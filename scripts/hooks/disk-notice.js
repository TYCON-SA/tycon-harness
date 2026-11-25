#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * disk-notice.js — con el disco casi lleno, el arranque dice cuánto queda y qué lo llena, con el comando que limpia
 * cada cosa.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────────────────────
 * Las pruebas de navegador bajan navegadores, Docker guarda imágenes, los cachés de npm, NuGet y Homebrew crecen y cada
 * carpeta de trabajo trae sus node_modules. Nada de eso es del arnés, pero llena el disco de la máquina donde corre, y
 * con el disco lleno fallan las pruebas y los commits sin decir por qué.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Al arrancar sesión mira el disco de la carpeta del usuario. Si lo libre está por debajo de
 * `maintenance.disk_warn_percent` (15 % si el perfil no dice otra cosa), dice cuánto queda y las cinco cosas de la
 * lista conocida (`disk-hogs.json`) que más ocupan, cada una con su tamaño y su comando de limpieza. Por encima, calla.
 * Lo libre se mira en cada arranque. Las cosas de la lista se miden una vez por día, con un tope de 2 segundos cada
 * una, y el resto del día se repite esa medición. La que no se pudo medir sale «no medido», nunca 0; la que no está en
 * la máquina no se nombra.
 *
 * ── LO QUE NUNCA HACE ────────────────────────────────────────────────────────────────────────────────────────────
 * Correr un comando de limpieza o borrar algo: nada de la lista es del arnés, y quien decide qué se borra es la persona.
 *
 * El disco, con fs.statfs. El tamaño, con `du` en Mac y Linux, y recorriendo la carpeta en Windows.
 * Apagar: TYCON_DISK_NOTICE=0. Medir de nuevo aunque ya se midió hoy: --force. Para las pruebas, el disco:
 * TYCON_DISK_NOTICE_TEST_DISK=<libre>/<total>, en bytes. Fail-open: un hook de arranque nunca frena ni tira.
 *
 * Casos: scripts/tests/disk-notice.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOGS_FILE = path.join(__dirname, 'disk-hogs.json');
const STATE_NAME = 'disk-notice-last.json';
const MEASURE_TIMEOUT_MS = 2 * 1000;
const DEFAULT_PERCENT = 15;
const SHOWN = 5;
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function loadHogs(file = HOGS_FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(j.hogs) ? j.hogs : [];
}

/** Las cosas de la lista que se miden en `platform`, con sus rutas y su comando de ese sistema. */
function hogsFor(platform, hogs) {
  const out = [];
  for (const h of hogs) {
    const paths = h && h.paths && Array.isArray(h.paths[platform]) ? h.paths[platform] : [];
    if (!paths.length) continue;
    const clean = typeof h.clean === 'string' ? h.clean : (h.clean && h.clean[platform]) || '';
    out.push({ id: h.id, name: h.name, paths, clean });
  }
  return out;
}

/**
 * Las rutas que existen para una ruta de la lista: `~`, `%LOCALAPPDATA%` y `{repos}` reemplazados, y un `*` dentro de
 * un tramo buscado en su carpeta. Sin la raíz de los repos, una ruta con `{repos}` no da ninguna.
 */
