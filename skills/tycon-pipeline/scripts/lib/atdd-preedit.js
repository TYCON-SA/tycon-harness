/**
 * atdd-preedit.js — el freno de ATDD en el MOMENTO de la primera edición de código.
 *
 * ── POR QUÉ HIZO FALTA UNA TERCERA CAPA ──────────────────────────────────────────────────────────
 * Ya había dos frenos de ATDD y los dos son POST-MORTEM:
 *
 *   1. `lib/atdd-order.js` + `marker.js complete-step 4` → corre al CERRAR el step 4, o sea cuando la
 *      implementación entera ya está escrita.
 *   2. `lib/atdd-commit-gate.js` → corre al commitear, todavía más tarde.
 *
 * Los dos DETECTAN la inversión; ninguno la IMPIDE. Caso disparador (2026-07-30, máquina de otro dev
 * del equipo): el orquestador implementó las Tasks 2 a 9 completas —modelos, validador, repositorio,
 * servicio, endpoint— y recién pensaba escribir los tests en las Tasks 10-11. Lo cazó **el dev
 * leyendo el transcript**, otra vez, y lo cazó ANTES de que ninguno de los dos frenos llegara a
 * correr. El freno existía y no llegó a tiempo: para cuando el `complete-step 4` hubiera hablado, el
 * trabajo mal hecho ya estaba hecho y había que tirarlo.
 *
 * La conclusión no es "más texto normativo" (eso ya falló tres veces) ni "otro detector": es mover el
 * control al único punto donde todavía se puede evitar el daño — **la edición misma**. El hook
 * `PreToolUse` (Edit|Write) puede DENEGAR el tool call, así que el intento de escribir el primer
 * archivo de código sin un test tocado antes no ocurre. Es indiferente a qué skill esté manejando
 * (bmad-dev-story, quick-dev, el orquestador a mano) y a si alguien leyó el step file: no es una
 * instrucción, es un portón.
 *
 * ── LA EVIDENCIA ES LA MISMA DE SIEMPRE ──────────────────────────────────────────────────────────
 * Reusa `isTestPath` / `isImplPath` de `atdd-order.js` — un solo criterio de "qué es un test" para
 * los tres frenos. Los eventos previos los arma el HANDLER (`on-atdd-preedit.js`) como la unión de
 * `marker.fileEvents` y el `.jsonl` por sesión de `atdd-commit-gate.js` (que se graba SIEMPRE,
 * haya marker o no — cubre los tests escritos ANTES de crear el marker).
 *
 * ── CALIBRADO: por qué bloquea tan poco ──────────────────────────────────────────────────────────
 * Un portón que da falsos positivos se termina apagando, y apagado no sirve para nada. Entonces
 * bloquea SÓLO con las seis condiciones juntas:
 *
 *   1. Hay un pipeline activo (marker) — afuera del pipeline no frena nada (el freno del commit
 *      sigue avisando ahí). Decisión DevA 2026-07-30.
 *   2. El step 4 (implementación) todavía NO está cerrado. Después del step 4 vienen los fixes de
 *      advisors: frenarlos ahí sería absurdo y el `complete-step 4` ya juzgó el orden.
 *   3. La story declara una tabla `### Tests` — mismo skip-condition que el sub-paso 4.0. Una story
 *      sin tests declarados no tiene contrato de ATDD que romper.
 *   4. El archivo es CÓDIGO de implementación y vive DENTRO del repo de la story. Editar el propio
 *      harness, un script suelto o un `.md` mid-pipeline no es la implementación de la story.
 *   5. En esta corrida no se tocó NINGÚN archivo de test todavía. Al primer test tocado el portón
 *      queda abierto para el resto de la corrida — no persigue tarea por tarea, sólo impide el
 *      arranque invertido, que es donde se decide todo lo demás.
 *   6. No hay bypass declarado (env, archivo del repo, o flag del marker).
 *
 * El refactor legítimo sobre red preexistente —el falso positivo que importa— cae en el bypass del
 * punto 6, que es UN comando y queda registrado en `bypass.log`. Se eligió que sea explícito y no
 * adivinado: adivinar "esto parece un refactor" es exactamente cómo un gate se vuelve inútil.
 */

'use strict';

const path = require('path');
const { isTestPath, isImplPath } = require('./atdd-order.js');

/**
 * ¿`file` está dentro de `root`? Comparación por segmento — `/repo-viejo` no cuenta como `/repo`.
 * Case-INSENSITIVE a propósito: los filesystems del equipo (APFS macOS, NTFS Windows) lo son, y un
 * `file_path` con otro casing escribe el MISMO archivo — compararlo sensible dejaba pasar código
 * real por una mayúscula (hallazgo B5 del review adversarial 2026-07-30). El costo teórico (dos
 * dirs distintos solo por case en Linux) no existe en los repos del equipo.
 */
