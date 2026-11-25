'use strict';
// hidden-window.test.js — todo proceso que lanza el arnés en la máquina de quien desarrolla pide la ventana oculta.
//
// En Windows, un proceso sin consola (un gancho que la herramienta lanza así, un arranque desprendido) que lanza un
// programa de consola sin `windowsHide` le abre una ventana visible: con cientos de git por minuto, una lluvia de
// ventanas. Esta prueba recorre las carpetas del arnés que corren en esa máquina y frena cualquier lanzamiento sin la
// opción en sus propias opciones. Las que corren en agentes de compilación o en el servidor quedan afuera, con su motivo.
//
// Lo que no se puede perder:
//   · cada carpeta de primer nivel de scripts/ está «dentro» o «fuera»: una nueva sin declarar falla;
//   · un `windowsHide: false` vale sólo en la lista de excepciones, y una excepción que ya no existe también falla;
//   · lo escrito dentro de un texto (el código de otro guion) no es un lanzamiento.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scan = require('./lib/hidden-window-scan.js');

const ROOT = path.resolve(__dirname, '..', '..');

// las carpetas cuyo código corre en la máquina de quien desarrolla: en una sesión, en un gancho o desde su consola
const INSIDE = ['scripts/hooks', 'scripts/instincts', 'scripts/lib', 'scripts/metrics', 'scripts/production', 'scripts/publishing', 'scripts/setup', 'scripts/tools', 'skills'];
// lo que queda afuera, con su motivo
const OUTSIDE = {
  'scripts/ci': 'corre en los agentes de compilación, sin escritorio',
  'scripts/controls-bench': 'corre en el agente de la noche, sin escritorio',
  'scripts/nightly': 'corre en el agente de la noche, sin escritorio',
  'scripts/site': 'corre en el servidor del sitio, sin escritorio',
  'scripts/tests': 'las pruebas lanzan procesos a propósito, desde la consola',
  'scripts/production/guard-libs': 'es la copia que instala el freno de producción con sudo, y se pone al día con él',
};
// los lanzamientos que tienen que mostrar su ventana, como `archivo:función`, con su motivo
const SHOWN = {
  'skills/tycon-pipeline/scripts/lib/runtime-waiver.js:consolaNueva': 'PowerShell se conecta a la consola de la persona para contar cuántos procesos la comparten',
};

function treeLaunches() {
  return scan.scanTree(ROOT, INSIDE, Object.keys(OUTSIDE));
}

test('T1 · HiddenWindow_EveryLaunchInScope_HidesTheWindow @story-8.266 @ac-1 @ac-2', () => {
  const launches = treeLaunches();
  const missing = launches.filter((l) => l.state === 'missing').map((l) => `${l.file}:${l.line}`);
  assert.deepStrictEqual(missing, [], 'lanzamientos sin windowsHide en sus opciones (en Windows, sin consola, abren una ventana): agregá windowsHide: true a cada uno');
  // la red de lo que el escáner no conoce: un archivo que usa child_process en su código y en el que no ve ningún
  // lanzamiento lo usa de una forma que el escáner no reconoce todavía
  const seen = new Set(launches.map((l) => l.file));
  const unseen = scan.scriptFiles(ROOT, INSIDE, Object.keys(OUTSIDE)).filter((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return !seen.has(file) && scan.usesChildProcess(text);
  });
  assert.deepStrictEqual(unseen, [], 'usan child_process de una forma que el escáner no reconoce: enseñásela (scripts/tests/lib/hidden-window-scan.js)');
  // y en cualquier archivo, aunque tenga otros lanzamientos vistos: lo que llega al módulo de un modo que no se sigue
  const noSeguidas = scan.scriptFiles(ROOT, INSIDE, Object.keys(OUTSIDE)).flatMap((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return scan.formasQueNoSigue(text).map((f) => `${file}:${f.line} (${f.forma})`);
  });
  assert.deepStrictEqual(noSeguidas, [], 'llegan a child_process de un modo que el escáner no sigue: escribilo con require(\'child_process\') y la función por su nombre');
});

