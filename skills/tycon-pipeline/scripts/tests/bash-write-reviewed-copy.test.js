'use strict';
// Un guion grande que vive en otra copia del arnés (una carpeta de trabajo aparte) no es del árbol del freno, pero si sus
// bytes son los mismos que main tiene en esa misma ruta, es lo revisado: el freno lo trata como al de su propio árbol. Y
// con `node --test` cada archivo nombrado es un guion que corre, no sólo el primero.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const ORIGEN = path.join(SCRIPTS, '..', '..', '..');
const FRENO = '⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO';
const HISTORIA = '⛔ tycon-pipeline — HISTORIA ESCRITA POR CONSOLA';
const ENV = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@acme.test', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@acme.test' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];

/** Un guion de más de 256 KB que escribe una historia (y la nombra). */
function grande(extra = '') {
  const relleno = '// ' + 'x'.repeat(200) + '\n';
  return `const fs = require('fs');\nfs.writeFileSync('specs/story-1.1.md', 'x');\n${extra}` + relleno.repeat(Math.ceil((300 * 1024) / relleno.length));
}

/**
 * El arnés del freno (un clon con git y su main), el repo con historias donde corre el comando y otra copia del arnés
 * (una carpeta de trabajo sin el freno: sólo un `.git`) con los mismos archivos que main.
 */
