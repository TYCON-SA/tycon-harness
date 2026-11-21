'use strict';
/*
 * delegated-signing-confirm.test.js — `confirm-designation`: qué deja escrito el guion según cómo volvió la firma.
 *
 * El freno que pide la firma se prueba en owner-window.test.js, con un árbol de procesos armado. Acá corre el guion de verdad
 * con la firma reemplazada (`exigir`): lo que se prueba es que sólo una persona confirma, y que el renglón queda atado a
 * esa designación.
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// La confirmación pide approvals.relay_session en el perfil del árbol del arnés, y el clon de trabajo no
// lo trae: el guion y sus bibliotecas corren desde una copia del arnés con ese perfil.
const COPIA = require('./lib/harness-copy.js').harnessCopy();
fs.writeFileSync(path.join(COPIA, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
const LIB = path.join(COPIA, 'scripts', 'lib');
const GUION = path.join(LIB, 'delegated-signing.js');
const PIPELINE_LIB = path.join(COPIA, 'skills', 'tycon-pipeline', 'scripts', 'lib');
const oa = require(path.join(LIB, 'owner-approvals.js'));

const COORDINADORA = 'ses-coord';

// Se carga antes del guion: la casa de la cuenta sale del sistema, y sin terminal ni firma de verdad el guion no sigue.
const PRECARGA = `
const fs = require('fs');
const os = require('os');
const homedir = process.env.TEST_HOME;
os.userInfo = () => ({ homedir, username: 'prueba', uid: 1, gid: 1, shell: null });
require(process.env.TEST_WAIVER_LIB).hasTty = () => false;
require(process.env.TEST_WINDOW_LIB).exigir = (o) => {
  fs.writeFileSync(process.env.TEST_CALL_FILE, JSON.stringify({ firma: o.firma, propia: o.propia }));
  return JSON.parse(process.env.TEST_SIGNATURE);
};
`;

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'confirmar-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  fs.mkdirSync(path.join(casa, '.tycon', 'state'), { recursive: true });
  return casa;
}
const registro = (casa) => path.join(casa, '.tycon', 'state', 'gates.log');
const renglones = (casa) => {
  let t = '';
  try { t = fs.readFileSync(registro(casa), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const confirmados = (casa) => renglones(casa).filter((l) => l.name === 'relay-designation-confirmed');

function designar(casa, { sesion = COORDINADORA, ts = '2026-11-02T00:00:00.000Z', cita = 'vos coordinás' } = {}) {
  fs.appendFileSync(registro(casa), `${JSON.stringify({ name: 'relay-designation', status: 'ok', sesion, rol: 'coordinadora', cita, ts })}\n`);
}

function confirmar(casa, { firma = { codigo: 0, via: 'click' }, sesion = COORDINADORA } = {}) {
  const precarga = path.join(casa, 'precarga.js');
  const llamada = path.join(casa, 'llamada.json');
  fs.writeFileSync(precarga, PRECARGA);
  const env = { PATH: process.env.PATH, HOME: casa, CLAUDE_CODE_SESSION_ID: sesion, TEST_HOME: casa, TEST_CALL_FILE: llamada, TEST_SIGNATURE: JSON.stringify(firma),
    TEST_WAIVER_LIB: path.join(PIPELINE_LIB, 'runtime-waiver.js'), TEST_WINDOW_LIB: path.join(LIB, 'owner-window.js') };
  const r = spawnSync(process.execPath, ['-r', precarga, GUION, 'confirm-designation'], { env, encoding: 'utf8' });
  return { ...r, llamada: fs.existsSync(llamada) ? JSON.parse(fs.readFileSync(llamada, 'utf8')) : null };
}

for (const via of ['click', 'mensaje', 'ventana']) {
  test(`Confirmar_Con_${via}_EscribeElRenglonYQuedaConfirmada`, (t) => {
    const casa = casaNueva(t);
    designar(casa);
    assert.strictEqual(oa.coordinadoraConfirmada(casa), null, 'antes de confirmar no vale');
    const r = confirmar(casa, { firma: { codigo: 0, via } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.llamada, { firma: 'designation-confirm', propia: COORDINADORA });
    const [c, ...resto] = confirmados(casa);
    assert.deepStrictEqual(resto, []);
    assert.strictEqual(c.status, 'ok');
    assert.strictEqual(c.sesion, COORDINADORA);
    assert.strictEqual(c.designacion_ts, '2026-11-02T00:00:00.000Z');
    assert.strictEqual(oa.coordinadoraConfirmada(casa), COORDINADORA);
  });
}

for (const via of ['delegacion', 'avisado']) {
  test(`Confirmar_Por_${via}_NoConfirmaNada`, (t) => {
    const casa = casaNueva(t);
    designar(casa);
    const r = confirmar(casa, { firma: { codigo: 0, via } });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /esto lo confirma una persona/);
    assert.deepStrictEqual(confirmados(casa), []);
    assert.strictEqual(oa.coordinadoraConfirmada(casa), null);
  });
}

test('Confirmar_FirmaNegada_NoEscribe', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = confirmar(casa, { firma: { codigo: 1, motivo: 'esta firma no pasó por la ventana' } });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(confirmados(casa), []);
});

test('Confirmar_DesdeOtraSesion_NiPideLaFirma', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = confirmar(casa, { sesion: 'ses-otra' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /pestaña de la sesión designada/);
  assert.strictEqual(r.llamada, null, 'no se le pide la firma a nadie');
  assert.deepStrictEqual(confirmados(casa), []);
});

test('Confirmar_SinDesignacion_Niega', (t) => {
  const casa = casaNueva(t);
  const r = confirmar(casa);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /ninguna sesión de esta máquina está designada/);
  assert.strictEqual(r.llamada, null);
});

test('Confirmar_DesignacionPosterior_NoQuedaCubiertaPorLaVieja', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  assert.strictEqual(confirmar(casa).status, 0);
  assert.strictEqual(oa.coordinadoraConfirmada(casa), COORDINADORA);
  // la misma sesión, designada de nuevo: el renglón ata sesión, hora y frase
  designar(casa, { ts: '2026-11-02T01:00:00.000Z', cita: 'seguí coordinando' });
  assert.strictEqual(oa.coordinadoraConfirmada(casa), null);
  assert.strictEqual(confirmar(casa).status, 0);
  assert.strictEqual(oa.coordinadoraConfirmada(casa), COORDINADORA);
});

// --- `--terminal` en Windows: la terminal no se lee; el comando se corre otra vez en una ventana nueva y se firma adentro ---

const rw = require(path.join(PIPELINE_LIB, 'runtime-waiver.js'));

// Lo que le pregunta a Windows no corre fuera de Windows: la ventana se reemplaza, y `hasTty` dice si la consola se comprobó.
const PRECARGA_TERMINAL = `
const fs = require('fs');
const os = require('os');
const homedir = process.env.TEST_HOME;
os.userInfo = () => ({ homedir, username: 'prueba', uid: 1, gid: 1, shell: null });
const rw = require(process.env.TEST_WAIVER_LIB);
rw.hasTty = () => process.env.TEST_CONSOLE === 'ok';
rw.confirmarFrase = () => process.env.TEST_PHRASE === 'ok';
rw.dentroDeLaVentana = () => fs.writeFileSync(process.env.TEST_INSIDE_FILE, '1');
rw.abrirVentana = (o) => {
  fs.writeFileSync(process.env.TEST_OPEN_FILE, JSON.stringify({ script: o.script, args: o.args }));
  return JSON.parse(process.env.TEST_WINDOW);
};
require(process.env.TEST_WINDOW_LIB).exigir = () => { fs.writeFileSync(process.env.TEST_CALL_FILE, '1'); return { codigo: 1, motivo: 'sin firma' }; };
`;

function porTerminal(casa, { args = ['--terminal'], plataforma = 'win32', ventana = { estado: 'cerrada', codigo: 0 }, adentro = false, consola = false, frase = false } = {}) {
  const precarga = path.join(casa, 'precarga-terminal.js');
  const abrio = path.join(casa, 'abrio.json');
  const dentro = path.join(casa, 'dentro');
  const exigio = path.join(casa, 'exigio');
  fs.writeFileSync(precarga, PRECARGA_TERMINAL);
  const env = { PATH: process.env.PATH, HOME: casa, CLAUDE_CODE_SESSION_ID: COORDINADORA, TEST_HOME: casa, TEST_WINDOW: JSON.stringify(ventana), TEST_OPEN_FILE: abrio, TEST_INSIDE_FILE: dentro, TEST_CALL_FILE: exigio,
    TEST_WAIVER_LIB: path.join(PIPELINE_LIB, 'runtime-waiver.js'), TEST_WINDOW_LIB: path.join(LIB, 'owner-window.js'), TYCON_WAIVER_PLATFORM: plataforma,
    ...(adentro ? { [rw.MARCA_VENTANA]: '1' } : {}), ...(consola ? { TEST_CONSOLE: 'ok' } : {}), ...(frase ? { TEST_PHRASE: 'ok' } : {}) };
  const r = spawnSync(process.execPath, ['-r', precarga, GUION, 'confirm-designation', ...args], { env, encoding: 'utf8' });
  return { ...r, abrio: fs.existsSync(abrio) ? JSON.parse(fs.readFileSync(abrio, 'utf8')) : null, dentro: fs.existsSync(dentro), exigio: fs.existsSync(exigio) };
}

test('Terminal_EnWindows_AbreLaVentanaConElMismoComando', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = porTerminal(casa);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.abrio, { script: GUION, args: ['confirm-designation', '--terminal'] });
  assert.match(r.stderr, /ventana nueva/);
  assert.deepStrictEqual(confirmados(casa), [], 'el proceso de afuera no confirma: confirma el de la ventana');
});

test('Terminal_EnWindows_DevuelveElCodigoDeLaVentana', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  assert.strictEqual(porTerminal(casa, { ventana: { estado: 'cerrada', codigo: 1 } }).status, 1);
  assert.strictEqual(porTerminal(casa, { ventana: { estado: 'cerrada', codigo: 2 } }).status, 2);
  assert.strictEqual(porTerminal(casa, { ventana: { estado: 'cerrada' } }).status, 1, 'una ventana que cierra sin código no es un sí');
  assert.deepStrictEqual(confirmados(casa), []);
});

for (const [estado, ventana, texto] of [
  ['vencida', { estado: 'vencida', tope: 300 }, /venció/],
  ['no-abrio', { estado: 'no-abrio', motivo: 'sin consola' }, /no pude abrir la ventana \(sin consola\)/],
]) {
  test(`Terminal_EnWindows_Ventana_${estado}_NoConfirma`, (t) => {
    const casa = casaNueva(t);
    designar(casa);
    const r = porTerminal(casa, { ventana });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, texto);
    assert.match(r.stderr, /no se confirmó nada/);
    assert.deepStrictEqual(confirmados(casa), []);
  });
}

test('Terminal_EnWindows_SinDesignacion_NoAbreLaVentana', (t) => {
  const casa = casaNueva(t);
  const r = porTerminal(casa);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /ninguna sesión de esta máquina está designada/);
  assert.strictEqual(r.abrio, null);
});

test('Terminal_DentroDeLaVentana_ConLaFrase_Confirma', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = porTerminal(casa, { adentro: true, consola: true, frase: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.abrio, null, 'adentro no abre otra');
  assert.strictEqual(r.dentro, true, 'se anota, para que la cierren al vencer y espere un Enter al salir');
  assert.strictEqual(confirmados(casa).length, 1);
  assert.strictEqual(oa.coordinadoraConfirmada(casa), COORDINADORA);
});

test('Terminal_DentroDeLaVentana_SinLaFrase_NoConfirma', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = porTerminal(casa, { adentro: true, consola: true, frase: false });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(confirmados(casa), []);
});

// 🔴 la marca la puede poner cualquiera: sin la consola comprobada no se pide la frase ni se confirma
test('Terminal_MarcaDeLaVentanaSinSuConsola_NoConfirma', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = porTerminal(casa, { adentro: true, consola: false, frase: true });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(r.abrio, null);
  assert.deepStrictEqual(confirmados(casa), []);
});

test('SinTerminal_EnWindows_NoAbreLaVentana_PideLaFirmaDeLaPestana', (t) => {
  const casa = casaNueva(t);
  designar(casa);
  const r = porTerminal(casa, { args: [] });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(r.abrio, null);
  assert.strictEqual(r.exigio, true);
  assert.deepStrictEqual(confirmados(casa), []);
});

test('Terminal_FueraDeWindows_NoAbreVentana_PideLaTerminal', (t) => {
  if (process.platform === 'win32') { t.skip('en Windows la variable no vuelve a la rama de /dev/tty'); return; }
  const casa = casaNueva(t);
  designar(casa);
  const r = porTerminal(casa, { plataforma: 'linux' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(r.abrio, null);
  assert.match(r.stderr, /pide la terminal del dueño/);
});

// --- la designación por click -----------------------------------------------------------------------------------------

const ds = require(GUION);
const cwLib = require(path.join(PIPELINE_LIB, 'critical-waivers.js'));
const paths = (casa) => ds.accountPaths(casa);
/** Una designación por click con su confirmación del mismo comando, como la deja marker.js designate-relay. */
function porClick(casa, { sesion = COORDINADORA, ts = '2026-11-04T10:00:00.000Z', confirmada = true } = {}) {
  const d = { name: 'relay-designation', status: 'ok', ts, sesion, rol: 'coordinadora', quien: 'el dueño', via: 'click' };
  fs.appendFileSync(registro(casa), `${JSON.stringify(d)}\n`);
  if (confirmada) fs.appendFileSync(registro(casa), `${JSON.stringify(ds.confirmationRecord({ ...d, cita: null }, ts, { via: 'click' }))}\n`);
  return d;
}

