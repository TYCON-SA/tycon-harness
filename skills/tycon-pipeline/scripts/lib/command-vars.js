'use strict';
/**
 * command-vars.js — expandir `$VAR` / `${VAR}` en una ruta como lo haría el shell en ESE punto del comando, o decir que
 * no se puede (story 7.25 del arnés, 2026-10-15).
 *
 * Lo usa la puerta de la consola (`on-bash-write-gate.js`) para saber adónde escribe un comando antes de decidir si es
 * código del repo de la corrida. Caso de un producto del equipo (2026-10-14): `SP=<scratchpad>; python3 -c
 * "open('$SP/x.cs','w')"` salió frenado como «EDICIÓN INVISIBLE» porque el destino se armó sin expandir, `<repo>/$SP/x.cs`.
 *
 * 🔴 Por qué no el lector compartido del arnés (`scripts/lib/shell-parse.js`), que fue la primera versión: está hecho para
 * el freno de sesiones y el registro de retrospectivas, que sólo miran lo que el comando define; acá eso daba resultados
 * FALSOS, no sólo incompletos (pase adversarial de la 7.25, 11 hallazgos confirmados):
 *   · guarda sólo la ÚLTIMA asignación: `SP=/tmp/a; … > $SP/1.cs; SP=<repo>/src; … > $SP/2.cs` mandaba los dos a `/tmp/a`;
 *   · toma `$(mktemp -d)` como texto: el destino quedaba `<repo>/$(mktemp/x.cs`, frenado y SIN el aviso de «no resuelta»;
 *   · no mira el ambiente: `D=$HOME/x` quedaba sin resolver y frenaba una escritura fuera del repo;
 *   · y con la asignación sin resolver se caía al valor del ambiente de la MISMA variable, que es otro valor.
 * Y la vuelta 2 de revisores (seguridad) encontró que un lector por regex contaba como asignación lo que no lo es:
 * texto entre comillas o en el cuerpo de un heredoc, un `VAR=x cmd` (vale sólo para ese comando), o una asignación que
 * puede no haber pasado (en un subshell, después de `||`, dentro de un `if`/`for`/`while`).
 *
 * Y la vuelta 3 (seguridad) encontró más formas: `cond && SP=…`, `… | SP=…`, `SP=… &`, un cuerpo de función, comillas
 * escapadas, comentarios, y entradas armadas para colgarlo o hacerlo tirar (un error adentro del freno es un freno
 * apagado: el hook falla abierto). Desde ahí el lector es CONSERVADOR: cuenta sólo lo que seguro quedó puesto y ante
 * cualquier forma que no lee del todo dice «no sé» — que frena avisando, nunca deja pasar.
 *
 * Reglas (las mismas que el shell, y «no sé» donde no se puede saber sin ejecutar):
 *   · cuenta la asignación SUELTA al principio de una sentencia (`VAR=…`, `export VAR=…`), fuera de comillas y de
 *     heredocs; vale desde ahí en adelante;
 *   · una asignación que puede no haber quedado puesta (subshell, después de `||` o de `&&`, al lado de un caño `|`,
 *     en segundo plano `&`, dentro de un bloque `if`/`for`/`while`/`until`/`case`, en un cuerpo de función, o de
 *     prefijo de otro comando) deja la variable en «no sé»;
 *   · un comando con comillas escapadas, comentarios `#` o comillas sin cerrar no se lee: todas sus asignaciones son
 *     «no sé» (la variable no cae al ambiente);
 *   · si el comando no la asignó antes de ese punto, vale el ambiente (`HOME` es la carpeta de la persona);
 *   · una asignación con `$(…)` o comillas invertidas, o que usa algo que no se sabe, también es «no sé» — y «no sé»
 *     NO cae al ambiente;
 *   · `${VAR:-x}`, `${VAR%…}` y demás formas con operador: «no sé» (no se interpretan);
 *   · `$(…)` o comillas invertidas en la ruta misma: «no sé»;
 *   · si el texto del destino aparece varias veces y en cada lugar daría otra ruta: «no sé».
 * Quien llama decide qué hacer con «no sé»; la puerta de la consola lo resuelve del lado seguro y lo dice en el mensaje.
 */

const os = require('os');

const NO_SE = Symbol('no-se');
const BLOQUE_ABRE = new Set(['if', 'while', 'until', 'for', 'case', 'select']);
const BLOQUE_CIERRA = new Set(['fi', 'done', 'esac']);

function sinComillas(v) {
  const s = String(v);
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) return s.slice(1, -1);
  return s;
}

/**
 * El comando con el cuerpo de cada heredoc en blanco (mismas posiciones; los saltos de línea quedan). Recorrido por
 * líneas, lineal: con muchas aperturas sin cierre una regex con `[\s\S]*?` es cuadrática (vuelta 3). Un heredoc sin
 * cierre deja en blanco el resto del comando: lo que sigue es su cuerpo.
 */
