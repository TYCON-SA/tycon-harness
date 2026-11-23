'use strict';
/**
 * criticals-to-confirm.test.js — el revisor que reportó un crítico que «Hallazgos» da por arreglado vuelve a la vuelta
 * siguiente para confirmarlo.
 *
 * El caso: el cruce de críticos da por bueno un «arreglado» sólo con otra vuelta legible del revisor que lo reportó, o con
 * la exención del dueño. El descuento mecánico (MECH-2) saca a ac-coverage y a deferral-tracker desde la vuelta 2, y el
 * cálculo por diferencias saca al de pruebas en una vuelta sin código, también con `--force-full-reloop`. Lanzado suelto,
 * el registro no lo anota. En una noche costó cinco exenciones del dueño.
 *
 * Corre `pipeline.js` de verdad contra una HOME y un repo de juguete, con el registro de críticos y `findings.json`
 * escritos como los deja el arnés. 0 deps (node:test).
 *
 * stable-data: el registro y el marcador se fechan con el reloj real; las pruebas comparan órdenes, nunca una fecha fija.
 *
 * 🔴 Mutaciones que los ponen en rojo: descontar al revisor por confirmar (T1), no sumarlo cuando el set no lo traía
 * (T2), sumarlo con el crítico ya confirmado, eximido o refutado, o sin registro (T3), sumar uno que no se puede lanzar o
 * perder la marca de vuelta sin código (T3), descontar con el registro ilegible o no exigirlo en el recálculo (T4).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const { stateDir: stateDirOf } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const rcLib = () => require(path.join(SCRIPTS, 'lib', 'reported-criticals.js'));

const SID = 's-ctc';
const DEFTR = 'tycon-deferral-tracker';
const TESTS = 'tycon-plugin-tests-coverage';
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-11-14T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-14T12:00:00Z' };
const at = (seg) => new Date(Date.now() + seg * 1000).toISOString();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/**
 * Una corrida de juguete en la vuelta 2: la vuelta 1 corrió, `reportes` dice qué reportó cada revisor y `hallazgos` es
 * `findings.json`. El cambio de la vuelta 2 es `cambio` (por defecto, código).
 */
