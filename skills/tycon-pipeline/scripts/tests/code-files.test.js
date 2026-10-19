'use strict';

/**
 * code-files.test.js — la lista única de lo que es código, de lo que es una prueba y de las marcas de prueba salteada.
 *
 * Lo que sostiene: un diff de sólo Python, Svelte o Vue es código para todos los controles, y todos responden lo mismo
 * para la misma lista de archivos.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const cf = require(path.join(LIB, 'code-files.js'));

test('@story-8.48 @ac-1 T1 CodeFiles_CoreList_IncludesPySvelteVue', () => {
  // isSource = archivos fuente de un lenguaje; isCode = además los guiones .sh y los proyectos .csproj
  assert.equal(cf.isSource('scripts/x.sh'), false);
  assert.equal(cf.isSource('app/util.py'), true);
  for (const f of ['app/util.py', 'src/App.svelte', 'src/App.vue', 'src/Api.cs', 'src/a.ts', 'src/b.tsx', 'x.mjs',
    'cmd/main.go', 'Main.java', 'a.kt', 'b.rb', 'c.swift', 'scripts/x.sh', 'App/App.csproj']) {
    assert.equal(cf.isCode(f), true, `${f} es código`);
  }
  for (const f of ['README.md', 'package.json', 'logo.png', 'db/001.sql', 'site.css', 'index.html', 'a.yml']) {
    assert.equal(cf.isCode(f), false, `${f} no es código`);
  }
  assert.equal(cf.isCode('SRC/APP.PY'), true, 'la extensión no distingue mayúsculas');
});

test('@story-8.48 @ac-2 T2 CodeFiles_OrgExtensions_Added', () => {
  assert.equal(cf.isCode('lib/a.gd'), false);
  assert.equal(cf.isCode('lib/a.gd', { extra: ['.gd'] }), true);
  assert.equal(cf.isCode('lib/a.ex', { extra: ['.gd'] }), false);
});

test('@story-8.48 @ac-6 T3 CodeFiles_OrgExtensions_Invalid_IgnoredWithReason', () => {
  for (const malo of [['gd'], ['.GD'], '.gd', [3], ['.g d']]) {
    const r = cf.parseExtensions(malo);
    assert.deepEqual(r.extra, [], `${JSON.stringify(malo)} no se usa`);
    assert.ok(r.problems.length > 0, `${JSON.stringify(malo)} deja el problema dicho`);
    assert.match(r.problems[0].path, /^stack\.code_extensions/);
  }
  assert.deepEqual(cf.parseExtensions(['.gd', '.ex']).extra, ['.gd', '.ex']);
  assert.deepEqual(cf.parseExtensions(undefined), { extra: [], problems: [] });
  // con la ampliación descartada, el núcleo sigue andando
  assert.equal(cf.isCode('a.py', { extra: cf.parseExtensions(['gd']).extra }), true);
});

test('@story-8.48 @ac-5 isTestFile: pytest, Go, .NET y JS', () => {
  for (const f of ['tests/test_api.py', 'app/test_x.py', 'app/x_test.py', 'tests/unit/helpers.py', 'pkg/a_test.go',
    'src/a.test.ts', 'src/a.spec.tsx', 'scripts/tests/b.test.sh', 'Api.Tests/FooTests.cs']) {
    assert.equal(cf.isTestFile(f), true, `${f} es prueba`);
  }
  for (const f of ['app/util.py', 'src/a.ts', 'pkg/a.go', 'contest.py', 'latest.py']) {
    assert.equal(cf.isTestFile(f), false, `${f} no es prueba`);
  }
});

test('@story-8.48 @ac-5 SKIP_MARK_RE: marcas de prueba salteada de pytest y Go', () => {
  for (const s of ['it.skip(', 'test.skip(', 'xit(', '[Fact(Skip = "x")]', '@pytest.mark.skip(reason="x")',
    '@pytest.mark.skip', 'pytest.skip("x")']) {
    assert.match(s, cf.SKIP_MARK_RE, s);
  }
  assert.doesNotMatch('def test_skip_logic():', cf.SKIP_MARK_RE);
  // la de Go sólo en un .go: en C# `t.Skip(1)` es LINQ
  assert.equal(cf.hasSkipMark('func TestX(t *testing.T) { t.Skip("x") }', 'svc/x_test.go'), true);
  assert.equal(cf.hasSkipMark('var r = items.Select(t => t.Skip(1));', 'tests/SvcTests.cs'), false);
  assert.equal(cf.hasSkipMark('it.skip("x")', 'a.test.ts'), true);
});

test('@story-8.48 @ac-2 CodeFiles_OrgExtensions_TwoSegments', () => {
  // `.blade.php` la aceptan los dos lectores: tiene que calzar por la terminación completa
  assert.equal(cf.isCode('views/home.blade.php', { extra: ['.blade.php'] }), true);
  assert.equal(cf.isCode('views/home.php', { extra: ['.blade.php'] }), false);
  assert.deepEqual(cf.parseExtensions(['.blade.php']).extra, ['.blade.php']);
});

test('@story-8.48 @ac-1 T4 CodeFiles_SameAnswer_AllCallers', () => {
  const lista = ['app/util.py', 'src/App.svelte', 'src/App.vue', 'src/Api.cs', 'src/a.ts', 'x.mjs', 'cmd/main.go',
    'README.md', 'package.json', 'logo.png', 'docs/a.txt', 'Main.java', 'scripts/x.sh', 'a.yml', 'b.rb', 'c.kt',
    'd.swift', 'e.jsx', 'f.cjs', 'App.csproj', 'lib/a.gd'];
  const extra = ['.gd'];
  const { isImplPath } = require(path.join(LIB, 'atdd-order.js'));
  const { isCodeFile } = require(path.join(LIB, 'story-gate.js'));
  const freshness = require(path.join(LIB, 'suite-freshness.js'));
  const matrix = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  const report = require(path.join(LIB, 'test-gate-report.js'));
  const storyChecks = require(path.join(LIB, 'story-checks.js'));
  // Cada control pregunta lo suyo, pero sobre la MISMA lista: todo archivo fuente del núcleo (o de la ampliación de la
  // organización) es código para todos, y fuera de eso sólo entra lo que cada control suma a propósito, declarado acá.
  // (changes.js y rebuild-before-verify.js no preguntan «¿es código?»: uno reconoce cualquier archivo que escribe un
  // comando, el otro sólo componentes de pantalla. Quedan aparte, con su propia lista.)
  const llamadores = {
    'atdd-order': { fn: (f) => isImplPath(f, { extra }), propios: [] },
    'story-gate': { fn: (f) => isCodeFile(f, { extra }), propios: ['.sh'] },
    'suite-freshness': { fn: (f) => freshness.isCodeFile(f, { extra }), propios: ['.sh', '.csproj'] },
    'runtime-matrix': { fn: (f) => matrix.isCodeFile(f, { extra }), propios: ['.sh', '.csproj'] },
    'test-gate-report': { fn: (f) => report.isCodeFile(f, { extra }), propios: [] },
    'story-checks': { fn: (f) => storyChecks.isCodeFile(f, { extra }), propios: [] },
  };
  for (const [nombre, { fn, propios }] of Object.entries(llamadores)) {
    for (const f of lista) {
      const esperado = cf.isSource(f, { extra }) || propios.includes(path.extname(f).toLowerCase());
      assert.equal(fn(f), esperado, `${nombre}: ${f} ${esperado ? 'es' : 'no es'} código`);
    }
  }
});

test('@story-8.48 @ac-6 AdvisorSet_StackProblems_Visible', () => {
  // una terminación mal escrita no se usa, y el anuncio del set lo dice (antes quedaba sólo en un campo que nadie leía)
  const fs = require('fs');
  const os = require('os');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-prob-')));
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' },
    operations: { platform: 'github', org: 'acme', repo: 'o' }, stack: { code_extensions: ['EX'] } }));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-prob-repo-'));
  fs.writeFileSync(path.join(repo, 'a.py'), 'x = 1\n');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'advisors', '--repo', repo, '--files', 'a.py'], {
    encoding: 'utf8', env: { ...process.env, TYCON_GUIDES_DIR: d, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'stack-prob-home-')), CLAUDE_CODE_SESSION_ID: 'stack-prob' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.stack_problems) && out.stack_problems.some((p) => /stack\.code_extensions/.test(p)), r.stdout.slice(0, 600));
});

test('@story-8.48 @ac-1 ListasAparte_ChangesYRebuild_ReconocenLoNuevo', () => {
  // changes.js (archivos que escribe un comando) y rebuild-before-verify.js (componentes de pantalla) quedan con su lista,
  // pero suman lo que les toca: un .svelte, un .go o un .vue escritos por consola, y una pantalla Svelte editada.
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const changes = require(path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'changes.js'));
  for (const f of ['src/App.svelte', 'cmd/main.go', 'src/App.vue', 'Main.java']) {
    assert.ok(changes.destinosDeConsola(`echo hola > ${f}`).includes(f), `changes.js reconoce ${f}`);
  }
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-svelte-')));
  spawnSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'frontend:\n  dev_build_cmd: npm run build\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'App.svelte'), '<p>hola</p>\n');
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'hooks', 'rebuild-before-verify.js')], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: repo, tool_input: { file_path: path.join(repo, 'src', 'App.svelte') } }),
    encoding: 'utf8', env: { ...process.env, TYCON_REBUILD_VERIFY: '1', TYCON_EVAL_SANDBOX: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  const marca = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'frontend-dirty.json'), 'utf8'));
  assert.deepEqual(marca.files, [path.join('src', 'App.svelte')]);
});

// ── Bordes de otros stacks: superficie de los revisores, densidad, venv y catch mudo en .mjs ──────────────────────
function arbolConExtra(extra) {
  const fs = require('fs');
  const os = require('os');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-adv-')));
  fs.mkdirSync(path.join(d, 'scripts'));
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(d, 'team-repos.json'), JSON.stringify({ version: 1,
    public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' },
    operations: { platform: 'github', org: 'acme', repo: 'o' }, stack: { code_extensions: extra } }));
  return d;
}
function correrConArbol(arbol, codigo) {
  const os = require('os');
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  return spawnSync(process.execPath, ['-e', codigo], {
    encoding: 'utf8', cwd: SCRIPTS,
    env: { ...process.env, TYCON_GUIDES_DIR: arbol, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'stack-adv-home-')) },
  });
}

test('@story-8.48 @ac-2 Adversarial_completitud1_OrgExtensionIsReviewerSurface', () => {
  const r = correrConArbol(arbolConExtra(['.ex']), `
    const p = require('./pipeline.js');
    const a = p.advisorAffectedByDelta('tycon-silent-failure-hunter', ['lib/app/x.ex']).affected;
    const b = p.advisorAffectedByDelta('tycon-plugin-security-basics', ['lib/app/x.ex']).affected;
    process.stdout.write(JSON.stringify({ a, b }));`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { a: true, b: true });
});

test('@story-8.48 @ac-1 Adversarial_completitud2_DensityCountsAllSources', () => {
  const fs = require('fs');
  const os = require('os');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dens-'));
  const { spawnSync } = require('child_process');
  spawnSync('git', ['init', '-q', repo]);
  for (const f of ['A.java', 'b.kt', 'c.swift', 'd.mts', 'e.ex']) fs.writeFileSync(path.join(repo, f), 'x\n'.repeat(10));
  const r = correrConArbol(arbolConExtra(['.ex']), `
    const p = require('./pipeline.js');
    const d = p.densidadDelDiff(${JSON.stringify(repo)}, ['A.java', 'b.kt', 'c.swift', 'd.mts', 'e.ex'], { allowMissing: true });
    process.stdout.write(String(d.lineas));`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(r.stdout) >= 50, `las cinco cuentan líneas (dio ${r.stdout})`);
});

test('@story-8.48 @ac-5 Adversarial_falsoNegativo1_VenvIsSkipped', () => {
  const fs = require('fs');
  const os = require('os');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-'));
  for (const rel of ['venv/lib/python3.12/site-packages/pkg/tests/test_x.py', 'site-packages/pkg/tests/test_y.py',
    'app/__pycache__/test_z.py', 'tests/test_propio.py']) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), 'def test_x(): pass\n');
  }
  const { walkFiles } = require(path.join(LIB, 'story-checks.js'));
  const encontrados = walkFiles(repo, (n, abs) => cf.isTestFile(path.relative(repo, abs))).map((f) => path.relative(repo, f));
  assert.deepEqual(encontrados, [path.join('tests', 'test_propio.py')]);
});

test('@story-8.48 @ac-3 Adversarial_falsoNegativo3_EmptyCatchInMjsCallsHunter', () => {
  const fs = require('fs');
  const os = require('os');
  for (const f of ['x.mjs', 'x.cjs', 'x.mts']) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mjs-'));
    fs.writeFileSync(path.join(repo, f), 'try { a() } catch (e) {}\n');
    const { computeAdvisorSet } = require(path.join(SCRIPTS, 'pipeline.js'));
    const set = computeAdvisorSet({ repo, story: null, files: [f] });
    assert.ok(set.all.includes('tycon-silent-failure-hunter'), `${f}: ${set.all.join(', ')}`);
  }
});
