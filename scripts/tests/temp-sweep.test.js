'use strict';

/**
 * temp-sweep.test.js — las carpetas temporales viejas que nadie usa se borran solas, y lo que está en uso, es de otro
 * o no se puede juzgar no se toca (scripts/hooks/temp-sweep.js).
 *
 * Dos capas:
 *   · la función `sweep` y sus partes, sobre una carpeta de prueba que hace de carpeta temporal: qué nombres mira, qué
 *     deja por reciente, por socket, por proceso vivo, por dueño, por permisos o por enlace, qué pasa con el tope de
 *     tiempo, sin la lista de procesos, cuando el borrado falla y en el camino de Windows. «Viejo» se arma corriendo
 *     dos días para adelante la fecha contra la que mide la función, no cambiando fechas: la función también mira la
 *     fecha de cambio, que no se puede fijar a mano;
 *   · el gancho como proceso, con un HOME de prueba por caso: borra, dice su línea, sella el día y calla al segundo
 *     arranque; `--force`; el corte por el tope; los interruptores; los valores que no valen; sin la librería del
 *     sello no barre y lo dice.
 *
 * La carpeta de prueba se arma dentro de una carpeta temporal de verdad: el gancho sólo acepta mirar ahí adentro.
 * Las entradas se crean con el permiso de mkdtemp (sólo el dueño), salvo en los casos que prueban otro.
 * Los casos de proceso vivo lanzan un Node de verdad parado en la carpeta, o con un archivo de adentro abierto.
 * Sin red.
 *
 * Correr: node --test scripts/tests/temp-sweep.test.js
 */
// stable-data: el reloj sólo corre para adelante la fecha que mira la función y mide la edad del sello; ningún caso compara contra una hora fija.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const HOOK = path.join(REPO, 'scripts', 'hooks', 'temp-sweep.js');
const { stateDir, claudeDir, agentTempDir } = require(path.join(REPO, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const { LSOF_ARGS, sweep, looksRandom, defaultRoots, allowedRoots, livePaths, trusted, inspect, remove, startupLine, lifeSigns } = require(HOOK);

const WIN = process.platform === 'win32';
const ROOT_USER = !WIN && process.getuid() === 0;
const HOUR = 60 * 60 * 1000;
const real = (p) => fs.realpathSync.native(p);
// dentro de una carpeta temporal de verdad: el gancho no acepta mirar en otro lado
const TEMP = defaultRoots().find((p) => fs.existsSync(p)) || os.tmpdir();
const tmp = real(fs.mkdtempSync(path.join(TEMP, 'temp-sweep-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let serial = 0;

/** Una carpeta que hace de carpeta temporal, vacía y sólo del dueño, y un HOME de prueba al lado. */
function lugar() {
  const base = path.join(tmp, `l${++serial}`);
  const root = path.join(base, 'r');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (!WIN) fs.chmodSync(root, 0o700);
  return { base, root, home };
}

/** Una carpeta del primer nivel como la deja mkdtemp (sólo del dueño), con un archivo dos niveles abajo. */
function carpeta(root, nombre, modo = 0o700) {
  const dir = path.join(root, nombre);
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'dato.txt'), 'dato\n');
  if (!WIN) fs.chmodSync(dir, modo);
  return dir;
}

/** Dentro de dos días: todo lo que se creó recién ya pasó el plazo de 24 horas. */
const pasadoElPlazo = () => Date.now() + 48 * HOUR;

/** La función, sin mirar los procesos de la máquina salvo que el caso lo pida. */
function barrer(root, extra = {}) { return sweep({ roots: [root], now: pasadoElPlazo(), live: [], ...extra }); }

/** Cada entrada mirada cae en un solo casillero. */
function cuadra(res) {
  assert.strictEqual(res.removed.length + res.failed.length + res.inUse + res.unsafe + res.unknown + res.pending + res.gone, res.checked, JSON.stringify(res));
}

function gancho(L, { env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, [HOOK, ...args], {
    cwd: L.base, encoding: 'utf8',
    env: { ...process.env, HOME: L.home, USERPROFILE: L.home, TYCON_TEMP_SWEEP_ROOTS: L.root, TYCON_TEMP_SWEEP_NOW: new Date(pasadoElPlazo()).toISOString(), TYCON_TEMP_SWEEP_HOURS: '', TYCON_TEMP_SWEEP: '', TYCON_EVAL_SANDBOX: '', ...env },
  });
}

const sello = (L) => path.join(stateDir(L.home), 'temp-sweep-last-run');

/** Un Node vivo, lanzado en `cwd`, que corre `code` y avisa cuando está listo. Devuelve el proceso. */
function vivo(code, cwd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `${code}; console.log('listo'); setInterval(() => {}, 1000);`, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

test('T1 el nombre: sólo el sufijo al azar de mkdtemp o el nombre de mktemp, y nunca lo de otra aplicación', () => {
  for (const n of ['coord-aB3dEf', 'packs-dir-9zzzzz', 'equiv-home-XYZabc', 'suite-tmps-Q7w2Lp', 'tmp.Ab3dEfGh1j']) assert.ok(looksRandom(n), n);
  for (const n of [
    // sin sufijo de seis, o con otro separador
    'notas.txt', 'coord-abc', 'coord-aB3dEfg', 'coord.aB3dEf', 'tmp.Ab3dEfGh1',
    // con la forma del nombre de mktemp, pero escritos a mano: sin las tres clases de caracteres
    'tmp.screenshot', 'tmp.production', 'tmp.2024backup', 'tmp.TestOutput', 'tmp.abcdefghij',
    // seis caracteres que escribe una persona: una palabra, una fecha, una versión, una palabra con mayúscula
    'mi-server', 'build-output', 'log-261117', 'dump-202611', 'x-BACKUP', 'x-Backup', 'x-Folder', 'rel-v12345', 'corte-2024q4',
    // de otra aplicación o de las sesiones del asistente
    'com.acme.app-aB3dEf', 'mcp-x-aB3dEf', 'vscode-ipc-aB3dEf', 'claude-aB3dEf', 'CLAUDE-aB3dEf', 'cc-aB3dEf', 'engram-x-aB3dEf', '.oculta-aB3dEf',
  ]) assert.ok(!looksRandom(n), n);
});

test('T2 borra la carpeta y el archivo viejos con sufijo al azar, y deja lo que no lo tiene', () => {
  const L = lugar();
  const vieja = carpeta(L.root, 'coord-aB3dEf');
  const suelto = path.join(L.root, 'tmp.Ab3dEfGh1j');
  const captura = carpeta(L.root, 'tmp.screenshot');
  fs.writeFileSync(suelto, 'x');
  const humana = carpeta(L.root, 'mi-server');
  const ajena = carpeta(L.root, 'claude-aB3dEf');
  const res = barrer(L.root);
  assert.deepStrictEqual(res.removed.sort(), ['coord-aB3dEf', 'tmp.Ab3dEfGh1j']);
  assert.ok(fs.existsSync(path.join(captura, 'a', 'b', 'dato.txt')), 'un nombre a mano con la forma del de mktemp no se toca');
  assert.ok(!fs.existsSync(vieja) && !fs.existsSync(suelto));
  assert.ok(fs.existsSync(path.join(humana, 'a', 'b', 'dato.txt')), 'un nombre sin sufijo al azar no se toca');
  assert.ok(fs.existsSync(path.join(ajena, 'a', 'b', 'dato.txt')), 'lo de las sesiones del asistente no se toca');
  assert.strictEqual(res.checked, 2);
  cuadra(res);
});

test('T3 dentro del plazo no borra nada: la carpeta recién creada queda', () => {
  const L = lugar();
  const nueva = carpeta(L.root, 'coord-aB3dEf');
  const res = sweep({ roots: [L.root], live: [] });
  assert.deepStrictEqual(res.removed, []);
  assert.strictEqual(res.inUse, 1);
  assert.ok(fs.existsSync(nueva));
  cuadra(res);
});

test('T4 un solo archivo de adentro cambiado en el plazo protege a toda la carpeta', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const reciente = new Date(pasadoElPlazo() - HOUR);
  fs.utimesSync(path.join(dir, 'a', 'b', 'dato.txt'), reciente, reciente);
  const res = barrer(L.root);
  assert.deepStrictEqual(res.removed, []);
  assert.strictEqual(res.inUse, 1);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'dato.txt')));
});

