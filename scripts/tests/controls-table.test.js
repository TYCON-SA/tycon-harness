'use strict';
/**
 * controls-table.test.js — la tabla de controles armada con los registros de la carpeta de estado (sólo lee).
 *
 * Cada prueba arma su propia casa con los registros que necesita; ninguna lee la casa de quien corre las pruebas.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUION = path.join(__dirname, '..', 'metrics', 'controls-table.js');
const ct = require(GUION);

function casaNueva(t, registros = {}) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'controls-table-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(estado, { recursive: true });
  for (const [archivo, filas] of Object.entries(registros)) {
    fs.writeFileSync(path.join(estado, archivo), filas.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))).join('\n') + '\n');
  }
  return { casa, estado };
}
const correr = (casa, args = []) => spawnSync(process.execPath, [GUION, '--home', casa, ...args], { encoding: 'utf8', env: { ...process.env, HOME: casa, USERPROFILE: casa } });
const listado = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`);

// 🔴 Falla con: un freno contado en la columna equivocada, o una falsa alarma inventada en vez de «no medido».
test('ControlsTable_CuentaPorFrenoYRegla', (t) => {
  const { casa } = casaNueva(t, { 'frenos.jsonl': [
    { ts: '2026-10-30T10:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { ts: '2026-10-30T11:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { ts: '2026-10-30T12:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'escape' },
    { ts: '2026-10-30T12:30:00Z', freno: 'test-scope-guard', regla: 'suite-completa', veredicto: 'paso' },
    { ts: '2026-10-30T13:00:00Z', freno: 'push-referencia-fantasma', regla: 'referencia-fantasma', veredicto: 'aviso' },
    'no es json',
  ] });
  const r = ct.tabla({ home: casa, ahora: '2026-10-31T00:00:00Z' });
  assert.deepStrictEqual(r.conteo.controles.map((c) => [c.freno, c.regla, c.bloqueo, c.aviso, c.escape, c.paso]), [
    ['push-referencia-fantasma', 'referencia-fantasma', 0, 1, 0, 0],
    ['safety-guard', 'GIT-C1', 2, 0, 1, 0],
    ['test-scope-guard', 'suite-completa', 0, 0, 0, 1],
  ]);
  assert.strictEqual(r.frenos.malas, 1);
  assert.match(r.md, /\| safety-guard \| GIT-C1 \| 2 \| 0 \| 1 \| 0 \| no medido \|/);
  assert.match(r.md, /1 ilegible/);
});

// 🔴 Falla con: una firma delegada contada como de la persona, o las vías mezcladas.
test('ControlsTable_CuentaLasFirmasPorVia', (t) => {
  const { casa } = casaNueva(t, { 'frenos.jsonl': [], 'signatures.jsonl': [
    { ts: '2026-10-30T10:00:00Z', signature: 'save', via: 'window', delegated: false },
    { ts: '2026-10-30T11:00:00Z', signature: 'save', via: 'delegation', delegated: true },
    { ts: '2026-10-30T12:00:00Z', signature: 'extra-round', via: 'terminal', delegated: false },
  ] });
  const r = ct.tabla({ home: casa });
  assert.deepStrictEqual(r.conteo.firmas.map((f) => [f.firma, f.total, f.delegadas, f.vias]), [
    ['extra-round', 1, 0, { terminal: 1 }],
    ['save', 2, 1, { delegation: 1, window: 1 }],
  ]);
  assert.match(r.md, /\| save \| 2 \| 1 \| delegation: 1, window: 1 \|/);
  assert.match(r.md, /Ningún freno anotó/);
});

// 🔴 Falla con: un registro que no existe dicho como cero (no haberlo medido no es no haber frenado).
test('ControlsTable_SinRegistro_DiceNoMedido', (t) => {
  const { casa } = casaNueva(t);
  const r = ct.tabla({ home: casa });
  assert.strictEqual(r.frenos.estado, 'ausente');
  assert.strictEqual(r.firmas.estado, 'ausente');
  assert.match(r.md, /no medido \(no hay frenos\.jsonl\)/);
  assert.match(r.md, /no medido \(no hay signatures\.jsonl\)/);
  assert.doesNotMatch(r.md, /\| 0 \|/);
});

// 🔴 Falla con: --since que no filtra, o un renglón sin fecha que entra igual.
test('ControlsTable_Desde_FiltraPorFecha', (t) => {
  const { casa } = casaNueva(t, { 'frenos.jsonl': [
    { ts: '2026-10-01T10:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { ts: '2026-10-30T10:00:00Z', freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
    { freno: 'safety-guard', regla: 'GIT-C1', veredicto: 'bloqueo' },
  ] });
  const r = ct.tabla({ home: casa, desde: '2026-10-15' });
  assert.strictEqual(r.conteo.controles[0].bloqueo, 1);
  assert.match(r.md, /desde el 2026-10-15/);
  assert.strictEqual(r.frenos.sinFecha, 1, 'el renglón sin fecha se cuenta aparte');
  assert.match(r.md, /1 sin fecha \(fuera del período\)/);
});

// 🔴 Falla con: el guion que escribe en la carpeta de estado, o que no deja la tabla en --out.
test('ControlsTable_Guion_EscribeSoloElArchivoPedido', (t) => {
  const { casa, estado } = casaNueva(t, { 'frenos.jsonl': [{ ts: '2026-10-30T10:00:00Z', freno: 'safety-guard', regla: 'FS-C1', veredicto: 'bloqueo' }] });
  const antes = listado(estado);
  const out = path.join(casa, 'tabla.md');
  const r = correr(casa, ['--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /\| safety-guard \| FS-C1 \| 1 \|/);
  assert.deepStrictEqual(listado(estado), antes, 'no tocó la carpeta de estado');
  // sin --out, a la salida; con --json, los conteos
  assert.match(correr(casa).stdout, /# Tabla de controles/);
  assert.strictEqual(JSON.parse(correr(casa, ['--json']).stdout).controles[0].regla, 'FS-C1');
  // un --out que no se puede escribir, o un argumento roto: sale 2
  assert.strictEqual(correr(casa, ['--out', path.join(casa, 'no', 'existe', 't.md')]).status, 2);
  assert.strictEqual(correr(casa, ['--since', 'ayer']).status, 2);
  assert.strictEqual(correr(casa, ['--out']).status, 2);
});
