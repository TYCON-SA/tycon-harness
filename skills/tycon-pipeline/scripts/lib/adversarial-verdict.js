'use strict';
/**
 * adversarial-verdict.js — ¿el pase adversarial está atendido? (story 1.8) y qué hacer con uno de otra sesión
 * (story 7.19). Lo usan `marker.js` (el freno del paso 8) y `pipeline.js` (`next`): una sola copia del criterio.
 *
 * Hasta la 7.19 `veredictoPaseAdversarial` vivía en `marker.js`, que no exporta nada; `next` no lo podía usar y
 * pedía relanzar siempre un pase de otra sesión —también uno ya cerrado, y relanzar un pase cerrado bloquea el paso 8.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * ¿El 5b quedó atendido? (story 1.8, 2026-09-18). Pura: lee el marker y devuelve
 * `{ veredicto: 'paso'|'bloqueo', motivo, runId, launchedAt }`.
 *
 * Lanzado → pasa con un resultado `tipo: '5b'` anotado en o después del ÚLTIMO lanzamiento (`resultado`), o con
 * el abandono de ESE lanzamiento (`abandonado`); si los resultados que hay son de un lanzamiento anterior —el
 * pase se relanzó, como en la 2.12— bloquea (`resultado-de-otro-lanzamiento`); sin nada, `sin-resultado`.
 * No lanzado → pasa con el salteo que decidió el portón (`salteado` / `salteado-forzado`), o con un resultado 5b
 * anotado aunque nadie haya registrado el lanzamiento (`resultado-sin-lanzamiento`), y si no, `no-atendido`:
 * la bandera `deepReviewDone` de una corrida vieja NO cuenta, porque es justo lo que cualquiera escribía a mano.
 * «No lo pude leer» no es «está»: un registro que no es lista o un lanzamiento sin fecha bloquean con su nombre.
 */
function veredictoPaseAdversarial(marker) {
  const m = marker || {};
  const adv = m.adversarial || null;
  const runId = adv && typeof adv === 'object' ? (adv.runId || null) : null;
  const launchedAt = adv && typeof adv === 'object' ? (adv.launchedAt ?? null) : null;
  const res = (veredicto, motivo, extra) => ({ veredicto, motivo, runId, launchedAt, ...(extra || {}) });
  if (m.adversarialPasses !== undefined && m.adversarialPasses !== null && !Array.isArray(m.adversarialPasses)) {
    return res('bloqueo', 'registro-ilegible', { campo: 'adversarialPasses' });
  }
  const pases = Array.isArray(m.adversarialPasses) ? m.adversarialPasses : [];
  const skip = m.adversarialSkip && typeof m.adversarialSkip === 'object' ? m.adversarialSkip : null;
  if (adv) {
    const desde = Date.parse(launchedAt);
    if (!Number.isFinite(desde)) return res('bloqueo', 'lanzamiento-sin-fecha', { campo: 'adversarial.launchedAt' });
    const del5b = pases.filter((p) => p && p.tipo === '5b');
    if (del5b.some((p) => Date.parse(p.ts) >= desde)) return res('paso', 'resultado');
    if (skip && skip.abandonado === true && skip.runId === runId) return res('paso', 'abandonado');
    if (del5b.length) return res('bloqueo', 'resultado-de-otro-lanzamiento');
    return res('bloqueo', 'sin-resultado');
  }
  if (skip) return res('paso', skip.forzado === true || skip.abandonado === true ? 'salteado-forzado' : 'salteado');
  // Resultado 5b anotado sin lanzamiento registrado (decisión D6 del dev, hallazgo del pase adversarial de la 1.8):
  // el resultado ES la constancia que el paso pide; queda con su propio motivo, visible en el registro.
  if (pases.some((p) => p && p.tipo === '5b')) return res('paso', 'resultado-sin-lanzamiento');
  return res('bloqueo', 'no-atendido');
}

/**
 * Para `next` (story 7.19, AC 4): «atendido» es `paso`, y también un `bloqueo` por `resultado-de-otro-lanzamiento`
 * —ése lo frena el paso 8, y pedir otro lanzamiento desde `next` lo empeora—.
 */
function paseAtendido(v) {
  return !!v && (v.veredicto === 'paso' || v.motivo === 'resultado-de-otro-lanzamiento');
}

