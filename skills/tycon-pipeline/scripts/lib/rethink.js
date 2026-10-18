'use strict';
/**
 * rethink.js — la nota de «repensar el enfoque» que el pipeline pide desde la tercera vuelta de revisores.
 *
 * Una nota por vuelta, en `<corrida>/rethink/iter-N.json`: la escribe `marker.js rethink`, la exige
 * `pipeline.js smart-reloop` (N >= 3) y la leen `write-findings` y `scripts/metrics/retro-heartbeat.js`.
 * Cada campo de texto tiene un mínimo de caracteres para que la nota no sea una línea vacía; la calidad de lo que
 * dice la juzga una persona, no el código.
 */

const fs = require('fs');
const path = require('path');

/** Desde esta vuelta el re-loop exige la nota. */
const FIRST_ITER = 3;
/** Mínimo de caracteres de cada campo de texto de la nota. */
const MIN_CHARS = 40;

const FIELDS = {
  repeated: '--repeated (qué hallazgos volvieron en las vueltas anteriores)',
  change: '--change (qué cambia del enfoque)',
  keep: '--keep (por qué el enfoque sigue igual)',
  story_change: '--story-change (qué cambia de la story)',
};

function notesDir(runDir) { return path.join(runDir, 'rethink'); }
function notePath(runDir, iter) { return path.join(notesDir(runDir), `iter-${iter}.json`); }
function servedPath(runDir) { return path.join(notesDir(runDir), 'served.json'); }

/**
 * Las vueltas que la corrida ya sirvió (`<corrida>/rethink/served.json`, `{ "served": [1, 2, ...] }`). Es el registro de
 * la propia carpeta: no depende del marcador de la sesión, que puede faltar. { ok, last } — `last` es 0 si no hay registro;
 * { ok:false, reason } si existe y no se puede leer (no se sabe cuántas vueltas van).
 */
function readServed(runDir) {
  if (!runDir) return { ok: true, last: 0 };
  const file = servedPath(runDir);
  if (!fs.existsSync(file)) return { ok: true, last: 0 };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, reason: `ilegible (${String(e.message).slice(0, 80)})` }; }
  if (!doc || !Array.isArray(doc.served) || !doc.served.every((n) => Number.isInteger(n) && n >= 1)) {
    return { ok: false, reason: 'no es una lista de vueltas servidas' };
  }
  return { ok: true, last: doc.served.reduce((m, n) => Math.max(m, n), 0), served: doc.served };
}

/** Anota la vuelta servida. { ok } o { ok:false, reason } si no se pudo leer el registro o escribirlo. */
function recordServed(runDir, iter) {
  const prev = readServed(runDir);
  if (!prev.ok) return prev;
  const served = [...new Set([...(prev.served || []), iter])].sort((a, b) => a - b);
  try {
    fs.mkdirSync(notesDir(runDir), { recursive: true });
    fs.writeFileSync(servedPath(runDir), JSON.stringify({ served }, null, 2) + '\n', 'utf8');
  } catch (e) { return { ok: false, reason: `no se pudo escribir (${String(e.message).slice(0, 80)})` }; }
  return { ok: true };
}

/** Texto del campo sin espacios de más; lo que no es texto cuenta como vacío. */
function clean(v) { return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''; }

/**
 * Errores de una nota (lista vacía = válida). `--repeated` es obligatorio, se elige exactamente uno entre `--change` y
 * `--keep`, y `--story-change` es opcional pero, si viene, cumple el mismo mínimo.
 */
function validateNote(note) {
  const errors = [];
  const n = note || {};
  if (!Number.isInteger(n.iter) || n.iter < 1) {
    errors.push(`--iter tiene que ser el número de la vuelta, un entero de 1 en adelante (vino «${n.iter === undefined ? '' : n.iter}»).`);
  }
  const has = (k) => n[k] !== undefined && n[k] !== null;
  const short = (k) => {
    const len = clean(n[k]).length;
    if (len < MIN_CHARS) errors.push(`${FIELDS[k]} ${len === 0 ? 'está vacío' : `tiene ${len} caracteres`}: pide al menos ${MIN_CHARS} para que diga algo.`);
  };
  if (!has('repeated')) errors.push(`falta ${FIELDS.repeated}.`);
  else short('repeated');
  if (has('change') && has('keep')) errors.push('--change y --keep son excluyentes: o cambia el enfoque o sigue igual, no las dos.');
  else if (!has('change') && !has('keep')) errors.push('falta decidir: --change "<qué cambia del enfoque>" o --keep "<por qué sigue igual>".');
  else short(has('change') ? 'change' : 'keep');
  if (has('story_change')) short('story_change');
  return errors;
}

