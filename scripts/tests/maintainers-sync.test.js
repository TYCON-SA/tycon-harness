'use strict';
/**
 * maintainers-sync.test.js — el arranque pone al día el clon de mantenimiento (T1-T19).
 *
 * POR QUÉ. El clon del repo de mantenimiento que declara la máquina (`paths.maintainers`) es de donde cada
 * sesión carga la portada privada (un `@import` del CLAUDE.md) y de donde los avisos leen la noche. El arranque pone
 * al día el clon del arnés y tiene que poner al día también ése: si no, quedaría atrás de `main` días enteros, en silencio.
 *
 * QUÉ FIJA. `scripts/lib/maintainers-sync.js run` sobre un clon de laboratorio:
 *   · en `main`, limpio y atrás → avanza con `merge --ff-only`; al día → no cambia nada;
 *   · un cambio rastreado, otra rama, commits propios, divergido, una operación a medias o archivos sin seguimiento que
 *     lo nuevo agrega → no toca nada y deja dicho por qué;
 *   · sin la clave, con el mismo clon que el arnés, en el perfil minimal o con el perfil sin saber → no corre git;
 *   · un candado vivo frena una segunda corrida; uno viejo se pisa;
 *   · los errores de `fetch` se clasifican, y un permiso en una dirección nunca se muestra;
 *   · el aviso de arranque dice una vez lo que pide a la persona, calla lo demás y lanza la puesta al día de fondo.
 *
 * 🔴 Nada toca la máquina real: `HOME` y `TYCON_HOME` propios, git sin configuración de sistema ni de usuario, y el
 * origen es un repo pelado en una carpeta local. Cada corrida es un proceso hijo con un ambiente armado de cero.
 */
