'use strict';
/**
 * instinct-upload.js — LOS DÍAS DE INSTINTOS, ARMADOS PARA EL BUZÓN
 *
 * Arma un archivo comprimido por día UTC cerrado con lo que grabó `integrations/instincts/scripts/instinct-observe.js` en esta máquina,
 * para que `scripts/metrics/upload-runs.js` lo suba como `<carpeta>/instincts/v<versión>/<AAAA-MM-DD>.jsonl.gz`. Lo
 * llama la preparación diaria de los registros; no sube nada por su cuenta.
 *
 * 🔴 NADA PERSONAL NI DE OTRA ORGANIZACIÓN. Sale sólo la línea cuyo `origin` es la organización del perfil activo
 *    (`ado.org`, comparada sin esquema, sin barra final y sin distinguir mayúsculas). Una línea sin repo, de otra
 *    organización (GitHub incluido) o que nombra `/clients/` no sale y se cuenta por motivo. De lo que sale viajan sólo
 *    `ts`, `session_id`, `tool`, `repo`, `summary` y `status`: ni `project` ni `origin`.
 *
 * 🔴 SÓLO DESDE EL AVISO, Y NUNCA EL DÍA EN CURSO. El primer día es el del sello del aviso (`instincts-notice.json` →
 *    `said_on`); ese día, sólo lo grabado desde la hora del aviso (`said_at`), si el sello la trae. El día en curso sigue
 *    creciendo: sube cuando cierra.
 *
 * 🔴 «NO PUDE» NUNCA ES «NADA». Sin organización, o con un registro que no se pudo leer, la cobertura dice `no_medido`
 *    con el motivo (sin rutas de la máquina) y no sale ninguna línea.
 *
 * Un día pasa de 5 MB comprimido: suben las primeras líneas hasta el tope y la cobertura dice `truncado` y cuántas
 * quedaron afuera. Un día ya subido con el mismo contenido no se vuelve a armar; los meses viejos cuyos días ya subieron
 * todos no se leen.
 *
 * Casos: scripts/tests/instinct-upload.test.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
const FIELDS = ['ts', 'session_id', 'tool', 'repo', 'summary', 'status'];

/** `ado.org` en la forma con que la grabadora anota `origin`: `dev.azure.com/<org>`, en minúsculas. '' si no hay. */
function orgKey(org) {
  const s = String(org || '').trim().replace(/\/+$/, '');
  let m = /^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)/i.exec(s);
  if (m) return `dev.azure.com/${m[1].toLowerCase()}`;
  m = /^(?:https?:\/\/)?(?:[^@/]+@)?([^./]+)\.visualstudio\.com/i.exec(s);
  if (m) return `dev.azure.com/${m[1].toLowerCase()}`;
  return '';
}

/** Por qué una línea no sale, o null si sale. */
function dropReason(line, org) {
  // en la Mac y en Windows el disco no distingue mayúsculas: `/Clients/` es la misma carpeta. `repo` es relativo
  // (`Clients/x` o `Clients`): se cierra entre barras para que su primer y su último tramo también cuenten
  const texto = `/${line.repo || ''}/ ${line.summary || ''}`.replace(/\\/g, '/').toLowerCase();
  if (texto.includes('/clients/')) return 'clientes';
  if (!line.origin || !line.repo) return 'sin_repo';
  if (String(line.origin).toLowerCase() !== org) return 'otra_organizacion';
  return null;
}

/**
 * Los milisegundos de `ts`: la grabadora lo anota en segundos (un número); una línea con la fecha en texto también vale.
 * NaN si no es ninguna de las dos.
 */
function tsMs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts * 1000 : NaN;
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(ts)) return Date.parse(ts);
  return NaN;
}

/** El día UTC anterior a `day`. */
function dayBefore(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

/** Los meses `AAAA-MM` de `from` a `to`, inclusive. */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Comprime las líneas; si pasan del tope, se queda con las primeras que entran. */
function compress(lines, maxBytes) {
  const body = (n) => zlib.gzipSync(Buffer.from(n ? `${lines.slice(0, n).join('\n')}\n` : '', 'utf8'));
  let gz = body(lines.length);
  if (gz.length <= maxBytes) return { gz, kept: lines.length };
  // búsqueda binaria de cuántas primeras líneas entran
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (body(mid).length <= maxBytes) lo = mid; else hi = mid - 1;
  }
  gz = body(lo);
  return { gz, kept: lo };
}

/** Escribe `file` entero o no lo escribe. */
function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Arma los días en `outDir` y devuelve `{ files, coverage }`.
 *   obsDir     la carpeta de lo grabado (`<AAAA-MM>.jsonl`)
 *   seal       el sello del aviso: `{ said_on, said_at? }`
 *   org        `ado.org` del perfil activo
 *   today      el día de hoy (UTC), que no sube
 *   folder     la carpeta de esta máquina en el buzón
 *   uploaded   `{ '<AAAA-MM-DD>': sha256 }` de lo que esta carpeta ya subió (el gz entero)
 *   maxBytes   el tope por día comprimido
 * `files` son los nombres armados en esta pasada; `coverage` es la sección `instincts` de la cobertura del día. En
 * `outDir` quedan sólo los días armados ahora: lo que ya subió igual no se vuelve a mandar.
 */
