#!/usr/bin/env node
'use strict';
/**
 * marker-archive-rescue.test.js — T8 y T8b: el archivador del cierre no se cae por el rescate.
 *
 * QUÉ CUIDA, en una frase: que el archivador del cierre (`marker.js clear`) llame al rescate del
 * hilo y el consumo **sin poder caerse por eso**. El volcado de una corrida es la única memoria que
 * queda de ella: si el rescate falla —conversación ilegible, disco lleno, o el script directamente
 * no está en esta máquina porque el arnés quedó atrasado— el volcado se escribe IGUAL, con el
 * motivo adentro.
 *
 * 🔴 POR QUÉ T8b ES EL QUE MÁS PESA. `marker.js` vive en `agent-skills` y `tokens-digest.js` vive en
 *    el arnés: son dos repos que se actualizan por caminos distintos. Una máquina con
 *    el arnés atrasado va a tener el `marker.js` nuevo y el `tokens-digest.js` ausente. Si el
 *    archivador exigiera el script, esa máquina **dejaría de archivar** — perdería no sólo el
 *    consumo sino los tiempos, los frenos y el costo, que sí se guardan bien.
 *
 * Correr: node --test ~/.claude/agent-skills/skills/tycon-pipeline/scripts/tests/marker-archive-rescue.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER = path.join(__dirname, '..', 'marker.js');

/**
 * Un HOME de mentira con su `.tycon-pipeline/`, para no tocar el del dev, y un arnés de mentira en `guides/`.
 * `harness-path.js` reconoce un arnés por `scripts/install-tycon-hooks.sh`: sin ese archivo la carpeta no cuenta como
 * arnés y el rescate nunca llega a buscar su `tokens-digest.js`.
 */
function corral() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'rescate-'));
  fs.mkdirSync(path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'projects', 'carpeta'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'guides', 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'guides', 'scripts', 'install-tycon-hooks.sh'), '');
  fs.mkdirSync(path.join(raiz, 'repo'), { recursive: true });
  return raiz;
}

function correrMarker(args, raiz, extra) {
  return spawnSync(process.execPath, [MARKER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(raiz, 'home'),
      CLAUDE_CODE_SESSION_ID: 'sesion-de-prueba',
      TYCON_GUIDES_DIR: path.join(raiz, 'guides'),
      TYCON_LANE_LLM: '0',
      ...(extra || {}),
    },
  });
}

/** Deja un marker activo con una story, como si el pipeline estuviera corriendo. */
function marcarCorrida(raiz) {
  const r = correrMarker(['set', JSON.stringify({
    storyId: '2.13-prueba',
    storyPath: path.join(raiz, 'repo', 'story.md'),
    repoPath: path.join(raiz, 'repo'),
    sessionId: 'sesion-de-prueba',
    stepsPending: [],
  })], raiz);
  assert.strictEqual(r.status, 0, `marker set falló: ${r.stderr}`);
}

function volcados(raiz) {
  const d = path.join(raiz, 'home', '.claude', '.tycon-pipeline', 'timing-history');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f));
}

// ── T8 (AC7) · con la conversación ilegible, el volcado igual se escribe ─────────────────────────
test('T8 · el archivador NO se cae si el rescate falla, y deja el motivo adentro', () => {
  const raiz = corral();
  // El rescate existe pero se rompe siempre: es el peor caso del lado del script.
  fs.writeFileSync(
    path.join(raiz, 'guides', 'scripts', 'metrics', 'tokens-digest.js'),
    'process.stderr.write("me rompí a propósito\\n"); process.exit(9);\n',
  );
  marcarCorrida(raiz);

  const r = correrMarker(['clear', '--discard'], raiz, { TYCON_PROJECTS_DIR: path.join(raiz, 'projects') });
  assert.strictEqual(r.status, 0, `el clear no debe fallar por el rescate: ${r.stderr}`);

  const vs = volcados(raiz);
  assert.strictEqual(vs.length, 1, 'el volcado de la corrida TIENE que existir igual');
  const d = JSON.parse(fs.readFileSync(vs[0], 'utf8'));
  assert.ok(d.marker && d.marker.storyId === '2.13-prueba', 'el volcado conserva el marker');
  assert.ok(d.consumo, 'el volcado declara qué pasó con el consumo');
  assert.strictEqual(d.consumo.estado, 'no_medido', 'un rescate que falla es "no_medido", nunca ceros');
  assert.ok(String(d.consumo.motivo || '').length > 10, 'y con el motivo escrito, en castellano');
  fs.rmSync(raiz, { recursive: true, force: true });
});

// ── T8b (AC7) · sin el script en esta máquina, el volcado sale igual ─────────────────────────────
test('T8b Rescue_DigestMissing_ArchivesAnyway @story-7.35 @ac-2 — con tokens-digest.js AUSENTE (arnés atrasado) el archivador archiva igual', () => {
  const raiz = corral();
  // A propósito: NO se crea `guides/scripts/metrics/tokens-digest.js`.
  marcarCorrida(raiz);

  const r = correrMarker(['clear', '--discard'], raiz, { TYCON_PROJECTS_DIR: path.join(raiz, 'projects') });
  assert.strictEqual(r.status, 0, `el clear no debe fallar porque falte el script: ${r.stderr}`);

  const vs = volcados(raiz);
  assert.strictEqual(vs.length, 1, 'el volcado TIENE que existir aunque el arnés esté atrasado');
  const d = JSON.parse(fs.readFileSync(vs[0], 'utf8'));
  assert.ok(d.costo, 'y conserva lo que el archivador ya sabía calcular (el costo)');
  assert.strictEqual(d.consumo.estado, 'no_medido');
  assert.match(
    String(d.consumo.motivo || ''),
    /tokens-digest|no está|no encontré/i,
    'el motivo tiene que decir que el script no está, para que se entienda sin abrir código',
  );
  fs.rmSync(raiz, { recursive: true, force: true });
});

// ── T8c · el camino feliz: si el rescate anda, su resultado queda en el volcado ──────────────────
// Sin este caso, T8 y T8b pasarían con un archivador que NUNCA llama al rescate.
test('T8c Rescue_HealthyDigest_LandsInDump @story-7.35 @ac-2 — con el rescate sano, lo que escribe queda en el volcado', () => {
  const raiz = corral();
  // Un rescate de mentira que hace lo que hace el de verdad: reescribe el volcado con `consumo`.
  // Lee `--run`, el nombre con el que el cierre lo llama (el viejo, y la vuelta que recibe un arnés
  // atrasado, los cubren T15 y T16 de marker-archive-change.test.js).
  fs.writeFileSync(
    path.join(raiz, 'guides', 'scripts', 'metrics', 'tokens-digest.js'),
    `const fs = require('fs');
const i = process.argv.indexOf('--run');
const p = process.argv[i + 1];
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.consumo = { estado: 'medido', respuestas: 42, tokens: { in: 1, out: 2, cache_new: 0, cache_read: 0 } };
fs.writeFileSync(p, JSON.stringify(d, null, 2));
`,
  );
  marcarCorrida(raiz);

  const r = correrMarker(['clear', '--discard'], raiz, { TYCON_PROJECTS_DIR: path.join(raiz, 'projects') });
  assert.strictEqual(r.status, 0, r.stderr);

  const d = JSON.parse(fs.readFileSync(volcados(raiz)[0], 'utf8'));
  assert.strictEqual(d.consumo.estado, 'medido', 'el archivador tiene que HABER llamado al rescate');
  assert.strictEqual(d.consumo.respuestas, 42);
  fs.rmSync(raiz, { recursive: true, force: true });
});
