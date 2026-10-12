'use strict';
/**
 * closing-evidence — LA definición de «qué archivo cuenta como evidencia de cierre» de una story.
 *
 * ── Por qué existe (2026-09-06) ──────────────────────────────────────────────────────────────
 * El criterio vivía en CUATRO lugares y decían cosas distintas: el freno del Edit aceptaba
 * cualquier `<id>-*.md` (matriz y self-audit incluidos), el freno del commit y el portón de CI
 * excluían tres sufijos, y el medidor del tablero contaba cualquier `<id>-*` — hasta un `.jsonl`.
 * Consecuencia medida: una story podía pasar el freno del Edit, figurar «cubierta» en el tablero,
 * y rebotar en el commit y en el pull request. Un repo con tres stories `done` daba 3/3 en el
 * tablero y dos de tres rechazadas por el portón.
 *
 * Cuatro copias de un criterio son el drift de mañana, y acá el drift ya había ocurrido. Ahora hay
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
 *   · 🔴 `-smoke-ledger.jsonl` — DECISIÓN DEL DEV (2026-09-06): el ledger es el registro crudo de
 *     cada prueba que corrió contra la aplicación —comando, ACs que verifica, código de salida—
 *     escrito por la máquina en el momento (`smoke-run.sh`). Es MÁS difícil de falsear que un
 *     informe redactado, no menos. Medido antes de decidir: es el archivo más frecuente en
 *     `dod-runtime/` de los repos grandes (un repo del equipo: 116 ledgers contra ~8 informes), y sin
 *     contarlo la story 1.1 del arnés —64 smokes reales— figuraba «sin evidencia». Como la
 *     definición es UNA, las cuatro capas cambiaron juntas: el tablero, el portón y los dos frenos.
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

module.exports = { NO_ES_EVIDENCIA_DE_CIERRE, ES_EVIDENCIA_ADEMAS, esEvidenciaDeCierre };
