#!/usr/bin/env node
/**
 * path-shape.test.js — una ruta de Windows llega escrita de tres formas, y los portones tienen que leer las tres.
 *
 * Los portones que deciden por la ruta de un
 * archivo dan el veredicto de siempre con `C:\a\b` y con `C:/a/b`, y con la forma de Git Bash,
 * `/c/a/b`, cuatro dejarían pasar lo que tienen que frenar: el portón de carril, el de frontmatter y el de story a mano en `hook-pre-edit.js`, y
 * el portón de la terminal (`on-bash-write-gate.js`). Para Node en Windows `/c/a/b` es `C:\c\a\b`: una carpeta que no
 * existe, fuera de cualquier repo — y un portón que no encuentra el repo deja pasar.
 *
 * La solución es UNA función (`lib/path-shape.js`) por la que pasa la ruta antes de que la mire cualquier portón: en el
 * despachador de Edit|Write y en el portón de la terminal. Acá se prueba con la plataforma inyectada (no se toca
 * `process.platform`); que los portones frenan de verdad con las tres formas lo mide el banco del arnés en Windows
 * (`46-path-shapes.json`).
 *
 * 🔴 REGLA DE ADMISIÓN: cada caso trae escrita la mutación que lo pone en rojo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { nativePath, nativeEvent } = require(path.join(__dirname, '..', 'lib', 'path-shape.js'));
const gate = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));
const dispatch = require(path.join(__dirname, '..', 'dispatch.js'));

const NATIVE = 'C:\\lab\\fixture\\src\\Foo.cs';

// Mutación: devolver `p` sin tocar en Windows.
test('nativePath: las tres formas de Windows dan la misma ruta', () => {
  assert.strictEqual(nativePath('C:\\lab\\fixture\\src\\Foo.cs', 'win32'), NATIVE);
  assert.strictEqual(nativePath('C:/lab/fixture/src/Foo.cs', 'win32'), NATIVE);
  assert.strictEqual(nativePath('/c/lab/fixture/src/Foo.cs', 'win32'), NATIVE, 'la de Git Bash');
  assert.strictEqual(nativePath('/C/lab/fixture/src/Foo.cs', 'win32'), NATIVE, 'con la letra en mayúscula');
  assert.strictEqual(nativePath('/cygdrive/c/lab/fixture/src/Foo.cs', 'win32'), NATIVE, 'la de Cygwin');
  assert.strictEqual(nativePath('C:\\lab\\fixture/src/Foo.cs', 'win32'), NATIVE, 'mezclada');
  assert.strictEqual(nativePath('/d', 'win32'), 'D:\\', 'la raíz de una unidad');
  // la letra de la unidad, siempre en mayúscula: si no, `c:/a/b` y `/c/a/b` darían dos textos para el mismo archivo
  assert.strictEqual(nativePath('c:/lab/fixture/src/Foo.cs', 'win32'), NATIVE);
  assert.strictEqual(nativePath('c:\\lab\\fixture\\src\\Foo.cs', 'win32'), NATIVE);
  assert.strictEqual(nativePath('c:', 'win32'), 'C:.', 'la letra sola (para Windows, «la carpeta actual de esa unidad»), también');
});

// Mutación: tratar como «/c/…» cualquier ruta que empiece con barra.
test('nativePath: lo que no es una ruta con unidad no se inventa', () => {
  assert.strictEqual(nativePath('src\\Foo.cs', 'win32'), 'src\\Foo.cs', 'una relativa sigue relativa');
  assert.strictEqual(nativePath('src/Foo.cs', 'win32'), 'src\\Foo.cs');
  assert.strictEqual(nativePath('\\\\servidor\\compartida\\x.md', 'win32'), '\\\\servidor\\compartida\\x.md', 'una ruta de red no es una unidad');
  assert.strictEqual(nativePath('//servidor/compartida/x.md', 'win32'), '\\\\servidor\\compartida\\x.md');
  assert.strictEqual(nativePath('/dev/null', 'win32'), '\\dev\\null', '«dev» no es una letra de unidad');
  for (const v of ['', null, undefined, 7]) assert.strictEqual(nativePath(v, 'win32'), v, 'lo que no es un texto con algo vuelve igual');
});

// Mutación: sacar el `if (platform !== 'win32') return p`.
test('nativePath: fuera de Windows no toca nada', () => {
  for (const platform of ['linux', 'darwin']) {
    for (const p of ['/c/lab/fixture/src/Foo.cs', 'C:\\lab\\x', '/a/b', 'src/Foo.cs', '/tmp/x y/z.md']) {
      assert.strictEqual(nativePath(p, platform), p, `${platform}: ${p}`);
    }
  }
  assert.strictEqual(nativePath('/c/lab/x'), process.platform === 'win32' ? 'C:\\lab\\x' : '/c/lab/x', 'sin plataforma, la de la máquina');
});

// Mutación: normalizar sólo `file_path` y dejar `cwd`.
test('nativeEvent: la ruta del archivo y la carpeta de trabajo, sin tocar el resto ni el evento original', () => {
  const event = { session_id: 's', cwd: '/c/lab/fixture', tool_name: 'Write', tool_input: { file_path: '/c/lab/fixture/src/Foo.cs', content: 'ruta en el texto: /c/lab' } };
  const out = nativeEvent(event, 'win32');
  assert.strictEqual(out.cwd, 'C:\\lab\\fixture');
  assert.strictEqual(out.tool_input.file_path, NATIVE);
  assert.strictEqual(out.tool_input.content, 'ruta en el texto: /c/lab', 'el contenido no es una ruta: no se toca');
  assert.strictEqual(nativeEvent({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/c/lab/fixture/n.ipynb' } }, 'win32').tool_input.notebook_path,
    'C:\\lab\\fixture\\n.ipynb', 'la ruta de un cuaderno también es una ruta');
  assert.strictEqual(event.tool_input.file_path, '/c/lab/fixture/src/Foo.cs', 'el evento que llegó no se modifica');
  assert.strictEqual(nativeEvent(event, 'linux'), event, 'fuera de Windows es el mismo objeto');
  for (const v of [null, undefined, {}, { tool_input: null }, { tool_input: { command: 'ls' } }]) assert.deepStrictEqual(nativeEvent(v, 'win32'), v, 'un evento sin rutas vuelve igual');
});

// Mutación: sacar `nativeEvent` de `prepareEvents` en dispatch.js (los portones de Edit|Write vuelven a recibir /c/a/b).
test('el despachador de Edit|Write le entrega a cada portón la ruta ya nativa', () => {
  assert.strictEqual(typeof dispatch.prepareEvents, 'function', 'dispatch.js exporta prepareEvents');
  const events = dispatch.prepareEvents({ cwd: '/c/lab/fixture', tool_name: 'Edit', tool_input: { file_path: '/c/lab/fixture/specs/story-1.md', old_string: 'a', new_string: 'b' } }, 'win32');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].tool_input.file_path, 'C:\\lab\\fixture\\specs\\story-1.md');
  assert.strictEqual(events[0].cwd, 'C:\\lab\\fixture');
  const same = { cwd: '/c/lab', tool_name: 'Edit', tool_input: { file_path: '/c/lab/a.md' } };
  assert.deepStrictEqual(dispatch.prepareEvents(same, 'linux'), [same], 'fuera de Windows, el evento tal cual');
  assert.deepStrictEqual(dispatch.prepareEvents(null, 'win32'), [null], 'sin evento no revienta');
});

// Mutación: resolver el destino con `path.resolve(cwd, t)` sin pasar por nativePath.
test('el portón de la terminal resuelve el destino de una escritura igual con las tres formas', () => {
  assert.strictEqual(typeof gate.resolveTarget, 'function', 'on-bash-write-gate.js exporta resolveTarget');
  const cwd = 'C:\\lab\\fixture';
  for (const t of ['C:\\lab\\fixture\\src\\Foo.cs', 'C:/lab/fixture/src/Foo.cs', '/c/lab/fixture/src/Foo.cs']) {
    assert.strictEqual(gate.resolveTarget(t, cwd, 'win32'), NATIVE, t);
  }
  assert.strictEqual(gate.resolveTarget('src/Foo.cs', cwd, 'win32'), NATIVE, 'una relativa, contra la carpeta de trabajo');
  assert.strictEqual(gate.resolveTarget('src/Foo.cs', '/c/lab/fixture', 'win32'), NATIVE, 'también si la carpeta de trabajo llegó en la forma de Git Bash');
  assert.strictEqual(gate.resolveTarget('src/Foo.cs', 'C:/lab/fixture', 'win32'), NATIVE);
  // fuera de Windows, lo de siempre
  assert.strictEqual(gate.resolveTarget('src/Foo.cs', '/lab/fixture', 'linux'), '/lab/fixture/src/Foo.cs');
  assert.strictEqual(gate.resolveTarget('/c/lab/x.cs', '/lab/fixture', 'darwin'), '/c/lab/x.cs', 'en Mac `/c/lab` es una carpeta, no una unidad');
});

// Mutación: volver a `m.filesTouched.includes(event.filePath)` (comparar las dos rutas como texto).
test('el aviso de colisión entre sesiones reconoce el mismo archivo aunque esté escrito de otra forma', () => {
  const collision = require(path.join(__dirname, '..', 'on-write-collision.js'));
  assert.strictEqual(typeof collision.samePath, 'function', 'on-write-collision.js exporta samePath');
  // en Windows la otra sesión puede anotar `C:\\lab\\fixture/src/Foo.cs` y el evento
  // llegar como `C:\\lab\\fixture\\src\\Foo.cs` — el mismo archivo, dos textos, y el aviso no sale
  assert.strictEqual(collision.samePath('C:\\lab\\fixture/src/Foo.cs', NATIVE, 'win32'), true);
  assert.strictEqual(collision.samePath('C:/lab/fixture/src/Foo.cs', NATIVE, 'win32'), true);
  assert.strictEqual(collision.samePath('/c/lab/fixture/src/Foo.cs', NATIVE, 'win32'), true);
  assert.strictEqual(collision.samePath('c:\\LAB\\fixture\\src\\foo.cs', NATIVE, 'win32'), true, 'en Windows las mayúsculas no distinguen un archivo de otro');
  assert.strictEqual(collision.samePath('C:\\lab\\fixture\\src\\Bar.cs', NATIVE, 'win32'), false, 'otro archivo no es el mismo');
  // fuera de Windows, la comparación de siempre: texto contra texto
  assert.strictEqual(collision.samePath('/lab/fixture/src/Foo.cs', '/lab/fixture/src/Foo.cs', 'linux'), true);
  assert.strictEqual(collision.samePath('/lab/fixture/src/foo.cs', '/lab/fixture/src/Foo.cs', 'linux'), false);
  assert.strictEqual(collision.samePath('/lab/fixture/src/../src/Foo.cs', '/lab/fixture/src/Foo.cs', 'darwin'), false, 'fuera de Windows no se normaliza nada');
});

// Mutación: volver al `require('./lib/path-shape.js')` sin respaldo en on-bash-write-gate.js.
test('sin la lib de rutas el portón de la terminal sigue cargando (y resuelve como antes)', () => {
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  // una copia de los guiones SIN lib/path-shape.js (un skill instalado a medias)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-path-shape-'));
  try {
    fs.cpSync(path.join(__dirname, '..'), path.join(dir, 'scripts'), { recursive: true, filter: (src) => !/[\\/]tests([\\/]|$)/.test(src) && path.basename(src) !== 'path-shape.js' });
    const r = spawnSync(process.execPath, ['-e', `const g = require(${JSON.stringify(path.join(dir, 'scripts', 'on-bash-write-gate.js'))}); process.stdout.write(g.resolveTarget('src/a.cs', ${JSON.stringify(dir)}));`], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `el portón carga sin la lib: ${r.stderr}`);
    assert.strictEqual(r.stdout, path.resolve(dir, 'src/a.cs'));
    // sin el lector compartido de la entrada, un heredoc sigue contando como programa: frena de más, nunca de menos
    const cmd = "python3 - <<'EOF'\nopen('src/a.cs','w').write('x')\nEOF";
    const h = spawnSync(process.execPath, ['-e', `const g = require(${JSON.stringify(path.join(dir, 'scripts', 'on-bash-write-gate.js'))}); process.stdout.write(JSON.stringify(g.extractWriteTargets(${JSON.stringify(cmd)})));`], { encoding: 'utf8' });
    assert.strictEqual(h.status, 0, h.stderr);
    assert.deepStrictEqual(JSON.parse(h.stdout), ['src/a.cs']);
    // el delimitador es cualquier palabra que el shell acepta: con guion o con punto también es un programa, y el
    // destino que arma con una variable se lee igual
    // 🔴 Falla con: un delimitador sólo de letras, números y `_` en el respaldo (`<<'END-DOC'` deja de ser un programa)
    for (const cab of ["<<'END-DOC'", '<<END-DOC', "<<-'END.DOC'"]) {
      const delim = cab.replace(/^<<-?'?|'$/g, '');
      const c = `python3 - ${cab}\np = 'specs/story-x.md'\nopen(p, 'w').write('x')\n${delim}`;
      const r2 = spawnSync(process.execPath, ['-e', `const g = require(${JSON.stringify(path.join(dir, 'scripts', 'on-bash-write-gate.js'))}); process.stdout.write(JSON.stringify(g.destinosArmados(${JSON.stringify(c)})));`], { encoding: 'utf8' });
      assert.strictEqual(r2.status, 0, r2.stderr);
      assert.deepStrictEqual(JSON.parse(r2.stdout).flatMap((a) => a.literales || []), ['specs/story-x.md'], cab);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
