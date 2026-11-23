'use strict';
/**
 * review-change-policy.js — qué pide un archivo cambiado después de la última vuelta de revisores, según lo que cambió
 * adentro (lib/change-kind.js). Lo usan los dos frenos de lo revisado (lib/steps.js `reviewersRound` y la comparación
 * del sello, lib/frozen-tree.js `changed`) y el re-loop de revisores (pipeline.js smart-reloop).
 *
 *   · `igual` y `comentarios` no piden otra vuelta: el código que se guarda es el revisado.
 *   · `textos` (cadenas, plantillas, texto de JSX) piden una vuelta chica: sólo los revisores de
 *     REVISORES_DE_LA_VUELTA_CHICA, sin firma, también pasado el tope de vueltas. Una cadena puede ser una consulta o una
 *     ruta, y así alguien la mira.
 *   · `codigo` pide la vuelta de siempre; pasado el tope, la vuelta extra con su firma.
 *
 * Las dos decisiones del dueño se cambian acá:
 *   · TEXTOS_CON_VUELTA_CHICA: en `false`, un cambio sólo de textos no pide ninguna vuelta.
 *   · El código cambiado después del tope pide la vuelta extra. La otra opción, dejarlo como deuda visible, necesita su
 *     renglón en el mensaje del commit, que arma marker.js: se agrega cuando el dueño la elija.
 */

const TEXTOS_CON_VUELTA_CHICA = true;
const REVISORES_DE_LA_VUELTA_CHICA = Object.freeze(['tycon-plugin-security-basics']);

/** ¿Un archivo con este tipo de cambio (`change-kind.js`) pide otra vuelta? Un tipo que no se conoce, sí. */
function pideVuelta(tipo, { textosConVueltaChica = TEXTOS_CON_VUELTA_CHICA } = {}) {
  if (tipo === 'igual' || tipo === 'comentarios') return false;
  if (tipo === 'textos') return textosConVueltaChica;
  return true;
}

module.exports = { TEXTOS_CON_VUELTA_CHICA, REVISORES_DE_LA_VUELTA_CHICA, pideVuelta };
