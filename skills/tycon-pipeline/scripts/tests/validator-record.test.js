#!/usr/bin/env node
/**
 * validator-record.test.js — la constancia del validador de historias (lib/validator-record.js): una llamada a
 * `tycon-story-validator` que nombra la historia, con su respuesta, posterior a la última escritura del archivo, leída de
 * la cadena de la conversación de la sesión.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/validator-record.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vrec-home-'));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const vr = require(path.join(__dirname, '..', 'lib', 'validator-record.js'));

const REPO = '/repo';
const RUTA = '/repo/specs/story-4.2-cbu-de-los-gestores.md';
// la constancia no mira la hora (sólo el orden en la cadena): una fija alcanza
const hace = (min) => `2026-01-01T00:${String(59 - min).padStart(2, '0')}:00.000Z`;

/**
 * Escribe la conversación de `sid` encadenada (cada registro es padre del siguiente) y la cierra con el pedido que se
 * juzga (`toolu_pedido`). `sueltos` van antes del pedido, con un padre que no existe: los agregó alguien por fuera.
 */
function conversacion(sid, registros, sueltos = []) {
  const dir = path.join(HOME, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  let padre = null;
  registros.forEach((r, i) => { const u = `${sid}-${i}`; out.push({ ...r, uuid: u, parentUuid: padre }); padre = u; });
  sueltos.forEach((r, i) => out.push({ ...r, uuid: `${sid}-suelto-${i}`, parentUuid: `no-existe-${i}` }));
  out.push({ ...uso('toolu_pedido', 'Edit', { file_path: RUTA }, 0), uuid: `${sid}-pedido`, parentUuid: padre });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const uso = (id, name, input, min = 1) => ({ type: 'assistant', timestamp: hace(min), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultado = (id, texto, { error = false, min = 1 } = {}) => ({ type: 'user', timestamp: hace(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: texto }], ...(error ? { is_error: true } : {}) }] } });
const escritura = (id, ruta = RUTA) => [uso(id, 'Write', { file_path: ruta, content: '---\nstory: "4.2"\nstatus: draft\n---\n' }), resultado(id, 'File created successfully')];
const validador = (id, prompt, tipo = 'tycon-story-validator') => uso(id, 'Agent', { subagent_type: tipo, description: 'Validar', prompt });
const fin = (id) => ({ type: 'attachment', timestamp: hace(0), attachment: { type: 'queued_command', origin: 'task-notification', prompt: `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<result>limpio</result>\n</task-notification>` } });
const consulta = (sid, ruta = RUTA) => vr.constancia({ sesion: sid, ruta, repoRoot: REPO, home: HOME, pedido: 'toolu_pedido' });

