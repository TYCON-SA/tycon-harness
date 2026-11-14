#!/usr/bin/env node
'use strict';
if (require.main === module) { try { require('../lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
/**
 * windows-console-probe.js — ¿cuántas ventanas de consola abre cada gancho en esta máquina Windows?
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * En Windows, después de escribirle a Claude, a veces aparecen varias ventanas de consola seguidas. Todo lo que el arnés
 * lanza desde Node ya pide la ventana oculta (scripts/tests/hidden-window.test.js), así que lo que queda se ve sólo en la
 * máquina: un ayudante de git, un gancho de un plugin o la forma en que la herramienta lanza cada gancho. Este programa lo
 * mide en la máquina de quien lo ve, con un solo comando, y deja un informe con cuántas ventanas abrió cada gancho.
 *
 * ── QUÉ HACE ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *   1. Lee los ganchos de «al mandar un mensaje» (UserPromptSubmit), «al cerrar el turno» (Stop) y «después de cada
 *      herramienta» (PostToolUse): los de ~/.claude/settings.json, los de .claude/settings.json y
 *      .claude/settings.local.json del repo, y los de los plugins prendidos.
 *   2. Prende el vigilante (windows-console-watch.ps1), que anota cada ventana de consola que se muestra, aunque dure un
 *      instante.
 *   3. Control: lanza a propósito un programa que tiene que abrir una ventana. Si el vigilante no la ve, la medición está
 *      ciega en esta máquina y el informe dice NO MEDIDO, nunca «0 ventanas».
 *   4. Dispara cada gancho, de a uno, con el texto exacto de su `command`, por el bash de Git y SIN consola (como lo
 *      lanza la extensión de VS Code), con una entrada de mentira de su evento y una sesión de mentira.
 *   5. Además prueba git hablando con la red (`git ls-remote origin` del repo, sin pedir clave), que es lo que hacen
 *      algunos ganchos cada tanto.
 *   6. Escribe el informe: por gancho, cuántas ventanas se vieron mientras corría y qué programa las abrió.
 *
 * ── LO QUE NO TOCA ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * No cambia la instalación: no escribe settings, no corre el instalador ni actualiza el arnés. A los ganchos les pasa
 * TYCON_NO_AUTOINSTALL=1, TYCON_GUIDES_HEAL=0 (la reparación del clon, que actualiza el arnés) y TYCON_OFFICE_LINK=0 (la
 * puesta al día de la capa del equipo); el informe lo dice. Lo que sí queda es lo que deja cualquier gancho para una
 * sesión: el estado de una sesión de mentira (`probe-ventanas-…`), que no es la tuya.
 *
 * Uso:
 *   node "$HOME/.tycon/harness/scripts/tools/windows-console-probe.js" [--repo <carpeta>] [--rounds N] [--no-plugins] [--json]
 *   --repo      el repo donde trabajás (por defecto, la carpeta actual): los ganchos corren ahí.
 *   --rounds   cuántas veces se dispara la lista entera (por defecto 2: algunos ganchos trabajan sólo la primera vez).
 *   --no-plugins  no dispara los ganchos de los plugins.
 * Sale 0 con el informe escrito; 2 si no se pudo medir (sin Windows, sin el bash de Git, sin PowerShell o vigilante ciego).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EVENTS = ['UserPromptSubmit', 'Stop', 'PostToolUse'];
const EVENT_WORDS = { UserPromptSubmit: 'al mandar un mensaje', Stop: 'al cerrar el turno', PostToolUse: 'después de una herramienta' };
const HOOK_TIMEOUT_MS = 60000;   // el tope por defecto de un gancho en Claude Code
const SETTLE_MS = 1500;          // lo que se espera después de cada gancho a que Windows muestre (o no) una ventana
const READY_MS = 20000;
// lo que se apaga para no cambiar la instalación mientras se mide
const QUIET_ENV = { TYCON_NO_AUTOINSTALL: '1', TYCON_GUIDES_HEAL: '0', TYCON_OFFICE_LINK: '0' };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/** Los ganchos de los tres eventos de un objeto de settings (o de un hooks.json de plugin), con su origen. */
function hooksOf(settings, source, extraEnv = {}) {
  const out = [];
  const hooks = settings && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of EVENTS) {
    for (const entry of Array.isArray(hooks[event]) ? hooks[event] : []) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || h.type && h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) continue;
        out.push({ event, matcher: typeof entry.matcher === 'string' ? entry.matcher : '', command: h.command, async: h.async === true, source, env: extraEnv });
      }
    }
  }
  return out;
}

