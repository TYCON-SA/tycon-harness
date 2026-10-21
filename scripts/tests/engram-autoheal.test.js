#!/usr/bin/env node
/**
 * engram-autoheal.test.js — las TRES guardas que hacen seguro unificar la memoria sin preguntar.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * Unir cajones de memoria es difícil de deshacer: al reetiquetar las observaciones se pierde la
 * etiqueta original, así que no hay forma de volver a separarlas salvo por heurística de texto.
 * Automatizar eso sólo es defendible si lo que se toca NO PUEDE estar bien de otra manera — y eso
 * lo deciden estas tres guardas.
 *
 * No son hipotéticas: la 2 y la 3 cubren datos reales, y sin ellas el automatismo movería memoria
 * ajena en silencio. El caso concreto: una carpeta puede tener cientos de observaciones bajo el nombre de
 * otro producto —alguien trabajó en ese producto desde ahí— y un automatismo ingenuo ("todo lo que
 * aparece en esta carpeta va al cajón de esta carpeta") se las llevaría adentro, sin vuelta atrás.
 *
 * Cada test de abajo es una de esas guardas. Si alguien las relaja, esto se pone en rojo.
 *
 * Correr: node --test scripts/tests/engram-autoheal.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const AUTOHEAL = path.join(RAIZ, 'scripts', 'lib', 'engram-autoheal.js');
const AUDIT = path.join(RAIZ, 'scripts', 'lib', 'harness-audit.js');
const { planificar } = require(AUTOHEAL);

function haySqlite3() {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const SKIP = !haySqlite3() && 'sin sqlite3';

/**
 * Laboratorio: una raíz de repos con sus pins + una base con sesiones y observaciones.
 * @param repos  [{ repo: 'Ceibo/CeiboBackend', pin: 'ceibo' }]
 * @param sesiones [{ dir: '<rel al root>', project: 'x' }]
 * @param obs    { 'x': 12 }  observaciones vivas por project
 */
function laboratorio(repos, sesiones, obs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-'));
  const root = path.join(dir, 'repos');
  for (const r of repos) {
    const d = path.join(root, r.repo);
    fs.mkdirSync(path.join(d, '.engram', 'chunks'), { recursive: true });
    fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, '.engram', 'config.json'), JSON.stringify({ project_name: r.pin }));
    fs.writeFileSync(path.join(d, '.engram', 'chunks', 'aaaaaaaa.jsonl.gz'), 'x');
  }
  const esc = (x) => String(x).replace(/'/g, "''");
  const filas = [
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, directory TEXT NOT NULL);',
    'CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, deleted_at TEXT);',
  ];
  sesiones.forEach((s, i) => filas.push(
    `INSERT INTO sessions VALUES ('s${i}', '${esc(s.project)}', '${esc(path.join(root, s.dir))}');`));
  let oid = 0;
  for (const [p, n] of Object.entries(obs)) {
    for (let k = 0; k < n; k++) filas.push(`INSERT INTO observations VALUES (${++oid}, '${esc(p)}', NULL);`);
  }
  const db = path.join(dir, 'engram.db');
  execFileSync('sqlite3', [db], { input: filas.join('\n') });
  return { dir, root, db };
}

const nombresAuto = (plan) => plan.flatMap((r) => r.auto.map((a) => a.nombre)).sort();
const nombresHumano = (plan) => plan.flatMap((r) => r.humano.map((h) => h.nombre)).sort();

// ── El caso que SÍ se une solo ────────────────────────────────────────────────────────────────

