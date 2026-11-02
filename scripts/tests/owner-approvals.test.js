'use strict';
/**
 * owner-approvals.test.js — la aprobación explícita de la persona sin terminal: un click en el cuadro de opciones o un
 * «aprobado» suyo (scripts/lib/owner-approvals.js y el gancho scripts/hooks/owner-approval-record.js).
 * Lo que tiene que pasar y, sobre todo, lo que no: sin aprobación se niega; una vieja, de otra sesión que no es la
 * coordinadora, ya usada, mandada por otra sesión, contestada por un gancho, de otra hora, para otra firma, o anotada
 * por un gancho que no lanzó la herramienta, no vale. Sin red, en milisegundos.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const oa = require('../lib/owner-approvals.js');
const { registroDe } = require('../hooks/owner-approval-record.js');

const AHORA = Date.parse('2026-11-01T23:30:00Z');
const hace = (min) => new Date(AHORA - min * 60000).toISOString();
const SIEMPRE = () => ({ ok: true });
const FIRMA = 'save';
const PIDE = `¿Guardo los cambios del arreglo? Si sale mal, se revierte el commit. (firma ${FIRMA})`;

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-approvals-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

/** La transcripción de la sesión, donde la busca el módulo: `<casa>/.claude/projects/<carpeta>/<sesión>.jsonl`. */
function transcripcion(casa, sesion, renglones) {
  const dir = path.join(casa, '.claude', 'projects', '-r-proyecto');
  fs.mkdirSync(dir, { recursive: true });
  const ruta = path.join(dir, `${sesion}.jsonl`);
  fs.writeFileSync(ruta, renglones.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return ruta;
}

const agente = (texto, ts = hace(2)) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });
const tipeado = (texto, ts = hace(1)) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: texto }, origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli' });
const deOtraSesion = (texto, ts = hace(1)) => ({ type: 'user', timestamp: ts, isMeta: true, message: { role: 'user', content: texto }, origin: { kind: 'peer', name: 'Coordinadora' }, entrypoint: 'cli' });
const cuadro = (id, pregunta = PIDE, ts = hace(2)) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: pregunta }] } }] } });
const respuesta = (id, { pregunta = PIDE, opcion = 'Sí, aprobar', decision = { decision: 'accept', source: 'user_temporary' }, ts = hace(1) } = {}) => ({
  type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult: { questions: [{ question: pregunta }], answers: { [pregunta]: opcion } }, ...(decision ? { permissionDecision: decision } : {}) });
const mensaje = (texto = 'Aprobado', ts = hace(1), sesion = 'ses-a') => ({ tipo: 'mensaje', sesion, ts, texto });
const click = (id = 'toolu_1', ts = hace(1)) => ({ tipo: 'click', sesion: 'ses-a', ts, tool_use_id: id, pregunta: PIDE, respuesta: 'Sí, aprobar' });

// --- qué es una aprobación ------------------------------------------------------------------------------------------

test('EsAprobacion_SoloLaAfirmativaClara', () => {
  for (const t of ['Aprobado', 'aprobado.', 'apruebo', 'Apruebo desde acá', 'Apruebo desde acá sin terminal', 'Sí, aprobar', 'si, aprobado',
    'aprobá', 'Ok, aprobado', 'APROBADO', 'dale, aprobado!', 'aprobalo']) {
    assert.ok(oa.esAprobacion(t), t);
  }
});

