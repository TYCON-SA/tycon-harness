#!/usr/bin/env node
'use strict';
/**
 * conversation-fixture.js — escribe la conversación de juguete de una sesión en la HOME del banco, para los casos de
 * los frenos que leen lo que dijo la persona (los escapes que se autorizan con «autorizo <VARIABLE>»).
 * Casos: scripts/controls-bench/cases/hooks/01-frenos-duros.json.
 *
 * Uso (en el `setup` de un caso):
 *   node "$TCG/scripts/controls-bench/conversation-fixture.js" --who person --text "autorizo TYCON_SAFETY_OFF" [--minutes-ago 2] [--session bench-escape] [--forged]
 *   --who person: un turno tipeado por la persona · --who agent: un mensaje del agente · --who command: el pedido del
 *   comando que se juzga (un tool_use con el id de `--tool-use-id`, por defecto `bench-tu`), que va último y que el caso
 *   pasa en la entrada del freno como `tool_use_id` · --who write --text <ruta>: una escritura de esa ruta que no falló ·
 *   --who validator --text <ruta>: una llamada al validador de historias que la nombra, con su respuesta.
 * Agrega un renglón a `$HOME/.claude/projects/-bench/<sesión>.jsonl` con la hora de hace `--minutes-ago` minutos,
 * encadenado como lo guarda Claude Code: su `uuid` y el del renglón anterior como padre (`parentUuid`).
 * `--forged`: el renglón queda afuera de la cadena, como uno agregado al archivo por fuera; después se escribe el
 * mensaje del agente que pide el comando, hijo del renglón anterior al forjado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, def) => { const i = process.argv.indexOf(n); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; };
const who = arg('--who', 'person');
const text = arg('--text', '');
const minutes = Number(arg('--minutes-ago', '2'));
const session = arg('--session', 'bench-escape');
const forged = process.argv.includes('--forged');
const toolUseId = arg('--tool-use-id', 'bench-tu');
if (!['person', 'agent', 'command', 'write', 'validator'].includes(who) || (!text && who !== 'command') || !Number.isFinite(minutes) || !/^[\w-]+$/.test(session) || !/^[\w-]+$/.test(toolUseId)) {
  process.stderr.write('conversation-fixture: --who person|agent|command [--text "<texto>"] [--minutes-ago N] [--session id] [--tool-use-id id] [--forged]\n');
  process.exit(2);
}
const dir = path.join(os.homedir(), '.claude', 'projects', '-bench');
const file = path.join(dir, `${session}.jsonl`);
fs.mkdirSync(dir, { recursive: true });
// el padre: el último renglón con uuid que ya está en el archivo
let parent = null;
let count = 0;
if (fs.existsSync(file)) {
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    count++;
    try { const r = JSON.parse(l); if (r.uuid) parent = r.uuid; } catch { /* un renglón roto no corta la cadena de los demás */ }
  }
}
const stamp = (min) => new Date(Date.now() - min * 60000).toISOString();
const rec = (kind, body, min, uuid, parentUuid) => {
  if (kind === 'person') return { type: 'user', timestamp: stamp(min), uuid, parentUuid, message: { role: 'user', content: body } };
  if (kind === 'command') {
    return { type: 'assistant', timestamp: stamp(0), uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }] } };
  }
  return { type: 'assistant', timestamp: stamp(min), uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text: body }] } };
};
// una herramienta y su resultado, encadenados: `write` escribe la ruta de `--text`; `validator` llama al validador de
// historias nombrándola (los casos del freno de historia sin validar, 29-story-skill-gate.json)
const toolPair = (kind, ruta, uuid, parentUuid) => {
  const id = `${kind}-${count}`;
  const use = kind === 'write'
    ? { type: 'tool_use', id, name: 'Write', input: { file_path: ruta, content: '' } }
    : { type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'tycon-story-validator', prompt: `Validar la story en ${ruta}` } };
  return [
    { type: 'assistant', timestamp: stamp(minutes), uuid, parentUuid, message: { role: 'assistant', content: [use] } },
    { type: 'user', timestamp: stamp(minutes), uuid: `${uuid}-r`, parentUuid: uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: kind === 'write' ? 'File created successfully' : 'Veredicto: limpio' }] } },
  ];
};
const lines = [];
if (who === 'write' || who === 'validator') {
  lines.push(...toolPair(who, text, `rec-${count}`, parent));
} else if (forged) {
  lines.push(rec(who, text, minutes, `forged-${count}`, parent));
  lines.push(rec('command', '', 0, `cmd-${count}`, parent));
} else {
  lines.push(rec(who, text, minutes, `rec-${count}`, parent));
}
fs.appendFileSync(file, lines.map((r) => `${JSON.stringify(r)}\n`).join(''));
