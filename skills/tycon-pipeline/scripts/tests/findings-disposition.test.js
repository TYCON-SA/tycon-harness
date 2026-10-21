'use strict';

/**
 * findings-disposition.test.js — la disposition `refuted` y el fin del aplanado mudo.
 *
 * Caso: un CRITICAL falso del story-validator se escribe con `disposition:"refuted"` y, si el schema no lo conoce,
 * `normalizeFindingRecord` lo aplana a 'open' EN SILENCIO. Resultado: el falso positivo
 * cuenta como deuda no accionada en las métricas, y write-followups lo persiste como checkbox abierto en la story
 * (deuda fantasma). Tres garantías, cada una con su test:
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
  // El laboratorio trae su registro de revisores: `write-findings`
  // valida el firmante contra el roster de la corrida y, si no puede, AVISA. Sin roster acá, cada
  // caso de este archivo se llevaría de yapa un aviso que no tiene nada que ver con lo que mide
  // —la `disposition`— y los asserts sobre `warnings` dejarían de hablar de lo suyo.
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

// Un `refuted` sólo se escribe con la constancia de un verificador que no es quien implementó: el
// laboratorio la deja en la carpeta de la corrida, con el mismo armado que usa `record-refutation`.
function dejarConstancia(runDir, { reviewer, rule, file }) {
  const refutation = require(path.join(__dirname, '..', 'lib', 'refutation.js'));
  const finding = { reviewer, rule, file, line: 1 };
  const c = refutation.build({ finding, authorReason: 'falso', verifier: { agent: 'general-purpose@2026-01-01T00:00:00Z', model: 'sonnet' },
    verdict: 'refutado', command: 'node probe.js', output: 'no se da' });
  fs.mkdirSync(path.join(runDir, 'refutations'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'refutations', `${refutation.idOf(finding)}.json`), JSON.stringify(c));
  // write-findings revalida al verificador contra el registro de lanzamientos (el HOME de juguete del laboratorio):
  // una constancia sola no alcanza, el agente tiene que figurar como lanzado.
  const ledger = path.join(path.dirname(path.dirname(path.dirname(runDir))), 'home', '.claude', '.tycon-pipeline', 'advisor-runs');
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(path.join(ledger, 's1.jsonl'), `${JSON.stringify({ ts: '2026-01-01T00:00:00Z', advisor: 'general-purpose', model: 'sonnet' })}\n`);
}

function writeFindings(labDir, spec, findings) {
  const fj = path.join(labDir, 'in.json');
  fs.writeFileSync(fj, JSON.stringify(findings));
  const out = execFileSync('node', [PIPELINE, 'write-findings', '--repo', labDir, '--story', spec, '--findings', fj], { encoding: 'utf8', env: { ...process.env, HOME: path.join(labDir, 'home'), USERPROFILE: path.join(labDir, 'home') } });
  return JSON.parse(out);
}

test('refuted se conserva, cuenta aparte, y NO queda como open', () => {
  const { d, spec, runDir } = lab();
  dejarConstancia(runDir, { reviewer: 'a', rule: 'VAL-C1', file: 'x.cs' });
  const r = writeFindings(d, spec, [
    { rule_id: 'VAL-C1', severity: 'CRITICAL', advisor: 'a', file: 'x.cs', line: 1, disposition: 'refuted', reason: 'falso positivo: releído de disco, el bloque no está' },
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
    { rule_id: 'Q-1', severity: 'CRITICAL', advisor: 'a', file: 'x.cs', line: 1, disposition: 'refuted' },
  ]);
  assert.strictEqual(r.counts.refuted, 0);
  assert.strictEqual(r.counts.open, 1);
  assert.ok(r.warnings && r.warnings.some((w) => /sin reason/.test(w)));
});

test('write-followups: refuted queda [x] (cerrado), no deuda fantasma [ ]', () => {
  const { d, spec, runDir } = lab();
  dejarConstancia(runDir, { reviewer: 'a', rule: 'VAL-C1', file: 'x.cs' });
  const r = writeFindings(d, spec, [
    { rule_id: 'VAL-C1', severity: 'CRITICAL', advisor: 'a', file: 'x.cs', line: 1, disposition: 'refuted', reason: 'falso, refutado con evidencia' },
    { rule_id: 'W-1', severity: 'WARNING', advisor: 'a', file: 'y.cs', disposition: 'open', reason: 'deuda real' },
  ]);
  execFileSync('node', [PIPELINE, 'write-followups', '--story', spec, '--findings', r.path], { encoding: 'utf8' });
  const story = fs.readFileSync(spec, 'utf8');
  assert.match(story, /- \[x\] \*\*\[CRITICAL\]\*\* VAL-C1/);
  assert.match(story, /- \[ \] \*\*\[WARNING\]\*\* W-1/);
});

const { normalizeFindingRecord } = require(PIPELINE);

// ── 5. «false-positive» es «refuted» ─────────────────────────────────────────────────────
// El orquestador lo escribe así cuando un CRITICAL de mech-check lo refuta el advisor especializado.
// Coaccionarlo a 'open' con un aviso que nadie lee deja una deuda fantasma en la story.
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

// ── Lo de antes sigue igual ────────────────────────────────────────────────────
// Guarda de no regresión: `fixed`, `waived`, `deferred` y `open` sin constancia se escriben tal cual.
test('Disposiciones_LoDeAntesSigueIgual', () => {
  const { d, spec } = lab();
  const r = writeFindings(d, spec, ['fixed', 'waived', 'deferred', 'open'].map((disposition, i) => (
    { rule_id: `K-${i}`, severity: 'WARNING', advisor: 'a', file: 'z.cs', disposition, reason: 'r' })));
  assert.deepStrictEqual([r.counts.fixed, r.counts.waived, r.counts.deferred, r.counts.open, r.counts.refuted], [1, 1, 1, 1, 0]);
  assert.ok(!r.warnings, 'sin avisos');
  const written = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.deepStrictEqual(written.map((f) => f.disposition), ['fixed', 'waived', 'deferred', 'open']);
  assert.ok(written.every((f) => !('refutation' in f)), 'ninguno trae constancia');
});
