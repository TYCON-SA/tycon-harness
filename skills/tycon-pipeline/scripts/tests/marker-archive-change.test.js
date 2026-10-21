#!/usr/bin/env node
'use strict';
/**
 * marker-archive-change.test.js — T11 y T12.
 *
 * QUÉ CUIDA: que el archivador del cierre (`marker.js clear`) guarde AL LADO del volcado el cambio real
 * de la corrida según git (`<volcado>.cambio.json.gz`, lo arma `scripts/metrics/run-change.js` de
 * el arnés) y anote en el volcado sólo el resumen — sin poder caerse por eso.
 *
 * 🔴 Mismo contrato que el rescate (`marker-archive-rescue.test.js`): el guion vive en OTRO
 *    repo, que se actualiza por otro camino. Una máquina con el arnés atrasado tiene este marker.js y no
 *    el guion: el volcado se escribe igual, con el motivo adentro. T12 lo prueba en sus cuatro formas.
 *
 * T11 usa el guion REAL: `TYCON_GUIDES_DIR`, `~/SourceCode/tycon-claude-guides` o el checkout del nocturno
 * (`BUILD_SOURCESDIRECTORY`). Si no está, el caso lo DICE y falla (no se da por bueno un archivador que no se
 * pudo probar).
 *
 * T13–T16: con qué NOMBRES de opción llama el cierre a los dos guiones del
 * arnés (`run-change.js` y `tokens-digest.js`). Tienen que ser los actuales y no los de antes del renombre; en el repo del equipo los
 * traduce el mapa de renombres, y la copia pública no trae ese mapa: con los viejos el guion sale 2 y cada cierre anota «no medido».
 *
 * Correr: TYCON_GUIDES_DIR=<clon del arnés> node --test <este archivo>
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync, execFileSync } = require('child_process');

const MARKER = path.join(__dirname, '..', 'marker.js');
// El guion con su nombre actual y con el anterior al renombre, armado por partes: un arnés
// atrasado sólo tiene el viejo, y el marker lo usa si falta el nuevo.
const GUION = 'run-change.js';
const GUION_VIEJO = `${['cambio', 'de', 'corrida'].join('-')}.js`;
// El guion real: la variable, el árbol de esta misma prueba, la carpeta actual, el arnés instalado o el checkout del
// nocturno de Azure (BUILD_SOURCESDIRECTORY es el arnés en el job de suites). El primero que lo tenga. La carpeta
// vieja del clon (~/SourceCode/tycon-claude-guides) no es candidata: no existe desde el renombre, y en una Mac sin
// la variable T11 saldría rojo con «no está el guion real».
const ARBOL = path.resolve(__dirname, '..', '..', '..', '..');
const GUIAS_REALES = [process.env.TYCON_GUIDES_DIR, ARBOL, process.cwd(), path.join(os.homedir(), '.tycon', 'harness'), process.env.BUILD_SOURCESDIRECTORY]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'scripts', 'metrics', GUION)))
  || process.env.TYCON_GUIDES_DIR || ARBOL;

function corral() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cambio-'));
  fs.mkdirSync(path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'guides', 'scripts', 'metrics'), { recursive: true });
  // el arnés de mentira tiene que PARECER un clon (criterio de lib/harness-path.js: scripts/install-tycon-hooks.sh);
  // si no, el marker avisa por stderr «no es un clon del arnés» y estos casos, que miden otra cosa, se ensucian
  fs.writeFileSync(path.join(raiz, 'guides', 'scripts', 'install-tycon-hooks.sh'), '#!/usr/bin/env bash\n');
  return raiz;
}

function git(dir, args, extra) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'P', GIT_AUTHOR_EMAIL: 'p@ejemplo.invalid', GIT_COMMITTER_NAME: 'P', GIT_COMMITTER_EMAIL: 'p@ejemplo.invalid', ...(extra || {}) },
  });
}

/** Repo con un commit inicial fechado ANTES de la corrida. */
function repo(raiz) {
  const r = path.join(raiz, 'repo');
  fs.mkdirSync(r, { recursive: true });
  git(r, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(r, 'a.js'), 'uno\n');
  git(r, ['add', '-A']);
  git(r, ['commit', '-qm', 'inicial'], { GIT_COMMITTER_DATE: '2026-01-01T10:00:00', GIT_AUTHOR_DATE: '2026-01-01T10:00:00' });
  return r;
}

