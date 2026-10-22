'use strict';
/**
 * node-floor.js — el piso de Node del arnés: lo único que un Node viejo tiene que poder leer.
 *
 * Qué hace. Mira con qué Node arrancó. Con 20 o más, corre el guion acá mismo, como guion principal. Con uno más viejo,
 * lo vuelve a lanzar con el Node propio del arnés (`~/.tycon/node/current`), con los mismos argumentos, la misma entrada
 * y su código de salida. Si el arnés no tiene Node propio, lo dice en una línea y sale: 1 en un comando, 2 en un freno
 * (`--gate`: falla cerrado), y 0 en un hook que no frena, con el aviso una sola vez por sesión.
 *
 * Por qué. Con Node 12 en el PATH, cada hook y cada comando del pipeline moría con un `SyntaxError` antes de poder decir
 * nada, y Claude Code lo toma como un error que no frena: los frenos no corrían y nadie se enteraba.
 *
 * 🔴 Este archivo se escribe con la sintaxis que Node 12 lee: sin `?.`, sin `??`, sin campos de clase. Lo mismo las
 * entradas que lo llaman. Lo comprueba node-old-real.test.sh con un Node 12 de verdad.
 *
 * Tres formas de usarlo:
 *   - la primera línea de un guion que Node 12 lee:   if (require.main === module) require('<…>/node-floor.js').guard();
 *   - la entrada de un guion que Node 12 no lee (su código vive en x-main.js):
 *                               if (require.main === module) require('<…>/node-floor.js').launch(__dirname + '/x-main.js');
 *                               else module.exports = require('./x-main.js');
 *   - un hook registrado sin el Node del arnés:   node "<…>/node-floor.js" [--gate] "<guion>" [args…]
 *
 * `TYCON_NODE_FLOOR_FAKE_VERSION` existe sólo para las pruebas: hace de cuenta que el Node es otro. Con una versión vieja
 * sólo puede volver a lanzar con el Node del arnés o negarse; no abre nada.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var MIN_MAJOR = 20;

function major(version) {
  var m = /^v?(\d+)\./.exec(String(version || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** La casa del arnés: `TYCON_HOME` si vale (absoluta), o `~/.tycon`. Igual que tycon-home.js, sin cargarlo. */
function tyconHome(env) {
  var v = env && env.TYCON_HOME !== undefined ? String(env.TYCON_HOME).trim() : '';
  if (v && path.isAbsolute(v)) return v;
  return path.join(os.homedir(), '.tycon');
}

function harnessBin(env, platform) {
  var current = path.join(tyconHome(env), 'node', 'current');
  return (platform || process.platform) === 'win32' ? path.join(current, 'node.exe') : path.join(current, 'bin', 'node');
}

/** El comando que deja al arnés con su Node y sus hooks al día. */
function repairCommand(env, platform) {
  var tree = path.join(tyconHome(env), 'harness', 'scripts');
  return (platform || process.platform) === 'win32'
    ? 'pwsh -File "' + path.join(tree, 'install-tycon-hooks.ps1') + '"'
    : 'bash "' + path.join(tree, 'install-tycon-hooks.sh') + '"';
}

/**
 * Qué hacer con este Node: `{ action: 'run' }`, `{ action: 'relaunch', bin }` o `{ action: 'fail', line }`.
 */
function decide(o) {
  var env = (o && o.env) || process.env;
  var version = (o && o.version) || process.version;
  if (major(version) >= MIN_MAJOR) return { action: 'run' };
  var bin = harnessBin(env, o && o.platform);
  if (fs.existsSync(bin)) return { action: 'relaunch', bin: bin };
  return {
    action: 'fail',
    line: 'Node ' + String(version).replace(/^v/, '') + ': el arnés necesita Node ' + MIN_MAJOR + ' o más; corré `' + repairCommand(env, o && o.platform) + '`',
  };
}

/**
 * La versión con la que se decide. `TYCON_NODE_FLOOR_FAKE_VERSION` existe para las pruebas y sólo puede BAJAR la versión:
 * con un Node viejo de verdad no hace de cuenta que es nuevo (eso dejaría correr el guion hasta el SyntaxError).
 */
function effectiveVersion(env, real) {
  var fake = env && env.TYCON_NODE_FLOOR_FAKE_VERSION;
  var actual = real || process.version;
  return fake && major(fake) && major(fake) < major(actual) ? fake : actual;
}

/**
 * La entrada del evento, entera, o null si no hay (una terminal). Sin tocar `process.stdin`: abrirlo deja el descriptor
 * sin bloqueo y la lectura corta a mitad (EAGAIN), con lo que un freno relanzado vería un evento trunco.
 * `{ error }` si no se pudo leer: un freno no sigue con una entrada a medias.
 */
function readStdin() {
  try { if (fs.fstatSync(0).isCharacterDevice()) return null; } catch (e) { return null; }
  var chunks = [];
  var buf = Buffer.alloc(65536);
  for (var tries = 0; tries < 200;) {
    var n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e.code === 'EAGAIN') { tries++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; }
      if (e.code === 'EOF') break;
      return { error: e.code || e.message };
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.slice(0, n)));
  }
  return Buffer.concat(chunks);
}

