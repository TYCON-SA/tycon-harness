/**
 * atdd-order.js — el freno mecánico de las pruebas primero en «Implementar» (ATDD: los tests se escriben ANTES del código).
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────────
 * Sin este gate, el ATDD sería la ÚNICA regla del pipeline sin gate mecánico. Todo lo demás que se cumple —build,
 * tests, advisors, lints, la matriz de DoD, el safety-guard— se cumple porque algo lo VERIFICA; el
 * ATDD sería un párrafo en un step file, y por eso el que se saltea. Más texto normativo no lo
 * arregla: reglas mandatorias + optimizaciones
 * opt-in = el sistema degrada al camino más caro.
 *
 * Caso: el orquestador escribe la implementación y después su test, tarea por tarea. Sin este gate la capa de
 * control es una persona leyendo el transcript, y un test escrito después puede apoyarse en un dato que el propio test
 * fabrica: el hallazgo de fondo sólo lo caza otra suite. Ése es exactamente
 * el defecto que el test-primero previene por construcción — con el test escrito antes, no puede
 * apoyarse en un dato que todavía no existe.
 *
 * ── DE DÓNDE SALE LA EVIDENCIA (no hace falta disciplina nueva) ──────────────────────────────────
 * El hook `on-edit.js` (PostToolUse Edit|Write) ya registra CADA edición en `marker.fileEvents` con
 * `{path, ts}` — también lo usa `smart-reloop`. Este gate NO
 * pide nada nuevo al orquestador: lee un dato que el pipeline ya guarda para otra cosa.
 *
 * ── QUÉ BLOQUEA Y QUÉ NO (calibrado para no dar falsos positivos) ───────────────────────────────
 *   · Se tocó código Y se tocaron tests, y el PRIMER test es POSTERIOR al PRIMER código → 🔴 BLOQUEA.
 *     Es la inversión inequívoca.
 *   · Se tocó código Y tests, y el primer test PRECEDE → ✅ verde.
 *   · No se tocó código (story de docs/specs/config) → ✅ verde, no hay nada que gatear.
 *   · Se tocó código y CERO tests → ⚠️ AVISA, no bloquea. Un refactor con red preexistente es
 *     legítimo y no toca ningún archivo de test.
 *     Bloquearlo sería un falso positivo, y un gate que da falsos positivos se termina desactivando.
 *   · Sin `fileEvents` (marker viejo, sesión adoptada) → ⚠️ AVISA `unknown`, no bloquea. No se puede
 *     afirmar una violación sin evidencia; lo que NO se hace es callarse.
 *
 * El aviso no es decorativo: queda en `gates.log`, así que "cuántas corridas hicieron ATDD de verdad"
 * pasa a ser una pregunta con respuesta medible en vez de una impresión.
 */

'use strict';


/** Extensiones que cuentan como CÓDIGO de implementación: los archivos fuente de `code-files.js` (sin `.md`/`.json`/
 * `.yaml`/`.sql`), más las que sume la organización (`stack.code_extensions`). */
const codeFiles = require('./code-files.js');
const CODE_EXTS = new Set(codeFiles.SOURCE_EXTS);
function esFuente(p, extra) {
  return codeFiles.isSource(p, { extra: extra !== undefined ? extra : require('./stack-config.js').orgExtra() });
}

/**
 * ¿El path es un archivo de TEST? Patrones de los stacks del equipo (vitest/jest/node:test/xunit).
 * Se mira el path COMPLETO normalizado a `/` — en Windows los eventos llegan con `\`.
 *
 * 🔴 La heurística de DIRECTORIO exige además EXTENSIÓN DE CÓDIGO. Sin eso,
 * `specs/stories/<story>.md` —que el pipeline edita SIEMPRE antes que el código (status →
 * in-progress)— contaría como "primer test tocado" y el gate del `complete-step implement` saldría verde en
 * TODAS las corridas, con `firstTest` apuntando al `.md` de la propia story.
 * Un gate ciego así no se nota, porque verde no llama la atención.
 * Misma razón excluye fixtures (`tests/fixtures/*.json`): tocar un dato de
 * prueba no es escribir un test. Los patrones por NOMBRE de archivo ya traen extensión de código.
 */
