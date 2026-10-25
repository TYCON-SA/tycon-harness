#!/usr/bin/env node
'use strict';
// steps-scheme.test.js — los pasos nuevos del pipeline: once seguidos, con nombre de máquina.
//
// Una ejecución nueva guarda los pasos por su nombre de máquina (`stepScheme: 2`) y se niega a cerrar un paso por número:
// con la numeración nueva, el mismo número es otro paso. Una ejecución con el marcador viejo sigue andando con sus números
// hasta la fecha de retiro. El portón de carril, el freno de pruebas primero y el aviso de pasos pendientes deciden lo
// mismo con los dos marcadores.
//
// Corre los comandos reales con un HOME temporal (el skill y el arnés enlazados, como en una máquina) y el id de sesión
// fijado en el proceso hijo.
//
// stable-data: dos casos leen el reloj a propósito (marker.js compara el check de los revisores con el cierre que anota
// con la hora real); los demás usan fechas fijas.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/steps-scheme.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const SKILL = path.join(SCRIPTS, '..');
const RAIZ = path.join(SKILL, '..', '..');
const S = () => require(path.join(SCRIPTS, 'lib', 'steps.js'));

// La tabla, escrita acá a propósito: es la de la story, no la del código que se prueba.
const TABLA = [
  [1, 'start', 'Arranque', 'step-01-start.md'],
  [2, 'validate-story', 'Validar la historia', 'step-02-validate-story.md'],
  [3, 'plan', 'Armar el plan', 'step-03-plan.md'],
  [4, 'approve-plan', 'Aprobar el plan', 'step-04-approve-plan.md'],
  [5, 'implement', 'Implementar', 'step-05-implement.md'],
  [6, 'run-tests', 'Correr las pruebas', 'step-06-run-tests.md'],
  [7, 'reviewers', 'Revisores', 'step-07-reviewers.md'],
  [8, 'adversarial-pass', 'Pase adversarial', 'step-08-adversarial-pass.md'],
  [9, 'findings', 'Hallazgos', 'step-09-findings.md'],
  [10, 'live-check', 'Probar en vivo', 'step-10-live-check.md'],
  [11, 'prepare-commit', 'Preparar el commit', 'step-11-prepare-commit.md'],
];
const CIERRE = ['close-work-item', 'Cerrar la historia', 'close-work-item.md'];
// Los quince archivos de paso del esquema viejo: ninguna ruta nueva puede ser igual a una de éstas.
const VIEJOS = [
  'step-00-preflight.md', 'step-00b-work-start.md', 'step-00c-ado-mark-active.md', 'step-01-validate-story.md',
  'step-02-invoke-bmad.md', 'step-03-hitl-plan.md', 'step-04-execute.md', 'step-05-advisors-parallel.md',
  'step-05b-adversarial-verify.md', 'step-06-consolidated-report.md', 'step-07-hitl-approve.md',
  'step-07b-rerun-advisors-if-fixes.md', 'step-07c-dod-runtime-gate.md', 'step-08-commit-prep.md', 'step-09-ado-story-closure.md',
];

// ── Un HOME temporal con el skill y el arnés enlazados, y una story en un repo de git ──────────────────────────────
function entorno({ ado = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-scheme-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'tests'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-esquema.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.9"', 'title: "esquema"', 'status: ready-for-dev', ...(ado ? ['ado_work_item: 123'] : []),
    'files_to_modify:', '  - src/a.js', '---', '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid, extra) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', ...(extra || {}),
  });
  const correr = (script, args, sid, input, extra) => spawnSync('node', [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: input === undefined ? '' : input, cwd: repo,
  });
  const activo = (sid) => path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const escribir = (sid, m) => { fs.mkdirSync(path.dirname(activo(sid)), { recursive: true }); fs.writeFileSync(activo(sid), JSON.stringify(m)); };
  return { base, home, repo, story, correr, activo, leer, escribir };
}

