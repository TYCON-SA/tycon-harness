'use strict';
/**
 * runtime-waiver.js — la ÚNICA puerta para saltear la verificación runtime por-AC
 * (DODRT-C6), y es USER-ONLY por construcción física, no por regla.
 *
 * Objetivo: el pipeline OBLIGA al agente a correr
 * los tests de cada AC; NO puede delegárselos al usuario. El único "obviar" lo decide
 * el humano — y sólo el humano.
 *
 * La asimetría que lo hace user-only: este proceso (el agente) corre SIN terminal
 * controladora — `open("/dev/tty")` devuelve ENXIO ("Device not configured"), verificado
 * empíricamente. El usuario, sentado en su terminal, SÍ puede abrir /dev/tty.
 * `promptTty()` abre /dev/tty y lee la confirmación de AHÍ (no de stdin, que el agente sí
 * controla). Sin terminal → tira. El agente no puede satisfacerlo.
 *
 * ⚠️ LÍMITE HONESTO — hasta dónde llega y hasta dónde NO (este bloque NO puede sobre-vender
 * la garantía, que es el pecado que todo esto combate):
 *
 *   El agente corre con el MISMO UID y tiene Bash + el código fuente de este archivo. El hash-chain
 *   es SHA-256 SIN clave (keyless): no es un secreto, cualquiera que lea este archivo lo recalcula.
 *
 *   🔴 La cadena se lee como ÁRBOL, no como lista: cada entrada vale si engancha con ALGUNA entrada anterior válida del
 *   mismo archivo, o con el vacío (raíz). Y cada firma nueva se escribe como raíz. Con una lista, dos ramas
 *   que firman en paralelo enganchan con la misma línea y al unirlas la segunda deja de enganchar con
 *   la anterior: desde ahí toda firma se descartaría en silencio y la matriz diría «esperan waiver». Una
 *   lista lineal es un árbol, así que los registros existentes se leen igual, bit a bit.
 *
 *   QUÉ FRENA (detecta y descarta): una línea agregada o cambiada a mano sin recalcular su `chain`
 *     (inventada, copiada de otra con otro contenido, o editada); una línea que engancha con otra que vino
 *     DESPUÉS en el archivo; todo lo que cuelga de una entrada descartada; una línea que no es JSON.
 *   QUÉ NO FRENA: una firma fabricada A PROPÓSITO. El agente puede reimplementar `sha()` +
 *     `canonical()` (son estas ~4 líneas) y escribir una entrada con el chain correcto.
 *     NO hay forma de impedirlo con hashing keyless.
 *   ACEPTADO: (a) una línea idéntica a otra válida vale (duplicada al unir ramas, o copiada); (b) una
 *     firma que se borró y se vuelve a pegar tal cual vuelve a valer — borrar una línea NO revoca una firma,
 *     lo que la vence es cambiar la declaración del AC (su `declHash`); (c) una raíz copiada de otro registro
 *     vale, y sólo aprueba un AC cuya story y declaración coincidan letra por letra con lo que un humano
 *     aprobó. Ninguna de las tres aprueba algo que un humano no haya aprobado desde su terminal.
 *
 *   No existe una llave que el agente no pueda leer en este modelo (mismo UID: un archivo 0600 lo
 *   leo; root/Keychain-con-Touch-ID lo tendría que montar el USUARIO). Así que la garantía REAL es:
 *   (a) NO hay vía cómoda/accidental — no hay ack agent-writable, DOD_BYPASS/set-check/flags
 *       están cerrados; la ÚNICA vía SANCIONADA es el comando TTY que el agente no puede ejecutar.
 *   (b) Cada waiver se pinnea al `matrixHash`: si el código/evidencia cambian, deja de aplicar solo.
 *   (c) Una forja deliberada es un ACTO FLAGRANTE Y VISIBLE en el transcript (reimplementar crypto
 *       para escribir `approvedBy:"<humano>", tty:true` sin que el humano haya aprobado = mentir
 *       explícitamente en el log). No es prevención criptográfica; es "no-conveniente + a la vista".
 *
 *   Para prevención dura de verdad haría falta firma con secreto fuera del alcance del UID del
 *   agente (p.ej. Keychain con Touch-ID interactivo) — lo tendría que configurar el usuario.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir: stateDirOf } = require('./state-dir.js');   // la carpeta del estado, de una sola pieza
const crypto = require('crypto');

const STATE_DIR = path.join(stateDirOf(os.homedir()));
// Path resuelto en CADA llamada (no cacheado a nivel módulo) para que los tests puedan
// aislar el log vía TYCON_WAIVER_LOG sin ensuciar el real. En producción esa env no existe.
function waiverLogPath() {
  return process.env.TYCON_WAIVER_LOG || path.join(STATE_DIR, 'runtime-waivers.jsonl');
}

// 🔴 El log firmado también vive DENTRO del repo, y ése es el que viaja.
// El del home sigue existiendo (compatibilidad con lo ya aprobado ahí) y se lee como
// segunda fuente, pero lo nuevo se escribe acá para que la aprobación del humano llegue a
// las otras máquinas y al CI junto con el código que aprueba.
function repoWaiverLogPath(repoRoot) {
  return path.join(repoRoot, '.tycon', 'runtime-waivers.jsonl');
}

/**
 * Hash de la DECLARACIÓN de un AC no-ejercitable: su `reason` + el test que lo cubre, tal
 * como están en el frontmatter `runtime_not_verifiable` de la story.
 *
 * Es el anclaje CORRECTO de un waiver, y reemplaza al `matrixHash` para lo nuevo. El
 * `matrixHash` pinnea los veredictos + las refs de evidencia de TODOS los ACs — evidencia que
 * vive en `.advisors/` (gitignoreado), así que en otra máquina o en CI no existe, el hash da
 * distinto y el waiver no engancha. Pero lo que el humano aprobó no fue el estado de la
 * evidencia: fue que ESE AC no se puede ejercer corriendo. Eso vive en la story, viaja con el
 * repo y es idéntico en toda máquina. Y se vence exactamente cuando debe: si alguien reescribe
 * la justificación, hay que volver a mirarlo.
 */
