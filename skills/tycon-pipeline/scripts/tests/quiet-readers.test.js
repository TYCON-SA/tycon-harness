'use strict';
/**
 * quiet-readers.test.js — lectores que leían mal o callaban, y daban por bueno lo que no midieron.
 *
 * Lo que no se puede perder:
 *   - Un grupo de rutas (`(app)/page.tsx`, una carpeta entre paréntesis de Next) es parte de la ruta: sólo el prefijo
 *     «(repo) », con su espacio, se quita. Vale para la lista de validadores de `pipeline.js`, las rutas a modificar de
 *     `compare-previous.js` y las rutas de una entrada en `ui-signal.js`, igual que en `normRuta` de `batch-scope.js`.
 *   - Si el despachador de ediciones no puede cargar uno de sus normalizadores (`hook-io.js` del arnés o
 *     `path-shape.js`), sigue sin él, como antes, pero deja su línea `FAILED OPEN` con el nombre de la pieza.
 *   - `marker.js owner-away get` muestra la marca de ausente que no pudo confirmar (`unconfirmed`).
 *
 * 0 deps (node:test). Todo corre con una HOME de laboratorio y carpetas temporales.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const DISPATCH = path.join(SCRIPTS, 'dispatch.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const STATE_DIR_LIB = path.join(SCRIPTS, 'lib', 'state-dir.js');

const tmpDirs = [];
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `quiet-readers-${p}-`))); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const escribir = (base, rel, txt) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const envDe = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', ...extra });

function estadoDe(home) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(STATE_DIR_LIB)}).stateDir(process.env.HOME))`],
    { env: envDe(home), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// ── DEF-8.272: el grupo de rutas no es el prefijo del repo ───────────────────────────────────────────────────────────

test('T1 RouteGroup_CompareRutasAModificar_KeepsTheGroup — «(app)/page.tsx» sigue entero; «(repo) x» pierde el prefijo', () => {
  const { rutasAModificar } = require(path.join(SCRIPTS, 'lib', 'compare-previous.js'));
  const historia = ['---', 'story: "9.1"', 'files_to_modify:', '  - (app)/page.tsx', '  - (público) cli.js', '  - "(auth)/login/page.tsx"', '---', ''].join('\n');
  assert.deepStrictEqual(rutasAModificar(historia), ['(app)/page.tsx', 'cli.js', '(auth)/login/page.tsx']);
});

test('T2 RouteGroup_PipelineValidators_SeesTheGroup — un revisor de validación que pide «(app)/» entra con un grupo de rutas', () => {
  const home = tmp('home');
  const packs = tmp('packs');
  const agents = tmp('agents');
  escribir(packs, 'prueba/agents/revisor-de-grupos.md', '---\nname: revisor-de-grupos\ndescription: prueba\ntools: Read\n---\n# prueba\n');
  escribir(packs, 'prueba/pack.json', JSON.stringify({
    name: 'prueba', description: 'de prueba', guides: [],
    reviewers: [{ agent: 'revisor-de-grupos', group: 'validacion', when: { files: '^\\(app\\)/' }, prompt: 'Story {story_path}', prefixes: ['PRG'] }],
  }));
  const repo = tmp('repo');
  const story = escribir(repo, 'specs/story-9.2-grupos.md', ['---', 'story: "9.2"', 'title: "grupos"', 'status: ready-for-dev',
    'files_to_modify:', '  - (app)/page.tsx', '---', '', '# Story 9.2', ''].join('\n'));
  const r = spawnSync(process.execPath, [PIPELINE, 'validators', '--story', story, '--repo', repo], {
    encoding: 'utf8', timeout: 60000,
    env: envDe(home, { TYCON_SESSION_ID: 'quiet-readers', TYCON_PACKS_DEFAULT: 'all', TYCON_PACKS_DIR: packs, TYCON_AGENTS_DIR: agents, TYCON_REPOS_ROOT: tmp('raiz') }),
  });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.ok(json.lanzamientos.some((l) => l.agente === 'revisor-de-grupos'), JSON.stringify(json.lanzamientos));
});

test('T3 RouteGroup_UiSignal_KeepsTheGroup — un nombre de front declarado con su grupo de rutas se encuentra en una entrada con prosa', () => {
  const ui = require(path.join(SCRIPTS, 'lib', 'ui-signal.js'));
  const repo = tmp('repo-ui');
  fs.mkdirSync(path.join(repo, '.git'));
  escribir(repo, '.tycon/advisors.yaml', 'evidence:\n  fe_paths:\n    - "(app)/portal"\n');
  const historia = ['---', 'story: "9.3"', 'files_to_modify:', '  - (app)/portal/handler.go — el portal nuevo', '---', '', '# Story 9.3', ''].join('\n');
  assert.equal(ui.storyTouchesUi(historia, repo), true, JSON.stringify(ui.uiSignalDetail(historia, repo)));
  // el prefijo de repo, con su espacio, sigue sin ser parte de la ruta
  const conPrefijo = ['---', 'story: "9.3"', 'files_to_modify:', '  - (app) portal/handler.go — el portal nuevo', '---', '', '# Story 9.3', ''].join('\n');
  assert.equal(ui.storyTouchesUi(conPrefijo, repo), false, JSON.stringify(ui.uiSignalDetail(conPrefijo, repo)));
});

// ── DEF-8.257: el normalizador que no carga deja su línea ────────────────────────────────────────────────────────────

// El guion del hijo: argv = dispatch.js, el sufijo de la pieza que no carga. Corta su carga y corre post-edit vacío.
const GUION_SIN_PIEZA = `
const Module = require('module');
const [dispatchPath, pieza] = process.argv.slice(2);
const cargar = Module._load;
Module._load = function (pedido, ...resto) {
  if (String(pedido).replace(/\\\\/g, '/').endsWith(pieza)) throw new Error('pieza rota de prueba');
  return cargar.call(this, pedido, ...resto);
};
const d = require(dispatchPath);
d.CHAINS['post-edit'].splice(0);
d.dispatch('post-edit');
`;

function sinPieza(pieza) {
  const home = tmp('home-dispatch');
  const dir = tmp('guion');
  const guion = escribir(dir, 'correr.js', GUION_SIN_PIEZA);
  const arnes = tmp('arnes');
  escribir(arnes, 'scripts/install-tycon-hooks.sh', '#!/bin/sh\n');   // lo que hace de la carpeta un clon del arnés
  escribir(arnes, 'scripts/lib/hook-io.js', 'module.exports = { editEventsFrom: (e) => [e] };\n');
  const input = JSON.stringify({ session_id: 'quiet-readers', tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(dir, 'x.md'), content: 'x' } });
  const r = spawnSync(process.execPath, [guion, DISPATCH, pieza], { env: envDe(home, { TYCON_GUIDES_DIR: arnes }), encoding: 'utf8', input });
  let log = '';
  try { log = fs.readFileSync(path.join(estadoDe(home), 'hook-errors.log'), 'utf8'); } catch (_) { /* sin registro */ }
  return { r, log };
}

