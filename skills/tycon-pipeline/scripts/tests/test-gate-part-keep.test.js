'use strict';

/**
 * test-gate-part-keep.test.js — una story que toca el backend y el sitio: después de un verde, la parte en la que nada
 * cambió conserva su verde y no vuelve a correr (lib/part-keep.js). Nunca la de navegador, nunca sin story, nunca con un
 * cambio común, con una parte que nombra la otra o con paquetes compartidos.
 *
 * Herramientas falsas en el PATH: pytest y vitest (o Playwright) anotan cada lanzamiento en FAKE_LANZAMIENTOS.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const PK = require(path.join(SCRIPTS, 'lib', 'part-keep.js'));

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
  'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN', 'TYCON_MUTATION_CHECK', 'STOP_AUTONOMY',
  'TYCON_TEST_GATE_ALL_PARTS'];

function herramientas() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tpk-bin-'));
  const sh = (nombre, cuerpo) => { const f = path.join(bin, nombre); fs.writeFileSync(f, `#!/usr/bin/env bash\n${cuerpo}\n`); fs.chmodSync(f, 0o755); };
  const escribe = `node -e 'const n=2;require("fs").mkdirSync(require("path").dirname(process.argv[1]),{recursive:true});require("fs").writeFileSync(process.argv[1], ${JSON.stringify('<?xml version="1.0"?><testsuites><testsuite name="s">')}+Array.from({length:n},(_,i)=>(i===0&&process.env.FAKE_FAILURES==="1"?"<testcase name=\\"t"+i+"\\"><failure/></testcase>":"<testcase name=\\"t"+i+"\\"/>")).join("")+"</testsuite></testsuites>")'`;
  sh('python', `
for a in "$@"; do case "$a" in --junitxml=*) J="\${a#--junitxml=}";; --cov) echo "pytest: error: unrecognized arguments: --cov" >&2; exit 4;; esac; done
echo pytest >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
if [ -n "$FAKE_ESCRIBE_IGNORADO" ]; then mkdir -p build; date +%s%N > build/salida.txt; fi
${escribe} "$J"
[ "\${FAKE_FAILURES:-0}" = "0" ]`);
  sh('npx', `
if [ "$1" = "vitest" ]; then
  prev=""; for a in "$@"; do case "$a" in --outputFile=*) O="\${a#--outputFile=}";; esac; [ "$prev" = "--outputFile" ] && O="$a"; prev="$a"; done
  echo vitest >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
  printf '{"numTotalTests":3,"numPassedTests":3,"numFailedTests":0,"numPendingTests":0,"numTodoTests":0}' > "$O"; exit 0
fi
if [ "$1" = "playwright" ] && [ "$2" = "test" ]; then
  echo playwright >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
  ${escribe} "$PLAYWRIGHT_JUNIT_OUTPUT_NAME"; exit 0
fi
echo "npx falso: no sé correr $*" >&2; exit 127`);
  return bin;
}

const STORY = ['---', 'epic: 9', 'story: "9.46"', 'title: "laboratorio del portón por parte"', 'status: in-progress',
  'files_to_create: []', 'files_to_modify:', '  - backend/app/precios.py', '  - frontend/src/a.ts', '---', '', '# Story 9.46', '',
  '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** se ve', '', '### Tests', '',
  '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `prueba` | 1 | unit | x | y |', ''].join('\n');
const BACK = { 'backend/pytest.ini': '[pytest]\n', 'backend/app/precios.py': 'a = 1\n', 'backend/tests/test_precios.py': 'def test_a(): pass\n' };
const FRONT = { 'frontend/package.json': '{"name":"f","devDependencies":{"vitest":"1"}}\n', 'frontend/src/a.ts': 'export const a = 1\n' };
const FRONT_NAVEGADOR = {
  'frontend/package.json': JSON.stringify({ name: 'f', devDependencies: { '@playwright/test': '1' } }) + '\n',
  'frontend/playwright.config.js': "export default { testDir: 'tests/e2e' };\n", 'frontend/src/a.ts': 'export const a = 1\n',
  'frontend/tests/e2e/a.spec.ts': "import { test } from '@playwright/test';\n",
};

/** Un repo con la story en specs/ y ambas partes tocadas sin commitear (así la story toca las dos). */
function repo(archivos) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpk-repo-')));
  const fecha = '2026-01-01T00:00:00Z';
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  git('init', '-q', '-b', 'wt/laboratorio'); git('config', 'user.email', 'prueba@ejemplo.invalid'); git('config', 'user.name', 'prueba');
  for (const [rel, c] of Object.entries({ ...archivos, 'specs/9.46.md': STORY })) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), c);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  tocar(d, 'backend/app/precios.py'); tocar(d, 'frontend/src/a.ts');
  return d;
}
const tocar = (d, rel, texto = '\n# tocado\n') => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.appendFileSync(path.join(d, rel), texto); };

