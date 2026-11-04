'use strict';
/**
 * suite-times.js — el registro de cuánto tarda cada suite: un renglón JSON por corrida.
 *
 * POR QUÉ: el portón mide los milisegundos de cada suite, pero el resumen vive en una carpeta temporal y se pierde. Sin
 * un registro que dure no se puede decir cuáles son las lentas ni si una se está poniendo más lenta. Cada corrida (el
 * portón, las portables, la validación de Azure) agrega su renglón; `scripts/tools/suite-times.js` lo lee.
 *
 * DÓNDE ANOTA (`target`): `TYCON_SUITE_TIMES` manda: `off` o `0` no anota, cualquier otro valor es el archivo. Sin la
 * variable, anota en `<estado>/suite-times.jsonl` sólo quien anota por defecto: el portón (`TYCON_SUITE_RUNNER=
 * test-gate`, que exporta test-gate.sh) y las portables corridas a mano. Así una prueba que lanza el corredor sobre un
 * repo de juguete no ensucia el registro de la máquina; y el corredor les pasa `off` a las suites que lanza.
 *
 * EL RENGLÓN: { v, ts, origen, repo, head, workers, nucleos, carga, wall_ms, cortada?, suites: [{ s, ms, exit }] }.
 * `s` es la `ruta` de suites.json. La carga es la de 1 min al arrancar.
 *
 * DOS A LA VEZ: agregar y rotar van bajo un candado (`<archivo>.lock`, creado exclusivo). Un candado de más de 60 s se
 * toma como abandonado; sin candado en 10 s no se anota y se dice. El archivo se queda con las últimas 200 corridas, y
 * se reescribe entero en un temporal que después se renombra: nunca queda a medio escribir.
 *
 * LEER (`readSources`): archivos y carpetas. Un renglón JSON se lee entero; uno con la marca `SUITE-TIMES ` (el que
 * las portables imprimen en el registro de la CI de GitHub) se lee desde la marca, aunque traiga la hora delante. Un
 * renglón que parece del registro y no se deja leer se cuenta como ilegible; el resto de un registro se ignora.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { stateDir } = require('./state-dir.js');

const MAX_RUNS = 200;
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 60000;
const MARK = 'SUITE-TIMES ';
const TREND_PCT = 15;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** El archivo donde anotar, o null con el motivo. `byDefault`: quien llama anota sin la variable. */
function target(env = process.env, { byDefault = env.TYCON_SUITE_RUNNER === 'test-gate', home } = {}) {
  const v = env.TYCON_SUITE_TIMES === undefined ? '' : String(env.TYCON_SUITE_TIMES).trim();
  if (v === 'off' || v === '0') return { file: null, why: 'TYCON_SUITE_TIMES lo apaga' };
  if (v) return { file: path.resolve(v), why: 'TYCON_SUITE_TIMES' };
  if (!byDefault) return { file: null, why: 'sin TYCON_SUITE_TIMES y no es el portón' };
  return { file: path.join(stateDir(home), 'suite-times.jsonl'), why: 'la carpeta de estado' };
}

/** El sha de 12 de HEAD del repo, o null. */
function headOf(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Núcleos y carga de 1 min, medidos ahora. */
function machine() {
  const nucleos = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return { nucleos, carga: Math.round(os.loadavg()[0] * 100) / 100 };
}

function takeLock(lock, { waitMs, staleMs }) {
  const t0 = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.rmSync(lock, { force: true }); continue; }
    } catch (_) { continue; }   // lo soltaron entre el intento y la mirada
    if (Date.now() - t0 >= waitMs) return false;
    sleep(50);
  }
}

/** Agrega un renglón al registro, bajo el candado, con el tope. { ok, reason?, file }. Nunca tira. */
function append(entry, file, { max = MAX_RUNS, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!takeLock(lock, { waitMs, staleMs })) return { ok: false, file, reason: `otra corrida tiene el candado ${lock} hace más de ${Math.round(waitMs / 1000)} s` };
  } catch (e) {
    return { ok: false, file, reason: `no pude tomar el candado de ${file} (${e.code || e.message})` };
  }
  try {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    lines.push(JSON.stringify(entry));
    if (lines.length > max) lines = lines.slice(lines.length - max);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, reason: `no pude escribir ${file} (${e.code || e.message})` };
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch (_) { /* vence a los 60 s */ }
  }
}

/** Arma el renglón de una corrida. */
function entryOf({ origen, repo, head, workers, nucleos, carga, wallMs, cortada, suites, ts = new Date().toISOString() }) {
  const e = { v: 1, ts, origen, repo, head: head || null, workers, nucleos, carga, wall_ms: wallMs,
    suites: suites.map((x) => ({ s: x.s, ms: x.ms, exit: x.exit })) };
  if (cortada) e.cortada = true;
  return e;
}

