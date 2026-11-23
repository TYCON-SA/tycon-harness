'use strict';
/**
 * background-question-guard.test.js — una sesión que abrió la coordinadora (`coordination.js open`) no le pregunta a la
 * persona: con la coordinadora confirmada y viva, el freno le niega el cuadro de opciones y el dictado, y le dice qué
 * mandarle. Todo con una casa de juguete: nada lee la casa real.
 * stable-data: las horas son fijas; ninguna prueba depende del día.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const GANCHO = path.join(RAIZ, 'scripts', 'hooks', 'background-question-guard.js');
const G = require(GANCHO);
const C = require('../tools/coordination.js');
const DS = require('../lib/delegated-signing.js');
const oa = require('../lib/owner-approvals.js');
const ow = require('../lib/owner-window.js');
const { harnessCopy } = require('./lib/harness-copy.js');
const { stateDir } = require(path.join(RAIZ,'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const AT = Date.parse('2026-11-04T23:03:39.000Z');
const COORD = 'ses-coord';
const LANZADA = 'ses-acme1';
const PERFIL = { approvals: { relay_session: 'coordinadora' } };
/** El gancho como proceso: corre desde una copia del arnés con el perfil del equipo en su árbol. */
function ganchoConPerfil() {
  const copia = harnessCopy();
  fs.writeFileSync(path.join(copia, 'team-profile.json'), JSON.stringify(PERFIL));
  return path.join(copia, 'scripts', 'hooks', 'background-question-guard.js');
}

function casaNueva(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-question-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const casa = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(casa, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir(casa), 'coordination'), { recursive: true });
  const carpeta = path.join(raiz, 'puesto-1');
  fs.mkdirSync(carpeta);
  // el perfil del equipo, en el árbol del arnés: sin approvals.relay_session no hay coordinadora confirmada
  const arnes = path.join(raiz, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'team-profile.json'), JSON.stringify(PERFIL));
  return { raiz, casa, carpeta, arnes };
}

/** Un archivo de sesión como lo escribe Claude Code: viva con este pid; muerta con uno que no existe. */
function sesion(toy, sid, { nombre, viva = true, ...extra } = {}) {
  fs.writeFileSync(path.join(toy.casa, '.claude', 'sessions', `${sid}.json`), JSON.stringify({
    pid: viva ? process.pid : 999999, sessionId: sid, name: nombre || sid, nameSource: 'peer', status: 'busy', cwd: toy.carpeta, ...extra,
  }));
}

