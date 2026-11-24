'use strict';
// control-profile.test.js — el perfil por modelo: un control que el dueño relajó para un perfil deja
// de frenar sólo para los modelos de ese perfil; una exigencia, un modelo que no se pudo leer, una clasificación sin firmar
// o una relajación vencida dejan todo prendido. Árbol, casa y conversación de juguete.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test control-profile.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CP = require('../lib/control-profile.js');
const TR = require('../lib/team-repos.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

// stable-data: un día fijo; las fechas de revisión se comparan contra él
const AHORA = Date.parse('2026-11-21T12:00:00Z');
const BASE = { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } };
const relajacion = (o = {}) => ({ control: 'pr-uno-por-repo', profile: 'fuertes', review_before: '2027-01-20', approved_by: 'el dueño', approved_on: '2026-11-21', ...o });
const CLASIF = {
  'pr-uno-por-repo': { tipo: 'preferencia', motivo: 'm', review_before: '2027-01-20', estado: 'firmada', firmada_el: '2026-11-21', firmo: 'el dueño' },
  'safety-guard': { tipo: 'exigencia', motivo: 'protege producción y datos', review_before: '2027-11-21', estado: 'firmada' },
  'test-scope-guard': { tipo: 'preferencia', motivo: 'm', review_before: '2027-01-20', estado: 'propuesta' },
};

/** Un árbol de juguete con su team-repos.json y su clasificación. */
function arbol({ perfil, clasif = CLASIF } = {}) {
  const t = tmp('arbol-');
  fs.writeFileSync(path.join(t, 'team-repos.json'), JSON.stringify(perfil === undefined ? BASE : { ...BASE, control_profiles: perfil }));
  fs.mkdirSync(path.join(t, 'scripts', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(t, 'scripts', 'metrics', 'controls-classification.json'), JSON.stringify(clasif));
  return t;
}
/**
 * Una copia de laboratorio del arnés sobre un árbol de juguete: el freno corre desde ahí y lee el perfil de su propio
 * árbol, como en una máquina (ninguna variable elige el árbol). Devuelve la ruta del freno copiado.
 */
function arnesDeLaboratorio(t) {
  for (const d of ['scripts/lib', 'scripts/setup/harness', 'skills/tycon-pipeline/scripts/lib', 'integrations']) {
    fs.cpSync(path.join(ROOT, d), path.join(t, d), { recursive: true });
  }
  const freno = path.join(t, 'scripts', 'hooks', 'pr-one-per-repo-guard.js');
  fs.mkdirSync(path.dirname(freno), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'pr-one-per-repo-guard.js'), freno);
  return freno;
}
const modelo = (m) => () => (m ? { model: m } : { model: null, noMedido: 'sin conversación' });
const decidir = (o) => CP.decide({ control: 'pr-uno-por-repo', sessionId: 's1', home: tmp('casa-'), now: AHORA, modelOf: modelo('claude-opus-5-5'), ...o });

test('T18 ControlProfile_NoSection_AllOn — sin la sección del perfil, todo prendido', () => {
  assert.strictEqual(decidir({ tree: arbol() }).on, true);
  assert.strictEqual(decidir({ tree: arbol({ perfil: { relaxed: [] } }) }).on, true, 'con la sección vacía, también');
});

test('T19a ControlProfile_StrongModel_PreferenceRelaxed — una preferencia firmada y relajada para fuertes, con una sesión opus, no frena', () => {
  const r = decidir({ tree: arbol({ perfil: { relaxed: [relajacion()] } }) });
  assert.deepStrictEqual([r.on, r.perfil, r.modelo], [false, 'fuertes', 'claude-opus-5-5']);
  assert.match(r.motivo, /hasta 2027-01-20/);
  assert.strictEqual(decidir({ tree: arbol({ perfil: { relaxed: [relajacion()] } }), modelOf: modelo('claude-sonnet-5-5') }).on, true, 'sonnet es del resto: frena');
});

test('T20 ControlProfile_UnknownModel_AllOn — sin modelo leído, o sin sesión, todo prendido', () => {
  const t = arbol({ perfil: { relaxed: [relajacion({ profile: 'resto' })] } });
  assert.strictEqual(decidir({ tree: t, modelOf: modelo(null) }).on, true, 'sin modelo: no es de ningún perfil');
  assert.strictEqual(decidir({ tree: t, sessionId: null }).on, true, 'sin sesión');
  assert.deepStrictEqual([CP.perfilDe('claude-fable-5-1'), CP.perfilDe('gpt-5'), CP.perfilDe(null)], ['fuertes', 'resto', null]);
});

