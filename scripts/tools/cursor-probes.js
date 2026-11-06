#!/usr/bin/env node
'use strict';
// cursor-probes.js — asks the installed Cursor CLI (`cursor-agent`) four questions before the harness writes any code
// for it, without a model and without spending quota:
//   S1  which global rules file the CLI reads, and whether the session-start hook injects text
//   S2  whether a hook sees a subagent being launched
//   S3  which variables with a conversation id a terminal command and a hook see, and whether they match the payload
//   S4  which chain of ancestor processes a hook sees, and whether `cursor-agent` shows up by name or only in the
//       command line
// Two sources, both without a model:
//   · the package: the text of the installed CLI (hook names, rules files, the CURSOR_* variables it gives its children,
//     the option that points it to another service);
//   · a run: `cursor-agent -p` in a temporary folder whose `.cursor/hooks.json` records what each hook receives, with
//     the service pointed to a closed local address, without `--force`. Cursor runs no project hook in a folder it does
//     not trust, so the run passes `--trust` for that temporary folder only; afterwards it removes what Cursor stored
//     for that folder under its projects folder and checks the listing is the one from before (`cursor_state`). Whatever
//     a hook records before the CLI fails to reach the service is the evidence.
// What needs a model (a subagent launch, a terminal command, the rules the model actually got) is
// `NO MEDIDO (pide modelo)`: it belongs to a re-test with a paid plan. A failure never comes out as a measured answer.
// It never reads or writes the keychain, never changes Cursor's settings and never writes into a repo.
// Every child has a time limit; a probe that hangs or fails says so and the others go on.
//
// Usage:  node scripts/tools/cursor-probes.js [--json] [--timeout-ms <n>] [--report <file.md>] [--no-run]
//   --json          the result as JSON on stdout, unmasked (otherwise a short summary)
//   --timeout-ms    the time limit of each call to cursor-agent (default 20000)
//   --report        also writes the result in Spanish, with the branch of decisions D4, D5, D8 and D9; personal paths,
//                   ids and secrets are masked
//   --no-run        only the package reading (the run items say «NO MEDIDO (sin ejecución: --no-run)»)
// Exit: 0 when it could write its output (a failed probe does not change it) · 2 with invalid arguments · 1 on an
// unexpected crash or when the report cannot be written (the result still goes to stdout first).

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 20000;
// the most setTimeout takes: above it Node fires at once
const MAX_TIMEOUT_MS = 2147483647;
const MAX_OUTPUT = 4000;
// what a hook launched without waiting gets to finish after the CLI exits, before its process group is killed
const RUN_GRACE_MS = 1500;
const RUN_PROMPT = 'Respondé sólo: ok';
const HOOK_EVENTS = ['sessionStart', 'sessionEnd', 'workspaceOpen', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'beforeReadFile',
  'afterFileEdit', 'beforeTabFileRead', 'afterTabFileEdit', 'subagentStart', 'subagentStop', 'preCompact',
  'afterAgentThought', 'afterAgentResponse', 'stop'];
const MODEL_EVENTS = ['afterAgentThought', 'afterAgentResponse'];
// how the CLI names a project folder with a long route: the first characters of the whole route and a hash of it
const LONG_ROUTE = 91;
const ROUTE_CUT = 83;
const ROUTE_HASH = 7;
// an id the run would inherit from whoever launched the probes: it says nothing about what Cursor gives its hooks
const INHERITED_ID = /(SESSION|CONVERSATION|CHAT).*ID$/i;
const SECRET_WORD = '[\\w.-]*(?:key|token|secret|passw(?:or)?d|pat(?![a-z])|auth|credential)[\\w.-]*';
const SECRETS = [
  [new RegExp(`(?<![\\w.-])(--?${SECRET_WORD}[= ])("[^"]*"|\\S+)`, 'gi'), '$1<oculto>'],
  [new RegExp(`\\b(${SECRET_WORD}=)("[^"]*"|\\S+)`, 'gi'), '$1<oculto>'],
  [/\b((?:Bearer|Basic)\s+)\S+/gi, '$1<oculto>'],
  [/(:\/\/)[^\s/@]+@/g, '$1<oculto>@'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<correo>'],
];

const MEDIDO = 'MEDIDO';
const NO_MEDIDO = 'NO MEDIDO';
const ERROR = 'ERROR';
const EJECUCION = 'ejecución';

// ── arguments ────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { json: false, timeoutMs: DEFAULT_TIMEOUT_MS, report: null, run: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-run') o.run = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--timeout-ms') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMEOUT_MS) throw new Error(`--timeout-ms pide un entero entre 1 y ${MAX_TIMEOUT_MS}`);
      o.timeoutMs = n;
    } else if (a === '--report') {
      o.report = argv[++i];
      if (!o.report || o.report.startsWith('-')) throw new Error('--report pide una ruta');
    } else throw new Error(`argumento desconocido: ${a}`);
  }
  return o;
}

// ── finding Cursor ───────────────────────────────────────────────────────────────────────────────────────────────────

function findCursor(env) {
  const names = IS_WIN ? ['cursor-agent.cmd', 'cursor-agent.exe', 'cursor-agent.bat', 'cursor-agent'] : ['cursor-agent'];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (!fs.statSync(p).isFile()) continue;
        if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (_e) { /* not here */ }
    }
  }
  return null;
}

function packageDirOf(cursorPath) {
  try { return path.dirname(fs.realpathSync(cursorPath)); } catch (_e) { return path.dirname(cursorPath); }
}

// ── running a child with a time limit ────────────────────────────────────────────────────────────────────────────────