function designar(toy, sid = COORD, { confirmada = true } = {}) {
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-11-04T20:00:00.000Z', sesion: sid, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  const lineas = [d, ...(confirmada ? [DS.confirmationRecord(d, '2026-11-04T20:01:00.000Z')] : [])];
  fs.writeFileSync(path.join(stateDir(toy.casa), 'gates.log'), `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const lanzadas = (toy, renglones) => fs.writeFileSync(C.launchedFile(toy.casa), JSON.stringify(renglones));

/** La máquina del caso: la coordinadora confirmada y viva, y «Acme1» abierta por `open` hace un rato. */
function maquina(t, { startedAt = AT + 7000, conRenglon = true } = {}) {
  const toy = casaNueva(t);
  designar(toy);
  sesion(toy, COORD, { nombre: 'Coordinadora', kind: 'interactive', cwd: toy.raiz });
  sesion(toy, LANZADA, { nombre: 'Acme1', kind: 'bg', startedAt });
  if (conRenglon) lanzadas(toy, [{ name: 'Acme1', cwd: toy.carpeta, at: AT, por: COORD }]);
  return toy;
}

const pregunta = (texto = '¿Aprobás el plan de la tanda C?') => ({ questions: [{ question: texto, header: 'Plan', multiSelect: false, options: [{ label: 'Sí', description: 'a' }, { label: 'No', description: 'b' }] }] });
const evento = (sid, tool_name = 'AskUserQuestion', tool_input = pregunta()) => ({ hook_event_name: 'PreToolUse', session_id: sid, tool_name, tool_input, cwd: '/r' });
const decidir = (toy, ev, env = {}) => G.decidir(ev, { home: toy.casa, env, arnes: toy.arnes });

test('T1 Lanzada_AskUserQuestion_SeNiega @story-8.211 @ac-1', (t) => {
  const toy = maquina(t);
  const r = decidir(toy, evento(LANZADA));
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
  assert.match(r.reason, /Coordinadora/);
  assert.match(r.reason, new RegExp(COORD));
  assert.match(r.reason, /SendMessage/);
  assert.match(r.reason, /tres renglones/);
  assert.match(r.reason, /ruta/);
  // el gancho como proceso: la negativa sale como decisión de la herramienta
  const p = spawnSync(process.execPath, [ganchoConPerfil()], { input: JSON.stringify(evento(LANZADA)), encoding: 'utf8', env: { ...process.env, HOME: toy.casa, USERPROFILE: toy.casa, TYCON_BG_QUESTION_GUARD: '' } });
  assert.strictEqual(p.status, 0, p.stderr);
  const out = JSON.parse(p.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /SendMessage/);
});

test('T2 Lanzada_DictadoSeNiega_ExitPlanModePasa @story-8.211 @ac-2', (t) => {
  const toy = maquina(t);
  assert.strictEqual(decidir(toy, evento(LANZADA, 'mcp__spokenly__ask_user_dictation', { question: '¿Seguimos?' })).decision, 'deny');
  assert.strictEqual(decidir(toy, evento(LANZADA, 'ExitPlanMode', { plan: '# plan' })), null);
  const lenta = maquina(t, { startedAt: AT + C.LAUNCH_TIMEOUT_MS + 30000 });
  assert.strictEqual(decidir(lenta, evento(LANZADA)).decision, 'deny', 'un lanzador lento se reconoce igual');
});

test('T3 Lanzada_PreguntaDeFirma_TalCual @story-8.211 @ac-3', (t) => {
  const toy = maquina(t);
  const plan = decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿Aprobás aprobar el plan? (firma plan-approval · sesión ${LANZADA} · código fabb4d5f)`)));
  assert.strictEqual(plan.decision, 'deny');
  assert.match(plan.reason, /tal cual/);
  assert.doesNotMatch(plan.reason, /terminal/);
  const cupo = decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿Pasás el tope? (firma adhoc-lane:sobre-cupo · sesión ${LANZADA} · código 0a1b2c3d)`)));
  assert.strictEqual(cupo.decision, 'deny');
  assert.match(cupo.reason, /tal cual/);
});

// Nombrar o retirar a la coordinadora sólo lo aprueba un click en la pestaña que trabaja. Una coordinadora nueva que
// abrió la vieja con `open` (15/11) no podía mostrar ese cuadro y quedaba sólo la terminal: ahora lo muestra en su
// pestaña, donde lo contesta el dueño (o por control remoto). La terminal sigue como salida de emergencia.
test('T27 BgGuard_SoloClickDeLaPropiaSesion_Pasa — el cuadro de nombrar la coordinadora se muestra en su pestaña', (t) => {
  const toy = maquina(t);
  const propia = decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿Nombrás coordinadora a esta sesión? (firma designation-set · sesión ${LANZADA} · código 1a2b3c4d)`)));
  assert.strictEqual(propia, null, JSON.stringify(propia));
  assert.strictEqual(decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿La retirás? (firma designation-withdraw · sesión ${LANZADA} · código 1a2b3c4e)`))), null);
  // el sello de otra sesión, una firma que no es de sólo click o una pregunta libre siguen yendo a la coordinadora
  assert.strictEqual(decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿Nombrás coordinadora? (firma designation-set · sesión ses-otra · código 1a2b3c4d)`))).decision, 'deny');
  assert.strictEqual(decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿Aprobás el plan? (firma plan-approval · sesión ${LANZADA} · código fabb4d5f)`))).decision, 'deny');
  assert.strictEqual(decidir(toy, evento(LANZADA)).decision, 'deny');
  // con otra pregunta en el mismo cuadro, o dos sellos en una, va a la coordinadora (lo encontró el pase adversarial)
  const dos = { questions: [pregunta(`¿Nombrás coordinadora? (firma designation-set · sesión ${LANZADA} · código 1a2b3c4d)`).questions[0],
    pregunta(`¿Aprobás el plan? (firma plan-approval · sesión ${LANZADA} · código fabb4d5f)`).questions[0]] };
  assert.strictEqual(decidir(toy, evento(LANZADA, 'AskUserQuestion', dos)).decision, 'deny');
  assert.strictEqual(decidir(toy, evento(LANZADA, 'AskUserQuestion', pregunta(`¿Nombrás? (firma designation-set · sesión ${LANZADA} · código 1a2b3c4d) ¿Y el plan? (firma plan-approval · sesión ${LANZADA} · código fabb4d5f)`))).decision, 'deny');
  // la negativa del freno de firmas lo dice: el cuadro va en esta pestaña, se avisa a la coordinadora y queda la terminal
  const cuadro = oa.cuadroDe({ firma: 'designation-set', destino: LANZADA, que: 'nombrar coordinadora', siSaleMal: 'x', huella: '1a2b3c4d',
    soloClick: true, descripciones: ['Esa sesión firma en tu nombre.', 'No cambia nada.'] });
  const r = ow.negarSinVentana('esta sesión corre de fondo', ['designation-set'], LANZADA, cuadro, true, false, { name: 'Coordinadora', sid: COORD });
  assert.match(r.texto, /mostrale AskUserQuestion/);
  assert.match(r.texto, /SendMessage/);
  assert.match(r.texto, /Coordinadora/);
  assert.match(r.texto, /control remoto/);
  assert.match(r.texto, /--terminal/);
});

test('T4 NoLanzada_Pasa @story-8.211 @ac-4', (t) => {
  const toy = maquina(t);
  sesion(toy, 'ses-interactiva', { nombre: 'Acme1', kind: 'interactive', startedAt: AT + 7000 });
  assert.strictEqual(decidir(toy, evento('ses-interactiva')), null, 'una pestaña interactiva pregunta');
  sesion(toy, 'ses-a-mano', { nombre: 'Acme2', kind: 'bg', startedAt: AT + 7000 });
  assert.strictEqual(decidir(toy, evento('ses-a-mano')), null, 'una de fondo abierta a mano pregunta');
});

// Producto A: una sesión que abrió la coordinadora quedó quieta con su pregunta negada y la coordinadora sin enterarse
const MIN = 60000;
test('T20 Lanzada_CoordinadoraQueNoResuelveLaPregunta_ALosNMinutosLeLlegaALaPersona', (t) => {
  const toy = maquina(t);
  const en = (ahora, texto) => G.decidir(evento(LANZADA, 'AskUserQuestion', pregunta(texto)), { home: toy.casa, env: {}, arnes: toy.arnes, ahora });
  assert.strictEqual(en(AT).decision, 'deny', 'la primera vez va a la coordinadora');
  const relevos = () => C.questionRelays(toy.casa);
  assert.strictEqual(relevos().length, 1, 'el freno anota la pregunta que le mandó');
  assert.match(en(AT).reason, /10 min/, 'y le dice a la sesión cuánto espera');
  assert.strictEqual(en(AT + 9 * MIN).decision, 'deny', 'dentro de los 10 minutos, la espera');
  assert.strictEqual(relevos().length, 1, 'la misma espera no se anota dos veces');
  assert.strictEqual(en(AT + 11 * MIN), null, 'la misma pregunta, sin resolver: le llega a la persona');
  assert.strictEqual(en(AT + 12 * MIN), null, 'y si la repite, también');
  // una pregunta nueva tiene su propio plazo: que la coordinadora no resolviera una no le quita las demás
  assert.strictEqual(en(AT + 30 * MIN, '¿Seguimos con la tanda D?').decision, 'deny', 'la nueva va a la coordinadora');
  assert.strictEqual(en(AT + 35 * MIN, '¿Seguimos con la tanda D?').decision, 'deny', 'con su plazo');
  assert.strictEqual(en(AT + 41 * MIN, '¿Seguimos con la tanda D?'), null, 'vencido su plazo, a la persona');
});

test('T20b Lanzada_CoordinadoraQueContesto_LaPreguntaSiguienteVuelveAEsperarla', (t) => {
  // la coordinadora contestó la primera y la sesión hace otra una hora después: no se saltea a la coordinadora
  const toy = maquina(t);
  const en = (ahora, texto) => G.decidir(evento(LANZADA, 'AskUserQuestion', pregunta(texto)), { home: toy.casa, env: {}, arnes: toy.arnes, ahora });
  assert.strictEqual(en(AT, '¿Aprobás el plan?').decision, 'deny');
  assert.strictEqual(en(AT + 60 * MIN, '¿Abro el pedido?').decision, 'deny');
});

test('T21 PreguntaNegada_LaCoordinadoraSeEnteraEnSuAviso', (t) => {
  const toy = maquina(t);
  G.decidir(evento(LANZADA), { home: toy.casa, env: {}, arnes: toy.arnes, ahora: AT });
  const lineas = C.questionRelayLines({ home: toy.casa }, COORD, AT + 3 * MIN);
  assert.strictEqual(lineas.length, 1, JSON.stringify(lineas));
  assert.match(lineas[0], /Acme1/);
  assert.match(lineas[0], /SendMessage|mensajes/);
  assert.match(lineas[0], /en 7 min/, 'cuánto le queda antes de que la pregunta vaya a la persona');
  assert.deepStrictEqual(C.questionRelayLines({ home: toy.casa }, 'ses-otra', AT + 3 * MIN), [], 'a otra sesión no se le avisa');
  assert.deepStrictEqual(C.questionRelayLines({ home: toy.casa }, COORD, AT + 11 * MIN), [], 'vencida y sin repetir, no la llena de avisos');
  // la que se le pasó a la persona la ve en su aviso: no pierde lo que tenía sin enterarse
  G.decidir(evento(LANZADA), { home: toy.casa, env: {}, arnes: toy.arnes, ahora: AT + 11 * MIN });
  const pasada = C.questionRelayLines({ home: toy.casa }, COORD, AT + 20 * MIN);
  assert.strictEqual(pasada.length, 1, JSON.stringify(pasada));
  assert.match(pasada[0], /directo a la persona/);
  assert.deepStrictEqual(C.questionRelayLines({ home: toy.casa }, COORD, AT + 80 * MIN), [], 'después de una hora ya no sale');
});

test('T5 SinCoordinadoraViva_Pasa @story-8.211 @ac-5', (t) => {
  const sin = maquina(t);
  fs.rmSync(path.join(stateDir(sin.casa), 'gates.log'));
  assert.strictEqual(decidir(sin, evento(LANZADA)), null, 'sin designación');
  const sinConfirmar = maquina(t);
  designar(sinConfirmar, COORD, { confirmada: false });
  assert.strictEqual(decidir(sinConfirmar, evento(LANZADA)), null, 'designada sin confirmar');
  const muerta = maquina(t);
  sesion(muerta, COORD, { nombre: 'Coordinadora', kind: 'interactive', viva: false });
  assert.strictEqual(decidir(muerta, evento(LANZADA)), null, 'con la coordinadora muerta');
  const ella = maquina(t);
  designar(ella, LANZADA);
  assert.strictEqual(decidir(ella, evento(LANZADA)), null, 'la que pregunta es la coordinadora');
});

test('T6 RenglonDeOtraSesion_Pasa @story-8.211 @ac-6', (t) => {
  const otra = maquina(t, { conRenglon: false });
  lanzadas(otra, [{ name: 'Acme1', cwd: path.join(otra.raiz, 'otra-carpeta'), at: AT, por: COORD }]);
  assert.strictEqual(decidir(otra, evento(LANZADA)), null, 'mismo nombre, otra carpeta');
  const vieja = maquina(t, { startedAt: AT + 2 * 3600000 });
  assert.strictEqual(decidir(vieja, evento(LANZADA)), null, 'mismo nombre y carpeta, arrancada dos horas después');
  // un nombre de más de 40 letras: el archivo de sesión llega recortado, y el renglón se compara recortado igual
  const largo = 'Acme'.repeat(13);
  const larga = maquina(t, { conRenglon: false });
  sesion(larga, LANZADA, { nombre: largo, kind: 'bg', startedAt: AT + 7000 });
  lanzadas(larga, [{ name: largo, cwd: larga.carpeta, at: AT, por: COORD }]);
  assert.strictEqual(decidir(larga, evento(LANZADA)).decision, 'deny', 'un nombre largo se reconoce');
});

test('T7 SinDato_AnteLaDudaFrenaSiEsDeFondo @story-8.211 @ac-7', (t) => {
  const errores = (toy) => { try { return fs.readFileSync(path.join(stateDir(toy.casa), 'hook-errors.log'), 'utf8'); } catch { return ''; } };
  // el registro roto con una sesión de fondo: ante la duda, niega, y queda anotado
  const rota = maquina(t);
  fs.writeFileSync(C.launchedFile(rota.casa), '{ no es json');
  const r = decidir(rota, evento(LANZADA));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /ante la duda/);
  assert.match(errores(rota), /background-question-guard: .*la frené/);
  // el mismo registro roto con una pestaña interactiva: pregunta como siempre, y queda anotado
  const interactiva = maquina(t);
  fs.writeFileSync(C.launchedFile(interactiva.casa), '{ no es json');
  sesion(interactiva, 'ses-tab', { nombre: 'Tab', kind: 'interactive' });
  assert.strictEqual(decidir(interactiva, evento('ses-tab')), null);
  // el archivo de la propia sesión ilegible: no se sabe si es de fondo, pregunta, y queda anotado
  const ilegible = maquina(t);
  fs.writeFileSync(path.join(ilegible.casa, '.claude', 'sessions', `${LANZADA}.json`), '{ roto');
  assert.strictEqual(decidir(ilegible, evento(LANZADA)), null);
  assert.match(errores(ilegible), /background-question-guard: .*la dejé preguntar/);
  // la designación ilegible: no hay coordinadora que se pueda confirmar, pregunta
  const sinDesignacion = maquina(t);
  fs.rmSync(path.join(stateDir(sinDesignacion.casa), 'gates.log'));
  fs.mkdirSync(path.join(stateDir(sinDesignacion.casa), 'gates.log'));
  assert.strictEqual(decidir(sinDesignacion, evento(LANZADA)), null);
  const apagado = maquina(t);
  assert.strictEqual(decidir(apagado, evento(LANZADA), { TYCON_BG_QUESTION_GUARD: '0' }), null);
});

test('T8 OtraHerramienta_NoHaceNada @story-8.211 @ac-8', (t) => {
  const toy = maquina(t);
  assert.strictEqual(decidir(toy, evento(LANZADA, 'Bash', { command: 'ls' })), null);
  assert.strictEqual(decidir(toy, { ...evento(LANZADA), hook_event_name: 'PostToolUse' }), null, 'otro momento');
  assert.strictEqual(decidir(toy, { ...evento(LANZADA), session_id: '../x' }), null, 'una sesión que no se puede leer');
  assert.strictEqual(decidir(toy, { ...evento(LANZADA), session_id: undefined }), null, 'sin sesión');
  const roto = spawnSync(process.execPath, [GANCHO], { input: '{ no es json', encoding: 'utf8', env: { ...process.env, HOME: toy.casa, USERPROFILE: toy.casa } });
  assert.strictEqual(roto.status, 0);
  assert.strictEqual(roto.stdout, '');
  const p = spawnSync(process.execPath, [GANCHO], { input: JSON.stringify(evento(LANZADA, 'Bash', { command: 'ls' })), encoding: 'utf8', env: { ...process.env, HOME: toy.casa, USERPROFILE: toy.casa } });
  assert.strictEqual(p.status, 0);
  assert.strictEqual(p.stdout, '');
});

test('T10 FirmaEnLanzada_TextoALaCoordinadora @story-8.211 @ac-12', (t) => {
  // el cuadro como lo arma el guion de las firmas
  const cuadro = oa.cuadroDe({ firma: 'plan-approval', destino: 's', que: 'aprobar el plan', detalle: 'la cita: «x»', siSaleMal: 'se rehace', huella: 'abcd1234' });
  const coord = { name: 'Coordinadora', sid: COORD };
  // varias firmas, o un cuadro que no se pudo armar: también a la coordinadora, sin «mostrale»
  for (const [ids, c] of [[['plan-approval', 'save'], cuadro], [['plan-approval'], { error: 'no se pudo' }], [['plan-approval'], null]]) {
    const r = ow.negarSinVentana('esta sesión corre de fondo', ids, 's', c, true, false, coord);
    assert.match(r.texto, /SendMessage/, JSON.stringify(ids));
    assert.doesNotMatch(r.texto, /mostrale AskUserQuestion/);
  }
  // la cadena entera: la sesión lanzada, con la coordinadora viva, da la coordinadora; otra, nada
  const toy = maquina(t);
  assert.deepStrictEqual(G.coordinadoraDeLaLanzada({ home: toy.casa, sid: LANZADA, arnes: toy.arnes }), { name: 'Coordinadora', sid: COORD, duda: false });
  sesion(toy, 'ses-otra', { nombre: 'Otra', kind: 'bg', startedAt: AT + 7000 });
  assert.strictEqual(G.coordinadoraDeLaLanzada({ home: toy.casa, sid: 'ses-otra', arnes: toy.arnes }), null);
  assert.strictEqual(G.coordinadoraDeLaLanzada({ home: toy.casa, sid: COORD, arnes: toy.arnes }), null);
  // sin approvals.relay_session en el perfil no hay coordinadora confirmada: la lanzada pregunta como siempre
  fs.writeFileSync(path.join(toy.arnes, 'team-profile.json'), JSON.stringify({ approvals: {} }));
  assert.strictEqual(G.coordinadoraDeLaLanzada({ home: toy.casa, sid: LANZADA, arnes: toy.arnes }), null, 'sin la clave del perfil');
  fs.writeFileSync(path.join(toy.arnes, 'team-profile.json'), JSON.stringify(PERFIL));
  const lanzada = ow.negarSinVentana('esta sesión corre de fondo', ['plan-approval'], 's', cuadro, true, false, coord);
  assert.match(lanzada.texto, /SendMessage/);
  assert.match(lanzada.texto, /Coordinadora/);
  assert.match(lanzada.texto, new RegExp(cuadro.pregunta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(lanzada.texto, /mostrale AskUserQuestion/);
  const anotada = ow.negarSinVentana('esta sesión corre de fondo', ['plan-approval'], 's', cuadro, true, true, coord);
  assert.match(anotada.texto, /ya quedó anotado/);
  const deHoy = ow.negarSinVentana('esta sesión corre de fondo', ['plan-approval'], 's', cuadro, true, false, null);
  assert.match(deHoy.texto, /mostrale AskUserQuestion/);
  const cupo = { ...cuadro, soloClick: true, descripciones: ['sigue', 'no sigue'] };
  // una de sólo click se muestra en la pestaña que trabaja, y la coordinadora se entera (T27)
  const soloClick = ow.negarSinVentana('pasar el tope', ['adhoc-lane:sobre-cupo'], 's', cupo, true, false, coord);
  assert.match(soloClick.texto, /terminal/);
  assert.match(soloClick.texto, /Coordinadora/);
  assert.match(soloClick.texto, /mostrale AskUserQuestion/);
});

test('T11 ClickEnLaCoordinadora_SigueValiendo @story-8.211 @ac-13', (t) => {
  const toy = casaNueva(t);
  const cfg = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion|mcp__spokenly__ask_user_dictation', hooks: [{ type: 'command', command: `node "${GANCHO}"` }] }] } };
  fs.writeFileSync(path.join(toy.casa, '.claude', 'settings.json'), JSON.stringify(cfg));
  assert.ok(oa.esPermitido(`node "${GANCHO}"`));
  assert.ok(oa.esPermitido('@tcg:background-question-guard.js'));
  assert.deepStrictEqual(oa.escuchasDelCuadro({ casa: toy.casa, cwd: toy.casa, plataforma: 'linux' }).ajenos, []);
});

// ── Una sesión de fondo no queda trabada en un pedido de permiso de Claude Code ────────────────────────────────────
// Medido en sesiones de fondo reales (sin permisos, sin ganchos): el chequeo de borrados de Claude Code pide permiso a una
// persona por un `rm` cuyo destino no puede revisar, y nadie lo contesta. El caso (a) es el comando que dejó trabada una
// sesión el 20/11 (de una transcripción, con las rutas cambiadas); el (b), la forma que se sospechó del otro caso: un
// `cd` a una copia en el TMPDIR con python, que medido no pide permiso y no se toca.
const TMP = '/var/folders/zz/acme/T';
const CASO_A = `T=${TMP}/armed-tree/tree; O=/srv/acme/.claude/jobs/abc/tmp/rojos; cd $T && for s in a.test.sh b.test.js; do `
  + 'H=$(mktemp -d "${TMPDIR:-/tmp}/casa-rojo.XXXXXX"); case $s in *.sh) r=bash;; *) r="node --test";; esac; '
  + 'env -u TYCON_HOME HOME=$H USERPROFILE=$H bash -c "$r scripts/tests/$s" > $O/$s.log 2>&1; echo "$s rc=$?"; rm -rf $H; done';
const CASO_B = `cd ${TMP}/copia && python3 - <<'EOF'\nprint(1)\nEOF`;
const B = require('../lib/bg-permission-shapes.js');

test('T12 Fondo_BorradoQuePidePermiso_SeNiegaConComoReescribirlo — caso (a)', (t) => {
  const toy = maquina(t);
  const r = decidir(toy, evento(LANZADA, 'Bash', { command: CASO_A }));
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
  assert.strictEqual(r.forma, 'sustitucion');
  assert.match(r.reason, /corre de fondo/);
  assert.match(r.reason, /ruta literal y absoluta/);
  // en una sesión que no es de fondo, nada cambia
  assert.strictEqual(decidir(toy, evento(COORD, 'Bash', { command: CASO_A })), null);
  // el gancho como proceso: niega con el texto
  const p = spawnSync(process.execPath, [GANCHO], { input: JSON.stringify(evento(LANZADA, 'Bash', { command: CASO_A })), encoding: 'utf8', env: { ...process.env, HOME: toy.casa, USERPROFILE: toy.casa, TYCON_BG_QUESTION_GUARD: '' } });
  assert.strictEqual(p.status, 0, p.stderr);
  assert.match(p.stdout, /"permissionDecision":"deny"/);
});

test('T13 Fondo_LoQueHoyPasa_SiguePasando — caso (b) y las formas medidas', (t) => {
  const toy = maquina(t);
  for (const command of [CASO_B, `H=${TMP}/sub; rm -rf $H`, `rm -rf ${TMP}/sub`, `cd ${TMP} && rm -rf sub`, `for d in ${TMP}/sub; do rm -rf $d; done`,
    `rm -rf ${TMP}/sub/*`, `bash -c 'echo hola'; rm -rf ${TMP}/sub`, 'grep -n "rm -rf" a.sh', 'ls']) {
    assert.strictEqual(decidir(toy, evento(LANZADA, 'Bash', { command })), null, command);
  }
});

test('T14 Formas_LasQueFrenoElChequeo — cada forma medida, y el interruptor', (t) => {
  const tmpdir = TMP;
  assert.strictEqual(B.formaQuePidePermiso('rm -rf "$(echo /x/sub)"', { tmpdir }).forma, 'sustitucion');
  assert.strictEqual(B.formaQuePidePermiso('H=$(mktemp -d /private/tmp/m.XXXX) && rm -rf $H', { tmpdir }).forma, 'sustitucion');
  assert.strictEqual(B.formaQuePidePermiso('S=/private/tmp/x; rm -f $S/*.png', { tmpdir }).forma, 'variable-con-comodin');
  assert.strictEqual(B.formaQuePidePermiso('rm -rf /srv/acme/SourceCode/repo/tmpd/*', { tmpdir }).forma, 'comodin-fuera-de-temporal');
  assert.strictEqual(B.formaQuePidePermiso(`r=echo; bash -c "$r hola"; rm -rf ${TMP}/sub`, { tmpdir }).forma, 'bash-c-armado');
  const toy = maquina(t);
  assert.strictEqual(decidir(toy, evento(LANZADA, 'Bash', { command: CASO_A }), { TYCON_BG_QUESTION_GUARD: '0' }), null, 'apagado');
});

test('T15 Fondo_SinArchivoDeSesion_LaVariableDeClaude — CLAUDE_JOB_DIR', (t) => {
  const toy = maquina(t);
  assert.strictEqual(decidir(toy, evento('ses-sin-archivo', 'Bash', { command: CASO_A })), null, 'sin archivo ni variable');
  const r = decidir(toy, evento('ses-sin-archivo', 'Bash', { command: CASO_A }), { CLAUDE_JOB_DIR: '/x/jobs/abc' });
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
});

/** Una configuración administrada de juguete: su archivo y los de `managed-settings.d/`, con estas reglas «ask». */
function administrada(toy, { ask = [], enCarpeta = [], copia = [] } = {}) {
  const dir = path.join(toy.raiz, 'administrada');
  fs.mkdirSync(path.join(dir, 'managed-settings.d'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify({ permissions: { ask } }));
  fs.writeFileSync(path.join(dir, 'managed-settings.d', 'tycon-production.json'), JSON.stringify({ permissions: { ask: enCarpeta } }));
  fs.writeFileSync(path.join(dir, 'managed-settings.d', 'tycon-production.json.bak-1'), JSON.stringify({ permissions: { ask: copia } }));
  return dir;
}
const REGLAS_DEL_FRENO = ['Bash(az sql server firewall-rule *)', 'Edit(//**/.tycon/production.json)', 'Write(//**/.tycon/state/production-firewall.json)'];

test('T28 Fondo_EdicionQuePidePermiso_SeNiegaConMotivo — fila 91', (t) => {
  const toy = maquina(t);
  const dir = administrada(toy, { enCarpeta: REGLAS_DEL_FRENO });
  const catalogo = path.join(toy.raiz, 'probe', 'repos', 'b', '.tycon', 'production.json');
  for (const [tool, tool_input] of [['Write', { file_path: catalogo, content: '{}' }], ['Edit', { file_path: catalogo, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: catalogo, edits: [] }], ['NotebookEdit', { notebook_path: path.join(toy.casa, '.tycon', 'state', 'production-firewall.json') }]]) {
    const r = G.decidir(evento(LANZADA, tool, tool_input), { home: toy.casa, env: {}, arnes: toy.arnes, administrada: dir });
    assert.ok(r && r.decision === 'deny', `${tool}: ${JSON.stringify(r)}`);
    assert.match(r.reason, /pide permiso/, tool);
    assert.match(r.reason, /corre de fondo/, tool);
    assert.match(r.reason, /coordinadora/, tool);
  }
  // en una sesión que no es de fondo, la regla pregunta como siempre
  assert.strictEqual(G.decidir(evento(COORD, 'Write', { file_path: catalogo, content: '{}' }), { home: toy.casa, env: {}, arnes: toy.arnes, administrada: dir }), null);
});

test('T29 Fondo_EdicionSinReglaQuePregunte_Pasa — fila 91', (t) => {
  const toy = maquina(t);
  const catalogo = path.join(toy.raiz, 'probe', 'repos', 'b', '.tycon', 'production.json');
  const otro = path.join(toy.raiz, 'probe', 'notas.md');
  const conReglas = administrada(toy, { ask: ['Edit(//**/.tycon/production.json)'], copia: ['Edit(//**/notas.md)'] });
  const d = (ruta, dir) => G.decidir(evento(LANZADA, 'Write', { file_path: ruta, content: 'x' }), { home: toy.casa, env: {}, arnes: toy.arnes, administrada: dir });
  // la regla del archivo de la configuración administrada también cuenta
  assert.ok(d(catalogo, conReglas), 'la regla de managed-settings.json');
  // una ruta que ninguna regla nombra; una copia con otro final no se carga, como en Claude Code
  assert.strictEqual(d(otro, conReglas), null);
  // sin configuración administrada no hay nada que pregunte
  assert.strictEqual(d(catalogo, path.join(toy.raiz, 'no-existe')), null);
  // el interruptor
  assert.strictEqual(G.decidir(evento(LANZADA, 'Write', { file_path: catalogo, content: 'x' }), { home: toy.casa, env: { TYCON_BG_QUESTION_GUARD: '0' }, arnes: toy.arnes, administrada: conReglas }), null);
});

test('T16 Formas_LoQueEncontroElPase — sin comillas, guiones literales, heredocs y textos largos', (t) => {
  const tmpdir = TMP;
  for (const c of ['rm -rf $(pwd)/x', 'rm -rf $(mktemp -d)', 'rm -rf `pwd`/x', 'rm -rf $(git rev-parse --show-toplevel)/dist', '\\rm -rf "$(pwd)"', 'nice rm -rf $(pwd)/x']) {
    assert.strictEqual((B.formaQuePidePermiso(c, { tmpdir }) || {}).forma, 'sustitucion', c);
  }
  for (const c of ["bash -c 'cd $HOME && ls'; rm /tmp/a.txt", 'git rm $(git ls-files -d)', 'echo "rm -rf $(pwd)"', 'rmdir "$(pwd)/x"',
    "cat <<EOF > /tmp/a.sh\nrm -rf $(pwd)/*\nEOF", 'rm -f *.log', 'docker rm $(docker ps -aq)', 'rm "file[1].txt"']) {
    assert.strictEqual(B.formaQuePidePermiso(c, { tmpdir }), null, c);
  }
  // un texto largo pegado: en una sesión que no es de fondo ni se mira, y de fondo se lee rápido
  const largo = `cat <<'EOF' > /tmp/x\n${'linea con $(algo) y rm adentro\n'.repeat(1300)}EOF\nrm -rf /tmp/x`;
  const toy = maquina(t);
  let t0 = process.hrtime.bigint();
  assert.strictEqual(decidir(toy, evento(COORD, 'Bash', { command: largo })), null);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100, 'sesión normal');
  t0 = process.hrtime.bigint();
  assert.strictEqual(decidir(toy, evento(LANZADA, 'Bash', { command: largo })), null);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100, 'sesión de fondo');
});

