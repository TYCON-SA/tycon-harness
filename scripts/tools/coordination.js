#!/usr/bin/env node
'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/*
 * coordination.js — lo que usa la sesión coordinadora de una máquina (el comando /coordinate y la guía
 * guides/coordination.md).
 *
 *   status [--json]          quién trabaja, quién espera y por qué, el tope, el pase adversarial en vuelo, las firmas
 *                            pendientes y las sesiones sin nombre puesto por una persona
 *   coordinate               lo mismo, sólo para la sesión designada; a cualquier otra le dice qué falta
 *   signature --kind <tema> --title <qué firma> --cwd <carpeta> -- <comando...>
 *                            deja el archivo que el dueño abre con doble clic para firmar en su terminal; sin carpeta
 *                            de firmas en esta máquina, sólo imprime el comando
 *   signature-done <id>      borra el archivo y su pendiente
 *   open --name <n> --cwd <carpeta> -- <encargo>
 *                            abre una sesión de fondo con ese nombre; nunca reintenta. Sin --name (o con --name auto)
 *                            toma el primero libre de `coordination.session_names` (el lector de configuración);
 *                            sin esa configuración, no la abre
 *   open --name <n> --repo <repo> [--branch <rama>] -- <encargo>
 *                            lo mismo, en un puesto fijo libre del repo (scripts/tools/work-slots.js), en la rama del
 *                            trabajo (wt/<nombre> sin rama); sin puesto libre no la abre
 *   close --name <n>         cierra una sesión de fondo si quedó limpia; si falta algo, o no pudo mirarlo, no cierra y dice
 *                            qué. A una interactiva la verifica y avisa
 *
 * Además, sin línea de comandos: `capNotice` es el aviso que la coordinadora ve en cada turno
 * (scripts/hooks/coordination-notice.js): el tope, las sesiones de fondo quietas, los pedidos verdes que nadie encoló,
 * las firmas viejas. `adversarialTurn` es lo que frena a `deep-review-gate` y a `next` cuando otra sesión tiene un pase
 * adversarial en vuelo. El turno de la suite completa vive en scripts/tools/heavy-turn.js. Todo calla sin coordinadora
 * designada.
 *
 * Trabaja una sesión cuyo archivo dice `busy`, una de Codex con actividad en los últimos 5 minutos y una que abrió
 * `open` hace menos de 10 minutos y todavía no escribió su archivo. Las sesiones se leen con lo mismo que usa /wip.
 * El tope sale del lector de configuración (`coordination.max_working`, 3 sin valor); la carpeta de las firmas,
 * también (`coordination.owner_folder`, sólo de la máquina), y los nombres de las sesiones nuevas
 * (`coordination.session_names`). Lo que este guion anota vive en `<estado>/coordination/`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir, claudeDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const { adversarialInFlight } = require(path.join(SKILL_LIB, 'codex-reviewers.js'));
const { sesionQueReenvia, designacionVigente } = require(path.join(SKILL_LIB, 'critical-waivers.js'));
const { sessionsBySid, SAFE_SID } = require('./work-in-progress.js');
const tyconConfig = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));
const workSlots = require('./work-slots.js');
const { sessionNames } = tyconConfig;

const CODEX_WINDOW_MS = 5 * 60000;
// Una sesión de Codex quieta hace más de tres horas ya no está esperando: no se lista.
const CODEX_IDLE_MS = 3 * 3600000;
const OPENED_WINDOW_MS = 10 * 60000;
// Una sesión de fondo sin trabajar más que esto ocupa su lugar sin hacer nada: se le avisa a la coordinadora.
const QUIET_MS = 15 * 60000;
// Un pase en vuelo frena al siguiente hasta esta edad. El marcador no sabe si el pase ya terminó en la nube (se entera
// cuando su sesión lo recoge), así que uno terminado o colgado ocupa el lugar a lo sumo este tiempo; suelen tardar 20 a 40 min.
const ADVERSARIAL_TURN_MAX_MS = 60 * 60000;
// La nota de `marker.js doing` dice que la sesión hace algo sin tocar archivos, mientras sea reciente.
const DOING_FRESH_MS = 3 * 3600000;
const LAUNCH_TIMEOUT_MS = 30000;
const GIT_TIMEOUT_MS = 20000;
// Empieza con letra o número: el nombre va como valor de `-n` y no puede leerse como una bandera.
const { NAME_RE } = sessionNames;
const KIND_RE = /^[a-z0-9-]+$/;
const LABEL_MAX = 40;

const coordinationDir = (home) => path.join(stateDir(home), 'coordination');
// Un renglón sin caracteres de control ni invisibles: lo que llega a la pantalla del dueño o al contexto de la
// coordinadora no puede mover el cursor ni esconder texto.
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
// Un nombre leído de afuera (una sesión, un hilo de Codex, una historia), acotado y sin `<` ni `>`: va dentro del bloque
// que el aviso inyecta y no puede cerrarlo.
const label = (s) => Array.from(oneLine(s).replace(/[<>]/g, '')).slice(0, LABEL_MAX).join('');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file} no se puede leer (${e.code || e.message})`);
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  // Si el reemplazo falla, el temporal se borra: cada corrida del gancho tiene otro pid y se juntarían.
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no está */ } throw e; }
}

// La configuración de esta máquina: el tope, la carpeta de las firmas y los nombres de las sesiones, con su origen. Un
// error del lector no tumba el estado: el tope queda en el de fábrica y el motivo va en `problems`.
function recipe({ home, arnes, env }) {
  try {
    const cfg = tyconConfig.cargar({ home, env, ...(arnes ? { arnes } : {}) });
    const r = tyconConfig.coordinacion(cfg);
    const problem = cfg.errores && cfg.errores.length ? `la configuración no se pudo leer entera (${cfg.errores[0].clave || cfg.errores[0].archivo}: ${cfg.errores[0].motivo})` : null;
    return { ...r, problem };
  } catch (e) {
    return { max_working: { value: 3, origin: 'sin-valor' }, owner_folder: { value: null, origin: 'sin-valor' }, session_names: { value: null, origin: 'sin-valor' }, problem: `el lector de configuración falló (${e.message})` };
  }
}

// Las sesiones de Codex de la base más nueva que abrió una persona, con su última actividad, en sólo lectura: fuera
// quedan las ejecuciones de un guion (`exec`), los subagentes y las archivadas. Sin Codex, ninguna.
function codexThreads(codexHome, problems) {
  let bases;
  try { bases = fs.readdirSync(codexHome).filter((f) => /^state_\d+\.sqlite$/.test(f)); } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`la carpeta de Codex (${codexHome}) no se puede leer (${e.code || e.message})`);
    return [];
  }
  const newest = bases.sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0])).pop();
  if (!newest) return [];
  let db = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(codexHome, newest), { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name));
    const where = [
      cols.has('source') ? "COALESCE(source, '') <> 'exec'" : null,
      cols.has('thread_source') ? "COALESCE(thread_source, '') <> 'subagent'" : null,
      cols.has('archived') ? 'COALESCE(archived, 0) = 0' : null,
    ].filter(Boolean);
    return db.prepare(`SELECT id, name, updated_at_ms FROM threads${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).all()
      .map((r) => ({ id: String(r.id), name: r.name ? label(r.name) || null : null, last: Number(r.updated_at_ms) || null }));
  } catch (e) {
    problems.push(`las sesiones de Codex (${newest}) no se pudieron leer: ${oneLine(e.message).slice(0, 120)}`);
    return [];
  } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

function markersBySid(home, problems) {
  const dir = path.join(stateDir(home), 'active');
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (e) {
    if (e.code !== 'ENOENT') problems.push(`la carpeta de los marcadores (${dir}) no se puede leer (${e.code || e.message})`);
    return out;
  }
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.set(String(m.sessionId || f.replace(/\.json$/, '')), m);
    } catch (e) { problems.push(`el marcador ${f} no se puede leer (${e.code || e.message})`); }
  }
  return out;
}

