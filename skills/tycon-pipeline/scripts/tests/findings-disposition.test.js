'use strict';

/**
 * findings-disposition.test.js — la disposition `refuted` y el fin del aplanado mudo
 * (propuesta FINDINGS-DISPOSITION-FALSE-POSITIVE-1, 2026-08-27).
 *
 * Caso disparador (Story 1.24 del backend de un producto del equipo): un CRITICAL falso del story-validator se
 * escribió con `disposition:"refuted"` — valor que el schema no tenía — y `normalizeFindingRecord`
 * lo aplanó a 'open' EN SILENCIO. Resultado: el falso positivo quedó contando como deuda no
 * accionada en las métricas, y write-followups lo persistió como checkbox abierto en la story
 * (deuda fantasma). Tres garantías nuevas, cada una con su test:
 *   1. 'refuted' es válido y se conserva (con su count propio en el summary).
 *   2. Un valor DESCONOCIDO se sigue coaccionando a 'open' pero AVISA (warnings en el output).
 *   3. 'refuted' sin reason degrada a 'open' con aviso — la refutación se documenta o no vale.
 *   4. write-followups marca los refuted como resueltos [x], no como deuda abierta [ ].
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PIPELINE = path.join(__dirname, '..', 'pipeline.js');

function lab() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'finddisp-'));
  const spec = path.join(d, 'story-9.9-x.md');
  fs.writeFileSync(spec, [
    '---', 'story: "9.9"', 'title: "t"', 'status: in-progress', '---', '',
    '# Story 9.9', '', '## Acceptance Criteria', '', '1. algo', '',
  ].join('\n'));
  // El laboratorio trae su registro de revisores (story 7.13): desde entonces `write-findings`
  // valida el firmante contra el roster de la corrida y, si no puede, AVISA. Sin roster acá, cada
  // caso de este archivo se llevaba de yapa un aviso que no tiene nada que ver con lo que mide
  // —la `disposition`— y los asserts sobre `warnings` dejaban de hablar de lo suyo.
  const runDir = path.join(d, '.advisors', 'pipeline-runs', '9.9-20260101000000');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'review-roster.json'), `${JSON.stringify({
    version: 1, story: '9.9', written_by: 'on-advisor-run.js', ts: '2026-01-01T00:00:00Z',
    base_sha: null, tree_sha: null,
    implementer: { kind: 'sesion-principal', session_id: 's1', model: null },
    reviewers: [{ agent: 'a', kind: 'subagente', model: null, model_source: 'heredado', ts: null, iter: 1 }],
    iterations: 1, iterations_source: 'ledger',
  }, null, 2)}\n`);
  return { d, spec, runDir };
}

function writeFindings(labDir, spec, findings) {
  const fj = path.join(labDir, 'in.json');
  fs.writeFileSync(fj, JSON.stringify(findings));
  const out = execFileSync('node', [PIPELINE, 'write-findings', '--repo', labDir, '--story', spec, '--findings', fj], { encoding: 'utf8' });
  return JSON.parse(out);
}

test('refuted se conserva, cuenta aparte, y NO queda como open', () => {
  const { d, spec } = lab();
  const r = writeFindings(d, spec, [
    { rule_id: 'VAL-C1', severity: 'CRITICAL', advisor: 'a', file: 'x.cs', disposition: 'refuted', reason: 'falso positivo: releído de disco, el bloque no está' },
    { rule_id: 'W-1', severity: 'WARNING', advisor: 'a', file: 'y.cs', disposition: 'open', reason: 'r' },
  ]);
  assert.strictEqual(r.counts.refuted, 1);
  assert.strictEqual(r.counts.open, 1);
  const written = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.strictEqual(written.find((f) => f.rule_id === 'VAL-C1').disposition, 'refuted');
  assert.ok(!r.warnings, 'con valores válidos no debe haber warnings');
});

test('disposition desconocida coacciona a open PERO avisa (fin del aplanado mudo)', () => {
  const { d, spec } = lab();
  const r = writeFindings(d, spec, [
    { rule_id: 'Z-1', severity: 'WARNING', advisor: 'a', file: 'x.cs', disposition: 'banana', reason: 'r' },
  ]);
  assert.strictEqual(r.counts.open, 1);
  assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1, 'debe avisar la coacción');
  assert.match(r.warnings[0], /banana/);
  assert.match(r.warnings[0], /Z-1/);
});

test('refuted SIN reason degrada a open con aviso — la refutación se documenta o no vale', () => {
  const { d, spec } = lab();
  const r = writeFindings(d, spec, [
    { rule_id: 'Q-1', severity: 'CRITICAL', advisor: 'a', file: 'x.cs', disposition: 'refuted' },
  ]);
  assert.strictEqual(r.counts.refuted, 0);
  assert.strictEqual(r.counts.open, 1);
  assert.ok(r.warnings && r.warnings.some((w) => /sin reason/.test(w)));
});

test('write-followups: refuted queda [x] (cerrado), no deuda fantasma [ ]', () => {
  const { d, spec } = lab();
  const r = writeFindings(d, spec, [
    { rule_id: 'VAL-C1', severity: 'CRITICAL', advisor: 'a', file: 'x.cs', disposition: 'refuted', reason: 'falso, refutado con evidencia' },
    { rule_id: 'W-1', severity: 'WARNING', advisor: 'a', file: 'y.cs', disposition: 'open', reason: 'deuda real' },
  ]);
  execFileSync('node', [PIPELINE, 'write-followups', '--story', spec, '--findings', r.path], { encoding: 'utf8' });
  const story = fs.readFileSync(spec, 'utf8');
  assert.match(story, /- \[x\] \*\*\[CRITICAL\]\*\* VAL-C1/);
  assert.match(story, /- \[ \] \*\*\[WARNING\]\*\* W-1/);
});

const { normalizeFindingRecord } = require(PIPELINE);

// ── 5. «false-positive» es «refuted» (2026-09-10, MECH-CHECK-CONFIRMED-FALSE-POSITIVE-NOT-REFUTED-1) ──
// El orquestador lo escribe así cuando un CRITICAL de mech-check lo refuta el advisor especializado.
// Antes se coaccionaba a 'open' con un aviso que nadie lee → deuda fantasma en la story (caso 2.15).
test('normalizeFindingRecord: «false-positive» con reason queda como refuted, sin aviso', () => {
  const warnings = [];
  const r = normalizeFindingRecord({ rule_id: 'ACCOV-C1', severity: 'CRITICAL', advisor: 'mech-check',
    file: 'scripts/tests/x.test.sh', disposition: 'false-positive',
    reason: 'el matcher no escanea suites bash; confirmado por tycon-ac-coverage-checker' }, warnings);
  assert.equal(r.disposition, 'refuted');
  assert.deepEqual(warnings, [], `no tiene que avisar nada: ${warnings.join(' | ')}`);
});

test('normalizeFindingRecord: «false-positive» SIN reason degrada a open, igual que refuted', () => {
  const warnings = [];
  const r = normalizeFindingRecord({ rule_id: 'ACCOV-C1', severity: 'CRITICAL', disposition: 'false-positive', reason: '' }, warnings);
  assert.equal(r.disposition, 'open');
  assert.ok(warnings.some((w) => /sin reason/.test(w)), 'la refutación se documenta o no vale');
});
