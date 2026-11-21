#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * live-sessions.js — quién más vive en un checkout. Una sola pieza para el aviso de llegada y el freno de git
 * (scripts/hooks/session-collision-guard.js), el arranque de una historia (pipeline.js start) y el freno del stash ajeno
 * (skills/tycon-pipeline/scripts/lib/stash-guard.js): nadie repite el criterio.
 *
 * ── LAS DOS FUENTES ───────────────────────────────────────────────────────────────────────────────────────────────
 * 1. La transcripción: cada sesión de Claude Code deja `~/.claude/projects/<carpeta-del-cwd>/<sesión>.jsonl`, y su fecha
 *    dice si se movió hace poco. Cuenta también cualquier archivo bajo `<carpeta>/<sesión>/subagents/` (los de un
 *    Workflow van más adentro, en `subagents/workflows/<wf>/`): una sesión con un pase o un revisor largo en vuelo no
 *    toca su transcripción principal y parecería muerta. «De este checkout» lo dice el cwd que anotó la transcripción
 *    (la raíz o debajo), no el nombre de la carpeta: la de una copia `…/repo--wt-X` empieza igual que la de `…/repo`.
 * 2. El marcador del pipeline (`<estado>/active/<sesión>.json`) con `repoPath` en este checkout, aunque su transcripción
 *    esté quieta: una sesión que espera a la persona tampoco escribe.
 *
 * ── VIVO POR MARCADOR ─────────────────────────────────────────────────────────────────────────────────────────────
 * El corte de `pruneStale` de marker.js (que corre `list-all` antes de listar), sin podar: `lastTouch` de menos de
 * 24 h, o una de las excepciones que se leen del disco (la corrida dejada a propósito, la historia en pausa, la espera
 * de turno anotada). Las otras excepciones de `pruneStale` (perdida, firmada después del corte, terminada con cambios
 * sin guardar) piden piezas de skills/, que esta lib no carga: pasadas las 24 h esa sesión no cuenta como viva.
 * «De quién es un archivo» es otra pregunta (`claims`): ahí cuenta todo marcador presente, con cualquier edad.
 *
 * Esta lib no carga nada de skills/ (la llaman ganchos de cada comando, y el banco la copia suelta con place.js y
 * tycon-home.js al lado). No poda ni escribe nada. Lo que no puede leer va a `problems`: no cuenta como vivo ni como
 * muerto en silencio. No lista procesos: la señal es el disco.
 *
 * CLI: `node live-sessions.js --root <repo> [--self <sesión>] [--repo-wide] [--json]`. Sin `--self`, la propia sale del
 * entorno (como `resolveSessionId`). Sale 0 siempre que pudo mirar; imprime las otras sesiones.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
const PLACE = require(path.join(__dirname, '..', 'setup', 'harness', 'place.js'));

const VENTANA_MIN_DEFAULT = 3;
const MARKER_STALE_MS = 24 * 3600 * 1000;      // STALE_HOURS de marker.js
const WAIT_TURN_MAX_MS = 24 * 3600 * 1000;      // WAIT_TURN_MAX_MS de story-gate-io.js
const SUBAGENTS_MAX_DEPTH = 4;
const ABSENT = ['ENOENT', 'ENOTDIR'];

const ventanaMs = (env = process.env) => (Number(env.TYCON_SESSION_GUARD_MIN) || VENTANA_MIN_DEFAULT) * 60 * 1000;
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const sinBarras = (sid) => String(sid || '').replace(/[/\\]/g, '_');
// Claude Code nombra la carpeta con la ruta del cwd cambiando por `-` todo lo que no sea letra o número (`_`, espacios,
// `~`, acentos); se prueban también las formas con sólo los separadores, y con los puntos, para no depender de ese
// detalle. Dos rutas que dan la misma carpeta se separan después por el cwd de cada transcripción.
const encode = (p) => [p.replace(/[^a-zA-Z0-9]/g, '-'), p.replace(/[/\\:]/g, '-'), p.replace(/[/\\:.]/g, '-')];

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: ((r.stderr || '').trim().split('\n')[0]) || (r.error && r.error.code) || '' };
}
function raizDelRepo(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out ? r.out : null;
}

