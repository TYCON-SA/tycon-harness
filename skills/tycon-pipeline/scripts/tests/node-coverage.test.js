'use strict';
/**
 * Pruebas de lib/node-coverage.js y de lib/coverage-wrapper.js: la cobertura de las pruebas del arnés.
 *
 * El corredor de suites del arnés deja un lcov (el formato de líneas del medidor de Node). Este lector lo vuelve el
 * mismo mapa archivo → línea → cubierta que test-gate-report.js ya arma desde coverage-final.json y cobertura.xml.
 *
 *   T6 · Lcov_MismoMapaQueCoverageFinal —un archivo medido de verdad por Node (lcov) y el mismo archivo en el
 *        formato de istanbul: sobre las líneas que los dos cuentan como medibles, las mismas cubiertas y no cubiertas.
 *   T7 · Lcov_RutasRealesYDeWindows —una ruta por enlace simbólico y otra con barras de Windows caen en la ruta
 *        real con `/`; lo de fuera de la carpeta pedida se descarta y se cuenta.
 *   T8 · Lcov_IlegibleOVacio_ConMotivo —un lcov vacío, uno cortado a la mitad y uno con una línea rota: «sin
 *        cruce» con el archivo y el motivo, nunca un mapa.
 *
 * Nada de nombres reales: acme. Correr: node skills/tycon-pipeline/scripts/tests/node-coverage.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('child_process');

const { readLcov, joinLcov, codeLines } = require('../lib/node-coverage');
const WRAPPER = path.join(__dirname, '..', 'lib', 'coverage-wrapper.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acme-lcov-'));
const real = (p) => fs.realpathSync(p).split('\\').join('/');

// Un archivo con una rama que corre y otra que no, y una función que nunca se llama.
const OBJETIVO = [
  "'use strict';",
  'function clasificar(n) {',
  '  if (n > 0) {',
  "    return 'positivo';",
  '  } else {',
  "    const x = 'no positivo';",
  '    return x;',
  '  }',
  '}',
  'function nuncaLlamada() {',
  "  return 'nunca';",
  '}',
  'console.log(clasificar(5));',
  'module.exports = { clasificar, nuncaLlamada };',
  '',
].join('\n');

// El mismo archivo como lo deja istanbul (coverage-final.json): una sentencia por línea donde empieza, con sus pasadas.
const ISTANBUL = {
  statementMap: {
    0: { start: { line: 1 } }, 1: { start: { line: 3 } }, 2: { start: { line: 4 } }, 3: { start: { line: 6 } },
    4: { start: { line: 7 } }, 5: { start: { line: 11 } }, 6: { start: { line: 13 } }, 7: { start: { line: 14 } },
  },
  s: { 0: 1, 1: 1, 2: 1, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1 },
};

/** La regla de test-gate-report.js para coverage-final.json: una línea es medible si una sentencia EMPIEZA en ella. */
function mapaIstanbul(entry) {
  const m = new Map();
  for (const [k, loc] of Object.entries(entry.statementMap)) {
    const l = loc.start.line;
    m.set(l, (m.get(l) || false) || entry.s[k] > 0);
  }
  return m;
}

