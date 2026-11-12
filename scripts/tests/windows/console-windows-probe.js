'use strict';
/**
 * console-windows-probe.js — ¿el arranque desprendido abre ventanas de consola en Windows?
 *
 * ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * En Windows, `harness.js startup` corre desprendido
 * (DETACHED_PROCESS: sin consola) y cada programa de consola que lance sin `windowsHide` —git, pwsh, node— recibe una
 * consola nueva y VISIBLE: 20 o más ventanas por inicio de sesión. El arreglo es el relevo de detach.js (el desprendido
 * lanza al que trabaja sin desprender y con la ventana oculta, y lo espera) más `windowsHide` en todo lo que el programa
 * lanza. Esta sonda MIDE eso en el agente Windows: lanza por `runDetached` un trabajador que a
 * su vez lanza un `node` de 6 s SIN pedir ventana oculta (como lo haría sources.js), y mira con PowerShell si ese nieto
 * quedó con ventana (`MainWindowHandle ≠ 0`).
 *
 * Dos corridas: con el relevo (lo de siempre en Windows) → ninguna ventana; y el CONTROL con el relevo apagado
 * (`TYCON_STARTUP_SHIM=0`, el comportamiento sin relevo) → tiene que verse una ventana. Si el control tampoco la ve, la
 * medición está ciega en este agente (sesión sin escritorio) y el paso sale NO MEDIDO, nunca verde.
 *
 * Fuera de Windows no mide nada (no medido). Uso: node scripts/tests/windows/console-windows-probe.js --lab <laboratorio> --out <carpeta del reporte>
 */
const fs = require('fs');
const path = require('path');
const L = require('./lab.js');

const NAME = 'console-windows';
const DETACH = path.join(__dirname, '..', '..', 'setup', 'harness', 'detach.js');
const say = (s) => process.stdout.write(`${s}\n`);
const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* nada */ } };

/** El trabajador: adopta la corrida desprendida y lanza un node de 6 s SIN windowsHide; anota el pid del nieto. */
function writeWorker(dir) {
  const script = path.join(dir, 'worker.js');
  fs.writeFileSync(script, [
    "'use strict';",
    `const D = require(${JSON.stringify(DETACH)});`,
    "if (!D.adoptDetachedRun()) { process.exit(3); }",
    "const { spawn } = require('child_process');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: ['ignore', 'pipe', 'pipe'] });",
    "require('fs').writeFileSync(process.argv[2], String(g.pid));",
    "g.on('exit', () => { D.writeResult(0, []); process.exit(0); });",
  ].join('\n'));
  return script;
}

/**
 * Las ventanas de consola VISIBLES del escritorio, con PowerShell (EnumWindows + IsWindowVisible + GetClassName): las de
 * conhost («ConsoleWindowClass») y las de Windows Terminal («CASCADIA_HOSTING_WINDOW_CLASS»). En Windows 11 la consola
 * nueva la abre Windows Terminal, y entonces `MainWindowHandle` del programa es 0 aunque la ventana esté a la vista: por
 * eso se cuentan las ventanas, antes y durante, además de mirar el handle. Devuelve el conteo o null si no se pudo.
 */
function consoleWindowCount(env) {
  const ps = L.scanPath('pwsh', { env })[0] || L.scanPath('powershell', { env })[0];
  if (!ps) return null;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class W { public delegate bool EnumProc(IntPtr h, IntPtr l); [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc p, IntPtr l); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h); [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); public static int Count() { int c = 0; EnumWindows((h, l) => { if (IsWindowVisible(h)) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); var k = sb.ToString(); if (k == \"ConsoleWindowClass\" || k == \"CASCADIA_HOSTING_WINDOW_CLASS\") c++; } return true; }, IntPtr.Zero); return c; } }'",
    '[W]::Count()',
  ].join('; ');
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env, timeoutMs: 60000 });
  if (r.exit !== 0) return null;
  const n = Number(String(r.stdout).trim().split(/\r?\n/).pop());
  return Number.isFinite(n) ? n : null;
}

