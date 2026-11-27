'use strict';
/**
 * profile-levels.test.js — el perfil del equipo no delega una firma de nivel 2 o más.
 *
 * La coordinadora firma sola lo que el perfil pone en `approvals.delegated_signing`. Por la tabla de niveles eso es
 * sólo la rutina (nivel 1): una excepción o algo irreversible lo firma una persona. El validador
 * (scripts/ci/check-profile-levels.js) rechaza el perfil que delega más. Sin el perfil del equipo en el árbol corre
 * contra los casos de acá; con la capa del equipo encima, también contra el perfil real.
 *
 *   T5 · una firma de nivel 2 o 3 delegada se rechaza, con su nivel.
 *   T6 · un grupo se rechaza si trae una firma de nivel 2 o más.
 *   T10 · un valor con espacios alrededor se rechaza igual: el lector del perfil lo recorta y lo delega.
 *   T7 · la rutina pasa, también en un valor solo y con `off`.
 *   T8 · el comando: sin perfil lo dice y sale 0; con uno que delega de más sale 1; ilegible sale 2.
 *   T9 · el perfil real, si la capa del equipo está encima, pasa.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const GUION = path.join(RAIZ, 'scripts', 'ci', 'check-profile-levels.js');
const { check } = require(GUION);

const perfil = (delegated_signing) => ({ approvals: { delegated_signing } });

// niveles T5 Perfil_DelegaNivel2o3_Rechaza
// 🔴 Falla con: un perfil que delega una excepción que no es de trámite o un cambio de control y el validador lo deja pasar.
test('niveles T5 Perfil_DelegaNivel2o3_Rechaza', () => {
  const r = check(perfil(['plan-approval', 'runtime-waiver', 'control-change', 'escape:force-manual', 'escape:trust-ran',
    'escape:DOD_BYPASS', 'adversarial-skip', 'escape:TYCON_TEST_GATE', 'escape:story-skill-bypass', 'adhoc-lane:datos', 'designation-confirm', 'escape:merge-bypass']));
  assert.deepStrictEqual(r.rejected.map((x) => [x.id, x.level]),
    [['control-change', 3], ['escape:DOD_BYPASS', 2], ['adversarial-skip', 2], ['escape:TYCON_TEST_GATE', 2], ['escape:story-skill-bypass', 2],
      ['adhoc-lane:datos', 2], ['designation-confirm', 2], ['escape:merge-bypass', 3]]);
  assert.ok(r.rejected.every((x) => x.via === x.id), 'nombradas por su id');
});

// 🔴 Falla con: una excepción de trámite rechazada aunque el perfil la nombre, o una que entra escondida en un grupo.
test('niveles Perfil_ExcepcionesDeTramite_PasanSoloPorSuNombre', () => {
  const cat = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const deTramite = [...cat.DELEGABLE_EXCEPTIONS, ...cat.formNames()];
  assert.deepStrictEqual(deTramite.slice().sort(), ['adhoc-lane:guardado-ajeno', 'critical-waiver', 'escape:ALLOW_DOD_EVIDENCE_WRITE',
    'escape:TYCON_STATUS_GATE', 'escape:cambiar-el-estado', 'escape:cerrar-como-deuda', 'escape:cerrar-la-ejecucion', 'escape:force-manual',
    'escape:red-control-test-edit', 'escape:rojo-esperado-de-la-matriz', 'escape:set-autonomous', 'escape:trust-ran', 'lost-run', 'manual-test',
    'plan-approval:delicada', 'runtime-waiver', 'save:sensible', 'write-after-release']);
  assert.deepStrictEqual(check(perfil(deTramite)).rejected, []);
  // el grupo de antes no las trae: las que son de trámite también salen si vienen por el grupo
  const porGrupo = check(perfil(['escape-phrases'])).rejected;
  assert.ok(porGrupo.some((x) => x.id === 'escape:set-autonomous' && x.via === 'escape-phrases'));
  // lo que el perfil sube a 3 deja de ser delegable, y una rutina subida a 2 también
  assert.strictEqual(cat.delegable('runtime-waiver', { 'runtime-waiver': 3 }), false);
  assert.strictEqual(cat.delegable('extra-round', { 'extra-round': 2 }), false);
  assert.strictEqual(cat.delegable('save:sensible', { 'save:sensible': 3 }), false);
  assert.strictEqual(cat.delegable('plan-approval:delicada', { 'plan-approval': 2 }), false);
  assert.strictEqual(cat.delegable('no-existe'), false);
});

// niveles T6 Perfil_GrupoConExcepcion_Rechaza
// 🔴 Falla con: un grupo que esconde una firma de nivel 2 o más detrás de su nombre.
test('niveles T6 Perfil_GrupoConExcepcion_Rechaza', () => {
  const r = check(perfil(['browser-test', 'escape-phrases']));
  const de = (via) => r.rejected.filter((x) => x.via === via).map((x) => x.id);
  assert.deepStrictEqual(de('browser-test'), ['browser-test'], 'decir que no a la prueba con navegador es nivel 2');
  assert.ok(de('escape-phrases').includes('escape:TYCON_SAFETY_OFF'), 'el grupo de los escapes trae el freno de seguridad');
  assert.ok(de('escape-phrases').length > 1);
});

// niveles T10 Perfil_ConEspacios_Rechaza
// 🔴 Falla con: un valor con espacios alrededor, que el lector del perfil recorta y delega, y el validador no reconoce.
test('niveles T10 Perfil_ConEspacios_Rechaza', () => {
  assert.deepStrictEqual(check(perfil(' adversarial-skip ')).rejected.map((x) => x.id), ['adversarial-skip'], 'valor solo');
  const r = check(perfil(['escape:DOD_BYPASS ', ' escape-phrases']));
  assert.ok(r.rejected.some((x) => x.id === 'escape:DOD_BYPASS' && x.via === 'escape:DOD_BYPASS'), 'en la lista, recortado');
  assert.ok(r.rejected.some((x) => x.via === 'escape-phrases'), 'un grupo con espacios');
});

// niveles T7 Perfil_Rutina_Pasa
// 🔴 Falla con: la rutina rechazada, o `off` y un valor solo leídos como una firma.
test('niveles T7 Perfil_Rutina_Pasa', () => {
  for (const v of [['plan-approval', 'extra-round', 'refresh-after-main', 'pending-approval', 'save', 'adhoc-lane'],
    'plan-approval', 'off', ['off'], []]) {
    assert.deepStrictEqual(check(perfil(v)).rejected, [], JSON.stringify(v));
  }
  assert.deepStrictEqual(check({}).rejected, [], 'sin approvals no delega nada');
  assert.deepStrictEqual(check({ approvals: {} }).rejected, []);
});

function correr(args, raiz) {
  return spawnSync(process.execPath, [GUION, ...args], { encoding: 'utf8', env: { ...process.env, TYCON_PROFILE_ROOT: raiz } });
}

// niveles T8 Perfil_Comando_SalidasYMensajes
// 🔴 Falla con: un perfil ausente leído como «está bien» en silencio, uno roto leído como vacío, o el rechazo sin salir 1.
test('niveles T8 Perfil_Comando_SalidasYMensajes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-levels-'));
  try {
    let r = correr([], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /no hay perfil del equipo/, 'dice que no midió');

    fs.writeFileSync(path.join(dir, 'team-profile.json'), JSON.stringify(perfil(['plan-approval', 'control-change'])));
    r = correr([], dir);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, /control-change.*nivel 3/);

    fs.writeFileSync(path.join(dir, 'team-profile.json'), '{ roto');
    r = correr([], dir);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(r.stderr, /no se pudo leer/);

    const otro = path.join(dir, 'otro.json');
    fs.writeFileSync(otro, JSON.stringify(perfil(['extra-round'])));
    r = correr(['--profile', otro], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /sólo delega rutina/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// niveles T9 Perfil_ElDelEquipo_Pasa
// 🔴 Falla con: el perfil real del equipo delegando una firma de nivel 2 o más (sólo donde la capa del equipo está encima).
test('niveles T9 Perfil_ElDelEquipo_Pasa', (t) => {
  const real = ['team-profile.json', 'perfil-equipo.json'].map((n) => path.join(RAIZ, n)).find((p) => fs.existsSync(p));
  if (!real) { t.skip('sin la capa del equipo encima: lo mide la validación del repo de mantenimiento'); return; }
  const r = check(JSON.parse(fs.readFileSync(real, 'utf8')));
  assert.deepStrictEqual(r.rejected, [], `${path.basename(real)} delega de más`);
});