// 🔴 Falla con: las dos lecturas de la confirmación que no coinciden para una designación sin frase.
test('ConfirmedDesignation_And_CoordinadoraConfirmada_ClickDesignation_Agree (T6)', (t) => {
  const casa = casaNueva(t);
  porClick(casa);
  assert.strictEqual(ds.confirmedDesignation(paths(casa)).ok, true);
  assert.strictEqual(oa.coordinadoraConfirmada(casa), COORDINADORA);
  const sin = casaNueva(t);
  porClick(sin, { confirmada: false });
  assert.strictEqual(ds.confirmedDesignation(paths(sin)).ok, false);
  assert.strictEqual(oa.coordinadoraConfirmada(sin), null);
});

// 🔴 Falla con: la confirmación de un click viejo que confirma la designación siguiente de la misma sesión.
test('ConfirmedDesignation_ConfirmationOfEarlierClick_DoesNotConfirmLater (T8)', (t) => {
  const casa = casaNueva(t);
  porClick(casa, { ts: '2026-11-04T09:00:00.000Z' });
  porClick(casa, { ts: '2026-11-04T10:00:00.000Z', confirmada: false });
  assert.strictEqual(cwLib.designacionVigente({ dir: paths(casa).state }).ts, '2026-11-04T10:00:00.000Z');
  assert.strictEqual(ds.confirmedDesignation(paths(casa)).ok, false);
  assert.strictEqual(oa.coordinadoraConfirmada(casa), null);
});

