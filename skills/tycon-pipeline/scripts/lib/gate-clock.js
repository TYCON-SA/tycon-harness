'use strict';
// El reloj del freno de escrituras por consola. El análisis corre en un hilo, y este hilo sólo mira el tiempo: si el
// análisis se traba, acá nada se traba con él y el comando no corre. No lee el comando con ninguna expresión: una
// que no termine dejaría al reloj sin quien lo atienda. No lanza procesos: el freno corre en cada comando.
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEGUNDOS_POR_DEFECTO = 20;
const ESPERA_DE_ENTREGA_MS = 2000;

/** El reloj en segundos: un entero de 1 a 50, escrito sin ceros adelante. Cualquier otro valor da el de siempre. */
function segundosDelReloj(valor) {
  const t = String(valor === undefined ? '' : valor);
  if (t.length < 1 || t.length > 2 || t[0] === '0') return SEGUNDOS_POR_DEFECTO;
  for (const c of t) if (c < '0' || c > '9') return SEGUNDOS_POR_DEFECTO;
  const n = Number(t);
  return n <= 50 ? n : SEGUNDOS_POR_DEFECTO;
}

// la carpeta del estado, de una sola pieza: el reloj anota aunque el resto del arnés no cargue
const stateDirOf = (() => { const lib = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js'); return require('fs').existsSync(lib) ? require(lib).stateDir : (h) => path.join(h || require('os').homedir(), '.claude', '.tycon-pipeline'); })();

function carpetaDelEstado() {
  try { return stateDirOf(os.homedir()); } catch { return os.tmpdir(); }
}

function anotar(motivo) {
  try {
    const dir = carpetaDelEstado();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'), `[${new Date().toISOString()}] on-bash-write-gate FRENÓ POR FALLA: ${motivo}\n\n`, 'utf8');
  } catch { /* sin dónde anotarlo, frena igual */ }
}

// Un hilo trabado en una llamada del sistema no deja terminar a `process.exit`, que lo espera. Reemplazar el proceso
// termina todos sus hilos. En Windows no existe: ahí un hilo trabado en JavaScript se corta igual, y uno trabado en
// una llamada del sistema deja al freno esperando, como antes de tener reloj.
function salirConDos() {
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    try { process.execve('/bin/sh', ['sh', '-c', 'exit 2'], {}); } catch { /* sigue con la salida común */ }
  }
  process.exit(2);
}

/**
 * Le pasa al hilo principal el texto leído y espera que llegue. La entrada estándar no se puede leer dos veces, y un
 * mensaje de un hilo que se cae enseguida puede perderse: sin el texto, la segunda lectura no vería el comando.
 */
function entregarEntrada(puerto, datos, entrada) {
  puerto.postMessage({ entrada });
  if (datos && datos.recibido) Atomics.wait(datos.recibido, 0, 0, ESPERA_DE_ENTREGA_MS);
}

/**
 * Corre `archivo` en un hilo y sale con su veredicto (0 o 2). Si termina de otra forma, otro hilo lee el comando con la
 * red de fallas (`modo: 'net'`); si tampoco contesta, o si se acaba el tiempo, el comando no corre.
 */
function vigilar({ archivo, archivoRed = archivo, segundos = segundosDelReloj(process.env.TYCON_BASH_GATE_TIMEOUT_S) }) {
  let cerrado = false;
  let entrada = null;
  const noDecidio = (motivo) => {
    if (cerrado) return;
    cerrado = true;
    try {
      fs.writeSync(2, `⛔ tycon-pipeline — el freno de escrituras no alcanzó a decidir (${motivo}): el comando no corrió. Reintentalo; si se repite, decíselo a la persona.\n`);
    } catch { /* sin dónde decirlo, frena igual */ }
    anotar(motivo);
    salirConDos();
  };
  const reloj = setTimeout(() => noDecidio(`no contestó en ${segundos} s`), segundos * 1000);
  const lanzar = (destino, modo, alCaer, extra = {}) => {
    let visto = false;
    const caer = (e) => { if (!visto) { visto = true; alCaer(e); } };
    const recibido = new Int32Array(new SharedArrayBuffer(4));
    let hilo;
    try {
      hilo = new Worker(destino, { workerData: { modo, recibido, ...(entrada === null ? {} : { entrada }), ...extra } });
    } catch (e) { caer(e); return; }
    hilo.on('message', (m) => {
      if (m && typeof m.entrada === 'string') entrada = m.entrada;
      Atomics.store(recibido, 0, 1);
      Atomics.notify(recibido, 0);
    });
    hilo.on('error', caer);
    hilo.on('exit', (codigo) => {
      if (visto) return;
      if (codigo !== 0 && codigo !== 2) { caer(new Error(`terminó con ${codigo}`)); return; }
      visto = true;
      if (cerrado) return;
      cerrado = true;
      clearTimeout(reloj);
      process.exitCode = codigo;
    });
  };
  lanzar(archivo, 'analysis', (e) => {
    lanzar(archivoRed, 'net', (e2) => noDecidio(`la segunda lectura falló: ${(e2 && e2.message) || e2}`), { falla: String((e && e.stack) || e) });
  });
}

module.exports = { vigilar, segundosDelReloj, entregarEntrada };