// La regla para un pase lanzado por otra sesión y sin resultado (story 7.19, AC 5; decisión del dueño del
// 2026-10-15: sin preguntarle a nadie). Preguntar sería una espera humana nueva justo donde se quieren ganar
// minutos; relanzar siempre (lo de antes) tiraba 20 a 40 minutos cuando la otra sesión seguía viva y entregaba sola
// (caso de la 8.23, adoptada con el pase en vuelo: anotó el resultado 26 minutos después sin relanzar nada).
const ESPERA_MAX_MIN = 45;
const HILO_VIVO_MIN = 10;
const REGLA_PASE_AJENO =
  `se espera si el lanzamiento tiene menos de ${ESPERA_MAX_MIN} min y la sesión que lo lanzó sigue viva ` +
  `(su conversación cambió hace menos de ${HILO_VIVO_MIN} min); si no, se relanza en el paso del pase adversarial`;

/** HH:MM en la hora de la máquina (la que ve el dueño). */
function horaCorta(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '??:??';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Hace cuántos minutos cambió la conversación de una sesión, o null si no se encuentra. Mismo criterio que
 * `scripts/hooks/session-collision-guard.js`: la fecha de modificación de `~/.claude/projects/<carpeta>/<sid>.jsonl`.
 */
function minutosDesdeElHilo(sid, { home = os.homedir(), ahora = Date.now() } = {}) {
  if (!sid) return null;
  const base = path.join(home, '.claude', 'projects');
  let carpetas = [];
  try { carpetas = fs.readdirSync(base); } catch { return null; }
  let mejor = null;
  for (const c of carpetas) {
    try {
      const st = fs.statSync(path.join(base, c, `${sid}.jsonl`));
      const min = (ahora - st.mtimeMs) / 60000;
      if (mejor === null || min < mejor) mejor = min;
    } catch { /* no está en esta carpeta */ }
  }
  return mejor;
}

/**
 * Qué hacer con un lanzamiento de otra sesión sin resultado. Devuelve la acción pendiente de `next`:
 * `{ kind: 'esperar-pase-ajeno' | 'relanzar-pase-ajeno', message, rule, why }`.
 */
function reglaPaseAjeno(adv, opts = {}) {
  const ahora = opts.ahora || Date.now();
  const sid = String(adv.sessionId || '?');
  const desde = Date.parse(adv.launchedAt);
  const edadMin = Number.isFinite(desde) ? (ahora - desde) / 60000 : null;
  const hiloMin = minutosDesdeElHilo(adv.sessionId, { home: opts.home, ahora });
  const reciente = edadMin !== null && edadMin < ESPERA_MAX_MIN;
  const viva = hiloMin !== null && hiloMin < HILO_VIVO_MIN;
  const cuando = `pase lanzado por otra sesión (${sid.slice(0, 8)}) a las ${horaCorta(adv.launchedAt)}, sin resultado`;
  const edad = edadMin === null ? 'sin hora de lanzamiento legible' : `lanzado hace ${Math.round(edadMin)} min`;
  const hilo = hiloMin === null ? 'su conversación no está en esta máquina' : `su conversación cambió hace ${Math.round(hiloMin)} min`;
  if (reciente && viva) {
    return {
      kind: 'esperar-pase-ajeno',
      message: `${cuando}: se ESPERA su resultado (lo anota esa sesión con mark-adversarial-result). Seguí con los revisores; no lo relances.`,
      rule: REGLA_PASE_AJENO,
      why: `${edad} y ${hilo}`,
    };
  }
  return {
    kind: 'relanzar-pase-ajeno',
    message: `${cuando}: se RELANZA en el paso del pase adversarial (5b, §JOIN de step-05b-adversarial-verify.md).`,
    rule: REGLA_PASE_AJENO,
    why: !reciente ? `${edad} (tope ${ESPERA_MAX_MIN} min)` : `${edad}, pero ${hilo} (tope ${HILO_VIVO_MIN} min)`,
  };
}

module.exports = {
  veredictoPaseAdversarial, paseAtendido, reglaPaseAjeno, minutosDesdeElHilo, horaCorta,
  ESPERA_MAX_MIN, HILO_VIVO_MIN, REGLA_PASE_AJENO,
};
