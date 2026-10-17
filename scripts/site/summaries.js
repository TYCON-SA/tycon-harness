'use strict';
/**
 * summaries.js — los resúmenes de las corridas del espejo del buzón, en un hilo aparte (`worker_threads`).
 *
 * Con `site.mailbox.threads: true`, cada pasada de la bajada trae una tanda de conversaciones y cambios de git; esto los
 * resume (dashboard/runs.js → resumirEspejo: lo que la tabla y el detalle sacan de ellos) y los borra del disco. Leer
 * una conversación pesa (megas, descomprimidas): en un hilo aparte el principal sigue contestando, y con un techo de
 * memoria y uno de tiempo se cae el hilo, nunca el sitio.
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

function enWorker(datos, { memoriaMb, tiempoMs, frase }) {
  return new Promise((resolve, reject) => {
    let listo = false;
    const w = new Worker(__filename, { workerData: datos, resourceLimits: { maxOldGenerationSizeMb: memoriaMb } });
    const fin = (fn, x) => { if (listo) return; listo = true; clearTimeout(corte); fn(x); };
    const corte = setTimeout(() => { fin(reject, Object.assign(new Error(frase), { code: 'TIEMPO_AGOTADO' })); w.terminate(); }, tiempoMs);
    if (corte.unref) corte.unref();
    w.once('message', (m) => (m && m.error ? fin(reject, Object.assign(new Error(m.error), { code: 'FALLA_DEL_HILO' })) : fin(resolve, m)));
    w.once('error', (e) => fin(reject, e));
    w.once('exit', (codigo) => fin(reject, Object.assign(new Error(`el hilo salió (${codigo})`), { code: `SALIDA_${codigo}` })));
  });
}

if (!isMainThread && workerData && workerData.__resumir) {
  try { parentPort.postMessage(resumirAca(workerData)); } catch (e) { parentPort.postMessage({ error: (e && (e.code ? `${e.code}: ${e.message}` : e.message)) || String(e) }); }
}
if (!isMainThread && workerData && workerData.__textos) {
  try { parentPort.postMessage(require(RUNS).textosDeUnaCorrida(workerData.volcado, { skillsDir: workerData.skillsDir })); }
  catch (e) { parentPort.postMessage({ error: (e && (e.code ? `${e.code}: ${e.message}` : e.message)) || String(e) }); }
}

module.exports = { resumirEnWorker, resumirAca, textosEnWorker };
