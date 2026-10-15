#!/usr/bin/env node
'use strict';
// steps-names.test.js — los pasos del pipeline con nombre llano (story 7.23, tanda A).
//
// Lo que ve el dueño nombra cada paso por su nombre en castellano, sin número: el `step_name` de `pipeline.js next`,
// los títulos de los `steps/*.md` y los textos de los hooks. Los comandos y las rutas siguen con el número de hoy, y el
// marcador no cambia de forma (eso es la tanda B).
//
// Corre los comandos reales con un HOME temporal (el skill enlazado en ~/.claude/agent-skills, como en una máquina) y el
// id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/steps-names.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const SKILL = path.join(SCRIPTS, '..');
const RAIZ = path.join(SKILL, '..', '..');

// La tabla de la tanda A, escrita acá a propósito: es la de la story, no la del código que se prueba.
const ESPERADOS = {
  0: 'Arranque',
  '0b': 'Arranque: reloj de Clockify',
  '0c': 'Arranque: pedido en ADO',
  1: 'Validar la story',
  2: 'Armar el plan',
  3: 'Aprobar el plan',
  4: 'Implementar y correr las pruebas',
  5: 'Revisores',
  '5b': 'Pase adversarial',
  6: 'Hallazgos: el informe',
  7: 'Hallazgos: la decisión',
  '7b': 'Revisores, otra vuelta',
  '7c': 'Probar en vivo',
  8: 'Preparar el commit',
  9: 'Cerrar en ADO',
};

// Un paso nombrado por su número: «Step 5», «step 4», «steps 1-2», «paso 8», «sub-paso 4.0», «5b», «7c»…
const POR_NUMERO = /\bsteps? ?\d|\bsub-?pasos? ?\d|\bpasos? \d|\b(?:0b|0c|5b|7b|7c)\b/i;

// Lo que tipea la máquina queda fuera: código entre comillas invertidas, rutas de archivos de paso, comandos con su
// número, banderas y variables, y las líneas que son un comando para copiar.
function prosa(texto) {
  return String(texto)
    .split('\n')
    .filter((l) => !/^\s*(?:node|bash|export)\s/.test(l))
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/[\w./~-]*step-\d\d[a-z]?-[\w-]+(?:\.md)?/g, ' ')
    .replace(/\b(?:complete-step|start-step|snapshot-iter)\s+\S+/g, ' ')
    .replace(/--[a-z][\w-]*(?:\s+\S+)?/g, ' ')
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, ' ');
}
const sinNumero = (texto, donde) => {
  const p = prosa(texto);
  const m = p.match(POR_NUMERO);
  assert.ok(!m, `${donde} nombra un paso por su número («${m && p.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\s+/g, ' ')}»)`);
};

// ── Un HOME temporal con el skill enlazado y una story en un repo de git ─────────────────────────────────────────────
function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-names-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  // fechas fijas y sin el mantenimiento automático de git: el sha sale siempre igual y nada corre de fondo
  // mientras la prueba mira el repo (guides/test-execution-discipline.md)
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-nombres.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.9"', 'title: "nombres"', 'status: ready-for-dev', 'ado_work_item: 123',
    'files_to_modify:', '  - src/a.js', '---', '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '' });
  const correr = (script, args, sid, input) => spawnSync('node', [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid), input: input === undefined ? '' : input,
  });
  const activo = (sid) => path.join(home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  return { base, home, repo, story, correr, activo };
}

const ORDEN = ['0', '0b', '0c', '1', '2', '3', '4', '5', '5b', '6', '7', '7c', '8'];
const BANDERA = { '0b': 'clockiStarted', '0c': 'adoMarkedActive', '5b': 'deepReviewDone', '7c': 'dodRuntimeChecked' };