const openedFile = (home) => path.join(coordinationDir(home), 'opened.json');
const signaturesFile = (home) => path.join(coordinationDir(home), 'signatures.json');
// Las firmas pendientes. Un registro roto o que no es una lista tira con su motivo.
function readPending(home) {
  const list = readJson(signaturesFile(home), []);
  if (!Array.isArray(list)) throw new Error(`${signaturesFile(home)} no es una lista`);
  return list;
}

// Las sesiones abiertas hace menos de diez minutos. Un archivo roto, o una entrada sin nombre o sin fecha, se dice en
// `problems`; una fecha futura (el reloj corrido) cuenta como recién abierta.
function recentOpened(home, now, problems) {
  let list;
  try { list = readJson(openedFile(home), []); } catch (e) { problems.push(e.message); return []; }
  if (!Array.isArray(list)) { problems.push(`${openedFile(home)} no es una lista`); return []; }
  const valid = list.filter((o) => o && typeof o.name === 'string' && o.name && Number.isFinite(o.at));
  if (valid.length < list.length) problems.push(`${openedFile(home)} tiene ${list.length - valid.length} entrada(s) sin nombre o sin fecha`);
  return valid.filter((o) => now - o.at < OPENED_WINDOW_MS);
}

// La sesión anotó hace poco qué hace (`marker.js doing`): no está quieta, aunque su archivo diga `idle`.
function hasFreshDoing(home, sid, now) {
  try { return now - fs.statSync(path.join(stateDir(home), 'doing', `${sid}.json`)).mtimeMs < DOING_FRESH_MS; } catch { return false; }
}

// Quién tiene el turno de la suite completa: el renglón de heavy-turn.js, o null. No poder leerlo no frena el estado.
function suiteHolder(home, now, problems) {
  try { return require('./heavy-turn.js').holder({ home, now }); } catch (e) { problems.push(`el turno de la suite completa (${e.message})`); return null; }
}

// Los pases adversariales en vuelo, con la sesión de cada uno.
function inFlight(markers, nameOf) {
  const out = [];
  for (const [sid, m] of markers) {
    if (adversarialInFlight(m)) out.push({ storyId: m.storyId ? label(m.storyId) : null, session: nameOf(sid), since: m.adversarial.launchedAt, sid });
  }
  return out;
}

/** El estado de la máquina, como datos. `noTranscripts`: sin abrir las conversaciones (el aviso de cada turno). */
function status(opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const problems = [];
  const sessions = sessionsBySid(path.join(claudeDir(home), 'sessions'), problems, opts.noTranscripts ? null : path.join(claudeDir(home), 'projects'));
  const markers = markersBySid(home, problems);
  const nameOf = (sid) => { const s = sessions.get(sid); return (s && s.name && label(s.name)) || String(sid).slice(0, 8); };
  const working = [];
  const waiting = [];
  const unnamed = [];
  const quiet = [];
  const passWaiting = [];
  const suite = suiteHolder(home, now, problems);
  const opened = recentOpened(home, now, problems);
  const justOpened = new Set(opened.map((o) => o.name));
  const alive = new Set();
  for (const [sid, s] of sessions) {
    if (!s.alive) continue;
    // Un agente interno de otra sesión (carpeta temporal, nombre armado) no es una sesión de trabajo, salvo con marcador.
    if (s.internal && !markers.has(sid)) continue;
    if (s.name) alive.add(s.name);
    const m = markers.get(sid);
    const story = m && m.storyId ? `la ${m.storyId}` : null;
    if (s.nameSource === 'derived' && s.name) unnamed.push(label(s.name));
    if (s.busy) working.push({ session: nameOf(sid), sid, why: story || 'trabajando sin pipeline', since: s.statusAt });
    else if (justOpened.has(s.name)) working.push({ session: nameOf(sid), sid, why: 'recién abierta, todavía arrancando', since: (opened.find((o) => o.name === s.name) || {}).at || null });
    else {
      waiting.push({ session: nameOf(sid), sid, why: story ? `${story}, ${s.status || 'sin estado'}` : 'sin trabajo' });
      // la que tiene que lanzar su pase y espera el lugar: no está quieta, le falta que alguien la despierte
      const owesPass = m && m.adversarialGate && m.adversarialGate.run === true && !m.adversarial && m.deepReviewDone !== true;
      if (owesPass && s.status === 'idle') passWaiting.push({ session: nameOf(sid), sid });
      // una de fondo, quieta: ni esperando su pase, ni con una nota de lo que hace, ni con la suite completa de la máquina
      else if (s.kind === 'bg' && s.status === 'idle' && Number.isFinite(s.statusAt) && now - s.statusAt >= QUIET_MS
        && !(m && adversarialInFlight(m)) && !hasFreshDoing(home, sid, now) && !(suite && suite.sid === sid)) {
        quiet.push({ session: nameOf(sid), sid, minutes: Math.floor((now - s.statusAt) / 60000) });
      }
    }
  }
  for (const c of codexThreads(opts.codexHome || path.join(home, '.codex'), problems)) {
    const session = c.name || c.id.slice(0, 8);
    const ago = c.last ? now - c.last : null;
    if (ago != null && ago >= 0 && ago < CODEX_WINDOW_MS) working.push({ session, sid: c.id, why: 'Codex, con actividad en los últimos 5 minutos', since: c.last });
    else if (ago != null && ago >= 0 && ago < CODEX_IDLE_MS) waiting.push({ session, sid: c.id, why: 'Codex, sin actividad en los últimos 5 minutos' });
    else if (ago == null) waiting.push({ session, sid: c.id, why: 'Codex, sin fecha de actividad' });
  }
  for (const o of opened) {
    if (!alive.has(o.name)) working.push({ session: o.name, sid: null, why: 'recién abierta, todavía sin archivo de sesión', since: o.at });
  }
  const adversarial = inFlight(markers, nameOf).map(({ sid, ...a }) => a);
  const r = recipe({ home, arnes: opts.arnes, env });
  if (r.problem) problems.push(r.problem);
  let pending = [];
  try { pending = readPending(home); } catch (e) { problems.push(e.message); }
  return {
    working, waiting, quiet, passWaiting, cap: r.max_working, adversarial,
    suite: suite ? { session: suite.session ? label(suite.session) : null, what: label(suite.what), since: suite.at } : null,
    signatures: { terminal: pending.length, delegated: 0 },
    unnamed, problems,
  };
}

const ORIGIN = { perfil: 'del perfil del equipo', maquina: 'de esta máquina', env: 'de una variable', 'sin-valor': 'de fábrica' };
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '?' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function statusText(s) {
  const lines = [`Trabajando: ${s.working.length} de ${s.cap.value} (tope ${ORIGIN[s.cap.origin] || s.cap.origin})`];
  for (const w of s.working) lines.push(`  · ${w.session} — ${w.why}`);
  lines.push(`Esperando: ${s.waiting.length}`);
  for (const w of s.waiting) lines.push(`  · ${w.session} — ${w.why}`);
  lines.push(`Pase adversarial en vuelo: ${s.adversarial.length ? s.adversarial.map((a) => `${a.storyId ? `la ${a.storyId}` : 'sin story'} (${a.session}, desde las ${hhmm(a.since)})`).join(' · ') : 'ninguno'}`);
  lines.push(`Suite completa en curso: ${s.suite ? `${s.suite.session || 'una sesión sin nombre'} (${s.suite.what}, desde las ${hhmm(s.suite.since)})` : 'ninguna'}`);
  lines.push(`De fondo y quietas: ${s.quiet.length ? s.quiet.map((q) => `${q.session} hace ${q.minutes} min`).join(' · ') : 'ninguna'}`);
  lines.push(`Firmas pendientes: ${s.signatures.terminal} por la terminal · ${s.signatures.delegated} por delegación`);
  lines.push(`Sin nombre puesto por una persona: ${s.unnamed.length ? s.unnamed.join(', ') : 'ninguna'}`);
  if (s.problems.length) lines.push(`No se pudo leer: ${s.problems.join(' · ')}`);
  return lines.join('\n');
}

