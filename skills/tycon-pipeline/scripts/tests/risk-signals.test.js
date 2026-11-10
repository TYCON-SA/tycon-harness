#!/usr/bin/env node
'use strict';
/**
 * risk-signals.test.js — las dos señales del riesgo, como aviso.
 *
 *   T24 «ninguna prueba lo ataja»: un archivo de código a modificar que ningún archivo de prueba nombra avisa; uno
 *       nombrado en el repo o en un compañero declarado, no; `specs/qa/` y `.advisors/` no se miran
 *   T25 concurrencia: avisa con la ruta declarada en `concurrency_paths:`; sin declarar, nada, aunque el archivo use colas
 *   T26 las señales no cambian el riesgo, la delicada ni el pase
 *
 * stable-data: arma repos de git en carpetas temporales; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/risk-signals.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const pipeline = require(path.join(SCRIPTS, 'pipeline.js'));
const scope = require(path.join(SCRIPTS, 'lib', 'batch-scope.js'));

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
}
/** Un repo con una historia que modifica `modificar`; `archivos`: los demás archivos del repo (`{ ruta: contenido }`). */
function repo({ modificar = ['src/cola.js', 'src/precio.js'], archivos = {}, advisors = null } = {}) {
  const dir = tmp('signals-');
  execFileSync('git', ['init', '-q', '-b', 'feat/x', dir]);
  const story = path.join(dir, 'specs', 'story-9.6-senales.md');
  escribir(dir, 'specs/story-9.6-senales.md', ['---', 'story: "9.6"', 'title: "señales"', 'status: ready-for-dev', 'files_to_modify:',
    ...modificar.map((f) => `  - ${f}`), '---', '# Story 9.6', ''].join('\n'));
  for (const f of modificar) escribir(dir, f, 'module.exports = 1;\n');
  for (const [rel, txt] of Object.entries(archivos)) escribir(dir, rel, txt);
  if (advisors) escribir(dir, '.tycon/advisors.yaml', advisors);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  return { dir, story };
}
const senales = (r, raices) => scope.senales({ story: r.story, repo: r.dir, raices: raices || [r.dir] });

test('T24 Senal_SinPrueba_Avisa — @story-8.168 @ac-13', () => {
  // sin ninguna prueba que los nombre: los dos avisan; las pruebas de specs/qa/ y .advisors/ no cuentan
  const sin = repo({ archivos: { 'specs/qa/cola.test.js': "require('../../src/cola')\n", '.advisors/precio.test.js': 'precio\n' } });
  const a = senales(sin);
  assert.ok(a.some((w) => /ninguna prueba lo ataja: src\/cola\.js/.test(w)), JSON.stringify(a));
  assert.ok(a.some((w) => /ninguna prueba lo ataja: src\/precio\.js/.test(w)), JSON.stringify(a));
  // uno nombrado por una prueba del repo, no avisa
  const con = repo({ archivos: { 'tests/cola.test.js': "const cola = require('../src/cola');\n" } });
  const b = senales(con);
  assert.ok(!b.some((w) => /src\/cola\.js/.test(w)), JSON.stringify(b));
  assert.ok(b.some((w) => /src\/precio\.js/.test(w)));
  // nombrado en un compañero declarado, tampoco
  const comp = tmp('companero-');
  execFileSync('git', ['init', '-q', comp]);
  escribir(comp, 'tests/precio.test.js', "require('precio')\n");
  execFileSync('git', ['-C', comp, 'add', '-A']);
  assert.ok(!senales(con, [con.dir, comp]).some((w) => /ninguna prueba/.test(w)));
});

test('T25 Senal_Concurrencia_SoloDeclarada — @story-8.168 @ac-14', () => {
  const colas = "const { Worker } = require('worker_threads'); queue.push(x);\n";
  // sin declarar: nada, aunque el archivo use colas e hilos
  const sinDecl = repo({ modificar: ['src/cola.js'], archivos: { 'src/cola.js': colas, 'tests/cola.test.js': 'cola\n' } });
  assert.deepStrictEqual(senales(sinDecl).filter((w) => /concurrencia/.test(w)), []);
  // con la ruta declarada: avisa
  const decl = repo({ modificar: ['src/cola.js'], archivos: { 'tests/cola.test.js': 'cola\n' }, advisors: 'concurrency_paths:\n  - src/cola.js\n' });
  assert.ok(senales(decl).some((w) => /concurrencia: src\/cola\.js/.test(w)));
  // una carpeta declarada cubre lo que tiene adentro
  const carpeta = repo({ modificar: ['src/workers/a.js'], archivos: { 'tests/a.test.js': 'a\n' }, advisors: 'concurrency_paths: [src/workers]\n' });
  assert.ok(senales(carpeta).some((w) => /concurrencia: src\/workers\/a\.js/.test(w)));
});