/** Los plugins prendidos con su carpeta instalada: [{ id, root }]. */
function enabledPlugins(home, settingsList) {
  const enabled = new Set();
  for (const s of settingsList) for (const [id, on] of Object.entries((s && s.enabledPlugins) || {})) if (on === true) enabled.add(id);
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const table = installed && installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const out = [];
  for (const id of [...enabled].sort()) {
    const copies = Array.isArray(table[id]) ? table[id] : [];
    const root = copies.map((c) => c && c.installPath).find((p) => typeof p === 'string' && p);
    if (root) out.push({ id, root });
  }
  return out;
}

/** La lista de ganchos a disparar, en el orden en que los corre la herramienta (usuario, repo, local, plugins). */
function collectHooks({ home, repo, plugins = true }) {
  const userSettings = readJson(path.join(home, '.claude', 'settings.json'));
  const projectSettings = readJson(path.join(repo, '.claude', 'settings.json'));
  const localSettings = readJson(path.join(repo, '.claude', 'settings.local.json'));
  const list = [
    ...hooksOf(userSettings, 'usuario'),
    ...hooksOf(projectSettings, 'repo'),
    ...hooksOf(localSettings, 'repo (local)'),
  ];
  if (plugins) {
    for (const p of enabledPlugins(home, [userSettings, projectSettings, localSettings])) {
      list.push(...hooksOf(readJson(path.join(p.root, 'hooks', 'hooks.json')), `plugin ${p.id}`, { CLAUDE_PLUGIN_ROOT: p.root }));
    }
  }
  return list;
}

/** La herramienta que representa un matcher: la primera alternativa que no es un patrón; sin matcher, Bash. */
function toolFor(matcher) {
  const first = String(matcher || '').split('|').map((s) => s.trim()).find((s) => /^[A-Za-z_][\w]*$/.test(s));
  return first || 'Bash';
}

/** La entrada de mentira de un gancho: lo mínimo de su evento, con la sesión y la conversación de la medición. */
function inputFor(hook, { sessionId, repo, transcript }) {
  const base = { hook_event_name: hook.event, session_id: sessionId, cwd: repo, transcript_path: transcript };
  if (hook.event === 'UserPromptSubmit') return { ...base, prompt: 'seguí con lo de ayer' };
  if (hook.event === 'Stop') return { ...base, stop_hook_active: false };
  return {
    ...base,
    tool_name: toolFor(hook.matcher),
    tool_input: { command: 'git status', file_path: path.join(repo, 'README.md') },
    tool_response: { stdout: '', stderr: '', exit_code: 0 },
  };
}

