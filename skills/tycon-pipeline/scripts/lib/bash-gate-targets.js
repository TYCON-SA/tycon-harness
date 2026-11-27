'use strict';
/**
 * bash-gate-targets.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: los destinos: dónde escribe o arma un comando, los heredocs, los guiones en línea y los comentarios que no corren.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
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
const { ABRE_O_CIERRA, CON_PALABRA_PROPIA, COPIA, DELIMITADOR_DE_HEREDOC, MARCA_DE_CUERPO, DESTINO_LITERAL, EMPIEZA_REDIRECCION, ESCRIBE_LO_QUE_NOMBRA, HONDO_DE_ENV_S, INTERPRETES, MODIFICADORES_DE_ZSH, PREFIJO, Q, SIGUE_UN_COMANDO, antesDeUnaRedireccion, archivoQueAbre, archivosDeRsync, argumentosDe, carpetaDeCd, cierreDeParentesis, cierresDe, corredoresDeLaOrganizacion, destinosDelSedEnSitio, empiezaCuenta, finDeCuenta, finDeSustitucion, guionDeSedSinEfectos, guionesInternos, leerArmado, nombresDelPrograma, palabras, palabrasDelComando, piezasDeTramo, primerArgumento, programasPorEntrada, sinEscapesDeComillas, sinBlancosAlBorde, sinPalabrasDeBloque, sinRedireccionesDelante, sinSustitucionesCerradas, splitSegments, textosCitados, tok, ultimosArgumentos } = require('./bash-gate-words.js');
const { TOPE_DE_CARPETAS_DE_CD, abreParaEscribir, cpMvDest, destinosDeCpMv, nombreDeComando, opcionesDelEnvoltorio, palabraConAnsi, palabraDelShell, palabrasEnteras, partidorComun, pelarEnv, resolveTarget, sinPalabrasDelShell } = require('./bash-gate-expansions.js');

/**
 * El tramo desde el programa que corre, con el programa por su nombre (`/bin/cp` y `\cp` son `cp`): sin las variables de
 * delante, las redirecciones (`HOLA=1 >f cp`) ni los envoltorios que corren otro comando (`env -i X=1`, `command`,
 * `nohup`, `sudo -u x`, `timeout 5`, `busybox`), con sus opciones. '' si no queda programa.
 */
function desdeElPrograma(seg) {
  const t = String(seg).trim();
  const pieza = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g;
  const fines = [];
  function* piezas() { for (let m = pieza.exec(t); m; m = pieza.exec(t)) { fines.push(m.index + m[0].length); yield m[0]; } }
  const p = programaEntre(piezas());
  return p ? p.n + t.slice(fines[p.k]) : '';
}

/**
 * El programa que corre entre las palabras crudas de un tramo, en orden: `{ k, n }`, su lugar entre ellas y su nombre
 * (`/bin/cp` y `\cp` son `cp`), sin las variables de delante, las redirecciones ni los envoltorios con sus opciones. null
 * si no queda programa.
 */
function programaEntre(piezas, info = null) {
  // las opciones del envoltorio que se está leyendo (null fuera de uno), las palabras que siguen y no son el programa (el
  // valor de una opción), y si al terminar sus opciones le sigue una palabra suya
  let opciones = null;
  let saltar = 0;
  let propia = false;
  let envoltorio = null;
  let k = -1;
  for (const pieza of piezas) {
    k++;
    if (saltar) { saltar--; continue; }
    // una redirección no es el programa; si su palabra va aparte (`> f`), tampoco la que sigue
    const redireccion = EMPIEZA_REDIRECCION.exec(pieza);
    if (redireccion) { if (redireccion[0].length === pieza.length) saltar = 1; continue; }
    // una redirección pegada detrás (`cp>/dev/null`, `X=1>f`) termina la palabra: cuenta lo de antes
    const crudo = pieza.slice(0, antesDeUnaRedireccion(pieza));
    const w = palabraConAnsi(crudo);
    if (opciones !== null && w.startsWith('-')) {
      // el texto de `env -S`, que quien llama lee como otro comando: en qué pieza está y lo que va pegado
      const s = envoltorio === 'env' && /^(?:-[i0v]*S|--split-string=?)([\s\S]*)$/.exec(w);
      if (s && info) info.envS = { k, pegado: s[1] };
      // también con las opciones juntas (`-iu root`), si la primera que lleva valor es la última; antes, el resto de la
      // palabra es su valor (`-uroot`, `-uP`) y el programa es la palabra que sigue
      const juntas = /^-[A-Za-z]{2,}$/.test(w) && opciones && [...w.slice(1)].findIndex((l) => opciones.test(`-${l}`)) === w.length - 2;
      if (opciones && (opciones.test(w) || juntas)) saltar = 1;
      continue;
    }
    if (opciones !== null && propia) { opciones = null; propia = false; continue; }
    opciones = null;
    if (/^[A-Za-z_]\w*=/.test(crudo)) continue;
    // si la palabra puede nombrar dos programas, cuenta el que escribe; si no, un envoltorio; si no, el de siempre. Una
    // sustitución pegada al nombre (`nohup$(:/ )`) puede no dar nada: el nombre sin ella también vale
    const nombres = nombresDelPrograma(w);
    const todos = [...nombres, ...nombres.map(sinSustitucionesCerradas)];
    const n = todos.find((x) => ESCRIBE_LO_QUE_NOMBRA.test(x)) || todos.find((x) => x === 'busybox' || ENVOLTORIOS.has(x) || MODIFICADORES_DE_ZSH.has(x)) || nombres[0];
    if (n === 'busybox' || MODIFICADORES_DE_ZSH.has(n)) continue;
    if (ENVOLTORIOS.has(n)) { opciones = opcionesDelEnvoltorio(n) || false; propia = CON_PALABRA_PROPIA.has(n); envoltorio = n; continue; }
    return { k, n };
  }
  return null;
}

/**
 * Limpia del comando lo que NO es comando (sus comentarios, apagados con `conComentariosApagados`):
 *  - los CUERPOS de los heredocs (el mensaje de commit HEREDOC del equipo, un .md escrito por heredoc que
 *    cita `> src/x.ts` o `a.ts -> b.ts`) — se conserva la línea de apertura (`cat > f <<EOF`), que es donde
 *    está el target real;
 *  - los strings entre comillas que NO son el token inmediato tras `>`/`>>`/`tee` (`-m "..."`, `-e "..."`,
 *    `grep "sed -i"`), para que su contenido no se lea como redirecciones ni como archivos.
 */
function stripNonCommandText(s, hondo = 0) {
  // Heredocs: <<EOF / <<-EOF / <<'EOF' / <<"EOF" … hasta la línea que es sólo el delimitador, con el mismo lector que
  // los tramos (`quitarCuerposDeHeredoc`): un `<<EOF` adentro de un comentario no abre nada, y lo de abajo corre. Después,
  // los comentarios: una comilla adentro de uno no abre un texto entre comillas que se vacía con lo de abajo. Un carácter
  // nulo no llega al shell, y sale antes de marcar los cuerpos sacados (las marcas se borran al final)
  const sinNulos = String(s || '').split(MARCA_DE_CUERPO).join('');
  const t = conComentariosApagados(quitarCuerposDeHeredoc(sinNulos, true));
  return vaciarCitados(t, hondo).replace(RENGLON_DE_MARCA, '');
}

// cómo se borra el renglón que deja un cuerpo de heredoc sacado (`MARCA_DE_CUERPO`, de bash-gate-words.js)
const RENGLON_DE_MARCA = /\u0000[^\n]*/g;

// cuántas sustituciones adentro de otras se leen como comandos: más hondo, quedan las otras lecturas
const HONDO_DE_CITADOS = 4;
// cuántas sustituciones una adentro de otra sigue el cierre antes de darla por abierta (la pila tiene un fondo)
const HONDO_DE_CIERRE = 200;

/**
 * Si en `t[i]` empieza una sustitución (`$(…)` o la comilla invertida), dónde termina: el índice de su último carácter,
 * -1 si no cierra, o `i` si ahí no empieza ninguna. Cuenta los paréntesis que se abren adentro y salta lo citado: un `)`
 * entre comillas (`$(grep -c ')' f)`) no la cierra. Salta también el cuerpo de sus heredocs: un apóstrofo en el mensaje
 * de `git commit -m "$(cat <<'EOF' … EOF)"` no es una comilla. Más de `HONDO_DE_CIERRE` sustituciones una adentro de otra
 * se toman como sin cierre: el resto se lee como está.
 */
function cierreDeUnaSustitucion(t, i, prof = 0) {
  if (t[i] === '`') return t.indexOf('`', i + 1);
  if (t[i] !== '$' || t[i + 1] !== '(') return i;
  if (prof >= HONDO_DE_CIERRE) return -1;
  // en una cuenta (`$((1 << 2))`) un `<<` no abre un heredoc
  const cuenta = t[i + 2] === '(';
  let hondo = 0;
  // los heredocs abiertos en el renglón: su cuerpo empieza en el renglón siguiente
  const pendientes = [];
  for (let j = i + 1; j < t.length; j++) {
    const c = t[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n' && pendientes.length) {
      const fin = finDeCuerpos(t, j + 1, pendientes.splice(0));
      if (fin < 0) return -1;
      j = fin - 1;
      continue;
    }
    if (c === '<' && t[j + 1] === '<' && !cuenta) {
      if (t[j + 2] === '<') { j += 2; continue; }
      const h = delimitadorDeHeredoc(t, j + 2);
      if (h) { pendientes.push(h); j = h.fin - 1; continue; }
    }
    if (c === '$' && t[j + 1] === '(') {
      const f = cierreDeUnaSustitucion(t, j, prof + 1);
      if (f === -1) return -1;
      j = f;
      continue;
    }
    if (c === "'") {
      // `$'…'`: la barra escapa
      if (t[j - 1] === '$') { j++; while (j < t.length && t[j] !== "'") j += t[j] === '\\' ? 2 : 1; } else j = t.indexOf("'", j + 1);
      if (j < 0 || j >= t.length) return -1;
      continue;
    }
    if (c === '"') {
      for (j++; j < t.length && t[j] !== '"'; j++) {
        if (t[j] === '\\') { j++; continue; }
        const f = cierreDeUnaSustitucion(t, j, prof + 1);
        if (f === -1) return -1;
        j = f;
      }
      if (j >= t.length) return -1;
      continue;
    }
    if (c === '`') { j = t.indexOf('`', j + 1); if (j < 0) return -1; continue; }
    if (c === '(') hondo++;
    else if (c === ')' && --hondo === 0) return j;
  }
  return -1;
}

/**
 * El delimitador del heredoc cuya palabra empieza en `t[k]` (justo después de `<<`): `{ delim, dash, fin }`, con `fin`
 * donde termina la palabra, o null si no hay una. La palabra se lee con la misma expresión que `delimitadoresQueAbre`:
 * los heredocs que salta el cierre son los mismos cuyos cuerpos saca `quitarCuerposDeHeredoc`.
 */
function delimitadorDeHeredoc(t, k) {
  DELIMITADOR_DE_HEREDOC.lastIndex = k;
  const m = DELIMITADOR_DE_HEREDOC.exec(t);
  return m ? { delim: m[2], dash: m[0].startsWith('-'), fin: DELIMITADOR_DE_HEREDOC.lastIndex } : null;
}

/** Dónde sigue `t` después de los cuerpos de los heredocs `abiertos`, uno detrás del otro desde `pos`; -1 si alguno no cierra. */
function finDeCuerpos(t, pos, abiertos) {
  for (const h of abiertos) {
    for (;;) {
      const e = t.indexOf('\n', pos);
      const linea = t.slice(pos, e < 0 ? t.length : e);
      pos = e < 0 ? t.length : e + 1;
      // el cuerpo ya sacado deja su marca; si no, el cuerpo sigue ahí, hasta su delimitador
      if (linea === MARCA_DE_CUERPO + h.delim || (h.dash ? linea.replace(/^\t+/, '') : linea) === h.delim) break;
      if (e < 0) return -1;
    }
  }
  return pos;
}

