#!/usr/bin/env node
'use strict';
/**
 * session-state.js — anota en el archivo de estado de la sesión (`<estado>/sessions/<sesión>.json`) el arranque, la
 * espera y el cierre, en los momentos de cada herramienta. Lo lee la oficina de /office.
 *
 *   Claude: SessionStart → crea el archivo (nombre y pid del archivo de sesión de Claude), con el paso del marcador si hay uno
 *           Notification permission_prompt → espera «un permiso» · PreToolUse de las preguntas → «una respuesta»
 *           PostToolUse, UserPromptSubmit, Stop → ya no espera · SessionEnd → borra el archivo
 *   Codex:  SessionStart → crea el archivo (sin nombre ni pid: Codex no da uno estable). Su arranque no trae `turn_id`:
 *           se lo reconoce por la carpeta de su conversación (toolOf), y el próximo momento corrige un archivo mal creado
 *           Stop con un pipeline abierto → espera «una respuesta» · UserPromptSubmit → ya no espera
 *           Codex no avisa los pedidos de permiso ni el cierre de la sesión: no se inventan (adapters/codex/hooks.json,
 *           la asimetría declarada). Una firma pendiente no es la espera de una sesión: su registro no dice de cuál es.
 *
 * Cualquier momento crea el archivo si falta. La espera la anota este gancho y no wait-notice.js, que no anota nada sin
 * pipeline ni sin un canal de aviso. Nunca frena ni imprime: todo error sale 0 y queda en
 * `<estado>/office/session-state-errors.log`. Off: TYCON_SESSION_STATE=0.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'session-state.js');
const WAIT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'mcp__spokenly__ask_user_dictation']);
const PERMISSION = 'un permiso';
const ANSWER = 'una respuesta';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * De qué herramienta es el momento: `{ tool, certain }`. Codex manda `turn_id` en todos sus momentos menos el arranque;
 * en el arranque se lo reconoce por dónde guarda su conversación (`.codex/` o CODEX_HOME), y si no, por su variable de
 * sesión. `certain` es para corregir un archivo creado con la herramienta equivocada: sólo con `turn_id`, o con la
 * conversación en la carpeta de cada una.
 */
function toolOf(d, env) {
  if (typeof d.turn_id === 'string') return { tool: 'codex', certain: true };
  const t = typeof d.transcript_path === 'string' ? path.resolve(d.transcript_path) : '';
  const parts = t ? t.split(/[\\/]/) : [];
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : null;
  // Claude guarda sus conversaciones en `.claude/projects/`: se mira primero, así una carpeta `.codex` más adentro no la confunde
  const ci = parts.indexOf('.claude');
  if (ci >= 0 && parts[ci + 1] === 'projects') return { tool: 'claude', certain: true };
  if (parts.includes('.codex') || (codexHome && t.startsWith(codexHome + path.sep))) return { tool: 'codex', certain: true };
  if ((env.CODEX_SESSION_ID || env.CODEX_THREAD_ID) && !env.CLAUDE_CODE_SESSION_ID) return { tool: 'codex', certain: false };
  return { tool: 'claude', certain: false };
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// El nombre y el pid de una sesión de Claude: de su archivo en la carpeta de sesiones de Claude (`<pid>.json`, con su
// sessionId). Si quedaron dos con la misma sesión, manda el del proceso vivo (como en /wip); entre iguales, el más nuevo.
function claudeSession(home, sid, { sdir = null, alive = isAlive } = {}) {
  const { claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const dir = path.join(claudeDir(home), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code !== 'ENOENT' && sdir) require(LIB).logError(sdir, `sesión ${sid}: no pude leer la carpeta de sesiones de Claude (${e.code || e.message})`);
    return { name: null, pid: null };
  }
  const found = [];
  for (const n of names) {
    const s = readJson(path.join(dir, n));
    if (!s || s.sessionId !== sid) continue;
    const pid = Number(s.pid);
    const ok = Number.isInteger(pid) && pid > 0;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* sin fecha: el último */ }
    found.push({ name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : null, pid: ok ? pid : null, alive: ok && alive(pid), mtime });
  }
  if (!found.length) return { name: null, pid: null };
  found.sort((a, b) => (Number(b.alive) - Number(a.alive)) || (b.mtime - a.mtime));
  return { name: found[0].name, pid: found[0].pid };
}

