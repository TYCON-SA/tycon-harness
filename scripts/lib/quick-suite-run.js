#!/usr/bin/env node
'use strict';
/**
 * scripts/lib/quick-suite-run.js — corre la suite rápida del arranque sin trabar la máquina.
 *
 * Qué hace. El aplicador corre en cada arranque de cada sesión, y con él unas suites rápidas de las skills. Este guion
 * las corre con tres reglas:
 *   · versión: si lo vigilado (`--watch`, una o más carpetas) no cambió desde la última corrida VERDE, no corre. Una
 *     corrida roja, cortada o muerta no cuenta: el arranque siguiente la vuelve a correr;
 *   · tope: a lo sumo la mitad de los núcleos a la vez, mínimo 1;
 *   · candado: una sola corrida por máquina. Con el candado tomado por un proceso vivo, sale 0 sin esperar ni correr y
 *     lo deja escrito en `<state-dir>/quick-suite.log`. Un candado de un proceso muerto se toma.
 *
 * Por qué. Corrían enteras en cada arranque, un proceso por suite y sin candado: medido en una Mac, 15 s y 440 MB por
 * arranque; con cinco sesiones abriendo juntas, treinta procesos.
 *
 * Uso: node quick-suite-run.js --state-dir <carpeta> --watch <carpeta> [--watch <carpeta>…] <suite.test.js>…
 * Sale 0 (verde, ya probada o la corre otra sesión), 1 (roja o cortada) o 2 (mal llamado).
 * `TYCON_QUICK_SUITE_CORES` existe sólo para las pruebas: hace de cuenta que la máquina tiene esos núcleos.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const LOCK = 'quick-suite.lock';
const STAMP = 'quick-suite-ok';
const LOG = 'quick-suite.log';
const LOG_MAX_BYTES = 256 * 1024;
// un candado sin pid es uno que se está creando; pasado este tiempo, quedó así porque el proceso murió en el medio
const LOCK_NO_PID_MS = 2 * 60 * 1000;

function parseArgs(argv) {
  const o = { stateDir: null, watch: [], files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') o.stateDir = argv[++i];
    else if (argv[i] === '--watch') o.watch.push(argv[++i]);
    else o.files.push(argv[i]);
  }
  return o.stateDir && o.watch.length && o.files.length && !o.watch.includes(undefined) ? o : null;
}

/** Huella de lo vigilado: ruta, tamaño y fecha de cada archivo, más la lista de suites y la versión de Node. */
function fingerprint(watch, files) {
  const h = crypto.createHash('sha1');
  h.update(`${process.version}\n${files.join('\n')}\n`);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { h.update(`sin ${dir}\n`); return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { const s = fs.statSync(p); h.update(`${p}|${s.size}|${s.mtimeMs}\n`); } catch (_) { /* se fue en el medio */ } }
    }
  };
  for (const w of watch) walk(path.resolve(w));
  return h.digest('hex');
}

function logLine(stateDir, text) {
  const f = path.join(stateDir, LOG);
  try {
    if (fs.statSync(f).size > LOG_MAX_BYTES) fs.writeFileSync(f, '');
  } catch (_) { /* todavía no existe */ }
  try { fs.appendFileSync(f, `${new Date().toISOString()} ${text}\n`); } catch (_) { /* el registro no es imprescindible */ }
}

function alive(pid) {
  if (!/^\d+$/.test(pid || '')) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Toma el candado. Devuelve null si lo tomó, o el pid de quien lo tiene. */
function takeLock(stateDir) {
  const dir = path.join(stateDir, LOCK);
  for (let intento = 0; intento < 2; intento++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let pid = '';
    try { pid = fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim(); } catch (_) { /* sin pid todavía */ }
    if (alive(pid)) return pid;
    if (!pid) {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch (_) { /* lo soltaron en el medio */ }
      if (age < LOCK_NO_PID_MS) return '?';
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return '?';
}

function releaseLock(stateDir) {
  const dir = path.join(stateDir, LOCK);
  try {
    if (fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim() === String(process.pid)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ya no está */ }
}

function cap() {
  const fake = Number(process.env.TYCON_QUICK_SUITE_CORES);
  const cpus = fake > 0 ? fake : (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  return Math.max(1, Math.floor(cpus / 2));
}

/** `--test-concurrency` llegó en Node 20.10 y 21. */
function knowsConcurrency() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 20 || (maj === 20 && min >= 10);
}

let child = null;
function run(args) {
  return new Promise((resolve) => {
    // corrido desde dentro de otro `node --test`, la variable le diría a este que reporte al de afuera en vez de correr
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, args, { stdio: 'ignore', env });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code === 0 ? 0 : 1));
  });
}

async function runSuites(files) {
  const n = cap();
  if (knowsConcurrency()) return run(['--test', `--test-concurrency=${n}`, ...files]);
  // un Node sin el tope: de a una
  let rc = 0;
  for (const f of files) rc = (await run(['--test', f])) || rc;
  return rc;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o) { process.stderr.write('uso: node quick-suite-run.js --state-dir <carpeta> --watch <carpeta>… <suite.test.js>…\n'); return 2; }
  fs.mkdirSync(o.stateDir, { recursive: true });
  const print = fingerprint(o.watch, o.files);
  let done = '';
  try { done = fs.readFileSync(path.join(o.stateDir, STAMP), 'utf8').trim(); } catch (_) { /* nunca salió verde */ }
  if (done === print) return 0;
  const holder = takeLock(o.stateDir);
  if (holder) { logLine(o.stateDir, `otra sesión (pid ${holder}) está corriendo la suite rápida: este arranque no la corre`); return 0; }
  const cut = (sig) => { if (child) child.kill(sig); releaseLock(o.stateDir); process.exit(1); };
  process.on('SIGTERM', () => cut('SIGTERM'));
  process.on('SIGINT', () => cut('SIGINT'));
  process.on('SIGHUP', () => cut('SIGHUP'));
  try {
    const rc = await runSuites(o.files);
    if (rc === 0) fs.writeFileSync(path.join(o.stateDir, STAMP), `${print}\n`);
    else { try { fs.rmSync(path.join(o.stateDir, STAMP), { force: true }); } catch (_) { /* no estaba */ } }
    return rc;
  } finally {
    releaseLock(o.stateDir);
  }
}

if (require.main === module) main().then((rc) => process.exit(rc), (e) => { process.stderr.write(`quick-suite-run: ${e.message}\n`); process.exit(1); });

module.exports = { fingerprint, cap };