// 🔴 Falla con: un perfil que delega nombrar o retirar a la coordinadora, y la delegación que lo deja pasar.
test('DesignationFirmas_InDelegatedSigning_NeverDelegated (T25)', (t) => {
  const casa = casaNueva(t);
  porClick(casa);
  const perfil = () => ({ delegated_signing: ['designation-set', 'designation-withdraw', 'plan-approval'], delegated_machines: [{ id: 'm1' }] });
  for (const firma of ['designation-set', 'designation-withdraw']) {
    const r = ds.delegaSinVentana({ firma, sesion: COORDINADORA, destino: 'ses-otra', home: casa, estado: paths(casa).state, perfil, huella: () => ({ huella: 'm1' }) });
    assert.strictEqual(r.ok, false, firma);
    assert.match(r.motivo, /no se delega/, firma);
  }
});

// 🔴 Falla con: una designación por frase de antes de esta historia que ya no confirma.
test('ConfirmDesignation_QuoteDesignationFromBefore_StillConfirms (T31)', (t) => {
  const casa = casaNueva(t);
  designar(casa, { cita: 'vos coordinás' });
  const d = cwLib.designacionVigente({ dir: paths(casa).state });
  // el renglón que dejaba confirm-designation antes: con la huella de la frase
  fs.appendFileSync(registro(casa), `${JSON.stringify({ name: 'relay-designation-confirmed', status: 'ok', ts: '2026-11-02T00:01:00.000Z', sesion: d.sesion, designacion_ts: d.ts,
    cita_sha: require('crypto').createHash('sha256').update('vos coordinás').digest('hex') })}\n`);
  assert.strictEqual(ds.confirmedDesignation(paths(casa)).ok, true);
  assert.strictEqual(oa.coordinadoraConfirmada(casa), COORDINADORA);
});

