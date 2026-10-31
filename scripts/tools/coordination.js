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
 *                            abre una sesión de fondo con ese nombre; nunca reintenta
 *
 * Además, sin línea de comandos: `capNotice` es el aviso del tope que la coordinadora ve en cada turno
 * (scripts/hooks/coordination-notice.js) y `adversarialTurn` es lo que `deep-review-gate` agrega cuando otra sesión
 * tiene un pase adversarial en vuelo. Los dos callan sin coordinadora designada.
 *
 * Trabaja una sesión cuyo archivo dice `busy`, una de Codex con actividad en los últimos 5 minutos y una que abrió
 * `open` hace menos de 10 minutos y todavía no escribió su archivo. Las sesiones se leen con lo mismo que usa /wip.
 * El tope sale del lector de configuración (`coordination.max_working`, 3 sin valor); la carpeta de las firmas,
 * también (`coordination.owner_folder`, sólo de la máquina). Lo que este guion anota vive en `<estado>/coordination/`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
const { stateDir, claudeDir } = require(path.join(SKILL_LIB, 'state-dir.js'));
const { adversarialInFlight } = require(path.join(SKILL_LIB, 'codex-reviewers.js'));
const { sesionQueReenvia, designacionVigente } = require(path.join(SKILL_LIB, 'critical-waivers.js'));
const { sessionsBySid } = require('./work-in-progress.js');
const tyconConfig = require(path.join(__dirname, '..', 'lib', 'tycon-config.js'));

const CODEX_WINDOW_MS = 5 * 60000;
// Una sesión de Codex quieta hace más de tres horas ya no está esperando: no se lista.
const CODEX_IDLE_MS = 3 * 3600000;
const OPENED_WINDOW_MS = 10 * 60000;
const LAUNCH_TIMEOUT_MS = 30000;
// Empieza con letra o número: el nombre va como valor de `-n` y no puede leerse como una bandera.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
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

