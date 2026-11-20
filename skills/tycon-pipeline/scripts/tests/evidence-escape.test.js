'use strict';
/*
 * evidence-escape.test.js —lo que da por buena la evidencia sin verificarla pide la firma de nivel 2 del dueño.
 *
 * Saltear los mutantes (la variable `TYCON_MUTATION_CHECK=off` o la bandera `--no-mutation`) y saltear la revisión de la
 * historia (`TYCON_STORY_REVIEW=0`) piden la firma desde la fecha de corte de la lista única de interruptores
 * (`enforce_from` en scripts/lib/env-switches.json). Hasta esa fecha pasan, avisan y dejan renglón. La fecha se mueve con
 * la `ahora` inyectable de `decidir`, o con una copia temporal del árbol con la lista reescrita: nunca con el reloj ni con
 * una variable de la máquina. Cada caso con su casa de juguete.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/evidence-escape.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const ES = require(path.join(RAIZ, 'scripts', 'lib', 'env-switches.js'));
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const { fakeHomeEnv } = require('./lib/fake-home.js');

const CORTE = ES.corteDe('TYCON_MUTATION_CHECK');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const renglones = (casa) => {
  try { return fs.readFileSync(path.join(stateDir(casa), 'bypass.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
};

/**
 * Una copia del árbol del arnés (sus guiones, sin las pruebas ni el banco) con la fecha de corte de la lista en `fecha`:
 * los guiones de la copia leen su propia lista.
 */
function arbolConCorte(fecha) {
  const dir = tmp('ee-arbol-');
  const fuera = [path.join(RAIZ, 'scripts', 'tests'), path.join(RAIZ, 'scripts', 'controls-bench'), path.join(SCRIPTS, 'tests')];
  const filtro = (src) => !fuera.includes(src) && path.basename(src) !== 'node_modules';
  fs.cpSync(path.join(RAIZ, 'scripts'), path.join(dir, 'scripts'), { recursive: true, filter: filtro });
  fs.cpSync(SCRIPTS, path.join(dir, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: filtro });
  const lista = path.join(dir, 'scripts', 'lib', 'env-switches.json');
  const datos = JSON.parse(fs.readFileSync(lista, 'utf8'));
  for (const e of datos.entradas) if (e.enforce_from) e.enforce_from = fecha;
  fs.writeFileSync(lista, JSON.stringify(datos, null, 1));
  return dir;
}

/** Una casa con la ejecución de la sesión `sid` en «Correr las pruebas», con las pruebas en verde del portón. */
function casaEnPruebas(sid) {
  const casa = tmp('ee-casa-');
  const activos = path.join(stateDir(casa), 'active');
  fs.mkdirSync(activos, { recursive: true });
  const repo = path.join(casa, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-9.9.md'), '---\nstory: "9.9"\nstatus: in-progress\n---\n# Story 9.9\n');
  fs.writeFileSync(path.join(activos, `${sid}.json`), JSON.stringify({
    sessionId: sid, storyId: '9.9', storyPath: path.join(repo, 'specs', 'story-9.9.md'), repoPath: repo, stepScheme: 2,
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'],
    stepsPending: ['run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'],
    checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' },
  }));
  return { casa, repo };
}

function marker(raiz, casa, sid, args) {
  const env = { ...process.env, ...fakeHomeEnv(casa), CLAUDE_CODE_SESSION_ID: sid };
  for (const k of Object.keys(env)) if (/^TYCON_/.test(k)) delete env[k];
  return spawnSync(process.execPath, [path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'marker.js'), ...args], { env, encoding: 'utf8', timeout: 60000 });
}

