'use strict';
/**
 * bash-gate-words.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: las palabras del comando: separar tramos y palabras, comillas, los guiones que lee un intérprete, los `sed` sin efectos y lo que no corre procesos.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isCodeFile, isManifestFile, NEVER_CODE_SEGMENTS } = require('./story-gate.js');
// ── variables del comando ─────────────────────────────────────
// `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` sale frenado como «EDICIÓN INVISIBLE»: el destino se resuelve
// tal cual, `<repo>/$SP/x.cs`, y queda adentro del repo de la corrida.
// Las variables las expande `lib/command-vars.js`: con el valor que tenían EN ESE PUNTO del comando, y si el comando no
// las asignó, con el ambiente. Lo que no se puede saber sin ejecutar (`$(…)`, `${VAR:-x}`, una variable que nadie
// define) queda «sin resolver»: se resuelve como siempre (del lado seguro: si cae en el repo, frena) y queda marcado,
// para que el mensaje diga que no se pudo resolver en vez de presentarlo como código del repo sin más.
// (Un lector compartido, `scripts/lib/shell-parse.js`, no sirve acá:
// da rutas falsas — la cabecera de command-vars.js dice por qué.)
const { expandirRuta } = require('./command-vars.js');
const { logHookError } = require('./bash-gate-net.js');

const RAIZ_DEL_ARNES = path.resolve(__dirname, '..', '..', '..', '..');
const dentroDelArnes = (abs) => {
  const rel = path.relative(RAIZ_DEL_ARNES, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
// El archivo de un módulo que no compila al pedirlo. Un .js roto deja en la primera línea de la pila «<archivo>:<línea>»;
// un .json, «SyntaxError: <archivo>: …». Un `JSON.parse` de datos no nombra ningún archivo.
function archivoQueNoCompila(e) {
  if (!e || e.name !== 'SyntaxError') return null;
  const primera = String(e.stack || '').split('\n')[0];
  const archivo = (/^(.+\.c?js):\d+$/.exec(primera) || /^SyntaxError: (.+?\.json): /.exec(primera) || [])[1];
  return archivo && path.isAbsolute(archivo) ? archivo : null;
}
// ¿El error de un `require` es un archivo del arnés que falta o no compila? Cuenta lo que se pide adentro del arnés, por
// su ruta; un paquete que falta no.
function esPiezaDelArnes(e, pedido, padre) {
  if (!(e && e.code === 'MODULE_NOT_FOUND') && !archivoQueNoCompila(e)) return false;
  const p = String(pedido || '');
  const abs = path.isAbsolute(p) ? p : (p.startsWith('.') && padre && padre.filename ? path.resolve(path.dirname(padre.filename), p) : null);
  return !!abs && dentroDelArnes(abs);
}
// En una versión bajada, un archivo del freno que no es el que se instaló (una instalación cortada: compila, pero quedó
// a medias) también es una pieza rota: la huella de git de cada archivo del arnés que el freno usó se compara con la de
// la lista. En un clon no: quien mantiene el arnés los cambia a propósito. Lo que no está en la lista (lo sumó una capa o
// un tercero) no se compara.
function archivoQueNoEsElInstalado() {
  const lista = path.join(RAIZ_DEL_ARNES, '.tycon-release.json');
  if (!fs.existsSync(lista) || fs.existsSync(path.join(RAIZ_DEL_ARNES, '.git'))) return null;
  let huellas = null;
  try { huellas = new Map(JSON.parse(fs.readFileSync(lista, 'utf8')).files.map((f) => [f.path, f.blob])); } catch (e) {
    return Object.assign(new Error(`${lista} no se puede leer (${e.message}): no sé si los archivos del freno son los instalados`), { instalado: lista });
  }
  for (const abs of Object.keys(require.cache)) {
    if (!dentroDelArnes(abs)) continue;
    const esperada = huellas.get(path.relative(RAIZ_DEL_ARNES, abs).split(path.sep).join('/'));
    if (!esperada) continue;
    let huella = null;
    try {
      const d = fs.readFileSync(abs);
      huella = require('crypto').createHash('sha1').update(`blob ${d.length}\0`).update(d).digest('hex');
    } catch { /* lo que no se puede leer tampoco es lo instalado */ }
    if (huella !== esperada) return Object.assign(new Error(`${abs} no es el que se instaló: su huella no es la de la versión`), { instalado: abs });
  }
  return null;
}
// Con respaldo, como en dispatch.js y on-write-collision.js: sin la lib (un skill instalado a medias) el portón no puede
// morir al cargar —saldría 1, que no frena, y sin dejar constancia—: resuelve las rutas como antes.
let nativePath = (p) => p;
try { ({ nativePath } = require('./path-shape.js')); } catch (e) { logHookError(e); /* sin normalización de rutas: conducta previa */ }

// ── extracción de targets de escritura ────────────────────────────────────────────────────────────

const Q = `(?:'([^']*)'|"([^"]*)"|([^\\s'"|;&<>]+))`; // token: 'x' | "x" | bare
function tok(m, i) { return m[i] ?? m[i + 1] ?? m[i + 2] ?? null; }

// (el `|` de `>|` y de `>&|`, que pisan el archivo aunque el shell no deje pisar, no separa; el de un `\>|` sí: ese `>`
// es una letra. Con un número par de barras delante, el `>` no está escapado)
const SEPARADOR_DE_SEGMENTOS = /&&|\|\||(?<!(?<!\\)(?:\\\\)*>&?)\|&|;|(?<!(?<!\\)(?:\\\\)*>&?)\||\n|(?<![<>&|\\])&(?![&>])/;
function splitSegments(cmd) {
  // Separadores de comandos (no dentro de comillas — aproximación: split simple alcanza para lo
  // que buscamos; las comillas raras caen del lado conservador = no se extrae nada).
  // también un `&` solo (segundo plano): `echo hi & cp a b` corre el cp. No `&&`, ni los de una redirección (`2>&1`, `&>`)
  // Los blancos de al lado de cada separador se sacan después, a mano, y no con `\s*` en la expresión, que con una
  // tirada larga de espacios la hace cuadrática.
  const partes = String(cmd).split(SEPARADOR_DE_SEGMENTOS);
  return partes.map((p, i) => {
    let s = p;
    if (i > 0) s = s.trimStart();
    if (i < partes.length - 1) s = s.trimEnd();
    return s;
  }).filter(Boolean);
}

/**
 * El tramo sin lo que el shell pone delante de un comando dentro de un bloque: `do`, `then`, `else`, `elif`, `if`,
 * `while`, `until`, `time`, `!`, y un `(` o `{` pegado. `for f in a; do cp a src/b.js; done` copia a `src/b.js` igual
 * que `cp a src/b.js`. Sacar de más sólo hace mirar de más.
 */