function lab({ reportes = [], hallazgos = null, cambio = { 'a.js': 'module.exports = 2;\n' }, registroRoto = false, foto = false, pases = null } = {}) {
  const base = tmp('ctc-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 'noreply@example.com'); git('config', 'user.name', 'lab');
  const story = path.join(repo, 'specs', 'story-9.93-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.93"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - a.js', '  - notas.md', '---', '',
    '# Story 9.93', '', '## Acceptance Criteria', '', '1. **Given** algo **When** pasa **Then** resultado.', '', '### Tests', '',
    '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso` | 1 | unit | x | y |', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'notas.md'), 'notas\n');
  git('add', '.'); git('commit', '-qm', 'base');
  // el código base es de antes de la vuelta 1: con la hora de ahora contaría como editado mientras corría
  const antesDeLaVuelta = new Date(Date.now() - 900000);
  fs.utimesSync(path.join(repo, 'a.js'), antesDeLaVuelta, antesDeLaVuelta);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0', TYCON_PACKS_DEFAULT: 'none', TYCON_AUTO_SNAPSHOT: '0' };
  delete env.TYCON_HOME; delete env.CODEX_SESSION_ID; delete env.CLAUDE_CONFIG_DIR; delete env.NODE_TEST_CONTEXT;
  const state = stateDirOf(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  fs.mkdirSync(path.join(state, 'advisor-runs'), { recursive: true });
  const runDir = require(PIPELINE).resolveRunDir(repo, '9.93', true, story);
  fs.mkdirSync(runDir, { recursive: true });
  const run = path.basename(runDir);
  const vuelta1 = at(-300);
  const marker = {
    storyId: '9.93', storyPath: story, repoPath: repo, sessionId: SID, stepScheme: 2, startedAt: at(-900), runDir,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests'], stepsPending: ['reviewers', 'findings', 'live-check', 'prepare-commit'],
    iter: 1, iterations: { 1: { snapshotAt: vuelta1 } }, filesTouched: [path.join(repo, 'a.js')],
    fileEvents: Object.keys(cambio).map((rel) => ({ path: path.join(repo, rel), ts: at(-60), code: /\.js$/.test(rel) })),
    // los pases adversariales anotados (mark-adversarial-result los escribe en el marcador)
    ...(pases ? { adversarialPasses: pases } : {}),
  };
  fs.writeFileSync(path.join(state, 'active', `${SID}.json`), JSON.stringify(marker, null, 2));
  fs.writeFileSync(path.join(state, 'advisor-runs', `${SID}.jsonl`), `${JSON.stringify({ ts: at(-600), event: 'step5-start', expected: [DEFTR, TESTS], iter: 1 })}\n`);
  // el registro de críticos, como lo dejan los ganchos: la salida y el reporte de cada revisor de la vuelta 1
  const registro = path.join(state, 'reported-criticals', `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(registro), { recursive: true });
  for (const r of reportes) {
    fs.appendFileSync(registro, `${JSON.stringify({ ts: at(-500), kind: 'launched', advisor: r.advisor, iter: 1, story: '9.93', run })}\n`);
    fs.appendFileSync(registro, `${JSON.stringify({ ts: r.ts || at(-400), kind: 'report', advisor: r.advisor, iter: r.iter || 1, story: '9.93', run, readable: true, criticals: r.criticals || [] })}\n`);
  }
  if (registroRoto) { fs.rmSync(path.dirname(registro), { recursive: true, force: true }); fs.writeFileSync(path.dirname(registro), 'no es una carpeta'); }
  if (hallazgos) fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(hallazgos));
  // la foto de la vuelta 1, como la toma el arnés al lanzar el último revisor: sin ella el re-loop cae al set completo
  if (foto) {
    const f = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'snapshot-iter', '1'], { cwd: repo, encoding: 'utf8', env, input: '' });
    assert.strictEqual(f.status, 0, `${f.stdout}\n${f.stderr}`);
    const m = JSON.parse(fs.readFileSync(path.join(state, 'active', `${SID}.json`), 'utf8'));
    // los cambios de la vuelta 2 son posteriores a la foto
    m.fileEvents = Object.keys(cambio).map((rel) => ({ path: path.join(repo, rel), ts: new Date(Date.now() + 1000).toISOString(), code: /\.js$/.test(rel) }));
    fs.writeFileSync(path.join(state, 'active', `${SID}.json`), JSON.stringify(m, null, 2));
  }
  for (const [rel, txt] of Object.entries(cambio)) fs.writeFileSync(path.join(repo, rel), txt);
  const correr = (args) => spawnSync(process.execPath, [PIPELINE, ...args], { cwd: repo, encoding: 'utf8', env, input: '' });
  const reloop = (extra = []) => {
    const r = correr(['smart-reloop', '--story', story, '--repo', repo, '--iter', '2', '--files', Object.keys(cambio).map((f) => path.join(repo, f)).join(','), ...extra]);
    let j = null;
    try { j = JSON.parse(r.stdout); } catch (_) { /* la aserción dice qué salió */ }
    return { ...r, j };
  };
  return { repo, home, story, state, runDir, run, registro, env, correr, reloop };
}

const DEFTR_REPORTO = { advisor: DEFTR, criticals: [{ rule: 'DEFTR-C1', count: 1 }] };
const ARREGLADO = (rule = 'DEFTR-C1') => [{ rule_id: rule, severity: 'CRITICAL', disposition: 'fixed', file: 'a.js', title: 'x' }];
const salida = (r) => `${r.stdout}\n${r.stderr}`;

test('T1 Set_FixedCriticalNotConfirmed_ReviewerBackDespiteMech @story-8.272 @ac-1 @ac-5', () => {
  for (const extra of [[], ['--force-full-reloop']]) {
    const L = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO() });
    const r = L.reloop(extra);
    assert.ok(r.j, salida(r));
    assert.ok(r.j.rerun.includes(DEFTR), `${extra}: ${JSON.stringify(r.j.rerun)} · ${salida(r)}`);
    assert.strictEqual(r.j.rerun_count, r.j.rerun.length);
    assert.deepStrictEqual((r.j.confirm_reviewers || []).map((c) => c.name), [DEFTR], salida(r));
    // la 8.296 nombra al crítico «abierto» (con o sin findings.json), no sólo al arreglado
    assert.match(r.j.confirm_reviewers[0].reason, /crítico abierto por confirmar \(DEFTR-C1\)/);
    assert.ok(!(r.j.mech_discounted || []).some((d) => d.name === DEFTR), 'no queda como descontado');
    assert.ok(!(r.j.skipped || []).some((s) => (s.name || s) === DEFTR), 'no queda como salteado');
    // sin configuración de modelos de la organización la salida no trae reviewer_models; con ella, el sumado lleva el suyo
    assert.ok(r.j.reviewer_models === undefined || r.j.reviewer_models[DEFTR], `lleva su modelo: ${JSON.stringify(r.j.reviewer_models)}`);
    // y lo que guardó para check-count lo exige
    const runs = fs.readFileSync(path.join(L.state, 'advisor-runs', `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const inicio = runs.filter((x) => x.event === 'step5-start').pop();
    assert.ok(inicio.expected.includes(DEFTR), JSON.stringify(inicio));
  }
  // su reporte nuevo ya no trae el crítico: el cruce no pide la exención
  const rc = rcLib();
  const lines = [
    { ts: at(-400), kind: 'report', advisor: DEFTR, iter: 1, readable: true, criticals: [{ rule: 'DEFTR-C1', count: 1 }] },
    { ts: at(-10), kind: 'report', advisor: DEFTR, iter: 2, readable: true, criticals: [] },
  ];
  assert.deepStrictEqual(rc.porConfirmar({ lines, findings: ARREGLADO() }).revisores, []);
  const cruce = rc.cross({ lines: [{ kind: 'launched', advisor: DEFTR, iter: 1 }, { kind: 'launched', advisor: DEFTR, iter: 2 }, ...lines], findings: ARREGLADO() });
  assert.ok(!cruce.problemas.some((p) => p.tipo === 'arreglado-sin-comprobar'), JSON.stringify(cruce.problemas));
});