test('T6 7.31-Lcov_MismoMapaQueCoverageFinal @story-7.31 @ac-6 — el lcov de Node y el de istanbul dan las mismas líneas cubiertas', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'objetivo.js'), OBJETIVO);
  // Medido de verdad, como proceso hijo de una prueba (así corre el código de las suites del arnés).
  fs.writeFileSync(path.join(d, 'acme.test.js'), [
    "const { test } = require('node:test');",
    "const { spawnSync } = require('child_process');",
    "test('hijo', () => { spawnSync(process.execPath, [require('path').join(__dirname, 'objetivo.js')]); });",
  ].join('\n'));
  const lcov = path.join(d, 'acme.lcov');
  // Sin las variables de la corrida de afuera: con NODE_TEST_CONTEXT el `--test` de adentro no escribe su reporte.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=lcov',
    `--test-reporter-destination=${lcov}`, 'acme.test.js'], { cwd: d, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);

  const leido = readLcov(lcov, { base: d });
  assert.strictEqual(leido.ok, true, leido.reason);
  const deNode = leido.map.get(real(path.join(d, 'objetivo.js')));
  assert.ok(deNode, `el lcov no trae objetivo.js: ${[...leido.map.keys()].join(', ')}`);
  const deIstanbul = mapaIstanbul(ISTANBUL);
  const comunes = [...deIstanbul.keys()].filter((l) => deNode.has(l));
  assert.deepStrictEqual(comunes, [1, 3, 4, 6, 7, 11, 13, 14], 'las líneas que los dos cuentan como medibles');
  for (const l of comunes) assert.strictEqual(deNode.get(l), deIstanbul.get(l), `línea ${l}`);
  // y lo que sólo cuenta V8 (llaves y declaraciones) también está bien marcado
  assert.strictEqual(deNode.get(8), false, 'la llave que cierra el else no corrió');
  assert.strictEqual(deNode.get(10), false, 'la declaración de la función que nunca se llama');
  assert.strictEqual(deNode.get(5), true, '«} else {» empieza en la parte que corrió');
});

