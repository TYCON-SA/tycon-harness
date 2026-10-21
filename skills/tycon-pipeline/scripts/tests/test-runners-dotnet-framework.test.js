'use strict';

/**
 * test-runners-dotnet-framework.test.js —la receta de una herramienta de prueba de la organización alcanza para .NET Framework con
 * vstest: un reporte TRX, el archivo detector en una subcarpeta y un detalle por repo declarado en la configuración.
 *
 * Herramientas falsas en el PATH: `vstestf` deja en el disco los TRX que dejaría vstest y sale con el código que
 * corresponde. Lo que se mide es la receta y la puerta: qué eligen, qué corren, qué cuentan y con qué salida terminan.
 * Además, el camino de quien le pide la receta a su agente: la frase del sitio, el índice de guías y la guía.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');
const runners = require(path.join(SCRIPTS, 'lib', 'test-runners.js'));
const team = require(path.join(RAIZ, 'scripts', 'lib', 'team-repos.js'));
const { discoverCandidates } = require(path.join(SCRIPTS, 'lib', 'test-scope.js'));

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
  'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED',
  'TYCON_COVERAGE_BASE', 'TYCON_GUIDES_DIR', 'TCG', 'TYCON_COVERAGE_MIN'];

const REPOS_BASE = {
  version: 1,
  public: { platform: 'github', org: 'acme', repo: 'h' },
  profile: { platform: 'github', org: 'acme', repo: 'p' },
  operations: { platform: 'github', org: 'acme', repo: 'o' },
};

/** Un TRX como el de vstest, con `total` pruebas de las que `fallas` fallan. */
const trx = (total, fallas = 0) => `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="1" name="r" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <ResultSummary outcome="${fallas ? 'Failed' : 'Completed'}">
    <Counters total="${total}" executed="${total}" passed="${total - fallas}" failed="${fallas}" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>`;

/** La herramienta de la organización como la declara el perfil, con el comando de la herramienta falsa. */
const netfx = (extra = {}) => ({
  name: 'netfx-vstest',
  detect: 'packages.config',
  detect_depth: 1,
  command: 'vstestf "{results}" "{args}"',
  results: { format: 'trx', path: '{results}/**/*.trx' },
  ...extra,
});

/**
 * La herramienta falsa: escribe un TRX por cada número de FAKE_TRX (`"2:1,3"` = un TRX de 2 pruebas con 1 fallida y otro
 * de 3), anota cada lanzamiento con su `{args}` en FAKE_LANZAMIENTOS y sale 0 salvo FAKE_EXIT.
 */
function herramientas() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-bin-'));
  const f = path.join(bin, 'vstestf');
  fs.writeFileSync(f, `#!/usr/bin/env bash
R="$1"; A="$2"
echo "args=$A" >> "\${FAKE_LANZAMIENTOS:-/dev/null}"
i=0
for spec in $(echo "\${FAKE_TRX:-}" | tr ',' ' '); do
  i=$((i+1)); t="\${spec%%:*}"; fa=0; [ "$spec" != "$t" ] && fa="\${spec#*:}"
  mkdir -p "$R/run$i"
  node -e 'require("fs").writeFileSync(process.argv[1], process.argv[2])' "$R/run$i/r.trx" "$(node -e '
    const [t,f]=process.argv.slice(1).map(Number);
    process.stdout.write(require(process.argv[3])(t,f))' "$t" "$fa" "${path.join(bin, 'trx.js')}")"
done
exit "\${FAKE_EXIT:-0}"
`);
  fs.chmodSync(f, 0o755);
  fs.writeFileSync(path.join(bin, 'trx.js'), `module.exports = ${trx.toString()};\n`);
  return bin;
}

/** Un repo con git, los archivos dados, el remoto `remote` y un cambio sin commitear en `tocar`. */
function repo(archivos, { tocar = [], remote = null } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-repo-')));
  const fecha = '2026-01-01T00:00:00Z';
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', d, ...a], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha },
  });
  git('init', '-q'); git('config', 'user.email', 'prueba@ejemplo.invalid'); git('config', 'user.name', 'prueba');
  if (remote) git('remote', 'add', 'origin', remote);
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), c);
  }
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  for (const rel of tocar) fs.appendFileSync(path.join(d, rel), '\n// tocado\n');
  return d;
}