// partida en tres (scripts/tests/suite-parts.json): los casos del hook esperan una corrida de fondo y, con la máquina
// cargada, el archivo entero pasa de 45 s. Corrido a mano corre todo, como siempre.
const test = require('./lib/suite-parts.js').test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PIECE = path.join(ROOT, 'scripts', 'lib', 'maintainers-sync.js');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'branch-guard-notice.js');
const LABS = [];
test.after(() => { for (const d of LABS) fs.rmSync(d, { recursive: true, force: true }); });

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** El ambiente de un proceso del laboratorio: armado de cero, sin heredar nada de quien corre la prueba. */
function labEnv(lab, more = {}) {
  const env = {
    PATH: process.env.PATH, HOME: lab.home, USERPROFILE: lab.home, TYCON_HOME: lab.tycon,
    TMPDIR: lab.tmp, TEMP: lab.tmp, TMP: lab.tmp, LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(lab.base, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    TYCON_INSTALL_PROFILE: 'full',
    ...more,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const k of Object.keys(env)) if (env[k] === undefined || env[k] === null) delete env[k];
  return env;
}

function git(lab, cwd, args, { ok = true } = {}) {
  const r = spawnSync('git', ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'init.defaultBranch=main',
    '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', env: labEnv(lab), stdio: ['ignore', 'pipe', 'pipe'] });
  if (ok && r.status !== 0) throw new Error(`git ${args.join(' ')} en ${cwd}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

/** Un commit nuevo en el origen (por el clon `seed`), con un archivo `name`. */
function upstreamCommit(lab, name, text = `${name}\n`) {
  write(path.join(lab.seed, name), text);
  git(lab, lab.seed, ['add', name]);
  git(lab, lab.seed, ['commit', '-qm', `agrega ${name}`]);
  git(lab, lab.seed, ['push', '-q', 'origin', 'main']);
}

/** Una máquina de juguete: origen pelado, un clon `seed` que publica y el clon de mantenimiento `mant`. */
function makeLab({ declare = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mant-sync-'));
  LABS.push(base);
  const lab = { base, home: path.join(base, 'home'), tycon: path.join(base, 'home', '.tycon'), tmp: path.join(base, 'tmp'),
    origin: path.join(base, 'origin.git'), seed: path.join(base, 'seed'), mant: path.join(base, 'mant') };
  for (const d of [lab.home, lab.tmp, path.join(lab.tycon, 'state')]) fs.mkdirSync(d, { recursive: true });
  write(path.join(base, 'gitconfig'), '');
  git(lab, base, ['init', '-q', '--bare', lab.origin]);
  git(lab, base, ['clone', '-q', lab.origin, lab.seed]);
  write(path.join(lab.seed, 'README.md'), 'portada\n');
  git(lab, lab.seed, ['add', 'README.md']);
  git(lab, lab.seed, ['commit', '-qm', 'inicio']);
  git(lab, lab.seed, ['push', '-q', 'origin', 'main']);
  git(lab, base, ['clone', '-q', lab.origin, lab.mant]);
  if (declare) setConfig(lab, { paths: { maintainers: lab.mant } });
  return lab;
}
function setConfig(lab, obj) { write(path.join(lab.tycon, 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); }
const resultFile = (lab) => path.join(lab.tycon, 'state', 'maintainers-sync.json');
const lockFile = (lab) => path.join(lab.tycon, 'state', 'maintainers-sync.lock');
function readResult(lab) { try { return JSON.parse(fs.readFileSync(resultFile(lab), 'utf8')); } catch (_) { return null; } }
const head = (lab) => git(lab, lab.mant, ['rev-parse', 'HEAD']);
const originMain = (lab) => git(lab, lab.seed, ['rev-parse', 'HEAD']);

/** La pieza en primer plano (`run --json`): lo que la puesta al día decidió, aunque no haya escrito nada. */
function runPiece(lab, more = {}) {
  const r = spawnSync(process.execPath, [PIECE, 'run', '--json'], { encoding: 'utf8', env: labEnv(lab, more), stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  assert.strictEqual(r.status, 0, `la pieza tiene que salir 0 siempre: ${r.stderr}`);
  let out = null;
  try { out = JSON.parse(r.stdout); } catch (_) { assert.fail(`run --json no devolvió JSON: ${r.stdout} ${r.stderr}`); }
  return out;
}
function runHook(lab, more = {}, hook = HOOK) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [hook], { encoding: 'utf8', env: labEnv(lab, more), stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', ms: Date.now() - t0 };
}
function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; sleep(100); }
}
const mantLine = (out) => out.split('\n').filter((l) => l.includes('clon de mantenimiento'));

// ── la puesta al día ────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Sync_UpToDate_NothingMoves — al día: resultado al-dia escrito, HEAD y árbol iguales', () => {
  const lab = makeLab();
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'al-dia');
  assert.strictEqual(head(lab), before);
  assert.strictEqual(git(lab, lab.mant, ['status', '--porcelain']), '');
  const saved = readResult(lab);
  assert.ok(saved, 'el resultado tiene que quedar escrito');
  assert.strictEqual(saved.status, 'al-dia');
  assert.strictEqual(saved.shown, false);
});

test('T2 Sync_BehindAndClean_FastForwards — atrás y limpio: avanza a origin/main y lo anota', () => {
  const lab = makeLab();
  const before = head(lab);
  upstreamCommit(lab, 'a.md');
  upstreamCommit(lab, 'b.md');
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'avanzo', JSON.stringify(r));
  assert.strictEqual(r.behind, 2);
  assert.strictEqual(head(lab), originMain(lab));
  const saved = readResult(lab);
  assert.strictEqual(saved.status, 'avanzo');
  assert.strictEqual(saved.from, before);
  assert.strictEqual(saved.to, originMain(lab));
});

test('T3 Sync_TrackedChange_DoesNotTouch — un cambio rastreado sin commitear frena: nada se mueve', () => {
  const lab = makeLab();
  write(path.join(lab.mant, 'README.md'), 'tocado a mano\n');
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'cambios-propios');
  assert.deepStrictEqual(r.files, ['README.md']);
  assert.strictEqual(head(lab), before);
  assert.strictEqual(fs.readFileSync(path.join(lab.mant, 'README.md'), 'utf8'), 'tocado a mano\n');
});

test('T4 Sync_OtherBranch_DoesNotTouch — en otra rama no se toca', () => {
  const lab = makeLab();
  git(lab, lab.mant, ['checkout', '-q', '-b', 'feat/x']);
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'otra-rama');
  assert.strictEqual(r.branch, 'feat/x');
  assert.strictEqual(head(lab), before);
  assert.strictEqual(git(lab, lab.mant, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/x');
});

test('T5 Sync_Diverged_DoesNotTouch — main local y origin/main separados: no se toca', () => {
  const lab = makeLab();
  write(path.join(lab.mant, 'local.md'), 'propio\n');
  git(lab, lab.mant, ['add', 'local.md']);
  git(lab, lab.mant, ['commit', '-qm', 'propio']);
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'divergido');
  assert.strictEqual(r.ahead, 1);
  assert.strictEqual(r.behind, 1);
  assert.strictEqual(head(lab), before);
});

test('T6 Sync_NoKey_DoesNothing — sin paths.maintainers: ni git ni resultado', () => {
  const lab = makeLab({ declare: false });
  setConfig(lab, { paths: {} });
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'sin-clave');
  assert.strictEqual(readResult(lab), null);
  assert.strictEqual(head(lab), before);
  // tampoco trajo nada: origin/main del clon sigue donde estaba
  assert.strictEqual(git(lab, lab.mant, ['rev-parse', 'origin/main']), before);
});

test('T7 Sync_LocalAhead_DoesNotTouch — commits propios sin empujar: no se toca', () => {
  const lab = makeLab();
  write(path.join(lab.mant, 'local.md'), 'propio\n');
  git(lab, lab.mant, ['add', 'local.md']);
  git(lab, lab.mant, ['commit', '-qm', 'propio']);
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'sin-empujar');
  assert.strictEqual(r.ahead, 1);
  assert.strictEqual(head(lab), before);
});

test('T8 Sync_OperationInProgress_DoesNotTouch — un merge con conflicto a medias: no se toca', () => {
  const lab = makeLab();
  git(lab, lab.mant, ['checkout', '-q', '-b', 'otra']);
  write(path.join(lab.mant, 'README.md'), 'de la otra\n');
  git(lab, lab.mant, ['commit', '-qam', 'otra']);
  git(lab, lab.mant, ['checkout', '-q', 'main']);
  write(path.join(lab.mant, 'README.md'), 'de main\n');
  git(lab, lab.mant, ['commit', '-qam', 'main']);
  git(lab, lab.mant, ['merge', 'otra'], { ok: false });   // conflicto: queda a medias
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'operacion-a-medias');
  assert.strictEqual(head(lab), before);
  assert.ok(fs.existsSync(path.join(lab.mant, '.git', 'MERGE_HEAD')), 'el merge a medias tiene que seguir como estaba');
});

test('T9 Sync_UntrackedCollision_NamesFiles — un sin seguimiento que lo nuevo agrega frena; uno ajeno no', () => {
  const lab = makeLab();
  write(path.join(lab.mant, 'nuevo.md'), 'mío, sin seguimiento\n');
  write(path.join(lab.mant, 'ajeno.out'), 'salida suelta\n');
  upstreamCommit(lab, 'nuevo.md', 'publicado\n');
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'archivos-traban');
  assert.deepStrictEqual(r.files, ['nuevo.md']);
  assert.strictEqual(head(lab), before);
  assert.strictEqual(fs.readFileSync(path.join(lab.mant, 'nuevo.md'), 'utf8'), 'mío, sin seguimiento\n');
  // sin la colisión, el ajeno no impide avanzar y queda donde estaba
  fs.rmSync(path.join(lab.mant, 'nuevo.md'));
  const again = runPiece(lab);
  assert.strictEqual(again.status, 'avanzo');
  assert.strictEqual(fs.readFileSync(path.join(lab.mant, 'ajeno.out'), 'utf8'), 'salida suelta\n');
});

test('T10 Sync_BadKey_SaysWhy — una clave que no sirve se dice, sin citar la configuración', () => {
  const lab = makeLab({ declare: false });
  // una relativa rompe la configuración entera para su lector: el perfil queda sin saber y calla; lo dice doctor
  setConfig(lab, { paths: { maintainers: 'relativa/no-sirve' }, github: { token: 'ghp_SECRETO_DE_PRUEBA' } });
  let r = runPiece(lab);
  assert.strictEqual(r.status, 'perfil');
  assert.strictEqual(readResult(lab), null);
  setConfig(lab, { paths: { maintainers: path.join(lab.base, 'no-esta') }, github: { token: 'ghp_SECRETO_DE_PRUEBA' } });
  r = runPiece(lab);
  assert.strictEqual(r.status, 'no-sirve');
  assert.ok(!JSON.stringify(readResult(lab)).includes('SECRETO'), 'el resultado no puede citar la configuración');
  // una carpeta que existe y no es un clon
  fs.mkdirSync(path.join(lab.base, 'suelta'));
  setConfig(lab, { paths: { maintainers: path.join(lab.base, 'suelta') } });
  r = runPiece(lab);
  assert.strictEqual(r.status, 'no-sirve');
});

test('T11 Sync_SameAsHarnessTree_Skips — la clave apunta al clon del arnés: no hace nada', () => {
  const lab = makeLab({ declare: false });
  setConfig(lab, { paths: { maintainers: ROOT } });
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'mismo-clon');
  assert.strictEqual(readResult(lab), null);
});

test('T12 Sync_LockBusy_Skips_StaleLockTaken — candado vivo frena; viejo o de un proceso muerto se pisa', () => {
  const lab = makeLab();
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  write(lockFile(lab), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  let r = runPiece(lab);
  assert.strictEqual(r.status, 'ocupado');
  assert.strictEqual(head(lab), before);
  assert.strictEqual(readResult(lab), null);
  write(lockFile(lab), JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 3 * 60 * 1000).toISOString() }));
  r = runPiece(lab);
  assert.strictEqual(r.status, 'avanzo', 'un candado de más de 2 minutos se pisa');
  assert.ok(!fs.existsSync(lockFile(lab)), 'al terminar suelta el candado');
  upstreamCommit(lab, 'b.md');
  write(lockFile(lab), JSON.stringify({ pid: 2147483646, at: new Date().toISOString() }));
  r = runPiece(lab);
  assert.strictEqual(r.status, 'avanzo', 'un candado de un proceso que no existe se pisa');
});

// ── lo que se dice ──────────────────────────────────────────────────────────────────────────────────────────────

test('T13 Classify_FetchErrors — red, permiso u otra cosa', () => {
  const M = require(PIECE);
  assert.strictEqual(M.classifyFetchError('fatal: unable to access \'https://x/\': Could not resolve host: x', false), 'sin-red');
  assert.strictEqual(M.classifyFetchError('fatal: unable to access: Failed to connect to x port 443', false), 'sin-red');
  assert.strictEqual(M.classifyFetchError('ssh: connect to host x port 22: Operation timed out', false), 'sin-red');
  assert.strictEqual(M.classifyFetchError('', true), 'sin-red');
  assert.strictEqual(M.classifyFetchError('fatal: Authentication failed for \'https://x/\'', false), 'sin-permiso');
  assert.strictEqual(M.classifyFetchError('fatal: could not read Username for \'https://x\': terminal prompts disabled', false), 'sin-permiso');
  assert.strictEqual(M.classifyFetchError('remote: TF401019: The Git repository ... 403', false), 'sin-permiso');
  assert.strictEqual(M.classifyFetchError('git@x: Permission denied (publickey).', false), 'sin-permiso');
  assert.strictEqual(M.classifyFetchError('fatal: \'/no/esta\' does not appear to be a git repository', false), 'fallo');
});

test('T14 Redact_CredentialsNeverShown — un permiso en una dirección no llega ni al resultado ni al aviso', () => {
  const M = require(PIECE);
  const red = M.redact('fatal: unable to access \'https://usuario:secreto@dev.example.invalid/x/_git/y/\': error 500\nsegunda línea');
  assert.ok(!red.includes('secreto') && !red.includes('usuario:'), red);
  assert.ok(!red.includes('segunda'), 'una sola línea');
  // de punta a punta: un origen con permiso en la dirección que falla
  const lab = makeLab();
  git(lab, lab.mant, ['remote', 'set-url', 'origin', 'https://usuario:secreto@127.0.0.1:9/x.git']);
  const r = runPiece(lab);
  assert.ok(['sin-red', 'fallo', 'sin-permiso'].includes(r.status), JSON.stringify(r));
  assert.ok(!fs.readFileSync(resultFile(lab), 'utf8').includes('secreto'));
  const line = M.noticeLine({ ...readResult(lab), status: 'fallo', detail: readResult(lab).detail || 'x' });
  assert.ok(line && !line.includes('secreto'), line);
});

test('T15 Notice_ProblemOnce_SilentStates — una línea la primera vez; nada después ni para lo que calla', () => {
  const M = require(PIECE);
  for (const status of ['avanzo', 'al-dia', 'sin-red']) assert.strictEqual(M.noticeLine({ status, clone: '/x' }), null, status);
  for (const status of ['otra-rama', 'cambios-propios', 'sin-empujar', 'divergido', 'operacion-a-medias', 'archivos-traban',
    'sin-permiso', 'sin-remoto', 'fallo', 'no-sirve']) {
    const line = M.noticeLine({ status, clone: '/x/mant', branch: 'feat/x', files: ['a.md'], ahead: 1, behind: 2, detail: 'algo' });
    assert.ok(typeof line === 'string' && line.includes('clon de mantenimiento') && !line.includes('\n'), `${status}: ${line}`);
  }
  // takeNotice: por la CLI, con un resultado escrito a mano
  const lab = makeLab();
  write(resultFile(lab), JSON.stringify({ schema: 1, status: 'otra-rama', branch: 'feat/x', clone: lab.mant, at: new Date().toISOString(), shown: false }));
  const notice = () => spawnSync(process.execPath, [PIECE, 'notice'], { encoding: 'utf8', env: labEnv(lab), stdio: ['ignore', 'pipe', 'pipe'] }).stdout.trim();
  const first = notice();
  assert.ok(first.includes('feat/x'), first);
  assert.strictEqual(notice(), '', 'la segunda vez no se repite');
  assert.strictEqual(readResult(lab).shown, true);
  write(resultFile(lab), JSON.stringify({ schema: 1, status: 'avanzo', behind: 3, clone: lab.mant, shown: false }));
  assert.strictEqual(notice(), '');
});

// ── el aviso de arranque ────────────────────────────────────────────────────────────────────────────────────────

test('T16 Hook_LaunchesInBackground_E2E — el aviso lanza de fondo, no espera, y dice lo pendiente una vez', () => {
  const lab = makeLab();
  upstreamCommit(lab, 'a.md');
  const h = runHook(lab);
  assert.strictEqual(h.status, 0, h.err);
  assert.ok(h.ms < 10000, `el hook no espera la puesta al día (tardó ${h.ms} ms)`);
  const done = waitFor(() => { const r = readResult(lab); return r && r.status === 'avanzo' ? r : null; });
  assert.ok(done, 'la puesta al día de fondo tenía que avanzar el clon');
  assert.strictEqual(head(lab), originMain(lab));
  // «avanzó» calla
  let next = runHook(lab);
  assert.deepStrictEqual(mantLine(next.out), []);
  // en otra rama: la corrida de fondo lo anota, y el aviso siguiente lo dice en una línea, una vez
  waitFor(() => !fs.existsSync(lockFile(lab)) && readResult(lab) && readResult(lab).status === 'al-dia');
  git(lab, lab.mant, ['checkout', '-q', '-b', 'feat/y']);
  runHook(lab);
  assert.ok(waitFor(() => { const r = readResult(lab); return r && r.status === 'otra-rama'; }), 'la corrida tenía que anotar otra-rama');
  waitFor(() => !fs.existsSync(lockFile(lab)));
  next = runHook(lab);
  const lines = mantLine(next.out);
  assert.strictEqual(lines.length, 1, next.out);
  assert.ok(lines[0].includes('feat/y'), lines[0]);
});

test('T17 Hook_OffVar_LooseCopy_BrokenPiece — apagado, suelto, pieza rota o resultado ilegible: sale 0 sin líneas de esto', () => {
  const lab = makeLab();
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  // apagado
  let h = runHook(lab, { TYCON_MAINTAINERS_SYNC: '0' });
  assert.strictEqual(h.status, 0);
  sleep(1500);
  assert.strictEqual(readResult(lab), null, 'apagado no se lanza');
  assert.strictEqual(head(lab), before);
  // apagado: tampoco dice un resultado pendiente
  write(resultFile(lab), JSON.stringify({ schema: 1, status: 'otra-rama', branch: 'z', clone: lab.mant, shown: false }));
  h = runHook(lab, { TYCON_MAINTAINERS_SYNC: '0' });
  assert.deepStrictEqual(mantLine(h.out), []);
  fs.rmSync(resultFile(lab));
  // el hook copiado suelto, sin la pieza al lado
  const loose = path.join(lab.base, 'suelto', 'branch-guard-notice.js');
  write(loose, fs.readFileSync(HOOK, 'utf8'));
  h = runHook(lab, {}, loose);
  assert.strictEqual(h.status, 0, h.err);
  sleep(1500);
  assert.strictEqual(readResult(lab), null, 'suelto no lanza nada');
  // una pieza que tira al cargarse
  const tree = path.join(lab.base, 'roto', 'scripts');
  write(path.join(tree, 'hooks', 'branch-guard-notice.js'), fs.readFileSync(HOOK, 'utf8'));
  write(path.join(tree, 'lib', 'maintainers-sync.js'), 'throw new Error("rota a propósito");\n');
  h = runHook(lab, {}, path.join(tree, 'hooks', 'branch-guard-notice.js'));
  assert.strictEqual(h.status, 0, h.err);
  assert.deepStrictEqual(mantLine(h.out), []);
  // un resultado ilegible
  write(resultFile(lab), '{ esto no es json');
  h = runHook(lab, { TYCON_MAINTAINERS_SYNC: '0' });
  assert.strictEqual(h.status, 0);
  h = runHook(lab, { TYCON_INSTALL_PROFILE: 'minimal' });
  assert.strictEqual(h.status, 0);
  assert.deepStrictEqual(mantLine(h.out), []);
});

test('T18 Relay_ForcedShim_StillSyncs — el camino de Windows (relevo) también pone al día', () => {
  const lab = makeLab();
  upstreamCommit(lab, 'a.md');
  const h = runHook(lab, { TYCON_MAINTAINERS_SYNC_SHIM: '1' });
  assert.strictEqual(h.status, 0, h.err);
  assert.ok(waitFor(() => { const r = readResult(lab); return r && r.status === 'avanzo'; }), 'por el relevo tenía que avanzar');
  assert.strictEqual(head(lab), originMain(lab));
});

test('T19 Sync_MinimalOrUnknownProfile_DoesNothing — perfil minimal o sin saber: ni git ni resultado', () => {
  const lab = makeLab();
  upstreamCommit(lab, 'a.md');
  const before = head(lab);
  let r = runPiece(lab, { TYCON_INSTALL_PROFILE: 'minimal' });
  assert.strictEqual(r.status, 'perfil');
  assert.strictEqual(readResult(lab), null);
  assert.strictEqual(git(lab, lab.mant, ['rev-parse', 'origin/main']), before, 'no tenía que traer nada');
  // un perfil que no se puede saber (valor fuera de la lista)
  setConfig(lab, { paths: { maintainers: lab.mant }, install: { profile: 'raro' } });
  r = runPiece(lab, { TYCON_INSTALL_PROFILE: undefined });
  assert.strictEqual(r.status, 'perfil');
  assert.strictEqual(head(lab), before);
});

test('T22 Catalogs_DeclareThePiece — la lista de efectos, la de hooks, INSTALL y la guía de piezas la nombran', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const effects = JSON.parse(read('scripts/setup/install-effects.json')).effects;
  const task = effects.find((e) => e.id === 'task:maintainers-sync');
  assert.ok(task, 'install-effects.json tiene que declarar task:maintainers-sync');
  assert.deepStrictEqual(task.profiles, ['full'], 'sólo en el perfil completo (decisión 13)');
  assert.strictEqual(task.switch, 'TYCON_MAINTAINERS_SYNC=0');
  assert.ok(task.network && task.stores, 'sale a la red y guarda un archivo: los dos se dicen');
  assert.ok(read(task.source.file).includes(task.source.pattern), 'la tarea nombra el texto que la lanza');
  assert.ok(read('scripts/setup/hooks-list.json').includes('TYCON_MAINTAINERS_SYNC=0'));
  assert.ok(/branch-guard-notice\.js` \| SessionStart \|[^\n]*TYCON_MAINTAINERS_SYNC=0/.test(read('INSTALL.md')), 'la fila del hook en INSTALL.md');
  assert.ok(read('guides/piezas-del-arnes.md').includes('## scripts/lib/maintainers-sync.js'), 'la ficha en la guía de piezas');
});

