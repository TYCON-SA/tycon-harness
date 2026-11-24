'use strict';

/**
 * story-move.test.js — `pipeline.js move-story --story <de> --to <a>`: mueve una historia de carpeta sin tocar su contenido y con su
 * validación.
 *
 * Las constancias de la validación y de la revisión previa se guardan con la clave de la RUTA de la historia, y valen
 * mientras su huella coincida con el contenido. Un `mv` a mano lo frena el portón de escrituras, y reescribirla en la
 * ruta nueva no la deja igual byte a byte: sin este comando, mover una historia validada la dejaba sin validación. El
 * comando mueve el archivo tal cual y pasa cada constancia vigente a la clave nueva; una que ya no coincide con el
 * contenido queda donde estaba, y el comando lo dice y sale con 3, así nadie cree que se movió validada.
 *
 * Todo corre sobre repos de juguete y una HOME de prueba.
 *
 * stable-data: lee el reloj a propósito — el marcador falso de una corrida abierta lleva la hora de ahora, como uno de
 * verdad.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const PIPELINE_JS = path.join(SCRIPTS, 'pipeline.js');
const VR = require(path.join(SCRIPTS, 'lib', 'validation-record.js'));
const SR = require(path.join(SCRIPTS, 'lib', 'story-review-record.js'));
const FT = require(path.join(SCRIPTS, 'lib', 'first-time-record.js'));
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'TYCON_HOME', 'TYCON_SKILLS_DIR'];
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const autor = ['-c', 'user.email=prueba@ejemplo.invalid', '-c', 'user.name=prueba'];
const HISTORIA = '---\nstory: "9.1"\ntitle: "Juguete"\nstatus: ready-for-dev\n---\n# Historia 9.1\n\n## Criterios\n\n1. Hace algo.\n';

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...autor, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Una HOME de prueba y un repo con la historia en specs/a/, commiteada. */
function lab(nombre, { contenido = HISTORIA, commitear = true } = {}) {
  const home = tmp(`move-story-${nombre}-home-`);
  const repo = tmp(`move-story-${nombre}-repo-`);
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'specs', 'a'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs', 'b'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'b', '.gitkeep'), '');
  const de = path.join(repo, 'specs', 'a', 'story-9.1-juguete.md');
  fs.writeFileSync(de, contenido);
  if (commitear) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'historia'); }
  return { home, repo, de, a: path.join(repo, 'specs', 'b', 'story-9.1-juguete.md') };
}

function mover(l, de = l.de, a = l.a) {
  const env = { ...process.env, HOME: l.home };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync(process.execPath, [PIPELINE_JS, 'move-story', '--story', de, '--to', a], { cwd: l.repo, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const validar = (l, p = l.de) => {
  VR.writeRecord(l.home, p, { resultado: 'verde', validadores: ['tycon-story-validator'] });
  SR.writeRecord(l.home, p, { resultado: 'limpio', hallazgos: [] });
};

// 🔴 Falla con: un comando que no pasa las constancias a la ruta nueva (la historia movida queda sin validar), o que
//    reescribe el archivo en vez de moverlo (deja de ser igual byte a byte).
test('MoveStory_ValidatedStory_StaysValidatedAtNewPath_ByteForByte', () => {
  const l = lab('vigente');
  validar(l);
  const antes = fs.readFileSync(l.de);
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.existsSync(l.de), false, 'la ruta vieja ya no tiene la historia');
  assert.deepStrictEqual(fs.readFileSync(l.a), antes, 'el contenido es el mismo, byte a byte');
  assert.equal(VR.readRecord(l.home, l.a).estado, 'current', r.out);
  assert.equal(SR.readRecord(l.home, l.a).estado, 'current', r.out);
  // git lo ve como un renombre, no como un archivo nuevo
  assert.match(git(l.repo, 'status', '--porcelain'), /^R {2}specs\/a\/story-9\.1-juguete\.md -> specs\/b\/story-9\.1-juguete\.md$/m);
});

// 🔴 Falla con: un comando que pasa una constancia vencida a la ruta nueva, o que sale con 0 como si la historia se
//    hubiera movido validada.
test('MoveStory_ChangedAfterValidation_SaysSoAndExits3', () => {
  const l = lab('vencida');
  validar(l);
  fs.appendFileSync(l.de, '2. Hace otra cosa.\n');
  git(l.repo, 'commit', '-q', '-am', 'criterio nuevo');
  const r = mover(l);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /la validación quedó en la ruta vieja: el contenido cambió/);
  assert.equal(fs.existsSync(l.a), true, 'la historia se movió igual');
  assert.equal(VR.readRecord(l.home, l.a).estado, 'none');
  assert.equal(SR.readRecord(l.home, l.a).estado, 'none');
});

test('MoveStory_NoValidation_MovesAndSaysSo', () => {
  const l = lab('sin-validar');
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no tenía validación/);
  assert.equal(fs.existsSync(l.a), true);
});