/**
 * Las suites de un TSV `suite<TAB>ms<TAB>exit` (el que escribe el paso de Azure). Un renglón roto se cuenta. Azure
 * anota el nombre del archivo; con `byName` (nombre → `ruta` de suites.json) se anota la ruta, la misma clave que el
 * portón: si no, la misma suite saldría en dos filas. Un nombre que no está en el mapa queda como vino.
 */
function fromTsv(text, byName = null) {
  const suites = [];
  let unreadable = 0;
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    const [s, ms, exit] = l.split('\t');
    if (!s || !/^\d+$/.test(ms || '') || !/^-?\d+$/.test(exit || '')) { unreadable += 1; continue; }
    suites.push({ s: (byName && byName.get(s)) || s, ms: Number(ms), exit: Number(exit) });
  }
  return { suites, unreadable };
}

/** Nombre del archivo → `ruta`, de un suites.json. Un nombre repetido no entra: no se sabe cuál es. */
function routesByName(suitesJson) {
  const d = JSON.parse(suitesJson);
  const map = new Map();
  const seen = new Set();
  for (const e of [...(d.diarias || []), ...(d.semanales || [])]) {
    if (!e || typeof e.ruta !== 'string') continue;
    const n = path.posix.basename(e.ruta);
    if (seen.has(n)) map.delete(n); else map.set(n, e.ruta);
    seen.add(n);
  }
  return map;
}

const isRun = (o) => o && typeof o === 'object' && typeof o.ts === 'string' && Array.isArray(o.suites);

function readText(text, out) {
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const at = l.indexOf(MARK);
    const body = at >= 0 ? l.slice(at + MARK.length) : (l.startsWith('{') ? l : null);
    if (body === null) continue;
    let o = null;
    try { o = JSON.parse(body); } catch (_) { o = null; }
    if (isRun(o)) out.runs.push(o); else out.unreadable += 1;
  }
}

function filesUnder(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...filesUnder(p));
    else if (/\.(jsonl|log|txt)$/.test(d.name)) out.push(p);
  }
  return out.sort();
}

/** Lee archivos y carpetas. { runs (por fecha), unreadable, missing: [rutas] }. */
function readSources(sources) {
  const out = { runs: [], unreadable: 0, missing: [] };
  for (const s of sources) {
    let st;
    try { st = fs.statSync(s); } catch (_) { out.missing.push(s); continue; }
    for (const f of st.isDirectory() ? filesUnder(s) : [s]) {
      try { readText(fs.readFileSync(f, 'utf8'), out); } catch (_) { out.missing.push(f); }
    }
  }
  out.runs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

function filterRuns(runs, { origen = null, maxLoad = null } = {}) {
  return runs.filter((r) => (!origen || r.origen === origen) && (maxLoad === null || (typeof r.carga === 'number' && r.carga <= maxLoad)));
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** «sube», «baja», «igual» o «sin tendencia» para una lista de ms en orden de fecha. */
function trend(ms) {
  if (ms.length < 6) return 'sin tendencia';
  const last = median(ms.slice(-5));
  const prev = median(ms.slice(-10, -5));
  // con la anterior en 0 (una suite de menos de un segundo medida en segundos) cualquier crecimiento sube
  const pct = prev > 0 ? ((last - prev) / prev) * 100 : (last > 0 ? Infinity : 0);
  if (pct > TREND_PCT) return 'sube';
  if (pct < -TREND_PCT) return 'baja';
  return 'igual';
}

/** Las `top` más lentas por mediana de sus últimas 5 mediciones. */
function slow(runs, { top = 20 } = {}) {
  const per = new Map();
  for (const r of runs) for (const x of r.suites) {
    if (!x || typeof x.s !== 'string' || typeof x.ms !== 'number') continue;
    if (!per.has(x.s)) per.set(x.s, []);
    per.get(x.s).push(x.ms);
  }
  const rows = [...per.entries()].map(([s, ms]) => ({ s, mediana: median(ms.slice(-5)), max: Math.max(...ms), n: ms.length, tendencia: trend(ms) }));
  rows.sort((a, b) => b.mediana - a.mediana || (a.s < b.s ? -1 : 1));
  return rows.slice(0, top);
}

/** Una línea por corrida, para `runs`. */
function runRow(r) {
  const suma = r.suites.reduce((a, x) => a + ((x && x.ms) || 0), 0);
  return { ts: r.ts, origen: r.origen, repo: r.repo, suites: r.suites.length, wall_ms: r.wall_ms, suma_ms: suma,
    workers: r.workers, nucleos: r.nucleos, carga: r.carga, ...(r.cortada ? { cortada: true } : {}) };
}

module.exports = { target, headOf, machine, append, entryOf, fromTsv, routesByName, readSources, filterRuns, median, trend, slow, runRow,
  MARK, MAX_RUNS, LOCK_WAIT_MS, LOCK_STALE_MS };