function clip(s) {
  const t = String(s || '');
  return t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}…` : t;
}

/**
 * Runs `file args` and resolves when it exits or when the time limit kills it (with its whole process group). `graceMs`
 * is what the process group gets after the exit. `full` carries the end of the output, unclipped: the error comes last.
 */
function runCmd(file, args, { cwd, env, timeoutMs, graceMs = 0 }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const viaShell = IS_WIN && /\.(cmd|bat)$/i.test(file);
    let child;
    try {
      child = viaShell
        ? spawn(`"${file}" ${args.map((a) => `"${a}"`).join(' ')}`, { cwd, env, shell: true, windowsHide: true })
        : spawn(file, args, { cwd, env, detached: !IS_WIN, windowsHide: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', full: '', timedOut: false, error: e.message });
      return;
    }
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch (_e) { /* already closed */ }
      resolve(Object.assign({ stdout: clip(stdout), stderr: clip(stderr), full: `${stderr}\n${stdout}`, timedOut }, r));
    };
    const kill = () => {
      try {
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch (_e) {
        try { child.kill('SIGKILL'); } catch (_e2) { /* already gone */ }
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); finish({ code: null }); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout = `${stdout}${d}`.slice(-MAX_OUTPUT * 2); });
    child.stderr.on('data', (d) => { stderr = `${stderr}${d}`.slice(-MAX_OUTPUT * 2); });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('exit', (code) => {
      clearTimeout(timer);
      setTimeout(() => {
        // a grandchild may keep the pipes open: the exit is what counts
        if (!IS_WIN) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_e) { /* group already gone */ } }
        setTimeout(() => finish({ code }), 50);
      }, graceMs);
    });
    child.stdin.end();
  });
}

function hungReason(ms) {
  return `se colgó: pasó el tiempo máximo de ${ms} ms`;
}

function firstLine(s) {
  return String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// ── source 1: the package ────────────────────────────────────────────────────────────────────────────────────────────

const PACKAGE_TERMS = {
  hooks: { re: new RegExp(`"(${HOOK_EVENTS.join('|')})"`, 'g') },
  rules: { re: /(\.cursor\/rules|\.cursorrules|AGENTS\.md|CLAUDE\.local\.md|CLAUDE\.md)/g },
  userRules: { re: /(homedir\)\(\),"\.cursor","rules")/g },
  additionalContext: { re: /(additional_context|additionalContext)/g },
  endpoint: { re: /(--endpoint|CURSOR_API_ENDPOINT)/g },
  idVars: { re: /\b(CURSOR_[A-Z_]*(?:CONVERSATION|CHAT|SESSION)[A-Z_]*ID)\b/g },
  subagentHooks: { re: /"(subagentStart|subagentStop)"/g },
};

// Only the top folder: it holds the CLI's own code, and what is deeper is node_modules. A file that cannot be read, or a
// folder where nothing of Cursor shows up, fails the whole reading: otherwise it comes out as «the code does not name it».
function readPackage(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  } catch (e) {
    return { error: `no pude leer la carpeta del paquete: ${e.code || e.message}` };
  }
  if (!files.length) return { error: 'la carpeta del paquete no trae archivos .js' };
  const found = {};
  for (const k of Object.keys(PACKAGE_TERMS)) found[k] = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return { error: `no pude leer ${f} del paquete: ${e.code || e.message}` }; }
    for (const [k, { re }] of Object.entries(PACKAGE_TERMS)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const term = m[1];
        if (!found[k].has(term)) {
          const a = Math.max(0, m.index - 60);
          found[k].set(term, { term, file: f, snippet: text.slice(a, m.index + m[0].length + 60).replace(/\s+/g, ' ') });
        }
      }
    }
  }
  if (Object.values(found).every((m) => m.size === 0)) return { error: 'no reconozco el código de Cursor en esa carpeta: no aparece ningún término conocido' };
  const out = { files: files.length };
  for (const k of Object.keys(found)) out[k] = [...found[k].values()];
  return out;
}

// ── source 2: a run with recording hooks ─────────────────────────────────────────────────────────────────────────────

// The hook every event runs. It records first what it got, in case its process group is killed while it asks `ps`, and
// then the chain of ancestors up to the probes: what launched the probes says nothing about the Cursor measured. It
// compares every variable against the ids of the payload by value and keeps only the name of the ones that match.
const RECORDER = `'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const event = process.argv[2];
const out = process.argv[3];
const stopPid = Number(process.argv[4]) || 0;
const write = (line) => { try { fs.appendFileSync(out, JSON.stringify(line) + '\\n'); } catch (e) { process.stderr.write('probe-recorder: ' + e.message + '\\n'); } };
let payload = null;
let payloadError = null;
try { const raw = fs.readFileSync(0, 'utf8'); payload = raw ? JSON.parse(raw) : null; } catch (e) { payloadError = e.message; }
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^CURSOR_|^CLAUDE_|^CODEX_|SESSION|CONVERSATION/i.test(k) && !/KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(k)) env[k] = v;
}
const ids = payload && typeof payload === 'object' ? [payload.session_id, payload.conversation_id].filter((v) => v != null).map(String) : [];
const matching = Object.keys(process.env).filter((k) => ids.includes(process.env[k]));
write({ stage: 'inicio', event, payload, payloadError, env, matching });
let ancestors = null;
let ancestorsError = null;
if (process.platform === 'win32') ancestorsError = 'sin ps en Windows';
else {
  ancestors = [];
  const ps = (field, pid) => { const r = spawnSync('ps', ['-o', field + '=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }); return r.status === 0 ? r.stdout.trim() : null; };
  let pid = process.pid;
  for (let i = 0; i < 25 && pid > 1 && pid !== stopPid; i++) {
    const ppid = Number(ps('ppid', pid));
    const exe = ps('ucomm', pid);
    if (exe == null) { ancestorsError = i === 0 ? 'ps no contestó' : 'ps dejó de contestar a mitad de la cadena'; break; }
    ancestors.push({ pid, ppid, start: ps('lstart', pid), exe, args: ps('args', pid) });
    if (!ppid || ppid === pid) break;
    pid = ppid;
  }
}
write({ stage: 'cadena', event, ancestors, ancestorsError });
process.stdout.write('{}');
`;

/** Runs the recorder once by hand: a run without records says something only if the recorder writes. null when it does. */
function checkRecorder(recorder, records) {
  const r = spawnSync(process.execPath, [recorder, 'prueba', records, String(process.pid)], { input: '{}', encoding: 'utf8', timeout: 15000 });
  if (fs.existsSync(records)) return null;
  return `el registrador de hooks no escribió: ${firstLine(r.stderr) || (r.error && r.error.message) || 'sin mensaje'}`;
}

function closedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(9));
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function removeFolder(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* the OS cleans tmp */ }
}

async function runWithHooks(cursor, opts, pkg) {
  // without the listing from before there is no way to leave the projects folder as it was: no run
  const before = readProjects();
  if (before.error) return { skip: `no pude leer ~/.cursor/projects: ${before.error}` };
  let work = null;
  let records;
  let recorder;
  try {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-probes-run-')));
    const dotCursor = path.join(work, '.cursor');
    fs.mkdirSync(dotCursor);
    recorder = path.join(dotCursor, 'probe-recorder.js');
    records = path.join(dotCursor, 'records.jsonl');
    fs.writeFileSync(recorder, RECORDER);
    const broken = checkRecorder(recorder, path.join(dotCursor, 'records-check.jsonl'));
    if (broken) {
      removeFolder(work);
      return { skip: broken };
    }
    const hooks = {};
    for (const ev of HOOK_EVENTS) hooks[ev] = [{ command: `"${process.execPath}" "${recorder}" ${ev} "${records}" ${process.pid}` }];
    fs.writeFileSync(path.join(dotCursor, 'hooks.json'), JSON.stringify({ version: 1, hooks }, null, 2));
  } catch (e) {
    if (work) removeFolder(work);
    return { skip: `no pude armar la carpeta temporal: ${e.code || e.message}` };
  }
  try {
    const port = await closedPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!INHERITED_ID.test(k)) env[k] = v;
    // Cursor runs no project hook in a folder it does not trust: `--trust` marks this temporary folder only, and what
    // Cursor stores for it is removed below. The service is pointed the way the package says it can be
    const args = ['-p', RUN_PROMPT, '--trust'];
    let pointedBy;
    if (pkg.endpoint.some((e) => e.term === 'CURSOR_API_ENDPOINT')) {
      env.CURSOR_API_ENDPOINT = endpoint;
      pointedBy = `CURSOR_API_ENDPOINT=${endpoint}`;
    } else {
      args.push('--endpoint', endpoint);
      pointedBy = `--endpoint ${endpoint}`;
    }
    const r = await runCmd(cursor, args, { cwd: work, env, timeoutMs: opts.timeoutMs, graceMs: RUN_GRACE_MS });
    const cursorState = restoreProjects(before, work);
    let recs = [];
    let readError = null;
    try {
      recs = fs.readFileSync(records, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      recs = [];
      if (e.code !== 'ENOENT') readError = `no pude leer lo que grabaron los hooks: ${e.code || e.message}`;
    }
    return {
      command: `cursor-agent ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')} (${pointedBy}, carpeta temporal con .cursor/hooks.json, sin --force; --trust sólo para esa carpeta)`,
      result: r,
      records: recs,
      readError,
      closedAddress: `127.0.0.1:${port}`,
      reachedService: r.code === 0 || recs.some((x) => MODEL_EVENTS.includes(x.event)),
      cursorState,
    };
  } finally {
    removeFolder(work);
  }
}