test('T5 la fecha de cambio también cuenta: fechas de modificación viejas sobre algo recién tocado no alcanzan', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  // como lo deja un desempaquetado: todo con fecha de modificación de hace tres días, y recién escrito
  const vieja = new Date(Date.now() - 72 * HOUR);
  for (const p of [path.join(dir, 'a', 'b', 'dato.txt'), path.join(dir, 'a', 'b'), path.join(dir, 'a'), dir]) fs.utimesSync(p, vieja, vieja);
  assert.ok(Date.now() - fs.statSync(dir).mtimeMs > 71 * HOUR, 'la fecha de modificación quedó vieja');
  const res = sweep({ roots: [L.root], live: [] });
  assert.deepStrictEqual(res.removed, []);
  assert.strictEqual(res.inUse, 1);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'dato.txt')));
});

test('T6 una carpeta con un socket adentro no se toca', { skip: WIN }, async () => {
  const L = lugar();
  const dir = carpeta(L.root, 's-aB3dEf');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(dir, 's'), resolve); });
  try {
    const res = barrer(L.root);
    assert.deepStrictEqual(res.removed, []);
    assert.strictEqual(res.inUse, 1);
    assert.ok(fs.existsSync(path.join(dir, 'a', 'b', 'dato.txt')));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('T7 la carpeta de trabajo de un proceso vivo no se toca, y la de al lado sí', async () => {
  const L = lugar();
  const usada = carpeta(L.root, 'coord-aB3dEf');
  const libre = carpeta(L.root, 'coord-zY9xWv');
  const child = await vivo('0', usada);
  try {
    const res = sweep({ roots: [L.root], now: pasadoElPlazo() });
    assert.strictEqual(res.unknown, 0, 'la lista de procesos vivos se pudo leer');
    assert.deepStrictEqual(res.removed, ['coord-zY9xWv']);
    assert.strictEqual(res.inUse, 1);
    assert.ok(fs.existsSync(path.join(usada, 'a', 'b', 'dato.txt')));
    assert.ok(!fs.existsSync(libre));
    cuadra(res);
  } finally { child.kill('SIGKILL'); }
});

test('T8 una carpeta con un archivo abierto por un proceso vivo no se toca, aunque la raíz se pase por un enlace', { skip: WIN }, async () => {
  const L = lugar();
  const usada = carpeta(L.root, 'coord-aB3dEf');
  const enlace = path.join(L.base, 'enlace-a-la-raiz');
  fs.symlinkSync(L.root, enlace);
  const child = await vivo("require('fs').openSync(process.argv[1], 'r')", L.base, [path.join(usada, 'a', 'b', 'dato.txt')]);
  try {
    const res = sweep({ roots: [enlace], now: pasadoElPlazo() });
    assert.strictEqual(res.unknown, 0, 'la lista de procesos vivos se pudo leer');
    assert.strictEqual(res.checked, 1, 'la raíz se mira por su ruta real');
    assert.deepStrictEqual(res.removed, []);
    assert.strictEqual(res.inUse, 1);
    assert.ok(fs.existsSync(path.join(usada, 'a', 'b', 'dato.txt')));
  } finally { child.kill('SIGKILL'); }
});

test('T9 sin saber qué usan los procesos vivos no borra: las viejas quedan y se cuentan', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const res = barrer(L.root, { live: null });
  assert.deepStrictEqual(res.removed, []);
  assert.strictEqual(res.unknown, 1);
  assert.ok(fs.existsSync(dir));
  assert.match(startupLine(res), /dejé 1: no pude saber si están en uso/);
  cuadra(res);
});

