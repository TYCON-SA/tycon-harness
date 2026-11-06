'use strict';
// Nombrar un guion no es correrlo: el freno de escrituras por consola no cuenta como guion que corre a uno que sólo está
// en la lista de archivos de un comando de sólo lectura de `pipeline.js`, o que lee un programa que no corre lo que lee.
// Todo lo demás se sigue contando, con cualquier envoltura.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.join(__dirname, '..');
const bash = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));

const SID = 'sesion-nombrar-guion';
const GRANDE = '⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO';
const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

/** Un repo con historias, un `marker.js` de otro clon (grande y ejecutable, como el de verdad) y una instalación del arnés. */
function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nombrar-guion-')));
  const estado = path.join(raiz, 'estado');
  const repo = path.join(raiz, 'repo');
  const instalado = path.join(raiz, 'instalado');
  for (const d of [path.join(estado, 'active'), path.join(repo, '.git'), path.join(repo, '.tycon'), path.join(repo, 'specs'), path.join(repo, 'scripts'), path.join(repo, 'planta'), instalado]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  const relleno = `// ${'x'.repeat(200)}\n`;
  const grande = `#!/usr/bin/env node\n// cambia el estado de la story\nrequire('fs').writeFileSync(process.argv[2], 'x');\n${relleno.repeat(1600)}`;
  for (const n of ['marker.js', 'otro-grande.js']) fs.writeFileSync(path.join(repo, 'scripts', n), grande, { mode: 0o755 });
  // el mismo nombre en la instalación y plantado en el repo; el de la instalación importa muchos módulos, como el de
  // verdad; el plantado no escribe nada y corre lo que recibe
  const modulos = Array.from({ length: 25 }, (_, i) => `m${i}`);
  for (const m of modulos) fs.writeFileSync(path.join(instalado, `${m}.js`), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(instalado, 'pipeline.js'), `#!/usr/bin/env node\n${modulos.map((m) => `require('./${m}.js');`).join('\n')}\nprocess.exit(0);\n`, { mode: 0o755 });
  // otro `pipeline.js` en la carpeta de arranque: desde una carpeta incierta, puede ser éste el que corre
  fs.writeFileSync(path.join(repo, 'pipeline.js'), 'process.exit(0);\n');
  // un guion propio con muchos módulos, que no escribe nada
  const sub = path.join(repo, 'muchos');
  fs.mkdirSync(sub);
  for (const m of modulos) fs.writeFileSync(path.join(sub, `${m}.js`), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(sub, 'a.js'), modulos.map((m) => `require('./${m}.js');`).join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'planta', 'pipeline.js'), "#!/usr/bin/env node\nrequire('child_process').execFileSync(process.argv[4]);\n", { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'planta', 'cat'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'planta', 'p.js'), 'process.exit(0);\n');
  return { estado, repo, pipeline: path.join(instalado, 'pipeline.js'), instalado };
}

function juzgador({ estado, repo, instalado }) {
  return (c) => conEnv(ENV, () => {
    const r = bash.handle({ tool_name: 'Bash', session_id: SID, cwd: repo, tool_input: { command: c } }, { stateDir: estado, installedRoots: [instalado] });
    return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : '';
  });
}

const M = 'scripts/marker.js';
const LISTA = `${M} scripts/otro-grande.js`;
const LEEN = ['advisors', 'check-count', 'smart-reloop', 'deep-review-gate', 'mech-check', 'risk-class', 'model-hint'];

