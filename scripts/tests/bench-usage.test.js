#!/usr/bin/env node
'use strict';
// bench-usage.test.js — el corredor del banco con `--help` o con un argumento que no entiende muestra el uso y sale sin
// correr un solo caso. Antes los ignoraba y corría el banco entero.
// 🔴 Falla con: correr algún caso con `--help`/`-h`, con una opción que no existe, con un valor pegado con `=`, con una
//    opción sin su valor o con un valor que no acepta; o salir 0 ante un argumento que no entiende.
// Corre con una HOME de prueba y una lista de casos de juguete: el único caso deja una marca si llega a correr.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'controls-bench', 'runner.js');

function laboratorio(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-uso-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'casa');
  fs.mkdirSync(home);
  const marca = path.join(dir, 'corrio');
  const script = path.join(dir, 'gancho.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marca)}, 'si'); console.log('sale');\n`);
  fs.mkdirSync(path.join(dir, 'casos'));
  const cases = [{ id: 'marca', type: 'must-emit', tools: ['claude', 'codex'], stdin: { source: 'startup' }, expect: { stdout_re: ['sale'] } }];
  fs.writeFileSync(path.join(dir, 'casos', '01-juguete.json'), JSON.stringify({ hooks: [{ hook: 'gancho.js', script, event: 'SessionStart', matcher: '*', cases }] }));
  fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify({ cases: {} }));
  const correr = (args) => spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_BENCH_CASES_DIR: path.join(dir, 'casos'), TYCON_BENCH_BASELINE: path.join(dir, 'base.json') },
  });
  return { dir, marca, correr };
}

test('T1 Ayuda_MuestraElUsoYNoCorreNada', (t) => {
  const L = laboratorio(t);
  for (const args of [['--help'], ['-h'], ['--tool', 'both', '--help']]) {
    const r = L.correr(args);
    assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Uso: node runner\.js/, args.join(' '));
    assert.ok(!fs.existsSync(L.marca), `con ${args.join(' ')} corrió un caso`);
  }
});

test('T2 ArgumentoQueNoEntiende_DiceCualYSaleSinCorrer', (t) => {
  const L = laboratorio(t);
  for (const [args, motivo] of [
    [['--verbosity'], /no conozco la opción --verbosity/],
    [['--only=marca'], /no conozco la opción --only=marca/],
    [['--tool'], /--tool necesita un valor/],
    [['--only', '--list'], /--only necesita un valor/],
    [['--tool', 'gpt'], /--tool acepta claude, codex, both, no «gpt»/],
    [['--baseline', 'quizas'], /--baseline acepta write, check/],
    [['57-worktree-sweep'], /no esperaba «57-worktree-sweep»/],
  ]) {
    const r = L.correr(args);
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, motivo, args.join(' '));
    assert.match(r.stderr, /Uso: node runner\.js/, args.join(' '));
    assert.ok(!fs.existsSync(L.marca), `con ${args.join(' ')} corrió un caso`);
  }
});

test('T3 ConArgumentosQueEntiende_Corre (la marca de las otras dos se ve)', (t) => {
  const L = laboratorio(t);
  const r = L.correr(['--tool', 'claude', '--only', 'marca', '--json', path.join(L.dir, 'reporte.json')]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(L.marca), 'el caso de juguete no corrió: la marca de T1 y T2 no prueba nada');
});