/**
 * Las formas de una raíz: tal cual, su ruta real y, por cada carpeta de `extras` (lo que escribió quien llama, que
 * resolvió a este repo), esa carpeta y la raíz «tal como se escribió». La carpeta de transcripciones lleva el cwd como
 * lo ve la sesión (/var/… en macOS) y `rev-parse` devuelve la ruta real (/private/var/…).
 */
function rutasDe(raiz, extras = []) {
  const out = [raiz, real(raiz)];
  for (const d of extras) {
    if (!d) continue;
    out.push(d, real(d));
    const rd = real(d), rr = real(raiz);
    if (rd.startsWith(rr) && rd.length > rr.length) out.push(d.slice(0, d.length - (rd.length - rr.length)));
  }
  return [...new Set(out)];
}

/** Las carpetas de transcripciones de un repo (y de sus subcarpetas). `{ dirs, problem }`. */
function carpetasDeSesiones(raiz, extras, home, selfTranscript) {
  const base = path.join(H.claudeDir(home), 'projects');
  const claves = new Set(rutasDe(raiz, extras).flatMap(encode));
  let entries;
  try { entries = fs.readdirSync(base); } catch (e) {
    if (ABSENT.includes(e.code)) return { dirs: [], problem: null };
    return { dirs: [], problem: `no pude leer las transcripciones (${base}): ${e.code || e.message}` };
  }
  const dirs = [];
  for (const d of entries) {
    for (const k of claves) if (d === k || d.startsWith(k + '-')) { dirs.push(path.join(base, d)); break; }
  }
  // Codex y otras herramientas no ordenan por cwd: la carpeta de la PROPIA transcripción es la pista, y se filtra por
  // cwd leyendo cada archivo (mejor esfuerzo).
  if (selfTranscript && !selfTranscript.startsWith(base + path.sep)) dirs.push(path.dirname(selfTranscript));
  return { dirs: [...new Set(dirs)], problem: null };
}

function cola(archivo, max = 256 * 1024) {
  const st = fs.statSync(archivo);
  const fd = fs.openSync(archivo, 'r');
  try {
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { texto: buf.toString('utf8'), entero: st.size <= len };
  } finally { fs.closeSync(fd); }
}

function ultimoPedido(archivo) {
  try {
    const lineas = cola(archivo).texto.split('\n');
    for (let i = lineas.length - 1; i >= 0; i--) {
      let d; try { d = JSON.parse(lineas[i]); } catch { continue; }
      if (d.type !== 'user') continue;
      const c = d.message && d.message.content;
      const textos = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text) : [];
      const t = textos.find((x) => typeof x === 'string' && x.trim() && !x.trim().startsWith('<'));
      if (t) return t.trim().replace(/\s+/g, ' ').slice(0, 90);
    }
  } catch { /* sin pedido legible */ }
  return null;
}

// Claude Code anota el `cwd` en cada línea; Codex, en el `payload` de la primera (`session_meta`).
function cwdDeLinea(linea) {
  let d; try { d = JSON.parse(linea); } catch { return null; }
  return d && (typeof d.cwd === 'string' && d.cwd ? d.cwd : d.payload && typeof d.payload.cwd === 'string' && d.payload.cwd ? d.payload.cwd : null);
}

/**
 * Dónde trabaja ahora la sesión: el último `cwd` de su transcripción (la cola), o el del arranque si la cola no trae
 * ninguno; null si no hay uno legible. El último y no el primero: una sesión que se mudó a una copia toca git ahí.
 */
function cwdDe(archivo) {
  try {
    const c = cola(archivo);
    const lineas = c.texto.split('\n');
    for (let i = lineas.length - 1; i >= 0; i--) { const x = cwdDeLinea(lineas[i]); if (x) return x; }
    if (c.entero) return null;
    const fd = fs.openSync(archivo, 'r');
    try {
      const cab = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, cab, 0, cab.length, 0);
      for (const l of cab.toString('utf8', 0, n).split('\n')) { const x = cwdDeLinea(l); if (x) return x; }
    } finally { fs.closeSync(fd); }
  } catch { /* ilegible: no se sabe */ }
  return null;
}

