#!/usr/bin/env node
/**
 * adversarial-result.test.js — el resultado del pase adversarial no es opcional.
 *
 * Sin esto, el 5b se puede cerrar con `set-flag deepReviewDone true` sin anotar qué confirmó el pase, y el paso 8
 * cierra igual: los hallazgos arreglados con una prueba escrita a mano quedan sin constancia, o se anotan como
 * «diferidos».
 *
 * Qué fija esta suite: (1) la bandera ya no se escribe a mano; (2) el salteo lo decide el portón
 * (`pipeline.js deep-review-gate` REAL, como proceso — el doble de un portón que no imita al real confirma lo
 * que uno quiere); (3) el resultado cierra el 5b y tiene casilla para la prueba propia, verificada contra el
 * registro de ediciones; (4) el paso 8 no cierra sin el pase atendido, y `DOD_BYPASS` no lo abre; (5) lo del pase
 * no se hereda entre stories.
 *
 * Nunca se toca el `gates.log` real: cada caso corre con un HOME falso.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adversarial-result.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const SKILL = path.join(SCRIPTS, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const LANZADO = '2026-09-18T01:00:00.000Z';
const DESPUES = '2026-09-18T02:00:00.000Z';
const ANTES = '2026-09-18T00:30:00.000Z';

// Los nombres viejos de las opciones de marker.js salen de la tabla del puente,
// nunca escritos acá: el freno y el termómetro cuentan los nombres de todo lo que se publica, pruebas incluidas.
const { OWN_ARGS } = require(path.join(SCRIPTS, 'lib', 'legacy-names.js'));
const VIEJA_DE = Object.fromEntries(Object.entries(OWN_ARGS['skills/tycon-pipeline/scripts/marker.js'].option)
  .map(([vieja, nueva]) => [nueva, vieja]));
const vieja = (nueva) => `--${VIEJA_DE[nueva]}`;

// Variables del entorno de quien corre la suite que cambian un veredicto: fuera, siempre. Un dev con
// `DOD_BYPASS=1` o `TYCON_NO_DEEP_REVIEW=1` exportado no puede poner verde un caso que tiene que dar rojo.
const DEL_ENTORNO = ['TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS', 'TYCON_5B_EARLY', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID',
  'TYCON_DEEP_REVIEW_DENSE_LINES', 'STOP_AUTONOMY', 'TYCON_MUTATION_CHECK', 'TYCON_ADVERSARIAL_RESULT_GATE'];

function entorno(home, sid, extra) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  return { ...env, HOME: home, CLAUDE_CODE_SESSION_ID: sid, ...(extra || {}) };
}

// El 5b se anota con `--result <archivo>` (el JSON del pase). Estas pruebas miden otras cosas: a
// una anotación 5b sin el archivo se le pasa uno medido con sus N confirmados. La exigencia en sí la fija
// tests/adversarial-unmeasured.test.js (T10).
function conResultado(home, args) {
  if (args[0] !== 'mark-adversarial-result' || args.includes('--result')) return args;
  const i = args.indexOf('--type');
  if (i >= 0 && String(args[i + 1]).toLowerCase() !== '5b') return args;
  const n = /^\d+$/.test(String(args[1])) ? parseInt(args[1], 10) : 0;
  const archivo = path.join(home, `resultado-${process.hrtime.bigint()}.json`);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify({
    confirmed: Array.from({ length: n }, (_v, k) => ({ lens: 'l', summary: `h${k}` })),
    lentes: ['a', 'b', 'c', 'd', 'e', 'f'].map((l) => ({ lens: l, estado: 'medida', count: 0 })), lentes_sin_medir: [], detalle: [], medido: true,
  }));
  return [...args, '--result', archivo];
}

function correr(home, sid, args, { env, cwd } = {}) {
  const r = spawnSync(process.execPath, [MARKER, ...conResultado(home, args)], { encoding: 'utf8', env: entorno(home, sid, env), cwd: cwd || os.tmpdir() });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function estado(home) { return path.join(home, '.claude', '.tycon-pipeline'); }
function archivoMarker(home, sid) { return path.join(estado(home), 'active', `${sid}.json`); }
function leerMarker(home, sid) { return JSON.parse(fs.readFileSync(archivoMarker(home, sid), 'utf8')); }
function crudoMarker(home, sid) { return fs.readFileSync(archivoMarker(home, sid), 'utf8'); }
function lineas(home, nombre) {
  const p = path.join(estado(home), nombre);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function crudoLog(home, nombre) {
  const p = path.join(estado(home), nombre);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Copiado de unit.test.js (~1160), que no lo exporta.
function writeFakeMarker(fakeHome, sid, extra) {
  const activeDir = path.join(fakeHome, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activeDir, { recursive: true });
  const marker = {
    storyId: 'A', storyPath: 'specs/a.md', repoPath: '/tmp/repo', sessionId: sid,
    startedAt: '2026-07-30T10:00:00.000Z', lastTouch: '2026-07-30T10:00:00.000Z',
    stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5], filesTouched: [], iterations: {}, fileEvents: [],
    ...extra,
  };
  fs.writeFileSync(path.join(activeDir, `${sid}.json`), JSON.stringify(marker));
  return marker;
}

/**
 * Repo de prueba como el de deep-review-dense.test.js: git + story con su scope declarado (1 archivo → el
 * risk-class por la story es LOW, así que «sin --files» llega a la medición de densidad y el portón da
 * `run: null`) + un archivo de código chico + una prueba.
 */