const arrancar = (E, sid, extra) => {
  const r = E.correr('pipeline.js', ['start', '--story', E.story, '--repo', E.repo, '--brief'], sid, undefined, extra);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(JSON.parse(r.stdout).ready, true, r.stdout);
  return E.leer(sid);
};
const next = (E, sid, extra) => {
  const r = E.correr('pipeline.js', ['next'], sid, undefined, extra);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const NOMBRES = TABLA.map((t) => t[1]);
// un marcador nuevo con los pasos hasta `hasta` (incluido) cerrados
const nuevo = (base, hasta, extra) => {
  const i = NOMBRES.indexOf(hasta);
  return { ...base, stepScheme: 2, stepsCompleted: NOMBRES.slice(0, i + 1), stepsPending: NOMBRES.slice(i + 1), ...(extra || {}) };
};
const viejo = (base, hechos, extra) => {
  const todos = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const m = { ...base, stepsCompleted: hechos, stepsPending: todos.filter((n) => !hechos.includes(n)), ...(extra || {}) };
  delete m.stepScheme;
  return m;
};

test('T7 Start_WritesSchemeTwo @story-7.23 @ac-5 — una ejecución nueva nace con el esquema 2 y next sale de la tabla', () => {
  const E = entorno();
  const m = arrancar(E, 's-t7');
  assert.strictEqual(m.stepScheme, 2);
  assert.deepStrictEqual(m.stepsCompleted, ['start'], 'start lo cierra el propio arranque');
  // los dos que se cierran con su bandera no van en la lista: ninguna bandera la vacía
  assert.deepStrictEqual(m.stepsPending, NOMBRES.slice(1).filter((x) => x !== 'adversarial-pass' && x !== 'live-check'));
  assert.ok(m.stepTimings && m.stepTimings.start && m.stepTimings.start.completedAt, 'el tiempo del arranque, por nombre');
  const n = next(E, 's-t7');
  assert.strictEqual(n.next_step, 'validate-story');
  assert.strictEqual(n.step_number, 2);
  assert.strictEqual(n.step_total, 11);
  assert.strictEqual(n.step_name, 'Validar la historia');
  assert.strictEqual(path.basename(n.next_step_file), 'step-02-validate-story.md');
  assert.ok(fs.existsSync(n.next_step_file), `el archivo existe: ${n.next_step_file}`);
  assert.match(n.note, /paso 2 de 11/);
  assert.match(n.note, /complete-step validate-story/);
  assert.deepStrictEqual(n.steps.map((s) => s.step), NOMBRES, 'los once, en orden');
  assert.deepStrictEqual(n.steps.map((s) => s.number), TABLA.map((t) => t[0]));
  // la tabla
  const T = S();
  assert.deepStrictEqual(T.STEPS.map((s) => [s.number, s.id, s.name, s.file]), TABLA);
  assert.deepStrictEqual([T.CLOSE_STEP.id, T.CLOSE_STEP.name, T.CLOSE_STEP.file], CIERRE);
  assert.strictEqual(T.OLD_NUMBERS_UNTIL, null, 'la fecha de retiro se fija después, con un commit propio');
});

test('T8 CompleteStep_NumberRejectedOnNewMarker @story-7.23 @ac-6 — con el marcador nuevo, un número se niega y nombra los dos pasos', () => {
  const E = entorno();
  const m = arrancar(E, 's-t8');
  const antes = fs.readFileSync(E.activo('s-t8'), 'utf8');
  const r = E.correr('marker.js', ['complete-step', '5'], 's-t8');
  assert.notStrictEqual(r.status, 0, 'un número no cierra nada');
  assert.match(r.stderr, /ambiguo/);
  assert.match(r.stderr, /implement/);
  assert.match(r.stderr, /reviewers/);
  assert.strictEqual(fs.readFileSync(E.activo('s-t8'), 'utf8'), antes, 'el marcador no cambió');
  const rs = E.correr('marker.js', ['start-step', '5'], 's-t8');
  assert.notStrictEqual(rs.status, 0, 'start-step con un número tampoco');
  assert.match(rs.stderr, /implement/);
  // con el nombre, cierra
  const ok = E.correr('marker.js', ['complete-step', 'validate-story'], 's-t8');
  assert.strictEqual(ok.status, 0, ok.stderr);
  const d = E.leer('s-t8');
  assert.ok(d.stepsCompleted.includes('validate-story'));
  assert.ok(!d.stepsPending.includes('validate-story'));
  assert.ok(d.stepTimings['validate-story'].completedAt);
  assert.strictEqual(m.stepScheme, 2);
  // un nombre que no existe
  const mal = E.correr('marker.js', ['complete-step', 'revisores'], 's-t8');
  assert.notStrictEqual(mal.status, 0);
  assert.match(mal.stderr, /reviewers/, 'dice los nombres que sí existen');
});

test('T9 CompleteStep_OldMarkerUntilRetireDate @story-7.23 @ac-7 — el marcador viejo sigue con sus números hasta la fecha', () => {
  const E = entorno();
  const base = arrancar(E, 's-t9');
  const ahora = new Date().toISOString(); // stable-data: el check de los revisores tiene que ser posterior al arranque real de la ejecución
  E.escribir('s-t9', viejo(base, [0, 1, 2, 3, 4], {
    checks: { advisors: 'green' }, checksProvenance: { advisors: 'run-check' }, checksAt: { advisors: ahora },
  }));
  const r = E.correr('marker.js', ['complete-step', '5'], 's-t9');
  assert.strictEqual(r.status, 0, r.stderr);
  const m = E.leer('s-t9');
  assert.ok(m.stepsCompleted.includes(5), 'cerró los revisores, como hoy');
  assert.strictEqual(m.stepScheme, undefined, 'el marcador viejo no se reescribe a mitad de ejecución');
  const n = next(E, 's-t9');
  assert.strictEqual(n.next_step, 'adversarial-pass', 'next traduce el resto con la equivalencia');
  assert.strictEqual(n.step_name, 'Pase adversarial');
  // la fecha de retiro, por la función pura
  const T = S();
  const mv = viejo(base, [0, 1, 2, 3, 4]);
  const hoy = '2027-03-10';
  assert.deepStrictEqual(T.resolveStepArg(mv, '5', { today: hoy, until: null }).ids, ['5']);
  assert.deepStrictEqual(T.resolveStepArg(mv, '5', { today: hoy, until: '2027-04-01' }).ids, ['5']);
  const pasada = T.resolveStepArg(mv, '5', { today: hoy, until: '2027-03-01' });
  assert.strictEqual(pasada.ok, false, 'pasada la fecha, se niega');
  assert.strictEqual(pasada.message, T.resolveStepArg(nuevo(base, 'start'), '5', { today: hoy }).message, 'con el mismo mensaje que en un marcador nuevo');
  // con el marcador viejo, el nombre nuevo se traduce a su número viejo
  assert.deepStrictEqual(T.resolveStepArg(mv, 'reviewers', { today: hoy }).ids, ['5']);
  assert.deepStrictEqual(T.resolveStepArg(mv, 'findings', { today: hoy }).ids, ['6', '7']);
});

test('T10 Start_OptionalPartsHiddenOrWarned @story-7.23 @ac-10 — las partes opcionales del Arranque: o no aparecen, o avisan', () => {
  // (a) sin herramienta de horas ni pedido de ADO: ninguna parte en ningún lado
  const E = entorno();
  arrancar(E, 's-t10a');
  const a = next(E, 's-t10a');
  assert.strictEqual(a.start_parts, undefined, `ninguna parte: ${JSON.stringify(a.start_parts)}`);
  assert.strictEqual(a.warnings, undefined);
  assert.doesNotMatch(a.note, /registro de horas|pedido en ADO/);
  const cierreA = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t10a');
  assert.doesNotMatch(cierreA.stderr + cierreA.stdout, /con aviso/);

  // con la herramienta elegida y el pedido en el frontmatter, las dos partes se piden
  const E2 = entorno({ ado: true });
  arrancar(E2, 's-t10p', { TYCON_TIME_TRACKING: 'clockify' });
  const p = next(E2, 's-t10p', { TYCON_TIME_TRACKING: 'clockify' });
  assert.deepStrictEqual((p.start_parts || []).map((x) => x.part).sort(), ['ado', 'time-tracking']);
  assert.match(p.note, /Arranque/);

  // (b) y (c) una parte que falla: el paso cierra igual y el aviso sale en next y en el cierre
  let E3 = null;
  for (const [parte, texto] of [['time-tracking', 'no se pudo abrir el registro de horas'], ['ado', 'no se pudo marcar el pedido en ADO']]) {
    const sid = `s-t10-${parte}`;
    // un repo propio por parte: una sola ejecución viva por story
    E3 = entorno({ ado: true });
    arrancar(E3, sid, { TYCON_TIME_TRACKING: 'clockify' });
    const w = E3.correr('marker.js', ['start-warning', parte, 'la herramienta no contestó'], sid);
    assert.strictEqual(w.status, 0, w.stderr);
    const m = E3.leer(sid);
    assert.deepStrictEqual(m.startWarnings.map((x) => x.part), [parte]);
    assert.strictEqual(m.startWarnings[0].message, 'la herramienta no contestó');
    assert.ok(m.stepsCompleted.includes('start'), 'el Arranque sigue cerrado');
    const n = next(E3, sid, { TYCON_TIME_TRACKING: 'clockify' });
    assert.ok((n.warnings || []).includes(`Arranque: hecho, con aviso: ${texto}`), JSON.stringify(n.warnings));
    assert.ok(!(n.start_parts || []).some((x) => x.part === parte), 'la parte que falló ya no se pide');
    const c = E3.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], sid, undefined, { TYCON_TIME_TRACKING: 'clockify' });
    assert.match(c.stderr + c.stdout, new RegExp(`Arranque: hecho, con aviso: ${texto}`));
  }
  const malo = E3.correr('marker.js', ['start-warning', 'clockify', 'x'], 's-t10-ado');
  assert.notStrictEqual(malo.status, 0, 'sólo time-tracking o ado');
});

