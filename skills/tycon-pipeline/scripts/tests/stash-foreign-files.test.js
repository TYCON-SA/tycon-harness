'use strict';

/**
 * stash-foreign-files.test.js — con otra sesión viva, ningún `git stash` se lleva archivos de otra sesión, y nadie borra
 * ni aplica lo que guardó otra. Los casos, abajo.
 *
 * El caso: dos historias corrieron sobre el mismo checkout; un `git stash` de una se llevó los archivos de la otra, con
 * la carpeta de su corrida, y la otra rehízo todo. Cada caso corre el gate real (on-bash-write-gate.js) con una HOME de
 * juguete y un repo de juguete; la otra sesión vive por su marcador. Ninguno mira las sesiones reales de la máquina.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const GATE = path.join(SCRIPTS, 'on-bash-write-gate.js');
const MIA = 'bbbb2222-la-mia';
const OTRA = 'aaaa1111-la-otra';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `stash-${p}-`)));
const stateDir = (home) => require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(home);
function entorno(home, extra = {}) {
  const env = { ...process.env };
  for (const k of ['TYCON_GUIDES_DIR', 'TCG', 'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_HOME', 'TYCON_STATE_DIR', 'CLAUDE_CODE_SESSION_ID',
    'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'TYCON_NO_RUN_CHANGE', 'TYCON_STASH_GUARD_OK']) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'acme@example.invalid', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'acme@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-01-15T12:00:00Z', ...extra };
}
const git = (home, dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: entorno(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Un repo con a.md, b.md, c.md y d.md commiteados y `.advisors/` ignorado (como en los repos de producto). */
function laboratorio(nombre = 'producto') {
  const home = tmp('home');
  const repo = path.join(tmp('lab'), nombre);
  fs.mkdirSync(repo);
  git(home, repo, 'init', '-q', '-b', 'trabajo');
  for (const f of ['a.md', 'b.md', 'c.md', 'd.md']) fs.writeFileSync(path.join(repo, f), `${f}\n`);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.advisors/\n');
  git(home, repo, 'add', '-A');
  git(home, repo, 'commit', '-q', '-m', 'inicio');
  return { home, repo };
}
// stable-data: el freno mide la vida de un marcador contra el reloj real, así que el marcador tiene que ser de ahora
function marcador(L, sid, fields) {
  const dir = path.join(stateDir(L.home), 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: '9.9', stepsPending: ['implement'], repoPath: L.repo, lastTouch: new Date().toISOString(), filesTouched: [], ...fields }));
}
function runDir(L, nombre) {
  const d = path.join(L.repo, '.advisors', 'pipeline-runs', nombre);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'step-02-bmad-plan.md'), '# plan\n');
  return d;
}
const cambiar = (L, ...fs_) => { for (const f of fs_) fs.writeFileSync(path.join(L.repo, f), `${f} cambiado\n`); };
function gate(L, command, { sid = MIA, cwd = L.repo, extra = {} } = {}) {
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sid, cwd, tool_input: { command } };
  return spawnSync(process.execPath, [GATE], { input: JSON.stringify(ev), env: entorno(L.home, extra), encoding: 'utf8', cwd });
}
/** Lo de siempre: la otra sesión con a.md y su corrida, la propia con b.md y la suya; a, b y c cambiados. */
function dosSesiones(L) {
  const suRun = runDir(L, '9.9-otra');
  const miRun = runDir(L, '8.8-mia');
  marcador(L, OTRA, { storyId: '9.9', filesTouched: [path.join(L.repo, 'a.md')], runDir: suRun });
  marcador(L, MIA, { storyId: '8.8', filesTouched: [path.join(L.repo, 'b.md')], runDir: miRun });
  cambiar(L, 'a.md', 'b.md', 'c.md');
  return { suRun, miRun };
}

