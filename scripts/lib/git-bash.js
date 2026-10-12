#!/usr/bin/env node
'use strict';
/**
 * git-bash.js — dónde está el bash de Git for Windows. LA única función del arnés que lo busca (story 8.17, tanda W1).
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────────────────────
 * En Windows, `bash` a secas no dice qué bash. La medición en un agente Windows (2026-10-03) encontró CUATRO en el
 * PATH: el de Git (`…\Git\bin\bash.exe`), el de `System32`, el de `…\Git\usr\bin` y el alias de `WindowsApps`. El de
 * `System32` y el de `WindowsApps` son el lanzador de WSL: abren una distribución de Linux, que no ve una ruta
 * `C:/…` y que puede no estar instalada. Cuál queda primero depende del orden del PATH de cada máquina. Un guion
 * que lanza `bash` por su nombre anda en la máquina de quien lo escribió y falla, sin decir por qué, en otra.
 *
 * ── EL ORDEN (Windows) ──────────────────────────────────────────────────────────────────────────────────────────
 *   1. la variable `CLAUDE_CODE_GIT_BASH_PATH` — la misma con la que se le dice a Claude Code dónde está;
 *   2. el `bash.exe` de la instalación del `git` que está en el PATH (`<raíz>\bin\bash.exe`, y si no,
 *      `<raíz>\usr\bin\bash.exe`);
 *   3. las dos carpetas de instalación por defecto de Git for Windows: para todos los usuarios
 *      (`%ProgramFiles%\Git`) y para uno solo (`%LOCALAPPDATA%\Programs\Git`).
 * NUNCA devuelve el lanzador de WSL, tampoco si la variable apunta a él.
 * Fuera de Windows devuelve el primer `bash` del PATH.
 *
 * ── QUÉ DEVUELVE ────────────────────────────────────────────────────────────────────────────────────────────────
 *   { path, source, reason }
 *     path    la ruta absoluta, o `null` si no lo encontró;
 *     source  de dónde salió: 'env' | 'git' | 'default' (Windows) · 'path' (el resto) · `null`;
 *     reason  `null` si lo encontró; si no, el motivo en una línea, para mostrárselo a una persona.
 *
 * ── CÓMO SE PRUEBA SIN WINDOWS ──────────────────────────────────────────────────────────────────────────────────
 * No lee `process.platform`, `process.env` ni el disco por su cuenta: los recibe (`ctx.platform`, `ctx.env`,
 * `ctx.exists`) y sin ellos usa los de la máquina. `scripts/tests/git-bash.test.js` le inyecta un Windows de mentira
 * y recorre cada rama. No lanza ningún proceso (ni `where`, ni `git --exec-path`): buscar no puede colgarse.
 *
 * A mano:   node scripts/lib/git-bash.js [--json]        (sale 0 si lo encontró, 1 si no)
 */
const fs = require('fs');
const nodePath = require('path');

const ENV_VAR = 'CLAUDE_CODE_GIT_BASH_PATH';

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/**
 * El valor de una variable de entorno, como texto. En Windows los nombres no distinguen mayúsculas (`Path`, `PATH`):
 * vale la primera que traiga algo (un objeto de entorno armado a mano puede traer dos, una vacía).
 */
function envValue(env, name, windows) {
  if (!env) return undefined;
  const text = (v) => (v === undefined || v === null ? undefined : String(v));
  if (!windows) return text(env[name]);
  const wanted = name.toLowerCase();
  const same = Object.keys(env).filter((k) => k.toLowerCase() === wanted).sort((a, b) => (b === name) - (a === name));
  const full = same.find((k) => text(env[k]));
  return text(env[full !== undefined ? full : same[0]]);
}

