'use strict';
/*
 * overlay-lab.js — un árbol armado de juguete, como el de los nocturnos: la punta del privado y, encima, el commit de la
 * superposición con lo que trae el público.
 *
 *   const lab = overlayLab({ privado: { 'specs/x.md': '…' }, publico: { 'scripts/x.js': '…' } });
 *   lab.root · lab.tip (la punta del privado) · lab.cleanup()
 *
 * El asunto del commit de arriba lleva la marca de la superposición (OVERLAY_MARK de scripts/publishing/internal-history.js),
 * que es lo que mira `broughtByOverlay`. Un archivo en `publico` que también está en `privado` queda con el contenido del
 * público, como lo deja la superposición.
 */
// stable-data: los commits de juguete fijan sus fechas y apagan el mantenimiento automático de git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { OVERLAY_MARK } = require('../../publishing/internal-history.js');

const FECHA_FIJA = '2026-01-01T00:00:00Z';

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'Prueba', GIT_AUTHOR_EMAIL: '1+prueba@users.noreply.github.com', GIT_COMMITTER_NAME: 'Prueba', GIT_COMMITTER_EMAIL: '1+prueba@users.noreply.github.com',
      GIT_AUTHOR_DATE: FECHA_FIJA, GIT_COMMITTER_DATE: FECHA_FIJA },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function overlayLab({ privado = {}, publico = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arbol-armado-')));
  const put = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  };
  git(root, ['init', '--quiet', '--initial-branch=main']);
  put(privado);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'la punta del privado']);
  const tip = git(root, ['rev-parse', 'HEAD']);
  put(publico);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', `arnés de GitHub ${'a'.repeat(40)} sobre la punta ${tip} del privado, adelgazado ${OVERLAY_MARK}`]);
  return { root, tip, git: (args) => git(root, args), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = { overlayLab };
