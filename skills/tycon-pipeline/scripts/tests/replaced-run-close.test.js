'use strict';
/**
 * replaced-run-close.test.js — una ejecución abierta cuyo arreglo ya entró a main por otro lado se cierra con
 * `marker.js clear --replaced-by <commit>`, sin pase, pasos ni firma, si el arnés lo comprueba.
 *
 * Sin esto, después de meter el arreglo con un commit propio, la persona tiene que firmar el pase y completar los pasos
 * de una ejecución que ya no hace nada.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const RUN_CLOSE = path.join(SCRIPTS, 'lib', 'run-close.js');
const rc = require(RUN_CLOSE);
const SID = 'sesion-reemplazada';

const FECHA = '2026-11-21T10:00:00Z';
// la base es de antes del arranque de la ejecución (09:00); los commits del arreglo, de después
const ARRANQUE = '2026-11-21T09:00:00Z';
const ANTES = '2026-11-21T08:00:00Z';
let fecha = FECHA;
const git = (d, ...a) => spawnSync('git', ['-C', d, '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false', ...a],
  { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
function tmp(t, p) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}
// stable-data: el arranque de la ejecución se compara con el reloj real
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

/**
 * El repo de la historia con su origen; la ejecución abierta (el pase sin cerrar, pasos sin correr) editó `plugin.json`.
 * `enMain`: un commit de la persona en main que toca `plugin.json`; `otro`: uno en main que toca otro archivo; `local`:
 * uno que no se empujó.
 */
function corral(t) {
  const raiz = tmp(t, 'reemplazada-');
  const origen = path.join(raiz, 'origen.git');
  const repo = path.join(raiz, 'backend');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'remote', 'add', 'origin', origen);
  escribir(repo, 'plugin.json', '{"a":1}\n');
  escribir(repo, 'src/otro.js');
  fecha = ANTES;
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  fecha = FECHA;
  escribir(repo, 'plugin.json', '{"a":2}\n');
  git(repo, 'commit', '-q', '-am', 'el arreglo, a mano'); git(repo, 'push', '-q', 'origin', 'main');
  const enMain = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  escribir(repo, 'src/otro.js', 'y\n');
  git(repo, 'commit', '-q', '-am', 'otra cosa'); git(repo, 'push', '-q', 'origin', 'main');
  const otro = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  escribir(repo, 'plugin.json', '{"a":3}\n');
  git(repo, 'commit', '-q', '-am', 'sin empujar');
  const local = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const home = path.join(raiz, 'home');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, '---\nstatus: in-progress\n---\n# 2.4\n');
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '2.4', storyPath: story, repoPath: repo, sessionId: SID, startedAt: ARRANQUE,
    checks: { tests: 'green' }, stepsCompleted: ['start', 'plan', 'approve-plan', 'implement'], stepsPending: ['run-tests', 'reviewers', 'prepare-commit'],
    adversarial: { status: 'launched', runId: 'r1' },
    fileEvents: [{ path: path.join(repo, 'plugin.json'), ts: hace(30), code: true }],
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0' };
  return { repo, home, estado, env, story, base, enMain, otro, local };
}
const cerrar = (c, ...args) => spawnSync(process.execPath, [MARKER, 'clear', ...args], { cwd: c.repo, encoding: 'utf8', env: c.env });
const marcador = (c) => JSON.parse(fs.readFileSync(path.join(c.estado, 'active', `${SID}.json`), 'utf8'));
const frena = (c, comando) => {
  const r = spawnSync(process.execPath, [RUN_CLOSE, '--gate', '--session', SID, '--command-stdin', '--shell', 'bash'], { input: comando, encoding: 'utf8', env: c.env });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((l) => l.startsWith('frena=')).map((l) => l.slice(6).split('\t')[0]);
};
function volcado(c) {
  const dir = path.join(c.estado, 'timing-history');
  return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8')).marker;
}