const isCodex = (env) => Boolean(env.CODEX_SESSION_ID) && !env.CLAUDE_CODE_SESSION_ID;

/** /coordinate: el estado para la sesión designada; a cualquier otra, qué falta. `{ code, text }`. */
function coordinate(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || require('os').homedir();
  if (isCodex(env)) return { code: 1, text: 'Codex no puede coordinar: sus mensajes a otra sesión (codex queue) no pasan por una herramienta que el arnés pueda mirar. La coordinadora va en Claude Code.' };
  const rol = sesionQueReenvia({ env, home, arnes: opts.arnes });
  if (!rol.valor) {
    return { code: 1, text: rol.aviso && !/no conoce/.test(rol.aviso)
      ? `No sé si esta organización usa una coordinadora: ${rol.aviso}.`
      : 'Esta organización no usa una coordinadora: se prende en la pestaña Configuración del sitio, en «Quién autoriza saltarse un control».' };
  }
  const sid = env.CLAUDE_CODE_SESSION_ID || null;
  const d = designacionVigente({ home });
  if (d && d.error) return { code: 1, text: `No pude saber cuál es la coordinadora: ${d.error}.` };
  if (!d || !sid || d.sesion !== sid) {
    const marker = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
    return { code: 1, text: [
      `Esta sesión no es la ${rol.valor} de esta máquina${d ? ' (hay otra designada)' : ''}.`,
      `Para que lo sea, el dueño escribe en este chat «Esta sesión es la ${rol.valor}», y después esta sesión corre:`,
      `  node ${marker} designate-relay --approved-by '<el dueño>' --quote '<su frase, textual>'`,
    ].join('\n') };
  }
  return { code: 0, text: statusText(status(opts)) };
}

// ── Lo que ve la coordinadora sin pedirlo ──

// El rol de la coordinadora, sólo si esta sesión es la designada. `{ role }`, `{ problem }` cuando la designación dice
// que es ella pero la configuración no se lee, o null: sin rol, sin designación, en otra sesión o sin poder leer el
// registro (en la duda, callar: el aviso no puede llegarle a una sesión de trabajo).
function coordinatorRole(opts, sid) {
  const env = opts.env || process.env;
  const home = opts.home || require('os').homedir();
  if (!sid) return null;
  const d = designacionVigente({ home });
  if (!d || d.error || d.sesion !== sid) return null;
  const rol = sesionQueReenvia({ env, home, arnes: opts.arnes });
  if (rol.valor) return { role: rol.valor };
  return rol.aviso && /no se pudo leer|falló/.test(rol.aviso) ? { problem: rol.aviso.replace(/: nadie reenvía$/, '') } : null;
}
const sessionOf = (opts) => opts.sessionId || (opts.env || process.env).CLAUDE_CODE_SESSION_ID || null;

// La coordinadora que recibe primero la espera de otra sesión (scripts/hooks/wait-notice.js): `{ sid, name, role,
// waitingName }`, o null sin rol, sin designación, con la designada cerrada o si la que espera es ella misma.
function liveCoordinator(opts, waitingSid) {
  const env = opts.env || process.env;
  const home = opts.home || require('os').homedir();
  const d = designacionVigente({ home });
  if (!d || d.error || d.sesion === waitingSid) return null;
  const rol = sesionQueReenvia({ env, home, arnes: opts.arnes });
  if (!rol.valor) return null;
  const sessions = sessionsBySid(path.join(claudeDir(home), 'sessions'), [], null);
  const s = sessions.get(d.sesion);
  if (!s || !s.alive) return null;
  const w = sessions.get(waitingSid);
  return {
    sid: d.sesion, name: (s.name && label(s.name)) || String(d.sesion).slice(0, 8), role: rol.valor,
    waitingName: (w && w.name && label(w.name)) || String(waitingSid).slice(0, 8),
  };
}

// Las esperas de otras sesiones que le llegaron a la coordinadora y todavía no vio, una línea cada una.
function waitLines(opts, sid, problems) {
  try {
    return require(path.join(__dirname, '..', 'hooks', 'wait-notice.js')).coordinatorLines({ home: opts.home || require('os').homedir(), coordinatorSid: sid });
  } catch (e) {
    problems.push(`las esperas de las otras sesiones (${e.message})`);
    return [];
  }
}

const OLD_SIGNATURE_MS = 24 * 3600000;
const oldSignaturesFile = (home) => path.join(coordinationDir(home), 'old-signatures-notice.json');
const ddmm = (ms) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };

// Las firmas por la terminal que esperan hace más de un día, con su archivo todavía en la carpeta: una línea por día de
// calendario. Sin carpeta de firmas no hay pendientes. Si no puede anotar el día, avisa igual y lo dice en `problems`:
// del lado seguro, el aviso se repite.
function oldSignatures(opts, now, problems) {
  const home = opts.home || require('os').homedir();
  if (!recipe({ home, arnes: opts.arnes, env: opts.env || process.env }).owner_folder.value) return null;
  let list;
  // Un registro roto ya lo dijo `status`.
  try { list = readPending(home); } catch { return null; }
  const valid = list.filter((p) => p && Number.isFinite(p.at) && typeof p.file === 'string');
  if (valid.length < list.length) problems.push(`${list.length - valid.length} firma(s) pendiente(s) sin fecha o sin archivo en el registro`);
  const old = valid.filter((p) => now - p.at > OLD_SIGNATURE_MS && fs.existsSync(p.file)).sort((a, b) => a.at - b.at);
  if (!old.length) return null;
  const today = localDate(now);
  let seen = null;
  try { seen = readJson(oldSignaturesFile(home), null); } catch (e) { problems.push(e.message); }
  if (seen && seen.day === today) return null;
  try { writeJson(oldSignaturesFile(home), { day: today }); } catch (e) { problems.push(`no pude anotar el día del aviso de firmas: ${e.code || e.message}`); }
  return `Coordinación: ${old.length} firma(s) del dueño esperan hace más de un día; la más vieja, «${label(old[0].title)}», desde el ${ddmm(old[0].at)} a las ${hhmm(old[0].at)}.`;
}

// Los pedidos verdes que nadie encoló (scripts/hooks/stuck-pr-notice.js), de la última foto: sin salir a la red.
function greenPrLines(opts, problems) {
  try {
    const r = require(path.join(__dirname, '..', 'hooks', 'stuck-pr-notice.js')).coordinatorLines({
      home: opts.home || require('os').homedir(), ...(opts.arnes ? { tree: opts.arnes } : {}), ...(opts.now == null ? {} : { now: Number(opts.now) }),
    });
    if (r.problem) problems.push(r.problem);
    return r.lines.map((l) => l.replace(/^⚠️ /, 'Coordinación: '));
  } catch (e) {
    problems.push(`los pedidos verdes (${e.message})`);
    return [];
  }
}

/**
 * El aviso para la sesión coordinadora: en el tope, quiénes trabajan; pasado el tope, por cuánto y cuál trabaja hace
 * menos. Después, las sesiones de fondo quietas, los pedidos verdes que nadie encoló y las firmas del dueño que esperan
 * hace más de un día. Sin nada de eso, null. Lo que no pudo leer va en una línea. No abre ninguna conversación ni sale a
 * la red.
 */
