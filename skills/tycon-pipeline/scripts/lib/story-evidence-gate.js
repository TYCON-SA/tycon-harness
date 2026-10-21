/**
 * story-evidence-gate.js — que no se saltee ni un AC, ni los pasos de tester, ni la verificación
 * en navegador de una story de interfaz.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * Sobre UNA sola story pueden pasarse TRES cosas distintas, y
 * las tres las encontraría el dev leyendo la guía de QA, no el harness:
 *
 *   1. No se escribe el archivo de pasos de tester (`specs/qa/<sid>-pasos.md`), así que la guía muestra
 *      el texto TÉCNICO del AC — `configSchema.configuration`, `client-column-filters` — a alguien
 *      que tiene que probar la pantalla. El generador ya avisa; nadie lee el aviso.
 *   2. Se verifican 3 de 4 ACs y el cuarto queda sin correr, sin declararlo.
 *   3. La verificación en navegador se corre A MANO, así que no llega al ledger: la guía sigue
 *      diciendo "0 verificados corriendo la app" aunque el navegador se haya abierto.
 *
 * Las tres son la MISMA falla: trabajar fuera del pipeline apaga sus garantías en silencio. La cura
 * no es más texto normativo — es que al commitear alguien pregunte.
 *
 * ── CALIBRACIÓN ──────────────────────────────────────────────────────────────────────────────────
 * Igual que los otros gates de esta familia: **avisa** por default y queda en `gates.log`; bloquea
 * sólo si el repo lo pide (`.tycon/atdd-gate` con `block` o `TYCON_ATDD_COMMIT_GATE=block`); `off`
 * lo apaga. Un gate que bloquea de más se termina desactivando, y ahí no protege de nada.
 */

'use strict';

const path = require('path');

/**
 * Qué ACs se quedaron sin pasos escritos en lenguaje de tester.
 * Reusa el parser de `qa-guide.js` — el archivo de pasos tiene UN formato y lo define él.
 */
function acsSinPasos(acs, pasosMd) {
  if (!Array.isArray(acs) || acs.length === 0) return [];
  if (!pasosMd) return [...acs];
  const parsed = require(path.join(__dirname, '..', 'qa-guide.js')).parsePasos(pasosMd);
  return acs.filter((n) => {
    const p = parsed[n];
    return !p || (!p.desc && (!p.pairs || p.pairs.length === 0));
  });
}

/**
 * ¿El comando registrado en el ledger abrió un navegador?
 * Heurística deliberadamente amplia: lo que se busca es distinguir "se ejercitó la UI" de
 * "se pegó a un endpoint con curl", no clasificar con precisión.
 */
function looksLikeBrowserRun(cmd) {
  const s = String(cmd || '').toLowerCase();
  if (/curl|dotnet\s+test|sqlcmd|psql/.test(s)) return false;
  return /playwright|puppeteer|chromium|cypress|\bbrowser\b|\.cjs\b|e2e/.test(s);
}

/**
 * Decide qué hacer. PURA — recibe hechos ya computados y devuelve la acción + los hallazgos.
 *
 * @param {{pendientes:number[], acsSinPasos:number[], isUi:boolean, hasBrowserEvidence:boolean,
 *          mode:'off'|'warn'|'block'}} args
 * @returns {{action:'pass'|'warn'|'block', hallazgos:string[], message:string}}
 */