// 🔴 Falla con: cerrar la ejecución abierta pidiendo la firma aunque su arreglo esté en main, o archivarla abortada.
test('ReplacedBy_CommitInMain_ClosesWithoutSteps (T23) @story-8.322 @ac-22', (t) => {
  const c = corral(t);
  // sin la bandera, cerrarla abierta pide la firma; con el commit que entró a main, no
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear`), ['cerrar la ejecución']);
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by ${c.enMain}`), []);
  const r = cerrar(c, '--replaced-by', c.enMain);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(c.estado, 'active', `${SID}.json`)), 'la ejecución sigue abierta');
  const cierre = volcado(c).cierre;
  assert.strictEqual(cierre.estado, 'reemplazada', JSON.stringify(cierre));
  assert.deepStrictEqual([cierre.commit, cierre.archivos], [c.enMain, ['plugin.json']]);
  assert.match(cierre.motivo, /entró a main con .*backend: plugin\.json.*quedaba: .*sin correr/);
  const gates = fs.readFileSync(path.join(c.estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(gates.some((g) => g.name === 'clear-replaced-by' && g.commit === c.enMain && g.story === '2.4'), 'no quedó la comprobación en gates.log');
});

// 🔴 Falla con: dar por reemplazada una ejecución con un commit que no está en main (sólo local o inventado).
test('ReplacedBy_NotInMain_Refuses (T24) @story-8.322 @ac-23', (t) => {
  const c = corral(t);
  for (const sha of [c.local, 'f'.repeat(40), 'no-es-un-commit']) {
    assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by ${sha}`), ['cerrar la ejecución'], sha);
    const r = cerrar(c, '--replaced-by', sha);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /no lo pude comprobar .*No se borró nada.*pide la firma de cerrarla/);
    assert.ok(marcador(c).storyId, 'borró la ejecución');
  }
  assert.match(cerrar(c, '--replaced-by', c.local).stderr, /no está en origin\/main/);
  // la bandera sin commit, o desde una variable, no se comprueba: queda la firma de siempre
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by "$C"`), ['cerrar la ejecución']);
  // un commit de main anterior al arranque, aunque toque el mismo archivo, no es el arreglo de esta ejecución
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by ${c.base}`), ['cerrar la ejecución']);
  assert.match(cerrar(c, '--replaced-by', c.base).stderr, /anterior al arranque de la ejecución/);
  // la copia local de main movida a mano engaña al freno, pero el guion mira main en el servidor y no cierra
  git(c.repo, 'update-ref', 'refs/remotes/origin/main', c.local);
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by ${c.local}`), []);
  const movido = spawnSync(process.execPath, [MARKER, 'clear', '--replaced-by', c.local], { cwd: c.repo, encoding: 'utf8',
    env: { ...c.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'never' } });
  assert.strictEqual(movido.status, 1, movido.stderr);
  assert.match(movido.stderr, /no está en origin\/main/);
  // sin poder leer main del servidor, no se comprueba
  git(c.repo, 'remote', 'set-url', 'origin', path.join(c.repo, 'no-existe.git'));
  assert.match(cerrar(c, '--replaced-by', c.enMain).stderr, /no pude leer main del servidor/);
  assert.ok(marcador(c).storyId, 'borró la ejecución');
});

