#!/usr/bin/env node
'use strict';
// test-scope-lists.test.js — las listas de archivos que declara la story se leen en las formas que YAML permite,
// para el alcance de la puerta de pruebas; los frenos siguen leyendo sólo la forma de siempre.
// Si una forma no se lee, la story declara archivos y el alcance de la puerta de pruebas cae al diff sin aviso.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const testScope = require('../lib/test-scope');

test('TestScope_ListAtKeyIndent_IsRead — la lista a la misma sangría que la clave se lee', () => {
  // 🔴 rojo si: sólo se lee la lista con sangría mayor que la clave.
  const story = [
    '---',
    'story: "4.31"',
    'files_to_create:',
    '- "mcp/src/a.ts"   # misma sangría que la clave',
    '- mcp/src/b.ts',
    'status: review',
    '---',
  ].join('\n');
  assert.deepEqual(testScope.parseDeclaredFiles(story, { allForms: true }), ['mcp/src/a.ts', 'mcp/src/b.ts']);
  assert.deepEqual(testScope.parseFilesToCreate(story, { allForms: true }), ['mcp/src/a.ts', 'mcp/src/b.ts']);
});

test('TestScope_InlineList_IsRead — la lista en línea se lee, con comillas o sin ellas', () => {
  // 🔴 rojo si: `clave: [a, b]` no se lee.
  const story = [
    '---',
    'files_to_modify: ["mcp/src/c.ts", \'mcp/src/d.ts\', mcp/src/e.ts]   # en línea',
    '---',
  ].join('\n');
  assert.deepEqual(testScope.parseDeclaredFiles(story, { allForms: true }), ['mcp/src/c.ts', 'mcp/src/d.ts', 'mcp/src/e.ts']);
});

test('TestScope_NextKeyAtSameIndent_EndsList — la clave siguiente a la misma sangría corta la lista', () => {
  // 🔴 rojo si: aceptar la misma sangría hace que la clave siguiente o sus ítems se lean como de esta lista.
  const story = ['---', 'files_to_create:', '- mcp/src/a.ts', 'depends_on:', '- "4.17"', '---'].join('\n');
  assert.deepEqual(testScope.parseDeclaredFiles(story, { allForms: true }), ['mcp/src/a.ts']);
});

test('TestScope_BrakesReadOnlyTheUsualForm — los frenos leen sólo la forma de siempre: lo declarado no crece para ellos', () => {
  // 🔴 rojo si: las formas nuevas llegan a los frenos → un `git rm` de un archivo declarado en línea, o un cambio
  //    declarado a la misma sangría, pasan sin freno.
  const story = [
    '---',
    'files_to_create:',
    '- mcp/src/a.ts',
    'files_to_modify: [mcp/src/c.ts]',
    'files_to_delete: [mcp/src/viejo.ts]',
    '---',
  ].join('\n');
  assert.deepEqual(testScope.parseDeclaredFiles(story), []);
  assert.deepEqual(testScope.parseFilesToDelete(story), []);
  // la clave con un comentario detrás tampoco llega a los frenos
  const conNota = ['---', 'files_to_modify:  # nota', '  - mcp/src/c.ts', '---'].join('\n');
  assert.deepEqual(testScope.parseDeclaredFiles(conNota), []);
  assert.deepEqual(testScope.parseDeclaredFiles(conNota, { allForms: true }), ['mcp/src/c.ts']);
});

test('TestScope_Cli_UsesAllForms — el comando que llama la puerta de pruebas lee la lista en línea', () => {
  // 🔴 rojo si: el comando no pide todas las formas → los archivos a crear salen vacíos.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scope-lists-'));
  const story = path.join(dir, 'story.md');
  fs.writeFileSync(story, ['---', 'story: "4.31"', 'files_to_create: [mcp/src/a.ts]', '---', ''].join('\n'));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'test-scope.js'), dir, story, '--files-to-create'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /mcp\/src\/a\.ts/);
});

test('TestScope_StoryDeOtroRepo_SacaElPrefijoDelRepo — `FrontEnd/shared/x.ts` declarado desde otro repo cae en `shared`', () => {
  // 🔴 rojo si: la ruta se lee con el nombre del repo delante → ningún archivo cae en un proyecto y frena «no sé qué
  //    suite correr» (salida 4), o un archivo de otro repo vota por un proyecto de éste.
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'test-scope-prefijo-')));
  const repo = path.join(raiz, 'FrontEnd');
  for (const p of ['shared', 'web']) {
    fs.mkdirSync(path.join(repo, p, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, p, 'package.json'), '{"devDependencies":{"vitest":"^2.0.0"}}\n');
  }
  fs.mkdirSync(path.join(raiz, 'Project', 'specs'), { recursive: true });
  const story = path.join(raiz, 'Project', 'specs', 'story-11.2.md');
  fs.writeFileSync(story, ['---', 'story: "11.2"', 'files_to_modify:', '  - FrontEnd/shared/src/a.ts',
    '  - Backend/src/Api/Algo.cs', '---', ''].join('\n'));
  const r = testScope.resolveScope(repo, story);
  assert.strictEqual(r.multi, true, JSON.stringify(r));
  assert.strictEqual(r.scope, 'shared', JSON.stringify(r));
  // en la caja que escribió la story, aunque la carpeta tenga otra
  fs.writeFileSync(story, ['---', 'story: "11.2"', 'files_to_modify:', '  - frontend/web/src/b.ts', '---', ''].join('\n'));
  assert.strictEqual(testScope.resolveScope(repo, story).scope, 'web');
  // una story del propio repo no se toca: `FrontEnd/` ahí sería una carpeta de verdad
  const propia = path.join(repo, 'story.md');
  fs.writeFileSync(propia, ['---', 'story: "11.3"', 'files_to_modify:', '  - shared/src/a.ts', '---', ''].join('\n'));
  assert.strictEqual(testScope.resolveScope(repo, propia).scope, 'shared');
});
