'use strict';
/**
 * harness-copy.js — una copia propia del arnés, con git y su main, para las pruebas que pasan un guion del arnés por el
 * freno de escrituras.
 *
 * El freno (skills/tycon-pipeline/scripts/on-bash-write-gate.js) reconoce un guion de su propio árbol sólo si git lo
 * tiene versionado, sin cambios y en un commit que el servidor ya tiene. En el clon donde corre la prueba
 * eso depende de su estado: un commit sin empujar que toca marker.js, la rama de un pedido o el árbol que arma el portón
 * (el público en un commit local) lo dejan sin reconocer, y la prueba sale roja por el clon, no por lo que mira. La
 * copia sale de los archivos de `skills/` y `scripts/` tal como están en disco (con lo que se cambió y no se commiteó),
 * en un repo nuevo con un solo commit, y su main del servidor apunta a ese commit.
 *
 *   harnessCopy()        → la raíz de la copia; se arma una vez por proceso y se borra al salir
 *   inHarnessCopy(texto) → `texto` con cada ruta de este arnés cambiada por la de la copia: el freno y los guiones
 *                          que nombra el comando corren desde la copia
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// stable-data: el único commit de la copia lleva fecha fija
const DATE = '2026-01-01T00:00:00Z';

let copy = null;

function trackedFiles() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'skills', 'scripts'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  } catch (_e) {
    return null;
  }
}

function harnessCopy() {
  if (copy) return copy;
  const dest = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-copy-')));
  process.on('exit', () => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_e) { /* la carpeta temporal la limpia el sistema */ } });
  const files = trackedFiles();
  if (files) {
    for (const f of files) {
      const from = path.join(ROOT, f);
      // uno versionado y borrado del disco no se copia
      if (!fs.statSync(from, { throwIfNoEntry: false })?.isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
      fs.copyFileSync(from, path.join(dest, f));
      // con la hora de la copia, git los ve escritos en el mismo segundo que su índice y los vuelve a leer enteros en
      // cada consulta del freno
      fs.utimesSync(path.join(dest, f), new Date(DATE), new Date(DATE));
    }
  } else {
    for (const d of ['skills', 'scripts']) {
      fs.cpSync(path.join(ROOT, d), path.join(dest, d), { recursive: true, filter: (s) => !/[\\/]node_modules$/.test(s) });
    }
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE,
    GIT_AUTHOR_NAME: 'copia', GIT_AUTHOR_EMAIL: 'copia@acme.test', GIT_COMMITTER_NAME: 'copia', GIT_COMMITTER_EMAIL: 'copia@acme.test' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const git = (...a) => execFileSync('git', ['-C', dest, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', ...a], { stdio: 'ignore', env });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'copia del arnés');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  copy = dest;
  return copy;
}

function inHarnessCopy(text) {
  return String(text).split(ROOT + path.sep).join(harnessCopy() + path.sep);
}

module.exports = { harnessCopy, inHarnessCopy };