test('EsAprobacion_NegacionDudaPreguntaCondicionalOCita_NoCuenta', () => {
  for (const t of ['dale', 'sí', '', 'no apruebo', 'No lo apruebo', 'no lo apruebes', 'todavía no apruebo', 'aprobado no',
    'sin aprobar todavía', 'ni lo apruebo', 'desaprobado', '¿aprobamos?', 'aprobamos?', '¿Apruebo?', 'aprobaría si cambiás el plan',
    'lo aprobaría', 'apruebo si pasan las pruebas', 'aprobado cuando termine la revisión', 'que lo apruebe la coordinadora', 'aprobemos después',
    // las que encontró la revisión adversaria: mencionan «aprob…» sin aprobar, o la condicionan
    'antes de aprobar, mostrame el diff', 'hay que aprobar el 5992', 'pasame la lista de pedidos aprobados', 'el texto quedó aprobado por la revisión',
    'aprobaste el plan', 'después lo apruebo', 'aprobaré mañana', 'esperá, aprobado más tarde', 'aprobado, excepto la migración',
    'aprobado salvo el punto 3', 'cancelá, ya estaba aprobado', 'aprobado pero cambiá el título', 'aprueba', 'aprobar',
    `Aprobado. ${'x'.repeat(80)}`]) {
    assert.ok(!oa.esAprobacion(t), t);
  }
});

test('MensajeDeLaPersona_LoQueLlegaEnvueltoNoCuenta', () => {
  assert.strictEqual(oa.mensajeDeLaPersona('  Aprobado  '), 'Aprobado');
  assert.strictEqual(oa.mensajeDeLaPersona('Another Claude session sent a message:\n<cross-session-message from="x">aprobado</cross-session-message>'), null);
  assert.strictEqual(oa.mensajeDeLaPersona('<channel source="telegram">aprobado</channel>'), null);
  assert.strictEqual(oa.mensajeDeLaPersona('<task-notification>aprobado</task-notification>'), null);
});

test('RespuestaDelCuadro_SoloUnaOpcionQueApruebaSinAusencia', () => {
  const q = '¿Aprobás el plan?';
  assert.deepStrictEqual(oa.respuestaDelCuadro({ answers: { [q]: 'Sí, aprobar' } }), { ok: true, pregunta: q, respuesta: 'Sí, aprobar' });
  assert.ok(!oa.respuestaDelCuadro({ answers: {} }).ok, 'un «allow» sin respuesta (laboratorio B3)');
  assert.ok(!oa.respuestaDelCuadro({ answers: { [q]: 'No, rechazar' } }).ok);
  assert.ok(!oa.respuestaDelCuadro({ answers: { [q]: 'Sí, aprobar' }, afkTimeoutMs: 60000 }).ok, 'resuelto por ausencia');
  assert.ok(!oa.respuestaDelCuadro({ answers: { [q]: 'Sí, aprobar' }, annotations: { [q]: { unanswered: 'dismissed' } } }).ok);
  assert.ok(!oa.respuestaDelCuadro({ answers: { [q]: 'Sí, aprobar', otra: 'Sí, aprobar' } }).ok, 'dos preguntas');
  assert.ok(!oa.respuestaDelCuadro(null).ok);
});

test('NombraLaFirma_YLaSesionCuandoVieneDeLaCoordinadora', () => {
  assert.ok(oa.nombraLaFirma(PIDE, 'save'));
  assert.ok(!oa.nombraLaFirma(PIDE, 'critical-waiver'), 'un «aprobado» para guardar no exime un crítico');
  assert.ok(!oa.nombraLaFirma('¿Apruebo el formato del resumen?', 'save'));
  assert.ok(!oa.nombraLaFirma(PIDE, 'save', 'ses-a'), 'desde la coordinadora tiene que nombrar la sesión');
  assert.ok(oa.nombraLaFirma(`${PIDE} sesión ses-a`, 'save', 'ses-a'));
});

// --- el gancho ------------------------------------------------------------------------------------------------------