/** Lee la nota de una vuelta. { ok, note } o { ok:false, reason } (no existe, ilegible o no cumple los mínimos). */
function readNote(runDir, iter) {
  if (!runDir) return { ok: false, reason: 'no hay carpeta de corrida' };
  const file = notePath(runDir, iter);
  if (!fs.existsSync(file)) return { ok: false, reason: 'no existe' };
  let note;
  try { note = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, reason: `ilegible (${String(e.message).slice(0, 80)})` }; }
  const errors = validateNote(note);
  // 🔴 sale rojo si una nota cuyo `iter` interno no es el del archivo (iter-N.json) vale: una nota sólo vale para su vuelta.
  if (!errors.length && note.iter !== Number(iter)) {
    errors.push(`la nota está guardada como la de la vuelta ${iter} pero dice ser de la vuelta ${note.iter}: una nota sólo vale para su vuelta`);
  }
  return errors.length ? { ok: false, reason: errors.join(' ') } : { ok: true, note };
}

/**
 * Todas las notas de la corrida, por vuelta: `notes` las válidas y `broken` las que están y no sirven (ilegibles o bajo
 * los mínimos), con el motivo. Una nota rota NO es una nota válida, pero tampoco se descarta callada: quien lista la dice.
 */
function readAll(runDir) {
  const out = { notes: [], broken: [] };
  if (!runDir) return out;
  let names = [];
  try { names = fs.readdirSync(notesDir(runDir)); } catch { return out; }
  for (const name of names) {
    const m = /^iter-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const r = readNote(runDir, Number(m[1]));
    if (r.ok) out.notes.push(r.note);
    else out.broken.push({ iter: Number(m[1]), reason: r.reason });
  }
  out.notes.sort((a, b) => a.iter - b.iter);
  out.broken.sort((a, b) => a.iter - b.iter);
  return out;
}

/** Las notas válidas de la corrida, por vuelta (las ilegibles o cortas no cuentan; `readAll` dice cuáles son). */
function listNotes(runDir) { return readAll(runDir).notes; }

/** El aviso llano de una nota rota. 🔴 sale rojo si una nota rota se descarta sin decir la vuelta. */
function brokenWarning(b) {
  // El motivo puede traer texto de la nota (un `iter` con una ruta, el mensaje del JSON roto) y el aviso viaja al informe y a la retro.
  return `nota ilegible/incompleta de la vuelta ${sanearTexto(b.iter)}: no cuenta como nota válida (${sanearTexto(b.reason)}).`;
}

/**
 * Los campos de texto de la nota pasados por el saneador del arnés (`sanear` de scripts/metrics/tokens-digest.js): la nota
 * la escribe una persona y viaja al informe y a la retrospectiva, que van por git. Sin saneador legible NO se publica el
 * texto: queda un marcador que lo dice.
 */
function loadSanear() {
  const candidatos = [];
  try {
    const { dir } = require('./harness-path.js').rutaArnesHook();
    if (dir) candidatos.push(path.join(dir, 'scripts', 'metrics', 'tokens-digest.js'));
  } catch { /* se prueba el siguiente */ }
  candidatos.push(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'metrics', 'tokens-digest.js'));
  for (const c of candidatos) {
    try { const d = require(c); if (typeof d.sanear === 'function') return d.sanear; } catch { /* siguiente */ }
  }
  return null;
}
/** Un texto cualquiera por el saneador; sin saneador legible no se publica. */
function sanearTexto(v) {
  const sanear = loadSanear();
  const t = String(v === undefined || v === null ? '' : v);
  return sanear ? sanear(t) : '<texto no publicado: no se encontró el saneador del arnés>';
}
function sanearNota(note) {
  const sanear = loadSanear();
  const out = { ...note };
  for (const k of Object.keys(FIELDS)) {
    if (typeof out[k] === 'string') out[k] = sanear ? sanear(out[k]) : '<texto no publicado: no se encontró el saneador del arnés>';
  }
  if (typeof out.at === 'string') out.at = sanearTexto(out.at);
  return out;
}

