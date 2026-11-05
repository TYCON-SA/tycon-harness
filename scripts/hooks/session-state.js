#!/usr/bin/env node
'use strict';
/**
 * session-state.js — anota en el archivo de estado de la sesión (`<estado>/sessions/<sesión>.json`) el arranque, la
 * espera y el cierre, en los momentos de cada herramienta. Lo lee la oficina de /office.
 *
 *   Claude: SessionStart → crea el archivo (nombre y pid del archivo de sesión de Claude), con el paso del marcador si hay uno
 *           PermissionRequest → espera «un permiso» y anota `permission`: la herramienta, qué pide y desde cuándo
 *           Notification permission_prompt → espera «un permiso»; sin `permission`, lo anota con la herramienta del texto
 *           PreToolUse de las preguntas → «una respuesta»
 *           PostToolUse, UserPromptSubmit, Stop → ya no espera · SessionEnd → borra el archivo
 *           Con un permiso abierto, el PostToolUse de otra herramienta (una en paralelo, un agente de la sesión) no lo
 *           cierra: sólo el de la misma herramienta. Dos usos a la vez de la misma lo pueden cerrar antes de tiempo.
 *   Codex:  SessionStart → crea el archivo (sin nombre ni pid: Codex no da uno estable). Su arranque no trae `turn_id`:
 *           se lo reconoce por la carpeta de su conversación (toolOf), y el próximo momento corrige un archivo mal creado
 *           UserPromptSubmit → ocupada (`busy: true`) y ya no espera · Stop → parada (`busy: false`)
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
const DETAIL_MAX = 200;
// de dónde sale qué pide cada herramienta, en este orden
const DETAIL_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern'];

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
  const { claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const ci = parts.indexOf(path.basename(claudeDir(os.homedir())));
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

/**
 * El permiso que pide la sesión: `{ tool, detail, since }`. `detail` es el comando, la ruta, la dirección o el patrón, en
 * una línea, con las credenciales tapadas y cortado; de una herramienta `mcp__…`, nada: su entrada puede traer cualquier
 * cosa.
 */
function permissionOf(d, now = Date.now()) {
  const tool = typeof d.tool_name === 'string' && d.tool_name ? d.tool_name : 'una herramienta';
  const input = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  let detail = null;
  if (!tool.startsWith('mcp__')) {
    const key = DETAIL_KEYS.find((k) => typeof input[k] === 'string' && input[k].trim());
    if (key) {
      // primero se tapa y después se corta, como en wait-notice.js: cortada, una credencial pierde su forma
      const one = require('./wait-notice.js').redact(input[key].replace(/\s+/g, ' ').trim());
      detail = one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 1)}…` : one;
    }
  }
  return { tool, detail, since: new Date(now).toISOString() };
}

/** La herramienta que nombra la notificación del cuadro («permission to use Bash»), o null. */
function toolOfNotification(d) {
  const m = /permission to use ([\w.:-]+)/i.exec(String(d.message || ''));
  return m ? m[1] : null;
}

/**
 * Lo que cambia en el archivo con este momento: `{ patch }`, `{ remove: true }` o null (nada que anotar). `cur` es el
 * archivo como está, para no pisar el permiso anotado.
 */
function decide(d, codex, cur = null, now = Date.now()) {
  const ev = d.hook_event_name;
  if (codex) {
    if (ev === 'Stop') return { patch: { busy: false } };
    if (ev === 'UserPromptSubmit') return { patch: { busy: true, waitingForOwner: false, waitingFor: null } };
    if (ev === 'SessionStart') return { patch: {} };
    return null;
  }
  const open = cur && cur.permission && typeof cur.permission === 'object' ? cur.permission : null;
  if (ev === 'SessionEnd') return { remove: true };
  if (ev === 'PermissionRequest') return { patch: { waitingForOwner: true, waitingFor: PERMISSION, permission: { ...permissionOf(d, now), via: 'request' } } };
  if (ev === 'Notification') {
    if (d.notification_type && d.notification_type !== 'permission_prompt') return null;
    if (open) return { patch: { waitingForOwner: true, waitingFor: PERMISSION } };
    return { patch: { waitingForOwner: true, waitingFor: PERMISSION, permission: { tool: toolOfNotification(d) || 'una herramienta', detail: null, since: new Date(now).toISOString(), via: 'notification' } } };
  }
  if (ev === 'PreToolUse') return WAIT_TOOLS.has(d.tool_name) ? { patch: { waitingForOwner: true, waitingFor: ANSWER } } : null;
  // sólo el pedido trae el nombre exacto de la herramienta: el de la notificación (el nombre visible, o ninguno) no se
  // compara, y lo cierra el final de cualquier herramienta, como antes
  if (ev === 'PostToolUse' && open && open.via === 'request' && open.tool !== d.tool_name) return null;
  if (ev === 'PostToolUse' || ev === 'UserPromptSubmit' || ev === 'Stop') return { patch: { waitingForOwner: false, waitingFor: null, permission: null } };
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
  const cur = lib.read(sdir, sid);
  const what = decide(d, codex, cur.state);
  if (!what) return;
  if (what.remove) { lib.remove(sdir, sid, { env }); return; }
  const retool = certain;
  // un archivo que falta (o que está roto) se arma de nuevo, con el paso del marcador y quién es la sesión
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

module.exports = { decide, handle, claudeSession, toolOf, permissionOf, WAIT_TOOLS };

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
