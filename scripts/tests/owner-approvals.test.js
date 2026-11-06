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
const armar = (firma = FIRMA, destino = 'ses-a', huella = 'ab12cd34') => oa.cuadroDe({ firma, destino, que: 'guardar los cambios', queHace: ['el comando: marker.js approve-save'], siSaleMal: 'se revierte el commit', huella });
const CUADRO = armar();
const PIDE = CUADRO.pregunta;
const CTX = (casa, o = {}) => ({ casa, cuadro: CUADRO, destino: 'ses-a', ...o });

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
const respuesta = (id, { pregunta = PIDE, opcion = 'Sí, aprobar', opciones = ['Sí, aprobar', 'No'], decision = { decision: 'accept', source: 'user_temporary' }, ts = hace(1) } = {}) => ({
  type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult: { questions: [{ question: pregunta, options: opciones.map((label) => ({ label })) }], answers: { [pregunta]: opcion } }, ...(decision ? { permissionDecision: decision } : {}) });
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

test('CuadroDe_LoArmaElGuion_ConQueSeApruebaQuePasaYElSello', () => {
  const c = armar('plan-approval', 'ses-b', 'ffff0000');
  assert.strictEqual(c.sello, 'firma plan-approval · sesión ses-b · código ffff0000');
  assert.ok(c.pregunta.includes(c.sello));
  assert.match(c.pregunta, /Si sale mal: se revierte el commit/);
  assert.deepStrictEqual(c.opciones, ['Sí, aprobar', 'No']);
  assert.ok(oa.respuestaDelCuadro({ answers: { [c.pregunta]: c.opciones[0] } }).ok, 'la opción que arma aprueba');
  assert.ok(!oa.respuestaDelCuadro({ answers: { [c.pregunta]: c.opciones[1] } }).ok, 'la otra no');
});

test('TraeElSello_EnteroYSinNombrarOtraSesion', () => {
  const o = { sello: CUADRO.sello, destino: 'ses-a' };
  assert.ok(oa.traeElSello(`Te pido esto: ${CUADRO.sello}. ¿Lo aprobás?`, o));
  assert.ok(!oa.traeElSello('¿Apruebo el formato del resumen?', o));
  assert.ok(!oa.traeElSello('firma save, sesión ses-a', o), 'sin el código del comando no es el sello');
  assert.ok(!oa.traeElSello(armar('save', 'ses-a', 'distinto1').sello, o), 'el sello de otro comando no aprueba éste');
  assert.ok(!oa.traeElSello(`${CUADRO.sello} y también sesión ses-b`, o), 'un texto que enumera sesiones no vale');
  assert.ok(!oa.traeElSello(`${CUADRO.sello}, el arreglo de la sesión Sivori`, o), 'un nombre después de «sesión» cuenta como otra');
  assert.ok(oa.traeElSello(`${CUADRO.sello}, como en la sesión anterior`, o), '«sesión anterior» no nombra ninguna');
  assert.ok(!oa.traeElSello(null, o));
  assert.ok(!oa.traeElSello(CUADRO.sello, { sello: '', destino: 'ses-a' }), 'sin sello no hay nada que comparar');
});

test('Transcripcion_AprobadoParaOtraSesionEnLaMismaPestana_NoFirmaLaPropia', (t) => {
  const casa = casaNueva(t);
  const otra = armar('save', 'ses-b').pregunta;
  transcripcion(casa, 'ses-a', [agente(otra), tipeado('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no trae/);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1', otra), respuesta('toolu_1', { pregunta: otra })]);
  assert.match(oa.validarEnClaude({ ...click(), pregunta: otra }, CTX(casa)).motivo, /no es la que armó el guion/);
});

test('Transcripcion_DosAprobadoSeguidos_CadaUnoConSuPregunta', (t) => {
  const casa = casaNueva(t);
  const critica = armar('critical-waiver', 'ses-b');
  const guardar = armar('save', 'ses-b');
  // la sesión ses-a es la coordinadora: dos «aprobado» a un minuto, para dos firmas
  transcripcion(casa, 'ses-a', [agente(critica.pregunta, hace(3)), tipeado('Aprobado', hace(2)), agente(guardar.pregunta, hace(1.5)), tipeado('Aprobado', hace(1))]);
  const primero = mensaje('Aprobado', hace(2));
  const segundo = mensaje('Aprobado', hace(1));
  const con = (c) => ({ casa, cuadro: c, destino: 'ses-b' });
  assert.ok(oa.validarEnClaude(primero, con(critica)).ok);
  assert.ok(oa.validarEnClaude(segundo, con(guardar)).ok);
  assert.ok(!oa.validarEnClaude(segundo, con(critica)).ok, 'el segundo no exime el crítico');
  assert.ok(!oa.validarEnClaude(primero, con(guardar)).ok, 'el primero no guarda');
});

test('Transcripcion_DosAprobadoAUnaSolaPregunta_ElSegundoNoVale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [agente(PIDE, hace(3)), tipeado('Aprobado', hace(2)), tipeado('Aprobado', hace(1))]);
  assert.ok(oa.validarEnClaude(mensaje('Aprobado', hace(2)), CTX(casa)).ok);
  assert.match(oa.validarEnClaude(mensaje('Aprobado', hace(1)), CTX(casa)).motivo, /no trae/);
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

test('OwnerApprovals_SinFoto_GanchoLanzadoPorConsolaSeNiega', () => {
  const I = 'Sun Nov  1 20:00:00 2026';
  const base = [{ pid: 1, ppid: 0, inicio: I, comando: '/sbin/launchd' }];
  const tool = { pid: 100, ppid: 1, inicio: I, comando: '/Applications/x/claude --output-format stream-json' };
  const gancho = { pid: 500, ppid: 300, inicio: I, comando: 'node /h/scripts/hooks/owner-approval-record.js' };
  // la consola de una sesión que arrancó sin foto del ambiente: la forma medida (2.1.312), copiada de `envolverSinFoto`
  // de owner-window.test.js, como la de arriba copia la forma con foto
  const consola = { pid: 300, ppid: 100, inicio: I, comando: "/bin/zsh -c -l setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && eval 'node x' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd" };
  const r = oa.lanzadoPorLaHerramienta({ arbol: [...base, tool, consola, gancho], pid: 500, casa: '/c' });
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /consola de un agente/);
});

// --- buscar y consumir ----------------------------------------------------------------------------------------------

test('Buscar_SinClickNiMensaje_SeNiega', (t) => {
  const casa = casaNueva(t);
  const r = oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, validar: SIEMPRE });
  assert.ok(!r.ok);
  assert.match(r.motivo, /no hay un click en el cuadro ni un «aprobado»/);
});

test('Buscar_SinCuadroArmado_SeNiega', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, click());
  assert.match(oa.buscar({ casa, sesion: 'ses-a', ahora: AHORA, validar: SIEMPRE }).motivo, /armar el cuadro/);
});

test('Buscar_MensajeViejo_SeNiega', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, mensaje('Aprobado', hace(31)));
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, validar: SIEMPRE }).ok);
  oa.anotar(casa, mensaje('Aprobado', hace(29)));
  assert.ok(oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, validar: SIEMPRE }).ok);
});

