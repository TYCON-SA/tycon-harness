'use strict';
/**
 * bash-gate-blocks.js — lo que corre sin `;` detrás de la cabecera de un bloque y lo que corta una sustitución, para el
 * freno de escrituras por consola (A217, A218).
 *
 * `puntosDeOtrasCabeceras` dice dónde un bloque corre lo de después sin `;` (`if (true) then cp …`, `for x do …`, las
 * formas cortas de zsh), para las lecturas de `variantesConSeparador` (bash-gate-words.js). `tramosConSustituciones`
 * parte el comando sin cortar adentro de un `$(…)` (`rm $(: # x⏎) h.md`), para quien lee lo que se borra.
 */

// detrás del cierre de una condición, lo que no es un comando: un separador, un cierre o un comentario (una redirección
// sí puede ir delante del comando: `case a in (a) >/dev/null cp …`)
const NO_ES_UN_COMANDO = /^(?:[;\n|)}#]|&(?!>))/;

/**
 * Los otros sitios donde un bloque corre lo de después sin `;` (A218), en `puntos` con la forma de `puntosDeSeparador`:
 * detrás del `)` de un `( … )` que abre donde va un comando (`if (true) then cp …`, `while (true) do …`, en zsh
 * `if (true) cp …`, `for x (a) cp …`, `foreach x (a) cp …`) o que cierra un patrón de `case` (`a) cp …`), del `}` de un
 * grupo (`if { true; } then cp …`), del `]]` de una prueba (`if [[ 1 ]] then cp …`), de un `fi`, `esac` o `done` que es
 * la condición de otro bloque, del nombre de un `for`/`select`/`foreach` seguido de `do` o `{` (`for x do cp …`) y de la
 * cuenta de un `repeat` de zsh (`repeat 1 cp …`). Un `(` pegado a otra cosa (`$(`, `<(`, `=(`, `*(`, `f()`, el segundo
 * de `$((`) no abre un grupo. Los paréntesis se emparejan dos veces: en todo el texto (lo de un `"$(…)"` corre) y sólo
 * en el texto de comando (un `(` citado no se empareja con el `)` de verdad). Como en el `for ((`, lo citado sigue siendo
 * texto para quien lo lee, y un señuelo que corta argumentos se ve en la lectura de tal cual o en la de su punto solo.
 */
// el cuerpo de un heredoc, como lo lee `posicionesDeComando` (bash-gate-words.js)
const HEREDOC = /(?<!<)<<(?!<)-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n((?:[\s\S]*?\n)??)[ \t]*\2[ \t]*(?=\n|$)/g;

/** Qué posiciones de `t` son el cuerpo de un heredoc (1) y cuáles no (0). */
function cuerposDeHeredoc(t) {
  const en = new Uint8Array(t.length);
  if (!t.includes('<<')) return en;
  for (const m of t.matchAll(HEREDOC)) en.fill(1, m.index + m[0].indexOf('\n') + 1, m.index + m[0].length);
  return en;
}

