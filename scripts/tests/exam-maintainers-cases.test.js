'use strict';
/**
 * exam-maintainers-cases.test.js — el examen de revisores suma los casos del clon de mantenimiento.
 *
 * El examen corre desde el árbol instalado, y los casos de algunos revisores viven sólo en el repo de mantenimiento.
 * El corredor lee los casos de su propio árbol y, además, los del repo del examen (`lugarDelExamen` de
 * periodic-exam.js: el clon de `paths.maintainers`, o TYCON_EXAM_REPO), los mismos de los que el examen ya lee su
 * configuración. Un archivo de casos con el mismo nombre en los dos lados sale del árbol propio.
 *
 * No llama a ningún modelo: usa `--list`. Con un clon de juguete, sin el repo privado.
 * Correr: node --test scripts/tests/exam-maintainers-cases.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const RUNNER = path.join(RAIZ, 'scripts', 'controls-bench', 'advisor-runner.js');
const CASOS_PROPIOS = path.join(RAIZ, 'scripts', 'controls-bench', 'cases', 'advisors');

function caso(advisor, id) {
  return { advisor, canario_ausente: 'caso de juguete', cases: [{ id, type: 'must-flag', rule: 'ACME-C1', files: { 'src/a.cs': '// x\n' } }] };
}

/** Un clon de mantenimiento de juguete con sus archivos de casos. */
function clon(home, archivos) {
  const dir = path.join(home, 'mantenimiento');
  const casos = path.join(dir, 'scripts', 'controls-bench', 'cases', 'advisors');
  fs.mkdirSync(casos, { recursive: true });
  for (const [nombre, contenido] of Object.entries(archivos)) fs.writeFileSync(path.join(casos, nombre), JSON.stringify(contenido));
  return dir;
}

function listar(home, extra = {}) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home }, extra);
  for (const k of ['TYCON_EXAM_REPO', 'TYCON_EXAM_CONFIG', 'TYCON_SKILLS_DIR']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [RUNNER, '--list'], { env, encoding: 'utf8', timeout: 60000 });
}
const enHome = (fn) => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-casos-')); try { fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); } };
const total = (out) => Number((String(out).match(/— (\d+) caso\(s\)/) || [])[1]);

test('M1 Runner_MaintainersClone_AddsItsCases — los casos que viven sólo en el clon entran al examen', () => enHome((home) => {
  const solo = listar(home);
  assert.strictEqual(solo.status, 0, solo.stderr);
  const dir = clon(home, { 'acme-toy-reviewer.json': caso('acme-toy-reviewer', 'acme-caso-del-clon') });
  const r = listar(home, { TYCON_EXAM_REPO: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /acme-toy-reviewer :: acme-caso-del-clon/);
  assert.strictEqual(total(r.stdout), total(solo.stdout) + 1);
  assert.match(r.stderr, /mantenimiento/, 'dice de dónde salieron los casos sumados');
}));

test('M2 Runner_SameFileInBoth_OwnTreeWins — un archivo con el mismo nombre sale del árbol propio', () => enHome((home) => {
  const propio = fs.readdirSync(CASOS_PROPIOS).filter((f) => f.endsWith('.json')).sort()[0];
  const solo = listar(home);
  const dir = clon(home, { [propio]: caso('acme-impostor', 'acme-no-tiene-que-aparecer') });
  const r = listar(home, { TYCON_EXAM_REPO: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /acme-no-tiene-que-aparecer/);
  assert.strictEqual(total(r.stdout), total(solo.stdout));
}));

test('M3 Runner_NoClone_SameAsToday — sin clon de mantenimiento, sólo los casos propios', () => enHome((home) => {
  const r = listar(home, { TYCON_EXAM_REPO: path.join(home, 'no-existe') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(total(r.stdout), total(listar(home).stdout));
}));