function analizarHeredocs(cmd) {
  const lineas = String(cmd || '').split('\n');
  const pendientes = [];          // delimitadores de los heredocs abiertos, en orden
  for (let i = 0; i < lineas.length; i++) {
    if (pendientes.length) {
      if (lineas[i].trim() === pendientes[0]) pendientes.shift();
      else lineas[i] = ' '.repeat(lineas[i].length);
      continue;
    }
    const re = /<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\1/g;
    let m;
    while ((m = re.exec(lineas[i]))) pendientes.push(m[2]);
  }
  // un heredoc sin cierre (o un `<<` que no era uno: entre comillas, `<<<`) deja el resto en blanco: «no sé» (vuelta 4)
  return { texto: lineas.join('\n'), sinCierre: pendientes.length > 0 };
}
function sinCuerposDeHeredoc(cmd) { return analizarHeredocs(cmd).texto; }

/** ¿El comando tiene algo que este lector no sabe leer del todo? (comillas escapadas, comentarios, comillas sin cerrar) */
function ilegible(s) {
  if (/\\["'`]/.test(s)) return true;
  // un `#` que abre comentario: al principio o después de un espacio/separador, fuera de comillas
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) return true;
  }
  return q !== null;
}

// Lo que cambia una variable sin la forma `VAR=…` que este lector entiende, o lo que no sabe leer (vuelta 4 de revisores:
// imitar al shell no converge, así que la lista es cerrada y todo lo demás es «no sé»).
// 🔴 Sólo `[ \t]` entre piezas, nunca `\s*`: sobre el cuerpo de un heredoc en blanco (miles de líneas de espacios) un
// `\s*` que cruza saltos de línea vuelve cuadrática la búsqueda (medido: 11 s con 20000 líneas).
const ORDENES_QUE_ASIGNAN = /(^|[\s;&|(){}])(declare|typeset|local|readonly|export[ \t]+-|eval|read|readarray|mapfile|printf[ \t]+-v|source|unset|let|getopts)(?=[\s;]|$)/;
const PUNTO_COMO_SOURCE = /(^|[;&|(){}\n])[ \t]*\.[ \t]+\S/;

/**
 * El comando con lo que está ADENTRO de comillas en blanco (las comillas quedan). Las reglas de forma se miran sobre
 * esto: un `f.close()` dentro de un `python3 -c "…"` no es una función de shell (vuelta 5 — el caso original de la story
 * escribe así, y la regla de funciones lo frenaba).
 */
function fueraDeComillas(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { q = null; out += c; } else out += c === '\n' ? '\n' : ' '; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c;
  }
  return out;
}