// 🔴 Falla con: un perfil que se decide por una palabra adentro del id, o una relajación con una fecha imposible que no
// vence nunca, o una sesión que se hace pasar por otro modelo con una segunda conversación.
test('ControlProfile_Escapes_AllOn — un id ajeno con «opus» adentro, una fecha imposible o lejana y una conversación duplicada no relajan', () => {
  assert.deepStrictEqual(['claude-opus-5-5', 'opus', 'Claude-Fable-5', 'qwen-claude-opus-distill', 'notopus-mini', 'gpt-opus'].map(CP.perfilDe),
    ['fuertes', 'fuertes', 'fuertes', 'resto', 'resto', 'resto']);
  for (const review_before of ['9999-99-99', '2026-02-30', '2031-01-01']) {
    assert.strictEqual(decidir({ tree: arbol({ perfil: { relaxed: [relajacion({ review_before })] } }) }).on, true, review_before);
  }
  const t = arbol({ perfil: { relaxed: [relajacion()] } });
  const casa = tmp('casa-');
  for (const [carpeta, m] of [['real', 'claude-haiku-5-5'], ['zzz', 'claude-opus-5-5']]) {
    fs.mkdirSync(path.join(casa, '.claude', 'projects', carpeta), { recursive: true });
    fs.writeFileSync(path.join(casa, '.claude', 'projects', carpeta, 'sesion-doble.jsonl'), `${JSON.stringify({ message: { model: m } })}\n`);
  }
  const r = CP.decide({ control: 'pr-uno-por-repo', sessionId: 'sesion-doble', tree: t, home: casa, now: AHORA });
  assert.strictEqual(r.on, true);
  assert.match(r.motivo, /2 conversaciones/);
});

