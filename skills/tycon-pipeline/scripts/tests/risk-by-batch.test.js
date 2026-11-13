#!/usr/bin/env node
'use strict';
/**
 * risk-by-batch.test.js — el riesgo se mide por la parte que se hace.
 *
 *   T1  set-batch con una parte válida: `batch` y `batchValid: true`
 *   T2  una parte que no existe se niega como hoy (sale 2, sin anotar)
 *   T3  una parte sin `files:` se anota con `batchValid: false` y su motivo
 *   T4  un archivo de la parte que la historia no declara: inválida
 *   T5  una parte `done` se niega como hoy
 *   T6  la parte de una guía, en una historia cuya otra parte toca un freno: no delicada
 *   T7  con `--files` que trae el freno, delicada; con `--files` de otra guía, la lista de la parte sigue contando
 *   T8  con una parte válida, «tiene tandas» no cuenta
 *   T9  sin parte, o con una inválida, cuenta como hoy
 *   T10 el `sensible:` de arriba marca todas las partes
 *   T11 sin el de arriba, el de una parte marca sólo esa
 *   T13 el pase, su modelo, la revisión de la historia y el tamaño de la corrida, por la historia entera
 *   T15 sin parte, como hoy
 *   T16 la revisión del plan lleva la parte y la huella de su lista; si cambian, la aprobación delegada se niega
 *   T34 una parte con un archivo de código de otra parte abierta: inválida; una guía compartida: válida
 *
 * stable-data: arma historias y repos en carpetas temporales; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/risk-by-batch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const pipeline = require(path.join(SCRIPTS, 'pipeline.js'));
const scope = require(path.join(SCRIPTS, 'lib', 'batch-scope.js'));

const FRENO = 'skills/tycon-pipeline/scripts/lib/story-gate.js';
const A = 'A-la-guia';
const B = 'B-el-freno';
const C = 'C-la-nota-de-auth';

/** Una historia con partes. `partes`: [{ name, status, files, sensible }]; `arriba`: renglones extra del frontmatter. */
function historia({ partes, arriba = [], archivos = ['docs/guia.md', 'docs/otra.md', 'docs/auth/notas.md', FRENO] } = {}) {
  const lineas = ['---', 'story: "9.8"', 'title: "partes"', 'status: ready-for-dev', ...arriba, 'files_to_modify:', ...archivos.map((f) => `  - ${f}`)];
  if (partes && partes.length) {
    lineas.push('pipelines:');
    for (const p of partes) {
      lineas.push(`  - name: ${p.name}`, `    status: ${p.status || 'pending'}`, '    acs: [1]');
      if (p.sensible !== undefined) lineas.push(`    sensible: ${p.sensible}`);
      if (p.files) { lineas.push('    files:'); for (const f of p.files) lineas.push(`      - ${f}`); }
    }
  }
  lineas.push('---', '# Story 9.8', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** pasa.', '');
  return lineas.join('\n');
}
const PARTES = [
  { name: A, files: ['docs/guia.md'] },
  { name: B, files: [FRENO] },
  { name: C, files: ['docs/auth/notas.md'] },
];

function repo(texto = historia({ partes: PARTES })) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'risk-by-batch-')));
  // una rama de trabajo: en main, `pipeline.js start` no arranca
  execFileSync('git', ['init', '-q', '-b', 'feat/x', dir]);
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  const story = path.join(dir, 'specs', 'story-9.8-partes.md');
  fs.writeFileSync(story, texto);
  return { dir, story };
}

// ── la parte, validada ──────────────────────────────────────────────────────────────────────────

function entorno(texto) {
  const { dir, story } = repo(texto);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'inicio']);
  const env = (sid) => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '' });
  const correr = (script, args, sid) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: env(sid), input: '', cwd: dir });
  const dirEstado = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const leer = (sid) => JSON.parse(fs.readFileSync(path.join(dirEstado(), 'active', `${sid}.json`), 'utf8'));
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', dir, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  return { dir, story, home, correr, leer, arrancar, dirEstado };
}

