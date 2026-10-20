'use strict';
/**
 * plan-visible.test.js — el plan que se aprueba solo (riesgo bajo) se muestra igual.
 *
 * Lo que no se puede perder:
 *   - `complete-step 3 --auto-approved` no cierra sin el plan escrito en la carpeta de la corrida
 *     (`step-02-bmad-plan.md`), y al cerrar lo imprime para que el agente se lo muestre a la persona tal cual.
 *   - Las instrucciones de los pasos 2 y 3 y la nota de `risk-class` lo dicen; el renglón de pendientes del cierre
 *     (paso 8) está en llano.
 *
 * El marcador corre de verdad contra un HOME temporal y un repo de juguete con git (como approvals.test.js).
 *
 * 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const STEPS = path.join(SCRIPTS, '..', 'steps');
const PLAN = 'step-02-bmad-plan.md';

const tmp = (prefijo) => fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z' };

// Cada repo en su carpeta padre propia: varias detecciones del arnés miran los repos hermanos.
function repoConStory() {
  const repo = path.join(tmp('plan-vis-'), 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.92-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.92"', 'title: "juguete"', 'status: in-progress',
    'files_to_modify:', '  - README.md', '---', '', '# Story 9.92', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { repo, story };
}

function markerCli(home, sid, cwd, args) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' },
  });
}

function hasta3(home, sid, repo, story) {
  const set = markerCli(home, sid, repo, ['set', JSON.stringify({ storyId: '9.92', storyPath: story, repoPath: repo })]);
  assert.equal(set.status, 0, set.stderr);
  for (const n of ['0', '1', '2']) markerCli(home, sid, repo, ['complete-step', n]);
}

const paso3Cerrado = (home, sid, repo) => {
  const g = markerCli(home, sid, repo, ['get']);
  const m = JSON.parse(g.stdout);
  return (m.stepsCompleted || []).map(String).includes('3');
};

test('PlanVisible_SinPlan_NoSeApruebaSolo @story-8.62 @ac-7', () => {
  const { repo, story } = repoConStory();
  const home = tmp('plan-vis-home-');
  hasta3(home, 's-sin', repo, story);
  const r = markerCli(home, 's-sin', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, new RegExp(PLAN.replace(/\./g, '\\.')));
  assert.match(r.stderr, /escrib/i, 'dice que primero se escribe el plan');
  assert.equal(paso3Cerrado(home, 's-sin', repo), false, 'el paso 3 sigue abierto');
  // un plan vacío tampoco alcanza
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.92', true, story);
  fs.writeFileSync(path.join(runDir, PLAN), '  \n');
  const v = markerCli(home, 's-sin', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(v.status, 0, v.stdout);
});

/** La conversación de la sesión como la guarda Claude Code: un renglón JSON por mensaje, en ~/.claude/projects/<x>/<sid>.jsonl. */
function conversacion(home, sid, textos) {
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const lineas = textos.map((text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${lineas.join('\n')}\n`);
}

const PLAN_JUGUETE = '# Plan\n\n1. La prueba primero, en rojo, en tests/readme.test.js.\n2. El cambio en README.md: el título nuevo del proyecto.\n';

function conPlanEscrito(sid) {
  const { repo, story } = repoConStory();
  const home = tmp('plan-vis-home-');
  hasta3(home, sid, repo, story);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.92', true, story);
  fs.writeFileSync(path.join(runDir, PLAN), PLAN_JUGUETE);
  return { repo, home };
}

test('PlanVisible_ConPlanMostrado_SeApruebaSolo @story-8.62 @ac-8', () => {
  const { repo, home } = conPlanEscrito('s-con');
  // el agente se lo mostró a la persona en su respuesta (con otro formato: negritas, sin el número)
  conversacion(home, 's-con', ['Voy con el plan.', `El plan se aprobó solo (riesgo bajo):\n\n- **La prueba primero, en rojo, en tests/readme.test.js.**\n- El cambio en README.md: el título nuevo del proyecto.`]);
  const r = markerCli(home, 's-con', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(paso3Cerrado(home, 's-con', repo), true);
});

test('PlanVisible_PlanNoMostrado_NoSeApruebaSolo @story-8.62 @ac-8', () => {
  const { repo, home } = conPlanEscrito('s-nomostro');
  // la conversación se lee, pero el plan no está en ninguna respuesta (el caso medido)
  conversacion(home, 's-nomostro', ['Escribo el plan en la carpeta de la corrida.', 'Task 1 listo: los archivos no existen.']);
  const r = markerCli(home, 's-nomostro', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /mensaje con el plan TAL CUAL/);
  // dice qué ve la persona: medido, el agente creía que la salida del comando contaba
  assert.match(r.stderr, /no ve la salida de este comando, ni el archivo del plan, ni lo que pensaste/);
  assert.ok(r.stderr.includes('El cambio en README.md'), `trae el plan para mostrarlo:\n${r.stderr}`);
  assert.equal(paso3Cerrado(home, 's-nomostro', repo), false);
  // el plan en un mensaje de un subagente (la persona no lo ve) tampoco cuenta
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.writeFileSync(path.join(dir, 's-nomostro.jsonl'), `${JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: PLAN_JUGUETE }] } })}\n`);
  const sub = markerCli(home, 's-nomostro', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(sub.status, 0, sub.stdout);
});

test('PlanVisible_PlanSinTexto_NoSeApruebaSolo @story-8.62 @ac-8', () => {
  // un plan hecho sólo de símbolos no se puede «ver»: no se aprueba solo
  const { repo, home } = conPlanEscrito('s-simbolos');
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.92', true, path.join(repo, 'specs', 'story-9.92-juguete.md'));
  fs.writeFileSync(path.join(runDir, PLAN), '***\n> \n#\n');
  conversacion(home, 's-simbolos', ['Sigo.']);
  const r = markerCli(home, 's-simbolos', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(paso3Cerrado(home, 's-simbolos', repo), false);
  // un plan de dos letras aparece en cualquier conversación: tampoco cuenta como visto
  fs.writeFileSync(path.join(runDir, PLAN), 'ok\n');
  conversacion(home, 's-simbolos', ['ok, sigo con las pruebas.']);
  const corto = markerCli(home, 's-simbolos', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(corto.status, 0, corto.stdout);
});

test('PlanVisible_SinConversacion_PreguntaALaPersona @story-8.62 @ac-8', () => {
  // sin conversación que leer (Codex, u otra herramienta que no la deja en disco): falla cerrado, se le pregunta a la persona
  const { repo, home } = conPlanEscrito('s-sinconv');
  const r = markerCli(home, 's-sinconv', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /no puedo leer la conversación/);
  assert.match(r.stderr, /--approved/);
  assert.equal(paso3Cerrado(home, 's-sinconv', repo), false);
  // con la aprobación de la persona, cierra
  const ok = markerCli(home, 's-sinconv', repo, ['complete-step', '3', '--approved', 'dale, aprobado']);
  assert.equal(ok.status, 0, ok.stderr);
});

test('PlanVisible_InstruccionesLoDicen @story-8.62 @ac-9 @ac-10', () => {
  const paso2 = fs.readFileSync(path.join(STEPS, 'step-02-invoke-bmad.md'), 'utf8');
  assert.ok(paso2.includes(PLAN), 'el paso 2 dice dónde queda escrito el plan');
  const paso3 = fs.readFileSync(path.join(STEPS, 'step-03-hitl-plan.md'), 'utf8');
  assert.match(paso3, /el plan se muestra siempre/i);
  const { computeRiskClass } = require(path.join(SCRIPTS, 'pipeline.js'));
  const { story } = repoConStory();
  const rc = computeRiskClass({ story });
  assert.equal(rc.risk, 'LOW');
  assert.match(rc.note, /se muestra siempre/);
  const paso8 = fs.readFileSync(path.join(STEPS, 'step-08-commit-prep.md'), 'utf8');
  const pendiente = paso8.split('\n').filter((l) => /^Pendiente tuyo:/.test(l));
  assert.equal(pendiente.length, 1, 'un solo renglón de pendientes en la plantilla del cierre');
  assert.doesNotMatch(pendiente[0], /\bsmoke\b|\bDoD\b|\bADO\b|clocki/);
  assert.match(pendiente[0], /probala andando/);
  // el reloj y el pedido de Azure DevOps van sólo si los hay: en la plantilla, entre llaves, y la regla lo dice
  assert.match(pendiente[0], /\{ · el reloj de Clockify[^}]*\}/);
  assert.match(pendiente[0], /\{ · el pedido de Azure DevOps[^}]*\}/);
  assert.match(paso8, /Sólo los que aplican: el del reloj si hay un timer de Clockify abierto[^]*si\s+la story tiene `ado_work_item`/);
});

test('Paso8_CierreSinJerga @story-8.64 @ac-2: el cierre no nombra lo que no aplicó, no usa jerga y dice qué sigue en llano', () => {
  const paso8 = fs.readFileSync(path.join(STEPS, 'step-08-commit-prep.md'), 'utf8');
  const reglas = paso8.slice(paso8.indexOf('**Reglas del cierre:**'), paso8.indexOf('## 🟢 Limpieza del marker file'));
  assert.ok(reglas.length > 40, 'no encontré las «Reglas del cierre»');
  assert.match(reglas, /no corrió porque no aplicaba[^]*no se nombra/);
  const noAplico = reglas.slice(reglas.indexOf('no corrió porque no aplicaba'));
  for (const ejemplo of ['pase adversarial', 'Clockify', 'Azure DevOps']) assert.ok(noAplico.slice(0, 300).includes(ejemplo), `la regla no da el ejemplo ${ejemplo}`);
  for (const palabra of ['«gate»', '«matriz»', '«done»', '«riesgo LOW»', '`/tycon-']) assert.ok(reglas.includes(palabra), `las reglas no prohíben ${palabra}`);
  assert.match(reglas, /mergeala a main/);
});