// ¿Hay un pipeline abierto? Un marcador que existe y no se lee cuenta como no abierto, y queda en el registro.
const pipelineOpen = (sdir, sid) => {
  const file = path.join(sdir, 'active', `${String(sid).replace(/[^\w.-]/g, '_')}.json`);
  let m = null;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') require(LIB).logError(sdir, `sesión ${sid}: su marcador no se pudo leer (${e.code || e.message})`);
    return false;
  }
  return Boolean(m && Array.isArray(m.stepsPending) && m.stepsPending.length);
};

/** Lo que cambia en el archivo con este momento: `{ patch }`, `{ remove: true }` o null (nada que anotar). */
function decide(d, codex, sdir) {
  const ev = d.hook_event_name;
  if (codex) {
    if (ev === 'Stop') return { patch: pipelineOpen(sdir, d.session_id) ? { waitingForOwner: true, waitingFor: ANSWER } : { waitingForOwner: false, waitingFor: null } };
    if (ev === 'UserPromptSubmit') return { patch: { waitingForOwner: false, waitingFor: null } };
    if (ev === 'SessionStart') return { patch: {} };
    return null;
  }
  if (ev === 'SessionEnd') return { remove: true };
  if (ev === 'Notification') {
    if (d.notification_type && d.notification_type !== 'permission_prompt') return null;
    return { patch: { waitingForOwner: true, waitingFor: PERMISSION } };
  }
  if (ev === 'PreToolUse') return WAIT_TOOLS.has(d.tool_name) ? { patch: { waitingForOwner: true, waitingFor: ANSWER } } : null;
  if (ev === 'PostToolUse' || ev === 'UserPromptSubmit' || ev === 'Stop') return { patch: { waitingForOwner: false, waitingFor: null } };
  if (ev === 'SessionStart') return { patch: {} };
  return null;
}

function handle(d, env = process.env, home = os.homedir()) {
  const lib = require(LIB);
  const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const sdir = stateDir(home);
  const sid = d && typeof d.session_id === 'string' ? d.session_id : null;
  if (!sid) return;
  const { tool, certain } = toolOf(d, env);
  const codex = tool === 'codex';
  const what = decide(d, codex, sdir);
  if (!what) return;
  if (what.remove) { lib.remove(sdir, sid, { env }); return; }
  const retool = certain;
  // un archivo que falta (o que está roto) se arma de nuevo, con el paso del marcador y quién es la sesión
  const cur = lib.read(sdir, sid);
  if (cur.problem) lib.logError(sdir, `sesión ${sid}: su estado no se podía usar y se arma de nuevo (${cur.problem})`);
  if (!cur.state) {
    const who = codex ? { name: null, pid: null } : claudeSession(home, sid, { sdir });
    const r = lib.refresh(sdir, sid, { create: true, tool, home, env });
    if (r === 'error') return;
    lib.update(sdir, sid, { ...who, ...what.patch }, { env, tool, retool });
    return;
  }
  // un archivo de Codex creado como de Claude (o al revés) cambia de herramienta, y en Codex deja el pid de Claude
  const fix = retool && cur.state.tool !== tool ? (codex ? { name: null, pid: null } : claudeSession(home, sid, { sdir })) : {};
  // en el arranque, quién es la sesión y su paso se vuelven a leer: pudo cambiar de nombre o retomarse
  if (d.hook_event_name === 'SessionStart') {
    const who = codex ? fix : claudeSession(home, sid, { sdir });
    lib.refresh(sdir, sid, { tool, home, env });
    lib.update(sdir, sid, { ...who, ...what.patch }, { env, tool, retool });
    return;
  }
  lib.update(sdir, sid, { ...fix, ...what.patch }, { env, tool, retool });
}

module.exports = { decide, handle, claudeSession, toolOf, WAIT_TOOLS };

if (require.main === module) {
  const env = process.env;
  if (env.TYCON_SESSION_STATE === '0') process.exit(0);
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  let d = null;
  try { d = JSON.parse(raw || '{}'); } catch (e) {
    try {
      const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
      require(LIB).logError(stateDir(os.homedir()), `la entrada del gancho no es JSON (${e.message})`);
    } catch { /* sin registro tampoco */ }
    process.exit(0);
  }
  try { handle(d, env); } catch (e) {
    try {
      const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
      require(LIB).logError(stateDir(os.homedir()), `sesión ${d && d.session_id}: ${e.message}`);
    } catch { /* sin registro tampoco */ }
  }
  process.exit(0);
}
