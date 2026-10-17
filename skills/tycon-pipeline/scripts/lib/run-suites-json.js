#!/usr/bin/env node
'use strict';
/**
 * run-suites-json.js — corre las suites declaradas en `<repo>/scripts/tests/suites.json`.
 *
 * Es el 5to stack del test-gate (2026-09-05). Los repos del equipo con package.json o .csproj ya
 * tenían gate; el repo del ARNÉS no tiene ninguno de los dos: sus suites son archivos sueltos
 * (`.js` que se corren con `node`, `.sh` con `bash`) declarados en `suites.json`, que el pipeline
 * de Azure ya recorre cada noche. Sin este runner el gate salía «no se detectó stack» y no escribía
 * `tests-result.json`, y sin ese artefacto la matriz de DoD marcaba como NOT-RUN criterios con la
 * suite realmente verde. Es la MISMA lista que usa el pipeline — no una copia — así que lo que el
 * gate mide en la máquina es lo que el nocturno mide en el servidor.
 *
 * EN PARALELO desde la story 7.15 (2026-09-29): en serie el gate del arnés tardaba 49,5 y 67,9 min
 * (153 suites; exportador-real sola, 24-41). Ahora:
 *   · corren W a la vez: `TYCON_SUITES_MAX_WORKERS` (entero positivo) o la mitad de los núcleos —
 *     el mismo 50 % que el gate le pone a jest y a vitest para no fundir la máquina del dev;
 *   · `"exclusive": true` en la entrada → corre sola, al final, de a una (comparte estado con otras);
 *   · `"gate_only_when_touching": ["<carpeta>/**"]` → se DIFIERE si el cambio real de la corrida no toca
 *     esas carpetas ni el archivo de la propia suite (`--touched <json de lib/touched-files.js>`). Sin `--touched`, con `known: false` o con
 *     `TYCON_GATE_ALL_SUITES=1`, corre todo: «no pude mirar» nunca se lee como «no toca».
 *   Esos dos campos los lee SÓLO este runner; el nocturno y el control del PR los ignoran.
 *
 * LA RAÍZ `agent-skills` LA DICE EL REPO QUE SE MIDE (story 8.18 del arnés, 2026-10-03): los dos repos
 * internos se unieron y esas suites viven en `<repo>/skills`. Este runner las buscaba en
 * `TYCON_SKILLS_DIR` o en `~/.claude/agent-skills/skills`: en un clon de trabajo del repo unido corría
 * las suites INSTALADAS en la máquina y el gate daba verde sin haber probado el cambio. Ahora, sin
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
 * `coverage.without_data` y no rompe nada. Sin `--coverage`, todo igual que antes: ni envoltorio ni carpeta.
 *
 * Uso:  node run-suites-json.js <repo> <resumen.json> [--skills <dir>] [--touched <archivo.json>] [--coverage <dir>]
 *   · `raiz: "arnes"`        → <repo>/scripts/<ruta>
 *   · `raiz: "agent-skills"` → <skills>/<ruta>   (`--skills`; si no, la función del repo; en un repo sin
 *                              esa función, lo de antes: TYCON_SKILLS_DIR, o ~/.claude/agent-skills/skills)
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

const MAX_BUFFER = 64 * 1024 * 1024;
const WRAPPER = path.join(__dirname, 'coverage-wrapper.js');

/**
 * Cómo se lanza una suite: `[ejecutable, args, env]`. Con cobertura, bajo el envoltorio: sin la variable que anida
 * corridas de `node --test` (con ella el medidor no escribe su reporte) ni una carpeta de V8 de afuera (cada suite mide
 * en la suya).
 */
function launch(p, covDir, env) {
  const ej = p.ruta.endsWith('.js') ? process.execPath : 'bash';
  if (!covDir) return [ej, [p.ruta], env];
  const e = { ...env };
  delete e.NODE_TEST_CONTEXT;
  delete e.NODE_V8_COVERAGE;
  // Sin `--test-coverage-exclude`: Node 20 no la tiene. El envoltorio y la propia suite se descartan al juntar.
  return [process.execPath, ['--experimental-test-coverage', '--test-reporter=lcov',
    `--test-reporter-destination=${path.join(covDir, `${String(p.idx).padStart(4, '0')}.lcov`)}`, WRAPPER, ej, p.ruta], e];
}

function defaultWorkers() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.floor(cores / 2));
}