function isTestPath(p, { extra } = {}) {
  const s = String(p || '').replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base) ||            // foo.test.ts · foo.spec.js
    // Suite bash (sin esto, una story con tests `.test.sh` queda frenada y pide `atddBypass` a mano).
    // SÓLO por nombre y SÓLO como test: `.sh` no entra a CODE_EXTS, así que un script de pipeline o
    // de hook no pasa a exigir un test previo, y un ayudante bash bajo tests/ no cuenta como suite.
    /\.(test|spec)\.sh$/i.test(base) ||                      // foo.test.sh
    /_test\.(go|py|rb)$/i.test(base) ||                      // foo_test.go
    /^test_.*\.py$/i.test(base) ||                           // test_foo.py
    /Tests?\.cs$/.test(base)                                 // FooTests.cs
  ) return true;
  // los guiones de pruebas de CI (`scripts/ci/pruebas/`, `scripts/ci/tests/`), `.sh` incluido: no son código
  if (/(^|\/)scripts\/ci\/(?:pruebas|tests)\/(?:.*\/)?[^/]+\.(?:js|py|sh)$/i.test(s)) return true;
  return (
    (/(^|\/)(tests?|__tests__|spec|specs)\//i.test(s) ||     // vive en un directorio de tests…
      /(^|[/.])Tests?\//.test(s)) &&                         // .NET: MiProyecto.Tests/ Y Tycon.X.API.Tests/
    esFuente(s, extra)                                       // …y es CÓDIGO (no .md/.json/.yaml)
  );
}

/**
 * Filtra los eventos a los que caen DENTRO de `repoPath`. Sin `repoPath`, no filtra nada.
 * Comparación case-insensitive con separador normalizado — mismo criterio que el resto del harness
 * (APFS y NTFS no distinguen mayúsculas, y en Windows los eventos llegan con `\`).
 */
