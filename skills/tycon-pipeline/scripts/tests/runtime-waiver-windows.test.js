#!/usr/bin/env node
'use strict';
/**
 * runtime-waiver-windows.test.js — la firma del waiver en Windows: una ventana NUEVA, una frase al azar, 5 minutos.
 * Sin esa vía, en Windows no se podría firmar
 * (`marker.js runtime-waiver` frenaría con «requiere /dev/tty» también corrido por la persona en PowerShell) y la story
 * quedaría parada.
 *
 * Acá se ejercita la rama de Windows en cualquier sistema (`TYCON_WAIVER_PLATFORM=win32` y las piezas inyectables de la
 * biblioteca). Lo que sólo se ve en un Windows de verdad —que sin persona la ventana vence y no firma— lo mide el ensayo
 * de Windows (scripts/tests/windows/waiver-probe.js).
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/runtime-waiver-windows.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib', 'runtime-waiver.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const MIGRATE = path.join(SCRIPTS, 'migrate-waivers-to-repo.js');

/** Carga la biblioteca con un ambiente propio (sin el de quien corre la prueba) y lo restituye. */
function conAmbiente(env, fn) {
  const antes = {};
  for (const k of Object.keys(env)) { antes[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try {
    delete require.cache[require.resolve(LIB)];
    return fn(require(LIB));
  } finally {
    for (const k of Object.keys(env)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
    delete require.cache[require.resolve(LIB)];
  }
}
const WIN = { TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: undefined, TYCON_WAIVER_TIMEOUT_S: undefined };
const psDice = (n) => () => ({ status: 0, stdout: `${n}\r\n` });

test('@story-waiver-windows en Mac y Linux nada cambia: sin la marca de plataforma no es Windows y hasTty mira /dev/tty', () => {
  if (process.platform === 'win32') return;
  conAmbiente({ TYCON_WAIVER_PLATFORM: undefined }, (W) => {
    assert.equal(W.esWindows(), false);
    let devTty = true;
    try { fs.closeSync(fs.openSync('/dev/tty', 'r')); } catch { devTty = false; }
    assert.equal(W.hasTty(), devTty, 'la respuesta es la de /dev/tty, como siempre');
  });
});

test('@story-waiver-windows en Windows, sin la marca de la ventana no hay terminal (el agente que lo corre directo)', () => {
  conAmbiente(WIN, (W) => {
    assert.equal(W.esWindows(), true);
    assert.equal(W.hasTty(), false);
    assert.throws(() => W.promptTty('¿? '), /NO_TTY/);
  });
});

test('@story-waiver-windows la marca sola no alcanza: entrada redirigida, consola compartida o sin poder preguntar, no firma', () => {
  conAmbiente({ ...WIN, TYCON_WAIVER_IN_WINDOW: '1' }, (W) => {
    assert.equal(W.enVentana({ stdinIsTTY: false, stdoutIsTTY: true, run: psDice(2) }), false, 'la entrada viene de un caño');
    assert.equal(W.enVentana({ stdinIsTTY: true, stdoutIsTTY: false, run: psDice(2) }), false, 'la salida va a un caño');
    assert.equal(W.enVentana({ stdinIsTTY: true, stdoutIsTTY: true, run: psDice(4) }), false, 'otra consola con más procesos: la del agente');
    assert.equal(W.enVentana({ stdinIsTTY: true, stdoutIsTTY: true, run: psDice(0) }), false, 'sin consola (un proceso desprendido da 0): tampoco');
    assert.equal(W.enVentana({ stdinIsTTY: true, stdoutIsTTY: true, run: psDice(1) }), false);
    assert.equal(W.enVentana({ stdinIsTTY: true, stdoutIsTTY: true, run: () => ({ status: 1, stdout: '' }) }), false, 'sin poder preguntar, no');
    assert.match(W.consolaNueva({ run: () => ({ error: new Error('ENOENT') }) }).motivo, /no pude preguntarle a Windows/);
    assert.equal(W.enVentana({ stdinIsTTY: true, stdoutIsTTY: true, run: psDice(2) }), true, 'la ventana nueva: sola con su PowerShell');
  });
});

test('@story-waiver-windows PowerShell se lanza conectado a la consola y por su ruta del sistema (no oculto, no del repo)', () => {
  // 🔴 Caso cubierto: con windowsHide y sin heredar nada, Node le da a PowerShell una consola propia
  //    oculta y la cuenta daría 1 siempre: nadie firmaría, ni la persona. Y sin ruta, Windows lo busca primero en el repo.
  conAmbiente({ ...WIN, SystemRoot: 'C:\\Windows' }, (W) => {
    let visto = null;
    W.consolaNueva({ pid: 4242, spawnSync: (cmd, args, o) => { visto = { cmd, args, o }; return { status: 0, stdout: '2' }; } });
    assert.match(visto.cmd, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.equal(visto.o.windowsHide, false);
    assert.equal(visto.o.stdio[0], 'inherit', 'hereda la consola de la ventana');
    // 🔴 Caso cubierto: en una ventana nueva de verdad la cuenta da 0 si PowerShell no queda
    //    conectado. Se conecta explícito a la consola de ESTE proceso antes de contar.
    assert.match(visto.args.join(' '), /AttachConsole\(4242\)/);
    assert.match(visto.args.join(' '), /FreeConsole\(\)/);
    // 🔴 Caso cubierto (error 87): `uint[]` no existe en PowerShell 5.1 y la lista quedaría nula.
    assert.match(visto.args.join(' '), /New-Object System\.UInt32\[\] 64/);
    assert.doesNotMatch(visto.args.join(' '), /New-Object uint\[\]/);
    const sinConsola = W.consolaNueva({ run: () => ({ status: 3, stdout: 'SIN-CONSOLA\r\n' }) });
    assert.equal(sinConsola.nueva, false);
    assert.match(sinConsola.motivo, /no tiene una consola/);
  });
});

test('@story-waiver-windows la cuenta viaja por un archivo, y una salida vacía no es «0 conectados»', () => {
  // 🔴 Caso cubierto: con la consola reconectada PowerShell no imprime nada, y '' se leería como
  //    0: la ventana de la persona quedaría como «sin consola» y no firmaría nadie.
  conAmbiente({ ...WIN }, (W) => {
    const vacia = W.consolaNueva({ run: () => ({ status: 0, stdout: '', stderr: 'algo dijo' }) });
    assert.equal(vacia.conectados, null, JSON.stringify(vacia));
    assert.equal(vacia.nueva, false);
    assert.match(vacia.detalle, /algo dijo/);
    const porArchivo = (contenido) => (cmd, args) => {
      const m = args.join(' ').match(/WriteAllText\('([^']+)'/);
      assert.ok(m, 'el guion escribe la cuenta en un archivo');
      fs.writeFileSync(m[1], contenido);
      return { status: 0, stdout: '' };
    };
    assert.equal(W.consolaNueva({ run: porArchivo('2 0') }).nueva, true, 'la ventana nueva, contada en el archivo');
    const cero = W.consolaNueva({ run: porArchivo('0 6') });
    assert.equal(cero.nueva, false);
    assert.equal(cero.error, 6, 'con 0, el código de error de Windows queda a la vista');
  });
});

test('@story-waiver-windows la frase: tres palabras distintas de la lista, y sólo la frase exacta firma', () => {
  conAmbiente(WIN, (W) => {
    for (let i = 0; i < 50; i += 1) {
      const p = W.fraseAlAzar().split(' ');
      assert.equal(p.length, 3);
      assert.equal(new Set(p).size, 3);
      for (const x of p) assert.ok(W.PALABRAS.includes(x));
    }
    const frase = 'gato luna reloj';
    let mostrado = '';
    const resp = (r) => (m) => { mostrado = m; return r; };
    assert.equal(W.confirmarFrase({ frase, prompt: resp('gato luna reloj') }), true);
    assert.ok(mostrado.includes(frase), 'la frase se muestra en la ventana');
    assert.equal(W.confirmarFrase({ frase, prompt: resp('  Gato   LUNA reloj ') }), true, 'mayúsculas y espacios de más no cuentan');
    assert.equal(W.confirmarFrase({ frase, prompt: resp('si') }), false, 'un «si» no firma');
    assert.equal(W.confirmarFrase({ frase, prompt: resp('gato luna') }), false);
    assert.equal(W.confirmarFrase({ frase, prompt: resp('') }), false);
  });
});

test('@story-waiver-windows abrir la ventana: start /wait con el mismo comando, la marca y el archivo del pid; el tope sólo baja', () => {
  conAmbiente(WIN, (W) => {
    let visto = null;
    const r = W.abrirVentana({ script: 'C:\\arnes\\marker.js', args: ['runtime-waiver', 'C:\\repo\\story.md'], spawn: (cmd, a, o) => {
      visto = { cmd, a, o };
      fs.writeFileSync(o.env.TYCON_WAIVER_WINDOW_PROCESS_FILE, '4242');
      return { status: 0 };
    } });
    assert.deepEqual(r, { estado: 'cerrada', codigo: 0 });
    assert.match(visto.a.join(' '), /start "Firma del waiver" \/wait ".*" "C:\\arnes\\marker\.js" "runtime-waiver" "C:\\repo\\story\.md"/);
    assert.equal(visto.o.env.TYCON_WAIVER_IN_WINDOW, '1');
    assert.equal(visto.o.windowsHide, false, 'la ventana tiene que verse');
    assert.equal(visto.o.timeout, 300000);
    assert.equal(fs.existsSync(visto.o.env.TYCON_WAIVER_WINDOW_PROCESS_FILE), false, 'el archivo del pid no queda');
  });
  conAmbiente({ ...WIN, TYCON_WAIVER_TIMEOUT_S: '20' }, (W) => assert.equal(W.topeVentanaS(), 20));
  conAmbiente({ ...WIN, TYCON_WAIVER_TIMEOUT_S: '9999' }, (W) => assert.equal(W.topeVentanaS(), 300, 'nunca sube'));
});

test('@story-waiver-windows vencido el plazo se cierra la ventana (su pid) y no se firma; sin arrancar, «no abrió»', () => {
  conAmbiente(WIN, (W) => {
    let matado = null;
    const vencida = W.abrirVentana({ script: 'm.js', spawn: (c, a, o) => {
      fs.writeFileSync(o.env.TYCON_WAIVER_WINDOW_PROCESS_FILE, '777');
      return { error: Object.assign(new Error('spawnSync cmd.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM' };
    }, kill: (p) => { matado = p; } });
    assert.equal(vencida.estado, 'vencida');
    assert.equal(vencida.pid, 777, 'dice si la ventana llegó a arrancar');
    assert.equal(matado, 777, 'cierra la ventana por su pid');

    const sinArrancar = W.abrirVentana({ script: 'm.js', spawn: () => ({ status: 1 }) });
    assert.equal(sinArrancar.estado, 'no-abrio');
    const comillas = W.abrirVentana({ script: 'C:\\a"b\\m.js', spawn: () => { throw new Error('no se tenía que lanzar'); } });
    assert.equal(comillas.estado, 'no-abrio');
    assert.match(comillas.motivo, /no deja pasar entre comillas/);
    // una barra al final escapa la comilla de cierre y junta dos argumentos: en una ruta, no se lanza
    const barra = W.abrirVentana({ script: 'C:\\arnes\\', spawn: () => { throw new Error('no se tenía que lanzar'); } });
    assert.equal(barra.estado, 'no-abrio');
  });
});

/** Lo que `abrirVentana` le pasa a la consola, con una ventana de mentira que llega a arrancar. */
function abrirConArgs(W, args, opciones = {}) {
  let visto = null;
  const r = W.abrirVentana({ script: 'C:\\arnes\\marker.js', args, env: {}, ...opciones, spawn: (cmd, a, o) => {
    visto = { linea: a.join(' '), env: o.env };
    fs.writeFileSync(o.env.TYCON_WAIVER_WINDOW_PROCESS_FILE, '4242');
    return { status: 0 };
  } });
  return { r, visto };
}

test('@story-waiver-windows un argumento con comillas, %, salto de línea o barra final va por el ambiente, nunca por la línea de cmd', () => {
  conAmbiente(WIN, (W) => {
    for (const dificil of ['{"reason":"arreglo chico","maxFiles":10}', 'subir al 50%', 'dos\nrenglones', 'C:\\repo\\']) {
      const { r, visto } = abrirConArgs(W, ['adhoc', 'set', dificil, '--terminal']);
      assert.deepEqual(r, { estado: 'cerrada', codigo: 0 }, dificil);
      assert.ok(!visto.linea.includes(dificil), `${dificil}: no pasa por cmd`);
      assert.ok(!visto.linea.includes('--terminal'), `${dificil}: ningún argumento queda en la línea, para no partir el comando en dos`);
      assert.match(visto.linea, /start "Firma del waiver" \/wait ".*" "-r" ".*window-args\.js" "C:\\arnes\\marker\.js""?$/);
      assert.deepEqual(JSON.parse(visto.env.TYCON_WAIVER_WINDOW_ARGS), ['adhoc', 'set', dificil, '--terminal']);
      assert.equal(visto.env.TYCON_WAIVER_IN_WINDOW, '1');
    }
  });
});

test('@story-waiver-windows sin caracteres difíciles la línea es la de siempre y no hay variable', () => {
  conAmbiente(WIN, (W) => {
    const { r, visto } = abrirConArgs(W, ['adhoc', 'set', '--reason', 'con espacios y ñ & ^', '--terminal']);
    assert.deepEqual(r, { estado: 'cerrada', codigo: 0 });
    assert.match(visto.linea, /"C:\\arnes\\marker\.js" "adhoc" "set" "--reason" "con espacios y ñ & \^" "--terminal"/);
    assert.ok(!visto.linea.includes('window-args'));
    assert.equal(visto.env.TYCON_WAIVER_WINDOW_ARGS, undefined);
  });
});

test('@story-waiver-windows lo que no se puede pasar por el ambiente no abre: una ruta, otro programa, demasiado largo', () => {
  const nunca = () => { throw new Error('no se tenía que lanzar'); };
  conAmbiente(WIN, (W) => {
    const ruta = W.abrirVentana({ script: 'C:\\a%b\\m.js', args: ['{"x":1}'], env: {}, spawn: nunca });
    assert.equal(ruta.estado, 'no-abrio', 'la ruta del guion sigue pasando por la consola');
    assert.match(ruta.motivo, /no deja pasar entre comillas/);
    const otro = W.abrirVentana({ programa: 'bash', script: 'm.sh', args: ['{"x":1}'], env: {}, spawn: nunca });
    assert.equal(otro.estado, 'no-abrio', 'bash no carga window-args.js');
    assert.match(otro.motivo, /no lo puede leer del ambiente/);
    const largo = W.abrirVentana({ script: 'm.js', args: [`"${'x'.repeat(33000)}`], env: {}, spawn: nunca });
    assert.equal(largo.estado, 'no-abrio');
    assert.match(largo.motivo, /demasiado largos/);
    assert.equal(W.abrirVentana({ programa: 'C:\\Program Files\\nodejs\\node.exe', script: 'm.js', args: ['{"x":1}'], env: {}, spawn: () => ({ status: 1 }) }).motivo, 'la ventana no llegó a arrancar el comando', 'con la ruta de node sí se intenta');
  });
});

/** Corre un guion que imprime lo que recibió, cargado como lo carga la ventana. */
function conCargador(args, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-args-'));
  const guion = path.join(dir, 'guion.js');
  fs.writeFileSync(guion, "console.log(JSON.stringify({ argv: process.argv.slice(1), variable: process.env.TYCON_WAIVER_WINDOW_ARGS === undefined ? null : process.env.TYCON_WAIVER_WINDOW_ARGS, principal: require.main === module }));\n");
  const limpio = { ...process.env };
  delete limpio.TYCON_WAIVER_IN_WINDOW;
  delete limpio.TYCON_WAIVER_WINDOW_ARGS;
  const r = spawnSync(process.execPath, ['-r', path.join(SCRIPTS, 'lib', 'window-args.js'), guion, ...args], { encoding: 'utf8', env: { ...limpio, ...env } });
  return { r, guion, dir };
}

test('@story-waiver-windows dentro de la ventana el guion recibe los argumentos intactos, como si vinieran en la línea', () => {
  const dificiles = ['adhoc', 'set', '{"reason":"50% de \\"todo\\" & ^ ñ","maxFiles":10}', 'dos\nrenglones', 'C:\\repo\\', '--terminal'];
  const { r, guion, dir } = conCargador([], { TYCON_WAIVER_IN_WINDOW: '1', TYCON_WAIVER_WINDOW_ARGS: JSON.stringify(dificiles) });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.argv, [guion, ...dificiles]);
  assert.equal(o.variable, null, 'un proceso hijo no la hereda');
  assert.equal(o.principal, true, 'el guion sigue siendo el programa principal');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('@story-waiver-windows sin la marca de la ventana la variable no agrega nada, y se borra igual', () => {
  const { r, guion, dir } = conCargador(['propio'], { TYCON_WAIVER_WINDOW_ARGS: JSON.stringify(['otro']) });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.argv, [guion, 'propio']);
  assert.equal(o.variable, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('@story-waiver-windows unos argumentos que no se pueden leer cortan: el guion no corre con otro comando', () => {
  for (const malo of ['{roto', '{"no":"lista"}', '[1,2]']) {
    const { r, dir } = conCargador([], { TYCON_WAIVER_IN_WINDOW: '1', TYCON_WAIVER_WINDOW_ARGS: malo });
    assert.equal(r.status, 2, `${malo}: ${r.stdout}`);
    assert.equal(r.stdout, '', `${malo}: el guion no llegó a correr`);
    assert.match(r.stderr, /no se firmó nada/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('@story-waiver-windows los programas del sistema salen de su ruta fija, no de SystemRoot', () => {
  conAmbiente({ ...WIN, SystemRoot: 'C:\\repo\\falso' }, (W) => {
    let visto = null;
    W.abrirVentana({ script: 'm.js', spawn: (cmd) => { visto = cmd; return { status: 1 }; } });
    assert.equal(visto, 'C:\\Windows\\System32\\cmd.exe');
  });
});

test('@story-waiver-windows anotarse escribe sólo el archivo del pid que eligió la ventana, y nunca pisa uno', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiver-anota-'));
  const ajeno = path.join(dir, 'gates.log');
  fs.writeFileSync(ajeno, 'renglón\n');
  conAmbiente({ ...WIN, TYCON_WAIVER_WINDOW_PROCESS_FILE: ajeno }, (W) => W.anotarVentana());
  assert.equal(fs.readFileSync(ajeno, 'utf8'), 'renglón\n', 'un archivo fuera de la forma no se toca');
  const propio = path.join(os.tmpdir(), `tycon-waiver-ventana-1-${process.pid}.pid`);
  fs.writeFileSync(propio, 'otro');
  conAmbiente({ ...WIN, TYCON_WAIVER_WINDOW_PROCESS_FILE: propio }, (W) => W.anotarVentana());
  assert.equal(fs.readFileSync(propio, 'utf8'), 'otro', 'uno que ya existe no se pisa');
  fs.unlinkSync(propio);
  conAmbiente({ ...WIN, TYCON_WAIVER_WINDOW_PROCESS_FILE: propio }, (W) => W.anotarVentana());
  assert.equal(fs.readFileSync(propio, 'utf8'), String(process.pid));
  fs.unlinkSync(propio);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('@story-waiver-windows entrar a la ventana es una vez por proceso: un solo Enter al cerrar', () => {
  const antes = process.listenerCount('exit');
  conAmbiente(WIN, (W) => { W.dentroDeLaVentana(); W.dentroDeLaVentana(); });
  assert.equal(process.listenerCount('exit') - antes, 1);
});

function laboratorio() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'waiver-win-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.9.md');
  fs.writeFileSync(story, ['---', 'story: 9.9', 'status: in-progress', 'runtime_not_verifiable:', '  - ac: 1', '    reason: "x"', '    covered_by: T1', '---', '', '1. algo', ''].join('\n'));
  return { home, repo, story };
}

test('@story-waiver-windows el agente corre el comando con la marca y la respuesta por la entrada: no firma', () => {
  const { home, repo, story } = laboratorio();
  const r = spawnSync(process.execPath, [MARKER, 'runtime-waiver', story], {
    encoding: 'utf8', input: 'si\nsi\ngato luna reloj\n', timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '1', CLAUDE_CODE_SESSION_ID: 'waiver-win-test' },
  });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /BLOQUEADO — en Windows firma sólo la ventana NUEVA/);
  assert.equal(fs.existsSync(path.join(repo, '.tycon', 'runtime-waivers.jsonl')), false, 'no se escribió ninguna firma');
});

test('@story-waiver-windows sin poder abrir la ventana, no firma y lo dice (acá no hay cmd.exe)', () => {
  if (process.platform === 'win32') return;   // en Windows de verdad se abriría: eso lo mide el ensayo
  const { home, repo, story } = laboratorio();
  // la firma en la terminal (--terminal): en Windows abre la ventana nueva; desde la sesión iría por la ventana de permiso
  const r = spawnSync(process.execPath, [MARKER, 'runtime-waiver', story, '--terminal'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '', CLAUDE_CODE_SESSION_ID: 'waiver-win-test' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no pude abrir la ventana de la firma/);
  assert.equal(fs.existsSync(path.join(repo, '.tycon', 'runtime-waivers.jsonl')), false);
});

test('@story-waiver-windows el migrador tampoco firma desde la consola del agente', () => {
  const { home, repo } = laboratorio();
  // una aprobación vieja en el registro de la HOME, para que el migrador tenga algo que firmar y llegue al candado
  const homeLog = path.join(home, 'log.jsonl');
  const lib = require(LIB);
  lib.appendWaiver({ story: '9.9', acs: [1], matrixHash: 'm', approvedBy: 'dev', nowIso: '2026-10-01T00:00:00.000Z',
    declHashByAc: { 1: lib.declHashFor('x', 'T1') }, logPath: homeLog });
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_WAIVER_PLATFORM: 'win32', TYCON_WAIVER_IN_WINDOW: '1', TYCON_WAIVER_LOG: homeLog };
  const seco = spawnSync(process.execPath, [MIGRATE, '--repos', repo], { encoding: 'utf8', timeout: 60000, env });
  assert.match(seco.stdout, /A MIGRAR \(dry-run\): [1-9]/, `el laboratorio tiene algo que migrar: ${seco.stdout}${seco.stderr}`);
  const r = spawnSync(process.execPath, [MIGRATE, '--repos', repo, '--apply'], { encoding: 'utf8', input: 'MIGRAR\n', timeout: 60000, env });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /BLOQUEADO/);
  assert.doesNotMatch(r.stdout, /MIGRADAS:/);
  assert.equal(fs.existsSync(path.join(repo, '.tycon', 'runtime-waivers.jsonl')), false);
});
