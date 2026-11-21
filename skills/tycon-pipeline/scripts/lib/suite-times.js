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
 * EL RENGLÓN: { v, ts, origen, repo, head, workers, nucleos, carga, wall_ms, cortada?, fingida?, suites: [{ s, ms, exit }] }.
 * `fingida`: núcleos y carga de TYCON_FAKE_MACHINE, no de la máquina.
 * `s` es la `ruta` de suites.json. La carga es la de 1 min al arrancar.
 *
 * DOS A LA VEZ: agregar y rotar van bajo un candado (`<archivo>.lock`, creado exclusivo). Un candado de más de 60 s se
 * toma como abandonado; sin candado en 10 s no se anota y se dice. El archivo se queda con las últimas 200 corridas, y
 * se reescribe entero en un temporal que después se renombra: nunca queda a medio escribir.
 *
 * LEER (`readSources`): archivos y carpetas. Un renglón JSON se lee entero; uno con la marca `SUITE-TIMES ` (el que
 * las portables imprimen en el registro de la CI de GitHub) se lee desde la marca, aunque traiga la hora delante. Un
 * renglón que parece del registro y no se deja leer se cuenta como ilegible; el resto de un registro se ignora.
 *
 * CUÁNTAS A LA VEZ (`workersFor`, la usan el portón y las portables): fuera de la CI y sin variable,
 * min(núcleos − 2, núcleos − carga), con piso 1; la carga es la de antes de lanzar ninguna, la ajena. Antes de cada
 * suite, con la carga sobre el doble de los núcleos y otra propia corriendo, se espera mirando cada 5 s
 * (`waitForRoom`). Con la variable o en la CI, la regla de antes y sin espera. `TYCON_FAKE_MACHINE=<núcleos>/<carga>`
 * finge la máquina en las pruebas que lanzan un proceso.
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
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short=12', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// La máquina de mentira de las pruebas que lanzan un proceso: TYCON_FAKE_MACHINE=<núcleos>/<carga>[/<carga después>].
// La tercera cifra es la carga que ve la espera después del arranque. Un valor que no tiene esa forma se dice.
function fakeMachine(env) {
  const raw = String((env && env.TYCON_FAKE_MACHINE) || '').trim();
  if (!raw) return null;
  const m = /^([1-9]\d*)\/(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(raw);
  if (!m) return { invalid: raw };
  return { nucleos: Number(m[1]), carga: Number(m[2]), despues: m[3] === undefined ? Number(m[2]) : Number(m[3]) };
}

/** Núcleos y carga de 1 min, medidos ahora. */
function machine(env = process.env) {
  const fake = fakeMachine(env);
  if (fake && !fake.invalid) return { nucleos: fake.nucleos, carga: fake.carga, fake: true };
  const nucleos = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const real = { nucleos, carga: Math.round(os.loadavg()[0] * 100) / 100 };
  if (fake) real.warning = `TYCON_FAKE_MACHINE=«${fake.invalid}» no es <núcleos>/<carga>[/<carga después>]: uso la máquina real`;
  return real;
}

/** La carga de 1 min de ahora (la de mentira si la hay). */
function loadNow(env = process.env) {
  const fake = fakeMachine(env);
  return fake && !fake.invalid ? fake.despues : os.loadavg()[0];
}

/** ¿Corre en la CI? GitHub (GITHUB_ACTIONS), Azure (TF_BUILD) o cualquiera que ponga CI. */
function isCI(env = process.env) {
  return ['CI', 'TF_BUILD', 'GITHUB_ACTIONS'].some((k) => {
    const v = String(env[k] || '').trim().toLowerCase();
    return v !== '' && v !== 'false' && v !== '0';
  });
}

/** Cuántas a la vez según la máquina: dos núcleos quedan para la persona y la carga ajena se descuenta; piso 1. */
function autoWorkers({ nucleos, carga }) {
  return Math.max(floorOf(nucleos), Math.min(nucleos - 2, Math.floor(nucleos - carga)));
}

/**
 * El piso: cuatro, o núcleos menos dos en una máquina chica, y nunca menos de una. Con la máquina cargada (la carga de
 * los demás arriba de los núcleos) la regla daba una a la vez y un portón de 380 suites no terminaba nunca.
 */
function floorOf(nucleos) {
  return Math.max(1, Math.min(4, nucleos - 2));
}

/**
 * Cuántas a la vez: la variable `varName` si es un entero positivo; si no, en la CI `ciDefault` (como siempre) y fuera
 * de ella la máquina. `wait` dice si antes de cada suite se mira la carga (sólo cuando decide la máquina).
 */
function workersFor({ env = process.env, varName, maquina, ci, ciDefault }) {
  const raw = env[varName];
  let warning = null;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return { workers: n, why: 'variable', varName, wait: false, warning: null };
    warning = `${varName}=«${raw}» no es un entero positivo: uso ${ci ? `${ciDefault} (la regla de la CI)` : `${autoWorkers(maquina)} (por los núcleos y la carga)`}`;
  }
  if (ci) return { workers: ciDefault, why: 'ci', varName, wait: false, warning };
  const floor = floorOf(maquina.nucleos);
  const byFloor = Math.min(maquina.nucleos - 2, Math.floor(maquina.nucleos - maquina.carga)) < floor;
  return { workers: autoWorkers(maquina), why: 'maquina', varName, wait: true, warning, floor, byFloor };
}

/** La carga pasa el doble de los núcleos: el doble porque la carga ya cuenta las suites propias y sus procesos. */
function overloaded(nucleos, carga) {
  return carga > 2 * nucleos;
}

/**
 * Antes de lanzar una suite: mientras la carga pase el doble y queden corriendo `floor` propias o más, vuelve a mirar
 * cada `intervalMs`: el piso sale siempre. Devuelve los ms que esperó (0 si no esperó).
 */
