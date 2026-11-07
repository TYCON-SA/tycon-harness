'use strict';
// deep-review-policy.test.js — la política del pase adversarial: el criterio de frenos y lo que pide la organización.
//
// Lo que no se puede perder:
//   · una historia que toca un freno del manifiesto de controles del repo (`scripts/ci/controls-from-base.json`) no es de
//     riesgo bajo: el criterio `sin-frenos` la hace NORMAL. `content` no cuenta; sin manifiesto, el criterio no aparece;
//     un manifiesto roto se dice y da NORMAL, sin excepción;
//   · la organización pide el pase «siempre» por argumento (el portón no lee la máquina) y entra en el mismo lugar que el
//     `always` del repo, también en una corrida liviana; el `auto` del repo gana;
//   · la organización no tiene `off`: un `off` del repo sigue siendo un pedido que, sin la firma del dueño, no saltea.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pipeline = require('../pipeline.js');

function carpeta(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Un repo con su manifiesto (null = sin manifiesto; un texto = tal cual) y su `.tycon/advisors.yaml` (opcional). */
function repoCon(t, { manifiesto, yaml } = {}) {
  const repo = carpeta(t, 'drp-repo-');
  if (manifiesto !== undefined && manifiesto !== null) {
    fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'ci', 'controls-from-base.json'), typeof manifiesto === 'string' ? manifiesto : JSON.stringify(manifiesto));
  }
  if (yaml) {
    fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), yaml);
  }
  return repo;
}

/** Una historia chica (riesgo bajo por tamaño) que declara `archivos`. */
function historia(repo, archivos) {
  const f = path.join(repo, 'story-9.99-prueba.md');
  fs.writeFileSync(f, [
    '---', 'story: "9.99"', 'title: "prueba"', 'status: ready-for-dev', 'files_to_modify:',
    ...archivos.map((a) => `  - ${a}   # un comentario`), '---', '', '# Story 9.99', '',
  ].join('\n'));
  return f;
}

const MANIFIESTO = {
  hook: '.githooks/pre-commit',
  controls: [
    { name: 'freno', script: 'scripts/ci/freno.js', rules: ['scripts/ci/reglas.json', { path: 'scripts/ci/opcional.json', optional: true }] },
  ],
  content: ['docs/datos.json'],
  workflows: [{ path: '.github/workflows/ci.yml', optional: true }],
};

const criterio = (rc, nombre) => rc.criteria.find((c) => c.name === nombre);