// La configuración de esta máquina: el tope y la carpeta de las firmas, con su origen. Un error del lector no tumba el
// estado: el tope queda en el de fábrica y el motivo va en `problems`.
function recipe({ home, arnes, env }) {
  try {
    const cfg = tyconConfig.cargar({ home, env, ...(arnes ? { arnes } : {}) });
    const r = tyconConfig.coordinacion(cfg);
    const problem = cfg.errores && cfg.errores.length ? `la configuración no se pudo leer entera (${cfg.errores[0].clave || cfg.errores[0].archivo}: ${cfg.errores[0].motivo})` : null;
    return { ...r, problem };
  } catch (e) {
    return { max_working: { value: 3, origin: 'sin-valor' }, owner_folder: { value: null, origin: 'sin-valor' }, problem: `el lector de configuración falló (${e.message})` };
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
    else waiting.push({ session: nameOf(sid), sid, why: story ? `${story}, ${s.status || 'sin estado'}` : 'sin trabajo' });
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
    working, waiting, cap: r.max_working, adversarial,
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

/**
 * El aviso del tope para la sesión coordinadora: en el tope, quiénes trabajan; pasado el tope, por cuánto y cuál trabaja
 * hace menos. Debajo del tope, null. Después, las firmas del dueño que esperan hace más de un día. Lo que no pudo leer
 * va en una línea. No abre ninguna conversación.
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
  const signatures = oldSignatures(opts, opts.now == null ? Date.now() : Number(opts.now), problems);
  if (signatures) lines.push(signatures);
  lines.push(...waitLines(opts, sid, problems));
  if (problems.length) lines.push(`Coordinación: No pude leer ${oneLine(problems.join(' · ')).slice(0, 300)}.`);
  return lines.length ? lines.join('\n') : null;
}

/**
 * Lo que `deep-review-gate` agrega cuando otra sesión tiene un pase adversarial en vuelo: `{ other_in_flight, turn }`.
 * Sin otro pase, o sin coordinadora designada, null.
 */
function adversarialTurn(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || require('os').homedir();
  const sid = sessionOf(opts);
  const d = designacionVigente({ home });
  if (!d || d.error) return null;
  const rol = sesionQueReenvia({ env, home, arnes: opts.arnes });
  if (!rol.valor) return null;
  const problems = [];
  const sessions = sessionsBySid(path.join(claudeDir(home), 'sessions'), problems, null);
  // Una coordinadora que ya se cerró no da turnos; el pase de una sesión que ya no vive quedó abandonado.
  if (!(sessions.get(d.sesion) || {}).alive) return null;
  const markers = markersBySid(home, problems);
  const others = [...markers].filter(([k, m]) => k !== sid && adversarialInFlight(m) && (!sessions.has(k) || sessions.get(k).alive));
  if (!others.length) return null;
  const nameOf = (k) => { const s = sessions.get(k); return (s && s.name && label(s.name)) || String(k).slice(0, 8); };
  const other_in_flight = inFlight(new Map(others), nameOf).map(({ sid: _s, ...a }) => a);
  const list = other_in_flight.map((a) => `${a.storyId ? `la ${a.storyId}` : 'sin story'}, ${a.session}, desde las ${hhmm(a.since)}`).join(' · ');
  return { other_in_flight, turn: `Hay otro pase adversarial en vuelo (${list}): pedile turno a la ${rol.valor} antes de lanzar este.` };
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

/** Abre una sesión de fondo con nombre y encargo. Nunca reintenta; sólo una apertura que salió bien queda anotada. */
function open(opts = {}) {
  const home = opts.home || require('os').homedir();
  const env = opts.env || process.env;
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const { name, task, cwd } = opts;
  const no = (message) => ({ ok: false, message: oneLine(message) });
  if (isCodex(env) && !opts.launcher) return no('Codex no tiene cómo abrir una sesión de fondo: esa sesión la abre el dueño.');
  if (!NAME_RE.test(String(name || ''))) return no('El nombre de la sesión va con letras, números, guion o guion bajo, sin espacios: no la abrí.');
  const s = status({ ...opts, home, env, now });
  // Sin leer todo no se sabe el tope ni qué nombres están tomados: no se abre a ciegas.
  if (s.problems.length) return no(`No pude leer todo el estado de la máquina (${s.problems[0]}): no la abrí.`);
  const taken = new Set([...sessionsBySid(path.join(claudeDir(home), 'sessions'), [], path.join(claudeDir(home), 'projects')).values()]
    .filter((x) => x.alive && x.name).map((x) => x.name));
  const openedProblems = [];
  for (const o of recentOpened(home, now, openedProblems)) taken.add(o.name);
  if (openedProblems.length) return no(`No pude saber qué sesiones se abrieron recién (${openedProblems[0]}): no la abrí.`);
  if (taken.has(name)) return no(`«${name}» ya lo usa otra sesión viva: no la abrí.`);
  if (!oneLine(task)) return no('Falta el encargo de la sesión: no la abrí.');
  if (s.working.length >= s.cap.value) return no(`Ya hay ${s.working.length} trabajando y el tope es ${s.cap.value} (${ORIGIN[s.cap.origin] || s.cap.origin}): no la abrí, espera su turno.`);
  if (!cwd || !path.isAbsolute(cwd)) return no('Falta la carpeta de la sesión, absoluta: no la abrí.');
  if (!fs.existsSync(cwd)) return no(`La carpeta ${cwd} no existe: no la abrí.`);
  const launcher = opts.launcher || { bin: 'claude', prefix: [] };
  const timeoutMs = opts.timeoutMs || LAUNCH_TIMEOUT_MS;
  const r = spawnSync(launcher.bin, [...(launcher.prefix || []), '--bg', '-n', name, '--', String(task)], {
    cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (r.error && r.error.code === 'ENOENT') return no(`Claude Code no está instalado en esta máquina (no encontré ${launcher.bin}): no abrí la sesión.`);
  if (r.error && r.error.code === 'ETIMEDOUT') return no(`El lanzador no volvió en ${Math.round(timeoutMs / 1000)} s: no sé si abrió la sesión y no reintenté. Mirá con /wip.`);
  if (r.error) return no(`El lanzador falló (${r.error.code || r.error.message}): no abrí la sesión.`);
  if (r.status !== 0) {
    const out = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (/not trusted/i.test(out)) return no(`La carpeta ${cwd} todavía no está aprobada para Claude Code: la abre el dueño una vez. Mientras tanto, la sesión la abre el dueño y yo le doy el encargo.`);
    const first = out.split('\n').map((l) => l.trim()).find(Boolean);
    return no(`El lanzador falló: ${first || (r.signal ? `lo cortó la señal ${r.signal}` : `salió con código ${r.status}`)}. No reintenté.`);
  }
  const opened = `Abrí «${name}» en ${cwd}. Para entrar: claude attach ${name}`;
  try {
    writeJson(openedFile(home), [...recentOpened(home, now, []).filter((o) => o.name !== name), { name, cwd, at: now }]);
  } catch (e) {
    return { ok: true, message: oneLine(`${opened}. Pero no la pude anotar (${e.code || e.message}): hasta que escriba su archivo de sesión no cuenta para el tope.`) };
  }
  return { ok: true, message: opened };
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
    const r = open({ ...base, name: f.name, cwd: f.cwd, task: f.rest.join(' '), timeoutMs: f['timeout-ms'] ? Number(f['timeout-ms']) : undefined });
    process.stdout.write(`${r.message}\n`);
    return r.ok ? 0 : 1;
  }
  process.stderr.write('uso: coordination.js status [--json] | coordinate | signature --kind <tema> --title <qué> --cwd <carpeta> -- <comando...> | signature-done <id> | open --name <n> --cwd <carpeta> -- <encargo>\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { status, statusText, capNotice, liveCoordinator, adversarialTurn, coordinate, signature, signatureBody, signatureDone, open, coordinationDir };