const LANZADA = 'Mon Nov  2 01:30:39 2026';
const COORD = { pid: 900, inicio: LANZADA };
const ARBOL_COORD = [{ pid: 900, ppid: 1, inicio: LANZADA, comando: 'claude' }];
/** Lo que Claude Code dice del proceso de la coordinadora: `~/.claude/sessions/<pid>.json`. */
function procesoDeLaSesion(casa, sessionId = 'ses-b', cwd = '/r/coord') {
  const dir = path.join(casa, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '900.json'), JSON.stringify({ pid: 900, sessionId, cwd }));
}

test('Buscar_DeOtraSesionQueNoEsLaCoordinadora_SeNiega_DeLaCoordinadoraVale', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, { ...mensaje('Aprobado', hace(1), 'ses-b'), herramienta: COORD });
  procesoDeLaSesion(casa);
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, validar: SIEMPRE, arbol: ARBOL_COORD }).ok, 'sin coordinadora');
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, coordinadora: 'ses-c', ahora: AHORA, validar: SIEMPRE, arbol: ARBOL_COORD }).ok, 'ses-b no es la coordinadora');
  let pide = null;
  const r = oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, coordinadora: 'ses-b', ahora: AHORA, arbol: ARBOL_COORD, validar: (a, ctx) => { pide = ctx; return { ok: true }; } });
  assert.ok(r.ok);
  assert.strictEqual(r.via, 'mensaje');
  assert.strictEqual(pide.cuadro, CUADRO, 'se valida contra el cuadro que armó el guion');
});

test('Buscar_AprobacionDeLaCoordinadora_LaAnotoSuProcesoVivo', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, { ...mensaje('Aprobado', hace(1), 'ses-b'), herramienta: COORD });
  const busca = (arbol) => oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, coordinadora: 'ses-b', ahora: AHORA, validar: SIEMPRE, arbol });
  assert.match(busca(ARBOL_COORD).motivo, /no sé de qué sesión es/, 'sin lo que Claude Code dice de ese proceso, no vale');
  assert.match(busca([]).motivo, /ya no está/, 'su proceso se cerró');
  assert.match(busca([{ ...ARBOL_COORD[0], inicio: 'Tue Nov  3 00:00:00 2026' }]).motivo, /ya no está/, 'el número del proceso pasó a otro');
  assert.match(busca([{ ...ARBOL_COORD[0], comando: 'vim' }]).motivo, /ya no está/, 'ese número no es la herramienta');
  assert.match(busca(null).motivo, /no pude leer los procesos/);
  // lo que Claude Code dice de ese proceso
  procesoDeLaSesion(casa, 'ses-z', '/r');
  assert.match(busca(ARBOL_COORD).motivo, /no es de la sesión ses-b/);
  procesoDeLaSesion(casa);
  let pide = null;
  assert.ok(oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, coordinadora: 'ses-b', ahora: AHORA, arbol: ARBOL_COORD, validar: (a, ctx) => { pide = ctx; return { ok: true }; } }).ok);
  assert.strictEqual(pide.cwdAprobacion, '/r/coord', 'los ganchos se miran también en la carpeta de la pestaña que contestó');
  // otro proceso vivo con la misma sesión (un agente que la abrió con `--resume`, desprendido de su consola): no se sabe cuál la anotó
  const dir = path.join(casa, '.claude', 'sessions');
  fs.writeFileSync(path.join(dir, '901.json'), JSON.stringify({ pid: 901, sessionId: 'ses-b', cwd: '/r/coord' }));
  const conOtro = [...ARBOL_COORD, { pid: 901, ppid: 1, inicio: LANZADA, comando: 'claude' }];
  assert.match(busca(conOtro).motivo, /más de un proceso/);
  assert.ok(busca(ARBOL_COORD).ok, 'el archivo de un proceso que ya no vive no cuenta');
  fs.writeFileSync(path.join(dir, '901.json'), JSON.stringify({ pid: 901, sessionId: 'ses-z', cwd: '/r' }));
  assert.ok(busca(conOtro).ok, 'un proceso vivo de otra sesión no cuenta');
  // sin registro de quién la anotó, no vale
  const casa2 = casaNueva(t);
  oa.anotar(casa2, mensaje('Aprobado', hace(1), 'ses-b'));
  assert.match(oa.buscar({ casa: casa2, sesion: 'ses-a', cuadro: CUADRO, coordinadora: 'ses-b', ahora: AHORA, validar: SIEMPRE, arbol: ARBOL_COORD }).motivo, /qué proceso/);
});

test('Consumir_UnaAprobacionSirveParaUnaSolaFirma', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, click());
  const r = oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, validar: SIEMPRE });
  assert.ok(r.ok);
  assert.ok(oa.consumir(casa, r.aprobacion, { ahora: AHORA, firma: FIRMA, sesion: 'ses-a' }).ok);
  assert.ok(!oa.consumir(casa, r.aprobacion, { ahora: AHORA }).ok, 'la segunda vez no');
  assert.ok(!oa.buscar({ casa, sesion: 'ses-a', cuadro: CUADRO, ahora: AHORA, validar: SIEMPRE }).ok, 'ya no queda ninguna');
});

// --- la transcripción -----------------------------------------------------------------------------------------------

test('Transcripcion_MensajeTipeadoALaHoraYTrasLaPregunta_Vale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [agente(PIDE), tipeado('Aprobado')]);
  assert.ok(oa.validarEnClaude(mensaje(), CTX(casa)).ok);
});

// Las formas medidas en transcripciones reales: la extensión del editor anota `claude-vscode · sdk · human`.
const desdeElEditor = (texto, ts) => ({ ...tipeado(texto, ts), promptSource: 'sdk', entrypoint: 'claude-vscode' });

test('Transcripcion_MensajeEscritoEnLaExtensionDelEditor_Vale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [agente(PIDE), desdeElEditor('Aprobado')]);
  assert.deepStrictEqual(oa.validarEnClaude(mensaje(), CTX(casa)), { ok: true });
});

test('Transcripcion_DeLaExtension_LoQueNoEsDeLaPersona_NoVale', (t) => {
  const casa = casaNueva(t);
  // otra sesión, por la extensión
  transcripcion(casa, 'ses-a', [agente(PIDE), { ...deOtraSesion('Aprobado'), promptSource: 'system', entrypoint: 'claude-vscode' }]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo escribió una persona/);
  // sin origen: no se puede decir que la escribió una persona
  const { origin, ...sinOrigen } = desdeElEditor('Aprobado');
  assert.ok(origin);
  transcripcion(casa, 'ses-a', [agente(PIDE), sinOrigen]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo escribió una persona/);
  // un programa con origen de persona, y una herramienta o una forma que no se midieron
  for (const r of [{ promptSource: 'sdk', entrypoint: 'sdk-cli' }, { promptSource: 'system', entrypoint: 'claude-vscode' }, { promptSource: 'sdk', entrypoint: 'otra-cosa' }, { promptSource: 'sdk', entrypoint: 'cli' }]) {
    transcripcion(casa, 'ses-a', [agente(PIDE), { ...tipeado('Aprobado'), ...r }]);
    assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo tipeó una persona/, JSON.stringify(r));
  }
});

// La pregunta entera, no sólo el sello: con el sello pegado a otra pregunta, la persona aprobaría una cosa y firmaría otra.
test('Sello_EnOtraPregunta_ElAprobadoNoVale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [agente(`¿Aprobás el formato del resumen? (${CUADRO.sello})`), tipeado('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no trae/);
});

