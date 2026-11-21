#!/usr/bin/env node
'use strict';
/**
 * session-name.test.js — el nombre de una sesión por su id (scripts/lib/session-name.js).
 *
 * QUÉ CUIDA: que el nombre salga de los mismos lectores que usa /wip (el archivo de sesión de Claude, el último /rename de
 * su conversación, el nombre de la sesión de Codex), que un nombre armado de la carpeta cuente como «sin nombre», que un
 * nombre largo quede en una línea de 40 con `cortado: true`, y que nada de lo que no se puede leer haga tirar.
 *
 * Cada caso arma su casa temporal: ninguna prueba lee ni escribe la carpeta de sesiones real.
 *
 * Correr: node --test scripts/tests/session-name.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'session-name.js');
const SID = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const OTRA = 'bbbbbbbb-0000-4000-8000-0000000000b2';

function casa(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'nombre-sesion-'));
  t.after(() => {
    try { fs.chmodSync(path.join(raiz, '.claude', 'sessions'), 0o755); } catch (_e) { /* ya está legible o no existe */ }
    fs.rmSync(raiz, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(raiz, '.claude', 'sessions'), { recursive: true });
  return raiz;
}

function sesion(raiz, pid, datos) {
  fs.writeFileSync(path.join(raiz, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, cwd: '/tmp/acme', ...datos }));
}

const leer = (raiz, extra = {}) => require(LIB).nombreDeSesion({ sid: SID, home: raiz, ...extra });

test('T1 2.83-NombreDeSesion_ClaudeArchivoYRenombre @story-2.83 @ac-1 @ac-2', (t) => {
  const raiz = casa(t);
  sesion(raiz, 123, { sessionId: SID, name: 'Carrizo-4', nameSource: 'peer' });
  sesion(raiz, 124, { sessionId: OTRA, name: 'Ponzio-9', nameSource: 'user' });
  const a = leer(raiz);
  assert.strictEqual(a.nombre, 'Carrizo-4');
  assert.strictEqual(a.problema, null);
  assert.ok(!a.cortado, 'un nombre corto no está cortado');
  // la persona la renombra: el próximo pedido ve el nombre nuevo, y nunca el de la otra sesión
  sesion(raiz, 123, { sessionId: SID, name: 'Carrizo-5', nameSource: 'user' });
  assert.strictEqual(leer(raiz).nombre, 'Carrizo-5');
  // un nombre de 60 caracteres con un salto de línea: en una línea, de 40, con la marca de cortado
  const largo = `${'a'.repeat(30)}\n${'b'.repeat(29)}`;
  sesion(raiz, 123, { sessionId: SID, name: largo, nameSource: 'user' });
  const c = leer(raiz);
  assert.strictEqual(Array.from(c.nombre).length, 40, c.nombre);
  assert.doesNotMatch(c.nombre, /\n/);
  assert.strictEqual(c.cortado, true);
});

test('T2 2.83-NombreDeSesion_TituloCodexYDerivado @story-2.83 @ac-4', (t) => {
  // sin archivo de sesión, el último /rename de su conversación
  const r1 = casa(t);
  const conv = path.join(r1, '.claude', 'projects', '-tmp-acme');
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, `${SID}.jsonl`), [
    { type: 'custom-title', customTitle: 'Viejo-1', sessionId: SID },
    { type: 'user', message: { role: 'user', content: 'hola' } },
    { type: 'custom-title', customTitle: 'Titulo-2', sessionId: SID },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const a = leer(r1);
  assert.strictEqual(a.nombre, 'Titulo-2');
  assert.strictEqual(a.fuente, 'claude');
  // una sesión de Codex: el nombre de `threads.name`
  const r2 = casa(t);
  const codex = path.join(r2, '.codex');
  fs.mkdirSync(codex, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  db.prepare('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)').run(SID, 'Codex-3', 'un resumen automático');
  db.close();
  const b = leer(r2);
  assert.strictEqual(b.nombre, 'Codex-3');
  assert.strictEqual(b.fuente, 'codex');
  assert.strictEqual(b.problema, null);
  // un nombre armado de la carpeta no es un nombre
  const r3 = casa(t);
  sesion(r3, 321, { sessionId: SID, name: 'acme', nameSource: 'derived' });
  assert.strictEqual(leer(r3).nombre, null);
  // ninguna fuente
  const r4 = casa(t);
  const d = leer(r4);
  assert.strictEqual(d.nombre, null);
  assert.strictEqual(d.problema, null);
});

test('T3 2.83-NombreDeSesion_NoTiraConFallas @story-2.83 @ac-6', (t) => {
  // la carpeta de sesiones sin permiso de lectura
  const r1 = casa(t);
  sesion(r1, 123, { sessionId: SID, name: 'Carrizo-4', nameSource: 'peer' });
  fs.chmodSync(path.join(r1, '.claude', 'sessions'), 0o000);
  let a;
  assert.doesNotThrow(() => { a = leer(r1); });
  if (process.getuid && process.getuid() !== 0) {
    assert.strictEqual(a.nombre, null);
    assert.strictEqual(a.problema, 'carpeta-ilegible');
  }
  fs.chmodSync(path.join(r1, '.claude', 'sessions'), 0o755);
  // el archivo de OTRA sesión que no es JSON no cambia nada para ésta
  const r2 = casa(t);
  sesion(r2, 123, { sessionId: SID, name: 'Carrizo-4', nameSource: 'peer' });
  fs.writeFileSync(path.join(r2, '.claude', 'sessions', '999.json'), '{ esto no es json');
  const b = leer(r2);
  assert.strictEqual(b.nombre, 'Carrizo-4');
  assert.strictEqual(b.problema, null);
  // una base de Codex que no es SQLite
  const r3 = casa(t);
  fs.mkdirSync(path.join(r3, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(r3, '.codex', 'state_5.sqlite'), 'no soy una base');
  let c;
  assert.doesNotThrow(() => { c = leer(r3); });
  assert.strictEqual(c.nombre, null);
  assert.strictEqual(c.problema, 'codex-ilegible');
  // un id que no entra en una ruta, o ningún id: sin nombre y sin tirar
  assert.doesNotThrow(() => leer(r3, { sid: '../x' }));
  assert.strictEqual(require(LIB).nombreDeSesion({}).nombre, null);
});
