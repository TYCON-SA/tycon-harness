#!/usr/bin/env node
/**
 * touched-files.test.js — ¿qué archivos toca la story, y SE SABE?
 *
 * El test-gate del arnés deja de correr exportador-real (24-41 min) cuando la story no toca
 * su carpeta de publicación (en este laboratorio, `scripts/lab-pub/**`). Esa decisión se apoya en esta lib, así que la pregunta que importa no es
 * sólo «¿toca?» sino «¿se pudo mirar?»: si git falla o no hay de dónde sacar los cambios, la respuesta
 * es `known: false` y el gate corre todo. «No pude mirar» nunca se lee como «no toca».
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib', 'touched-files.js');
// Los archivos del laboratorio llevan nombres que no existen en el arnés: la copia pública traduce las rutas del arnés
// ya renombradas, y una ruta real aquí se traduciría a medias.
const PUBLICATION = ['scripts/lab-pub/**'];

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Repo git de laboratorio con un commit base; devuelve { repo, base, write, story }. */
function lab() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touched-files-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  const write = (rel, body = 'x\n') => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  write('scripts/lab-pub/lab-tool.js', 'module.exports = 1;\n');
  write('scripts/hooks/x.js', 'module.exports = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const story = (declared) => {
    const p = path.join(root, 'story.md');
    fs.writeFileSync(p, ['---', 'epic: 9', 'story: "9.9"', 'status: in-progress',
      'files_to_modify:', ...declared.map((d) => `  - "${d}"`), '---', '', '# Story 9.9', ''].join('\n'));
    return p;
  };
  return { root, repo, base, write, story };
}

test('T1 TouchedFiles_DeclaredButUnchanged_DoesNotTouch — lo que la story declara y la corrida no cambió NO cuenta', () => {
  // El corte es el cambio REAL, no la lista de la story. Una story
  // de varias tandas declara archivos de las tandas que vienen; sumarlos haría correr exportador-real (más de
  // 10 min) en una tanda que no toca la publicación. Lo commiteado antes de la
  // base es de una tanda anterior, que ya pasó su control; lo que la corrida cambia lo ve el diff.
  // 🔴 rojo si: volver a sumar `sources.declared` a `files` → la declarada sin cambio «toca».
  const { touchedFiles, touches } = require(LIB);
  const L = lab();
  const r = touchedFiles({ repo: L.repo, storyPath: L.story(['scripts/lab-pub/lab-tool.js']), baseRef: L.base });
  assert.equal(r.known, true, `esperaba known:true y salió ${JSON.stringify(r)}`);
  assert.ok(!r.files.includes('scripts/lab-pub/lab-tool.js'), `lo declarado sin cambio no entra: ${JSON.stringify(r.files)}`);
  assert.deepEqual(r.sources.declared, ['scripts/lab-pub/lab-tool.js'], 'lo declarado queda como dato');
  assert.equal(touches(r.files, PUBLICATION), false);
});

test('T2 TouchedFiles_InDiffOrUntracked_Touches — un cambio real bajo la carpeta cuenta aunque la story no lo declare', () => {
  // 🔴 rojo si: mirar sólo lo declarado → la story que edita exportar.js sin declararlo se saltea
  //    la única prueba que mira la copia pública.
  const { touchedFiles, touches } = require(LIB);
  const modified = lab();
  modified.write('scripts/lab-pub/lab-tool.js', 'module.exports = 2;\n');
  const r1 = touchedFiles({ repo: modified.repo, storyPath: modified.story(['scripts/hooks/x.js']), baseRef: modified.base });
  assert.equal(r1.known, true);
  assert.equal(touches(r1.files, PUBLICATION), true, 'el archivo modificado bajo la carpeta cuenta');

  // 🔴 rojo si: `git diff` sin `ls-files --others` → un archivo NUEVO sin agregar al índice no se ve.
  const untracked = lab();
  untracked.write('scripts/lab-pub/nuevo.js', 'module.exports = 3;\n');
  const r2 = touchedFiles({ repo: untracked.repo, storyPath: untracked.story(['scripts/hooks/x.js']), baseRef: untracked.base });
  assert.equal(r2.known, true);
  assert.equal(touches(r2.files, PUBLICATION), true, 'el archivo sin trackear bajo la carpeta cuenta');
});

