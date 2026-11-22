'use strict';

/**
 * Lo que sostiene partir marker.js por responsabilidad, antes de mover nada: lo que el despachador cargue de nuevo es
 * sensible (T16) y el recorrido del freno de guiones no corta callado (T14), porque partir suma un nivel de `require`
 * locales (despachador → módulo → ayudante).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib');

/**
 * Los `require` locales de un archivo, resueltos a rutas relativas a la raíz del arnés (con `/`): los literales
 * (`require('./x.js')`) y los armados con la carpeta del archivo o con `SCRIPTS_DIR` y partes literales
 * (`require(path.join(__dirname, 'lib', 'x.js'))`). Lo que se arma con otra variable no se puede resolver y no cuenta.
 */
function requiresLocales(archivo, scriptsDir = SCRIPTS) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const dir = path.dirname(archivo);
  const out = new Set();
  const rel = (abs) => path.relative(path.resolve(scriptsDir, '..', '..', '..'), abs).split(path.sep).join('/');
  for (const m of texto.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) out.add(rel(path.resolve(dir, m[1])));
  for (const m of texto.matchAll(/require\(\s*path\.join\(\s*(__dirname|SCRIPTS_DIR)\s*,\s*((?:'[^']*'\s*,?\s*)+)\)\s*\)/g)) {
    const base = m[1] === '__dirname' ? dir : scriptsDir;
    const partes = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    out.add(rel(path.resolve(base, ...partes)));
  }
  return [...out].sort();
}

/** Lo que cargan los archivos y no estaba en la lista de antes, y no es sensible. */
function nuevosNoSensibles(antes, archivos, scriptsDir = SCRIPTS) {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  const ahora = new Set(archivos.flatMap((a) => requiresLocales(a, scriptsDir)));
  return [...ahora].filter((r) => !antes.includes(r) && !esSensible(r)).sort();
}

test('T16 Split_ModulesAreSensitive @story-8.163 @ac-16', () => {
  const { esSensible } = require(path.join(LIB, 'save-ok.js'));
  // lo que sale de marker.js, de pipeline.js y del freno de guiones nace sensible, se llame como se llame la parte
  for (const m of ['marker-firmas.js', 'pipeline-pasos.js', 'bash-gate-guiones.js']) {
    assert.ok(esSensible(`skills/tycon-pipeline/scripts/lib/${m}`), `lib/${m} es sensible`);
  }
  // la medida es lo que carga el despachador contra la lista de antes, no el nombre: un módulo nuevo fuera del patrón
  // falla; uno de la partición no; uno que ya cargaba (lib/steps.js) no cuenta
  const antes = requiresLocales(path.join(SCRIPTS, 'marker.js'));
  assert.ok(antes.includes('skills/tycon-pipeline/scripts/lib/steps.js'), 'marker.js ya cargaba lib/steps.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'split-sensible-'));
  const juguete = path.join(raiz, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  fs.mkdirSync(path.dirname(juguete), { recursive: true });
  fs.writeFileSync(juguete, "require('./lib/x.js');\nrequire('./lib/steps.js');\nrequire('./lib/marker-firmas.js');\n");
  assert.deepStrictEqual(nuevosNoSensibles(antes, [juguete], path.dirname(juguete)), ['skills/tycon-pipeline/scripts/lib/x.js'],
    'el juguete nuevo falla; lib/steps.js, que ya estaba, y lib/marker-firmas.js, sensible, no');
});

// ── el recorrido del freno de guiones ────────────────────────────────────────────────────────────────────────────────

const bash = () => require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const FRENO_ENTERO = '⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO';

/** Un repo de juguete con una historia y una carpeta de estado, para el freno. */
function repoDelFreno() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-freno-')));
  const estado = path.join(raiz, 'estado');
  const dir = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  return { raiz, estado, dir };
}

function frenar(r, command, installedRoots = []) {
  const antes = process.env.TYCON_NO_RUN_CHANGE;
  process.env.TYCON_NO_RUN_CHANGE = '1';
  try {
    const x = bash().handle({ tool_name: 'Bash', session_id: 'sesion-split', cwd: r.dir, tool_input: { command } }, { stateDir: r.estado, installedRoots });
    return x && x.block ? String(x.block) : '';
  } finally { if (antes === undefined) delete process.env.TYCON_NO_RUN_CHANGE; else process.env.TYCON_NO_RUN_CHANGE = antes; }
}

/** Una cadena de módulos de juguete: `principal.js` → m1 → … → m<largo>; el último hace `ultimo`. */
function cadena(dir, largo, ultimo) {
  fs.mkdirSync(path.join(dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'herr', 'principal.js'), "require('./m1.js');\n");
  for (let i = 1; i <= largo; i++) fs.writeFileSync(path.join(dir, 'herr', `m${i}.js`), i === largo ? ultimo : `require('./m${i + 1}.js');\n`);
}
// la ruta de la constancia va armada por partes: escrita entera, el freno de esta misma sesión leería esta prueba como
// un guion que escribe una constancia
const CONSTANCIA = ['.tycon', 'control-changes', 'aprobado.json'].join('/');
const ESCRIBE_CONSTANCIA = ['require(\'fs\').write', 'FileSync(\'', CONSTANCIA, '\', \'{}\');\n'].join('');
const NO_ESCRIBE = "module.exports = 1 + 1;\n";

// 🔴 Falla con: el recorrido que corta callado a los 2 niveles o a los 20 archivos (el freno de antes), o que juzga el
// primer módulo pasado el tope pero no lo que ese módulo carga.
test('T14 BashGate_DeepModule_BlocksNotCuts @story-8.163 @ac-14', () => {
  const freno = fs.readFileSync(path.join(SCRIPTS, 'on-bash-write-gate.js'), 'utf8');
  // sin nombre todavía, el de antes: 2 niveles y 20 archivos (el comportamiento da el rojo, no la falta del nombre)
  const niveles = Number((/const RECORRIDO_NIVELES = (\d+);/.exec(freno) || [])[1]) || 2;
  const tope = Number((/const RECORRIDO_ARCHIVOS = (\d+);/.exec(freno) || [])[1]) || 20;
  // nivel 3: el freno de antes cortaba callado a los 2 niveles
  const a = repoDelFreno();
  cadena(a.dir, 3, ESCRIBE_CONSTANCIA);
  assert.notStrictEqual(frenar(a, 'node herr/principal.js'), '', 'el módulo del nivel 3 que escribe una constancia frena');
  // el archivo 21 de los que carga: el de antes cortaba callado a los 20
  const b = repoDelFreno();
  fs.mkdirSync(path.join(b.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(b.dir, 'herr', 'principal.js'), Array.from({ length: 21 }, (_, i) => `require('./h${i + 1}.js');`).join('\n') + '\n');
  for (let i = 1; i <= 21; i++) fs.writeFileSync(path.join(b.dir, 'herr', `h${i}.js`), i === 21 ? ESCRIBE_CONSTANCIA : NO_ESCRIBE);
  assert.notStrictEqual(frenar(b, 'node herr/principal.js'), '', 'el archivo 21 que escribe una constancia frena');
  // más allá del número nuevo: frena con «no se puede leer entero»
  const c = repoDelFreno();
  cadena(c.dir, niveles + 1, ESCRIBE_CONSTANCIA);
  assert.ok(frenar(c, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'más allá del tope, frena con «no se puede leer entero»');
  // igual de hondo, sin escribir ni nombrar historia ni constancia: no frena
  const d = repoDelFreno();
  cadena(d.dir, niveles + 1, NO_ESCRIBE);
  assert.strictEqual(frenar(d, 'node herr/principal.js'), '', 'igual de hondo y sin escribir: no frena');
  // lo que carga un módulo fuera del tope también se mira: dos niveles más allá frena igual, y sin escribir sigue sin frenar
  const e = repoDelFreno();
  cadena(e.dir, niveles + 2, ESCRIBE_CONSTANCIA);
  assert.ok(frenar(e, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'dos niveles más allá del tope, frena');
  const f = repoDelFreno();
  cadena(f.dir, niveles + 2, NO_ESCRIBE);
  assert.strictEqual(frenar(f, 'node herr/principal.js'), '', 'dos niveles más allá y sin escribir: no frena');
  // lo mismo pasado el tope de archivos: el último de la lista no escribe, pero carga al que escribe
  const g = repoDelFreno();
  fs.mkdirSync(path.join(g.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(g.dir, 'herr', 'principal.js'), Array.from({ length: tope + 1 }, (_, i) => `require('./h${i + 1}.js');`).join('\n') + '\n');
  for (let i = 1; i <= tope; i++) fs.writeFileSync(path.join(g.dir, 'herr', `h${i}.js`), NO_ESCRIBE);
  fs.writeFileSync(path.join(g.dir, 'herr', `h${tope + 1}.js`), "require('./detras.js');\n");
  fs.writeFileSync(path.join(g.dir, 'herr', 'detras.js'), ESCRIBE_CONSTANCIA);
  assert.ok(frenar(g, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'detrás del tope de archivos, frena');
  // un ciclo pasado el tope termina, sin frenar
  const h = repoDelFreno();
  cadena(h.dir, niveles + 2, `require('./m${niveles + 1}.js');\n`);
  assert.strictEqual(frenar(h, 'node herr/principal.js'), '', 'un ciclo pasado el tope termina y no frena');
  // pasado el tope, lo que no se puede leer no se da por bueno
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const i = repoDelFreno();
    cadena(i.dir, niveles + 1, NO_ESCRIBE);
    fs.chmodSync(path.join(i.dir, 'herr', `m${niveles + 1}.js`), 0o000);
    assert.ok(frenar(i, 'node herr/principal.js').startsWith(FRENO_ENTERO), 'un módulo ilegible pasado el tope frena');
  }
  // uno instalado pasado el tope no se juzga, pero lo que carga sí
  const j = repoDelFreno();
  const arnes = path.join(j.raiz, 'arnes');
  fs.mkdirSync(arnes);
  cadena(j.dir, niveles, "require('../../arnes/puente.js');\n");
  fs.writeFileSync(path.join(arnes, 'puente.js'), "require('../repo/herr/detras.js');\n");
  fs.writeFileSync(path.join(j.dir, 'herr', 'detras.js'), ESCRIBE_CONSTANCIA);
  assert.ok(frenar(j, 'node herr/principal.js', [arnes]).startsWith(FRENO_ENTERO), 'detrás de uno instalado, frena');
  assert.ok(niveles > 2 && tope > 20, `el tope del recorrido tiene nombre y subió (niveles ${niveles}, archivos ${tope})`);
});

// 🔴 Falla con: un recorrido que lee el mismo módulo cada vez que alguien lo pide, que no tiene tope de lectura, o que
// lee entero un ejecutable para ver su línea `#!`.
test('T14 BashGate_ModuleWalk_ReadsAreBounded @story-8.163 @ac-14', () => {
  // el mismo módulo, pedido desde dos lados, se lee una sola vez
  const a = repoDelFreno();
  fs.mkdirSync(path.join(a.dir, 'herr'), { recursive: true });
  const repetido = path.join(a.dir, 'herr', 'a.js');
  fs.writeFileSync(path.join(a.dir, 'herr', 'principal.js'), "require('./uno.js');\nrequire('./otro.js');\n");
  fs.writeFileSync(path.join(a.dir, 'herr', 'uno.js'), "require('./a.js');\n");
  fs.writeFileSync(path.join(a.dir, 'herr', 'otro.js'), "require('./a.js');\n");
  fs.writeFileSync(repetido, NO_ESCRIBE);
  const original = fs.readFileSync;
  let lecturas = 0;
  fs.readFileSync = (f, ...resto) => { if (String(f) === repetido) lecturas++; return original(f, ...resto); };
  try { assert.strictEqual(frenar(a, 'node herr/principal.js'), '', 'un módulo que no escribe no frena'); } finally { fs.readFileSync = original; }
  assert.strictEqual(lecturas, 1, 'el módulo repetido se lee una vez');
  // gastado el tope de lectura no se lee más, y lo que falta cuenta como que no se pudo leer
  const b = repoDelFreno();
  fs.mkdirSync(path.join(b.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(b.dir, 'herr', 'principal.js'), "require('./grande.js');\nrequire('./despues.js');\n");
  fs.writeFileSync(path.join(b.dir, 'herr', 'grande.js'), `// ${'x'.repeat(20000)}\n`);
  fs.writeFileSync(path.join(b.dir, 'herr', 'despues.js'), NO_ESCRIBE);
  const guiones = bash().guionesEnArchivo('node herr/principal.js', [b.dir], [], 8192);
  assert.ok(guiones.some((g) => g.grande && !g.texto), 'agotado el tope, queda un guion sin leer');
  assert.ok(!guiones.some((g) => g.archivo.endsWith('despues.js') && g.texto), 'lo de después del tope no se lee');
  // el tope es lo que se lee entre todos, no un umbral que se mira antes de leer: un archivo que lo pasaría no se lee
  const b2 = repoDelFreno();
  fs.mkdirSync(path.join(b2.dir, 'herr'), { recursive: true });
  fs.writeFileSync(path.join(b2.dir, 'herr', 'principal.js'), "require('./justo.js');\n");
  fs.writeFileSync(path.join(b2.dir, 'herr', 'justo.js'), `// ${'x'.repeat(5000)}\n`);
  const justos = bash().guionesEnArchivo('node herr/principal.js', [b2.dir], [], 8192);
  assert.ok(!justos.some((g) => g.archivo.endsWith('justo.js') && g.texto), 'el que pasaría el tope de lectura no se lee');
  assert.ok(justos.some((g) => g.grande && !g.texto), 'y queda como un guion sin leer');
  // de un ejecutable nombrado se mira el comienzo: su línea `#!` no pide leerlo entero
  if (process.platform !== 'win32') {
    const c = repoDelFreno();
    fs.mkdirSync(path.join(c.dir, 'herr'), { recursive: true });
    const ejecutable = path.join(c.dir, 'herr', 'programa');
    fs.writeFileSync(ejecutable, `#!/bin/sh\n# ${'x'.repeat(1024)}\n`, { mode: 0o755 });
    let leidas = 0;
    fs.readFileSync = (f, ...resto) => { if (String(f) === ejecutable) leidas++; return original(f, ...resto); };
    try { assert.strictEqual(frenar(c, './herr/programa'), '', 'un ejecutable que no corre un intérprete de guiones no frena'); } finally { fs.readFileSync = original; }
    assert.strictEqual(leidas, 0, 'el ejecutable no se lee entero para ver su primera línea');
    // con un intérprete de guiones se sigue mirando lo que escribe
    const d = repoDelFreno();
    fs.mkdirSync(path.join(d.dir, 'herr'), { recursive: true });
    fs.writeFileSync(path.join(d.dir, 'herr', 'guion'), `#!/usr/bin/env node\n${ESCRIBE_CONSTANCIA}`, { mode: 0o755 });
    assert.notStrictEqual(frenar(d, './herr/guion'), '', 'un ejecutable de node que escribe una constancia frena');
  }
});