test('T11 Hooks_SameDecisionOldAndNew @story-7.23 @ac-8 — el portón, el freno y el aviso deciden igual con los dos marcadores', () => {
  const E = entorno();
  const base = arrancar(E, 's-t11');
  const archivo = path.join(E.repo, 'src', 'a.js');
  const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const atdd = require(path.join(SCRIPTS, 'lib', 'atdd-preedit.js'));
  const casos = [
    // [situación, marcador viejo, marcador nuevo]
    ['plan pendiente', viejo(base, [0, 1, 2]), nuevo(base, 'plan')],
    ['plan aprobado', viejo(base, [0, 1, 2, 3]), nuevo(base, 'approve-plan')],
    ['implementación cerrada', viejo(base, [0, 1, 2, 3, 4]), nuevo(base, 'run-tests')],
  ];
  for (const [que, mv, mn] of casos) {
    const g = (m) => gate.computeStoryGate({ filePath: archivo, repoRoot: E.repo, marker: m, adhoc: null, isHarness: false }).action;
    assert.strictEqual(g(mn), g(mv), `el portón de carril, ${que}`);
    const a = (m) => atdd.computeAtddPreEdit({ filePath: archivo, repoPath: E.repo, storyHasTests: true, priorPaths: [], stepsCompleted: m.stepsCompleted, stepScheme: m.stepScheme }).action;
    assert.strictEqual(a(mn), a(mv), `el freno de pruebas primero, ${que}`);
  }
  assert.strictEqual(gate.computeStoryGate({ filePath: archivo, repoRoot: E.repo, marker: nuevo(base, 'plan'), adhoc: null, isHarness: false }).kind, 'plan');
  // el aviso de pasos pendientes: «listo» con los revisores pendientes
  for (const [que, m] of [['viejo', viejo(base, [0, 1, 2, 3, 4])], ['nuevo', nuevo(base, 'run-tests')]]) {
    E.escribir('s-t11', m);
    const r = E.correr('on-prompt.js', [], 's-t11', JSON.stringify({ prompt: 'listo, ya está', session_id: 's-t11' }));
    assert.match(r.stdout, /STOP-detect/, `avisa con el marcador ${que}`);
    assert.match(r.stdout, /Revisores/, `nombra los revisores con el marcador ${que}`);
  }
});

test('T12 Reloop_IsReviewersRound @story-7.23 @ac-9 — un arreglo después de Hallazgos vuelve a Revisores, vuelta 2', () => {
  const E = entorno();
  const base = arrancar(E, 's-t12');
  const t0 = Date.parse('2026-05-01T10:00:00Z');
  const iso = (min) => new Date(t0 + min * 60000).toISOString();
  const m = nuevo(base, 'findings', {
    deepReviewDone: true,
    stepTimings: { reviewers: { completedAt: iso(0) }, findings: { completedAt: iso(5) } },
    fileEvents: [{ path: path.join(E.repo, 'src', 'a.js'), ts: iso(-30) }],
  });
  m.stepsCompleted = m.stepsCompleted.filter((s) => s !== 'adversarial-pass');
  E.escribir('s-t12', m);
  assert.strictEqual(next(E, 's-t12').next_step, 'live-check', 'sin arreglos, sigue Probar en vivo');
  E.escribir('s-t12', { ...m, fileEvents: [...m.fileEvents, { path: path.join(E.repo, 'src', 'a.js'), ts: iso(8) }] });
  const n = next(E, 's-t12');
  assert.strictEqual(n.next_step, 'reviewers');
  assert.strictEqual(n.step_name, 'Revisores, vuelta 2');
  assert.match(n.note, /paso 7 de 11/);
  assert.ok(!n.steps.some((s) => /7b/.test(String(s.step))), 'no hay paso 7b');
});

test('T13 Findings_WaitOnlyWhenItStops @story-7.23 @ac-11 — la espera de Hallazgos se anota sólo cuando de verdad frena', () => {
  const E = entorno();
  const base = arrancar(E, 's-t13');
  const abierto = nuevo(base, 'reviewers', { autonomous: true, deepReviewDone: true });
  // sin críticos: el turno cierra sin pregunta, y no queda espera
  E.escribir('s-t13', abierto);
  E.correr('on-stop-dod-gate.js', [], 's-t13', JSON.stringify({ session_id: 's-t13' }));
  assert.strictEqual(((E.leer('s-t13').stepTimings || {}).findings || {}).waitStartedAt, undefined, 'sin pregunta, sin espera');
  // con críticos, en modo autónomo: el Stop-hook consume waitingForHuman y anota la espera
  E.escribir('s-t13', { ...abierto, waitingForHuman: true });
  E.correr('on-stop-dod-gate.js', [], 's-t13', JSON.stringify({ session_id: 's-t13' }));
  const m = E.leer('s-t13');
  assert.strictEqual(m.waitingForHuman, undefined, 'la bandera se consume');
  const w = m.stepTimings.findings.waitStartedAt;
  assert.ok(w, 'la espera quedó anotada');
  // otra vuelta no la mueve
  E.escribir('s-t13', { ...m, waitingForHuman: true });
  E.correr('on-stop-dod-gate.js', [], 's-t13', JSON.stringify({ session_id: 's-t13' }));
  assert.strictEqual(E.leer('s-t13').stepTimings.findings.waitStartedAt, w);
  // con la persona presente: la pregunta abre la espera
  const sid = 's-t13p';
  E.escribir(sid, { ...abierto, sessionId: sid, autonomous: false });
  const r = spawnSync('node', [path.join(RAIZ, 'scripts', 'hooks', 'wait-notice.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(E.leer(sid).stepTimings.findings.waitStartedAt, 'la pregunta a la persona anota la espera');
  // con otro paso abierto, la pregunta no anota la espera de Hallazgos
  const sid2 = 's-t13q';
  E.escribir(sid2, { ...nuevo(base, 'plan'), sessionId: sid2 });
  spawnSync('node', [path.join(RAIZ, 'scripts', 'hooks', 'wait-notice.js')], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid2 }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid2, TYCON_HOME: '' },
  });
  assert.strictEqual((E.leer(sid2).stepTimings || {}).findings, undefined);
});