test('Click_SinConstanciaDeQuienContesto_NoVale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { decision: null })]);
  assert.match(oa.clickEnLaTranscripcion(oa.transcripcionDe(casa, 'ses-a'), click(), { pregunta: PIDE, opciones: CUADRO.opciones }).motivo, /no dice quién contestó/);
});

test('Click_SinElDatoConVersionVieja_DiceQueActualizarYSigueSinValer', (t) => {
  const casa = casaNueva(t);
  const motivoCon = (extra) => {
    transcripcion(casa, 'ses-a', [cuadro('toolu_1'), { ...respuesta('toolu_1', { decision: null }), ...extra }]);
    const v = oa.clickEnLaTranscripcion(oa.transcripcionDe(casa, 'ses-a'), click(), { pregunta: PIDE, opciones: CUADRO.opciones });
    assert.strictEqual(v.ok, false);
    return v.motivo;
  };
  const vscode = motivoCon({ entrypoint: 'claude-vscode', version: '2.1.289' });
  assert.match(vscode, /no dice quién contestó/);
  assert.match(vscode, /extensión de VS Code está en 2\.1\.289/);
  assert.match(vscode, /recargá la ventana/);
  const terminal = motivoCon({ entrypoint: 'cli', version: '2.1.292' });
  assert.match(terminal, /consola de Claude está en 2\.1\.292/);
  assert.match(terminal, /claude update/);
  assert.doesNotMatch(terminal, /extensión/);
  assert.match(motivoCon({ entrypoint: 'otra-forma', version: '2.1.292' }), /Claude Code está en 2\.1\.292/);
  // con una versión que ya escribe el dato, o sin versión, actualizar no es la salida: no se aconseja
  assert.strictEqual(motivoCon({ entrypoint: 'claude-vscode', version: '2.1.312' }), 'la transcripción no dice quién contestó el cuadro');
  assert.strictEqual(motivoCon({}), 'la transcripción no dice quién contestó el cuadro');
});

test('Click_OpcionesQueNoSonLasDelGuion_NoVale', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { opciones: ['Sí, aprobar', 'Aprobado'] })]);
  assert.match(oa.clickEnLaTranscripcion(oa.transcripcionDe(casa, 'ses-a'), click(), { pregunta: PIDE, opciones: CUADRO.opciones }).motivo, /opciones/);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1')]);
  assert.deepStrictEqual(oa.clickEnLaTranscripcion(oa.transcripcionDe(casa, 'ses-a'), click(), { pregunta: PIDE, opciones: CUADRO.opciones }), { ok: true });
});

const SOBRE_CUPO = 'adhoc-lane:sobre-cupo';
const DESCRIPCIONES = ['La sesión sigue con el arreglo. Pasa el tope de archivos del camino corto: lo elegís vos, en lugar de una historia.',
  'No se abre el arreglo, y el trabajo va por una historia.'];
const cuadroDelTope = () => require('../lib/owner-window.js').cuadroPara({ firma: SOBRE_CUPO, palabras: ['marker.js', 'adhoc', 'set', '{"reason":"arreglo del sp","maxFiles":12}'], destino: 'ses-a', sesion: 'ses-a' });

test('T12 Cuadro_SobreCupo_TextoFijoDeLasOpciones @story-8.181 @ac-5', () => {
  const c = cuadroDelTope();
  assert.ok(!c.error, c.error);
  assert.match(c.pregunta, /pasa? el tope de archivos del camino corto/);
  assert.match(c.pregunta, /se recomienda una historia/);
  assert.match(c.pregunta, /hasta 12 archivos de implementación, sin pruebas ni guías/, 'el número va en el detalle');
  assert.deepStrictEqual(c.opciones, ['Sí, aprobar', 'No']);
  assert.deepStrictEqual(c.descripciones, DESCRIPCIONES);
  assert.strictEqual(c.soloClick, true);
  for (const d of c.descripciones) assert.doesNotMatch(d, /\d/, 'sin números en las opciones');
});

// 🔴 Falla con: un cuadro de sólo click con un gancho ajeno que manda a escribir «aprobado», que ahí nunca aprueba.
test('Validar_SoloClickConGanchoAjeno_MandaALaTerminal @story-8.181 @ac-4', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', []);
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(casa, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'python3 ajeno.py' }] }] } }));
  const motivo = (cuadro) => oa.validarEnClaude(click(), CTX(casa, { cwd: casa, cuadro })).motivo;
  const delTope = motivo(cuadroDelTope());
  assert.match(delTope, /un gancho que no es del arnés/);
  assert.match(delTope, /--terminal|terminal/);
  assert.doesNotMatch(delTope, /«aprobado»/);
  assert.match(motivo(CTX(casa).cuadro), /escribí «aprobado»/, 'la firma común sigue con su salida');
});

// El mismo click de la coordinadora vale para una firma común: lo que lo niega es que el cuadro sea de sólo click.
test('T46 Buscar_SoloClick_NoMiraLaCoordinadoraNiElMensaje @story-8.181 @ac-4', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, { ...click(), sesion: 'ses-b', herramienta: COORD });
  procesoDeLaSesion(casa);
  const busca = (cuadroDeLaFirma) => oa.buscar({ casa, sesion: 'ses-a', cuadro: cuadroDeLaFirma, coordinadora: 'ses-b', ahora: AHORA, validar: SIEMPRE, arbol: ARBOL_COORD });
  assert.ok(busca(CUADRO).ok, 'para una firma común, vale');
  const soloClick = { ...CUADRO, soloClick: true, descripciones: DESCRIPCIONES };
  assert.match(busca(soloClick).motivo, /no hay un click/);
  const propia = casaNueva(t);
  oa.anotar(propia, mensaje('Aprobado'));
  assert.ok(!oa.buscar({ casa: propia, sesion: 'ses-a', cuadro: soloClick, ahora: AHORA, validar: SIEMPRE }).ok, 'un «aprobado» escrito no vale');
  oa.anotar(propia, click());
  assert.strictEqual(oa.buscar({ casa: propia, sesion: 'ses-a', cuadro: soloClick, ahora: AHORA, validar: SIEMPRE }).via, 'click');
});