test('T26 Senales_NoCambianElRiesgo — @story-8.168 @ac-15', () => {
  const quieta = repo({ modificar: ['src/cola.js'], archivos: { 'tests/cola.test.js': 'cola\n' } });
  const avisa = repo({ modificar: ['src/cola.js'], advisors: 'concurrency_paths:\n  - src/cola.js\n' });
  assert.ok(senales(avisa).length >= 2, 'la segunda historia tiene las dos señales');
  for (const f of ['computeRiskClass', 'computeDelicate']) {
    const a = pipeline[f]({ story: quieta.story, repo: quieta.dir });
    const b = pipeline[f]({ story: avisa.story, repo: avisa.dir });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b).split(avisa.dir).join('R')), JSON.parse(JSON.stringify(a).split(quieta.dir).join('R')), f);
  }
  // las señales salen como aviso en risk-class y en el portón del pase, sin cambiar su resultado
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'sig-sin-corrida', TYCON_HOME: '' };
  const cli = (cmd, ...extra) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), cmd, '--story', avisa.story, '--repo', avisa.dir, ...extra], { encoding: 'utf8', cwd: avisa.dir, env, input: '' });
    assert.ok(r.stdout.trim(), `${cmd}: ${r.status} ${r.stderr.slice(0, 600)}`);
    return JSON.parse(r.stdout);
  };
  const rc = cli('risk-class');
  assert.ok(rc.warnings && rc.warnings.some((w) => /ninguna prueba/.test(w)) && rc.warnings.some((w) => /concurrencia/.test(w)), JSON.stringify(rc.warnings));
  assert.strictEqual(rc.risk, pipeline.computeRiskClass({ story: avisa.story, repo: avisa.dir }).risk);
  const dr = cli('deep-review-gate', '--files', 'src/cola.js');
  assert.ok(dr.warnings && dr.warnings.some((w) => /concurrencia/.test(w)), JSON.stringify(dr));
});

// 🔴 Falla con: las señales calladas por una lista en línea, un comentario entre los archivos o una carpeta declarada con
// barra final (lo encontró el pase adversarial de la 8.245).
test('P5 Senales_ListaEnLineaComentarioYBarraFinal — @story-8.168 @ac-13 @ac-14', () => {
  const enLinea = repo({ modificar: ['src/workers/a.js'], advisors: 'concurrency_paths: [src/workers/]\n' });
  escribir(enLinea.dir, 'specs/story-9.6-senales.md', ['---', 'story: "9.6"', 'status: ready-for-dev',
    'files_to_modify: [src/workers/a.js]  # el único', '---', '# Story 9.6', ''].join('\n'));
  const a = senales(enLinea);
  assert.ok(a.some((w) => /ninguna prueba lo ataja: src\/workers\/a\.js/.test(w)), JSON.stringify(a));
  assert.ok(a.some((w) => /concurrencia: src\/workers\/a\.js/.test(w)), JSON.stringify(a));
  const conComentario = repo({ modificar: ['src/cola.js', 'src/precio.js'] });
  escribir(conComentario.dir, 'specs/story-9.6-senales.md', ['---', 'story: "9.6"', 'status: ready-for-dev', 'files_to_modify:',
    '  - src/cola.js', '  # el de abajo también', '', '  - src/precio.js', '---', '# Story 9.6', ''].join('\n'));
  const b = senales(conComentario);
  assert.ok(b.some((w) => /ninguna prueba lo ataja: src\/precio\.js/.test(w)), JSON.stringify(b));
});

// 🔴 Falla con: un `**/` en concurrency_paths que exigía al menos una carpeta, y callaba el aviso de src/lock.js con
// `src/**/lock.js` o de un queue.js en la raíz con `**/queue.js`.
test('Q21 Senal_Concurrencia_DobleAsteriscoEsCeroOMasCarpetas — @story-8.168 @ac-14', () => {
  const r = repo({ modificar: ['src/lock.js', 'src/a/b/lock.js', 'queue.js', 'srclock.js', 'src/locks.js'],
    advisors: 'concurrency_paths:\n  - src/**/lock.js\n  - "**/queue.js"\n' });
  const avisos = senales(r).filter((w) => /^concurrencia:/.test(w));
  const con = (f) => avisos.some((w) => w.startsWith(`concurrencia: ${f} `));
  for (const f of ['src/lock.js', 'src/a/b/lock.js', 'queue.js']) assert.ok(con(f), `${f}: ${JSON.stringify(avisos)}`);
  for (const f of ['srclock.js', 'src/locks.js']) assert.ok(!con(f), `${f}: ${JSON.stringify(avisos)}`);
});

// 🔴 Falla con: un advisors.yaml que no se lee, o un repo cuyas pruebas no se listan, tomados como «sin declaración» o
// «ninguna prueba» (revisor de fallos silenciosos, vuelta 2): la señal dice que no se midió.
test('R2 Senales_LoQueNoSeLee_DiceNoMedido — @story-8.168 @ac-13 @ac-14', () => {
  const r = repo({ modificar: ['src/cola.js'] });
  fs.mkdirSync(path.join(r.dir, '.tycon', 'advisors.yaml'), { recursive: true });
  const a = senales(r);
  assert.ok(a.some((w) => /^concurrencia: no medido, no pude leer \.tycon\/advisors\.yaml/.test(w)), JSON.stringify(a));
  const noRepo = tmp('sin-git-');
  const b = senales(r, [r.dir, noRepo]);
  assert.ok(b.some((w) => /^ninguna prueba lo ataja: no medido, no pude listar las pruebas de/.test(w)), JSON.stringify(b));
  assert.ok(!b.some((w) => /ningún archivo de prueba lo nombra/.test(w)), 'sin listar, no avisa sin base');
  // una historia que no se lee tampoco es «sin señales»
  const c = scope.senales({ story: path.join(r.dir, 'specs', 'no-existe.md'), repo: r.dir, raices: [r.dir] });
  assert.ok(c.some((w) => /^ninguna prueba lo ataja: no medido, no pude leer la historia/.test(w)), JSON.stringify(c));
});
