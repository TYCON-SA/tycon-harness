#!/usr/bin/env node
/**
 * reviewer-launch-gate.js — PreToolUse (matcher: Task|Agent): un revisor del arnés no sale mientras el pase
 * adversarial que corresponde no esté en vuelo.
 *
 * El pase es el camino más largo de la revisión: si sale después de los revisores, la revisión entera se alarga.
 * `pipeline.js next` ya pide lanzarlo antes del primer revisor, pero un pedido se olvida. Este freno decide con la
 * misma función que `next` (`accionDelPase`, que exporta `pipeline.js`) y niega en tres casos: falta consultar el
 * portón del pase (`consultar-porton`), el portón dijo que corre y no se lanzó (`lanzar-pase`), o el pase quedó sin
 * medir y hay que relanzarlo (`relanzar-pase-no-medido`). Todo lo demás pasa: el turno del pase ocupado por otra
 * sesión, un pase de otra sesión (si venció, `next` lo relanza en el paso del pase, no antes de los revisores), el
 * pase atendido o en vuelo, y el lanzamiento temprano apagado (`adversarialGate.early_launch === false`, que anota el
 * portón con `TYCON_5B_EARLY=0`): es la vuelta atrás de los tres casos, y por eso se mira antes que nada.
 *
 * Sólo juzga a los revisores del arnés —los del núcleo (`CORE_REVIEWERS`, sin el validador de historias) y los de los
 * paquetes activos del repo que no son del grupo `validacion`— y sólo con «Correr las pruebas» cerrado en el marcador
 * de esta sesión: antes no hay nada que revisar. Codex lanza sus revisores por otro camino y no pasa por acá.
 *
 * Un freno roto no puede parar la máquina: lo que no puede leer (el marcador, la historia, la sesión) o cualquier
 * error deja pasar y queda en `gates.log` como `reviewer-launch-gate-unreadable`, con su motivo. Cada negativa queda
 * como `reviewer-launch-blocked`, con el caso y el tipo de subagente.
 *
 * `decide(event)` es la decisión entera, sin escribir nada; la usa también `on-advisor-run.js`, para no anotar como
 * revisor corrido un lanzamiento que este freno niega. Toda salida trae su `reason`.
 *
 * Exit 2 con el motivo en stderr al negar; exit 0 siempre que deja pasar.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// Las bibliotecas del arnés se cargan adentro de cada `try`: una que no carga deja pasar con constancia, no mata el hook.
const stateDir = (home) => require('./lib/state-dir.js').stateDir(home);
const sessionIdFileKey = (sid) => require('./lib/session-id.js').sessionIdFileKey(sid);

const LAUNCH_TOOLS = new Set(['Task', 'Agent']);
// Los subagentes de exploración libre: no son revisión (el mismo conjunto que `on-advisor-run.js`).
const EXPLORATION = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
// Los casos del pase que niegan: los que piden lanzarlo, relanzarlo o consultar su portón antes del primer revisor.
const DENIED_KINDS = new Set(['consultar-porton', 'lanzar-pase', 'relanzar-pase-no-medido']);
const FOREIGN_KINDS = new Set(['esperar-pase-ajeno', 'relanzar-pase-ajeno']);
// Los motivos de lo que no se pudo leer, tal como quedan en `gates.log`.
const UNREADABLE = {
  marker: 'marcador-ilegible',
  noStoryPath: 'sin-ruta-de-story',
  story: 'story-ilegible',
  noSession: 'sin-sesion',
  input: 'entrada-ilegible',
  error: 'error',
};
const NO_RELAUNCH = 'Si ya lo lanzaste en este turno, no lo relances: marcalo con ese comando y volvé a lanzar los revisores.';

const allow = (reason, extra) => ({ deny: false, reason, ...(extra || {}) });
const unreadable = (motivo, detail) => allow('unreadable', { unreadable: motivo, ...(detail ? { detail } : {}) });

/** El marcador de la sesión, leído acá: `null` sin archivo (o sin historia); `{ error }` con el JSON roto. */
function readMarker(sessionId) {
  const file = path.join(stateDir(os.homedir()), 'active', `${sessionIdFileKey(sessionId)}.json`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? null : { error: `${file}: ${e.code || e.message}` };
  }
  try {
    const m = JSON.parse(raw);
    return m && m.storyId ? m : null;
  } catch (e) { return { error: `${file}: ${e.message}` }; }
}