/** Las carpetas del PATH, en orden, sin vacías y sin las comillas que Windows permite alrededor de cada una. */
function pathEntries(env, windows) {
  const raw = envValue(env, 'PATH', windows) || '';
  return String(raw).split(windows ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/**
 * ¿Esa ruta es el lanzador de WSL? Lo es el `bash.exe` de la carpeta de sistema (`System32`, y sus dos alias
 * `Sysnative` y `SysWOW64`) y el alias de `…\Microsoft\WindowsApps\`. Se decide por el NOMBRE de la carpeta, sin mirar
 * dónde está Windows: así vale con Windows en otra unidad, sin `SystemRoot` en el entorno y con el prefijo de ruta
 * larga (`\\?\C:\…`). Ninguna instalación de Git deja su bash en una carpeta con esos nombres.
 */
function isWslLauncher(candidate) {
  const win = nodePath.win32;
  const p = win.normalize(String(candidate || '')).toLowerCase();
  if (!p) return false;
  if (/\\microsoft\\windowsapps\\[^\\]+$/.test(p)) return true;
  return ['system32', 'sysnative', 'syswow64'].includes(win.basename(win.dirname(p)));
}

function findOnWindows(env, exists) {
  const win = nodePath.win32;
  const notes = [];

  // 1 · la variable
  const fromEnv = String(envValue(env, ENV_VAR, true) || '').trim().replace(/^"(.*)"$/, '$1');
  if (fromEnv) {
    if (isWslLauncher(fromEnv)) notes.push(`${ENV_VAR} apunta a ${fromEnv}, que es el lanzador de WSL y no el bash de Git for Windows`);
    else if (!exists(fromEnv)) notes.push(`${ENV_VAR} apunta a ${fromEnv}, que no existe`);
    else return { path: fromEnv, source: 'env', reason: null };
  }

  // 2 · el bash.exe de la instalación del git que está en el PATH. git.exe vive en <raíz>\cmd, en <raíz>\bin o en
  //     <raíz>\mingw64\bin: la raíz está una o dos carpetas arriba de la suya. Acá NO se busca `bash.exe` en el PATH
  //     —ahí es donde aparece el lanzador de WSL—: se arma desde la raíz de git, y por eso este paso y el que sigue no
  //     pueden devolver el lanzador (que vive en la carpeta de sistema, nunca en un `bin` de una instalación de git).
  const entries = pathEntries(env, true);
  const gitWithoutBash = [];
  for (const dir of entries) {
    if (!exists(win.join(dir, 'git.exe'))) continue;
    gitWithoutBash.push(dir);
    for (const root of [win.dirname(dir), win.dirname(win.dirname(dir))]) {
      for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
        const candidate = win.join(root, ...rel);
        if (exists(candidate)) return { path: candidate, source: 'git', reason: null };
      }
    }
  }

  // 3 · las dos carpetas de instalación por defecto. `ProgramW6432` es la de 64 bits vista desde un Node de 32 bits
  //     (ahí `ProgramFiles` es la carpeta «(x86)»); en uno de 64 bits las dos variables dicen lo mismo.
  const localAppData = envValue(env, 'LOCALAPPDATA', true);
  const defaults = [...new Set([envValue(env, 'ProgramW6432', true), envValue(env, 'ProgramFiles', true) || 'C:\\Program Files']
    .filter(Boolean).map((d) => win.join(d, 'Git')))];
  if (localAppData) defaults.push(win.join(localAppData, 'Programs', 'Git'));
  for (const root of defaults) {
    const candidate = win.join(root, 'bin', 'bash.exe');
    if (exists(candidate)) return { path: candidate, source: 'default', reason: null };
  }

  // no está: el motivo dice qué hay, para que el mensaje no mande a buscar lo que no falta
  const launchers = entries.map((d) => win.join(d, 'bash.exe')).filter((p) => isWslLauncher(p) && exists(p));
  const how = `instalá Git for Windows, o indicá dónde está su bash.exe con ${ENV_VAR}`;
  let base;
  if (gitWithoutBash.length) {
    // hay git, y no es una instalación completa de Git for Windows (una mínima, o git por atajos): decir «no hay git»
    // mandaría a instalar lo que ya está
    const launcher = launchers.length ? `; el bash que aparece en el PATH es el lanzador de WSL (${launchers.join(', ')}), que no sirve` : '';
    base = `falta el bash de Git for Windows: hay git en ${gitWithoutBash.join(', ')}, pero no su bash.exe al lado (¿una instalación mínima, o git por atajos?)${launcher} — indicá dónde está su bash.exe con ${ENV_VAR}, o instalá Git for Windows`;
  } else if (launchers.length) {
    base = `falta Git for Windows: sólo está el lanzador de WSL (${launchers.join(', ')}), que no es el bash de Git y no puede leer una ruta C:/… — ${how}`;
  } else {
    base = `falta Git for Windows: no hay git en el PATH ni en sus carpetas de instalación por defecto (${defaults.join(', ')}) — ${how}`;
  }
  return { path: null, source: null, reason: [...notes, base].join('; ') };
}

function findOnPosix(env, exists) {
  for (const dir of pathEntries(env, false)) {
    const candidate = nodePath.posix.join(dir, 'bash');
    if (exists(candidate)) return { path: candidate, source: 'path', reason: null };
  }
  return { path: null, source: null, reason: 'no hay bash en el PATH' };
}

/**
 * El bash con el que el arnés corre un guion de bash en esta máquina.
 * @param {{platform?: string, env?: object, exists?: (p: string) => boolean}} [ctx]  lo que no se pasa sale de la máquina
 * @returns {{path: string|null, source: 'env'|'git'|'default'|'path'|null, reason: string|null}}
 */
function findGitBash(ctx = {}) {
  const platform = ctx.platform || process.platform;
  const env = ctx.env || process.env;
  const lookUp = ctx.exists || fileExists;
  // un disco que no se deja mirar se lee como «no está»: la función contesta siempre, con su motivo
  const exists = (p) => { try { return Boolean(lookUp(p)); } catch (_) { return false; } };
  return platform === 'win32' ? findOnWindows(env, exists) : findOnPosix(env, exists);
}

module.exports = { findGitBash, isWslLauncher, ENV_VAR };

if (require.main === module) {
  const found = findGitBash();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ platform: process.platform, ...found })}\n`);
  } else if (found.path) {
    process.stdout.write(`${found.path}\n`);
  } else {
    process.stderr.write(`${found.reason}\n`);
  }
  process.exitCode = found.path ? 0 : 1;
}