test('T1 Display_PlainNamesOnly — lo que ve el dueño nombra cada paso por su nombre llano, sin número', () => {
  // la tabla
  const S = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  assert.deepStrictEqual(Object.fromEntries(S.STEPS.map((s) => [s.id, s.name])), Object.fromEntries(Object.entries(ESPERADOS).map(([k, v]) => [String(k), v])));
  for (const s of S.STEPS) {
    assert.strictEqual(S.stepName(s.id), s.name);
    assert.strictEqual(S.stepName(Number.isNaN(Number(s.id)) ? s.id : Number(s.id)), s.name, `stepName acepta el número suelto del marcador (${s.id})`);
  }
  assert.strictEqual(S.stepName('zz'), null, 'un id que no existe: null, no un nombre inventado');
  assert.strictEqual(S.stepNames([5, '5b', 8]), 'Revisores, Pase adversarial, Preparar el commit');
  assert.strictEqual(S.stepNames([3, 'zz']), 'Aprobar el plan, «zz»', 'un id desconocido se muestra tal cual, marcado');
  assert.strictEqual(S.stepNames(undefined), '', 'sin lista: vacío, sin romper');
  assert.strictEqual(S.stepNames('5'), '', 'algo que no es lista: vacío, sin romper');

  // los títulos de los quince archivos de paso
  const archivos = fs.readdirSync(path.join(SKILL, 'steps')).filter((f) => f.endsWith('.md'));
  assert.strictEqual(archivos.length, 15, 'quince archivos de paso');
  for (const f of archivos) {
    const fila = S.STEPS.find((s) => s.file === f);
    assert.ok(fila, `${f} tiene su fila en lib/steps.js`);
    assert.strictEqual(fs.readFileSync(path.join(SKILL, 'steps', f), 'utf8').split('\n')[0], `# ${fila.name}`, `título de ${f}`);
  }

  // `next` en cada paso de la secuencia: `step_name` y el `note` sin número (comandos y rutas, con número)
  const E = entorno();
  const sid = 's-next';
  const r0 = E.correr('pipeline.js', ['start', '--story', E.story, '--repo', E.repo, '--brief'], sid);
  assert.strictEqual(r0.status, 0, r0.stderr + r0.stdout);
  const start = JSON.parse(r0.stdout);
  assert.strictEqual(start.ready, true, r0.stdout);
  sinNumero(start.next, 'el «next» de start');
  const base = JSON.parse(fs.readFileSync(E.activo(sid), 'utf8'));
  for (let i = 1; i < ORDEN.length; i++) {
    const hechos = ORDEN.slice(0, i);
    const m = { ...base, stepsCompleted: hechos.filter((id) => /^\d$/.test(id)).map(Number), stepsPending: ORDEN.slice(i).filter((id) => /^\d$/.test(id)).map(Number) };
    for (const [id, flag] of Object.entries(BANDERA)) m[flag] = hechos.includes(id);
    fs.writeFileSync(E.activo(sid), JSON.stringify(m));
    const r = E.correr('pipeline.js', ['next'], sid);
    assert.strictEqual(r.status, 0, r.stderr);
    const n = JSON.parse(r.stdout);
    assert.strictEqual(n.next_step, ORDEN[i], `next_step sigue con el número de hoy (${ORDEN[i]})`);
    assert.strictEqual(n.step_name, ESPERADOS[ORDEN[i]], `step_name del paso ${ORDEN[i]}`);
    assert.ok(n.note.includes(ESPERADOS[ORDEN[i]]), `el note nombra el paso: ${n.note}`);
    sinNumero(n.note, `el note del paso ${ORDEN[i]}`);
    for (const s of n.steps) assert.strictEqual(s.name, ESPERADOS[s.step], `steps[].name del paso ${s.step}`);
  }
  const fin = { ...base, stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7, 8], stepsPending: [] };
  for (const flag of Object.values(BANDERA)) fin[flag] = true;
  fs.writeFileSync(E.activo(sid), JSON.stringify(fin));
  const nf = JSON.parse(E.correr('pipeline.js', ['next'], sid).stdout);
  assert.strictEqual(nf.step_name, null);
  sinNumero(nf.note, 'el note sin pasos pendientes');

  // los hooks que le hablan al dueño
  const salida = (r) => r.stdout + r.stderr;
  //   on-prompt: «listo» con los revisores pendientes
  const sidStop = 's-stop';
  fs.writeFileSync(E.activo(sidStop), JSON.stringify({ ...base, sessionId: sidStop, stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5, 6, 7, 8] }));
  const stop = salida(E.correr('on-prompt.js', [], sidStop, JSON.stringify({ prompt: 'listo, ya está', session_id: sidStop })));
  assert.match(stop, /STOP-detect/);
  assert.match(stop, /Revisores/);
  sinNumero(stop, 'on-prompt (cierre con pasos pendientes)');
  //   on-prompt: pedido de story sin corrida, y la misma story abierta en otra sesión
  const intent = salida(E.correr('on-prompt.js', [], 's-intent', JSON.stringify({ prompt: 'implementemos la story 8.8', session_id: 's-intent' })));
  assert.match(intent, /INTENT-detect/);
  sinNumero(intent, 'on-prompt (pedido de story)');
  const cruce = salida(E.correr('on-prompt.js', [], 's-otra', JSON.stringify({ prompt: 'implementemos la story 9.9', session_id: 's-otra' })));
  assert.match(cruce, /CROSS-SESSION/);
  sinNumero(cruce, 'on-prompt (story abierta en otra sesión)');
  //   on-edit: un archivo de una story, sin corrida
  const edit = salida(E.correr('on-edit.js', [], 's-edit', JSON.stringify({ tool_name: 'Edit', session_id: 's-edit', tool_input: { file_path: path.join(E.repo, 'src', 'a.js') } })));
  assert.match(edit, /EDIT-detect/);
  sinNumero(edit, 'on-edit (archivo de una story sin corrida)');
  //   el portón de carril y el freno de pruebas primero
  const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const plan = gate.blockMessage({ action: 'block', kind: 'plan', reason: 'x' }, { filePath: path.join(E.repo, 'src', 'a.js'), repoRoot: E.repo, marker: base });
  assert.match(plan, /Aprobar el plan/);
  sinNumero(plan, 'el portón de carril (plan pendiente)');
  sinNumero(gate.blockMessage({ action: 'block', kind: 'no-lane', reason: 'x' }, { filePath: path.join(E.repo, 'src', 'a.js'), repoRoot: E.repo }), 'el portón de carril (sin carril)');
  sinNumero(gate.computeStoryGate({ filePath: path.join(E.repo, 'src', 'a.js'), repoRoot: E.repo, marker: base, adhoc: null, isHarness: false }).reason || '', 'el motivo del portón');
  const atdd = require(path.join(SCRIPTS, 'lib', 'atdd-preedit.js'));
  sinNumero(atdd.preEditBlockMessage({ filePath: path.join(E.repo, 'src', 'a.js'), storyId: '9.9', storyPath: E.story }), 'el freno de pruebas primero');

  //   los hooks cuyo texto no se puede disparar sin un repo entero (el pre-commit, el Stop-hook, los portones): cada
  //   texto literal que escriben, fuera de los comentarios
  for (const h of ['on-pre-commit.js', 'on-stop-dod-gate.js', 'on-story-gate.js', 'on-atdd-preedit.js', 'on-prompt.js', 'on-edit.js']) {
    const literales = fs.readFileSync(path.join(SCRIPTS, h), 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .flatMap((l) => l.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g) || [])
      .map((s) => s.slice(1, -1).replace(/\$\{[^}]*\}/g, ' '));
    for (const lit of literales) sinNumero(lit, `un texto de ${h}`);
  }
});

