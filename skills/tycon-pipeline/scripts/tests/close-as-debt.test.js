#!/usr/bin/env node
'use strict';
// close-as-debt.test.js — una historia que terminó por su salida prevista («si no se puede, queda como deuda») se cierra
// con `marker.js close-as-debt --reason <texto> --debt <DEF-id>`: el marcador recibe `cierre = deuda` y la ejecución
// sigue hasta el commit. La deuda tiene que estar anotada en la historia o en `tasks/todo.md`. `expect-red` registra un
// control en rojo como esperado, sólo en una ejecución en deuda. La frase de la persona la pide el freno de seguridad
// (ESC-C4, en safety-escape.test.js): acá se corren los comandos directo.
//
// Corre los comandos reales con un HOME temporal y el id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/close-as-debt.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

function entorno({ todo = null, enHistoria = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'close-as-debt-'));
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
  const story = path.join(repo, 'specs', 'story-9.9-deuda.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.9"', 'title: "deuda"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---', '# Story 9.9', '',
    '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', '',
    ...(enHistoria ? ['- Deuda: DEF-9.9-angular — la librería no tiene versión compatible', ''] : []),
  ].join('\n'));
  if (todo !== null) {
    fs.mkdirSync(path.join(repo, 'tasks'));
    fs.writeFileSync(path.join(repo, 'tasks', 'todo.md'), todo);
  }
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '',
  });
  const correr = (script, args, sid) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid), input: '', cwd: repo,
  });
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const activo = (sid) => path.join(dir(), 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const escribir = (sid, m) => fs.writeFileSync(activo(sid), JSON.stringify(m));
  // lo que deja el freno de seguridad cuando la persona dijo «autorizo cerrar como deuda» (ESC-C4); el arranque, antes
  const arrancar = (sid, { autorizada = true, via = 'persona' } = {}) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    if (autorizada) {
      require(path.join(RAIZ, 'scripts', 'lib', 'guard-record.js')).anotar({ freno: 'safety-guard', regla: 'ESC-C4', veredicto: 'escape', cmd: 'x',
        home, via, sesion: sid, escape: 'cerrar-como-deuda' });
    }
  };
  return { home, repo, story, correr, leer, escribir, activo, arrancar, dir };
}

const CERRAR = ['close-as-debt', '--reason', 'la librería no tiene versión compatible', '--debt', 'DEF-9.9-angular'];

test('T20 CloseAsDebt_DondeViveLaDeuda @story-8.93 @ac-10 — la deuda está en la historia o en tasks/todo.md; si no, dice dónde', () => {
  // en la historia, sin tasks/todo.md
  let E = entorno({ enHistoria: true });
  E.arrancar('s-t20a');
  let r = E.correr('marker.js', CERRAR, 's-t20a');
  assert.strictEqual(r.status, 0, r.stderr);
  // sólo en tasks/todo.md
  E = entorno({ todo: '# Pendientes\n\n- [ ] [DEF-9.9-angular] subir angular cuando haya versión\n' });
  E.arrancar('s-t20b');
  r = E.correr('marker.js', CERRAR, 's-t20b');
  assert.strictEqual(r.status, 0, r.stderr);
  // en ninguno: sale 2 y dice dónde anotarla
  E = entorno({ todo: '# Pendientes\n' });
  E.arrancar('s-t20c');
  r = E.correr('marker.js', CERRAR, 's-t20c');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /DEF-9\.9-angular/);
  assert.match(r.stderr, /Dev Agent Record/);
  assert.match(r.stderr, /tasks\/todo\.md/);
  assert.strictEqual(E.leer('s-t20c').cierre, undefined, 'no escribió nada');
  // sin motivo o sin deuda: sale 2
  assert.strictEqual(E.correr('marker.js', ['close-as-debt', '--debt', 'DEF-9.9-angular'], 's-t20c').status, 2);
  assert.strictEqual(E.correr('marker.js', ['close-as-debt', '--reason', 'x'], 's-t20c').status, 2);
  // un pedazo de un id anotado, o una letra suelta, no es la deuda
  const T = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  T.arrancar('s-t20d');
  for (const corto of ['DEF-9.9', 'DEF-9.9-ang', 'a', 'e']) {
    assert.strictEqual(T.correr('marker.js', ['close-as-debt', '--reason', 'x', '--debt', corto], 's-t20d').status, 2, corto);
  }
  assert.strictEqual(T.leer('s-t20d').cierre, undefined);
});

