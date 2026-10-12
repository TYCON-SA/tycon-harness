#!/usr/bin/env node
/**
 * large-output.test.js — el contrato de `pipeline.js advisors` y `smart-reloop`:
 * **emiten su JSON por stdout Y salen 0**, sin texto de uso pegado abajo.
 *
 * 🔴 POR QUÉ EXISTE (regresión b3b3147, cazada el 2026-09-10 en la story 2.15 del arnés):
 * al arreglar el truncado de salidas grandes se cambió `process.exit()` por
 * `process.stdout.write(texto, () => process.exit(code))`. El callback de `write` es
 * ASÍNCRONO: `salidaGrande` retornaba en el acto, el despachador seguía de largo, no
 * matcheaba ningún otro comando y caía al texto de uso con `exit(1)` — que le ganaba la
 * carrera al callback. Resultado: JSON correcto, uso pegado abajo, salida 1.
 *
 * Nadie lo vio durante un día entero porque el orquestador parsea stdout e ignora el
 * código de salida. Lo delató `smart-reloop-blindness.test.js` (rojo → gate del arnés
 * 79/80, y de ahí un `set-check tests green --manual` en cada corrida). Este archivo
 * agrega lo que aquél no cubría: el mismo contrato para `advisors`, y la ausencia del
 * texto de uso en la salida — sin eso, un `return` de más volvería a colar el uso con
 * exit 0 y los asserts de código pasarían igual.
 *
 * Las dos mitades del arreglo tienen su caso: (1) el código de salida es 0; (2) el JSON
 * es el ÚNICO contenido de stdout.
 *
 * Correr: node --test tests/large-output.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Story 8.7 (AC 8): un repo sin `packs:` activa los paquetes que diga `packs.default` (afuera, sin perfil: ninguno).
// Esta suite corre el pipeline con una HOME aislada y cuenta con «todos los instalados», como desde la 8.2: lo declara.
process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';   // recortada, como el cargador
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const SID = 'sesion-salida-grande';

/** Repo git mínimo con una story Mary+GOLD legible y un archivo de código. */
function mkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'salida-grande-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), '// código\n');
  fs.writeFileSync(path.join(repo, 'story.md'), [
    '---', 'epic: 9', 'story: "9.9"', 'title: "Salida"', 'status: in-progress',
    'files_to_modify:', '  - src/app.js', '---', '',
    '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** otra cosa.', '',
    '### Tests (1 verificaciones)', '',
    '| # | Test | AC | Nivel | Escenario | Resultado esperado |',
    '|---|---|---|---|---|---|',
    '| T1 | `Algo_Funciona` | 1 | unit | x | y |', '',
  ].join('\n'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'test');
  git('add', '.');
  git('commit', '-qm', 'base');
  return repo;
}

/** HOME temporal con el marker de "esta sesión" — lo necesita smart-reloop para el snapshot. */
function mkHome(repo) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salida-grande-home-'));
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify({
    storyId: '9.9',
    storyPath: path.join(repo, 'story.md'),
    repoPath: repo,
    filesTouched: [path.join(repo, 'src', 'app.js')],
    iterations: { 1: { ts: new Date(Date.now() - 60000).toISOString(), filesSnapshot: [] } },
  }, null, 2));
  return home;
}

function correr(args, home) {
  return spawnSync(process.execPath, [PIPELINE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0' },
  });
}

for (const modo of ['advisors', 'smart-reloop']) {
  test(`${modo}: emite JSON y sale 0 (no se derrama al texto de uso)`, () => {
    const repo = mkRepo();
    const home = mkHome(repo);
    const base = [modo, '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', 'src/app.js'];
    const args = modo === 'smart-reloop' ? [...base, '--iter', '2'] : base;
    const r = correr(args, home);

    assert.equal(r.status, 0,
      `${modo} salió ${r.status}: el flujo se derramó al final del despachador ` +
      `(salidaGrande retorna antes de que corra su callback). stderr: ${String(r.stderr).slice(0, 300)}`);

    // (1) el JSON es parseable de punta a punta…
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
      `${modo}: stdout no es un JSON entero — ¿quedó el texto de uso pegado abajo? ` +
      `cola: ${String(r.stdout).slice(-200)}`);
    assert.ok(parsed && typeof parsed === 'object', `${modo}: el JSON no es un objeto`);

    // (2) …y NADA más salió por stdout. Sin este assert, un `return` de más devolvería
    // el uso con exit 0 y el chequeo del código de salida pasaría igual.
    assert.ok(!/pipeline\.js \(H17/.test(r.stdout),
      `${modo}: el texto de uso salió por stdout junto con el JSON`);
  });
}

test('el JSON del set incluye lo que el orquestador consume (no es un objeto vacío)', () => {
  const repo = mkRepo();
  const home = mkHome(repo);
  const r = correr(['advisors', '--repo', repo, '--story', path.join(repo, 'story.md'), '--files', 'src/app.js'], home);
  const set = JSON.parse(r.stdout);
  assert.ok(Array.isArray(set.all) && set.all.length > 0, 'el set no trae `all`');
  assert.ok(typeof set.batch_rule === 'string' && set.batch_rule.length > 0, 'el set no trae `batch_rule`');
});

