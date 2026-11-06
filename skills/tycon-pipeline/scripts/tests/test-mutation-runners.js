#!/usr/bin/env node
'use strict';
/**
 * test-mutation-runners.js — el chequeo de mutantes con las recetas de pruebas: .NET, Vitest, Jest, pytest y
 * `node --test`, más las de la organización que dicen cómo correr sólo algunas pruebas (`scoped`).
 *
 * Lo que sostiene: la receta se elige por estructura (nunca leyendo una prueba), corre sólo las pruebas declaradas, el
 * portón de pruebas no cambia, C# y Python se mutan con su catálogo, los topes cierran entre sí, y las recetas nuevas
 * avisan dos semanas antes de frenar.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/test-mutation-runners.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const ROOT = path.join(SCRIPTS, '..', '..', '..');
const runners = require(path.join(SCRIPTS, 'lib', 'test-runners.js'));
const team = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
const checker = require(path.join(SCRIPTS, 'mutation-check.js'));
const gate = require(path.join(SCRIPTS, 'lib', 'mutation-gate.js'));
const cs = require(path.join(SCRIPTS, 'lib', 'mutation-mutants-cs.js'));
const py = require(path.join(SCRIPTS, 'lib', 'mutation-mutants-py.js'));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com',
  GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
};

// git con el mantenimiento automático apagado: si no, queda corriendo de fondo y toca el .git del laboratorio
function sh(cmd, args, cwd) {
  const todos = cmd === 'git' ? ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args] : args;
  const r = spawnSync(cmd, todos, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`falló: ${cmd} ${args.join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

function escribir(dir, archivos) {
  for (const [rel, c] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), c);
  }
}

/** Un repo git con `base` commiteado y `nuevos` escritos encima, sin commitear. */
function repo(base, nuevos = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutrun-')));
  sh('git', ['init', '-q'], d);
  sh('git', ['config', 'commit.gpgsign', 'false'], d);
  escribir(d, { '.keep': '', ...base });
  sh('git', ['add', '-A'], d);
  sh('git', ['commit', '-q', '-m', 'base'], d);
  escribir(d, nuevos);
  return d;
}

function story(dir, archivos, nombre = 'story.md') {
  fs.writeFileSync(path.join(dir, nombre), [
    '---', 'story: "MUT-X"', 'epic: fixtures', 'status: in-progress', 'files_to_create:',
    ...archivos.map((a) => `  - "${a}"`), '---', '', '# fixture', '',
  ].join('\n'));
  return path.join(dir, nombre);
}

const CSPROJ_TEST = '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.8.0" />\n  </ItemGroup>\n</Project>\n';
const siempre = () => true;
const nunca = () => false;

// ── La receta y su comando acotado ──────────────────────────────────────────

test('@story-8.204 @ac-1 T1 Receta_Scoped_FilesOClassesOProblema', () => {
  const base = { detect: 'mi.config', command: 'mi-tool run', results: { format: 'junit', path: '{results}/j.xml' } };
  const conFiles = runners.validateRunners([{ ...base, name: 'uno', scoped: 'mi-tool run {files}' }]);
  const conClases = runners.validateRunners([{ ...base, name: 'dos', scoped: 'mi-tool run --filter "{classes}"' }]);
  const sinNada = runners.validateRunners([{ ...base, name: 'tres', scoped: 'mi-tool run todo' }]);
  assert.deepEqual(conFiles.problems, []);
  assert.deepEqual(conClases.problems, []);
  assert.equal(sinNada.runners.length, 0);
  assert.equal(sinNada.problems.length, 1);
  assert.equal(sinNada.problems[0].path, 'stack.test_runners.0.scoped');
  assert.match(sinNada.problems[0].message, /\{files\}.*\{classes\}/);
  const enTeam = team.stackProblems({ test_runners: [{ ...base, name: 'tres', scoped: 'mi-tool run todo' }] });
  assert.deepEqual(enTeam, sinNada.problems, 'team-repos.js dice lo mismo que test-runners.js');
  assert.deepEqual(team.stackProblems({ test_runners: [{ ...base, name: 'uno', scoped: 'x {files}' }] }), []);
});

test('@story-8.204 @ac-2 T2 Fabrica_LasCuatroNuevasYPytest_ConScoped', () => {
  const f = (n) => runners.FACTORY.find((r) => r.name === n);
  for (const n of ['jest', 'vitest', 'dotnet', 'node-test']) {
    assert.ok(f(n), `falta la receta ${n}`);
    assert.equal(f(n).gate, false, `${n} no la usa el portón`);
  }
  assert.match(f('jest').scoped, /node_modules\/\.bin\/jest --runTestsByPath \{files\} --ci --silent --json --outputFile=\{results\}\/jest\.json/);
  assert.match(f('vitest').scoped, /node_modules\/\.bin\/vitest run \{files\} --reporter=json --outputFile=\{results\}\/vitest\.json/);
  assert.match(f('dotnet').scoped, /^dotnet test \{project\} --filter "\{classes\}" --logger "trx;LogFileName=\{results\}\/mutation\.trx"$/);
  assert.equal(f('node-test').scoped, 'node --test {files}');
  assert.equal(f('pytest').scoped, '{tool} -m pytest {files} -q --junitxml={results}/junit.xml');
  assert.equal(f('jest').results.format, 'jest-json');
  assert.equal(f('vitest').results.format, 'jest-json');
  assert.equal(f('dotnet').results.format, 'trx');
  assert.equal(f('pytest').results.format, 'junit');
  assert.equal(f('node-test').results, null);
  assert.ok(f('pytest').gate !== false, 'pytest la sigue usando el portón');
});