/**
 * ¿La transcripción es de este repo? Su cwd es la raíz o está debajo. Sin cwd legible no se sabe de dónde es y cuenta:
 * callarla sería no avisar nunca de esa sesión.
 */
function esDeEsteRepo(archivo, rutas) {
  const c = cwdDe(archivo);
  if (c == null) return true;
  return rutas.some((r) => c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

/** La fecha más nueva de un archivo bajo `dir`, hasta `depth` niveles; 0 si no hay ninguno. */
function masNuevoBajo(dir, depth) {
  let max = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) max = Math.max(max, masNuevoBajo(p, depth - 1)); continue; }
    try { max = Math.max(max, fs.statSync(p).mtimeMs); } catch { /* se fue */ }
  }
  return max;
}

/** Las sesiones vivas por transcripción. `subagents: false` mira sólo la principal (el criterio del freno de git). */
function porTranscripcion({ raiz, extras, home, now, windowMs, selfSessionId, selfTranscript, subagents, problems }) {
  const { dirs, problem } = carpetasDeSesiones(raiz, extras, home, selfTranscript);
  if (problem) problems.push(problem);
  const rutas = rutasDe(raiz, extras);
  const out = [];
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (e) {
      if (!ABSENT.includes(e.code)) problems.push(`no pude leer las transcripciones (${dir}): ${e.code || e.message}`);
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      const id = f.replace(/\.jsonl$/, '');
      if (id === selfSessionId || (selfTranscript && real(p) === real(selfTranscript))) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      let ultima = st.mtimeMs;
      let porSub = false;
      if (subagents) {
        const sub = masNuevoBajo(path.join(dir, id, 'subagents'), SUBAGENTS_MAX_DEPTH);
        if (sub > ultima) { ultima = sub; porSub = true; }
      }
      const edadMs = now - ultima;
      if (edadMs > windowMs) continue;
      if (!esDeEsteRepo(p, rutas)) continue;
      const min = Math.max(0, Math.round(edadMs / 60000));
      out.push({ id, min, lastPrompt: ultimoPedido(p), why: porSub ? `un subagente suyo escribió hace ${min} min` : `su transcripción se movió hace ${min} min` });
    }
  }
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Todos los marcadores de `active/`, sin mirar la edad: `{ list: [{ sid, m }], problem }`. */
function marcadores(home, problems) {
  const dir = path.join(H.stateDir(home), 'active');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) {
    if (ABSENT.includes(e.code)) return { list: [], seen: true };
    problems.push(`no pude leer los marcadores (${dir}): ${e.code || e.message}`);
    return { list: [], seen: false };
  }
  const list = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let m;
    try { m = readJson(path.join(dir, f)); } catch (e) { problems.push(`no pude leer el marcador ${path.join(dir, f)}: ${e.code || e.message}`); continue; }
    if (!m || typeof m !== 'object' || !m.storyId) continue;
    list.push({ sid: String(m.sessionId || f.replace(/\.json$/, '')), m });
  }
  return { list, seen: true };
}

/**
 * La fecha de `paused_until:` de una historia, o null. Una historia que no se puede leer no dice que no está en pausa:
 * el motivo queda en `unreadable`, si viene. (La usa también scripts/tools/work-in-progress.js.)
 */
function storyPausedUntil(storyPath, unreadable) {
  if (typeof storyPath !== 'string' || !storyPath) return null;
  try {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(storyPath, 'utf8'));
    const line = fm && /^paused_until:[ \t]*["']?(\d{4}-\d\d-\d\d)/m.exec(fm[1]);
    return line ? line[1] : null;
  } catch (e) {
    if (unreadable && !ABSENT.includes(e && e.code)) unreadable.push(`${storyPath}: no pude ver si está en pausa (${(e && e.code) || (e && e.message)})`);
    return null;
  }
}

