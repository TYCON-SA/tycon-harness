'use strict';
// workflow-lite-args-file.test.js — los args del pase llegan en un archivo, no en la línea de comando.
//
// Lo que no se puede perder:
//   · `--args-file <ruta>` le da al guion los mismos args que `--args '<json>'`, sin importar cuánto pesen: en Windows
//     la línea de comando tiene tope (unos 32 KB) y los args de la revisión del plan pesan 74-81 KB;
//   · un archivo que no existe, que no es JSON, o `--args` y `--args-file` juntos salen 1 sin correr el guion ni escribir
//     el resultado; un BOM al principio se tolera (así guarda el JSON más de un editor de Windows);
//   · el comando que imprime la revisión del plan pasa la ruta del archivo, y su largo no depende de los args;
//   · los pasos del pipeline no le dicen al agente que pegue el JSON de args en la línea de comando.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const LITE = path.join(SCRIPTS, 'workflow-lite.js');
const STEPS = path.join(SCRIPTS, '..', 'steps');

function carpeta(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wflite-args-file-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Un guion que devuelve los args que recibió, sin lanzar agentes. */
function guionEco(lab) {
  const wf = path.join(lab, 'eco.workflow.js');
  fs.writeFileSync(wf, 'return { medido: true, eco: args }');
  return wf;
}

function correr(lab, extra, { conOut = true } = {}) {
  const out = path.join(lab, 'r.json');
  const r = spawnSync(process.execPath, [LITE, guionEco(lab), ...extra, ...(conOut ? ['--out', out] : [])], { cwd: lab, encoding: 'utf8', timeout: 60000 });
  return { r, out };
}

// 🔴 Falla con: workflow-lite.js que ignora `--args-file` (el guion recibe {} y la revisión corre sin su historia).
test('T1 ArgsFile_LosArgsLleganAlGuion — 300 KB de args en un archivo llegan enteros', (t) => {
  const lab = carpeta(t);
  const args = { repo: lab, modo: 'plan', texto: 'x'.repeat(300 * 1024) };
  const archivo = path.join(lab, 'args.json');
  fs.writeFileSync(archivo, JSON.stringify(args));
  const { r, out } = correr(lab, ['--args-file', archivo]);
  assert.strictEqual(r.status, 0, r.stderr);
  const eco = JSON.parse(fs.readFileSync(out, 'utf8')).eco;
  assert.strictEqual(eco.modo, 'plan');
  assert.strictEqual(eco.texto.length, 300 * 1024);
});

test('T2 ArgsFile_ConBOM — un archivo guardado con BOM se lee igual', (t) => {
  const lab = carpeta(t);
  const archivo = path.join(lab, 'args.json');
  fs.writeFileSync(archivo, `﻿${JSON.stringify({ repo: lab, n: 7 })}`);
  const { r, out } = correr(lab, ['--args-file', archivo]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).eco.n, 7);
});

test('T3 ArgsFile_ArchivoMalo_Sale1SinCorrer — que no existe, que no es JSON, sin ruta, repetido, o con --args a la vez', (t) => {
  const lab = carpeta(t);
  const roto = path.join(lab, 'roto.json');
  fs.writeFileSync(roto, '{ esto no es json');
  const bueno = path.join(lab, 'bueno.json');
  fs.writeFileSync(bueno, '{}');
  const casos = [
    [['--args-file', path.join(lab, 'no-esta.json')], /no se pudo leer/],
    [['--args-file', roto], /no es JSON/],
    [['--args-file', '--runners', 'x'], /sin archivo/],
    [['--args-file='], /sin archivo/],
    [['--args', '{}', '--args-file', bueno], /una sola/],
    [['--args-file', bueno, '--args-file', bueno], /más de una vez/],
  ];
  for (const [extra, motivo] of casos) {
    const { r, out } = correr(lab, extra);
    assert.strictEqual(r.status, 1, `${extra.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, motivo, extra.join(' '));
    assert.ok(!fs.existsSync(out), `${extra.join(' ')}: no escribe el resultado`);
  }
  // como último argumento de verdad, sin nada después
  const { r } = correr(lab, ['--args-file'], { conOut: false });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /sin archivo/);
});

test('T6 ArgsFile_ConIgual — --args-file=<archivo> se lee igual que con espacio', (t) => {
  const lab = carpeta(t);
  const archivo = path.join(lab, 'args.json');
  fs.writeFileSync(archivo, JSON.stringify({ repo: lab, n: 9 }));
  const { r, out } = correr(lab, [`--args-file=${archivo}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).eco.n, 9);
});

// 🔴 Falla con: el comando de la revisión del plan que pega el JSON en la línea de comando (`--args "$(cat …)"`).
test('T4 PlanReview_ElComandoPasaLaRuta — el comando lleva --args-file con la ruta y no el contenido', () => {
  const PR = require('../lib/plan-review.js');
  const cmd = PR.comandoLite('/tmp/a b/args.json', '/tmp/r.json', { order: ['claude'], integration: { runners: { claude: { label: 'claude' } } } });
  assert.match(cmd, /--args-file '\/tmp\/a b\/args\.json'/);
  assert.doesNotMatch(cmd, /\$\(cat/);
  assert.doesNotMatch(cmd, /--args /);
});

// 🔴 Falla con: un paso que le dice al agente `workflow-lite.js … --args '<JSON>'`.
test('T5 Pasos_NoPeganLosArgsEnLaLinea — ningún paso pasa el JSON de args a workflow-lite.js en la línea de comando', () => {
  const malos = [];
  for (const f of fs.readdirSync(STEPS).filter((x) => x.endsWith('.md'))) {
    const lineas = fs.readFileSync(path.join(STEPS, f), 'utf8').split('\n');
    lineas.forEach((l, i) => {
      if (/workflow-lite\.js/.test(l) && /--args\s+['"<$]/.test(l)) malos.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(malos, []);
});
