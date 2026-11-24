#!/usr/bin/env node
'use strict';
// stable-data: las horas son las del reloj de quien corre: los renglones y los marcadores se escriben y se leen en el momento.
/**
 * autonomous-close.test.js — el cierre del turno de una corrida autónoma con la matriz roja sólo por criterios que esperan
 * la exención de la persona (on-stop-dod-gate.js). La pista le dice al agente que pida la exención corriendo él
 * `marker.js runtime-waiver`, que deja el renglón en la lista del dueño con su cuadro (owner-window.js); y salir del modo
 * autónomo, o esperar a la persona, deja cerrar el turno pero no saltea la matriz en «Preparar el pull request».
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const sl = require(path.join(RAIZ, 'scripts', 'lib', 'signature-list.js'));
const { APPROVERS } = require(path.join(RAIZ, 'scripts', 'lib', 'approver.js'));

const CRITERIO = 'el aviso queda en el servicio externo';
const RAZON = 'el servicio externo no tiene ambiente de prueba';

/** Una casa y un repo de juguete con una historia cuyo criterio 1 está declarado imposible de probar en vivo. */
function entorno(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-close-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  // la lista de firmas del dueño, prendida en esta máquina
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: 'on' } }));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.93-cierre.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.93"', 'title: "cierre"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js',
    'runtime_not_verifiable:', '  - ac: 1', `    reason: "${RAZON}"`, '    covered_by: T1', '---', '', '# Story 9.93', '',
    '## Acceptance Criteria', '', `1. **Given** un pedido **Then** ${CRITERIO}.`, '', '### Tests', '',
    '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Aviso_QuedaRegistrado` | 1 | unit | x | y |', '', '## Dev Agent Record', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  // las pruebas de la historia, en verde: el criterio queda esperando sólo la exención
  fs.mkdirSync(path.join(repo, '.advisors'));
  fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'), JSON.stringify({ ts: new Date().toISOString(), story_id: '9.93', suite_green: true }));
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', NODE_TEST_CONTEXT: '',
  });
  const correr = (script, args, sid) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: env(sid), input: '', cwd: repo });
  const dir = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const activo = (sid) => path.join(dir(), 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  const escribir = (sid, m) => fs.writeFileSync(activo(sid), JSON.stringify(m));
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  const stop = (sid) => spawnSync(process.execPath, [path.join(SCRIPTS, 'on-stop-dod-gate.js')], {
    encoding: 'utf8', input: JSON.stringify({ session_id: sid }), env: env(sid),
  });
  return { home, repo, story, env, correr, leer, escribir, arrancar, stop };
}

// La matriz roja sólo por el criterio que espera la exención, y nada más en rojo.
const SOLO_MATRIZ = { acmatrix: 'red:exit=1', build: 'green' };

// 🔴 mutación: volver a «lo aprueba él desde su terminal» manda la firma por donde no deja renglón ni cuadro.
test('CierreAutonomo_MatrizRoja_PistaPorElCuadro (T12) @story-8.274 @ac-15 @ac-16', (t) => {
  const E = entorno(t);
  E.arrancar('s-a');
  E.escribir('s-a', { ...E.leer('s-a'), autonomous: true, iter: 0, checks: SOLO_MATRIZ });
  const r = E.stop('s-a');
  assert.match(r.stdout, /"decision":"block"/, r.stdout + r.stderr);
  const reason = JSON.parse(r.stdout).reason;
  assert.doesNotMatch(reason, /desde su terminal/);
  assert.match(reason, /lista de firmas de la persona/);
  const cmd = (/`([^`]*runtime-waiver[^`]*)`/.exec(reason) || [])[1];
  assert.ok(cmd, `la pista trae el comando: ${reason}`);
  assert.ok(cmd.includes(E.story), 'con la historia de la corrida');
  // el agente lo corre como dice la pista, en una pestaña donde la ventana de permiso no llega a nadie
  const ahora = Date.now();
  const evento = { session_id: 's-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, permission_mode: 'bypassPermissions', cwd: E.repo };
  const inicio = 'Tue Oct 27 10:00:00 2026';
  const arbol = [{ pid: 1, ppid: 0, inicio, comando: '/sbin/launchd' },
    { pid: 100, ppid: 1, inicio, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' },
    { pid: 200, ppid: 100, inicio, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
    { pid: 201, ppid: 200, inicio, comando: 'node /h/scripts/lib/owner-window.js gate' }];
  const d = ow.decidir({ evento, escapes: [], arbol, pid: 201, casa: E.home, ahora, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }),
    tramite: () => ({ ok: false, motivo: null }), clasificar: () => null, comprobar: () => null, aprobador: () => APPROVERS.maintainers });
  assert.deepStrictEqual(d.firmas, ['runtime-waiver'], JSON.stringify(d));
  // el renglón queda en la lista del dueño, con la historia y el criterio, y su pasada lo arma como cuadro
  assert.ok(fs.existsSync(sl.archivo(E.home)), `la lista se escribió: ${JSON.stringify(d)}`);
  const filas = JSON.parse(fs.readFileSync(sl.archivo(E.home), 'utf8'));
  const fila = filas.find((f) => f.firma === 'runtime-waiver');
  assert.ok(fila, `hay renglón: ${JSON.stringify(filas)}`);
  assert.ok(String(fila.comando).includes(E.story));
  const sig = sl.siguiente({ casa: E.home, env: {}, ahora, arbol: [], sesion: 's-a' });
  assert.strictEqual(sig.tipo, 'firma', JSON.stringify(sig));
  assert.match(JSON.stringify(sig), new RegExp(CRITERIO));
});

// 🔴 mutación: dejar que salir del modo autónomo (o esperar a la persona) saltee la matriz en «Preparar».
test('CierreAutonomo_SinAutonomia_MatrizSigueFrenandoEnPreparar (T13) @story-8.274 @ac-17', (t) => {
  const E = entorno(t);
  E.arrancar('s-b');
  const base = { ...E.leer('s-b'), checks: SOLO_MATRIZ, dodRuntimeChecked: true };
  // los hallazgos de la corrida, sin ninguno: lo que «Preparar» pide antes de la matriz
  const w = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', E.story, '--findings', '-'], { encoding: 'utf8', env: E.env('s-b'), input: '[]', cwd: E.repo });
  assert.strictEqual(w.status, 0, w.stderr);
  for (const [caso, marca] of [['sin autonomía', { autonomous: false }], ['esperando a la persona', { autonomous: true, waitingForHuman: true }]]) {
    E.escribir('s-b', { ...base, ...marca });
    // el cierre del turno deja pasar
    assert.doesNotMatch(E.stop('s-b').stdout, /"decision":"block"/, caso);
    // «Preparar» sigue frenando por la matriz, sin la exención
    const r = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-b');
    assert.notStrictEqual(r.status, 0, `${caso}: ${r.stdout}`);
    assert.match(r.stderr, /BLOQUEADO — acmatrix=red/, `${caso}: ${r.stderr}`);
    // y aunque el control anotado diga verde, «Preparar» recalcula la matriz: sin la exención, roja
    E.escribir('s-b', { ...base, ...marca, checks: { acmatrix: 'green', build: 'green' } });
    const v = E.correr('marker.js', ['complete-step', 'prepare-commit', '--out-of-order'], 's-b');
    assert.notStrictEqual(v.status, 0, `${caso}: ${v.stdout}`);
    assert.match(v.stderr, /matriz de verificación runtime \(DODRT-C6\) ROJA/, `${caso}: ${v.stderr}`);
  }
});