// T1 ListOfFiles_InReadOnlyPipelineCommands_DoesNotCountAsRunning
// 🔴 Falla con: contar como guion que corre a cualquier palabra con `/` que apunte a un ejecutable.
test('T1 ListOfFiles_InReadOnlyPipelineCommands_DoesNotCountAsRunning', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = `node ${c.pipeline}`;
  for (const sub of LEEN) {
    for (const lista of [M, LISTA, `scripts/otro-grande.js ${M} specs/nada.txt`, `planta/node ${M}`]) {
      assert.strictEqual(freno(`${P} ${sub} --repo ${c.repo} --story specs/story-1.1.md --files ${lista}`), '', `${sub} con ${lista}`);
    }
  }
  // con las demás opciones en cualquier orden, con la lista por variables, y encadenado con algo que no corre un guion
  assert.strictEqual(freno(`${P} advisors --files ${M} --repo "$PWD" --story specs/story-1.1.md --iter 2`), '');
  assert.strictEqual(freno(`${P} advisors --repo "$PWD" --story "$S" --files "$W/marker.js"`), '');
  assert.strictEqual(freno(`I=${path.dirname(c.pipeline)}; node $I/pipeline.js advisors --files ${M}`), '', 'la carpeta del guion en una variable');
  assert.strictEqual(freno(`cd ${c.repo} && ${P} advisors --files ${M}; echo listo`), '');
  assert.strictEqual(freno(`${P} check-count --files ${M} 2>&1 | tail -3`), '');
  assert.strictEqual(freno(`cat ${M} 2>/dev/null`), '');
  // un comando largo, escrito en varios renglones
  assert.strictEqual(freno(`${P} advisors --repo ${c.repo} \\\n  --files ${M}`), '', 'la lista en otro renglón');
  assert.strictEqual(freno(`${P} \\\n  advisors --files ${M} \\\n  --repo ${c.repo}`), '', 'en tres renglones');
  // lo que dice una opción no es una función
  assert.strictEqual(freno(`${P} advisors --files ${M} --story 'fn()'`), '');
  // el `&` de `2>&1` no empieza otro tramo; el que sigue, sí
  assert.strictEqual(freno(`${P} check-count --files ${M} 2>&1 & ./${M}`), GRANDE);
  assert.strictEqual(freno(`cat ${M} 2>&1& ./${M}`), GRANDE);
});

// T2 ListOfFiles_ReadingPrograms_DoNotCountAsRunning
// 🔴 Falla con: lo mismo que T1, o tomar el `node` de `grep node <guion>` por el intérprete.
test('T2 ListOfFiles_ReadingPrograms_DoNotCountAsRunning', () => {
  const c = corral();
  const freno = juzgador(c);
  for (const leer of [`sed -n 1,2p scripts/otro-grande.js ${M}`, `sed -n '/node/p' ${M}`, `sed 5q ${M}`, `sed -n ':a;p;b a' ${M}`, `cat ${M}`, `ls -la ${M}`, `grep -n node ${M}`, `grep -n python3 ${LISTA}`,
    `head -3 ${M}`, `tail -3 ${M}`, `wc -l ${M}`, `stat ${M}`, `git log -3 -- ${M}`, `git diff main -- ${M}`, `git status -- ${M}`,
    `/bin/cat ${M}`, `cat ${M} | head -2`, `(cat ${M})`, `cat "$W/marker.js"`,
    `cat \\\n  ${M}`, `cat 'a # b' \\\n  ${M}`, `cat x#y \\\n  ${M}`, `cat ${M} # nota sobre ./${M}`,
    // lo que se busca no es una función, un alias ni un PATH
    `grep -n 'function foo' ${M}`, `grep -n "foo()" ${M}`, `grep -n alias ${M}`, `grep -n PATH= ${M}`, `sed -n '/function x/p' ${M}`,
    `cat ${M} | grep 'run()'`, `cat ${M}; echo 'f()'`, `W=scripts; cat $W/marker.js`]) {
    assert.strictEqual(freno(leer), '', leer);
  }
});

// T3 RunningTheScript_WrappedChainedOrWithVariables_StillBlocks
// 🔴 Falla con: contar sólo la palabra en posición de comando (se escapan las envolturas que no se conocen), no leer los
//    comandos de adentro, o no expandir la variable que trae la ruta entera (`G=…; "$G"`).
test('T3 RunningTheScript_WrappedChainedOrWithVariables_StillBlocks', () => {
  const c = corral();
  const freno = juzgador(c);
  const directos = [`./${M}`, M, `node ${M}`, `node ./${M} specs/story-1.1.md`, `python3 ${M}`];
  const envolturas = ['time', 'sudo -u x', 'nice -10', 'nice -n 5', 'timeout -s KILL 5', 'nohup', 'env A=1', 'env -i', 'command', 'exec', '!',
    'stdbuf -o0', 'ionice -c3', 'setsid', 'flock /tmp/l', 'caffeinate', 'parallel', 'watch', 'script -q /dev/null', 'unbuffer', 'chronic',
    'busybox', 'npx', 'bash', 'sh', '.', 'source', 'xargs', 'xargs -I{}', 'A=1'];
  for (const e of envolturas) assert.strictEqual(freno(`${e} ./${M}`), GRANDE, e);
  for (const d of directos) {
    assert.strictEqual(freno(d), GRANDE, d);
    for (const forma of [`if true; then ${d}; fi`, `while true; do ${d}; done`, `( ${d} )`, `{ ${d}; }`, `bash -c '${d}'`, `eval ${d}`, `echo $(${d})`, `echo \`${d}\``, `find . -name x -exec ${d} {} ';'`, `D=scripts; echo uno; ${d}`]) {
      assert.strictEqual(freno(forma), GRANDE, forma);
    }
  }
  assert.strictEqual(freno(`G=${M}; "$G" specs/story-1.1.md`), GRANDE, 'en una variable');
  assert.strictEqual(freno(`G=${M}; node "$G"`), GRANDE, 'en una variable, con node');
  assert.strictEqual(freno('D=scripts; ./$D/marker.js'), GRANDE, 'la carpeta en una variable');
});

