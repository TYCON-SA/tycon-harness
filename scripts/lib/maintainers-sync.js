#!/usr/bin/env node
'use strict';
// maintainers-sync.js — el arranque pone al día el clon de mantenimiento.
//
// ── POR QUÉ ───────────────────────────────────────────────────────────────────────────────────────────────────────
// La máquina de quien mantiene el arnés declara el clon del repo de mantenimiento (`paths.maintainers`). De
// ahí cada sesión carga la portada privada (un `@import` del CLAUDE.md) y de ahí los avisos leen la noche
// (scripts/lib/night-data.js). El arranque pone al día el clon del arnés, no ése: sin esta puesta al día, el clon de mantenimiento queda atrás de `main` días enteros y
// cada sesión carga la portada vieja sin ningún aviso.
//
// ── QUÉ HACE ──────────────────────────────────────────────────────────────────────────────────────────────────────
// El aviso de arranque (scripts/hooks/branch-guard-notice.js) llama a `launch`, que lanza `run` DESPRENDIDO y vuelve
// enseguida: Claude Code lee los `@import` al arrancar en paralelo con los hooks, sin esperarlos,
// así que esperar la bajada sólo atrasaría la sesión sin que ella la vea (la lee la siguiente). `run`:
//   · sin la clave, con la variable apagada, fuera del perfil completo, con el mismo clon que el arnés (a ése lo mueve el
//     arranque) o con el candado de otra corrida viva → no corre git ni escribe nada;
//   · en `main`, sin cambios rastreados, sin operación a medias y atrás de `origin/main` → `merge --ff-only`;
//   · cualquier otra cosa → NO TOCA NADA y deja dicho por qué. Un cambio sin commitear en ese checkout es trabajo de
//     alguien: no se aparta con un stash (a diferencia de guides-heal, que repara el clon del arnés);
//   · lo que no pudo mirar (git que falla, una salida que no se entiende) es `fallo`, nunca «al día» ni «sin operación».
// Deja el resultado en `<estado>/maintainers-sync.json` (escritura atómica). El aviso de la sesión siguiente lo dice en
// UNA línea si pide algo a la persona (`takeNotice`) y lo marca como mostrado; «avanzó», «al día» y «sin red» callan:
// `main` se mueve muchas veces por día y la persona no tiene nada que hacer con eso. «Sin red» avisa recién si dura más
// de 3 días seguidos: ahí ya no es la red de un rato, y el clon se está quedando atrás.
//
// En Windows `run` corre siempre detrás de un relevo (`relay`), como scripts/setup/harness/detach.js: el proceso
// desprendido no tiene consola, y cada git que lanzara sin `windowsHide` abriría una ventana. El relevo lanza `run` SIN
// desprender y con `windowsHide` (recibe una consola propia sin ventana, que sus hijos heredan) y lo espera.
//
// La CLI: `run [--json]` (la corrida; con `--json` imprime lo que decidió, aunque no haya escrito nada) · `relay` (el
// relevo) · `notice` (imprime y marca la línea pendiente: lo mismo que hace el hook; para pruebas y para mirar a mano).
// Off: TYCON_MAINTAINERS_SYNC=0. Sólo de pruebas: `TYCON_MAINTAINERS_SYNC_SHIM=1` fuerza el relevo en cualquier sistema y
// `TYCON_MAINTAINERS_SYNC_FETCH_MS` acorta el tope del `fetch`.
// Nunca tira hacia afuera y nunca muestra la configuración (trae un permiso en texto plano) ni un permiso de una dirección.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HARNESS_ROOT = path.resolve(__dirname, '..', '..');
const TH = require(path.join(HARNESS_ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));

