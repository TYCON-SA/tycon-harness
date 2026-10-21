'use strict';

/**
 * Resolución ÚNICA del session id del arnés.
 *
 * El marker, el ledger de spawns de advisors y los gates viven todos bajo este id, y lo
 * resuelven desde DOS puntas distintas: los hooks lo reciben en el `session_id` del payload,
 * los comandos CLI lo leen del ambiente. Si las dos puntas no convergen al MISMO valor el
 * estado se parte en dos — sin dar error: el hook escribe bajo un id y el CLI lee otro,
 * encuentra vacío, y reporta con total honestidad que no hay nada.
 *
 * Cadena, en orden: el id que expone la herramienta anfitriona (Claude Code), el override
 * explícito del banco de pruebas, el id nativo de Codex, y `_nosession` como sentinel.
 *
 * `CODEX_SESSION_ID`: Codex lo exporta al
 * ambiente de TODO shell que corre el modelo, con el mismo valor que manda en el `session_id`
 * de cada payload de hook — o sea que ata las dos puntas sin que nadie tenga que exportar
 * nada. Sin este eslabón el CLI caería a `_nosession` mientras los hooks escriben bajo el id
 * real de la sesión: el marker arrancaría huérfano y `check-count` leería un ledger vacío
 * ("CERO spawns registrados") con los advisors REALMENTE corridos, lo que empujaría al
 * `--trust-ran` y de ahí al `--force-manual`.
 *
 * `TYCON_SESSION_ID` va ANTES que el nativo a propósito: es el override del banco de pruebas,
 * y un banco que no puede fijar la identidad de la sesión no puede aislar sus casos.
 */

/**
 * @param {string|null|undefined} eventSessionId  el `session_id` del payload, si esto corre en un hook
 * @returns {string} el id resuelto (nunca vacío — `_nosession` si no hay ninguno)
 */
function resolveSessionId(eventSessionId) {
  return eventSessionId
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.TYCON_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || '_nosession';
}

/**
 * El mismo id, saneado para usarse como NOMBRE DE ARCHIVO (`active/<sid>.json`,
 * `advisor-runs/<sid>.jsonl`). Las barras se reemplazan porque un id con `/` escribiría
 * fuera del directorio de estado.
 *
 * @param {string|null|undefined} eventSessionId
 * @returns {string}
 */
function sessionIdFileKey(eventSessionId) {
  return String(resolveSessionId(eventSessionId)).replace(/[/\\]/g, '_');
}

module.exports = { resolveSessionId, sessionIdFileKey };
