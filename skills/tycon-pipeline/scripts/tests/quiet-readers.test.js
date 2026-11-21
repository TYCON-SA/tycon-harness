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

// ── DEF-8.204: el chequeo de mutantes no calla lo que no midió ───────────────────────────────────────────────────────

const checker = require(path.join(SCRIPTS, 'mutation-check.js'));
const gate = require(path.join(SCRIPTS, 'lib', 'mutation-gate.js'));

/** Un repo de juguete con su base commiteada y `nuevos` sin commitear. */
function repoMutantes(base, nuevos) {
  const d = tmp('mut');
  const FECHA = '2026-01-01T10:00:00';
  const env = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA };
  const git = (args) => { const r = spawnSync('git', ['-c', 'maintenance.auto=false', ...args], { cwd: d, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'prueba']);
  for (const [rel, txt] of Object.entries({ '.keep': '', ...base })) escribir(d, rel, txt);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  for (const [rel, txt] of Object.entries(nuevos)) escribir(d, rel, txt);
  return d;
}
const historiaMutantes = (d, archivos) => escribir(d, 'story.md', ['---', 'story: "MUT-Q"', 'status: in-progress', 'files_to_create:',
  ...archivos.map((a) => `  - "${a}"`), '---', '', '# prueba', ''].join('\n'));
const CALC = "'use strict';\nfunction mayorOIgual(a, b) { return a >= b; }\nmodule.exports = { mayorOIgual };\n";
const SUITE_OK = ['#!/usr/bin/env bash', 'cd "$(dirname "$0")"', 'r=$(node -e "console.log(require(\'./calc.js\').mayorOIgual(2, 2))")', '[ "$r" = "true" ] || exit 1', ''].join('\n');
const NO_POSIX = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) ? 'permisos POSIX' : false;

test('T7 Mutation_NewFileUnreadable_NotMeasuredWithReason — un archivo nuevo ilegible no es «ningún operador aplica»', { skip: NO_POSIX }, async () => {
  const d = repoMutantes({ 'x.test.sh': '' }, { 'calc.js': CALC, 'x.test.sh': SUITE_OK });
  fs.chmodSync(path.join(d, 'calc.js'), 0o000);
  let r;
  try {
    r = await checker.runMutationCheck({ repo: d, storyPath: historiaMutantes(d, ['calc.js', 'x.test.sh']), stack: {}, log: () => {} });
  } finally { fs.chmodSync(path.join(d, 'calc.js'), 0o644); }
  assert.ok(r.result.skipped.some((s) => s.file === 'calc.js' && /no pude leer el archivo nuevo .*\(EACCES\)/.test(s.reason)), JSON.stringify(r.result));
  assert.match(String(r.result.motivo), /no pude leer las líneas agregadas de calc\.js/, JSON.stringify(r.result));
});

test('T8 MutationGate_OutputNotJson_NotMeasured — una salida del chequeo que no es JSON no pasa por limpia', () => {
  // el lector: dice por qué no hay resultado
  const dir = tmp('chequeo-roto');
  const guion = escribir(dir, 'chequeo.js', "process.stdout.write('esto no es json');\n");
  const out = gate.defaultInvokeCheck({ scriptPath: guion, repo: dir, storyPath: path.join(dir, 'story.md'), maxMutants: 1 });
  assert.equal(out.code, 0);
  assert.equal(out.result, null);
  assert.match(out.parseError, /la salida del chequeo no es JSON .*"esto no es json"/);
  // el portón: NO MEDIDO con el motivo, nunca «pass»
  const entries = [];
  const lines = [];
  const r = gate.runMutationGate({
    marker: { storyId: '9.9', repoPath: dir, storyPath: 'story.md' }, opts: [], env: {},
    appendLog: (_f, o) => entries.push(o), log: (...a) => lines.push(a.join(' ')),
    destinosDe: () => [dir],
    invokeCheck: () => out,
  });
  assert.equal(r.block, false);
  assert.deepStrictEqual(entries.map((e) => e.status), ['warn-unparsed']);
  assert.match(entries[0].reason, /no es JSON/);
  assert.match(lines.join('\n'), /NO MEDIDO .*no es JSON/);
});

test('T9 Mutation_BaseRed_ReasonCarriesStderr — con la base en rojo, el motivo trae las últimas líneas de error', async () => {
  const rota = ['#!/usr/bin/env bash', 'echo "preparando" >&2', 'echo "falta el SDK de prueba" >&2', 'exit 3', ''].join('\n');
  const d = repoMutantes({ 'x.test.sh': '' }, { 'calc.js': CALC, 'x.test.sh': rota });
  const r = await checker.runMutationCheck({ repo: d, storyPath: historiaMutantes(d, ['calc.js', 'x.test.sh']), stack: {}, log: () => {} });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo, /no medido: la base ya falla .*salió 3.*últimas líneas de error: «preparando \| falta el SDK de prueba»/, r.result.motivo);
});

test('T10 RouteGroup_DeprecatedAndUiTexts_KeepTheGroup — los lectores de deprecados y de textos de pantalla tampoco lo toman por repo', () => {
  const dep = require(path.join(SCRIPTS, 'lib', 'deprecated.js'));
  const historia = ['---', 'story: "9.4"', 'files_to_modify:', '  - (app)/page.tsx', '  - (web) src/x.ts', '---', ''].join('\n');
  assert.deepStrictEqual(dep.entradasDelFrontmatter(historia, 'files_to_modify'), [{ ruta: '(app)/page.tsx', repo: null }, { ruta: 'src/x.ts', repo: 'web' }]);
  const { screenFiles } = require(path.join(SCRIPTS, 'lib', 'ui-texts.js'));
  const fm = ['story: "9.4"', 'files_to_modify:', '  - (app)/page.tsx'].join('\n');
  const r = screenFiles(fm, '', [tmp('pantallas')]);
  assert.deepStrictEqual(r.missing, ['(app)/page.tsx'], JSON.stringify(r));
});
