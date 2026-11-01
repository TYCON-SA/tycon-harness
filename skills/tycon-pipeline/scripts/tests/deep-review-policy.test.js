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