/**
 * `t` con sus textos entre comillas vaciados (quedan las comillas), para que su contenido no se lea como redirecciones
 * ni como archivos. No se vacían los que pueden ser un nombre de archivo (sin blancos ni operadores: `cp a "<dir>/b.md"`
 * sigue nombrando su destino), los que siguen a un `>` o a `tee`, ni los pegados a una palabra. Entre comillas simples
 * una barra es una letra (`'x\'` termina ahí); en `$'…'`, escapa. Lo que corre adentro de una sustitución
 * (`x="$(cat > f <<'EOF' … )"`, `${x:-$(cp a b)}`) es comando: se suma al final, cada uno en su renglón.
 */
function vaciarCitados(t, hondo = 0) {
  const { texto, comandos } = leerCitados(t, hondo);
  return comandos.length ? `${texto}\n${comandos.join('\n')}` : texto;
}

/**
 * Los textos entre comillas vaciados con una expresión, como se leía antes de `leerCitados`: no sabe de sustituciones ni
 * de `$'…'`, y toma la barra como escape también entre comillas simples. Quedan los que pueden ser un nombre de archivo y
 * los que siguen a un `>` o a `tee`.
 */
function vaciarConExpresion(t) {
  return t.replace(/(^|[^>\w])(?<!tee[ \t]+)(?<!>[ \t]*)(['"])((?:\\.|(?!\2)[^\\])*)\2/g, (m, pre, q, body) => (/^[^\s'"|;&<>`()]+$/.test(body) ? m : `${pre}${q}${q}`));
}

/** La lectura de `vaciarCitados`: `{ texto, comandos }`, el texto vaciado y lo que corre en sus sustituciones. */
function leerCitados(t, hondo) {
  // más hondo que el tope, como se leía antes
  if (hondo >= HONDO_DE_CITADOS) return { texto: vaciarConExpresion(t), comandos: [] };
  // el texto que se arma, y de su punta la última palabra (sus últimas letras) y si la siguen blancos: mirar la punta del
  // texto armado lo recompone entero cada vez
  let out = '';
  let palabra = '';
  let blancos = false;
  const esBlanco = (ch) => ch === ' ' || ch === '\t';
  const agregar = (x) => {
    out += x;
    // de atrás para adelante: sus blancos del final y la palabra de antes
    let fin = x.length;
    while (fin > 0 && esBlanco(x[fin - 1])) fin--;
    let ini = fin;
    while (ini > 0 && !esBlanco(x[ini - 1])) ini--;
    if (fin === 0) { blancos = blancos || x.length > 0; return; }
    palabra = (ini === 0 && !blancos ? palabra + x.slice(0, fin) : x.slice(ini, fin)).slice(-8);
    blancos = fin < x.length;
  };
  const comandos = [];
  // lo que corre adentro de una sustitución, leído igual (sin sus heredocs ni sus comentarios): su texto, que también es
  // un comando, y el de las sustituciones de adentro
  const sustitucion = (desde, fin) => {
    const r = leerCitados(conComentariosApagados(quitarCuerposDeHeredoc(t.slice(desde, fin), true)), hondo + 1);
    comandos.push(r.texto, ...r.comandos);
    return r.texto;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\') { agregar(t.slice(i, i + 2)); i++; continue; }
    const fin = cierreDeUnaSustitucion(t, i);
    if (fin === -1) { agregar(t.slice(i)); break; }
    if (fin > i) {
      // en el texto de afuera, lo de adentro vaciado como antes: un pedazo roto adentro (una comilla o un `$(` sin
      // cierre) no se pega con lo de afuera; sus comandos se leen igual, aparte
      const abre = c === '`' ? 1 : 2;
      agregar(t.slice(i, i + abre) + vaciarConExpresion(sustitucion(i + abre, fin)) + t[fin]);
      i = fin;
      continue;
    }
    if (c !== '"' && c !== "'") { agregar(c); continue; }
    let j = i + 1;
    if (c === "'") {
      // `$'…'` con un `$` suelto delante (no el segundo de `$$`): ahí la barra escapa
      let pesos = 0;
      while (i - 1 - pesos >= 0 && t[i - 1 - pesos] === '$') pesos++;
      if (pesos % 2 === 1) { while (j < t.length && t[j] !== "'") j += t[j] === '\\' ? 2 : 1; } else { j = t.indexOf("'", i + 1); if (j < 0) j = t.length; }
    } else {
      // entre comillas dobles corren las sustituciones, y su comilla de adentro no cierra la de afuera
      while (j < t.length && t[j] !== '"') {
        if (t[j] === '\\') { j += 2; continue; }
        const f = cierreDeUnaSustitucion(t, j);
        if (f === -1) { j = t.length; break; }
        if (f > j) { const abre = t[j] === '`' ? 1 : 2; sustitucion(j + abre, f); j = f + 1; continue; }
        j++;
      }
    }
    // sin cierre, el resto queda como está
    if (j >= t.length) { agregar(t.slice(i)); break; }
    // queda si parece un nombre de archivo, si va pegado a una palabra o a un `>`, o si lo siguen blancos detrás de un `>`
    // o de `tee`: es el destino
    const queda = /^[^\s'"|;&<>`()]+$/.test(t.slice(i + 1, j)) || (!blancos && /[>\w]$/.test(palabra)) || palabra.endsWith('>') || (blancos && palabra.endsWith('tee'));
    agregar(queda ? t.slice(i, j + 1) : `${c}${c}`);
    i = j;
  }
  return { texto: out, comandos };
}

// lo que vuelve compleja la parte de un comando antes de su `cd`: comillas, sustituciones, paréntesis o llaves, tuberías,
// `||`, un `&` suelto, comentarios, redirecciones, heredocs, escapes y las palabras de control del shell
const ANTES_DEL_CD_COMPLEJO = /['"`(){}|<>#\\]|\$\(|(?:^|[^&])&(?!&)|\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|eval|source|exec|bash|sh|zsh)\b/;

/**
 * Devuelve los paths (tal cual aparecen) que el comando escribe. Lo mira con los renglones como vienen y, si el comando
 * tiene continuaciones de renglón, también unidos como los une el shell (`cp a \` y `b` abajo es `cp a b`): cuentan los
 * destinos de las dos lecturas, así unir los renglones nunca hace ver menos que no unirlos.
 */
function extractWriteTargets(cmd, { keep = null } = {}) {
  const out = new Set();
  const raw = String(cmd || '');
  const s = stripNonCommandText(raw);
  const lecturas = [s];
  // los cuerpos de los heredocs ya no están (`stripNonCommandText`): se puede unir aunque el comando tenga uno
  const unidos = sinContinuaciones(s, { sinCuerpos: true });
  if (unidos !== s) lecturas.push(unidos);
  for (const l of lecturas) destinosDeEscritura(raw, l, keep, out);
  destinosPorElPartidor(raw, keep, out);
  return [...out];
}

/**
 * Agrega a `out` los destinos de los tramos de `tramosDelShell`, con las palabras y las redirecciones que lee el partidor
 * común (`scripts/lib/shell-parse.js`) como el shell: con las comillas, las sustituciones y las redirecciones de zsh. Ve
 * lo que la lectura por expresiones pierde (`>! f`, `1<>f`, un `;` citado en la palabra de una redirección, un destino
 * citado con blancos, `TS=$(date) cp …`), y se suma a ella: nunca se ve menos. Sin el partidor (una instalación a
 * medias) no agrega nada y quedan las otras lecturas.
 */
function destinosPorElPartidor(raw, keep, out, hondo = 0) {
  const p = partidorComun();
  if (!p || typeof p.sinHeredocs !== 'function' || typeof p.parseSimpleCommand !== 'function') return;
  // un destino que es la salida de un comando (`"$(mktemp -d)"`, `$(pwd)/a`) no se sabe sin correrlo: esta lectura no lo
  // suma, como las de antes, que tampoco lo leían; lo que corre adentro se lee como su propio tramo
  const sumar = (t) => { if (t && !/^\/dev\//.test(t) && !/\$\(|`/.test(t)) out.add(t); };
  for (const tramo of tramosDelShell(hondo ? raw : p.sinHeredocs(raw))) {
    const c = p.parseSimpleCommand(sinPalabrasDeBloque(tramo));
    for (const r of c.redirections) if (r.write && r.target != null) sumar(palabraConAnsi(r.target));
    const info = {};
    const programa = programaEntre(c.words, info);
    // el texto de `env -S` (o `--split-string`), que env parte en palabras y corre con las que siguen
    if (info.envS && hondo < HONDO_DE_ENV_S) {
      const { k, pegado } = info.envS;
      const valor = pegado || (k + 1 < c.words.length ? palabraConAnsi(c.words[k + 1]) : '');
      destinosPorElPartidor(`${valor} ${c.words.slice(pegado ? k + 1 : k + 2).join(' ')}`, keep, out, hondo + 1);
    }
    if (!programa) continue;
    const resto = c.words.slice(programa.k + 1);
    const palabras = [programa.n, ...resto.map(palabraConAnsi)];
    if (COPIA.test(programa.n)) {
      for (const t of destinosDeCpMv(palabras)) sumar(t);
      // una sustitución suelta al final puede no dar ninguna palabra (`cp a b $(true)`): el destino es la de antes
      let fin = palabras.length;
      while (fin > 2 && /^(?:\$\(|`)/.test(resto[fin - 2])) fin--;
      if (fin < palabras.length) for (const t of destinosDeCpMv(palabras.slice(0, fin))) sumar(t);
    }
    if (/^tee(?![\w.-])/.test(programa.n)) for (const t of palabras.slice(1)) if (!t.startsWith('-')) sumar(t);
    if (/^rsync(?![\w.-])/.test(programa.n)) for (const t of archivosDeRsync(palabras)) sumar(t);
    const ultimo = palabras[palabras.length - 1];
    if (/^truncate(?![\w.-])/.test(programa.n) && palabras.length > 1 && !ultimo.startsWith('-')) sumar(ultimo);
    destinosDelSedEnSitio([programa.n, ...resto].join(' '), raw, keep, out);
  }
}

// cuántas sustituciones adentro de otras se parten en tramos
const HONDO_DE_SUSTITUCIONES = 8;

/**
 * Los tramos del comando como los parte el shell, sin sus comentarios: corta en `;`, `&&`, `||`, `|`, `|&`, `&` y el salto
 * de renglón que están fuera de comillas y de sustituciones; no en el `|` de `>|` o `>&|` ni en el `&` de una redirección
 * (`2>&1`, `&>f`, `<&0`). Una sola pasada: una comilla o una sustitución sin cerrar se lleva el resto en el mismo tramo.
 */
function tramosDelShell(texto, hondo = 0) {
  const s = String(texto);
  const out = [];
  // el tramo que se arma, y sus dos últimas letras sueltas (sin escapar ni citadas; vacía detrás de otra cosa): mirar la
  // punta del tramo armado lo recompone entero cada vez
  let cur = '';
  let cola = '';
  const agregar = (t, suelta = false) => { cur += t; cola = suelta ? (cola + t).slice(-2) : ''; };
  const cortar = () => { if (cur.trim()) out.push(cur); cur = ''; cola = ''; };
  // los comandos de adentro de una sustitución (entre `desde` y `fin`) también son tramos; más hondo que el tope, quedan
  // las otras lecturas
  const adentro = (desde, fin) => {
    if (hondo >= HONDO_DE_SUSTITUCIONES) return;
    for (const t of tramosDelShell(s.slice(desde, fin), hondo + 1)) out.push(t);
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { if (s[i + 1] !== '\n') agregar(s.slice(i, i + 2)); i++; continue; }
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      let j = c === '$' ? i + 2 : i + 1;
      while (j < s.length && s[j] !== "'") j += c === '$' && s[j] === '\\' ? 2 : 1;
      agregar(s.slice(i, j + 1));
      i = j;
      continue;
    }
    // entre comillas dobles, una sustitución corre igual, y su comilla de adentro no cierra la de afuera
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') { j += 2; continue; }
        const f = finDeSustitucion(s, j);
        if (f === -1) { j = s.length; break; }
        if (f > j) { if (s[j] === '`') adentro(j + 1, f); else if (s[j + 1] === '(') adentro(j + 2, f); j = f + 1; continue; }
        j++;
      }
      agregar(s.slice(i, j + 1));
      i = j;
      continue;
    }
    // (`<(…)` y `>(…)` también: su tubería de adentro no parte el tramo)
    const proceso = (c === '<' || c === '>') && s[i + 1] === '(';
    const fin = proceso ? cierreDeParentesis(s, i + 1) : finDeSustitucion(s, i);
    if (fin === -1) { agregar(s.slice(i)); break; }
    if (fin > i) {
      if (c === '`') adentro(i + 1, fin); else if (s[i + 1] === '(') adentro(i + 2, fin);
      agregar(s.slice(i, fin + 1));
      i = fin;
      continue;
    }
    if (c === '#' && (cur.length === 0 || /\s/.test(cola.slice(-1)))) { while (i + 1 < s.length && s[i + 1] !== '\n') i++; continue; }
    if (c === '\n' || c === ';') { cortar(); continue; }
    if (c === '|') {
      if (cola.endsWith('>') || cola === '>&') { agregar(c, true); continue; }
      if (s[i + 1] === '|' || s[i + 1] === '&') i++;
      cortar();
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { i++; cortar(); continue; }
      if (s[i + 1] === '>' || cola.endsWith('>') || cola.endsWith('<')) { agregar(c, true); continue; }
      cortar();
      continue;
    }
    agregar(c, true);
  }
  cortar();
  return out;
}

/** Agrega a `out` los destinos de escritura de `s` (el comando ya sin lo que no es comando); `raw`, el comando entero. */
function destinosDeEscritura(raw, s, keep, out) {
  // 1) redirecciones: `> f`, `>> f`, `2> f`, `&> f`, `>| f`, `>& f` (no `>&2`, no `<`)
  const reRedirect = new RegExp(`(?:^|[^<>&])(?:&|\\d)?>{1,2}(?:\\||&(?![\\d-]))?[ \\t]*${Q}`, 'g');
  let m;
  while ((m = reRedirect.exec(s))) {
    const t = tok(m, 1);
    if (t && !t.startsWith('&') && !/^\/dev\//.test(t)) out.add(t);
  }
  // las de zsh que pisan el archivo aunque el shell no deje pisar (`>! f`, `>>! f`, `&>! f`, `>&! f`, `>&| f`); en bash
  // `>!` es `>` al archivo `!`, que se lee arriba. El partidor común las lee también, salvo `>&|`, que parte en la tubería
  const reZsh = new RegExp(`(?:^|[^<>&])(?:&|\\d)?>{1,2}&?[|!][ \\t]*${Q}`, 'g');
  while ((m = reZsh.exec(s))) {
    const t = tok(m, 1);
    if (t && !/^\/dev\//.test(t)) out.add(t);
  }

  // 2) tee [-a] f1 [f2 …]
  const reTee = /\btee\b((?:[ \t]+-[a-zA-Z]+)*)((?:[ \t]+(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+))+)/g;
  while ((m = reTee.exec(s))) {
    const args = m[2].match(new RegExp(Q, 'g')) || [];
    for (const a of args) {
      const mm = a.match(new RegExp(`^${Q}$`));
      const t = mm ? tok(mm, 1) : null;
      if (t && !t.startsWith('-')) out.add(t);
    }
  }

  // 3) sed -i / --in-place / perl -i / -pi / -ni : todo token con extensión de código del segmento, o que quien llama
  //    quiere mirar igual (`keep`: el estado y el árbol instalado, sea cual sea la extensión)
  for (const crudo of splitSegments(s)) {
    // la palabra de un bloque o el paréntesis delante no es el comando: `do cp a b`, `then sed -i …`, `if cp a b`, `(cp a b)`
    const seg = sinPalabrasDeBloque(crudo);
    // Anclados al INICIO del segmento: `grep -i "sed" src/a.ts` no es un sed -i. Sin variables ni envoltorios delante, y
    // con el programa por su nombre (`env sed -i`, `/usr/bin/sed -i` son un sed -i); y también con la lectura de siempre,
    // el nombre al principio detrás de variables y `sudo`: cuenta lo que vea cualquiera de las dos
    const programa = desdeElPrograma(sinRedireccionesDelante(seg));
    for (const head of new Set([programa, seg.trim().replace(/^(?:\w+=\S+\s+)*(?:sudo\s+)?/, '')])) destinosDelSedEnSitio(head, raw, keep, out);
    // 4) cp / mv / ln / install / rsync → destino = último token del segmento (un enlace también deja un archivo en su
    //    destino). También las formas de PowerShell de cp y mv (Copy-Item / Move-Item y sus alias copy / cpi / move / mi;
    //    no distingue mayúsculas): por la herramienta PowerShell de Windows. Una redirección delante (`> f cp a b`) no es
    //    el comando, ni un envoltorio (`env cp`, `nohup cp`); el programa también por su ruta o escapado (`/bin/cp`, `\cp`).
    //    Y con la lectura de siempre, el nombre al principio: cuenta lo que vea cualquiera de las dos
    if (COPIA.test(programa) || /^(?:copy-item|move-item|copy|cpi|move|mi)\b/i.test(programa)) {
      for (const t of cpMvDest(programa)) out.add(t);
    }
    const comando = sinRedireccionesDelante(seg);
    if (/^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cp|mv|ln)\b/.test(comando) || /^(?:copy-item|move-item|copy|cpi|move|mi)\b/i.test(comando)) {
      for (const t of cpMvDest(seg)) out.add(t);
    }
  }

  // 5) scripts inline: open('f','w'|'a'), writeFileSync('f'), fs.writeFile('f', Set-Content/Out-File —
  //    sobre el comando CRUDO (viven dentro de strings que stripNonCommandText vacía a propósito)
  //    también con las comillas escapadas del shell leídas como comillas (`python3 -c "open(\"f\", \"w\")"`)
  // open(<ruta literal>, <modo que escribe>), con el modo leído por abreParaEscribir (`'w'`, `'r+'`, `mode='x'`, uno en
  // una variable) sobre el texto con las comillas escapadas leídas como comillas: en el crudo, un `\"r\"` no se lee como
  // lectura. La ruta va primera o como `file=`/`path=`, con o sin prefijo de texto (`r'…'`, `b'…'`); también como método
  // con la ruta primero (`File.open('f', 'w')`, `io.open`, `codecs.open`) y con la ruta en `Path('f').open('w')`
  const sinEscapes = sinEscapesDeComillas(raw);
  const LITERAL = /^[rRbBuUfF]{0,2}(['"])([^'"]+)\1$/;
  for (const o of sinEscapes.matchAll(/(?<![\w$])open\s*\(/g)) {
    const desde = o.index + o[0].length;
    if (!abreParaEscribir(sinEscapes, desde, false)) continue;
    const primero = primerArgumento(sinEscapes, desde).arg;
    const conNombre = /^(?:file|path)\s*=\s*([\s\S]+)$/.exec(primero);
    let lit = LITERAL.exec((conNombre ? conNombre[1] : primero).trim());
    if (!lit) {
      // la ruta con nombre puede no ir primera: `open(mode='w', file='f')`
      for (let pos = desde, k = 0; k < 16; k++) {
        const a = primerArgumento(sinEscapes, pos);
        const n = /^(?:file|path)\s*=\s*([\s\S]+)$/.exec(a.arg);
        if (n) { lit = LITERAL.exec(n[1].trim()); break; }
        if (sinEscapes[a.fin] !== ',') break;
        pos = a.fin + 1;
      }
    }
    if (lit) out.add(lit[2]);
  }
  for (const o of sinEscapes.matchAll(/\bPath\s*\(\s*[rRbBuUfF]{0,2}(['"])([^'"]+)\1\s*\)\s*\.\s*open\s*\(/g)) {
    if (abreParaEscribir(sinEscapes, o.index + o[0].length, true)) out.add(o[2]);
  }
  // perl, con el manejador primero: `open(FH, '>f')` (el modo pegado a la ruta) y `open(my $fh, '>', 'f')`; escribe con
  // `>`, `>>`, `+<` o `+>`
  for (const o of sinEscapes.matchAll(/\bopen\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*(['"])\s*(?:\+<|\+?>{1,2})\s*([^'"\s]+)\1/g)) out.add(o[2]);
  for (const o of sinEscapes.matchAll(/\bopen\s*\(?\s*(?:my\s+)?\$?\w+\s*,\s*(['"])\s*(?:\+<|\+?>{1,2})[^'"]*\1\s*,\s*(['"])([^'"]+)\2/g)) out.add(o[3]);
  for (const texto of new Set([raw, sinEscapes])) {
    const reNodeWrite = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\(\s*(['"`])([^'"`]+)\1/g;
    while ((m = reNodeWrite.exec(texto))) out.add(m[2]);
    // python: Path('f').write_text(…) / pathlib.Path('f').write_bytes(…)
    const rePathWrite = /\bPath\(\s*(['"])([^'"]+)\1\s*\)\s*\.(?:write_text|write_bytes)\s*\(/g;
    while ((m = rePathWrite.exec(texto))) out.add(m[2]);
    // ruby: File.write('f', …) / IO.write / File.binwrite (`File.open('f', 'w')` ya lo ve el `open(` de arriba)
    const reRubyWrite = /\b(?:File|IO)\.(?:write|binwrite)\(\s*(['"])([^'"]+)\1/g;
    while ((m = reRubyWrite.exec(texto))) out.add(m[2]);
  }
  const rePs = /\b(?:Set-Content|Out-File|Add-Content)\b(?:\s+-(?:Path|LiteralPath|FilePath))?\s+(['"]?)([^\s'"]+)\1/gi;
  while ((m = rePs.exec(raw))) out.add(m[2]);
  // [IO.File]::WriteAllText / AppendAllText / WriteAllLines('f', …): escriben como Set-Content
  const reDotNet = /\[(?:system\.)?io\.file\]::(?:writealltext|appendalltext|writealllines|appendalllines|writeallbytes)\(\s*(['"])([^'"]+)\1/gi;
  while ((m = reDotNet.exec(raw))) out.add(m[2]);

  // 6) dd of=… y truncate … <file>: dos escritores que, sin esta extracción, permitirían escribir el estado
  //    del pipeline esquivando esta puerta.
  const reDd = /\bdd\b[^\n|;&]*?\bof=(['"]?)([^\s'"]+)\1/g;
  while ((m = reDd.exec(s))) out.add(m[2]);
  for (const seg of splitSegments(s)) {
    // el programa por su nombre, y la lectura de siempre (el nombre al principio, detrás de variables y `sudo`)
    for (const comando of new Set([desdeElPrograma(sinRedireccionesDelante(seg)), sinRedireccionesDelante(seg)])) {
      if (!/^(?:\w+=\S+\s+)*(?:sudo\s+)?truncate\b/.test(comando)) continue;
      const words = palabrasDelComando(comando);
      // el último, si no es una opción; con el tramo sin cerrar, todos los que no lo son
      const t = words[words.length - 1];
      if (words.sinCerrar) for (const w of ultimosArgumentos(words)) out.add(w);
      else if (t && !t.startsWith('-')) out.add(t);
    }
  }

  // 7) git con `--output` (log, diff, show y los que aceptan las opciones de diff) escribe el archivo que nombra, pegado
  //    con `=` o en la palabra que sigue; git acepta abreviar la opción (`--out=…`). Con `git -C <carpeta>` una ruta
  //    relativa es desde esa carpeta: cuentan las dos. `git` se busca en cualquier lugar del tramo: detrás de `env`,
  //    `xargs` o `find -exec` también corre.
  const esOutput = (w) => { const nombre = w.split('=')[0]; return nombre.length >= 4 && '--output'.startsWith(nombre); };
  for (const seg of splitSegments(s)) {
    const words = (seg.match(new RegExp(Q, 'g')) || []).map((w) => { const mm = w.match(new RegExp(`^${Q}$`)); return mm ? tok(mm, 1) : null; }).filter((w) => w != null);
    const k = words.findIndex((w) => path.basename(w) === 'git');
    if (k < 0) continue;
    let carpeta = null;
    for (let i = k + 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-C' && words[i + 1]) { carpeta = words[++i]; continue; }
      if (!esOutput(w)) continue;
      // `--output='specs/h.md'` llega en dos palabras: la opción con su `=` y el valor citado
      const crudo = w.includes('=') && !w.endsWith('=') ? w.slice(w.indexOf('=') + 1) : words[++i];
      // con sus comillas resueltas, como lo deja el shell
      const valor = crudo ? palabraDelShell(crudo) : '';
      if (!valor) continue;
      out.add(valor);
      if (carpeta && !path.isAbsolute(valor)) out.add(path.join(carpeta, valor));
    }
  }
  // un alias de git que lleva `--output` (`git -c 'alias.d=diff --output=specs/h.md' d`): su definición se lee del
  // comando tal cual, porque entre comillas con espacios no queda en el texto que se mira arriba
  for (const m of raw.matchAll(/\balias\.[^\s=]+=([^\n'"]*)/gi)) {
    const partes = m[1].trim().split(/\s+/);
    for (let i = 0; i < partes.length; i++) {
      if (!esOutput(partes[i])) continue;
      const valor = partes[i].includes('=') && !partes[i].endsWith('=') ? partes[i].slice(partes[i].indexOf('=') + 1) : partes[i + 1];
      if (valor) out.add(valor);
    }
  }
}

/**
 * Los scripts inline del comando con sus argumentos: `[{ script, argv }]`. Un script va después de `-e`, `-c`, `-p`,
 * `--eval` o `-Command` (con o sin opciones antes), o por la entrada estándar con un heredoc (`python3 - a <<EOF`,
 * `node <<EOF`). Sólo se mira el texto del script: lo que otro comando menciona (un mensaje de commit, un `.md` escrito
 * por heredoc) no es un script.
 */
function scriptsInline(cmd) {
  const raw = String(cmd || '');
  const out = [];
  const inicio = `(?:^|[\\s;&|(\`])(?:[^\\s;&|()'"]*[\\\\/])?(?:${INTERPRETES})(?:\\.exe)?`;
  // cada parte con una sola lectura posible: una barra invertida es siempre escape, una opción empieza con letra
  const conFlag = new RegExp(`${inicio}((?:\\s+-{1,2}[A-Za-z][\\w-]*(?:=[^\\s'"]+)?)*?)\\s+(?:-[a-zA-Z]*[epc]|--eval|--print|-Command)\\s+(['"])((?:\\\\[\\s\\S]|(?!\\2)[^\\\\])*)\\2([^\\n;&|]*)`, 'gi');
  // sin los cuerpos de los heredocs: un `node -e` adentro de un `.md` que se escribe es texto, no un comando
  const sinCuerpos = raw.replace(/((?<!<)<<(?!<)(?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*<<)(?<!\$\(\([^\n]*<<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)(?:[\s\S]*?\n)??[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  for (const m of sinCuerpos.matchAll(conFlag)) out.push({ script: m[3], argv: argumentosDe(m[4]) });
  // por la entrada: el heredoc o el here-string que llega a un intérprete como su programa, detrás de un envoltorio,
  // en otra etapa de la tubería o con `/dev/stdin`
  for (const p of programasPorEntrada(raw)) {
    // `node - a`: process.argv[1] es '-' y el primer argumento es process.argv[2]; en python, sys.argv[1] ya es `a`
    const argv = !p.conGuion ? [] : /^(?:node|nodejs|bun|deno)$/.test(p.interprete) ? ['-', ...p.despues] : p.despues;
    // un heredoc sin comillas (`<<EOF`): el shell expande las variables del cuerpo antes de correrlo
    out.push({ script: p.cuerpo, argv, expande: !p.comillas });
  }
  return out;
}

/**
 * Las opciones de un intérprete hasta su guion: `{ enLinea, desde, modulos, precargas }`. `enLinea` si el programa va
 * en la línea (`-c`, `-e`: lo ve `scriptsInline`), `desde` la primera palabra que ya no es opción, `modulos` lo que se
 * corre como módulo (`python3 -m x`) y `precargas` los guiones que se cargan antes (`node -r ./p.js`). Cada familia lee
 * sus opciones agrupadas y con el valor pegado (`-Wignore`, `-mx`, `-Ilib`, `--require=./p.js`).
 */
function opcionesDelInterprete(familia, words, i) {
  const r = { enLinea: false, desde: words.length, modulos: [], precargas: [] };
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { r.desde = i + 1; return r; }
    if (!w.startsWith('-') || w === '-') { r.desde = i; return r; }
    if (familia === 'node') {
      const largo = /^(--[\w-]+)(?:=(.*))?$/.exec(w);
      const nombre = largo ? largo[1] : w;
      if (['-e', '-p', '--eval', '--print'].includes(nombre) || /^-[A-Za-z]*[ep]$/.test(w)) r.enLinea = true;
      if (['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(nombre)) {
        const v = largo && largo[2] != null ? largo[2] : words[++i];
        if (v) r.precargas.push(v);
      }
      continue;
    }
    // una opción larga con su valor aparte deja el valor como palabra: no existe como archivo, y se sigue buscando
    if (w.startsWith('--')) continue;
    // opciones cortas agrupadas: la que lleva valor se queda con el resto de la palabra, o con la siguiente
    const conValor = { python: 'WXm', perl: 'IMmlCx0', ruby: 'IrCEFKTWx0' }[familia] || '';
    const enLinea = { python: 'c', perl: 'eE', ruby: 'e' }[familia] || '';
    for (let k = 1; k < w.length; k++) {
      const c = w[k];
      if (enLinea.includes(c)) { r.enLinea = true; break; }
      if (conValor.includes(c)) {
        const v = k + 1 < w.length ? w.slice(k + 1) : (c === 'x' || c === '0' ? '' : words[++i]);
        if (familia === 'python' && c === 'm' && v) r.modulos.push(v);
        if (familia === 'ruby' && c === 'r' && v) r.precargas.push(v);
        break;
      }
    }
  }
  return r;
}

/**
 * El comando con los renglones unidos donde el shell los une: una barra invertida justo antes del salto de línea. No en un
 * comentario, donde el salto corta igual; tampoco una barra escapada (`\\`), ni delante de un `\r`, que para el shell es un
 * carácter más. Es para ver un comando largo entero al buscar guiones; `tramos` queda como la leen los demás frenos. Con
 * un heredoc no une nada: en su cuerpo la barra es texto, y unir la línea de cierre correría el cierre a un renglón posterior
 * y borraría lo que hay en el medio.
 */
function sinContinuaciones(cmd, { sinCuerpos = false } = {}) {
  const s = String(cmd);
  // con `sinCuerpos`, quien llama ya sacó los cuerpos de los heredocs: une igual
  if (!sinCuerpos && s.includes('<<')) return s;
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === '\\') {
      if (s[i + 1] !== '\n') out += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (q === '"') { out += c; if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    // empieza una palabra: después de un espacio o de un signo que corta palabras (`true;#\`)
    if (c === '#' && (i === 0 || /[\s;&|()<>`]/.test(s[i - 1]))) {
      const fin = s.indexOf('\n', i);
      const hasta = fin < 0 ? s.length : fin;
      out += s.slice(i, hasta);
      i = hasta - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Lo que un guion en archivo escribe con una ruta que se sabe: las escrituras literales y las que arma con sus
 * argumentos, como si llegara en la línea. `armadosSinSaber` cuenta los destinos que arma de un modo que no se lee
 * (`argparse`, un desempaquetado): con una historia entre los argumentos, cuenta esa historia. Los demás textos del
 * guion no cuentan: un guion que sólo lee una historia no la escribe.
 */
function escritosDelGuion(g) {
  const comillas = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
  const forma = `${g.interprete} - ${g.argv.map(comillas).join(' ')} <<'__TYCON_GUION__'\n${g.texto}\n__TYCON_GUION__`;
  const armados = destinosArmados('', [{ script: g.texto, argv: g.argv }]);
  const perl = [...g.texto.matchAll(/\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\+?>{1,2}\s*([^'"\s]+)\1/g)].map((m) => m[2])
    .concat([...g.texto.matchAll(/\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\+?>{1,2}['"]\s*,\s*(['"])([^'"]+)\1/g)].map((m) => m[2]));
  return {
    rutas: [
      ...extractWriteTargets(forma, { keep: () => true }),
      ...armados.flatMap((a) => (a.literal ? [a.literal] : (a.literales || []))),
      ...perl,
    ],
    armadosSinSaber: armados.some((a) => !a.literal && !a.literales && (!a.ext || a.ext === '.md')),
  };
}

/**
 * Los destinos con que un script inline nombra el archivo que escribe, cuando no son una ruta literal:
 * `[{ expr, literal?, ext?, cola? }]` (ver leerArmado). `guiones` son los del comando, o los de un archivo ya leído.
 */
function destinosArmados(cmd, guiones = scriptsInline(cmd)) {
  const vistos = new Map();
  for (const [n, { script, argv }] of guiones.entries()) {
    // la misma expresión en dos guiones es otro destino: `p` vale lo que asigna cada guion
    const add = (e) => {
      const x = String(e || '').trim();
      const clave = `${n}\u0000${x}`;
      if (x && !DESTINO_LITERAL.test(x) && !vistos.has(clave)) vistos.set(clave, { expr: x, ...leerArmado(x, script, argv) });
    };
    const llamadas = (re, quePasa) => {
      for (const m of script.matchAll(re)) {
        const a = primerArgumento(script, m.index + m[0].length);
        if (!quePasa || quePasa(a)) add(a.arg);
      }
    };
    llamadas(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/g);
    // lo que reemplaza, mueve o copia sobre el destino, su segundo argumento: `os.replace(tmp, <destino>)`,
    // `shutil.move`, `fs.renameSync`, `fs.copyFileSync`
    for (const m of script.matchAll(/\b(?:os\.(?:replace|rename)|shutil\.(?:move|copy|copy2|copyfile)|renameSync|rename|copyFileSync|copyFile)\s*\(/g)) {
      const a = primerArgumento(script, m.index + m[0].length);
      if (script[a.fin] === ',') add(primerArgumento(script, a.fin + 1).arg);
    }
    // python: open(<destino>, 'w'|'a'|'x'|'+'); sin modo es lectura
    const sinEscapes = sinEscapesDeComillas(script);
    for (const m of sinEscapes.matchAll(/\bopen\s*\(/g)) {
      const a = primerArgumento(sinEscapes, m.index + m[0].length);
      // en perl el primer argumento es el manejador (`my $fh`, o `FH` seguido de un modo de perl): su destino lo leen la
      // regla de perl de abajo y los destinos literales. Un nombre en mayúsculas sin modo de perl es una variable
      // (`open(P, 'w')` en python): sigue contando
      const segundo = sinEscapes[a.fin] === ',' ? primerArgumento(sinEscapes, a.fin + 1).arg : '';
      if (/^(?:my\s+)?\$\w+$/.test(a.arg) || (/^[A-Z][A-Z0-9_]*$/.test(a.arg) && /^(['"])\s*(?:\+?[<>]|\|)/.test(segundo))) continue;
      // el archivo puede ir con nombre y en cualquier lugar: `open(mode='w', file=sys.argv[1])`
      if (abreParaEscribir(sinEscapes, m.index + m[0].length, false) && sinEscapes[a.fin] === ',') add(archivoQueAbre(sinEscapes, m.index + m[0].length) || a.arg);
    }
    // python: Path(<destino>).write_text / write_bytes
    llamadas(/\bPath\s*\(/g, (a) => /^\)\s*\.(?:write_text|write_bytes)\s*\(/.test(script.slice(a.fin)));
    // perl: open(my $fh, '>', <destino>)
    for (const m of script.matchAll(/\bopen\s*\(?\s*(?:my\s+)?\$\w+\s*,\s*['"]\+?>{1,2}['"]\s*,\s*/g)) add(primerArgumento(script, m.index + m[0].length).arg.replace(/\)\s*;?$/, ''));
    // powershell: Set-Content / Out-File / Add-Content con una variable o una expresión, y [IO.File]::Write*
    for (const m of script.matchAll(/\b(?:Set-Content|Out-File|Add-Content)\b(?:\s+-(?:Path|LiteralPath|FilePath))?\s+([$(][^\s'"]*)/gi)) add(m[1]);
    llamadas(/\[(?:system\.)?io\.file\]::(?:writealltext|appendalltext|writealllines|appendalllines|writeallbytes)\s*\(/gi);
  }
  return [...vistos.values()];
}

/**
 * Los heredocs que abre el renglón, en orden: `{ delimitador, inicio, fin }`, con `inicio` y `fin` los del operador con
 * su palabra (`<<-'EOF'`). No abren nada lo de adentro de comillas, lo escapado, lo que sigue a un `$((` ni lo que sigue a
 * un `#` que empieza una palabra: ahí el shell ve un comentario y el renglón siguiente corre. Tampoco lo de adentro de
 * una cuenta o una expansión (`((…))`, `$[…]`, `${…}`), y una que no cierra en el renglón corta lo que sigue: leer de
 * más como comando es el lado que frena.
 */
function* aperturasDeHeredoc(linea) {
  const aritmetica = linea.indexOf('$((');
  const tope = aritmetica < 0 ? linea.length : Math.min(linea.length, aritmetica + 3);
  for (let i = 0; i < tope; i++) {
    const c = linea[i];
    if (c === '\\') {
      i++;
    } else if (c === '#' && (i === 0 || /[\s;&|()]/.test(linea[i - 1]))) {
      return;
    } else if (c === '$' && linea[i + 1] === "'") {
      // `$'…'`: una comilla escapada no lo cierra (`$'it\'s <<Z'` es un texto)
      let j = i + 2;
      while (j < linea.length && linea[j] !== "'") j += linea[j] === '\\' ? 2 : 1;
      if (j >= linea.length) return;
      i = j;
    } else if (c === "'") {
      const cierra = linea.indexOf("'", i + 1);
      if (cierra < 0) return;
      i = cierra;
    } else if (c === '"') {
      let j = i + 1;
      while (j < linea.length && linea[j] !== '"') j += linea[j] === '\\' ? 2 : 1;
      if (j >= linea.length) return;
      i = j;
    } else if (empiezaCuenta(linea, i)) {
      const fin = finDeCuenta(linea, i);
      if (fin < 0) return;
      i = fin;
    } else if (c === '<' && linea[i + 1] === '<' && linea[i - 1] !== '<' && linea[i + 2] !== '<') {
      DELIMITADOR_DE_HEREDOC.lastIndex = i + 2;
      const m = DELIMITADOR_DE_HEREDOC.exec(linea);
      if (m) yield { delimitador: m[2], inicio: i, fin: DELIMITADOR_DE_HEREDOC.lastIndex };
    }
  }
}

/**
 * Los heredocs que abre el renglón como los leía la expresión de `heredocs()`, en orden y con la misma forma que
 * `aperturasDeHeredoc`: las comillas sin escapes desde el principio del renglón (simples o dobles, hasta la siguiente
 * igual), sin mirar el `#`, y nada desde el primer `$((`. Así `heredocs()` da lo mismo que antes, renglón por renglón,
 * salvo en una cuenta o una expansión: adentro no abre nada, como `aperturasDeHeredoc`.
 */
function* aperturasComoAntes(linea) {
  const aritmetica = linea.indexOf('$((');
  const tope = aritmetica < 0 ? linea.length : aritmetica;
  let comilla = null;
  for (let i = 0; i < tope; i++) {
    const c = linea[i];
    if (comilla) { if (c === comilla) comilla = null; continue; }
    if (c === "'" || c === '"') { comilla = c; continue; }
    if (empiezaCuenta(linea, i)) {
      const fin = finDeCuenta(linea, i);
      if (fin < 0) return;
      i = fin;
      continue;
    }
    if (c === '<' && linea[i + 1] === '<' && linea[i - 1] !== '<' && linea[i + 2] !== '<') {
      DELIMITADOR_DE_HEREDOC.lastIndex = i + 2;
      const m = DELIMITADOR_DE_HEREDOC.exec(linea);
      if (m) yield { delimitador: m[2], inicio: i, fin: DELIMITADOR_DE_HEREDOC.lastIndex };
    }
  }
}

/** Los delimitadores que abre el renglón, en orden (`aperturasDeHeredoc`). */
function* delimitadoresQueAbre(linea) {
  for (const a of aperturasDeHeredoc(linea)) yield a.delimitador;
}

function heredocsCerrados(lineas) {
  const cierreTras = cierresDe(lineas);
  const out = [];
  for (let n = 0; n < lineas.length - 1; n++) {
    let cursor = n;
    let indice = 0;
    // un heredoc sin cierre se come el resto: los que siguen en el renglón ya no tienen cuerpo
    for (const { delimitador, inicio, fin } of aperturasDeHeredoc(lineas[n])) {
      const cierre = cierreTras(delimitador, cursor);
      if (cierre < 0) break;
      out.push({ abre: n, desde: cursor + 1, cierre, indice: indice++, operador: { inicio, fin } });
      cursor = cierre;
    }
    n = cursor;
  }
  return out;
}

/**
 * El comando sin los cuerpos de sus heredocs ni sus renglones de cierre. Un heredoc sin cierre queda como está. Con
 * `marcar`, cada cuerpo sacado deja un renglón con `MARCA_DE_CUERPO` y su delimitador: el cierre de una sustitución lo toma
 * por el cuerpo, en vez de buscar el delimitador más abajo.
 */
function quitarCuerposDeHeredoc(cmd, marcar = false) {
  const s = String(cmd || '');
  if (!s.includes('<<')) return s;
  const lineas = s.split('\n');
  const out = [];
  let n = 0;
  for (const { abre, cierre } of heredocsCerrados(lineas)) {
    while (n <= abre) out.push(lineas[n++]);
    // un cuerpo que ya estaba sacado conserva su marca
    const marca = lineas[cierre][0] === MARCA_DE_CUERPO ? lineas[cierre] : MARCA_DE_CUERPO + sinBlancosAlBorde(lineas[cierre]);
    out.push(marcar ? marca : '');
    n = cierre + 1;
  }
  while (n < lineas.length) out.push(lineas[n++]);
  return out.join('\n');
}

// Las dos lecturas del comando (ver `handle`): en una se apagan sus comentarios, en la otra no. `apagoAlgo` dice si la
// primera apagó alguno: si no, las dos lecturas son la misma
let leerComentarios = true;
let apagoAlgo = false;
// la segunda lectura sólo decide: no anota lo que el comando escribe ni lo que borra (ya lo anotó la primera)
let soloDecidir = false;
/**
 * El comando con sus comentarios apagados: desde un `#` que empieza una palabra hasta el salto de renglón, el texto queda
 * pero sin lo que abre o cierra algo (`ABRE_O_CIERRA`). Una comilla o un `<<EOF` adentro de un comentario no abren nada y
 * el renglón siguiente corre, como en el shell: sin esto, esa comilla juntaba lo de abajo con el comentario y nadie lo
 * miraba. Como el texto queda, si algo se toma por comentario sin serlo, lo que sigue en ese renglón se sigue mirando. Se
 * usa sobre el comando ya sin los cuerpos de sus heredocs (lo de adentro de un cuerpo no es del shell).
 *
 * Un `#` es comentario sólo cuando es seguro, en bash y en zsh:
 *  - empieza una palabra: después de un espacio, un tab, un salto de renglón, `;`, `&` o `|`. Un `\r` o un espacio de
 *    Unicode son parte de la palabra, como lo escapado, el cierre de unas comillas, de un paréntesis o de una llave; una
 *    continuación de renglón (`\` y salto) no corta la palabra, porque el shell junta los renglones;
 *  - afuera de todo, o sólo adentro de un `case`: adentro de comillas, de comillas invertidas, de `${…}` o de cualquier
 *    paréntesis el `#` puede ser texto, y no se apaga nada. Las comillas se anidan como en el shell: una comilla doble
 *    adentro de `"$(…)"` abre otro texto. `$'…'` deja escapar su comilla. El `)` de un patrón de `case` no cierra nada.
 */
function conComentariosApagados(cmd) {
  const s = String(cmd || '');
  if (!leerComentarios || !s.includes('#')) return s;
  let out = '';
  // lo abierto, de afuera hacia adentro: `'`, `"`, `$'`, `` ` ``, `(` (también `$(` y `<(`), `{` (el de `${`), `(p` (el
  // paréntesis que abre un patrón de `case`) y los `case`, según dónde se está: el sujeto, un patrón o un cuerpo
  const abiertos = [];
  const arriba = () => abiertos[abiertos.length - 1];
  const cambiarArriba = (e) => { abiertos[abiertos.length - 1] = e; };
  // el último carácter que cuenta para saber si un `#` empieza una palabra: una continuación de renglón no cuenta
  let anterior = '';
  const empiezaPalabra = () => anterior === '' || anterior === ' ' || anterior === '\t' || anterior === '\n' || anterior === ';' || anterior === '&' || anterior === '|';
  // la palabra que se está leyendo afuera de comillas (null entre palabras): si va donde va un comando, y si tiene algo
  // citado o escapado (entonces no es `case` ni `esac`)
  let palabra = null;
  let alPrincipio = true;
  const enPalabra = (limpia) => {
    if (palabra === null) palabra = { texto: '', alComienzo: alPrincipio, limpia };
    else if (!limpia) palabra.limpia = false;
  };
  const sigueLaPalabra = () => { palabra = { texto: '', alComienzo: false, limpia: false }; };
  const terminarPalabra = () => {
    if (palabra === null) return;
    const { texto, alComienzo, limpia } = palabra;
    palabra = null;
    alPrincipio = false;
    if (!limpia) return;
    const a = arriba();
    if (a === 'case-sujeto') { if (texto === 'in') cambiarArriba('case-patron'); return; }
    if (a === 'case-patron') { if (texto === 'esac') abiertos.pop(); return; }
    if (!alComienzo) return;
    if (texto === 'case') abiertos.push('case-sujeto');
    else if (texto === 'esac' && a === 'case-cuerpo') abiertos.pop();
    else if (SIGUE_UN_COMANDO.has(texto)) alPrincipio = true;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const a = arriba();
    if (a === "'") { out += c; if (c === "'") { abiertos.pop(); sigueLaPalabra(); anterior = 'x'; } continue; }
    if (a === "$'" || a === '"') {
      if (c === '\\') { out += c + (s[i + 1] || ''); i++; continue; }
      if (c === (a === '"' ? '"' : "'")) { out += c; abiertos.pop(); sigueLaPalabra(); anterior = 'x'; continue; }
      if (a === '"' && c === '`') { out += c; abiertos.push('`'); palabra = null; alPrincipio = true; continue; }
      if (a === '"' && c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
        out += c + s[i + 1];
        i++;
        abiertos.push(s[i]);
        palabra = null;
        alPrincipio = s[i] === '(';
        continue;
      }
      out += c;
      continue;
    }
    // afuera de comillas: arriba de todo, o adentro de `$(…)`, `${…}`, comillas invertidas, paréntesis o un `case`
    if (c === '\\') {
      if (s[i + 1] === '\n') { out += '\\\n'; i++; continue; }
      enPalabra(false);
      out += c + (s[i + 1] || '');
      i++;
      anterior = 'x';
      continue;
    }
    if (c === '#' && palabra === null && empiezaPalabra() && abiertos.every((e) => e.startsWith('case'))) {
      let fin = s.indexOf('\n', i);
      if (fin < 0) fin = s.length;
      for (; i < fin; i++) out += ABRE_O_CIERRA.test(s[i]) ? ' ' : s[i];
      apagoAlgo = true;
      i--;
      continue;
    }
    if (c === "'" || c === '"') { enPalabra(false); abiertos.push(c); out += c; continue; }
    // `$$` es el número del proceso: la comilla que lo siga es simple común, no `$'…'`
    if (c === '$' && s[i + 1] === '$') { enPalabra(true); out += '$$'; i++; anterior = '$'; continue; }
    if (c === '$' && s[i + 1] === "'") { enPalabra(false); abiertos.push("$'"); out += "$'"; i++; continue; }
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      out += c + s[i + 1];
      i++;
      abiertos.push(s[i]);
      palabra = null;
      alPrincipio = s[i] === '(';
      continue;
    }
    if (c === '`') {
      if (a === '`') { terminarPalabra(); abiertos.pop(); sigueLaPalabra(); } else { abiertos.push('`'); palabra = null; alPrincipio = true; }
      out += c;
      anterior = 'x';
      continue;
    }
    if (c === '(') {
      const patron = a === 'case-patron' && palabra === null;
      palabra = null;
      abiertos.push(patron ? '(p' : '(');
      alPrincipio = !patron;
      out += c;
      anterior = c;
      continue;
    }
    if (c === ')') {
      terminarPalabra();
      // el cierre de un patrón de `case` (con su `(` o sin él): lo que sigue es su cuerpo, donde va un comando
      let patron = false;
      if (a === '(') abiertos.pop();
      else if (a === '(p') { abiertos.pop(); patron = arriba() === 'case-patron'; }
      else if (a === 'case-patron') patron = true;
      if (patron) { cambiarArriba('case-cuerpo'); palabra = null; alPrincipio = true; } else sigueLaPalabra();
      out += c;
      anterior = 'x';
      continue;
    }
    if (c === '}' && a === '{') { terminarPalabra(); abiertos.pop(); sigueLaPalabra(); out += c; anterior = 'x'; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n') {
      terminarPalabra();
      // un `&` pegado a una redirección (`>&1`, `&>`) no separa comandos
      if (c === '&' && (anterior === '>' || anterior === '<' || s[i + 1] === '>')) { out += c; anterior = c; continue; }
      // `;;`, `;&` y `;;&` cierran un cuerpo de `case`: lo que sigue es un patrón
      if (c === ';' && arriba() === 'case-cuerpo' && (s[i + 1] === ';' || s[i + 1] === '&')) {
        cambiarArriba('case-patron');
        out += c + s[i + 1];
        i++;
        if (s[i] === ';' && s[i + 1] === '&') { out += '&'; i++; }
      } else out += c;
      anterior = s[i];
      alPrincipio = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '<' || c === '>') { terminarPalabra(); out += c; anterior = c; continue; }
    enPalabra(true);
    if (palabra.texto.length < 8) palabra.texto += c;
    out += c;
    anterior = c;
  }
  return out;
}

/**
 * Los tramos de un comando (`;`, `&&`, `||`, `|`, salto de línea), sin cortar adentro de las comillas ni de los heredocs.
 * Lo escapado con `\` no corta ni cierra comillas dobles, como en el shell. Con los comentarios apagados (`conComentariosApagados`).
 */
function tramos(cmd) {
  const s = conComentariosApagados(quitarCuerposDeHeredoc(cmd));
  const out = [];
  let q = null;
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q !== "'") { actual += c + (s[i + 1] || ''); i++; continue; }
    if (q) { actual += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; actual += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      if (actual.trim()) out.push(actual);
      actual = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    actual += c;
  }
  if (actual.trim()) out.push(actual);
  return out;
}

/**
 * Las palabras del comando, también las de adentro de un texto que corre otro shell (`bash -c '…'`) y los textos de un
 * guion. Lo que sólo se cita (`textosCitados`) no es una palabra del comando.
 */
function palabrasProfundas(cmd) {
  const out = [];
  const ver = (texto, nivel) => {
    for (const tramo of tramos(texto)) {
      const citados = textosCitados(tramo, cmd);
      for (const w of palabras(tramo)) {
        if (!w || citados.has(w)) continue;
        out.push(w);
        if (nivel < 2 && /\s/.test(w)) ver(w, nivel + 1);
      }
    }
  };
  ver(cmd, 0);
  for (const { script } of scriptsInline(cmd)) {
    for (const m of script.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]);
  }
  return out;
}

/**
 * Las carpetas de los `cd` del comando, en orden: los que empiezan un comando en un tramo (`cd x`, `(cd x`, `x & cd y`,
 * `then cd x`, `command cd x`, `\cd x`, `pushd x`), sin los cuerpos de los heredocs ni el texto entre comillas, y los
 * de adentro de un `$(…)`, de unas comillas invertidas o de un `bash -c '…'`. Cada una con `carpetaDeCd`, y las
 * variables leídas con el comando hasta ese tramo.
 */
function carpetasDeLosCd(cmd, nivel = 0) {
  const raw = String(cmd || '');
  const out = [];
  let desde = 0;
  for (const tramo of tramos(raw)) {
    const en = raw.indexOf(tramo, desde);
    const hasta = en < 0 ? raw.length : en + tramo.length;
    if (en >= 0) desde = hasta;
    for (const pieza of piezasDeTramo(tramo)) {
      const m = /^(?:(?:if|elif|while|until|then|do|else|time|!|command|builtin)\s+)*\\?(cd|pushd)(?:\s+([\s\S]*))?$/.exec(pieza);
      if (!m) continue;
      // `pushd` sin carpeta, o con `+N`/`-N`, va a una carpeta de su pila, que el freno no conoce
      const resto = m[2] || '';
      if (m[1] === 'pushd' && (!resto.trim() || /^\s*[+-]\d+(?:\s|$)/.test(resto))) out.push({ texto: `pushd ${resto.trim()}`.trim(), valor: null, comodin: false });
      else out.push(carpetaDeCd(raw.slice(0, hasta), resto));
    }
  }
  // lo que corre adentro: el cuerpo de un `$(…)` o de unas comillas invertidas, el guion de un shell con `-c` en
  // cualquier lugar (`xargs sh -c '…'`, `bash --norc -o pipefail -c "…"`, `fish -c`) y lo que corre `eval`. Más hondo
  // que tres niveles no se lee: frena
  const adentro = guionesInternos(raw);
  if (adentro.length && nivel >= 3) return [...out, { texto: '(un comando anidado de más)', valor: null, comodin: false }];
  for (const g of adentro) out.push(...carpetasDeLosCd(g, nivel + 1));
  return out;
}

/** Los orígenes de un `mv` o un `Move-Item` (y sus alias): lo que deja de estar donde estaba. */
function origenesMovidos(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    if (!words.length) continue;
    const c = nombreDeComando(words[0]);
    if (!['mv', 'move', 'mi', 'move-item', 'rename-item', 'ren', 'rni'].includes(c)) continue;
    const args = [];
    // el destino dicho con su nombre (`-Destination`, `-NewName`, `-t`): entonces todos los sueltos son orígenes
    let destinoNombrado = false;
    for (let i = 1; i < words.length; i++) {
      // `-t` y `--target-directory` de mv nombran el destino; `-T` (sin carpeta destino) no lleva valor
      if (/^-(?:destination|newname)$/i.test(words[i]) || /^(?:-[a-zA-SU-Z]*t|--target-directory)$/.test(words[i])) { destinoNombrado = true; i++; continue; }
      if (/^--target-directory=/.test(words[i])) { destinoNombrado = true; continue; }
      if (/^-(?:path|literalpath)$/i.test(words[i])) { if (words[i + 1]) args.push(words[++i]); continue; }
      if (words[i].startsWith('-')) continue;
      args.push(words[i]);
    }
    // si no, el último es el destino
    out.push(...(destinoNombrado || /(?:^|\s)-(?:t|-target-directory)\b/.test(tramo) ? args : args.slice(0, -1)));
  }
  return out;
}

function salidaAjenaALaRevision(cmd, cwd, stateDir, installedRoots) {
  const { isPlanReviewRecord } = require('./story-gate.js');
  const { isInside } = require('./atdd-preedit.js');
  const installedTree = require('./installed-tree.js');
  const carpetas = [...new Set([stateDir, installedTree.realPath(stateDir)].filter(Boolean))].map((b) => path.join(b, 'plan-review'));
  const enLaRevision = (abs) => isPlanReviewRecord(abs) || carpetas.some((c) => abs === c || isInside(c, abs) || isInside(c, installedTree.realPath(abs)));
  const delArnes = (ruta, nombre) => {
    const real = installedTree.realPath(path.resolve(cwd, ruta));
    return path.basename(real) === nombre && (installedRoots || []).some((r) => {
      const raiz = installedTree.realPath(r);
      return real === installedTree.realPath(path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', nombre));
    });
  };
  // un destino que no se lee hasta correr (una variable, una sustitución, o relativo después de un `cd`) cuenta como de
  // la revisión si el comando nombra la carpeta de la revisión (`plan-review`, o `…}-review` armada por partes) o el
  // estado; «review» suelto en otra palabra (`code-review`, `preview`, un subcomando `review`) no. El límite de la guía sigue:
  // esto cierra el camino fácil, no una falsificación armada a propósito
  const nombraLaRevision = /(^|[^\w-])plan-review|\}-review|tycon[\\/]state|\.tycon-pipeline/i.test(String(cmd || ''));
  const cambiaDeCarpeta = /(^|[;&|(\s])(?:cd|pushd)(\s|$)/.test(String(cmd));
  // las palabras del comando como las lee el shell, sólo en la forma que imprime el arnés: un solo comando, con caracteres
  // simples sin comillas y tramos entre comillas simples, pegados o no, y un comentario al final. Otra cosa (una barra
  // invertida, comillas dobles, `$`, `~`, comodines, un `#` pegado, otro renglón con algo, también después del
  // comentario, que el shell termina en el salto de renglón) no es esa forma, y el freno no la lee distinto que el shell: null
  const palabrasDelCorredor = (comando) => {
    const t = String(comando);
    const w = [];
    let actual = null;
    // lo que queda desde `i` es un salto de renglón (o nada) y después sólo los blancos del shell: un `\r`, un espacio
    // duro, `\f` o `\v` el shell los toma como parte de una palabra o como otro comando
    const terminaAca = (i) => !/[^ \t\n]/.test(t.slice(i));
    for (let i = 0; i < t.length;) {
      const c = t[i];
      if (c === '\n') { if (!terminaAca(i)) return null; break; }
      if (c === ' ' || c === '\t') { if (actual !== null) { w.push(actual); actual = null; } i++; continue; }
      if (c === '#' && actual === null) {
        const fin = t.indexOf('\n', i);
        if (fin >= 0 && !terminaAca(fin)) return null;
        break;
      }
      if (c === "'") {
        const j = t.indexOf("'", i + 1);
        if (j < 0) return null;
        actual = (actual || '') + t.slice(i + 1, j);
        i = j + 1;
        continue;
      }
      if (!/[A-Za-z0-9_./,=:+@%-]/.test(c)) return null;
      actual = (actual || '') + c;
      i++;
    }
    if (actual !== null) w.push(actual);
    return w;
  };
  // una ruta absoluta, sin `.` ni `..`: la misma para el freno y para el shell, en cualquier carpeta
  const exacta = (p) => path.isAbsolute(p) && path.normalize(p) === p && !p.endsWith(path.sep);
  // el corredor del pase como lo imprime marker.js plan-review (lib/plan-review.js, comandoLite), solo y como el comando
  // entero: `node` (el del PATH: una ruta, `./node` o `nodejs` puede ser un programa de la sesión), los dos guiones del
  // arnés, el pedido y el --out una vez cada uno y, si va, la lista de corredores de la organización; revisores propios o
  // `--args`, nunca. El pedido es la pareja exacta del --out que se mira, `<carpeta de la revisión de este estado>/<sesión>/
  // <destino>.args.json` y `<…>/<destino>.resultado.json`: por la carpeta real, no por su nombre, y un archivo común, no un
  // enlace (si todavía no existe, el corredor no lo lee y no escribe nada)
  const esElCorredor = (comando, abs) => {
    const w = palabrasDelCorredor(comando);
    if (!w || w.length < 3 || w[0] !== 'node') return false;
    if (!exacta(w[1]) || !exacta(w[2]) || !delArnes(w[1], 'workflow-lite.js') || !delArnes(w[2], 'adversarial-verify.workflow.js')) return false;
    const op = {};
    for (let i = 3; i < w.length; i++) {
      const m = /^--(args-file|out|runners)(?:=(.*))?$/.exec(w[i]);
      if (!m || op[m[1]] !== undefined) return false;
      const v = m[2] !== undefined ? m[2] : w[++i];
      if (!v) return false;
      op[m[1]] = v;
    }
    const pedido = op['args-file'];
    if (!pedido || !op.out || !exacta(pedido) || !exacta(op.out)) return false;
    if (op.runners !== undefined && op.runners !== corredoresDeLaOrganizacion().lista) return false;
    const destino = /^(.+)\.resultado\.json$/.exec(path.basename(op.out));
    if (!destino || pedido !== path.join(path.dirname(op.out), `${destino[1]}.args.json`)) return false;
    const carpeta = installedTree.realPath(path.dirname(op.out));
    if (!carpeta || !carpetas.some((c) => installedTree.realPath(c) === path.dirname(carpeta))) return false;
    // el --out que se mira es éste
    if (!abs || installedTree.realPath(path.dirname(abs)) !== carpeta || path.basename(abs) !== path.basename(op.out)) return false;
    let st = null;
    try { st = fs.lstatSync(pedido); } catch (e) { if (!e || e.code !== 'ENOENT') return false; }
    return (!st || st.isFile()) && installedTree.realPath(pedido) === path.join(carpeta, path.basename(pedido));
  };
  for (const tramo of tramos(cmd)) {
    const w = palabras(tramo);
    // cada `--out` del tramo, no sólo el primero
    const destinos = [];
    w.forEach((x, i) => {
      if (x.startsWith('--out=')) destinos.push(x.slice('--out='.length));
      else if (x === '--out' && w[i + 1] != null) destinos.push(w[i + 1]);
    });
    for (const destino of destinos) {
      const opaco = /[$`]/.test(destino) || (cambiaDeCarpeta && !path.isAbsolute(destino) && !/^~/.test(destino));
      const abs = opaco ? null : resolveTarget(destino, cwd, process.platform, { homeVariable: true });
      if (opaco ? !nombraLaRevision : !enLaRevision(abs)) continue;
      if (opaco || destinos.length !== 1 || !esElCorredor(cmd, abs)) return abs || destino;
    }
  }
  return null;
}

/**
 * Las carpetas donde puede caer una ruta relativa del comando, para las constancias: las de partida y la de cada `cd` o
 * `pushd` de cualquier tramo, también adentro de un paréntesis o de `bash -c`, resuelto desde cada carpeta ya juntada
 * (`cd a && cd b` da `a/b`). No se decide cuál vale: se miran todas, y basta una que caiga en una constancia para frenar.
 * Así un `cd` adentro de un paréntesis no cambia dónde se resuelve lo de afuera, que se sigue mirando desde la de partida.
 * `sinResolver`: hubo un `cd` con una variable o una sustitución que no se puede saber adónde va.
 * `unico`: la carpeta, si todos los `cd` del comando van a la misma ruta absoluta; si alguno vuelve (`cd -`, `popd`,
 * `pushd +N`), va a otra, a una relativa (que `CDPATH` puede llevar a otro lado) o no se resuelve, es null.
 */
function carpetasDeLosCdDeConstancias(tramosDelComando, cmd, partida) {
  const carpetas = [...new Set(partida.filter(Boolean))];
  let sinResolver = false;
  const absolutos = new Set();
  let otroCd = false;
  for (const tramo of tramosDelComando) {
    // `env -C <carpeta> …` corre lo que sigue en esa carpeta
    const { carpetas: conEnv } = pelarEnv(tramo);
    const words = conEnv.length ? ['cd', ...conEnv] : palabrasEnteras(sinPalabrasDelShell(tramo)).filter((w) => w !== '');
    if (words[0] === 'builtin') words.shift();
    const programa = nombreDeComando(words[0]);
    // lo que cambia la carpeta del shell sin que se vea adónde: volver (`popd`), un guion o un texto que corre en el mismo
    // shell (`source`, `.`, `eval`), un alias, o una variable como programa (`$C /otra`, que puede ser un `cd`). Un
    // programa aparte (`bash f.sh`, `git`) no cambia la carpeta del shell que lo lanza
    if (['popd', 'source', '.', 'eval', 'alias'].includes(programa) || /[$`]/.test(String(words[0] || ''))) otroCd = true;
    if (programa !== 'cd' && programa !== 'pushd' && programa !== 'chdir') continue;
    // el primer argumento que no es una opción (`cd -P d`); `cd -` y `pushd +N` vuelven a una carpeta ya juntada
    const destino = words.slice(1).find((w) => w === '-' || !/^[-+]/.test(w));
    if (destino === '-') { otroCd = true; continue; }
    if (destino === undefined) {
      otroCd = true;
      if (!words.slice(1).some((w) => /^\+\d+$|^-\d+$/.test(w))) carpetas.push(os.homedir());
      continue;
    }
    const ex = expandirRuta(cmd, destino);
    if (ex.sinResolver.length || /\$|`/.test(String(ex.valor))) { sinResolver = true; continue; }
    if (path.isAbsolute(String(ex.valor))) absolutos.add(resolveTarget(ex.valor, '/', process.platform, { homeVariable: true }));
    else otroCd = true;
    for (const desde of [...carpetas]) {
      if (carpetas.length >= TOPE_DE_CARPETAS_DE_CD) break;
      const dir = resolveTarget(ex.valor, desde, process.platform, { homeVariable: true });
      if (!carpetas.includes(dir)) carpetas.push(dir);
    }
    // con demasiados `cd`, lo que quede afuera del tope no se sabe dónde cae
    if (carpetas.length >= TOPE_DE_CARPETAS_DE_CD) sinResolver = true;
  }
  const unico = !sinResolver && !otroCd && absolutos.size === 1 ? [...absolutos][0] : null;
  return { carpetas, sinResolver, unico };
}

// ── contenido escrito (para el freno de story-a-mano) ───────────────────────────────────────────

/**
 * Heredocs del comando: [{ body, target }] — el cuerpo (lo que stripNonCommandText descarta a
 * propósito) y el target de SU línea de apertura (`cat > f <<EOF` / `cat <<EOF > f` / `tee f <<EOF`),
 * o null si la línea no redirige a un archivo. La atribución importa: el cuerpo de un heredoc que
 * reescribe una story EXISTENTE no se le atribuye a cualquier `.md` nuevo del mismo comando.
 * Dos lecturas, sin repetir una apertura (renglón y lugar): la de siempre (`aperturasComoAntes`, uno por renglón, la
 * primera que cierra), que da lo mismo que la expresión que la buscaba desde cada separador, y la del lector de los
 * destinos (`heredocsCerrados`), que no abre en un comentario y lee uno detrás del otro los heredocs de un renglón. Un
 * `<<Z` en un comentario o en el cuerpo de otro heredoc abre uno falso en la de siempre, que se traga el de verdad: con las
 * dos, el de verdad se lee igual. Va por renglones, con los cierres en un índice.
 */
function heredocs(cmd) {
  const s = String(cmd || '');
  if (!s.includes('<<')) return [];
  const lineas = s.split('\n');
  const cierreTras = cierresDe(lineas);
  const out = [];
  const vistas = new Set();
  // el destino, una vez por renglón: los otros `<<` del renglón no son destinos, y con miles de heredocs en uno leerlo por
  // cada heredoc crece con el cuadrado
  const destinoDe = new Map();
  const sumar = (n, inicio, fin, desde, cierre) => {
    if (vistas.has(`${n}:${inicio}`)) return;
    vistas.add(`${n}:${inicio}`);
    if (!destinoDe.has(n)) {
      // el renglón que lo abre, sin el `<<` y su palabra
      const linea = lineas[n];
      const t = extractWriteTargets(`${linea.slice(0, inicio)} ${linea.slice(fin)}`);
      destinoDe.set(n, t.length === 1 ? t[0] : null);
    }
    out.push({ body: lineas.slice(desde, cierre).join('\n'), target: destinoDe.get(n) });
  };
  for (let n = 0; n < lineas.length - 1; n++) {
    for (const { inicio, fin, delimitador } of aperturasComoAntes(lineas[n])) {
      const cierre = cierreTras(delimitador, n);
      if (cierre < 0) continue;
      sumar(n, inicio, fin, n + 1, cierre);
      n = cierre;
      break;
    }
  }
  for (const h of heredocsCerrados(lineas)) sumar(h.abre, h.operador.inicio, h.operador.fin, h.desde, h.cierre);
  return out;
}
/**
 * Cada destino de escritura del comando, con su ruta absoluta: `[{ raw, abs, sinResolver: [nombres] }]`.
 * `sinResolver` lista lo que no se pudo resolver (vacía si se resolvió todo).
 */
// Lo que el shell pone y nunca trae una barra ni `..`: un número (`$$`, `$!`, `$?`, `$#`). `$RANDOM`, `$SECONDS` y los
// demás no: con `unset RANDOM` vuelven a ser variables comunes (`RANDOM=../src`)
const SIN_BARRAS = new Set(['$$', '$!', '$?', '$#']);
/** ¿Todo lo que quedó sin resolver en una ruta es de lo que nunca trae una barra? */
function sinBarras(nombres) {
  return nombres.length > 0 && nombres.every((n) => SIN_BARRAS.has(String(n)));
}

/** El mensaje del camino corto cuando un destino de escritura tiene una variable que no se pudo resolver. */
function mensajeRutaSinResolver(d, via) {
  const nombres = [...new Set(d.sinResolver)].map((n) => (String(n).startsWith('$') ? n : `$${n}`)).join(', ');
  return [
    '⛔ camino corto — NO PUDE RESOLVER LA RUTA',
    `  (detectado en ${via})`,
    `  El comando escribe en «${String(d.raw).slice(0, 120)}» y no pude saber qué vale ${nombres}: viene de afuera del`,
    '  comando, de un `$(…)`, de un bucle, o de una forma que el freno no lee. Sin la ruta real no sé si el archivo',
    '  está en la lista de este camino corto, así que frena.',
    '  Para seguir: escribí la ruta entera, o poné la variable en el mismo comando con un valor fijo',
    '  (`D=/ruta/de/la/carpeta; cat > "$D/x"`), sin `$(…)`.',
  ].join('\n') + '\n';
}

/** El mensaje del camino corto cuando un destino relativo cae en una carpeta que el freno no sigue (un `cd` adentro). */
function mensajeCarpetaSinSeguir(d, via) {
  return [
    '⛔ camino corto — NO PUDE RESOLVER LA RUTA',
    `  (detectado en ${via})`,
    `  El comando escribe en «${String(d.raw).slice(0, 120)}» después de cambiar de carpeta con un \`cd\` que el freno no`,
    '  sigue (adentro de un paréntesis, de un bucle o después de otro comando). Sin la carpeta no sé si el archivo está',
    '  en la lista de este camino corto, así que frena.',
    '  Para seguir: escribí la ruta entera, o empezá el comando con el `cd` (`cd /ruta && cp a b`).',
  ].join('\n') + '\n';
}

/** El nombre sugiere story cuando no hay contenido legible (cp / mv / tee desde un pipe). */
function nameSuggestsStory(abs) {
  const s = String(abs || '').replace(/\\/g, '/');
  return /(^|\/)story[-_.][^/]*\.md$/i.test(s) || /\/stories\/[^/]+\.md$/i.test(s);
}

/**
 * Anota dónde escribe un comando de consola, en
 * `<estado>/console-writes/<sesión>.jsonl`: una línea `{path, ts}` por destino. Lo lee
 * `scripts/metrics/run-change.js` (el arnés) al archivar la corrida, para saber en qué
 * repos buscar el cambio: sin esto, un repo que la corrida tocó sólo por consola no se mira nunca.
 * 🔴 NO va a `file-events/` ni al marcador: esos los leen los frenos de ATDD, y una escritura por consola
 *    ahí cambiaría sus veredictos. Es un registro, no un control: nunca cambia la decisión y un error al
 *    escribir no rompe nada. Apagado: TYCON_NO_RUN_CHANGE=1.
 * Si la carpeta todavía tiene el nombre en castellano, la primera anotación se lleva la vieja
 * entera (`prepareStateWrite` del puente) y el lector mira las dos mientras dure el renombre. Con un arnés anterior al
 * renombre el puente devuelve la vieja (es la que lee ese arnés). Si la migración falla, queda en hook-errors.log y la
 * anotación va a la vieja: perderla sería callar.
 */
/**
 * Lo que un `git rm` borra con permiso de la story: va a los archivos tocados de la corrida y a sus eventos (como una
 * edición por el editor, para que la vuelta siguiente de revisores lo mire), con su línea en gates.log. Se anota antes de
 * que el comando corra: si `git rm` falla, el archivo sigue y la corrida lo tiene de más, no de menos.
 */
function anotarBorradosDeLaStory({ stateDir, sessionId, marker, rutas, via }) {
  if (soloDecidir) return;
  const archivo = path.join(stateDir, 'active', `${String(sessionId || '_nosession').replace(/[/\\]/g, '_')}.json`);
  try {
    const m = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const ts = new Date().toISOString();
    m.filesTouched = Array.isArray(m.filesTouched) ? m.filesTouched : [];
    m.fileEvents = Array.isArray(m.fileEvents) ? m.fileEvents : [];
    for (const p of rutas) {
      if (!m.filesTouched.includes(p)) m.filesTouched.push(p);
      // la marca `code`, como on-edit: si la regla falla, pide otra vuelta (ante la duda, se revisa)
      let code;
      try { code = require('./reloop-code.js').pideOtraVuelta(p, { storyPath: m.storyPath }); } catch (_) { code = true; }
      m.fileEvents.push({ path: p, ts, code });
    }
    if (m.fileEvents.length > 500) m.fileEvents = m.fileEvents.slice(-500);
    // `otraVuelta`, la decisión de `next` escrita para el cartel (lib/steps.js `otraVueltaDe`)
    try {
      const v = require('./steps.js').otraVueltaDe(m);
      if (v === undefined) delete m.otraVuelta;
      else m.otraVuelta = v;
    } catch (e) { delete m.otraVuelta; logHookError(e); }   // sin el campo, el cartel usa su regla de antes
    m.lastTouch = ts;
    const tmp = `${archivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, archivo);
  } catch (e) { logHookError(e); }
  try {
    fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
      ts: new Date().toISOString(), sessionId, repoPath: marker.repoPath, name: 'ledger-visible', status: 'story-delete',
      storyId: marker.storyId || null, files: rutas.length, paths: rutas, via,
    }) + '\n', 'utf8');
  } catch (e) { logHookError(e); }
}

function anotarEscriturasConsola(stateDir, sessionId, rutas, kind = null) {
  const legacy = require('./legacy-names.js');
  const where = 'skills/tycon-pipeline/scripts/on-bash-write-gate.js';
  if (soloDecidir || !rutas.length || legacy.readEnv('TYCON_NO_RUN_CHANGE', { where }) === '1') return;
  const nueva = path.join(stateDir, 'console-writes');
  let dir;
  try { dir = legacy.prepareStateWrite(nueva, { where }); } catch (e) {
    logHookError(e);
    try { dir = legacy.legacyStatePath(nueva) || nueva; } catch (_) { dir = nueva; }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const sid = String(sessionId || 'sin-sesion').replace(/[^\w.-]/g, '_');
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), rutas.map((p) => JSON.stringify(kind ? { path: p, ts, kind } : { path: p, ts })).join('\n') + '\n', 'utf8');
  } catch (e) { logHookError(e); /* el registro no puede trabar un comando, pero no se pierde callado */ }
}

const MARKER_LEE = new Set(['get', 'list-all', 'find-by-story', 'clear-session', 'restore']);
// una variable suelta que cambia qué se corre o cómo se parte (`PATH`, `path`, `NODE_OPTIONS`, `BASH_ENV`, `IFS`)
const VARIABLE_DEL_SHELL = /path$|env$|options$|^ifs$|^(?:ld|dyld)_/i;
// El programa vale por su nombre sólo si es el del sistema: sin ruta (lo busca el PATH), en una carpeta del sistema, o
// el mismo node que corre este gancho. Un `./cat` plantado en el repo no es leer.
const CARPETAS_DEL_SISTEMA = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];
function programaDelSistema(texto) {
  const t = String(texto);
  if (!/[\\/]/.test(t)) return true;
  if (CARPETAS_DEL_SISTEMA.some((c) => t.startsWith(c))) return true;
  try { return fs.realpathSync(t) === fs.realpathSync(process.execPath); } catch { return false; }
}
function esteGuion(arg, guion, cwd) {
  if (guion !== 'marker.js' && guion !== 'pipeline.js') return false;
  // `~` entre comillas no lo expande el shell: si en la carpeta hay un `~`, no se sabe cuál corre
  if (/^~[\\/]/.test(arg) && fs.existsSync(path.join(cwd || process.cwd(), '~'))) return false;
  try {
    const dado = path.resolve(cwd || process.cwd(), arg.replace(/^~(?=[\\/])/, os.homedir()));
    return fs.realpathSync(dado) === fs.realpathSync(path.join(__dirname, '..', guion));
  } catch { return false; }
}
const gitQueLee = (w) => ['status', 'diff', 'log'].includes(w[1] && w[1].texto) && !w.some((x) => /^--output\b/.test(x.texto));
// `git add` guarda el guion que nombra, no lo corre (no vale para decir que el comando sólo lee)
const gitQueNombra = (w) => gitQueLee(w) || (w[1] && w[1].texto) === 'add';

/**
 * ¿Este `sed` sólo lee? El de GNU corre lo que le pide `e`, también sobre las líneas del archivo (`sed e ./x`), y lee las
 * opciones en cualquier lugar: vale un guion a la vista y sin efectos, y detrás sólo archivos escritos tal cual.
 */
function sedQueLee(w) {
  let i = 1;
  while (w[i] && /^-[nEr]+$/.test(w[i].texto)) i++;
  const resto = w.slice(i + 1);
  return !!w[i] && w[i].literal && !w[i].texto.startsWith('-') && guionDeSedSinEfectos(w[i].texto)
    && resto.every((x) => x.literal && !x.texto.startsWith('-'));
}

// ── la carpeta de una ejecución abierta no se borra ni se mueve: primero se cierra la ejecución (@story-8.318) ────────

/**
 * Lo que el comando borra o mueve, para buscar adentro una ejecución abierta: `{ rutas: [{ raw, base? }], prune: [base] }`.
 * Los borrados de un programa que borra (`rm -r`, `Remove-Item`, `rd`, `del`; no los de `git rm|checkout|restore`, que sólo
 * tocan lo versionado, ni `find -delete`, que borra por nombre), los orígenes de `mv`, `Move-Item` y `Rename-Item`,
 * también detrás de `cmd /c`, y la carpeta de `git worktree remove|move`. `prune` trae la carpeta desde la que corre cada
 * `git worktree prune` (la de `-C`, o null para la del comando).
 */
// las palabras de control del shell y los envoltorios que corren otro comando (@story-8.318)
// `time` va con los envoltorios: lleva opciones (`time -p`)
const CONTROL = new Set(['if', 'while', 'until', 'then', 'do', 'else', 'elif', '!', '{', '(']);
const ENVOLTORIOS = new Set(['sudo', 'doas', 'setsid', 'ionice', 'nice', 'env', 'command', 'exec', 'time', 'timeout', 'nohup', 'stdbuf', 'chrt', 'taskset']);

// El despachador (`handle`) lee dos veces cada comando y cambia estas tres entre una lectura y la otra. Lo que carga de
// una parte es una copia de su valor: las cambia y las lee por acá
function modoDeLectura(cambios = {}) {
  if ('leerComentarios' in cambios) leerComentarios = cambios.leerComentarios;
  if ('apagoAlgo' in cambios) apagoAlgo = cambios.apagoAlgo;
  if ('soloDecidir' in cambios) soloDecidir = cambios.soloDecidir;
  return { leerComentarios, apagoAlgo, soloDecidir };
}

module.exports = { desdeElPrograma, programaEntre, stripNonCommandText, ANTES_DEL_CD_COMPLEJO, extractWriteTargets, destinosPorElPartidor, HONDO_DE_SUSTITUCIONES, tramosDelShell, destinosDeEscritura, scriptsInline, opcionesDelInterprete, sinContinuaciones, escritosDelGuion, destinosArmados, aperturasDeHeredoc, aperturasComoAntes, delimitadoresQueAbre, heredocsCerrados, quitarCuerposDeHeredoc, conComentariosApagados, tramos, palabrasProfundas, carpetasDeLosCd, origenesMovidos, salidaAjenaALaRevision, carpetasDeLosCdDeConstancias, heredocs, SIN_BARRAS, sinBarras, mensajeRutaSinResolver, mensajeCarpetaSinSeguir, nameSuggestsStory, anotarBorradosDeLaStory, anotarEscriturasConsola, MARKER_LEE, VARIABLE_DEL_SHELL, CARPETAS_DEL_SISTEMA, programaDelSistema, esteGuion, gitQueLee, gitQueNombra, sedQueLee, CONTROL, ENVOLTORIOS, modoDeLectura };
