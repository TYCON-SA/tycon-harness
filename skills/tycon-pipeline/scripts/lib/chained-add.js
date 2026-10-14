'use strict';
/**
 * chained-add.js — los `git add` que vienen ANTES del `git commit` en la misma línea (2026-10-14).
 *
 * ── El caso ──────────────────────────────────────────────────────────────────────────────────
 * El freno del commit (on-pre-commit.js) corre ANTES de que se ejecute el comando entero. Con
 * `git add X && git commit`, lo stageado todavía es la versión VIEJA de X: el freno rebotaba por algo
 * que el mismo comando ya arreglaba. Y al revés, que es peor: si lo stageado estaba sano y el `add`
 * traía una versión rota, el freno miraba la sana y dejaba pasar la rota.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────────────────────
 * Si TODO lo que precede al commit son `git add` simples, encadenados con `&&` o `;`, el freno los
 * corre sobre una COPIA del índice (`GIT_INDEX_FILE` apuntando a un temporal) y evalúa ESA copia: es
 * exactamente lo que quedaría stageado, con los mismos argumentos y desde la misma carpeta. El índice
 * real no se toca.
 *
 * ── Cuándo NO simula (y por qué así no se abre un hueco) ─────────────────────────────────────
 * Un `add` encadenado no puede servir para colar algo que el freno no vio. Por eso se simula sólo lo
 * que se puede reproducir igual que el shell:
 *   · cualquier otro comando antes del commit (un `cd`, un `sed` que cambia el archivo entre dos
 *     `add`, un `git rm`): lo que va a quedar stageado ya no es lo que ve el freno;
 *   · `||`, `|`, `&` o un envoltorio `bash -c` entre medio;
 *   · variables, comodines sin comillas, `~`, sustituciones, redirecciones o barras invertidas: los
 *     expande el shell y el freno no;
 *   · `git -C`, opciones globales o asignaciones delante del `git add`, y cualquier opción del `add` fuera de una
 *     lista cerrada de las que se reproducen igual (las interactivas, como `-p`, quedan afuera).
 * En esos casos el freno mira lo stageado hoy (lo de siempre) y, si frena, lo dice: que corra el
 * `add` en una llamada aparte y después el commit.
 */

const SEPARADORES_QUE_ENCADENAN = new Set(['&&', ';', '\n']);
// Fuera de comillas, estos los interpreta el shell (expansión, comodines, redirección, sustitución).
const META_SIN_COMILLAS = /[$`*?[\]{}~<>()\\!#]/;
// Opciones de `git add` que se reproducen igual sobre la copia del índice. Cualquier otra (las interactivas, las que leen
// la lista de archivos de otro lado, las que no conocemos) deja el comando sin simular: lista cerrada, no lista negra.
const OPCIONES_SIMULABLES = new Set(['-A', '--all', '-u', '--update', '-f', '--force', '-N', '--intent-to-add',
  '--ignore-removal', '--no-all', '--renormalize', '-v', '--verbose', '-n', '--dry-run', '--']);

/**
 * Parte el comando en segmentos y separadores, respetando comillas simples y dobles.
 * Devuelve null si hay una comilla sin cerrar (no se adivina).
 */
function segmentar(command) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    const dos = command.slice(i, i + 2);
    if (dos === '&&' || dos === '||') { out.push({ seg: cur, sep: dos }); cur = ''; i++; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { out.push({ seg: cur, sep: c }); cur = ''; continue; }
    cur += c;
  }
  if (q) return null;
  out.push({ seg: cur, sep: null });
  // Las líneas en blanco no son comandos: se descartan, y el segmento anterior conserva su separador.
  return out.filter((x) => !(x.seg.trim() === '' && (x.sep === '\n' || x.sep === ';')));
}

/**
 * Palabras de un segmento SIN expansiones del shell. null si algo lo expandiría el shell.
 * Dentro de comillas simples todo es literal; dentro de dobles se rechaza `$`, la comilla invertida y
 * la barra invertida (las tres las interpreta el shell también ahí).
 */
function palabras(seg) {
  const out = [];
  let cur = null;
  let q = null;
  for (const c of seg) {
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (c === '$' || c === '`' || c === '\\') return null;
      cur += c; continue;
    }
    if (c === "'" || c === '"') { q = c; if (cur === null) cur = ''; continue; }
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    if (META_SIN_COMILLAS.test(c)) return null;
    cur = (cur === null ? '' : cur) + c;
  }
  if (q) return null;
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * Qué `git add` hay antes del commit.
 * @param {string} command  el comando entero de la herramienta
 * @param {(seg: string) => boolean} esCommit  decide si un segmento es el `git commit` (el de on-pre-commit.js)
 * @returns {{estado: 'sin-add'} | {estado: 'simulable', adds: string[][]} | {estado: 'no-simulable', motivo: string}}
 */
function addsBeforeCommit(command, esCommit) {
  if (!command || typeof command !== 'string') return { estado: 'sin-add' };
  const hayAdd = /\bgit\b[^\n;&|]*\badd\b/.test(command);
  if (!hayAdd) return { estado: 'sin-add' };
  const partes = segmentar(command);
  if (!partes) return { estado: 'no-simulable', motivo: 'el comando tiene una comilla sin cerrar' };
  const iCommit = partes.findIndex((p) => esCommit(p.seg));
  if (iCommit <= 0) {
    // Sin commit propio (lo trae un envoltorio `bash -c`) o el commit va primero: el `add` no cambia lo que ve el freno
    // si viene después; si viene adentro de un envoltorio, no se simula.
    if (iCommit === 0) return { estado: 'sin-add' };
    return { estado: 'no-simulable', motivo: 'el `git add` y el commit vienen dentro de otro comando (por ejemplo `bash -c`)' };
  }
  const adds = [];
  for (let i = 0; i < iCommit; i++) {
    const { seg, sep } = partes[i];
    if (!SEPARADORES_QUE_ENCADENAN.has(sep)) {
      return { estado: 'no-simulable', motivo: `antes del commit hay un \`${sep}\`, y con eso no se sabe qué llega a stagearse` };
    }
    const w = palabras(seg.trim());
    if (!w) return { estado: 'no-simulable', motivo: `\`${seg.trim().slice(0, 60)}\` tiene algo que expande el shell (variables, comodines sin comillas, sustituciones)` };
    if (w[0] !== 'git' || w[1] !== 'add') {
      return { estado: 'no-simulable', motivo: `antes del commit corre \`${seg.trim().slice(0, 60)}\`, que no es un \`git add\` simple` };
    }
    const args = w.slice(2);
    const finDeOpciones = args.indexOf('--');
    const raro = args.find((a, i) => a.startsWith('-') && a !== '-' && (finDeOpciones < 0 || i <= finDeOpciones) && !OPCIONES_SIMULABLES.has(a));
    if (raro) return { estado: 'no-simulable', motivo: `\`git add ${raro}\` no se reproduce igual sobre una copia del índice (interactiva, o una opción que el freno no conoce)` };
    adds.push(args);
  }
  return { estado: 'simulable', adds };
}

module.exports = { addsBeforeCommit, segmentar, palabras };
