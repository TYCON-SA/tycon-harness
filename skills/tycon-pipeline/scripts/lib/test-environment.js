'use strict';

/**
 * test-environment.js — el entorno de pruebas que la organización declara para unos repos, en
 * `team-repos.json → stack.test_environments`: cómo se prepara (una base local en un contenedor, un servidor levantado,
 * las variables que leen las pruebas, la versión de Node delante en el PATH) y cómo se desarma.
 *
 * El portón (test-gate.sh) lo prepara antes de la suite y lo desarma al terminar, también después de los repos
 * hermanos: las corridas de los hermanos heredan lo preparado, y un hermano que está en el mismo entorno no lo prepara
 * otra vez. Si la preparación falla, tarda más que su tope o no deja las variables de `requires`, el portón no corre
 * la suite y sale 8, «entorno sin preparar»: no es verde ni rojo. Sin esto, una suite sin su base saltea las pruebas
 * contra la base y deja en rojo las de navegador, y el informe lo cuenta como código roto.
 *
 * Como `stack.test_runners`, los comandos salen SÓLO de la configuración de la organización (la lee stack-config.js
 * desde el árbol del arnés): nunca de un archivo del repo que se prueba. El comando sí puede llamar a un guion del
 * repo; lo que decide que corra es la organización.
 *
 * Una entrada:
 *   { "name": "acme-local", "label": "Base local y servidor de Acme",
 *     "repos": [ { "platform": "github", "org": "acme", "repo": "acme-backend" }, … ],
 *     "prepare": "bash scripts/test-env/prepare.sh", "teardown": "bash scripts/test-env/stop.sh",
 *     "requires": ["ACME_TEST_SQL"], "timeout_s": 600 }
 *
 * Los comandos corren con bash, desde la carpeta que se prueba. Lo que `prepare` deja exportado (también con
 * `source guion.sh`) llega a la suite y a `teardown`. En los dos se puede usar `{repo}` (la carpeta que se prueba) y
 * `{sibling:<nombre>}` (la carpeta de otro repo), las dos ya entre comillas. Un repo hermano de la story se ubica igual
 * que lo ubica el portón para correr su suite (lib/companion-repos.js: su copia en la rama de la story): así el servidor
 * que se levanta es el del código que se prueba. Si no es un hermano declarado, el repo al lado: con la carpeta que se
 * prueba llamada `<repo>--<sufijo>`, primero `<nombre>--<sufijo>`, si no `<nombre>`.
 * Al desarmar, lo que la preparación dejó andando en su grupo de procesos (un servidor) se corta, aunque `teardown` no
 * lo haya parado: el portón no deja procesos sueltos. Lo que tiene que sobrevivir a la corrida se arranca fuera de ese
 * grupo (un contenedor, por ejemplo).
 *
 * CLI (lo usa test-gate.sh):
 *   node test-environment.js name <carpeta> [--story <arg>]
 *     → el nombre del entorno que le toca a la carpeta y todavía no está preparado en esta corrida, o nada.
 *   node test-environment.js run <carpeta> [--story <arg>] -- <comando del portón…>
 *     → prepara, corre el portón, desarma y sale con la salida del portón (8 si el entorno no quedó listo).
 * `TYCON_TEST_ENV=off` apaga todo (una máquina o una CI que prepara el entorno por su cuenta).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const NOT_READY_EXIT = 8;
const DEFAULT_TIMEOUT_S = 600;
// lo que bash pone solo en cada proceso: no es algo que haya preparado el entorno
const NO_IMPORT = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'IFS']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIBLING_NAME = /^[A-Za-z0-9._-]+$/;
// las corridas que ya prepararon su entorno, separadas por «:»; la heredan las partes y los repos hermanos
const READY_VAR = 'TYCON_TEST_ENV_READY';

const quote = (s) => `'${String(s).split("'").join("'\\''")}'`;
const readyList = (env) => String(env[READY_VAR] || '').split(':').filter(Boolean);

/** La carpeta raíz del repo de `dir` (la de git), o `dir` si git no contesta. */
function repoRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : path.resolve(dir);
}

/**
 * La carpeta del repo `name` al lado de `dir`: con `dir` llamado `<repo>--<sufijo>` (una copia de trabajo), primero
 * `<name>--<sufijo>`; si no, `<name>`. `{ dir }` o `{ problem }`.
 */