function mkRepo({ codigo = 1, runDir = false } = {}) {
  // En una carpeta propia: el paso 8 mira las carpetas vecinas del repo, y la carpeta temporal de una máquina de
  // trabajo puede tener cientos de miles de entradas (medido: 517.471, ~40 s por llamada).
  const r = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'res-adv-'))), 'repo');
  fs.mkdirSync(r);
  spawnSync('git', ['init', '-q', r]);
  fs.mkdirSync(path.join(r, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(r, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(r, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(r, 'specs', 'a.md'),
    ['---', 'story: "A"', 'epic: 1', 'status: in-progress', 'files_to_create: []', 'files_to_modify:', '  - scripts/x.js', '---', '',
      '# Story A', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
  fs.writeFileSync(path.join(r, 'scripts', 'x.js'), 'module.exports = 1;\n');
  for (let i = 2; i <= codigo; i += 1) fs.writeFileSync(path.join(r, 'scripts', `x${i}.js`), `module.exports = ${i};\n`);
  fs.writeFileSync(path.join(r, 'tests', 'x.test.js'), "require('node:test');\n");
  if (runDir) fs.mkdirSync(path.join(r, '.advisors', 'pipeline-runs', 'A-20260918T0100'), { recursive: true });
  return r;
}

function casa() { return fs.mkdtempSync(path.join(os.tmpdir(), 'res-adv-home-')); }

/** Un marker en el paso 8 de una corrida sobre `repo`, con lo que haga falta encima. */
function enPaso8(home, sid, repo, extra) {
  return writeFakeMarker(home, sid, {
    repoPath: repo, storyPath: repo ? path.join(repo, 'specs', 'a.md') : undefined,
    stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8],
    clockiStarted: true, dodRuntimeChecked: true,
    ...extra,
  });
}

const lanzamiento = (runId = 'wf_T', launchedAt = LANZADO) => ({ launchedAtStep: 4, runId, sessionId: 'otra', launchedAt });
const lineaDelFreno = (home) => lineas(home, 'gates.log').filter((l) => l.name === 'adversarial-result-gate');

// ─────────────────────────────── La bandera deja de escribirse a mano ───────────────────────────────

test('T1 SetFlag_DeepReviewDone_SeNiega @story-1.8 @ac-1', () => {
  // Sin el freno, `deepReviewDone` (que está en VALID_FLAGS) lo escribiría cmdSetFlag sin mirar (exit 0).
  const home = casa(); const SID = 't1';
  writeFakeMarker(home, SID);
  const antes = crudoMarker(home, SID);
  for (const v of ['true', 'false']) {
    const r = correr(home, SID, ['set-flag', 'deepReviewDone', v]);
    assert.equal(r.status, 2, `set-flag deepReviewDone ${v} tiene que salir 2 — salió ${r.status}`);
    assert.match(r.stderr, /mark-adversarial-result/);
    assert.match(r.stderr, /mark-adversarial-skipped/);
    assert.equal(crudoMarker(home, SID), antes, 'el marker queda igual byte a byte');
  }
});

test('T2 SetFlag_OtrasBanderas_SiguenAndando @story-1.8 @ac-2', () => {
  const home = casa(); const SID = 't2';
  writeFakeMarker(home, SID);
  for (const f of ['clockiStarted', 'adoMarkedActive', 'atddBypass', 'waitingForHuman']) {
    const r = correr(home, SID, ['set-flag', f, 'true']);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), `${f}: true`);
    assert.equal(leerMarker(home, SID)[f], true);
  }
});

test('T3 Set_PayloadConDeepReviewDone_NoLoEscribe @story-1.8 @ac-3', () => {
  const home = casa(); const SID = 't3';
  writeFakeMarker(home, SID);
  const r = correr(home, SID, ['set', JSON.stringify({ storyId: 'A', deepReviewDone: true })]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(leerMarker(home, SID).deepReviewDone, undefined, 'el payload de `set` no escribe la bandera');
});

// ─────────────────────────── El salteo lo decide el portón (mark-adversarial-skipped) ───────────────────────────

test('T4 Skipped_PortonLow_AnotaSalteoYCierra5b @story-1.8 @ac-4', () => {
  // Sin el comando, marker.js responde «comando desconocido» (exit 2).
  const home = casa(); const SID = 't4'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', 'scripts/x.js']);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker(home, SID);
  assert.equal(m.deepReviewDone, true);
  assert.ok(m.adversarialSkip, 'adversarialSkip escrito');
  assert.equal(m.adversarialSkip.archivos, 1);
  assert.equal(m.adversarialSkip.forzado, false);
  assert.equal(m.adversarialSkip.abandonado, false);
  assert.equal(m.adversarialSkip.runId, null);
  assert.match(m.adversarialSkip.motivo, /LOW/);
  assert.ok(!Number.isNaN(Date.parse(m.adversarialSkip.at)));
  const l = lineas(home, 'gates.log').filter((x) => x.name === 'adversarial-skip');
  assert.equal(l.length, 1);
  assert.equal(l[0].status, 'ok');
  assert.equal(l[0].storyId, 'A');
  assert.equal(l[0].forzado, false);
  assert.equal(l[0].abandonado, false);
  assert.match(l[0].motivo, /LOW/);
  assert.equal(JSON.parse(r.stdout).motivo, m.adversarialSkip.motivo, 'imprime el objeto por stdout');
});

test('T5 Skipped_PortonNormal_SeNiega @story-1.8 @ac-5', () => {
  const home = casa(); const SID = 't5'; const repo = mkRepo({ codigo: 7 });
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  const antes = crudoMarker(home, SID);
  const siete = ['scripts/x.js', 'scripts/x2.js', 'scripts/x3.js', 'scripts/x4.js', 'scripts/x5.js', 'scripts/x6.js', 'scripts/x7.js'];
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', ...siete]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /NORMAL/, 'stderr trae el reason del portón');
  assert.match(r.stderr, /Lanzamiento temprano|lanz/i, 'y la instrucción: el pase se lanza');
  // El portón que el salteo consulta deja su veredicto en la corrida (`adversarialGate`, AC 1):
  // `next` lo usa para pedir el lanzamiento. Lo que no se anota es el salteo ni el cierre del 5b.
  const despues = leerMarker(home, SID);
  assert.strictEqual(despues.adversarialGate && despues.adversarialGate.run, true, 'el veredicto «corre» queda anotado');
  const sinVeredicto = (m) => { const x = { ...m }; delete x.adversarialGate; delete x.lastTouch; return x; };
  assert.deepStrictEqual(sinVeredicto(despues), sinVeredicto(JSON.parse(antes)), 'nada más cambia: ni salteo ni cierre del 5b');
  assert.equal(crudoLog(home, 'gates.log'), '', 'gates.log sin cambios');
});

test('T6 Skipped_FilesEnUnSoloArgumento_SeNiega @story-1.8 @ac-6', () => {
  // Un `--files` sin partir cuenta 1 archivo → LOW → salteo que «selló el step».
  const home = casa(); const SID = 't6'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  const antes = crudoMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', 'a.js b.js c.js']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no pude evaluar el portón/);
  assert.match(r.stderr, /word-split|UN SOLO argumento/);
  assert.equal(crudoMarker(home, SID), antes);
  assert.equal(crudoLog(home, 'gates.log'), '');
});

test('T7 Skipped_SinFiles_SeNiega @story-1.8 @ac-6', () => {
  const home = casa(); const SID = 't7'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  const antes = crudoMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-skipped']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no pude evaluar el portón/);
  assert.match(r.stderr, /--files/);
  assert.equal(crudoMarker(home, SID), antes);
  assert.equal(crudoLog(home, 'gates.log'), '');
});

test('T8 Skipped_Interruptor_AnotaForzado @story-1.8 @ac-7', () => {
  const home = casa(); const SID = 't8'; const repo = mkRepo({ codigo: 7 });
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  // Con 7 archivos el portón diría NORMAL: sólo el interruptor lo saltea, y eso es lo que se anota como forzado.
  const siete = ['scripts/x.js', 'scripts/x2.js', 'scripts/x3.js', 'scripts/x4.js', 'scripts/x5.js', 'scripts/x6.js', 'scripts/x7.js'];
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', ...siete], { env: { TYCON_NO_DEEP_REVIEW: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker(home, SID);
  assert.equal(m.adversarialSkip.forzado, true);
  assert.equal(m.adversarialSkip.abandonado, false);
  assert.equal(m.deepReviewDone, true);
  const b = lineas(home, 'bypass.log').filter((x) => x.kind === 'ADVERSARIAL_SKIP_FORZADO');
  assert.equal(b.length, 1);
  assert.equal(b[0].storyId, 'A');
  assert.ok(b[0].motivo);
  // Y por argumento, igual.
  const home2 = casa();
  writeFakeMarker(home2, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  const r2 = correr(home2, SID, ['mark-adversarial-skipped', '--no-deep-review', '--files', ...siete]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(leerMarker(home2, SID).adversarialSkip.forzado, true);
});

test('T9 Skipped_PaseLanzado_SinInterruptor_SeNiega @story-1.8 @ac-8', () => {
  const home = casa(); const SID = 't9'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento() });
  const antes = crudoMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', 'scripts/x.js']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mark-adversarial-result/);
  assert.match(r.stderr, /TYCON_NO_DEEP_REVIEW|--no-deep-review/, 'dice que abandonarlo se decide con el interruptor');
  assert.equal(crudoMarker(home, SID), antes);
  assert.equal(crudoLog(home, 'gates.log'), '');
});

test('T10 Skipped_PaseLanzado_ConInterruptor_AnotaAbandono @story-1.8 @ac-8', () => {
  const home = casa(); const SID = 't10'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento('wf_ABANDONO') });
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', 'scripts/x.js'], { env: { TYCON_NO_DEEP_REVIEW: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker(home, SID);
  assert.equal(m.adversarialSkip.abandonado, true);
  assert.equal(m.adversarialSkip.forzado, true);
  assert.equal(m.adversarialSkip.runId, 'wf_ABANDONO');
  assert.equal(m.deepReviewDone, true);
  const b = lineas(home, 'bypass.log').filter((x) => x.kind === 'ADVERSARIAL_ABANDONADO');
  assert.equal(b.length, 1);
  assert.equal(b[0].runId, 'wf_ABANDONO');
  assert.equal(b[0].storyId, 'A');
});