test('SF1 Stash_TakesForeignFile_Blocks @story-8.292 @ac-12', () => {
  // 🔴 mutación: dejar pasar el stash que se lleva a.md (de la otra) o c.md (sin dueño), o frenar el que sólo lleva lo propio
  const L = laboratorio();
  const { miRun } = dosSesiones(L);
  for (const cmd of ['git stash', `git -C ${L.repo} stash push -u`, `cd ${L.repo} && git stash save x`]) {
    const r = gate(L, cmd, { cwd: cmd.startsWith('git stash') ? L.repo : os.tmpdir() });
    assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /a\.md.*aaaa1111/, cmd);
    assert.match(r.stderr, /c\.md.*ninguna sesión lo reclama/, cmd);
    assert.match(r.stderr, /git stash push -m "\[sesión bbbb2222\] [^"]*" -- b\.md/, cmd);
    assert.match(r.stderr, /TYCON_STASH_GUARD_OK=1/, cmd);
    assert.match(r.stderr, /la persona/, cmd);
  }
  assert.strictEqual(gate(L, 'git stash push -m "[sesión bbbb2222] mío" -- b.md').status, 0, 'el comando que sugiere pasa');
  assert.strictEqual(gate(L, `git stash push -u -- ${path.relative(L.repo, miRun)}`).status, 0, 'su propia corrida pasa');
  // (d) lo que la propia escribe por consola cuenta como suyo (el registro del gate), sin tocar el marcador
  const antes = fs.readFileSync(path.join(stateDir(L.home), 'active', `${MIA}.json`), 'utf8');
  const sed = gate(L, "sed -i '' 's/d/D/' d.md");
  assert.strictEqual(sed.status, 0, sed.stderr);
  cambiar(L, 'd.md');
  assert.strictEqual(gate(L, 'git stash push -- b.md d.md').status, 0, 'd.md es suyo por el registro de consola');
  assert.strictEqual(fs.readFileSync(path.join(stateDir(L.home), 'active', `${MIA}.json`), 'utf8'), antes, 'el marcador no cambia');
  // (e) el checkout por un enlace: lo propio sigue siendo propio
  const enlace = path.join(path.dirname(path.dirname(L.repo)), `enlace-${path.basename(path.dirname(L.repo))}`);
  fs.symlinkSync(path.dirname(L.repo), enlace);
  const porEnlace = path.join(enlace, 'producto');
  marcador(L, MIA, { storyId: '8.8', filesTouched: [path.join(porEnlace, 'b.md')], runDir: path.join(porEnlace, '.advisors', 'pipeline-runs', '8.8-mia') });
  assert.strictEqual(gate(L, 'git stash push -- b.md', { cwd: porEnlace }).status, 0, 'b.md por el enlace sigue siendo propio');
});

test('SF2 Stash_NoOwnMarker_RunDirOrClaimed_Blocks @story-8.292 @ac-13', () => {
  // 🔴 mutación: frenar sin marcador propio lo que nadie reclama, o dejar pasar la corrida de la otra
  const L = laboratorio();
  const suRun = runDir(L, '9.9-otra');
  marcador(L, OTRA, { storyId: '9.9', filesTouched: [path.join(L.repo, 'a.md')], runDir: suRun });
  // (a) sólo cambia un archivo que nadie reclama
  cambiar(L, 'c.md');
  assert.strictEqual(gate(L, 'git stash').status, 0);
  // (b) la carpeta de la corrida de la otra, ignorada por .gitignore: `-a` la lleva, `-u` no
  const a = gate(L, 'git stash -a');
  assert.strictEqual(a.status, 2, a.stderr);
  assert.match(a.stderr, /corrida de la sesión aaaa1111/);
  assert.strictEqual(gate(L, 'git stash -u').status, 0, '-u no lleva lo ignorado');
});

test('SF3 StashDropClearPop_NotOwn_Blocks @story-8.292 @ac-14', () => {
  // 🔴 mutación: dejar borrar o aplicar la entrada de otra, o frenar la propia (con marca, o sin marca con sus archivos)
  const L = laboratorio();
  marcador(L, MIA, { storyId: '8.8', filesTouched: [path.join(L.repo, 'b.md')] });
  // (c) la entrada de la otra (sin marca, con a.md), hecha antes de todo
  cambiar(L, 'a.md');
  git(L.home, L.repo, 'stash', 'push', '-m', 'de la otra');
  // (b) sin marca, con sólo lo propio, hecha cuando la sesión estaba sola
  cambiar(L, 'b.md');
  git(L.home, L.repo, 'stash', 'push', '-m', 'mío sin marca');
  // (a) con la marca propia
  cambiar(L, 'c.md');
  git(L.home, L.repo, 'stash', 'push', '-m', '[sesión bbbb2222] mío');
  marcador(L, OTRA, { storyId: '9.9', filesTouched: [path.join(L.repo, 'a.md')] });
  // la pila: stash@{0} con marca, @{1} sin marca propia, @{2} de la otra
  assert.strictEqual(gate(L, 'git stash list').status, 0);
  assert.strictEqual(gate(L, 'git stash show stash@{2}').status, 0);
  const clear = gate(L, 'git stash clear');
  assert.strictEqual(clear.status, 2, clear.stderr);
  const ajena = gate(L, 'git stash drop stash@{2}');
  assert.strictEqual(ajena.status, 2, ajena.stderr);
  assert.match(ajena.stderr, /TYCON_STASH_GUARD_OK=1/);
  assert.strictEqual(gate(L, 'git stash pop stash@{2}').status, 2);
  assert.strictEqual(gate(L, 'git stash pop').status, 0, 'la de la marca propia');
  assert.strictEqual(gate(L, 'git stash drop stash@{1}').status, 0, 'la sin marca con sólo lo propio');
  // (d) la propia sola en su copia; la otra viva en el checkout principal: la pila es común
  const copia = `${L.repo}--wt-x`;
  git(L.home, L.repo, 'worktree', 'add', '-q', '-b', 'wt/x', copia);
  marcador(L, MIA, { storyId: '8.8', repoPath: copia, filesTouched: [] });
  assert.strictEqual(gate(L, 'git stash clear', { cwd: copia }).status, 2, 'clear desde la copia');
  assert.strictEqual(gate(L, 'git stash drop stash@{2}', { cwd: copia }).status, 2, 'drop de la entrada de la otra desde la copia');
});