function correr(d, { bin, story = true, extra = {} } = {}) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tpk-home-'));
  const lanz = path.join(home, 'lanzamientos');
  const args = [TEST_GATE, d]; if (story) args.push(path.join(d, 'specs', '9.46.md'));
  const r = spawnSync('bash', args, { encoding: 'utf8', cwd: d,
    env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'tpk', PATH: `${bin}:${process.env.PATH}`, FAKE_LANZAMIENTOS: lanz, ...extra } });
  let art = null; try { art = JSON.parse(fs.readFileSync(path.join(d, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  let corrieron = []; try { corrieron = fs.readFileSync(lanz, 'utf8').trim().split('\n').filter(Boolean).sort(); } catch (_) { corrieron = []; }
  const kept = art && Array.isArray(art.parts) ? art.parts.filter((p) => p.kept).map((p) => p.scope).sort() : [];
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art, corrieron, kept };
}

test('PK1 TestGatePartKeep_OnlyTheSiteChanged_BackendKeepsItsGreen', () => {
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  const r1 = correr(d, { bin });
  assert.equal(r1.status, 0, r1.out);
  assert.deepEqual(r1.corrieron, ['pytest', 'vitest']);
  tocar(d, 'frontend/src/a.ts', 'export const b = 2\n');
  const r2 = correr(d, { bin });
  assert.equal(r2.status, 0, r2.out);
  assert.deepEqual(r2.corrieron, ['vitest'], 'el backend no vuelve a correr');
  assert.deepEqual(r2.kept, ['backend']);
  assert.equal(r2.art.suite_green, true);
  assert.ok(r2.art.parts.find((p) => p.scope === 'backend').kept_from, 'dice de cuándo es el verde conservado');
  assert.match(r2.out, /parte backend: conservo su verde/);
});

test('PK2 TestGatePartKeep_TheBackendChanged_ItRuns', () => {
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'backend/app/precios.py', 'b = 2\n');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['pytest'], r.out);
  assert.deepEqual(r.kept, ['frontend']);
});

test('PK3 TestGatePartKeep_CommonFileChanged_BothRun', () => {
  // 🔴 mutación: sin la huella de lo común, un cambio en la raíz dejaría las dos partes conservadas
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT, 'config.json': '{}\n' });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'config.json', ' ');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
  assert.match(r.out, /cambió algo común a las partes/);
});

test('PK4 TestGatePartKeep_OnlyTheStoryChanged_BothKept_OtherMarkdownCounts', () => {
  // la story cambia en cada paso del pipeline y no es lo que se prueba; otro Markdown puede ser un dato de una prueba
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'specs/9.46.md', '\nUna nota más.\n');
  const r = correr(d, { bin });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.corrieron, []);
  assert.deepEqual(r.kept, ['backend', 'frontend']);
  // 🔴 mutación: con todo el Markdown afuera de lo común, un README que una prueba lee no la volvería a correr
  tocar(d, 'README.md', '# notas\n');
  const r2 = correr(d, { bin });
  assert.deepEqual(r2.corrieron, ['pytest', 'vitest'], r2.out);
});

test('PK13 TestGatePartKeep_IgnoredEnvFileChanged_ThePartRuns', () => {
  // 🔴 mutación: sin lo ignorado en la huella, un .env que la prueba lee cambiaría y la parte se conservaría
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT, 'backend/.gitignore': '.env\n', 'backend/.env': 'A=1\n' });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'backend/.env', 'A=2\n');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['pytest'], r.out);
  assert.match(r.out, /cambió algo ignorado por git en la parte/);
});

test('PK14 TestGatePartKeep_TestEnvVariableChanged_BothRun', () => {
  // 🔴 mutación: sin el entorno en la huella, otra base de datos dejaría conservar los dos verdes
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  assert.equal(correr(d, { bin, extra: { DATABASE_URL: 'postgres://uno' } }).status, 0);
  const r = correr(d, { bin, extra: { DATABASE_URL: 'postgres://otro' } });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
  assert.match(r.out, /variable del entorno/);
});