test('T21 CloseAsDebt_EscribeCierreYSigue @story-8.93 @ac-10 — el cierre es deuda y la ejecución sigue abierta', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t21');
  const antes = E.leer('s-t21');
  const r = E.correr('marker.js', CERRAR, 's-t21');
  assert.strictEqual(r.status, 0, r.stderr);
  const m = E.leer('s-t21');
  assert.strictEqual(m.cierre.estado, 'deuda');
  assert.strictEqual(m.cierre.motivo, 'la librería no tiene versión compatible');
  assert.strictEqual(m.cierre.deuda, 'DEF-9.9-angular');
  assert.ok(m.cierre.via && m.cierre.at, JSON.stringify(m.cierre));
  assert.deepStrictEqual(m.stepsPending, antes.stepsPending, 'los pasos que faltan siguen pendientes');
  assert.ok(fs.existsSync(E.activo('s-t21')), 'no archivó: la ejecución sigue hasta el commit');
  assert.match(r.stdout, /sigue hasta el commit/);
  assert.strictEqual(m.cierre.via, 'persona');
  // sin la constancia del freno (la llamada no pasó por él): no cierra
  const sin = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  sin.arrancar('s-t21b', { autorizada: false });
  const n = sin.correr('marker.js', CERRAR, 's-t21b');
  assert.strictEqual(n.status, 2, n.stderr);
  assert.match(n.stderr, /ventana de permiso/);
  assert.doesNotMatch(n.stderr, /autorizo/, 'el aviso no enseña la frase');
  assert.strictEqual(sin.leer('s-t21b').cierre, undefined);
  // aprobada en la ventana de permiso: cierra, y anota esa vía
  const ven = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  ven.arrancar('s-t21c', { via: 'ventana' });
  const v = ven.correr('marker.js', CERRAR, 's-t21c');
  assert.strictEqual(v.status, 0, v.stderr);
  assert.strictEqual(ven.leer('s-t21c').cierre.via, 'ventana');
});

test('T22 ExpectRed_SoloEnDeuda @story-8.93 @ac-11 — un rojo esperado se registra sólo en una ejecución en deuda', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t22');
  E.escribir('s-t22', { ...E.leer('s-t22'), checks: { tests: 'red:exit=1' }, checksProvenance: { tests: 'test-gate' } });
  const sin = E.correr('marker.js', ['expect-red', 'tests', '--tests', 'T2,T5'], 's-t22');
  assert.strictEqual(sin.status, 2, sin.stderr);
  assert.match(sin.stderr, /close-as-debt/);
  assert.strictEqual(E.leer('s-t22').checks.tests, 'red:exit=1', 'sin deuda no cambia');
  assert.strictEqual(E.correr('marker.js', CERRAR, 's-t22').status, 0);
  const con = E.correr('marker.js', ['expect-red', 'tests', '--tests', 'T2,T5'], 's-t22');
  assert.strictEqual(con.status, 0, con.stderr);
  const m = E.leer('s-t22');
  assert.strictEqual(m.checks.tests, 'rojo-esperado:exit=1');
  assert.deepStrictEqual(m.expectedRed.tests.tests, ['T2', 'T5']);
  // sin la lista de pruebas, o sobre un control que no está en rojo: sale 2
  assert.strictEqual(E.correr('marker.js', ['expect-red', 'tests'], 's-t22').status, 2);
  E.escribir('s-t22', { ...E.leer('s-t22'), checks: { ...E.leer('s-t22').checks, build: 'green' } });
  assert.strictEqual(E.correr('marker.js', ['expect-red', 'build', '--tests', 'T1'], 's-t22').status, 2);
});

test('T23 RojoEsperado_LoAceptanSoloEnDeuda @story-8.93 @ac-11 — el cierre del turno y prepare-commit lo aceptan sólo con deuda; ESC-C3 sigue', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t23');
  const base = { ...E.leer('s-t23'), autonomous: true, checks: { tests: 'rojo-esperado:exit=1', build: 'green' }, expectedRed: { tests: { tests: ['T2'] } } };
  const deuda = { estado: 'deuda', motivo: 'sin versión compatible', deuda: 'DEF-9.9-angular', via: 'persona', at: '2026-10-22T20:00:00Z' };
  const stop = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'on-stop-dod-gate.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: 's-t23' }), env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '' },
  });
  // el cierre del turno: frena sin deuda, deja pasar con ella
  E.escribir('s-t23', base);
  assert.match(stop().stdout, /"decision":"block"/, 'sin deuda, el rojo esperado es un rojo');
  E.escribir('s-t23', { ...base, cierre: deuda });
  assert.doesNotMatch(stop().stdout, /"decision":"block"/, 'con deuda, deja cerrar el turno');
  // prepare-commit: frena sin deuda y lo dice; con deuda, lo acepta diciéndolo
  E.escribir('s-t23', base);
  let r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t23');
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /rojo-esperado.*sin una ejecución en deuda/);
  E.escribir('s-t23', { ...base, cierre: deuda });
  r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t23');
  assert.doesNotMatch(r.stderr, /sin una ejecución en deuda/, r.stderr);
  assert.match(r.stderr, /aceptado por la deuda DEF-9\.9-angular/);
  // `next` dice lo mismo que los frenos: en deuda, el rojo esperado no es una condición sin cumplir
  const listo = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'live-check'];
  const precond = (m) => {
    E.escribir('s-t23', { ...m, stepScheme: 2, stepsCompleted: listo, stepsPending: ['prepare-commit'], dodRuntimeChecked: true, deepReviewDone: true });
    const n = JSON.parse(E.correr('pipeline.js', ['next'], 's-t23').stdout);
    assert.strictEqual(n.next_step, 'prepare-commit', JSON.stringify(n).slice(0, 400));
    return (n.preconditions || []).find((p) => p.id === 'check-tests');
  };
  assert.strictEqual(precond({ ...base, cierre: deuda }).satisfied, true, 'con deuda');
  assert.strictEqual(precond(base).satisfied, false, 'sin deuda');
  // ESC-C3 mira los controles que empiezan con «red»: el rojo esperado no la abre; un red:exit=1 sí, aun en deuda
  const rc = require(path.join(SCRIPTS, 'lib', 'run-close.js'));
  assert.strictEqual(rc.abierta(rc.estado({ checks: { tests: 'rojo-esperado:exit=1' }, stepsPending: [] })), false);
  assert.strictEqual(rc.abierta(rc.estado({ checks: { tests: 'red:exit=1' }, cierre: deuda, stepsPending: [] })), true);
});