// ─────────────────────────────────────────────────────────────────────────────
// `start --brief` (story 7.10) — el otro lado de la misma moneda: `advisors` y `smart-reloop` ya
// no truncan su salida grande; `start` directamente NO DEBERÍA emitirla. Devuelve ~4 KB de JSON del
// que el orquestador usa una docena de campos, y ese texto vuelve a entrar en contexto en CADA
// respuesta posterior del turno.
//
// 🔴 El contrato que estos casos fijan: el modo breve RECORTA pero no PIERDE (el JSON entero queda
//    en un archivo y su ruta viaja en la salida), y SIN el flag el comando se comporta igual que
//    siempre — un `start` que cambiara de forma rompería a todo orquestador ya escrito.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repo como mkRepo pero listo para `start`: parado en una rama de trabajo (si no, PIPE-C1 frena por
 * rama protegida) y con la story en `ready-for-dev` (el molde la deja `in-progress`, que es lo que
 * necesitan advisors/smart-reloop, y para `start` eso es PIPE-C5 «pipeline abandonado»).
 */
function mkRepoEnRama() {
  const repo = mkRepo();
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace('status: in-progress', 'status: ready-for-dev'));
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/salida-breve'], { stdio: 'ignore' });
  return repo;
}

/**
 * HOME limpio para `start`: escribe el marker él mismo, no hay que pre-fabricarlo. Pero `start`
 * invoca `marker.js` por una ruta colgada de HOME (`$HOME/.claude/agent-skills/...`), así que un
 * HOME vacío lo hace fallar con `marker-set-failed` — que se lee igual que un preflight frenado.
 * El enlace apunta al agent-skills REAL (el código bajo prueba) y el ESTADO igual queda aislado en
 * el temporal, porque marker.js escribe bajo `$HOME/.claude/.tycon-pipeline/`.
 */
function mkHomeLimpio() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'salida-grande-start-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(path.resolve(SCRIPTS, '..', '..', '..'), path.join(home, '.claude', 'agent-skills'));
  return home;
}

test('start --brief: devuelve sólo lo que el orquestador usa y la ruta del JSON completo', () => {
  const repo = mkRepoEnRama();
  const home = mkHomeLimpio();
  const r = correr(['start', '--repo', repo, '--story', path.join(repo, 'story.md'), '--brief'], home);

  assert.equal(r.status, 0, `start --brief salió ${r.status}. stderr: ${String(r.stderr).slice(0, 300)}`);

  let breve;
  assert.doesNotThrow(() => { breve = JSON.parse(r.stdout); },
    `start --brief: stdout no es un JSON entero. cola: ${String(r.stdout).slice(-200)}`);

  // Lo que el orquestador consume de verdad sigue estando.
  assert.equal(breve.ready, true, 'el modo breve perdió `ready`');
  assert.equal(breve.story_id, '9.9', 'el modo breve perdió `story_id`');
  assert.equal(breve.branch, 'feat/salida-breve', 'el modo breve perdió `branch`');
  assert.ok(typeof breve.riesgo === 'string' && breve.riesgo.length, 'el modo breve perdió la clase de riesgo');
  assert.equal(typeof breve.auto_approve_plan, 'boolean', 'el modo breve perdió `auto_approve_plan`');
  assert.ok(typeof breve.modelo === 'string' && breve.modelo.length, 'el modo breve perdió el modelo recomendado');
  assert.ok(Array.isArray(breve.acciones), 'el modo breve perdió las acciones del preflight');
  assert.ok(typeof breve.next === 'string' && breve.next.length, 'el modo breve perdió `next`');

  // El detalle NO se pierde: vive en un archivo y su ruta viaja en la salida.
  assert.ok(typeof breve.completo === 'string' && breve.completo.length,
    'el modo breve no devolvió la ruta del JSON completo — recortar sin dejar dónde mirar es perder');
  assert.ok(fs.existsSync(breve.completo), `la ruta de \`completo\` no existe: ${breve.completo}`);
  const entero = JSON.parse(fs.readFileSync(breve.completo, 'utf8'));
  assert.ok(entero.risk && entero.model_hint && entero.tooling,
    'el archivo del detalle no trae el objeto completo (risk / model_hint / tooling)');

  // Y recorta de verdad: el objetivo es que NO vuelva a entrar en contexto en cada respuesta.
  const enteroLen = JSON.stringify(entero, null, 2).length;
  assert.ok(r.stdout.length < enteroLen / 2,
    `el modo breve casi no recortó: ${r.stdout.length} caracteres contra ${enteroLen} del completo`);
});