function correrMarker(args, raiz, guias, extra) {
  return spawnSync(process.execPath, [MARKER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(raiz, 'home'),
      CLAUDE_CODE_SESSION_ID: 'sesion-cambio',
      TYCON_GUIDES_DIR: guias,
      TYCON_PROJECTS_DIR: path.join(raiz, 'projects'),
      TYCON_NO_THREAD_RESCUE: '1',
      TYCON_LANE_LLM: '0',
      ...(extra || {}),
    },
  });
}

function marcarCorrida(raiz, repoPath) {
  const r = correrMarker(['set', JSON.stringify({
    storyId: '2.19-prueba', storyPath: path.join(repoPath, 'story.md'), repoPath, sessionId: 'sesion-cambio', stepsPending: [],
  })], raiz, path.join(raiz, 'guides'));
  assert.strictEqual(r.status, 0, `marker set falló: ${r.stderr}`);
}

function volcados(raiz) {
  const d = path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'timing-history');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f));
}

// ── T11 · el archivador deja el cambio al lado y el resumen adentro, sin parches ──────────────────
// rojo si: marker.js no llama al guion → no hay .cambio.json.gz ni `cambio` en el volcado.
test('T11 · marker.js clear deja <volcado>.cambio.json.gz y anota sólo el resumen', () => {
  const guion = path.join(GUIAS_REALES, 'scripts', 'metrics', GUION);
  assert.ok(fs.existsSync(guion), `no está el guion real en ${guion}: este caso no se puede probar en esta máquina (TYCON_GUIDES_DIR)`);
  const raiz = corral();
  const r = repo(raiz);
  marcarCorrida(raiz, r);
  fs.writeFileSync(path.join(r, 'a.js'), 'uno\nPARCHE_SEMBRADO_COMMIT\n');
  git(r, ['commit', '-qam', 'feat: la corrida']);
  fs.writeFileSync(path.join(r, 'b.js'), 'PARCHE_SEMBRADO_SIN_COMMITEAR\n');

  const c = correrMarker(['clear'], raiz, GUIAS_REALES);
  assert.strictEqual(c.status, 0, `el clear no debe fallar: ${c.stderr}`);
  const vs = volcados(raiz);
  assert.strictEqual(vs.length, 1, 'el volcado existe');
  const cambio = vs[0].replace(/\.json$/, '.cambio.json.gz');
  assert.ok(fs.existsSync(cambio), 'el cambio queda AL LADO del volcado, con su mismo nombre');
  const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(cambio)).toString('utf8'));
  assert.strictEqual(x.estado, 'medido');
  const d = JSON.parse(fs.readFileSync(vs[0], 'utf8'));
  assert.deepStrictEqual(Object.keys(d.cambio).sort(), ['archivos', 'estado', 'motivo', 'repos']);
  assert.strictEqual(d.cambio.estado, 'medido');
  assert.strictEqual(d.cambio.archivos, 2, 'a.js commiteado y b.js sin commitear');
  const crudo = fs.readFileSync(vs[0], 'utf8');
  assert.ok(!crudo.includes('PARCHE_SEMBRADO'), 'el volcado NO lleva parches');
  const runs = path.join(r, '.advisors', 'pipeline-runs');
  const copias = fs.existsSync(runs) ? fs.readdirSync(runs).filter((f) => f.startsWith('timing-dump-')) : [];
  assert.strictEqual(copias.length, 1, 'la copia del repo existe');
  const copia = fs.readFileSync(path.join(runs, copias[0]), 'utf8');
  assert.ok(!copia.includes('PARCHE_SEMBRADO'), 'la copia que viaja con el repo NO lleva parches');
  assert.strictEqual(JSON.parse(copia).cambio.estado, 'medido', 'y lleva el mismo resumen');
  fs.rmSync(raiz, { recursive: true, force: true });
});

