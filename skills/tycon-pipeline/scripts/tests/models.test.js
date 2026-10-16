'use strict';

/**
 * models.test.js — story 7.29: los modelos de cada trabajo del pipeline, configurables por el admin del equipo.
 *
 * Lo que no se puede perder:
 *   - Sin `team-repos.json → models` y sin pedidos, los campos de modelos de los cinco comandos son los de hoy (la foto
 *     `fixtures/models-snapshot.json`, tomada del pipeline.js de partida con el sha adentro).
 *   - Los valores de hoy viven en un solo lugar (`lib/models.js`) y sus copias se verifican.
 *   - Con techo obligatorio, nada pasa el techo: se baja y se avisa una vez, sin frenar.
 *   - Las funciones que deciden nunca leen la configuración de la máquina: la reciben por argumento.
 *
 * Todo corre en laboratorios (HOME aislado, árbol del arnés de mentira, repos temporales) con nombres inventados (acme).
 * Regenerar la foto es una decisión explícita, sobre un checkout del commit de partida (nunca sobre la rama):
 *   TYCON_MODELS_SNAPSHOT_WRITE=<sha de partida> TYCON_TODAY=<aaaa-mm-dd> node --test models.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const HOOK = path.join(SCRIPTS, 'on-advisor-run.js');
const FOTO = path.join(__dirname, 'fixtures', 'models-snapshot.json');
const MODELS_JS = path.join(SCRIPTS, 'lib', 'models.js');
const SID = 'lab-modelos-729';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `modelos-${p}-`));
const models = () => require(MODELS_JS);

// ── laboratorios ─────────────────────────────────────────────────────────────────────────────────────────────────

const historia = (id, archivos, acs) => [
  '---', `story: "${id}"`, `title: "historia de laboratorio ${id}"`, 'status: ready-for-dev', 'approach: "[MODIFY]"',
  'files_to_modify:', ...archivos.map((f) => `  - ${f}`), '---', '', `# Story ${id}`, '', '## Acceptance Criteria', '',
  ...Array.from({ length: acs }, (_, i) => `${i + 1}. **Given** algo **Then** pasa ${i + 1}.`), '',
].join('\n');

const ARCHIVOS = Array.from({ length: 13 }, (_, i) => `src/m${i}.js`);
const HISTORIAS = {
  low: () => historia('9.1', ARCHIVOS.slice(0, 2), 2),
  normal: () => historia('9.2', ARCHIVOS.slice(0, 8), 3),
  heavy: () => historia('9.3', ARCHIVOS, 10),
};

/** Un repo git de laboratorio en una rama de trabajo, con los archivos y las tres historias. */
function labRepo() {
  const d = tmp('repo');
  // fechas fijas (el sha sale siempre igual) y sin el mantenimiento automático de git (no compite con la prueba)
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-10-16T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore', env });
  git('init', '-q');
  git('config', 'user.email', 'lab@acme.example');
  git('config', 'user.name', 'lab');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  fs.mkdirSync(path.join(d, 'src'));
  fs.mkdirSync(path.join(d, 'specs'));
  for (const f of ARCHIVOS) fs.writeFileSync(path.join(d, f), 'module.exports = 1;\n');
  for (const [k, fn] of Object.entries(HISTORIAS)) fs.writeFileSync(path.join(d, 'specs', `${k}.md`), fn());
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat/lab');
  fs.appendFileSync(path.join(d, 'src', 'm0.js'), 'module.exports.b = 2;\n');
  return d;
}

/** Un árbol del arnés de laboratorio: un clon (trae install-tycon-hooks.sh) con los lectores de `scripts/lib`. */
function labTree(teamRepos) {
  const d = tmp('arbol');
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.cpSync(path.join(RAIZ, 'scripts', 'lib'), path.join(d, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'install-tycon-hooks.sh'), '');
  fs.mkdirSync(path.join(d, 'build'));
  fs.copyFileSync(path.join(RAIZ, 'build', 'equivalences.json'), path.join(d, 'build', 'equivalences.json'));
  if (teamRepos !== undefined) {
    fs.writeFileSync(path.join(d, 'team-repos.json'), typeof teamRepos === 'string' ? teamRepos : JSON.stringify(teamRepos, null, 2));
  }
  return d;
}

const equipo = (models, platform = 'github') => ({
  version: 1,
  public: platform === 'github' ? { platform, org: 'acme', repo: 'harness' } : { platform, org: 'acme', project: 'Ventas', repo: 'harness' },
  profile: platform === 'github' ? { platform, org: 'acme', repo: 'harness-profile' } : { platform, org: 'acme', project: 'Ventas', repo: 'harness-profile' },
  operations: platform === 'github' ? { platform, org: 'acme', repo: 'harness-ops' } : { platform, org: 'acme', project: 'Ventas', repo: 'harness-ops' },
  ...(models !== undefined ? { models } : {}),
});

/** El ambiente aislado: HOME de laboratorio, sin el arnés de la máquina salvo el árbol que se pasa. */
function ambiente({ home, tree, extra } = {}) {
  const env = { ...process.env };
  for (const k of ['TYCON_GUIDES_DIR', 'TCG', 'TYCON_PIPELINE_COST_TIER', 'TYCON_NO_DEEP_REVIEW', 'TYCON_5B_EARLY',
    'NODE_TEST_CONTEXT', 'TYCON_SKILLS_DIR', 'TYCON_SPAWN_GOVERNANCE', 'TYCON_ADHOC_SPAWN_WARN', 'TYCON_AUTO_SNAPSHOT']) delete env[k];
  env.HOME = home || tmp('home');
  // `start` llama a marker.js por ~/.claude/agent-skills: el de este árbol (no el de la máquina)
  const skills = path.join(env.HOME, '.claude', 'agent-skills');
  if (!fs.existsSync(skills)) {
    fs.mkdirSync(path.dirname(skills), { recursive: true });
    fs.symlinkSync(RAIZ, skills, 'junction');
  }
  env.USERPROFILE = env.HOME;
  env.CLAUDE_CODE_SESSION_ID = SID;
  env.TYCON_SESSION_ID = SID;
  env.TYCON_AUTO_SNAPSHOT = '0';
  env.TYCON_PACKS_DEFAULT = 'none';   // sin arnés no hay packs.default: ningún paquete, en los tres ambientes por igual
  if (tree) env.TYCON_GUIDES_DIR = tree;
  return { ...env, ...(extra || {}) };
}