// ── Cursor's state: its projects folder must end as it started ───────────────────────────────────────────────────────

function dataDir() {
  const custom = String(process.env.CURSOR_DATA_DIR || '').trim();
  return custom || path.join(os.homedir(), '.cursor');
}

function projectsDir() {
  return path.join(dataDir(), 'projects');
}

function readProjects() {
  const dataDirExisted = fs.existsSync(dataDir());
  try {
    return { list: fs.readdirSync(projectsDir()).sort(), error: null, dataDirExisted };
  } catch (e) {
    return { list: null, error: e.code === 'ENOENT' ? null : (e.code || e.message), dataDirExisted };
  }
}

function slugOf(dir) {
  return dir.replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]+/g, '-');
}

/**
 * The second folder the CLI creates for `work` when its route is long: the whole route cut at a fixed length, plus a hash
 * of that route. With a long data folder the cut lands above `projects`, so this is a path and not a name under it.
 */
function shortRoute(work) {
  const route = path.join(projectsDir(), slugOf(work));
  if (route.length <= LONG_ROUTE) return null;
  return `${route.substring(0, ROUTE_CUT)}-${crypto.createHash('sha256').update(route).digest('hex').slice(0, ROUTE_HASH)}`;
}

/**
 * Whether a project folder was created for `work`: the exact names the CLI gives it, the path with dashes and, with a
 * long route, the cut route with its hash. Anything else belongs to another Cursor session.
 */
function isRunFolder(name, work) {
  return name === slugOf(work) || path.join(projectsDir(), name) === shortRoute(work);
}

/**
 * Removes what the run left for `work` and checks that it is gone: the projects folder must list what it listed before,
 * and the short folder, which may be outside it, must not exist.
 */
