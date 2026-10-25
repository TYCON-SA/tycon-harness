#!/usr/bin/env node
/**
 * deprecated-session-notice.js — SessionStart: el código deprecado del repo, dicho al modelo antes de que busque.
 *
 * Un agente que busca «cómo se hace X acá» encuentra el código viejo y lo copia, o lo edita sin que nadie lo haya
 * pedido. Si el repo declara su código deprecado (clave `deprecated` de `.tycon/advisors.yaml`, commiteada), el
 * arranque le da al modelo la lista con su nivel y su motivo, y la regla. Tope de 20 entradas; si hay más, dice
 * cuántas faltan y dónde verlas. Las marcas en la cabecera de los archivos no entran (encontrarlas exigiría recorrer
 * el repo entero): avisan al leer (`deprecated-read-notice.js`).
 *
 * Además, una vez por día y repo, las entradas podridas: la ruta ya no alcanza ningún archivo, o pasó su `review_by`.
 * La fecha del último aviso vive en `<estado>/deprecated-notices/<repo>.json`.
 *
 * Sin lista, no dice nada. Ante cualquier error, calla: un aviso no frena el arranque.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'deprecated.js');
const TOPE = 20;
const NIVEL = { frozen: 'congelado', dead: 'muerto' };

const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();
function stateDir() { return stateDirOf(os.homedir()); }

function hoy() {
  const h = process.env.TYCON_TODAY;
  return h && /^\d{4}-\d{2}-\d{2}$/.test(h) ? h : new Date().toISOString().slice(0, 10);
}

/** La instrucción para el modelo, desde la lista. '' sin entradas. */
function instruccion(entries) {
  if (!entries.length) return '';
  const lineas = entries.slice(0, TOPE).map((e) => `  · ${e.path} — ${NIVEL[e.level]}: ${e.reason}`);
  const faltan = entries.length - TOPE;
  if (faltan > 0) lineas.push(`  · … faltan ${faltan}: están en la clave \`deprecated\` de .tycon/advisors.yaml`);
  return [
    `🗂️ Código deprecado en este repo (${entries.length}, de .tycon/advisors.yaml):`,
    ...lineas,
    '   Regla: no lo tomes de ejemplo para código nuevo. Congelado: sólo arreglos, con el motivo en la historia',
    '   (`deprecated_reason:` en su frontmatter). Muerto: no se toca. Borrarlo o moverlo sí se puede.',
  ].join('\n');
}

/** ¿Hoy todavía no se avisó la lista de este repo? Lo anota al contestar que no. */
function primeraVezHoy(repo, dia, dir) {
  const archivo = path.join(dir, 'deprecated-notices', `${path.basename(repo).replace(/[^\w.-]/g, '_')}.json`);
  let previo = null;
  try { previo = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_e) { previo = null; }
  if (previo && previo.repo === repo && previo.ultimo === dia) return false;
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, JSON.stringify({ repo, ultimo: dia }) + '\n');
  } catch (_e) { /* sin estado se avisa de nuevo mañana: mejor que callar */ }
  return true;
}

/** Las entradas podridas y mal escritas, si hoy todavía no se avisaron en este repo. '' si no hay o ya se dijo. */
function podridasDeHoy(dep, repo, lista, dia, dir) {
  const { podridas } = dep.podridas(repo, { hoy: dia, lista, stateDir: dir });
  const malas = lista.problems || [];
  if (!podridas.length && !malas.length) return '';
  if (!primeraVezHoy(repo, dia, dir)) return '';
  const lineas = podridas.map((p) => (p.motivo === 'no-existe'
    ? `  · ${p.entry.path}: la ruta ya no alcanza ningún archivo`
    : `  · ${p.entry.path}: pasó su fecha de revisión (${p.entry.review_by})`));
  for (const m of malas) lineas.push(`  · ${m.motivo}`);
  return [
    `🟠 La lista de código deprecado de ${path.basename(repo)} tiene ${lineas.length} entrada(s) para revisar:`,
    ...lineas,
    '   Se corrige en .tycon/advisors.yaml (sacar la entrada, corregir la ruta o decidir si se borra el código).',
  ].join('\n');
}

function armar({ cwd, dia = hoy(), dir = stateDir() }) {
  if (!fs.existsSync(LIB)) return '';
  const dep = require(LIB);
  const repo = dep.raizDelRepo(cwd, { stateDir: dir });
  if (!repo) return '';
  const lista = dep.leerLista(repo, { stateDir: dir });   // lo que no pudo mirar queda en gates.log
  if (lista.estado === 'unknown-config-ilegible') {
    // una lista que no se puede leer no protege nada: la persona lo tiene que saber, una vez por día
    return primeraVezHoy(repo, dia, dir)
      ? `🟠 La lista de código deprecado de ${path.basename(repo)} no se pudo leer (${lista.motivo}): mientras tanto no protege nada.`
      : '';
  }
  if (lista.estado !== 'ok') return '';
  return [instruccion(lista.entries), podridasDeHoy(dep, repo, lista, dia, dir)].filter(Boolean).join('\n');
}

module.exports = { armar, instruccion };

if (require.main === module) {
  try {
    let evento = {};
    try { evento = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_e) { evento = {}; }
    const texto = armar({ cwd: (evento.cwd && String(evento.cwd)) || process.cwd() });
    if (texto) console.log(texto);
  } catch (e) {
    // un aviso que tira no frena el arranque, pero queda dicho: si no, deja de avisar sin rastro
    try { require(LIB).anotar({ stateDir: stateDir() }, { status: 'unknown-error', reason: (e && e.message) || String(e) }); } catch (_e) { /* el registro tampoco frena */ }
  }
  process.exit(0);
}
