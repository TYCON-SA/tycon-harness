'use strict';
/**
 * sibling-copy.js — la copia hermana de un repo para una sesión: `<carpeta principal>--wt-<nombre>`, con su rama.
 *
 * La usan `coordination.js open` (abre cada sesión en su copia) y `own-copy.js` del pipeline (la copia de una historia
 * cuando hay otra sesión en el checkout). No pisa ni reusa una copia o una rama `wt/<nombre>` que ya existen: pueden
 * tener el trabajo de otra sesión. Todo `git` corre en la carpeta principal, así que `base` llega ya resuelto (un sha o
 * `origin/main`): `HEAD` acá sería el de la principal, no el del checkout de quien llama.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_TIMEOUT_MS = 20000;
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
const realDir = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } };

function gitIn(dir, args) {
  // la carpeta la dice quien llama: su configuración no corre un programa por acá
  const r = spawnSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: require('./clean-git-env.js').idiomaFijo() });
  return { code: r.error ? null : r.status, out: String(r.stdout || '').trim(), err: String((r.error && r.error.message) || r.stderr || '').trim().split('\n')[0] };
}

/**
 * Crea la copia. `base`: de dónde nace una rama nueva (por defecto `origin/main`). `fetch`: trae `main` de `origin` antes
 * (por defecto sí; quien ya lo trajo pasa `false`). `{ ok, path, main, branch, created }` o `{ ok: false, message,
 * reason }`, con el primer renglón del error de git; `reason: 'exists'` si la carpeta o la rama ya estaban.
 */
function siblingCopy({ repo, name, branch, base = 'origin/main', fetch = true }) {
  const no = (message, reason = null) => ({ ok: false, message: oneLine(message), reason });
  const common = gitIn(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0 || !common.out) return no(`No pude ver el repo ${repo} (${common.err || `git salió con código ${common.code}`}): no la abrí.`);
  const main = realDir(path.basename(common.out) === '.git' ? path.dirname(common.out) : common.out);
  const copyPath = `${main}--wt-${name}`;
  if (fs.existsSync(copyPath)) return no(`La copia ${copyPath} ya existe: no la piso ni la reuso; no la abrí.`, 'exists');
  const exists = gitIn(main, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).code === 0;
  if (exists && branch === `wt/${name}`) return no(`La rama ${branch} ya existe en ${main}: no la piso ni la reuso; no la abrí.`, 'exists');
  // sin red no se crea la copia desde una punta vieja
  if (fetch) {
    const fetched = gitIn(main, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
    if (fetched.code !== 0) return no(`No pude traer main de origin en ${main} (${fetched.err || `git salió con código ${fetched.code}`}): no la abrí.`);
  }
  const add = exists
    ? gitIn(main, ['worktree', 'add', '-q', copyPath, branch])
    : gitIn(main, ['worktree', 'add', '-q', '--no-track', '-b', branch, copyPath, base]);
  if (add.code !== 0) {
    // sólo se saca lo que este add pudo haber dejado: la carpeta si no existía antes, la rama si no existía antes
    const left = removeCopy({ path: copyPath, main, branch, created: !exists }) ? '' : ` Quedó algo de la copia: lo saca el barrido.`;
    return no(`No pude crear la copia ${copyPath} (${add.err || `git salió con código ${add.code}`}): no la abrí.${left}`);
  }
  return { ok: true, path: copyPath, main, branch, created: !exists };
}

/**
 * Saca una copia recién creada, y su rama si la creó quien llama. Devuelve true si no quedó ninguna de las dos; lo que
 * no puede sacar queda para el barrido, y quien llama lo dice.
 */
function removeCopy(copy) {
  if (fs.existsSync(copy.path)) gitIn(copy.main, ['worktree', 'remove', '--force', copy.path]);
  gitIn(copy.main, ['worktree', 'prune']);
  if (copy.created) gitIn(copy.main, ['branch', '-D', copy.branch]);
  const branchLeft = copy.created && gitIn(copy.main, ['rev-parse', '--verify', '-q', `refs/heads/${copy.branch}`]).code === 0;
  return !fs.existsSync(copy.path) && !branchLeft;
}

module.exports = { siblingCopy, removeCopy, gitIn };
