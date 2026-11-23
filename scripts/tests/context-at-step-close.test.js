'use strict';
/**
 * context-at-step-close.test.js — al cerrar un paso pesado del pipeline (Implementar, Correr las pruebas, Revisores, Pase
 * adversarial, Probar en vivo), si la sesión ya pasó el umbral del aviso de contexto, el cierre dice que es el momento
 * de compactar o de abrir una sesión nueva, antes del paso siguiente.
 *
 * Por qué: el aviso de contexto sale cuando la persona escribe, y una corrida larga casi no tiene mensajes suyos. Una
 * sesión llegó a 832 mil tokens sin compactar en sus puntos de control, y cada turno releía todo.
 *
 * Lo que no se puede perder:
 *   · lo dice al cerrar un paso pesado con la sesión sobre el umbral, cada vez (es el punto de corte, no un recordatorio);
 *   · debajo del umbral, en un paso liviano, después de compactar o con TYCON_CONTEXT_NOTICE=0, nada;
 *   · nunca frena: el paso se cierra igual.
 *
 * Cada caso tiene su HOME de juguete; marker.js corre por subproceso con el ambiente limpio de las variables de la máquina.
 *
 * Correr: node --test scripts/tests/context-at-step-close.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
const MARKER = path.join(SCRIPTS, 'marker.js');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'context-size-notice.js');
const { stateDir } = require(path.join(SCRIPTS, 'lib', 'state-dir.js'));
const STEPS = require(path.join(SCRIPTS, 'lib', 'steps.js'));

function cleanEnv(home, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$|^CLAUDE_/.test(k)) continue;
    e[k] = v;
  }
  return Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off' }, extra);
}

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-close-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing', 'timing-history']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  return { home, sdir };
}

/** Un turno del asistente que suma `total` tokens de contexto. */
// stable-data: la hora del turno sólo se compara con la del reinicio, que el aviso también toma del reloj; no depende del día ni del huso
const turno = (total, ts = new Date().toISOString()) => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { role: 'assistant', usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: total - 3000, output_tokens: 500 } },
});

/** La conversación de la sesión donde la guarda la herramienta: `~/.claude/projects/<carpeta>/<sesión>.jsonl`. */
function conversacion(w, sid, tokens) {
  const d = path.join(w.home, '.claude', 'projects', '-tmp-producto-a');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sid}.jsonl`), `${turno(tokens)}\n`);
}

function pipelineMarker(w, sid, done) {
  const ids = STEPS.STEPS.filter((s) => !s.flag).map((s) => s.id);
  const story = path.join(w.home, 'story-9.9.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\ntitle: "Producto A"\n---\n# Story\n');
  fs.writeFileSync(path.join(w.sdir, 'active', `${sid}.json`), JSON.stringify({
    sessionId: sid, storyId: '9.9', storyPath: story, stepScheme: STEPS.SCHEME,
    startedAt: new Date().toISOString(), lastTouch: new Date().toISOString(),
    stepsCompleted: done, stepsPending: ids.filter((s) => !done.includes(s)), stepTimings: {},
  }));
}

const marker = (w, sid, args, extra = {}) => spawnSync(process.execPath, [MARKER, ...args], {
  input: '', cwd: w.home, env: cleanEnv(w.home, { CLAUDE_CODE_SESSION_ID: sid, ...extra }), encoding: 'utf8',
});
const cerrarImplementar = (w, sid, extra) => marker(w, sid, ['complete-step', 'implement', '--no-atdd', '--reason', 'prueba de juguete'], extra);
const HECHOS = ['start', 'validate-story', 'plan', 'approve-plan'];

test('T1 ContextAtStepClose_HeavyStepOverThreshold_SaysCompactOrNewSession — cerrar Implementar con 832 mil tokens lo dice', () => {
  // 🔴 rojo: el cierre del paso no mide el contexto, y la recomendación sólo llega si la persona escribe.
  const w = world();
  pipelineMarker(w, 'c1', HECHOS);
  conversacion(w, 'c1', 832000);
  const r = cerrarImplementar(w, 'c1');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /🧠 contexto/);
  assert.match(r.stderr, /832 mil/);
  assert.match(r.stderr, /Implementar/);
  assert.match(r.stderr, /\/compact/);
  assert.match(r.stderr, /sesión nueva/);
  assert.match(r.stderr, /adopt-session c1/, 'dice cómo seguir la ejecución en la sesión nueva');
  assert.doesNotMatch(r.stdout, /🧠/, 'la salida estándar sigue siendo el marcador, sin el aviso');
  assert.strictEqual(JSON.parse(r.stdout).stepsCompleted.includes('implement'), true, 'el paso se cierra igual');
});

test('T2 ContextAtStepClose_BelowThresholdOrLightStep_Silent — debajo del umbral, o un paso liviano, nada', () => {
  // 🔴 rojo: avisa siempre, o en pasos que no son pesados.
  const w = world();
  pipelineMarker(w, 'c2', HECHOS);
  conversacion(w, 'c2', 299999);
  const r = cerrarImplementar(w, 'c2');
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stderr, /🧠 contexto/);
  const { avisoAlCerrarPaso } = require(HOOK);
  const home = world().home;
  const tp = path.join(home, 'c.jsonl');
  fs.writeFileSync(tp, `${turno(900000)}\n`);
  assert.strictEqual(avisoAlCerrarPaso({ pasos: ['plan'], sessionId: 'c2b', home, env: {}, transcriptPath: tp }), '', 'armar el plan no es pesado');
  assert.match(avisoAlCerrarPaso({ pasos: ['reviewers'], sessionId: 'c2b', home, env: {}, transcriptPath: tp }), /Revisores/);
  assert.match(avisoAlCerrarPaso({ pasos: ['5b'], sessionId: 'c2b', home, env: {}, transcriptPath: tp }), /Pase adversarial/, 'el marcador viejo, por número');
});

test('T3 ContextAtStepClose_AfterCompactOrOff_Silent — después de compactar cuentan sólo los turnos nuevos; apagado, nada', () => {
  // 🔴 rojo: cuenta el turno de antes de compactar, o no respeta el apagado del aviso.
  const w = world();
  pipelineMarker(w, 'c3', HECHOS);
  conversacion(w, 'c3', 832000);
  const off = cerrarImplementar(w, 'c3', { TYCON_CONTEXT_NOTICE: '0' });
  assert.strictEqual(off.status, 0, off.stderr + off.stdout);
  assert.doesNotMatch(off.stderr, /🧠 contexto/, 'apagado');
  const { avisoAlCerrarPaso, run } = require(HOOK);
  const home = world().home;
  const tp = path.join(home, 'c.jsonl');
  fs.writeFileSync(tp, `${turno(832000, '2026-01-01T10:00:00.000Z')}\n`);
  run({ hook_event_name: 'SessionStart', session_id: 'c3b', transcript_path: tp, source: 'compact' }, { home, env: {} });
  assert.strictEqual(avisoAlCerrarPaso({ pasos: ['implement'], sessionId: 'c3b', home, env: {}, transcriptPath: tp }), '', 'tras compactar, el turno viejo no cuenta');
});
