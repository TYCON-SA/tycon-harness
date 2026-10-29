#!/usr/bin/env node
/**
 * test-gate-scope.test.js — la clave `test_gate` de `.test-gate.yaml`: cuándo el portón acota a lo tocado.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib', 'test-gate-scope.js');
const { parseScope } = require(LIB);

test('T1 TestGateScope_Parse — touched con quién corre la completa acota; sin clave, mal escrita o sin full_suite_by corre todo', () => {
  // 🔴 mutación: aceptar scope touched sin full_suite_by, o un valor desconocido, acotaría sin respaldo.
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: touched\n  full_suite_by: "la CI del pedido"  # obligatoria\n'), { scope: 'touched', fullSuiteBy: 'la CI del pedido' });
  assert.deepStrictEqual(parseScope(null), { scope: 'full' });
  assert.deepStrictEqual(parseScope('evidence:\n  fe_paths:\n    - x\n'), { scope: 'full' });
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: full\n'), { scope: 'full' });
  assert.match(parseScope('test_gate:\n  scope: touched\n').problem, /pide full_suite_by/);
  assert.match(parseScope('test_gate:\n  scope: algunas\n  full_suite_by: x\n').problem, /touched o full/);
  assert.match(parseScope('test_gate: touched\n').problem, /tiene que ser un bloque/);
  // el bloque termina en la siguiente clave de primer nivel
  assert.deepStrictEqual(parseScope('test_gate:\n  scope: touched\nfull_suite_by: afuera\n').scope, 'full');
});

test('T2 TestGateScope_SoloLoCommiteado — la clave escrita en la carpeta sin commitear no acota', () => {
  // 🔴 mutación: leer la carpeta de trabajo dejaría a un agente acotar el portón con un Write sin rastro en el diff.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, '.test-gate.yaml'), 'test_gate:\n  scope: touched\n  full_suite_by: la CI\n');
  const sin = spawnSync('node', [LIB, repo], { encoding: 'utf8' });
  assert.strictEqual(sin.status, 10, sin.stdout);
  git('add', '.'); git('commit', '-qm', 'clave');
  const con = spawnSync('node', [LIB, repo], { encoding: 'utf8' });
  assert.strictEqual(con.status, 0, con.stderr);
  assert.strictEqual(con.stdout, 'la CI');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('T4 TestGateScope_AcotarPideFirma — la configuración que acota el portón es regla de la revisión de controles: cambiarla pide la firma del dueño', () => {
  // 🔴 mutación: sin la entrada en el inventario, quien commitea `test_gate: scope: touched` acota el portón sin firma.
  const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'ci', 'controls-from-base.json'), 'utf8'));
  const reglas = inv.controls.flatMap((c) => (c.rules || []).map((r) => (typeof r === 'string' ? r : r.path)));
  assert.ok(reglas.includes('.test-gate.yaml'), JSON.stringify(reglas));
});