test('T3 TouchedFiles_NothingUnderPrefix_DoesNotTouch — fuera de la carpeta, y lo de otro repo no confunde', () => {
  // 🔴 rojo si: un patrón que compara por substring (`includes('lab-pub')`) → `scripts/lab-pub-old/`
  //    o una entrada `(agent-skills) …/lab-pub/…` de OTRO repo harían correr la suite de más.
  const { touchedFiles, touches } = require(LIB);
  const L = lab();
  L.write('scripts/hooks/x.js', 'module.exports = 9;\n');
  L.write('scripts/lab-pub-old/y.js', 'y\n');
  const r = touchedFiles({ repo: L.repo,
    storyPath: L.story(['scripts/hooks/x.js', '(agent-skills) skills/tycon-pipeline/scripts/lab-pub/z.js']), baseRef: L.base });
  assert.equal(r.known, true);
  assert.ok(!r.files.some((f) => f.startsWith('(')), 'las entradas de otro repo no entran a la lista');
  assert.equal(touches(r.files, PUBLICATION), false);
});

test('T4 TouchedFiles_NoStoryNoGit_Unknown — sin story y sin git, no se sabe (nunca «no toca»)', () => {
  // 🔴 rojo si: devolver `{ known: true, files: [] }` cuando no hay de dónde mirar → el gate
  //    difiere exportador-real sin haber mirado nada.
  const { touchedFiles } = require(LIB);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touched-files-nogit-'));
  const r = touchedFiles({ repo: dir, storyPath: '', baseRef: null });
  assert.equal(r.known, false);
  assert.ok(r.reason && r.reason.length > 0, 'dice por qué no sabe');
});

