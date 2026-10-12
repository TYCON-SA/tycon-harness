'use strict';
/**
 * lib/portable-tools.js — buscar una herramienta y lanzar `bash` igual en Mac, Linux y Windows (story 8.17 del arnés,
 * tanda W6 · AC 48).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 *   · `pipeline.js tooling-expected` buscaba cada herramienta con la ruta fija `/usr/bin/which`. En Windows ese
 *     programa no existe: todas salían «no está», también las instaladas, y el pipeline mandaba a instalar lo que ya
 *     estaba. `findBinary()` busca con `where` en Windows y con `which` —por el PATH, sin ruta fija— en el resto.
 *   · `marker.js run-check <check> -- bash …` lanzaba `bash` por su nombre. En Windows el primero del PATH puede ser
 *     el lanzador de WSL (abre una distribución de Linux que no ve una ruta `C:/…`, o que no está instalada).
 *     `runCheckLaunch()` lo cambia por el bash que devuelve `findGitBash()` del arnés (`scripts/lib/git-bash.js`, la
 *     única búsqueda del bash de Git). Si no hay, NO se lanza otro bash: vuelve el motivo, y el check sale rojo con él.
 *   · En Windows `npx` (y `npm`, `jest`…) es un `npx.cmd`, que Node no lanza sin shell: vitest y jest nunca corrían y
 *     el gate daba un rojo con totales vacíos (pase adversarial de la W6). `runCheckLaunch()` lo lanza por el bash de
 *     Git, y `canLaunch()` —lo que mira test-gate.sh antes de la salida 5— usa la misma búsqueda.
 *
 * ── CÓMO SE PRUEBA SIN WINDOWS ──────────────────────────────────────────────────────────────────
 * Nada lee `process.platform` por su cuenta: la plataforma, el `execFileSync`, el disco y la búsqueda del bash se
 * inyectan (`ctx`). `tests/tooling-portable.test.js` recorre cada rama con Windows de mentira.
 */
const fs = require('fs');
const path = require('path');

/** El buscador de programas de cada sistema: `where` en Windows, `which` en el resto. */
function whichCommand(platform = process.platform) {
  return platform === 'win32' ? 'where' : 'which';
}

/** Una variable del entorno; en Windows sin distinguir mayúsculas (`Path`, `PATH`). */
function envGet(env, name, windows) {
  if (!env) return undefined;
  if (!windows) return env[name];
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase() && env[x]);
  return k === undefined ? undefined : env[k];
}

/** Las extensiones de PATHEXT, en minúsculas y en su orden (`.com`, `.exe`, `.bat`, `.cmd` si no está). */
function pathExts(env) {
  const raw = envGet(env, 'PATHEXT', true) || '.COM;.EXE;.BAT;.CMD';
  return String(raw).split(';').map((e) => e.trim().toLowerCase()).filter((e) => /^\.[a-z0-9]+$/.test(e));
}

const fileExists = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } };

/**
 * Dónde está `cmd`: la primera ubicación que da el buscador del sistema, o `null`. Una ruta absoluta se mira en el
 * disco, sin buscar en el PATH; en Windows, si no está tal cual, se prueban las extensiones de PATHEXT (`.exe`,
 * `.cmd`…): en Windows todo ejecutable lleva extensión, y el arnés declara algunos por su ruta sin ella (pase
 * adversarial de la W6, hallazgo #5: `~/.local/bin/codebase-memory-mcp` salía «no está» con el `.exe` instalado).
 * @param {string} cmd
 * @param {{platform?: string, exec?: Function, exists?: (p: string) => boolean, env?: object}} [ctx]
 */