// T4 FilesListFollowedByARealRun_StillBlocks
// 🔴 Falla con: eximir el comando entero por su primer tramo, partir los tramos sin el `&` suelto ni los paréntesis (el
//    lector del freno sólo corta `;`, `&&`, `||`, `|` y el renglón), o no mirar lo que corre adentro de la lista.
test('T4 FilesListFollowedByARealRun_StillBlocks', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = `node ${c.pipeline} advisors --repo ${c.repo} --files ${M}`;
  const correr = `./${M} specs/story-1.1.md`;
  for (const primero of [P, `sed -n 1,2p ${M}`, `cat ${M}`, `grep -n x ${M}`, `git log -- ${M}`]) {
    for (const sep of ['; ', ' && ', ' || ', ' | ', ' & ', ' |& ', '\n', ' ) ; ( ']) {
      assert.strictEqual(freno(`${primero}${sep}${correr}`), GRANDE, `${primero}${JSON.stringify(sep)}`);
      assert.strictEqual(freno(`${primero}${sep}node ${M}`), GRANDE, `${primero}${JSON.stringify(sep)} con node`);
    }
    assert.strictEqual(freno(`${correr}; ${primero}`), GRANDE, `antes de ${primero}`);
    assert.strictEqual(freno(`${primero} $(${correr})`), GRANDE, `$() en ${primero}`);
    assert.strictEqual(freno(`${primero} \`${correr}\``), GRANDE, `comillas invertidas en ${primero}`);
    assert.strictEqual(freno(`${primero} <(${correr})`), GRANDE, `<() en ${primero}`);
  }
  // lo que va después de `--` lo corre el guion
  assert.strictEqual(freno(`${P} -- ${M} clear`), GRANDE, 'después de --');
});

// T8 ModulesOfAnotherScript_DoNotUseUpTheLimit
// 🔴 Falla con: un solo tope de veinte archivos para todo el comando: los módulos de `pipeline.js`, o los de otro guion,
//    llenan el cupo y lo que corre después no se mira.
test('T8 ModulesOfAnotherScript_DoNotUseUpTheLimit', () => {
  const c = corral();
  const freno = juzgador(c);
  assert.strictEqual(freno(`node ${c.pipeline} advisors --repo ${c.repo} --files ${M}; node ${M} specs/story-1.1.md`), GRANDE, 'con la lista');
  assert.strictEqual(freno(`node ${c.pipeline} next; node ${M} specs/story-1.1.md`), GRANDE, 'sin la lista');
  assert.strictEqual(freno(`node muchos/a.js; node ${M} specs/story-1.1.md`), GRANDE, 'los módulos de un guion propio');
});