test('T5 TouchedFiles_GitFails_Unknown — git que falla es «no sé», con el error de git', () => {
  // 🔴 rojo si: reusar `changedFiles` de test-scope.js, que traga el error y devuelve [] → «git falló»
  //    se lee igual que «no hay cambios».
  const { touchedFiles } = require(LIB);
  const L = lab();
  const r = touchedFiles({ repo: L.repo, storyPath: L.story(['scripts/hooks/x.js']), baseRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(r.known, false);
  assert.match(r.reason, /git/i, 'el motivo nombra a git');
});

test('T5 — el CLI imprime el mismo JSON (lo consume test-gate.sh)', () => {
  // 🔴 rojo si: CLI que imprime texto o sale ≠ 0 cuando no sabe → test-gate no puede distinguir.
  const L = lab();
  L.write('scripts/lab-pub/lab-tool.js', 'module.exports = 5;\n');
  const r = spawnSync(process.execPath, [LIB, L.repo, L.story([]), L.base], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.known, true);
  assert.ok(j.files.includes('scripts/lab-pub/lab-tool.js'));
});

// ── Tres falsos «no toca» que el código tiene que evitar ─────────────────────────────────────────

test('T24 TouchedFiles_RenameOutOfFolder_Touches —mover un archivo FUERA de la carpeta también la toca', () => {
  // 🔴 rojo si: `git diff --name-only` colapsa el renombre a la ruta destino → la de origen (bajo
  //    scripts/lab-pub/) desaparece y exportador-real se difiere aunque la carpeta perdió un archivo.
  const { touchedFiles, touches } = require(LIB);
  const L = lab();
  fs.mkdirSync(path.join(L.repo, 'scripts', 'otrolugar'), { recursive: true });
  git(L.repo, 'mv', 'scripts/lab-pub/lab-tool.js', 'scripts/otrolugar/lab-tool.js');
  git(L.repo, 'commit', '-q', '-m', 'mover');
  const r = touchedFiles({ repo: L.repo, storyPath: L.story([]), baseRef: L.base, baseSource: 'marcador' });
  assert.equal(r.known, true);
  assert.ok(r.files.includes('scripts/lab-pub/lab-tool.js'), `la ruta de origen tiene que estar: ${JSON.stringify(r.files)}`);
  assert.equal(touches(r.files, PUBLICATION), true);
});

test('T25 TouchedFiles_BaseFallbackToHead_Unknown —si la base cayó a HEAD por defecto, no se sabe', () => {
  // 🔴 rojo si: con la base = HEAD (sin marcador ni TYCON_COVERAGE_BASE: test-gate corrido a mano sobre
  //    un commit hecho) el diff no ve lo commiteado → known:true, «no toca», y se difiere con la carpeta tocada.
  const { touchedFiles } = require(LIB);
  const L = lab();
  L.write('scripts/lab-pub/lab-tool.js', 'module.exports = 7;\n');
  git(L.repo, 'commit', '-q', '-am', 'toca lab-pub');
  const head = git(L.repo, 'rev-parse', 'HEAD');
  const r = touchedFiles({ repo: L.repo, storyPath: L.story(['scripts/hooks/x.js']), baseRef: head, baseSource: 'HEAD' });
  assert.equal(r.known, false, 'base por defecto = no se sabe qué se commiteó');
  assert.match(r.reason, /HEAD/);
});

test('T26 Touches_DoubleSlashOrDotSegments_Invalid — una barra doble, un «.» o un «..» no son «<carpeta>/**»', () => {
  // 🔴 rojo si: la clase del segmento repetido no excluía «/» → «scripts//lab-pub/**» pasaba como válido,
  //    nunca calzaba con nada y la suite quedaba diferida SIEMPRE, sin el aviso de campo mal formado.
  const { isValidPattern } = require(LIB);
  for (const p of ['scripts//lab-pub/**', '//scripts/**', 'scripts/./lab-pub/**', '../scripts/**', 'scripts/../x/**']) {
    assert.equal(isValidPattern(p), false, `«${p}» no es válido`);
  }
  assert.equal(isValidPattern('scripts/lab-pub/**'), true);
  assert.equal(isValidPattern('a.b/c-d_e/**'), true, 'un punto dentro del nombre sí vale');
});

test('touches — sólo entiende «<carpeta>/**»; otra forma no se interpreta', () => {
  // 🔴 rojo si: tratar «scripts/lab-pub» (sin /**) como prefijo de texto → también calza
  //    «scripts/lab-pub-old/x.js».
  const { touches, isValidPattern } = require(LIB);
  assert.equal(isValidPattern('scripts/lab-pub/**'), true);
  assert.equal(isValidPattern('scripts/lab-pub'), false);
  assert.equal(isValidPattern('scripts/*.js'), false);
  assert.equal(isValidPattern('/abs/**'), false);
  assert.equal(touches(['scripts/lab-pub-old/x.js'], ['scripts/lab-pub']), false);
  assert.equal(touches(['scripts/lab-pub/a/b.js'], ['scripts/lab-pub/**']), true);
});

test('T27 TouchedFiles_EmptyWithBranchCommits_Unknown — nada tocado desde la base, pero la rama ya trae commits propios: no se sabe', () => {
  // 🔴 rojo si: con la base del marcador en la punta y lo de la story ya commiteado, el diff sale vacío y se lee como
  //    «conocido y vacío» → el portón acotado sale verde sin correr ninguna suite.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  L.write('scripts/hooks/x.js', 'module.exports = 2;\n');
  git(L.repo, 'commit', '-q', '-am', 'lo de la story');
  const head = git(L.repo, 'rev-parse', 'HEAD');
  const r = touchedFiles({ repo: L.repo, storyPath: L.story(['scripts/hooks/x.js']), baseRef: head, baseSource: 'marker' });
  assert.equal(r.known, false, `vacío con commits propios de la rama = no se sabe: ${JSON.stringify(r)}`);
  assert.match(r.reason, /1 commit/);
});

test('T28 TouchedFiles_EmptyOnMain_Known — nada tocado y nada propio de la rama: se sabe que no hay nada', () => {
  // 🔴 rojo si: tratar todo vacío como «no sé» → una corrida sin cambios corre la suite entera.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  const r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: L.base, baseSource: 'marker' });
  assert.equal(r.known, true, JSON.stringify(r));
  assert.deepEqual(r.files, []);
});

test('T29 TouchedFiles_EmptyWithoutMainBranch_Unknown — vacío y sin rama principal contra la que contar: no se sabe', () => {
  // 🔴 rojo si: sin main ni master el conteo de commits propios falla y se sigue como «conocido y vacío».
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'trabajo');
  const r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: L.base, baseSource: 'marker' });
  assert.equal(r.known, false, JSON.stringify(r));
  assert.match(r.reason, /rama principal/);
});