/** La ventana del proceso `pid`, con PowerShell: { handle, raw } o null si no se pudo preguntar. */
function windowOf(pid, env) {
  const ps = L.scanPath('pwsh', { env })[0] || L.scanPath('powershell', { env })[0];
  if (!ps) return null;
  const r = L.run(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle`], { env, timeoutMs: 30000 });
  if (r.exit !== 0) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? { handle: n, raw: String(r.stdout).trim() } : null;
}

/** Una corrida: lanza el trabajador por runDetached con `shim` prendido o apagado y mide la ventana del nieto. */
function runOnce(dir, label, shim, env) {
  const D = require(DETACH);
  const pidFile = path.join(dir, `${label}.pid`);
  const resultFile = path.join(dir, `${label}.result.json`);
  fs.rmSync(pidFile, { force: true });
  const before = consoleWindowCount(env);
  const r = D.runDetached({ script: writeWorker(dir), args: [pidFile], env: Object.assign({}, env, { TYCON_STARTUP_SHIM: shim ? '1' : '0' }), resultFile, waitMs: 400, startWaitMs: 10000 });
  if (!r) return { problem: 'no pude lanzar el desprendido' };
  const until = Date.now() + 10000;
  while (!fs.existsSync(pidFile) && Date.now() < until) wait(100);
  if (!fs.existsSync(pidFile)) return { problem: `el trabajador no anotó el pid del nieto en 10 s (desprendido pid ${r.pid})` };
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  wait(1500);   // que Windows termine de crear (o no) la ventana
  const w = windowOf(pid, env);
  const during = consoleWindowCount(env);
  // dejar que el nieto termine y el resultado llegue (así no quedan procesos del laboratorio vivos)
  const end = Date.now() + 15000;
  while (!fs.existsSync(resultFile) && !fs.existsSync(resultFile + '.gone') && Date.now() < end) wait(200);
  const newWindows = before === null || during === null ? null : Math.max(0, during - before);
  // «se ve una ventana» = el handle del programa no es 0 (conhost) o aparecieron ventanas de consola nuevas (Windows Terminal)
  const visible = (w && w.handle !== 0) || (newWindows !== null && newWindows > 0);
  return { pid, window: w, consoleWindows: { before, during, new: newWindows }, visible, detachedPid: r.pid };
}

/**
 * Un repo de laboratorio con `branches` ramas (la mitad con un commit sin subir) y su remoto pelado: lo que el aviso de
 * trabajo sin subir recorre. Devuelve su ruta, o null si git no anduvo.
 */
function toyRepo(dir, branches, env) {
  const bare = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  const g = (cwd, args) => L.run('git', ['-c', 'maintenance.auto=false', ...args], { cwd, env: Object.assign({}, env, { GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com', GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' }), timeoutMs: 60000 }).exit === 0;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (!g(dir, ['init', '-q', '--bare', bare]) || !g(dir, ['clone', '-q', bare, repo])) return null;
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  if (!g(repo, ['checkout', '-q', '-b', 'main']) || !g(repo, ['add', '-A']) || !g(repo, ['commit', '-qm', 'base']) || !g(repo, ['push', '-q', 'origin', 'main'])) return null;
  for (let i = 1; i <= branches; i++) {
    if (!g(repo, ['checkout', '-q', '-b', `b${i}`, 'main'])) return null;
    if (i % 2 === 0) { fs.writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`); if (!g(repo, ['add', '-A']) || !g(repo, ['commit', '-qm', `c${i}`])) return null; }
  }
  return g(repo, ['checkout', '-q', 'main']) ? repo : null;
}

/**
 * El aviso de trabajo sin subir corriendo en un proceso SIN consola (desprendido, sin relevo): es lo que pasa cuando la
 * herramienta lanza los ganchos sin consola. Escanea el repo una y otra vez durante 6 s, para que una ventana, si la
 * abriera, esté a la vista cuando se cuentan. Cada git que lanza tiene que ir con la ventana oculta: 0 ventanas nuevas.
 */
function runHookWithoutConsole(dir, repo, env) {
  const D = require(DETACH);
  const hook = path.join(__dirname, '..', '..', 'hooks', 'unpushed-work-notice.js');
  const script = path.join(dir, 'hook-worker.js');
  fs.writeFileSync(script, [
    "'use strict';",
    `const D = require(${JSON.stringify(DETACH)});`,
    'if (!D.adoptDetachedRun()) { process.exit(3); }',
    `process.argv = [process.argv[0], ${JSON.stringify(hook)}, '--scan', ${JSON.stringify(repo)}];`,
    'const end = Date.now() + 6000;',
    `while (Date.now() < end) { delete require.cache[require.resolve(${JSON.stringify(hook)})]; require(${JSON.stringify(hook)}); }`,
    'D.writeResult(0, []);',
  ].join('\n'));
  const resultFile = path.join(dir, 'hook.result.json');
  const before = consoleWindowCount(env);
  const r = D.runDetached({ script, args: [], env: Object.assign({}, env, { TYCON_STARTUP_SHIM: '0' }), resultFile, waitMs: 400, startWaitMs: 10000 });
  if (!r) return { problem: 'no pude lanzar el aviso desprendido' };
  wait(3000);
  const during = consoleWindowCount(env);
  const end = Date.now() + 20000;
  while (!fs.existsSync(resultFile) && !fs.existsSync(resultFile + '.gone') && Date.now() < end) wait(200);
  const newWindows = before === null || during === null ? null : Math.max(0, during - before);
  return { consoleWindows: { before, during, new: newWindows }, detachedPid: r.pid };
}

