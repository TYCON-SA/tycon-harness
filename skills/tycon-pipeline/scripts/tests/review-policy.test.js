'use strict';
// review-policy.test.js — cuándo corren la revisión del plan y la del código, y quién aprueba el plan.
//
// Lo que no se puede perder:
//   · una historia delicada se revisa siempre, sin preguntar, y su plan lo aprueba el dueño;
//   · en la rutina se pregunta, salvo con el dueño ausente: ahí manda la celda de «dueño ausente»;
//   · un cambio chico que el riesgo marca por otro motivo, o denso, cuenta como grande y corre;
//   · un valor malo de la configuración cae al de fábrica, sólo esa clave, y se dice;
//   · el dueño está ausente con la marca puesta, o cuando la pregunta lleva los minutos sin respuesta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const P = require('../lib/review-policy.js');

const cfg = (over = {}) => P.normalize(over).values;

test('T10 ReviewPolicy_PlanDelicadoSiempre @story-8.221 @ac-10 — delicada y always: corre, aprueba el dueño, con y sin coordinadora', () => {
  for (const coordinator of [true, false]) {
    const r = P.planReview({ delicate: true, coordinator, ownerAway: false, config: cfg() });
    assert.strictEqual(r.decision, 'run');
    assert.strictEqual(r.approves, 'owner');
  }
});

test('T11 ReviewPolicy_PlanDelicadoConAsk @story-8.221 @ac-11 — delicada y ask: pregunta', () => {
  const r = P.planReview({ delicate: true, coordinator: true, ownerAway: false, config: cfg({ plan_review: { delicate: 'ask' } }) });
  assert.strictEqual(r.decision, 'ask');
  assert.strictEqual(r.approves, 'owner');
});

test('T12 ReviewPolicy_PlanDeRutinaSePregunta @story-8.221 @ac-12 — rutina y ask con el dueño presente: pregunta; la hace la coordinadora si la hay', () => {
  const con = P.planReview({ delicate: false, coordinator: true, ownerAway: false, config: cfg() });
  assert.strictEqual(con.decision, 'ask');
  assert.strictEqual(con.asker, 'coordinator');
  const sin = P.planReview({ delicate: false, coordinator: false, ownerAway: false, config: cfg() });
  assert.strictEqual(sin.decision, 'ask');
  assert.strictEqual(sin.asker, 'session');
});

test('T13 ReviewPolicy_RutinaDuenoAusenteReview @story-8.221 @ac-13 — rutina, dueño ausente, review: corre', () => {
  const r = P.planReview({ delicate: false, coordinator: true, ownerAway: true, config: cfg() });
  assert.strictEqual(r.decision, 'run');
});

test('T14 ReviewPolicy_RutinaDuenoAusenteWait @story-8.221 @ac-13 — rutina, dueño ausente, wait: espera al dueño', () => {
  const r = P.planReview({ delicate: false, coordinator: true, ownerAway: true, config: cfg({ plan_review: { routine_owner_away: 'wait' } }) });
  assert.strictEqual(r.decision, 'wait');
});

test('T15 ReviewPolicy_RutinaDuenoAusenteSkip @story-8.221 @ac-13 — rutina, dueño ausente, skip: sin revisión, aprueba el dueño', () => {
  const r = P.planReview({ delicate: false, coordinator: true, ownerAway: true, config: cfg({ plan_review: { routine_owner_away: 'skip' } }) });
  assert.strictEqual(r.decision, 'skip');
  assert.strictEqual(r.approves, 'owner');
});

test('T16 ReviewPolicy_RutinaAlways @story-8.221 @ac-14 — rutina always: corre sin preguntar', () => {
  const r = P.planReview({ delicate: false, coordinator: false, ownerAway: false, config: cfg({ plan_review: { routine: 'always' } }) });
  assert.strictEqual(r.decision, 'run');
});

