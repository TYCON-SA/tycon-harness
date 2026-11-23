#!/usr/bin/env node
'use strict';
/**
 * run-suites-json.js — corre las suites declaradas en `<repo>/scripts/tests/suites.json`.
 *
 * Es el quinto stack del test-gate. Los repos del equipo con package.json o .csproj ya
 * tienen gate; el repo del ARNÉS no tiene ninguno de los dos: sus suites son archivos sueltos
 * (`.js` que se corren con `node`, `.sh` con `bash`) declarados en `suites.json`, que el pipeline
 * de Azure ya recorre cada noche. Sin este runner el gate diría «no se detectó stack» y no escribiría
 * `tests-result.json`, y sin ese artefacto la matriz de DoD marcaría como NOT-RUN criterios con la
 * suite realmente verde. Es la MISMA lista que usa el pipeline — no una copia — así que lo que el
 * gate mide en la máquina es lo que el nocturno mide en el servidor.
 *
 * EN PARALELO: en serie el gate del arnés tarda entre 50 y 68 min
 * (153 suites; exportador-real sola, 24-41):
 *   · corren W a la vez: `TYCON_SUITES_MAX_WORKERS` (entero positivo); en la CI, la mitad de los núcleos; si no,
 *     min(núcleos − 2, núcleos − carga) con piso 1, y antes de cada suite se espera si la carga pasa el doble de los
 *     núcleos y queda otra corriendo (lib/suite-times.js, `workersFor` y `waitForRoom`): no fundir la máquina del dev;
 *   · `"exclusive": true` en la entrada → corre sola, al final, de a una (comparte estado con otras);
 *   · `"gate_only_when_touching": ["<carpeta>/**"]` → se DIFIERE si el cambio real de la corrida no toca
 *     esas carpetas ni el archivo de la propia suite (`--touched <json de lib/touched-files.js>`). Sin `--touched`, con `known: false` o con
 *     `TYCON_GATE_ALL_SUITES=1`, corre todo: «no pude mirar» nunca se lee como «no toca».
 *   Esos dos campos los lee SÓLO este runner; el nocturno y el control del PR los ignoran.
 *   · las suites del grupo `installer` de `<repo>/scripts/ci/heavy-suites.json` se DIFIEREN si lo tocado no toca el
 *     instalador ni la suite misma: el mismo criterio que la validación de Azure y la CI de GitHub, leído con
 *     `groupCriterion` del selector del repo que se mide (scripts/ci/suites-for-change.js). Sin poder leerlo, corren.
 *
 * LA CORRIDA CRUZADA (`--only-touched`: la del repo hermano, o un repo con la story de otro): corre sólo las suites que
 * prueban algo tocado (`namesTouched`: la suite misma, o su texto nombra un archivo tocado), aunque lo tocado sea código; las demás quedan diferidas: la completa la corre la CI del pedido. Si no
 * se sabe qué se tocó, o ninguna suite lo lee, no corre nada y sale 7 («sin acotar»), con el motivo en `unscoped`: correr
 * las ~400 suites del hermano en la máquina del dev no es la alternativa. `TYCON_GATE_ALL_SUITES=1` corre todo.
 *
 * LA RAÍZ `agent-skills` LA DICE EL REPO QUE SE MIDE: en el repo unido
 * esas suites viven en `<repo>/skills`. Sin esto, este runner las buscaría en
 * `TYCON_SKILLS_DIR` o en `~/.claude/agent-skills/skills`: en un clon de trabajo del repo unido correría
 * las suites INSTALADAS en la máquina y el gate daría verde sin haber probado el cambio. Sin
 * `--skills`, la raíz la contesta `resolveSkillsDirs()` de `<repo>/scripts/lib/skills-dir.js` —la misma
 * función que usan los demás lectores de suites.json—: la variable › el propio clon si es unido › lo
 * instalado. Se le pregunta al repo que se mide y no al árbol donde vive este runner, porque el runner
 * instalado es el que corre sobre los clones de trabajo. La salida y el resumen (`skills_root`) dicen
 * qué raíz se usó y de qué regla salió.
 *
 * CON LA COBERTURA PEDIDA (`--coverage <carpeta>`): cada suite corre bajo `coverage-wrapper.js`, una
 * prueba de Node que la lanza como hijo con el medidor de cobertura de Node prendido. La suite sale igual (su salida, su
 * código); cada una deja su lcov en la carpeta y al final quedan juntos en `<carpeta>/lcov.info`, que lee
 * test-gate-report.js. Una suite sin datos (una de bash que no lanza `node`, una que no arrancó) se nombra en
 * `coverage.without_data` y no rompe nada. Sin `--coverage`: ni envoltorio ni carpeta.
 *
 * ACOTADA POR EL REPO (`--scoped-by-repo <quién corre la completa>`): el mismo criterio que la corrida cruzada, en el
 * propio repo, porque el repo lo declara (`test_gate` de `.test-gate.yaml`, leído por lib/test-gate-scope.js) y una
 * CI corre la suite entera antes del merge. Lo que cambia respecto de la cruzada: si ninguna suite lee lo tocado sale 0
 * («ninguna suite lee lo tocado; la suite completa la corre la CI del pedido»), porque esa CI es el control obligatorio;
 * si no se sabe qué se tocó no corre nada y sale 7 («sin acotar»), como la cruzada: la completa no corre en la máquina.
 * Con más suites que el tope de la máquina (`TOPE_DE_LA_MAQUINA`, o `test_gate.max_local_suites` del repo) corren las más
 * cercanas al cambio y las demás quedan para esa CI (`scoped.capped`). El resumen lleva `scoped` con quién corre la
 * completa sólo cuando acotó. `TYCON_GATE_ALL_SUITES=1` sigue corriendo todo, a pedido de una persona.
 *
 * UNA SOLA SUITE (`--suite <ruta>`, la `ruta` de su entrada en suites.json): el plan queda con esa entrada sola y corre
 * aunque la difiera lo tocado o la corrida liviana, con el mismo envoltorio de cobertura. Una ruta que no está sale 2.
 * Cada falla del resumen trae `entrada: {raiz, ruta}`, la de suites.json, que es la que recibe `--suite`.
 *
 * Uso:  node run-suites-json.js <repo> <resumen.json> [--skills <dir>] [--touched <archivo.json>] [--coverage <dir>] [--suite <ruta>]
 *   · `raiz: "arnes"`        → <repo>/scripts/<ruta>
 *   · `raiz: "agent-skills"` → <skills>/<ruta>   (`--skills`; si no, la función del repo; en un repo sin
 *                              esa función, TYCON_SKILLS_DIR, o ~/.claude/agent-skills/skills)
 *
 * Contrato de salida (regla de la casa):
 *   0 → TODAS verdes.  1 → alguna roja, AUSENTE o NO MEDIDA.  3 → no pude medir (suites.json ilegible o
 *   vacío, la raíz de las skills no se pudo resolver, o nada para correr después de diferir).
 *   130/143 → cortado por SIGINT/SIGTERM.
 *
 * 🔴 Una suite AUSENTE es una falla, no un salteo: «no pude mirar» y «miré y está bien» no se
 *    escriben igual. 🔴 Una suite cuya RAÍZ no existe sale «NO MEDIDA» con su motivo (la raíz y de qué
 *    regla salió) en `unmeasured_suites`, y cuenta además como ausente: nunca verde, nunca salteada.
 *    🔴 El exit es el acumulado, no el del último comando. 🔴 Sin suites.json legible
 *    no se escribe un resumen que se pueda leer como verde. 🔴 El resumen va en el ORDEN DE LA LISTA,
 *    no en el de llegada. 🔴 Cortado a mitad: se matan los grupos de proceso de las suites (no quedan
 *    nietos huérfanos) y el resumen dice `no_medido`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { touches, isValidPattern } = require('./touched-files');
const { joinLcov } = require('./node-coverage');
const suiteTimes = require('./suite-times');
const { stateDir } = require('./state-dir.js');
const { changeNames } = require('./change-names.js');

const MAX_BUFFER = 64 * 1024 * 1024;
// Tope en bytes del archivo con la salida entera de una suite roja (se guardan la primera y la última mitad) y de lo que
// se guarda entre todas las de una corrida: pasado éste, de las que siguen queda sólo el resumen de sus casos.
const FULL_OUTPUT_MAX = 8 * 1024 * 1024;
const RUN_OUTPUT_MAX = 64 * 1024 * 1024;
// Cuántos casos fallidos y cuántos renglones de explicación por caso van al resumen.
const MAX_CASES = 40;
const MAX_CASE_CONTEXT = 6;
const MAX_LINE = 300;
const WRAPPER = path.join(__dirname, 'coverage-wrapper.js');
// Desde cuántas suites por correr se pide el turno de la máquina: dos portones grandes a la vez la saturan, y uno mediano
// corre cerca de cien. Es el único lugar donde se fija.
const TURN_FROM_SUITES = 100;
// El tope de la máquina con el portón acotado por el repo: cuántas suites corren como mucho en la máquina del dev. La
// suite completa nunca corre ahí: la corre la CI del pedido. Pasado el tope quedan las más cercanas al cambio
// (`cercania`) y las demás se difieren a esa CI. El repo lo cambia con `test_gate.max_local_suites` (.test-gate.yaml).
const TOPE_DE_LA_MAQUINA = 60;
// Una pieza central: un archivo de código tocado que nombran tantas suites o más (5 % de las ~800 del arnés). Con el
// portón acotado por el repo, para ésas nombrar el archivo no alcanza: ver `piezasCentrales` y `lejana`.
const PIEZA_CENTRAL_MIN = 40;

/**
 * Cómo se lanza una suite: `[ejecutable, args, env]`, sin las variables internas del portón. Con cobertura, bajo el envoltorio: sin la variable que anida
 * corridas de `node --test` (con ella el medidor no escribe su reporte) ni una carpeta de V8 de afuera (cada suite mide
 * en la suya).
 */
// Las variables con que test-gate.sh describe ESTA corrida (la clave de la copia sellada, las marcas del hermano y de la
// corrida cruzada): una suite que corre su propio portón de juguete las tomaría como suyas. TYCON_TEST_GATE es la marca
// con que run-check anota la procedencia del check `tests`: heredada, la suite del freno de cierre cambiaría de conducta
// (roja dentro del portón, verde sola; casos: tests/run-suites-json.test.js T15b). TYCON_GATE_ALL_SUITES es una orden a
// este corredor (correr todo): heredada, una suite que corre su propio portón de juguete dejaría de acotar y daría rojo.
const DEL_PORTON = ['TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_STORY_REPO',
  'TYCON_TEST_GATE_CROSS_REPO', 'TYCON_TEST_GATE', 'TYCON_TEST_GATE_TREE_TOUCHED', 'TYCON_SUITE_HOMES_ROOT', 'TYCON_GATE_PROCESS',
  'TYCON_GATE_ALL_SUITES', 'TYCON_TEST_GATE_RUN'];

