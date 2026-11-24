'use strict';
/**
 * swallowed-errors.test.js — errores que se tragaban en silencio y dejaban pasar algo sin rastro.
 *
 * Lo que no se puede perder:
 *   - `marker.js set` de la misma historia no marca hechos pasos que no lo estaban: se cierran con `complete-step`.
 *   - Si `on-edit.js` no puede escribir el marcador, la edición deja su línea en hook-errors.log.
 *   - Un renglón de gates.log que no se escribe se dice; el de una firma (`<firma>-signed`) hace fallar el comando.
 *   - Si git no puede leer lo preparado para el commit, el gancho lo dice (fuera de un repo, nada).
 *   - Un marcador ajeno ilegible no es «no hay otra ejecución»: la lista lo informa.
 *   - Una lista `files: [a,` sin cerrar deja la parte inválida, con su razón.
 *   - Los renglones ilegibles del registro de lanzamientos de revisores se cuentan.
 *
 * 0 deps (node:test). Todo corre con una HOME de laboratorio y carpetas temporales.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const STATE_DIR_LIB = path.join(SCRIPTS, 'lib', 'state-dir.js');
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

const tmpDirs = [];
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `swallowed-${p}-`))); tmpDirs.push(d); return d; };
test.after(() => {
  for (const d of tmpDirs) { try { fs.chmodSync(path.join(d, 'active'), 0o755); } catch (_) { /* no estaba */ } fs.rmSync(d, { recursive: true, force: true }); }
});
const escribir = (base, rel, txt) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const NO_POSIX = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) ? 'permisos POSIX' : false;

function estadoDe(home) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(STATE_DIR_LIB)}).stateDir(process.env.HOME))`],
    { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Una HOME de laboratorio con su sesión y un marcador con `storyId`. */
function lab(sid = 's-tragados') {
  const home = tmp('home');
  const repo = tmp('repo');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  delete env.TYCON_HOME;
  const marker = (args, { ventana = false } = {}) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', env: ventana ? conVentana(env) : env, detached: true });
  return { home, repo, env, sid, marker, estado: estadoDe(home) };
}
const leerLineas = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── DEF-8.195: el marcador no acepta pasos hechos por set, ni pierde ediciones sin rastro ────────────────────────────

test('T1 MarkerSet_SameStoryNewDoneSteps_Discarded @def-8.195 — «Preparar el pull request» no se marca hecho con set', () => {
  const l = lab();
  const historia = escribir(l.repo, 'story.md', '---\nstory: "9.5"\n---\n');
  const base = { storyId: '9.5', storyPath: historia, repoPath: l.repo, stepScheme: 2, stepsCompleted: ['start'], stepsPending: ['plan', 'prepare-commit'] };
  assert.equal(l.marker(['set', JSON.stringify(base)]).status, 0);
  const r = l.marker(['set', JSON.stringify({ ...base, stepsCompleted: ['start', 'prepare-commit'] })]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /prepare-commit no se marca\(n\) hecho\(s\) con set/);
  const m = JSON.parse(l.marker(['get']).stdout);
  assert.deepStrictEqual(m.stepsCompleted, ['start'], JSON.stringify(m));
  assert.ok(leerLineas(path.join(l.estado, 'bypass.log')).some((x) => x.kind === 'MARKER_SET_STEPS_DISCARDED' && x.steps.includes('prepare-commit')));
  // los que ya estaban hechos pasan como estaban
  const igual = l.marker(['set', JSON.stringify(base)]);
  assert.doesNotMatch(igual.stderr, /no se marca/);
});

test('T2 OnEdit_MarkerNotWritable_LeavesItsLine @def-8.195 — la edición que no se anota en el marcador deja su línea', { skip: NO_POSIX }, () => {
  const l = lab('s-on-edit');
  const active = path.join(l.estado, 'active');
  escribir(active, 's-on-edit.json', JSON.stringify({ storyId: '9.6', sessionId: 's-on-edit', repoPath: l.repo, filesTouched: [] }));
  const archivo = escribir(l.repo, 'src/a.js', 'x\n');
  fs.chmodSync(active, 0o555);   // el marcador se lee pero no se puede reescribir
  let r;
  try {
    r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(SCRIPTS, 'on-edit.js'))}).handle(JSON.parse(process.argv[1]))`,
      JSON.stringify({ session_id: 's-on-edit', tool_name: 'Edit', tool_input: { file_path: archivo } })], { env: l.env, encoding: 'utf8' });
  } finally { fs.chmodSync(active, 0o755); }
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(l.estado, 'hook-errors.log'), 'utf8');
  assert.match(log, /on-edit FAILED OPEN: no pude anotar la edición de .*src\/a\.js en el marcador de s-on-edit/);
});

// ── DEF-8.143: el renglón de una firma no se pierde en silencio ──────────────────────────────────────────────────────

test('T3 AppendLog_Unwritable_SaysSo_AndSignatureFails @def-8.143 — un renglón perdido se dice; el de una firma frena', () => {
  const l = lab('s-firma');
  const historia = escribir(l.repo, 'story.md', '---\nstory: "9.7"\n---\n');
  assert.equal(l.marker(['set', JSON.stringify({ storyId: '9.7', storyPath: historia, repoPath: l.repo })]).status, 0);
  // bypass.log que no se puede escribir (una carpeta en su lugar): el set sigue y lo dice
  fs.mkdirSync(path.join(l.estado, 'bypass.log'));
  const set = l.marker(['set', JSON.stringify({ storyId: '9.7', cierre: 'ok' })]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stderr, /no pude escribir el renglón en bypass\.log \(EISDIR\): queda sin registrar/);
  // gates.log que no se puede escribir: la firma del dueño no queda registrada y el comando falla a la vista
  fs.rmSync(path.join(l.estado, 'gates.log'), { force: true });
  fs.mkdirSync(path.join(l.estado, 'gates.log'));
  const r = l.marker(['set-check', 'build', 'green', '--force-manual'], { ventana: true });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /no pude escribir el renglón de la firma escape:force-manual-signed en gates\.log \(EISDIR\): la firma no quedó registrada/);
  const m = JSON.parse(l.marker(['get']).stdout);
  assert.notEqual(m.checks && m.checks.build, 'green', 'sin el renglón de la firma, el control no se escribe');
});