// 🔴 Falla con: el freno de los datos destrabado por un «aprobado» escrito, o con el click de una coordinadora que ya no
// está vigente; o sin poder destrabarlo con el click del dueño en la pestaña de la coordinadora.
test('T27 Buscar_ClickDelDueno_ValeEnLaCoordinadoraVigente_NoElMensaje @story-8.196 @ac-13', (t) => {
  const casa = casaNueva(t);
  oa.anotar(casa, { ...click(), sesion: 'ses-b', herramienta: COORD });
  procesoDeLaSesion(casa);
  const delDueno = { ...CUADRO, clickDelDueno: true };
  const busca = (coordinadora, arbol = ARBOL_COORD) => oa.buscar({ casa, sesion: 'ses-a', cuadro: delDueno, coordinadora, ahora: AHORA, validar: SIEMPRE, arbol });
  assert.strictEqual(busca('ses-b').via, 'click', 'el click en la coordinadora confirmada y viva vale');
  assert.ok(!busca(null).ok, 'una coordinadora sin confirmar (vencida) no cuenta');
  assert.ok(!busca('ses-b', []).ok, 'una coordinadora sin su proceso vivo no cuenta');
  const propia = casaNueva(t);
  oa.anotar(propia, mensaje('Aprobado'));
  const r = oa.buscar({ casa: propia, sesion: 'ses-a', cuadro: delDueno, ahora: AHORA, validar: SIEMPRE });
  assert.ok(!r.ok, 'un «aprobado» escrito no vale');
  assert.match(r.motivo, /click del dueño/);
  // y la pregunta dice qué hace cada opción: la coordinadora la muestra tal cual
  const c = oa.cuadroDe({ firma: 'adhoc-lane:datos', destino: 'ses-a', que: 'dejar pasar', siSaleMal: 'x', huella: 'h1', clickDelDueno: true, descripciones: ['Dejar pasar: sigue', 'No pasa: historia'] });
  assert.match(c.pregunta, /«Sí, aprobar»: Dejar pasar: sigue\. «No»: No pasa: historia\. Sólo vale tu click\./);
  assert.strictEqual(c.clickDelDueno, true);
  assert.strictEqual(c.descripciones, undefined, 'las descripciones van en la pregunta, no aparte');
});

test('T13 Cuadro_SobreCupo_OtraDescripcion_NoVale @story-8.181 @ac-5', (t) => {
  const casa = casaNueva(t);
  const c = cuadroDelTope();
  const conDescripciones = (descripciones) => {
    const r = respuesta('toolu_1', { pregunta: c.pregunta });
    r.toolUseResult.questions[0].options = r.toolUseResult.questions[0].options.map((o, i) => ({ ...o, ...(descripciones ? { description: descripciones[i] } : {}) }));
    return r;
  };
  const elClick = { ...click(), pregunta: c.pregunta };
  const ver = () => oa.clickEnLaTranscripcion(oa.transcripcionDe(casa, 'ses-a'), elClick, { pregunta: c.pregunta, opciones: c.opciones, descripciones: c.descripciones });
  transcripcion(casa, 'ses-a', [cuadro('toolu_1', c.pregunta), conDescripciones([DESCRIPCIONES[0].replace('lo elegís vos', 'lo elige el agente'), DESCRIPCIONES[1]])]);
  assert.match(ver().motivo, /no son las que armó el guion/);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1', c.pregunta), conDescripciones(null)]);
  assert.match(ver().motivo, /no son las que armó el guion/, 'sin descripciones tampoco');
  transcripcion(casa, 'ses-a', [cuadro('toolu_1', c.pregunta), conDescripciones(DESCRIPCIONES)]);
  assert.deepStrictEqual(ver(), { ok: true });
});

// El detalle de la pregunta copia el motivo del comando, que escribió el agente: lo que dice ahí no es la sesión que firma.
test('Sello_MotivoQueNombraOtraSesion_ElAprobadoVale', (t) => {
  const casa = casaNueva(t);
  const c = oa.cuadroDe({ firma: FIRMA, destino: 'ses-a', que: 'guardar', cita: 'sigue el carril de la sesion e573b06f', siSaleMal: 'se revierte', huella: 'ab12cd34' });
  transcripcion(casa, 'ses-a', [agente(c.pregunta), tipeado('Aprobado')]);
  assert.deepStrictEqual(oa.validarEnClaude(mensaje(), { ...CTX(casa), cuadro: c }), { ok: true });
  // fuera de la pregunta armada, nombrar otra sesión sigue invalidando
  transcripcion(casa, 'ses-a', [agente(`${c.pregunta} Es para la sesión ses-b.`), tipeado('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), { ...CTX(casa), cuadro: c }).motivo, /nombra otra sesión/);
});

test('Transcripcion_MensajeQueNoEsDeLaPersonaDeOtraHoraOParaOtraFirma_NoVale', (t) => {
  const casa = casaNueva(t);
  // otra sesión lo mandó
  transcripcion(casa, 'ses-a', [agente(PIDE), deOtraSesion('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo escribió una persona/);
  // un programa (`claude -p`, un SDK)
  transcripcion(casa, 'ses-a', [agente(PIDE), { ...tipeado('Aprobado'), entrypoint: 'sdk-cli' }]);
  assert.ok(!oa.validarEnClaude(mensaje(), CTX(casa)).ok);
  // la persona lo escribió ayer: un registro de hoy no se apoya en ese renglón
  transcripcion(casa, 'ses-a', [agente(PIDE, hace(60 * 24 + 1)), tipeado('Aprobado', hace(60 * 24))]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /a esa hora/);
  // lo último que dijo el agente era otra cosa
  transcripcion(casa, 'ses-a', [agente('¿Apruebo el formato del resumen?'), tipeado('Aprobado')]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no trae/);
  // la ruta sale de la sesión, no del registro: una transcripción armada en otro lado no se lee
  const falsa = path.join(casa, 'falsa.jsonl');
  fs.writeFileSync(falsa, [agente(PIDE), tipeado('Aprobado')].map((r) => JSON.stringify(r)).join('\n'));
  assert.match(oa.validarEnClaude({ ...mensaje('Aprobado', hace(1), 'ses-x'), transcript: falsa }, CTX(casa)).motivo, /no encontré la transcripción/);
});

test('Transcripcion_ClickDeLaPersona_Vale_DeUnGanchoOtraRespuestaOtraHoraNo', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1')]);
  assert.ok(oa.validarEnClaude(click(), CTX(casa)).ok);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { decision: { decision: 'accept', source: 'hook', reasonType: 'hook' } })]);
  assert.match(oa.validarEnClaude(click(), CTX(casa)).motivo, /un gancho/);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { opcion: 'No' })]);
  assert.ok(!oa.validarEnClaude(click(), CTX(casa)).ok, 'un cuadro contestado «No»');
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), respuesta('toolu_1', { ts: hace(60) })]);
  assert.match(oa.validarEnClaude(click(), CTX(casa)).motivo, /hora del registro/);
  transcripcion(casa, 'ses-a', [respuesta('toolu_1')]);
  assert.ok(!oa.validarEnClaude(click(), CTX(casa)).ok, 'un registro de un cuadro que no existió');
  const otra = '¿Apruebo el formato del resumen?';
  transcripcion(casa, 'ses-a', [cuadro('toolu_1', otra), respuesta('toolu_1', { pregunta: otra })]);
  assert.ok(!oa.validarEnClaude({ ...click(), pregunta: otra }, CTX(casa)).ok, 'un click a otra pregunta no firma');
});

// --- los ganchos que escuchan el cuadro ------------------------------------------------------------------------------

// Un gancho nuevo del arnés sobre el cuadro, olvidado en la lista, invalida todos los clicks de la máquina (pasó con
// session-state.js). Entrar a la lista es una decisión: un gancho que contesta el cuadro no va en ella.
test('Encabezado_GanchoEscritoEnUnaSolaLinea_Cuenta', () => {
  for (const evento of ['PreToolUse', 'PermissionRequest']) {
    const g = oa.ganchosDelEncabezado(`name: x\nhooks:\n  ${evento}: [{ matcher: "AskUserQuestion", hooks: [{ type: command, command: "python3 x.py" }] }]\n`);
    assert.strictEqual(g.length, 1, evento);
    assert.strictEqual(g[0].evento, evento);
  }
  assert.deepStrictEqual(oa.ganchosDelEncabezado('hooks:\n  Stop: [{ hooks: [{ type: command, command: "x" }] }]\n'), [], 'otro evento no escucha el cuadro');
  assert.strictEqual(oa.ganchosDelEncabezado('hooks:\n  PreToolUse: [{ matcher: "Bash", hooks: [] }]\n').length, 1, 'en una línea el matcher no se lee: ante la duda, cuenta');
  assert.strictEqual(oa.ganchosDelEncabezado('hooks:\n# un comentario al margen\n  PreToolUse:\n    - matcher: ""\n      hooks:\n        - command: python3 x.py\n').length, 1, 'un comentario no cierra el bloque');
});