test('@story-8.204 @ac-3 T3 Porton_ElMismoCorredorQueAntes', () => {
  // Proyectos de cada tecnología: el portón (test-runners.js resolve) no elige ninguna receta `gate: false`.
  const casos = [
    [{ 'package.json': '{"scripts":{"test":"jest"},"devDependencies":{"jest":"^29"}}', 'jest.config.js': '' }, null],
    [{ 'package.json': '{"devDependencies":{"vitest":"^1"}}', 'vitest.config.ts': '' }, null],
    [{ 'Api.Tests.csproj': CSPROJ_TEST }, null],
    [{ 'package.json': '{"scripts":{"test":"node --test"}}' }, null],
    [{ 'pytest.ini': '[pytest]\n' }, 'pytest'],
    [{ 'go.mod': 'module x\n' }, 'go'],
  ];
  for (const [archivos, esperado] of casos) {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-porton-')));
    escribir(d, archivos);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'test-runners.js'), 'resolve', d], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.runner ? j.runner.name : null, esperado, `${Object.keys(archivos).join(',')}`);
  }
  // el sitio y el alcance tampoco ven las recetas nuevas
  const tabla = runners.factoryTable().map((x) => x.name);
  for (const n of ['jest', 'vitest', 'dotnet', 'node-test']) assert.ok(!tabla.includes(n), `${n} no va a la tabla del sitio`);
  assert.equal(tabla[tabla.length - 1], 'playwright');
  assert.ok(!runners.detectorFiles(undefined).some((x) => ['jest', 'vitest', 'dotnet', 'node-test'].includes(x.name)));
});

// ── Qué receta usa el chequeo ────────────────────────────────────────────────

test('@story-8.204 @ac-4 T4 Elige_PorEstructura_CadaReceta', () => {
  const d = repo({
    'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/jest.config.js': '',
    'web/node_modules/.bin/jest': '', 'web/src/a.test.ts': '',
    'sdk/package.json': '{"devDependencies":{"vitest":"^1"}}', 'sdk/vitest.config.ts': '',
    'sdk/node_modules/.bin/vitest': '', 'sdk/src/b.test.ts': '',
    'api/Api.Tests/Api.Tests.csproj': CSPROJ_TEST, 'api/Api.Tests/CalcTests.cs': '',
    'py/pytest.ini': '[pytest]\n', 'py/tests/test_x.py': '',
    'tools/x.test.js': '',
  });
  const elegir = (f) => runners.scopedRecipe({ repo: d, testFiles: [f], stack: {}, which: siempre });
  assert.equal(elegir('web/src/a.test.ts').name, 'jest');
  assert.equal(elegir('sdk/src/b.test.ts').name, 'vitest');
  assert.equal(elegir('api/Api.Tests/CalcTests.cs').name, 'dotnet');
  assert.equal(elegir('py/tests/test_x.py').name, 'pytest');
  const nt = elegir('tools/x.test.js');
  assert.equal(nt.name, 'node-test');
  assert.equal(nt.cwd, d, 'node --test corre en la raíz del repo, como hoy');
});

test('@story-8.204 @ac-4 T30 Elige_JestYVitestSinConfig_ComoElPorton', () => {
  const d = repo({
    'a/package.json': '{"scripts":{"test":"jest"}}', 'a/node_modules/.bin/jest': '', 'a/x.test.js': '',
    'b/package.json': '{"devDependencies":{"vitest":"^1"}}', 'b/vite.config.ts': '', 'b/node_modules/.bin/vitest': '',
    'b/y.test.ts': '',
  });
  assert.equal(runners.scopedRecipe({ repo: d, testFiles: ['a/x.test.js'], stack: {} }).name, 'jest');
  assert.equal(runners.scopedRecipe({ repo: d, testFiles: ['b/y.test.ts'], stack: {} }).name, 'vitest');
});

test('@story-8.204 @ac-5 T5 Elige_OrganizacionPrimero_SinScopedEstructural', () => {
  const d = repo({ 'app/mi.config': '', 'app/pytest.ini': '[pytest]\n', 'app/tests/test_a.py': '' });
  const base = { detect: 'mi.config', command: 'mi-tool run', results: { format: 'junit', path: '{results}/j.xml' } };
  const con = runners.scopedRecipe({
    repo: d, testFiles: ['app/tests/test_a.py'],
    stack: { test_runners: [{ ...base, name: 'mi-tool', scoped: 'mi-tool run {files} --out {results}/j.xml' }] },
  });
  assert.equal(con.name, 'mi-tool');
  assert.equal(con.source, 'organizacion');
  assert.match(con.command, /mi-tool run 'tests\/test_a\.py' --out \{results\}\/j\.xml/);
  const sin = runners.scopedRecipe({ repo: d, testFiles: ['app/tests/test_a.py'], stack: { test_runners: [{ ...base, name: 'mi-tool' }] } });
  assert.ok(sin.problem);
  assert.match(sin.problem, /la receta mi-tool no dice cómo correr sólo algunas pruebas \(falta scoped en stack\.test_runners\)/);
});

test('@story-8.204 @ac-6 T6 Elige_DosRecetasOMocha_Estructural', () => {
  const d = repo({
    'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/node_modules/.bin/jest': '', 'web/a.test.js': '',
    'api/Api.Tests.csproj': CSPROJ_TEST, 'api/ATests.cs': '',
    'mix/package.json': '{}', 'mix/jest.config.js': '', 'mix/vitest.config.ts': '', 'mix/m.test.ts': '',
    'w1/package.json': '{"devDependencies":{"jest":"^29"}}', 'w1/node_modules/.bin/jest': '', 'w1/a.test.js': '',
    'w2/package.json': '{"devDependencies":{"jest":"^29"}}', 'w2/node_modules/.bin/jest': '', 'w2/b.test.js': '',
    'mo/package.json': '{"devDependencies":{"mocha":"^10"}}', 'mo/c.test.js': '',
  });
  const r = (files) => runners.scopedRecipe({ repo: d, testFiles: files, stack: {}, which: siempre });
  const dos = r(['web/a.test.js', 'api/ATests.cs']);
  assert.match(dos.problem, /jest/); assert.match(dos.problem, /dotnet/);
  const mix = r(['mix/m.test.ts']);
  assert.match(mix.problem, /Jest/); assert.match(mix.problem, /Vitest/);
  const paquetes = r(['w1/a.test.js', 'w2/b.test.js']);
  assert.match(paquetes.problem, /w1/); assert.match(paquetes.problem, /w2/);
  assert.match(r(['mo/c.test.js']).problem, /Mocha no está soportado: no se afirma nada sobre esa suite/);
});

test('@story-8.204 @ac-7 T7 Elige_ComentarioQueDiceVitest_NoCambiaNada', () => {
  const d = repo({
    'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/node_modules/.bin/jest': '',
    'web/a.test.js': "// migrado desde vitest: import { it } from 'vitest'\ntest('x', () => {});\n",
  });
  assert.equal(runners.scopedRecipe({ repo: d, testFiles: ['web/a.test.js'], stack: {} }).name, 'jest');
});