function restoreProjects(before, work) {
  const dir = projectsDir();
  const removed = [];
  // its name carries a hash of a route that did not exist before the run: it can only be from this run
  const short = shortRoute(work);
  const shortOutside = short && path.dirname(short) !== dir ? short : null;
  if (shortOutside && fs.existsSync(shortOutside)) {
    try { fs.rmSync(shortOutside, { recursive: true, force: true }); removed.push(path.basename(shortOutside)); } catch (_e) { /* reported below */ }
  }
  const left = shortOutside && fs.existsSync(shortOutside) ? `no pude borrar ${shortOutside}, que Cursor creó para esta ejecución fuera de ~/.cursor/projects` : null;
  const now = readProjects();
  if (now.error) return { status: ERROR, motivo: left || `no pude leer ~/.cursor/projects después de la ejecución: ${now.error}`, removed, foreign: [] };
  const added = (now.list || []).filter((n) => !(before.list || []).includes(n));
  for (const n of added.filter((a) => isRunFolder(a, work))) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); removed.push(n); } catch (_e) { /* reported below */ }
  }
  // the folders themselves, when the run created them
  if (before.list === null && now.list !== null) {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_e) { /* reported below */ }
    if (!before.dataDirExisted) {
      try { if (fs.readdirSync(dataDir()).length === 0) fs.rmdirSync(dataDir()); } catch (_e) { /* not ours or not empty */ }
    }
  }
  const after = readProjects();
  const same = !after.error && JSON.stringify(after.list) === JSON.stringify(before.list);
  const foreign = added.filter((a) => !isRunFolder(a, work));
  let motivo = left;
  if (!motivo && foreign.length) motivo = `en ~/.cursor/projects apareció ${foreign.length} carpeta(s) que no son de esta ejecución y no las toqué (los nombres, en cursor_state.foreign de --json)`;
  else if (!motivo && !same) motivo = '~/.cursor/projects no quedó igual que antes';
  return { status: same && !left ? 'igual' : ERROR, motivo, removed, foreign };
}

const NO_HOOK_WITH_SERVICE_CLOSED = 'Cursor no disparó ningún hook con el servicio cerrado';

/** Why the run left no record: the reason a run item shows. */
function noRecordReason(run, timeoutMs) {
  const r = run.result;
  if (run.readError) return { status: ERROR, motivo: run.readError };
  if (r.timedOut) return { status: NO_MEDIDO, motivo: hungReason(timeoutMs) };
  if (r.error) return { status: ERROR, motivo: `no pude lanzar cursor-agent: ${r.error}` };
  // only a refused connection to the closed address: any other failure says nothing about the hooks
  if (r.full.includes(run.closedAddress)) return { status: NO_MEDIDO, motivo: NO_HOOK_WITH_SERVICE_CLOSED };
  if (/Workspace Trust Required/i.test(r.full)) return { status: ERROR, motivo: `Cursor pidió confiar en la carpeta aun con --trust: ${firstLine(r.stderr) || firstLine(r.stdout)}` };
  if (r.code === 0) return { status: NO_MEDIDO, motivo: 'Cursor terminó sin disparar ningún hook' };
  return { status: ERROR, motivo: `cursor-agent salió ${r.code}: ${firstLine(r.stderr) || firstLine(r.stdout) || 'sin mensaje'}` };
}

// ── the questions ────────────────────────────────────────────────────────────────────────────────────────────────────

function item(id, question, source, fields) {
  return Object.assign({ id, question, source, status: NO_MEDIDO, motivo: null, answer: null, command: null, output: null, evidence: [] }, fields);
}

function notMeasured(id, question, source, motivo) {
  return item(id, question, source, { status: NO_MEDIDO, motivo });
}

function modelItem(id, question) {
  return notMeasured(id, question, 'modelo', 'pide modelo');
}

function packageItem(id, question, pkg, pkgCmd, build) {
  if (pkg.error) return item(id, question, 'paquete', { status: ERROR, motivo: pkg.error });
  const { answer, output, evidence } = build(pkg);
  return item(id, question, 'paquete', { status: MEDIDO, answer, command: pkgCmd, output, evidence });
}

const Q = {
  s1Rules: '¿Qué archivos de reglas nombra el código del CLI?',
  s1UserRules: '¿El código arma una carpeta de reglas del usuario (~/.cursor/rules)?',
  s1Hooks: '¿Qué hooks nombra el código del CLI?',
  s1Inject: '¿El código acepta que un hook devuelva texto para el contexto (additional_context)?',
  s1SessionStart: '¿Cursor dispara el hook de arranque de sesión con el servicio cerrado, antes de su primera llamada?',
  s1Model: '¿Qué reglas globales recibe de verdad el modelo, y si le llega el texto del hook de arranque?',
  s2Code: '¿El código tiene hooks propios de subagentes?',
  s2Model: '¿Un hook ve el lanzamiento de un subagente, con qué nombre de herramienta y con la orden en su entrada?',
  s3Code: '¿Qué variables con un id de conversación nombra el código?',
  s3Hook: '¿Qué variables con un id ve un hook, y coinciden con el session_id o el conversation_id del payload?',
  s3Terminal: '¿Qué variables con un id ve un comando de terminal de la sesión?',
  s4Hook: '¿Qué cadena de procesos ancestros ve un hook, y cursor-agent aparece por su nombre o sólo en la línea de comando?',
  s4Terminal: '¿Qué cadena de procesos ancestros ve un comando de terminal de la sesión?',
};

const names = (list) => list.map((e) => e.term);
const evid = (list) => list.map((e) => `${e.file}: …${e.snippet}…`);

