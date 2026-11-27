#!/usr/bin/env node
'use strict';
// start-silences.test.js — los errores que el arranque de una corrida y sus carpetas tragaban sin decir nada.
//
// Caso: un marcador ilegible de otra sesión, una falla del reporte sin ruta, una carpeta de corrida que no se lee o sin
// permiso, una carpeta nueva sin decir por qué, la rama propia ilegible dicha como «de la otra sesión», y tres lecturas
// de la configuración que caían a lo de siempre sin rastro. Cada uno ahora avisa o queda como no medido.
//
//   S1  un marcador de otra sesión que no se lee: el arranque lo dice
//   S2  una falla del reporte sin ruta: la prueba queda no medida, no en silencio
//   S3  una carpeta de corrida sin permiso no se toma por «ya no está», ni se crea otra encima
//   S4  una carpeta de corrida que no se lee: lo dice al elegir
//   S5  una carpeta nueva sin marcador que sirva: dice por qué no usó la del marcador
//   S6  la rama propia que no se lee: el texto dice «de esta sesión»
//   S7  una historia que no se lee al buscar su parte: lo dice
//   S8  el tope de rechazos del repo con su archivo de ajustes roto: lo dice
//
// Corre con un HOME temporal. Correr: node --test skills/tycon-pipeline/scripts/tests/start-silences.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const ES_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function historia() {
  return ['---', 'story: "9.9"', 'title: "juguete"', 'status: ready-for-dev', '---', '# Story 9.9', '', '## Acceptance Criteria', '',
    '1. **Given** algo, **Then** resultado.', '', '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `a.caso1` | 1 | unit | x | y |', ''].join('\n');
}

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'start-silences-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-juguete.md');
  fs.writeFileSync(story, historia());
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none' });
  const arrancar = (sid) => spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'start', '--story', story, '--repo', repo], { encoding: 'utf8', env: env(sid), input: '', cwd: repo });
  const active = path.join(home, '.claude', '.tycon-pipeline', 'active');
  const escribir = (sid, texto) => { fs.mkdirSync(active, { recursive: true }); fs.writeFileSync(path.join(active, `${sid}.json`), texto); };
  return { base, home, repo, story, git, arrancar, escribir };
}
const salida = (r) => `${r.stdout}\n${r.stderr}`;
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return {}; } };

/** Corre `fn` con stderr capturado: `{ valor, err }`. */
function conStderr(fn) {
  const escribir = process.stderr.write.bind(process.stderr);
  let err = '';
  process.stderr.write = (t) => { err += String(t); return true; };
  try { return { valor: fn(), err }; } finally { process.stderr.write = escribir; }
}

