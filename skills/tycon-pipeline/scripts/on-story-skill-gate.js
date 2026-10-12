#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Edit|Write) — freno de STORY A MANO.
 *
 * DENIEGA la creación de un `.md` que declara identidad de story Mary+GOLD (`story:` en el
 * frontmatter) cuando el archivo NO existe todavía y en la sesión no consta que se haya invocado
 * un skill que crea stories (`tycon-create-story` y familia — la constancia la deja
 * `on-skill-invoke.js`, PostToolUse sobre la tool Skill). Editar una story que ya existe pasa
 * siempre: el pipeline lo hace todo el tiempo. Lógica y porqué: `lib/story-skill-gate.js`; I/O
 * compartido con la puerta de Bash: `lib/story-skill-gate-io.js`.
 *
 * Caso disparador 2026-08-30 (un producto del equipo, stories AS-1 y PERF-1 — guides/incident-log.md#story-a-mano-sin-skill-2026-08-30): la story se escribió con un heredoc
 * siguiendo story-format.md de memoria — las dos veces la cazó el dev leyendo el chat, no el arnés.
 *
 * Corre in-process vía dispatch.js ('pre-edit'). Contrato: handle(event) →
 *   null           → dejar pasar
 *   { block: msg } → dispatch escribe msg a stderr y sale con exit 2 (el tool call se deniega)
 *
 * Fail-open VISIBLE (contrato del dispatcher): si tira, queda en hook-errors.log y el Write sigue.
 * Escapes: `marker.js story-skill-bypass "<razón>"` (bypass.log) · env TYCON_STORY_SKILL_GATE=off ·
 *          `.tycon/advisors.yaml → pipeline.story_skill_gate: false` COMMITEADO.
 */

'use strict';

const path = require('path');
const io = require('./lib/story-skill-gate-io.js');
const { resolveSessionId } = require('./lib/session-id.js');

function handle(event, opts = {}) {
  if (String(process.env.TYCON_STORY_SKILL_GATE || '').toLowerCase() === 'off') return null;
  const filePath = event?.tool_input?.file_path;
  if (!filePath || !/\.md$/i.test(String(filePath))) return null;
  const cwd = event?.cwd || process.cwd();
  const abs = path.isAbsolute(String(filePath)) ? String(filePath) : path.resolve(cwd, String(filePath));
  const content = event?.tool_input?.content;
  const r = io.evaluate({
    absPath: abs,
    content: typeof content === 'string' ? content : null,
    sessionId: resolveSessionId(event?.session_id),
    via: event?.tool_name || 'Write',
    event,
    stateDir: opts.stateDir || io.DEFAULT_STATE_DIR,
    nowMs: opts.nowMs,
  });
  if (r.verdict.action !== 'block') return null;
  return { block: r.message + '\n' };
}

module.exports = { handle };

if (require.main === module) {
  const fs = require('fs');
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { event = null; }
  const r = handle(event || {});
  if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
  process.exit(0);
}