// ── los caminos de error, de punta a punta ─────────────────────────────────────────────

/** Un ssh de mentira: `GIT_SSH_COMMAND` con un origen `ssh://`. Modo: deny · unreach · sleep (N segundos y sale 255). */
function fakeSsh(lab, mode, secs = 6) {
  const file = path.join(lab.base, 'fake-ssh.sh');
  write(file, [
    '#!/bin/sh',
    `case "${mode}" in`,
    '  deny) echo "git@fake.invalid: Permission denied (publickey)." >&2; exit 255;;',
    '  unreach) echo "ssh: connect to host fake.invalid port 22: Network is unreachable" >&2; exit 255;;',
    `  sleep) sleep ${secs}; exit 255;;`,
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  git(lab, lab.mant, ['remote', 'set-url', 'origin', 'ssh://git@fake.invalid/x.git']);
  return { GIT_SSH_COMMAND: file };
}
const noticeOf = (lab, more = {}) => spawnSync(process.execPath, [PIECE, 'notice'], { encoding: 'utf8', env: labEnv(lab, more), stdio: ['ignore', 'pipe', 'pipe'] }).stdout.trim();

test('T23 Sync_NoRemote_SaysSo — un clon sin origin: sin-remoto, y el aviso lo dice', () => {
  const lab = makeLab();
  git(lab, lab.mant, ['remote', 'remove', 'origin']);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'sin-remoto');
  assert.ok(noticeOf(lab).includes('no tiene un remoto origin'));
});

test('T24 Sync_FetchErrors_EndToEnd — permiso avisa; red y tope callan; sin red más de 3 días avisa', () => {
  const lab = makeLab();
  let env = fakeSsh(lab, 'deny');
  let r = runPiece(lab, env);
  assert.strictEqual(r.status, 'sin-permiso', JSON.stringify(r));
  assert.ok(noticeOf(lab, env).includes('por permiso'));
  env = fakeSsh(lab, 'unreach');
  r = runPiece(lab, env);
  assert.strictEqual(r.status, 'sin-red');
  assert.strictEqual(noticeOf(lab, env), '', 'sin red de un rato calla');
  env = { ...fakeSsh(lab, 'sleep', 5), TYCON_MAINTAINERS_SYNC_FETCH_MS: '800' };
  r = runPiece(lab, env);
  assert.strictEqual(r.status, 'sin-red', 'el tope del fetch es sin-red');
  assert.match(r.detail, /no terminó/);
  // sin red desde hace 4 días: la corrida siguiente lo arrastra y el aviso lo dice
  const prev = readResult(lab);
  write(resultFile(lab), JSON.stringify({ ...prev, offline_since: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString(), shown: true }));
  env = fakeSsh(lab, 'unreach');
  r = runPiece(lab, env);
  assert.strictEqual(r.status, 'sin-red');
  assert.strictEqual(r.offline_days, 4);
  assert.match(noticeOf(lab, env), /hace 4 día\(s\) que no puedo traer/);
});

test('T25 Sync_MergeFails_Fallo — git se niega a avanzar: fallo con su motivo, nada tocado', () => {
  const lab = makeLab();
  // otro proceso tiene tomado el índice del clon: status y fetch andan, el merge no
  upstreamCommit(lab, 'a.md');
  write(path.join(lab.mant, '.git', 'index.lock'), '');
  const before = head(lab);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'fallo', JSON.stringify(r));
  assert.match(r.detail, /index\.lock/);
  assert.strictEqual(head(lab), before);
  assert.ok(!fs.existsSync(path.join(lab.mant, 'a.md')), 'nada de lo nuevo quedó en el árbol');
});