test('PK15 TestGatePartKeep_SiteDependsByFileProtocol_NeverKept', () => {
  const bin = herramientas();
  const d = repo({ ...BACK, ...FRONT, 'frontend/package.json': '{"name":"f","devDependencies":{"vitest":"1"},"dependencies":{"sdk":"file:../backend/app"}}\n' });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'backend/app/precios.py', 'b = 2\n');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
});

test('PK16 TestGatePartKeep_RunnerWritesIgnoredOutput_StillKept', () => {
  // la herramienta escribe en lo ignorado de la parte en cada corrida (como dotnet en bin/ y obj/): la huella anotada es la
  // de después de correr, así que la próxima vez, sin cambios, conserva
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT, 'backend/.gitignore': 'build/\n' });
  const extra = { FAKE_ESCRIBE_IGNORADO: '1' };
  assert.equal(correr(d, { bin, extra }).status, 0);
  tocar(d, 'frontend/src/a.ts', 'export const b = 2\n');
  const r = correr(d, { bin, extra });
  assert.deepEqual(r.corrieron, ['vitest'], r.out);
  assert.deepEqual(r.kept, ['backend']);
});

test('PK5 TestGatePartKeep_BrowserPart_NeverKept', () => {
  // 🔴 mutación: sin la regla del navegador, Playwright se conservaría aunque cambió el backend que prueba
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT_NAVEGADOR });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'backend/app/precios.py', 'b = 2\n');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['playwright', 'pytest'], r.out);
  assert.match(r.out, /parte de navegador \(playwright\)/);
});

test('PK6 TestGatePartKeep_NoStory_NothingKept', () => {
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  assert.equal(correr(d, { bin, story: false }).status, 0);
  const r = correr(d, { bin, story: false });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
  assert.deepEqual(r.kept, []);
});

test('PK7 TestGatePartKeep_SiteNamesTheBackend_SiteNeverKept', () => {
  // 🔴 mutación: sin mirar las rutas que cruzan, el sitio que lee el backend se conservaría con el backend cambiado
  const bin = herramientas();
  const d = repo({ ...BACK, ...FRONT, 'frontend/src/precios.ts': "import p from '../../backend/app/precios.py';\n" });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'backend/app/precios.py', 'b = 2\n');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
  assert.match(r.out, /parte frontend: corre \(la parte nombra rutas de otra parte/);
});

test('PK8 TestGatePartKeep_AllPartsVariable_RunsBoth', () => {
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  assert.equal(correr(d, { bin }).status, 0);
  const r = correr(d, { bin, extra: { TYCON_TEST_GATE_ALL_PARTS: '1' } });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
});

test('PK9 TestGatePartKeep_RedPart_RunsAgain', () => {
  // 🔴 mutación: si un rojo se conservara, el total quedaría verde sin volver a correr la parte que falló
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT });
  const r1 = correr(d, { bin, extra: { FAKE_FAILURES: '1' } });
  assert.notEqual(r1.status, 0, r1.out);
  tocar(d, 'frontend/src/a.ts', 'export const b = 2\n');
  const r2 = correr(d, { bin, extra: { FAKE_FAILURES: '1' } });
  assert.ok(r2.corrieron.includes('pytest'), r2.out);
  assert.equal(r2.art.suite_green, false);
});

test('PK10 TestGatePartKeep_SharedPackages_NothingKept', () => {
  const bin = herramientas(); const d = repo({ ...BACK, ...FRONT, 'package.json': '{"private":true,"workspaces":["frontend"]}\n' });
  assert.equal(correr(d, { bin }).status, 0);
  tocar(d, 'frontend/src/a.ts', 'export const b = 2\n');
  const r = correr(d, { bin });
  assert.deepEqual(r.corrieron, ['pytest', 'vitest'], r.out);
  assert.match(r.out, /comparten paquetes/);
});