/** ¿El marcador sigue vivo según el corte de `pruneStale`, sin podar? */
function marcadorVivo(sid, m, { home, now, problems }) {
  const t = Date.parse(m.lastTouch);
  if (!Number.isFinite(t) || now - t <= MARKER_STALE_MS) return true;   // sin fecha legible, ante la duda, vivo
  const state = H.stateDir(home);
  // la corrida dejada a propósito: su marca, de la misma historia, no anterior al arranque (marcaDe de marker.js)
  try {
    const mark = readJson(path.join(state, 'parked', `${sinBarras(sid)}.json`));
    const started = Date.parse(m.startedAt);
    if (mark && String(mark.story) === String(m.storyId) && !(Number.isFinite(started) && Date.parse(mark.at) < started)) return true;
  } catch (e) {
    if (!ABSENT.includes(e.code)) return true;   // ilegible cuenta como marcada
  }
  if (storyPausedUntil(m.storyPath, problems)) return true;
  // la espera de turno anotada (waitingTurn de story-gate-io.js)
  try {
    const n = readJson(path.join(state, 'doing', `${sinBarras(sid)}.json`));
    const what = n && typeof n.waitingFor === 'string' ? n.waitingFor.trim() : '';
    const since = Number.isFinite(Number(n && n.waitingSince)) ? Number(n.waitingSince) : Date.parse(n && n.waitingSince);
    if (what && Number.isFinite(since) && now - since <= WAIT_TURN_MAX_MS) return true;
  } catch { /* sin nota */ }
  return false;
}