/** Un nombre corto para el informe: el guion que nombra el comando, o el comando recortado. */
function labelOf(command) {
  const m = String(command).match(/["']?([^"'\s]+\.(?:js|sh|ps1|py|cmd|bat))["']?/gi);
  const last = m ? m[m.length - 1].replace(/["']/g, '') : String(command);
  return last.replace(/\$\{CLAUDE_PLUGIN_ROOT\}[\\/]/, '').split(/[\\/]/).slice(-2).join('/').slice(0, 80);
}

/**
 * Reparte las ventanas vistas entre los disparos: cada ventana va al disparo en cuyo tramo [inicio, fin + espera) cayó.
 * Las que no caen en ningún tramo quedan aparte («fuera de todo gancho»).
 */
function attribute(windows, runs, settleMs = SETTLE_MS) {
  const byRun = runs.map((r) => ({ ...r, windows: [] }));
  const loose = [];
  for (const w of windows) {
    const r = byRun.find((x) => w.t >= x.start && w.t < x.end + settleMs);
    if (r) r.windows.push(w); else loose.push(w);
  }
  return { runs: byRun, loose };
}

/** Lo que dice el vigilante: las ventanas y si estuvo listo. */
function parseEvents(text) {
  const out = { ready: false, error: null, windows: [] };
  // PowerShell 5.1 escribe con BOM la línea del error si el archivo era nuevo
  for (const line of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (e.ready === true) out.ready = true;
    else if (e.ready === false) out.error = e.error || 'el vigilante no arrancó';
    else if (typeof e.t === 'number' && e.class) out.windows.push(e);
  }
  return out;
}

const who = (w) => `${w.name || '?'} (pid ${w.pid})${w.parentName ? `, lo abrió ${w.parentName} (pid ${w.parent})` : ''}`;

/** El informe en castellano: el veredicto arriba, la tabla por gancho y lo que no se pudo atribuir. */
function renderReport(r) {
  const lines = [`# Ventanas de consola por gancho — ${r.machine} — ${r.at}`, ''];
  if (!r.measured) {
    lines.push(`**NO MEDIDO**: ${r.why}`, '', 'Sin medición no se puede decir que los ganchos no abren ventanas.');
    return lines.join('\n') + '\n';
  }
  const withWindows = r.runs.filter((x) => x.windows.length);
  const total = r.runs.reduce((n, x) => n + x.windows.length, 0);
  lines.push(withWindows.length
    ? `**${total} ventana(s) en ${withWindows.length} disparo(s)** de ${r.runs.length}. El control abrió ${r.control.windows} ventana(s): la vigilancia ve.`
    : `**Ninguna ventana** en ${r.runs.length} disparo(s). El control abrió ${r.control.windows} ventana(s): la vigilancia ve, así que el cero es real.`);
  lines.push('', `Forma de lanzar cada gancho: bash de Git (${r.bash}), sin consola, como la extensión de VS Code.`,
    `Apagado para no cambiar la instalación: ${Object.keys(QUIET_ENV).join(', ')}.`, '',
    '| Vuelta | Cuándo | Gancho | Origen | Ventanas | Quién las abrió | Duró |', '|---|---|---|---|---|---|---|');
  for (const x of r.runs) {
    const owners = [...new Set(x.windows.map(who))].join('; ') || '—';
    lines.push(`| ${x.round} | ${x.when} | ${x.label} | ${x.source} | ${x.windows.length} | ${owners} | ${x.ms} ms${x.timedOut ? ' (cortado)' : ''} |`);
  }
  if (r.loose.length) {
    lines.push('', `Ventanas fuera de todo disparo (${r.loose.length}): pueden ser de un proceso de fondo de un gancho anterior.`);
    for (const w of r.loose) lines.push(`- ${new Date(w.t).toISOString()} · ${who(w)} · ${w.class}${w.title ? ` · «${w.title}»` : ''}`);
  }
  lines.push('', 'El detalle de cada ventana (hora, clase, título, proceso y padre) está en report.json, al lado de este archivo.');
  return lines.join('\n') + '\n';
}

/** Un proceso SIN consola (como un gancho lanzado por la extensión): devuelve { ms, timedOut, code }. */
function fireWithoutConsole(bin, args, { cwd, env, input = '', timeoutMs = HOOK_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try { child = spawn(bin, args, { cwd, env, detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }); } catch (e) { resolve({ ms: 0, timedOut: false, code: null, error: e.message }); return; }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) { /* ya no estaba */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ms: Date.now() - start, timedOut, code: null, error: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ms: Date.now() - start, timedOut, code }); });
    child.stdin.on('error', () => { /* el gancho no leyó la entrada */ });
    child.stdin.end(input);
  });
}