/** Un árbol del arnés con la configuración de la organización. */
function arbol(test_runners) {
  const a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-arbol-')));
  fs.mkdirSync(path.join(a, 'scripts'));
  fs.writeFileSync(path.join(a, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(a, 'team-repos.json'), JSON.stringify({ ...REPOS_BASE, stack: { test_runners } }));
  return a;
}

function correr(dir, { bin, tree, extra = {} }) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-home-'));
  const r = spawnSync('bash', [TEST_GATE, dir], {
    encoding: 'utf8', cwd: dir,
    env: { ...env, HOME: home, CLAUDE_CODE_SESSION_ID: 'nf-runners', PATH: `${bin}:${process.env.PATH}`, TYCON_GUIDES_DIR: tree, ...extra },
  });
  let art = null;
  try { art = JSON.parse(fs.readFileSync(path.join(dir, '.advisors', 'tests-result.json'), 'utf8')); } catch (_) { art = null; }
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, art };
}

// un repo .NET Framework como BIZUITAPI: solución en la raíz, packages.config en cada proyecto
const NETFX = {
  'App.sln': 'Microsoft Visual Studio Solution File\nProject("{FAE04EC0}") = "App", "App\\App.csproj", "{1}"\nEndProject\nProject("{FAE04EC0}") = "App.Tests", "App.Tests\\App.Tests.csproj", "{2}"\nEndProject\n',
  'App/App.csproj': '<Project ToolsVersion="15.0"><ItemGroup><Compile Include="A.cs" /></ItemGroup></Project>\n',
  'App/packages.config': '<packages />\n',
  'App/A.cs': 'class A {}\n',
  'App.Tests/App.Tests.csproj': '<Project ToolsVersion="15.0"><ItemGroup><Compile Include="T.cs" /></ItemGroup></Project>\n',
  'App.Tests/packages.config': '<packages><package id="MSTest.TestFramework" version="2.2.10" /></packages>\n',
  'App.Tests/T.cs': 'class T {}\n',
};
// un repo .NET con SDK: sin packages.config
const SDK = {
  'App.sln': 'Microsoft Visual Studio Solution File\nProject("{9A19103F}") = "App", "App\\App.csproj", "{1}"\nEndProject\n',
  'App/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>\n',
  'App/A.cs': 'class A {}\n',
};

test('@story-7.51 @ac-1 @ac-8 T1 Trx_Format_Valid_BothReaders', () => {
  // con su nombre para personas (`label`) también vale en los dos
  const conNombre = netfx({ label: '.NET Framework (vstest)' });
  assert.deepStrictEqual(runners.validateRunners([conNombre]).problems, []);
  const tn = team.parse(JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [conNombre] } }));
  assert.deepStrictEqual((tn.sectionProblems && tn.sectionProblems.stack) || [], []);
  const v = runners.validateRunners([netfx()]);
  assert.deepStrictEqual(v.problems, [], JSON.stringify(v.problems));
  const t = team.parse(JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [netfx()] } }));
  assert.deepStrictEqual((t.sectionProblems && t.sectionProblems.stack) || [], [], JSON.stringify(t.sectionProblems));
  assert.ok(t.ok, JSON.stringify(t.problems));
  // los dos lectores aceptan los mismos formatos
  assert.ok(runners.RESULT_FORMATS.includes('trx'));
});

