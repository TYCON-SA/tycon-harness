'use strict';

/**
 * time-tracking-config.test.js — la clave de la herramienta de horas y los secretos de las integraciones.
 *
 *   T12 · `integrations.clockify: true` / `false` de antes, sin `timeTracking`, se lee `clockify` / `none` y se anota
 *         como nombre viejo; `timeTracking` escrito gana; sin nada, `none`.
 *   T13 · el secreto de una integración: `harness.js config set solidtime.token` lo toma por stdin, lo guarda en
 *         `<casa>/secrets/solidtime.json` (carpeta 700, archivo 600), no en `config.json`, y no lo imprime; por
 *         argumento se rechaza; `config show` dice «está» / «falta», nunca el valor; en el perfil es un error.
 *
 * Nada toca el HOME real. El token de mentira se arma por partes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TC = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
const HARNESS = path.join(ROOT, 'scripts', 'setup', 'harness.js');
const TOKEN = ['st', 'cfg', 'Qm71', 'zz04', 'marca'].join('-');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function casa() { const h = tmp('ttc-home-'); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
function env(home, extra = {}) {
  const e = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0' }, extra);
  for (const k of ['TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY', 'TYCON_INTEGRATIONS_DIR', 'TYCON_SOLIDTIME_TOKEN']) if (!(k in extra)) delete e[k];
  return e;
}
function machineFile(home, data) {
  const f = path.join(home, '.claude', 'tycon.json');
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
}

test('Config_LegacyClockifyTrue_ReadsClockify @story-7.40 @ac-5', () => {
  const nada = casa();
  assert.strictEqual(TC.timeTracking(TC.leer({ home: nada, env: env(nada) })).value, 'none');

  const viejo = casa();
  machineFile(viejo, { integrations: { clockify: true } });
  const t = TC.timeTracking(TC.leer({ home: viejo, env: env(viejo) }));
  assert.strictEqual(t.value, 'clockify');
  assert.strictEqual(t.legacy, true);
  const log = path.join(viejo, '.claude', '.tycon-pipeline', 'legacy-names.jsonl');
  const logs = [log, path.join(viejo, '.tycon', 'state', 'legacy-names.jsonl')].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('');
  assert.match(logs, /integrations\.clockify/, 'el uso del nombre viejo queda anotado');

  const apagado = casa();
  machineFile(apagado, { integrations: { clockify: false } });
  assert.strictEqual(TC.timeTracking(TC.leer({ home: apagado, env: env(apagado) })).value, 'none');

  const nuevo = casa();
  machineFile(nuevo, { integrations: { clockify: true, timeTracking: 'solidtime' } });
  const n = TC.timeTracking(TC.leer({ home: nuevo, env: env(nuevo) }));
  assert.strictEqual(n.value, 'solidtime', 'la clave nueva gana a la vieja');
  assert.strictEqual(n.legacy, false);

  // la variable gana a los archivos; un valor raro no rompe la configuración (lo dice el evento neutro)
  const raro = TC.leer({ home: nada, env: env(nada, { TYCON_TIME_TRACKING: 'harvest' }) });
  assert.strictEqual(TC.timeTracking(raro).value, 'harvest');
  // las ocho integraciones siguen siendo ocho
  assert.strictEqual(TC.LAS_OCHO.length, 8);
  assert.ok(!TC.LAS_OCHO.includes('timeTracking'));
});

function harness(args, home, input) {
  return spawnSync(process.execPath, [HARNESS, 'config', ...args], { env: env(home), input, encoding: 'utf8', timeout: 60000 });
}

test('Config_SolidtimeSecrets_NeverPrinted @story-7.40 @ac-13', () => {
  const home = casa();
  const falta = harness(['show'], home);
  assert.strictEqual(falta.status, 0, falta.stderr);
  assert.match(falta.stdout, /solidtime\.token: falta/);

  const porArgumento = harness(['set', 'solidtime.token', TOKEN], home);
  assert.strictEqual(porArgumento.status, 2);
  assert.ok(!(porArgumento.stdout + porArgumento.stderr).includes(TOKEN), 'el rechazo no repite el valor');

  const set = harness(['set', 'solidtime.token'], home, `${TOKEN}\n`);
  assert.strictEqual(set.status, 0, set.stderr + set.stdout);
  assert.ok(!(set.stdout + set.stderr).includes(TOKEN), 'guardar no lo imprime');

  const dir = path.join(home, '.tycon', 'secrets');
  const file = path.join(dir, 'solidtime.json');
  assert.ok(fs.existsSync(file), 'va en su archivo aparte');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'la carpeta, sólo del usuario');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'el archivo, sólo del usuario');
  }
  const config = path.join(home, '.tycon', 'config.json');
  assert.ok(!fs.existsSync(config) || !fs.readFileSync(config, 'utf8').includes(TOKEN), 'no va en config.json, que lee el freno');

  const esta = harness(['show'], home);
  assert.match(esta.stdout, /solidtime\.token: está/);
  assert.ok(!(esta.stdout + esta.stderr).includes(TOKEN));

  // la configuración de la máquina se sigue leyendo bien con el secreto guardado
  assert.doesNotThrow(() => TC.leer({ home, env: env(home) }));

  const unset = harness(['unset', 'solidtime.token'], home);
  assert.strictEqual(unset.status, 0, unset.stderr);
  assert.match(harness(['show'], home).stdout, /solidtime\.token: falta/);

  // en el perfil del equipo, un secreto es un error
  const perfil = path.join(home, 'team-profile.json');
  fs.writeFileSync(perfil, JSON.stringify({ solidtime: { token: 'x' } }));
  assert.throws(() => TC.leer({ home, env: env(home, { TYCON_PROFILE: perfil }) }), /solidtime/);

  // ningún mensaje del comando repite un pedazo de lo que se le pasó para un secreto
  const [a, b] = [TOKEN.slice(0, 12), TOKEN.slice(12)];
  for (const args of [['set', 'solidtime.token', a, b], ['set', 'solidtime.token', TOKEN, 'otro'], ['unset', 'solidtime.token', TOKEN], ['set', TOKEN], ['set', 'github.token', a, b]]) {
    const r = harness(args, home);
    assert.strictEqual(r.status, 2, args.join(' '));
    for (const part of [a, b, TOKEN]) assert.ok(!(r.stdout + r.stderr).includes(part), `${args[0]} con valores de más no los repite`);
  }
  const conEspacio = harness(['set', 'solidtime.token'], home, `${a} ${b}\n`);
  assert.strictEqual(conEspacio.status, 2);
  for (const part of [a, b]) assert.ok(!(conEspacio.stdout + conEspacio.stderr).includes(part), 'un valor con espacios no se repite');
});

test('Config_DamagedSecretsFile_NotOverwritten @story-7.40 @ac-13', () => {
  const home = casa();
  const dir = path.join(home, '.tycon', 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'solidtime.json');
  fs.writeFileSync(file, '{ dañado', { mode: 0o600 });
  const show = harness(['show'], home);
  assert.match(show.stdout, /solidtime\.token: falta \(el archivo de secretos está dañado\)/);
  const set = harness(['set', 'solidtime.token'], home, `${TOKEN}\n`);
  assert.strictEqual(set.status, 2, 'no pisa un archivo dañado');
  assert.match(set.stdout + set.stderr, /dañado/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ dañado', 'el archivo queda como estaba');
  assert.ok(!(set.stdout + set.stderr).includes(TOKEN));
});

test('Config_IntegrationSettings_Validated @story-7.40 @ac-10', () => {
  const home = casa();
  const perfil = path.join(home, 'team-profile.json');
  const leer = (integrations) => { fs.writeFileSync(perfil, JSON.stringify({ integrations })); return () => TC.leer({ home, env: env(home, { TYCON_PROFILE: perfil }) }); };
  assert.throws(leer({ timeTracking: 'solidtime', solidtime: { url: 'http://acme.example' } }), /integrations\.solidtime\.url[\s\S]*https:\/\//);
  assert.throws(leer({ timeTracking: 'solidtime', solidtime: { url: 'https://horas.acme.example', color: 'azul' } }), /integrations\.solidtime\.color[\s\S]*clave desconocida/);
  assert.throws(leer({ solidtime: 'https://horas.acme.example' }), /tiene que ser un objeto/);
  for (const ok of ['https://horas.acme.example', 'http://localhost:8080', 'http://127.0.0.1']) {
    const c = leer({ timeTracking: 'solidtime', solidtime: { url: ok } })();
    assert.strictEqual(c.valores.integraciones.solidtime.url, ok);
  }
  // una integración con el manifiesto roto: el error lo dice, no «clave desconocida»
  const ints = tmp('ttc-int-');
  fs.mkdirSync(path.join(ints, 'acme'));
  fs.writeFileSync(path.join(ints, 'acme', 'integration.json'), '{ roto');
  const prev = process.env.TYCON_INTEGRATIONS_DIR;
  process.env.TYCON_INTEGRATIONS_DIR = ints;
  try {
    assert.throws(leer({ acme: { url: 'https://x.example' } }), /«acme» tiene el manifiesto roto/);
  } finally { if (prev === undefined) delete process.env.TYCON_INTEGRATIONS_DIR; else process.env.TYCON_INTEGRATIONS_DIR = prev; }
});

test('MoveHome_ProfileFold_KeepsTimeTrackingInProfile @story-7.40 @ac-5', () => {
  const MH = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'move-home.js'));
  const home = casa();
  const oldTree = tmp('ttc-tree-');
  fs.writeFileSync(path.join(oldTree, 'team-profile.json'), JSON.stringify({ integrations: { engram: true, timeTracking: 'solidtime', solidtime: { url: 'https://horas.acme.example' } } }));
  const f = MH.__test.profileFold({ ctx: { home, env: env(home, { TYCON_PROFILE: path.join(oldTree, 'team-profile.json') }) }, oldTree });
  assert.strictEqual(f.status, 'read', f.reason);
  const keys = (list) => list.map((m) => `${m.section}.${m.key}`);
  assert.ok(keys(f.moves).includes('integrations.engram'), 'las llaves de siempre viajan');
  assert.ok(!keys(f.moves).includes('integrations.timeTracking'), 'la elección de horas no pasa al archivo de la máquina');
  assert.ok(!keys(f.moves).includes('integrations.solidtime'), 'los ajustes de una integración tampoco');
  assert.ok(keys(f.skipped).includes('integrations.timeTracking') && keys(f.skipped).includes('integrations.solidtime'));
});
