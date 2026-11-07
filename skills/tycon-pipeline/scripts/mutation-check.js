#!/usr/bin/env node
'use strict';
/**
 * mutation-check.js — CHEQUEO DE MUTANTES del harness TYCON.
 *
 * Por qué existe: la suite en verde NO prueba que los tests ejerzan lo que
 * dicen — un test puede pasar sin probar nada. La
 * compensación manual es romper cada control a mano y mirar que un test se
 * ponga rojo; eso depende de que alguien se acuerde. Esto lo mecaniza: muta
 * las líneas AGREGADAS del diff (operadores chicos y determinísticos — ver
 * lib/mutation-mutants.js), corre los tests que la story declara, y reporta
 * qué mutantes murieron (algún test los cazó) y cuáles SOBREVIVIERON (nadie
 * los probó).
 *
 * CLI:
 *   node mutation-check.js --repo <dir> --story <ruta/spec.md>
 *                          [--files a.ts b.ts] [--max-mutants N] [--json]
 *
 *   - Targets: ÚNICAMENTE lo que la story declara en files_to_create/
 *     files_to_modify, sin los que parecen test (el pipeline es POR STORY:
 *     descubrir targets mirando `git diff HEAD` / `ls-files --others`
 *     mutaría archivos ajenos al scope y seguiría symlinks
 *     fuera del repo). `--files` queda
 *     como override explícito. Las LÍNEAS a mutar sí salen del delta: diff
 *     contra la base de la corrida para tracked (lib/coverage-base.js: el
 *     `baseSha` del marcador, la bifurcación con la rama principal o HEAD),
 *     archivo entero para los nuevos.
 *   - Todo target (declarado o de --files) tiene que resolver DENTRO del repo
 *     tras symlinks (fs.realpathSync + prefijo con separador) → si no, exit 2
 *     SIN escribir nada. Un declarado que no existe en disco → `skipped` con
 *     su razón, nunca un crash.
 *   - Tests a correr: los que la story declara cuyo path parezca de test. Si no
 *     declara ninguno → exit 2 con el motivo. Los corre la receta de pruebas del
 *     paquete o proyecto más cercano (lib/test-runners.js, scopedRecipe: Jest,
 *     Vitest, .NET, pytest, `node --test` o la de la organización que declara
 *     `scoped`), acotada a esos archivos — nunca la suite entera. La receta se
 *     elige por estructura, jamás leyendo una prueba. Muta JS/TS, C# y Python.
 *   - Topes por receta (BUDGETS): .NET 8 min en total y 3 por corrida; las demás
 *     3 y 2. Cada corrida, además, nunca pasa lo que queda del total.
 *   - --max-mutants default 20 (los excedentes quedan en `skipped`).
 *
 * Exit codes:
 *   0 → corrió bien (aunque haya sobrevivientes: en v1 AVISA, no bloquea).
 *   1 → CERO mutantes muertos habiendo generado al menos uno — los tests no
 *       ejercen el código nuevo.
 *   2 → error de uso o estructural (story sin tests declarados, base no verde,
 *       tests de un runner que no sé correr, target fuera del repo, restore
 *       fallido, repo inválido). Fail-closed: ante cualquier duda estructural,
 *       exit 2 con el motivo — nunca exit 0 silencioso.
 *
 * Invariante SAGRADO: por cada mutante se guardan los BYTES exactos del archivo,
 * se restaura SIEMPRE (try/finally) y se verifica byte a byte. Si el restore
 * falla → exit 2 gritando con el path y el backup. Nada importa más que esto:
 * un runner que deja el repo mutado es un desastre.
 *
 * Cableado: lo invoca `marker.js complete-step run-tests` vía lib/mutation-gate.js
 * (AVISA, NO FRENA — la semántica del gate vive allá). JSON de salida:
 *   { total, killed, survived: [{file, line, operator, before, after}],
 *     skipped: [...], verdict }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const mutantesJs = require(path.join(__dirname, 'lib', 'mutation-mutants.js'));
const mutantesCs = require(path.join(__dirname, 'lib', 'mutation-mutants-cs.js'));
const mutantesPy = require(path.join(__dirname, 'lib', 'mutation-mutants-py.js'));
const { applyMutant } = mutantesJs;
const { parseDeclaredFiles } = require(path.join(__dirname, 'lib', 'test-scope.js'));
const { scopedRecipe } = require(path.join(__dirname, 'lib', 'test-runners.js'));
const { resolver: resolverBase, leerMarcador } = require(path.join(__dirname, 'lib', 'coverage-base.js'));

// Extensiones que este runner sabe mutar: JS/TS, C# y Python, cada una con su catálogo.
const CODE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|cs|py)$/i;

// Tope por CORRIDA de `node --test` cuando nadie pasa otro: pasado esto, el hijo muere con
// SIGKILL y `timedOut: true` — el dato se propaga, no se disfraza de "falló".
const RUN_CAP_MS = 120000;

// Topes por receta, que cierran entre sí: el total del chequeo (base incluida) y el de cada corrida, que además nunca
// pasa lo que queda del total. En un producto .NET la base tarda unos 25 s y cada mutante de 12 a 37 s (recompila):
// entre 3 y 8 min para 12 mutantes; un archivo de Jest o Vitest, de 1 a 5 s.
const BUDGETS = Object.freeze({
  dotnet: Object.freeze({ totalMs: 480000, perRunMs: 180000 }),
  default: Object.freeze({ totalMs: 180000, perRunMs: 120000 }),
});

// ── ¿El path parece un archivo de test? ─────────────────────────────────────
// Estructura, no vocabulario suelto: el nombre del archivo o la carpeta de pruebas, con una extensión que el chequeo
// sabe mutar. JS/TS: sufijo .test./.spec. o carpeta de tests. C#: `*Test(s).cs` o un proyecto `*.Tests`. Python:
// `test_*.py`, `*_test.py` o lo que está en `tests/`. Qué RECETA las corre se decide también por estructura
// (lib/test-runners.js, scopedRecipe), JAMÁS leyendo una prueba: un comentario que diga «vitest» no cambia nada.
function looksLikeTestPath(p) {
  const f = String(p || '').replace(/\\/g, '/');
  if (!CODE_EXT_RE.test(f)) return false;
  // `Tests?` con mayúscula, como se nombra una clase de prueba: `Latest.cs` o `Contest.cs` son código
  if (/\.cs$/i.test(f)) return /Tests?\.cs$/.test(f) || /(^|\/)[^/]*\.Tests?\//i.test(f) || /(^|\/)tests?\//i.test(f);
  if (/\.py$/i.test(f)) return /(^|\/)test_[^/]*\.py$/i.test(f) || /_test\.py$/i.test(f) || /(^|\/)tests?\//i.test(f);
  if (/\.(test|spec)\.(m|c)?[tj]sx?$/i.test(f)) return true;
  if (/(^|\/)(tests?|__tests__)\//i.test(f)) return true;
  return false;
}

// Los archivos de Python que viven entre las pruebas pero no son una prueba que se le pasa a pytest.
const PY_NO_PRUEBA = /(^|\/)(conftest|__init__)\.py$/i;

/** Los mutantes de un archivo, con el catálogo de su lenguaje. */
function mutantesDe(entry) {
  if (/\.cs$/i.test(entry.file)) return mutantesCs.mutantsForFile(entry);
  if (/\.py$/i.test(entry.file)) return mutantesPy.mutantsForFile(entry);
  return mutantesJs.mutantsForFile(entry);
}