// El árbol del freno: la herramienta (100), el freno (200) y su consulta (201), como en owner-window.test.js.
const INICIO = 'Tue Oct 27 10:00:00 2026';
const ARBOL = [{ pid: 1, ppid: 0, inicio: INICIO, comando: '/sbin/launchd' },
  { pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' },
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const evento = (command, casa) => ({ session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  tool_input: { command }, permission_mode: 'default', cwd: casa });
const decidir = (command, escapes, ahora, casa) => ow.decidir({ evento: evento(command, casa), escapes, ahora, casa, arbol: ARBOL, pid: 201,
  delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null, comprobar: () => null, lanzarAviso: () => {} });

// T26 NormalRun_NoNewSignatures @story-8.256 @ac-25
// 🔴 Falla con: un comando normal del pipeline, sin variables ni banderas de escape, que pide una firma nueva.
test('T26 NormalRun_NoNewSignatures @story-8.256 @ac-25', () => {
  for (const c of ['node marker.js complete-step run-tests', 'node marker.js complete-step implement',
    'node pipeline.js validators --story specs/story-9.9.md --repo .', 'node marker.js complete-step live-check',
    'node marker.js complete-step "$PASO"', 'node marker.js complete-step run-tests --for-session "$SID"']) {
    assert.deepStrictEqual([...ow.firmasDelComando(c)], [], c);
  }
  // aprobar el plan con la sesión en una variable pide la firma del plan, no la de los mutantes
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js complete-step approve-plan --for-session "$SID" --approved "ok"')], ['plan-approval']);
});

// T16 EscC1_NoticePeriod_BothSides @story-8.256 @ac-11 @ac-15
// 🔴 Falla con: un escape que pide la firma antes de la fecha de corte, o que deja pasar desde ese día; un camino (la
//    variable o la bandera) que se comporta distinto del otro; el período de aviso sin su renglón, o contado por la noche.
test('T16 EscC1_NoticePeriod_BothSides @story-8.256 @ac-11 @ac-15', () => {
  assert.match(CORTE, /^\d{4}-\d{2}-\d{2}$/);
  const antes = Date.parse(`${CORTE}T00:00:00Z`) - 12 * 3600000;
  const dia = Date.parse(`${CORTE}T00:00:01Z`);
  const casos = [
    ['TYCON_MUTATION_CHECK=off node marker.js complete-step run-tests', ['escape:TYCON_MUTATION_CHECK']],
    ['node marker.js complete-step run-tests --no-mutation --reason "refactor sin código nuevo"', []],
  ];
  for (const [cmd, escapes] of casos) {
    const casa = tmp('ee-aviso-');
    const r = decidir(cmd, escapes, antes, casa);
    assert.deepStrictEqual([r.decision, r.via], ['allow', 'aviso'], `${cmd}: ${r.texto}`);
    assert.match(r.texto, new RegExp(`desde ${CORTE} esto pide la firma del dueño`), cmd);
    const l = renglones(casa).filter((x) => x.kind === 'ESCAPE_NOTICE_PERIOD');
    assert.strictEqual(l.length, 1, `${cmd}: ${JSON.stringify(renglones(casa))}`);
    assert.strictEqual(l[0].variable, 'TYCON_MUTATION_CHECK', cmd);
    // el mismo día, el mismo escape: un solo renglón
    decidir(cmd, escapes, antes + 1000, casa);
    assert.strictEqual(renglones(casa).filter((x) => x.kind === 'ESCAPE_NOTICE_PERIOD').length, 1, cmd);
    const d = decidir(cmd, escapes, dia, tmp('ee-corte-'));
    assert.notStrictEqual(d.via, 'aviso', `${cmd}: el día del corte sigue en aviso`);
    assert.ok(['ask', 'deny'].includes(d.decision), `${cmd}: ${d.decision} ${d.texto}`);
  }
  // en Windows, con un escape en aviso y otra firma negada, el texto para el agente no culpa al escape que ya pasó
  const mixto = 'TYCON_MUTATION_CHECK=off node marker.js complete-step approve-plan --approved ok';
  const escMixto = ['escape:TYCON_MUTATION_CHECK'];
  const rm = decidir(mixto, escMixto, antes, tmp('ee-win-'));
  assert.strictEqual(rm.decision, 'deny', rm.texto);
  assert.deepStrictEqual(rm.avisos, escMixto);
  const conAviso = ow.ofreceTrasDecidir(rm, { evento: evento(mixto, '/c'), escapes: escMixto, plataforma: 'win32', gitBash: () => null });
  const sinEscape = ow.ofreceTrasDecidir(rm, { evento: evento(mixto, '/c'), escapes: [], plataforma: 'win32', gitBash: () => null });
  assert.doesNotMatch(conAviso, /un escape no se aprueba en la pestaña/);
  assert.strictEqual(conAviso, sinEscape);
  // la revisión de la noche no cuenta el renglón del aviso: el comando y el del lector ya cuentan ese escape
  const reglas = require(path.join(RAIZ, 'scripts', 'nightly', 'runs-review', 'rules.js'));
  assert.strictEqual(reglas.categoriaDeLinea({ kind: 'ESCAPE_NOTICE_PERIOD', variable: 'TYCON_MUTATION_CHECK' }, '/r'), null);
});

// T12 NoMutation_NeedsReasonAndSignature @story-8.256 @ac-11
// 🔴 Falla con: la bandera sin su firma, sin motivo o en un paso que no corre las pruebas aceptada; antes del corte, sin
//    el renglón con la vía del agente y el motivo; desde el corte, salteada sin la firma.
test('T12 NoMutation_NeedsReasonAndSignature @story-8.256 @ac-11', () => {
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js complete-step run-tests --no-mutation --reason "x"')], ['escape:no-mutation']);
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js complete-step implement --no-mutation --reason x')], ['escape:no-mutation']);
  // un --env-file delante del paso de las pruebas, también con espacios en el nombre del paso (marker.js los recorta)
  const MC = require(path.join(SCRIPTS, 'lib', 'marker-command.js'));
  for (const paso of ['run-tests', '" run-tests"', '"run-tests "']) {
    const c = `node --env-file=.e marker.js complete-step ${paso}`;
    assert.deepStrictEqual(MC.llamadas(c).map((l) => MC.escapeDe(l, 's')), ['TYCON_MUTATION_CHECK'], c);
  }
  const sid = 's-ee-mut';
  // sin motivo, o en un paso sin pruebas: sale 2 antes de pedir nada
  let { casa } = casaEnPruebas(sid);
  let r = marker(RAIZ, casa, sid, ['complete-step', 'run-tests', '--no-mutation']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /--reason/);
  r = marker(RAIZ, casa, sid, ['complete-step', 'reviewers', '--no-mutation', '--reason', 'x']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /pruebas/);
  // en una pestaña sin permisos, `decidir` lo niega sin abrir el cuadro: el guion se iba a negar
  const sinPermisos = ow.decidir({ evento: { ...evento(`node ${path.join(SCRIPTS, 'marker.js')} complete-step run-tests --no-mutation`, casa), permission_mode: 'bypassPermissions', session_id: sid },
    escapes: [], ahora: Date.parse(`${CORTE}T00:00:01Z`), casa, arbol: ARBOL, pid: 201, delegacion: () => ({ ok: false, motivo: 'x' }), clasificar: () => null, lanzarAviso: () => {} });
  assert.strictEqual(sinPermisos.decision, 'deny', sinPermisos.texto);
  assert.ok(!sinPermisos.cuadro, 'no hay cuadro para un pedido que el guion niega');
  // antes del corte: pasa, avisa y anota con la vía del agente y el motivo
  ({ casa } = casaEnPruebas(sid));
  r = marker(arbolConCorte('2099-01-01'), casa, sid, ['complete-step', 'run-tests', '--no-mutation', '--reason', 'refactor sin código nuevo']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /desde 2099-01-01 esto pide la firma de una persona/);
  const b = renglones(casa).filter((x) => x.kind === 'MUTATION_BYPASS');
  assert.deepStrictEqual(b.map((x) => [x.via, x.motivo]), [['agente', 'refactor sin código nuevo']]);
  // desde el corte: sin la firma de la ventana no saltea nada
  ({ casa } = casaEnPruebas(sid));
  r = marker(arbolConCorte('2000-01-01'), casa, sid, ['complete-step', 'run-tests', '--no-mutation', '--reason', 'refactor sin código nuevo']);
  assert.notStrictEqual(r.status, 0, r.stderr);
  assert.strictEqual(renglones(casa).filter((x) => x.kind === 'MUTATION_BYPASS').length, 0);
});

// T19 Docs_NoPersonInProseForEscapes @story-8.256 @ac-18
// 🔴 Falla con: un texto que le dice al modelo que el escape «lo decide la persona» sin nombrar la firma, o que le pide
//    registrar él mismo el salteo de la revisión de la historia.
test('T19 Docs_NoPersonInProseForEscapes @story-8.256 @ac-18', () => {
  const leer = (...p) => fs.readFileSync(path.join(...p), 'utf8');
  const skill = leer(SCRIPTS, '..', 'SKILL.md');
  assert.doesNotMatch(skill, /Escapes \(persona\)/);
  assert.match(skill, /escape:no-mutation/);
  const gate = leer(SCRIPTS, 'lib', 'mutation-gate.js');
  assert.doesNotMatch(gate, /Saltear este chequeo lo decide la persona/);
  assert.match(gate, /escape:no-mutation/);
  const paso = leer(SCRIPTS, '..', 'steps', 'step-02-validate-story.md');
  assert.doesNotMatch(paso, /apagada\s*\(`TYCON_STORY_REVIEW=0`\),\s*registrar el salteo/);
  assert.match(paso, /escape:TYCON_STORY_REVIEW/);
});

// T27 MutationCheckZero_DoesNothing @story-8.256 @ac-26
// 🔴 Falla con: `TYCON_MUTATION_CHECK=0` tomado como apagado (el lector exige `off`).
test('T27 MutationCheckZero_DoesNothing @story-8.256 @ac-26', () => {
  const { runMutationGate } = require(path.join(SCRIPTS, 'lib', 'mutation-gate.js'));
  const entradas = {};
  let llamadas = 0;
  const r = runMutationGate({
    marker: { storyId: '9.9', repoPath: '/tmp/ee-repo', storyPath: 'specs/story-9.9.md' }, opts: [], env: { TYCON_MUTATION_CHECK: '0' },
    appendLog: (f, e) => { (entradas[f] = entradas[f] || []).push(e); }, log: () => {}, destinosDe: () => ['/tmp/ee-repo'],
    invokeCheck: () => { llamadas += 1; return { code: 0, result: { total: 1, killed: 1, survived: [], skipped: [], verdict: 'OK' } }; },
  });
  assert.strictEqual(llamadas, 1, 'el chequeo corre');
  assert.strictEqual(r.invoked, true);
  assert.strictEqual((entradas['bypass.log'] || []).length, 0, JSON.stringify(entradas['bypass.log']));
});
