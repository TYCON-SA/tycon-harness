#!/usr/bin/env node
'use strict';
/**
 * inventory.js — qué trae la máquina, ANTES de instalar nada (story 8.17, tanda W0 · AC 5 y 11).
 *
 * POR QUÉ EXISTE. El agente Windows de Azure no es una máquina común: trae herramientas que un usuario no tiene y,
 * se espera, corre como administrador. Sin este inventario la medición se cree sola: si el agente trae `jq`, los dos
 * frenos en bash dan verde ahí y rojo en la máquina de un usuario; si corre como administrador, el enlace de archivo
 * funciona ahí y no afuera. Así que lo primero que publica la corrida es qué había.
 *
 * QUÉ ANOTA (sólo lee; corre con el ambiente del agente, no con el del laboratorio):
 *   · todas las ubicaciones, en el orden del PATH, de cada herramienta de `TOOLS`, y su versión;
 *   · si `az` y `claude` son un `.exe` o un `.cmd` (Node no lanza un `.cmd` sin shell);
 *   · `git config --show-origin core.autocrlf`; si el usuario es administrador; si el «modo desarrollador» está prendido;
 *   · las cuatro carpetas de usuario —`$HOME` de PowerShell, `USERPROFILE`, la `HOME` de Git Bash y `os.homedir()`— y
 *     si coinciden;
 *   · qué `bash` aparece primero (el de Git o el lanzador de WSL) y qué trae el bash de Git (`jq`, `timeout`, …).
 *
 * CÓMO FALLA. Una herramienta que no está es un HECHO («no está»), no un error. Un buscador que falla por otra cosa
 * («no pude preguntar») es un error del paso, igual que la falta de `git`, `node` o `pwsh`: sin ellos no hay medición.
 * Ninguna línea dice «no hay» cuando lo que pasó fue «no pude preguntar».
 *
 * Uso: node scripts/tests/windows/inventory.js --out <carpeta del reporte>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lab.js');

const NAME = 'inventory';
const TOOLS = ['git', 'node', 'pwsh', 'powershell', 'bash', 'jq', 'python', 'python3', 'py', 'az', 'claude', 'timeout', 'realpath', 'lsof'];
// Se ubican y no se les pide versión: sólo importa si están.
const LOCATE_ONLY = ['wsl', 'winget', 'cmd', 'where', 'npm'];
const INSIDE_GIT_BASH = ['jq', 'timeout', 'realpath', 'lsof', 'python3', 'python', 'cygpath', 'readlink', 'mktemp', 'flock'];
const VERSION_ARGS = {
  powershell: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  lsof: ['-v'],
};
const VERSION_TIMEOUT_MS = { az: 120000 };
const REQUIRED = (platform) => (L.isWin(platform) ? ['git', 'node', 'pwsh'] : ['git', 'node', 'bash']);

/** El buscador del sistema: `where` en Windows, `which -a` en el resto. Devuelve lo que devolvió, sin interpretarlo. */
function systemFinder(name, { platform = process.platform, env = process.env } = {}) {
  const [bin, args] = L.isWin(platform) ? ['where.exe', [name]] : ['which', ['-a', name]];
  const r = L.run(bin, args, { env, timeoutMs: 20000 });
  return { status: r.exit, stdout: r.stdout, stderr: r.stderr, error: r.error, finder: bin };
}

/**
 * Dónde está una herramienta: `present` con sus ubicaciones en orden, `absent` (el buscador dijo «no encontrado»:
 * código 1 y nada por la salida), o `error` (el buscador falló por otra cosa: no se sabe si está).
 */
