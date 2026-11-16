#!/usr/bin/env node
'use strict';
/**
 * live-sessions.js — quién más vive en un checkout: las otras sesiones que trabajan en la raíz de un repo (o debajo).
 *
 * ── LAS DOS FUENTES ──────────────────────────────────────────────────────────────────────────────
 * · La transcripción. Cada sesión de Claude Code escribe `~/.claude/projects/<carpeta-del-cwd>/<sesión>.jsonl`; la de
 *   Codex, en la carpeta de su propia transcripción, que se pasa en `selfTranscript`. Es «de este repo» si el último
 *   `cwd` que anotó es la raíz o está debajo (una sesión que se mudó a su copia deja de contar acá). Está viva si tuvo
 *   actividad en la ventana (3 min, `TYCON_SESSION_GUARD_MIN`), contando también lo que escriben sus subagentes en
 *   `<carpeta>/<sesión>/subagents/`: una sesión con un revisor de 20 minutos en vuelo no toca su transcripción.
 * · El marcador del pipeline (`<estado>/active/<sesión>.json`), leído como JSON con las reglas de `listOtherMarkers`
 *   de skills/tycon-pipeline/scripts/lib/story-gate-io.js: con `storyId`, no terminado (`stepsPending` vacío) y con
 *   `repoPath` en esta raíz. Cuenta si no venció (`lastTouch`, o `declaredAt`, de menos de 6 h: `why: 'corrida'`); si
 *   venció, cuenta si espera turno (`<estado>/doing/<sesión>.json` con `waitingFor` de menos de 24 h: `'esperando'`) o
 *   si quedó dejada a propósito con la marca de su misma historia, no anterior a su arranque (`<estado>/parked/`, como
 *   `marcaDe` de marker.js: `'dejada'`). La pausa por el archivo de la historia, que `marcaDe` también mira, no se lee:
 *   cargaría el lector de /wip.
 * Una sesión que sale por las dos fuentes sale una vez. La propia nunca cuenta, salvo que su id sea `_nosession` (sin
 * id no se sabe cuál es: cuenta de más, nunca de menos). Lo que no se puede leer va a `problems`, nunca a la cuenta.
 *
 * ── POR QUÉ NO CARGA NADA ────────────────────────────────────────────────────────────────────────
 * La usan ganchos que corren en cada comando y el guardián de sesiones, que viaja casi suelto (el banco lo copia con
 * sus libs a un árbol de juguete). Sólo `fs`, `path` y `os`: la raíz del repo (`git rev-parse --show-toplevel`) y la
 * carpeta del estado las resuelve quien llama.
 *
 * Uso: node scripts/lib/live-sessions.js --root <carpeta> [--state-dir <carpeta>] [--json]
 *      Toma la carpeta tal cual, sin buscar la raíz del repo. Sale 0 siempre.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// La carpeta del estado, si quien llama no la pasa: la sabe scripts/setup/harness/tycon-home.js, que se carga SI ESTÁ (esta
// lib viaja suelta con el guardián; ahí vale la ruta de siempre, que es la misma).
const stateDirOf = (() => { const lib = path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();

const VENTANA_MS = () => (Number(process.env.TYCON_SESSION_GUARD_MIN) || 3) * 60 * 1000;
// los de story-gate-io.js: STALE_HOURS (el marcador vencido) y WAIT_TURN_MAX_MS (la espera que todavía protege)
const MARCADOR_VENCE_MS = 6 * 3600 * 1000;
const ESPERA_VENCE_MS = 24 * 3600 * 1000;
const SIN_SESION = '_nosession';

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
// Claude Code nombra la carpeta con la ruta del cwd cambiando los separadores por `-`; se prueban las dos variantes
// (con y sin los puntos cambiados) para no depender de ese detalle.
const encode = (p) => [p.replace(/[/\\:]/g, '-'), p.replace(/[/\\:.]/g, '-')];

// La raíz tal como se escribió y como la guarda el disco (en macOS /var/… y /private/var/…), más las carpetas que quien
// llama vio resolver a esta raíz (`extras`, como las escribió un comando).
function rutasDe(raiz, extras = []) {
  const out = [raiz, real(raiz)];
  for (const d of extras) {
    if (!d) continue;
    out.push(d, real(d));
    const rd = real(d), rr = real(raiz);   // la raíz "tal como se escribió": lo escrito menos el sobrante
    if (rd.startsWith(rr) && rd.length > rr.length) out.push(d.slice(0, d.length - (rd.length - rr.length)));
  }
  return [...new Set(out)];
}

function carpetasDeSesiones(raiz, extras, home, selfTranscript, problems) {
  const base = path.join(home, '.claude', 'projects');
  const claves = new Set(rutasDe(raiz, extras).flatMap(encode));
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`no pude leer las transcripciones de ${base} (${e.code || e.message})`);
  }
  const out = [];
  for (const d of dirs) {
    for (const k of claves) if (d === k || d.startsWith(k + '-')) { out.push(path.join(base, d)); break; }
  }
  // Codex y otras herramientas no ordenan por cwd: la carpeta de la propia transcripción es la pista
  if (selfTranscript && !selfTranscript.startsWith(base + path.sep)) out.push(path.dirname(selfTranscript));
  return [...new Set(out)];
}

function cola(archivo, bytes) {
  const st = fs.statSync(archivo);
  const fd = fs.openSync(archivo, 'r');
  try {
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { texto: buf.toString('utf8') };
  } finally { fs.closeSync(fd); }
}

function ultimoPedido(archivo) {
  try {
    const lineas = cola(archivo, 256 * 1024).texto.split('\n');
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

/** Dónde trabaja ahora la sesión: el último `cwd` de su transcripción, o el del arranque; null si no hay uno legible. */
function cwdDe(archivo) {
  try {
    const st = fs.statSync(archivo);
    const fd = fs.openSync(archivo, 'r');
    try {
      const len = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lineas = buf.toString('utf8').split('\n');
      for (let i = lineas.length - 1; i >= 0; i--) { const c = cwdDeLinea(lineas[i]); if (c) return c; }
      if (st.size <= len) return null;
      const cab = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, cab, 0, cab.length, 0);
      for (const l of cab.toString('utf8', 0, n).split('\n')) { const c = cwdDeLinea(l); if (c) return c; }
    } finally { fs.closeSync(fd); }
  } catch { /* ilegible: no se sabe */ }
  return null;
}

