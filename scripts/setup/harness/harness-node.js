#!/usr/bin/env node
'use strict';
// harness-node.js — el Node propio del arnés: bajarlo, verificarlo, enlazarlo, decidir con qué intérprete
// se escriben los hooks y decirlo en `doctor`.
//
// ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// Un hook registrado como `node "<guion>"` arranca con el primer `node` del PATH de la herramienta:
// el que tenga la máquina (una versión que la CI pública puede no probar) y que nadie mira. El arnés
// baja y mantiene su propio Node 24, en Mac, Linux y Windows, y lo usan sus hooks y sus
// guiones; los proyectos del dev siguen con el suyo. Por eso este módulo NUNCA toca el PATH: escribe la ruta del Node en
// el comando de cada hook.
//
// ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//   · La lista: scripts/production/node-official.json DEL ÁRBOL QUE CORRE (la misma del freno de producción). La huella del
//     comprimido (o del .exe) y la del binario que trae (`node_sha256`) salen de ahí, nunca del servidor.
//   · `ensure` baja la versión de la lista si `current` no la tiene: un HIJO (`--fetch`) la baja con http-get.js
//     (respeta HTTPS_PROXY/NO_PROXY) directo a un archivo, con su tope (180 s, el del freno); se comparan las dos huellas,
//     se corre `<binario> --version`, todo en `<casa>/node/.incoming-<pid>/`, que recién al final pasa a
//     `versions/<v>/` por cambio de nombre; una versión rota que ya estaba ahí se aparta a `trash/`. Después `current`
//     pasa a ella con `pointLink` (en Windows un node.exe en uso no se pisa: se baja al lado y se cambia la unión).
//     Se guardan la de `current` y la anterior; las más viejas se borran en la corrida siguiente.
//   · Cuando no puede, nunca deja la máquina sin arnés: anota el motivo y el arnés sigue con el `node` del PATH.
//     En el arranque, tras una falla de red espera 6 horas; un binario que no arranca en la máquina queda
//     «incompatible» con esa versión y el arranque no la vuelve a bajar. A mano (`install`, `update`,
//     `apply`) se intenta siempre. El arranque que corre en el lugar (dentro del tope del hook) no baja nada.
//   · `interpreter` decide, MIRANDO EL DISCO, con qué se escribe cada hook `.js`: la ruta de `current` si
//     arranca y dice la versión de la lista, en la forma de `formFor`; si no, `node`. La usan el aplicador de Claude Code,
//     el de Codex y la paridad: si decidiera una variable, cada corrida sin ella devolvería los hooks a `node`.
//   · `doctorFacts` arma la línea y la clave `harness_node` de `doctor`: nunca un rojo.
//
// El registro (último intento, última falla, incompatible, la versión anterior) vive en `<estado>/harness/
// harness-node.json`, aparte de harness-state.json: lo escribe `runApplierOnly`, que corre dentro de comandos que ya
// tienen el estado en memoria y lo escriben después (lo pisarían). Mismo motivo que update-failures.json.
//
// Viaja en la copia fija del programa (scripts/setup/harness/): http-get.js y tar-reader.js se cargan del árbol al usarlos.
// Apagado: TYCON_HARNESS_NODE=0 (no baja nada, los hooks quedan con `node`, doctor lo dice como dato).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const TH = require('./tycon-home.js');

