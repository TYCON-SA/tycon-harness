#!/usr/bin/env node
'use strict';
/**
 * runtime-waiver-windows.test.js — la firma del waiver en Windows: una ventana NUEVA, una frase al azar, 5 minutos
 * (decisión del dueño, 2026-10-15, opción A). Caso disparador: un dev del equipo en Windows no podía firmar nunca
 * (`marker.js runtime-waiver` frenaba con «requiere /dev/tty» también corrido por la persona en PowerShell) y su story
 * quedó parada.
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
  // 🔴 rojo previo (revisión adversarial): con windowsHide y sin heredar nada, Node le daba a PowerShell una consola propia
  //    oculta y la cuenta daba 1 siempre: nadie firmaba, ni la persona. Y sin ruta, Windows lo busca primero en el repo.
  conAmbiente({ ...WIN, SystemRoot: 'C:\\Windows' }, (W) => {
    let visto = null;
    W.consolaNueva({ pid: 4242, spawnSync: (cmd, args, o) => { visto = { cmd, args, o }; return { status: 0, stdout: '2' }; } });
    assert.match(visto.cmd, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.equal(visto.o.windowsHide, false);
    assert.equal(visto.o.stdio[0], 'inherit', 'hereda la consola de la ventana');
    // 🔴 rojo previo (ensayo de Windows 13585): en una ventana nueva de verdad la cuenta dio 0 — PowerShell no quedaba
    //    conectado. Se conecta explícito a la consola de ESTE proceso antes de contar.
    assert.match(visto.args.join(' '), /AttachConsole\(4242\)/);
    assert.match(visto.args.join(' '), /FreeConsole\(\)/);
    const sinConsola = W.consolaNueva({ run: () => ({ status: 3, stdout: 'SIN-CONSOLA\r\n' }) });
    assert.equal(sinConsola.nueva, false);
    assert.match(sinConsola.motivo, /no tiene una consola/);
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
  });
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
  const r = spawnSync(process.execPath, [MARKER, 'runtime-waiver', story], {
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
