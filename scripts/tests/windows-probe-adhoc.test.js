#!/usr/bin/env node
/**
 * windows-probe-adhoc.test.js — las sondas del arreglo rápido del ensayo de Windows llegan a la firma.
 *
 * Lo que no se puede perder: el ensayo de Windows (scripts/tests/windows/waiver-probe.js) pide el arreglo rápido como
 * lo pediría una sesión o el dueño, para medir que la firma por terminal abre su ventana y vence, y que el candado frena
 * al agente. Si al pedido le falta algo que `marker.js adhoc set` exige, el comando sale 2 antes de la ventana: el
 * ensayo da tres hallazgos que no midieron nada y la firma en Windows queda sin medir. El ensayo corre sólo en Windows;
 * esto corre en cualquier máquina, con el chequeo previo de la firma, que comprueba lo que el comando exige sin firmar
 * ni escribir.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const MARKER = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const PROBE = path.join(ROOT, 'scripts', 'tests', 'windows', 'waiver-probe.js');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** Un repo de juguete con el archivo que nombran las sondas, como el del ensayo, y una HOME vacía. */
function laboratorio(t) {
  const root = tmp('probe-adhoc-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'casa');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  const fecha = '2026-01-01T00:00:00Z';
  const env = { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha };
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', ...a], { encoding: 'utf8', env });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'regla.txt'), 'una regla\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  return { repo, home };
}

function chequeoPrevio(lab, args) {
  const env = { ...process.env, HOME: lab.home, USERPROFILE: lab.home, TYCON_SIGN_PRECHECK: '1' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_TEST_CONTEXT']) delete env[k];
  const r = spawnSync(process.execPath, [MARKER, ...args], { cwd: lab.repo, env, encoding: 'utf8', input: '', timeout: 60000 });
  return { status: r.status, dice: `${r.stdout || ''}${r.stderr || ''}` };
}

test('T1 Sondas_TraenLoQueExigeAdhocSet — las tres sondas pasan el chequeo previo y llegan a la firma', (t) => {
  // 🔴 mutación: sacar «datos» (--data / "datos") o la lista de archivos (--file / "allowedFiles") de una sonda.
  const { ADHOC_SONDAS } = require(PROBE);
  assert.deepStrictEqual(Object.keys(ADHOC_SONDAS || {}).sort(), ['agente', 'banderas', 'json'], 'waiver-probe.js publica las tres sondas');
  const lab = laboratorio(t);
  for (const [nombre, args] of Object.entries(ADHOC_SONDAS)) {
    const r = chequeoPrevio(lab, args);
    assert.doesNotMatch(r.dice, /falta "datos"|falta la lista de archivos/, `${nombre}: el pedido no está completo`);
    assert.strictEqual(r.status, 0, `${nombre}: el chequeo previo no llegó a la firma (salió ${r.status}): ${r.dice.slice(0, 400)}`);
  }
});

test('T2 Sondas_SinDatos_NoLlegan — sin «datos» el chequeo previo frena: la prueba de arriba mide algo', (t) => {
  // 🔴 mutación: que `adhoc set` deje de exigir «datos» (entonces el ensayo ya no necesita mandarlo y esto lo dice).
  const lab = laboratorio(t);
  const r = chequeoPrevio(lab, ['adhoc', 'set', '--reason', 'sonda de la ventana', '--file', 'regla.txt', '--terminal', '--for-session', 'waiver-adhoc']);
  assert.strictEqual(r.status, 2, r.dice);
  assert.match(r.dice, /falta "datos"/);
});