test('T1 SetBatch_ParteValida_SeAnota — @story-8.168 @ac-1', () => {
  const E = entorno();
  E.arrancar('s1');
  const r = E.correr('marker.js', ['set-batch', A], 's1');
  assert.strictEqual(r.status, 0, r.stderr);
  const m = E.leer('s1');
  assert.strictEqual(m.batch, A);
  assert.strictEqual(m.batchValid, true);
  assert.strictEqual(m.batchInvalidReason, undefined);
});

test('T2 SetBatch_ParteInexistente_SeNiegaComoHoy — @story-8.168 @ac-2', () => {
  const E = entorno();
  E.arrancar('s2');
  const r = E.correr('marker.js', ['set-batch', 'Z-no-esta'], 's2');
  assert.strictEqual(r.status, 2);
  assert.strictEqual(E.leer('s2').batch, undefined);
  // la medición es la de la historia entera: una parte que no está no cambia nada
  assert.deepStrictEqual(pipeline.computeDelicate({ story: E.story, repo: E.dir, batch: 'Z-no-esta' }), pipeline.computeDelicate({ story: E.story, repo: E.dir }));
});

test('T3 SetBatch_ParteSinFiles_HistoriaEntera — @story-8.168 @ac-2', () => {
  const E = entorno(historia({ partes: [{ name: A }, { name: B, files: [FRENO] }] }));
  E.arrancar('s3');
  const r = E.correr('marker.js', ['set-batch', A], 's3');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /no vale|historia entera/);
  const m = E.leer('s3');
  assert.strictEqual(m.batch, A);
  assert.strictEqual(m.batchValid, false);
  assert.match(m.batchInvalidReason, /files:/);
  // el riesgo, la delicada y el tamaño dan lo mismo que sin parte
  for (const f of ['computeRiskClass', 'computeDelicate', 'computeRunSize']) {
    const sin = pipeline[f]({ story: E.story, repo: E.dir });
    const con = pipeline[f]({ story: E.story, repo: E.dir, batch: A });
    delete con.batch;
    assert.deepStrictEqual(con, sin, f);
  }
});

test('T4 SetBatch_ArchivoFueraDeLaHistoria_HistoriaEntera — @story-8.168 @ac-2', () => {
  const texto = historia({ partes: [{ name: A, files: ['docs/guia.md', 'docs/no-declarada.md'] }, { name: B, files: [FRENO] }] });
  const p = scope.validarParte(texto, A);
  assert.strictEqual(p.valid, false);
  assert.match(p.reason, /no-declarada\.md/);
  const { story, dir } = repo(texto);
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: A }).value, true, 'se mide la historia entera');
});

test('T5 SetBatch_ParteDone_SeNiegaComoHoy — @story-8.168 @ac-2', () => {
  const E = entorno(historia({ partes: [{ name: A, status: 'done', files: ['docs/guia.md'] }, { name: B, files: [FRENO] }] }));
  E.arrancar('s5');
  const r = E.correr('marker.js', ['set-batch', A], 's5');
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /done/);
  assert.strictEqual(E.leer('s5').batch, undefined);
});

test('T34 SetBatch_PartesQueSePisan_HistoriaEntera — @story-8.168 @ac-2', () => {
  const pisa = historia({ partes: [{ name: A, files: ['docs/guia.md', FRENO] }, { name: B, files: [FRENO] }] });
  const p = scope.validarParte(pisa, A);
  assert.strictEqual(p.valid, false);
  assert.match(p.reason, new RegExp(`story-gate\\.js.*${B}`));
  // si la otra está hecha, no pisa
  assert.strictEqual(scope.validarParte(historia({ partes: [{ name: A, files: ['docs/guia.md', FRENO] }, { name: B, status: 'done', files: [FRENO] }] }), A).valid, true);
  // una guía, suites.json o sprint-status.yaml compartidos no la invalidan
  const comparte = historia({
    archivos: ['docs/guia.md', 'scripts/tests/suites.json', 'specs/sprint-status.yaml', FRENO],
    partes: [{ name: A, files: ['docs/guia.md', 'scripts/tests/suites.json', 'specs/sprint-status.yaml'] }, { name: B, files: [FRENO, 'docs/guia.md', 'scripts/tests/suites.json', 'specs/sprint-status.yaml'] }],
  });
  assert.strictEqual(scope.validarParte(comparte, A).valid, true, scope.validarParte(comparte, A).reason);
});