function sinPalabrasDeBloque(seg) {
  let t = String(seg).trim();
  for (let antes = null; antes !== t;) {
    antes = t;
    // (el `{` de un descriptor con nombre, `{fd}>f`, no abre un grupo)
    // (`time -p` con su opción: el comando es lo que sigue)
    t = t.replace(/^(?:(?:do|then|else|elif|if|while|until|time(?:[ \t]+-p)?|!)(?=[\s({])|\(|\{(?![A-Za-z_]\w*\}[<>]))\s*/, '');
  }
  // el `)` del paréntesis que se sacó adelante, pegado al último archivo (`(sed -i … docs/a.js)`): sólo los que sobran,
  // para no tocar un `$(…)` del final
  // (de atrás para adelante, una sola vez: con miles de `)` el recuento por vuelta colgaría el freno)
  let sobran = (t.match(/\)/g) || []).length - (t.match(/\(/g) || []).length;
  let fin = t.length;
  while (sobran > 0) {
    let k = fin;
    while (k > 0 && /\s/.test(t[k - 1])) k--;
    if (k === 0 || t[k - 1] !== ')') break;
    fin = k - 1;
    sobran--;
  }
  return t.slice(0, fin).trimEnd();
}

/**
 * Las palabras de un tramo sin su comentario del final ni sus redirecciones: las de salida (`2>&1`, `> f`) y las de
 * entrada (`< f`, `<<< palabra`, `<<EOF`, `<<-'EOF'`), cuyo archivo o delimitador no es un argumento del comando. Sin la
 * barra suelta del final (`cp a b \` sin renglón siguiente), que tampoco es el último argumento.
 */
// La palabra de una redirección, como la lee el shell: con lo citado, `$'…'`, `$(…)`, `${…}` y lo escapado pegado
// (`<<<x"y"`, `<'a b'c`, `<<<$(echo x y)`, `<<<a\ b`). Cada pieza empieza distinto: no hay dos formas de leer lo mismo.
// Un `$(` o `${` sin cerrar se lleva el resto del tramo: exigir el cierre recorre el resto una vez por cada uno
const PALABRA_DE_REDIRECCION = String.raw`(?:\$'(?:\\.|[^'\\])*'|\$"(?:\\.|[^"\\])*"|'[^']*'|"(?:\\.|[^"\\])*"|\$\([^)]*\)?|\$\{[^}]*\}?|\\.|[^\s'"\\|;&<>$]|\$(?![('{"]))+`;
// el descriptor de una redirección: una o más cifras, o un nombre (`{fd}`), al principio de una palabra
const DESCRIPTOR = String.raw`(?:\d+|\{[A-Za-z_]\w*\})`;
// (la palabra va en su propio grupo opcional: un `?` pegado al `+` de la palabra la volvería perezosa, de una letra. Y
// sin blancos opcionales delante del operador: con una tirada larga de blancos sin `>` detrás, cada blanco la recorrería
// entera)
const REDIRECCION_DE_SALIDA_CON_PALABRA = new RegExp(String.raw`(?:&|(?<!\S)${DESCRIPTOR})?>{1,2}(?:\||&)?[ \t]*(?:${PALABRA_DE_REDIRECCION})?`, 'g');
const REDIRECCION_DE_ENTRADA_CON_PALABRA = new RegExp(String.raw`(?:(?<!\S)${DESCRIPTOR})?<(?:<<|<-?|&|>)?[ \t]*(?:${PALABRA_DE_REDIRECCION})?`, 'g');

// ¿La redirección deja un `$(` o un `${` sin cerrar? El tramo se parte en el `;` o la tubería de adentro, y el resto de la
// sustitución queda en otro tramo
function sinCerrar(redireccion) {
  const a = redireccion.lastIndexOf('$(');
  const b = redireccion.lastIndexOf('${');
  return (a >= 0 && !redireccion.includes(')', a)) || (b >= 0 && !redireccion.includes('}', b));
}

function palabrasDelComando(seg, { conVacias = false } = {}) {
  // un comentario al final no es parte del comando
  const sinComentario = String(seg).replace(/(^|\s)#.*$/, '');
  // con una sustitución sin cerrar no se sabe dónde termina el comando: `words.sinCerrar` lo dice, y quien busca el
  // último argumento toma todos. En su lugar queda una palabra que no se resuelve: el destino puede haber quedado en el
  // tramo siguiente
  let abierta = false;
  const blanco = (r) => { if (!sinCerrar(r)) return ' '; abierta = true; return ' $( '; };
  const sinRedir = sinComentario
    .replace(REDIRECCION_DE_SALIDA_CON_PALABRA, blanco)
    .replace(REDIRECCION_DE_ENTRADA_CON_PALABRA, blanco);
  const words = (sinRedir.trim().match(new RegExp(Q, 'g')) || []).map((w) => {
    const mm = w.match(new RegExp(`^${Q}$`));
    return mm ? tok(mm, 1) : null;
  }).filter((w) => w != null && (conVacias || w !== ''));
  if (words[words.length - 1] === '\\') words.pop();
  words.sinCerrar = abierta;
  return words;
}

/** El último argumento que no es una opción; con el tramo sin cerrar (`palabrasDelComando`), todos. */
function ultimosArgumentos(words) {
  const sueltos = words.slice(1).filter((w) => !w.startsWith('-'));
  return words.sinCerrar ? sueltos : sueltos.slice(-1);
}

// Una redirección delante del comando (`> f cp a b`, `10>f cp a b`, `{fd}>f cp a b`, `<<<x cp a b`): el comando es lo
// que sigue
const REDIRECCION_DELANTE = new RegExp(String.raw`(?:(?:&|${DESCRIPTOR})?>{1,2}(?:\||&)?|${DESCRIPTOR}?<(?:<<|<-?|&|>)?)[ \t]*${PALABRA_DE_REDIRECCION}[ \t]*`, 'y');
function sinRedireccionesDelante(seg) {
  const t = String(seg).trim();
  let i = 0;
  REDIRECCION_DELANTE.lastIndex = 0;
  while (REDIRECCION_DELANTE.test(t)) i = REDIRECCION_DELANTE.lastIndex;
  return t.slice(i);
}

// los envoltorios que, después de sus opciones, llevan una palabra suya antes del comando: la duración, la prioridad, la
// máscara de procesadores
const CON_PALABRA_PROPIA = new Set(['timeout', 'chrt', 'taskset']);
// el principio de una palabra que es una redirección (`>f`, `2>`, `{fd}<x`, `&>f`, `>|f`)
const EMPIEZA_REDIRECCION = new RegExp(String.raw`^(?:&|${DESCRIPTOR})?(?:>{1,2}(?:\||&)?|<(?:<<|<-?|&|>)?)`);

/**
 * Dónde termina la palabra antes de un `<` o `>` sin comillas ni barra (el largo de la palabra si no hay). Lo de adentro
 * de `$(…)`, `` `…` `` y `${…}` no corta: ahí un `>` no es una redirección (`$(:>/dev/null)/bin/cp` es `cp`).
 */
function antesDeUnaRedireccion(crudo) {
  for (let i = 0; i < crudo.length; i++) {
    const c = crudo[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = crudo.indexOf("'", i + 1); if (j < 0) return crudo.length; i = j; continue; }
    if (c === '"') { let j = i + 1; while (j < crudo.length && crudo[j] !== '"') j += crudo[j] === '\\' ? 2 : 1; i = j; continue; }
    const fin = finDeSustitucion(crudo, i);
    if (fin === -1) return crudo.length;
    if (fin > i) { i = fin; continue; }
    if (c === '<' || c === '>') return i;
  }
  return crudo.length;
}

/**
 * Si en `i` empieza una sustitución (`$(…)`, `${…}` o `` `…` ``), dónde termina (contando las que se abren adentro); -1
 * si no cierra; `i` si ahí no empieza ninguna.
 */
function finDeSustitucion(w, i) {
  if (w[i] === '`') return w.indexOf('`', i + 1);
  if (w[i] !== '$' || (w[i + 1] !== '(' && w[i + 1] !== '{')) return i;
  const abre = w[i + 1];
  const cierra = abre === '(' ? ')' : '}';
  let hondo = 0;
  for (let j = i + 1; j < w.length; j++) {
    if (w[j] === '\\') { j++; continue; }
    if (w[j] === abre) hondo++;
    else if (w[j] === cierra && --hondo === 0) return j;
  }
  return -1;
}

/**
 * Los nombres que puede tener el programa de una palabra (`/bin/cp` es `cp`, `\cp` también), el primero el de siempre:
 * lo que sigue a su última barra, sin contar las de adentro de una sustitución (`cp$(:>/dev/null)` es `cp…`, no
 * `null)`). Con una sustitución que no cierra en la palabra (cierra después de un blanco), no se sabe si sus barras son
 * de la ruta (`/bin/cp$(:/ )`) o de lo que corre adentro (`$(/bin/cp`): van los dos nombres. `w`, la palabra con sus
 * comillas resueltas.
 */
function nombresDelPrograma(w) {
  // (`=cp` en zsh es la ruta de `cp`)
  const nombre = (barra) => w.slice(barra + 1).replace(/^[\\=]/, '').toLowerCase().replace(/\.exe$/, '');
  let barra = -1;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '/') { barra = i; continue; }
    const fin = finDeSustitucion(w, i);
    if (fin === -1) return [...new Set([nombre(barra), nombre(w.lastIndexOf('/'))])];
    i = fin;
  }
  return [nombre(barra)];
}

// los programas que escriben lo que nombran: entre los nombres posibles de una palabra, cuenta el que escribe
const ESCRIBE_LO_QUE_NOMBRA = /^(?:g?(?:cp|mv|ln|install|sed)|rsync|perl|truncate|tee)(?![\w.-])/;

// lo que zsh pone delante de un comando sin cambiar cuál corre: `noglob cp`, `nocorrect cp`, `- cp`
const MODIFICADORES_DE_ZSH = new Set(['noglob', 'nocorrect', '-']);

/**
 * La palabra sin sus sustituciones que cierran (`nohup$(:/ )` es `nohup`); desde una que no cierra, queda como está. Una
 * pasada: buscar el cierre con una expresión desde cada `$(` sin cerrar crece con el cuadrado del largo.
 */
function sinSustitucionesCerradas(w) {
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const fin = finDeSustitucion(w, i);
    if (fin === -1) return out + w.slice(i);
    if (fin > i) { i = fin; continue; }
    out += w[i];
  }
  return out;
}

// los programas que copian o mueven a un destino que es su último argumento (o la carpeta de `-t`); el nombre entero
// (`install.sh` es un guion, no `install`), y lo que el shell pega detrás no es parte del nombre (`cp>log`, `cp$x`)
const COPIA = /^(?:g?(?:cp|mv|ln|install)|rsync)(?![\w.-])/;

/** `cd <dir> && …` al inicio: el dir contra el que resolver targets relativos (best-effort). */
function leadingCd(cmd) {
  const m = String(cmd || '').match(/^\s*cd\s+(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))\s*(?:&&|;)/);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// La forma de `$(…)` que el nombre de un informe puede llevar: `$(date +F)` con un formato sólo de dígitos, `-` y `_`.
// Su salida no tiene `/` ni `.`. (`basename` no entra: `basename /` da `/`, y su salida puede abrir una carpeta)
const SUBCOMANDO_EN_DESTINO = String.raw`\$\(date \+(?:%[YmdHMSsjy]|[-_])+\)`;
// el destino entero detrás de `>`, `>>` o `tee`, que termina en un espacio, un operador o el final: nunca en una
// comilla ni en una barra invertida, que lo seguirían (`r-$(date +%s).md'.ts'` escribe un `.ts`)
const DESTINO_CON_SUBCOMANDO = new RegExp(String.raw`((?:^|[^<>&])(?:>{1,2}|\btee(?:[ \t]+-a)?)[ \t]*)((?:[^\s'"|;&<>$\`()\\]|\$\{?[A-Za-z_]\w*\}?|${SUBCOMANDO_EN_DESTINO})+)(?=$|[\s;&|)<>])`, 'g');

/**
 * Qué posiciones de `cmd` son texto de comando: fuera de las comillas y fuera del cuerpo de un heredoc. Un `>` adentro
 * de un mensaje de commit o de un heredoc no es una redirección.
 */
function posicionesDeComando(cmd) {
  const s = String(cmd || '');
  const es = new Array(s.length).fill(true);
  for (const m of s.matchAll(/(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n((?:[\s\S]*?\n)??)[ \t]*\2[ \t]*(?=\n|$)/g)) {
    const desde = m.index + m[0].indexOf('\n') + 1;
    for (let i = desde; i < m.index + m[0].length; i++) es[i] = false;
  }
  let q = null;
  for (let i = 0; i < s.length; i++) {
    if (!es[i]) continue;
    const c = s[i];
    if (q) { es[i] = false; if (c === q) q = null; else if (c === '\\' && q === '"') { es[i + 1] = false; i++; } continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; es[i] = false; }
  }
  return es;
}

/**
 * El comando con cada `$(date +F)` adentro de un destino de escritura `.md` o `.log` cambiado por un comodín de un
 * segmento: `{ cmd, destinos }`, con `destinos` los destinos con comodín (`out/run-*.log`). Sólo cuando el destino es
 * texto de comando, cada `$(…)` está pegado a texto en su segmento (nunca el segmento entero) y la carpeta que se sabe
 * antes del primer `$(…)` pasa `seguro(carpeta, glob)`; si no, ese destino queda como está y frena como hoy.
 */
function subcomandosComoComodin(cmd, seguro) {
  const destinos = [];
  const texto0 = String(cmd || '');
  // un `date` que el comando redefine (función, alias, otro PATH) ya no es el de siempre: su salida no se sabe
  if (/\bdate\s*\(\s*\)|\bfunction\s+date\b|\balias\s+date\b|(?:^|[\s;&|(])(?:export\s+)?PATH=/.test(texto0)) return { cmd, destinos };
  const es = posicionesDeComando(cmd);
  const texto = texto0.replace(DESTINO_CON_SUBCOMANDO, (todo, antes, palabra, en) => {
    const desde = en + antes.length;
    if (!es.slice(desde, desde + palabra.length).every(Boolean)) return todo;
    if (!new RegExp(SUBCOMANDO_EN_DESTINO).test(palabra) || !/\.(?:md|log)$/.test(palabra)) return todo;
    // lo que el shell expande en el destino además del `$(…)`: llaves (`{specs,out}`), comodines escritos y un `~` que
    // no está al principio. Con eso la carpeta no es la que se lee: queda como está
    const sinSub = palabra.replace(new RegExp(SUBCOMANDO_EN_DESTINO, 'g'), '').replace(/\$\{[A-Za-z_]\w*\}/g, '');
    if (/[{}*?[]/.test(sinSub) || /.~/.test(sinSub)) return todo;
    const glob = palabra.replace(new RegExp(SUBCOMANDO_EN_DESTINO, 'g'), '*');
    const segmentos = glob.split('/');
    if (segmentos.some((s) => /^\*+$/.test(s))) return todo;
    const conocida = segmentos.slice(0, segmentos.findIndex((s) => s.includes('*'))).join('/') || '.';
    if (!seguro(conocida, glob)) return todo;
    destinos.push(glob);
    return antes + glob;
  });
  return { cmd: texto, destinos };
}

// cuántos `env -S` adentro de otros se leen: más hondo, quedan las otras lecturas
const HONDO_DE_ENV_S = 4;

// las opciones de rsync que escriben el archivo que nombran: el registro y el lote
const RSYNC_ESCRIBE = /^--(?:log-file|write-batch|only-write-batch)(?:=([\s\S]*))?$/;

/** Los archivos que un rsync escribe por sus opciones (`--log-file`, `--write-batch`), pegados con `=` o en la palabra que sigue. */
function archivosDeRsync(palabras) {
  const out = [];
  for (let i = 1; i < palabras.length; i++) {
    const m = RSYNC_ESCRIBE.exec(palabras[i]);
    if (!m) continue;
    const valor = m[1] !== undefined ? m[1] : palabras[i + 1];
    if (valor) out.push(valor);
  }
  return out;
}

/** Dónde cierra el paréntesis que abre en `s[i]`, contando los que se abren adentro; -1 si no cierra. */
function cierreDeParentesis(s, i) {
  let hondo = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '(') hondo++;
    else if (s[j] === ')' && --hondo === 0) return j;
  }
  return -1;
}

/**
 * Agrega a `out` los archivos que edita en su lugar un `sed -i` / `--in-place` o un `perl -i` / `-pi` / `-ni` que empieza
 * `head`: todo token con extensión de código, o que quien llama quiere mirar igual (`keep`). `raw`, el comando entero.
 */
const sufijoVacioDe = { raw: null, hay: false };
function destinosDelSedEnSitio(head, raw, keep, out) {
  const isSedI = /^sed\b/.test(head) && /(^|\s)(-i\b|-[a-zA-Z]*i[a-zA-Z]*\b(?=\s)|--in-place)/.test(head);
  // (con el separador de registro en el mismo grupo: `-0pi`, `-0777pi`)
  const isPerlI = /^perl\b/.test(head) && /(^|\s)-[a-zA-Z0-9]*i\S*(\s|$)/.test(head);
  if (!isSedI && !isPerlI) return;
  const words = head.match(new RegExp(Q, 'g')) || [];
  // el nombre del comando y, si no hay -e / -f, la expresión (el primer argumento) no son archivos: `keep` no los mira
  const conExpresionAparte = /(^|\s)(-[a-zA-Z]*[ef]|--expression|--file)/.test(head) || isPerlI;
  let args = 0;
  let esValorDeE = false;   // lo que sigue a -e / --expression es la expresión, no un archivo
  let anterior = null;
  // en el comando escrito, ¿hay un `-i ''` de verdad (el sufijo vacío de Mac) o es una expresión que se vació? (una vez
  // por comando: con miles de `sed -i` en uno, buscarlo en cada uno lo recorre entero cada vez)
  if (sufijoVacioDe.raw !== raw) { sufijoVacioDe.raw = raw; sufijoVacioDe.hay = /(^|\s)-i\s+(''|"")(\s|$)/.test(raw); }
  const sufijoVacio = sufijoVacioDe.hay;
  for (const w of words.slice(1)) {
    const mm = w.match(new RegExp(`^${Q}$`));
    const t = mm ? tok(mm, 1) : null;
    if (t == null) continue;
    const previo = anterior; anterior = t;
    if (t.startsWith('-')) { esValorDeE = /^(-[a-zA-Z]*e|--expression)$/.test(t); continue; }
    if (esValorDeE) { esValorDeE = false; continue; }
    // `sed -i ''` (Mac): el `''` es el sufijo de -i. Si no, una expresión con espacios llega vaciada y ocupa su lugar
    if (t === '') { if (!(isSedI && previo === '-i' && sufijoVacio)) args++; continue; }
    args++;
    const esExpresion = !conExpresionAparte && args === 1;
    // una ruta con variable (`$f`, `${D}/x.js`) también es un destino, que se resuelve o se dice que no. Una expresión
    // de sed que quedó en otro lugar (`-i''` pegado corre la cuenta) no: lleva espacios o arranca con `s/`, `y/`
    const rutaConVariable = /\$\{?[A-Za-z_]/.test(t) && !/\s/.test(t) && !/^[sy][^\w\s]/.test(t);
    if (isCodeFile(t) || isManifestFile(t) || (keep && !esExpresion && keep(t)) || (!esExpresion && rutaConVariable)) out.add(t);
  }
}

// ── lo que el registro tampoco ve: un intérprete que escribe en un destino armado, y borrar o deshacer ────────────

const INTERPRETES = 'node|nodejs|python[0-9.]*|perl|ruby|pwsh|powershell';
// un destino escrito como una sola ruta literal, o la salida estándar: no está armado. Con un `$` adentro no es literal:
// perl, PowerShell y el shell interpolan entre comillas dobles
const DESTINO_LITERAL = /^(?:(['"])[^'"$]*\1|`[^`$]*`|\d+|process\.std(?:out|err)(?:\.fd)?|sys\.std(?:out|err)|['"]?\/dev\/std(?:out|err)['"]?)$/;

/** Las palabras de un tramo de comando, con sus comillas resueltas (`'a b'` es una palabra). */
function palabras(tramo) {
  return (String(tramo).match(new RegExp(Q, 'g')) || []).map((w) => {
    const mm = w.match(new RegExp(`^${Q}$`));
    return mm ? tok(mm, 1) : null;
  }).filter((w) => w != null);
}

/** Los argumentos que siguen a un script, sin redirecciones; el `--` de node no cuenta (node lo saca de `process.argv`). */
function argumentosDe(resto) {
  const sinRedir = String(resto || '').replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
  const w = palabras(sinRedir).filter((x) => x !== '');
  return w[0] === '--' ? w.slice(1) : w;
}

// Quién lee el programa de la entrada lo decide el lector compartido, el mismo del freno de producción: los dos juzgan
// igual el mismo comando. Sólo se usa esta función; las variables las sigue resolviendo command-vars.js. Sin el lector
// (una instalación a medias) el portón carga igual, y cada cuerpo de heredoc cuenta como programa: frena de más
let lectorDeEntrada;
// lo que leyó para los últimos comandos: el freno lo pide unas cinco veces por comando, y con una tubería larga de
// here-strings cada lectura tarda segundos
const ENTRADAS_LEIDAS = new Map();
function programasPorEntrada(raw) {
  const ya = ENTRADAS_LEIDAS.get(raw);
  if (ya) return ya;
  const leidos = leerProgramasPorEntrada(raw);
  if (ENTRADAS_LEIDAS.size >= 8) ENTRADAS_LEIDAS.delete(ENTRADAS_LEIDAS.keys().next().value);
  ENTRADAS_LEIDAS.set(raw, leidos);
  return leidos;
}
function leerProgramasPorEntrada(raw) {
  if (lectorDeEntrada === undefined) {
    try { ({ programasPorEntrada: lectorDeEntrada } = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'shell-parse.js'))); } catch (e) { logHookError(e); lectorDeEntrada = null; }
  }
  if (lectorDeEntrada) return lectorDeEntrada(raw);
  return [...raw.matchAll(/(?<!<)<<(?!<)(?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*<<)(?<!\$\(\([^\n]*<<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\1(?=[\s;&|()<>]|$)[^\n]*\n(?:([\s\S]*?)\n)??[ \t]*\2[ \t]*(?=\n|$)/g)]
    .map((m) => ({ interprete: '', conGuion: false, despues: [], cuerpo: m[3] || '', comillas: Boolean(m[1]) }));
}

// los intérpretes que corren un guion guardado en un archivo
const CORRE_ARCHIVO = /^(?:node|nodejs|python[0-9.]*|perl|ruby|bun|deno|tsx|ts-node)$/;
// lo que el guion escribe se lee entero hasta este tamaño; más grande, cuenta si nombra una historia o una constancia
const GUION_TOPE = 256 * 1024;
const GUION_TOPE_DURO = 64 * 1024 * 1024;
// el recorrido de los módulos locales: lo medido sobre los despachadores sin partir (marker.js, 127 módulos en 14
// niveles) por dos. Lo que queda más allá no se corta callado: se juzga como un guion que no se lee entero
const RECORRIDO_NIVELES = 28;
const RECORRIDO_ARCHIVOS = 254;
// lo que un comando puede hacerle leer al freno entre todos sus guiones y módulos (lo medido en los despachadores son
// unos 3 MB): el freno corre antes de cada comando, y un guion armado a propósito no le agota la memoria
const RECORRIDO_BYTES = 2 * GUION_TOPE_DURO;
const ESCANEO_REINTENTO_MS = 3000;
const CORCHETE_TOPE = 64;
const CLASES_POSIX = {
  alnum: '\\p{L}\\p{N}', alpha: '\\p{L}', blank: ' \\t', cntrl: '\\p{Cc}', digit: '0-9', graph: '\\S', lower: '\\p{Ll}', print: '\\S ',
  punct: '\\p{P}\\p{S}', space: '\\s', upper: '\\p{Lu}', xdigit: '0-9a-fA-F',
};
// la palabra entera: «historial», «storage» o «restore» no nombran una historia
const MENCIONA_HISTORIA = /control-changes|exemptions\.jsonl|\bstor(?:y|ies)\b|\bhistorias?\b/i;

/**
 * ¿La carpeta está en un repo con historias? Su raíz de git (sin git, la carpeta misma) con `.tycon/`, o con alguna
 * historia que encuentre el descubridor del arnés (el mismo de los demás frenos). Sin su caché: un «ninguna» de hace
 * una hora no ve la primera historia recién escrita. Un escaneo que falló cuenta como que sí: no se sabe. Uno que no
 * terminó y no encontró ninguna se repite con más tiempo, para que lo cargada que esté la máquina no decida; si tampoco
 * termina, cuenta como que no y queda dicho: la ruta de una historia y la constancia frenan igual.
 */
function repoConHistorias(carpeta) {
  try {
    const sd = require('./story-discovery.js');
    const raiz = sd.findRepoRoot(carpeta) || carpeta;
    if (fs.existsSync(path.join(raiz, '.tycon'))) return true;
    let r = sd.discoverStories(raiz, { cache: false });
    if (r.partial && !r.stories.length) r = sd.discoverStories(raiz, { cache: false, budgetMs: ESCANEO_REINTENTO_MS });
    if (r.partial && !r.stories.length) logHookError(new Error(`el escaneo de historias de ${raiz} no terminó en ${ESCANEO_REINTENTO_MS} ms`));
    return r.stories.length > 0;
  } catch (e) { logHookError(e); return true; }
}
const EXTENSION_DE = { python: /\.py$/i, node: /\.(?:[cm]?js|[cm]?ts)$/i, perl: /\.p[lm]$/i, ruby: /\.rb$/i };
const familiaDe = (interprete) => (/^python/.test(interprete) ? 'python' : interprete === 'perl' ? 'perl' : interprete === 'ruby' ? 'ruby' : 'node');
const INTERPRETE_DE = { python: 'python3', node: 'node', perl: 'perl', ruby: 'ruby' };

// Una palabra del comando con sus variables expandidas y sin las comillas que la envuelven: `"${F}"` es la ruta de F
const palabraExpandida = (cmd, w) => String(expandirRuta(cmd, w).valor).replace(/^"([^"]*)"$|^'([^']*)'$/, (_, a, b) => (a !== undefined ? a : b));

// una palabra que es sólo una variable: `$N`, `${N}` (no `$VENV/bin/black`, donde el programa es el nombre escrito)
const SOLO_VARIABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
// lo que el shell lee antes del programa dentro de un tramo: `if`, `then`, `do`, `!`…
const ANTES_DEL_PROGRAMA = /^(?:if|then|else|elif|do|while|until|!)$/;
/** ¿El freno no puede leer qué programa es esta palabra? Una variable sin valor conocido, una sustitución o `eval`. */
function noSeLeeElPrograma(cmd, w) {
  const s = String(w);
  // `$((…))` es una cuenta, no una sustitución
  if (s === 'eval' || /\$\((?!\()|`/.test(s)) return true;
  if (!SOLO_VARIABLE.test(s)) return false;
  const e = expandirRuta(cmd, s);
  return e.sinResolver.length > 0 || /^\$/.test(String(e.valor));
}

/** La palabra sin los signos del shell que la pegan a un grupo: `(python3`, `p.py)`, `{`. */
// sin lo que abre o cierra una agrupación (`(`, `{`, `)`, `}`, `;`); la llave que cierra una variable (`${F}`) se queda
const sinGrupo = (w) => {
  const s = String(w).replace(/^[({]+/, '');
  const conVariable = s.match(/^(.*\$\{[^{}]*\})[)};]*$/);
  return conVariable ? conVariable[1] : s.replace(/[)};]+$/, '');
};

function rutaRealDelGuion(valor, base) {
  const crudo = valor.startsWith('~/') ? os.homedir() + valor.slice(1) : path.isAbsolute(valor) ? valor : `${base}${path.sep}${valor}`;
  try { return fs.realpathSync.native(crudo); } catch { return null; }
}

/** Los módulos locales que importa un guion, como rutas relativas a su carpeta (los de la biblioteca no existen ahí). */
function importsLocales(familia, texto, dir) {
  const out = [];
  if (familia === 'python') {
    for (const m of texto.matchAll(/^[ \t]*(?:from[ \t]+\.?([\w.]+)[ \t]+import\b|import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*))/gm)) {
      for (const n of (m[1] || m[2]).split(',').map((x) => x.trim().replace(/\./g, '/'))) out.push(`${n}.py`, `${n}/__init__.py`);
    }
  } else if (familia === 'ruby') {
    for (const m of texto.matchAll(/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(/\.rb$/.test(m[1]) ? m[1] : `${m[1]}.rb`);
  } else if (familia === 'node') {
    for (const m of texto.matchAll(/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
      out.push(m[2], ...['.js', '.cjs', '.mjs', '.ts', '/index.js'].map((e) => m[2] + e));
    }
  }
  return [...new Set(out)].filter((r) => { try { return fs.statSync(path.join(dir, r)).isFile(); } catch { return false; } });
}

/**
 * ¿`real` es un guion del árbol de este freno, y ese árbol es el arnés y no un repo donde se trabaja? Sin git (una
 * versión bajada) es el arnés. En un clon de trabajo, el de quien lo mantiene, cuenta sólo lo versionado, sin cambios
 * y como está en main del servidor: un guion nuevo, cambiado ahí o que sólo trae otra rama no es del arnés. Si git no
 * responde, tampoco.
 *
 * `memo` (de una sola llamada del freno) guarda la respuesta por ruta, la rama principal y si HEAD tiene commits que
 * ella no tiene: sin ninguno, ningún archivo tiene uno propio y no se pregunta archivo por archivo.
 */
function versionadoEnElArbolPropio(real, memo = { porRuta: new Map() }) {
  if (memo.porRuta.has(real)) return memo.porRuta.get(real);
  const r = versionadoSinMemo(real, memo);
  memo.porRuta.set(real, r);
  return r;
}

function versionadoSinMemo(real, memo) {
  const arbol = (() => { try { return fs.realpathSync.native(path.resolve(__dirname, '..', '..', '..', '..')); } catch { return null; } })();
  if (!arbol || !isInsideReal(arbol, real)) return false;
  const conGit = (() => {
    for (let d = arbol; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return true;
      if (path.dirname(d) === d) return false;
    }
  })();
  if (!conGit) return true;
  const rel = path.relative(arbol, real);
  const { spawnSync } = require('child_process');
  // sin el repo de quien llama: un GIT_DIR heredado haría contestar a otro repo; la ruta, literal: `orq-[x].js` no
  // es un patrón que encuentre a `orq-x.js`. Sin los reemplazos de objetos: `refs/replace/<punta de main>` haría pasar
  // otro commit por main
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  // sin el programa que el clon configure para vigilar archivos: lo correría el freno, y puede mostrar limpio un guion
  // editado. Sin el índice de archivos tocados por commit: si lo reescriben, esconde el commit local que tocó el guion
  const git = (args) => spawnSync('git', ['-C', arbol, '-c', 'core.fsmonitor=false', '-c', 'commitGraph.readChangedPaths=false', ...args], { windowsHide: true, encoding: 'utf8', timeout: 3000, env });
  // `-v` marca con minúscula o con `S` lo que git dejó de mirar (`--assume-unchanged`, `--skip-worktree`)
  const versionado = git(['ls-files', '-v', '--error-unmatch', '--', rel]);
  if (versionado.status !== 0) return false;
  const lineas = versionado.stdout.split('\n').filter(Boolean);
  if (lineas.length !== 1 || lineas[0] !== `H ${rel.split(path.sep).join('/')}`) return false;
  const cambios = git(['status', '--porcelain', '--', rel]);
  if (cambios.status !== 0 || cambios.stdout.trim() !== '') return false;
  // un commit que no está en main del servidor y toca el guion no cuenta: lo pudo escribir quien llama, y empujarlo a
  // otra rama del servidor no lo hace revisado. Los que tocan otros archivos no cambian este guion. Sin main, no cuenta
  if (!memo.arbol || memo.arbol.raiz !== arbol) {
    const principal = ['refs/remotes/origin/main', 'refs/remotes/origin/master']
      .find((ref) => git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).status === 0);
    // sin commits propios en todo HEAD, tampoco los hay para un archivo; si git no contesta, se pregunta por archivo
    const propios = principal ? git(['rev-list', '-n1', 'HEAD', '--not', principal]) : null;
    memo.arbol = { raiz: arbol, main: principal, sinPropios: !!propios && propios.status === 0 && propios.stdout.trim() === '' };
  }
  const main = memo.arbol.main;
  if (!main) return false;
  if (memo.arbol.sinPropios) return true;
  const locales = git(['rev-list', '-n1', '--full-history', 'HEAD', '--not', main, '--', rel]);
  if (locales.status !== 0) return false;
  if (locales.stdout.trim() === '') return true;
  // salvo que lo deje igual a la punta de main. Igual a una versión vieja o a otra rama no cuenta
  const relGit = rel.split(path.sep).join('/');
  if (/[\n\r]/.test(relGit)) return false;
  const propio = git(['rev-parse', '--verify', '-q', `HEAD:${relGit}`]);
  const enMain = git(['rev-parse', '--verify', '-q', `${main}:${relGit}`]);
  return propio.status === 0 && enMain.status === 0 && propio.stdout.trim() === enMain.stdout.trim();
}

/**
 * ¿`real` (ya resuelta, fuera del árbol del freno) tiene los mismos bytes que main del árbol del freno en la misma ruta?
 * Es otra copia del arnés (una carpeta de trabajo aparte) con lo revisado: se trata como al guion del árbol propio. La
 * ruta es la que tiene dentro de su copia, la carpeta más cercana con `.git`, buscada sin correr git en ella (lo que esa
 * copia configure no corre). Sin main o sin esa ruta en main, no cuenta; sin git en el árbol del freno (una
 * instalación), se compara con el archivo de esa ruta en el árbol. Sólo se pregunta por los que pasan del tope de lectura.
 */
function igualAMainDelArbolPropio(real, memo = { porRuta: new Map() }) {
  const clave = `main:${real}`;
  if (memo.porRuta.has(clave)) return memo.porRuta.get(clave);
  let r = false;
  try { r = igualAMainSinMemo(real); } catch { r = false; }
  memo.porRuta.set(clave, r);
  return r;
}

function igualAMainSinMemo(real) {
  const arbol = (() => { try { return fs.realpathSync.native(path.resolve(__dirname, '..', '..', '..', '..')); } catch { return null; } })();
  if (!arbol || isInsideReal(arbol, real)) return false;
  let copia = null;
  for (let d = path.dirname(real); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { copia = d; break; }
    if (path.dirname(d) === d) break;
  }
  if (!copia) return false;
  const rel = path.relative(copia, real).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || /[\n\r]/.test(rel)) return false;
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > GUION_TOPE_DURO) return false;
  // sin git (una instalación, una versión bajada) el árbol entero es el arnés: se compara con el archivo de esa ruta
  const conGit = (() => {
    for (let d = arbol; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return true;
      if (path.dirname(d) === d) return false;
    }
  })();
  if (!conGit) {
    const propio = path.join(arbol, ...rel.split('/'));
    let real2;
    try { real2 = fs.realpathSync.native(propio); } catch { return false; }
    if (!isInsideReal(arbol, real2)) return false;
    const st2 = fs.statSync(real2);
    if (!st2.isFile() || st2.size !== st.size) return false;
    return fs.readFileSync(real2).equals(fs.readFileSync(real));
  }
  const { spawnSync } = require('child_process');
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const git = (args) => spawnSync('git', ['-C', arbol, '-c', 'core.fsmonitor=false', ...args], { windowsHide: true, encoding: 'utf8', timeout: 3000, env });
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).status !== 0) continue;
    const enMain = git(['rev-parse', '--verify', '-q', `${ref}:${rel}`]);
    if (enMain.status !== 0) return false;
    const oid = enMain.stdout.trim();
    const algoritmo = oid.length === 64 ? 'sha256' : oid.length === 40 ? 'sha1' : null;
    if (!algoritmo) return false;
    const bytes = fs.readFileSync(real);
    const h = require('crypto').createHash(algoritmo);
    h.update(`blob ${bytes.length}\0`);
    h.update(bytes);
    return h.digest('hex') === oid;
  }
  return false;
}

/** ¿`p` (ya resuelta) cae adentro de la carpeta `dir`, comparadas por su ruta real? */
function isInsideReal(dir, p) {
  const installedTree = require('./installed-tree.js');
  const d = installedTree.realPath(dir) || path.resolve(dir);
  const rel = path.relative(d, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * El primer argumento de la llamada que abre en `desde` (el carácter después del paréntesis), respetando comillas y
 * paréntesis anidados: `{ arg, fin }` con `fin` en la coma o el paréntesis que lo cierra. Se busca hasta 4 KB: un guion
 * con miles de llamadas sin cerrar no hace recorrer el texto entero por cada una.
 */
function primerArgumento(texto, desde) {
  let nivel = 0;
  let q = null;
  const hasta = Math.min(texto.length, desde + 4096);
  for (let i = desde; i < hasta; i++) {
    const c = texto[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(' || c === '[' || c === '{') nivel++;
    else if (c === ')' || c === ']' || c === '}') { if (nivel === 0) return { arg: texto.slice(desde, i).trim(), fin: i }; nivel--; } else if (c === ',' && nivel === 0) return { arg: texto.slice(desde, i).trim(), fin: i };
  }
  return { arg: texto.slice(desde, hasta).trim(), fin: hasta };
}

// Un modo de abrir que sólo lee: `'r'`, `'rb'`, `"rt"` en python y ruby, con la codificación de ruby (`'r:utf-8'`,
// `'rb:BOM|utf-8'`), `'<'` y `'<:encoding(UTF-8)'` en perl, y `os.O_RDONLY` sola en os.open
const MODO_SOLO_LEE = /^(?:(['"])(?:[rbtU<]*|r[bt]?:[\w|-]+(?::[\w|-]+)?|<:[\w()|:-]+)\1|os\.O_RDONLY)$/;
const ARGUMENTO_CON_NOMBRE = /^[A-Za-z_]\w*\s*=(?!=)/;
// los argumentos con nombre de un `open(` que no cambian cómo abre: el archivo y su lectura
const ARGUMENTOS_DE_LECTURA = new Set(['file', 'path', 'encoding', 'errors', 'newline', 'buffering', 'closefd']);
/** Los argumentos de la llamada que abre en `desde`, hasta 16; null si no se terminan de leer. */
function argumentosDeLlamada(texto, desde) {
  const args = [];
  let pos = desde;
  for (let k = 0; k < 16; k++) {
    const a = primerArgumento(texto, pos);
    if (a.arg) args.push(a.arg);
    if (texto[a.fin] === ')') return args;
    if (texto[a.fin] !== ',') return null;
    pos = a.fin + 1;
  }
  return null;
}
/**
 * El archivo que abre un `open(` que empieza en `desde`: el de `file=` o `path=` en cualquier lugar
 * (`open(mode='w', file=p)`), o el primer argumento posicional. null si no se terminan de leer.
 */
function archivoQueAbre(texto, desde) {
  const args = argumentosDeLlamada(texto, desde);
  if (!args) return null;
  const conNombre = args.map((a) => /^(file|path)\s*=(?!=)\s*([\s\S]*)$/i.exec(a)).find(Boolean);
  if (conNombre) return conNombre[2].trim();
  return args.find((a) => !ARGUMENTO_CON_NOMBRE.test(a)) || null;
}
// una llamada a `open(`: como método también con blancos o una continuación de línea antes (`Path(p) . open(`,
// `.\⏎open(`) y con `::` (`[IO.File]::Open(`); sin distinguir mayúsculas, como las formas de escribir
const OPEN_LLAMADA = /(\.[\s\\]*|::\s*)?\bopen\s*\(/gi;
/** El texto con las comillas escapadas del shell (`\"`, `\'`) leídas como comillas. */
const sinEscapesDeComillas = (texto) => String(texto || '').replace(/\\(["'])/g, '$1');

/**
 * Las rutas que una expresión nombra si sale sólo de literales: `'a.ts'`, `['a', 'b']`, `os.path.expanduser('~/x')`,
 * `path.join('a', 'b')`, `Path('a')`. null si algo no es literal.
 */
function literalesDe(expr) {
  const e = String(expr || '').trim();
  // con `$VAR` adentro también: quien lo juzga la expande con las variables del comando (un heredoc sin comillas)
  const lit = /^(['"])([^'"]*)\1$/.exec(e);
  if (lit) return [lit[2]];
  const partes = (cuerpo) => {
    const out = [];
    let desde = 0;
    while (desde < cuerpo.length) {
      const a = primerArgumento(cuerpo, desde);
      const l = /^(['"])([^'"]*)\1$/.exec(a.arg);
      if (!l) return null;
      out.push(l[2]);
      desde = a.fin + 1;
      if (cuerpo[a.fin] !== ',') break;
    }
    return out.length ? out : null;
  };
  const lista = /^\[([\s\S]*)\]$/.exec(e);
  if (lista) return partes(lista[1]);
  const llamada = /^(os\.path\.expanduser|os\.path\.abspath|os\.path\.join|path\.join|path\.resolve|Path)\s*\(([\s\S]*)\)$/.exec(e);
  if (llamada) {
    const p = partes(llamada[2]);
    if (!p) return null;
    return /join|resolve/.test(llamada[1]) ? [p.join('/')] : (p.length === 1 ? p : null);
  }
  return null;
}

/**
 * Lo que se sabe de un destino armado sin ejecutar el script: `literal` si es una variable que el mismo script asigna a
 * una ruta literal (`const p = 'src/a.ts'`) o un argumento del comando, `ext` si termina en un literal con extensión
 * (`dir + '/findings.json'`).
 */
/**
 * Cuántas veces se le asigna algo a `nombre` en un script, por cualquier forma que se lea: `nombre = …` (también entre
 * paréntesis o como argumento con nombre: contar de más sólo deja el destino sin resolver), una asignación compuesta
 * (`nombre += …`, `nombre ||= …`, `nombre := …`), un desempaquetado (`a, nombre = …`, `[a, nombre] = …`, `{ nombre } = …`)
 * y la variable de un bucle (`for nombre in …`, `for (const nombre of …)`).
 */
function vecesAsignado(script, nombre) {
  const s = String(script || '');
  const n = String(nombre).replace(/\$/g, '\\$');
  let veces = (s.match(new RegExp(`(?<![\\w$.])${n}[ \\t]*=(?!=)`, 'gm')) || []).length;
  veces += (s.match(new RegExp(`(?<![\\w$.])${n}[ \\t]*(?:\\*\\*|\\/\\/|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^:])=(?!=)`, 'gm')) || []).length;
  // con anotación de tipo: `nombre: str = …` · `let nombre: string = …`
  veces += (s.match(new RegExp(`(?<![\\w$.])${n}[ \\t]*:[^=\\n;:]+=(?!=)`, 'gm')) || []).length;
  // al principio de una sentencia, con o sin corchetes; después de un paréntesis, sólo con corchetes o llaves (sin ellos
  // es una llamada: `open(p, encoding=…)`)
  for (const m of s.matchAll(/(?:(?:^|[;\n])[ \t]*(?:const[ \t]+|let[ \t]+|var[ \t]+)?([[{])?|\([ \t]*([[{]))([\w$ \t]+(?:,[\w$ \t]*)*)[\]}]?[ \t]*=(?!=)/g)) {
    m[1] = m[1] || m[2];
    m[2] = m[3];
    const nombres = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    // sin corchetes, el último nombre ya contó como `nombre = …`; entre corchetes o llaves, ninguno
    const cuentan = m[1] ? nombres : nombres.slice(0, -1);
    if (cuentan.includes(nombre)) veces++;
  }
  veces += (s.match(new RegExp(`\\bfor[ \\t]*\\(?[ \\t]*(?:const[ \\t]+|let[ \\t]+|var[ \\t]+)?${n}[ \\t]+(?:in|of)\\b`, 'g')) || []).length;
  return veces;
}

function leerArmado(expr, script, argv) {
  // `process.argv[k]` / `sys.argv[k]` / `$ARGV[k]` (perl cuenta desde 0), con o sin una cola literal
  const desdeArgv = (e) => {
    const m = /^(?:(?:process|sys)\.argv\[(\d+)\]|\$ARGV\[(\d+)\])\s*(?:\+\s*(['"`])([^'"`]*)\3)?$/.exec(e);
    if (!m) return null;
    const k = m[1] != null ? Number(m[1]) - 1 : Number(m[2]);
    return argv[k] != null ? argv[k] + (m[4] || '') : null;
  };
  const deArgv = desdeArgv(expr);
  if (deArgv) return { literal: deArgv };
  const directos = literalesDe(expr);
  if (directos) return { literales: directos };
  if (/^\$?[A-Za-z_][\w$]*$/.test(expr)) {
    const nombre = expr.replace(/\$/g, '\\$');
    // cuántas veces se le asigna algo al nombre en el script. Con una, su lado derecho; con varias `nombre = …`, todas:
    // si cada una sale de literales, se juzgan todas las rutas (un script que edita dos archivos con la misma variable);
    // un desempaquetado o un bucle entre ellas no se sabe
    const asignaciones = vecesAsignado(script, expr);
    const simples = [...script.matchAll(new RegExp(`(?<![\\w$.])(?<![,(][ \\t]*)${nombre}[ \\t]*=(?!=)[ \\t]*([^;\\n]+)`, 'gm'))].map((x) => x[1].trim());
    if (asignaciones === 1 && simples.length === 1 && desdeArgv(simples[0])) return { literal: desdeArgv(simples[0]) };
    if (simples.length && simples.length === asignaciones) {
      // el lado derecho entero tiene que salir de literales: `p = 'src/' + n` no se sabe
      const todas = simples.map((der) => literalesDe(der));
      if (todas.every(Boolean)) return { literales: [...new Set(todas.flat())] };
    }
    // el primer parámetro de una función auxiliar (`function edit(p, pares)`, `def rep(p, pares):`): si cada llamada
    // le pasa una ruta literal, ésas son las rutas (y nada le asigna otra cosa)
    const fn = asignaciones === 0 && new RegExp(`(?:function|def)\\s+([A-Za-z_]\\w*)\\s*\\(\\s*${nombre}\\s*[,)]`).exec(script);
    if (fn) {
      const rutas = [];
      let todas = true;
      for (const c of script.matchAll(new RegExp(`(?<!(?:function|def)\\s+)\\b${fn[1]}\\s*\\(`, 'g'))) {
        const a = primerArgumento(script, c.index + c[0].length);
        const lits = literalesDe(a.arg);
        if (!lits) { todas = false; break; }
        rutas.push(...lits);
      }
      if (todas && rutas.length) return { literales: rutas };
    }
    // un bucle sobre una lista de rutas literales: `for p in ['a.yaml', 'b.md']` · `for (const p of ['a', 'b'])` (y el
    // bucle es la única asignación del nombre)
    const bucle = asignaciones === 1 && new RegExp(`for\\s*\\(?\\s*(?:const\\s+|let\\s+|var\\s+)?${nombre}\\s+(?:in|of)\\s+(\\[[^\\]]*\\])`).exec(script);
    if (bucle) {
      const lits = literalesDe(bucle[1]);
      if (lits) return { literales: lits };
    }
    // `const [a, b] = process.argv.slice(1)` · `a, b = sys.argv[1:]`
    const re = /(?:\[([\w$,\s]+)\]|(?:^|;)\s*([\w,\s]+?))\s*=\s*(?:process\.argv\.slice\((\d+)\)|sys\.argv\[(\d+):\])/gm;
    for (const d of script.matchAll(re)) {
      const nombres = String(d[1] || d[2]).split(',').map((x) => x.trim());
      const k = nombres.indexOf(expr);
      const desde = Number(d[3] || d[4]);
      if (k >= 0 && asignaciones === 1 && argv[desde + k - 1] != null) return { literal: argv[desde + k - 1] };
    }
    // por índice: `B, OUTF = sys.argv[1], sys.argv[2]` · `const f = process.argv[2]` (un nombre por índice, en orden).
    // Sólo si es la única asignación de ese nombre en el script: reasignado después, el destino ya no es el argumento
    const porIndice = /(?:^|[;\n]|\b(?:const|let|var)\s)[ \t]*([\w, \t]+?)[ \t]*=[ \t]*((?:(?:sys\.argv|process\.argv)\[\d+\][ \t]*(?:,[ \t]*)?)+)(?=$|[;\n])/gm;
    for (const d of script.matchAll(porIndice)) {
      const nombres = d[1].split(',').map((x) => x.trim()).filter(Boolean);
      const indices = [...d[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
      const k = nombres.indexOf(expr);
      if (k >= 0 && asignaciones === 1 && indices[k] != null && argv[indices[k] - 1] != null) return { literal: argv[indices[k] - 1] };
    }
  }
  // la cola es un literal (`dir + '/findings.json'`, `"'$R'/x.md"`): su extensión dice qué clase de archivo es
  const cola = String(expr).replace(/['"`\s)]+$/, '');
  const fin = /([^'"`+\s,(]*\.([A-Za-z0-9]+))$/.exec(cola);
  if (fin && /['"`]/.test(expr) && cola.length < String(expr).length) return { ext: `.${fin[2].toLowerCase()}`, cola: fin[1] };
  return {};
}

// la palabra de un heredoc: `EOF`, `'EOF'`, `"EOF"` o `\EOF` (la barra la cita, como las comillas), con `-` delante o no
const DELIMITADOR_DE_HEREDOC = /-?[ \t]*\\?(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\1(?=[\s;&|()<>]|$)/y;

// lo que deja un cuerpo de heredoc sacado, delante de su delimitador (ver `quitarCuerposDeHeredoc` en bash-gate-targets.js)
const MARCA_DE_CUERPO = '\u0000';

/**
 * Dónde termina la cuenta o la expansión que empieza en `i` (`((…))`, `$[…]` o `${…}`): el índice de su último carácter,
 * o -1 si no cierra en el renglón. Adentro, un `<<` es un corrimiento o parte de la palabra, nunca un heredoc: bash y
 * zsh corren lo de abajo aunque un renglón más abajo se llame como lo que sigue al `<<`.
 */
function finDeCuenta(linea, i) {
  const abre = linea[i + 1] === '(' ? '(' : linea[i + 1];
  const cierra = { '(': ')', '[': ']', '{': '}' }[abre];
  let profundidad = abre === '(' ? 2 : 1;
  for (let j = i + 2; j < linea.length; j++) {
    const c = linea[j];
    if (c === '\\') j++;
    else if (c === abre) profundidad++;
    else if (c === cierra) {
      profundidad -= 1;
      if (profundidad === 0) return j;
    }
  }
  return -1;
}
const empiezaCuenta = (linea, i) => (linea[i] === '(' && linea[i + 1] === '(') || (linea[i] === '$' && (linea[i + 1] === '[' || linea[i + 1] === '{'));

function sinBlancosAlBorde(linea) {
  let ini = 0;
  let fin = linea.length;
  while (ini < fin && (linea[ini] === ' ' || linea[ini] === '\t')) ini++;
  while (fin > ini && (linea[fin - 1] === ' ' || linea[fin - 1] === '\t')) fin--;
  return linea.slice(ini, fin);
}

/**
 * Cada heredoc que se cierra: `{ abre, desde, cierre, indice, operador }`. `abre` es el renglón que lo abre, su cuerpo va
 * de `desde` a `cierre` sin incluirlo, `indice` es su lugar entre los que abre ese renglón (varios en un renglón se leen
 * uno detrás del otro) y `operador`, `{ inicio, fin }` del `<<` con su palabra en el renglón. Va por renglones, con los
 * cierres en un índice: con muchas aperturas sin cierre, una expresión que busca el cierre desde cada una es cuadrática.
 */
/** `cierreTras(delimitador, n)`: el primer renglón después de `n` que es el delimitador (sin blancos al borde), o -1. */
function cierresDe(lineas) {
  const renglonesDe = new Map();
  lineas.forEach((linea, n) => {
    // el renglón que dejó un cuerpo ya sacado (`MARCA_DE_CUERPO` y su delimitador) también lo cierra
    const clave = linea[0] === MARCA_DE_CUERPO ? linea.slice(1) : sinBlancosAlBorde(linea);
    if (renglonesDe.has(clave)) renglonesDe.get(clave).push(n); else renglonesDe.set(clave, [n]);
  });
  return (delimitador, n) => {
    const renglones = renglonesDe.get(delimitador) || [];
    let bajo = 0;
    let alto = renglones.length;
    while (bajo < alto) {
      const medio = (bajo + alto) >> 1;
      if (renglones[medio] > n) alto = medio; else bajo = medio + 1;
    }
    return bajo < renglones.length ? renglones[bajo] : -1;
  };
}

// lo que se apaga adentro de un comentario: lo que abre o cierra algo para los lectores del freno (una comilla, un escape,
// una sustitución, un paréntesis, una llave, un heredoc)
const ABRE_O_CIERRA = /['"`\\$(){}<]/;
// las palabras después de las cuales viene otro comando: ahí un `case` o un `esac` es la palabra del shell
const SIGUE_UN_COMANDO = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!', 'time']);

// el valor de una asignación: cada pedazo se lee de una sola forma. Un `$` suelto no puede ir seguido de comilla, así
// `$'…'` es siempre una cadena y un `$''` repetido no abre caminos que crecen al doble por cada uno
const VALOR_DE_ASIGNACION = String.raw`(?:\$'(?:\\.|[^'\\])*'|'[^']*'|"(?:\\.|[^"\\])*"|\\.|\$(?!')|[^\s'"\\$])*`;
// los prefijos que no cambian qué comando corre
// `sudo` con sus opciones; las que llevan valor (`-u root`), con él
const PREFIJO = new RegExp(String.raw`^(?:\(\s*|[A-Za-z_]\w*=${VALOR_DE_ASIGNACION}\s+|sudo\s+(?:-[ugCDhprtTUR]\s+\S+\s+|-\S+\s+)*|command\s+|exec\s+|nice\s+(?:-n\s+\S+\s+)?|nohup\s+|env\s+(?:-\S+\s+)*(?:[A-Za-z_]\w*=${VALOR_DE_ASIGNACION}\s+)*|timeout\s+(?:-\S+\s+)*\S+\s+)+`);
// los parámetros de Remove-Item que llevan un valor que no es la ruta
const PS_CON_VALOR = /^-(?:filter|include|exclude|erroraction|ea|credential|stream|warningaction|wa|informationaction|ia)$/i;

// Cada redirección del tramo (`> x`, `2>> "y"`, `&>|z`), con los espacios y tabs que la preceden, cambiada por un
// blanco. Esos blancos se sacan a mano y no con un `[ \t]*` al principio de la expresión, que con una tirada larga de
// espacios la hace cuadrática.
const REDIRECCION_DE_SALIDA = /(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g;
function blancoPorRedireccion(t) {
  let out = '';
  let desde = 0;
  for (const m of t.matchAll(REDIRECCION_DE_SALIDA)) {
    let hasta = m.index;
    while (hasta > desde && (t[hasta - 1] === ' ' || t[hasta - 1] === '\t')) hasta--;
    out += `${t.slice(desde, hasta)} `;
    desde = m.index + m[0].length;
  }
  return out + t.slice(desde);
}

// ── los marcadores de la ejecución: se cierran con marker.js, no se borran ni se mueven a mano ─────────────────────────

// las formas de borrar o mover: un comando (también dentro de `bash -c`), una opción (`find -delete`, `rsync --delete`),
// un subcomando de git o la llamada de un guion. Sin ninguna, el comando no se lee de nuevo (es lo de cada comando)
// Los alias cortos de Windows (`del`, `erase`, `rd`, `ren`, `mi`, `ri`) son también palabras de un texto («la deuda del
// cliente»): cuentan sólo donde empieza un comando. Un `find -exec` con un programa que sólo lee no borra
const LECTORES_DE_FIND = String.raw`(?:wc|cat|head|tail|grep|egrep|fgrep|rg|ls|stat|file|echo|printf|du|basename|dirname|readlink|realpath|shasum|sha1sum|sha256sum|md5|md5sum|cksum|jq|diff|cmp|test)(?=[\s;'"]|$)`;
const BORRA_O_MUEVE = new RegExp([
  // el comando con su ruta (`/bin/rm`) o con la barra que saltea un alias (`\rm`) es el mismo comando
  String.raw`(?:^|[\s;&|(` + '`' + String.raw`'"])(?:[^\s;&|()'"` + '`' + String.raw`]*[\\/])?\\?(?:rm|rmdir|unlink|mv|move|remove-item|move-item|rename-item|rni|shred|trash|truncate)(?:\.exe)?(?=[\s;&|)` + '`' + String.raw`'"]|$)`,
  // los blancos después del separador no cruzan un salto de línea, que ya es otro separador: un `\s*` ahí hace cuadrática
  // la expresión con una tirada larga de renglones vacíos (sólo se pregunta si hay una coincidencia: es la misma)
  String.raw`(?:^|[;&|(` + '`' + String.raw`'"\n]|\bcmd(?:\.exe)?\s+/[ck])[^\S\n]*(?:[^\s;&|()'"` + '`' + String.raw`]*[\\/])?\\?(?:del|erase|rd|ren|mi|ri)(?:\.exe)?(?=[\s;&|)` + '`' + String.raw`'"]|$)`,
  String.raw`(?:^|\s)--?delete\b`,
  String.raw`(?:^|\s)-exec(?:dir)?\s+(?!` + LECTORES_DE_FIND + ')',
  // `git worktree move` ya casa por `move` suelto, en la primera forma (@story-8.318)
  String.raw`\bgit\b[^\n;&|]*\s(?:rm|clean|checkout|restore|mv|worktree\s+(?:remove|prune))\b`,
  String.raw`\b(?:unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir|renameSync|rename|rmtree|removedirs|remove|replace|move|delete|rm_rf|rm_r|remove_dir|remove_entry(?:_secure)?)\s*\(`,
  String.raw`\bunlink\b`,
].join('|'), 'i');

/** `a{b,c}d` → `abd`, `acd` (sin anidar; hasta 32 resultados). */
function expandirLlaves(w) {
  let out = [w];
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const sig = [];
    let cambio = false;
    for (const x of out) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(x);
      if (!m) { sig.push(x); continue; }
      cambio = true;
      for (const alt of m[1].split(',')) sig.push(x.slice(0, m.index) + alt + x.slice(m.index + m[0].length));
    }
    out = sig.slice(0, 32);
    if (!cambio) break;
  }
  return out;
}

// las opciones cuyo valor es un texto para leer: el título, la descripción o el cuerpo de un pedido, un mensaje
const OPCIONES_DE_TEXTO = new Set(['--title', '--description', '--body', '--comment', '--message', '-m', '--notes']);
// los programas cuyas opciones de texto son un mensaje (en otro programa, `-m` puede ser cualquier cosa)
const CON_MENSAJE = new Set(['git', 'gh', 'az', 'glab', 'hg', 'svn']);
// las opciones con las que un buscador ejecuta otro programa. git y ag aceptan la opción larga abreviada (`--open`) y
// la corta pegada a otras (`-iO`): cuenta cualquier comienzo de dos letras o más de uno de estos nombres
const OPCIONES_QUE_EJECUTAN = ['pre', 'pager', 'open-files-in-pager', 'hostname-bin'];
const BUSCADOR_EJECUTA = {
  test: (w) => {
    if (/^-[A-Za-z0-9]*O/.test(w)) return true;
    const nombre = /^--([^=]{2,})/.exec(w);
    return !!nombre && OPCIONES_QUE_EJECUTAN.some((o) => o.startsWith(nombre[1]) || nombre[1].startsWith(o));
  },
};
const BUSCADORES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
// la salida de un comando que la ejecuta otro: ahí lo citado puede terminar corriendo
const A_UN_SHELL = /\|&?\s*(?:(?:\/|[^\s-]\S*\/)?(?:sudo|env|busybox|command|exec|nohup|nice|time)(?:\s+-\S+)*\s+)*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|xargs|eval|source|python\d*(?:\.\d+)?|node|perl|ruby|php|pwsh|powershell)\b/;
const TOPE_DE_TUBERIAS = 500;
let enteroMirado = null;
let enteroVaAUnShell = false;

// Se pregunta una vez por tramo sobre el mismo comando, y la búsqueda arranca en cada `|`: se recuerda la última
// respuesta y, pasado el tope, se contesta que sí, que es lo que hace mirar de más: nada cuenta como citado.
function vaAUnShell(entero) {
  const texto = String(entero || '');
  if (texto === enteroMirado) return enteroVaAUnShell;
  let tuberias = 0;
  for (let i = texto.indexOf('|'); i >= 0 && tuberias <= TOPE_DE_TUBERIAS; i = texto.indexOf('|', i + 1)) tuberias++;
  enteroMirado = texto;
  enteroVaAUnShell = tuberias > TOPE_DE_TUBERIAS || A_UN_SHELL.test(texto);
  return enteroVaAUnShell;
}

/**
 * Los textos con blancos de un tramo que se citan y no se ejecutan: el patrón y los argumentos de un buscador (`grep`,
 * `rg` sin `--pre`…) y el valor de una opción de texto (`--description`, `--body`, `-m`…). Un texto con `$(` o comillas
 * invertidas no se cita: el shell lo corre antes. Con la salida del comando entero yendo a un shell, nada se cita.
 */
function textosCitados(tramo, entero) {
  const out = new Set();
  if (vaAUnShell(entero)) return out;
  const words = palabras(String(tramo).trim().replace(PREFIJO, '')).filter((w) => w !== '');
  const c = path.basename(words[0] || '').toLowerCase();
  const busca = (BUSCADORES.has(c) || (c === 'git' && words[1] === 'grep'))
    && !words.some((w) => BUSCADOR_EJECUTA.test(w));
  const mensaje = CON_MENSAJE.has(c);
  const citable = (w) => /\s/.test(w) && !/\$\(|`/.test(w);
  words.forEach((w, k) => {
    if (k > 0 && busca && citable(w)) out.add(w);
    if (mensaje && OPCIONES_DE_TEXTO.has(w) && words[k + 1] !== undefined && citable(words[k + 1])) out.add(words[k + 1]);
    const pegado = /^(--[a-z]+)=([\s\S]*)$/.exec(w);
    if (mensaje && pegado && OPCIONES_DE_TEXTO.has(pegado[1]) && citable(pegado[2])) out.add(pegado[2]);
  });
  return out;
}

/**
 * ¿El programa de un `perl -pi -e` es sólo sustituciones? Uno o más `s<d>…<d>…<d><indicadores>` separados por `;`, con
 * un delimitador que no abre ni cierra (`/ # | ! , : ~`) y los indicadores `g i m s x`, sin `$`, `@`, llaves, comillas
 * invertidas ni salto de renglón, y sin una barra seguida de una cifra en el reemplazo (perl lee `\1` como `$1`, y
 * `\1[…]` calcula su índice): perl no tiene ahí nada que leer como una variable ni que correr como código. Lo que no se
 * sabe leer cuenta como que no.
 */
function programaDePerlSoloSustituye(programa) {
  const s = String(programa);
  if (/[$@{}`\n\r]/.test(s)) return false;
  // hasta el delimitador sin escapar; -1 si no cierra
  const hasta = (d, j) => { for (; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === d) return j; } return -1; };
  let i = 0;
  let sustituciones = 0;
  while (i < s.length) {
    while (/[\s;]/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    if (s[i] !== 's' || !/[/#|!,:~]/.test(s[i + 1] || '')) return false;
    const d = s[i + 1];
    const medio = hasta(d, i + 2);
    if (medio < 0) return false;
    const fin = hasta(d, medio + 1);
    if (fin < 0 || /\\\d/.test(s.slice(medio + 1, fin))) return false;
    i = fin + 1;
    while (/[gimsx]/.test(s[i] || '')) i++;
    if (i < s.length && !/[\s;]/.test(s[i])) return false;
    sustituciones++;
  }
  return sustituciones > 0;
}

/**
 * Los pedazos de un tramo donde puede empezar un comando: corta en `&`, `(`, `)` y en `{` o `}` sueltos, fuera de las
 * comillas. Un `$(…)` y unas comillas invertidas quedan enteros en su pedazo: son parte de una palabra.
 */
function piezasDeTramo(tramo) {
  const s = String(tramo);
  const out = [];
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { actual += s.slice(i, i + 2); i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const fin = c === '"' ? cierreDoble(s, i) : s.indexOf(c, i + 1);
      const hasta = fin < 0 ? s.length : fin + 1;
      actual += s.slice(i, hasta);
      i = hasta - 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let prof = 0;
      let j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '(') prof++; else if (s[j] === ')' && --prof === 0) break; }
      actual += s.slice(i, j + 1);
      i = j;
      continue;
    }
    const llaveSuelta = (c === '{' || c === '}') && /^$|\s$/.test(actual.slice(-1)) && /^$|\s/.test(s[i + 1] || '');
    if (c === '&' || c === '(' || c === ')' || llaveSuelta) { out.push(actual); actual = ''; continue; }
    actual += c;
  }
  out.push(actual);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** El índice de las comillas dobles que cierran las que abren en `i` (con sus escapes), o -1. */
function cierreDoble(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j;
  }
  return -1;
}

/**
 * La carpeta de un `cd`, leída de lo que sigue al `cd` como la lee el shell: `{ texto, valor, comodin }`. `valor` es la
 * carpeta sin comillas ni escapes y con sus variables, `'~'` si no hay carpeta, o null si el freno no la sabe resolver:
 * `$(…)`, comillas invertidas, `$'…'`, llaves, `~+`, `cd -` o una variable que no conoce. `comodin` dice si el shell la
 * expande (`*`, `?`, `[…]` fuera de las comillas).
 */
function carpetaDeCd(cmd, resto) {
  let s = String(resto).replace(/^\s+/, '');
  // las opciones del cd (`-P`, `-L`, `-e`, `-@`) y el `--` que las cierra
  for (let m; (m = /^(-[A-Za-z@]+|--)(?=\s|$)\s*/.exec(s));) { s = s.slice(m[0].length); if (m[1] === '--') break; }
  let texto = '';
  let valor = '';
  let dinamico = false;
  let desconocido = false;
  let comodin = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/[\s<>]/.test(c)) break;
    if (c === '\\') { texto += s.slice(i, i + 2); valor += s[i + 1] || ''; i++; continue; }
    if (c === "'") {
      const fin = s.indexOf("'", i + 1);
      const hasta = fin < 0 ? s.length : fin;
      if (s[i - 1] === '$') desconocido = true;
      texto += s.slice(i, hasta + 1);
      valor += s.slice(i + 1, hasta);
      i = hasta;
      continue;
    }
    if (c === '"') {
      const fin = cierreDoble(s, i);
      const hasta = fin < 0 ? s.length : fin;
      const dentro = s.slice(i + 1, hasta);
      if (/\$\(|`/.test(dentro)) desconocido = true;
      if (/\$/.test(dentro)) dinamico = true;
      texto += s.slice(i, hasta + 1);
      valor += dentro.replace(/\\(["\\$`])/g, '$1');
      i = hasta;
      continue;
    }
    if (c === '`' || (c === '$' && s[i + 1] === '(') || c === '{' || c === '}') desconocido = true;
    if (c === '$') dinamico = true;
    if (/[*?[]/.test(c)) comodin = true;
    texto += c;
    valor += c;
  }
  if (!texto) return { texto, valor: '~', comodin: false };
  // `~+`, `~-` y `~otro` (la carpeta de otro usuario) no se resuelven acá
  if (desconocido || texto === '-' || /^~[^/]/.test(texto)) return { texto, valor: null, comodin };
  // con `CDPATH` (en el ambiente o en el comando) un `cd` relativo puede caer en cualquiera de sus carpetas
  const relativo = !/^(?:\/|\.{1,2}(?:\/|$)|~|\$)/.test(valor);
  if (relativo && (process.env.CDPATH || /(?:^|[\s;&|(])(?:export\s+)?CDPATH(?==)/.test(String(cmd)))) return { texto, valor: null, comodin };
  if (dinamico) {
    const ex = expandirRuta(cmd, valor);
    if (ex.sinResolver.length) return { texto, valor: null, comodin };
    valor = ex.valor;
  }
  return { texto, valor, comodin };
}

/**
 * Los `.md` de la carpeta de un `cd`, a cualquier profundidad, sin las carpetas de `NEVER_CODE_SEGMENTS` ni `.git`:
 * `{ mds, incompleta }`. `incompleta` dice por qué la recorrida no llegó a todo (más de 500 `.md`, más de 2000
 * carpetas, una carpeta que no se pudo leer), o es '' si la recorrió entera.
 */
function recorrerCarpetaDeCd(dir) {
  const mds = [];
  const pendientes = [dir];
  const vistas = new Set();
  try { vistas.add(fs.realpathSync(dir)); } catch { vistas.add(dir); }
  let carpetas = 0;
  while (pendientes.length) {
    const d = pendientes.pop();
    if (++carpetas > 2000) return { mds, incompleta: 'más de 2000 carpetas: no la recorro entera' };
    let entradas = [];
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { logHookError(e); return { mds, incompleta: `no pude leer ${d}` }; }
    for (const e of entradas) {
      // un enlace simbólico se sigue: cuenta lo que nombra (una vez cada carpeta real, por si el enlace da la vuelta)
      let esDir = e.isDirectory();
      let esArchivo = e.isFile();
      if (e.isSymbolicLink()) {
        try { const st = fs.statSync(path.join(d, e.name)); esDir = st.isDirectory(); esArchivo = st.isFile(); } catch { /* roto */ }
      }
      if (esDir && !NEVER_CODE_SEGMENTS.has(e.name) && e.name !== '.git') {
        let real = path.join(d, e.name);
        try { real = fs.realpathSync(real); } catch { /* queda la ruta */ }
        if (!vistas.has(real)) { vistas.add(real); pendientes.push(path.join(d, e.name)); }
      } else if (esArchivo && /\.md$/i.test(e.name)) {
        if (mds.length >= 500) return { mds, incompleta: 'más de 500 .md: no la recorro entera' };
        mds.push(path.join(d, e.name));
      }
    }
  }
  return { mds, incompleta: '' };
}

// Un shell con `-c` y su guion entre comillas (sólo importa dónde termina cada coincidencia). La carpeta de delante del
// shell no cruza un separador: un `\S*` ahí hace cuadrática la expresión con una tirada larga de `;`, y donde termina
// cada coincidencia es el mismo.
const SHELL_CON_C = /(?:^|[\s;&|(`])(?:[^\s;&|(`]*\/)?(?:ba|z|k|da|fi|c|tc)?sh\b(?:\s+(?:--?[A-Za-z][\w-]*|[+-][oO]\s+(?:[^\s+-]|\+(?![oO](?:\s|$))|-(?![-A-Za-z])|--(?![A-Za-z]))\S*|\+[oO](?=\s)))*?\s+-[A-Za-z]*c\s+(?=['"])/g;

/**
 * Lo que corre adentro de un comando, un nivel: el cuerpo de cada `$(…)` (con sus paréntesis balanceados) y de cada
 * par de comillas invertidas, fuera de las comillas simples; el guion de un shell con `-c` (con cualquier opción
 * antes); y lo que corre `eval`.
 */
function guionesInternos(cmd) {
  const s = String(cmd || '');
  const out = [];
  // las comillas en las que está cada carácter: entre simples no corre nada; entre dobles, `$(…)` y `…` sí
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '"') { q = q ? null : '"'; continue; }
    if (c === "'" && !q) { q = "'"; continue; }
    if (c === '$' && s[i + 1] === '(') {
      let prof = 0;
      let j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '(') prof++; else if (s[j] === ')' && --prof === 0) break; }
      out.push(s.slice(i + 2, j));
      i = j;
    } else if (c === '`') {
      const fin = s.indexOf('`', i + 1);
      out.push(s.slice(i + 1, fin < 0 ? s.length : fin));
      i = fin < 0 ? s.length : fin;
    }
  }
  for (const m of s.matchAll(SHELL_CON_C)) {
    const i = m.index + m[0].length;
    const fin = s[i] === '"' ? cierreDoble(s, i) : s.indexOf("'", i + 1);
    const cuerpo = s.slice(i + 1, fin < 0 ? s.length : fin);
    out.push(s[i] === '"' ? cuerpo.replace(/\\(["\\$`])/g, '$1') : cuerpo);
  }
  // `eval` corre sus palabras juntas, hasta el primer `;`, `&`, `|` o salto de línea fuera de las comillas
  for (const m of s.matchAll(/(?:^|[\s;&|(`])eval\s+/g)) {
    let j = m.index + m[0].length;
    for (let qq = null; j < s.length; j++) {
      const c = s[j];
      if (qq) { if (c === qq) qq = null; else if (c === '\\' && qq === '"') j++; continue; }
      if (c === '\\') { j++; continue; }
      if (c === "'" || c === '"') { qq = c; continue; }
      if (/[;&|\n]/.test(c)) break;
    }
    out.push(palabras(s.slice(m.index + m[0].length, j)).join(' '));
  }
  return out;
}

// los niveles de `$(…)`, comillas invertidas y `sh -c` que se leen como otro comando; lo de más adentro no se lee
const TOPE_ANIDADOS = 4;

/**
 * Un `--out` que cae en la carpeta de la revisión del plan desde un comando que no es el corredor del pase del arnés:
 * `node <workflow-lite.js del arnés> <adversarial-verify.workflow.js del arnés> … --out <ruta>`, con las dos rutas
 * resueltas contra el arnés instalado. Devuelve la ruta del `--out` que no vale, o null. Otro guion con `--out` ahí, o el
 * corredor con otro workflow, escribiría un resultado que la revisión tomaría por el del pase.
 */
/**
 * Los corredores del pase que eligió la organización, como los escribe el arnés en `--runners`: `{ lista, motivo }`.
 * Si no se pueden leer, `lista` es null (el corredor con `--runners` se frena) y `motivo` dice por qué, también por la
 * salida de errores. `leer` reemplaza la lectura de la configuración (las pruebas).
 */
function corredoresDeLaOrganizacion({ leer } = {}) {
  try {
    const raw = leer ? leer() : require('./plan-review.js').configDeLaOrganizacion().raw;
    const orden = require('./review-runner.js').runnerOrder(raw).order;
    return { lista: Array.isArray(orden) ? orden.join(',') : null, motivo: null };
  } catch (e) {
    const motivo = `no pude leer la lista de corredores de la organización (${(e && e.message) || e}): el corredor con --runners se frena`;
    process.stderr.write(`[on-bash-write-gate] ${motivo}\n`);
    return { lista: null, motivo };
  }
}

/** La palabra sin las comillas que la rodean, si las tiene (`'w h.md'` → `w h.md`). */
function sinComillasDeLosBordes(w) {
  const m = /^(['"])([\s\S]*)\1$/.exec(String(w));
  return m ? m[2] : String(w);
}

// el archivo de un `w` o `W` de un guion de `sed`, también con una dirección delante (`1w`, `/a/w`) o como indicador de
// una sustitución (`s/a/b/w`): hasta el fin del renglón en un guion, y hasta un espacio o una comilla en el texto de un
// comando, donde el guion puede venir citado o escapado (`printf 'w h.md\n' > x.sed`, `printf 'w\th.md'`)
const SED_W_EN_GUION = /(?:^|[;{}\s\d$/!])[wW][ \t]+([^\n]+)/g;
const SED_W_EN_COMANDO = /(?:^|[;{}\s\d$/!'"]|\\[nt])[wW](?:[ \t]|\\t)+([^\s'"\\;&|<>`]+)/g;

// Un programa de `node -e` que no puede correr otro proceso: cada `require` es de un módulo propio de node que no corre
// nada, y no hay otra forma de llegar a uno (`import`, `process.binding`, `module`, `Function`, `eval`, `constructor`…).
// Un módulo propio no se puede reemplazar con un archivo de la carpeta, como sí un `json.py` en python
const MODULOS_QUE_NO_CORREN = String.raw`(?:node:)?(?:fs|fs\/promises|path|os|util|assert|url|crypto|zlib|readline|events|buffer|string_decoder|querystring)`;
const REQUIRE_QUE_NO_CORRE = new RegExp(String.raw`\brequire\s*\(\s*(['"])${MODULOS_QUE_NO_CORREN}\1\s*\)`, 'g');
const PROGRAMA_LLEGA_A_PROCESOS = /\bimport\b|\bprocess\s*(?:\.\s*(?:binding|_linkedBinding|dlopen|mainModule|execve|getBuiltinModule|kill|send|channel)|\[)|\bmodule\b|\bexports\b|\bFunction\b|\beval\b|\bvm\b|\bglobalThis\b|\bglobal\b|\bReflect\b|\bWorker\b|\bWebAssembly\b|child_process|\bconstructor\b|__proto__|\bprototype\b|\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/;
// lo que, fuera del programa, puede estar en el comando sin correr nada que el programa haya dejado escrito o impreso
const COMANDOS_QUE_NO_CORREN = new Set(['cd', 'pushd', 'popd', 'echo', 'printf', 'true', 'false', 'test', '[', 'cat', 'head',
  'tail', 'wc', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'jq', 'stat', 'pwd', 'date',
  'mkdir', 'touch']);

/**
 * Los programas de `node -e '…'` del comando cuyo texto no puede correr como comandos del shell: el programa no llega a
 * otro proceso (`REQUIRE_QUE_NO_CORRE`, `PROGRAMA_LLEGA_A_PROCESOS`), su salida no va a ningún lado (sin tubería ni
 * redirección), node no lleva otras opciones, y el resto del comando sólo lee o muestra (`COMANDOS_QUE_NO_CORREN`, o un
 * `bash -n`/`sh -n` que sólo revisa la sintaxis): nada corre lo que el programa imprime o deja escrito. Con cualquier
 * otra cosa (otro intérprete, un `$(…)`, un heredoc, una variable antes de node, un shell que corre) el conjunto queda
 * vacío y el texto se lee como siempre. Cada programa tal cual lo deja el shell y con los escapes de las comillas
 * dobles, como lo puede dejar `palabras`.
 */
function programasSinProcesos(cmd) {
  const out = new Set();
  let r;
  try { r = require('./marker-command.js').tramos(String(cmd || ''), 'bash'); } catch (e) { logHookError(e); return out; }
  if (!r || r.abierta || r.conParentesis || r.subs.length) return out;
  const programas = [];
  for (const t of r.tramos) {
    if (t.heredocs.length || t.tras === '|') return new Set();
    const w = t.palabras.map((p) => p.texto);
    if (['node', 'nodejs'].includes(w[0]) && ['-e', '--eval', '-p', '--print'].includes(w[1]) && w.length >= 3) {
      const programa = w[2];
      const requires = (programa.match(/\brequire\b/g) || []).length;
      if (requires !== (programa.match(REQUIRE_QUE_NO_CORRE) || []).length || PROGRAMA_LLEGA_A_PROCESOS.test(programa)) return new Set();
      if (w.slice(3).some((x) => x.startsWith('-') || /[<>]/.test(x))) return new Set();
      programas.push(programa);
      continue;
    }
    if (w.some((x) => /[<>]/.test(x))) return new Set();
    if (w.every((x) => /^[A-Za-z_]\w*=/.test(x))) continue;
    if (COMANDOS_QUE_NO_CORREN.has(w[0])) continue;
    if (['bash', 'sh', 'zsh', 'dash'].includes(w[0]) && w.length === 3 && w[1] === '-n') continue;
    return new Set();
  }
  for (const p of programas) { out.add(p); out.add(p.replace(/(["\\$`])/g, '\\$1')); }
  return out;
}

/**
 * ¿El guion de `sed` sólo cambia el texto que lee? Sin `r`, `R`, `w`, `W`, `e` ni `F` (leen, escriben o corren algo
 * aparte) y sin los indicadores `w` o `e` de un `s`. Lo que no se sabe leer cuenta como que no.
 */
function guionDeSedSinEfectos(guion) {
  const s = String(guion);
  let i = 0;
  // hasta el delimitador sin escapar (`\/` no corta); -1 si no cierra
  const hasta = (d, j) => { for (; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === d) return j; } return -1; };
  const direccion = () => {
    if (/\d/.test(s[i] || '')) { while (/[\d~]/.test(s[i] || '')) i++; return true; }
    if (s[i] === '$') { i++; return true; }
    if (s[i] === '/' || s[i] === '\\') {
      const d = s[i] === '\\' ? s[++i] : '/';
      const fin = hasta(d, i + 1);
      if (fin < 0) return false;
      i = fin + 1;
      while (/[IM]/.test(s[i] || '')) i++;
    }
    return true;
  };
  while (i < s.length) {
    while (/[\s;{}]/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    if (!direccion()) return false;
    if (s[i] === ',') { i++; if (!direccion()) return false; }
    while (/[\s!]/.test(s[i] || '')) i++;
    const c = s[i++];
    if (c === undefined) return false;
    if (c === '}' || c === '{') continue;
    if (c === 's' || c === 'y') {
      const d = s[i];
      if (!d || /[\s\\\n]/.test(d)) return false;
      const medio = hasta(d, i + 1);
      const fin = medio < 0 ? -1 : hasta(d, medio + 1);
      if (fin < 0) return false;
      i = fin + 1;
      const flags = /^[gGiIpmM\d]*/.exec(s.slice(i))[0];
      i += flags.length;
      if (!/^(?:$|[\s;}])/.test(s.slice(i))) return false;
      continue;
    }
    if ('dDpPnNgGhHxlz='.includes(c)) continue;
    if (c === 'q' || c === 'Q') { while (/\d/.test(s[i] || '')) i++; continue; }
    // el texto de `a`, `i` y `c` llega hasta el fin de la línea o del guion; la etiqueta de `b`, `t`, `T` y `:`, hasta el
    // primer espacio o `;`, como la corta el `sed` de GNU: lo que sigue es otro comando (`t x e` corre `e`)
    if ('aic'.includes(c)) { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl + 1; continue; }
    if ('btT:'.includes(c)) { while (/[ \t]/.test(s[i] || '')) i++; while (i < s.length && !/[\s;]/.test(s[i])) i++; continue; }
    return false;
  }
  return true;
}


module.exports = { RAIZ_DEL_ARNES, dentroDelArnes, archivoQueNoCompila, esPiezaDelArnes, archivoQueNoEsElInstalado, nativePath, Q, tok, SEPARADOR_DE_SEGMENTOS, splitSegments, sinPalabrasDeBloque, PALABRA_DE_REDIRECCION, DESCRIPTOR, REDIRECCION_DE_SALIDA_CON_PALABRA, REDIRECCION_DE_ENTRADA_CON_PALABRA, sinCerrar, palabrasDelComando, ultimosArgumentos, REDIRECCION_DELANTE, sinRedireccionesDelante, CON_PALABRA_PROPIA, EMPIEZA_REDIRECCION, antesDeUnaRedireccion, finDeSustitucion, nombresDelPrograma, ESCRIBE_LO_QUE_NOMBRA, MODIFICADORES_DE_ZSH, sinSustitucionesCerradas, COPIA, leadingCd, SUBCOMANDO_EN_DESTINO, DESTINO_CON_SUBCOMANDO, posicionesDeComando, subcomandosComoComodin, HONDO_DE_ENV_S, RSYNC_ESCRIBE, archivosDeRsync, cierreDeParentesis, sufijoVacioDe, destinosDelSedEnSitio, INTERPRETES, DESTINO_LITERAL, palabras, argumentosDe, ENTRADAS_LEIDAS, programasPorEntrada, leerProgramasPorEntrada, CORRE_ARCHIVO, GUION_TOPE, GUION_TOPE_DURO, RECORRIDO_NIVELES, RECORRIDO_ARCHIVOS, RECORRIDO_BYTES, ESCANEO_REINTENTO_MS, CORCHETE_TOPE, CLASES_POSIX, MENCIONA_HISTORIA, repoConHistorias, EXTENSION_DE, familiaDe, INTERPRETE_DE, palabraExpandida, SOLO_VARIABLE, ANTES_DEL_PROGRAMA, noSeLeeElPrograma, sinGrupo, rutaRealDelGuion, importsLocales, versionadoEnElArbolPropio, versionadoSinMemo, igualAMainDelArbolPropio, isInsideReal, primerArgumento, MODO_SOLO_LEE, ARGUMENTO_CON_NOMBRE, ARGUMENTOS_DE_LECTURA, argumentosDeLlamada, archivoQueAbre, OPEN_LLAMADA, sinEscapesDeComillas, literalesDe, vecesAsignado, leerArmado, DELIMITADOR_DE_HEREDOC, MARCA_DE_CUERPO, finDeCuenta, empiezaCuenta, sinBlancosAlBorde, cierresDe, ABRE_O_CIERRA, SIGUE_UN_COMANDO, VALOR_DE_ASIGNACION, PREFIJO, PS_CON_VALOR, REDIRECCION_DE_SALIDA, blancoPorRedireccion, LECTORES_DE_FIND, BORRA_O_MUEVE, expandirLlaves, OPCIONES_DE_TEXTO, CON_MENSAJE, OPCIONES_QUE_EJECUTAN, BUSCADOR_EJECUTA, BUSCADORES, A_UN_SHELL, TOPE_DE_TUBERIAS, vaAUnShell, textosCitados, programaDePerlSoloSustituye, piezasDeTramo, cierreDoble, carpetaDeCd, recorrerCarpetaDeCd, SHELL_CON_C, guionesInternos, TOPE_ANIDADOS, corredoresDeLaOrganizacion, sinComillasDeLosBordes, SED_W_EN_GUION, SED_W_EN_COMANDO, MODULOS_QUE_NO_CORREN, REQUIRE_QUE_NO_CORRE, PROGRAMA_LLEGA_A_PROCESOS, COMANDOS_QUE_NO_CORREN, programasSinProcesos, guionDeSedSinEfectos };