test('PK11 PartKeep_Decide_EachDifferenceRuns', () => {
  const f = { scope: 'backend', part: 'a', part_ignored: 'ai', common: 'b', common_ignored: 'bi', gate: 'c', tools: { node: 'v1' }, env: 'e',
    outside: [], shared_packages: false };
  const prev = { suite_green: true, runner: 'pytest', ts: 't', kept_fingerprint: { story: '9.46', branch: 'r', fingerprint: f } };
  const base = { prev, current: f, story: '9.46', branch: 'r' };
  assert.equal(PK.decide(base).keep, true);
  const no = (cambio, motivo) => { const d = PK.decide({ ...base, ...cambio }); assert.equal(d.keep, false, motivo); assert.match(d.why, motivo); };
  no({ story: '9.47' }, /otra story/);
  no({ branch: 'otra' }, /otra rama/);
  no({ current: { ...f, gate: 'x' } }, /cambió el portón/);
  no({ current: { ...f, tools: { node: 'v2' } } }, /herramienta/);
  no({ current: { ...f, part: 'x' } }, /cambió la parte/);
  no({ current: { ...f, common: 'x' } }, /común/);
  no({ prev: { ...prev, kept_fingerprint: undefined } }, /no dejó su huella/);
  no({ prev: { ...prev, suite_green: false } }, /no fue verde/);
  no({ prev: { ...prev, runner: 'karma' } }, /navegador/);
  no({ story: 'unknown' }, /no es de una story/);
  no({ branch: 'HEAD' }, /no está en una rama/);
  no({ current: { ...f, env: 'x' } }, /entorno/);
  no({ current: { ...f, part_ignored: 'x' } }, /ignorado por git en la parte/);
  no({ current: { ...f, common_ignored: 'x' } }, /común ignorado/);
  // la huella que se anota: la de después, si lo versionado no cambió mientras corría
  assert.deepEqual(PK.paraAnotar(f, { ...f, part_ignored: 'otra' }), { ...f, part_ignored: 'otra' });
  assert.equal(PK.paraAnotar(f, { ...f, part: 'editado' }), null, 'un archivo editado mientras corría no se anota');
  assert.equal(PK.paraAnotar(f, { ...f, common: 'editado' }), null);
  assert.equal(PK.paraAnotar(null, f), null);
});

test('PK12 PartKeep_OutsideRoutes_ProjectReferenceAndSiblingRepo', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpk-rutas-')));
  spawnSync('git', ['-C', d, 'init', '-q']);
  const w = (rel, c) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), c); };
  w('api/Api.csproj', '<Project><ItemGroup><ProjectReference Include="..\\web\\Web.csproj" /></ItemGroup></Project>\n');
  w('web/Web.csproj', '<Project />\n');
  w('web/tsconfig.json', '{ "extends": "../tsconfig.base.json" }\n');
  w('web/x.ts', "import y from '../../otro-repo/y';\n");
  assert.deepEqual(PK.dependenciasDeAfuera(d, 'api', ['api', 'web']), ['api/Api.csproj → ..\\web\\Web.csproj']);
  // lo de la raíz lo cubre la huella de lo común; lo de fuera del repo, no
  assert.deepEqual(PK.dependenciasDeAfuera(d, 'web', ['api', 'web']), ["web/x.ts → ../../otro-repo/y"]);
  // 🔴 mutación: con la regla vieja (sólo después de una comilla o un igual), ninguno de éstos se veía
  w('api/package.json', '{ "dependencies": { "sdk": "file:../web/sdk" } }\n');
  w('api/go.mod', 'replace x => ../web/lib\n');
  w('api/requirements.txt', '-e ../web\n');
  w('api/Lib.csproj', '<HintPath>..\\web\\bin\\x.dll</HintPath>\n');
  w('api/rutas.py', 'p = os.path.join(AQUI, "..", "web")\n');
  const api = PK.dependenciasDeAfuera(d, 'api', ['api', 'web']);
  for (const esperado of ['api/package.json → ../web/sdk', 'api/go.mod → ../web/lib', 'api/requirements.txt → ../web',
    'api/Lib.csproj → ..\\web\\bin\\x.dll', 'api/rutas.py → ".." (una ruta armada que sube de carpeta)']) {
    assert.ok(api.includes(esperado), `no vio ${esperado}: ${api.join(' | ')}`);
  }
  // un enlace de la parte que apunta a la otra
  fs.symlinkSync('../web/Web.csproj', path.join(d, 'api', 'enlace.csproj'));
  assert.match(PK.dependenciasDeAfuera(d, 'api', ['api', 'web']).join('\n'), /api\/enlace\.csproj → \(enlace\)/);
});