test('T14 ImplementAndRunTests_Split @story-7.23 @ac-12 — cada control del viejo paso 4 en su paso nuevo', () => {
  const E = entorno();
  const base = arrancar(E, 's-t14');
  const codigo = path.join(E.repo, 'src', 'a.js');
  const prueba = path.join(E.repo, 'tests', 'a.test.js');
  const t = (min) => new Date(Date.parse('2026-05-01T10:00:00Z') + min * 60000).toISOString();
  // el orden: Implementar pide el plan aprobado; Revisores pide Correr las pruebas
  E.escribir('s-t14', nuevo(base, 'plan'));
  const sinPlan = E.correr('marker.js', ['complete-step', 'implement'], 's-t14');
  assert.notStrictEqual(sinPlan.status, 0);
  assert.match(sinPlan.stderr, /approve-plan/);
  // el freno de pruebas primero cierra con Implementar
  E.escribir('s-t14', nuevo(base, 'approve-plan', { fileEvents: [{ path: codigo, ts: t(1) }, { path: prueba, ts: t(2) }] }));
  const codigoPrimero = E.correr('marker.js', ['complete-step', 'implement'], 's-t14');
  assert.notStrictEqual(codigoPrimero.status, 0, 'código antes que la prueba: frena');
  assert.match(codigoPrimero.stderr, /ATDD|prueba/i);
  E.escribir('s-t14', nuevo(base, 'approve-plan', { fileEvents: [{ path: prueba, ts: t(1) }, { path: codigo, ts: t(2) }] }));
  const ok = E.correr('marker.js', ['complete-step', 'implement'], 's-t14');
  assert.strictEqual(ok.status, 0, ok.stderr);
  // Correr las pruebas exige el verde de la suite completa (test-gate), no uno a mano
  const m = E.leer('s-t14');
  E.escribir('s-t14', { ...m, checks: { tests: 'green' }, checksProvenance: { tests: 'run-check' } });
  const aMano = E.correr('marker.js', ['complete-step', 'run-tests'], 's-t14');
  assert.notStrictEqual(aMano.status, 0);
  assert.match(aMano.stderr, /suite completa/);
  // Revisores, antes de Correr las pruebas: frena por orden
  const antes = E.correr('marker.js', ['complete-step', 'reviewers'], 's-t14');
  assert.notStrictEqual(antes.status, 0);
  assert.match(antes.stderr, /run-tests/);
  E.escribir('s-t14', { ...m, checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' } });
  const pruebas = E.correr('marker.js', ['complete-step', 'run-tests'], 's-t14');
  assert.strictEqual(pruebas.status, 0, pruebas.stderr);
  // con Correr las pruebas cerrado, next pide el pase adversarial antes del primer revisor
  const n = next(E, 's-t14');
  assert.strictEqual(n.next_step, 'reviewers');
  assert.ok(n.pending_action && ['consultar-porton', 'lanzar-pase'].includes(n.pending_action.kind), JSON.stringify(n.pending_action));
  // la tabla de orden
  assert.deepStrictEqual(S().ORDER_REQUIRES, {
    'approve-plan': ['validate-story', 'plan'], implement: ['approve-plan'], 'run-tests': ['implement'],
    reviewers: ['run-tests'], 'prepare-commit': ['reviewers'],
  });
});

test('T17 Steps_FolderMatchesTable @story-7.23 @ac-14 — la carpeta tiene sólo los doce archivos de la tabla', () => {
  const archivos = fs.readdirSync(path.join(SKILL, 'steps')).filter((f) => f.endsWith('.md')).sort();
  assert.deepStrictEqual(archivos, [...TABLA.map((x) => x[3]), CIERRE[2]].sort());
  for (const f of archivos) {
    const txt = fs.readFileSync(path.join(SKILL, 'steps', f), 'utf8');
    assert.doesNotMatch(txt.slice(0, 400), /Movido a/, `${f} no es un reemplazo`);
  }
  // nadie busca el archivo de un paso por patrón de número
  const lectores = ['pipeline.js', 'marker.js', path.join('lib', 'steps.js')].map((f) => path.join(SCRIPTS, f))
    .concat([path.join(RAIZ, 'scripts', 'nightly', 'dashboard', 'runs.js'), path.join(RAIZ, 'scripts', 'lib', 'harness-audit.js')]);
  for (const f of lectores) {
    const codigo = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(codigo, /step-0\[|step-\\d|step-0N|step-\d\d-\*/, `${path.basename(f)} no arma rutas de paso por patrón de número`);
  }
});

test('T19 Steps_NoNewPathRepeatsAnOld @story-7.23 @ac-14 — ninguna ruta nueva es igual a una vieja', () => {
  const nuevas = [...S().STEPS.map((s) => s.file), S().CLOSE_STEP.file];
  for (const f of nuevas) assert.ok(!VIEJOS.includes(f), `${f} repite una ruta de antes de la tanda B`);
});

test('T20 Steps_ConsecutiveNumbersNoLetters @story-7.23 @ac-14 — números 1..11 seguidos, sin letras', () => {
  const T = S();
  assert.deepStrictEqual(T.STEPS.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const s of T.STEPS) {
    assert.match(s.id, /^[a-z]+(?:-[a-z]+)*$/, `nombre de máquina sin números ni letras sueltas: ${s.id}`);
    assert.strictEqual(s.file, `step-${String(s.number).padStart(2, '0')}-${s.id}.md`);
  }
  assert.doesNotMatch(T.CLOSE_STEP.file, /\d/, 'el cierre en ADO, sin número');
  const archivos = fs.readdirSync(path.join(SKILL, 'steps')).filter((f) => /^step-/.test(f));
  for (const f of archivos) assert.match(f, /^step-\d\d-[a-z-]+\.md$/, `${f}: número de dos cifras y sin letra`);
});

test('T21 RetireCheck_ReadsMachineVersions @story-7.23 @ac-7 — la versión de cada máquina y cuándo llegó a todas', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-retire-'));
  const espejo = path.join(base, 'corridas-buzon');
  const place = (maq, version, day) => {
    fs.mkdirSync(path.join(espejo, maq, 'registros'), { recursive: true });
    fs.writeFileSync(path.join(espejo, maq, 'registros', 'place.json'), JSON.stringify({ day, install: { version } }));
  };
  place('maq-a', '2026.11.02.3', '2026-11-05');
  place('maq-b', '2026.10.30.1', '2026-11-04');   // atrasada
  place('maq-c', '2026.10.01.1', '2026-10-01');   // sin subir en 14 días: no cuenta
  const estado = path.join(base, 'estado.json');
  const correr = (today) => {
    const r = spawnSync('node', [path.join(SCRIPTS, 'lib', 'steps.js'), '--retire-check', '--mirror', espejo, '--since', '2026.11.01.1', '--today', today, '--state', estado, '--json'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const r1 = correr('2026-11-06');
  const fila = (r, m) => r.machines.find((x) => x.machine === m);
  assert.strictEqual(fila(r1, 'maq-a').arrived, true);
  assert.strictEqual(fila(r1, 'maq-a').version, '2026.11.02.3');
  assert.strictEqual(fila(r1, 'maq-b').arrived, false);
  assert.strictEqual(fila(r1, 'maq-c').active, false, 'sin subir en 14 días no cuenta');
  assert.strictEqual(r1.all_arrived, false);
  assert.strictEqual(r1.all_arrived_on, null);
  place('maq-b', '2026.11.03.2', '2026-11-07');
  const r2 = correr('2026-11-08');
  assert.strictEqual(r2.all_arrived, true);
  assert.strictEqual(r2.all_arrived_on, '2026-11-08');
  assert.strictEqual(r2.retire_on, '2026-12-08', 'la fecha de retiro: llegó a todas + 30');
  const r3 = correr('2026-11-20');
  assert.strictEqual(r3.all_arrived_on, '2026-11-08', 'la fecha en que llegó no se corre');
  // una máquina con el place.json roto: no medido, nunca «llegó a todas»
  fs.mkdirSync(path.join(espejo, 'maq-d', 'registros'), { recursive: true });
  fs.writeFileSync(path.join(espejo, 'maq-d', 'registros', 'place.json'), '{roto');
  const r4 = correr('2026-11-20');
  assert.strictEqual(r4.all_arrived, false, 'con una máquina ilegible no se sabe');
  assert.match(r4.note, /maq-d.*no es JSON válido/);
  fs.rmSync(path.join(espejo, 'maq-d'), { recursive: true });
  // sin espejo: no medido, nunca «llegó»
  const r = spawnSync('node', [path.join(SCRIPTS, 'lib', 'steps.js'), '--retire-check', '--mirror', path.join(base, 'no'), '--since', '2026.11.01.1', '--today', '2026-11-08', '--state', estado, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).all_arrived, false);
  assert.match(JSON.parse(r.stdout).note, /no medido|no hay/i);
});

// ── Cada clase de defecto del esquema nuevo, cerrada en todos sus sitios ──────────────────────────────────────────────
test('T22 Bandera_NoSeCierraConCompleteStep @story-7.23 @ac-6 @ac-12 — el pase y la prueba en vivo sólo los cierra su bandera, en los dos marcadores', () => {
  const E = entorno();
  const base = arrancar(E, 's-t22');
  E.escribir('s-t22', nuevo(base, 'reviewers'));
  for (const paso of ['adversarial-pass', 'live-check']) {
    const r = E.correr('marker.js', ['complete-step', paso], 's-t22');
    assert.notStrictEqual(r.status, 0, `complete-step ${paso} no cierra el paso sin su bandera`);
    assert.match(r.stderr, /bandera/);
    assert.ok(!E.leer('s-t22').stepsCompleted.includes(paso));
  }
  assert.strictEqual(next(E, 's-t22').next_step, 'adversarial-pass', 'el pase sigue pendiente');
  // el marcador viejo: sus sub-pasos tampoco se cierran con complete-step (antes, «5b» se leía como el 5)
  E.escribir('s-t22', viejo(base, [0, 1, 2, 3, 4, 5]));
  for (const sub of ['0b', '0c', '5b', '7b', '7c']) {
    const r = E.correr('marker.js', ['complete-step', sub], 's-t22');
    assert.notStrictEqual(r.status, 0, `complete-step ${sub} se niega en el marcador viejo`);
  }
  assert.deepStrictEqual(E.leer('s-t22').stepsCompleted, [0, 1, 2, 3, 4, 5]);
});

test('T23 EjecucionTerminada_ListaVacia @story-7.23 @ac-5 — una ejecución nueva terminada deja los pendientes vacíos para todos los que lo miran', () => {
  const E = entorno();
  const base = arrancar(E, 's-t23');
  const sinBandera = NOMBRES.filter((x) => x !== 'adversarial-pass' && x !== 'live-check');
  const fin = { ...base, stepsCompleted: sinBandera, stepsPending: [], deepReviewDone: true, dodRuntimeChecked: true };
  assert.deepStrictEqual(S().pendingSteps(fin), []);
  assert.strictEqual(require(path.join(SCRIPTS, 'lib', 'ledger-visible.js')).pipelineAbierto(fin), false);
  // y cerrando el último paso con complete-step, la lista queda vacía de verdad
  E.escribir('s-t23', { ...fin, stepsCompleted: sinBandera.filter((x) => x !== 'plan'), stepsPending: ['plan'] });
  const r = E.correr('marker.js', ['complete-step', 'plan'], 's-t23');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(E.leer('s-t23').stepsPending, []);
});

test('T24 MarcadorMezclado_NoAbreNada @story-7.23 @ac-8 — un marcador que no es de ningún esquema frena el portón, y set no lo escribe', () => {
  const E = entorno();
  const base = arrancar(E, 's-t24');
  const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const mezclado = { ...base, stepScheme: undefined, stepsCompleted: [0, 'start'], stepsPending: ['approve-plan', 4] };
  assert.strictEqual(gate.computeStoryGate({ filePath: path.join(E.repo, 'src', 'a.js'), repoRoot: E.repo, marker: mezclado, adhoc: null, isHarness: false }).action, 'block',
    'sin saber si el plan está aprobado, el portón frena');
  // set con nombres y sin stepScheme: se reconoce el esquema 2
  const conNombres = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.9', storyPath: E.story, repoPath: E.repo, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement'] })], 's-t24');
  assert.strictEqual(conNombres.status, 0, conNombres.stderr);
  assert.strictEqual(E.leer('s-t24').stepScheme, 2);
  // set con listas mezcladas: no se escribe
  const antes = fs.readFileSync(E.activo('s-t24'), 'utf8');
  const malo = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.9', stepsCompleted: [0, 'start'], stepsPending: ['implement'] })], 's-t24');
  assert.notStrictEqual(malo.status, 0);
  assert.match(malo.stderr, /esquema/);
  assert.strictEqual(fs.readFileSync(E.activo('s-t24'), 'utf8'), antes);
});