test('RiskClass_ControlFile_IsNormal @story-7.54 @ac-5 — un freno del manifiesto en el alcance da NORMAL; content no; sin manifiesto no aparece; roto se dice', (t) => {
  // 🔴 rojo: el criterio no existe, `content` cuenta como freno, aparece sin manifiesto, o un manifiesto roto tira.
  const repo = repoCon(t, { manifiesto: MANIFIESTO });
  for (const freno of ['scripts/ci/freno.js', 'scripts/ci/opcional.json', '.github/workflows/ci.yml']) {
    const rc = pipeline.computeRiskClass({ story: historia(repo, ['src/a.js', freno]), repo });
    assert.strictEqual(rc.risk, 'NORMAL', `${freno}: ${JSON.stringify(rc.criteria)}`);
    const c = criterio(rc, 'sin-frenos');
    assert.ok(c, `${freno}: el criterio aparece`);
    assert.strictEqual(c.pass, false);
    assert.match(c.detail, new RegExp(freno.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'el motivo nombra el freno');
    assert.ok(!('auto_approve_plan' in rc), 'ningún plan se aprueba solo (story 1.29)');
  }
  // un archivo de content no es regla: sigue LOW
  const contenido = pipeline.computeRiskClass({ story: historia(repo, ['src/a.js', 'docs/datos.json']), repo });
  assert.strictEqual(contenido.risk, 'LOW', JSON.stringify(contenido.criteria));
  assert.strictEqual(criterio(contenido, 'sin-frenos').pass, true);
  // sin manifiesto, el criterio no aparece
  const sinManifiesto = repoCon(t, {});
  const rcSin = pipeline.computeRiskClass({ story: historia(sinManifiesto, ['scripts/ci/freno.js']), repo: sinManifiesto });
  assert.strictEqual(criterio(rcSin, 'sin-frenos'), undefined);
  assert.strictEqual(rcSin.risk, 'LOW');
  // manifiesto roto (JSON roto y sin «controls»): NORMAL con el motivo, sin excepción
  for (const roto of ['{ "controls": [', JSON.stringify({ workflows: [] })]) {
    const r = repoCon(t, { manifiesto: roto });
    let rc;
    assert.doesNotThrow(() => { rc = pipeline.computeRiskClass({ story: historia(r, ['src/a.js']), repo: r }); });
    assert.strictEqual(rc.risk, 'NORMAL', roto);
    const c = criterio(rc, 'sin-frenos');
    assert.strictEqual(c.pass, false);
    assert.match(c.detail, /no pude leer el manifiesto/);
  }
});

test('Gate_OrgAlways_RepoAutoWins_OffStillNeedsSignature @story-7.54 @ac-6 — la organización pide siempre; el auto del repo gana; el off del repo sin firma no saltea', (t) => {
  // 🔴 rojo: la política de la organización no llega al portón, no corre en una liviana, le gana al `auto` del repo, o un
  // `off` del repo saltea sin la firma.
  const repo = repoCon(t, {});
  const story = historia(repo, ['src/a.js']);
  const base = { story, repo, files: [], filesDeclarado: true };
  // de control: riesgo bajo y sin política, el pase no corre
  assert.strictEqual(pipeline.computeDeepReviewGate(base).run, false, 'sin política, riesgo bajo: no corre');
  // la organización lo pide siempre
  const siempre = pipeline.computeDeepReviewGate({ ...base, orgDeepReview: 'always' });
  assert.strictEqual(siempre.run, true, siempre.reason);
  assert.match(siempre.reason, /la organización lo pide siempre/);
  // también en una corrida liviana (la historia declara sólo documentación)
  const docs = historia(repoCon(t, {}), ['docs/guia.md']);
  const liviana = { story: docs, repo: path.dirname(docs), files: [], filesDeclarado: true };
  assert.strictEqual(pipeline.computeDeepReviewGate(liviana).run, false, 'liviana sin política: no corre');
  const livianaSiempre = pipeline.computeDeepReviewGate({ ...liviana, orgDeepReview: 'always' });
  assert.strictEqual(livianaSiempre.run, true, livianaSiempre.reason);
  assert.match(livianaSiempre.reason, /la organización lo pide siempre/);
  // `deep_review: auto` del repo gana: decide el riesgo
  const repoAuto = repoCon(t, { yaml: 'deep_review: auto\n' });
  const conAuto = pipeline.computeDeepReviewGate({ story: historia(repoAuto, ['src/a.js']), repo: repoAuto, files: [], filesDeclarado: true, orgDeepReview: 'always' });
  assert.strictEqual(conAuto.run, false, conAuto.reason);
  // `off` del repo, sin la constancia firmada: no saltea
  const repoOff = repoCon(t, { yaml: 'deep_review: off\n' });
  const conOff = pipeline.computeDeepReviewGate({ story: historia(repoOff, ['src/a.js']), repo: repoOff, files: [], filesDeclarado: true, orgDeepReview: 'always' });
  assert.strictEqual(conOff.run, true, conOff.reason);
  assert.ok(conOff.skip_request && conOff.skip_request.firmado === false, 'queda como pedido de salteo sin firma');
  // la organización no puede pedir un salteo (no hay off): un valor que no sea always no cambia nada
  assert.strictEqual(pipeline.computeDeepReviewGate({ ...base, orgDeepReview: 'off' }).run, false, 'un off no corre ni saltea: sigue el riesgo');
  assert.strictEqual(pipeline.computeDeepReviewGate({ ...base, orgDeepReview: 'off' }).skip_request, undefined);
  // no-regresión: riesgo NORMAL con auto corre como hoy
  const repoGrande = repoCon(t, {});
  const grande = historia(repoGrande, ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js']);
  const normal = pipeline.computeDeepReviewGate({ story: grande, repo: repoGrande, files: [], filesDeclarado: true, orgDeepReview: 'auto' });
  assert.strictEqual(normal.run, true, normal.reason);
  assert.match(normal.reason, /risk-class NORMAL/);
});

test('OrgDeepReview_BrokenTeamRepos_SaysNotRead @story-7.54 @ac-6 — un team-repos.json que no se puede usar no pierde la política sin decirlo', (t) => {
  // 🔴 rojo: con otro error en el archivo, con el JSON roto o sin el lector, la política always se pierde con value:null
  // y problem:null, y el pase decide por riesgo sin decirlo.
  const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
  const base = { version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' } };
  const arbol = (texto, { lector = true } = {}) => {
    const d = carpeta(t, 'drp-org-');
    if (lector) {
      fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true });
      fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', 'team-repos.js'), path.join(d, 'scripts', 'lib', 'team-repos.js'));
    }
    if (texto !== null) fs.writeFileSync(path.join(d, 'team-repos.json'), texto);
    return d;
  };
  // de control: el archivo sano da la política, sin problema
  const sano = pipeline.orgDeepReview({ tree: arbol(JSON.stringify({ ...base, deep_review: { default: 'always' } })) });
  assert.deepStrictEqual(sano, { value: 'always', problem: null });
  // sin archivo, silencio: la organización no declaró nada
  assert.deepStrictEqual(pipeline.orgDeepReview({ tree: arbol(null) }), { value: null, problem: null });
  // otro error en el archivo, JSON roto, o el archivo sin su lector: decide el riesgo, y se dice
  for (const [caso, d] of [
    ['otra clave mala', arbol(JSON.stringify({ ...base, deep_review: { default: 'always' }, bogus_top: 1 }))],
    ['JSON roto', arbol('{ "deep_review": { "default": "always" ')],
    ['sin el lector', arbol(JSON.stringify({ ...base, deep_review: { default: 'always' } }), { lector: false })],
  ]) {
    const r = pipeline.orgDeepReview({ tree: d });
    assert.strictEqual(r.value, null, caso);
    assert.ok(r.problem, `${caso}: lo dice`);
    assert.match(r.problem, /decide el riesgo/, caso);
  }
});

// ── La matriz de la organización en el portón ───────────────────────────────────────────────────────────────────

const POL = require('../lib/review-policy.js');
const { execFileSync, spawnSync } = require('child_process');
const cfgCon = (raw = {}) => POL.normalize(raw).values;
/** Un repo git con una historia (delicada con `sensible`) y sus archivos ya escritos; `nuevo`: líneas de un archivo sin commitear. */
function repoGit(t, { archivos = ['src/a.js'], sensible = null, yaml, nuevo = 0 } = {}) {
  const repo = repoCon(t, { yaml });
  const fecha = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, ...fecha } });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const a of archivos) { fs.mkdirSync(path.dirname(path.join(repo, a)), { recursive: true }); fs.writeFileSync(path.join(repo, a), 'x\n'); }
  const story = path.join(repo, 'story-9.98-prueba.md');
  fs.writeFileSync(story, ['---', 'story: "9.98"', 'title: "prueba"', 'status: in-progress', ...(sensible ? [`sensible: ${sensible}`] : []), 'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', '# Story 9.98', ''].join('\n'));
  git('add', '.'); git('commit', '-qm', 'base');
  if (nuevo) fs.writeFileSync(path.join(repo, archivos[0]), Array.from({ length: nuevo }, (_, i) => `const v${i} = ${i};`).join('\n'));
  return { repo, story, files: archivos };
}
const gateDe = (r, extra = {}) => pipeline.computeDeepReviewGate({ story: r.story, repo: r.repo, files: r.files, filesDeclarado: true, ...extra });