function siblingDir(dir, name, { story } = {}) {
  if (!SIBLING_NAME.test(name)) return { problem: `{sibling:${name}}: el nombre de un repo, sin barras ni espacios` };
  const hermano = story ? companionNamed(dir, story, name) : null;
  if (hermano) return { dir: hermano };
  const root = repoRoot(dir);
  const parent = path.dirname(root);
  const base = path.basename(root);
  const cut = base.indexOf('--');
  const candidates = cut > 0 ? [`${name}${base.slice(cut)}`, name] : [name];
  for (const c of candidates) {
    const full = path.join(parent, c);
    try { if (fs.statSync(full).isDirectory()) return { dir: full }; } catch (_) { /* el siguiente */ }
  }
  return { problem: `{sibling:${name}}: no encontré ${candidates.map((c) => path.join(parent, c)).join(' ni ')}` };
}

/** El hermano declarado de la story que se llama `name` (su repo, también desde un worktree), como lo corre el portón. */
function companionNamed(dir, story, name) {
  let cr;
  try { cr = require('./companion-repos.js'); } catch (_) { return null; }
  let roots = [];
  try { roots = cr.companionRoots(dir, story, {}); } catch (_) { return null; }
  return roots.find((r) => path.basename(r) === name || cr.nombreDelRepo(r) === name) || null;
}

/** `cmd` con `{repo}` y `{sibling:<nombre>}` reemplazados (entre comillas). `{ text }` o `{ problem }`. */
function expand(cmd, dir, { story } = {}) {
  let problem = null;
  const text = String(cmd).replace(/\{repo\}|\{sibling:([^}]*)\}/g, (all, name) => {
    if (all === '{repo}') return quote(dir);
    const s = siblingDir(dir, name, { story });
    if (s.problem) { problem = problem || s.problem; return all; }
    return quote(s.dir);
  });
  return problem ? { problem } : { text };
}

/**
 * El entorno que le toca a `dir`: `{ environment, problems }`, con `environment` null si la organización no declara
 * ninguno para este repo. `stack` es la clave de la organización ya leída; `repoOf` reconoce el repo de una carpeta
 * (el de test-runners.js, por su remoto `origin`).
 */
function resolve(dir, { stack, repoOf, identityKey, story } = {}) {
  const list = stack && Array.isArray(stack.test_environments) ? stack.test_environments : [];
  if (!list.length) return { environment: null, problems: [] };
  const problems = [];
  const { id, problema } = repoOf(dir);
  if (problema) problems.push(`stack.test_environments: ${problema}; no preparo ningún entorno`);
  if (!id) return { environment: null, problems };
  const key = identityKey(id);
  const entry = list.find((e) => Array.isArray(e.repos) && e.repos.some((r) => identityKey(r) === key));
  if (!entry) return { environment: null, problems };
  const environment = {
    name: entry.name,
    label: entry.label || entry.name,
    requires: Array.isArray(entry.requires) ? entry.requires : [],
    timeout_s: Number.isInteger(entry.timeout_s) ? entry.timeout_s : DEFAULT_TIMEOUT_S,
  };
  for (const k of ['prepare', 'teardown']) {
    if (entry[k] === undefined) continue;
    const x = expand(entry[k], dir, { story });
    if (x.problem) environment.unresolved = environment.unresolved || x.problem;
    else environment[k] = x.text;
  }
  return { environment, problems };
}

/** El entorno de `dir` con la configuración de esta máquina (el árbol del arnés). */
function resolveHere(dir, { story: storyArg } = {}) {
  const leido = require('./stack-config.js').readStack();
  const problems = leido.problems.filter((p) => p.startsWith('stack.test_environments'));
  const { repoDe } = require('./test-runners.js');
  const { identityKey } = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'team-repos.js'));
  const story = storyArg && /\.md$/.test(storyArg) && fs.existsSync(storyArg) ? path.resolve(storyArg) : null;
  const r = resolve(dir, { stack: leido.stack, repoOf: repoDe, identityKey, story });
  return { environment: r.environment, problems: [...problems, ...r.problems] };
}

// El volcado del entorno al terminar bien. Node y el archivo llegan como argumentos de bash ($1 y $2) y se guardan en
// variables sin exportar: ninguna ruta va dentro del texto del comando, y el volcado no las ve
const DUMP_TRAP = '__tycon_dump() { trap - EXIT; if [ "$1" -eq 0 ]; then "$__tycon_node" -e \'process.stdout.write(JSON.stringify(process.env))\' > "$__tycon_out" || exit 97; fi; exit "$1"; }';