function correr(script, argv, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...argv], { env: ambiente(opts), encoding: 'utf8', input: opts.input || '', cwd: opts.cwd });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { /* no es JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** Un marcador de laboratorio para la sesión SID en ese HOME. */
function marcador(home, extra = {}) {
  const dir = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  const m = { sessionId: SID, storyId: '9.2', storyPath: 'specs/normal.md', stepsCompleted: ['0', '1', '2', '3'], ...extra };
  fs.writeFileSync(path.join(dir, `${SID}.json`), JSON.stringify(m, null, 2));
  return path.join(dir, `${SID}.json`);
}
const leerMarcador = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), 'utf8'));
const leerGates = (home) => {
  try { return fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
};

// ── la foto: los casos y los campos de modelos de cada comando ───────────────────────────────────────────────────

const CAMPOS = {
  advisors: ['model_hints', 'reloop_model_hints', 'reloop_model_hints_note', 'cost_tier'],
  'smart-reloop': ['reloop_model_hints', 'reloop_model_hints_note'],
  'deep-review-gate': ['model', 'model_reason', 'fable_upsell'],
  start: ['model_hint'],
  'model-hint': null,
};
const CASOS = [
  ['advisors-i1', 'advisors', 'normal', []],
  ['advisors-i2', 'advisors', 'normal', ['--iter', '2']],
  ['advisors-lean', 'advisors', 'normal', ['--cost-tier', 'lean']],
  ['advisors-deep', 'advisors', 'normal', ['--cost-tier', 'deep']],
  ['advisors-i2-deep', 'advisors', 'normal', ['--iter', '2', '--cost-tier', 'deep']],
  ['advisors-i2-lean', 'advisors', 'normal', ['--iter', '2', '--cost-tier', 'lean']],
  ['smart-reloop-i2', 'smart-reloop', 'normal', ['--iter', '2']],
  ['smart-reloop-force', 'smart-reloop', 'normal', ['--iter', '2', '--force-full-reloop']],
  ['gate-low', 'deep-review-gate', 'low', []],
  ['gate-normal', 'deep-review-gate', 'normal', []],
  ['gate-heavy', 'deep-review-gate', 'heavy', []],
  ['gate-normal-opus', 'deep-review-gate', 'normal', ['--deep-review-opus']],
  ['gate-heavy-opus', 'deep-review-gate', 'heavy', ['--deep-review-opus']],
  ['gate-heavy-ultracode', 'deep-review-gate', 'heavy', ['--ultracode']],
  ['gate-heavy-fable', 'deep-review-gate', 'heavy', ['--deep-review-fable']],
  ['gate-low-forced', 'deep-review-gate', 'low', ['--deep-review']],
  ['start-low', 'start', 'low', []],
  ['start-normal', 'start', 'normal', []],
  ['start-heavy', 'start', 'heavy', []],
  ['hint-low', 'model-hint', 'low', []],
  ['hint-normal', 'model-hint', 'normal', []],
  ['hint-heavy', 'model-hint', 'heavy', []],
];

function campos(cmd, json) {
  if (!json) return null;
  if (CAMPOS[cmd] === null) return json;
  const out = {};
  for (const k of CAMPOS[cmd]) if (json[k] !== undefined) out[k] = json[k];
  return out;
}

/**
 * Los archivos del diff: los comandos que miran el cambio los necesitan. El portón decide el riesgo por la cantidad de
 * archivos: recibe los de la story (si no, toda story sería liviana).
 */
const CANTIDAD = { low: 2, normal: 8, heavy: 13 };
const archivosDe = (cmd, cual) => {
  if (cmd === 'deep-review-gate') return ['--files', ...ARCHIVOS.slice(0, CANTIDAD[cual])];
  return ['advisors', 'smart-reloop'].includes(cmd) ? ['--files', 'src/m0.js'] : [];
};

function medirCaso([, cmd, cual, extra], opts) {
  const repo = labRepo();
  const story = path.join(repo, 'specs', `${cual}.md`);
  const r = correr(PIPELINE, [cmd, '--repo', repo, '--story', story, ...archivosDe(cmd, cual), ...extra], opts);
  return { r, campos: campos(cmd, r.json) };
}

// Las tres formas de «sin configuración» del AC 2.
const SIN_CONFIG = {
  'home-aislado': () => ({}),
  'arbol-sin-team-repos': () => ({ tree: labTree() }),
  'team-repos-sin-models': () => ({ tree: labTree(equipo()) }),
};

test('T2 SinConfig_CamposDeModelosIgualesALaFoto @story-7.29 @ac-2', () => {
  if (process.env.TYCON_MODELS_SNAPSHOT_WRITE) {
    const casos = {};
    for (const c of CASOS) casos[c[0]] = medirCaso(c, {}).campos;
    // la fecha de la foto se inyecta (TYCON_TODAY): la prueba no lee el reloj
    fs.writeFileSync(FOTO, `${JSON.stringify({ base_sha: process.env.TYCON_MODELS_SNAPSHOT_WRITE, tomada_en: process.env.TYCON_TODAY || null, casos }, null, 2)}\n`);
  }
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
  assert.match(foto.base_sha, /^[0-9a-f]{7,40}$/);
  assert.equal(Object.keys(foto.casos).length, CASOS.length);
  for (const [nombre, armar] of Object.entries(SIN_CONFIG)) {
    for (const c of CASOS) {
      const { r, campos: got } = medirCaso(c, armar());
      assert.deepStrictEqual(got, foto.casos[c[0]], `${nombre} · ${c[0]}: ${r.stderr.slice(0, 400)}`);
      if (r.json) {
        assert.equal(r.json.reviewer_models, undefined, `${nombre} · ${c[0]}: sin models no hay reviewer_models`);
        assert.equal(r.json.models_problem, undefined, `${nombre} · ${c[0]}`);
      }
    }
  }
});

// ── T1: un solo lugar ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El código de un archivo sin comentarios, línea por línea: fuera las líneas de comentario (`//`, `/*`, ` *`) y la
 * cola `// …` de una línea de código (cuando el `//` está fuera de comillas). Por líneas y no por caracteres: una
 * expresión regular con comillas adentro descalabra un recorrido de caracteres.
 */
function sinComentarios(src) {
  const out = [];
  for (const linea of src.split('\n')) {
    const t = linea.trim();
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    let q = null;
    let corte = linea.length;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '/' && linea[i + 1] === '/' && /\s/.test(linea[i - 1] || ' ')) { corte = i; break; }
    }
    out.push(linea.slice(0, corte));
  }
  return out.join('\n');
}

