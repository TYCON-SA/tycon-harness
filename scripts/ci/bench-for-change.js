#!/usr/bin/env node
'use strict';

/**
 * bench-for-change.js — ¿el banco de controles corre en la validación de este cambio? `si` o `no`.
 *
 * POR QUÉ: la validación de cada pedido del repo de mantenimiento (pipelines/azure-pipelines-maintainers-pr.yml) corría
 * el banco entero (8,5 a 9,6 min) en todo pedido con código, aunque el pedido sólo tocara una prueba o un dato de
 * prueba que el banco no lee (un pedido que sólo toca `scripts/tests/fixtures/product-pipeline/BASE`, o sólo tres
 * `legacy-names-*.test.js`). La regla: en el pedido el banco corre sólo si el cambio toca lo que el banco lee; el banco
 * nocturno lo corre entero todas las noches, y en `main` corre siempre.
 *
 * LA REGLA, AL REVÉS DE UNA LISTA DE DISPAROS: lo que el banco lee es casi todo el arnés (los frenos, sus bibliotecas,
 * las skills, las integraciones, los revisores, lo que esos leen a su vez), y una lista de «lo que dispara» escrita a
 * mano se queda corta el día que un control nuevo lee otra carpeta. Por eso la lista es la de lo que el banco NO lee,
 * cerrada y chica, y todo lo demás dispara: el banco se saltea sólo si CADA archivo del cambio está en ella.
 *
 *   1. Una suite: un archivo `*.test.js` o `*.test.sh` (también las partes `.p<k>.test.*`) bajo `scripts/tests/`.
 *      Salvo las de `scripts/tests/windows/` y `scripts/tests/lib/`, y las que corre el freno del empuje
 *      (`PRE_PUSH_SUITES`: scripts/hooks/pre-push-repo-rules.js las corre de verdad).
 *   2. Un dato de prueba dentro de una SUBCARPETA de `scripts/tests/fixtures/`. Salvo `fixtures/codex-typed/`, que lee
 *      scripts/lib/codex-typed-verdict.js. Los archivos sueltos de `fixtures/` (sin subcarpeta) disparan: los leen
 *      piezas que el banco corre (scripts/setup/harness/layer.js y managed.js, scripts/lib/stable-test-data.js).
 *
 * Quién lee algo de `scripts/tests/` desde el código que el banco corre está anotado en `READERS`, con qué lee. La
 * prueba scripts/tests/bench-for-change.test.js recorre ese código y se pone roja si aparece un lector nuevo: ahí se
 * decide si lo que lee tiene que salir de la lista de arriba.
 *
 * ANTE LA DUDA, CORRE. Sale `si` (y dice por qué) cuando:
 *   · no hay lista (`--changed` no vino, no se deja leer o está vacía) o quien llama dice que no pudo acotar (`--all`);
 *   · la rama es `main` (`--branch main` o `refs/heads/main`): ahí corre siempre;
 *   · algún renglón no es una ruta limpia (comillas de git, `\`, `.` o `..` como tramo, un tramo vacío, ruta absoluta);
 *   · cualquier error inesperado: se atrapa, se dice y sale `si`.
 * Nunca sale distinto de 0 por no poder decidir: quien llama lee la palabra. Si no lee exactamente `no`, corre.
 *
 * Uso:  node scripts/ci/bench-for-change.js --changed <archivo con una ruta por línea> [--all] [--branch <rama>]
 * Salida: `si` o `no` en stdout, solo; el motivo en una línea por stderr. Sale 0.
 *
 * Red: scripts/tests/bench-for-change.test.js
 */

const fs = require('fs');

/** Las suites que corre el freno del empuje (scripts/hooks/pre-push-repo-rules.js, `SUITES`): el banco lo ejercita. */
const PRE_PUSH_SUITES = [
  'scripts/tests/node-floor.test.js',
  'scripts/tests/suites-listed.test.js',
  'scripts/tests/suites-coverage.test.js',
];

/** Carpetas de `scripts/tests/` que el código del banco lee: nada de adentro se saltea. */
const READ_TEST_FOLDERS = ['scripts/tests/windows/', 'scripts/tests/lib/'];

/** Subcarpetas de `scripts/tests/fixtures/` que el código del banco lee. */
const READ_FIXTURE_FOLDERS = ['scripts/tests/fixtures/codex-typed/'];

/**
 * El código que el banco corre y lee algo de `scripts/tests/`, con qué lee. Lo mantiene al día la prueba: un lector que
 * no está acá la pone roja. Nombrar una suite o suites.json no cambia la regla (suites.json no es una suite y dispara).
 */
