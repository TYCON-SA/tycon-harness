#!/usr/bin/env node
/**
 * change-names.test.js — los nombres de lo que cambió dentro de un archivo (lib/change-names.js).
 *
 * El portón acotado por el repo corre, para una pieza central, sólo las suites que nombran lo que cambió adentro. Si
 * esta lib devolviera una lista vacía como conocida, o un nombre equivocado, el portón diferiría suites que prueban el
 * cambio: ante la duda tiene que decir «no sé» (`known: false`) y el portón corre todas.
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { changeNames } = require('../lib/change-names.js');

function git(dir, ...args) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  return execFileSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
}

/** Repo git de juguete con los archivos de `inicial` commiteados; devuelve { repo, base, write }. */
function lab(inicial) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'change-names-'));
  const write = (f, body) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), body); };
  git(repo, 'init', '-q');
  for (const [f, body] of Object.entries(inicial)) write(f, body);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD'), write };
}

const JS = [
  'const ARRIBA = 1;',
  'function a(p) {',
  '  return p;',
  '}',
  'function main(argv) {',
  '  switch (argv[0]) {',
  "    case 'b':",
  '      uno();',
  '      break;',
  '  }',
  '}',
  'const c = (q) => {',
  '  return q;',
  '};',
  '',
].join('\n');
const SH = ['#!/bin/bash', 'd() {', '  echo hola', '}', ''].join('\n');

test('T5 ChangeNames_FunctionCaseArrowShell @story-8.302 @ac-2 — un cambio dentro de una función, un subcomando, una flecha y una función de shell da sus nombres', () => {
  // 🔴 mutación: buscar sólo `function x(` (sin `case`, sin flecha, sin la forma de shell) → faltan b, c o d; contar
  //    `main` con un subcomando adentro → sobra «main», que casi toda suite nombra.
  const l = lab({ 'lib/a.js': JS, 'lib/d.sh': SH });
  l.write('lib/a.js', JS.replace('return p;', 'return p + 1;').replace('uno();', 'dos();').replace('return q;', 'return q * 2;'));
  l.write('lib/d.sh', SH.replace('hola', 'chau'));
  const js = changeNames({ repo: l.repo, file: 'lib/a.js', base: l.base });
  const sh = changeNames({ repo: l.repo, file: 'lib/d.sh', base: l.base });
  assert.equal(js.known, true, JSON.stringify(js));
  assert.equal(sh.known, true, JSON.stringify(sh));
  assert.deepEqual([...js.names, ...sh.names], ['a', 'b', 'c', 'd']);
});

test('T6 ChangeNames_DeletedAtEnd_UsesLastRemaining @story-8.302 @ac-8 — borrar los últimos renglones cuenta por el nombre que encierra el último que quedó', () => {
  // 🔴 mutación: ignorar los tramos que sólo borran (`+c,0`) → no hay renglones cambiados y sale «no cambió»; contar el
  //    renglón c+1 (que no existe al final) → sin nombre.
  const l = lab({ 'lib/z.js': ['const ANTES = 0;', 'function z() {', '  uno();', '}', 'const DESPUES = 1;', 'const MAS = 2;', ''].join('\n') });
  l.write('lib/z.js', ['const ANTES = 0;', 'function z() {', '  uno();', '}', ''].join('\n'));
  assert.deepEqual(changeNames({ repo: l.repo, file: 'lib/z.js', base: l.base }), { known: true, names: ['z'] });
  // sin ningún nombre que encierre el último renglón que quedó: «no sé», nunca una lista vacía
  const sinNombre = lab({ 'lib/y.js': ['const UNO = 1;', 'const DOS = 2;', ''].join('\n') });
  sinNombre.write('lib/y.js', ['const UNO = 1;', ''].join('\n'));
  const r = changeNames({ repo: sinNombre.repo, file: 'lib/y.js', base: sinNombre.base });
  assert.equal(r.known, false, JSON.stringify(r));
  assert.match(r.reason, /no lo encierra ninguna función ni subcomando/);
});

test('T7 ChangeNames_BadPathOrBase_Unknown @story-8.302 @ac-7 — ruta inexistente, base desconocida o archivo nuevo: known false con su motivo', () => {
  // 🔴 mutación: devolver `{ known: true, names: [] }` cuando git falla o el archivo no está → el portón diferiría todas
  //    las suites cercanas sin saber qué cambió.
  const l = lab({ 'lib/a.js': JS });
  l.write('lib/a.js', JS.replace('return p;', 'return p + 1;'));
  const sinArchivo = changeNames({ repo: l.repo, file: 'lib/no-existe.js', base: l.base });
  assert.equal(sinArchivo.known, false);
  assert.match(sinArchivo.reason, /no pude leer lib\/no-existe\.js/);
  const sinBase = changeNames({ repo: l.repo, file: 'lib/a.js', base: 'deadbeef' });
  assert.equal(sinBase.known, false);
  assert.match(sinBase.reason, /git no conoce la base deadbeef/);
  l.write('lib/nuevo.js', 'function n() {}\n');
  const nuevo = changeNames({ repo: l.repo, file: 'lib/nuevo.js', base: l.base });
  assert.equal(nuevo.known, false);
  assert.match(nuevo.reason, /el archivo es nuevo/);
  for (const r of [sinArchivo, sinBase, nuevo]) assert.equal(r.names, undefined, JSON.stringify(r));
});

const DESPACHO = [
  'const uno = (v) => v + 1;',
  'function cmdBuild(x) {',
  '  return x;',
  '}',
  'function main(cmd) {',
  "  if (cmd === 'build' || cmd === 'rebuild') {",
  '    return cmdBuild(1);',
  '  }',
  '  switch (cmd) {',
  "    case 'other':",
  '      cmdBuild(2);',
  '      break;',
  '  }',
  "  if (cmd === 'third') {",
  "    const tmp = { a: '}' };",
  '  }',
  '}',
  'const SUELTO = 2;',
  '',
].join('\n');

test('T9 ChangeNames_EnclosingByBraces_DispatchAndUnknown @story-8.302 @ac-2 @ac-6 — encierra por las llaves, suma el subcomando que llama a la función y, sin nada que encierre o con llaves rotas, dice «no sé»', () => {
  // 🔴 mutación: «el primero hacia arriba» → `cmdBuild` sin `build`/`rebuild`/`other`, y el renglón suelto de abajo se
  //    queda con `main` (o con la flecha de una línea) en vez de «no sé»; contar la llave del string `'}'` → las llaves
  //    no cierran y `third` sale «no sé».
  const l = lab({ 'lib/despacho.js': DESPACHO });
  const con = (de, a) => { l.write('lib/despacho.js', DESPACHO.replace(de, a)); return changeNames({ repo: l.repo, file: 'lib/despacho.js', base: l.base }); };
  assert.deepEqual(con('return x;', 'return x + 1;'), { known: true, names: ['cmdBuild', 'build', 'rebuild', 'other'] });
  assert.deepEqual(con("a: '}'", "a: '}}'"), { known: true, names: ['third'] });
  const suelto = con('const SUELTO = 2;', 'const SUELTO = 3;');
  assert.equal(suelto.known, false, JSON.stringify(suelto));
  assert.match(suelto.reason, /el renglón 18 cambió y no lo encierra ninguna función ni subcomando/);
  const rota = con('return x;', 'return x; {');
  assert.equal(rota.known, false, JSON.stringify(rota));
  assert.match(rota.reason, /no pude seguir las llaves de lib\/despacho\.js/);
});
