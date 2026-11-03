'use strict';
// Un texto con forma de comodín que no se puede convertir no abre el freno de escrituras por consola: un corchete sin
// cerrar o un rango al revés son texto, como para el shell, y lo que el comando escribe se sigue mirando. Tampoco lo abre
// una carpeta que no se puede leer, ni lo cuelga una tira de estrellas. El registro dice «FAILED OPEN» sólo cuando el
// freno de verdad dejó pasar el comando sin mirarlo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GATE = path.join(__dirname, '..', 'on-bash-write-gate.js');

/** Un repo de juguete con una historia y una HOME propia: el registro de errores no es el de la máquina. */
function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'freno-corchete-')));
  const home = path.join(raiz, 'home');
  const dir = path.join(raiz, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.tycon'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'specs', 'story-1.1.md'), '---\nstory: "1.1"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  return { home, dir };
}

/** El freno de verdad, en su proceso: la salida, lo que dijo y lo que quedó en su registro de errores. */
function correr({ home, dir }, command) {
  const log = path.join(home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  fs.rmSync(log, { force: true });
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', session_id: 's-corchete', cwd: dir, tool_input: { command } }),
    env: { ...base, HOME: home, USERPROFILE: home, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8', timeout: 15000,
  });
  return { salida: r.status, stderr: String(r.stderr), log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

const HISTORIA = /HISTORIA ESCRITA POR CONSOLA/;
const CONSTANCIA = /una constancia de cambio de control no se escribe a mano/;

// T1 Bracket_InlineScriptThatWritesStory_Blocks
// 🔴 Falla con: `new RegExp` sin cuidar el corchete en `expandirComodin`: el `SyntaxError` sale por la captura de arriba
//    de todo y el comando pasa sin que nadie mire qué escribe.
test('T1 Bracket_InlineScriptThatWritesStory_Blocks', () => {
  const c = corral();
  const r = correr(c, `python3 -c "open('specs/story-1.1.md','w').write('x'); print('d[')"`);
  assert.strictEqual(r.salida, 2, 'el corchete no esconde la escritura de la historia');
  assert.match(r.stderr, HISTORIA);
  assert.doesNotMatch(r.log, /SyntaxError/);
});

// T2 Bracket_InlineScriptThatWritesRecord_Blocks
// 🔴 Falla con: lo mismo, por una constancia de cambio de control.
test('T2 Bracket_InlineScriptThatWritesRecord_Blocks', () => {
  const c = corral();
  const r = correr(c, `node -e "require('fs').writeFileSync('.tycon/control-changes/c.json','x'); console.log('control-changes|(.:^|[')"`);
  assert.strictEqual(r.salida, 2, 'el corchete no esconde la escritura de la constancia');
  assert.match(r.stderr, CONSTANCIA);
  assert.doesNotMatch(r.log, /SyntaxError/);
});

// T3 Bracket_GrepPipedToInPlaceEditor_Blocks
// 🔴 Falla con: lo mismo, por la palabra que el comando le pasa a un editor en el lugar.
test('T3 Bracket_GrepPipedToInPlaceEditor_Blocks', () => {
  const c = corral();
  const r = correr(c, `grep -l 'd[' specs/*.md | xargs sed -i '' 's/a/b/'`);
  assert.strictEqual(r.salida, 2);
  assert.match(r.stderr, HISTORIA);
});

// T4 Bracket_ReversedRange_Blocks
// 🔴 Falla con: cuidar sólo el corchete sin cerrar: `[z-a]` también hace lanzar a `new RegExp`, y `[^x` y `[!x` son la
//    negación sin cerrar.
test('T4 Bracket_ReversedRange_Blocks', () => {
  const c = corral();
  for (const texto of ['[z-a]', '[^x', '[!x']) {
    const r = correr(c, `python3 -c "open('specs/story-1.1.md','w').write('x'); print('${texto}')"`);
    assert.strictEqual(r.salida, 2, texto);
    assert.match(r.stderr, HISTORIA, texto);
    assert.doesNotMatch(r.log, /SyntaxError/, texto);
  }
});

// T5 Bracket_IsLiteral_MatchesFileWithThatName
// 🔴 Falla con: descartar la palabra en lugar de leerla como texto: una historia que se llama así, con una estrella al
//    lado, quedaría sin mirar.
test('T5 Bracket_IsLiteral_MatchesFileWithThatName', () => {
  const c = corral();
  fs.writeFileSync(path.join(c.dir, 'specs', 'h[1.md'), '---\nstory: "1.2"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n');
  fs.rmSync(path.join(c.dir, 'specs', 'story-1.1.md'));
  const r = correr(c, `sed -i '' 's/a/b/' 'specs/h[*.md'`);
  assert.strictEqual(r.salida, 2, 'el corchete es texto; la estrella sigue siendo comodín');
  assert.match(r.stderr, HISTORIA);
});

// T6 Bracket_CommandThatDoesNotWrite_Passes
// 🔴 Falla con: resolver el corchete frenando: un `python3 -c` cualquiera con un corchete no tiene por qué frenar.
test('T6 Bracket_CommandThatDoesNotWrite_Passes', () => {
  const c = corral();
  for (const cmd of [`python3 -c "print('d[')"`, `python3 -c "open('salida.txt','w').write('x'); print('d[')"`]) {
    const r = correr(c, cmd);
    assert.strictEqual(r.salida, 0, `${cmd}: ${r.stderr}`);
    assert.strictEqual(r.log, '', 'sin nada para el registro');
  }
});

// T7 Glob_ClosedClass_StillExpands
// 🔴 Falla con: tratar como texto todo corchete, también uno bien cerrado; leer `[^x]` como «^ o x», cuando para el shell
//    es la negación, igual que `[!x]`; o no leer el `]` que va primero como un carácter más de la clase.
test('T7 Glob_ClosedClass_StillExpands', () => {
  const c = corral();
  for (const g of ['[0-9]', '[!x]', '[^x]', '[]1]', '[!]x]']) {
    const r = correr(c, `sed -i '' 's/a/b/' specs/story-${g}.1.md`);
    assert.strictEqual(r.salida, 2, `specs/story-${g}.1.md nombra la historia`);
    assert.match(r.stderr, HISTORIA, g);
  }
});

// T8 Glob_RunOfStars_DoesNotHang
// 🔴 Falla con: una `.*` por estrella: con treinta seguidas y una letra al final, la expresión no termina nunca, el freno
//    se cuelga y el cliente termina dejando pasar el comando.
test('T8 Glob_RunOfStars_DoesNotHang', () => {
  const c = corral();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(c.dir, `un-archivo-con-un-nombre-bastante-largo-numero-${i}.txt`), 'x');
  const estrellas = '*'.repeat(32);
  const sinHistoria = correr(c, `python3 -c "open('salida.txt','w').write('x'); print('${estrellas}z')"`);
  assert.strictEqual(sinHistoria.salida, 0, 'terminó y dejó pasar lo que no toca una historia');
  const conHistoria = correr(c, `python3 -c "open('specs/story-1.1.md','w').write('x'); print('${estrellas}z')"`);
  assert.strictEqual(conHistoria.salida, 2, 'terminó y frenó la escritura de la historia');
  assert.match(conHistoria.stderr, HISTORIA);
});

// T9 UnreadableFolder_DoesNotOpen_AndIsNotLabeledOpen
// 🔴 Falla con: que la carpeta sin permiso abra el freno, o que el registro diga «FAILED OPEN» de algo que frenó.
test('T9 UnreadableFolder_DoesNotOpen_AndIsNotLabeledOpen', (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return t.skip('acá chmod no quita el permiso');
  const c = corral();
  const cerrada = path.join(c.dir, 'cerrada');
  fs.mkdirSync(cerrada);
  fs.chmodSync(cerrada, 0o000);
  try {
    const r = correr(c, 'echo x > cerrada/$(date +%s).md');
    assert.strictEqual(r.salida, 2, 'una carpeta que no se puede leer puede tener historias');
    assert.match(r.log, /EACCES/, 'la falla queda dicha');
    assert.doesNotMatch(r.log, /FAILED OPEN/, 'no dejó pasar nada: no se anota como que se abrió');
  } finally { fs.chmodSync(cerrada, 0o755); }
});

// T10 UnexpectedError_IsTheOnlyOneLabeledOpen
// 🔴 Falla con: quitarle el rótulo también a la falla que sí deja pasar el comando: ésa es la que hay que ver.
test('T10 UnexpectedError_IsTheOnlyOneLabeledOpen', () => {
  const c = corral();
  const roto = path.join(c.home, 'roto.js');
  fs.writeFileSync(roto, `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'atdd-preedit.js'))}).isInside = () => { throw new TypeError('roto a propósito'); };\n`);
  const log = path.join(c.home, '.claude', '.tycon-pipeline', 'hook-errors.log');
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_')) base[k] = v;
  const r = spawnSync(process.execPath, ['-r', roto, GATE], {
    input: JSON.stringify({ tool_name: 'Bash', session_id: 's-corchete', cwd: c.dir, tool_input: { command: 'rm salida.txt' } }),
    env: { ...base, HOME: c.home, USERPROFILE: c.home, TYCON_NO_RUN_CHANGE: '1' }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, 'una falla sin prever deja pasar el comando');
  assert.match(fs.readFileSync(log, 'utf8'), /FAILED OPEN: TypeError: roto a propósito/);
});

// T11 Glob_StarsBetweenLetters_DoesNotHang
// 🔴 Falla con: comparar con una expresión: unas estrellas separadas por letras, contra un nombre largo de esa letra, no
//    terminan nunca aunque las seguidas valgan por una.
test('T11 Glob_StarsBetweenLetters_DoesNotHang', () => {
  const c = corral();
  fs.writeFileSync(path.join(c.dir, 'a'.repeat(200)), 'x');
  const texto = `${'*a'.repeat(30)}*b`;
  const sinHistoria = correr(c, `python3 -c "open('salida.txt','w').write('x'); print('${texto}')"`);
  assert.strictEqual(sinHistoria.salida, 0, 'terminó y dejó pasar lo que no toca una historia');
  const conHistoria = correr(c, `python3 -c "open('specs/story-1.1.md','w').write('x'); print('${texto}')"`);
  assert.strictEqual(conHistoria.salida, 2, 'terminó y frenó la escritura de la historia');
});

// T12 Glob_InsideClass_IsLiteral
// 🔴 Falla con: leer `*` como comodín adentro de un corchete, donde es un carácter.
test('T12 Glob_InsideClass_IsLiteral', () => {
  const c = corral();
  fs.rmSync(path.join(c.dir, 'specs', 'story-1.1.md'));
  const historia = '---\nstory: "1.2"\nepic: "1"\ntitle: "x"\nstatus: in-progress\n---\n\n# x\n';
  fs.writeFileSync(path.join(c.dir, 'specs', 'h*.md'), historia);
  const r = correr(c, `sed -i '' 's/a/b/' 'specs/h[*].md'`);
  assert.strictEqual(r.salida, 2, 'h[*].md nombra la historia h*.md');
  assert.match(r.stderr, HISTORIA);
  fs.rmSync(path.join(c.dir, 'specs', 'h*.md'));
  fs.writeFileSync(path.join(c.dir, 'specs', 'hx.md'), historia);
  assert.strictEqual(correr(c, `sed -i '' 's/a/b/' 'specs/h[*].md'`).salida, 0, 'h[*].md no nombra hx.md');
});

// T13 Glob_LongRunOfOpenBrackets_DoesNotHang
// 🔴 Falla con: buscar el cierre hasta el final en cada corchete, también cuando al final hay un cierre con un rango al revés,
//    o armar el comodín de nuevo por cada carpeta: el tiempo crece con el cuadrado del largo del texto, y el freno que no
//    termina deja pasar el comando.
test('T13 Glob_LongRunOfOpenBrackets_DoesNotHang', () => {
  const c = corral();
  const largo = 300 * 1024;
  for (const texto of ['['.repeat(largo), `${'['.repeat(largo)}z-a]`, '[[[z-a]'.repeat(Math.floor(largo / 7)), `${'['.repeat(63)}z-a]`.repeat(Math.floor(largo / 67))]) {
    const nombre = `${texto.slice(0, 4)}…${texto.slice(-4)}`;
    const sinHistoria = correr(c, `python3 -c "open('salida.txt','w').write('x'); print('${texto}')"`);
    assert.strictEqual(sinHistoria.salida, 0, `${nombre}: terminó y dejó pasar lo que no toca una historia`);
    const conHistoria = correr(c, `python3 -c "open('specs/story-1.1.md','w').write('x'); print('${texto}')"`);
    assert.strictEqual(conHistoria.salida, 2, `${nombre}: terminó y frenó la escritura de la historia`);
  }
});

// T14 Glob_LongClosedClass_StillBlocks
// 🔴 Falla con: tratar como texto el corchete cerrado que pasa del tope: para el shell es una clase, y el comando que la usa
//    escribe o borra sin frenar. Ante la duda, coincide con cualquier carácter.
test('T14 Glob_LongClosedClass_StillBlocks', () => {
  const c = corral();
  const estado = path.join(c.home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active.json'), '{}');
  const formas = {
    'sed -i': (g) => `sed -i '' 's/a/b/' specs/story-${g}.1.md`,
    'redirección': (g) => `echo x > specs/story-${g}.1.md`,
    'grep con xargs sed': (g) => `grep -l a specs/story-${g}.1.md | xargs sed -i '' 's/a/b/'`,
    'rm': (g) => `rm specs/story-${g}.1.md`,
    'cp encima': (g) => `cp /tmp/x specs/story-${g}.1.md`,
    'borrar un marcador': (g) => `rm ${estado}/active.jso${g.replace('1', 'n')}`,
  };
  for (const relleno of [62, 63, 64, 70, 500]) {
    const clase = `[1${'x'.repeat(relleno)}]`;
    for (const [nombre, forma] of Object.entries(formas)) {
      assert.strictEqual(correr(c, forma(clase)).salida, 2, `${nombre}, con una clase de ${relleno + 1} caracteres`);
    }
    assert.strictEqual(correr(c, `sed -i '' 's/a/b/' specs/story-[!${'x'.repeat(relleno)}].1.md`).salida, 2, `la negación de ${relleno} caracteres`);
  }
});

// T15 Glob_EscapedBracketInClass_Blocks
// 🔴 Falla con: leer `\]` como el cierre del corchete: la clase termina antes, sobra un `]` y el comodín no nombra la
//    historia que el shell sí expande.
test('T15 Glob_EscapedBracketInClass_Blocks', (t) => {
  if (process.platform === 'win32') return t.skip('en Windows la barra invertida separa carpetas');
  const c = corral();
  for (const g of ['[1\\]]', '[\\]1]', '[!\\]x]', '[1\\\\]']) {
    for (const cmd of [`sed -i '' 's/a/b/' specs/story-${g}.1.md`, `echo x > specs/story-${g}.1.md`, `rm specs/story-${g}.1.md`]) {
      const r = correr(c, cmd);
      assert.strictEqual(r.salida, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, HISTORIA, cmd);
    }
  }
  // afuera de un corchete, la barra escapa el carácter que sigue
  const conBarra = correr(c, `sed -i '' 's/a/b/' specs/st\\ory-*.md`);
  assert.strictEqual(conBarra.salida, 2, conBarra.stderr);
  assert.match(conBarra.stderr, HISTORIA);
  // también el punto de una carpeta oculta: pide los ocultos igual que sin la barra
  fs.mkdirSync(path.join(c.dir, '.oculta'));
  fs.copyFileSync(path.join(c.dir, 'specs', 'story-1.1.md'), path.join(c.dir, '.oculta', 'story-1.2.md'));
  const oculta = correr(c, `sed -i '' 's/a/b/' \\.oculta/st*.md`);
  assert.strictEqual(oculta.salida, 2, oculta.stderr);
  assert.match(oculta.stderr, HISTORIA);
  const tramo = correr(c, `sed -i '' 's/a/b/' .oculta/\\.*`);
  assert.strictEqual(tramo.salida, 0, 'ahí no hay ocultos que nombren una historia');
  fs.copyFileSync(path.join(c.dir, 'specs', 'story-1.1.md'), path.join(c.dir, '.oculta', '.story-1.3.md'));
  const archivo = correr(c, `sed -i '' 's/a/b/' .oculta/\\.st*`);
  assert.strictEqual(archivo.salida, 2, archivo.stderr);
  fs.rmSync(path.join(c.dir, '.oculta'), { recursive: true });
  // la clase sigue siendo una clase: la que no tiene el carácter no nombra la historia
  const r = correr(c, `sed -i '' 's/a/b/' specs/story-[2\\]].1.md`);
  assert.doesNotMatch(r.stderr, HISTORIA, 'esa clase no nombra story-1.1.md');
});

// T16 Glob_PosixClass_Blocks
// 🔴 Falla con: leer `[[:digit:]]` como los caracteres de la palabra `digit`: la clase no coincide con el `1` y el comodín
//    no nombra la historia; o inventar una regla para una clase que no se conoce, en lugar de frenar.
test('T16 Glob_PosixClass_Blocks', () => {
  const c = corral();
  for (const g of ['[[:digit:]]', '[[:alnum:]]', '[[:digit:]x]', '[x[:digit:]]', '[![:alpha:]]', '[[:xdigit:]]', '[[:raro:]]', '[[:digit:]-_]', '[_-[:digit:]]']) {
    for (const cmd of [`sed -i '' 's/a/b/' specs/story-${g}.1.md`, `echo x > specs/story-${g}.1.md`]) {
      const r = correr(c, cmd);
      assert.strictEqual(r.salida, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, HISTORIA, cmd);
    }
  }
  // un guion pegado a una clase, con un carácter que la clase no tiene: del lado que frena
  for (const cmd of [`sed -i '' 's/a/b/' specs/s[[:digit:]-_]ory-1.1.md`, `sed -i '' 's/a/b/' specs/s[[:xdigit:]-z]ory-1.1.md`, `sed -i '' 's/a/b/' specs/s[_-[:digit:]]ory-1.1.md`]) {
    const r = correr(c, cmd);
    assert.strictEqual(r.salida, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, HISTORIA, cmd);
  }
  // las clases de equivalencia y los símbolos, y un nombre que es una propiedad de todo objeto: del lado que frena
  for (const g of ['[[=s=]]', '[[.s.]]', '[[:constructor:]]']) {
    const r = correr(c, `sed -i '' 's/a/b/' specs/${g}tory-1.1.md`);
    assert.strictEqual(r.salida, 2, `${g}: ${r.stderr}`);
    assert.match(r.stderr, HISTORIA, g);
  }
  // lo que parece una clase cierra el único `]`: el corchete cierra ahí, y no es texto
  for (const g of ['[[:bogus:]', '[[=s=]', '[[.s.]', '[x[:bogus:]']) {
    const r = correr(c, `sed -i '' 's/a/b/' specs/${g}tory-1.1.md`);
    assert.strictEqual(r.salida, 2, `${g}: ${r.stderr}`);
    assert.match(r.stderr, HISTORIA, g);
  }
  // el guion al final es un carácter más
  assert.doesNotMatch(correr(c, `sed -i '' 's/a/b/' specs/s[[:digit:]-]ory-1.1.md`).stderr, HISTORIA, 'esa clase no tiene la t');
  // la clase mira de verdad: el `1` no es una letra
  for (const g of ['[[:alpha:]]', '[![:digit:]]']) {
    const r = correr(c, `sed -i '' 's/a/b/' specs/story-${g}.1.md`);
    assert.doesNotMatch(r.stderr, HISTORIA, `${g} no nombra story-1.1.md`);
  }
});