test('T23b RojoComun_FrenaPrepareCommitSinDeuda — un control en rojo frena el commit y nombra las dos salidas; con deuda, pasa diciéndolo', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t23b');
  const base = { ...E.leer('s-t23b'), checks: { tests: 'red:exit=1', build: 'green' } };
  const deuda = { estado: 'deuda', motivo: 'siete rojas de main', deuda: 'DEF-9.9-angular', via: 'persona', at: '2026-10-22T20:00:00Z' };
  E.escribir('s-t23b', base);
  let r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t23b');
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /tests=red:exit=1/);
  assert.match(r.stderr, /close-as-debt/);
  assert.doesNotMatch(r.stderr, /autorizo/, 'el aviso no le dicta la frase al agente');
  E.escribir('s-t23b', { ...base, cierre: deuda });
  r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t23b');
  assert.doesNotMatch(r.stderr, /tests=red:exit=1 sin una ejecución en deuda/, r.stderr);
  assert.match(r.stderr, /tests: red:exit=1 — aceptado por la deuda DEF-9\.9-angular/);
});

test('T24 Deuda_LlegaAlCommit @story-8.93 @ac-12 — la línea Deuda: sale al preparar el commit y el volcado dice deuda', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t24');
  assert.strictEqual(E.correr('marker.js', CERRAR, 's-t24').status, 0);
  // la ejecución en deuda recorre los pasos que siguen: los revisores sobre lo que sí cambió, el pase, el commit
  const m = E.leer('s-t24');
  const hechos = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'live-check'];
  E.escribir('s-t24', { ...m, stepsCompleted: hechos, stepsPending: ['prepare-commit'], checks: { tests: 'green', advisors: 'green' } });
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t24');
  assert.match(r.stderr, /Deuda: DEF-9\.9-angular — la librería no tiene versión compatible/);
  assert.strictEqual(E.leer('s-t24').cierre.estado, 'deuda', 'preparar el commit no toca el cierre');
  // `clear` conserva el cierre escrito: el volcado dice deuda, nunca completa
  const c = E.correr('marker.js', ['clear', '--discard'], 's-t24');
  assert.strictEqual(c.status, 0, c.stderr);
  const hist = path.join(E.dir(), 'timing-history');
  const volcados = fs.readdirSync(hist).filter((f) => /^9\.9-[\dT-]+\.json$/.test(f));
  assert.strictEqual(volcados.length, 1, volcados.join(', '));
  const v = JSON.parse(fs.readFileSync(path.join(hist, volcados[0]), 'utf8'));
  assert.strictEqual(v.marker.cierre.estado, 'deuda');
  assert.strictEqual(v.marker.cierre.deuda, 'DEF-9.9-angular');
});

test('T25 Pasos_NombranCloseAsDebt @story-8.93 @ac-13 — implementar y el SKILL nombran la salida; ningún paso ofrece apagar el lazo o clear', () => {
  const SKILL = path.join(SCRIPTS, '..');
  const leer = (f) => fs.readFileSync(path.join(SKILL, f), 'utf8');
  for (const f of ['steps/step-05-implement.md', 'SKILL.md']) assert.match(leer(f), /close-as-debt/, `${f} nombra close-as-debt`);
  // un párrafo que habla de una historia que no se pudo terminar y manda a cerrar con `clear` nombra antes la deuda
  const fracaso = /(no puede implementar|build roto|no se pudo|no se puede terminar|salida prevista)/i;
  for (const f of ['SKILL.md', ...fs.readdirSync(path.join(SKILL, 'steps')).filter((x) => x.endsWith('.md')).map((x) => path.join('steps', x))]) {
    for (const parrafo of leer(f).split(/\n\s*\n/)) {
      if (fracaso.test(parrafo) && /marker\.js clear/.test(parrafo)) assert.match(parrafo, /close-as-debt/, `${f}: cierra con clear una historia que no se pudo, sin la deuda`);
    }
  }
  for (const f of fs.readdirSync(path.join(SKILL, 'steps')).filter((x) => x.endsWith('.md'))) {
    const t = leer(path.join('steps', f));
    assert.doesNotMatch(t, /set-autonomous false[^\n]*(salida|si no se puede|para cerrar)/i, `${f} ofrece apagar el lazo como salida`);
    assert.doesNotMatch(t, /(si no se puede|salida prevista)[^\n]*marker\.js clear/i, `${f} ofrece clear como salida`);
  }
});