test('T1 ValidatorRecord_LlamadaConRespuesta_Cuenta: el validador nombra la historia después de escribirla, con su respuesta', () => {
  conversacion('t1', [...escritura('w1'), validador('v1', `Validar la story en ${RUTA} contra el repo ${REPO}.`), resultado('v1', 'Veredicto: limpio')]);
  assert.deepEqual([consulta('t1').legible, consulta('t1').hay], [true, true]);
  // lanzado de fondo: el acuse no alcanza; cuenta el aviso de fin con su número de llamada
  conversacion('t1b', [...escritura('w1'), validador('v2', `Validar ${RUTA}`), resultado('v2', 'Async agent launched successfully. agentId: x')]);
  assert.equal(consulta('t1b').hay, false);
  conversacion('t1c', [...escritura('w1'), validador('v3', `Validar ${RUTA}`), resultado('v3', 'Async agent launched successfully. agentId: x'), fin('v3')]);
  assert.equal(consulta('t1c').hay, true);
  // lanzado en el mismo mensaje que otra herramienta: las llamadas se encadenan entre sí y la respuesta del validador
  // cuelga de su propia llamada, fuera de la cadena (la forma real que guarda Claude Code)
  const dir = path.join(HOME, '.claude', 'projects', '-repo');
  const regs = [...escritura('w1')].map((r, i) => ({ ...r, uuid: `p-${i}`, parentUuid: i ? `p-${i - 1}` : null }));
  regs.push({ ...validador('v4', `Validar ${RUTA}`), uuid: 'p-val', parentUuid: 'p-1' });
  regs.push({ ...uso('otra', 'Bash', { command: 'ls' }), uuid: 'p-otra', parentUuid: 'p-val' });
  regs.push({ ...resultado('v4', 'Veredicto: limpio'), uuid: 'p-val-r', parentUuid: 'p-val' });
  regs.push({ ...resultado('otra', 'specs'), uuid: 'p-otra-r', parentUuid: 'p-otra' });
  regs.push({ ...uso('toolu_pedido', 'Edit', { file_path: RUTA }, 0), uuid: 'p-pedido', parentUuid: 'p-otra-r' });
  fs.writeFileSync(path.join(dir, 't1d.jsonl'), regs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(consulta('t1d').hay, true, 'la respuesta en la rama lateral de una llamada en paralelo cuenta');
});

test('T2 ValidatorRecord_OtroRevisorOSinRespuesta_NoCuenta: otro revisor, el validador sin respuesta o con error', () => {
  conversacion('t2a', [...escritura('w1'), validador('v1', `Revisá ${RUTA}`, 'tycon-story-adversarial-reviewer'), resultado('v1', 'Veredicto: limpio')]);
  assert.equal(consulta('t2a').hay, false);
  conversacion('t2b', [...escritura('w1'), validador('v1', `Validar ${RUTA}`)]);
  assert.equal(consulta('t2b').hay, false);
  conversacion('t2c', [...escritura('w1'), validador('v1', `Validar ${RUTA}`), resultado('v1', 'Agent type not found', { error: true })]);
  assert.equal(consulta('t2c').hay, false);
  // el aviso de fin de OTRA llamada no es la respuesta de ésta
  conversacion('t2d', [...escritura('w1'), validador('v1', `Validar ${RUTA}`), resultado('v1', 'Async agent launched successfully.'), fin('otra')]);
  assert.equal(consulta('t2d').hay, false);
});

test('T3 ValidatorRecord_AnteriorALaUltimaEscritura_NoCuenta: validar y después volver a escribir deja vieja la constancia', () => {
  conversacion('t3', [...escritura('w1'), validador('v1', `Validar ${RUTA}`), resultado('v1', 'limpio'), uso('w2', 'Edit', { file_path: RUTA, old_string: 'a', new_string: 'b' }), resultado('w2', 'updated')]);
  assert.equal(consulta('t3').hay, false);
  // una escritura que falló no cuenta como escritura
  conversacion('t3b', [...escritura('w1'), validador('v1', `Validar ${RUTA}`), resultado('v1', 'limpio'), uso('w2', 'Edit', { file_path: RUTA, old_string: 'x', new_string: 'y' }), resultado('w2', 'String not found', { error: true })]);
  assert.equal(consulta('t3b').hay, true);
  // la escritura de OTRO archivo tampoco
  conversacion('t3c', [...escritura('w1'), validador('v1', `Validar ${RUTA}`), resultado('v1', 'limpio'), ...escritura('w3', '/repo/specs/otra.md')]);
  assert.equal(consulta('t3c').hay, true);
  // reescribirla por la terminal después del validador también deja vieja la constancia
  const heredoc = { ...uso('b1', 'Bash', { command: `cat > specs/story-4.2-cbu-de-los-gestores.md <<'EOF'\n---\nstory: "4.2"\nstatus: draft\n---\nEOF` }), cwd: REPO };
  conversacion('t3d', [...escritura('w1'), validador('v1', `Validar ${RUTA}`), resultado('v1', 'limpio'), heredoc, resultado('b1', '')]);
  assert.equal(consulta('t3d').hay, false, 'heredoc posterior al validador');
  // y el guion del camino sin BMAD, que escribe el archivo y devuelve su ruta
  const guion = { ...uso('b2', 'Bash', { command: 'node story-without-bmad.js write --repo . --answers a.json' }), cwd: REPO };
  conversacion('t3e', [validador('v1', `Validar ${RUTA}`), resultado('v1', 'limpio'), guion, resultado('b2', JSON.stringify({ path: RUTA, story: '4.2' }))]);
  assert.equal(consulta('t3e').hay, false, 'el guion escribió después del validador');
});

test('T4 ValidatorRecord_FueraDeLaCadena_NoCuenta: la llamada y su respuesta agregadas al archivo por fuera no cuentan', () => {
  conversacion('t4', [...escritura('w1')], [validador('v1', `Validar ${RUTA}`), resultado('v1', 'limpio')]);
  assert.equal(consulta('t4').hay, false);
  // sin conversación legible, no hay constancia
  const r = consulta('t4-no-existe');
  assert.equal(r.legible, false);
  assert.equal(r.hay, false);
});

test('T5 ValidatorRecord_RutaComoLaNombraElAgente: absoluta, relativa al repo, con ~ o sólo el nombre', () => {
  for (const [sid, nombre] of [['t5a', RUTA], ['t5b', 'specs/story-4.2-cbu-de-los-gestores.md'], ['t5c', 'story-4.2-cbu-de-los-gestores.md']]) {
    conversacion(sid, [...escritura('w1'), validador('v1', `Validar la story en \`${nombre}\`.`), resultado('v1', 'limpio')]);
    assert.equal(consulta(sid).hay, true, nombre);
  }
  const enHome = path.join(HOME, 'repo', 'specs', 'story-4.2-x.md');
  conversacion('t5d', [...escritura('w1', enHome), validador('v1', 'Validar ~/repo/specs/story-4.2-x.md'), resultado('v1', 'limpio')]);
  assert.equal(vr.constancia({ sesion: 't5d', ruta: enHome, repoRoot: path.join(HOME, 'repo'), home: HOME, pedido: 'toolu_pedido' }).hay, true);
  // otro archivo con un nombre que contiene al de la historia no es la historia
  conversacion('t5e', [...escritura('w1'), validador('v1', 'Validar specs/story-4.2-cbu-de-los-gestores.md.bak'), resultado('v1', 'limpio')]);
  assert.equal(consulta('t5e').hay, false);
});