function declHashFor(reason, coveredBy) {
  return sha(JSON.stringify([String(reason ?? '').trim(), String(coveredBy ?? '').trim()])).slice(0, 16);
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Contenido canónico de un waiver para el hash-chain (excluye el propio campo `chain`).
// 🔴 `declHashByAc` entra al canónico SÓLO si existe: así las entries ya firmadas con el
// formato viejo siguen verificando bit a bit (agregarlo incondicionalmente rompería la cadena
// entera y dejaría sin efecto todo lo ya aprobado).
function canonical(e) {
  const base = [e.ts, String(e.story), [...e.acs].sort((a, b) => a - b), e.matrixHash, e.approvedBy || null];
  if (e.declHashByAc !== undefined) {
    base.push(Object.keys(e.declHashByAc).sort((a, b) => Number(a) - Number(b)).map((k) => [Number(k), e.declHashByAc[k]]));
  }
  // la firma con el ok de una persona escrito en el chat (sin terminal) lleva el ok adentro del hash; las
  // firmas por terminal no lo traen y siguen verificando igual
  if (e.ok !== undefined) base.push([e.tty === true, e.ok]);
  return JSON.stringify(base);
}

// ── WINDOWS: la firma vive en una VENTANA NUEVA ─────────────────────────
// En Windows nativo no hay /dev/tty: el candado de arriba frenaría SIEMPRE, también a la persona en PowerShell, y una story
// con `runtime_not_verifiable` quedaría sin salida. Leer la consola propia (CONIN$) no sirve:
// los procesos del agente en Windows suelen tener una consola OCULTA adjunta, así que abriría y quedaría esperando teclas que
// nadie ve (o que el agente inyecta). Lo que se hace:
//   1. el comando, en Windows, se vuelve a lanzar a sí mismo en una ventana de consola NUEVA y visible (`start … /wait`);
//   2. sólo ahí firma: el proceso de la ventana exige la marca de la ventana, su entrada y salida en la consola, y una
//      consola NUEVA de verdad —a la que no está conectado ningún otro proceso del que la abrió—;
//   3. antes de firmar pide escribir una frase al azar de 3 palabras que sólo se muestra en esa ventana;
//   4. el que la abrió espera hasta 5 minutos; vencido el plazo cierra la ventana y no se firma nada.
// El MISMO nivel de garantía que en Mac (ver «LÍMITE HONESTO» arriba): el agente puede ABRIR la ventana —aparece en el
// escritorio de la persona—, pero no escribir en ella sin un acto evidente (conectarse a esa consola e inyectar teclas,
// como envolver el comando con `script` en Mac). Mac y Linux no cambian.
const VENTANA_TOPE_S = 300;
const MARCA_VENTANA = 'TYCON_WAIVER_IN_WINDOW';
const PALABRAS = Object.freeze(['arbol', 'barco', 'campo', 'dedo', 'faro', 'gato', 'hielo', 'isla', 'jarra', 'lago',
  'mano', 'nube', 'oro', 'pato', 'queso', 'rio', 'sol', 'tren', 'uva', 'vela', 'mesa', 'llave', 'luna', 'piedra', 'pan',
  'reloj', 'silla', 'torre', 'vaso', 'zorro', 'canto', 'brisa', 'cobre', 'duna', 'flor', 'gota', 'humo', 'lana', 'miel',
  'nieve', 'ola', 'perla', 'rama', 'sal', 'tinta', 'valle', 'yeso', 'cuerda']);

/** ¿Esta corrida es la de Windows? `TYCON_WAIVER_PLATFORM` existe sólo para que las pruebas ejerciten la rama en Mac. */
// 🔴 En un Windows de verdad la variable NO vale: con `TYCON_WAIVER_PLATFORM=linux` volvería a la rama de
//    /dev/tty, que Windows lee como el archivo `C:\dev\tty` —el agente lo puede crear y escribirle «si»—, sin la frase.
function esWindows() {
  if (process.platform === 'win32') return true;
  return process.env.TYCON_WAIVER_PLATFORM === 'win32';
}

/** Un programa del sistema por su ruta entera: sin ruta, Windows lo busca primero en la carpeta actual (el repo, que
 *  controla el agente) y un `powershell.exe` de mentira que diga «2» saltaría el control de la consola. */
function delSistema(...partes) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...partes);
}