test('T23c RojoDePruebas_DiceQueFallaYQueSeArregla — el aviso nombra las pruebas que fallan, manda a arreglarlas y no dicta la frase', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t23c');
  E.escribir('s-t23c', { ...E.leer('s-t23c'), checks: { tests: 'red:exit=1', build: 'green' }, checksProvenance: { tests: 'test-gate' } });
  fs.mkdirSync(path.join(E.repo, '.advisors'), { recursive: true });
  fs.writeFileSync(path.join(E.repo, '.advisors', 'tests-result.json'), JSON.stringify({
    suite_green: false, totals: { failed: 2, failures: ['cobro.test.js', 'alta.test.js'] },
  }));
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t23c');
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /cobro\.test\.js/, 'nombra lo que falla');
  assert.match(r.stderr, /alta\.test\.js/);
  assert.match(r.stderr, /arregl/i, 'dice que se arregla');
  assert.match(r.stderr, /test-gate\.sh/, 'y cómo se vuelve a medir');
  assert.doesNotMatch(r.stderr, /autorizo/);
  // sin el informe, el aviso igual sale y no inventa nombres
  fs.rmSync(path.join(E.repo, '.advisors', 'tests-result.json'));
  const sin = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-t23c');
  assert.strictEqual(sin.status, 1, sin.stderr);
  assert.match(sin.stderr, /tests=red:exit=1/);
  assert.doesNotMatch(sin.stderr, /cobro\.test\.js/);
});

test('T23d VerdeParcial_DiceQueFaltaYNoDictaLaFrase — un verde de pruebas que no salió de la suite completa manda a correr el gate, sin la frase', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t23d');
  E.escribir('s-t23d', { ...E.leer('s-t23d'), checks: { tests: 'green' }, checksProvenance: { tests: 'run-check' } });
  const r = E.correr('marker.js', ['complete-step', 'run-tests', '--out-of-order'], 's-t23d');
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /no salió de la suite completa/);
  assert.match(r.stderr, /test-gate\.sh/);
  assert.match(r.stderr, /guides\/safety-guard\.md/, 'si la persona pregunta cómo seguir, la guía');
  assert.doesNotMatch(r.stderr, /autorizo/, 'el aviso no le dicta la frase al agente');
});

test('T23e CompleteStepConForceManual_DiceDondeVa — el flag de declarar a mano va en set-check: complete-step lo dice y no cierra nada', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-t23e');
  const antes = E.leer('s-t23e');
  const r = E.correr('marker.js', ['complete-step', 'run-tests', '--force-manual'], 's-t23e');
  assert.notStrictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /set-check/, 'dice dónde va el flag');
  assert.match(r.stderr, /set-check tests green --force-manual/, 'con el control de pruebas de ejemplo');
  assert.doesNotMatch(r.stderr, /autorizo/, 'no le dicta la frase al agente');
  assert.deepStrictEqual(E.leer('s-t23e').stepsPending, antes.stepsPending, 'no cerró el paso');
});

// ── El último paso revisa lo cambiado (8.195) ──────────────────────────────────────────────────────────────────

const HASTA_EL_ULTIMO = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check'];
const REVISORES = '2026-01-01T10:00:00.000Z';
const DESPUES = (min) => `2026-01-01T10:${String(min).padStart(2, '0')}:00.000Z`;

/** Una ejecución lista para «Preparar el commit», con los revisores cerrados a las 10:00 y los cambios que se le pasan. */
function listaParaElUltimo(E, sid, { cambios = [], timings = {}, extra = {} } = {}) {
  E.arrancar(sid, { autorizada: false });
  E.escribir(sid, {
    ...E.leer(sid), stepScheme: 2, stepsCompleted: HASTA_EL_ULTIMO, stepsPending: ['prepare-commit'],
    checks: { tests: 'green', advisors: 'green' }, dodRuntimeChecked: true, deepReviewDone: true,
    stepTimings: { reviewers: { completedAt: REVISORES, rounds: 1 }, findings: { completedAt: DESPUES(1) }, ...timings },
    fileEvents: cambios.map((c, i) => ({ path: path.join(E.repo, c), ts: DESPUES(5 + i), code: true })),
    // los otros frenos del último paso, atendidos: el pase salteado por el portón y los hallazgos escritos
    adversarialSkip: { motivo: 'riesgo bajo', at: DESPUES(1) },
    ...extra,
  });
  const w = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', E.story, '--findings', '-'], {
    encoding: 'utf8', input: '[]', cwd: E.repo,
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(w.status, 0, w.stderr);
}
const PANTALLAS = ['HistorialConsulta.tsx', 'MisConsultas.tsx', 'GestionConsultasScreen.tsx', 'RevisionScreen.tsx']
  .map((f) => `acme-Consultas/src/components/consultas/${f}`);

