#!/usr/bin/env node
'use strict';
// detector.js — lo que no puede salir en una publicación
//
// POR QUÉ EXISTE: el arnés se publica como código abierto, y puede traer menciones de clientes y personas,
// credenciales vivas y rutas de máquina repartidas en miles de archivos. Revisar eso a ojo antes
// de cada publicación no escala y no se repite igual dos veces. Este detector es el control:
// el exportador lo corre antes de publicar, y la CI del repo público lo vuelve a correr.
//
// QUÉ BUSCA:
//   · Los términos de una lista de denegación (clientes, personas, hosts internos, cuentas). Esa
//     lista es PRIVADA —nombrarlos es justamente lo que no puede salir— y el detector NO la trae
//     adentro: la recibe con --config. El propio archivo de la lista nunca se escanea.
//   · Patrones genéricos que valen para cualquiera (acá adentro, porque no nombran a nadie):
//     credenciales con formato conocido, rutas de máquina de una persona, emails.
//   · Archivos binarios: no se pueden leer, así que cuentan como hallazgo («sin leer») salvo que
//     la config los permita por extensión. Un binario sin leer no es un binario limpio.
//
// CÓMO FALLA: fuerte. Sin config, config ilegible, un regex que no compila, una excepción sin
// motivo, o una ruta de --list que no existe → exit 2 y el motivo. Nunca «no encontré nada»
// cuando en realidad no pudo mirar.
//
// TAMBIÉN CUBRE formas de un nombre que de otro modo se escaparían
// (la sigla pegada en mayúsculas, la barra invertida, el valor de una clave con comentario, la ñ y la ç en ASCII, el
// singular en «e») y la sigla pegada dentro de una tira de base64. Cuenta las apariciones (por posición, sin repetir una)
// y ordena el informe (por cantidad, recorriendo en orden de nombre).
//
// SALIDA: exit 0 = limpio · 1 = hay hallazgos · 2 = no pude mirar. Los secretos se muestran
// enmascarados (4 caracteres + ***): el informe del detector se puede pegar sin filtrar nada.
//
// A mano:
//   node scripts/publishing/detector.js --config <denylist.json> <ruta>...
//   node scripts/publishing/detector.js --config <denylist.json> --list <archivo-con-rutas>
//   Opciones: --base <dir> (rutas relativas a esa carpeta en el informe y en los globs)
//             --json (todo el resultado) · --detail (cada hallazgo, no sólo el resumen)

const fs = require('fs');
const path = require('path');