test('DeepReviewGate_LaFirmaDeSaltearSigueGanando (T36) @story-8.221 @ac-27', (t) => {
  const r = repoGit(t, { sensible: 'seguridad' });
  // delicada y chica: con la matriz de fábrica corre (hoy se salteaba)
  assert.strictEqual(gateDe(r, { reviewConfig: cfgCon() }).run, true);
  const firmada = { ok: true, linea: { via: 'terminal', quien: 'dueño', ts: '2026-11-06T10:00:00Z', huella: 'abc', camino: '--no-deep-review', motivo: 'lo decidió el dueño' } };
  const v = gateDe(r, { reviewConfig: cfgCon(), adversarialSkipRecord: firmada });
  assert.strictEqual(v.run, false);
  assert.ok(v.adversarial_skip);
  assert.match(v.reason, /constancia firmada/);
});

test('DeepReviewGate_LoQueHaciaCorrerSigueHaciendoCorrer (T37) @story-8.221 @ac-27', (t) => {
  const salta = cfgCon({ deep_review: { small_routine_day: 'skip' } });
  const chica = repoGit(t);
  assert.strictEqual(gateDe(chica, { reviewConfig: salta }).run, false, 'la celda skip saltea una chica');
  assert.strictEqual(gateDe(chica, { reviewConfig: salta }).decision, 'skip');
  // lo que hacía correr sigue haciendo correr, con la celda en skip
  const compartida = repoGit(t, { yaml: 'deep_review_always_paths:\n  - src/**\n' });
  assert.strictEqual(gateDe(compartida, { reviewConfig: salta }).run, true, 'deep_review_always_paths');
  const siempre = repoGit(t, { yaml: 'deep_review: always\n' });
  assert.strictEqual(gateDe(siempre, { reviewConfig: salta }).run, true, 'el always del repo');
  for (const extra of [{ orgDeepReview: 'always' }, { deepReview: true }, { ultracode: true }]) {
    assert.strictEqual(gateDe(chica, { reviewConfig: salta, ...extra }).run, true, JSON.stringify(extra));
  }
  // el pedido sin firma no saltea lo que corre
  const delicada = repoGit(t, { sensible: 'seguridad' });
  const pedido = gateDe(delicada, { reviewConfig: salta, noDeepReview: true });
  assert.strictEqual(pedido.run, true);
  assert.ok(pedido.skip_request && pedido.skip_request.firmado === false);
  // una delicada liviana (sólo documentación): sin pase
  const docs = repoGit(t, { archivos: ['docs/guia.md'], sensible: 'seguridad' });
  const liviana = gateDe(docs, { reviewConfig: cfgCon() });
  assert.strictEqual(liviana.run, false);
  assert.strictEqual(liviana.risk, 'liviana');
  // sin --files: no medible, como hoy
  assert.strictEqual(pipeline.computeDeepReviewGate({ story: chica.story, repo: chica.repo, filesDeclarado: false, reviewConfig: salta }).run, null);
  // chica y densa: cuenta como grande, corre aunque la celda chica diga skip
  const densa = repoGit(t, { nuevo: 400 });
  const vd = gateDe(densa, { reviewConfig: salta });
  assert.strictEqual(vd.run, true, vd.reason);
  assert.strictEqual(vd.size, 'large');
  // la celda ask: no corre todavía, con la pregunta, y no es «no medible»
  const ask = gateDe(chica, { reviewConfig: cfgCon() });
  assert.strictEqual(ask.run, false);
  assert.strictEqual(ask.decision, 'ask');
  assert.match(ask.question, /review-ask --kind code/);
  // con el dueño ausente, la chica corre (de fábrica) o espera
  assert.strictEqual(gateDe(chica, { reviewConfig: cfgCon(), ownerAway: true }).run, true);
  assert.strictEqual(gateDe(chica, { reviewConfig: cfgCon({ deep_review: { small_routine_owner_away: 'wait' } }), ownerAway: true }).decision, 'wait');
  // el corte y la gravedad viajan para los args del pase
  assert.deepStrictEqual([ask.verifiers, ask.blocking_severity], ['per_lens', 'bug']);
  // la respuesta anotada para este diff decide la celda que preguntaba o esperaba; «wait» la deja esperando
  const conReview = gateDe(chica, { reviewConfig: cfgCon(), codeAnswer: 'review' });
  assert.deepStrictEqual([conReview.run, conReview.decision], [true, 'run']);
  const conSkip = gateDe(chica, { reviewConfig: cfgCon(), codeAnswer: 'skip' });
  assert.deepStrictEqual([conSkip.run, conSkip.decision], [false, 'skip']);
  const esperando = gateDe(chica, { reviewConfig: cfgCon({ deep_review: { small_routine_owner_away: 'wait' } }), ownerAway: true, codeAnswer: 'wait' });
  assert.strictEqual(esperando.decision, 'wait');
});