/**
 * ¿La transcripción es de este repo? Manda el `cwd` donde trabaja la sesión: la raíz o debajo. El nombre de la carpeta no
 * alcanza (el de un puesto `…/repo--wt-X` empieza como el del checkout). Sin `cwd` legible no se sabe de dónde es y
 * cuenta: callarla sería no avisar nunca de esa sesión.
 */
function esDeEsteRepo(archivo, raiz, extras) {
  const c = cwdDe(archivo);
  if (c == null) return true;
  return rutasDe(raiz, extras).some((r) => c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

// Lo más nuevo que escribió un subagente de la sesión, o 0.
function subagenteMasNuevo(dir, id) {
  const sub = path.join(dir, id, 'subagents');
  let mas = 0;
  let files = [];
  try { files = fs.readdirSync(sub); } catch { return 0; }
  for (const f of files) {
    try { const m = fs.statSync(path.join(sub, f)).mtimeMs; if (m > mas) mas = m; } catch { /* se fue entre leer y mirar */ }
  }
  return mas;
}

function porTranscripcion({ root, extras, self, selfTranscript, now, home, problems }) {
  const out = [];
  for (const dir of carpetasDeSesiones(root, extras, home, selfTranscript, problems)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (e) {
      problems.push(`no pude leer las transcripciones de ${dir} (${e.code || e.message})`);
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      const id = f.replace(/\.jsonl$/, '');
      if (self && (id === self || (selfTranscript && real(p) === real(selfTranscript)))) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      const sub = subagenteMasNuevo(dir, id);
      const ultima = Math.max(st.mtimeMs, sub);
      const edadMs = now - ultima;
      if (edadMs > VENTANA_MS()) continue;
      if (!esDeEsteRepo(p, root, extras)) continue;
      out.push({ id, why: sub > st.mtimeMs ? 'subagente' : 'transcripción', min: Math.max(0, Math.round(edadMs / 60000)), lastPrompt: ultimoPedido(p) });
    }
  }
  return out;
}

function leerJson(file, problems, { ausente = null } = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ausente;
    problems.push(`no pude leer ${file} (${e.code || String(e.message).split('\n')[0]})`);
    return undefined;
  }
}
const fecha = (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
const sid = (s) => String(s).replace(/[/\\]/g, '_');

// La espera anotada que todavía protege (como `waitingTurn` de story-gate-io.js).
function esperando(stateDir, id, now, problems) {
  const n = leerJson(path.join(stateDir, 'doing', `${sid(id)}.json`), problems);
  const que = n && typeof n.waitingFor === 'string' ? n.waitingFor.trim() : '';
  if (!que) return false;
  const desde = fecha(n.waitingSince);
  return desde != null && now - desde <= ESPERA_VENCE_MS;
}
// La marca de dejada de su misma historia, no anterior a su arranque (como `marcaDe` de marker.js). Ilegible cuenta.
function dejada(stateDir, id, m, problems) {
  const mark = leerJson(path.join(stateDir, 'parked', `${sid(id)}.json`), problems);
  if (mark === undefined) return true;
  if (!mark) return false;
  const at = fecha(mark.at), started = fecha(m.startedAt);
  return String(mark.story) === String(m.storyId) && !(at != null && started != null && at < started);
}

function porMarcador({ root, self, now, stateDir, problems }) {
  const dir = path.join(stateDir, 'active');
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`no pude leer los marcadores de ${dir} (${e.code || e.message})`);
    return [];
  }
  const raiz = real(root);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id0 = f.replace(/\.json$/, '');
    if (self && id0 === sid(self)) continue;
    const m = leerJson(path.join(dir, f), problems);
    if (!m || typeof m !== 'object' || !m.storyId) continue;
    const id = m.sessionId ? String(m.sessionId) : id0;
    if (self && id === self) continue;
    if (Array.isArray(m.stepsPending) && m.stepsPending.length === 0) continue;   // terminado
    if (!m.repoPath || real(String(m.repoPath)) !== raiz) continue;
    const toque = fecha(m.lastTouch || m.declaredAt);
    let why = null;
    if (toque == null || now - toque <= MARCADOR_VENCE_MS) why = 'corrida';
    else if (esperando(stateDir, id, now, problems)) why = 'esperando';
    else if (dejada(stateDir, id, m, problems)) why = 'dejada';
    if (!why) continue;
    out.push({ id, why, story: String(m.storyId), repoPath: String(m.repoPath), runDir: m.runDir || null, min: toque == null ? null : Math.max(0, Math.round((now - toque) / 60000)) });
  }
  return out;
}

