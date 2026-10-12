#!/usr/bin/env node
'use strict';
// harness-startup.js — hook de SessionStart del lado Codex: el arranque de una sesión de Codex ACTUALIZA el arnés
// (story 8.23, tanda C · AC 22).
//
// ── EL CASO (2026-10-06) ──────────────────────────────────────────────────────────────────────────────────────────
// La actualización del arnés la disparaba sólo la línea de arranque de Claude Code (`settings.json` → la copia fija
// `bootstrap.js` → `harness.js startup`). El arranque de Codex corría `harness-maintain.sh`, que lanza el aplicador de
// fondo y NO actualiza: una máquina que sólo usa Codex se quedaba en la versión con que se instaló, para siempre y sin
// una palabra. Y era un guion de shell: en Windows sin Git Bash no corría.
//
// ── QUÉ HACE ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Lo mismo que la línea de arranque de Claude Code, desde Node (anda igual en Mac, Linux y Windows):
//   1. Corre la COPIA FIJA de arranque —`<estado>/harness/bootstrap.js`, fuera del árbol que se actualiza—, que lanza
//      `harness.js startup` con sus topes de siempre (la red, el candado, y lo largo aparte del hook: tanda L). Lo que
//      imprime (el aviso de una versión disponible, de una retención) sale por acá, a la sesión.
//   2. Si la copia fija sale distinto de 0 (el árbol no arranca), lanza el respaldo en shell que vive a su lado
//      (`bootstrap-fallback.sh`, o `.ps1` en Windows), desprendido de la sesión: repara o vuelve a la versión anterior.
//   3. Sin copia fija (una máquina con Codex desplegado y sin el mecanismo de instalación: de antes de la 8.13), lo de
//      antes: el aplicador del árbol, de fondo y desprendido de la sesión.
// Dónde está el estado lo dice scripts/setup/harness/tycon-home.js (una máquina sin Claude Code lo tiene en
// `~/.tycon/state`).
//
// Sale 0 SIEMPRE y nunca frena: un hook de arranque que falla o bloquea es peor que uno que no corre.
// Apagar: `TYCON_UPDATE=0` (lo lee `harness.js startup`) · `TYCON_NO_AUTOINSTALL=1` (el aplicador).
// `TYCON_MAINTAIN_CMD`: variable de PRUEBA (el banco de controles): el comando que se lanza en vez de todo lo de arriba.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TREE = path.resolve(__dirname, '..', '..');
const STARTUP_TIMEOUT_MS = 90 * 1000;

/** La carpeta del estado, o null si no se puede saber (un árbol sin tycon-home.js: de antes del mecanismo). */
function stateDir() {
  try { return require(path.join(TREE, 'scripts', 'setup', 'harness', 'tycon-home.js')).stateDir(os.homedir()); } catch (_) { return null; }
}

/** Lanza un comando desprendido de la sesión (doble salida: no muere cuando la sesión cierra) y no lo espera. */
function detach(bin, args) {
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
    child.on('error', () => { /* sin el binario: no hay mantenimiento esta vez */ });
    child.unref();
  } catch (_) { /* nunca frena el arranque */ }
}

function main() {
  // el banco de controles lo corre hermético: sólo dispara lo que se le dice
  const override = process.env.TYCON_MAINTAIN_CMD;
  if (override) { if (fs.existsSync(override)) detach('bash', [override]); return; }

  const state = stateDir();
  const fixedDir = state ? path.join(state, 'harness') : null;
  const bootstrap = fixedDir ? path.join(fixedDir, 'bootstrap.js') : null;
  if (bootstrap && fs.existsSync(bootstrap)) {
    const r = spawnSync(process.execPath, [bootstrap], { encoding: 'utf8', env: process.env, timeout: STARTUP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status === 0) return;
    // la copia fija no pudo arrancar el programa: el respaldo en shell de su misma carpeta, como en la línea de Claude
    // Code. Desprendido de la sesión: puede correr un instalador entero, y un hook de arranque no espera eso
    const win = process.platform === 'win32';
    const fallback = path.join(fixedDir, win ? 'bootstrap-fallback.ps1' : 'bootstrap-fallback.sh');
    if (fs.existsSync(fallback)) detach(win ? 'pwsh' : 'bash', win ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fallback] : [fallback]);
    return;
  }

  // con el mecanismo instalado (hay estado) y sin su copia fija: no es «una máquina de antes», es una copia fija que
  // falta; el aplicador suelto de Claude Code acá sería un enchufe a espaldas de la persona (pase adversarial, clase 14)
  if (state && fs.existsSync(path.join(state, 'harness-state.json'))) {
    process.stdout.write(`arnés: falta la copia fija de arranque en ${fixedDir}: el arnés no se actualiza en esta sesión; la repone node <árbol>/scripts/setup/harness.js install --version latest\n`);
    return;
  }
  // sin el mecanismo de instalación: el mantenimiento de antes (el aplicador del árbol, de fondo)
  if (process.env.TYCON_NO_AUTOINSTALL === '1') return;
  const win = process.platform === 'win32';
  const applier = path.join(TREE, 'scripts', win ? 'install-tycon-hooks.ps1' : 'install-tycon-hooks.sh');
  if (fs.existsSync(applier)) detach(win ? 'pwsh' : 'bash', win ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applier] : [applier]);
}

try { main(); } catch (_) { /* un hook de arranque nunca frena una sesión */ }
process.exit(0);