test('T26 Sync_DetachedHead_SaysNoBranch — HEAD suelto: otra-rama sin nombre y su frase', () => {
  const lab = makeLab();
  git(lab, lab.mant, ['checkout', '-q', '--detach']);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'otra-rama');
  assert.strictEqual(r.branch, null);
  assert.match(noticeOf(lab), /sin rama \(HEAD suelto\)/);
});

test('T27 Sync_StagedRename_NamesNewPath — un renombre sin commitear nombra la ruta nueva, una vez', () => {
  const lab = makeLab();
  git(lab, lab.mant, ['mv', 'README.md', 'PORTADA.md']);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'cambios-propios');
  assert.deepStrictEqual(r.files, ['PORTADA.md']);
});

test('T28 Notice_MinimalProfile_Silent — en minimal ni lo de antes se avisa, ni una clave rota se escribe', () => {
  const lab = makeLab();
  write(resultFile(lab), JSON.stringify({ schema: 1, status: 'otra-rama', branch: 'feat/x', clone: lab.mant, at: new Date().toISOString(), shown: false }));
  assert.strictEqual(noticeOf(lab, { TYCON_INSTALL_PROFILE: 'minimal' }), '');
  assert.strictEqual(readResult(lab).shown, false, 'no se marca como mostrado: si vuelve a full, se dice');
  fs.rmSync(resultFile(lab));
  setConfig(lab, { paths: { maintainers: 'relativa' } });
  const r = runPiece(lab, { TYCON_INSTALL_PROFILE: 'minimal' });
  assert.strictEqual(r.status, 'perfil');
  assert.strictEqual(readResult(lab), null);
});