/** Orden estable: archivo (alfabético), línea, operador — el mismo de cada catálogo. */
function generateMutants(entries) {
  const sorted = entries.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const out = [];
  for (const e of sorted) out.push(...mutantesDe(e));
  return out;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────
// Números de línea AGREGADOS (1-based, lado nuevo) de un diff unificado -U0.
function parseAddedLines(diffText) {
  const out = [];
  for (const line of String(diffText || '').split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

// ── git helpers ──────────────────────────────────────────────────────────────
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// Líneas a mutar de UN target ya validado: delta contra la base de la corrida
// (`base`, lo commiteado durante la corrida también es nuevo) si está tracked,
// archivo entero si es nuevo (la story lo CREA — todas sus líneas son nuevas,
// esté o no en `.gitignore`: si la story lo declara, está en scope).
function addedLinesOf(repo, relFile, base = 'HEAD') {
  const tracked = git(repo, ['ls-files', '--', relFile]);
  if (tracked && tracked.trim() !== '') {
    const diff = git(repo, ['diff', '-U0', base, '--', relFile]);
    // un diff que falla no es «nada agregado»: el que llama lo anota como no medido
    if (diff === null) return null;
    return parseAddedLines(diff);
  }
  let src = '';
  try { src = fs.readFileSync(path.join(repo, relFile), 'utf8'); } catch { return []; }
  return src.split('\n').map((_l, i) => i + 1);
}

// ── Runner de tests por default (inyectable en los tests de esta herramienta) ─
// Recibe { repo, testFiles, mutant } — mutant es null en la corrida BASE.
// Devuelve (promesa de) { code, timedOut } con el exit code REAL. Timeout/señal
// → la suite no terminó bien → cuenta como NO-verde (code 1): un mutante que
// cuelga la suite también fue "detectado". Pero el dato `timedOut` se PROPAGA
// en la corrida BASE, «la maté yo por tiempo» y «falló» son
// diagnósticos distintos — tirarlo convertiría una suite lenta VERDE en "rota".
//
// 🔴 Es spawn ASÍNCRONO a propósito: con spawnSync el
// event loop queda bloqueado durante toda la suite y los handlers de señal del
// runner NO PUEDEN correr — un SIGTERM en medio de un mutante quedaría diferido
// hasta el final y el proceso ni restauraría ni saldría 2 (saldría 0 ignorando
// la señal). Con await, el loop queda libre y el handler restaura al instante.
function defaultRunTests({ repo, testFiles, capMs = RUN_CAP_MS }) {
  // 🔴 NODE_TEST_CONTEXT se hereda cuando ESTE proceso corre bajo `node --test`
  // (p.ej. desde la propia suite del harness) y hace que el `node --test` hijo
  // salga SIEMPRE 0 — aunque los tests fallen. Con eso heredado, TODO mutante
  // "sobrevive" y el chequeo miente (killed=0 con un mutante que a mano moría).
  // Por eso se limpia del entorno del hijo.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...testFiles], {
      cwd: repo, env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ya murió */ }
    }, capMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code === null || code === undefined ? 1 : code, timedOut });
    });
  });
}

// ── Cuántas pruebas corrieron, según el resultado de la receta ───────────────
// null = no se pudo leer. Con cero pruebas una base «verde» no prueba nada: todo mutante sobreviviría.
function countTests(format, text) {
  const s = String(text == null ? '' : text);
  if (format === 'jest-json') {
    try { const j = JSON.parse(s); return Number.isInteger(j.numTotalTests) ? j.numTotalTests : null; } catch { return null; }
  }
  if (format === 'trx') {
    const m = s.match(/<Counters\b[^>]*\btotal="(\d+)"/);
    return m ? parseInt(m[1], 10) : null;
  }
  if (format === 'junit') {
    // `errors` son las que no llegaron a correr (pytest anota así un import roto o una colección fallida): no cuentan
    const corridas = (tag) => {
      const tests = tag.match(/\btests="(\d+)"/);
      const errors = tag.match(/\berrors="(\d+)"/);
      return tests ? Math.max(0, parseInt(tests[1], 10) - (errors ? parseInt(errors[1], 10) : 0)) : null;
    };
    const raiz = s.match(/<testsuites\b[^>]*>/);
    if (raiz && corridas(raiz[0]) != null) return corridas(raiz[0]);
    const suites = [...s.matchAll(/<testsuite\b[^>]*>/g)].map((m) => corridas(m[0])).filter((n) => n != null);
    return suites.length ? suites.reduce((n, x) => n + x, 0) : null;
  }
  return null;
}