test('T17 ReviewPolicy_RutinaNever @story-8.221 @ac-14 — rutina never: ni pregunta ni revisa, aprueba el dueño y el motivo lo dice', () => {
  const r = P.planReview({ delicate: false, coordinator: true, ownerAway: false, config: cfg({ plan_review: { routine: 'never' } }) });
  assert.strictEqual(r.decision, 'skip');
  assert.strictEqual(r.approves, 'owner');
  assert.match(r.reason, /el perfil no revisa/);
});

test('T18 ReviewPolicy_LasCeldasDeFabrica @story-8.221 @ac-15 — las celdas de las dos matrices con la configuración vacía', () => {
  const c = cfg();
  // matriz 1
  assert.deepStrictEqual(P.planReview({ delicate: true, coordinator: true, ownerAway: false, config: c }).decision, 'run');
  assert.deepStrictEqual(P.planReview({ delicate: false, coordinator: true, ownerAway: false, config: c }).decision, 'ask');
  assert.deepStrictEqual(P.planReview({ delicate: false, coordinator: true, ownerAway: true, config: c }).decision, 'run');
  const rutina = P.planReview({ delicate: false, coordinator: true, ownerAway: false, config: c });
  assert.strictEqual(rutina.approves, 'coordinator');
  // sin coordinadora, un plan de rutina lo aprueba su revisión (la de la propia sesión); con `person`, el dueño
  assert.strictEqual(P.planReview({ delicate: false, coordinator: false, ownerAway: false, config: c }).approves, 'session');
  assert.strictEqual(P.planReview({ delicate: false, coordinator: false, ownerAway: false, config: cfg({ plan_review: { routine_approval: 'person' } }) }).approves, 'owner');
  // matriz 2
  const code = (o) => P.codeReview({ delicate: false, codeFiles: 2, normalByOtherCriterion: false, dense: false, ownerAway: false, config: c, ...o }).decision;
  assert.strictEqual(code({ delicate: true }), 'run');
  assert.strictEqual(code({ delicate: true, codeFiles: 9 }), 'run');
  assert.strictEqual(code({}), 'ask');
  assert.strictEqual(code({ ownerAway: true }), 'run');
  assert.strictEqual(code({ codeFiles: 9 }), 'run');
});

test('T29 ReviewPolicy_CodigoDelicadoYChicoCorre @story-8.221 @ac-23 — delicada con 2 archivos: corre', () => {
  const r = P.codeReview({ delicate: true, codeFiles: 2, normalByOtherCriterion: false, dense: false, ownerAway: false, config: cfg() });
  assert.strictEqual(r.decision, 'run');
  assert.strictEqual(r.size, 'small');
});

test('T30 ReviewPolicy_CodigoDelicadoConAsk @story-8.221 @ac-23 — deep_review.delicate ask: pregunta', () => {
  const r = P.codeReview({ delicate: true, codeFiles: 2, normalByOtherCriterion: false, dense: false, ownerAway: false, config: cfg({ deep_review: { delicate: 'ask' } }) });
  assert.strictEqual(r.decision, 'ask');
});

test('T31 ReviewPolicy_RutinaGrandeCorre @story-8.221 @ac-24 — 7 archivos corre; un chico NORMAL por otro criterio es grande y corre', () => {
  const base = { delicate: false, dense: false, ownerAway: false, config: cfg() };
  const r7 = P.codeReview({ ...base, codeFiles: 7, normalByOtherCriterion: false });
  assert.strictEqual(r7.decision, 'run');
  assert.strictEqual(r7.size, 'large');
  const otro = P.codeReview({ ...base, codeFiles: 2, normalByOtherCriterion: true });
  assert.strictEqual(otro.size, 'large');
  assert.strictEqual(otro.decision, 'run');
});