// 🔴 Falla con: un comando que pisa un archivo que ya estaba en el destino.
test('MoveStory_DestinationExists_Refuses', () => {
  const l = lab('destino');
  fs.writeFileSync(l.a, 'otra historia\n');
  const r = mover(l);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ya existe/);
  assert.equal(fs.readFileSync(l.a, 'utf8'), 'otra historia\n');
  assert.equal(fs.existsSync(l.de), true);
});

// La clave de la constancia es el repo más la ruta: otro repo es otra historia.
test('MoveStory_OtherRepo_Refuses', () => {
  const l = lab('otro-repo');
  const otro = tmp('move-story-otro-');
  git(otro, 'init', '-q', '-b', 'main');
  const r = mover(l, l.de, path.join(otro, 'story-9.1-juguete.md'));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /otro repo/);
  assert.equal(fs.existsSync(l.de), true);
});

test('MoveStory_NotAStory_Refuses', () => {
  const l = lab('no-historia', { contenido: '# Notas\n\nsin encabezado\n' });
  const r = mover(l);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no es una historia/);
  assert.equal(fs.existsSync(l.de), true);
});

// 🔴 Falla con: un comando que mueve la historia de una corrida abierta (su marcador y sus registros la nombran por la
//    ruta vieja).
test('MoveStory_OpenRun_Refuses', () => {
  const l = lab('corrida');
  const activos = path.join(stateDir(l.home), 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'otra-sesion.json'), JSON.stringify({
    sessionId: 'otra-sesion', storyId: '9.1', storyPath: 'specs/a/story-9.1-juguete.md', repoPath: l.repo, lastTouch: new Date().toISOString(),
  }));
  const r = mover(l);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /corrida abierta/);
  assert.match(r.out, /otra-sesion/);
  assert.equal(fs.existsSync(l.de), true);
});

test('MoveStory_FirstTimeRecord_Moves', () => {
  const l = lab('primera-vez');
  FT.writeRecord(l.home, l.de, '9.1');
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.equal(FT.isRecorded(l.home, l.a, '9.1'), true, r.out);
});

test('MoveStory_UntrackedStory_MovesToo', () => {
  const l = lab('sin-commitear', { commitear: false });
  validar(l);
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.existsSync(l.a), true);
  assert.equal(VR.readRecord(l.home, l.a).estado, 'current', r.out);
});

// El estado del sprint que cuenta es el de la carpeta de la historia: al cambiar de carpeta, se avisa.
test('MoveStory_OtherFolderWithSprintStatus_Warns', () => {
  const l = lab('sprint');
  fs.writeFileSync(path.join(l.repo, 'specs', 'a', 'sprint-status.yaml'), 'development_status:\n  9-1-juguete: ready-for-dev\n');
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /sprint-status\.yaml/);
});

// 🔴 Falla con: un comando que mueve primero y escribe las constancias después: si la escritura falla, la historia queda
//    movida y sin validar, y el comando dice que no se movió.
test('MoveStory_RecordWriteFails_NothingMoves', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const l = lab('no-escribe');
  validar(l);
  const dir = path.dirname(VR.recordFile(l.home, l.de));
  fs.chmodSync(dir, 0o500);
  try {
    const r = mover(l);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no moví nada/);
    assert.equal(fs.existsSync(l.de), true, 'la historia sigue en su ruta');
    assert.equal(fs.existsSync(l.a), false);
    assert.equal(git(l.repo, 'status', '--porcelain'), '', 'git no quedó con un renombre a medias');
  } finally { fs.chmodSync(dir, 0o700); }
});

// La clave de una constancia es el repo más la ruta: la comparten las copias del mismo repo (worktrees, ramas).
// 🔴 Falla con: un comando que borra la constancia de la ruta vieja (otra copia todavía tiene la historia ahí) o que pisa
//    la de la ruta nueva cuando es de otra historia.
test('MoveStory_OtherCopies_OldRecordKept_NewKeyOfOtherStoryNotOverwritten', () => {
  const l = lab('copias');
  validar(l);
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  // otra copia sigue con la historia en la ruta vieja: su validación sigue vigente
  fs.writeFileSync(l.de, HISTORIA);
  assert.equal(VR.readRecord(l.home, l.de).estado, 'current', 'la constancia de la ruta vieja sigue');

  const m = lab('copias-otra');
  validar(m);
  // otra copia tiene OTRA historia validada en la ruta nueva
  const otra = HISTORIA.replace('Hace algo.', 'Hace otra cosa.');
  fs.writeFileSync(m.a, otra);
  validar(m, m.a);
  fs.rmSync(m.a);
  const r2 = mover(m);
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, /otro contenido/);
  assert.equal(fs.existsSync(m.de), true, 'no se movió');
  fs.writeFileSync(m.a, otra);
  assert.equal(VR.readRecord(m.home, m.a).estado, 'current', 'la constancia de la otra historia no se pisó');
});