function capNotice(opts = {}) {
  const sid = sessionOf(opts);
  const who = coordinatorRole(opts, sid);
  if (!who) return null;
  const s = status({ ...opts, noTranscripts: true });
  const problems = who.problem ? [who.problem, ...s.problems] : [...s.problems];
  const working = s.working.filter((w) => w.sid !== sid);
  const cap = s.cap.value;
  const lines = [];
  if (working.length >= cap) {
    const names = working.map((w) => w.session).join(', ');
    if (working.length === cap) lines.push(`Coordinación: la máquina está en el tope (${working.length} de ${cap} trabajando: ${names}). Antes de asignar, esperá que una termine.`);
    else {
      const newest = working.filter((w) => Number.isFinite(w.since)).sort((a, b) => b.since - a.since)[0];
      lines.push(`Coordinación: la máquina pasó el tope por ${working.length - cap} (${working.length} de ${cap} trabajando: ${names})${newest ? `; la que trabaja hace menos: ${newest.session}` : ''}.`);
    }
  }
  for (const q of s.quiet.filter((x) => x.sid !== sid)) lines.push(`Coordinación: ${q.session} está quieta hace ${q.minutes} min: cerrala o dale trabajo.`);
  // nada la despierta sola: quien tiene que avisarle cuando se libera el lugar es la coordinadora. Con el mismo criterio
  // que el portón: el pase de una sesión cerrada, o de más de una hora, no ocupa el lugar.
  for (const w of s.passWaiting.filter((x) => x.sid !== sid)) {
    const t = adversarialTurn({ ...opts, sessionId: w.sid });
    lines.push(t && t.waiting_turn
      ? `Coordinación: ${w.session} espera su turno de pase adversarial (lo tiene ${t.other_in_flight[0].session}): avisale cuando termine.`
      : `Coordinación: ${w.session} puede lanzar su pase adversarial, no hay otro en vuelo: avisale.`);
  }
  lines.push(...greenPrLines(opts, problems));
  const signatures = oldSignatures(opts, opts.now == null ? Date.now() : Number(opts.now), problems);
  if (signatures) lines.push(signatures);
  lines.push(...waitLines(opts, sid, problems));
  if (problems.length) lines.push(`Coordinación: No pude leer ${oneLine(problems.join(' · ')).slice(0, 300)}.`);
  return lines.length ? lines.join('\n') : null;
}

/**
 * El turno del pase adversarial, cuando otra sesión tiene uno en vuelo: `{ other_in_flight, turn, waiting_turn }`. Con
 * `waiting_turn`, `deep-review-gate` sale 3 y `next` pide esperar: el arnés no deja lanzar el segundo. Un pase de más de
 * una hora ya no frena (puede estar terminado o colgado), y se dice. Sin otro pase, o sin coordinadora designada, null.
 */
function adversarialTurn(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || require('os').homedir();
  const sid = sessionOf(opts);
  const d = designacionVigente({ home });
  // no poder leerla no es «no hay coordinadora»: el pase no se frena, pero se dice que no se pudo mirar
  if (d && d.error) process.stderr.write(`coordination: no pude saber cuál es la coordinadora (${d.error}): no miro el turno del pase\n`);
  if (!d || d.error) return null;
  const rol = sesionQueReenvia({ env, home, arnes: opts.arnes });
  if (!rol.valor) return null;
  const problems = [];
  const sessions = sessionsBySid(path.join(claudeDir(home), 'sessions'), problems, null);
  // Una coordinadora que ya se cerró no da turnos; el pase de una sesión que ya no vive quedó abandonado.
  if (!(sessions.get(d.sesion) || {}).alive) return null;
  const markers = markersBySid(home, problems);
  // Una sesión cerrada no deja archivo: sin archivo no vive, y su pase quedó abandonado, salvo que sea de Codex, que no
  // escribe esos archivos: ésa cuenta si tuvo actividad hace poco. Si no se pudieron leer las sesiones, en la duda, cuenta.
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const codexAlive = new Set(codexThreads(opts.codexHome || path.join(home, '.codex'), problems).filter((c) => c.last && now - c.last < CODEX_IDLE_MS).map((c) => c.id));
  const others = [...markers].filter(([k, m]) => k !== sid && adversarialInFlight(m) && (sessions.has(k) ? sessions.get(k).alive : (codexAlive.has(k) || problems.length > 0)));
  if (!others.length) return null;
  const nameOf = (k) => { const s = sessions.get(k); return (s && s.name && label(s.name)) || String(k).slice(0, 8); };
  const other_in_flight = inFlight(new Map(others), nameOf).map(({ sid: _s, ...a }) => a);
  const list = other_in_flight.map((a) => `${a.storyId ? `la ${a.storyId}` : 'sin story'}, ${a.session}, desde las ${hhmm(a.since)}`).join(' · ');
  // una fecha que no se lee no frena: no se sabe cuánto lleva, y sin tope trabaría la fila para siempre
  const waiting_turn = other_in_flight.some((a) => { const at = Date.parse(a.since); return Number.isFinite(at) && now - at < ADVERSARIAL_TURN_MAX_MS; });
  return { other_in_flight, waiting_turn, turn: waiting_turn
    ? `Hay otro pase adversarial en vuelo (${list}): va uno por vez y el arnés no deja lanzar este hasta que termine; pedile turno a la ${rol.valor}.`
    : `Hay otro pase adversarial anotado hace más de una hora (${list}): puede estar terminado o colgado, así que no frena; pedile turno a la ${rol.valor} antes de lanzar este.` };
}

// ── Las firmas por la terminal ──

const shQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).split("'").join("'\\''")}'`);
// En un .cmd el `%` se expande aun entre comillas: se dobla siempre. Un texto con `%` va entre comillas.
const cmdQuote = (s) => (/^[\w@+=:,./\\-]+$/.test(s) ? s : `"${String(s).split('"').join('""').split('%').join('%%')}"`);
// Lo que `echo` muestra tal cual en un .cmd: `^` antes de & | < > ^, y el `%` doblado.
const cmdEcho = (s) => s.replace(/[\^&|<>]/g, '^$&').split('%').join('%%');
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

function signatureBody({ title, cwd, command, windows }) {
  if (windows) {
    return ['@echo off', `rem ${cmdEcho(oneLine(title))}`, `echo ${cmdEcho(oneLine(title))}`, `cd /d ${cmdQuote(cwd)} || exit /b 1`, command.map(cmdQuote).join(' '), 'echo.', 'pause', ''].join('\r\n');
  }
  return ['#!/bin/bash', `# ${oneLine(title)}`, `echo ${shQuote(oneLine(title))}`, `cd ${shQuote(cwd)} || exit 1`, command.map(shQuote).join(' '),
    'echo', 'read -n 1 -s -r -p "Listo. Tocá una tecla para cerrar."', 'echo', ''].join('\n');
}