const DEFAULT_TREE = path.resolve(__dirname, '..', '..', '..');
const LIST_REL = ['scripts', 'production', 'node-official.json'];
const FETCH_BUDGET_S = 180;                     // el tope del freno (`curl --max-time 180`), aparte del de la actualización
const MAX_BYTES = 160 * 1024 * 1024;            // el node.exe de win-x64 pesa ~94 MB
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;      // en el arranque, tras una falla de red
const PROBE_MS = 5000;
const MANIFEST = '.tycon-node.json';
const RECORD = 'harness-node.json';
// la forma sin comillas
const BARE_POSIX = /^[A-Za-z0-9._/+-]+$/;
const BARE_WIN = /^[A-Za-z]:\/[A-Za-z0-9._/+-]+$/;
const UNSAFE = /[$`"]/;
// La medición de la forma en Windows: la forma sin comillas por los cinco lanzadores (`bash-c`, `bash-file`,
// `pwsh-command`, `pwsh-file`, `default-shell`). Medida en verde con scripts/tests/windows/node-form-spike.js: los
// cinco salen igual que con `node "<guion>"` y corren con el node.exe de la ruta. Si una medición futura sale mal,
// `measured: false` deja a toda Windows con `node "<guion>"`.
const WINDOWS_FORM = Object.freeze({ measured: true, run: 13608 });

const fwd = (p) => String(p).replace(/\\/g, '/');
const nowIso = () => new Date().toISOString();
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const isOff = (env) => String((env || process.env).TYCON_HARNESS_NODE || '') === '0';

// ── la lista ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `{ ok, list }` o `{ ok: false, reason }`. Ilegible nunca es «no hace falta». */
function readList(tree = DEFAULT_TREE) {
  const file = path.join(tree, ...LIST_REL);
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) {
    return { ok: false, reason: `no pude leer node-official.json: ${e.code === 'ENOENT' ? `no está en ${file}` : e.message}` };
  }
  if (!j || typeof j.version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(j.version) || typeof j.base_url !== 'string' || !j.files || typeof j.files !== 'object') {
    return { ok: false, reason: 'no pude leer node-official.json: le falta version, base_url o files' };
  }
  return { ok: true, list: j };
}

/** La clave de la plataforma en la lista: `darwin-arm64`, `linux-x64`, `win-x64`… y si Linux trae glibc. */
function platformKey({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const head = platform === 'win32' ? 'win' : platform;
  const key = `${head}-${arch}`;
  let glibc = true;
  if (platform === 'linux') {
    if (String(env.TYCON_HARNESS_NODE_NO_GLIBC || '') === '1') glibc = false;   // sólo pruebas: un Linux sin glibc
    else {
      try { glibc = Boolean(process.report && process.report.getReport().header.glibcVersionRuntime); } catch (_) { glibc = false; }
    }
  }
  return { key, glibc, label: glibc ? key : `${key} sin glibc` };
}

/** La entrada completa de esa plataforma, o null (sin entrada, o sin los campos que hacen falta). */
function entryFor(pk, list) {
  if (!pk.glibc) return null;
  const e = list && list.files && list.files[pk.key];
  if (!e || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return null;
  if (pk.key.startsWith('win-')) return typeof e.exe === 'string' ? { kind: 'exe', file: e.exe, sha256: e.sha256, binarySha: e.sha256 } : null;
  if (typeof e.tar !== 'string' || typeof e.node_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.node_sha256)) return null;
  return { kind: 'tar', file: e.tar, sha256: e.sha256, binarySha: e.node_sha256 };
}

/** Por qué no hay entrada: la plataforma no está (o es un Linux sin glibc), o está a medias (una lista vieja). */
function noEntryReason(pk, list) {
  if (pk.glibc && list && list.files && list.files[pk.key]) return `la entrada de esta plataforma (${pk.label}) en node-official.json está incompleta (le falta la huella del binario o el archivo)`;
  return `esta plataforma (${pk.label}) no tiene Node oficial en la lista`;
}

// ── el binario ───────────────────────────────────────────────────────────────────────────────────────────────────────
const probeCache = new Map();
/** `<bin> --version` en menos de 5 s: `{ ok, version }` o `{ ok: false, reason }`. */
function probe(bin, { cache = true } = {}) {
  if (cache && probeCache.has(bin)) return probeCache.get(bin);
  let out;
  if (!fs.existsSync(bin)) out = { ok: false, reason: `no está ${bin}` };
  else {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: PROBE_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const said = String(r.stdout || '').trim();
    if (r.error) out = { ok: false, reason: `no arranca (${r.error.code || r.error.message})` };
    else if (r.status !== 0 || !/^v\d+\.\d+\.\d+$/.test(said)) out = { ok: false, reason: `no arranca (salió ${r.status === null ? 'matado' : r.status}${String(r.stderr || said).trim() ? `: ${String(r.stderr || said).trim().split('\n')[0].slice(0, 200)}` : ''})` };
    else out = { ok: true, version: said };
  }
  if (cache) probeCache.set(bin, out);
  return out;
}

// ── el intérprete de los hooks ─────────────────────────────────────────────────────────────────────────
/** La forma del comando para esa ruta: `{ prefix, form, reason }`. `prefix` es lo que va antes de `"<guion>"`. */
function formFor(bin, platform = process.platform) {
  const b = fwd(bin);
  if (platform === 'win32') {
    if (!WINDOWS_FORM.measured) return { prefix: 'node', form: 'path', reason: 'en Windows la forma sin comillas todavía no se midió en verde: los hooks .js quedan con el Node del PATH' };
    if (BARE_WIN.test(b)) return { prefix: b, form: 'own', reason: null };
    return { prefix: 'node', form: 'path', reason: 'el Node del arnés está, pero la ruta de esta carpeta no se puede escribir en un comando que corra en todos los intérpretes de Windows' };
  }
  if (BARE_POSIX.test(b)) return { prefix: b, form: 'own', reason: null };
  if (UNSAFE.test(b)) return { prefix: 'node', form: 'path', reason: `la ruta del Node del arnés tiene un carácter que un shell leería distinto (${b.match(UNSAFE)[0]}): los hooks quedan con el Node del PATH` };
  return { prefix: `"${b}"`, form: 'own-quoted', reason: null };
}

/**
 * Con qué intérprete se escriben los hooks `.js`, mirando el disco: `current` arranca y dice la versión de la lista.
 * `TYCON_NODE_BIN` (la pone harness.js en el ambiente del aplicador, después de `ensure`) es sólo un atajo para no
 * volver a preguntar: tiene que nombrar el mismo binario.
 * → `{ own, present, prefix, form, bin, version, expected, switch, reason }`
 */
function interpreter({ tree = DEFAULT_TREE, env = process.env, platform = process.platform } = {}) {
  const out = { own: false, present: false, prefix: 'node', form: 'path', bin: null, version: null, expected: null, switch: isOff(env) ? 'off' : 'on', reason: null };
  if (out.switch === 'off') return Object.assign(out, { reason: 'apagado (TYCON_HARNESS_NODE=0)' });
  // una TYCON_HOME vacía o relativa no tiene casa: el Node del PATH, con el motivo (como harness-node.sh y bootstrap.js);
  // nunca tumba al aplicador, que no tiene por qué mirar la casa
  let p;
  try { p = TH.harnessNode({ env, platform }); } catch (e) { return Object.assign(out, { reason: `sin casa del arnés (${e.message})` }); }
  out.bin = fwd(p.bin);
  const L = readList(tree);
  if (!L.ok) return Object.assign(out, { reason: L.reason });
  out.expected = L.list.version;
  const shortcut = env.TYCON_NODE_BIN && fwd(env.TYCON_NODE_BIN) === fwd(p.bin);
  const pr = shortcut ? { ok: true, version: L.list.version } : probe(p.bin);
  if (!pr.ok) return Object.assign(out, { reason: `sin Node del arnés (${pr.reason})` });
  out.version = pr.version;
  if (pr.version !== L.list.version) return Object.assign(out, { reason: `el Node del arnés dice ${pr.version} y la lista pide ${L.list.version}` });
  out.present = true;
  const f = formFor(p.bin, platform);
  return Object.assign(out, { own: f.prefix !== 'node', prefix: f.prefix, form: f.form, reason: f.reason });
}

// ── el registro ──────────────────────────────────────────────────────────────────────────────────────────────────────
function recordFile() { const p = require('./state.js').paths(os.homedir()); return p.harnessNodeFile || path.join(p.harnessDir, RECORD); }
/**
 * El registro, o `{}` si todavía no hay. Uno que está y no se puede leer NO es «vacío»: vuelve `{ unreadable: <motivo> }`
 * y quien lo usa no borra nada por él (la versión anterior que guarda, `previous`, sólo la sabe el registro).
 */
function readRecord() {
  let text;
  try { text = fs.readFileSync(recordFile(), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? {} : { unreadable: e.code || e.message }; }
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : { unreadable: 'no es un objeto JSON' }; } catch (e) { return { unreadable: e.message }; }
}
function writeRecord(_ctx, rec) {
  const f = recordFile();
  const clean = Object.assign({}, rec);
  delete clean.unreadable;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // un registro que no se podía leer no se pisa: se aparta (queda para mirarlo) y el nuevo arranca de cero
  if (rec.unreadable) { try { fs.renameSync(f, `${f}.ilegible-${Date.now()}`); } catch (_) { /* ya no estaba */ } }
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(tmp, f);
}

// ── la bajada ────────────────────────────────────────────────────────────────────────────────────────────────────────
function noticeFor(reason) {
  return `el arnés corre con el Node del PATH (${process.version}): no pude bajar su Node propio (${reason}) — harness.js doctor lo detalla`;
}

/** Borra las versiones que no son la de `current` ni la anterior, y lo apartado. Una en uso (Windows) queda para otra vez. */
/** ¿Sigue vivo ese proceso? `EPERM` es «vive, de otro usuario»; sólo `ESRCH` dice que ya no está. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

/** Las carpetas de bajada `.incoming-<pid>` de procesos que ya no existen (un arranque cortado a mitad de la bajada). */
function sweepIncoming(p, log) {
  let names = [];
  try { names = fs.readdirSync(p.dir); } catch (_) { return; }
  for (const n of names) {
    const m = /^\.incoming-(\d+)$/.exec(n);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(p.dir, n), { recursive: true, force: true }); log(`node del arnés: borré ${n}, la bajada a medias de un proceso que ya no está`); } catch (e) { log(`node del arnés: ${n} no se pudo borrar (${e.code || e.message})`); }
  }
}

function cleanup(p, rec, log) {
  sweepIncoming(p, log);
  // sin `current` no se sabe cuál es la versión en uso, y con el registro ilegible no se sabe cuál es la anterior: no se
  // borra nada (una carpeta rota se aparta al instalar)
  if (!TH.linkTarget(p.current)) return;
  if (rec.unreadable) { log(`node del arnés: el registro no se pudo leer (${rec.unreadable}): no borro versiones viejas`); return; }
  // sin saber cuál es la anterior (un registro que se perdió, o que nunca la anotó) tampoco: se borra recién cuando un
  // cambio de versión la vuelva a anotar
  if (!rec.previous) return;
  const keep = new Set([path.basename(TH.linkTarget(p.current) || ''), rec.previous || ''].filter(Boolean));
  let names = [];
  try { names = fs.readdirSync(p.versions); } catch (_) { names = []; }
  for (const n of names) {
    if (keep.has(n)) continue;
    try { fs.rmSync(path.join(p.versions, n), { recursive: true, force: true }); log(`node del arnés: borré la versión vieja ${n}`); } catch (e) { log(`node del arnés: la versión vieja ${n} no se pudo borrar (${e.code || e.message}): otro arranque lo reintenta`); }
  }
  try { if (fs.existsSync(p.trash)) fs.rmSync(p.trash, { recursive: true, force: true }); } catch (e) { log(`node del arnés: lo apartado en ${p.trash} no se pudo borrar (${e.code || e.message})`); }
}

/** Baja con un hijo directo a un archivo. `{ ok, reason }`. */
function fetchToFile(url, file, { tree, env, budgetS }) {
  const r = spawnSync(process.execPath, [__filename, '--fetch', url, file, '--tree', tree, '--budget-s', String(budgetS)], { encoding: 'utf8', env, timeout: (budgetS + 10) * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? `la bajada pasó su tope de ${budgetS} s` : `no pude lanzar la bajada (${r.error.message})` };
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (_) { j = null; }
  if (!j) return { ok: false, reason: `la bajada salió ${r.status === null ? 'matada' : r.status} sin decir qué pasó` };
  return j;
}

/**
 * Deja `current` en la versión de la lista si se puede. `mode`: `manual` (install, update, apply: intenta siempre),
 * `startup` (el arranque aparte del hook: respeta las ventanas) o `none` (el arranque en el lugar: no baja nada).
 * → `{ status, reason, version, notice }`; status ∈ off · unreadable · unsupported · ok · installed · deferred · skipped · failed.
 * Nunca tira.
 */
function ensure({ tree = DEFAULT_TREE, env = process.env, platform = process.platform, arch = process.arch, mode = 'manual', log = () => {} } = {}) {
  try {
    if (isOff(env)) return { status: 'off', reason: 'apagado (TYCON_HARNESS_NODE=0)', version: null, notice: null };
    const L = readList(tree);
    if (!L.ok) return { status: 'unreadable', reason: L.reason, version: null, notice: null };
    const list = L.list;
    const pk = platformKey({ platform, arch, env });
    const entry = entryFor(pk, list);
    if (!entry) return { status: 'unsupported', reason: noEntryReason(pk, list), version: null, notice: null };
    const p = TH.harnessNode({ env, platform });
    const rec = readRecord();
    cleanup(p, rec, log);
    const cur = probe(p.bin, { cache: false });
    if (cur.ok && cur.version === list.version) {
      if (rec.last_failure || rec.incompatible) { delete rec.last_failure; delete rec.incompatible; writeRecord(null, rec); }
      return { status: 'ok', reason: null, version: cur.version, notice: null };
    }
    // un `current` que no arranca: se saca el ENLACE, nunca la carpeta; los hooks vuelven a `node`
    if (!cur.ok && TH.isLink(p.current)) { TH.removeLink(p.current); log(`node del arnés: current no arranca (${cur.reason}): saqué el enlace, la carpeta queda`); }
    // la versión de la lista ya está en versions/ y sana (la huella del binario es la de la lista y dice su versión): se
    // vuelve a enlazar sin bajar nada — es la anterior que se guarda para volver atrás. Si no está sana, la
    // bajada la aparta a trash/
    const kept = path.join(p.versions, list.version);
    if (fs.existsSync(kept)) {
      const kb = p.binIn(kept);
      let same = false;
      try { same = sha256File(kb) === entry.binarySha; } catch (_) { same = false; }
      const kp = same ? probe(kb, { cache: false }) : { ok: false };
      if (same && kp.ok && kp.version === list.version) {
        const before = TH.linkTarget(p.current);
        try {
          TH.pointLink(p.current, kept, { platform });
          if (before && path.basename(before) !== list.version) rec.previous = path.basename(before);
          delete rec.last_failure; delete rec.incompatible;
          writeRecord(null, rec);
          log(`node del arnés: ${list.version} ya estaba en ${fwd(kept)} y sano: enlazado sin bajar nada`);
          return { status: 'installed', reason: null, version: list.version, notice: null };
        } catch (e) { log(`node del arnés: no pude enlazar ${fwd(kept)} (${e.code || e.message}): se baja de nuevo`); }
      }
    }
    if (mode === 'none') return { status: 'deferred', reason: 'el arranque corre en el lugar: la bajada queda para el siguiente', version: null, notice: null };
    if (mode === 'startup') {
      if (rec.incompatible === list.version) return { status: 'skipped', reason: `el Node ${list.version} no arranca en esta máquina (se reintenta a mano o cuando cambie la lista)`, version: null, notice: noticeFor(`el Node ${list.version} no arranca en esta máquina`) };
      const at = Date.parse((rec.last_failure && rec.last_failure.at) || '');
      if (at && Date.now() - at < RETRY_AFTER_MS) return { status: 'skipped', reason: 'la última falla fue hace menos de 6 horas', version: null, notice: noticeFor(rec.last_failure.reason) };
    }
    rec.last_try = nowIso();
    const r = install({ tree, env, platform, list, entry, pk, p, log, rec });
    if (!r.ok) {
      rec.last_failure = { at: nowIso(), reason: r.reason };
      if (r.incompatible) rec.incompatible = list.version;
      try { writeRecord(null, rec); } catch (e) { log(`node del arnés: no pude anotar la falla (${e.message})`); }
      log(`node del arnés: ${r.reason}`);
      return { status: 'failed', reason: r.reason, version: null, notice: noticeFor(r.reason) };
    }
    delete rec.last_failure; delete rec.incompatible;
    writeRecord(null, rec);
    log(`node del arnés: ${list.version} bajado, verificado y enlazado (${fwd(p.current)})`);
    return { status: 'installed', reason: null, version: list.version, notice: null };
  } catch (e) {
    // un error de disco a mitad de la instalación: no queda la carpeta a medias, y se anota como cualquier falla (así el
    // arranque respeta la espera de 6 horas y doctor dice el motivo)
    const reason = `error inesperado: ${e.message}`;
    try { fs.rmSync(path.join(TH.harnessNode({ env, platform }).dir, `.incoming-${process.pid}`), { recursive: true, force: true }); } catch (_) { /* lo barre la próxima */ }
    try { const rec = readRecord(); rec.last_failure = { at: nowIso(), reason }; writeRecord(null, rec); } catch (e2) { log(`node del arnés: no pude anotar la falla (${e2.message})`); }
    log(`node del arnés: ${reason}`);
    return { status: 'failed', reason, version: null, notice: noticeFor(reason) };
  }
}

/**
 * `rename` que espera a un archivo tomado: en Windows el antivirus revisa el Node recién bajado y lo tiene abierto unos
 * segundos (EPERM, EBUSY, EACCES). Reintenta con esperas crecientes; si sigue tomado, el motivo dice qué hacer.
 * `rename` y `sleep` se inyectan en las pruebas. `{ ok, reason }`.
 */
const HELD = ['EPERM', 'EBUSY', 'EACCES'];
const HELD_STEPS = 'si se repite, cerrá VS Code, tu agente y las terminales, abrí PowerShell desde el menú Inicio y corré: npx @tyconsa/harness@latest';
function renameWaiting(from, to, { rename = fs.renameSync, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), waitsMs = [200, 500, 1000, 2000, 3000] } = {}) {
  for (let i = 0; ; i++) {
    try { rename(from, to); return { ok: true }; } catch (e) {
      if (!HELD.includes(e.code) || i >= waitsMs.length) {
        const why = `${e.code || e.message}: ${from} → ${to}`;
        return { ok: false, reason: HELD.includes(e.code) ? `${why} — un archivo está tomado (suele ser el antivirus revisando el Node recién bajado); se reintenta en el próximo arranque; ${HELD_STEPS}` : why };
      }
      sleep(waitsMs[i]);
    }
  }
}

function install({ tree, env, platform, list, entry, pk, p, log, rec }) {
  const inc = path.join(p.dir, `.incoming-${process.pid}`);
  const drop = () => { try { fs.rmSync(inc, { recursive: true, force: true }); } catch (_) { /* queda; lo barre la próxima */ } };
  const fail = (reason, extra = {}) => { drop(); return Object.assign({ ok: false, reason }, extra); };
  drop();
  fs.mkdirSync(inc, { recursive: true });
  const budgetS = Number(env.TYCON_HARNESS_NODE_BUDGET_S) > 0 ? Number(env.TYCON_HARNESS_NODE_BUDGET_S) : FETCH_BUDGET_S;
  const url = `${list.base_url.replace(/\/?$/, '/')}${list.version}/${entry.file}`;
  const file = path.join(inc, 'download');
  log(`node del arnés: bajo ${url}`);
  const f = fetchToFile(url, file, { tree, env, budgetS });
  if (!f.ok) return fail(f.reason);
  const got = sha256File(file);
  if (got !== entry.sha256) return fail(`la huella no coincide (esperaba ${entry.sha256}, vino ${got})`);
  const binDir = platform === 'win32' ? inc : path.join(inc, 'bin');
  const bin = p.binIn(inc);
  if (entry.kind === 'tar') {
    const TR = require(path.join(tree, 'scripts', 'lib', 'tar-reader.js'));
    const x = TR.extractTarGz(fs.readFileSync(file), path.join(inc, 'x'), { stripRoot: true, only: 'bin/node' });
    if (!x.ok) return fail(`el comprimido no se abre: ${x.reason}`);
    if (!fs.existsSync(path.join(inc, 'x', 'bin', 'node'))) return fail('el comprimido no trae bin/node');
    fs.mkdirSync(binDir, { recursive: true });
    fs.renameSync(path.join(inc, 'x', 'bin', 'node'), bin);
    fs.rmSync(path.join(inc, 'x'), { recursive: true, force: true });
    fs.rmSync(file, { force: true });
  } else {
    fs.renameSync(file, bin);
  }
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  const binSha = sha256File(bin);
  if (binSha !== entry.binarySha) return fail(`la huella no coincide (esperaba ${entry.binarySha}, vino ${binSha})`);
  const pr = probe(bin, { cache: false });
  if (!pr.ok) return fail(`el Node bajado no arranca en esta máquina (${pr.reason})`, { incompatible: true });
  if (pr.version !== list.version) return fail(`el Node bajado no arranca en esta máquina (dice ${pr.version}, la lista ${list.version})`, { incompatible: true });
  fs.writeFileSync(path.join(inc, MANIFEST), `${JSON.stringify({ version: list.version, platform: pk.key, file: entry.file, sha256: entry.sha256, binary_sha256: binSha, installed_at: nowIso() }, null, 2)}\n`);
  const dest = path.join(p.versions, list.version);
  fs.mkdirSync(p.versions, { recursive: true });
  let aside = null;
  if (fs.existsSync(dest)) {
    aside = path.join(p.trash, `${list.version}-${Date.now()}`);
    fs.mkdirSync(p.trash, { recursive: true });
    const ra = renameWaiting(dest, aside);
    if (!ra.ok) return fail(ra.reason);
    log(`node del arnés: ${dest} estaba y no servía: apartado a ${aside}`);
  }
  const rm = renameWaiting(inc, dest);
  if (!rm.ok) {
    // lo apartado vuelve a su lugar: el enlace `current` puede apuntar ahí, y no tiene que quedar apuntando a la nada
    if (aside && !fs.existsSync(dest)) { const back = renameWaiting(aside, dest); if (!back.ok) log(`node del arnés: no pude devolver ${aside} a ${dest} (${back.reason})`); }
    return fail(rm.reason);
  }
  const before = TH.linkTarget(p.current);
  try { TH.pointLink(p.current, dest, { platform }); } catch (e) { return { ok: false, reason: `no pude apuntar ${p.current} a ${dest} (${e.code || e.message})` }; }
  if (before && path.basename(before) !== list.version) rec.previous = path.basename(before);
  return { ok: true };
}

// ── doctor ───────────────────────────────────────────────────────────────────────────────────
const HOOK_JS = /"([^"]+\.js)"\s*$/;
/**
 * Las rutas en su repo de los guiones `.js` de hooks-list.json y de los manifiestos de integrations/
 * (`scripts/hooks/x.js`, `integrations/<n>/x.js`, `skills/…/y.js`), o null.
 */
function listedHookPaths(tree = DEFAULT_TREE, problems = null) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
    const specs = (j.hooks || []).map((h) => String(h.spec || ''));
    const lib = path.join(tree, 'scripts', 'lib', 'integrations.js');
    // un manifiesto roto o la biblioteca que no carga se dicen en `problems`; un árbol sin la biblioteca, callado
    if (fs.existsSync(lib)) {
      try {
        const INT = require(lib);
        const l = INT.listManifests({ dir: path.join(tree, 'integrations') });
        for (const m of l.manifests) specs.push(...INT.hookEntries(m, { tool: 'claude' }).map((h) => h.spec));
        if (problems) for (const b of l.problems) problems.push(`el manifiesto de la integración ${b.name} está roto (${b.reasons.join('; ')}): sus hooks no se cuentan`);
      } catch (e) { if (problems) problems.push(`no pude cargar scripts/lib/integrations.js (${e.code || e.message}): los hooks de las integraciones no se cuentan`); }
    }
    const repoPath = (s) => (s.startsWith('@tcg:') ? `scripts/hooks/${s.slice(5)}` : (s.startsWith('@int:') ? `integrations/${s.slice(5)}` : `skills/${s}`));
    return [...new Set(specs.filter((s) => s.endsWith('.js')).map(repoPath))];
  } catch (_) { return null; }
}

/**
 * Los registros `.js` del arnés en settings.json: `{ own, path_node, other, total }` contados contra el prefijo de
 * `interp`. Cuentan sólo los guiones de `listed` (los de hooks-list.json, los que el aplicador maneja): un hook de otra
 * pieza —el barrido del reloj— no es del aplicador y nunca va a cambiar de forma. `other`: un hook del arnés con OTRO
 * Node (una ruta vieja, o que ya no existe), que no es ni el propio ni el del PATH.
 */
function countHooks(settingsFile, interp, listed = null) {
  let s;
  // sin archivo: null (no hay hooks que contar); uno que está y no se lee: `{ unreadable }` (no es «sin settings.json»)
  let text;
  try { text = fs.readFileSync(settingsFile, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : { unreadable: e.code || e.message }; }
  try { s = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { unreadable: e.message }; }
  const out = { own: 0, path_node: 0, other: 0, total: 0 };
  for (const bucket of Object.values((s && s.hooks) || {})) {
    for (const entry of Array.isArray(bucket) ? bucket : []) {
      for (const hk of (entry && Array.isArray(entry.hooks)) ? entry.hooks : []) {
        const cmd = String((hk && hk.command) || '').trim();
        const m = HOOK_JS.exec(cmd);
        if (!m) continue;
        const script = fwd(m[1]);
        if (/bootstrap\.js$/.test(script) || /codegraph/i.test(script)) continue;
        if (listed ? !listed.some((rel) => script.endsWith(`/${rel}`)) : !/\/scripts\/hooks\/|\/skills\//.test(script)) continue;
        out.total += 1;
        if (cmd.startsWith('node "')) out.path_node += 1;
        else if (interp && interp.own && cmd.startsWith(`${interp.prefix} "`)) out.own += 1;
        else out.other += 1;
      }
    }
  }
  return out;
}

