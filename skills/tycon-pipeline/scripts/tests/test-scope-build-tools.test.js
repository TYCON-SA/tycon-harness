#!/usr/bin/env node
'use strict';
// test-scope-build-tools.test.js — un proyecto Maven o Gradle en la raíz es dueño de su Scala, Groovy y Kotlin de guion.
// Si esas terminaciones no votan, nadie vota y la puerta de pruebas frena con «no sé el alcance».
const test = require('node:test');
const assert = require('node:assert');
const testScope = require('../lib/test-scope');

test('TestScope_JvmRoot_VotesForScalaGroovyKts — un proyecto Maven o Gradle en la raíz es dueño de su Scala, Groovy y .kts', () => {
  // 🔴 rojo si: la raíz Maven/Gradle no vota por esas terminaciones → nadie vota y la puerta de pruebas frena con 4.
  for (const runner of ['maven', 'gradle']) {
    const r = testScope.deduceScope({ files: ['src/main/scala/A.scala', 'src/test/groovy/BSpec.groovy', 'buildSrc/x.kts'],
      candidates: [{ dir: '.', runner }, { dir: 'web', runner: 'vitest' }] });
    assert.equal(r.scope, '.', `${runner}: ${JSON.stringify(r)}`);
    assert.equal(r.votes['.'], 3);
  }
});

test('TestScope_OtherRoot_DoesNotVoteForScala — con otra herramienta en la raíz, esas terminaciones no votan', () => {
  // 🔴 rojo si: el voto se da a cualquier raíz → un .scala elige un proyecto que no lo corre.
  const otro = testScope.deduceScope({ files: ['src/A.scala'], candidates: [{ dir: '.', runner: 'pytest' }, { dir: 'web', runner: 'vitest' }] });
  assert.notEqual(otro.scope, '.');
});