// ── lo que se mide con la parte ───────────────────────────────────────────────────────────────────

test('T6 Riesgo_ParteDeGuia_NoDelicada — @story-8.168 @ac-3', () => {
  const { story, dir } = repo();
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir }).value, true, 'la historia entera toca el freno');
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: A }).value, false);
  assert.strictEqual(pipeline.computeRiskClass({ story, repo: dir, batch: A }).delicate.value, false);
});

test('T7 Riesgo_ParteDeGuiaQueTocaUnFreno_Delicada — @story-8.168 @ac-3', () => {
  const { story, dir } = repo();
  // lo que el cambio toca manda: la parte de la guía que toca el freno es delicada
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: A, files: [FRENO] }).value, true);
  // con --files de otra guía, la lista de la parte sigue contando (une, no reemplaza)
  const d = pipeline.computeDelicate({ story, repo: dir, batch: C, files: ['docs/otra.md'] });
  assert.strictEqual(d.value, true);
  assert.strictEqual(d.rule, 'rutas-sensibles');
  const rc = pipeline.computeRiskClass({ story, repo: dir, batch: C, files: ['docs/otra.md'] });
  assert.strictEqual(rc.criteria.find((c) => c.name === 'sin-paths-sensibles').pass, false, 'la parte suma su lista a --files');
  assert.match(rc.criteria.find((c) => c.name === 'superficie-chica').detail, /^2 archivos/);
});

test('T8 Riesgo_TieneTandas_NoCuentaConParteValida — @story-8.168 @ac-4', () => {
  const { story, dir } = repo();
  const rc = pipeline.computeRiskClass({ story, repo: dir, batch: A });
  assert.strictEqual(rc.criteria.find((c) => c.name === 'sin-pipelines-multi-tanda').pass, true);
  assert.deepStrictEqual(rc.criteria.filter((c) => !c.pass).map((c) => c.name), []);
  assert.strictEqual(rc.risk, 'LOW');
});

test('T9 Riesgo_TieneTandas_CuentaSinParte — @story-8.168 @ac-4', () => {
  const { story, dir } = repo(historia({ partes: [{ name: A }, { name: B, files: [FRENO] }] }));
  for (const batch of [undefined, A, 'Z-no-esta']) {
    const rc = pipeline.computeRiskClass({ story, repo: dir, batch });
    assert.strictEqual(rc.criteria.find((c) => c.name === 'sin-pipelines-multi-tanda').pass, false, String(batch));
  }
});

test('T10 Sensible_DeLaHistoria_MarcaTodas — @story-8.168 @ac-5', () => {
  const { story, dir } = repo(historia({ arriba: ['sensible: true'], partes: [{ name: A, files: ['docs/guia.md'], sensible: 'false' }, { name: B, files: [FRENO] }] }));
  const d = pipeline.computeDelicate({ story, repo: dir, batch: A });
  assert.strictEqual(d.value, true);
  assert.strictEqual(d.rule, 'sensible');
});

