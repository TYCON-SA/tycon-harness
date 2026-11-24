'use strict';

/**
 * automatic-signing.js — las firmas de trámite, que el arnés da solo.
 *
 * Una firma es de trámite si el perfil del equipo la nombra en `approvals.delegated_signing` (sus grupos, expandidos), no
 * la nombra en `approvals.owner_only`, y el catálogo la deja salir sin una persona (`signatures.js delegable`: la rutina
 * y las excepciones de trámite de nivel 2; nunca el nivel 3). Esa firma no abre ventana ni cuadro y no espera a la
 * coordinadora: la da el arnés, en cualquier sesión y en cualquier máquina, y su constancia la escribe `firmar` con la
 * vía `automatica`. Lo de contenido lo sigue comprobando el control previo de cada guion (la revisión del plan, la
 * rutina de la comparación, el repo del pendiente): lo que ese control niega va a una persona.
 *
 * Las dos listas se leen como las lee la delegación (`delegated-signing.js profileLists`): del perfil del árbol de este
 * arnés, con el lector de configuración. Moverlas es un pedido en el repo del perfil, no un cambio en la máquina.
 */

// lo que el arnés nunca firma solo, aunque el perfil lo liste: lo mismo que nunca se delega
const SOLO_DEL_DUENO = new Set(['adversarial-skip', 'review-skip']);
// lo que nunca sale solo aunque se delegue: la constancia tiene que nombrar a la persona que dio el ok, y la del trámite
// dice «el arnés» (write-findings la rechazaría después). Va por la delegación, que nombra al dueño, o por su click
const SIEMPRE_CON_PERSONA = new Map([['critical-waiver', 'un crítico lo decide una persona: va por la delegación o por el click del dueño, no como trámite']]);

/**
 * ¿`firma` es de trámite? `{ ok, motivo? }`. `perfil()` → `{ delegated_signing, owner_only, levels }`, para las
 * pruebas; sin él, las listas del perfil del equipo.
 */
function esDeTramite({ firma, perfil, env, home, arnes } = {}) {
  const no = (motivo) => ({ ok: false, motivo });
  if (typeof firma !== 'string' || !firma) return no('sin firma');
  const ds = require('./delegated-signing.js');
  if (SOLO_DEL_DUENO.has(firma)) return no(`«${firma}» es sólo del dueño`);
  if (ds.NUNCA_DELEGABLES.has(firma)) return no(ds.NUNCA_DELEGABLES.get(firma));
  const cat = require('./signatures.js');
  if (!cat.delegable(firma)) return no(`«${firma}» es sólo del dueño`);
  let a;
  try { a = perfil ? perfil() : ds.profileLists({ env, home, arnes }).approvals; } catch (e) { return no(`no pude leer el perfil del equipo (${e.message})`); }
  a = a || {};
  const malFormada = ['owner_only', 'delegated_signing'].find((k) => a[k] != null && !Array.isArray(a[k]) && typeof a[k] !== 'string');
  if (malFormada) return no(`no pude leer approvals.${malFormada} del perfil: no es una lista`);
  const ids = (v, o) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).flatMap((x) => cat.expand(x, o));
  if (ids(a.owner_only, { restringe: true }).includes(firma)) return no(`«${firma}» es sólo del dueño (approvals.owner_only)`);
  if (SIEMPRE_CON_PERSONA.has(firma)) return no(SIEMPRE_CON_PERSONA.get(firma));
  if (!ids(a.delegated_signing).includes(firma)) return no(`el perfil del equipo no la lista como trámite (approvals.delegated_signing)`);
  if (a.levels && typeof a.levels === 'object' && !cat.delegable(firma, a.levels)) return no(`«${firma}» es sólo del dueño: el perfil le subió el nivel (approvals.levels)`);
  return { ok: true };
}

/** ¿Todas las firmas de `firmas` son de trámite? `{ ok, motivo? }` con el motivo de la primera que no. */
function todasDeTramite(firmas, o = {}) {
  if (!Array.isArray(firmas) || !firmas.length) return { ok: false, motivo: 'sin firmas' };
  for (const firma of firmas) {
    const r = esDeTramite({ ...o, firma });
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** El firmante que dice la constancia de una firma automática. */
const FIRMANTE = 'arnés (firma de trámite)';

/** El aviso de una línea que deja la firma automática en la consola de la sesión. */
function aviso({ firma, destino, que }) {
  const s = require('./signatures.js').SIGNATURES.find((x) => x.id === firma);
  const nombre = s ? s.approves : firma;
  // por caracteres, no por unidades de UTF-16: un corte en medio de un emoji dejaría medio carácter
  const texto = [...String(que || '').replace(/\s+/g, ' ').trim()];
  return `✅ firma de trámite, la dio el arnés: ${nombre}${destino ? ` (sesión ${destino})` : ''}${texto.length ? ` — ${texto.length > 160 ? `${texto.slice(0, 160).join('')}…` : texto.join('')}` : ''}`;
}

module.exports = { esDeTramite, todasDeTramite, aviso, FIRMANTE, SOLO_DEL_DUENO };