test('T10 la lista de procesos vivos se cree sólo si trae la carpeta de este mismo proceso', () => {
  assert.deepStrictEqual(trusted(new Set(['/a', '/propia']), '/propia').sort(), ['/a', '/propia']);
  assert.strictEqual(trusted(new Set(['/a', '/b']), '/propia'), null, 'una lista recortada no sirve');
  assert.strictEqual(trusted(new Set(), '/propia'), null, 'una lista vacía no es «nadie usa nada»');
  assert.strictEqual(trusted(null, '/propia'), null);
  assert.strictEqual(trusted(new Set(['/propia']), null), null, 'sin saber la carpeta propia no hay contra qué comprobar');
  assert.deepStrictEqual(livePaths({ win: true }), [], 'en Windows no hay lista: lo dice el cambio de nombre, y no es «no se sabe»');
});

test('T11 lo de otro usuario no se toca; sin número de usuario (Windows) el dueño no se mira', { skip: WIN }, () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const ajeno = barrer(L.root, { uid: process.getuid() + 1 });
  assert.deepStrictEqual(ajeno.removed, []);
  assert.strictEqual(ajeno.checked, 0);
  assert.deepStrictEqual(ajeno.skippedRoots, [L.root], 'una raíz de otro, sin «sticky», no se mira');
  assert.ok(fs.existsSync(dir));
  // algo de otro adentro de una entrada que otro alcanza, y otro disco adentro
  fs.chmodSync(dir, 0o755);
  const st = fs.statSync(dir);
  assert.strictEqual(inspect(dir, { cutoff: pasadoElPlazo(), deadline: Date.now() + 5000, uid: process.getuid() + 1, dev: st.dev }), 'unsafe');
  assert.strictEqual(inspect(dir, { cutoff: pasadoElPlazo(), deadline: Date.now() + 5000, uid: process.getuid(), dev: st.dev + 1 }), 'unsafe', 'otro disco adentro');
  fs.chmodSync(dir, 0o700);
  const sinNumero = barrer(L.root, { uid: null });
  assert.deepStrictEqual(sinNumero.removed, ['coord-aB3dEf']);
});

test('T12 enlaces: el del primer nivel queda, y lo que está del otro lado de uno de adentro también', () => {
  const L = lugar();
  const afuera = path.join(L.base, 'afuera');
  fs.mkdirSync(afuera);
  fs.writeFileSync(path.join(afuera, 'queda.txt'), 'queda\n');
  fs.symlinkSync(afuera, path.join(L.root, 'enlace-aB3dEf'), 'junction');
  const dir = carpeta(L.root, 'coord-aB3dEf');
  fs.symlinkSync(afuera, path.join(dir, 'a', 'salida'), 'junction');
  const res = barrer(L.root);
  assert.deepStrictEqual(res.removed, ['coord-aB3dEf']);
  assert.ok(fs.lstatSync(path.join(L.root, 'enlace-aB3dEf')).isSymbolicLink(), 'el enlace del primer nivel queda');
  assert.ok(fs.existsSync(path.join(afuera, 'queda.txt')), 'lo de afuera queda');
});

test('T13 una entrada que otro alcanza y tiene adentro una carpeta donde otro escribe no se toca; la que es sólo del dueño sí', { skip: WIN }, () => {
  const L = lugar();
  const abierta = carpeta(L.root, 'coord-aB3dEf', 0o755);
  fs.chmodSync(path.join(abierta, 'a'), 0o777);
  const alcanzable = carpeta(L.root, 'coord-kL8mNp', 0o755);
  fs.chmodSync(path.join(alcanzable, 'a'), 0o755);
  fs.chmodSync(path.join(alcanzable, 'a', 'b'), 0o755);
  const privada = carpeta(L.root, 'coord-zY9xWv', 0o700);
  fs.chmodSync(path.join(privada, 'a'), 0o777);
  const res = barrer(L.root);
  assert.deepStrictEqual(res.removed.sort(), ['coord-kL8mNp', 'coord-zY9xWv']);
  assert.strictEqual(res.unsafe, 1);
  assert.ok(fs.existsSync(path.join(abierta, 'a', 'b', 'dato.txt')));
  assert.strictEqual(startupLine({ ...res, removed: [] }), null, 'lo que no es seguro tocar queda en silencio');
  cuadra(res);
});

test('T14 una raíz donde cualquiera escribe y que no protege lo de cada uno no se mira, y se dice', { skip: WIN }, () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  fs.chmodSync(L.root, 0o777);
  try {
    const res = barrer(L.root);
    assert.deepStrictEqual(res.removed, []);
    assert.deepStrictEqual(res.skippedRoots, [L.root]);
    assert.ok(fs.existsSync(dir));
    assert.match(startupLine(res), /no miré .*: no es una carpeta que se pueda barrer/);
    fs.chmodSync(L.root, 0o1777);
    assert.deepStrictEqual(barrer(L.root, { uid: process.getuid() + 1 }).skippedRoots, [L.root], 'con «sticky» pero de otro que no es el administrador, tampoco');
    assert.deepStrictEqual(barrer(L.root).removed, ['coord-aB3dEf'], 'con «sticky», como /tmp, sí');
  } finally { fs.chmodSync(L.root, 0o700); }
});

