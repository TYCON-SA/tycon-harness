'use strict';
/**
 * sibling-copy.js — la copia hermana de un repo: `<carpeta principal>--wt-<nombre>`, con su rama, desde una punta
 * elegida. La usan `coordination.js open` (la sesión que abre la coordinadora va a su copia) y `pipeline.js start` (la
 * historia que arranca con otra sesión viva en el checkout va a la suya). Una sola pieza: dos copias de
 * cómo se crea y se limpia una copia divergen.
 *
 * No pisa ni reusa una copia o una rama `wt/<nombre>` que ya existen (pueden tener el trabajo de otra sesión); una rama
 * pedida aparte que ya existe se usa y nunca se borra. Si `worktree add` falla, saca sólo lo que ese intento dejó.
 * Claude Code 2.1.330 pide aprobar cada copia aparte, aunque la principal esté aprobada (con 2.1.312 no la pedía).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_TIMEOUT_MS = 20000;
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
const realDir = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } };

function gitIn(dir, args) {
  // la carpeta la elige quien llama: su configuración no corre un programa por acá
  const r = spawnSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: require('./clean-git-env.js').idiomaFijo() });
  return { code: r.error ? null : r.status, out: String(r.stdout || '').trim(), err: String((r.error && r.error.message) || r.stderr || '').trim().split('\n')[0] };
}

/** La carpeta principal de un repo (la de su `.git` común), o null. */
function mainOf(repo) {
  const common = gitIn(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0 || !common.out) return null;
  return realDir(path.basename(common.out) === '.git' ? path.dirname(common.out) : common.out);
}

const ramaExiste = (main, branch) => gitIn(main, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).code === 0;

/**
 * El primer nombre libre: `nombre`, `nombre-2`, `nombre-3`…, sin carpeta `<principal>--wt-<n>` ni rama `wt/<n>`.
 * `{ name }` o `{ problem }`.
 */
function freeName(repo, name, { max = 50 } = {}) {
  const main = mainOf(repo);
  if (!main) return { problem: `no pude ver el repo ${repo}` };
  for (let i = 1; i <= max; i++) {
    const n = i === 1 ? name : `${name}-${i}`;
    if (!fs.existsSync(`${main}--wt-${n}`) && !ramaExiste(main, `wt/${n}`)) return { name: n };
  }
  return { problem: `las copias ${main}--wt-${name} a -${max} ya existen` };
}

/**
 * Crea la copia. `base`: `origin/main` (de fábrica: se trae antes; sin red no se crea desde una punta vieja) o un commit
 * ya resuelto. `closing`: cómo termina un mensaje de error para quien llama («no la abrí», «no la creé»).
 * `{ ok, path, main, branch, created, base }` o `{ ok: false, message, step }` con el primer renglón del error de git;
 * `step` es `fetch`, `add` o `repo`.
 */
function siblingCopy({ repo, name, branch, base = 'origin/main', closing = 'no la abrí' }) {
  const no = (message, step) => ({ ok: false, message: oneLine(message), step });
  const main = mainOf(repo);
  if (!main) {
    const common = gitIn(repo, ['rev-parse', '--git-common-dir']);
    return no(`No pude ver el repo ${repo} (${common.err || `git salió con código ${common.code}`}): ${closing}.`, 'repo');
  }
  const copyPath = `${main}--wt-${name}`;
  if (fs.existsSync(copyPath)) return no(`La copia ${copyPath} ya existe: no la piso ni la reuso; ${closing}.`, 'repo');
  const exists = ramaExiste(main, branch);
  if (exists && branch === `wt/${name}`) return no(`La rama ${branch} ya existe en ${main}: no la piso ni la reuso; ${closing}.`, 'repo');
  if (base === 'origin/main') {
    const fetched = gitIn(main, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
    if (fetched.code !== 0) return no(`No pude traer main de origin en ${main} (${fetched.err || `git salió con código ${fetched.code}`}): ${closing}.`, 'fetch');
  }
  const add = exists
    ? gitIn(main, ['worktree', 'add', '-q', copyPath, branch])
    : gitIn(main, ['worktree', 'add', '-q', '--no-track', '-b', branch, copyPath, base]);
  if (add.code !== 0) {
    // sólo se saca lo que este add pudo haber dejado: la carpeta si no existía antes, la rama si no existía antes
    const left = removeCopy({ path: copyPath, main, branch, created: !exists }) ? '' : ' Quedó algo de la copia: lo saca el barrido.';
    return no(`No pude crear la copia ${copyPath} (${add.err || `git salió con código ${add.code}`}): ${closing}.${left}`, 'add');
  }
  return { ok: true, path: copyPath, main, branch, created: !exists, base };
}

/**
 * Saca una copia recién creada, y su rama si la creó quien llama. Devuelve true si no quedó ninguna de las dos; lo que
 * no puede sacar queda para el barrido, y quien llama lo dice.
 */
function removeCopy(copy) {
  if (fs.existsSync(copy.path)) gitIn(copy.main, ['worktree', 'remove', '--force', copy.path]);
  gitIn(copy.main, ['worktree', 'prune']);
  if (copy.created) gitIn(copy.main, ['branch', '-D', copy.branch]);
  const branchLeft = copy.created && ramaExiste(copy.main, copy.branch);
  return !fs.existsSync(copy.path) && !branchLeft;
}

module.exports = { siblingCopy, removeCopy, freeName, mainOf, gitIn };