// ── los mensajes a una sesión de fondo: se mira el destino (`to`), no la sesión que llama ─────────────────────────────
const OTRA = 'ses-otra-pestana';
const mensaje = (sid, to = 'Acme1') => evento(sid, 'SendMessage', { to, message: '¿cómo vas?', summary: 'pregunta' });
const erroresDe = (toy) => { try { return fs.readFileSync(path.join(stateDir(toy.casa), 'hook-errors.log'), 'utf8'); } catch { return ''; } };
/** La máquina del caso con una pestaña más, que no es la coordinadora ni la lanzada. */
function maquinaConOtra(t, opts) {
  const toy = maquina(t, opts);
  sesion(toy, OTRA, { nombre: 'Otra pestaña', kind: 'interactive', cwd: toy.raiz });
  return toy;
}

test('T17 BgGuard_MensajeDeOtraSesionAUnaDeFondo_Niega @story-8.232 @ac-9', (t) => {
  const toy = maquinaConOtra(t);
  const r = decidir(toy, mensaje(OTRA));
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
  assert.match(r.reason, /Esa sesión trabaja de fondo: mandáselo a la coordinadora, que se lo pasa\./);
  assert.match(r.reason, /Coordinadora/);
  assert.match(r.reason, new RegExp(COORD));
  assert.doesNotMatch(r.reason, /tres renglones/, 'no es el texto de las preguntas');
  // el gancho como proceso
  const p = spawnSync(process.execPath, [ganchoConPerfil()], { input: JSON.stringify(mensaje(OTRA)), encoding: 'utf8', env: { ...process.env, HOME: toy.casa, USERPROFILE: toy.casa, TYCON_BG_QUESTION_GUARD: '' } });
  assert.strictEqual(p.status, 0, p.stderr);
  const out = JSON.parse(p.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /mandáselo a la coordinadora/);
  // apagado, pasa
  assert.strictEqual(decidir(toy, mensaje(OTRA), { TYCON_BG_QUESTION_GUARD: '0' }), null);
});

