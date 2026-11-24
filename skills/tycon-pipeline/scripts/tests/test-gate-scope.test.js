#!/usr/bin/env node
/**
 * test-gate-scope.test.js — la clave `test_gate` de `.test-gate.yaml`: cuándo el portón acota a lo tocado.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib', 'test-gate-scope.js');
const { parseScope } = require(LIB);

test('T1 TestGateScope_Parse — touched con quién corre la completa acota; sin clave, mal escrita o sin full_suite_by corre todo', () => {
  // 🔴 mutación: aceptar scope touched sin full_suite_by, o un valor desconocido, acotaría sin respaldo.
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: touched\n  full_suite_by: "la CI del pedido"  # obligatoria\n'), { scope: 'touched', fullSuiteBy: 'la CI del pedido' });
  assert.deepStrictEqual(parseScope(null), { scope: 'full' });
  assert.deepStrictEqual(parseScope('evidence:\n  fe_paths:\n    - x\n'), { scope: 'full' });
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: full\n'), { scope: 'full' });
  assert.match(parseScope('test_gate:\n  scope: touched\n').problem, /pide full_suite_by/);
  assert.match(parseScope('test_gate:\n  scope: algunas\n  full_suite_by: x\n').problem, /touched o full/);
  assert.match(parseScope('test_gate: touched\n').problem, /tiene que ser un bloque/);
  // el bloque termina en la siguiente clave de primer nivel
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: touched\nfull_suite_by: afuera\n').scope, 'full');
});

test('TestGateScope_TopeDeLaMaquina — max_local_suites es opcional; mal escrito, rige el de fábrica y se dice', () => {
  const con = (v) => parseScope(`test_gate:\n  scope: touched\n  full_suite_by: "la CI"\n  max_local_suites: ${v}\n`);
  assert.deepStrictEqual(con('40'), { scope: 'touched', fullSuiteBy: 'la CI', maxLocalSuites: 40 });
  for (const malo of ['0', '-3', 'muchas', '1.5']) {
    const r = con(malo);
    assert.deepStrictEqual([r.scope, r.fullSuiteBy, r.maxLocalSuites], ['touched', 'la CI', undefined], malo);
    assert.match(r.problem, /max_local_suites tiene que ser un entero/, malo);
  }
});

test('T2 TestGateScope_SoloLoCommiteado — la clave escrita en la carpeta sin commitear no acota', () => {
  // 🔴 mutación: leer la carpeta de trabajo dejaría a un agente acotar el portón con un Write sin rastro en el diff.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, '.test-gate.yaml'), 'test_gate:\n  scope: touched\n  full_suite_by: la CI\n');
  const sin = spawnSync('node', [LIB, repo], { encoding: 'utf8' });
  assert.strictEqual(sin.status, 10, sin.stdout);
  git('add', '.'); git('commit', '-qm', 'clave');
  const con = spawnSync('node', [LIB, repo], { encoding: 'utf8' });
  assert.strictEqual(con.status, 0, con.stderr);
  assert.strictEqual(con.stdout, 'la CI');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('F210 TestGateScope_SinSuiteLocal_Parse — none con quién la corre y el motivo; sin alguno de los dos, corre todo', () => {
  // 🔴 mutación: aceptar none sin motivo o sin quién la corre dejaría una suite sin correr en ningún lado sin decir por qué.
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: none\n  full_suite_by: "la CI del pedido"\n  reason: "la suite le pega a la base de otra persona"\n'),
    { scope: 'none', fullSuiteBy: 'la CI del pedido', reason: 'la suite le pega a la base de otra persona' });
  const sinMotivo = parseScope('test_gate:\n  scope: none\n  full_suite_by: la CI\n');
  assert.deepStrictEqual([sinMotivo.scope, /pide reason/.test(sinMotivo.problem)], ['full', true]);
  const sinQuien = parseScope('test_gate:\n  scope: none\n  reason: la base\n');
  assert.deepStrictEqual([sinQuien.scope, /pide full_suite_by/.test(sinQuien.problem)], ['full', true]);
});

// 🔴 Falla con: un repo cuya suite le pega a recursos ajenos no tenía cómo decir «acá no se corre»; la única salida era
// un alcance falso para que el portón saliera 3
test('F210 TestGate_SinSuiteLocal_NoCorreYSale3ConElMotivo — el portón no corre la suite del repo que la declara sin correr acá', () => {
  const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const home = tmp('tg-none-home-');
  const state = tmp('tg-none-state-');
  const repo = tmp('tg-none-repo-');
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', '-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 'prueba@ejemplo.invalid'); git('config', 'user.name', 'prueba');
  fs.mkdirSync(path.join(repo, 'scripts', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'suites.json'), JSON.stringify({ diarias: [{ raiz: 'arnes', ruta: 'tests/a.test.sh' }], semanales: [] }));
  fs.writeFileSync(path.join(repo, 'scripts', 'tests', 'a.test.sh'), '#!/usr/bin/env bash\necho a >> "$TG_STATE/corridas"\nexit 0\n');
  fs.writeFileSync(path.join(repo, '.test-gate.yaml'), 'test_gate:\n  scope: none\n  full_suite_by: "la CI del pedido"\n  reason: "la suite le pega a la base de otra persona"\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE',
    'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_OUT_FILE', 'TYCON_TEST_GATE_STORY_REPO', 'TYCON_EVIDENCE_DIR',
    'TYCON_EVIDENCE_KEY', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR', 'TYCON_SUITE_RUNNER']) delete env[k];
  const r = spawnSync('bash', [path.join(__dirname, '..', 'test-gate.sh'), repo], { cwd: repo, encoding: 'utf8', timeout: 120000,
    env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'sin-suite-local', TG_STATE: state } });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.strictEqual(r.status, 3, out);
  assert.ok(!fs.existsSync(path.join(state, 'corridas')), `corrió la suite: ${out}`);
  assert.match(out, /la suite le pega a la base de otra persona/);
  const art = JSON.parse(fs.readFileSync(path.join(repo, '.advisors', 'tests-result.json'), 'utf8'));
  assert.deepStrictEqual([art.suite_exit, art.no_local_suite, art.full_suite_by], [3, true, 'la CI del pedido']);
  for (const d of [home, state, repo]) fs.rmSync(d, { recursive: true, force: true });
});

// 🔴 Falla con: sin la marca de «sin medir», al combinar con los hermanos un hermano en verde convertía el 3 del repo de
// la historia en 0, y la corrida salía verde sin haber medido ese repo
test('F210 TestGate_SinSuiteLocal_ConHermanoVerde_SigueSinMedir — un hermano en verde no vuelve verde al repo que no corrió', () => {
  const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const raiz = tmp('tg-none-hermano-');
  const home = tmp('tg-none-hermano-home-');
  const repo = (dir, archivos) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, txt] of Object.entries(archivos)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); }
    const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.email=lab@ejemplo.invalid', '-c', 'user.name=lab', 'commit', '-q', '-m', 'base');
    return dir;
  };
  const historia = ['---', 'epic: 9', 'story: "9.40"', 'title: "sin suite local"', 'status: in-progress', 'files_to_modify:',
    '  - app/tests/x.test.js', '---', '', '# Story 9.40', '', '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** se ve', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `prueba` | 1 | unit | x | y |', ''].join('\n');
  const back = repo(path.join(raiz, 'Back'), {
    'specs/s.md': historia, 'package.json': JSON.stringify({ name: 'b', version: '1.0.0', scripts: { test: 'node --test' } }) + '\n',
    '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - Front\n',
    '.test-gate.yaml': 'test_gate:\n  scope: none\n  full_suite_by: "la CI del pedido"\n  reason: "la suite le pega a la base de otra persona"\n',
  });
  repo(path.join(raiz, 'Front'), {
    'app/package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }) + '\n',
    'app/tests/x.test.js': "const {test}=require('node:test');test('ok',()=>{});\n",
  });
  const env = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION',
    'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_STORY_REPO', 'TYCON_EVIDENCE_DIR', 'TYCON_EVIDENCE_KEY', 'TYCON_GATE_ALL_SUITES']) delete env[k];
  const r = spawnSync('bash', [path.join(__dirname, '..', 'test-gate.sh'), back, path.join(back, 'specs', 's.md')], { cwd: back, encoding: 'utf8', timeout: 180000,
    env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'sin-suite-local-hermano' } });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /sin suite local/, out);
  assert.strictEqual(r.status, 3, `el hermano en verde no tiene que volver verde al repo que no corrió:\n${out}`);
  for (const d of [raiz, home]) fs.rmSync(d, { recursive: true, force: true });
});

test('T4 TestGateScope_AcotarPideFirma — la configuración que acota el portón es regla de la revisión de controles: cambiarla pide la firma del dueño', () => {
  // 🔴 mutación: sin la entrada en el inventario, quien commitea `test_gate: scope: touched` acota el portón sin firma.
  const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  const reglas = inv.controls.flatMap((c) => (c.rules || []).map((r) => (typeof r === 'string' ? r : r.path)));
  assert.ok(reglas.includes('.test-gate.yaml'), JSON.stringify(reglas));
});