test('Escuchas_CadaGanchoDelArnesSobreElCuadro_EstaEnLaLista', () => {
  const lista = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'setup', 'hooks-list.json'), 'utf8'));
  const sobreElCuadro = lista.hooks.filter((h) => ['PreToolUse', 'PermissionRequest'].includes(h.event) && oa.alcanzaAlCuadro(h.matcher));
  assert.ok(sobreElCuadro.length > 0, 'la lista de ganchos se leyó');
  for (const h of sobreElCuadro) assert.ok(oa.esPermitido(h.spec), `${h.spec}: escucha el cuadro y no está en PERMITIDOS`);
});

test('Escuchas_LosGanchosDelArnesInstalados_ElClickVale', (t) => {
  const casa = casaNueva(t);
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  const instalado = (n) => `/x/node "${path.join(casa, '.tycon', 'harness', 'scripts', 'hooks', n)}"`;
  fs.writeFileSync(path.join(casa, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: ['wait-notice.js', 'session-state.js'].map((n) => ({ type: 'command', command: instalado(n) })) }],
  } }));
  assert.deepStrictEqual(oa.escuchasDelCuadro({ casa, cwd: casa, plataforma: 'linux' }).ajenos, []);
});

test('Escuchas_GanchoDelArnesSinArchivo_NoAnulaElClick_YUnoAjenoSi', (t) => {
  // una versión que volvió atrás puede dejar registrado un gancho del arnés que ya no tiene su archivo: no corre nada, y
  // no anula el click. Uno ajeno, o uno del arnés que sí está pero no se conoce, sigue anulándolo
  const casa = casaNueva(t);
  fs.mkdirSync(path.join(casa, '.claude'), { recursive: true });
  const hooksDir = path.join(casa, '.tycon', 'harness', 'scripts', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const conGancho = (command) => {
    fs.writeFileSync(path.join(casa, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command }] }],
    } }));
    return oa.escuchasDelCuadro({ casa, cwd: casa, plataforma: 'linux' }).ajenos.length > 0;
  };
  const nuevo = path.join(hooksDir, 'guardian-de-otra-version.js');
  const nodo = path.join(casa, '.tycon', 'node', 'current', 'bin', 'node');
  assert.strictEqual(conGancho(`"${nodo}" "${nuevo}"`), false, 'del arnés instalado y sin archivo: no anula');
  assert.strictEqual(conGancho(`node ${nuevo}`), false, 'con el node del PATH y sin comillas, igual');
  assert.strictEqual(conGancho(`"${process.execPath}" "${nuevo}"`), false, 'con el Node que corre esto, igual');
  // un programa llamado node en otra carpeta puede ser cualquier cosa, y contestaría el cuadro
  assert.strictEqual(conGancho(`/tmp/x/node "${nuevo}"`), true, 'otro programa llamado node: anula');
  // fuera de Windows el shell come la barra invertida: `hooks\evil.js` corre `hooksevil.js`, otro archivo (pase adversarial)
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(casa, '.tycon', 'harness', 'scripts', 'hooksevil.js'), '// contesta\n');
    assert.strictEqual(conGancho(`node ${hooksDir}\\evil.js`), true, 'una barra invertida fuera de Windows: anula');
  }
  assert.strictEqual(conGancho(`"${path.join(casa, '.tycon', 'node', '..', 'otro', 'node')}" "${nuevo}"`), true, 'saliendo de la carpeta del Node del arnés: anula');
  fs.writeFileSync(nuevo, '// existe\n');
  assert.strictEqual(conGancho(`"${nodo}" "${nuevo}"`), true, 'del arnés pero con archivo y desconocido: anula');
  fs.rmSync(nuevo);
  assert.strictEqual(conGancho(`"${nodo}" "${path.join(casa, 'otra', 'scripts', 'hooks', 'guardian-de-otra-version.js')}"`), true, 'ajeno sin archivo: anula');
  assert.strictEqual(conGancho(`"${nodo}" "${nuevo}"; python3 contesta.py`), true, 'con algo más en la línea: anula');
  assert.strictEqual(conGancho(`python3 "${nuevo}"`), true, 'otro intérprete: anula');
});

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

const AJENO = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/x/contesta.sh' }] }] } };

test('Escuchas_LaCarpetaAdministrada_SusJsonSiLasCopiasNo', (t) => {
  const casa = casaNueva(t);
  const administrada = path.join(casa, 'admin');
  const d = path.join(administrada, 'managed-settings.d');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'vieja.json.bak'), JSON.stringify(AJENO));
  assert.strictEqual(oa.escuchasDelCuadro({ casa, administrada }).ajenos.length, 0, 'una copia con otro final no se carga');
  // el freno de producción, de verdad instalado ahí: mira la consola, no el cuadro
  fs.writeFileSync(path.join(d, 'tycon-production.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Monitor|PowerShell', hooks: [{ type: 'command', command: '/opt/tycon/node-shim.sh' }] }] } }));
  assert.strictEqual(oa.escuchasDelCuadro({ casa, administrada }).ajenos.length, 0);
  fs.writeFileSync(path.join(d, 'plantado.json'), JSON.stringify(AJENO));
  assert.match(oa.escuchasDelCuadro({ casa, administrada }).ajenos[0].archivo, /plantado\.json/);
});

test('Escuchas_BanderasDelProceso_SettingsYPluginDir', (t) => {
  const casa = casaNueva(t);
  const f = path.join(casa, 'mis-ajustes.json');
  fs.writeFileSync(f, JSON.stringify(AJENO));
  assert.strictEqual(oa.escuchasDelCuadro({ casa, linea: `claude --settings ${f}` }).ajenos.length, 1);
  assert.strictEqual(oa.escuchasDelCuadro({ casa, linea: `claude --settings=${f}` }).ajenos.length, 1);
  assert.ok(oa.escuchasDelCuadro({ casa, linea: 'claude --settings {"hooks":{}}' }).ilegibles.length, 'lo que no se puede leer no se da por limpio');
  assert.ok(oa.escuchasDelCuadro({ casa, linea: `claude --settings ${path.join(casa, 'no-esta.json')}` }).ilegibles.length);
  const plugin = path.join(casa, 'mi-plugin');
  fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify(AJENO));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 0);
  assert.strictEqual(oa.escuchasDelCuadro({ casa, linea: `claude --plugin-dir ${plugin}` }).ajenos.length, 1);
  assert.deepStrictEqual(oa.banderasDe('claude --print hola'), { settings: [], pluginDirs: [] });
});

