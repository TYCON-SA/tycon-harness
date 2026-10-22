'use strict';
/**
 * adversarial-verdict.js — ¿el pase adversarial está atendido? Y qué hacer con uno de otra sesión.
 * Lo usan `marker.js` (el freno de «Preparar el commit») y `pipeline.js` (`next`): una sola copia del criterio.
 *
 * `veredictoPaseAdversarial` vive acá y no en `marker.js` (que no exporta nada) para que `next` lo use: sin
 * él, `next` pediría relanzar siempre un pase de otra sesión —también uno ya cerrado, y relanzar un pase cerrado bloquea «Preparar el commit».
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * ¿El pase adversarial quedó atendido? Pura: lee el marker y devuelve
 * `{ veredicto: 'paso'|'bloqueo', motivo, runId, launchedAt }`.
 *
 * Lanzado → pasa con un resultado `tipo: '5b'` anotado en o después del ÚLTIMO lanzamiento (`resultado`), o con
 * el abandono de ESE lanzamiento (`abandonado`); si los resultados que hay son de un lanzamiento anterior —el
 * pase se relanzó— bloquea (`resultado-de-otro-lanzamiento`); sin nada, `sin-resultado`.
 * No lanzado → pasa con el salteo que decidió el portón (`salteado` / `salteado-forzado`), o con un resultado del pase
 * anotado aunque nadie haya registrado el lanzamiento (`resultado-sin-lanzamiento`), y si no, `no-atendido`:
 * la bandera `deepReviewDone` de una corrida vieja NO cuenta, porque es justo lo que cualquiera escribía a mano.
 * «No lo pude leer» no es «está»: un registro que no es lista o un lanzamiento sin fecha bloquean con su nombre.
 * Un último resultado `no-medido` (alguna lente sin medir o algún hallazgo sin veredicto) bloquea como
 * `pase-no-medido`: el pase que no revisó todo es un pase que falta.
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
    const vigentes = del5b.filter((p) => Date.parse(p.ts) >= desde);
    // El abandono de ESTE lanzamiento con el interruptor es la decisión del dev y gana: es la salida que el propio
    // freno del pase no medido ofrece (con el orden al revés, no destrabaría). Casos: tests/adversarial-unmeasured.test.js.
    if (skip && skip.abandonado === true && skip.runId === runId) return res('paso', 'abandonado');
    // Un pase que no revisó todo es un pase que falta: cuenta el ÚLTIMO resultado del lanzamiento.
    if (vigentes.length && vigentes[vigentes.length - 1].veredicto === 'no-medido') return res('bloqueo', 'pase-no-medido', { pase: vigentes[vigentes.length - 1] });
    if (vigentes.length) return res('paso', 'resultado');
    if (del5b.length) return res('bloqueo', 'resultado-de-otro-lanzamiento');
    return res('bloqueo', 'sin-resultado');
  }
  if (skip) return res('paso', skip.forzado === true || skip.abandonado === true ? 'salteado-forzado' : 'salteado');
  // Resultado del pase anotado sin lanzamiento registrado:
  // el resultado ES la constancia que el paso pide; queda con su propio motivo, visible en el registro.
  const del5b = pases.filter((p) => p && p.tipo === '5b');
  if (del5b.length && del5b[del5b.length - 1].veredicto === 'no-medido') return res('bloqueo', 'pase-no-medido', { pase: del5b[del5b.length - 1] });
  if (del5b.length) return res('paso', 'resultado-sin-lanzamiento');
  return res('bloqueo', 'no-atendido');
}

/**
 * Para `next`: «atendido» es `paso`, y también un `bloqueo` por `resultado-de-otro-lanzamiento`
 * —ése lo frena «Preparar el commit», y pedir otro lanzamiento desde `next` lo empeora—.
 */
function paseAtendido(v) {
  return !!v && (v.veredicto === 'paso' || v.motivo === 'resultado-de-otro-lanzamiento');
}