/**
 * ¿La consola de este proceso es NUEVA, sin otro proceso conectado? Se pregunta a Windows (GetConsoleProcessList) con
 * PowerShell, que al correr se conecta a la misma consola: en una ventana recién abierta por el arnés la lista trae dos
 * procesos (éste y ese PowerShell); en la consola del agente aparecen además su intérprete y lo que lanzó. Sin poder
 * preguntar, no: «no pude mirar» no es «está sola». `opts.run` sólo para las pruebas.
 */
function consolaNueva(opts = {}) {
  // 🔴 PowerShell tiene que CONECTARSE a esta consola: con `windowsHide` y sin heredar nada, Node le da una consola propia
  //    oculta y la cuenta da 1 siempre — nadie podría firmar, tampoco la persona. Hereda la entrada, que
  //    acá es la consola de la ventana (enVentana ya comprobó que lo es), y no pide ventana oculta.
  const sp = opts.spawnSync || require('child_process').spawnSync;
  const run = opts.run || ((cmd, args) => sp(cmd, args, { encoding: 'utf8', windowsHide: false, timeout: 30000, stdio: ['inherit', 'pipe', 'pipe'] }));
  // 🔴 PowerShell se conecta EXPLÍCITO a la consola de este proceso (FreeConsole + AttachConsole(pid)) antes de contar:
  //    si no, en una ventana nueva de verdad la cuenta da 0 (no queda conectado a esa consola).
  //    La cuenta es la de NUESTRA consola, la arme Node como la arme. Sin consola a la que conectarse, no hay cuenta.
  const pid = opts.pid || process.pid;
  // 🔴 Con la consola reconectada, PowerShell puede no imprimir nada, y una salida vacía se leería como
  //    «0 conectados». La cuenta viaja por un archivo (no depende de adónde quedó apuntando la salida) y sólo vale un
  //    número escrito: sin número, «no pude preguntar», con lo que PowerShell haya dicho.
  const archivo = path.join(os.tmpdir(), `tycon-waiver-consola-${process.pid}-${Date.now()}.txt`);
  const ps = 'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class C { '
    + '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); '
    + '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p); '
    + '[DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList(uint[] l, uint n); }\'; '
    + `[C]::FreeConsole() | Out-Null; if (-not [C]::AttachConsole(${Number(pid)})) { 'SIN-CONSOLA'; exit 3 }; `
    // 🔴 `uint[]` no existe en el PowerShell de Windows (5.1; el atajo `uint` existe desde PowerShell 6.2): New-Object falla, la lista
    //    queda nula y Windows rechaza la pregunta (error 87, parámetro inválido).
    + '$l = New-Object System.UInt32[] 64; $n = [C]::GetConsoleProcessList($l, 64); '
    + '$e = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); '
    + `[IO.File]::WriteAllText('${archivo.replace(/'/g, "''")}', "$n $e"); $n`;
  const leerNumero = (texto) => {
    const m = String(texto || '').match(/^\s*(\d+)(?:\s+(\d+))?\s*$/m);
    return m ? { n: Number(m[1]), error: m[2] !== undefined ? Number(m[2]) : null } : null;
  };
  let detalle = '';
  for (const exe of [delSistema('WindowsPowerShell', 'v1.0', 'powershell.exe')]) {
    try { fs.unlinkSync(archivo); } catch { /* lo normal: no existe */ } // uno dejado de antemano no cuenta
    const r = run(exe, ['-NoProfile', '-NonInteractive', '-Command', ps]);
    let escrito = null;
    try { escrito = fs.readFileSync(archivo, 'utf8'); } catch { /* PowerShell no llegó a escribirlo */ }
    try { fs.unlinkSync(archivo); } catch { /* no estaba */ }
    if (r && r.status === 3 && /SIN-CONSOLA/.test(String(r.stdout || ''))) return { nueva: false, conectados: 0, motivo: 'este proceso no tiene una consola a la que conectarse' };
    detalle = `${String((r && r.stdout) || '').trim()} ${String((r && r.stderr) || '').trim()}`.trim().slice(0, 300);
    if (!r || r.error || r.status !== 0) continue;
    const leido = leerNumero(escrito) || leerNumero(r.stdout);
    // exactamente 2: éste y el PowerShell que pregunta. 0 o 1 = este proceso no tiene consola (un proceso desprendido
    // devuelve 0): tampoco es la ventana. 3 o más = la consola es de alguien más (la del agente, con su intérprete).
    if (leido) return Object.assign({ nueva: leido.n === 2, conectados: leido.n }, leido.n === 0 && leido.error ? { error: leido.error } : {});
  }
  return Object.assign({ nueva: false, conectados: null, motivo: 'no pude preguntarle a Windows qué procesos usan esta consola (PowerShell no contestó)' }, detalle ? { detalle } : {});
}