test('T25 OtraVueltaDeRevisores_NoPisaLaPrimera @story-7.23 @ac-9 @ac-11 @ac-13 — la segunda vuelta no mueve el primer cierre ni se come la espera de Hallazgos', () => {
  const E = entorno();
  const base = arrancar(E, 's-t25');
  const ahora = () => new Date().toISOString(); // stable-data: marker.js compara el check con el cierre que anota con la hora real
  const verde = () => ({ checks: { advisors: 'green' }, checksProvenance: { advisors: 'run-check' }, checksAt: { advisors: ahora() } });
  E.escribir('s-t25', nuevo(base, 'run-tests', verde()));
  assert.strictEqual(E.correr('marker.js', ['complete-step', 'reviewers'], 's-t25').status, 0);
  const primero = E.leer('s-t25').stepTimings.reviewers.completedAt;
  const m = E.leer('s-t25');
  E.escribir('s-t25', { ...m, ...verde() });
  const r2 = E.correr('marker.js', ['complete-step', 'reviewers'], 's-t25');
  assert.strictEqual(r2.status, 0, r2.stderr);
  const t = E.leer('s-t25').stepTimings.reviewers;
  assert.strictEqual(t.completedAt, primero, 'el primer cierre queda');
  assert.ok(t.lastCompletedAt && t.lastCompletedAt >= primero, 'el último cierre aparte');
  assert.strictEqual(t.rounds, 2);
  // la vuelta 2 la pide next por el último cierre: cerrada, no vuelve a pedirla
  const t0 = Date.parse('2026-05-01T10:00:00Z');
  const iso = (min) => new Date(t0 + min * 60000).toISOString();
  const tras = nuevo(base, 'findings', { deepReviewDone: true, stepTimings: { reviewers: { completedAt: iso(0), lastCompletedAt: iso(20), rounds: 2 }, findings: { completedAt: iso(5) } },
    fileEvents: [{ path: path.join(E.repo, 'src', 'a.js'), ts: iso(10) }] });
  E.escribir('s-t25', tras);
  assert.strictEqual(next(E, 's-t25').next_step, 'live-check', 'la edición quedó antes del último cierre de los revisores');
  // la cuenta de tiempos: la espera de Hallazgos no se pierde con la segunda vuelta
  const { tiempos } = require(path.join(RAIZ, 'scripts', 'metrics', 'step-times.js'));
  const c = tiempos({
    'approve-plan': { startedAt: iso(0), completedAt: iso(10) },
    reviewers: { startedAt: iso(10), completedAt: iso(20), lastCompletedAt: iso(60), rounds: 2 },
    findings: { startedAt: iso(20), waitStartedAt: iso(25), completedAt: iso(40) },
  }, { inicio: iso(0) });
  assert.strictEqual(c.espera_humana_ms, 25 * 60000, `espera = Aprobar el plan (10) + Hallazgos desde que preguntó (15): ${JSON.stringify(c.pasos.map((p) => p.paso))}`);
});