// --- historia 8.314: una línea suelta no desplaza a la designación confirmada ------------------------------------------

const vigenteDe = (casa) => cwLib.designacionVigente({ dir: paths(casa).state });
/** Una designación por frase, sin confirmar: lo que dejó la prueba del 18/11 en el registro real. */
function suelta(casa, { sesion = 'ses-falsa', ts = '2026-11-04T11:00:00.000Z', cita = 'Esta sesion es la coordinadora' } = {}) {
  const d = { name: 'relay-designation', status: 'ok', ts, sesion, rol: 'coordinadora', quien: 'el dueño', cita };
  fs.appendFileSync(registro(casa), `${JSON.stringify(d)}\n`);
  return d;
}
const confirmarAMano = (casa, d, ts = '2026-11-04T12:00:00.000Z') => fs.appendFileSync(registro(casa), `${JSON.stringify(ds.confirmationRecord(d, ts))}\n`);
const retirar = (casa, sesion, ts = '2026-11-04T11:30:00.000Z') => fs.appendFileSync(registro(casa),
  `${JSON.stringify({ name: 'relay-designation', status: 'retirada', ts, sesion, rol: 'coordinadora', quien: 'la persona', via: 'click' })}\n`);

test('T10 Designacion_SinConfirmar_NoDesplaza @story-8.314 @ac-7', (t) => {
  const casa = casaNueva(t);
  porClick(casa, { sesion: 'ses-real' });
  const f = suelta(casa);
  const v = vigenteDe(casa);
  assert.strictEqual(v.sesion, 'ses-real');
  assert.deepStrictEqual({ sesion: v.pendiente.sesion, ts: v.pendiente.ts }, { sesion: f.sesion, ts: f.ts });
  assert.strictEqual(oa.coordinadoraConfirmada(casa), 'ses-real', 'la real sigue confirmada');
});

