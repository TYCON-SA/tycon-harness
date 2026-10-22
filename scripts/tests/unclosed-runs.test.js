'use strict';
// unclosed-runs.test.js — a pipeline run whose marker vanished without its close still reaches the mailbox, marked
// «sin cerrar», built only from what its run dir and this machine's gates.log hold. Homes, sessions, repos and logs are
// toys in temporary folders; no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const U = require(path.join(ROOT, 'scripts', 'metrics', 'unclosed-runs.js'));
const NOTICE = path.join(ROOT, 'scripts', 'hooks', 'unclosed-runs-notice.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const H = 3600 * 1000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ID = ['-c', 'user.name=t', '-c', `user.email=t${'@'}acme.example`, '-c', 'maintenance.auto=false'];
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

// A toy machine: a home with its sessions folder and its harness state folder.
const { stateDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
function machine() {
  const home = tmp('ucr-home-');
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'timing-history'), { recursive: true });
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  return { home, state, projects: path.join(home, '.claude', 'projects') };
}
// A repo with one commit; `ignored` puts .advisors/pipeline-runs/ in its .gitignore, as some products do.
function repo(m, name, { ignored = false } = {}) {
  const dir = path.join(tmp('ucr-repos-'), name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), ignored ? '.advisors/pipeline-runs/\n' : 'node_modules/\n');
  execFileSync('git', ['-C', dir, ...ID, 'add', '-A']);
  execFileSync('git', ['-C', dir, ...ID, 'commit', '-qm', 'x'], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' } });
  return dir;
}
// A session of this person whose cwd is the repo. The session folder gets a name that does not look like a temporary
// one (the reader skips those by name before opening them); the cwd inside is the real one.
function session(m, cwd, sid) {
  const d = path.join(m.projects, `-Users-toy-${sid}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', cwd, sessionId: sid })}\n`);
}
// A run dir `<key>-<UTC stamp>` started `hoursAgo` before NOW, with optional files; `commit` adds it to git.
function runDir(r, key, hoursAgo, files = {}, { commit = false } = {}) {
  const name = `${key}-${stamp(NOW - hoursAgo * H)}`;
  const dir = path.join(r, '.advisors', 'pipeline-runs', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
  if (!Object.keys(files).length) fs.writeFileSync(path.join(dir, 'approvals.jsonl'), '');
  if (commit) {
    execFileSync('git', ['-C', r, ...ID, 'add', '-f', '.advisors']);
    execFileSync('git', ['-C', r, ...ID, 'commit', '-qm', 'run'], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-02T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-02T00:00:00Z' } });
  }
  return name;
}
function gate(m, r, key, sid, hoursAgo, extra = {}) {
  fs.appendFileSync(path.join(m.state, 'gates.log'), `${JSON.stringify({ ts: new Date(NOW - hoursAgo * H).toISOString(), sessionId: sid, repoPath: r, storyPath: path.join(r, 'specs', `story-${key}-algo.md`), check: 'build', status: 'green', ...extra })}\n`);
}
// the toy repos live in the system temp folder, which the session reader leaves out: a different «temp» for the tests
const opts = (m) => ({ home: m.home, stateDir: m.state, projectsDir: m.projects, now: NOW, tmp: path.join(m.home, 'otra-temporal') });
const envOf = (m, extra = {}) => ({ ...process.env, HOME: m.home, USERPROFILE: m.home, TMPDIR: path.join(m.home, 'otra-temporal'), TEMP: path.join(m.home, 'otra-temporal'), TMP: path.join(m.home, 'otra-temporal'), TYCON_UNCLOSED_NOW: new Date(NOW).toISOString(), ...extra });

test('T1 Encuentra_SoloLasSinCerrar @story-2.67 @ac-1: sólo las de esta máquina, sin cierre, sin marcador vivo y de más de 24 h', () => {
  const m = machine();
  const ign = repo(m, 'ignora', { ignored: true });
  const com = repo(m, 'commitea');
  session(m, ign, 's-1'); session(m, com, 's-2');
  const a = runDir(ign, '5.1', 48);                              // ignored by git, no gates: this machine's
  const b = runDir(com, '5.2', 30, {}, { commit: true }); gate(m, com, '5.2', 's-2', 29);   // committed, with gates
  runDir(com, '5.3', 30, {}, { commit: true });                 // committed, no gates: came by merge
  const d = runDir(ign, '5.4', 40);                             // has a close
  fs.writeFileSync(path.join(m.state, 'timing-history', '5.4-x.json'), JSON.stringify({ archivedAt: 'x', marker: { storyId: '5.4', startedAt: new Date(NOW - 40 * H + 60000).toISOString() } }));
  runDir(ign, '5.5', 30);                                       // live marker
  fs.writeFileSync(path.join(m.state, 'active', 's-9.json'), JSON.stringify({ sessionId: 's-9', storyId: '5.5', repoPath: ign }));
  runDir(ign, '5.6', 2);                                        // too young
  const r = U.findUnclosed(opts(m));
  assert.deepStrictEqual(r.runs.map((x) => x.name).sort(), [a, b].sort(), JSON.stringify(r));
  assert.ok(d);
  // what cannot be read is never «absent»: an unreadable close keeps its story undecided, an unreadable marker stops
  // everything, a bad date is not a date; each one is said
  fs.writeFileSync(path.join(m.state, 'timing-history', '5.1-roto.json'), '{ esto no es json');
  const r2 = U.findUnclosed(opts(m));
  assert.ok(!r2.runs.some((x) => x.key === '5.1'), 'con un cierre ilegible de la 5.1, no se toma');
  assert.ok(r2.problems.some((p) => /cierre ilegible.*5\.1/.test(p)), r2.problems.join('\n'));
  fs.writeFileSync(path.join(m.state, 'active', 'roto.json'), '{ roto');
  const r3 = U.findUnclosed(opts(m));
  assert.deepStrictEqual(r3.runs, []);
  assert.ok(r3.problems.some((p) => /marcador ilegible/.test(p)), r3.problems.join('\n'));
  fs.mkdirSync(path.join(ign, '.advisors', 'pipeline-runs', '5.7-20261332000000'));
  fs.rmSync(path.join(m.state, 'active', 'roto.json'));
  assert.ok(!U.findUnclosed(opts(m)).runs.some((x) => x.key === '5.7'), 'el mes 13 no es una fecha');
});

test('T2 Volcado_NoInventa @story-2.67 @ac-2: trae lo del run dir y del gates.log; lo que falta, «no medido» con motivo', () => {
  const m = machine();
  const r = repo(m, 'x', { ignored: true });
  session(m, r, 's-1');
  const findings = [{ rule_id: 'TEST-W4', severity: 'WARNING', disposition: 'fixed' }];
  const name = runDir(r, '5.1', 48, { 'findings.json': findings });
  gate(m, r, '5.1', 's-77', 47);
  const [run] = U.findUnclosed(opts(m)).runs;
  const d = U.buildDump(run);
  assert.strictEqual(d.sinCerrar, true);
  assert.strictEqual(d.marker.storyId, '5.1');
  assert.strictEqual(d.marker.sessionId, 's-77');
  assert.strictEqual(d.marker.startedAt, new Date(NOW - 48 * H).toISOString().replace(/\.\d{3}Z$/, '.000Z'));
  assert.deepStrictEqual(d.hallazgos, findings);
  assert.strictEqual(d.gates.length, 1);
  for (const k of ['pasos', 'consumo', 'costo', 'revisores']) {
    assert.strictEqual(d.no_medido[k] && typeof d.no_medido[k], 'string', k);
  }
  assert.ok(!('stepTimings' in d.marker), 'sin pasos inventados');
  // without gates: its own id, said as such
  const n = machine();
  const r2 = repo(n, 'y', { ignored: true });
  session(n, r2, 's-1');
  runDir(r2, '5.2', 48);
  const d2 = U.buildDump(U.findUnclosed(opts(n)).runs[0]);
  assert.match(d2.marker.sessionId, /^sin-cerrar-[0-9a-f]{12}$/);
  assert.match(d2.no_medido.sesion, /gates\.log/);
  assert.match(d2.no_medido.gates, /gates\.log/, 'sin renglones: «no medido» con motivo, no una lista vacía muda');
  // only the closed list of fields leaves the machine: no free text from the run dir
  const p = machine();
  const r3 = repo(p, 'z', { ignored: true });
  session(p, r3, 's-1');
  runDir(r3, '5.3', 48, {
    'findings.json': [{ rule_id: 'SEC-W8', severity: 'WARNING', disposition: 'fixed', reason: 'texto libre que no sale' }],
    'approvals.jsonl': `${JSON.stringify({ quote: 'Firmo el plan', by: 'una persona' })}\n`,
    'review-roster.json': { reviewers: [{ agent: 'tycon-story-validator', model: 'haiku' }] },
  });
  gate(p, r3, '5.3', 's-1', 47, { reason: 'otro texto libre' });
  gate(p, r3, '5.3', 's-otra', 46);
  const d3 = U.buildDump(U.findUnclosed(opts(p)).runs[0]);
  assert.deepStrictEqual(d3.hallazgos, [{ rule_id: 'SEC-W8', severity: 'WARNING', disposition: 'fixed' }]);
  assert.strictEqual(d3.aprobaciones, 1, 'sólo cuántas, sin las citas');
  assert.deepStrictEqual(d3.revisores, ['tycon-story-validator']);
  assert.ok(d3.gates.every((g) => g.sessionId === d3.marker.sessionId && !('reason' in g)), JSON.stringify(d3.gates));
  assert.ok(name);
});

test('T3 Volcado_UnaVez @story-2.67 @ac-2 @ac-3: un segundo pase no duplica', () => {
  const m = machine();
  const r = repo(m, 'x', { ignored: true });
  session(m, r, 's-1');
  runDir(r, '5.1', 48);
  const dest = path.join(m.state, 'timing-history');
  const first = U.materialize({ ...opts(m), dest });
  assert.strictEqual(first.written.length, 1);
  assert.match(path.basename(first.written[0]), /^5\.1-\d{14}-sin-cerrar\.json$/);
  const second = U.materialize({ ...opts(m), dest });
  assert.strictEqual(second.written.length, 0);
  // and its own volcado no longer counts as «without a close» for the finder
  assert.strictEqual(U.findUnclosed(opts(m)).runs.length, 0);
});

test('T4 Upload_LasCuenta @story-2.67 @ac-3: upload-runs deja los volcados antes de contar lo que sube', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js'), 'utf8');
  const sub = src.slice(src.indexOf('async function subir('));
  const llama = sub.indexOf('prepararSinCerrar(');
  assert.ok(llama > 0, 'subir llama a prepararSinCerrar');
  assert.ok(llama < sub.indexOf('res.a_subir = pendientes.length'), 'antes de contar');
  const UP = require(path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js'));
  const m = machine();
  const r = repo(m, 'x', { ignored: true });
  session(m, r, 's-1');
  runDir(r, '5.1', 48);
  const dest = path.join(m.state, 'timing-history');
  const out = UP.prepararSinCerrar({ ...opts(m), origen: dest, log: () => {} });
  assert.strictEqual(out.written.length, 1);
  assert.ok(fs.readdirSync(dest).some((f) => /-sin-cerrar\.json$/.test(f)));
});

test('T5 Vista_DiceSinCerrar @story-2.67 @ac-4: la vista de ejecuciones marca «sin cerrar» en la fila y en el detalle', () => {
  // the real view, over a folder with one «sin cerrar» volcado built by the collector
  const m = machine();
  const r = repo(m, 'x', { ignored: true });
  session(m, r, 's-1');
  runDir(r, '5.1', 48);
  gate(m, r, '5.1', 's-77', 47);
  const runs = tmp('ucr-runs-');
  U.materialize({ ...opts(m), dest: runs });
  const V = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'runs.js'));
  const M = V.modelo(runs, { sinHilos: true });
  assert.strictEqual(M.corridas.length, 1, JSON.stringify(M).slice(0, 400));
  assert.strictEqual(M.corridas[0].sin_cerrar, true);
  const html = V.render(M);
  assert.match(html, /<span class="parcial"[^>]*>sin cerrar<\/span>/, 'la fila');
  // el detalle lo arma el navegador con los textos que la página le pasa: la pieza y su texto
  assert.match(html, /◆<\/span>' \+ T\('sinCerrar'\)/, 'el detalle');
  assert.match(html, /"sinCerrar":"sin cerrar"/, 'el texto del detalle');
});

test('T6 Aviso_UnaVezPorDia @story-2.67 @ac-5: un renglón al arrancar; después calla; apagado calla', () => {
  const m = machine();
  const r = repo(m, 'x', { ignored: true });
  session(m, r, 's-1');
  runDir(r, '5.1', 48);
  fs.mkdirSync(path.join(m.home, 'otra-temporal'), { recursive: true });
  const env = envOf(m);
  const run = (e) => spawnSync(process.execPath, [NOTICE], { env: e, encoding: 'utf8', input: '{}' });
  const first = run(env);
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /1 ejecución\(es\) del pipeline quedaron sin cerrar.*5\.1/);
  assert.match(first.stdout, /se suben al buzón marcadas «sin cerrar»/);
  assert.strictEqual(run(env).stdout.trim(), '', 'el mismo día calla');
  const off = machine();
  const r2 = repo(off, 'x', { ignored: true });
  session(off, r2, 's-1');
  runDir(r2, '5.1', 48);
  fs.mkdirSync(path.join(off.home, 'otra-temporal'), { recursive: true });
  assert.strictEqual(run(envOf(off, { TYCON_UNCLOSED_NOTICE: '0' })).stdout.trim(), '');
});

