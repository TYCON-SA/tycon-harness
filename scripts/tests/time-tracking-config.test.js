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
 *   T14-T15, T21-T22, T40-T46 · los hooks, el despachador y las skills de una integración (`@int:`), su manifiesto
 *         mal escrito (roto con aviso, nunca frena la instalación) y la herramienta que no se puede leer.
 *   T52 · las cuentas de solo conteo (`managed.js` y el Node del arnés) dicen un manifiesto roto, no lo cuentan callado.
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
  // timeTracking es una elección, no una integración más: las integraciones son nueve, con instincts
  assert.strictEqual(TC.LAS_OCHO.length, 9);
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
  // un token con forma de palabra (minúsculas y guion bajo) pegado en lugar de la clave, y valores de más con una clave
  // que no es secreta (una secreta mal escrita deja de reconocerse como secreta)
  const palabra = `pat_${TOKEN.replace(/-/g, '')}`;
  for (const args of [['set', 'solidtime.token', a, b], ['set', 'solidtime.token', TOKEN, 'otro'], ['unset', 'solidtime.token', TOKEN], ['set', TOKEN], ['set', 'github.token', a, b], ['set', `-${TOKEN}`], ['set', palabra], ['set', 'solidtime.tokn', a, b], ['set', 'paths.team', 'x', TOKEN]]) {
    const r = harness(args, home);
    assert.strictEqual(r.status, 2, args.join(' '));
    for (const part of [a, b, TOKEN, palabra]) assert.ok(!(r.stdout + r.stderr).includes(part), `${args.join(' ')}: no repite lo que se le pasó`);
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

// ── Clockify como integración: sus hooks, su despachador y las máquinas de hoy ─────────────────────────────────────────────────────────────────────────────

const AH = require(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'));
const LIST = path.join(ROOT, 'scripts', 'setup', 'hooks-list.json');
const INTS = path.join(ROOT, 'integrations');
// los hooks de las integraciones de horas (las de prender y apagar, como los instintos, se miden en integrations-toggle)
const intSpecs = (hooks) => hooks.map((h) => h.spec).filter((s) => /^@int:(clockify|solidtime)\//.test(s)).sort();
const decideFor = (list, timeTracking) => AH.decide(list, { env: {}, integ: { state: 'ok', values: {}, timeTracking }, profile: { state: 'ok', value: 'full' }, minimalIds: null, platform: 'posix' });
const CLOCKIFY_CLAUDE = ['@int:clockify/scripts/on-prompt.js', '@int:clockify/scripts/touch-activity.js'];
const SOLIDTIME_CLAUDE = ['@int:solidtime/scripts/on-activity.js', '@int:solidtime/scripts/on-prompt.js'];
// la carpeta de skills de una instalación de hoy, donde vivía clocki (una carpeta temporal, no la de nadie)
const OLD_SKILLS = path.join(os.tmpdir(), 'acme-casa', '.claude', 'agent-skills', 'skills');

test('Installer_RegistersOnlyChosenHooks @story-7.40 @ac-3 @ac-16', () => {
  const list = AH.loadList(LIST, { integrationsDir: INTS });
  assert.deepStrictEqual(intSpecs(decideFor(list, 'none').active), [], 'sin herramienta: ningún hook de horas');
  assert.deepStrictEqual(intSpecs(decideFor(list, 'clockify').active), CLOCKIFY_CLAUDE, 'con Clockify: los suyos');
  assert.deepStrictEqual(intSpecs(decideFor(list, 'solidtime').active), SOLIDTIME_CLAUDE, 'con Solidtime: los suyos, ninguno de Clockify');
  for (const s of [...CLOCKIFY_CLAUDE, ...SOLIDTIME_CLAUDE]) assert.ok(decideFor(list, 'none').known.includes(s), `${s}: sin elegir, se saca si estaba`);
  assert.ok(!list.hooks.some((h) => /(^|\/)clocki\//.test(h.spec)), 'la lista del núcleo ya no nombra la carpeta vieja');
  // el lado Codex, con la configuración de una casa de laboratorio
  const DCH = require(path.join(ROOT, 'build', 'deploy-codex-hooks.js'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  const commands = (frag) => Object.values(frag.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command);
  for (const [value, n, s] of [['none', 0, 0], ['clockify', 3, 0], ['solidtime', 0, 2]]) {
    const home = casa();
    const r = DCH.activeFragment(raw, { env: env(home, { TYCON_TIME_TRACKING: value }), tcg: ROOT });
    const ours = commands(r.fragment).filter((c) => c.includes('integrations/clockify/'));
    assert.strictEqual(ours.length, n, `Codex con ${value}: ${n} hooks de Clockify (dio ${ours.length})`);
    const theirs = commands(r.fragment).filter((c) => c.includes('integrations/solidtime/'));
    assert.strictEqual(theirs.length, s, `Codex con ${value}: ${s} hooks de Solidtime (dio ${theirs.length})`);
    assert.ok(!commands(r.fragment).some((c) => /skills\/clocki\//.test(c)), 'Codex ya no nombra la carpeta vieja');
  }
  // la llave vieja sola sigue eligiendo Clockify
  const viejo = casa();
  const r = DCH.activeFragment(raw, { env: env(viejo, { TYCON_CLOCKIFY: '1' }), tcg: ROOT });
  assert.strictEqual(commands(r.fragment).filter((c) => c.includes('integrations/clockify/')).length, 3);
});

function hookCommands(settings) {
  return Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command);
}

test('Installer_MovesOldClockiHooks @story-7.40 @ac-5', () => {
  const list = AH.loadList(LIST, { integrationsDir: INTS });
  const old = (s) => ({ type: 'command', command: `node "${OLD_SKILLS}/clocki/scripts/${s}"` });
  const settings = { hooks: {
    UserPromptSubmit: [{ matcher: '', hooks: [old('on-prompt.js')] }],
    PostToolUse: [{ matcher: '', hooks: [Object.assign(old('touch-activity.js'), { async: true })] }, { matcher: 'Edit|Write', hooks: [old('clocki-enforce.js')] }],
    SessionStart: [{ matcher: '', hooks: [old('sweep.js')] }],
  } };
  const o = { list, decision: decideFor(list, 'clockify'), platform: 'posix', hooksDir: path.join(ROOT, 'scripts', 'hooks'), skills: path.join(ROOT, 'skills'), integrationsDir: INTS, env: {} };
  AH.applyToSettings(settings, o);
  let cmds = hookCommands(settings);
  assert.ok(!cmds.some((c) => c.includes('/skills/clocki/')), `ninguna ruta vieja queda: ${cmds.filter((c) => c.includes('clocki/')).join(' | ')}`);
  for (const s of ['on-prompt.js', 'touch-activity.js']) {
    assert.strictEqual(cmds.filter((c) => c.includes(`integrations/clockify/scripts/${s}`)).length, 1, `${s}: una vez, con la ruta nueva`);
  }
  // correrlo otra vez no duplica nada
  AH.applyToSettings(settings, Object.assign({}, o, { decision: decideFor(list, 'clockify') }));
  cmds = hookCommands(settings);
  for (const s of ['on-prompt.js', 'touch-activity.js']) assert.strictEqual(cmds.filter((c) => c.includes(`integrations/clockify/scripts/${s}`)).length, 1);
  // elegir otra herramienta saca los de Clockify
  AH.applyToSettings(settings, Object.assign({}, o, { decision: decideFor(list, 'solidtime') }));
  assert.ok(!hookCommands(settings).some((c) => c.includes('integrations/clockify/')));
});

test('Clockify_Manifest_CarriesHooksAndDispatch @story-7.40 @ac-4', () => {
  const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
  const { manifests, problems } = INT.listManifests({ dir: INTS });
  assert.deepStrictEqual(problems, [], 'los manifiestos valen');
  const m = manifests.find((x) => x.name === 'clockify');
  assert.ok(m, 'integrations/clockify/integration.json existe');
  assert.strictEqual(m.kind, 'timeTracking');
  assert.strictEqual(m.label, 'Clockify');
  const scripts = m.hooks.map((h) => h.script).sort();
  assert.deepStrictEqual(scripts, ['scripts/on-prompt.js', 'scripts/sweep.js', 'scripts/touch-activity.js']);
  assert.deepStrictEqual(m.dispatch.map((d) => [d.on, d.script]), [['post-edit', 'scripts/clocki-enforce.js']]);
  for (const f of [...scripts, 'scripts/clocki-enforce.js', 'scripts/lib.js', m.onWork && path.relative(m.dir, m.onWork), 'skills/clocki/SKILL.md']) {
    assert.ok(f && fs.existsSync(path.join(m.dir, f)), `${f} existe en la integración`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'skills', 'clocki')), 'skills/clocki/ ya no está');
  for (const f of ['install-clocki-hooks.sh', 'install-clocki-hooks.ps1']) assert.ok(!fs.existsSync(path.join(m.dir, 'scripts', f)), `${f} se borró`);
  // el despachador carga la entrada del manifiesto sólo con Clockify elegida
  const D = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'dispatch.js');
  for (const [value, n] of [['clockify', 1], ['none', 0], ['solidtime', 0]]) {
    const home = casa();
    const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(D)}).integrationEntries('post-edit')))`], { env: env(home, { TYCON_GUIDES_DIR: ROOT, TYCON_TIME_TRACKING: value }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const entries = JSON.parse(r.stdout);
    assert.strictEqual(entries.length, n, `${value}: ${n} entrada(s) del despachador`);
    if (n) { assert.strictEqual(entries[0].name, 'clocki-enforce'); assert.ok(fs.existsSync(entries[0].path)); assert.strictEqual(entries[0].integration, 'clockify'); }
  }
});

test('Clockify_OldStateStillFound @story-7.40 @ac-5', () => {
  const home = casa();
  const sid = 'ses-vieja';
  const cwd = path.join(home, 'acme-repo');
  fs.mkdirSync(cwd);
  const dir = path.join(home, '.claude', 'clocki', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const key = require(path.join(INTS, 'clockify', 'scripts', 'lib.js')).normalizeCwd(cwd);
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ [key]: { entryId: 'ent-123', workspaceId: 'ws-1', projectId: 'prj-1', description: 'Story 7.40 — algo', startedAt: '2026-10-21T09:00:00', lastActivity: '2026-10-21T09:30:00', source: 'tycon-pipeline' } }));
  const onWork = path.join(INTS, 'clockify', 'scripts', 'on-work.js');
  const run = (event, h = home) => spawnSync(process.execPath, [onWork], { env: env(h), encoding: 'utf8', input: JSON.stringify({ event, storyId: '7.40', title: 'algo', repo: cwd, sessionId: sid, at: '2026-10-21T12:40:00Z', stateDir: path.join(h, '.tycon', 'state', 'time-tracking', 'clockify'), settings: {}, missing: [] }) });
  const stop = run('stop');
  assert.strictEqual(stop.status, 0, stop.stderr);
  const out = JSON.parse(stop.stdout.trim());
  assert.match(out.action || '', /ent-123/, 'la entrada abierta en el estado de siempre se encuentra');
  assert.match(out.action, /update-clockify-time-entry/, 'y se le dice al agente cómo cerrarla con el MCP');
  const start = JSON.parse(run('start').stdout.trim());
  assert.match(start.action || '', /create-clockify-time-entry|ya hay una entrada abierta/, 'start le dice al agente qué hacer');
  assert.match(out.action, /list-clockify-time-entries/, 'y que sume las entradas de la historia para CompletedWork');
  // sin estado, stop no tiene nada que cerrar, pero las entradas de la historia (cerradas por inactividad) se suman igual
  const vacio = casa();
  const r = JSON.parse(run('stop', vacio).stdout.trim());
  assert.doesNotMatch(r.action || '', /update-clockify-time-entry/);
  assert.match(r.action || '', /list-clockify-time-entries.*7\.40|7\.40.*list-clockify-time-entries/);
});

// ── Los manifiestos y sus rutas: un manifiesto mal escrito queda roto con aviso, nunca frena la instalación ─────────

/** Una carpeta de integraciones con `acme` (de horas) y los hooks dados. */
function intDir(hooks, extra = {}) {
  const dir = tmp('ttc-int-');
  fs.mkdirSync(path.join(dir, 'acme', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'acme', 'scripts', 'h.js'), '');
  fs.writeFileSync(path.join(dir, 'acme', 'integration.json'), JSON.stringify(Object.assign({ name: 'acme', label: 'De mentira', kind: 'timeTracking', hooks }, extra)));
  return dir;
}
const GOOD = { event: 'UserPromptSubmit', script: 'scripts/h.js', label: 'aviso', platforms: { windows: true } };

test('Manifest_BadShape_IsBrokenNotFatal @story-7.40 @ac-4', () => {
  const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
  const bad = [
    ['evento fuera del vocabulario', { event: 'OnSave' }],
    ['pasos mal escritos', { steps: ['tres y medio'] }],
    ['efecto desconocido', { effect: 'explota' }],
    ['async falso', { async: false }],
    ['ruta con ..', { script: '../fuera.js' }],
    ['ruta con barra invertida', { script: 'scripts\\h.js' }],
    ['ruta con espacio', { script: 'scripts/h h.js' }],
    ['ruta con punto y coma', { script: 'scripts/h.js;rm' }],
    ['ruta con comillas', { script: 'scripts/"h.js' }],
    ['herramienta desconocida', { tools: ['vim'] }],
  ];
  for (const [what, patch] of bad) {
    const dir = intDir([Object.assign({}, GOOD, patch)]);
    const { manifests, problems } = INT.listManifests({ dir });
    assert.deepStrictEqual(manifests, [], `${what}: no se usa`);
    assert.strictEqual(problems.length, 1, `${what}: queda como roto`);
    // el instalador no se cae: sigue con la lista del núcleo y dice cuál está roto
    let list;
    assert.doesNotThrow(() => { list = AH.loadList(LIST, { integrationsDir: dir }); }, `${what}: la instalación no frena`);
    assert.ok(!list.hooks.some((h) => String(h.spec).startsWith('@int:acme/')), `${what}: sus hooks no entran`);
    assert.ok(list.warnings.some((w) => /«acme» tiene el manifiesto roto/.test(w)), `${what}: se dice (${list.warnings})`);
  }
  // una entrada del despachador mal escrita, igual
  const d = intDir([GOOD], { dispatch: [{ on: 'post-edit', name: 'acme-x', script: 'scripts/h.js', effect: 'explota' }] });
  assert.strictEqual(INT.listManifests({ dir: d }).problems.length, 1, 'despachador con efecto desconocido: roto');
  // el bueno sí vale
  assert.strictEqual(INT.listManifests({ dir: intDir([GOOD]) }).manifests.length, 1);
});

test('IntSpec_UnsafePaths_Rejected @story-7.40 @ac-4', () => {
  const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
  for (const s of ['@int:acme/../x.js', '@int:acme/a/../../x.js', '@int:acme/a\\b.js', '@int:acme/a b.js', '@int:acme/a.js;rm', '@int:Acme/a.js', '@int:acme/', '@int:/a.js', '@int:acme/./a.js', 'acme/a.js']) {
    assert.strictEqual(INT.parseIntSpec(s), null, `${s}: no es un spec de integración`);
  }
  assert.deepStrictEqual(INT.parseIntSpec('@int:acme/scripts/h.js'), { name: 'acme', rel: 'scripts/h.js' });
  assert.strictEqual(INT.intSpecRepoPath('@int:acme/scripts/h.js'), 'integrations/acme/scripts/h.js');
  // la revisión del instalador no sale de la carpeta de la integración
  const HE = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'health.js'));
  assert.strictEqual(HE.hookFile('@int:clockify/../../scripts/hooks/x.js', { tree: ROOT, skillsDir: path.join(ROOT, 'skills') }), null);
  assert.strictEqual(HE.hookFile('@int:clockify/scripts/on-prompt.js', { tree: ROOT, skillsDir: path.join(ROOT, 'skills') }), path.join(ROOT, 'integrations', 'clockify', 'scripts', 'on-prompt.js'));
  // los registros que salen de un manifiesto
  const m = INT.listManifests({ dir: INTS }).manifests.find((x) => x.name === 'clockify');
  const claude = INT.hookEntries(m, { tool: 'claude' });
  assert.deepStrictEqual(claude.map((h) => h.spec).sort(), CLOCKIFY_CLAUDE);
  assert.ok(claude.every((h) => h.when === 'time:clockify' && typeof h.platforms.windows === 'boolean'));
  assert.deepStrictEqual(INT.hookEntries(m, { tool: 'codex' }).map((h) => h.spec).sort(), [...CLOCKIFY_CLAUDE, '@int:clockify/scripts/sweep.js'].sort());
  const [d] = INT.dispatchEntries(m, 'post-edit');
  assert.deepStrictEqual([d.name, d.integration, d.path], ['clocki-enforce', 'clockify', path.join(INTS, 'clockify', 'scripts', 'clocki-enforce.js')]);
  // una integración que no es de horas no suma hooks al instalador
  assert.deepStrictEqual(INT.hookEntries(Object.assign({}, m, { kind: 'notify' })), []);
  // la cuenta de Node del arnés incluye los guiones de las integraciones
  const HN = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'harness-node.js'));
  const listed = HN.listedHookPaths(ROOT);
  for (const s of ['on-prompt.js', 'touch-activity.js']) assert.ok(listed.includes(`integrations/clockify/scripts/${s}`), s);
});

test('Installer_ConfigUnreadable_KeepsClockifyHooks @story-7.40 @ac-5', () => {
  const list = AH.loadList(LIST, { integrationsDir: INTS });
  // una carpeta de skills de antes que todavía tiene clocki (otro clon sin actualizar), y una que ya no lo tiene
  const alive = path.join(tmp('ttc-old-'), 'skills');
  for (const s of ['on-prompt.js', 'touch-activity.js']) { fs.mkdirSync(path.join(alive, 'clocki', 'scripts'), { recursive: true }); fs.writeFileSync(path.join(alive, 'clocki', 'scripts', s), '// viejo\n'); }
  const settingsFrom = (dir) => {
    const old = (s) => ({ type: 'command', command: `node "${dir}/clocki/scripts/${s}"` });
    return { hooks: { UserPromptSubmit: [{ matcher: '', hooks: [old('on-prompt.js')] }], PostToolUse: [{ matcher: '', hooks: [old('touch-activity.js')] }] } };
  };
  // sin saber qué herramienta eligió (configuración ilegible): los hooks de horas quedan como están, también los viejos
  const decision = AH.decide(list, { env: {}, integ: { state: 'ok', values: {}, timeTracking: null }, profile: { state: 'ok', value: 'full' }, minimalIds: null, platform: 'posix' });
  for (const s of CLOCKIFY_CLAUDE) assert.ok(decision.leave.has(s), `${s}: queda como está`);
  const opts = { list, decision, platform: 'posix', hooksDir: path.join(ROOT, 'scripts', 'hooks'), skills: path.join(ROOT, 'skills'), integrationsDir: INTS, env: {} };
  const settings = settingsFrom(alive);
  AH.applyToSettings(settings, opts);
  let cmds = hookCommands(settings);
  for (const s of ['on-prompt.js', 'touch-activity.js']) assert.ok(cmds.some((c) => c.includes(`skills/clocki/scripts/${s}`)), `${s}: Clockify no se queda sin su hook`);
  // con el archivo viejo ya movido, la ruta vieja sólo daría error: sale, y el hook vuelve en su ruta nueva, una vez
  const gone = settingsFrom(OLD_SKILLS);
  AH.applyToSettings(gone, Object.assign({}, opts, { decision: AH.decide(list, { env: {}, integ: { state: 'ok', values: {}, timeTracking: null }, profile: { state: 'ok', value: 'full' }, minimalIds: null, platform: 'posix' }) }));
  cmds = hookCommands(gone);
  assert.ok(!cmds.some((c) => c.includes('/clocki/scripts/')), `ninguna ruta muerta: ${cmds.filter((c) => /clock/.test(c)).join(' | ')}`);
  for (const s of ['on-prompt.js', 'touch-activity.js']) assert.strictEqual(cmds.filter((c) => c.includes(`integrations/clockify/scripts/${s}`)).length, 1, `${s}: vuelve en su ruta nueva`);
  // el lector: una respuesta con otra forma, o que falla, no es «ninguna»
  const fake = (tt) => (args) => (args[0] === 'integrations' ? { status: 0, stdout: 'TYCON_INTEG_CLOCKIFY=0\n' } : (args[0] === 'time-tracking' ? tt : { status: 3, stdout: '' }));
  const libDir = path.join(ROOT, 'scripts', 'lib');
  const raro = AH.readConfig({ libDir, runConfig: fake({ status: 0, stdout: 'Click Up\n' }) });
  assert.strictEqual(raro.integ.timeTracking, null);
  assert.match(raro.integ.timeTrackingProblem, /no se entiende/);
  const falla = AH.readConfig({ libDir, runConfig: fake({ status: 2, stdout: '' }) });
  assert.strictEqual(falla.integ.timeTracking, null);
  assert.match(falla.integ.timeTrackingProblem, /no pude leer/);
  assert.strictEqual(AH.readConfig({ libDir, runConfig: fake({ status: 0, stdout: 'solidtime\n' }) }).integ.timeTracking, 'solidtime');
});

test('TimeTrackingCli_SaysChosenOrFails @story-7.40 @ac-3', () => {
  const CLI = path.join(ROOT, 'scripts', 'lib', 'tycon-config.js');
  const ask = (home, extra) => spawnSync(process.execPath, [CLI, 'time-tracking'], { env: env(home, extra), encoding: 'utf8' });
  assert.strictEqual(ask(casa(), {}).stdout.trim(), 'none', 'sin nada: none');
  assert.strictEqual(ask(casa(), { TYCON_TIME_TRACKING: 'solidtime' }).stdout.trim(), 'solidtime');
  const viejo = casa();
  machineFile(viejo, { integrations: { clockify: true } });
  assert.strictEqual(ask(viejo, {}).stdout.trim(), 'clockify', 'la llave vieja elige Clockify');
  const roto = casa();
  fs.writeFileSync(path.join(roto, '.claude', 'tycon.json'), '{ roto');
  const r = ask(roto, {});
  assert.strictEqual(r.status, 2, 'configuración rota: sale 2');
  assert.strictEqual(r.stdout, '', 'y no dice ninguna herramienta');
});

test('Dispatch_ChosenMissingOrBroken_Warns @story-7.40 @ac-4', () => {
  const D = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'dispatch.js');
  const run = (extra) => spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(D)}).integrationEntries('post-edit')))`], { env: env(casa(), Object.assign({ TYCON_GUIDES_DIR: ROOT }, extra)), encoding: 'utf8' });
  const falta = run({ TYCON_TIME_TRACKING: 'harvest' });
  assert.strictEqual(falta.stdout, '[]');
  assert.match(falta.stderr, /no suma sus controles \(no encuentro «harvest»/);
  const rota = intDir([Object.assign({}, GOOD, { event: 'OnSave' })]);
  const r = run({ TYCON_TIME_TRACKING: 'acme', TYCON_INTEGRATIONS_DIR: rota });
  assert.strictEqual(r.stdout, '[]');
  assert.match(r.stderr, /«acme» tiene el manifiesto roto/);
  // ninguna elegida: callado
  assert.strictEqual(run({ TYCON_TIME_TRACKING: 'none' }).stderr, '');
});

test('Skills_OnlyChosenIntegrationLinked @story-7.40 @ac-4', () => {
  const show = (lib, call, extra) => {
    const r = spawnSync(process.execPath, ['-e', `const L=require(${JSON.stringify(lib)});process.stdout.write(JSON.stringify(${call}))`], { env: env(casa(), extra), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const clocki = path.join(INTS, 'clockify', 'skills', 'clocki');
  const DSS = path.join(ROOT, 'build', 'deploy-shared-skills.js');
  const con = show(DSS, `L.withIntegrationSkills(${JSON.stringify(ROOT)}, null)`, { TYCON_TIME_TRACKING: 'clockify' });
  assert.deepStrictEqual(con.extra.map((e) => [e.name, e.src]), [['clocki', clocki]], 'elegida: /clocki se enlaza');
  assert.strictEqual(con.intRoot, INTS, 'un enlace a integrations/ es del arnés');
  const sin = show(DSS, `L.withIntegrationSkills(${JSON.stringify(ROOT)}, null)`, { TYCON_TIME_TRACKING: 'solidtime' });
  assert.deepStrictEqual(sin.extra, []);
  assert.ok(sin.retire.includes(clocki), 'otra elegida: /clocki se retira');
  const CP = path.join(ROOT, 'scripts', 'lib', 'canonical-path.js');
  const call = `L.packEntries({ tree: ${JSON.stringify(ROOT)}, given: ${JSON.stringify(ROOT)}, home: process.env.HOME })`;
  const cpCon = show(CP, call, { TYCON_TIME_TRACKING: 'clockify' });
  assert.ok(cpCon.extra.skills.some((e) => e.name === 'clocki' && e.src === clocki), 'el lugar canónico, igual');
  const cpSin = show(CP, call, { TYCON_TIME_TRACKING: 'none' });
  assert.ok(cpSin.retire.skills.includes(clocki) && cpSin.retireNames.skills.includes('clocki'));
  assert.strictEqual(cpSin.owner['skills/clocki'], 'clockify');
});

test('Codex_IntegrationHooks_KnownFromAnyClone @story-7.40 @ac-4 @ac-16', () => {
  const DCH = require(path.join(ROOT, 'build', 'deploy-codex-hooks.js'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  const deOtroClon = 'node /otra/copia/integrations/clockify/scripts/on-prompt.js';
  assert.ok(DCH.plantillas(DCH.withIntegrationHooks(raw, ROOT).raw).some((re) => re.test(deOtroClon)), 'un hook de la integración desplegado desde otro clon se reconoce (no queda duplicado)');
  // un manifiesto roto no suma hooks a Codex y se dice
  const rota = intDir([Object.assign({}, GOOD, { script: 'scripts/h.js;rm' })]);
  const tree = tmp('ttc-tree-');
  fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'scripts', 'lib'), path.join(tree, 'scripts', 'lib'));
  fs.symlinkSync(rota, path.join(tree, 'integrations'));
  const w = DCH.withIntegrationHooks(raw, tree);
  assert.deepStrictEqual(w.entries, []);
  assert.ok(w.broken.some((b) => /«acme» tiene el manifiesto roto/.test(b)));
  assert.ok(!JSON.stringify(w.raw).includes(';rm'), 'nada del manifiesto roto llega a un comando');
});

test('IntegrationsLib_UnloadableOrUnreadable_IsSaid @story-7.40 @ac-4', (t) => {
  // un árbol cuya biblioteca de integraciones está y no carga: cada lector lo dice en vez de seguir sin integraciones
  const tree = tmp('ttc-rota-');
  fs.mkdirSync(path.join(tree, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'lib', 'integrations.js'), 'module.exports = {;\n');
  fs.mkdirSync(path.join(tree, 'integrations'));
  const raw = { hooks: {} };
  const codex = require(path.join(ROOT, 'build', 'deploy-codex-hooks.js')).withIntegrationHooks(raw, tree);
  assert.ok(codex.broken.some((b) => /no pude cargar integrations\.js/.test(b)), 'Codex lo dice');
  const DSS = path.join(ROOT, 'build', 'deploy-shared-skills.js');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(DSS)}).withIntegrationSkills(${JSON.stringify(tree)}, null)`], { env: env(casa()), encoding: 'utf8' });
  assert.match(r.stderr, /no pude cargar integrations\.js/, 'el despliegue de skills lo dice');
  const HIW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  assert.ok(HIW.readControls(tree).problems.some((p) => /integrations\.js/.test(p.spec) && /no se pudo cargar/.test(p.message)), '«Cómo trabaja» lo dice');
  // sin la biblioteca en el árbol, callados
  const sin = tmp('ttc-sin-');
  assert.deepStrictEqual(require(path.join(ROOT, 'build', 'deploy-codex-hooks.js')).withIntegrationHooks(raw, sin).broken, []);
  // una carpeta de integraciones que no se puede leer no es «sin integraciones»
  if (process.platform === 'win32' || process.getuid() === 0) { t.diagnostic('sin chmod que corte la lectura en esta plataforma'); return; }
  const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
  const cerrada = intDir([GOOD]);
  fs.chmodSync(cerrada, 0o000);
  try {
    const l = INT.listManifests({ dir: cerrada });
    assert.deepStrictEqual(l.manifests, []);
    assert.match(l.problems[0].reasons[0], /no se puede leer/);
  } finally { fs.chmodSync(cerrada, 0o755); }
});

test('ManagedCounts_BrokenManifest_IsSaid @story-7.40 @ac-4', () => {
  // un árbol con los guiones de éste y una carpeta de integraciones propia: Clockify sana y «acme», de horas, rota
  const tree = tmp('ttc-arbol-');
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(tree, 'scripts'), 'dir');
  fs.mkdirSync(path.join(tree, 'integrations', 'acme'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'integrations', 'clockify'), path.join(tree, 'integrations', 'clockify'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'integrations', 'acme', 'integration.json'), JSON.stringify({ name: 'acme', label: 'Acme', kind: 'timeTracking', hooks: [{ event: 'Nunca', script: 'scripts/x.js', label: 'x', platforms: { windows: true } }] }));
  const M = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js'));
  const HN = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'harness-node.js'));
  // la cuenta del instalador: sigue contando lo sano y dice el roto con su nombre
  const e = M.expectedControls({ platform: 'darwin', tree, integrations: {}, env: {}, home: casa() });
  assert.ok([...e.expected, ...e.off, ...e.unknown].some((x) => /clockify/.test(x.relpath || x.id)), `lo sano se sigue contando: ${JSON.stringify(e)}`);
  assert.ok(e.problems.some((p) => /acme/.test(p) && /manifiesto/.test(p)), `el roto se dice: ${JSON.stringify(e.problems)}`);
  // la del Node del arnés: los guiones de lo sano, y el roto en sus problemas
  const problemas = [];
  const listed = HN.listedHookPaths(tree, problemas);
  assert.ok(listed.includes('integrations/clockify/scripts/on-prompt.js'));
  assert.ok(problemas.some((p) => /acme/.test(p) && /manifiesto/.test(p)), `el roto se dice: ${JSON.stringify(problemas)}`);
  // sin la biblioteca de integraciones (un árbol viejo): callado, como siempre
  const viejo = tmp('ttc-viejo-');
  fs.mkdirSync(path.join(viejo, 'scripts', 'setup'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), path.join(viejo, 'scripts', 'setup', 'hooks-list.json'));
  const sinProblemas = [];
  assert.ok(Array.isArray(HN.listedHookPaths(viejo, sinProblemas)));
  assert.deepStrictEqual(sinProblemas, []);
  for (const d of [tree, viejo]) fs.rmSync(d, { recursive: true, force: true });
});

// ── El recordatorio de horas viaja en el prompt: corto, con las reglas que no pueden faltar ──────────────────────────
// Antes pesaba ~4.600 bytes en cada prompt en que hablaba (1.539 veces en una semana de una máquina). Los pasos
// largos viven en la skill clocki; el recordatorio dispara y conserva lo que no se puede perder: preguntar antes de
// abrir, la hora local, el fin igual al inicio y el archivo propio de la sesión.
function recordatorio(prompt, activo) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clocki-recordatorio-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clocki-cwd-')));
  fs.mkdirSync(path.join(home, '.claude', 'clocki', 'active'), { recursive: true });
  if (activo) {
    // stable-data: el timer tiene que estar fresco para que el recordatorio no lo dé por inactivo; la fecha no se afirma
    const ahora = new Date().toISOString().slice(0, 19);
    fs.writeFileSync(path.join(home, '.claude', 'clocki', 'active', 's1.json'), JSON.stringify({ [cwd]: {
      entryId: 'e1', workspaceId: 'w1', projectId: 'p1', description: 'story 7.53 medidor', startedAt: ahora, lastActivity: ahora } }));
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'integrations', 'clockify', 'scripts', 'on-prompt.js')],
    { input: JSON.stringify({ cwd, session_id: 's1', prompt }), encoding: 'utf8', env: { ...process.env, HOME: home, TYCON_EVAL_SANDBOX: '' } });
  for (const d of [home, cwd]) fs.rmSync(d, { recursive: true, force: true });
  return r.stdout;
}

test('Recordatorio_Arranque_CortoConLasReglasClave @story-7.53', () => {
  const out = recordatorio('implementemos la story 9.9 del tablero', false);
  assert.match(out, /clocki/, out);
  assert.ok(Buffer.byteLength(out) < 1600, `pesa ${Buffer.byteLength(out)} bytes:\n${out}`);
  assert.match(out, /pregunt/i, 'tiene que pedir confirmación antes de abrir');
  assert.match(out, /hora local/i, out);
  assert.match(out, /date "\+%Y-%m-%dT%H:%M:%S"/, out);
  assert.match(out, /igual al inicio/i, out);
  assert.match(out, /active\/s1\.json/, 'el archivo propio de la sesión');
  assert.match(out, /skill clocki/i, 'el detalle, en la skill');
});

test('Recordatorio_Cierre_CortoConLasReglasClave @story-7.53', () => {
  const out = recordatorio('listo, cerremos', true);
  assert.match(out, /e1/, out);
  assert.ok(Buffer.byteLength(out) < 1600, `pesa ${Buffer.byteLength(out)} bytes:\n${out}`);
  assert.match(out, /cerr/i, out);
  assert.match(out, /otra tarea/i, 'la transición atómica');
  assert.match(out, /skill clocki/i, out);
});
