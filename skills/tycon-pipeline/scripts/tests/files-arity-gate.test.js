#!/usr/bin/env node
/**
 * files-arity-gate.test.js — la guarda de word-split de `--files` y su cableado en los DOS gates
 * que la necesitaban y no la tenían (`risk-class`, `deep-review-gate`).
 *
 * POR QUÉ EXISTE (casos 9.1 / 9.3 / 9.3.1, el repo del framework 2026-08-26): zsh no word-splitea
 * `$VAR` sin comillas, así que los N paths del diff llegaban como UN argumento con espacios.
 * `computeRiskClass` contaba 1 archivo → `superficie-chica` ✅ → LOW. Y LOW hace DOS cosas a la
 * vez: `auto_approve_plan: true` (se saltea el checkpoint donde el dev aprueba el plan) y
 * `deep-review-gate → run:false` (se saltea el pase adversarial, sellando `deepReviewDone`).
 * Ninguna de las dos dejaba rastro de que se apagó por un error de parseo. El validador ya
 * existía (`validateFilesExist`) pero SÓLO lo llamaban `advisors` y `smart-reloop`.
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/files-arity-gate.test.js
 * 0 deps (node:test). Lanza el CLI real contra repos temporales.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', 'pipeline.js');

// 🔴 Un repo git de verdad (2026-10-15): el portón mide cada archivo en SU repo, y fuera de todo repo git ya no cuenta
//    el archivo entero en silencio. Sin commits, los archivos son nuevos.
function mkRepo() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'arity-'));
  spawnSync('git', ['-C', r, '-c', 'maintenance.auto=false', 'init', '-q'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  fs.mkdirSync(path.join(r, 'src'));
  for (const f of ['a.cs', 'b.cs', 'c.cs']) fs.writeFileSync(path.join(r, 'src', f), '// x\n');
  fs.writeFileSync(path.join(r, 'story.md'), [
    '---', 'story: 9.3.1', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', '',
  ].join('\n'));
  return r;
}

// HOME temporal: `deep-review-gate` deja constancia en `~/.claude/.tycon-pipeline/gates.log` cuando
// el repo no declaró superficie compartida, y ese log es de donde la retrospectiva saca métricas.
// Sin aislarlo, cada corrida de este test mete repos de /var/folders en el log real del dev
// (revisión adversarial 2026-08-26 — ya había pasado: hubo que limpiar 75 entradas).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'arity-home-'));

function run(cmd, repo, files) {
  return spawnSync(process.execPath,
    [PIPELINE, cmd, '--repo', repo, '--story', path.join(repo, 'story.md'), ...(files ? ['--files', ...files] : [])],
    { encoding: 'utf8', env: { ...process.env, HOME } });
}

// ── El caso que motivó todo: los 3 paths en UN argumento ──────────────────────

test('risk-class: --files word-splitteado ABORTA (exit 2), no devuelve LOW', () => {
  const repo = mkRepo();
  const r = run('risk-class', repo, ['src/a.cs src/b.cs src/c.cs']);
  assert.equal(r.status, 2, `esperaba exit 2, dio ${r.status}. stdout: ${r.stdout}`);
  assert.match(r.stderr, /word-split fallado/);
  assert.match(r.stderr, /3 paths, 3 existen/);
  assert.equal(r.stdout.trim(), '', 'no debe emitir veredicto: un LOW acá apaga el checkpoint del plan');
});

test('deep-review-gate: --files word-splitteado ABORTA, no sella el 5b como hecho', () => {
  const repo = mkRepo();
  const r = run('deep-review-gate', repo, ['src/a.cs src/b.cs src/c.cs']);
  assert.equal(r.status, 2, `esperaba exit 2, dio ${r.status}. stdout: ${r.stdout}`);
  assert.match(r.stderr, /word-split fallado/);
  assert.doesNotMatch(r.stdout, /"run"/, 'un run:false computado sobre entrada rota es peor que ninguno');
});

// ── Lo que NO debe romper (un gate que molesta se termina apagando) ───────────

test('risk-class: --files bien expandido sigue funcionando', () => {
  const repo = mkRepo();
  const r = run('risk-class', repo, ['src/a.cs', 'src/b.cs', 'src/c.cs']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).risk, 'LOW', '3 archivos sin nada sensible = LOW legítimo');
});

test('deep-review-gate: --files bien expandido sigue funcionando', () => {
  const repo = mkRepo();
  const r = run('deep-review-gate', repo, ['src/a.cs', 'src/b.cs', 'src/c.cs']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).run, false, 'LOW legítimo sigue salteando el 5b');
});

test('risk-class SIN --files no aborta: cae al frontmatter de la story', () => {
  const repo = mkRepo();
  const r = run('risk-class', repo, null);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).risk, 'NORMAL', 'scope no declarado = NORMAL (default seguro)');
});

test('un path REAL con espacios no dispara el guard (falso positivo de macOS)', () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, 'My Folder'));
  fs.writeFileSync(path.join(repo, 'My Folder', 'x.cs'), '// x\n');
  const r = run('risk-class', repo, ['My Folder/x.cs']);
  assert.equal(r.status, 0, `un archivo que EXISTE no es un word-split. stderr: ${r.stderr}`);
});

// ── Constancia: el guard nombra la causa, no manda a buscar el archivo equivocado ──

test('el mensaje explica QUÉ apaga un LOW falso (los dos frenos, no sólo el 5b)', () => {
  const repo = mkRepo();
  const r = run('risk-class', repo, ['src/a.cs src/b.cs']);
  assert.match(r.stderr, /auto_approve_plan/, 'tiene que decir que apaga el checkpoint del plan');
  assert.match(r.stderr, /deep-review-gate/, 'y que apaga el pase adversarial');
  assert.match(r.stderr, /\$\{=VAR\}/, 'y cómo se arregla');
});

// ── La cerca que NO se pisa: story ilegible tiene su propia decisión (Story 4.18, 2026-07-24) ──
// Un gate que aborta feo empuja al bypass, así que con --story inválido estos dos devuelven el
// default SEGURO con el error a la vista, no exit 2. Al cablear la validación de --files había
// que traer SÓLO esa parte; este test es lo que impide que vuelva a colarse la otra.

test('deep-review-gate: --story inexistente sigue devolviendo run:true, no aborta', () => {
  const repo = mkRepo();
  const r = spawnSync(process.execPath,
    [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'no-existe.md'),
      '--files', 'src/a.cs', 'src/b.cs'], { encoding: 'utf8', env: { ...process.env, HOME } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.run, true, 'default seguro: si no se puede computar el riesgo, se revisa');
  assert.match(out.reason, /no computable/);
});

test('risk-class: --story inexistente sigue devolviendo NORMAL, no aborta', () => {
  const repo = mkRepo();
  const r = spawnSync(process.execPath,
    [PIPELINE, 'risk-class', '--repo', repo, '--story', path.join(repo, 'no-existe.md'),
      '--files', 'src/a.cs'], { encoding: 'utf8', env: { ...process.env, HOME } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).risk, 'NORMAL');
});

test('advisors SÍ sigue abortando con --story inexistente (su contrato no cambió)', () => {
  const repo = mkRepo();
  const r = spawnSync(process.execPath,
    [PIPELINE, 'advisors', '--repo', repo, '--story', path.join(repo, 'no-existe.md'),
      '--files', 'src/a.cs'], { encoding: 'utf8', env: { ...process.env, HOME } });
  assert.equal(r.status, 2, `esperaba exit 2, dio ${r.status}`);
  assert.match(r.stderr, /--story NO existe/);
});

// ── Story 7.25: un archivo que no está en el disco NI en HEAD es un fantasma, no un borrado ─────────
// Caso de un producto del equipo (2026-10-14): `--files a.cs,b.cs,c.cs` en UN argumento, sin espacios. La guarda de
// arriba sólo mira el argumento con espacios, así que pasaba; `densidadDelDiff` contaba 0 líneas y el gate daba LOW con
// `run:false` sobre un cambio de ~955 líneas. Un borrado del cambio sigue pasando: git lo conoce en HEAD.

const { execFileSync } = require('child_process');

function mkGitRepo() {
  const r = mkRepo();
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q');
  fs.writeFileSync(path.join(r, 'src', 'borrado.cs'), '// se va\n');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  for (let i = 0; i < 40; i++) fs.appendFileSync(path.join(r, 'src', 'a.cs'), `int x${i};\n`);
  return r;
}

test('T1 DeepReviewGate_FilesConComas_Aborta — deep-review-gate y risk-class frenan con el fantasma', () => {
  const repo = mkGitRepo();
  for (const cmd of ['deep-review-gate', 'risk-class']) {
    const r = run(cmd, repo, ['src/a.cs,src/b.cs,src/c.cs']);
    assert.equal(r.status, 2, `${cmd}: esperaba exit 2, dio ${r.status}. stdout: ${r.stdout}`);
    assert.match(r.stderr, /src\/a\.cs,src\/b\.cs,src\/c\.cs/, `${cmd}: tiene que nombrar el fantasma`);
    assert.match(r.stderr, /--allow-missing-files/, `${cmd}: y la salida consciente`);
    assert.equal(r.stdout.trim(), '', `${cmd}: sin veredicto sobre una entrada rota`);
  }
});

test('T2 DeepReviewGate_RutaAbsolutaFantasmaDeOtroRepo_Aborta', () => {
  const repo = mkGitRepo();
  const otro = mkGitRepo();
  const r = run('deep-review-gate', repo, ['src/a.cs', path.join(otro, 'front', 'Ventana.tsx')]);
  assert.equal(r.status, 2, `esperaba exit 2, dio ${r.status}. stdout: ${r.stdout}`);
  assert.match(r.stderr, /Ventana\.tsx/);
});

test('T22 DeepReviewGate_FantasmaFueraDeGit_LoDice — sin git a quien preguntar, frena y dice que no pudo confirmar', () => {
  const repo = mkRepo();   // sin git: nadie puede decir si es un borrado
  const r = run('deep-review-gate', repo, ['src/a.cs', 'src/se-fue.cs']);
  assert.equal(r.status, 2, `stdout: ${r.stdout}`);
  assert.match(r.stderr, /no pude preguntarle a git/);
  assert.match(r.stderr, /--allow-missing-files/);
});

test('T3 DeepReviewGate_ArchivoBorradoPorElCambio_NoAborta — un borrado es un cambio legítimo', () => {
  const repo = mkGitRepo();
  fs.rmSync(path.join(repo, 'src', 'borrado.cs'));
  for (const cmd of ['deep-review-gate', 'risk-class']) {
    const r = run(cmd, repo, ['src/a.cs', 'src/borrado.cs']);
    assert.equal(r.status, 0, `${cmd}: stderr: ${r.stderr}`);
    assert.ok(JSON.parse(r.stdout), `${cmd}: con veredicto`);
  }
});

test('T4 DeepReviewGate_AllowMissingFiles_NoAborta', () => {
  const repo = mkGitRepo();
  const r = spawnSync(process.execPath,
    [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', path.join(repo, 'story.md'), '--allow-missing-files',
      '--files', 'src/a.cs,src/b.cs'], { encoding: 'utf8', env: { ...process.env, HOME } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok('run' in JSON.parse(r.stdout));
});
