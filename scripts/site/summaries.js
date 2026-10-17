'use strict';
/**
 * summaries.js — el trabajo pesado sobre el espejo del buzón, en un hilo aparte (`worker_threads`).
 *
 * El hilo principal del sitio contesta las sondas de vida y de carga (`/livez`, `/readyz`) con un plazo de un segundo, y
 * el espejo vive en el disco montado del sitio, donde cada `stat` o lectura tarda: con mil archivos, una vuelta por el
 * espejo en el hilo principal lo deja sin contestar y la plataforma reinicia el contenedor. Todo lo que recorre el
 * espejo va acá: la bajada (`bajarEnWorker`), el resumen de las conversaciones (`resumirEnWorker`: dashboard/runs.js →
 * resumirEspejo, lo que la tabla y el detalle sacan de ellas, y las borra del disco), la lectura de las corridas y de lo
 * informado por las máquinas (`leerEspejoEnWorker`), la huella del espejo (`huellaEnWorker`) y los textos de una
 * corrida a demanda (`textosEnWorker`). Con un techo de memoria y uno de tiempo se cae el hilo, nunca el sitio.
 */
const path = require('path');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

const RUNS = path.join(__dirname, '..', 'nightly', 'dashboard', 'runs.js');

/** Resume en el hilo donde corre: { resumidas, fallidas, motivos }. */
function resumirAca({ buzon, skillsDir = null }) {
  return require(RUNS).resumirEspejo(buzon, { skillsDir });
}

/** Lo mismo en un hilo aparte, con techo de memoria (`memoriaMb`) y de tiempo (`tiempoMs`). */
function resumirEnWorker({ buzon, skillsDir = null, memoriaMb = 512, tiempoMs = 600000 }) {
  return enWorker({ __resumir: true, buzon, skillsDir }, { memoriaMb, tiempoMs, frase: 'el resumen de las corridas no terminó a tiempo' });
}

/** Los textos de una corrida (`volcado`, con su conversación y su cambio al lado), en un hilo aparte: { texto, textoGit }. */
function textosEnWorker({ volcado, skillsDir = null, memoriaMb = 512, tiempoMs = 120000 }) {
  return enWorker({ __textos: true, volcado, skillsDir }, { memoriaMb, tiempoMs, frase: 'los textos de la corrida no se armaron a tiempo' });
}

/** La bajada del buzón (download-runs.js → bajar) en un hilo aparte; `log` recibe sus líneas. Mismo resultado: { codigo, res }. */
function bajarEnWorker({ log = () => {}, memoriaMb = 768, tiempoMs = null, ...opts }) {
  const plazo = tiempoMs || (Number(opts.budgetMs) || 120000) + 120000;
  return enWorker({ __bajar: true, opts }, { memoriaMb, tiempoMs: plazo, frase: 'la bajada del buzón no terminó a tiempo', log });
}

/** Las corridas del espejo y lo informado por las máquinas, leídos en un hilo aparte: { corridas, informados }. */
function leerEspejoEnWorker({ buzon, memoriaMb = 768, tiempoMs = 300000 }) {
  return enWorker({ __leerEspejo: true, buzon }, { memoriaMb, tiempoMs, frase: 'la lectura del espejo del buzón no terminó a tiempo' });
}

/** La huella del espejo (tabs/runs.js → huellaDelEspejo) en un hilo aparte. */
function huellaEnWorker({ dir, extra = [], memoriaMb = 256, tiempoMs = 300000 }) {
  return enWorker({ __huella: true, dir, extra }, { memoriaMb, tiempoMs, frase: 'la huella del espejo no terminó a tiempo' });
}

function enWorker(datos, { memoriaMb, tiempoMs, frase, log = () => {} }) {
  return new Promise((resolve, reject) => {
    let listo = false;
    const w = new Worker(__filename, { workerData: datos, resourceLimits: { maxOldGenerationSizeMb: memoriaMb } });
    const fin = (fn, x) => { if (listo) return; listo = true; clearTimeout(corte); fn(x); };
    const corte = setTimeout(() => { fin(reject, Object.assign(new Error(frase), { code: 'TIEMPO_AGOTADO' })); w.terminate(); }, tiempoMs);
    if (corte.unref) corte.unref();
    w.on('message', (m) => {
      if (m && typeof m.__linea === 'string') { try { log(m.__linea); } catch { /* el registro no corta el trabajo */ } return; }
      if (m && m.error) fin(reject, Object.assign(new Error(m.error), { code: 'FALLA_DEL_HILO' }));
      else fin(resolve, m && m.__resultado !== undefined ? m.__resultado : m);
    });
    w.once('error', (e) => fin(reject, e));
    w.once('exit', (codigo) => fin(reject, Object.assign(new Error(`el hilo salió (${codigo})`), { code: `SALIDA_${codigo}` })));
  });
}

const mensajeDe = (e) => (e && (e.code ? `${e.code}: ${e.message}` : e.message)) || String(e);
function trabajo(fn) {
  Promise.resolve().then(fn).then((r) => parentPort.postMessage({ __resultado: r }), (e) => parentPort.postMessage({ error: mensajeDe(e) }));
}

if (!isMainThread && workerData && workerData.__bajar) {
  trabajo(() => require('../metrics/download-runs.js').bajar({ ...workerData.opts, log: (l) => parentPort.postMessage({ __linea: String(l) }) }));
}
if (!isMainThread && workerData && workerData.__leerEspejo) {
  trabajo(() => ({ corridas: require('./sources.js').leerCorridas(workerData.buzon), informados: require('../lib/people.js').leerCorreosInformados(workerData.buzon) }));
}
if (!isMainThread && workerData && workerData.__huella) {
  trabajo(() => require('./tabs/runs.js').huellaDelEspejo(workerData.dir, workerData.extra));
}
if (!isMainThread && workerData && workerData.__resumir) trabajo(() => resumirAca(workerData));
if (!isMainThread && workerData && workerData.__textos) trabajo(() => require(RUNS).textosDeUnaCorrida(workerData.volcado, { skillsDir: workerData.skillsDir }));

module.exports = { resumirEnWorker, resumirAca, textosEnWorker, bajarEnWorker, leerEspejoEnWorker, huellaEnWorker };