test('T11 Skipped_SinCorrida_SeNiega @story-1.8 @ac-9', () => {
  const home = casa(); const SID = 't11';
  const r = correr(home, SID, ['mark-adversarial-skipped', '--files', 'scripts/x.js']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no hay corrida del pipeline en esta sesión/);
  assert.equal(crudoLog(home, 'gates.log'), '');
  assert.equal(fs.existsSync(archivoMarker(home, SID)), false);
});

// ─────────────────────────── El resultado cierra el 5b (mark-adversarial-result) ───────────────────────────

test('T12 Result5b_CierraEl5bEnLaMismaEscritura @story-1.8 @ac-10', () => {
  // Sin el comando, mark-adversarial-result no escribiría deepReviewDone.
  const home = casa(); const SID = 't12';
  writeFakeMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b']);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker(home, SID);
  assert.equal(m.deepReviewDone, true);
  assert.equal((m.adversarialPasses || []).length, 1, 'la entrada nueva está en el MISMO marker leído');
});

test('T13 ResultRevision_NoTocaDeepReviewDone @story-1.8 @ac-11', () => {
  const home = casa(); const SID = 't13';
  writeFakeMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-result', '0', '--type', 'revision']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(leerMarker(home, SID).deepReviewDone, undefined);
});

/** Marker en el 5b sobre `repo`, con el pase lanzado y (opcional) una prueba promovida y eventos de edición. */
function conPase(home, sid, repo, { promovidas = 0, eventos = [] } = {}) {
  return writeFakeMarker(home, sid, {
    repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento(),
    adversarialRegressions: Array.from({ length: promovidas }, (_, i) => ({ dest: `tests/p${i}.test.js`, ts: DESPUES })),
    fileEvents: eventos,
  });
}

