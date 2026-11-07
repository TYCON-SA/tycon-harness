'use strict';
// review-docs.test.js — la documentación de las revisiones automáticas dice lo que hace el código.
//
// Lo que no se puede perder:
//   · las guías y los pasos nombran la matriz del plan, la del código, el revisor elegible y lo que hace la coordinadora;
//   · las 18 opciones del sitio están en las dos guías del sitio y en la guía nueva, en los dos idiomas;
//   · los valores de fábrica de las tablas son los que devuelve el lector sin configuración: si uno cambia sin el otro,
//     esta prueba se pone roja.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const P = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-policy.js'));
const RR = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'review-runner.js'));

const CLAVES = ['plan_review.delicate', 'plan_review.routine', 'plan_review.routine_owner_away', 'plan_review.coordinator_approves',
  'plan_review.rejected_reaches_owner', 'deep_review.delicate', 'deep_review.small_max_files', 'deep_review.small_routine_day',
  'deep_review.small_routine_owner_away', 'deep_review.large_routine', 'review_runner.order[0]', 'review_runner.order',
  'plan_review.owner_away_minutes', 'review_runner.custom_command', 'review.max_rounds', 'review_runner.verifiers',
  'review.blocking_severity', 'plan_review.lenses'];

/** Las filas `| O<n> | … |` de una tabla de opciones: `{ id, clave, fabrica }`, con la clave y el valor de fábrica sin comillas. */
function opciones(texto) {
  const out = [];
  for (const l of texto.split('\n')) {
    const m = l.match(/^\| (O\d+) \|/);
    if (!m) continue;
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    out.push({ id: c[0], clave: c[2].replace(/`/g, ''), fabrica: c[4].replace(/`/g, '') });
  }
  return out;
}

/** El valor de fábrica que devuelve el lector sin configuración, escrito como en las tablas. */
function deFabrica(clave) {
  const v = P.normalize({}).values;
  if (clave === 'review_runner.order[0]') return RR.DEFAULT_ORDER[0];
  if (clave === 'review_runner.order') return JSON.stringify(RR.DEFAULT_ORDER);
  if (clave === 'review_runner.custom_command') return '—';
  const [sec, k] = clave.split('.');
  const x = v[sec][k];
  return Array.isArray(x) ? JSON.stringify(x) : String(x);
}

test('ReviewDocs_FirmasDelArnesDiceLaMatrizDelPlan (T39) @story-8.221 @ac-29', () => {
  const g = leer('guides/firmas-del-arnes.md');
  const nota = g.split('\n').filter((l) => l.startsWith('- \\*\\*') || l.startsWith('  ')).join('\n');
  for (const salida of [/\*\*aprobado\*\*/, /\*\*rechazado\*\*/, /\*\*sin veredicto\*\*/]) assert.match(nota, salida);
  assert.match(g, /plan_review/);
  assert.doesNotMatch(g, /no\s+puede lanzar su propia revisión/);
  assert.match(g, /sólo informa y nunca firma/);
});

test('ReviewDocs_Step04TraeElFlujoConYSinCoordinadora (T40) @story-8.221 @ac-30', () => {
  const s = leer('skills/tycon-pipeline/steps/step-04-approve-plan.md');
  for (const r of [/4a\. Aprobado/, /4b\. Rechazado/, /4c\. Sin veredicto/, /4d\. Sin revisión/]) assert.match(s, r);
  assert.match(s, /marker\.js plan-review --for-session <sesión>/);
  assert.match(s, /`marker\.js plan-review` \(sin `--for-session`\)/);
  assert.match(s, /review-ask --kind plan/);
});

test('ReviewDocs_Step08TraeLaMatrizDelCodigo (T41) @story-8.221 @ac-31', () => {
  const s = leer('skills/tycon-pipeline/steps/step-08-adversarial-pass.md');
  for (const k of ['deep_review.delicate', 'deep_review.large_routine', 'deep_review.small_routine_day', 'deep_review.small_routine_owner_away', 'deep_review.small_max_files']) assert.ok(s.includes(k), k);
  const sin = s.split('## Sin Codex ni Workflow')[1] || '';
  assert.match(sin.split('\n## ')[0], /revisor de la lista/);
});

test('ReviewDocs_OrganizationSiteNombraLas18OpcionesEnLosDosIdiomas (T42) @story-8.221 @ac-32', () => {
  for (const f of ['guides/organization-site.md', 'guides/organization-site.en.md']) {
    const o = opciones(leer(f));
    assert.deepStrictEqual(o.map((x) => x.id), Array.from({ length: 18 }, (_, i) => `O${i + 1}`), f);
    assert.deepStrictEqual(o.map((x) => x.clave), CLAVES, f);
  }
});