test('T11 Sensible_DeLaParte_SoloEsa — @story-8.168 @ac-5', () => {
  const texto = historia({ archivos: ['docs/guia.md', 'docs/otra.md'], partes: [{ name: A, files: ['docs/guia.md'] }, { name: 'D-la-otra', files: ['docs/otra.md'], sensible: 'true' }] });
  const { story, dir } = repo(texto);
  const d = pipeline.computeDelicate({ story, repo: dir, batch: 'D-la-otra' });
  assert.strictEqual(d.value, true);
  assert.strictEqual(d.rule, 'sensible');
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: A }).value, false);
});

// ── el pase, el modelo y la revisión de la historia: por la historia entera ───────────────────────

test('T13 Pase_PorLaHistoriaEntera_ComoHoy — @story-8.168 @ac-6', () => {
  const salidas = (E, sid) => {
    const json = (args) => { const r = E.correr('pipeline.js', args, sid); return r.stdout.trim() ? JSON.parse(r.stdout) : { status: r.status, err: r.stderr.slice(0, 200) }; };
    const sinHora = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/^(ts|at|hora|generatedAt)$/.test(k) ? undefined : v)));
    return {
      pase: sinHora(json(['deep-review-gate', '--story', E.story, '--repo', E.dir])),
      modelo: sinHora(json(['model-hint', '--story', E.story, '--repo', E.dir])),
      historia: sinHora(json(['story-review-gate', '--story', E.story])),
    };
  };
  // la misma corrida, antes y después de anotar la parte (una historia tiene una sola corrida abierta)
  const E = entorno();
  E.arrancar('s13');
  const rc = () => JSON.parse(E.correr('pipeline.js', ['risk-class', '--story', E.story, '--repo', E.dir], 's13').stdout);
  const antes = salidas(E, 's13');
  assert.strictEqual(rc().risk, 'NORMAL');
  assert.strictEqual(E.correr('marker.js', ['set-batch', A], 's13').status, 0);
  assert.deepStrictEqual(salidas(E, 's13'), antes);
  // y el plan sí se mide por la parte: risk-class da LOW con la parte
  const con = rc();
  assert.strictEqual(con.risk, 'LOW');
  assert.deepStrictEqual(con.batch, { name: A, valid: true });
  // el tamaño que miden el pase y los revisores (sin parte) no cambia
  assert.deepStrictEqual(pipeline.computeRunSize({ story: E.story, repo: E.dir }), pipeline.computeRunSize({ story: E.story, repo: E.dir, batch: undefined }));
});

test('T15 SinParte_ComoHoy — @story-8.168 @ac-7', () => {
  for (const texto of [historia({ partes: [] }), historia({ partes: PARTES })]) {
    const { story, dir } = repo(texto);
    for (const f of ['computeRiskClass', 'computeDelicate', 'computeRunSize']) {
      assert.deepStrictEqual(pipeline[f]({ story, repo: dir, batch: undefined }), pipeline[f]({ story, repo: dir }), f);
    }
    assert.deepStrictEqual(pipeline.computeModelHint({ story, repo: dir }), pipeline.computeModelHint({ story, repo: dir }));
  }
});

// ── la revisión del plan ──────────────────────────────────────────────────────────────────────────