// ── Correr acotado ───────────────────────────────────────────────────────────

test('@story-8.204 @ac-8 T8 Corre_JestYVitest_BinarioDelPaqueteYSusArchivos', () => {
  const d = repo({
    'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/node_modules/.bin/jest': '',
    'web/src/a.test.ts': '', 'web/src/b.test.ts': '', 'web/src/c.test.ts': '',
    'sdk/package.json': '{"devDependencies":{"vitest":"^1"}}', 'sdk/node_modules/.bin/vitest': '', 'sdk/x.test.ts': '',
  });
  const j = runners.scopedRecipe({ repo: d, testFiles: ['web/src/a.test.ts', 'web/src/b.test.ts'], stack: {} });
  assert.equal(j.cwd, path.join(d, 'web'));
  assert.equal(j.command, `'${path.join(d, 'web', 'node_modules', '.bin', 'jest')}' --runTestsByPath 'src/a.test.ts' 'src/b.test.ts' --ci --silent --json --outputFile={results}/jest.json`);
  assert.ok(!/c\.test/.test(j.command), 'sólo los archivos declarados');
  const v = runners.scopedRecipe({ repo: d, testFiles: ['sdk/x.test.ts'], stack: {} });
  assert.equal(v.cwd, path.join(d, 'sdk'));
  assert.equal(v.command, `'${path.join(d, 'sdk', 'node_modules', '.bin', 'vitest')}' run 'x.test.ts' --reporter=json --outputFile={results}/vitest.json`);
});

test('@story-8.204 @ac-8 T9 Corre_SinNodeModules_Estructural', () => {
  const d = repo({ 'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/a.test.js': '', 'node_modules/.bin/jest': '' });
  const r = runners.scopedRecipe({ repo: d, testFiles: ['web/a.test.js'], stack: {} });
  assert.equal(r.problem, 'dependencias sin instalar en web', 'el binario de la raíz no cuenta: es el del paquete');
});

test('@story-8.204 @ac-9 T10 Corre_Dotnet_FiltroPorClase', () => {
  const d = repo({ 'Api.Tests/Api.Tests.csproj': CSPROJ_TEST, 'Api.Tests/ATests.cs': '', 'Api.Tests/Sub/BTests.cs': '' });
  const r = runners.scopedRecipe({ repo: d, testFiles: ['Api.Tests/ATests.cs', 'Api.Tests/Sub/BTests.cs'], stack: {}, which: siempre });
  assert.equal(r.name, 'dotnet');
  assert.equal(r.cwd, path.join(d, 'Api.Tests'));
  assert.ok(r.command.includes('--filter "FullyQualifiedName~.ATests.|FullyQualifiedName~.BTests."'), r.command);
  assert.ok(r.command.startsWith(`dotnet test '${path.join(d, 'Api.Tests', 'Api.Tests.csproj')}'`), r.command);
  assert.equal(runners.scopedRecipe({ repo: d, testFiles: ['Api.Tests/ATests.cs'], stack: {}, which: nunca }).problem,
    'falta dotnet en el PATH: no puedo correr las pruebas de Api.Tests');
});