/** ¿Esta corrida es la de la ventana nueva? Marca + entrada y salida en una consola + consola sin nadie más. Se
 *  pregunta una vez por proceso (cada pregunta a Windows lanza un PowerShell); con `opts` (las pruebas), siempre. */
let enVentanaCache = null;
function enVentana(opts = {}) {
  if (process.env[MARCA_VENTANA] !== '1') return false;
  const sinOpts = Object.keys(opts).length === 0;
  if (sinOpts && enVentanaCache !== null) return enVentanaCache;
  const r = enVentanaSinCache(opts);
  if (sinOpts) enVentanaCache = r;
  return r;
}
function enVentanaSinCache(opts) {
  const stdin = opts.stdinIsTTY !== undefined ? opts.stdinIsTTY : process.stdin.isTTY === true;
  const stdout = opts.stdoutIsTTY !== undefined ? opts.stdoutIsTTY : process.stdout.isTTY === true;
  if (!stdin || !stdout) return false;
  return consolaNueva(opts).nueva;
}

/** La frase al azar: 3 palabras distintas de la lista. `rnd` sólo para las pruebas. */
function fraseAlAzar(rnd = (n) => require('crypto').randomInt(n)) {
  const elegidas = [];
  while (elegidas.length < 3) {
    const p = PALABRAS[rnd(PALABRAS.length)];
    if (!elegidas.includes(p)) elegidas.push(p);
  }
  return elegidas.join(' ');
}
const normalizarFrase = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * La última confirmación en Windows: muestra una frase al azar y pide escribirla tal cual. Devuelve true sólo si coincide.
 * `opts.prompt` y `opts.frase` sólo para las pruebas.
 */
function confirmarFrase(opts = {}) {
  const frase = opts.frase || fraseAlAzar();
  const prompt = opts.prompt || promptTty;
  const escrito = prompt(`\nPara firmar, escribí estas tres palabras tal como están:\n\n    ${frase}\n\n> `);
  return normalizarFrase(escrito) === normalizarFrase(frase);
}

