'use strict';
// story-reader-parity.test.js — el portón de CI, el freno del commit y el descubridor de historias leen el frontmatter
// igual (A34). Vive en scripts/tests y no en las pruebas de las skills porque carga el portón (scripts/ci), que en un
// clon de las skills solas no está.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const discovery = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-discovery.js'));

test('el freno del commit, el portón de CI y el descubridor leen igual el estado y el número (A34)', () => {
  // 🔴 rojo: el portón y el freno leían `status: done   # nota` y `story: "9.2"   # nota` con su regex propio. La historia
  //    se le escapaba al portón y al freno del commit, y el índice la mostraba `done`: dos lectores distintos del mismo
  //    archivo son un hueco.
  const ROOT_ARNES = path.join(__dirname, '..', '..');
  // el portón carga el lector del skill que diga la variable: en la prueba, el de este clon (no el instalado)
  const antes = process.env.TYCON_SKILLS_DIR;
  process.env.TYCON_SKILLS_DIR = path.join(ROOT_ARNES, 'skills');
  const gate = require(path.join(ROOT_ARNES, 'scripts', 'ci', 'tycon-ci-gate.js'));
  try { gate.escalar('status: x', 'status'); } finally { if (antes === undefined) delete process.env.TYCON_SKILLS_DIR; else process.env.TYCON_SKILLS_DIR = antes; }
  const freno = require(path.join(ROOT_ARNES, 'skills', 'tycon-pipeline', 'scripts', 'on-pre-commit.js'));
  const casos = [
    ['status: done   # nota', 'status', 'done'], ['status:  # x', 'status', null], ['status: "done # no"  # si', 'status', 'done # no'],
    ['story: "9.2"   # nota', 'story', '9.2'], ["story: '9.3'\t# t", 'story', '9.3'], ['title: C# y más', 'title', 'C# y más'],
    ['status: "done"\nstatus: review', 'status', 'done'], ['status: review\nstatus: "done"', 'status', 'review'],
    ['status: done\r', 'status', 'done'], ['status:\nepic: 3', 'status', null],
  ];
  for (const [fm, k, esperado] of casos) {
    assert.strictEqual(discovery.fmScalar(fm, k), esperado, `descubridor: ${JSON.stringify(fm)}`);
    assert.strictEqual(gate.escalar(fm, k), esperado, `portón: ${JSON.stringify(fm)}`);
  }
  // el freno del commit reconoce la historia con comentario en el número y en el estado, como el descubridor
  const texto = (id, st) => `---\nstory: ${id}\nstatus: ${st}\nepic: 9\n---\n# h\n`;
  assert.strictEqual(freno.looksLikeStorySpec(texto('"9.2"   # nota', 'done   # nota')), true);
  assert.strictEqual(freno.looksLikeStorySpec(texto('"9.2"', '  # sin estado')), false);
});

test('el portón avisa cuando no carga el lector del skill (A34, segunda vuelta)', () => {
  // 🔴 rojo: sin el skill, el portón volvía a la lectura vieja sin decir nada, y su «✅ ninguna story pasa…» lo tapaba
  const gate = path.join(__dirname, '..', 'ci', 'tycon-ci-gate.js');
  const r = require('child_process').spawnSync(process.execPath, ['-e', `require(${JSON.stringify(gate)}).escalar('status: done', 'status')`], { encoding: 'utf8', env: { ...process.env, TYCON_SKILLS_DIR: path.join(os.tmpdir(), 'sin-skill-a34') } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /portón: el lector del frontmatter del skill no cargó/);
});