function launch(p, covDir, env0) {
  const ej = p.ruta.endsWith('.js') ? process.execPath : 'bash';
  const env = { ...env0 };
  for (const k of DEL_PORTON) delete env[k];
  // un corredor que una suite lance sobre su repo de juguete no anota en el registro de tiempos de la máquina
  env.TYCON_SUITE_TIMES = 'off';
  if (!covDir) return [ej, [p.ruta], env];
  const e = { ...env };
  delete e.NODE_TEST_CONTEXT;
  delete e.NODE_V8_COVERAGE;
  // Con `--test-coverage-exclude` declarado, Node no aplica su exclusión de fábrica, que deja afuera todo `test-*.js`
  // (la receta de pruebas y el informe de la puerta salían «sin datos»). Un Node que no la tiene (el 20 viejo) corre
  // como antes. El envoltorio y la propia suite se descartan igual al juntar.
  const excluir = process.allowedNodeEnvironmentFlags.has('--test-coverage-exclude') ? [`--test-coverage-exclude=${WRAPPER}`] : [];
  return [process.execPath, ['--experimental-test-coverage', ...excluir, '--test-reporter=lcov',
    `--test-reporter-destination=${path.join(covDir, `${String(p.idx).padStart(4, '0')}.lcov`)}`, WRAPPER, ej, p.ruta], e];
}

// Las variables con que la puerta marca su corrida (test-gate.sh las exporta) y las que cambian cómo corre una suite:
// de éstas se anota el valor. De las demás TYCON_* sólo el nombre, porque alguna puede llevar una credencial.
const GATE_MARKS = ['TYCON_TEST_GATE', 'TYCON_MAILBOX', 'TYCON_NO_UPLOAD_RUNS', 'TYCON_MAILBOX_JSON', 'TYCON_SUITE_RUNNER',
  'TYCON_FULL_SUITE', 'TYCON_HARNESS_LOCK_HELD', 'TYCON_SUITES_MAX_WORKERS', 'TYCON_GATE_ALL_SUITES', 'TYCON_SKILLS_DIR',
  'TYCON_TEST_GATE_PART', 'TYCON_TEST_GATE_MARK', 'NODE_TEST_CONTEXT'];

/** Lo que la puerta hace distinto al correr las suites: sus marcas, las variables que les quita, run-check y W. */
function gateEnvironment(env, runCheck, workers) {
  const childEnv = launch({ ruta: 'x.js' }, null, env)[2];
  const marks = {};
  for (const k of GATE_MARKS) if (k in childEnv) marks[k] = String(childEnv[k]);
  const removed = DEL_PORTON.filter((k) => k in env);
  const otherNames = Object.keys(childEnv).filter((k) => k.startsWith('TYCON_') && !GATE_MARKS.includes(k)).sort();
  return { run_check: runCheck, workers, marks, removed, other_names: otherNames };
}

function describeEnvironment(a) {
  const marks = Object.entries(a.marks).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${a.run_check ? `run-check ${a.run_check}` : 'sin run-check'} · ${a.workers} a la vez`
    + ` · marcas: ${marks || 'ninguna'}${a.removed.length ? ` · quitadas a las suites: ${a.removed.join(' ')}` : ''}`
    + `${a.empty_home ? ` · las portables (${a.empty_home}) con su HOME vacía, como en la CI` : ''}`;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// Los renglones con que las suites del arnés anuncian un caso que falló: el reportero de Node (✖), TAP (not ok), las de
// bash propias (MAL, ❌, FAIL). La línea de título del resumen de Node («✖ failing tests:») no es un caso.
const FAIL_LINE = /^\s*(?:✖|✗|❌|not ok\b|MAL\b|FAIL\b)/;
const FAIL_TITLE = /^\s*✖\s+failing tests:?\s*$/;
const indentOf = (l) => l.length - l.trimStart().length;
const clip = (l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l);

/**
 * Los casos que fallaron en la salida de una suite: cada renglón de falla con los renglones más sangrados que lo siguen
 * (el error que lo explica), sin repetidos —el reportero de Node repite cada caso en su resumen final—.
 */
function failedCases(salida) {
  const lines = String(salida).replace(ANSI, '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && out.length < MAX_CASES; i++) {
    const l = lines[i];
    if (!FAIL_LINE.test(l) || FAIL_TITLE.test(l)) continue;
    const head = l.trim();
    if (seen.has(head)) continue;
    seen.add(head);
    const base = indentOf(l);
    const ctx = [];
    for (let j = i + 1; j < lines.length && ctx.length < MAX_CASE_CONTEXT; j++) {
      const n = lines[j];
      if (!n.trim() || indentOf(n) <= base || FAIL_LINE.test(n)) break;
      ctx.push(clip(n.trimEnd()));
    }
    out.push([clip(head), ...ctx].join('\n'));
  }
  return out;
}

/** La salida recortada a `max` bytes: el principio y el final, con un aviso en el medio. */
function capOutput(text, max = FULL_OUTPUT_MAX) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, truncated: false };
  const half = Math.floor(max / 2);
  const note = `\n\n[… recortada: ${buf.length - 2 * half} bytes del medio quedaron afuera …]\n\n`;
  return { text: buf.subarray(0, half).toString('utf8') + note + buf.subarray(buf.length - half).toString('utf8'), truncated: true };
}

/**
 * Escribe la salida entera de una suite roja al lado del resumen, con el tope por suite y lo que le queda a la corrida
 * (`budget.left`, en bytes, se descuenta). Devuelve `{ file, truncated, skipped? }`; `file` es null si no se guardó.
 */
function saveFullOutput(out, r, ambiente, budget = { left: RUN_OUTPUT_MAX }, perSuite = FULL_OUTPUT_MAX) {
  if (budget.left <= 0) return { file: null, truncated: false, skipped: `se pasó el tope de ${RUN_OUTPUT_MAX / 1048576} MB de salidas de la corrida: quedan sólo sus casos` };
  try {
    const dir = path.join(path.dirname(out), 'salidas');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(r.idx).padStart(4, '0')}-${path.basename(r.ruta)}.log`);
    const { text, truncated } = capOutput(r.salida, Math.min(perSuite, budget.left));
    const head = `# ${r.ruta}\n# salió ${r.exit} en ${r.ms} ms · ${describeEnvironment(ambiente)}\n\n`;
    const body = head + text;
    fs.writeFileSync(file, body);
    budget.left -= Buffer.byteLength(body, 'utf8');
    return { file, truncated };
  } catch (e) {
    console.error(`[suites.json] ⚠️  no pude guardar la salida entera de ${path.basename(r.ruta)}: ${e.message}`);
    return { file: null, truncated: false };
  }
}

/**
 * W, por qué, si se espera por la carga y, si el valor de la variable no sirve, el aviso: la variable › en la CI la
 * mitad de los núcleos › la máquina (lib/suite-times.js, `workersFor`).
 */
function resolveWorkers(env, maquina = suiteTimes.machine(env)) {
  return suiteTimes.workersFor({ env, varName: 'TYCON_SUITES_MAX_WORKERS', maquina, ci: suiteTimes.isCI(env),
    ciDefault: Math.max(1, Math.floor(maquina.nucleos / 2)) });
}

/**
 * Lo que corre antes de lanzar cada suite: espera mientras la carga pase el doble de los núcleos y quede otra corriendo.
 * Cuenta en `esperas` ({ veces, ms }) los intervalos de reloj con algún carril esperando: varios carriles que esperan
 * por la misma carga son una sola espera, como en las portables.
 */
function launchGate({ nucleos, floor = 1, load, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), esperas, stopped, now = Date.now }) {
  let waiting = 0;
  let since = 0;
  return async (others) => {
    let entered = false;
    const counted = async (ms) => {
      if (!entered) {
        entered = true;
        if (waiting++ === 0) { esperas.veces += 1; since = now(); }
      }
      await sleep(ms);
    };
    try {
      await suiteTimes.waitForRoom({ nucleos, floor, load, others, sleep: counted, stopped });
    } finally {
      if (entered && --waiting === 0) esperas.ms += now() - since;
    }
  };
}

/** Corre `items` de a `n` carriles; `beforeLaunch(otras)` se espera antes de lanzar cada uno. */
async function pool(items, n, runOne, { stopped = () => false, beforeLaunch = null } = {}) {
  let next = 0;
  let running = 0;
  const lane = async () => {
    while (!stopped() && next < items.length) {
      if (beforeLaunch) await beforeLaunch(() => running);
      if (stopped() || next >= items.length) break;
      const item = items[next++];
      running += 1;
      try { await runOne(item); } finally { running -= 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

/** Lo que el gate sabe de lo tocado: { known, files, reason } o null si no se pasó. */
function readTouched(file) {
  if (!file) return { known: false, files: [], reason: 'el gate no pasó qué archivos toca la story' };
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof t.known !== 'boolean' || !Array.isArray(t.files)) {
      return { known: false, files: [], reason: `${file} no tiene la forma de touched-files.js` };
    }
    return t;
  } catch (e) {
    return { known: false, files: [], reason: `no pude leer ${file} (${e.message})` };
  }
}

/**
 * La raíz de las suites `agent-skills`: { dir, source }. `--skills` manda; si no, la función del repo que se
 * mide (la variable › su propio clon si es unido › lo instalado); un repo sin esa función, la variable o lo instalado.
 * Tira si la función del repo no se deja usar: la raíz no se adivina.
 */
function resolveSkillsRoot(repo, given, env) {
  if (given) return { dir: given, source: '--skills' };
  const lib = path.resolve(repo, 'scripts', 'lib', 'skills-dir.js');
  if (fs.existsSync(lib)) {
    const d = require(lib).resolveSkillsDirs(env.TYCON_SKILLS_DIR || '');
    // un arnés anterior no dice de dónde salió: sólo conoce la variable y lo instalado
    return { dir: d.skills, source: d.source || (env.TYCON_SKILLS_DIR ? 'variable' : 'installed') };
  }
  if (env.TYCON_SKILLS_DIR) return { dir: env.TYCON_SKILLS_DIR, source: 'variable' };
  return { dir: path.join(installedSkillsIn(os.homedir()), 'skills'), source: 'installed' };
}

/** Dónde quedan las skills instaladas dentro de una carpeta personal: la real o la vacía de una suite portable. */
const installedSkillsIn = (home) => path.join(home, '.claude', 'agent-skills');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
// Borra una carpeta aunque una suite le haya sacado los permisos a algo de adentro (el banco de controles prueba así un
// ~/.claude/skills al que no se puede entrar, y no los devuelve). Si igual no se puede, devuelve el error: quien llama
// lo avisa con la ruta y sigue, porque una carpeta que queda no cambia el resultado de ninguna suite.
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return null; } catch (_) { /* se reabre y se reintenta */ }
  const reopen = (d) => {
    try { fs.chmodSync(d, 0o700); } catch (_) { return; }
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) if (e.isDirectory()) reopen(path.join(d, e.name));
  };
  reopen(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); return null; } catch (e) { return e; }
}
const realOf = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/**
 * «La propia suite», como la nombra git: su ruta relativa a la raíz del repo. Devuelve las formas en que puede
 * figurar en lo tocado: la de las rutas TAL COMO LLEGARON y la de las rutas REALES de las dos puntas.
 *
 * Por qué las dos: la raíz
 * de las skills sale ya resuelta a su ruta real (el `__dirname` de skills-dir.js) y el repo llega como lo escribió
 * quien llama (test-gate.sh lo pasa con `pwd`, que conserva los enlaces). Con el repo por un enlace —el canónico
 * `~/.claude/tycon-harness`, o `/tmp` en Mac— la ruta propia daría `../../…`, nunca coincidiría con lo tocado y
 * la suite que la story editó se DIFERIRÍA con el gate en verde. Lo mismo al revés (el repo por su ruta real y la raíz
 * por el enlace instalado). Se resuelve el ARCHIVO entero y no sólo la raíz: la carpeta `~/.claude/skills` de la
 * máquina de un solo árbol es real y lo enlazado es cada skill. La forma «como llegó» se conserva: es la que cubre
 * el caso común, y de las dos alcanza con una —sumar una forma sólo puede hacer correr una suite, nunca diferirla—.
 */
