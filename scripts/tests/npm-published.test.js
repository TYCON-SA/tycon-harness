'use strict';
/**
 * npm-published.test.js — lo que el paquete de npm tiene PUBLICADO (story 8.40, el cierre: AC 12, 13 y 41 · T48 y T49).
 *
 * Las otras pruebas del paquete miran el código; ésta mira el registro de npm, con red:
 *   · T48 — la versión de scripts/setup/npm/package.json está publicada con su constancia de procedencia
 *           (`dist.attestations`, la que npm emite sola cuando publica la CI con trusted publishing) y es la `latest`.
 *   · T49 — la cuenta que publica está protegida: con una sesión de npm en la máquina, la doble verificación pide el
 *           segundo factor también para escribir (`auth-and-writes`), y la `latest` no es el marcador `0.0.0-stage` de una
 *           publicación en etapas sin aprobar.
 * Sin red, con el registro caído, con la versión todavía sin aprobar, o sin sesión de npm (T49): «NO MEDIDO», nunca verde.
 * Corre de noche (pide red: `requiere: ["red"]` en suites.json), no en cada pedido: depende de un servicio de afuera.
 * Correr: node --test scripts/tests/npm-published.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'npm', 'package.json'), 'utf8'));
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npm = (args) => spawnSync(npmBin, args, { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32', env: Object.assign({}, process.env, { npm_config_update_notifier: 'false' }) });
const json = (r) => { try { return JSON.parse(r.stdout); } catch (_) { return undefined; } };

test('T48 NpmPublished_Provenance_LatestIsTheRepoVersion', (t) => {
  if (npm(['--version']).status !== 0) return t.skip('NO MEDIDO: no hay npm en esta máquina');
  const r = npm(['view', `${PKG.name}@${PKG.version}`, 'version', 'dist.attestations', 'dist-tags', '--json']);
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0 && /E404/.test(out)) {
    // sin publicar todavía es «no medido»; pero si el registro ya tiene una versión MAYOR, ésta se salteó: nunca va a salir
    const latest = (json(npm(['view', PKG.name, 'dist-tags', '--json'])) || {}).latest;
    const cmp = (a, b) => { const x = String(a).split(/[.-]/).map(Number), y = String(b).split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
    assert.ok(!latest || cmp(latest, PKG.version) < 0, `${PKG.name}@${PKG.version} no está publicada y el registro ya va por ${latest}: la versión del repo quedó atrás o su publicación falló`);
    return t.skip(`NO MEDIDO: ${PKG.name}@${PKG.version} todavía no está publicada (o espera su aprobación en etapas)`);
  }
  if (r.status !== 0 || r.error) return t.skip(`NO MEDIDO: no pude preguntarle al registro (${(r.error && r.error.code) || out.trim().split('\n').slice(-1)[0]})`);
  const v = json(r);
  assert.ok(v && typeof v === 'object', `el registro contestó algo que no se entiende: ${r.stdout.slice(0, 300)}`);
  assert.strictEqual(v.version, PKG.version);
  const att = v['dist.attestations'];
  assert.ok(att && att.url && /provenance/i.test(JSON.stringify(att)), `${PKG.name}@${PKG.version} no trae constancia de procedencia: ${JSON.stringify(att)}`);
  assert.strictEqual((v['dist-tags'] || {}).latest, PKG.version, `la latest es ${(v['dist-tags'] || {}).latest}, no la del repo (${PKG.version})`);
});

test('T49 NpmAccount_ProtectedReadOnly_Suite', (t) => {
  if (npm(['--version']).status !== 0) return t.skip('NO MEDIDO: no hay npm en esta máquina');
  const who = npm(['whoami']);
  if (who.status !== 0) return t.skip('NO MEDIDO: sin sesión de npm en esta máquina (la cuenta del dueño se mira con su sesión)');
  // la sesión tiene que ser de quien publica el paquete: la de otra persona no dice nada de la cuenta que importa
  const me = String(who.stdout || '').trim();
  const owners = String(npm(['owner', 'ls', PKG.name]).stdout || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  if (!owners.includes(me)) return t.skip(`NO MEDIDO: la sesión de npm de esta máquina (${me}) no es dueña de ${PKG.name} (${owners.join(', ') || 'sin dueños legibles'})`);
  const collaborators = json(npm(['access', 'list', 'collaborators', PKG.name, '--json'])) || {};
  assert.strictEqual(Object.keys(collaborators).length, 1, `${PKG.name} tiene un solo colaborador con permiso de escritura (tiene: ${Object.keys(collaborators).join(', ') || 'ninguno legible'})`);
  const profile = json(npm(['profile', 'get', '--json']));
  assert.ok(profile && profile.tfa, 'la cuenta que publica tiene la doble verificación prendida');
  assert.strictEqual(profile.tfa.mode, 'auth-and-writes', `la doble verificación pide el segundo factor también para escribir (dice ${profile.tfa.mode})`);
  const tags = json(npm(['view', PKG.name, 'dist-tags', '--json']));
  if (!tags) return t.skip('NO MEDIDO: no pude leer las etiquetas del paquete');
  assert.notStrictEqual(tags.latest, '0.0.0-stage', 'la latest no es el marcador de una publicación en etapas sin aprobar');
});
