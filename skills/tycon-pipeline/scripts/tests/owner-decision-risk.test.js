#!/usr/bin/env node
'use strict';
/**
 * owner-decision-risk.test.js — la decisión del dueño en la historia cuenta como riesgo alto.
 *
 *   T10 `riesgo_alto_por:` (lista o escalar) da `riesgo-alto-por` y gana sobre las otras reglas; `[]` no cuenta; la
 *       aprobación delegada del plan se niega
 *   T11 un archivo de dependencias declarado da `dependencias`; un valor fuera de la lista frena el lint
 *
 * stable-data: escribe historias y repos en carpetas temporales; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/owner-decision-risk.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const { computeDelicate } = require(path.join(SCRIPTS, 'pipeline.js'));
const riskPaths = require(path.join(SCRIPTS, 'lib', 'risk-paths.js'));
const planReview = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
const LINT = path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'lint-story-frontmatter.js');

function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'odr-')));
  execFileSync('git', ['init', '-q', d]);
  fs.mkdirSync(path.join(d, 'specs'), { recursive: true });
  return d;
}
function historia(d, fm, nombre = 'story-9.9-prueba.md') {
  const s = path.join(d, 'specs', nombre);
  fs.writeFileSync(s, `---\nepic: 9\nstory: "9.9"\ntitle: "prueba"\nstatus: draft\n${fm}---\n\n# Story 9.9\n`);
  return s;
}

test('T10 RiesgoAltoPor_DaRiesgoAlto — @story-8.174 @ac-10', () => {
  const d = repo();
  const lista = computeDelicate({ story: historia(d, 'riesgo_alto_por: [plata]\nfiles_to_modify:\n  - src/app.js\n'), repo: d });
  assert.equal(lista.value, true);
  assert.equal(lista.rule, 'riesgo-alto-por');
  assert.match(lista.reason, /plata/);
  const escalar = computeDelicate({ story: historia(d, 'riesgo_alto_por: plata\nfiles_to_modify:\n  - src/app.js\n'), repo: d });
  assert.equal(escalar.rule, 'riesgo-alto-por');
  const bloque = computeDelicate({ story: historia(d, 'riesgo_alto_por:\n  - clientes\n  - personas\nfiles_to_modify:\n  - src/app.js\n'), repo: d });
  assert.equal(bloque.rule, 'riesgo-alto-por');
  // la lista en bloque con el guion en la columna 0 también vale; un comentario solo en el renglón no es un valor
  // (hallazgos del pase adversarial)
  const col0 = computeDelicate({ story: historia(d, 'riesgo_alto_por:\n- plata\nfiles_to_modify:\n  - src/app.js\n'), repo: d });
  assert.equal(col0.rule, 'riesgo-alto-por');
  assert.deepStrictEqual(riskPaths.leerRiesgoAltoPor('riesgo_alto_por:\n- plata\n- clientes\nfiles_to_modify:\n- src/a.js\n').valores, ['plata', 'clientes']);
  assert.deepStrictEqual(riskPaths.leerRiesgoAltoPor('riesgo_alto_por: # lo decide el dueño\n  - plata\n').valores, ['plata']);
  assert.deepStrictEqual(riskPaths.leerRiesgoAltoPor('riesgo_alto_por: [plata] # nota\n').valores, ['plata']);
  // gana sobre `sensible:` y sobre una ruta sensible
  const gana = computeDelicate({ story: historia(d, 'sensible: [pagos]\nriesgo_alto_por: [alcance]\nfiles_to_modify:\n  - src/auth/x.js\n'), repo: d });
  assert.equal(gana.rule, 'riesgo-alto-por');
  // vacía o ausente: no cuenta
  const vacia = computeDelicate({ story: historia(d, 'riesgo_alto_por: []\nfiles_to_modify:\n  - src/app.js\n'), repo: d });
  assert.equal(vacia.value, false);
  assert.deepStrictEqual(riskPaths.leerRiesgoAltoPor('riesgo_alto_por: []\n').valores, []);
  assert.deepStrictEqual(riskPaths.leerRiesgoAltoPor('riesgo_alto_por: [plata, otra]\n'), { valores: ['plata', 'otra'], invalidos: ['otra'] });
  // la aprobación delegada del plan se niega: el plan de una historia así lo aprueba una persona
  const s = historia(d, 'riesgo_alto_por: [plata]\nfiles_to_modify:\n  - src/app.js\n');
  const r = planReview.antesDeAprobar({ estado: fs.mkdtempSync(path.join(os.tmpdir(), 'odr-e-')), firmante: 'coord', destino: 'otra',
    marker: { storyId: '9.9', storyPath: s, repoPath: d } });
  assert.equal(r.codigo, 2);
  assert.match(r.motivo, /plan delicado/);
  assert.match(r.motivo, /riesgo-alto-por/);
});

test('T11 Dependencias_DaRiesgoAlto_YValorInvalidoFrenaElLint — @story-8.174 @ac-10', () => {
  const d = repo();
  for (const dep of ['package.json', 'src/Api/Api.csproj', 'requirements-dev.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle.kts']) {
    const r = computeDelicate({ story: historia(d, `files_to_modify:\n  - src/app.js\n  - ${dep}\n`), repo: d });
    assert.equal(r.rule, 'dependencias', dep);
  }
  // también uno que se crea
  assert.equal(computeDelicate({ story: historia(d, 'files_to_create:\n  - web/package.json\n'), repo: d }).rule, 'dependencias');
  // las reglas por archivo van antes que dependencias
  assert.equal(computeDelicate({ story: historia(d, 'files_to_modify:\n  - package.json\n  - db/001.sql\n'), repo: d }).rule, 'porton-instalador-migracion');
  // el lint del frontmatter frena un valor fuera de la lista y deja pasar uno de la lista
  const mala = historia(d, 'riesgo_alto_por: [otra]\n', 'story-9.8-mala.md');
  const buena = historia(d, 'riesgo_alto_por: [plata, clientes]\n', 'story-9.7-buena.md');
  const env = { ...process.env, STORIES_DIR: path.join(d, 'specs') };
  const rm = spawnSync(process.execPath, [LINT, mala], { cwd: d, env, encoding: 'utf8' });
  assert.notEqual(rm.status, 0, rm.stdout + rm.stderr);
  assert.match(rm.stdout + rm.stderr, /riesgo_alto_por/);
  assert.match(rm.stdout + rm.stderr, /otra/);
  const rb = spawnSync(process.execPath, [LINT, buena], { cwd: d, env, encoding: 'utf8' });
  assert.doesNotMatch(rb.stdout + rb.stderr, /riesgo_alto_por/);
});
