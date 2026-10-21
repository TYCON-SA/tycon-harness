'use strict';

/**
 * windows-portable.test.js — los guiones que MIDEN la «base portable» del arnés en un agente Windows: el escenario
 * `portable` de `pipelines/azure-pipelines-windows.yml`.
 *
 * Como `windows-probe.test.js` y `windows-rehearsal.test.js`, lo que se mide acá NO es Windows: es que los guiones
 * (`scripts/tests/windows/portable-probe.js` y `portable-report.js`) y el pipeline que los corre hagan lo que dicen. Lo
 * que no se puede perder:
 *   P1 · el pipeline suma el escenario `portable` sin cambiar los otros: corre en los trabajos `Sources` y `Rehearsal`,
 *        cada parte es un paso de `rehearse.js`, las suites van antes que el banco, no nombra ningún secreto, no copia
 *        archivos (clona) y `all` no lo incluye.
 *   P2 · los guiones de bash con `\r` se cuentan archivo por archivo, hooks de git incluidos, sin pasarle un patrón a
 *        git (la primera medición contó «0 de 1»); un clon que no está es «no pude contar», no «cero».
 *   P3 · los totales de una suite se leen de su salida en las dos formas en que Node los escribe, y una salida sin
 *        totales no es «pasó».
 *   P4 · de un reporte del banco sale UN veredicto por caso —verde, rojo, no medido o salteado con constancia—, los
 *        rojos por su nombre, y los casos de la lista que el reporte no trae; los portones por ruta, forma por forma
 *        (`forma-barras` no se confunde con `forma-barras-invertidas`).
 *   P5 · el «En corto»: una fila por pregunta, esperado contra medido; el veredicto es rojo sólo si no se pudo medir
 *        (un paso que falta o en error): lo que la medición encuentra no pone roja la corrida.
 *   P6 · nunca fuera de un laboratorio: sin la marca nadie mide ni escribe.
 *   P7 · los bundles traen el «antes» (`base`): el antepasado común de lo que se mide con la rama principal; si lo que
 *        se mide ES la rama principal, el viernes, y queda dicho.
 *   Y un recorrido entero en modo de laboratorio sobre dos repos de juguete, con `core.autocrlf=true` forzado: el clon
 *   nuevo llega sin `\r`; el que ya existía los conserva después del pull y de los dos caminos que parecen arreglarlo, y
 *   los pierde con el paso que normaliza; el banco de juguete deja su veredicto por caso; y cada comando, su salida.
 *
 * Sin dependencias y sin el arnés real: los repos de juguete traen su propio banco y sus propias suites. Nunca toca la
 * carpeta de usuario de quien la corre. No abre ninguna sesión del asistente.
 *
 * Correr: node --test scripts/tests/windows-portable.test.js
 * Para leer el reporte que deja el recorrido de juguete: TYCON_WINDOWS_PORTABLE_KEEP=<carpeta> node --test …
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'tests', 'windows');
const FIXTURES = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'windows');
const PIPELINE = path.join(ROOT, 'pipelines', 'azure-pipelines-windows.yml');
const L = require(path.join(DIR, 'lab.js'));
const T = require(path.join(DIR, 'team-lab.js'));
const rehearse = require(path.join(DIR, 'rehearse.js'));
const sources = require(path.join(DIR, 'build-sources.js'));
const probe = require(path.join(DIR, 'portable-probe.js'));
const P = require(path.join(DIR, 'portable-report.js'));

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const node = (args, opts = {}) => spawnSync(process.execPath, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts));
const tmp = (name) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `windows-portable-${name}-`));
const has = (bin) => L.scanPath(bin).length > 0;
const git = (args, cwd) => spawnSync('git', ['-c', 'user.name=lab', '-c', 'user.email=lab@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
const write = (root, files) => { for (const [rel, text] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); } };
const listing = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p)); if (e.isDirectory()) walk(p); } }; if (fs.existsSync(dir)) walk(dir); return out.sort(); };

// ═══ P1 · el pipeline ══════════════════════════════════════════════════════════════════════════════════════════

test('PortablePipeline_Yaml_OwnScenario_StepsThroughRehearse_NoSecrets', { skip: !fs.existsSync(PIPELINE) && 'NO MEDIDO — este árbol no trae pipelines/azure-pipelines-windows.yml (vive en el repo del equipo)' }, () => {
  const yml = fs.readFileSync(PIPELINE, 'utf8');
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const params = code.slice(code.indexOf('parameters:'), code.indexOf('jobs:'));
  const scenario = /- name: scenario\n\s+displayName: .*\n\s+type: string\n\s+default: (\w+)\n\s+values:\n((?:\s+- \w+\n)+)/.exec(params);
  assert.ok(scenario, 'el parámetro scenario, con su lista cerrada de valores');
  assert.strictEqual(scenario[1], 'measure', 'sin decir nada sigue corriendo measure');
  assert.ok(scenario[2].split(/\s*-\s*/).map((s) => s.trim()).includes('portable'), 'portable es un valor del parámetro');
  const jobs = [...code.matchAll(/^ {2}- job: (\w+)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(jobs, ['Bundle', 'Windows', 'Sources', 'Rehearsal'], 'no suma trabajos: usa los dos de los ensayos');
  const job = (name) => code.slice(code.indexOf(`- job: ${name}`), jobs[jobs.indexOf(name) + 1] ? code.indexOf(`- job: ${jobs[jobs.indexOf(name) + 1]}`) : undefined);
  // corre en los dos trabajos de los ensayos, y NO en los de measure
  for (const name of ['Sources', 'Rehearsal']) assert.match(job(name), /condition: .*in\('\$\{\{ parameters\.scenario \}\}', [^)]*'portable'[^)]*\)/, `${name} corre con portable`);
  for (const name of ['Bundle', 'Windows']) assert.doesNotMatch(job(name), /'portable'/, `${name} (la copia pública) no corre con portable`);
  const reh = job('Rehearsal');
  // sus pasos: sólo con scenario=portable, cada uno por rehearse.js, en el orden del guion
  const from = reh.indexOf("- ${{ if eq(parameters.scenario, 'portable') }}:");
  assert.ok(from > 0, 'los pasos de portable van bajo su condición: `all` no los corre');
  const block = reh.slice(from, reh.indexOf('rehearse.js finish'));
  const steps = [...block.matchAll(/rehearse\.js step ([\w-]+) --lab "\$\(lab\)" --out "\$\(report\)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(steps, rehearse.SCENARIOS.portable.filter((s) => s !== 'inventory'), 'cada parte de portable es un paso del pipeline, y al revés');
  assert.deepStrictEqual(rehearse.SCENARIOS.portable, ['inventory', 'fresh-clone', 'existing-clone', 'git-bash', 'suites', 'bench', 'path-shapes']);
  assert.ok(steps.indexOf('suites') < steps.indexOf('bench'), 'las suites van antes que el banco: con bench-portable en rojo el banco no es de fiar');
  assert.deepStrictEqual(steps, probe.PARTS, 'las partes del guion son las del pipeline');
  for (const s of rehearse.SCENARIOS.portable.slice(1)) assert.ok(!rehearse.SCENARIOS.all.includes(s), `all no corre ${s}`);
  assert.match(reh, /rehearse\.js step inventory /, 'el inventario corre siempre');
  assert.ok(reh.indexOf('artifact: windows-rehearsal') < reh.indexOf('rehearse.js verdict'), 'el reporte se publica ANTES del veredicto');
  // clona, no copia; sin secretos; sin sesiones del asistente
  for (const copy of ['CopyFiles@', 'Copy-Item', 'robocopy', 'xcopy', 'ExtractFiles@']) assert.ok(!reh.includes(copy), `el trabajo no copia archivos (${copy}): clona`);
  assert.doesNotMatch(reh, /AccessToken|windowsSessionCredential|\$\(\w*(Token|Secret|Password|Credential)\w*\)/i, 'el trabajo de Windows no recibe ninguna credencial');
  assert.doesNotMatch(code, /continueOnError/);
  const src = fs.readFileSync(path.join(DIR, 'portable-probe.js'), 'utf8');
  for (const opener of ['live-fire', 'advisor-runner']) assert.doesNotMatch(src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n'), new RegExp(`['"\`/]${opener}\\.js`), `el guion no lanza ${opener}.js (abre sesiones del asistente)`);
  assert.match(src, /'clone', state\.remotes\[key\]\.dir, dir\]/, 'los dos repos se CLONAN de los remotos del laboratorio');
  assert.doesNotMatch(src, /cpSync|copyFileSync/, 'el guion no copia archivos');
  // cada parte tiene su tope, y el guion que la corre es el de portable
  for (const part of probe.PARTS) {
    assert.ok(rehearse.OWN_STEPS[part].cap >= 900, `${part} tiene su tope`);
    assert.strictEqual(path.basename(rehearse.OWN_STEPS[part].script), 'portable-probe.js');
    assert.deepStrictEqual(rehearse.OWN_STEPS[part].args, ['--part', part]);
  }
});