test('T32 ReviewPolicy_RutinaGrandeConAsk @story-8.221 @ac-24 — large_routine ask: pregunta', () => {
  const r = P.codeReview({ delicate: false, codeFiles: 7, normalByOtherCriterion: false, dense: false, ownerAway: false, config: cfg({ deep_review: { large_routine: 'ask' } }) });
  assert.strictEqual(r.decision, 'ask');
});

test('T33 ReviewPolicy_RutinaChicaDeDia @story-8.221 @ac-25 — chica de día: ask, run y skip', () => {
  for (const v of ['ask', 'run', 'skip']) {
    const r = P.codeReview({ delicate: false, codeFiles: 3, normalByOtherCriterion: false, dense: false, ownerAway: false, config: cfg({ deep_review: { small_routine_day: v } }) });
    assert.strictEqual(r.decision, v);
  }
});

test('T34 ReviewPolicy_RutinaChicaConElDuenoAusente @story-8.221 @ac-25 — chica con el dueño ausente: run, skip y wait', () => {
  for (const v of ['run', 'skip', 'wait']) {
    const r = P.codeReview({ delicate: false, codeFiles: 3, normalByOtherCriterion: false, dense: false, ownerAway: true, config: cfg({ deep_review: { small_routine_owner_away: v } }) });
    assert.strictEqual(r.decision, v);
  }
});

test('T35 ReviewPolicy_ElCorteDe6 @story-8.221 @ac-26 — 6 chico, 7 grande; el corte se mueve; fuera de rango o de lista cae al de fábrica, sólo esa clave', () => {
  const size = (n, c) => P.codeReview({ delicate: false, codeFiles: n, normalByOtherCriterion: false, dense: false, ownerAway: false, config: c }).size;
  assert.strictEqual(size(6, cfg()), 'small');
  assert.strictEqual(size(7, cfg()), 'large');
  assert.strictEqual(size(4, cfg({ deep_review: { small_max_files: 3 } })), 'large');
  // un chico denso es grande
  assert.strictEqual(P.codeReview({ delicate: false, codeFiles: 2, normalByOtherCriterion: false, dense: true, ownerAway: false, config: cfg() }).size, 'large');
  for (const malo of [0, 51]) {
    const n = P.normalize({ deep_review: { small_max_files: malo, large_routine: 'ask' } });
    assert.strictEqual(n.values.deep_review.small_max_files, 6);
    assert.strictEqual(n.values.deep_review.large_routine, 'ask', 'las otras claves siguen');
    assert.ok(n.problems.some((p) => p.path === 'deep_review.small_max_files'));
  }
  for (const [k, malo, fabrica] of [['delicate', 'never', 'always'], ['small_routine_day', 'x', 'ask'], ['small_routine_owner_away', 'ask', 'run'], ['large_routine', 'skip', 'run']]) {
    const n = P.normalize({ deep_review: { [k]: malo } });
    assert.strictEqual(n.values.deep_review[k], fabrica, k);
    assert.ok(n.problems.some((p) => p.path === `deep_review.${k}`), k);
  }
});

test('T48 ReviewPolicy_LosMinutosSinRespuesta @story-8.221 @ac-37 — con 20, a los 19 presente y a los 20 ausente; con 5, a los 5; fuera de rango cae a 20; la marca rige enseguida', () => {
  // stable-data: horas fijas, la política no lee el reloj
  const askedAt = Date.parse('2026-11-06T10:00:00Z');
  const at = (min) => askedAt + min * 60000;
  assert.strictEqual(P.ownerAway({ mark: null, askedAt, now: at(19), minutes: 20 }).away, false);
  assert.strictEqual(P.ownerAway({ mark: null, askedAt, now: at(20), minutes: 20 }).away, true);
  assert.strictEqual(P.ownerAway({ mark: null, askedAt, now: at(5), minutes: 5 }).away, true);
  assert.strictEqual(P.ownerAway({ mark: { setAt: '2026-11-06T09:59:00Z' }, askedAt, now: at(0), minutes: 20 }).away, true);
  assert.strictEqual(P.ownerAway({ mark: null, askedAt: null, now: at(500), minutes: 20 }).away, false, 'sin pregunta no hay minutos que contar');
  for (const malo of [4, 241]) {
    const n = P.normalize({ plan_review: { owner_away_minutes: malo } });
    assert.strictEqual(n.values.plan_review.owner_away_minutes, 20);
    assert.ok(n.problems.some((p) => p.path === 'plan_review.owner_away_minutes'));
  }
});

