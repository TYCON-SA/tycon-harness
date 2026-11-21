'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * free-slots.js — el motivo con que la coordinadora deja lugares libres a propósito, y el registro del cierre sin motivo.
 *
 * El freno del cierre del turno (scripts/hooks/coordination-fill-gate.js) no deja cerrar con lugar, memoria libre y una
 * historia lista; la salida es anotar por qué no se abre nada (`coordination.js keep-free`). Acá vive lo que ese motivo
 * necesita: dónde se guarda, hasta cuándo vale, qué cubre y cómo se muestra. Va aparte de coordination.js para que /wip y
 * la oficina lo lean sin cargar la coordinación entera.
 *
 *   <estado>/coordination/free-slots.json   el último motivo (o el último cierre sin motivo), entero
 *   <estado>/coordination/free-slots.jsonl  un renglón por cada uno, para la historia
 *
 * Un motivo vale TTL_MS desde `at` (su `expiresAt`) y cubre sólo el trabajo listo que vio (`work`, las claves de la lista
 * entera): una clave nueva lo vence; menos trabajo que antes, no. La vigencia se decide sólo por `expiresAt`. Un archivo
 * roto no es un motivo: se dice en `problem` y quien lo lee sigue.
 */
const fs = require('fs');
const path = require('path');

const TTL_MS = 30 * 60000;
// letras del motivo sin contar espacios: menos que esto no es un motivo
const MIN_REASON = 15;
const REASON_MAX = 200;
const KINDS = new Set(['reason', 'closed-without-reason']);

const files = (stateDir) => ({
  current: path.join(stateDir, 'coordination', 'free-slots.json'),
  log: path.join(stateDir, 'coordination', 'free-slots.jsonl'),
});
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
/** El motivo como se guarda y se muestra: una línea, sin `<` ni `>`, hasta `max` letras (las reglas de `label` de coordination.js). */
const cleanReason = (text, max = REASON_MAX) => Array.from(oneLine(text).replace(/[<>]/g, '')).slice(0, max).join('');
/** Cuántas letras tiene el motivo sin contar espacios ni `<` ni `>`, que no se guardan (el piso es MIN_REASON). */
const reasonLength = (text) => Array.from(oneLine(text).replace(/[<>\s]+/g, '')).length;
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** El último registro tal cual: `{ record, problem }`. Sin archivo, los dos nulos; roto o sin forma, `problem` lo dice. */
function read(stateDir) {
  const f = files(stateDir).current;
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { record: null, problem: null };
    return { record: null, problem: `${f} no se puede leer (${e.code || e.message})` };
  }
  let r;
  try { r = JSON.parse(raw); } catch (e) { return { record: null, problem: `${f} está roto (${e.message})` }; }
  if (!r || typeof r !== 'object' || Array.isArray(r) || !KINDS.has(r.kind) || !Number.isFinite(Date.parse(r.expiresAt))) {
    return { record: null, problem: `${f} no tiene la forma de un motivo` };
  }
  return { record: r, problem: null };
}

/** El registro vigente (su `expiresAt` todavía no llegó), o `record: null`. */
function current(stateDir, now = Date.now()) {
  const r = read(stateDir);
  if (!r.record) return r;
  return Date.parse(r.record.expiresAt) > now ? r : { record: null, problem: null };
}

/** Arma un registro: `kind` `reason` o `closed-without-reason`, con su vencimiento a TTL_MS de `at`. */
function record({ kind = 'reason', at = Date.now(), sid, session, reason, working, cap, memoryPct, work }) {
  const t = Number.isFinite(at) ? at : Date.parse(at);
  return {
    at: new Date(t).toISOString(), expiresAt: new Date(t + TTL_MS).toISOString(), sid: cleanReason(sid, 64), session: cleanReason(session, 40) || null,
    kind, reason: cleanReason(reason), working, cap, memoryPct: memoryPct == null ? null : memoryPct, work: [...(work || [])],
  };
}

/** Guarda el registro como el vigente (escribe aparte y renombra) y lo suma a la historia. Tira si no puede. */
function write(stateDir, rec) {
  const { current: f, log } = files(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } throw e; }
  fs.appendFileSync(log, `${JSON.stringify(rec)}\n`);
}

/** ¿El registro cubre este trabajo listo? Vigente, y con TODAS las claves en su `work`. */
const covers = (rec, keys, now = Date.now()) => Boolean(rec) && Date.parse(rec.expiresAt) > now && Array.isArray(rec.work) && (keys || []).every((k) => rec.work.includes(k));

/** «<sesión>, HH:MM a HH:MM: <motivo>», el renglón de /wip. */
const item = (rec) => `${cleanReason(rec.session || rec.sid || 'la coordinadora', 40)}, ${hhmm(rec.at)} a ${hhmm(rec.expiresAt)}: ${cleanReason(rec.reason)}`;
/** La línea entera, con su rótulo: lo que muestra la oficina. */
const line = (rec) => `Lugares libres a propósito: ${item(rec)}`;

module.exports = { TTL_MS, MIN_REASON, REASON_MAX, files, read, current, record, write, covers, item, line, cleanReason, reasonLength };