// ── Patrones genéricos (no nombran a nadie; sirven en cualquier repo) ─────────────────────────
const PATRONES_GENERICOS = [
  { nombre: 'sas-azure', categoria: 'secreto', regex: /\bsig=[A-Za-z0-9%+/=]{16,}/g },
  { nombre: 'token-github', categoria: 'secreto', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { nombre: 'llave-anthropic', categoria: 'secreto', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { nombre: 'llave-openai', categoria: 'secreto', regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { nombre: 'token-telegram', categoria: 'secreto', regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { nombre: 'llave-aws', categoria: 'secreto', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { nombre: 'llave-privada', categoria: 'secreto', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { nombre: 'jwt', categoria: 'secreto', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Llaves sin prefijo reconocible (por ejemplo, una API key de 20 hex asignada a
  // `…_API_KEY=` en un .md). Se reconoce por el NOMBRE de la variable, no por el valor.
  { nombre: 'asignacion-de-secreto', categoria: 'secreto', regex: /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9+/_-]{16,}/g },
  { nombre: 'clave-en-cadena-de-conexion', categoria: 'secreto', regex: /\b(?:Password|Pwd)\s*=\s*[^;"'\s<>{}$]{4,}/gi },
  // La misma clave ENTRE COMILLAS (`Password="…"`, `bizuit:emailPassword="…"`): la regla de arriba corta en la comilla
  // y no vería esta forma. Los marcadores de plantilla no son una clave:
  // `$VAR`, `{0}`, `%X%`, `***` y `<clave>` no disparan, ni un booleano (`requirePassword="true"`).
  { nombre: 'clave-entre-comillas', categoria: 'secreto', regex: /\b[A-Za-z0-9_.:-]*?(?:password|pwd)\s*=\s*(["'])(?![$%{<]|\*+\1|(?:true|false)\1)[^"'\s]{4,}\1/gi },
  // Un proceso exportado con la organización como sufijo del nombre: `<algo>__<org>.bpmn` o `.vdw`.
  // Es un patrón de forma: la organización no tiene que estar en ninguna lista.
  // Sobre la lista de rutas de una copia, cubre también el nombre del archivo. La extensión, sin
  // caja: un `.BPMN` es el mismo archivo.
  { nombre: 'nombre-con-sufijo-de-organizacion', categoria: 'cliente', regex: /[A-Za-z0-9]__[A-Za-z0-9][A-Za-z0-9-]*\.(?:bpmn|vdw)\b/gi },
  { nombre: 'ruta-de-maquina', categoria: 'ruta-de-maquina', regex: /\/(?:Users|home)\/[a-z][a-z0-9._-]*\/|\b[A-Z]:\\Users\\[A-Za-z][^\\\s]*\\/g },
  { nombre: 'email', categoria: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  // Una licencia ajena que no se puede redistribuir: el aviso de copyright CON la reserva de todos los
  // derechos en la misma línea, o el frontmatter de una skill propietaria. La frase suelta en prosa no alcanza. Escrito
  // con escapes para que este archivo, que sale en la copia, no se dispare a sí mismo.
  { nombre: 'foreign-license', categoria: 'foreign-license', regex: /^(?=.*(?:©|\bCopyright\b))(?=.*\bAll\s+rights\s+reserved\b).*$|^license:\s*Proprietary\b.*$/gi },
];
const CATEGORIAS_ENMASCARADAS = new Set(['secreto']);
// Lo que el patrón de email agarra y no es una persona: dominios de ejemplo (RFC 2606), usuarios
// de servicio de git y el firmante automático de los commits, y nombres de imagen `icono@2x.png`.
// Y las direcciones `noreply` de GitHub: `…@users.noreply.github.com` es la que GitHub le da a
// una cuenta justamente para no publicar su correo —es con la que se firma en el repo público— y `noreply@github.com` es
// el committer de todo merge hecho en GitHub. No son un correo de nadie; el nombre de la cuenta, si está en la lista, lo
// sigue viendo su término.
const DOMINIOS_DE_EJEMPLO = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:invalid|test|example|localhost))$|@users\.noreply\.github\.com$/i;
// (`support@github.com` es el que GitHub pone en el pie de los commits de dependabot)
const EMAILS_QUE_NO_SON_PERSONAS = new Set(['git@github.com', 'git@ssh.dev.azure.com', 'noreply@anthropic.com', 'noreply@github.com', 'support@github.com']);
const NO_ES_EMAIL = /\.(?:png|jpe?g|gif|svg|webp)$/i;
const SALTEAR_CARPETAS = new Set(['.git', 'node_modules']);
const LEER_PARA_DETECTAR_BINARIO = 8000;

class ErrorDeConfig extends Error {}

// ── Globs mínimos: `**` cruza carpetas, `*` y `?` no ────────────────────────────────────────
function globARegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Config ───────────────────────────────────────────────────────────────────────────────────
function compilar(fuente, flags, donde) {
  try {
    return new RegExp(fuente, flags);
  } catch (e) {
    throw new ErrorDeConfig(`${donde}: el regex no compila (${e.message})`);
  }
}

// ── Variantes de un término ─────────────────────────────────────────────────────────────────
// Un término que distingue mayúsculas (`SOL`, `Globex`) se escaparía en OTRA caja dentro de un identificador
// (`tycon-prod-sol`, `/api/globex/…`): el detector daría cero sobre una copia con cientos de
// menciones de clientes. En prosa la palabra común no es un identificador («hay que tomar sol», «sol.» al final de
// una oración, `globexImage`): sólo cuenta pegada a un separador de identificador o sola entre comillas. El exportador
// arma sus reemplazos con estas mismas funciones: lo que el detector ve es exactamente lo que la tabla no alcanzó.
// El borde izquierdo: «no pegado a una letra o a un dígito», salvo que esa letra o
// ese dígito sea la cola de un escape (`\n`, `\t`, `\r` dentro de una cadena JSON o de un printf) o de un carácter
// codificado para una URL (`%20`). Sin esto, un nombre justo después de un salto escapado no lo vería nadie.
const NO_ALNUM_ANTES = '(?:(?<![A-Za-z0-9])|(?<=\\\\[ntr])|(?<=%[0-9A-Fa-f]{2}))';
const NO_ALNUM_DESPUES = '(?![A-Za-z0-9])';

/** El término en cualquier caja, pegado a `-`, `_`, `/`, `\`, `@` o `.` (con letra o dígito del otro lado del punto) por
 *  algún lado, después de un `=` (el valor de una asignación: `engram_project=x`), o solo entre dos comillas iguales.
 *  Pegado a letras no: eso es otra palabra. (Cubre la barra invertida de una ruta de Windows, y la arroba
 *  también a la derecha —la parte local de un email—.) */
function regexOtraCaja(patron) {
  return regexOtraCajaDe(escaparRegex(patron));
}

/** Lo mismo, con el cuerpo del regex ya armado (el cuerpo flojo de un término: con su tilde y su plural). */
function regexOtraCajaDe(e) {
  return new RegExp(
    `(?<=[-_/\\\\@=]|[A-Za-z0-9]\\.)${e}${NO_ALNUM_DESPUES}|${NO_ALNUM_ANTES}${e}(?=[-_/\\\\@]|\\.[A-Za-z0-9])|(?<=(['"\`]))${e}(?=\\1)`, 'gi');
}

/** El término escrito entero en mayúsculas, como palabra (`CEIBO` de `Ceibo`). */
function regexMayusculas(patron) {
  return new RegExp(`${NO_ALNUM_ANTES}${escaparRegex(patron.toUpperCase())}${NO_ALNUM_DESPUES}`, 'g');
}

/** Las partes de un nombre compuesto (`AcmeCorp` → Acme, Corp); un término de una sola parte da una. */
function partesDe(patron) {
  return /^[A-Za-z]+$/.test(patron) ? patron.split(/(?<=[a-z])(?=[A-Z])/) : [patron];
}

/** Un nombre de varias partes separado por `-`, `_` o espacio (`acme-corp`, «Acme Corp»), en cualquier caja.
 *  Sin separador es el término mismo: lo ve su propia regla, así que quien use esta pide al menos uno. */
function regexPartes(patron) {
  return new RegExp(`${NO_ALNUM_ANTES}${partesDe(patron).map(escaparRegex).join('[-_ ]?')}${NO_ALNUM_DESPUES}`, 'gi');
}
const conSeparador = (texto) => /[-_ ]/.test(texto);

// ── Formas partidas ─────────────────────────────────────────────────────────────
// Un término se esquiva con un cambio mínimo:
// un guion donde había un espacio, una tilde, el singular, el host sin sus puntos, `%20`, unas comillas en el medio o
// un corte de renglón. La lista no puede traer cada forma a mano: el detector las deriva de cada término.
// También la ñ y la ç: escritas en ASCII (`n`, `c`) son lo habitual en usuarios, emails e identificadores
const TILDES = { a: 'aá', e: 'eé', i: 'ií', o: 'oó', u: 'uúü', á: 'aá', é: 'eé', í: 'ií', ó: 'oó', ú: 'uúü', ü: 'uúü', n: 'nñ', ñ: 'nñ', c: 'cç', ç: 'cç' };
// Un separador simple entre dos partes de un nombre, o ninguno. Un término de caja exacta no admite el espacio.
const SEPARADOR = '(?:[-_ ./\\\\+]|%20)?';
const SEPARADOR_SIN_ESPACIO = '(?:[-_./\\\\+]|%20)?';
const ES_CLAVE = /^[:=]$/;

/** Sin tildes ni diéresis: para comparar las letras de un término contra las de un texto. */
function sinTildes(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/** El cuerpo de un regex que ve `texto` con tilde o sin ella en cada vocal. `exacta`: el regex distingue caja. */
function conTildes(texto, exacta) {
  let out = '';
  for (const c of texto) {
    const clase = TILDES[c.toLowerCase()];
    if (!clase) out += escaparRegex(c);
    else if (!exacta) out += `[${clase}]`;
    else out += `[${c === c.toLowerCase() ? clase : clase.toUpperCase()}]`;
  }
  return out;
}

/** Las partes de un término para sus formas flojas, cada una con lo que la separaba de la anterior: `[{ texto, antes }]`.
 *  Corta en cada separador que ya trae (espacio, `-`, `_`, `/`, `\`, `.`), saca las comillas, y cada trozo de letras lo
 *  corta además donde pasa de minúscula a mayúscula (`antes` vacío). Un `:` o un `=` queda como su propia parte
 *  (`clave: 'valor'` → clave, `:`, valor). */
function partesFlojas(patron) {
  const out = [];
  let antes = '';
  for (const trozo of patron.replace(/["'`]/g, '').split(/([-_ /\\.]+)|(?=[:=])|(?<=[:=])/)) {
    if (!trozo) continue;
    if (/^[-_ /\\.]+$/.test(trozo)) { antes = trozo; continue; }
    partesDe(trozo).forEach((texto, i) => out.push({ texto, antes: i === 0 ? antes : '' }));
    antes = '';
  }
  return out;
}

/** El singular y el plural de la última parte: `Recibos` ve «Recibo»; `Sucursales`, «Sucursal»; una palabra entera que no
 *  termina en ese ve además su plural (`Zorb` → «Zorbs», «Zorbes»). Devuelve `{ base, cola }`: texto y regex. */
function numeroDe(parte, palabra) {
  // La cola admite la `e` sola: `Deportes` ve «Deporte», no sólo «Deport»
  if (/[A-Za-z]es$/i.test(parte) && parte.length > 4) return { base: parte.slice(0, -2), cola: '(?:[eE][sS]?|[sS])?' };
  if (/[A-Za-z]s$/i.test(parte) && parte.length > 3) return { base: parte.slice(0, -1), cola: '[sS]?' };
  if (palabra && /[A-Za-z]$/.test(parte)) return { base: parte, cola: '(?:[eE]?[sS])?' };
  return { base: parte, cola: '' };
}

/** El cuerpo flojo de un término: sus partes con tilde o sin ella, unidas por un separador simple o pegadas, con su
 *  singular y su plural. El espacio vale como separador sólo entre las partes de un NOMBRE (las que separa un espacio,
 *  un guion, un guion bajo o el cambio de caja) y sólo si el término no es de caja exacta: «Quick Review» es una frase y
 *  `QuickReview`, un nombre; y entre los tramos de un host o de una ruta (un punto, una barra) el espacio haría de
 *  «la app de la marca como…» un servidor. Alrededor de un `:` o un `=`, espacios (`clave:valor`, `clave = valor`). */
function cuerpoFlojo(t) {
  const partes = partesFlojas(t.patron);
  if (!partes.length) return null;
  const ultima = numeroDe(partes[partes.length - 1].texto, t.palabra);
  let cuerpo = '';
  partes.forEach((parte, i) => {
    const clave = ES_CLAVE.test(parte.texto);
    if (i > 0) {
      if (clave || ES_CLAVE.test(partes[i - 1].texto)) cuerpo += '\\s*';
      else cuerpo += t.mayusculas || /[/\\.]/.test(parte.antes) ? SEPARADOR_SIN_ESPACIO : SEPARADOR;
    }
    if (clave) cuerpo += '[:=]';
    else if (i === partes.length - 1) cuerpo += conTildes(ultima.base, t.mayusculas) + ultima.cola;
    else cuerpo += conTildes(parte.texto, t.mayusculas);
  });
  return cuerpo;
}

/** Lo que un texto tiene que traer (sin caja y sin tildes) para que el término o alguna forma suya pueda aparecer. */
function pistasDe(t) {
  const partes = partesFlojas(t.patron).map((x) => x.texto).filter((x) => !ES_CLAVE.test(x));
  return partes.map((x, i) => sinTildes((i === partes.length - 1 ? numeroDe(x, t.palabra).base : x).toLowerCase()));
}

/** Una línea sin lo que parte un nombre sin cambiarlo: las comillas (`"acme"corp`), la concatenación entre dos comillas
 *  iguales (`'acme' + 'corp'`) y la barra que las escapa. Entre dos acentos graves no se une: en un `.md`, `uno` + `dos`
 *  son dos trozos de código en una frase, no un nombre partido. */
function aplanar(linea) {
  return linea.replace(APLANAR[0], '').replace(APLANAR[1], '');
}
const APLANAR = [/\\?(["'])\s*\+\s*\\?\1/g, /\\?["'`]/g];

/** Lo mismo para UN renglón, con el mapa de vuelta: `mapa[i]` es la posición en el renglón original del carácter `i`
 *  del texto aplanado (las pasadas que miran el texto aplanado comparan apariciones por posición, no por
 *  cantidad). Las posiciones son las de JavaScript (unidades UTF-16), las mismas que dan los regex. */
function aplanarConMapa(linea) {
  let texto = linea;
  let mapa = Array.from({ length: linea.length }, (_, i) => i);
  for (const re of APLANAR) {
    let out = '';
    const m2 = [];
    let desde = 0;
    const copiar = (hasta) => { for (let k = desde; k < hasta; k++) m2.push(mapa[k]); };
    for (const m of texto.matchAll(re)) {
      out += texto.slice(desde, m.index);
      copiar(m.index);
      desde = m.index + m[0].length;
    }
    out += texto.slice(desde);
    copiar(texto.length);
    texto = out;
    mapa = m2;
  }
  return { texto, mapa };
}

/** Las variantes que se miran además de la grafía del término: `{ re, nombre, vale(texto) }`. Con `prefijo: true` el
 *  regex va anclado al principio de la línea y trae dos grupos: lo de antes y el término (es mucho más barato que mirar
 *  hacia atrás desde cada posición). */
function variantesDe(t) {
  const v = [];
  const sigla = t.palabra && t.mayusculas && /^[A-Za-z0-9]+$/.test(t.patron);
  const flojo = cuerpoFlojo(t);
  if (sigla) {
    // en otra caja, pegada a un separador de identificador; también con su tilde y su plural (un alias
    // como `zorbs-mac`): el cuerpo flojo contiene al término tal cual
    v.push({ re: flojo ? regexOtraCajaDe(flojo) : regexOtraCaja(t.patron), nombre: '(otra caja, en un identificador)', vale: (x) => x !== t.patron });
    if (t.patron !== t.patron.toUpperCase()) v.push({ re: regexMayusculas(t.patron), nombre: '(en mayúsculas)', vale: () => true });
  }
  // Un término de caja exacta no se parte en una frase: `QuickReview` no prohíbe «quick review»
  if (t.categoria === 'cliente' && partesDe(t.patron).length > 1 && !t.mayusculas) {
    v.push({ re: regexPartes(t.patron), nombre: '(separado en partes)', vale: conSeparador });
  }
  if (flojo) {
    // con tilde o sin ella, en singular o en plural, y sus partes con otro separador o pegadas (el host sin sus puntos)
    const fuente = t.palabra ? `${NO_ALNUM_ANTES}${flojo}${NO_ALNUM_DESPUES}` : flojo;
    v.push({ re: new RegExp(fuente, t.mayusculas ? 'g' : 'gi'), nombre: '(otra forma)', vale: (x) => x !== t.patron });
    if (sigla) {
      // en otra caja, como el valor entero de una clave (`project: zorb`), que en un YAML va sin comillas.
      // También con `=` y espacios (INI, TOML), entre llaves y con un comentario detrás.
      v.push({
        re: new RegExp(`^(\\s*(?:-\\s+|\\{\\s*)?["']?[\\w.-]+["']?\\s*[:=]\\s*["']?)(${flojo})(?=${CIERRE_DE_VALOR})`, 'i'),
        prefijo: true,
        nombre: '(otra caja, el valor de una clave)',
        vale: (x) => x !== t.patron,
      });
    }
  }
  // la misma idea de «sigla» que arriba (letras y dígitos), desde tres caracteres y empezando por una letra: con sólo
  // letras, una sigla con un dígito en el medio era sigla para una condición y no para ésta, y pegada pasaba sin verse
  if (sigla && t.glued !== false && /^[A-Za-z][A-Za-z0-9]{2,}$/.test(t.patron)) v.push(...variantesPegadas(t.patron));
  return v;
}

// ── La sigla PEGADA a otra palabra ───────────────────────
// Una sigla de palabra entera y caja exacta (`ZORB`) no se ve pegada a letras: ahí es otra palabra. Dos formas pegadas sí
// nombran al mismo: con la inicial en mayúscula dentro de un CamelCase (`DeployZorbStaging`, el nombre de una etapa de
// pipeline: salió así en una copia publicada) y en minúscula al principio o al final del valor de una clave que nombra
// un proyecto (`project: 'proyectozorb'`). En minúscula y suelta en cualquier parte no hay regla posible: tres letras
// están dentro de cientos de palabras del castellano. Una sigla que además es una palabra común las apaga con
// `"glued": false` en su término. Lo que el exportador reemplaza no cambia: una forma de éstas en las fuentes es un
// hallazgo, y se arregla en la fuente.
// La clave en cualquier caja (`ENGRAM_PROJECT=…`, `"Project": …`, `REPO=…`), con `export` adelante; el
// resto del valor también con mayúsculas (`zorbForms`); y un comentario detrás del valor no lo esconde.
const sinCaja = (s) => s.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const CLAVES_DE_PROYECTO = sinCaja('(?:project|engram_project|pin|repo|keychain)');
// Lo que puede seguir al valor de una clave: su comilla, una coma, la llave o el corchete que cierra, y un comentario.
const CIERRE_DE_VALOR = `["']?\\s*,?\\s*(?:[}\\]]\\s*,?\\s*)?(?:(?:#|//).*)?$`;

/** Si la posición cae dentro de una tira de base64 (un `integrity` de un lockfile, una imagen embebida):
 *  40 o más caracteres seguidos del alfabeto, con mayúsculas, minúsculas y al menos cuatro dígitos. Ahí una sigla
 *  pegada aparece por azar; en un identificador o en una ruta, que casi no traen dígitos, no. */
function enTiraBase64(texto, index, largo) {
  let a = index;
  let b = index + largo;
  while (a > 0 && /[A-Za-z0-9+/=]/.test(texto[a - 1])) a--;
  while (b < texto.length && /[A-Za-z0-9+/=]/.test(texto[b])) b++;
  const tira = texto.slice(a, b);
  return tira.length >= 40 && /[A-Z]/.test(tira) && /[a-z]/.test(tira) && (tira.match(/[0-9]/g) || []).length >= 4;
}

function variantesPegadas(patron) {
  const forma = patron[0].toUpperCase() + patron.slice(1).toLowerCase();
  const capitalizada = escaparRegex(forma);
  const minuscula = escaparRegex(patron.toLowerCase());
  const clave = `\\s*(?:-\\s+)?(?:export\\s+)?["']?${CLAVES_DE_PROYECTO}["']?\\s*[:=]\\s*["']?`;
  const cierre = CIERRE_DE_VALOR;
  // Después de una minúscula o un dígito y sin otra minúscula atrás (`DeployZorbStaging`, `PanelZorb`); `Zorbita` es otra
  // palabra. Y al principio de un nombre, seguida de otra palabra en CamelCase (`ZorbBackend`), sólo si el término NO
  // se escribe ya así: para `Globex`, `GlobexImage` es el prefijo que mira el control de nombres pegados del exportador,
  // y acá sigue sin ser un hallazgo (T32 de publishing-detector.test.js).
  // …y con la grafía del término tal cual, en mayúsculas (`DeployZORBStaging`, `PanelZORB`, `ZORBBackend`)
  const enMedio = (x) => `(?<=[a-z0-9])${x}(?![a-z])`;
  const alPrincipio = (x) => `(?<![A-Za-z])${x}(?=[A-Z][a-z])`;
  const formas = [forma === patron ? enMedio(capitalizada) : `${enMedio(capitalizada)}|${alPrincipio(capitalizada)}`];
  // En mayúsculas, sólo EN MEDIO y después de una minúscula: después de un dígito (`20ZORB`) es una cifra pegada. Al
  // principio (`ZORBBackend`) ya la ve el control de nombres pegados del exportador, que mira el prefijo: acá contaría dos
  // veces, igual que `GlobexImage` (T32 de publishing-detector.test.js).
  if (patron === patron.toUpperCase() && patron !== forma) formas.push(`(?<=[a-z])${escaparRegex(patron)}(?![a-z])`);
  // …y un término escrito en caja MIXTA (`ZetaRepo`, `ZETARepo`: el nombre de un repo), con su
  // grafía tal cual: `forma` lo aplana (`Zetarepo`) y esa no es su grafía, así que pegado después de otra palabra
  // (`AcmeZETARepoBackEnd`, el nombre de un sitio; `DeployZetaRepoStaging`) no lo vería nadie. Al principio lo sigue
  // mirando el control de nombres pegados del exportador; `myZetaRepository` es otra palabra.
  else if (patron !== forma && patron !== patron.toLowerCase()) formas.push(enMedio(escaparRegex(patron)));
  const fueraDeBase64 = (x, texto, index) => texto === undefined || !enTiraBase64(texto, index, x.length);
  return [
    { re: new RegExp(formas.join('|'), 'g'), nombre: '(pegada en CamelCase)', vale: fueraDeBase64 },
    { re: new RegExp(`^(${clave}[A-Za-z0-9]+)(${minuscula})(?=${cierre})`), prefijo: true, nombre: '(pegada en el valor de una clave de proyecto)', vale: () => true },
    { re: new RegExp(`^(${clave})(${minuscula})(?=[A-Za-z0-9]+${cierre})`), prefijo: true, nombre: '(pegada en el valor de una clave de proyecto)', vale: () => true },
  ];
}

/** `text`: la lista ya leída —del índice de un commit, por ejemplo—; sin él, se lee `ruta` del disco. */
function cargarConfig(ruta, text) {
  if (!ruta) throw new ErrorDeConfig('falta --config: sin lista de denegación no hay contra qué mirar');
  let crudo = text;
  if (crudo === undefined) {
    try {
      crudo = fs.readFileSync(ruta, 'utf8');
    } catch (e) {
      throw new ErrorDeConfig(`no pude leer la config ${ruta} (${e.code || e.message})`);
    }
  }
  let cfg;
  try {
    cfg = JSON.parse(crudo);
  } catch (e) {
    throw new ErrorDeConfig(`la config ${ruta} no es JSON válido (${e.message})`);
  }
  const terminos = (cfg.terminos || []).map((t, i) => {
    const donde = `terminos[${i}]`;
    if (!t || typeof t.patron !== 'string' || !t.patron.trim()) throw new ErrorDeConfig(`${donde}: falta "patron"`);
    if (!t.categoria) throw new ErrorDeConfig(`${donde} (${t.patron}): falta "categoria"`);
    const cuerpo = escaparRegex(t.patron);
    const fuente = t.palabra ? `${NO_ALNUM_ANTES}${cuerpo}${NO_ALNUM_DESPUES}` : cuerpo;
    // `pistas`: lo que un texto tiene que contener (sin caja) para que el término o alguna variante pueda aparecer. La
    // grafía, la otra caja y las mayúsculas contienen el término entero; el nombre separado en partes, cada parte. Un
    // texto sin todas las partes no se recorre con esta regla (el freno revisa en cada commit). Se
    // comparan sin tildes, sin la «s» del plural y contra el texto aplanado: una forma con tilde, en singular
    // o partida con comillas trae las mismas letras.
    const pistas = pistasDe(t);
    return { nombre: t.patron, categoria: t.categoria, regex: compilar(fuente, t.mayusculas ? 'g' : 'gi', donde), variantes: variantesDe(t), pistas, unaParte: pistas.length < 2, deLista: true };
  });
  const patrones = (cfg.patrones || []).map((p, i) => {
    const donde = `patrones[${i}]`;
    if (!p || !p.nombre || !p.regex || !p.categoria) throw new ErrorDeConfig(`${donde}: necesita "nombre", "categoria" y "regex"`);
    // `pistas` (opcional): las letras que una línea tiene que traer para que el patrón pueda aparecer
    // (`database.windows.net`). Se comparan sin caja y sin tildes, contra la línea aplanada. Sin pistas el patrón recorre
    // todas las líneas, y uno que empieza con una clase repetida (`[a-z0-9-]+…`) es cuadrático en una línea larga:
    // tres patrones así pueden llevarse casi todo el tiempo de una copia grande.
    if (p.pistas !== undefined && (!Array.isArray(p.pistas) || p.pistas.some((x) => typeof x !== 'string' || !x.trim()))) {
      throw new ErrorDeConfig(`${donde} (${p.nombre}): "pistas" es una lista de textos`);
    }
    const pistas = p.pistas && p.pistas.length ? p.pistas.map((x) => sinTildes(x.toLowerCase())) : null;
    return { nombre: p.nombre, categoria: p.categoria, regex: compilar(p.regex, p.mayusculas ? 'g' : 'gi', donde), pistas, deLista: true };
  });
  const permitidos = (cfg.permitidos || []).map((p, i) => {
    const donde = `permitidos[${i}]`;
    if (!p || !p.archivo) throw new ErrorDeConfig(`${donde}: falta "archivo" (glob)`);
    if (!p.motivo || !String(p.motivo).trim()) throw new ErrorDeConfig(`${donde} (${p.archivo}): una excepción sin motivo no se acepta`);
    return {
      archivo: globARegex(p.archivo),
      patron: p.patron ? compilar(p.patron, 'i', donde) : null,
      motivo: p.motivo,
    };
  });
  const binariosPermitidos = (cfg.binariosPermitidos || []).map((g) => globARegex(g));
  const excluir = (cfg.excluir || []).map((g) => globARegex(g));
  const emailsPermitidos = new Set((cfg.emailsPermitidos || []).map((e) => e.toLowerCase()));
  return {
    ruta: path.resolve(ruta),
    reglas: [...terminos, ...patrones, ...PATRONES_GENERICOS],
    permitidos,
    binariosPermitidos,
    excluir,
    emailsPermitidos,
  };
}

// ── Archivos a mirar ─────────────────────────────────────────────────────────────────────────
// Un enlace simbólico no es ni archivo ni carpeta para `readdirSync`: se saltearía en
// silencio, y con un nombre prohibido en lo apuntado el detector diría «limpio». Se mira lo que apunta (cada carpeta
// una vez, aunque el enlace dé la vuelta), y un enlace roto es un «no pude mirar».
function recorrer(dir, out, vistas = new Set([fs.realpathSync(dir)])) {
  // En orden de nombre: el del sistema de archivos cambia entre la Mac, Windows y Linux
  const entradas = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entradas) {
    if (SALTEAR_CARPETAS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let esCarpeta = e.isDirectory();
    let esArchivo = e.isFile();
    if (e.isSymbolicLink()) {
      let st;
      try {
        st = fs.statSync(full);
      } catch (err) {
        throw new ErrorDeConfig(`el enlace ${full} está roto (${err.code || err.message}): no se puede dar por limpio lo que no se pudo mirar`);
      }
      esCarpeta = st.isDirectory();
      esArchivo = st.isFile();
    }
    if (esCarpeta) {
      const real = fs.realpathSync(full);
      if (vistas.has(real)) continue;
      vistas.add(real);
      recorrer(full, out, vistas);
    } else if (esArchivo) out.push(full);
  }
}

function juntarArchivos(rutas) {
  const out = [];
  for (const r of rutas) {
    let st;
    try {
      st = fs.statSync(r);
    } catch {
      throw new ErrorDeConfig(`la ruta ${r} no existe: no se puede dar por limpia una ruta que no se miró`);
    }
    if (st.isDirectory()) recorrer(r, out);
    else out.push(r);
  }
  return out;
}

function leerLista(archivo) {
  let txt;
  try {
    txt = fs.readFileSync(archivo, 'utf8');
  } catch (e) {
    throw new ErrorDeConfig(`no pude leer la lista ${archivo} (${e.code || e.message})`);
  }
  const base = path.dirname(path.resolve(archivo));
  return txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => (path.isAbsolute(l) ? l : path.resolve(base, l)));
}

// ── Detección ────────────────────────────────────────────────────────────────────────────────
function enmascarar(texto) {
  return `${texto.slice(0, 4)}***`;
}

function esBinario(buf) {
  const n = Math.min(buf.length, LEER_PARA_DETECTAR_BINARIO);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function esEmailInofensivo(cfg, texto) {
  const e = texto.toLowerCase();
  return DOMINIOS_DE_EJEMPLO.test(e) || NO_ES_EMAIL.test(e) || EMAILS_QUE_NO_SON_PERSONAS.has(e) || cfg.emailsPermitidos.has(e);
}

function permitido(cfg, rel, texto) {
  return cfg.permitidos.find((p) => p.archivo.test(rel) && (!p.patron || p.patron.test(texto)));
}

function revisarArchivo(cfg, abs, rel) {
  const buf = fs.readFileSync(abs);
  if (esBinario(buf)) {
    if (cfg.binariosPermitidos.some((g) => g.test(rel))) return { hallazgos: [], permitidos: 0 };
    // Un binario puntual (una imagen que alguien miró) se permite con una excepción por archivo,
    // sin patrón: no hay texto contra el cual comparar.
    if (cfg.permitidos.some((p) => !p.patron && p.archivo.test(rel))) return { hallazgos: [], permitidos: 1 };
    return { hallazgos: [{ archivo: rel, linea: 0, categoria: 'sin-leer', regla: 'binario', texto: '(archivo binario)' }], permitidos: 0 };
  }
  return reviewText(cfg, buf.toString('utf8'), rel);
}

/** Un texto en memoria, con las mismas reglas que un archivo (el freno mira el índice, no el disco).
 *  `opciones.categorias` (un Set) limita las reglas a esas categorías: el freno sólo busca nombres. */
function reviewText(cfg, text, rel, opciones = {}) {
  const hallazgos = [];
  let permitidosN = 0;
  const lineas = text.split(/\r?\n/);
  // Las letras del texto, para las pistas: sin caja, sin tildes, y sin lo que parte un nombre (las
  // comillas, la concatenación, la barra que sigue en el renglón de abajo)
  const letras = sinTildes(aplanar(text.replace(/\\\r?\n[ \t]*/g, ''))).toLowerCase();
  const reglas = cfg.reglas.filter((r) => (!opciones.categorias || opciones.categorias.has(r.categoria))
    && (!r.pistas || r.pistas.every((pista) => letras.includes(pista))));
  const deLista = reglas.filter((r) => r.deLista);
  // Las letras de cada línea, para no recorrer con un término las líneas que no pueden traerlo: con las formas partidas
  // cada término mira tres veces (la línea, la línea aplanada y la unión con la de abajo) y sin este filtro el detector
  // tardaba veinte veces más.
  const letrasDe = lineas.map((l) => sinTildes(aplanar(l)).toLowerCase());
  const puede = (r, texto) => !r.pistas || r.pistas.every((pista) => texto.includes(pista));
  const anotar = (r, ap, linea, forma) => {
    if (r.categoria === 'email' && esEmailInofensivo(cfg, ap.texto)) return;
    if (permitido(cfg, rel, ap.texto)) { permitidosN++; return; }
    const variante = [ap.variante, forma].filter(Boolean).join(' ');
    hallazgos.push({
      archivo: rel,
      linea,
      categoria: r.categoria,
      regla: variante ? `${r.nombre} ${variante}` : r.nombre,
      texto: CATEGORIAS_ENMASCARADAS.has(r.categoria) ? enmascarar(ap.texto) : ap.texto,
    });
  };
  lineas.forEach((linea, i) => {
    const enLaLinea = new Map();
    const letras = letrasDe[i];
    const todas = [];   // [regla, aparición], en el orden de siempre
    for (const r of reglas) {
      if (!puede(r, letras)) continue;
      const aps = apariciones(r, linea);
      if (r.deLista) enLaLinea.set(r, aps);
      for (const ap of aps) todas.push([r, ap]);
    }
    // Una sigla «pegada» que cae ADENTRO de otro nombre de la lista no es un hallazgo aparte: con `ACME` y `AcmeCorp` en la
    // lista, el `Acme` de `AcmeCorp` es ese otro nombre, no la sigla pegada a una palabra cualquiera. Sin esto cada
    // aparición contaría dos veces y una excepción que permite el nombre entero en un archivo dejaría de alcanzar.
    // Sólo otro nombre de LA LISTA: un email que la contiene no, porque si
    // después se descarta por inofensivo, el nombre no quedaría en ningún hallazgo.
    const cubierta = (r, ap) => /^\(pegada /.test(ap.variante || '') && typeof ap.index === 'number'
      && todas.some(([r2, ap2]) => r2 !== r && r2.deLista && typeof ap2.index === 'number' && ap2.texto.length > ap.texto.length
        && ap2.index <= ap.index && ap2.index + ap2.texto.length >= ap.index + ap.texto.length);
    for (const [r, ap] of todas) if (!cubierta(r, ap)) anotar(r, ap, i + 1, '');
    // Lo mismo sobre la línea aplanada, sólo para los términos y patrones de la lista: un nombre partido
    // con comillas (`"acme"corp`, `'acme' + 'corp'`) es el mismo nombre. Cuenta lo que la línea tal cual no mostró.
    // Nueva es la aparición que empieza donde la línea tal cual no mostró ninguna: contar por cantidad
    // dejaría que una aparición que aplanar borra (una sigla entre comillas que sin ellas queda como prosa) compensara una
    // forma partida nueva, y ésta no se anotaría.
    const plana = aplanar(linea);
    let mapa = null;   // el mapa de vuelta, sólo si hay algo que ubicar
    if (plana !== linea) {
      for (const r of deLista) {
        const antes = enLaLinea.get(r);
        if (!antes) continue;
        const aps = apariciones(r, plana);
        if (!aps.length) continue;
        if (!mapa) mapa = aplanarConMapa(linea).mapa;
        const desde = new Set(antes.map((ap) => ap.index));
        for (const ap of aps) {
          if (desde.has(mapa[ap.index])) continue;
          desde.add(mapa[ap.index]);
          anotar(r, ap, i + 1, '(partido con comillas)');
        }
      }
    }
    // …y sobre la unión con el renglón siguiente: la prosa de las guías va cortada a ancho fijo y un
    // comando sigue abajo con una barra. Cuenta sólo lo que cruza el corte: lo demás ya lo vio cada renglón.
    if (i + 1 < lineas.length && deLista.length) {
      const sigue = /\\\s*$/.test(linea);
      const crudo = sigue ? linea.replace(/\\\s*$/, '') : linea.replace(/\s+$/, '');
      const plano = aplanar(crudo);
      const corte = Math.max(0, plano.length - CORTE_DE_RENGLON);
      const izq = plano.slice(corte);
      let mapaIzq = null;   // la posición en el renglón original, sólo si una aparición cruza el corte
      const der = aplanar(lineas[i + 1].replace(sigue ? /^\s+/ : /^\s*(?:(?:\/\/+|#+|\*|>+)\s*)?/, '')).slice(0, CORTE_DE_RENGLON);
      if (izq && der) {
        const union = sigue ? izq + der : `${izq} ${der}`;
        const desde = sigue ? izq.length : izq.length + 1;
        const letrasUnion = sinTildes(union).toLowerCase();
        for (const r of deLista) {
          // un término de una sola parte sólo puede cruzar el corte si el renglón sigue con una barra
          if (!puede(r, letrasUnion) || (!sigue && r.unaParte)) continue;
          // Una aparición que el renglón solo ya informó, y que la continuación sólo alarga (la cola del
          // plural), no se cuenta otra vez
          const yaInformadas = new Set((enLaLinea.get(r) || []).map((ap) => ap.index));
          for (const ap of apariciones(r, union)) {
            if (ap.index >= izq.length || ap.index + ap.texto.length <= desde) continue;
            if (yaInformadas.size) {
              if (!mapaIzq) mapaIzq = aplanarConMapa(crudo).mapa;
              if (yaInformadas.has(mapaIzq[corte + ap.index])) continue;
            }
            anotar(r, ap, i + 1, '(partido en dos renglones)');
          }
        }
      }
    }
  });
  return { hallazgos, permitidos: permitidosN };
}

const CORTE_DE_RENGLON = 200;

/** Las apariciones de una regla en un texto: la grafía del término y sus variantes. Una aparición
 *  cuenta una vez, aunque la vean dos: `[{ index, texto, variante }]`. */
function apariciones(r, texto) {
  const out = [];
  const vistas = new Set();
  for (const v of [{ re: r.regex, nombre: '', vale: () => true }, ...(r.variantes || [])]) {
    if (v.prefijo) {
      const m = v.re.exec(texto);
      if (m && v.vale(m[2]) && !vistas.has(m[1].length)) {
        vistas.add(m[1].length);
        out.push({ index: m[1].length, texto: m[2], variante: v.nombre });
      }
      continue;
    }
    v.re.lastIndex = 0;
    let m;
    while ((m = v.re.exec(texto)) !== null) {
      if (m[0].length === 0) { v.re.lastIndex++; continue; }
      if (!v.vale(m[0], texto, m.index) || vistas.has(m.index)) continue;
      vistas.add(m.index);
      out.push({ index: m.index, texto: m[0], variante: v.nombre });
    }
  }
  return out;
}

function detectar({ config, rutas, lista, base }) {
  const cfg = cargarConfig(config);
  const objetivos = lista ? leerLista(lista) : rutas;
  if (!objetivos || objetivos.length === 0) throw new ErrorDeConfig('no me pasaste nada que mirar (rutas o --list)');
  const raiz = path.resolve(base || process.cwd());
  const archivos = juntarArchivos(objetivos);
  const resultado = { archivos: 0, excluidos: 0, permitidos: 0, hallazgos: [] };
  for (const abs of archivos) {
    const resuelto = path.resolve(abs);
    const rel = path.relative(raiz, resuelto).split(path.sep).join('/');
    if (resuelto === cfg.ruta || cfg.excluir.some((g) => g.test(rel))) { resultado.excluidos++; continue; }
    resultado.archivos++;
    const r = revisarArchivo(cfg, resuelto, rel);
    resultado.permitidos += r.permitidos;
    resultado.hallazgos.push(...r.hallazgos);
  }
  resultado.porCategoria = contar(resultado.hallazgos, (h) => h.categoria);
  resultado.porArchivo = contar(resultado.hallazgos, (h) => h.archivo);
  return resultado;
}

function contar(items, clave) {
  const out = {};
  for (const it of items) out[clave(it)] = (out[clave(it)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parsear(argv) {
  const a = { rutas: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--config') a.config = argv[++i];
    else if (x === '--list') a.lista = argv[++i];
    else if (x === '--base') a.base = argv[++i];
    else if (x === '--json') a.json = true;
    else if (x === '--detail') a.detalle = true;
    else if (x.startsWith('--')) throw new ErrorDeConfig(`opción desconocida: ${x}`);
    else a.rutas.push(x);
  }
  return a;
}

/** Las entradas de un conteo de mayor a menor y, en empate, por nombre (un objeto pone primero las claves
 *  con forma de número, así que el orden no puede salir del objeto). */
function porCantidad(conteo) {
  return Object.entries(conteo).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function informe(r, detalle) {
  const lineas = [];
  const total = r.hallazgos.length;
  lineas.push(total === 0
    ? `✅ limpio — ${r.archivos} archivos mirados (${r.excluidos} excluidos, ${r.permitidos} excepciones con motivo)`
    : `🛑 ${total} hallazgos en ${Object.keys(r.porArchivo).length} de ${r.archivos} archivos (${r.excluidos} excluidos, ${r.permitidos} excepciones con motivo)`);
  if (total > 0) {
    lineas.push('', 'Por categoría:');
    for (const [k, v] of porCantidad(r.porCategoria)) lineas.push(`  ${String(v).padStart(6)}  ${k}`);
    lineas.push('', 'Archivos con más hallazgos:');
    for (const [k, v] of porCantidad(r.porArchivo).slice(0, 15)) lineas.push(`  ${String(v).padStart(6)}  ${k}`);
    if (detalle) {
      lineas.push('', 'Detalle:');
      for (const h of r.hallazgos) lineas.push(`  ${h.archivo}:${h.linea}  [${h.categoria}/${h.regla}]  ${h.texto}`);
    }
  }
  return lineas.join('\n');
}

function main() {
  let args;
  try {
    args = parsear(process.argv.slice(2));
    const r = detectar(args);
    // El código de salida se DEJA puesto y el proceso termina solo: con
    // `process.exit()` enseguida, un informe largo por un pipe llega cortado (65.536 bytes, u 8.192 por `spawnSync`)
    // y sin aviso.
    process.exitCode = r.hallazgos.length === 0 ? 0 : 1;
    process.stdout.write(`${args.json ? JSON.stringify(r, null, 2) : informe(r, args.detalle)}\n`);
  } catch (e) {
    // Cualquier error —no sólo los de config— sale con 2: el 1 significa «encontré algo», y un
    // archivo que no se pudo leer no puede confundirse con eso ni, peor, con un 0.
    const detalle = e instanceof ErrorDeConfig ? e.message : (e.stack || String(e));
    process.exitCode = 2;
    process.stderr.write(`⛔ detector: no pude mirar — ${detalle}\n`);
  }
}

if (require.main === module) {
  // Las opciones viejas en castellano siguen andando hasta el retiro
  require('../lib/legacy-names.js').aliasArgv('scripts/publishing/detector.js', { exitCode: 2, prefix: '⛔ detector: no pude mirar — ' });
  main();
}

// `esBinario` se exporta para el exportador: decide texto o binario con esta MISMA regla, nunca por extensión.
module.exports = {
  detectar, cargarConfig, globARegex, esBinario, ErrorDeConfig, PATRONES_GENERICOS,
  regexOtraCaja, regexMayusculas, regexPartes, partesDe, conSeparador,
  reviewText,
};
