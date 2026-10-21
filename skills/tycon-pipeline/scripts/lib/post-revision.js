'use strict';
/**
 * post-revision.js — ¿el commit trae código que se tocó DESPUÉS de la última ronda de revisores?
 * AVISA, no frena.
 *
 * 🔴 Caso: la última ronda de revisores cierra, y horas después se escribe una migración SQL que entra al
 * commit sin otra ronda. Puede traer un error de sintaxis que frene el despliegue. El revisor de
 * migraciones no corrió porque el archivo no existía cuando se armó su ronda: el orquestador no
 * falla, lo que falta es alguien que diga «esto no lo revisó nadie».
 *
 * Criterio: la ronda N deja su foto con hora (`marker.iterations[N].ts`, la escribe
 * `marker.js snapshot-iter`). Un archivo stageado que es CÓDIGO y tiene una edición registrada
 * (`file-events`, las escribe on-edit.js en cada edición) con hora posterior a la última foto no lo
 * vio ningún revisor. Specs, evidencia y config no cuentan: después de la última ronda se editan
 * siempre, a propósito (el cierre de la story, los hallazgos).
 *
 * Sin rondas registradas no hay nada que comparar y no se dice nada: esto es para corridas del
 * pipeline, no para trabajo suelto (ahí ya mira el aviso de ATDD).
 */
const path = require('path');
const { isCodeFile } = require('./story-gate.js');

/**
 * @param {object} p
 * @param {object} p.iterations  `marker.iterations` — { "<N>": { ts, filesSnapshot } }
 * @param {Array<{path:string, ts:string}>} p.events  ediciones registradas (rutas absolutas)
 * @param {string[]} p.staged  archivos del commit, relativos al repo
 * @param {string} p.repoRoot
 * @returns {null | { iter:number, ts:string, archivos:string[] }}  null = no hay rondas que comparar
 */
function archivosSinRevisar({ iterations, events, staged, repoRoot }) {
  const rondas = Object.entries(iterations || {})
    .map(([n, v]) => ({ n: Number(n), ts: v && v.ts }))
    .filter((r) => Number.isFinite(r.n) && typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts)));
  if (!rondas.length) return null;
  const ultima = rondas.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const corte = Date.parse(ultima.ts);

  const tardeEditados = new Set();
  for (const e of events || []) {
    if (!e || typeof e.path !== 'string' || typeof e.ts !== 'string') continue;
    if (Date.parse(e.ts) > corte) tardeEditados.add(path.resolve(e.path));
  }
  const archivos = (staged || [])
    .filter(Boolean)
    .filter((rel) => {
      const abs = path.resolve(repoRoot, rel);
      return tardeEditados.has(abs) && isCodeFile(abs);
    })
    .sort();
  return { iter: ultima.n, ts: ultima.ts, archivos };
}

function mensaje({ iter, ts, archivos }) {
  const hora = String(ts).slice(11, 16);
  const lista = archivos.slice(0, 8).join(', ') + (archivos.length > 8 ? ` (+${archivos.length - 8} más)` : '');
  return [
    `⚠ tycon-post-revision: ${archivos.length} archivo(s) de código entraron DESPUÉS de la última ronda de revisores (ronda ${iter}, ${hora} UTC): ${lista}`,
    '   Ningún revisor los vio. Si no es un arreglo mínimo ya revisado, corré otra ronda antes de commitear:',
    `   node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/pipeline.js smart-reloop --iter ${iter + 1} --repo . --story <story>`,
    '   (Aviso, no freno. Caso: la migración 054 del repo del framework entró así y rompió el despliegue.)',
  ].join('\n');
}

module.exports = { archivosSinRevisar, mensaje };
