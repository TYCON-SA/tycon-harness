#!/usr/bin/env node
/**
 * tycon-pipeline SubagentStop hook — anota los críticos que reportó un revisor, apenas termina.
 *
 * `on-advisor-run.js` anota el LANZAMIENTO de cada revisor (antes de la herramienta). Lo que contestó lo leía sólo el
 * agente, que después arma findings.json: podía omitir un crítico o rebajarlo. Este gancho lee la respuesta del revisor
 * cuando termina, sin pasar por el agente, y la anota en el registro de críticos reportados (lib/reported-criticals.js).
 *
 * Por qué `SubagentStop` y no el gancho de después de la herramienta de agentes: el pipeline lanza los revisores en
 * segundo plano, y en ese caso la herramienta vuelve al lanzar, sin el reporte. `SubagentStop` trae `agent_type`,
 * `agent_transcript_path` y `last_assistant_message`. Los revisores no escriben archivos (sólo leen): el detalle que el
 * orquestador deja en la carpeta de la corrida lo escribe él, y no sirve. Se leen las palabras del revisor, de su
 * transcripción (con lo que haya entregado con la herramienta de entrega, `SubagentHandback`) y `last_assistant_message`.
 *
 * Sólo anota un revisor del set de la vuelta: uno que tiene su lanzamiento en el registro sin reporte, o el mismo agente
 * (`agent_id`) que contesta otra vez —por ejemplo con el detalle que le pidieron—, cuyos críticos se suman. Los demás
 * agentes no le interesan. Una transcripción que no pudo leer la anota como ilegible, con el motivo. Si no puede leer el
 * registro, no sabe de qué salida es la respuesta: no anota nada y lo dice en la salida de errores; el cierre ve la salida
 * sin reporte y frena. Sale 0 siempre: nunca frena el fin de un subagente.
 */

const fs = require('fs');
const os = require('os');

/** El tipo de agente: el del evento o, sin él, el del `.meta.json` de su transcripción. */
function agentTypeOf(event) {
  if (event && typeof event.agent_type === 'string' && event.agent_type) return event.agent_type;
  const t = event && event.agent_transcript_path;
  if (!t) return null;
  try { return JSON.parse(fs.readFileSync(String(t).replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType || null; } catch { return null; }
}

/**
 * Lo que dijo el revisor, de su transcripción: todos los mensajes del asistente (son del revisor; los del usuario son el
 * pedido del orquestador), con lo que haya entregado con la herramienta de entrega. Si después le pidieron el detalle,
 * su respuesta está en la misma transcripción y se suma. `{ text, error? }`.
 */
function reportFromTranscript(file) {
  if (!file) return { text: '', error: 'el evento no trae la transcripción del revisor' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { text: '', error: `no pude leer la transcripción del revisor (${e.code || e.message})` }; }
  const partes = [];
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue;
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    const m = d && d.message;
    if (!m || m.role !== 'assistant') continue;
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const c of content) {
      if (c && c.type === 'text' && c.text) partes.push(c.text);
      if (c && c.type === 'tool_use' && c.name === 'SubagentHandback' && c.input && c.input.message) partes.push(String(c.input.message));
    }
  }
  return { text: partes.join('\n') };
}

function main() {
  let event;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { return; }
  if (!event) return;
  const advisor = agentTypeOf(event);
  if (!advisor) return;
  const { stateDir } = require('./lib/state-dir.js');
  const { sessionIdFileKey } = require('./lib/session-id.js');
  const rc = require('./lib/reported-criticals.js');
  const dir = stateDir(os.homedir());
  const sessionKey = sessionIdFileKey(event.session_id);
  const agentId = typeof event.agent_id === 'string' && event.agent_id ? event.agent_id : null;
  let lines;
  try { lines = rc.readSessionStrict(dir, sessionKey); } catch (e) {
    process.stderr.write(`on-advisor-done: no pude leer el registro de críticos (${(e && (e.code || e.message)) || e}); el reporte de ${advisor} no quedó anotado y el cierre lo va a pedir\n`);
    return;
  }
  const launch = rc.launchFor(lines, advisor, agentId);
  if (!launch) return;
  const fromTranscript = reportFromTranscript(event.agent_transcript_path);
  const lastMessage = typeof event.last_assistant_message === 'string' ? event.last_assistant_message : '';
  const text = [fromTranscript.text, lastMessage].filter(Boolean).join('\n');
  rc.recordReport({
    stateDir: dir, sessionKey, advisor, agentId, iter: launch.iter, story: launch.story, run: launch.run, source: 'subagent-stop',
    text, error: text ? null : (fromTranscript.error || 'el revisor terminó sin texto'),
  });
}

if (require.main === module) {
  try { main(); } catch (e) {
    // nunca frena el fin de un subagente; lo que falló queda dicho en la salida de errores
    try { process.stderr.write(`on-advisor-done: no pude anotar el reporte (${(e && e.message) || e})\n`); } catch { /* nada */ }
  }
  process.exit(0);
}

module.exports = { agentTypeOf, reportFromTranscript };