// La regla para un pase lanzado por otra sesión y sin resultado (sin preguntarle a
// nadie). Preguntar sería una espera humana nueva justo donde se quieren ganar minutos; relanzar siempre
// tiraría 20 a 40 minutos cuando la otra sesión sigue viva y entrega sola.
const ESPERA_MAX_MIN = 45;
const HILO_VIVO_MIN = 10;
const REGLA_PASE_AJENO =
  `se espera si el lanzamiento tiene menos de ${ESPERA_MAX_MIN} min y la sesión que lo lanzó sigue viva ` +
  `(su conversación cambió hace menos de ${HILO_VIVO_MIN} min); si no, se relanza en el paso del pase adversarial`;

/** HH:MM en la hora de la máquina (la que ve quien usa la máquina). */
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
    message: `${cuando}: se RELANZA en el paso del pase adversarial (§JOIN de step-08-adversarial-pass.md).`,
    rule: REGLA_PASE_AJENO,
    why: !reciente ? `${edad} (tope ${ESPERA_MAX_MIN} min)` : `${edad}, pero ${hilo} (tope ${HILO_VIVO_MIN} min)`,
  };
}

// La salida aprobada cuando Codex no contesta y la sesión no tiene la herramienta Workflow.
// 🔴 El guion del pase lleva una copia LITERAL (corre en una caja sin `require`):
// `tests/adversarial-unmeasured.test.js` T9 compara las dos.
const SALIDA_APROBADA = 'la salida aprobada: un pase propio con agentes de Claude — cazadores con Sonnet, un verificador aparte por hallazgo que corre el código, juicio con Opus, nunca Fable (workflow-lite.js --agents-dir, step-08-adversarial-pass.md §«Sin Codex ni Workflow»)';

/**
 * ¿El resultado del pase revisó todo? Pura: recibe el objeto que devolvió el guion y devuelve
 * `{ medido, confirmados, lentes_sin_medir, hallazgos_sin_veredicto, motivo }`. Medido = todas las lentes con su
 * cazador contestado y ningún hallazgo sin veredicto. Un resultado sin el campo `lentes` o con la lista vacía
 * (sin archivos que auditar) no está medido: «no revisé nada» nunca es «limpio».
 */
function medicionDelResultado(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('el resultado no es un objeto JSON');
  // Sin la lista de confirmados no se sabe cuántos hubo: no se cuenta 0 (un `<N>` de 0 pasaría como `listo`).
  if (!Array.isArray(obj.confirmed)) throw new Error('el resultado no trae la lista `confirmed`: no se sabe cuántos hallazgos confirmó');
  const confirmados = obj.confirmed.length;
  if (!Array.isArray(obj.lentes)) {
    return { medido: false, confirmados, lentes_sin_medir: [], hallazgos_sin_veredicto: 0,
      motivo: 'el resultado no trae el estado de cada lente (un formato anterior): no se sabe qué se revisó' };
  }
  if (!obj.lentes.length) {
    return { medido: false, confirmados, lentes_sin_medir: [], hallazgos_sin_veredicto: 0, motivo: 'el pase no revisó ninguna lente (sin archivos de código)' };
  }
  const sinMedir = obj.lentes.filter((l) => !l || l.estado !== 'medida').map((l) => (l && l.lens) || '?');
  const detalle = Array.isArray(obj.detalle) ? obj.detalle : [];
  const sinVeredicto = detalle.filter((d) => d && d.estado === 'sin-veredicto').length;
  const partes = [];
  if (sinMedir.length) partes.push(`${sinMedir.length} lente(s) sin medir (${sinMedir.join(', ')}): su cazador no contestó`);
  if (sinVeredicto) partes.push(`${sinVeredicto} hallazgo(s) sin veredicto: su verificador no contestó`);
  return { medido: partes.length === 0, confirmados, lentes_sin_medir: sinMedir, hallazgos_sin_veredicto: sinVeredicto, motivo: partes.join('; ') || null };
}

module.exports = {
  SALIDA_APROBADA, medicionDelResultado,
  veredictoPaseAdversarial, paseAtendido, reglaPaseAjeno, minutosDesdeElHilo, horaCorta,
  ESPERA_MAX_MIN, HILO_VIVO_MIN, REGLA_PASE_AJENO,
};