async function waitForRoom({ nucleos, load, others, sleep, floor = 1, intervalMs = 5000, stopped = () => false }) {
  let ms = 0;
  while (!stopped() && others() >= floor && overloaded(nucleos, load())) {
    await sleep(intervalMs);
    ms += intervalMs;
  }
  return ms;
}

/** La línea de ambiente: «N a la vez (<núcleos> núcleos, carga <c> al arrancar)», con quién decidió si no fue la máquina. */
function describeWorkers({ workers, why, varName, byFloor }, { nucleos, carga, fake }, platform = process.platform) {
  const por = why === 'variable' ? ` por ${varName}` : why === 'ci' ? ' por la CI' : (byFloor ? ', el piso' : '');
  const c = fake || platform !== 'win32' ? `carga ${carga} al arrancar` : 'Windows no da la carga';
  return `${workers} a la vez${por} (${nucleos} núcleos, ${c})${fake ? ' · máquina fingida por TYCON_FAKE_MACHINE' : ''}`;
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
function entryOf({ origen, repo, head, workers, nucleos, carga, wallMs, cortada, fingida, suites, ts = new Date().toISOString() }) {
  const e = { v: 1, ts, origen, repo, head: head || null, workers, nucleos, carga, wall_ms: wallMs,
    suites: suites.map((x) => ({ s: x.s, ms: x.ms, exit: x.exit })) };
  if (cortada) e.cortada = true;
  // núcleos y carga de TYCON_FAKE_MACHINE: el renglón no pasa por uno de la máquina real
  if (fingida) e.fingida = true;
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

// Una corrida con la máquina fingida (TYCON_FAKE_MACHINE) no mide esta máquina: no entra a medianas ni tendencias.
function filterRuns(runs, { origen = null, maxLoad = null } = {}) {
  return runs.filter((r) => !r.fingida && (!origen || r.origen === origen) && (maxLoad === null || (typeof r.carga === 'number' && r.carga <= maxLoad)));
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

/**
 * Cuánto va a tardar una corrida de `rutas` con `workers` a la vez: la mediana de las últimas 5 mediciones de cada suite
 * en `runs` (o `defaultMs` sin medición), sumadas y repartidas entre los carriles. `{ ms, medidas, sinMedir }`.
 */
function estimateMs({ rutas, workers, runs, defaultMs }) {
  const per = new Map();
  for (const r of runs || []) for (const x of (r && r.suites) || []) {
    if (!x || typeof x.s !== 'string' || typeof x.ms !== 'number') continue;
    if (!per.has(x.s)) per.set(x.s, []);
    per.get(x.s).push(x.ms);
  }
  let suma = 0;
  let medidas = 0;
  for (const s of rutas) {
    const ms = per.get(s);
    if (ms && ms.length) { suma += median(ms.slice(-5)); medidas += 1; } else suma += defaultMs;
  }
  return { ms: Math.round(suma / Math.max(1, workers)), medidas, sinMedir: rutas.length - medidas };
}

// ── El aviso del portón lento ─────────────────────────────────────────────────────────────────────────────────────
// Un portón grande que arranca con menos de 3 a la vez deja `<estado>/slow-gates/<pid>.json` mientras corre: lo lee el
// aviso de cada turno de la coordinadora (scripts/tools/coordination.js). Lleva la hora de arranque del proceso: un
// número de proceso reusado por otro programa no cuenta como el portón.
const SLOW_GATE_WORKERS = 3;
const slowGatesDir = (home) => path.join(stateDir(home), 'slow-gates');

/** La hora de arranque de un proceso según el sistema, o null (Windows, o el proceso no está). */
function processStart(pid) {
  if (process.platform === 'win32') return null;
  // con el idioma y la zona fijos: quien escribe el aviso y quien lo lee pueden tener otro ambiente
  const env = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo(process.env, { TZ: 'UTC' });
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { windowsHide: true, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function writeSlowGate(entry, home) {
  const dir = slowGatesDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ ...entry, pid: process.pid, procStart: processStart(process.pid) })}\n`);
  return file;
}

/** Los avisos de los portones lentos vivos; los de un proceso que ya no está (o con otra hora de arranque) se borran. */
function readSlowGates(home, { alive = (e) => {
  try { process.kill(e.pid, 0); } catch (err) { if (err.code !== 'EPERM') return false; }
  return !e.procStart || processStart(e.pid) === e.procStart;
} } = {}) {
  const dir = slowGatesDir(home);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let e = null;
    try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* uno a medio escribir o roto: no cuenta */ }
    if (e && Number.isInteger(e.pid) && alive(e)) out.push(e);
    else if (e) { try { fs.rmSync(file, { force: true }); } catch (_) { /* lo borra la próxima */ } }
  }
  return out;
}

/** Una línea por corrida, para `runs`. */
function runRow(r) {
  const suma = r.suites.reduce((a, x) => a + ((x && x.ms) || 0), 0);
  return { ts: r.ts, origen: r.origen, repo: r.repo, suites: r.suites.length, wall_ms: r.wall_ms, suma_ms: suma,
    workers: r.workers, nucleos: r.nucleos, carga: r.carga, ...(r.cortada ? { cortada: true } : {}) };
}

module.exports = { target, headOf, machine, loadNow, isCI, autoWorkers, floorOf, workersFor, overloaded, waitForRoom, describeWorkers, append, entryOf, fromTsv, routesByName, readSources, filterRuns, median, trend, slow, runRow,
  estimateMs, writeSlowGate, readSlowGates, slowGatesDir, processStart, SLOW_GATE_WORKERS,
  MARK, MAX_RUNS, LOCK_WAIT_MS, LOCK_STALE_MS };