// 🔴 Mutaciones: perder el valor de fábrica `review`, aceptar un valor malo, que el nombre viejo en false no valga
// `person` (o que el lector de la organización lo saque de `data`), o que el nombre viejo le gane al nuevo.
test('ReviewPolicy_RoutineApproval_KeyAliasAndBadValue (T23) @story-8.267 @ac-18', () => {
  assert.strictEqual(cfg().plan_review.routine_approval, 'review', 'de fábrica');
  assert.strictEqual(cfg({ plan_review: { routine_approval: 'person' } }).plan_review.routine_approval, 'person');
  const malo = P.normalize({ plan_review: { routine_approval: 'quizas' } });
  assert.strictEqual(malo.values.plan_review.routine_approval, 'review');
  assert.ok(malo.problems.some((p) => p.path === 'plan_review.routine_approval'), JSON.stringify(malo.problems));
  // el nombre viejo en false, sin el nuevo: vale `person`, sin problema (el lector de la organización lo conserva)
  const viejo = P.normalize({ plan_review: { coordinator_approves: false } });
  assert.strictEqual(viejo.values.plan_review.routine_approval, 'person');
  assert.deepStrictEqual(viejo.problems, []);
  assert.strictEqual(P.nombreViejo({ plan_review: { coordinator_approves: false } }), true);
  // con los dos escritos, gana el nuevo y no hay aviso de nombre viejo
  assert.strictEqual(cfg({ plan_review: { coordinator_approves: false, routine_approval: 'review' } }).plan_review.routine_approval, 'review');
  assert.strictEqual(P.nombreViejo({ plan_review: { coordinator_approves: false, routine_approval: 'review' } }), false);
  // idempotente: normalizar lo normalizado da lo mismo
  assert.deepStrictEqual(P.normalize(viejo.values).values.plan_review, viejo.values.plan_review);
  // el lector de team-repos.json deja las dos llaves en `data`
  const TR = require('../../../../scripts/lib/team-repos.js');
  const base = { version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } };
  const r = TR.parse(JSON.stringify({ ...base, plan_review: { coordinator_approves: false } }));
  assert.strictEqual(r.data.plan_review.coordinator_approves, false, `el lector sacó el nombre viejo: ${JSON.stringify(r.sectionProblems || {})}`);
  const n = TR.parse(JSON.stringify({ ...base, plan_review: { routine_approval: 'person' } }));
  assert.strictEqual(n.data.plan_review.routine_approval, 'person', `el lector sacó la llave nueva: ${JSON.stringify(n.sectionProblems || {})}`);
  // la matriz: con coordinadora, `coordinator`; sin ella, `session`; delicada o `person`, el dueño
  const ap = (o, c = cfg()) => P.planReview({ delicate: false, coordinator: true, ownerAway: false, config: c, ...o }).approves;
  assert.strictEqual(ap({}), 'coordinator');
  assert.strictEqual(ap({ coordinator: false }), 'session');
  assert.strictEqual(ap({ delicate: true }), 'owner');
  assert.strictEqual(ap({}, viejo.values), 'owner');
});