function computeStoryEvidenceGate({ pendientes = [], acsSinPasos: sinPasos = [], isUi = false,
  hasBrowserEvidence = false, mode = 'warn' } = {}) {
  if (mode === 'off') return { action: 'pass', hallazgos: [], message: '' };

  const hallazgos = [];

  if (pendientes.length) {
    hallazgos.push(
      `Quedaron ACs sin verificar corriendo la app: AC ${pendientes.join(', ')}. ` +
      `Si alguno NO se puede verificar así, declaralo en \`runtime_not_verifiable:\` con su razón — ` +
      `saltearlo en silencio es lo que hay que evitar.`);
  }

  if (sinPasos.length) {
    hallazgos.push(
      `Sin pasos de tester para: AC ${sinPasos.join(', ')}. Sin eso la guía de QA le muestra a quien ` +
      `prueba el texto técnico del AC. Escribilos en \`specs/qa/<story>-pasos.md\` (formato: \`## AC N\`, ` +
      `una línea de descripción, y pares \`- hacé esto\` / \`→ tenés que ver esto\`).`);
  }

  if (isUi && !hasBrowserEvidence) {
    hallazgos.push(
      `Es una story de interfaz y NO hay evidencia registrada de haberla abierto en un navegador. ` +
      `Correr el smoke a mano no cuenta: tiene que ir por \`smoke-run.sh\` para que quede en el ledger ` +
      `(si no, la guía de QA sigue diciendo "0 verificados corriendo la app").`);
  }

  if (hallazgos.length === 0) return { action: 'pass', hallazgos: [], message: '' };

  return {
    action: mode === 'block' ? 'block' : 'warn',
    hallazgos,
    message: hallazgos.map((h) => `  • ${h}`).join('\n'),
  };
}

/**
 * ¿Corresponde controlar la evidencia en ESTE commit?
 *
 * 🔴 Sólo cuando la story pasa a `review`/`done` — el momento en que alguien AFIRMA que está lista.
 * NO en cada commit: correr siempre que el commit toque una story
 * con ACs incluiría el commit donde la story recién se escribe (nada verificado, obviamente) y cada
 * commit intermedio de la implementación. Eso es ruido, y un gate ruidoso se ignora o se apaga.
 * Mismo disparador que el gate de DoD.
 *
 * Nota: NO depende de la rama. Da igual dev o main; lo que importa es la afirmación de que terminó.
 */
function shouldCheckEvidence(oldStatus, newStatus) {
  const declaraTerminado = new Set(['review', 'done']);
  const antes = String(oldStatus || '').trim().toLowerCase();
  const ahora = String(newStatus || '').trim().toLowerCase();
  if (!declaraTerminado.has(ahora)) return false;
  return antes !== ahora;
}

/**
 * ¿Corresponde pedir los PASOS DE TESTER de esta story?
 *
 * 🔴 La misma respuesta que da el generador de la guía de QA, y por la misma razón — que es todo el
 * punto de esta función. Los pasos de tester existen para UNA cosa: que la guía no le muestre a
 * quien prueba el texto técnico del AC. Si en ese repo no se genera guía —porque el repo la apagó, o
 * porque el producto no tiene ninguna superficie que una persona pueda manejar— entonces no hay
 * ningún lector al que se le pueda mostrar nada, y pedir los pasos es pedir un archivo para nadie.
 *
 * Caso: el generador de la guía consulta la escotilla del repo (`qa_guide: off|auto|always`) y el criterio de «hay algo operable
 * a mano»; este control también. Sobre un servidor MCP sin pantalla ni endpoints, el generador se calla
 * bien y este control, si no los consultara, acusaría igual. Una escotilla documentada que sólo
 * apaga la mitad de los avisos es peor que no tenerla: el dev la declara, el ruido sigue, y aprende
 * que el arnés no se puede callar.
 *
 * Fail-open: sin datos, se piden. Un control nuevo que se calla por
 * accidente es exactamente lo que no queremos.
 *
 * @param {{qaGuideMode?: 'off'|'auto'|'always', handOperable?: boolean}} args
 * @returns {boolean}
 */
function pidePasosDeTester({ qaGuideMode, handOperable } = {}) {
  if (qaGuideMode === 'off') return false;
  if (qaGuideMode === 'always') return true;
  // `auto` (y cualquier valor no reconocido, igual que `qaGuideMode()`): manda la superficie.
  return handOperable !== false;
}

module.exports = {
  acsSinPasos, looksLikeBrowserRun, computeStoryEvidenceGate, shouldCheckEvidence, pidePasosDeTester,
};