test('T1 UltimoPaso_CodigoDespuesDeRevisores_Niega @story-8.195 @ac-1 — con código cambiado después de los revisores, el último paso no cierra', () => {
  const E = entorno();
  listaParaElUltimo(E, 's-8195-t1', { cambios: ['src/a.js'] });
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t1');
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /cambió código después de los revisores: src\/a\.js\./);
  assert.match(r.stderr, /Corré los revisores sobre lo cambiado \(`pipeline\.js next` dice cómo\) y volvé a cerrar/);
  assert.deepStrictEqual(E.leer('s-8195-t1').stepsPending, ['prepare-commit'], 'el paso sigue pendiente');
});

test('T2 UltimoPaso_CasoReal_NombraLasCuatroPantallas @story-8.195 @ac-2 — el caso real nombra las cuatro; con más de cinco, «y N más»', () => {
  const E = entorno();
  listaParaElUltimo(E, 's-8195-t2', { cambios: PANTALLAS });
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t2');
  assert.strictEqual(r.status, 2, r.stderr);
  for (const p of PANTALLAS) assert.ok(r.stderr.includes(p), `nombra ${p}: ${r.stderr}`);
  const siete = entorno();
  listaParaElUltimo(siete, 's-8195-t2b', { cambios: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `src/${x}.js`) });
  const r7 = siete.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t2b');
  assert.strictEqual(r7.status, 2, r7.stderr);
  assert.match(r7.stderr, /src\/e\.js y 2 más\./);
  assert.doesNotMatch(r7.stderr, /src\/f\.js/);
});

test('T1b UltimoPaso_ConHallazgosAbierto_Niega @story-8.195 @ac-1 — con «Hallazgos» sin cerrar, el código cambiado después de los revisores también frena', () => {
  // lo cazó el pase adversarial: sin «Hallazgos» cerrado, la regla de `next` no pide otra vuelta, y el último paso cerraba
  const E = entorno();
  const sid = 's-8195-t1b';
  listaParaElUltimo(E, sid, { cambios: ['src/a.js'] });
  E.escribir(sid, { ...E.leer(sid), stepsCompleted: HASTA_EL_ULTIMO.filter((s) => s !== 'findings'), stepsPending: ['findings', 'prepare-commit'] });
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], sid);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /cambió código después de los revisores: src\/a\.js\./);
});

test('T5b UltimoPaso_SoloPruebasOTextos_NoFrenaPorCodigo @story-8.195 @ac-5 @ac-6 — con sólo pruebas o textos cambiados, el último paso decide como sin cambios', () => {
  const C = entorno();
  listaParaElUltimo(C, 's-8195-t5c');
  const control = C.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t5c');
  const frenos = (s) => s.split('\n').filter((l) => /BLOQUEADO/.test(l)).map((l) => l.replace(/\/\S+/g, '<ruta>'));
  for (const [nombre, cambios] of [['pruebas', ['src/a.test.js', 'tests/b.js']], ['textos', ['docs/guia.md', 'config.json']]]) {
    const E = entorno();
    const sid = `s-8195-t5b-${nombre}`;
    // con la marca en verdadero (como la dejaba un arnés de antes): decide la regla, no la marca
    listaParaElUltimo(E, sid, { cambios });
    const r = E.correr('marker.js', ['complete-step', 'prepare-commit'], sid);
    assert.doesNotMatch(r.stderr, /cambió código después de los revisores/, `${nombre}: ${r.stderr}`);
    assert.strictEqual(r.status, control.status, nombre);
    assert.deepStrictEqual(frenos(r.stderr), frenos(control.stderr), nombre);
  }
});

test('T3 UltimoPaso_RevisoresDeNuevo_Cierra @story-8.195 @ac-3 — con los revisores cerrados otra vez después del cambio, cierra como hoy', () => {
  // «como hoy»: lo mismo que una ejecución igual sin el cambio (los demás frenos del último paso siguen, igual)
  const E = entorno();
  listaParaElUltimo(E, 's-8195-t3', { cambios: ['src/a.js'], timings: { reviewers: { completedAt: REVISORES, lastCompletedAt: DESPUES(30), rounds: 2 } } });
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t3');
  assert.doesNotMatch(r.stderr, /cambió código después de los revisores/, r.stderr);
  const C = entorno();
  listaParaElUltimo(C, 's-8195-t3c');
  const control = C.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t3c');
  assert.strictEqual(r.status, control.status, `${r.stderr}\n---\n${control.stderr}`);
  const frenos = (s) => s.split('\n').filter((l) => /BLOQUEADO/.test(l)).map((l) => l.replace(/\/\S+/g, '<ruta>'));
  assert.deepStrictEqual(frenos(r.stderr), frenos(control.stderr));
});