function cursorSeenAs(chain) {
  if (chain.some((a) => /^cursor-agent(\.(cmd|exe|bat))?$/i.test(path.basename(String(a.exe || '').trim())))) return 'ejecutable';
  if (chain.some((a) => /(^|[\\/\s])cursor-agent(\.(cmd|exe|bat))?(\s|$)/i.test(String(a.args || '')))) return 'linea de comando';
  return 'no aparece';
}

function hasPayloadId(r) {
  const p = r.payload;
  return p && typeof p === 'object' && !Array.isArray(p) && (p.session_id != null || p.conversation_id != null);
}

function buildProbes(ctx) {
  const { pkg, pkgCmd, run, runSkip, timeoutMs } = ctx;
  const recs = run ? run.records : [];
  const runItem = (id, question, build) => {
    if (runSkip) return notMeasured(id, question, EJECUCION, runSkip);
    if (!recs.length) return item(id, question, EJECUCION, Object.assign(noRecordReason(run, timeoutMs), { command: run.command, output: clip(`${run.result.stderr}${run.result.stdout}`) || null }));
    return build(recs);
  };

  let startItem;
  if (run && run.reachedService) {
    startItem = notMeasured('arranque_con_servicio_cerrado', Q.s1SessionStart, EJECUCION, 'la ejecución llegó al servicio de Cursor: no fue con el servicio cerrado');
  } else if (!runSkip && !recs.length && noRecordReason(run, timeoutMs).motivo === NO_HOOK_WITH_SERVICE_CLOSED) {
    // no record because Cursor reached for its service before any hook: a measured «no», not «not measured». It says
    // nothing about the hook running before the model: that first call may be to something else
    startItem = item('arranque_con_servicio_cerrado', Q.s1SessionStart, EJECUCION, {
      status: MEDIDO, answer: false, command: run.command,
      output: `no: con el servicio cerrado no corrió ningún hook (${firstLine(run.result.stderr) || firstLine(run.result.stdout)})`,
    });
  } else {
    startItem = runItem('arranque_con_servicio_cerrado', Q.s1SessionStart, (rs) => item('arranque_con_servicio_cerrado', Q.s1SessionStart, EJECUCION, {
      status: MEDIDO, answer: rs.some((r) => r.event === 'sessionStart'), command: run.command,
      output: `hooks disparados: ${[...new Set(rs.map((r) => r.event))].join(', ')}`,
    }));
  }

  const S1 = [
    packageItem('reglas_en_el_codigo', Q.s1Rules, pkg, pkgCmd, (p) => ({
      answer: names(p.rules), output: p.rules.length ? `nombra: ${names(p.rules).join(', ')}` : 'no nombra ningún archivo de reglas conocido', evidence: evid(p.rules),
    })),
    packageItem('carpeta_de_reglas_de_usuario', Q.s1UserRules, pkg, pkgCmd, (p) => ({
      answer: p.userRules.length > 0, output: p.userRules.length ? 'sí: arma ~/.cursor/rules con alcance de usuario; si el modelo las recibe, lo dice la reprueba' : 'no la arma', evidence: evid(p.userRules),
    })),
    packageItem('hooks_en_el_codigo', Q.s1Hooks, pkg, pkgCmd, (p) => ({
      answer: names(p.hooks), output: p.hooks.length ? `nombra: ${names(p.hooks).join(', ')}` : 'no nombra hooks conocidos', evidence: evid(p.hooks).slice(0, 3),
    })),
    packageItem('contexto_de_hooks_en_el_codigo', Q.s1Inject, pkg, pkgCmd, (p) => ({
      answer: p.additionalContext.length > 0, output: p.additionalContext.length ? 'sí: el código trae additional_context para los hooks' : 'no aparece additional_context', evidence: evid(p.additionalContext),
    })),
    startItem,
    modelItem('reglas_que_recibe_el_modelo', Q.s1Model),
  ];

  const S2 = [
    packageItem('hooks_de_subagentes_en_el_codigo', Q.s2Code, pkg, pkgCmd, (p) => ({
      answer: names(p.subagentHooks), output: p.subagentHooks.length ? `trae: ${names(p.subagentHooks).join(', ')}` : 'no trae hooks de subagentes', evidence: evid(p.subagentHooks),
    })),
    modelItem('hook_ve_el_subagente', Q.s2Model),
  ];

  const S3 = [
    packageItem('variables_de_id_en_el_codigo', Q.s3Code, pkg, pkgCmd, (p) => ({
      answer: names(p.idVars), output: p.idVars.length ? `nombra: ${names(p.idVars).join(', ')}` : 'no nombra variables con id de conversación', evidence: evid(p.idVars),
    })),
    runItem('variables_de_id_en_el_hook', Q.s3Hook, (rs) => {
      const starts = rs.filter((r) => r.stage === 'inicio');
      const usable = starts.filter(hasPayloadId);
      if (!usable.length) {
        const bad = starts.find((r) => r.payloadError);
        return notMeasured('variables_de_id_en_el_hook', Q.s3Hook, EJECUCION, bad ? `el hook no recibió un payload legible: ${bad.payloadError}` : 'el hook no recibió un payload con session_id ni conversation_id');
      }
      const vars = {};
      const ids = { session_id: null, conversation_id: null };
      const matching = new Set();
      for (const r of usable) {
        for (const [k, v] of Object.entries(r.env || {})) if (/ID$/i.test(k) && !(k in vars)) vars[k] = v;
        for (const k of Object.keys(ids)) if (ids[k] == null && r.payload[k] != null) ids[k] = r.payload[k];
        for (const k of r.matching || []) matching.add(k);
      }
      const seen = Object.keys(vars);
      const match = [...matching];
      return item('variables_de_id_en_el_hook', Q.s3Hook, EJECUCION, {
        status: MEDIDO,
        answer: { vars, payload_ids: ids, matches_payload: match.length > 0, matching: match },
        command: run.command,
        output: seen.length || match.length
          ? `los hooks ven ${seen.join(', ') || 'ninguna con nombre de id'}; coinciden con el payload: ${match.join(', ') || 'ninguna'}`
          : 'los hooks no ven ninguna variable con id',
      });
    }),
    modelItem('variables_de_id_en_la_terminal', Q.s3Terminal),
  ];

  const S4 = [
    runItem('ancestros_del_hook', Q.s4Hook, (rs) => {
      const r0 = rs.find((r) => Array.isArray(r.ancestors) && r.ancestors.length);
      const broken = rs.find((r) => r.ancestorsError);
      if (!r0) return notMeasured('ancestros_del_hook', Q.s4Hook, EJECUCION, broken ? broken.ancestorsError : 'el hook no pudo leer sus ancestros');
      const seen = cursorSeenAs(r0.ancestors);
      // a chain cut short cannot say that Cursor is not in it
      if (seen === 'no aparece' && r0.ancestorsError) return notMeasured('ancestros_del_hook', Q.s4Hook, EJECUCION, r0.ancestorsError);
      return item('ancestros_del_hook', Q.s4Hook, EJECUCION, {
        status: MEDIDO,
        answer: { chain: r0.ancestors, cursor_seen_as: seen },
        command: run.command,
        output: `${r0.ancestors.length} ancestros desde el hook «${r0.event}»; cursor-agent: ${seen}`,
      });
    }),
    modelItem('ancestros_de_la_terminal', Q.s4Terminal),
  ];

  const probes = {};
  for (const [k, items] of Object.entries({ S1, S2, S3, S4 })) probes[k] = summarize(items);
  return probes;
}