/**
 * Las otras sesiones vivas en `root` (la raíz del repo, ya resuelta por quien llama).
 * @returns {{ sessions: Array<{id, why, story, lastPrompt, min, repoPath, runDir}>, problems: string[] }}
 */
function others({ root, extras = [], selfSessionId = null, selfTranscript = null, now = Date.now(), home = os.homedir(), stateDir = null } = {}) {
  const problems = [];
  if (!root) return { sessions: [], problems: ['sin raíz de repo: no miré nada'] };
  const self = selfSessionId && selfSessionId !== SIN_SESION ? String(selfSessionId) : null;
  const estado = stateDir || stateDirOf(home);
  const porId = new Map();
  for (const s of porTranscripcion({ root, extras, self, selfTranscript: self ? selfTranscript : null, now, home, problems })) {
    porId.set(s.id, { id: s.id, why: s.why, story: null, lastPrompt: s.lastPrompt, min: s.min, repoPath: null, runDir: null });
  }
  for (const s of porMarcador({ root, self, now, stateDir: estado, problems })) {
    const ya = porId.get(s.id);
    if (ya) Object.assign(ya, { story: s.story, repoPath: s.repoPath, runDir: s.runDir });
    else porId.set(s.id, { id: s.id, why: s.why, story: s.story, lastPrompt: null, min: s.min, repoPath: s.repoPath, runDir: s.runDir });
  }
  return { sessions: [...porId.values()].sort((a, b) => (a.min == null ? 1e9 : a.min) - (b.min == null ? 1e9 : b.min)), problems };
}

/** Una línea por sesión, para un mensaje: «sesión abcd1234 — historia 1.2 — hace 3 min — último pedido: «…»». */
function describe(s) {
  return `sesión ${String(s.id).slice(0, 8)}`
    + (s.story ? ` — historia ${s.story}` : '')
    + (s.why === 'dejada' ? ' (dejada a propósito)' : s.why === 'esperando' ? ' (esperando turno)' : s.why === 'subagente' ? ' (con un subagente trabajando)' : '')
    + (s.min != null ? ` — hace ${s.min} min` : '')
    + (s.lastPrompt ? ` — último pedido: «${s.lastPrompt}»` : '');
}

module.exports = { others, describe, SIN_SESION, MARCADOR_VENCE_MS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h') || !val('--root')) {
    process.stdout.write('Uso: node scripts/lib/live-sessions.js --root <carpeta> [--state-dir <carpeta>] [--json]\n'
      + '  Las otras sesiones vivas en esa carpeta. Toma la carpeta tal cual: pasale la raíz del repo.\n');
    process.exit(0);
  }
  const r = others({ root: path.resolve(val('--root')), stateDir: val('--state-dir') });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write(r.sessions.length ? r.sessions.map((s) => `· ${describe(s)}`).join('\n') + '\n' : 'ninguna otra sesión viva en esa carpeta\n');
    for (const p of r.problems) process.stdout.write(`⚠️  ${p}\n`);
  }
  process.exit(0);
}