test('@story-7.51 @ac-1 T2 Trx_Totals_SameReaderAsDotnet', () => {
  const report = require(path.join(SCRIPTS, 'lib', 'test-gate-report.js'));
  assert.equal(typeof report.contarTrx, 'function', 'el lector de TRX es una función compartida');
  const bin = herramientas();
  const d = repo(NETFX, { tocar: ['App/A.cs'] });
  const r = correr(d, { bin, tree: arbol([netfx()]), extra: { FAKE_TRX: '2,3' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'netfx-vstest');
  assert.equal(r.art.totals.total, 5, JSON.stringify(r.art.totals));
  assert.equal(r.art.totals.failed, 0);
  assert.equal(r.art.suite_green, true);
});

test('@story-7.51 @ac-2 T3 Trx_FailedInReport_NotGreen', () => {
  const bin = herramientas();
  const d = repo(NETFX, { tocar: ['App/A.cs'] });
  const r = correr(d, { bin, tree: arbol([netfx()]), extra: { FAKE_TRX: '2:1' } });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.art.suite_green, false);
  assert.equal(r.art.totals.failed, 1);
  assert.match(String(r.art.failed_in_report || ''), /1 prueba/);
});

test('@story-7.51 @ac-3 T4 Trx_Missing_SaysSo', () => {
  const bin = herramientas();
  const d = repo(NETFX, { tocar: ['App/A.cs'] });
  const r = correr(d, { bin, tree: arbol([netfx()]), extra: { FAKE_TRX: '' } });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.art.suite_green, false);
  assert.match(String(r.art.totals_error || ''), /TRX/);
  // un TRX sin su resumen no es «cero pruebas»: se dice que no se pudo contar
  const report = require(path.join(SCRIPTS, 'lib', 'test-gate-report.js'));
  const sinResumen = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-trx-')), 'r.trx');
  fs.writeFileSync(sinResumen, '<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results/></TestRun>');
  const faltan = [];
  report.contarTrx([sinResumen], faltan);
  assert.deepStrictEqual(faltan, [sinResumen], 'el TRX sin Counters queda anotado');
  // y la rama de .NET también lo dice, y no da verde: un `dotnet` falso que deja un TRX sin su resumen
  const dotnetBin = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dotnet-'));
  fs.writeFileSync(path.join(dotnetBin, 'dotnet'), `#!/usr/bin/env bash
R=""; prev=""; for a in "$@"; do [ "$prev" = "--results-directory" ] && R="$a"; prev="$a"; done
[ -n "$R" ] || exit 0
mkdir -p "$R/run"
printf '<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results/></TestRun>' > "$R/run/r.trx"
exit 0
`);
  fs.chmodSync(path.join(dotnetBin, 'dotnet'), 0o755);
  const sdk = repo(SDK, { tocar: ['App/A.cs'] });
  const rd = correr(sdk, { bin: dotnetBin, tree: arbol([]) });
  assert.ok(rd.art, rd.out);
  assert.equal(rd.art.runner, 'dotnet');
  assert.match(String(rd.art.totals_error || ''), /Counters/, rd.out);
  assert.equal(rd.art.suite_green, false);
});

test('@story-7.51 @ac-4 T5 DetectDepth_FindsSubfolder_SkipsBinObj', () => {
  const d = repo({ 'App.sln': '', 'X/packages.config': '<packages />' });
  const r = runners.resolve(d, { results: '/tmp/res', stack: { test_runners: [netfx()] } });
  assert.ok(r, 'lo encuentra a profundidad 1');
  assert.equal(r.name, 'netfx-vstest');
  // sin detect_depth, sólo la carpeta que se prueba
  assert.equal(runners.resolve(d, { results: '/tmp/res', stack: { test_runners: [netfx({ detect_depth: undefined })] } }), null);
  // en bin/ u obj/ no cuenta
  const conBin = repo({ 'App.sln': '', 'bin/packages.config': '', 'obj/packages.config': '', 'node_modules/x/packages.config': '', '.vs/packages.config': '' });
  assert.equal(runners.resolve(conBin, { results: '/tmp/res', stack: { test_runners: [netfx()] } }), null);
  // una carpeta que no se pudo leer no es «no está»: lo dice
  if (process.getuid && process.getuid() !== 0) {
    const cerrada = repo({ 'App.sln': '', 'X/otra.txt': '' });
    fs.chmodSync(path.join(cerrada, 'X'), 0o000);
    try {
      const i = runners.inspect(cerrada, { results: '/tmp/res', stack: { test_runners: [netfx()] } });
      assert.equal(i.runner, null);
      assert.ok(i.problems.some((p) => /no pude leer .*packages\.config/.test(p)), JSON.stringify(i.problems));
    } finally { fs.chmodSync(path.join(cerrada, 'X'), 0o755); }
  }
  // fuera de rango es un problema de los dos lectores
  for (const malo of [5, -1, 1.5, '1']) {
    const v = runners.validateRunners([netfx({ detect_depth: malo })]);
    assert.ok(v.problems.some((p) => p.path === 'stack.test_runners.0.detect_depth'), `${malo}: ${JSON.stringify(v.problems)}`);
    const t = team.parse(JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [netfx({ detect_depth: malo })] } }));
    const sec = (t.sectionProblems && t.sectionProblems.stack) || t.problems;
    assert.ok(sec.some((p) => p.path === 'stack.test_runners.0.detect_depth'), `team-repos ${malo}: ${JSON.stringify(sec)}`);
  }
});