test('T18 BgGuard_MensajeDeLaCoordinadora_Pasa @story-8.232 @ac-10', (t) => {
  const toy = maquinaConOtra(t);
  assert.strictEqual(decidir(toy, mensaje(COORD)), null, 'la coordinadora le escribe');
  assert.strictEqual(decidir(toy, mensaje(OTRA)).decision, 'deny', 'el mismo mensaje de otra sesión se niega');
  // la lanzada le contesta a la coordinadora: el destino no es de fondo lanzado
  assert.strictEqual(decidir(toy, mensaje(LANZADA, 'Coordinadora')), null);
});

test('T19 BgGuard_MensajeAUnaConPersona_Pasa @story-8.232 @ac-11', (t) => {
  const sinRenglon = maquinaConOtra(t, { conRenglon: false });
  assert.strictEqual(decidir(sinRenglon, mensaje(OTRA)), null, 'fuera del registro de las lanzadas');
  const conRenglon = maquinaConOtra(t);
  assert.strictEqual(decidir(conRenglon, mensaje(OTRA)).decision, 'deny', 'con su renglón se niega');
  // una pestaña interactiva con nombre de lanzada no es de fondo
  const interactiva = maquinaConOtra(t);
  sesion(interactiva, LANZADA, { nombre: 'Acme1', kind: 'interactive', startedAt: AT + 7000 });
  assert.strictEqual(decidir(interactiva, mensaje(OTRA)), null);
  // sin coordinadora viva, nadie frena
  const sinCoord = maquinaConOtra(t);
  sesion(sinCoord, COORD, { nombre: 'Coordinadora', kind: 'interactive', viva: false });
  assert.strictEqual(decidir(sinCoord, mensaje(OTRA)), null);
});