function locate(name, { finder = systemFinder, platform = process.platform, env = process.env } = {}) {
  let r;
  try { r = finder(name, { platform, env }); } catch (e) { return { state: 'error', locations: [], reason: `el buscador tiró: ${e.message}` }; }
  if (r && r.error === 'ENOENT') {
    // no hay `where` ni `which` (un contenedor mínimo): se mira el PATH a mano, y se dice
    const locations = L.scanPath(name, { env, platform });
    return { state: locations.length ? 'present' : 'absent', locations, finder: 'path-scan' };
  }
  if (!r || r.error) return { state: 'error', locations: [], reason: `no pude preguntar dónde está ${name}: ${r ? r.error : 'sin respuesta'}` };
  const lines = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const locations = lines.filter((l, i) => lines.indexOf(l) === i);
  if (r.status === 0 && locations.length) return { state: 'present', locations };
  if (r.status === 1 && !locations.length) return { state: 'absent', locations: [] };
  return { state: 'error', locations: [], reason: `no pude preguntar dónde está ${name}: el buscador salió ${r.status}${L.firstLine(r.stderr) ? ` (${L.firstLine(r.stderr)})` : ''}` };
}

function versionOf(name, location, { runner = L.runTool, platform, env }) {
  const r = runner(location, VERSION_ARGS[name] || ['--version'], { platform, env, timeoutMs: VERSION_TIMEOUT_MS[name] || 30000, cap: 600 });
  const text = L.firstLine(r.stdout) || L.firstLine(r.stderr);
  if (r.error) return { text: null, problem: r.timed_out ? 'no contestó en el tiempo dado' : `no arrancó (${r.error})` };
  return { text: text || null, exit: r.exit };
}

/** `exe`, `cmd`, `bat`, `ps1` o `no-extension` (en Windows, un guion que sólo corre bajo un shell). */
function launchKind(location) {
  const ext = path.extname(String(location || '')).toLowerCase();
  return ext ? ext.slice(1) : 'no-extension';
}

function measureHomes({ platform, env, runner, gitBash, homedir, pwsh }) {
  const homes = { node_homedir: homedir(), env_userprofile: env.USERPROFILE || null, env_home: env.HOME || null };
  if (L.isWin(platform)) homes.env_homedrive_homepath = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null;
  const ps = runner(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `${L.PWSH_UTF8}"$HOME|$env:USERPROFILE"`], { platform, env, timeoutMs: 60000, cap: 600 });
  if (ps.error || ps.exit !== 0) homes.pwsh_problem = ps.error ? `pwsh no arrancó (${ps.error})` : `pwsh salió ${ps.exit}: ${L.firstLine(ps.stderr)}`;
  else { const [h, u] = L.firstLine(ps.stdout).split('|'); homes.pwsh_home = h || null; homes.pwsh_userprofile = u || null; }
  if (gitBash && gitBash.path) {
    const gb = runner(gitBash.path, ['-c', 'printf "%s|" "$HOME"; cygpath -w "$HOME" 2>/dev/null || true'], { platform, env, timeoutMs: 60000, cap: 600 });
    if (gb.error || gb.exit !== 0) homes.git_bash_problem = gb.error ? `no arrancó (${gb.error})` : `salió ${gb.exit}: ${L.firstLine(gb.stderr)}`;
    else { const [h, w] = L.firstLine(gb.stdout).split('|'); homes.git_bash_home = h || null; homes.git_bash_home_windows = (w || '').trim() || null; }
  } else homes.git_bash_problem = gitBash ? gitBash.reason : 'sin bash de Git';
  // las cuatro que pide el AC 5, en forma comparable (la de Git Bash, por su forma de Windows si la dio)
  const four = {
    pwsh_home: homes.pwsh_home,
    userprofile: L.isWin(platform) ? homes.env_userprofile : (homes.env_userprofile || homes.env_home),
    git_bash_home: homes.git_bash_home_windows || homes.git_bash_home,
    node_homedir: homes.node_homedir,
  };
  const known = Object.entries(four).filter(([, v]) => v);
  const distinct = [...new Set(known.map(([, v]) => L.comparable(v, platform)))];
  homes.compared = four;
  homes.unknown = Object.keys(four).filter((k) => !four[k]);
  homes.agree = distinct.length === 1 && !homes.unknown.length ? true : (distinct.length > 1 ? false : null);   // null = falta alguna: no se sabe
  return homes;
}

