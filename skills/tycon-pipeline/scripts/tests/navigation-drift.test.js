'use strict';

/**
 * navigation-drift.test.js — el mapa de navegación cambió y nadie volvió a mirar las pantallas
 * ya escritas (FIX-8, caso C7 de la auditoría del 2026-08-25).
 *
 * WIRING-C5 compara el layout del código contra el documento de arquitectura de información en UN
 * SOLO SENTIDO: código nuevo → documento. Si el documento cambia, lo ya escrito no se revisa nunca.
 * La marca cierra ese hueco sin agregar revisores.
 *
 * 🔴 Los casos que sostienen el diseño son los de LIMPIEZA: un aviso que no se apaga nunca se
 * aprende a ignorar, y uno que se apaga con cualquier cosa no protege. La marca se levanta sólo con
 * una corrida REAL del revisor de wiring EN ESTE REPO y POSTERIOR al cambio — las tres condiciones.
 *
 * Parte pura (fs, sin git ni spawns) — corre en cada arranque.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nd = require('../lib/navigation-drift.js');

function lab() { return fs.mkdtempSync(path.join(os.tmpdir(), 'navdrift-')); }

function ledger(dir, filas) {
  const runs = path.join(dir, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 's.jsonl'), filas.map((f) => JSON.stringify(f)).join('\n') + '\n');
  return { runsDir: runs, summaryPath: path.join(dir, 'sum.jsonl') };
}

// ── qué documento cuenta ──────────────────────────────────────────────────────────────────────
test('reconoce el mapa de navegación y descarta el resto del planning', () => {
  assert.equal(nd.esMapaDeNavegacion('/r/specs/planning-artifacts/navigation-map.md'), true);
  assert.equal(nd.esMapaDeNavegacion('/r/specs/planning-artifacts/mapa-de-navegacion.md'), true);
  assert.equal(nd.esMapaDeNavegacion('/r/specs/planning-artifacts/information-architecture.md'), true);
  assert.equal(nd.esMapaDeNavegacion('/r/specs/planning-artifacts/prd.md'), false, 'un PRD no es el modelo de navegación');
  assert.equal(nd.esMapaDeNavegacion('/r/docs/navigation-map.md'), false, 'fuera de planning-artifacts no cuenta');
  assert.equal(nd.esMapaDeNavegacion(''), false);
});

// ── la marca ──────────────────────────────────────────────────────────────────────────────────
test('la marca guarda cuándo y qué documento cambió', () => {
  const d = lab();
  assert.equal(nd.marcar(d, 'specs/planning-artifacts/navigation-map.md', 'Edit'), true);
  const m = nd.leerMarca(d);
  assert.equal(m.artefacto, 'specs/planning-artifacts/navigation-map.md');
  assert.equal(m.evento, 'Edit');
  assert.ok(m.ts);
});

test('sin marca no hay aviso', () => {
  assert.equal(nd.avisoPendiente(lab()), null);
});

test('con marca y sin re-auditoría, avisa y nombra el documento', () => {
  const d = lab();
  nd.marcar(d, 'specs/planning-artifacts/navigation-map.md', 'Edit');
  const a = nd.avisoPendiente(d, ledger(lab(), []));
  assert.match(a, /navigation-drift/);
  assert.match(a, /WIRING-C5/);
  assert.match(a, /navigation-map\.md/);
});

// ── la limpieza: las TRES condiciones ─────────────────────────────────────────────────────────
test('una corrida REAL del revisor de wiring, posterior y en este repo, levanta la marca', () => {
  const d = lab();
  nd.marcar(d, 'x.md', 'Edit');
  const opts = ledger(lab(), [{ ts: new Date(Date.now() + 1000).toISOString(), advisor: nd.WIRING, repo: d }]);
  assert.equal(nd.avisoPendiente(d, opts), null);
  assert.equal(fs.existsSync(nd.rutaMarca(d)), false, 'la marca se borra: si quedara, el aviso volvería a salir');
});

test('una corrida ANTERIOR al cambio no levanta la marca', () => {
  const d = lab();
  nd.marcar(d, 'x.md', 'Edit');
  const opts = ledger(lab(), [{ ts: new Date(Date.now() - 60000).toISOString(), advisor: nd.WIRING, repo: d }]);
  assert.ok(nd.avisoPendiente(d, opts), 'auditar ANTES del cambio no prueba nada sobre el cambio');
});

test('una corrida en OTRO repo no levanta la marca', () => {
  const d = lab();
  nd.marcar(d, 'x.md', 'Edit');
  const opts = ledger(lab(), [{ ts: new Date(Date.now() + 1000).toISOString(), advisor: nd.WIRING, repo: '/otro/repo' }]);
  assert.ok(nd.avisoPendiente(d, opts));
});

test('otro revisor cualquiera no levanta la marca', () => {
  const d = lab();
  nd.marcar(d, 'x.md', 'Edit');
  const opts = ledger(lab(), [{ ts: new Date(Date.now() + 1000).toISOString(), advisor: 'tycon-plugin-security-basics', repo: d }]);
  assert.ok(nd.avisoPendiente(d, opts));
});

test('el resumen durable también cuenta (el detalle vivo dura 7 días)', () => {
  // Sin mirar el resumen, una corrida real de hace más de una semana quedaría invisible y la marca
  // no se levantaría NUNCA — el aviso se volvería permanente, que es como se muere un aviso.
  const d = lab();
  nd.marcar(d, 'x.md', 'Edit');
  const dir = lab();
  const sum = path.join(dir, 'sum.jsonl');
  fs.writeFileSync(sum, JSON.stringify({
    sessionId: 'vieja', from: '2026-08-01T00:00:00.000Z', to: new Date(Date.now() + 1000).toISOString(),
    repos: [d], stories: [], advisors: { [nd.WIRING]: 1 }, spawns: 1,
  }) + '\n');
  assert.equal(nd.avisoPendiente(d, { runsDir: path.join(dir, 'vacio'), summaryPath: sum }), null);
});