test('T26 EsperaDeHallazgos_SoloCuandoEstaAbierto @story-7.23 @ac-11 — una pregunta del pase adversarial no es la espera de Hallazgos; una estimada no se cuenta como trabajo', () => {
  const E = entorno();
  const base = arrancar(E, 's-t26');
  const pase = nuevo(base, 'reviewers');
  assert.strictEqual(S().noteFindingsWait(pase, '2026-05-01T10:00:00.000Z'), false, 'con el pase adversarial en curso, Hallazgos no está abierto');
  assert.strictEqual(S().noteFindingsWait({ ...pase, deepReviewDone: true }, '2026-05-01T10:00:00.000Z'), true);
  const { tiempos } = require(path.join(RAIZ, 'scripts', 'metrics', 'step-times.js'));
  const iso = (min) => new Date(Date.parse('2026-05-01T10:00:00Z') + min * 60000).toISOString();
  const c = tiempos({ 'approve-plan': { startedAt: iso(0), completedAt: iso(10) }, findings: { waitStartedAt: iso(15), completedAt: iso(30) } }, { inicio: iso(0) });
  assert.strictEqual(c.espera_humana_ms, null, 'Hallazgos preguntó pero no se puede medir: la espera no se publica');
  assert.match(c.motivo || '', /Hallazgos|findings/);
});