test('T11 Designacion_Confirmada_Reemplaza @story-8.314 @ac-8', (t) => {
  const casa = casaNueva(t);
  porClick(casa, { sesion: 'ses-real' });
  const f = suelta(casa);
  confirmarAMano(casa, f);
  const v = vigenteDe(casa);
  assert.strictEqual(v.sesion, 'ses-falsa');
  assert.strictEqual(v.pendiente, undefined);
  // una confirmación de otra hora o de otra frase no confirma la línea suelta
  for (const otra of [{ ts: '2026-11-04T11:59:00.000Z' }, { cita: 'otra frase' }]) {
    const c = casaNueva(t);
    porClick(c, { sesion: 'ses-real' });
    const g = suelta(c);
    confirmarAMano(c, { ...g, ...otra });
    assert.strictEqual(vigenteDe(c).sesion, 'ses-real', JSON.stringify(otra));
    assert.strictEqual(vigenteDe(c).pendiente.sesion, 'ses-falsa');
  }
});

test('T12 Designacion_SinConfirmadasORetirada @story-8.314 @ac-8 @ac-7', (t) => {
  // sin ninguna confirmada: vale la última, como hoy
  const sin = casaNueva(t);
  suelta(sin, { sesion: 'ses-a', ts: '2026-11-04T10:00:00.000Z' });
  suelta(sin, { sesion: 'ses-b', ts: '2026-11-04T10:05:00.000Z' });
  assert.strictEqual(vigenteDe(sin).sesion, 'ses-b');
  assert.strictEqual(vigenteDe(sin).pendiente, undefined);
  // la confirmada retirada, y después una suelta: la suelta
  const retirada = casaNueva(t);
  porClick(retirada, { sesion: 'ses-real' });
  retirar(retirada, 'ses-real');
  suelta(retirada, { ts: '2026-11-04T11:45:00.000Z' });
  assert.strictEqual(vigenteDe(retirada).sesion, 'ses-falsa');
  // la retirada de otra sesión no toca a la confirmada
  const otra = casaNueva(t);
  porClick(otra, { sesion: 'ses-real' });
  retirar(otra, 'ses-x');
  assert.strictEqual(vigenteDe(otra).sesion, 'ses-real');
  // la misma sesión confirmada, designada otra vez: manda la nueva, sin confirmar y sin pendiente
  const misma = casaNueva(t);
  porClick(misma, { sesion: 'ses-real' });
  suelta(misma, { sesion: 'ses-real', ts: '2026-11-04T12:30:00.000Z' });
  assert.strictEqual(vigenteDe(misma).ts, '2026-11-04T12:30:00.000Z');
  assert.strictEqual(vigenteDe(misma).pendiente, undefined);
  assert.strictEqual(oa.coordinadoraConfirmada(misma), null);
});