test('@story-7.51 @ac-5 @ac-14 T6 NetfxRepo_RunsRecipe_SdkRepo_RunsDotnet', () => {
  const bin = herramientas();
  const tree = arbol([netfx()]);
  const lanz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-l-')), 'n');
  const d = repo(NETFX, { tocar: ['App/A.cs', 'App.Tests/T.cs'] });
  const r = correr(d, { bin, tree, extra: { FAKE_TRX: '2', FAKE_LANZAMIENTOS: lanz } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.art.runner, 'netfx-vstest');
  assert.equal(fs.readFileSync(lanz, 'utf8').trim().split('\n').length, 1, 'una sola corrida, en la raíz');
  // un repo .NET con SDK sigue con dotnet: la receta no aplica
  const sdk = repo(SDK);
  assert.equal(runners.resolve(sdk, { results: '/tmp/res', stack: { test_runners: [netfx()] } }), null);
});

test('@story-7.51 @ac-6 T7 DeepDetect_DoesNotSplitSolution', () => {
  const d = repo(NETFX);
  const antes = process.env.TYCON_GUIDES_DIR;
  process.env.TYCON_GUIDES_DIR = arbol([netfx()]);
  let cands;
  try { cands = discoverCandidates(d); } finally { if (antes === undefined) delete process.env.TYCON_GUIDES_DIR; else process.env.TYCON_GUIDES_DIR = antes; }
  // la solución de la raíz es el único proyecto: sus carpetas con packages.config no se suman aparte
  assert.deepStrictEqual(cands.map((c) => c.dir), ['.'], JSON.stringify(cands));
});

test('@story-7.51 @ac-7 T8 RepoArgs_ByRemote_DefaultAndEmpty', () => {
  const conRepos = netfx({
    args_default: 'TestCategory!=Slow',
    repos: [{ repo: { platform: 'azure', org: 'acme', project: 'Prod', repo: 'api' }, args: 'TestCategory=Unit&TestCategory!=PendingSeed' }],
  });
  const stack = { test_runners: [conRepos] };
  const suyo = repo({ 'X/packages.config': '' }, { remote: 'https://dev.azure.com/acme/Prod/_git/api' });
  const otro = repo({ 'X/packages.config': '' }, { remote: 'https://github.com/acme/otro.git' });
  const sinRemoto = repo({ 'X/packages.config': '' });
  assert.match(runners.resolve(suyo, { results: '/r', stack }).command, /"TestCategory=Unit&TestCategory!=PendingSeed"/);
  assert.match(runners.resolve(otro, { results: '/r', stack }).command, /"TestCategory!=Slow"/);
  assert.match(runners.resolve(sinRemoto, { results: '/r', stack }).command, /"TestCategory!=Slow"/);
  // el mismo repo con el host viejo de Azure, el nuevo y otras mayúsculas: cada máquina puede tener su forma del remoto
  for (const url of ['https://acme.visualstudio.com/Prod/_git/api', 'https://dev.azure.com/acme/PROD/_git/API', 'https://dev.azure.com/Acme/prod/_git/Api']) {
    const otraForma = repo({ 'X/packages.config': '' }, { remote: url });
    assert.match(runners.resolve(otraForma, { results: '/r', stack }).command, /"TestCategory=Unit&TestCategory!=PendingSeed"/, url);
  }
  // sin args_default, vacío
  const sinDefault = { test_runners: [netfx({ repos: conRepos.repos })] };
  assert.match(runners.resolve(otro, { results: '/r', stack: sinDefault }).command, /vstestf "\/r" ""/);
  // y por la puerta: el args del repo llega al comando que corre
  const bin = herramientas();
  const lanz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-l-')), 'n');
  const d = repo(NETFX, { tocar: ['App/A.cs'], remote: 'https://dev.azure.com/acme/Prod/_git/api' });
  const r = correr(d, { bin, tree: arbol([conRepos]), extra: { FAKE_TRX: '1', FAKE_LANZAMIENTOS: lanz } });
  assert.equal(r.status, 0, r.out);
  assert.match(fs.readFileSync(lanz, 'utf8'), /args=TestCategory=Unit&TestCategory!=PendingSeed/);
});

test('@story-7.51 @ac-8 @ac-9 T9 RepoArgs_Validation_AndNotFromTestedRepo', () => {
  const r = { platform: 'github', org: 'acme', repo: 'api' };
  const casos = [
    [{ repos: [{ repo: r, args: 'a$b' }] }, 'stack.test_runners.0.repos.0.args'],
    [{ repos: [{ repo: r, args: 'a"b' }] }, 'stack.test_runners.0.repos.0.args'],
    [{ repos: [{ repo: r, args: "a'b" }] }, 'stack.test_runners.0.repos.0.args'],
    [{ repos: [{ repo: r, args: 'a`b' }] }, 'stack.test_runners.0.repos.0.args'],
    [{ repos: [{ repo: r, args: 'a\\b' }] }, 'stack.test_runners.0.repos.0.args'],
    [{ repos: [{ repo: r, args: 'a\nb' }] }, 'stack.test_runners.0.repos.0.args'],
    [{ args_default: 'a$b' }, 'stack.test_runners.0.args_default'],
    [{ repos: [{ repo: r, args: 'x' }, { repo: r, args: 'y' }] }, 'stack.test_runners.0.repos.1.repo'],
    [{ repos: [{ repo: { platform: 'github', org: 'acme' }, args: 'x' }] }, 'stack.test_runners.0.repos.0.repo'],
    [{ repos: [{ repo: r, args: 'x', otra: 1 }] }, 'stack.test_runners.0.repos.0.otra'],
    [{ repos: 'api' }, 'stack.test_runners.0.repos'],
    [{ label: 5 }, 'stack.test_runners.0.label'],
    [{ label: '' }, 'stack.test_runners.0.label'],
  ];
  for (const [extra, ruta] of casos) {
    const v = runners.validateRunners([netfx(extra)]);
    // un <repo> mal formado se dice en la clave que falta, adentro de su `repo`
    const enRuta = (p) => p.path === ruta || p.path.startsWith(`${ruta}.`);
    assert.ok(v.problems.some(enRuta), `test-runners ${JSON.stringify(extra)}: ${JSON.stringify(v.problems)}`);
    const t = team.parse(JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [netfx(extra)] } }));
    const sec = (t.sectionProblems && t.sectionProblems.stack) || t.problems;
    assert.ok(sec.some(enRuta), `team-repos ${JSON.stringify(extra)}: ${JSON.stringify(sec)}`);
  }
  // por la línea de comandos el lector también lo dice: el archivo es válido, pero la sección stack no se usa
  const conMalo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-cli-')), 'team-repos.json');
  fs.writeFileSync(conMalo, JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [netfx({ repos: [{ repo: r, args: 'a$(x)' }] })] } }));
  const cli = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'team-repos.js'), conMalo], { encoding: 'utf8' });
  assert.match(cli.stdout, /stack\.test_runners\.0\.repos\.0\.args: .*la sección stack no se usa/, cli.stdout);
  // un repo que trae su propio team-repos.json con otro comando no cambia nada: la configuración es la del arnés
  const bin = herramientas();
  const lanz = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-l-')), 'n');
  const propio = { ...NETFX, 'team-repos.json': JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [netfx({ command: 'touch PWNED; vstestf "{results}" "x"', args_default: 'del-repo' })] } }) };
  const d = repo(propio, { tocar: ['App/A.cs'] });
  const out = correr(d, { bin, tree: arbol([netfx({ args_default: 'del-arnes' })]), extra: { FAKE_TRX: '1', FAKE_LANZAMIENTOS: lanz } });
  assert.equal(out.status, 0, out.out);
  assert.match(fs.readFileSync(lanz, 'utf8'), /args=del-arnes/);
  assert.ok(!fs.existsSync(path.join(d, 'PWNED')), 'el comando del repo probado no corrió');
});

