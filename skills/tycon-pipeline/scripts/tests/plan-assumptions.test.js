'use strict';
// La sección «## Suposiciones sobre el código» del plan: el cierre de «Armar el plan» de una historia con código no pasa
// sin ella, ni con un archivo citado que no existe. Un plan de puro texto no la lleva.
// Corre: node --test skills/tycon-pipeline/scripts/tests/plan-assumptions.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const sup = require(path.join(SCRIPTS, 'lib', 'plan-assumptions.js'));

function repoDePrueba() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-assumptions-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\nfunction leer() { return null; }\n');
  return repo;
}
const PLAN_CODIGO = (suposiciones) => ['## Qué hace', 'Cambia lo que devuelve leer.', '', '## Archivos', '- src/a.js', '- `node --test tests/a.test.js`',
  ...(suposiciones === undefined ? [] : ['', '## Suposiciones sobre el código', ...suposiciones]), ''].join('\n');

test('T1 Suposiciones_PlanConCodigo_SinSeccion_DiceQueFaltaConEjemplo — una línea con qué falta y cómo se escribe', () => {
  const r = sup.revisar(PLAN_CODIGO(), { repo: repoDePrueba() });
  assert.strictEqual(r.aplica, true);
  assert.strictEqual(r.problemas.length, 1);
  assert.match(r.problemas[0], /falta la sección «## Suposiciones sobre el código»/);
  assert.match(r.problemas[0], /por ejemplo: «- .+:\d+ — .+»/);
  assert.doesNotMatch(r.problemas[0], /\n/, 'el mensaje es una sola línea');
});

test('T2 Suposiciones_PlanDePuroTexto_NoAplica — un plan que sólo toca guías o historias no la lleva', () => {
  const plan = ['## Qué hace', 'Corrige la guía.', '', '## Archivos', '- guides/x.md', '- specs/story-1.md', ''].join('\n');
  assert.deepStrictEqual(sup.revisar(plan, { repo: repoDePrueba() }), { aplica: false, problemas: [], suposiciones: [] });
  // una prueba sola tampoco es código de implementación
  const soloPrueba = ['## Archivos', '- tests/a.test.js', ''].join('\n');
  assert.strictEqual(sup.revisar(soloPrueba, { repo: repoDePrueba() }).aplica, false);
  // sin «## Archivos» no se sabe: no frena
  assert.strictEqual(sup.revisar('## Qué hace\nalgo\n', { repo: repoDePrueba() }).aplica, false);
});

test('T3 Suposiciones_ArchivoCitadoQueNoExiste_Frena — la ruta y la línea se comprueban en el repo', () => {
  const repo = repoDePrueba();
  const r = sup.revisar(PLAN_CODIGO(['- `src/b.js:3` — b exporta leer', '- src/a.js:40 — leer está al final', '- leer devuelve null']), { repo });
  assert.strictEqual(r.problemas.length, 3, r.problemas.join(' | '));
  assert.match(r.problemas[0], /src\/b\.js:3 no existe en el repo/);
  assert.match(r.problemas[1], /src\/a\.js:40 no existe: el archivo tiene 3 líneas/);
  assert.match(r.problemas[2], /«leer devuelve null» no cita dónde lo comprobaste.*por ejemplo/);
  // vacía también frena
  assert.match(sup.revisar(PLAN_CODIGO([]), { repo }).problemas[0], /está vacía/);
});

test('T4 Suposiciones_TodasCitadasYExistentes_Pasa — con su archivo:línea, el plan cierra', () => {
  const r = sup.revisar(PLAN_CODIGO(['- `src/a.js:2` — leer devuelve null', '- src/a.js:1-2 — el módulo exporta un número']), { repo: repoDePrueba() });
  assert.deepStrictEqual(r.problemas, []);
  assert.strictEqual(r.suposiciones.length, 2);
});

test('T6 Suposiciones_CitaDelRepoHermano_Vale — la historia vive en un repo y el código en su hermano', () => {
  const historias = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-assumptions-historias-'));
  const codigo = repoDePrueba();
  const plan = PLAN_CODIGO(['- `src/a.js:2` — leer devuelve null']);
  assert.match(sup.revisar(plan, { repo: historias }).problemas[0], /src\/a\.js:2 no existe en el repo ni en sus hermanos/);
  assert.deepStrictEqual(sup.revisar(plan, { repo: historias, raices: [codigo] }).problemas, []);
});

test('T7 Suposiciones_Ninguna_ConMotivo_Pasa — un plan que sólo crea archivos nuevos no tiene nada que suponer', () => {
  const repo = repoDePrueba();
  assert.deepStrictEqual(sup.revisar(PLAN_CODIGO(['- Ninguna: el plan sólo crea src/b.js']), { repo }).problemas, []);
  // «Ninguna» sin motivo no vale
  assert.strictEqual(sup.revisar(PLAN_CODIGO(['- Ninguna']), { repo }).problemas.length, 1);
});

test('T8 Suposiciones_RangoAfuera_RutaAfuera_Frenan; RuidoConCitaBuena_Pasa — los bordes de una cita', () => {
  const repo = repoDePrueba();
  assert.match(sup.revisar(PLAN_CODIGO(['- src/a.js:1-9999 — todo el archivo']), { repo }).problemas[0], /src\/a\.js:1-9999 no existe: el archivo tiene 3 líneas/);
  const afuera = path.join(repo, 'src', 'a.js');
  assert.strictEqual(sup.revisar(PLAN_CODIGO([`- ${afuera}:1 — ruta absoluta`]), { repo: fs.mkdtempSync(path.join(os.tmpdir(), 'otro-')) }).problemas.length, 1);
  // una versión que parece cita no tumba al renglón que sí cita bien
  assert.deepStrictEqual(sup.revisar(PLAN_CODIGO(['- desde v1.2:3, `src/a.js:2` devuelve null']), { repo }).problemas, []);
  // una ruta de Next.js con corchetes
  fs.mkdirSync(path.join(repo, 'app', '[id]'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'app', '[id]', 'page.tsx'), 'export default 1;\n');
  assert.deepStrictEqual(sup.revisar(PLAN_CODIGO(['- app/[id]/page.tsx:1 — exporta por defecto']), { repo }).problemas, []);
});

// ── El cierre de «Armar el plan», de punta a punta ──
test('T5 CompleteStepPlan_SinSuposiciones_Frena_ConEllas_Cierra — marker.js complete-step plan', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-assumptions-cli-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.8-suposiciones.md');
  fs.writeFileSync(story, ['---', 'story: "9.8"', 'title: "suposiciones"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
    '# Story 9.8', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\nfunction leer() { return null; }\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-sup', TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '' };
  const correr = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env, input: '', cwd: repo });
  const s = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief']);
  assert.strictEqual(s.status, 0, s.stderr + s.stdout);
  const activo = path.join(home, '.claude', '.tycon-pipeline', 'active', 's-sup.json');
  const m = JSON.parse(fs.readFileSync(activo, 'utf8'));
  const pasos = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const nombres = pasos.STEPS.map((p) => p.id);
  const hasta = nombres.indexOf('plan');
  fs.writeFileSync(activo, JSON.stringify({ ...m, stepScheme: 2, stepsCompleted: nombres.slice(0, hasta), stepsPending: nombres.slice(hasta) }));
  const rd = correr('pipeline.js', ['run-dir', '--story', story, '--repo', repo, '--create']);
  assert.strictEqual(rd.status, 0, rd.stderr);
  const planFile = path.join(rd.stdout.trim().split('\n').pop().trim(), 'step-02-bmad-plan.md');
  fs.writeFileSync(planFile, PLAN_CODIGO());
  const sin = correr('marker.js', ['complete-step', 'plan']);
  assert.strictEqual(sin.status, 2, sin.stderr + sin.stdout);
  assert.match(sin.stderr, /complete-step plan BLOQUEADO — falta la sección «## Suposiciones sobre el código».*por ejemplo/);
  assert.ok(!JSON.parse(fs.readFileSync(activo, 'utf8')).stepsCompleted.includes('plan'), 'el paso sigue abierto');
  fs.writeFileSync(planFile, PLAN_CODIGO(['- `src/a.js:2` — leer devuelve null']));
  const con = correr('marker.js', ['complete-step', 'plan']);
  assert.strictEqual(con.status, 0, con.stderr + con.stdout);
  assert.ok(JSON.parse(fs.readFileSync(activo, 'utf8')).stepsCompleted.includes('plan'), 'el paso cerró');
});