function isInside(root, file) {
  if (!root || !file) return false;
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = String(file).replace(/\\/g, '/').toLowerCase();
  return f === r || f.startsWith(r + '/');
}

/**
 * ¿El texto de la story declara una tabla `### Tests`? Mismo criterio que el sub-paso 4.0.
 * Ante la duda (no se pudo leer la story) devuelve `false` → NO bloquea: un portón nuevo que se
 * equivoca callándose es preferible a uno que frena por no haber podido leer un archivo.
 */
function storyDeclaresTests(storyText) {
  if (typeof storyText !== 'string' || storyText.trim() === '') return false;
  // el título lo encuentra story-checks.js, el único lector de las secciones de la story; si no carga,
  // vale lo de arriba: ante la duda no bloquea
  try {
    return require('./story-checks.js').storySection(storyText, 'tests') !== null;
  } catch {
    return false;
  }
}

/**
 * Veredicto del portón. PURA — sin fs, sin env, sin process: recibe todo lo que necesita y devuelve
 * la decisión. Es lo que se testea (misma disciplina que `computeAtddOrder`).
 *
 * @param {object} a
 * @param {string}   a.filePath        archivo que el tool call quiere editar/escribir
 * @param {string}   a.repoPath        marker.repoPath (repo de la story)
 * @param {string[]} a.priorPaths      paths YA editados en esta corrida, en orden
 * @param {boolean}  a.storyHasTests   la story declara tabla `### Tests`
 * @param {number[]} a.stepsCompleted  marker.stepsCompleted
 * @param {boolean} [a.bypassed]       bypass explícito (env / .tycon/atdd-gate / flag del marker)
 * @returns {{action:'pass'|'block', reason:string}}
 */
function computeAtddPreEdit({ filePath, repoPath, priorPaths, storyHasTests, stepsCompleted, bypassed = false }) {
  if (bypassed) return { action: 'pass', reason: 'bypass declarado' };
  if (!storyHasTests) return { action: 'pass', reason: 'la story no declara tabla ### Tests — sin contrato ATDD que gatear' };

  const done = Array.isArray(stepsCompleted) ? stepsCompleted : [];
  if (done.includes(4)) return { action: 'pass', reason: 'el step 4 ya cerró — esto son fixes post-implementación' };

  if (!isImplPath(filePath)) return { action: 'pass', reason: 'no es código de implementación' };
  if (!isInside(repoPath, filePath)) return { action: 'pass', reason: 'el archivo está fuera del repo de la story' };

  const prev = Array.isArray(priorPaths) ? priorPaths : [];
  if (prev.some((p) => isTestPath(p))) {
    return { action: 'pass', reason: 'ya se tocó al menos un archivo de test en esta corrida' };
  }

  return {
    action: 'block',
    reason: 'primer archivo de código de la corrida y todavía no se escribió ningún test',
  };
}

/** Texto del bloqueo: qué pasó, por qué frena, y las DOS salidas concretas. */
function preEditBlockMessage({ filePath, storyId, storyPath }) {
  const rel = path.basename(String(filePath || ''));
  return [
    `🔴 ATDD — edición DENEGADA: "${rel}" es el primer archivo de código de esta corrida y todavía no se`,
    `   escribió ningún test (Story ${storyId || '?'}, pruebas primero en «Implementar y correr las pruebas»).`,
    '',
    '   Por qué frena ACÁ y no al final: los dos frenos que ya existían (el cierre de ese paso y el',
    '   commit) avisan cuando la implementación ya está escrita — o sea, cuando el trabajo mal hecho',
    '   ya se hizo y hay que tirarlo. Un test escrito después describe lo que el código hace, no lo',
    '   que el AC pide, y queda verde igual cuando el código está mal.',
    '',
    '   Qué hacer AHORA:',
    '',
    '   (a) Escribí primero el/los test(s) de la tabla `### Tests` que cubren esta tarea, con sus',
    '       T-IDs y traits (`[Trait("Story",...)]` en xUnit · `@story-N.M` / `@ac-n` en vitest),',
    '       corrélos SCOPED y verificá que fallan por la razón correcta (assertion por feature',
    '       ausente — no un import roto). Recién ahí escribí este archivo: el portón se abre solo.',
    storyPath ? `       Story: ${storyPath}` : '',
    '',
    '   (b) Si el orden invertido es legítimo y lo podés justificar (refactor sobre una red de tests',
    '       que ya existe, spike acordado), declarálo explícitamente:',
    '',
    '         node ~/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js set-flag atddBypass true',
    '',
    '       Queda en bypass.log con el detalle — no es un skip silencioso, y el cierre de ese paso',
    '       lo va a seguir reportando.',
  ].filter((l) => l !== '').join('\n');
}

module.exports = { computeAtddPreEdit, preEditBlockMessage, storyDeclaresTests, isInside };
