'use strict';
/**
 * approvals-removed.test.js — la cuenta de la noche de las constancias del dueño que salieron de main, y el freno local
 * que no deja escribirlas a mano.
 *
 *   Nightly_CountsRemoved_SignedAndUnsigned @story-8.248 @ac-9 · un borrado con la firma del dueño y uno sin firma en el
 *     último día dan 1 y 1, con sus nombres, en la foto; un día sin borrados da 0, dicho como 0.
 *   Nightly_UnreadableHistory_NotMeasured @story-8.248 @ac-9 · sin una historia que se pueda leer, «no medido», nunca 0.
 *   LocalBrake_WriteApprovalByHand_Unchanged @story-8.248 @ac-12 · escribir una constancia con la herramienta de edición
 *     sigue frenado.
 *
 * Repos de juguete armados con git, sin red. Correr: node --test scripts/tests/approvals-removed.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'approvals-removed.js');
const HOOK = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'hook-pre-edit.js');
const HOUR = 3600000;
// la hora de la prueba, fija: los commits llevan fechas relativas a ella y la cuenta corre con `--now`
const AHORA = Date.parse('2026-11-08T12:00:00Z');
const CARPETA = '.github/control-changes/';

function lab(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-removed-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'home'));
  return dir;
}
const gitEnv = (dir, at) => ({
  ...process.env, HOME: path.join(dir, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'home', 'gitconfig'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  ...(at ? { GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() } : {}),
});
function git(dir, repo, args, at) {
  const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { encoding: 'utf8', env: gitEnv(dir, at || AHORA) });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const hashOf = (entries) => crypto.createHash('sha256').update(entries.map((e) => `${e.path}\t${e.blob}\n`).sort().join('')).digest('hex');
// la constancia del dueño de esas entradas, como la escribe `run-base-controls.sh approve`
const firma = (entries) => `${JSON.stringify({ hash: hashOf(entries), rules: entries, at: '2026-11-01', by: 'dueño' })}\n`;
const ruta = (entries) => `${CARPETA}${hashOf(entries)}.json`;

const A = [{ path: 'scripts/ci/toy-rules.json', blob: 'a'.repeat(40) }];
const B = [{ path: 'scripts/ci/toy-rules.json', blob: 'b'.repeat(40) }];

/** El repo de juguete: el inventario y dos constancias del dueño hace tres días. Devuelve la carpeta del repo. */
function repoConDosConstancias(dir) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(dir, repo, ['init', '-q', '.']);
  write(path.join(repo, 'scripts', 'ci', 'controls-from-base.json'), JSON.stringify({ hook: '.githooks/pre-commit-checks', passes: [], controls: [], content: [], workflows: [], approvals: [CARPETA] }));
  write(path.join(repo, ruta(A)), firma(A));
  write(path.join(repo, ruta(B)), firma(B));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'base'], AHORA - 72 * HOUR);
  return repo;
}
function contar(dir, repo, extra = []) {
  const out = path.join(dir, 'ultimo-constancias.json');
  // lo de `extra` va primero: el guion lee la primera aparición de cada opción, y `--now` cae a la hora fija de la prueba
  const r = spawnSync(process.execPath, [SCRIPT, '--root', repo, '--ref', 'main', '--out', out, ...extra, '--now', new Date(AHORA).toISOString()], { encoding: 'utf8', env: gitEnv(dir) });
  let foto = null;
  try { foto = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) { foto = null; }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, foto };
}

test('Nightly_CountsRemoved_SignedAndUnsigned @story-8.248 @ac-9', (t) => {
  const dir = lab(t);
  const repo = repoConDosConstancias(dir);
  // borra A con la firma del dueño para ese borrado
  const borraA = [{ path: ruta(A), blob: 'borrado' }];
  fs.rmSync(path.join(repo, ruta(A)));
  write(path.join(repo, ruta(borraA)), firma(borraA));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'borra A, firmado'], AHORA - 2 * HOUR);
  // borra B sin firma
  fs.rmSync(path.join(repo, ruta(B)));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'borra B'], AHORA - HOUR);

  const r = contar(dir, repo);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(r.foto, `no escribió la foto: ${r.out}`);
  assert.strictEqual(r.foto.medido, true);
  assert.deepStrictEqual(r.foto.sin_firma.map((x) => x.path), [ruta(B)]);
  assert.deepStrictEqual(r.foto.con_firma.map((x) => x.path), [ruta(A)]);
  assert.match(r.out, /1 sin firma/);
  assert.match(r.out, /1 con la firma del dueño/);

  // la ventana de un día que termina antes de los borrados: cero, dicho como cero
  // (--fresh: sin seguir desde la foto de recién, la ventana de un día por fecha)
  const antes = contar(dir, repo, ['--fresh', '--now', new Date(AHORA - 48 * HOUR).toISOString()]);
  assert.strictEqual(antes.status, 0, antes.out);
  assert.strictEqual(antes.foto.medido, true);
  assert.strictEqual(antes.foto.sin_firma.length, 0);
  assert.strictEqual(antes.foto.con_firma.length, 0);
  assert.match(antes.out, /0 sin firma/);
});

