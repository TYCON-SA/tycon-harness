#!/usr/bin/env node
/**
 * run-close.test.js — `marker.js clear` deja dicho cómo terminó la ejecución (`cierre`), en el volcado y en gates.log.
 * (@story-8.92)
 *
 * Una ejecución cerrada con un control en rojo, con pasos sin correr o con el pase adversarial sin resultado no se
 * archiva como terminada: queda `abortada`, con el motivo y quién lo autorizó. La marca es una sola para todos los
 * caminos de cierre: `completa`, `deuda` (la escribe `close-as-debt` y no se pisa), `abortada` y `abandonada`.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/run-close.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = path.join(__dirname, '..', 'marker.js');
const SID = 'sesion-de-prueba';

// stable-data: el arranque y el escape se comparan con el reloj real; tienen que quedar cerca de él
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

/** Una HOME de mentira con el marcador de la sesión, y el repo de la historia. */
function corral(marcador, frenos = []) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cierre-'));
  const estado = path.join(raiz, 'home', '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'repo'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '9.9', storyPath: path.join(raiz, 'repo', 'story.md'), repoPath: path.join(raiz, 'repo'),
    sessionId: SID, startedAt: hace(60), ...marcador,
  }));
  if (frenos.length) fs.writeFileSync(path.join(estado, 'frenos.jsonl'), frenos.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { raiz, estado };
}