test('ReviewPolicy_DelicadaSinCodigo_NoCorre @story-8.282 @ac-13 @ac-14 @ac-28 — sin código no hay pase; con otro criterio o con código, como antes', () => {
  const base = { delicate: true, codeFiles: 0, onlyDocs: true, normalByOtherCriterion: false, dense: false, ownerAway: false };
  // 0 archivos que cuente code-files, pero no todo es documentación (instrucciones del agente, un .yml): corre como antes
  assert.strictEqual(P.codeReview({ ...base, onlyDocs: false, config: cfg() }).decision, 'run');
  assert.strictEqual(P.codeReview({ ...base, onlyDocs: undefined, config: cfg() }).decision, 'run');
  // el portón entero: una delicada que toca sólo eso no se saltea por «sin código»
  const pipeline = require('../pipeline.js');
  for (const archivo of ['skills/x/SKILL.md', 'pipelines/azure-pipelines.yml', '.githooks/pre-commit']) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-sin-codigo-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'feature/9-9-x']);
      fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
      const story = path.join(repo, 'specs', 'story-9.9-x.md');
      fs.writeFileSync(story, ['---', 'story: 9.9', 'status: in-progress', 'files_to_modify:', `  - ${archivo}`, '---', '',
        '## Acceptance Criteria', '', '1. **Given** a **When** b **Then** c.', ''].join('\n'));
      fs.mkdirSync(path.dirname(path.join(repo, archivo)), { recursive: true });
      fs.writeFileSync(path.join(repo, archivo), 'x\n');
      const r = pipeline.computeDeepReviewGate({ story, repo, files: [archivo], filesDeclarado: true, delicate: { value: true, rule: 'prueba', reason: 'delicada' } });
      assert.strictEqual(r.run, true, `${archivo}: ${r.reason}`);
      assert.doesNotMatch(String(r.reason), /sin código/, archivo);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
  for (const [nombre, o] of [['delicada', {}], ['delicada con ask', { config: cfg({ deep_review: { delicate: 'ask' } }) }], ['dueño ausente', { ownerAway: true }]]) {
    const r = P.codeReview({ ...base, config: cfg(), ...o });
    assert.strictEqual(r.decision, 'skip', nombre);
    assert.match(r.reason, /sin código/, nombre);
  }
  // sin alcance declarado (o marcada por otro criterio) llega con 0 y normalByOtherCriterion: decide como grande
  const otro = P.codeReview({ ...base, normalByOtherCriterion: true, config: cfg() });
  assert.strictEqual(otro.decision, 'run');
  assert.doesNotMatch(otro.reason, /sin código/);
  const conCodigo = P.codeReview({ ...base, codeFiles: 3, config: cfg() });
  assert.strictEqual(conCodigo.decision, 'run');
});

test('ReviewPolicy_DelicadaSoloDocumentacion_ElPortonLaSaltea @story-8.282 @ac-13 — el portón entero, no sólo codeReview: una delicada que toca sólo documentación no corre el pase', () => {
  const pipeline = require('../pipeline.js');
  // la corrida liviana la saltea antes; forzada a completa a mano, la saltea la matriz por «sin código»
  for (const [archivos, runSize, motivo] of [
    [['guides/x.md'], undefined, /corrida liviana \(sólo documentación/],
    [['guides/x.md', 'docs/y.md'], { size: 'completa', reason: 'a mano' }, /sin código/],
  ]) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-solo-docs-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'feature/9-9-x']);
      fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
      const story = path.join(repo, 'specs', 'story-9.9-x.md');
      fs.writeFileSync(story, ['---', 'story: 9.9', 'status: in-progress', 'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '',
        '## Acceptance Criteria', '', '1. **Given** a **When** b **Then** c.', ''].join('\n'));
      for (const a of archivos) { fs.mkdirSync(path.dirname(path.join(repo, a)), { recursive: true }); fs.writeFileSync(path.join(repo, a), '# x\n'); }
      const r = pipeline.computeDeepReviewGate({ story, repo, files: archivos, filesDeclarado: true, runSize, delicate: { value: true, rule: 'prueba', reason: 'delicada' } });
      assert.strictEqual(r.run, false, `${archivos}: ${JSON.stringify(r)}`);
      assert.match(String(r.reason), motivo, archivos.join(' '));
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
});
