'use strict';
/**
 * clean-git-env.js —el git de un sandbox no puede terminar escribiendo en el repo de verdad.
 *
 * 🔴 EL CASO. 2026-09-27: un commit que tocaba `agents/tycon-e2e-realness-checker.md` disparó el
 * chequeo de vida del pre-commit (`advisor-liveness-on-change.js`), el chequeo armó su fixture con
 * `mkFixture()`, y los `git init && git add -A && git commit -qm fixture` del fixture cayeron
 * SOBRE LA RAMA DEL DEV: dos commits `fixture` en la punta, y el árbol del repo reemplazado por el
 * del fixture (un `.spec.ts` de juguete). Se recuperó con `git reset`, pero el commit se perdió y
 * el trabajo estuvo a un `git gc` de ser irrecuperable.
 *
 * POR QUÉ. git le exporta a sus hooks `GIT_DIR`, `GIT_INDEX_FILE` y compañía. Cualquier `git` que
 * un hook lance las hereda, y esas variables GANAN sobre el `cwd`: `git init` crea el repo del
 * sandbox, y el `git add` siguiente igual escribe en el índice que dice `GIT_INDEX_FILE`. Por eso
 * no se ve nunca en un checkout normal —ahí `GIT_DIR` vale `.git`, relativo, y con `cwd` en el
 * sandbox apunta al `.git` del sandbox— y sí se ve desde un worktree, donde es absoluto.
 *
 * LA REGLA. Todo comando que un script del arnés corra DENTRO de un sandbox va con este env: el
 * `cwd` tiene que ser la única cosa que decide sobre qué repo se opera.
 */

// `GIT_PREFIX` y `GIT_PROTOCOL` no rompen nada pero tampoco significan nada fuera del repo padre.
const DEL_PADRE = [
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_VERSION',
  'GIT_QUARANTINE_PATH', 'GIT_PUSH_CERT_NONCE', 'GIT_EDITOR', 'GIT_REFLOG_ACTION',
];

/** Copia de `base` (por defecto, el entorno propio) sin las variables que git le pasa a sus hooks. */
function sinGitDelPadre(...extras) {
  const env = Object.assign({}, process.env, ...extras.filter(Boolean));
  for (const k of DEL_PADRE) delete env[k];
  return env;
}

module.exports = { sinGitDelPadre, DEL_PADRE };