test('T16 RevisionDelPlan_LlevaLaParte — @story-8.168 @ac-8', () => {
  const pr = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
  const E2 = 'E-la-otra-guia';
  const { story, dir } = repo(historia({ partes: [...PARTES, { name: E2, files: ['docs/otra.md'] }] }));
  const estado = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'estado-')));
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const run = path.join(dir, '.advisors', 'pipeline-runs', '9.8-20261109000000');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'step-02-bmad-plan.md'), '# Plan\n\nCambiar docs/guia.md.\n');
  const marker = { storyId: '9.8', storyPath: story, repoPath: dir, startedAt: '2026-11-09T00:00:00.000Z', batch: A, batchValid: true };
  fs.writeFileSync(path.join(estado, 'active', 'dest.json'), JSON.stringify(marker));
  const p = pr.preparar({ lanza: 'coord', destino: 'dest', estado, designada: () => 'coord' });
  assert.strictEqual(p.codigo, 0, p.motivo);
  // el pedido y lo que lee el revisor llevan la parte y la huella de su lista
  const pedido = JSON.parse(fs.readFileSync(p.pedido, 'utf8'));
  assert.deepStrictEqual(pedido.parte, { nombre: A, valida: true, files: ['docs/guia.md'], huella: scope.huellaDeLaLista(['docs/guia.md']) });
  assert.deepStrictEqual(p.args.parte, pedido.parte);
  assert.strictEqual(pedido.delicate.value, false, 'la delicada se mide con la parte');
  const c = pr.anotar({ lanza: 'coord', destino: 'dest', estado, resultado: { medido: true, modo: 'plan', confirmed: [], pedido: pedido.numero } });
  assert.strictEqual(c.veredicto, 'aprobado');
  const config = { plan_review: { coordinator_approves: true } };
  assert.strictEqual(pr.antesDeAprobar({ estado, firmante: 'coord', destino: 'dest', marker, config }).codigo, 0, 'con la misma parte, aprueba');
  // si la parte cambió desde la revisión (otra, tampoco delicada), la aprobación delegada se niega por la parte
  const otra = pr.antesDeAprobar({ estado, firmante: 'coord', destino: 'dest', marker: { ...marker, batch: E2 }, config });
  assert.strictEqual(otra.codigo, 2);
  assert.match(otra.motivo, /parte o su lista cambiaron/);
  // una parte delicada, o ninguna (la historia entera toca un freno): tampoco
  for (const batch of [C, undefined]) {
    assert.strictEqual(pr.antesDeAprobar({ estado, firmante: 'coord', destino: 'dest', marker: { ...marker, batch }, config }).codigo, 2, String(batch));
  }
});

// ── la parte sin `files:`, medida por lo que la historia le ata ──────────────────────────────────────────────
// 🔴 Mutaciones: no derivar la lista de lo atado (T25), dejar afuera lo que no se ata a ninguna tanda (T25), tomar la
// parte de la otra tanda como propia, o dejar valer una parte que comparte código con otra abierta (T26).
const FIRMAS = 'scripts/lib/signatures.js';
/** Una historia con dos tandas sin `files:`, atadas por comentario, por una fila de pruebas y por una tarea. */
function atada({ conAtados = true, extraArriba = [] } = {}) {
  return ['---', 'story: "9.7"', 'title: "atadas"', 'status: ready-for-dev', ...extraArriba,
    'pipelines:',
    '  - name: A-guias', '    status: pending', '    acs_pending: [1]', '    tests_pending: ["T1"]', '    tasks_pending: [1]',
    '  - name: B-firmas', '    status: pending', '    acs_pending: [2]', '    tests_pending: ["T2"]', '    tasks_pending: [2]',
    'files_to_modify:',
    `  - docs/guia.md            ${conAtados ? '# tanda A' : ''}`,
    '  - docs/tabla.md',
    '  - docs/tarea.md',
    `  - ${FIRMAS}                # tanda B`,
    '  - docs/suelta.md',
    '---', '# Story 9.7', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** pasa.', '2. **Given** otro, **Then** pasa.', '',
    '### Tests', '', '| # | Test | AC | Nivel | Escenario | Resultado esperado |', '|---|---|---|---|---|---|',
    `| T1 | \`Guia_Tabla\` | 1 | unit | ${conAtados ? 'lee docs/tabla.md' : 'lee la guía'} | ok |`, '| T2 | `Firmas_Texto` | 2 | unit | lee el catálogo | ok |', '',
    '## Tasks / Subtasks', '', `- [ ] Task 1 (tanda A): ${conAtados ? 'ajustar docs/tarea.md' : 'ajustar la guía'}`, '- [ ] Task 2 (tanda B): el texto del catálogo', ''].join('\n');
}