test('T2 Set_FixedCriticalNotConfirmed_TestsReviewerBackWithoutCode @story-8.272 @ac-1', () => {
  const L = lab({ reportes: [{ advisor: TESTS, criticals: [{ rule: 'TEST-C1', count: 1 }] }], hallazgos: ARREGLADO('TEST-C1'), cambio: { 'notas.md': 'otras notas\n' } });
  const r = L.reloop();
  assert.ok(r.j, salida(r));
  assert.ok(r.j.rerun.includes(TESTS), `${JSON.stringify(r.j.rerun)} · ${salida(r)}`);
  assert.ok(!(r.j.skipped || []).some((s) => (s.name || s) === TESTS), JSON.stringify(r.j.skipped));
});

test('T3 Set_ConfirmedOrWaivedOrRefuted_DiscountAsToday + Set_ReviewerNotLaunchable_NotAdded + Set_NoCodeDelta_KeepsFlag @story-8.272 @ac-1 @ac-3 @ac-4 @ac-25', () => {
  const rc = rcLib();
  const reporte = { ts: at(-400), kind: 'report', advisor: DEFTR, iter: 1, readable: true, criticals: [{ rule: 'DEFTR-C1', count: 1 }] };
  // confirmado por un reporte posterior
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte, { ...reporte, ts: at(-5), iter: 2, criticals: [] }], findings: ARREGLADO() }).revisores, []);
  // refutado (con la constancia que da `refutedHolds`, por defecto válida) o diferido: ya tiene su destino, no vuelve
  // (volvería a reportarlo). Un `waived` sin la exención del dueño no es un destino (8.296, AC 11): vuelve.
  for (const disposition of ['refuted', 'deferred']) {
    assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: [{ ...ARREGLADO()[0], disposition }] }).revisores, [], disposition);
  }
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: [{ ...ARREGLADO()[0], disposition: 'waived' }], eximido: () => false }).revisores, [{ name: DEFTR, rules: ['DEFTR-C1'] }]);
  // abierto: es como queda un crítico arreglado hasta que su revisor lo confirma (write-findings no acepta fixed antes)
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: [{ ...ARREGLADO()[0], disposition: 'open' }] }).revisores, [{ name: DEFTR, rules: ['DEFTR-C1'] }]);
  // sin reportes de la corrida, o sin el reporte de ese revisor: nada que confirmar
  assert.deepStrictEqual(rc.porConfirmar({ lines: [], findings: ARREGLADO() }).revisores, []);
  assert.deepStrictEqual(rc.porConfirmar({ lines: [{ ...reporte, advisor: TESTS, criticals: [] }], findings: ARREGLADO() }).revisores, []);
  // sin findings.json, el crítico reportado sigue abierto: vuelve (8.296, AC 11)
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: [] }).revisores, [{ name: DEFTR, rules: ['DEFTR-C1'] }]);
  // con su crítico sin confirmar, vuelve
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: ARREGLADO() }).revisores, [{ name: DEFTR, rules: ['DEFTR-C1'] }]);
  // la exención del dueño (la misma consulta que el cruce: sólo la que firma una persona): nada que confirmar
  let consultada = null;
  const eximido = (o) => { consultada = o; return o.rule === 'DEFTR-C1' && o.ownerOnly === true; };
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: ARREGLADO(), story: '9.93', eximido }).revisores, []);
  assert.ok(consultada && consultada.ownerOnly, 'pregunta por la exención del dueño, no la de la coordinadora');
  // sin registro: nada que confirmar, el set es el de hoy
  const sinReportes = lab({ hallazgos: ARREGLADO() });
  const hoy = sinReportes.reloop();
  assert.ok(hoy.j, salida(hoy));
  assert.strictEqual(hoy.j.confirm_reviewers, undefined, 'sin registro: nada que confirmar');
  // un revisor que no se puede lanzar en la sesión: no se suma, y lo dice
  const ajeno = lab({ reportes: [{ advisor: 'tycon-no-existe-en-ningun-lado', criticals: [{ rule: 'NADA-C1', count: 1 }] }], hallazgos: ARREGLADO('NADA-C1') });
  const r = ajeno.reloop();
  assert.ok(r.j, salida(r));
  assert.ok(!r.j.rerun.includes('tycon-no-existe-en-ningun-lado'));
  assert.match(r.stderr, /su agente no se puede lanzar en esta sesión/);
  // una vuelta sin código nuevo con el revisor por confirmar: vuelve sólo a confirmar, y la marca se conserva
  const sinCodigo = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO(), cambio: { 'notas.md': 'otras\n' }, foto: true });
  const sc = sinCodigo.reloop();
  assert.ok(sc.j, salida(sc));
  assert.deepStrictEqual([sc.j.rerun, sc.j.rerun_count, sc.j.no_code_delta], [[DEFTR], 1, true], salida(sc));
});