/** Todas las carpetas debajo de `d`, ella incluida (para `**`). */
function carpetasDebajo(d) {
  const out = [d];
  let nombres = [];
  try { nombres = fs.readdirSync(d, { withFileTypes: true }); } catch { nombres = []; }
  for (const n of nombres) if (n.isDirectory()) out.push(...carpetasDebajo(path.join(d, n.name)));
  return out;
}

/**
 * Los archivos que coinciden con `patron` —`*` dentro de un segmento, `**` cualquier cantidad de carpetas, como en las
 * recetas del portón—, contados desde `base` si el patrón es relativo.
 */
function buscarArchivos(base, patron) {
  const absoluto = path.isAbsolute(patron);
  const partes = patron.split(/[\\/]/).filter(Boolean);
  let actuales = [absoluto ? path.parse(patron).root : base];
  for (const p of partes) {
    if (absoluto && actuales.length === 1 && actuales[0] === path.parse(patron).root && /^[A-Za-z]:$/.test(p)) continue;
    if (p === '**') { actuales = [...new Set(actuales.flatMap(carpetasDebajo))]; continue; }
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').split('*').join('.*')}$`);
    const sig = [];
    for (const d of actuales) {
      if (!p.includes('*')) { sig.push(path.join(d, p)); continue; }
      let nombres = [];
      try { nombres = fs.readdirSync(d); } catch { nombres = []; }
      for (const n of nombres) if (re.test(n)) sig.push(path.join(d, n));
    }
    actuales = sig;
  }
  return actuales.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/** Cuántas pruebas dice el resultado de la corrida (null si no hay ninguno legible). */
function leerResultado(results, resultsDir, cwd) {
  const ruta = String(results.path).split('{results}').join(resultsDir);
  const archivos = buscarArchivos(cwd, ruta);
  if (!archivos.length) return null;
  let total = 0;
  for (const f of archivos) {
    let n = null;
    try { n = countTests(results.format, fs.readFileSync(f, 'utf8')); } catch { n = null; }
    if (n == null) return null;
    total += n;
  }
  return total;
}

// ── Corredor de una receta (todas menos `node --test`) ───────────────────────
// Corre el comando acotado con bash, en la carpeta del paquete dentro de la copia, con su propia carpeta de
// resultados. Pasado `capMs`, muere el grupo de procesos entero con SIGKILL (dotnet o jest lanzan hijos) y queda
// `timedOut: true`. Devuelve también cuántas pruebas corrieron (`tests`), leídas del resultado de la receta.
function runRecipe({ recipe, capMs = RUN_CAP_MS }) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutation-resultados-'));
  const command = String(recipe.command).split('{results}').join(resultsDir.split(path.sep).join('/'));
  // sin .pyc: uno escrito en una corrida podría servirle el código a la siguiente (mismo segundo, mismo tamaño)
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const grupo = process.platform !== 'win32';
  const limpiar = () => { try { fs.rmSync(resultsDir, { recursive: true, force: true }); } catch { /* nada */ } };
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { cwd: recipe.cwd, env, stdio: ['ignore', 'ignore', 'ignore'], detached: grupo });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { if (grupo) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* ya murió */ }
      }
    }, capMs);
    child.on('error', (e) => { clearTimeout(t); limpiar(); reject(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      const tests = recipe.results ? leerResultado(recipe.results, resultsDir, recipe.cwd) : undefined;
      limpiar();
      resolve({ code: code === null || code === undefined ? 1 : code, timedOut, tests });
    });
  });
}

/** El corredor por defecto: `node --test` como siempre, y las demás recetas con su comando acotado. */
function defaultRun({ repo, testFiles, recipe, capMs }) {
  if (!recipe || recipe.name === 'node-test') return defaultRunTests({ repo, testFiles, capMs });
  return runRecipe({ recipe, capMs });
}

// ── El chequeo ───────────────────────────────────────────────────────────────
/**
 * Arma la copia descartable sobre la que se mutan y se corren los tests. Devuelve { dir } o
 * { dir: null, motivo }. Nunca escribe en `repo`.
 */
