#!/usr/bin/env node
'use strict';
/**
 * marker-session-names.test.js — las sesiones de la corrida, con su nombre, en el marcador y en el volcado.
 *
 * QUÉ CUIDA: que `set`, `complete-step`, `adopt-session`, `restore` y `clear` pongan al día la entrada de la sesión que
 * corre el comando en `marker.sesiones` (una por sesión, hasta 10, con el nombre que tiene en su máquina), que el volcado
 * del cierre la lleve, y que no poder leer el nombre nunca frene un comando ni cambie su salida.
 *
 * Cada caso corre el marcador real en su casa temporal, con sesiones inventadas y su archivo de sesión ahí: ninguna
 * prueba lee ni escribe la carpeta de sesiones real.
 *
 * stable-data: las horas son las del reloj de la corrida de la prueba; los commits del repo de juguete llevan fecha fija.
 *
 * Correr (desde esta carpeta): node --test marker-session-names.test.js < /dev/null
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const ARBOL = path.resolve(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const A = 'dddddddd-0000-4000-8000-0000000000a1';
const B = 'dddddddd-0000-4000-8000-0000000000b2';
const LINEA = /\[marker\] no pude leer el nombre de la sesión \(([a-z-]+)\)/g;

function corral(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sesiones-corrida-'));
  t.after(() => {
    try { fs.chmodSync(path.join(raiz, 'home', '.claude', 'sessions'), 0o755); } catch (_e) { /* ya está legible */ }
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'home', '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'repo'), { recursive: true });
  return raiz;
}