// ── DEF-8.208: el gancho de commit no calla un git que no lee lo preparado ───────────────────────────────────────────

test('T4 PreCommit_StagedUnreadable_SaysSo @def-8.208 — un índice roto no es «nada preparado»; fuera de un repo, nada', () => {
  const repo = tmp('indice');
  // stable-data: un repo sin commits; sólo se rompe su índice
  assert.equal(spawnSync('git', ['-c', 'maintenance.auto=false', 'init', '-q'], { cwd: repo }).status, 0);
  fs.writeFileSync(path.join(repo, '.git', 'index'), 'esto no es un índice');
  const correr = (cwd) => spawnSync(process.execPath, ['-e',
    `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'on-pre-commit.js'))}).getStagedDiff(process.cwd())))`],
  { cwd, encoding: 'utf8', env: { ...process.env, HOME: tmp('home-pc') } });
  const r = correr(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), '');
  assert.match(r.stderr, /no pude leer lo preparado para el commit \(git diff --cached: .*\); los controles de este commit NO lo miraron/);
  const afuera = correr(tmp('sin-repo'));
  assert.doesNotMatch(afuera.stderr, /no pude leer lo preparado/);
});

// ── DEF-8.245: marcadores ajenos ilegibles y listas sin cerrar ───────────────────────────────────────────────────────

test('T5 OtherMarkers_Unreadable_Reported @def-8.245 — un marcador ajeno ilegible no es «no hay»', () => {
  const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
  const estado = tmp('estado');
  const active = path.join(estado, 'active');
  // stable-data: el marcador ajeno tiene que estar vivo, y la poda por viejo compara contra Date.now()
  escribir(active, 'otra.json', JSON.stringify({ storyId: 'L', sessionId: 'otra', stepsPending: ['plan'], lastTouch: new Date().toISOString() }));
  escribir(active, 'rota.json', '{ roto');
  fs.mkdirSync(path.join(active, 'carpeta.json'));
  const problems = [];
  assert.deepStrictEqual(io.listOtherMarkers(estado, 'yo', null, problems).map((m) => m.storyId), ['L']);
  assert.match(problems.join(' · '), /el marcador rota\.json \(no es JSON\)/);
  assert.match(problems.join(' · '), /el marcador carpeta\.json \(EISDIR\)/);
  // la carpeta de marcadores ilegible: un archivo en su lugar
  const otro = tmp('estado-roto');
  fs.writeFileSync(path.join(otro, 'active'), 'no es una carpeta');
  const p2 = [];
  assert.deepStrictEqual(io.listOtherMarkers(otro, 'yo', null, p2), []);
  assert.match(p2.join(' · '), /la carpeta de los marcadores \(ENOTDIR\)/);
  // sin carpeta: nada que decir
  const p3 = [];
  io.listOtherMarkers(tmp('vacio'), 'yo', null, p3);
  assert.deepStrictEqual(p3, []);
});

test('T6 PipelinesBlock_InlineListNotClosed_PartInvalid @def-8.245 — `files: [a.js,` sin cerrar no da una parte válida con menos archivos', () => {
  const sc = require(path.join(SCRIPTS, 'lib', 'story-checks.js'));
  const bs = require(path.join(SCRIPTS, 'lib', 'batch-scope.js'));
  const historia = (files) => ['---', 'story: "9.8"', 'files_to_modify:', '  - a.js', '  - b.js', 'pipelines:', '  - name: A', '    status: pending',
    `    files: ${files}`, '---', ''].join('\n');
  const rota = historia('[a.js,');
  assert.deepStrictEqual(sc.parsePipelinesBlock(rota)[0].problemas, ['files: la lista abre «[» y no cierra en el mismo renglón']);
  const v = bs.validarParte(rota, 'A');
  assert.equal(v.valid, false, JSON.stringify(v));
  assert.match(v.reason, /la parte A no se puede leer entera \(files: la lista abre «\[» y no cierra/);
  // cerrada: válida, como siempre
  const sana = bs.validarParte(historia('[a.js, b.js]'), 'A');
  assert.equal(sana.valid, true, JSON.stringify(sana));
  assert.equal(sc.parsePipelinesBlock(historia('[a.js, b.js]'))[0].problemas, undefined);
});

// ── DEF-8.83: los lanzamientos ilegibles se cuentan ──────────────────────────────────────────────────────────────────

test('T7 SpawnsOf_UnreadableLines_Counted @def-8.83 — un renglón roto del registro de lanzamientos se cuenta, no se saltea', () => {
  const rc = require(path.join(SCRIPTS, 'lib', 'reported-criticals.js'));
  const estado = tmp('lanzamientos');
  escribir(estado, 'advisor-runs/s-1.jsonl', [
    JSON.stringify({ event: 'step5-start', expected: ['revisor-a'] }),
    JSON.stringify({ advisor: 'revisor-a', story: '9.9', ts: '2026-11-20T10:00:00Z' }),
    '{ "advisor": "revisor-a", roto',
    '',
  ].join('\n'));
  const r = rc.spawnsOf(estado, { story: '9.9' });
  assert.deepStrictEqual(r.spawns.map((s) => s.advisor), ['revisor-a']);
  assert.equal(r.unreadable, 1);
});