test('Set_AdvisorsPath_RelativeRunDir_UnreadableMarker @story-8.272 @ac-1 @ac-4 — (revisores y pase de la 8.272) advisors suma igual; la carpeta relativa del marcador se resuelve; un marcador ilegible no descuenta', () => {
  // el set de la vuelta pedido por `advisors --iter 2`, el otro camino de la vuelta
  const L = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO() });
  const a = L.correr(['advisors', '--story', L.story, '--repo', L.repo, '--iter', '2', '--files', path.join(L.repo, 'a.js')]);
  const ja = JSON.parse(a.stdout);
  assert.ok(ja.all.includes(DEFTR), salida(a));
  assert.deepStrictEqual((ja.confirm_reviewers || []).map((c) => c.name), [DEFTR]);
  assert.strictEqual(ja.required_count, ja.all.length);
  // el marcador guarda la carpeta de la corrida relativa al repo, como la dejan algunas corridas
  const R = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO() });
  const activo = path.join(R.state, 'active', `${SID}.json`);
  const m = JSON.parse(fs.readFileSync(activo, 'utf8'));
  fs.writeFileSync(activo, JSON.stringify({ ...m, runDir: path.relative(R.repo, R.runDir) }));
  const rr = R.reloop();
  assert.ok(rr.j && rr.j.rerun.includes(DEFTR), salida(rr));
  // un marcador que no se lee no es «nada que confirmar»: no se devuelve un set descontado
  const M = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO() });
  fs.writeFileSync(path.join(M.state, 'active', `${SID}.json`), '{ esto no es json');
  const rm = M.correr(['advisors', '--story', M.story, '--repo', M.repo, '--iter', '2', '--files', path.join(M.repo, 'a.js')]);
  assert.notStrictEqual(rm.status, 0, salida(rm));
  assert.match(salida(rm), /no se puede leer|no pude leer los críticos de la corrida/, salida(rm));
  // y el ayudante solo, con el marcador ilegible, lo da como error, no como «nada»
  const pipe = require(PIPELINE);
  if (typeof pipe.revisoresPorConfirmar === 'function') {
    const antes = { HOME: process.env.HOME, SID: process.env.CLAUDE_CODE_SESSION_ID };
    process.env.HOME = M.home; process.env.CLAUDE_CODE_SESSION_ID = SID;
    try { assert.match(String(pipe.revisoresPorConfirmar({ story: M.story, iter: 2 }).error), /marcador/); } finally {
      process.env.HOME = antes.HOME; if (antes.SID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = antes.SID;
    }
  } else assert.fail('pipeline.js no exporta revisoresPorConfirmar');
});