function summarize(items) {
  const measured = items.filter((i) => i.status === MEDIDO);
  if (measured.length === items.length) return { status: MEDIDO, motivo: null, items };
  if (measured.length > 0) {
    return { status: 'PARCIAL', motivo: [...new Set(items.filter((i) => i.status !== MEDIDO).map((i) => i.motivo))].join(' · '), items };
  }
  return { status: items[0].status, motivo: items[0].motivo, items };
}

// ── the decisions: a probe that did not measure leaves its decision on the safe branch ───────────────────────────────

function findItem(probes, s, id) {
  return (probes[s].items || []).find((i) => i.id === id) || { status: NO_MEDIDO, motivo: 'sin la pregunta' };
}

function decide(probes) {
  const s1model = findItem(probes, 'S1', 'reglas_que_recibe_el_modelo');
  const s1user = findItem(probes, 'S1', 'carpeta_de_reglas_de_usuario');
  const s1ctx = findItem(probes, 'S1', 'contexto_de_hooks_en_el_codigo');
  const s1start = findItem(probes, 'S1', 'arranque_con_servicio_cerrado');
  const s2model = findItem(probes, 'S2', 'hook_ve_el_subagente');
  const s3term = findItem(probes, 'S3', 'variables_de_id_en_la_terminal');
  const s4hook = findItem(probes, 'S4', 'ancestros_del_hook');

  // D4: (a) only with a global rules file the model is seen to receive; (b) only with the injected text seen; else (c)
  let D4;
  if (s1model.status === MEDIDO && s1model.answer && s1model.answer.global_file) {
    D4 = { rama: '(a)', motivo: `el modelo recibe ${s1model.answer.global_file}`, supuesto: false };
  } else if (s1model.status === MEDIDO && s1model.answer && s1model.answer.session_start_injects) {
    D4 = { rama: '(b)', motivo: 'el modelo recibe el texto del hook de arranque', supuesto: false };
  } else {
    const hints = [];
    if (s1user.status === MEDIDO && s1user.answer) hints.push('el código arma ~/.cursor/rules como reglas de usuario, candidata a (a)');
    if (s1ctx.status === MEDIDO && s1ctx.answer) hints.push('el código acepta additional_context en los hooks, candidato a (b)');
    if (s1start.status === MEDIDO) hints.push(s1start.answer ? 'el hook de arranque corrió con el servicio cerrado' : 'con el servicio cerrado no corrió el hook de arranque, y eso no dice si corre antes del modelo');
    D4 = {
      rama: '(c)',
      motivo: `qué reglas recibe el modelo no se midió (${s1model.motivo || 'sin medir'}): rama segura, no se escribe en los repos${hints.length ? `; para la reprueba: ${hints.join('; ')}` : ''}`,
      supuesto: true,
    };
  }

  // D5 and D8: a variable with the conversation id in the terminal, or else the ancestor process. The id has to come
  // out the same in the hook and in the terminal, so the hook alone never settles it
  let D5;
  if (s3term.status === MEDIDO && s3term.answer && s3term.answer.variable) {
    D5 = { rama: `variable ${s3term.answer.variable}`, motivo: 'la terminal la ve y coincide con el hook', supuesto: false };
  } else {
    let why;
    if (s4hook.status !== MEDIDO) why = `S4 no midió (${s4hook.motivo})`;
    else if (s4hook.answer && s4hook.answer.cursor_seen_as !== 'no aparece') why = `cursor-agent aparece entre los ancestros del hook por su ${s4hook.answer.cursor_seen_as === 'ejecutable' ? 'nombre de ejecutable' : 'línea de comando'}, y la terminal no se midió (pide modelo)`;
    else why = 'cursor-agent no aparece entre los ancestros del hook';
    D5 = { rama: 'proceso ancestro', motivo: `${why}: supuesto a confirmar en la reprueba`, supuesto: true };
  }
  const D8 = { rama: D5.rama.startsWith('variable') ? D5.rama : 'proceso ancestro cursor-agent', motivo: `la misma señal que D5: ${D5.motivo}`, supuesto: D5.supuesto };

  // D9: by mark only if a hook is seen to receive the subagent launch; otherwise check-count fails closed
  let D9;
  if (s2model.status === MEDIDO && s2model.answer === true) D9 = { rama: 'por marca', motivo: 'el hook ve el lanzamiento del subagente', supuesto: false };
  else if (s2model.status === MEDIDO) D9 = { rama: 'falla cerrada', motivo: 'el hook no ve el lanzamiento del subagente (S2 negativa)', supuesto: false };
  else D9 = { rama: 'falla cerrada', motivo: `S2 no midió (${s2model.motivo}): los AC 17 y 19 se confirman con Cursor real en la reprueba`, supuesto: true };

  return { D4, D5, D8, D9 };
}

