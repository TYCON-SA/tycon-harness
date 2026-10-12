#!/usr/bin/env node
/**
 * ledger-honesty.test.js — que el pipeline sepa CUÁNDO no sabe qué cambió, y que los probes
 * transitorios del pase adversarial no se cuenten como trabajo del repo.
 *
 * Caso disparador (Story 9.3.1 del repo del framework + la M-10 de un producto del equipo, 2026-08-26): el registro de
 * ediciones de la corrida tenía 7 entradas y las 7 eran scratchpad de los probes del 5b. Cero
 * ediciones del repo. `smart-reloop` devolvió un delta chico y nadie avisó que estaba ciego —
 * un archivo con contenido no despierta la sospecha de "esto no se está escribiendo".
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/ledger-honesty.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('../lib/ledger-honesty.js');

const REPO = '/Users/x/SourceCode/MiRepo';

// ── Reconocer los probes: los nombres REALES observados en los dos repos ──────

test('esProbe reconoce los probes .NET y JS/TS observados en producción', () => {
  const reales = [
    `${REPO}/src/__tests__/utils/__probe_determinism.test.ts`,
    `${REPO}/src/__tests__/utils/__adversarial_probe.test.ts`,
    `${REPO}/src/__tests__/utils/_probe_m10.test.ts`,
    `${REPO}/src/__tests__/utils/_probe_m10b.test.ts`,
    `${REPO}/src/__tests__/utils/__adv_probe_contact.test.ts`,
    `${REPO}/src/__tests__/utils/__adv_probe2_contact.test.ts`,
    `${REPO}/src/utils/__probe_whitespace.test.ts`,
    `${REPO}/Tests/ZZProbe_PluginManager.cs`,
    `${REPO}/Tests/ZzProbeRelay.cs`,
    `${REPO}/Tests/ZZVerifyDeterminismo.cs`,
  ];
  for (const f of reales) assert.equal(h.esProbe(f), true, `no reconoció ${f}`);
});

test('esProbe NO se come tests legítimos (un falso positivo acá borra trabajo real del delta)', () => {
  const legitimos = [
    // 🔴 Los 5 primeros los aportó la revisión adversarial (2026-08-26): la 1ra versión del regex
    // matcheaba cualquier nombre que empezara con `_adv`/`__adv`, y eso se come partials de Sass y
    // módulos privados que son trabajo REAL. Sacar un archivo real de la foto es peor que no
    // filtrar nada: el advisor que tenía que re-auditarlo no se entera.
    `${REPO}/src/styles/_advanced.scss`,
    `${REPO}/src/lib/__adapter.ts`,
    `${REPO}/src/styles/_adv_layout.scss`,
    `${REPO}/src/lib/__advisor.ts`,
    `${REPO}/src/models/_probeta.cs`,
    `${REPO}/src/__tests__/utils/format.test.ts`,
    `${REPO}/src/__tests__/probe-service.test.ts`,   // "probe" en el medio: es un servicio real
    `${REPO}/Tests/PluginManagerTests.cs`,
    `${REPO}/Services/Plugins/PluginManager.cs`,
    `${REPO}/src/lib/adversarial-review.ts`,
    `${REPO}/tests/e2e/login.spec.ts`,
  ];
  for (const f of legitimos) assert.equal(h.esProbe(f), false, `falso positivo en ${f}`);
});

// ── Qué es "del repo" ────────────────────────────────────────────────────────

test('esDelRepo distingue el repo del scratchpad', () => {
  assert.equal(h.esDelRepo(`${REPO}/src/a.cs`, REPO), true);
  assert.equal(h.esDelRepo('/private/tmp/claude-501/x/scratchpad/Det.cs', REPO), false);
  assert.equal(h.esDelRepo(`${REPO}-otro/src/a.cs`, REPO), false, 'prefijo parcial no cuenta');
  assert.equal(h.esDelRepo(null, REPO), false);
});

// ── El diagnóstico: el caso real de la 9.3.1 ─────────────────────────────────

test('9.3.1: registro con 7 entradas de scratchpad + git ve 4 archivos = CIEGO', () => {
  const r = h.diagnosticar({
    repoPath: REPO,
    registro: [
      '/private/tmp/claude-501/s/scratchpad/det-probe/Det.cs',
      '/private/tmp/claude-501/s/scratchpad/det-probe/Det2.cs',
      '/private/tmp/claude-501/s/scratchpad/probe931/probe931.csproj',
      '/private/tmp/claude-501/s/scratchpad/probe931/Program.cs',
      '/private/tmp/claude-501/s/scratchpad/verif-determinismo-9.3.1.md',
      '/private/tmp/claude-501/s/scratchpad/lens-false-negatives-931.md',
      '/private/tmp/claude-501/s/scratchpad/probe-integ/DETALLE.md',
    ],
    gitCambiados: [
      `${REPO}/Services/Plugins/PluginManager.cs`,
      `${REPO}/Services/Plugins/EndpointRegistrar.cs`,
      `${REPO}/Tests/MockPlugin.cs`,
      `${REPO}/Tests/PluginManagerTests.cs`,
    ],
  });
  assert.equal(r.ciego, true, 'un registro lleno de ruido NO es un registro sano');
  assert.equal(r.registroUtil.length, 0);
  assert.equal(r.gitUtil.length, 4);
  assert.match(r.razon, /CIEGO/);
  assert.match(r.razon, /7 entrada\(s\) pero ninguna es trabajo del repo/);
  assert.match(r.razon, /Edit\/Write/, 'tiene que nombrar la causa: el hook no ve ediciones por Bash');
});

test('Totora M-10: el registro son TODO probes dentro del repo = igual de ciego', () => {
  const r = h.diagnosticar({
    repoPath: REPO,
    registro: [
      `${REPO}/src/__tests__/utils/__probe_determinism.test.ts`,
      `${REPO}/src/__tests__/utils/__adversarial_probe.test.ts`,
      `${REPO}/src/__tests__/utils/_probe_m10.test.ts`,
    ],
    gitCambiados: [`${REPO}/src/services/contacto.ts`],
  });
  assert.equal(r.ciego, true, 'estar DENTRO del repo no alcanza: un probe no es trabajo del repo');
  assert.equal(r.probesDescartados.length, 3);
  assert.match(r.razon, /3 probes del pase adversarial/);
});

test('registro sano (aporta archivos reales del repo) = NO ciego', () => {
  const r = h.diagnosticar({
    repoPath: REPO,
    registro: [`${REPO}/Services/Plugins/PluginManager.cs`, '/tmp/scratchpad/nota.md'],
    gitCambiados: [`${REPO}/Services/Plugins/PluginManager.cs`, `${REPO}/Tests/X.cs`],
  });
  assert.equal(r.ciego, false, 'con UNA edición real del repo el registro ya mide algo');
  assert.equal(r.razon, null);
});

test('git no ve nada = NO ciego (no hay nada que perderse)', () => {
  const r = h.diagnosticar({ repoPath: REPO, registro: [], gitCambiados: [] });
  assert.equal(r.ciego, false, 'sin trabajo que detectar, un registro vacío es correcto');
});

test('git ve SOLO probes = NO ciego (no hay trabajo real sin registrar)', () => {
  const r = h.diagnosticar({
    repoPath: REPO,
    registro: [],
    gitCambiados: [`${REPO}/Tests/ZZProbe_X.cs`],
  });
  assert.equal(r.ciego, false);
});

test('sin git disponible (lista vacía) el diagnóstico NO inventa ceguera', () => {
  const r = h.diagnosticar({ repoPath: REPO, registro: [`${REPO}/a.cs`], gitCambiados: [] });
  assert.equal(r.ciego, false, 'fail-open: si no se puede comparar, no se acusa');
});
