'use strict';
// reviewer-change-check.test.js — el examen de UN revisor y el portón que frena un cambio de revisor sin examen, con el
// examen de otra versión del archivo, o con puntaje menor que su línea de base. El corredor de casos se inyecta (un guion
// que escribe el informe con la forma de advisor-runner.js): las pruebas no llaman a ningún modelo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkReviewerChange } = require('../controls-bench/reviewer-change-check.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECK = path.join(ROOT, 'scripts', 'controls-bench', 'reviewer-change-check.js');
const AGENT = 'tycon-juguete';

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-change-')); dirs.push(d); return d; };

function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_)/.test(k)) e[k] = v;
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'reviewer-change-no-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00', ...extra };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}
/** Un arnés de juguete: el revisor, sus tres casos en la línea de base (dos verdes) y main con eso. */
function harness() {
  const dir = tmp();
  git(dir, ['init', '--quiet', '-b', 'main']);
  write(dir, {
    [`agents/${AGENT}.md`]: '---\nname: tycon-juguete\n---\nRevisá TOY-C1.\n',
    'scripts/controls-bench/baseline/claude-advisors.json': JSON.stringify({ fixed_at: '2026-10-01', tool: 'claude', runs: 3,
      cases: { [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: false, 'otro-revisor::x': true } }, null, 2) + '\n',
  });
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', 'base']);
  return dir;
}
/** El corredor de casos de mentira: deja el informe que pida `RESULTADOS` (json caso → pasa). */
function runner(results) {
  const f = path.join(tmp(), 'runner.js');
  fs.writeFileSync(f, `
const out = process.argv[process.argv.indexOf('--json') + 1];
const only = process.argv[process.argv.indexOf('--only') + 1];
const res = ${JSON.stringify(results)};
const results = {};
for (const [k, pass] of Object.entries(res)) if (k.startsWith(only)) results[k] = { tools: { claude: pass === 'skip' ? { skipped: true } : { pass } } };
require('fs').writeFileSync(out, JSON.stringify({ tool: 'claude', only: [only], results }));
`);
  return f;
}
function run(dir, args, extra = {}) {
  const r = spawnSync(process.execPath, [CHECK, ...args, '--repo', dir], { env: env(extra), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const resultOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'controls-bench', 'reviewer-exams', `${AGENT}.json`), 'utf8'));
/** Cambia el revisor en una rama y devuelve la base. */
function change(dir, text = 'Revisá TOY-C1 y también TOY-W1.\n') {
  git(dir, ['checkout', '--quiet', '-b', 'cambio']);
  fs.appendFileSync(path.join(dir, 'agents', `${AGENT}.md`), text);
  return 'main';
}
const commit = (dir, msg = 'cambio') => { git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '-m', msg]); };

test('T3 CambioDeRevisor_Resultado_ConHuella @story-1.22 @ac-3: el examen de un revisor deja revisor, huella, puntaje y línea de base', () => {
  const dir = harness();
  const r = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner({ [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: false, 'otro-revisor::x': false }) });
  assert.strictEqual(r.code, 0, r.out);
  const j = resultOf(dir);
  assert.strictEqual(j.agent, AGENT);
  assert.strictEqual(j.file, `agents/${AGENT}.md`);
  assert.strictEqual(j.hash, git(dir, ['hash-object', `agents/${AGENT}.md`]), 'la huella es la del archivo, como la calcula git');
  assert.deepStrictEqual([j.passed, j.total], [2, 3], 'sólo sus casos: el otro revisor no cuenta');
  assert.strictEqual(j.score, Number((2 / 3).toFixed(4)));
  assert.deepStrictEqual([j.baseline.passed, j.baseline.total], [2, 3], 'y el de la línea de base');
  assert.deepStrictEqual(j.regressions, []);
});