function expand(p, { home, env = process.env, reposRoot = null }) {
  let s = p.replace(/^~(?=\/|$)/, home);
  s = s.replace(/%LOCALAPPDATA%/g, env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
  if (s.includes('{repos}')) { if (!reposRoot) return []; s = s.replace(/\{repos\}/g, reposRoot); }
  const parts = s.split(/[\\/]/);
  let found = [parts[0] === '' ? path.sep : parts[0]];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    if (!part.includes('*')) { found = found.map((d) => path.join(d, part)); continue; }
    const re = new RegExp(`^${part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    found = found.flatMap((d) => { try { return fs.readdirSync(d).filter((n) => re.test(n)).map((n) => path.join(d, n)); } catch (_) { return []; } });
  }
  return found.filter((f) => { try { fs.lstatSync(f); return true; } catch (_) { return false; } });
}

/** Lo que ocupan las rutas, en bytes, con `du`; null si no se pudo medir. */
function measureDu(paths) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn('du', ['-sk', ...paths], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch (_) { resolve(null); return; }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code, signal) => {
      const lines = out.split('\n').filter(Boolean);
      // du sale 1 si alguna carpeta de adentro no se dejó leer: el total de cada ruta sirve igual
      if (signal || lines.length < paths.length || (code !== 0 && code !== 1)) { resolve(null); return; }
      resolve(lines.reduce((n, l) => n + Number(l.split(/\s/)[0]) * 1024, 0));
    });
    measureDu.children.add(child);
    child.on('close', () => measureDu.children.delete(child));
  });
}
measureDu.children = new Set();

/** Lo que ocupan las rutas recorriéndolas (Windows, sin `du`), sin seguir enlaces; null si se acaba el tiempo. */
function measureWalk(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let total = 0;
  const stack = paths.slice();
  while (stack.length) {
    if (Date.now() >= deadline) return Promise.resolve(null);
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch (_) { continue; }
    if (st.isSymbolicLink()) continue;
    if (!st.isDirectory()) { total += st.size; continue; }
    try { for (const k of fs.readdirSync(cur)) stack.push(path.join(cur, k)); } catch (_) { /* no se deja leer: queda afuera */ }
  }
  return Promise.resolve(total);
}

function defaultMeasure(platform) {
  return platform === 'win32' ? measureWalk : measureDu;
}

/** Cada cosa medida a la vez, con su tope: `[{ id, name, clean, bytes }]`; `bytes` null es «no medido». */
async function measureAll(items, { measure, timeoutMs = MEASURE_TIMEOUT_MS }) {
  return Promise.all(items.map((it) => {
    let timer;
    const tope = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const medida = Promise.resolve().then(() => measure(it.found, timeoutMs)).catch(() => null);
    return Promise.race([medida, tope]).then((bytes) => {
      clearTimeout(timer);
      return { id: it.id, name: it.name, clean: it.clean, bytes: Number.isFinite(bytes) ? bytes : null };
    });
  }));
}

function size(b) {
  if (b >= 10 * GB) return `${Math.round(b / GB)} GB`;
  if (b >= GB) return `${(b / GB).toFixed(1).replace('.', ',')} GB`;
  return `${Math.max(1, Math.round(b / MB))} MB`;
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * La línea del aviso: lo libre, las cinco que más ocupan y sus comandos. Las que no se pudieron medir van siempre, al
 * final: la que no terminó a tiempo puede ser justo la más grande.
 */
function noticeLine({ disk, threshold, items, measuredAt }) {
  const pct = Math.round((disk.free / disk.total) * 100);
  const medidas = items.filter((i) => i.bytes !== null && i.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const sinMedir = items.filter((i) => i.bytes === null);
  const shown = [...medidas.slice(0, SHOWN), ...sinMedir];
  const cosas = shown.map((i) => `${i.name} ${i.bytes === null ? 'no medido' : size(i.bytes)} (${i.clean})`).join(' · ');
  const lista = cosas
    ? ` Lo que más ocupa de lo conocido: ${cosas}. El arnés no corre ninguno de esos comandos: elegí vos qué limpiar (medido hoy a las ${hhmm(measuredAt)}).`
    : ' Nada de la lista conocida ocupa lugar en esta máquina.';
  return `⚠️ disco: quedan ${size(disk.free)} libres de ${size(disk.total)} (${pct} %), menos del ${threshold} %.${lista} Apagar: TYCON_DISK_NOTICE=0`;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

/**
 * El aviso de un arranque: `{ line, measured }`. `line` null con el disco por encima del umbral. Mide las cosas de la
 * lista sólo si hoy no se midieron (`stateFile` guarda la medición del día), salvo con `force`.
 */
async function run({ home, env = process.env, now = Date.now(), platform = process.platform, disk, threshold = DEFAULT_PERCENT, hogs, measure, stateFile, reposRoot = null, timeoutMs = MEASURE_TIMEOUT_MS, force = false }) {
  if (!disk || !(disk.total > 0) || (disk.free / disk.total) * 100 >= threshold) return { line: null, measured: false };
  const prev = force ? null : readJson(stateFile);
  if (prev && prev.day === dayOf(now) && Array.isArray(prev.items)) {
    return { line: noticeLine({ disk, threshold, items: prev.items, measuredAt: Date.parse(prev.at) || now }), measured: false };
  }
  const present = hogsFor(platform, hogs)
    .map((h) => ({ ...h, found: h.paths.flatMap((p) => expand(p, { home, env, reposRoot })) }))
    .filter((h) => h.found.length);
  const items = await measureAll(present, { measure: measure || defaultMeasure(platform), timeoutMs });
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ day: dayOf(now), at: new Date(now).toISOString(), items }) + '\n');
  } catch (_) { /* sin dónde guardar: mañana se mide igual, y hoy cada arranque mide de nuevo */ }
  return { line: noticeLine({ disk, threshold, items, measuredAt: now }), measured: true };
}

/** El disco de la carpeta del usuario: `{ free, total }` en bytes, o null si no se pudo saber. */
function diskOf(home, env = process.env) {
  const fake = env.TYCON_DISK_NOTICE_TEST_DISK;
  if (fake) {
    const m = /^(\d+)\/(\d+)$/.exec(fake.trim());
    return m ? { free: Number(m[1]), total: Number(m[2]) } : null;
  }
  try { const s = fs.statfsSync(home); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (_) { return null; }
}

/** El umbral: `maintenance.disk_warn_percent` del perfil (o de la máquina); sin el lector, o si falla, el de fábrica. */
function threshold() {
  const lib = path.join(__dirname, '..', 'lib', 'tycon-config.js');
  try {
    if (fs.existsSync(lib)) {
      const tc = require(lib);
      const r = tc.leerParaHook({});
      if (r.ok) return tc.mantenimiento(r.config).disk_warn_percent.value;
    }
  } catch (_) { /* fail-open: el de fábrica */ }
  return DEFAULT_PERCENT;
}

function reposRootOf() {
  try { return require(path.join(__dirname, '..', 'lib', 'repos-root.js')).resolveReposRoot().root || null; } catch (_) { return null; }
}

async function main() {
  if (process.env.TYCON_DISK_NOTICE === '0' || process.env.TYCON_EVAL_SANDBOX === '1') return;
  const home = os.homedir();
  const disk = diskOf(home);
  if (!disk) return;
  const pct = threshold();
  if ((disk.free / disk.total) * 100 >= pct) return;
  const { stateDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
  const r = await run({ home, disk, threshold: pct, hogs: loadHogs(), stateFile: path.join(stateDir(home), STATE_NAME), reposRoot: reposRootOf(), force: process.argv.includes('--force') });
  if (r.line) process.stdout.write(r.line + '\n');
}

if (require.main === module) {
  // un hook de arranque nunca frena una sesión; si el aviso falló, lo dice en una línea
  main().catch((e) => {
    try { process.stdout.write(`⚠️ disco: el aviso falló (${String((e && e.message) || e).split('\n')[0]}). Apagar: TYCON_DISK_NOTICE=0\n`); } catch (_) { /* sin salida */ }
  }).finally(() => {
    // una medición cortada por su tope no deja procesos colgados
    for (const c of measureDu.children) { try { c.kill('SIGKILL'); } catch (_) { /* ya terminó */ } }
    process.exitCode = 0;
  });
}

module.exports = { loadHogs, hogsFor, expand, measureAll, measureDu, measureWalk, noticeLine, run, diskOf, MEASURE_TIMEOUT_MS };