test('T15 una carpeta de adentro que no se deja leer: sin permiso de paso se borra igual; con permiso de paso no se toca', { skip: WIN || ROOT_USER }, () => {
  const L = lugar();
  const cerrada = carpeta(L.root, 'coord-aB3dEf');
  const sinPaso = carpeta(L.root, 'coord-kL8mNp');
  fs.chmodSync(path.join(sinPaso, 'a'), 0o444);
  const ciega = carpeta(L.root, 'coord-zY9xWv');
  fs.chmodSync(path.join(cerrada, 'a', 'b'), 0o500);
  fs.chmodSync(path.join(cerrada, 'a'), 0o000);
  fs.chmodSync(path.join(ciega, 'a'), 0o300);
  // sin paso para el dueño y con paso para otros: otro podría entrar, y el dueño no puede mirar
  const paraOtros = carpeta(L.root, 'coord-Hq4RtW');
  fs.chmodSync(path.join(paraOtros, 'a'), 0o005);
  try {
    const res = barrer(L.root);
    assert.deepStrictEqual(res.removed, ['coord-aB3dEf', 'coord-kL8mNp'], 'sin permiso de paso (cerrada del todo, o sólo de lectura): nadie entra por ruta, y se le devuelve el permiso para borrarla');
    assert.ok(!fs.existsSync(sinPaso));
    assert.strictEqual(res.unknown, 2, 'con permiso de paso (del dueño o de otros) y sin lectura no se sabe qué tiene');
    assert.ok(fs.existsSync(paraOtros));
    assert.ok(!fs.existsSync(cerrada));
    assert.ok(fs.existsSync(ciega));
    cuadra(res);
  } finally {
    for (const p of [path.join(cerrada, 'a'), path.join(cerrada, 'a', 'b'), path.join(ciega, 'a'), path.join(sinPaso, 'a'), path.join(paraOtros, 'a')]) { try { fs.chmodSync(p, 0o700); } catch (_) { /* ya no está */ } }
  }
});

test('T16 lo que no se deja borrar se cuenta y se nombra', { skip: WIN || ROOT_USER }, () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  // la raíz sin permiso de escritura: la entrada se mira, pero no se puede sacar de ahí
  fs.chmodSync(L.root, 0o500);
  try {
    const res = barrer(L.root);
    assert.deepStrictEqual(res.removed, []);
    assert.deepStrictEqual(res.failed, ['coord-aB3dEf']);
    assert.ok(fs.existsSync(dir));
    assert.match(startupLine(res), /^temporales viejos: 1 no se dejaron borrar \(coord-aB3dEf\)\. Apagar: TYCON_TEMP_SWEEP=0$/);
    cuadra(res);
  } finally { fs.chmodSync(L.root, 0o700); }
});

test('T17 el camino de Windows: cambia el nombre y lo devuelve antes de borrar; si el sistema se niega, la deja', { skip: ROOT_USER }, () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  assert.strictEqual(remove(dir, { win: true }), 'removed');
  assert.ok(!fs.existsSync(dir));
  assert.deepStrictEqual(fs.readdirSync(L.root), [], 'no queda el nombre de paso');
  assert.strictEqual(remove(dir, { win: true }), 'gone', 'lo que ya borró otro no se cuenta como borrado');
  // algo que ya se llama como el nombre de paso no se pisa
  const conResto = carpeta(L.root, 'coord-kL8mNp');
  const dePaso = conResto + '.tycon-sweep';
  fs.writeFileSync(dePaso, 'resto\n');
  assert.strictEqual(remove(conResto, { win: true }), 'failed');
  assert.strictEqual(fs.readFileSync(dePaso, 'utf8'), 'resto\n');
  fs.rmSync(dePaso);
  // el cambio de nombre que falla: por otra cosa que «en uso», o a la vuelta
  const original = fs.renameSync;
  try {
    fs.renameSync = () => { const e = new Error('disco lleno'); e.code = 'ENOSPC'; throw e; };
    assert.strictEqual(remove(conResto, { win: true }), 'failed', 'un error que no es «en uso» no se cuenta como en uso');
    let calls = 0;
    fs.renameSync = (...a) => { if (++calls === 2) { const e = new Error('ocupado'); e.code = 'EBUSY'; throw e; } return original(...a); };
    const res = barrer(L.root, { win: true });
    assert.deepStrictEqual(res.failed, ['coord-kL8mNp.tycon-sweep'], 'si no vuelve a su nombre, se informa el de paso');
    cuadra(res);
  } finally { fs.renameSync = original; }
  fs.rmSync(dePaso, { recursive: true, force: true });
  if (WIN) return;
  // el cambio de nombre se niega: acá, por una raíz sin permiso de escritura
  const otra = carpeta(L.root, 'coord-zY9xWv');
  fs.chmodSync(L.root, 0o500);
  try {
    const res = barrer(L.root, { win: true });
    assert.deepStrictEqual(res.removed, []);
    assert.deepStrictEqual(res.failed, []);
    assert.strictEqual(res.inUse, 1);
    assert.ok(fs.existsSync(path.join(otra, 'a', 'b', 'dato.txt')));
    cuadra(res);
  } finally { fs.chmodSync(L.root, 0o700); }
});