test('T4 Set_UnreadableRegistry_NoDiscount + CheckCount_Recompute_AsksTheReviewer @story-8.272 @ac-2 @ac-4', () => {
  // el registro de críticos no se lee: esa vuelta no descuenta a nadie, y lo dice
  const roto = lab({ hallazgos: ARREGLADO(), registroRoto: true });
  const r = roto.reloop();
  assert.ok(r.j, salida(r));
  assert.ok(!(r.j.mech_discounted || []).length, JSON.stringify(r.j.mech_discounted));
  assert.match(r.stderr, /no pude leer los críticos de la corrida.*no descuento/);
  // un renglón roto y ningún reporte legible de la corrida: el mismo «registro ilegible» del cruce, no «nada que confirmar»
  const renglonRoto = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO() });
  const lineas = fs.readFileSync(renglonRoto.registro, 'utf8').trim().split('\n');
  fs.writeFileSync(renglonRoto.registro, `${lineas[0]}\n{ el reporte quedó cortado\n`);
  const rr = renglonRoto.reloop();
  assert.ok(rr.j, salida(rr));
  assert.ok(!(rr.j.mech_discounted || []).length, JSON.stringify(rr.j.mech_discounted));
  assert.match(rr.stderr, /no pude leer los críticos de la corrida.*no descuento/, salida(rr));
  // el recálculo de check-count, sin el inicio de la vuelta 2 guardado y con sólo otro revisor lanzado en ella, exige al
  // revisor por confirmar
  const L = lab({ reportes: [DEFTR_REPORTO], hallazgos: ARREGLADO() });
  const log = path.join(L.state, 'advisor-runs', `${SID}.jsonl`);
  fs.writeFileSync(log, `${JSON.stringify({ ts: at(-40), event: 'step5-start', iter: 2 })}\n${JSON.stringify({ ts: at(-30), advisor: TESTS, model: 'sonnet', repo: L.repo, story: '9.93', run: L.run })}\n`);
  const c = L.correr(['check-count', '--story', L.story, '--repo', L.repo, '--iter', '2']);
  assert.notStrictEqual(c.status, 0, salida(c));
  assert.match(salida(c), /recomputado/, salida(c));
  assert.match(salida(c), new RegExp(DEFTR), salida(c));
});

// ── 8.296: el revisor con críticos abiertos vuelve aunque findings.json todavía no los traiga ──────────────────────────
//
// 🔴 Mutaciones que los ponen en rojo: contar sólo lo que trae findings.json (T11, T12), restar un `refuted` sin constancia
// o un `waived` sin la exención del dueño, o sumar con el crítico ya con destino o confirmado (T13), y los textos de MECH-2
// que no nombran la excepción (T14).

const AC = 'tycon-ac-coverage-checker';
const AC_REPORTO = { advisor: AC, criticals: [{ rule: 'ACCOV-C1', count: 1 }] };

