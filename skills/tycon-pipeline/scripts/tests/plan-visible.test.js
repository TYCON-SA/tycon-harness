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
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
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

// La firma del plan la da el dueño en la ventana de permiso; acá se da por pasada (window-passed.js).
function markerCli(home, sid, cwd, args) {
  return spawnSync('node', [path.join(SCRIPTS, 'marker.js'), ...args], {
    cwd, encoding: 'utf8',
    env: conVentana({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' }),
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
  const paso2 = fs.readFileSync(path.join(STEPS, 'step-03-plan.md'), 'utf8');
  assert.ok(paso2.includes(PLAN), 'el paso 2 dice dónde queda escrito el plan');
  const paso3 = fs.readFileSync(path.join(STEPS, 'step-04-approve-plan.md'), 'utf8');
  assert.match(paso3, /el plan se muestra siempre/i);
  const { computeRiskClass } = require(path.join(SCRIPTS, 'pipeline.js'));
  const { story } = repoConStory();
  const rc = computeRiskClass({ story });
  assert.equal(rc.risk, 'LOW');
  assert.match(rc.note, /se muestra siempre/);
  const paso8 = fs.readFileSync(path.join(STEPS, 'step-11-prepare-commit.md'), 'utf8');
  const pendiente = paso8.split('\n').filter((l) => /^Pendiente tuyo:/.test(l));
  assert.equal(pendiente.length, 1, 'un solo renglón de pendientes en la plantilla del cierre');
  assert.doesNotMatch(pendiente[0], /\bsmoke\b|\bDoD\b|\bADO\b|clocki/);
  assert.match(pendiente[0], /probala andando/);
  // el reloj y el pedido de Azure DevOps van sólo si los hay: en la plantilla, entre llaves, y la regla lo dice
  assert.match(pendiente[0], /\{ · el reloj de horas[^}]*\}/);
  assert.match(pendiente[0], /\{ · el pedido de Azure DevOps[^}]*\}/);
  assert.match(paso8, /Sólo los que aplican: el del reloj si el Arranque avisó el trabajo[^]*si\s+la story tiene `work_item`/);
});

test('Paso8_CierreSinJerga @story-8.64 @ac-2: el cierre no nombra lo que no aplicó, no usa jerga y dice qué sigue en llano', () => {
  const paso8 = fs.readFileSync(path.join(STEPS, 'step-11-prepare-commit.md'), 'utf8');
  const reglas = paso8.slice(paso8.indexOf('**Reglas del cierre:**'), paso8.indexOf('## 🟢 Limpieza del marker file'));
  assert.ok(reglas.length > 40, 'no encontré las «Reglas del cierre»');
  assert.match(reglas, /no corrió porque no aplicaba[^]*no se nombra/);
  const noAplico = reglas.slice(reglas.indexOf('no corrió porque no aplicaba'));
  for (const ejemplo of ['pase adversarial', 'herramienta de horas', 'Azure DevOps']) assert.ok(noAplico.slice(0, 300).includes(ejemplo), `la regla no da el ejemplo ${ejemplo}`);
  for (const palabra of ['«gate»', '«matriz»', '«done»', '«riesgo LOW»', '`/tycon-']) assert.ok(reglas.includes(palabra), `las reglas no prohíben ${palabra}`);
  assert.match(reglas, /mergeala a main/);
});

/** La conversación con registros armados a mano (bloques de texto o llamadas a herramientas). */
function conversacionCruda(home, sid, registros) {
  const dir = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${registros.map((r) => JSON.stringify(r)).join('\n')}\n`);
}
const herramienta = (name, input, extra = {}) => ({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name, input }] } });

test('PlanVisible_FrenoPorSalidaNormal @story-8.65 @ac-1', () => {
  const { repo, home } = conPlanEscrito('s-salida');
  // el caso medido: el agente cree que ya lo mostró, pero ninguno de sus mensajes lo trae
  conversacion(home, 's-salida', ['El cierre sigue bloqueado aunque el plan ya está en mis mensajes.']);
  const r = markerCli(home, 's-salida', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Mostrale esto a la persona/);
  assert.ok(r.stdout.includes('El cambio en README.md: el título nuevo del proyecto.'), `la salida normal trae el plan:\n${r.stdout}`);
  assert.match(r.stdout, /no alcanza/);
  // sin conversación legible, también por la salida normal
  const otro = conPlanEscrito('s-salida-sin');
  const s = markerCli(otro.home, 's-salida-sin', otro.repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(s.status, 1, s.stderr);
  assert.match(s.stdout, /Mostrale esto a la persona/);
  assert.ok(s.stdout.includes('La prueba primero, en rojo'), s.stdout);
});

test('PlanVisible_PreguntaConElPlan_Cuenta @story-8.65 @ac-2', () => {
  const { planEnLaConversacion } = require(path.join(SCRIPTS, 'lib', 'person-ok.js'));
  const home = tmp('plan-vis-home-');
  const pregunta = { questions: [{ question: '¿Apruebo este plan?', header: 'Plan', multiSelect: false,
    options: [{ label: 'Sí, aprobado', description: 'Sigo con las pruebas', preview: PLAN_JUGUETE }, { label: 'No', description: 'Cambio algo' }] }] };
  conversacionCruda(home, 's-preg', [herramienta('AskUserQuestion', pregunta)]);
  assert.equal(planEnLaConversacion(PLAN_JUGUETE, { home, sesion: 's-preg' }).mostrado, true, 'el plan en la vista previa de la pregunta');
  conversacionCruda(home, 's-modo', [herramienta('ExitPlanMode', { plan: PLAN_JUGUETE })]);
  assert.equal(planEnLaConversacion(PLAN_JUGUETE, { home, sesion: 's-modo' }).mostrado, true, 'el plan del modo plan');
  // lo de un subagente no lo ve la persona, ni por herramienta
  conversacionCruda(home, 's-sub', [herramienta('AskUserQuestion', pregunta, { isSidechain: true }), herramienta('ExitPlanMode', { plan: PLAN_JUGUETE }, { isSidechain: true })]);
  assert.equal(planEnLaConversacion(PLAN_JUGUETE, { home, sesion: 's-sub' }).mostrado, false);
  // lo que va dentro de un comentario HTML no se ve en pantalla
  conversacion(home, 's-oculto', [`Sigo con las pruebas.\n<!--\n${PLAN_JUGUETE}\n-->`]);
  assert.equal(planEnLaConversacion(PLAN_JUGUETE, { home, sesion: 's-oculto' }).mostrado, false, 'el plan escondido en un comentario');
  // otra herramienta (un archivo que se escribe) no se muestra
  conversacionCruda(home, 's-write', [herramienta('Write', { file_path: '/x/plan.md', content: PLAN_JUGUETE })]);
  assert.equal(planEnLaConversacion(PLAN_JUGUETE, { home, sesion: 's-write' }).mostrado, false);
});

test('PlanVisible_OkSinPlan_NoAprueba @story-8.65 @ac-3', () => {
  // riesgo bajo, la conversación se lee y el plan no está: el ok no alcanza
  const { repo, home } = conPlanEscrito('s-ok');
  conversacion(home, 's-ok', ['¿Apruebo el plan?']);
  const r = markerCli(home, 's-ok', repo, ['complete-step', '3', '--approved', 'sí, dale, aprobado el plan']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(`${r.stdout}\n${r.stderr}`, /sin ver el plan/);
  assert.match(r.stdout, /Mostrale esto a la persona/);
  assert.equal(paso3Cerrado(home, 's-ok', repo), false);
  const gates = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(gates, /"name":"plan-approval","status":"blocked"[^\n]*ok sin plan a la vista/, 'el freno queda anotado');
  // con el plan en la pregunta, el mismo ok cierra
  const pregunta = { questions: [{ question: `¿Apruebo este plan?\n\n${PLAN_JUGUETE}`, header: 'Plan', multiSelect: false, options: [{ label: 'Sí', description: 'Sigo' }, { label: 'No', description: 'Cambio algo' }] }] };
  conversacionCruda(home, 's-ok', [herramienta('AskUserQuestion', pregunta)]);
  const ok = markerCli(home, 's-ok', repo, ['complete-step', '3', '--approved', 'sí, dale, aprobado el plan']);
  assert.equal(ok.status, 0, ok.stderr);
  // sin conversación legible, la cita alcanza como hoy
  const sin = conPlanEscrito('s-ok-sin');
  const s = markerCli(sin.home, 's-ok-sin', sin.repo, ['complete-step', '3', '--approved', 'sí, dale, aprobado el plan']);
  assert.equal(s.status, 0, s.stderr);
});

test('PlanVisible_InstruccionesLaPreguntaTraeElPlan @story-8.65 @ac-4', () => {
  const paso3 = fs.readFileSync(path.join(STEPS, 'step-04-approve-plan.md'), 'utf8');
  assert.match(paso3, /la pregunta a la persona trae el plan entero/i);
  assert.match(paso3, /con riesgo bajo, `--approved` también comprueba que el plan se vio/i);
});

test('PlanVisible_OkConRiesgoNormal_NoCambia @story-8.65 @ac-3', () => {
  // con riesgo normal el plan se aprueba en el modo plan o en un mensaje: --approved sigue como antes
  const { repo, home } = conPlanEscrito('s-normal');
  const story = path.join(repo, 'specs', 'story-9.92-juguete.md');
  fs.writeFileSync(story, fs.readFileSync(story, 'utf8').replace('  - README.md', '  - README.md\n  - db/001-tabla.sql'));
  const { computeRiskClass } = require(path.join(SCRIPTS, 'pipeline.js'));
  assert.equal(computeRiskClass({ story }).risk, 'NORMAL');
  conversacion(home, 's-normal', ['¿Apruebo el plan?']);
  const r = markerCli(home, 's-normal', repo, ['complete-step', '3', '--approved', 'sí, dale, aprobado el plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Mostrale esto a la persona/);
});

/** La puerta Bash del portón de carril, como la corre Claude Code antes de un comando. */
function puertaBash(home, sid, repo, command) {
  return spawnSync('node', [path.join(SCRIPTS, 'on-bash-write-gate.js')], {
    cwd: repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: sid, tool_name: 'Bash', cwd: repo, tool_input: { command } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0' },
  });
}

test('PlanVisible_ElArnesLoMuestra @story-8.65 @ac-6', () => {
  const cierre = `node ${path.join(SCRIPTS, 'marker.js')} complete-step 3 --auto-approved "LOW: superficie chica" 2>&1 | head -4`;
  // el plan escrito, el paso 3 abierto y la conversación sin el plan: el arnés se lo muestra a la persona
  const { repo, home } = conPlanEscrito('s-arnes');
  conversacion(home, 's-arnes', ['Sigo con la aprobación del plan.']);
  const p = puertaBash(home, 's-arnes', repo, cierre);
  assert.equal(p.status, 0, p.stderr);
  const aviso = JSON.parse(p.stdout).systemMessage;
  assert.match(aviso, /El plan de la historia 9\.92 \(te lo muestra el arnés\): «Plan»/);
  assert.match(aviso, /Tiene 2 pasos\./);
  const gates = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.match(gates, /"name":"plan-shown"[^\n]*"sessionId":"s-arnes"|"sessionId":"s-arnes"[^\n]*"name":"plan-shown"/);
  // con esa constancia, el paso cierra aunque el agente no lo haya escrito
  const r = markerCli(home, 's-arnes', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(paso3Cerrado(home, 's-arnes', repo), true);
  // con el paso cerrado, ya no muestra nada
  assert.equal(puertaBash(home, 's-arnes', repo, cierre).stdout.trim(), '');

  // también antes de un cierre con el ok de la persona (--approved)
  const ok = conPlanEscrito('s-arnes-ok');
  conversacion(ok.home, 's-arnes-ok', ['¿Apruebo el plan?']);
  const pOk = puertaBash(ok.home, 's-arnes-ok', ok.repo, `node ${path.join(SCRIPTS, 'marker.js')} complete-step 3 --approved "sí, dale, aprobado el plan"`);
  assert.match(JSON.parse(pOk.stdout).systemMessage, /te lo muestra el arnés/);
  assert.equal(markerCli(ok.home, 's-arnes-ok', ok.repo, ['complete-step', '3', '--approved', 'sí, dale, aprobado el plan']).status, 0);

  // el plan ya mostrado por el agente: no lo repite
  const ya = conPlanEscrito('s-ya');
  conversacion(ya.home, 's-ya', [PLAN_JUGUETE]);
  assert.equal(puertaBash(ya.home, 's-ya', ya.repo, cierre).stdout.trim(), '');

  // sin conversación legible (otra herramienta): ni aviso ni constancia
  const sin = conPlanEscrito('s-sinlect');
  assert.equal(puertaBash(sin.home, 's-sinlect', sin.repo, cierre).stdout.trim(), '');
  const gSin = path.join(sin.home, '.claude', '.tycon-pipeline', 'gates.log');
  assert.doesNotMatch(fs.existsSync(gSin) ? fs.readFileSync(gSin, 'utf8') : '', /plan-shown/);

  // una constancia de otro plan (el plan cambió después) no cuenta
  const otro = conPlanEscrito('s-otro');
  conversacion(otro.home, 's-otro', ['Sigo.']);
  puertaBash(otro.home, 's-otro', otro.repo, cierre);
  assert.match(fs.readFileSync(path.join(otro.home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8'), /"plan-shown"/, 'la primera pasada dejó la constancia');
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(otro.repo, '9.92', true, path.join(otro.repo, 'specs', 'story-9.92-juguete.md'));
  fs.writeFileSync(path.join(runDir, PLAN), `${PLAN_JUGUETE}3. Un paso nuevo que se agregó después de mostrarlo a la persona.\n`);
  const o = markerCli(otro.home, 's-otro', otro.repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(o.status, 1, o.stderr);
  // un comando que no cierra el paso 3 no muestra nada (tampoco el 30 ni un 3.1)
  const nada = conPlanEscrito('s-nada');
  conversacion(nada.home, 's-nada', ['Sigo.']);
  for (const c of ['git status', 'node marker.js complete-step 30', 'node marker.js complete-step 3.1']) {
    assert.equal(puertaBash(nada.home, 's-nada', nada.repo, c).stdout.trim(), '', c);
  }
  // una constancia de otra sesión o de otra historia no cuenta
  const pd = require(path.join(SCRIPTS, 'lib', 'plan-display.js'));
  const st = path.join(nada.home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(st, { recursive: true });
  const linea = (e) => fs.appendFileSync(path.join(st, 'gates.log'), `${JSON.stringify({ name: 'plan-shown', status: 'ok', sha: pd.huella(PLAN_JUGUETE), ...e })}\n`);
  linea({ sessionId: 'otra-sesion', story: '9.92' });
  linea({ sessionId: 's-nada', story: '9.93' });
  assert.equal(pd.mostradoPorElArnes({ stateDir: st, sessionId: 's-nada', storyId: '9.92', planTxt: PLAN_JUGUETE }), false);
  assert.equal(pd.mostradoPorElArnes({ stateDir: st, sessionId: 'otra-sesion', storyId: '9.92', planTxt: PLAN_JUGUETE }), true);
});

test('PlanVisible_AlEscribirloLoMuestra @story-8.65 @ac-6', () => {
  // la instalación mínima no trae la puerta Bash: el plan se muestra cuando el agente lo escribe con Write o Edit
  const { repo, home } = conPlanEscrito('s-escrito');
  conversacion(home, 's-escrito', ['Escribo el plan en la carpeta de la corrida.']);
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.92', true, path.join(repo, 'specs', 'story-9.92-juguete.md'));
  const despachar = (file_path, tool_name = 'Write') => spawnSync('node', [path.join(SCRIPTS, 'hook-post-edit.js')], {
    cwd: repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-escrito', tool_name, cwd: repo, tool_input: { file_path, content: PLAN_JUGUETE } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-escrito', TYCON_LANE_LLM: '0' },
  });
  // un archivo con el mismo nombre en otra carpeta no es el plan de la corrida
  const ajeno = despachar(path.join(repo, PLAN));
  assert.equal(ajeno.status, 0, ajeno.stderr);
  assert.doesNotMatch(ajeno.stdout, /te lo muestra el arnés/);
  const d = despachar(path.join(runDir, PLAN));
  assert.equal(d.status, 0, d.stderr);
  const salida = JSON.parse(d.stdout);
  assert.match(salida.systemMessage, /El plan de la historia 9\.92 \(te lo muestra el arnés\): «Plan»/);
  assert.ok(salida.systemMessage.includes(path.join(runDir, PLAN)), salida.systemMessage);
  const r = markerCli(home, 's-escrito', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(r.status, 0, r.stderr);
  // con el paso cerrado, otra edición del plan ya no lo muestra
  assert.doesNotMatch(despachar(path.join(runDir, PLAN), 'Edit').stdout, /te lo muestra el arnés/);

  // si otro control ya escribió su salida, el aviso baja a reminder (lo lee sólo el agente) y NO queda constancia
  const otro = conPlanEscrito('s-aparte');
  conversacion(otro.home, 's-aparte', ['Escribo el plan.']);
  const runOtro = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(otro.repo, '9.92', true, path.join(otro.repo, 'specs', 'story-9.92-juguete.md'));
  const escribe = path.join(tmp('plan-vis-aparte-'), 'escribe.js');
  fs.writeFileSync(escribe, "process.stdout.write('salida de otro control\\n');\n");
  const conOtro = spawnSync('node', ['-e', `const d=require(${JSON.stringify(path.join(SCRIPTS, 'dispatch.js'))});d.CHAINS['post-edit'].unshift({name:'aparte',path:${JSON.stringify(escribe)},spawn:true});d.dispatch('post-edit');`], {
    cwd: otro.repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-aparte', tool_name: 'Write', cwd: otro.repo, tool_input: { file_path: path.join(runOtro, PLAN), content: PLAN_JUGUETE } }),
    env: { ...process.env, HOME: otro.home, USERPROFILE: otro.home, CLAUDE_CODE_SESSION_ID: 's-aparte', TYCON_LANE_LLM: '0' },
  });
  assert.equal(conOtro.status, 0, conOtro.stderr);
  assert.match(conOtro.stdout, /salida de otro control[\s\S]*<system-reminder>[\s\S]*te lo muestra el arnés/);
  const gOtro = path.join(otro.home, '.claude', '.tycon-pipeline', 'gates.log');
  assert.doesNotMatch(fs.existsSync(gOtro) ? fs.readFileSync(gOtro, 'utf8') : '', /"plan-shown"/, 'un aviso que no salió no deja constancia');
  const noCierra = markerCli(otro.home, 's-aparte', otro.repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']);
  assert.equal(noCierra.status, 1, noCierra.stderr);
});

test('PlanVisible_ConMaqueta_TambienSeMuestra @story-8.65 @ac-3 @ac-6', () => {
  // una story con pantalla: el paso 3 pide además la maqueta, y el plan se muestra igual (medido: el traspié del plan
  // también pasa con maqueta)
  const { repo, home } = conPlanEscrito('s-maqueta');
  const story = path.join(repo, 'specs', 'story-9.92-juguete.md');
  fs.writeFileSync(story, `${fs.readFileSync(story, 'utf8').replace('  - README.md', '  - src/components/Facturas.tsx')}
## Acceptance Criteria

1. **La pantalla de facturas muestra el total.**

### Tests

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | \`Facturas_MuestraElTotal\` | 1 | unit | una factura | el total en pantalla |
`);
  const mk = require(path.join(SCRIPTS, 'mockup.js'));
  assert.equal(mk.screenStory(story).screen, true, 'la story de juguete tiene pantalla');
  const { mockup } = mk.mockupPaths(story);
  fs.mkdirSync(path.dirname(mockup), { recursive: true });
  const demo = spawnSync('node', [path.join(SCRIPTS, 'mockup.js'), 'demo', '--out', mockup], { cwd: repo, encoding: 'utf8' });
  assert.equal(demo.status, 0, demo.stderr);
  conversacion(home, 's-maqueta', ['Te muestro la maqueta: ' + mockup]);
  const cita = ['--mockup-approved', 'la maqueta está bien, aprobada'];
  // la maqueta aprobada no tapa el plan: un ok sin el plan a la vista no aprueba
  const { computeRiskClass } = require(path.join(SCRIPTS, 'pipeline.js'));
  assert.equal(computeRiskClass({ story }).risk, 'LOW');
  const sinPlan = markerCli(home, 's-maqueta', repo, ['complete-step', '3', '--approved', 'sí, dale, aprobado el plan', ...cita]);
  assert.match(sinPlan.stderr, /sin ver el plan/);
  assert.equal(sinPlan.status, 1, sinPlan.stderr);
  assert.equal(paso3Cerrado(home, 's-maqueta', repo), false);
  // al escribir el plan, el arnés lo muestra, y el paso cierra con la maqueta aprobada
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.92', true, story);
  const d = spawnSync('node', [path.join(SCRIPTS, 'hook-post-edit.js')], {
    cwd: repo, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's-maqueta', tool_name: 'Write', cwd: repo, tool_input: { file_path: path.join(runDir, PLAN), content: PLAN_JUGUETE } }),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-maqueta', TYCON_LANE_LLM: '0' },
  });
  assert.match(JSON.parse(d.stdout).systemMessage, /te lo muestra el arnés/);
  const ok = markerCli(home, 's-maqueta', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica', ...cita]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(paso3Cerrado(home, 's-maqueta', repo), true);
});

