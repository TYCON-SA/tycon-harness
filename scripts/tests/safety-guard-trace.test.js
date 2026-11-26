#!/usr/bin/env node
'use strict';
// safety-guard-trace.test.js — con TYCON_SAFETY_TRACE, el freno de seguridad anota cuánto tarda cada node que lanza (y
// lo que lanzan ellos) y su propio total: es para encontrar el paso que se vuelve lento con la máquina cargada. Sin la
// variable no anota nada, y con ella no cambia ninguna decisión.
// stable-data: lee el reloj sólo para medir cuánto tarda el freno; no depende de la fecha.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'hooks', 'safety-guard-pre.sh');
const SKIP = process.platform === 'win32' && 'el jq de mentira es un guion sin .exe y Windows no lo lanza; el freno es el mismo guion, se mide en la Mac';
const FIRMA_MAQUETA = 'node "$HOME/arnes/scripts/marker.js" approve-mockup --approved "lo que escribió el dev" --for-session sesion-de-prueba';

function correr(command, { env = {}, bin } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-trace-home-'));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: os.tmpdir() });
  return spawnSync('bash', [GUARD], {
    input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH, ...env },
  });
}
const nuevo = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-trace-')), 'tiempos.jsonl');
const renglones = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const delFreno = (rs) => rs.filter((r) => r.guion === 'safety-guard-pre.sh');

test('T108a SafetyTrace_SinLaVariable_NoAnota', { skip: SKIP }, () => {
  const f = nuevo();
  const r = correr('ls', { env: { TYCON_SAFETY_TRACE_FILE: f } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(renglones(f), [], 'sin TYCON_SAFETY_TRACE no se anota nada, aunque la ruta esté puesta');
});

test('T108b SafetyTrace_ComandoComun_AnotaElTotalDelFreno', { skip: SKIP }, () => {
  // 🔴 rojo si: el freno no anota su total al salir
  const f = nuevo();
  const r = correr('ls', { env: { TYCON_SAFETY_TRACE: f } });
  assert.strictEqual(r.status, 0, r.stderr);
  const fin = delFreno(renglones(f));
  assert.strictEqual(fin.length, 1, JSON.stringify(renglones(f)));
  assert.strictEqual(fin[0].evento, 'termina');
  assert.strictEqual(fin[0].salida, 0);
  assert.ok(Number.isInteger(fin[0].ms) && fin[0].ms >= 0, JSON.stringify(fin[0]));
});

test('T108c SafetyTrace_UnaFirma_CadaNodeArrancaYTermina_SinLosValores', { skip: SKIP }, () => {
  // 🔴 rojo si: los node del freno no se miden (sin NODE_OPTIONS), o se anota lo que escribió el dev
  const f = nuevo();
  correr(FIRMA_MAQUETA, { env: { TYCON_SAFETY_TRACE: f } });
  const rs = renglones(f);
  const fin = delFreno(rs);
  assert.strictEqual(fin.length, 1, JSON.stringify(rs));
  const nodes = rs.filter((r) => r.guion !== 'safety-guard-pre.sh');
  assert.ok(nodes.some((r) => r.guion === 'run-close.js' && r.evento === 'arranca'), JSON.stringify(nodes));
  for (const pid of new Set(nodes.map((r) => r.pid))) {
    const de = nodes.filter((r) => r.pid === pid);
    assert.deepStrictEqual(de.map((r) => r.evento), ['arranca', 'termina'], `${de[0].guion}: ${JSON.stringify(de)}`);
    assert.ok(Number.isInteger(de[1].ms), JSON.stringify(de[1]));
  }
  // todos de la misma corrida del freno
  assert.deepStrictEqual([...new Set(rs.map((r) => r.corrida))], [fin[0].corrida]);
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /escribió el dev/, 'nunca los valores del comando');
});

test('T108f SafetyTrace_ElCargador_AnotaGuionYSubcomando_NuncaLosValores', () => {
  // 🔴 rojo si: el cargador anota los argumentos (una cita o un comando pueden traer lo que escribió el dev)
  const f = nuevo();
  const guion = path.join(path.dirname(f), 'marker.js');
  fs.writeFileSync(guion, 'process.exitCode = 3;\n');
  const pre = path.join(__dirname, '..', 'lib', 'safety-trace.js');
  const r = spawnSync(process.execPath, ['--require', pre, guion, 'approve-mockup', '--approved', 'lo que escribió el dev'],
    { encoding: 'utf8', env: { ...process.env, TYCON_SAFETY_TRACE_FILE: f, TYCON_SAFETY_TRACE_RUN: '123-456' } });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.strictEqual(r.stdout + r.stderr, '', 'no escribe en la salida del guion');
  const rs = renglones(f);
  assert.deepStrictEqual(rs.map((x) => [x.guion, x.sub, x.evento, x.corrida]), [['marker.js', 'approve-mockup', 'arranca', '123-456'], ['marker.js', 'approve-mockup', 'termina', '123-456']]);
  assert.strictEqual(rs[1].salida, 3);
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /escribió el dev|--approved/);
  // un primer argumento que no es una palabra sola (una ruta, un valor) no se anota
  const g = nuevo();
  spawnSync(process.execPath, ['--require', pre, guion, '/ruta/de/algo'], { env: { ...process.env, TYCON_SAFETY_TRACE_FILE: g } });
  assert.strictEqual(renglones(g)[0].sub, null);
  // con `node -e <código> <valor>`, el valor no es un guion: no se anota (del pase adversarial)
  const h = nuevo();
  spawnSync(process.execPath, ['--require', pre, '-e', '0', 'valor-secreto'], { env: { ...process.env, TYCON_SAFETY_TRACE_FILE: h } });
  assert.deepStrictEqual([renglones(h)[0].guion, renglones(h)[0].sub], ['(-e)', null]);
  assert.doesNotMatch(fs.readFileSync(h, 'utf8'), /valor-secreto/);
});