/** En la ventana, antes de cerrarse: que la persona alcance a leer el resultado (el tope del que la abrió igual corre). */
function pausaFinal() {
  if (!esWindows() || process.env[MARCA_VENTANA] !== '1' || process.stdin.isTTY !== true) return;
  // aunque la ventana no haya pasado el control: que la persona lea POR QUÉ no se firmó antes de que se cierre
  try {
    fs.writeSync(1, '\n(Enter para cerrar esta ventana) ');
    const one = Buffer.alloc(1);
    for (;;) { const n = fs.readSync(0, one, 0, 1, null); if (n === 0 || one[0] === 0x0a) break; }
  } catch { /* sin consola: nada que esperar */ }
}

/** El tope de la ventana en segundos: 300, o menos si `TYCON_WAIVER_TIMEOUT_S` lo baja (nunca lo sube). */
function topeVentanaS() {
  const env = Number(process.env.TYCON_WAIVER_TIMEOUT_S);
  return Number.isFinite(env) && env > 0 ? Math.min(env, VENTANA_TOPE_S) : VENTANA_TOPE_S;
}

/**
 * Abre la ventana nueva y espera. `script` y `args` son lo que corre adentro (el mismo comando). Devuelve
 * `{ estado: 'cerrada', codigo }`, `{ estado: 'vencida' }` (pasó el tope: se la cerró, no se firmó nada) o
 * `{ estado: 'no-abrio', motivo }`. `opts.spawn` y `opts.kill` sólo para las pruebas.
 */
function abrirVentana({ script, args = [], titulo = 'Firma del waiver', spawn, kill } = {}) {
  const cp = require('child_process');
  const todo = [process.execPath, script, ...args];
  const malo = todo.find((a) => /["%\r\n]/.test(String(a)));
  if (malo) return { estado: 'no-abrio', motivo: `una ruta trae un carácter que la consola de Windows no deja pasar entre comillas (${malo})` };
  const pidFile = path.join(os.tmpdir(), `tycon-waiver-ventana-${process.pid}-${Date.now()}.pid`);
  const linea = `start "${titulo}" /wait ${todo.map((a) => `"${a}"`).join(' ')}`;
  const tope = topeVentanaS();
  const correr = spawn || ((cmd, a, o) => cp.spawnSync(cmd, a, o));
  const r = correr(delSistema('cmd.exe'), ['/d', '/s', '/c', `"${linea}"`], {
    windowsVerbatimArguments: true, windowsHide: false, stdio: 'inherit', timeout: tope * 1000,
    env: { ...process.env, [MARCA_VENTANA]: '1', TYCON_WAIVER_WINDOW_PROCESS_FILE: pidFile },
  });
  const vencida = r && r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
  let pid = null;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { /* la ventana no llegó a anotarse */ }
  try { fs.unlinkSync(pidFile); } catch { /* ya no estaba */ }
  if (vencida) {
    if (pid) (kill || ((p) => cp.spawnSync(delSistema('taskkill.exe'), ['/PID', String(p), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })))(pid);
    return { estado: 'vencida', tope, pid };
  }
  if (!r || r.error) return { estado: 'no-abrio', motivo: r && r.error ? r.error.message : 'sin respuesta de la consola' };
  if (!pid) return { estado: 'no-abrio', motivo: 'la ventana no llegó a arrancar el comando', codigo: r.status };
  return { estado: 'cerrada', codigo: r.status };
}

/** Lo primero que hace el proceso de la ventana: anotarse, para que el que la abrió la pueda cerrar al vencer el plazo. */
function anotarVentana() {
  const f = process.env.TYCON_WAIVER_WINDOW_PROCESS_FILE;
  if (f) { try { fs.writeFileSync(f, String(process.pid)); } catch { /* sin anotarse, el plazo igual cierra el comando */ } }
}

// ¿Hay una terminal interactiva real? open(/dev/tty) es no-bloqueante: falla YA con
// ENXIO si no hay terminal controladora (caso del agente). No hace falta leer nada.
// En Windows: sólo la ventana nueva (ver arriba).
function hasTty() {
  if (esWindows()) return enVentana();
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r'); } catch { return false; }
  try { fs.closeSync(fd); } catch { /* ignore */ }
  return true;
}

// Prompt + lectura de UNA línea DESDE /dev/tty (no stdin). Tira si no hay terminal.
// En Windows, dentro de la ventana nueva: de su consola (la entrada y salida estándar de esa ventana).
function promptTty(message) {
  if (esWindows()) {
    if (!enVentana()) throw new Error('NO_TTY: en Windows este comando firma sólo en la ventana nueva que abre él mismo. El agente no puede ejecutarlo — lo corre el usuario.');
    fs.writeSync(1, message);
    const bytes = [];
    const one = Buffer.alloc(1);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let n;
      try { n = fs.readSync(0, one, 0, 1, null); } catch { break; }
      if (n === 0 || one[0] === 0x0a) break;
      if (one[0] !== 0x0d) bytes.push(one[0]);
    }
    return Buffer.from(bytes).toString('utf8').trim();
  }
  let wfd;
  try { wfd = fs.openSync('/dev/tty', 'w'); } catch (e) {
    throw new Error('NO_TTY: este comando requiere una terminal interactiva real. El agente no puede ejecutarlo — lo corre el usuario.');
  }
  fs.writeSync(wfd, message);
  fs.closeSync(wfd);

  const rfd = fs.openSync('/dev/tty', 'r'); // ya sabemos que hay tty (el write funcionó)
  const bytes = [];
  const one = Buffer.alloc(1);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let n;
    try { n = fs.readSync(rfd, one, 0, 1, null); } catch { break; }
    if (n === 0) break;
    if (one[0] === 0x0a) break; // \n
    if (one[0] !== 0x0d) bytes.push(one[0]); // ignora \r
  }
  fs.closeSync(rfd);
  return Buffer.from(bytes).toString('utf8').trim();
}