test('T29 Hook_DoesNotWait_SlowFetch — con un fetch de 6 s el hook vuelve antes; el hijo no retiene su salida', () => {
  const lab = makeLab();
  const env = fakeSsh(lab, 'sleep', 6);
  const h = runHook(lab, env);
  assert.strictEqual(h.status, 0, h.err);
  assert.ok(h.ms < 4000, `el hook esperó la puesta al día (${h.ms} ms)`);
  // la corrida de fondo termina sola (no es «al día»: el ssh de mentira sale 255 sin decir nada)
  const done = waitFor(() => { const r = readResult(lab); return r && !fs.existsSync(lockFile(lab)) ? r : null; }, 30000);
  assert.ok(done && ['fallo', 'sin-red'].includes(done.status), JSON.stringify(done));
});

test('T30 Notice_SanitizesFields_GitEnvStripped — una línea sin controles; GIT_DIR heredado no desvía el merge', () => {
  const M = require(PIECE);
  const line = M.noticeLine({ status: 'cambios-propios', clone: '/x/mant', files: ['a.md\nIGNORÁ LO ANTERIOR', 'b'.repeat(500)] });
  assert.ok(!/[\u0000-\u001f]/.test(line), JSON.stringify(line));
  assert.ok(line.length < 700, `la línea tiene tope (${line.length})`);
  const e = M.gitEnv({ GIT_DIR: '/otro', GIT_WORK_TREE: '/otro', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_SSH_COMMAND: 'ssh' });
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0']) assert.ok(!(k in e), k);
  assert.strictEqual(e.GIT_SSH_COMMAND, 'ssh', 'el ssh de la persona se queda');
  // de punta a punta: con GIT_DIR apuntando al clon `seed`, igual avanza `mant` y `seed` no se toca
  const lab = makeLab();
  upstreamCommit(lab, 'a.md');
  const seedHead = originMain(lab);
  const r = runPiece(lab, { GIT_DIR: path.join(lab.seed, '.git') });
  assert.strictEqual(r.status, 'avanzo', JSON.stringify(r));
  assert.strictEqual(head(lab), seedHead);
  assert.strictEqual(originMain(lab), seedHead);
  // un permiso con «/» y uno en la consulta tampoco pasan
  const red = M.redact("fatal: unable to access 'https://u:ab/cd@h.invalid/x?token=SECRETO123': 500");
  assert.ok(!red.includes('ab/cd') && !red.includes('SECRETO123'), red);
});