/** W y, si el valor de la variable no sirve, el aviso. */
function resolveWorkers(env) {
  const raw = env.TYCON_SUITES_MAX_WORKERS;
  if (raw === undefined || raw === '') return { workers: defaultWorkers(), warning: null };
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return { workers: n, warning: null };
  const def = defaultWorkers();
  return { workers: def, warning: `TYCON_SUITES_MAX_WORKERS=«${raw}» no es un entero positivo: uso ${def} (la mitad de los núcleos)` };
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
 * mide (la variable › su propio clon si es unido › lo instalado); un repo sin esa función, lo de antes.
 * Tira si la función del repo no se deja usar: la raíz no se adivina.
 */
function resolveSkillsRoot(repo, given, env) {
  if (given) return { dir: given, source: '--skills' };
  const lib = path.resolve(repo, 'scripts', 'lib', 'skills-dir.js');
  if (fs.existsSync(lib)) {
    const d = require(lib).resolveSkillsDirs(env.TYCON_SKILLS_DIR || '');
    // un arnés anterior a la story 8.18 no dice de dónde salió: sólo conoce la variable y lo instalado
    return { dir: d.skills, source: d.source || (env.TYCON_SKILLS_DIR ? 'variable' : 'installed') };
  }
  if (env.TYCON_SKILLS_DIR) return { dir: env.TYCON_SKILLS_DIR, source: 'variable' };
  return { dir: path.join(os.homedir(), '.claude', 'agent-skills', 'skills'), source: 'installed' };
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const realOf = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/**
 * «La propia suite», como la nombra git: su ruta relativa a la raíz del repo. Devuelve las formas en que puede
 * figurar en lo tocado: la de las rutas TAL COMO LLEGARON y la de las rutas REALES de las dos puntas.
 *
 * Por qué las dos (pase adversarial del tramo 1 de la story 8.18, hallazgos 4, 5, 6, 7 y 16 — 2026-10-04): la raíz
 * de las skills sale ya resuelta a su ruta real (el `__dirname` de skills-dir.js) y el repo llega como lo escribió
 * quien llama (test-gate.sh lo pasa con `pwd`, que conserva los enlaces). Con el repo por un enlace —el canónico
 * `~/.claude/tycon-harness`, o `/tmp` en Mac— la ruta propia daba `../../…`, nunca coincidía con lo tocado y
 * la suite que la story editó se DIFERÍA con el gate en verde. Lo mismo al revés (el repo por su ruta real y la raíz
 * por el enlace instalado). Se resuelve el ARCHIVO entero y no sólo la raíz: la carpeta `~/.claude/skills` de la
 * máquina de un solo árbol es real y lo enlazado es cada skill. La forma «como llegó» se conserva: es la que ya
 * andaba, y de las dos alcanza con una —sumar una forma sólo puede hacer correr una suite, nunca diferirla—.
 */
// Una suite partida (story 8.22: `<suite>.p<k>.test.<js|sh>`, una línea que carga el archivo entero) se registra por sus
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

function main(argv, env = process.env) {
  const [repo, out] = argv;
  const iSk = argv.indexOf('--skills');
  const iCov = argv.indexOf('--coverage');
  if (!repo || !out || (iSk >= 0 && !argv[iSk + 1]) || (iCov >= 0 && !argv[iCov + 1])) {
    console.error('uso: run-suites-json.js <repo> <resumen.json> [--skills <dir>] [--touched <archivo.json>] [--coverage <dir>]');
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

  const { workers, warning } = resolveWorkers(env);
  if (warning) console.error(`[suites.json] ⚠️  ${warning}`);
  const allSuites = env.TYCON_GATE_ALL_SUITES === '1';
  const touched = readTouched(touchedFile);

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
    return { idx, ruta, name, exclusive, gate, fromSkills: s.raiz === 'agent-skills' };
  });

  const resumen = { corridas: 0, verdes: 0, fallas: [], ausentes: [], suites: [], workers, wall_ms: 0, deferred_suites: [], unmeasured_suites: [], skills_root: skillsRoot };
  const results = new Array(plan.length).fill(null);
  const parallel = [];
  const exclusives = [];
  let unknownSaid = false;
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
    if (p.gate && !allSuites) {
      // Editar la propia suite la hace correr aunque no toque sus carpetas (2026-09-30).
      const propia = ownPaths(repo, p.ruta);
      if (touched.known && !touches(touched.files, p.gate) && !propia.some((o) => touched.files.includes(o))) {
        const reason = `corre de noche y en el control del PR; esta story no toca ${p.gate.join(', ')}`;
        resumen.deferred_suites.push({ suite: p.ruta, reason });
        console.log(`DIFERIDA ${p.name} — ${reason}`);
        continue;
      }
      if (!touched.known && !unknownSaid) {
        console.log(`[suites.json] no pude saber qué archivos toca la story (${touched.reason || 'sin motivo'}): corre todo`);
        unknownSaid = true;
      }
    }
    (p.exclusive ? exclusives : parallel).push(p);
  }

  if (!parallel.length && !exclusives.length) {
    const motivo = resumen.ausentes.length ? 'todas las suites declaradas están ausentes' : 'no quedó ninguna suite para correr después de diferir';
    console.error(`[suites.json] ${motivo} — «0 corridas» no es un verde`);
    escribir(out, { ...resumen, no_medido: motivo });
    return Promise.resolve(resumen.ausentes.length ? 1 : 3);
  }

  console.log(`[suites.json] workers: ${workers} · en paralelo: ${parallel.length} · solas al final: ${exclusives.length} · diferidas: ${resumen.deferred_suites.length}`);

  const live = new Set();
  let interrupted = null;
  const onSignal = (sig) => {
    if (interrupted) return;
    interrupted = sig;
    for (const c of live) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* ya terminó */ } }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  if (covDir) {
    // la carpeta es de esta corrida: un lcov de una corrida anterior no puede sumarse a éste
    fs.rmSync(covDir, { recursive: true, force: true });
    fs.mkdirSync(covDir, { recursive: true });
    console.log(`[suites.json] con cobertura: cada suite bajo el medidor de Node, lcov en ${covDir}`);
  }

  const runOne = (p) => new Promise((resolve) => {
    const [ej, args, childEnv] = launch(p, covDir, env);
    const t0 = Date.now();
    // detached = grupo de proceso propio: al cortar se mata el grupo entero (la suite y sus hijos).
    const c = spawn(ej, args, { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    live.add(c);
    const chunks = [];
    let size = 0;
    const take = (b) => {
      if (size >= MAX_BUFFER) return;
      chunks.push(b); size += b.length;
    };
    c.stdout.on('data', take);
    c.stderr.on('data', take);
    let settled = false;
    const done = (status, spawnError) => {
      // 'error' y 'close' pueden llegar los dos (un binario que no arranca): se anota una sola vez.
      if (settled) return;
      settled = true;
      live.delete(c);
      const ms = Date.now() - t0;
      const exit = status === null ? 124 : status;   // null = murió por señal: se cuenta como rojo
      const salida = spawnError ? `${spawnError.message}\n` : Buffer.concat(chunks).toString('utf8');
      results[p.idx] = { ruta: p.ruta, exit, ms, salida };
      console.log(exit === 0 ? `ok       ${p.name} (${ms} ms)` : `ROJO(${exit}) ${p.ruta}`);
      resolve();
    };
    c.on('error', (e) => done(127, e));
    c.on('close', (code) => done(code, null));
  });

  const pool = async (items, n) => {
    let next = 0;
    const lane = async () => {
      while (!interrupted && next < items.length) await runOne(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  };

  const t0 = Date.now();
  return (async () => {
    await pool(parallel, workers);
    await pool(exclusives, 1);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    resumen.wall_ms = Date.now() - t0;

    for (const r of results) {
      if (!r) continue;
      resumen.corridas += 1;
      resumen.suites.push({ ruta: r.ruta, exit: r.exit, ms: r.ms });
      if (r.exit === 0) resumen.verdes += 1;
      // La cola de la salida viaja en el resumen para que el rojo se pueda leer sin re-correr.
      else resumen.fallas.push({ ruta: r.ruta, exit: r.exit, cola: r.salida.split('\n').slice(-25).join('\n') });
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

    if (interrupted) {
      console.error(`[suites.json] corrida interrumpida (${interrupted}) — maté las suites que estaban corriendo`);
      escribir(out, { ...resumen, no_medido: `corrida interrumpida (${interrupted})` });
      return interrupted === 'SIGINT' ? 130 : 143;
    }
    escribir(out, resumen);
    const rojas = resumen.fallas.length;
    const ausentes = resumen.ausentes.length;
    const unmeasured = resumen.unmeasured_suites.length;
    console.log(`[suites.json] ${resumen.corridas} corridas · ${resumen.verdes} verdes · ${rojas} rojas · ${ausentes} ausentes${unmeasured ? ` (${unmeasured} no medidas: su raíz no existe)` : ''} · ${resumen.deferred_suites.length} diferidas · ${(resumen.wall_ms / 60000).toFixed(1)} min con ${workers} a la vez`);
    return rojas === 0 && ausentes === 0 ? 0 : 1;
  })();
}

function escribir(out, obj) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + '\n');
}

if (require.main === module) {
  // Un rechazo al final (p. ej. no se pudo escribir el resumen) no puede quedar como «salió raro»:
  // se dice, y el exit es 3 — «no pude medir» —, nunca 0.
  // `Promise.resolve().then(...)`: una excepción SÍNCRONA de main (las salidas tempranas llaman a
  // escribir() antes de la parte async) también cae acá y sale 3 — pase adversarial 2026-09-29.
  Promise.resolve().then(() => main(process.argv.slice(2))).then((code) => process.exit(code), (e) => {
    console.error(`[suites.json] el runner falló antes de dejar el resumen: ${e && e.stack ? e.stack : e}`);
    process.exit(3);
  });
}
module.exports = { main, resolveWorkers, defaultWorkers };