test('T108g SafetyTrace_GitBash_RutaConBarrasHaciaAdelante_YLaMismaDecision', { skip: SKIP }, () => {
  // 🔴 rojo si: la ruta va en la forma de Windows (C:\…), que dentro de las comillas de NODE_OPTIONS pierde las barras y
  // ningún node del freno arranca. Un cygpath de juguete hace lo de Git Bash: -w con barras invertidas, -m y -u igual.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-trace-cyg-'));
  // cygpath de juguete (safety-guard-trace.test.js)
  fs.writeFileSync(path.join(bin, 'cygpath'), '#!/bin/sh\nif [ "$1" = "-w" ]; then printf "%s" "$2" | tr "/" "\\\\"; else printf "%s" "$2"; fi\n', { mode: 0o755 });
  const f = nuevo();
  const con = correr(FIRMA_MAQUETA, { bin, env: { TYCON_SAFETY_TRACE: f } });
  const sin = correr(FIRMA_MAQUETA, { bin });
  assert.strictEqual(con.status, sin.status, `${con.stderr}\n---\n${sin.stderr}`);
  const nodes = renglones(f).filter((r) => r.guion !== 'safety-guard-pre.sh');
  assert.ok(nodes.some((r) => r.guion === 'run-close.js' && r.evento === 'termina' && r.salida === 0), JSON.stringify(renglones(f)));
});

test('T108d SafetyTrace_NoCambiaLaDecision', { skip: SKIP }, () => {
  const f = nuevo();
  const r = correr('rm -rf /', { env: { TYCON_SAFETY_TRACE: f } });
  assert.strictEqual(r.status, 2, 'frena igual que sin la medición');
  assert.strictEqual(delFreno(renglones(f))[0].salida, 2);
});

test('T108e SafetyTrace_ElRelojCorta_AnotaElTotalConSalida2', { skip: SKIP }, () => {
  // el caso que se quiere medir: el freno no llega a tiempo
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-trace-bin-'));
  // jq de juguete (safety-guard-trace.test.js): se queda esperando
  fs.writeFileSync(path.join(bin, 'jq'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const f = nuevo();
  const r = correr('ls', { bin, env: { TYCON_SAFETY_TRACE: f, TYCON_SAFETY_TIMEOUT_S: '2' } });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const fin = delFreno(renglones(f));
  assert.strictEqual(fin.length, 1, JSON.stringify(renglones(f)));
  assert.strictEqual(fin[0].salida, 2);
  assert.ok(fin[0].ms >= 1500, JSON.stringify(fin[0]));
});
