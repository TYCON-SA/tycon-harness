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
  for (const v of ['NODE_TEST_CONTEXT', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_LIVENESS_REVIEWER_CAP', 'TF_BUILD', 'GITHUB_ACTIONS']) delete env[v];
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
  // los guiones del arnés lo ponen dentro de la CI: ahí no es una decisión de la sesión
  const ci = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: 'ci', CLAUDE_CODE_SESSION_ID: 'sesion-1', TF_BUILD: 'True' });
  assert.strictEqual(ci.status, 0, ci.stderr);
  assert.strictEqual(ci.lineas.length, 0);
});

// T8 Liveness_CiOutsideCi_Recorded @story-8.256 @ac-6
// 🔴 Falla con: `ci` fuera de la CI que apaga el chequeo sin rastro, el renglón con el nombre del apagado de la
//    persona (la noche lo contaría como escape), o `TF_BUILD=True` de Azure no reconocido por la mayúscula.
test('T8 Liveness_CiOutsideCi_Recorded @story-8.256 @ac-6', () => {
  const fuera = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: 'ci', CLAUDE_CODE_SESSION_ID: 'sesion-1' });
  assert.strictEqual(fuera.status, 0, fuera.stderr);
  assert.deepStrictEqual(fuera.lineas.map((l) => `${l.kind}:${l.sessionId}`), ['LIVENESS_PRECOMMIT_CI_LOCAL:sesion-1']);
  // `CI` en mayúsculas apaga igual, como lo cuentan la lista, el freno de la configuración y la noche
  const mayus = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: 'CI', CLAUDE_CODE_SESSION_ID: 'sesion-2' });
  assert.strictEqual(mayus.status, 0, mayus.stderr);
  assert.deepStrictEqual(mayus.lineas.map((l) => `${l.kind}:${l.sessionId}`), ['LIVENESS_PRECOMMIT_CI_LOCAL:sesion-2']);
  // con un espacio adelante no apaga: el freno del archivo de arranque tampoco lo toma
  const espacio = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: ' ci', CLAUDE_CODE_SESSION_ID: 'sesion-3' });
  assert.strictEqual(espacio.lineas.filter((l) => l.kind === 'LIVENESS_PRECOMMIT_CI_LOCAL').length, 0);
  for (const marca of [{ TF_BUILD: 'True' }, { TF_BUILD: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    const dentro = correr(['agents/tycon-silent-failure-hunter.md'], { TYCON_NO_LIVENESS_PRECOMMIT: 'ci', CLAUDE_CODE_SESSION_ID: 'sesion-1', ...marca });
    assert.strictEqual(dentro.status, 0, dentro.stderr);
    assert.strictEqual(dentro.lineas.length, 0, JSON.stringify(marca));
  }
});

// 🔴 Falla con: anotar un escape cuando el chequeo tampoco habría corrido (más revisores que el tope).
test('V5 Apagado_PasadoElTope_NoAnota', () => {
  const r = correr(['agents/tycon-silent-failure-hunter.md', 'agents/llm-cost-reviewer.md'],
    { TYCON_NO_LIVENESS_PRECOMMIT: '1', CLAUDE_CODE_SESSION_ID: 'sesion-1', TYCON_LIVENESS_REVIEWER_CAP: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.lineas.length, 0);
});