test('Set_CriticoAbiertoSinFindings_RevisorVuelvePorEncimaDeMech @story-8.296 @ac-11', () => {
  const L = lab({ reportes: [AC_REPORTO] });
  assert.ok(!fs.existsSync(path.join(L.runDir, 'findings.json')), 'la prueba supone que todavía no hay findings.json');
  const r = L.reloop();
  assert.ok(r.j, salida(r));
  assert.ok(r.j.rerun.includes(AC), `${JSON.stringify(r.j.rerun)} · ${salida(r)}`);
  assert.ok(!(r.j.mech_discounted || []).some((d) => d.name === AC), JSON.stringify(r.j.mech_discounted));
  const suyo = (r.j.confirm_reviewers || []).find((c) => c.name === AC);
  assert.ok(suyo, JSON.stringify(r.j.confirm_reviewers));
  assert.match(suyo.reason, /crítico abierto por confirmar \(ACCOV-C1\)/);
  const runs = fs.readFileSync(path.join(L.state, 'advisor-runs', `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(runs.filter((x) => x.event === 'step5-start').pop().expected.includes(AC));
});

test('Set_CriticoAbierto_EnAdvisorsYCheckCount @story-8.296 @ac-11', () => {
  const L = lab({ reportes: [AC_REPORTO] });
  const a = L.correr(['advisors', '--story', L.story, '--repo', L.repo, '--iter', '2', '--files', path.join(L.repo, 'a.js')]);
  const ja = JSON.parse(a.stdout);
  assert.ok(ja.all.includes(AC), salida(a));
  const inicio = fs.readFileSync(path.join(L.state, 'advisor-runs', `${SID}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.event === 'step5-start').pop();
  assert.ok(inicio.expected.includes(AC), JSON.stringify(inicio));
  // el recálculo de check-count, sin el inicio de la vuelta guardado
  const C = lab({ reportes: [AC_REPORTO] });
  fs.writeFileSync(path.join(C.state, 'advisor-runs', `${SID}.jsonl`), `${JSON.stringify({ ts: at(-40), event: 'step5-start', iter: 2 })}\n${JSON.stringify({ ts: at(-30), advisor: TESTS, model: 'sonnet', repo: C.repo, story: '9.93', run: C.run })}\n`);
  const c = C.correr(['check-count', '--story', C.story, '--repo', C.repo, '--iter', '2']);
  assert.notStrictEqual(c.status, 0, salida(c));
  assert.match(salida(c), new RegExp(AC), salida(c));
});

test('Set_ConDestinoOConfirmadoOVuelta1_NoVuelve @story-8.296 @ac-11 @ac-14', () => {
  const rc = rcLib();
  const reporte = { ts: at(-400), kind: 'report', advisor: AC, iter: 1, readable: true, criticals: [{ rule: 'ACCOV-C1', count: 1 }] };
  const hallazgo = (disposition) => [{ rule_id: 'ACCOV-C1', severity: 'CRITICAL', disposition, file: 'a.js', title: 'x' }];
  const vuelve = [{ name: AC, rules: ['ACCOV-C1'] }];
  // refutado con la constancia del verificador
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: hallazgo('refuted'), refutedHolds: () => true }).revisores, []);
  // diferido
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: hallazgo('deferred') }).revisores, []);
  // un reporte posterior que lo bajó
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte, { ...reporte, ts: at(-5), iter: 2, criticals: [] }], findings: [] }).revisores, []);
  // la vuelta 1: nadie por confirmar
  const pipe = require(PIPELINE);
  assert.deepStrictEqual(pipe.revisoresPorConfirmar({ story: 'x', iter: 1 }).agregar, []);
  // refutado sin constancia y eximido sin la exención del dueño: vuelve
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: hallazgo('refuted'), refutedHolds: () => false }).revisores, vuelve);
  assert.deepStrictEqual(rc.porConfirmar({ lines: [reporte], findings: hallazgo('waived'), eximido: () => false }).revisores, vuelve);
  // y por la corrida de verdad: un refuted escrito a mano sin su constancia no saca al revisor
  const L = lab({ reportes: [AC_REPORTO], hallazgos: hallazgo('refuted').map((f) => ({ ...f, reason: 'es falso' })) });
  const r = L.reloop();
  assert.ok(r.j && r.j.rerun.includes(AC), salida(r));
});

test('Set_TextosDeMech_NombranElRevisorQueVuelve @story-8.296 @ac-13', () => {
  const L = lab({ reportes: [{ advisor: DEFTR, criticals: [] }] });
  const r = L.reloop(['--force-full-reloop']);
  assert.ok(r.j, salida(r));
  assert.ok(r.j.mech_note, `smart-reloop no descontó: la prueba no mide su texto · ${salida(r)}`);
  assert.match(r.j.mech_note, /nunca saca a un revisor con críticos abiertos por confirmar/, r.j.mech_note);
  const a = L.correr(['advisors', '--story', L.story, '--repo', L.repo, '--iter', '2', '--files', path.join(L.repo, 'a.js')]);
  const ja = JSON.parse(a.stdout);
  assert.ok(ja.mech_note, `advisors no descontó: la prueba no mide su texto · ${salida(a)}`);
  assert.match(ja.mech_note, /nunca saca a un revisor con críticos abiertos por confirmar/, ja.mech_note);
  const m = L.correr(['mech-check', '--story', L.story, '--repo', L.repo, '--files', path.join(L.repo, 'a.js')]);
  const jm = JSON.parse(m.stdout);
  assert.deepStrictEqual(jm.ambiguous, [], 'la historia de juguete trae ambiguos: el texto que se mide es otro');
  assert.match(jm.note, /nunca saca a un revisor con críticos abiertos por confirmar/, jm.note);
  const ayuda = L.correr([]);
  assert.match(ayuda.stderr, /DESCUENTA advisors cubiertos \(MECH-2\)[\s\S]{0,200}nunca saca a un revisor con críticos abiertos/, 'la ayuda de advisors no lo dice');
});

