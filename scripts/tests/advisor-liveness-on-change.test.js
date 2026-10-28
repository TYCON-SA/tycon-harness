#!/usr/bin/env node
// El chequeo de vida de un revisor tocado (scripts/hooks/advisor-liveness-on-change.js): apagarlo deja constancia, y
// su cartel no le dicta al agente cómo apagarlo. Ninguna prueba gasta un modelo: el apagado sale antes de correr nada.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'advisor-liveness-on-change.js');
const VIDA = require(HOOK);

function correr(args, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vida-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const v of ['NODE_TEST_CONTEXT', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_LIVENESS_REVIEWER_CAP']) delete env[v];
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [HOOK, ...args], { env, encoding: 'utf8' });
  const log = path.join(home, '.claude', '.tycon-pipeline', 'bypass.log');
  const lineas = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, lineas };
}

// 🔴 Falla con: el apagado que sale sin dejar rastro, o que no nombra el revisor que no se miró.
test('V1 Apagado_ConRevisorConCanario_QuedaEnBypassLog', () => {
  const r = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: '1', CLAUDE_CODE_SESSION_ID: 'sesion-1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.lineas.length, 1, 'una línea por commit que se saltea el chequeo');
  assert.strictEqual(r.lineas[0].kind, 'LIVENESS_PRECOMMIT_OFF');
  assert.deepStrictEqual(r.lineas[0].advisors, ['tycon-silent-failure-hunter']);
  assert.strictEqual(r.lineas[0].sessionId, 'sesion-1', 'la noche se la cobra a la sesión que commiteó, no a cualquiera abierta');
  assert.strictEqual(r.stderr, '', 'el apagado no suma un aviso');
});

// 🔴 Falla con: anotar un escape cuando no había nada que mirar (un commit sin revisores con canario).
test('V2 Apagado_SinRevisorConCanario_NoAnota', () => {
  const r = correr(['agents/no-existe-este-revisor.md'], { TYCON_NO_LIVENESS_PRECOMMIT: '1', CLAUDE_CODE_SESSION_ID: 'sesion-1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.lineas.length, 0);
});

// 🔴 Falla con: el cartel de bloqueo que le enseña al agente la variable que lo apaga.
test('V3 Cartel_NoDictaElApagado', () => {
  const texto = VIDA.cartelDeBloqueo('tycon-silent-failure-hunter', 'tycon-silent-failure-hunter::caso-1', 'motivo').join('\n');
  assert.doesNotMatch(texto, /TYCON_NO_LIVENESS_PRECOMMIT/);
  assert.match(texto, /lo decide la persona/);
  assert.match(texto, /caso-1/, 'sigue diciendo qué caso mirar');
});

// 🔴 Falla con: una línea sin sesión, que la noche le cobraría a cualquier ejecución abierta a esa hora, o una por los
//    guiones del arnés que apagan el chequeo a propósito (`ci`).
test('V4 Apagado_SinSesionOPorLosGuionesDelArnes_NoAnota', () => {
  const sinSesion = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: '1' });
  assert.strictEqual(sinSesion.status, 0, sinSesion.stderr);
  assert.strictEqual(sinSesion.lineas.length, 0);
  const ci = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: 'ci', CLAUDE_CODE_SESSION_ID: 'sesion-1' });
  assert.strictEqual(ci.status, 0, ci.stderr);
  assert.strictEqual(ci.lineas.length, 0);
});

// 🔴 Falla con: anotar un escape cuando el chequeo tampoco habría corrido (más revisores que el tope).
test('V5 Apagado_PasadoElTope_NoAnota', () => {
  const r = correr(['agents/tycon-silent-failure-hunter.md', 'agents/llm-cost-reviewer.md'],
    { TYCON_NO_LIVENESS_PRECOMMIT: '1', CLAUDE_CODE_SESSION_ID: 'sesion-1', TYCON_LIVENESS_REVIEWER_CAP: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.lineas.length, 0);
});
