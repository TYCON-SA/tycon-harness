'use strict';
/**
 * Las formas de comando que hacen que Claude Code pida permiso aun en modo sin permisos: su chequeo de borrados
 * peligrosos frena un `rm` cuyo destino no puede resolver antes de correr el comando, y sólo una persona lo aprueba. En
 * una sesión de fondo nadie contesta ese pedido: la sesión queda trabada y no lee mensajes mientras tanto.
 *
 * Medido en sesiones de fondo reales (claude --bg, sin permisos, sin ganchos) y en lo que el chequeo frenó en las
 * transcripciones de la máquina. Frena:
 *   · sustitucion: el destino es la salida de un `$(...)` o de comillas invertidas, o una variable armada con una
 *   · variable-con-comodin: el destino tiene una variable y un comodín (`$S/*.log`)
 *   · bash-c-armado: un `bash -c` (o `sh -c`, `zsh -c`) con un guion que no es literal, en un comando que borra
 *   · comodin-fuera-de-temporal: un comodín en una ruta literal y absoluta que no es una carpeta temporal del sistema
 * Pasan sin pedir y no se tocan: una variable armada con un valor literal (`H=/x; rm -rf $H`), una ruta literal, una
 * relativa, un `for` sobre rutas literales, un comodín dentro del TMPDIR del sistema y un `bash -c` con un guion literal.
 *
 * Se lee el texto crudo de cada `rm` (hasta el próximo `;`, `&`, `|` o fin de línea fuera de comillas y de `$(...)`):
 * partido en palabras se pierden las comillas y un `$(...)` sin comillas queda en otro pedazo.
 */
const os = require('os');
const path = require('path');