test('T14 Result_Propias_SumaExacta_Acepta @story-1.8 @ac-12', () => {
  const home = casa(); const SID = 't14'; const repo = mkRepo();
  conPase(home, SID, repo, { promovidas: 1, eventos: [{ path: path.join(repo, 'tests', 'x.test.js'), ts: DESPUES }] });
  const r = correr(home, SID, ['mark-adversarial-result', '3', '--type', '5b', '--tests', '1', '--own', '1',
    '--in', 'tests/x.test.js', '--deferred', '1', '--reason', 'código preexistente, story 9.9'], { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const l = lineas(home, 'gates.log').filter((x) => x.name === 'adversarial-pass');
  assert.equal(l.length, 1);
  assert.equal(l[0].propias, 1);
  assert.deepEqual(l[0].en, ['tests/x.test.js'], 'la ruta queda relativa al repo');
  const p = leerMarker(home, SID).adversarialPasses[0];
  assert.equal(p.propias, 1);
  assert.deepEqual(p.en, ['tests/x.test.js']);
});

test('T15 Result_Propias_SumaNoDa_SeNiega @story-1.8 @ac-12', () => {
  const home = casa(); const SID = 't15'; const repo = mkRepo();
  conPase(home, SID, repo, { promovidas: 1, eventos: [{ path: path.join(repo, 'tests', 'x.test.js'), ts: DESPUES }] });
  const antes = crudoMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-result', '3', '--type', '5b', '--tests', '1', '--own', '1', '--in', 'tests/x.test.js']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /≠ 3/);
  assert.equal(crudoMarker(home, SID), antes);
  assert.equal(crudoLog(home, 'gates.log'), '');
});

/** Corre un resultado con UNA prueba propia en `ruta` y espera exit 2 sin escribir nada. */
function propiaRechazada(nombre, ruta, patron, { eventos, antesDelLanzamiento } = {}) {
  const home = casa(); const repo = mkRepo();
  fs.mkdirSync(path.join(path.dirname(repo), 'otro'), { recursive: true });
  // La (d) cuenta también la fecha del archivo (AC 35): para que «no se editó después» sea cierto, el archivo tiene
  // que tener fecha anterior al lanzamiento, no sólo no tener evento.
  if (antesDelLanzamiento) { const t = Date.parse(ANTES) / 1000; fs.utimesSync(path.join(repo, ruta), t, t); }
  const evs = eventos ? eventos(repo) : [{ path: path.join(repo, ruta), ts: DESPUES }];
  conPase(home, nombre, repo, { eventos: evs });
  const antes = crudoMarker(home, nombre);
  const r = correr(home, nombre, ['mark-adversarial-result', '1', '--type', '5b', '--tests', '0', '--own', '1', '--in', ruta]);
  assert.equal(r.status, 2, `${nombre}: tenía que salir 2 — ${r.stderr}`);
  assert.ok(r.stderr.includes(ruta), `stderr nombra la ruta: ${r.stderr}`);
  assert.match(r.stderr, patron);
  assert.equal(crudoMarker(home, nombre), antes);
  assert.equal(crudoLog(home, 'gates.log'), '');
}

test('T16 Result_En_FueraDelRepo_SeNiega @story-1.8 @ac-13', () => {
  propiaRechazada('t16', '../otro/x.test.js', /fuera del repo/);
});

test('T17 Result_En_Inexistente_SeNiega @story-1.8 @ac-13', () => {
  propiaRechazada('t17', 'tests/no-existe.test.js', /no existe/);
});

test('T18 Result_En_NoEsPrueba_SeNiega @story-1.8 @ac-13', () => {
  propiaRechazada('t18', 'scripts/x.js', /no es un archivo de prueba/);
});

test('T19 Result_En_NoTocadaDespuesDelLanzamiento_SeNiega @story-1.8 @ac-13', () => {
  propiaRechazada('t19', 'tests/x.test.js', /no se editó después del lanzamiento/, {
    eventos: (repo) => [{ path: path.join(repo, 'tests', 'x.test.js'), ts: ANTES }],
    antesDelLanzamiento: true,
  });
});

test('T20 Result_PropiasYEnDesparejos_SeNiega @story-1.8 @ac-13', () => {
  const home = casa(); const SID = 't20'; const repo = mkRepo();
  conPase(home, SID, repo, { eventos: [{ path: path.join(repo, 'tests', 'x.test.js'), ts: DESPUES }] });
  const antes = crudoMarker(home, SID);
  const casos = [
    ['--tests', '0', '--own', '1'],
    ['--tests', '0', '--deferred', '1', '--reason', 'x', '--in', 'tests/x.test.js'],
    ['--tests', '0', '--own', '1', '--in', ''],
  ];
  for (const c of casos) {
    const r = correr(home, SID, ['mark-adversarial-result', '1', '--type', '5b', ...c]);
    assert.equal(r.status, 2, `${c.join(' ')} → ${r.status} ${r.stderr}`);
  }
  assert.equal(crudoMarker(home, SID), antes);
  assert.equal(crudoLog(home, 'gates.log'), '');
});

test('T21 Result_RevisionSinLanzamiento_DiceQueNoPudoFechar @story-1.8 @ac-14', () => {
  const home = casa(); const SID = 't21'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  // A propósito con las opciones viejas: una sesión abierta con las instrucciones de antes en la memoria las sigue
  // mandando, y el marker.js real (no un laboratorio) tiene que entenderlas igual hasta el retiro.
  assert.notEqual(vieja('own'), '--own', 'la tabla del puente trae el nombre viejo');
  const r = correr(home, SID, ['mark-adversarial-result', '1', vieja('type'), 'revision', vieja('tests'), '0', vieja('own'), '1',
    vieja('in'), 'tests/x.test.js']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no pude verificar que se tocaron después del pase: no hay lanzamiento anotado/);
  const l = lineas(home, 'gates.log').find((x) => x.name === 'adversarial-pass');
  assert.equal(l.enSinFecha, true);
  assert.equal(l.propias, 1);
  // Sin marker (revisión a mano), la base de las rutas es la raíz git del directorio actual.
  const home2 = casa();
  const r2 = correr(home2, 'sin-corrida', ['mark-adversarial-result', '1', '--type', 'revision', '--story', 'A', '--tests', '0',
    '--own', '1', '--in', 'tests/x.test.js'], { cwd: path.join(repo, 'scripts') });
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(lineas(home2, 'gates.log').find((x) => x.name === 'adversarial-pass').en, ['tests/x.test.js']);
});

test('T22 Result_FormaDeHoy_SigueAndando @story-1.8 @ac-15', () => {
  const home = casa(); const SID = 't22';
  writeFakeMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-result', '2', '--type', '5b', '--tests', '0', '--deferred', '2', '--reason', 'x']);
  assert.equal(r.status, 0, r.stderr);
  const l = lineas(home, 'gates.log').find((x) => x.name === 'adversarial-pass');
  assert.equal(l.propias, 0);
  assert.equal(l.pruebas, 0);
  assert.equal(l.diferidos, 2);
});

// ─────────────────────────── El paso 8 no cierra sin el pase atendido ───────────────────────────

test('T23 Paso8_LanzadoSinResultado_Bloquea @story-1.8 @ac-16', () => {
  // Sin el freno, complete-step 8 no mira el pase y cierra con dodRuntimeChecked y el resto.
  const home = casa(); const SID = 't23'; const repo = mkRepo();
  enPaso8(home, SID, repo, { adversarial: lanzamiento('wf_SIN'), adversarialPasses: [] });
  const r = correr(home, SID, ['complete-step', '8']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /el pase adversarial se lanzó \(wf_SIN/);
  assert.match(r.stderr, /mark-adversarial-result <N confirmados> --type 5b --result <RUN_DIR>\/step-05b-adversarial\.json --run wf_SIN/);
  const l = lineaDelFreno(home);
  assert.equal(l.length, 1);
  assert.equal(l[0].status, 'blocked');
  assert.equal(l[0].motivo, 'sin-resultado');
  assert.equal(l[0].story, 'A');
  assert.equal(l[0].step, 8);
  assert.equal(l[0].runId, 'wf_SIN');
  assert.ok(leerMarker(home, SID).stepsPending.includes(8), 'el paso 8 sigue pendiente');
});

test('T24 Paso8_ResultadoDespuesDelLanzamiento_Pasa @story-1.8 @ac-17', () => {
  const home = casa(); const SID = 't24'; const repo = mkRepo();
  enPaso8(home, SID, repo, { adversarial: lanzamiento(), adversarialPasses: [{ ts: DESPUES, tipo: '5b', confirmados: 0 }] });
  correr(home, SID, ['complete-step', '8']);
  const l = lineaDelFreno(home);
  assert.equal(l.length, 1);
  assert.equal(l[0].status, 'ok');
  assert.equal(l[0].motivo, 'resultado');
});

test('T25 Paso8_ResultadoDeOtroLanzamiento_Bloquea @story-1.8 @ac-18', () => {
  const home = casa(); const SID = 't25'; const repo = mkRepo();
  enPaso8(home, SID, repo, { adversarial: lanzamiento(), adversarialPasses: [{ ts: ANTES, tipo: '5b', confirmados: 0 }] });
  const r = correr(home, SID, ['complete-step', '8']);
  assert.equal(r.status, 2);
  assert.equal(lineaDelFreno(home)[0].motivo, 'resultado-de-otro-lanzamiento');
});

test('T26 Paso8_SalteoAnotado_Pasa @story-1.8 @ac-19', () => {
  const casos = [
    [{ adversarialSkip: { motivo: 'LOW', archivos: 1, forzado: false, abandonado: false, runId: null, at: DESPUES } }, 'salteado'],
    [{ adversarialSkip: { motivo: 'OFF', archivos: 1, forzado: true, abandonado: false, runId: null, at: DESPUES } }, 'salteado-forzado'],
    [{ adversarial: lanzamiento('wf_AB'), adversarialSkip: { motivo: 'OFF', archivos: 1, forzado: true, abandonado: true, runId: 'wf_AB', at: DESPUES } }, 'abandonado'],
  ];
  for (const [extra, motivo] of casos) {
    const home = casa(); const repo = mkRepo();
    enPaso8(home, 't26', repo, extra);
    correr(home, 't26', ['complete-step', '8']);
    const l = lineaDelFreno(home);
    assert.equal(l.length, 1, motivo);
    assert.equal(l[0].status, 'ok', motivo);
    assert.equal(l[0].motivo, motivo);
  }
});

test('T27 Paso8_NiLanzadoNiSalteado_Bloquea @story-1.8 @ac-20', () => {
  // El marker de una corrida vieja: el 5b cerrado con la bandera, sin lanzamiento ni salteo.
  const home = casa(); const SID = 't27'; const repo = mkRepo();
  enPaso8(home, SID, repo, { deepReviewDone: true });
  const r = correr(home, SID, ['complete-step', '8']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /el 5b no está atendido: ni lanzado ni salteado por el portón/);
  assert.match(r.stderr, /mark-adversarial-result/);
  assert.match(r.stderr, /mark-adversarial-skipped/);
  const l = lineaDelFreno(home);
  assert.equal(l[0].status, 'blocked');
  assert.equal(l[0].motivo, 'no-atendido');
});

test('T28 Paso8_DodBypass_NoAbreEsteFreno @story-1.8 @ac-21', () => {
  // Fixture: sin storyPath (el freno del findings.json queda en «no pude mirar», que no bloquea), story no-UI y
  // `dodRuntimeChecked: false` → el único otro freno es el de DoD no-UI, que DOD_BYPASS=1 abre. Lo único que
  // decide el exit es ESTE freno.
  const home = casa(); const SID = 't28';
  writeFakeMarker(home, SID, {
    repoPath: os.tmpdir(), storyPath: null, stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8],
    dodRuntimeChecked: false, adversarial: lanzamiento('wf_BYP'),
  });
  const r = correr(home, SID, ['complete-step', '8'], { env: { DOD_BYPASS: '1' } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /el pase adversarial se lanzó \(wf_BYP/, 'el exit 2 sale de ESTE freno');
  assert.match(r.stderr, /no se abre con DOD_BYPASS/);
  // Con el resultado anotado, DOD_BYPASS abre el freno viejo y el paso 8 cierra.
  const m = leerMarker(home, SID);
  m.adversarialPasses = [{ ts: DESPUES, tipo: '5b', confirmados: 0 }];
  fs.writeFileSync(archivoMarker(home, SID), JSON.stringify(m));
  const r2 = correr(home, SID, ['complete-step', '8'], { env: { DOD_BYPASS: '1' } });
  assert.equal(r2.status, 0, r2.stderr);
});

test('T29 Paso8_DosFrenosALaVez_DosMensajes @story-1.8 @ac-22', () => {
  const home = casa(); const SID = 't29'; const repo = mkRepo({ runDir: true });
  enPaso8(home, SID, repo, { adversarial: lanzamiento('wf_DOS') });
  const r = correr(home, SID, ['complete-step', '8']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FALTA el findings\.json/);
  assert.match(r.stderr, /el pase adversarial se lanzó \(wf_DOS/);
});

test('T30 Paso8_RegistroIlegible_Bloquea @story-1.8 @ac-23', () => {
  const casos = [
    [{ adversarial: lanzamiento(), adversarialPasses: 'x' }, 'registro-ilegible', /adversarialPasses/],
    [{ adversarial: lanzamiento('wf_T', 'ayer') }, 'lanzamiento-sin-fecha', /launchedAt/],
  ];
  for (const [extra, motivo, campo] of casos) {
    const home = casa(); const repo = mkRepo();
    enPaso8(home, 't30', repo, extra);
    const r = correr(home, 't30', ['complete-step', '8']);
    assert.equal(r.status, 2, motivo);
    assert.match(r.stderr, campo, `stderr dice qué campo no se pudo leer (${motivo})`);
    const l = lineaDelFreno(home);
    assert.equal(l[0].status, 'blocked', motivo);
    assert.equal(l[0].motivo, motivo);
  }
});

// ─────────────────────────── Lo que no se hereda entre stories ───────────────────────────

test('T31 Set_StoryNueva_ReseteaLoAdversarial @story-1.8 @ac-24', () => {
  // Sin esto, cmdSet resetea adversarial y deepReviewDone pero no adversarialPasses ni adversarialRegressions.
  const home = casa(); const SID = 't31';
  writeFakeMarker(home, SID, {
    adversarialPasses: [{ ts: DESPUES, tipo: '5b', confirmados: 0 }],
    adversarialRegressions: [{ dest: 'tests/p.test.js' }],
    adversarialSkip: { motivo: 'LOW', forzado: false, abandonado: false },
  });
  const r = correr(home, SID, ['set', JSON.stringify({ storyId: 'B', stepsPending: [1, 2, 3, 4, 5, 6, 7, 8] })]);
  assert.equal(r.status, 0, r.stderr);
  const m = leerMarker(home, SID);
  assert.equal(m.storyId, 'B');
  assert.equal(m.adversarialPasses, undefined);
  assert.equal(m.adversarialRegressions, undefined);
  assert.equal(m.adversarialSkip, undefined);
});

// ─────────────────────────── No-regresión ───────────────────────────

/** `pipeline.js next` sobre una corrida con los pasos 0..5 hechos. */
function next(home, sid, repo, extra) {
  writeFakeMarker(home, sid, {
    repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'),
    stepsCompleted: [0, 1, 2, 3, 4, 5], stepsPending: [6, 7, 8], clockiStarted: true, ...extra,
  });
  const r = spawnSync(process.execPath, [PIPELINE, 'next'], { encoding: 'utf8', env: entorno(home, sid), cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('T32 Next_5bAtendidoSoloConLaBandera @story-1.8 @ac-30', () => {
  const repo = mkRepo();
  const con = next(casa(), 't32', repo, { deepReviewDone: true });
  assert.equal(con.steps.find((s) => s.step === '5b').done, true);
  assert.notEqual(con.next_step, '5b');
  const sin = next(casa(), 't32', repo, {});
  assert.equal(sin.next_step, '5b');
});

test('T33 Regresion_LanzamientoYPromoteComoHoy @story-1.8 @ac-29', () => {
  const home = casa(); const SID = 't33'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
  assert.equal(correr(home, SID, ['mark-adversarial-launched', 'wf_1', '4']).status, 0);
  const re = correr(home, SID, ['mark-adversarial-launched', 'wf_2', '4']);
  assert.equal(re.status, 2, 'relanzar en la misma sesión sin --relaunch sigue saliendo 2');
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'res-adv-probe-'));
  fs.writeFileSync(path.join(probe, 'p.js.txt'), "require('node:test');\n");
  const pr = correr(home, SID, ['promote-probe', probe, '--file', 'p.js.txt', '--a', 'tests/x.test.js']);
  assert.equal(pr.status, 2, 'promote-probe sobre un destino existente sigue saliendo 2');
  assert.match(pr.stderr, /editalo a mano/);
  // Revisión a mano sin corrida: como hoy.
  const home2 = casa();
  const rv = correr(home2, 'sin-corrida', ['mark-adversarial-result', '0', '--type', 'revision', '--story', 'X']);
  assert.equal(rv.status, 0, rv.stderr);
  assert.equal(lineas(home2, 'gates.log').find((x) => x.name === 'adversarial-pass').storyId, 'X');
});

test('T34 Paso8_FrenosExistentes_MismaLinea @story-1.8 @ac-31', () => {
  const home = casa(); const SID = 't34'; const repo = mkRepo({ runDir: true });
  enPaso8(home, SID, repo, { adversarial: lanzamiento(), adversarialPasses: [{ ts: DESPUES, tipo: '5b', confirmados: 0 }] });
  const r = correr(home, SID, ['complete-step', '8']);
  assert.equal(r.status, 2);
  const f = lineas(home, 'gates.log').filter((x) => x.name === 'findings-json');
  assert.equal(f.length, 1);
  // `storyPath` se suma a cada línea (con número repetido, sólo cuenta la línea que trae la ruta propia):
  // como `ts`, `sessionId` y `repoPath`, va aparte de lo que esta prueba compara.
  const { ts, sessionId, repoPath, storyPath, ...campos } = f[0];
  assert.ok(storyPath && storyPath.endsWith('a.md'), `la línea trae la ruta de la story: ${storyPath}`);
  assert.deepEqual(campos, { name: 'findings-json', action: 'bloqueo', story: 'A', step: 8, motivo: 'findings.json ausente' });
});

// ─────────────────────────── Los textos del pipeline ───────────────────────────

test('T40 Textos_SinSetFlagDeepReviewDone @story-1.8 @ac-27', () => {
  const dir = path.join(SKILL, 'steps');
  const textos = [...fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)), path.join(SKILL, 'SKILL.md')];
  for (const t of textos) {
    assert.ok(!fs.readFileSync(t, 'utf8').includes('set-flag deepReviewDone'), `${path.basename(t)} todavía dice set-flag deepReviewDone`);
  }
  const s8 = fs.readFileSync(path.join(dir, 'step-08-commit-prep.md'), 'utf8');
  assert.match(s8, /adversarial-result-gate/);
  assert.match(s8, /mark-adversarial-result/);
  const s4 = fs.readFileSync(path.join(dir, 'step-04-execute.md'), 'utf8');
  assert.match(s4, /mark-adversarial-skipped/);
  const s5b = fs.readFileSync(path.join(dir, 'step-05b-adversarial-verify.md'), 'utf8');
  assert.match(s5b, /mark-adversarial-skipped/);
  assert.match(s5b, /--own/);
  assert.match(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'), /mark-adversarial-skipped/);
});

test('T42 Next_NotaDel5b_NombraLosComandos @story-1.8 @ac-27 @ac-30', () => {
  // El `note` del 5b no puede decir «Al completar: marker.js set-flag deepReviewDone true»: ese comando sale 2.
  const d = next(casa(), 't42', mkRepo(), {});
  assert.equal(d.next_step, '5b');
  assert.ok(!d.note.includes('set-flag deepReviewDone'), d.note);
  assert.match(d.note, /mark-adversarial-result/);
  assert.match(d.note, /mark-adversarial-skipped/);
});

// ─────────────────── Casos límite del resultado (AC 34-41) ───────────────────

/** Un resultado con UNA prueba propia; devuelve el proceso. */
function propia(home, sid, ruta, { cwd } = {}) {
  return correr(home, sid, ['mark-adversarial-result', '1', '--type', '5b', '--tests', '0', '--own', '1', '--in', ruta], { cwd });
}

test('T43 Result_En_AliasDeEnlace_Acepta @story-1.8 @ac-34', () => {
  // «Fuera del repo» se decide sobre la ruta resuelta: si se comparara la ruta ESCRITA contra el repo RESUELTO, una
  // ruta absoluta escrita igual que marker.repoPath (/tmp en vez de /private/tmp) quedaría afuera.
  const home = casa(); const SID = 't43'; const repo = mkRepo();
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'res-adv-alias-')), 'repo');
  fs.symlinkSync(repo, alias);
  writeFakeMarker(home, SID, { repoPath: alias, storyPath: path.join(alias, 'specs', 'a.md'), adversarial: lanzamiento(),
    fileEvents: [{ path: path.join(alias, 'tests', 'x.test.js'), ts: DESPUES }] });
  const r = propia(home, SID, path.join(alias, 'tests', 'x.test.js'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lineas(home, 'gates.log').find((x) => x.name === 'adversarial-pass').en, ['tests/x.test.js']);
});

test('T44 Result_En_MayusculasDistintas_Acepta @story-1.8 @ac-34', () => {
  // La (d) compara sin distinguir mayúsculas: fs.realpathSync (JS) las conserva como vienen y una comparación exacta fallaría.
  const home = casa(); const SID = 't44'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento(),
    fileEvents: [{ path: path.join(repo, 'TESTS', 'X.test.js'), ts: DESPUES }] });
  const t = Date.parse(ANTES) / 1000; fs.utimesSync(path.join(repo, 'tests', 'x.test.js'), t, t); // sólo el evento puede probarlo
  const r = propia(home, SID, 'tests/x.test.js');
  assert.equal(r.status, 0, r.stderr);
});

test('T45 Result_En_EditadaPorConsola_Acepta @story-1.8 @ac-35', () => {
  // Sin evento en fileEvents (edición por sed/heredoc: on-edit.js sólo escucha Edit|Write) sale 2.
  const home = casa(); const SID = 't45'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento(), fileEvents: [] });
  const t = Date.parse(DESPUES) / 1000; fs.utimesSync(path.join(repo, 'tests', 'x.test.js'), t, t);
  const r = propia(home, SID, 'tests/x.test.js');
  assert.equal(r.status, 0, r.stderr);
});