test('PlanVisible_AvisoEnTresRenglones: título, cuántos pasos y la ruta absoluta; la constancia, del plan entero', () => {
  // Claude Code antepone su propio rótulo a cada renglón del aviso: un plan de 40 renglones eran 40 avisos repetidos
  const { repo, home } = conPlanEscrito('s-corto');
  const runDir = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(repo, '9.92', true, path.join(repo, 'specs', 'story-9.92-juguete.md'));
  const largo = ['# Plan — 9.92, el título nuevo', '', '## Decisiones', '', '1. Una decisión que no es un paso.', '',
    '## Pasos (en orden; pruebas primero)', '', ...Array.from({ length: 30 }, (_, i) => `${i + 1}. Paso ${i + 1}, con su detalle.`),
    '', '## Riesgos', '', '- Ninguno.', ''].join('\n');
  fs.writeFileSync(path.join(runDir, PLAN), largo);
  conversacion(home, 's-corto', ['Sigo.']);
  const p = puertaBash(home, 's-corto', repo, `node ${path.join(SCRIPTS, 'marker.js')} complete-step 3 --auto-approved "LOW: superficie chica"`);
  assert.equal(p.status, 0, p.stderr);
  const aviso = JSON.parse(p.stdout).systemMessage;
  const renglones = aviso.split('\n');
  assert.ok(renglones.length <= 3, `${renglones.length} renglones:\n${aviso}`);
  assert.match(renglones[0], /«Plan — 9\.92, el título nuevo»/);
  assert.match(aviso, /Tiene 30 pasos\./, 'cuenta los pasos de su sección, no las decisiones');
  assert.ok(path.isAbsolute(path.join(runDir, PLAN)) && aviso.includes(path.join(runDir, PLAN)), aviso);
  assert.doesNotMatch(aviso, /Paso 7, con su detalle/, 'el plan no va entero');
  // la constancia sigue siendo la del plan entero: con ella el paso cierra, y cambiar el plan la invalida
  const pd = require(path.join(SCRIPTS, 'lib', 'plan-display.js'));
  const gates = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8');
  assert.ok(gates.includes(`"sha":"${pd.huella(largo)}"`), gates);
  assert.equal(markerCli(home, 's-corto', repo, ['complete-step', '3', '--auto-approved', 'LOW: superficie chica']).status, 0);

  // sin sección de pasos, cuenta los numerados del plan; sin título, el primer renglón con texto
  const otro = conPlanEscrito('s-corto2');
  const run2 = require(path.join(SCRIPTS, 'pipeline.js')).resolveRunDir(otro.repo, '9.92', true, path.join(otro.repo, 'specs', 'story-9.92-juguete.md'));
  fs.writeFileSync(path.join(run2, PLAN), 'Lo que hago:\n\n1. Uno.\n2. Dos.\n   1. Un subpaso que no cuenta.\n3. Tres.\n');
  conversacion(otro.home, 's-corto2', ['Sigo.']);
  const a2 = JSON.parse(puertaBash(otro.home, 's-corto2', otro.repo, `node ${path.join(SCRIPTS, 'marker.js')} complete-step 3 --auto-approved "LOW"`).stdout).systemMessage;
  assert.ok(a2.split('\n').length <= 3, a2);
  assert.match(a2, /«Lo que hago:»/);
  assert.match(a2, /Tiene 3 pasos\./);
});