test('T25 RiskByBatch_PartWithoutFiles_MeasuresTiedFiles — @story-8.267 @ac-20', () => {
  const p = scope.validarParte(atada(), 'A-guias');
  assert.strictEqual(p.valid, true, p.reason);
  assert.deepStrictEqual([...p.files].sort(), ['docs/guia.md', 'docs/suelta.md', 'docs/tabla.md', 'docs/tarea.md'], 'los atados a A más el que no se ata a ninguna');
  assert.strictEqual(p.derivada, true);
  const b = scope.validarParte(atada(), 'B-firmas');
  assert.strictEqual(b.valid, true, b.reason);
  assert.ok(b.files.includes(FIRMAS) && !b.files.includes('docs/guia.md'), JSON.stringify(b.files));
  // la regla de atar es una sola: la matriz la importa de la parte
  const rm = require(path.join(SCRIPTS, 'runtime-matrix.js'));
  assert.ok(!rm.tandasQueNombran || rm.tandasQueNombran === scope.tandasQueNombran, 'la regla de atar quedó duplicada en la matriz');
  // el riesgo de A sale de rutina: el catálogo de firmas es de la B
  const { story, dir } = repo(atada());
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir }).value, true, 'la historia entera toca las firmas');
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: 'A-guias' }).value, false);
  assert.strictEqual(pipeline.computeRiskClass({ story, repo: dir, batch: 'A-guias' }).delicate.value, false);
  // el plan que nombra un archivo sensible, o lo que el cambio toca de verdad, la vuelve delicada
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: 'A-guias', planText: `Cambiar ${FIRMAS}.` }).value, true);
  assert.strictEqual(pipeline.computeDelicate({ story, repo: dir, batch: 'A-guias', files: [FIRMAS] }).value, true);
  // la revisión del plan la ve válida, con su lista
  const pr = require(path.join(SCRIPTS, 'lib', 'plan-review.js'));
  const parte = pr.parteDe({ batch: 'A-guias' }, atada());
  assert.strictEqual(parte.valida, true);
  assert.strictEqual(parte.huella, scope.huellaDeLaLista(p.files));
  // set-batch la anota válida e imprime la lista derivada
  const E = entorno(atada());
  E.arrancar('s25');
  const r = E.correr('marker.js', ['set-batch', 'A-guias'], 's25');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(E.leer('s25').batchValid, true);
  assert.match(r.stdout + r.stderr, /archivos de la parte: .*docs\/guia\.md/);
  // una tanda sin files: y sin nada atado no vale, y lo dice
  const sinAtados = scope.validarParte(atada({ conAtados: false }), 'A-guias');
  assert.strictEqual(sinAtados.valid, false);
  assert.match(sinAtados.reason, /ningún archivo atado a la tanda/);
});

test('T26 RiskByBatch_SharedCodeStillWhole_AndGuidesSayIt — @story-8.267 @ac-21', () => {
  // un .js atado a las dos tandas abiertas: la parte no vale
  const ambas = atada().replace('  - docs/suelta.md', '  - scripts/lib/compartido.js   # tanda A, tanda B');
  const p = scope.validarParte(ambas, 'A-guias');
  assert.strictEqual(p.valid, false);
  assert.match(p.reason, /compartido\.js.*B-firmas.*historia entera/);
  // dos tandas que sólo comparten sprint-status.yaml: vale
  const papeleo = atada().replace('  - docs/suelta.md', '  - specs/sprint-status.yaml   # tanda A, tanda B');
  assert.strictEqual(scope.validarParte(papeleo, 'A-guias').valid, true, scope.validarParte(papeleo, 'A-guias').reason);
  // las guías dicen la regla derivada
  const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
  assert.match(leer('story-format.md'), /[Ss]in `files:`, la parte vale con los archivos que la historia le ata/);
  assert.match(leer('guides/coordination.md'), /sin `files:`, con los archivos que la historia le ata/);
  assert.match(leer('guides/coordination.en.md'), /without `files:`, with the files the story ties to it/);
});
