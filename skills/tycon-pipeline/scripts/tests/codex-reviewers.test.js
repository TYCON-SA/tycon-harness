#!/usr/bin/env node
/**
 * codex-reviewers.test.js — bajo Codex, los revisores los lanza el pipeline (`pipeline.js reviewers-run`), no el modelo.
 *
 * El caso: con Codex, el paso «Revisores» le pedía al modelo que lanzara cada revisor como agente aparte. Un modelo que no
 * usa esa herramienta no lanzaba ninguno, y `check-count` no tenía qué contar. El lanzador corre cada revisor como un
 * proceso `codex exec -p <revisor>` aparte y deja la misma constancia que el gancho.
 *
 * `codex` de mentira: un guion al frente del PATH que anota cada llamada (argumentos, si la entrada estuvo cerrada, cuándo
 * empezó y terminó) y escribe el reporte en el archivo de `-o`. Todo con HOME temporal: el estado real no se toca.
 *
 * stable-data: lee el reloj a propósito — mide cuántos revisores estuvieron vivos a la vez (inicio y fin de cada
 * proceso) y cuánto tardó el tope en cortar; ninguna aserción compara contra una fecha fija.
 *
 * 🔴 Mutaciones que los ponen en rojo: lanzar sin cerrar la entrada (T1), ventana de más de 4 o de más de 2 con el pase en
 * vuelo (T2), ignorar la sesión del marcador (T3), contar una línea del lanzador sin reporte o con salida ≠ 0 (T4, T5, T6),
 * relanzar un revisor ya hecho o dejar vivo el de la corrida cortada (T16).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const REPO_ROOT = path.join(SCRIPTS, '..', '..', '..');
const SID = 'test-codex-reviewers';

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const adv = argv[argv.indexOf('-p') + 1];
const out = argv[argv.indexOf('-o') + 1];
const beh = (JSON.parse(process.env.FAKE_CODEX_BEHAVIOR || '{}')[adv]) || {};
let stdinClosed = false;
try { stdinClosed = fs.fstatSync(0).isCharacterDevice() || fs.readFileSync(0).length === 0; } catch { stdinClosed = true; }
const rec = { adv, argv, stdinClosed, pid: process.pid, start: Date.now() };
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ ...rec, event: 'start' }) + '\\n');
const fin = () => {
  if (!beh.noReport) fs.writeFileSync(out, '## ' + adv + '\\nVeredicto: limpio\\n');
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ adv, pid: process.pid, event: 'end', end: Date.now() }) + '\\n');
  if (beh.stderr) process.stderr.write(beh.stderr);
  process.exit(beh.exit || 0);
};
if (beh.wrapperHang) {
  // como el codex de npm: un envoltorio que lanza el binario real con la salida heredada, y los dos quedan colgados
  const nieto = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ adv, event: 'grandchild', pid: nieto.pid }) + '\\n');
  setInterval(() => {}, 1000);
} else if (beh.hang) setInterval(() => {}, 1000); else setTimeout(fin, beh.sleepMs || 50);
`;

function mkEnv(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cxrev-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cxrev-repo-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cxrev-bin-'));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const fechas = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=noreply@example.com', '-c', 'user.name=lab', ...a], { stdio: 'ignore', env: { ...process.env, ...fechas } });
  fs.mkdirSync(path.join(repo, 'specs'));
  const storyPath = path.join(repo, 'specs', 'story-1.1.md');
  fs.writeFileSync(storyPath, ['---', 'epic: 1', 'story: "1.1"', 'title: "x"', 'status: in-progress', '---', '# Story 1.1', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  if (opts.withCodex !== false) {
    fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  }
  const advisors = opts.advisors || ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter', 'tycon-spec-first-checker'];
  for (const a of advisors) if (!(opts.missingProfile || []).includes(a)) fs.writeFileSync(path.join(codexHome, `${a}.config.toml`), 'model = "x"\n');
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'advisor-runs'), { recursive: true });
  const marker = {
    storyId: '1.1', storyPath, repoPath: repo, sessionId: SID, stepScheme: 2, startedAt: '2026-01-01T00:00:00.000Z',
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests'],
    stepsPending: ['reviewers', 'findings', 'prepare-commit'], filesTouched: ['a.js'], fileEvents: [],
    ...(opts.marker || {}),
  };
  fs.writeFileSync(path.join(stateDir, 'active', `${SID}.json`), JSON.stringify(marker, null, 2));
  const ctx = path.join(home, 'context.md');
  fs.writeFileSync(ctx, '# contexto\n');
  const logPath = path.join(stateDir, 'advisor-runs', `${SID}.jsonl`);
  fs.writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: 'step5-start', expected: advisors, iter: 1, context_file: ctx }) + '\n');
  const fakeLog = path.join(home, 'fake-codex.jsonl');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CODEX_SESSION_ID: SID, FAKE_CODEX_LOG: fakeLog,
    FAKE_CODEX_BEHAVIOR: JSON.stringify(opts.behavior || {}), PATH: `${bin}${path.delimiter}${opts.withCodex === false ? '/usr/bin:/bin' : process.env.PATH}`,
    TYCON_PACKS_DEFAULT: 'none', TYCON_AUTO_SNAPSHOT: opts.snapshot ? '1' : '0', ...(opts.env || {}) };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.TYCON_SESSION_ID; delete env.CLAUDE_CONFIG_DIR;
  // sin la carpeta de node: ahí suele estar instalado el `codex` real
  if (opts.withCodex === false) env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  return { home, repo, storyPath, logPath, fakeLog, env, advisors, stateDir, marker };
}

const runReviewers = (e, extra = []) => spawnSync(process.execPath, [PIPELINE, 'reviewers-run', '--repo', e.repo, '--story', e.storyPath, ...extra], { cwd: e.repo, env: e.env, encoding: 'utf8', timeout: 60000 });
const checkCount = (e) => spawnSync(process.execPath, [PIPELINE, 'check-count', '--repo', e.repo, '--story', e.storyPath, '--files', 'a.js'], { cwd: e.repo, env: e.env, encoding: 'utf8', timeout: 60000 });
const fakeCalls = (e) => (fs.existsSync(e.fakeLog) ? fs.readFileSync(e.fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ledger = (e) => fs.readFileSync(e.logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function reportsDir(e) {
  const base = path.join(e.repo, '.advisors', 'pipeline-runs');
  if (!fs.existsSync(base)) return null;
  const run = fs.readdirSync(base).find((d) => fs.existsSync(path.join(base, d, 'step-05-advisor-reports')));
  return run ? path.join(base, run, 'step-05-advisor-reports') : null;
}
function maxAlive(calls) {
  const ev = [];
  for (const c of calls) ev.push([c.event === 'start' ? c.start : c.end, c.event === 'start' ? 1 : -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0; let max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  return max;
}

test('ReviewersRun_LaunchesEachReviewer_AsSeparateCodexProcess @story-8.97 @ac-1', () => {
  const e = mkEnv();
  const r = runReviewers(e);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const starts = fakeCalls(e).filter((c) => c.event === 'start');
  assert.deepStrictEqual(starts.map((c) => c.adv).sort(), [...e.advisors].sort());
  for (const c of starts) {
    assert.strictEqual(c.argv[0], 'exec');
    assert.ok(c.stdinClosed, `${c.adv}: la entrada quedó abierta`);
    assert.ok(c.argv.some((a) => a.includes(path.join(e.home, 'context.md'))), `${c.adv}: sin el context_file`);
  }
  const dir = reportsDir(e);
  assert.ok(dir, 'sin carpeta de reportes');
  for (const a of e.advisors) assert.ok(fs.statSync(path.join(dir, `${a}.md`)).size > 0, `falta el reporte de ${a}`);

  // el revisor con su propio contexto (context_file_overrides) recibe ése, no el común
  const e2 = mkEnv();
  const propio = path.join(e2.home, 'contexto-propio.md');
  fs.writeFileSync(propio, '# propio\n');
  const linea = JSON.parse(fs.readFileSync(e2.logPath, 'utf8').trim());
  linea.context_file_overrides = { 'tycon-spec-first-checker': propio };
  fs.writeFileSync(e2.logPath, JSON.stringify(linea) + '\n');
  assert.strictEqual(runReviewers(e2).status, 0);
  const calls = fakeCalls(e2).filter((c) => c.event === 'start');
  assert.ok(calls.find((c) => c.adv === 'tycon-spec-first-checker').argv.some((a) => a.includes(propio)), 'no le pasó su contexto propio');
  assert.ok(!calls.find((c) => c.adv === 'tycon-plugin-security-basics').argv.some((a) => a.includes(propio)), 'el contexto propio le llegó a otro revisor');
});

test('ReviewersRun_Window_AtMostFourAlive @story-8.97 @ac-1', () => {
  const seven = ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter', 'tycon-spec-first-checker', 'tycon-ac-coverage-checker',
    'tycon-deferral-tracker', 'tycon-plugin-tests-coverage', 'tycon-story-validator'];
  const slow = Object.fromEntries(seven.map((a) => [a, { sleepMs: 400 }]));
  const e = mkEnv({ advisors: seven, behavior: slow });
  assert.strictEqual(runReviewers(e).status, 0);
  const m = maxAlive(fakeCalls(e));
  assert.ok(m <= 4 && m >= 2, `vivos a la vez: ${m}`);

  const e2 = mkEnv({ advisors: seven, behavior: slow, marker: { adversarial: { runId: 'r1', launchedAt: new Date().toISOString(), launchedAtStep: '5b' } } });
  assert.strictEqual(runReviewers(e2).status, 0);
  assert.ok(maxAlive(fakeCalls(e2)) <= 2, `con el pase adversarial en vuelo: ${maxAlive(fakeCalls(e2))} vivos`);
});

test('ReviewersRun_OllamaSession_PassesProviderAndModel @story-8.97 @ac-2', () => {
  const e = mkEnv({ marker: { codexSession: { oss: true, provider: 'ollama', model: 'kimi-k2.7-code:cloud' } } });
  const run = runReviewers(e);
  assert.strictEqual(run.status, 0);
  // el anuncio (regla B) dice cada revisor con su modelo
  for (const a of e.advisors) assert.match(run.stderr, new RegExp(`${a} \\(kimi-k2\\.7-code:cloud\\)`), `el anuncio no dice el modelo de ${a}`);
  for (const c of fakeCalls(e).filter((x) => x.event === 'start')) {
    const a = c.argv.join(' ');
    assert.ok(a.includes('--oss --local-provider ollama'), a);
    assert.ok(a.includes('-m kimi-k2.7-code:cloud'), a);
  }
  const lines = ledger(e).filter((l) => l.launcher === 'pipeline');
  assert.ok(lines.every((l) => l.model === 'kimi-k2.7-code:cloud'));

  const e2 = mkEnv();
  assert.strictEqual(runReviewers(e2).status, 0);
  for (const c of fakeCalls(e2).filter((x) => x.event === 'start')) {
    assert.ok(!c.argv.includes('-m'), 'sin sesión de Codex, el modelo es el del perfil');
    assert.ok(!c.argv.includes('--oss'));
  }

  // `start --codex-session` lo guarda en el marcador
  const e3 = mkEnv();
  fs.unlinkSync(path.join(e3.stateDir, 'active', `${SID}.json`));
  // `start` escribe el marcador con el marker.js del arnés instalado en el HOME: el de este árbol. Y arranca sólo
  // fuera de la rama protegida, con la story lista para empezar.
  fs.symlinkSync(REPO_ROOT, path.join(e3.home, '.claude', 'agent-skills'));
  fs.writeFileSync(e3.storyPath, fs.readFileSync(e3.storyPath, 'utf8').replace('status: in-progress', 'status: ready-for-dev'));
  execFileSync('git', ['-C', e3.repo, 'checkout', '-qb', 'story/1.1'], { stdio: 'ignore' });
  spawnSync(process.execPath, [PIPELINE, 'start', '--story', e3.storyPath, '--repo', e3.repo, '--brief', '--no-autonomous',
    '--codex-session', '{"oss":true,"provider":"ollama","model":"kimi-k2.7-code:cloud"}'], { cwd: e3.repo, env: e3.env, encoding: 'utf8', timeout: 60000 });
  const m = JSON.parse(fs.readFileSync(path.join(e3.stateDir, 'active', `${SID}.json`), 'utf8'));
  assert.deepStrictEqual(m.codexSession, { oss: true, provider: 'ollama', model: 'kimi-k2.7-code:cloud' });

  // una opción de la sesión no afloja el sandbox ni la aprobación de los revisores
  const floja = spawnSync(process.execPath, [PIPELINE, 'start', '--story', e3.storyPath, '--repo', e3.repo, '--brief', '--no-autonomous',
    '--codex-session', '{"oss":true,"provider":"ollama","model":"m","config":["sandbox_mode=danger-full-access"]}'], { cwd: e3.repo, env: e3.env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(floja.status, 2);
  assert.match(floja.stderr, /sandbox/);

  // un proveedor sin `oss` frena: Codex lo ignoraría y correría con su proveedor por defecto
  const sinOss = spawnSync(process.execPath, [PIPELINE, 'start', '--story', e3.storyPath, '--repo', e3.repo, '--brief', '--no-autonomous',
    '--codex-session', '{"provider":"ollama","model":"m"}'], { cwd: e3.repo, env: e3.env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(sinOss.status, 2);
  assert.match(sinOss.stderr, /oss/);

  // la sesión de Codex es de la corrida: otra story en la misma sesión no la hereda
  const otra = path.join(e3.repo, 'specs', 'story-2.2.md');
  fs.writeFileSync(otra, ['---', 'epic: 2', 'story: "2.2"', 'title: "y"', 'status: ready-for-dev', '---', '# Story 2.2', ''].join('\n'));
  const setOtra = spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), 'set', JSON.stringify({ storyId: '2.2', storyPath: otra, repoPath: e3.repo,
    stepScheme: 2, stepsPending: ['validate-story', 'plan', 'approve-plan', 'implement'] }), '--replace'], { cwd: e3.repo, env: e3.env, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(setOtra.status, 0, setOtra.stderr);
  const m2 = JSON.parse(fs.readFileSync(path.join(e3.stateDir, 'active', `${SID}.json`), 'utf8'));
  assert.strictEqual(m2.codexSession, undefined, 'la story nueva heredó la sesión de Codex de la anterior');
});

test('ReviewersRun_WritesTheRunLine_CheckCountCountsIt @story-8.97 @ac-3', () => {
  const e = mkEnv({ snapshot: true });
  assert.strictEqual(runReviewers(e).status, 0);
  // la línea cae en el mismo archivo que lee check-count: la sesión de CODEX_SESSION_ID
  const lines = ledger(e).filter((l) => l.launcher === 'pipeline');
  assert.deepStrictEqual(lines.map((l) => l.advisor).sort(), [...e.advisors].sort());
  for (const l of lines) {
    assert.strictEqual(l.exit, 0);
    assert.ok(l.report && fs.existsSync(l.report));
    assert.strictEqual(l.story, '1.1');
  }
  const cc = checkCount(e);
  assert.strictEqual(cc.status, 0, cc.stderr);
  // la foto de la vuelta (o su rechazo, con su motivo) y el registro de revisores: lo mismo que deja el gancho
  assert.ok(ledger(e).some((l) => l.event === 'auto-snapshot'), 'sin el sello de la ronda');
  assert.ok(fs.existsSync(path.join(path.dirname(reportsDir(e)), 'review-roster.json')), 'sin el registro de revisores');

  // un reporte que existe pero está vacío no cuenta
  const e3 = mkEnv({ behavior: { 'tycon-silent-failure-hunter': { noReport: true } }, snapshot: true });
  assert.strictEqual(runReviewers(e3).status, 1);
  fs.writeFileSync(path.join(reportsDir(e3), 'tycon-silent-failure-hunter.md'), '');
  const cc3 = checkCount(e3);
  assert.notStrictEqual(cc3.status, 0);
  assert.match(cc3.stderr, /tycon-silent-failure-hunter.*sin reporte/);
  // el que no dejó reporte no entra al registro de autoría ni sella la ronda
  const roster3 = path.join(path.dirname(reportsDir(e3)), 'review-roster.json');
  assert.ok(!fs.existsSync(roster3) || !fs.readFileSync(roster3, 'utf8').includes('tycon-silent-failure-hunter'), 'el registro de autoría lista a un revisor sin reporte');
  assert.ok(!ledger(e3).some((l) => l.event === 'auto-snapshot'));

  // una línea escrita a mano sin su reporte no cuenta
  const e2 = mkEnv();
  for (const a of e2.advisors) fs.appendFileSync(e2.logPath, JSON.stringify({ ts: new Date().toISOString(), advisor: a, model: null, repo: e2.repo, story: '1.1', launcher: 'pipeline', exit: 0, report: path.join(e2.home, 'no-existe.md') }) + '\n');
  const cc2 = checkCount(e2);
  assert.notStrictEqual(cc2.status, 0);
  assert.match(cc2.stderr, /sin reporte/);
});

test('ReviewersRun_MissingCodexOrProfile_SaysWhichAndCountFailsClosed @story-8.97 @ac-10', () => {
  const sinCodex = mkEnv({ withCodex: false });
  const r1 = runReviewers(sinCodex);
  assert.strictEqual(r1.status, 2);
  assert.match(r1.stderr, /codex/);
  assert.strictEqual(fakeCalls(sinCodex).length, 0);
  assert.notStrictEqual(checkCount(sinCodex).status, 0);

  const sinPerfil = mkEnv({ missingProfile: ['tycon-spec-first-checker'] });
  const r2 = runReviewers(sinPerfil);
  assert.strictEqual(r2.status, 2);
  assert.match(r2.stderr, /tycon-spec-first-checker/);
  assert.strictEqual(fakeCalls(sinPerfil).length, 0, 'no lanza los demás a medias');
  assert.notStrictEqual(checkCount(sinPerfil).status, 0);

  const falla = mkEnv({ behavior: { 'tycon-silent-failure-hunter': { exit: 1 } } });
  const r3 = runReviewers(falla);
  assert.strictEqual(r3.status, 1);
  const cc = checkCount(falla);
  assert.notStrictEqual(cc.status, 0);
  assert.match(cc.stderr, /tycon-silent-failure-hunter/);
});

test('ReviewersRun_Timeout_CutsOneAndTheRestFinish @story-8.97 @ac-11', () => {
  const e = mkEnv({ behavior: { 'tycon-spec-first-checker': { hang: true } }, env: { TYCON_REVIEWER_TIMEOUT_MS: '2000' } });
  const r = runReviewers(e);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout + r.stderr, /tycon-spec-first-checker.*timeout|timeout.*tycon-spec-first-checker/s);
  const lines = ledger(e).filter((l) => l.launcher === 'pipeline');
  // el que se cortó queda en su propia línea, no como revisor corrido (no completa la ronda ni entra al registro de autoría)
  assert.strictEqual(lines.find((l) => l.failed_advisor === 'tycon-spec-first-checker').exit, 'timeout');
  assert.ok(!lines.some((l) => l.advisor === 'tycon-spec-first-checker'), 'el revisor cortado quedó anotado como corrido');
  assert.ok(!ledger(e).some((l) => l.event === 'auto-snapshot'), 'la ronda se selló con un revisor cortado');
  for (const a of ['tycon-plugin-security-basics', 'tycon-silent-failure-hunter']) assert.strictEqual(lines.find((l) => l.advisor === a).exit, 0);
  const cc = checkCount(e);
  assert.notStrictEqual(cc.status, 0);
  assert.match(cc.stderr, /tycon-spec-first-checker.*timeout/);

  // el codex de npm es un envoltorio: el tope corta también al binario que lanzó, y la corrida no se queda esperándolo
  const e2 = mkEnv({ behavior: { 'tycon-spec-first-checker': { wrapperHang: true } }, env: { TYCON_REVIEWER_TIMEOUT_MS: '2000' } });
  const t0 = Date.now();
  const r2 = runReviewers(e2);
  assert.strictEqual(r2.status, 1);
  assert.ok(Date.now() - t0 < 30000, `la corrida esperó al binario huérfano (${Date.now() - t0} ms)`);
  const nieto = fakeCalls(e2).find((c) => c.event === 'grandchild');
  assert.ok(nieto, 'el envoltorio de mentira no lanzó su binario');
  let vivo = true; try { process.kill(nieto.pid, 0); } catch { vivo = false; }
  if (vivo) { try { process.kill(nieto.pid, 'SIGKILL'); } catch { /* limpieza */ } }
  assert.ok(!vivo, 'el binario que lanzó el envoltorio quedó vivo después del tope');
});

