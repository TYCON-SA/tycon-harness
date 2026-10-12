#!/usr/bin/env node
'use strict';

/**
 * pre-commit-hook.js — cuál es el archivo del pre-commit de un repo, según cómo esté armado (story 8.7, tanda B).
 *
 * Por qué existe: en el repo del equipo el arnés y agent-skills son dos repos y cada uno trae su `.githooks/pre-commit`.
 * En la copia pública de UN solo repo ese archivo es un despachador generado por el exportador, que corre
 * `pre-commit-harness` y `pre-commit-skills`; los guiones de verdad son esos dos. Una suite que copia
 * `.githooks/pre-commit` a un repo de juguete se lleva, en la copia, el despachador sin sus dos guiones: el commit de
 * juguete sale 1 y la suite queda en rojo sin haber medido nada. Tres suites hacían esa elección cada una por su lado
 * (`githook-livefire.test.sh`, `new-names.test.js`, `third-party-skills.test.js`); vive acá para que no se separen.
 *
 * La regla: si el repo trae el guion partido (`pre-commit-harness` o `pre-commit-skills`), ése es el pre-commit; si no,
 * `pre-commit`. Nunca inventa: devuelve la ruta aunque el archivo no exista, y quien llama decide qué hacer con eso.
 *
 *   const { preCommitHook } = require('./lib/pre-commit-hook.js');
 *   const HOOK = preCommitHook('harness', RAIZ);          // el del arnés
 *   const hook = preCommitHook('skills', repoDeSkills);   // el de agent-skills
 *
 * Desde shell:  HOOK="$(node "$RAIZ/scripts/tests/lib/pre-commit-hook.js" harness "$RAIZ")"
 *   exit 0 = imprimió la ruta · exit 2 = argumentos inválidos (no imprime nada por stdout).
 */

const fs = require('fs');
const path = require('path');

// el nombre que el exportador le da a cada guion cuando junta los dos repos en uno (export.js, «merged-hooks»)
const SPLIT_NAMES = { harness: 'pre-commit-harness', skills: 'pre-commit-skills' };

/**
 * @param {'harness'|'skills'} kind  de qué repo es el guion que se busca
 * @param {string} repoRoot          la raíz del repo donde vive `.githooks/`
 * @returns {string} la ruta del guion del pre-commit de ese repo
 */
function preCommitHook(kind, repoRoot) {
  const split = SPLIT_NAMES[kind];
  if (!split) throw new Error(`pre-commit-hook: tipo desconocido «${kind}» — los que hay: ${Object.keys(SPLIT_NAMES).join(', ')}`);
  if (!repoRoot || typeof repoRoot !== 'string') throw new Error('pre-commit-hook: falta la raíz del repo');
  const dir = path.join(repoRoot, '.githooks');
  const candidate = path.join(dir, split);
  return fs.existsSync(candidate) ? candidate : path.join(dir, 'pre-commit');
}

module.exports = { preCommitHook, SPLIT_NAMES };

if (require.main === module) {
  const [kind, repoRoot] = process.argv.slice(2);
  try {
    process.stdout.write(`${preCommitHook(kind, repoRoot)}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\nuso: pre-commit-hook.js <harness|skills> <raíz del repo>\n`);
    process.exit(2);
  }
}