/** El nivel de la línea de doctor con el Node propio presente: warn si la huella no es la de la lista o si queda algún
 *  hook del arnés con el Node del PATH o con otro Node; si no, ok. */
function doctorLevel(json, hooks) {
  return json.verified === false || (hooks && (hooks.path_node > 0 || hooks.other > 0)) ? 'warn' : 'ok';
}

/**
 * Lo que `doctor` dice del Node del arnés: `{ level: ok|warn|info, line, json }`. Nunca `fail`. Con
 * `health` (la comprobación de salud de una actualización) no recalcula la huella del binario: `verified: null`.
 */
function doctorFacts({ tree = DEFAULT_TREE, env = process.env, platform = process.platform, arch = process.arch, health = false, settingsFile = null } = {}) {
  const json = { own: null, version: null, expected: null, path: null, verified: null, hooks: { own: null, path_node: null }, form: null, switch: isOff(env) ? 'off' : 'on', reason: null };
  try {
    const p = TH.harnessNode({ env, platform });
    json.path = fwd(p.current);
    if (json.switch === 'off') {
      json.own = false; json.reason = 'apagado (TYCON_HARNESS_NODE=0)';
      return { level: 'info', line: `Node del arnés: apagado (TYCON_HARNESS_NODE=0), usa el del PATH (${process.version})`, json };
    }
    const L = readList(tree);
    if (!L.ok) { json.own = null; json.reason = L.reason; return { level: 'warn', line: `Node del arnés: no se pudo mirar (${L.reason}): los hooks usan el Node del PATH (${process.version})`, json }; }
    json.expected = L.list.version;
    const pk = platformKey({ platform, arch, env });
    const entry = entryFor(pk, L.list);
    const interp = interpreter({ tree, env: Object.assign({}, env, { TYCON_NODE_BIN: '' }), platform });
    json.own = interp.own; json.version = interp.version; json.form = interp.form;
    const deLaLista = [];
    const counted = settingsFile ? countHooks(settingsFile, interp, listedHookPaths(tree, deLaLista)) : null;
    if (deLaLista.length) json.problems = deLaLista;
    const hooks = counted && !counted.unreadable ? counted : null;
    if (hooks) json.hooks = { own: hooks.own, path_node: hooks.path_node };
    if (!entry) { json.reason = noEntryReason(pk, L.list); return { level: 'warn', line: `Node del arnés: ${json.reason}: los hooks usan el Node del PATH (${process.version})`, json }; }
    if (!interp.present) {
      const rec = readRecord();
      json.reason = rec.last_failure ? `no pude bajar su Node propio (${rec.last_failure.reason})` : interp.reason;
      return { level: 'warn', line: `Node del arnés: no está (${json.reason}): el arnés corre con el Node del PATH (${process.version})`, json };
    }
    if (!health) {
      try { json.verified = sha256File(p.bin) === entry.binarySha; } catch (_) { json.verified = false; }
    }
    const k = hooks ? `${hooks.own} de ${hooks.total}` : counted && counted.unreadable ? `settings.json ilegible (${counted.unreadable}), no los pude contar` : 'sin settings.json';
    if (!interp.own) {
      json.reason = interp.reason;
      return { level: 'warn', line: `Node del arnés: ${interp.version}, el propio (${json.path}), pero ${interp.reason} · hooks: ${k} con él`, json };
    }
    const parts = [`Node del arnés: ${interp.version}, el propio (${json.path})`];
    parts.push(json.verified === null ? 'huella del binario sin recalcular (comprobación de salud)' : json.verified ? 'huella del binario igual a la de la lista' : 'la huella del binario NO es la de la lista');
    if (hooks && (hooks.path_node > 0 || hooks.other > 0)) parts.push(`hooks: ${hooks.own} de ${hooks.total} con el Node del arnés${hooks.other ? ` (${hooks.other} con otro Node)` : ''}: el próximo arranque los pasa`);
    else parts.push(`hooks: ${k} con él`);
    // un manifiesto roto (sus hooks no se cuentan) se dice también en la línea, y la sube a aviso
    if (deLaLista.length) parts.push(deLaLista.join(' · '));
    if (json.verified === false) json.reason = 'la huella del binario no es la de la lista';
    else if (hooks && hooks.path_node > 0) json.reason = `${hooks.path_node} hooks todavía con el Node del PATH`;
    else if (hooks && hooks.other > 0) json.reason = `${hooks.other} hooks con otro Node (una ruta vieja o que ya no está)`;
    return { level: deLaLista.length ? 'warn' : doctorLevel(json, hooks), line: parts.join(' · '), json };
  } catch (e) {
    json.reason = `no se pudo mirar (${e.message})`;
    return { level: 'warn', line: `Node del arnés: ${json.reason}`, json };
  }
}