function adentroDelRepo(evs, repoPath) {
  // una raíz, o varias (la del repo de la story más sus hermanos declarados)
  const lista = (Array.isArray(repoPath) ? repoPath : [repoPath]).filter((r) => typeof r === 'string' && r !== '');
  if (!lista.length) return evs;
  const raices = lista.map((r) => r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  return evs.filter((e) => {
    const p = String((e && e.path) || '').replace(/\\/g, '/').toLowerCase();
    return raices.some((raiz) => p === raiz || p.startsWith(`${raiz}/`));
  });
}

/**
 * ¿El archivo es un guion de medición del repo que la story no declara? Vive en `tasks/measurement-<algo>/` contado
 * desde una de las raíces (`tasks/` puede ser código de verdad en un repo: sólo la carpeta de medición se descarta).
 * Es como un guion del scratchpad: medir antes de implementar no es implementar primero. Declarado en
 * `files_to_create`/`files_to_modify`, es código de la story.
 */
function esMedicionNoDeclarada(p, repoPath, declarados) {
  const raices = (Array.isArray(repoPath) ? repoPath : [repoPath]).filter((r) => typeof r === 'string' && r !== '');
  const s = String(p || '').replace(/\\/g, '/');
  // la story puede declarar el archivo o su carpeta, con o sin acentos graves
  const lista = (Array.isArray(declarados) ? declarados : [])
    .map((d) => String(d).trim().replace(/^`|`$/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  return raices.some((r) => {
    const raiz = r.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!s.toLowerCase().startsWith(`${raiz.toLowerCase()}/`)) return false;
    const rel = s.slice(raiz.length + 1).toLowerCase();
    return /^tasks\/measurement-[^/]+\//.test(rel) && !lista.some((d) => rel === d || rel.startsWith(`${d}/`));
  });
}

/** ¿El path es CÓDIGO de implementación (no test)? */
function isImplPath(p, { extra } = {}) {
  const s = String(p || '').replace(/\\/g, '/');
  if (isTestPath(s, { extra })) return false;
  return esFuente(s, extra);
}

/**
 * Computa el veredicto de orden ATDD sobre los `fileEvents` de un marker.
 *
 * Función PURA — sin fs, sin Date, sin process: recibe los eventos y devuelve el veredicto. Es lo que
 * la hace testeable sin montar un marker en disco (misma disciplina que `lib/story-checks.js`).
 *
 * 🔴 `repoPath` (opcional) DESCARTA los eventos de fuera del repo de la story. Sin él,
 * cualquier script que el agente escriba en el scratchpad de la sesión —una sonda de diagnóstico, un
 * probe de una medición— cuenta como "primer archivo de código" y bloquea una corrida cuyo orden real
 * fue correcto. Caso: una story cuya Task 1 es una SALVAGUARDA, o sea
 * verificar contra el código que las anclas que la story cita sigan existiendo, y esa verificación se
 * hace con un `.mjs` throwaway. Toda story que arranque con una salvaguarda o una medición escribe un
 * script de diagnóstico antes que cualquier test — y eso NO es implementar primero.
 *
 * Es la MISMA clase de falso positivo que el de las stories `.md` bajo
 * `specs/`: un clasificador que mira la forma del archivo y no su pertenencia al trabajo gateado se equivoca igual.
 * Omitirlo no filtra nada (compatibilidad con markers viejos y con los callers
 * que no tienen el dato).
 *
 * @param {Array<{path: string, ts: string}>} fileEvents
 * @param {string|string[]} [repoPath] - raíz del repo de la story (o la lista: la story y sus repos hermanos); los
 *   eventos de afuera se descartan
 * @param {{declarados?: string[]}} [opciones] - `declarados`: `files_to_create` + `files_to_modify` de la story,
 *   relativos a la raíz. Un guion de `tasks/measurement-<algo>/` que no está en la lista no cuenta (sin lista, nunca cuenta).
 * @returns {{verdict:'green'|'blocked'|'warn-no-tests'|'warn-unknown', firstTest:?string,
 *            firstImpl:?string, firstTestTs:?string, firstImplTs:?string, reason:string}}
 */
function computeAtddOrder(fileEvents, repoPath, { declarados } = {}) {
  const todos = Array.isArray(fileEvents) ? fileEvents : [];
  const evs = adentroDelRepo(todos, repoPath).filter((e) => !(e && esMedicionNoDeclarada(e.path, repoPath, declarados)));
  // Orden por timestamp; ante empate (dos ediciones en el mismo ms), gana el orden de registro, que
  // es el orden real en que el hook las vio.
  const orden = evs
    .filter((e) => e && typeof e.path === 'string' && typeof e.ts === 'string')
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => (a.ts === b.ts ? a.i - b.i : a.ts < b.ts ? -1 : 1));

  if (orden.length === 0) {
    return {
      verdict: 'warn-unknown',
      firstTest: null, firstImpl: null, firstTestTs: null, firstImplTs: null,
      reason:
        todos.length === 0
          ? 'el marker no tiene fileEvents — no se puede verificar el orden (marker viejo o sesión adoptada)'
          : 'ningún fileEvent cae dentro del repo de la story — no hay nada que gatear acá',
    };
  }

  const t = orden.find((e) => isTestPath(e.path)) || null;
  const c = orden.find((e) => isImplPath(e.path)) || null;

  if (!c) {
    return {
      verdict: 'green',
      firstTest: t ? t.path : null, firstImpl: null,
      firstTestTs: t ? t.ts : null, firstImplTs: null,
      reason: 'no se editó código de implementación — no hay nada que gatear',
    };
  }
  if (!t) {
    return {
      verdict: 'warn-no-tests',
      firstTest: null, firstImpl: c.path, firstTestTs: null, firstImplTs: c.ts,
      reason: 'se editó código y NINGÚN archivo de test — puede ser un refactor con red preexistente (legítimo), pero conviene mirarlo',
    };
  }
  if (t.ts < c.ts || (t.ts === c.ts && t.i < c.i)) {
    return {
      verdict: 'green',
      firstTest: t.path, firstImpl: c.path, firstTestTs: t.ts, firstImplTs: c.ts,
      reason: 'el primer archivo de test se tocó ANTES que el primero de código',
    };
  }
  return {
    verdict: 'blocked',
    firstTest: t.path, firstImpl: c.path, firstTestTs: t.ts, firstImplTs: c.ts,
    reason: 'el primer archivo de CÓDIGO se tocó antes que el primero de TEST — la implementación fue primero',
  };
}

/** Texto del bloqueo, en el idioma del harness: qué pasó, por qué frena, y qué hacer. */
function atddBlockMessage(r) {
  return [
    'marker.js complete-step implement BLOQUEADO — el código se escribió ANTES que los tests (ATDD).',
    '',
    `  Primer archivo de CÓDIGO: ${r.firstImpl}  (${r.firstImplTs})`,
    `  Primer archivo de TEST:   ${r.firstTest}  (${r.firstTestTs})`,
    '',
    '  Por qué frena: un test escrito DESPUÉS describe lo que el código hace, no lo que el AC pide,',
    '  y queda verde igual cuando el código está mal. Caso medido (Story 3.21, 2026-07-27): un test',
    '  escrito después se apoyaba en un dato que el propio test fabricaba, así que el bug de fondo',
    '  sólo lo cazaba otra suite. Con el test primero eso es imposible: el dato todavía no existe.',
    '',
    '  Qué hacer:',
    '   (a) Escribir el/los test(s) que faltan AHORA y verificar que fallan contra el código actual',
    '       (o, si ya pasan, que fallan al romper la pieza a propósito). Después reintentar.',
    '   (b) Si el orden fue legítimo y podés justificarlo, saltealo explícitamente:',
    '         marker.js complete-step implement --no-atdd',
    '       Queda registrado en bypass.log con el detalle — no es un skip silencioso.',
  ].join('\n');
}

module.exports = { computeAtddOrder, isTestPath, isImplPath, esMedicionNoDeclarada, atddBlockMessage, CODE_EXTS };