// Las líneas no vacías con su número FÍSICO (contado desde 1), para que un aviso pueda decir «archivo:línea».
// Sin la marca de orden de bytes que agregan algunos editores de Windows: pegada a la primera línea, rompe su
// JSON y, como todo cuelga de ahí, descartaría el registro entero.
function readNumberedLines(logPath) {
  let raw;
  try { raw = fs.readFileSync(logPath || waiverLogPath(), 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = [];
  raw.split('\n').forEach((l, i) => { const text = l.replace(/\r$/, ''); if (text) out.push({ text, line: i + 1 }); });
  return out;
}

// Verifica la cadena de hashes, leída como ÁRBOL. Devuelve
// { ok, entries, brokenAt, total, discarded }:
//   - `entries`: las válidas, en orden del archivo (lo que leían todos los llamadores, sin cambios).
//   - `brokenAt`: índice (entre las líneas no vacías, como siempre) de la primera descartada, o -1.
//   - `discarded`: [{ line, entry|null, motivo }] con la línea FÍSICA desde 1 y el motivo:
//       json                  no es JSON
//       cuelga-de-descartada  su padre es una línea descartada
//       padre-posterior       su padre está más abajo en el archivo
//       sin-padre             ninguna línea ni el vacío dan su chain: la editaron, o su padre ya no está
function verifyChain(logPath) {
  const lines = readNumberedLines(logPath);
  const parsed = lines.map(({ text, line }) => { try { return { e: JSON.parse(text), line }; } catch { return { e: null, line }; } });
  // Una línea que no tiene la forma de una firma se descarta como `json`, nunca hace caer al lector: una sola línea
  // así tumbaría la lectura entera, y con ella todas las firmas del registro.
  const linkOf = (padre, e) => { try { return sha(padre + canonical(e)).slice(0, 16); } catch { return null; } };
  const tieneForma = (e) => !!e && typeof e === 'object' && Array.isArray(e.acs)
    && (e.declHashByAc === undefined || (e.declHashByAc !== null && typeof e.declHashByAc === 'object'))
    && linkOf('', e) !== null;
  const validChains = new Set();
  const validIdx = new Set();
  const entries = [];
  const pendientes = [];
  parsed.forEach(({ e }, i) => {
    if (!tieneForma(e)) { pendientes.push(i); return; }
    let ok = e.chain === linkOf('', e);
    if (!ok) for (const p of validChains) { if (e.chain === linkOf(p, e)) { ok = true; break; } }
    if (ok) { validChains.add(e.chain); validIdx.add(i); entries.push(e); } else pendientes.push(i);
  });
  // El motivo de cada descartada se busca contra TODAS las líneas (el padre puede estar descartado o más abajo).
  const discarded = pendientes.map((i) => {
    const { e, line } = parsed[i];
    // La entrada leída se conserva aunque no tenga forma de firma: así se sabe de qué story es y el aviso la ve.
    if (!tieneForma(e)) return { line, entry: e && typeof e === 'object' && !Array.isArray(e) ? e : null, motivo: 'json' };
    let motivo = 'sin-padre';
    for (let j = 0; j < parsed.length; j++) {
      const p = parsed[j].e;
      if (j === i || !p || typeof p.chain !== 'string' || e.chain !== linkOf(p.chain, e)) continue;
      motivo = j > i ? 'padre-posterior' : (validIdx.has(j) ? 'sin-padre' : 'cuelga-de-descartada');
      break;
    }
    return { line, entry: e, motivo };
  });
  return { ok: discarded.length === 0, entries, brokenAt: pendientes.length ? pendientes[0] : -1, total: lines.length, discarded };
}

// Escribe un waiver TTY-confirmado con hash-chain. Sólo lo llama el comando marker.js
// runtime-waiver, DESPUÉS de que promptTty() confirmó al humano.
function appendWaiver({ story, acs, matrixHash, approvedBy, nowIso, declHashByAc, logPath, migratedFrom, ok }) {
  const destino = logPath || waiverLogPath();
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  // 🔴 La firma nueva va SIN padre (raíz). Si enganchara con la última línea, un revert
  // (la línea sale), un cherry-pick con la unión deduplicada (queda antes que su padre) o una línea rota más
  // arriba la descartarían. El `chain` de una raíz es el hash de su propio contenido: editarla se sigue viendo.
  const prev = '';
  const e = { ts: nowIso, story: String(story), acs: [...acs].sort((a, b) => a - b), matrixHash, approvedBy: approvedBy || null, tty: true };
  if (declHashByAc !== undefined) e.declHashByAc = declHashByAc;
  if (migratedFrom !== undefined) e.migratedFrom = migratedFrom;
  // firmada fuera de la terminal (en la ventana de permiso; las viejas, con el ok escrito en el chat): `tty` queda en
  // false y `ok` dice quién y cómo (las viejas, también con qué palabras y a qué hora)
  if (ok !== undefined) { e.tty = false; e.ok = ok; }
  e.chain = sha(prev + canonical(e)).slice(0, 16);
  // Si el archivo quedó sin salto final (recortado a mano en un editor, o una resolución de conflicto), la firma nueva
  // se pegaría a la última línea y se perderían las dos, sin aviso.
  let sep = '';
  try { const st = fs.statSync(destino); if (st.size > 0) { const fd = fs.openSync(destino, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd); if (b[0] !== 0x0a) sep = '\n'; } } catch { /* no existe todavía: nada que separar */ }
  fs.appendFileSync(destino, sep + JSON.stringify(e) + '\n', 'utf8');
  return e;
}

// Set de ACs waiveados para (story, matrixHash) — SÓLO cuenta una entry válida de la cadena
// (engancha con alguna anterior válida, o es raíz). Un waiver cuyo matrixHash no
// matchea el actual NO cuenta (drift).
/**
 * ACs waiveados para una story. Dos formas de llamarla, a propósito:
 *
 *   waivedAcs(story, 'matrixHash')                              ← firma vieja, sigue viva
 *   waivedAcs(story, { matrixHash, declHashByAc, repoRoot })    ← firma nueva
 *
 * Un AC cuenta como waiveado si hay una entry con cadena INTACTA que lo cubra y que enganche
 * por alguna de las dos vías:
 *   (a) por DECLARACIÓN — `declHashByAc[ac]` de la entry coincide con el de la story HOY.
 *       Es machine-independent: viaja con el repo y vale en cualquier máquina y en CI.
 *   (b) por matrixHash — formato viejo, sólo válido en la máquina donde se aprobó.
 *
 * Se leen DOS logs: el del repo (`.tycon/runtime-waivers.jsonl`, commiteado) y el del home
 * (legacy). Cada uno con su propia cadena — una entrada descartada invalida lo que cuelga de ella
 * EN ESE archivo, no en el otro (la cadena se lee como árbol).
 *
 * `story` es la CLAVE de la story (`lib/evidence-key.js`), no el número a secas: con número único son
 * lo mismo, así que las firmas vigentes no cambian; con número repetido es `<tema>__<número>`. Quien computa la
 * matriz pregunta por la clave, y por el número solo únicamente para nombrar las firmas viejas que ya no cuentan.
 */
// La declaración que la entrada ancló para el AC `n`. Las claves se comparan por NÚMERO, como las normaliza
// `canonical()`: si no, renombrar «3» a «03» dejaría el `chain` válido y la entrada caería al camino viejo por
// matrixHash, salteando el anclaje a la declaración.
function declDeLaEntrada(e, n) {
  if (!e.declHashByAc || typeof e.declHashByAc !== 'object') return undefined;
  for (const k of Object.keys(e.declHashByAc)) if (Number(k) === Number(n)) return e.declHashByAc[k];
  return undefined;
}

function waivedAcs(story, arg2) {
  const opts = typeof arg2 === 'string' || arg2 === undefined ? { matrixHash: arg2 } : arg2;
  const matrixHash = opts.matrixHash;
  const declHashByAc = opts.declHashByAc || {};
  const logs = [];
  if (opts.repoRoot) logs.push(repoWaiverLogPath(opts.repoRoot));
  logs.push(waiverLogPath());

  const out = new Set();
  for (const log of logs) {
    const { entries } = verifyChain(log); // sólo el prefijo con cadena válida
    for (const e of entries) {
      if (String(e.story) !== String(story)) continue;
      const porMatrix = matrixHash !== undefined && e.matrixHash === matrixHash;
      for (const n of e.acs) {
        const declEntry = declDeLaEntrada(e, n);
        if (declEntry !== undefined) {
          // 🔴 La entry declara anclaje por justificación → ÉSE manda, y el matrixHash NO lo
          // rescata. Si no fuera así, en la máquina donde se aprobó (donde el matrixHash sigue
          // matcheando) reescribir la razón no vencería nada — que es justo lo que el anclaje
          // por justificación existe para lograr.
          if (declHashByAc[n] !== undefined && declEntry === declHashByAc[n]) out.add(n);
          continue;
        }
        if (porMatrix) out.add(n); // entry legacy (sin declaración): sigue valiendo
      }
    }
  }
  return out;
}

/**
 * Las firmas DESCARTADAS de una story — lo que la matriz tiene que NOMBRAR en vez de decir
 * «esperan waiver» a secas. Mismos dos registros y mismas opciones que `waivedAcs`. Devuelve:
 *   - `acs`:   [{ ac, log, line, approvedBy, ts, motivo }] — cada AC de una firma descartada que HOY
 *              engancharía (por la declaración vigente, o por matrixHash si la entrada es legacy). Una firma
 *              de una declaración vieja no está: volver a firmarla no aprobaría nada.
 *   - `lines`: [{ log, line, motivo }] — toda línea descartada de esta story, para el aviso de cadena. Las de
 *              otras stories no: el registro sólo crece, y un aviso global quedaría prendido para siempre.
 */
function discardedFor(story, arg2) {
  const opts = typeof arg2 === 'string' || arg2 === undefined ? { matrixHash: arg2 } : arg2;
  const declHashByAc = opts.declHashByAc || {};
  const logs = [];
  if (opts.repoRoot) logs.push(repoWaiverLogPath(opts.repoRoot));
  logs.push(waiverLogPath());
  const acs = [];
  const lines = [];
  for (const log of logs) {
    for (const d of verifyChain(log).discarded) {
      const e = d.entry;
      if (!e || String(e.story) !== String(story)) continue;
      const acsDe = Array.isArray(e.acs) ? e.acs : [];
      const antes = acs.length;
      for (const n of acsDe) {
        const declEntry = declDeLaEntrada(e, n);
        const engancharia = declEntry !== undefined
          ? declHashByAc[n] !== undefined && declEntry === declHashByAc[n]
          : opts.matrixHash !== undefined && e.matrixHash === opts.matrixHash;
        if (engancharia) acs.push({ ac: n, log, line: d.line, approvedBy: e.approvedBy || null, ts: e.ts || null, motivo: d.motivo });
      }
      // El registro de la HOME lo comparten todos los repos de la máquina, y la entrada no dice de cuál es: ahí una
      // línea cuenta para el aviso sólo si engancharía con esta story. La del repo es de este repo.
      const esDelRepo = opts.repoRoot && log === repoWaiverLogPath(opts.repoRoot);
      if (esDelRepo || acs.length > antes) lines.push({ log, line: d.line, motivo: d.motivo });
    }
  }
  return { acs, lines };
}

module.exports = {
  hasTty, promptTty, appendWaiver, waivedAcs, verifyChain, waiverLogPath, repoWaiverLogPath, declHashFor, discardedFor,
  esWindows, enVentana, consolaNueva, abrirVentana, anotarVentana, confirmarFrase, fraseAlAzar, pausaFinal, topeVentanaS,
  MARCA_VENTANA, VENTANA_TOPE_S, PALABRAS,
};