test('T4 Porton_SinCorrida_Frena @story-1.22 @ac-4: un cambio a agents/tycon-x.md sin resultado frena con el comando que lo produce', () => {
  const dir = harness();
  const base = change(dir);
  commit(dir);
  const r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`${AGENT}.*sin el examen`));
  assert.match(r.out, new RegExp(`reviewer-change-check\\.js run --agent ${AGENT}`));
  // un cambio que no toca revisores no pide nada
  const otro = harness();
  git(otro, ['checkout', '--quiet', '-b', 'cambio']); write(otro, { 'README.md': 'x\n' }); commit(otro);
  assert.strictEqual(run(otro, ['check', '--base', 'main']).code, 0);
});

test('T5 Porton_HuellaVieja_Frena @story-1.22 @ac-4: el resultado de otra versión del archivo no cuenta', () => {
  const dir = harness();
  const base = change(dir);
  const all = { [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: false };
  assert.strictEqual(run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner(all) }).code, 0);
  fs.appendFileSync(path.join(dir, 'agents', `${AGENT}.md`), 'Una frase más después del examen.\n');
  commit(dir);
  const r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /la corrida es de otra versión/);
  // con --staged mira el índice: el mismo freno antes de commitear
  const d2 = harness();
  change(d2);
  run(d2, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner(all) });
  git(d2, ['add', '-A']);
  assert.strictEqual(run(d2, ['check', '--staged']).code, 0, 'examen de la versión que se commitea: pasa');
});

test('T6 Porton_PuntajeMenor_Frena @story-1.22 @ac-4: menor frena; igual pasa; mayor pasa y la línea de base se actualiza', () => {
  const cases = (c) => ({ [`${AGENT}::a`]: true, [`${AGENT}::b`]: false, [`${AGENT}::c`]: c });
  // menor: 1 de 3 contra 2 de 3
  let dir = harness(); let base = change(dir);
  run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner(cases(false)) });
  commit(dir);
  let r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /puntaje 1\/3 .*menor .*2\/3/);
  assert.match(r.out, new RegExp(`${AGENT}::b`), 'nombra el caso que dejó de pasar');
  // igual: 2 de 3
  dir = harness(); base = change(dir);
  run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner(cases(true)) });
  commit(dir);
  r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 0, r.out);
  // mayor: 3 de 3 → la línea de base de ese revisor se actualiza en el mismo commit; la del otro, no
  dir = harness(); base = change(dir);
  const up = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner({ [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: true }) });
  assert.match(up.out, /línea de base .*actualizada/);
  const bl = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'controls-bench', 'baseline', 'claude-advisors.json'), 'utf8')).cases;
  assert.strictEqual(bl[`${AGENT}::c`], true);
  assert.strictEqual(bl['otro-revisor::x'], true);
  commit(dir);
  assert.strictEqual(run(dir, ['check', '--base', base]).code, 0);
  // mayor pero sin commitear la línea de base nueva: pasa y lo pide
  dir = harness(); base = change(dir);
  run(dir, ['run', '--agent', AGENT, '--no-baseline-update'], { TYCON_REVIEWER_EXAM_RUNNER: runner({ [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: true }) });
  commit(dir);
  r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /actualizá la línea de base/);
});

test('T6b Examen_NoPudoCorrer_NoEsPasar @story-1.22 @ac-3: si el corredor falla o no deja informe, no hay resultado', () => {
  const dir = harness();
  const broken = path.join(tmp(), 'roto.js');
  fs.writeFileSync(broken, 'process.exit(3);\n');
  const r = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: broken });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /no pude correr el examen/);
  assert.ok(!fs.existsSync(path.join(dir, 'scripts', 'controls-bench', 'reviewer-exams', `${AGENT}.json`)), 'nada escrito');
});

test('T6c Porton_EnElPortonDeCI @story-1.22 @ac-4: tycon-ci-gate.js frena el mismo cambio', () => {
  const GATE = path.join(ROOT, 'scripts', 'ci', 'tycon-ci-gate.js');
  const dir = harness();
  // el portón corre los guiones del árbol que revisa: el de este cambio va con el arnés de juguete
  fs.mkdirSync(path.join(dir, 'scripts', 'controls-bench'), { recursive: true });
  git(dir, ['add', '-A']); git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'x']);
  const base = change(dir);
  commit(dir);
  const r = spawnSync(process.execPath, [GATE, '--repo', dir, '--base', base], { env: env(), encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, new RegExp(`${AGENT}.*sin el examen`));
});