// Otra copia ya movió la misma historia: la clave nueva tiene la constancia del mismo contenido, y se puede mover.
test('MoveStory_NewKeyAlreadyHasSameContent_Moves', () => {
  const l = lab('misma');
  validar(l);
  fs.writeFileSync(l.a, HISTORIA);
  validar(l, l.a);
  fs.rmSync(l.a);
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.equal(VR.readRecord(l.home, l.a).estado, 'current', r.out);
});

const conHora = (f, hora) => { const r = JSON.parse(fs.readFileSync(f, 'utf8')); r.hora = hora; fs.writeFileSync(f, `${JSON.stringify(r, null, 2)}\n`); };

// La clave nueva ya tiene la constancia del mismo contenido (otra copia lo validó): queda la más nueva de las dos, y el
// comando dice cuál quedó.
// 🔴 Falla con: un comando que se queda siempre con la de la otra copia (y la propia, más nueva, se pierde) o que dice
//    «vigente» sin decir con qué resultado quedó.
test('MoveStory_NewKeySameContent_NewerRecordWins_AndSaysWhich', () => {
  const nuestra = lab('mas-nueva-nuestra');
  fs.writeFileSync(nuestra.a, HISTORIA);
  VR.writeRecord(nuestra.home, nuestra.a, { resultado: 'rojo', validadores: ['tycon-story-validator'] });
  conHora(VR.recordFile(nuestra.home, nuestra.a), '2026-01-01T00:00:00.000Z');
  fs.rmSync(nuestra.a);
  validar(nuestra);
  const r = mover(nuestra);
  assert.equal(r.status, 0, r.out);
  assert.equal(VR.readRecord(nuestra.home, nuestra.a).record.resultado, 'verde', 'la propia, más nueva, quedó');
  assert.match(r.out, /verde/);

  const suya = lab('mas-nueva-suya');
  validar(suya);
  conHora(VR.recordFile(suya.home, suya.de), '2026-01-01T00:00:00.000Z');
  fs.writeFileSync(suya.a, HISTORIA);
  VR.writeRecord(suya.home, suya.a, { resultado: 'rojo', validadores: ['tycon-story-validator'] });
  fs.rmSync(suya.a);
  const r2 = mover(suya);
  assert.equal(r2.status, 0, r2.out);
  assert.equal(VR.readRecord(suya.home, suya.a).record.resultado, 'rojo', 'la de la otra copia, más nueva, quedó');
  assert.match(r2.out, /rojo/);
});

// Una ruta que una historia dejó al moverse se puede volver a usar: su constancia vieja queda marcada como movida.
// 🔴 Falla con: un comando que toma la constancia que dejó una mudanza por la de otra historia y se niega para siempre.
test('MoveStory_PathLeftByAMove_CanBeReused', () => {
  const l = lab('reusar');
  validar(l);
  assert.equal(mover(l).status, 0);
  // otra historia a la ruta que quedó libre
  const c = path.join(l.repo, 'specs', 'a', 'story-9.3-otra.md');
  fs.writeFileSync(c, HISTORIA.replace(/9\.1/g, '9.3'));
  git(l.repo, 'add', '-A'); git(l.repo, 'commit', '-q', '-m', 'otra');
  validar(l, c);
  const r = mover(l, c, l.de);
  assert.equal(r.status, 0, r.out);
  assert.equal(VR.readRecord(l.home, l.de).estado, 'current', r.out);
  // y la primera, de vuelta a su ruta de antes (ahora ocupada): se niega por el destino, no por la constancia
  git(l.repo, 'commit', '-q', '-am', 'mudanzas');
  const ida = lab('ida-y-vuelta');
  validar(ida);
  assert.equal(mover(ida).status, 0);
  git(ida.repo, 'commit', '-q', '-m', 'ida');
  const vuelta = mover(ida, ida.a, ida.de);
  assert.equal(vuelta.status, 0, vuelta.out);
  assert.equal(VR.readRecord(ida.home, ida.de).estado, 'current', vuelta.out);
});

// La constancia de primera vez es por ruta real: la de otra rama del mismo checkout en la ruta nueva no se pisa.
// 🔴 Falla con: un comando que escribe la de primera vez sin mirar si la ruta nueva ya tiene la de otra historia.
test('MoveStory_FirstTimeOfOtherStoryAtNewPath_NotOverwritten', () => {
  const l = lab('primera-vez-otra');
  FT.writeRecord(l.home, l.de, '9.1');
  FT.writeRecordAt(l.home, path.join(fs.realpathSync(path.dirname(l.a)), path.basename(l.a)), '9.7');
  const r = mover(l);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /primera vez/);
  assert.equal(FT.isRecorded(l.home, l.a, '9.7'), true, 'la de la otra historia sigue');
  assert.equal(FT.isRecorded(l.home, l.a, '9.1'), false);
});

test('MoveStory_Usage_Exits2', () => {
  const l = lab('uso');
  const env = { ...process.env, HOME: l.home };
  for (const k of DEL_ENTORNO) delete env[k];
  const r = spawnSync(process.execPath, [PIPELINE_JS, 'move-story', '--story', l.de], { cwd: l.repo, env, encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});
