'use strict';

/**
 * work-signal.test.js — el evento neutro de trabajo y la integración de horas que lo escucha.
 *
 * El núcleo sólo sabe que hay una carpeta `integrations/` con manifiestos: lee `integrations.timeTracking`, busca la
 * integración con ese nombre y `kind: "timeTracking"`, y le pasa el evento por la entrada estándar. Estas pruebas usan
 * una integración de mentira (`fake`) en una carpeta temporal (`TYCON_INTEGRATIONS_DIR`) que anota lo que recibe.
 *
 *   T1  · sin clave y con `none`: no corre ninguna integración y no escribe nada.
 *   T2  · `start` le llega a la integración con historia, título, repo y sesión.
 *   T3  · un valor desconocido o una integración sin carpeta: «integración de horas desconocida», no hace nada.
 *   T4  · el núcleo no suma nombres de herramientas de horas: la cuenta de archivos no pasa del techo.
 *   T23 · `activity` y `stop` llegan; `stop` devuelve los segundos que informa la integración.
 *
 * Nada toca el HOME real: cada caso arma su HOME, su TYCON_HOME y su carpeta de integraciones en el temporal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'work-signal.js');

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

/** Una integración de mentira que anota cada evento en `<dir>/fake/got.jsonl` y en `stop` devuelve 1080 segundos. */
function fakeIntegrations({ name = 'fake', kind = 'timeTracking' } = {}) {
  const dir = tmp('ws-int-');
  const own = path.join(dir, name);
  fs.mkdirSync(path.join(own, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(own, 'integration.json'), JSON.stringify({ name, label: 'De mentira', kind, onWork: 'scripts/on-work.js', hooks: [], dispatch: [], settings: [] }));
  fs.writeFileSync(path.join(own, 'scripts', 'on-work.js'), [
    "const fs = require('fs'); const path = require('path');",
    "let raw = ''; process.stdin.on('data', (c) => { raw += c; }); process.stdin.on('end', () => {",
    "  const ev = JSON.parse(raw);",
    "  fs.appendFileSync(path.join(__dirname, '..', 'got.jsonl'), JSON.stringify(ev) + '\\n');",
    "  process.stdout.write(JSON.stringify(ev.event === 'stop' ? { seconds: 1080 } : {}) + '\\n');",
    "});",
  ].join('\n'));
  return { dir, got: path.join(own, 'got.jsonl') };
}

function lab() {
  const home = tmp('ws-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, tyconHome: path.join(home, '.tycon') };
}

function run(args, { home, tyconHome, dir, extra = {} }) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_HOME: tyconHome, TYCON_PROFILE: '0', TYCON_INTEGRATIONS_DIR: dir }, extra);
  for (const k of ['TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30000 });
}

const EV = ['--story', '7.40', '--title', 'El registro de horas', '--repo', '/tmp/acme-repo', '--session', 'ses-1'];

test('WorkSignal_None_DoesNothing @story-7.40 @ac-3', () => {
  const f = fakeIntegrations();
  for (const extra of [{}, { TYCON_TIME_TRACKING: 'none' }]) {
    const l = lab();
    const r = run(['start', ...EV], Object.assign({}, l, { dir: f.dir, extra }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '{}', 'sin integración no devuelve nada');
    assert.strictEqual(r.stderr.trim(), '', 'sin integración no avisa nada');
    assert.ok(!fs.existsSync(f.got), 'la integración no corrió');
    assert.ok(!fs.existsSync(l.tyconHome), 'no escribió nada en la casa del arnés');
  }
});

test('WorkSignal_Start_PassesNeutralEvent @story-7.40 @ac-2', () => {
  const f = fakeIntegrations();
  const l = lab();
  const r = run(['start', ...EV], Object.assign({}, l, { dir: f.dir, extra: { TYCON_TIME_TRACKING: 'fake' } }));
  assert.strictEqual(r.status, 0, r.stderr);
  const got = fs.readFileSync(f.got, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.strictEqual(got.length, 1);
  const ev = got[0];
  assert.strictEqual(ev.event, 'start');
  assert.strictEqual(ev.storyId, '7.40');
  assert.strictEqual(ev.title, 'El registro de horas');
  assert.strictEqual(ev.repo, '/tmp/acme-repo');
  assert.strictEqual(ev.sessionId, 'ses-1');
  assert.match(ev.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'la hora va en UTC con Z, sin milésimas');
  assert.ok(ev.stateDir.startsWith(l.tyconHome), 'el estado de la integración va en la casa del arnés');
  assert.deepStrictEqual(ev.settings, {}, 'una integración que no pide ajustes no recibe ninguno');
});

test('WorkSignal_UnknownTool_TreatedAsNone @story-7.40 @ac-14', () => {
  const f = fakeIntegrations();
  for (const value of ['harvest', 'Fake ']) {
    const l = lab();
    const r = run(['start', ...EV], Object.assign({}, l, { dir: f.dir, extra: { TYCON_TIME_TRACKING: value } }));
    assert.strictEqual(r.status, 0, r.stderr);
    if (value === 'harvest') {
      assert.match(r.stderr, /integración de horas desconocida/);
      assert.match(r.stderr, /harvest/);
      assert.ok(!fs.existsSync(f.got));
    }
    assert.strictEqual(r.stdout.trim(), '{}');
  }
  // la carpeta de la integración elegida no existe
  const l = lab();
  const vacia = tmp('ws-int-vacia-');
  const r = run(['start', ...EV], Object.assign({}, l, { dir: vacia, extra: { TYCON_TIME_TRACKING: 'fake' } }));
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /integración de horas desconocida/);
  // una integración de otro tipo no cuenta como de horas
  const otra = fakeIntegrations({ kind: 'notify' });
  const r2 = run(['start', ...EV], Object.assign({}, lab(), { dir: otra.dir, extra: { TYCON_TIME_TRACKING: 'fake' } }));
  assert.match(r2.stderr, /integración de horas desconocida/);
  assert.ok(!fs.existsSync(otra.got));
  // un manifiesto roto no se confunde con «no existe»: el aviso dice qué tiene
  for (const [what, write] of [
    ['no se lee', (f) => fs.writeFileSync(f, '{ esto no es json')],
    ['kind con otras mayúsculas', (f) => fs.writeFileSync(f, JSON.stringify({ name: 'fake', label: 'De mentira', kind: 'timetracking', onWork: 'scripts/on-work.js' }))],
  ]) {
    const rota = fakeIntegrations();
    write(path.join(rota.dir, 'fake', 'integration.json'));
    const r3 = run(['start', ...EV], Object.assign({}, lab(), { dir: rota.dir, extra: { TYCON_TIME_TRACKING: 'fake' } }));
    assert.strictEqual(r3.status, 0, what);
    assert.match(r3.stderr, /«fake» tiene el manifiesto roto/, `${what}: ${r3.stderr}`);
    assert.ok(!fs.existsSync(rota.got), `${what}: no corre`);
  }
  // el guion que escucha no está: se dice eso, no «no terminó a tiempo»
  const sinGuion = fakeIntegrations();
  fs.rmSync(path.join(sinGuion.dir, 'fake', 'scripts', 'on-work.js'));
  const r4 = run(['start', ...EV], Object.assign({}, lab(), { dir: sinGuion.dir, extra: { TYCON_TIME_TRACKING: 'fake' } }));
  assert.strictEqual(r4.status, 0);
  assert.match(r4.stderr, /no encuentro el guion/);
  assert.doesNotMatch(r4.stderr, /a tiempo/);
});

// El techo: archivos del núcleo que nombran una herramienta de horas, fuera de las carpetas de integraciones, la vieja
// carpeta de la skill y las pruebas. Sólo baja: llega a 0 cuando la última integración sale del núcleo.
// Tampoco cuentan las capturas de la guía del sitio: son la página tal cual la guarda site-guide-captures.js, y la
// página de Configuración trae la sección de integraciones con sus nombres; no es núcleo escrito
const TOOL_NAMES_CEILING = 68;
const TOOL_NAMES_OUTSIDE_CORE = [':!integrations', ':!skills/clocki', ':!guides/integrations', ':!guides/sitio-de-la-organizacion/capturas',
  ':!**/tests/**', ':!**/*.test.*'];
/** Los archivos del núcleo que nombran una herramienta de horas en el clon `root`. `--untracked`: un archivo nuevo cuenta desde que existe. */
function coreFilesNamingTimeTool(root) {
  const r = spawnSync('git', ['-C', root, 'grep', '--untracked', '-il', '-E', 'clocki|clockify|solidtime', '--', '.', ...TOOL_NAMES_OUTSIDE_CORE], { encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `git grep falló: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

test('Core_NamesNoTimeTool_CapturesAreNotCore_NewCoreFileCounts @story-7.40 @ac-1 @story-2.71 — las capturas no cuentan; un archivo nuevo del núcleo sí', () => {
  // 🔴 rojo: la exclusión de las capturas se come también el núcleo, o una captura nueva vuelve a subir el conteo.
  const repo = tmp('nucleo-');
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.mkdirSync(path.join(repo, 'guides', 'sitio-de-la-organizacion', 'capturas'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'guides', 'sitio-de-la-organizacion', 'capturas', 'configuracion-x.html'), '<p>Clockify: registra las horas</p>\n');
  fs.writeFileSync(path.join(repo, 'guides', 'otra.md'), 'sin herramientas\n');
  assert.deepStrictEqual(coreFilesNamingTimeTool(repo), [], 'una captura de la guía no cuenta');
  fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'nuevo.js'), "// abre el reloj de clockify\n");
  fs.writeFileSync(path.join(repo, 'guides', 'sitio-de-la-organizacion', 'nota.md'), 'Clockify, al lado de las capturas\n');
  assert.deepStrictEqual(coreFilesNamingTimeTool(repo).sort(), ['guides/sitio-de-la-organizacion/nota.md', 'scripts/lib/nuevo.js'], 'un archivo nuevo del núcleo sí cuenta, también junto a la carpeta de capturas');
});

test('Core_NamesNoTimeTool @story-7.40 @ac-1', (t) => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) { t.skip('sin git: el árbol no es un clon'); return; }
  const files = coreFilesNamingTimeTool(ROOT);
  assert.ok(files.length <= TOOL_NAMES_CEILING, `el núcleo nombra una herramienta de horas en ${files.length} archivos (techo ${TOOL_NAMES_CEILING}): ${files.join(', ')}`);
  for (const own of ['scripts/lib/work-signal.js', 'scripts/lib/integrations.js']) assert.ok(!files.includes(own), `${own} no nombra ninguna herramienta`);
});

test('WorkSignal_StopAndActivity_Reach @story-7.40 @ac-2', () => {
  const f = fakeIntegrations();
  const l = lab();
  const o = Object.assign({}, l, { dir: f.dir, extra: { TYCON_TIME_TRACKING: 'fake' } });
  const a = run(['activity', ...EV], o);
  assert.strictEqual(a.status, 0, a.stderr);
  const s = run(['stop', ...EV], o);
  assert.strictEqual(s.status, 0, s.stderr);
  assert.deepStrictEqual(JSON.parse(s.stdout.trim()), { seconds: 1080 });
  const events = fs.readFileSync(f.got, 'utf8').trim().split('\n').map((x) => JSON.parse(x).event);
  assert.deepStrictEqual(events, ['activity', 'stop']);
  // una integración que en `stop` no dice segundos: `{}`
  const sinSegundos = run(['activity', ...EV], o);
  assert.strictEqual(sinSegundos.stdout.trim(), '{}');
  // un evento que no existe es un error de uso
  const mal = run(['pause', ...EV], o);
  assert.strictEqual(mal.status, 2);
});