test('T18 con el tope de tiempo agotado no mira ni borra: las cuenta como pendientes', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  carpeta(L.root, 'coord-zY9xWv');
  const res = barrer(L.root, { budgetMs: 0 });
  assert.deepStrictEqual(res.removed, []);
  assert.strictEqual(res.pending, 2);
  assert.ok(fs.existsSync(dir));
  assert.match(startupLine(res), /2 quedaron sin mirar por el tope de tiempo: vuelvo a pasar en la próxima sesión que arranque después de una hora/);
  assert.doesNotMatch(startupLine(res, { dryRun: true }), /vuelvo a pasar/, 'el simulacro no promete otra pasada');
  const st = fs.statSync(dir);
  assert.strictEqual(inspect(dir, { cutoff: pasadoElPlazo(), deadline: Date.now() - 1, uid: null, dev: st.dev }), 'timeout', 'el corte también vale a mitad de una carpeta');
  cuadra(res);
});

test('T19 el simulacro no borra y dice qué borraría', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const res = barrer(L.root, { dryRun: true });
  assert.deepStrictEqual(res.removed, ['coord-aB3dEf']);
  assert.ok(fs.existsSync(dir));
  assert.match(startupLine(res, { dryRun: true }), /^temporales viejos: borraría 1 que nadie usa hace 24 h\. Apagar: TYCON_TEMP_SWEEP=0$/);
  assert.strictEqual(startupLine({ removed: [], failed: [], inUse: 3, unsafe: 0, unknown: 0, pending: 0, checked: 3, skippedRoots: [] }), null, 'sólo cosas en uso: silencio');
});

test('T20 dónde mira: las carpetas por defecto no salen de TMPDIR, y una ruta pedida sólo vale dentro de una de ellas', () => {
  const L = lugar();
  const antes = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = L.root; process.env.TEMP = L.root; process.env.TMP = L.root;
  try {
    const roots = defaultRoots();
    assert.ok(!roots.includes(L.root), 'TMPDIR no decide dónde se borra');
    if (process.platform === 'darwin') assert.ok(roots.includes('/private/tmp'));
    if (process.platform === 'linux') assert.deepStrictEqual(roots, ['/tmp']);
    if (WIN) assert.deepStrictEqual(roots, [path.join(os.homedir(), 'AppData', 'Local', 'Temp')]);
  } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const adentro = path.join(L.root, 'x');
  fs.mkdirSync(adentro);
  const vecina = `${L.root}-otra`;
  fs.mkdirSync(vecina);
  const split = allowedRoots([adentro, L.root, L.home, vecina, path.join(L.base, 'no-existe')], [L.root]);
  assert.deepStrictEqual(split.inside, [adentro, L.root]);
  assert.deepStrictEqual(split.outside, [L.home, vecina, path.join(L.base, 'no-existe')], 'una vecina que empieza igual no está adentro');
});

test('T21 el gancho: borra, dice su línea, sella el día y calla al segundo arranque; --force pasa de nuevo', () => {
  const L = lugar();
  const uno = carpeta(L.root, 'coord-aB3dEf');
  const r1 = gancho(L);
  assert.strictEqual(r1.status, 0);
  assert.match(r1.stdout, /^temporales viejos: borré 1 que nadie usa hace 24 h\. Apagar: TYCON_TEMP_SWEEP=0\n$/);
  assert.ok(!fs.existsSync(uno));
  assert.ok(fs.existsSync(sello(L)), 'sella el día');
  const dos = carpeta(L.root, 'coord-zY9xWv');
  const r2 = gancho(L);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout, '', 'el segundo arranque del día calla');
  assert.ok(fs.existsSync(dos), 'y no borra');
  const r3 = gancho(L, { args: ['--force', '--json'] });
  assert.deepStrictEqual(JSON.parse(r3.stdout).removed, ['coord-zY9xWv']);
  assert.ok(!fs.existsSync(dos));
  // un sello con fecha futura (el reloj se corrigió para atrás) cuenta como vencido
  const tres = carpeta(L.root, 'coord-kL8mNp');
  const futuro = new Date(Date.now() + 72 * HOUR);
  fs.utimesSync(sello(L), futuro, futuro);
  assert.match(gancho(L).stdout, /borré 1/);
  assert.ok(!fs.existsSync(tres));
});

test('T22 el gancho sin nada que borrar: silencio, y sella igual; el simulacro no borra ni sella', () => {
  const L = lugar();
  carpeta(L.root, 'mi-server');
  const vieja = carpeta(L.root, 'coord-aB3dEf');
  const s = gancho(L, { args: ['--dry-run'] });
  assert.match(s.stdout, /^temporales viejos: borraría 1 que nadie usa hace 24 h\. Apagar: TYCON_TEMP_SWEEP=0\n$/);
  assert.ok(fs.existsSync(vieja));
  assert.ok(!fs.existsSync(sello(L)), 'un simulacro no gasta la pasada del día');
  fs.rmSync(vieja, { recursive: true });
  const r = gancho(L);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(fs.existsSync(sello(L)));
});

test('T23 el gancho cortado por el tope: no borra, lo dice y vuelve a pasar en una hora, no mañana', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const r = gancho(L, { args: ['--budget-seconds', '0'] });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /1 quedaron sin mirar por el tope de tiempo: vuelvo a pasar/);
  assert.ok(fs.existsSync(dir));
  const edad = Date.now() - fs.statSync(sello(L)).mtimeMs;
  assert.ok(edad > 22 * HOUR && edad < 24 * HOUR, `el sello queda a una hora de vencer (edad ${Math.round(edad / HOUR)} h)`);
});

test('T24 los dos interruptores: apagado no mira, no borra y no sella', () => {
  for (const env of [{ TYCON_TEMP_SWEEP: '0' }, { TYCON_EVAL_SANDBOX: '1' }]) {
    const L = lugar();
    const dir = carpeta(L.root, 'coord-aB3dEf');
    const r = gancho(L, { env });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(fs.existsSync(dir), JSON.stringify(env));
    assert.ok(!fs.existsSync(sello(L)), JSON.stringify(env));
  }
});