test('SF4 Stash_Alone_Or_Escape_Passes @story-8.292 @ac-15 @ac-16', () => {
  // 🔴 mutación: frenar estando sola, ignorar el escape de la persona, o callar cuando no se puede calcular
  const L = laboratorio();
  marcador(L, MIA, { storyId: '8.8' });
  cambiar(L, 'a.md', 'c.md');
  // (a) sola: pasa todo
  for (const c of ['git stash', 'git stash -a', 'git stash clear', 'git stash drop']) assert.strictEqual(gate(L, c).status, 0, c);
  // (b) con otra viva y el escape pegado: pasa con constancia
  marcador(L, OTRA, { storyId: '9.9', filesTouched: [path.join(L.repo, 'a.md')] });
  const esc = gate(L, 'TYCON_STASH_GUARD_OK=1 git stash');
  assert.strictEqual(esc.status, 0, esc.stderr);
  assert.match(esc.stderr, /TYCON_STASH_GUARD_OK=1/);
  const log = fs.readFileSync(path.join(stateDir(L.home), 'bypass.log'), 'utf8');
  assert.match(log, /STASH_GUARD_OK/);
  // (c) git no puede calcular (el índice roto) y la otra tiene corrida abierta: frena y lo dice
  fs.writeFileSync(path.join(L.repo, '.git', 'index'), 'roto');
  const roto = gate(L, 'git stash');
  assert.strictEqual(roto.status, 2, roto.stderr);
  assert.match(roto.stderr, /no pude calcular/);
});

test('SF6 Stash_MessageGluedToFlags_IsNotAPath @story-8.292 @ac-12', () => {
  // 🔴 mutación: tomar el mensaje por una ruta: el filtro no coincide con nada y el stash ajeno pasa
  const L = laboratorio();
  dosSesiones(L);
  for (const cmd of ['git stash push -um "wip"', 'git stash push -qum wip', 'git stash push -m"a b"', 'git stash push --message="a b" -u', "git stash push -u --message='a b'"]) {
    const r = gate(L, cmd);
    assert.strictEqual(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /a\.md.*aaaa1111/, cmd);
  }
  assert.strictEqual(gate(L, 'git stash push -m"[sesión bbbb2222] mío" -- b.md').status, 0, 'con rutas propias, el mensaje pegado pasa');
});

test('SF7 Stash_FileNamesWithAccentsOrSpaces_AreRecognized @story-8.292 @ac-12 @ac-14', () => {
  // 🔴 mutación: leer los nombres de git sin -z: salen entre comillas y con escapes, y no coinciden con ninguna ruta
  const L = laboratorio();
  const mio = 'acción mía.md';
  const suyo = 'decisión.md';
  fs.writeFileSync(path.join(L.repo, mio), 'x\n');
  fs.writeFileSync(path.join(L.repo, suyo), 'x\n');
  git(L.home, L.repo, 'add', '-A');
  git(L.home, L.repo, 'commit', '-q', '-m', 'con acentos');
  marcador(L, OTRA, { storyId: '9.9', filesTouched: [path.join(L.repo, suyo)] });
  marcador(L, MIA, { storyId: '8.8', filesTouched: [path.join(L.repo, mio)] });
  cambiar(L, mio);
  assert.strictEqual(gate(L, 'git stash').status, 0, 'sólo lo propio, con acento y espacio');
  cambiar(L, suyo);
  const r = gate(L, 'git stash');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /decisión\.md.*aaaa1111/);
  assert.ok(r.stderr.includes(`-- '${mio}'`), r.stderr);
  // una entrada sin marca con sólo lo propio, con acento: es de la sesión
  git(L.home, L.repo, 'checkout', '-q', '--', suyo);
  git(L.home, L.repo, 'stash', 'push', '-q', '-m', 'sin marca');
  const pop = gate(L, 'git stash pop');
  assert.strictEqual(pop.status, 0, pop.stderr);
});