/**
 * El texto de bash del paso y sus argumentos (`$0` y lo que sigue). Sin `dump`, el comando tal cual. Con `dump`, el
 * comando entre la trampa del volcado; `shift 2` lo deja sin argumentos, como sin volcado.
 */
function stepScript(cmd, dump) {
  if (!dump) return { script: cmd, args: [] };
  return {
    script: `__tycon_node=$1; __tycon_out=$2; shift 2\n${DUMP_TRAP}\ntrap '__tycon_dump $?' EXIT\n${cmd}\n__tycon_dump $?\n`,
    args: ['bash', process.execPath, dump],
  };
}

/**
 * Corre `cmd` con bash desde `cwd`, en su propio grupo de procesos, con tope de `timeoutS` segundos (al pasarlo corta el
 * grupo entero). La salida va a un archivo, no a un tubo: un proceso que el comando deja andando (un servidor) no
 * traba la espera ni muere al cerrarse el tubo. Con `dump`, al terminar bien escribe ahí las variables del proceso en
 * JSON: después del comando, y también desde la salida de bash por si el comando termina con `exit 0`. `onSpawn(pid)`
 * recibe el grupo apenas arranca (para cortarlo si llega una señal). Devuelve `{ code, timedOut, output, pid }`.
 */
function step(cmd, { cwd, env, timeoutS, dump, logFile, onSpawn }) {
  return new Promise((done) => {
    const { script, args } = stepScript(cmd, dump);
    const fd = fs.openSync(logFile, 'w', 0o600);
    let child;
    try {
      child = spawn('bash', ['-c', script, ...args], { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally { fs.closeSync(fd); }
    if (onSpawn && child.pid) onSpawn(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_e) { /* ya salió */ } }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* ya salió */ } }, 5000).unref();
    }, timeoutS * 1000);
    const finish = (code) => {
      clearTimeout(timer);
      let output = '';
      try { output = fs.readFileSync(logFile, 'utf8'); } catch (_) { output = ''; }
      done({ code, timedOut, output, pid: child.pid });
    };
    child.on('error', (e) => finish({ error: e.message }));
    child.on('exit', (code, signal) => finish(code === null ? `señal ${signal}` : code));
  });
}

const importable = (k) => ENV_NAME.test(k) && !NO_IMPORT.has(k) && !k.startsWith('BASH') && k !== READY_VAR;

/**
 * El entorno de la suite: `base` con lo que la preparación dejó (las variables nuevas o cambiadas del volcado) y sin lo
 * que sacó con `unset`. `{ env, changed }`, con `changed` la cantidad de variables que puso o sacó.
 */
function envAfterPrepare(dumpFile, base) {
  const after = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
  const env = { ...base };
  let changed = 0;
  for (const [k, v] of Object.entries(after)) {
    if (importable(k) && base[k] !== v) { env[k] = v; changed++; }
  }
  for (const k of Object.keys(base)) {
    if (importable(k) && !(k in after)) { delete env[k]; changed++; }
  }
  return { env, changed };
}

const echoOutput = (output) => {
  const lines = String(output).split('\n').filter((l) => l.trim());
  for (const l of lines) process.stderr.write(`[entorno] ${l}\n`);
  return lines;
};