// ── casos de borde (una prueba por caso) ────────────────────────────────────────────────────

test('T31 Adv_RenameInWorktreeColumn — un renombre en la columna del árbol (add -N) nombra sólo la ruta nueva', () => {
  const lab = makeLab();
  fs.renameSync(path.join(lab.mant, 'README.md'), path.join(lab.mant, 'LEEME-LARGO.md'));
  git(lab, lab.mant, ['add', '-N', 'LEEME-LARGO.md']);
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'cambios-propios');
  assert.deepStrictEqual(r.files, ['LEEME-LARGO.md'], JSON.stringify(r.files));
  assert.strictEqual(r.more, 0);
});

test('T32 Adv_FetchRefspecWithoutMain — un clon que no mapea main igual trae origin/main y avanza', () => {
  const lab = makeLab();
  git(lab, lab.mant, ['config', 'remote.origin.fetch', '+refs/heads/dev:refs/remotes/origin/dev']);
  upstreamCommit(lab, 'a.md');
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'avanzo', JSON.stringify(r));
  assert.strictEqual(head(lab), originMain(lab));
});

test('T33 Adv_ClassifyNumbersInNetworkErrors — un 401/403 suelto (milisegundos, puerto, host) no es permiso', () => {
  const M = require(PIECE);
  assert.strictEqual(M.classifyFetchError('fatal: unable to access: Failed to connect to h port 443 after 403 ms: Connection refused', false), 'sin-red');
  assert.strictEqual(M.classifyFetchError('fatal: unable to access: Could not resolve host: git-401.corp', false), 'sin-red');
  assert.strictEqual(M.classifyFetchError('ssh: connect to host 10.0.0.1 port 403: Operation timed out', false), 'sin-red');
  assert.strictEqual(M.classifyFetchError("fatal: unable to access 'https://h/x/': The requested URL returned error: 403", false), 'sin-permiso');
  assert.strictEqual(M.classifyFetchError('fatal: unable to access: Received HTTP code 407 from proxy after CONNECT', false), 'sin-permiso');
});