function escena() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'copia-revisada-')));
  const estado = path.join(raiz, 'estado');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  const clon = path.join(raiz, 'clon');
  fs.cpSync(SCRIPTS, path.join(clon, 'skills', 'tycon-pipeline', 'scripts'), { recursive: true, filter: (s) => !/[\\/](?:tests|node_modules)$/.test(s) });
  fs.cpSync(path.join(ORIGEN, 'scripts', 'lib'), path.join(clon, 'scripts', 'lib'), { recursive: true });
  fs.cpSync(path.join(ORIGEN, 'scripts', 'setup', 'harness'), path.join(clon, 'scripts', 'setup', 'harness'), { recursive: true });
  fs.mkdirSync(path.join(clon, 'scripts', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(clon, 'scripts', 'tools'), { recursive: true });
  fs.writeFileSync(path.join(clon, 'scripts', 'tests', 'grande.test.js'), "require('../tools/herramienta.js');\n" + grande());
  fs.writeFileSync(path.join(clon, 'scripts', 'tools', 'herramienta.js'), grande());
  fs.writeFileSync(path.join(clon, 'scripts', 'tests', 'chica.test.js'), "require('node:assert');\n");
  const git = (...a) => execFileSync('git', ['-C', clon, '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: GIT_ENV });
  git('init', '-q', '.'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const copia = path.join(raiz, 'copia');
  fs.mkdirSync(path.join(copia, '.git'), { recursive: true });
  for (const rel of ['scripts/tests/grande.test.js', 'scripts/tools/herramienta.js', 'scripts/tests/chica.test.js']) {
    fs.mkdirSync(path.dirname(path.join(copia, rel)), { recursive: true });
    fs.copyFileSync(path.join(clon, rel), path.join(copia, rel));
  }
  const freno = (command, arbol = clon) => conEnv(ENV, () => {
    const r = require(path.join(arbol, 'skills', 'tycon-pipeline', 'scripts', 'on-bash-write-gate.js'))
      .handle({ tool_name: 'Bash', session_id: 'sesion-copia-revisada', cwd: repo, tool_input: { command } }, { stateDir: estado, installedRoots: [] });
    return r && r.block ? r.block.split('\n').find((l) => l.trim()).trim() : '';
  });
  return { raiz, repo, clon, copia, git, freno };
}

// T1 CopiaIgualAMain_Pasa
// 🔴 Falla con: creerle sólo al árbol del freno (la suite de coordinación de una carpeta de trabajo, igual a main, no
//    corre sola), o eximir la suite sin mirar lo que importa.
test('T1 CopiaIgualAMain_Pasa', () => {
  const e = escena();
  assert.equal(e.freno(`node --test ${path.join(e.copia, 'scripts', 'tests', 'grande.test.js')}`), '', 'los mismos bytes que main en la misma ruta: es lo revisado');
  assert.equal(e.freno(`node ${path.join(e.copia, 'scripts', 'tools', 'herramienta.js')}`), '', 'también sin --test');
});

// T1b InstalacionSinGit_ComparaConElArbol
// 🔴 Falla con: pedir git en el árbol del freno (la instalación no lo tiene: el arreglo no llega a ninguna máquina), o
//    creerle a cualquier copia sin comparar los bytes.
test('T1b InstalacionSinGit_ComparaConElArbol', () => {
  const e = escena();
  const instalado = path.join(e.raiz, 'instalado');
  fs.cpSync(e.clon, instalado, { recursive: true, filter: (x) => !/[\\/]\.git$/.test(x) });
  const suite = path.join(e.copia, 'scripts', 'tests', 'grande.test.js');
  assert.equal(e.freno(`node --test ${suite}`, instalado), '', 'los mismos bytes que el árbol instalado en la misma ruta pasan');
  fs.appendFileSync(path.join(e.copia, 'scripts', 'tools', 'herramienta.js'), '// cambiada\n');
  assert.equal(e.freno(`node --test ${suite}`, instalado), FRENO, 'lo que importa, cambiado, frena');
  const otra = path.join(e.copia, 'scripts', 'otra.js');
  fs.copyFileSync(path.join(instalado, 'scripts', 'tools', 'herramienta.js'), otra);
  assert.equal(e.freno(`node ${otra}`, instalado), FRENO, 'en otra ruta frena');
});

// T1c CopiaRevisada_ConUnaHistoriaDeArgumento_Frena
// 🔴 Falla con: eximir la copia revisada de todo (una historia entre sus argumentos ya no frena).
test('T1c CopiaRevisada_ConUnaHistoriaDeArgumento_Frena', () => {
  const e = escena();
  assert.equal(e.freno(`node ${path.join(e.copia, 'scripts', 'tools', 'herramienta.js')} specs/story-1.1.md`), HISTORIA, 'la historia por argumento sigue frenando');
});

// T2 CopiaQueNoEsLaDeMain_Frena
// 🔴 Falla con: eximir cualquier copia de un archivo del arnés (cambiada), una con los bytes de main en otra ruta, la
//    que importa un módulo cambiado, o una igual a un commit que no está en main.
test('T2 CopiaQueNoEsLaDeMain_Frena', () => {
  const e = escena();
  const suite = path.join(e.copia, 'scripts', 'tests', 'grande.test.js');
  const herramienta = path.join(e.copia, 'scripts', 'tools', 'herramienta.js');
  fs.appendFileSync(herramienta, '// cambiada\n');
  assert.equal(e.freno(`node --test ${suite}`), FRENO, 'la suite igual a main que importa un módulo cambiado frena');
  assert.equal(e.freno(`node ${herramienta}`), FRENO, 'un byte distinto de main frena');
  const otraRuta = path.join(e.copia, 'scripts', 'otra.js');
  fs.copyFileSync(path.join(e.clon, 'scripts', 'tools', 'herramienta.js'), otraRuta);
  assert.equal(e.freno(`node ${otraRuta}`), FRENO, 'los bytes de main en otra ruta frenan');
  const local = path.join(e.clon, 'scripts', 'tools', 'herramienta.js');
  fs.appendFileSync(local, '// sólo en el clon\n');
  e.git('commit', '-q', '-am', 'local');
  fs.copyFileSync(local, herramienta);
  assert.equal(e.freno(`node ${herramienta}`), FRENO, 'igual a un commit del clon que no está en main frena');
  const sinGit = path.join(e.raiz, 'suelta', 'scripts', 'tools', 'herramienta.js');
  fs.mkdirSync(path.dirname(sinGit), { recursive: true });
  fs.copyFileSync(path.join(e.copia, 'scripts', 'tests', 'grande.test.js'), sinGit);
  assert.equal(e.freno(`node ${sinGit}`), FRENO, 'fuera de una copia con git no hay ruta que comparar: frena');
});

// T3 NodeTest_CadaArchivoEsUnGuion
// 🔴 Falla con: mirar sólo el primer archivo de `node --test` (una suite chica delante esconde un guion grande que
//    escribe historias), o tomar como guiones los argumentos de un `node guion.js a b` sin --test.
test('T3 NodeTest_CadaArchivoEsUnGuion', () => {
  const e = escena();
  const chica = path.join(e.copia, 'scripts', 'tests', 'chica.test.js');
  const escritor = path.join(e.repo, 'escritor.test.js');
  fs.writeFileSync(escritor, grande('// nuevo\n'));
  assert.equal(e.freno(`node --test ${escritor}`), FRENO, 'solo frena (como hoy)');
  assert.equal(e.freno(`node --test ${chica} ${escritor}`), FRENO, 'con otra suite delante también frena');
  assert.equal(e.freno(`node --test --test-concurrency=1 ${chica} ${escritor}`), FRENO, 'con opciones de --test también');
  assert.equal(e.freno(`node --test --test-name-pattern T1 ${chica} ${escritor}`), FRENO, 'con una opción de valor aparte también');
  assert.equal(e.freno(`node --test ${chica} ${path.join(e.copia, 'scripts', 'tests', 'grande.test.js')}`), '', 'dos suites revisadas pasan');
  assert.equal(e.freno(`node --test ${chica} - ${escritor}`), FRENO, 'detrás de un - también');
  assert.equal(e.freno(`node --test ${chica} ${path.join(e.repo, 'escr*.test.js')}`), FRENO, 'por un comodín también');
  assert.equal(e.freno(`node --test "${path.join(e.repo, 'escr*.test.js')}"`), FRENO, 'por un comodín entre comillas (lo expande node) también');
  assert.equal(e.freno(`node --test ${chica} ${path.join(e.repo, '{escritor,otro}.test.js')}`), FRENO, 'por llaves también');
  assert.equal(e.freno(`echo ${escritor} | xargs node --test ${chica}`), FRENO, 'por xargs también');
  assert.equal(e.freno(`node ${chica} ${escritor}`), '', 'sin --test, lo que sigue al guion es un argumento');
});

// T4 NodeTest_ComodinesYRedirecciones
// 🔴 Falla con: frenar un comodín de más de 200 suites inocuas (cortar la lista en 200), no abrir una ruta con `[id]`
//    literal que escribe historias, o abrir como suite el destino de una redirección.
test('T4 NodeTest_ComodinesYRedirecciones', () => {
  const e = escena();
  const muchas = path.join(e.raiz, 'muchas');
  fs.mkdirSync(muchas);
  for (let i = 0; i < 230; i++) fs.writeFileSync(path.join(muchas, `s${i}.test.js`), "require('node:assert');\n");
  assert.equal(e.freno(`node --test ${path.join(muchas, '*.test.js')}`), '', '230 suites inocuas por comodín pasan');
  fs.writeFileSync(path.join(muchas, 's999.test.js'), grande('// escondido\n'));
  assert.equal(e.freno(`node --test ${path.join(muchas, '*.test.js')}`), FRENO, 'un escritor entre ellas frena');
  const conCorchetes = path.join(e.raiz, 'app', '[id]');
  fs.mkdirSync(conCorchetes, { recursive: true });
  fs.writeFileSync(path.join(conCorchetes, 'w.test.js'), grande('// corchetes\n'));
  assert.equal(e.freno(`node --test '${path.join(conCorchetes, 'w.test.js')}'`), FRENO, 'una ruta con [id] literal se abre');
  const salida = path.join(e.raiz, 'salida.txt');
  fs.writeFileSync(salida, grande('// salida\n'));
  const chica = path.join(e.copia, 'scripts', 'tests', 'chica.test.js');
  assert.equal(e.freno(`node --test ${chica} > ${salida}`), '', 'el destino de una redirección no es una suite');
});

// T5 NodeTest_EnUnBucle_MiraCadaArchivo
// 🔴 Falla con: no mirar el guion que llega en la variable de un `for` o de un `while read` (`node --test "$f"`), en
//    primer plano o de fondo, o soltar la ruta armada con la variable (`t/$f`, `$f.test.js`).
test('T5 NodeTest_EnUnBucle_MiraCadaArchivo', () => {
  const e = escena();
  const chica = path.join(e.copia, 'scripts', 'tests', 'chica.test.js');
  const escritor = path.join(e.repo, 'escritor.test.js');
  fs.writeFileSync(escritor, grande('// nuevo\n'));
  fs.mkdirSync(path.join(e.repo, 't'));
  fs.copyFileSync(escritor, path.join(e.repo, 't', 'w.test.js'));
  for (const c of [
    `for f in ${chica} ${escritor}; do node --test "$f" | grep ok; done`,
    `for f in ${chica} ${escritor}; do node --test "$f" | grep ok; done &`,
    `for f in ${escritor}; do node $f; done`,
    'ls *.test.js | while read f; do node --test "$f"; done',
    'ls t | while read f; do node --test "t/$f"; done',
    'for f in escritor; do node --test "$f.test.js"; done',
  ]) assert.equal(e.freno(c), FRENO, c);
  assert.equal(e.freno(`for f in ${chica}; do node --test "$f"; done`), '', 'un bucle sobre una suite inocua pasa');
});

// T6 Bucle_NoTapaLoQueSigue_YUsaSuLista
// 🔴 Falla con: que el guion abierto como candidato de un bucle (sin argumentos) tape la historia que recibe cuando
//    corre después; cambiar la variable por un comodín cuando la lista del `for` se ve (abre todas las suites de la
//    carpeta), o no ver la carpeta dentro de la variable ni las comillas del medio.
test('T6 Bucle_NoTapaLoQueSigue_YUsaSuLista', () => {
  const e = escena();
  const chica = path.join(e.copia, 'scripts', 'tests', 'chica.test.js');
  fs.writeFileSync(path.join(e.repo, 'tool.js'), "console.log(process.argv[2]);\n");
  assert.equal(e.freno(`for f in ${chica} tool.js; do node --test "$f"; done; node tool.js specs/story-1.1.md`), HISTORIA, 'el bucle delante no tapa la historia del que sigue');
  assert.equal(e.freno('node "$NADA"; node tool.js specs/story-1.1.md'), HISTORIA, 'una variable sin valor delante tampoco');
  fs.mkdirSync(path.join(e.repo, 't'));
  fs.writeFileSync(path.join(e.repo, 't', 'w.test.js'), grande('// carpeta\n'));
  assert.equal(e.freno('for f in t/w; do node --test "$f.test.js"; done'), FRENO, 'la carpeta dentro de la variable');
  assert.equal(e.freno('ls t | while read f; do node --test t/"$f"; done'), FRENO, 'las comillas del medio');
  assert.equal(e.freno('for f in chica otra; do node --test "t/$f.test.js"; done'), '', 'con la lista a la vista, sólo sus palabras');
});
