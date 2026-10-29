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
});

test('TestScope_JvmRoot_VotesForScalaGroovyKts — un proyecto Maven o Gradle en la raíz es dueño de su Scala, Groovy y .kts', () => {
  // 🔴 rojo si: la raíz Maven/Gradle no vota por esas terminaciones → nadie vota y la puerta de pruebas frena con 4.
  for (const runner of ['maven', 'gradle']) {
    const r = testScope.deduceScope({ files: ['src/main/scala/A.scala', 'src/test/groovy/BSpec.groovy', 'buildSrc/x.kts'],
      candidates: [{ dir: '.', runner }, { dir: 'web', runner: 'vitest' }] });
    assert.equal(r.scope, '.', `${runner}: ${JSON.stringify(r)}`);
    assert.equal(r.votes['.'], 3);
  }
  // con otra herramienta en la raíz, esas terminaciones no votan
  const otro = testScope.deduceScope({ files: ['src/A.scala'], candidates: [{ dir: '.', runner: 'pytest' }, { dir: 'web', runner: 'vitest' }] });
  assert.notEqual(otro.scope, '.');
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