test('@story-7.51 @ac-4 @ac-6 @ac-7 @ac-8 T9b Recipe_EdgesFromAdversarialPass', () => {
  // una nota `_x` en una entrada de repos vale igual en los dos lectores (no descarta la herramienta en la puerta)
  const conNota = netfx({ repos: [{ repo: { platform: 'github', org: 'acme', repo: 'api' }, args: 'A', _nota: 'el filtro de categorías' }] });
  assert.deepStrictEqual(runners.validateRunners([conNota]).problems, []);
  const t = team.parse(JSON.stringify({ ...REPOS_BASE, stack: { test_runners: [conNota] } }));
  assert.deepStrictEqual((t.sectionProblems && t.sectionProblems.stack) || [], []);
  // y una que parece una credencial es un problema en los dos
  const conClave = netfx({ repos: [{ repo: { platform: 'github', org: 'acme', repo: 'api' }, args: 'A', _token: 'x' }] });
  assert.ok(runners.validateRunners([conClave]).problems.some((p) => p.path === 'stack.test_runners.0.repos.0._token'));

  // el clon de un clon: el detalle sale del remoto real, siguiendo la cadena
  const stack = { test_runners: [netfx({ repos: [{ repo: { platform: 'github', org: 'acme', repo: 'api' }, args: 'DEL-REAL' }] })] };
  const original = repo({ 'X/packages.config': '' }, { remote: 'https://github.com/acme/api.git' });
  const clon = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-clon-')));
  spawnSync('git', ['clone', '-q', original, path.join(clon, 'c')], { encoding: 'utf8' });
  assert.match(runners.resolve(path.join(clon, 'c'), { results: '/r', stack }).command, /"DEL-REAL"/);

  // el .sln escrito con otras mayúsculas que la carpeta: sigue siendo un proyecto de la solución
  const caja = repo({ ...NETFX, 'App.sln': NETFX['App.sln'].replace('App.Tests\\App.Tests.csproj', 'app.tests\\App.Tests.csproj') });
  const antes = process.env.TYCON_GUIDES_DIR;
  process.env.TYCON_GUIDES_DIR = arbol([netfx()]);
  let cands;
  try { cands = discoverCandidates(caja); } finally { if (antes === undefined) delete process.env.TYCON_GUIDES_DIR; else process.env.TYCON_GUIDES_DIR = antes; }
  assert.deepStrictEqual(cands.map((c) => c.dir), ['.'], JSON.stringify(cands));

  // un proyecto de Vitest en la raíz no se lo lleva la receta porque una subcarpeta tenga packages.config
  const vitest = repo({ 'package.json': '{"devDependencies":{"vitest":"1.0.0"}}', 'legacy/packages.config': '' });
  assert.equal(runners.resolve(vitest, { results: '/r', stack: { test_runners: [netfx()] } }), null);
});