test('S1 Arranque_MarcadorIlegible_LoDice — un marcador de otra sesión que no se lee no se calla', () => {
  const E = entorno();
  E.escribir('s-rota', '{ esto no es json');
  const r = E.arrancar('s-1');
  assert.match(salida(r), /no pude leer el marcador de otra sesión \(s-rota\.json/, salida(r));
});

test('S6 Arranque_RamaPropiaIlegible_DiceDeEstaSesion — el texto no culpa a la otra sesión', () => {
  const E = entorno();
  // stable-data: la otra sesión tiene que estar viva, y `start` mide la vida de un marcador contra el reloj real
  E.escribir('s-otra', JSON.stringify({ storyId: '9.9', storyPath: E.story, repoPath: E.repo, sessionId: 's-otra', lastTouch: new Date().toISOString(), stepsCompleted: ['start'] }));
  // una rama sin commits: `git rev-parse --abbrev-ref HEAD` no contesta
  E.git('checkout', '-q', '--orphan', 'sin-commits');
  const r = E.arrancar('s-6');
  const detalle = (json(r).pauses || []).map((p) => p.detail).join('\n');
  assert.match(detalle, /No pude leer la rama de esta sesión/, salida(r));
  assert.doesNotMatch(detalle, /la rama de la otra sesión \(la de esta sesión/, salida(r));
});

test('S2 PruebaEnRojo_FallaSinRuta_NoMedida — una falla del reporte sin ruta deja la prueba no medida', () => {
  const RT = require(path.join(SCRIPTS, 'lib', 'red-test-edit.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'red-sin-ruta-'));
  const prueba = path.join(repo, 'scripts', 'tests', 'algo.test.js');
  fs.mkdirSync(path.dirname(prueba), { recursive: true });
  fs.writeFileSync(prueba, '// prueba\n');
  const reporte = { by: { session: 's-2' }, totals: { failure_entries: [{ raiz: 'arnes' }] } };
  const d = RT.decidir({ archivo: prueba, marker: {}, sessionId: 's-2', reporte, repoDelReporte: repo, existiaEnMain: () => true });
  assert.strictEqual(d.decision, 'no-medido', JSON.stringify(d));
  assert.match(d.motivo, /no dice su ruta/);
});

test('S3 CarpetaDeCorrida_SinPermiso_NoEsYaNoEsta — un EACCES no se toma por una carpeta que falta', { skip: ES_ROOT && 'como root no hay EACCES' }, () => {
  const RD = require(path.join(SCRIPTS, 'lib', 'run-dir.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-dir-eacces-'));
  const cerrada = path.join(repo, '.advisors', 'pipeline-runs');
  const dir = path.join(cerrada, '9.9-20260101100000');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(cerrada, 0o000);
  try {
    const marker = { storyId: '9.9', sessionId: 's-3', repoPath: repo, runDir: dir };
    const { valor, err } = conStderr(() => RD.resolveRunDir(repo, '9.9', true, null, { marker }));
    assert.notStrictEqual(valor, dir, 'no la crea encima');
    assert.match(err, /no se puede leer|EACCES/, err);
  } finally { fs.chmodSync(cerrada, 0o755); }
});

test('S4 CarpetaDeCorrida_Ilegible_LoDiceAlElegir — una carpeta que no se lee no cuenta callada como vacía', { skip: ES_ROOT && 'como root no hay EACCES' }, () => {
  const RD = require(path.join(SCRIPTS, 'lib', 'run-dir.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-dir-ilegible-'));
  const runs = path.join(repo, '.advisors', 'pipeline-runs');
  const vieja = path.join(runs, '9.9-20260101100000');
  const nueva = path.join(runs, '9.9-20260102100000');
  fs.mkdirSync(vieja, { recursive: true });
  fs.writeFileSync(path.join(vieja, 'plan.md'), 'x');
  fs.mkdirSync(nueva, { recursive: true });
  fs.chmodSync(nueva, 0o000);
  try {
    const { err } = conStderr(() => RD.resolveRunDir(repo, '9.9', false, null, { marker: null }));
    assert.match(err, /9\.9-20260102100000[^\n]*no se (puede leer|lee)/, err);
  } finally { fs.chmodSync(nueva, 0o755); }
});

test('S5 CarpetaNueva_DicePorQueNoLaDelMarcador — sin carpetas, al crear dice el motivo del marcador', () => {
  const RD = require(path.join(SCRIPTS, 'lib', 'run-dir.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'run-dir-nueva-'));
  const marker = { storyId: '9.9', sessionId: '_nosession' };
  const { valor, err } = conStderr(() => RD.resolveRunDir(repo, '9.9', true, null, { marker }));
  assert.ok(valor && fs.existsSync(valor), 'la crea');
  assert.match(err, /no tiene carpeta de corrida/, err);
});

test('S7 Parte_HistoriaIlegible_LoDice — buscar la parte de una historia que no se lee no se calla', () => {
  const BS = require(path.join(SCRIPTS, 'lib', 'batch-scope.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parte-ilegible-'));
  const { valor, err } = conStderr(() => BS.parteMedible(dir, 'A-la-primera'));
  assert.strictEqual(valor, null);
  assert.match(err, /no pude leer la historia/, err);
  // una historia que no está no es un error que avisar: no hay parte
  const { err: err2 } = conStderr(() => BS.parteMedible(path.join(dir, 'no-esta.md'), 'A-la-primera'));
  assert.strictEqual(err2, '');
});

test('S8 TopeDeRechazos_AjusteRoto_LoDice — un .tycon/advisors.yaml que no se lee no cae callado al de la organización', () => {
  const PR = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
  const CS = require(path.join(SCRIPTS, 'lib', 'config-source.js'));
  const antes = CS.leerCommiteado;
  CS.leerCommiteado = () => { throw new Error('no es YAML'); };
  try {
    const { valor, err } = conStderr(() => PR.topeDeRechazos({ review: { max_rounds: 3 } }, '/un/repo'));
    assert.strictEqual(valor, 3, 'vale el de la organización');
    assert.match(err, /review\.max_rounds[^\n]*no es YAML/, err);
  } finally { CS.leerCommiteado = antes; }
});

// S9 · 🔴 Falla con: una parte que no está en la historia (o un bloque pipelines que no se lee) devuelve null callada, y se
//      mide la historia entera sin decirlo.
test('S9 Parte_NoValida_LoDice — buscar una parte que no está no se calla', () => {
  const BS = require(path.join(SCRIPTS, 'lib', 'batch-scope.js'));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parte-no-esta-')), 'h.md');
  fs.writeFileSync(f, historia());
  const { valor, err } = conStderr(() => BS.parteMedible(f, 'Z-no-existe'));
  assert.strictEqual(valor, null);
  assert.match(err, /Z-no-existe/, err);
});

// S10 · 🔴 Falla con: un review.max_rounds del repo que no es un número válido (o fuera del rango) cae callado al de la
//       organización.
test('S10 TopeDeRechazos_ValorInvalido_LoDice — un max_rounds que no sirve no cae callado al de la organización', () => {
  const PR = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
  const CS = require(path.join(SCRIPTS, 'lib', 'config-source.js'));
  const antes = CS.leerCommiteado;
  CS.leerCommiteado = () => 'review:\n  max_rounds: tres\n';
  try {
    const { valor, err } = conStderr(() => PR.topeDeRechazos({ review: { max_rounds: 3 } }, '/un/repo'));
    assert.strictEqual(valor, 3, 'vale el de la organización');
    assert.match(err, /review\.max_rounds[^\n]*tres/, err);
  } finally { CS.leerCommiteado = antes; }
});

// S11 · 🔴 Falla con: la lista de lo sensible (save-ok.js) que no carga deja `esSensible` en null sin decirlo: el delegado
//       no guarda nada y nadie sabe por qué.
test('S11 FrenoDeLaLista_SensiblesSinCargar_LoDice — sin la lista de lo sensible, se dice', () => {
  const SB = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));
  const ruta = require.resolve(path.join(SCRIPTS, 'lib', 'save-ok.js'));
  const antes = require.cache[ruta];
  require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports: { get esSensible() { throw new Error('no cargó'); } } };
  try {
    const { valor, err } = conStderr(() => SB.cargarEsSensible());
    assert.strictEqual(valor, null);
    assert.match(err, /lo sensible[^\n]*no cargó/, err);
  } finally { if (antes) require.cache[ruta] = antes; else delete require.cache[ruta]; }
});