/** ¿El lector no puede decir nada seguro de las variables de este comando? */
function noSeLee(s, sinCierre = false) {
  if (sinCierre || ilegible(s)) return true;
  // sobre el texto CRUDO: estas dos asignan en el shell actual aunque vayan entre comillas dobles (vuelta 6)
  if (/\$\(\(/.test(s) || /\$\{[A-Za-z_][A-Za-z0-9_]*:?=/.test(s)) return true;
  const f = fueraDeComillas(s);
  return /<<</.test(f)                                   // here-string
    || /\$\(\(/.test(f)                                   // aritmética
    || /(^|[\s;&|(])[{}](?=\s|;|$)/.test(f)              // llaves: bloque o cuerpo de función
    || /\b[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\)/.test(f) // definición de función
    || /(^|[\s;&|(])function\s+[A-Za-z_]/.test(f)
    || /(^|[\s;&|(])(for|select|case)\s/.test(f)        // bucles y case reasignan (vuelta 5)
    || /(^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*\+=/.test(f)   // VAR+=…
    || ORDENES_QUE_ASIGNAN.test(f)
    || PUNTO_COMO_SOURCE.test(f);
}

/**
 * Las asignaciones que el shell deja puestas, en orden: `[{ nombre, valor, pos, cierta }]`.
 * `cierta: false` = puede no haber quedado puesta (la variable pasa a «no sé» desde ahí). Una pasada, lineal.
 */
function asignaciones(cmd) {
  const s = sinCuerposDeHeredoc(cmd);
  const out = [];
  // Un comando que no se lee del todo o que define una función: ninguna de sus asignaciones es segura (y expandirRuta
  // ni siquiera mira el ambiente: una función puede cambiar la variable cuando se la llama).
  const todasInciertas = noSeLee(s);
  let i = 0;
  let subshell = 0;          // ( … ) que no es $( … )
  let bloque = 0;            // if/for/while/until/case … fi/done/esac
  let trasIncierto = false;  // la sentencia arranca después de ||, &&, | o & (puede no correr, o corre en un subshell)
  let inicio = true;         // estamos al principio de una sentencia
  const n = s.length;
  const esSeparador = (c) => c === ';' || c === '&' || c === '|' || c === '\n';
  while (i < n) {
    const c = s[i];
    if (inicio) {
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '(') { subshell++; i++; continue; }
      if (c === '{') { i++; continue; }
      // palabra de bloque o `export`
      const palabra = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i, i + 64));
      if (palabra && !/^=/.test(s.slice(i + palabra[0].length, i + palabra[0].length + 1))) {
        const w = palabra[0];
        if (BLOQUE_ABRE.has(w)) bloque++;
        if (BLOQUE_CIERRA.has(w)) bloque = Math.max(0, bloque - 1);
        if (w === 'then' || w === 'else' || w === 'elif' || w === 'do' || w === 'export') { i += w.length; continue; }
      }
      // un grupo de asignaciones al principio: A=1 B=2 [cmd]
      const grupo = [];
      let j = i;
      for (;;) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(s.slice(j, j + 256));
        if (!m) break;
        let k = j + m[0].length;
        let q = null;
        let prof = 0;
        for (; k < n; k++) {
          const ch = s[k];
          if (q) { if (ch === q) q = null; continue; }
          if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
          if (ch === '$' && s[k + 1] === '(') { prof++; k++; continue; }
          if (ch === ')' && prof > 0) { prof--; continue; }
          if (prof === 0 && /[\s;&|)]/.test(ch)) break;
        }
        grupo.push({ nombre: m[1], valor: s.slice(j + m[0].length, k), pos: j });
        j = k;
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
      }
      inicio = false;
      if (grupo.length) {
        // ¿sigue un comando en la misma sentencia? entonces era un prefijo: vale sólo para ese comando
        const prefijo = j < n && !esSeparador(s[j]) && s[j] !== ')';
        // ¿termina en `&` (segundo plano) o en `|` (caño)? las dos corren en un subshell
        const enSubshell = (s[j] === '&' && s[j + 1] !== '&') || (s[j] === '|' && s[j + 1] !== '|');
        const cierta = !todasInciertas && !prefijo && !enSubshell && subshell === 0 && bloque === 0 && !trasIncierto;
        for (const a of grupo) out.push({ ...a, cierta });
        i = j;
        continue;
      }
      continue;
    }
    // dentro de una sentencia: comillas, subshells y separadores
    if (c === "'" || c === '"' || c === '`') {
      const fin = s.indexOf(c, i + 1);
      i = fin < 0 ? n : fin + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let prof = 1;
      let k = i + 2;
      for (; k < n && prof > 0; k++) { if (s[k] === '(') prof++; else if (s[k] === ')') prof--; }
      i = k;
      continue;
    }
    if (c === ')') { subshell = Math.max(0, subshell - 1); i++; continue; }
    if ((c === '|' && s[i + 1] === '|') || (c === '&' && s[i + 1] === '&')) { trasIncierto = true; inicio = true; i += 2; continue; }
    if (c === '|' || c === '&') { trasIncierto = true; inicio = true; i++; continue; }   // caño o segundo plano
    if (esSeparador(c)) { trasIncierto = false; inicio = true; i++; continue; }          // `;` o salto de línea
    if (c === '(') { subshell++; i++; continue; }
    i++;
  }
  return out;
}

/**
 * Expande el texto `t` con lo que valían las variables en `pos` del comando.
 * @returns {{ valor: string|null, sinResolver: string[] }} `valor` null si algo no se pudo saber.
 */
// Tope de variables encadenadas (`A2=$A1; A1=$A0; …`): más allá, «no sé». Sin tope, una cadena larga desbordaba la pila,
// el hook tiraba y el freno quedaba apagado (vuelta 3 de revisores).
const MAX_PROFUNDIDAD = 32;
// Variables que mantiene el shell de la sesión (cambian con cada `cd` o cada vez que se leen): el ambiente del proceso
// del freno no las sabe (vuelta 4: `cat > $PWD/src/x.cs` se resolvía contra la carpeta del hook).
const DEL_SHELL = new Set(['PWD', 'OLDPWD', 'RANDOM', 'SECONDS', 'LINENO', 'PPID', 'BASHPID', 'DIRSTACK', 'PIPESTATUS', 'REPLY', 'OPTARG', 'OPTIND']);

/** ¿La posición `pos` del comando cae adentro de unas comillas simples del shell? (adentro de "…", una ' es literal) */
function enComillasSimples(s, pos) {
  let q = null;
  for (let i = 0; i < pos && i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
  }
  return q === "'";
}

function expandirEn(t, pos, asigs, env, home, prof = 0) {
  // `$(…)`, comillas invertidas, el tope de profundidad, y las variables posicionales o especiales (`$1`, `${1}`, `$@`,
  // `$$`, `$?`…, vuelta 5): «no sé»
  const especial = /\$(\{)?([0-9@*#?$!-])/.exec(String(t));
  if (especial) return { valor: null, sinResolver: [`$${especial[2]}`] };
  if (/\$\(|`/.test(t) || prof > MAX_PROFUNDIDAD) {
    const nombres = [...String(t).matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]);
    return { valor: null, sinResolver: nombres.length ? nombres : ['$(…)'] };
  }
  const sinResolver = [];
  const valorDe = (nombre) => {
    let a = null;
    for (const x of asigs) { if (x.nombre === nombre && x.pos < pos) a = x; }
    if (a) {
      if (a.resuelto === undefined) {
        if (!a.cierta) a.resuelto = NO_SE;
        else {
          const crudo = String(a.valor);
          if (/^'[\s\S]*'$/.test(crudo)) {
            // entre comillas simples el shell no expande nada: el valor es literal. Si trae un `$`, la ruta final tendría
            // un `$` de verdad y otra pieza (resolveTarget) lo expandiría: «no sé» (vuelta 4).
            const literal = crudo.slice(1, -1);
            a.resuelto = /\$/.test(literal) ? NO_SE : literal;
          } else {
            const r = expandirEn(sinComillas(crudo), a.pos, asigs, env, home, prof + 1);
            a.resuelto = r.valor === null ? NO_SE : r.valor;
          }
        }
      }
      return a.resuelto;
    }
    if (nombre === 'HOME') return home;
    if (DEL_SHELL.has(nombre)) return NO_SE;   // las mantiene el shell, no el ambiente del freno
    return Object.prototype.hasOwnProperty.call(env, nombre) ? env[nombre] : NO_SE;
  };
  const valor = String(t).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, llave, operador, suelta) => {
    const nombre = llave || suelta;
    if (llave && operador) { sinResolver.push(nombre); return m; }   // ${VAR:-x}, ${VAR%…}: no se interpreta
    const v = valorDe(nombre);
    if (v === NO_SE) { sinResolver.push(nombre); return m; }
    return v;
  });
  return { valor: sinResolver.length ? null : valor, sinResolver };
}

/**
 * La ruta `raw`, que aparece en `cmd`, con sus variables expandidas como en ese punto del comando.
 * @param {object} [opts] env (default process.env) · home (default os.homedir())
 * @returns {{ valor: string, sinResolver: string[] }} `valor` es la ruta expandida, o `raw` tal cual si algo no se supo.
 */
function expandirRuta(cmd, raw, opts = {}) {
  if (!/[$`]/.test(String(raw))) return { valor: raw, sinResolver: [] };
  // Nunca tira: un error acá apagaría el freno (el hook falla abierto). Ante un error, «no sé», que frena avisando.
  const todas = () => {
    const nombres = [...new Set([...String(raw).matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]))];
    return { valor: raw, sinResolver: nombres.length ? nombres : ['$(…)'] };
  };
  try {
    const h = analizarHeredocs(cmd);
    if (noSeLee(h.texto, h.sinCierre)) return todas();
    const r = expandirRutaSinRed(cmd, raw, opts);
    // un destino escrito entre comillas simples (a nivel del shell) es literal: no se expande nada
    if (!r.sinResolver.length && posicionesDe(h.texto, raw).some((p) => p < h.texto.length && enComillasSimples(h.texto, p))) return todas();
    return r;
  } catch { return todas(); }
}

function posicionesDe(s, raw) {
  const out = [];
  for (let p = s.indexOf(raw); p >= 0; p = s.indexOf(raw, p + 1)) out.push(p);
  return out;
}

function expandirRutaSinRed(cmd, raw, opts) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const asigs = asignaciones(cmd);
  // Todos los lugares donde aparece el texto del destino (fuera de los cuerpos de heredoc); si no aparece, el final.
  const s = sinCuerposDeHeredoc(cmd);
  const posiciones = [];
  for (let p = s.indexOf(raw); p >= 0; p = s.indexOf(raw, p + 1)) posiciones.push(p);
  if (!posiciones.length) posiciones.push(s.length);
  const resultados = posiciones.map((p) => expandirEn(raw, p, asigs, env, home));
  const nombres = [...String(raw).matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((x) => x[1]);
  const fallidos = resultados.filter((r) => r.valor === null);
  if (fallidos.length) return { valor: raw, sinResolver: [...new Set(fallidos.flatMap((r) => r.sinResolver))] };
  // el mismo texto daría rutas distintas según dónde se lo mire: no se sabe cuál es la escritura
  if (new Set(resultados.map((r) => r.valor)).size > 1) return { valor: raw, sinResolver: [...new Set(nombres)] };
  return { valor: resultados[0].valor, sinResolver: [] };
}

module.exports = { asignaciones, expandirRuta };