function measure({ lab, out, platform = process.platform, baseEnv = process.env, rec }) {
  if (platform !== 'win32') return { status: L.STATUS.notMeasured, reason: 'sólo mide en Windows: las ventanas de consola son de ahí' };
  const dir = path.join(lab, 'console-windows');
  fs.mkdirSync(dir, { recursive: true });
  const env = Object.assign({}, baseEnv);
  const control = runOnce(dir, 'control', false, env);
  if (control.problem) return { status: L.STATUS.error, reason: `control: ${control.problem}` };
  rec.fact('control_without_shim', control);
  if (!control.window && control.consoleWindows.new === null) return { status: L.STATUS.error, reason: 'no pude preguntarle a PowerShell por las ventanas' };
  if (!control.visible) {
    // sin escritorio no hay ventanas que ver: la medición no distingue nada
    return { status: L.STATUS.notMeasured, reason: 'el control (sin relevo) tampoco muestra ventana: este agente no tiene escritorio donde verlas, la medición está ciega' };
  }
  const fixed = runOnce(dir, 'shim', true, env);
  if (fixed.problem) return { status: L.STATUS.error, reason: `con relevo: ${fixed.problem}` };
  rec.fact('with_shim', fixed);
  if (!fixed.window && fixed.consoleWindows.new === null) return { status: L.STATUS.error, reason: 'con relevo: no pude preguntarle a PowerShell por las ventanas' };
  if (fixed.visible) rec.finding('console-windows:visible-with-shim', 'startup', `con el relevo, el programa lanzado desde el arranque desprendido sigue abriendo ventana (handle ${fixed.window ? fixed.window.handle : '?'}, ventanas de consola nuevas: ${fixed.consoleWindows.new})`, 'L', { severity: 'breaks' });
  // el aviso de trabajo sin subir, sin consola: sus git no abren ventanas (el control de arriba ya dijo que se ven)
  const repo = toyRepo(path.join(dir, 'hook-repo'), 20, env);
  if (!repo) return { status: L.STATUS.error, reason: 'aviso sin consola: no pude armar el repo de laboratorio' };
  const hook = runHookWithoutConsole(dir, repo, env);
  if (hook.problem) return { status: L.STATUS.error, reason: `aviso sin consola: ${hook.problem}` };
  rec.fact('hook_without_console', hook);
  if (hook.consoleWindows.new === null) return { status: L.STATUS.error, reason: 'aviso sin consola: no pude contar las ventanas' };
  if (hook.consoleWindows.new > 0) rec.finding('console-windows:hook-opens-window', 'hooks', `el aviso de trabajo sin subir, corriendo sin consola, abrió ${hook.consoleWindows.new} ventana(s) de consola: algún git que lanza va sin windowsHide`, 'L', { severity: 'breaks' });
  return { status: L.STATUS.measured, reason: null };
}

function main(argv) {
  const args = L.parseArgs(argv, { '--lab': 'value', '--out': 'value', '--allow-temp': 'flag' });
  if (args.problem || !args.lab || !args.out) { process.stderr.write(`console-windows-probe.js: ${args.problem || 'faltan --lab <laboratorio> y --out <carpeta del reporte>'}\n`); return 2; }
  const lab = path.resolve(args.lab);
  if (!fs.existsSync(path.join(lab, L.LAB_MARK))) { process.stderr.write(`console-windows-probe.js: ${lab} no tiene la marca del laboratorio (${L.LAB_MARK}): no mido ni escribo nada\n`); return 2; }
  const rec = L.recorder(NAME, path.resolve(args.out));
  let result;
  try { result = measure({ lab, out: path.resolve(args.out), rec }); } catch (e) {
    result = { status: L.STATUS.error, reason: `no pude medir: el paso tiró: ${e.message}` };
  }
  rec.finish(result.status, result.reason);
  say(`${NAME}: ${result.status === L.STATUS.measured ? `medido — ${rec.step.findings.length} hallazgo(s)` : result.reason}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { NAME, measure, toyRepo, runHookWithoutConsole };