test('T7 Aviso_SinNadaCalla @story-2.67 @ac-5: sin ejecuciones sin cerrar no dice nada', () => {
  const m = machine();
  const r = repo(m, 'x', { ignored: true });
  session(m, r, 's-1');
  fs.mkdirSync(path.join(m.home, 'otra-temporal'), { recursive: true });
  const out = spawnSync(process.execPath, [NOTICE], { env: envOf(m), encoding: 'utf8', input: '{}' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.stdout.trim(), '');
  // with something it could not read, it says so instead of keeping quiet
  fs.writeFileSync(path.join(m.state, 'active', 'roto.json'), '{ roto');
  const partial = spawnSync(process.execPath, [NOTICE], { env: envOf(m, { TYCON_UNCLOSED_NOW: new Date(NOW + 30 * H).toISOString() }), encoding: 'utf8', input: '{}' });
  assert.match(partial.stdout, /No pude mirar del todo.*marcador ilegible/);
});

test('T8 Encuentra_ConMayusculasYUnidad @story-2.67 @ac-6: rutas de Windows se comparan sin distinguir mayúsculas', () => {
  assert.strictEqual(U.sameRepo('D:\\Repos\\Acme\\Plugin', 'd:\\repos\\acme\\plugin', 'win32'), true);
  assert.strictEqual(U.sameRepo('/Repos/Acme', '/repos/acme', 'linux'), false);
  assert.strictEqual(U.sameRepo('D:\\Repos\\Acme\\', 'D:\\Repos\\Acme', 'win32'), true);
});
