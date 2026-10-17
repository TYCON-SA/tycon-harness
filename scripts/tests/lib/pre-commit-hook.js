#!/usr/bin/env node
'use strict';

/**
 * pre-commit-hook.js — cuál es el archivo de los controles del pre-commit de un repo, según cómo esté armado.
 *
 * En el arnés `.githooks/pre-commit` sólo llama a `.githooks/pre-commit-checks`, que trae los controles: una suite que
 * copia `.githooks/pre-commit` a un repo de juguete se lleva un archivo que llama a otro que no está, y el commit de
 * juguete sale 1 sin haber medido nada. Las suites eligen el archivo con esta función, para que no se separen.
 *
 * La regla: si el repo trae `pre-commit-checks`, ése es el pre-commit (para los dos tipos: las partes del arnés y de las
 * skills viven ahí juntas); si no, el guion partido de un repo de antes (`pre-commit-harness` o `pre-commit-skills`);
 * si no, `pre-commit`. Nunca inventa: devuelve la ruta aunque el archivo no exista, y quien llama decide qué hacer.
 *
 *   const { preCommitHook } = require('./lib/pre-commit-hook.js');
 *   const HOOK = preCommitHook('harness', RAIZ);          // los controles del arnés
 *   const hook = preCommitHook('skills', repoDeSkills);   // los de las skills
 *
 * Desde shell:  HOOK="$(node "$RAIZ/scripts/tests/lib/pre-commit-hook.js" harness "$RAIZ")"
 *   exit 0 = imprimió la ruta · exit 2 = argumentos inválidos (no imprime nada por stdout).
 */

const fs = require('fs');
const path = require('path');

// el archivo con los controles de los dos tipos (el arnés y las skills)
const CHECKS_NAME = 'pre-commit-checks';
// el guion partido de un repo de antes del control único
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
  for (const name of [CHECKS_NAME, split]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, 'pre-commit');
}

module.exports = { preCommitHook, SPLIT_NAMES, CHECKS_NAME };

if (require.main === module) {
  const [kind, repoRoot] = process.argv.slice(2);
  try {
    process.stdout.write(`${preCommitHook(kind, repoRoot)}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\nuso: pre-commit-hook.js <harness|skills> <raíz del repo>\n`);
    process.exit(2);
  }
}
