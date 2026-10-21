'use strict';
/**
 * closing-evidence — LA definición de «qué archivo cuenta como evidencia de cierre» de una story.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Si el criterio vive en CUATRO lugares, dicen cosas distintas: el freno del Edit aceptaría
 * cualquier `<id>-*.md` (matriz y self-audit incluidos), el freno del commit y el portón de CI
 * excluyen tres sufijos, y el medidor del tablero contaría cualquier `<id>-*` — hasta un `.jsonl`.
 * Una story podría pasar el freno del Edit, figurar «cubierta» en el tablero, y rebotar en el commit
 * y en el pull request.
 *
 * Cuatro copias de un criterio son el drift de mañana. Por eso hay
 * UNA definición: la importan los dos hooks del skill, y el portón de CI —que corre en un agente
 * sin `~/.claude/`, así que no puede importarla— lleva una COPIA deliberada que
 * `~/.claude/tycon-harness/scripts/tests/closing-evidence-parity.test.js` compara contra ésta en
 * cada corrida, con el mismo mecanismo que ya cuida la paridad del roster.
 *
 * ── Qué NO es evidencia de cierre, y por qué ─────────────────────────────────────────────────
 *   · `-runtime-matrix.md` — la matriz por AC lista los ACs INCLUIDOS los que no tienen evidencia:
 *     si contara como evidencia, laundearía el chequeo por AC (todo AC «mencionado» → falso verde).
 *   · `-self-audit*.md` — lo escribe el agente libremente (ACCOV-C8); es la declaración, no la prueba.
 *   · `-manual-test-plan.md` — es el plan, no su ejecución.
 *   · cualquier otro archivo que no sea `.md` (drivers `.mjs`, sondas, temporales).
 *
 * ── Qué SÍ es, además del informe `.md` ─────────────────────────────────────────────────────
 *   · 🔴 `-smoke-ledger.jsonl`: el ledger es el registro crudo de
 *     cada prueba que corrió contra la aplicación —comando, ACs que verifica, código de salida—
 *     escrito por la máquina en el momento (`smoke-run.sh`). Es MÁS difícil de falsear que un
 *     informe redactado, no menos. Es el archivo más frecuente en
 *     `dod-runtime/` de los repos grandes (116 ledgers contra ~8 informes en uno del equipo), y sin
 *     contarlo una story con 64 smokes reales figuraría «sin evidencia». Como la
 *     definición es UNA, las cuatro capas cambian juntas: el tablero, el portón y los dos frenos.
 */

const NO_ES_EVIDENCIA_DE_CIERRE = [
  /-self-audit(?:-iter\d+)?\.md$/,
  /-runtime-matrix\.md$/,
  /-manual-test-plan\.md$/,
];
const ES_EVIDENCIA_ADEMAS = [/-smoke-ledger\.jsonl$/];

/** @param {string} nombre  nombre de archivo (sin ruta) dentro de `.advisors/dod-runtime/` */
function esEvidenciaDeCierre(nombre) {
  const f = String(nombre || '');
  if (ES_EVIDENCIA_ADEMAS.some((re) => re.test(f))) return true;
  return f.endsWith('.md') && !NO_ES_EVIDENCIA_DE_CIERRE.some((re) => re.test(f));
}

/*
 * ── La unión de las tres fuentes, por AC ───────────────────────────────────────
 * Elegir UN archivo de evidencia (el que nombra más criterios) y exigirle que nombre TODOS no sirve: las
 * stories que reparten la evidencia en lo que escribe la máquina —el registro de pruebas de humo, los gates
 * E2E y las firmas del dev— no tienen un archivo que nombre todo, y casi cada cierre rebotaría hasta habilitar a
 * mano una escritura para que el agente redacte un `<id>-cierre.md` con la lista. Un resumen escrito por el
 * agente reemplazaría a tres fuentes escritas por la máquina: lo más falsificable le ganaría a lo menos.
 *
 * Por eso un AC cuenta si aparece en la UNIÓN de las tres, con las MISMAS reglas de validez de la matriz
 * por AC (runtime-matrix.js), sin recalcularlas acá: se lee el resultado de `compute()`.
 *   · smoke  — una corrida del registro con salida 0, copia en gates.log y posterior al último cambio de
 *              código (la matriz descarta las demás antes de anotarlas).
 *   · e2e    — una fila E2E de la tabla `### Tests` con un gate PASS, con su copia en gates.log y fresco.
 *   · firma  — el AC quedó aprobado por el dev desde su terminal, vigente para su declaración
 *              (veredicto WAIVED-USER: la matriz sólo lo da si la firma engancha con la declaración actual).
 * La matriz, el self-audit y el plan manual siguen sin contar (arriba): esto no los mira.
 */
function coberturaDeLaUnion(matriz) {
  const porAc = new Map();
  if (!matriz || matriz.structuralError || matriz.exempt || !matriz.perAc) return { porAc, cubiertos: new Set() };
  for (const [k, v] of Object.entries(matriz.perAc)) {
    const f = [];
    if (v && v.fuentes && v.fuentes.smoke && v.fuentes.smoke.length) f.push('smoke');
    if (v && v.fuentes && v.fuentes.e2e && v.fuentes.e2e.length) f.push('e2e');
    if (v && v.verdict === 'WAIVED-USER') f.push('firma');
    if (f.length) porAc.set(Number(k), f);
  }
  return { porAc, cubiertos: new Set(porAc.keys()) };
}

module.exports = { NO_ES_EVIDENCIA_DE_CIERRE, ES_EVIDENCIA_ADEMAS, esEvidenciaDeCierre, coberturaDeLaUnion };
