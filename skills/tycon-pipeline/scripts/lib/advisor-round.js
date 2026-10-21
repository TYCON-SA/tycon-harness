/**
 * advisor-round.js — ¿se completó la ronda de advisors de esta iteración?
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * La FOTO del estado auditado (`marker.js snapshot-iter N`) tiene un único momento correcto: cuando
 * terminó la ronda de advisors y ANTES de tocar una línea de código para arreglar lo que reportaron.
 * Si se toma después de los fixes, los fixes ya están «adentro» de la foto, el delta de la iteración
 * siguiente sale VACÍO, y el re-loop degrada a `--force-full-reloop`: el set completo de advisors
 * donde el delta real son dos archivos.
 *
 * Ese momento depende de que el orquestador se acuerde, y eso no es confiable: falla con el mismo
 * síntoma y la misma recuperación a mano.
 *
 * *Lo que hay que acordarse de hacer, no se hace.* El dato para no depender de la memoria existe — el
 * hook `on-advisor-run.js` registra cada spawn REAL y la línea `step5-start` persiste el set esperado
 * (eso es lo que lee `check-count`). Este módulo los cruza para detectar el momento.
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────────────────────────────
 * Función PURA sobre las líneas del log de spawns: dice si los advisors corridos desde el último
 * `step5-start` ya cubren el set esperado, y de qué iteración se trata. El efecto (tomar la foto) lo
 * hace el hook, que es quien tiene el side-effect.
 *
 * 🔴 Se decide en el SPAWN del último advisor, no en su término. Es a propósito y es lo correcto para
 * lo que la foto protege: entre el último spawn y el primer fix no se toca código — los fixes vienen
 * después de leer los reportes. Esperar el término exigiría un hook de post-ejecución que hoy no
 * existe, y llegaría igual de bien pero más tarde.
 */

'use strict';

/**
 * ¿La ronda de advisors de esta iteración ya está completa?
 *
 * @param {string[]} lineas líneas crudas del `advisor-runs/<sessionId>.jsonl`, en orden.
 * @returns {{completa: boolean, iter: number|null, faltan: string[], esperados: number, corridos: number}}
 *   `completa` sólo es `true` si hubo un `step5-start` CON set esperado y todos sus advisors ya se
 *   spawnearon. Sin `step5-start`, sin `expected`, o con un `expected` vacío → `false` (nunca se
 *   inventa una ronda que nadie declaró).
 */
function rondaCompleta(lineas) {
  const vacio = { completa: false, iter: null, faltan: [], esperados: 0, corridos: 0 };
  if (!Array.isArray(lineas)) return vacio;

  const parsed = [];
  for (const l of lineas) {
    if (typeof l !== 'string' || !l.trim()) continue;
    try { parsed.push(JSON.parse(l)); } catch { /* línea corrupta: se ignora, no rompe */ }
  }

  let startIdx = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i] && parsed[i].event === 'step5-start') { startIdx = i; break; }
  }
  if (startIdx === -1) return vacio;

  const start = parsed[startIdx];
  const esperados = Array.isArray(start.expected) ? start.expected.filter((a) => typeof a === 'string') : [];
  const iter = Number.isInteger(start.iter) ? start.iter : null;
  if (esperados.length === 0) return { ...vacio, iter };

  const corridos = new Set();
  for (let i = startIdx + 1; i < parsed.length; i++) {
    const d = parsed[i];
    if (d && typeof d.advisor === 'string') corridos.add(d.advisor);
  }

  const faltan = esperados.filter((a) => !corridos.has(a));

  // 🔴 ¿Ya se tomó la foto de ESTA ronda? Sin esto, se reintroduciría el bug que esta pieza
  // cierra: la ronda queda «completa» para siempre, así que CUALQUIER spawn posterior —un agente
  // ad-hoc, una búsqueda— volvería a disparar la foto, con los fixes ya aplicados adentro.
  // Ése es exactamente el estado que produce el delta vacío. La foto se toma UNA vez por ronda.
  const yaFotografiada = parsed
    .slice(startIdx + 1)
    .some((d) => d && d.event === 'auto-snapshot');

  return {
    completa: faltan.length === 0,
    yaFotografiada,
    iter,
    faltan,
    esperados: esperados.length,
    corridos: corridos.size,
  };
}