function findBinary(cmd, ctx = {}) {
  if (!cmd) return null;
  const platform = ctx.platform || process.platform;
  const exists = ctx.exists || fs.existsSync;
  const exec = ctx.exec || require('child_process').execFileSync;
  const abs = (platform === 'win32' ? path.win32 : path.posix).isAbsolute(cmd);
  if (abs) {
    if (exists(cmd)) return cmd;
    if (platform !== 'win32') return null;
    const exts = pathExts(ctx.env || process.env);
    if (exts.includes(path.win32.extname(cmd).toLowerCase())) return null;   // ya traía su extensión y no está
    return exts.map((e) => cmd + e).find((c) => exists(c)) || null;
  }
  try {
    // `where` da una ubicación por línea (con \r\n), en el orden del PATH: vale la primera
    const out = exec(whichCommand(platform), [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return String(out || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch (_) { return null; }   // no está (sale 1), o el buscador no arrancó: para el aviso es lo mismo, «no lo encontré»
}

/** La búsqueda del bash de Git del arnés, ubicado como lo ubica el pipeline (`lib/harness-path.js`). */
function harnessFindGitBash(ctx) {
  let dir = ctx.harnessDir;
  let why = null;
  if (dir === undefined) {
    const r = require('./harness-path.js').rutaArnesHook({ env: ctx.env, home: ctx.home });
    dir = r.dir;
    why = r.aviso;
  }
  if (!dir) return () => ({ path: null, reason: why || 'no encontré el arnés (TYCON_GUIDES_DIR o el enlace ~/.claude/tycon-harness)' });
  const lib = path.join(dir, 'scripts', 'lib', 'git-bash.js');
  if (!fs.existsSync(lib)) return () => ({ path: null, reason: `el arnés de ${dir} no trae scripts/lib/git-bash.js (está atrasado): actualizalo` });
  const { findGitBash } = require(lib);
  return () => findGitBash({ platform: 'win32', env: ctx.env, exists: ctx.exists });
}

/**
 * Qué encuentra Windows para un nombre de programa, mirando el PATH como lo mira Node al lanzar SIN shell.
 *   · `exe`    un `.exe`/`.com` que Node puede lanzar tal cual (o el nombre exacto, si ya trae esa extensión);
 *   · `script` un `.cmd`/`.bat` (en el orden de PATHEXT) que Node NO lanza sin shell: no lo encuentra (busca sólo
 *              `.com` y `.exe`) o, desde Node 18.20.2 / 20.12.2, lo rechaza con EINVAL;
 *   · `shim`   el guion sin extensión que npm deja al lado del `.cmd` (`npx` junto a `npx.cmd`): un sh que llama a
 *              node, el que encuentra Git Bash.
 * Lo que aparece primero en el PATH gana, como en Windows. Una ruta con carpeta se mira sólo ahí.
 */
function windowsLookup(name, ctx) {
  const win = path.win32;
  const env = ctx.env || process.env;
  const exists = ctx.exists || fileExists;
  const exts = pathExts(env);
  const ext = win.extname(name).toLowerCase();
  const dirs = /[\\/]/.test(name)
    ? [win.dirname(name)]
    : String(envGet(env, 'PATH', true) || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const base = /[\\/]/.test(name) ? win.basename(name) : name;
  for (const dir of dirs) {
    if (ext === '.cmd' || ext === '.bat') {
      const p = win.join(dir, base);
      const shim = win.join(dir, base.slice(0, -ext.length));
      if (exists(p)) return { exe: null, script: p, shim: exists(shim) ? shim : null };
      continue;
    }
    // con una extensión escrita se busca ESE archivo, esté o no en PATHEXT (un `.ps1` existe aunque no se lance solo):
    // decir «no está» de algo que está es un fallo callado; si no se puede lanzar, el error de spawn lo dice
    if (ext && exists(win.join(dir, base))) return { exe: win.join(dir, base), script: null, shim: null };
    for (const e of ['.com', '.exe']) { const p = win.join(dir, base + e); if (exists(p)) return { exe: p, script: null, shim: null }; }
    for (const e of exts.filter((x) => x === '.cmd' || x === '.bat')) {
      const p = win.join(dir, base + e);
      if (exists(p)) {
        const shim = ext ? null : win.join(dir, base);
        return { exe: null, script: p, shim: shim && exists(shim) ? shim : null };
      }
    }
  }
  return { exe: null, script: null, shim: null };
}

/** La búsqueda del bash de Git: la inyectada, o la del arnés. Nunca tira: un error vuelve como motivo. */
function gitBashFor(ctx) {
  try {
    return (ctx.findGitBash || harnessFindGitBash(ctx))() || { path: null, reason: 'sin motivo' };
  } catch (e) {
    return { path: null, reason: `la búsqueda tiró: ${e.message}` };
  }
}

/**
 * Con qué se lanza el comando de `marker.js run-check`. Fuera de Windows, tal cual. En Windows:
 *   · un `bash` (o `bash.exe`) a secas se cambia por el bash de Git;
 *   · un programa que en el PATH es sólo un `.cmd`/`.bat` (`npx`, `npm`, `jest` instalados por npm) se lanza POR el
 *     bash de Git: `bash -c 'exec "$0" "$@"' <programa> <argumentos…>` (pase adversarial de la W6, hallazgos #1 y
 *     #2: run-check lanzaba `npx` sin shell, Node no lo encontraba, y vitest y jest nunca corrían en Windows);
 *   · un `.exe` (dotnet, node) y lo que no se encuentra quedan tal cual (lo que no está sale rojo con ENOENT, como
 *     siempre; test-gate.sh lo ve antes con `canLaunch()` y sale 5).
 *
 * 🔴 POR QUÉ EL BASH DE GIT Y NO `cmd /c`. `cmd.exe` vuelve a leer la línea entera como un comando de cmd: un `&`,
 * un `|`, un `^` o un `%VARIABLE%` dentro de un argumento (una ruta, un filtro de pruebas) se interpreta en vez de
 * pasarse. Es la familia de fallas por la que Node dejó de lanzar `.cmd` sin shell (CVE-2024-27980), y no hay un
 * escapado de cmd que sea seguro para cualquier texto. Con bash, cada argumento llega como un parámetro posicional
 * (`"$@"`) y ningún shell lo vuelve a leer. Y lo que bash ejecuta es el guion sin extensión que npm deja al lado del
 * `.cmd` (un sh que llama a node): cmd.exe no aparece en el camino. Sólo si no hay guion se le pasa el `.cmd` mismo.
 * Sin bash de Git no se lanza: vuelve el motivo, como con `bash`.
 * @param {string[]} cmdArgv  el comando y sus argumentos
 * @param {{platform?: string, findGitBash?: Function, harnessDir?: string|null, env?: object, home?: string,
 *          exists?: Function}} [ctx]
 * @returns {{file: string|null, args: string[], error: string|null}}  `file: null` = no se lanza; `error` dice por qué
 */
function runCheckLaunch(cmdArgv, ctx = {}) {
  const [file, ...args] = cmdArgv;
  const platform = ctx.platform || process.platform;
  if (platform !== 'win32' || !file) return { file, args, error: null };
  if (/^bash(\.exe)?$/i.test(String(file))) {
    const found = gitBashFor(ctx);
    if (found.path) return { file: found.path, args, error: null };
    return {
      file: null, args,
      error: `no lanzo «${file}» en Windows sin el bash de Git for Windows (el primero del PATH puede ser el lanzador de WSL): ${found.reason || 'sin motivo'}`,
    };
  }
  const hit = windowsLookup(String(file), ctx);
  if (!hit.script) return { file, args, error: null };
  const found = gitBashFor(ctx);
  if (!found.path) {
    return {
      file: null, args,
      error: `no lanzo «${file}» en Windows: es un ${path.win32.extname(hit.script)} (${hit.script}), Node no lo lanza sin shell, y para lanzarlo hace falta el bash de Git for Windows: ${found.reason || 'sin motivo'}`,
    };
  }
  // La ruta del guion sin extensión si está (no pasa por cmd.exe); si no, la del .cmd. Con barras `/`: Git Bash la
  // lee igual y no se confunde una `\` con un escape.
  const target = (hit.shim || hit.script).replace(/\\/g, '/');
  return { file: found.path, args: ['-c', 'exec "$0" "$@"', target, ...args], error: null };
}

/**
 * ¿`run-check` puede lanzar `cmd`? Lo mira test-gate.sh ANTES de correr la suite, para salir 5 («no pude correr las
 * pruebas») en vez de dejar un rojo con totales vacíos (pase adversarial de la W6, hallazgo #8: `command -v npx` en
 * Git Bash encuentra el guion `npx`, pero run-check no lo podía lanzar). Usa la MISMA búsqueda que `runCheckLaunch()`.
 * Fuera de Windows: un archivo del PATH que se pueda ejecutar (bash `command -v` cuenta también uno sin permiso).
 * @returns {{ok: boolean, reason: string|null}}
 */
function canLaunch(cmd, ctx = {}) {
  const platform = ctx.platform || process.platform;
  if (!cmd) return { ok: false, reason: 'sin programa' };
  if (platform === 'win32') {
    const l = runCheckLaunch([cmd], ctx);
    if (!l.file) return { ok: false, reason: l.error };
    if (/^bash(\.exe)?$/i.test(cmd)) return { ok: true, reason: null };
    const hit = windowsLookup(cmd, ctx);
    if (hit.exe || hit.script) return { ok: true, reason: null };
    return { ok: false, reason: `«${cmd}» no está en el PATH de Windows (ni .exe ni .cmd)` };
  }
  const exists = ctx.exists || fileExists;
  const executable = ctx.executable || isExecutable;
  const env = ctx.env || process.env;
  const cands = cmd.includes('/') ? [cmd] : String(env.PATH || '').split(':').filter(Boolean).map((d) => path.posix.join(d, cmd));
  const seen = cands.filter((p) => exists(p));
  if (seen.some((p) => executable(p))) return { ok: true, reason: null };
  return { ok: false, reason: seen.length ? `«${cmd}» está en ${seen[0]} pero no se puede ejecutar` : `«${cmd}» no está en el PATH` };
}

module.exports = { whichCommand, findBinary, runCheckLaunch, canLaunch };

// A mano (y desde test-gate.sh):  node lib/portable-tools.js can-launch <programa>   → 0 se puede · 1 no (motivo a stderr)
if (require.main === module) {
  const [sub, cmd] = process.argv.slice(2);
  if (sub !== 'can-launch' || !cmd) {
    process.stderr.write('uso: node portable-tools.js can-launch <programa>\n');
    process.exit(2);
  }
  const r = canLaunch(cmd);
  if (!r.ok) process.stderr.write(`${r.reason}\n`);
  process.exit(r.ok ? 0 : 1);
}