// T5 NotTheInstalledPipelineOrNotAReader_StillBlocks
// 🔴 Falla con: mirar el nombre `pipeline.js` o `cat` y no quién es, mirar sólo el subcomando, aceptar lo que se le pone
//    delante a `node`, o creerle a un programa que el mismo comando redefine.
test('T5 NotTheInstalledPipelineOrNotAReader_StillBlocks', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = `node ${c.pipeline}`;
  for (const raro of [
    `node planta/pipeline.js advisors --files ${M}`, `node ./planta/pipeline.js check-count --files ${M}`,
    `${P} start --story specs/story-1.1.md --files ${M}`, `${P} --files ${M}`, `${P} $S --files ${M}`, `${P} ad"$X"visors --files ${M}`,
    `NODE_OPTIONS=--require=./planta/p.js ${P} advisors --files ${M}`, `node --require ./planta/p.js ${c.pipeline} advisors --files ${M}`,
    `node -r ./planta/p.js ${c.pipeline} advisors --files ${M}`, `planta/node ${c.pipeline} advisors --files ${M}`,
    `xargs ${P} advisors --files ${M}`, `time ${P} advisors --files ${M}`,
    `planta/cat ${M}`, `./planta/cat ${M}`, `$CAT ${M}`, `PATH=planta:$PATH; cat ${M}`, `export PATH=planta; cat ${M}`, `path=(planta); cat ${M}`,
    `cat() { "$@"; }; cat ${M}`, `function cat { "$@"; }; cat ${M}`, `alias cat=sh; cat ${M}`,
    `PATH=planta:$PATH; ${P} advisors --files ${M}`,
    `sudo cat ${M}`, `awk 'BEGIN{system("x")}' ${M}`, `rg --pre ${M} x specs`, `sort --compress-program=${M} specs/story-1.1.md ${M}`,
    `open ${M}`, `git log --output=salida ${M}`, `git -C . log ${M}`, `cat ${M} 'x`,
    // el `sed` de GNU corre lo que le pide `e`, y lee las opciones en cualquier lugar
    `sed e ./${M}`, `sed 's/.*/&/e' ${M}`, `sed '1e python x.py' ${M}`, `sed -n 1p -e 1e ${M}`, `sed -f planta/p.js ${M}`, `sed -n "$X" ${M}`, `sed -n 1p ${M} $X`,
    `sed -n 1,2w${'salida'} ${M}`, `sed -s -n 1p ${M}`,
    // la etiqueta termina en el primer espacio: lo que sigue es otro comando
    `sed 't x e;:x' ${M}`, `sed 'T x e;:x' ${M}`, `sed 'b x e;:x' ${M}`,
    // desde una carpeta incierta, tienen que ser el instalado las dos
    `cd ${c.instalado} && node pipeline.js advisors --files ${M}`,
    // lo que le cambia al shell qué programa corre `cat`, también adentro de otro comando
    `hash -p planta/cat cat; cat ${M}`, `hash cat=planta/cat; cat ${M}`, `builtin hash -p planta/cat cat; cat ${M}`, `enable -n cat; cat ${M}`,
    `export -n PATH; cat ${M}`, `read PATH <<< planta; cat ${M}`, `printf -v PATH planta; cat ${M}`, `. planta/p.js; cat ${M}`, `source planta/p.js; cat ${M}`,
    `IFS=x; cat ${M}`, `NODE_OPTIONS=--require=./planta/p.js; ${P} advisors --files ${M}`, `echo $(hash -p planta/cat cat; cat ${M})`,
    `bash -c 'hash -p planta/cat cat; cat ${M}'`, `eval 'hash -p planta/cat cat; cat ${M}'`, `find . -name x -exec sh -c 'hash -p planta/cat cat; cat ${M}' ';'`,
    `if true; then cat ${M}; fi`, `for f in a; do cat ${M}; done`, `python3 planta/p.js; cat ${M}`,
    // la barra invertida al final del renglón no esconde lo que sigue
    `cat \\\n  ${M} \\\n  ; ./${M}`,
    // una barra escapada, o delante de un `\r`, no une los renglones: el de abajo es otro comando
    `cat ${M} \\\\\n./${M}`, `cat ${M} \\\\\nnode ${M}`, `echo \\\\\n./${M}`, `cat ${M} \\\r\n./${M}`, `cat ${M} \\\r\nnode ${M}`, `echo \\\r\n./${M}`,
    // en un comentario tampoco: el salto de línea corta igual
    `cat ${M} # nota \\\n./${M}`, `cat ${M} # nota \\\nnode ${M}`, `# nota \\\n./${M}`, `cat ${M};# nota \\\n./${M}`,
    // también pegado a un operador: unirlo dejaría `#./x`, una palabra que no es nada
    `true;#\\\n./${M}`, `true;#\\\npython3 ${M}`, `true&&#\\\n./${M}`, `true|#\\\n./${M}`, `(#\\\n./${M}\n)`, `true&#\\\n./${M}`, `echo \`#\\\n./${M}\n\``,
    // en el cuerpo de un heredoc la barra es texto: la línea de cierre sigue cerrando y lo de abajo corre
    `cat <<'EOF'\na \\\nEOF\n./${M}\nEOF`, `cat <<EOF\na \\\nEOF\n./${M}\nEOF`, `cat <<'EOF'\na \\\nEOF\nnode ${M}\nEOF`,
    // la ruta del guion en una variable que no se sabe: puede ser otro `pipeline.js`
    `node $X/pipeline.js advisors --files ${M}`, `read X; node $X/pipeline.js advisors --files ${M}`,
  ]) {
    assert.strictEqual(freno(raro), GRANDE, raro);
  }
});