/** Exploración libre: no son revisores (mismo set que on-advisor-run.js y review-roster.js). */
const ADHOC = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
/** Chequeadores de otras etapas: no son vueltas de revisión aunque corran después del sello. */
const NO_REVISORES = new Set([
  'tycon-retrospective-capturer', 'tycon-dod-runtime-checker', 'tycon-ac-coverage-checker',
  'tycon-deferral-tracker', 'tycon-story-validator', 'tycon-signed-scope-audit', 'tycon-spec-first-checker',
]);

/**
 * vueltaManual — ¿el spawn que acaba de registrarse abre una VUELTA MANUAL de revisores?
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * La métrica `advisor_rerun_loop_iterations` cuenta las líneas `advisors-iter` de gates.log, que
 * escribe `snapshot-iter` cuando una ronda FORMAL se completa (todos los esperados del último
 * `step5-start`). Las re-invocaciones MANUALES —dos o tres revisores puntuales después del pase
 * adversarial, hasta que confirman limpio— nunca completan una ronda formal, así que no dejan
 * rastro: una story con 5 vueltas reales daría 2 en la métrica — y justo la señal más interesante
 * (revisores que siguen encontrando cosas después del pase que ejecuta) es la que se perdería.
 *
 * ── QUÉ HACE ───────────────────────────────────────────────────────────────────────────────────
 * Función PURA sobre las líneas del ledger de spawns. Sólo mira DESPUÉS del sello `auto-snapshot`
 * de la última ronda formal: hasta ahí, la ronda es formal y la cuenta `rondaCompleta`. Desde el
 * sello, cada spawn de un revisor (no ad-hoc) de la misma story:
 *   - sólo si es un REVISOR (no ad-hoc, no un chequeador de otra etapa como el capturador, el DoD
 *     checker o el validador) y de la misma story que la ronda; no hace falta que haya estado en el
 *     `expected`: un especialista que entra después también es una vuelta;
 *   - abre la vuelta manual `<iter>.1` si no había ninguna;
 *   - abre la siguiente (`<iter>.2`, …) si ese MISMO revisor ya corrió en la vuelta abierta y
 *     pasó más de `ventanaMs` desde aquel spawn — volver a llamar al mismo revisor es lo que
 *     define una vuelta nueva; dentro de la ventana es un fan-out en paralelo, no una vuelta;
 *   - si no, la vuelta abierta sigue (un revisor distinto se suma a la misma).
 * El efecto (sellar `manual-iter` en el ledger y escribir `advisors-iter` en gates.log) lo hace el
 * hook; el número `<iter>.<k>` es distinto de cualquier iter formal a propósito: el capturador
 * cuenta iters DISTINTOS, y un `3` manual chocaría con el `3` del próximo re-loop formal.
 *
 * @param {string[]} lineas líneas crudas del `advisor-runs/<sessionId>.jsonl`, en orden; la ÚLTIMA
 *   con `advisor` es el spawn que se está decidiendo.
 * @param {{ventanaMs?: number}} [opts]
 * @returns {{abre: boolean, iter: string|null, k: number}}
 */
