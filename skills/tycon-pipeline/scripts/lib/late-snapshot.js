/**
 * late-snapshot.js — ¿se tocó CÓDIGO después del último revisor de la ronda?
 *
 * ── POR QUÉ EXISTE (2026-09-15) ──────────────────────────────────────────────────────────────────
 * La FOTO del estado auditado (`marker.js snapshot-iter N`) se toma sola desde el 2026-08-15, en el
 * spawn del último revisor esperado — que es el momento correcto: entre ese spawn y el primer fix no
 * se toca código. Pero el TEXTO del skill nunca se actualizó: siguió mandando una segunda llamada
 * «al cierre del step», y `cmdSnapshotIter` PISABA la foto buena sin mirar nada.
 *
 * Medido sobre la corrida real de la story 2.5 del arnés: **15 de 15** fotos automáticas
 * fueron pisadas por la llamada manual, y en **2 de 15** había código editado en el medio. En la
 * iteración 11 la foto automática salió a las 16:52:52, `reductor.js` se arregló a las 16:58:16 y la
 * llamada manual la re-fechó a las 17:03:17: el arreglo quedó ADENTRO de la foto, el delta de la
 * iteración 12 salió VACÍO, y `security-basics` y `silent-failure-hunter` se saltearon como
 * «superficie no tocada». Las trece restantes no dañaron porque no hubo código en el medio — no
 * porque algo lo impidiera.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
 * Contesta UNA pregunta, con los datos que ya existen: ¿hay archivos de código con hora POSTERIOR al
 * último lanzamiento de revisores? El efecto (negarse, conservar, o tomar la foto) lo decide quien
 * llama — `marker.js` con su tabla de decisión, `pipeline.js` para correr el delta desde el corte
 * correcto.
 *
 * 🔴 El corte es el ÚLTIMO REVISOR, no la hora de la foto: la hora de la foto es justamente el dato
 * que puede estar mal, y una guarda que confía en él tiene el mismo punto ciego que el defecto que
 * viene a cerrar (es lo que le pasa a `post-revision.js`, declarado en su lugar).
 *
 * 🔴 Las TRES fuentes, no una: `fileEvents` (lo que vio el hook de Edit/Write) es ciego a las
 * ediciones por Bash (`sed`, heredoc), el mtime de `filesTouched` es ciego a lo que el hook nunca
 * vio, y git ve el working tree entero. Es la misma unión que usa `computeSmartReloop` — una guarda
 * con menos fuentes que el consumidor de su resultado deja pasar en silencio justo lo que no ve.
 *
 * 🔴 Falla siempre hacia MÁS revisión: sin registro de spawns no se puede medir y se dice (`medible:
 * false`), nunca se finge un «está todo bien». Un mtime movido sin cambio de contenido (un checkout,
 * un rebase) se lee como «posterior» y cuesta un revisor de más; el error al revés —un fix sin
 * re-auditar— es el que produjo este defecto.
 *
 * 🔴 Sólo CÓDIGO (`isCodeFile` de story-gate.js, el mismo criterio de `post-revision.js`): escribir
 * los reportes de los revisores, la story y la evidencia entre la foto y el cierre del step es lo
 * NORMAL de cada iteración. Un control que frenara ahí se apaga en una semana, y se lleva puestos
 * los casos donde sí importaba. Punto ciego declarado: un `.json` de configuración que el código lee
 * en runtime no cuenta — el mismo que `post-revision.js` ya declara.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { NO_REVISORES, ADHOC } = require('./advisor-round.js');
const { isCodeFile } = require('./story-gate.js');
const honesty = require('./ledger-honesty.js');

/** Cuántos archivos posteriores se nombran en la constancia y en el aviso (el resto va como total). */
const TOPE_NOMBRADOS = 10;

function parseJsonl(lineas) {
  const out = [];
  for (const l of Array.isArray(lineas) ? lineas : []) {
    if (typeof l !== 'string' || !l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* línea corrupta: se ignora, no rompe */ }
  }
  return out;
}

/**
 * ¿Ese subagente es un REVISOR? Mismos sets que `advisor-round.js` (no se copian: dos listas que
 * nada obliga a moverse juntas se separan solas). Quedan afuera la exploración libre (ADHOC) y los
 * chequeadores de otras etapas (el capturador post-merge, el checker de DoD, el validador…): ésos
 * corren en cualquier momento y moverían el corte hacia adelante, que es la dirección insegura.
 */
function esRevisor(a) {
  return typeof a === 'string' && !ADHOC.has(a) && !NO_REVISORES.has(a);
}