test('T6 · HiddenWindow_Scanner_SaysWhatItCannotFollow', () => {
  // las formas que el escáner no sigue no pasan calladas: cada una se nombra, aunque el archivo tenga otros lanzamientos
  const casos = [
    ["const cp = require('child_process'); cp[fn]('ls', [], { windowsHide: true });", /corchetes/],
    ["const c = process.getBuiltinModule('child_process'); c.spawnSync('ls');", /como texto/],
    ["const r = createRequire(import.meta.url)('node:child_process');", /como texto/],
    ["const m = 'child_' + 'process'; const c = require(m);", /nombre armado/],
    // pase adversarial: lo que el escáner tampoco sigue
    ['const c = require(`child_process`); c.spawnSync(\'ls\');', /como texto/],
    ["const c = require ('child_process'); c.spawnSync('ls');", /como texto/],
    ["export { spawn } from 'child_process';", /como texto/],
    ["import * as cp from 'node:child_process'; cp[fn]('ls', [], { windowsHide: true });", /corchetes/],
    ["import cp from 'child_process'; cp[fn]('ls');", /corchetes/],
  ];
  for (const [texto, forma] of casos) {
    const f = scan.formasQueNoSigue(`const { spawnSync } = require('child_process');\nspawnSync('ls', [], { windowsHide: true });\n${texto}\n`);
    assert.equal(f.length, 1, `${texto}: ${JSON.stringify(f)}`);
    assert.match(f[0].forma, forma);
    assert.equal(f[0].line, 3);
  }
  // lo de siempre no se nombra: la carga reconocida, un comentario, un texto que es el código de otro guion
  for (const texto of [
    "const { spawnSync } = require('node:child_process');",
    "import { spawn } from 'child_process';",
    "// process.getBuiltinModule('child_process')",
    "const guion = `const c = require('child_process'); c[fn]();`;",
    "const p = require(path.join(__dirname, 'x.js'));",
    "import * as cp from 'child_process'; cp.spawnSync('ls', [], { windowsHide: true });",
    // el nombre partido sólo en un comentario o adentro de otro texto no hace sospechoso a un require de una variable
    "// antes se armaba 'child_' + 'process'\nconst p = require(ruta);",
    "const aviso = \"no uses 'child_' + 'process'\"; const p = require(ruta);",
  ]) assert.deepStrictEqual(scan.formasQueNoSigue(texto), [], texto);
});

test('T2 · HiddenWindow_Scanner_FindsEveryForm @story-8.266 @ac-2', () => {
  const text = [
    "const { spawnSync, execFile: ef } = require('child_process');",
    "const cp = require('node:child_process');",
    "const sp = opts.spawnSync || require('child_process').spawnSync;",
    "spawnSync('git', ['a'], { windowsHide: true });",
    "ef('git', ['b'], { windowsHide: true }, () => {});",
    "cp.spawn('git', ['c'], {",
    '  windowsHide: true,',
    '});',
    "require('child_process').execFileSync('git', ['d'], { windowsHide: true });",
    "sp('git', ['e'], { windowsHide: true });",
    "cp.fork('x.js', [], { windowsHide: true });",
    "// spawnSync('git', ['comentario'])",
    "const m = /x/.exec('y');",
    "const shim = \"require('child_process').spawnSync(process.argv[1], [])\";",
    "const tpl = `a ${b.map((x) => `require('child_process').spawnSync(${x})`)} c`;",
    "const re = /['\"`]/g; spawnSync('git', ['f'], { windowsHide: true });",
  ].join('\n');
  const found = scan.findLaunches(text).map((l) => `${l.fn}:${l.line}`);
  assert.deepStrictEqual(found, ['spawnSync:4', 'ef:5', 'spawn:6', 'execFileSync:9', 'sp:10', 'fork:11', 'spawnSync:16']);
  // the import or the binding is not the first thing in its declaration, or is not a declaration at all
  const forms = [
    ["const fs = require('fs'), { spawnSync } = require('child_process');", "spawnSync('git', ['a']);"],
    ["const fs = require('fs'), cp = require('child_process');", "cp.spawnSync('git', ['a']);"],
    ["const cp = require('child_process') // the module", "cp.spawnSync('git', ['a']);"],
    ["const cp = require('child_process'); const { spawnSync } = cp;", "spawnSync('git', ['a']);"],
    ["function read({ spawnSync = require('child_process').spawnSync } = {}) {", "  return spawnSync('git', ['a']);", '}'],
    ["import { spawnSync as run } from 'node:child_process';", "run('git', ['a']);"],
    ["import * as cp from 'child_process';", "cp.execFile('git', ['a'], () => {});"],
    ["const { spawnSync } = await import('node:child_process');", "spawnSync('git', ['a']);"],
    ["const { spawnSync } = require('child_process'); function f({ run = spawnSync } = {}) {", "  return run('git', ['a']);", '}'],
    ["const { exec } = require('child_process'); const run = require('util').promisify(exec);", "run('git a');"],
    ["const cp = require('child_process'); const run = promisify(cp.execFile);", "run('git', ['a']);"],
    ["const cp = require('child_process');", "cp?.spawnSync('git', ['a']);"],
    ["const { spawnSync } = require('child_process');", "spawnSync.call(null, 'git', ['a']);"],
  ];
  for (const lines of forms) {
    assert.deepStrictEqual(scan.findLaunches(lines.join('\n')).map((l) => `${l.line}:${l.state}`), ['2:missing'], lines.join(' / '));
  }
  // a comment or a regular expression inside the arguments does not hide the launch nor merge it with the next one
  const inside = [
    "const { spawnSync } = require('child_process');",
    "spawnSync('git', ['status'], {",
    "  // don't pipe",
    "  encoding: 'utf8',",
    '});',
    "spawnSync('git', a.filter((x) => /\\(/.test(x)));",
    "spawnSync('git', a.filter((x) => /[')]/.test(x)), { windowsHide: true });",
  ].join('\n');
  assert.deepStrictEqual(scan.findLaunches(inside).map((l) => `${l.line}:${l.state}`), ['2:missing', '6:missing', '7:hidden']);
  // the net of T1: the code loads the module, in any form; a text or a comment that names it does not
  assert.ok(scan.usesChildProcess("const x = require('node:child_process');"));
  assert.ok(scan.usesChildProcess("import { spawn } from 'child_process';"));
  assert.ok(!scan.usesChildProcess("// require('child_process')\nconst s = \"require('child_process')\";"));
  // a method with the same name as a launch function is not a launch
  assert.deepStrictEqual(scan.findLaunches("const { exec } = require('child_process');\nclass Db { exec(sql) { return sql; } }\nconst o = { exec(sql) { return sql; } };"), []);
});