/** El id de la story, como lo pone el portón: el `id:` de su frontmatter, o lo que se pasó. */
function storyIdOf(storyArg) {
  if (!storyArg) return 'unknown';
  try {
    const fm = fs.readFileSync(storyArg, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const id = fm && fm[1].match(/^id:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
    if (id) return id[1];
  } catch (_) { /* no es una ruta legible: va como vino */ }
  return storyArg;
}

/** El informe de una corrida que no corrió la suite porque el entorno no quedó listo. */
function writeNotReady(dir, { storyArg, environment, reason }) {
  const out = path.join(dir, '.advisors', 'tests-result.json');
  const art = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    story_id: storyIdOf(storyArg),
    runner: null,
    repo: dir,
    suite_exit: NOT_READY_EXIT,
    suite_green: false,
    halted: true,
    env_not_ready: true,
    env_not_ready_reason: reason,
    test_environment: { name: environment.name, label: environment.label, prepared: false },
    totals: {},
    coverage: { per_new_file: {}, new_files_pct: null, threshold: null, meets_threshold: null },
    provenance: 'test-environment.js: el entorno de pruebas no quedó listo y la suite no corrió (salida 8, ni verde ni rojo)',
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(art, null, 2)}\n`);
}

/**
 * El check del marcador en rojo con la salida 8: un verde de una corrida anterior no queda en pie. Con `--suite` (la
 * repetición de una suite) es el check `tests-suite`, como en el portón: el de la corrida completa no se toca.
 */
function markNotReady(dir, reason, check) {
  const marker = path.join(__dirname, '..', 'marker.js');
  spawnSync(process.execPath, [marker, 'run-check', check, '--', process.execPath, '-e',
    'console.error("test-gate: " + process.argv[1]); process.exit(Number(process.argv[2]))', reason, String(NOT_READY_EXIT)],
  { cwd: dir, env: { ...process.env, TYCON_TEST_GATE: '1', TYCON_TEST_GATE_MARK: '1' }, stdio: ['ignore', 2, 2], windowsHide: true });
}

/** Le agrega al informe que dejó el portón (si es de esta corrida) qué entorno se preparó. */
function noteInArtifact(dir, environment, since) {
  const out = path.join(dir, '.advisors', 'tests-result.json');
  try {
    if (fs.statSync(out).mtimeMs < since) return;
    const art = JSON.parse(fs.readFileSync(out, 'utf8'));
    art.test_environment = { name: environment.name, label: environment.label, prepared: true };
    fs.writeFileSync(out, `${JSON.stringify(art, null, 2)}\n`);
  } catch (_) { /* sin informe de esta corrida: nada que anotar */ }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalExit = (sig) => 128 + ((os.constants.signals && os.constants.signals[sig]) || 1);

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };

/** Corta lo que quedó andando en el grupo de procesos `pgid` (TERM, y KILL a los 5 s). true si había algo. */
async function stopGroup(pgid) {
  if (!pgid || process.platform === 'win32' || !groupAlive(pgid)) return false;
  try { process.kill(-pgid, 'SIGTERM'); } catch (_) { return false; }
  for (let i = 0; i < 50 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
  if (groupAlive(pgid)) { try { process.kill(-pgid, 'SIGKILL'); } catch (_) { /* ya salió */ } }
  return true;
}

/**
 * El candado del entorno en la máquina: uno por nombre, porque dos corridas del mismo entorno comparten lo que levanta
 * (un puerto fijo, una base). Una segunda corrida que preparara y desarmara le apagaría el servidor a la primera. Guarda
 * el proceso dueño y el grupo de la preparación: si el dueño murió sin desarmar (un SIGKILL), la corrida siguiente corta
 * lo que dejó andando antes de preparar. `{ ok, release, setGroup }` o `{ ok: false, holder }`.
 */
async function takeLock(name, { dir = os.tmpdir() } = {}) {
  const file = path.join(dir, `tycon-test-env-${name}.lock`);
  for (let intento = 0; intento < 2; intento++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), group: null }));
      fs.closeSync(fd);
      const write = (group) => { try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now(), group })); } catch (_) { /* sin candado no hay nada que anotar */ } };
      const release = () => {
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch (_) { /* ya no está */ }
      };
      return { ok: true, release, setGroup: write, file };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: true, release: () => {}, setGroup: () => {}, file: null };
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { holder = null; }
      if (holder && holder.pid && pidAlive(holder.pid)) return { ok: false, holder };
      // el dueño murió sin desarmar: lo que dejó andando su preparación se corta antes de volver a preparar
      if (holder && holder.group && await stopGroup(holder.group)) {
        process.stderr.write(`[test-gate] corté lo que dejó andando una corrida anterior del entorno «${name}» que terminó sin desarmarlo\n`);
      }
      try { fs.unlinkSync(file); } catch (_) { /* otra corrida lo sacó */ }
    }
  }
  return { ok: false, holder: null };
}

/**
 * Prepara el entorno, corre `cmd` (el portón) con lo preparado, lo desarma y devuelve la salida. Una señal (Ctrl-C,
 * SIGTERM) en cualquier momento corta lo que esté corriendo y desarma igual; una segunda señal durante el desarme no lo
 * interrumpe.
 */
async function run(dir, { environment, storyArg, cmd, suiteOnly = false, lockDir }) {
  const lock = await takeLock(environment.name, { dir: lockDir });
  if (!lock.ok) {
    const quien = lock.holder && lock.holder.pid ? ` (proceso ${lock.holder.pid})` : '';
    process.stderr.write(`🟡 [test-gate] el entorno «${environment.label}» lo está usando otra corrida${quien}: no lo preparo para no desarmárselo, y no corrí nada. Esperá su resultado y volvé a correr el portón.\n`);
    return 75;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-env-'));
  try { fs.chmodSync(tmp, 0o700); } catch (_) { /* Windows */ }
  const timeoutS = environment.timeout_s;
  const base = { ...process.env };
  let childEnv = base;
  let prepared = false;
  let prepGroup = null;
  let phase = 'prepare';
  let interrupted = null;
  let gateChild = null;

  const onSignal = (sig) => {
    if (phase === 'teardown') return; // el desarme termina igual
    if (!interrupted) interrupted = sig;
    if (phase === 'prepare' && prepGroup) { try { process.kill(-prepGroup, 'SIGTERM'); } catch (_) { /* ya salió */ } }
    if (phase === 'gate' && gateChild) { try { gateChild.kill(sig); } catch (_) { /* ya salió */ } }
  };
  const handlers = Object.fromEntries(SIGNALS.map((s) => [s, () => onSignal(s)]));
  for (const s of SIGNALS) process.on(s, handlers[s]);

  const runTeardown = async (env) => {
    process.stderr.write(`[test-gate] desarmando el entorno «${environment.label}»\n`);
    const r = await step(environment.teardown, { cwd: dir, env, timeoutS, logFile: path.join(tmp, 'teardown.log') });
    echoOutput(r.output);
    if (r.timedOut || r.code !== 0) {
      process.stderr.write(`[test-gate] ⚠️  el entorno «${environment.label}» no se desarmó bien (${r.timedOut ? `pasó el tope de ${timeoutS} s` : `salida ${JSON.stringify(r.code)}`}): mirá si quedó algo andando\n`);
    }
  };
  const teardown = async (env) => {
    phase = 'teardown';
    if (!prepared) return;
    if (environment.teardown) await runTeardown(env);
    if (await stopGroup(prepGroup)) {
      process.stderr.write(`[test-gate] corté lo que la preparación del entorno «${environment.label}» dejó andando\n`);
    }
  };
  const interruptedExit = async () => {
    process.stderr.write(`[test-gate] corrida cortada (${interrupted}): desarmo el entorno «${environment.label}»\n`);
    await teardown(childEnv);
    return signalExit(interrupted);
  };
  const notReady = async (reason) => {
    process.stderr.write(`🟡 [test-gate] entorno sin preparar («${environment.label}»): ${reason}. No corrí la suite: no es verde ni rojo. Preparalo (o arreglá su receta en stack.test_environments de team-repos.json) y volvé a correr el portón.\n`);
    // la repetición de una suite no reemplaza la constancia de la corrida completa
    if (!suiteOnly) writeNotReady(dir, { storyArg, environment, reason });
    markNotReady(dir, `entorno sin preparar («${environment.label}»): ${reason}`, suiteOnly ? 'tests-suite' : 'tests');
    await teardown(childEnv);
    return NOT_READY_EXIT;
  };

  try {
    if (environment.unresolved) return await notReady(environment.unresolved);
    process.stderr.write(`[test-gate] preparando el entorno «${environment.label}» (hasta ${timeoutS} s)\n`);
    const dump = path.join(tmp, 'env.json');
    prepared = true;
    const r = await step(environment.prepare, {
      cwd: dir, env: base, timeoutS, dump, logFile: path.join(tmp, 'prepare.log'),
      onSpawn: (pid) => { prepGroup = pid; lock.setGroup(pid); },
    });
    // sin nada andando en su grupo, no queda qué cortar: el número podría reusarlo otro proceso
    if (!groupAlive(prepGroup)) { prepGroup = null; lock.setGroup(null); }
    const lines = echoOutput(r.output);
    if (interrupted) return await interruptedExit();
    const last = lines.slice(-3).join(' · ');
    if (r.timedOut) return await notReady(`la preparación pasó su tope de ${timeoutS} s${last ? ` (${last})` : ''}`);
    if (r.code !== 0) return await notReady(`la preparación salió ${typeof r.code === 'number' ? r.code : JSON.stringify(r.code)}${last ? ` (${last})` : ''}`);
    let after;
    try { after = envAfterPrepare(dump, base); } catch (e) {
      return await notReady(e && e.code === 'ENOENT'
        ? 'la preparación terminó sin dejar sus variables (¿termina con exec, o su propia trampa de salida la cortó antes?)'
        : `no pude leer lo que dejó la preparación (${e.message})`);
    }
    childEnv = after.env;
    const faltan = environment.requires.filter((v) => !childEnv[v]);
    if (faltan.length) return await notReady(`la preparación terminó bien pero no dejó ${faltan.join(', ')}`);
    childEnv[READY_VAR] = [...readyList(base), environment.name].join(':');
    process.stderr.write(`[test-gate] entorno «${environment.label}» listo${after.changed ? ` (cambia ${after.changed} variable(s))` : ''}\n`);

    phase = 'gate';
    const since = Date.now();
    const code = await new Promise((done) => {
      gateChild = spawn(cmd[0], cmd.slice(1), { cwd: process.cwd(), env: childEnv, stdio: 'inherit', windowsHide: true });
      gateChild.on('error', (e) => { process.stderr.write(`[test-gate] 🔴 no pude lanzar el portón (${e.message})\n`); done(1); });
      gateChild.on('exit', (c, signal) => done(c === null ? signalExit(signal) : c));
    });
    noteInArtifact(dir, environment, since);
    await teardown(childEnv);
    return code;
  } finally {
    phase = 'teardown';
    for (const s of SIGNALS) process.removeListener(s, handlers[s]);
    lock.release();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* un proceso que dejó andando la preparación todavía lo usa */ }
  }
}

module.exports = { NOT_READY_EXIT, READY_VAR, resolve, expand, siblingDir, envAfterPrepare, stepScript, step, run, takeLock, storyIdOf };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const [cmd, dirArg] = argv;
  if (!['name', 'run'].includes(cmd) || !dirArg) {
    process.stderr.write('uso: test-environment.js name <carpeta> [--story <arg>] | run <carpeta> [--story <arg>] -- <comando…>\n');
    process.exit(2);
  }
  const dir = path.resolve(dirArg);
  const off = String(process.env.TYCON_TEST_ENV || '').toLowerCase() === 'off';
  const si = argv.indexOf('--story');
  const sep = argv.indexOf('--');
  const storyArg = si >= 0 && (sep < 0 || si < sep) ? (argv[si + 1] || '') : '';
  // una carpeta que `run` ya lanzó sin entorno (no lo encontró): `name` no la vuelve a mandar a `run`
  const skip = process.env.TYCON_TEST_ENV_SKIP_DIR && path.resolve(process.env.TYCON_TEST_ENV_SKIP_DIR) === dir;
  let r = { environment: null, problems: [] };
  if (!off && !skip) {
    try { r = resolveHere(dir, { story: storyArg }); } catch (e) { r = { environment: null, problems: [`stack.test_environments: no pude leerla (${e.message}); no preparo ningún entorno`] }; }
  }
  const pending = r.environment && !readyList(process.env).includes(r.environment.name) ? r.environment : null;
  if (cmd === 'name') {
    for (const p of r.problems) process.stderr.write(`[test-gate] ⚠️  ${p}\n`);
    if (pending) process.stdout.write(`${pending.name}\n`);
    process.exit(0);
  }
  const gate = sep >= 0 ? argv.slice(sep + 1) : [];
  if (!gate.length) { process.stderr.write('test-environment.js run: falta el comando después de --\n'); process.exit(2); }
  if (!pending) {
    const c = spawnSync(gate[0], gate.slice(1), { stdio: 'inherit', windowsHide: true, env: { ...process.env, TYCON_TEST_ENV_SKIP_DIR: dir } });
    process.exit(c.status === null ? signalExit(c.signal) : c.status);
  }
  run(dir, { environment: pending, storyArg, cmd: gate, suiteOnly: gate.includes('--suite') }).then((code) => process.exit(code), (e) => {
    process.stderr.write(`[test-gate] 🔴 el entorno de pruebas falló sin poder desarmarse (${e && e.message}): mirá si quedó algo andando\n`);
    process.exit(1);
  });
}