test('T27 CartelYNext_LaMismaVuelta @story-7.23 @ac-9 @ac-16 — el cartel y next deciden igual qué edición pide otra vuelta', async () => {
  const E = entorno();
  const base = arrancar(E, 's-t27');
  // on-edit marca cada edición: código o prueba, o no
  for (const f of ['src/a.js', 'config.json']) {
    E.correr('on-edit.js', [], 's-t27', JSON.stringify({ tool_name: 'Edit', session_id: 's-t27', tool_input: { file_path: path.join(E.repo, f) } }));
  }
  const ev = E.leer('s-t27').fileEvents;
  assert.strictEqual(ev.find((e) => e.path.endsWith('a.js')).code, true);
  assert.strictEqual(ev.find((e) => e.path.endsWith('config.json')).code, false);
  const { readRun } = await import(require('url').pathToFileURL(path.join(RAIZ, 'mods', 'harness-mods', 'hooks', 'run.mjs')).href);
  const iso = (min) => new Date(Date.parse('2026-05-01T10:00:00Z') + min * 60000).toISOString();
  for (const [f, code, vuelve] of [['config.json', false, false], ['src/a.js', true, true]]) {
    const m = nuevo(base, 'findings', { deepReviewDone: true, stepTimings: { reviewers: { completedAt: iso(0) }, findings: { completedAt: iso(5) } },
      fileEvents: [{ path: path.join(E.repo, f), ts: iso(8), code }] });
    E.escribir('s-t27', m);
    assert.strictEqual(next(E, 's-t27').next_step === 'reviewers', vuelve, `next con ${f}`);
    const run = readRun(JSON.stringify(m), Date.parse(iso(10)));
    assert.strictEqual(run.current.id === 'reviewers', vuelve, `el cartel con ${f}`);
  }
});

test('T28 RetireCheck_VersionMalEscrita @story-7.23 @ac-7 — un --since que no es una versión no da «llegó a todas»', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-retire-mal-'));
  const espejo = path.join(base, 'b');
  fs.mkdirSync(path.join(espejo, 'maq-a', 'registros'), { recursive: true });
  fs.writeFileSync(path.join(espejo, 'maq-a', 'registros', 'place.json'), JSON.stringify({ day: '2026-11-05', install: { version: '2026.11.02.3' } }));
  for (const since of ['v2026.11.01.1', '2026-11-01', 'x']) {
    const estado = path.join(base, `e-${since}.json`);
    const r = spawnSync('node', [path.join(SCRIPTS, 'lib', 'steps.js'), '--retire-check', '--mirror', espejo, '--since', since, '--today', '2026-11-06', '--state', estado, '--json'], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.all_arrived, false, `--since ${since}`);
    assert.match(j.note, /versión/);
    assert.ok(!fs.existsSync(estado), 'no anota ninguna fecha');
  }
});

test('T29 Next_AnotaElArranquePorNombre @story-7.23 @ac-5 @ac-13 — next anota cuándo arranca el paso, también por su nombre', () => {
  const E = entorno();
  arrancar(E, 's-t29');
  next(E, 's-t29');
  const m = E.leer('s-t29');
  assert.ok(m.stepTimings['validate-story'] && m.stepTimings['validate-story'].startedAt, JSON.stringify(m.stepTimings));
});

// ── El barrido: ningún paso por su número viejo en lo que lee un agente ─────────────────────────────────────────────
// Un número de paso que ya no existe confunde al agente que lee la skill: con la numeración nueva, «Step 5» es otro
// paso, y «5b» o «7c» no son ninguno. Lo que lee el pipeline o un agente (la skill, los revisores, los ganchos) nombra
// los pasos por su nombre; las guías para personas no nombran un paso que ya no existe. Lo que se conserva a propósito
// (claves guardadas, la equivalencia con el marcador viejo) está en la lista cerrada, con su motivo.
// un número seguido de `-nombre` es un nombre de archivo (`step-08-adversarial-pass.md`): los viejos los mira ARCHIVO_VIEJO
// los números con letra, con o sin el cero de adelante (`5b`, `05b`) y con sub-paso (`7c.3`): ninguno existe ya
const LETRA = '0?(?:0b|0c|5b|7b|7c)';
// entre «paso» y el número puede haber markdown (`paso **7c**`, `Step \`5\``); el sub-paso numérico (`4.0`) también es viejo
const SEP = '[ -]?[*`_]*';
const MENCION = new RegExp(`\\b(?:step|paso)s?${SEP}(?:${LETRA}\\b|\\d{1,2}(?:\\.\\d+)?\\b(?!\\d|-[a-z]))`, 'i');
const CON_LETRA = new RegExp(`\\b(?:step|paso)s?${SEP}${LETRA}\\b`, 'i');
// y el número con letra suelto, pegado a lo que sea que no sea una palabra («el 5b», «**5b**», «0b/0c», «(7c)»).
// Entre comillas simples o dobles es un valor del código (`'5b'`), no una mención; tras `#` o `-`, parte de otra cosa
// sin mayúsculas: los sub-pasos viejos siempre fueron en minúscula, y «7B» es el tamaño de un modelo
const LETRA_SUELTA = new RegExp(`(?<![A-Za-z0-9_'"#-])${LETRA}(?:\\.\\d)?(?![A-Za-z0-9_'"])`);
const COMPLETE_NUM = /complete-step\s+\d/;
// los archivos viejos de paso, salvo los que siguen siendo nombres de la carpeta de una ejecución (lista cerrada)
// (con o sin `.md`: `step-04-execute` también nombra el archivo viejo)
const ARCHIVO_VIEJO = new RegExp(`(?:${VIEJOS.filter((f) => f !== 'step-06-consolidated-report.md').map((f) => f.replace(/\.md$/, '')).join('|')})\\b`);
// en las guías, además de los números con letra, el paso 0: la numeración nueva arranca en 1
const PASO_CERO = new RegExp(`\\b(?:step|paso)s?${SEP}0\\b(?![.\\d]|-[a-z])`, 'i');
const CERRADA = path.join(__dirname, 'fixtures', 'old-step-mentions-allowed.json');