// ── examen completo, resultado determinista y verificable ─────────────────────────────────────────────────────
const ALL = (c = false) => ({ [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: c });
const blPath = (dir) => path.join(dir, 'scripts', 'controls-bench', 'baseline', 'claude-advisors.json');
const examPath = (dir) => path.join(dir, 'scripts', 'controls-bench', 'reviewer-exams', `${AGENT}.json`);
const hashOf = (dir) => git(dir, ['hash-object', `agents/${AGENT}.md`]);
/** Escribe a mano un resultado con la forma del examen. */
function handResult(dir, over = {}) {
  const cases = over.cases || { [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: false };
  const vals = Object.values(cases);
  const passed = vals.filter((v) => v === true).length;
  const res = { agent: AGENT, file: `agents/${AGENT}.md`, hash: hashOf(dir), cases, passed, total: vals.length,
    score: Number((passed / vals.length).toFixed(4)), ...over };
  fs.mkdirSync(path.dirname(examPath(dir)), { recursive: true });
  fs.writeFileSync(examPath(dir), `${JSON.stringify(res, null, 2)}\n`);
}

test('T21 Examen_Incompleto_NoEscribeNada @story-1.22 @ac-3: si falta o viene salteado un caso de la línea de base, el examen no deja resultado', () => {
  for (const [label, results, re] of [
    ['falta', { [`${AGENT}::a`]: true, [`${AGENT}::b`]: true }, /examen incompleto.*tycon-juguete::c/],
    ['salteado', { ...ALL(true), [`${AGENT}::b`]: 'skip' }, /examen incompleto.*tycon-juguete::b/],
  ]) {
    const dir = harness();
    const before = fs.readFileSync(blPath(dir), 'utf8');
    const r = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner(results) });
    assert.strictEqual(r.code, 2, `${label}: ${r.out}`);
    assert.match(r.out, re, label);
    assert.ok(!fs.existsSync(examPath(dir)), `${label}: nada escrito`);
    assert.strictEqual(fs.readFileSync(blPath(dir), 'utf8'), before, `${label}: la línea de base no se toca`);
  }
});

test('T22 Examen_LineaDeBase_NuncaBorraClaves @story-1.22 @ac-3: actualizar la línea de base pisa lo corrido, agrega lo nuevo y conserva el resto', () => {
  const dir = harness();
  const r = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner({ ...ALL(true), [`${AGENT}::d`]: true }) });
  assert.strictEqual(r.code, 0, r.out);
  const bl = JSON.parse(fs.readFileSync(blPath(dir), 'utf8')).cases;
  assert.deepStrictEqual(Object.keys(bl).sort(), ['otro-revisor::x', `${AGENT}::a`, `${AGENT}::b`, `${AGENT}::c`, `${AGENT}::d`]);
  assert.strictEqual(bl[`${AGENT}::c`], true);
});

test('T23 Examen_Resultado_ConCasosYSinMomento @story-1.22 @ac-3: el resultado trae los casos y es idéntico byte a byte entre dos corridas iguales', () => {
  const dir = harness();
  const env2 = { TYCON_REVIEWER_EXAM_RUNNER: runner(ALL(true)) };
  assert.strictEqual(run(dir, ['run', '--agent', AGENT], env2).code, 0);
  const first = fs.readFileSync(examPath(dir), 'utf8');
  const j = JSON.parse(first);
  assert.deepStrictEqual(j.cases, ALL(true));
  assert.ok(!('ran_at' in j), 'sin momento: lo dice git');
  // la primera corrida subió la línea de base: la segunda parte de la misma, así que el resultado tiene que ser el mismo
  assert.strictEqual(run(dir, ['run', '--agent', AGENT], env2).code, 0);
  const second = fs.readFileSync(examPath(dir), 'utf8');
  assert.strictEqual(run(dir, ['run', '--agent', AGENT], env2).code, 0);
  assert.strictEqual(fs.readFileSync(examPath(dir), 'utf8'), second);
  assert.strictEqual(JSON.parse(first).cases[`${AGENT}::a`], JSON.parse(second).cases[`${AGENT}::a`]);
});