function vueltaManual(lineas, opts) {
  const ventanaMs = opts && Number.isFinite(opts.ventanaMs) ? opts.ventanaMs : 90 * 1000;
  const nada = { abre: false, iter: null, k: 0 };
  if (!Array.isArray(lineas)) return nada;
  const parsed = [];
  for (const l of lineas) {
    if (typeof l !== 'string' || !l.trim()) continue;
    try { parsed.push(JSON.parse(l)); } catch { /* línea corrupta: se ignora */ }
  }
  let startIdx = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i] && parsed[i].event === 'step5-start') { startIdx = i; break; }
  }
  if (startIdx === -1) return nada;
  const iterBase = Number.isInteger(parsed[startIdx].iter) ? parsed[startIdx].iter : null;
  if (iterBase === null) return nada;
  let selloIdx = -1;
  for (let i = startIdx + 1; i < parsed.length; i++) {
    if (parsed[i] && parsed[i].event === 'auto-snapshot') selloIdx = i;
  }
  if (selloIdx === -1) return nada;                       // la ronda formal sigue abierta
  // 🔴 Sólo un REVISOR abre una vuelta: un subagente que no es de exploración (ADHOC) ni un
  // chequeador de otra etapa (NO_REVISORES: el capturador post-merge, el DoD checker del 7c, el
  // validador, el de cobertura de ACs…). La ronda formal NO lo limita: un revisor que no estuvo en
  // el `expected` y se re-invoca a mano (un especialista que entró después) también es una vuelta
  // — y un chequeador que corrió DENTRO de la ventana formal sigue sin serlo.
  const esRevisor = (a) => typeof a === 'string' && !ADHOC.has(a) && !NO_REVISORES.has(a);
  let storyRonda = null;
  for (let i = startIdx + 1; i < selloIdx; i++) {
    const d = parsed[i];
    if (d && esRevisor(d.advisor) && storyRonda === null && d.story != null) storyRonda = String(d.story);
  }
  let ultimoIdx = -1;
  for (let i = parsed.length - 1; i > selloIdx; i--) {
    if (parsed[i] && typeof parsed[i].advisor === 'string') { ultimoIdx = i; break; }
  }
  if (ultimoIdx === -1) return nada;
  const ultimo = parsed[ultimoIdx];
  if (!esRevisor(ultimo.advisor)) return nada;
  const story = ultimo.story == null ? null : String(ultimo.story);
  if (storyRonda !== null && story !== storyRonda) return nada;   // otra story, o sin story atribuida: no es esta ronda
  const tsDe = (d) => { const t = Date.parse(d && d.ts); return Number.isFinite(t) ? t : null; };

  let k = 0;
  let primerSpawn = new Map();                             // advisor → ts del primer spawn en la vuelta abierta
  let ultimoVisto = null;                                  // el spawn que ABRE una vuelta va ANTES de su sello
  for (let i = selloIdx + 1; i < ultimoIdx; i++) {
    const d = parsed[i];
    if (!d) continue;
    if (d.event === 'manual-iter') {
      k++; primerSpawn = new Map();
      if (ultimoVisto) primerSpawn.set(ultimoVisto.advisor, ultimoVisto.ts);
      continue;
    }
    if (!esRevisor(d.advisor)) continue;
    if ((d.story == null ? null : String(d.story)) !== story) continue;
    ultimoVisto = { advisor: d.advisor, ts: tsDe(d) };
    if (k > 0 && !primerSpawn.has(d.advisor)) primerSpawn.set(d.advisor, tsDe(d));
  }
  if (k === 0) return { abre: true, iter: `${iterBase}.1`, k: 1 };
  if (!primerSpawn.has(ultimo.advisor)) return { abre: false, iter: `${iterBase}.${k}`, k };
  const antes = primerSpawn.get(ultimo.advisor);
  const ahora = tsDe(ultimo);
  if (antes !== null && ahora !== null && ahora - antes <= ventanaMs) return { abre: false, iter: `${iterBase}.${k}`, k };
  return { abre: true, iter: `${iterBase}.${k + 1}`, k: k + 1 };
}

// ADHOC y NO_REVISORES se EXPORTAN: `lib/late-snapshot.js` decide con los mismos dos
// sets quién es un revisor. Copiarlos allá sería la divergencia de mañana — el día que alguien
// agregue un chequeador nuevo a una lista y no a la otra, el corte de la foto se mueve solo.
module.exports = { rondaCompleta, vueltaManual, NO_REVISORES, ADHOC };