test('T34 Adv_UntrackedPrefixCollision — un sin seguimiento que choca como carpeta o archivo se nombra', () => {
  const lab = makeLab();
  write(path.join(lab.mant, 'foo'), 'suelto\n');
  upstreamCommit(lab, path.join('foo', 'bar.md'));
  let r = runPiece(lab);
  assert.strictEqual(r.status, 'archivos-traban', JSON.stringify(r));
  assert.deepStrictEqual(r.files, ['foo']);
  // al revés: una carpeta sin seguimiento donde lo nuevo trae un archivo
  const lab2 = makeLab();
  write(path.join(lab2.mant, 'baz', 'q.md'), 'suelto\n');
  upstreamCommit(lab2, 'baz');
  r = runPiece(lab2);
  assert.strictEqual(r.status, 'archivos-traban', JSON.stringify(r));
  assert.deepStrictEqual(r.files, ['baz/q.md']);
});

test('T35 Adv_RedactKeepsLongPathSegments — una ruta o una rama larga no se tapa; un permiso suelto sí', () => {
  const M = require(PIECE);
  const seg = 'abc123def456ghi789jkl012mno345pqr678';
  const red = M.redact(`fatal: '/srv/git/${seg}/x.git' does not appear to be a git repository`);
  assert.ok(red.includes(seg), red);
  assert.ok(M.redact(`error: rama feat/${seg}`).includes(seg));
  // armado por partes: escrito entero, el freno de publicar lo lee como un permiso de verdad (y tiene razón en frenarlo)
  const fakePat = ['ghp', 'abcdefghij1234567890abcdefghij123456'].join('_');
  assert.ok(!M.redact(`remote: invalid credentials ${fakePat}`).includes('abcdefghij1234567890'));
});