test('@story-8.204 @ac-9 T10b Corre_NombresDelRepo_NoEntranAlComando', () => {
  // Un nombre de archivo del repo probado no puede ejecutar nada ni hacerse pasar por una opción.
  const d = repo({ 'T/T.csproj': CSPROJ_TEST, 'T/$(touch pwned).cs': '', 'T/ATests.cs': '', 'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/node_modules/.bin/jest': '', 'web/-x.test.js': '' });
  const raro = runners.scopedRecipe({ repo: d, testFiles: ['T/$(touch pwned).cs'], stack: {}, which: siempre });
  assert.match(raro.problem, /no es un nombre de clase de C#/);
  const org = runners.scopedRecipe({
    repo: d, testFiles: ['T/$(touch pwned).cs'], which: siempre,
    stack: { test_runners: [{ name: 'mi-net', detect: 'T.csproj', command: 'x', scoped: 'x --filter "{classes}"', results: { format: 'trx', path: '{results}/a.trx' } }] },
  });
  assert.match(org.problem, /no es un nombre de clase de C#/, 'también en la receta de la organización');
  const guion = runners.scopedRecipe({ repo: d, testFiles: ['web/-x.test.js'], stack: {} });
  assert.match(guion.command, / '\.\/-x\.test\.js' /, 'un archivo que empieza con «-» va con ./ adelante');
  // un archivo cuyo nombre trae una marca de la receta no se vuelve a reemplazar: el comando se arma en una sola pasada
  escribir(d, { 'web/{classes}.test.js': '' });
  const marca = runners.scopedRecipe({
    repo: d, testFiles: ['web/{classes}.test.js'],
    stack: { test_runners: [{ name: 'mi-js', detect: 'package.json', command: 'x', scoped: 'x {files} --f "{classes}"', results: { format: 'junit', path: '{results}/j.xml' } }] },
  });
  assert.equal(marca.problem, 'no quedó ninguna clase de prueba para filtrar: no corro la suite entera');
  const marca2 = runners.scopedRecipe({
    repo: d, testFiles: ['web/{classes}.test.js'],
    stack: { test_runners: [{ name: 'mi-js', detect: 'package.json', command: 'x', scoped: 'x {files} {args}', args_default: 'A', results: { format: 'junit', path: '{results}/j.xml' } }] },
  });
  assert.equal(marca2.command, "x '{classes}.test.js' A");
  assert.deepEqual(marca2.warnings, [], 'los avisos de {args} viajan con la receta');
});

test('@story-8.204 @ac-9 T11 Corre_DotnetSinClases_NoCorreNada', async () => {
  const d = repo({ 'Api.Tests/Api.Tests.csproj': CSPROJ_TEST, 'Api/Calc.cs': 'class C {}\n' }, {
    'Api.Tests/data/calc.test.js': '', 'Api/Calc.cs': 'class C { bool f(int a) { return a == 1; } }\n',
  });
  const s = story(d, ['Api/Calc.cs', 'Api.Tests/data/calc.test.js']);
  let corridas = 0;
  const r = await checker.runMutationCheck({
    repo: d, storyPath: s, stack: {}, recipeOpts: { which: siempre },
    runTests: () => { corridas += 1; return { code: 0 }; }, log: () => {},
  });
  assert.equal(r.exitCode, 2);
  assert.match(r.result.motivo, /ninguna clase de prueba/);
  assert.equal(corridas, 0, 'nunca la suite entera');
});

test('@story-8.204 @ac-10 T12 Corre_Pytest_ReconoceYAcota', async () => {
  assert.ok(checker.looksLikeTestPath('app/test_a.py'));
  assert.ok(checker.looksLikeTestPath('app/b_test.py'));
  assert.ok(checker.looksLikeTestPath('app/tests/c.py'));
  assert.ok(!checker.looksLikeTestPath('app/d.py'));
  const d = repo({ 'app/pytest.ini': '[pytest]\n', 'app/test_a.py': '', 'app/b_test.py': '', 'app/tests/c.py': '', 'app/d.py': '' });
  const r = runners.scopedRecipe({ repo: d, testFiles: ['app/test_a.py', 'app/b_test.py', 'app/tests/c.py'], stack: {} });
  assert.equal(r.name, 'pytest');
  assert.equal(r.cwd, path.join(d, 'app'));
  assert.match(r.command, /-m pytest 'test_a\.py' 'b_test\.py' 'tests\/c\.py' -q --junitxml=\{results\}\/junit\.xml$/);
  assert.ok(!/d\.py/.test(r.command));
  // con conftest.py en tests/ y pytest.ini en la raíz, pytest corre desde la raíz (si no, el paquete no se importa)
  const raiz = repo({ 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'tests/conftest.py': '', 'tests/test_a.py': '' });
  const rr = runners.scopedRecipe({ repo: raiz, testFiles: ['tests/test_a.py'], stack: {} });
  assert.equal(rr.cwd, raiz);
  assert.match(rr.command, / 'tests\/test_a\.py' /);
  // un archivo de código cuyo nombre termina en «test» no es una prueba
  assert.ok(!checker.looksLikeTestPath('src/Latest.cs'));
  assert.ok(!checker.looksLikeTestPath('src/Contest.cs'));
  assert.ok(checker.looksLikeTestPath('src/CalcTests.cs'));
  const lt = repo({ 'src/latest.ts': '' }, { 'src/latest.ts': 'export const f = (a: number) => a === 1;\n' });
  const rl = await checker.runMutationCheck({ repo: lt, storyPath: story(lt, ['src/latest.ts']), stack: {}, runTests: () => ({ code: 0 }), log: () => {} });
  assert.equal(rl.exitCode, 2);
  assert.match(rl.result.motivo, /no declara ningún archivo de test/, 'latest.ts no cuenta como prueba declarada');
});

test('@story-8.204 @ac-11 T13 Corre_BaseRoja_Estructural', async () => {
  const casos = [
    ['jest', { 'web/package.json': '{"devDependencies":{"jest":"^29"}}', 'web/node_modules/.bin/jest': '', 'web/a.test.js': '' },
      { 'web/a.js': 'module.exports = (a) => a === 1;\n' }, ['web/a.js', 'web/a.test.js']],
    ['vitest', { 'web/package.json': '{"devDependencies":{"vitest":"^1"}}', 'web/node_modules/.bin/vitest': '', 'web/a.test.ts': '' },
      { 'web/a.ts': 'export const f = (a: number) => a === 1;\n' }, ['web/a.ts', 'web/a.test.ts']],
    ['dotnet', { 'T/T.csproj': CSPROJ_TEST, 'T/ATests.cs': '' }, { 'A.cs': 'class A { bool f(int a) { return a == 1; } }\n' }, ['A.cs', 'T/ATests.cs']],
    ['pytest', { 'pytest.ini': '[pytest]\n', 'tests/test_a.py': '' }, { 'a.py': 'def f(a):\n    return a == 1\n' }, ['a.py', 'tests/test_a.py']],
  ];
  for (const [nombre, base, nuevos, decl] of casos) {
    const d = repo(base, nuevos);
    const r = await checker.runMutationCheck({
      repo: d, storyPath: story(d, decl), stack: {}, recipeOpts: { which: siempre },
      runTests: () => ({ code: 1 }), log: () => {},
    });
    assert.equal(r.exitCode, 2, nombre);
    assert.match(r.result.motivo, /BASE/, nombre);
    assert.match(r.result.motivo, new RegExp(nombre), `${nombre}: el motivo nombra la receta`);
    assert.equal(r.result.runner, nombre);
  }
});

test('@story-8.204 @ac-12 T14 Copia_Dotnet_SinBinNiObj_YElRepoIntacto', () => {
  const d = repo({ '.gitignore': 'bin/\nobj/\nnode_modules/\n__pycache__/\n', 'A/A.csproj': '<Project/>', 'B/B.csproj': '<Project/>', 'py/m.py': '' }, {
    'A/bin/Debug/a.dll': 'x', 'A/obj/project.assets.json': '{}', 'B/bin/b.dll': 'x', 'B/obj/x': 'x', 'node_modules/m/i.js': '',
    'py/__pycache__/m.cpython-312.pyc': 'x',
  });
  const antes = sh('git', ['status', '--porcelain', '--ignored'], d);
  const copia = checker.crearCopiaDeTrabajo(d, () => {});
  try {
    assert.ok(copia.dir);
    // la copia va por su ruta real (en macOS /var es un enlace a /private/var): con la otra, .NET restaura los paquetes
    // con una ruta y compila con la otra, y no los encuentra (medido en E1)
    assert.equal(copia.dir, fs.realpathSync(copia.dir));
    for (const rel of ['A/bin', 'A/obj', 'B/bin', 'B/obj', 'py/__pycache__']) assert.ok(!fs.existsSync(path.join(copia.dir, rel)), `${rel} no se enlaza`);
    assert.ok(fs.lstatSync(path.join(copia.dir, 'node_modules')).isSymbolicLink(), 'lo demás que git ignora se sigue enlazando');
  } finally { fs.rmSync(copia.dir, { recursive: true, force: true }); }
  assert.equal(sh('git', ['status', '--porcelain', '--ignored'], d), antes);
});

test('@story-8.204 @ac-13 T15 Corre_Tope_TimedOutNoEsFallo', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-tope-')));
  // stable-data: el reloj mide cuánto tarda el corredor en matar el comando, no es una fecha que se compara
  const t0 = Date.now();
  const out = await checker.runRecipe({ recipe: { name: 'x', cwd: d, command: 'sleep 20', results: null }, capMs: 300 });
  assert.equal(out.timedOut, true);
  // Python no deja .pyc: uno viejo podría servir el mutante anterior (mismo tamaño, mismo segundo)
  const pyc = await checker.runRecipe({ recipe: { name: 'x', cwd: d, command: 'test "$PYTHONDONTWRITEBYTECODE" = 1', results: null }, capMs: 5000 });
  assert.equal(pyc.code, 0);
  assert.ok(Date.now() - t0 < 10000, 'muere con SIGKILL, no espera al comando');
  // un mutante que pasa su tope no cuenta como cazado
  const r = repo({ 'calc.test.js': '' }, { 'calc.js': 'module.exports = (a) => a === 1 && a !== 2;\n' });
  const res = await checker.runMutationCheck({
    repo: r, storyPath: story(r, ['calc.js', 'calc.test.js']), stack: {},
    runTests: ({ mutant }) => (mutant ? { code: 1, timedOut: true } : { code: 0 }), log: () => {},
  });
  assert.equal(res.result.killed, 0, 'un tope no es «cazado»');
  assert.ok(res.result.skipped.some((s) => /tope/.test(s.reason)));
});

// ── Mutar C# y Python ────────────────────────────────────────────────────────

test('@story-8.204 @ac-14 T16 CatalogoCs_OrdenYBordes', () => {
  const lineas = [
    'if (a == b && c != d || e >= f && g <= h || i > j && k < l) { }',
    'return true;',
    'return false;',
  ];
  const ms = cs.generateMutants([{ file: 'A.cs', source: lineas.join('\n'), addedLines: [1, 2, 3] }]);
  assert.deepEqual(ms.filter((m) => m.line === 1).map((m) => m.operator),
    ['eq-a-neq', 'neq-a-eq', 'and-a-or', 'or-a-and', 'gte-a-gt', 'lte-a-lt', 'gt-a-gte', 'lt-a-lte']);
  assert.deepEqual(ms.filter((m) => m.line > 1).map((m) => m.operator), ['return-true-a-false', 'return-false-a-true']);
  const gt = ms.find((m) => m.operator === 'gt-a-gte');
  assert.ok(gt.after.includes('i >= j'));
  // genéricos, lambdas y flechas no se tocan
  assert.deepEqual(cs.generateMutants([{ file: 'B.cs', source: 'var x = new List<int>(); Func<int,bool> f = a => a;', addedLines: [1] }]), []);
  // un operador definido (`operator ==`) no se muta: el mutante duplicaría la definición y no compilaría
  assert.deepEqual(cs.generateMutants([{ file: 'C.cs', source: 'public static bool operator ==(A a, A b) => a.X == b.X;', addedLines: [1] }]), []);
});

test('@story-8.204 @ac-14 T17 CatalogoCs_NoMutaTextoComentarioUsingAtributo', () => {
  const src = [
    'var s = "a > b";',
    '// a > b',
    '/// a > b',
    '/* a > b */',
    'using X;',
    'namespace Y;',
    '[Range(0, 10)]',
    'var v = @"a == b";',
    "var c = '=';",
  ].join('\n');
  assert.deepEqual(cs.generateMutants([{ file: 'A.cs', source: src, addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }]), []);
  // lo que cruza líneas: un comentario de bloque, un texto @"…" y uno de tres comillas; el código de después sí se muta
  const varias = [
    '/* empieza', '   a == b && c', '*/', 'var v = @"uno', 'a == b";', 'var r = """', '  a == b', '  """;', 'var x = p == q;',
  ].join('\n');
  const ms = cs.generateMutants([{ file: 'D.cs', source: varias, addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }]);
  assert.deepEqual(ms.map((m) => m.line), [9], JSON.stringify(ms));
});

test('@story-8.204 @ac-15 T18 CatalogoPy_OrdenYBordes', () => {
  const src = [
    'x = a == b and c != d or e >= f and g <= h or i > j and k < l',
    'return True',
    'return False',
    'if listo:',
  ].join('\n');
  const ms = py.generateMutants([{ file: 'a.py', source: src, addedLines: [1, 2, 3, 4] }]);
  assert.deepEqual(ms.filter((m) => m.line === 1).map((m) => m.operator),
    ['eq-a-neq', 'neq-a-eq', 'and-a-or', 'or-a-and', 'gte-a-gt', 'lte-a-lt', 'gt-a-gte', 'lt-a-lte']);
  assert.deepEqual(ms.filter((m) => m.line > 1).map((m) => m.operator), ['return-true-a-false', 'return-false-a-true', 'negar-if']);
  assert.equal(ms.find((m) => m.operator === 'negar-if').after, 'if not (listo):');
  assert.deepEqual(py.generateMutants([{ file: 'b.py', source: 'def f(a) -> int:', addedLines: [1] }]), []);
});

test('@story-8.204 @ac-15 T19 CatalogoPy_NoMutaTextoComentarioImportDecorador', () => {
  const src = ['s = "a > b"', "t = 'a == b'", '# a > b', 'import x', 'from y import z', '@decorador(a > b)', 'u = """a and b"""'].join('\n');
  assert.deepEqual(py.generateMutants([{ file: 'a.py', source: src, addedLines: [1, 2, 3, 4, 5, 6, 7] }]), []);
  // un docstring de varias líneas es texto, aunque diga «a == b and» o empiece con «if»
  const doc = ['def f(a, b):', '    """Devuelve True si', '    a == b and a > 0', '    if a is None:', '    """', '    return a == b'].join('\n');
  assert.deepEqual(py.generateMutants([{ file: 'b.py', source: doc, addedLines: [1, 2, 3, 4, 5, 6] }]).map((m) => m.line), [6]);
  // una palabra con letras no ASCII que contiene «or» no se parte
  assert.deepEqual(py.generateMutants([{ file: 'c.py', source: 'señor = 1', addedLines: [1] }]), []);
});

test('@story-8.204 @ac-16 T20 Catalogos_PurosYDeterministas', () => {
  const cp = require('child_process');
  const vigilados = [[fs, 'readFileSync'], [fs, 'existsSync'], [fs, 'statSync'], [cp, 'spawn'], [cp, 'spawnSync'], [cp, 'execFileSync']];
  const originales = vigilados.map(([o, k]) => o[k]);
  let llamadas = 0;
  vigilados.forEach(([o, k]) => { o[k] = (...a) => { llamadas += 1; return originales[vigilados.findIndex(([oo, kk]) => oo === o && kk === k)](...a); }; });
  let a; let b; let c; let e;
  try {
    const entCs = [{ file: 'B.cs', source: 'if (a == b) { return true; }\nx = c > d;', addedLines: [1, 2] }, { file: 'A.cs', source: 'y = e != f;', addedLines: [1] }];
    const entPy = [{ file: 'a.py', source: 'if a == b:\n    return True', addedLines: [1, 2] }];
    a = cs.generateMutants(entCs); b = cs.generateMutants(entCs.slice().reverse());
    c = py.generateMutants(entPy); e = py.generateMutants(entPy);
  } finally { vigilados.forEach(([o, k], i) => { o[k] = originales[i]; }); }
  assert.equal(llamadas, 0, 'ni disco ni procesos');
  assert.deepEqual(a, b);
  assert.deepEqual(c, e);
  assert.equal(a[0].file, 'A.cs', 'orden por archivo, sin importar el de entrada');
});

test('@story-8.204 @ac-17 T21 Mutar_SoloLineasAgregadas_YRestaura', async () => {
  const casos = [
    [{ 'T/T.csproj': CSPROJ_TEST, 'T/CalcTests.cs': '', 'Calc.cs': 'class C {\n  bool v(int a) { return a == 0; }\n}\n' },
      { 'Calc.cs': 'class C {\n  bool v(int a) { return a == 0; }\n  bool n(int a) { return a != 1; }\n}\n' }, ['Calc.cs', 'T/CalcTests.cs'], 'Calc.cs', 3],
    [{ 'pytest.ini': '[pytest]\n', 'tests/test_calc.py': '', 'calc.py': 'def v(a):\n    return a == 0\n' },
      { 'calc.py': 'def v(a):\n    return a == 0\ndef n(a):\n    return a != 1\n' }, ['calc.py', 'tests/test_calc.py'], 'calc.py', 4],
  ];
  for (const [base, nuevos, decl, target, lineaNueva] of casos) {
    const d = repo(base, nuevos);
    const original = fs.readFileSync(path.join(d, target));
    const vistas = [];
    let restaurado = true;
    const r = await checker.runMutationCheck({
      repo: d, storyPath: story(d, decl), stack: {}, recipeOpts: { which: siempre }, log: () => {},
      runTests: ({ repo: copia, mutant }) => {
        const actual = fs.readFileSync(path.join(copia, target));
        if (mutant) {
          vistas.push(mutant.line);
          const dif = actual.toString().split('\n').map((l, i) => (l !== original.toString().split('\n')[i] ? i + 1 : null)).filter(Boolean);
          assert.deepEqual(dif, [mutant.line], 'sólo cambia la línea del mutante');
        } else if (Buffer.compare(actual, original) !== 0) restaurado = false;
        return { code: mutant ? 1 : 0, tests: 1 };
      },
    });
    assert.equal(r.exitCode, 0, JSON.stringify(r.result));
    assert.ok(vistas.length >= 1);
    assert.ok(vistas.every((l) => l === lineaNueva), `${target}: sólo la línea nueva (${vistas})`);
    assert.ok(restaurado);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(d, target)), original), 0, 'el repo original queda igual');
  }
});