// ── the report ───────────────────────────────────────────────────────────────────────────────────────────────────────

function collectIds(result) {
  const ids = new Set();
  for (const s of Object.values(result.probes)) {
    for (const it of s.items) {
      const a = it.answer;
      if (a && typeof a === 'object' && a.vars) for (const v of Object.values(a.vars)) if (v) ids.add(String(v));
      if (a && typeof a === 'object' && a.payload_ids) for (const v of Object.values(a.payload_ids)) if (v) ids.add(String(v));
    }
  }
  // a short value would also hide unrelated text, like a pid
  return [...ids].filter((v) => v.length >= 8).sort((x, y) => y.length - x.length);
}

function masker(result) {
  const pairs = [];
  const add = (from, to) => { if (from && from.length > 1) pairs.push([from, to]); };
  const tmps = new Set([os.tmpdir()]);
  try { tmps.add(fs.realpathSync(os.tmpdir())); } catch (_e) { /* keep the plain one */ }
  for (const t of tmps) add(t, '<tmp>');
  const homes = new Set([os.homedir(), process.env.HOME].filter(Boolean));
  for (const h of homes) {
    add(h, '~');
    add(slugOf(h), '~');
    try { add(fs.realpathSync(h), '~'); } catch (_e) { /* keep the plain one */ }
  }
  for (const id of collectIds(result)) add(id, '<id>');
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (s) => {
    let t = String(s == null ? '' : s);
    for (const [from, to] of pairs) t = t.split(from).join(to);
    for (const [re, to] of SECRETS) t = t.replace(re, to);
    return t;
  };
}

