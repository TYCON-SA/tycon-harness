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
  const c = E.correr('marker.js', ['clear'], 's-t24');
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