/**
 * El último lanzamiento de REVISOR de la ronda abierta (desde el `step5-start` que corresponda).
 *
 * 🔴 `iterEsperada` no es un detalle (lo cazó el replay de punta a punta al escribirlo): `smart-reloop`
 * ANOTA un `step5-start` nuevo al terminar de calcular, así que una SEGUNDA llamada para la misma
 * iteración —un reintento, o el `--force-full-reloop` que sigue— encontraría como «ronda abierta» la
 * que ella misma acaba de abrir, todavía sin un solo revisor: la medición se perdería en silencio.
 * Con la iteración esperada se busca SU ronda; si no hay ninguna con ese número, se cae a la última,
 * que es el comportamiento de siempre.
 *
 * @param {string[]} lineas líneas crudas del `advisor-runs/<sessionId>.jsonl`.
 * @param {number|null} [iterEsperada] la iteración cuya ronda se busca.
 * @returns {{ts: number|null, iso?: string, advisor?: string, iter?: number|null, motivo?: string}}
 */
function ultimoRevisorDeLaRonda(lineas, iterEsperada) {
  const parsed = parseJsonl(lineas);
  if (!parsed.length) {
    return { ts: null, motivo: 'no hay registro de revisores en esta sesión (advisor-runs/<sid>.jsonl vacío o ausente)' };
  }
  let startIdx = -1;
  if (Number.isInteger(iterEsperada)) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i] && parsed[i].event === 'step5-start' && parsed[i].iter === iterEsperada) { startIdx = i; break; }
    }
  }
  if (startIdx === -1) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i] && parsed[i].event === 'step5-start') { startIdx = i; break; }
    }
  }
  if (startIdx === -1) {
    return { ts: null, motivo: 'no hay ronda de revisores registrada en esta sesión (falta step5-start)' };
  }
  const iter = Number.isInteger(parsed[startIdx].iter) ? parsed[startIdx].iter : null;
  let ts = null;
  let advisor = null;
  for (let i = startIdx + 1; i < parsed.length; i++) {
    const d = parsed[i];
    if (!d || !esRevisor(d.advisor)) continue;
    const t = Date.parse(d.ts);
    if (!Number.isFinite(t)) continue;
    if (ts === null || t >= ts) { ts = t; advisor = d.advisor; }
  }
  if (ts === null) {
    return { ts: null, iter, motivo: 'la ronda abierta todavía no registró el lanzamiento de ningún revisor' };
  }
  return { ts, iso: new Date(ts).toISOString(), advisor, iter };
}

/**
 * Qué versión del cambio vio CADA revisor de una vuelta: la hora en que se lanzó (2026-10-14).
 *
 * 🔴 Por qué no alcanza con el último revisor: la foto de la vuelta se toma al lanzar el último, y
 * un arreglo hecho mientras corrían los demás queda ADENTRO de la foto. El revisor que se lanzó
 * antes del arreglo no lo vio nunca, y el delta de la vuelta siguiente —que mira desde la foto— no
 * lo trae: el revisor se saltea por «superficie no tocada». La hora de lanzamiento de cada uno ya
 * está en el registro que escribe el hook en cada spawn real; no hace falta que nadie la declare.
 *
 * La vuelta se ubica por su `step5-start` con ese número de iteración. Se toma la ÚLTIMA y se
 * extiende hacia atrás sobre los `step5-start` de la misma iteración que la preceden sin otra
 * iteración en el medio (un reintento de `smart-reloop`, o el `--force-full-reloop` que lo sigue):
 * así una sesión que corrió dos stories no mezcla vueltas, y un reintento no corre el inicio hacia
 * adelante. Los lanzamientos se cuentan hasta el `step5-start` de la iteración siguiente.
 *
 * 🔴 Si un revisor se lanzó DOS veces en la vuelta (se cayó y se relanzó), cuenta el PRIMER
 * lanzamiento: no se sabe cuál de los dos informes se usó, y el primero es el que vio menos.
 *
 * Sin vuelta registrada (otra sesión, registro borrado) no se finge nada: `medible: false` con el
 * motivo, y quien llama decide lo conservador.
 *
 * @param {string[]} lineas líneas crudas del `advisor-runs/<sessionId>.jsonl`.
 * @param {number} iter la iteración cuya vuelta se busca.
 * @returns {{medible: boolean, motivo: string|null, inicioMs: number|null,
 *            esperados: Set<string>, lanzamientos: Map<string, number>}}
 */
function vistaPorRevisor(lineas, iter) {
  const vacio = (motivo) => ({ medible: false, motivo, inicioMs: null, esperados: new Set(), lanzamientos: new Map() });
  const parsed = parseJsonl(lineas);
  if (!parsed.length) return vacio('no hay registro de lanzamientos en esta sesión (advisor-runs/<sid>.jsonl vacío o ausente)');
  const esInicio = (d) => d && d.event === 'step5-start';
  let ancla = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (esInicio(parsed[i]) && parsed[i].iter === iter) { ancla = i; break; }
  }
  if (ancla === -1) return vacio(`el registro no tiene el arranque de la vuelta ${iter} (step5-start con iter ${iter})`);
  let desde = ancla;
  for (let i = ancla - 1; i >= 0; i--) {
    if (!esInicio(parsed[i])) continue;
    if (parsed[i].iter !== iter) break;
    desde = i;
  }
  const esperados = new Set();
  const lanzamientos = new Map();
  let inicioMs = null;
  for (let i = desde; i < parsed.length; i++) {
    const d = parsed[i];
    if (!d) continue;
    if (esInicio(d)) {
      if (i > ancla && d.iter !== iter) break;      // empezó la vuelta siguiente
      const t = Date.parse(d.ts);
      if (Number.isFinite(t) && (inicioMs === null || t < inicioMs)) inicioMs = t;
      for (const a of Array.isArray(d.expected) ? d.expected : []) if (typeof a === 'string') esperados.add(a);
      continue;
    }
    if (typeof d.advisor !== 'string') continue;
    const t = Date.parse(d.ts);
    if (!Number.isFinite(t)) continue;
    const previo = lanzamientos.get(d.advisor);
    if (previo === undefined || t < previo) lanzamientos.set(d.advisor, t);
  }
  if (inicioMs === null) return vacio(`el arranque de la vuelta ${iter} no tiene hora legible`);
  return { medible: true, motivo: null, inicioMs, esperados, lanzamientos };
}

function mtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

/** El working tree según git — la única fuente que no depende de que el hook haya visto el archivo. */
function archivosDeGit(repoRoot) {
  if (!repoRoot) return [];
  try {
    // Fuente ÚNICA: la misma función que usa `computeSmartReloop` (raíz real del repo, recorte a
    // --repo, realpath en las dos puntas). Copiarla acá sería la divergencia de mañana.
    const { gitArchivosDelWorkingTree } = require('../pipeline.js');
    if (typeof gitArchivosDelWorkingTree === 'function') return gitArchivosDelWorkingTree(repoRoot);
  } catch { /* sin pipeline.js (arnés a medio actualizar) → las otras dos fuentes siguen */ }
  return [];
}

/** ¿El path cuenta como «código que ningún revisor vio»? */
function cuenta(p) {
  if (!p) return false;
  if (honesty.sinProbes([p]).length === 0) return false;             // probe transitorio del pase adversarial
  const enHome = path.join(os.homedir(), '.claude');
  if (String(p) === enHome || String(p).startsWith(`${enHome}${path.sep}`)) return false;  // estado del arnés
  return isCodeFile(p);
}

/**
 * ¿Hay código editado después del último revisor?
 *
 * @param {{ledgerLineas: string[], marker: object, repoRoot: string|null, iter: number|null}} args
 * @returns {{medible: boolean, motivo: string|null, ultimoRevisor: string|null,
 *            ultimoRevisorMs: number|null, posteriores: Array<{path,ts,fuente}>,
 *            fotoPrevia: object|null}}
 */
function codigoDespuesDelUltimoRevisor({ ledgerLineas, marker, repoRoot, iter }) {
  const m = marker || {};
  const fotoPrevia = (m.iterations && iter != null && m.iterations[String(iter)]) || null;
  const r = ultimoRevisorDeLaRonda(ledgerLineas, Number.isInteger(iter) ? iter : null);
  if (r.ts === null) {
    return { medible: false, motivo: r.motivo, ultimoRevisor: null, ultimoRevisorMs: null, posteriores: [], fotoPrevia };
  }

  const corte = r.ts;
  const vistos = new Map();                       // path → {path, ts, fuente} — gana la 1ra fuente que lo ve
  const anotar = (p, ts, fuente) => {
    if (!p || !Number.isFinite(ts) || ts <= corte) return;
    if (vistos.has(p)) return;
    vistos.set(p, { path: p, ts: new Date(ts).toISOString(), fuente });
  };

  // (a) lo que vio el hook de Edit/Write.
  for (const e of Array.isArray(m.fileEvents) ? m.fileEvents : []) {
    if (!e || !e.path) continue;
    anotar(e.path, Date.parse(e.ts), 'fileEvents');
  }
  // (b) el mtime de lo que el registro ya conoce — cubre las ediciones por Bash.
  for (const f of Array.isArray(m.filesTouched) ? m.filesTouched : []) {
    anotar(f, mtimeMs(f), 'mtime');
  }
  // (c) lo que ve git — cubre lo que el hook NUNCA vio.
  for (const f of archivosDeGit(repoRoot)) anotar(f, mtimeMs(f), 'git');

  const posteriores = [...vistos.values()]
    .filter((e) => cuenta(e.path))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return {
    medible: true,
    motivo: null,
    ultimoRevisor: r.iso,
    ultimoRevisorMs: corte,
    ultimoRevisorAdvisor: r.advisor || null,
    posteriores,
    fotoPrevia,
  };
}

/** Los nombres para el aviso y la constancia, acotados (un log de 300 rutas no lo lee nadie). */
function nombrados(posteriores) {
  const lista = (posteriores || []).slice(0, TOPE_NOMBRADOS);
  return {
    lista,
    resto: Math.max(0, (posteriores || []).length - lista.length),
    corto: lista.map((e) => path.basename(e.path)).join(', '),
  };
}

module.exports = { codigoDespuesDelUltimoRevisor, ultimoRevisorDeLaRonda, vistaPorRevisor, esRevisor, nombrados, TOPE_NOMBRADOS };
