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
 *     contra HEAD para tracked, archivo entero para los nuevos.
 *   - Todo target (declarado o de --files) tiene que resolver DENTRO del repo
 *     tras symlinks (fs.realpathSync + prefijo con separador) → si no, exit 2
 *     SIN escribir nada. Un declarado que no existe en disco → `skipped` con
 *     su razón, nunca un crash.
 *   - Tests a correr: los que la story declara cuyo path parezca de test. Si no
 *     declara ninguno → exit 2 con el motivo. Sólo se sabe correr `node --test`
 *     (.js/.mjs/.cjs) — la señal es la EXTENSIÓN (estructura), jamás escanear
 *     el repo buscando nombres de herramientas.
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

const { generateMutants, applyMutant } = require(path.join(__dirname, 'lib', 'mutation-mutants.js'));
const { parseDeclaredFiles } = require(path.join(__dirname, 'lib', 'test-scope.js'));

// Extensiones que este runner sabe mutar (JS/TS — los tests corren con node --test).
const CODE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;

// Tope por CORRIDA de suite (base o mutante): pasado esto, el hijo muere con
// SIGKILL y `timedOut: true` — el dato se propaga, no se disfraza de "falló".
const RUN_CAP_MS = 120000;

// ── ¿El path parece un archivo de test? ─────────────────────────────────────
// Estructura, no vocabulario suelto: sufijo .test./.spec. o directorio de tests
// canónico, siempre con extensión de código ejecutable.
function looksLikeTestPath(p) {
  const f = String(p || '').replace(/\\/g, '/');
  if (!CODE_EXT_RE.test(f)) return false;
  if (/\.(test|spec)\.(m|c)?[tj]sx?$/i.test(f)) return true;
  if (/(^|\/)(tests?|__tests__)\//i.test(f)) return true;
  return false;
}

// Este chequeo SÓLO sabe
// correr `node --test`, y qué sabe correr se decide por ESTRUCTURA — la
// extensión del test declarado — JAMÁS escaneando contenido en busca de
// palabras como «vitest» (un comentario que diga
// vitest no puede apagar un control, y la herramienta número once lo rompe
// igual). .js/.mjs/.cjs → corrible; todo lo demás → exit 2 estructural honesto.
const NODE_RUNNABLE_RE = /\.(js|mjs|cjs)$/i;

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

// Líneas a mutar de UN target ya validado: delta contra HEAD si está tracked,
// archivo entero si es nuevo (la story lo CREA — todas sus líneas son nuevas,
// esté o no en `.gitignore`: si la story lo declara, está en scope).
function addedLinesOf(repo, relFile) {
  const tracked = git(repo, ['ls-files', '--', relFile]);
  if (tracked && tracked.trim() !== '') {
    const diff = git(repo, ['diff', '-U0', 'HEAD', '--', relFile]);
    return parseAddedLines(diff || '');
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
function defaultRunTests({ repo, testFiles }) {
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
    }, RUN_CAP_MS);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code === null || code === undefined ? 1 : code, timedOut });
    });
  });
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-mutation-copia-'));
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
    // directorio (node_modules, dist, bin/obj: no se copia nada pesado) y se COPIA si es un archivo
    // suelto. Un mutante que escriba en un directorio ignorado enlazado escribe en el original —
    // es material que git no cuida, y es el precio de que la suite encuentre sus dependencias.
    let ignorados = [];
    try {
      ignorados = g(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
        .split('\0').filter(Boolean);
    } catch { /* sin lista de ignorados se sigue sin ellos */ }
    for (const rel of ignorados) {
      const src = path.join(repo, rel); const dst = path.join(dir, rel.replace(/\/$/, ''));
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
  runTests = defaultRunTests,
  fsOps = null,
  log = (...a) => console.error(...a),
}) {
  let repo = repoOriginal;
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
  const fail2 = (motivo) => {
    log(`🔴 mutation-check: ${motivo}`);
    return { exitCode: 2, result: { motivo } };
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
  // Separar «declara tests» de «los sé correr» — por ESTRUCTURA (la
  // extensión), jamás leyendo contenido en busca de nombres de herramientas.
  // Una story .NET declara `FooTests.cs`: decirle "no declarás tests" es FALSO;
  // la verdad honesta es que este chequeo no sabe correr esa suite. Y ante la
  // DUDA (mezcla de corribles y no corribles) → exit 2 estructural: un
  // veredicto parcial que excluye tests declarados en silencio produce
  // sobrevivientes espurios.
  const declaredTests = declared.filter(
    (f) => looksLikeTestPath(f) || /Tests?\.[a-z]+$|\.(test|spec)\.[a-z]+$/i.test(String(f)),
  );
  if (!declaredTests.length) {
    return fail2(
      'la story no declara ningún archivo de test en files_to_create/files_to_modify — ' +
      'sin tests declarados no se puede chequear que los mutantes mueran'
    );
  }
  const noCorribles = declaredTests.filter((f) => !NODE_RUNNABLE_RE.test(String(f)));
  if (noCorribles.length) {
    return fail2(
      `este chequeo hoy sólo sabe correr \`node --test\` (.js/.mjs/.cjs); la story declara ` +
      `tests que no puedo correr: ${noCorribles.join(', ')}. No se afirma nada sobre esa ` +
      `suite (puede estar perfectamente verde con su runner real).`
    );
  }
  const absTests = declaredTests.map((f) => (path.isAbsolute(f) ? f : path.join(repo, f)));
  const faltantes = absTests.filter((f) => !fs.existsSync(f));
  if (faltantes.length) {
    return fail2(`la story declara tests que NO existen en disco: ${faltantes.join(', ')}`);
  }

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
    const addedLines = addedLinesOf(repo, rel);
    if (!addedLines.length) continue;
    entries.push({ file: rel, source: fs.readFileSync(abs, 'utf8'), addedLines });
  }
  const todos = generateMutants(entries);
  if (!todos.length) {
    const result = {
      total: 0, killed: 0, survived: [], skipped,
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
    const inicio = Date.now(); // presupuesto de pared — control de ejecución, no de orden

    // Corrida BASE sin mutar: si la suite ya está en rojo, TODO mutante "muere"
    // gratis y el chequeo parece perfecto — el falso verde exacto que esta
    // herramienta existe para cazar, un nivel más arriba. Fail-closed.
    let base;
    try {
      base = await runTests({ repo, testFiles: absTests, mutant: null });
    } catch (e) {
      return fail2(`el comando de test explotó en la corrida BASE (sin mutar nada): ${e && e.message}`);
    }
    if (!base || base.code !== 0) {
      // Decir la VERDAD y nada más. Un exit != 0 acá puede ser (a) la
      // suite realmente rota, (b) tests que node --test no sabe cargar (vitest
      // con globals, etc.), o (c) — si timedOut — una suite lenta VERDE que
      // matamos nosotros. Nunca afirmar «está en rojo» sin saber cuál es.
      if (base && base.timedOut) {
        return fail2(
          `la corrida BASE superó el tope de ${RUN_CAP_MS}ms por corrida y la maté yo — ` +
          'la suite es demasiado lenta para este chequeo; no afirmo nada sobre su estado'
        );
      }
      // ¿Es la suite, o es la COPIA? Si en el original la misma corrida está verde, la copia no
      // tiene algo que la suite necesita — y eso se dice, en vez de acusar a la suite.
      if (copia.dir) {
        let enOriginal = null;
        try {
          enOriginal = await runTests({ repo: repoOriginal, testFiles: absTests.map((t) => path.join(repoOriginal, path.relative(repo, t))), mutant: null });
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
        `la corrida BASE con \`node --test\` no salió en verde (exit ${base ? base.code : '?'}) — ` +
        'o la suite está realmente rota, o estos tests no corren con `node --test` (lo único que ' +
        'este chequeo sabe correr). Un veredicto de mutantes sin base verde no significa nada; ' +
        'verificá la suite con su runner real.'
      );
    }

    // Loop de mutantes. El restore es SAGRADO: bytes exactos, try/finally,
    // verificación byte a byte, y exit 2 gritando si algo quedó distinto.
    let killed = 0;
    let ejecutados = 0;
    let deadlineHit = false;
    const survived = [];
    for (let i = 0; i < aCorrer.length; i++) {
      // El corte de presupuesto se decide ENTRE mutantes, nunca adentro de uno.
      if (deadlineMs && Date.now() - inicio > deadlineMs) {
        for (let j = i; j < aCorrer.length; j++) {
          skipped.push({ ...aCorrer[j], reason: `deadline de ${deadlineMs}ms alcanzado — no llegó a correr` });
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
          try { outcome = await runTests({ repo, testFiles: absTests, mutant: m }); } catch (e) { runError = e; }
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
        return fail2(`no pude escribir el mutante en ${abs}: ${mutError && mutError.message} — el archivo quedó intacto (verificado byte a byte)`);
      }
      if (runError) {
        return fail2(
          `el comando de test explotó corriendo el mutante ${m.file}:${m.line} (${m.operator}): ` +
          `${runError && runError.message}. El archivo fue restaurado byte a byte.`
        );
      }
      ejecutados += 1;
      // Exit code REAL: != 0 → el mutante MURIÓ (algún test lo cazó). 0 → SOBREVIVIÓ.
      if (outcome && outcome.code !== 0) killed += 1;
      else survived.push(m);
    }

    const total = ejecutados;
    let verdict;
    if (total === 0) verdict = deadlineHit ? 'DEADLINE_SIN_CORRER' : 'SIN_MUTANTES';
    else if (killed === 0) verdict = 'TESTS_NO_EJERCEN_EL_CODIGO';
    else verdict = survived.length ? 'AVISO_SOBREVIVIENTES' : 'OK';
    const result = { total, killed, survived, skipped, verdict, repoDeTrabajo: copia.dir };
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

module.exports = { looksLikeTestPath, parseAddedLines, runMutationCheck, parseArgs, defaultRunTests };
