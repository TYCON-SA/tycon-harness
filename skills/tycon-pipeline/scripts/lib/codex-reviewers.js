'use strict';
/**
 * codex-reviewers.js — bajo Codex, los revisores los lanza el pipeline, no el modelo (`pipeline.js reviewers-run`).
 *
 * Con Claude Code el paso «Revisores» lanza cada revisor con `Agent(...)` y el gancho `on-advisor-run.js` lo anota. Con
 * Codex, pedirle al modelo que lance agentes depende de que el modelo use esa herramienta: uno que no la usa no lanza
 * ninguno y `check-count` no tiene qué contar. Acá cada revisor del set corre como un proceso `codex exec -p <revisor>`
 * aparte, con la entrada cerrada (con ella abierta `codex exec` espera para siempre), y al terminar deja la misma
 * constancia que el gancho (`recordLaunch`), más `launcher`, `exit` y `report`.
 *
 * - El set, el contexto y la vuelta salen de la última marca `step5-start` del registro de la sesión: lo que fijó
 *   `pipeline.js advisors` (o `smart-reloop`). Sin esa marca no se lanza nada.
 * - Ventana de a lo sumo 4 vivos; 2 con el pase adversarial en vuelo (lanzado y sin cerrar en el marcador).
 * - El modelo: el de la sesión de Codex del marcador (`start --codex-session`) o, sin ella, el del perfil.
 * - Tope por revisor: `TYCON_REVIEWER_TIMEOUT_MS` (15 minutos por defecto); pasado, se corta y queda `exit: "timeout"`.
 * - Relanzado: corta los procesos de una corrida anterior que siguen vivos (`reviewers-run.pids.json` de la carpeta de
 *   la ejecución) y saltea los revisores que ya tienen su reporte y salida 0 en esta vuelta.
 * - Sin `codex` o sin el perfil de algún revisor en `$CODEX_HOME`, sale antes de lanzar nada, nombrando cuál y por qué.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { stateDir: stateDirOf } = require('./state-dir.js');
const { sessionIdFileKey } = require('./session-id.js');

const WINDOW = 4;
const WINDOW_WITH_ADVERSARIAL = 2;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const PIDS_FILE = 'reviewers-run.pids.json';
const REPORTS_DIR = 'step-05-advisor-reports';

// La composición del pedido es la del examen de revisores: el preámbulo que obliga a usar las herramientas MCP del
// perfil y el sandbox que declara el perfil. Sin el examen al lado (un clon de skills aparte), pedido sin preámbulo y
// sandbox de sólo lectura, y se dice.
function benchHelpers() {
  try {
    return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'controls-bench', 'advisor-runner.js'));
  } catch (e) {
    return { missing: (e && e.message) || String(e) };
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** El ejecutable de Codex: `TYCON_CODEX_BIN` o el primero del PATH; null si no hay. */
function findCodex(env = process.env) {
  if (env.TYCON_CODEX_BIN) return fs.existsSync(env.TYCON_CODEX_BIN) ? env.TYCON_CODEX_BIN : null;
  // en Windows el .exe primero: el .cmd de npm no se puede lanzar sin shell
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* sigue */ }
    }
  }
  return null;
}

