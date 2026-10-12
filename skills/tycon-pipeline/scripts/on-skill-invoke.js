#!/usr/bin/env node
/**
 * tycon-pipeline PostToolUse hook (matcher: Skill) — la CONSTANCIA de que se invocó un skill que
 * crea stories. Es la mitad "evidencia" del freno de story-a-mano (`lib/story-skill-gate.js`); la
 * mitad "freno" vive en `on-story-skill-gate.js` (Edit|Write) y en `on-bash-write-gate.js` (Bash).
 *
 * Qué hace: si `tool_input.skill` es uno de CREATOR_SKILLS (tycon-create-story y familia), escribe
 * `~/.claude/.tycon-pipeline/skill-marks/<sid>.json` = { skill, at, sessionId, cwd }. Nada más.
 * Silencioso siempre; exit 0 siempre (PostToolUse no bloquea nada).
 *
 * Por qué la escribe el HARNESS y no el skill (diseño A del handoff, 2026-08-30): la constancia
 * tiene que ser mecánica, no declarativa. Verificado antes de escribir esto: Claude Code emite
 * PostToolUse con `tool_name: "Skill"` y `tool_input.skill` = nombre (823 eventos reales en el
 * grabador de instincts, 26 de tycon-create-story). El agente no puede fabricar la marca con
 * Write/heredoc: el directorio de estado está bloqueado en las dos puertas por el portón de carril.
 *
 * Límite conocido: Codex no expone la invocación de skills como tool call → este hook no tiene
 * evento de su lado (asimetría declarada en adapters/codex/hooks.json); el freno lo sabe y no
 * bloquea bajo Codex. Fail-open visible: errores a hook-errors.log.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // story 8.23 (A2): la carpeta del estado, de una sola pieza
const { isCreatorSkill } = require('./lib/story-skill-gate.js');
const { resolveSessionId } = require('./lib/session-id.js');

function logHookError(e) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] on-skill-invoke FAILED OPEN: ${(e && e.stack) || e}\n\n`, 'utf8');
  } catch { /* noop */ }
}

/**
 * @param {object} event  evento PostToolUse (o PreToolUse) de la tool Skill
 * @param {object} [opts] { stateDir, now } — override para tests
 * @returns {object|null} la marca escrita, o null si el skill no crea stories
 */
function handle(event, opts = {}) {
  if (event?.tool_name && event.tool_name !== 'Skill') return null;
  const skill = event?.tool_input?.skill;
  if (!isCreatorSkill(skill)) return null;
  const io = require('./lib/story-skill-gate-io.js');
  const sessionId = resolveSessionId(event?.session_id);
  const at = opts.now || new Date().toISOString();
  return io.writeMark(opts.stateDir || io.DEFAULT_STATE_DIR, sessionId, {
    skill: String(skill).trim(), at, sessionId, cwd: event?.cwd || process.cwd(), via: 'hook',
  });
}

module.exports = { handle };

if (require.main === module) {
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { event = null; }
  try { handle(event || {}); } catch (e) { logHookError(e); }
  process.exit(0);
}