/**
 * Mide. `{ facts, problems }`: `problems` son los «no pude medir» (un buscador que falló, un requisito ausente).
 * Todo lo que toca la máquina entra por parámetro (`finder`, `runner`, `exists`, `homedir`): así se prueba sin ella.
 */
function measure({ platform = process.platform, env = process.env, finder = systemFinder, runner = L.runTool, exists = fs.existsSync, homedir = os.homedir, onFact = () => {} } = {}) {
  const facts = {};
  const problems = [];
  const put = (k, v) => { facts[k] = v; onFact(k, v); return v; };

  put('system', { platform, arch: os.arch(), type: os.type(), release: os.release(), version: typeof os.version === 'function' ? os.version() : null,
    tmpdir: os.tmpdir(), comspec: env.ComSpec || env.COMSPEC || null, pathext: env.PATHEXT || null, shell: env.SHELL || null,
    git_bash_variable: env.CLAUDE_CODE_GIT_BASH_PATH || null, powershell_tool_variable: env.CLAUDE_CODE_USE_POWERSHELL_TOOL || null,
    azure_agent: Boolean(env.TF_BUILD), agent_os: env.AGENT_OS || null, image: env.ImageOS ? `${env.ImageOS} ${env.ImageVersion || ''}`.trim() : null });

  const tools = {};
  for (const name of [...TOOLS, ...LOCATE_ONLY]) {
    const where = locate(name, { finder, platform, env });
    const t = { state: where.state, locations: where.locations };
    if (where.finder) t.finder = where.finder;
    if (where.state === 'error') { t.reason = where.reason; problems.push(where.reason); }
    if (where.state === 'present' && TOOLS.includes(name)) {
      // En Windows una herramienta puede estar dos veces en la misma carpeta: `az` (un guion de shell, sin extensión) y
      // `az.cmd`. PowerShell y cmd corren la que tiene extensión; Node, sin shell, sólo un `.exe`.
      t.launch_kinds = where.locations.map(launchKind);
      const runs = L.isWin(platform) ? (where.locations.find((loc) => launchKind(loc) !== 'no-extension') || where.locations[0]) : where.locations[0];
      t.launch_kind = launchKind(runs);
      // la versión de la que corre; de `bash`, la de cada una: puede haber dos y no son el mismo programa
      const which = name === 'bash' ? where.locations : [runs];
      t.versions = which.map((loc) => Object.assign({ location: loc }, versionOf(name, loc, { runner, platform, env })));
      t.version = t.versions[0].text;
      if (name === 'bash') t.wsl_launcher = where.locations.map((loc) => L.isWslLauncher(loc));
    }
    tools[name] = t;
    put('tools', tools);
  }
  for (const need of REQUIRED(platform)) {
    if (tools[need].state === 'absent') problems.push(`falta ${need} en la máquina: sin él no hay medición`);
  }

  const gitBash = L.findGitBash({ platform, env, gitLocations: tools.git.locations, bashLocations: tools.bash.locations, exists });
  const inside = {};
  if (gitBash.path) {
    const script = INSIDE_GIT_BASH.map((t) => `p=$(command -v ${t} 2>/dev/null); printf '%s=%s\\n' ${t} "$p"`).join('; ');
    const r = runner(gitBash.path, ['-c', script], { platform, env, timeoutMs: 60000 });
    if (r.error || r.exit !== 0) inside.problem = r.error ? `el bash de Git no arrancó (${r.error})` : `el bash de Git salió ${r.exit}: ${L.firstLine(r.stderr)}`;
    else for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) inside[line.slice(0, i)] = line.slice(i + 1).trim() || null; }
  }
  put('git_bash', { path: gitBash.path, from: gitBash.from || null, reason: gitBash.reason || null, tools: inside,
    first_bash_in_path: tools.bash.locations[0] || null, first_bash_is_wsl_launcher: tools.bash.locations.length ? L.isWslLauncher(tools.bash.locations[0]) : null });

  if (tools.git.state === 'present') {
    const r = runner(tools.git.locations[0], ['config', '--show-origin', '--show-scope', '--get-all', 'core.autocrlf'], { platform, env, timeoutMs: 30000, cap: 1200 });
    // `git config --get` sale 1 cuando la clave no está en ningún archivo: eso es un hecho («sin fijar»)
    if (r.error || (r.exit !== 0 && r.exit !== 1)) { put('autocrlf', { problem: r.error ? `git no arrancó (${r.error})` : `git config salió ${r.exit}: ${L.firstLine(r.stderr)}` }); problems.push('no pude leer core.autocrlf'); }
    else {
      const entries = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      put('autocrlf', { set: entries.length > 0, entries, effective: entries.length ? entries[entries.length - 1].split(/\s+/).pop() : null });
    }
  }

  const pwsh = tools.pwsh.locations[0] || 'pwsh';
  if (L.isWin(platform)) {
    const adm = runner(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { platform, env, timeoutMs: 60000, cap: 600 });
    put('administrator', adm.error || adm.exit !== 0 ? { known: false, problem: adm.error || `pwsh salió ${adm.exit}: ${L.firstLine(adm.stderr)}` } : { known: true, value: /^true$/i.test(L.firstLine(adm.stdout)) });
    const dev = runner('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock', '/v', 'AllowDevelopmentWithoutDevLicense'], { platform, env, timeoutMs: 30000, cap: 600 });
    // `reg query` sale 1 cuando la clave o el valor no están: el modo está apagado, y es un hecho
    if (dev.error) put('developer_mode', { known: false, problem: `reg no arrancó (${dev.error})` });
    else if (dev.exit === 0) put('developer_mode', { known: true, value: /0x1\b/.test(dev.stdout) });
    else if (dev.exit === 1) put('developer_mode', { known: true, value: false, detail: 'la clave del registro no está' });
    else put('developer_mode', { known: false, problem: `reg query salió ${dev.exit}: ${L.firstLine(dev.stderr)}` });
  } else {
    put('administrator', { known: true, value: typeof process.getuid === 'function' && process.getuid() === 0 });
    put('developer_mode', { known: false, problem: 'no aplica fuera de Windows' });
  }

  put('homes', measureHomes({ platform, env, runner, gitBash, homedir, pwsh }));
  return { facts, problems };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--out': 'value' });
  if (args.problem || !args.out) { process.stderr.write(`inventory.js: ${args.problem || 'falta --out <carpeta del reporte>'}\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out), { redact: L.redactor({ secrets: L.secretValues() }) });
  let result;
  try { result = measure({ onFact: (k, v) => rec.fact(k, v) }); } catch (e) {
    rec.finish(L.STATUS.error, `no pude medir: el inventario tiró: ${e.message}`);
    process.stdout.write(`inventory: error — ${e.message}\n`);
    return 0;
  }
  const { facts, problems } = result;
  for (const [name, t] of Object.entries(facts.tools)) {
    const text = t.state === 'present' ? `${t.locations[0]}${t.version ? ` · ${t.version}` : ''}${t.locations.length > 1 ? ` (+${t.locations.length - 1})` : ''}` : (t.state === 'absent' ? 'no está' : `no pude preguntar: ${t.reason}`);
    process.stdout.write(`inventory: ${name.padEnd(10)} ${text}\n`);
  }
  if (problems.length) rec.finish(L.STATUS.error, `no pude medir: ${problems.join(' · ')}`);
  else rec.finish(L.STATUS.measured);
  process.stdout.write(`inventory: ${problems.length ? `error — ${problems.join(' · ')}` : 'medido'}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, TOOLS, systemFinder, locate, launchKind, measure };