test('T4 Dispatch_HookIoMissing_LeavesFailedOpen — sin hook-io.js sigue como antes y lo anota con el nombre de la pieza', () => {
  const { r, log } = sinPieza('scripts/lib/hook-io.js');
  assert.equal(r.status, 0, r.stderr);
  assert.match(log, /dispatch handler "normalizador hook-io\.js" FAILED OPEN: .*pieza rota de prueba/, log);
});

test('T5 Dispatch_PathShapeMissing_LeavesFailedOpen — sin path-shape.js sigue como antes y lo anota con el nombre de la pieza', () => {
  const { r, log } = sinPieza('lib/path-shape.js');
  assert.equal(r.status, 0, r.stderr);
  assert.match(log, /dispatch handler "normalizador path-shape\.js" FAILED OPEN: .*pieza rota de prueba/, log);
  // con todo cargado, ninguna línea de normalizador
  const sano = sinPieza('no-existe-esta-pieza.js');
  assert.doesNotMatch(sano.log, /normalizador/, sano.log);
});

// ── DEF-8.281: owner-away get muestra la marca que no pudo confirmar ─────────────────────────────────────────────────

test('T6 OwnerAwayGet_UnreadableLog_ShowsUnconfirmedMark — con gates.log ilegible, la marca sale aparte y se dice', () => {
  const home = tmp('home-oa');
  const estado = estadoDe(home);
  const oa = require(path.resolve(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'owner-away.js'));
  assert.ok(oa.set({ estado, quien: 'prueba', frase: 'me voy un rato' }).mark);
  fs.rmSync(path.join(estado, 'gates.log'), { force: true });
  fs.mkdirSync(path.join(estado, 'gates.log'));   // una carpeta en su lugar: ilegible en todo sistema
  const r = spawnSync(process.execPath, [MARKER, 'owner-away', 'get'], { env: envDe(home, { TYCON_SESSION_ID: 'quiet-readers' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(r.stdout);
  assert.equal(g.mark, null);
  assert.match(g.problem, /no pude leer gates\.log/);
  assert.ok(g.unconfirmed && g.unconfirmed.setAt, r.stdout);
  assert.match(r.stderr, /marca de ausente sin confirmar \(puesta .*\)/, r.stderr);
});