test('T25 el plazo: se puede alargar, y uno menor que una hora o que no es un número no vale y se dice', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const largo = JSON.parse(gancho(L, { env: { TYCON_TEMP_SWEEP_HOURS: '72' }, args: ['--force', '--json'] }).stdout);
  assert.strictEqual(largo.hours, 72);
  assert.deepStrictEqual(largo.removed, [], 'a dos días, con un plazo de tres, todavía no');
  assert.ok(fs.existsSync(dir));
  for (const malo of ['0', '0.5', 'abc', '-3']) {
    const M = lugar();
    carpeta(M.root, 'coord-aB3dEf');
    const r = gancho(M, { env: { TYCON_TEMP_SWEEP_HOURS: malo } });
    assert.match(r.stdout, /borré 1 que nadie usa hace 24 h · TYCON_TEMP_SWEEP_HOURS «.+» no vale \(un número de 1 para arriba\): uso 24\./, malo);
  }
  const N = lugar();
  const reciente = carpeta(N.root, 'coord-aB3dEf');
  const r = gancho(N, { env: { TYCON_TEMP_SWEEP_NOW: 'ayer' } });
  assert.match(r.stdout, /TYCON_TEMP_SWEEP_NOW «ayer» no es una fecha: uso la de ahora/);
  assert.ok(fs.existsSync(reciente), 'con la fecha de ahora, lo recién creado queda');
  const B = lugar();
  carpeta(B.root, 'coord-aB3dEf');
  assert.match(gancho(B, { args: ['--budget-seconds', 'mucho'] }).stdout, /--budget-seconds «mucho» no vale/);
  assert.match(gancho(B, { args: ['--force', '--budget-seconds', '-5'] }).stdout, /--budget-seconds «-5» no vale/);
});

test('T26 una ruta pedida fuera de las carpetas temporales no se mira, y se dice', { skip: WIN }, () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const r = gancho(L, { env: { TYCON_TEMP_SWEEP_ROOTS: ['/', L.root].join(path.delimiter) } });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /borré 1 que nadie usa hace 24 h · TYCON_TEMP_SWEEP_ROOTS: \/ no está dentro de una carpeta temporal y no se mira\./);
  assert.ok(!fs.existsSync(dir), 'la que sí está adentro se mira igual');
});

test('T27 el guion suelto, sin la librería que sabe dónde va el sello, no barre, lo dice y sale 0', () => {
  const L = lugar();
  const dir = carpeta(L.root, 'coord-aB3dEf');
  const suelto = path.join(L.base, 'suelto', 'temp-sweep.js');
  fs.mkdirSync(path.dirname(suelto));
  fs.copyFileSync(HOOK, suelto);
  const r = spawnSync(process.execPath, [suelto], { cwd: L.base, encoding: 'utf8', env: { ...process.env, HOME: L.home, USERPROFILE: L.home, TYCON_TEMP_SWEEP_ROOTS: L.root, TYCON_TEMP_SWEEP_NOW: new Date(pasadoElPlazo()).toISOString(), TYCON_TEMP_SWEEP: '', TYCON_EVAL_SANDBOX: '' } });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^temporales viejos: el barrido falló \(.+\)\. Apagar: TYCON_TEMP_SWEEP=0\n$/);
  assert.ok(fs.existsSync(dir));
  const j = spawnSync(process.execPath, [suelto, '--json'], { cwd: L.base, encoding: 'utf8', env: { ...process.env, HOME: L.home, USERPROFILE: L.home, TYCON_TEMP_SWEEP: '', TYCON_EVAL_SANDBOX: '' } });
  assert.ok(JSON.parse(j.stdout).error, 'con --json, el fallo también sale en JSON');
});

test('T28 lsof no traduce las direcciones ni los puertos de red: con muchas conexiones, la lista llega antes del tope', () => {
  assert.ok(LSOF_ARGS.includes('-n') && LSOF_ARGS.includes('-P'), LSOF_ARGS.join(' '));
  assert.deepStrictEqual(LSOF_ARGS.slice(-3), ['-u', String(process.getuid ? process.getuid() : ''), '-Fn']);
});

// ── las carpetas temporales de las sesiones del agente (@story-8.164) ────────────────────────────────────────────────

const AGENTE = WIN ? null : path.basename(agentTempDir());
const DIA = 24 * HOUR;
const sid = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** La carpeta temporal de una sesión del agente, como la arma Claude Code: `claude-<uid>/<proyecto>/<sesión>/`. */
function sesion(root, id, proyecto = '-Users-dev-repo') {
  const dir = path.join(root, AGENTE, proyecto, id);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 'b1.output'), 'salida\n');
  for (const d of [path.join(root, AGENTE), path.join(root, AGENTE, proyecto), dir]) fs.chmodSync(d, 0o700);
  return dir;
}