test('T3 · HiddenWindow_Scanner_OptionsMustBeTheCallsOwn @story-8.266 @ac-1 @ac-2', () => {
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'], { env: Object.assign({}, env, { windowsHide: true }) })"), 'missing');
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'], opts)"), 'missing');
  assert.strictEqual(scan.windowState("execFile('git', ['x'], { windowsHide: true }, (e) => {})"), 'hidden');
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'], { windowsHide: true, ...o })"), 'hidden');
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'], { stdio: 'inherit', windowsHide: false })"), 'shown');
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'])"), 'missing');
  // options chosen with a conditional: hidden only if both branches ask for it
  assert.strictEqual(scan.windowState("spawnSync('x', [], gate ? { env, windowsHide: true } : { stdio: 'inherit', windowsHide: true })"), 'hidden');
  assert.strictEqual(scan.windowState("spawnSync('x', [], gate ? { env, windowsHide: true } : { stdio: 'inherit' })"), 'missing');
  assert.strictEqual(scan.windowState("spawnSync('x', [], a?.b ? { windowsHide: true } : { windowsHide: true })"), 'hidden');
  // an option written inside a comment is not an option
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'], {\n  // windowsHide: true,\n  encoding: 'utf8',\n})"), 'missing');
  assert.strictEqual(scan.windowState("spawnSync('git', ['x'], { encoding: 'utf8' /* windowsHide: true */ })"), 'missing');
});

test('T4 · HiddenWindow_ExplicitFalse_OnlyFromTheList @story-8.266 @ac-3', () => {
  const check = (launches, allowed) => {
    const shown = launches.filter((l) => l.state === 'shown').map((l) => `${l.file}:${l.inFunction}`);
    return {
      notAllowed: shown.filter((k) => !(k in allowed)),
      stale: Object.keys(allowed).filter((k) => !shown.includes(k)),
    };
  };
  const toy = (file, fn) => scan.findLaunches(`const { spawnSync } = require('child_process');\nfunction ${fn}() { spawnSync('x', [], { windowsHide: false }); }`).map((l) => ({ file, ...l }));
  const launches = [...toy('a.js', 'listed'), ...toy('b.js', 'notListed')];
  assert.deepStrictEqual(check(launches, { 'a.js:listed': 'x', 'c.js:gone': 'y' }), { notAllowed: ['b.js:notListed'], stale: ['c.js:gone'] });
  // el árbol real: sólo las de la lista, y ninguna de la lista sobra
  assert.deepStrictEqual(check(treeLaunches(), SHOWN), { notAllowed: [], stale: [] });
});