// ── el hijo de la bajada ─────────────────────────────────────────────────────────────────────────────────────────────
async function fetchMain(argv) {
  const [url, file] = argv;
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const tree = opt('--tree') || DEFAULT_TREE;
  const budgetS = Number(opt('--budget-s')) > 0 ? Number(opt('--budget-s')) : FETCH_BUDGET_S;
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  let H;
  try { H = require(path.join(tree, 'scripts', 'lib', 'http-get.js')); } catch (e) { say({ ok: false, reason: `sin http-get.js en el árbol (${e.message})` }); return; }
  try {
    const r = await H.httpGet(url, { maxBytes: MAX_BYTES, timeoutMs: budgetS * 1000, deadlineAt: Date.now() + budgetS * 1000, env: process.env });
    if (r.status !== 200) { say({ ok: false, reason: `el servidor contestó ${r.status}` }); return; }
    fs.writeFileSync(file, r.body);
    say({ ok: true, bytes: r.body.length });
  } catch (e) {
    const kind = e && e.kind;
    say({ ok: false, reason: kind === 'timeout' ? `el servidor no contestó en ${budgetS} s` : kind === 'network' ? `sin red (${e.code || e.message})` : kind === 'too-big' ? 'el archivo pasa el tope de 160 MB' : `${(e && e.message) || e}` });
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--fetch') fetchMain(argv.slice(1)).catch((e) => { process.stdout.write(`${JSON.stringify({ ok: false, reason: e.message })}\n`); });
  else { process.stderr.write('uso: harness-node.js --fetch <url> <archivo> [--tree <árbol>] [--budget-s <s>]\n'); process.exitCode = 2; }
}

module.exports = {
  readList, platformKey, entryFor, probe, formFor, interpreter, ensure, doctorFacts, countHooks, doctorLevel, listedHookPaths,
  readRecord, writeRecord, noticeFor, WINDOWS_FORM, BARE_POSIX, BARE_WIN, FETCH_BUDGET_S, MAX_BYTES, RETRY_AFTER_MS,
  renameWaiting,
};