/** Un segundo repo git con una prueba propia, como el agent-skills de una story de dos repos. */
function repoHermano() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'res-adv-hermano-')));
  spawnSync('git', ['init', '-q', r]);
  fs.mkdirSync(path.join(r, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(r, 'tests', 'y.test.js'), "require('node:test');\n");
  return r;
}

test('T46 Result_En_RepoHermanoEditado_Acepta @story-1.8 @ac-36', () => {
  // Una ruta fuera de marker.repoPath no es «fuera del repo» si es de un repo hermano de la corrida: las pruebas
  // pueden vivir en agent-skills mientras el repo de la corrida es el arnés.
  const home = casa(); const SID = 't46'; const repo = mkRepo(); const r2 = repoHermano();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento(),
    fileEvents: [{ path: path.join(r2, 'tests', 'y.test.js'), ts: DESPUES }] });
  const r = propia(home, SID, path.join(r2, 'tests', 'y.test.js'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lineas(home, 'gates.log').find((x) => x.name === 'adversarial-pass').en, [`(${path.basename(r2)}) tests/y.test.js`]);
});

test('T47 Result_En_RepoHermanoNoEditado_SeNiega @story-1.8 @ac-36', () => {
  const home = casa(); const SID = 't47'; const repo = mkRepo(); const r2 = repoHermano();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento(),
    fileEvents: [{ path: path.join(repo, 'tests', 'x.test.js'), ts: DESPUES }] });
  const antes = crudoMarker(home, SID);
  const r = propia(home, SID, path.join(r2, 'tests', 'y.test.js'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fuera del repo/);
  assert.equal(crudoMarker(home, SID), antes);
});

