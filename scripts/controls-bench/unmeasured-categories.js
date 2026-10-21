'use strict';
/**
 * ¿Qué rubros del examen de revisores esta corrida NO PUDO medir?
 *
 * 🔴 El trabajo nocturno es el chequeo de vida: una corrida por caso, una sola herramienta, ~12 min en vez de ~3 h.
 * Esa corrida no puede medir todo, pero el reporte igual PUBLICA `inestables: 0 · paridadReal: 0 · parityBreaks: 0`, y
 * el aviso de arranque los mostraría en cada sesión al lado de los que sí se midieron:
 *
 *     1 de criterio (el revisor razona mal) · 0 inestables (cambia de opinión entre corridas)
 *     · paridad rota 0 · regresiones 0 · 1 salteados por MCP ausente (constancia, no verde)
 *
 * Con UNA corrida por caso, "el revisor contesta distinto entre corridas" no tiene con qué compararse; con UNA
 * herramienta, "las dos coinciden" tampoco. Los dos ceros no dicen "medí y no hay": dicen "no miré". Es la regla
 * cardinal del arnés al revés —"no medido" pintado de cero— y justo en la pieza que existe para vigilar a los
 * revisores. El aviso ya sabe hacerlo bien con "salteados por MCP ausente (constancia, no verde)"; estos dos,
 * sin esta pieza, no.
 *
 * 🔴 POR QUÉ ES UN ARCHIVO APARTE, y no una función adentro de `advisor-runner.js`: requerir el corredor ARRANCA el
 * banco entero (no tiene guarda de "sólo si me ejecutan" — es el mismo motivo por el que `advisor-runner.js --help`
 * dispara una corrida completa en vez de imprimir ayuda). La lógica que hay que poder probar barato tiene que vivir
 * afuera. Mismo criterio, y mismo vecindario, que `report-name.js`.
 *
 * 🔴 POR QUÉ LO USAN LOS DOS LADOS —el que escribe el reporte y el que lo lee—: si sólo lo aplicara el productor, un
 * reporte ya escrito seguiría mintiendo hasta la próxima corrida nocturna. El consumidor lo deriva de `tool` y
 * `runs`, que todo reporte trae, así que la salida se corrige en el arranque siguiente.
 */

/**
 * @param {{tool?: string, runs?: number}} corrida — cómo se produjo el reporte.
 * @returns {{inestables: string|null, paridad: string|null}} motivo en castellano por rubro que
 *   NO se pudo medir, o `null` si ese rubro sí se midió.
 *
 * 🔴 Un reporte que no declara CÓMO se produjo no se juzga: sin `runs` no se puede afirmar que no
 * midió la inestabilidad, y sin `tool` tampoco la paridad — inventarlo sería el error simétrico al
 * que esta pieza cierra (denunciar de más también hace que un control se apague). Los reportes
 * reales siempre traen los dos campos: `advisor-runner.js` los escribe en cada corrida.
 */
function rubrosNoMedidos(corrida) {
  const c = corrida || {};
  // `null`/`undefined`/vacío = "no declarado", y no se juzga. `Number(null)` es 0 —finito— y
  // sin esta guarda un `runs: null` se leería como "0 corridas por caso".
  const runs = c.runs === null || c.runs === undefined || c.runs === '' ? NaN : Number(c.runs);
  const tool = c.tool === undefined || c.tool === null || String(c.tool).trim() === ''
    ? null : String(c.tool).trim().toLowerCase();

  // Los motivos van en el aviso de arranque, que se lee todos los días: cortos, y con el comando
  // que sí mediría el rubro — lo accionable, no la explicación.
  const inestables = Number.isFinite(runs) && runs < 2
    ? `${runs} corrida por caso; hacen falta al menos 2 (--runs 2)`
    : null;

  const paridad = tool !== null && tool !== 'both'
    ? `una sola herramienta, ${tool}; hacen falta las dos (--tool both)`
    : null;

  return { inestables, paridad };
}

module.exports = { rubrosNoMedidos };