// La historia como la lee `next`: la ruta del marcador tal cual, y vacía si no se puede leer.
function readStory(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** ¿Es un revisor del arnés en este repo? El núcleo sin el validador de historias, y los paquetes activos fuera de `validacion`. */
function isHarnessReviewer(agent, repo) {
  const pipeline = require('./pipeline.js');
  if (pipeline.CORE_REVIEWERS.some((r) => r.agent === agent && r.agent !== 'tycon-story-validator')) return true;
  return pipeline.paquetesActivos(repo).some((p) => (p.revisores || []).some((r) => r.agente === agent && r.grupo !== 'validacion'));
}

/**
 * La decisión para un lanzamiento: `{ deny, reason, kind?, message?, unreadable?, detail? }`. No escribe nada.
 * @param {object} event la entrada del hook PreToolUse
 */
function decide(event) {
  try {
    const e = event || {};
    if (!LAUNCH_TOOLS.has(e.tool_name)) return allow('not-a-launch');
    const agent = e.tool_input && e.tool_input.subagent_type;
    if (!agent || typeof agent !== 'string') return allow('no-subagent-type');
    if (EXPLORATION.has(agent)) return allow('exploration');
    if (!e.session_id) return unreadable(UNREADABLE.noSession);
    const marker = readMarker(e.session_id);
    if (!marker) return allow('no-marker');
    if (marker.error) return unreadable(UNREADABLE.marker, marker.error);
    if (!require('./lib/steps.js').isDone(marker, 'run-tests')) return allow('tests-open');
    if (!isHarnessReviewer(agent, marker.repoPath || e.cwd || process.cwd())) return allow('not-a-reviewer');

    const gate = marker.adversarialGate && typeof marker.adversarialGate === 'object' ? marker.adversarialGate : null;
    if (gate && gate.early_launch === false) return allow('early-off');

    const story = marker.storyPath ? readStory(marker.storyPath) : '';
    const { accionDelPase } = require('./pipeline.js');
    // La sesión se compara tal cual, como en `next`: el marcador guarda el id crudo; la forma normalizada sólo nombra
    // su archivo.
    const r = accionDelPase(marker, story, { sidNow: e.session_id, nextStep: 'reviewers' });
    const pending = r.pending_action || null;
    if (pending && DENIED_KINDS.has(pending.kind)) {
      const message = pending.kind === 'consultar-porton' ? pending.message : `${pending.message}. ${NO_RELAUNCH}`;
      return { deny: true, reason: pending.kind, kind: pending.kind, message };
    }
    if (pending && pending.kind === 'esperar-turno-pase') return allow('turn-busy', { kind: pending.kind });
    if (pending && FOREIGN_KINDS.has(pending.kind)) return allow('foreign-pass', { kind: pending.kind });
    if (pending) return allow('other-pending', { kind: pending.kind });

    const { veredictoPaseAdversarial, paseAtendido } = require('./lib/adversarial-verdict.js');
    if (paseAtendido(veredictoPaseAdversarial(marker))) return allow('pass-handled');
    if (marker.adversarial && marker.adversarial.sessionId === e.session_id) return allow('pass-in-flight');
    if (!marker.storyPath) return unreadable(UNREADABLE.noStoryPath);
    if (!story) return unreadable(UNREADABLE.story, marker.storyPath);
    return allow('pass-not-needed');
  } catch (err) {
    return unreadable(UNREADABLE.error, String((err && err.message) || err).split('\n')[0].slice(0, 200));
  }
}

function logGate(entry) {
  try {
    const dir = stateDir(os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch { /* sin registro, la decisión vale igual */ }
}

function main() {
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch (err) {
    logGate({ name: 'reviewer-launch-gate-unreadable', motivo: UNREADABLE.input, detail: String((err && err.message) || err).slice(0, 200) });
    return;
  }
  const d = decide(event);
  const e = event || {};
  const agent = e.tool_input && e.tool_input.subagent_type;
  const marker = d.deny ? readMarker(e.session_id) : null;
  if (d.deny) {
    logGate({ sessionId: e.session_id || null, name: 'reviewer-launch-blocked', kind: d.kind, subagent_type: agent, storyId: marker && marker.storyId ? marker.storyId : null });
    try {
      process.stderr.write(`⛔ tycon-pipeline — el revisor \`${agent}\` no sale todavía: el pase adversarial tiene que estar en vuelo antes.\n  ${d.message}\n`);
    } catch { /* frena igual */ }
    process.exit(2);
  }
  if (d.reason === 'unreadable') {
    logGate({ sessionId: e.session_id || null, name: 'reviewer-launch-gate-unreadable', motivo: d.unreadable, subagent_type: agent || null, ...(d.detail ? { detail: d.detail } : {}) });
  }
}

module.exports = { decide };

if (require.main === module) {
  // un freno roto deja pasar, y lo dice
  try { main(); } catch (err) {
    logGate({ name: 'reviewer-launch-gate-unreadable', motivo: UNREADABLE.error, detail: String((err && err.message) || err).split('\n')[0].slice(0, 200) });
  }
  process.exit(0);
}