// 🔴 Falla con: una vuelta sin código que se cierra sola con un crítico de mech-check dado por arreglado en findings.json
//    (no lo reportó ningún revisor, así que el cruce no lo mira) sin volver a correr mech-check: el crítico sigue y nadie
//    lo comprueba.
test('Set_SinCodigo_CriticoMecanicoArreglado_SeVuelveAComprobar', () => {
  const sinTest = (L) => {
    const t = fs.readFileSync(L.story, 'utf8').replace('1. **Given** algo **When** pasa **Then** resultado.\n', '1. **Given** algo **When** pasa **Then** resultado.\n2. **Given** otra cosa **When** pasa **Then** otro resultado.\n');
    fs.writeFileSync(L.story, t);
  };
  const L = lab({ hallazgos: ARREGLADO('ACCOV-C5'), cambio: { 'notas.md': 'otras\n' }, foto: true });
  sinTest(L);
  const r = L.reloop();
  assert.ok(r.j, salida(r));
  assert.notStrictEqual(r.j.no_code_delta, true, `la vuelta se cerró sola con el crítico mecánico vivo: ${salida(r)}`);
  assert.deepStrictEqual((r.j.mech_still_open || []).map((m) => m.rule), ['ACCOV-C5'], salida(r));
  // arreglado de verdad (la historia sin el criterio sin prueba): se comprueba y la vuelta se cierra
  const ok = lab({ hallazgos: ARREGLADO('ACCOV-C5'), cambio: { 'notas.md': 'otras\n' }, foto: true });
  const r2 = ok.reloop();
  assert.ok(r2.j, salida(r2));
  assert.strictEqual(r2.j.no_code_delta, true, salida(r2));
  assert.deepStrictEqual(r2.j.mech_confirmed, ['ACCOV-C5'], salida(r2));
});

// 🔴 Falla con (pase adversarial): un crítico de una regla que mech-check no evalúa, o que hoy deja ambigua, tomado por
//    comprobado porque mech-check no lo reporta: la vuelta sin código se cierra sola sin saber.
test('Set_SinCodigo_ReglaQueMechNoEvaluaOAmbigua_NoSeCierra', () => {
  const noEvalua = lab({ hallazgos: ARREGLADO('SEC-C7'), cambio: { 'notas.md': 'otras\n' }, foto: true });
  const r = noEvalua.reloop();
  assert.ok(r.j, salida(r));
  assert.notStrictEqual(r.j.no_code_delta, true, salida(r));
  assert.deepStrictEqual((r.j.mech_still_open || []).map((m) => m.rule), ['SEC-C7'], salida(r));
  assert.match(r.j.mech_still_open[0].reason, /no la evalúa/);
  // la tabla de pruebas sin la columna AC: mech-check deja ACCOV-C5 ambiguo
  const ambigua = lab({ hallazgos: ARREGLADO('ACCOV-C5'), cambio: { 'notas.md': 'otras\n' }, foto: true });
  const t = fs.readFileSync(ambigua.story, 'utf8')
    .replace('| # | Test | AC | Nivel | Escenario | Resultado esperado |', '| # | Test | Nivel | Escenario | Resultado esperado |')
    .replace('|---|---|---|---|---|---|', '|---|---|---|---|---|').replace('| T1 | `a.caso` | 1 | unit | x | y |', '| T1 | `a.caso` | unit | x | y |');
  fs.writeFileSync(ambigua.story, t);
  const ra = ambigua.reloop();
  assert.ok(ra.j, salida(ra));
  assert.notStrictEqual(ra.j.no_code_delta, true, salida(ra));
  assert.deepStrictEqual((ra.j.mech_still_open || []).map((m) => m.rule), ['ACCOV-C5'], salida(ra));
});