function cerrar({ raiz, estado }) {
  const r = spawnSync(process.execPath, [MARKER, 'clear', '--discard'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(raiz, 'home'), USERPROFILE: path.join(raiz, 'home'), CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const dir = path.join(estado, 'timing-history');
  const volcado = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8'));
  const gates = fs.existsSync(path.join(estado, 'gates.log'))
    ? fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.name === 'run-close')
    : [];
  return { cierre: volcado.marker.cierre, gates };
}

const VERDE = {
  checks: { tests: 'green', advisors: 'green' },
  stepsPending: ['prepare-commit'],
  stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers'],
};
const escape = (min, extra = {}) => ({ ts: hace(min), freno: 'safety-guard', regla: 'ESC-C3', veredicto: 'escape', via: 'persona', sesion: SID, escape: 'cerrar-la-ejecucion', ...extra });

test('T9 RunClose_Verde_Completa @story-8.92 — todo en verde y el pase cerrado: completa; sin medir lo nombra', () => {
  const v = cerrar(corral(VERDE));
  assert.strictEqual(v.cierre.estado, 'completa', JSON.stringify(v.cierre));
  assert.strictEqual(v.gates.length, 1);
  assert.deepStrictEqual([v.gates[0].estado, v.gates[0].story], ['completa', '9.9']);
  const s = cerrar(corral({ ...VERDE, checks: { tests: 'sin-medir', advisors: 'green' } }));
  assert.strictEqual(s.cierre.estado, 'completa');
  assert.match(s.cierre.motivo, /sin medir: tests/);
  const a = cerrar(corral({ ...VERDE, checks: { tests: 'sin-acotar', advisors: 'green' } }));
  assert.deepStrictEqual([a.cierre.estado, /sin medir: tests/.test(a.cierre.motivo)], ['completa', true]);
});

test('T10 RunClose_Rojo_Abortada @story-8.92 — con un control en rojo: abortada, con el motivo y la vía del escape', () => {
  const rojo = { ...VERDE, checks: { tests: 'red:exit=1' } };
  const conEscape = cerrar(corral(rojo, [escape(1)]));
  assert.strictEqual(conEscape.cierre.estado, 'abortada');
  assert.match(conEscape.cierre.motivo, /tests/);
  assert.strictEqual(conEscape.cierre.via, 'persona');
  assert.strictEqual(conEscape.gates[0].estado, 'abortada');
  // sin línea de escape, o con una anterior al arranque o de otra sesión: no se inventa quién autorizó
  for (const frenos of [[], [escape(120)], [escape(1, { sesion: 'otra' })]]) {
    const v = cerrar(corral(rojo, frenos));
    assert.deepStrictEqual([v.cierre.estado, v.cierre.via], ['abortada', 'sin-registro'], JSON.stringify(frenos));
    assert.match(v.cierre.motivo, /sin constancia de quién autorizó/);
  }
  // la última línea de la sesión manda, y el relevo se copia
  const reenviada = cerrar(corral(rojo, [escape(5), escape(1, { via: 'reenvio', relevo: 'coordinadora' })]));
  assert.deepStrictEqual([reenviada.cierre.via, reenviada.cierre.relevo], ['reenvio', 'coordinadora']);
  // un registro que existe y no se puede leer se dice en el motivo
  const ilegible = corral(rojo);
  fs.mkdirSync(path.join(ilegible.estado, 'frenos.jsonl'));
  assert.match(cerrar(ilegible).cierre.motivo, /el registro de escapes no se pudo leer/);
  // pasos sin correr o el pase colgado también la dejan abortada
  const pend = cerrar(corral({ ...VERDE, stepsPending: ['run-tests', 'prepare-commit'], stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement'] }));
  assert.deepStrictEqual([pend.cierre.estado, /sin correr: .*run-tests/.test(pend.cierre.motivo)], ['abortada', true]);
  const colgado = cerrar(corral({ ...VERDE, adversarial: { launchedAtStep: 'implement', runId: 'r1', sessionId: SID, launchedAt: hace(30) } }));
  assert.deepStrictEqual([colgado.cierre.estado, /pase adversarial sin cerrar/.test(colgado.cierre.motivo)], ['abortada', true]);
});

test('T11 RunClose_CierreEscrito_NoSePisa @story-8.92 — un cierre de deuda ya escrito pasa al volcado tal cual', () => {
  const deuda = { estado: 'deuda', motivo: 'el criterio 7 no se pudo', via: 'comando', deuda: 'DEF-9.9-x', at: hace(1) };
  const v = cerrar(corral({ ...VERDE, checks: { tests: 'red:exit=1' }, cierre: deuda }));
  assert.deepStrictEqual(v.cierre, deuda);
  assert.deepStrictEqual([v.gates[0].estado, v.gates[0].deuda], ['deuda', 'DEF-9.9-x']);
});

test('T11b RunClose_SetNoEscribeCierre @story-8.92 — un `marker.js set` con cierre: completa no la archiva como terminada', () => {
  const c = corral({ ...VERDE, checks: { tests: 'red:exit=1' } });
  const env = { ...process.env, HOME: path.join(c.raiz, 'home'), USERPROFILE: path.join(c.raiz, 'home'), CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0' };
  const s = spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '9.9', cierre: { estado: 'completa', at: hace(0) } })], { env, encoding: 'utf8' });
  assert.match(s.stderr, /cierre.*se descartó/);
  const v = cerrar(c);
  assert.strictEqual(v.cierre.estado, 'abortada');
});

test('T11c RunClose_SetNoLavaLaEjecucion @story-8.92 — un `set` con otra historia o sin pasos no la deja «completa»', () => {
  const rojo = { ...VERDE, autonomous: true, checks: { tests: 'red:exit=1' }, stepsPending: ['run-tests', 'reviewers', 'prepare-commit'] };
  const entorno = (c) => ({ ...process.env, HOME: path.join(c.raiz, 'home'), USERPROFILE: path.join(c.raiz, 'home'), CLAUDE_CODE_SESSION_ID: SID, TYCON_LANE_LLM: '0' });
  // otra historia sobre la ejecución abierta: la anterior queda anotada como abortada
  const a = corral(rojo);
  spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '9.9b', stepsPending: [], stepsCompleted: [] }), '--replace'], { env: entorno(a), encoding: 'utf8' });
  const gates = fs.readFileSync(path.join(a.estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.name === 'run-close');
  assert.deepStrictEqual([gates[0] && gates[0].estado, gates[0] && gates[0].story], ['abortada', '9.9'], JSON.stringify(gates));
  // la misma historia: set no vacía los pasos pendientes ni pisa los controles ni el modo autónomo
  const b = corral(rojo);
  const pase = { launchedAtStep: 'implement', runId: 'r1', sessionId: SID, launchedAt: hace(30) };
  fs.writeFileSync(path.join(b.estado, 'active', `${SID}.json`), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(b.estado, 'active', `${SID}.json`), 'utf8')), adversarial: pase }));
  spawnSync(process.execPath, [MARKER, 'set', JSON.stringify({ storyId: '9.9', stepsPending: [], checks: { tests: 'green' }, autonomous: false, adversarial: null })], { env: entorno(b), encoding: 'utf8' });
  const m = JSON.parse(fs.readFileSync(path.join(b.estado, 'active', `${SID}.json`), 'utf8'));
  assert.deepStrictEqual([m.checks.tests, m.autonomous, m.adversarial && m.adversarial.runId], ['red:exit=1', true, 'r1']);
  assert.ok(m.stepsPending.includes('run-tests'), JSON.stringify(m.stepsPending));
  const descartes = fs.readFileSync(path.join(b.estado, 'bypass.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => l.kind === 'MARKER_SET_FIELD_DISCARDED').map((l) => l.field).sort();
  assert.deepStrictEqual(descartes, ['adversarial', 'autonomous', 'checks']);
  assert.strictEqual(cerrar(b).cierre.estado, 'abortada');
});

// ── Cada escape de cierre va a la ventana: el ya dado para la misma decisión no cubre el que viene atrás (@story-8.139, AC 29;
// antes, @story-8.140, lo cubría con la salida `cubre=`) ───────────────────────────────────────────────────────────────
const RUN_CLOSE = path.join(__dirname, '..', 'lib', 'run-close.js');
const MK = 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js';
const PL = 'node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js';
const ROJO = { ...VERDE, checks: { tests: 'red:exit=1', advisors: 'green' } };
const deuda = (min, extra) => escape(min, { regla: 'ESC-C4', escape: 'cerrar-como-deuda', ...extra });
const trustRan = (min, extra) => escape(min, { escape: 'trust-ran', ...extra });