test('ReviewersRun_Rerun_KillsLeftoversSkipsDone @story-8.97 @ac-4b', async () => {
  const e = mkEnv({ behavior: { 'tycon-spec-first-checker': { hang: true } } });
  const first = spawn(process.execPath, [PIPELINE, 'reviewers-run', '--repo', e.repo, '--story', e.storyPath], { cwd: e.repo, env: e.env, stdio: 'ignore' });
  // espera a que los dos rápidos terminen y el colgado esté vivo
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const done = ledger(e).filter((l) => l.launcher === 'pipeline').length;
    if (done >= 2) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  process.kill(first.pid, 'SIGKILL'); // una caída del lanzador: su hijo colgado queda vivo, huérfano
  const hung = fakeCalls(e).find((c) => c.event === 'start' && c.adv === 'tycon-spec-first-checker');
  assert.ok(hung, 'el revisor colgado no arrancó');
  let vivo = true; try { process.kill(hung.pid, 0); } catch { vivo = false; }
  assert.ok(vivo, 'el colgado tenía que seguir vivo tras cortar el lanzador');

  e.env.FAKE_CODEX_BEHAVIOR = '{}';
  const r = runReviewers(e);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  let sigue = true; try { process.kill(hung.pid, 0); } catch { sigue = false; }
  assert.ok(!sigue, 'el relanzado no cortó el proceso de la corrida anterior');
  const starts = fakeCalls(e).filter((c) => c.event === 'start');
  assert.strictEqual(starts.filter((c) => c.adv === 'tycon-plugin-security-basics').length, 1, 'relanzó uno ya hecho');
  assert.strictEqual(starts.filter((c) => c.adv === 'tycon-spec-first-checker').length, 2);
  assert.strictEqual(checkCount(e).status, 0);

  // un pid del registro que el sistema reusó para otro proceso no se corta
  const ajeno = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(path.dirname(reportsDir(e)), 'reviewers-run.pids.json'), JSON.stringify({ iter: 1, procs: { 'tycon-spec-first-checker': { pid: ajeno.pid } } }));
    assert.strictEqual(runReviewers(e).status, 0);
    let vive = true; try { process.kill(ajeno.pid, 0); } catch { vive = false; }
    assert.ok(vive, 'cortó un proceso que no era el revisor');
  } finally { ajeno.kill('SIGKILL'); }
});