const COMODIN = /[*?[]/;

const FORMAS = {
  sustitucion: 'el destino de un `rm` sale de un `$(...)` (o de una variable armada con uno): Claude Code no lo puede revisar antes de correrlo',
  'variable-con-comodin': 'el destino de un `rm` tiene una variable y un comodín: Claude Code no sabe qué borra si la variable queda vacía',
  'bash-c-armado': 'un `bash -c` con un guion armado en un comando que borra: Claude Code no puede revisar qué borra el guion',
  'comodin-fuera-de-temporal': 'un `rm` con comodín fuera de una carpeta temporal del sistema',
};

// donde empieza un comando: el principio, un separador, o una palabra que va delante del programa
const INICIO = /(?:^|[;&|\n({]|\b(?:do|then|else|sudo|nice|nohup|command|exec|time|builtin|xargs)\s)\s*/;
const RM = new RegExp(`${INICIO.source}(?:\\\\|/bin/|/usr/bin/)?rm(?=\\s)`, 'g');
const SHELL_C = new RegExp(`${INICIO.source}(?:/bin/|/usr/bin/)?(?:bash|sh|zsh|dash)\\s+(?:-[a-zA-Z]+\\s+)*-c\\s+`, 'g');

/** Desde `i`, hasta el próximo separador de comandos fuera de comillas y de `$(...)`/comillas invertidas. */
function hastaElSeparador(s, i) {
  let q = null;
  let prof = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === '\\' && q === '"') { j++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '\\') { j++; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
    if (c === '$' && s[j + 1] === '(') { prof++; j++; continue; }
    if (c === ')' && prof > 0) { prof--; continue; }
    if (prof === 0 && (c === ';' || c === '&' || c === '|' || c === '\n')) break;
  }
  return s.slice(i, j);
}

/** Las palabras crudas de un texto, con sus comillas: `a "b c" $(d e)` → `a`, `"b c"`, `$(d e)`. */
function palabrasCrudas(t) {
  const out = [];
  let cur = '';
  let q = null;
  let prof = 0;
  for (let j = 0; j < t.length; j++) {
    const c = t[j];
    if (q) { cur += c; if (c === '\\' && q === '"' && j + 1 < t.length) cur += t[++j]; else if (c === q) q = null; continue; }
    if (c === '\\' && j + 1 < t.length) { cur += c + t[++j]; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '$' && t[j + 1] === '(') { prof++; cur += '$('; j++; continue; }
    if (c === ')' && prof > 0) { prof--; cur += c; continue; }
    if (/\s/.test(c) && prof === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Una palabra cruda sin comillas, para leer su ruta: `'a b'` → `a b`, `"$X"/y` → `$X/y`. */
const sinComillas = (w) => w.replace(/'([^']*)'/g, '$1').replace(/"((?:[^"\\]|\\.)*)"/g, '$1');

/** Las carpetas temporales del sistema, con y sin `/private` delante (en Mac son la misma). */
function temporales(tmpdir) {
  const base = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  if (tmpdir) base.push(path.resolve(tmpdir));
  return base;
}
const dentroDe = (p, dirs) => dirs.some((d) => p === d || p.startsWith(`${d.replace(/\/+$/, '')}/`));

/**
 * La forma que hará pedir permiso, o null: `{ forma, que }`. Sólo mira los `rm` del comando y los `bash -c`; un comando
 * que no borra nunca da una forma. Nunca lanza: un comando que no se puede leer da null (no se frena lo que no se sabe).
 */
function formaQuePidePermiso(cmd, { tmpdir = os.tmpdir() } = {}) {
  try {
    // el cuerpo de un heredoc es texto que se le pasa a un programa, no un comando: se saca antes de mirar
    const texto = String(cmd || '').replace(/<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (m) => m.slice(0, m.indexOf('\n')));
    if (!/\brm\b/.test(texto)) return null;
    // las variables armadas con una sustitución: su valor no se conoce antes de correr
    const deSustitucion = new Set();
    for (const m of texto.matchAll(/(?:^|[\s;&|\n(])(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?[^\s;&|]*?(?:\$\(|`)/g)) deSustitucion.add(m[1]);
    const usaDeSustitucion = (a) => [...a.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some((x) => deSustitucion.has(x[1]));
    let hayRm = false;
    for (const m of texto.matchAll(RM)) {
      hayRm = true;
      const args = palabrasCrudas(hastaElSeparador(texto, m.index + m[0].length));
      let opciones = true;
      for (const crudo of args) {
        if (opciones && crudo === '--') { opciones = false; continue; }
        if (opciones && crudo.startsWith('-')) continue;
        // lo que va entre comillas simples es literal: ni variables ni sustituciones
        const vivo = crudo.replace(/'[^']*'/g, '');
        if (vivo.includes('$(') || vivo.includes('`') || usaDeSustitucion(vivo)) return { forma: 'sustitucion', que: FORMAS.sustitucion };
        const ruta = sinComillas(crudo);
        // un comodín sólo vale fuera de comillas
        const comodin = COMODIN.test(crudo.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ''));
        if (vivo.includes('$') && comodin) return { forma: 'variable-con-comodin', que: FORMAS['variable-con-comodin'] };
        if (!vivo.includes('$') && comodin && path.isAbsolute(ruta.replace(/^~(?=\/|$)/, os.homedir()))) {
          if (!dentroDe(path.resolve(ruta.replace(/^~(?=\/|$)/, os.homedir())), temporales(tmpdir))) return { forma: 'comodin-fuera-de-temporal', que: FORMAS['comodin-fuera-de-temporal'] };
        }
      }
    }
    if (!hayRm) return null;
    for (const m of texto.matchAll(SHELL_C)) {
      const guion = palabrasCrudas(hastaElSeparador(texto, m.index + m[0].length))[0] || '';
      // un guion entre comillas simples es literal; uno entre dobles o sin comillas, con `$` o comillas invertidas, no
      if (!guion.startsWith('\'') && /[$`]/.test(guion)) return { forma: 'bash-c-armado', que: FORMAS['bash-c-armado'] };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** El texto de la negativa: qué lo frenaría y cómo reescribirlo para que pase solo. */
function textoDeLaNegativa(f) {
  return `Esta sesión corre de fondo y este comando haría que Claude Code pida permiso a una persona: ${f.que}. `
    + 'Nadie lo contesta en una sesión de fondo, y mientras espera la sesión no lee mensajes. Reescribilo antes de '
    + 'correrlo: un `rm` por llamada, con la ruta literal y absoluta de lo que borrás (sin `$(...)`, sin variables con '
    + 'comodines y fuera de un `bash -c`), o no borres: lo que dejaste en el TMPDIR del sistema lo limpia la máquina. '
    + 'Las salidas, en el TMPDIR del sistema. El resto del comando, en llamadas aparte.';
}

module.exports = { FORMAS, formaQuePidePermiso, textoDeLaNegativa };