/** Los rastros de vida en un HOME de prueba: los archivos de sesión de Claude Code y los marcadores del arnés. */
function rastros(home, { sesiones = [], marcadores = [], estacionadas = [] } = {}) {
  const sdir = path.join(claudeDir(home), 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  sesiones.forEach((s, i) => fs.writeFileSync(path.join(sdir, `${9000 + i}.json`), JSON.stringify({ cwd: '/x', ...s })));
  for (const [carpeta, lista] of [['active', marcadores], ['parked', estacionadas]]) {
    fs.mkdirSync(path.join(stateDir(home), carpeta), { recursive: true });
    for (const id of lista) fs.writeFileSync(path.join(stateDir(home), carpeta, `${id}.json`), '{}');
  }
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'sin-gitconfig'), GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid' };
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Un remoto de juguete con un commit en main, y un clon suyo en `dest`, limpio y con todo subido. */
function clon(base, dest) {
  const remoto = path.join(base, 'remoto.git');
  if (!fs.existsSync(remoto)) {
    git(base, 'init', '-q', '--bare', '-b', 'main', remoto);
    const semilla = path.join(base, 'semilla');
    git(base, 'clone', '-q', remoto, semilla);
    fs.writeFileSync(path.join(semilla, 'a.txt'), 'a\n');
    git(semilla, 'add', 'a.txt');
    git(semilla, 'commit', '-q', '-m', 'uno');
    git(semilla, 'push', '-q', 'origin', 'HEAD:main');
  }
  git(base, 'clone', '-q', remoto, dest);
  return dest;
}

test('T29 8.164-SesionMuertaYVieja_SeBorra @story-8.164 @ac-8 — la carpeta de una sesión sin rastro de vida y sin tocar hace más del plazo se borra; la viva, la reciente y la que tiene trabajo sin guardar quedan, y la sucia se nombra', { skip: WIN }, () => {
  const L = lugar();
  const sinArchivo = sesion(L.root, sid(1));
  const muerta = sesion(L.root, sid(2));
  const viva = sesion(L.root, sid(4));
  const conMarcador = sesion(L.root, sid(5));
  const estacionada = sesion(L.root, sid(9));
  const sucia = sesion(L.root, sid(6));
  clon(L.base, path.join(sucia, 'scratchpad', 'c'));
  fs.writeFileSync(path.join(sucia, 'scratchpad', 'c', 'nuevo.txt'), 'sin commitear\n');
  const sinSubir = sesion(L.root, sid(7), '-Users-dev-otro');
  const c2 = clon(L.base, path.join(sinSubir, 'scratchpad', 'c'));
  fs.writeFileSync(path.join(c2, 'b.txt'), 'b\n');
  git(c2, 'add', 'b.txt');
  git(c2, 'commit', '-q', '-m', 'sin subir');
  const sinRemota = sesion(L.root, sid(3), '-Users-dev-otro');
  git(clon(L.base, path.join(sinRemota, 'x')), 'checkout', '-q', '-b', 'propia');
  const limpia = sesion(L.root, sid(8));
  clon(L.base, path.join(limpia, 'scratchpad', 'c'));
  const tocada = sesion(L.root, 'aaaaaaaa-0000-4000-8000-000000000001');
  // lo que se crea después del corte es nuevo: la edad de una carpeta es la de lo más nuevo que tiene adentro
  dormir(30);
  const corte = Date.now();
  dormir(30);
  const nueva = sesion(L.root, 'aaaaaaaa-0000-4000-8000-000000000002');
  fs.writeFileSync(path.join(tocada, 'tasks', 'b2.output'), 'recién\n');
  const muerto = spawnSync(process.execPath, ['-e', '']).pid;
  rastros(L.home, { sesiones: [{ sessionId: sid(2), pid: muerto }, { sessionId: sid(4), pid: process.pid }], marcadores: [sid(5)], estacionadas: [sid(9)] });
  const life = lifeSigns(L.home);
  assert.strictEqual(life.error, null, life.error);
  const res = sweep({ roots: [L.root], now: corte + 2 * DIA, live: [], agent: { name: AGENTE, days: 2, life } });
  const s = res.sessions;
  assert.deepStrictEqual(s.removed.slice().sort(), [sinArchivo, muerta, limpia].sort(), JSON.stringify(s));
  for (const d of [sinArchivo, muerta, limpia]) assert.ok(!fs.existsSync(d), `${d} se borra`);
  for (const d of [viva, conMarcador, estacionada, sucia, sinSubir, sinRemota, tocada, nueva]) assert.ok(fs.existsSync(d), `${d} queda`);
  assert.deepStrictEqual(s.unsaved.map((u) => u.path).sort(), [sucia, sinSubir, sinRemota].sort(), JSON.stringify(s.unsaved));
  assert.match(s.unsaved.find((u) => u.path === sucia).why, /cambios sin commitear/);
  assert.match(s.unsaved.find((u) => u.path === sinSubir).why, /commits sin subir/);
  assert.match(s.unsaved.find((u) => u.path === sinRemota).why, /rama sin remoto/);
  assert.strictEqual(s.blocked, null);
  const line = startupLine(res, { sessionDays: 2 });
  assert.match(line, /sesiones del agente que ya no viven: borré 3 sin tocar hace 2 días/);
  assert.ok(line.includes(sucia), 'la del clon sucio se nombra');
  // dos barridos a la vez: el segundo no encuentra nada que borrar y no lo cuenta como error
  const otra = sweep({ roots: [L.root], now: corte + 2 * DIA, live: [], agent: { name: AGENTE, days: 2, life } });
  assert.deepStrictEqual(otra.sessions.removed, []);
  assert.deepStrictEqual(otra.sessions.failed, []);
  // con el plazo sin cumplir, nada de lo muerto se borra
  const antes = sesion(L.root, sid(1));
  assert.deepStrictEqual(sweep({ roots: [L.root], now: corte + DIA, live: [], agent: { name: AGENTE, days: 2, life } }).sessions.removed, []);
  assert.ok(fs.existsSync(antes));
});

test('T30 8.164-FormaDesconocida_NoSeToca @story-8.164 @ac-9 — lo que no tiene la forma claude-<uid>/<proyecto>/<sesión> no se toca', { skip: WIN }, () => {
  const L = lugar();
  const ag = path.join(L.root, AGENTE);
  fs.mkdirSync(path.join(ag, '-Users-dev-repo', 'no-es-una-sesion'), { recursive: true });
  fs.writeFileSync(path.join(ag, '-Users-dev-repo', 'no-es-una-sesion', 'x.txt'), 'x\n');
  fs.writeFileSync(path.join(ag, '-Users-dev-repo', `${sid(1)}`), 'un archivo con nombre de sesión\n');
  fs.writeFileSync(path.join(ag, 'suelto.txt'), 'x\n');
  const ajeno = path.join(L.root, 'claude-99999', '-Users-dev-repo', sid(2));
  fs.mkdirSync(ajeno, { recursive: true });
  fs.mkdirSync(path.join(L.base, 'afuera', sid(3)), { recursive: true });
  fs.symlinkSync(path.join(L.base, 'afuera', sid(3)), path.join(ag, '-Users-dev-repo', sid(3)));
  const suelta = carpeta(L.root, 'suelta');
  rastros(L.home);
  const res = sweep({ roots: [L.root], now: Date.now() + 3 * DIA, live: [], agent: { name: AGENTE, days: 2, life: lifeSigns(L.home) } });
  assert.deepStrictEqual(res.sessions.removed, []);
  for (const p of [path.join(ag, '-Users-dev-repo', 'no-es-una-sesion', 'x.txt'), path.join(ag, '-Users-dev-repo', sid(1)), path.join(ag, 'suelto.txt'), ajeno, path.join(L.base, 'afuera', sid(3)), path.join(ag, '-Users-dev-repo', sid(3)), suelta]) {
    assert.ok(fs.existsSync(p), `${p} queda`);
  }
});

test('T31 8.164-NoPudeLeer_NoBorra @story-8.164 @ac-10 — sin poder leer las sesiones o los marcadores no se borra ninguna carpeta de sesión, y se dice; lo demás del barrido sigue', { skip: WIN }, () => {
  // sin la carpeta de sesiones (una máquina sólo con Codex): no se sabe qué sesión vive
  const sinSesiones = lugar();
  assert.match(lifeSigns(sinSesiones.home).error, /no pude leer las sesiones/);
  // un archivo de sesión ilegible
  const ilegible = lugar();
  rastros(ilegible.home);
  fs.writeFileSync(path.join(claudeDir(ilegible.home), 'sessions', '1.json'), '{ a medias');
  assert.match(lifeSigns(ilegible.home).error, /no pude leer las sesiones/);
  if (!ROOT_USER) {
    // la carpeta de marcadores sin permiso de lectura
    const sinMarcadores = lugar();
    rastros(sinMarcadores.home);
    fs.chmodSync(path.join(stateDir(sinMarcadores.home), 'active'), 0o000);
    try { assert.match(lifeSigns(sinMarcadores.home).error, /no pude leer los marcadores/); } finally { fs.chmodSync(path.join(stateDir(sinMarcadores.home), 'active'), 0o700); }
  }
  // sin la carpeta de marcadores no hay ejecuciones: eso sí se sabe
  const nunca = lugar();
  fs.mkdirSync(path.join(claudeDir(nunca.home), 'sessions'), { recursive: true });
  assert.strictEqual(lifeSigns(nunca.home).error, null);

  const L = lugar();
  const muerta = sesion(L.root, sid(1));
  const vieja = carpeta(L.root, 'coord-aB3dEf');
  const life = lifeSigns(L.home);
  const res = sweep({ roots: [L.root], now: Date.now() + 3 * DIA, live: [], agent: { name: AGENTE, days: 2, life } });
  assert.ok(fs.existsSync(muerta), 'la de sesión queda');
  assert.deepStrictEqual(res.sessions.removed, []);
  assert.match(res.sessions.blocked, /no pude leer las sesiones/);
  assert.ok(!fs.existsSync(vieja), 'el temporal común se borra igual');
  assert.match(startupLine(res, { sessionDays: 2 }), /sesiones del agente: no borré ninguna, no pude leer las sesiones/);

  // el gancho, con el HOME vacío: lo mismo, en su línea
  const G = lugar();
  const otra = sesion(G.root, sid(2));
  const r = gancho(G);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(otra));
  assert.match(r.stdout, /sesiones del agente: no borré ninguna, no pude leer las sesiones/);
});

