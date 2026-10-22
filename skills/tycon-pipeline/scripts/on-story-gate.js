#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Edit|Write) — portón de CARRIL.
 *
 * DENIEGA la edición de un archivo de código en un repo bajo el arnés TYCON cuando en la sesión no hay
 * pipeline activo (marker) ni carril ad-hoc declarado; con pipeline activo, deniega código mientras el
 * paso «Aprobar el plan» (plan aprobado por el user) siga pendiente; y deniega SIEMPRE las escrituras directas al
 * estado del pipeline (~/.claude/.tycon-pipeline/). Lógica y porqué: `lib/story-gate.js`; I/O
 * compartido con el guard de Bash: `lib/story-gate-io.js`.
 *
 * Sin este portón, el agente puede anunciar "story + pipeline" y largarse a codear, o saltear etapas
 * dentro del pipeline. Un system-reminder previo al marker se puede ignorar.
 *
 * Corre in-process vía dispatch.js ('pre-edit'). Contrato: handle(event) →
 *   null           → dejar pasar
 *   { block: msg } → dispatch escribe msg a stderr y sale con exit 2 (el tool call se deniega)
 *
 * Fail-open VISIBLE (contrato del dispatcher): si tira, queda en hook-errors.log y el Edit sigue.
 *
 * Escapes: env TYCON_STORY_GATE=off (del dev; el agente no puede setear env de hooks) ·
 *          `.tycon/advisors.yaml → pipeline.story_gate: false` COMMITEADO (git show HEAD:).
 */

'use strict';

const io = require('./lib/story-gate-io.js');
const { resolveSessionId } = require('./lib/session-id.js');

function handle(event, opts = {}) {
  if (String(process.env.TYCON_STORY_GATE || '').toLowerCase() === 'off') return null;
  const filePath = event?.tool_input?.file_path;
  if (!filePath) return null;
  const sessionId = resolveSessionId(event?.session_id);
  const r = io.evaluate({
    filePath,
    sessionId,
    cwd: event?.cwd,
    via: event?.tool_name || 'Edit',
    stateDir: opts.stateDir || io.DEFAULT_STATE_DIR,
  });
  if (r.verdict.action !== 'block') return null;
  return { block: r.message + '\n' };
}

module.exports = { handle };

// Shim CLI (standalone): lee el evento de stdin, igual que los demás handlers.
if (require.main === module) {
  const fs = require('fs');
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { event = null; }
  const r = handle(event || {});
  if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
  process.exit(0);
}