test('T6 …los comentarios y las líneas en blanco no cuentan: un archivo documentado que no corrió no pasa por cubierto @story-7.31 @ac-6', () => {
  // 🔴 rojo: V8 marca cubiertas las líneas de comentario del nivel superior de un archivo cargado; contadas, una
  // cabecera de documentación alcanza para el 75 % sin que corra ninguna función.
  const d = tmp();
  const cabecera = ['/**', ...Array.from({ length: 30 }, (_, i) => ` * línea ${i + 1} de la cabecera`), ' */'];
  const fuente = ["'use strict';", ...cabecera, '', 'function parse(x) {', '  // un comentario de línea', "  if (!x) throw new Error('vacío'); /* y uno al final */", "  return String(x).split(',');", '}', 'module.exports = { parse };', ''].join('\n');
  fs.writeFileSync(path.join(d, 'nuevo.js'), fuente);
  fs.writeFileSync(path.join(d, 'acme.test.js'), "require('node:test')('carga', () => { require('./nuevo.js'); });\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const lcov = path.join(d, 'acme.lcov');
  const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=lcov',
    `--test-reporter-destination=${lcov}`, 'acme.test.js'], { cwd: d, encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = readLcov(lcov, { base: d }).map.get(real(path.join(d, 'nuevo.js')));
  assert.ok(lineas, 'el lcov trae nuevo.js');
  for (let n = 2; n <= 33; n++) assert.ok(!lineas.has(n), `la línea ${n} es comentario: no se mide`);
  assert.ok(!lineas.has(34), 'la línea en blanco no se mide');
  assert.ok(!lineas.has(36), 'el comentario de línea no se mide');
  assert.strictEqual(lineas.get(37), false, 'la línea con código y un comentario al final sí, y no corrió');
  assert.strictEqual(lineas.get(38), false);
  const cubiertas = [...lineas.values()].filter(Boolean).length;
  assert.ok(cubiertas / lineas.size < 0.75, `${cubiertas} de ${lineas.size}: sin los comentarios no llega al 75 %`);
});

test('T6 …codeLines: qué es comentario y qué es código @story-7.31 @ac-6', () => {
  // 🔴 rojo: un `//` dentro de una cadena corta la línea como comentario, una plantilla de varias líneas pierde sus
  // líneas, o el shebang cuenta como código.
  const fuente = [
    '#!/usr/bin/env node',                 // 1 shebang: no es código
    "const url = 'http://acme.example';",  // 2 el // de la cadena no es un comentario
    'const t = `uno',                      // 3 plantilla de varias líneas…
    '/* no es comentario */ dos`;',        // 4 …su contenido es código
    "const s = 'a\\",                      // 5 cadena con barra y salto de línea…
    "b';",                                 // 6 …sigue siendo código
    '/* bloque',                           // 7 comentario de bloque…
    '   sigue */',                         // 8 …hasta acá
    '   ',                                 // 9 en blanco
    'x(); // y un comentario',             // 10 código con comentario al final
  ].join('\n');
  assert.deepStrictEqual([...codeLines(fuente)].sort((a, b) => a - b), [2, 3, 4, 5, 6, 10]);
  // una expresión regular con comillas o barras adentro no deja abierta una cadena ni un comentario
  const conRegex = ["const a = /'/;", '// uno', 'const b = x.replace(/\\/\\*/g, "");', '/* dos */', "if (/[\"']/.test(c)) y();", '// tres', "const z = 'sin cerrar", '// cuatro'].join('\n');
  assert.deepStrictEqual([...codeLines(conRegex)].sort((a, b) => a - b), [1, 3, 5, 7]);
  // la división no es una expresión regular: si lo fuera, se comería el «/*» y la línea 2 contaría como código
  assert.deepStrictEqual([...codeLines('const x = a / 2; /*\ncomentario */')], [1]);
  // un archivo fuente que no se puede leer queda con lo que dijo V8, y se nombra
  const d = tmp();
  fs.writeFileSync(path.join(d, 'x.lcov'), 'TN:\nSF:no-esta.js\nDA:1,1\nDA:2,0\nend_of_record\n');
  const leido = readLcov(path.join(d, 'x.lcov'), { base: d });
  assert.deepStrictEqual([...leido.map.values()][0], new Map([[1, true], [2, false]]));
  assert.deepStrictEqual(leido.sourceUnreadable, [real(d) + '/no-esta.js']);
});

test('T5 …joinLcov con finales de Windows y sin carpeta @story-7.31 @ac-5', () => {
  // Resguardo: un lcov con finales de Windows se junta y se lee entero (un registro que no termina se descartaría).
  const d = tmp();
  const cov = path.join(d, 'cov');
  fs.mkdirSync(cov);
  fs.writeFileSync(path.join(d, 'a.js'), 'x\r\n');
  fs.writeFileSync(path.join(cov, '0000.lcov'), 'TN:\r\nSF:a.js\r\nDA:1,1\r\nend_of_record\r\n');
  const out = path.join(cov, 'lcov.info');
  const j = joinLcov(cov, out, { base: d });
  assert.deepStrictEqual([j.withData, j.withoutData, j.unreadable], [1, [], []]);
  const leido = readLcov(out, { base: d });
  assert.strictEqual(leido.ok, true, leido.reason);
  assert.deepStrictEqual([...leido.map.values()][0], new Map([[1, true]]));
  const sin = joinLcov(path.join(d, 'no-esta'), path.join(d, 'otro', 'lcov.info'));
  assert.deepStrictEqual([sin.withData, sin.withoutData, sin.unreadable], [0, [], []], 'sin carpeta: nada, sin romper');
});

test('T7 …las claves salen de la misma ruta real que usa el informe @story-7.31 @ac-6', () => {
  // 🔴 rojo: el lector resuelve con una función y el informe con otra (en Windows, realpathSync contra .native): las
  // claves no se encuentran y todo queda «sin datos».
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.js'), 'x\n');
  fs.writeFileSync(path.join(d, 'b.lcov'), 'TN:\nSF:a.js\nDA:1,1\nend_of_record\n');
  const visto = [];
  const leido = readLcov(path.join(d, 'b.lcov'), { base: d, realpath: (p) => { visto.push(p); return `/MISMA/${path.basename(p)}`; } });
  assert.deepStrictEqual([...leido.map.keys()], ['/MISMA/a.js']);
  assert.ok(visto.length > 0, 'usa la función que le pasan');
});

test('T7 7.31-Lcov_RutasRealesYDeWindows @story-7.31 @ac-6 — enlace y barras de Windows caen en la ruta real con «/»', () => {
  const d = tmp();
  const arbol = path.join(d, 'arbol');
  fs.mkdirSync(path.join(arbol, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(arbol, 'scripts', 'lib', 'acme.js'), 'a\nb\n');
  fs.writeFileSync(path.join(arbol, 'scripts', 'lib', 'acme-dos.js'), 'a\nb\n');
  const enlace = path.join(d, 'enlace');
  fs.symlinkSync(arbol, enlace, process.platform === 'win32' ? 'junction' : 'dir');
  const afuera = path.join(d, 'afuera.js');
  fs.writeFileSync(afuera, 'x\n');
  const lcov = path.join(d, 'acme.lcov');
  fs.writeFileSync(lcov, [
    'TN:', `SF:${path.join(enlace, 'scripts', 'lib', 'acme.js')}`, 'DA:1,1', 'DA:2,0', 'LH:1', 'LF:2', 'end_of_record',
    'TN:', 'SF:scripts\\lib\\acme-dos.js', 'DA:1,0', 'DA:2,3', 'end_of_record',
    'TN:', `SF:${afuera}`, 'DA:1,1', 'end_of_record',
    // el mismo archivo en otra suite: cubierta si ALGUNA la ejecutó
    'TN:', 'SF:scripts/lib/acme.js', 'DA:2,4', 'end_of_record',
    '',
  ].join('\n'));

  const leido = readLcov(lcov, { base: enlace, within: arbol });
  assert.strictEqual(leido.ok, true, leido.reason);
  const uno = real(path.join(arbol, 'scripts', 'lib', 'acme.js'));
  const dos = real(path.join(arbol, 'scripts', 'lib', 'acme-dos.js'));
  assert.deepStrictEqual([...leido.map.keys()].sort(), [uno, dos].sort());
  for (const k of leido.map.keys()) assert.ok(!k.includes('\\'), `clave con barra de Windows: ${k}`);
  assert.deepStrictEqual([...leido.map.get(uno)], [[1, true], [2, true]]);
  assert.deepStrictEqual([...leido.map.get(dos)], [[1, false], [2, true]]);
  assert.deepStrictEqual(leido.outside, [real(afuera)], 'lo de fuera del árbol se descarta y se nombra');
});

test('T8 7.31-Lcov_IlegibleOVacio_ConMotivo @story-7.31 @ac-7 — vacío, cortado o roto: «sin cruce» con el archivo y el motivo', () => {
  const d = tmp();
  const casos = {
    vacio: ['', /no trae ningún archivo/],
    'solo-tn': ['TN:\n', /no trae ningún archivo/],
    cortado: ['TN:\nSF:a.js\nDA:1,1\nDA:2,', /cortado.*a\.js/],
    roto: ['TN:\nSF:a.js\nDA:uno,1\nend_of_record\n', /línea 3.*DA:uno,1/],
  };
  for (const [nombre, [texto, motivo]] of Object.entries(casos)) {
    const f = path.join(d, `${nombre}.lcov`);
    fs.writeFileSync(f, texto);
    const leido = readLcov(f, { base: d });
    assert.strictEqual(leido.ok, false, `${nombre}: tenía que ser «sin cruce»`);
    assert.strictEqual(leido.map, undefined, `${nombre}: no trae mapa`);
    assert.ok(leido.reason.includes(f), `${nombre}: el motivo nombra el archivo (${leido.reason})`);
    assert.match(leido.reason, motivo, nombre);
  }
  const falta = readLcov(path.join(d, 'no-esta.lcov'), { base: d });
  assert.strictEqual(falta.ok, false);
  assert.match(falta.reason, /no-esta\.lcov.*no se pudo leer/);
});

test('T8 …un lcov con los registros mal armados también es «sin cruce», con la línea @story-7.31 @ac-7', () => {
  // 🔴 rojo: un SF dentro de otro, un end_of_record suelto o un DA fuera de registro se leen como datos.
  const d = tmp();
  const casos = {
    anidado: ['TN:\nSF:a.js\nDA:1,1\nSF:b.js\nDA:1,1\nend_of_record\n', /línea 4.*a\.js no termina/],
    'fin-suelto': ['TN:\nend_of_record\n', /línea 2.*«end_of_record» sin registro/],
    'da-afuera': ['TN:\nDA:1,1\nSF:a.js\nend_of_record\n', /línea 2.*DA:1,1/],
  };
  for (const [nombre, [texto, motivo]] of Object.entries(casos)) {
    const f = path.join(d, `${nombre}.lcov`);
    fs.writeFileSync(f, texto);
    const leido = readLcov(f, { base: d, label: `el-${nombre}` });
    assert.strictEqual(leido.ok, false, nombre);
    assert.match(leido.reason, motivo, nombre);
    assert.ok(leido.reason.startsWith(`el-${nombre}: `), `${nombre}: con label, el motivo nombra el label (${leido.reason})`);
  }
});

test('T5 …el envoltorio sale con el código de la suite, y nunca 0 si no la corrió @story-7.31 @ac-4', () => {
  // 🔴 rojo: el envoltorio sin argumentos, o con un ejecutable que no existe, sale 0 (una suite que no corrió en verde).
  const d = tmp();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const correr = (args) => spawnSync(process.execPath, ['--experimental-test-coverage', '--test-reporter=lcov',
    `--test-reporter-destination=${path.join(d, 'x.lcov')}`, WRAPPER, ...args], { encoding: 'utf8', env });
  const s3 = path.join(d, 'tres.sh');
  fs.writeFileSync(s3, 'echo hola\nexit 3\n');
  const tres = correr(['bash', s3]);
  assert.strictEqual(tres.status, 3, 'el código de la suite');
  assert.match(tres.stdout, /hola/, 'la salida de la suite, tal cual');
  const sinArgs = correr([]);
  assert.strictEqual(sinArgs.status, 2, `sin argumentos no es verde: ${sinArgs.stderr}`);
  assert.match(sinArgs.stderr, /uso/);
  const noArranca = correr([path.join(d, 'no-existe'), s3]);
  assert.strictEqual(noArranca.status, 127, 'un ejecutable que no arranca');
  assert.match(noArranca.stderr, /no pude lanzar/);
  const kill = path.join(d, 'kill.sh');
  fs.writeFileSync(kill, 'kill -9 $$\n');
  assert.strictEqual(correr(['bash', kill]).status, 124, 'muerta por una señal');
});

test('T5 …joinLcov: sin datos y con un archivo ilegible, cada cosa por su nombre @story-7.31 @ac-5', () => {
  // 🔴 rojo: un lcov que no se pudo leer contado como «sin datos» (se confunde con una suite de bash sin node).
  const d = tmp();
  const cov = path.join(d, 'cov');
  fs.mkdirSync(cov);
  fs.writeFileSync(path.join(d, 'a.js'), 'x\n');
  fs.writeFileSync(path.join(cov, '0000.lcov'), 'TN:\nSF:a.js\nDA:1,1\nend_of_record\nTN:\nSF:wrap.js\nDA:1,1\nend_of_record\n');
  fs.writeFileSync(path.join(cov, '0001.lcov'), 'TN:\n');
  fs.mkdirSync(path.join(cov, '0002.lcov'));   // un «archivo» que no se puede leer
  fs.writeFileSync(path.join(cov, '0003.lcov'), 'TN:\nSF:a.js\nDA:1,1\nend_of_record\nTN:\nSF:a.js\nDA:2,');   // cortado
  fs.writeFileSync(path.join(d, 'wrap.js'), 'w\n');
  const out = path.join(cov, 'lcov.info');
  const j = joinLcov(cov, out, { base: d, drop: [path.join(d, 'wrap.js')] });
  assert.strictEqual(j.withData, 1);
  assert.deepStrictEqual(j.withoutData, ['0001.lcov']);
  assert.strictEqual(j.unreadable.length, 2);
  assert.strictEqual(j.unreadable[0].name, '0002.lcov');
  assert.match(j.unreadable[0].reason, /EISDIR|no se pudo leer/);
  assert.strictEqual(j.unreadable[1].name, '0003.lcov', 'un lcov cortado no se descarta callado');
  assert.match(j.unreadable[1].reason, /cortado/);
  const juntado = fs.readFileSync(out, 'utf8');
  assert.match(juntado, /^SF:a\.js$/m);
  assert.doesNotMatch(juntado, /wrap\.js/, 'lo de `drop` no queda');
  assert.strictEqual(readLcov(out, { base: d }).ok, true, 'lo juntado se lee');
});