test('T13 Confirmar_ConfirmaLaPendiente @story-8.314 @ac-9', (t) => {
  const ow = require(path.join(LIB, 'owner-window.js'));
  for (const desde of ['ses-pend', COORDINADORA]) {
    const casa = casaNueva(t);
    designar(casa);
    assert.strictEqual(confirmar(casa).status, 0);
    const p = suelta(casa, { sesion: 'ses-pend', ts: '2026-11-02T05:00:00.000Z' });
    // el cuadro de la firma nombra a la pendiente, no a la vigente
    const d = ow.detalleDe('designation-confirm', 'node delegated-signing.js confirm-designation', null, casa, casa);
    assert.ok(d.linea.includes('ses-pend') && !d.linea.includes(COORDINADORA), d.linea);
    const r = confirmar(casa, { sesion: desde });
    assert.strictEqual(r.status, 0, `${desde}: ${r.stderr}`);
    assert.strictEqual(r.llamada.propia, desde);
    const ultimo = confirmados(casa).pop();
    assert.deepStrictEqual({ sesion: ultimo.sesion, ts: ultimo.designacion_ts }, { sesion: 'ses-pend', ts: p.ts }, desde);
    assert.strictEqual(vigenteDe(casa).sesion, 'ses-pend');
  }
  const casa = casaNueva(t);
  designar(casa);
  assert.strictEqual(confirmar(casa).status, 0);
  suelta(casa, { sesion: 'ses-pend', ts: '2026-11-02T05:00:00.000Z' });
  const antes = confirmados(casa).length;
  fs.rmSync(path.join(casa, 'llamada.json'), { force: true });   // la de la confirmación anterior
  const tercera = confirmar(casa, { sesion: 'ses-tercera' });
  assert.strictEqual(tercera.status, 1, tercera.stderr);
  assert.strictEqual(tercera.llamada, null, 'a la tercera no se le pide la firma');
  assert.strictEqual(confirmados(casa).length, antes);
});