function nombrar(raiz, sid, name, pid) {
  fs.writeFileSync(path.join(raiz, 'home', '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: '/tmp/acme', name, nameSource: 'user' }));
}

function correr(raiz, sid, args, { marker = MARKER, env = {} } = {}) {
  return spawnSync(process.execPath, [marker, ...args], {
    encoding: 'utf8', input: '', cwd: path.join(raiz, 'repo'),
    env: {
      ...process.env,
      HOME: path.join(raiz, 'home'), USERPROFILE: path.join(raiz, 'home'), CLAUDE_CODE_SESSION_ID: sid, TYCON_GUIDES_DIR: ARBOL,
      TYCON_PROJECTS_DIR: path.join(raiz, 'projects'), TYCON_NO_THREAD_RESCUE: '1', TYCON_NO_RUN_CHANGE: '1', TYCON_LANE_LLM: '0',
      TYCON_SIGN_PRECHECK: '', ...env,
    },
  });
}

const archivo = (raiz, sid) => path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
const leer = (raiz, sid) => JSON.parse(fs.readFileSync(archivo(raiz, sid), 'utf8'));

function abrir(raiz, sid, opts) {
  const repo = path.join(raiz, 'repo');
  const r = correr(raiz, sid, ['set', JSON.stringify({ storyId: '2.83-prueba', storyPath: path.join(repo, 'story.md'), repoPath: repo, stepScheme: 2, stepsCompleted: ['start'], stepsPending: ['validate-story', 'plan', 'approve-plan'] })], opts);
  assert.strictEqual(r.status, 0, `marker set falló: ${r.stderr}`);
  return r;
}

function volcado(raiz) {
  const d = path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'timing-history');
  const fs1 = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : [];
  assert.strictEqual(fs1.length, 1, `un volcado: ${fs1.join(', ')}`);
  return JSON.parse(fs.readFileSync(path.join(d, fs1[0]), 'utf8'));
}

test('T4 2.83-Marcador_AnotaYActualizaElNombre @story-2.83 @ac-1 @ac-2 @ac-5', (t) => {
  const raiz = corral(t);
  nombrar(raiz, A, 'Carrizo-4', 4242);
  abrir(raiz, A);
  const m1 = leer(raiz, A);
  assert.strictEqual(m1.sesiones.length, 1, JSON.stringify(m1.sesiones));
  assert.deepStrictEqual({ id: m1.sesiones[0].id, nombre: m1.sesiones[0].nombre }, { id: A, nombre: 'Carrizo-4' });
  assert.ok(Number.isFinite(Date.parse(m1.sesiones[0].visto)), 'visto es una hora ISO');
  // la sesión cambia de nombre entre dos pasos: la misma entrada, con el nombre y la hora nuevos
  nombrar(raiz, A, 'Carrizo-5', 4242);
  const c = correr(raiz, A, ['complete-step', 'validate-story']);
  assert.strictEqual(c.status, 0, c.stderr);
  const m2 = leer(raiz, A);
  assert.strictEqual(m2.sesiones.length, 1, JSON.stringify(m2.sesiones));
  assert.strictEqual(m2.sesiones[0].nombre, 'Carrizo-5');
  assert.ok(m2.sesiones[0].visto >= m1.sesiones[0].visto, 'visto nuevo');
  // el cierre: el volcado trae la lista
  const k = correr(raiz, A, ['clear', '--discard']);
  assert.strictEqual(k.status, 0, k.stderr);
  const d = volcado(raiz);
  assert.ok(Array.isArray(d.marker.sesiones), `el volcado trae marker.sesiones: ${Object.keys(d.marker).join(', ')}`);
  assert.deepStrictEqual(d.marker.sesiones.map((s) => [s.id, s.nombre]), [[A, 'Carrizo-5']]);
  assert.doesNotMatch(c.stderr + k.stderr, LINEA, 'sin línea de error con el nombre legible');
});

// Un entorno con `pipeline.js start` de verdad, para el restore (como lost-marker.test.js): la HOME, el repo de juguete
// y la historia.
function entornoDeRestore(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sesiones-restore-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.symlinkSync(ARBOL, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(ARBOL, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-restaurada.md');
  fs.writeFileSync(story, ['---', 'story: "9.9"', 'title: "restaurada"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
    '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none',
      TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', TYCON_GUIDES_DIR: ARBOL, CLAUDE_CODE_SESSION_ID: sid });
    return Object.assign(e, extra);
  };
  const run = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo });
  const estado = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  return { home, repo, story, run, estado };
}

test('T5 2.83-Marcador_AdopcionSumaSesionYTope @story-2.83 @ac-3', (t) => {
  // adopt-session: B toma la corrida de A y la lista tiene a las dos
  const raiz = corral(t);
  nombrar(raiz, A, 'Carrizo-4', 4242);
  nombrar(raiz, B, 'Ponzio-5', 4343);
  abrir(raiz, A);
  const r = correr(raiz, B, ['adopt-session', A]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(leer(raiz, B).sesiones.map((s) => [s.id, s.nombre]), [[A, 'Carrizo-4'], [B, 'Ponzio-5']]);

  // restore: la corrida perdida de A (su marcador podado) vuelve en B, con A en la lista
  const E = entornoDeRestore(t);
  fs.writeFileSync(path.join(E.home, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: A, cwd: E.repo, name: 'Carrizo-4', nameSource: 'user' }));
  fs.writeFileSync(path.join(E.home, '.claude', 'sessions', '4343.json'), JSON.stringify({ pid: 4343, sessionId: B, cwd: E.repo, name: 'Ponzio-5', nameSource: 'user' }));
  const s = E.run('pipeline.js', ['start', '--story', E.story, '--repo', E.repo, '--brief'], A);
  assert.strictEqual(s.status, 0, s.stderr + s.stdout);
  const activo = path.join(E.estado, 'active', `${A}.json`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(activo, 'utf8')).sesiones.map((x) => x.nombre), ['Carrizo-4']);
  fs.mkdirSync(path.join(E.estado, 'pruned'), { recursive: true });
  fs.renameSync(activo, path.join(E.estado, 'pruned', `${A}.json`));
  const { conVentana } = require(path.join(ARBOL, 'scripts', 'tests', 'lib', 'window-passed.js'));
  const rs = E.run('marker.js', ['restore', A], B, conVentana({}));
  assert.strictEqual(rs.status, 0, rs.stderr + rs.stdout);
  const mb = JSON.parse(fs.readFileSync(path.join(E.estado, 'active', `${B}.json`), 'utf8'));
  assert.deepStrictEqual(mb.sesiones.map((x) => [x.id, x.nombre]), [[A, 'Carrizo-4'], [B, 'Ponzio-5']]);

  // el tope: con 10 entradas y una sesión nueva, quedan 10 y sale la más vieja
  const raiz2 = corral(t);
  nombrar(raiz2, A, 'Carrizo-4', 4242);
  abrir(raiz2, A);
  const m = leer(raiz2, A);
  m.sesiones = Array.from({ length: 10 }, (_v, i) => ({ id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`, nombre: `Viejo-${i}`, visto: new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString() }));
  fs.writeFileSync(archivo(raiz2, A), JSON.stringify(m, null, 2));
  const c = correr(raiz2, A, ['complete-step', 'validate-story']);
  assert.strictEqual(c.status, 0, c.stderr);
  const lista = leer(raiz2, A).sesiones;
  assert.strictEqual(lista.length, 10);
  assert.ok(!lista.some((x) => x.nombre === 'Viejo-0'), 'salió la de visto más viejo');
  assert.strictEqual(lista[lista.length - 1].nombre, 'Carrizo-4');
});

// Una copia del arnés sin la librería del nombre: los guiones del pipeline y `scripts/`, sin sus pruebas.
function arnesSinLibreria(t) {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'arnes-sin-nombre-'));
  t.after(() => fs.rmSync(destino, { recursive: true, force: true }));
  const sinPruebas = (s) => !/[\\/](?:tests|node_modules)$/.test(s);
  fs.cpSync(SCRIPTS, path.join(destino, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: sinPruebas });
  fs.cpSync(path.join(ARBOL, 'scripts'), path.join(destino, 'scripts'), { recursive: true, filter: sinPruebas });
  fs.rmSync(path.join(destino, 'scripts', 'lib', 'session-name.js'));
  return path.join(destino, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
}

test('T6 2.83-Marcador_SinNombreNoFrena @story-2.83 @ac-6 @ac-7', (t) => {
  // la carpeta de sesiones ilegible: el paso se completa, el nombre ya anotado al abrir no se pierde y sale una sola
  // línea con el código
  const raiz = corral(t);
  nombrar(raiz, A, 'Carrizo-4', 4242);
  abrir(raiz, A);
  const sesiones = path.join(raiz, 'home', '.claude', 'sessions');
  fs.chmodSync(sesiones, 0o000);
  const c = correr(raiz, A, ['complete-step', 'validate-story']);
  fs.chmodSync(sesiones, 0o755);
  assert.strictEqual(c.status, 0, c.stderr);
  const m = leer(raiz, A);
  assert.ok((m.stepsCompleted || []).includes('validate-story'), 'el marcador se escribió');
  if (process.getuid && process.getuid() !== 0) {
    assert.strictEqual(m.sesiones.length, 1);
    assert.strictEqual(m.sesiones[0].nombre, 'Carrizo-4');
    assert.deepStrictEqual([...c.stderr.matchAll(LINEA)].map((x) => x[1]), ['carpeta-ilegible']);
  }

  // sin la librería: el paso se completa, la lista queda como estaba y la línea dice sin-libreria
  const raiz2 = corral(t);
  nombrar(raiz2, A, 'Carrizo-4', 4242);
  abrir(raiz2, A);
  const antes = leer(raiz2, A).sesiones;
  const sin = correr(raiz2, A, ['complete-step', 'validate-story'], { marker: arnesSinLibreria(t) });
  assert.strictEqual(sin.status, 0, sin.stderr);
  const m2 = leer(raiz2, A);
  assert.ok((m2.stepsCompleted || []).includes('validate-story'), 'el marcador se escribió');
  assert.deepStrictEqual(m2.sesiones, antes);
  assert.deepStrictEqual([...sin.stderr.matchAll(LINEA)].map((x) => x[1]), ['sin-libreria']);

  // la verificación antes de la firma no lee ni escribe ningún nombre
  const raiz3 = corral(t);
  nombrar(raiz3, A, 'Carrizo-4', 4242);
  abrir(raiz3, A);
  const previo = leer(raiz3, A).sesiones;
  nombrar(raiz3, A, 'Carrizo-5', 4242);
  const p = correr(raiz3, A, ['complete-step', 'validate-story'], { env: { TYCON_SIGN_PRECHECK: '1' } });
  assert.strictEqual(p.status, 0, p.stderr);
  assert.deepStrictEqual(leer(raiz3, A).sesiones, previo);
  assert.doesNotMatch(p.stderr, LINEA);
  // un comando de sólo lectura tampoco
  const g = correr(raiz3, A, ['get']);
  assert.strictEqual(g.status, 0, g.stderr);
  assert.deepStrictEqual(leer(raiz3, A).sesiones, previo);
});