test('T20 BgGuard_NombreSinResolverAmbiguoDifusionEIlegible @story-8.232 @ac-12', (t) => {
  // (a) un nombre que no es ninguna sesión: pasa y queda anotado; `main` y un ayudante pasan sin anotar
  const sinNombre = maquinaConOtra(t);
  assert.strictEqual(decidir(sinNombre, mensaje(OTRA, 'Nadie')), null);
  assert.match(erroresDe(sinNombre), /background-question-guard: .*«Nadie».*ninguna sesión/);
  const ayudantes = maquinaConOtra(t);
  assert.strictEqual(decidir(ayudantes, mensaje(OTRA, 'main')), null);
  assert.strictEqual(decidir(ayudantes, mensaje(OTRA, 'a2a28ee7ed3ab0450')), null);
  assert.strictEqual(erroresDe(ayudantes), '');
  // (b) un nombre de dos sesiones, una de fondo lanzada: niega
  const ambiguo = maquinaConOtra(t);
  sesion(ambiguo, 'ses-gemela', { nombre: 'Acme1', kind: 'interactive', cwd: ambiguo.raiz });
  assert.strictEqual(decidir(ambiguo, mensaje(OTRA)).decision, 'deny');
  // (c) la difusión con una lanzada viva: niega; sin lanzadas, pasa
  assert.strictEqual(decidir(maquinaConOtra(t), mensaje(OTRA, '*')).decision, 'deny');
  assert.strictEqual(decidir(maquinaConOtra(t, { conRenglon: false }), mensaje(OTRA, '*')), null);
  // (d) el registro de las lanzadas ilegible y el destino de fondo: ante la duda, niega
  const rota = maquinaConOtra(t);
  fs.writeFileSync(C.launchedFile(rota.casa), '{ no es json');
  const r = decidir(rota, mensaje(OTRA));
  assert.strictEqual(r.decision, 'deny');
  assert.match(r.reason, /ante la duda/);
  // las otras formas del destino: el nombre con su referencia y la dirección de respuesta
  const formas = maquinaConOtra(t);
  sesion(formas, LANZADA, { nombre: 'Acme1', kind: 'bg', startedAt: AT + 7000, messagingSocketPath: '/tmp/cc-socks/4242.sock' });
  assert.strictEqual(decidir(formas, mensaje(OTRA, 'Acme1 [6f2349]')).decision, 'deny');
  assert.strictEqual(decidir(formas, mensaje(OTRA, 'uds:/tmp/cc-socks/4242.sock')).decision, 'deny');
  assert.strictEqual(decidir(formas, mensaje(OTRA, 'uds:/tmp/cc-socks/9999.sock')), null);
  // un nombre de más de 40 letras: se compara entero, no recortado
  const largo = 'Acme'.repeat(13);
  const larga = maquinaConOtra(t, { conRenglon: false });
  sesion(larga, LANZADA, { nombre: largo, kind: 'bg', startedAt: AT + 7000 });
  lanzadas(larga, [{ name: largo, cwd: larga.carpeta, at: AT, por: COORD }]);
  assert.strictEqual(decidir(larga, mensaje(OTRA, largo)).decision, 'deny', 'el nombre largo entero resuelve');
  assert.strictEqual(decidir(larga, mensaje(OTRA, largo.slice(0, 40))), null, 'el recortado no es su nombre');
});