// 🔴 Falla con: decide tomaba el árbol de TYCON_TREE, una variable que el agente puede poner, y con eso leía un perfil que
// relaja el freno y ejecutaba el team-repos.js de esa carpeta.
test('ControlProfile_TreeVariable_Ignored — la variable no elige el árbol, y el código que lee el perfil es siempre el del arnés', () => {
  const t = arbol({ perfil: { relaxed: [relajacion()] } });
  const marca = path.join(tmp('marca-'), 'corrio');
  fs.mkdirSync(path.join(t, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(t, 'scripts', 'lib', 'team-repos.js'),
    `require('fs').writeFileSync(${JSON.stringify(marca)}, '');\nmodule.exports = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'))});\n`);
  // con la variable apuntando a una carpeta que relaja (en el ambiente del proceso y en el que se le pase), el árbol sigue
  // siendo el del arnés, que no relaja nada
  const antes = process.env.TYCON_TREE;
  process.env.TYCON_TREE = t;
  let r;
  try {
    r = CP.decide({ control: 'pr-uno-por-repo', sessionId: 's1', home: tmp('casa-'), now: AHORA, modelOf: modelo('claude-opus-5-5'), env: { ...process.env } });
  } finally {
    if (antes === undefined) delete process.env.TYCON_TREE; else process.env.TYCON_TREE = antes;
  }
  assert.strictEqual(r.on, true, r.motivo);
  // el árbol de juguete de las pruebas se lee, pero con el team-repos.js del arnés
  assert.strictEqual(decidir({ tree: t }).on, false);
  assert.ok(!fs.existsSync(marca), 'no ejecuta el team-repos.js de otra carpeta');
});

// 🔴 Falla con: el patrón de «fuertes» aceptaba cualquier sufijo, y un modelo local llamado opus-lite contaba como fuerte.
test('ControlProfile_StrongNeedsAnthropicId — fuerte es el nombre solo o un id de Anthropic con su versión', () => {
  assert.deepStrictEqual(['opus-lite', 'fable-local-llama', 'opus-x', 'claude-opus-lite', 'claude-fable'].map(CP.perfilDe), Array(5).fill('resto'));
  assert.deepStrictEqual(['opus', 'fable', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-1-20250805', 'Claude-Fable-5'].map(CP.perfilDe), Array(6).fill('fuertes'));
});

test('T21 ControlProfile_ExigenciaListed_Ignored — el perfil nombra una exigencia: se ignora, avisa una vez por día y sigue prendida', () => {
  const t = arbol({ perfil: { relaxed: [relajacion({ control: 'safety-guard' })] } });
  const casa = tmp('casa-');
  const a = CP.decide({ control: 'safety-guard', sessionId: 's1', tree: t, home: casa, now: AHORA, modelOf: modelo('claude-opus-5-5') });
  const b = CP.decide({ control: 'safety-guard', sessionId: 's1', tree: t, home: casa, now: AHORA, modelOf: modelo('claude-opus-5-5') });
  assert.strictEqual(a.on, true);
  assert.match(a.aviso, /es una exigencia/);
  assert.strictEqual(b.aviso, null, 'el mismo día no avisa dos veces');
  // una preferencia propuesta (sin firmar) tampoco se relaja
  assert.strictEqual(CP.decide({ control: 'test-scope-guard', sessionId: 's1', tree: arbol({ perfil: { relaxed: [relajacion({ control: 'test-scope-guard' })] } }), home: casa, now: AHORA, modelOf: modelo('claude-opus-5-5') }).on, true);
});

test('T22 ControlProfile_ExpiredRelaxation_BackOn — una relajación vencida vuelve a frenar', () => {
  const r = decidir({ tree: arbol({ perfil: { relaxed: [relajacion({ review_before: '2026-11-20' })] } }) });
  assert.strictEqual(r.on, true);
  assert.match(r.motivo, /venció/);
});

test('ControlProfile_BadSection_AllOnAndSaid — una relajación mal escrita deja la sección sin usar, y el archivo sigue valiendo', () => {
  const r = TR.parse(JSON.stringify({ ...BASE, control_profiles: { relaxed: [relajacion({ profile: 'todos', review_before: 'pronto' })] } }));
  assert.strictEqual(r.ok, true, 'el archivo vale');
  assert.strictEqual(r.data.control_profiles, undefined, 'sin la sección');
  assert.deepStrictEqual(r.sectionProblems.control_profiles.map((p) => p.path).sort(), ['control_profiles.relaxed.0.profile', 'control_profiles.relaxed.0.review_before']);
  assert.strictEqual(decidir({ tree: arbol({ perfil: { relaxed: [relajacion({ profile: 'todos' })] } }) }).on, true);
  const imposible = TR.parse(JSON.stringify({ ...BASE, control_profiles: { relaxed: [relajacion({ review_before: '9999-99-99' })] } }));
  assert.deepStrictEqual(imposible.sectionProblems.control_profiles.map((p) => p.path), ['control_profiles.relaxed.0.review_before'], 'una fecha que no existe es un problema, no una excepción');
});

// 🔴 Falla con: un freno que no pregunta al perfil, o que no anota el paso por el perfil (la tabla dejaría de contarlo).
test('T19 ControlProfile_HookRelaxed_PassesAndRecords — el freno de un pedido por repo, relajado para fuertes: con opus no frena y anota paso-por-perfil', () => {
  const t = arbol({ perfil: { relaxed: [relajacion()] } });
  const freno = arnesDeLaboratorio(t);
  const casa = tmp('casa-');
  const sid = 'sesion-de-prueba-perfil';
  fs.mkdirSync(path.join(casa, '.claude', 'projects', 'p'), { recursive: true });
  const conv = (m) => fs.writeFileSync(path.join(casa, '.claude', 'projects', 'p', `${sid}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { model: m } })}\n`);
  // un az de mentira: un pedido abierto en el repo, construyendo
  const bin = tmp('bin-');
  const fix = tmp('fix-');
  fs.writeFileSync(path.join(fix, 'prs.json'), JSON.stringify([{ pullRequestId: 2845, title: 'otro', sourceRefName: 'refs/heads/ci/otra' }]));
  fs.writeFileSync(path.join(fix, 'policy.json'), JSON.stringify([{ configuration: { type: { displayName: 'Build' } }, status: 'running' }]));
  fs.writeFileSync(path.join(bin, 'az'), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = policy ] && { cat "${fix}/policy.json"; exit 0; }; done\ncat "${fix}/prs.json"\n`);
  fs.chmodSync(path.join(bin, 'az'), 0o755);
  const CREAR = 'az repos pr create --org https://x --project Totora --repository FrontEnd --source-branch ci/nueva --target-branch main --title t';
  const correr = () => spawnSync(process.execPath, [freno], {
    input: JSON.stringify({ session_id: sid, tool_input: { command: CREAR } }), encoding: 'utf8',
    env: { ...process.env, HOME: casa, USERPROFILE: casa, TYCON_PR_ONE_PER_REPO: '1', PATH: `${bin}:${process.env.PATH}` },
  });
  const frenos = () => { try { return fs.readFileSync(path.join(require('../setup/harness/tycon-home.js').stateDir(casa), 'frenos.jsonl'), 'utf8'); } catch (_) { return ''; } };
  conv('claude-opus-5-5');
  const conOpus = correr();
  assert.strictEqual(conOpus.status, 0, conOpus.stderr);
  assert.match(conOpus.stderr, /no freno: relajado para el perfil fuertes/);
  assert.match(frenos(), /"veredicto":"paso-por-perfil"/, 'anotado para la tabla');
  conv('claude-sonnet-5-5');
  const conSonnet = correr();
  assert.strictEqual(conSonnet.status, 2, 'con sonnet frena como siempre');
});