function alcance(ruta) {
  if (/^skills\/tycon-pipeline\/scripts\/tests\//.test(ruta)) return null;   // las pruebas citan lo viejo para probarlo
  if (/^skills\/tycon-pipeline\//.test(ruta) || /^agents\/tycon-[^/]+\.md$/.test(ruta) || /^scripts\/hooks\//.test(ruta)) return 'agente';
  if (/^(?:guides\/.+|INDEX(?:\.[a-z]+)?|README(?:\.[a-z]+)?|INSTALL)\.md$/.test(ruta)) return 'guia';
  return null;
}

/** Las menciones viejas de `archivos` ({ruta: texto}) que la lista cerrada no ampara: [{ruta, linea, texto}]. */
function mencionesViejas(archivos, cerrada) {
  const fuera = [];
  for (const [ruta, texto] of Object.entries(archivos)) {
    const tipo = alcance(ruta);
    if (!tipo) continue;
    // un archivo que numera SUS propios pasos (un freno, un procedimiento) no habla de los del pipeline
    if (cerrada.some((c) => c.own_steps && c.path === ruta)) continue;
    texto.split('\n').forEach((original, i) => {
      // la lista cerrada ampara su fragmento, no la línea entera: otra mención vieja en la misma línea se sigue viendo
      let l = original;
      for (const c of cerrada) if (c.contains && c.path === ruta) l = l.split(c.contains).join(' ');
      const hay = tipo === 'agente'
        ? (MENCION.test(l) || LETRA_SUELTA.test(l) || COMPLETE_NUM.test(l) || ARCHIVO_VIEJO.test(l))
        : (CON_LETRA.test(l) || LETRA_SUELTA.test(l) || PASO_CERO.test(l) || ARCHIVO_VIEJO.test(l));
      if (!hay) return;
      fuera.push({ ruta, linea: i + 1, texto: original.trim().slice(0, 160) });
    });
  }
  return fuera;
}

function arbolPublico() {
  const lista = execFileSync('git', ['ls-files', '-z'], { cwd: RAIZ, encoding: 'utf8' }).split('\0').filter(Boolean);
  const out = {};
  for (const r of lista) {
    if (!alcance(r) || !/\.(?:md|js|mjs|cjs|sh|ps1|json)$/.test(r)) continue;
    const abs = path.join(RAIZ, r);
    if (fs.existsSync(abs)) out[r] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}

test('T30 Steps_NoOldNumbersInWhatAgentsRead @story-7.23 @ac-15 — ningún paso por su número viejo en lo que lee un agente', () => {
  const cerrada = JSON.parse(fs.readFileSync(CERRADA, 'utf8'));
  // la lista entera, para barrer: T30_LIST=<archivo> node --test --test-name-pattern=T30 …
  if (process.env.T30_LIST) {
    fs.writeFileSync(process.env.T30_LIST, mencionesViejas(arbolPublico(), cerrada).map((f) => `${f.ruta}:${f.linea}: ${f.texto}\n`).join(''));
  }
  for (const c of cerrada) {
    // cada amparo nombra su archivo: uno que valiera para todo el alcance taparía menciones que nadie miró
    assert.ok(c.reason && c.path && (c.contains || c.own_steps === true), `la lista cerrada pide «path», «reason» y «contains» (o «own_steps»): ${JSON.stringify(c)}`);
    if (c.path) assert.ok(fs.existsSync(path.join(RAIZ, c.path)), `la lista cerrada nombra un archivo que no está: ${c.path}`);
  }
  const arbol = arbolPublico();
  const fuera = mencionesViejas(arbol, cerrada);
  assert.deepStrictEqual(fuera.map((f) => `${f.ruta}:${f.linea}: ${f.texto}`), [],
    `${fuera.length} mención(es) de un paso por su número viejo (pasalas al nombre del paso, o a la lista cerrada con su motivo)`);
  // y una copia con una mención vieja agregada sale roja, nombrando archivo y línea
  const ruta = 'skills/tycon-pipeline/steps/step-07-reviewers.md';
  const alterado = { [ruta]: `${arbol[ruta] || ''}\nAl terminar, volver al Step 5b.\n`, 'guides/x.md': 'ver el paso 7c\n', 'agents/tycon-x.md': 'correr complete-step 4\n',
    'agents/tycon-y.md': 'leer step-05b-verify y el sub-paso 7c.3\n', 'agents/tycon-z.md': 'como en el 5b, guardar step5-start y Step 6\n',
    'guides/y.md': 'en el paso 0 se arranca\n', 'agents/tycon-w.md': 'ver step-04-execute (sin extensión)\n',
    // las formas que el pase adversarial encontró escapándose: markdown, barras, sub-paso numérico
    'agents/tycon-m1.md': 'Anotarlo **cierra el 5b** y sigue\n', 'agents/tycon-m2.md': 'Los sub-pasos (0b/0c/5b/7c) también\n',
    'agents/tycon-m3.md': 'en el paso **7c** se prueba\n', 'agents/tycon-m4.md': 'el sub-paso 4.0 escribe la prueba\n',
    'guides/z.md': 'No aplica al Step 5/5b del pipeline\n' };
  // y lo que NO es una mención: un valor del código entre comillas, un color, un nombre con guion
  const limpio = mencionesViejas({ 'agents/tycon-n.md': "--type '5b' y el color #7c3aed y sha-5b0c\n" }, cerrada);
  assert.deepStrictEqual(limpio, [], `marcó como mención algo que no lo es: ${JSON.stringify(limpio)}`);
  const rojo = mencionesViejas(alterado, cerrada);
  for (const r of [ruta, 'guides/x.md', 'agents/tycon-x.md', 'agents/tycon-y.md', 'agents/tycon-z.md', 'guides/y.md', 'agents/tycon-w.md',
    'agents/tycon-m1.md', 'agents/tycon-m2.md', 'agents/tycon-m3.md', 'agents/tycon-m4.md', 'guides/z.md']) {
    assert.ok(rojo.some((f) => f.ruta === r), `${r} no salió rojo: ${JSON.stringify(rojo.map((f) => f.ruta))}`);
  }
  // nombra la línea donde está la mención, no sólo el archivo
  const agregada = rojo.find((f) => f.ruta === ruta);
  assert.match(agregada.texto, /Step 5b/, `la línea nombrada no es la agregada: ${JSON.stringify(agregada)}`);
});

test('Steps_CloseChecks_SameOldKeys @story-8.127 @ac-11 — la tabla del marcador armada desde los frenos del cierre es la de siempre', () => {
  // la de marker.js antes de la 8.127, escrita acá a propósito
  const deSiempre = {
    'approve-plan': ['plan'], implement: ['atdd'], 'run-tests': ['tests'], reviewers: ['advisors'],
    findings: ['waivers', 'findings-close'], 'prepare-commit': ['waivers', 'commit'],
    3: ['plan'], 4: ['atdd', 'tests'], 5: ['advisors'], 7: ['waivers', 'findings-close'], 8: ['waivers', 'commit'],
  };
  const armada = S().closeControlsByStep();
  assert.deepStrictEqual(armada, deSiempre);
  for (const k of ['6', '5b', '7b']) assert.ok(!(k in armada), `sin la clave vieja ${k}`);
  // las claves viejas van a mano en cada fila, no se derivan de `old` de cada paso
  for (const r of S().STEP_CLOSE_CHECKS) assert.ok(Array.isArray(r.oldKeys), `${r.textKey}: oldKeys declaradas`);
});