/**
 * Los hallazgos que volvieron: los que el findings.json de la corrida trae con el mismo `rule_id` y el mismo archivo
 * en más de una vuelta (cada registro lleva su `iter` anotado por quien firmó). Si no se puede saber —no hay informe,
 * no se lee, o ningún hallazgo dice su vuelta— se devuelve `known: false` con el motivo, no una lista vacía.
 */
function repeatedFindings(runDir) {
  if (!runDir) return { known: false, reason: 'todavía no hay carpeta de corrida' };
  const file = path.join(runDir, 'findings.json');
  if (!fs.existsSync(file)) return { known: false, reason: 'la corrida todavía no tiene findings.json' };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { known: false, reason: 'el findings.json de la corrida no se puede leer' }; }
  if (!Array.isArray(arr)) return { known: false, reason: 'el findings.json de la corrida no es una lista de hallazgos' };
  const byKey = new Map();
  let withIter = 0;
  for (const f of arr) {
    if (!f || !Number.isInteger(f.iter)) continue;
    withIter += 1;
    const key = `${f.rule_id || '?'}\u0000${f.file || ''}`;
    if (!byKey.has(key)) byKey.set(key, { rule_id: f.rule_id || '?', file: f.file || '', iters: new Set() });
    byKey.get(key).iters.add(f.iter);
  }
  if (!withIter) return { known: false, reason: 'ningún hallazgo del findings.json dice en qué vuelta apareció' };
  const items = [...byKey.values()].filter((x) => x.iters.size > 1)
    .map((x) => ({ rule_id: x.rule_id, file: x.file, iters: [...x.iters].sort((a, b) => a - b) }));
  return { known: true, items };
}

/** El mensaje llano con que `smart-reloop` frena: qué volvió y qué tiene que decir la nota. */
function blockMessage({ iter, runDir, repeated, why }) {
  const lines = [`🛑 Vuelta ${iter} de revisores sin nota de «repensar el enfoque»: smart-reloop no devuelve el set hasta que la corrida la tenga.`];
  if (iter > FIRST_ITER) lines.push(`Cada vuelta desde la ${FIRST_ITER} pide su propia nota; la de las vueltas anteriores no vale para esta.`);
  if (repeated.known) {
    if (repeated.items.length) {
      lines.push('Hallazgos que volvieron en más de una vuelta:');
      for (const x of repeated.items) lines.push(`  - ${x.rule_id} en ${x.file || '(sin archivo)'} (vueltas ${x.iters.join(', ')})`);
    } else {
      lines.push('Ningún hallazgo del findings.json se repite en más de una vuelta (mismo código de regla y mismo archivo).');
    }
  } else {
    lines.push(`No puedo saber qué hallazgos volvieron: ${repeated.reason}. Mirá los reportes de las vueltas anteriores y anotalo vos.`);
  }
  if (why) lines.push(`La nota que hay en la corrida no sirve: ${why}.`);
  lines.push(
    'La nota dice (cada campo, al menos ' + MIN_CHARS + ' caracteres): qué se repitió en las vueltas, y o bien qué cambia del enfoque, o bien por qué sigue igual. '
    + 'Si hace falta cambiar la story, primero se cambia la story (con su registro de cambios) y se pasa --story-change.',
  );
  lines.push(`Comando: node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js rethink --iter ${iter} --repeated "<qué se repitió>" (--change "<qué cambia del enfoque>" | --keep "<por qué sigue igual>") [--story-change "<qué cambia de la story>"]`);
  if (runDir) lines.push(`La nota se guarda en ${notePath(runDir, iter)}.`);
  return lines.join('\n') + '\n';
}

module.exports = { FIRST_ITER, MIN_CHARS, notePath, notesDir, servedPath, readServed, recordServed, clean, validateNote, readNote, readAll, listNotes, brokenWarning, sanearNota, sanearTexto, repeatedFindings, blockMessage };