const codexHomeOf = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** El modelo que declara el perfil desplegado, o null. */
function profileModel(codexHome, advisor) {
  try {
    const m = fs.readFileSync(path.join(codexHome, `${advisor}.config.toml`), 'utf8').match(/^model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Los argumentos de la sesión de Codex del marcador: proveedor local, modelo y opciones `-c`. */
function sessionArgs(codexSession) {
  const s = codexSession || {};
  const out = [];
  if (s.oss) out.push('--oss');
  if (s.oss && s.provider) out.push('--local-provider', s.provider);
  for (const c of Array.isArray(s.config) ? s.config : []) out.push('-c', c);
  if (s.model) out.push('-m', s.model);
  return out;
}

function adversarialInFlight(marker) {
  return !!(marker && marker.adversarial && marker.adversarial.launchedAt && marker.deepReviewDone !== true);
}

/**
 * Corta un revisor con todo lo que lanzó. El `codex` que instala npm es un envoltorio de node que lanza el binario
 * nativo: matar sólo al envoltorio deja al binario corriendo y con la salida de errores abierta. Cada revisor corre en
 * su propio grupo de procesos (`detached`), y se corta el grupo; en Windows, el árbol con `taskkill /T`.
 */
function killTree(pid) {
  if (!Number.isInteger(pid)) return;
  if (process.platform === 'win32') {
    require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ya no está */ } }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** La línea de comando de un proceso vivo, o null si no se puede saber (sin `ps`, en Windows). */
function commandOf(pid) {
  if (process.platform === 'win32') return null;
  const r = require('child_process').spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

/**
 * Corta lo que una corrida anterior dejó vivo, sólo si el proceso sigue siendo ese revisor (`exec -p <revisor>` en su
 * línea de comando): un pid que el sistema ya reusó para otra cosa no se toca. Devuelve los cortados y los que no se
 * pudieron mirar.
 */
function killLeftovers(pidsFile) {
  const cut = [];
  const unchecked = [];
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(pidsFile, 'utf8')); } catch { return { cut, unchecked }; }
  for (const [advisor, info] of Object.entries((prev && prev.procs) || {})) {
    const pid = info && info.pid;
    if (!Number.isInteger(pid) || !alive(pid)) continue;
    const cmd = commandOf(pid);
    if (cmd === null) { unchecked.push(advisor); continue; }
    if (!cmd.includes('exec') || !cmd.includes(` ${advisor} `)) continue;
    killTree(pid);
    cut.push(advisor);
  }
  return { cut, unchecked };
}

function validReport(report) {
  try { return fs.statSync(report).size > 0; } catch { return false; }
}

function promptFor({ advisor, contextFile, storyPath, repo, preamble }) {
  return (preamble || '') +
    `context_file: ${contextFile}\n` +
    `story_path: ${storyPath}\nrepo_path: ${repo}\nphase: post-implementation\n\n` +
    `Revisá según tu procedimiento (${advisor}) lo que dice el context_file: la story y los archivos tocados. ` +
    'Devolvé el reporte con tu formato, cada hallazgo con su regla entre corchetes, y cerrá con el renglón «Veredicto:».';
}

/**
 * Corre los revisores de la vuelta. `o`: { repo, story (ruta), env?, stateDir?, sessionId?, log? }.
 * Devuelve { code, launched, skipped, results, error? }: code 0 todos bien, 1 alguno falló o se cortó, 2 no se lanzó
 * nada (falta algo para lanzar).
 */
async function run(o) {
  const env = o.env || process.env;
  const say = o.log || ((l) => process.stderr.write(l + '\n'));
  const stateDir = o.stateDir || stateDirOf(os.homedir());
  const sessionId = o.sessionId || sessionIdFileKey();
  const logPath = path.join(stateDir, 'advisor-runs', `${sessionId}.jsonl`);
  const fail = (msg) => { say(`reviewers-run: ${msg}`); return { code: 2, launched: [], skipped: [], results: [], error: msg }; };

  const lines = readLines(logPath);
  const startIdx = require('./advisor-round.js').inicioDeLaRonda(lines);
  if (startIdx === -1) return fail('no hay set de esta vuelta: corré primero `pipeline.js advisors` (o `smart-reloop`) y después reviewers-run.');
  const start = lines[startIdx];
  const expected = Array.isArray(start.expected) ? start.expected.filter((a) => typeof a === 'string') : [];
  if (!expected.length) return { code: 0, launched: [], skipped: [], results: [] };

  const marker = require('./repo-attrib.js').readMarkerFile(sessionId) || {};
  const repo = path.resolve(o.repo || marker.repoPath || process.cwd());
  const storyPath = o.story ? path.resolve(o.story) : marker.storyPath;
  const storyId = marker.storyId ? String(marker.storyId) : null;
  const { resolveRunDir } = require('../pipeline.js');
  const runDir = storyId ? resolveRunDir(repo, storyId, true, storyPath || undefined) : null;
  if (!runDir) return fail('no encuentro la carpeta de la ejecución (sin marcador con la story de esta sesión).');
  const reportsDir = path.join(runDir, REPORTS_DIR);
  fs.mkdirSync(reportsDir, { recursive: true });

  // lo ya hecho en esta vuelta: salida 0 con su reporte
  const done = new Set();
  for (const e of lines.slice(startIdx + 1)) {
    if (e && e.launcher === 'pipeline' && e.exit === 0 && validReport(e.report)) done.add(e.advisor);
  }
  const pending = expected.filter((a) => !done.has(a));

  const codex = findCodex(env);
  if (pending.length && !codex) return fail(`no encuentro \`codex\` en el PATH: no lancé ninguno de los ${pending.length} revisores (${pending.join(', ')}).`);
  const codexHome = codexHomeOf(env);
  const sinPerfil = pending.filter((a) => !fs.existsSync(path.join(codexHome, `${a}.config.toml`)));
  if (sinPerfil.length) {
    return fail(`falta el perfil de Codex de ${sinPerfil.join(', ')} en ${codexHome} (${sinPerfil.map((a) => `${a}.config.toml`).join(', ')}); ` +
      'se despliega con `node build/generate.js --deploy`. No lancé ninguno.');
  }

  const pidsFile = path.join(runDir, PIDS_FILE);
  const { cut, unchecked } = killLeftovers(pidsFile);
  if (cut.length) say(`reviewers-run: corté lo que quedó vivo de la corrida anterior: ${cut.join(', ')}.`);
  if (unchecked.length) say(`reviewers-run: no pude mirar si siguen vivos los procesos anteriores de ${unchecked.join(', ')} (sin \`ps\`): no los corté; si quedaron, cortalos a mano.`);

  const helpers = benchHelpers();
  if (helpers.missing) say(`reviewers-run: sin el examen de revisores al lado (${helpers.missing}): pedido sin preámbulo de MCP y sandbox de sólo lectura.`);
  const window = adversarialInFlight(marker) ? WINDOW_WITH_ADVERSARIAL : WINDOW;
  const timeoutMs = Number.parseInt(env.TYCON_REVIEWER_TIMEOUT_MS || '', 10) > 0 ? Number.parseInt(env.TYCON_REVIEWER_TIMEOUT_MS, 10) : DEFAULT_TIMEOUT_MS;
  const session = marker.codexSession || null;
  const modelOf = (a) => (session && session.model) || profileModel(codexHome, a);
  const overrides = start.context_file_overrides || {};

  say(`reviewers-run: lanzo ${pending.length} revisor(es) como procesos de Codex, de a ${window} a la vez` +
    `${window === WINDOW_WITH_ADVERSARIAL ? ' (el pase adversarial está en vuelo)' : ''}: ` +
    pending.map((a) => `${a} (${modelOf(a) || 'el modelo del perfil'})`).join(', ') +
    (done.size ? `. Ya hechos en esta vuelta: ${[...done].join(', ')}` : '') + '.');

  const { recordLaunch } = require('../on-advisor-run.js');
  const procs = {};
  const writePids = () => {
    try { fs.writeFileSync(pidsFile, JSON.stringify({ iter: start.iter ?? null, procs }, null, 2)); } catch { /* el relanzado sólo pierde el corte */ }
  };
  const children = new Set();
  // los revisores corren en su propio grupo: un Ctrl-C de la terminal no les llega solo, se cortan acá
  const onSignal = (sig) => { for (const c of children) killTree(c.pid); process.exit(sig === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const results = [];
  const launchOne = (advisor) => new Promise((resolve) => {
    const report = path.join(reportsDir, `${advisor}.md`);
    try { fs.rmSync(report, { force: true }); } catch { /* no estaba */ }
    const contextFile = overrides[advisor] || start.context_file || '(sin context_file: leé la story y el diff)';
    const preamble = helpers.codexInvokePreamble ? (() => { try { return helpers.codexInvokePreamble(advisor); } catch { return ''; } })() : '';
    const sandbox = helpers.codexSandbox ? helpers.codexSandbox(advisor) : 'read-only';
    const args = ['exec', '-p', advisor, '--sandbox', sandbox, '--skip-git-repo-check', ...sessionArgs(session), '-o', report,
      promptFor({ advisor, contextFile, storyPath, repo, preamble })];
    const errLog = path.join(reportsDir, `${advisor}.stderr.log`);
    let tail = '';
    // Un `.cmd` sin shell no arranca en Windows (Node tira EINVAL al lanzar, no como evento): se cierra como falla con su
    // motivo, nunca rompe la corrida entera.
    let ch = null;
    let spawnError = null;
    try {
      ch = spawn(codex, args, { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    } catch (e) { spawnError = e; }
    if (ch) {
      children.add(ch);
      procs[advisor] = { pid: ch.pid, startedAt: new Date().toISOString() };
      writePids();
      ch.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    }
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; if (ch) killTree(ch.pid); }, timeoutMs);
    // `error` (no arrancó) y `close` pueden llegar los dos: se cierra una sola vez, o la línea se anotaría dos veces
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      children.delete(ch);
      delete procs[advisor];
      writePids();
      try { fs.writeFileSync(errLog, tail); } catch { /* informativo */ }
      const exit = timedOut ? 'timeout' : code;
      const corrio = exit === 0 && validReport(report);
      // Sólo un revisor que corrió pasa por la constancia común (cuenta para la ronda, la foto y el registro de autoría).
      // El que falló queda en su propia línea, sin `advisor`: `check-count` la nombra en el rojo y nada lo da por corrido.
      let rec = { ok: true };
      if (corrio) rec = recordLaunch({ sessionId, cwd: repo, advisor, model: modelOf(advisor), extra: { launcher: 'pipeline', exit, report } });
      else {
        try {
          fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: 'launch-failed', failed_advisor: advisor,
            model: modelOf(advisor), repo, story: storyId, launcher: 'pipeline', exit, report }) + '\n');
        } catch (e) { rec = { ok: false, error: e.message }; }
      }
      const r = { advisor, exit, report, model: modelOf(advisor), ok: corrio && rec.ok !== false };
      if (rec.ok === false) say(`reviewers-run: ${advisor} terminó, pero su línea no quedó en el registro (${rec.error}): check-count no lo va a contar.`);
      else if (!r.ok) say(`reviewers-run: ${advisor} ${exit === 'timeout' ? `timeout (pasó ${Math.round(timeoutMs / 1000)} s)` : exit === 0 ? 'terminó sin reporte' : `salió ${exit}`}; lo que dijo, en ${errLog}.`);
      results.push(r);
      resolve(r);
    };
    if (spawnError) {
      tail += `\nno arrancó: ${spawnError.message || spawnError}` +
        (/\.(cmd|bat)$/i.test(codex) ? ' (en Windows un .cmd no se lanza sin shell: apuntá TYCON_CODEX_BIN a codex.exe)' : '') + '\n';
      finish(-1);
    } else {
      ch.on('error', (e) => { tail += `\nno arrancó: ${(e && e.message) || e}\n`; finish(-1); });
      ch.on('close', (code) => finish(code));
    }
  });

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(window, queue.length) }, async () => {
    while (queue.length) await launchOne(queue.shift());
  });
  await Promise.all(workers);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  try { fs.rmSync(pidsFile, { force: true }); } catch { /* nada que limpiar */ }

  const bad = results.filter((r) => !r.ok);
  say(`reviewers-run: ${results.length - bad.length} de ${results.length} revisores con su reporte` +
    (bad.length ? `; sin reporte válido: ${bad.map((r) => `${r.advisor} (${r.exit === 'timeout' ? 'timeout' : `exit ${r.exit}`})`).join(', ')}` : '') + '.');
  return { code: bad.length ? 1 : 0, launched: pending, skipped: [...done], results, reports_dir: reportsDir };
}

module.exports = { run, findCodex, sessionArgs, adversarialInFlight, killLeftovers, WINDOW, WINDOW_WITH_ADVERSARIAL, DEFAULT_TIMEOUT_MS };
