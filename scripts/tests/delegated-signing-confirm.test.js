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

const LIB = path.join(__dirname, '..', 'lib');
const GUION = path.join(LIB, 'delegated-signing.js');
const PIPELINE_LIB = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib');
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