// ── Topes, aviso y registro ─────────────────────────────────────────────────

/** Un repo node con N mutantes posibles (una línea con `===` cada una). */
function repoConMutantes(n) {
  const lineas = Array.from({ length: n }, (_v, i) => `exports.f${i} = (a) => a === ${i};`);
  return repo({ 'calc.test.js': '' }, { 'calc.js': `${lineas.join('\n')}\n` });
}

test('@story-8.204 @ac-18 T22 Topes_PorReceta_CierranEntreSi', async () => {
  assert.deepEqual(checker.BUDGETS.dotnet, { totalMs: 480000, perRunMs: 180000 });
  assert.deepEqual(checker.BUDGETS.default, { totalMs: 180000, perRunMs: 120000 });
  assert.equal(gate.HARD_TIMEOUT_MS, 720000, 'el portón, red de último recurso a los 12 min');
  // .NET: la base termina a los 7:50; el primer mutante sólo tiene 10 s
  const d = repo({ 'T/T.csproj': CSPROJ_TEST, 'T/ATests.cs': '' }, { 'A.cs': 'class A {\n bool f(int a) { return a == 1; }\n bool g(int a) { return a != 2; }\n}\n' });
  let reloj = 0;
  const topes = [];
  const r = await checker.runMutationCheck({
    repo: d, storyPath: story(d, ['A.cs', 'T/ATests.cs']), stack: {}, recipeOpts: { which: siempre }, log: () => {},
    now: () => reloj,
    runTests: ({ mutant, capMs }) => {
      topes.push(capMs);
      if (!mutant) { reloj += 470000; return { code: 0, tests: 3 }; }
      reloj += capMs; return { code: 1, timedOut: true };
    },
  });
  assert.equal(topes[0], 180000, 'la base tiene su tope por corrida');
  assert.equal(topes[1], 10000, 'el mutante que arranca a los 7:50 tiene 10 s');
  assert.equal(topes.length, 2, 'no arranca otro pasado el total');
  assert.ok(reloj <= 480000);
  assert.equal(r.result.budgetMs, 480000);
  // las demás: 3 min en total, 2 por corrida
  const j = repoConMutantes(1);
  const topesJ = [];
  const rj = await checker.runMutationCheck({
    repo: j, storyPath: story(j, ['calc.js', 'calc.test.js']), stack: {}, log: () => {}, now: () => 0,
    runTests: ({ capMs, mutant }) => { topesJ.push(capMs); return { code: mutant ? 1 : 0 }; },
  });
  assert.deepEqual(topesJ, [120000, 120000]);
  assert.equal(rj.result.budgetMs, 180000);
});