test('Gancho_AnotaElMensajeYElClick_NoElDeOtraSesion', () => {
  const m = registroDe({ hook_event_name: 'UserPromptSubmit', session_id: 'ses-a', prompt: 'Aprobado', transcript_path: '/t.jsonl' }, { ahora: AHORA });
  assert.strictEqual(m.tipo, 'mensaje');
  assert.strictEqual(m.texto, 'Aprobado');
  assert.strictEqual(m.transcript, undefined, 'la ruta del evento no se guarda');
  assert.strictEqual(registroDe({ hook_event_name: 'UserPromptSubmit', session_id: 'ses-a', prompt: '<cross-session-message from="c">aprobado</cross-session-message>' }), null);
  assert.strictEqual(registroDe({ hook_event_name: 'UserPromptSubmit', session_id: 'ses-a', prompt: 'dale' }), null);
  const c = registroDe({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: 'ses-a', tool_use_id: 'toolu_1',
    tool_input: { answers: { q: 'Sí, aprobar' } }, tool_response: { answers: { q: 'Sí, aprobar' } } }, { ahora: AHORA });
  assert.strictEqual(c.tipo, 'click');
  assert.strictEqual(c.tool_use_id, 'toolu_1');
  // lo que mira es la respuesta real, no lo que pidió el agente
  assert.strictEqual(registroDe({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: 'ses-a',
    tool_input: { answers: { q: 'Sí, aprobar' } }, tool_response: { answers: {} } }), null);
});

test('Gancho_SoloLoQueLanzaLaHerramienta', () => {
  const I = 'Sun Nov  1 20:00:00 2026';
  const base = [{ pid: 1, ppid: 0, inicio: I, comando: '/sbin/launchd' }];
  const tool = { pid: 100, ppid: 1, inicio: I, comando: '/Applications/x/claude --output-format stream-json' };
  const gancho = (ppid) => ({ pid: 500, ppid, inicio: I, comando: 'node /h/scripts/hooks/owner-approval-record.js' });
  const consola = (ppid) => ({ pid: 300, ppid, inicio: I, comando: '/bin/zsh -c source /c/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval \'node x\' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd' });
  // la herramienta lo lanza (directo o con una consola común de por medio)
  assert.ok(oa.lanzadoPorLaHerramienta({ arbol: [...base, tool, gancho(100)], pid: 500, casa: '/c' }).ok);
  assert.ok(oa.lanzadoPorLaHerramienta({ arbol: [...base, tool, { pid: 400, ppid: 100, inicio: I, comando: '/bin/sh -c node hook' }, gancho(400)], pid: 500, casa: '/c' }).ok);
  // un agente lo corre a mano desde su consola
  const aMano = oa.lanzadoPorLaHerramienta({ arbol: [...base, tool, consola(100), gancho(300)], pid: 500, casa: '/c' });
  assert.ok(!aMano.ok);
  assert.match(aMano.motivo, /consola de un agente/);
  // otra sesión abierta por el agente en una pseudo-terminal: la herramienta nueva tiene la consola del agente arriba
  const pty = { pid: 350, ppid: 300, inicio: I, comando: 'script -q /dev/null claude --resume ses-a' };
  const anidada = { pid: 360, ppid: 350, inicio: I, comando: '/Applications/x/claude --resume ses-a' };
  assert.ok(!oa.lanzadoPorLaHerramienta({ arbol: [...base, tool, consola(100), pty, anidada, gancho(360)], pid: 500, casa: '/c' }).ok);
  // la sesión de fondo: su herramienta es `claude bg-spare`, debajo de su terminal virtual y del daemon
  const fondo = [...base, { pid: 50, ppid: 1, inicio: I, comando: '/u/claude.exe daemon run' },
    { pid: 60, ppid: 50, inicio: I, ejecutable: 'claude bg-pty-host', comando: 'claude bg-pty-host --bg-pty-host /tmp/x 200 50' },
    { pid: 100, ppid: 60, inicio: I, ejecutable: 'claude bg-spare', comando: 'claude bg-spare --bg-spare /tmp/y' }, gancho(100)];
  const f = oa.lanzadoPorLaHerramienta({ arbol: fondo, pid: 500, casa: '/c' });
  assert.ok(f.ok, f.motivo);
  assert.strictEqual(f.herramienta.pid, 100);
  assert.ok(!oa.lanzadoPorLaHerramienta({ arbol: null, pid: 500 }).ok, 'sin árbol no anota');
});

// --- buscar y consumir ----------------------------------------------------------------------------------------------

test('Buscar_SinClickNiMensaje_SeNiega', (t) => {
  const casa = casaNueva(t);
  const r = oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, ahora: AHORA, validar: SIEMPRE });
  assert.ok(!r.ok);
  assert.match(r.motivo, /no hay un click en el cuadro ni un «aprobado»/);
});