test('T4 Next_CambioDespuesDelUltimoPaso_PideRevisoresYElUltimoPaso @story-8.195 @ac-4 — el caso de Gustavo: revisores, el último paso otra vez, y recién ahí cerrar', () => {
  const E = entorno();
  const sid = 's-8195-t4';
  listaParaElUltimo(E, sid, { cambios: ['src/a.js'], timings: { 'prepare-commit': { completedAt: DESPUES(3) } } });
  E.escribir(sid, { ...E.leer(sid), stepsCompleted: [...HASTA_EL_ULTIMO, 'prepare-commit'], stepsPending: [] });
  const next = () => JSON.parse(E.correr('pipeline.js', ['next'], sid).stdout);
  let n = next();
  assert.strictEqual(n.next_step, 'reviewers', JSON.stringify(n).slice(0, 300));
  assert.match(n.note, /src\/a\.js/, 'nombra lo que falta revisar');
  // los revisores vuelven a cerrar después del último paso: el último paso se pide otra vez
  const m = E.leer(sid);
  E.escribir(sid, { ...m, stepTimings: { ...m.stepTimings, reviewers: { ...m.stepTimings.reviewers, lastCompletedAt: DESPUES(30), rounds: 2 } } });
  n = next();
  assert.strictEqual(n.next_step, 'prepare-commit', JSON.stringify(n).slice(0, 300));
  assert.match(n.note, /lo preparado ya no es lo revisado/);
  // cerrarlo otra vez pasa por el mismo camino que la primera vez (los mismos frenos y, al pasarlos, la foto del código)
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit'], sid);
  assert.doesNotMatch(r.stderr, /cambió código después de los revisores/, r.stderr);
  const C = entorno();
  listaParaElUltimo(C, 's-8195-t4c');
  const control = C.correr('marker.js', ['complete-step', 'prepare-commit'], 's-8195-t4c');
  assert.strictEqual(r.status, control.status, `${r.stderr}\n---\n${control.stderr}`);
  // cerrado otra vez, después de los revisores: recién ahí se cierra la ejecución
  const cerrado = E.leer(sid);
  E.escribir(sid, { ...cerrado, stepTimings: { ...cerrado.stepTimings, 'prepare-commit': { completedAt: DESPUES(40) } } });
  n = next();
  assert.strictEqual(n.next_step, null, JSON.stringify(n).slice(0, 300));
  assert.match(n.note, /cerrá con marker\.js clear/);
});