// ═══ P2 · contar los guiones de bash con \r ════════════════════════════════════════════════════════════════════

test('Portable_ScriptsWithCr_CountsEveryFile_HooksIncluded', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('p2');
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo); git(['init', '-q'], repo);
    write(repo, {
      'a.sh': '#!/bin/sh\necho a\n',
      'dir/b con espacio.sh': '#!/bin/sh\r\nif true; then\r\n  echo b\r\nfi\r\n',
      '.githooks/pre-commit': '#!/bin/sh\r\nexit 0\r\n',
      '.githooks/commit-msg': '#!/bin/sh\nexit 0\n',
      'c.ps1': 'Write-Host c\r\n', 'docs/e.txt': 'x\r\n', 'not-versioned.sh': 'x\r\n',
    });
    git(['add', '--', 'a.sh', 'dir', '.githooks', 'c.ps1', 'docs'], repo); assert.strictEqual(git(['commit', '-q', '-m', 'x'], repo).status, 0);
    const counted = probe.scriptsWithCr(repo, process.env);
    assert.deepStrictEqual([counted.total, counted.with_cr, counted.first, counted.unreadable], [4, 2, ['.githooks/pre-commit', 'dir/b con espacio.sh'], 0], JSON.stringify(counted));
    // un versionado que no está en el árbol no es «sin \r»: se cuenta aparte
    fs.rmSync(path.join(repo, 'a.sh'));
    assert.deepStrictEqual([probe.scriptsWithCr(repo, process.env).total, probe.scriptsWithCr(repo, process.env).unreadable], [4, 1]);
    assert.match(probe.scriptsWithCr(path.join(base, 'no-such-repo'), process.env).problem, /git ls-files/, 'un clon que no está es «no pude contar», no «cero»');
    assert.deepStrictEqual(['x.sh', '.githooks/pre-commit', 'a/.githooks/x', 'x.sh.txt', 'x.ps1'].map(probe.isBashScript), [true, true, false, false, false]);
    // el paso que normaliza y los caminos que no: los que dice el informe, tal cual
    assert.deepStrictEqual(probe.NORMALIZE.map((a) => a.join(' ')), ['rm --cached -r -q .', 'reset --hard -q']);
    assert.deepStrictEqual(probe.PLAIN_RESTORE.map((a) => a.join(' ')), ['checkout -- .', 'reset --hard -q']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ P3 · leer los totales de una suite ════════════════════════════════════════════════════════════════════════

test('Portable_ParseTap_BothForms_NoTotalsIsNotAPass', () => {
  const tap = 'TAP version 13\n# Subtest: T15a\nok 1 - T15a\nnot ok 2 - T15b Eol_NoCrlfTracked — el repo real\n  ---\n  ...\n1..6\n# tests 6\n# suites 0\n# pass 5\n# fail 1\n# cancelled 0\n# skipped 0\n';
  assert.deepStrictEqual(P.parseTap(tap), { tests: 6, pass: 5, fail: 1, skipped: 0, first_failure: 'T15b Eol_NoCrlfTracked — el repo real' });
  const spec = '✔ T18a (1.2ms)\n✖ T18b GitBash_Find_Git (3.4ms)\nℹ tests 7\nℹ pass 6\nℹ fail 1\nℹ skipped 0\n';
  assert.deepStrictEqual(P.parseTap(spec), { tests: 7, pass: 6, fail: 1, skipped: 0, first_failure: 'T18b GitBash_Find_Git' });
  assert.deepStrictEqual(P.parseTap('Error: Cannot find module x'), { tests: null, pass: null, fail: null, skipped: null, first_failure: null });
  const t = (o) => Object.assign({ exit: 0, error: null, pass: 6, fail: 0 }, o);
  assert.strictEqual(P.testPassed(t({})), true);
  for (const bad of [t({ exit: 1 }), t({ fail: 1 }), t({ pass: null, fail: null }), t({ pass: 0 }), t({ error: 'ETIMEDOUT', exit: null }), null]) assert.strictEqual(P.testPassed(bad), false, JSON.stringify(bad));
});

// ═══ P4 · el reporte del banco ═════════════════════════════════════════════════════════════════════════════════

const TOY_BENCH = {
  ts: '2026-10-04T12:00:00.000Z', tool: 'claude', ran: 6, failed: 2, skipped: 3, nomedido: 1, parityBreaks: 0, baselineRegressions: 0,
  results: {
    'a.js::frena': { type: 'must-block', tools: { claude: { pass: true, failures: [], exit: 2 } } },
    'a.js::pasa': { type: 'must-not-block', tools: { claude: { pass: true, failures: [], exit: 0 } } },
    'b.sh::frena': { type: 'must-block', tools: { claude: { pass: false, failures: ['NO bloqueó (exit=127, sin decision:block)', 'otra'], exit: 127 } } },
    'b.sh::pasa': { type: 'must-not-block', tools: { claude: { pass: false, failures: ['ERROR: Command failed: lsof'], exit: null } } },
    'c.js::lento': { type: 'must-run', tools: { claude: { pass: false, nomedido: true, failures: ['NO MEDIDO: se agotaron los 20 s dos veces'], exit: null } } },
    'c.js::rapido': { type: 'must-run', tools: { claude: { pass: true, failures: [], exit: 0 } } },
    'd.js::solo-mac': { type: 'must-run', tools: { claude: { skipped: true, so: 'win32' } } },
    'e.js::freno': { type: 'must-block', tools: { claude: { skipped: true, motivo: 'el freno de producción está instalado en esta máquina' } } },
    'f.js::codex': { type: 'must-block', asymmetry: 'sólo codex', tools: { claude: { skipped: true } } },
  },
};

test('Portable_BenchSummary_OneVerdictPerCase_RedsByName_MissingCases', () => {
  const listed = [...Object.keys(TOY_BENCH.results), 'g.js::desaparecido'];
  const s = P.benchSummary(TOY_BENCH, { listed });
  assert.strictEqual(s.readable, true);
  assert.deepStrictEqual(s.totals, { cases: 9, ran: 6, green: 3, red: 2, not_measured: 1, skipped: 3 });
  assert.deepStrictEqual(s.verdicts, { 'a.js::frena': 'green', 'a.js::pasa': 'green', 'b.sh::frena': 'red', 'b.sh::pasa': 'red', 'c.js::lento': 'not-measured', 'c.js::rapido': 'green', 'd.js::solo-mac': 'skipped', 'e.js::freno': 'skipped', 'f.js::codex': 'skipped' });
  assert.deepStrictEqual(s.red.map((r) => [r.key, r.script, r.type, r.failures[0]]), [['b.sh::frena', 'b.sh', 'must-block', 'NO bloqueó (exit=127, sin decision:block)'], ['b.sh::pasa', 'b.sh', 'must-not-block', 'ERROR: Command failed: lsof']]);
  assert.deepStrictEqual(s.red_by_script, [{ script: 'b.sh', count: 2 }]);
  assert.deepStrictEqual(s.not_measured, [{ key: 'c.js::lento', why: 'NO MEDIDO: se agotaron los 20 s dos veces' }], 'un caso sin medir no es verde ni rojo');
  assert.deepStrictEqual(s.skipped_by, { 'other-system': 1, 'production-brake-installed': 1, 'other-tool': 1 });
  assert.deepStrictEqual(s.missing, ['g.js::desaparecido'], 'un caso de la lista que el reporte no trae');
  // lo que cuenta el propio banco coincide con lo contado caso por caso
  assert.deepStrictEqual([s.reported.ran, s.reported.failed, s.reported.skipped, s.reported.not_measured], [s.totals.ran, s.totals.red, s.totals.skipped, s.totals.not_measured]);
  // un reporte que no se puede leer no da ningún número
  for (const bad of [null, {}, { results: null }, 'x']) assert.deepStrictEqual([P.benchSummary(bad).readable, P.benchSummary(bad).totals.ran], [false, 0]);
  // un caso sin resultado para la herramienta no es verde
  const hole = clone(TOY_BENCH); hole.results['a.js::frena'].tools = {};
  assert.strictEqual(P.benchSummary(hole).verdicts['a.js::frena'], 'not-measured');
  // la lista del banco: una clave por línea, y nada más
  const list = 'a.js::frena [must-block] tools=claude,codex  — a.js (un freno)\nb.sh::pasa [must-not-block] tools=claude  — b.sh\n\n⏭ otra línea\n';
  assert.deepStrictEqual(P.parseBenchList(list), ['a.js::frena', 'b.sh::pasa']);
});

test('Portable_ShapesSummary_EachShapeApart', () => {
  const ok = { claude: { pass: true, failures: [], exit: 0 } };
  const bad = { claude: { pass: false, failures: ['NO bloqueó (exit=0, sin decision:block)'], exit: 0 } };
  const skip = { claude: { skipped: true, so: 'win32' } };
  const doc = { results: {
    'hook-pre-edit.js::story-gate-frena-forma-nativa': { type: 'must-block', tools: skip },
    'hook-pre-edit.js::story-gate-frena-forma-barras-invertidas': { type: 'must-block', tools: ok },
    'hook-pre-edit.js::story-gate-frena-forma-barras': { type: 'must-block', tools: ok },
    'hook-pre-edit.js::story-gate-frena-forma-git-bash': { type: 'must-block', tools: bad },
    'hook-pre-edit.js::story-gate-pasa-forma-git-bash': { type: 'must-not-block', tools: ok },
    'otro.js::la-forma-de-siempre': { type: 'must-run', tools: ok },
  } };
  assert.deepStrictEqual(['x::a-forma-barras', 'x::a-forma-barras-invertidas', 'x::a-forma-git-bash', 'x::a-forma-nativa', 'x::forma-barras-y-algo', 'x::otro'].map(P.shapeOf), ['slash', 'backslash', 'git-bash', 'native', null, null]);
  const s = P.shapesSummary(doc);
  const row = (x) => [x.cases, x.green, x.red, x.not_measured, x.skipped];
  assert.deepStrictEqual([row(s.shapes.backslash), row(s.shapes.slash), row(s.shapes['git-bash']), row(s.shapes.native), row(s.other)], [[1, 1, 0, 0, 0], [1, 1, 0, 0, 0], [2, 1, 1, 0, 0], [1, 0, 0, 0, 1], [1, 1, 0, 0, 0]]);
  assert.deepStrictEqual(s.shapes['git-bash'].red_cases, [{ key: 'hook-pre-edit.js::story-gate-frena-forma-git-bash', failures: ['NO bloqueó (exit=0, sin decision:block)'] }]);
  assert.deepStrictEqual(P.WINDOWS_SHAPES.map((x) => x.looks), ['C:\\a\\b', 'C:/a/b', '/c/a/b'], 'las tres formas de Windows');
  assert.strictEqual(P.shapesSummary(null).readable, false);
});

// ═══ P5 · el «En corto» y el veredicto ═════════════════════════════════════════════════════════════════════════

test('Portable_ShortRows_ExpectedAgainstMeasured_VerdictRedOnlyWhenItCouldNotMeasure', () => {
  const report = fixture('portable-report.json');
  const rows = P.shortRows(report);
  // una fila (o más) por cada una de las seis preguntas, cada una con lo esperado y lo medido
  assert.deepStrictEqual([...new Set(rows.map((r) => r.question))], ['1', '2', '3', '4', '5', '6']);
  for (const r of rows) assert.ok(r.what && r.expected && r.measured && [true, false, null].includes(r.match), JSON.stringify(r));
  const find = (rx) => rows.find((r) => rx.test(r.what));
  assert.deepStrictEqual([find(/^Clon nuevo del arnés/).expected, find(/^Clon nuevo del arnés/).measured.split(' · ')[0], find(/^Clon nuevo del arnés/).match], ['0 de 241', '0 de 241', true]);
  assert.deepStrictEqual([find(/^Clon que ya existía del arnés/).measured.split(' · ')[0], find(/^Clon que ya existía del arnés/).match], ['241 de 241', true], 'antes de la tanda, todos con \\r: es lo esperado');
  assert.strictEqual(find(/^arnés: después del paso que normaliza/).match, true);
  assert.deepStrictEqual([find(/^agent-skills: después del paso que normaliza/).measured, find(/^agent-skills: después del paso que normaliza/).match], ['1 de 13 · git status: 2 línea(s)', false], 'un \\r que queda es un NO');
  assert.strictEqual(find(/antes de normalizar/).match, true, 'antes del paso, lo esperado es que la prueba esté ROJA');
  assert.strictEqual(find(/^`eol\.test\.js` después del paso que normaliza$/).match, false, 'y después del paso, que pase');
  assert.match(find(/findGitBash\(\)` en esta máquina/).measured, /^C:\\Program Files\\Git\\bin\\bash\.exe \(de: git\) · GNU bash, version 5/);
  assert.strictEqual(find(/El banco de controles entero/).match, true, 'tres rojos y la fila coincide: no se espera todo verde, se espera que todo caso tenga veredicto');
  assert.match(find(/El banco de controles entero/).measured, /^12 en la lista · 9 corridos · 6 verdes · 3 rojos · 0 no medidos · 3 salteados con constancia · faltan 0/);
  assert.deepStrictEqual(P.WINDOWS_SHAPES.map((s) => find(new RegExp(`forma \`${s.looks.replace(/[\\/]/g, '.')}\``)).match), [true, true, false]);
  assert.deepStrictEqual(rows.filter((r) => r.question === '6').map((r) => r.match), [true, true]);
  // lo que cambia una fila: un caso sin medir, un caso que falta, un «0 de 0», un bash de System32, una suite sin totales
  const change = (fn) => { const x = clone(report); fn(x); return P.shortRows(x); };
  const stepOf = (x, name) => x.steps.find((s) => s.name === name);
  const benchRow = (list) => list.find((r) => /El banco de controles entero/.test(r.what));
  assert.strictEqual(benchRow(change((x) => { stepOf(x, 'bench').facts.summary.totals.not_measured = 1; })).match, false, 'un caso sin medir no deja la fila en «sí»');
  assert.strictEqual(benchRow(change((x) => { stepOf(x, 'bench').facts.summary.missing = ['a.js::x']; })).match, false, 'un caso que falta, tampoco');
  assert.strictEqual(benchRow(change((x) => { stepOf(x, 'bench').facts.summary = { readable: false, problem: 'ilegible', totals: {}, missing: [] }; })).match, false);
  assert.strictEqual(change((x) => { stepOf(x, 'fresh-clone').facts.repos.harness.scripts = { total: 0, with_cr: 0, first: [] }; }).find((r) => /^Clon nuevo del arnés/.test(r.what)).match, null, 'un «0 de 0» no es un sí');
  assert.strictEqual(change((x) => { stepOf(x, 'git-bash').facts.found.path = 'C:\\Windows\\System32\\bash.exe'; }).find((r) => /en esta máquina/.test(r.what)).match, false, 'el lanzador de WSL nunca es un sí');
  assert.strictEqual(change((x) => { Object.assign(stepOf(x, 'suites').facts.tests['bench-portable'], { pass: null, fail: null }); }).find((r) => /bench-portable/.test(r.what)).match, false, 'una suite sin totales no pasó');
  assert.strictEqual(change((x) => { stepOf(x, 'suites').facts.tests['bench-portable'] = { file: 'x', not_run: 'el commit que se mide no trae x' }; }).find((r) => /bench-portable/.test(r.what)).match, null, 'una suite que el commit no trae no es un NO: no hay qué comparar');
  // fuera de Windows las tres formas se saltean: no hay nada que comparar, y no es un sí
  const lab = change((x) => { for (const id of ['backslash', 'slash', 'git-bash']) stepOf(x, 'path-shapes').facts.shapes.shapes[id] = { cases: 12, green: 0, red: 0, not_measured: 0, skipped: 12, red_cases: [] }; });
  assert.deepStrictEqual(lab.filter((r) => /Portones por ruta/.test(r.what)).map((r) => r.match), [null, null, null]);
  // sin core.autocrlf=true no llegan con \r: tampoco hay qué comparar
  assert.strictEqual(change((x) => { const r = stepOf(x, 'existing-clone').facts.repos.harness; r.autocrlf = null; r.stages['at-base'].scripts.with_cr = 0; }).find((r) => /^Clon que ya existía del arnés/.test(r.what)).match, null);
  // un paso que no corrió: su pregunta sigue en la tabla, y lo dice
  const short = change((x) => { x.steps = x.steps.filter((s) => s.name !== 'bench'); });
  assert.deepStrictEqual([short.find((r) => r.question === '4').measured, short.find((r) => r.question === '4').match], ['no corrió el paso bench', null]);

  // el veredicto: verde con hallazgos; rojo sólo si no se pudo medir
  const green = rehearse.verdict(report);
  assert.strictEqual(green.color, 'green', JSON.stringify(green));
  assert.ok(report.steps.reduce((n, s) => n + s.findings.length, 0) >= 8 && rows.some((r) => r.match === false), 'hay hallazgos y filas que no coinciden, y la ejecución es verde: se pudo medir');
  const missing = clone(report); missing.steps = missing.steps.filter((s) => s.name !== 'bench');
  assert.deepStrictEqual([rehearse.verdict(missing).color, rehearse.verdict(missing).missing_steps], ['red', ['bench']]);
  const failed = clone(report); Object.assign(failed.steps.find((s) => s.name === 'bench'), { status: 'error', reason: 'no pude medir: el banco salió 2 y no dejó un reporte legible' });
  assert.strictEqual(rehearse.verdict(failed).color, 'red');
  const skipped = clone(report); Object.assign(skipped.steps.find((s) => s.name === 'git-bash'), { status: 'not-measured', reason: 'el commit que se mide no trae scripts/lib/git-bash.js' });
  assert.deepStrictEqual([rehearse.verdict(skipped).color, rehearse.verdict(skipped).not_measured.length], ['green', 1], 'un paso no medido se dice y no pone roja la ejecución');

  // el resumen legible: el «En corto» arriba, y cada parte con sus comandos y su salida guardada
  const md = rehearse.renderMarkdown(Object.assign(clone(report), { verdict: green }));
  for (const title of ['# El arnés en Windows — la base portable', '## Veredicto: VERDE — se pudo medir', '## En corto', '## Los pasos', '## 1 · El clon nuevo', '## 2 · El clon que ya existía', '## 3 · El bash de Git', '## 6 · Las suites', '## 4 · El banco de controles entero', '## 5 · Los portones que deciden por ruta', '## Qué trae la máquina', '## No medido']) assert.ok(md.includes(title), `el resumen trae «${title}»`);
  assert.ok(md.indexOf('## En corto') < md.indexOf('## Los pasos'), 'el «En corto» va arriba');
  assert.match(md, /\| # \| Pregunta \| Esperado \| Medido \| ¿Coincide\? \|/);
  assert.match(md, /Coinciden \d+ · no coinciden \*\*3\*\* · sin nada que comparar \d+\./);
  assert.match(md, /- `safety-guard-pre\.sh::rm-rf-raiz` — NO bloqueó/, 'los rojos del banco, por su nombre');
  assert.match(md, /\| safety-guard-pre\.sh \| 2 \|/, 'y por guion');
  assert.match(md, /steps\/bench\/02-bench\.txt/, 'cada comando dice dónde quedó su salida');
  assert.match(md, /el disparo real \(`live-fire\.js`\).*abre una sesión del asistente/, 'lo que no se mide, con su motivo');
  assert.doesNotMatch(md, /El viernes/, 'no es el reporte de los ensayos');
  assert.match(rehearse.renderMarkdown(Object.assign(clone(failed), { verdict: rehearse.verdict(failed) })), /## Veredicto: ROJO — NO se pudo medir/);
  // el reporte de los ensayos sigue saliendo con su forma
  assert.match(rehearse.renderMarkdown(Object.assign(fixture('rehearsal-report.json'), { verdict: rehearse.verdict(fixture('rehearsal-report.json')) })), /## En corto — del viernes a hoy/);
});

// ═══ P6 · nunca fuera de un laboratorio ════════════════════════════════════════════════════════════════════════

// Sin la lista del banco, «faltan 0» no es un
// sí; y si el «antes» ya trae el .gitattributes (una rama que sale del main actual), lo esperado es ningún \r.
test('Portable_ShortRows_NoBenchListIsNotASi_BaseWithGitattributesExpectsNoCr', () => {
  const report = fixture('portable-report.json');
  const stepOf = (x, name) => x.steps.find((s) => s.name === name);
  const change = (fn) => { const x = clone(report); fn(x); return P.shortRows(x); };
  const benchRow = (list) => list.find((r) => /El banco de controles entero/.test(r.what));
  for (const listed of [null, 0]) assert.strictEqual(benchRow(change((x) => { stepOf(x, 'bench').facts.listed = listed; })).match, false, `lista ${listed}: no se sabe qué falta`);
  const baseRow = (list) => list.find((r) => /^Clon que ya existía del arnés/.test(r.what));
  const attrs = (withCr) => change((x) => { const r = stepOf(x, 'existing-clone').facts.repos.harness; r.gitattributes_at_base = true; r.stages['at-base'].scripts.with_cr = withCr; });
  assert.match(baseRow(attrs(0)).expected, /ninguno con \\r: el antes ya trae \.gitattributes/);
  assert.strictEqual(baseRow(attrs(0)).match, true, 'con .gitattributes en el antes, ninguno con \\r es lo esperado');
  assert.strictEqual(baseRow(attrs(241)).match, false, 'y todos con \\r ya no coincide');
});

// Con un arnés del repo unido, el banco leído contra el agent-skills de antes de la unión
// (congelado en el corte) daría rojos que no son del arnés. Con un arnés unido, las skills son las del propio clon.
test('Portable_UnifiedHarness_SkillsAreTheHarnessClone', () => {
  const base = tmp('unified');
  try {
    const pair = { harness: path.join(base, 'h'), skills: path.join(base, 's') };
    fs.mkdirSync(pair.harness); fs.mkdirSync(pair.skills);
    assert.strictEqual(probe.skillsFor(pair), pair.skills, 'un arnés de antes de la unión: su clon de agent-skills');
    for (const d of ['skills', 'agents', 'packs']) {
      fs.mkdirSync(path.join(pair.harness, d));
      assert.strictEqual(probe.skillsFor(pair), pair.harness, `con ${d}/ en la raíz: el propio clon`);
      fs.rmSync(path.join(pair.harness, d), { recursive: true });
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Portable_RefusesToRunOutsideALab_AndWritesNothing', () => {
  const base = tmp('p6');
  try {
    const out = path.join(base, 'out');
    const real = os.homedir();
    for (const [lab, why] of [[real, /carpeta de usuario real/], [path.join(base, 'not-a-lab'), /no tiene la marca del laboratorio/], [path.join(real, '.claude', 'windows-lab'), /dentro de la carpeta \.claude real/]]) {
      for (const step of probe.PARTS) {
        const r = node([path.join(DIR, 'rehearse.js'), 'step', step, '--lab', lab, '--out', out, '--allow-temp']);
        assert.strictEqual(r.status, 2, `${step} en ${lab}: salió ${r.status}`);
        assert.match(r.stderr, why);
        assert.ok(!fs.existsSync(out), 'no escribió ni la carpeta del reporte');
      }
    }
    const direct = node([path.join(DIR, 'portable-probe.js'), '--part', 'bench', '--lab', path.join(base, 'not-a-lab'), '--out', out]);
    assert.deepStrictEqual([direct.status, fs.existsSync(out)], [2, false]);
    assert.match(node([path.join(DIR, 'portable-probe.js'), '--part', 'everything', '--lab', base, '--out', out]).stderr, /parte desconocida/);
    // con la marca y sin los remotos: el paso lo dice como error, no inventa una medición
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    for (const part of probe.PARTS) assert.match(probe.measure({ part, lab, out: path.join(base, 'o2'), allowTemp: true, rec: L.recorder(part, path.join(base, 'o2')) }).reason, /no trae los remotos del laboratorio/);
    // con los remotos y sin el clon nuevo: las partes que corren sobre él lo dicen
    fs.writeFileSync(path.join(lab, T.STATE_FILE), JSON.stringify({ remotes: { harness: { dir: 'x', target: 'a', base: 'b' }, skills: { dir: 'y', target: 'c', base: 'd' } } }));
    for (const part of ['git-bash', 'suites', 'bench', 'path-shapes']) assert.match(probe.measure({ part, lab, out: path.join(base, 'o3'), allowTemp: true, rec: L.recorder(part, path.join(base, 'o3')) }).reason, /no está el clon nuevo del arnés.*fresh-clone/);
    // unos bundles sin la rama «base» (los de antes): el clon que ya existía lo dice
    fs.writeFileSync(path.join(lab, T.STATE_FILE), JSON.stringify({ remotes: { harness: { dir: 'x', target: 'a', base: null }, skills: { dir: 'y', target: 'c', base: null } } }));
    assert.match(probe.measure({ part: 'existing-clone', lab, out: path.join(base, 'o4'), allowTemp: true, rec: L.recorder('existing-clone', path.join(base, 'o4')) }).reason, /no traen la rama «base»/);
    // todo dentro del laboratorio
    const where = probe.places(lab);
    for (const p of [where.home, ...Object.values(where.fresh), ...Object.values(where.existing)]) assert.ok(L.isInside(p, lab), p);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ los dos repos de juguete: la rama principal sin la regla, y la rama del cambio con ella ══════════════════

const TOY_TAG = 'retorno/toy-friday';
const SCRIPT = '#!/usr/bin/env bash\necho hola\nexit 0\n';
// la suite de finales de línea de juguete: roja, nombrando el archivo y el paso, si un guion de bash tiene \r
const TOY_LINE_ENDINGS_TEST = `const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const withCr = (dir) => execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).split('\\n').filter((f) => /\\.sh$/.test(f) || /^\\.githooks\\//.test(f)).filter((f) => fs.readFileSync(path.join(dir, f)).includes(13));
test('T15b toy — el repo: ningún guion con \\\\r\\\\n', () => { assert.deepStrictEqual(withCr(path.resolve(__dirname, '..', '..')), [], 'con \\\\r\\\\n en el árbol de trabajo — el paso: git rm --cached -r -q . && git reset --hard -q'); });
test('T15c toy — agent-skills', () => { assert.deepStrictEqual(withCr(process.env.TYCON_SKILLS_DIR), []); });
`;
const passing = (names) => `const test = require('node:test');\n${names.map((n) => `test('${n}', () => {});`).join('\n')}\n`;
const TOY_FINDER = `const fs = require('fs'); const path = require('path');
const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
const found = dirs.map((d) => path.join(d, 'bash')).find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
if (process.argv.includes('--json')) console.log(JSON.stringify({ platform: process.platform, path: found, source: found ? 'path' : null, reason: found ? null : 'no hay bash en el PATH' })); else if (found) console.log(found);
process.exitCode = found ? 0 : 1;
`;
// el banco de juguete: la misma línea de comandos y el mismo reporte que el de verdad, con nueve casos de mentira.
// Uno escribe en la carpeta de usuario de quien lo corre: es el defecto que la medición tiene que ver.
const TOY_RUNNER = `const fs = require('fs'); const os = require('os'); const path = require('path');
const argv = process.argv.slice(2); const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const ok = { pass: true, failures: [], exit: 0 }; const red = (why) => ({ pass: false, failures: [why], exit: 1 });
const CASES = {
  'toy-brake.sh::frena': ['must-block', ok], 'toy-brake.sh::pasa': ['must-not-block', red('bloqueó y no debía · stderr: toy')],
  'toy-notice.js::avisa': ['must-emit', ok], 'toy-notice.js::lento': ['must-run', { pass: false, nomedido: true, failures: ['NO MEDIDO: se agotaron los 20 s dos veces'], exit: null }],
  'toy-notice.js::solo-mac': ['must-run', { skipped: true, so: process.platform }],
  'toy-gate.js::story-gate-frena-forma-barras-invertidas': ['must-block', ok], 'toy-gate.js::story-gate-frena-forma-barras': ['must-block', ok],
  'toy-gate.js::story-gate-frena-forma-git-bash': ['must-block', red('NO bloqueó (exit=0, sin decision:block)')],
  'toy-gate.js::story-gate-frena-forma-nativa': ['must-block', { skipped: true, so: process.platform }],
  'toy-path-notice.js::sin-HOME': ['must-emit', ok],
};
if (argv.includes('--list')) { for (const [k, [type]] of Object.entries(CASES)) console.log(k + ' [' + type + '] tools=claude,codex  — de juguete'); process.exit(0); }
if (!val('--only')) fs.writeFileSync(path.join(os.homedir(), 'toy-bench-leak.txt'), 'x\\n');
const results = {}; let ran = 0, failed = 0, skipped = 0, nomedido = 0;
for (const [k, [type, r]] of Object.entries(CASES)) {
  if (val('--only') && !k.includes(val('--only'))) continue;
  results[k] = { type, asymmetry: null, tools: { claude: r } };
  if (r.skipped) { skipped++; console.log('⏭ ' + k); continue; }
  ran++; if (r.nomedido) nomedido++; else if (!r.pass) failed++;
  console.log((r.nomedido ? '🟡' : (r.pass ? '✅' : '❌')) + ' [claude] ' + k);
}
fs.writeFileSync(val('--json'), JSON.stringify({ ts: new Date().toISOString(), tool: 'claude', ran, failed, skipped, nomedido, results }, null, 2) + '\\n');
console.log('\\n' + (failed ? '❌' : '✅') + ' ' + ran + ' corridos · ' + failed + ' rojos');
process.exitCode = failed ? 1 : 0;
`;
const TOY_BASE = {
  'README.md': '# Arnés de juguete\n',
  'scripts/hooks/safety-guard-pre.sh': SCRIPT, 'scripts/hooks/toy-untouched.sh': SCRIPT, 'scripts/hooks/toy-touched.sh': SCRIPT, '.githooks/pre-commit': SCRIPT,
};
// la rama del cambio: la regla, las piezas que el escenario corre, y un guion de bash tocado (ése llega con \n en el pull)
const TOY_TARGET = Object.assign({}, TOY_BASE, {
  '.gitattributes': '* text=auto eol=lf\n',
  'scripts/hooks/toy-touched.sh': `${SCRIPT}# tocado por la tanda\n`,
  'scripts/lib/git-bash.js': TOY_FINDER,
  'scripts/controls-bench/runner.js': TOY_RUNNER,
  'scripts/tests/eol.test.js': TOY_LINE_ENDINGS_TEST,
  'scripts/tests/git-bash.test.js': passing(['T18a', 'T18b']),
  'scripts/tests/bench-portable.test.js': passing(['T19a', 'T19b', 'T19c']),
  // una suite roja a propósito: un hallazgo del reporte, no un rojo de la corrida
  'scripts/tests/windows-support.test.js': "const test = require('node:test'); const assert = require('node:assert');\ntest('T23a', () => {});\ntest('T23b toy — rojo a propósito', () => { assert.strictEqual(1, 2); });\n",
});

/** Los dos repos de juguete: `main` (con su marca del viernes) sin la regla, y la rama `story/toy-portable` con ella. */
function toyRepos(base) {
  const harness = path.join(base, 'toy-harness'); const skills = path.join(base, 'toy-skills');
  for (const [dir, before, after] of [[harness, TOY_BASE, TOY_TARGET], [skills, { 'skills/toy/run.sh': SCRIPT, 'skills/toy/SKILL.md': '# de juguete\n' }, { 'skills/toy/run.sh': SCRIPT, 'skills/toy/SKILL.md': '# de juguete\n', '.gitattributes': '* text=auto eol=lf\n' }]]) {
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir);
    write(dir, before);
    git(['add', '-A'], dir);
    assert.strictEqual(git(['commit', '-q', '-m', 'la rama principal, sin la regla'], dir).status, 0, 'no pude armar el commit de la rama principal');
    git(['checkout', '-q', '-B', 'main'], dir);
    git(['tag', TOY_TAG], dir);
    git(['checkout', '-q', '-b', 'story/toy-portable'], dir);
    write(dir, after);
    git(['add', '-A'], dir);
    assert.strictEqual(git(['commit', '-q', '-m', 'la tanda'], dir).status, 0, 'no pude armar el commit de la tanda');
    git(['checkout', '-q', 'main'], dir);
  }
  return { harness, skills };
}

// ═══ P7 · los bundles traen el «antes» ═════════════════════════════════════════════════════════════════════════

test('Portable_BuildSources_BaseIsTheCommonAncestorWithTheMainBranch', { skip: !has('git') && 'NO MEDIDO — sin git' }, () => {
  const base = tmp('p7');
  try {
    const toy = toyRepos(base);
    const rev = (dir, ref) => git(['rev-parse', ref], dir).stdout.trim();
    // la rama principal avanza por su lado: el «antes» es el antepasado común, no la punta de la rama principal
    git(['commit', '-q', '--allow-empty', '-m', 'otra cosa entró a la rama principal'], toy.harness);
    const out = path.join(base, 'sources');
    const made = sources.build({ output: out, harness: toy.harness, skills: toy.skills, harnessRef: 'story/toy-portable', skillsRef: 'story/toy-portable', fridayTag: TOY_TAG });
    assert.ok(made.ok, made.reason);
    assert.deepStrictEqual([made.info.harness.target, made.info.harness.base, made.info.harness.commits_since_base, made.info.harness.base_is_ancestor], [rev(toy.harness, 'story/toy-portable'), rev(toy.harness, TOY_TAG), 1, true]);
    assert.notStrictEqual(made.info.harness.base, rev(toy.harness, 'main'), 'no es la punta de la rama principal');
    assert.match(made.info.harness.base_from, /^el antepasado común con main$/);
    assert.deepStrictEqual([made.info.skills.base, made.info.skills.commits_since_base], [rev(toy.skills, 'main'), 1]);
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ['agent-skills.bundle', 'harness.bundle', 'sources-info.json'], 'en la carpeta no queda nada más');
    // el remoto del laboratorio trae las tres ramas, y se apunta al antes y a lo que se mide
    const lab = path.join(base, 'lab');
    fs.mkdirSync(lab); fs.writeFileSync(path.join(lab, L.LAB_MARK), '{}\n');
    const remotes = T.makeRemotes({ lab, sources: out, env: process.env });
    assert.ok(remotes.ok, remotes.reason);
    assert.deepStrictEqual([remotes.state.remotes.harness.base, remotes.state.remotes.harness.target], [made.info.harness.base, made.info.harness.target]);
    assert.strictEqual(T.pointRemotes(remotes.state, 'base', process.env), null);
    assert.strictEqual(rev(remotes.state.remotes.harness.dir, 'refs/heads/main'), made.info.harness.base);
    assert.match(T.pointRemotes({ remotes: { x: { dir: 'd', target: 'a' } } }, 'base', process.env), /no trae el commit «base»/);
    // lo que se mide ES la rama principal: no hay un antes propio, queda el viernes, y lo dice
    const main = sources.build({ output: path.join(base, 's2'), harness: toy.harness, skills: toy.skills, fridayTag: TOY_TAG });
    assert.ok(main.ok, main.reason);
    assert.deepStrictEqual([main.info.skills.base, main.info.skills.commits_since_base], [rev(toy.skills, TOY_TAG), 0]);
    assert.match(main.info.skills.base_from, /^la marca del viernes \(lo que se ensaya ya está en la rama principal\)$/);
    assert.strictEqual(git(['status', '--porcelain'], toy.harness).stdout, '', 'build-sources.js no toca el repo que empaqueta');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ el recorrido entero, en modo de laboratorio ═══════════════════════════════════════════════════════════════

test('Portable_LabRun_ToyRepos_FreshClone_ExistingClone_Bench', { skip: (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows corre la medición de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, () => {
  const base = tmp('lab');
  try {
    const toy = toyRepos(base);
    const src = path.join(base, 'sources');
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.harness, '--skills', toy.skills, '--harness-ref', 'story/toy-portable', '--skills-ref', 'story/toy-portable', '--friday-tag', TOY_TAG]).status, 0);
    // como en una máquina con Git for Windows: core.autocrlf=true para todo git que lance la medición
    const env = Object.assign({}, process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true', TYCON_NO_NIGHTLY_EXAM: '0' });
    const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
    const realBefore = listing(path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness'));
    const r = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab, '--out', out, '--sources', src, '--scenario', 'portable', '--run-id', '999', '--harness-ref', 'origin/story/toy-portable', '--allow-temp'], { env, timeout: 600000 });
    const why = `${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
    if (process.env.TYCON_WINDOWS_PORTABLE_KEEP) fs.cpSync(out, process.env.TYCON_WINDOWS_PORTABLE_KEEP, { recursive: true });
    const step = (name) => report.steps.find((s) => s.name === name);
    assert.deepStrictEqual(report.steps.map((s) => s.name), rehearse.SCENARIOS.portable, why);
    assert.deepStrictEqual(report.steps.map((s) => s.status), Array(7).fill('measured'), `${JSON.stringify(report.steps.map((s) => s.reason))}\n${why}`);
    assert.deepStrictEqual([report.kind, report.run.id, report.run.scenario, report.run.lab_mode, report.run.commits.harness.since_base, report.run.commits.harness.base_from], ['windows-rehearsal', '999', 'portable', true, 1, 'el antepasado común con main']);
    // lo que encontró no pone roja la corrida: se pudo medir
    assert.deepStrictEqual([r.status, report.verdict.color], [0, 'green'], why);
    for (const s of report.steps) assert.strictEqual(s.capped_by, 'run-capped.js', `${s.name} corrió bajo su tope`);
    assert.deepStrictEqual(listing(path.join(os.homedir(), '.claude', '.tycon-pipeline', 'harness')), realBefore, 'la carpeta de usuario real quedó como estaba');

    // ── 1 · el clon nuevo: es un clon (su origen es el remoto del laboratorio), y con la regla no llega ningún \r
    const fresh = step('fresh-clone').facts;
    const origin = spawnSync('git', ['-C', fresh.repos.harness.dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(fs.realpathSync(origin), fs.realpathSync(path.join(lab, 'remotes', 'harness.git')), 'el clon nuevo es un clon del remoto del laboratorio');
    assert.ok(L.isInside(fresh.repos.harness.dir, lab) && L.isInside(fresh.repos.skills.dir, lab), 'todo dentro del laboratorio');
    assert.deepStrictEqual([fresh.repos.harness.autocrlf, fresh.repos.harness.gitattributes, fresh.repos.harness.head], ['true', true, report.run.commits.harness.today]);
    assert.deepStrictEqual([fresh.repos.harness.scripts.total, fresh.repos.harness.scripts.with_cr, fresh.repos.skills.scripts.total, fresh.repos.skills.scripts.with_cr], [4, 0, 1, 0], JSON.stringify(fresh.repos));
    assert.deepStrictEqual([fresh.tests['line-endings'].exit, fresh.tests['line-endings'].pass, fresh.tests['line-endings'].fail], [0, 2, 0]);
    assert.strictEqual(fresh.bash_reads.exit, 0);
    assert.deepStrictEqual(step('fresh-clone').findings, []);

    // ── 2 · el clon que ya existía
    const old = step('existing-clone').facts;
    const counts = (repo) => ['at-base', 'after-pull', 'after-plain-restore', 'after-normalize'].map((id) => `${old.repos[repo].stages[id].scripts.with_cr}/${old.repos[repo].stages[id].scripts.total}`);
    // antes: todos con \r. El pull deja con \n sólo el guion que tocó. Los dos caminos de siempre no cambian nada. El paso sí.
    assert.deepStrictEqual(counts('harness'), ['4/4', '3/4', '3/4', '0/4'], JSON.stringify(old.repos.harness.stages));
    assert.deepStrictEqual(counts('skills'), ['1/1', '1/1', '1/1', '0/1']);
    assert.ok(!old.repos.harness.stages['after-pull'].scripts.first.includes('scripts/hooks/toy-touched.sh'), 'el guion que el pull tocó llegó con \\n');
    assert.deepStrictEqual([old.repos.harness.gitattributes_at_base, old.repos.harness.gitattributes_after_pull, old.repos.harness.pull.exit, old.repos.harness.head_after_pull], [false, true, 0, report.run.commits.harness.today]);
    assert.deepStrictEqual([old.repos.harness.stages['after-pull'].status_lines, old.repos.harness.stages['after-normalize'].status_lines], [0, 0], 'git status limpio después del pull y después del paso');
    assert.deepStrictEqual(old.repos.harness.normalize.map((c) => c.exit), [0, 0]);
    assert.strictEqual(old.normalize_step, 'git rm --cached -r -q . && git reset --hard -q');
    assert.deepStrictEqual([old.tests['before-normalize'].exit, old.tests['before-normalize'].fail, old.tests['after-normalize'].exit, old.tests['after-normalize'].fail], [1, 2, 0, 0], 'la prueba está roja antes del paso y verde después');
    assert.deepStrictEqual([old.tests['before-normalize'].says, /T15b toy/.test(old.tests['before-normalize'].tail)], [{ names_the_step: true }, true], 'el rojo nombra el paso, y queda lo que dijo');
    assert.deepStrictEqual(step('existing-clone').findings, [], 'todo salió como dice el informe: ningún hallazgo');

    // ── 3 · el bash de Git
    const gb = step('git-bash').facts;
    assert.deepStrictEqual([gb.found.platform, gb.found.source, gb.found.exit, path.basename(gb.found.path)], [process.platform, 'path', 0, 'bash']);
    assert.match(gb.version, /bash/i);
    assert.deepStrictEqual([gb.variants, gb.not_measured.length, gb.tests['git-bash'].pass], [[], 1, 2], 'las variantes son de Windows: fuera de él quedan dichas como no medidas');

    // ── 6 · las suites: una roja a propósito es un hallazgo, no un rojo de la corrida
    const su = step('suites');
    assert.deepStrictEqual([su.facts.tests['bench-portable'].pass, su.facts.tests['bench-portable'].fail, su.facts.tests['windows-support'].exit, su.facts.tests['windows-support'].fail], [3, 0, 1, 1]);
    assert.deepStrictEqual(su.findings.map((f) => f.id), ['suites:windows-support-failed']);
    assert.match(su.facts.tests['windows-support'].first_failure, /T23b/);

    // ── 4 · el banco: un veredicto por caso, en el reporte y en su JSON
    const bench = step('bench');
    const sum = bench.facts.summary;
    assert.deepStrictEqual([bench.facts.listed, sum.totals, sum.missing, bench.facts.exit, bench.facts.sessions_opened], [10, { cases: 10, ran: 8, green: 5, red: 2, not_measured: 1, skipped: 2 }, [], 1, 0]);
    assert.deepStrictEqual(sum.red.map((x) => x.key), ['toy-brake.sh::pasa', 'toy-gate.js::story-gate-frena-forma-git-bash']);
    const verdicts = JSON.parse(fs.readFileSync(path.join(out, 'steps', 'bench', 'verdicts.json'), 'utf8'));
    assert.deepStrictEqual([Object.keys(verdicts.verdicts).length, verdicts.verdicts['toy-brake.sh::frena'], verdicts.verdicts['toy-brake.sh::pasa'], verdicts.verdicts['toy-notice.js::lento'], verdicts.verdicts['toy-notice.js::solo-mac']], [10, 'green', 'red', 'not-measured', 'skipped']);
    assert.ok(fs.existsSync(path.join(out, 'steps', 'bench', 'bench.json')), 'el reporte del banco, tal cual, queda guardado');
    // el banco de juguete escribe en la carpeta de usuario de quien lo corre: la medición lo ve (y es la del laboratorio)
    assert.deepStrictEqual(bench.facts.user_folder.appeared, ['toy-bench-leak.txt']);
    assert.ok(L.isInside(bench.facts.user_folder.home, lab) && !fs.existsSync(path.join(os.homedir(), 'toy-bench-leak.txt')), 'la carpeta de usuario del banco es la del laboratorio');
    const ids = bench.findings.map((f) => f.id);
    for (const id of ['bench:red:toy-brake.sh::pasa', 'bench:not-measured:toy-notice.js::lento', 'bench:user-folder-written']) assert.ok(ids.includes(id), `${id} en ${ids.join(', ')}`);
    assert.match(bench.facts.without_git.not_measured, /sólo en Windows/);

    // ── 5 · los portones por ruta
    const ps = step('path-shapes').facts;
    const shape = (id) => [ps.shapes.shapes[id].green, ps.shapes.shapes[id].red, ps.shapes.shapes[id].skipped];
    assert.deepStrictEqual([shape('backslash'), shape('slash'), shape('git-bash'), shape('native')], [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    assert.deepStrictEqual([ps.no_home.ran, ps.no_home.red], [1, 0]);
    assert.deepStrictEqual(step('path-shapes').findings.map((f) => f.id), ['path-shapes:red:toy-gate.js::story-gate-frena-forma-git-bash']);

    // cada comando: su código de salida real, su tope, y su salida entera en la carpeta de su paso
    for (const s of report.steps.filter((x) => x.name !== 'inventory')) {
      assert.ok(s.facts.commands.length >= 1, `${s.name} anotó sus comandos`);
      for (const c of s.facts.commands) {
        assert.ok(c.cap_s > 0 && typeof c.seconds === 'number' && (typeof c.exit === 'number' || c.error), `${s.name}/${c.id}: ${JSON.stringify(c)}`);
        assert.ok(c.saved.startsWith(`steps/${s.name}/`) && fs.existsSync(path.join(out, c.saved)), `${s.name}/${c.id}: su salida quedó en ${c.saved}`);
      }
    }
    assert.match(fs.readFileSync(path.join(out, step('bench').facts.commands.find((c) => c.id === 'bench').saved), 'utf8'), /✅ \[claude\] toy-brake\.sh::frena[\s\S]*8 corridos · 2 rojos/);
    assert.deepStrictEqual(step('bench').facts.commands.map((c) => [c.id, c.exit]), [['list', 0], ['bench', 1]], 'el código de salida real del banco: 1, con rojos');

    // el reporte: el «En corto» arriba, con lo que no coincide dicho; y el registro de la corrida también lo trae
    const md = fs.readFileSync(path.join(out, 'windows-report.md'), 'utf8');
    for (const title of ['# El arnés en Windows — la base portable', '## Veredicto: VERDE — se pudo medir', '## En corto', '## 2 · El clon que ya existía', '## 4 · El banco de controles entero', '## No medido']) assert.ok(md.includes(title), `el resumen trae «${title}»`);
    assert.match(md, /modo de laboratorio: esto NO es un Windows/);
    const rows = P.shortRows(report);
    assert.deepStrictEqual(rows.filter((x) => x.match === false).map((x) => x.what), ['El banco de controles entero (`runner.js --tool claude`)', 'El banco no escribe en la carpeta de usuario de quien lo corre', 'Portones por ruta, forma `/c/a/b`', '`windows-support.test.js`']);
    assert.match(r.stdout, /NO\s+4 · El banco de controles entero/);
    assert.match(r.stdout, /veredicto VERDE \(se pudo medir\) · coinciden \d+ · no coinciden 4/);
    // un laboratorio no se usa dos veces
    const again = node([path.join(DIR, 'rehearse.js'), 'step', 'fresh-clone', '--lab', lab, '--out', out, '--allow-temp'], { env });
    assert.strictEqual(again.status, 0);
    assert.match(JSON.parse(fs.readFileSync(path.join(out, 'steps', 'fresh-clone.json'), 'utf8')).reason, /ya existe — el laboratorio es de una sola ejecución/);

    // ── un commit anterior al cambio (la rama principal): las piezas que no trae salen «no medido», y sin el banco
    // no se pudo medir: la corrida es roja
    const src2 = path.join(base, 'sources-main');
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', src2, '--harness', toy.harness, '--skills', toy.skills, '--friday-tag', TOY_TAG]).status, 0);
    const lab2 = path.join(base, 'lab2'); const out2 = path.join(base, 'out2');
    const before = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab2, '--out', out2, '--sources', src2, '--scenario', 'portable', '--allow-temp'], { env, timeout: 600000 });
    const r2 = JSON.parse(fs.readFileSync(path.join(out2, 'windows-report.json'), 'utf8'));
    const st2 = Object.fromEntries(r2.steps.map((s) => [s.name, s.status]));
    assert.deepStrictEqual([st2['fresh-clone'], st2['git-bash'], st2.suites, st2.bench, st2['path-shapes'], r2.verdict.color, before.status], ['measured', 'not-measured', 'not-measured', 'error', 'error', 'red', 1], JSON.stringify(r2.steps.map((s) => s.reason)));
    // sin la regla, el clon nuevo llega entero con \r: es el dato que el cambio viene a cambiar
    const f2 = r2.steps.find((s) => s.name === 'fresh-clone');
    assert.deepStrictEqual([f2.facts.repos.harness.scripts.with_cr, f2.facts.repos.harness.scripts.total, f2.facts.repos.harness.gitattributes], [4, 4, false]);
    assert.ok(f2.findings.some((x) => x.id === 'fresh-clone:harness:scripts-with-cr'));
    assert.match(f2.facts.tests['line-endings'].not_run, /no trae scripts\/tests\/eol\.test\.js/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// ═══ T54 · la base portable sobre UN SOLO REPO ═══════════════════════════════════════════════
// El árbol publicado es un repo, con las skills adentro: el laboratorio trae un solo remoto. La medición clona y cuenta
// ese repo y nada más —no pide un segundo remoto que no hay—, y el reporte no trae la fila del segundo.
test('Portable_SingleRepo_MeasuresOnlyTheHarnessClone', { skip: (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows corre la medición de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, () => {
  const base = tmp('single');
  try {
    const toy = toyRepos(base);
    // el arnés de juguete con las skills adentro, parado en la rama del cambio (como lo trae un agente)
    git(['checkout', '-q', 'story/toy-portable'], toy.harness);
    write(toy.harness, { 'skills/toy/SKILL.md': '# de juguete\n' });
    git(['add', '-A'], toy.harness);
    assert.strictEqual(git(['commit', '-q', '-m', 'las skills adentro'], toy.harness).status, 0);
    const tip = git(['rev-parse', 'HEAD'], toy.harness).stdout.trim();
    const src = path.join(base, 'sources');
    const made = node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.harness, '--single-repo']);
    assert.strictEqual(made.status, 0, made.stderr);
    const env = Object.assign({}, process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true', TYCON_NO_NIGHTLY_EXAM: '0' });
    const lab = path.join(base, 'lab'); const out = path.join(base, 'out');
    const r = node([path.join(DIR, 'rehearse.js'), 'all', '--lab', lab, '--out', out, '--sources', src, '--scenario', 'portable', '--allow-temp'], { env, timeout: 600000 });
    const why = `${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n');
    const report = JSON.parse(fs.readFileSync(path.join(out, 'windows-report.json'), 'utf8'));
    const step = (name) => report.steps.find((s) => s.name === name);
    assert.deepStrictEqual(report.steps.map((s) => [s.name, s.status]), rehearse.SCENARIOS.portable.map((n) => [n, 'measured']), `${JSON.stringify(report.steps.map((s) => s.reason))}\n${why}`);
    assert.deepStrictEqual([r.status, report.verdict.color, report.run.single_repo, Object.keys(report.run.commits)], [0, 'green', true, ['harness']], why);
    assert.deepStrictEqual([report.run.commits.harness.today, report.run.commits.harness.since_base], [tip, 2], 'lo que se mide es el commit del checkout; el «antes», la rama principal');
    // un solo repo clonado y contado, en las dos partes que clonan
    assert.deepStrictEqual(Object.keys(step('fresh-clone').facts.repos), ['harness']);
    assert.deepStrictEqual(Object.keys(step('existing-clone').facts.repos), ['harness']);
    assert.deepStrictEqual(fs.readdirSync(path.join(lab, 'portable', 'fresh')), ['tycon-claude-guides'], 'ningún clon de un segundo repo');
    assert.strictEqual(step('fresh-clone').facts.repos.harness.head, tip);
    assert.deepStrictEqual(step('existing-clone').facts.repos.harness.pull.exit, 0);
    // las skills que ven el banco y las suites son las del propio clon
    const measured = step('suites').facts.measured;
    assert.deepStrictEqual([measured.harness, measured.skills, measured.unified, measured.skills_dir], [tip, null, true, step('fresh-clone').facts.repos.harness.dir]);
    // ningún hallazgo ni renglón habla del repo que no hay
    const ids = report.steps.flatMap((s) => (s.findings || []).map((f) => f.id));
    assert.deepStrictEqual(ids.filter((id) => /:skills:/.test(id)), [], ids.join(', '));
    const md = fs.readFileSync(path.join(out, 'windows-report.md'), 'utf8');
    assert.match(md, /\| arnés \| `[0-9a-f]{10}`/);
    // (el texto «agent-skills» sí puede aparecer: es el nombre de una prueba del árbol de juguete, citada tal cual)
    assert.doesNotMatch(md, /\| agent-skills \|/, 'la tabla de lo que se mide no trae la fila de un segundo repo');
    assert.ok(P.shortRows(report).every((row) => !/agent-skills/.test(row.what)), 'ningún renglón del «En corto» es de un segundo repo');
    // también el paso que CLONA dice dónde están las skills después de clonar (antes del clon no se puede saber): con
    // un solo repo, el propio clon; nunca la carpeta de un segundo repo que no existe
    const freshMeasured = step('fresh-clone').facts.measured;
    assert.deepStrictEqual([freshMeasured.unified, freshMeasured.skills_dir], [true, step('fresh-clone').facts.repos.harness.dir]);
    assert.ok(!fs.existsSync(path.join(lab, 'portable', 'fresh', 'agent-skills')));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Portable_SingleRepo_NoBefore_ExistingCloneIsNotMeasured_NoSkillsInsideIsAnError', { skip: (process.platform === 'win32' && 'el recorrido de juguete es del modo de laboratorio: en Windows corre la medición de verdad') || (!has('git') && 'NO MEDIDO — sin git') || (!has('bash') && 'NO MEDIDO — sin bash') }, () => {
  const base = tmp('single-edges');
  try {
    // los repos que se miden son los remotos que hay
    assert.deepStrictEqual(probe.reposOf({ remotes: { harness: {}, skills: {} } }).map(([key]) => key), ['harness', 'skills']);
    assert.deepStrictEqual(probe.reposOf({ remotes: { harness: {} } }).map(([key]) => key), ['harness']);
    const toy = toyRepos(base);
    const env = Object.assign({}, process.env, { TYCON_NO_NIGHTLY_EXAM: '0' });
    const runPart = (lab, out, part) => { const r = node([path.join(DIR, 'rehearse.js'), 'step', part, '--lab', lab, '--out', out, '--allow-temp'], { env, timeout: 300000 }); assert.strictEqual(r.status, 0, r.stderr); return JSON.parse(fs.readFileSync(path.join(out, 'steps', `${part}.json`), 'utf8')); };
    const init = (name, src) => { const lab = path.join(base, `${name}-lab`); const out = path.join(base, `${name}-out`); const made = rehearse.initLab({ lab, out, sources: src, scenario: 'portable', allowTemp: true }); assert.ok(made.ok, made.reason); return [lab, out]; };
    // ── un solo repo, con las skills adentro, parado en la rama principal y sin marca: no hay un «antes»
    git(['checkout', '-q', 'story/toy-portable'], toy.harness);
    write(toy.harness, { 'skills/toy/SKILL.md': '# de juguete\n' });
    git(['add', '-A'], toy.harness); git(['commit', '-q', '-m', 'las skills adentro'], toy.harness);
    git(['checkout', '-q', '-B', 'main'], toy.harness);   // la rama principal ES lo que se mide
    const src = path.join(base, 'sources');
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', src, '--harness', toy.harness, '--single-repo']).status, 0);
    const [lab, out] = init('no-before', src);
    assert.strictEqual(runPart(lab, out, 'fresh-clone').status, 'measured');
    const existing = runPart(lab, out, 'existing-clone');
    assert.strictEqual(existing.status, 'not-measured', existing.reason);
    assert.match(existing.reason, /no hay un «antes» del que arrancar/);
    assert.match(existing.reason, /ya está en la rama principal/, 'dice el motivo real, el que dejó dicho quien armó el bundle');
    assert.doesNotMatch(existing.reason, /no pude medir|de esta rama/);
    // ── con DOS repos, un bundle sin «antes» sigue siendo un error (lo arma un build-sources viejo): nada cambió ahí
    const lab2 = path.join(base, 'two-lab');
    fs.mkdirSync(lab2); fs.writeFileSync(path.join(lab2, L.LAB_MARK), '{}\n');
    fs.writeFileSync(path.join(lab2, T.STATE_FILE), JSON.stringify({ remotes: { harness: { dir: 'x', target: 'a', base: null }, skills: { dir: 'y', target: 'c', base: null } } }));
    const two = runPart(lab2, path.join(base, 'two-out'), 'existing-clone');
    assert.strictEqual(two.status, 'error');
    assert.match(two.reason, /no traen la rama «base»/);
    // ── un solo repo cuyo árbol NO trae las skills adentro: no se sigue con una carpeta de skills que no existe
    const bare = path.join(base, 'bare-harness');
    fs.mkdirSync(bare); git(['init', '-q', '-b', 'main'], bare);
    write(bare, { 'README.md': '# sin skills\n', 'scripts/hooks/a.sh': '#!/bin/sh\nexit 0\n' });
    git(['add', '-A'], bare); git(['commit', '-q', '-m', 'x'], bare);
    const src3 = path.join(base, 'sources-bare');
    assert.strictEqual(node([path.join(DIR, 'build-sources.js'), '--output', src3, '--harness', bare, '--single-repo']).status, 0);
    const [lab3, out3] = init('bare', src3);
    const fresh3 = runPart(lab3, out3, 'fresh-clone');
    assert.strictEqual(fresh3.status, 'error', fresh3.reason);
    assert.match(fresh3.reason, /un solo repo y su árbol no trae las skills adentro/);
    assert.strictEqual(fresh3.facts.measured.unified, false, 'con el clon hecho, se sabe: no trae las skills adentro');
    // … y si el clon nunca llegó a existir, «¿trae las skills?» no se sabe: no se anota «no»
    const [lab4, out4] = init('no-clone-yet', src);
    fs.rmSync(path.join(lab4, 'remotes', 'harness.git'), { recursive: true, force: true });   // el clon va a fallar
    const fresh4 = runPart(lab4, out4, 'fresh-clone');
    assert.strictEqual(fresh4.status, 'error', fresh4.reason);
    assert.deepStrictEqual([fresh4.facts.measured.unified, fresh4.facts.measured.skills_dir], [null, null], 'sin clon no se afirma dónde están las skills');
    const suites3 = runPart(lab3, out3, 'suites');
    assert.strictEqual(suites3.status, 'error');
    assert.match(suites3.reason, /un solo repo y su árbol no trae las skills adentro/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