test('T1 Defaults_UnSoloLugar_CopiasVerificadas @story-7.29 @ac-1', () => {
  const M = models();
  assert.deepStrictEqual(M.MODELS, ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepStrictEqual(M.DEFAULTS, {
    reviewers: 'sonnet',
    reviewer: { 'tycon-spec-first-checker': 'opus' },
    reviewers_reloop: 'sonnet',
    adversarial: { model: 'sonnet', heavy: 'opus', fable_question: 'ask' },
    helpers: 'haiku',
    session: { low: 'sonnet', normal: 'opus', heavy: 'fable' },
  });
  assert.deepStrictEqual(M.TIERS, { lean: 'haiku', standard: 'sonnet', deep: 'opus' });
  // el model: de cada agents/*.md del público es el que da defaultFor
  const agentes = path.join(RAIZ, 'agents');
  const mds = fs.readdirSync(agentes).filter((f) => f.endsWith('.md'));
  assert.ok(mds.length >= 20, `${mds.length} revisores`);
  for (const f of mds) {
    const fm = (fs.readFileSync(path.join(agentes, f), 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    const m = (fm.match(/^model:\s*(\S+)/m) || [])[1];
    const nombre = f.replace(/\.md$/, '');
    const conDefaults = M.DEFAULTS.reviewer[nombre] || M.DEFAULTS.reviewers;
    assert.equal(m, conDefaults, `${f}: model: ${m} y DEFAULTS dice ${conDefaults}`);
    assert.equal(M.defaultFor(nombre, { agentsDir: agentes }), m, f);
  }
  // las copias: el pase adversarial y el generador de Codex
  const wf = fs.readFileSync(path.join(SCRIPTS, 'adversarial-verify.workflow.js'), 'utf8');
  assert.equal((wf.match(/const MODEL = \(A && A\.model\) \|\| '(\w+)'/) || [])[1], M.DEFAULTS.adversarial.model);
  const gen = require(path.join(RAIZ, 'build', 'generate.js'));
  const sinModelo = path.join(tmp('gen'), 'x.md');
  fs.writeFileSync(sinModelo, '---\nname: x\ndescription: de prueba\n---\ncuerpo\n');
  assert.equal(gen.parseAdvisor(sinModelo).model, M.DEFAULTS.reviewers);
  // pipeline.js sin literales exactos de modelo en el código; workflow-lite.js sin nombres de Codex
  const codigo = sinComentarios(fs.readFileSync(PIPELINE, 'utf8'));
  const literales = codigo.match(/['"](haiku|sonnet|opus|fable)['"]/g) || [];
  assert.deepStrictEqual(literales, [], 'pipeline.js tiene literales de modelo escritos');
  const eq = JSON.parse(fs.readFileSync(path.join(RAIZ, 'build', 'equivalences.json'), 'utf8')).models;
  const lite = sinComentarios(fs.readFileSync(path.join(SCRIPTS, 'workflow-lite.js'), 'utf8'));
  for (const slug of Object.values(eq)) assert.ok(!lite.includes(slug), `workflow-lite.js nombra ${slug}`);
});

// ── T3: la resolución ────────────────────────────────────────────────────────────────────────────────────────────

test('T3 Resolver_GeneralPorRevisorDefaultYFrontmatter @story-7.29 @ac-6', () => {
  const M = models();
  const agentsDir = tmp('agentes');
  fs.writeFileSync(path.join(agentsDir, 'acme-capa-revisor.md'), '---\nname: acme-capa-revisor\nmodel: opus\n---\n');
  const set = ['tycon-spec-first-checker', 'tycon-plugin-security-basics', 'acme-capa-revisor'];
  const general = M.resolveModels({ org: { reviewers: 'haiku', reviewer: { 'tycon-spec-first-checker': 'sonnet' } }, set, agentsDir });
  assert.deepStrictEqual(general.reviewers['tycon-spec-first-checker'], { model: 'sonnet', origin: 'organization-reviewer' });
  assert.deepStrictEqual(general.reviewers['tycon-plugin-security-basics'], { model: 'haiku', origin: 'organization' });
  assert.deepStrictEqual(general.reviewers['acme-capa-revisor'], { model: 'haiku', origin: 'organization' });
  const soloAyudantes = M.resolveModels({ org: { helpers: 'sonnet' }, set, agentsDir });
  assert.deepStrictEqual(soloAyudantes.reviewers['tycon-spec-first-checker'], { model: 'opus', origin: 'default' });
  assert.deepStrictEqual(soloAyudantes.reviewers['tycon-plugin-security-basics'], { model: 'sonnet', origin: 'default' });
  assert.deepStrictEqual(soloAyudantes.reviewers['acme-capa-revisor'], { model: 'opus', origin: 'default' }, 'el de la capa sigue en opus');
  assert.deepStrictEqual(soloAyudantes.helpers, { model: 'sonnet', origin: 'organization' });
  assert.equal(M.capAt('opus', 'sonnet'), 'sonnet');
  assert.equal(M.capAt('haiku', 'sonnet'), 'haiku');
  assert.equal(M.capAt('fable', null), 'fable');
  const eq = { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-luna', haiku: 'gpt-5.4-mini', fable: 'gpt-5.6-sol' };
  assert.equal(M.normalizeSessionModel('claude-opus-5-5[1m]', eq), 'opus');
  assert.equal(M.normalizeSessionModel('Sonnet', eq), 'sonnet');
  assert.equal(M.normalizeSessionModel('gpt-5.6-terra', eq), 'opus');
  assert.equal(M.normalizeSessionModel('xyz', eq), null);
  assert.equal(M.normalizeSessionModel(undefined, eq), null);
  // pase adversarial (2do): un solo valor de la organización por encima del techo es UN aviso (una clave), no uno por revisor
  const w = [];
  M.resolveReviewers({ org: { reviewers: 'fable', mandatory_ceiling: true, ceiling: 'opus' }, set: ['acme-a', 'acme-b', 'acme-c'], agentsDir, warnings: w });
  assert.deepStrictEqual([...new Set(w.map((x) => x.key))], ['organization:reviewers']);
  assert.match(w[0].message, /^models\.reviewers en fable pasa el techo de la organización \(opus\)/);
  // …y la carpeta de los revisores respeta TYCON_AGENTS_DIR, como los paquetes
  const guardado = process.env.TYCON_AGENTS_DIR;
  try {
    process.env.TYCON_AGENTS_DIR = agentsDir;
    assert.equal(M.agentsDirDefault(), agentsDir);
    const sinAviso = [];
    const r = M.resolveReviewers({ org: { helpers: 'haiku', reviewer: { 'acme-capa-revisor': 'sonnet' } }, set: ['acme-capa-revisor'], warnings: sinAviso });
    assert.deepStrictEqual(r['acme-capa-revisor'], { model: 'sonnet', origin: 'organization-reviewer' });
    assert.deepStrictEqual(sinAviso, [], 'el revisor existe en TYCON_AGENTS_DIR: no hay aviso de «no es un revisor»');
    assert.equal(M.defaultFor('acme-capa-revisor'), 'opus', 'el valor de hoy sale de su .md en TYCON_AGENTS_DIR');
  } finally {
    if (guardado === undefined) delete process.env.TYCON_AGENTS_DIR; else process.env.TYCON_AGENTS_DIR = guardado;
  }
  // el techo: sólo con mandatory_ceiling: true
  assert.equal(M.ceilingOf({ mandatory_ceiling: true, ceiling: 'sonnet' }), 'sonnet');
  assert.equal(M.ceilingOf({ ceiling: 'sonnet' }), null);
  assert.equal(M.ceilingOf(null), null);
  // el único lector: sin archivo, declarado, ilegible (no JSON, error en models, una carpeta en lugar del archivo)
  const TR = require(path.join(RAIZ, 'scripts', 'lib', 'team-repos.js'));
  const dir = (contenido) => {
    const d = tmp('org');
    if (contenido !== undefined) fs.writeFileSync(path.join(d, 'team-repos.json'), contenido);
    return d;
  };
  assert.deepStrictEqual(M.readOrgModels({ dir: dir(), teamRepos: TR }), { declared: false, data: null, problem: null });
  assert.deepStrictEqual(M.readOrgModels({ dir: dir(JSON.stringify(equipo())), teamRepos: TR }), { declared: false, data: null, problem: null });
  assert.deepStrictEqual(M.readOrgModels({ dir: dir(JSON.stringify(equipo({ helpers: 'opus' }))), teamRepos: TR }), { declared: true, data: { helpers: 'opus' }, problem: null });
  assert.match(M.readOrgModels({ dir: dir('{ roto'), teamRepos: TR }).problem, /^no pude leer la configuración de la organización \(.*: no es JSON válido/);
  assert.match(M.readOrgModels({ dir: dir(JSON.stringify(equipo({ mandatory_ceiling: true }))), teamRepos: TR }).problem, /models\.mandatory_ceiling.*no sé si hay techo$/);
  // pase adversarial: un problema AJENO a models con un techo declarado no puede perder el techo callado
  const ajeno = { ...equipo({ mandatory_ceiling: true, ceiling: 'sonnet' }), bogus: 1 };
  assert.match(M.readOrgModels({ dir: dir(JSON.stringify(ajeno)), teamRepos: TR }).problem, /no pude leer la configuración de la organización \(.*bogus: clave desconocida\): uso los valores de hoy: no sé si hay techo$/);
  assert.match(M.readOrgModels({ dir: dir(JSON.stringify({ version: 999, models: { mandatory_ceiling: true, ceiling: 'sonnet' } })), teamRepos: TR }).problem, /no sé si hay techo$/);
  assert.deepStrictEqual(M.readOrgModels({ dir: dir(JSON.stringify({ ...equipo(), bogus: 1 })), teamRepos: TR }), { declared: false, data: null, problem: null }, 'sin models, un problema ajeno no es de este lector');
  const carpeta = dir();
  fs.mkdirSync(path.join(carpeta, 'team-repos.json'));
  assert.match(M.readOrgModels({ dir: carpeta, teamRepos: TR }).problem, /no pude leer la configuración de la organización \(.*EISDIR/);
});

// ── con la configuración de la organización ──────────────────────────────────────────────────────────────────────

/** Corre un comando del pipeline sobre un repo de laboratorio con la configuración `models` (o un texto crudo). */
function conConfig(cmd, cual, extra, models, opts = {}) {
  const repo = opts.repo || labRepo();
  const tree = opts.tree || labTree(typeof models === 'string' ? models : equipo(models, opts.platform));
  const story = path.join(repo, 'specs', `${cual}.md`);
  return correr(PIPELINE, [cmd, '--repo', repo, '--story', story, ...archivosDe(cmd, cual), ...extra], { tree, home: opts.home });
}

test('T4 Advisors_ReviewerModels_ConConfigDelArbol @story-7.29 @ac-6 @ac-19', () => {
  for (const platform of ['github', 'azure']) {
    const r = conConfig('advisors', 'normal', [], { reviewers: 'haiku', reviewer: { 'tycon-spec-first-checker': 'sonnet' } }, { platform });
    assert.equal(r.status, 0, r.stderr);
    const rm = r.json.reviewer_models;
    assert.ok(rm, `${platform}: reviewer_models`);
    assert.deepStrictEqual(Object.keys(rm).sort(), [...r.json.all].sort(), 'uno por cada revisor del set');
    assert.deepStrictEqual(rm['tycon-spec-first-checker'], { model: 'sonnet', origin: 'organization-reviewer' });
    for (const [nombre, v] of Object.entries(rm)) if (nombre !== 'tycon-spec-first-checker') assert.deepStrictEqual(v, { model: 'haiku', origin: 'organization' }, nombre);
    assert.equal(r.json.model_hints, undefined);
    assert.equal(r.json.reloop_model_hints, undefined);
  }
});

test('T5 Reloop_TopeYFirstRound_TresCaminos @story-7.29 @ac-7', () => {
  const org = { reviewer: { 'tycon-spec-first-checker': 'opus', 'tycon-plugin-security-basics': 'haiku' } };
  const caminos = [
    ['advisors', ['--iter', '2']],
    ['smart-reloop', ['--iter', '2']],
    ['smart-reloop', ['--iter', '2', '--force-full-reloop']],
  ];
  for (const [cmd, extra] of caminos) {
    const r = conConfig(cmd, 'normal', extra, org);
    const rm = r.json.reviewer_models;
    assert.ok(rm, `${cmd} ${extra.join(' ')}: ${r.stderr.slice(0, 300)}`);
    assert.deepStrictEqual(rm['tycon-spec-first-checker'], { model: 'sonnet', origin: 'organization-reviewer', first_round: 'opus' }, cmd);
    if (rm['tycon-plugin-security-basics']) assert.deepStrictEqual(rm['tycon-plugin-security-basics'], { model: 'haiku', origin: 'organization-reviewer', first_round: 'haiku' });
    assert.equal(r.json.reloop_model_hints, undefined);
  }
  // con techo sonnet: first_round ya recortado
  const techo = conConfig('advisors', 'normal', ['--iter', '2'], { ...org, mandatory_ceiling: true, ceiling: 'sonnet' });
  assert.deepStrictEqual(techo.json.reviewer_models['tycon-spec-first-checker'], { model: 'sonnet', origin: 'organization-reviewer', first_round: 'sonnet' });
  // --cost-tier deep sin techo: no baja en la vuelta 2
  const deep = conConfig('advisors', 'normal', ['--iter', '2', '--cost-tier', 'deep'], { reviewers: 'sonnet' });
  for (const [n, v] of Object.entries(deep.json.reviewer_models)) assert.deepStrictEqual(v, { model: 'opus', origin: 'run', first_round: 'opus' }, n);
});

test('T6 Adversarial_ModeloComunPesadoYBanderas @story-7.29 @ac-8', () => {
  const org = { adversarial: { model: 'haiku', heavy: 'sonnet' } };
  const casos = [
    ['normal', [], 'haiku', /organización/],
    ['heavy', [], 'sonnet', /organización/],
    ['heavy', ['--deep-review-opus'], 'opus', /--deep-review-opus/],
    ['heavy', ['--ultracode'], 'opus', /ultracode/],
    ['heavy', ['--deep-review-fable'], 'fable', /--deep-review-fable/],
  ];
  for (const [cual, extra, modelo, motivo] of casos) {
    const r = conConfig('deep-review-gate', cual, extra, org);
    assert.equal(r.json.model, modelo, `${cual} ${extra}`);
    assert.match(r.json.model_reason, motivo);
  }
  // sin declararlos: sonnet y opus
  assert.equal(conConfig('deep-review-gate', 'normal', [], { helpers: 'haiku' }).json.model, 'sonnet');
  assert.equal(conConfig('deep-review-gate', 'heavy', [], { helpers: 'haiku' }).json.model, 'opus');
});

test('T7 Adversarial_PreguntaDeFable_OrganizacionY719 @story-7.29 @ac-8', () => {
  // ask: fable_upsell; never: model_question + gates.log
  const ask = conConfig('deep-review-gate', 'heavy', [], { adversarial: { fable_question: 'ask' } });
  assert.ok(ask.json.fable_upsell);
  assert.equal(ask.json.model_question, undefined);
  const home = tmp('home');
  const never = conConfig('deep-review-gate', 'heavy', [], { adversarial: { fable_question: 'never' } }, { home });
  assert.equal(never.json.fable_upsell, undefined);
  assert.deepStrictEqual(never.json.model_question, { value: 'never', origin: 'organization' });
  assert.ok(leerGates(home).some((g) => g.check === 'model-question' && g.origin === 'organization'));
  // la clave de la 7.19 en la máquina (never) y la de la organización (ask): gana la organización y se nombra la otra
  const home2 = tmp('home');
  const tree = labTree(equipo({ adversarial: { fable_question: 'ask' } }));
  execFileSync(process.execPath, [path.join(tree, 'scripts', 'lib', 'tycon-config.js'), 'set', 'adversarial.model_question', 'never'], { env: ambiente({ home: home2, tree }), stdio: 'ignore' });
  const ambas = conConfig('deep-review-gate', 'heavy', [], null, { tree, home: home2 });
  assert.ok(ambas.json.fable_upsell, 'gana la organización');
  assert.match(JSON.stringify(ambas.json) + ambas.stderr, /model_question.*no se usa|no se usa.*model_question/);
  // la de la 7.19 sola: decide ella
  const home3 = tmp('home');
  const tree3 = labTree(equipo({ helpers: 'haiku' }));
  execFileSync(process.execPath, [path.join(tree3, 'scripts', 'lib', 'tycon-config.js'), 'set', 'adversarial.model_question', 'never'], { env: ambiente({ home: home3, tree: tree3 }), stdio: 'ignore' });
  const sola = conConfig('deep-review-gate', 'heavy', [], null, { tree: tree3, home: home3 });
  assert.equal(sola.json.fable_upsell, undefined);
  assert.deepStrictEqual(sola.json.model_question, { value: 'never', origin: 'maquina' });
});

test('T8 Ayudantes_EnStartYNotaDelControl @story-7.29 @ac-9', () => {
  const s1 = conConfig('start', 'normal', ['--brief'], { helpers: 'sonnet' });
  assert.deepStrictEqual(s1.json.models, { helpers: { model: 'sonnet', origin: 'organization' } });
  const s1c = conConfig('start', 'normal', [], { helpers: 'sonnet' });
  assert.deepStrictEqual(s1c.json.models, { helpers: { model: 'sonnet', origin: 'organization' } });
  const s2 = conConfig('start', 'normal', ['--brief'], { reviewers: 'sonnet' });
  assert.deepStrictEqual(s2.json.models, { helpers: { model: 'haiku', origin: 'default' } });
  // la nota del control de lanzamientos con .codegraph/ en el cwd
  const nota = (models) => {
    const cwd = tmp('cwd');
    fs.mkdirSync(path.join(cwd, '.codegraph'));
    const tree = labTree(models === undefined ? undefined : equipo(models));
    const ev = { tool_name: 'Agent', session_id: SID, cwd, tool_input: { subagent_type: 'general-purpose', prompt: 'buscá algo' } };
    return correr(HOOK, [], { tree, input: JSON.stringify(ev) }).stdout;
  };
  assert.match(nota({ helpers: 'sonnet' }), /alcanza `sonnet` \(configuración de la organización\)/);
  assert.match(nota({ reviewers: 'sonnet' }), /alcanza `haiku` \(valor de hoy\)/);
  assert.match(nota(undefined), /alcanza uno barato/);
});

test('T9 Sesion_SugerenciaPorPesoYAlsoOk @story-7.29 @ac-10', () => {
  const session = { low: 'haiku', normal: 'sonnet', heavy: 'opus' };
  for (const [cual, modelo] of [['low', 'haiku'], ['normal', 'sonnet'], ['heavy', 'opus']]) {
    const r = conConfig('model-hint', cual, [], { session });
    assert.equal(r.json.recommended_session_model, modelo, cual);
    assert.deepStrictEqual(r.json.also_ok, []);
    assert.match(r.json.note, /configuración de la organización/);
  }
  const sinSession = conConfig('model-hint', 'heavy', [], { helpers: 'haiku' });
  assert.equal(sinSession.json.recommended_session_model, 'fable');
  assert.deepStrictEqual(sinSession.json.also_ok, ['opus']);
  const techo = conConfig('model-hint', 'heavy', [], { mandatory_ceiling: true, ceiling: 'opus' });
  assert.equal(techo.json.recommended_session_model, 'opus');
  assert.ok(!techo.json.also_ok.includes('fable'));
});

// ── el pedido del dev y el techo ─────────────────────────────────────────────────────────────────────────────────

test('T10 SinTecho_PedidoArribaYAbajo_Anotado @story-7.29 @ac-11', () => {
  const home = tmp('home');
  marcador(home);
  const m = correr(MARKER, ['set-models', 'reviewers=opus', 'adversarial=haiku'], { home });
  assert.equal(m.status, 0, m.stderr);
  const mk = leerMarcador(home);
  assert.deepStrictEqual(mk.modelRequests.values, { reviewers: 'opus', adversarial: 'haiku' });
  assert.equal(mk.modelRequests.sessionId, SID);
  assert.ok(mk.modelRequests.at);
  assert.ok(leerGates(home).some((g) => g.name === 'set-models'));
  const a = conConfig('advisors', 'normal', [], { helpers: 'haiku' }, { home });
  for (const [n, v] of Object.entries(a.json.reviewer_models)) assert.deepStrictEqual(v, { model: 'opus', origin: 'run' }, n);
  const g = conConfig('deep-review-gate', 'heavy', [], { helpers: 'haiku' }, { home });
  assert.equal(g.json.model, 'haiku');
});

test('T11 MarkerSetModels_ValidaYNoEscribe @story-7.29 @ac-11', () => {
  const home = tmp('home');
  const ruta = marcador(home);
  const antes = fs.readFileSync(ruta, 'utf8');
  assert.equal(correr(MARKER, ['set-models', 'foo=bar'], { home }).status, 2);
  assert.equal(correr(MARKER, ['set-models', 'reviewers=Opus'], { home }).status, 2);
  assert.equal(correr(MARKER, ['set-models', 'Foo_Bar=opus'], { home }).status, 2);
  assert.equal(fs.readFileSync(ruta, 'utf8'), antes, 'no escribió nada');
  assert.equal(correr(MARKER, ['set-models', 'reviewers=opus'], { home: tmp('home') }).status, 1, 'sin marcador sale 1');
  assert.equal(correr(MARKER, ['set-models', 'mi-revisor=opus'], { home }).status, 0);
  assert.deepStrictEqual(leerMarcador(home).modelRequests.values, { 'mi-revisor': 'opus' });
  const a = conConfig('advisors', 'normal', [], { helpers: 'haiku' }, { home });
  assert.ok((a.json.models_warnings || []).some((w) => /mi-revisor/.test(w)), JSON.stringify(a.json.models_warnings));
  assert.equal(correr(MARKER, ['set-models', '--clear'], { home }).status, 0);
  assert.equal(leerMarcador(home).modelRequests, undefined);
  assert.ok(leerGates(home).filter((g) => g.name === 'set-models').length >= 2);
});

test('T12 ConTecho_PedidoArribaSeRecortaAbajoSeRespeta @story-7.29 @ac-12', () => {
  const techo = { mandatory_ceiling: true, ceiling: 'sonnet' };
  const home = tmp('home');
  marcador(home);
  correr(MARKER, ['set-models', 'reviewers=opus'], { home });
  const arriba = conConfig('advisors', 'normal', [], techo, { home });
  for (const [n, v] of Object.entries(arriba.json.reviewer_models)) assert.equal(v.model, 'sonnet', n);
  assert.ok(arriba.json.models_warnings.some((w) => /pediste opus; el techo de la organización es sonnet/.test(w)));
  const home2 = tmp('home');
  marcador(home2);
  correr(MARKER, ['set-models', 'reviewers=haiku'], { home: home2 });
  const abajo = conConfig('advisors', 'normal', [], techo, { home: home2 });
  for (const [n, v] of Object.entries(abajo.json.reviewer_models)) assert.equal(v.model, 'haiku', n);
  const deep = conConfig('advisors', 'normal', ['--cost-tier', 'deep'], techo);
  for (const [n, v] of Object.entries(deep.json.reviewer_models)) assert.equal(v.model, 'sonnet', n);
  const fable = conConfig('deep-review-gate', 'heavy', ['--deep-review-fable'], techo);
  assert.equal(fable.json.model, 'sonnet');
  assert.match(fable.json.model_reason, /pediste fable; el techo de la organización es sonnet/);
  assert.equal(conConfig('deep-review-gate', 'heavy', ['--deep-review-opus'], techo).json.model, 'sonnet');
});

test('T13 ConTecho_ValoresArriba_SeBajanYAvisanUnaVez @story-7.29 @ac-12', () => {
  const techo = { mandatory_ceiling: true, ceiling: 'sonnet' };
  const home = tmp('home');
  marcador(home);
  const repo = labRepo();
  const tree = labTree(equipo(techo));
  const uno = conConfig('advisors', 'normal', [], null, { home, repo, tree });
  assert.equal(uno.status, 0);
  assert.deepStrictEqual(uno.json.reviewer_models['tycon-spec-first-checker'], { model: 'sonnet', origin: 'default' });
  assert.ok((uno.json.models_warnings || []).some((w) => /tycon-spec-first-checker/.test(w)));
  assert.ok(leerMarcador(home).modelsWarned.length >= 1);
  // mark-models-warned (el del orquestador) anota igual que la línea de comandos
  assert.equal(correr(MARKER, ['mark-models-warned', 'acme:otra'], { home }).status, 0);
  assert.ok(leerMarcador(home).modelsWarned.includes('acme:otra'));
  assert.equal(correr(MARKER, ['mark-models-warned'], { home }).status, 2);
  const dos = conConfig('advisors', 'normal', [], null, { home, repo, tree });
  assert.equal(dos.status, 0);
  assert.ok(!(dos.json.models_warnings || []).some((w) => /tycon-spec-first-checker/.test(w)), 'la segunda vez no avisa');
  // sin marcador: en cada salida
  const h3 = tmp('home');
  for (let i = 0; i < 2; i++) {
    const r = conConfig('advisors', 'normal', [], null, { home: h3, repo, tree });
    assert.ok(r.json.models_warnings.some((w) => /tycon-spec-first-checker/.test(w)), `vuelta ${i}`);
  }
  // el pase en una pesada y la sesión pesada también bajan y avisan
  const g = conConfig('deep-review-gate', 'heavy', [], techo);
  assert.equal(g.json.model, 'sonnet');
  assert.ok(g.json.models_warnings.length);
});

test('T14 Sesion_ArribaDelTecho_AvisaYNoCambia @story-7.29 @ac-13', () => {
  const techo = { mandatory_ceiling: true, ceiling: 'sonnet' };
  for (const nombre of ['claude-opus-5-5[1m]', 'opus', 'gpt-5.6-terra']) {
    const r = conConfig('start', 'normal', ['--session-model', nombre], techo);
    assert.equal(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.json.model_hint.session_check, { model: 'opus', ceiling: 'sonnet', above: true }, nombre);
    assert.match(r.stderr + JSON.stringify(r.json), /la sesión corre en opus, por encima del techo de la organización \(sonnet\)/);
    assert.equal(r.json.ready, true);
  }
  for (const extra of [['--session-model', 'xyz'], []]) {
    const r = conConfig('model-hint', 'normal', extra, techo);
    assert.deepStrictEqual(r.json.session_check, { model: null, reason: 'no se sabe el modelo de la sesión' });
    assert.doesNotMatch(r.stderr, /por encima del techo/);
  }
});

test('T15 Fable_TechoDebajo_NuncaSeOfrece @story-7.29 @ac-14', () => {
  const r = conConfig('deep-review-gate', 'heavy', [], { mandatory_ceiling: true, ceiling: 'opus', adversarial: { fable_question: 'ask' } });
  assert.equal(r.json.fable_upsell, undefined);
  assert.deepStrictEqual(r.json.model_question, { value: 'never', origin: 'ceiling' });
  assert.ok(conConfig('deep-review-gate', 'heavy', [], { mandatory_ceiling: true, ceiling: 'fable' }).json.fable_upsell);
});

test('T16 Control_LanzamientoArribaDelTecho_AvisaSinCambiar @story-7.29 @ac-15', () => {
  const skills = tmp('skills');
  fs.mkdirSync(path.join(skills, 'skills'));
  fs.mkdirSync(path.join(skills, 'agents'));
  fs.writeFileSync(path.join(skills, 'agents', 'tycon-spec-first-checker.md'), '---\nname: tycon-spec-first-checker\nmodel: opus\n---\n');
  const tree = labTree(equipo({ mandatory_ceiling: true, ceiling: 'sonnet' }));
  const lanzar = (tool, input, extra = {}) => {
    const home = tmp('home');
    const ev = { tool_name: tool, session_id: SID, cwd: tmp('cwd'), tool_input: input };
    const r = correr(HOOK, [], { home, tree, input: JSON.stringify(ev), extra: { TYCON_SKILLS_DIR: skills, ...extra } });
    const log = fs.readFileSync(path.join(home, '.claude', '.tycon-pipeline', 'advisor-runs', `${SID}.jsonl`), 'utf8');
    return { ...r, log };
  };
  const conModelo = lanzar('Agent', { subagent_type: 'tycon-plugin-security-basics', model: 'opus', prompt: 'x' });
  const delMd = lanzar('Agent', { subagent_type: 'tycon-spec-first-checker', prompt: 'x' });
  const apagado = lanzar('Agent', { subagent_type: 'tycon-spec-first-checker', model: 'opus', prompt: 'x' }, { TYCON_SPAWN_GOVERNANCE: '0' });
  const codex = lanzar('collaborationspawn_agent', { agent_type: 'tycon-spec-first-checker', prompt: 'x' });
  for (const r of [conModelo, delMd, apagado, codex]) {
    assert.equal(r.status, 0);
    assert.match(r.log, /"advisor":"tycon-/);
    assert.doesNotMatch(r.stdout, /"decision"|permissionDecision|updatedInput/);
  }
  assert.match(conModelo.stdout, /este lanzamiento usa opus, por encima del techo de la organización \(sonnet\)/);
  assert.match(delMd.stdout, /este lanzamiento usa opus, por encima del techo de la organización \(sonnet\)/);
  assert.doesNotMatch(apagado.stdout, /techo/);
  assert.doesNotMatch(codex.stdout, /techo/);
  // con la configuración ilegible, el control lo dice (no es «sin techo» callado) y sale 0 igual
  const roto = labTree('{ roto');
  const ev = { tool_name: 'Agent', session_id: SID, cwd: tmp('cwd'), tool_input: { subagent_type: 'tycon-spec-first-checker', model: 'opus', prompt: 'x' } };
  const r = correr(HOOK, [], { tree: roto, input: JSON.stringify(ev), extra: { TYCON_SKILLS_DIR: skills } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no pude leer la configuración de la organización.*el techo de la organización no se controla/);
});

test('T17 ConfigIlegible_ValoresDeHoyYUnaLinea @story-7.29 @ac-4', () => {
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8')).casos;
  const roto = conConfig('advisors', 'normal', [], '{ esto no es json');
  assert.equal(roto.status, 0);
  assert.deepStrictEqual(campos('advisors', roto.json), foto['advisors-i1']);
  assert.match(roto.json.models_problem, /^no pude leer la configuración de la organización \(.*team-repos\.json: .*\): uso los valores de hoy/);
  const suelto = conConfig('deep-review-gate', 'heavy', [], { ceiling: 'sonnet' });
  assert.deepStrictEqual(campos('deep-review-gate', suelto.json), foto['gate-heavy']);
  assert.match(suelto.json.models_problem, /no pude leer la configuración de la organización/);
  const conTecho = conConfig('deep-review-gate', 'heavy', [], { mandatory_ceiling: 'si', ceiling: 'sonnet' });
  assert.match(conTecho.json.models_problem, /no sé si hay techo/);
  for (const cmd of ['start', 'model-hint', 'smart-reloop']) {
    const r = conConfig(cmd, 'normal', cmd === 'smart-reloop' ? ['--iter', '2'] : [], '{ roto');
    assert.match(r.json.models_problem, /no pude leer la configuración de la organización/, cmd);
  }
  const fantasma = conConfig('advisors', 'normal', [], { reviewer: { 'acme-no-existe': 'opus' } });
  assert.ok(fantasma.json.models_warnings.some((w) => w.includes('`acme-no-existe` no es un revisor de este arnés: no se usa')));
});

test('T18 WorkflowLite_SinEquivalente_DefaultDeCodex @story-7.29 @ac-17', () => {
  const lite = require(path.join(SCRIPTS, 'workflow-lite.js'));
  const M = models();
  const mapa = { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-luna', haiku: 'gpt-5.4-mini', fable: 'gpt-5.6-sol' };
  const { haiku: _h, ...sinHaiku } = mapa;
  const { fable: _f, ...sinFable } = mapa;
  const avisos = [];
  const decir = (t) => avisos.push(t);
  assert.equal(lite.slugFor('haiku', sinHaiku, decir), null);
  assert.equal(lite.slugFor('fable', sinFable, decir), null);
  assert.equal(avisos.length, 2);
  assert.match(avisos[0], /el modelo haiku no tiene equivalente en Codex: uso el modelo por defecto de Codex/);
  assert.equal(lite.slugFor('gpt-5.6-luna', mapa, decir), 'gpt-5.6-luna');
  assert.equal(lite.slugFor('sonnet', mapa, decir), 'gpt-5.6-luna');
  assert.equal(lite.slugFor(undefined, mapa, decir), mapa[M.DEFAULTS.adversarial.model]);
});

test('T19 Codex_PedidoYVueltas_LoDice @story-7.29 @ac-18', () => {
  const texto = 'en Codex los revisores usan el modelo con que se desplegaron; el pedido de esta corrida y las vueltas siguientes no aplican ahí';
  assert.equal(conConfig('advisors', 'normal', ['--iter', '2'], { helpers: 'haiku' }).json.codex_note, texto);
  const home = tmp('home');
  marcador(home);
  correr(MARKER, ['set-models', 'reviewers=haiku'], { home });
  assert.equal(conConfig('advisors', 'normal', [], { helpers: 'haiku' }, { home }).json.codex_note, texto);
  assert.equal(conConfig('advisors', 'normal', [], { helpers: 'haiku' }).json.codex_note, undefined);
});

test('T27 NombresInventados_Y_SinShell @story-7.29 @ac-19', () => {
  const propios = [MODELS_JS, __filename];
  for (const f of propios) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /execSync\(|shell:\s*true/, f);
    assert.doesNotMatch(src, /['"`][^'"`\n]*\/(Users|home)\/[a-z]/, `${f}: ruta de una máquina`);
  }
  assert.match(fs.readFileSync(__filename, 'utf8'), /acme/);
});

test('T29 Suites_NoLeenLaConfiguracionDeLaMaquina @story-7.29 @ac-21', () => {
  const P = require(PIPELINE);
  const repo = labRepo();
  const medir = () => ['low', 'normal', 'heavy'].map((c) => {
    const story = path.join(repo, 'specs', `${c}.md`);
    const h = P.computeModelHint({ story, repo, files: [] });
    const g = P.computeDeepReviewGate({ story, repo, files: [] });
    return { h, g: { model: g.model, fable_upsell: g.fable_upsell, model_question: g.model_question } };
  });
  const guardar = { HOME: process.env.HOME, TYCON_GUIDES_DIR: process.env.TYCON_GUIDES_DIR };
  const home = tmp('home');
  const tree = labTree(equipo({ mandatory_ceiling: true, ceiling: 'haiku', adversarial: { fable_question: 'never' }, session: { low: 'haiku', normal: 'haiku', heavy: 'haiku' } }));
  try {
    process.env.HOME = tmp('home-limpio');
    delete process.env.TYCON_GUIDES_DIR;
    const limpio = medir();
    process.env.HOME = home;
    process.env.TYCON_GUIDES_DIR = tree;
    execFileSync(process.execPath, [path.join(tree, 'scripts', 'lib', 'tycon-config.js'), 'set', 'adversarial.model_question', 'never'], { env: ambiente({ home, tree }), stdio: 'ignore' });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const conCapa = medir();
    assert.deepStrictEqual(conCapa, limpio);
  } finally {
    for (const [k, v] of Object.entries(guardar)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // y el comando, como lo corren las suites (HOME aislado), da lo mismo que la foto
  const foto = JSON.parse(fs.readFileSync(FOTO, 'utf8')).casos;
  assert.deepStrictEqual(medirCaso(CASOS.find((c) => c[0] === 'hint-heavy'), {}).campos, foto['hint-heavy']);
});