// ── T12 · arnés atrasado, roto, lento o apagado: se archiva igual ────────────────────────────────
// rojo si: sin la integración no hay `cambio` en el volcado. Mutaciones: propagar el error del guion,
// no poner timeout (el caso lento colgaría el cierre), o ignorar la variable de apagado → rojo.
const CASOS = [
  { nombre: 'guion ausente', guion: null, env: {}, motivo: /run-change|no encontré|atrasado/i },
  { nombre: 'guion que sale 9', guion: 'process.stderr.write("me rompí\\n"); process.exit(9);', env: {}, motivo: /falló|9/i },
  // un arnés atrasado sólo tiene el nombre viejo, y se usa (sale 9: se ve que lo llamó)
  { nombre: 'sólo el nombre viejo (arnés atrasado)', nombreDelGuion: GUION_VIEJO, guion: 'process.exit(9);', env: {}, motivo: /falló|9/i },
  // y con los dos, el nuevo: el viejo es el reemplazo, que en Azure avisa «nombre viejo» en cada corrida
  { nombre: 'los dos nombres: corre el nuevo', guion: 'process.exit(7);', otro: { nombre: GUION_VIEJO, guion: 'process.exit(9);' }, env: {}, motivo: /7/ },
  { nombre: 'guion más lento que el tope', guion: 'setTimeout(() => {}, 20000);', env: { TYCON_RUN_CHANGE_TIMEOUT_MS: '1500' }, motivo: /tard|tiempo|ETIMEDOUT/i },
  { nombre: 'apagado', guion: 'require("fs").writeFileSync(process.argv[process.argv.indexOf("--dump")+1].replace(/\\.json$/, ".cambio.json.gz"), "x"); console.log("{}");', env: { TYCON_NO_RUN_CHANGE: '1' }, motivo: /TYCON_NO_RUN_CHANGE/ },
];
for (const caso of CASOS) {
  test(`T12 · ${caso.nombre}: el volcado se archiva con cambio.estado no_medido y su motivo`, () => {
    const raiz = corral();
    const r = repo(raiz);
    if (caso.guion) fs.writeFileSync(path.join(raiz, 'guides', 'scripts', 'metrics', caso.nombreDelGuion || GUION), caso.guion);
    if (caso.otro) fs.writeFileSync(path.join(raiz, 'guides', 'scripts', 'metrics', caso.otro.nombre), caso.otro.guion);
    marcarCorrida(raiz, r);
    const t0 = Date.now();
    const c = correrMarker(['clear'], raiz, path.join(raiz, 'guides'), caso.env);
    assert.strictEqual(c.status, 0, `el clear no debe fallar: ${c.stderr}`);
    assert.ok(Date.now() - t0 < 15000, 'el cierre no se cuelga esperando al guion');
    const vs = volcados(raiz);
    assert.strictEqual(vs.length, 1, 'el volcado TIENE que existir');
    const d = JSON.parse(fs.readFileSync(vs[0], 'utf8'));
    assert.ok(d.marker && d.marker.storyId === '2.19-prueba', 'conserva el marker');
    assert.ok(d.cambio, 'declara qué pasó con el cambio');
    assert.strictEqual(d.cambio.estado, 'no_medido');
    assert.match(String(d.cambio.motivo || ''), caso.motivo);
    if (caso.env.TYCON_NO_RUN_CHANGE) {
      assert.ok(!fs.existsSync(vs[0].replace(/\.json$/, '.cambio.json.gz')), 'apagado: ni siquiera se llama al guion');
    }
    fs.rmSync(raiz, { recursive: true, force: true });
  });
}

// ── T13–T16 · los nombres de las opciones con las que el cierre llama al arnés ──────────────────────
// El cierre llama a `run-change.js` y a `tokens-digest.js` con los nombres de opción actuales. Con los de ANTES del renombre,
// el repo del equipo andaría igual (el mapa de renombres los traduce) pero la copia pública no trae el mapa: el guion saldría 2 y el cierre
// no guardaría qué cambió la corrida ni rescataría el hilo y el consumo. Por eso van los nombres actuales y,
// si el guion sale 2 (su código de «argumentos inválidos»), UNA vuelta más con los de antes: un arnés atrasado, que
// sólo entiende los viejos, sigue andando. Los viejos se arman por partes: no son nombres a usar.
// Los casos del rescate (T15, T16) viven acá y no en marker-archive-rescue.test.js: esta suite sí corre en la CI.
// rojo si el cierre usa los nombres viejos: T13 y T15 reciben la opción vieja en la primera llamada; T14 y T16 nunca ven la segunda.
const OLD_OPTION = {
  dump: `--${['vol', 'cado'].join('')}`,
  state: `--${['es', 'tado'].join('')}`,
  run: `--${['co', 'rrida'].join('')}`,
};