test('ClaudeCode_StepUnchanged_NoDoubleLaunch @story-8.97 @ac-4 @ac-13', () => {
  const step = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-07-reviewers.md'), 'utf8');
  assert.match(step, /Agent\(subagent_type: "tycon-plugin-/, 'el paso dejó de lanzar con Agent(...) bajo Claude Code');
  // `reviewers-run` aparece sólo dentro de la sección de Codex
  const codex = step.match(/^### Bajo Codex[^\n]*\n([\s\S]*?)(?=^#{2,3} )/m);
  assert.ok(codex, 'falta la sección «Bajo Codex»');
  assert.match(codex[1], /pipeline\.js reviewers-run/);
  const fuera = step.replace(codex[0], '');
  assert.doesNotMatch(fuera, /reviewers-run/, 'reviewers-run aparece como instrucción fuera de la sección de Codex');
});

test('CodexProfiles_StillGenerated_NotHandEdited @story-8.97 @ac-14', () => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'build', 'generate.js'), '--check'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

// ── La red de los revisores: la caja de arena de Codex sin red no llega al modelo ──
// La marca la pone Codex en la terminal de una sesión con la caja de arena sin red (medido con codex-cli 0.162.1).

test('ReviewersRun_SinRed_NoLanza @story-8.108 @ac-5', () => {
  const e = mkEnv({ advisors: ['tycon-plugin-security-basics', 'tycon-spec-first-checker'], env: { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' } });
  const antes = ledger(e).length;
  const r = runReviewers(e);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.deepStrictEqual(fakeCalls(e), [], 'no tenía que lanzar ningún codex');
  assert.strictEqual(ledger(e).length, antes, 'no tenía que anotar ningún lanzamiento');
  assert.match(r.stderr, /caja de arena/);
  assert.match(r.stderr, /sin red/);
  assert.match(r.stderr, /fuera de la caja de arena/);
  assert.match(r.stderr, /aprob/);
  assert.match(r.stderr, /sandbox_workspace_write\.network_access/);
  assert.match(r.stderr, /todo comando/);
});

test('ReviewersRun_ConRed_LanzaComoHoy @story-8.108 @ac-5', () => {
  const e = mkEnv({ advisors: ['tycon-plugin-security-basics', 'tycon-spec-first-checker'], env: { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '' } });
  const r = runReviewers(e);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(fakeCalls(e).filter((c) => c.event === 'start').map((c) => c.adv).sort(), ['tycon-plugin-security-basics', 'tycon-spec-first-checker']);
});

test('ReviewersRun_OllamaInalcanzable_NombraLaCausa @story-8.108 @ac-6', () => {
  const ollama = 'Error: OSS setup failed: No running Ollama server detected. Start it with: `ollama serve` (after installing).\n';
  const e = mkEnv({ advisors: ['tycon-plugin-security-basics', 'tycon-spec-first-checker'],
    behavior: { 'tycon-plugin-security-basics': { exit: 1, noReport: true, stderr: ollama } } });
  const r = runReviewers(e);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const linea = r.stderr.split('\n').find((l) => l.includes('tycon-plugin-security-basics salió 1'));
  assert.ok(linea, r.stderr);
  assert.match(linea, /no llegó a Ollama/);
  assert.match(linea, /tycon-plugin-security-basics\.stderr\.log/);
  const otra = r.stderr.split('\n').find((l) => l.includes('tycon-spec-first-checker') && /no llegó a Ollama/.test(l));
  assert.strictEqual(otra, undefined, 'el revisor que anduvo no lleva la causa');
});
