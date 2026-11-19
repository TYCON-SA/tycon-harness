'use strict';
/**
 * result-travel.test.js — los resultados de la noche viajan por la rama `night-results` sin tocar el clon, y un fallo se
 * ve al arrancar.
 *
 * Remotos desnudos y clones de juguete en carpetas temporales, con una casa propia: nada de la HOME de quien corre la
 * suite, ni un remoto de verdad. El examen corre con su corredor falso (`TYCON_EXAM_RUNNER`) y la revisión semanal con su
 * agente falso (`TYCON_WEEKLY_REVIEW_AGENT`): ningún caso gasta una consulta al modelo.
 *
 * Correr: node --test scripts/tests/result-travel.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RT_PATH = path.join(ROOT, 'scripts', 'lib', 'result-travel.js');
const EXAM = path.join(ROOT, 'scripts', 'controls-bench', 'periodic-exam.js');
const NOTICE = path.join(ROOT, 'scripts', 'hooks', 'bench-notice.js');
const REVIEW = path.join(ROOT, 'scripts', 'nightly', 'weekly-review', 'weekly-review.js');
const PRE_PUSH = path.join(ROOT, 'scripts', 'hooks', 'git-pre-push-global.sh');
const { HEARTBEAT } = require(path.join(ROOT, 'scripts', 'lib', 'retro-coverage.js'));

const DIRS = [];
test.after(() => { for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'result-travel-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); DIRS.push(d); return d; };

// La casa de la suite: temporal y nunca la de la persona. Si coincidiera con la HOME real, la suite no arranca.
const REAL_HOME = os.userInfo().homedir;
const SUITE_HOME = tmp('result-travel-casa-');
if (path.resolve(SUITE_HOME) === path.resolve(REAL_HOME)) throw new Error('result-travel.test.js: la casa de la suite es la HOME real; no arranco');
process.env.HOME = SUITE_HOME;
delete process.env.TYCON_HOME;
// El git de quien corre la suite (ganchos globales, firmas) no decide nada: config global vacía y propia.
const GITCFG = path.join(SUITE_HOME, 'gitconfig');
fs.writeFileSync(GITCFG, '');
process.env.GIT_CONFIG_GLOBAL = GITCFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
// los commits de la suite salen siempre iguales: fecha fija (las semanas de prueba fijan la suya) y sin el mantenimiento
// automático de git
process.env.GIT_AUTHOR_DATE = '2026-11-18T00:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-11-18T00:00:00Z';

const RT = require(RT_PATH);
const EXAM_REL = 'scripts/controls-bench/ultimo-examen.json';
const GUIDES_REL = 'scripts/controls-bench/ultimo-guias.json';
const REPORT_REL = '.dashboard/weekly-review/latest.json';
const LIST_REL = 'guides/guide-update-proposals.md';
const HOUR = 3600 * 1000;

function git(dir, args, extra = {}) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...extra } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

/** Un mundo: remoto desnudo con `main`, un clon de mantenimiento y una casa propia. */
function world(opts = {}) {
  const raiz = tmp();
  const casa = path.join(raiz, 'casa');
  fs.mkdirSync(path.join(casa, '.claude', '.tycon-pipeline'), { recursive: true });
  assert.notStrictEqual(path.resolve(casa), path.resolve(REAL_HOME), 'la casa del caso nunca es la real');
  const remote = path.join(raiz, 'remoto.git');
  const clone = path.join(raiz, 'clon');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, ['config', 'user.email', 'lab@example.com']);
  git(clone, ['config', 'user.name', 'Lab']);
  write(clone, 'README.md', 'repo de juguete\n');
  write(clone, '.gitignore', 'scripts/controls-bench/.bench/\n');
  write(clone, LIST_REL, '# Guide Update Proposals\n\nPropuestas.\n\n---\n');
  for (const [rel, body] of Object.entries(opts.files || {})) write(clone, rel, body);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'base']);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-q', '-u', 'origin', 'main']);
  return { raiz, casa, remote, clone };
}
/** Lo que hay en `night-results` del remoto: las carpetas de entrada y los archivos de cada una. */
function branch(w) {
  const r = spawnSync('git', ['-C', w.remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${RT.BRANCH}`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const files = git(w.remote, ['ls-tree', '-r', '--name-only', RT.BRANCH]).split('\n').filter(Boolean);
  const ids = [...new Set(files.map((f) => f.split('/')[1]))].sort();
  return { tip: r.stdout.trim(), files, ids, show: (rel) => git(w.remote, ['show', `${RT.BRANCH}:${rel}`]) };
}
/** La foto del clon: HEAD, índice, estado y worktrees. Una publicación la deja idéntica. */
function snapshot(dir) {
  return {
    head: git(dir, ['rev-parse', 'HEAD']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    index: git(dir, ['ls-files', '--stage']),
    status: git(dir, ['status', '--porcelain', '--untracked-files=all']),
    worktrees: git(dir, ['worktree', 'list', '--porcelain']),
    commits: git(dir, ['rev-list', '--all', '--count']),
  };
}
const examReport = (ts, extra = {}) => ({ kind: 'examen-periodico', estado: 'completo', alcance: 'completo', ts, inicio: ts, fin: ts,
  criterio: 0, inestables: null, paridadReal: null, baselineRegressions: 0, maquina: 'mini', tool: 'claude', runs: 1, ...extra });
/** Publica un examen con fecha `ts` desde la casa del mundo. */
function publishExam(w, ts, extra = {}) {
  const kept = RT.keptPath('exam', EXAM_REL, w.casa);
  write(path.dirname(kept), path.basename(kept), json(examReport(ts, extra)));
  return RT.publish({ repo: w.clone, piece: 'exam', files: [{ path: EXAM_REL, mode: 'replace', source: kept }],
    message: `chore(examen): resultado ${ts.slice(0, 10)}`, home: w.casa, log: () => {} });
}
/** Un gancho pre-receive en el remoto. */
function hook(w, body) {
  const h = path.join(w.remote, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(h), { recursive: true });
  fs.writeFileSync(h, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(h, 0o755);
}
const tempLeft = (w) => { try { return fs.readdirSync(path.join(RT.rootDir(w.casa), 'tmp')); } catch (_) { return []; } };

/** El aviso de arranque, desde otra carpeta y sin el `.bench` del arnés salvo que se pida. */
function notice(w, extra = {}) {
  const cfg = path.join(w.raiz, 'exam-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ designated_machine: 'Devas-Mac-mini', days_between_runs: 3, scheduled_days: ['tuesday', 'friday'], hour: '02:00' }));
  const env = { ...process.env, HOME: w.casa, TYCON_EXAM_CONFIG: cfg, TYCON_EXAM_REPO: w.clone, TYCON_EXAM_MACHINE: 'Devas-Mac-mini',
    TYCON_BENCH_DIR: path.join(w.raiz, 'no-hay-bench'), TYCON_EVAL_SANDBOX: '', ...extra };
  delete env.TYCON_HOME;
  delete env.TYCON_EXAM_REPORT;
  const r = spawnSync(process.execPath, [NOTICE], { cwd: tmp('otra-carpeta-'), encoding: 'utf8', input: '{"source":"startup"}', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, lines: `${r.stdout}`.split('\n') };
}
const travelLines = (n) => n.lines.filter((l) => /resultados de la noche/.test(l));

// Cada caso arma su mundo y no comparte nada con los demás: corren de a cuatro, así la suite entra en el límite de la
// validación de cada pedido. El único que necesita otra configuración de git (T31) la usa en un proceso propio.
test.describe('story 8.312: los resultados de la noche', { concurrency: 4 }, () => {

// ── A: publicar sin tocar el clon ─────────────────────────────────────────────────────────────────────────────────

test('T1 Publish_DirtyClone_ReachesResultsBranchCloneIntact @story-8.312 @ac-1', () => {
  const w = world();
  write(w.clone, 'README.md', 'editado por la persona\n');
  write(w.clone, 'preparado.txt', 'en el índice\n');
  git(w.clone, ['add', '--', 'preparado.txt']);
  write(w.clone, 'nuevo.txt', 'sin seguimiento\n');
  const antes = snapshot(w.clone);
  const r = publishExam(w, new Date().toISOString());
  assert.strictEqual(r.ok, true, r.motivo);
  const b = branch(w);
  assert.ok(b && b.ids.length === 1, 'una entrada nueva en night-results');
  assert.ok(b.files.some((f) => f.endsWith(`files/${EXAM_REL}`)), 'con el reporte del examen');
  const despues = snapshot(w.clone);
  assert.deepStrictEqual({ ...despues, commits: undefined }, { ...antes, commits: undefined }, 'HEAD, índice, estado y worktrees iguales');
});

test('T2 Publish_OtherBranchOrDiverged_OnlyResultsBranchMoves @story-8.312 @ac-2', () => {
  const w = world();
  const mainAntes = git(w.remote, ['rev-parse', 'main']);
  git(w.clone, ['checkout', '-q', '-b', 'trabajo']);
  write(w.clone, 'propio.txt', 'commit propio\n');
  git(w.clone, ['add', '-A']);
  git(w.clone, ['commit', '-q', '-m', 'propio']);
  const antes = snapshot(w.clone);
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  // aparte: el clon atrasado respecto de main
  const otro = path.join(w.raiz, 'otro');
  execFileSync('git', ['clone', '-q', w.remote, otro]);
  git(otro, ['config', 'user.email', 'lab@example.com']); git(otro, ['config', 'user.name', 'Lab']);
  write(otro, 'avance.txt', 'main avanza\n'); git(otro, ['add', '-A']); git(otro, ['commit', '-q', '-m', 'avance']); git(otro, ['push', '-q', 'origin', 'main']);
  const mainNuevo = git(w.remote, ['rev-parse', 'main']);
  assert.strictEqual(publishExam(w, new Date(Date.now() + 1000).toISOString()).ok, true);
  assert.strictEqual(git(w.remote, ['rev-parse', 'main']), mainNuevo, 'main del remoto no se mueve');
  assert.notStrictEqual(mainNuevo, mainAntes);
  assert.strictEqual(spawnSync('git', ['-C', w.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/trabajo']).status, 1, 'la rama del clon no se empuja');
  assert.strictEqual(branch(w).ids.length, 2);
  const despues = snapshot(w.clone);
  assert.strictEqual(despues.head, antes.head, 'el clon no suma commits');
  assert.strictEqual(despues.branch, 'trabajo');
  assert.strictEqual(despues.status, antes.status);
});

test('T3 Publish_BranchMoved_RetriesKeepsBothEntries @story-8.312 @ac-3', () => {
  const w = world();
  assert.strictEqual(publishExam(w, '2026-11-17T05:10:00.000Z').ok, true);
  // otra entrada lista en el remoto, encima de la punta, que el gancho pone en la rama justo cuando llega el primer empuje
  const otra = path.join(w.raiz, 'otra');
  execFileSync('git', ['clone', '-q', '-b', RT.BRANCH, w.remote, otra]);
  git(otra, ['config', 'user.email', 'lab@example.com']); git(otra, ['config', 'user.name', 'Lab']);
  write(otra, 'runs/20261118T000000000Z-guides-aaaaaa/entry.json', json({ schema: 1, id: '20261118T000000000Z-guides-aaaaaa', piece: 'guides', ts: '2026-11-18T00:00:00.000Z', files: [] }));
  git(otra, ['add', '-A']); git(otra, ['commit', '-q', '-m', 'otra']); git(otra, ['push', '-q', 'origin', `HEAD:refs/heads/otra`]);
  const marca = path.join(w.raiz, 'ya-rechace');
  // git no deja mover referencias desde la cuarentena de un pre-receive: el gancho la deja de lado para mover la rama
  hook(w, `if [ ! -f "${marca}" ]; then touch "${marca}"; env -u GIT_QUARANTINE_PATH git update-ref refs/heads/${RT.BRANCH} refs/heads/otra; echo "la rama se movio" >&2; exit 1; fi\nexit 0`);
  const logs = [];
  const r = RT.publish({ repo: w.clone, piece: 'exam', files: [{ path: EXAM_REL, mode: 'replace', text: json(examReport('2026-11-20T05:10:00.000Z')) }],
    message: 'chore(examen): segundo', home: w.casa, log: (m) => logs.push(m) });
  assert.strictEqual(r.ok, true, r.motivo);
  assert.match(logs.join('\n'), /intento 2/, 'publicó en el segundo intento');
  assert.strictEqual(branch(w).ids.length, 3, 'las dos entradas anteriores y la nueva: nada se pisó');
  assert.ok(branch(w).ids.includes('20261118T000000000Z-guides-aaaaaa'));
});

test('T5 Publish_AnyEnding_LeavesNoTempFiles @story-8.312 @ac-5', () => {
  const w = world();
  const wtAntes = git(w.clone, ['worktree', 'list', '--porcelain']);
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  assert.deepStrictEqual(tempLeft(w), [], 'éxito: sin temporales');
  hook(w, 'echo rechazado >&2\nexit 1');
  assert.strictEqual(publishExam(w, new Date(Date.now() + 1000).toISOString()).ok, false);
  assert.deepStrictEqual(tempLeft(w), [], 'empuje rechazado: sin temporales');
  const r = RT.publish({ repo: w.clone, piece: 'exam', files: [{ path: EXAM_REL, mode: 'replace', source: path.join(w.raiz, 'no-existe.json') }],
    message: 'x', home: w.casa, log: () => {} });
  assert.strictEqual(r.ok, false, 'un error al armar la entrada es un fallo');
  assert.deepStrictEqual(tempLeft(w), [], 'error al armar: sin temporales');
  assert.strictEqual(git(w.clone, ['worktree', 'list', '--porcelain']), wtAntes, 'worktree list igual en los tres');
});

test('T6 Publish_LeftoverTemp_CleanedNextRun @story-8.312 @ac-5', () => {
  const w = world();
  const dir = path.join(RT.rootDir(w.casa), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2147483646-abandonado.index'), 'de una corrida cortada');
  fs.writeFileSync(path.join(dir, `${process.pid}-vivo.index`), 'de un proceso vivo');
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  const quedan = tempLeft(w);
  assert.ok(!quedan.includes('2147483646-abandonado.index'), 'el de un proceso muerto se borra');
  assert.ok(quedan.includes(`${process.pid}-vivo.index`), 'el de un proceso vivo no se toca');
});

test('T17 Publish_ForeignWorktree_Stays @story-8.312 @ac-5', () => {
  const w = world();
  const ajeno = path.join(w.raiz, 'worktree-ajeno');
  git(w.clone, ['worktree', 'add', '-q', '--detach', ajeno]);
  fs.rmSync(ajeno, { recursive: true, force: true });
  const antes = git(w.clone, ['worktree', 'list', '--porcelain']);
  assert.ok(antes.includes(ajeno) || antes.includes(fs.realpathSync(w.raiz)), 'el worktree ajeno está registrado');
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  assert.strictEqual(git(w.clone, ['worktree', 'list', '--porcelain']), antes, 'sigue en worktree list: nunca se poda lo ajeno');
});

test('T7 Publish_SameAsMain_NoEntryNoPush @story-8.312 @ac-6', () => {
  const igual = json({ kind: 'casos-de-guia', ts: '2026-11-17T05:15:14.121Z', guias: [] });
  const w = world({ files: { [GUIDES_REL]: igual } });
  const r = RT.publish({ repo: w.clone, piece: 'guides', files: [{ path: GUIDES_REL, mode: 'replace', text: igual }], message: 'x', home: w.casa, log: () => {} });
  assert.strictEqual(r.ok, true, r.motivo);
  assert.strictEqual(branch(w), null, 'sin entrada ni empuje');
  const r2 = RT.publish({ repo: w.clone, piece: 'weekly', message: 'x', home: w.casa, log: () => {},
    files: [{ path: REPORT_REL, mode: 'replace', text: json({ schema: 1, hecho: new Date().toISOString(), estado: 'hecho' }) }, { path: LIST_REL, mode: 'append', text: '' }] });
  assert.strictEqual(r2.ok, true, r2.motivo);
  const b = branch(w);
  assert.ok(b.files.some((f) => f.endsWith(`files/${REPORT_REL}`)), 'la revisión sin secciones deja el informe');
  assert.ok(!b.files.some((f) => f.endsWith(`files/${LIST_REL}`)), 'y no lleva la lista');
  assert.strictEqual(RT.readStatus(w.casa).pieces.guides.ok, true, 'lo igual cuenta como publicado');
});

test('T8 Publish_OnlyThePieceFiles @story-8.312 @ac-7', () => {
  const w = world();
  write(w.clone, 'otro.txt', 'cambio ajeno\n');
  write(w.clone, EXAM_REL, '{"no":"es el resultado"}\n');
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  const b = branch(w);
  const id = b.ids[0];
  assert.deepStrictEqual(b.files.sort(), [`runs/${id}/entry.json`, `runs/${id}/files/${EXAM_REL}`].sort());
  const entry = JSON.parse(b.show(`runs/${id}/entry.json`));
  assert.strictEqual(entry.piece, 'exam');
  assert.deepStrictEqual(entry.files, [{ path: EXAM_REL, mode: 'replace' }]);
  assert.match(b.show(`runs/${id}/files/${EXAM_REL}`), /examen-periodico/, 'el resultado guardado, no el archivo del clon');
});

// ── B: un fallo se ve ─────────────────────────────────────────────────────────────────────────────────────────────

test('T9 Notice_PushFailed_OneLinePerPiece @story-8.312 @ac-8', () => {
  const w = world();
  RT.recordFailure('exam', 'el empuje se rechazó tres veces', w.casa);
  RT.recordFailure('guides', 'fetch: no se pudo leer el remoto', w.casa);
  RT.recordFailure('weekly', 'no pude armar la copia de transporte', w.casa);
  const n = notice(w);
  const l = travelLines(n);
  assert.strictEqual(l.filter((x) => /🔴/.test(x)).length, 3, n.out);
  const hoy = new Date().toISOString().slice(0, 10);
  assert.ok(l.some((x) => /examen/.test(x) && x.includes(hoy) && /rechazó tres veces/.test(x)), n.out);
  assert.ok(l.some((x) => /casos de guía/.test(x) && /fetch/.test(x)), n.out);
  assert.ok(l.some((x) => /revisión semanal/.test(x) && /transporte/.test(x)), n.out);
  assert.strictEqual(l.filter((x) => /examen/.test(x)).length, 1, 'el examen sale una sola vez');
});

test('T10 Publish_NoRemote_IsAFailure @story-8.312 @ac-8', () => {
  const w = world();
  git(w.clone, ['remote', 'set-url', 'origin', path.join(w.raiz, 'no-existe.git')]);
  const r = publishExam(w, new Date().toISOString());
  assert.strictEqual(r.ok, false);
  assert.ok(r.motivo, 'con su motivo');
  const st = RT.readStatus(w.casa);
  assert.strictEqual(st.pieces.exam.ok, false, 'la pieza queda anotada');
});

function examCli(w, args = [], extra = {}) {
  const cfg = path.join(w.raiz, 'exam-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ designated_machine: 'Devas-Mac-mini', days_between_runs: 3, scheduled_days: ['tuesday', 'friday'], hour: '02:00' }));
  const runner = path.join(w.raiz, 'runner-falso.js');
  fs.writeFileSync(runner, `const fs=require('fs');const i=process.argv.indexOf('--json');
fs.writeFileSync(process.argv[i+1],JSON.stringify({ts:new Date().toISOString(),tool:'claude',runs:1,failed:0,criterio:0,inestables:null,erroresDeCorrida:0,fugas:0,parityBreaks:null,paridadReal:null,baselineRegressions:0,skippedMcp:0,results:{'a|claude':{}}}));`);
  const sonda = path.join(w.raiz, 'sonda.sh');
  fs.writeFileSync(sonda, '#!/bin/sh\nexit 0\n'); fs.chmodSync(sonda, 0o755);
  fs.mkdirSync(path.join(w.clone, 'scripts', 'controls-bench', '.bench'), { recursive: true });
  const env = { ...process.env, HOME: w.casa, TYCON_EXAM_CONFIG: cfg, TYCON_EXAM_RUNNER: runner, TYCON_EXAM_REPO: w.clone,
    TYCON_EXAM_MACHINE: 'Devas-Mac-mini', TYCON_EXAM_PROBE: sonda, ...extra };
  delete env.TYCON_HOME;
  const r = spawnSync(process.execPath, [EXAM, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('T11 Publish_Failed_ResultKeptOutsideClone @story-8.312 @ac-9', () => {
  const w = world();
  hook(w, 'echo rechazado >&2\nexit 1');
  const antes = snapshot(w.clone);
  const r = examCli(w, ['--force']);
  assert.strictEqual(r.code, 5, r.out);
  const kept = RT.keptPath('exam', EXAM_REL, w.casa);
  assert.ok(fs.existsSync(kept), 'el resultado queda en la carpeta de estado');
  assert.strictEqual(JSON.parse(fs.readFileSync(kept, 'utf8')).estado, 'completo');
  assert.ok(!fs.existsSync(path.join(w.clone, EXAM_REL)), 'y no en el clon');
  const despues = snapshot(w.clone);
  assert.strictEqual(despues.head, antes.head);
  assert.strictEqual(despues.status, antes.status);
  assert.strictEqual(RT.readStatus(w.casa).pieces.exam.ok, false);
});

test('T12 Notice_PieceRecovers_OnlyItsLineGoes @story-8.312 @ac-10', () => {
  const w = world();
  RT.recordFailure('exam', 'rechazado', w.casa);
  RT.recordFailure('guides', 'rechazado', w.casa);
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  const l = travelLines(notice(w)).filter((x) => /🔴/.test(x));
  assert.strictEqual(l.length, 1, l.join('\n'));
  assert.match(l[0], /casos de guía/);
});

test('T13 Notice_UnreadableState_SaysItDoesNotKnow @story-8.312 @ac-11', () => {
  const w = world();
  const f = RT.statusFile(w.casa);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ esto no es json');
  const l = travelLines(notice(w));
  assert.strictEqual(l.length, 1, l.join('\n'));
  assert.match(l[0], /no sé si/);
});

test('T36 Publish_RelativeOrigin_ResolvedFromClone @story-8.312 @ac-2', () => {
  // la copia de transporte vive en la carpeta de estado: una ruta relativa leída desde ahí apunta a otro lado
  const w = world();
  git(w.clone, ['remote', 'set-url', 'origin', path.relative(w.clone, w.remote)]);
  const r = publishExam(w, new Date().toISOString());
  assert.strictEqual(r.ok, true, r.motivo);
  const b = branch(w);
  assert.ok(b && b.ids.length === 1, 'la entrada llegó a night-results del remoto');
});

test('T37 WeeklyReview_HeadingInsideProposal_OneSection @story-8.312 @ac-4', () => {
  const CARRY = require(path.join(ROOT, 'scripts', 'ci', 'carry-night-results.js'));
  const texto = '## Revisión semanal 2026-11-17 — una — ⏳ PENDIENTE\n<!-- revision-semanal:2026-11-17:1 -->\n\n'
    + 'La propuesta cita un encabezado:\n## Revisión semanal 2026-11-10 — otra cosa\n\nY sigue.\n';
  const s = RT.sectionsOf(texto);
  assert.strictEqual(s.length, 1, JSON.stringify(s));
  assert.strictEqual(s[0].marker, '<!-- revision-semanal:2026-11-17:1 -->');
  assert.ok(s[0].text.includes('Y sigue.'), 'el texto entero queda en la sección');
  const entrada = { schema: 1, id: '20261117T000000000Z-weekly-aaaaa1', piece: 'weekly', ts: '2026-11-17T00:00:00.000Z', files: [{ path: LIST_REL, mode: 'append' }] };
  const v = CARRY.check(entrada.id, JSON.stringify(entrada), () => texto, Date.parse('2026-11-17T12:00:00.000Z'));
  assert.ok(!v.why, `la validación del nocturno la acepta: ${v.why}`);
});

test('T34 Notice_LibraryMissing_StaysQuiet @story-8.312 @ac-19', () => {
  // el aviso y la librería viajan juntos: sin ella el aviso calla, con o sin el examen al lado, como esperan los casos del
  // banco que lo copian solo
  const w = world();
  const correr = (conExamen) => {
    const arbol = tmp('aviso-solo-');
    fs.mkdirSync(path.join(arbol, 'scripts', 'hooks'), { recursive: true });
    fs.copyFileSync(NOTICE, path.join(arbol, 'scripts', 'hooks', 'bench-notice.js'));
    if (conExamen) {
      fs.mkdirSync(path.join(arbol, 'scripts', 'controls-bench'), { recursive: true });
      for (const f of ['periodic-exam.js', 'tools-path.js']) {
        fs.copyFileSync(path.join(ROOT, 'scripts', 'controls-bench', f), path.join(arbol, 'scripts', 'controls-bench', f));
      }
    }
    const env = { ...process.env, HOME: w.casa, TYCON_BENCH_DIR: path.join(w.raiz, 'no-hay-bench'), TYCON_EVAL_SANDBOX: '' };
    delete env.TYCON_HOME;
    const r = spawnSync(process.execPath, [path.join(arbol, 'scripts', 'hooks', 'bench-notice.js')],
      { cwd: tmp('otra-carpeta-'), encoding: 'utf8', input: '{"source":"startup"}', env });
    return { out: `${r.stdout}${r.stderr}`, l: `${r.stdout}`.split('\n').filter((x) => /resultados de la noche/.test(x)) };
  };
  for (const conExamen of [true, false]) {
    const r = correr(conExamen);
    assert.deepStrictEqual(r.l, [], `${conExamen ? 'con' : 'sin'} el examen: ${r.out}`);
  }
});

// ── C: quien lee el examen ────────────────────────────────────────────────────────────────────────────────────────

test('T14 Notice_PublishedExam_UsesNewest @story-8.312 @ac-12', () => {
  const viejo = new Date(Date.now() - 9 * 24 * HOUR).toISOString();
  const nuevo = new Date().toISOString();
  for (const [enClon, enEstado] of [[viejo, nuevo], [nuevo, viejo]]) {
    const w = world();
    write(w.clone, EXAM_REL, json(examReport(enClon, enClon === nuevo ? { criterio: 2 } : {})));
    const kept = RT.keptPath('exam', EXAM_REL, w.casa);
    write(path.dirname(kept), path.basename(kept), json(examReport(enEstado, enEstado === nuevo ? { criterio: 2 } : {})));
    const n = notice(w);
    assert.ok(!/NO ESTÁ CORRIENDO/.test(n.out), `no denuncia un examen viejo: ${n.out}`);
    assert.ok(n.out.includes(nuevo.slice(0, 10)) && /2 de criterio/.test(n.out), `usa el de ts mayor: ${n.out}`);
  }
});

test('T15 Notice_SealWithPublishedExam_NoFalseAlarm @story-8.312 @ac-12', () => {
  const w = world();
  const hoy = new Date().toISOString();
  const kept = RT.keptPath('exam', EXAM_REL, w.casa);
  write(path.dirname(kept), path.basename(kept), json(examReport(hoy)));
  write(path.join(w.casa, '.claude', '.tycon-pipeline'), 'periodic-exam-last-run', `${hoy}\n`);
  const bench = path.join(w.raiz, 'bench-vacio');
  fs.mkdirSync(bench);
  const n = notice(w, { TYCON_BENCH_DIR: bench });
  assert.ok(!/el sello de HOY/.test(n.out), n.out);
});

// ── B, piezas: la revisión semanal y el examen ────────────────────────────────────────────────────────────────────

function repoWithMerges(entries, base = {}) {
  const dir = tmp('rt-merges-');
  const env = { GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com' };
  git(dir, ['init', '-q', '-b', 'main'], env);
  write(dir, 'base.txt', 'base\n');
  for (const [rel, body] of Object.entries(base)) write(dir, rel, body);
  git(dir, ['add', '-A'], env); git(dir, ['commit', '-q', '-m', 'base'], { ...env, GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00' });
  const shas = [];
  entries.forEach((e, i) => {
    const d = { ...env, GIT_AUTHOR_DATE: e.date, GIT_COMMITTER_DATE: e.date };
    git(dir, ['checkout', '-q', '-b', e.branch], env);
    for (const [rel, body] of Object.entries(e.files || { [`f${i}.txt`]: `${i}\n` })) write(dir, rel, body);
    git(dir, ['add', '-A'], env); git(dir, ['commit', '-q', '-m', `feat: trabajo ${i}`], d);
    git(dir, ['checkout', '-q', 'main'], env);
    git(dir, ['merge', '-q', '--no-ff', e.branch, '-m', `Merge pull request ${100 + i} from ${e.branch} into main`], d);
    shas.push(git(dir, ['rev-parse', 'HEAD']));
  });
  return { dir, shas };
}
/** La semana: tres merges de story con su retro, como en weekly-review.test.js. */
function week() {
  const a = repoWithMerges([
    { date: '2026-10-13T10:00:00', branch: 'story/8.54-oferta' },
    { date: '2026-10-14T10:00:00', branch: 'story/8.55-porton' },
    { date: '2026-10-15T10:00:00', branch: 'story/8.57-x' },
  ]);
  const files = {};
  for (const sha of a.shas) files[`.dashboard/retros/metrics-${sha.slice(0, 7)}.json`] = JSON.stringify({ schema_version: '2.0', merge_commit: sha, generated_by: HEARTBEAT, metrics: {} });
  const ops = repoWithMerges([{ date: '2026-10-18T23:00:00', branch: 'chore/retros', files }]).dir;
  return { a, ops };
}
function fakeAgent(respuesta) {
  const d = tmp('rt-agente-');
  const script = path.join(d, 'agent.js');
  fs.writeFileSync(script, `let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({type:'result',is_error:false,total_cost_usd:0.1,result:${JSON.stringify(JSON.stringify(respuesta))}}));});\n`);
  return script;
}
function review(w, args, extra = {}) {
  const env = { ...process.env, HOME: w.casa, TYCON_TODAY: '2026-10-19', ...extra };
  delete env.TYCON_HOME;
  const r = spawnSync(process.execPath, [REVIEW, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const pattern = (s) => ({ patron: 'el pase da todo limpio sin revisar', titulo_llano: 'el pase da todo limpio', forma: 'prueba', texto: 'una prueba', por_que: 'los tres',
  merges: s.a.shas.map((sha) => ({ repo: 'acme-a', sha })) });

test('T4 WeeklyReview_ReadsMainList_EntryHasOnlyNewSections @story-8.312 @ac-4', () => {
  const s = week();
  const w = world();
  // main avanza con una propuesta que el clon todavía no bajó
  const otro = path.join(w.raiz, 'otro');
  execFileSync('git', ['clone', '-q', w.remote, otro]);
  git(otro, ['config', 'user.email', 'lab@example.com']); git(otro, ['config', 'user.name', 'Lab']);
  fs.appendFileSync(path.join(otro, LIST_REL), '\n## Revisión semanal 2026-10-12 — de main — ⏳ PENDIENTE\n<!-- revision-semanal:2026-10-12:1 -->\n\nde main\n\n---\n');
  git(otro, ['commit', '-qam', 'propuesta en main']); git(otro, ['push', '-q', 'origin', 'main']);
  const antes = snapshot(w.clone);
  const r = review(w, ['--out', w.clone, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--stamp', path.join(w.raiz, 'sello')],
    { TYCON_WEEKLY_REVIEW_AGENT: fakeAgent({ patrones: [pattern(s)] }) });
  assert.strictEqual(r.code, 0, r.out);
  const b = branch(w);
  const id = b.ids[0];
  const nuevas = b.show(`runs/${id}/files/${LIST_REL}`);
  assert.match(nuevas, /revision-semanal:2026-10-19:1/, 'la sección nueva');
  assert.ok(!/de main/.test(nuevas) && !/# Guide Update Proposals/.test(nuevas), 'sólo la sección nueva, no la lista entera');
  assert.ok(b.files.includes(`runs/${id}/files/${REPORT_REL}`), 'y el informe');
  assert.deepStrictEqual(snapshot(w.clone).status, antes.status, 'el clon no cambia');
  // con la marca de hoy ya en main, la fecha se mira sobre main: no hay secciones nuevas
  fs.appendFileSync(path.join(otro, LIST_REL), '\n## Revisión semanal 2026-10-19 — ya estaba — ⏳ PENDIENTE\n<!-- revision-semanal:2026-10-19:1 -->\n\nx\n\n---\n');
  git(otro, ['commit', '-qam', 'la de hoy']); git(otro, ['push', '-q', 'origin', 'main']);
  const r2 = review(w, ['--out', w.clone, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--stamp', path.join(w.raiz, 'sello2')],
    { TYCON_WEEKLY_REVIEW_AGENT: fakeAgent({ patrones: [pattern(s)] }) });
  assert.strictEqual(r2.code, 0, r2.out);
  const id2 = branch(w).ids.find((x) => x !== id);
  assert.ok(!branch(w).files.includes(`runs/${id2}/files/${LIST_REL}`), 'sin secciones nuevas, la entrada no lleva la lista');
});

test('T18 WeeklyReview_PushFailed_Exit5AndKept @story-8.312 @ac-9', () => {
  const s = week();
  const w = world();
  hook(w, 'echo rechazado >&2\nexit 1');
  const sello = path.join(w.raiz, 'sello');
  const r = review(w, ['--out', w.clone, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--stamp', sello],
    { TYCON_WEEKLY_REVIEW_AGENT: fakeAgent({ patrones: [pattern(s)] }) });
  assert.strictEqual(r.code, 5, r.out);
  assert.ok(fs.existsSync(RT.keptPath('weekly', REPORT_REL, w.casa)), 'el informe queda en la carpeta de estado');
  assert.match(fs.readFileSync(RT.keptPath('weekly', LIST_REL, w.casa), 'utf8'), /revision-semanal:2026-10-19:1/, 'y las secciones nuevas');
  assert.ok(!fs.existsSync(sello), 'la semana no se sella');
  assert.strictEqual(RT.readStatus(w.casa).pieces.weekly.ok, false);
});

test('T19 WeeklyReview_NoPush_StillWritesToOut @story-8.312 @ac-13', () => {
  const s = week();
  const w = world();
  const out = tmp('rt-out-');
  write(out, LIST_REL, '# Guide Update Proposals\n');
  const r = review(w, ['--out', out, '--repo', `acme-a=${s.a.dir}`, '--repo', `acme-ops=${s.ops}`, '--no-push', '--stamp', path.join(w.raiz, 'sello')],
    { TYCON_WEEKLY_REVIEW_AGENT: fakeAgent({ patrones: [pattern(s)] }) });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(out, REPORT_REL)), 'el informe en --out');
  assert.match(fs.readFileSync(path.join(out, LIST_REL), 'utf8'), /revision-semanal:2026-10-19:1/);
  assert.strictEqual(branch(w), null, 'sin entrada ni empuje');
  assert.ok(!fs.existsSync(path.join(RT.rootDir(w.casa), 'weekly')), 'sin carpeta de trabajo en el estado');
});

test('T20 Exam_ExistingGuards_Unchanged @story-8.312 @ac-13', () => {
  const w = world();
  const lock = path.join(w.clone, 'scripts', 'controls-bench', '.bench', 'examen.lock');
  write(path.dirname(lock), path.basename(lock), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), maquina: 'x' }));
  assert.strictEqual(examCli(w, ['--force']).code, 0);
  assert.strictEqual(branch(w), null, 'con el candado tomado no publica');
  fs.rmSync(lock);
  assert.strictEqual(examCli(w, ['--force'], { TYCON_NO_NIGHTLY_EXAM: '1' }).code, 0);
  assert.strictEqual(branch(w), null, 'apagado no publica');
  const dry = examCli(w, ['--dry-run']);
  assert.strictEqual(dry.code, 0);
  assert.match(dry.out, new RegExp(RT.BRANCH), '--dry-run dice adónde viaja');
  assert.strictEqual(branch(w), null, '--dry-run no publica');
  const r = examCli(w, ['--force']);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(w.casa, '.claude', '.tycon-pipeline', 'periodic-exam-last-run')), 'la completa sella');
  assert.strictEqual(branch(w).ids.length, 1, 'y publica');
});

// ── B: el aviso sobre lo que el nocturno llevó ────────────────────────────────────────────────────────────────────

/** Publica un examen y le corre la hora de publicación `horas` para atrás. */
function publishedAgo(w, horas) {
  assert.strictEqual(publishExam(w, new Date().toISOString()).ok, true);
  const f = RT.statusFile(w.casa);
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  st.exam.publishedAt = new Date(Date.now() - horas * HOUR).toISOString();
  fs.writeFileSync(f, json(st));
  return st.exam.entry;
}
/** Deja `carried.json` en main del remoto y lo trae al clon. */
function carriedOnMain(w, entries) {
  const otro = path.join(w.raiz, `carga-${Date.now()}`);
  execFileSync('git', ['clone', '-q', w.remote, otro]);
  git(otro, ['config', 'user.email', 'lab@example.com']); git(otro, ['config', 'user.name', 'Lab']);
  write(otro, RT.CARRIED, json({ schema: 1, entries }));
  git(otro, ['add', '-A']); git(otro, ['commit', '-q', '-m', 'llevado']); git(otro, ['push', '-q', 'origin', 'main']);
}

test('T28 Notice_NotCarriedAfterDeadline_RedLine @story-8.312 @ac-19', () => {
  const w = world();
  publishedAgo(w, 37);
  git(w.clone, ['fetch', '-q', 'origin', 'main']);
  const l = travelLines(notice(w));
  assert.strictEqual(l.length, 1, l.join('\n'));
  assert.match(l[0], /🔴/);
  assert.match(l[0], /no llegó a main/);
});

test('T29 Notice_StaleCopy_SaysItDoesNotKnow @story-8.312 @ac-19', () => {
  const w = world();
  publishedAgo(w, 37);
  git(w.clone, ['fetch', '-q', 'origin', 'main']);
  const viejo = new Date(Date.now() - 40 * HOUR);
  fs.utimesSync(path.join(w.clone, '.git', 'FETCH_HEAD'), viejo, viejo);
  const n = notice(w);
  const l = travelLines(n);
  assert.ok(l.length >= 1 && /🟠/.test(l[0]) && /no sé/.test(l[0]), n.out);
  assert.ok(!l.some((x) => /🔴/.test(x)), 'ninguna 🔴');
  assert.match(n.out, /git -C .* fetch origin/, 'con el comando para traerla');
});

test('T30 Notice_CarriedSilent_RejectedSaysWhy @story-8.312 @ac-19', () => {
  const w = world();
  const llevada = publishedAgo(w, 40);
  RT.recordFailure('guides', 'x', w.casa);
  // los casos de guía publican bien y su entrada termina rechazada
  const guias = RT.publish({ repo: w.clone, piece: 'guides', files: [{ path: GUIDES_REL, mode: 'replace', text: json({ kind: 'casos-de-guia', ts: new Date().toISOString(), guias: [] }) }],
    message: 'x', home: w.casa, log: () => {} });
  assert.strictEqual(guias.ok, true);
  carriedOnMain(w, { [llevada]: { status: 'carried', at: new Date().toISOString() }, [guias.entry]: { status: 'rejected', reason: 'la ruta no está permitida', at: new Date().toISOString() } });
  git(w.clone, ['fetch', '-q', 'origin', 'main']);
  const l = travelLines(notice(w));
  assert.strictEqual(l.length, 1, l.join('\n'));
  assert.match(l[0], /🔴.*casos de guía.*la ruta no está permitida/);
});

test('T31 Publish_EngramProjectClone_HookLeavesItClean @story-8.312 @ac-1', () => {
  const w = world({ files: { '.engram-project': 'acme\n', '.engram/chunks/.keep': '' } });
  // el gancho real de la máquina, y el `pre-push.local` de la persona que sincroniza su memoria en la raíz del repo
  const hooks = path.join(w.raiz, 'ganchos');
  fs.mkdirSync(hooks);
  fs.copyFileSync(PRE_PUSH, path.join(hooks, 'pre-push'));
  fs.chmodSync(path.join(hooks, 'pre-push'), 0o755);
  fs.writeFileSync(path.join(hooks, 'pre-push.local'), [
    '#!/bin/sh',
    `touch "${path.join(hooks, 'corrio')}"`,
    'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    '[ -f "$REPO_ROOT/.engram-project" ] || exit 0',
    'touch "$REPO_ROOT/.engram/chunks/creado-al-empujar.jsonl.gz"',
    'echo "engram: nuevo chunk generado" >&2',
    'exit 1',
  ].join('\n'));
  fs.chmodSync(path.join(hooks, 'pre-push.local'), 0o755);
  // la configuración global con los ganchos, sólo para el proceso que publica: los demás casos corren en paralelo
  const cfg = path.join(w.raiz, 'gitconfig-con-ganchos');
  fs.writeFileSync(cfg, `[core]\n\thooksPath = ${hooks}\n`);
  const antes = snapshot(w.clone);
  const kept = RT.keptPath('exam', EXAM_REL, w.casa);
  write(path.dirname(kept), path.basename(kept), json(examReport(new Date().toISOString())));
  const script = `const RT=require(${JSON.stringify(RT_PATH)});process.stdout.write(JSON.stringify(RT.publish({repo:${JSON.stringify(w.clone)},piece:'exam',`
    + `files:[{path:${JSON.stringify(EXAM_REL)},mode:'replace',source:${JSON.stringify(kept)}}],message:'x',home:${JSON.stringify(w.casa)}})))`;
  const p = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: cfg } });
  const r = JSON.parse(p.stdout || '{}');
  assert.strictEqual(r.ok, true, `${r.motivo} ${p.stderr}`);
  assert.ok(fs.existsSync(path.join(hooks, 'corrio')), 'el gancho de la máquina corrió en el empuje');
  assert.ok(!fs.existsSync(path.join(w.clone, '.engram', 'chunks', 'creado-al-empujar.jsonl.gz')), 'el gancho no escribió en el clon');
  assert.strictEqual(snapshot(w.clone).status, antes.status);
});

});