test('T13 BorradoPorConsola_Y_AppendFile_LlevanLaMarca @story-8.195 @ac-13 — el borrado por consola, append-file y la regla que falla dejan su marca', () => {
  const E = entorno();
  const sid = 's-8195-t13';
  listaParaElUltimo(E, sid);
  const prueba = path.join(E.repo, 'src', 'a.test.js');
  const codigo = path.join(E.repo, 'src', 'b.js');
  // append-file
  for (const f of [prueba, codigo]) assert.strictEqual(E.correr('marker.js', ['append-file', f], sid).status, 0);
  let ev = E.leer(sid).fileEvents;
  assert.strictEqual(ev.find((e) => e.path === prueba).code, false);
  assert.strictEqual(ev.find((e) => e.path === codigo).code, true);
  // el borrado por consola (`git rm`), como lo anota el freno
  const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
  const borradaPrueba = path.join(E.repo, 'src', 'c.test.js');
  const borradoCodigo = path.join(E.repo, 'src', 'c.js');
  bash.anotarBorradosDeLaStory({ stateDir: E.dir(), sessionId: sid, marker: E.leer(sid), rutas: [borradaPrueba, borradoCodigo], via: 'git rm' });
  ev = E.leer(sid).fileEvents;
  assert.strictEqual(ev.find((e) => e.path === borradaPrueba).code, false);
  assert.strictEqual(ev.find((e) => e.path === borradoCodigo).code, true);
  // una edición por el editor con la regla que lanza: marca code (ante la duda, se revisa)
  const preload = path.join(E.repo, '..', 'lanza.js');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'reloop-code.js'))}).pideOtraVuelta = () => { throw new Error('regla rota'); };\n`);
  const raro = path.join(E.repo, 'src', 'd.js');
  const r = spawnSync(process.execPath, ['--require', preload, path.join(SCRIPTS, 'on-edit.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: sid, tool_name: 'Edit', tool_input: { file_path: raro } }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer(sid).fileEvents.find((e) => e.path === raro).code, true);
  // el cartel y next deciden lo mismo con estos eventos: lo escrito en otraVuelta es reviewersRound
  const T = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const m = E.leer(sid);
  assert.deepStrictEqual(m.otraVuelta, T.reviewersRound(m));
  assert.deepStrictEqual(m.otraVuelta.archivos, ['src/b.js', 'src/c.js', 'src/d.js']);
  // si el cálculo de la vuelta falla, el campo viejo no queda: el cartel vuelve a su regla de antes (y queda el rastro)
  const vieja = { round: 2, archivos: ['src/viejo.js'], desde: '2026-01-01T10:59:00.000Z' };
  const rompeVuelta = path.join(E.repo, '..', 'rompe-vuelta.js');
  fs.writeFileSync(rompeVuelta, `require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'steps.js'))}).otraVueltaDe = () => { throw new Error('vuelta rota'); };\n`);
  E.escribir(sid, { ...E.leer(sid), otraVuelta: vieja });
  const r2 = spawnSync(process.execPath, ['--require', rompeVuelta, path.join(SCRIPTS, 'on-edit.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: sid, tool_name: 'Edit', tool_input: { file_path: path.join(E.repo, 'src', 'e.js') } }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual('otraVuelta' in E.leer(sid), false, 'on-edit: el campo viejo se borra');
  assert.match(fs.readFileSync(path.join(E.dir(), 'hook-errors.log'), 'utf8'), /on-edit otraVuelta: Error: vuelta rota/);
  E.escribir(sid, { ...E.leer(sid), otraVuelta: vieja });
  const pasos = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const original = pasos.otraVueltaDe;
  pasos.otraVueltaDe = () => { throw new Error('vuelta rota'); };
  try {
    require(path.join(SCRIPTS, 'on-bash-write-gate.js')).anotarBorradosDeLaStory({ stateDir: E.dir(), sessionId: sid, marker: E.leer(sid), rutas: [path.join(E.repo, 'src', 'f.js')], via: 'git rm' });
  } finally { pasos.otraVueltaDe = original; }
  assert.strictEqual('otraVuelta' in E.leer(sid), false, 'el borrado por consola: el campo viejo se borra');
});

test('T15 UltimoPaso_MarcadorIlegible_NiegaComoHoy @story-8.195 @ac-15 — con el marcador roto, el último paso niega con el motivo de hoy', () => {
  const E = entorno();
  const sid = 's-8195-t15';
  listaParaElUltimo(E, sid, { cambios: ['src/a.js'] });
  fs.writeFileSync(E.activo(sid), '{ roto');
  const r = E.correr('marker.js', ['complete-step', 'prepare-commit'], sid);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /no hay marker activo para esta sesión/, 'el motivo de hoy');
  assert.doesNotMatch(r.stderr, /no hay nada que revisar/);
  assert.doesNotMatch(r.stderr, /cambió código después de los revisores/, 'no decide sin leer el marcador');
});

test('T30 OtraVuelta_SeEscribeEnElMarcador @story-8.195 @ac-30 — cada cambio deja otraVuelta igual a reviewersRound; recortado conserva lo suyo; otra story lo borra', () => {
  const E = entorno();
  const sid = 's-8195-t30';
  const T = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  listaParaElUltimo(E, sid);
  const igual = (que) => { const m = E.leer(sid); assert.deepStrictEqual(m.otraVuelta, T.reviewersRound(m), que); return m.otraVuelta; };
  // una edición por el editor
  const a = path.join(E.repo, 'src', 'a.js');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-edit.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: sid, tool_name: 'Edit', tool_input: { file_path: a } }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, CLAUDE_CODE_SESSION_ID: sid, TYCON_HOME: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(igual('la edición').archivos, ['src/a.js']);
  // un borrado por consola y append-file
  require(path.join(SCRIPTS, 'on-bash-write-gate.js')).anotarBorradosDeLaStory({ stateDir: E.dir(), sessionId: sid, marker: E.leer(sid), rutas: [path.join(E.repo, 'src', 'z.js')], via: 'git rm' });
  igual('el borrado');
  assert.strictEqual(E.correr('marker.js', ['append-file', path.join(E.repo, 'src', 'y.js')], sid).status, 0);
  const desde = igual('append-file').desde;
  // los eventos recortados: el campo conserva sus archivos y su desde
  const m = E.leer(sid);
  E.escribir(sid, { ...m, fileEvents: m.fileEvents.slice(-1) });
  assert.strictEqual(E.correr('marker.js', ['append-file', path.join(E.repo, 'docs', 'nota.md')], sid).status, 0);
  const recortado = E.leer(sid).otraVuelta;
  assert.deepStrictEqual(recortado.archivos, ['src/a.js', 'src/z.js', 'src/y.js']);
  assert.strictEqual(recortado.desde, desde);
  // un complete-step: con los revisores cerrados otra vez, el cierre recalcula el campo y queda en null
  const conVuelta = E.leer(sid);
  const despues = new Date(Math.max(...conVuelta.fileEvents.map((e) => Date.parse(e.ts))) + 1000).toISOString();
  E.escribir(sid, { ...conVuelta, stepTimings: { ...conVuelta.stepTimings, reviewers: { completedAt: REVISORES, lastCompletedAt: despues, rounds: 2 } } });
  const cierre = E.correr('marker.js', ['complete-step', 'plan', '--out-of-order'], sid);
  assert.strictEqual(cierre.status, 0, cierre.stderr);
  assert.strictEqual(E.leer(sid).otraVuelta, null, 'cerraron los revisores: no queda otra vuelta');
  // otra story: el reinicio borra el campo
  E.escribir(sid, { ...E.leer(sid), otraVuelta: { round: 2, archivos: ['src/a.js'], desde } });
  const otra = E.correr('marker.js', ['set', JSON.stringify({ storyId: '9.10', storyPath: E.story, repoPath: E.repo }), '--replace'], sid);
  assert.strictEqual(otra.status, 0, otra.stderr);
  assert.strictEqual(E.leer(sid).otraVuelta, undefined, 'la otra story no hereda la vuelta');
});

// ───────────── Una corrida sin turno no cuenta como prueba roja ─────────────

const SIN_TURNO = { tests: 'sin-turno', build: 'green' };
const PROV = { tests: 'test-gate', build: 'run-check' };
const DEUDA = { estado: 'deuda', motivo: 'x', deuda: 'DEF-9.9-angular', via: 'persona', at: '2026-10-22T20:00:00Z' };
const frenaSinLlamarloRojo = (r, quien) => {
  assert.strictEqual(r.status, 1, `${quien}: ${r.stderr}`);
  assert.match(r.stderr, /turno/, quien);
  assert.doesNotMatch(r.stderr, /en rojo|Arreglalas/, quien);
};

test('T10 8.215-SinTurno_CompleteStep_FrenaSinLlamarloRojo @story-8.215 @ac-10', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-st10');
  const base = { ...E.leer('s-st10'), checks: SIN_TURNO, checksProvenance: PROV };
  E.escribir('s-st10', base);
  frenaSinLlamarloRojo(E.correr('marker.js', ['complete-step', 'run-tests', '--out-of-order'], 's-st10'), 'run-tests');
  E.escribir('s-st10', base);
  frenaSinLlamarloRojo(E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-st10'), 'prepare-commit');
  // `next`: la precondición de las pruebas queda sin cumplir y lo nombra
  const listo = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'live-check'];
  E.escribir('s-st10', { ...base, stepScheme: 2, stepsCompleted: listo, stepsPending: ['prepare-commit'], dodRuntimeChecked: true, deepReviewDone: true });
  const n = JSON.parse(E.correr('pipeline.js', ['next'], 's-st10').stdout);
  const p = (n.preconditions || []).find((x) => x.id === 'check-tests');
  assert.ok(p, JSON.stringify(n).slice(0, 400));
  assert.strictEqual(p.satisfied, false);
  assert.match(p.detail, /turno/);
});

test('T19 8.215-Stop_SinTurno_DejaParar @story-8.215 @ac-14', () => {
  const E = entorno();
  E.arrancar('s-st19');
  const stop = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'on-stop-dod-gate.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: 's-st19' }), env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '' },
  });
  E.escribir('s-st19', { ...E.leer('s-st19'), autonomous: true, iter: 0, checks: SIN_TURNO, checksProvenance: PROV });
  const r = stop();
  assert.doesNotMatch(r.stdout, /"decision":"block"/, `con sin-turno deja parar: ${r.stdout}`);
  assert.match(`${r.stdout}${r.stderr}`, /turno/, 'lo dice en una línea');
  const m = E.leer('s-st19');
  assert.strictEqual(m.iter || 0, 0, 'no suma una vuelta');
  assert.notStrictEqual(m.needs_human, true, 'no escala a una persona');
  // un rojo de verdad sigue frenando
  E.escribir('s-st19', { ...m, checks: { tests: 'red:exit=1', build: 'green' } });
  assert.match(stop().stdout, /"decision":"block"/);
});

test('T22 8.215-PrepareCommit_SinTurnoDespuesDeRunTests_Frena @story-8.215 @ac-10', () => {
  const E = entorno({ todo: '- [ ] [DEF-9.9-angular] subir angular\n' });
  E.arrancar('s-st22');
  // «Correr las pruebas» ya cerrado, y después el portón salió sin turno
  const hecho = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests'];
  const base = { ...E.leer('s-st22'), stepScheme: 2, stepsCompleted: hecho, checks: SIN_TURNO, checksProvenance: PROV };
  for (const [quien, m] of [['sin deuda', base], ['en deuda', { ...base, cierre: DEUDA }]]) {
    E.escribir('s-st22', m);
    frenaSinLlamarloRojo(E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-st22'), quien);
  }
});
