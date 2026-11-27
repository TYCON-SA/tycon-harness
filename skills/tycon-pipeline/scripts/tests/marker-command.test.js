'use strict';
// El lector de comandos (lib/marker-command.js): una llamada a `marker.js` o `pipeline.js` es la que corre el guion, no la
// palabra que lo nombra como argumento de otro programa.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const mc = require(path.join(__dirname, '..', 'lib', 'marker-command.js'));

const guiones = (cmd) => mc.llamadas(cmd).map((l) => `${l.guion} ${l.sub}`);

const FIRMA = ['harness', 'sign'].join('-');
const PIPELINE = path.join(__dirname, '..', 'pipeline.js');

// T2b MarkerCommand_SignLibrary_OnlyWhenRun
// 🔴 Falla con: decidir por el nombre, o dejar pasar lo que no está en la lista de los que sólo leen.
test('T2b MarkerCommand_SignLibrary_OnlyWhenRun @story-8.278 @story-8.308 @ac-1 @ac-2 @ac-3 @ac-15', () => {
  for (const cmd of [
    `grep -n ${FIRMA} notas.txt`, `echo ${FIRMA}atures`, `cat ${FIRMA}.js | head -3`, `ls scripts/lib/${FIRMA}.js`,
    `git log --oneline -- scripts/lib/${FIRMA}.js`, `git show HEAD:scripts/lib/${FIRMA}.js`, `git diff -- ${FIRMA}.js`, 'git status',
    `wc -l "${FIRMA}.js"`, `tail -5 '${FIRMA}.js'`,
    `node ${PIPELINE} smart-reloop --iter 2 --files a.js,scripts/lib/${FIRMA}.js`,
  ]) assert.strictEqual(mc.leerFirma(cmd), 'lee', cmd);
  for (const cmd of [
    `node ${FIRMA}.js`, `./${FIRMA}.js`, `cat ${FIRMA}.js | node`, `grep x ${FIRMA}.js > y`, `ls ${FIRMA}.js; node x`, `${FIRMA}$1`,
    `git diff --output ${FIRMA}.js`, `git diff --output=${FIRMA}.js`, `cd x && cat ${FIRMA}.js`, `env cat ${FIRMA}.js`, `A=1 cat ${FIRMA}.js`,
    `rg ${FIRMA}`, `uniq ${FIRMA}.js`, `python3 x.py ${FIRMA}.js`, `(cat ${FIRMA}.js)`, `git grep ${FIRMA}`, `grep --x=${FIRMA} y`,
    `/bin/cat ${FIRMA}.js`, `cat ${FIRMA}.js || node x`, `cat ${FIRMA}.js | `, `cat ${FIRMA}.js\nnode x`,
    `node otro/pipeline.js smart-reloop --files ${FIRMA}.js`, `node ${PIPELINE} update-story-status ${FIRMA}.js`,
    `node ${PIPELINE} smart-reloop --output ${FIRMA}.js`,
  ]) assert.strictEqual(mc.leerFirma(cmd), 'corre', cmd);
  for (const cmd of [`cat "${FIRMA}.js`, `cat '${FIRMA}.js`, `cat ${FIRMA}.js\r`]) assert.strictEqual(mc.leerFirma(cmd), 'ilegible', cmd);
});

// T2d MarkerCommand_SignLibrary_ReadsWithSeparatorsAndSed
// 🔴 Falla con: el lector de antes, que frenaba como si corriera la biblioteca un `sed -n` que muestra renglones, un `grep`
// con `2>/dev/null` y dos lecturas encadenadas con `;` o `&&` (falsos positivos medidos en la revisión de precisión).
test('T2d MarkerCommand_SignLibrary_ReadsWithSeparatorsAndSed — sed -n que muestra, 2>/dev/null y lecturas encadenadas leen; lo demás sigue corriendo', () => {
  for (const cmd of [
    `sed -n 320,350p scripts/tests/${FIRMA}.test.js`, `sed -n 5p ${FIRMA}.js`,
    `grep -rn x scripts/tests/${FIRMA}.test.js 2>/dev/null | head -8`,
    `grep -n a tycon-home.js | head -10; grep -n b scripts/lib/${FIRMA}.js 2>/dev/null | head -5`,
    `cat ${FIRMA}.js && wc -l ${FIRMA}.js`,
  ]) assert.strictEqual(mc.leerFirma(cmd), 'lee', cmd);
  for (const cmd of [
    `cat ${FIRMA}.js; node ${FIRMA}.js`, `grep x ${FIRMA}.js && node ${FIRMA}.js sign`, `grep x ${FIRMA}.js 2>/dev/null > y`,
    `grep x ${FIRMA}.js &`, `cat ${FIRMA}.js & node ${FIRMA}.js`, `sed -n '1w /tmp/x' ${FIRMA}.js`, `sed -n 1,5e ${FIRMA}.js`,
    `sed -i 1d ${FIRMA}.js`, `sed -n 1,5p ${FIRMA}.js -i`, `sed 1p ${FIRMA}.js`, `grep x ${FIRMA}.js 2>&1 | head`, `grep x ${FIRMA}.js ;`,
  ]) assert.strictEqual(mc.leerFirma(cmd), 'corre', cmd);
});

// T2c MarkerCommand_SignGateCli
// 🔴 Falla con: un modo de consola que no contesta lo que el freno de shell espera leer.
test('T2c MarkerCommand_SignGateCli @story-8.278 @story-8.308 @ac-1 @ac-2 @ac-3 @ac-15', () => {
  const LIB = path.join(__dirname, '..', 'lib', 'marker-command.js');
  const correr = (input) => spawnSync(process.execPath, [LIB, '--sign-gate'], { input, encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(correr(`cat ${FIRMA}.js`), 'firma=0');
  assert.strictEqual(correr(`node ${FIRMA}.js`), 'firma=1');
  assert.strictEqual(correr(`cat "${FIRMA}.js`), 'firma=?');
});

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

// T5 MarkerCommand_PipeKeepsItsSource
// 🔴 Falla con: un salto de línea o un `(` después del `|` cierran un tramo vacío, y el tramo que sigue nace sin saber de
//    qué tubería viene: el cuerpo de un heredoc que va a un shell deja de leerse como comando.
test('T5 MarkerCommand_PipeKeepsItsSource — el tramo después de un | sabe de dónde viene aunque siga un salto o un (', () => {
  const desde = (cmd) => mc.tramos(cmd).tramos.map((t) => (t.desde ? t.desde.palabras[0].texto : null));
  for (const cmd of ['echo a | grep b', 'echo a |\ngrep b', 'echo a | (grep b)', 'echo a |\n  (grep b)', 'echo a | \\\ngrep b']) {
    assert.deepStrictEqual(desde(cmd), [null, 'echo'], JSON.stringify(cmd));
  }
  assert.deepStrictEqual(desde('echo a; grep b'), [null, null], 'un ; no es una tubería');
  assert.deepStrictEqual(desde('echo a |\n\ngrep b'), [null, 'echo'], 'tampoco con un renglón en blanco');
  assert.deepStrictEqual(guiones('cat <<EOF | (bash)\nnode marker.js clear\nEOF'), ['marker clear']);
  assert.deepStrictEqual(guiones('cat <<EOF | (bash -c "sh")\nnode marker.js clear\nEOF'), ['marker clear'], 'con -c el destino se lee por el enlace');
});
