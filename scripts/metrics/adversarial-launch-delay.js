#!/usr/bin/env node
'use strict';
/*
 * adversarial-launch-delay.js — ¿EL PASE ADVERSARIAL SALIÓ A TIEMPO?
 *
 * El pase es el camino crítico de la revisión (27 min de mediana en 403 corridas): tiene que lanzarse al cerrar el
 * paso 4, en paralelo con los revisores. Esta cuenta mide, POR HORAS, cuántas corridas con pase lo lanzaron más de
 * 2 minutos después del primer revisor. Contar el rótulo `launchedAtStep` (lo tipea el agente) no sirve: da mal
 * en 36 de 86 casos medidos, así que acá NO se lee.
 *
 * Las señales, fijas:
 *   · flujo lanzado  = `marker.adversarial.launchedAt` (lo escribe `mark-adversarial-launched` después de lanzar:
 *                      la hora del flujo con la demora de un turno).
 *   · primer revisor = el menor `lanzado` de `revisores.detalle` con un tipo de revisor del arnés, sin el validador
 *                      de stories (que corre antes de implementar).
 *   · apagado        = `marker.adversarialGate.early_launch === false` y, si no está, el
 *                      `"early_launch": false` en el resultado del comando `deep-review-gate` dentro del hilo de la
 *                      corrida. Sin ninguno de los dos, «no se sabe», contado aparte.
 *
 * Una corrida sin pase, o con pase pero sin revisores medidos, no entra en la cuenta de tardías: se dice cuántas hay.
 * Sólo lectura: no escribe los volcados (a diferencia de reviewers-cost.js).
 *
 * Uso:  node scripts/metrics/adversarial-launch-delay.js [--history-dir <dir>] [--projects-dir <dir>] [--json]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TARDE_MS = 2 * 60 * 1000;
const VALIDADOR = 'tycon-story-validator';
const RAIZ = path.join(__dirname, '..', '..');

// La carpeta del estado la sabe scripts/setup/harness/tycon-home.js, que viaja con este guion.
const { stateDir: stateDirOf } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));

const aMs = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

/** Los revisores del arnés: los agentes del núcleo y los de los paquetes que haya en el árbol. */
function revisoresDelArnes(raiz = RAIZ) {
  const nombres = new Set();
  try { for (const f of fs.readdirSync(path.join(raiz, 'agents'))) if (f.endsWith('.md')) nombres.add(f.slice(0, -3)); } catch { /* sin carpeta */ }
  const dirsPaquetes = [path.join(raiz, 'packs'), process.env.TYCON_PACKS_DIR].filter(Boolean);
  for (const d of dirsPaquetes) {
    let paquetes = [];
    try { paquetes = fs.readdirSync(d); } catch { continue; }
    for (const p of paquetes) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(d, p, 'pack.json'), 'utf8'));
        for (const r of m.revisores || m.reviewers || []) if (r && (r.agente || r.agent)) nombres.add(r.agente || r.agent);
      } catch { /* paquete sin manifiesto legible */ }
    }
  }
  nombres.delete(VALIDADOR);
  return nombres;
}

/** El menor `lanzado` de los revisores del arnés, o null. */
function primerRevisor(dump, arnes) {
  const detalle = (dump && dump.revisores && Array.isArray(dump.revisores.detalle)) ? dump.revisores.detalle : [];
  let min = null;
  for (const d of detalle) {
    if (!d || d.tipo === VALIDADOR) continue;
    const esDelArnes = arnes.has(d.tipo) || /^tycon-/.test(String(d.tipo || ''));
    if (!esDelArnes) continue;
    const t = aMs(d.lanzado);
    if (t !== null && (min === null || t < min)) min = t;
  }
  return min;
}

/** Las líneas del hilo de la corrida (la conversación viva o el hilo guardado al lado del volcado), o null. */
function hiloDe(volcado, sessionId, projectsDir) {
  try {
    const { conversacionDe } = require('./reviewers-cost.js');
    const c = conversacionDe(volcado, sessionId, projectsDir);
    return Array.isArray(c.lineas) ? c.lineas : null;
  } catch { return null; }
}