test('T24 Examen_NombreInvalido_Sale2 @story-1.22 @ac-3: --agent con ruta o con guion inicial se rechaza', () => {
  const dir = harness();
  for (const bad of ['../x', 'a/b', '-x', 'a..b', '']) {
    const r = run(dir, ['run', '--agent', bad], { TYCON_REVIEWER_EXAM_RUNNER: runner(ALL(true)) });
    assert.strictEqual(r.code, 2, `${bad}: ${r.out}`);
  }
  assert.match(run(dir, ['run', '--agent', '../x']).out, /nombre de revisor inválido/);
});

test('T25 Porton_NoConfiaEnLosNumeros @story-1.22 @ac-4: passed, total y score se recalculan desde los casos', () => {
  const dir = harness();
  const base = change(dir);
  run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner(ALL(false)) });
  const j = JSON.parse(fs.readFileSync(examPath(dir), 'utf8'));
  fs.writeFileSync(examPath(dir), JSON.stringify({ ...j, passed: 3, score: 1 }));
  commit(dir);
  const r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /el resultado no cuadra con sus casos/);
});

test('T26 Porton_ResultadoMalFormado_Frena @story-1.22 @ac-4: hash que no es texto, casos vacíos o no booleanos, claves de otro revisor', () => {
  const bads = {
    'hash numérico': { hash: 7 },
    'casos vacíos': { cases: {} },
    'casos no booleanos': { cases: { [`${AGENT}::a`]: 'si', [`${AGENT}::b`]: true, [`${AGENT}::c`]: false } },
    'clave de otro revisor': { cases: { [`${AGENT}::a`]: true, [`${AGENT}::b`]: true, [`${AGENT}::c`]: false, 'otro-revisor::x': true } },
    'casos ausentes': { cases: undefined },
  };
  for (const [label, over] of Object.entries(bads)) {
    const dir = harness();
    const base = change(dir);
    handResult(dir, over);
    if (label === 'casos ausentes') { const j = JSON.parse(fs.readFileSync(examPath(dir), 'utf8')); delete j.cases; fs.writeFileSync(examPath(dir), JSON.stringify(j)); }
    commit(dir);
    const r = run(dir, ['check', '--base', base]);
    assert.strictEqual(r.code, 1, `${label}: ${r.out}`);
    assert.match(r.out, /mal formado/, label);
  }
});

test('T27 Porton_CompararContraLaBase @story-1.22 @ac-4: bajar la línea de base en el mismo cambio no baja la vara', () => {
  const dir = harness();
  const base = change(dir);
  run(dir, ['run', '--agent', AGENT, '--no-baseline-update'], { TYCON_REVIEWER_EXAM_RUNNER: runner({ [`${AGENT}::a`]: true, [`${AGENT}::b`]: false, [`${AGENT}::c`]: false }) });
  const doc = JSON.parse(fs.readFileSync(blPath(dir), 'utf8'));
  doc.cases[`${AGENT}::b`] = false;
  fs.writeFileSync(blPath(dir), JSON.stringify(doc, null, 2));
  commit(dir);
  const r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /puntaje 1\/3 .*menor .*2\/3/);
});

test('T28 Porton_FaltanClaves_Frena @story-1.22 @ac-4: un resultado sin todas las claves de la línea de base no cuenta', () => {
  const dir = harness();
  const base = change(dir);
  handResult(dir, { cases: { [`${AGENT}::a`]: true, [`${AGENT}::b`]: true } });
  commit(dir);
  const r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /el examen no corrió.*tycon-juguete::c/);
});