test('T30 TouchedFiles_TipBaseWithBranchCommitsAndStrayFiles_Unknown — base en la punta y commits propios: un archivo suelto o un .md cambiado no lo vuelven «conocido»', () => {
  // 🔴 rojo si: los commits propios se miran sólo cuando lo tocado sale vacío → un archivo sin seguimiento o un .md
  //    cambiado dan una lista que ninguna suite lee y el portón acotado sale verde sin correr nada.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  L.write('scripts/hooks/x.js', 'module.exports = 2;\n');
  git(L.repo, 'commit', '-q', '-am', 'lo de la story');
  const head = git(L.repo, 'rev-parse', 'HEAD');
  L.write('notas.txt');
  let r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: head, baseSource: 'marker' });
  assert.equal(r.known, false, `archivo sin seguimiento: ${JSON.stringify(r)}`);
  assert.match(r.reason, /1 commit/);
  fs.rmSync(path.join(L.repo, 'notas.txt'));
  L.write('LEAME.md');
  git(L.repo, 'add', 'LEAME.md');
  git(L.repo, 'commit', '-q', '-m', 'un documento');
  const punta = git(L.repo, 'rev-parse', 'HEAD');
  L.write('LEAME.md', 'cambiado\n');
  r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: punta, baseSource: 'marker' });
  assert.equal(r.known, false, `.md cambiado: ${JSON.stringify(r)}`);
});

test('T31 TouchedFiles_BaseBehindTipWithStrayFile_Known — con la base atrás de la punta, el diff ya ve lo commiteado: se sabe', () => {
  // 🔴 rojo si: tratar todo commit propio como «no sé» aunque la base lo cubra → cada corrida acotada corre la suite entera.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  L.write('scripts/hooks/x.js', 'module.exports = 2;\n');
  git(L.repo, 'commit', '-q', '-am', 'lo de la story');
  L.write('notas.txt');
  const r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: L.base, baseSource: 'marker' });
  assert.equal(r.known, true, JSON.stringify(r));
  assert.deepEqual([...r.files].sort(), ['notas.txt', 'scripts/hooks/x.js']);
});

test('T32 TouchedFiles_BaseBehindTipByDocsCommit_Unknown — la base un commit detrás de la punta, y ese commit sólo trae documentación: no se sabe', () => {
  // 🔴 rojo si: el «no se sabe» depende de que la base esté justo en la punta → la story commiteada antes de la base y
  //    un commit de sólo .md encima dejan el diff con el .md y el portón acotado sale verde sin correr nada.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  L.write('scripts/hooks/x.js', 'module.exports = 2;\n');
  git(L.repo, 'commit', '-q', '-am', 'lo de la story');
  const desde = git(L.repo, 'rev-parse', 'HEAD');
  L.write('LEAME.md');
  git(L.repo, 'add', 'LEAME.md');
  git(L.repo, 'commit', '-q', '-m', 'un documento');
  const r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: desde, baseSource: 'marker' });
  assert.equal(r.known, false, JSON.stringify(r));
  assert.match(r.reason, /2 commit/);
});

test('T33 TouchedFiles_LaterBatchWithCodeChange_Known — una tanda posterior que cambia código con seguimiento: se sabe', () => {
  // 🔴 rojo si: los commits propios de una tanda anterior vuelven «no sé» toda corrida con la base en la punta → desde la
  //    segunda tanda el portón acotado corre la suite entera aunque el diff vea el cambio real.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  L.write('scripts/hooks/x.js', 'module.exports = 2;\n');
  git(L.repo, 'commit', '-q', '-am', 'la tanda anterior');
  const head = git(L.repo, 'rev-parse', 'HEAD');
  L.write('scripts/hooks/x.js', 'module.exports = 3;\n');
  L.write('LEAME.md');
  const r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: head, baseSource: 'marker' });
  assert.equal(r.known, true, JSON.stringify(r));
  assert.deepEqual([...r.files].sort(), ['LEAME.md', 'scripts/hooks/x.js']);
});

test('T34 TouchedFiles_LaterBatchOnlyNewFiles_Unknown — con commits propios, una tanda que sólo crea archivos nuevos corre todo (frena de más, aceptado)', () => {
  // 🔴 rojo si: un archivo sin seguimiento cuenta como cambio real con commits propios → un archivo suelto deja el
  //    portón acotado verde sin correr la story ya commiteada.
  const { touchedFiles } = require(LIB);
  const L = lab();
  git(L.repo, 'branch', '-M', 'main');
  git(L.repo, 'checkout', '-q', '-b', 'story');
  L.write('scripts/hooks/x.js', 'module.exports = 2;\n');
  git(L.repo, 'commit', '-q', '-am', 'la tanda anterior');
  const head = git(L.repo, 'rev-parse', 'HEAD');
  L.write('scripts/hooks/nuevo.js', 'module.exports = 1;\n');
  const r = touchedFiles({ repo: L.repo, storyPath: '', baseRef: head, baseSource: 'marker' });
  assert.equal(r.known, false, JSON.stringify(r));
  assert.match(r.reason, /1 commit/);
});