// 🔴 Falla con: una ejecución detenida, que espera la decisión del dueño, cerrada sin él porque su arreglo está en main.
test('ReplacedBy_Detained_StillAsksTheOwner (T24b) @story-8.322 @ac-23', (t) => {
  const c = corral(t);
  fs.writeFileSync(path.join(c.estado, 'active', `${SID}.json`), JSON.stringify({ ...marcador(c), needs_human: true }));
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by ${c.enMain}`), ['cerrar la ejecución']);
  const r = cerrar(c, '--replaced-by', c.enMain);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /una ejecución detenida la cierra una persona/);
  assert.ok(marcador(c).storyId, 'borró la ejecución');
});

// 🔴 Falla con: aceptar un commit de main que no toca nada de lo que editó la ejecución.
test('ReplacedBy_OtherFiles_Refuses (T25) @story-8.322 @ac-23', (t) => {
  const c = corral(t);
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear --replaced-by ${c.otro}`), ['cerrar la ejecución']);
  const r = cerrar(c, '--replaced-by', c.otro);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no toca ninguno de los archivos que editó la ejecución/);
  // sin archivos anotados no hay con qué comparar
  const m = marcador(c);
  fs.writeFileSync(path.join(c.estado, 'active', `${SID}.json`), JSON.stringify({ ...m, fileEvents: [] }));
  assert.match(cerrar(c, '--replaced-by', c.enMain).stderr, /no tiene archivos editados anotados/);
});

// 🔴 Falla con: la historia que no pasa a terminada porque la ejecución reemplazada sigue pidiendo su pase y sus pasos.
test('StoryDone_SkipsReplacedRun (T26) @story-8.322 @ac-24', (t) => {
  const c = corral(t);
  assert.strictEqual(cerrar(c, '--replaced-by', c.enMain).status, 0);
  // otra ejecución de la historia, completa, se cierra como siempre
  fs.writeFileSync(path.join(c.estado, 'active', `${SID}.json`), JSON.stringify({ storyId: '2.4', storyPath: c.story, repoPath: c.repo, sessionId: SID, startedAt: hace(10),
    checks: { tests: 'green', advisors: 'green' }, stepsCompleted: ['start', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers'], stepsPending: ['prepare-commit'] }));
  assert.deepStrictEqual(frena(c, `node ${MARKER} clear`), []);
  assert.strictEqual(cerrar(c).status, 0);
  const u = spawnSync(process.execPath, [MARKER, 'update-story-status', c.story, 'done'], { cwd: c.repo, encoding: 'utf8', env: c.env });
  assert.strictEqual(u.status, 0, u.stderr);
  assert.match(fs.readFileSync(c.story, 'utf8'), /status: done/);
});

// 🔴 Falla con: `reemplazada` fuera de los estados, o contada como abierta (el freno pediría la firma de cerrarla).
test('RunClose_Replaced_NotOpen (T27) @story-8.322 @ac-25', (t) => {
  assert.ok(rc.ESTADOS.includes('reemplazada'));
  const abierta = { storyId: '2.4', checks: { tests: 'red:exit=1' }, stepsCompleted: [], stepsPending: ['run-tests'] };
  const yaEscrito = { estado: 'reemplazada', commit: 'abc1234', at: FECHA };
  assert.strictEqual(rc.cierreDe({ ...abierta, cierre: yaEscrito }), yaEscrito, 'un cierre reemplazada ya escrito se pisa');
  const sin = rc.cierreDe(abierta, { home: tmp(t, 'casa-') });
  assert.strictEqual(sin.estado, 'abortada', 'sin comprobar, una abierta es abortada');
  const con = rc.cierreDe(abierta, { home: tmp(t, 'casa-'), reemplazo: { ok: true, commit: 'abc1234', repo: '/x/backend', archivos: ['plugin.json'] } });
  assert.strictEqual(con.estado, 'reemplazada');
  assert.strictEqual(rc.cierreDe(abierta, { home: tmp(t, 'casa-'), reemplazo: { ok: false } }).estado, 'abortada');
  // el freno la consulta como cerrada
  const home = tmp(t, 'casa-');
  const estado = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(estado, { recursive: true });
  fs.writeFileSync(path.join(estado, `${SID}.json`), JSON.stringify({ ...abierta, cierre: yaEscrito }));
  assert.deepStrictEqual([rc.consulta(SID, home).abierta, rc.consulta(SID, home).detenida], [false, false]);
  fs.writeFileSync(path.join(estado, `${SID}.json`), JSON.stringify(abierta));
  assert.strictEqual(rc.consulta(SID, home).abierta, true);
});