test('@story-8.204 @ac-19 T23 Chequeo_AvisoAntesDeLaBase_YJson', () => {
  // Un repo .NET con 7 mutantes y un `dotnet` de mentira que deja constancia de que corrió la base y falla.
  const d = repo({ 'T/T.csproj': CSPROJ_TEST, 'T/ATests.cs': '' }, {
    'A.cs': ['class A {', ...Array.from({ length: 7 }, (_v, i) => `  bool f${i}(int a) { return a == ${i}; }`), '}', ''].join('\n'),
  });
  const s = story(d, ['A.cs', 'T/ATests.cs']);
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-fakedotnet-')));
  const marca = path.join(bin, 'corrio-la-base');
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/sh\necho base >> '${marca}'\nexit 1\n`, { mode: 0o755 });
  const log = path.join(bin, 'gates.log');
  const programa = `
    const g = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'mutation-gate.js'))});
    const fs = require('fs');
    g.runMutationGate({
      marker: { storyId: 'MUT-X', repoPath: ${JSON.stringify(d)}, storyPath: ${JSON.stringify(s)} },
      appendLog: (f, e) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(e) + '\\n'),
      log: () => {},
    });`;
  const r = spawnSync(process.execPath, ['-e', programa], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Chequeo de mutantes: 7 mutantes en dotnet; puede tardar hasta 8 min/, 'el portón deja pasar la línea del chequeo');
  assert.ok(fs.existsSync(marca), 'la base corrió después del aviso');
  const entrada = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  assert.equal(entrada.runner, 'dotnet');
  // el JSON del chequeo trae runner, mutants y budgetMs
  const cli = spawnSync(process.execPath, [path.join(SCRIPTS, 'mutation-check.js'), '--repo', d, '--story', s, '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const j = JSON.parse(cli.stdout);
  assert.equal(j.runner, 'dotnet');
  assert.equal(j.mutants, 7);
  assert.equal(j.budgetMs, 480000);
});

test('@story-8.204 @ac-20 T24 Corte_MidioXDeN', async () => {
  const d = repoConMutantes(12);
  let reloj = 0;
  const r = await checker.runMutationCheck({
    repo: d, storyPath: story(d, ['calc.js', 'calc.test.js']), stack: {}, log: () => {}, now: () => reloj,
    runTests: ({ mutant }) => { reloj += mutant ? 40000 : 10000; return { code: mutant ? 1 : 0 }; },
  });
  assert.equal(r.result.mutants, 12);
  assert.equal(r.result.total, 5, 'base 10 s + 4 mutantes de 40 s = 170 s; el quinto arranca antes de los 180');
  assert.equal(r.result.killed, 5);
  const lineas = [];
  gate.runMutationGate({
    marker: { storyId: 'X', repoPath: d, storyPath: 's.md' }, appendLog: () => {}, log: (l) => lineas.push(l),
    invokeCheck: () => ({ code: 0, result: { total: 4, killed: 4, survived: [], skipped: [], verdict: 'OK', runner: 'jest', mutants: 12 } }),
  });
  assert.ok(lineas.some((l) => /midió 4 de 12/.test(l)), lineas.join('\n'));
  const cero = [];
  const g0 = gate.runMutationGate({
    marker: { storyId: 'X', repoPath: d, storyPath: 's.md' }, appendLog: () => {}, log: (l) => cero.push(l),
    invokeCheck: () => ({ code: 0, result: { total: 0, killed: 0, survived: [], skipped: [], verdict: 'DEADLINE_SIN_CORRER', runner: 'dotnet', mutants: 12 } }),
  });
  assert.equal(g0.block, false);
  assert.ok(cero.some((l) => /midió 0 de 12/.test(l)), cero.join('\n'));
});

test('@story-8.204 @ac-21 T25 GatesLog_TraeLaReceta', () => {
  for (const runner of ['jest', 'vitest', 'dotnet', 'pytest', 'node-test']) {
    const entradas = [];
    gate.runMutationGate({
      marker: { storyId: 'X', repoPath: '/r', storyPath: 's.md' }, appendLog: (_f, e) => entradas.push(e), log: () => {},
      invokeCheck: () => ({ code: 0, result: { total: 1, killed: 1, survived: [], skipped: [], verdict: 'OK', runner, mutants: 1 } }),
    });
    assert.equal(entradas[0].runner, runner);
  }
  const entradas = [];
  gate.runMutationGate({
    marker: { storyId: 'X', repoPath: '/r', storyPath: 's.md' }, appendLog: (_f, e) => entradas.push(e), log: () => {},
    invokeCheck: () => ({ code: null, result: null, stderr: '', timedOut: true }),
  });
  assert.equal(entradas[0].runner, 'desconocido');
});

test('@story-8.204 @ac-22 T26 PeriodoDeAviso_AntesAvisaDespuesFrena', () => {
  assert.match(gate.MUTATION_NOTICE_UNTIL, /^\d{4}-\d{2}-\d{2}$/);
  const hasta = new Date(`${gate.MUTATION_NOTICE_UNTIL}T12:00:00Z`);
  const antes = new Date(hasta.getTime() - 86400000);
  const despues = new Date(hasta.getTime() + 86400000);
  const correr = (runner, today) => {
    const lineas = [];
    const g = gate.runMutationGate({
      marker: { storyId: 'X', repoPath: '/r', storyPath: 's.md' }, appendLog: () => {}, log: (l) => lineas.push(l), today,
      invokeCheck: () => ({ code: 1, result: { total: 3, killed: 0, survived: [{ file: 'a', line: 1, operator: 'x', before: 'a', after: 'b' }], skipped: [], verdict: 'TESTS_NO_EJERCEN_EL_CODIGO', runner, mutants: 3 } }),
    });
    return { g, texto: lineas.join('\n') };
  };
  const a = correr('vitest', antes);
  assert.equal(a.g.block, false);
  assert.ok(a.texto.includes(`entra frenando el ${gate.MUTATION_NOTICE_UNTIL}`), a.texto);
  assert.equal(correr('vitest', despues).g.block, true);
  assert.equal(correr('node-test', antes).g.block, true, 'node --test frena como hoy');
});

// ── Guías y no-regresión ─────────────────────────────────────────────────────

test('@story-8.204 @ac-24 @ac-25 T27 NoRegresion_NodeTestIgual', async () => {
  // La fixture de siempre (calc.js con esPar cubierta y nuncaTesteada sin cubrir), con el corredor real.
  const FIX = path.join(__dirname, 'fixtures', 'mutation');
  const d = repo({ 'calc.js': "'use strict';\n", 'calc.test.js': "'use strict';\n" }, {
    'calc.js': fs.readFileSync(path.join(FIX, 'calc.js'), 'utf8'), 'calc.test.js': fs.readFileSync(path.join(FIX, 'calc.test.js'), 'utf8'),
  });
  fs.copyFileSync(path.join(FIX, 'story-con-tests.md'), path.join(d, 'story.md'));
  const r = await checker.runMutationCheck({ repo: d, storyPath: path.join(d, 'story.md'), stack: {}, log: () => {} });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result.runner, 'node-test');
  assert.equal(r.result.total, 5);
  assert.equal(r.result.killed, 1);
  assert.deepEqual(r.result.survived.map((m) => `${m.line}:${m.operator}`), ['10:gte-a-gt', '10:negar-if', '11:return-true-a-false', '13:return-false-a-true']);
  assert.equal(r.result.verdict, 'AVISO_SOBREVIVIENTES');
});

test('@story-8.204 @ac-23 T28 Guias_DicenRecetasScopedYTopes', () => {
  // la guía de piezas no tiene lugar (su tope de tamaño): la pieza se explica en la guía de disciplina de pruebas
  const disciplina = fs.readFileSync(path.join(ROOT, 'guides', 'test-execution-discipline.md'), 'utf8');
  const i = disciplina.search(/^## El chequeo de mutantes/m);
  assert.ok(i >= 0, 'test-execution-discipline.md: falta la sección «El chequeo de mutantes»');
  const seccion = disciplina.slice(i, disciplina.indexOf('\n## ', i + 1));
  for (const t of ['scoped', 'Jest', 'Vitest', '.NET', 'pytest', '8 min', '3 min', '{files}', '{classes}']) {
    assert.ok(seccion.includes(t), `la sección del chequeo de mutantes no dice «${t}»`);
  }
  assert.match(seccion, /nunca la suite/i);
});

// ── La base con cero pruebas ─────────────────────────────────────────────────

test('@story-8.204 @ac-26 T29 Base_CeroPruebasOResultadoIlegible_Estructural', async () => {
  assert.equal(checker.countTests('trx', '<TestRun><ResultSummary><Counters total="0" executed="0" passed="0" /></ResultSummary></TestRun>'), 0);
  assert.equal(checker.countTests('trx', '<Counters total="3" executed="3" />'), 3);
  assert.equal(checker.countTests('jest-json', '{"numTotalTests":0,"success":true}'), 0);
  assert.equal(checker.countTests('junit', '<testsuites tests="4"><testsuite tests="4"/></testsuites>'), 4);
  assert.equal(checker.countTests('jest-json', 'no es json'), null);
  // pytest anota un import roto como `errors`: esas no corrieron
  assert.equal(checker.countTests('junit', '<testsuites tests="1" errors="1"><testsuite tests="1" errors="1"/></testsuites>'), 0);
  assert.equal(checker.countTests('junit', '<testsuite name="pytest" errors="1" failures="0" tests="5">'), 4);
  // `**` en la ruta del resultado baja a cualquier profundidad, como en las recetas del portón
  const rd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-res-')));
  escribir(rd, { 'a/b/j.xml': '<testsuites tests="3"></testsuites>' });
  assert.deepEqual(checker.buscarArchivos(rd, `${rd}/**/j.xml`), [path.join(rd, 'a', 'b', 'j.xml')]);
  // un mutante que no llegó a correr pruebas (no compila: dotnet sale 1 sin dejar resultado) no cuenta como cazado
  const nc = repo({ 'T/T.csproj': CSPROJ_TEST, 'T/ATests.cs': '' }, { 'A.cs': 'class A { bool f(int a) { return a == 1; } }\n' });
  const rnc = await checker.runMutationCheck({
    repo: nc, storyPath: story(nc, ['A.cs', 'T/ATests.cs']), stack: {}, recipeOpts: { which: siempre }, log: () => {},
    runTests: ({ mutant }) => (mutant ? { code: 1, tests: null } : { code: 0, tests: 2 }),
  });
  assert.equal(rnc.result.killed, 0);
  assert.ok(rnc.result.skipped.some((s) => /no llegó a correr pruebas/.test(s.reason)), JSON.stringify(rnc.result.skipped));
  assert.equal(rnc.result.verdict, 'SIN_MEDIR', 'mutantes generados y ninguno medido no es «sin mutantes»');
  // en verde pero con el resultado ilegible, el mutante no se mide: no es un sobreviviente
  const il = repo({ 'T/T.csproj': CSPROJ_TEST, 'T/ATests.cs': '' }, { 'A.cs': 'class A { bool f(int a) { return a == 1; } }\n' });
  const ril = await checker.runMutationCheck({
    repo: il, storyPath: story(il, ['A.cs', 'T/ATests.cs']), stack: {}, recipeOpts: { which: siempre }, log: () => {},
    runTests: ({ mutant }) => (mutant ? { code: 0, tests: null } : { code: 0, tests: 2 }),
  });
  assert.equal(ril.result.survived.length, 0);
  assert.ok(ril.result.skipped.some((s) => /no dice qué pruebas corrieron/.test(s.reason)), JSON.stringify(ril.result.skipped));
  // el portón no lo anota como verde
  const sm = [];
  const gsm = gate.runMutationGate({
    marker: { storyId: 'X', repoPath: il, storyPath: 's.md' }, appendLog: (_f, e) => sm.push(e), log: () => {},
    invokeCheck: () => ({ code: 0, result: { ...ril.result, runner: 'dotnet' } }),
  });
  assert.equal(gsm.block, false);
  assert.equal(sm[0].status, 'warn-unmeasured');
  const casos = [
    [{ code: 0, tests: 0 }, /el filtro no coincidió con ninguna prueba/],
    [{ code: 0, tests: null }, /no pude leer el resultado de la base/],
  ];
  for (const [base, re] of casos) {
    const d = repo({ 'T/T.csproj': CSPROJ_TEST, 'T/ATests.cs': '' }, { 'A.cs': 'class A { bool f(int a) { return a == 1; } }\n' });
    let mutantes = 0;
    const r = await checker.runMutationCheck({
      repo: d, storyPath: story(d, ['A.cs', 'T/ATests.cs']), stack: {}, recipeOpts: { which: siempre }, log: () => {},
      runTests: ({ mutant }) => { if (mutant) mutantes += 1; return base; },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.result.motivo, re);
    assert.equal(mutantes, 0, 'ningún mutante corrido');
  }
});
