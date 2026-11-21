'use strict';
/**
 * main-advances-during-run.test.js — cuando main avanza durante una corrida, el sello de lo revisado y «cambios sin
 * declarar» no se contradicen.
 *
 * El caso: la corrida cambia su código y se sella la vuelta de revisores. Mientras tanto main pasa otra historia a done
 * (su archivo y su renglón en sprint-status). Al cerrar, la corrida pasa su propio renglón a review. Con la rama al día
 * con main, o sin traerlo, ninguno de los dos controles puede pedir otra vuelta o una firma por lo que trajo main.
 *
 * Los dos controles corren sobre un repo de juguete con su origin y otro clon que hace avanzar main. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');
const ft = () => require(path.join(LIB, 'frozen-tree.js'));
const uc = () => require(path.join(LIB, 'undeclared-changes.js'));
const FECHA = '2026-11-12T10:00:00Z';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const STORY = 'specs/story-9.1-corrida.md';
const OTRA = 'specs/story-9.2-otra.md';
const SPRINT = 'specs/sprint-status.yaml';
const historia = (n, estado, extra = []) => ['---', `story: "${n}"`, 'epic: "9"', `status: ${estado}`, ...extra, '---', '', `# Story ${n}`, ''].join('\n');
const sprint = (r1, r2) => ['development_status:', `  9-1-corrida: ${r1}`, `  9-2-otra: ${r2}`, ''].join('\n');

function laboratorio() {
  const base = tmp('main-avanza-');
  const origen = path.join(base, 'origen.git');
  const repo = path.join(base, 'repo');
  const otro = path.join(base, 'otro');
  const env = { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const en = (dir) => (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(repo);
  const git = en(repo);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origen);
  const escribir = (dir, archivos) => {
    for (const [rel, txt] of Object.entries(archivos)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), txt);
    }
  };
  escribir(repo, {
    'src/a.js': 'module.exports = 1;\n',
    [STORY]: historia('9.1', 'in-progress', ['files_to_modify:', '  - src/a.js']),
    [OTRA]: historia('9.2', 'in-progress'),
    [SPRINT]: sprint('in-progress', 'in-progress'),
  });
  git('add', '.');
  git('commit', '-qm', 'inicio');
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', 'story/9.1');
  const baseSha = git('rev-parse', 'HEAD');
  // la corrida cambia su código (con Edit) y lo commitea; después se sella la vuelta de revisores
  escribir(repo, { 'src/a.js': 'module.exports = 2;\n' });
  git('commit', '-qam', 'la corrida');
  const v = ft().sealAndFreeze({ stateDir: tmp('main-avanza-estado-'), sid: 's-main-avanza', etiqueta: 'rev-iter1', repos: [repo] });
  assert.ok(!v.error, v.error);
  execFileSync('git', ['clone', '-q', origen, otro], { env });
  const o = en(otro);
  // main cambia otros archivos mientras la corrida sigue
  // un archivo en null se borra; los nuevos se agregan
  const avanzarMain = (archivos) => {
    for (const [rel, txt] of Object.entries(archivos)) if (txt === null) fs.rmSync(path.join(otro, rel));
    escribir(otro, Object.fromEntries(Object.entries(archivos).filter(([, txt]) => txt !== null)));
    o('add', '-A');
    o('commit', '-qm', 'otro pedido');
    o('push', '-q', 'origin', 'main');
    git('fetch', '-q', 'origin');
  };
  // el cierre de la corrida pasa su historia y su renglón a review (con Edit: quedan registrados)
  const cerrar = () => {
    const s = fs.readFileSync(path.join(repo, SPRINT), 'utf8').replace('9-1-corrida: in-progress', '9-1-corrida: review');
    escribir(repo, { [SPRINT]: s, [STORY]: historia('9.1', 'review', ['files_to_modify:', '  - src/a.js']) });
  };
  const sello = () => {
    const ahora = ft().seal(repo);
    const pm = ft().puntoComunConMain(repo);
    return ft().changed(repo, v.repos[0].tree, ahora.tree, { storyRel: STORY, mainAntes: v.repos[0].mainBase, mainAhora: pm.sha || null });
  };
  const sinDeclarar = () => uc().computeUndeclared({ repo, baseSha, storyPath: path.join(repo, STORY),
    registrados: [path.join(repo, 'src', 'a.js'), path.join(repo, SPRINT), path.join(repo, STORY)] });
  return { repo, git, baseSha, avanzarMain, cerrar, sello, sinDeclarar };
}

const MAIN_92_DONE = { [OTRA]: historia('9.2', 'done'), [SPRINT]: sprint('in-progress', 'done') };

test('MainAdvances_BranchUpToDate_NeitherControlBlocks (T1)', () => {
  for (const como of ['merge', 'rebase']) {
    const L = laboratorio();
    L.avanzarMain(MAIN_92_DONE);
    if (como === 'merge') L.git('merge', '-q', '--no-edit', 'origin/main');
    else L.git('rebase', '-q', 'origin/main');
    L.cerrar();
    const s = L.sello();
    assert.ok(!s.error, s.error);
    assert.deepEqual(s.files, [], `${como}: el sello pide otra vuelta por lo que trajo main: ${JSON.stringify(s)}`);
    const u = L.sinDeclarar();
    assert.equal(u.medido, true, u.motivo);
    assert.deepEqual(u.sobra, [], `${como}: «cambios sin declarar» frena por lo que trajo main: ${JSON.stringify(u)}`);
  }
});

test('MainAdvances_BranchNotUpdated_NeitherControlBlocks (T2)', () => {
  const L = laboratorio();
  L.avanzarMain(MAIN_92_DONE);
  L.cerrar();
  const s = L.sello();
  assert.deepEqual(s.files, [], JSON.stringify(s));
  const u = L.sinDeclarar();
  assert.equal(u.medido, true, u.motivo);
  assert.deepEqual(u.sobra, [], JSON.stringify(u));
});

test('MainAdvances_AgainAfterMerge_NeitherControlBlocks (T3)', () => {
  // la rama trajo main, y main volvió a avanzar sobre los mismos archivos sin que la rama lo traiga otra vez
  const L = laboratorio();
  L.avanzarMain(MAIN_92_DONE);
  L.git('merge', '-q', '--no-edit', 'origin/main');
  L.cerrar();
  L.avanzarMain({ [OTRA]: historia('9.2', 'done', ['followed_up_by: "9.3"']), [SPRINT]: sprint('in-progress', 'done').replace('9-2-otra: done\n', '9-2-otra: done\n  9-3-nueva: backlog\n') });
  const s = L.sello();
  assert.deepEqual(s.files, [], JSON.stringify(s));
  const u = L.sinDeclarar();
  assert.equal(u.medido, true, u.motivo);
  assert.deepEqual(u.sobra, [], `lo que trajo el merge cuenta porque main volvió a cambiar: ${JSON.stringify(u)}`);
});

test('MainAdvances_RunTouchesOtherStory_StillCounts (T4)', () => {
  // control: si la corrida misma cambia la historia de otra por fuera de Edit, «cambios sin declarar» lo ve (para el
  // sello, una historia de specs/ es papeleo)
  for (const otraVez of [false, true]) {
    const L = laboratorio();
    L.avanzarMain(MAIN_92_DONE);
    L.git('merge', '-q', '--no-edit', 'origin/main');
    L.cerrar();
    if (otraVez) L.avanzarMain({ [OTRA]: historia('9.2', 'done', ['followed_up_by: "9.3"']) });
    fs.writeFileSync(path.join(L.repo, OTRA), historia('9.2', 'review'));
    assert.deepEqual(L.sinDeclarar().sobra, [OTRA], `main otra vez: ${otraVez}`);
  }
});

test('MainAdvances_BroughtThenMainRevertsOrDeletes_NotCounted (T6)', () => {
  // la rama trajo algo de main, y después main lo revierte, lo borra o lo renombra: lo de la rama sigue siendo de main
  const NUEVO = 'specs/nuevo.md';
  const casos = [
    ['revierte', { [OTRA]: historia('9.2', 'done') }, () => ({ [OTRA]: historia('9.2', 'in-progress') })],
    ['borra lo agregado', { [NUEVO]: 'nuevo\n' }, () => ({ [NUEVO]: null })],
    ['renombra lo agregado', { [NUEVO]: 'nuevo\n' }, () => ({ [NUEVO]: null, 'specs/renombrado.md': 'nuevo\n' })],
  ];
  for (const [nombre, primero, despues] of casos) {
    const L = laboratorio();
    L.avanzarMain(primero);
    L.git('merge', '-q', '--no-edit', 'origin/main');
    L.avanzarMain(despues());
    const u = L.sinDeclarar();
    assert.equal(u.medido, true, u.motivo);
    assert.deepEqual(u.sobra, [], `${nombre}: ${JSON.stringify(u)}`);
  }
});

test('MainAdvances_RunRevertsToOldMainVersion_StillCounts (T7)', () => {
  // un commit de la rama anterior al arranque cambió un archivo; la corrida lo devuelve por la terminal a la versión vieja
  // de main, la rama trae main (otro archivo) y main después cambia ese archivo: main nunca lo trajo, cuenta
  const L = laboratorio();
  fs.writeFileSync(path.join(L.repo, 'src', 'f.js'), 'de la tanda anterior\n');
  L.git('add', '.');
  L.git('commit', '-qm', 'tanda anterior');
  const base = L.git('rev-parse', 'HEAD');
  L.avanzarMain({ 'src/z.js': 'z de main\n' });
  L.git('merge', '-q', '--no-edit', 'origin/main');
  fs.rmSync(path.join(L.repo, 'src', 'f.js'));
  L.avanzarMain({ 'src/f.js': 'f de main\n' });
  const u = uc().computeUndeclared({ repo: L.repo, baseSha: base, storyPath: path.join(L.repo, STORY), registrados: [path.join(L.repo, 'src', 'a.js')] });
  assert.deepEqual(u.sobra, ['src/f.js'], JSON.stringify(u));
});

test('MainAdvances_SymlinkBroughtByMain_NotCounted (T8)', { skip: process.platform === 'win32' }, () => {
  // un enlace simbólico que trajo main se compara por su destino, como lo guarda git, también si queda colgando
  for (const destino of ['a.js', 'no-existe.js']) {
    const L = laboratorio();
    const otro = path.join(path.dirname(L.repo), 'otro');
    fs.symlinkSync(destino, path.join(otro, 'src', 'enlace'));
    L.avanzarMain({});
    L.git('merge', '-q', '--no-edit', 'origin/main');
    const u = L.sinDeclarar();
    assert.deepEqual(u.sobra, [], `${destino}: ${JSON.stringify(u)}`);
  }
});

test('MainAdvances_BranchBackToOlderMain_StillCounts (T9)', () => {
  // la corrida arranca con main traído y después la rama vuelve a un main anterior: lo viejo de main no es «traído»
  const L = laboratorio();
  const inicio = L.git('rev-parse', 'HEAD~1');
  L.avanzarMain({ 'src/b.js': 'b de main\n' });
  L.git('merge', '-q', '--no-edit', 'origin/main');
  const base = L.git('rev-parse', 'HEAD');
  L.git('reset', '-q', '--hard', inicio);
  fs.writeFileSync(path.join(L.repo, 'src', 'a.js'), 'module.exports = 3;\n');
  const u = uc().computeUndeclared({ repo: L.repo, baseSha: base, storyPath: path.join(L.repo, STORY), registrados: [path.join(L.repo, 'src', 'a.js')] });
  assert.deepEqual(u.sobra, ['src/b.js'], JSON.stringify(u));
});

test('MainAdvances_SprintRowBroughtThenMainMoves_NotCounted (T5)', () => {
  // el sprint-status que trajo el merge, sin el renglón propio registrado: main vuelve a sumar un renglón
  const L = laboratorio();
  L.avanzarMain(MAIN_92_DONE);
  L.git('merge', '-q', '--no-edit', 'origin/main');
  L.avanzarMain({ [SPRINT]: sprint('in-progress', 'done') + '  9-3-nueva: backlog\n' });
  const u = uc().computeUndeclared({ repo: L.repo, baseSha: L.baseSha, storyPath: path.join(L.repo, STORY), registrados: [path.join(L.repo, 'src', 'a.js')] });
  assert.deepEqual(u.sobra, [], JSON.stringify(u));
});