test('DeepReviewGate_PreguntarNoEsSaltear (T36) @story-8.221 @ac-27 — con «ask» el salteo se niega, next lo pide, y una pregunta de una ejecución cerrada no cuenta', (t) => {
  const chica = repoGit(t, { nuevo: 10 });
  const home = carpeta(t, 'drp-home-');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const sid = 'ses-preguntar';
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_PROFILE: '0', TYCON_LANE_LLM: '0' };
  for (const k of ['TYCON_HOME', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_GUIDES_DIR']) delete env[k];
  const correr = (script, args) => spawnSync(process.execPath, [path.join(__dirname, '..', script), ...args], { cwd: chica.repo, env, encoding: 'utf8' });
  const archivos = chica.files.map((f) => path.join(chica.repo, f));
  // una pregunta del código de hace 26 h, de una ejecución ya cerrada (sin marcador): no hace al dueño ausente
  // stable-data: el gate corre en otro proceso con el reloj real, así que la pregunta se fecha 26 h antes de ahora
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts: new Date(Date.now() - 26 * 3600000).toISOString(), name: 'review-ask', status: 'ok', sesion: sid, kind: 'code', huella: 'h-vieja' })}\n`);
  const gate = correr('pipeline.js', ['deep-review-gate', '--repo', chica.repo, '--story', chica.story, '--files', ...archivos]);
  assert.strictEqual(gate.status, 0, gate.stderr);
  const v = JSON.parse(gate.stdout);
  assert.deepStrictEqual([v.run, v.decision], [false, 'ask'], v.reason);
  // con una ejecución abierta, el salteo se niega mientras la pregunta no tenga respuesta
  const set = correr('marker.js', ['set', JSON.stringify({ storyId: '9.98', storyPath: chica.story, repoPath: chica.repo })]);
  assert.strictEqual(set.status, 0, set.stderr);
  const salteo = correr('marker.js', ['mark-adversarial-skipped', '--files', ...archivos]);
  assert.strictEqual(salteo.status, 3, salteo.stderr);
  assert.match(salteo.stderr, /no saltea el pase, pide preguntarle al dueño/);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(estado, 'active', `${sid}.json`), 'utf8')).deepReviewDone, 'no quedó sellado');
});

test('OrgDeepReview_UnaClaveMalaNoTiraLaPolitica (T37) @story-8.221 @ac-26 @ac-27', (t) => {
  const arbol = carpeta(t, 'drp-arbol-');
  fs.symlinkSync(path.join(__dirname, '..', '..', '..', '..', 'scripts'), path.join(arbol, 'scripts'));
  fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify({ repos: [], deep_review: { default: 'always', small_max_files: 99 } }));
  const r = pipeline.orgDeepReview({ tree: arbol });
  assert.strictEqual(r.value, 'always', JSON.stringify(r));
  assert.match(r.problem || '', /small_max_files/);
});

test('WriteFindings_ElCorteDeGravedadDelPase (T57) @story-8.221 @ac-45', () => {
  const sev = (raw, corte) => pipeline.normalizeFindingRecord({ rule_id: 'ADV-1', advisor: 'orquestador', file: 'a.js', ...raw }, [], { corte }).severity;
  // de fábrica, sólo un bug confirmado es CRITICAL; robustez y detalle, WARNING
  assert.deepStrictEqual(['bug', 'robustness', 'nit'].map((s) => sev({ adjusted_severity: s }, 'bug')), ['CRITICAL', 'WARNING', 'WARNING']);
  // con el corte en robustness o all, también frenan
  assert.deepStrictEqual(['bug', 'robustness', 'nit'].map((s) => sev({ adjusted_severity: s }, 'robustness')), ['CRITICAL', 'CRITICAL', 'WARNING']);
  assert.deepStrictEqual(['bug', 'robustness', 'nit'].map((s) => sev({ severity: s }, 'all')), ['CRITICAL', 'CRITICAL', 'CRITICAL']);
  // un hallazgo de un revisor (no del pase) conserva la suya
  assert.strictEqual(sev({ severity: 'critical' }, 'bug'), 'CRITICAL');
  assert.strictEqual(sev({ severity: 'warning' }, 'all'), 'WARNING');
});