test('T48 Paso8_ResultadoSinLanzamiento_Pasa @story-1.8 @ac-37', () => {
  // El resultado que cierra el 5b (next avanza) también tiene que dar por atendido el pase en el paso 8.
  const home = casa(); const SID = 't48'; const repo = mkRepo();
  enPaso8(home, SID, repo, { adversarialPasses: [{ ts: DESPUES, tipo: '5b', confirmados: 0 }] });
  const r = correr(home, SID, ['complete-step', '8']);
  const l = lineaDelFreno(home);
  assert.equal(l.length, 1, r.stderr);
  assert.equal(l[0].status, 'ok');
  assert.equal(l[0].motivo, 'resultado-sin-lanzamiento');
  assert.doesNotMatch(r.stderr, /el 5b no está atendido/);
});

test('T49 Result_Pruebas_CuentaSoloDelLanzamientoVigente @story-1.8 @ac-38', () => {
  // Se cuentan sólo las promovidas del lanzamiento actual, no las de toda la corrida.
  const home = casa(); const SID = 't49'; const repo = mkRepo();
  writeFakeMarker(home, SID, { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md'), adversarial: lanzamiento(),
    adversarialRegressions: [{ dest: 'tests/viejo.test.js', ts: ANTES }, { dest: 'tests/nuevo.test.js', ts: DESPUES }] });
  const no = correr(home, SID, ['mark-adversarial-result', '2', '--type', '5b', '--tests', '2']);
  assert.equal(no.status, 2, 'la promovida del lanzamiento anterior no cuenta');
  const si = correr(home, SID, ['mark-adversarial-result', '1', '--type', '5b', '--tests', '1']);
  assert.equal(si.status, 0, si.stderr);
});