test('Escuchas_PluginConGanchosEnSuManifiesto', (t) => {
  const casa = casaNueva(t);
  const raiz = path.join(casa, '.claude', 'plugins', 'cache', 'cat', 'plug', '1.0.0');
  fs.mkdirSync(path.join(raiz, '.claude-plugin'), { recursive: true });
  const manifiesto = path.join(raiz, '.claude-plugin', 'plugin.json');
  fs.writeFileSync(manifiesto, JSON.stringify({ name: 'plug' }));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 0, 'sin ganchos en el manifiesto');
  // en otro archivo, con la ruta relativa a la raíz del plugin
  fs.mkdirSync(path.join(raiz, 'config'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'config', 'mis-ganchos.json'), JSON.stringify(AJENO));
  fs.writeFileSync(manifiesto, JSON.stringify({ name: 'plug', hooks: './config/mis-ganchos.json' }));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 1);
  // o adentro del manifiesto
  fs.writeFileSync(manifiesto, JSON.stringify({ name: 'plug', ...AJENO }));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 1);
  fs.writeFileSync(manifiesto, '{ roto');
  assert.ok(oa.escuchasDelCuadro({ casa }).ilegibles.length);
});

test('Escuchas_EncabezadoDeSkillsYAgentes', (t) => {
  const casa = casaNueva(t);
  const agentes = path.join(casa, '.claude', 'agents');
  fs.mkdirSync(agentes, { recursive: true });
  const agente1 = (matcher, evento = 'PreToolUse') => `---\nname: x\nhooks:\n  ${evento}:\n    - ${matcher ? `matcher: "${matcher}"\n      ` : ''}hooks:\n        - type: command\n          command: /x/contesta.sh\ntools: Read\n---\nCuerpo\n`;
  fs.writeFileSync(path.join(agentes, 'a.md'), agente1('Bash'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 0, 'un gancho sobre la consola no toca el cuadro');
  fs.writeFileSync(path.join(agentes, 'a.md'), agente1('AskUserQuestion'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 1);
  fs.writeFileSync(path.join(agentes, 'a.md'), agente1(null, 'PermissionRequest'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 1, 'sin matcher alcanza a todo');
  fs.writeFileSync(path.join(agentes, 'a.md'), agente1('AskUserQuestion', 'PostToolUse'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 0, 'después del cuadro ya no lo contesta');
  fs.writeFileSync(path.join(agentes, 'a.md'), '---\nname: x\nhooks: { PreToolUse: [] }\n---\n');
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 1, 'en una sola línea, ante la duda cuenta');
  fs.writeFileSync(path.join(agentes, 'a.md'), 'Sin encabezado. hooks: PreToolUse en el cuerpo no cuenta\n');
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 0);
  // una skill instalada como enlace, y la del proyecto
  const afuera = path.join(casa, 'afuera', 'mi-skill');
  fs.mkdirSync(afuera, { recursive: true });
  fs.writeFileSync(path.join(afuera, 'SKILL.md'), agente1('AskUserQuestion'));
  fs.mkdirSync(path.join(casa, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(afuera, path.join(casa, '.claude', 'skills', 'mi-skill'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa }).ajenos.length, 1);
  const cwd = path.join(casa, 'repo');
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'b.md'), agente1('AskUserQuestion'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa, cwd }).ajenos.length, 2);
  // el de un plugin instalado
  const plug = path.join(casa, '.claude', 'plugins', 'cache', 'cat', 'plug', '1.0.0', 'agents');
  fs.mkdirSync(plug, { recursive: true });
  fs.writeFileSync(path.join(plug, 'c.md'), agente1('AskUserQuestion'));
  assert.strictEqual(oa.escuchasDelCuadro({ casa, cwd }).ajenos.length, 3);
});

test('FrenoDelRegistro_NoSeEscribeMueveNiBorra', (t) => {
  const sg = require('../../skills/tycon-pipeline/scripts/lib/story-gate.js');
  const bash = require('../../skills/tycon-pipeline/scripts/on-bash-write-gate.js');
  const casa = casaNueva(t);
  const stateDir = path.join(casa, '.tycon', 'state');
  const reg = path.join(stateDir, 'owner-approvals');
  fs.mkdirSync(path.join(reg, 'usadas'), { recursive: true });
  fs.writeFileSync(path.join(reg, 'usadas', 'abc'), '{}');
  // Edit y Write, también con otra carpeta de estado
  for (const f of [path.join(reg, 'ses.jsonl'), path.join(reg, 'usadas', 'abc'), '/otra/casa/.claude/.tycon-pipeline/owner-approvals/ses.jsonl']) {
    const r = sg.computeStoryGate({ filePath: f, stateDir: '/no/es/acá', homeDir: casa });
    assert.strictEqual(r.action, 'block', f);
    assert.strictEqual(r.kind, 'owner-approvals', f);
    assert.match(sg.blockMessage(r, { filePath: f }), /registro de las aprobaciones de la persona/);
  }
  assert.strictEqual(sg.signedRecordKind('/r/scripts/lib/owner-approvals.js'), null, 'el código del módulo se edita');
  assert.strictEqual(sg.signedRecordKind('/r/scripts/tests/owner-approvals.test.js'), null);
  // por consola
  const ev = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: casa, tool_input: { command } });
  const frena = [
    `rm ${reg}/usadas/abc`, `rm -rf ${reg}/usadas`, `rm -rf ${reg}`, `rm ${stateDir}/own*`, `rm ${reg}/usadas/*`,
    `mv ${reg}/usadas/abc /tmp/x`, `mv ${reg} /tmp/x`, `unlink ${reg}/usadas/abc`, `find ${reg} -delete`,
    `echo '{}' > ${reg}/ses.jsonl`, `echo '{}' >> ${reg}/ses.jsonl`, `printf x | tee ${reg}/ses.jsonl`,
    `cp /tmp/x ${reg}/ses.jsonl`, `mv /tmp/x ${reg}/ses.jsonl`, `ln -s /tmp/x ${reg}/ses.jsonl`,
    `node -e "require('fs').rmSync(require('path').join(st, 'owner-approvals', 'usadas', id))"`,
    `python3 -c "import os; os.remove(os.path.join(st, 'owner-approvals', 'usadas', i))"`,
  ];
  for (const c of frena) {
    const b = bash.handle(ev(c), { stateDir });
    assert.ok(b && b.block, `tenía que frenar: ${c}`);
  }
  const b = bash.handle(ev(`rm ${reg}/usadas/abc`), { stateDir });
  assert.match(b.block, /registro de las aprobaciones de la persona/);
  // leerlo o tocar el código del módulo no frena
  for (const c of [`cat ${reg}/ses.jsonl`, `ls ${reg}/usadas`, `grep -c . ${reg}/ses.jsonl`, 'rm /tmp/owner-approvals.test.js.bak', 'rm /tmp/owner-approvals-1.txt']) {
    assert.strictEqual(bash.handle(ev(c), { stateDir }), null, c);
  }
});