function cell(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function answerText(it) {
  if (it.status !== MEDIDO) return `${it.status}${it.motivo ? ` (${it.motivo})` : ''}`;
  if (it.output) return it.output;
  return JSON.stringify(it.answer);
}

function renderReport(result) {
  const m = masker(result);
  const L = [];
  L.push('# Medición — sondas de Cursor');
  L.push('');
  L.push(`Medido el ${result.measured_at} con \`scripts/tools/cursor-probes.js\`, sin modelo y sin \`--force\`.`);
  L.push('');
  L.push(`- Cursor: ${result.cursor.path ? `\`${m(result.cursor.path)}\` (paquete en \`${m(result.cursor.package_dir)}\`)` : 'no está en el PATH'}`);
  L.push(`- Versión: ${result.version.status === MEDIDO ? `\`${m(result.version.value)}\`` : `${result.version.status} (${m(result.version.motivo)})`} — \`${result.version.command || 'cursor-agent --version'}\``);
  L.push('');
  L.push('## Las decisiones');
  L.push('');
  L.push('| Decisión | Rama | Por qué | ¿Supuesto? |');
  L.push('|---|---|---|---|');
  for (const d of ['D4', 'D5', 'D8', 'D9']) {
    const x = result.decisions[d];
    L.push(`| ${d} | ${cell(x.rama)} | ${cell(m(x.motivo))} | ${x.supuesto ? 'sí, a confirmar en la reprueba' : 'no'} |`);
  }
  L.push('');
  if (result.notes.length) {
    for (const n of result.notes) L.push(`- ${m(n)}`);
    L.push('');
  }
  for (const s of ['S1', 'S2', 'S3', 'S4']) {
    const p = result.probes[s];
    L.push(`## ${s} — ${p.status}${p.motivo ? ` (${m(p.motivo)})` : ''}`);
    L.push('');
    L.push('| Pregunta | Fuente | Respuesta |');
    L.push('|---|---|---|');
    for (const it of p.items) L.push(`| ${cell(it.question)} | ${it.source} | ${cell(m(answerText(it)))} |`);
    L.push('');
    const withEvidence = p.items.filter((it) => it.command || (it.evidence && it.evidence.length));
    for (const it of withEvidence) {
      L.push(`- **${it.id}** — comando: \`${m(it.command || '')}\``);
      for (const e of (it.evidence || []).slice(0, 3)) L.push(`  - \`${m(e).replace(/`/g, "'")}\``);
      if (it.id === 'ancestros_del_hook' && it.status === MEDIDO) {
        for (const a of it.answer.chain) L.push(`  - pid ${a.pid} · ${m(a.start || '')} · \`${m(a.exe)}\` · \`${m(a.args).replace(/`/g, "'").slice(0, 200)}\``);
      }
    }
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function probe(opts) {
  const env = process.env;
  const cursor = findCursor(env);
  const result = {
    measured_at: new Date().toISOString(),
    timeout_ms: opts.timeoutMs,
    cursor: { path: cursor, package_dir: cursor ? packageDirOf(cursor) : null },
    version: { status: NO_MEDIDO, motivo: null, value: null, command: 'cursor-agent --version', output: null },
    probes: {},
    decisions: {},
    cursor_state: { status: 'sin ejecución', motivo: null, removed: [], foreign: [] },
    notes: [],
  };

  if (!cursor) {
    const why = 'cursor-agent no está en el PATH';
    result.version.motivo = why;
    const none = (ids) => summarize(ids.map(([id, q, src]) => notMeasured(id, q, src, why)));
    result.probes = {
      S1: none([['reglas_en_el_codigo', Q.s1Rules, 'paquete'], ['carpeta_de_reglas_de_usuario', Q.s1UserRules, 'paquete'], ['hooks_en_el_codigo', Q.s1Hooks, 'paquete'], ['contexto_de_hooks_en_el_codigo', Q.s1Inject, 'paquete'], ['arranque_con_servicio_cerrado', Q.s1SessionStart, EJECUCION], ['reglas_que_recibe_el_modelo', Q.s1Model, 'modelo']]),
      S2: none([['hooks_de_subagentes_en_el_codigo', Q.s2Code, 'paquete'], ['hook_ve_el_subagente', Q.s2Model, 'modelo']]),
      S3: none([['variables_de_id_en_el_codigo', Q.s3Code, 'paquete'], ['variables_de_id_en_el_hook', Q.s3Hook, EJECUCION], ['variables_de_id_en_la_terminal', Q.s3Terminal, 'modelo']]),
      S4: none([['ancestros_del_hook', Q.s4Hook, EJECUCION], ['ancestros_de_la_terminal', Q.s4Terminal, 'modelo']]),
    };
  } else {
    const v = await runCmd(cursor, ['--version'], { cwd: os.tmpdir(), env, timeoutMs: opts.timeoutMs });
    result.version.output = clip(`${v.stdout}${v.stderr}`) || null;
    if (v.timedOut) Object.assign(result.version, { status: NO_MEDIDO, motivo: hungReason(opts.timeoutMs) });
    else if (v.error || v.code !== 0) Object.assign(result.version, { status: ERROR, motivo: v.error || `salió ${v.code}: ${firstLine(v.stderr) || firstLine(v.stdout) || 'sin mensaje'}` });
    else if (!firstLine(v.stdout)) Object.assign(result.version, { status: ERROR, motivo: 'salió 0 sin imprimir la versión' });
    else Object.assign(result.version, { status: MEDIDO, value: firstLine(v.stdout) });

    const pkg = readPackage(result.cursor.package_dir);
    const pkgCmd = pkg.error ? null : `lectura de ${pkg.files} archivos .js de ${result.cursor.package_dir}`;
    let run = null;
    let runSkip = null;
    if (!opts.run) runSkip = 'sin ejecución: --no-run';
    else if (pkg.error) runSkip = `sin mecanismo: ${pkg.error}`;
    else if (!pkg.endpoint.length) runSkip = 'sin mecanismo: el CLI no trae --endpoint ni CURSOR_API_ENDPOINT';
    else run = await runWithHooks(cursor, opts, pkg);
    if (run && run.skip) {
      runSkip = run.skip;
      run = null;
    }
    result.probes = buildProbes({ pkg, pkgCmd, run, runSkip, timeoutMs: opts.timeoutMs });
    if (run) {
      result.cursor_state = run.cursorState;
      if (run.reachedService) result.notes.push('ERROR: la ejecución llegó al servicio de Cursor aunque se lo apuntó a una dirección cerrada: pudo gastar cupo.');
      if (run.cursorState.status !== 'igual') result.notes.push(`ERROR: ${run.cursorState.motivo}`);
      else if (run.cursorState.removed.length) result.notes.push(`Cursor guardó ${run.cursorState.removed.length} carpeta(s) en ~/.cursor/projects para la carpeta temporal; se borraron y el listado quedó igual que antes.`);
    }
  }

  result.decisions = decide(result.probes);
  if (findItem(result.probes, 'S2', 'hook_ve_el_subagente').status !== MEDIDO) {
    result.notes.push('S2 no midió: los AC 17 y 19 sólo se confirman con Cursor real en la reprueba (las pruebas T21 y T23 los cubren con registros armados).');
  }
  if (result.decisions.D5.supuesto) result.notes.push('D5 y D8 quedan como supuesto a confirmar en la reprueba.');
  return result;
}

function summaryText(r) {
  const L = [`Cursor: ${r.cursor.path || 'no está en el PATH'} · versión: ${r.version.value || `${r.version.status} (${r.version.motivo})`}`];
  for (const s of ['S1', 'S2', 'S3', 'S4']) L.push(`${s}: ${r.probes[s].status}${r.probes[s].motivo ? ` (${r.probes[s].motivo})` : ''}`);
  for (const d of ['D4', 'D5', 'D8', 'D9']) L.push(`${d}: ${r.decisions[d].rama}${r.decisions[d].supuesto ? ' (supuesto)' : ''}`);
  L.push(`Estado de Cursor: ${r.cursor_state.status}`);
  for (const n of r.notes.filter((x) => x.startsWith('ERROR'))) L.push(n);
  return `${L.join('\n')}\n`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`cursor-probes: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write('Uso: node scripts/tools/cursor-probes.js [--json] [--timeout-ms <n>] [--report <archivo.md>] [--no-run]\n');
    return 0;
  }
  const result = await probe(opts);
  await new Promise((resolve) => { process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : summaryText(result), resolve); });
  if (!opts.report) return 0;
  try {
    fs.mkdirSync(path.dirname(path.resolve(opts.report)), { recursive: true });
    fs.writeFileSync(opts.report, renderReport(result));
    return 0;
  } catch (e) {
    process.stderr.write(`cursor-probes: no pude escribir el informe: ${e.code || e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`cursor-probes: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  });
}

module.exports = { RECORDER, parseArgs, findCursor, readPackage, checkRecorder, decide, cursorSeenAs, renderReport };