// Pase adversarial, clases 1, 4 y 13: el commit que borra la constancia saca también su carpeta del inventario, o borra el
// inventario. Las rutas salen del padre y del commit juntos, así que el borrado se cuenta igual.
test('Nightly_InventoryChangedInTheSameCommit_StillCounts @story-8.248 @ac-9', (t) => {
  for (const caso of ['sin-carpeta', 'sin-inventario']) {
    const dir = lab(t);
    const repo = repoConDosConstancias(dir);
    fs.rmSync(path.join(repo, ruta(A)));
    const inv = path.join(repo, 'scripts', 'ci', 'controls-from-base.json');
    if (caso === 'sin-carpeta') write(inv, JSON.stringify({ hook: '.githooks/pre-commit-checks', passes: [], controls: [], content: [], workflows: [], approvals: [] }));
    else fs.rmSync(inv);
    git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', `borra A y ${caso}`], AHORA - HOUR);
    const r = contar(dir, repo);
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual(r.foto.sin_firma.map((x) => x.path), [ruta(A)], `${caso}: ${r.out}`);
  }
});

// Pase adversarial, clases 2, 3, 5 y 11: la medición sigue desde la punta que vio la anterior, sin mirar fechas. Un borrado
// con fecha de commit vieja que entra hoy a main, o uno que queda detrás de un commit con fecha vieja, se cuenta igual.
test('Nightly_FollowsFromThePreviousTip_NotByDate @story-8.248 @ac-9', (t) => {
  const dir = lab(t);
  const repo = repoConDosConstancias(dir);
  const primera = contar(dir, repo);
  assert.strictEqual(primera.status, 0, primera.out);
  assert.match(primera.foto.tip, /^[0-9a-f]{40}$/, 'la foto guarda la punta que miró');
  // un borrado sin firma con fecha de hace 60 horas, y encima un commit con fecha de hace 50
  fs.rmSync(path.join(repo, ruta(B)));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'borra B con fecha vieja'], AHORA - 60 * HOUR);
  write(path.join(repo, 'otro.txt'), 'x\n');
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'otro con fecha vieja'], AHORA - 50 * HOUR);
  const segunda = contar(dir, repo);
  assert.strictEqual(segunda.status, 0, segunda.out);
  assert.strictEqual(segunda.foto.desde_punta, primera.foto.tip, 'sigue desde la punta de la anterior');
  assert.deepStrictEqual(segunda.foto.sin_firma.map((x) => x.path), [ruta(B)], segunda.out);
  // una noche que no midió conserva la punta: la siguiente sigue desde ahí
  const rota = contar(dir, path.join(dir, 'no-hay'));
  assert.strictEqual(rota.status, 3, rota.out);
  assert.strictEqual(rota.foto.tip, segunda.foto.tip, 'sin medir, la punta de la anterior se conserva');
});

// Pase adversarial, clase 7: la firma de un renglón sacado de un registro .jsonl ancla el blob de la punta del pedido; si
// main sumó otro renglón después, el blob que queda en main es otro. La cuenta lo reconoce como firmado.
test('Nightly_JsonlSignedOnThePullRequestBlob_IsSigned @story-8.248 @ac-9', (t) => {
  const dir = lab(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(dir, repo, ['init', '-q', '.']);
  const JSONL = '.tycon/control-changes.jsonl';
  write(path.join(repo, 'scripts', 'ci', 'controls-from-base.json'), JSON.stringify({ hook: '.githooks/pre-commit-checks', passes: [], controls: [], content: [], workflows: [], approvals: [CARPETA, JSONL] }));
  write(path.join(repo, JSONL), firma(A) + firma(B));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'base'], AHORA - 72 * HOUR);
  // lo que firmó el dueño: el registro sin el renglón de A (el blob de la punta de su pedido)
  write(path.join(dir, 'firmado.jsonl'), firma(B));
  const blobPedido = git(dir, repo, ['hash-object', '-w', path.join(dir, 'firmado.jsonl')]);
  const entradas = [{ path: JSONL, blob: blobPedido }];
  // lo que quedó en main: sin A y con un renglón más que trajo main
  write(path.join(repo, JSONL), firma(B) + firma([{ path: 'x', blob: 'c'.repeat(40) }]));
  write(path.join(repo, ruta(entradas)), firma(entradas));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'saca A, firmado en el pedido'], AHORA - HOUR);
  const r = contar(dir, repo);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual([r.foto.con_firma.map((x) => x.path), r.foto.sin_firma.length], [[JSONL], 0], r.out);
});