test('T37 ErrorBranches_SubfolderLockLaunchAndMore — subcarpeta, candado imposible, lanzamiento que tira, y «y N más»', () => {
  const M = require(PIECE);
  // una subcarpeta de un clon no es su raíz
  const lab = makeLab({ declare: false });
  fs.mkdirSync(path.join(lab.mant, 'sub'));
  setConfig(lab, { paths: { maintainers: path.join(lab.mant, 'sub') } });
  let r = runPiece(lab);
  assert.strictEqual(r.status, 'no-sirve');
  // el candado no se puede crear ni pisar (una carpeta en su lugar): fallo escrito con el motivo, no «ocupado»
  setConfig(lab, { paths: { maintainers: lab.mant } });
  fs.mkdirSync(lockFile(lab));
  r = runPiece(lab);
  assert.strictEqual(r.status, 'fallo', JSON.stringify(r));
  assert.match(readResult(lab).detail, /candado/);
  fs.rmSync(lockFile(lab), { recursive: true });
  // un lanzamiento que tira (un valor del ambiente con un NUL) deja un fallo escrito para la sesión siguiente
  fs.rmSync(resultFile(lab));
  const saved = process.env.TYCON_HOME;
  process.env.TYCON_HOME = lab.tycon;
  try {
    const out = M.launch({ env: { ...labEnv(lab), RARO: `a${String.fromCharCode(0)}b` }, home: lab.home, platform: 'darwin' });
    assert.strictEqual(out.launched, false);
  } finally { if (saved === undefined) delete process.env.TYCON_HOME; else process.env.TYCON_HOME = saved; }
  assert.strictEqual(readResult(lab).status, 'fallo');
  assert.match(readResult(lab).detail, /no se pudo lanzar/);
  // más de cinco archivos: cinco nombrados y «y N más»
  for (let i = 0; i < 7; i++) { write(path.join(lab.seed, `f${i}.md`), 'x\n'); git(lab, lab.seed, ['add', `f${i}.md`]); }
  git(lab, lab.seed, ['commit', '-qm', 'siete']);
  git(lab, lab.seed, ['push', '-q', 'origin', 'main']);
  git(lab, lab.mant, ['pull', '-q', '--ff-only']);
  for (let i = 0; i < 7; i++) write(path.join(lab.mant, `f${i}.md`), 'tocado\n');
  r = runPiece(lab);
  assert.strictEqual(r.status, 'cambios-propios');
  assert.strictEqual(r.files.length, 5);
  assert.strictEqual(r.more, 2);
  assert.match(M.noticeLine(r), / y 2 más/);
});

test('T38 Iter2_RedactEnvInvisibleAndRelay — más formas de permiso, más variables de git, invisibles y el relevo', () => {
  const M = require(PIECE);
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'c2lnbmF0dXJh'].join('.');   // por partes, por el freno de publicar
  for (const t of [`remote: Authorization: Bearer ${jwt}`, `error en ${jwt}`, 'https://h/x?api_key=corto-1&client_secret=s.e-c', "https://u:pa'ss@h.invalid/x"]) {
    const red = M.redact(t);
    assert.ok(!red.includes('c2lnbmF0dXJh') && !red.includes('corto-1') && !red.includes('s.e-c') && !red.includes("pa'ss"), `${t} → ${red}`);
  }
  const e = M.gitEnv({ GIT_IMPLICIT_WORK_TREE: '1', GIT_QUARANTINE_PATH: '/q', GIT_SHALLOW_FILE: '/s', GIT_REPLACE_REF_BASE: 'x', GIT_NO_REPLACE_OBJECTS: '1', Git_Dir: '/otro' });
  for (const k of ['GIT_IMPLICIT_WORK_TREE', 'GIT_QUARANTINE_PATH', 'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'Git_Dir']) assert.ok(!(k in e), k);
  const hidden = ['a', String.fromCharCode(0x202e), 'b', String.fromCharCode(0x200b), 'c', String.fromCharCode(0x2066), 'd', String.fromCharCode(0xfeff)].join('');
  assert.strictEqual(M.clean(hidden), 'a b c d');
  // el relevo: deja un fallo sólo si el trabajador no dejó lo suyo
  const t0 = Date.now();
  assert.strictEqual(M.relayFailure({ status: 0 }, t0, { at: new Date(t0 + 50).toISOString() }), null);
  assert.strictEqual(M.relayFailure({ status: 0 }, t0, null), null);
  assert.match(M.relayFailure({ error: { code: 'ETIMEDOUT' } }, t0, null), /cortó/);
  assert.match(M.relayFailure({ error: { code: 'ENOENT' } }, t0, { at: new Date(t0 - 60000).toISOString() }), /no pudo correr/);
  assert.match(M.relayFailure({ status: null, signal: 'SIGKILL' }, t0, null), /terminó mal/);
});

test('T36 Adv_UntrackedLeadingSpaceName — un nombre con espacio adelante choca igual, aunque sea el primero', () => {
  const lab = makeLab();
  write(path.join(lab.mant, ' lead.md'), 'mío\n');
  upstreamCommit(lab, ' lead.md', 'publicado\n');
  const r = runPiece(lab);
  assert.strictEqual(r.status, 'archivos-traban', JSON.stringify(r));
  assert.deepStrictEqual(r.files, [' lead.md']);
});