function crearCopiaDeTrabajo(repo, log) {
  const { execFileSync } = require('child_process');
  const g = (cwd, args, opts) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(opts || {}) });
  let dir = null;
  try {
    // Por su ruta real: en macOS la carpeta temporal es un enlace (/var → /private/var), y .NET restaura los paquetes con
    // una ruta y compila con la otra, y no los encuentra (la base sale en rojo con la suite verde).
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutation-copia-')));
    const head = g(repo, ['rev-parse', 'HEAD']).trim();
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', repo, dir], { stdio: 'ignore' });
    g(dir, ['checkout', '-q', head]);
    // lo que la story cambió y todavía no commiteó (trackeado)
    const patch = g(repo, ['diff', 'HEAD', '--binary'], { maxBuffer: 256 * 1024 * 1024 });
    if (patch.trim()) g(dir, ['apply', '--whitespace=nowarn', '-'], { input: patch });
    // y lo untracked (archivos nuevos que la story creó), respetando .gitignore
    const nuevos = g(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    for (const rel of nuevos) {
      const src = path.join(repo, rel); const dst = path.join(dir, rel);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        // Un symlink se copia COMO symlink: si se siguiera, un enlace a un archivo de AFUERA del
        // repo entraría a la copia como archivo normal y la guarda N2 («target que resuelve fuera
        // del repo → exit 2») dejaría de ver el problema.
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
        else fs.copyFileSync(src, dst);
      } catch { /* un untracked ilegible no frena la copia */ }
    }
    // 🔴 Y lo que git IGNORA también tiene que estar. Enlazar sólo `<repo>/node_modules` no alcanza: con las
    // dependencias en una subcarpeta, un `.env`, un `local.json` o un `dist/` que la suite lee, la BASE
    // fallaría en la copia con la suite VERDE en el original, el motivo acusaría a la suite, y el gate lo
    // trataría como «no aplicable — sigue sin frenar»: el control se apagaría solo, en silencio, en cada
    // corrida. Lo ignorado se ENLAZA si es un
    // directorio (node_modules, dist: no se copia nada pesado; `bin/` y `obj/` no, ver abajo) y se COPIA si es un archivo
    // suelto. Un mutante que escriba en un directorio ignorado enlazado escribe en el original —
    // es material que git no cuida, y es el precio de que la suite encuentre sus dependencias.
    let ignorados = [];
    try {
      ignorados = g(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
        .split('\0').filter(Boolean);
    } catch { /* sin lista de ignorados se sigue sin ellos */ }
    for (const rel of ignorados) {
      const src = path.join(repo, rel); const dst = path.join(dir, rel.replace(/\/$/, ''));
      // `bin/` y `obj/` no se enlazan, en ninguna carpeta: una compilación de .NET en la copia escribiría a través del
      // enlace en el repo del dev. Se compila en la copia, desde cero.
      // Tampoco `__pycache__/`: un .pyc viejo del original puede servir un mutante anterior (Python sólo compara el
      // segundo y el tamaño del fuente, y `==`/`!=` no cambian el tamaño).
      if (rel.endsWith('/') && /^(bin|obj|__pycache__)$/i.test(path.basename(rel.replace(/\/$/, '')))) continue;
      try {
        if (fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (rel.endsWith('/')) fs.symlinkSync(src, dst, 'dir');
        else {
          const st = fs.lstatSync(src);
          if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
          else if (st.size <= 64 * 1024 * 1024) fs.copyFileSync(src, dst);
        }
      } catch { /* un ignorado ilegible no frena la copia */ }
    }
    // Submódulos: `clone --no-checkout` los deja vacíos y `submodule update` saldría a la red. Se
    // enlaza el directorio del original (la suite los lee, no los muta: no son target de la story).
    let submodulos = '';
    try { submodulos = g(repo, ['config', '--file', '.gitmodules', '--get-regexp', 'path']); } catch { /* sin submódulos */ }
    for (const linea of submodulos.split('\n').filter(Boolean)) {
      const rel = linea.split(/\s+/).slice(1).join(' ');
      if (!rel) continue;
      const src = path.join(repo, rel); const dst = path.join(dir, rel);
      try {
        if (!fs.existsSync(src)) continue;
        try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* no estaba */ }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.symlinkSync(src, dst, 'dir');
      } catch { /* un submódulo ilegible no frena la copia */ }
    }
    if (log) log(`mutation-check: corriendo sobre una copia descartable (${dir}), no sobre ${repo}`);
    return { dir };
  } catch (e) {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nada */ } }
    return { dir: null, motivo: String((e && e.message) || e).slice(0, 200) };
  }
}

