'use strict';
/**
 * restore-steps.js — dos reglas de `marker.js restore <sesión>`, como funciones que se prueban sin firmar.
 *
 * `pisaMarcadorVivo`: un restore desde la terminal sin `--for-session` cae en la sesión `_nosession`. Si ahí vive el
 * marcador de OTRA historia, tocado hace menos que el plazo de la poda (story-gate-io.js `STALE_HOURS`), el restore no
 * lo pisa: frena antes de la firma y sin cerrar nada. Con la misma historia, con uno vencido o en una sesión con nombre,
 * sigue como siempre (el previo se cierra como «reemplazada»).
 *
 * `correrRestore`: el orden de lo que hace el restore después de la firma. Primero se escribe el marcador nuevo con la
 * lista de lo que falta (`restorePendiente`); recién después corren los cierres y la apertura nueva, de a uno. Cada paso
 * hecho sale de la lista y el marcador se vuelve a escribir. Un paso que tira o devuelve `false` corta ahí y deja en la
 * lista ese paso y los siguientes, con sus datos: el marcador nuevo pisa el archivo del que se leyó el previo, así que la
 * repetición no tiene otro lugar de donde sacarlos. Repetir el mismo restore corre sólo lo que quedó.
 */

const ORDEN = ['apertura', 'reemplazada', 'abrir', 'podada'];

/**
 * ¿El restore pisaría el marcador vivo de otra historia en `_nosession`? null (sigue), o `{ historia, ultimoToque }`.
 * Un último toque que no se puede leer cuenta como vivo: ante la duda, no se pisa.
 */
function pisaMarcadorVivo({ sid, previo, story, ahora = Date.now(), staleHours }) {
  if (sid !== '_nosession' || !previo || !previo.storyId) return null;
  if (String(previo.storyId) === String(story)) return null;
  const t = Date.parse(previo.lastTouch || '');
  if (Number.isFinite(t) && ahora - t > staleHours * 3600 * 1000) return null;
  return { historia: String(previo.storyId), ultimoToque: previo.lastTouch || null };
}

/**
 * Corre los pasos de `pendiente.pasos` en orden. `pasos` trae una función por nombre (`apertura`, `reemplazada`,
 * `abrir`, `podada`) que recibe los datos del paso; `escribirMarcador(pendiente)` guarda la lista que queda. Devuelve
 * `{ ok: true }`, o `{ ok: false, falto, error }` con el paso que no se pudo (`marcador` si no se pudo ni escribir el
 * marcador: entonces no corrió nada).
 */
function correrRestore({ pendiente, pasos, escribirMarcador }) {
  const resto = { ...pendiente, pasos: [...(pendiente.pasos || [])] };
  try { escribirMarcador(resto); } catch (e) { return { ok: false, falto: 'marcador', error: (e && e.message) || String(e) }; }
  while (resto.pasos.length) {
    const paso = resto.pasos[0];
    let hecho;
    let error = null;
    try { hecho = pasos[paso.que](paso) !== false; } catch (e) { hecho = false; error = (e && e.message) || String(e); }
    if (!hecho) return { ok: false, falto: paso.que, error };
    resto.pasos.shift();
    try { escribirMarcador(resto); } catch (e) { return { ok: false, falto: resto.pasos.length ? resto.pasos[0].que : 'marcador', error: (e && e.message) || String(e) }; }
  }
  return { ok: true };
}

module.exports = { ORDEN, pisaMarcadorVivo, correrRestore };