// Una suite partida (`<suite>.p<k>.test.<js|sh>`, una línea que carga el archivo entero) se registra por sus
// partes: «la propia suite» de una parte es también su archivo entero, donde viven sus casos, y lo que la reparte.
// Acá alcanza con el nombre: lo propio sólo sirve para CORRER una suite que el criterio diferiría, así que una suite
// común que se llame como una parte a lo sumo corre de más (el selector de la validación, que además lee de qué
// depende cada una, sí mira el contenido de la parte: scripts/ci/suites-for-change.js).
const PARTE = /^(.*)\.p[1-9]\d*\.test\.(js|sh)$/;
function ownPaths(repo, ruta) {
  const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');
  const asGiven = rel(repo, ruta);
  const real = rel(realOf(repo), realOf(ruta));
  const out = asGiven === real ? [asGiven] : [asGiven, real];
  for (const own of [...out]) {
    const m = own.match(PARTE);
    if (!m) continue;   // por el nombre, esté o no el entero: borrado o movido, sus partes corren y salen rojas
    const dir = path.posix.dirname(own);
    out.push(`${m[1]}.test.${m[2]}`, `${dir}/lib/suite-parts.${m[2]}`, ...(m[2] === 'js' ? [`${dir}/suite-parts.json`] : []));
  }
  return out;
}

/**
 * Corrida cruzada: ¿la suite prueba algo tocado? Sí si es ella misma, o si su texto nombra un archivo tocado que no es
 * otra suite (por su ruta relativa o por su nombre). Más estricta que la corrida liviana: sin la regla de la carpeta,
 * tocar una suite de `scripts/tests/` arrastraría a las ~400 que viven ahí.
 */
function namesTouched(repo, ruta, files) {
  const own = ownPaths(repo, ruta);
  if (files.some((f) => own.includes(f))) return true;
  let text = null;
  try { text = fs.readFileSync(ruta, 'utf8'); } catch (_) { return true; }
  return files.some((f) => !esSuite(f) && nombres(f).some((n) => text.includes(n)));
}

// Cómo puede nombrar una suite a un archivo: su ruta, su nombre, y como lo carga `require` —sin la extensión, con su
// carpeta («lib/acme» por lib/acme.js) y, para un index, por la carpeta («lib/gen» por lib/gen/index.js)—.
function nombres(f) {
  const p = path.posix;
  const sinExt = f.replace(/\.(c|m)?(js|ts)$/, '');
  const out = [f, p.basename(f)];
  if (sinExt !== f) {
    const dir = p.dirname(sinExt);
    const base = p.basename(sinExt);
    if (dir !== '.') out.push(`${p.basename(dir)}/${base}`);
    if (base === 'index' && dir !== '.') {
      const arriba = p.dirname(dir);
      out.push(arriba !== '.' ? `${p.basename(arriba)}/${p.basename(dir)}` : p.basename(dir));
    }
  }
  return out;
}

/**
 * Las piezas centrales del portón acotado por el repo: los archivos de código tocados que nombran PIEZA_CENTRAL_MIN
 * suites de la lista o más (con la regla de `namesTouched`), cada uno con lo que cambió adentro según change-names.js
 * contra la base de touched.json. `names: null` es «no sé qué cambió» (con `reason`): esa pieza no difiere nada.
 */
function piezasCentrales({ repo, plan, files, bases }) {
  const { classifyFile } = require('./run-size.js');
  const candidatas = files.filter((f) => !esSuite(f) && classifyFile(f).kind === 'code');
  if (!candidatas.length) return [];
  const textos = plan.map((p) => { try { return fs.readFileSync(p.ruta, 'utf8'); } catch (_) { return null; } });
  const out = [];
  for (const f of candidatas) {
    const formas = nombres(f);
    const rutas = new Set(plan.filter((p, i) => textos[i] !== null && formas.some((n) => textos[i].includes(n))).map((p) => p.ruta));
    if (rutas.size < PIEZA_CENTRAL_MIN) continue;
    let c = { known: false, reason: 'touched.json no trae la base' };
    const b = baseDelArchivo(repo, bases, f);
    if (b.reason) c = { known: false, reason: b.reason };
    // una falla al leer el cambio es «no sé», nunca un portón caído
    else if (b.ref) { try { c = changeNames({ repo: b.repo, file: f, base: b.ref }); } catch (e) { c = { known: false, reason: `no pude leer el cambio (${e.message})` }; } }
    out.push({ file: f, stem: path.posix.basename(f).replace(/\.[^.]+$/, ''), rutas, names: c.known ? c.names : null, reason: c.known ? null : c.reason });
  }
  return out;
}

/**
 * Las bases de touched.json: la de un repo (`base`, de touched-files.js) o, en el árbol armado, la de cada repo
 * (`bases`, de private-tree.js: cada una con su `repo`). Sin `repo`, la base es del repo que se mide.
 */
function basesDeLoTocado(touched) {
  if (touched.base && typeof touched.base.ref === 'string' && touched.base.ref) return [{ ...touched.base, repo: touched.base.repo || null }];
  if (!Array.isArray(touched.bases)) return [];
  return touched.bases.filter((b) => b && typeof b.ref === 'string' && b.ref && typeof b.repo === 'string' && b.repo);
}

/**
 * Contra qué repo y qué base se lee el cambio de `file`: con una base sola, ésa; en el árbol armado, la del único repo
 * que tiene el archivo. En los dos, o en ninguno, es «no sé» (`reason`): no se adivina contra qué base comparar.
 */
function baseDelArchivo(repo, bases, file) {
  if (!bases.length) return { ref: null };
  if (bases.length === 1 && !bases[0].repo) return { repo, ref: bases[0].ref };
  const con = bases.filter((b) => fs.existsSync(path.join(b.repo, file)));
  if (con.length === 1) return { repo: con[0].repo, ref: con[0].ref };
  return { reason: con.length ? `${file} está en ${con.length} de los repos del árbol: no sé contra qué base comparar` : `${file} no está en ningún repo de las bases de touched.json` };
}

// ¿El texto nombra `n` como palabra entera? (`adhoc` sí en «adhoc set», no en «noadhocs»; también con letras fuera del
// ASCII, como los nombres que da change-names.js)
function nombra(text, n) {
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u').test(text);
}

/**
 * Una suite que hoy corre SÓLO porque nombra piezas centrales queda lejos si, en cada una que nombra, se sabe qué cambió
 * y la suite no nombra ninguno de esos nombres ni se llama como la pieza (`pieza-*.test.js`). Devuelve las piezas que
 * nombra, o null si corre: la suite tocada, la que nombra otro archivo tocado, la ilegible y la de una pieza «no sé».
 */
function lejana(repo, p, files, centrales) {
  const leidas = centrales.filter((c) => c.rutas.has(p.ruta));
  if (!leidas.length) return null;
  const own = ownPaths(repo, p.ruta);
  if (files.some((f) => own.includes(f))) return null;
  let text = null;
  try { text = fs.readFileSync(p.ruta, 'utf8'); } catch (_) { return null; }
  const central = new Set(centrales.map((c) => c.file));
  if (files.some((f) => !esSuite(f) && !central.has(f) && nombres(f).some((n) => text.includes(n)))) return null;
  for (const c of leidas) {
    if (!c.names || p.name.startsWith(c.stem) || c.names.some((n) => nombra(text, n))) return null;
  }
  return leidas;
}

/**
 * Qué tan cerca del cambio está una suite que ya se eligió para correr, para ordenarlas cuando pasan el tope de la
 * máquina: la suite tocada (o la ilegible) primero; después la que se llama como un archivo tocado, la que lo nombra por
 * su ruta entera, la que lo nombra por su nombre, y la que nombra lo que cambió dentro de una pieza central. La elegida
 * por la regla de carpetas (`gate_only_when_touching`) va delante de las que sólo nombran.
 */
function cercania(repo, p, files, centrales) {
  const own = ownPaths(repo, p.ruta);
  if (files.some((f) => own.includes(f))) return 1000;
  let text = null;
  try { text = fs.readFileSync(p.ruta, 'utf8'); } catch (_) { return 1000; }
  let n = p.gate ? 50 : 0;
  for (const f of files) {
    if (esSuite(f)) continue;
    const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
    if (stem.length >= 3 && p.name.startsWith(stem)) n += 100;
    if (text.includes(f)) n += 10;
    else if (nombres(f).some((x) => text.includes(x))) n += 3;
  }
  for (const c of centrales) if (c.names && c.rutas.has(p.ruta)) n += c.names.filter((x) => nombra(text, x)).length;
  return n;
}

/** El tope de suites de la máquina para este repo: el de su `.test-gate.yaml` commiteado, o el de fábrica. */
function topeDeLaMaquina(repo) {
  try {
    const n = require('./test-gate-scope.js').scopeOf(repo).maxLocalSuites;
    return Number.isInteger(n) && n > 0 ? n : TOPE_DE_LA_MAQUINA;
  } catch (_) { return TOPE_DE_LA_MAQUINA; }
}