/** Las raíces de todas las copias de trabajo del repo (la pila de stash es común a todas). */
function copiasDelRepo(raiz) {
  const r = git(raiz, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [raiz];
  const out = r.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  return out.length ? out : [raiz];
}

/**
 * Las otras sesiones vivas de un checkout: `{ sessions: [{ id, why, story, lastPrompt, min }], problems, seen }`.
 * `seen.transcripts` / `seen.markers` dicen si se pudo mirar cada fuente. `scope: 'repo'` une todas las copias del repo.
 * `sources: { subagents, markers }` (default los dos en true); el freno de git usa sólo la transcripción principal.
 */
function others({ root, selfSessionId = '', selfTranscript = '', now = Date.now(), home = os.homedir(), extras = [], scope = 'checkout', sources = {}, env = process.env } = {}) {
  const problems = [];
  const seen = { transcripts: true, markers: true };
  // la propia: por su id o por el nombre de su transcripción (que es su id)
  const propias = new Set([selfSessionId, selfTranscript ? path.basename(selfTranscript, '.jsonl') : ''].filter(Boolean));
  const subagents = sources.subagents !== false;
  const conMarcadores = sources.markers !== false;
  const raiz = raizDelRepo(root) || root;
  const raices = scope === 'repo' ? copiasDelRepo(raiz) : [raiz];
  const byId = new Map();
  for (const r of raices) {
    const antes = problems.length;
    const vivas = porTranscripcion({ raiz: r, extras: r === raiz ? extras : [], home, now, windowMs: ventanaMs(env), selfSessionId, selfTranscript, subagents, problems });
    if (problems.slice(antes).some((p) => /no pude leer las transcripciones/.test(p))) seen.transcripts = false;
    for (const v of vivas) if (!byId.has(v.id)) byId.set(v.id, { id: v.id, why: v.why, story: null, lastPrompt: v.lastPrompt, min: v.min });
  }
  if (conMarcadores) {
    const ms = marcadores(home, problems);
    if (!ms.seen) seen.markers = false;
    const reales = new Set(raices.map(real));
    for (const { sid, m } of ms.list) {
      if (propias.has(sid) || !m.repoPath || !reales.has(real(m.repoPath))) continue;
      if (!marcadorVivo(sid, m, { home, now, problems })) continue;
      const ya = byId.get(sid);
      if (ya) { ya.story = String(m.storyId); continue; }
      byId.set(sid, { id: sid, why: `tiene abierta la ejecución de la historia ${m.storyId}`, story: String(m.storyId), lastPrompt: null, min: null });
    }
  }
  const sessions = [...byId.values()].sort((a, b) => (a.min == null ? 1e9 : a.min) - (b.min == null ? 1e9 : b.min));
  return { sessions, problems, seen };
}

/**
 * De quién es cada archivo: todos los marcadores en `active/` (con cualquier edad) cuyo `repoPath` es una copia del
 * repo de `root`, con sus `filesTouched` y su `runDir` por ruta real. `{ markers: [{ sessionId, storyId, files, runDir,
 * repoPath }], problems }`.
 */
function claims({ root, home = os.homedir() } = {}) {
  const problems = [];
  const raiz = raizDelRepo(root) || root;
  const reales = new Set(copiasDelRepo(raiz).map(real));
  const out = [];
  for (const { sid, m } of marcadores(home, problems).list) {
    if (!m.repoPath || !reales.has(real(m.repoPath))) continue;
    const files = new Set((Array.isArray(m.filesTouched) ? m.filesTouched : []).filter((f) => typeof f === 'string').map(real));
    out.push({ sessionId: sid, storyId: String(m.storyId), files, runDir: typeof m.runDir === 'string' && m.runDir ? real(m.runDir) : null, repoPath: real(m.repoPath) });
  }
  return { markers: out, problems };
}

// Los repos donde una copia está prohibida a propósito (guides/git-worktrees.md §1): los dos nombres del lugar del arnés
// y agent-skills, como cualquier tramo de la ruta (también `<nombre>--wt-<x>`). Reconocedor declarado en
// scripts/tests/fixtures/harness-place-names.json.
const NOMBRES_SIN_COPIA = [PLACE.PLACE_NAME, PLACE.LEGACY_PLACE_NAME, 'agent-skills'];
const tramoSinCopia = (p) => String(p).split(/[/\\]+/).some((s) => NOMBRES_SIN_COPIA.some((n) => s === n || s.startsWith(`${n}--wt-`)));
/**
 * ¿En este repo no se crea una copia? Se mira la raíz, la carpeta principal del repo (la de su `.git` común: una copia
 * `tycon-harness--wt-X` tiene la principal `tycon-harness`) y, si `origin` es una ruta local (un clon descartable), la
 * principal de ese origen.
 */
function noOwnCopy(root) {
  const raiz = raizDelRepo(root) || root;
  const candidatas = [raiz];
  const comun = git(raiz, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (comun.code === 0 && comun.out) candidatas.push(path.basename(comun.out) === '.git' ? path.dirname(comun.out) : comun.out);
  const origin = git(raiz, ['remote', 'get-url', 'origin']);
  const url = origin.code === 0 ? origin.out : '';
  // una ruta local o `file://`; una URL (`https://…`) o la forma `usuario@host:ruta` no es una carpeta
  const local = /^file:\/\//.test(url) ? url.slice(7) : url && !/^[\w+.-]+:\/\//.test(url) && !/^[^/\\]+@[^:]+:/.test(url) ? url : null;
  if (local) {
    const ruta = path.isAbsolute(local) ? local : path.resolve(raiz, local);
    if (fs.existsSync(ruta)) {
      candidatas.push(ruta);
      const c2 = git(ruta, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (c2.code === 0 && c2.out) candidatas.push(path.basename(c2.out) === '.git' ? path.dirname(c2.out) : c2.out);
    }
  }
  return candidatas.some((c) => tramoSinCopia(c) || tramoSinCopia(real(c)));
}

/** La sesión propia desde el entorno, en el orden de resolveSessionId (skills/tycon-pipeline/scripts/lib/session-id.js). */
const selfFromEnv = (env = process.env) => env.CLAUDE_CODE_SESSION_ID || env.TYCON_SESSION_ID || env.CODEX_SESSION_ID || '';

module.exports = { others, claims, noOwnCopy, storyPausedUntil, selfFromEnv, ventanaMs, rutasDe, raizDelRepo, copiasDelRepo, NOMBRES_SIN_COPIA };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const root = opt('--root') || process.cwd();
  const r = others({ root: path.resolve(root), selfSessionId: opt('--self') || selfFromEnv(), scope: argv.includes('--repo-wide') ? 'repo' : 'checkout' });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (!r.sessions.length) process.stdout.write(r.seen.transcripts || r.seen.markers ? 'ninguna otra sesión viva en este checkout\n' : `no pude ver si hay otra sesión: ${r.problems.join('; ')}\n`);
  else for (const s of r.sessions) process.stdout.write(`otra sesión viva: ${s.id.slice(0, 8)} — ${s.why}${s.lastPrompt ? ` — último pedido: «${s.lastPrompt}»` : ''}\n`);
  process.exit(0);
}