test('@story-7.51 @ac-10 @ac-11 T11 AgentPath_IndexPhraseGuide', () => {
  const index = fs.readFileSync(path.join(RAIZ, 'INDEX.md'), 'utf8');
  const texts = require(path.join(RAIZ, 'scripts', 'site', 'texts.js'));
  const tabla = texts.TEXTOS;
  const frase = tabla['pantalla.tecFraseParaElAgente'];
  assert.ok(frase && frase.es && frase.en, 'la frase del sitio existe en los dos idiomas');
  // la frase lleva a la guía; el índice tiene una fila que también
  assert.match(frase.es, /organization-site\.md/);
  assert.match(frase.es, /Tu tecnología/);
  const fila = index.split('\n').find((l) => l.startsWith('|') && /configur(á|ar) las pruebas/i.test(l));
  assert.ok(fila, 'INDEX.md: una fila para configurar las pruebas en el arnés');
  assert.match(fila, /organization-site\.md/);
  for (const [archivo, palabras] of [
    ['guides/organization-site.md', [/trx/i, /detect_depth/, /repos/, /args/, /team-config/, /sin auto-?completar/i]],
    ['guides/organization-site.en.md', [/trx/i, /detect_depth/, /repos/, /args/, /team-config/, /without auto-?complete/i]],
  ]) {
    const g = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
    const sec = g.slice(g.search(/^### (Tu tecnología|Your technology)/m));
    for (const p of palabras) assert.match(sec.slice(0, 6000), p, `${archivo}: ${p}`);
  }
});