test('T7 · HiddenWindow_LegacyShims_AreScannedAndHideTheWindow @story-8.266 @ac-1 @ac-2', () => {
  // los atajos de nombres viejos los escribe la plantilla de legacy-names.js --write-shims; viven en el repo privado de
  // quien mantiene y lanzan su destino con node: la plantilla pide la ventana oculta, y el escáner los lee como a
  // cualquier guion (un atajo a mano con la marca y sin la opción también se ve)
  const L = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-window-shims-'));
  try {
    const harness = path.join(lab, 'harness');
    const skills = path.join(lab, 'agent-skills');
    for (const f of [path.join(harness, 'scripts', 'tools', 'new-tool.js'), path.join(skills, 'skills', 'lab', 'new-tool.js')]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '#!/usr/bin/env node\nconsole.log(1);\n');
    }
    const entries = [
      { kind: 'file', old: 'scripts/old-place/old-tool.js', new: 'scripts/tools/new-tool.js', batch: 'lab', callers: ['machine'] },
      { kind: 'file', old: 'skills/lab/old-tool.js', new: 'skills/lab/new-tool.js', batch: 'lab', callers: ['other-repo'], repo: 'agent-skills' },
    ];
    const { written } = L.writeShims({ map: { entries }, root: harness, skillsRoot: skills });
    assert.deepStrictEqual(written.sort(), ['scripts/old-place/old-tool.js', 'skills/lab/old-tool.js']);
    const shims = [path.join(harness, 'scripts', 'old-place', 'old-tool.js'), path.join(skills, 'skills', 'lab', 'old-tool.js')];
    for (const f of shims) {
      const launches = scan.findLaunches(fs.readFileSync(f, 'utf8'));
      assert.ok(launches.length > 0, `${f}: el escáner ve el lanzamiento del atajo`);
      assert.deepStrictEqual(launches.map((l) => l.state), launches.map(() => 'hidden'), `${f}: el atajo lanza su destino con windowsHide: true`);
      assert.deepStrictEqual(scan.formasQueNoSigue(fs.readFileSync(f, 'utf8')), [], `${f}: el atajo llega al módulo de un modo que el escáner sigue`);
    }
    // el recorrido del árbol no saltea los atajos: los generados salen ocultos, y uno con la marca sin la opción, sin ella
    const old = fs.readFileSync(shims[0], 'utf8').replace(/, windowsHide: true \}/, ' }');
    assert.notStrictEqual(old, fs.readFileSync(shims[0], 'utf8'), 'el laboratorio arma el atajo sin la opción');
    fs.writeFileSync(path.join(harness, 'scripts', 'old-place', 'hand-shim.js'), old);
    const seen = scan.scanTree(harness, ['scripts']).map((l) => `${l.file}:${l.state}`);
    assert.deepStrictEqual(seen.filter((s) => s.startsWith('scripts/old-place/')).sort(),
      ['scripts/old-place/hand-shim.js:missing', 'scripts/old-place/old-tool.js:hidden']);
  } finally {
    fs.rmSync(lab, { recursive: true, force: true });
  }
});

test('T5 · HiddenWindow_Scope_NewFolderMustBeDeclared @story-8.266 @ac-2', () => {
  const undeclared = (folders, inside, outside) => folders.filter((f) => !inside.includes(f) && !(f in outside));
  // una carpeta con sólo atajos de nombres viejos (el nombre viejo de una carpeta movida, en el repo privado) no es código
  // propio: no hace falta declararla
  const onlyShims = (folder) => {
    const files = scan.scriptFiles(ROOT, [folder]);
    return files.length > 0 && files.every((f) => scan.isLegacyShim(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  };
  const folders = fs.readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `scripts/${d.name}`).filter((f) => !onlyShims(f));
  assert.deepStrictEqual(undeclared(folders, INSIDE, OUTSIDE), [], 'una carpeta nueva de scripts/ tiene que ir en INSIDE o en OUTSIDE, con su motivo');
  assert.deepStrictEqual(undeclared(['scripts/hooks', 'scripts/new-folder'], INSIDE, OUTSIDE), ['scripts/new-folder']);
  assert.ok(scan.isLegacyShim("#!/usr/bin/env node\n// tycon-legacy-shim: scripts/hooks/x.js\n'use strict';\n"));
  assert.ok(!scan.isLegacyShim("'use strict';\n// habla de tycon-legacy-shim: en el medio de un comentario cualquiera\n"));
  // cada motivo dice algo
  for (const [k, why] of Object.entries(OUTSIDE)) assert.ok(why.length > 10, `${k} sin motivo`);
});