test('T50 Result_OtraStory_NoTocaLaCorrida @story-1.8 @ac-39', () => {
  // El resultado de la story B no se suma a la corrida de A ni le cierra el 5b.
  const home = casa(); const SID = 't50';
  writeFakeMarker(home, SID);
  const antes = crudoMarker(home, SID);
  const r = correr(home, SID, ['mark-adversarial-result', '0', '--type', '5b', '--story', 'B']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lineas(home, 'gates.log').find((x) => x.name === 'adversarial-pass').storyId, 'B');
  assert.equal(crudoMarker(home, SID), antes, 'el marker de A queda igual byte a byte');
});

test('T52 Skipped_ArchivosCuentaComoElPorton @story-1.8 @ac-41', () => {
  // marker.js cuenta todos los --files y no cuenta el argumento vacío, igual que el portón.
  const casos = [[['--files', 'scripts/x.js', '--files', 'scripts/x2.js'], 2], [['--files', 'scripts/x.js', '', 'scripts/x2.js'], 1]];
  for (const [args, n] of casos) {
    const home = casa(); const repo = mkRepo({ codigo: 2 });
    writeFakeMarker(home, 't52', { repoPath: repo, storyPath: path.join(repo, 'specs', 'a.md') });
    const r = correr(home, 't52', ['mark-adversarial-skipped', ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(leerMarker(home, 't52').adversarialSkip.archivos, n, JSON.stringify(args));
  }
});
