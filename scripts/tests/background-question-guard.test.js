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
  assert.match(cupo.reason, /terminal/);
});

test('T4 NoLanzada_Pasa @story-8.211 @ac-4', (t) => {
  const toy = maquina(t);
  sesion(toy, 'ses-interactiva', { nombre: 'Acme1', kind: 'interactive', startedAt: AT + 7000 });
  assert.strictEqual(decidir(toy, evento('ses-interactiva')), null, 'una pestaña interactiva pregunta');
  sesion(toy, 'ses-a-mano', { nombre: 'Acme2', kind: 'bg', startedAt: AT + 7000 });
  assert.strictEqual(decidir(toy, evento('ses-a-mano')), null, 'una de fondo abierta a mano pregunta');
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
  const soloClick = ow.negarSinVentana('pasar el tope', ['adhoc-lane:sobre-cupo'], 's', cupo, true, false, coord);
  assert.match(soloClick.texto, /terminal/);
  assert.match(soloClick.texto, /Coordinadora/);
  assert.doesNotMatch(soloClick.texto, /mostrale AskUserQuestion/);
});

test('T11 ClickEnLaCoordinadora_SigueValiendo @story-8.211 @ac-13', (t) => {
  const toy = casaNueva(t);
  const cfg = { hooks: { PreToolUse: [{ matcher: 'AskUserQuestion|mcp__spokenly__ask_user_dictation', hooks: [{ type: 'command', command: `node "${GANCHO}"` }] }] } };
  fs.writeFileSync(path.join(toy.casa, '.claude', 'settings.json'), JSON.stringify(cfg));
  assert.ok(oa.esPermitido(`node "${GANCHO}"`));
  assert.ok(oa.esPermitido('@tcg:background-question-guard.js'));
  assert.deepStrictEqual(oa.escuchasDelCuadro({ casa: toy.casa, cwd: toy.casa, plataforma: 'linux' }).ajenos, []);
});