test('T14 Plegar_MismaReglaQueLaLecturaEntera @story-8.314 @ac-10', (t) => {
  const cwr = require(path.join(LIB, 'coordination-writes.js'));
  const casa = casaNueva(t);
  const estado = paths(casa).state;
  porClick(casa, { sesion: 'ses-real' });
  assert.strictEqual(cwr.currentCoordinator({ stateDir: estado }).session, 'ses-real');
  // lo agregado se lee por partes, con la memoria
  suelta(casa);
  assert.strictEqual(cwr.currentCoordinator({ stateDir: estado }).session, 'ses-real', 'por partes');
  assert.strictEqual(vigenteDe(casa).sesion, 'ses-real', 'entera');
  const f = suelta(casa, { sesion: 'ses-otra', ts: '2026-11-04T11:10:00.000Z' });
  confirmarAMano(casa, f);
  assert.strictEqual(cwr.currentCoordinator({ stateDir: estado }).session, 'ses-otra');
  assert.strictEqual(vigenteDe(casa).sesion, 'ses-otra');
  // una memoria con la forma vieja (sólo la sesión) no se usa
  const log = registro(casa);
  const st = fs.statSync(log);
  const buf = fs.readFileSync(log);
  const vieja = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, tail: buf.subarray(Math.max(0, st.size - 64)).toString('base64'), session: 'ses-falsa' };
  fs.mkdirSync(path.join(estado, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'coordination', cwr.MEMO), JSON.stringify(vieja));
  assert.strictEqual(cwr.currentCoordinator({ stateDir: estado }).session, 'ses-otra');
});

test('T15 Delegacion_LineaSuelta_NoCambiaQuienFirma @story-8.314 @ac-11', (t) => {
  const perfil = () => ({ relay_session: 'coordinadora', delegated_signing: ['plan-approval'], owner_only: [], delegated_machines: [{ id: 'maquina' }] });
  const huella = () => ({ huella: 'maquina' });
  const pide = (casa, sesion) => ds.delegaSinVentana({ firma: 'plan-approval', sesion, destino: 'ses-destino', estado: paths(casa).state, perfil, huella }).ok;
  // la primera fila: sólo la real, confirmada
  const sola = casaNueva(t);
  porClick(sola, { sesion: 'ses-real' });
  assert.deepStrictEqual([pide(sola, 'ses-real'), pide(sola, 'ses-falsa')], [true, false]);
  // la segunda: la línea suelta después (lo del 18/11): firma la real y no la falsa
  const conLinea = casaNueva(t);
  porClick(conLinea, { sesion: 'ses-real' });
  suelta(conLinea);
  assert.deepStrictEqual([pide(conLinea, 'ses-real'), pide(conLinea, 'ses-falsa')], [true, false]);
  // la tercera: además un renglón de confirmación falso, igual que hoy
  const conConfirmacion = casaNueva(t);
  porClick(conConfirmacion, { sesion: 'ses-real' });
  confirmarAMano(conConfirmacion, suelta(conConfirmacion));
  assert.deepStrictEqual([pide(conConfirmacion, 'ses-real'), pide(conConfirmacion, 'ses-falsa')], [false, true]);
});