/** Deja el archivo de una firma por la terminal, o imprime el comando si la máquina no tiene carpeta de firmas. */
function signature(opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const { kind, title, cwd } = opts;
  const command = Array.isArray(opts.command) ? opts.command.map(String) : [];
  if (!KIND_RE.test(String(kind || ''))) return { wrote: false, file: null, id: null, message: 'el tema de la firma va en minúsculas, números y guiones (--kind)' };
  if (!oneLine(title)) return { wrote: false, file: null, id: null, message: 'falta qué se firma (--title)' };
  if (!cwd || !path.isAbsolute(cwd)) return { wrote: false, file: null, id: null, message: 'falta la carpeta donde corre la firma, absoluta (--cwd)' };
  if (!command.length) return { wrote: false, file: null, id: null, message: 'falta el comando de la firma, después de --' };
  // Un salto de línea parte el renglón del comando: en un .cmd lo que sigue se ejecuta solo.
  if ([cwd, ...command].some((s) => /[\r\n\0]/.test(s))) return { wrote: false, file: null, id: null, message: 'la carpeta o el comando de la firma traen un salto de línea: no escribí el archivo' };
  const printed = `cd ${shQuote(cwd)} && ${command.map(shQuote).join(' ')}`;
  const r = recipe({ home, arnes: opts.arnes, env });
  const folder = r.owner_folder.value;
  if (!folder && r.problem) return { wrote: false, file: null, id: null, message: `No sé si esta máquina tiene carpeta de firmas: ${r.problem}. El dueño corre en su terminal ${printed}` };
  if (!folder) return { wrote: false, file: null, id: null, printed: true, message: `Esta máquina no tiene carpeta de firmas: el dueño corre en su terminal ${printed}` };
  const dir = expandHome(String(folder), home);
  let pending;
  try { pending = readPending(home); } catch (e) { return { wrote: false, file: null, id: null, message: `${e.message}: no escribí la firma` }; }
  const windows = process.platform === 'win32';
  const ext = windows ? '.cmd' : '.command';
  const body = signatureBody({ title, cwd, command, windows });
  const key = JSON.stringify([cwd, command]);
  const same = pending.find((p) => p.key === key && fs.existsSync(p.file)) || sameInFolder(dir, ext, body);
  if (same) return { wrote: false, file: same.file, id: same.id, message: `ya hay un archivo para esa firma: ${same.file}` };
  const base = `${localDate(now)}-${kind}`;
  fs.mkdirSync(dir, { recursive: true });
  const usedIds = new Set(pending.map((p) => p.id));
  let id = base;
  let file = null;
  // Se crea sin pisar nada: un archivo o un enlace con ese nombre, aunque esté roto, hace probar el siguiente.
  for (let n = 2; !file; n += 1) {
    if (!usedIds.has(id)) {
      const candidate = path.join(dir, `${id}${ext}`);
      try { fs.writeFileSync(candidate, body, { mode: 0o755, flag: 'wx' }); file = candidate; continue; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    id = `${base}-${n}`;
  }
  writeJson(signaturesFile(home), [...pending.filter((p) => p.key !== key), { id, key, file, kind, title: oneLine(title), at: now }]);
  return { wrote: true, file, id, message: `Dejé la firma «${oneLine(title)}» en ${file}: el dueño la abre con doble clic.` };
}

// Un archivo de la carpeta de firmas con la misma carpeta y el mismo comando, aunque el registro se haya perdido.
function sameInFolder(dir, ext, body) {
  const lines = body.split(/\r?\n/);
  const wanted = lines.slice(3, 5).join('\n');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return null; }
  for (const f of files) {
    try {
      if (fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(3, 5).join('\n') === wanted) return { file: path.join(dir, f), id: f.slice(0, -ext.length) };
    } catch { /* un archivo que no se lee no es el mismo */ }
  }
  return null;
}

/** Borra el archivo de una firma ya hecha y su pendiente. Sólo borra un archivo de firma de la carpeta de firmas. */
function signatureDone(id, opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  let pending;
  try { pending = readPending(home); } catch (e) { return { ok: false, message: `${e.message}: no cerré la firma` }; }
  const p = pending.find((x) => x.id === id);
  if (!p) return { ok: false, message: `no hay una firma pendiente «${id}»` };
  const folder = recipe({ home, arnes: opts.arnes, env }).owner_folder.value;
  const file = path.resolve(String(p.file || ''));
  if (!folder || path.dirname(file) !== path.resolve(expandHome(String(folder), home)) || !/\.(command|cmd)$/.test(file)) {
    return { ok: false, message: `la firma «${id}» apunta a ${file}, que no es un archivo de la carpeta de firmas: no lo borré` };
  }
  try { fs.rmSync(file, { force: true }); } catch (e) { return { ok: false, message: `no pude borrar ${file} (${e.code || e.message})` }; }
  writeJson(signaturesFile(home), pending.filter((x) => x.id !== id));
  return { ok: true, message: `Firma «${id}» cerrada: borré ${file}.` };
}

// ── Abrir una sesión de fondo ──

// Los modos que acepta `claude --permission-mode`, más `default`, que es como la conversación anota el modo por
// defecto (el lanzador sin la opción ya arranca en él).
const LAUNCHER_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan', 'default']);
const MODE_TAIL_BYTES = 1024 * 1024;
const MODE_CHUNK_BYTES = 64 * 1024;
const MODE_RE = /"permissionMode":"([^"\\]*)"/g;

// El último modo anotado en el último MODE_TAIL_BYTES de un archivo, leído de atrás hacia adelante; null si no hay.
function lastModeIn(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let end = size;
    let tail = '';
    while (end > 0 && size - end < MODE_TAIL_BYTES) {
      const len = Math.min(MODE_CHUNK_BYTES, end, MODE_TAIL_BYTES - (size - end));
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, end - len);
      end -= len;
      // se suma el bloque nuevo adelante: una anotación partida entre dos bloques queda entera en el texto
      tail = buf.toString('latin1') + tail;
      let m;
      let last = null;
      MODE_RE.lastIndex = 0;
      while ((m = MODE_RE.exec(tail))) last = m[1];
      if (last !== null) return last;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

// El modo de permisos de la sesión que llama. No está en el entorno ni en su archivo de sesión: sólo en su
// conversación, donde cada mensaje de la persona lleva el modo de ese momento. Se busca en todas las carpetas de
// `projects/` (la conversación no siempre está en la de su carpeta de arranque) y vale la de modificación más nueva.
// Límite conocido: un cambio de modo sin un mensaje después no queda anotado.
function callerPermissionMode({ home, env }) {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  if (!sid || !SAFE_SID.test(String(sid))) return { problem: 'no sé qué sesión me llama' };
  const projects = path.join(claudeDir(home), 'projects');
  let newest = null;
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch (e) { return { problem: `no pude leer ${projects}: ${e.code || e.message}` }; }
  for (const d of dirs) {
    const file = path.join(projects, d, `${sid}.jsonl`);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: st.mtimeMs };
  }
  if (!newest) return { problem: 'no encontré la conversación de esta sesión' };
  let mode;
  try { mode = lastModeIn(newest.file); } catch (e) { return { problem: `no pude leer la conversación: ${e.code || e.message}` }; }
  if (mode === null) return { problem: 'la conversación no lo anota cerca del final' };
  if (!LAUNCHER_MODES.has(mode)) return { problem: `la conversación dice «${label(mode)}», que el lanzador no conoce` };
  // una sesión de fondo en plan queda esperando que alguien apruebe su plan
  if (mode === 'plan') return { problem: 'estás en modo plan, y la sesión nueva quedaría esperando que alguien apruebe su plan' };
  return { mode };
}

/**
 * El tope, como lo cuentan `open` y el freno de sesiones (scripts/hooks/session-cap-guard.js): `{ atCap, working, cap,
 * problems }`. Lee las conversaciones, como `open`. Con `problems` no vacío el conteo no es confiable: cada uno decide.
 */
function capCheck(opts = {}) {
  const s = status(opts);
  return { atCap: s.working.length >= s.cap.value, working: s.working, cap: s.cap, problems: s.problems };
}

/** Anota una sesión recién abierta en `opened.json`, para que cuente hasta que escriba su archivo. Tira si no puede. */
function noteOpened({ home, now, name, cwd }) {
  writeJson(openedFile(home), [...recentOpened(home, now, []).filter((o) => o.name !== name), { name, cwd, at: now }]);
}

// Una apertura por vez en la máquina: dos `open` juntos elegían el mismo nombre de la lista y la segunda anotación de
// `opened` pisaba la primera. La otra espera su turno; un candado de hace más de dos minutos es de una apertura que murió.
const OPEN_LOCK_STALE_MS = 120000;
const OPEN_LOCK_WAIT_MS = LAUNCH_TIMEOUT_MS + 15000;
function withOpenLock(home, waitMs, fn) {
  // al lado de la carpeta de la coordinadora y no adentro: con esa carpeta sin permiso de escritura se abre igual y se
  // avisa que no se pudo anotar
  const lock = path.join(stateDir(home), 'coordination-open.lock');
  try { fs.mkdirSync(stateDir(home), { recursive: true }); } catch (e) { return { ok: false, message: `No pude preparar ${stateDir(home)} (${e.code || e.message}): no la abrí.` }; }
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, message: `No pude tomar el candado de las aperturas (${e.code}): no la abrí.` };
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > OPEN_LOCK_STALE_MS) { try { fs.rmdirSync(lock); } catch { /* otro lo soltó */ } continue; }
      if (Date.now() >= until) return { ok: false, message: 'Otra apertura de sesión sigue en curso en esta máquina: no la abrí. Probá de nuevo en unos segundos.' };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* ya no está */ } }
}