test('T32 8.164 @story-8.164 @ac-8 — el gancho borra la carpeta de una sesión muerta y vieja con el plazo del perfil, y la nombra si tiene trabajo sin guardar', { skip: WIN }, () => {
  const L = lugar();
  const muerta = sesion(L.root, sid(1));
  const sucia = sesion(L.root, sid(2));
  clon(L.base, path.join(sucia, 'scratchpad', 'c'));
  fs.writeFileSync(path.join(sucia, 'scratchpad', 'c', 'nuevo.txt'), 'sin commitear\n');
  rastros(L.home);
  const vacio = path.join(L.base, 'team-profile.json');
  fs.writeFileSync(vacio, '{}');
  const r = gancho(L, { env: { TYCON_PROFILE: vacio, TYCON_TEMP_SWEEP_NOW: new Date(Date.now() + 3 * DIA).toISOString() } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(muerta), r.stdout);
  assert.ok(fs.existsSync(sucia));
  assert.match(r.stdout, /sesiones del agente que ya no viven: borré 1 sin tocar hace 2 días/);
  assert.ok(r.stdout.includes(sucia), r.stdout);
  // el perfil alarga el plazo: con 5 días, la de hace 3 queda
  const M = lugar();
  const otra = sesion(M.root, sid(3));
  rastros(M.home);
  const perfil = path.join(M.base, 'team-profile.json');
  fs.writeFileSync(perfil, JSON.stringify({ maintenance: { temp_days: 5 } }));
  const r2 = gancho(M, { env: { TYCON_PROFILE: perfil, TYCON_TEMP_SWEEP_NOW: new Date(Date.now() + 3 * DIA).toISOString() } });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(fs.existsSync(otra), r2.stdout);
  assert.doesNotMatch(r2.stdout, /sesiones del agente que ya no viven/);
});