function puntosDeOtrasCabeceras(t, puntos, es) {
  // (el cuerpo de un heredoc es texto: un guion que se escribe a un archivo no corre)
  const cuerpo = cuerposDeHeredoc(t);
  const poner = (fin) => {
    if (cuerpo[fin]) return;
    let k = fin + 1;
    while (t[k] === ' ' || t[k] === '\t') k++;
    if (k >= t.length || NO_ES_UN_COMANDO.test(t.slice(k, k + 2))) return;
    if (!puntos.has(fin + 1)) puntos.set(fin + 1, k > fin + 1);
  };
  if (t.includes(')')) {
    // (cada `(` con su `)`, en una pasada: buscar el cierre de cada uno recorrería el resto una vez por paréntesis)
    for (const soloComando of [false, true]) {
      const abiertos = [];
      for (let j = 0; j < t.length; j++) {
        if (t[j] === '\\') { j++; continue; }
        if (soloComando && !es[j]) continue;
        if (t[j] === '(') abiertos.push(j);
        else if (t[j] === ')') {
          // sin `(` que cierre: el de un patrón de `case`
          if (!abiertos.length) { poner(j); continue; }
          const p = abiertos.pop();
          if (abreUnGrupo(t, p)) poner(j);
        }
      }
    }
  }
  for (const m of t.matchAll(/(?:^|[;\n&)])[ \t]*\}/g)) poner(m.index + m[0].length - 1);
  for (const m of t.matchAll(/(?<=\s)\]\]/g)) poner(m.index + 1);
  for (const m of t.matchAll(/(?<=[\s;&|)])(?:fi|esac|done)(?=[ \t]+(?:then|do|else|elif)(?![\w-]))/g)) poner(m.index + m[0].length - 1);
  for (const m of t.matchAll(/(?<![\w$.-])(?:for|select|foreach)(?:[ \t]+[A-Za-z_]\w*)+(?=[ \t]+(?:do(?![\w-])|\{))/g)) {
    if (vaUnComando(t, m.index)) poner(m.index + m[0].length - 1);
  }
  for (const m of t.matchAll(/(?<![\w$.-])repeat[ \t]+(?:"[^"]*"|'[^']*'|\$\([^()]*\)|[^\s;&|()<>"'])+/g)) {
    if (vaUnComando(t, m.index)) poner(m.index + m[0].length - 1);
  }
}

// las palabras de bloque detrás de las que va un comando (y el `in` de un `case x in (a) …`), y los nombres de un
// `for x y (…)` de zsh
const DETRAS_VA_UN_COMANDO = /(?:^|[\s;&|(){}!`])(?:if|elif|while|until|then|do|else|time|in)$/;
const NOMBRE_DE_FOR = /(?:^|[\s;&|(){}!`])(?:for|foreach|select)(?:[ \t]+[A-Za-z_]\w*)+$/;

/**
 * ¿`t[p]` va donde el shell espera un comando? Al principio, detrás de un separador, `(`, `)` (el cuerpo de un `f()` o
 * de un brazo de `case`), `{`, `!`, `` ` `` o de una palabra de bloque.
 */
function vaUnComando(t, p) {
  let k = p;
  while (k > 0 && (t[k - 1] === ' ' || t[k - 1] === '\t')) k--;
  if (k === 0) return true;
  // (también detrás de una comilla: el texto de un `sh -c '…'` empieza con un comando)
  if (/[;&|\n(){!`'"]/.test(t[k - 1])) return true;
  return DETRAS_VA_UN_COMANDO.test(t.slice(Math.max(0, k - 6), k));
}

/**
 * ¿El `(` de `t[p]` abre un grupo (un subshell, la lista de un `for x (…)` de zsh) y no algo pegado (`$(`, `<(`, `f()`,
 * el segundo de `$((`)? Pegado a una palabra de bloque sí (`if(true)`).
 */
function abreUnGrupo(t, p) {
  const a = p > 0 ? t[p - 1] : '';
  if (a !== '' && !/[\s;&|({!`]/.test(a)) return DETRAS_VA_UN_COMANDO.test(t.slice(Math.max(0, p - 6), p));
  if (a === '(' && t[p - 2] === '$') return false;
  if (vaUnComando(t, p)) return true;
  let k = p;
  while (k > 0 && (t[k - 1] === ' ' || t[k - 1] === '\t')) k--;
  return NOMBRE_DE_FOR.test(t.slice(Math.max(0, k - 80), k));
}

/**
 * Los de `tramos` y, además, los tramos con cada `$(…)`, `${…}`, `$[…]`, `` `…` ``, `<(…)`, `>(…)` y `=(…)` entero: el
 * `;`, el `|` o el salto de renglón de adentro de una sustitución (`rm $(: # x⏎) h.md`) no corta el comando de afuera,
 * y en `tramos` sus argumentos quedaban en otro tramo. Lo de adentro lo lee quien llama aparte (`anidadosHasta`). Se
 * parte dos veces: tal cual y sin los comentarios (un `)` en un comentario de adentro, `$(: # )⏎)`, no cierra nada). Una
 * sustitución que no cierra se parte como en `tramos`. Sólo suma tramos: quien los usa mira de más, nunca de menos.
 */
function tramosConSustituciones(cmd) {
  const { conComentariosApagados, quitarCuerposDeHeredoc, tramos } = require('./bash-gate-targets.js');
  const viejos = tramos(cmd);
  const s = conComentariosApagados(quitarCuerposDeHeredoc(cmd));
  if (!/[$<>`=]/.test(s)) return viejos;
  const ya = new Set(viejos);
  const out = [...viejos];
  // (sólo los comentarios con un `)`, el que cierra de más: uno citado, `"cierra #12"`, no se toca)
  for (const texto of new Set([s, s.replace(/(^|[\s;&|(])#[^\n)]*\)[^\n]*/g, '$1')])) {
    for (const t of conSustitucionesEnteras(texto)) if (!ya.has(t)) { ya.add(t); out.push(t); }
  }
  return out;
}

/** Dónde cierra el `$[` de `s[i]` (una cuenta vieja de bash), contando los de adentro; -1 si no cierra. */
function cierreDeCorchete(s, i) {
  let hondo = 0;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') hondo++;
    else if (s[j] === ']' && --hondo === 0) return j;
  }
  return -1;
}

function conSustitucionesEnteras(s) {
  const { cierreDeParentesis, finDeSustitucion } = require('./bash-gate-words.js');
  const nuevos = [];
  let q = null;
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && q !== "'") { actual += c + (s[i + 1] || ''); i++; continue; }
    if (q === "'") { actual += c; if (c === q) q = null; continue; }
    if (!q && c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      actual += s.slice(i, j + 1);
      i = j;
      continue;
    }
    let fin = -1;
    if (c === '`' || (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{'))) fin = finDeSustitucion(s, i);
    else if (c === '$' && s[i + 1] === '[') fin = cierreDeCorchete(s, i);
    else if ((c === '<' || c === '>' || c === '=') && s[i + 1] === '(') fin = cierreDeParentesis(s, i + 1);
    // (una que `tramos` partía queda como una palabra que no se resuelve, `$(:)`: sus pedazos no son argumentos)
    if (fin > i) { const sub = s.slice(i, fin + 1); actual += /[;\n|&]/.test(sub) ? '$(:)' : sub; i = fin; continue; }
    if (q) { actual += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; actual += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      if (actual.trim()) nuevos.push(actual);
      actual = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    actual += c;
  }
  if (actual.trim()) nuevos.push(actual);
  return nuevos;
}

/** Lo que corre el `find` de un tramo que `tramos` partía por un `$(…)` (`find specs $(: ; :) -delete`). Sólo él: en una tubería, el orden de los tramos dice qué alimenta a cuál. */
function findsEnSustituciones(texto, absoluta) {
  const { tramos } = require('./bash-gate-targets.js');
  const { palabras } = require('./bash-gate-words.js');
  const { nombreDeComando, ordenesDeFind, sinPalabrasDelShell } = require('./bash-gate-expansions.js');
  const out = [];
  for (const tramo of tramosConSustituciones(texto).slice(tramos(texto).length)) {
    const words = palabras(sinPalabrasDelShell(tramo)).filter((w) => w !== '');
    if (nombreDeComando(words[0]) === 'find') out.push(...ordenesDeFind(words, absoluta));
  }
  return out;
}

module.exports = { cuerposDeHeredoc, findsEnSustituciones, puntosDeOtrasCabeceras, tramosConSustituciones, vaUnComando };