test('ReviewDocs_CoordinationDiceQueHaceLaCoordinadora (T43) @story-8.221 @ac-33', () => {
  const es = leer('guides/coordination.md').split('## Las revisiones automáticas: qué hace la coordinadora')[1] || '';
  const sec = es.split('\n## ')[0];
  for (const r of [/\*\*Pregunta o no\.\*\*/, /\*\*Lanza la revisión del plan\*\*/, /O4/, /\*\*Da el turno del pase del código\.\*\*/, /owner-away set/]) assert.match(sec, r);
  const en = leer('guides/coordination.en.md').split('## The automatic reviews: what the coordinator does')[1] || '';
  for (const r of [/\*\*Asks or not\.\*\*/, /\*\*Launches the plan review\*\*/, /O4/, /\*\*Gives the code pass its turn\.\*\*/, /owner-away set/]) assert.match(en.split('\n## ')[0], r);
});

test('ReviewDocs_LaGuiaNuevaYSuRenglon (T44) @story-8.221 @ac-34', () => {
  const es = leer('guides/revisiones-automaticas.md');
  const en = leer('guides/revisiones-automaticas.en.md');
  for (const r of [/## Matriz 1: la revisión del plan/, /## Matriz 2: la revisión del código/, /## Matriz 3: con qué corre la revisión/]) assert.match(es, r);
  for (const r of [/## Matrix 1: the plan review/, /## Matrix 2: the code review/, /## Matrix 3: what runs the review/]) assert.match(en, r);
  assert.match(leer('INDEX.md'), /guides\/revisiones-automaticas\.md/);
});

test('ReviewDocs_LosValoresDeFabricaCoincidenConElLector (T45) @story-8.221 @ac-35', () => {
  for (const f of ['guides/revisiones-automaticas.md', 'guides/revisiones-automaticas.en.md', 'guides/organization-site.md', 'guides/organization-site.en.md']) {
    const o = opciones(leer(f));
    assert.strictEqual(o.length, 18, f);
    for (const x of o) assert.strictEqual(x.fabrica, deFabrica(x.clave), `${f} ${x.id} (${x.clave})`);
  }
});

test('Medicion_VerificadoresAntesYDespues (T51) @story-8.221 @ac-40 — el mismo plan con los dos modos: per_lens usa menos agentes y tokens y no pierde un confirmado sin nombrarlo', () => {
  const dato = (n) => JSON.parse(leer(`scripts/tests/fixtures/review-measurement/${n}.json`));
  const pf = dato('per-finding');
  const pl = dato('per-lens');
  // el mismo plan, las mismas lentes y el mismo modelo: lo único que cambia es el verificador
  assert.deepStrictEqual([pf.verifiers, pl.verifiers], ['per_finding', 'per_lens']);
  assert.deepStrictEqual([pf.plan, pf.model, pf.lenses], [pl.plan, pl.model, pl.lenses]);
  assert.ok(pf.medido && pl.medido, 'las dos corridas midieron todo');
  // los números salen de los resultados: el total es la suma de sus fases, y los agentes de cada fase cuadran
  for (const r of [pf, pl]) {
    const fases = Object.values(r.corredor.tokens.por_fase).reduce((a, b) => a + b, 0);
    assert.strictEqual(r.corredor.tokens.total, fases, `${r.verifiers}: el total es la suma de las fases`);
    assert.strictEqual(r.corredor.agentes.Hunt, r.lenses.length, `${r.verifiers}: un cazador por lente`);
  }
  assert.strictEqual(pl.corredor.agentes.Verify, pl.lenses.length, 'per_lens: un verificador por lente');
  assert.strictEqual(pf.corredor.agentes.Verify, pf.hallazgos, 'per_finding: un verificador por hallazgo');
  const agentes = (r) => r.corredor.agentes.Hunt + r.corredor.agentes.Verify;
  assert.ok(agentes(pl) < agentes(pf), `per_lens usa menos agentes: ${agentes(pl)} contra ${agentes(pf)}`);
  assert.ok(pl.corredor.tokens.total < pf.corredor.tokens.total, `per_lens usa menos tokens: ${pl.corredor.tokens.total} contra ${pf.corredor.tokens.total}`);
  // cada confirmado de per_finding está en per_lens o nombrado como diferencia, nunca los dos ni ninguno
  const enPl = new Set(pl.confirmed.map((c) => c.id));
  const diferentes = new Set(pf.diferencias.map((d) => d.id));
  for (const c of pf.confirmed) {
    const par = pf.equivalentes_en_per_lens[c.id];
    assert.ok(Boolean(par) !== diferentes.has(c.id), `${c.id}: está en per_lens o es una diferencia, no las dos`);
    if (par) assert.ok(enPl.has(par), `${c.id}: su par ${par} existe en per_lens`);
    else assert.ok(pf.diferencias.find((d) => d.id === c.id).motivo.length > 40, `${c.id}: la diferencia dice por qué`);
  }
});