test('T3 TandaA_MarkerAndHooksUnchanged — el marcador y las decisiones de los hooks, iguales que hoy', () => {
  const E = entorno();
  const sid = 's-forma';
  const r = E.correr('pipeline.js', ['start', '--story', E.story, '--repo', E.repo, '--brief'], sid);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const m = JSON.parse(fs.readFileSync(E.activo(sid), 'utf8'));
  // las claves de hoy (medidas el 2026-10-15 con `start` sobre el código anterior a la tanda A), y ni una más
  assert.deepStrictEqual(Object.keys(m).sort(), [
    'autonomous', 'baseSha', 'checks', 'evidenceDir', 'fileEvents', 'filesTouched', 'filesTouchedAt', 'iter', 'iterations',
    'lastFailures', 'lastTouch', 'noProgressStreak', 'repoPath', 'sessionId', 'sprint', 'startedAt', 'stepTimings',
    'stepsCompleted', 'stepsPending', 'storyId', 'storyPath',
  ]);
  assert.strictEqual(m.stepScheme, undefined, 'sin stepScheme: eso es la tanda B');
  assert.deepStrictEqual(m.stepsCompleted, [0]);
  assert.deepStrictEqual(m.stepsPending, [1, 2, 3, 4, 5, 6, 7, 8], 'los pendientes, por número como hoy');

  // el portón de carril: plan pendiente frena; plan aprobado deja pasar
  const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const archivo = path.join(E.repo, 'src', 'a.js');
  const conPlan = gate.computeStoryGate({ filePath: archivo, repoRoot: E.repo, marker: m, adhoc: null, isHarness: false });
  assert.strictEqual(conPlan.action, 'block');
  assert.strictEqual(conPlan.kind, 'plan');
  const aprobado = gate.computeStoryGate({ filePath: archivo, repoRoot: E.repo, marker: { ...m, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8] }, adhoc: null, isHarness: false });
  assert.strictEqual(aprobado.action, 'pass');

  // el freno de pruebas primero: sin pruebas tocadas frena; con una prueba tocada, o el 4 cerrado, deja pasar
  const atdd = require(path.join(SCRIPTS, 'lib', 'atdd-preedit.js'));
  const pre = { filePath: archivo, repoPath: E.repo, storyHasTests: atdd.storyDeclaresTests(fs.readFileSync(E.story, 'utf8')), stepsCompleted: [0, 1, 2, 3] };
  assert.strictEqual(pre.storyHasTests, true);
  assert.strictEqual(atdd.computeAtddPreEdit({ ...pre, priorPaths: [] }).action, 'block');
  assert.strictEqual(atdd.computeAtddPreEdit({ ...pre, priorPaths: [path.join(E.repo, 'tests', 'a.test.js')] }).action, 'pass');
  assert.strictEqual(atdd.computeAtddPreEdit({ ...pre, priorPaths: [], stepsCompleted: [0, 1, 2, 3, 4] }).action, 'pass');

  // el aviso de pasos pendientes: con «listo» avisa; sin palabras de cierre, calla
  fs.writeFileSync(E.activo(sid), JSON.stringify({ ...m, stepsCompleted: [0, 1, 2, 3, 4], stepsPending: [5, 6, 7, 8] }));
  const avisa = E.correr('on-prompt.js', [], sid, JSON.stringify({ prompt: 'listo', session_id: sid }));
  assert.match(avisa.stdout, /STOP-detect/);
  const calla = E.correr('on-prompt.js', [], sid, JSON.stringify({ prompt: 'seguí con lo que sigue', session_id: sid }));
  assert.doesNotMatch(calla.stdout, /STOP-detect/);
});