test('Buscar_MensajeViejo_SeNiega', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, mensaje('Aprobado', hace(31)));
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, ahora: AHORA, validar: SIEMPRE }).ok);
  oa.anotar(casa, mensaje('Aprobado', hace(29)));
  assert.ok(oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, ahora: AHORA, validar: SIEMPRE }).ok);
});

test('Buscar_DeOtraSesionQueNoEsLaCoordinadora_SeNiega_DeLaCoordinadoraVale', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, mensaje('Aprobado', hace(1), 'ses-b'));
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, ahora: AHORA, validar: SIEMPRE }).ok, 'sin coordinadora');
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, coordinadora: 'ses-c', ahora: AHORA, validar: SIEMPRE }).ok, 'ses-b no es la coordinadora');
  let pide = null;
  const r = oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, coordinadora: 'ses-b', ahora: AHORA, validar: (a, ctx) => { pide = ctx; return { ok: true }; } });
  assert.ok(r.ok);
  assert.strictEqual(r.via, 'mensaje');
  assert.strictEqual(pide.sesion, 'ses-a', 'desde la coordinadora, la aprobación tiene que nombrar la sesión que firma');
  assert.strictEqual(pide.firma, FIRMA);
});

test('Consumir_UnaAprobacionSirveParaUnaSolaFirma', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, click());
  const r = oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, ahora: AHORA, validar: SIEMPRE });
  assert.ok(r.ok);
  assert.ok(oa.consumir(casa, r.aprobacion, { ahora: AHORA, firma: FIRMA, sesion: 'ses-a' }).ok);
  assert.ok(!oa.consumir(casa, r.aprobacion, { ahora: AHORA }).ok, 'la segunda vez no');
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', firma: FIRMA, ahora: AHORA, validar: SIEMPRE }).ok, 'ya no queda ninguna');
});

// --- la transcripción -----------------------------------------------------------------------------------------------

test('Transcripcion_MensajeTipeadoALaHoraYTrasLaPregunta_Vale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [agente(PIDE), tipeado('Aprobado')]);
  assert.ok(oa.validarEnClaude(mensaje(), { casa, firma: FIRMA }).ok);
});

test('Transcripcion_MensajeQueNoEsDeLaPersonaDeOtraHoraOParaOtraFirma_NoVale', (t) => {
  const casa = casaNueva(t);
  // otra sesión lo mandó
  transcripcion(casa, 'ses-a', [agente(PIDE), deOtraSesion('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), { casa, firma: FIRMA }).motivo, /no lo escribió una persona/);
  // un programa (`claude -p`, un SDK)
  transcripcion(casa, 'ses-a', [agente(PIDE), { ...tipeado('Aprobado'), entrypoint: 'sdk-cli' }]);
  assert.ok(!oa.validarEnClaude(mensaje(), { casa, firma: FIRMA }).ok);
  // la persona lo escribió ayer: un registro de hoy no se apoya en ese renglón
  transcripcion(casa, 'ses-a', [agente(PIDE, hace(60 * 24 + 1)), tipeado('Aprobado', hace(60 * 24))]);
  assert.match(oa.validarEnClaude(mensaje(), { casa, firma: FIRMA }).motivo, /a esa hora/);
  // lo último que dijo el agente era otra cosa
  transcripcion(casa, 'ses-a', [agente('¿Apruebo el formato del resumen?'), tipeado('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), { casa, firma: FIRMA }).motivo, /no nombra «firma save»/);
  // la ruta sale de la sesión, no del registro: una transcripción armada en otro lado no se lee
  const falsa = path.join(casa, 'falsa.jsonl');
  fs.writeFileSync(falsa, [agente(PIDE), tipeado('Aprobado')].map((r) => JSON.stringify(r)).join('\n'));
  assert.match(oa.validarEnClaude({ ...mensaje('Aprobado', hace(1), 'ses-x'), transcript: falsa }, { casa, firma: FIRMA }).motivo, /no encontré la transcripción/);
});

test('Transcripcion_ClickDeLaPersona_Vale_DeUnGanchoOtraRespuestaOtraHoraNo', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1')]);
  assert.ok(oa.validarEnClaude(click(), { casa, firma: FIRMA }).ok);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { decision: { decision: 'accept', source: 'hook', reasonType: 'hook' } })]);
  assert.match(oa.validarEnClaude(click(), { casa, firma: FIRMA }).motivo, /un gancho/);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { opcion: 'No' })]);
  assert.ok(!oa.validarEnClaude(click(), { casa, firma: FIRMA }).ok, 'un cuadro contestado «No»');
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { ts: hace(60) })]);
  assert.match(oa.validarEnClaude(click(), { casa, firma: FIRMA }).motivo, /hora del registro/);
  transcripcion(casa, 'ses-a', [respuesta('toolu_1')]);
  assert.ok(!oa.validarEnClaude(click(), { casa, firma: FIRMA }).ok, 'un registro de un cuadro que no existió');
  const otra = '¿Apruebo el formato del resumen?';
  transcripcion(casa, 'ses-a', [cuadro('toolu_1', otra), respuesta('toolu_1', { pregunta: otra })]);
  assert.ok(!oa.validarEnClaude({ ...click(), pregunta: otra }, { casa, firma: FIRMA }).ok, 'un click a otra pregunta no firma');
});