function prepareDays({ obsDir, outDir, seal, org, today, folder = null, uploaded = {}, maxBytes = MAX_BYTES } = {}) {
  const notMeasured = (motivo) => {
    clearDir(outDir);
    return { files: [], coverage: { estado: 'no_medido', motivo } };
  };
  const key = orgKey(org);
  if (!key) return notMeasured('sin organización: el perfil activo no tiene ado.org');
  if (!seal || !/^\d{4}-\d{2}-\d{2}$/.test(String(seal.said_on || ''))) return notMeasured('sin aviso: esta máquina todavía no dijo qué graba');
  const yesterday = dayBefore(today);
  // la hora del aviso, comparada como fecha (un `ts` sin milésimas no ordena bien como texto)
  const saidAt = seal.said_at ? Date.parse(seal.said_at) : NaN;
  const lastLine = { day: null };
  const days = new Map();
  const readMonths = [];
  let unreadable = 0;
  if (seal.said_on <= yesterday) {
    let names;
    try { names = fs.readdirSync(obsDir); }
    catch (e) { if (e.code !== 'ENOENT') return notMeasured(`la carpeta de lo grabado no se pudo leer (${e.code || 'error'})`); names = []; }
    const months = new Set(monthsBetween(seal.said_on.slice(0, 7), today.slice(0, 7)));
    const done = readDoneMonths(outDir, folder, key);
    const monthFiles = names.filter((n) => MONTH_FILE.test(n)).sort();
    const newest = monthFiles.length ? MONTH_FILE.exec(monthFiles[monthFiles.length - 1])[1] : null;
    for (const name of monthFiles) {
      const month = MONTH_FILE.exec(name)[1];
      const read = months.has(month) && !done.includes(month);
      if (read) readMonths.push(month);
      // el mes más nuevo que hay siempre se lee: de ahí sale la última línea grabada
      if (!read && month !== newest) continue;
      let text;
      try { text = fs.readFileSync(path.join(obsDir, name), 'utf8'); }
      catch (e) { return notMeasured(`lo grabado de ${month} no se pudo leer (${e.code || 'error'})`); }
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        let line;
        try { line = JSON.parse(raw); } catch (_) { if (read) unreadable += 1; continue; }
        const ms = tsMs(line && line.ts);
        if (!Number.isFinite(ms)) { if (read) unreadable += 1; continue; }
        const day = new Date(ms).toISOString().slice(0, 10);
        if (!lastLine.day || day > lastLine.day) lastLine.day = day;
        if (!read || day < seal.said_on || day > yesterday) continue;
        if (day === seal.said_on && Number.isFinite(saidAt) && ms < saidAt) continue;
        if (!days.has(day)) days.set(day, { lines: [], filtradas: { otra_organizacion: 0, sin_repo: 0, clientes: 0 } });
        const d = days.get(day);
        const why = dropReason(line, key);
        if (why) { d.filtradas[why] += 1; continue; }
        d.lines.push(JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, line[f] === undefined ? null : line[f]]))));
      }
    }
  }
  clearDir(outDir);
  const files = [];
  const dias = {};
  for (const day of [...days.keys()].sort()) {
    const d = days.get(day);
    if (!d.lines.length) { dias[day] = { lineas: 0, filtradas: d.filtradas, bytes: 0, truncado: false }; continue; }
    const { gz, kept } = compress(d.lines, maxBytes);
    const entry = { lineas: kept, filtradas: d.filtradas, bytes: gz.length, truncado: kept < d.lines.length };
    if (entry.truncado) entry.quedaron_afuera = d.lines.length - kept;
    dias[day] = entry;
    // ni la primera línea entra en el tope: no se sube un día vacío (fijaría su sha como «subido»)
    if (!kept) { entry.bytes = 0; continue; }
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    if (uploaded[day] === sha) continue;
    fs.mkdirSync(outDir, { recursive: true });
    writeAtomic(path.join(outDir, `${day}.jsonl.gz`), gz);
    files.push(`${day}.jsonl.gz`);
  }
  // un mes cerrado que se leyó y no dejó nada por mandar no se vuelve a leer (un mes con días vacíos se leería siempre)
  // un día donde ni una línea entró en el tope tampoco subió: su mes sigue abierto
  const pending = new Set([...files.map((f) => f.slice(0, 7)), ...Object.keys(dias).filter((d) => dias[d].truncado && !dias[d].bytes).map((d) => d.slice(0, 7))]);
  const closed = readMonths.filter((m) => m < yesterday.slice(0, 7) && !pending.has(m));
  if (closed.length) writeDoneMonths(outDir, folder, key, [...new Set([...readDoneMonths(outDir, folder, key), ...closed])].sort());
  // las líneas que no se pudieron leer se dicen: no son «0»
  return { files, coverage: { estado: 'medido', ultima_linea: lastLine.day, ilegibles: unreadable, dias } };
}

/**
 * Los meses cerrados cuyos días ya subieron todos, anotados con la carpeta del buzón y la organización: con otra carpeta
 * (la máquina vuelve a subir sus días) u otra organización la lista no vale y se lee todo otra vez.
 */
const DONE_FILE = 'months-done.json';
function readDoneMonths(dir, folder, org) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, DONE_FILE), 'utf8'));
    return Array.isArray(d.months) && d.folder === folder && d.org === org ? d.months.filter((m) => /^\d{4}-\d{2}$/.test(m)) : [];
  } catch (_) { return []; }
}
function writeDoneMonths(dir, folder, org, months) {
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, DONE_FILE), `${JSON.stringify({ folder, org, months })}\n`);
}
/** Saca de `dir` los días armados antes. */
function clearDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) if (DAY_FILE.test(n)) fs.rmSync(path.join(dir, n), { force: true });
}

module.exports = { prepareDays, orgKey, dropReason, MAX_BYTES, DAY_FILE };