test('basura de autodetección en UNA sola carpeta: se absorbe sin preguntar', { skip: SKIP }, () => {
  const { dir, root, db } = laboratorio(
    [{ repo: 'Ceibo', pin: 'ceibo' }],
    [{ dir: 'Ceibo', project: 'ceibo' }, { dir: 'Ceibo', project: 'ceiboproject' }],
    { ceibo: 100, ceiboproject: 40 });

  const { plan } = planificar({ root, db });
  assert.deepEqual(nombresAuto(plan), ['ceiboproject'],
    'un nombre que sólo existió en esta carpeta y que ningún repo declara es, por construcción, un accidente de la autodetección');
  assert.deepEqual(nombresHumano(plan), []);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Las tres guardas ──────────────────────────────────────────────────────────────────────────

test('GUARDA 1 — un proyecto TRANSVERSAL no se toca ni se reporta', { skip: SKIP }, () => {
  const { dir, root, db } = laboratorio(
    [{ repo: 'Totora', pin: 'totora' }],
    [{ dir: 'Totora', project: 'totora' }, { dir: 'Totora', project: 'tycon' }],
    { totora: 100, tycon: 135 });

  const { plan } = planificar({ root, db });
  assert.deepEqual(nombresAuto(plan), [],
    'guardar el arnés bajo `tycon` desde el cwd de un producto es la CONVENCIÓN (engram-workflow.md §2) — absorberlo sería destruir la memoria del arnés');
  assert.deepEqual(nombresHumano(plan), [], 'y tampoco se molesta al dev con eso: no es un problema');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('GUARDA 2 — el nombre declarado por OTRO repo nunca se absorbe', { skip: SKIP }, () => {
  // El caso: observaciones de un producto del equipo guardadas desde la carpeta de otro.
  const { dir, root, db } = laboratorio(
    [{ repo: 'Totora', pin: 'totora' }, { repo: 'Pacara/BackEnd', pin: 'nimbobackend' }],
    [{ dir: 'Totora', project: 'totora' }, { dir: 'Totora', project: 'nimbobackend' }],
    { totora: 330, nimbobackend: 359 });

  const { plan } = planificar({ root, db });
  assert.deepEqual(nombresAuto(plan), [],
    '🔴 sin esta guarda el automatismo se llevaba 359 observaciones de Pacara adentro de Totora, en silencio y sin vuelta atrás');
  assert.deepEqual(nombresHumano(plan), ['nimbobackend'], 'se reporta para que lo mire una persona');
  const motivo = plan.flatMap((r) => r.humano).find((h) => h.nombre === 'nimbobackend').motivo;
  assert.match(motivo, /otro repo/, 'el motivo tiene que explicar POR QUÉ no se tocó');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('GUARDA 3 — un nombre usado desde VARIAS carpetas es un proyecto propio', { skip: SKIP }, () => {
  // `backend` lo genera la autodetección IGUAL en Totora/Backend y en Pacara/BackEnd: mismo
  // basename, dos productos. Absorberlo en cualquiera de los dos mezcla los dos.
  const { dir, root, db } = laboratorio(
    [{ repo: 'Totora/Backend', pin: 'totora' }, { repo: 'Pacara/BackEnd', pin: 'nimbobackend' }],
    [{ dir: 'Totora/Backend', project: 'totora' },
     { dir: 'Totora/Backend', project: 'backend' },
     { dir: 'Pacara/BackEnd', project: 'backend' }],
    { totora: 330, nimbobackend: 359, backend: 9 });

  const { plan } = planificar({ root, db });
  assert.deepEqual(nombresAuto(plan), [],
    'el mismo nombre en dos carpetas de productos distintos no puede absorberse en ninguno de los dos');
  assert.ok(nombresHumano(plan).includes('backend'));
  assert.match(plan.flatMap((r) => r.humano).find((h) => h.nombre === 'backend').motivo, /carpetas distintas/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('una carpeta de OTRA máquina no cuenta para la guarda 3', { skip: SKIP }, () => {
  // 🔴 La tabla de sesiones VIAJA en los chunks, así que trae las rutas de los demás devs. Medido
  // en una máquina real: 680 directorios que no existen en ese disco, incluido el de otro dev con
  // el mismo repo. Si esas rutas contaran, la guarda 3 vería "usado desde 2 carpetas" para
  // CUALQUIER proyecto que otro compañero también tenga — y el arreglo automático no se dispararía
  // NUNCA, en ninguna máquina, cada una bloqueada por las carpetas de las otras. La guarda hace una
  // pregunta local y se responde con evidencia local.
  const { dir, root, db } = laboratorio(
    [{ repo: 'FRESNO/FRESNOBZExtBackend', pin: 'fresnobzextbackend' }],
    [{ dir: 'FRESNO/FRESNOBZExtBackend', project: 'fresnobzextbackend' },
     { dir: 'FRESNO/FRESNOBZExtBackend', project: 'proyectoviejo' }],
    { fresnobzextbackend: 80, proyectoviejo: 12 });

  // Se agrega a mano una sesión con una ruta que NO existe en este disco (la del otro dev).
  execFileSync('sqlite3', [db], {
    input: `INSERT INTO sessions VALUES ('ajena','proyectoviejo','/Users/otrodev/Proyectos/FRESNO/FRESNOBZExtBackend');`,
  });

  const { plan } = planificar({ root, db });
  assert.deepEqual(nombresAuto(plan), ['proyectoviejo'],
    'la ruta ajena no puede bloquear la unificación en ESTA máquina — si lo hiciera, el autoheal sería inerte para todo el equipo');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Bordes ────────────────────────────────────────────────────────────────────────────────────

test('un cajón VACÍO no se reporta ni se une (no hay nada que mover)', { skip: SKIP }, () => {
  const { dir, root, db } = laboratorio(
    [{ repo: 'Ceibo', pin: 'ceibo' }],
    [{ dir: 'Ceibo', project: 'ceibo' }, { dir: 'Ceibo', project: 'restoviejo' }],
    { ceibo: 100 });   // 'restoviejo' sin observaciones

  const { plan } = planificar({ root, db });
  assert.deepEqual(nombresAuto(plan), []);
  assert.deepEqual(nombresHumano(plan), [], 'un cajón vacío es ruido, no un hallazgo');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('sin base no inventa un plan (fail-open, con motivo)', () => {
  const r = planificar({ root: '/tmp', db: path.join(os.tmpdir(), 'no-existe-' + process.pid + '.db') });
  assert.deepEqual(r.plan, []);
  assert.ok(r.motivo, 'tiene que DECIR por qué no hay plan — un plan vacío sin motivo se lee como "está todo bien"');
});

test('el CLI corre y no rompe; como require no ejecuta nada', () => {
  const script = AUTOHEAL;
  const salida = execFileSync('node', [script], { encoding: 'utf8' });
  assert.ok(salida.length >= 0);
  const callado = execFileSync('node', ['-e', `require(${JSON.stringify(script)})`], { encoding: 'utf8' });
  assert.equal(callado.trim(), '', 'el guard require.main es lo que permite testear las guardas sin disparar el CLI');
});

// ── T23 · R3_Lib_MovedRequires ─────────────────────────────────────────────────────────
// El autoarreglo y la auditoría viven en scripts/lib/. Un `require` que apunta a una carpeta que ya no tiene la función no rompe al
// cargar: rompe cuando se llega a esa función, y la auditoría lo traga como una categoría en rojo que se lee como «el
// arnés anda mal» y no como «la auditoría no encuentra sus piezas». Por eso el caso no se conforma con que compile: cada
// ruta relativa escrita existe, la auditoría con `--json` corre y mira las guías y las herramientas del clon (no de
// scripts/), y `--parity` encuentra su vecino. En la ruta de siempre de cada uno queda el reemplazo generado; esa ruta
// sale del mapa, y la copia pública, que no lo lleva, lo dice.

/** Las rutas relativas escritas en `file`: `require('./x')`, `require('../x')` y `path.join|resolve(__dirname, 'a', …)`. */
function relativePaths(file) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const out = [];
  for (const m of src.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) out.push({ spec: m[2], abs: path.resolve(dir, m[2]) });
  for (const m of src.matchAll(/path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]+\2)+)\s*\)/g)) {
    const parts = [...m[1].matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2]);
    out.push({ spec: `__dirname, ${parts.join(', ')}`, abs: path.resolve(dir, ...parts) });
  }
  return out;
}
const existe = (abs) => { try { require.resolve(abs); return true; } catch { return fs.existsSync(abs); } };
// Sólo la copia pública —que no lleva el mapa— se saltea. Con el mapa presente, ilegible o sin la entrada es un rojo
// (leer «sin entrada» como «copia pública» dejaría pasar en verde un reemplazo que falta).
const MAP_PATH = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const HAS_MAP = fs.existsSync(MAP_PATH);
/** HOME de mentira: la auditoría lee ~/.claude y el reemplazo anota su uso ahí; una prueba no toca el de la máquina. */
function homeDeMentira() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-home-'));
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{ "mcpServers": {} }\n');
  fs.writeFileSync(path.join(h, '.claude', 'CLAUDE.md'), 'x\n');
  return h;
}
const envCon = (home) => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'TF_BUILD') e[k] = v;
  // TYCON_PARITY_BENCH_DIR: `--parity` deja su reporte en scripts/controls-bench/.bench/ del clon, que comparten las demás suites
  return { ...e, HOME: home, TYCON_NO_NIGHTLY_EXAM: '1', TYCON_REPOS_ROOT: path.join(home, 'repos'), TYCON_PARITY_BENCH_DIR: path.join(home, 'parity-bench') };
};

test('T23 R3_Lib_MovedRequires — autoarreglo y auditoría compilan desde scripts/lib/ y cada ruta relativa existe', () => {
  for (const f of [AUTOHEAL, AUDIT]) {
    const chk = require('child_process').spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.strictEqual(chk.status, 0, `${path.basename(f)} compila desde scripts/lib/ (${chk.stderr})`);
    const muertas = relativePaths(f).filter((r) => !existe(r.abs)).map((r) => r.spec);
    assert.deepStrictEqual(muertas, [], `${path.basename(f)}: toda ruta relativa resuelve desde scripts/lib/`);
    assert.ok(!/require\(\s*(?:['"]\.\/lib\/|path\.join\(\s*__dirname\s*,\s*['"]lib['"])/.test(fs.readFileSync(f, 'utf8')),
      `${path.basename(f)}: sus vecinos de lib/ se piden sin \`lib/\` adelante`);
  }
  assert.ok(relativePaths(AUDIT).length >= 6, 'la auditoría escribe sus vecinos (paridad, raíz de repos, paquetes, engram, configuración, presupuesto)');
});

test('T23 R3_Lib_MovedRequires — harness-audit --json corre desde scripts/lib/ y mira las guías y herramientas del clon', () => {
  const home = homeDeMentira();
  try {
    const r = require('child_process').spawnSync(process.execPath, [AUDIT, '--json'], { encoding: 'utf8', env: envCon(home), cwd: RAIZ });
    assert.ok(!/Cannot find module/.test(r.stderr), `ningún require roto (${r.stderr.slice(0, 400)})`);
    const d = JSON.parse(r.stdout);
    const checks = d.categories.flatMap((c) => c.checks.map((k) => ({ ...k, cat: c.name })));
    const dod = checks.find((k) => k.name === 'Definition of Done guide existe');
    assert.ok(dod, 'la auditoría trae el chequeo de la guía de DoD');
    assert.strictEqual(dod.file, path.join(RAIZ, 'guides', 'definition-of-done.md'), 'TCG_ROOT es el clon, no scripts/');
    assert.strictEqual(dod.passed, true, 'y la encuentra');
    const catalogo = checks.filter((k) => k.cat === 'Catalog Integrity').map((k) => k.file);
    assert.ok(catalogo.length && catalogo.every((f) => [path.join(RAIZ, 'guides', 'advisor-rules-catalog.md'), path.join(RAIZ, 'scripts', 'tools', 'rules-distill.js')].includes(f)),
      `Catalog Integrity apunta al catálogo y a scripts/tools/rules-distill.js (${catalogo.join(' · ')})`);
    const cadena = checks.find((k) => k.name.startsWith('Cadena del CLAUDE.md'));
    assert.ok(cadena && !/NO se pudo medir/.test(cadena.name), `importa scripts/tools/context-budget.js (${cadena && cadena.name})`);
    const par = require('child_process').spawnSync(process.execPath, [AUDIT, '--parity', '--json'], { encoding: 'utf8', env: envCon(home), cwd: RAIZ });
    assert.ok(!/Cannot find module/.test(par.stderr), `--parity encuentra harness-parity.js (${par.stderr.slice(0, 400)})`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('T23 R3_Lib_MovedRequires — en la ruta de siempre de los dos queda el reemplazo generado que lanza el de lib/',
  { skip: !HAS_MAP && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    const L = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
    const R3_MAP = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).entries.filter((e) => e && e.batch === 'R3');
    for (const nuevo of [AUTOHEAL, AUDIT]) {
      const e = R3_MAP.find((x) => path.join(RAIZ, x.new) === nuevo);
      assert.ok(e, `el mapa no tiene la entrada de scripts/lib/${path.basename(nuevo)}`);
      const viejo = path.join(RAIZ, e.old);
      assert.ok(fs.existsSync(viejo) && L.isGeneratedShim(e.old, fs.readFileSync(viejo, 'utf8')), `${e.old} es el reemplazo generado, tal cual`);
      assert.strictEqual(path.resolve(L.shimTarget(viejo)), nuevo, `${e.old} lanza el de scripts/lib/`);
    }
    // por la ruta de siempre, el autoarreglo dice lo mismo que por la nueva (lo llaman los hooks de otras máquinas)
    const home = homeDeMentira();
    try {
      const viejo = path.join(RAIZ, R3_MAP.find((x) => path.join(RAIZ, x.new) === AUTOHEAL).old);
      const a = require('child_process').spawnSync(process.execPath, [AUTOHEAL, '--json'], { encoding: 'utf8', env: envCon(home) });
      const b = require('child_process').spawnSync(process.execPath, [viejo, '--json'], { encoding: 'utf8', env: envCon(home) });
      assert.deepStrictEqual([b.status, b.stdout], [a.status, a.stdout], 'misma salida y código por las dos rutas');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