// --- los ganchos que escuchan el cuadro ------------------------------------------------------------------------------

test('Escuchas_GanchoAjenoSobreElCuadro_ElClickNoVale', (t) => {
  const casa = casaNueva(t);
  const cwd = path.join(casa, 'proyecto');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  const delArnes = `node ${path.join(__dirname, '..', 'hooks', 'wait-notice.js')}`;
  fs.writeFileSync(path.join(casa, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: delArnes }] }],
  } }));
  assert.deepStrictEqual(oa.escuchasDelCuadro({ casa, cwd, plataforma: 'linux' }).ajenos, [], 'el aviso de espera del arnés pasa');
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ hooks: {
    PermissionRequest: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 contesta-el-cuadro.py' }] }],
  } }));
  const e = oa.escuchasDelCuadro({ casa, cwd, plataforma: 'linux' });
  assert.strictEqual(e.ajenos.length, 1);
  assert.strictEqual(e.ajenos[0].evento, 'PermissionRequest');
  // el mismo nombre en otra ruta, o el del arnés con algo más en la línea, no es el del arnés
  assert.ok(!oa.esPermitido('node /tmp/otro/wait-notice.js'));
  assert.ok(!oa.esPermitido(`${delArnes}; node /tmp/x.js`));
  assert.ok(!oa.esPermitido('@tcg:wait-notice.js && node /tmp/x.js'));
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1')]);
  const v = oa.validarEnClaude(click(), { casa, cwd, firma: FIRMA });
  assert.ok(!v.ok);
  assert.match(v.motivo, /un gancho que no es del arnés escucha el cuadro/);
});

test('Escuchas_PluginYCapaIlegible', (t) => {
  const casa = casaNueva(t);
  const hooksDir = path.join(casa, '.claude', 'plugins', 'cache', 'x', 'p', '1.0', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } }));
  assert.strictEqual(oa.escuchasDelCuadro({ casa, plataforma: 'linux' }).ajenos.length, 1);
  fs.writeFileSync(path.join(casa, '.claude', 'settings.json'), '{ esto no es json');
  assert.deepStrictEqual(oa.escuchasDelCuadro({ casa, plataforma: 'linux' }).ilegibles, [path.join(casa, '.claude', 'settings.json')]);
});

test('AlcanzaAlCuadro_VacioAsteriscoYExpresion', () => {
  for (const m of ['', '*', null, 'AskUserQuestion', 'Ask.*', 'AskUserQuestion|Bash']) assert.ok(oa.alcanzaAlCuadro(m), String(m));
  for (const m of ['Bash', 'Edit|Write', 'mcp__.*']) assert.ok(!oa.alcanzaAlCuadro(m), m);
});
