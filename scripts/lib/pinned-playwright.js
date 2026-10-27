'use strict';
// pinned-playwright.js — la versión fija de Playwright del arnés, en un solo lugar.
//
// Playwright no es una dependencia del arnés: lo usan las pruebas del sitio que abren un navegador
// (scripts/tests/site-config.test.js, site-propose.test.js) y la herramienta de capturas de la guía
// (scripts/tools/site-guide-captures.js). Un `require('playwright')` suelto sube de carpeta en carpeta y toma el primero
// que encuentra, por ejemplo uno viejo de la carpeta personal cuyo Chromium ya no arranca. Por eso se busca sólo:
//   1. en `TYCON_PLAYWRIGHT` (la carpeta de un módulo playwright o playwright-core), la salida explícita;
//   2. en la caché del arnés, y sólo si es la versión fija.
// Nunca entre los módulos de node. Instalar la versión fija: `node scripts/lib/pinned-playwright.js install` (baja
// playwright-core a la caché, fuera de cualquier repo, y su Chromium). Las pruebas no instalan nada: sin la versión fija
// se saltean con constancia y el motivo dice ese comando.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PINNED_VERSION = '1.63.0';
const INSTALL_HINT = 'node scripts/lib/pinned-playwright.js install';

/** La caché del arnés para Playwright (el nombre viene de la herramienta de capturas, que fue la primera en usarla). */
function cacheDir(home = os.homedir()) {
  return path.join(home, '.cache', 'site-guide-captures', 'playwright');
}

function versionOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

/** Dónde está el Playwright que corresponde: { dir, why }. Sin uno que sirva, `dir` es null y `why` dice por qué. */
function locate({ env = process.env, home = os.homedir() } = {}) {
  if (env.TYCON_PLAYWRIGHT) {
    const dir = path.resolve(env.TYCON_PLAYWRIGHT);
    return versionOf(dir) ? { dir, why: '' } : { dir: null, why: `TYCON_PLAYWRIGHT=${dir} no es la carpeta de un módulo` };
  }
  const dir = path.join(cacheDir(home), 'node_modules', 'playwright-core');
  const v = versionOf(dir);
  if (v === PINNED_VERSION) return { dir, why: '' };
  const encontro = v ? `en la caché está la ${v}` : 'no está en la caché';
  return { dir: null, why: `Playwright ${PINNED_VERSION} ${encontro} (${INSTALL_HINT}, o TYCON_PLAYWRIGHT=<carpeta del módulo>)` };
}

/** El módulo, o null si no hay uno que corresponda. */
function load(opts) {
  const { dir } = locate(opts);
  if (!dir) return null;
  try { return require(dir); } catch { return null; }
}

/** Instala la versión fija en la caché y su Chromium. Devuelve true si quedó. */
function install({ home = os.homedir(), stdio = 'inherit' } = {}) {
  const cache = cacheDir(home);
  const dir = path.join(cache, 'node_modules', 'playwright-core');
  if (versionOf(dir) !== PINNED_VERSION) {
    fs.mkdirSync(cache, { recursive: true });
    if (!fs.existsSync(path.join(cache, 'package.json'))) fs.writeFileSync(path.join(cache, 'package.json'), '{"private":true}\n');
    const npm = spawnSync('npm', ['install', '--prefix', cache, '--no-audit', '--no-fund', `playwright-core@${PINNED_VERSION}`], { stdio, shell: process.platform === 'win32' });
    if (npm.status !== 0 || versionOf(dir) !== PINNED_VERSION) return false;
  }
  const r = spawnSync(process.execPath, [path.join(dir, 'cli.js'), 'install', 'chromium'], { stdio });
  return r.status === 0;
}

module.exports = { PINNED_VERSION, INSTALL_HINT, cacheDir, locate, load, install };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'install') process.exit(install() ? 0 : 1);
  if (cmd === 'where') { const r = locate(); console.log(r.dir || r.why); process.exit(r.dir ? 0 : 1); }
  console.log(`uso: node scripts/lib/pinned-playwright.js install|where — Playwright ${PINNED_VERSION} en ${cacheDir()}`);
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 2);
}