test('start SIN el flag se comporta como hoy (el contrato viejo no se toca)', () => {
  const repo = mkRepoEnRama();
  const home = mkHomeLimpio();
  const r = correr(['start', '--repo', repo, '--story', path.join(repo, 'story.md')], home);

  assert.equal(r.status, 0, `start salió ${r.status}. stderr: ${String(r.stderr).slice(0, 300)}`);
  const full = JSON.parse(r.stdout);
  assert.equal(full.ready, true);
  assert.ok(full.risk && typeof full.risk.risk === 'string', 'sin el flag desapareció `risk`');
  assert.ok(full.model_hint && full.model_hint.recommended_session_model, 'sin el flag desapareció `model_hint`');
  assert.ok(full.tooling, 'sin el flag desapareció `tooling`');
  assert.ok(!('completo' in full), 'sin el flag no debería aparecer `completo`');
});

test('start --brief conserva el código de salida cuando el preflight FRENA', () => {
  // La rama protegida es la pausa más común del preflight. El orquestador gatea por el exit code:
  // si el modo breve lo cambiara, un `start` frenado pasaría por bueno.
  const repo = mkRepoEnRama();
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-'], { stdio: 'ignore' });   // vuelta a la rama protegida
  const home = mkHomeLimpio();
  const r = correr(['start', '--repo', repo, '--story', path.join(repo, 'story.md'), '--brief'], home);

  assert.equal(r.status, 1, 'un preflight frenado tiene que salir 1 también en modo breve');
  const breve = JSON.parse(r.stdout);
  assert.equal(breve.ready, false);
  assert.ok(Array.isArray(breve.pauses) && breve.pauses.length > 0, 'el modo breve se comió las pausas');
  assert.ok(breve.pauses[0].id && breve.pauses[0].detail, 'las pausas perdieron id o detalle');
});

test('start --brief: las ramas opcionales del recorte (riesgo, gap de E2E, spec vieja)', () => {
  // Rojo previo: los asserts de abajo no existían y las cuatro ramas opcionales de `recortarStart`
  // —`riesgo_por`, `effort`, `e2e_gap`, `spec_stale`— no las tocaba ningún caso. Una rama sin
  // assert es una rama que se puede romper sin que nadie se entere.
  const repo = mkRepoEnRama();
  const home = mkHomeLimpio();
  const r = correr(['start', '--repo', repo, '--story', path.join(repo, 'story.md'), '--brief'], home);
  const breve = JSON.parse(r.stdout);
  const entero = JSON.parse(fs.readFileSync(breve.completo, 'utf8'));

  // Con riesgo NORMAL el recorte tiene que decir POR QUÉ, no sólo la clase: es lo que el
  // orquestador le muestra al dev en el checkpoint del plan.
  if (entero.risk && entero.risk.risk === 'NORMAL') {
    assert.ok(Array.isArray(breve.riesgo_por), 'riesgo NORMAL sin `riesgo_por`: el dev no sabe qué criterio falló');
    assert.deepEqual(
      breve.riesgo_por,
      (entero.risk.criteria || []).filter((c) => !c.pass).map((c) => c.name),
      '`riesgo_por` no coincide con los criterios que fallaron en el objeto completo');
  }
  // `effort` viaja aunque sea null — el orquestador lo compara con el effort de su sesión.
  assert.ok('effort' in breve, 'el recorte se comió `effort`');
  // Los dos avisos del preflight pasan sólo si existen, y con el mismo valor que el completo.
  for (const campo of ['e2e_gap', 'spec_stale']) {
    if (entero[campo]) {
      assert.deepEqual(breve[campo], entero[campo], `el recorte perdió o cambió \`${campo}\``);
    } else {
      assert.ok(!(campo in breve), `\`${campo}\` no existía en el completo y apareció en el recorte`);
    }
  }
  // Las tools esperadas viajan como NOMBRES: el cómo-levantarlas es el grueso del texto y vive
  // en el archivo. Es la mitad del recorte.
  if (entero.tooling && Array.isArray(entero.tooling.expected)) {
    assert.deepEqual(breve.tools_esperadas, entero.tooling.expected.map((x) => x.name));
  }
});

test('start --brief: si no puede escribir el detalle, devuelve el objeto ENTERO', () => {
  // Rojo previo: el `catch` de `recortarStart` —la red de seguridad del AC 5— no tenía ningún
  // assert. La regla del fail-open es explícita: peor en tokens, NUNCA peor en información.
  const repo = mkRepoEnRama();
  const home = mkHomeLimpio();
  // Un ARCHIVO donde el script espera poder crear la CARPETA de salidas: mkdirSync falla y el
  // recorte tiene que caer con gracia.
  const dir = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'salidas'), 'no soy una carpeta\n');

  const r = correr(['start', '--repo', repo, '--story', path.join(repo, 'story.md'), '--brief'], home);
  assert.equal(r.status, 0, `start --brief salió ${r.status} con la carpeta de salidas bloqueada. stderr: ${String(r.stderr).slice(0, 300)}`);
  const salida = JSON.parse(r.stdout);
  assert.ok(!('completo' in salida), 'prometió una ruta de detalle que no pudo escribir');
  assert.ok(salida.risk && salida.model_hint && salida.tooling,
    'no pudo escribir el detalle Y ADEMÁS lo recortó: el fail-open tiene que devolver el objeto entero');
});
