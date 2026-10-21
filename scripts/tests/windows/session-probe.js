#!/usr/bin/env node
'use strict';
/**
 * session-probe.js — una sesión REAL del asistente en el agente, con un hook marcador en cada evento.
 * A pedido: cuesta una credencial y un gasto por corrida.
 *
 * 🔴 NO SE USA: la sesión real se mide en la máquina virtual con el login del dueño, y
 * ninguna credencial del asistente se carga en Azure. Sin `--real-session` el paso dice
 * «no medido: falta la sesión real» y la corrida no cambia de color. El modo con credencial queda escrito y probado por
 * si alguna vez se decide otra cosa; no se lanza.
 *
 * POR QUÉ EXISTE. Tres preguntas deciden cómo se registra un hook en Windows y ninguna se contesta sin el asistente
 * corriendo de verdad: con qué shell lanza el `command` de un hook; cómo se llama la herramienta de terminal en el
 * evento (y si un matcher `Bash` ve lo que corre por la herramienta `PowerShell`); y qué forma tienen las rutas que
 * manda (`cwd`, `file_path`, `transcript_path`). Disparar los hooks a mano (`fire-registered.js`) dice qué pasa con
 * cada shell; sólo esto dice CUÁL usa.
 *
 * QUÉ HACE, con `--real-session` y la credencial en `TYCON_WINDOWS_SESSION_CREDENTIAL`:
 *   1. usa el `claude` de la máquina o lo instala dentro del laboratorio (`npm install --prefix`);
 *   2. en una carpeta de usuario de laboratorio propia, registra un hook marcador de Node en cada evento —sin matcher,
 *      con matcher `Bash` y con matcher `PowerShell`—, que anota lo que recibió y quién lo lanzó;
 *   3. abre una sesión mínima (`claude -p`) que le pide correr un comando y crear un archivo;
 *   4. lo repite con `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` en `env` de `settings.json`, y con Git Bash fuera del PATH.
 *
 * SIN `--real-session` (lo normal): el paso dice «no medido: falta la sesión real» y la corrida no cambia de color.
 *
 * LA CREDENCIAL nunca sale: no se imprime, no va al reporte (se tapa en todo texto antes de escribir) y no se pasa por
 * la línea de comandos de nadie: sólo por el ambiente del `claude` que la usa.
 *
 * 🔴 SIN PROBAR CONTRA UNA SESIÓN REAL: la parte con credencial se probó sólo con un
 * lanzador de mentira. La primera corrida con `realSession: true` es también su primera prueba.
 *
 * Uso: node scripts/tests/windows/session-probe.js --lab <laboratorio> --out <carpeta del reporte> [--real-session]
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');

const NAME = 'session-probe';
const CREDENTIAL_VAR = 'TYCON_WINDOWS_SESSION_CREDENTIAL';
// la sesión real se mide en la máquina virtual con el login del dueño, no en el agente
const NOT_REQUESTED = 'falta la sesión real: se mide en la máquina virtual con el login del dueño (story 8.17, AC 9), no en este agente';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'PreCompact', 'SessionEnd'];
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
const SESSION_TIMEOUT_MS = 8 * 60 * 1000;
// Una sola línea y sin comillas ni acentos: en Windows `claude` puede ser un `.cmd`, y su texto pasa por `cmd.exe`.
const PROMPT = 'Hace exactamente estas tres cosas, en orden, y nada mas: 1) corre en la terminal el comando: echo tycon-probe-terminal '
  + '2) crea el archivo probe-note.txt con el texto: hola '
  + '3) si tenes una herramienta llamada PowerShell, corre con ella: Write-Output tycon-probe-powershell y si no la tenes, deci: sin herramienta PowerShell. '
  + 'Despues deci: listo.';

// El hook marcador. Anota y sale 0 siempre: nunca frena ni habla.
const MARKER = `'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
let raw = '';
process.stdin.on('data', (c) => { raw += c; }).on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch (e) { d = { unreadable: raw.length }; }
  const input = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  let parent = null;
  try {
    const r = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + process.ppid + '").CommandLine'], { encoding: 'utf8', timeout: 20000 })
      : spawnSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 20000 });
    parent = String(r.stdout || '').trim().slice(0, 400) || null;
  } catch (e) { parent = null; }
  // las variables que delatan al shell que lanzó el hook (son del sistema, de MSYS y del asistente: no del arnés)
  const clues = {};
  for (const name of ['SHELL', 'MSYSTEM', 'ComSpec', 'PROMPT', 'PSModulePath', 'CLAUDE_PROJECT_DIR']) clues[name] = name === 'PSModulePath' ? Boolean(process.env[name]) : (process.env[name] || null);
  const line = {
    label: process.argv[2], event: d.hook_event_name || null, tool_name: d.tool_name || null, input_keys: Object.keys(input),
    command: typeof input.command === 'string' ? input.command.slice(0, 200) : null,
    cwd: d.cwd || null, file_path: input.file_path || null, transcript_path: d.transcript_path || null, hook_cwd: process.cwd(),
    parent, clues,
  };
  try { fs.appendFileSync(process.argv[3], JSON.stringify(line) + '\\n'); } catch (e) { /* el marcador nunca frena */ }
});
`;

/** La forma de una ruta, para comparar sin copiarla: `C:\\…`, `C:/…`, `/c/…` (Git Bash), `/…` o `otra`. */
function pathShape(p) {
  if (!p) return null;
  if (/^[A-Za-z]:\\/.test(p)) return 'C:\\…';
  if (/^[A-Za-z]:\//.test(p)) return 'C:/…';
  if (/^\/[A-Za-z]\//.test(p)) return '/c/…';
  if (p.startsWith('/')) return '/…';
  return 'otra';
}

/** El shell que lanzó el hook: el EJECUTABLE de su proceso padre (no lo que su línea de comandos nombre después). */
function shellOf(parent) {
  const line = String(parent || '').trim();
  if (!line) return null;
  const m = /^"([^"]+)"|^(\S+)/.exec(line);
  const exe = String(m[1] || m[2]).replace(/\\/g, '/');
  const name = exe.split('/').pop().toLowerCase().replace(/\.exe$/, '');
  if (name === 'bash') return /\/(system32|sysnative|windowsapps)\//i.test(exe) ? 'bash (lanzador de WSL)' : 'bash';
  if (['pwsh', 'powershell', 'cmd', 'sh', 'zsh', 'dash'].includes(name)) return name;
  if (['node', 'claude', 'bun'].includes(name)) return 'sin shell (lo lanzó el asistente directo)';
  return `otro (${name})`;
}

/** Lo que dicen las líneas del marcador de una sesión. */
function summarize(lines) {
  const any = lines.filter((l) => l.label === 'any');
  const tools = any.filter((l) => TOOL_EVENTS.includes(l.event));
  const uniq = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))];
  const seenBy = (label) => uniq(lines.filter((l) => l.label === label).map((l) => l.tool_name));
  const terminal = uniq(tools.filter((l) => l.command !== null).map((l) => l.tool_name));
  return {
    events: uniq(any.map((l) => l.event)),
    tool_names: uniq(tools.map((l) => l.tool_name)),
    terminal_tool_names: terminal,
    hook_shells: uniq(any.map((l) => shellOf(l.parent))),
    hook_parent_sample: any.length ? any[0].parent : null,
    shapes: { cwd: uniq(any.map((l) => pathShape(l.cwd))), file_path: uniq(any.map((l) => pathShape(l.file_path))), transcript_path: uniq(any.map((l) => pathShape(l.transcript_path))), hook_cwd: uniq(any.map((l) => pathShape(l.hook_cwd))) },
    samples: { cwd: (any.find((l) => l.cwd) || {}).cwd || null, file_path: (any.find((l) => l.file_path) || {}).file_path || null, transcript_path: (any.find((l) => l.transcript_path) || {}).transcript_path || null },
    matcher_bash_saw: seenBy('matcher-Bash'),
    matcher_powershell_saw: seenBy('matcher-PowerShell'),
    powershell_tool_used: terminal.some((t) => /powershell/i.test(t)),
    bash_matcher_sees_powershell_tool: terminal.some((t) => /powershell/i.test(t)) ? seenBy('matcher-Bash').some((t) => /powershell/i.test(t)) : null,
    lines: lines.length,
  };
}

function markerSettings(marker, log, extraEnv) {
  const cmd = (label) => ({ type: 'command', command: `node "${marker.replace(/\\/g, '/')}" ${label} "${log.replace(/\\/g, '/')}"` });
  const hooks = {};
  for (const e of EVENTS) {
    hooks[e] = [{ hooks: [cmd('any')] }];
    if (TOOL_EVENTS.includes(e)) hooks[e].push({ matcher: 'Bash', hooks: [cmd('matcher-Bash')] }, { matcher: 'PowerShell', hooks: [cmd('matcher-PowerShell')] });
  }
  const out = { hooks };
  if (extraEnv) out.env = extraEnv;
  return out;
}

/** El `claude` de la máquina, o uno instalado dentro del laboratorio. `{ bin }` o `{ problem }`. */
function ensureClaude({ lab, env, platform, runner }) {
  const found = L.scanPath('claude', { env, platform });
  if (found.length) return { bin: found[0], from: 'path' };
  const prefix = path.join(lab, 'tools', 'claude-code');
  const npm = L.scanPath('npm', { env, platform })[0];
  if (!npm) return { problem: 'no hay claude ni npm en el PATH para instalarlo' };
  fs.mkdirSync(prefix, { recursive: true });
  const r = runner(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '@anthropic-ai/claude-code'], { env, platform, timeoutMs: 10 * 60 * 1000, cap: 1500 });
  if (r.error || r.exit !== 0) return { problem: `npm install de Claude Code salió ${r.error || r.exit}: ${L.firstLine(r.stderr) || L.firstLine(r.stdout)}` };
  const bin = [path.join(prefix, 'node_modules', '.bin', L.isWin(platform) ? 'claude.cmd' : 'claude')].find((p) => fs.existsSync(p));
  return bin ? { bin, from: 'npm install --prefix (laboratorio)' } : { problem: 'npm install terminó y no dejó el ejecutable de claude' };
}

/** Cómo lanzarlo: si es un `.cmd` de npm y su `cli.js` está al lado, por `node` directo (sin pasar por `cmd.exe`). */
function launchOf(bin) {
  if (/\.(cmd|bat)$/i.test(bin)) {
    const dir = path.dirname(bin);
    for (const rel of [['..', '@anthropic-ai', 'claude-code', 'cli.js'], ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js']]) {
      const cli = path.join(dir, ...rel);
      if (fs.existsSync(cli)) return { bin: process.execPath, args: [cli] };
    }
  }
  return { bin, args: [] };
}

function measure({ lab, realSession = false, credential = null, platform = process.platform, baseEnv = process.env, allowTemp = false, rec, runner = L.runTool }) {
  if (!realSession) return { status: L.STATUS.notMeasured, reason: NOT_REQUESTED };
  // una variable de Azure sin definir llega como el texto «$(nombre)»: no es una credencial
  if (!credential || /^\$\(.*\)$/.test(credential)) return { status: L.STATUS.notMeasured, reason: `falta la credencial del asistente: se pidió la sesión real y ${CREDENTIAL_VAR} no trae nada (tarea humana: cargarla como variable secreta del pipeline)` };
  rec.setRedactor(L.redactor({ secrets: [credential, ...L.secretValues(baseEnv)] }));
  const home = path.join(lab, 'users', 'lab-user-session');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const problem = L.labHomeProblem(home, { labRoot: lab, platform, allowTemp });
  if (problem) return { status: L.STATUS.error, reason: `no pude medir: ${problem}` };
  const dir = path.join(lab, 'scratch', 'session');
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, 'marker.js');
  fs.writeFileSync(marker, MARKER);
  const credentialVar = /^sk-ant-oat/.test(credential) ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  const sessionEnv = (extra) => {
    const env = L.labEnv(home, { base: baseEnv, platform, extra: Object.assign({ [credentialVar]: credential, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, extra || {}) });
    L.setEnv(env, CREDENTIAL_VAR, null);
    return env;
  };
  const claude = ensureClaude({ lab, env: sessionEnv(), platform, runner });
  rec.fact('claude', claude.problem ? { problem: claude.problem } : { from: claude.from, launch_kind: path.extname(claude.bin).slice(1) || 'no-extension' });
  if (claude.problem) return { status: L.STATUS.error, reason: `no pude medir: ${claude.problem}` };
  const launch = launchOf(claude.bin);
  const version = runner(launch.bin, [...launch.args, '--version'], { env: sessionEnv(), platform, timeoutMs: 60000, cap: 600 });
  rec.fact('claude_version', L.firstLine(version.stdout) || L.firstLine(version.stderr) || null);

  const key = L.pathKey(baseEnv);
  const dirs = String(baseEnv[key] || '').split(path.delimiter).filter(Boolean);
  const hasBash = (d) => ['bash', 'bash.exe', 'sh.exe'].some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch (_) { return false; } });
  const scenarios = [
    { id: 'default', settingsEnv: null, env: {} },
    { id: 'powershell-tool-off', settingsEnv: { CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' }, env: {} },
    { id: 'git-bash-off-path', settingsEnv: null, env: { [key]: dirs.filter((d) => !hasBash(d)).join(path.delimiter) }, note: 'Git sigue instalado en su carpeta: sólo se sacó su bash del PATH (desinstalarlo dejaría a la ejecución sin git)' },
  ];
  const results = [];
  let measured = 0;
  for (const sc of scenarios) {
    const log = path.join(dir, `${sc.id}.jsonl`);
    const repo = path.join(dir, `repo-${sc.id}`);
    fs.rmSync(log, { force: true });
    fs.mkdirSync(repo, { recursive: true });
    L.writeJsonAtomic(path.join(home, '.claude', 'settings.json'), markerSettings(marker, log, sc.settingsEnv));
    const env = sessionEnv(sc.env);
    L.run('git', ['init', '-q', repo], { env, timeoutMs: 30000 });
    process.stdout.write(`session-probe: ${sc.id} — abro una sesión mínima\n`);
    const r = runner(launch.bin, [...launch.args, '-p', PROMPT, '--output-format', 'json', '--max-turns', '8', '--dangerously-skip-permissions'], { cwd: repo, env, platform, timeoutMs: SESSION_TIMEOUT_MS, cap: 3000 });
    let lines = [];
    try { lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { lines = []; }
    const item = { id: sc.id, note: sc.note || null, exit: r.exit, error: r.error, timed_out: r.timed_out, seconds: Math.round(r.ms / 100) / 10, output: r.stdout, stderr: r.stderr, file_created: fs.existsSync(path.join(repo, 'probe-note.txt')) };
    if (lines.length) { Object.assign(item, summarize(lines)); measured++; } else item.not_measured = `la sesión no disparó ningún hook marcador (salió ${r.error || r.exit})`;
    results.push(item);
    rec.fact('scenarios', results);
  }
  const base = results.find((x) => x.id === 'default') || {};
  const off = results.find((x) => x.id === 'powershell-tool-off') || {};
  rec.fact('answers', {
    hook_shell: base.hook_shells || null,
    hook_shell_without_git_bash_in_path: (results.find((x) => x.id === 'git-bash-off-path') || {}).hook_shells || null,
    terminal_tool_names: base.terminal_tool_names || null,
    path_shapes: base.shapes || null,
    bash_matcher_sees_powershell_tool: base.bash_matcher_sees_powershell_tool === undefined ? null : base.bash_matcher_sees_powershell_tool,
    variable_turns_powershell_tool_off: base.powershell_tool_used && off.lines ? !off.powershell_tool_used : null,
  });
  if (!measured) return { status: L.STATUS.error, reason: 'no pude medir: ninguna sesión disparó un hook marcador (ver la salida de cada escenario)' };
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--real-session': 'flag', '--allow-temp': 'flag' });
  if (args.problem || !args.out) { process.stderr.write(`session-probe.js: ${args.problem || 'falta --out <carpeta del reporte>'}\n`); return 2; }
  const credential = process.env[CREDENTIAL_VAR] || null;
  const rec = L.recorder(NAME, path.resolve(args.out), { redact: L.redactor({ secrets: [credential, ...L.secretValues()].filter(Boolean) }) });
  let result;
  if (args['real-session'] && !args.lab) result = { status: L.STATUS.error, reason: 'no pude medir: falta --lab <laboratorio>' };
  else if (args['real-session'] && !fs.existsSync(path.join(path.resolve(args.lab), L.LAB_MARK))) result = { status: L.STATUS.error, reason: `no pude medir: ${args.lab} no tiene la marca del laboratorio` };
  else {
    try { result = measure({ lab: args.lab ? path.resolve(args.lab) : null, realSession: Boolean(args['real-session']), credential, allowTemp: Boolean(args['allow-temp']), rec }); } catch (e) {
      result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
    }
  }
  rec.finish(result.status, result.reason);
  process.stdout.write(`session-probe: ${result.status === L.STATUS.measured ? 'medido' : (result.status === L.STATUS.notMeasured ? `no medido: ${result.reason}` : result.reason)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, CREDENTIAL_VAR, NOT_REQUESTED, EVENTS, MARKER, pathShape, shellOf, summarize, markerSettings, measure };