// T6 ExtraRoundAndEscapes_NotExempted
// 🔴 Falla con: eximir por el subcomando sin mirar el resto de la línea. La vuelta extra y los escapes siguen sin
//    exención, y su firma la pide el freno de firmas, que lee el mismo comando con la lista adentro.
test('T6 ExtraRoundAndEscapes_NotExempted', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = `node ${c.pipeline}`;
  for (const raro of [
    `${P} smart-reloop --extra-round --files ${M}`, `${P} smart-reloop --files ${M} --extra-round`, `${P} advisors --extra-round --files ${M}`,
    `F=--extra-round; ${P} smart-reloop --files ${M} $F`, `${P} smart-reloop --files ${M} "$F"`, `${P} smart-reloop --files ${M} $(echo --extra-round)`,
    `${P} check-count --trust-ran --files ${M}`, `${P} deep-review-gate --no-deep-review --files ${M}`,
    `node --env-file=x ${c.pipeline} deep-review-gate --files ${M}`,
  ]) {
    assert.strictEqual(freno(raro), GRANDE, raro);
  }
  const ow = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
  const pide = (comando) => JSON.stringify(ow.firmasDelComando(comando));
  assert.match(pide(`${P} smart-reloop --extra-round --files ${M}`), /extra-round/, 'la vuelta extra sigue pidiendo su firma');
  assert.doesNotMatch(pide(`${P} smart-reloop --files ${M}`), /extra-round/, 'sin la bandera no hay firma que pedir');
});

// T7 RealWritesToTheRunState_StillBlock
// 🔴 Falla con: que la exención saltee los demás frenos del comando, no sólo el de nombrar un guion.
test('T7 RealWritesToTheRunState_StillBlock', () => {
  const c = corral();
  const freno = juzgador(c);
  const P = `node ${c.pipeline} advisors --files ${M}`;
  const activo = path.join(c.estado, 'active', `${SID}.json`);
  fs.writeFileSync(activo, JSON.stringify({ storyId: '1.1', repoPath: c.repo, sessionId: SID, stepsCompleted: [], stepsPending: [] }));
  const ESTADO = '⛔ tycon-pipeline — ESCRITURA DIRECTA AL ESTADO DEL PIPELINE';
  const BORRADO = '⛔ tycon-pipeline — BORRADO DEL ESTADO DEL PIPELINE';
  const HISTORIA = '⛔ tycon-pipeline — HISTORIA ESCRITA POR CONSOLA';
  for (const [raro, esperado] of [
    [`${P} > ${activo}`, ESTADO], [`${P} >> ${activo}`, ESTADO], [`${P} | tee ${activo}`, ESTADO],
    // con un `rm` o un `mv` delante del nombre no hay exención: frena por el guion, antes de mirar el borrado
    [`${P}; rm ${activo}`, GRANDE], [`${P} && mv ${activo} /tmp/x`, GRANDE],
    [`rm ${activo}`, BORRADO], [`mv ${activo} /tmp/x`, BORRADO],
    // los demás frenos siguen viendo el comando de abajo: unir renglones es sólo para buscar guiones
    [`ls \\\\\nrm ${activo}`, BORRADO], [`ls \\\r\nrm ${activo}`, BORRADO], [`ls # nota \\\nrm ${activo}`, BORRADO],
    [`cat ${M} > ${activo}`, ESTADO], [`sed -n 1p ${M} > ${activo}`, ESTADO], [`sed -i s/a/b/ ${activo}`, ESTADO], [`cat ${M} | tee ${activo}`, ESTADO],
    [`cat ${M} > specs/story-1.1.md`, HISTORIA], [`sed -i s/in-progress/done/ specs/story-1.1.md`, HISTORIA], [`${P} > specs/story-1.1.md`, HISTORIA],
  ]) {
    assert.strictEqual(freno(raro), esperado, raro);
  }
});
