#!/usr/bin/env node
'use strict';
// on-work.js — escucha el evento de trabajo del núcleo (scripts/lib/work-signal.js) para Clockify.
//
// Clockify se maneja con su MCP, que es del agente: este guion no llama a ninguna API. Le devuelve al agente la acción
// que tiene que hacer, en `{"action": "…"}`, y lo que sabe del estado de siempre (el de lib.js, una entrada por sesión):
//   · start: abrir la entrada con el MCP, o avisar que ya hay una abierta en esa carpeta;
//   · stop (el cierre de la historia, paso 9 del pipeline): cerrar la entrada abierta de la sesión (con su id) con el MCP,
//     si hay una, y sumar las entradas de la historia para CompletedWork: los segundos los informa el MCP, no este guion;
//   · entry: el id de la entrada abierta de la sesión en esa carpeta, si hay una (el núcleo lo cruza con la conversación);
//   · activity y sweep: nada (los hacen los hooks de la integración: touch-activity.js y sweep.js).
// Sale 0 siempre: la historia sigue aunque el estado no se pueda leer.
// Casos: scripts/tests/time-tracking-config.test.js.

const lib = require('./lib.js');

function handle(ev) {
  if (!ev || typeof ev !== 'object') return {};
  const description = `Story ${ev.storyId || '?'}${ev.title ? ` — ${ev.title}` : ''}`.slice(0, 100);
  let found = null;
  try { found = ev.repo && ev.sessionId ? lib.findActiveEntryForCwd(lib.readActive(), lib.normalizeCwd(ev.repo), ev.sessionId) : null; } catch (_) { found = null; }
  if (ev.event === 'entry') return found ? { entryId: found.entry.entryId } : {};
  if (ev.event === 'start') {
    if (found) return { action: `ya hay una entrada abierta de esta sesión en Clockify (${found.entry.entryId}, «${found.entry.description || ''}»): si es de otra historia, cerrala con mcp__clockify__update-clockify-time-entry antes de abrir la de «${description}»` };
    return { action: `abrí la entrada de Clockify con mcp__clockify__create-clockify-time-entry, descripción «${description}», el proyecto que se llama como la carpeta del repo y la hora local; guardala en ${lib.sessionFilePath(ev.sessionId || '<sesión>')} (la skill clocki, «Flujo de start»)` };
  }
  if (ev.event === 'stop') {
    const sum = `sumá las entradas de Clockify de la historia ${ev.storyId || '?'} con mcp__clockify__list-clockify-time-entries (la skill clocki, «Cierre desde el pipeline»): ése es el tiempo para CompletedWork`;
    if (!found) return { action: `${sum}; no hay entrada abierta de esta sesión que cerrar` };
    return { action: `cerrá la entrada de Clockify ${found.entry.entryId} con mcp__clockify__update-clockify-time-entry con el fin ahora (hora local), sacala de ${lib.sessionFilePath(ev.sessionId)}, y ${sum}`, entryId: found.entry.entryId };
  }
  return {};
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let ev = null;
  try { ev = JSON.parse(raw); } catch (_) { ev = null; }
  let out = {};
  try { out = handle(ev); } catch (e) { process.stderr.write(`clockify: no pude leer el estado del reloj (${(e && e.code) || 'error'}); sigo sin registrar\n`); }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
});