test('T21 BgGuard_ArchivosDeSesionRaros_NoResuelvenDestino @story-8.232 @ac-12', (t) => {
  // una lanzada muerta no recibe el mensaje: no es destino
  const muerta = maquinaConOtra(t);
  sesion(muerta, LANZADA, { nombre: 'Acme1', kind: 'bg', startedAt: AT + 7000, viva: false });
  assert.strictEqual(decidir(muerta, mensaje(OTRA)), null);
  // un pid que no es un número entero positivo, o un sessionId que no es texto, tampoco
  for (const extra of [{ pid: 0 }, { pid: 'x' }, { sessionId: 42 }]) {
    const rara = maquinaConOtra(t);
    fs.writeFileSync(path.join(rara.casa, '.claude', 'sessions', `${LANZADA}.json`), JSON.stringify({
      pid: process.pid, sessionId: LANZADA, name: 'Acme1', kind: 'bg', startedAt: AT + 7000, cwd: rara.carpeta, ...extra,
    }));
    assert.strictEqual(decidir(rara, mensaje(OTRA)), null, JSON.stringify(extra));
  }
  // un archivo de sesión ilegible se salta y se nombra cuando el mensaje no va a ninguna sesión
  const rota = maquinaConOtra(t);
  fs.writeFileSync(path.join(rota.casa, '.claude', 'sessions', 'roto.json'), '{ no es json');
  assert.strictEqual(decidir(rota, mensaje(OTRA)).decision, 'deny', 'el roto no tapa a la lanzada');
  // con un archivo ilegible, un destino que no resuelve puede ser justo esa sesión: ante la duda, niega
  const r = decidir(rota, mensaje(OTRA, 'Nadie'));
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
  assert.match(r.reason, /ante la duda/);
  assert.match(erroresDe(rota), /«Nadie».*\(roto\.json: /);
  // a la conversación principal o a un ayudante, nunca
  assert.strictEqual(decidir(rota, mensaje(OTRA, 'main')), null);
});

// ── lo que encontró el pase adversarial: las formas del destino que Claude Code entrega, el registro y las fallas ─────
test('T22 BgGuard_FormasDelDestinoQueClaudeEntrega_Niegan @story-8.232 @ac-9 @ac-12', (t) => {
  const toy = maquinaConOtra(t);
  sesion(toy, LANZADA, { nombre: 'Acme1', kind: 'bg', startedAt: AT + 7000, messagingSocketPath: '/tmp/cc-socks/2 x.sock', bridgeSessionId: 'session_ABC' });
  for (const to of ['acme1 [6f2349]', 'ACME1 [6f2349]', 'Acme1[6f2349]', ' Acme1 ', 'acme1', 'uds:/tmp/cc-socks/2%20x.sock',
    'uds:%2Ftmp%2Fcc-socks%2F2%20x.sock', '/tmp/cc-socks/2 x.sock', 'bridge:session_ABC', LANZADA]) {
    const r = decidir(toy, mensaje(OTRA, to));
    assert.ok(r && r.decision === 'deny', `${JSON.stringify(to)} → ${JSON.stringify(r)}`);
  }
  // las mismas formas hacia una sesión con persona delante pasan
  assert.strictEqual(decidir(toy, mensaje(OTRA, 'otra-pestaña')), null);
});

test('T23 BgGuard_MensajeALaCoordinadora_NoAnotaNada @story-8.232 @ac-12', (t) => {
  const toy = maquinaConOtra(t);
  sesion(toy, COORD, { nombre: 'Coordinadora', kind: 'interactive', cwd: toy.raiz, messagingSocketPath: '/tmp/cc-socks/1.sock' });
  for (const to of ['Coordinadora', 'Coordinadora [abc123]', 'uds:/tmp/cc-socks/1.sock']) {
    assert.strictEqual(decidir(toy, mensaje(LANZADA, to)), null, to);
    assert.strictEqual(decidir(toy, mensaje(OTRA, to)), null, to);
  }
  assert.strictEqual(erroresDe(toy), '');
  // un destino sin sesión se anota en un solo renglón, aunque traiga saltos de línea
  assert.strictEqual(decidir(toy, mensaje(OTRA, 'Nadie\n[2026-01-01] renglón falso')), null);
  assert.strictEqual(erroresDe(toy).trim().split('\n').length, 1);
});

test('T24 BgGuard_LaNegativaNombraALaCoordinadoraEntera @story-8.232 @ac-9', (t) => {
  const toy = maquinaConOtra(t);
  const largo = 'Coordinadora de la máquina de la oficina del fondo';
  sesion(toy, COORD, { nombre: largo, kind: 'interactive', cwd: toy.raiz });
  const r = decidir(toy, mensaje(OTRA));
  assert.strictEqual(r.decision, 'deny');
  assert.ok(r.reason.includes(`«${largo}»`), r.reason);
});

test('T25 BgGuard_FallaConCoordinadoraViva_NiegaSiElDestinoEsDeFondo @story-8.232 @ac-12', (t) => {
  const original = C.launchedBy;
  t.after(() => { C.launchedBy = original; });
  C.launchedBy = () => { throw new Error('se rompió'); };
  const toy = maquinaConOtra(t);
  const r = decidir(toy, mensaje(OTRA));
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
  assert.match(r.reason, /ante la duda/);
  assert.match(erroresDe(toy), /se rompió/);
  // a una sesión con persona delante, la misma falla deja pasar y queda anotada
  const persona = maquinaConOtra(t, { conRenglon: false });
  sesion(persona, LANZADA, { nombre: 'Acme1', kind: 'interactive', startedAt: AT + 7000 });
  assert.strictEqual(decidir(persona, mensaje(OTRA)), null);
  assert.match(erroresDe(persona), /se rompió/);
  // un destino de fondo ya confirmado no se suelta por la falla de otro destino
  C.launchedBy = ({ sid }) => { if (sid === LANZADA) return { launched: true }; throw new Error('otro'); };
  const dos = maquinaConOtra(t);
  assert.strictEqual(decidir(dos, mensaje(OTRA, '*')).decision, 'deny');
  // un problema del registro con un destino que no es de fondo: pasa y queda anotado
  C.launchedBy = () => ({ problem: 'registro raro', background: false });
  const raro = maquinaConOtra(t);
  assert.strictEqual(decidir(raro, mensaje(OTRA)), null);
  assert.match(erroresDe(raro), /registro raro.*dejé pasar/);
});

test('T26 BgGuard_LoQueQuedabaDeLaVuelta2 @story-8.232 @ac-9 @ac-12', (t) => {
  const SL = require('../lib/signature-list.js');
  // los prefijos de dirección en mayúsculas también resuelven
  const toy = maquinaConOtra(t);
  sesion(toy, LANZADA, { nombre: 'Acme1', kind: 'bg', startedAt: AT + 7000, messagingSocketPath: '/tmp/cc-socks/3.sock', bridgeSessionId: 'session_XYZ' });
  for (const to of ['UDS:/tmp/cc-socks/3.sock', 'Bridge:session_XYZ']) assert.strictEqual(decidir(toy, mensaje(OTRA, to)).decision, 'deny', to);
  // la lanzada que difunde no se cuenta a sí misma como destino de fondo
  assert.strictEqual(decidir(toy, mensaje(LANZADA, '*')), null);
  // sin sesión que llama o sin destino, no se mira nada
  assert.strictEqual(decidir(toy, { hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'Acme1' } }), null);
  assert.strictEqual(decidir(toy, mensaje(OTRA, '')), null);
  // una falla general con la coordinadora ya conocida niega; sin coordinadora conocida, pasa
  const { sesiones, vive } = SL;
  t.after(() => { SL.sesiones = sesiones; SL.vive = vive; });
  SL.vive = () => true;
  SL.sesiones = () => ({ mapa: { get() { throw new Error('mapa roto'); } } });
  const r = decidir(maquinaConOtra(t), mensaje(OTRA));
  assert.ok(r && r.decision === 'deny', JSON.stringify(r));
  SL.sesiones = () => { throw new Error('sin sesiones'); };
  assert.strictEqual(decidir(maquinaConOtra(t), mensaje(OTRA)), null);
});