/** ¿El temprano estaba apagado? `true` · `false` · `null` (no se sabe). */
function tempranoApagado(dump, lineas) {
  const gate = dump && dump.marker && dump.marker.adversarialGate;
  if (gate && typeof gate.early_launch === 'boolean') return gate.early_launch === false;
  if (!Array.isArray(lineas)) return null;
  let visto = null;
  for (const l of lineas) {
    const texto = JSON.stringify(l);
    if (!texto.includes('early_launch')) continue;
    if (/\\?"early_launch\\?"\s*:\s*false/.test(texto)) return true;   // visto apagado una vez: vale para la corrida
    if (/\\?"early_launch\\?"\s*:\s*true/.test(texto)) visto = false;
  }
  return visto;
}

function medirCorrida(volcado, opts = {}) {
  let dump;
  try { dump = JSON.parse(fs.readFileSync(volcado, 'utf8')); } catch (e) { return { volcado, estado: 'ilegible', motivo: e.code || e.message }; }
  // un JSON válido que no es un objeto (`null`, un número) también es ilegible: abortaría el informe entero.
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) return { volcado, estado: 'ilegible', motivo: 'el volcado no es un objeto' };
  const marker = dump.marker || {};
  const lanzado = aMs(marker.adversarial && marker.adversarial.launchedAt);
  if (lanzado === null) return { volcado, story: marker.storyId || null, estado: 'sin-pase' };
  const primero = primerRevisor(dump, opts.arnes || revisoresDelArnes());
  if (primero === null) return { volcado, story: marker.storyId || null, estado: 'sin-revisores' };
  const demoraMs = lanzado - primero;
  const tarde = demoraMs > TARDE_MS;
  const gate = marker.adversarialGate;
  const lineas = gate && typeof gate.early_launch === 'boolean' ? null : hiloDe(volcado, marker.sessionId, opts.projectsDir);
  const apagado = tempranoApagado(dump, lineas);
  return { volcado, story: marker.storyId || null, estado: 'medida', demora_ms: demoraMs, tarde, apagado };
}

function medir(volcados, opts = {}) {
  const arnes = opts.arnes || revisoresDelArnes();
  const corridas = volcados.map((v) => medirCorrida(v, { ...opts, arnes }));
  const medidas = corridas.filter((c) => c.estado === 'medida');
  const tardias = medidas.filter((c) => c.tarde);
  return {
    corridas: corridas.length,
    con_pase: corridas.filter((c) => c.estado === 'medida' || c.estado === 'sin-revisores').length,
    sin_revisores: corridas.filter((c) => c.estado === 'sin-revisores').length,
    ilegibles: corridas.filter((c) => c.estado === 'ilegible').length,
    medidas: medidas.length,
    tardias: tardias.length,
    tardias_con_temprano_apagado: tardias.filter((c) => c.apagado === true).length,
    tardias_con_temprano_prendido: tardias.filter((c) => c.apagado === false).length,
    tardias_no_se_sabe: tardias.filter((c) => c.apagado === null).length,
    umbral_ms: TARDE_MS,
    detalle: corridas,
  };
}

function texto(r) {
  return [
    `pase adversarial lanzado tarde (más de ${r.umbral_ms / 60000} min después del primer revisor), por horas`,
    `  corridas: ${r.corridas} · con pase: ${r.con_pase} · medidas: ${r.medidas}` +
      `${r.sin_revisores ? ` · con pase y sin revisores medidos: ${r.sin_revisores}` : ''}${r.ilegibles ? ` · ilegibles: ${r.ilegibles}` : ''}`,
    `  tardías: ${r.tardias} de ${r.medidas}`,
    `    con el temprano apagado: ${r.tardias_con_temprano_apagado}`,
    `    con el temprano prendido: ${r.tardias_con_temprano_prendido}`,
    `    no se sabe: ${r.tardias_no_se_sabe}`,
    '',
  ].join('\n');
}

function main(argv) {
  const arg = (k, def) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const historyDir = arg('--history-dir', path.join(stateDirOf(os.homedir()), 'timing-history'));
  const projectsDir = arg('--projects-dir', path.join(os.homedir(), '.claude', 'projects'));
  let volcados;
  try {
    volcados = fs.readdirSync(historyDir).filter((f) => f.endsWith('.json')).map((f) => path.join(historyDir, f)).sort();
  } catch (e) {
    process.stderr.write(`adversarial-launch-delay: no pude leer ${historyDir}: ${e.code || e.message}\n`);
    return 2;
  }
  const r = medir(volcados, { projectsDir });
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else process.stdout.write(texto(r));
  return 0;
}

module.exports = { medir, medirCorrida, primerRevisor, tempranoApagado, revisoresDelArnes, TARDE_MS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