async function runMutationCheck({
  repo: repoOriginal,
  storyPath,
  files = null,
  maxMutants = 20,
  deadlineMs = null,
  runTests = defaultRun,
  fsOps = null,
  log = (...a) => console.error(...a),
  // la configuración de la organización (sus recetas en stack.test_runners); sin pasarla, se lee del árbol del arnés
  stack = undefined,
  // opciones de scopedRecipe (`which`: si un programa está en el PATH)
  recipeOpts = {},
  // reloj de pared, sólo para los topes (nunca decide el orden de los mutantes)
  now = Date.now,
  // el marcador de la corrida (su `baseSha`); sin él, la base es la bifurcación con la rama principal. `markerError`:
  // por qué no se pudo leer
  marker = null,
  markerError = null,
}) {
  let repo = repoOriginal;
  // La base se resuelve en el repo original: la copia de trabajo tiene otras ramas remotas. Una base descartada se dice.
  const resuelta = resolverBase({ repo: repoOriginal, env: process.env, marker, markerError });
  const base = resuelta.ref || 'HEAD';
  for (const d of resuelta.descartadas) log(`⚠️  mutation-check: base descartada (${d.source}): ${d.motivo}`);
  // Seam inyectable de fs para la sección SAGRADA del restore (DI con defaults
  // reales — en producción es fs puro, cero cambio de comportamiento). Existe
  // porque la verificación byte a byte del restore, sin un seam, no se puede cubrir con un test
  // (un `restoreOk = true;` hardcodeado dejaría la suite en verde): no hay forma de simular un restore
  // que escribe bytes distintos.
  const fso = {
    readFileSync: fs.readFileSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    ...(fsOps || {}),
  };
  // lo que se sabe del chequeo hasta acá (la receta, cuántos mutantes, el tope) viaja también en una salida estructural
  const ctx = { base: resuelta.ref ? { ref: resuelta.ref, fuente: resuelta.source } : { ref: 'HEAD', fuente: 'sin-base' } };
  const fail2 = (motivo) => {
    log(`🔴 mutation-check: ${motivo}`);
    return { exitCode: 2, result: { motivo, ...ctx } };
  };

  // 1. Repo válido (fail-closed).
  let repoStat = null;
  try { repoStat = fs.statSync(repo); } catch { /* cae abajo */ }
  if (!repoStat || !repoStat.isDirectory()) return fail2(`--repo no es un directorio: ${repo}`);
  const inside = git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return fail2(`--repo no es un repo git: ${repo}`);
  if (!Number.isInteger(maxMutants) || maxMutants < 1) {
    return fail2(`--max-mutants tiene que ser un entero ≥ 1 (recibí: ${maxMutants})`);
  }

  // 🔴 1b. Los mutantes corren sobre una COPIA descartable, nunca sobre el working tree del dev
  // Un mutante no es un bug: es código roto a propósito.
  // Si el archivo bajo mutación tiene efectos sobre el repo (git, borrar archivos, red), el chequeo
  // los ejecutaría contra el repo REAL, N veces, con el código deliberadamente roto — un mutante
  // que da vuelta el operador que elige el repo destino deja cosas preparadas en el índice de verdad.
  // Y contaminaría el diagnóstico: un revisor que lea el archivo durante la ventana vería el mutante
  // y lo reportaría como bug.
  // La copia: `git clone --shared` (comparte objetos, cuesta lo que cuesta el checkout), el diff
  // sin commitear aplicado encima, los untracked copiados, y `node_modules` enlazado — para que el
  // árbol sea el mismo que el dev tiene delante, incluido lo que la story todavía no commiteó.
  // Se prefiere a la alternativa (una lista de archivos «con efectos» que
  // excluir): la lista hay que mantenerla, y el día que le falte un nombre el problema vuelve.
  // Sin un commit del que clonar (repo recién iniciado) no hay copia posible: se muta en el propio
  // repo, y se dice — un exit 2 acá apagaría el control en silencio.
  const sinHead = !git(repoOriginal, ['rev-parse', '--verify', '-q', 'HEAD']);
  const copia = sinHead ? { dir: null, motivo: 'el repo no tiene commits' } : crearCopiaDeTrabajo(repoOriginal, log);
  if (!copia.dir && !sinHead) return fail2(`no pude armar la copia de trabajo para mutar: ${copia.motivo}`);
  if (sinHead) log(`⚠️  mutation-check: ${repoOriginal} no tiene commits todavía — se muta EN EL PROPIO REPO (con restore byte a byte), no en una copia`);
  repo = copia.dir || repoOriginal;
  const limpiarCopia = () => { if (copia.dir) { try { fs.rmSync(copia.dir, { recursive: true, force: true }); } catch { /* si no existe, no hay nada que limpiar */ } } };
  // La copia se borra al terminar (en el finally de abajo) y, para las salidas tempranas por
  // `fail2`, al salir el proceso: una copia huérfana en tmp es basura, nunca un riesgo.
  process.once('exit', limpiarCopia);

  // 2. Tests declarados por la story (sin tests no hay chequeo posible).
  let storyText = null;
  try { storyText = fs.readFileSync(storyPath, 'utf8'); } catch { /* cae abajo */ }
  if (storyText == null) return fail2(`no pude leer la story: ${storyPath}`);
  const declared = parseDeclaredFiles(storyText);
  // Separar «declara tests» de «los sé correr» — por ESTRUCTURA (el nombre del
  // archivo), jamás leyendo contenido en busca de nombres de herramientas.
  // Una story .NET declara `FooTests.cs`: decirle "no declarás tests" es FALSO.
  // `FooTests.<ext>` con mayúscula (una clase de prueba de otro lenguaje), no `latest.ts`
  const declaredTests = declared.filter(
    (f) => looksLikeTestPath(f) || /Tests?\.[a-z]+$/.test(String(f)) || /\.(test|spec)\.[a-z]+$/i.test(String(f)),
  );
  if (!declaredTests.length) {
    return fail2(
      'la story no declara ningún archivo de test en files_to_create/files_to_modify — ' +
      'sin tests declarados no se puede chequear que los mutantes mueran'
    );
  }
  const absTests = declaredTests.map((f) => (path.isAbsolute(f) ? f : path.join(repo, f)));
  const faltantes = absTests.filter((f) => !fs.existsSync(f));
  if (faltantes.length) {
    return fail2(`la story declara tests que NO existen en disco: ${faltantes.join(', ')}`);
  }
  // La receta que corre esas pruebas: la del paquete o proyecto más cercano (lib/test-runners.js, scopedRecipe), con
  // su comando acotado a esos archivos. Ante la DUDA —dos recetas, dos paquetes, una receta que no sabe acotar, el
  // binario sin instalar— exit 2 estructural: un veredicto que deja pruebas afuera en silencio da sobrevivientes falsos.
  let stackOrg = stack;
  if (stackOrg === undefined) {
    try { stackOrg = require(path.join(__dirname, 'lib', 'stack-config.js')).readStack().stack; } catch { stackOrg = undefined; }
  }
  const aCorrerComoPrueba = absTests.map((f) => path.relative(repo, f).split(path.sep).join('/')).filter((f) => !PY_NO_PRUEBA.test(f));
  const recipe = scopedRecipe({ repo, testFiles: aCorrerComoPrueba, stack: stackOrg, ...recipeOpts });
  if (recipe.problem) {
    return fail2(`${recipe.problem}. No se afirma nada sobre esa suite (puede estar perfectamente verde con su runner real).`);
  }
  for (const w of recipe.warnings || []) log(`⚠️  mutation-check: ${w}`);
  ctx.runner = recipe.name;
  const presupuesto = BUDGETS[recipe.name] || BUDGETS.default;
  const totalMs = deadlineMs || presupuesto.totalMs;
  ctx.budgetMs = totalMs;
  const nombreDelCorredor = recipe.name === 'node-test' ? '`node --test`' : `\`${recipe.name}\``;

  // 3. Archivos target: --files (override explícito), o ÚNICAMENTE los NO-test
  // que la story declara. NADA de descubrir targets mirando el diff del repo:
  // descubrirlos abre un agujero nuevo SIEMPRE, porque el
  // repo tiene más vida que la story (artefactos del propio pipeline, scratch
  // del dev, templates ajenos, symlinks). Las LÍNEAS
  // a mutar sí salen del delta (addedLinesOf), que cubre tracked y nuevos.
  const overrideExplicito = Array.isArray(files) && files.length > 0;
  const rawTargets = overrideExplicito
    // Un `--files` absoluto se relativiza contra el repo ORIGINAL (el que el dev nombró), no
    // contra la copia: contra la copia se resolvería «fuera del repo» y saldría 2.
    ? files.map((f) => (path.isAbsolute(f) ? path.relative(repoOriginal, f) : f))
    : declared;
  const targets = [...new Set(rawTargets.map((f) => String(f).replace(/\\/g, '/')))]
    .filter((f) => CODE_EXT_RE.test(f) && !looksLikeTestPath(f))
    .sort();

  // 4. Validar cada target y generar mutantes sobre las líneas agregadas.
  //   - Declarado que no existe en disco → `skipped` con su razón (una story
  //     puede declarar un archivo que todavía no se escribió) — nunca un crash.
  //   - Target que resuelva FUERA del repo tras symlinks → exit 2 SIN escribir
  //     nada (un symlink untracked haría que el chequeo mutara un archivo
  //     externo que `git status` del repo ni muestra).
  let realRepo;
  try { realRepo = fs.realpathSync(repo); } catch (e) {
    return fail2(`no pude resolver el path real del repo ${repo}: ${e && e.message}`);
  }
  const skipped = [];
  const entries = [];
  for (const rel of targets) {
    const abs = path.resolve(repo, rel);
    if (!fs.existsSync(abs)) {
      if (overrideExplicito) return fail2(`--files incluye un archivo inexistente: ${rel}`);
      skipped.push({ file: rel, reason: 'declarado por la story pero no existe en disco — nada que mutar' });
      continue;
    }
    let realAbs;
    try { realAbs = fs.realpathSync(abs); } catch (e) {
      return fail2(`no pude resolver el path real del target ${rel}: ${e && e.message}`);
    }
    if (!realAbs.startsWith(realRepo + path.sep)) {
      return fail2(
        `el target ${rel} resuelve FUERA del repo tras seguir symlinks (${realAbs}) — ` +
        `no se escribe nada fuera de ${realRepo}; no se mutó ningún archivo`
      );
    }
    const addedLines = addedLinesOf(repo, rel, base);
    if (addedLines === null) {
      skipped.push({ file: rel, reason: `git diff contra la base ${base} falló: sus líneas no se midieron` });
      continue;
    }
    if (!addedLines.length) continue;
    entries.push({ file: rel, source: fs.readFileSync(abs, 'utf8'), addedLines });
  }
  const todos = generateMutants(entries);
  if (!todos.length) {
    const result = {
      total: 0, killed: 0, survived: [], skipped, ...ctx, mutants: 0,
      verdict: 'SIN_MUTANTES',
      motivo: targets.length
        ? 'ningún operador aplica sobre las líneas agregadas de los archivos que la story declara'
        : 'la story no declara archivos de código NO-test en files_to_create/files_to_modify',
    };
    log(`⚠️ mutation-check: ${result.motivo} — no se verificó nada.`);
    return { exitCode: 0, result };
  }
  const aCorrer = todos.slice(0, maxMutants);
  skipped.push(...todos.slice(maxMutants).map((m) => ({ ...m, reason: `excede --max-mutants (${maxMutants})` })));
  ctx.mutants = aCorrer.length;

  // 5+6. Corrida BASE + loop de mutantes, con estos blindajes:
  //   - Handlers de señal (SIGINT/SIGTERM/SIGHUP) mientras el tramo corre: el
  //     `finally` NO se ejecuta cuando una señal mata el proceso, así que un
  //     timeout del padre (SIGTERM de spawnSync) o un Ctrl+C dejarían el repo
  //     MUTADO en silencio. El handler restaura SINCRÓNICAMENTE el mutante en
  //     vuelo con fs real, grita y sale 2.
  //   - Deadline ENTRE mutantes (`--deadline-ms`): el corte de presupuesto nunca
  //     cae en medio de un mutante; los restantes quedan en `skipped` con razón
  //     `deadline`. (Date.now acá es control de ejecución, NO decide orden: el
  //     orden de mutantes sigue determinístico; cuántos alcanzaron a correr
  //     depende del reloj y queda declarado en el reporte.)
  //   - TODO el tramo va en try/catch → cualquier excepción cae a fail2 (exit 2)
  //     con el mensaje real. Sin esto, una excepción suelta (EACCES, ENOSPC)
  //     saldría con el exit 1 default de Node — indistinguible de «cero mutantes
  //     muertos» — y el gate bloquearía el step acusando en falso a los tests.
  let enVuelo = null; // { abs, origBuf, backupPath } del mutante aplicado en disco, o null
  const onSignal = (sig) => {
    // Restore de EMERGENCIA con fs REAL (no el seam): sincrónico, pase lo que pase.
    try {
      if (enVuelo) {
        try { fs.writeFileSync(enVuelo.abs, enVuelo.origBuf); } catch { /* la verificación decide */ }
        let ok = false;
        try { ok = Buffer.compare(fs.readFileSync(enVuelo.abs), enVuelo.origBuf) === 0; } catch { ok = false; }
        console.error(`🔴 mutation-check: recibí ${sig} con un mutante APLICADO en disco.`);
        console.error(ok
          ? `   Restauré ${enVuelo.abs} byte a byte antes de salir.`
          : `🔴🔴 NO PUDE RESTAURAR ${enVuelo.abs} — recuperá a mano desde el backup: ${enVuelo.backupPath}`);
      } else {
        console.error(`🔴 mutation-check: recibí ${sig} — no había mutante aplicado, el repo queda intacto.`);
      }
    } catch (e) {
      console.error(`🔴 mutation-check: ${sig} y el restore de emergencia explotó (${e && e.message}). Backup: ${enVuelo && enVuelo.backupPath}`);
    }
    process.exit(2);
  };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    const inicio = now(); // presupuesto de pared — control de ejecución, no de orden
    // El tope de cada corrida: el de la receta, sin pasar lo que queda del total (así el chequeo entero no pasa el total
    // más lo que tarda en restaurar).
    const topeDeLaCorrida = () => Math.max(1, Math.min(presupuesto.perRunMs, totalMs - (now() - inicio)));

    // El aviso, antes de la base: cuánto puede tardar. El portón deja pasar esta línea en el momento.
    log(`Chequeo de mutantes: ${aCorrer.length} mutantes en ${recipe.name}; puede tardar hasta ${Math.ceil(totalMs / 60000)} min`);

    // Corrida BASE sin mutar: si la suite ya está en rojo, TODO mutante "muere"
    // gratis y el chequeo parece perfecto — el falso verde exacto que esta
    // herramienta existe para cazar, un nivel más arriba. Fail-closed.
    let base;
    const capBase = topeDeLaCorrida();
    try {
      base = await runTests({ repo, testFiles: absTests, mutant: null, recipe, capMs: capBase });
    } catch (e) {
      return fail2(`el comando de test explotó en la corrida BASE (sin mutar nada): ${e && e.message}`);
    }
    if (!base || base.code !== 0) {
      // Decir la VERDAD y nada más. Un exit != 0 acá puede ser (a) la
      // suite realmente rota, (b) tests que la receta no sabe cargar (vitest
      // con globals, dependencias, la compilación), o (c) — si timedOut — una suite lenta VERDE que
      // matamos nosotros. Nunca afirmar «está en rojo» sin saber cuál es.
      if (base && base.timedOut) {
        return fail2(
          `la corrida BASE superó el tope de ${capBase}ms por corrida y la maté yo — ` +
          'la suite es demasiado lenta para este chequeo; no afirmo nada sobre su estado'
        );
      }
      // ¿Es la suite, o es la COPIA? Si en el original la misma corrida está verde, la copia no
      // tiene algo que la suite necesita — y eso se dice, en vez de acusar a la suite. Sólo con `node --test`: las
      // demás recetas compilan o escriben resultados, y correrlas en el original escribiría en el repo del dev.
      if (copia.dir && recipe.name === 'node-test') {
        let enOriginal = null;
        try {
          enOriginal = await runTests({ repo: repoOriginal, testFiles: absTests.map((t) => path.join(repoOriginal, path.relative(repo, t))), mutant: null, recipe, capMs: capBase });
        } catch { /* no se pudo comparar */ }
        if (enOriginal && enOriginal.code === 0) {
          return fail2(
            `la corrida BASE con \`node --test\` salió en rojo en la COPIA descartable (exit ${base ? base.code : '?'}) ` +
            'pero en VERDE en el repo original: la copia no tiene algo que la suite necesita (un archivo ' +
            'ignorado por git fuera de los que se copian, un submódulo, algo generado por el build). ' +
            'La suite no está rota; el chequeo no pudo correr sobre la copia.'
          );
        }
      }
      return fail2(
        `la corrida BASE con ${nombreDelCorredor} no salió en verde (exit ${base ? base.code : '?'}) — ` +
        `o la suite está realmente rota, o estos tests no corren con ${nombreDelCorredor} en la copia (la receta ` +
        'elegida, las dependencias o la compilación). Un veredicto de mutantes sin base verde no significa nada; ' +
        'verificá la suite con su runner real.'
      );
    }
    // Una base «verde» que no corrió ninguna prueba no prueba nada: todo mutante sobreviviría. Las recetas que dejan
    // su resultado dicen cuántas corrieron (`node --test` no deja ninguno).
    if (recipe.results) {
      if (base.tests == null) return fail2('no pude leer el resultado de la base: no sé cuántas pruebas corrieron, y no sigo con los mutantes');
      if (base.tests === 0) return fail2('el filtro no coincidió con ninguna prueba: la base corrió cero pruebas, y no sigo con los mutantes');
    }

    // Loop de mutantes. El restore es SAGRADO: bytes exactos, try/finally,
    // verificación byte a byte, y exit 2 gritando si algo quedó distinto.
    let killed = 0;
    let ejecutados = 0;
    let deadlineHit = false;
    const survived = [];
    for (let i = 0; i < aCorrer.length; i++) {
      // El corte de presupuesto se decide ENTRE mutantes, nunca adentro de uno.
      if (now() - inicio >= totalMs) {
        for (let j = i; j < aCorrer.length; j++) {
          skipped.push({ ...aCorrer[j], reason: `deadline de ${totalMs}ms alcanzado — no llegó a correr` });
        }
        deadlineHit = true;
        break;
      }
      const m = aCorrer[i];
      const abs = path.join(repo, m.file);
      const origBuf = fso.readFileSync(abs);
      const mutado = applyMutant(origBuf.toString('utf8'), m);
      if (mutado == null) {
        skipped.push({ ...m, reason: 'la línea del archivo ya no coincide con el mutante (¿archivo cambiado durante la corrida?)' });
        continue;
      }
      const backupPath = path.join(os.tmpdir(), `tycon-mutation-backup-${process.pid}-${i}-${path.basename(m.file)}`);
      fso.writeFileSync(backupPath, origBuf); // si tira (tmp lleno), cae al catch general → exit 2
      let outcome = null;
      let runError = null;
      let mutError = null;
      let restoreOk = false;
      enVuelo = { abs, origBuf, backupPath };
      try {
        // El write del mutante se ATRAPA — un EACCES acá no puede escapar
        // como exit 1 (eso acusaría a los tests del dev por un problema nuestro).
        try { fso.writeFileSync(abs, mutado, 'utf8'); } catch (e) { mutError = e; }
        if (!mutError) {
          try { outcome = await runTests({ repo, testFiles: absTests, mutant: m, recipe, capMs: topeDeLaCorrida() }); } catch (e) { runError = e; }
        }
      } finally {
        // Restaurar SIEMPRE y verificar byte a byte. La VERIFICACIÓN manda: si
        // el write de restore falla pero el archivo quedó intacto (p.ej. el
        // mutante nunca se pudo escribir), restoreOk es true — no se grita en falso.
        try { fso.writeFileSync(abs, origBuf); } catch { /* la verificación decide */ }
        try { restoreOk = Buffer.compare(fso.readFileSync(abs), origBuf) === 0; } catch { restoreOk = false; }
      }
      if (!restoreOk) {
        log('🔴🔴🔴 RESTORE FALLIDO — EL REPO QUEDÓ MUTADO 🔴🔴🔴');
        log(`   Archivo: ${abs}`);
        log(`   Backup con los bytes originales: ${backupPath}`);
        log('   Restaurar A MANO YA (cp del backup sobre el archivo) antes de tocar nada más.');
        return { exitCode: 2, result: { motivo: `restore fallido: ${abs} quedó mutado; bytes originales en ${backupPath}` } };
      }
      enVuelo = null;
      try { fso.unlinkSync(backupPath); } catch { /* best-effort */ }
      if (mutError) {
        return fail2(`no pude escribir el mutante en ${abs}: ${mutError.message} — el archivo quedó intacto (verificado byte a byte)`);
      }
      if (runError) {
        return fail2(
          `el comando de test explotó corriendo el mutante ${m.file}:${m.line} (${m.operator}): ` +
          `${runError.message}. El archivo fue restaurado byte a byte.`
        );
      }
      // Una corrida que pasó su tope no es «cazado» ni «sobrevivió»: no se midió.
      if (outcome && outcome.timedOut) {
        skipped.push({ ...m, reason: 'la corrida pasó su tope y la maté yo: no cuenta como cazado' });
        deadlineHit = true;
        continue;
      }
      // Una receta que deja resultado y no lo dejó (o dice cero pruebas) no midió nada. En rojo, el mutante no compila
      // o no carga (dotnet sale 1 en la compilación): contarlo como cazado inflaría `killed`. En verde, el resultado no
      // se pudo leer: contarlo como sobreviviente acusaría a pruebas que nadie vio correr.
      if (recipe.results && outcome && !outcome.tests) {
        skipped.push({
          ...m,
          reason: outcome.code !== 0
            ? 'la corrida no llegó a correr pruebas (el mutante no compila o no carga): no cuenta como cazado'
            : 'la corrida salió bien pero su resultado no dice qué pruebas corrieron: no cuenta como sobreviviente',
        });
        continue;
      }
      ejecutados += 1;
      // Exit code REAL: != 0 → el mutante MURIÓ (algún test lo cazó). 0 → SOBREVIVIÓ.
      if (outcome && outcome.code !== 0) killed += 1;
      else survived.push(m);
    }

    const total = ejecutados;
    let verdict;
    // Cero medidos con mutantes generados no es «no había nada que mutar»: se intentó y no se pudo medir ninguno.
    if (total === 0) verdict = deadlineHit ? 'DEADLINE_SIN_CORRER' : (skipped.length ? 'SIN_MEDIR' : 'SIN_MUTANTES');
    else if (killed === 0) verdict = 'TESTS_NO_EJERCEN_EL_CODIGO';
    else verdict = survived.length ? 'AVISO_SOBREVIVIENTES' : 'OK';
    if (total < aCorrer.length) log(`mutation-check: midió ${total} de ${aCorrer.length} mutantes (el resto, por tope: ver skipped)`);
    const result = { total, killed, survived, skipped, verdict, ...ctx, repoDeTrabajo: copia.dir };
    return { exitCode: killed === 0 && total > 0 ? 1 : 0, result };
  } catch (e) {
    // NUNCA dejar escapar una excepción — Node saldría con exit 1, que el
    // gate leería como «cero mutantes muertos» y bloquearía acusando en falso.
    return fail2(`excepción inesperada del chequeo: ${e && e.message}`);
  } finally {
    for (const s of SIGNALS) process.removeListener(s, onSignal);
    limpiarCopia();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { repo: null, story: null, files: null, maxMutants: 20, json: false, unknown: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--story') out.story = argv[++i];
    else if (a === '--files') {
      out.files = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]);
    } else if (a === '--max-mutants') out.maxMutants = parseInt(argv[++i], 10);
    else if (a === '--deadline-ms') out.deadlineMs = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else { out.unknown = a; break; }
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown) {
    console.error(`🔴 argumento desconocido: ${args.unknown}`);
    console.error('uso: mutation-check.js --repo <dir> --story <spec.md> [--files a.ts b.ts] [--max-mutants N] [--json]');
    process.exit(2);
  }
  if (!args.repo || !args.story) {
    console.error('uso: mutation-check.js --repo <dir> --story <spec.md> [--files a.ts b.ts] [--max-mutants N] [--json]');
    process.exit(2);
  }
  (async () => {
    let outcome;
    try {
      outcome = await runMutationCheck({
        repo: path.resolve(args.repo),
        storyPath: path.resolve(args.story),
        files: args.files,
        maxMutants: args.maxMutants,
        deadlineMs: Number.isInteger(args.deadlineMs) && args.deadlineMs > 0 ? args.deadlineMs : null,
        ...(({ marker, error }) => ({ marker, markerError: error }))(leerMarcador()),
      });
    } catch (e) {
      // Cinturón extra — una excepción acá saldría con exit 1 de Node, que es
      // indistinguible de «cero mutantes muertos». Siempre exit 2 con el motivo.
      console.error(`🔴 mutation-check: excepción no manejada: ${e && e.stack ? e.stack : e}`);
      process.exit(2);
    }
    const { exitCode, result } = outcome;
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.motivo && result.verdict === undefined) {
      // El motivo ya salió por log (stderr).
    } else {
      console.log(`mutantes: ${result.total} · muertos: ${result.killed} · sobrevivientes: ${result.survived.length} · veredicto: ${result.verdict}`);
      for (const m of result.survived) {
        console.log(`  ⚠️ SOBREVIVIÓ ${m.file}:${m.line} [${m.operator}]`);
        console.log(`     antes:   ${m.before.trim()}`);
        console.log(`     mutado:  ${m.after.trim()}  ← ningún test lo detectó`);
      }
      if (result.skipped.length) console.log(`  (skipped: ${result.skipped.length} — ver --json para el detalle)`);
    }
    process.exit(exitCode);
  })();
}

module.exports = {
  looksLikeTestPath, parseAddedLines, addedLinesOf, runMutationCheck, parseArgs, defaultRunTests, runRecipe, countTests,
  crearCopiaDeTrabajo, buscarArchivos, BUDGETS,
};