function findPowerShell(env) {
  const root = env.SystemRoot || 'C:\\Windows';
  const candidates = [path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  return candidates.find((p) => fs.existsSync(p)) || 'powershell.exe';
}

function parseArgs(argv) {
  const o = { repo: process.cwd(), rounds: 2, plugins: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = path.resolve(argv[++i] || '.');
    else if (a === '--rounds') o.rounds = Math.max(1, Math.min(5, Number(argv[++i]) || 2));
    else if (a === '--no-plugins') o.plugins = false;
    else if (a === '--json') o.json = true;
    else throw new Error(`no conozco la opción ${a}`);
  }
  return o;
}

async function main(argv = process.argv.slice(2), { env = process.env, home = os.homedir(), platform = process.platform, write = (s) => process.stdout.write(s) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { write(`windows-console-probe: ${e.message}\n`); return 2; }
  if (platform !== 'win32') { write('windows-console-probe: esto mide ventanas de Windows; en esta máquina no hay nada que medir.\n'); return 2; }

  const { stateDir } = require(path.join(__dirname, '..', 'setup', 'harness', 'tycon-home.js'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(stateDir(home), 'windows-console-probe', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const report = { machine: os.hostname(), at: new Date().toISOString(), repo: o.repo, measured: false, why: null, runs: [], loose: [], control: null, bash: null };
  const finish = (code) => {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dir, 'report.md'), renderReport(report));
    write(o.json ? `${JSON.stringify(report)}\n` : `${renderReport(report)}\nInforme: ${path.join(dir, 'report.md')}\n`);
    return code;
  };

  const bash = require(path.join(__dirname, '..', 'lib', 'git-bash.js')).findGitBash({ env });
  if (!bash.path) { report.why = `no encontré el bash de Git (${bash.reason})`; return finish(2); }
  report.bash = bash.path;

  // el vigilante
  const events = path.join(dir, 'events.jsonl');
  const stop = path.join(dir, 'stop');
  const watch = spawn(findPowerShell(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-console-watch.ps1'), '-Out', events, '-StopFile', stop],
    { windowsHide: true, stdio: 'ignore' });
  watch.on('error', () => { /* se ve abajo: no llega la línea de listo */ });
  const readEvents = () => { try { return parseEvents(fs.readFileSync(events, 'utf8')); } catch (_) { return parseEvents(''); } };
  const until = Date.now() + READY_MS;
  while (!readEvents().ready && !readEvents().error && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  const stopWatch = async () => { fs.writeFileSync(stop, ''); const end = Date.now() + 5000; while (watch.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };
  if (!readEvents().ready) { report.why = `el vigilante de ventanas no arrancó (${readEvents().error || 'sin respuesta de PowerShell en 20 s'})`; await stopWatch(); return finish(2); }

  const runs = [];
  const shot = async (meta, bin, args, opts) => {
    const start = Date.now();
    const r = await fireWithoutConsole(bin, args, opts);
    const end = Date.now();
    await new Promise((res) => setTimeout(res, SETTLE_MS));
    runs.push({ ...meta, start, end, ms: r.ms, timedOut: r.timedOut, code: r.code, error: r.error || null });
  };

  // control: un node sin consola que lanza un programa de consola sin pedir la ventana oculta → tiene que verse
  const control = "require('child_process').spawn('cmd.exe', ['/c', 'ping -n 3 127.0.0.1 >nul'], { stdio: 'ignore' })";
  await shot({ round: 0, when: 'control', label: 'control: tiene que abrir una ventana', source: 'medición' }, process.execPath, ['-e', control], { cwd: o.repo, env });
  await new Promise((res) => setTimeout(res, 2500));

  const transcript = path.join(dir, 'fake-transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const sessionId = `probe-ventanas-${stamp}`;
  const hooks = collectHooks({ home, repo: o.repo, plugins: o.plugins });
  const hookEnv = (h) => Object.assign({}, env, QUIET_ENV, h.env, { CLAUDE_PROJECT_DIR: o.repo });
  for (let round = 1; round <= o.rounds; round++) {
    for (const h of hooks) {
      const input = JSON.stringify(inputFor(h, { sessionId, repo: o.repo, transcript }));
      const command = h.env.CLAUDE_PLUGIN_ROOT ? h.command.split('${CLAUDE_PLUGIN_ROOT}').join(h.env.CLAUDE_PLUGIN_ROOT.replace(/\\/g, '/')) : h.command;
      await shot({ round, when: `${EVENT_WORDS[h.event]}${h.event === 'PostToolUse' ? ` (${toolFor(h.matcher)})` : ''}`, label: labelOf(h.command), source: h.source, command: h.command },
        bash.path, ['-c', command], { cwd: o.repo, env: hookEnv(h), input });
    }
    // git hablando con la red, como lo hacen algunos ganchos cada tanto: sin pedir clave
    const net = "require('child_process').spawnSync('git', ['ls-remote', '--heads', 'origin'], { windowsHide: true, stdio: 'ignore', timeout: 15000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }) })";
    await shot({ round, when: 'git a la red', label: 'git ls-remote origin (desde un gancho)', source: 'medición' }, process.execPath, ['-e', net], { cwd: o.repo, env: hookEnv({ env: {} }) });
  }
  await new Promise((res) => setTimeout(res, 3000));
  await stopWatch();

  const seen = readEvents();
  const split = attribute(seen.windows, runs);
  const controlRun = split.runs.find((x) => x.when === 'control');
  report.control = { windows: controlRun ? controlRun.windows.length : 0 };
  report.runs = split.runs.filter((x) => x.when !== 'control');
  report.loose = split.loose;
  if (!report.control.windows) {
    report.why = 'el control no abrió ninguna ventana que el vigilante viera: en esta máquina la vigilancia está ciega (¿sesión sin escritorio?)';
    return finish(2);
  }
  report.measured = true;
  return finish(0);
}

if (require.main === module) main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`windows-console-probe: ${e && e.stack || e}\n`); process.exitCode = 2; });

module.exports = { hooksOf, collectHooks, enabledPlugins, toolFor, inputFor, labelOf, attribute, parseEvents, renderReport, parseArgs, main, QUIET_ENV };
