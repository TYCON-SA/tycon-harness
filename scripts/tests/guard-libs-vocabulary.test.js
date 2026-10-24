'use strict';

/**
 * guard-libs-vocabulary.test.js — la copia del lector que usa el freno de producción conoce todas las claves del lector
 * principal (@story-8.116).
 *
 * El freno de producción lleva su propia copia del lector de configuración (scripts/production/guard-libs/), que se
 * instala en /opt con la contraseña de la persona. Si el lector principal suma una clave y la copia no la conoce, un
 * perfil o un archivo de la máquina que la trae se lee en el freno como configuración ROTA: el índice se arma sin la
 * configuración de la máquina y el aviso sale en cada sesión. Pasó con `approvals.delegated_signing` (8.88), que el
 * sitio ya dejaba proponer.
 *
 * La copia no usa esas claves: las acepta. Esta prueba falla si el principal tiene una clave que la copia no conoce.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..');
const PRINCIPAL = path.join(SCRIPTS, 'lib', 'tycon-config.js');
const COPIA = path.join(SCRIPTS, 'production', 'guard-libs', 'lib', 'tycon-config.js');
const claves = (vocabulario) => Object.entries(vocabulario).flatMap(([s, o]) => Object.keys(o).map((k) => `${s}.${k}`));

// T1 GuardLibs_ConoceTodasLasClavesDelPrincipal @story-8.116
// 🔴 Falla con: una clave nueva del lector principal que la copia del freno no conoce.
test('8.116 GuardLibs_ConoceTodasLasClavesDelPrincipal', () => {
  const copia = new Set(claves(require(COPIA).VOCABULARIO));
  const faltan = claves(require(PRINCIPAL).VOCABULARIO).filter((c) => !copia.has(c));
  assert.deepStrictEqual(faltan, [], `la copia del freno no conoce: ${faltan.join(', ')} — sumalas en ${path.relative(SCRIPTS, COPIA)} como 'aceptada'`);
});

// T2 GuardLibs_PerfilConLasClavesNuevas_NoEsRoto @story-8.116
// 🔴 Falla con: la copia que conoce la clave pero rechaza su valor (el freno lee el perfil como roto igual).
test('8.116 GuardLibs_PerfilConLasClavesNuevas_NoEsRoto', (t) => {
  const L = require(COPIA);
  for (const [nombre, perfil, maquina] of [
    ['firma delegada suelta', { approvals: { relay_session: 'coordinadora', delegated_signing: 'refresh-after-main' } }, null],
    ['firma delegada en lista, con máquinas', { approvals: { relay_session: 'coordinadora', delegated_signing: ['refresh-after-main', 'adversarial-skip'], delegated_machines: [{ id: '0123456789abcdef', label: 'Mac de ejemplo' }] } }, null],
    ['el freno se actualiza solo', { guard: { update: 'auto' } }, null],
    ['proveedor de modelos en la máquina', {}, { models: { provider: 'anthropic' } }],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-home-'));
    fs.mkdirSync(path.join(home, '.claude'));
    const arnes = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-arnes-'));
    t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(arnes, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(arnes, 'team-profile.json'), JSON.stringify(perfil));
    if (maquina) fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify(maquina));
    const r = L.cargar({ env: {}, home, arnes });
    assert.deepStrictEqual(r.errores, [], `${nombre}: ${JSON.stringify(r.errores)}`);
  }
});