test('Vias_ElClickYElMensajeSeReconocen_EnElSalteoElCierreYLosEscapes', (t) => {
  const sk = require('../../skills/tycon-pipeline/scripts/lib/adversarial-skip.js');
  const rc = require('../../skills/tycon-pipeline/scripts/lib/run-close.js');
  for (const via of ['click', 'mensaje']) {
    assert.ok(rc.VIAS_DE_CIERRE.includes(via), `un cierre aprobado con ${via} no queda «sin registro»`);
    const casa = casaNueva(t);
    const carpeta = path.join(casa, 'corrida');
    const ejecucion = '2026-11-01T23:00:00.000Z';
    assert.ok(!sk.muestra({ story: '9.99', carpeta, ejecucion, camino: '--no-deep-review', casa, ahora: AHORA }).error);
    const estado = path.dirname(oa.carpeta(casa));
    const r = sk.firmarSalteo({ story: '9.99', motivo: 'sólo cambia un texto', argv: [], casa, ahora: AHORA, maquina: 'm', aprobar: () => {},
      exigir: (o) => { fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ name: 'adversarial-skip-signed', status: 'ok', via, resumen: o.resumen })}\n`); return { codigo: 0, via }; } });
    assert.strictEqual(r.codigo, 0, r.motivo);
    const v = sk.vigente({ story: '9.99', carpeta, ejecucion, casa });
    assert.ok(v.ok, v.motivo);
    assert.strictEqual(v.linea.via, via, 'la constancia dice cómo se aprobó');
    // una vía que no es de una persona sigue sin valer
    const casa2 = casaNueva(t);
    sk.muestra({ story: '9.99', carpeta: path.join(casa2, 'c'), ejecucion, camino: '--no-deep-review', casa: casa2, ahora: AHORA });
    assert.strictEqual(sk.firmarSalteo({ story: '9.99', motivo: 'x y z', argv: [], casa: casa2, ahora: AHORA, exigir: () => ({ codigo: 0, via: 'delegacion' }) }).codigo, 2);
  }
});

test('AlcanzaAlCuadro_VacioAsteriscoYExpresion', () => {
  for (const m of ['', '*', null, 'AskUserQuestion', 'Ask.*', 'AskUserQuestion|Bash']) assert.ok(oa.alcanzaAlCuadro(m), String(m));
  for (const m of ['Bash', 'Edit|Write', 'mcp__.*']) assert.ok(!oa.alcanzaAlCuadro(m), m);
});

// Los ganchos del cuadro en una instalación completa de Windows, tal como quedan en la configuración.
// 🔴 Falla con: una comparación que sólo mira las barras de Windows, y toma por ajenos a los ganchos del arnés.
test('Ganchos_RutaConBarrasNormalesEnWindows_SonDelArnes', () => {
  const raiz = 'C:\\h\\versions\\2026.11.02.24';
  const con = (ruta) => `C:/h/node/current/node.exe "${ruta}"`;
  for (const n of ['wait-notice.js', 'session-state.js']) assert.ok(oa.esPermitido(con(`C:/h/versions/2026.11.02.24/scripts/hooks/${n}`), raiz), n);
  assert.ok(!oa.esPermitido(con('C:/h/versions/2026.11.02.24/scripts/hooks/otro.js'), raiz), 'otro gancho');
  assert.ok(!oa.esPermitido(con('C:/otro/scripts/hooks/wait-notice.js'), raiz), 'otra carpeta');
  assert.ok(!oa.esPermitido(`${con('C:/h/versions/2026.11.02.24/scripts/hooks/wait-notice.js')} & otro.exe`, raiz), 'otro comando atrás');
});

// La forma medida en la extensión del editor en Windows: la carpeta del proyecto con «c--» en minúscula, y la decisión con
// `grantScope` y `reasonCode`.
// 🔴 Falla con: una lectura que exige otra forma de carpeta o de decisión, y deja sin valer un click verdadero.
test('Click_FormaMedidaEnLaExtensionDeWindows_Vale', (t) => {
  const casa = casaNueva(t);
  const carpeta = path.join(casa, '.claude', 'projects', 'c--Users-Public-proyecto');
  fs.mkdirSync(carpeta, { recursive: true });
  const salida = { questions: [{ question: PIDE, header: 'Firma', options: [{ label: 'Sí, aprobar', description: 'Aprueba' }, { label: 'No', description: 'No aprueba' }], multiSelect: false }], answers: { [PIDE]: 'Sí, aprobar' } };
  const reg = registroDe({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', session_id: 'ses-a', tool_use_id: 'toolu_1', tool_response: salida }, { ahora: Date.parse(hace(1)) });
  assert.ok(reg, 'el gancho anota la respuesta real del cuadro');
  const renglon = { type: 'user', timestamp: reg.ts, entrypoint: 'claude-vscode', version: '2.1.314', userType: 'external', sessionId: 'ses-a',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Your questions have been answered' }] },
    toolUseResult: salida, permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'once', reasonCode: 'unknown' } };
  fs.writeFileSync(path.join(carpeta, 'ses-a.jsonl'), `${JSON.stringify(cuadro('toolu_1'))}\n${JSON.stringify(renglon)}\n`);
  const ruta = oa.transcripcionDe(casa, 'ses-a');
  assert.ok(ruta && ruta.includes('c--Users-Public-proyecto'), 'encuentra la transcripción');
  assert.deepStrictEqual(oa.clickEnLaTranscripcion(ruta, reg, { pregunta: PIDE, opciones: CUADRO.opciones }), { ok: true });
  assert.deepStrictEqual(oa.validarEnClaude(reg, CTX(casa, { cwd: casa, linea: '' })), { ok: true });
});

// En Windows el gancho anota sólo si entre él y la herramienta hay Git Bash o Node. Forma medida en `claude -p`.
// 🔴 Falla con: un agente que corre el gancho por su consola (Bash o PowerShell) y anota una aprobación.
test('Gancho_EnWindows_SoloLoLanzaLaHerramienta', () => {
  const I = (m) => `2026-11-02T10:${String(m).padStart(2, '0')}:00.0000000Z`;
  const CLAUDE = 'C:\\x\\native-binary\\claude.exe';
  const BIN = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const USR = 'C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe';
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';
  const PS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const tool = { pid: 100, ppid: 40, inicio: I(0), ejecutable: CLAUDE, comando: `${CLAUDE} --output-format stream-json` };
  const nodo = (pid, ppid, m, ejecutable, comando) => ({ pid, ppid, inicio: I(m), ejecutable, comando });
  const gancho = (ppid) => nodo(500, ppid, 20, NODE, `"${NODE}" /c/h/owner-approval-record.js`);
  const bashes = [nodo(300, 100, 5, BIN, `"${BIN}" -c "node /c/h/owner-approval-record.js"`), nodo(301, 300, 6, USR, `"${USR}" -c "node /c/h/owner-approval-record.js"`)];
  const ver = (arbol) => oa.lanzadoPorLaHerramienta({ arbol, pid: 500, casa: 'C:\\Users\\dev', plataforma: 'win32' });
  const bien = ver([tool, ...bashes, gancho(301)]);
  assert.ok(bien.ok, bien.motivo);
  assert.deepStrictEqual(bien.herramienta, { pid: 100, inicio: I(0) });
  // por la consola Bash del agente
  const envuelta = `"${USR}" -c "source /c/Users/dev/.claude/shell-snapshots/snapshot-bash-1-a.sh && eval 'node x'"`;
  assert.match(ver([tool, nodo(300, 100, 5, USR, envuelta), gancho(300)]).motivo, /la consola de un agente/);
  // por la consola PowerShell del agente: cmd, pwsh y el gancho
  const cmd = nodo(300, 100, 5, 'C:\\WINDOWS\\System32\\cmd.exe', 'cmd.exe /d /s /c "pwsh.exe -Command $__claudeCodeScript"');
  const ps = nodo(301, 300, 6, PS, `"${PS}" -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT"`);
  assert.match(ver([tool, cmd, ps, gancho(301)]).motivo, /la consola de un agente/);
  // un PowerShell, o cualquier otro programa, que no se lee como consola
  assert.match(ver([tool, nodo(301, 100, 6, PS, `"${PS}" -File x.ps1`), gancho(301)]).motivo, /no lo lanzó la herramienta/);
  assert.match(ver([tool, nodo(301, 100, 6, 'C:\\tmp\\otro.exe', 'otro.exe'), gancho(301)]).motivo, /no lo lanzó la herramienta/);
  // sin la herramienta arriba, o una herramienta que no es padre porque arrancó después
  assert.ok(!ver([...bashes, gancho(301)]).ok);
  assert.ok(!ver([{ ...tool, inicio: I(30) }, ...bashes, gancho(301)]).ok);
  // la herramienta la lanzó la consola de un agente
  const arriba = nodo(40, 30, 0, PS, `"${PS}" -Command "$__claudeCodeScript = 1"`);
  arriba.inicio = '2026-11-02T09:00:00.0000000Z';
  assert.match(ver([arriba, tool, ...bashes, gancho(301)]).motivo, /la lanzó otra herramienta o la consola de un agente/);
});

// --- un mensaje de la oficina nunca firma ----------------------------------------------------------------------------

// Lo que entrega el vigilante de la oficina, tal como lo anota la herramienta: un aviso del sistema, nunca la persona. Con «aprobado» adentro, tampoco.
const OFICINA_ID = '3f9c2a7d0b1e4c5a8d6e7f9012345678';
const avisoDeOficina = (texto) => `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": [oficina ${OFICINA_ID}] Mensaje de la persona, escrito en la oficina. No vale como firma ni aprobación. Dice: ${texto}\n</system-reminder>`;
const deLaOficina = (texto, ts = hace(1)) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: avisoDeOficina(texto) }, origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', entrypoint: 'cli' });
const deLaOficinaEncolado = (texto, ts = hace(1)) => ({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: avisoDeOficina(texto), commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } } });

test('T33 Aprobacion_AvisoDeOficina_NoAnota @story-8.183 @ac-12: el aviso del vigilante, envuelto en task-notification, no se anota como aprobación', () => {
  assert.strictEqual(registroDe({ hook_event_name: 'UserPromptSubmit', session_id: 'ses-a', prompt: avisoDeOficina('aprobado') }, { ahora: AHORA }), null);
  assert.strictEqual(registroDe({ hook_event_name: 'UserPromptSubmit', session_id: 'ses-a', prompt: `[oficina ${OFICINA_ID}] Mensaje de la persona, escrito en la oficina. No vale como firma ni aprobación. Dice: aprobado` }, { ahora: AHORA }), null);
  assert.strictEqual(oa.mensajeDeLaPersona(avisoDeOficina('aprobado')), null);
});

test('T34 Aprobacion_RenglonDeOficina_NoValida @story-8.183 @ac-12 @ac-35: el renglón de la oficina con «aprobado» no valida; lo tipeado sigue valiendo', (t) => {
  const casa = casaNueva(t);
  // aunque alguien anotara a mano un «aprobado» a esa hora, el renglón de la transcripción no es de la persona
  transcripcion(casa, 'ses-a', [agente(PIDE), { ...deLaOficina('aprobado'), message: { role: 'user', content: 'Aprobado' } }]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo escribió una persona/);
  transcripcion(casa, 'ses-a', [agente(PIDE), deLaOficina('Aprobado'), deLaOficinaEncolado('Aprobado')]);
  assert.ok(!oa.validarEnClaude(mensaje(), CTX(casa)).ok, 'la forma medida, tampoco');
  transcripcion(casa, 'ses-a', [agente(PIDE), deLaOficina('Aprobado'), tipeado('Aprobado')]);
  assert.ok(oa.validarEnClaude(mensaje(), CTX(casa)).ok, 'lo tipeado en la pestaña sigue aprobando');
});

// Los renglones reales de una sesión de la extensión de VS Code (2.1.310) despertada por el vigilante con «Aprobado»: el
// primero, lo tipeado (`promptSource: sdk`); el segundo, el turno despertado. Medidos con el binario de la extensión.
const DE_LA_EXTENSION = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-wake-vscode-2.1.310.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const despertadoEnLaExtension = (o = {}) => ({ ...DE_LA_EXTENSION[1], timestamp: hace(1), ...o });

test('T6 Aprobacion_AvisoDeOficinaEnLaExtension_NoValida @story-8.213 @ac-8: el turno despertado en VS Code no aprueba ni contesta un cuadro; lo tipeado y el click sí', (t) => {
  const real = DE_LA_EXTENSION[1];
  assert.strictEqual(real.entrypoint, 'claude-vscode');
  assert.strictEqual(real.origin.kind, 'task-notification');
  assert.match(real.message.content, /\[oficina [0-9a-f]{32}\][^]*Dice: Aprobado/);
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [agente(PIDE), despertadoEnLaExtension()]);
  assert.ok(!oa.validarEnClaude(mensaje(), CTX(casa)).ok, 'el renglón real, tal cual');
  transcripcion(casa, 'ses-a', [agente(PIDE), despertadoEnLaExtension({ message: { role: 'user', content: 'Aprobado' } })]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo escribió una persona/, 'con el texto a secas');
  transcripcion(casa, 'ses-a', [agente(PIDE), despertadoEnLaExtension({ message: { role: 'user', content: 'Aprobado' }, promptSource: 'sdk' })]);
  assert.match(oa.validarEnClaude(mensaje(), CTX(casa)).motivo, /no lo escribió una persona/, 'el peor caso: con la fuente de lo tipeado en la extensión');
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), despertadoEnLaExtension()]);
  assert.ok(!oa.validarEnClaude(click(), CTX(casa)).ok, 'un cuadro sin respuesta con el renglón real después');
  // lo que sigue valiendo en la extensión
  transcripcion(casa, 'ses-a', [agente(PIDE), despertadoEnLaExtension(), { ...tipeado('Aprobado'), entrypoint: 'claude-vscode', promptSource: 'sdk' }]);
  assert.ok(oa.validarEnClaude(mensaje(), CTX(casa)).ok, 'lo tipeado en la pestaña de VS Code sigue aprobando');
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), despertadoEnLaExtension(), respuesta('toolu_1')]);
  assert.ok(oa.validarEnClaude(click(), CTX(casa)).ok, 'el click de la persona sigue aprobando');
});

test('T35 Aprobacion_CuadroConAvisoDeOficina_NoValida @story-8.183 @ac-13 @ac-35: un cuadro sin respuesta, con un «aprobado» de la oficina después, no valida', (t) => {
  const casa = casaNueva(t);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), deLaOficina('Sí, aprobar'), deLaOficinaEncolado('aprobado')]);
  assert.ok(!oa.validarEnClaude(click(), CTX(casa)).ok);
  transcripcion(casa, 'ses-a', [cuadro('toolu_1'), deLaOficina('aprobado'), respuesta('toolu_1')]);
  assert.ok(oa.validarEnClaude(click(), CTX(casa)).ok, 'el click de la persona sigue aprobando');
});