test('T29 Porton_RevisorNuevo_ComparaConElArbol @story-1.22 @ac-4: sin claves en la base se compara con la del cambio y se avisa; sin ninguna, frena', () => {
  const NEW = 'tycon-nuevo';
  const dir = harness();
  git(dir, ['checkout', '--quiet', '-b', 'cambio']);
  write(dir, { [`agents/${NEW}.md`]: '---\nname: tycon-nuevo\n---\nRevisá NEW-C1.\n' });
  const doc = JSON.parse(fs.readFileSync(blPath(dir), 'utf8'));
  doc.cases[`${NEW}::p`] = true; doc.cases[`${NEW}::q`] = false;
  fs.writeFileSync(blPath(dir), JSON.stringify(doc, null, 2));
  const newExam = (cases) => {
    const vals = Object.values(cases);
    const passed = vals.filter(Boolean).length;
    const file = path.join(dir, 'scripts', 'controls-bench', 'reviewer-exams', `${NEW}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ agent: NEW, file: `agents/${NEW}.md`, hash: git(dir, ['hash-object', `agents/${NEW}.md`]),
      cases, passed, total: vals.length, score: Number((passed / vals.length).toFixed(4)) }));
  };
  newExam({ [`${NEW}::p`]: true, [`${NEW}::q`]: false });
  commit(dir);
  let r = run(dir, ['check', '--base', 'main']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /revisor nuevo: la línea de base nace con este cambio/);
  // el mismo revisor sin claves tampoco en el árbol del cambio
  fs.writeFileSync(blPath(dir), JSON.stringify({ ...doc, cases: Object.fromEntries(Object.entries(doc.cases).filter(([k]) => !k.startsWith(`${NEW}::`))) }, null, 2));
  commit(dir, 'sin claves');
  r = run(dir, ['check', '--base', 'main']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /tycon-nuevo/);
});

test('T30 Porton_RegresionPorCaso_Avisa @story-1.22 @ac-4: un caso que pasaba y ya no pasa se nombra aunque el puntaje no baje', () => {
  const dir = harness();
  const base = change(dir);
  run(dir, ['run', '--agent', AGENT, '--no-baseline-update'], { TYCON_REVIEWER_EXAM_RUNNER: runner({ [`${AGENT}::a`]: false, [`${AGENT}::b`]: true, [`${AGENT}::c`]: true }) });
  commit(dir);
  const r = run(dir, ['check', '--base', base]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /aviso:.*dejaron de pasar.*tycon-juguete::a/);
});

test('T31 Porton_NoPuedeComparar_DevuelveError @story-1.22 @ac-4: con una base inexistente el control devuelve error, nunca vacío', () => {
  const dir = harness();
  change(dir); commit(dir);
  const r = checkReviewerChange({ repo: dir, base: 'no-existe', staged: false });
  assert.ok(r.error, 'error explícito');
  assert.deepStrictEqual(r.hallazgos, []);
});

test('T32 Examen_LineaDeBase_NoBajaUnCaso @story-1.22 @ac-3: si el puntaje sube pero un caso que pasaba deja de pasar, ese caso sigue en verde en la línea de base', () => {
  const dir = harness();
  // la base: a=true, b=true, c=false (2/3). La corrida: a=false, b=true, c=true, d=true (3/4): sube, y a se cae
  const r = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: runner({ [`${AGENT}::a`]: false, [`${AGENT}::b`]: true, [`${AGENT}::c`]: true, [`${AGENT}::d`]: true }) });
  assert.strictEqual(r.code, 0, r.out);
  const bl = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'controls-bench', 'baseline', 'claude-advisors.json'), 'utf8')).cases;
  assert.strictEqual(bl[`${AGENT}::a`], true, 'la vara de un caso no baja en silencio');
  assert.strictEqual(bl[`${AGENT}::c`], true);
  assert.match(r.out, new RegExp(`${AGENT}::a`), 'y la regresión se nombra');
});

test('T37 Porton_NoPudoComparar_EsHallazgo @story-1.22 @ac-4: si el control no puede comparar, el portón de CI frena (no avisa)', () => {
  const dir = harness();
  const base = change(dir);
  commit(dir);
  // el control devuelve «no pude comparar»: se reemplaza su módulo en la caché de require antes de cargar el portón
  const modPath = require.resolve(CHECK);
  const gatePath = require.resolve(path.join(ROOT, 'scripts', 'ci', 'tycon-ci-gate.js'));
  const saved = require.cache[modPath];
  delete require.cache[gatePath];
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true,
    exports: { checkReviewerChange: () => ({ error: 'git no respondió', hallazgos: [], avisos: [] }) } };
  try {
    const r = require(gatePath).revisar({ repo: dir, base, staged: false });
    const h = r.hallazgos.find((x) => x.regla === 'reviewer-exam-not-comparable');
    assert.ok(h, `hallazgo, no aviso: ${JSON.stringify(r.avisos)}`);
    assert.match(h.mensaje, /git no respondió/);
    assert.ok(!r.avisos.some((x) => x.regla === 'reviewer-exam-not-comparable'));
  } finally {
    if (saved) require.cache[modPath] = saved; else delete require.cache[modPath];
    delete require.cache[gatePath];
  }
});

test('T38 Examen_CorreElRevisorDelArbol @story-1.22 @ac-3: el examen corre el revisor tal como está en el árbol del cambio, no el instalado', () => {
  const dir = harness();
  change(dir, 'Una frase que sólo existe en este árbol.\n');
  // el corredor de mentira deja pasar los casos sólo si ve el archivo del árbol (por TYCON_AGENTS_DIR)
  const f = path.join(tmp(), 'runner.js');
  fs.writeFileSync(f, `
const fs = require('fs'); const path = require('path');
const out = process.argv[process.argv.indexOf('--json') + 1];
const only = process.argv[process.argv.indexOf('--only') + 1];
const dir = process.env.TYCON_AGENTS_DIR || '';
const seen = fs.existsSync(path.join(dir, '${AGENT}.md')) && fs.readFileSync(path.join(dir, '${AGENT}.md'), 'utf8').includes('sólo existe en este árbol');
const results = {};
for (const k of ['a', 'b', 'c']) results[only + k] = { tools: { claude: { pass: seen } } };
fs.writeFileSync(out, JSON.stringify({ tool: 'claude', only: [only], results }));
`);
  const r = run(dir, ['run', '--agent', AGENT, '--no-baseline-update'], { TYCON_REVIEWER_EXAM_RUNNER: f, TYCON_AGENTS_DIR: path.join(tmp(), 'instalado') });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual([resultOf(dir).passed, resultOf(dir).total], [3, 3], 'el corredor vio el revisor del árbol');
});

test('T39 Examen_CorredorConRojos_EsUnExamen @story-1.22 @ac-3 @ac-4: el corredor sale 1 cuando hay casos en rojo; eso es un examen que corrió y baja el puntaje, no «no pude correr»', () => {
  const dir = harness();
  const base = change(dir);
  const f = path.join(tmp(), 'runner-rojo.js');
  fs.writeFileSync(f, `
const out = process.argv[process.argv.indexOf('--json') + 1];
const only = process.argv[process.argv.indexOf('--only') + 1];
const res = { a: true, b: false, c: false };
const results = {};
for (const [k, pass] of Object.entries(res)) results[only + k] = { tools: { claude: { pass } } };
require('fs').writeFileSync(out, JSON.stringify({ tool: 'claude', only: [only], results }));
process.exit(1);
`);
  const r = run(dir, ['run', '--agent', AGENT], { TYCON_REVIEWER_EXAM_RUNNER: f });
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual([resultOf(dir).passed, resultOf(dir).total], [1, 3]);
  commit(dir);
  const c = run(dir, ['check', '--base', base]);
  assert.strictEqual(c.code, 1, c.out);
  assert.match(c.out, /puntaje 1\/3 .*menor/);
});
