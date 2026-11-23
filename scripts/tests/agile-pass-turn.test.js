'use strict';
/**
 * agile-pass-turn.test.js — un pase lanzado sin el pipeline pasa por el turno de tarea pesada (fila 126, parte a).
 *
 *   APT1  qué cuenta como pase: todo Workflow; un Agent sólo si dice «adversarial».
 *   APT2  sin turno avisa, y dice quién lo tiene; con el «arrancá» o la reserva para la sesión, no.
 *   APT3  no mira sin coordinadora, en la coordinadora, ni en una sesión con corrida del pipeline.
 *   APT4  en modo freno, la decisión es frenar con el mismo motivo.
 *   APT5  el gancho entero: sin coordinadora calla y no anota; apagado, también; lo que no es pase, también.
 *   APT6  el evento: apagado calla aun con coordinadora; el aviso viaja como contexto, nunca como freno; un error queda
 *         como no medido.
 *   APT7  con la reserva para la sesión, si su portón ya corre con ella, avisa: es para una cosa por vez.
 * 🔴 Nada toca el HOME real: el gancho corre en un proceso hijo con su HOME de juguete.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'agile-pass-turn.js');
const G = require(HOOK);

// la máquina de juguete: una coordinadora viva, nadie con turno
const maquina = (cambios = {}) => ({
  coordinadora: () => 'coord-1',
  tieneCorrida: () => false,
  arranca: () => null,
  reserva: () => null,
  corriendo: () => [],
  propias: () => [],
  pases: () => [],
  ...cambios,
});
const pase = { toolName: 'Agent', toolInput: { description: 'Pase adversarial fila 9', prompt: 'Sos revisor…' }, sid: 'ses-a' };

// 🔴 mutación: contar todo Agent (los revisores chicos y las búsquedas quedarían avisados), no contar el Workflow, o
// contar un pedido que sólo nombra el pase.
test('APT1 QueCuentaComoPase_WorkflowSiempre_AgentSiDiceAdversarial', () => {
  assert.strictEqual(G.esPase('Workflow', {}), true, 'todo Workflow');
  assert.strictEqual(G.esPase('Workflow', { name: 'revisar' }), true);
  assert.strictEqual(G.esPase('Agent', { description: 'Pase adversarial fila 9' }), true);
  assert.strictEqual(G.esPase('Task', { description: 'Revisión ADVERSARIAL', prompt: 'revisá' }), true, 'sin importar mayúsculas');
  assert.strictEqual(G.esPase('Agent', { description: 'revisar la historia', subagent_type: 'tycon-story-adversarial-reviewer' }), true, 'por el tipo de agente');
  assert.strictEqual(G.esPase('Agent', { description: 'Buscar X', prompt: 'Buscá X; no hagas una revisión adversarial.' }), false, 'el pedido no se mira');
  assert.strictEqual(G.esPase('Agent', { description: 'Buscar dónde se define X', prompt: 'buscá' }), false);
  assert.strictEqual(G.esPase('Agent', {}), false);
  assert.strictEqual(G.esPase('Bash', { command: 'echo adversarial' }), false, 'otra herramienta no');
});

// 🔴 mutación: aceptar la reserva de la coordinadora (su propia sesión) como turno de cualquiera, o callar quién lo tiene.
test('APT2 SinTurno_Avisa_ConArrancaOReservaParaLaSesion_No', () => {
  const sin = G.decidir(pase, maquina({ corriendo: () => ['Bea (120 suites, desde las 09:10)'], pases: () => ['el pase de la 8.3 (Ana)'] }));
  assert.strictEqual(sin.status, 'aviso');
  assert.match(sin.message, /Lanzás un pase adversarial sin el turno de tarea pesada de esta máquina\. Lo tiene: Bea \(120 suites, desde las 09:10\) · el pase de la 8\.3 \(Ana\)\./, sin.message);
  assert.match(sin.message, /grant --to <sesión>, o reserve --for "<qué>" --to <sesión>/);
  assert.match(sin.message, /Hoy sólo se avisa\./);
  const wf = G.decidir({ ...pase, toolName: 'Workflow', toolInput: {} }, maquina());
  assert.match(wf.message, /Lanzás un Workflow \(un abanico de agentes\) sin el turno.*Nadie lo tiene, pero la coordinadora no te lo dio\./);
  // la reserva de la coordinadora para otra cosa (sin --to, o para otra sesión) no es turno de ésta, y se nombra
  const otra = G.decidir(pase, maquina({ reserva: () => ({ sid: 'coord-1', what: 'el pase de la fila 122', to: 'ses-b', toSession: 'Mejoras' }) }));
  assert.strictEqual(otra.status, 'aviso');
  assert.match(otra.message, /Lo tiene: la reserva de la coordinadora para «el pase de la fila 122» de Mejoras\./);
  assert.strictEqual(G.decidir(pase, maquina({ reserva: () => ({ sid: 'coord-1', what: 'x' }) })).status, 'aviso', 'una reserva sin --to no es de nadie');
  // con turno: el «arrancá» o la reserva para esta sesión
  assert.strictEqual(G.decidir(pase, maquina({ arranca: () => ({ to: 'ses-a' }) })).status, 'con-turno');
  assert.strictEqual(G.decidir(pase, maquina({ reserva: () => ({ sid: 'coord-1', what: 'su pase', to: 'ses-a' }) })).status, 'con-turno');
  assert.strictEqual(G.decidir(pase, maquina({ arranca: () => ({ to: 'ses-b' }) })).status, 'aviso', 'el «arrancá» de otra no');
});

// 🔴 mutación: mirar sin coordinadora (no hay a quién pedir), a la coordinadora misma, o a una sesión del pipeline.
test('APT3 NoMira_SinCoordinadora_LaCoordinadora_NiConCorrida', () => {
  assert.strictEqual(G.decidir(pase, maquina({ coordinadora: () => null })).status, 'fuera');
  assert.strictEqual(G.decidir({ ...pase, sid: 'coord-1' }, maquina()).status, 'fuera');
  assert.strictEqual(G.decidir(pase, maquina({ tieneCorrida: (s) => s === 'ses-a' })).status, 'fuera');
  assert.strictEqual(G.decidir({ ...pase, sid: null }, maquina()).status, 'fuera');
  assert.strictEqual(G.decidir({ ...pase, toolInput: { description: 'buscar' } }, maquina()).status, 'fuera', 'lo que no es pase no se mira');
});

// 🔴 mutación: dar turno con la reserva aunque el portón de la sesión ya corra con ella (pase y suites a la vez), o
// mirar las ejecuciones de otras sesiones (esas no usan la reserva de ésta).
test('APT7 ConReserva_SiSuPortonYaCorre_Avisa (fila 130)', () => {
  const reserva = () => ({ sid: 'coord-1', what: 'su pase', to: 'ses-a' });
  const ocupada = G.decidir(pase, maquina({ reserva, propias: (s) => (s === 'ses-a' ? ['Uma (40 suites, desde las 10:05)'] : []) }));
  assert.strictEqual(ocupada.status, 'aviso');
  assert.match(ocupada.message, /con la reserva de la coordinadora, pero con esa reserva ya corre Uma \(40 suites, desde las 10:05\), de esta sesión: es para una cosa por vez\. Lanzalo cuando termine\. Hoy sólo se avisa\./);
  assert.strictEqual(G.decidir({ ...pase, modo: 'block' }, maquina({ reserva, propias: () => ['x'] })).status, 'freno');
  // lo de otra sesión no cuenta
  assert.strictEqual(G.decidir(pase, maquina({ reserva, corriendo: () => ['Bea (120 suites)'], propias: (s) => (s === 'ses-b' ? ['Bea'] : []) })).status, 'con-turno');
  // el lector de la máquina: de los dos lugares del turno, sólo el de esa sesión
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apt7-casa-'));
  try {
    const coord = path.join(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home), 'coordination');
    fs.mkdirSync(coord, { recursive: true });
    // stable-data: un lugar del turno vence por edad contra la hora de ahora; la prueba sólo mira de qué sesión es
    const ahora = Date.now();
    fs.writeFileSync(path.join(coord, 'suite-turn.json'), JSON.stringify({ pid: process.pid, sid: 'ses-b', session: 'Bea', what: '120 suites', at: ahora - 1000 }));
    fs.writeFileSync(path.join(coord, 'suite-turn-2.json'), JSON.stringify({ pid: process.pid, sid: 'ses-a', session: 'Uma', what: '40 suites', at: ahora }));
    const L = G.lectores(home, ahora);
    assert.strictEqual(L.corriendo().length, 2);
    const propias = L.propias('ses-a');
    assert.strictEqual(propias.length, 1);
    assert.match(propias[0], /Uma/);
    assert.doesNotMatch(propias[0], /Bea/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// 🔴 mutación: en modo freno, dejar pasar o frenar con otro motivo.
test('APT4 ModoFreno_FrenaConElMismoMotivo', () => {
  assert.strictEqual(G.MODO, 'warn', 'entra en modo aviso: el freno lo decide el dueño con la medición');
  const r = G.decidir({ ...pase, modo: 'block' }, maquina());
  assert.strictEqual(r.status, 'freno');
  assert.match(r.message, /sin el turno de tarea pesada/);
  assert.doesNotMatch(r.message, /Hoy sólo se avisa/);
});

// 🔴 mutación: ignorar el apagado, frenar en vez de avisar, leer la máquina para lo que no es un pase, o perder un error
// en vez de anotarlo como no medido.
test('APT6 ElEvento_ApagadoCalla_AvisoComoContexto_ErrorNoMedido', () => {
  const ev = { tool_name: 'Workflow', tool_input: {}, session_id: 'ses-a' };
  const leer = () => maquina();
  assert.strictEqual(G.responder(ev, { TYCON_AGILE_PASS_TURN: '0' }, leer), null, 'apagado no dice nada, aun con coordinadora');
  const r = G.responder(ev, {}, leer);
  assert.deepStrictEqual(r.fila, { sessionId: 'ses-a', tool: 'Workflow', status: 'aviso' });
  assert.strictEqual(r.salida.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(r.salida.hookSpecificOutput.additionalContext, /sin el turno de tarea pesada/);
  assert.match(r.salida.systemMessage, /^⚠️ Lanzás un Workflow/);
  assert.ok(!('permissionDecision' in r.salida.hookSpecificOutput), 'avisa, no frena');
  // lo que no es pase no lee la máquina
  assert.strictEqual(G.responder({ ...ev, tool_name: 'Agent', tool_input: { description: 'buscar' } }, {}, () => { throw new Error('no se lee'); }), null);
  // con turno se anota y no se imprime
  assert.deepStrictEqual(G.responder(ev, {}, () => maquina({ arranca: () => ({ to: 'ses-a' }) })), { fila: { sessionId: 'ses-a', tool: 'Workflow', status: 'con-turno' }, salida: null });
  // un error al leer la máquina no frena: queda no medido
  const roto = G.responder(ev, {}, () => maquina({ coordinadora: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }));
  assert.deepStrictEqual([roto.fila.status, roto.fila.why, roto.salida], ['no-medido', 'EACCES', null]);
  // la sesión sale del evento, o de la variable de Claude Code
  assert.strictEqual(G.responder({ tool_name: 'Workflow', tool_input: {} }, { CLAUDE_CODE_SESSION_ID: 'ses-z' }, leer).fila.sessionId, 'ses-z');
});

// 🔴 mutación: anotar o avisar sin coordinadora, o ignorar el apagado.
test('APT5 ElGanchoEntero_SinCoordinadoraNiApagado_CallaYNoAnota', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-home-'));
  const correr = (ev, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(ev), encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), ...env } });
  const ev = { tool_name: 'Workflow', tool_input: {}, session_id: 'ses-a' };
  for (const r of [correr(ev), correr(ev, { TYCON_AGILE_PASS_TURN: '0' }), correr({ ...ev, tool_name: 'Agent', tool_input: { description: 'buscar' } })]) {
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'calla');
  }
  // ningún gates.log de la casa nombra al gancho, esté donde esté la carpeta del estado
  const logs = fs.readdirSync(home, { recursive: true }).map(String).filter((f) => path.basename(f) === 'gates.log');
  for (const f of logs) assert.ok(!fs.readFileSync(path.join(home, f), 'utf8').includes('agile-pass-turn'), `no anota en ${f}`);
  fs.rmSync(home, { recursive: true, force: true });
});