// Revisores, vuelta 2: una constancia vieja que aprobó otra versión del registro no tapa un borrado posterior; sólo
// cuentan las que entraron en el mismo commit.
test('Nightly_OldApprovalDoesNotCoverALaterRemoval @story-8.248 @ac-9', (t) => {
  const dir = lab(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(dir, repo, ['init', '-q', '.']);
  const JSONL = '.tycon/control-changes.jsonl';
  write(path.join(repo, 'scripts', 'ci', 'controls-from-base.json'), JSON.stringify({ hook: '.githooks/pre-commit-checks', passes: [], controls: [], content: [], workflows: [], approvals: [CARPETA, JSONL] }));
  // hace tres días: el registro vacío y una constancia vieja que lo aprueba así (sin renglones)
  write(path.join(repo, JSONL), '\n');
  const vacio = git(dir, repo, ['hash-object', '-w', path.join(repo, JSONL)]);
  const vieja = [{ path: JSONL, blob: vacio }];
  write(path.join(repo, ruta(vieja)), firma(vieja));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'base'], AHORA - 72 * HOUR);
  // después se suma un renglón, y hoy se saca sin firma: la constancia vieja «aprueba» un registro sin ese renglón
  write(path.join(repo, JSONL), firma(A));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'suma A'], AHORA - 48 * HOUR);
  const primera = contar(dir, repo, ['--fresh']);
  assert.strictEqual(primera.status, 0, primera.out);
  write(path.join(repo, JSONL), '\n');
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'saca A sin firma'], AHORA - HOUR);
  const r = contar(dir, repo);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual([r.foto.sin_firma.map((x) => x.path), r.foto.con_firma.length], [[JSONL], 0], r.out);
});

// Revisores, vuelta 2: si la primera medición no midió, la siguiente empieza donde empezaba aquélla, no un día atrás.
test('Nightly_FirstMeasurementFailed_NextOneStartsWhereItStarted @story-8.248 @ac-9', (t) => {
  const dir = lab(t);
  const out = path.join(dir, 'ultimo-constancias.json');
  write(out, JSON.stringify({ kind: 'constancias-borradas', medido: false, tip: null, desde: new Date(AHORA - 5 * 24 * HOUR).toISOString(), hasta: new Date(AHORA - 4 * 24 * HOUR).toISOString(), motivo: 'falló' }));
  const repo = repoConDosConstancias(dir);
  fs.rmSync(path.join(repo, ruta(B)));
  git(dir, repo, ['add', '-A']); git(dir, repo, ['commit', '-qm', 'borra B hace tres días y medio'], AHORA - 84 * HOUR);
  const r = contar(dir, repo);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(r.foto.desde, new Date(AHORA - 5 * 24 * HOUR).toISOString(), 'la ventana empieza donde empezaba la que falló');
  assert.deepStrictEqual(r.foto.sin_firma.map((x) => x.path), [ruta(B)], r.out);
});

test('Nightly_UnreadableHistory_NotMeasured @story-8.248 @ac-9', (t) => {
  const dir = lab(t);
  const noRepo = path.join(dir, 'no-es-un-repo');
  fs.mkdirSync(noRepo);
  const r = contar(dir, noRepo);
  assert.strictEqual(r.status, 3, r.out);
  assert.ok(r.foto, `no escribió la foto: ${r.out}`);
  assert.strictEqual(r.foto.medido, false);
  assert.ok(r.foto.motivo, 'la foto no dice por qué no midió');
  assert.match(r.out, /no medido/);
  assert.doesNotMatch(r.out, /\b0 sin firma/);
});

test('LocalBrake_WriteApprovalByHand_Unchanged @story-8.248 @ac-12', (t) => {
  const dir = lab(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(dir, repo, ['init', '-q', '.']);
  const evento = { session_id: 'prueba-constancia', tool_name: 'Write', tool_input: { file_path: path.join(repo, CARPETA, 'abc.json'), content: '{}' } };
  const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', input: JSON.stringify(evento), cwd: repo, env: gitEnv(dir) });
  assert.strictEqual(r.status, 2, `el freno no frenó: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /constancia de cambio de control no se escribe a mano/);
  assert.match(r.stderr, /run-base-controls\.sh approve/);
});