// Los nombres que ya tienen rama `wt/<nombre>` en el repo: con un nombre de la lista y sin --branch, la sesión nueva
// arrancaría sobre la rama del trabajo anterior con ese nombre. `{ names }` o `{ problem }`.
function wtBranchNames(repo) {
  const r = spawnSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/wt/'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return { problem: oneLine((r.stderr || '').split('\n')[0] || (r.error && r.error.code) || `git salió con código ${r.status}`) };
  return { names: r.stdout.split('\n').map((l) => l.trim().replace(/^refs\/heads\/wt\//, '')).filter(Boolean) };
}

/**
 * Abre una sesión de fondo con nombre y encargo. Nunca reintenta; sólo una apertura que salió bien queda anotada. Sin
 * nombre (o con «auto»), toma el primero libre de `coordination.session_names`.
 */
function open(opts = {}) {
  const home = opts.home || require('os').homedir();
  return withOpenLock(home, opts.lockWaitMs == null ? OPEN_LOCK_WAIT_MS : opts.lockWaitMs, () => openNow({ ...opts, home }));
}

function openNow(opts) {
  const { home } = opts;
  const env = opts.env || process.env;
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const { task, cwd } = opts;
  let { name } = opts;
  const auto = name === undefined || name === null || name === '' || name === 'auto';
  const no = (message) => ({ ok: false, message: oneLine(message) });
  if (isCodex(env) && !opts.launcher) return no('Codex no tiene cómo abrir una sesión de fondo: esa sesión la abre el dueño.');
  if (!auto && !NAME_RE.test(String(name))) return no('El nombre de la sesión va con letras, números, guion o guion bajo, sin espacios: no la abrí.');
  const s = capCheck({ ...opts, home, env, now });
  // Sin leer todo no se sabe el tope ni qué nombres están tomados: no se abre a ciegas.
  if (s.problems.length) return no(`No pude leer todo el estado de la máquina (${s.problems[0]}): no la abrí.`);
  const taken = new Set([...sessionsBySid(path.join(claudeDir(home), 'sessions'), [], path.join(claudeDir(home), 'projects')).values()]
    .filter((x) => x.alive && x.name).map((x) => x.name));
  const openedProblems = [];
  for (const o of recentOpened(home, now, openedProblems)) taken.add(o.name);
  if (openedProblems.length) return no(`No pude saber qué sesiones se abrieron recién (${openedProblems[0]}): no la abrí.`);
  if (auto) {
    const names = sessionNames.namesOf(recipe({ home, arnes: opts.arnes, env }).session_names.value);
    // sin lista, como siempre: el nombre lo pone quien abre
    if (names.length && opts.repo && !opts.branch && path.isAbsolute(String(opts.repo))) {
      const b = wtBranchNames(opts.repo);
      if (b.problem) return no(`No pude ver qué ramas wt/ tiene ${opts.repo} (${b.problem}): no la abrí.`);
      for (const n of b.names) taken.add(n);
    }
    if (!names.length) return no('El nombre de la sesión va con letras, números, guion o guion bajo, sin espacios (sin --name, sale de coordination.session_names, y esta máquina no tiene esa lista): no la abrí.');
    name = sessionNames.nextFree(names, taken);
    if (!name) return no('No quedó ningún nombre libre en la lista de esta máquina (coordination.session_names): no la abrí.');
  }
  if (taken.has(name)) return no(`«${name}» ya lo usa otra sesión viva: no la abrí.`);
  if (!oneLine(task)) return no('Falta el encargo de la sesión: no la abrí.');
  if (s.atCap) return no(`Ya hay ${s.working.length} trabajando y el tope es ${s.cap.value} (${ORIGIN[s.cap.origin] || s.cap.origin}): no la abrí, espera su turno.`);
  if (cwd && opts.repo) return no('Va o la carpeta o el repo, no los dos: no la abrí.');
  // La sesión nueva arranca en el modo de la que la abre: en otro modo se traba en permisos que nadie ve y no recibe
  // los mensajes de las demás. Sin saberlo, no se abre a ciegas.
  const pm = callerPermissionMode({ home, env });
  if (pm.problem) return no(`No pude saber en qué modo de permisos estás (${pm.problem}): no la abrí.`);
  // Con el repo, la sesión va a un puesto fijo (scripts/tools/work-slots.js): la carpeta ya está aprobada y no hace
  // falta que el dueño apruebe una nueva.
  let slot = null;
  if (opts.repo) {
    if (!path.isAbsolute(opts.repo)) return no('El repo va con su ruta absoluta: no la abrí.');
    const branch = opts.branch || `wt/${name}`;
    const tk = workSlots.take({ home, env, arnes: opts.arnes, repo: opts.repo, branch });
    if (!tk.ok) return no(`${tk.message.replace(/\.$/, '')}; no la abrí.`);
    slot = tk;
  }
  const where = slot ? slot.path : cwd;
  if (!where || !path.isAbsolute(where)) return no('Falta la carpeta de la sesión, absoluta: no la abrí.');
  if (!fs.existsSync(where)) return no(`La carpeta ${where} no existe: no la abrí.`);
  // Si no abrió, el puesto vuelve a quedar libre y la rama que se creó para el trabajo no queda.
  const fail = (message) => {
    if (slot) {
      workSlots.release({ home, env, slot: slot.path });
      if (slot.created) spawnSync('git', ['-C', slot.path, 'branch', '-d', slot.branch], { encoding: 'utf8', windowsHide: true });
    }
    return no(message);
  };
  // Lo pesado se pide: seis sesiones dentro del tope, cada una con lo suyo, llevaron la carga de una máquina a 52.
  const rolTurno = sesionQueReenvia({ env, home, arnes: opts.arnes }).valor;
  const heavyRule = rolTurno ? ` — Nada pesado sin turno de la ${rolTurno}: suite completa, banco, examen, portón, revisores, pase.` : '';
  const job = slot
    ? `${task}${heavyRule} — Trabajás en el puesto ${slot.path}, en la rama ${slot.branch}. Al terminar, con todo commiteado, soltalo: node "${path.join(__dirname, 'work-slots.js')}" release "${slot.path}"`
    : `${task}${heavyRule}`;
  const launcher = opts.launcher || { bin: 'claude', prefix: [] };
  const timeoutMs = opts.timeoutMs || LAUNCH_TIMEOUT_MS;
  // con control remoto a su nombre, el dueño la ve y la maneja desde claude.ai/code o el celular
  const modeArgs = pm.mode === 'default' ? [] : ['--permission-mode', pm.mode];
  const r = spawnSync(launcher.bin, [...(launcher.prefix || []), '--bg', '-n', name, ...modeArgs, '--remote-control', name, '--', job], {
    cwd: where, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (r.error && r.error.code === 'ENOENT') return fail(`Claude Code no está instalado en esta máquina (no encontré ${launcher.bin}): no abrí la sesión.`);
  // sin respuesta no se sabe si abrió: el puesto queda tomado, mejor que dos sesiones en la misma carpeta
  if (r.error && r.error.code === 'ETIMEDOUT') return no(`El lanzador no volvió en ${Math.round(timeoutMs / 1000)} s: no sé si abrió la sesión y no reintenté. Mirá con /wip.`);
  if (r.error) return fail(`El lanzador falló (${r.error.code || r.error.message}): no abrí la sesión.`);
  if (r.status !== 0) {
    const out = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (/not trusted/i.test(out)) return fail(`La carpeta ${where} todavía no está aprobada para Claude Code: la abre el dueño una vez${slot ? ' (los puestos sin aprobar los lista work-slots.js pending-trust)' : ''}. Mientras tanto, la sesión la abre el dueño y yo le doy el encargo.`);
    const first = out.split('\n').map((l) => l.trim()).find(Boolean);
    return fail(`El lanzador falló: ${first || (r.signal ? `lo cortó la señal ${r.signal}` : `salió con código ${r.status}`)}. No reintenté.`);
  }
  const opened = `Abrí «${name}» en ${where}. Para entrar: claude attach ${name}, o desde claude.ai/code (control remoto «${name}»)`;
  try {
    noteOpened({ home, now, name, cwd: where });
  } catch (e) {
    return { ok: true, message: oneLine(`${opened}. Pero no la pude anotar (${e.code || e.message}): hasta que escriba su archivo de sesión no cuenta para el tope.`) };
  }
  return { ok: true, message: opened };
}

// ── Cerrar una sesión ──

function gitIn(dir, args) {
  // la carpeta la dice el archivo de la sesión: su configuración no corre un programa por acá
  const r = spawnSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' } });
  return { code: r.error ? null : r.status, out: String(r.stdout || '').trim(), err: String((r.error && r.error.message) || r.stderr || '').trim().split('\n')[0] };
}

// Lo que le falta a la carpeta de una sesión para cerrarla: `{ missing, unknown }`. Lo que no se pudo mirar va a `unknown`:
// «no sé» nunca es «está limpia». Un puesto fijo se suelta, no se borra (work-slots.js).
function folderGaps(dir, opts) {
  const missing = [];
  const unknown = [];
  // `answersOne`: los comandos cuyo código 1 es una respuesta («no está en una rama», «no entró»), no una falla
  const git = (args, what, answersOne = false) => {
    const r = gitIn(dir, args);
    if (r.code !== 0 && !(answersOne && r.code === 1)) unknown.push(`no pude mirar ${what} en ${dir} (${r.err || `salió con código ${r.code}`})`);
    return r;
  };
  if (!fs.existsSync(dir)) return { missing, unknown: [`su carpeta ${dir} ya no está: no puedo mirar su rama`] };
  const top = gitIn(dir, ['rev-parse', '--show-toplevel']);
  // fuera de un repo no hay nada de git que mirar
  if (top.code !== 0) return /not a git repository/i.test(top.err) ? { missing, unknown } : { missing, unknown: [`no pude mirar el repo de ${dir} (${top.err})`] };
  // con todos los archivos sin seguir, aunque la configuración del repo los esconda
  const status = git(['status', '--porcelain', '--untracked-files=all'], 'los cambios');
  if (status.code === 0 && status.out) missing.push(`${status.out.split('\n').length} archivo(s) sin commitear en ${dir}`);
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD'], 'la rama', true);
  const onBranch = branch.code === 0;
  const slots = workSlots.list({ home: opts.home, env: opts.env, arnes: opts.arnes, repo: dir });
  if (!slots.ok) unknown.push(`no pude mirar si ${dir} es un puesto fijo (${slots.message})`);
  const slot = slots.ok ? slots.slots.find((s) => fs.realpathSync(top.out) === s.path) : null;
  if (slot && onBranch) missing.push(`el puesto ${slot.path} sigue tomado por la rama ${branch.out}: soltalo con work-slots.js release`);
  const fetched = gitIn(dir, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
  if (fetched.code !== 0) {
    unknown.push(`no pude traer main de origin en ${dir} (${fetched.err || `salió con código ${fetched.code}`}): no sé si lo empujó ni si entró`);
    return { missing, unknown };
  }
  const main = git(['rev-parse', 'FETCH_HEAD^{commit}'], 'main');
  if (main.code !== 0) return { missing, unknown };
  const unpushed = git(['rev-list', '--count', 'HEAD', '--not', '--remotes', main.out], 'lo empujado');
  if (unpushed.code === 0 && Number(unpushed.out) > 0) missing.push(`${unpushed.out} commit(s) sin empujar en ${dir}`);
  // la rama de un worktree o de la carpeta, o un commit suelto: que haya entrado a main. También una `main` local: empujada
  // a otra rama, tampoco entró
  const merged = git(['merge-base', '--is-ancestor', 'HEAD', main.out], 'si la rama entró a main', true);
  if (merged.code === 1) missing.push(`${onBranch ? `la rama ${branch.out}` : 'el commit suelto'} de ${dir} no entró a main`);
  // las ramas de las que la sesión se fue en esta carpeta: su registro dice cuáles, desde que arrancó
  if (!Number.isFinite(opts.startedAt)) {
    unknown.push(`no sé desde cuándo trabaja en ${dir}: no puedo mirar las ramas que dejó`);
    return { missing, unknown };
  }
  // sin su archivo, git contesta con el registro de la rama, que no dice de qué ramas se fue: medido
  const logPath = git(['rev-parse', '--git-path', 'logs/HEAD'], 'el registro');
  if (logPath.code !== 0) return { missing, unknown };
  let logSize = 0;
  try { logSize = fs.statSync(path.resolve(dir, logPath.out)).size; } catch (_) { logSize = 0; }
  const log = logSize ? git(['reflog', 'show', '--date=unix', '--format=%gd %gs', 'HEAD'], 'las ramas que dejó') : null;
  if (log && log.code !== 0) return { missing, unknown };
  // un registro vacío (apagado por configuración) o con otra forma no dice que no dejó ramas
  const lines = log && log.out ? log.out.split('\n') : [];
  if (!lines.length || !lines.every((l) => /^HEAD@\{\d+\}( |$)/.test(l))) {
    unknown.push(`no pude leer el registro de ${dir}: no sé qué ramas dejó`);
    return { missing, unknown };
  }
  const left = new Set();
  for (const l of lines) {
    const m = /^HEAD@\{(\d+)\} checkout: moving from (\S+) to /.exec(l);
    if (m && Number(m[1]) * 1000 >= opts.startedAt) left.add(m[2]);
  }
  for (const b of left) {
    if (b === branch.out) continue;
    // el código 1 es «ya no existe»; otro es que no se pudo mirar
    const ref = git(['show-ref', '--verify', '--quiet', `refs/heads/${b}`], `si la rama ${b} sigue`, true);
    if (ref.code !== 0) {
      // sin rama, el registro dice el commit: lo hecho ahí sólo queda en el registro si ninguna rama lo tiene
      if (ref.code === 1 && /^[0-9a-f]{7,40}$/.test(b)) {
        const loose = git(['rev-list', '--count', b, '--not', '--branches', '--remotes', main.out], `el commit ${b}`);
        if (loose.code === 0 && Number(loose.out) > 0) missing.push(`${loose.out} commit(s) hechos sin rama en ${dir}, desde ${b}`);
      }
      continue;
    }
    const entered = git(['merge-base', '--is-ancestor', `refs/heads/${b}`, main.out], `si la rama ${b} entró a main`, true);
    if (entered.code === 1) missing.push(`la rama local ${b} de ${dir} no entró a main`);
  }
  return { missing, unknown };
}

// La ejecución de la sesión: `{ missing, unknown }`. Un marcador sin pasos pendientes es de una corrida terminada, y un
// arreglo rápido vencido ya no abre nada.
function runGaps(sid, home) {
  const missing = [];
  const unknown = [];
  const io = require(path.join(SKILL_LIB, 'story-gate-io.js'));
  const problems = [];
  const m = markersBySid(home, problems).get(String(sid));
  unknown.push(...problems);
  if (m && !(Array.isArray(m.stepsPending) && m.stepsPending.length === 0)) missing.push(`su corrida de la historia ${m.storyId || '(sin nombre)'} sigue abierta`);
  let crudo = null;
  try { crudo = fs.readFileSync(io.adhocPath(stateDir(home), sid), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') unknown.push(`no pude leer su arreglo rápido (${e.code || e.message})`);
  }
  if (crudo !== null) {
    try {
      const a = JSON.parse(crudo);
      if (!a || !a.reason) unknown.push('no pude leer su arreglo rápido: no dice su motivo');
      else if (io.readAdhoc(stateDir(home), sid)) missing.push('su arreglo rápido sigue abierto: marker.js adhoc clear');
    } catch (e) {
      unknown.push(`no pude leer su arreglo rápido (${e.message})`);
    }
  }
  return { missing, unknown };
}

/**
 * Cierra una sesión de fondo sólo si quedó limpia: nada sin commitear ni sin empujar, su worktree sin rama pendiente y su
 * ejecución cerrada. Si falta algo no cierra y dice qué; lo que no pudo mirar es «no sé», y tampoco cierra. A una sesión
 * interactiva la verifica y avisa: esa pestaña la cierra la persona. `{ ok, closed, message }`.
 */
function close(opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  const name = opts.name;
  const no = (message) => ({ ok: false, closed: false, message: oneLine(message) });
  if (!name || !NAME_RE.test(String(name))) return no('close va con --name <el nombre de la sesión>: no cerré nada.');
  if (isCodex(env) && !opts.launcher) return no('Codex no tiene sesiones de fondo que cerrar: no cerré nada.');
  // el nombre lo escribe la coordinadora o una persona en su terminal: una sesión de trabajo no cierra a otra
  const caller = sessionOf({ ...opts, env });
  const d = designacionVigente({ home });
  if (d && d.error) return no(`No pude saber cuál es la coordinadora (${d.error}): no cerré nada.`);
  if (caller && (!d || d.sesion !== caller)) return no('Una sesión la cierra la coordinadora designada o una persona en su terminal: no cerré nada.');
  const unreadable = [];
  const sessions = sessionsBySid(path.join(claudeDir(home), 'sessions'), unreadable, path.join(claudeDir(home), 'projects'));
  if (unreadable.length) return no(`No pude leer todas las sesiones (${unreadable[0]}): no cerré nada.`);
  const found = [...sessions.entries()].filter(([, s]) => s.name === name);
  const alive = found.filter(([, s]) => s.alive);
  if (!found.length) return no(`No encuentro la sesión «${name}»: no cerré nada.`);
  if (alive.length > 1 || (!alive.length && found.length > 1)) return no(`Hay más de una sesión «${name}»: no cerré nada.`);
  const [sid, s] = alive[0] || found[0];
  if (sid === caller) return no('Una sesión no se cierra a sí misma: no cerré nada.');
  const missing = [];
  const unknown = [];
  // sólo una quieta: `shell` es un comando corriendo, y un estado que no se conoce tampoco es estar quieta
  if (s.alive && s.status !== 'idle') missing.push(`está trabajando (${oneLine(s.status) || 'sin estado'})`);
  const folder = s.cwd ? folderGaps(s.cwd, { home, env, arnes: opts.arnes, startedAt: s.startedAt }) : { missing: [], unknown: ['no anotó su carpeta: no puedo mirarla'] };
  const run = runGaps(sid, home);
  missing.push(...folder.missing, ...run.missing);
  unknown.push(...folder.unknown, ...run.unknown);
  if (missing.length || unknown.length) {
    const parts = [missing.length ? `falta: ${missing.join('; ')}` : '', unknown.length ? `no sé: ${unknown.join('; ')}` : ''].filter(Boolean);
    return no(`No cierro «${name}»: ${parts.join('. ')}.`);
  }
  if (!/^(bg|background)$/.test(String(s.kind))) return { ok: true, closed: false, message: `«${name}» quedó limpia. Es una pestaña interactiva: la cierra la persona.` };
  // el id va como argumento del lanzador: uno que empieza con guion se leería como una opción
  if (!/^\w[\w-]*$/.test(String(s.jobId || ''))) return no(`«${name}» quedó limpia, pero no anotó un id de fondo válido: no sé cómo cerrarla. Mirá el id con claude agents.`);
  const launcher = opts.launcher || { bin: 'claude', prefix: [] };
  const run1 = (verb) => spawnSync(launcher.bin, [...(launcher.prefix || []), verb, s.jobId], { encoding: 'utf8', timeout: opts.timeoutMs || LAUNCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const why = (r) => (r.error ? (r.error.code || r.error.message) : (`${r.stderr || ''}\n${r.stdout || ''}`.split('\n').map((l) => l.trim()).find(Boolean) || `salió con código ${r.status}`));
  if (s.alive) {
    const stop = run1('stop');
    if (stop.error || stop.status !== 0) return no(`«${name}» quedó limpia, pero no la pude parar (${why(stop)}): no la cerré.`);
  }
  const rm = run1('rm');
  if (rm.error || rm.status !== 0) return no(`«${name}» quedó parada, pero no la pude borrar (${why(rm)}).`);
  // sin leer la lista no se la reescribe: vacía, el tope dejaría de contar a las recién abiertas
  const openedProblems = [];
  const opened = recentOpened(home, opts.now == null ? Date.now() : Number(opts.now), openedProblems);
  if (openedProblems.length) return { ok: true, closed: true, message: oneLine(`Cerré «${name}». Pero no pude leer las abiertas (${openedProblems[0]}): sigue contando para el tope hasta que venza.`) };
  try { writeJson(openedFile(home), opened.filter((o) => o.name !== name)); } catch (e) {
    return { ok: true, closed: true, message: oneLine(`Cerré «${name}». Pero no pude sacarla de las abiertas (${e.code || e.message}).`) };
  }
  return { ok: true, closed: true, message: `Cerré «${name}»: quedó limpia, sin nada pendiente.` };
}

// ── La línea de comandos ──

function flags(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a === '--json') out.json = true;
    else if (/^--[a-z-]+$/.test(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} pide un valor`);
      out[a.slice(2)] = v;
    } else out.rest.push(a);
  }
  return out;
}

function main(argv) {
  const [cmd, ...more] = argv;
  let f;
  try { f = flags(more); } catch (e) { process.stderr.write(`coordination.js: ${e.message}\n`); return 2; }
  const base = { env: process.env };
  if (cmd === 'status') {
    const s = status(base);
    process.stdout.write(f.json ? `${JSON.stringify(s, null, 2)}\n` : `${statusText(s)}\n`);
    return 0;
  }
  if (cmd === 'coordinate') {
    const r = coordinate(base);
    process.stdout.write(`${r.text}\n`);
    return r.code;
  }
  if (cmd === 'signature') {
    const r = signature({ ...base, kind: f.kind, title: f.title, cwd: f.cwd, command: f.rest });
    process.stdout.write(`${r.message}\n`);
    return r.wrote || r.printed ? 0 : 1;
  }
  if (cmd === 'signature-done') {
    const r = signatureDone(f.rest[0], base);
    process.stdout.write(`${r.message}\n`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'open') {
    // el modo no se elige: se copia el de la sesión que abre, así nunca queda más alto
    if (f['permission-mode'] !== undefined) {
      process.stderr.write('coordination.js: open no elige el modo de permisos: copia el de la sesión que lo llama.\n');
      return 2;
    }
    const r = open({ ...base, name: f.name, cwd: f.cwd, repo: f.repo, branch: f.branch, task: f.rest.join(' '), timeoutMs: f['timeout-ms'] ? Number(f['timeout-ms']) : undefined });
    process.stdout.write(`${r.message}\n`);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'close') {
    const r = close({ ...base, name: f.name });
    process.stdout.write(`${r.message}\n`);
    return r.ok ? 0 : 1;
  }
  process.stderr.write('uso: coordination.js status [--json] | coordinate | signature --kind <tema> --title <qué> --cwd <carpeta> -- <comando...> | signature-done <id> | open [--name <n>|auto] (--cwd <carpeta> | --repo <repo> [--branch <rama>]) -- <encargo> | close --name <n>\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { status, statusText, readPending, capNotice, liveCoordinator, adversarialTurn, coordinate, signature, signatureBody, signatureDone, open, close, capCheck, noteOpened, callerPermissionMode, coordinationDir, ORIGIN };