/** Un guion de mentira que anota cada llamada (sus argumentos) en `calls.jsonl`, a su lado, y —como los de verdad—
 *  sale 2 si no le llega la opción que conoce. `body` es lo que hace cuando sí le llega (`value` = el valor de esa opción). */
function fakeScript(known, body) {
  return [
    "const fs = require('fs'); const path = require('path');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');",
    `const i = args.indexOf(${JSON.stringify(known)});`,
    "if (i < 0) { process.stderr.write('uso: no conozco esa opción\\n'); process.exit(2); }",
    'const value = args[i + 1];',
    body,
    '',
  ].join('\n');
}
function callsOf(raiz) {
  const p = path.join(raiz, 'guides', 'scripts', 'metrics', 'calls.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
/** Un cierre completo contra un arnés de mentira con UN guion; devuelve el volcado, su ruta y las llamadas que recibió. */
function closeWith(script, text, env) {
  const raiz = corral();
  const r = repo(raiz);
  fs.writeFileSync(path.join(raiz, 'guides', 'scripts', 'metrics', script), text);
  marcarCorrida(raiz, r);
  const c = correrMarker(['clear'], raiz, path.join(raiz, 'guides'), env);
  assert.strictEqual(c.status, 0, `el clear no debe fallar: ${c.stderr}`);
  const vs = volcados(raiz);
  assert.strictEqual(vs.length, 1, 'el volcado TIENE que existir');
  const out = { raiz, file: vs[0], dump: JSON.parse(fs.readFileSync(vs[0], 'utf8')), calls: callsOf(raiz) };
  fs.rmSync(raiz, { recursive: true, force: true });
  return out;
}

const CHANGE_SUMMARY = "console.log(JSON.stringify({ estado: 'medido', repos: 1, archivos: 3, motivo: null }));";
// sólo el cambio de git: el rescate del hilo queda apagado (el default de `correrMarker`)
const ONLY_CHANGE = {};
// sólo el rescate del hilo: se prende (el corral lo apaga) y se apaga el cambio de git
const ONLY_RESCUE = { TYCON_NO_THREAD_RESCUE: '0', TYCON_NO_RUN_CHANGE: '1' };
const RESCUE_WRITES = [
  "const d = JSON.parse(fs.readFileSync(value, 'utf8'));",
  "d.consumo = { estado: 'medido', respuestas: 42, tokens: { in: 1, out: 2, cache_new: 0, cache_read: 0 } };",
  'fs.writeFileSync(value, JSON.stringify(d, null, 2));',
].join('\n');

test('T13 MarkerClear_RunChange_CurrentHarnessGetsNewOptions — al guion de hoy le llegan --dump y --state, una sola vez', () => {
  const x = closeWith(GUION, fakeScript('--dump', CHANGE_SUMMARY), ONLY_CHANGE);
  assert.strictEqual(x.calls.length, 1, `una sola llamada: ${JSON.stringify(x.calls)}`);
  assert.deepStrictEqual(x.calls[0], ['--dump', x.file, '--state', path.join(x.raiz, 'home', '.claude', '.tycon-pipeline')]);
  assert.strictEqual(x.dump.cambio.estado, 'medido', `motivo: ${x.dump.cambio.motivo}`);
  assert.strictEqual(x.dump.cambio.archivos, 3);
});

test('T14 MarkerClear_RunChange_OldHarnessRetriedOnceWithOldOptions — el que sólo entiende los nombres viejos sale 2 y recibe UNA vuelta más con ésos', () => {
  const body = `if (args.indexOf(${JSON.stringify(OLD_OPTION.state)}) < 0) process.exit(9);\n${CHANGE_SUMMARY}`;
  const x = closeWith(GUION_VIEJO, fakeScript(OLD_OPTION.dump, body), ONLY_CHANGE);
  assert.strictEqual(x.calls.length, 2, `primero los de hoy, después los de antes: ${JSON.stringify(x.calls)}`);
  assert.strictEqual(x.calls[0][0], '--dump', 'la primera llamada va con los nombres de hoy');
  assert.deepStrictEqual(x.calls[1], [OLD_OPTION.dump, x.file, OLD_OPTION.state, path.join(x.raiz, 'home', '.claude', '.tycon-pipeline')]);
  assert.strictEqual(x.dump.cambio.estado, 'medido', `un arnés atrasado sigue midiendo — motivo: ${x.dump.cambio.motivo}`);
  assert.strictEqual(x.dump.cambio.archivos, 3);
});

test('T14b MarkerClear_RunChange_RetryIsBounded — sale 2 de las dos formas: dos llamadas y no_medido; sale otro código: una sola', () => {
  const always2 = closeWith(GUION, fakeScript('--no-such-option', ''), ONLY_CHANGE);
  assert.strictEqual(always2.calls.length, 2, 'una vuelta más, no un bucle');
  assert.strictEqual(always2.dump.cambio.estado, 'no_medido');
  assert.match(String(always2.dump.cambio.motivo), /salió 2/);
  const exit9 = closeWith(GUION, fakeScript('--dump', 'process.exit(9);'), ONLY_CHANGE);
  assert.strictEqual(exit9.calls.length, 1, 'un guion que se rompe (no es «argumentos inválidos») no se repite');
  assert.strictEqual(exit9.dump.cambio.estado, 'no_medido');
  assert.match(String(exit9.dump.cambio.motivo), /9/);
});

test('T15 MarkerClear_ThreadRescue_CurrentHarnessGetsRun — al rescate de hoy le llega --run, una sola vez, y lo que escribe queda', () => {
  const x = closeWith('tokens-digest.js', fakeScript('--run', RESCUE_WRITES), ONLY_RESCUE);
  assert.strictEqual(x.calls.length, 1, `una sola llamada: ${JSON.stringify(x.calls)}`);
  assert.deepStrictEqual(x.calls[0].slice(0, 2), ['--run', x.file]);
  assert.ok(x.calls[0].includes('--projects-dir'), 'y la carpeta de conversaciones, como siempre');
  assert.strictEqual(x.dump.consumo.estado, 'medido', `motivo: ${x.dump.consumo.motivo}`);
  assert.strictEqual(x.dump.consumo.respuestas, 42);
});

test('T16 MarkerClear_ThreadRescue_OldHarnessRetriedOnceWithOldOption — el que sólo entiende el nombre viejo recibe UNA vuelta más con ése', () => {
  const x = closeWith('tokens-digest.js', fakeScript(OLD_OPTION.run, RESCUE_WRITES), ONLY_RESCUE);
  assert.strictEqual(x.calls.length, 2, `primero el de hoy, después el de antes: ${JSON.stringify(x.calls)}`);
  assert.strictEqual(x.calls[0][0], '--run', 'la primera llamada va con el nombre de hoy');
  assert.deepStrictEqual(x.calls[1].slice(0, 2), [OLD_OPTION.run, x.file]);
  assert.strictEqual(x.dump.consumo.estado, 'medido', `un arnés atrasado sigue rescatando — motivo: ${x.dump.consumo.motivo}`);
  assert.strictEqual(x.dump.consumo.respuestas, 42);
});

test('T16b MarkerClear_ThreadRescue_RetryIsBounded — sale 2 de las dos formas: dos llamadas y no_medido; sale otro código: una sola', () => {
  const always2 = closeWith('tokens-digest.js', fakeScript('--no-such-option', ''), ONLY_RESCUE);
  assert.strictEqual(always2.calls.length, 2, 'una vuelta más, no un bucle');
  assert.strictEqual(always2.dump.consumo.estado, 'no_medido');
  assert.ok(String(always2.dump.consumo.motivo || '').length > 10, 'con el motivo escrito');
  const exit9 = closeWith('tokens-digest.js', fakeScript('--run', 'process.exit(9);'), ONLY_RESCUE);
  assert.strictEqual(exit9.calls.length, 1, 'un rescate que se rompe no se repite');
  assert.strictEqual(exit9.dump.consumo.estado, 'no_medido');
});