const OFF_VAR = 'TYCON_MAINTAINERS_SYNC';
const SHIM_VAR = 'TYCON_MAINTAINERS_SYNC_SHIM';
const FETCH_MS_VAR = 'TYCON_MAINTAINERS_SYNC_FETCH_MS';
const RESULT_NAME = 'maintainers-sync.json';
const LOCK_NAME = 'maintainers-sync.lock';
const LOCK_STALE_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const MERGE_TIMEOUT_MS = 60000;
const GIT_TIMEOUT_MS = 10000;
// el relevo espera más que la suma de los topes de adentro: cortar `run` a mitad de un merge no deja resultado
const RELAY_TIMEOUT_MS = 5 * 60 * 1000;
const OFFLINE_LOUD_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FILES = 5;
// lo que pide a la persona; el resto calla. `sin-red` entra sólo con `offline_days`.
const LOUD = new Set(['otra-rama', 'cambios-propios', 'sin-empujar', 'divergido', 'operacion-a-medias', 'archivos-traban',
  'sin-permiso', 'sin-remoto', 'fallo', 'no-sirve']);
// las variables de git que cambian DÓNDE trabaja o qué configuración lee: heredadas de la sesión (un hook de git, un
// laboratorio) mandarían el merge a otro repo. `GIT_SSH_COMMAND` y `GIT_CONFIG_GLOBAL` se quedan: son de la persona.
const GIT_LOCATION_VARS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_QUARANTINE_PATH', 'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS']);

const resultFile = (home) => path.join(TH.stateDir(home || os.homedir()), RESULT_NAME);
const lockFile = (home) => path.join(TH.stateDir(home || os.homedir()), LOCK_NAME);
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };

/**
 * Una línea de un error de git, ≤ 200, sin lo que pueda ser un permiso: lo que haya entre `://` y `@` (usuario y
 * clave, aunque la clave traiga `/` o comillas), un `token=…`/`api_key=…`/`client_secret=…` de una consulta, un JWT
 * (`eyJ….….…`), lo que siga a `Bearer`/`Basic` y cualquier tira larga de letras y números (un permiso suelto). Sólo la
 * primera línea: las demás no se guardan.
 */