/** El aviso de un hook que no frena: una vez por sesión (o por día, si el evento no trae sesión). */
function firstTimeThisSession(env, input) {
  var sid = null;
  try { sid = JSON.parse(String(input || '')).session_id || null; } catch (e) { sid = null; }
  var key = sid ? String(sid).replace(/[^A-Za-z0-9._-]/g, '_') : 'dia-' + new Date().toISOString().slice(0, 10);
  var dir = path.join(tyconHome(env), 'state', 'node-floor');
  var mark = path.join(dir, key);
  try {
    if (fs.existsSync(mark)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mark, new Date().toISOString() + '\n');
  } catch (e) { /* sin poder anotar, se avisa igual: mejor de más que callado */ }
  return true;
}

/** Corre `mainFile` como guion principal en este proceso. */
function runHere(mainFile, args) {
  process.argv = [process.argv[0], mainFile].concat(args);
  var Module = require('module');
  if (typeof Module.runMain === 'function') Module.runMain(mainFile);
  else Module._load(mainFile, null, true);
}

/**
 * Arranca `mainFile` con el Node que corresponde. `args`: los argumentos del guion (por defecto, los de este proceso).
 * `gate`: es un freno antes de una herramienta. `hook`: es un hook (el aviso de un no-freno sale una vez por sesión).
 */
function launch(mainFile, opts) {
  var o = opts || {};
  var env = process.env;
  var args = o.args || process.argv.slice(2);
  var version = effectiveVersion(env);
  var d = decide({ version: version, env: env });
  if (d.action === 'run') { delete env.TYCON_NODE_FLOOR_RELAUNCHED; return runHere(mainFile, args); }
  return onOldNode(d, mainFile, args, o, version);
}

/**
 * La primera línea de un guion que Node 12 sí puede leer (sus `require` no): con un Node bueno vuelve y el guion sigue;
 * con uno viejo, el guion entero se vuelve a lanzar con el Node del arnés (o se dice) y este proceso termina acá.
 */
function guard(opts) {
  var env = process.env;
  var version = effectiveVersion(env);
  var d = decide({ version: version, env: env });
  // con un Node bueno la marca de relanzado ya cumplió: no se hereda a lo que este guion lance después
  if (d.action === 'run') { delete env.TYCON_NODE_FLOOR_RELAUNCHED; return; }
  // `onlyReexec`: el guion ya dice lo suyo con un Node viejo (harness.js): acá sólo se vuelve a lanzar si hay con qué
  if (d.action === 'fail' && opts && opts.onlyReexec) return;
  onOldNode(d, process.argv[1], process.argv.slice(2), opts || {}, version);
}

function onOldNode(d, mainFile, args, o, version) {
  var env = process.env;
  var shown = String(version).replace(/^v/, '');
  var input = readStdin();
  if (input && input.error) {
    process.stderr.write('Node ' + shown + ': no pude leer la entrada del evento (' + input.error + ')\n');
    process.exit(o.gate ? 2 : 1);
  }
  // ya relanzado una vez y el Node sigue siendo viejo (el «Node del arnés» también lo es): sin bucle, se dice y se sale
  if (d.action === 'relaunch' && env.TYCON_NODE_FLOOR_RELAUNCHED === '1') {
    d = { action: 'fail', line: 'Node ' + shown + ': el Node del arnés también es viejo; corré `' + repairCommand(env) + '`' };
  }
  if (d.action === 'relaunch') {
    // `via`: el hijo vuelve a pasar por el piso (la forma de un hook registrado), así un Node del arnés que también sea
    // viejo se dice y un freno sale cerrado, en vez de morir el guion con un SyntaxError
    var r = childProcess.spawnSync(d.bin, (o.via || []).concat([mainFile]).concat(args), {
      input: input === null ? undefined : input,
      stdio: [input === null ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      env: Object.assign({}, env, { TYCON_NODE_FLOOR_FAKE_VERSION: '', TYCON_NODE_FLOOR_RELAUNCHED: '1' }),
      windowsHide: true,
    });
    // EPIPE: el hijo arrancó y salió sin leer toda la entrada (en Linux, escribírsela falla así). No es una falla al
    // lanzar: cuenta cómo salió el hijo
    if (r.error && !(r.error.code === 'EPIPE' && (r.status !== null || r.signal))) {
      process.stderr.write('Node ' + shown + ': no pude lanzar el Node del arnés (' + (r.error.code || r.error.message) + '); corré `' + repairCommand(env) + '`\n');
      process.exit(o.gate ? 2 : 1);
    }
    if (r.status === null) {
      // cortado por una señal: un freno no queda abierto
      process.stderr.write('Node ' + shown + ': el Node del arnés se cortó (señal ' + (r.signal || '?') + ')\n');
      process.exit(o.gate ? 2 : 1);
    }
    process.exit(r.status);
  }
  if (o.gate) { process.stderr.write(d.line + '\n'); process.exit(2); }
  if (o.hook) {
    if (firstTimeThisSession(env, input)) process.stderr.write(d.line + '\n');
    process.exit(0);
  }
  process.stderr.write(d.line + '\n');
  process.exit(1);
}

module.exports = { MIN_MAJOR: MIN_MAJOR, major: major, decide: decide, effectiveVersion: effectiveVersion, harnessBin: harnessBin, repairCommand: repairCommand, launch: launch, guard: guard };

// Un hook registrado sin el Node del arnés: node node-floor.js [--gate] <guion> [args…]
if (require.main === module) {
  var argv = process.argv.slice(2);
  var gate = false;
  if (argv[0] === '--gate') { gate = true; argv.shift(); }
  var script = argv.shift();
  if (!script) { process.stderr.write('node-floor.js: falta el guion\n'); process.exit(gate ? 2 : 1); }
  launch(path.resolve(script), { args: argv, gate: gate, hook: true, via: [__filename].concat(gate ? ['--gate'] : []) });
}
