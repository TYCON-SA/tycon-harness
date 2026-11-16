'use strict';
// El lector de comandos (lib/marker-command.js): una llamada a `marker.js` o `pipeline.js` es la que corre el guion, no la
// palabra que lo nombra como argumento de otro programa.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const mc = require(path.join(__dirname, '..', 'lib', 'marker-command.js'));

const guiones = (cmd) => mc.llamadas(cmd).map((l) => `${l.guion} ${l.sub}`);

// T3 MarkerCommand_NamedAsArgument_NoCall — @story-8.278 @ac-4 @ac-6
// 🔴 Falla con: contar como llamada un `marker.js` que no está en la posición del programa.
test('T3 MarkerCommand_NamedAsArgument_NoCall — @story-8.278 @ac-4 @ac-6', () => {
  const M = '/x/skills/tycon-pipeline/scripts/marker.js';
  assert.deepStrictEqual(guiones(`grep -n rethink ${M}`), []);
  assert.deepStrictEqual(guiones(`git grep -n 'extra-round|rethink' origin/main -- ${M}`), []);
  assert.deepStrictEqual(guiones('cat marker.js'), []);
  assert.deepStrictEqual(guiones(`sed -n 1,40p ${M} && grep clear ${M}`), []);
  // la lista de `smart-reloop` nombra marker.js: la única llamada es la de pipeline.js
  assert.deepStrictEqual(guiones(`node /x/pipeline.js smart-reloop --iter 2 --files ${M}`), ['pipeline smart-reloop']);
  assert.deepStrictEqual(guiones('node /x/pipeline.js smart-reloop --files a.js,/abs/marker.js'), ['pipeline smart-reloop']);
});

// T4 MarkerCommand_ProgramPosition_StillCalls — @story-8.278 @ac-5 @ac-18
// 🔴 Falla con: dejar de ver la llamada en la posición del programa, detrás de `env`, variables o `xargs`.
test('T4 MarkerCommand_ProgramPosition_StillCalls — @story-8.278 @ac-5 @ac-18', () => {
  assert.deepStrictEqual(guiones('node /x/marker.js clear'), ['marker clear']);
  assert.deepStrictEqual(guiones('env A=1 node marker.js set-autonomous false'), ['marker set-autonomous']);
  assert.deepStrictEqual(guiones('A=1 node marker.js rethink --iter 3'), ['marker rethink']);
  assert.deepStrictEqual(guiones('ls | xargs node marker.js clear'), ['marker clear']);
  assert.deepStrictEqual(guiones('cd /x && node ./pipeline.js start --story s.md'), ['pipeline start']);
});
