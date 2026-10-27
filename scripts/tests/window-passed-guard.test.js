'use strict';
/**
 * window-passed-guard.test.js — el ayudante que da la ventana de permiso por pasada en las pruebas
 * (tests/lib/window-passed.js) no lo nombra ningún guion fuera de una carpeta de pruebas, y con la HOME de la cuenta no
 * firma nada: fuera de una prueba, cada firma la da el dueño en la ventana.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const AYUDANTE = path.join(__dirname, 'lib', 'window-passed.js');
const CODIGO = /\.(c?js|mjs|sh|ps1|py)$/;
// una carpeta de pruebas en cualquier nivel del camino
const DE_PRUEBAS = /(^|\/)(tests?|__tests__)\//;

function archivosDelRepo() {
  const r = spawnSync('git', ['-C', RAIZ, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `git ls-files falló: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

test('WindowPassed_SoloLoNombranLasPruebas — ningún guion fuera de una carpeta de pruebas nombra el ayudante', () => {
  const fuera = archivosDelRepo().filter((f) => CODIGO.test(f) && !DE_PRUEBAS.test(f));
  assert.ok(fuera.length > 50, `muy pocos guiones para revisar (${fuera.length}): la lista no es la del repo`);
  const lo = fuera.filter((f) => {
    let txt = '';
    try { txt = fs.readFileSync(path.join(RAIZ, f), 'utf8'); } catch (_) { return false; }
    return /window-passed/.test(txt) || /conVentana\s*\(/.test(txt);
  });
  assert.deepStrictEqual(lo, [], `estos guiones nombran el ayudante de pruebas: ${lo.join(', ')}`);
});

test('WindowPassed_ElAyudanteViveEnPruebas — el ayudante está en una carpeta de pruebas', () => {
  const rel = path.relative(RAIZ, AYUDANTE).split(path.sep).join('/');
  assert.ok(fs.existsSync(AYUDANTE), `no encuentro ${rel}`);
  assert.match(rel, DE_PRUEBAS);
});

test('WindowPassed_ConLaCasaReal_NoFirma — con la HOME de la cuenta, el guion termina sin firmar', () => {
  const guion = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-')), 'firma.js');
  fs.writeFileSync(guion, `const ow = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'))});\n`
    + 'const r = ow.exigir({ firma: \'plan-approval\', argv: [], anotar: () => {} });\nconsole.log(r.via || \'sin-firma\');\n');
  const { conVentana } = require(AYUDANTE);
  const env = conVentana({ ...process.env, HOME: os.userInfo().homedir });
  const r = spawnSync(process.execPath, [guion], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /ventana/);
  assert.match(r.stderr, /sólo con una HOME de prueba/);
});

test('WindowPassed_TyconHomeEnLaCasaReal_NoFirma — con la HOME de prueba y TYCON_HOME dentro de la casa de la cuenta, el guion termina sin firmar', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
  const guion = path.join(home, 'firma.js');
  fs.writeFileSync(guion, `const ow = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'))});\n`
    + 'const r = ow.exigir({ firma: \'plan-approval\', argv: [], anotar: () => {} });\nconsole.log(r.via || \'sin-firma\');\n');
  const { conVentana } = require(AYUDANTE);
  // una carpeta que no existe: si el freno fallara, el estado igual caería en la HOME de prueba y no en el de la cuenta
  const tyconHome = path.join(os.userInfo().homedir, '.tycon', `wp-guard-no-existe-${process.pid}`);
  const r = spawnSync(process.execPath, [guion], { encoding: 'utf8', env: conVentana({ ...process.env, HOME: home, TYCON_HOME: tyconHome }) });
  assert.strictEqual(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /ventana/);
  assert.match(r.stderr, /casa de la cuenta/);
  assert.strictEqual(fs.existsSync(tyconHome), false);
});

test('WindowPassed_TocaLaCasaReal — el estado que usaría el guion no puede caer en la casa de la cuenta, ni por un enlace', () => {
  const { tocaLaCasaReal } = require(AYUDANTE);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-casas-')));
  const real = path.join(base, 'cuenta');
  fs.mkdirSync(path.join(real, '.tycon'), { recursive: true });
  const prueba = path.join(base, 'prueba');
  fs.mkdirSync(prueba);
  const enlace = path.join(base, 'enlace');
  fs.symlinkSync(path.join(real, '.tycon'), enlace);
  const casos = [
    ['la HOME es la de la cuenta', { home: real, env: {} }, true],
    ['TYCON_HOME es la casa propia de la cuenta', { home: prueba, env: { TYCON_HOME: path.join(real, '.tycon') } }, true],
    ['TYCON_HOME adentro de la casa propia de la cuenta', { home: prueba, env: { TYCON_HOME: path.join(real, '.tycon', 'x', 'y') } }, true],
    ['TYCON_HOME es la casa de la cuenta', { home: prueba, env: { TYCON_HOME: real } }, true],
    ['TYCON_HOME por un enlace a la casa propia de la cuenta', { home: prueba, env: { TYCON_HOME: enlace } }, true],
    ['la HOME adentro de la carpeta de Claude Code de la cuenta', { home: path.join(real, '.claude', 'h'), env: {} }, true],
    ['la HOME de prueba sin TYCON_HOME', { home: prueba, env: {} }, false],
    ['la HOME de prueba adentro de la casa de la cuenta (un worktree)', { home: path.join(real, 'SourceCode', 'wt', 'h'), env: {} }, false],
    ['TYCON_HOME relativo no cuenta', { home: prueba, env: { TYCON_HOME: '.tycon' } }, false],
  ];
  for (const [que, o, esperado] of casos) assert.strictEqual(tocaLaCasaReal({ ...o, real }), esperado, que);
});

test('WindowPassed_ConCasaDePrueba_FirmaPorVentana — con una HOME de prueba, la firma queda con via ventana', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
  const guion = path.join(home, 'firma.js');
  fs.writeFileSync(guion, `const ow = require(${JSON.stringify(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'))});\n`
    + 'const filas = [];\nconst r = ow.exigir({ firma: \'plan-approval\', argv: [], propia: \'s1\', anotar: (f) => filas.push(f) });\n'
    + 'console.log(JSON.stringify({ r, filas }));\n');
  const { conVentana } = require(AYUDANTE);
  const r = spawnSync(process.execPath, [guion], { encoding: 'utf8', env: conVentana({ ...process.env, HOME: home }) });
  assert.strictEqual(r.status, 0, r.stderr);
  const { r: res, filas } = JSON.parse(r.stdout);
  assert.deepStrictEqual([res.codigo, res.via, res.destino], [0, 'ventana', 's1']);
  assert.deepStrictEqual([filas[0].name, filas[0].via], ['plan-approval-signed', 'ventana']);
});
