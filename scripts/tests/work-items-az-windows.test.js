'use strict';
// work-items-az-windows.test.js — el conector de pedidos de trabajo de Azure DevOps en Windows. Ahí `az` es az.cmd, que
// node sólo corre por la consola: cada argumento va entre comillas, y lo que la consola interpretaría adentro de ellas
// (un título con comillas, «&» o «%», la consulta con comillas del estado) va por archivo, que az lee cuando el
// argumento empieza con «@». La primera parte es pura y corre en cualquier máquina; la segunda llama a un az.cmd de
// mentira por la consola de verdad, y sólo corre en Windows (la mide el escenario portable de la prueba de Windows).
//
// Correr:   node --test scripts/tests/work-items-az-windows.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WI = path.join(ROOT, 'integrations', 'azure-devops', 'scripts', 'work-items.js');
const P = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const HOSTIL = 'Volvió "a aparecer" & sigue: 100% (RR-CIERRE:abortada) <ok>';
const ORG = 'https://dev.azure.com/acme';

// T1 AzWindows_UnsafeValuesByFile_RestQuoted
// 🔴 Falla con: correr az sin la consola en Windows, pasar un valor con comillas o «&» por la línea (la consola lo corta o
//    lo ejecuta), rechazar un correo o la ruta de un archivo de campo, o dejar los archivos en el disco.
test('T1 AzWindows_UnsafeValuesByFile_RestQuoted — lo que la consola interpretaría va por archivo, el resto entre comillas', () => {
  const { azConsoleCall } = require(WI);
  assert.strictEqual(typeof azConsoleCall, 'function', 'work-items.js arma la llamada a az de Windows');
  const campo = 'System.Description=@C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\az-campo-x\\campo-0.txt';
  const args = ['boards', 'work-item', 'update', '--organization', ORG, '--id', '7', '--discussion', HOSTIL,
    '--query', 'fields."System.State"', '--assigned-to', 'ana@acme.example', '--fields', campo, '--output', 'json'];
  const win = azConsoleCall('az', args, 'win32');
  try {
    assert.strictEqual(win.problem, undefined, JSON.stringify(win));
    assert.strictEqual(win.shell, true);
    assert.strictEqual(win.args.length, args.length);
    const porArchivo = {};
    win.args.forEach((a, i) => {
      assert.match(a, /^".*"$/, `${a}: entre comillas`);
      const sin = a.slice(1, -1);
      if (sin.startsWith('@') && sin !== args[i]) porArchivo[args[i]] = fs.readFileSync(sin.slice(1), 'utf8');
      else assert.strictEqual(sin, args[i], `${args[i]}: tal cual`);
    });
    assert.deepStrictEqual(porArchivo, { [HOSTIL]: HOSTIL, 'fields."System.State"': 'fields."System.State"' },
      'el título hostil y la consulta van por archivo, con el texto tal cual; el correo y el campo por archivo no');
  } finally { win.cleanup(); }
  for (const a of win.args) if (a.startsWith('"@') && !a.includes('=')) assert.ok(!fs.existsSync(a.slice(2, -1)), `${a}: se borró`);
  // fuera de Windows, o con un doble con ruta, la llamada no cambia
  for (const [cmd, plataforma] of [['az', 'darwin'], ['az', 'linux'], ['/x/fake-az', 'win32']]) {
    const c = azConsoleCall(cmd, args, plataforma);
    assert.deepStrictEqual([c.args, c.shell], [args, false], `${cmd} en ${plataforma}`);
    c.cleanup();
  }
  assert.strictEqual(Object.keys(require(WI)).includes('azConsoleCall'), false, 'no es una operación del conector');
});

// T2 AzWindows_TrailingBackslash_SaidNotSilent
// 🔴 Falla con: pasar un valor que termina en «\» entre comillas (escaparía la comilla de cierre y correría el resto de la
//    línea), o callarlo en vez de decirlo.
test('T2 AzWindows_TrailingBackslash_ByFile — un valor que termina en «\\» no cierra mal la comilla', () => {
  const { azConsoleCall } = require(WI);
  const c = azConsoleCall('az', ['--project', 'Carpeta\\'], 'win32');
  try {
    assert.strictEqual(c.problem, undefined, JSON.stringify(c));
    assert.notStrictEqual(c.args[1], '"Carpeta\\"', 'nunca entre comillas con la barra al final');
    assert.strictEqual(fs.readFileSync(c.args[1].slice(2, -1), 'utf8'), 'Carpeta\\');
  } finally { c.cleanup(); }
});

// T3 AzWindows_RealConsole_CommentAndQueryArriveIntact
// 🔴 Falla con: que en Windows el conector no encuentre az.cmd (sin la consola), o que el comentario o la consulta lleguen
//    a az cortados o cambiados por la consola.
test('T3 AzWindows_RealConsole_CommentAndQueryArriveIntact — por la consola de verdad, el comentario y la consulta llegan enteros', async (t) => {
  if (process.platform !== 'win32') { t.skip('sólo en Windows: la consola de verdad (la mide el escenario portable)'); return; }
  const bin = tmp('az-bin-');
  const log = path.join(tmp('az-log-'), 'llamadas.jsonl');
  // el az de mentira: anota cada llamada con lo que az leería de cada «@archivo», y contesta como Azure
  fs.writeFileSync(path.join(bin, 'fake-az.js'), [
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const leido = args.map((a) => { const i = a.startsWith('@') ? 0 : a.indexOf('=@') + 1; if (i === 0 && !a.startsWith('@')) return a;",
    "  try { return a.slice(0, i) + fs.readFileSync(a.slice(i + 1), 'utf8'); } catch (_) { return a; } });",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, leido }) + '\\n');`,
    "process.stdout.write(args.includes('show') ? 'Active\\n' : JSON.stringify({ id: 7 }));",
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'az.cmd'), `@"${process.execPath}" "%~dp0fake-az.js" %*\r\n`);
  const tree = tmp('arbol-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ integrations: { platform: { default: 'azure-devops' } } }));
  const home = tmp('casa-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_TREE: tree, TYCON_HOME: path.join(home, '.tycon'), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_CMD|ADO_ORG|ADO_PROJECT|PLATFORM|PROFILE|INTEGRATIONS_DIR)$/.test(k)) delete env[k];
  const ops = tmp('operaciones-');
  const c = await P().run('work-item.update', { repoDir: ops, org: 'acme', project: 'Operaciones', id: 7, comment: HOSTIL }, { env });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  const e = await P().run('work-item.update', { repoDir: ops, org: 'acme', project: 'Operaciones', id: 7, state: 'Active' }, { env });
  assert.strictEqual(e.ok, true, JSON.stringify(e));
  const llamadas = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).leido);
  assert.deepStrictEqual(llamadas, [
    ['boards', 'work-item', 'update', '--organization', ORG, '--id', '7', '--discussion', HOSTIL, '--output', 'json'],
    ['boards', 'work-item', 'show', '--organization', ORG, '--id', '7', '--query', 'fields."System.State"', '--output', 'tsv'],
  ]);
});