function redact(text) {
  const first = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
  return first
    .replace(/:\/\/[^\s@]*@/g, '://')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***')
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '***')
    .replace(/([\w-]*(?:token|password|passwd|pwd|secret|sig|key))=[^&\s'"]+/gi, '$1=***')
    // una tira suelta de 32 o más con letras Y números (un permiso; también un sha, que en un error no hace falta). Un
    // tramo de una ruta o de una rama (pegado a `/` o `.`) no es un permiso y sirve para entender el error
    .replace(/(?<![/.\w+=-])(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{32,}(?![/.\w+=-])/g, '***')
    .slice(0, 200);
}

/** Un texto para la línea del aviso: sin caracteres de control (un nombre de archivo puede traer un salto), ≤ max. */
// los caracteres de control, los separadores de línea de Unicode (U+2028, U+2029), los de ancho cero (U+200B-U+200F,
// U+2060-U+2064, U+FEFF) y los de dirección (U+202A-U+202E, U+2066-U+2069): con ellos un nombre de archivo puede partir o
// disfrazar la línea que lee el modelo. Armados por código: escritos como escape en el fuente, una herramienta de
// edición los convierte en el carácter real y rompe la expresión
const ch = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${ch(0x2028, 0x2029)}${ch(0x200b, 0x200f)}${ch(0x202a, 0x202e)}${ch(0x2060, 0x2069)}${String.fromCharCode(0xfeff)}]+`, 'g');
function clean(s, max = 120) {
  const t = String(s === undefined || s === null ? '' : s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * El error de `fetch`: `sin-red` (calla), `sin-permiso` o `fallo`. Por el texto en inglés (git corre con LC_ALL=C).
 * Sólo lo que es de verdad de la red calla: un certificado roto, un repo que no está o un proxy que pide permiso son de
 * la persona y no se arreglan solos.
 */
function classifyFetchError(stderr, timedOut) {
  if (timedOut) return 'sin-red';
  const s = String(stderr || '');
  // un 401/403/407 cuenta sólo como código de una respuesta HTTP, no suelto: en «after 403 ms», «port 403» o un host
  // «git-401» es un número cualquiera
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied|(returned error|HTTP code|status code|HTTP\/[\d.]+):? 40[137]\b|TF401019|access denied|not authorized|Proxy Authentication Required/i.test(s)) return 'sin-permiso';
  if (/Could not resolve (host|proxy)|Failed to connect|Connection (refused|timed out|reset)|Operation timed out|Network is unreachable|Could not connect|No route to host|Temporary failure in name resolution|Name or service not known|SSL_ERROR_SYSCALL|Recv failure|connection closed/i.test(s)) return 'sin-red';
  return 'fallo';
}

function gitEnv(env) {
  const e = Object.assign({}, env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' });
  // por nombre en mayúsculas: en Windows el ambiente no distingue `Git_Dir` de `GIT_DIR`, y la copia sí
  for (const k of Object.keys(e)) {
    const up = k.toUpperCase();
    if (GIT_LOCATION_VARS.has(up) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(up)) delete e[k];
  }
  return e;
}
/** git sin tirar: `{ ok, code, out, err, timedOut, noGit }`. Siempre con `windowsHide`. */
function git(dir, args, { env = process.env, timeout = GIT_TIMEOUT_MS, raw = false } = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, windowsHide: true, env: gitEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT') || (r.signal === 'SIGTERM' && r.status === null);
  // `raw`: sin recortar (la salida de `status --porcelain` empieza con un espacio que es parte del código)
  return { ok: r.status === 0 && !r.error, code: r.status, out: raw ? String(r.stdout || '') : String(r.stdout || '').trim(), err: String(r.stderr || ''), timedOut, noGit: Boolean(r.error && r.error.code === 'ENOENT') };
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function readResult(home) {
  try { const r = JSON.parse(fs.readFileSync(resultFile(home), 'utf8')); return r && typeof r === 'object' ? r : null; } catch (_) { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); }
}
/**
 * El candado: `'taken'`, `'busy'` (otra corrida viva) o `'error'` (no se pudo crear, con `why`). Uno de más de 2
 * minutos, ilegible o de un proceso muerto se pisa. «No pude crearlo» no es «ocupado»: se dice.
 */
function takeLock(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { return { state: 'error', why: e && e.code }; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return { state: 'taken' };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { state: 'error', why: e && e.code };
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { held = null; }
      const age = held && typeof held.at === 'string' ? Date.now() - Date.parse(held.at) : Infinity;
      if (held && pidAlive(held.pid) && age < LOCK_STALE_MS) return { state: 'busy' };
      try { fs.rmSync(file, { force: true }); } catch (e2) { return { state: 'error', why: e2 && e2.code }; }
    }
  }
  return { state: 'busy' };
}
function releaseLock(file) {
  try { const held = JSON.parse(fs.readFileSync(file, 'utf8')); if (held && held.pid === process.pid) fs.rmSync(file, { force: true }); } catch (_) { /* nada */ }
}

/** El perfil de instalación: `full` deja correr y avisar; `minimal` o sin saber, no. */
function profileAllows(home, env) {
  try {
    const P = require(path.join(HARNESS_ROOT, 'scripts', 'setup', 'harness', 'profile.js'));
    const r = P.resolve({ tree: HARNESS_ROOT, home, env });
    return Boolean(r && r.ok && r.value === 'full');
  } catch (_) { return false; }
}

/**
 * Lo que trae `origin/main` y acá existe sin seguimiento: eso traba el merge. También cuando chocan como carpeta y
 * archivo (acá `foo` suelto y lo nuevo trae `foo/bar`, o al revés). Devuelve los sin seguimiento que traban; `null` si
 * no se pudo mirar. Las listas van sin recortar: un nombre puede empezar con un espacio.
 */
function blockingUntracked(dir, env) {
  const added = git(dir, ['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', 'HEAD', 'origin/main'], { env, raw: true });
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], { env, raw: true });
  if (!added.ok || !untracked.ok) return null;
  const incoming = added.out.split('\0').filter(Boolean);
  return untracked.out.split('\0').filter(Boolean)
    .filter((u) => incoming.some((a) => a === u || a.startsWith(`${u}/`) || u.startsWith(`${a}/`)));
}

/** La operación a medias del clon (merge, rebase, cherry-pick, revert, bisect): su nombre, null, o `{ unread }`. */
function operationInProgress(dir, env) {
  const marks = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];
  for (const [mark, name] of marks) {
    const p = git(dir, ['rev-parse', '--git-path', mark], { env });
    if (!p.ok) return { unread: true };
    const abs = path.isAbsolute(p.out) ? p.out : path.join(dir, p.out);
    if (fs.existsSync(abs)) return name;
  }
  return null;
}

/** El trabajo con el clon ya validado y el candado tomado. → el resultado (sin `at`/`clone`). */
function syncClone(dir, env) {
  const top = git(dir, ['rev-parse', '--show-toplevel'], { env });
  if (!top.ok || realOrNull(top.out) !== realOrNull(dir)) return { status: 'no-sirve', detail: top.noGit ? 'git no está en esta máquina' : 'no es la raíz de un clon de git' };
  const op = operationInProgress(dir, env);
  if (op && op.unread) return { status: 'fallo', detail: 'no pude mirar si tiene una operación a medias' };
  if (op) return { status: 'operacion-a-medias', detail: op };
  // sin rama: `symbolic-ref -q` sale 1 callado; cualquier otra salida es «no pude leer la rama», no «HEAD suelto»
  const br = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { env });
  if (!br.ok && !(br.code === 1 && !br.err.trim())) return { status: 'fallo', detail: redact(br.err) || 'no pude leer en qué rama está' };
  const branch = br.ok ? br.out : null;
  if (branch !== 'main') return { status: 'otra-rama', branch };
  const st = git(dir, ['status', '--porcelain', '--untracked-files=no', '-z'], { env, raw: true });
  if (!st.ok) return { status: 'fallo', detail: redact(st.err) || 'git status falló' };
  // con -z, un renombre o una copia traen la ruta vieja como entrada aparte, sin las dos letras: se salta
  const changed = [];
  const recs = st.out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    if (!recs[i]) continue;
    changed.push(recs[i].slice(3));
    // en cualquiera de las dos columnas: `R ` (índice) o ` R` (árbol, con `add -N`)
    if (/[RC]/.test(recs[i].slice(0, 2))) i++;
  }
  if (changed.length) return { status: 'cambios-propios', files: changed.slice(0, MAX_FILES), more: Math.max(0, changed.length - MAX_FILES) };
  const remote = git(dir, ['remote', 'get-url', 'origin'], { env });
  if (!remote.ok) return { status: 'sin-remoto' };
  const fetchMs = Number(env[FETCH_MS_VAR]) > 0 ? Number(env[FETCH_MS_VAR]) : FETCH_TIMEOUT_MS;
  // con el destino explícito: un clon cuya configuración no mapea main (uno de una sola rama) dejaría origin/main viejo
  // y saldría «al día» sin estarlo
  const fetched = git(dir, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { env, timeout: fetchMs });
  if (!fetched.ok) {
    const kind = classifyFetchError(fetched.err, fetched.timedOut);
    return { status: kind, detail: fetched.timedOut ? `no terminó en ${Math.round(fetchMs / 1000)} s` : redact(fetched.err) };
  }
  const count = git(dir, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { env });
  const m = count.ok ? /^(\d+)\s+(\d+)$/.exec(count.out) : null;
  if (!m) return { status: 'fallo', detail: count.ok ? 'no entendí cuánto le falta contra origin/main' : (redact(count.err) || 'no pude contar contra origin/main') };
  const ahead = Number(m[1]);
  const behind = Number(m[2]);
  if (ahead > 0 && behind > 0) return { status: 'divergido', ahead, behind };
  if (ahead > 0) return { status: 'sin-empujar', ahead };
  if (behind === 0) return { status: 'al-dia' };
  const blocking = blockingUntracked(dir, env);
  if (blocking === null) return { status: 'fallo', detail: 'no pude mirar qué archivos sin seguimiento trae lo nuevo' };
  if (blocking.length) return { status: 'archivos-traban', files: blocking.slice(0, MAX_FILES), more: Math.max(0, blocking.length - MAX_FILES), behind };
  const from = git(dir, ['rev-parse', 'HEAD'], { env }).out;
  const merged = git(dir, ['merge', '--ff-only', '--quiet', 'origin/main'], { env, timeout: MERGE_TIMEOUT_MS });
  if (!merged.ok) return { status: 'fallo', detail: merged.timedOut ? `merge --ff-only no terminó en ${MERGE_TIMEOUT_MS / 1000} s` : (redact(merged.err) || 'merge --ff-only falló'), behind };
  return { status: 'avanzo', behind, from, to: git(dir, ['rev-parse', 'HEAD'], { env }).out };
}

/**
 * Escribe el resultado. Si no puede (la carpeta del estado no se deja escribir), lo dice por stderr: corrido a mano
 * (`run`) se ve; en el proceso de fondo no llega a nadie, y es el único caso que queda sin aviso (sin dónde escribir no
 * hay de dónde leerlo; doctor dice si la carpeta del estado no sirve).
 */
function save(home, out) {
  try { writeAtomic(resultFile(home), out); } catch (e) { try { process.stderr.write(`maintainers-sync: no pude escribir el resultado (${e && e.code})\n`); } catch (_) { /* nada */ } }
  return out;
}

/**
 * Una puesta al día. → `{ status, ... }`. Escribe el resultado sólo cuando miró el clon, la clave no sirve o no pudo
 * tomar el candado; los estados que no tocan nada (`apagado`, `sin-clave`, `perfil`, `mismo-clon`, `ocupado`) no
 * escriben. El resultado: `schema`, `status`, `clone`, `at`, `shown` y lo de cada estado (`branch`, `files`, `more`,
 * `ahead`, `behind`, `from`, `to`, `detail`), más `ok_at` (la última vez que pudo traer) y `offline_since`.
 */
function syncOnce({ home = os.homedir(), env = process.env, harnessRoot = HARNESS_ROOT } = {}) {
  if (String(env[OFF_VAR] || '') === '0') return { status: 'apagado' };
  const m = TH.maintainersClone({ env });
  if (!m.declared) return { status: 'sin-clave' };
  if (!profileAllows(home, env)) return { status: 'perfil' };
  const now = new Date();
  const base = { schema: 1, clone: m.path, at: now.toISOString(), shown: false };
  if (m.problem) return save(home, { ...base, status: 'no-sirve', detail: m.problem });
  if (realOrNull(m.path) && realOrNull(m.path) === realOrNull(harnessRoot)) return { status: 'mismo-clon' };
  const lock = lockFile(home);
  const got = takeLock(lock);
  if (got.state === 'busy') return { status: 'ocupado' };
  if (got.state === 'error') return save(home, { ...base, status: 'fallo', detail: `no pude tomar el candado de la puesta al día (${got.why || 'sin código'})` });
  try {
    let r;
    try { r = syncClone(m.path, env); } catch (e) { r = { status: 'fallo', detail: redact(e && e.message) }; }
    // «sin red» que dura: se arrastra desde cuándo no se puede traer, y pasados 3 días se dice
    const prev = readResult(home) || {};
    const fetchedOk = !['sin-red', 'sin-permiso', 'fallo', 'no-sirve', 'sin-remoto', 'otra-rama', 'cambios-propios', 'operacion-a-medias'].includes(r.status);
    const out = { ...base, ...r };
    if (fetchedOk) out.ok_at = out.at;
    else if (typeof prev.ok_at === 'string') out.ok_at = prev.ok_at;
    if (r.status === 'sin-red') {
      out.offline_since = typeof prev.offline_since === 'string' && prev.status === 'sin-red' ? prev.offline_since : out.at;
      const days = Math.floor((now - Date.parse(out.offline_since)) / (24 * 60 * 60 * 1000));
      if (now - Date.parse(out.offline_since) > OFFLINE_LOUD_MS) out.offline_days = days;
    }
    return save(home, out);
  } finally { releaseLock(lock); }
}

/** La línea del aviso para un resultado, o null si calla. Una sola línea, en castellano llano, sin la configuración. */
function noticeLine(r) {
  if (!r || typeof r !== 'object') return null;
  const loudOffline = r.status === 'sin-red' && Number(r.offline_days) > 0;
  if (!LOUD.has(r.status) && !loudOffline) return null;
  const where = r.clone ? ` (${clean(r.clone, 160)})` : '';
  const list = Array.isArray(r.files) ? r.files.slice(0, MAX_FILES).map((f) => clean(f, 80)).filter(Boolean) : [];
  const files = list.length ? `${list.join(', ')}${Number(r.more) > 0 ? ` y ${Number(r.more)} más` : ''}` : '';
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : '?');
  const say = {
    'otra-rama': r.branch ? `está en la rama «${clean(r.branch, 80)}», no en main: no lo puse al día. Si nadie trabaja ahí, que vuelva a main y se pone al día solo` : 'está sin rama (HEAD suelto): no lo puse al día',
    'cambios-propios': `tiene cambios sin commitear (${files}): no lo puse al día para no pisarlos. Ese checkout queda en main y sin trabajo: que pasen a una rama o a un worktree`,
    'sin-empujar': `tiene ${n(r.ahead)} commit(s) en main que origin no tiene: no lo toqué. Que se empujen o pasen a una rama`,
    divergido: `su main y origin/main se separaron (${n(r.ahead)} propio(s), ${n(r.behind)} de origin): no lo toqué; hay que mirarlo a mano`,
    'operacion-a-medias': `tiene un ${clean(r.detail, 20) || 'merge'} a medias: no lo toqué (git status lo muestra)`,
    'archivos-traban': `lo nuevo de origin/main trae archivos que ahí existen sin seguimiento (${files}): no lo puse al día. Si se mueven o se borran, se pone al día solo`,
    'sin-permiso': `git no pudo traer origin/main por permiso (${clean(r.detail)}): no lo puse al día`,
    'sin-remoto': 'no tiene un remoto origin: no sé de dónde ponerlo al día',
    fallo: `no lo pude poner al día: ${clean(r.detail) || 'git falló sin decir por qué'}`,
    'no-sirve': `paths.maintainers no sirve (${clean(r.detail)}): no lo puse al día`,
    'sin-red': `hace ${n(r.offline_days)} día(s) que no puedo traer origin/main (sin red: ${clean(r.detail) || 'no contesta'}): se está quedando atrás`,
  }[r.status];
  return `🔔 TYCON — clon de mantenimiento${where}: ${say}. Decile a la persona en una línea; no lo arregles sin que te lo pida.`;
}

/**
 * La línea pendiente de la corrida anterior (una vez): la marca como mostrada. null si no hay nada que decir, si la
 * variable la apaga o fuera del perfil completo (ahí no se avisa nada de esto, ni lo que quedó de antes).
 */
function takeNotice({ home = os.homedir(), env = process.env } = {}) {
  if (String(env[OFF_VAR] || '') === '0') return null;
  const r = readResult(home);
  if (!r || r.shown === true) return null;
  const line = noticeLine(r);
  if (!line) return null;
  if (!profileAllows(home, env)) return null;
  // una corrida de fondo pudo escribir uno nuevo en el medio: se marca sólo si sigue siendo el mismo
  const again = readResult(home);
  if (!again || again.at !== r.at || again.status !== r.status) return null;
  try { writeAtomic(resultFile(home), { ...again, shown: true }); } catch (_) { return null; }   // sin poder marcarla, mejor callar que repetir
  return line;
}

/**
 * Lo que llama el hook: barato (la variable y la clave, sin git); si corresponde, lanza `run` desprendido y vuelve.
 * → `{ launched, why }`. Nunca tira; si no pudo lanzar, lo deja escrito para que la sesión siguiente lo diga.
 */
function launch({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  try {
    if (String(env[OFF_VAR] || '') === '0') return { launched: false, why: 'apagado' };
    const m = TH.maintainersClone({ env });
    if (!m.declared) return { launched: false, why: 'sin-clave' };
    const viaRelay = platform === 'win32' || String(env[SHIM_VAR] || '') === '1';
    const child = spawn(process.execPath, [__filename, viaRelay ? 'relay' : 'run'], { detached: true, stdio: 'ignore', windowsHide: true, env });
    // un fallo que llega después (sin procesos libres, sin archivos libres): si el hook sigue vivo, queda escrito
    child.on('error', (e) => { save(home, failure(`no se pudo lanzar la puesta al día (${redact(e && (e.code || e.message))})`)); });
    child.unref();
    return { launched: Boolean(child.pid), why: viaRelay ? 'relay' : 'run' };
  } catch (e) {
    const why = `no se pudo lanzar la puesta al día (${redact(e && e.message)})`;
    try { save(home, failure(why)); } catch (_) { /* nada */ }
    return { launched: false, why };
  }
}

/** Un resultado `fallo` armado acá (sin haber mirado el clon). */
function failure(detail) {
  return { schema: 1, status: 'fallo', detail, clone: null, at: new Date().toISOString(), shown: false };
}

/**
 * ¿El relevo tiene que dejar un fallo? → el motivo, o null. Sólo si el trabajador no dejó un resultado propio de esta
 * corrida (uno con `at` posterior al arranque del relevo): uno que terminó bien, o que ya dijo lo suyo, no se pisa.
 */
function relayFailure(r, startedMs, last) {
  const ownResult = last && typeof last.at === 'string' && Date.parse(last.at) >= startedMs - 1000;
  if (ownResult) return null;
  if (!r || r.error) {
    const code = r && r.error && (r.error.code || r.error.message);
    if (code === 'ETIMEDOUT') return `el relevo cortó la puesta al día a los ${RELAY_TIMEOUT_MS / 60000} min`;
    return `el relevo no pudo correr la puesta al día (${redact(code) || 'sin código'})`;
  }
  if (r.status !== 0 || r.signal) return `la puesta al día terminó mal detrás del relevo (${r.signal || `salida ${r.status}`})`;
  return null;
}

function main(argv) {
  const cmd = argv[0];
  if (cmd === 'run') {
    let r;
    try { r = syncOnce(); } catch (e) {
      // lo que tiró antes de mirar el clon (la configuración, la carpeta del estado): queda escrito, no sólo impreso
      r = failure(redact(e && e.message) || 'la puesta al día falló sin decir por qué');
      try { save(os.homedir(), r); } catch (_) { /* nada */ }
    }
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r)}\n`);
    return 0;
  }
  if (cmd === 'relay') {
    // el trabajador SIN desprender y con `windowsHide`: sus git heredan una consola sin ventana (ver la cabecera). Si no
    // arranca, lo corta el tope o sale mal sin dejar un resultado propio, el relevo lo deja escrito
    const started = Date.now();
    let r;
    try { r = spawnSync(process.execPath, [__filename, 'run'], { stdio: 'ignore', windowsHide: true, env: process.env, timeout: RELAY_TIMEOUT_MS }); } catch (e) { r = { error: e }; }
    const why = relayFailure(r, started, readResult(os.homedir()));
    if (why) save(os.homedir(), failure(why));
    return 0;
  }
  if (cmd === 'notice') {
    let line = null;
    try { line = takeNotice(); } catch (_) { line = null; }
    if (line) process.stdout.write(`${line}\n`);
    return 0;
  }
  process.stderr.write('uso: maintainers-sync.js run [--json] | relay | notice\n');
  return 2;
}

module.exports = { syncOnce, launch, takeNotice, noticeLine, classifyFetchError, redact, clean, gitEnv, relayFailure, resultFile, lockFile, LOUD };

if (require.main === module) process.exit(main(process.argv.slice(2)));