// 🔴 Falla con (pase adversarial): dos críticos de la misma regla, uno arreglado y otro con su destino (diferido): el que
//    mech-check sigue reportando es el diferido, y la vuelta queda trabada por el arreglado.
test('Set_SinCodigo_MismaReglaConDestino_SeCuentaPorInstancia', () => {
  const L = lab({ hallazgos: [...ARREGLADO('ACCOV-C5'), { rule_id: 'ACCOV-C5', severity: 'CRITICAL', disposition: 'deferred', file: 'specs/x.md', title: 'AC 2' }], cambio: { 'notas.md': 'otras\n' }, foto: true });
  const t = fs.readFileSync(L.story, 'utf8').replace('1. **Given** algo **When** pasa **Then** resultado.\n', '1. **Given** algo **When** pasa **Then** resultado.\n2. **Given** otra cosa **When** pasa **Then** otro resultado.\n');
  fs.writeFileSync(L.story, t);
  const r = L.reloop();
  assert.ok(r.j, salida(r));
  assert.strictEqual(r.j.no_code_delta, true, salida(r));
  assert.deepStrictEqual(r.j.mech_confirmed, ['ACCOV-C5'], salida(r));
});

// Un crítico del pase adversarial (ADV) arreglado con su prueba no espera a nadie: el pase no se repite y ningún revisor
// lo tiene asignado, así que una vuelta sin código lo dejaba abierto para siempre y trababa el cierre. Su prueba, que
// write-findings exige para el `fixed` de un hallazgo reproducido, es lo que lo confirma.
// El firmante del pase lo puede escribir cualquiera en findings.json: lo que lo ata al pase es su anotación en el marcador
// (mark-adversarial-result), que dice cuántos confirmados quedaron con su prueba. Y la prueba tiene que estar en el repo.
// 🔴 Falla con: un ADV `fixed` con prueba que deja abierta la vuelta sin código; o uno sin prueba, todavía abierto, con la
//    misma regla firmada también por un revisor, sin un pase anotado, con más críticos del pase que pruebas anotadas, o con
//    una prueba que no existe, que la cierra.
test('Set_SinCodigo_CriticoDelPaseConPrueba_SeCierra', () => {
  const ADV = (extra = {}) => ({ rule_id: 'ADV-1', severity: 'CRITICAL', disposition: 'fixed', file: 'a.js', title: 'x', advisor: 'adversarial-verify:bordes', test: 'tests/a.test.js::el borde', ...extra });
  const PASE = { tipo: '5b', confirmados: 1, pruebas: 0, propias: 1, diferidos: 0, veredicto: 'no-listo' };
  const vuelta = (hallazgos, { pases = [PASE], conPrueba = true } = {}) => {
    const L = lab({ hallazgos, cambio: { 'notas.md': 'otras\n' }, foto: true, pases });
    if (conPrueba) { fs.mkdirSync(path.join(L.repo, 'tests'), { recursive: true }); fs.writeFileSync(path.join(L.repo, 'tests', 'a.test.js'), '// la prueba\n'); }
    const r = L.reloop();
    assert.ok(r.j, salida(r));
    return r;
  };
  const cerrada = vuelta([ADV()]);
  assert.strictEqual(cerrada.j.no_code_delta, true, `la vuelta sin código quedó abierta por un ADV arreglado con prueba: ${salida(cerrada)}`);
  assert.deepStrictEqual(cerrada.j.mech_confirmed, ['ADV-1'], salida(cerrada));
  // nombrado en castellano, igual
  assert.strictEqual(vuelta([ADV({ advisor: 'pase adversarial (2 lentes)' })]).j.no_code_delta, true);
  // sin prueba, todavía abierto, con otro firmante en la misma regla, sin pase anotado, con un pase no medido, con más
  // críticos firmados por el pase que pruebas anotadas (un crítico de mech-check reetiquetado), o con la prueba que no está
  for (const [caso, hallazgos, op] of [['sin prueba', [ADV({ test: '' })]], ['abierto', [ADV({ disposition: 'open' })]],
    ['otro firmante en la misma regla', [ADV(), ADV({ advisor: 'tycon-silent-failure-hunter', test: '' })]],
    ['sin pase anotado', [ADV()], { pases: null }], ['pase no medido', [ADV()], { pases: [{ ...PASE, veredicto: 'no-medido' }] }],
    ['más críticos que pruebas del pase', [ADV(), ADV({ rule_id: 'ACCOV-C5', file: 'specs/x.md' })]],
    ['la prueba no está en el repo', [ADV()], { conPrueba: false }]]) {
    const r = vuelta(hallazgos, op);
    assert.notStrictEqual(r.j.no_code_delta, true, `${caso}: la vuelta se cerró sola · ${salida(r)}`);
    assert.ok((r.j.mech_still_open || []).some((m) => m.rule === 'ADV-1' || m.rule === 'ACCOV-C5'), `${caso} · ${salida(r)}`);
  }
});