/** Lo que el lector del freno le contesta a ese comando: los renglones `frena=` y `cubre=`. */
function lector(c, comando) {
  const r = spawnSync(process.execPath, [RUN_CLOSE, '--gate', '--session', SID, '--command-stdin', '--shell', 'bash'], {
    input: comando, encoding: 'utf8',
    env: { ...process.env, HOME: path.join(c.raiz, 'home'), USERPROFILE: path.join(c.raiz, 'home'), TYCON_LANE_LLM: '0' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const de = (p) => r.stdout.split('\n').filter((l) => l.startsWith(p)).map((l) => l.slice(p.length).split('\t'));
  return { frena: de('frena='), cubre: de('cubre=') };
}

test('T1 RunCloseGate_DeudaYaNoCubreCerrar @story-8.140 @ac-1 @story-8.139 @ac-29 — con la deuda ya autorizada, cerrar la ejecución pide su propia ventana', () => {
  for (const frenos of [[], [deuda(5)], [deuda(5, { via: 'reenvio', relevo: 'coordinadora' })], [deuda(5, { via: 'delegacion', relevo: 'coordinadora' })]]) {
    const v = lector(corral(ROJO, frenos), `${MK} clear`);
    assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['cerrar la ejecución'], 0], JSON.stringify(frenos));
  }
});

test('T1b RunCloseGate_DeudaYaNoCubrePasarARevision @story-8.139 @ac-29 — con la deuda ya autorizada, pasar la historia a revisión pide su propia ventana', () => {
  const cmd = `${MK} update-story-status specs/story-9-9.md review`;
  for (const frenos of [[], [deuda(5)]]) {
    const v = lector(corral(ROJO, frenos), cmd);
    assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['cerrar la ejecución'], 0], JSON.stringify(frenos));
  }
});

// la forma canónica de force-manual y trust-ran la firma su guion en la ventana: acá, la que el freno sigue frenando
const FUERA_DE_FORMA = 'cd /tmp &&';

test('T2 RunCloseGate_TrustRanYaNoCubreForceManual @story-8.140 @ac-2 @story-8.139 @ac-29 — con trust-ran ya autorizado, force-manual del control de revisores pide su propia ventana', () => {
  const cmd = `${FUERA_DE_FORMA} ${MK} set-check advisors green --force-manual`;
  for (const frenos of [[], [trustRan(3)]]) {
    const v = lector(corral(VERDE, frenos), cmd);
    assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['force-manual'], 0], JSON.stringify(frenos));
  }
});

test('T3 RunCloseGate_AlReves_Frena @story-8.140 @ac-4 — la segunda frase no cubre la primera', () => {
  const a = lector(corral(ROJO, [escape(5)]), `${MK} close-as-debt --reason "x" --debt DEF-9.9-x`);
  assert.deepStrictEqual([a.frena.map((f) => f[0]), a.cubre.length], [['cerrar como deuda'], 0]);
  const b = lector(corral(VERDE, [escape(5, { escape: 'force-manual' })]), `${FUERA_DE_FORMA} ${PL} check-count --story s --trust-ran`);
  assert.deepStrictEqual([b.frena.map((f) => f[0]), b.cubre.length], [['trust-ran'], 0]);
});

test('T4 RunCloseGate_ForceManualDeOtroControl_Frena @story-8.140 @ac-4 — trust-ran no cubre force-manual de otro control ni de uno que no se lee', () => {
  for (const control of ['tests', 'dod', 'acmatrix', '"advisors"x', '"$C"']) {
    const v = lector(corral(VERDE, [trustRan(3)]), `${FUERA_DE_FORMA} ${MK} set-check ${control} green --force-manual`);
    assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['force-manual'], 0], control);
  }
});

test('T5 RunCloseGate_EjecucionPerdida_Frena @story-8.140 @ac-4 — la salida de una ejecución perdida y el comando dudoso siguen pidiendo su frase', () => {
  for (const cmd of [`${MK} clear-session otra-sesion --lost`, `${MK} restore otra-sesion`]) {
    const v = lector(corral(ROJO, [deuda(5)]), cmd);
    assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['cerrar la ejecución'], 0], cmd);
  }
  assert.strictEqual(require(RUN_CLOSE).cubiertaPor, undefined, 'la deuda ya no cubre ningún cierre');
});

test('T6 RunCloseGate_OtraSesionOtraEjecucionOtraVia_Frena @story-8.140 @ac-4 — otra sesión, otra ejecución, otro veredicto u otra vía no cubren', () => {
  for (const frenos of [[deuda(5, { sesion: 'otra' })], [deuda(120)], [deuda(5, { veredicto: 'bloqueo' })],
    [deuda(5, { via: 'ambiente' })], [deuda(5, { via: 'sin-conversacion' })], [deuda(5, { freno: 'otro-freno' })]]) {
    const v = lector(corral(ROJO, frenos), `${MK} clear`);
    assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['cerrar la ejecución'], 0], JSON.stringify(frenos));
  }
  // sin un arranque legible no hay desde cuándo medir: no cubre
  const v = lector(corral({ ...ROJO, startedAt: 'no-es-una-fecha' }, [deuda(5)]), `${MK} clear`);
  assert.deepStrictEqual([v.frena.map((f) => f[0]), v.cubre.length], [['cerrar la ejecución'], 0]);
});