// «Otra suite»: un archivo con `.test.` o uno dentro de una carpeta `tests/`. Un archivo de código que empieza con
// «test-» (test-gate.sh, lib/test-gate-report.js) es código, y una suite que lo nombra lo prueba.
function esSuite(f) { return /\.test\.(js|sh)$/.test(f) || /(^|\/)tests\//.test(f); }

/**
 * Corrida liviana: ¿la suite lee algún archivo tocado? Sí si es ella misma, si vive en la carpeta del
 * archivo (o debajo), o si su texto lo nombra —por su ruta relativa o por su nombre—. Una suite ilegible corre.
 */
function readsTouched(repo, ruta, files) {
  const own = ownPaths(repo, ruta);
  let text = null;
  try { text = fs.readFileSync(ruta, 'utf8'); } catch (_) { return true; }
  const suiteDir = own[0].includes('/') ? path.posix.dirname(own[0]) : '';
  return files.some((f) => {
    if (own.includes(f)) return true;
    const dir = path.posix.dirname(f);
    if (dir !== '.' && (suiteDir === dir || suiteDir.startsWith(`${dir}/`))) return true;
    return text.includes(f) || text.includes(path.posix.basename(f));
  });
}

function main(argv, env = process.env) {
  const [repo, out] = argv;
  const iSk = argv.indexOf('--skills');
  const iCov = argv.indexOf('--coverage');
  const iSu = argv.indexOf('--suite');
  const iBy = argv.indexOf('--scoped-by-repo');
  const iRc = argv.indexOf('--run-check');
  const runCheck = iRc >= 0 ? String(argv[iRc + 1] || '').trim() : null;
  const fullSuiteBy = iBy >= 0 ? String(argv[iBy + 1] || '').trim() : null;
  if (!repo || !out || (iSk >= 0 && !argv[iSk + 1]) || (iCov >= 0 && !argv[iCov + 1]) || (iSu >= 0 && !argv[iSu + 1]) || (iBy >= 0 && (!fullSuiteBy || fullSuiteBy.startsWith('--'))) || (iRc >= 0 && (!runCheck || runCheck.startsWith('--')))) {
    console.error('uso: run-suites-json.js <repo> <resumen.json> [--skills <dir>] [--touched <archivo.json>] [--coverage <dir>] [--light] [--only-touched] [--scoped-by-repo <quién corre la completa>] [--suite <ruta>] [--run-check <check que la envuelve>]');
    return Promise.resolve(2);
  }
  const covDir = iCov >= 0 ? path.resolve(argv[iCov + 1]) : null;
  let skillsRoot;
  try {
    skillsRoot = resolveSkillsRoot(repo, iSk >= 0 ? argv[iSk + 1] : null, env);
  } catch (e) {
    console.error(`[suites.json] no pude resolver la raíz de las skills con ${path.join(repo, 'scripts', 'lib', 'skills-dir.js')}: ${e.message} — no la adivino`);
    escribir(out, { no_medido: `la raíz de las skills no se pudo resolver: ${e.message}`, corridas: 0, fallas: [], ausentes: [] });
    return Promise.resolve(3);
  }
  const skills = skillsRoot.dir;
  const iTo = argv.indexOf('--touched');
  const touchedFile = iTo >= 0 ? argv[iTo + 1] : null;

  const lista = path.join(repo, 'scripts', 'tests', 'suites.json');
  let suites;
  try {
    const d = JSON.parse(fs.readFileSync(lista, 'utf8'));
    suites = [...(d.diarias || []), ...(d.semanales || [])];
  } catch (e) {
    console.error(`[suites.json] no pude leer ${lista}: ${e.message} — sin lista no hay nada que medir`);
    escribir(out, { no_medido: `suites.json ilegible: ${e.message}`, corridas: 0, fallas: [], ausentes: [] });
    return Promise.resolve(3);
  }
  if (!suites.length) {
    console.error(`[suites.json] ${lista} no declara ninguna suite — «0 suites, 0 rojas» no es un verde`);
    escribir(out, { no_medido: 'suites.json sin suites declaradas', corridas: 0, fallas: [], ausentes: [] });
    return Promise.resolve(3);
  }
  const suiteOnly = iSu >= 0 ? argv[iSu + 1] : null;
  if (suiteOnly) {
    suites = suites.filter((s) => s.ruta === suiteOnly);
    if (!suites.length) {
      console.error(`[suites.json] ${suiteOnly} no está en ${lista}: no corrí nada`);
      return Promise.resolve(2);
    }
  }

  // la carga y los núcleos, antes de lanzar ninguna suite: la carga de ahora es la ajena
  const maquina = suiteTimes.machine(env);
  const decision = resolveWorkers(env, maquina);
  const { workers, warning } = decision;
  if (maquina.warning) console.error(`[suites.json] ⚠️  ${maquina.warning}`);
  if (warning) console.error(`[suites.json] ⚠️  ${warning}`);
  // la suite pedida sola corre aunque la difiera lo tocado o la corrida liviana
  const allSuites = env.TYCON_GATE_ALL_SUITES === '1' || Boolean(suiteOnly);
  const touched = readTouched(touchedFile);
  const rerun = new Set(touched.known && Array.isArray(touched.rerun_suites) ? touched.rerun_suites.filter((r) => typeof r === 'string') : []);
  const rerunHallada = new Set();
  // el motivo de una repetida, si quien armó lo tocado lo da (`rerun_reasons`: las que esperan a main, test-gate.sh)
  const motivoDeRepetida = (k) => (touched.rerun_reasons && typeof touched.rerun_reasons[k] === 'string' ? touched.rerun_reasons[k] : 'se repitió sola y la carpeta cambió después: vuelve a correr');
  // Las suites que vuelven por sus carpetas (failed-first.js `decide`, `reactivadas`): claves `<raiz>:<ruta>` de la lista,
  // con su motivo aparte. Corren sin pasar por los filtros, como las repetidas viejas. Con `--suite` no se miran: quien
  // pidió una sola ya sabe lo que corre, y una reactivada de otra lista no es una ausente de esa corrida.
  const reactivadas = new Set(touched.known && !suiteOnly && Array.isArray(touched.reactivated_suites) ? touched.reactivated_suites.filter((r) => typeof r === 'string') : []);
  const motivoDeVuelta = (k) => (touched.reactivated_reasons && typeof touched.reactivated_reasons[k] === 'string' ? touched.reactivated_reasons[k] : 'lo cambiado la vuelve a hacer correr');
  const reactivadaHallada = new Set();
  let light = argv.includes('--light');
  // acotar sin saber qué se tocó sería no correr nada: el acotado por el repo sólo vale con lo tocado conocido
  const byRepo = Boolean(fullSuiteBy) && !allSuites && touched.known;
  const byRepoDeclarado = Boolean(fullSuiteBy) && !argv.includes('--only-touched');
  // con el repo acotado, sin saber qué se tocó tampoco corre todo: la completa no corre en la máquina (sale 7, «sin acotar»)
  const onlyTouched = (argv.includes('--only-touched') || Boolean(fullSuiteBy)) && !allSuites;
  // el tamaño se fija al arrancar: si el cambio real toca código, la corrida deja de ser liviana y corre lo de siempre
  if (light && touched.known) {
    const code = touched.files.find((f) => require('./run-size.js').classifyFile(f).kind === 'code');
    if (code) {
      console.log(`[suites.json] corrida liviana, pero el cambio toca código (${code}): corren las suites de siempre`);
      light = false;
    }
  }

  // Plan: por cada entrada, en el orden de la lista → ausente · diferida · exclusiva · paralela.
  const plan = suites.map((s, idx) => {
    const base = s.raiz === 'agent-skills' ? skills : path.join(repo, 'scripts');
    const ruta = path.join(base, s.ruta);
    const name = path.basename(ruta);
    let exclusive = false;
    if (s.exclusive !== undefined && s.exclusive !== false) {
      exclusive = true;   // cualquier valor que no sea `false` explícito: lo seguro es correrla sola
      if (s.exclusive !== true) console.error(`[suites.json] ⚠️  ${name}: «exclusive» no es booleano (${JSON.stringify(s.exclusive)}) — la corro sola, por las dudas`);
    }
    let gate = null;
    if (s.gate_only_when_touching !== undefined) {
      const g = s.gate_only_when_touching;
      if (Array.isArray(g) && g.length && g.every(isValidPattern)) gate = g;
      else console.error(`[suites.json] ⚠️  ${name}: «gate_only_when_touching» no es una lista de «<carpeta>/**» (${JSON.stringify(g)}) — no la difiero`);
    }
    return { idx, ruta, name, exclusive, gate, fromSkills: s.raiz === 'agent-skills', entrada: { raiz: s.raiz, ruta: s.ruta },
      portable: Array.isArray(s.requiere) && s.requiere.length === 0 };
  });

  const resumen = { corridas: 0, verdes: 0, fallas: [], ausentes: [], suites: [], workers, nucleos: maquina.nucleos, carga: maquina.carga, esperas: { veces: 0, ms: 0 }, wall_ms: 0, deferred_suites: [], unmeasured_suites: [], skills_root: skillsRoot, ...(light ? { light: true } : {}) };
  const results = new Array(plan.length).fill(null);
  const parallel = [];
  const exclusives = [];
  // las que corren pase lo que pase con el tope de la máquina: las repetidas que quedaron viejas
  const fijas = new Set();
  let unknownSaid = false;
  // El grupo `installer` de <repo>/scripts/ci/heavy-suites.json: sus suites corren sólo si la story toca el instalador o
  // la suite misma, con el criterio del selector del repo que se mide. Sin el archivo no hay grupo; si está y no se deja
  // leer (o falta el selector), no se difiere ninguna y se dice una vez.
  let installerCrit = null;
  const installer = () => {
    if (installerCrit) return installerCrit;
    installerCrit = { skips: () => false };
    const heavyFile = path.join(repo, 'scripts', 'ci', 'heavy-suites.json');
    if (!fs.existsSync(heavyFile)) return installerCrit;
    let crit;
    try {
      crit = require(path.join(repo, 'scripts', 'ci', 'suites-for-change.js')).groupCriterion(heavyFile, 'installer');
    } catch (e) {
      crit = { problem: `scripts/ci/suites-for-change.js no se deja usar (${e.code || e.message})` };
    }
    if (crit.problem) console.log(`[suites.json] ⚠️  no pude leer el criterio del instalador (${crit.problem}): sus suites corren`);
    else installerCrit = crit;
    return installerCrit;
  };
  // Con el portón acotado por el repo, las piezas centrales tocadas: sus suites lejanas al cambio quedan para la CI.
  const centrales = byRepo && !light ? piezasCentrales({ repo, plan, files: touched.files, bases: basesDeLoTocado(touched) }) : [];
  const rootMissing = !isDir(skills);
  if (plan.some((p) => p.fromSkills)) console.log(`[suites.json] raíz agent-skills: ${skills} (salió de: ${skillsRoot.source})`);
  for (const p of plan) {
    if (p.fromSkills && rootMissing) {
      // No es «el archivo no está»: no está el árbol entero. Se dice cuál se buscó y por qué regla; y sigue contando
      // como ausente, para que quien sólo lee `ausentes` la vea igual.
      const reason = `la raíz agent-skills no existe: ${skills} (salió de: ${skillsRoot.source})`;
      resumen.unmeasured_suites.push({ suite: p.ruta, reason });
      resumen.ausentes.push(p.ruta);
      console.log(`NO MEDIDA ${p.name} — ${reason}`);
      continue;
    }
    if (!fs.existsSync(p.ruta)) { resumen.ausentes.push(p.ruta); console.log(`AUSENTE  ${p.ruta}`); continue; }
    // Una repetida vieja (failed-first.js `decide`, `rerun`) vuelve a correr sin pasar por los filtros, como `--suite`:
    // se la reconoce por su entrada de la lista, la misma clave con que se guardó la repetición.
    if (rerun.has(p.entrada.ruta)) {
      rerunHallada.add(p.entrada.ruta);
      fijas.add(p);
      // si además vuelve por sus carpetas, también quedó hallada: corre una sola vez, y no es una ausente
      if (reactivadas.has(`${p.entrada.raiz}:${p.entrada.ruta}`)) reactivadaHallada.add(`${p.entrada.raiz}:${p.entrada.ruta}`);
      console.log(`REPETIDA ${p.name} — ${motivoDeRepetida(p.entrada.ruta)}`);
      (p.exclusive ? exclusives : parallel).push(p);
      continue;
    }
    // Una suite que vuelve por sus carpetas corre sin pasar por los filtros: la carpeta (la volvería a diferir si la story
    // no la toca) y «no lee lo tocado» (lee sus carpetas sin nombrarlas). Se la reconoce por la raíz y la ruta de su entrada.
    const claveDeEntrada = `${p.entrada.raiz}:${p.entrada.ruta}`;
    if (reactivadas.has(claveDeEntrada)) {
      reactivadaHallada.add(claveDeEntrada);
      console.log(`VUELVE   ${p.name} — ${motivoDeVuelta(claveDeEntrada)}`);
      (p.exclusive ? exclusives : parallel).push(p);
      continue;
    }
    if (p.gate && !allSuites) {
      // Editar la propia suite la hace correr aunque no toque sus carpetas.
      const propia = ownPaths(repo, p.ruta);
      if (touched.known && !touches(touched.files, p.gate) && !propia.some((o) => touched.files.includes(o))) {
        const reason = `corre de noche y en el control del PR; esta story no toca ${p.gate.join(', ')}`;
        resumen.deferred_suites.push({ suite: p.ruta, reason, entrada: p.entrada });
        console.log(`DIFERIDA ${p.name} — ${reason}`);
        continue;
      }
      if (!touched.known && !unknownSaid) {
        console.log(`[suites.json] no pude saber qué archivos toca la story (${touched.reason || 'sin motivo'}): corre todo`);
        unknownSaid = true;
      }
    }
    if (!p.fromSkills && !allSuites && touched.known && installer().skips(p.name, touched.files)) {
      const reason = 'corre de noche y en el control del PR; esta story no toca el instalador (el grupo installer de scripts/ci/heavy-suites.json)';
      resumen.deferred_suites.push({ suite: p.ruta, reason, entrada: p.entrada });
      console.log(`DIFERIDA ${p.name} — ${reason}`);
      continue;
    }
    if (onlyTouched && touched.known && !namesTouched(repo, p.ruta, touched.files)) {
      const reason = byRepo ? `no lee lo tocado; la suite completa la corre ${fullSuiteBy}` : 'la corrida cruzada (la del repo hermano, o con la story en otro repo) corre sólo las suites que leen lo tocado; la completa la corre la CI del pedido';
      resumen.deferred_suites.push({ suite: p.ruta, reason, entrada: p.entrada });
      console.log(`DIFERIDA ${p.name} — ${reason}`);
      continue;
    }
    // La de la regla de carpetas ya se eligió por lo que toca: la cercanía no la difiere.
    const lejos = centrales.length && !p.gate ? lejana(repo, p, touched.files, centrales) : null;
    if (lejos) {
      const reason = `${lejos.map((c) => `lee ${c.file}, que nombran ${c.rutas.size} suites, pero no nombra lo que cambió (${c.names.join(', ')})`).join('; ')}; la suite completa la corre ${fullSuiteBy}`;
      resumen.deferred_suites.push({ suite: p.ruta, reason, entrada: p.entrada });
      console.log(`DIFERIDA ${p.name} — ${reason}`);
      continue;
    }
    if (light && touched.known && !allSuites && !readsTouched(repo, p.ruta, touched.files)) {
      const reason = 'diferida por corrida liviana: no lee ningún archivo tocado';
      resumen.deferred_suites.push({ suite: p.ruta, reason, entrada: p.entrada });
      console.log(`DIFERIDA ${p.name} — ${reason}`);
      continue;
    }
    (p.exclusive ? exclusives : parallel).push(p);
  }
  // Una repetida vieja sin entrada en la lista no se vuelve a medir: cuenta como ausente (es rojo), no se saltea callada.
  // Su repetición guardada en verde no puede cerrar lo que nadie volvió a correr.
  for (const r of rerun) {
    if (rerunHallada.has(r)) continue;
    resumen.ausentes.push(r);
    console.log(`AUSENTE  ${r} — se repitió sola y la carpeta cambió después, pero ya no está en la lista de suites: no se pudo volver a correr`);
  }
  // Lo mismo para una que vuelve por sus carpetas y ya no está en la lista: ausente (es rojo), nunca salteada callada.
  for (const k of reactivadas) {
    if (reactivadaHallada.has(k)) continue;
    resumen.ausentes.push(k);
    console.log(`AUSENTE  ${k} — lo cambiado la vuelve a hacer correr, pero ya no está en la lista de suites`);
  }

  // El tope de la máquina: acotado por el repo, corren como mucho `tope` suites, las más cercanas al cambio. Las demás
  // quedan para la CI del pedido, que corre la completa. Las tocadas y las repetidas viejas corren siempre.
  let topado = null;
  if (byRepo) {
    // `--max-suites <n>` lo fija quien lanza el corredor (una prueba, un guion); sin él, el del repo o el de fábrica
    const iMax = argv.indexOf('--max-suites');
    const pedido = iMax >= 0 && /^[1-9]\d{0,3}$/.test(String(argv[iMax + 1] || '')) ? Number(argv[iMax + 1]) : null;
    const tope = pedido || topeDeLaMaquina(repo);
    const elegidas = [...parallel, ...exclusives];
    if (elegidas.length > tope) {
      const puntos = new Map(elegidas.map((p) => [p, fijas.has(p) ? 1000 : cercania(repo, p, touched.files, centrales)]));
      const orden = elegidas.map((p, i) => [p, i]).sort((a, b) => (puntos.get(b[0]) - puntos.get(a[0])) || (a[1] - b[1])).map(([p]) => p);
      const quedan = new Set(orden.filter((p, i) => i < tope || puntos.get(p) >= 1000));
      const fuera = elegidas.filter((p) => !quedan.has(p));
      if (fuera.length) {
        const reason = `lee lo tocado, pero pasa el tope de ${tope} suites de la máquina y hay otras más cercanas al cambio; la suite completa la corre ${fullSuiteBy}`;
        for (const p of fuera) { resumen.deferred_suites.push({ suite: p.ruta, reason }); console.log(`DIFERIDA ${p.name} — ${reason}`); }
        for (const lista of [parallel, exclusives]) { const q = lista.filter((p) => quedan.has(p)); lista.length = 0; lista.push(...q); }
        topado = { max: tope, chosen: elegidas.length, deferred: fuera.length };
        console.log(`[suites.json] tope de la máquina: ${elegidas.length} suites leen lo tocado; corren las ${quedan.size} más cercanas y ${fuera.length} quedan fuera (la suite completa la corre ${fullSuiteBy})`);
      }
    }
  }

  for (const c of centrales) {
    const corren = [...parallel, ...exclusives].filter((p) => c.rutas.has(p.ruta)).length;
    console.log(c.names
      ? `[suites.json] ${c.file}: corrieron ${corren} de las ${c.rutas.size} suites que la nombran (para correrlas todas: TYCON_GATE_ALL_SUITES=1)`
      : `[suites.json] ${c.file}: no sé qué cambió adentro (${c.reason}): corren las ${c.rutas.size} suites que la nombran`);
  }

  // Lo tocado que hay que medir (`must_measure`, lib/touched-files.js) y ninguna suite que lo lea: no se acotó nada, y la
  // corrida sale 7 más abajo. Sin esto cerraría en verde sin haber medido.
  const sinMedir = touched.must_measure === true && !parallel.length && !exclusives.length && !resumen.ausentes.length;
  if (byRepo && !sinMedir) resumen.scoped = { by: 'repo', full_suite_by: fullSuiteBy, none_touched: false, ...(topado ? { capped: topado } : {}) };
  // Acotada por el repo y ninguna suite lee lo tocado: verde, dicho. La CI del pedido corre la completa antes del merge.
  if (byRepo && !sinMedir && touched.known && !parallel.length && !exclusives.length && !resumen.ausentes.length) {
    resumen.scoped.none_touched = true;
    console.log(`[suites.json] ninguna suite lee lo tocado; la suite completa la corre ${fullSuiteBy}`);
    escribir(out, resumen);
    return Promise.resolve(0);
  }
  // Sin acotar (salida 7): no se sabe qué se tocó, o ninguna suite lo lee. No se corre nada y no es verde ni rojo.
  if (onlyTouched && (!touched.known || (!parallel.length && !exclusives.length && !resumen.ausentes.length))) {
    const reason = !touched.known
      ? `no sé qué archivos tocó la story en este repo (${touched.reason || 'sin motivo'}): la cubre la CI del pedido${byRepoDeclarado ? '. Para correr lo cercano en la máquina, relanzá con TYCON_COVERAGE_BASE="$(git merge-base origin/main HEAD)"' : ''}`
      : 'ninguna suite lee lo que la story tocó en este repo: la cubre la CI del pedido';
    console.error(`[suites.json] sin acotar — ${reason}`);
    escribir(out, { ...resumen, deferred_suites: [], unscoped: { reason } });
    return Promise.resolve(7);
  }

  if (!parallel.length && !exclusives.length) {
    // El motivo dice lo que pasó: con suites diferidas, no «todas ausentes» (una ausente sigue siendo rojo).
    const nDif = resumen.deferred_suites.length;
    const motivo = !resumen.ausentes.length ? 'no quedó ninguna suite para correr después de diferir'
      : nDif ? `${resumen.ausentes.length} ausente(s) y ${nDif} diferida(s): no quedó ninguna suite para correr`
        : 'todas las suites declaradas están ausentes';
    console.error(`[suites.json] ${motivo} — «0 corridas» no es un verde`);
    escribir(out, { ...resumen, no_medido: motivo });
    return Promise.resolve(resumen.ausentes.length ? 1 : 3);
  }

  const portables = [...parallel, ...exclusives].filter((p) => p.portable).length;

  // El turno de las ejecuciones grandes (scripts/tools/heavy-turn.js): lo que satura la máquina es cuántas suites corren, esté
  // acotada o no la ejecución, y en una máquina con coordinadora va una grande por vez. Con el turno de otro proceso vivo
  // no corre y sale 77, con quién lo tiene. Sin coordinadora (la CI, la nube) no se toma nada.
  const count = parallel.length + exclusives.length;
  // Un portón acotado dice su tamaño antes de pedir el turno: quien lo lanzó (o la coordinadora) sabe cuánto ocupa la
  // máquina antes de que la ocupe. Es el aviso de portón lento adelantado: ése no lo repite.
  const anunciado = onlyTouched && anunciarTamano({ repo, decision, items: [...parallel, ...exclusives], total: plan.length });
  let turn = null;
  if (count >= TURN_FROM_SUITES) {
    // un repo sin el módulo no tiene turno; uno que lo trae y no carga, lo dice
    const turnModule = path.join(repo, 'scripts', 'tools', 'heavy-turn.js');
    try { turn = require(turnModule); } catch (e) {
      turn = null;
      if (fs.existsSync(turnModule)) console.error(`[suites.json] ⚠️  no pude cargar el turno de las ejecuciones grandes (${e.message}): corro igual`);
    }
    let t = { ok: true };
    // no poder mirar el turno no frena la suite: se dice y corre, como antes de que hubiera turno. El nombre sale de la
    // carpeta desde donde se lanza: en el árbol armado, `repo` es una carpeta temporal
    try { if (turn) t = turn.take({ env, what: `${count} suites de ${path.basename(process.cwd())}` }); } catch (e) { console.error(`[suites.json] ⚠️  no pude mirar el turno de las ejecuciones grandes (${e.message}): corro igual`); }
    if (!t.ok) {
      console.error(`[suites.json] ${t.message}`);
      escribir(out, { ...resumen, no_medido: t.message });
      // no es verde ni rojo, y el total no se mide: test-gate.sh la da como su 75, «otra corrida en marcha, esperá»
      return Promise.resolve(turn.BUSY_EXIT);
    }
    if (!t.taken) turn = null;
  }
  // Un portón (lo lanzó test-gate.sh: trae su marca) que corre sin el turno igual deja de esperar y, con coordinadora, se
  // anota mientras corre: la fila lo ve y no da el «arrancá» encima. La espera y la fila son de la máquina, no del repo:
  // vale el heavy-turn.js del arnés que corre esto, y si no está (una copia suelta), el del repo. Nada de esto frena, pero
  // no poder anotarse se dice: la fila pediría el «arrancá» encima de este portón.
  // Con un pase adversarial en vuelo, el portón corre al lado sólo si es chico, va uno solo y hay memoria libre
  // (heavy-turn.js `besidePass`); si no, sale 77 como con el turno ajeno. Un heavy-turn.js sin esa regla no la aplica, y
  // lo dice.
  let gateTurn = null;
  if (!turn && env.TYCON_GATE_PROCESS) {
    const sinAnotar = (why) => console.error(`[suites.json] ⚠️  no pude anotar el portón: la fila de la coordinadora no lo va a ver (${why})`);
    const cargas = [];
    let mod = null;
    for (const m of [path.join(__dirname, '..', '..', '..', '..', 'scripts', 'tools', 'heavy-turn.js'), path.join(repo, 'scripts', 'tools', 'heavy-turn.js')]) {
      if (!fs.existsSync(m)) continue;
      try {
        const x = require(m);
        if (typeof x.gateStarted !== 'function') { cargas.push(`${m} no trae el registro de portones`); continue; }
        if (!mod || (typeof mod.besidePass !== 'function' && typeof x.besidePass === 'function')) mod = x;
        if (typeof mod.besidePass === 'function') break;
      } catch (e) { cargas.push(`${m}: ${e.message}`); }
    }
    if (!mod) sinAnotar(cargas.length ? cargas.join(' · ') : 'no encontré heavy-turn.js');
    else {
      let beside = null;
      if (typeof mod.besidePass !== 'function') console.error('[suites.json] ⚠️  el heavy-turn.js que cargué no trae la regla del portón al lado del pase: no la aplico');
      else {
        let b = null;
        try { b = mod.besidePass({ env, suites: count }); } catch (e) { console.error(`[suites.json] ⚠️  no pude mirar si hay un pase en vuelo (${e.message}): corro igual`); }
        if (b && !b.ok) {
          console.error(`[suites.json] ${b.message}`);
          escribir(out, { ...resumen, no_medido: b.message });
          return Promise.resolve(mod.BUSY_EXIT);
        }
        beside = b && b.pass;
      }
      try {
        const g = mod.gateStarted({ env, what: `${count} suites de ${path.basename(process.cwd())}`, suites: count });
        if (g && g.error) sinAnotar(g.error);
        else if (g && g.file) gateTurn = mod;
      } catch (e) { sinAnotar(e.message); }
      if (gateTurn && beside) {
        const again = mod.besideRecheck({});
        if (!again.ok) {
          gateTurn = null;
          console.error(`[suites.json] ${again.message}`);
          escribir(out, { ...resumen, no_medido: again.message });
          return Promise.resolve(mod.BUSY_EXIT);
        }
      }
    }
  }
  // con el turno ya tomado: un portón que no arranca no deja aviso ni dice su hora de fin
  const slowGate = avisarSiLento({ env, repo, decision, maquina, items: [...parallel, ...exclusives], callado: anunciado });
  console.log(`[suites.json] ${suiteTimes.describeWorkers(decision, maquina)} · en paralelo: ${parallel.length} · solas al final: ${exclusives.length} · diferidas: ${resumen.deferred_suites.length}${portables ? ` · ${portables} portables con su HOME vacía, como en la CI` : ''}`);
  const releaseTurn = () => {
    if (turn) { try { turn.release({}); } catch (_) { /* vence con el proceso */ } turn = null; }
    if (gateTurn) { try { gateTurn.gateEnded({}); } catch (_) { /* se descarta con el proceso */ } gateTurn = null; }
    // el aviso de portón lento se va con la corrida; si queda, la coordinadora lo descarta por el proceso muerto
    if (slowGate) { try { fs.rmSync(slowGate, { force: true }); } catch (_) { /* nada */ } }
  };
  process.on('exit', releaseTurn);

  // El repo acota el portón y no se sabe qué se tocó: corre todo. Se dice acá, lo último antes de la primera suite, con la
  // cantidad y cómo acotarla: quien la lanzó puede cortarla. La base tiene que ser ancestro de HEAD: `origin/main` solo
  // no sirve en una rama atrasada.
  const basesSel = basesDeLoTocado(touched);
  const base = basesSel.length === 1 ? basesSel[0] : null;
  resumen.seleccion = { base: base ? base.ref : null, fuente: base ? base.source : null,
    ...(basesSel.length > 1 ? { bases: basesSel.map((b) => ({ repo: b.repo, ref: b.ref, fuente: b.source || null })) } : {}),
    tocados: touched.known ? touched.files.length : null, corren: count, total: plan.length };
  const desde = base ? ` desde ${base.ref.slice(0, 7)} (${base.source})`
    : basesSel.length > 1 ? ` desde ${basesSel.map((b) => `${b.ref.slice(0, 7)} en ${path.basename(b.repo)}`).join(' y ')}` : '';
  console.log(touched.known
    ? `[suites.json] acotado a lo tocado: ${touched.files.length} archivos${desde}: corren ${count} de ${plan.length}`
    : `[suites.json] sin acotar: ${touched.reason || 'no sé qué se tocó'}: corren ${count} de ${plan.length}`);

  const live = new Set();
  let interrupted = null;
  const onSignal = (sig) => {
    if (interrupted) return;
    interrupted = sig;
    for (const c of live) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* ya terminó */ } }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // El portón que lanzó esta corrida (test-gate.sh, TYCON_GATE_PROCESS): si ya no está —lo mataron con kill -9, o se cerró
  // su terminal—, nadie va a leer el resultado y el turno de las ejecuciones grandes quedaría tomado. Se corta solo.
  const gatePid = Number(env.TYCON_GATE_PROCESS);
  const watchGate = Number.isInteger(gatePid) && gatePid > 1 ? setInterval(() => {
    try { process.kill(gatePid, 0); } catch (e) {
      if (e.code === 'ESRCH') { console.error(`[suites.json] el portón que lanzó esta corrida (pid ${gatePid}) ya no está: corto las suites`); onSignal('SIGTERM'); }
    }
  }, 2000) : null;
  if (watchGate) watchGate.unref();

  if (covDir) {
    // la carpeta es de esta corrida: un lcov de una corrida anterior no puede sumarse a éste (por eso, si igual no se
    // borra, la corrida no sigue)
    const e = removeTree(covDir);
    if (e) throw e;
    fs.mkdirSync(covDir, { recursive: true });
    console.log(`[suites.json] con cobertura: cada suite bajo el medidor de Node, lcov en ${covDir}`);
  }

  // Las portables (`requiere: []`) corren como en la CI: cada una con su HOME vacía, con sólo los dos enlaces de
  // instalación a las skills que se miden. Con la HOME real pasaban acá y fallaban allá, o al revés. Las que piden
  // herramientas siguen con la real: la sesión de esas herramientas vive ahí. Las HOME van bajo `.advisors/` del repo
  // (git la ignora) y no bajo la carpeta temporal, como en la CI: hay suites que tratan esa carpeta como «de prueba».
  // La carpeta temporal de cada una, al revés, va fuera del repo, también como en la CI: hay suites que arman ahí un
  // repo de juguete o suponen estar fuera de todo repo, y dentro del árbol git les contesta la raíz de ese árbol.
  // Un repo que vive él mismo en la carpeta temporal (el árbol armado del privado) declara otra raíz para las HOME con
  // TYCON_SUITE_HOMES_ROOT: bajo el repo quedarían en la carpeta temporal.
  const homesRoot = process.env.TYCON_SUITE_HOMES_ROOT ? path.resolve(process.env.TYCON_SUITE_HOMES_ROOT) : path.join(repo, '.advisors');
  const homesDir = path.join(homesRoot, `suite-homes-${process.pid}`);
  let tmpsDir = null;
  // Las HOME y las carpetas temporales de una corrida anterior que murió sin limpiar (un kill -9): las de un proceso
  // que ya no vive.
  try {
    for (const d of fs.readdirSync(homesRoot)) {
      const m = /^suite-homes-(\d+)$/.exec(d);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); } catch (e) { if (e.code === 'ESRCH') removeTree(path.join(homesRoot, d)); }
    }
  } catch (_) { /* sin .advisors todavía: no hay nada viejo */ }
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      const m = /^suite-tmps-(\d+)-/.exec(d);
      if (!m || Number(m[1]) === process.pid) continue;
      try { process.kill(Number(m[1]), 0); } catch (e) { if (e.code === 'ESRCH') removeTree(path.join(os.tmpdir(), d)); }
    }
  } catch (_) { /* la carpeta temporal no se deja leer: queda lo viejo, no frena la corrida */ }
  const skillsAbs = path.resolve(skills);
  const emptyHome = (p) => {
    const h = path.join(homesDir, `h${p.idx}`);
    const installed = installedSkillsIn(h);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    if (!tmpsDir) tmpsDir = fs.mkdtempSync(path.join(os.tmpdir(), `suite-tmps-${process.pid}-`));
    fs.mkdirSync(path.join(tmpsDir, `t${p.idx}`), { recursive: true });
    const agentSkills = path.dirname(skillsAbs);
    const tipo = process.platform === 'win32' ? 'junction' : 'dir';
    if (isDir(skillsAbs)) fs.symlinkSync(agentSkills, installed, tipo);
    if (isDir(path.join(agentSkills, 'agents'))) fs.symlinkSync(path.join(agentSkills, 'agents'), path.join(path.dirname(installed), 'agents'), tipo);
    return h;
  };
  const removeHomes = () => {
    for (const dir of [homesDir, tmpsDir]) {
      if (!dir) continue;
      const e = removeTree(dir);
      if (!e) continue;
      console.error(`[suites.json] ⚠️  no pude borrar ${dir}: ${e.message} — queda en el disco; el resultado de las suites no cambia`);
      (resumen.not_removed = resumen.not_removed || []).push(dir);
    }
  };
  // El resto de lo que la CI le pone a cada portable (`casaVacia` de scripts/tests/portable-suites.test.sh), salvo el
  // PATH: acá las herramientas de la máquina siguen a mano. Y la configuración de git de quien corre tampoco llega: un
  // gancho global de la máquina (rechazar un merge sin mensaje propio) frenaba acá lo que en la CI pasa. Git la lee de
  // la HOME, pero también de estas variables.
  const isolatedEnv = (home, p) => {
    const e = { ...env };
    for (const k of Object.keys(e)) {
      if (k === 'GIT_CONFIG_GLOBAL' || k === 'XDG_CONFIG_HOME' || k === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete e[k];
    }
    const tmp = path.join(tmpsDir, `t${p.idx}`);
    return Object.assign(e, {
      HOME: home, USERPROFILE: home, TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1',
      TYCON_PROFILE: '0', TYCON_CHROME: '0', TYCON_GUIDES_DIR: path.resolve(repo), TYCON_SKILLS_DIR: skillsAbs,
      TYCON_MAILBOX_JSON: path.join(home, 'no-hay-llave.json'), TYCON_PARITY_BENCH_DIR: path.join(tmp, 'parity-bench'),
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
    });
  };

  // el registro de tiempos de la máquina, una vez por corrida: de ahí sale el tope de cada suite (topeDeSuite)
  const historial = historialDeTiempos(env);

  const runOne = (p) => new Promise((resolve) => {
    let home = null;
    if (p.portable) {
      // Sin su HOME vacía la suite corre igual, con la real, y lo dice: una falla al armarla no tumba la corrida.
      try { home = emptyHome(p); } catch (e) { console.log(`[suites.json] ${p.ruta}: no pude armarle la HOME vacía (${e.code || e.message}); corre con la real`); }
    }
    const [ej, args, childEnv] = launch(p, covDir, home ? isolatedEnv(home, p) : env);
    const t0 = Date.now();
    // detached = grupo de proceso propio: al cortar se mata el grupo entero (la suite y sus hijos).
    const c = spawn(ej, args, { windowsHide: true, cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    live.add(c);
    const chunks = [];
    let size = 0;
    const take = (b) => {
      if (size >= MAX_BUFFER) return;
      chunks.push(b); size += b.length;
    };
    c.stdout.on('data', take);
    c.stderr.on('data', take);
    // Pasado su tope, la suite se corta: SIGTERM a su grupo y, si no se cerró en TOPE_GRACIA_MS, SIGKILL. Si después de
    // otra gracia la salida sigue abierta (un nieto que se fue del grupo la tiene), se suelta y la suite se da por
    // terminada: el nieto queda, pero la corrida sigue.
    const tope = topeDeSuite(p.entrada.ruta, historial, env);
    let vencida = false;
    let rematar = null;
    let soltar = null;
    const senal = (s) => { try { process.kill(-c.pid, s); } catch { try { c.kill(s); } catch { /* ya terminó */ } } };
    const reloj = tope.ms == null ? null : setTimeout(() => {
      // la que ya salió y espera que se cierre su salida no se corta
      if (c.exitCode !== null || c.signalCode !== null) return;
      vencida = true;
      senal('SIGTERM');
      rematar = setTimeout(() => {
        senal('SIGKILL');
        soltar = setTimeout(() => {
          for (const s of [c.stdout, c.stderr]) { try { s.destroy(); } catch { /* ya cerrada */ } }
          done(null, null);
        }, TOPE_GRACIA_MS);
      }, TOPE_GRACIA_MS);
    }, tope.ms);
    let settled = false;
    const done = (status, spawnError) => {
      // 'error' y 'close' pueden llegar los dos (un binario que no arranca): se anota una sola vez.
      if (settled) return;
      settled = true;
      for (const t of [reloj, rematar, soltar]) if (t) clearTimeout(t);
      live.delete(c);
      if (home) removeTree(home);   // lo que quede, lo vuelve a intentar removeHomes al final
      const ms = Date.now() - t0;
      // null = murió por señal: se cuenta como rojo; la que se cortó por su tope también, aunque saliera con otro código
      const exit = vencida || status === null ? 124 : status;
      let salida = spawnError ? `${spawnError.message}\n` : Buffer.concat(chunks).toString('utf8');
      if (vencida) salida += `\n❌ cortada por tiempo: pasó su tope de ${duracion(tope.ms)} (${tope.por})\n`;
      // la que termina por el corte, o por su tope, no se midió: su tiempo no va al registro
      results[p.idx] = { idx: p.idx, ruta: p.ruta, entrada: p.entrada, exit, ms, salida, ...(interrupted || vencida ? { cortada: true } : {}) };
      console.log(exit === 0 ? `ok       ${p.name} (${ms} ms)` : `ROJO(${exit}) ${p.ruta}${vencida ? ` — cortada por tiempo (tope ${duracion(tope.ms)})` : ''}`);
      resolve();
    };
    c.on('error', (e) => done(127, e));
    c.on('close', (code) => done(code, null));
  });

  const stopped = () => Boolean(interrupted);
  // sólo cuando decide la máquina: con la variable o en la CI, como siempre
  const beforeLaunch = decision.wait
    ? launchGate({ nucleos: maquina.nucleos, floor: decision.floor, load: () => suiteTimes.loadNow(env), esperas: resumen.esperas, stopped })
    : null;

  const t0 = Date.now();
  return (async () => {
    await pool(parallel, workers, runOne, { stopped, beforeLaunch });
    await pool(exclusives, 1, runOne, { stopped });
    releaseTurn();
    removeHomes();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (watchGate) clearInterval(watchGate);
    resumen.wall_ms = Date.now() - t0;
    resumen.ambiente = { ...gateEnvironment(env, runCheck, workers), empty_home: portables };
    const outputBudget = { left: RUN_OUTPUT_MAX };

    for (const r of results) {
      if (!r) continue;
      resumen.corridas += 1;
      // con su entrada de la lista: al juntar con lo guardado (failed-first.js `merge`), la misma suite de otra corrida
      // se reconoce por ella, aunque la ruta absoluta cambie (el árbol armado es una carpeta nueva cada vez)
      resumen.suites.push({ ruta: r.ruta, exit: r.exit, ms: r.ms, entrada: r.entrada });
      if (r.exit === 0) resumen.verdes += 1;
      else {
        // El rojo se lee sin re-correr: los casos que fallaron (estén donde estén en la salida), la salida entera en un
        // archivo y la cola, para quien ya la leía.
        const full = saveFullOutput(out, r, resumen.ambiente, outputBudget);
        resumen.fallas.push({
          ruta: r.ruta, exit: r.exit, ms: r.ms, casos: failedCases(r.salida), salida_completa: full.file,
          ...(full.truncated ? { salida_recortada: true } : {}), ...(full.skipped ? { salida_no_guardada: full.skipped } : {}), cola: r.salida.split('\n').slice(-25).join('\n'), entrada: r.entrada,
        });
      }
    }
    if (covDir) {
      const lcov = path.join(covDir, 'lcov.info');
      // lo que no es código de la story: el envoltorio y cada suite (Node 20 no excluye los archivos de prueba)
      const j = joinLcov(covDir, lcov, { base: repo, drop: [WRAPPER, ...plan.map((p) => p.ruta)] });
      const porArchivo = new Map(plan.map((p) => [`${String(p.idx).padStart(4, '0')}.lcov`, p.ruta]));
      // una suite que corrió y no dejó ni su archivo (murió antes de escribirlo) también es «sin datos»
      const corrieron = results.filter(Boolean).map((r) => plan.find((p) => p.ruta === r.ruta));
      const sinArchivo = corrieron.filter((p) => !fs.existsSync(path.join(covDir, `${String(p.idx).padStart(4, '0')}.lcov`))).map((p) => p.ruta);
      resumen.coverage = {
        lcov, with_data: j.withData, without_data: [...j.withoutData.map((n) => porArchivo.get(n) || n), ...sinArchivo],
        unreadable: j.unreadable.map((u) => ({ ruta: porArchivo.get(u.name) || u.name, motivo: u.reason })),
      };
      console.log(`[suites.json] cobertura: ${j.withData} suite(s) con datos · ${resumen.coverage.without_data.length} sin datos`
        + `${j.unreadable.length ? ` · ${j.unreadable.length} ilegible(s): ${resumen.coverage.unreadable.map((u) => `${path.basename(u.ruta)} (${u.motivo})`).join(', ')}` : ''} → ${lcov}`);
    }

    anotarTiempos({ env, repo, workers, maquina, wallMs: resumen.wall_ms, results, cortada: Boolean(interrupted) });
    if (interrupted) {
      console.error(`[suites.json] corrida interrumpida (${interrupted}) — maté las suites que estaban corriendo`);
      escribir(out, { ...resumen, no_medido: `corrida interrumpida (${interrupted})` });
      return interrupted === 'SIGINT' ? 130 : 143;
    }
    escribir(out, resumen);
    // Lo último que se imprime es lo que guarda la cola de run-check: el ambiente y los casos van justo antes del total.
    if (resumen.fallas.length) {
      console.log(`[suites.json] ambiente: ${describeEnvironment(resumen.ambiente)}`);
      for (const f of resumen.fallas) {
        console.log(`ROJO ${path.basename(f.ruta)} (salió ${f.exit} en ${f.ms} ms) — salida completa: ${f.salida_completa || f.salida_no_guardada || 'no se pudo guardar'}`);
        if (!f.casos.length) console.log('  no encontré renglones de casos fallidos (✖, not ok, MAL, ❌, FAIL): mirá la salida completa');
        for (const c of f.casos) console.log(c.split('\n').map((l) => `  ${l}`).join('\n'));
      }
    }
    const rojas = resumen.fallas.length;
    const ausentes = resumen.ausentes.length;
    const unmeasured = resumen.unmeasured_suites.length;
    console.log(`[suites.json] ${resumen.corridas} corridas · ${resumen.verdes} verdes · ${rojas} rojas · ${ausentes} ausentes${unmeasured ? ` (${unmeasured} no medidas: su raíz no existe)` : ''} · ${resumen.deferred_suites.length} diferidas · ${(resumen.wall_ms / 60000).toFixed(1)} min con ${workers} a la vez`);
    return rojas === 0 && ausentes === 0 ? 0 : 1;
  })();
}

// El tope de tiempo de una suite: TOPE_VECES lo más que tardó en esta máquina, entre el piso y el techo; sin medición,
// el techo. Una suite que lo pasa se corta y cuenta roja, con el motivo: una prueba colgada (el 23/11, la de
// guard-record quedó horas en un árbol temporal) no traba la corrida ni se queda con sus procesos.
const TOPE_VECES = 5;
const TOPE_PISO_MS = 10 * 60000;
const TOPE_TECHO_MS = 60 * 60000;
// Después del SIGTERM al grupo de la suite, el SIGKILL: lo que no se cerró solo en este plazo se mata.
const TOPE_GRACIA_MS = 10000;
const RELOJ_MAX_MS = 2 ** 31 - 1;

/**
 * Las corridas del registro de tiempos, del mismo archivo en el que anota el portón (TYCON_SUITE_TIMES, o el de la
 * carpeta de estado). Sin registro, o ilegible, ninguna: cada suite queda con el techo.
 */
function historialDeTiempos(env = process.env) {
  try {
    const file = suiteTimes.target(env, { byDefault: true }).file || path.join(stateDir(), 'suite-times.jsonl');
    return suiteTimes.filterRuns(suiteTimes.readSources([file]).runs);
  } catch (_) { return []; }
}

/**
 * El tope de la suite `ruta` (la de suites.json) con las corridas `runs` del registro: `{ ms, por }`, con `ms` null sin
 * tope y `por` de dónde salió, para el motivo del corte. `TYCON_SUITE_MAX_SECONDS` lo fija para todas (0 = sin tope);
 * un valor que no es un número entero de segundos no cuenta.
 */
function topeDeSuite(ruta, runs, env = process.env) {
  const fijo = String(env.TYCON_SUITE_MAX_SECONDS ?? '').trim();
  if (/^\d+$/.test(fijo)) {
    // más de lo que acepta un reloj de Node (24,8 días) lo dispararía al instante: queda en ese máximo
    return { ms: Number(fijo) === 0 ? null : Math.min(Number(fijo) * 1000, RELOJ_MAX_MS), por: 'fijado con TYCON_SUITE_MAX_SECONDS' };
  }
  let max = 0;
  for (const r of runs || []) {
    for (const s of (r && r.suites) || []) {
      if (s && s.s === ruta && Number(s.ms) > max) max = Number(s.ms);
    }
  }
  const rango = `entre ${TOPE_PISO_MS / 60000} y ${TOPE_TECHO_MS / 60000} min`;
  if (!max) return { ms: TOPE_TECHO_MS, por: `sin medición en esta máquina: el techo (${rango})` };
  return { ms: Math.min(TOPE_TECHO_MS, Math.max(TOPE_PISO_MS, max * TOPE_VECES)), por: `${TOPE_VECES} veces lo más que tardó en esta máquina (${Math.round(max / 1000)} s), ${rango}` };
}

const duracion = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * Cuánto tarda correr `items` con `workers` a la vez: las medianas del registro de la máquina y, sin medición, el peso
 * por defecto de suites-weights.json. `{ est, eta }`, con `eta` la hora estimada de fin. Tira si no puede estimar.
 */
function estimar({ repo, items, workers }) {
  let defaultMs = 30000;
  try {
    const w = JSON.parse(fs.readFileSync(path.join(repo, 'scripts', 'ci', 'suites-weights.json'), 'utf8'));
    const d = (w.pr && w.pr.default) || w.default;
    if (Number(d) > 0) defaultMs = Number(d) * 1000;
  } catch (_) { /* sin pesos, el valor de siempre */ }
  // sin registro, todo con el peso por defecto
  const runs = historialDeTiempos();
  const est = suiteTimes.estimateMs({ rutas: items.map((p) => p.entrada.ruta), workers, runs, defaultMs });
  const fin = new Date(Date.now() + est.ms);
  return { est, eta: `${String(fin.getHours()).padStart(2, '0')}:${String(fin.getMinutes()).padStart(2, '0')}` };
}

/**
 * El tamaño de un portón acotado, en un renglón, antes del turno: cuántas suites de cuántas y los minutos estimados
 * (o «sin estimación» si ninguna tiene medida en la máquina). Desde TURN_FROM_SUITES suites dice que es casi una
 * completa y que pide turno como una. Devuelve si lo dijo: no poder estimar no tumba la corrida.
 */
function anunciarTamano({ repo, decision, items, total }) {
  try {
    const casi = items.length >= TURN_FROM_SUITES ? ' · casi una completa: pide turno como una completa' : '';
    let tiempo = 'sin estimación';
    if (items.length) {
      // con menos suites que carriles, los carriles de más no acortan nada
      const { est, eta } = estimar({ repo, items, workers: Math.max(1, Math.min(decision.workers, items.length)) });
      if (est.medidas) tiempo = `~${Math.max(1, Math.round(est.ms / 60000))} min, termina cerca de las ${eta}${est.sinMedir ? ` (${est.sinMedir} sin medición, con el peso por defecto)` : ''}`;
    }
    console.log(`[suites.json] portón acotado: ${items.length} de ${total} suites · ${tiempo}${casi}`);
    return true;
  } catch (e) {
    console.log(`[suites.json] ⚠️  no pude decir el tamaño del portón acotado: ${e.message}`);
    return false;
  }
}

/**
 * Un portón grande (desde TURN_FROM_SUITES suites) fuera de la CI que arranca con menos de 3 a la vez lo dice en su
 * primera línea, con la hora estimada de fin, y deja su aviso para la coordinadora mientras corre (lib/suite-times.js).
 * La hora sale de las medianas del registro de la máquina; sin medición, el peso por defecto de suites-weights.json.
 * Devuelve la ruta del aviso (para borrarlo al terminar) o null. Nada de esto puede tumbar la corrida. Con `callado`, el
 * tamaño ya se dijo antes del turno (`anunciarTamano`): deja el aviso sin repetir la línea.
 */
function avisarSiLento({ env, repo, decision, maquina, items, callado = false }) {
  if (decision.why === 'ci' || items.length < TURN_FROM_SUITES || decision.workers >= suiteTimes.SLOW_GATE_WORKERS) return null;
  try {
    const { est, eta } = estimar({ repo, items, workers: decision.workers });
    if (!callado) console.log(`🔴 [suites.json] portón lento: ${decision.workers} a la vez para ${items.length} suites (carga ${maquina.carga} al arrancar): termina cerca de las ${eta}${est.sinMedir ? ` (${est.sinMedir} sin medición, con el peso por defecto)` : ''}`);
    // el nombre sale de la carpeta desde donde se lanza, como el del turno: en el árbol armado, `repo` es temporal
    return suiteTimes.writeSlowGate({ sid: env.CLAUDE_CODE_SESSION_ID || null, repo: path.basename(process.cwd()), suites: items.length,
      workers: decision.workers, carga: maquina.carga, eta });
  } catch (e) {
    console.log(`[suites.json] ⚠️  no pude dejar el aviso de portón lento: ${e.message}`);
    return null;
  }
}

// Un renglón por corrida en el registro de tiempos (lib/suite-times.js dice dónde): las suites que terminaron, con su
// `ruta` de suites.json. Un registro que no se deja escribir se dice y no cambia la salida de la corrida.
function anotarTiempos({ env, repo, workers, maquina, wallMs, results, cortada }) {
  try {
    const t = suiteTimes.target(env);
    if (!t.file) return;
    const suites = results.filter((r) => r && !r.cortada).map((r) => ({ s: r.entrada.ruta, ms: r.ms, exit: r.exit }));
    const entry = suiteTimes.entryOf({ origen: 'gate', repo: path.basename(path.resolve(repo)),
      head: suiteTimes.headOf(repo), workers, nucleos: maquina.nucleos, carga: maquina.carga, wallMs, cortada, fingida: maquina.fake, suites });
    const r = suiteTimes.append(entry, t.file);
    if (!r.ok) console.log(`[suites.json] ⚠️  no pude anotar los tiempos de las suites: ${r.reason}`);
  } catch (e) {
    // ni la carpeta de estado puede tumbar la corrida: se dice y la salida queda la de las suites
    console.log(`[suites.json] ⚠️  no pude anotar los tiempos de las suites: ${e.message}`);
  }
}

function escribir(out, obj) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + '\n');
}

if (require.main === module) {
  // Un rechazo al final (p. ej. no se pudo escribir el resumen) no puede quedar como «salió raro»:
  // se dice, y el exit es 3 — «no pude medir» —, nunca 0.
  // `Promise.resolve().then(...)`: una excepción SÍNCRONA de main (las salidas tempranas llaman a
  // escribir() antes de la parte async) también cae acá y sale 3.
  Promise.resolve().then(() => main(process.argv.slice(2))).then((code) => process.exit(code), (e) => {
    console.error(`[suites.json] el runner falló antes de dejar el resumen: ${e && e.stack ? e.stack : e}`);
    process.exit(3);
  });
}
module.exports = { main, resolveWorkers, launchGate, pool, failedCases, capOutput, saveFullOutput, FULL_OUTPUT_MAX, RUN_OUTPUT_MAX, resolveSkillsRoot, topeDeSuite, historialDeTiempos, TOPE_PISO_MS, TOPE_TECHO_MS };