test('SF8 Stash_LetsThroughUnmeasured_SaysSo @story-8.292 @ac-16', () => {
  // 🔴 mutación: dejar pasar sin decir nada cuando git falla o cuando no se puede leer lo que la sesión escribió
  const { evaluar } = require(path.join(SCRIPTS, 'lib', 'stash-guard.js'));
  const otraPorTranscripcion = (L) => {
    const dir = path.join(L.home, '.claude', 'projects', L.repo.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${OTRA}.jsonl`), `${JSON.stringify({ type: 'user', cwd: L.repo, message: { role: 'user', content: 'pedido' } })}\n`);
  };
  const correr = (L) => {
    const avisos = [];
    const v = evaluar({ cmd: 'git stash', cwd: L.repo, sessionId: MIA, stateDir: stateDir(L.home), home: L.home, avisar: (m) => avisos.push(m) });
    return { v, avisos };
  };
  // (a) git no calcula y la otra sesión no tiene corrida abierta: pasa, y queda dicho
  const A = laboratorio();
  otraPorTranscripcion(A);
  fs.writeFileSync(path.join(A.repo, '.git', 'index'), 'roto');
  const a = correr(A);
  assert.strictEqual(a.v, null);
  assert.ok(a.avisos.some((m) => /no pude calcular/.test(m)), a.avisos.join('\n'));
  // (b) el marcador propio no se lee
  const B = laboratorio();
  otraPorTranscripcion(B);
  fs.mkdirSync(path.join(stateDir(B.home), 'active'), { recursive: true });
  fs.writeFileSync(path.join(stateDir(B.home), 'active', `${MIA}.json`), '{roto');
  const b = correr(B);
  assert.ok(b.avisos.some((m) => /marcador/.test(m) && /bbbb2222/.test(m)), b.avisos.join('\n'));
  // (c) el registro de lo escrito por consola no se lee
  const C = laboratorio();
  otraPorTranscripcion(C);
  marcador(C, MIA, { storyId: '8.8' });
  fs.mkdirSync(path.join(stateDir(C.home), 'console-writes', `${MIA}.jsonl`), { recursive: true });
  const c = correr(C);
  assert.ok(c.avisos.some((m) => /consola/.test(m) && /bbbb2222/.test(m)), c.avisos.join('\n'));
  // (d) las sesiones vivas no se pueden leer: pasa porque no ve a nadie, y lo dice
  if (!(process.getuid && process.getuid() === 0)) {
    const D = laboratorio();
    cambiar(D, 'a.md');
    const projects = path.join(D.home, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    fs.chmodSync(projects, 0o000);
    try {
      const d = correr(D);
      assert.strictEqual(d.v, null);
      assert.ok(d.avisos.some((m) => /no pude leer las transcripciones/.test(m)), d.avisos.join('\n'));
    } finally { fs.chmodSync(projects, 0o755); }
  }
});

test('SF5 MergeToMain_NoStashOptionWithOtherSession_GuideSaysIt @story-8.292 @ac-17 @ac-18', () => {
  // 🔴 mutación: ofrecer el stash con otra sesión viva, devolver stash@{0} en vez de la entrada marcada, o dejar la guía vieja
  const merge = (f) => fs.readFileSync(path.join(RAIZ, 'skills', 'tycon-merge-to-main', 'steps', f), 'utf8');
  const pre = merge('step-00-preflight.md');
  assert.match(pre, /live-sessions\.js --root/);
  assert.match(pre, /otra sesión viva[\s\S]{0,400}\(a\)/);
  assert.match(pre, /git stash push -m "\[sesión <id corto>\] pre-merge stash"/);
  for (const f of ['step-03-hitl-confirm-merge.md', 'step-10-summary.md']) {
    const t = merge(f);
    assert.match(t, /\[sesión <id corto>\] pre-merge stash/, f);
    assert.doesNotMatch(t, /ejecutar `git stash pop`\.|ofrecer `git stash pop` para/, f);
  }
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'git-worktrees.md'), 'utf8');
  const recuadro = guia.slice(0, guia.indexOf('## 2'));
  assert.doesNotMatch(recuadro, /hoy retirado/);
  assert.match(recuadro, /arranque de una historia crea su copia/);
  assert.match(recuadro, /aviso de llegada sale siempre/);
  assert.match(recuadro, /stash que se llevaría archivos de otra sesión/);
  assert.match(recuadro, /TYCON_STASH_GUARD_OK=1/);
});