const READERS = {
  'scripts/controls-bench/runner.js': 'scripts/tests/windows/known-gaps.json',
  'scripts/hooks/pre-push-repo-rules.js': 'las suites de PRE_PUSH_SUITES (y una de skills/)',
  'scripts/lib/codex-typed-verdict.js': 'scripts/tests/fixtures/codex-typed/',
  'scripts/lib/harness-audit.js': 'una prueba de skills/ (no de scripts/tests/)',
  'scripts/lib/stable-test-data.js': 'scripts/tests/fixtures/stable-test-data-baseline*.json (sueltos: disparan)',
  'scripts/setup/harness/layer.js': 'archivos sueltos de scripts/tests/fixtures/ (disparan)',
  'scripts/setup/harness/managed.js': 'scripts/tests/fixtures/harness-managed-pieces.json (suelto: dispara)',
  'scripts/tools/site-guide-captures.js': 'scripts/tests/lib/ (dispara)',
  'skills/tycon-pipeline/scripts/lib/adhoc-list.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/lib/failed-first.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/lib/inherited-reds.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/lib/isolated-run.js': 'scripts/tests/lib/real-home-guard.js, la red que precarga en la ejecución aislada (scripts/tests/lib/: dispara)',
  'skills/tycon-pipeline/scripts/lib/main-check.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/lib/nightly-coverage.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/lib/run-suites-json.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/lib/test-runners.js': 'scripts/tests/suites.json (dispara)',
  'skills/tycon-pipeline/scripts/package-equivalence.js': 'una fixture de skills/ (no de scripts/tests/)',
  'skills/tycon-pipeline/scripts/test-gate.sh': 'scripts/tests/suites.json (dispara)',
};

/** Las carpetas del código que el banco corre, donde la prueba busca lectores de `scripts/tests/`. */
const READER_ROOTS = ['scripts/hooks', 'scripts/lib', 'scripts/controls-bench', 'scripts/setup', 'scripts/tools', 'integrations', 'adapters', 'build', 'skills'];

/** Una ruta limpia, relativa, con `/`: sin comillas, `\`, tramos vacíos, `.` ni `..`. Si no, no se juzga: dispara. */
function cleanPath(rel) {
  if (!rel || rel.startsWith('/') || rel.startsWith('"') || rel.includes('\\')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Por qué el banco NO lee este archivo, o null si lo lee (o no se sabe). */
function notRead(rel) {
  if (!cleanPath(rel) || !rel.startsWith('scripts/tests/')) return null;
  if (READ_TEST_FOLDERS.some((dir) => rel.startsWith(dir))) return null;
  if (rel.startsWith('scripts/tests/fixtures/')) {
    const inside = rel.slice('scripts/tests/fixtures/'.length);
    if (!inside.includes('/')) return null;
    if (READ_FIXTURE_FOLDERS.some((dir) => rel.startsWith(dir))) return null;
    return 'dato de prueba';
  }
  if (PRE_PUSH_SUITES.includes(rel)) return null;
  return /\.test\.(js|sh)$/.test(rel) ? 'suite' : null;
}

/** La decisión: `{ run: boolean, why: string }`. */
function decide({ lines, all = false, branch = null }) {
  const name = typeof branch === 'string' ? branch.replace(/^refs\/heads\//, '') : '';
  if (name === 'main') return { run: true, why: 'la rama es main: ahí el banco corre siempre' };
  if (all) return { run: true, why: 'quien llama no pudo acotar el cambio (--all): corre' };
  if (!Array.isArray(lines)) return { run: true, why: 'no hay lista del cambio: corre' };
  const files = lines.map((l) => l.replace(/\r$/, '').trim()).filter(Boolean);
  if (!files.length) return { run: true, why: 'la lista del cambio está vacía: «nada» no es «no toca», corre' };
  const reads = files.filter((f) => notRead(f) === null);
  if (reads.length) {
    const some = reads.slice(0, 3).join(' ') + (reads.length > 3 ? ` (y ${reads.length - 3} más)` : '');
    return { run: true, why: `el cambio toca ${reads.length} archivo(s) que el banco lee o que no sé juzgar: ${some}` };
  }
  const suites = files.filter((f) => notRead(f) === 'suite').length;
  return { run: false, why: `el cambio sólo toca lo que el banco no lee (${suites} suite(s), ${files.length - suites} dato(s) de prueba): el banco lo corre el nocturno` };
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

function main(argv, write = (t) => process.stdout.write(t), complain = (t) => process.stderr.write(t)) {
  let verdict;
  try {
    let lines = null;
    let missing = '';
    const file = option(argv, '--changed');
    if (file) {
      try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { missing = ` (la lista ${file} no se deja leer: ${e.code || e.message})`; }
    }
    verdict = decide({ lines, all: argv.includes('--all'), branch: option(argv, '--branch') });
    if (missing) verdict.why += missing;
  } catch (e) {
    verdict = { run: true, why: `no pude decidir (${e.message}): corre` };
  }
  complain(`banco: ${verdict.run ? 'corre' : 'no corre'} — ${verdict.why}\n`);
  write(`${verdict.run ? 'si' : 'no'}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, decide, notRead, PRE_PUSH_SUITES, READ_TEST_FOLDERS, READ_FIXTURE_FOLDERS, READERS, READER_ROOTS };
