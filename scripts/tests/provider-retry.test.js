'use strict';
// provider-retry.test.js — reanudar sola una sesión que el proveedor cortó: espera 1, 2, 4 y 8 minutos y la despierta
// (sale con 2 y el aviso por la salida de error); al quinto corte seguido, con otro error o si la sesión se movió en la
// espera, no hace nada.
// Todo en una casa de juguete en una carpeta temporal, con las esperas escaladas a milisegundos. Nada lee la casa real.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test provider-retry.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'provider-retry.js');
const PR = require(HOOK);
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const SID = 'aaaaaaaa-3333-4aaa-8bbb-00000000c0de';
const MIN = 60000;

function casa(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retry-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, sdir: stateDir(home) };
}
// el gancho de verdad, con las esperas escaladas (1 min → 6 ms) y armado aunque no lo lance la herramienta
const correr = (home, ev, extra = {}) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ hook_event_name: 'StopFailure', session_id: SID, ...ev }), encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_ENTRYPOINT: 'cli', TYCON_PROVIDER_RETRY_ANY_PARENT: '1', TYCON_PROVIDER_RETRY_SCALE: '0.0001', ...extra },
});

test('T1 Plan_UnoDosCuatroOchoYDespuesSeCalla — cada corte seguido es el intento siguiente; pasada media hora vuelve a cero', (t) => {
  const { sdir } = casa(t);
  const t0 = Date.parse('2026-11-21T10:00:00Z');
  const esperas = [0, 1, 2, 3, 4].map((i) => PR.plan(sdir, SID, 'overloaded', t0 + i * MIN));
  assert.deepStrictEqual(esperas.slice(0, 4).map((p) => p.delayMs / MIN), [1, 2, 4, 8]);
  assert.strictEqual(esperas[4], null, 'al quinto corte seguido se calla');
  assert.strictEqual(PR.plan(sdir, SID, 'server_error', t0 + 4 * MIN + PR.RESET_AFTER_MS).attempt, 1, 'pasada media hora, empieza de nuevo');
  for (const e of ['authentication_failed', 'billing_error', 'unknown', undefined]) assert.strictEqual(PR.plan(sdir, 'otra', e, t0), null, `${e}: no se reintenta`);
});

test('T2 Hook_DespiertaConElAviso — sale con 2 y el aviso dice el error y el intento', (t) => {
  const { home } = casa(t);
  const r = correr(home, { error: 'overloaded' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /El proveedor cortó el turno anterior \(overloaded\)\. Reintento 1 de 4: seguí con lo que estabas haciendo/);
  assert.strictEqual(r.stdout, '');
  assert.match(correr(home, { error: 'rate_limit' }).stderr, /Reintento 2 de 4/);
});

test('T3 Hook_NoDespierta — otro error, apagado, sin la herramienta, bajo claude -p, o la sesión se movió en la espera', (t) => {
  const { home, sdir } = casa(t);
  assert.strictEqual(correr(home, { error: 'authentication_failed' }).status, 0);
  assert.strictEqual(correr(home, { error: 'overloaded' }, { TYCON_PROVIDER_RETRY: '0' }).status, 0);
  assert.strictEqual(correr(home, { error: 'overloaded' }, { TYCON_PROVIDER_RETRY_ANY_PARENT: '' }).status, 0, 'no lo lanzó la herramienta');
  assert.strictEqual(correr(home, { error: 'overloaded' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }).status, 0, 'claude -p espera al gancho');
  assert.strictEqual(correr(home, { error: 'overloaded', hook_event_name: 'Stop' }).status, 0, 'sólo el corte');
  // la persona escribió durante la espera: el archivo de estado de la sesión cambió después del corte
  // stable-data: el gancho corre como proceso aparte con el reloj de verdad; la hora se arma contra ahora
  const futuro = new Date(Date.now() + 10 * MIN).toISOString();
  fs.mkdirSync(path.join(sdir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'sessions', `${SID}.json`), JSON.stringify({ schema: 1, session: SID, tool: 'claude', updatedAt: futuro, lastEventAt: futuro }));
  const r = correr(home, { error: 'overloaded' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
});

test('T4 Registro_DeFondoConSuEventoYSoloDondeSeMidio — la lista lo declara de fondo, con los tres errores y fuera de Windows', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const hooks = Array.isArray(list) ? list : (list.hooks || Object.values(list).find(Array.isArray));
  const h = hooks.find((x) => x.spec === '@tcg:provider-retry.js');
  assert.ok(h, 'está en la lista');
  assert.deepStrictEqual({ event: h.event, rewake: h.asyncRewake, windows: h.platforms && h.platforms.windows }, { event: 'StopFailure', rewake: true, windows: false });
  assert.deepStrictEqual(h.matcher.split('|').sort(), [...PR.RETRYABLE].sort());
  assert.ok(h.timeout * 1000 > PR.DELAYS_MIN[PR.DELAYS_MIN.length - 1] * MIN, 'el plazo del gancho alcanza para la espera más larga');
});

// Pase adversarial (21/11): con el archivo de estado apagado o sin cambios, la conversación de la sesión dice si se movió.
test('T5 Hook_LaConversacionDiceQueSeMovio — sin archivo de estado, una conversación que creció después del corte no se despierta', (t) => {
  const { home } = casa(t);
  const conv = path.join(home, 'conversacion.jsonl');
  fs.writeFileSync(conv, '{}\n');
  // stable-data: el gancho corre como proceso aparte con el reloj de verdad; las horas del archivo se arman contra ahora
  const despues = (Date.now() + 10 * MIN) / 1000;
  fs.utimesSync(conv, despues, despues);
  const r = correr(home, { error: 'overloaded', transcript_path: conv }, { TYCON_SESSION_STATE: '0' });
  assert.strictEqual(r.status, 0, r.stderr);
  const quieta = path.join(home, 'quieta.jsonl');
  fs.writeFileSync(quieta, '{}\n');
  const antes = (Date.now() - 10 * MIN) / 1000;
  fs.utimesSync(quieta, antes, antes);
  assert.strictEqual(correr(home, { error: 'overloaded', transcript_path: quieta }, { TYCON_SESSION_STATE: '0' }).status, 2, 'quieta desde antes del corte: se despierta');
});
