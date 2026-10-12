'use strict';

/**
 * mirror.test.js — la sincronización con el repo público (épica 8, story 8.8, tanda A · 2026-10-03).
 *
 * Lo que no se puede perder, en orden de gravedad:
 *   · Que nada llegue al repo público sin pasar por el exportador y sus controles, y que fuera de la primera publicación
 *     ningún camino escriba en `main`: todo lo demás va a la rama `mirror/sync` y a UN pull request.
 *   · Que «no pude leer» nunca se lea como «no hay nada»: 2, sin escribir.
 *   · Que el token salga sólo de su variable, viaje por el ambiente y no aparezca en ninguna salida.
 *   · Que `verify` mire TODO lo publicado, también lo que no es git —versiones, pedidos, issues, comentarios, cada
 *     lista hasta su última página—, y que cada hallazgo diga qué hacer (story 8.26, tanda F2: T24 y T65).
 *
 * SIN RED. El «repo público» es un repo `--bare` en un temporal (`TYCON_MIRROR_GIT_BASE=file://…`), con un hook que
 * anota cada ref empujada; la «API» es un servidor de este mismo proceso en 127.0.0.1 (`TYCON_MIRROR_API_URL`), que anota
 * cada pedido. Los repos internos son dos repos de mentira (un arnés y un agent-skills) y la configuración del exportador
 * es SINTÉTICA y va por opción: esta suite también corre en la copia pública, donde la lista de denegación, la tabla de
 * reemplazos y el archivo del nombre público no existen. Por eso mismo el guion se lanza con `spawn` y una promesa: con
 * `spawnSync` este proceso no podría contestarle a la API de mentira mientras espera.
 *
 * Los valores con forma de secreto y las direcciones de correo de los firmantes de GitHub se arman por partes: ninguna
 * línea de este archivo trae uno entero.
 *
 * A mano: node scripts/tests/mirror.test.js   ·   una sola: node --test --test-name-pattern "<nombre>" scripts/tests/mirror.test.js
 */

const test = require('./lib/suite-parts.js').test;   // se corre por partes: lib/suite-parts.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const PUBLISHING = path.join(RAIZ, 'scripts', 'publishing');
const MIRROR = path.join(PUBLISHING, 'mirror.js');
const EXPORTER = path.join(PUBLISHING, 'export.js');

// ── git de la fixture: sin la configuración de la máquina, con autor y fechas fijas ─────────────────────────────────
function withoutGit(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_')) out[k] = v;
  return out;
}
const ISOLATED = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

function gitFx(dir, args, opts = {}) {
  const env = { ...withoutGit(process.env), ...ISOLATED, ...FIXTURE_IDENTITY, ...(opts.env || {}) };
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { env, encoding: 'utf8', input: opts.input });
  if (r.status !== 0 && !opts.tolerate) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return opts.tolerate ? r : r.stdout.trim();
}

// las fechas de la fixture son fijas: cada commit, cien segundos después del anterior
let clock = 1700000000;
const nextDate = () => { clock += 100; return `@${clock} +0000`; };

function commit(dir, message, { allowEmpty = false } = {}) {
  const date = nextDate();
  gitFx(dir, ['add', '-A']);
  gitFx(dir, ['commit', '-q', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return gitFx(dir, ['rev-parse', 'HEAD']);
}

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// ── la configuración sintética ─────────────────────────────────────────────────────────────────────────────────────
// El nombre público de mentira: el de verdad vive en un archivo que no viaja, y acá no se escribe.
const PUBLIC = { __doc: 'nombre público de mentira', org: 'example-org', repo: 'example-harness' };
const PAPERS_DIR = 'scripts/publishing/public-files';
const PAPERS = {
  LICENSE: '                                 Apache License\n                           Version 2.0, January 2004\n\n   (texto de prueba)\n',
  NOTICE: 'Arnés de mentira\n',
  '.github/README.md': '# Example harness\n\nA harness, for the tests.\n',
  '.github/README.es.md': '# Arnés de ejemplo\n\nUn arnés, para las pruebas.\n',
  '.github/CONTRIBUTING.md': '# Contributing\n\nPull requests are not merged here.\n',
  '.github/CODE_OF_CONDUCT.md': '# Code of conduct\n\nBe kind.\n',
  '.github/SECURITY.md': '# Security\n\nReport privately.\n',
};
const paper = (target) => ({ target, from: `${PAPERS_DIR}/${target}`, packages: ['core'], reason: 'papel de prueba' });
const ALLOWLIST = {
  __doc: 'Lista blanca sintética de la prueba.',
  packages: {
    core: {
      arnes: {
        in: ['README.md', '.gitignore', 'scripts/**', 'guides/**', 'commands/**'],
        out: [
          { glob: 'guides/bizuit/*.md', reason: 'va al paquete bizuit' },
          { glob: `${PAPERS_DIR}/**`, reason: 'los papeles llegan a su destino por un sintético' },
        ],
      },
      'agent-skills': {
        in: ['.gitignore', 'skills/tycon-*/**', 'agents/*.md'],
        out: [{ glob: 'packs/**', reason: 'cada manifiesto viaja con su paquete' }],
      },
    },
    bizuit: {
      arnes: { in: ['guides/bizuit/bizuit-plugin.md'], out: [] },
      'agent-skills': { in: ['packs/bizuit/pack.json'], out: [] },
    },
  },
  suitesOutside: [],
  casesOutside: [],
  empty: {},
  synthetic: Object.keys(PAPERS).map(paper),
};
const REPLACEMENTS = {
  pares: [{
    real: 'AcmeCorp', categoria: 'cliente',
    formas: [{ texto: 'AcmeCorp', anonimo: 'ClienteA' }, { texto: 'ACME', anonimo: 'CLIENTEA' }, { texto: 'acmecorp', anonimo: 'clientea' }],
    palabra: true, mayusculas: true, anonimoProsa: 'Cliente A',
  }, {
    real: 'Vandelay', categoria: 'persona', palabra: true, formas: [{ texto: 'Vandelay', anonimo: 'PersonaA' }],
  }],
  afuera: [],
};
// Un nombre de cliente y una persona, los dos inventados. La persona es quien mergea en GitHub el pull request de la
// sincronización: su correo anónimo, el correo «de verdad» (con un dominio inventado que NO es de ejemplo: uno de ejemplo
// el detector lo deja pasar) y el firmante automático de los commits web de GitHub se arman por partes.
const TERM = 'AcmeCorp';
const MERGER = 'Vandelay';
const MERGER_NOREPLY = ['4242+vandelay', 'users.noreply.github.com'].join('@');
const MERGER_REAL = ['vandelay', 'correo-inventado.dev'].join('@');
const WEB_COMMITTER = ['noreply', 'github.com'].join('@');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * La lista de denegación sintética, con la excepción de identidad en el mismo formato que la de verdad: acotada a la
 * ruta ficticia de la identidad de los commits y a los valores exactos. La identidad fija del commit sale del
 * exportador: su valor no se copia acá.
 */
function denylist() {
  return {
    terminos: [
      { patron: TERM, categoria: 'cliente', palabra: true },
      { patron: 'ACME', categoria: 'cliente', palabra: true, mayusculas: true },
      { patron: MERGER, categoria: 'persona', palabra: true },
    ],
    permitidos: [{
      archivo: '<commit-identity>', patron: `^(${escapeRegex(MERGER)}|${escapeRegex(MERGER_NOREPLY)})$`,
      motivo: 'quien mergea el pull request de la sincronización, con su correo anónimo: sólo en la identidad de los commits',
    }],
    emailsPermitidos: [require(EXPORTER).COMMIT_IDENTITY.email, WEB_COMMITTER],
  };
}

// La muestra de cada exclusión fija del exportador: un archivo que la exclusión cubre (sin ella, la exclusión «sin
// archivo» frena la exportación de la fixture).
function fixedSamples(source) {
  const sample = (glob) => glob.replace(/^\*\*\//, '').replace(/\/\*\*$/, '/muestra.txt').replace(/[*?]/g, 'x');
  return (require(EXPORTER).EXCLUIDOS_SIEMPRE || []).filter((f) => f.fuente === source && !f.clase).map((f) => sample(f.glob));
}

// ── la fixture: se arma una vez y cada prueba trabaja sobre su copia ────────────────────────────────────────────────
let template = null;
function buildTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-template-'));
  const harness = path.join(dir, 'harness');
  const skills = path.join(dir, 'agent-skills');
  for (const d of [harness, skills]) {
    fs.mkdirSync(d, { recursive: true });
    gitFx(d, ['init', '-q', '-b', 'main']);
  }
  const inHarness = {};
  for (const s of fixedSamples('arnes')) inHarness[s] = 'muestra de una exclusión fija\n';
  Object.assign(inHarness, {
    'README.md': '# Arnés de mentira\n\nPara probar la publicación.\n',
    '.gitignore': 'node_modules/\n*.log\n',
    'scripts/hola.js': "'use strict';\nmodule.exports = () => 'hola';\n",
    'guides/guia.md': '# Guía\n\nPrimera versión.\n',
    'guides/bizuit/bizuit-plugin.md': '# Plugins del stack\n\nCómo se arma uno.\n',
    // el exportador lee los productos del registro de paridad: el de la fixture, uno que la lista ve
    'scripts/ci/product-parity.json': `${JSON.stringify({ grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/Backend' }] } }, null, 2)}\n`,
  });
  for (const [target, text] of Object.entries(PAPERS)) inHarness[`${PAPERS_DIR}/${target}`] = text;
  write(harness, inHarness);

  const inSkills = {};
  for (const s of fixedSamples('agent-skills')) inSkills[s] = 'muestra de una exclusión fija\n';
  Object.assign(inSkills, {
    '.gitignore': 'node_modules/\n',
    'skills/tycon-pipeline/SKILL.md': '---\nname: tycon-pipeline\n---\n\nOrquesta el pipeline.\n',
    'skills/tycon-pipeline/scripts/paso.js': "'use strict';\nmodule.exports = 1;\n",
    'agents/revisor-nucleo.md': '---\nname: revisor-nucleo\ndescription: Revisor de mentira\n---\n\nRevisa el núcleo.\n',
    'packs/bizuit/pack.json': `${JSON.stringify({ name: 'bizuit', reviewers: [] }, null, 2)}\n`,
  });
  write(skills, inSkills);

  const first = { harness: commit(harness, 'primero'), skills: commit(skills, 'primero') };
  write(harness, { 'guides/guia.md': '# Guía\n\nSegunda versión.\n' });
  write(skills, { 'skills/tycon-pipeline/segundo.md': '# Segundo\n' });
  commit(harness, 'segundo');
  commit(skills, 'segundo');
  return { dir, first };
}

const created = [];
let api = null;

/** Una fixture nueva: los dos internos de mentira, la configuración sintética, el público `--bare` y la API en cero. */
async function fixture({ publicRepo = PUBLIC } = {}) {
  if (!template) template = buildTemplate();
  if (!api) api = await startApi();
  api.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  created.push(dir);
  fs.cpSync(template.dir, dir, { recursive: true });
  const fx = {
    dir,
    api,
    publicRepo,
    harness: path.join(dir, 'harness'),
    skills: path.join(dir, 'agent-skills'),
    first: template.first,
    github: path.join(dir, 'github'),
    pushLog: path.join(dir, 'pushes.log'),
    cfg: {
      allowlist: path.join(dir, 'cfg', 'allowlist.json'), replacements: path.join(dir, 'cfg', 'replacements.json'),
      denied: path.join(dir, 'cfg', 'denylist.json'), publicRepos: path.join(dir, 'cfg', 'public-repos.json'),
    },
    config(parts = {}) {
      for (const [k, v] of Object.entries(parts)) fs.writeFileSync(fx.cfg[k], `${JSON.stringify(v, null, 2)}\n`);
    },
  };
  fs.mkdirSync(path.join(dir, 'cfg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(fx.pushLog, '');
  fx.config({ allowlist: ALLOWLIST, replacements: REPLACEMENTS, denied: denylist(), publicRepos: publicRepo });
  fx.bare = bareRepo(fx, publicRepo);
  return fx;
}

/** El repo público de mentira: `--bare`, en <github>/<org>/<repo>.git, con un hook que anota cada ref empujada. */
function bareRepo(fx, { org, repo }) {
  const bare = path.join(fx.github, org, `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  gitFx(bare, ['init', '-q', '--bare', '-b', 'main']);
  const hook = path.join(bare, 'hooks', 'post-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$old $new $ref" >> "${fx.pushLog}"; done\n`);
  fs.chmodSync(hook, 0o755);
  return bare;
}

const refsOf = (bare) => gitFx(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
const pushes = (fx) => fs.readFileSync(fx.pushLog, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[2]);

// ── la API de mentira ──────────────────────────────────────────────────────────────────────────────────────────────
const FULL_RULES = () => [
  { type: 'deletion' },
  { type: 'non_fast_forward' },
  { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true } },
  { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'un-chequeo' }] } },
];
const defaultState = () => ({
  credential: null,          // con un valor, la API exige `Authorization: Bearer <valor>` (un repo privado)
  repo: {
    private: false, description: 'A harness, for the tests', homepage: '', default_branch: 'main',
    allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false,
  },
  topics: ['harness'],
  rules: FULL_RULES(),
  pulls: [],
  comments: [],
  // lo publicado que no es git (story 8.26, tanda F2): lo que `verify` lee por la API, cada lista de a páginas
  releases: [],
  issues: [],            // pedidos (con `pull_request`) e issues, abiertos y cerrados
  labels: [],
  milestones: [],
  issueComments: [],
  reviewComments: [],
  commitComments: [],
  issueEvents: [],       // la línea de tiempo de los pedidos y los issues (un título anterior, una etiqueta borrada…)
  reviews: {},           // número de pedido → sus revisiones
  alerts: [],
  vulnerabilityReporting: { enabled: true },
  installation: 'instalacion-de-mentira',
});

function startApi() {
  return new Promise((resolve) => {
    const self = { requests: [], state: defaultState(), override: null };
    self.reset = () => { self.requests = []; self.state = defaultState(); self.override = null; };
    self.writes = () => self.requests.filter((q) => q.method !== 'GET');
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        const q = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
        self.requests.push(q);
        const a = (self.override && self.override(q)) || route(self.state, q);
        if (a.hang) return;   // nunca contesta
        res.writeHead(a.status, { 'Content-Type': 'application/json' });
        res.end(a.raw !== undefined ? a.raw : JSON.stringify(a.json === undefined ? {} : a.json));
      });
    });
    self.close = () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); });
    server.listen(0, '127.0.0.1', () => {
      self.url = `http://127.0.0.1:${server.address().port}`;
      resolve(self);
    });
  });
}

function route(s, q) {
  const notFound = { status: 404, json: { message: 'Not Found' } };
  if (q.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(q.path)) return { status: 201, json: { token: s.installation } };
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(q.path);
  if (!m) return notFound;
  if (s.credential && q.headers.authorization !== `Bearer ${s.credential}`) return notFound;
  const rest = m[3] || '';
  if (q.method === 'GET' && rest === '') return { status: 200, json: s.repo };
  if (q.method === 'GET' && rest === '/topics') return { status: 200, json: { names: s.topics } };
  if (q.method === 'GET' && rest === '/rules/branches/main') return { status: 200, json: s.rules };
  if (q.method === 'GET' && rest === '/secret-scanning/alerts') return { status: 200, json: s.alerts };
  if (q.method === 'GET' && rest === '/private-vulnerability-reporting') return { status: 200, json: s.vulnerabilityReporting };
  // las listas que `verify` lee enteras: de a `per_page`, la página que se pida
  const paged = (list) => {
    const size = Number(q.query.per_page) || 30;
    const page = Number(q.query.page) || 1;
    return { status: 200, json: list.slice((page - 1) * size, page * size) };
  };
  const lists = { '/releases': s.releases, '/issues': s.issues, '/labels': s.labels, '/milestones': s.milestones, '/issues/comments': s.issueComments,
    '/pulls/comments': s.reviewComments, '/comments': s.commitComments, '/issues/events': s.issueEvents };
  if (q.method === 'GET' && lists[rest]) return paged(lists[rest]);
  // todos los pedidos, abiertos y cerrados, de a páginas (de acá sale el nombre de la rama de cada uno)
  if (q.method === 'GET' && rest === '/pulls' && q.query.state === 'all') return paged(s.pulls);
  const reviews = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
  if (q.method === 'GET' && reviews) return paged(s.reviews[reviews[1]] || []);
  if (q.method === 'GET' && rest === '/pulls') {
    const head = String(q.query.head || '').split(':').pop();
    // (un pedido roto de una prueba —sin su rama, o que no es un objeto— no es uno abierto de esa rama)
    return { status: 200, json: s.pulls.filter((p) => p && p.state === (q.query.state || 'open') && (!head || (p.head && p.head.ref === head)) && (!q.query.base || (p.base && p.base.ref === q.query.base))) };
  }
  if (q.method === 'POST' && rest === '/pulls') {
    const pr = { number: s.pulls.length + 1, state: 'open', title: q.body.title, body: q.body.body, head: { ref: q.body.head, label: `${m[1]}:${q.body.head}` }, base: { ref: q.body.base } };
    s.pulls.push(pr);
    return { status: 201, json: pr };
  }
  const one = /^\/pulls\/(\d+)$/.exec(rest);
  if (one && q.method === 'PATCH') {
    const pr = s.pulls.find((p) => p.number === Number(one[1]));
    if (!pr) return notFound;
    Object.assign(pr, q.body);
    return { status: 200, json: pr };
  }
  const comment = /^\/issues\/(\d+)\/comments$/.exec(rest);
  if (comment && q.method === 'POST') {
    s.comments.push({ issue: Number(comment[1]), body: q.body.body });
    return { status: 201, json: { id: s.comments.length } };
  }
  return notFound;
}

// ── correr el guion ────────────────────────────────────────────────────────────────────────────────────────────────
function run(script, args, env, cwd, { umask = null } = {}) {
  return new Promise((resolve) => {
    const options = { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] };
    // con otra máscara de permisos: la pone un shell, que después se reemplaza por node
    const child = umask
      ? spawn('sh', ['-c', `umask ${umask} && exec "$0" "$@"`, process.execPath, script, ...args], options)
      : spawn(process.execPath, [script, ...args], options);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out); } catch { json = null; }
      resolve({ code, out, err, json, all: `${out}\n${err}` });
    });
  });
}

/** El ambiente del guion: sin las variables de git ni credenciales heredadas, con los internos, el público y la API de mentira. */
function mirrorEnv(fx, { credential, env = {}, guides = true } = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('TYCON_MIRROR_') || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN' || k === 'TYCON_GUIDES_DIR') continue;
    e[k] = v;
  }
  if (guides) e.TYCON_GUIDES_DIR = fx.harness;
  e.TYCON_SKILLS_DIR = fx.skills;
  e.TYCON_MIRROR_GIT_BASE = `file://${fx.github}`;
  e.TYCON_MIRROR_API_URL = fx.api.url;
  if (credential) e.TYCON_MIRROR_TOKEN = credential;
  return { ...e, ...env };
}

/**
 * Corre mirror.js: `args[0]` es el subcomando. Por defecto pasa la configuración sintética por opción y toma agent-skills
 * de su HEAD (los internos de mentira no tienen remoto); `config: false` y `refs: false` dejan los valores por defecto.
 */
function mirror(fx, args, opts = {}) {
  const extra = [];
  if (opts.config !== false) {
    extra.push('--allowlist', fx.cfg.allowlist, '--replacements', fx.cfg.replacements, '--denied', fx.cfg.denied, '--public-repos', fx.cfg.publicRepos);
  }
  if (opts.refs !== false) extra.push('--agent-skills', 'HEAD');
  return run(opts.script || MIRROR, [args[0], ...extra, ...args.slice(1)], mirrorEnv(fx, opts), fx.dir, { umask: opts.umask });
}

/** Lo mismo, comprobando que la corrida no movió ninguna ref del público, no empujó y no escribió por la API. */
async function mirrorReadOnly(fx, args, opts = {}) {
  const before = refsOf(fx.bare);
  const pushed = pushes(fx).length;
  const written = fx.api.writes().length;
  const r = await mirror(fx, args, opts);
  assert.strictEqual(refsOf(fx.bare), before, `${args.join(' ')}: las refs del público, iguales antes y después`);
  assert.strictEqual(pushes(fx).length, pushed, `${args.join(' ')}: ningún push`);
  assert.strictEqual(fx.api.writes().length, written, `${args.join(' ')}: ningún pedido de escritura a la API`);
  return r;
}

// ── el estado del público, armado a mano ───────────────────────────────────────────────────────────────────────────
let serial = 0;

/** El exportador, tal como lo llama el guion, sobre los internos de la fixture: lo que contestó, y dónde dejó la copia. */
function runExporter(fx) {
  const out = path.join(fx.dir, 'out', `copy-${++serial}`);
  const r = spawnSync(process.execPath, [EXPORTER, '--package', 'core,bizuit', '--single-repo', '--output', out,
    '--allowlist', fx.cfg.allowlist, '--replacements', fx.cfg.replacements, '--denied', fx.cfg.denied, '--public-repos', fx.cfg.publicRepos,
    '--harness', 'HEAD', '--agent-skills', 'HEAD', '--json'], {
    cwd: fx.dir, encoding: 'utf8', env: { ...withoutGit(process.env), TYCON_GUIDES_DIR: fx.harness, TYCON_SKILLS_DIR: fx.skills },
  });
  return { r, out };
}

/** La copia que publicaría la corrida: el exportador, tal como lo llama el guion, sobre los internos de la fixture. */
function exportCopy(fx) {
  const { r, out } = runExporter(fx);
  assert.strictEqual(r.status, 0, `la fixture no pudo exportar: ${r.stderr}\n${r.stdout}`);
  const json = JSON.parse(r.stdout);
  const only = Object.keys(json.repos);
  assert.strictEqual(only.length, 1, 'la fixture exporta un solo repo');
  return { dir: out, tree: json.repos[only[0]].arbol, harness: json.fuentes.arnes.sha, skills: json.fuentes['agent-skills'].sha };
}

const trailers = (copy) => `Mirror-Harness-Commit: ${copy.harness}\nMirror-Agent-Skills-Commit: ${copy.skills}\nMirror-Tree: ${copy.tree}\n`;

/** La identidad fija con que el guion firma sus commits, como ambiente de git: sale del exportador, no se copia acá. */
function mirrorIdentity() {
  const fixed = require(EXPORTER).COMMIT_IDENTITY;
  return { GIT_AUTHOR_NAME: fixed.nombre, GIT_AUTHOR_EMAIL: fixed.email, GIT_COMMITTER_NAME: fixed.nombre, GIT_COMMITTER_EMAIL: fixed.email };
}

/**
 * Deja en `main` del público lo que deja la primera publicación: un commit raíz con el árbol exportado, los tres
 * trailers y la identidad fija de la copia.
 */
function seedPublication(fx) {
  const copy = exportCopy(fx);
  const date = nextDate();
  const root = gitFx(copy.dir, ['commit-tree', copy.tree, '-m', `Primera publicación\n\n${trailers(copy)}`], { env: { ...mirrorIdentity(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  gitFx(copy.dir, ['update-ref', 'refs/heads/seed', root]);
  gitFx(fx.bare, ['fetch', '-q', copy.dir, 'refs/heads/seed:refs/heads/main']);
  return { ...copy, commit: root };
}

/**
 * Un commit escrito directo en el público (lo que deja un merge hecho en GitHub): por plomería, sin pasar por sus hooks.
 * Su árbol es el de `from` (por defecto, el del primer padre) más `files`; `message` puede ser una función del árbol.
 */
function publicCommit(fx, { parents = [], from = parents[0], files = {}, message, ref = 'refs/heads/main', identity = {} }) {
  const index = path.join(fx.dir, `index-${++serial}`);
  const date = nextDate();
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...identity };
  if (from) gitFx(fx.bare, ['read-tree', from], { env });
  for (const [rel, content] of Object.entries(files)) {
    // (con modo 0, `--index-info` saca la ruta: `--force-remove` pide un árbol de trabajo, y el público es `--bare`)
    if (content === null) { gitFx(fx.bare, ['update-index', '--index-info'], { env, input: `0 ${'0'.repeat(40)}\t${rel}\n` }); continue; }
    // `{ gitlink: <sha> }`: un submódulo (la entrada apunta a un commit de OTRO repo, que éste no tiene)
    if (typeof content === 'object' && content.gitlink) { gitFx(fx.bare, ['update-index', '--add', '--cacheinfo', `160000,${content.gitlink},${rel}`], { env }); continue; }
    const blob = gitFx(fx.bare, ['hash-object', '-w', '--stdin'], { input: content });
    gitFx(fx.bare, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { env });
  }
  const tree = gitFx(fx.bare, ['write-tree'], { env });
  const text = typeof message === 'function' ? message(tree) : message;
  const sha = gitFx(fx.bare, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', text], { env });
  if (ref) gitFx(fx.bare, ['update-ref', ref, sha]);
  fs.rmSync(index, { force: true });
  return sha;
}

/** Un commit de la sincronización en el público, armado a mano: la identidad fija y los tres trailers, con el de su árbol bien puesto. */
function syncCommit(fx, seed, { parent = null, files = {}, subject = 'Sincronización', ref = null } = {}) {
  return publicCommit(fx, {
    parents: parent ? [parent] : [], from: seed.commit, files, ref, identity: mirrorIdentity(),
    message: (tree) => `${subject}\n\nMirror-Harness-Commit: ${seed.harness}\nMirror-Agent-Skills-Commit: ${seed.skills}\nMirror-Tree: ${tree}\n`,
  });
}

/** Un puerto de 127.0.0.1 donde no escucha nadie. */
function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Un `git` de mentira adelante en el PATH: anota los argumentos y el ambiente de cada llamada y después corre el de verdad.
 * Con `requires` (un token), además se porta como GitHub ante un repo privado: si el ambiente no trae la cabecera de ESE
 * token tal como git la necesita para mandarla, leer o empujar falla.
 * Con `watch` (`{ dir, needles }`), en cada llamada que habla con el público busca cada texto en esa carpeta y anota el
 * archivo que lo trae. Con `onPush` (una función que recibe el git de verdad y devuelve comandos de shell), la llamada
 * número N a `push` corre antes el comando N: es «otra corrida» que se mete entre la lectura y el push.
 */
function fakeGit(fx, { requires = null, watch = null, onPush = null } = {}) {
  const bin = path.join(fx.dir, 'bin');
  const log = path.join(fx.dir, 'git-calls.log');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(real, 'la fixture necesita git');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(log, '');
  const lines = [
    '#!/bin/sh',
    `{ printf 'ARGS'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; env | grep -E '^(GIT_CONFIG_|GH_|GITHUB_|TYCON_MIRROR_)' | sed 's/^/ENV /'; } >> "${log}"`,
  ];
  if (requires) {
    // lo que git necesita para mandar la cabecera: una entrada de configuración por el ambiente, para las URL del público
    const wanted = [['GIT_CONFIG_COUNT', '1'], ['GIT_CONFIG_KEY_0', `http.file://${fx.github}/.extraheader`], ['GIT_CONFIG_VALUE_0', authHeader(requires)]];
    lines.push('case " $* " in *" ls-remote "*|*" fetch "*|*" push "*)',
      `  if ${wanted.map(([k, v]) => `[ "\${${k}:-}" != "${v}" ]`).join(' || ')}; then`,
      '    echo "fatal: could not read Username for \'https://github.com\': terminal prompts disabled" >&2; exit 128',
      '  fi;;',
      'esac');
  }
  if (watch) {
    lines.push('case " $* " in *" ls-remote "*|*" fetch "*|*" push "*)',
      ...watch.needles.map((needle) => `  grep -rlF -- "${needle}" "${watch.dir}" 2>/dev/null | sed 's/^/DISK /' >> "${log}"`),
      '  ;;',
      'esac');
  }
  if (onPush) {
    const counter = path.join(fx.dir, 'push-count');
    lines.push('case " $* " in *" push "*)',
      `  n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${counter}"`,
      '  case "$n" in',
      ...onPush(`"${real}"`).map((command, i) => `    ${i + 1}) ${command} ;;`),
      '  esac;;',
      'esac');
  }
  lines.push(`exec "${real}" "$@"`, '');
  fs.writeFileSync(path.join(bin, 'git'), lines.join('\n'));
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, log, calls: () => fs.readFileSync(log, 'utf8') };
}

/** Lo que anotó el git de mentira: de cada llamada, sus argumentos, lo que traía su ambiente y lo que encontró en el disco. */
function gitCalls(github) {
  const calls = [];
  for (const line of github.calls().split('\n')) {
    const last = calls[calls.length - 1];
    if (line.startsWith('ARGS')) calls.push({ args: `${line.slice(4)} `, env: {}, disk: [] });
    else if (last && line.startsWith('ENV ')) last.env[line.slice(4, line.indexOf('='))] = line.slice(line.indexOf('=') + 1);
    else if (last && line.startsWith('DISK ')) last.disk.push(line.slice(5));
  }
  return calls;
}
/** Las llamadas que hablan con el público. */
const remoteCalls = (github, kind = 'ls-remote|fetch|push') => gitCalls(github).filter((c) => new RegExp(` (${kind}) `).test(c.args));
/** La cabecera con la que git se presenta ante GitHub (AC 14): el valor que el guion le pasa por el ambiente. */
const authHeader = (credential) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${credential}`).toString('base64')}`;

// Centinelas: no tienen forma de token de nadie, sólo son únicos.
const READER = 'lector-de-mentira-0001';

// ── T1 · AC 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_PublicRepos_InvalidOrMissing_Exit2', async () => {
  const fx = await fixture();
  const broken = path.join(fx.dir, 'cfg', 'roto.json');
  const cases = [
    ['ausente', () => path.join(fx.dir, 'cfg', 'no-existe.json'), /no pude leer el nombre público/],
    ['ilegible', () => { fs.writeFileSync(broken, '{ "org": '); return broken; }, /no es JSON válido/],
    ['sin organización', () => { fs.writeFileSync(broken, JSON.stringify({ repo: 'example-harness' })); return broken; }, /falta "org"/],
    ['sin repo', () => { fs.writeFileSync(broken, JSON.stringify({ org: 'example-org' })); return broken; }, /falta "repo"/],
    ['un nombre con espacio', () => { fs.writeFileSync(broken, JSON.stringify({ org: 'example-org', repo: 'example harness' })); return broken; }, /caracteres fuera de/],
  ];
  for (const [name, prepare, reason] of cases) {
    const file = prepare();
    for (const command of ['plan', 'first', 'sync', 'verify']) {
      const r = await mirrorReadOnly(fx, [command, '--public-repos', file], { credential: READER });
      assert.strictEqual(r.code, 2, `${name}, ${command}: sale 2\n${r.all}`);
      assert.match(r.err, reason, `${name}, ${command}: dice el motivo`);
    }
  }
  // con --json el motivo también va en el objeto
  const r = await mirrorReadOnly(fx, ['plan', '--json', '--public-repos', path.join(fx.dir, 'cfg', 'no-existe.json')]);
  assert.strictEqual(r.code, 2, r.all);
  assert.strictEqual(r.json.exit, 2);
  assert.match(r.json.message, /no pude leer el nombre público/);
  // un subcomando que no existe (traer un cambio ajeno llega con otra tanda) también es 2, sin tocar nada
  for (const command of ['import', 'push', '']) {
    const u = await mirrorReadOnly(fx, [command], { credential: READER });
    assert.strictEqual(u.code, 2, `«${command}»: sale 2\n${u.all}`);
    assert.match(u.err, /subcomando/, `«${command}»: dice por qué`);
  }
  assert.deepStrictEqual(fx.api.requests, [], 'ningún pedido a la API');
  assert.deepStrictEqual(pushes(fx), [], 'ningún push');
});

// ── T2 · AC 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// la skill que sale con otro nombre: su nombre de adentro va por partes (el exportador lo reescribe en lo que publica)
const RENAMED_SKILL = ['skills/bmad', 'create', 'story'].join('-');

/**
 * La regla del número de versión vive en scripts/setup/harness/version-order.js (la comparte el merge por pedido):
 * un arnés de laboratorio que copia el guion a mano tiene que llevarla al lado, como la lleva el clon de verdad.
 */
function copyVersionRule(lab) {
  const rel = path.join('scripts', 'setup', 'harness', 'version-order.js');
  fs.mkdirSync(path.dirname(path.join(lab, rel)), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, rel), path.join(lab, rel));
}

/** Un arnés de laboratorio con el guion copiado y un exportador de mentira que contesta lo que se le diga. */
function labWithFakeExporter(fx, answer, code = 0) {
  const lab = path.join(fx.dir, 'lab-exporter');
  fs.mkdirSync(path.join(lab, 'scripts', 'publishing'), { recursive: true });
  fs.mkdirSync(path.join(lab, 'scripts', 'lib'), { recursive: true });
  copyVersionRule(lab);
  fs.copyFileSync(MIRROR, path.join(lab, 'scripts', 'publishing', 'mirror.js'));
  fs.copyFileSync(path.join(PUBLISHING, 'detector.js'), path.join(lab, 'scripts', 'publishing', 'detector.js'));
  fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js'), path.join(lab, 'scripts', 'lib', 'skills-dir.js'));
  fs.writeFileSync(path.join(lab, 'scripts', 'publishing', 'export.js'), [
    "'use strict';",
    '// exportador de mentira: presta las funciones del de verdad y, corrido, contesta siempre lo mismo',
    `module.exports = require(${JSON.stringify(EXPORTER)});`,
    'if (require.main === module) {',
    `  process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`,
    `  process.exitCode = ${code};`,
    '}', '',
  ].join('\n'));
  return path.join(lab, 'scripts', 'publishing', 'mirror.js');
}

test('Mirror_Preconditions_Exit2', async () => {
  // (a) una lista blanca que deja un pendiente
  let fx = await fixture();
  let allow = clone(ALLOWLIST);
  allow.packages.core.arnes.out.push({ glob: 'guides/guia.md', reason: 'espera a otra story', until: '9.9' });
  fx.config({ allowlist: allow });
  let r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /pendiente/);
  assert.match(r.err, /guides\/guia\.md/, 'nombra el pendiente');
  // lo que escribe frena igual, sin escribir: `first` sobre ese repo vacío y `sync` sobre uno ya publicado
  r = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 2, `first: ${r.all}`);
  assert.match(r.err, /pendiente/, 'first: nombra el caso');
  fx = await fixture();
  seedPublication(fx);
  fx.config({ allowlist: allow });
  r = await mirrorReadOnly(fx, ['sync'], { credential: WRITER });
  assert.strictEqual(r.code, 2, `sync: ${r.all}`);
  assert.match(r.err, /pendiente/, 'sync: nombra el caso');
  assert.ok(fx.api.requests.length > 0, 'control: sync llegó a exportar (leyó antes las reglas de main)');

  // (b) una exportación con dos repos: la exportación del guion es una constante y da uno; se ensaya con un exportador de mentira
  fx = await fixture();
  const two = { resultado: 0, pendientes: [], reemplazos: {}, fuentes: {}, repos: { arnes: { commit: 'a'.repeat(40), arbol: 'b'.repeat(40) }, 'agent-skills': { commit: 'c'.repeat(40), arbol: 'd'.repeat(40) } } };
  r = await mirrorReadOnly(fx, ['plan'], { script: labWithFakeExporter(fx, two) });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /2 repos/, 'dice cuántos repos trae la exportación');

  // (c) un árbol sin .github/SECURITY.md
  fx = await fixture();
  allow = clone(ALLOWLIST);
  allow.synthetic = allow.synthetic.filter((s) => s.target !== '.github/SECURITY.md');
  fx.config({ allowlist: allow });
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /\.github\/SECURITY\.md/, 'nombra el papel que falta');
  assert.doesNotMatch(r.err, /CONTRIBUTING/, 'y sólo ése');
  r = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 2, `first: ${r.all}`);
  assert.match(r.err, /\.github\/SECURITY\.md/, 'first: nombra el papel que falta');

  // (d) un LICENSE que no es Apache-2.0
  fx = await fixture();
  write(fx.harness, { [`${PAPERS_DIR}/LICENSE`]: 'MIT License\n\nPermission is hereby granted, free of charge…\n' });
  commit(fx.harness, 'otra licencia');
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /LICENSE/);
  assert.match(r.err, /Apache/, 'dice qué licencia tiene que ser');

  // (e) un árbol con la skill que no se publica · (f) otro con la que sale con otro nombre, con su nombre de adentro
  for (const folder of ['skills/bizuit-sdd', RENAMED_SKILL]) {
    fx = await fixture();
    write(fx.skills, { [`${folder}/SKILL.md`]: '---\nname: una-skill\n---\n\nUna skill.\n' });
    commit(fx.skills, 'una skill que no puede salir así');
    allow = clone(ALLOWLIST);
    allow.packages.core['agent-skills'].in.push(`${folder}/**`);
    fx.config({ allowlist: allow });
    r = await mirrorReadOnly(fx, ['plan']);
    assert.strictEqual(r.code, 2, `${folder}: ${r.all}`);
    assert.ok(r.err.includes(`${folder}/`), `${folder}: nombra la carpeta\n${r.err}`);
  }

  // con todo en su lugar, el mismo ensayo sale 0: lo que frenaba arriba era cada precondición
  fx = await fixture();
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 0, r.all);
});

// ── T3 · AC 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Cada valor, por partes: [las partes, la regla que lo reconoce]. Ninguna línea de este archivo trae uno entero.
const PROVIDER_SHAPES = [
  [['AKIA', 'ABCDEFGHIJKLMNOP'], '', 'llave-aws'],
  [['ghp', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'], '_', 'token-github'],
  [['xoxb', '1234567890', 'abcdefghijkl'], '-', 'token-slack'],
  [['-----BEGIN RSA', 'PRIVATE KEY-----'], ' ', 'llave-privada'],
];
const NOT_PROVIDER_SHAPES = [
  [['SERVICE_API', 'KEY=0123456789abcdef0123'], '_'],          // sólo la reconoce la regla que mira el nombre de la variable
  [['Server=db;Database=x;Pass', 'word=clave-de-mentira;'], ''],   // una clave en una cadena de conexión
];

test('Mirror_ProviderSecretShapes_Exit2', async () => {
  // los valores enteros en un archivo que sale, cubiertos por una excepción: el exportador los deja pasar
  let fx = await fixture();
  const whole = PROVIDER_SHAPES.map(([parts, glue], i) => `const v${i} = '${parts.join(glue)}';`);
  write(fx.harness, { 'scripts/formas.js': `'use strict';\n${whole.join('\n')}\n` });
  commit(fx.harness, 'valores con forma de secreto de proveedor');
  const denied = denylist();
  denied.permitidos = [{ archivo: 'scripts/formas.js', motivo: 'valores de laboratorio de una prueba' }];
  fx.config({ denied });
  let r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 2, r.all);
  PROVIDER_SHAPES.forEach(([parts, glue, rule], i) => {
    const value = parts.join(glue);
    assert.ok(r.err.includes(`scripts/formas.js:${i + 2}`), `${rule}: nombra archivo y línea\n${r.err}`);
    assert.ok(r.err.includes(rule), `${rule}: nombra la regla\n${r.err}`);
    assert.ok(r.err.includes(`${value.slice(0, 4)}***`), `${rule}: el valor sale enmascarado\n${r.err}`);
    assert.ok(!r.all.includes(value), `${rule}: el valor entero no aparece en ninguna salida`);
  });
  assert.match(r.err, /por partes/, 'dice cómo se arregla');
  const j = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(j.code, 2, j.all);
  assert.deepStrictEqual(j.json.secretShapes.map((h) => `${h.file}:${h.line} ${h.rule}`),
    PROVIDER_SHAPES.map(([, , rule], i) => `scripts/formas.js:${i + 2} ${rule}`));
  for (const [parts, glue] of PROVIDER_SHAPES) assert.ok(!j.all.includes(parts.join(glue)), 'tampoco en --json');
  // lo que escribe frena igual, sin escribir nada: lo empujado ya es público
  const w = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(w.code, 2, `first: ${w.all}`);
  assert.match(w.err, /forma de secreto de proveedor/, 'first: dice por qué');

  // los mismos, armados por partes en el código: ninguna línea trae el valor
  fx = await fixture();
  const inParts = PROVIDER_SHAPES.map(([parts, glue], i) => `const v${i} = ${JSON.stringify(parts)}.join(${JSON.stringify(glue)});`);
  write(fx.harness, { 'scripts/formas.js': `'use strict';\n${inParts.join('\n')}\n` });
  commit(fx.harness, 'los mismos valores, por partes');
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 0, r.all);

  // las dos formas que no son de proveedor, cubiertas por una excepción: frenan donde siempre (el exportador), no acá
  fx = await fixture();
  write(fx.harness, { 'scripts/otras.txt': `${NOT_PROVIDER_SHAPES.map(([parts, glue]) => parts.join(glue)).join('\n')}\n` });
  commit(fx.harness, 'un secreto por el nombre de la variable y una cadena de conexión');
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 1, `control: sin excepción, el exportador las frena\n${r.all}`);
  denied.permitidos = [{ archivo: 'scripts/otras.txt', motivo: 'valores de laboratorio de una prueba' }];
  fx.config({ denied });
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 0, r.all);
});

// ── T4 · AC 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Plan_ReportsStateWithoutWrites', async () => {
  const fx = await fixture();
  const head = () => gitFx(fx.harness, ['rev-parse', 'HEAD']);

  // sin refs
  let r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unpublished');
  assert.strictEqual(r.json.message, 'no publicado');
  assert.strictEqual(r.json.harness.sha, head(), 'el arnés, por defecto, en su HEAD');
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /no publicado/);

  // igual
  const seed = seedPublication(fx);
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unchanged');
  assert.strictEqual(r.json.message, 'sin cambios');
  assert.strictEqual(r.json.tree, seed.tree, 'el árbol que se publicaría');
  assert.strictEqual(r.json.publicTip, seed.commit, 'la punta de main del público');
  assert.deepStrictEqual(r.json.warnings, []);

  // las referencias por defecto: el arnés en su HEAD y agent-skills en origin/main, cada una resuelta una vez a un sha
  gitFx(fx.skills, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  r = await mirrorReadOnly(fx, ['plan', '--json'], { refs: false });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.harness, { ref: 'HEAD', sha: head() });
  assert.deepStrictEqual(r.json.agentSkills, { ref: 'origin/main', sha: gitFx(fx.skills, ['rev-parse', 'HEAD']) });
  assert.strictEqual(r.json.state, 'unchanged');

  // distinto: uno agregado, uno modificado, uno borrado
  write(fx.harness, { 'scripts/nuevo.js': "'use strict';\nmodule.exports = 3;\n", 'guides/guia.md': '# Guía\n\nTercera versión.\n', 'scripts/hola.js': null });
  commit(fx.harness, 'un cambio interno');
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'changes');
  assert.strictEqual(r.json.message, 'cambios');
  assert.deepStrictEqual(r.json.counts, { added: 1, modified: 1, deleted: 1 });
  assert.deepStrictEqual(r.json.paths, [
    { status: 'modified', path: 'guides/guia.md' }, { status: 'deleted', path: 'scripts/hola.js' }, { status: 'added', path: 'scripts/nuevo.js' },
  ]);
  assert.strictEqual(r.json.pathsOmitted, 0);
  r = await mirrorReadOnly(fx, ['plan']);
  assert.match(r.out, /cambios/);
  assert.match(r.out, /1 agregado.*1 modificado.*1 borrado/s);
  assert.match(r.out, /scripts\/nuevo\.js/);

  // muchas rutas: la cuenta entera y hasta 50 rutas
  const many = {};
  for (let i = 0; i < 60; i++) many[`guides/muchas/nota-${String(i).padStart(2, '0')}.md`] = `# Nota ${i}\n`;
  write(fx.harness, many);
  commit(fx.harness, 'sesenta archivos más');
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.json.state, 'changes', r.all);
  assert.deepStrictEqual(r.json.counts, { added: 61, modified: 1, deleted: 1 });
  assert.strictEqual(r.json.paths.length, 50);
  assert.strictEqual(r.json.pathsOmitted, 13);

  // un cambio ajeno sin absorber: un commit en el main público que no viene de una sincronización
  const foreign = publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.strictEqual(r.json.state, 'foreign-changes');
  assert.strictEqual(r.json.message, 'cambios ajenos sin traer');
  assert.deepStrictEqual(r.json.foreign, [{ commit: foreign, paths: ['docs/ajeno.md'], absorbed: false, discarded: false }]);
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 1, r.all);
  assert.match(r.all, /cambios ajenos sin traer/);
  assert.ok(r.all.includes(foreign) && r.all.includes('docs/ajeno.md'), 'dice el sha y la ruta');

  assert.deepStrictEqual(fx.api.writes(), [], '0 pedidos de escritura en toda la prueba');
  assert.deepStrictEqual(pushes(fx), [], 'ningún push en toda la prueba');
});

test('Mirror_Plan_ReportsStateWithoutWrites — un repo privado se lee con el token; sin él, sale 2 con su motivo', async () => {
  const fx = await fixture();
  seedPublication(fx);
  fx.api.state.credential = READER;
  fx.api.state.repo.private = true;
  const github = fakeGit(fx, { requires: READER });
  let r = await mirrorReadOnly(fx, ['plan', '--json'], { env: github.env });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude leer: el repo es privado/);
  assert.match(r.err, /falta el token de lectura/);
  r = await mirrorReadOnly(fx, ['plan', '--json'], { env: github.env, credential: READER });
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unchanged');
  assert.ok(!r.all.includes(READER), 'el token no aparece en ninguna salida');
  // con un token que GitHub no acepta: 2, y no dice «falta»
  r = await mirrorReadOnly(fx, ['plan'], { env: github.env, credential: 'otro-lector-0002' });
  assert.strictEqual(r.code, 2, r.all);
  assert.doesNotMatch(r.err, /falta el token/);
  assert.ok(!r.all.includes('otro-lector-0002'));
  assert.deepStrictEqual(fx.api.writes(), []);
});

test('Mirror_Plan_ReportsStateWithoutWrites — qué es un cambio ajeno, y cuándo está absorbido (AC 8)', async () => {
  const fx = await fixture();
  const seed = seedPublication(fx);
  const state = async () => {
    const r = await mirrorReadOnly(fx, ['plan', '--json']);
    assert.ok(r.json && r.json.state, r.all);
    return r.json;
  };
  const merge = (first, second, from = second) => publicCommit(fx, { parents: [first, second], from, message: 'Merge pull request #1' });

  // una sincronización mergeada no es un cambio ajeno
  const sync = syncCommit(fx, seed, { parent: seed.commit });
  const merged = merge(seed.commit, sync);
  let j = await state();
  assert.strictEqual(j.state, 'unchanged');
  assert.deepStrictEqual(j.foreign, []);

  // un commit posterior que no viene de una sincronización, sí: sólo él
  const foreign = publicCommit(fx, { parents: [merged], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  j = await state();
  assert.strictEqual(j.state, 'foreign-changes');
  assert.deepStrictEqual(j.foreign.map((f) => f.commit), [foreign]);

  // absorbido: su sha en una marca de la historia interna, en cualquiera de los dos repos. El interno es la fuente:
  // lo que el público tiene de más se va con la sincronización siguiente
  commit(fx.skills, `Traer un cambio del público\n\nPublic-Commit: ${foreign}`, { allowEmpty: true });
  j = await state();
  assert.strictEqual(j.state, 'changes');
  assert.deepStrictEqual(j.foreign, [{ commit: foreign, paths: ['docs/ajeno.md'], absorbed: true, discarded: false }]);
  assert.deepStrictEqual(j.paths, [{ status: 'deleted', path: 'docs/ajeno.md' }]);

  // la marca tiene que estar en la historia HASTA el commit que se exporta: con el anterior, sigue sin absorber
  j = (await mirrorReadOnly(fx, ['plan', '--json', '--agent-skills', 'HEAD~1'])).json;
  assert.strictEqual(j.state, 'foreign-changes');

  // otro, descartado: la marca y la del descarte, en el mismo commit
  const dropped = publicCommit(fx, { parents: [foreign], files: { 'docs/otro.md': '# Otro\n' }, message: 'Otro cambio mergeado en GitHub' });
  j = await state();
  assert.strictEqual(j.state, 'foreign-changes');
  assert.deepStrictEqual(j.foreign.filter((f) => !f.absorbed).map((f) => f.commit), [dropped]);
  commit(fx.harness, `Descartar un cambio del público\n\nPublic-Commit: ${dropped}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
  j = await state();
  assert.strictEqual(j.state, 'changes');
  assert.deepStrictEqual(j.foreign.map((f) => `${f.commit} ${f.absorbed} ${f.discarded}`), [`${dropped} true true`, `${foreign} true false`]);

  // un merge cuyo segundo padre copia los trailers de una sincronización, con otro árbol, sigue siendo ajeno
  const fake = publicCommit(fx, { parents: [dropped], files: { 'docs/falso.md': '# Falso\n' }, message: `Sincronización\n\n${trailers(seed)}`, ref: null });
  const forged = merge(dropped, fake);
  j = await state();
  assert.strictEqual(j.state, 'foreign-changes');
  assert.deepStrictEqual(j.foreign.filter((f) => !f.absorbed).map((f) => f.commit), [forged]);

  // un cambio ajeno mergeado justo ANTES que la sincronización —que no lo contiene— no queda tapado por ese merge
  gitFx(fx.bare, ['update-ref', 'refs/heads/main', merged]);
  const early = publicCommit(fx, { parents: [merged], files: { 'docs/antes.md': '# Antes\n' }, message: 'Mergeado antes que la sincronización' });
  const later = syncCommit(fx, seed, { parent: merged });
  merge(early, later, early);
  j = await state();
  assert.strictEqual(j.state, 'foreign-changes');
  assert.deepStrictEqual(j.foreign.map((f) => f.commit), [early]);

  // un público que no salió de una publicación: todo es ajeno
  for (const ref of refsOf(fx.bare).split('\n').filter(Boolean).map((l) => l.split(' ')[0])) gitFx(fx.bare, ['update-ref', '-d', ref]);
  const alien = publicCommit(fx, { files: { 'README.md': '# Otro repo\n' }, message: 'Initial commit' });
  j = await state();
  assert.strictEqual(j.state, 'foreign-changes');
  assert.deepStrictEqual(j.foreign.map((f) => `${f.commit} ${f.paths.join(',')}`), [`${alien} README.md`]);
});

// ── T5 · AC 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * El arnés de laboratorio: el interno de mentira con los guiones copiados adentro y la configuración SINTÉTICA con sus
 * nombres por defecto, commiteada. Así el guion lee «su» configuración del disco, como en el repo de verdad.
 */
function labHarness(fx) {
  for (const folder of ['publishing', 'lib']) {
    const from = path.join(RAIZ, 'scripts', folder);
    fs.mkdirSync(path.join(fx.harness, 'scripts', folder), { recursive: true });
    for (const f of fs.readdirSync(from)) if (f.endsWith('.js')) fs.copyFileSync(path.join(from, f), path.join(fx.harness, 'scripts', folder, f));
  }
  copyVersionRule(fx.harness);
  const allow = clone(ALLOWLIST);
  allow.packages.core.arnes.out = [
    { glob: 'guides/bizuit/*.md', reason: 'va al paquete bizuit' },
    { glob: 'scripts/publishing/**', reason: 'laboratorio: los guiones copiados no son parte de lo que se prueba' },
    { glob: 'scripts/lib/**', reason: 'laboratorio: los guiones copiados no son parte de lo que se prueba' },
    { glob: 'scripts/setup/**', reason: 'laboratorio: los guiones copiados no son parte de lo que se prueba' },
  ];
  const defaults = { 'allowlist.json': allow, 'replacements.json': REPLACEMENTS, 'denylist.json': denylist(), 'public-repos.json': PUBLIC };
  for (const [name, content] of Object.entries(defaults)) fs.writeFileSync(path.join(fx.harness, 'scripts', 'publishing', name), `${JSON.stringify(content, null, 2)}\n`);
  commit(fx.harness, 'los guiones y su configuración por defecto');
  return { script: path.join(fx.harness, 'scripts', 'publishing', 'mirror.js'), config: false, guides: false };
}

test('Mirror_Plan_ConfigFromAnotherCommit_WarnsOrExit2', async () => {
  // (a) --harness que no es el HEAD del clon
  let fx = await fixture();
  let r = await mirrorReadOnly(fx, ['plan', '--json', '--harness', fx.first.harness]);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.harness.sha, fx.first.harness);
  assert.strictEqual(r.json.warnings.length, 1, 'plan avisa');
  assert.match(r.json.warnings[0], /HEAD/);
  r = await mirrorReadOnly(fx, ['plan', '--harness', fx.first.harness]);
  assert.match(r.all, /HEAD/, 'el aviso también sale sin --json');
  for (const command of ['first', 'sync']) {
    r = await mirrorReadOnly(fx, [command, '--harness', fx.first.harness], { credential: READER });
    assert.strictEqual(r.code, 2, `${command}: ${r.all}`);
    assert.match(r.err, /HEAD/, `${command}: nombra la causa`);
  }

  // (b) el denylist.json POR DEFECTO modificado sin commitear, en un arnés de laboratorio
  fx = await fixture();
  const lab = labHarness(fx);
  r = await mirrorReadOnly(fx, ['plan', '--json'], lab);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.warnings, [], 'control: con la configuración commiteada no hay nada que avisar');
  const file = path.join(fx.harness, 'scripts', 'publishing', 'denylist.json');
  fs.writeFileSync(file, `${JSON.stringify(denylist())}\n`);   // el mismo contenido con otro formato: sólo cambia el archivo
  r = await mirrorReadOnly(fx, ['plan', '--json'], lab);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.warnings.length, 1, 'plan avisa');
  assert.match(r.json.warnings[0], /denylist\.json/);
  for (const command of ['first', 'sync']) {
    r = await mirrorReadOnly(fx, [command], { ...lab, credential: READER });
    assert.strictEqual(r.code, 2, `${command}: ${r.all}`);
    assert.match(r.err, /denylist\.json/, `${command}: nombra la causa`);
  }

  // (c) ese mismo archivo pasado por opción no se compara
  r = await mirrorReadOnly(fx, ['plan', '--json', '--denied', file], lab);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.warnings, []);

  // y los otros tres por defecto se miran igual: cada uno, modificado sin commitear, se nombra
  for (const name of ['allowlist.json', 'replacements.json', 'public-repos.json']) {
    const other = path.join(fx.harness, 'scripts', 'publishing', name);
    const original = fs.readFileSync(other);
    fs.writeFileSync(other, `${JSON.stringify(JSON.parse(original.toString('utf8')))}\n`);
    r = await mirrorReadOnly(fx, ['plan', '--json', '--denied', file], lab);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.strictEqual(r.json.warnings.length, 1, `${name}: plan avisa`);
    assert.ok(r.json.warnings[0].includes(name), `${name}: lo nombra`);
    fs.writeFileSync(other, original);
  }
});

// ── T6 · AC 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Plan_ExporterFindings_PropagatesExit', async () => {
  // un término de la lista sin par: el exportador encuentra el nombre en lo que sale y sale 1
  let fx = await fixture();
  write(fx.harness, { 'README.md': '# Arnés de mentira\n\nLo usa AcmeCorp todos los días.\n' });
  commit(fx.harness, 'un nombre en lo que sale');
  fx.config({ replacements: { pares: [], afuera: [] } });
  let r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 1, r.all);
  assert.match(r.err, /exportador/, 'dice de quién es el hallazgo');
  assert.match(r.err, /README\.md:3/, 'reproduce el resumen: dónde');
  assert.doesNotMatch(r.all, /AcmeCorp/, 'el resumen dice dónde, no qué: lo hallado no se imprime');
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.strictEqual(r.json.exporter.exit, 1);
  assert.ok(r.json.exporter.findings.some((h) => h.file === 'README.md' && h.line === 3 && h.category === 'cliente'), JSON.stringify(r.json.exporter));
  // lo que escribe sale con ese mismo código, sin escribir nada
  r = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 1, `first: ${r.all}`);
  assert.match(r.err, /exportador/, 'first: dice de quién es el hallazgo');

  // una lista blanca con un glob muerto: el exportador sale 2
  fx = await fixture();
  const allow = clone(ALLOWLIST);
  allow.packages.core.arnes.in.push('no-existe/**');
  fx.config({ allowlist: allow });
  r = await mirrorReadOnly(fx, ['plan']);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /exportador/);
  assert.match(r.err, /no coincide con nada/, 'reproduce el motivo del exportador');
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 2, r.all);
  assert.strictEqual(r.json.exporter.exit, 2);
});

// ── T35 · AC 29 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_RenamePublicRepo_OnlyTheFileChanges', async () => {
  // el público se llama `name-a` y ya está publicado
  const fx = await fixture({ publicRepo: { ...PUBLIC, repo: 'name-a' } });
  const seed = seedPublication(fx);
  let r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unchanged');
  assert.strictEqual(r.json.publicTip, seed.commit);
  // el guion del token, con una llave generada acá: pide un token limitado al repo que dice el archivo
  const keyFile = path.join(fx.dir, 'app-key.pem');
  fs.writeFileSync(keyFile, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
  const mint = async () => {
    const env = { ...mirrorEnv(fx), TYCON_MIRROR_APP_ID: '424242', TYCON_MIRROR_INSTALLATION_ID: '98765432', TYCON_MIRROR_APP_KEY_FILE: keyFile };
    const before = fx.api.requests.length;
    const t = await run(tokenScript, ['--public-repos', fx.cfg.publicRepos], env, fx.dir);
    assert.strictEqual(t.code, 0, t.all);
    const asked = fx.api.requests.slice(before);
    assert.deepStrictEqual(asked.map((q) => `${q.method} ${q.path}`), ['POST /app/installations/98765432/access_tokens'], 'un solo pedido, el del token');
    return { credential: t.out.trim(), repositories: asked[0].body.repositories };
  };
  let minted = await mint();
  assert.deepStrictEqual(minted.repositories, ['name-a'], 'el pedido del token nombra el repo del archivo');

  // se cambia SÓLO esa línea del archivo: el repo nuevo existe y todavía no tiene nada
  const text = fs.readFileSync(fx.cfg.publicRepos, 'utf8');
  const renamed = text.replace('"repo": "name-a"', '"repo": "name-b"');
  assert.strictEqual(renamed.split('\n').filter((l, i) => l !== text.split('\n')[i]).length, 1, 'control: cambió una sola línea');
  fs.writeFileSync(fx.cfg.publicRepos, renamed);
  const other = bareRepo(fx, { org: PUBLIC.org, repo: 'name-b' });
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unpublished', 'plan mira el repo nuevo');
  assert.strictEqual(refsOf(other), '');

  // el guion del token, sin tocar nada más: el pedido nombra el repo nuevo
  fx.api.reset();
  minted = await mint();
  assert.deepStrictEqual(minted.repositories, ['name-b'], 'el pedido del token nombra el repo nuevo');
  assert.strictEqual(minted.credential, fx.api.state.installation, 'y entrega el token por su salida');

  // `sync` también, con ese token: lo publicado y un cambio interno, en el repo nuevo. La rama y el pull request van
  // ahí, y sólo ahí
  const old = { bare: fx.bare, refs: refsOf(fx.bare) };
  fx.bare = other;
  seedPublication(fx);
  internalChange(fx);
  fx.api.reset();
  fx.api.state.credential = minted.credential;
  r = await syncRun(fx, ['--json'], { credential: minted.credential });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.strictEqual(tipOf(other, SYNC_REF), r.json.commit, 'la rama de la sincronización, en el repo nuevo');
  assert.strictEqual(refsOf(old.bare), old.refs, 'el repo de antes, sin tocar');
  assert.ok(fx.api.requests.length > 0 && fx.api.requests.every((q) => q.path.startsWith(`/repos/${PUBLIC.org}/name-b`)), 'todos los pedidos a la API nombran el repo nuevo');
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'created' });
});

// ── T24 · AC 15 ────────────────────────────────────────────────────────────────────────────────────────────────────
/** `verify`, comprobando además que no escribe nada y que ninguna salida trae el nombre ni la URL del repo. */
async function verifyPlain(fx, args = [], opts = {}) {
  const r = await mirrorReadOnly(fx, ['verify', ...args], opts);
  for (const text of [fx.publicRepo.repo, `${fx.publicRepo.org}/`, fx.github]) {
    assert.ok(!r.all.includes(text), `verify nombra al repo como «el de public-repos.json», sin su nombre ni su URL (${text})\n${r.all}`);
  }
  return r;
}
const verifyRun = (fx, args = [], opts = {}) => verifyPlain(fx, ['--json', ...args], opts);
const partsOf = (r) => [...new Set(r.json.findings.map((f) => f.part))].sort();

test('Mirror_Verify_FindsNamesEverywhereWithScopedIdentityException', async () => {
  const fx = await fixture();
  const seed = seedPublication(fx);
  /** Deja el público como recién publicado: `main` en la primera publicación, ninguna otra ref, la API en cero. */
  const reset = () => {
    for (const ref of refsOf(fx.bare).split('\n').filter(Boolean).map((l) => l.split(' ')[0])) gitFx(fx.bare, ['update-ref', '-d', ref]);
    gitFx(fx.bare, ['update-ref', 'refs/heads/main', seed.commit]);
    fx.api.reset();
  };
  /** Otra primera publicación: el mismo árbol más `files`, con sus trailers. No es un cambio ajeno. */
  const republish = (files, subject) => syncCommit(fx, seed, { files, subject, ref: 'refs/heads/main' });

  // control: lo recién publicado está limpio
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.couldNotLook, []);

  const cases = [
    ['un archivo de main', () => republish({ 'docs/nota.md': `# Nota\n\nLo pidió ${TERM}.\n` }), ['a'], 'docs/nota.md:3'],
    ['un blob que sólo está en un commit viejo', () => {
      const old = republish({ 'docs/nota.md': `Lo pidió ${TERM}.\n` });
      const fixed = syncCommit(fx, seed, { parent: old });   // la sincronización siguiente lo saca, y alguien la mergea
      publicCommit(fx, { parents: [old, fixed], from: fixed, message: 'Merge pull request #1' });
    }, ["a'"], 'docs/nota.md:1'],
    ['una ruta', () => republish({ [`docs/${TERM}/nota.md`]: '# Nota\n' }), ['b'], null],
    // la ruta ES lo hallado: el hallazgo de adentro del archivo tampoco la imprime
    ['una ruta, con el nombre también adentro', () => republish({ [`docs/${TERM}/nota.md`]: `Lo pidió ${TERM}.\n` }), ['a', 'b'], null],
    ['el mensaje de un commit', () => republish({}, `Primera publicación, para ${TERM}`), ['c'], null],
    ['el mensaje de un tag', () => gitFx(fx.bare, ['tag', '-a', 'v1', '-m', `Entrega para ${TERM}`, seed.commit]), ['c'], null],
    ['el nombre de un tag', () => gitFx(fx.bare, ['tag', `${TERM}-v1`, seed.commit]), ['c'], null],
    ['la cabeza de un refs/pull/<n>/head', () => publicCommit(fx, { parents: [seed.commit], files: { 'docs/aporte.md': `De parte de ${TERM}.\n` }, message: 'Un aporte', ref: 'refs/pull/7/head' }), ["a'"], 'docs/aporte.md:1'],
    ['la descripción del repo', () => { fx.api.state.repo.description = `El arnés de ${TERM}`; }, ['d'], null],
    ['un tema del repo', () => { fx.api.state.topics = ['harness', TERM.toLowerCase()]; }, ['d'], null],
    ['el cuerpo del pull request abierto', () => {
      fx.api.state.pulls = [{ number: 1, state: 'open', title: 'Sincronización', body: `Cambios pedidos por ${TERM}`, head: { ref: 'mirror/sync' }, base: { ref: 'main' } }];
    }, ['e'], null],
  ];
  for (const [name, mutate, parts, place] of cases) {
    reset();
    mutate();
    r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), parts, `${name}: nombra la parte\n${r.all}`);
    assert.ok(r.json.findings.every((f) => f.category === 'cliente'), `${name}: nombra la categoría\n${r.all}`);
    if (place) assert.ok(r.json.findings.some((f) => f.place.includes(place)), `${name}: nombra el lugar (${place})\n${r.all}`);
    assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()), `${name}: ninguna salida trae el texto hallado\n${r.all}`);
    // sin --json dice lo mismo: la parte por su letra, y tampoco el texto
    const h = await verifyPlain(fx);
    assert.strictEqual(h.code, 1, `${name}, sin --json: ${h.all}`);
    assert.ok(h.all.includes(`· (${parts[0]}) [cliente] `), `${name}, sin --json: nombra la parte y la categoría\n${h.all}`);
    assert.ok(!h.all.toLowerCase().includes(TERM.toLowerCase()), `${name}, sin --json: sin el texto hallado\n${h.all}`);
  }

  // la excepción de identidad: quien mergea, con su correo anónimo, y el firmante automático de los commits web
  const merged = (identity, message = 'Merge pull request #1 from example-org/mirror/sync') => {
    reset();
    const sync = syncCommit(fx, seed, { parent: seed.commit });
    return publicCommit(fx, { parents: [seed.commit, sync], from: sync, message, identity: { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: WEB_COMMITTER, ...identity } });
  };
  const noSecrets = (x, name) => {
    for (const text of [MERGER, MERGER_NOREPLY, MERGER_REAL]) assert.ok(!x.all.toLowerCase().includes(text.toLowerCase()), `${name}: ninguna salida trae el texto hallado\n${x.all}`);
  };
  merged({ GIT_AUTHOR_NAME: MERGER, GIT_AUTHOR_EMAIL: MERGER_NOREPLY });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, `el merge de la persona de la excepción, con su correo anónimo: ${r.all}`);
  assert.deepStrictEqual(r.json.findings, []);

  const withReal = merged({ GIT_AUTHOR_NAME: MERGER, GIT_AUTHOR_EMAIL: MERGER_REAL });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, `con su correo real: ${r.all}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['c email']);
  assert.ok(r.json.findings[0].place.includes(withReal), 'el lugar es el commit');
  noSecrets(r, 'con su correo real');

  merged({ GIT_AUTHOR_NAME: MERGER, GIT_AUTHOR_EMAIL: MERGER_NOREPLY }, `Merge pull request #1\n\nAprobado por ${MERGER}.`);
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, `con su nombre en el mensaje del merge: ${r.all}`);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['c persona'], 'la excepción no alcanza al mensaje');
  noSecrets(r, 'con su nombre en el mensaje');

  // la excepción es de esa persona: otro nombre de la lista en la identidad de un commit sigue siendo un hallazgo
  merged({ GIT_AUTHOR_NAME: TERM, GIT_AUTHOR_EMAIL: 'alguien@example.com' });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['c cliente']);
});

// ── Story 8.26, tanda F2 · AC 24: lo publicado que no es git, qué hacer con cada hallazgo, y el modo directo ────────
// Con el arnés mantenido directo en el público, lo que un `gh` tecleado en una terminal o la web de GitHub publican no
// pasa por ningún freno de la máquina: se ve recién acá. Todo sale de la API de mentira; los términos son inventados.

/**
 * Cada caso deja UN término en UN lugar de lo publicado que no es git: `verify` da un solo hallazgo, en su parte, con su
 * lugar y lo que hay que hacer —y sin el texto—, con `--json` y sin él.
 */
async function onePlaceEach(fx, cases) {
  for (const [name, mutate, part, place, action] of cases) {
    fx.api.reset();
    mutate(fx.api.state);
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), [`${part} cliente`], `${name}: un hallazgo, en su parte\n${r.all}`);
    assert.match(r.json.findings[0].place, place, `${name}: el lugar`);
    assert.strictEqual(r.json.findings[0].action, action, `${name}: qué hacer`);
    // hasta dónde llegó (tanda F3 de la 8.26): una versión, un texto de un pedido/issue/comentario, o algo del repo
    // (el nombre de la rama de un pedido es del pedido: su lugar lo dice)
    const reach = part === 'k' ? 'release' : action === 'edit' ? 'about' : /^el pedido nº \d+ \(rama/.test(r.json.findings[0].place) ? 'pull' : 'conversation';
    assert.strictEqual(r.json.findings[0].reach, reach, `${name}: hasta dónde llegó`);
    assert.strictEqual(r.json.findings[0].rotateFirst, false);
    assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()), `${name}: ninguna salida trae el texto hallado\n${r.all}`);
    // sin --json dice lo mismo, con lo que hay que hacer en el renglón de abajo
    const h = await verifyPlain(fx);
    assert.strictEqual(h.code, 1, `${name}, sin --json: ${h.all}`);
    assert.match(h.out, new RegExp(`· \\(${part}\\) \\[cliente\\] [^\\n]+\\n {6}→ [^\\n]*${action === 'delete' ? 'se borra' : action === 'edit' ? 'se corrige' : 'purga'}`), `${name}: la acción, debajo del lugar\n${h.out}`);
    assert.ok(!h.all.toLowerCase().includes(TERM.toLowerCase()), `${name}, sin --json: sin el texto hallado`);
  }
}

test('T24_Verify_ReleasesPullsIssuesAndComments_OneFindingPerPlace_EachWithWhatToDo', async () => {
  const fx = await fixture();
  const seed = seedPublication(fx);
  const dirty = `Lo pidió ${TERM}.`;
  const pull = (over = {}) => ({ number: 7, state: 'closed', title: 'Un aporte', body: 'Sin nada raro.', pull_request: { url: 'x' }, ...over });
  /** El mismo pedido, como lo da la lista de pedidos (ahí viene el nombre de su rama, que la de issues no trae). */
  const closedPull = (over = {}) => ({ number: 7, state: 'closed', title: 'Un aporte', body: 'Sin nada raro.', head: { ref: 'un-aporte' }, base: { ref: 'main' }, ...over });
  const cases = [
    ['el título de una versión', (s) => { s.releases = [{ id: 501, name: `Entrega para ${TERM}`, tag_name: 'v1', body: 'Notas.', assets: [] }]; }, 'k', /^la versión con id 501 \(título\)$/, 'delete'],
    ['la marca de una versión', (s) => { s.releases = [{ id: 502, name: 'v1', tag_name: `${TERM}-v1`, body: '', assets: [] }]; }, 'k', /^la versión con id 502 \(marca\)$/, 'delete'],
    ['las notas de una versión', (s) => { s.releases = [{ id: 503, name: 'v1', tag_name: 'v1', body: `Cambios.\n${dirty}`, assets: [] }]; }, 'k', /^la versión con id 503 \(notas, línea 2\)$/, 'delete'],
    ['el título de un pedido cerrado', (s) => { s.issues = [pull({ title: `Para ${TERM}` })]; }, 'l', /^el pedido nº 7 \(título\)$/, 'delete-and-purge'],
    ['el cuerpo de un issue', (s) => { s.issues = [{ number: 9, state: 'open', title: 'Un bug', body: `Uno.\nDos.\n${dirty}` }]; }, 'l', /^el issue nº 9 \(cuerpo, línea 3\)$/, 'delete-and-purge'],
    ['un comentario de un pedido cerrado', (s) => { s.issues = [pull()]; s.issueComments = [{ id: 9001, issue_url: 'https://api.example.test/repos/o/r/issues/7', body: dirty }]; },
      'm', /^el comentario con id 9001 \(en el pedido o issue nº 7\) \(línea 1\)$/, 'delete-and-purge'],
    ['un comentario de revisión, en una línea del cambio', (s) => { s.issues = [pull()]; s.reviewComments = [{ id: 9002, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: `ok\n${dirty}`, path: 'docs/aporte.md', diff_hunk: '@@ -0,0 +1 @@\n+Limpio.' }]; },
      'm', /^el comentario de revisión con id 9002 \(en el pedido nº 7\) \(línea 2\)$/, 'delete-and-purge'],
    ['el cuerpo de una revisión', (s) => { s.issues = [pull()]; s.reviews = { 7: [{ id: 9003, state: 'APPROVED', body: dirty }] }; }, 'm', /^la revisión con id 9003 del pedido nº 7 \(línea 1\)$/, 'delete-and-purge'],
    ['un comentario sobre un commit', (s) => { s.commitComments = [{ id: 9004, commit_id: seed.commit, body: dirty }]; }, 'm', new RegExp(`^el comentario con id 9004 sobre el commit ${seed.commit.slice(0, 12)} \\(línea 1\\)$`), 'delete-and-purge'],
    ['el nombre de una etiqueta', (s) => { s.labels = [{ name: 'bug', description: '' }, { name: `cliente ${TERM}`, description: '' }]; }, 'l', /^la etiqueta nº 2 del repo$/, 'edit'],
    ['el título de un hito', (s) => { s.milestones = [{ number: 2, title: `Entrega ${TERM}`, description: '' }]; }, 'l', /^el hito nº 2 del repo$/, 'edit'],
    // la descripción de una etiqueta y la de un hito también se publican (con el nombre y el título limpios)
    ['la descripción de una etiqueta', (s) => { s.labels = [{ name: 'cliente', description: `Lo que pide ${TERM}` }]; }, 'l', /^la etiqueta nº 1 del repo$/, 'edit'],
    ['la descripción de un hito', (s) => { s.milestones = [{ number: 3, title: 'La próxima', description: `Para ${TERM}` }]; }, 'l', /^el hito nº 3 del repo$/, 'edit'],
  ];
  await onePlaceEach(fx, cases);

  // un adjunto subido a una versión: «sin leer» (su contenido no se baja), y su nombre se mira
  fx.api.reset();
  fx.api.state.releases = [{ id: 504, name: 'v2', tag_name: 'v2', body: '', assets: [{ id: 1, name: 'paquete.zip' }, { id: 2, name: `informe-${TERM}.zip`, label: '' }] }];
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category} ${f.place}`), [
    'k sin-leer la versión con id 504: un adjunto subido (el nº 1; su contenido no se lee)',
    'k sin-leer la versión con id 504: un adjunto subido (el nº 2; su contenido no se lee)',
    'k cliente la versión con id 504 (el nombre del adjunto nº 2)',
  ]);
  assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()));
  // …y también el rótulo que GitHub muestra en lugar del nombre del adjunto, con el nombre limpio
  fx.api.reset();
  fx.api.state.releases = [{ id: 506, name: 'v2', tag_name: 'v2', body: '', assets: [{ id: 1, name: 'paquete.zip', label: `Paquete para ${TERM}` }] }];
  r = await verifyRun(fx);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category} ${f.place}`), [
    'k sin-leer la versión con id 506: un adjunto subido (el nº 1; su contenido no se lee)',
    'k cliente la versión con id 506 (el nombre del adjunto nº 1)',
  ]);
  assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()));

  // el gemelo verde: versiones, pedidos, issues y comentarios LIMPIOS no son un hallazgo, y se dice cuánto se miró
  fx.api.reset();
  Object.assign(fx.api.state, {
    releases: [{ id: 505, name: 'v3', tag_name: 'v3', body: 'Notas limpias.', target_commitish: 'main', assets: [] }],
    issues: [pull(), { number: 9, state: 'open', title: 'Un bug', body: null }],
    pulls: [closedPull()],
    labels: [{ name: 'bug', description: 'Algo no anda' }], milestones: [{ number: 1, title: 'La próxima', description: null }],
    issueComments: [{ id: 1, issue_url: 'https://api.example.test/repos/o/r/issues/9', body: 'Gracias.' }],
    reviewComments: [{ id: 2, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', path: 'docs/aporte.md', diff_hunk: '@@ -0,0 +1 @@\n+Limpio.' }],
    commitComments: [{ id: 3, commit_id: seed.commit, body: 'Visto.', path: null }], reviews: { 7: [{ id: 4, body: '' }, { id: 5, body: null }] },
    // la línea de tiempo: un renombre limpio, y eventos que no traen ningún texto (cerrar, asignar)
    issueEvents: [{ id: 6, event: 'renamed', issue: { number: 7 }, rename: { from: 'Un aporte viejo', to: 'Un aporte' } }, { id: 7, event: 'closed', issue: { number: 7 } }, { id: 8, event: 'labeled', issue: { number: 9 }, label: { name: 'bug' } },
      // …y uno con sus claves en nulo, como las manda GitHub cuando el evento no trae ese texto: no es «no pude leer»
      { id: 9, event: 'review_dismissed', issue: { number: 7 }, rename: null, label: null, milestone: null, dismissed_review: { dismissal_message: null } }],
  });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.couldNotLook, []);
  assert.deepStrictEqual([r.json.looked.k, r.json.looked.l, r.json.looked.m], [1, 8, 5], 'cuenta lo que miró: 1 versión · 2 pedidos/issues + 1 etiqueta + 1 hito + 4 eventos · 3 comentarios + 2 revisiones');
  assert.ok(fx.api.requests.some((q) => q.path.endsWith('/issues') && q.query.state === 'all'), 'pide los pedidos y los issues abiertos Y cerrados');
  assert.ok(fx.api.requests.some((q) => q.path.endsWith('/pulls') && q.query.state === 'all'), 'y la lista de pedidos, abiertos Y cerrados: de ahí sale el nombre de la rama de cada uno');
  assert.ok(fx.api.requests.some((q) => q.path.endsWith('/issues/events')), 'y la línea de tiempo');
  assert.ok(fx.api.requests.some((q) => q.path.endsWith('/pulls/7/reviews')), 'y las revisiones de cada pedido');
  assert.ok(!fx.api.requests.some((q) => q.path.endsWith('/pulls/9/reviews')), 'un issue no tiene revisiones');
  // lo que la API dice de dónde es un comentario no se imprime si no es un número: nada que el servidor quiera poner ahí
  fx.api.reset();
  fx.api.state.issueComments = [{ id: 'un-id-raro', issue_url: `https://api.example.test/repos/o/r/issues/${TERM}`, body: dirty }];
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.strictEqual(r.json.findings[0].place, 'el comentario con id ? (en el pedido o issue nº ?) (línea 1)');
  assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()));
});

// Lo que sumó el pase adversarial de la tanda F2: texto publicado que ninguna de las listas de la prueba de arriba trae.
test('T24_Verify_BranchNamesTimelineAndReviewHunks_OneFindingPerPlace_EachWithWhatToDo', async () => {
  const fx = await fixture();
  seedPublication(fx);
  const dirty = `Lo pidió ${TERM}.`;
  const pull = (over = {}) => ({ number: 7, state: 'closed', title: 'Un aporte', body: 'Sin nada raro.', pull_request: { url: 'x' }, ...over });
  /** El mismo pedido, como lo da la lista de pedidos (ahí viene el nombre de su rama, que la de issues no trae). */
  const closedPull = (over = {}) => ({ number: 7, state: 'closed', title: 'Un aporte', body: 'Sin nada raro.', head: { ref: 'un-aporte' }, base: { ref: 'main' }, ...over });
  await onePlaceEach(fx, [
    // el nombre de la rama de un pedido CERRADO, ya borrada: no es una ref del clon, y sigue en la página del pedido
    ['la rama de un pedido cerrado, ya borrada', (s) => { s.issues = [pull()]; s.pulls = [closedPull({ head: { ref: `feature/${TERM.toLowerCase()}-x` } })]; }, 'l', /^el pedido nº 7 \(rama\)$/, 'delete-and-purge'],
    ['la rama destino de un pedido cerrado', (s) => { s.issues = [pull()]; s.pulls = [closedPull({ base: { ref: `entrega-${TERM.toLowerCase()}` } })]; }, 'l', /^el pedido nº 7 \(rama destino\)$/, 'delete-and-purge'],
    ['de dónde se cortó una versión', (s) => { s.releases = [{ id: 507, name: 'v1', tag_name: 'v1', body: '', target_commitish: `entrega-${TERM.toLowerCase()}`, assets: [] }]; }, 'k', /^la versión con id 507 \(la rama o el commit de donde se cortó\)$/, 'delete'],
    // la línea de tiempo conserva el título ANTERIOR de un pedido renombrado: corregir el título no lo saca de ahí
    ['el título anterior de un pedido renombrado', (s) => { s.issues = [pull()]; s.issueEvents = [{ id: 8001, event: 'renamed', issue: { number: 7 }, rename: { from: `Para ${TERM}`, to: 'Un aporte' } }]; },
      'l', /^el evento con id 8001 \(en el pedido o issue nº 7\): un título anterior$/, 'delete-and-purge'],
    ['una etiqueta ya borrada, en la línea de tiempo', (s) => { s.issueEvents = [{ id: 8002, event: 'labeled', issue: { number: 9 }, label: { name: `cliente ${TERM}` } }]; },
      'l', /^el evento con id 8002 \(en el pedido o issue nº 9\): el nombre de una etiqueta$/, 'delete-and-purge'],
    ['un hito ya borrado, en la línea de tiempo', (s) => { s.issueEvents = [{ id: 8003, event: 'milestoned', issue: { number: 9 }, milestone: { title: `Entrega ${TERM}` } }]; },
      'l', /^el evento con id 8003 \(en el pedido o issue nº 9\): el título de un hito$/, 'delete-and-purge'],
    ['el motivo con que se descartó una revisión', (s) => { s.issues = [pull()]; s.issueEvents = [{ id: 8004, event: 'review_dismissed', issue: { number: 7 }, dismissed_review: { dismissal_message: dirty } }]; },
      'l', /^el evento con id 8004 \(en el pedido o issue nº 7\): el motivo con que se descartó una revisión$/, 'delete-and-purge'],
    // un comentario de revisión muestra el fragmento del cambio y su ruta: de un commit que, si la rama se reescribió, el clon ya no trae
    ['el fragmento del cambio, en un comentario de revisión', (s) => { s.issues = [pull()]; s.reviewComments = [{ id: 9005, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'ok', path: 'docs/aporte.md', diff_hunk: `@@ -0,0 +1 @@\n+${dirty}` }]; },
      'm', /^el comentario de revisión con id 9005 \(en el pedido nº 7\) \(el fragmento del cambio, línea 2\)$/, 'delete-and-purge'],
    ['la ruta del archivo comentado, en un comentario de revisión', (s) => { s.issues = [pull()]; s.reviewComments = [{ id: 9006, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'ok', path: `docs/${TERM}/nota.md`, diff_hunk: '@@ -0,0 +1 @@\n+limpio' }]; },
      'm', /^el comentario de revisión con id 9006 \(en el pedido nº 7\) \(la ruta del archivo comentado\)$/, 'delete-and-purge'],
    // …y un comentario sobre un commit puede traer la ruta del archivo comentado
    ['la ruta del archivo comentado, en un comentario sobre un commit', (s) => { s.commitComments = [{ id: 9007, commit_id: 'a'.repeat(40), body: 'ok', path: `docs/${TERM}/nota.md` }]; },
      'm', /^el comentario con id 9007 sobre el commit a{12} \(la ruta del archivo comentado\)$/, 'delete-and-purge'],
  ]);
});

test('T24_Verify_WhatToDo_DependsOnHowFarItGot_MainPullRequestOrJustABranchOrTag', async () => {
  const fx = await fixture();
  const seed = seedPublication(fx);
  const reset = () => {
    for (const ref of refsOf(fx.bare).split('\n').filter(Boolean).map((l) => l.split(' ')[0])) gitFx(fx.bare, ['update-ref', '-d', ref]);
    gitFx(fx.bare, ['update-ref', 'refs/heads/main', seed.commit]);
    fx.api.reset();
  };
  // T70 (story 8.26, tanda F3 · AC 58): cada hallazgo dice además hasta dónde llegó (`reach`), que hasta esa tanda
  // sólo estaba en el texto del consejo. El aviso lo lee para saber qué es «de la historia de main».
  const REACHES = {
    'un archivo de main': 'main', 'sólo en refs/pull/1/head': 'pull', 'el mensaje de un commit de un pedido': 'pull', 'sólo en una rama': 'ref',
    'el mensaje de una marca anotada': 'ref', 'la descripción del repo': 'about', 'una ruta de main': 'main', 'el mensaje de un commit de main': 'main',
    'el nombre de una rama': 'ref', 'el nombre de una marca': 'ref', 'el cuerpo del pedido de la sincronización': 'conversation',
    'sólo en la historia de main': 'main',
    'el nombre de una ruta que estuvo en main y además está en una rama': 'main', 'el nombre de una ruta que sólo está en una rama': 'ref',
  };
  const PURGE = /pid\w* la purga/;
  const mineOf = (r) => r.json.findings.filter((f) => f.category === 'cliente');
  /** Los hallazgos sin su consejo: lo que NO puede cambiar según el repo sea privado, público o no se sepa. */
  const withoutAdvice = (r) => r.json.findings.map((f) => { const rest = { ...f }; delete rest.todo; return rest; });
  const only = async (name, action, todo) => {
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}\n${r.all}`);
    const mine = mineOf(r);
    assert.ok(mine.length >= 1, `${name}: lo encuentra\n${r.all}`);
    assert.ok(REACHES[name], `${name}: la prueba no dice hasta dónde llega este caso`);
    for (const f of mine) {
      assert.strictEqual(f.action, action, `${name}: ${f.place}`);
      assert.match(f.todo, todo, name);
      assert.strictEqual(f.reach, REACHES[name], `${name}: hasta dónde llegó (${f.place})`);
    }
    assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()), name);
    return r;
  };
  /**
   * El MISMO caso, con el repo privado: el consejo es el de la guía —nada se purga— y todo lo demás es idéntico
   * (los hallazgos, sus lugares, hasta dónde llegaron, su acción y el código de salida).
   */
  const onPrivate = async (name, before, todo) => {
    fx.api.state.credential = READER;
    fx.api.state.repo.private = true;
    const r = await verifyRun(fx, [], { credential: READER });
    assert.strictEqual(r.json.private, true, `${name}, privado\n${r.all}`);
    assert.strictEqual(r.code, before.code, `${name}, privado: el mismo código de salida\n${r.all}`);
    assert.deepStrictEqual(withoutAdvice(r), withoutAdvice(before), `${name}, privado: los mismos hallazgos, salvo el consejo`);
    for (const f of mineOf(r)) {
      assert.match(f.todo, todo, `${name}, privado: ${f.place}`);
      assert.doesNotMatch(f.todo, PURGE, `${name}, privado: no se pide purga`);
    }
    assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()), `${name}, privado`);
    return r;
  };
  // llegó a main: además de sacarlo, se pide la purga
  reset();
  syncCommit(fx, seed, { files: { 'docs/nota.md': `Lo pidió ${TERM}.\n` }, ref: 'refs/heads/main' });
  let shown = await only('un archivo de main', 'delete-and-purge', /llegó a main.*purga/);
  // 🔴 sin poder leer si el repo es privado (la parte (d) no contestó), el consejo es el del repo público: no se sabe
  fx.api.override = (q) => (/^\/repos\/[^/]+\/[^/]+$/.test(q.path) ? { status: 500, json: {} } : null);
  const unknown = await verifyRun(fx);
  assert.strictEqual(unknown.json.private, null, unknown.all);
  assert.deepStrictEqual(unknown.json.couldNotLook.map((x) => x.part), ['d']);
  assert.deepStrictEqual(unknown.json.findings, shown.json.findings, 'sin saber si es privado: los mismos hallazgos, con el consejo del repo público');
  assert.strictEqual(unknown.code, shown.code, 'sin saber si es privado: el mismo código de salida');
  fx.api.override = null;
  await onPrivate('un archivo de main', shown, /^el repo es privado: si sigue en main, se arregla en el interno y sale de lo publicado con la sincronización siguiente; en la historia queda, y se acepta hasta el corte/);
  // lo que main ya no sirve y sigue en su historia: la parte (a'), que con el repo privado es lo aceptado hasta el corte
  reset();
  const dirtyOnce = syncCommit(fx, seed, { parent: seed.commit, files: { 'docs/nota.md': `Lo pidió ${TERM}.\n` } });
  syncCommit(fx, seed, { parent: dirtyOnce, files: { 'docs/nota.md': 'Limpio.\n' }, ref: 'refs/heads/main' });
  shown = await only('sólo en la historia de main', 'delete-and-purge', /llegó a main.*purga/);
  assert.deepStrictEqual([...new Set(mineOf(shown).map((f) => f.part))], ["a'"], shown.all);
  await onPrivate('sólo en la historia de main', shown, /^el repo es privado: .*en la historia queda, y se acepta hasta el corte/);
  // una rama borrada que sigue en la cabeza de su pedido: borrar la rama no alcanza
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/aporte.md': `De parte de ${TERM}.\n` }, message: 'Un aporte', ref: 'refs/pull/1/head' });
  shown = await only('sólo en refs/pull/1/head', 'delete-and-purge', /está en un pedido.*purga/);
  await onPrivate('sólo en refs/pull/1/head', shown, /^está en un pedido del repo privado: se cierra el pedido y se borra su rama/);
  // el mensaje de un commit que sólo cuelga de la cabeza de un pedido
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/aporte.md': 'Limpio.\n' }, message: `Un aporte para ${TERM}`, ref: 'refs/pull/2/head' });
  await only('el mensaje de un commit de un pedido', 'delete-and-purge', /está en un pedido/);
  // cuelga sólo de una rama: se borra la rama
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/prueba.md': `Para ${TERM}.\n` }, message: 'Una prueba', ref: 'refs/heads/una-prueba' });
  shown = await only('sólo en una rama', 'delete', /cuelga sólo de una rama o de una marca/);
  // lo que se borra, se borra igual con el repo privado: el consejo no cambia
  await onPrivate('sólo en una rama', shown, /^cuelga sólo de una rama o de una marca: se borra esa rama o esa marca$/);
  // una marca anotada: su mensaje
  reset();
  gitFx(fx.bare, ['tag', '-a', 'v1', '-m', `Entrega para ${TERM}`, seed.commit]);
  await only('el mensaje de una marca anotada', 'delete', /cuelga sólo de una rama o de una marca/);
  // la descripción del repo se corrige
  reset();
  fx.api.state.repo.description = `El arnés de ${TERM}`;
  shown = await only('la descripción del repo', 'edit', /se corrige en la configuración del repo/);
  // lo del repo se corrige en su configuración, sea privado o no: el consejo no cambia
  await onPrivate('la descripción del repo', shown, /^se corrige en la configuración del repo$/);
  // los demás sitios de main: el nombre de una ruta y el mensaje de un commit
  reset();
  syncCommit(fx, seed, { files: { [`docs/${TERM}/nota.md`]: '# Nota\n' }, ref: 'refs/heads/main' });
  await only('una ruta de main', 'delete-and-purge', /llegó a main.*purga/);
  reset();
  syncCommit(fx, seed, { subject: `Primera publicación, para ${TERM}`, ref: 'refs/heads/main' });
  await only('el mensaje de un commit de main', 'delete-and-purge', /llegó a main.*purga/);
  // el NOMBRE de una rama y el de una marca: se borra (o se renombra) esa ref
  reset();
  gitFx(fx.bare, ['update-ref', `refs/heads/${TERM}-prueba`, seed.commit]);
  await only('el nombre de una rama', 'delete', /cuelga sólo de una rama o de una marca/);
  reset();
  gitFx(fx.bare, ['tag', `${TERM}-v1`, seed.commit]);
  await only('el nombre de una marca', 'delete', /cuelga sólo de una rama o de una marca/);
  // el pedido abierto de la sincronización (parte e): un texto de un pedido, que además de corregirse se purga
  reset();
  fx.api.state.pulls = [{ number: 1, state: 'open', title: 'Sincronización', body: `Cambios pedidos por ${TERM}`, head: { ref: 'mirror/sync' }, base: { ref: 'main' } }];
  shown = await only('el cuerpo del pedido de la sincronización', 'delete-and-purge', /está en un pedido, un issue o un comentario.*purga/);
  await onPrivate('el cuerpo del pedido de la sincronización', shown, /^está en un pedido, un issue o un comentario del repo privado: se borra o se corrige/);

  // lo que no es un texto publicado remite a la guía —no hay nada que borrar—: un cambio ajeno, una ref de reemplazo
  // (se borra, pero lo dice su sección), una alerta del escaneo de secretos (que además se rota primero)
  const one = async (name, category, check, opts = {}) => {
    const r = await verifyRun(fx, [], opts);
    assert.strictEqual(r.code, 1, `${name}\n${r.all}`);
    const f = r.json.findings.find((x) => x.category === category);
    assert.ok(f, `${name}: falta el hallazgo «${category}»\n${r.all}`);
    check(f);
  };
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  const toTheGuide = (f) => {
    assert.deepStrictEqual([f.reach, f.action, f.rotateFirst], ['guide', 'see-guide', false]);
    assert.match(f.todo, /^qué hacer: guides\/publicacion-espejo\.md, §«Si `verify` da 1»$/);
  };
  await one('un cambio ajeno', 'foreign-change', toTheGuide);
  // …y con el repo privado sigue remitiendo a la guía: el consejo del repo privado toca sólo lo que nombraba la purga
  fx.api.state.credential = READER;
  fx.api.state.repo.private = true;
  await one('un cambio ajeno, con el repo privado', 'foreign-change', toTheGuide, { credential: READER });
  reset();
  gitFx(fx.bare, ['update-ref', `refs/replace/${seed.commit}`, seed.commit]);
  await one('una ref de reemplazo', 'replace-ref', (f) => assert.deepStrictEqual([f.part, f.action], ['c', 'delete']));
  reset();
  fx.api.state.alerts = [{ number: 3, state: 'open' }];
  await one('una alerta del escaneo de secretos', 'secret-alert', (f) => {
    assert.deepStrictEqual([f.part, f.action, f.rotateFirst], ['g', 'see-guide', true]);
    assert.match(f.todo, /^es un secreto: se rota PRIMERO .*después, qué hacer: guides\//);
  }, { credential: READER });

  // ── Pase adversarial de la tanda F2: hasta dónde llegó se dice por los COMMITS que lo traen, no por el objeto ──
  // 🔴 un submódulo que llegó a main y después se sacó. Su objeto es un commit de OTRO repo: nunca está entre los
  // alcanzables de éste, y mirado por su objeto salía siempre como «cuelga de una rama: se borra».
  const gitlink = { gitlink: 'c'.repeat(40) };
  const submodule = (name, action, todo) => one(name, 'sin-leer', (f) => {
    assert.match(f.place, /un submódulo, en la historia o en otra ref/, name);
    assert.strictEqual(f.action, action, name);
    assert.match(f.todo, todo, name);
  });
  reset();
  const withSub = syncCommit(fx, seed, { parent: seed.commit, files: { 'vendor/otro': gitlink } });
  syncCommit(fx, seed, { parent: withSub, ref: 'refs/heads/main' });
  await submodule('un submódulo en la historia de main', 'delete-and-purge', /llegó a main.*purga/);
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'vendor/otro': gitlink }, message: 'Un aporte', ref: 'refs/pull/3/head' });
  await submodule('un submódulo sólo en la cabeza de un pedido', 'delete-and-purge', /está en un pedido.*purga/);
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'vendor/otro': gitlink }, message: 'Una prueba', ref: 'refs/heads/una-prueba' });
  await submodule('un submódulo sólo en una rama', 'delete', /cuelga sólo de una rama o de una marca/);

  // 🔴 el NOMBRE de una ruta que estuvo en main (ya se sacó) y que además está en una rama, con otro contenido. Se
  // dice una vez; lo que hay que hacer sale del sitio que más lejos llegó, no del objeto que ordena primero. Para
  // que el orden no ayude: el contenido cuyo objeto ordena PRIMERO va a la rama, y el otro a la historia de main.
  reset();
  const dirtyPath = `docs/${TERM}/nota.md`;
  const [first, second] = ['# Una nota\n', '# Otra nota\n'].map((content) => ({ content, sha: gitFx(fx.bare, ['hash-object', '-w', '--stdin'], { input: content }) })).sort((x, y) => (x.sha < y.sha ? -1 : 1));
  const wasInMain = syncCommit(fx, seed, { parent: seed.commit, files: { [dirtyPath]: second.content } });
  syncCommit(fx, seed, { parent: wasInMain, ref: 'refs/heads/main' });
  publicCommit(fx, { parents: [seed.commit], files: { [dirtyPath]: first.content }, message: 'Una prueba', ref: 'refs/heads/una-prueba' });
  await only('el nombre de una ruta que estuvo en main y además está en una rama', 'delete-and-purge', /llegó a main.*purga/);
  const byName = (await verifyRun(fx)).json.findings.filter((f) => f.category === 'cliente');
  assert.strictEqual(byName.length, 1, 'el nombre de la ruta se dice una sola vez');
  assert.ok(byName[0].place.includes(second.sha.slice(0, 12)), `y cita el objeto del sitio que más lejos llegó (el de main)\n${byName[0].place}`);
  // el gemelo: la misma ruta SÓLO en la rama se borra con la rama
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { [dirtyPath]: first.content }, message: 'Una prueba', ref: 'refs/heads/una-prueba' });
  await only('el nombre de una ruta que sólo está en una rama', 'delete', /cuelga sólo de una rama o de una marca/);
});

test('T65_Verify_EveryPage_APageThatFails_IsCouldNotLook_AndTheOtherPartsAreStillLooked', async () => {
  const fx = await fixture();
  seedPublication(fx);
  const dirty = `Lo pidió ${TERM}.`;
  const pagesOf = (suffix) => fx.api.requests.filter((q) => q.path.endsWith(suffix)).map((q) => `${q.query.per_page}/${q.query.page}`);

  // el término en el ÚLTIMO issue de 150 (la segunda página) y en el último de 230 comentarios (la tercera)
  fx.api.state.issues = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, state: 'closed', title: `Issue ${i + 1}`, body: i === 149 ? dirty : 'Limpio.' }));
  fx.api.state.issueComments = Array.from({ length: 230 }, (_, i) => ({ id: 1000 + i, issue_url: 'https://api.example.test/repos/o/r/issues/3', body: i === 229 ? dirty : 'Limpio.' }));
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => f.place), ['el issue nº 150 (cuerpo, línea 1)', 'el comentario con id 1229 (en el pedido o issue nº 3) (línea 1)']);
  assert.deepStrictEqual(pagesOf('/issues'), ['100/1', '100/2']);
  assert.deepStrictEqual(pagesOf('/issues/comments'), ['100/1', '100/2', '100/3']);
  assert.deepStrictEqual([r.json.looked.l, r.json.looked.m], [150, 230]);
  // una lista de justo una página llena: se pide la siguiente (vacía) antes de darla por leída
  fx.api.reset();
  fx.api.state.releases = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `v${i}`, tag_name: `v${i}`, body: '', assets: [] }));
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(pagesOf('/releases'), ['100/1', '100/2']);
  // la lista de pedidos y la línea de tiempo, también hasta su última página: el término en el último de cada una
  fx.api.reset();
  fx.api.state.pulls = Array.from({ length: 120 }, (_, i) => ({ number: i + 1, state: 'closed', head: { ref: i === 119 ? `feature/${TERM.toLowerCase()}-x` : `rama-${i}` }, base: { ref: 'main' } }));
  fx.api.state.issueEvents = Array.from({ length: 101 }, (_, i) => ({ id: 5000 + i, event: 'renamed', issue: { number: 3 }, rename: { from: i === 100 ? `Para ${TERM}` : 'Un título', to: 'Otro título' } }));
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => f.place), ['el pedido nº 120 (rama)', 'el evento con id 5100 (en el pedido o issue nº 3): un título anterior']);
  assert.deepStrictEqual(fx.api.requests.filter((q) => q.path.endsWith('/pulls') && q.query.state === 'all').map((q) => `${q.query.per_page}/${q.query.page}`), ['100/1', '100/2']);
  assert.deepStrictEqual(pagesOf('/issues/events'), ['100/1', '100/2']);

  // 🔴 las alertas de secretos se leen ANTES que las listas largas: la parte (m) hace una llamada por pedido, y si
  // agota el cupo de la hora (de ahí en más la API contesta 403 a todo), las alertas ya se leyeron. Con el orden de
  // antes quedaban «no medidas» la misma noche en que más importan (pase adversarial de la tanda F2).
  fx.api.reset();
  fx.api.state.credential = READER;
  fx.api.state.alerts = [{ number: 3, state: 'open' }];
  fx.api.state.issues = [{ number: 7, state: 'closed', title: 'Un aporte', body: '', pull_request: {} }];
  let spent = false;
  fx.api.override = (q) => {
    if (/\/pulls\/\d+\/reviews$/.test(q.path)) spent = true;
    return spent ? { status: 403, json: { message: 'API rate limit exceeded' } } : null;
  };
  r = await verifyRun(fx, [], { credential: READER });
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['g secret-alert'], 'la alerta se leyó');
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part), ['m'], 'y las revisiones quedan como «no pude mirar»');
  assert.deepStrictEqual(r.json.notMeasured, [], 'nada quedó «no medido» por el cupo');

  // 🔴 una página que no se pudo leer: ESA parte queda en «no pude mirar» (2), y las otras se miran igual
  fx.api.reset();
  fx.api.state.issueComments = Array.from({ length: 130 }, (_, i) => ({ id: i, issue_url: 'https://api.example.test/repos/o/r/issues/3', body: 'Limpio.' }));
  fx.api.override = (q) => (q.path.endsWith('/issues/comments') && q.query.page === '2' ? { status: 500, json: { message: 'Server Error' } } : null);
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part), ['m']);
  assert.match(r.json.couldNotLook[0].reason, /página 2/);
  assert.deepStrictEqual(r.json.findings, []);
  let plain = await verifyPlain(fx);
  assert.match(plain.out, /\(m\) [^\n]*: NO PUDE MIRAR/);
  assert.match(plain.out, /\(k\) [^\n]*: sin hallazgos/);
  assert.match(plain.out, /\(l\) [^\n]*: sin hallazgos/);
  // …y con un hallazgo en otra parte sale 1, diciendo además lo que no se pudo mirar
  fx.api.state.releases = [{ id: 7, name: `Para ${TERM}`, tag_name: 'v1', body: '', assets: [] }];
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['k']);
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part), ['m']);
  assert.match(r.err, /Además no pude mirar \(m\)/);
});

// (Aparte de la de arriba para que ninguna de las dos pase de unos segundos: cada caso es una corrida entera de `verify`.)
test('T65_Verify_WhatIsNotAListOrCannotBeRead_IsCouldNotLook_NeverSkippedNorCutShort', async () => {
  const fx = await fixture();
  seedPublication(fx);
  let r;
  // lo que no es una lista, en cualquier página; y una lista de pedidos caída arrastra a las revisiones (no se sabe de cuáles)
  for (const [what, override, parts] of [
    ['las versiones contestan un objeto', (q) => (q.path.endsWith('/releases') ? { status: 200, json: { message: 'otra cosa' } } : null), ['k']],
    ['las versiones contestan 404', (q) => (q.path.endsWith('/releases') ? { status: 404, json: { message: 'Not Found' } } : null), ['k']],
    ['las etiquetas no contestan JSON', (q) => (q.path.endsWith('/labels') ? { status: 200, raw: '<html>' } : null), ['l', 'm']],
    ['los pedidos y los issues contestan 500', (q) => (q.path.endsWith('/issues') ? { status: 500, json: {} } : null), ['l', 'm']],
    ['la lista de pedidos (el nombre de cada rama) contesta 500', (q) => (q.path.endsWith('/pulls') && q.query.state === 'all' ? { status: 500, json: {} } : null), ['l', 'm']],
    ['la línea de tiempo contesta 403', (q) => (q.path.endsWith('/issues/events') ? { status: 403, json: {} } : null), ['l', 'm']],
    ['las revisiones de un pedido contestan 500', (q) => (/\/pulls\/\d+\/reviews$/.test(q.path) ? { status: 500, json: {} } : null), ['m']],
    ['los comentarios sobre commits contestan 403', (q) => (q.path.endsWith('/comments') && !q.path.includes('/issues/') && !q.path.includes('/pulls/') ? { status: 403, json: {} } : null), ['m']],
  ]) {
    fx.api.reset();
    fx.api.state.issues = [{ number: 7, state: 'closed', title: 'Un aporte', body: '', pull_request: {} }];
    fx.api.override = override;
    r = await verifyRun(fx);
    assert.strictEqual(r.code, 2, `${what}: sale 2\n${r.all}`);
    assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part).sort(), parts, `${what}\n${r.all}`);
  }
  // 🔴 un elemento de una lista que no se puede leer no se saltea (salteado, la lista se daría por leída con uno menos):
  // la parte entera es «no pude mirar». Lo mismo una versión sin su lista de adjuntos, y un pedido sin su número
  // (sus revisiones no se podrían pedir, y eso no es «no tiene»)
  const pr7 = { number: 7, state: 'closed', title: 'Un aporte', body: '', pull_request: {} };
  for (const [what, mutate, parts] of [
    ['una versión que no es un objeto', (s) => { s.releases = [{ id: 1, name: 'v', tag_name: 'v', body: '', assets: [] }, null]; }, ['k']],
    ['una versión que es una lista', (s) => { s.releases = [[]]; }, ['k']],
    ['una versión sin su lista de adjuntos', (s) => { s.releases = [{ id: 1, name: 'v', tag_name: 'v', body: '' }]; }, ['k']],
    ['una versión con adjuntos que no son una lista', (s) => { s.releases = [{ id: 1, name: 'v', tag_name: 'v', body: '', assets: 'ninguno' }]; }, ['k']],
    ['un adjunto que no es un objeto', (s) => { s.releases = [{ id: 1, name: 'v', tag_name: 'v', body: '', assets: ['paquete.zip'] }]; }, ['k']],
    ['un issue que no es un objeto', (s) => { s.issues = [pr7, 'otro']; }, ['l', 'm']],
    ['un pedido sin su número', (s) => { s.issues = [pr7, { title: 'Sin número', body: '', pull_request: {} }]; }, ['l', 'm']],
    ['un pedido con un número que no es un número', (s) => { s.issues = [{ ...pr7, number: '7; rm -rf' }]; }, ['l', 'm']],
    ['una etiqueta que no es un objeto', (s) => { s.labels = ['bug']; }, ['l', 'm']],
    ['un hito que no es un objeto', (s) => { s.milestones = [3]; }, ['l', 'm']],
    ['un comentario que no es un objeto', (s) => { s.issueComments = [{ id: 1, body: 'Bien.' }, 7]; }, ['m']],
    ['un comentario de revisión que no es un objeto', (s) => { s.reviewComments = [null]; }, ['m']],
    // un comentario de revisión trae siempre su ruta y el fragmento del cambio: sin alguno no es «sin fragmento»; y lo
    // de adentro de un evento de la línea de tiempo, si viene y no es un texto, tampoco es «sin texto» (revisor de
    // fallos silenciosos, cuarta vuelta de la F2)
    ['un comentario de revisión sin el fragmento del cambio', (s) => { s.reviewComments = [{ id: 1, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', path: 'docs/aporte.md' }]; }, ['m']],
    ['un comentario de revisión sin su ruta', (s) => { s.reviewComments = [{ id: 1, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', diff_hunk: '@@ -0,0 +1 @@\n+Limpio.' }]; }, ['m']],
    ['un comentario de revisión con una ruta que no es un texto', (s) => { s.reviewComments = [{ id: 1, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', path: ['docs'], diff_hunk: '' }]; }, ['m']],
    ['un comentario sobre un commit con una ruta que no es un texto', (s) => { s.commitComments = [{ id: 1, commit_id: 'a'.repeat(40), body: 'Visto.', path: { nombre: 'x' } }]; }, ['m']],
    ['un evento con un título anterior que no es un texto', (s) => { s.issueEvents = [{ id: 1, event: 'renamed', issue: { number: 7 }, rename: { from: ['Un título'], to: 'Otro' } }]; }, ['l', 'm']],
    ['un evento con un «rename» que no es un objeto', (s) => { s.issueEvents = [{ id: 1, event: 'renamed', issue: { number: 7 }, rename: 7 }]; }, ['l', 'm']],
    ['un evento con una etiqueta que no es un objeto', (s) => { s.issueEvents = [{ id: 1, event: 'labeled', issue: { number: 7 }, label: [{ name: 'bug' }] }]; }, ['l', 'm']],
    // …y en cualquier parte que lee la API: donde va un texto, otra cosa (un objeto, un número, una lista) no se lee
    // como «[object Object]», que saldría limpio (revisor de fallos silenciosos, quinta vuelta de la F2)
    ['el cuerpo de un comentario que es un objeto', (s) => { s.issueComments = [{ id: 1, issue_url: 'https://api.example.test/repos/o/r/issues/7', body: { texto: 'Bien.' } }]; }, ['m']],
    ['el cuerpo de una revisión que es una lista', (s) => { s.reviews = { 7: [{ id: 1, body: ['Bien.'] }] }; }, ['m']],
    ['el cuerpo de un issue que es un número', (s) => { s.issues = [pr7, { number: 9, state: 'open', title: 'Un bug', body: 7 }]; }, ['l', 'm']],
    ['las notas de una versión que son una lista', (s) => { s.releases = [{ id: 1, name: 'v', tag_name: 'v', body: ['Notas.'], assets: [] }]; }, ['k']],
    ['la descripción del repo que es un objeto', (s) => { s.repo.description = { texto: 'Un arnés' }; }, ['d']],
    ['el título del pedido abierto de la sincronización que es un objeto', () => { fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') && q.query.state === 'open' ? { status: 200, json: [{ number: 1, title: {}, body: '', head: { ref: 'mirror/sync' } }] } : null); }, ['e']],
    ['un comentario sobre un commit que no es un objeto', (s) => { s.commitComments = ['x']; }, ['m']],
    ['una revisión que no es un objeto', (s) => { s.reviews = { 7: [{ id: 1, body: '' }, null] }; }, ['m']],
    // las dos partes de antes que leen la API tenían el mismo salteo callado: el pedido abierto de la sincronización
    // y los temas del repo
    ['un pedido abierto de la sincronización que no es un objeto', () => { fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') && q.query.state === 'open' ? { status: 200, json: [null] } : null); }, ['e']],
    // la lista de pedidos (de ahí sale el nombre de cada rama) y la línea de tiempo: lo mismo
    ['un pedido de la lista de pedidos que no es un objeto', (s) => { s.pulls = [null]; }, ['l', 'm']],
    ['un pedido sin el nombre de su rama', (s) => { s.pulls = [{ number: 7, state: 'closed', head: {}, base: { ref: 'main' } }]; }, ['l', 'm']],
    ['un pedido sin su rama destino', (s) => { s.pulls = [{ number: 7, state: 'closed', head: { ref: 'un-aporte' }, base: null }]; }, ['l', 'm']],
    ['un evento de la línea de tiempo que no es un objeto', (s) => { s.issueEvents = [{ id: 1, event: 'closed', issue: { number: 7 } }, 'otro']; }, ['l', 'm']],
    ['los temas del repo, que no son una lista', (s) => { s.topics = 'harness'; }, ['d']],
  ]) {
    fx.api.reset();
    fx.api.state.issues = [pr7];
    mutate(fx.api.state);
    r = await verifyRun(fx);
    assert.strictEqual(r.code, 2, `${what}: sale 2\n${r.all}`);
    assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part).sort(), parts, `${what}\n${r.all}`);
    assert.deepStrictEqual(r.json.findings, [], what);
  }
  // el gemelo: un issue SIN número no es un pedido, y no impide leer nada (no hay revisiones que pedirle)
  fx.api.reset();
  fx.api.state.issues = [pr7, { title: 'Un issue raro', body: '' }];
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  // un servidor que nunca deja de dar páginas llenas: no se corta callado en un tope
  fx.api.reset();
  fx.api.override = (q) => (q.path.endsWith('/releases') ? { status: 200, json: Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'v', tag_name: 'v', body: '', assets: [] })) } : null);
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part), ['k']);
  assert.match(r.json.couldNotLook[0].reason, /más de \d+ páginas/);
});

test('T65_Verify_ASecretRotatesFirst_AndTheReportFileSaysWhereAndWhatToDo_NeverTheText', async () => {
  const fx = await fixture();
  seedPublication(fx);
  const secret = tokenSentinel('F2nota');
  const report = path.join(fx.dir, 'informe', 'verify.json');
  fx.api.state.issues = [{ number: 7, state: 'closed', title: 'Un aporte', body: `Lo pidió ${TERM}.`, pull_request: {} }];
  fx.api.state.issueComments = [{ id: 31, issue_url: 'https://api.example.test/repos/o/r/issues/7', body: `la llave es ${secret}` }];
  let r = await verifyRun(fx, ['--report', report]);
  assert.strictEqual(r.code, 1, r.all);
  const byCategory = Object.fromEntries(r.json.findings.map((f) => [f.category, f]));
  assert.deepStrictEqual(Object.keys(byCategory).sort(), ['cliente', 'secreto']);
  assert.strictEqual(byCategory.secreto.rotateFirst, true);
  assert.match(byCategory.secreto.todo, /^es un secreto: se rota PRIMERO .*después, .*purga/);
  assert.strictEqual(byCategory.cliente.rotateFirst, false);
  assert.doesNotMatch(byCategory.cliente.todo, /se rota/);
  for (const text of [secret, secret.slice(0, 14), TERM]) assert.ok(!r.all.toLowerCase().includes(text.toLowerCase()), `ninguna salida trae lo hallado\n${r.all}`);
  // el informe: el veredicto, los lugares y qué hacer — lo mismo que --json, en un archivo que sólo lee quien corre
  const written = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.strictEqual(written.command, 'verify');
  assert.strictEqual(written.exit, 1);
  assert.deepStrictEqual(written.findings, r.json.findings);
  const KEYS = ['action', 'category', 'part', 'place', 'reach', 'rotateFirst', 'todo'];   // `reach`: tanda F3 de la 8.26
  assert.deepStrictEqual(written.findings.map((f) => Object.keys(f).sort()), [KEYS, KEYS]);
  assert.deepStrictEqual(written.findings.map((f) => f.reach), ['conversation', 'conversation']);
  assert.strictEqual(written.private, false);
  // T70 (tanda F3 · AC 58): con el repo privado el secreto se sigue rotando primero, y ninguno de los dos pide la purga
  fx.api.state.credential = READER;
  fx.api.state.repo.private = true;
  const onPrivate = await verifyRun(fx, [], { credential: READER });
  assert.strictEqual(onPrivate.code, 1, onPrivate.all);
  const privately = Object.fromEntries(onPrivate.json.findings.map((f) => [f.category, f]));
  assert.match(privately.secreto.todo, /^es un secreto: se rota PRIMERO .*después, está en un pedido, un issue o un comentario del repo privado: se borra o se corrige/);
  assert.deepStrictEqual([privately.secreto.rotateFirst, privately.secreto.action, privately.cliente.action], [true, 'delete-and-purge', 'delete-and-purge'], 'la acción no cambia: cambia el consejo');
  for (const f of onPrivate.json.findings) assert.doesNotMatch(f.todo, /pid\w* la purga/, f.place);
  fx.api.state.credential = null;
  fx.api.state.repo.private = false;
  // …y sin poder leer si el repo es privado, todo como con el repo público: los mismos hallazgos con su consejo (el
  // secreto se rota primero y se pide la purga) y el mismo código de salida
  fx.api.override = (q) => (/^\/repos\/[^/]+\/[^/]+$/.test(q.path) ? { status: 500, json: {} } : null);
  const unknown = await verifyRun(fx);
  assert.deepStrictEqual([unknown.code, unknown.json.private], [r.code, null], unknown.all);
  assert.deepStrictEqual(unknown.json.findings, r.json.findings);
  fx.api.override = null;
  const raw = fs.readFileSync(report, 'utf8');
  for (const text of [secret, TERM, fx.publicRepo.repo]) assert.ok(!raw.toLowerCase().includes(text.toLowerCase()), 'el informe tampoco trae lo hallado ni el nombre del repo');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(report).mode & 0o077, 0, 'el informe no lo lee otro usuario de la máquina');

  // limpio: el informe dice 0 y sin hallazgos (el paso que avisa calla con esto)
  fx.api.reset();
  r = await verifyRun(fx, ['--report', report]);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual([JSON.parse(fs.readFileSync(report, 'utf8')).exit, JSON.parse(fs.readFileSync(report, 'utf8')).findings], [0, []]);
  // «no pude mirar»: el informe lo dice, con el motivo — también cuando `verify` frena antes de mirar nada (sin lista)
  fx.api.override = (q) => (q.path.endsWith('/releases') ? { status: 500, json: {} } : null);
  r = await verifyRun(fx, ['--report', report]);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(report, 'utf8')).couldNotLook.map((n) => n.part), ['k']);
  fs.rmSync(report);
  const noList = await mirror(fx, ['verify', '--json', '--report', report, '--denied', path.join(fx.dir, 'no-hay-lista.json')]);
  assert.strictEqual(noList.code, 2, noList.all);
  const early = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.strictEqual(early.exit, 2);
  assert.match(early.message, /no pude mirar/);
  // …y cuando frena ANTES de leer sus opciones: una opción que no existe, o un token que no tiene forma de token. El
  // paso que avisa lee este archivo: sin él diría «no dejó un informe», no el motivo (pase adversarial de la tanda F2)
  for (const [what, args, opts, why] of [
    ['una opción que no existe', ['verify', '--json', '--report', report, '--not-an-option'], {}, /opción desconocida/],
    ['un token que no es una sola palabra', ['verify', '--json', '--report', report], { credential: 'dos palabras' }, /no tiene la forma de un token/],
  ]) {
    fs.rmSync(report, { force: true });
    const stopped = await mirror(fx, args, opts);
    assert.strictEqual(stopped.code, 2, `${what}\n${stopped.all}`);
    const left = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.deepStrictEqual([left.command, left.exit], ['verify', 2], what);
    assert.match(left.message, why, what);
  }
  // `--report` seguido de otra opción no tiene valor: sale 2, y no deja un archivo llamado como esa opción
  const noValue = await mirror(fx, ['verify', '--report', '--json']);
  assert.strictEqual(noValue.code, 2, noValue.all);
  assert.match(noValue.all, /--report necesita un valor/);
  assert.ok(!fs.existsSync(path.join(fx.dir, '--json')), 'no se escribe un informe en un archivo llamado «--json»');
  // el archivo es de `verify`: otro subcomando que frena con `--report` no deja nada escrito
  fs.rmSync(report, { force: true });
  assert.strictEqual((await mirrorReadOnly(fx, ['sync', '--report', report])).code, 2);
  assert.ok(!fs.existsSync(report), 'sync --report no escribe un informe');
  // un informe que no se puede escribir no pasa callado: un verde sin informe deja al aviso sin de dónde salir
  fx.api.reset();
  const blocked = path.join(fx.dir, 'un-archivo');
  fs.writeFileSync(blocked, 'x');
  r = await verifyRun(fx, ['--report', path.join(blocked, 'verify.json')]);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude escribir el informe/);
  // …y con hallazgos sigue siendo un 1 (hay hallazgos: no se degradan a «no pude»), diciendo las dos cosas
  fx.api.state.issues = [{ number: 7, state: 'closed', title: `Para ${TERM}`, body: '', pull_request: {} }];
  r = await verifyRun(fx, ['--report', path.join(blocked, 'verify.json')]);
  assert.strictEqual(r.code, 1, r.all);
  assert.match(r.err, /1 hallazgo\(s\)[^\n]*Además, no pude escribir el informe/);
  // la regla, sola: qué va al informe y qué código queda si no se pudo escribir
  const lib = require(MIRROR);
  const crashed = { exit: 2, message: 'error no previsto: TypeError: x is not a function\n    at verify (/una/ruta/privada/mirror.js:1:1)', data: {} };
  assert.deepStrictEqual(lib.reportForFile(crashed), { exit: 2, message: 'error no previsto (el detalle, en el registro de la corrida)', data: {} }, 'la traza de un error no previsto no va al informe (termina en un aviso)');
  const known = { exit: 2, message: 'no pude mirar (k): la API contestó 500', data: { couldNotLook: [] } };
  assert.strictEqual(lib.reportForFile(known), known, 'un motivo previsto va tal cual');
  assert.deepStrictEqual([0, 1, 2].map((exit) => lib.reportUnwritten({ exit, message: '' }, 'no pude escribir').exit), [2, 1, 2]);
  assert.strictEqual(lib.reportUnwritten({ exit: 0, message: '' }, 'no pude escribir').message, 'no pude escribir');
  // `--report` y `--direct` son de verify: los que escriben los rechazan sin tocar nada
  for (const args of [['sync', '--direct'], ['first', '--direct'], ['plan', '--direct'], ['sync', '--report', report], ['verify', '--report']]) {
    const bad = await mirrorReadOnly(fx, args);
    assert.strictEqual(bad.code, 2, `${args.join(' ')}\n${bad.all}`);
  }
});

test('T24_Verify_DirectMode_OwnerCommitOnMainIsNotForeign_AndANoreplyIdentityIsNotAFinding', async () => {
  const fx = await fixture();
  const seed = seedPublication(fx);
  // el dueño escribe directo en main, con el correo `noreply` de GitHub de su cuenta (una persona que la lista no conoce)
  const owner = { GIT_AUTHOR_NAME: 'Mantenedor De Prueba', GIT_AUTHOR_EMAIL: ['5151+mantenedor-de-prueba', 'users.noreply.github.com'].join('@') };
  const asOwner = { ...owner, GIT_COMMITTER_NAME: owner.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: owner.GIT_AUTHOR_EMAIL };
  const direct = publicCommit(fx, { parents: [seed.commit], files: { 'docs/nuevo.md': '# Nuevo\n' }, message: 'docs: una guía nueva', identity: asOwner });

  // sin --direct: es un cambio ajeno a la sincronización (la parte f, como siempre)… y NADA más: el `noreply` no es un hallazgo
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['f foreign-change']);
  assert.ok(r.json.findings[0].place.includes(direct));
  assert.strictEqual(r.json.direct, false);

  // con --direct: el público es la fuente. Ese commit no es ajeno, y las tres partes de la sincronización dicen «no aplica»
  r = await verifyRun(fx, ['--direct']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.couldNotLook, []);
  assert.strictEqual(r.json.direct, true);
  assert.deepStrictEqual(r.json.notApplicable.map((n) => n.part).sort(), ['f', 'i', 'j']);
  for (const n of r.json.notApplicable) assert.match(n.reason, /--direct/);
  const plain = await verifyPlain(fx, ['--direct']);
  for (const part of ['f', 'i', 'j']) assert.match(plain.out, new RegExp(`\\(${part}\\) [^\\n]*: no aplica — el público es la fuente`));
  // …y lo demás se sigue mirando igual: el contenido, la identidad, lo que no es git
  publicCommit(fx, { parents: [direct], files: { 'docs/otra.md': `Lo pidió ${TERM}.\n` }, message: 'docs: otra', identity: asOwner });
  r = await verifyRun(fx, ['--direct']);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['a']);
  gitFx(fx.bare, ['update-ref', 'refs/heads/main', direct]);
  // con --direct y --strict: «no aplica» no es «no medido»
  fx.api.state.credential = READER;
  r = await verifyRun(fx, ['--direct', '--strict'], { credential: READER });
  assert.strictEqual(r.code, 0, r.all);
  fx.api.reset();
  // con --direct no hacen falta los internos: una sincronización anterior que el interno no conoce no es «no pude mirar»
  r = await verifyRun(fx, ['--direct', '--harness', 'HEAD']);
  assert.strictEqual(r.code, 0, r.all);

  // el `noreply` no tapa lo que sí se mira: el NOMBRE con que firma y la CUENTA de adentro del correo, contra la lista
  const check = async (identity, expected, what) => {
    gitFx(fx.bare, ['update-ref', 'refs/heads/main', seed.commit]);
    publicCommit(fx, { parents: [seed.commit], files: { 'docs/x.md': '# X\n' }, message: 'docs: x', identity: { ...asOwner, ...identity } });
    const v = await verifyRun(fx, ['--direct']);
    assert.deepStrictEqual(v.json.findings.map((f) => `${f.part} ${f.category}`), expected, `${what}\n${v.all}`);
    assert.strictEqual(v.code, expected.length ? 1 : 0, what);
    assert.ok(!v.all.toLowerCase().includes(TERM.toLowerCase()), what);
  };
  await check({ GIT_AUTHOR_NAME: `${TERM} Pérez` }, ['c cliente'], 'un nombre de la lista, con correo noreply');
  await check({ GIT_AUTHOR_EMAIL: [`77+${TERM}`, 'users.noreply.github.com'].join('@') }, ['c cliente'], 'una cuenta de la lista adentro del noreply');
  await check({ GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: WEB_COMMITTER }, [], 'el committer de un merge hecho en la web de GitHub');
  // un correo que NO es noreply sigue siendo un hallazgo (la regla genérica de correos), como antes
  await check({ GIT_AUTHOR_EMAIL: ['otra.persona', 'correo-inventado.dev'].join('@') }, ['c email'], 'un correo de verdad');
  // y el firmante de una marca anotada, lo mismo: con noreply pasa, con un correo de verdad no
  gitFx(fx.bare, ['update-ref', 'refs/heads/main', seed.commit]);
  gitFx(fx.bare, ['tag', '-a', 'v1', '-m', 'Una entrega', seed.commit], { env: asOwner });
  r = await verifyRun(fx, ['--direct']);
  assert.strictEqual(r.code, 0, `una marca firmada con noreply\n${r.all}`);
  gitFx(fx.bare, ['tag', '-a', 'v2', '-m', 'Otra entrega', seed.commit], { env: { ...asOwner, GIT_COMMITTER_EMAIL: ['otra.persona', 'correo-inventado.dev'].join('@') } });
  r = await verifyRun(fx, ['--direct']);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['c email'], r.all);
});

// ── T25 · AC 15, 16 ────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Verify_ExitCodesAndNotMeasured', async () => {
  let fx = await fixture();
  const seed = seedPublication(fx);
  const measured = (r) => r.json.notMeasured.map((n) => n.part).sort();

  // control: público, con un token que lee todo, y estricto: 0 sin nada sin medir
  fx.api.state.credential = READER;
  let r = await verifyRun(fx, ['--strict'], { credential: READER });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.notMeasured, []);
  assert.deepStrictEqual(r.json.findings, []);
  assert.ok(fx.api.requests.every((q) => q.headers.authorization === `Bearer ${READER}`), 'a la API le habla con el token');
  fx.api.reset();

  // un cambio ajeno sin absorber: 1
  const foreign = publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['f']);
  assert.ok(r.json.findings[0].place.includes(foreign), 'el lugar es el commit');
  // absorbido en la historia interna (la marca, puesta a mano), deja de serlo. Su contenido se mira como el de cualquier commit.
  commit(fx.harness, `Traer un cambio del público\n\nPublic-Commit: ${foreign}`, { allowEmpty: true });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  gitFx(fx.bare, ['update-ref', 'refs/heads/main', seed.commit]);

  // el reporte privado de vulnerabilidades apagado, con el repo público: 1
  fx.api.state.vulnerabilityReporting = { enabled: false };
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['h']);
  fx.api.reset();

  // una alerta abierta del escaneo de secretos: 1
  fx.api.state.alerts = [{ number: 3, state: 'open' }];
  r = await verifyRun(fx, [], { credential: READER });
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['g']);
  fx.api.reset();

  // sin un token que lea alertas: 0 con «NO MEDIDO», nunca callado; con --strict, 2
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(measured(r), ['g']);
  assert.ok(!fx.api.requests.some((q) => q.path.includes('secret-scanning')), 'sin token ni pregunta');
  let h = await verifyPlain(fx);
  assert.strictEqual(h.code, 0, h.all);
  assert.match(h.out, /\(g\).*NO MEDIDO/);
  r = await verifyRun(fx, ['--strict']);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(measured(r), ['g']);
  assert.match(r.err, /NO MEDIDO/);

  // con un token sin permiso para leer alertas ni el reporte privado: lo mismo, por las dos
  fx.api.override = (q) => (/secret-scanning|private-vulnerability-reporting/.test(q.path) ? { status: 403, json: { message: 'Resource not accessible by integration' } } : null);
  r = await verifyRun(fx, [], { credential: READER });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(measured(r), ['g', 'h']);
  r = await verifyRun(fx, ['--strict'], { credential: READER });
  assert.strictEqual(r.code, 2, r.all);
  fx.api.reset();

  // un repo privado: ahí (g) y (h) no existen. Con --strict, 0, y la salida lo dice
  fx.api.state.credential = READER;
  fx.api.state.repo.private = true;
  r = await verifyRun(fx, ['--strict'], { credential: READER });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.notMeasured, []);
  assert.deepStrictEqual(r.json.notApplicable.map((n) => n.part).sort(), ['g', 'h']);
  assert.strictEqual(r.json.private, true);
  assert.ok(!fx.api.requests.some((q) => /secret-scanning|private-vulnerability-reporting/.test(q.path)), 'no pregunta por lo que no existe');
  h = await verifyPlain(fx, ['--strict'], { credential: READER });
  assert.strictEqual(h.code, 0, h.all);
  assert.match(h.out, /\(g\).*privado/);
  assert.match(h.out, /\(h\).*privado/);
  // sin el token, la API no deja ver el repo privado: no pude mirar
  r = await verifyRun(fx, ['--strict']);
  assert.strictEqual(r.code, 2, r.all);
  assert.ok(r.json.couldNotLook.some((n) => n.part === 'd'), JSON.stringify(r.json.couldNotLook));
  fx.api.reset();

  // una API que no contesta: 2 «no pude mirar»
  r = await verifyRun(fx, [], { env: { TYCON_MIRROR_API_URL: `http://127.0.0.1:${await closedPort()}` } });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude mirar/);
  // todas las partes que se leen por la API: las de siempre y las de lo publicado que no es git (versiones, pedidos e
  // issues, comentarios — story 8.26, tanda F2)
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part).sort(), ['d', 'e', 'k', 'l', 'm']);

  // la API contesta mal a lo que hay que mirar: 2, nunca «limpio»
  const openPulls = (q) => q.path.endsWith('/pulls') && q.query.state === 'open';   // la lista de TODOS los pedidos es de la parte (l)
  fx.api.override = (q) => (openPulls(q) ? { status: 500, json: { message: 'Server Error' } } : null);
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part), ['e']);
  fx.api.reset();

  // con hallazgos y algo sin poder mirar: 1 (lo hallado es seguro), y las dos cosas dichas
  fx.api.state.repo.description = `El arnés de ${TERM}`;
  fx.api.override = (q) => (openPulls(q) ? { status: 500, json: {} } : null);
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['d']);
  assert.deepStrictEqual(r.json.couldNotLook.map((n) => n.part), ['e']);
  fx.api.reset();

  // un repo sin publicar (sin main): no hay qué mirar, 2
  fx = await fixture();
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude mirar/);

  // un repo que no existe: 2
  fx.config({ publicRepos: { ...PUBLIC, repo: 'no-existe' } });
  fx.publicRepo = { ...PUBLIC, repo: 'no-existe' };
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude mirar/);
  assert.match(r.err, /no existe/);

  // sin la lista privada (donde no viaja): 2 diciendo qué falta, sin mirar nada
  fx = await fixture();
  seedPublication(fx);
  const lab = labWithFakeExporter(fx, {});
  r = await mirrorReadOnly(fx, ['verify', '--public-repos', fx.cfg.publicRepos], { script: lab, config: false });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /denylist\.json/);
  assert.deepStrictEqual(fx.api.requests, []);
});

// ── lo que escribe: `first` y `sync` ───────────────────────────────────────────────────────────────────────────────
const WRITER = 'escritor-de-mentira-0002';
const AMBIENT = 'credencial-del-ambiente-0003';
const MAIN_REF = 'refs/heads/main';
const SYNC_REF = 'refs/heads/mirror/sync';
// el título del pull request de la sincronización: un texto del guion, que T17 mete en la lista para probar que se revisa
const PR_TITLE = 'Sincronización con los repos internos';
const tipOf = (bare, ref) => gitFx(bare, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { tolerate: true }).stdout.trim();
const headOf = (dir) => gitFx(dir, ['rev-parse', 'HEAD']);
const base64 = (credential) => authHeader(credential).split(' ').pop();

/** Un commit del público, abierto: padres, árbol, identidad, fechas y mensaje. */
function commitFacts(bare, sha) {
  const format = '%P%x00%T%x00%an <%ae>%x00%ad%x00%cn <%ce>%x00%cd%x00%B';
  const [parents, tree, author, authored, committer, committed, body] = gitFx(bare, ['log', '-1', '--date=raw', `--format=${format}`, sha]).split('\0');
  return { parents: parents ? parents.split(' ') : [], tree, author, authored, committer, committed, body };
}

/**
 * Lo que tiene que traer un commit de la sincronización: la identidad fija, la fecha del interno más reciente, los tres
 * trailers y —desde la story 8.13 (AC 24)— `version.json`: el árbol del commit es el FINAL (el de la exportación más ese
 * archivo), y `Mirror-Tree` nombra ese mismo. Con `version`, además, que el número sea ése.
 */
function assertMirrorCommit(fx, sha, { parents, tree, subject, version = null }, name) {
  const fixed = require(EXPORTER).COMMIT_IDENTITY;
  const identity = `${fixed.nombre} <${fixed.email}>`;
  const newest = Math.max(...[fx.harness, fx.skills].map((dir) => Number(gitFx(dir, ['log', '-1', '--format=%ct', 'HEAD']))));
  const facts = commitFacts(fx.bare, sha);
  assert.deepStrictEqual(facts.parents, parents, `${name}: los padres`);
  assert.strictEqual(facts.tree, tree, `${name}: el árbol es el final (el de la exportación más version.json)`);
  const stamped = gitFx(fx.bare, ['show', `${sha}:version.json`], { tolerate: true });
  assert.strictEqual(stamped.status, 0, `${name}: el commit trae version.json en su raíz\n${stamped.stderr}`);
  const file = JSON.parse(stamped.stdout);
  assert.deepStrictEqual(file.source, { harness: headOf(fx.harness), agent_skills: headOf(fx.skills) }, `${name}: version.json nombra los dos commits internos`);
  assert.strictEqual(stamped.stdout, require(EXPORTER).versionFileBytes(file).toString('utf8'), `${name}: sus bytes son los de la función del exportador`);
  assert.strictEqual(file.version.split('.').slice(0, 3).join('.'), new Date(newest * 1000).toISOString().slice(0, 10).replace(/-/g, '.'),
    `${name}: la fecha de la versión es la del commit interno más reciente, en UTC`);
  if (version) assert.strictEqual(file.version, version, `${name}: el número`);
  assert.strictEqual(facts.author, identity, `${name}: el autor es la identidad fija de la copia`);
  assert.strictEqual(facts.committer, identity, `${name}: el committer también`);
  assert.strictEqual(facts.authored, `${newest} +0000`, `${name}: la fecha es la del commit interno más reciente, en UTC`);
  assert.strictEqual(facts.committed, `${newest} +0000`, `${name}: la del committer también`);
  assert.strictEqual(facts.body.trim(), [subject, '',
    `Mirror-Harness-Commit: ${headOf(fx.harness)}`, `Mirror-Agent-Skills-Commit: ${headOf(fx.skills)}`, `Mirror-Tree: ${tree}`].join('\n'), `${name}: el mensaje, con los tres trailers`);
  assert.ok(!gitFx(fx.bare, ['cat-file', 'commit', sha]).includes('gpgsig'), `${name}: sin firma`);
  return facts;
}

/**
 * Una corrida de `sync`, con lo que vale para todas (T14): el `main` del público queda en el mismo sha, y lo que el
 * `--bare` anota como empujado va sólo a la rama de la sincronización.
 */
async function syncRun(fx, args = [], opts = {}) {
  const before = tipOf(fx.bare, MAIN_REF);
  const logged = pushes(fx).length;
  const r = await mirror(fx, ['sync', ...args], { credential: WRITER, ...opts });
  assert.strictEqual(tipOf(fx.bare, MAIN_REF), before, `sync ${args.join(' ')}: el main del público no se mueve\n${r.all}`);
  r.pushed = pushes(fx).slice(logged);
  assert.ok(r.pushed.every((ref) => ref === SYNC_REF), `sync ${args.join(' ')}: sólo se empuja a la rama de la sincronización (${r.pushed.join(', ')})`);
  return r;
}

/** La configuración sintética con un término más en la lista (y su par en la tabla: sin par, el exportador no arranca). */
function withTerm(term, { denied = denylist() } = {}) {
  denied.terminos.push({ patron: term, categoria: 'cliente' });
  const replacements = clone(REPLACEMENTS);
  replacements.pares.push({ real: term, categoria: 'cliente', formas: [{ texto: term, anonimo: 'Otro-Texto' }] });
  return { denied, replacements };
}

/** Una HOME con la configuración de git que rompería todo si el guion la leyera: hooks que fallan, firma obligatoria, otra rama. */
function hostileHome(fx) {
  const home = path.join(fx.dir, 'home');
  const hooks = path.join(home, 'hooks');
  const log = path.join(home, 'hook.log');
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of ['pre-push', 'pre-commit', 'commit-msg', 'pre-receive', 'update', 'post-receive', 'reference-transaction']) {
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\necho ${name} >> "${log}"\nexit 1\n`);
    fs.chmodSync(path.join(hooks, name), 0o755);
  }
  fs.writeFileSync(path.join(home, '.gitconfig'), ['[core]', `\thooksPath = ${hooks}`, '[commit]', '\tgpgsign = true', '[gpg]', '\tprogram = /usr/bin/false',
    '[init]', '\tdefaultBranch = otra', '[push]', '\tdefault = matching', '[user]', '\tname = Persona De La Maquina', '\temail = persona@example.com', ''].join('\n'));
  return { log, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1', TYCON_CODEX: '0' } };
}

// ── T23 · AC 14 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Token_OnlyExplicitNeverInArgsNorDisk', async () => {
  // la cabecera con que git se presenta, con la base por defecto: una entrada de configuración por el ambiente
  assert.deepStrictEqual(require(MIRROR).gitAuth('abc', 'https://github.com'), {
    GIT_ASKPASS: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: authHeader('abc'),
  });

  // sin el token explícito y con credenciales de la máquina en el ambiente: lo que escribe no arranca
  let fx = await fixture();
  seedPublication(fx);
  let github = fakeGit(fx);
  const ambient = { ...github.env, GH_TOKEN: AMBIENT, GITHUB_TOKEN: AMBIENT };
  for (const command of ['first', 'sync']) {
    const r = await mirrorReadOnly(fx, [command], { env: ambient });
    assert.strictEqual(r.code, 2, `${command}: ${r.all}`);
    assert.match(r.err, /falta el token \(TYCON_MIRROR_TOKEN\)/, `${command}: dice qué falta`);
    assert.ok(!r.all.includes(AMBIENT), `${command}: la credencial del ambiente no aparece`);
  }
  assert.deepStrictEqual(fx.api.requests, [], 'ningún pedido a la API');
  assert.deepStrictEqual(remoteCalls(github), [], 'ninguna llamada de git al público');
  // lo que sólo lee sí corre, y esas credenciales no viajan: ni a git ni a la API
  for (const command of ['plan', 'verify']) {
    const r = await mirrorReadOnly(fx, [command, '--json'], { env: ambient });
    assert.strictEqual(r.code, 0, `${command}: ${r.all}`);
    assert.ok(!r.all.includes(AMBIENT), `${command}: la credencial del ambiente no aparece`);
  }
  assert.ok(remoteCalls(github).length >= 2, 'control: git habló con el público');
  assert.ok(gitCalls(github).every((c) => !('GIT_CONFIG_COUNT' in c.env) && !('GIT_CONFIG_VALUE_0' in c.env)), 'git no recibe ninguna cabecera');
  assert.ok(fx.api.requests.length > 0, 'control: verify habló con la API');
  assert.ok(fx.api.requests.every((q) => q.headers.authorization === undefined), 'la API no recibe ninguna credencial');
  assert.ok(!JSON.stringify(fx.api.requests).includes(AMBIENT));

  // con el token explícito: el que escribe lo manda a git por el ambiente y a la API en su cabecera, y a ningún otro lado
  const header = authHeader(WRITER);
  for (const [command, extra] of [['first', ['--json']], ['first', []], ['sync', ['--json']], ['sync', []]]) {
    const name = `${command} ${extra.join(' ')}`;
    fx = await fixture();
    if (command === 'sync') {
      seedPublication(fx);
      write(fx.harness, { 'scripts/nuevo.js': "'use strict';\nmodule.exports = 3;\n" });
      commit(fx.harness, 'un cambio interno');
    }
    const tmp = path.join(fx.dir, 'tmp');
    fs.mkdirSync(tmp);
    github = fakeGit(fx, { requires: WRITER, watch: { dir: tmp, needles: [WRITER, base64(WRITER)] } });
    fx.api.state.credential = WRITER;
    const r = await mirror(fx, [command, ...extra], { credential: WRITER, env: { ...github.env, TMPDIR: tmp, GH_TOKEN: AMBIENT, GITHUB_TOKEN: AMBIENT } });
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.deepStrictEqual(pushes(fx), [command === 'first' ? MAIN_REF : SYNC_REF], `${name}: control, la corrida empujó`);
    // ninguna salida lo trae, ni entero ni en la cabecera
    for (const secret of [WRITER, base64(WRITER), AMBIENT]) assert.ok(!r.all.includes(secret), `${name}: el token no aparece en ninguna salida`);
    // ningún argumento de git lo trae; el ambiente trae la cabecera sólo cuando git habla con el público
    const calls = gitCalls(github);
    const remote = calls.filter((c) => / (ls-remote|fetch|push) /.test(c.args));
    assert.ok(remote.some((c) => / push /.test(c.args)), `${name}: control, hubo un push`);
    for (const c of calls) {
      assert.ok(!c.args.includes(WRITER) && !c.args.includes(base64(WRITER)), `${name}: ningún argumento de git trae el token (${c.args.slice(0, 80)})`);
      assert.ok(!('TYCON_MIRROR_TOKEN' in c.env), `${name}: git no hereda la variable del token`);
      assert.deepStrictEqual(c.disk, [], `${name}: el token no está en ningún archivo del temporal`);
    }
    for (const c of remote) {
      assert.strictEqual(c.env.GIT_CONFIG_COUNT, '1', `${name}: una entrada de configuración por el ambiente`);
      assert.strictEqual(c.env.GIT_CONFIG_KEY_0, `http.file://${fx.github}/.extraheader`, `${name}: para las URL del público`);
      assert.strictEqual(c.env.GIT_CONFIG_VALUE_0, header, `${name}: la cabecera, con el formato que pide git`);
      assert.ok(c.args.includes(' -c credential.helper= '), `${name}: sin ayudante de credenciales`);
    }
    assert.ok(calls.filter((c) => !remote.includes(c)).every((c) => !('GIT_CONFIG_VALUE_0' in c.env)), `${name}: lo que no habla con el público no recibe la cabecera`);
    // ni en un archivo: nada de lo que quedó en el disco lo trae, salvo el git de mentira (que lo busca) y lo que anotó
    const holding = (text) => spawnSync('grep', ['-rlF', '--', text, fx.dir], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
    const fake = path.join(fx.dir, 'bin', 'git');
    assert.deepStrictEqual(holding(WRITER), [fake], `${name}: el token no quedó en ningún archivo de la corrida`);
    assert.deepStrictEqual(holding(base64(WRITER)), [fake, github.log].sort(), `${name}: la cabecera tampoco`);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], `${name}: el temporal de la corrida no queda`);
    // la API lo recibe en su cabecera, y nunca la credencial del ambiente
    assert.ok(fx.api.requests.length > 0 && fx.api.requests.every((q) => q.headers.authorization === `Bearer ${WRITER}`), `${name}: a la API le habla con el token`);
    assert.ok(!JSON.stringify(fx.api.requests).includes(AMBIENT), `${name}: la credencial del ambiente no viaja`);
  }
});

// ── T7 · AC 6 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_First_EmptyRemote_OneRootCommitThenVerify', async () => {
  let fx = await fixture();
  const home = hostileHome(fx);
  const planned = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(planned.json.state, 'unpublished', planned.all);

  const r = await mirror(fx, ['first', '--json'], { credential: WRITER, env: home.env });
  assert.strictEqual(r.code, 0, r.all);
  // main, y ninguna otra ref; un solo commit, sin padre, con el árbol que anunció `plan`
  const tip = tipOf(fx.bare, MAIN_REF);
  assert.strictEqual(refsOf(fx.bare), `${MAIN_REF} ${tip}`, 'main, y ninguna otra ref');
  assert.strictEqual(gitFx(fx.bare, ['rev-list', '--count', '--all']), '1', 'un solo commit');
  assertMirrorCommit(fx, tip, { parents: [], tree: planned.json.tree, subject: 'Primera publicación' }, 'first');
  assert.strictEqual(r.json.outcome, 'published');
  assert.strictEqual(r.json.commit, tip);
  assert.strictEqual(r.json.tree, planned.json.tree);
  // el anotador del --bare ve el empuje (el control positivo de T14), y es uno solo
  assert.deepStrictEqual(pushes(fx), [MAIN_REF]);
  assert.deepStrictEqual(fx.api.writes(), [], 'first no escribe nada por la API');
  // la configuración hostil de la máquina no entró: ni sus hooks, ni su firma, ni su identidad
  assert.ok(!fs.existsSync(home.log), 'ningún hook de la máquina corrió');
  assert.ok(!gitFx(fx.bare, ['cat-file', 'commit', tip]).includes('Persona De La Maquina'));
  // después corrió verify --strict, con el token, y dio 0: ése es el código de first
  assert.strictEqual(r.json.verify.exit, 0);
  assert.strictEqual(r.json.verify.strict, true);
  assert.deepStrictEqual(r.json.verify.findings, []);
  assert.deepStrictEqual(r.json.verify.notMeasured, []);
  assert.ok(fx.api.requests.some((q) => q.path.endsWith('/secret-scanning/alerts') && q.headers.authorization === `Bearer ${WRITER}`), 'verify leyó las alertas con el token');

  // sin --json dice lo mismo: qué publicó y qué dio verify
  fx = await fixture();
  let h = await mirror(fx, ['first'], { credential: WRITER });
  assert.strictEqual(h.code, 0, h.all);
  assert.match(h.out, /mirror first: publicado/);
  assert.ok(h.out.includes(tipOf(fx.bare, MAIN_REF).slice(0, 12)), 'dice el commit');
  assert.match(h.out, /mirror verify:/, 'y trae lo que miró verify');

  // el código de first es el de verify --strict: con un hallazgo, 1 — y lo publicado, publicado está
  fx = await fixture();
  fx.api.state.vulnerabilityReporting = { enabled: false };
  h = await mirror(fx, ['first', '--json'], { credential: WRITER });
  assert.strictEqual(h.code, 1, h.all);
  assert.strictEqual(h.json.verify.exit, 1);
  assert.deepStrictEqual(h.json.verify.findings.map((f) => f.part), ['h']);
  assert.strictEqual(h.json.commit, tipOf(fx.bare, MAIN_REF), 'main quedó publicado');
  assert.match(h.err, /publicado/, 'dice que la publicación está hecha');
  // y es estricto: algo sin medir es 2
  fx = await fixture();
  fx.api.override = (q) => (q.path.includes('secret-scanning') ? { status: 403, json: { message: 'Resource not accessible by integration' } } : null);
  h = await mirror(fx, ['first', '--json'], { credential: WRITER });
  assert.strictEqual(h.code, 2, h.all);
  assert.deepStrictEqual(h.json.verify.notMeasured.map((n) => n.part), ['g']);
  assert.ok(tipOf(fx.bare, MAIN_REF), 'main quedó publicado');

  // el mensaje del commit pasa por la lista antes de empujar: con un término, 1 sin escribir nada
  fx = await fixture();
  fx.config(withTerm('Mirror-Tree'));
  h = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(h.code, 1, h.all);
  assert.match(h.err, /el mensaje del commit/, 'dice dónde');
  assert.match(h.err, /cliente/, 'y la categoría');
  assert.doesNotMatch(h.all, /Mirror-Tree/, 'no lo hallado');
});

// ── T8 · AC 6 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_First_RemoteWithRefs_Exit2', async () => {
  // una rama cualquiera
  let fx = await fixture();
  publicCommit(fx, { files: { 'README.md': '# Algo\n' }, message: 'Una rama cualquiera', ref: 'refs/heads/otra' });
  let r = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /ya tiene 1 ref/);
  assert.match(r.err, /sync/, 'dice qué sigue');
  // un tag solo también es una ref
  fx = await fixture();
  const loose = publicCommit(fx, { files: { 'README.md': '# Algo\n' }, message: 'Un commit suelto', ref: null });
  gitFx(fx.bare, ['tag', 'v0', loose]);
  r = await mirrorReadOnly(fx, ['first', '--json'], { credential: WRITER });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.json.message, /ya tiene 1 ref/);
  // y lo ya publicado no se pisa
  fx = await fixture();
  seedPublication(fx);
  r = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /ya tiene/);
  assert.deepStrictEqual(fx.api.requests, [], 'ni un pedido a la API');

  // el repo deja de estar vacío entre la lectura y el push (otra corrida publicó antes): tampoco se pisa
  fx = await fixture();
  const theirs = publicCommit(fx, { files: { 'README.md': '# Lo de la otra corrida\n' }, message: 'Primera publicación, de otra corrida', ref: null });
  const github = fakeGit(fx, { onPush: (git) => [`${git} -C "${fx.bare}" update-ref ${MAIN_REF} ${theirs}`] });
  r = await mirror(fx, ['first'], { credential: WRITER, env: github.env });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /dejó de estar vacío/);
  assert.strictEqual(remoteCalls(github, 'push').length, 1, 'un solo intento');
  assert.strictEqual(tipOf(fx.bare, MAIN_REF), theirs, 'main queda con lo que publicó la otra corrida');
  assert.deepStrictEqual(pushes(fx), [], 'nada de esta corrida llegó');
});

// ── la sincronización ──────────────────────────────────────────────────────────────────────────────────────────────
let changeCount = 0;
/** Un cambio en el arnés interno de mentira, commiteado: por defecto, un archivo nuevo que sale en la copia. */
function internalChange(fx, files) {
  changeCount += 1;
  write(fx.harness, files || { [`scripts/cambio-${changeCount}.js`]: `'use strict';\nmodule.exports = ${changeCount};\n` });
  return commit(fx.harness, `un cambio interno (${changeCount})`);
}

/** Una fixture ya publicada (como la deja `first`) y, salvo que se pida que no, con un cambio interno sin sincronizar. */
async function published({ change = true } = {}) {
  const fx = await fixture();
  const seed = seedPublication(fx);
  if (change) internalChange(fx);
  return { fx, seed };
}

const openPulls = (fx) => fx.api.state.pulls.filter((p) => p.state === 'open');
const writesOf = (fx) => fx.api.writes().map((q) => `${q.method} ${q.path.replace(/^\/repos\/[^/]+\/[^/]+/, '')}`);

/** Lo que hace una persona en GitHub: mergea el pull request de la sincronización, con un commit de merge. */
function mergeSync(fx) {
  const sync = tipOf(fx.bare, SYNC_REF);
  const merged = publicCommit(fx, { parents: [tipOf(fx.bare, MAIN_REF), sync], from: sync, message: 'Merge pull request #1 from example-org/mirror/sync' });
  for (const pr of openPulls(fx)) pr.state = 'closed';
  return merged;
}

/** Una corrida de `sync` que no puede haber escrito nada: ni un push, ni la rama, ni un pedido de escritura a la API. */
async function syncWithoutWrites(fx, args = [], opts = {}) {
  const branch = tipOf(fx.bare, SYNC_REF);
  const written = fx.api.writes().length;
  const r = await syncRun(fx, args, opts);
  assert.deepStrictEqual(r.pushed, [], `sync ${args.join(' ')}: ningún push\n${r.all}`);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), branch, `sync ${args.join(' ')}: la rama de la sincronización, como estaba`);
  assert.strictEqual(fx.api.writes().length, written, `sync ${args.join(' ')}: ningún pedido de escritura a la API`);
  return r;
}

// ── T9 · AC 7 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_RulesMissing_Exit2NoPush', async () => {
  const { fx } = await published();
  const without = (type) => (s) => { s.rules = s.rules.filter((rule) => rule.type !== type); };
  const inRule = (type, change) => (s) => { change(s.rules.find((rule) => rule.type === type).parameters); };
  const allow = ['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge'];
  // [el caso, cómo queda la API, lo que el mensaje tiene que nombrar, cuántas cosas faltan]
  const cases = [
    ['sin pull_request', without('pull_request'), /falta la regla pull_request/, 1],
    ['con 0 aprobaciones', inRule('pull_request', (p) => { p.required_approving_review_count = 0; }), /required_approving_review_count/, 1],
    ['sin la cuenta de aprobaciones', inRule('pull_request', (p) => { delete p.required_approving_review_count; }), /required_approving_review_count/, 1],
    ['sin dismiss_stale_reviews_on_push', inRule('pull_request', (p) => { delete p.dismiss_stale_reviews_on_push; }), /dismiss_stale_reviews_on_push/, 1],
    ['con dismiss_stale_reviews_on_push apagado', inRule('pull_request', (p) => { p.dismiss_stale_reviews_on_push = false; }), /dismiss_stale_reviews_on_push/, 1],
    ['sin require_last_push_approval', inRule('pull_request', (p) => { p.require_last_push_approval = false; }), /require_last_push_approval/, 1],
    ['sin non_fast_forward', without('non_fast_forward'), /non_fast_forward/, 1],
    ['sin deletion', without('deletion'), /deletion/, 1],
    ['sin required_status_checks', without('required_status_checks'), /required_status_checks/, 1],
    ['con required_status_checks sin ningún chequeo', inRule('required_status_checks', (p) => { p.required_status_checks = []; }), /required_status_checks/, 1],
    ['con squash permitido', (s) => { s.repo.allow_squash_merge = true; }, /allow_squash_merge/, 1],
    ['con rebase permitido', (s) => { s.repo.allow_rebase_merge = true; }, /allow_rebase_merge/, 1],
    ['sin commits de merge', (s) => { s.repo.allow_merge_commit = false; }, /allow_merge_commit/, 1],
    ['sin los campos allow_*', (s) => { for (const k of allow) delete s.repo[k]; }, /no trae allow_merge_commit[\s\S]*no trae allow_squash_merge[\s\S]*no trae allow_rebase_merge/, 3],
    ['con mirror/sync como rama por defecto', (s) => { s.repo.default_branch = 'mirror/sync'; }, /rama por defecto/, 1],
    ['sin la rama por defecto en la respuesta', (s) => { delete s.repo.default_branch; }, /default_branch/, 1],
    ['sin nada', (s) => { s.rules = [{ type: 'creation' }]; s.repo.allow_squash_merge = true; }, /pull_request[\s\S]*non_fast_forward[\s\S]*deletion[\s\S]*required_status_checks[\s\S]*allow_squash_merge/, 5],
  ];
  for (const [name, mutate, reason, missing] of cases) {
    fx.api.reset();
    mutate(fx.api.state);
    const r = await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 2, `${name}: sale 2\n${r.all}`);
    assert.match(r.err, reason, `${name}: nombra lo que falta`);
    assert.strictEqual(r.err.split('\n').filter((l) => l.startsWith('  · ')).length, missing, `${name}: nombra sólo lo que falta\n${r.err}`);
    assert.ok(fx.api.requests.some((q) => q.path.endsWith('/rules/branches/main')), `${name}: leyó las reglas activas de main`);
  }
  // con la lista de reglas vacía, el mensaje del ruleset
  fx.api.reset();
  fx.api.state.rules = [];
  let r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.ok(r.err.includes('sin ruleset: una protección clásica de rama no cuenta, hace falta un ruleset (TH6)'), r.err);
  // en --json, lo que falta va en una lista
  fx.api.reset();
  fx.api.state.rules = fx.api.state.rules.filter((rule) => rule.type !== 'deletion');
  r = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(r.code, 2, r.all);
  assert.strictEqual(r.json.rules.missing.length, 1);
  assert.match(r.json.rules.missing[0], /deletion/);
  // lo que no se pudo leer no se da por bueno: la API contesta mal, contesta otra cosa, o no contesta
  const unreadable = [
    ['las reglas, 500', (q) => (q.path.endsWith('/rules/branches/main') ? { status: 500, json: {} } : null)],
    ['las reglas, algo que no es una lista', (q) => (q.path.endsWith('/rules/branches/main') ? { status: 200, json: { message: 'otra cosa' } } : null)],
    ['las reglas, algo que no es JSON', (q) => (q.path.endsWith('/rules/branches/main') ? { status: 200, raw: '<html>' } : null)],
    ['los datos del repo, 404', (q) => (/^\/repos\/[^/]+\/[^/]+$/.test(q.path) ? { status: 404, json: {} } : null)],
  ];
  for (const [name, override] of unreadable) {
    fx.api.reset();
    fx.api.override = override;
    r = await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 2, `${name}: sale 2\n${r.all}`);
    assert.match(r.err, /la API contestó|no contestó una lista/, `${name}: dice que no pudo leer`);
  }
  fx.api.reset();
  r = await syncWithoutWrites(fx, [], { env: { TYCON_MIRROR_API_URL: `http://127.0.0.1:${await closedPort()}` } });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude hablar con la API/);

  // control: con las reglas en su lugar, esa misma corrida empuja — y las leyó antes de empujar
  fx.api.reset();
  r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.ok(/^\/repos\/[^/]+\/[^/]+$/.test(fx.api.requests[0].path) && fx.api.requests[1].path.endsWith('/rules/branches/main'),
    'antes de empujar pregunta si el repo es privado y, como es público, las reglas');
  // varias reglas del mismo tipo (dos rulesets activos) valen juntas: alcanza con que una pida cada cosa
  fx.api.reset();
  internalChange(fx);
  fx.api.state.rules = [{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }, ...FULL_RULES()];
  r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
});

test('Mirror_Sync_PrivateRepo_NoRulesRequired', async () => {
  // 2026-10-06 (decisión del dueño): con el repo PRIVADO no se exige ninguna regla. GitHub Free no las admite en un
  // privado (la API de reglas contesta 403) y el único que escribe es el dueño: exigirlas frenaba toda sincronización
  // y obligaba a recrear el repo por cualquier cambio.
  const { fx } = await published();
  fx.api.reset();
  internalChange(fx);
  fx.api.state.repo.private = true;
  fx.api.state.rules = [];
  fx.api.state.repo.allow_squash_merge = true;
  fx.api.override = (q) => (q.path.endsWith('/rules/branches/main') ? { status: 403, json: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } } : null);
  const r = await syncRun(fx);
  assert.strictEqual(r.code, 0, `privado, sin reglas y con la API de reglas en 403: empuja igual\n${r.all}`);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.ok(!fx.api.requests.some((q) => q.path.endsWith('/rules/branches/main')), 'ni pregunta por las reglas');
  // el mismo repo, público: vuelven a exigirse
  fx.api.reset();
  internalChange(fx);
  fx.api.state.repo.private = false;
  fx.api.state.rules = [];
  const pub = await syncWithoutWrites(fx);
  assert.strictEqual(pub.code, 2, `público y sin reglas: no empuja\n${pub.all}`);
});

// ── T10 · AC 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_ForeignChangeNotAbsorbed_Exit1', async () => {
  const { fx, seed } = await published();
  const foreign = publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  let r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.match(r.err, /cambios ajenos sin traer/);
  assert.ok(r.err.includes(`· ${foreign} — docs/ajeno.md`), `el sha entero, con su ruta\n${r.err}`);
  // en esta tanda: la marca que lo resuelve, y el aviso de que los dos comandos que la escriben todavía no existen
  assert.ok(r.err.includes(`Public-Commit: ${foreign}`), 'la marca, con el sha');
  assert.match(r.err, /import --commit/);
  assert.match(r.err, /--discard/);
  assert.match(r.err, /llegan con la tanda C/);
  assert.ok(r.err.includes('guides/publicacion-espejo.md, §«Cambios ajenos»'), 'remite a la guía');
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), '', 'la rama no se creó');
  assert.deepStrictEqual(openPulls(fx), [], 'ni se abrió nada');

  r = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.strictEqual(r.json.outcome, 'foreign-changes');
  assert.strictEqual(r.json.state, 'foreign-changes');
  assert.deepStrictEqual(r.json.foreign, [{ commit: foreign, paths: ['docs/ajeno.md'], absorbed: false, discarded: false }]);

  // con una sincronización abierta de antes, tampoco la toca
  const { fx: other } = await published();
  r = await syncRun(other);
  assert.strictEqual(r.code, 0, r.all);
  const before = clone(other.api.state.pulls);
  publicCommit(other, { parents: [tipOf(other.bare, MAIN_REF)], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  internalChange(other);
  r = await syncWithoutWrites(other);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(other.api.state.pulls, before, 'el pull request abierto queda como estaba');
});

// ── T11 · AC 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_ForeignAbsorbedThenNewChange_Heals', async () => {
  const fixedInGithub = '# Guía\n\nSegunda versión, corregida en GitHub.\n';
  for (const discard of [false, true]) {
    const name = discard ? 'descartado' : 'traído';
    const { fx, seed } = await published({ change: false });
    const internal = gitFx(fx.harness, ['show', 'HEAD:guides/guia.md']);
    // alguien mergea en GitHub un cambio que no salió del interno
    const foreign = publicCommit(fx, { parents: [seed.commit], files: { 'guides/guia.md': fixedInGithub }, message: 'Un cambio mergeado en GitHub' });
    let r = await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 1, `${name}, control: sin absorber frena\n${r.all}`);

    // el interno lo absorbe: un commit en una rama con la marca ESCRITA A MANO (la que va a escribir `import`), y su merge
    gitFx(fx.harness, ['checkout', '-q', '-b', 'absorber']);
    if (discard) {
      commit(fx.harness, `chore: descarta un cambio ajeno del repo público\n\nPublic-Commit: ${foreign}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
    } else {
      write(fx.harness, { 'guides/guia.md': fixedInGithub });
      commit(fx.harness, `fix: trae la corrección del repo público\n\nPublic-Commit: ${foreign}`);
    }
    gitFx(fx.harness, ['checkout', '-q', 'main']);
    const date = nextDate();
    gitFx(fx.harness, ['merge', '-q', '--no-ff', '-m', 'Merge de la rama que absorbe el cambio', 'absorber'], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    // y después, otro cambio interno
    internalChange(fx, { 'scripts/despues.js': "'use strict';\nmodule.exports = 9;\n" });

    r = await syncRun(fx, ['--json']);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.deepStrictEqual(r.pushed, [SYNC_REF], `${name}: empuja`);
    assert.deepStrictEqual(r.json.foreign, [{ commit: foreign, paths: ['guides/guia.md'], absorbed: true, discarded: discard }], name);
    // el commit nuevo: padre = la punta pública (que ya contiene el cambio ajeno), árbol = la exportación
    const branch = tipOf(fx.bare, SYNC_REF);
    assertMirrorCommit(fx, branch, { parents: [foreign], tree: r.json.tree, subject: 'Sincronización' }, name);
    assert.strictEqual(gitFx(fx.bare, ['show', `${branch}:scripts/despues.js`]), "'use strict';\nmodule.exports = 9;", `${name}: trae el cambio interno`);
    // el interno es la fuente: traído, queda la corrección; descartado, el público vuelve a lo del interno
    assert.strictEqual(`${gitFx(fx.bare, ['show', `${branch}:guides/guia.md`])}\n`, discard ? `${internal}\n` : fixedInGithub, name);
    assert.strictEqual(openPulls(fx).length, 1, `${name}: abre el pull request`);
    assert.strictEqual(r.json.pullRequest.action, 'created', name);

    // mergeado en el público, la corrida siguiente dice «sin cambios»
    mergeSync(fx);
    r = await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.match(r.out, /sin cambios/, name);
  }
});

// ── T12 · AC 9 ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_SameTreeOrUnpublished_NoOp', async () => {
  // un repo sin refs: todavía no publicado
  let fx = await fixture();
  let r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.ok(r.out.includes('todavía no publicado: corré `first`'), r.all);
  assert.strictEqual(refsOf(fx.bare), '', 'el repo sigue sin refs');
  assert.deepStrictEqual(fx.api.requests, [], 'ni un pedido a la API');
  r = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.outcome, 'unpublished');
  assert.strictEqual(r.json.message, 'todavía no publicado: corré `first`');

  // el árbol igual al del público, sin nada abierto: sin cambios, y nada más
  ({ fx } = await published({ change: false }));
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /sin cambios/);

  // con un pull request abierto desde mirror/sync: lo cierra con el comentario. Uno de otra rama no se toca,
  // aunque la API lo devuelva sin que se lo pidan
  const stale = () => [
    { number: 4, state: 'open', title: 'Sincronización', body: 'Lo de antes', head: { ref: 'mirror/sync' }, base: { ref: 'main' } },
    { number: 5, state: 'open', title: 'De otra rama', body: '', head: { ref: 'otra-rama' }, base: { ref: 'main' } },
    { number: 6, state: 'open', title: 'Del fork de alguien', body: '', head: { ref: 'mirror/sync', label: 'alguien:mirror/sync' }, base: { ref: 'main' } },
  ];
  fx.api.state.pulls = stale();
  fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') ? { status: 200, json: fx.api.state.pulls.filter((p) => p.state === 'open') } : null);
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [], 'no empuja');
  assert.strictEqual(r.json.outcome, 'unchanged');
  assert.strictEqual(r.json.message, 'sin cambios');
  assert.deepStrictEqual(r.json.pullRequest, { number: 4, action: 'closed' });
  assert.deepStrictEqual(writesOf(fx), ['POST /issues/4/comments', 'PATCH /pulls/4'], 'el comentario, y después el cierre');
  assert.match(fx.api.writes()[0].body.body, /ya no hay diferencias con el interno/);
  assert.deepStrictEqual(fx.api.writes()[1].body, { state: 'closed' });
  assert.deepStrictEqual(fx.api.state.pulls.map((p) => p.state), ['closed', 'open', 'open']);
  // sin --json también lo dice; y la corrida siguiente ya no tiene nada que cerrar
  fx.api.reset();
  fx.api.state.pulls = stale().slice(0, 1);
  r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /sin cambios/);
  assert.match(r.out, /pull request nº 4.*cerrado/);
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 0, r.all);

  // si no puede leer los pull requests abiertos, no decide nada: 2
  fx.api.reset();
  fx.api.state.pulls = stale().slice(0, 1);
  fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') ? { status: 500, json: {} } : null);
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /pull requests abiertos/);
});

// ── T13 · AC 10 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_Changes_DeterministicCommitOnPublicTip', async () => {
  const { fx, seed } = await published();
  const one = await syncRun(fx, ['--json'], { env: { TZ: 'Pacific/Kiritimati', LANG: 'C', LC_ALL: 'C' } });
  assert.strictEqual(one.code, 0, one.all);
  assert.strictEqual(one.json.outcome, 'synced');
  assert.deepStrictEqual(one.pushed, [SYNC_REF]);
  assert.strictEqual(one.json.pushed, true);
  // el commit de la rama: padre = la punta pública, árbol = la exportación, identidad, fecha y trailers fijos
  const branch = tipOf(fx.bare, SYNC_REF);
  assert.strictEqual(one.json.commit, branch);
  assert.strictEqual(one.json.publicTip, seed.commit);
  assertMirrorCommit(fx, branch, { parents: [seed.commit], tree: one.json.tree, subject: 'Sincronización' }, 'sync');
  assert.notStrictEqual(one.json.tree, seed.tree, 'control: el árbol cambió');

  // la segunda, con otro huso, otro idioma y otra máscara de permisos: el mismo commit, y no empuja ni escribe
  const written = fx.api.writes().length;
  const two = await syncRun(fx, ['--json'], { env: { TZ: 'America/Anchorage', LANG: 'es_AR.UTF-8', LC_ALL: 'es_AR.UTF-8' }, umask: '077' });
  assert.strictEqual(two.code, 0, two.all);
  assert.strictEqual(two.json.commit, branch, 'mismos commits internos y misma punta pública: el mismo commit');
  assert.deepStrictEqual(two.pushed, [], 'la segunda no empuja');
  assert.strictEqual(two.json.pushed, false);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), branch);
  assert.strictEqual(fx.api.writes().length, written, 'ni toca el pull request: ya dice lo mismo');
  assert.deepStrictEqual(two.json.pullRequest, { number: 1, action: 'unchanged' });

  // y si la rama no estuviera, vuelve a armar exactamente ese commit
  gitFx(fx.bare, ['update-ref', '-d', SYNC_REF]);
  const three = await syncRun(fx, ['--json'], { env: { TZ: 'UTC', LANG: 'en_US.UTF-8' }, umask: '002' });
  assert.strictEqual(three.code, 0, three.all);
  assert.deepStrictEqual(three.pushed, [SYNC_REF]);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), branch, 'el mismo sha en una corrida aparte');

  // otra punta pública (alguien mergeó la sincronización) u otros commits internos: otro commit
  mergeSync(fx);
  internalChange(fx);
  const four = await syncRun(fx, ['--json']);
  assert.strictEqual(four.code, 0, four.all);
  assert.notStrictEqual(four.json.commit, branch);
  assert.deepStrictEqual(commitFacts(fx.bare, four.json.commit).parents, [tipOf(fx.bare, MAIN_REF)]);
});

// ── T14 · AC 1, 10 ─────────────────────────────────────────────────────────────────────────────────────────────────
// Cada caso de sincronización de esta suite pasa por `syncRun`, que comprueba que `main` no se movió y que lo empujado
// fue sólo a la rama de la sincronización. Acá, el control positivo —el anotador sí ve un empuje a `main` cuando lo
// hay— y el recorrido entero sobre un mismo repo.
test('Mirror_Sync_NeverWritesPublicMain', async () => {
  const fx = await fixture();
  let r = await mirror(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(pushes(fx), [MAIN_REF], 'control: el anotador del --bare ve el empuje de first a main');
  const main = tipOf(fx.bare, MAIN_REF);

  r = await syncRun(fx);                       // sin cambios
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, []);
  internalChange(fx);
  r = await syncRun(fx);                       // con cambios: crea la rama
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  r = await syncRun(fx);                       // repetida
  assert.deepStrictEqual(r.pushed, []);
  internalChange(fx);
  r = await syncRun(fx);                       // con más cambios: reemplaza la rama
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  internalChange(fx, { 'guides/guia.md': null });
  r = await syncRun(fx, ['--json']);           // con borrados
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  r = await mirror(fx, ['first'], { credential: WRITER });   // y `first` otra vez no publica dos veces
  assert.strictEqual(r.code, 2, r.all);

  assert.strictEqual(tipOf(fx.bare, MAIN_REF), main, 'main quedó donde lo dejó first');
  assert.deepStrictEqual(pushes(fx), [MAIN_REF, SYNC_REF, SYNC_REF, SYNC_REF], 'todo lo empujado después de first fue a la rama de la sincronización');
  assert.deepStrictEqual(refsOf(fx.bare).split('\n').map((l) => l.split(' ')[0]), [MAIN_REF, SYNC_REF], 'y no hay ninguna otra ref');
  assert.deepStrictEqual(commitFacts(fx.bare, tipOf(fx.bare, SYNC_REF)).parents, [main], 'la rama sale de main');

  // en el código: dos lugares empujan, cada uno con su ref escrita adentro, y main está en uno solo
  const sites = fs.readFileSync(MIRROR, 'utf8').split('\n').filter((l) => l.includes("['push'"));
  assert.strictEqual(sites.length, 2, sites.join('\n'));
  assert.strictEqual(sites.filter((l) => l.includes(':${MAIN}`')).length, 1, 'un solo lugar empuja a main');
  assert.strictEqual(sites.filter((l) => l.includes(':${SYNC}`')).length, 1, 'el otro, a la rama de la sincronización');
});

// ── T15 · AC 10, 12 ────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_NewerSyncOnBranch_NoRegression', async () => {
  const { fx } = await published({ change: false });
  const oldSkills = headOf(fx.skills);
  write(fx.skills, { 'skills/tycon-pipeline/tercero.md': '# Tercero\n' });
  commit(fx.skills, 'un cambio interno más nuevo');
  let r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  const newer = tipOf(fx.bare, SYNC_REF);
  const pulls = clone(fx.api.state.pulls);
  assert.strictEqual(pulls.length, 1);

  // una corrida vieja, con el agent-skills de antes: lo suyo ya está publicado, pero la rama trae algo más nuevo
  r = await syncWithoutWrites(fx, ['--agent-skills', oldSkills]);
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /hay una sincronización más nueva/);
  r = await syncWithoutWrites(fx, ['--agent-skills', oldSkills, '--json']);
  assert.strictEqual(r.json.outcome, 'newer-sync');
  assert.strictEqual(r.json.message, 'hay una sincronización más nueva');
  assert.strictEqual(r.json.syncTip, newer);
  // una corrida vieja con cambios propios (el arnés nuevo, el agent-skills viejo): tampoco la pisa
  internalChange(fx);
  r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF], 'control: la corrida con todo lo nuevo sí reemplaza la rama');
  const newest = tipOf(fx.bare, SYNC_REF);
  const body = fx.api.state.pulls[0].body;
  r = await syncWithoutWrites(fx, ['--agent-skills', oldSkills]);
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /hay una sincronización más nueva/);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), newest, 'la rama queda con lo nuevo');
  assert.strictEqual(fx.api.state.pulls[0].body, body, 'y el pull request también');
  assert.strictEqual(openPulls(fx).length, 1);

  // la carrera: la vieja leyó la rama cuando todavía no estaba, y la nueva llega justo antes de su push
  gitFx(fx.bare, ['update-ref', '-d', SYNC_REF]);
  const github = fakeGit(fx, { onPush: (git) => [`${git} -C "${fx.bare}" update-ref ${SYNC_REF} ${newest}`] });
  r = await syncRun(fx, ['--agent-skills', oldSkills], { env: github.env });
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /hay una sincronización más nueva/);
  assert.strictEqual(remoteCalls(github, 'push').length, 1, 'perdió el lease, releyó y no volvió a empujar');
  assert.deepStrictEqual(r.pushed, [], 'nada llegó al público');
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), newest, 'la rama queda con lo nuevo');
  assert.strictEqual(fx.api.state.pulls[0].body, body, 'y el pull request también');

  // lo que NO es más nuevo se reemplaza: una rama con el arnés de antes y el agent-skills de después (ni lo uno ni lo otro)
  const { fx: mixed, seed } = await published({ change: false });
  const before = { harness: headOf(mixed.harness), skills: headOf(mixed.skills) };
  write(mixed.skills, { 'skills/tycon-pipeline/tercero.md': '# Tercero\n' });
  const after = commit(mixed.skills, 'agent-skills avanza');
  internalChange(mixed);
  syncCommit(mixed, { ...seed, harness: before.harness, skills: after }, { parent: seed.commit, files: { 'docs/de-antes.md': '# De antes\n' }, ref: SYNC_REF });
  r = await syncRun(mixed, ['--agent-skills', before.skills]);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF], 'ni igual ni descendiente en los dos: no es más nueva, se reemplaza');
  // una rama que no trae una sincronización (alguien empujó otra cosa) también se reemplaza
  const { fx: odd, seed: oddSeed } = await published();
  publicCommit(odd, { parents: [oddSeed.commit], files: { 'docs/otra-cosa.md': '# Otra cosa\n' }, message: 'Algo que no es una sincronización', ref: SYNC_REF });
  r = await syncRun(odd);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  // tampoco alcanza con copiar los trailers de una sincronización más nueva: el del árbol tiene que ser el suyo
  write(odd.skills, { 'skills/tycon-pipeline/tercero.md': '# Tercero\n' });
  const ahead = commit(odd.skills, 'agent-skills avanza');
  publicCommit(odd, {
    parents: [oddSeed.commit], files: { 'docs/falso.md': '# Falso\n' }, ref: SYNC_REF,
    message: `Sincronización\n\n${trailers({ ...oddSeed, harness: headOf(odd.harness), skills: ahead })}`,
  });
  r = await syncRun(odd, ['--agent-skills', oddSeed.skills]);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF], 'una rama con trailers copiados no es una sincronización: se reemplaza');
  // y una sincronización de un commit interno que este clon no conoce no se pisa ni se da por vieja: 2
  const { fx: unknown, seed: unknownSeed } = await published();
  syncCommit(unknown, { ...unknownSeed, harness: 'f'.repeat(40) }, { parent: unknownSeed.commit, files: { 'docs/de-otro-clon.md': '# De otro clon\n' }, ref: SYNC_REF });
  r = await syncWithoutWrites(unknown);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /este clon no conoce/);
});

// ── T16 · AC 11 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_OpensUpdatesReopensOnePr', async () => {
  const { fx } = await published({ change: false });
  const short = (dir) => headOf(dir).slice(0, 12);
  // la primera, con cambios: crea el pull request
  internalChange(fx, { 'scripts/nuevo.js': "'use strict';\nmodule.exports = 3;\n", 'guides/guia.md': '# Guía\n\nTercera versión.\n', 'scripts/hola.js': null });
  let r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'created' });
  assert.deepStrictEqual(writesOf(fx), ['POST /pulls']);
  const created = fx.api.writes()[0].body;
  assert.deepStrictEqual(Object.keys(created).sort(), ['base', 'body', 'head', 'title']);
  assert.strictEqual(created.head, 'mirror/sync', 'desde la rama de la sincronización');
  assert.strictEqual(created.base, 'main', 'hacia main');
  assert.ok(created.title.length > 0);
  // el cuerpo: los shas internos cortos, la cuenta y las rutas
  for (const text of [short(fx.harness), short(fx.skills), '1 agregado(s), 1 modificado(s), 1 borrado(s)', 'scripts/nuevo.js', 'guides/guia.md', 'scripts/hola.js']) {
    assert.ok(created.body.includes(text), `el cuerpo trae «${text}»\n${created.body}`);
  }
  assert.strictEqual(openPulls(fx).length, 1);
  const firstHarness = short(fx.harness);

  // la segunda, con otro cambio: actualiza ese mismo
  internalChange(fx, { 'scripts/otro.js': "'use strict';\nmodule.exports = 4;\n" });
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'updated' });
  assert.deepStrictEqual(writesOf(fx), ['POST /pulls', 'PATCH /pulls/1']);
  assert.strictEqual(fx.api.state.pulls.length, 1, 'no creó otro');
  const updated = fx.api.state.pulls[0].body;
  for (const text of [short(fx.harness), '2 agregado(s), 1 modificado(s), 1 borrado(s)', 'scripts/otro.js', 'scripts/nuevo.js']) {
    assert.ok(updated.includes(text), `el cuerpo actualizado trae «${text}»\n${updated}`);
  }
  assert.ok(!updated.includes(firstHarness), 'y ya no el sha de la corrida anterior');

  // la tercera, con el mismo commit, después de que alguien cerró el pull request a mano: crea uno nuevo sin empujar
  fx.api.state.pulls[0].state = 'closed';
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [], 'sin empujar: la rama ya tiene ese commit');
  assert.strictEqual(r.json.pushed, false);
  assert.deepStrictEqual(r.json.pullRequest, { number: 2, action: 'created' });
  assert.deepStrictEqual(fx.api.state.pulls.map((p) => p.state), ['closed', 'open'], 'nunca hay dos abiertos');
  assert.strictEqual(fx.api.state.pulls[1].body, updated, 'con el mismo cuerpo');
  // y la cuarta no toca nada
  r = await syncWithoutWrites(fx, ['--json']);
  assert.deepStrictEqual(r.json.pullRequest, { number: 2, action: 'unchanged' });
  // sin --json dice qué pull request es
  r = await syncWithoutWrites(fx);
  assert.match(r.out, /pull request nº 2/);

  // muchas rutas: la cuenta entera y hasta 50 rutas en el cuerpo
  const many = {};
  for (let i = 0; i < 60; i++) many[`guides/muchas/nota-${String(i).padStart(2, '0')}.md`] = `# Nota ${i}\n`;
  internalChange(fx, many);
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  const long = fx.api.state.pulls[1].body;
  assert.ok(long.includes('62 agregado(s)'), long);
  assert.strictEqual(long.split('\n').filter((l) => /^[+~-] /.test(l)).length, 50, 'hasta 50 rutas');
  assert.match(long, /y 14 más/);

  // otra corrida abrió el pull request entre la lista y el pedido (la API contesta 422 al crear): lo vuelve a leer y
  // actualiza ése, sin crear otro
  fx.api.state.pulls[1].state = 'closed';
  fx.api.override = (q) => {
    if (q.method !== 'POST' || !q.path.endsWith('/pulls')) return null;
    fx.api.state.pulls.push({ number: 3, state: 'open', title: 'El de la otra corrida', body: 'Lo que escribió la otra corrida', head: { ref: 'mirror/sync' }, base: { ref: 'main' } });
    return { status: 422, json: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] } };
  };
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.pullRequest, { number: 3, action: 'updated' });
  assert.strictEqual(openPulls(fx).length, 1, 'un solo pull request abierto');
  assert.strictEqual(fx.api.state.pulls[2].body, long);
  // un 422 que no es eso (no aparece ninguno abierto): 2, sin inventar nada
  fx.api.state.pulls[2].state = 'closed';
  fx.api.override = (q) => (q.method === 'POST' && q.path.endsWith('/pulls') ? { status: 422, json: { message: 'Validation Failed' } } : null);
  r = await syncRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /la API contestó 422 al crear el pull request/);
  assert.deepStrictEqual(openPulls(fx), []);
});

// ── T17 · AC 11 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_DeniedTermInPrText_Exit1NoApiWrite', async () => {
  // una ruta cambiada con un término de la lista en su nombre, que la copia deja pasar por una excepción por ruta
  let { fx } = await published({ change: false });
  const rel = `guides/${TERM}/nota.md`;
  internalChange(fx, { [rel]: '# Nota\n' });
  const denied = denylist();
  denied.permitidos.push({ archivo: 'rutas-de-la-copia.txt', motivo: 'laboratorio: una ruta con un nombre de la lista' });
  fx.config({ denied });
  const planned = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(planned.code, 0, `control: el exportador la deja pasar\n${planned.all}`);
  assert.deepStrictEqual(planned.json.paths, [{ status: 'added', path: rel }], 'control: la ruta sale con el nombre');
  let r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.match(r.err, /el cuerpo del pull request/, 'dice dónde');
  assert.match(r.err, /\[cliente\]/, 'y la categoría');
  assert.ok(!r.all.includes(TERM), `no lo hallado\n${r.all}`);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), '', 'antes de escribir: la rama no existe');
  r = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.ok(r.json.textFindings.some((f) => f.what === 'el cuerpo del pull request' && f.category === 'cliente'), JSON.stringify(r.json.textFindings));
  assert.ok(!r.all.includes(TERM));

  // los demás textos se revisan igual: el título, el mensaje del commit, y el comentario con que se cierra
  const texts = fs.readFileSync(MIRROR, 'utf8');
  for (const [term, where] of [['Mirror-Tree', /el mensaje del commit/], [PR_TITLE, /el título del pull request/]]) {
    ({ fx } = await published());
    fx.config(withTerm(term));
    r = await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 1, `${term}: ${r.all}`);
    assert.match(r.err, where, `${term}: dice dónde`);
    assert.ok(texts.includes(term), `control: «${term}» es un texto del guion`);
  }
  ({ fx } = await published({ change: false }));
  fx.api.state.pulls = [{ number: 4, state: 'open', title: 'Sincronización', body: 'Lo de antes', head: { ref: 'mirror/sync' }, base: { ref: 'main' } }];
  fx.config(withTerm('diferencias con el interno'));
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.match(r.err, /el comentario/);
  assert.strictEqual(openPulls(fx).length, 1, 'el pull request sigue abierto');
});

// ── T18 · AC 11 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_ReplacementsOnlyInInternalSummary', async () => {
  const { fx } = await published({ change: false });
  const before = (await mirrorReadOnly(fx, ['plan', '--json'])).json.replacements;
  // un par de la tabla que se usa: un nombre real en lo que sale, que el exportador reemplaza
  internalChange(fx, { 'guides/caso.md': `# Caso\n\nLo pidió ${TERM}, y ${TERM} lo aprobó.\n` });
  let r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  // el resumen de la corrida trae el aviso, con la cuenta
  const notice = /(\d+) reemplazo\(s\): un nombre pasó el freno y se arregla en el interno/.exec(r.out);
  assert.ok(notice, r.out);
  assert.strictEqual(Number(notice[1]), before + 2, 'la cuenta del exportador');
  // el pull request —que es público— no menciona reemplazos: ni el título, ni el cuerpo, ni el mensaje del commit
  const pr = fx.api.state.pulls[0];
  const message = commitFacts(fx.bare, tipOf(fx.bare, SYNC_REF)).body;
  for (const text of [pr.title, pr.body, message, JSON.stringify(fx.api.writes().map((q) => q.body))]) {
    assert.doesNotMatch(text, /reemplaz/i);
    assert.ok(!text.includes(TERM));
  }
  assert.ok(pr.body.includes('guides/caso.md'), 'control: el cuerpo sí nombra el archivo');
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.replacements, before + 2, 'en --json, la cuenta va en su clave');
});

// ── T19 · AC 12 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_LostLeaseOrApiError_NoSecondPr', async () => {
  const lease = (c) => / --force-with-lease=(\S*) /.exec(c.args)[1];
  // otra corrida empuja la rama entre la lectura y el push: se relee una vez, y termina con un solo pull request
  let { fx, seed } = await published();
  const other = syncCommit(fx, seed, { parent: seed.commit, files: { 'docs/otra-corrida.md': '# Otra corrida\n' } });
  let github = fakeGit(fx, { onPush: (git) => [`${git} -C "${fx.bare}" update-ref ${SYNC_REF} ${other}`] });
  let r = await syncRun(fx, ['--json'], { env: github.env });
  assert.strictEqual(r.code, 0, r.all);
  let tried = remoteCalls(github, 'push');
  assert.deepStrictEqual(tried.map(lease), [`${SYNC_REF}:`, `${SYNC_REF}:${other}`], 'dos intentos: el segundo, con lo que encontró al releer');
  assert.deepStrictEqual(r.pushed, [SYNC_REF], 'llegó un solo push');
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), r.json.commit, 'la rama queda con lo de esta corrida, que es más nueva');
  assert.notStrictEqual(r.json.commit, other);
  assert.deepStrictEqual(writesOf(fx), ['POST /pulls'], 'un solo pull request');
  assert.strictEqual(openPulls(fx).length, 1);

  // pierde otra vez: no insiste. Sale 2 sin abrir nada, y no quedó nada más viejo que lo que había
  ({ fx, seed } = await published());
  const one = syncCommit(fx, seed, { parent: seed.commit, files: { 'docs/una.md': '# Una\n' } });
  const two = syncCommit(fx, seed, { parent: seed.commit, files: { 'docs/dos.md': '# Dos\n' } });
  github = fakeGit(fx, { onPush: (git) => [one, two, one, two].map((sha) => `${git} -C "${fx.bare}" update-ref ${SYNC_REF} ${sha}`) });
  r = await syncRun(fx, [], { env: github.env });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /otra corrida/);
  tried = remoteCalls(github, 'push');
  assert.deepStrictEqual(tried.map(lease), [`${SYNC_REF}:`, `${SYNC_REF}:${one}`], 'releyó una vez, y nada más');
  assert.deepStrictEqual(r.pushed, []);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), two, 'la rama queda con lo que dejó la otra corrida');
  assert.deepStrictEqual(fx.api.writes(), [], 'sin abrir ningún pull request');

  // la API contesta 500 al listar los pull requests abiertos: 2 sin crear ninguno (y sin empujar)
  ({ fx } = await published());
  fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') ? { status: 500, json: { message: 'Server Error' } } : null);
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /la API contestó 500 al leer los pull requests abiertos/);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), '');
  // contesta algo que no es una lista: lo mismo
  fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') ? { status: 200, json: { message: 'otra cosa' } } : null);
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 2, r.all);

  // el push no llega a GitHub (sin red): 2, sin abrir nada, y sin la URL del repo en la salida
  github = fakeGit(fx, { onPush: () => [`echo "fatal: unable to access 'file://${fx.github}/${PUBLIC.org}/${PUBLIC.repo}.git/': Could not resolve host" >&2; exit 128`] });
  fx.api.override = null;
  r = await syncWithoutWrites(fx, [], { env: github.env });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /no pude empujar/);
  assert.match(r.err, /Could not resolve host/, 'con el motivo');
  assert.ok(!r.all.includes(fx.github) && !r.all.includes(PUBLIC.repo), 'sin la URL ni el nombre del repo');

  // falla al crear el pull request, con la rama ya empujada: 2. La corrida siguiente lo crea sin volver a empujar
  fx.api.override = (q) => (q.method === 'POST' && q.path.endsWith('/pulls') ? { status: 500, json: { message: 'Server Error' } } : null);
  r = await syncRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /la API contestó 500 al crear el pull request/);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.deepStrictEqual(openPulls(fx), []);
  fx.api.override = null;
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, []);
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'created' });
  assert.strictEqual(openPulls(fx).length, 1);
});

// ── T20 · AC 12 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Push_RejectedByGithub_RawMessageNoRetry', async () => {
  /** El público rechaza todo push con ese texto, como lo hace GitHub: por un `pre-receive`. Anota cada intento. */
  const rejecting = (fx, said) => {
    const attempts = path.join(fx.dir, 'attempts.log');
    const hook = path.join(fx.bare, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, ['#!/bin/sh', 'cat > /dev/null', `echo intento >> "${attempts}"`, ...said.map((l) => `echo "${l}" >&2`), 'exit 1', ''].join('\n'));
    fs.chmodSync(hook, 0o755);
    return () => (fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').split('\n').filter(Boolean).length : 0);
  };

  // un rechazo con un texto fijo
  let { fx } = await published();
  const fixed = 'error: GH006: esta rama está protegida y no acepta este push';
  let attempts = rejecting(fx, [fixed]);
  let r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.ok(r.err.includes(`remote: ${fixed}`), `el texto de GitHub, tal cual\n${r.err}`);
  assert.match(r.err, /no reintento/);
  assert.strictEqual(attempts(), 1, 'un solo intento');
  assert.doesNotMatch(r.err, /Alertas de prueba/, 'no es un rechazo por secretos');
  assert.ok(!r.all.includes(WRITER) && !r.all.includes(base64(WRITER)), 'el token no aparece');
  assert.deepStrictEqual(openPulls(fx), [], 'sin la rama no hay pull request');

  // el rechazo de la protección contra secretos, que cita un archivo
  ({ fx } = await published());
  const protection = [
    'error: GH013: Repository rule violations found for refs/heads/mirror/sync.',
    '- GITHUB PUSH PROTECTION',
    '  Push cannot contain secrets',
    '  locations:',
    '    - commit: 8728dbe67',
    '      path: scripts/formas.js:4',
    '    - commit: 8728dbe67',
    '      path: guides/otra cosa.md:12',
  ];
  attempts = rejecting(fx, protection);
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  for (const line of protection) assert.ok(r.err.includes(`remote: ${line}`), `el texto de GitHub, tal cual: «${line}»\n${r.err}`);
  assert.match(r.err, /protección contra secretos de GitHub, por scripts\/formas\.js/, 'nombra el archivo que GitHub cita');
  assert.ok(r.err.includes('guides/publicacion-espejo.md, §«Alertas de prueba en GitHub»'), 'remite a la guía');
  assert.strictEqual(attempts(), 1, 'un solo intento');
  assert.ok(!r.all.includes(WRITER) && !r.all.includes(base64(WRITER)), 'el token no aparece');
  r = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.strictEqual(r.json.push.rejected, true);
  assert.strictEqual(r.json.push.secretProtection, true);
  assert.deepStrictEqual(r.json.push.files, ['scripts/formas.js', 'guides/otra cosa.md']);
  assert.strictEqual(attempts(), 2, 'la segunda corrida, otro único intento');

  // `first` rechazado dice lo mismo: 1 con el texto, sin reintentar, y main no queda
  fx = await fixture();
  attempts = rejecting(fx, [fixed]);
  r = await mirrorReadOnly(fx, ['first'], { credential: WRITER });
  assert.strictEqual(r.code, 1, r.all);
  assert.ok(r.err.includes(`remote: ${fixed}`), r.err);
  assert.strictEqual(attempts(), 1);
});

// ── BLOQUE T21-T22: inicio ───────────────────────────────────────────────────────────────────────────────────────
// El token de instalación de la App (story 8.8, AC 13): `github-app-token.js` contra una API de mentira en 127.0.0.1,
// con un par de llaves generado en cada prueba. El servidor vive en este mismo proceso: el guion se lanza con `spawn` y
// una promesa, nunca con `spawnSync` (el servidor no contesta mientras el proceso espera, y la prueba se cuelga).
const tokenScript = path.join(RAIZ, 'scripts', 'publishing', 'github-app-token.js');
// los permisos de la tarea humana TH2: los que usa la sincronización, ni uno más
const tokenPermissions = Object.freeze({
  contents: 'write', pull_requests: 'write', workflows: 'write',
  metadata: 'read', administration: 'read', secret_scanning_alerts: 'read',
  // story 8.26, tanda F3 (AC 59): la lista de issues y su línea de tiempo no entran con ningún otro permiso
  issues: 'read',
});
// T72 · Qué permiso acepta GitHub para cada dirección que `verify` lee (cualquiera de los de la fila alcanza). Sale de
// la tabla de GitHub «Permissions required for GitHub Apps», leída fila por fila el 2026-10-10. La tanda F2 sumó la
// lista de issues y su línea de tiempo sin sumarle el permiso al token, y se vio recién en una corrida de verdad (un
// 403): con esta tabla, una dirección nueva sin permiso es un rojo de la suite.
const PERMISSION_FOR = Object.freeze([
  [/^$/, ['metadata']],
  [/^\/topics$/, ['metadata']],
  [/^\/private-vulnerability-reporting$/, ['metadata']],
  [/^\/secret-scanning\/alerts$/, ['secret_scanning_alerts']],
  [/^\/releases$/, ['contents']],
  [/^\/comments$/, ['metadata']],
  [/^\/pulls$/, ['pull_requests']],
  [/^\/pulls\/comments$/, ['pull_requests']],
  [/^\/pulls\/\d+\/reviews$/, ['pull_requests']],
  [/^\/issues$/, ['issues']],
  [/^\/issues\/events$/, ['issues']],
  [/^\/issues\/comments$/, ['issues', 'pull_requests']],
  [/^\/labels$/, ['issues', 'pull_requests']],
  [/^\/milestones$/, ['issues', 'pull_requests']],
]);
/** Un valor con la forma de un token de instalación, armado por partes: entero no se escribe en ningún archivo. */
const tokenSentinel = (tag) => ['ghs', '_', tag, 'Zz9'.repeat(12)].join('');

/** El laboratorio de una prueba: una llave nueva, su archivo y un nombre público inventado. */
function tokenLab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-token-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });   // la forma en que GitHub entrega la llave
  const keyFile = path.join(dir, 'app-key.pem');
  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
  const publicRepos = path.join(dir, 'public-repos.json');
  fs.writeFileSync(publicRepos, `${JSON.stringify({ org: 'example-org', repo: 'example-harness' })}\n`);
  return {
    dir, publicKey, keyPem, keyFile, publicRepos, repo: 'example-harness', appId: '424242', installationId: '98765432',
    decoy: tokenSentinel('decoy'),
    files: () => fs.readdirSync(dir).sort(),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** El ambiente del guion: sin las variables de la sincronización que traiga la máquina, con las del laboratorio, y con
 *  un señuelo en las credenciales que el guion NO tiene que mirar. `undefined` en `changes` saca la variable. */
function tokenEnv(lab, apiUrl, changes = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_MIRROR_')) env[k] = v;
  Object.assign(env, {
    TYCON_MIRROR_APP_ID: lab.appId,
    TYCON_MIRROR_INSTALLATION_ID: lab.installationId,
    TYCON_MIRROR_APP_KEY_FILE: lab.keyFile,
    TYCON_MIRROR_API_URL: apiUrl,
    GH_TOKEN: lab.decoy,
    GITHUB_TOKEN: lab.decoy,
  }, changes);
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete env[k];
  return env;
}

/** Corre el guion, parado en el laboratorio, y devuelve su código y sus dos salidas. */
function tokenRun(lab, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tokenScript, ...args], { cwd: lab.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** La API de mentira: anota cada pedido y contesta lo que diga `api.respond(pedido)` → `{ status, body }`. */
function tokenFakeApi(respond) {
  const api = { requests: [], respond };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      api.requests.push(seen);
      const answer = api.respond(seen);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  api.close = () => new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      api.url = `http://127.0.0.1:${server.address().port}`;
      resolve(api);
    });
  });
}

/** Un puerto de 127.0.0.1 donde no escucha nadie: se abre, se anota y se cierra. */
function tokenClosedPort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** El JWT de la cabecera `Authorization`, abierto y con la firma comprobada contra la llave pública (o null). */
function tokenJwt(authorization, publicKey) {
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization || '');
  if (!m) return null;
  const open = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  try {
    return {
      raw: `${m[1]}.${m[2]}.${m[3]}`,
      signature: m[3],
      header: open(m[1]),
      payload: open(m[2]),
      verified: crypto.verify('RSA-SHA256', Buffer.from(`${m[1]}.${m[2]}`), publicKey, Buffer.from(m[3], 'base64url')),
    };
  } catch (_) {
    return null;
  }
}

/** La API que se porta como la de verdad: sin `User-Agent` rechaza, con un JWT bien firmado entrega el token. */
function tokenMintingApi(lab, minted) {
  return tokenFakeApi((seen) => {
    if (!seen.headers['user-agent']) return { status: 403, body: { message: 'falta User-Agent' } };
    const jwt = tokenJwt(seen.headers.authorization, lab.publicKey);
    if (!jwt || !jwt.verified) return { status: 401, body: { message: 'Bad credentials' } };
    return { status: 201, body: { token: minted, expires_at: '2030-01-01T00:00:00Z' } };
  });
}

/** Ni la llave, ni un JWT, ni ninguno de los valores dados en un texto. Los mensajes no repiten lo hallado. */
function tokenAssertNoSecrets(text, lab, values, what) {
  const keyLines = String(lab.keyPem).split('\n').filter((l) => l && !l.startsWith('-----'));
  assert.ok(!keyLines.some((l) => text.includes(l)), `${what}: trae un renglón de la llave privada`);
  assert.ok(!text.includes(['PRIVATE', 'KEY'].join(' ')), `${what}: trae la cabecera de una llave privada`);
  assert.ok(!/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text), `${what}: trae un JWT`);
  for (const v of values) assert.ok(!text.includes(v), `${what}: trae un token`);
}

test('T72_AppToken_AsksForIssuesRead_AndEveryPathVerifyReadsHasItsPermission', async () => {
  // lo que el token pide: los seis permisos de siempre más la lectura de issues, y ninguno más
  const lab = tokenLab();
  const api = await tokenMintingApi(lab, tokenSentinel('f3'));
  try {
    const r = await tokenRun(lab, ['--public-repos', lab.publicRepos], tokenEnv(lab, api.url));
    assert.strictEqual(r.status, 0, r.stderr);
    const asked = JSON.parse(api.requests[0].body).permissions;
    assert.strictEqual(asked.issues, 'read', 'sin él, la lista de issues contesta 403 y las partes (l) y (m) no leen nada');
    assert.deepStrictEqual(Object.keys(asked).sort(), ['administration', 'contents', 'issues', 'metadata', 'pull_requests', 'secret_scanning_alerts', 'workflows']);
    assert.deepStrictEqual(asked, { ...tokenPermissions });
  } finally {
    await api.close();
  }
  // lo que una verificación completa le pide a la API: cada dirección, con un permiso que el token pide
  const fx = await fixture();
  seedPublication(fx);
  fx.api.state.credential = READER;
  fx.api.state.issues = [{ number: 7, state: 'closed', title: 'Un aporte', body: 'Sin nada raro.', pull_request: { url: 'x' } }];
  const run = await verifyRun(fx, ['--strict'], { credential: READER });
  assert.strictEqual(run.code, 0, run.all);
  const paths = [...new Set(fx.api.requests.map((q) => { assert.strictEqual(q.method, 'GET', `verify no escribe: ${q.method} ${q.path}`); return q.path.replace(/^\/repos\/[^/]+\/[^/]+/, ''); }))];
  for (const [pattern] of PERMISSION_FOR) assert.ok(paths.some((p) => pattern.test(p)), `la verificación ya no lee ${pattern}: la tabla de la prueba quedó vieja`);
  for (const p of paths) {
    const row = PERMISSION_FOR.find(([pattern]) => pattern.test(p));
    assert.ok(row, `verify lee «${p}» y la prueba no sabe qué permiso pide: sumalo a la tabla y, si hace falta, al token`);
    assert.ok(row[1].some((permission) => Object.prototype.hasOwnProperty.call(tokenPermissions, permission)), `«${p}» pide ${row[1].join(' o ')}, y el token no pide ninguno`);
  }
});

test('GithubAppToken_MintsWithVerifiableJwt', async () => {
  const lab = tokenLab();
  const minted = tokenSentinel('mint');
  const api = await tokenMintingApi(lab, minted);
  try {
    const before = Math.floor(Date.now() / 1000);
    const r = await tokenRun(lab, ['--public-repos', lab.publicRepos], tokenEnv(lab, api.url));
    const after = Math.ceil(Date.now() / 1000);

    // el token por la salida estándar, y nada más
    assert.strictEqual(r.status, 0, `sale 0 — ${r.stderr}`);
    assert.strictEqual(r.stdout, `${minted}\n`, 'la salida estándar es el token y un salto de línea, nada más');
    tokenAssertNoSecrets(r.stderr, lab, [minted, lab.decoy], 'la salida de error');
    assert.deepStrictEqual(lab.files(), ['app-key.pem', 'public-repos.json'], 'no deja ningún archivo donde corre');

    // un solo pedido, al punto de entrada de la instalación
    assert.strictEqual(api.requests.length, 1, 'un solo pedido');
    const seen = api.requests[0];
    assert.strictEqual(seen.method, 'POST');
    assert.strictEqual(seen.url, `/app/installations/${lab.installationId}/access_tokens`);

    // el JWT: RS256, firmado con la llave de la App, emitido por ella y con vida de 10 minutos o menos
    const jwt = tokenJwt(seen.headers.authorization, lab.publicKey);
    assert.ok(jwt, 'la cabecera Authorization es «Bearer <JWT>»');
    assert.strictEqual(jwt.verified, true, 'la firma se verifica con la llave pública');
    assert.strictEqual(jwt.header.alg, 'RS256');
    assert.strictEqual(jwt.header.typ, 'JWT');
    assert.strictEqual(String(jwt.payload.iss), lab.appId, 'iss es el id de la App');
    assert.ok(Number.isInteger(jwt.payload.iat) && Number.isInteger(jwt.payload.exp), 'iat y exp son segundos enteros');
    assert.ok(jwt.payload.iat <= after, 'no está emitido en el futuro');
    assert.ok(jwt.payload.exp > after, 'todavía no venció');
    assert.ok(jwt.payload.exp <= after + 600, 'vence a 10 minutos o menos de ahora');
    assert.ok(jwt.payload.exp - jwt.payload.iat <= 600, 'su vida entera es de 10 minutos o menos');
    assert.ok(jwt.payload.iat >= before - 600, 'el emitido es de ahora, no una fecha fija');

    // el pedido limita al repo del nombre público y a los permisos de la sincronización: el cuerpo, entero
    assert.deepStrictEqual(JSON.parse(seen.body), { repositories: [lab.repo], permissions: { ...tokenPermissions } });

    // nada de la máquina viaja en el pedido: ni las credenciales que no son suyas ni la llave
    const sent = `${JSON.stringify(seen.headers)}\n${seen.body}`;
    assert.ok(!sent.includes(lab.decoy), 'el pedido no lleva una credencial del ambiente');
    tokenAssertNoSecrets(seen.body, lab, [lab.decoy], 'el cuerpo del pedido');
  } finally {
    await api.close();
    lab.remove();
  }
});

test('GithubAppToken_Failures_Exit2WithoutSecrets', async () => {
  const lab = tokenLab();
  const minted = tokenSentinel('mint');
  const inBody = tokenSentinel('body');
  const api = await tokenMintingApi(lab, minted);
  const mint = api.respond;
  const sentJwts = () => api.requests.map((x) => tokenJwt(x.headers.authorization, lab.publicKey)).filter(Boolean);
  const ok = ['--public-repos', lab.publicRepos];

  /** Un caso: sale 2, la salida estándar vacía, el motivo en la de error, los pedidos esperados y ningún secreto. */
  async function fails(what, { args = ok, env = {}, apiUrl = api.url, reason, requests = 0, hidden = [] }) {
    api.requests.length = 0;
    const r = await tokenRun(lab, args, tokenEnv(lab, apiUrl, env));
    assert.strictEqual(r.status, 2, `${what}: sale 2 — ${r.stderr}`);
    assert.strictEqual(r.stdout, '', `${what}: la salida estándar queda vacía`);
    assert.match(r.stderr, reason, `${what}: dice el motivo`);
    assert.strictEqual(api.requests.length, requests, `${what}: pedidos a la API`);
    const secrets = [minted, inBody, lab.decoy, ...hidden];
    for (const jwt of sentJwts()) secrets.push(jwt.raw, jwt.signature);
    tokenAssertNoSecrets(r.stderr, lab, secrets, `${what}, la salida de error`);
    assert.deepStrictEqual(lab.files(), ['app-key.pem', 'public-repos.json'], `${what}: no deja ningún archivo`);
  }

  try {
    // sin cada una de las tres variables (ausente, y vacía: vacío no es un valor)
    for (const name of ['TYCON_MIRROR_APP_ID', 'TYCON_MIRROR_INSTALLATION_ID', 'TYCON_MIRROR_APP_KEY_FILE']) {
      await fails(`sin ${name}`, { env: { [name]: undefined }, reason: new RegExp(name) });
      await fails(`${name} vacía`, { env: { [name]: '' }, reason: new RegExp(name) });
    }
    await fails('sin ninguna de las tres', {
      env: { TYCON_MIRROR_APP_ID: undefined, TYCON_MIRROR_INSTALLATION_ID: undefined, TYCON_MIRROR_APP_KEY_FILE: undefined },
      reason: /TYCON_MIRROR_APP_ID[\s\S]*TYCON_MIRROR_INSTALLATION_ID[\s\S]*TYCON_MIRROR_APP_KEY_FILE/,
    });
    // un id de instalación que no es un número no llega a la ruta del pedido
    await fails('id de instalación con una ruta adentro', { env: { TYCON_MIRROR_INSTALLATION_ID: '1/../../x' }, reason: /TYCON_MIRROR_INSTALLATION_ID/ });

    // la llave ilegible: no está, o está y no es una llave
    const missingKey = path.join(lab.dir, 'no-such-key.pem');
    await fails('la llave no existe', { env: { TYCON_MIRROR_APP_KEY_FILE: missingKey }, reason: /llave[\s\S]*ENOENT/ });
    const notAKey = path.join(os.tmpdir(), `app-token-not-a-key-${process.pid}.pem`);
    const garbage = ['esto', 'no', 'es', 'una', 'llave', String(process.pid)].join('-');
    fs.writeFileSync(notAKey, `${garbage}\n`);
    try {
      await fails('la llave no es una llave', { env: { TYCON_MIRROR_APP_KEY_FILE: notAKey }, reason: /llave/, hidden: [garbage] });
    } finally {
      fs.rmSync(notAKey, { force: true });
    }
    // una llave que no es RSA no firma RS256: se dice antes de pedir nada
    const otherKey = path.join(os.tmpdir(), `app-token-other-key-${process.pid}.pem`);
    const { privateKey: notRsa } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fs.writeFileSync(otherKey, notRsa.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    try {
      await fails('la llave no es RSA', { env: { TYCON_MIRROR_APP_KEY_FILE: otherKey }, reason: /RSA/ });
    } finally {
      fs.rmSync(otherKey, { force: true });
    }

    // el nombre público ilegible: no está, o no es JSON, o le falta el repo
    const missingRepos = path.join(lab.dir, 'no-such-public-repos.json');
    await fails('public-repos.json no existe', { args: ['--public-repos', missingRepos], reason: /no-such-public-repos\.json/ });
    const brokenRepos = path.join(os.tmpdir(), `app-token-broken-repos-${process.pid}.json`);
    try {
      fs.writeFileSync(brokenRepos, '{ "org": ');
      await fails('public-repos.json roto', { args: ['--public-repos', brokenRepos], reason: /app-token-broken-repos/ });
      fs.writeFileSync(brokenRepos, `${JSON.stringify({ org: 'example-org' })}\n`);
      await fails('public-repos.json sin repo', { args: ['--public-repos', brokenRepos], reason: /repo/ });
    } finally {
      fs.rmSync(brokenRepos, { force: true });
    }

    // la línea de comandos
    await fails('--public-repos sin valor', { args: ['--public-repos'], reason: /--public-repos/ });
    await fails('una opción desconocida', { args: [...ok, '--no-such-option'], reason: /--no-such-option/ });

    // la base de la API: sólo http:// o https://
    await fails('una base que no es http', { apiUrl: 'ftp://127.0.0.1/', reason: /TYCON_MIRROR_API_URL/ });
    await fails('una base que no es una URL', { apiUrl: '127.0.0.1 sin esquema', reason: /TYCON_MIRROR_API_URL/ });

    // sin cifrar (http://) sólo hacia la propia máquina: a cualquier otro servidor la credencial firmada no se le manda.
    // Los dos nombres de acá llegan al servidor de este laboratorio sin ser ninguno de los tres permitidos: si el guion
    // no frenara, el pedido llegaría (y la cuenta de pedidos lo vería).
    const apiPort = new URL(api.url).port;
    for (const host of ['0.0.0.0', '[::ffff:127.0.0.1]']) {
      await fails(`http:// hacia ${host}`, { apiUrl: `http://${host}:${apiPort}`, reason: /TYCON_MIRROR_API_URL[\s\S]*https:\/\// });
    }
    // frena antes de leer la llave —y por eso antes de firmar—: con la llave ilegible, el motivo sigue siendo la base
    await fails('http:// hacia otro servidor, antes de la llave', {
      apiUrl: `http://0.0.0.0:${apiPort}`, env: { TYCON_MIRROR_APP_KEY_FILE: missingKey }, reason: /TYCON_MIRROR_API_URL[\s\S]*https:\/\//,
    });
    // los otros dos nombres de la propia máquina pasan el control: con nadie escuchando, el motivo es la conexión
    const quietPort = await tokenClosedPort();
    for (const host of ['localhost', '[::1]']) {
      await fails(`http:// hacia ${host}, sin nadie escuchando`, { apiUrl: `http://${host}:${quietPort}`, reason: /no pude hablar con la API/ });
    }

    // la API contesta 401: sale el código, nunca el cuerpo
    api.respond = () => ({ status: 401, body: { message: 'Bad credentials', echo: inBody } });
    await fails('la API contesta 401', { reason: /\b401\b/, requests: 1, hidden: ['Bad credentials'] });
    assert.strictEqual(sentJwts().length, 1, 'el pedido rechazado llevaba un JWT: el caso mide que no se imprime');

    // cualquier respuesta que no sea 201, aunque traiga un token, no entrega nada
    api.respond = () => ({ status: 200, body: { token: inBody } });
    await fails('la API contesta 200', { reason: /\b200\b/, requests: 1 });
    api.respond = () => ({ status: 302, body: { token: inBody } });
    await fails('la API contesta 302', { reason: /\b302\b/, requests: 1 });

    // un 201 que no trae un token usable: el cuerpo tampoco se imprime (ni dentro del error de quien lo lee)
    api.respond = () => ({ status: 201, body: `${inBody} no es JSON` });
    await fails('un 201 que no es JSON', { reason: /201/, requests: 1, hidden: [inBody.slice(0, 8)] });
    api.respond = () => ({ status: 201, body: { expires_at: '2030-01-01T00:00:00Z', other: inBody } });
    await fails('un 201 sin token', { reason: /201/, requests: 1 });
    api.respond = () => ({ status: 201, body: { token: `${inBody}\nsegunda línea` } });
    await fails('un 201 con un token de dos líneas', { reason: /201/, requests: 1 });
    api.respond = () => ({ status: 201, body: { token: minted, padding: 'x'.repeat(200000) } });
    await fails('un 201 desmedido', { reason: /201/, requests: 1 });

    // nadie escucha: no pude, con el motivo
    api.respond = mint;
    const port = await tokenClosedPort();
    await fails('nadie escucha en la base', { apiUrl: `http://127.0.0.1:${port}`, reason: /ECONNREFUSED/ });
  } finally {
    await api.close();
    lab.remove();
  }
});
// ── BLOQUE T21-T22: fin ──────────────────────────────────────────────────────────────────────────────────────────

// ── T28 · AC 23 ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Las secciones de nivel 2 de un Markdown, fuera de los bloques de código: el título de cada una y su texto. */
function sectionsOf(markdown) {
  const sections = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^## (.+?)\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1], lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
  }
  return sections.map((s) => ({ title: s.title, text: s.lines.join('\n') }));
}

test('Guide_IfVerifyFails_TwoCasesAndOwner', () => {
  const rel = 'guides/publicacion-espejo.md';
  const whole = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  // lo que sale en la copia: sin los bloques internos. En la copia ya no están, y la prueba da lo mismo
  const shipped = require(path.join(PUBLISHING, 'public-copy.js')).internalBlocks(whole, rel);
  assert.deepStrictEqual(shipped.errors, [], 'los marcadores de bloque de la guía están bien puestos');
  const sections = sectionsOf(shipped.text);
  const titles = sections.map((s) => s.title);
  assert.ok(sectionsOf(whole).length >= sections.length && sections.length > 6, 'control: la guía se leyó, con sus secciones');

  // las seis secciones de la publicación, una vez cada una, antes del estado y en lo que sale
  const wanted = ['La publicación', 'Cambios ajenos', 'Si `verify` da 1', 'Alertas de prueba en GitHub', 'Cómo se cambia el nombre público', 'La llave de la App'];
  const state = titles.indexOf('Estado');
  assert.ok(state > 0, 'la guía tiene su sección de estado');
  for (const title of wanted) {
    assert.strictEqual(titles.filter((t) => t === title).length, 1, `la sección «${title}» está una vez, y sale en la copia\n${titles.join(' · ')}`);
    assert.ok(titles.indexOf(title) < state, `«${title}» va antes del estado`);
  }

  // «Si `verify` da 1»: los dos casos, quién decide —el rol, sin el nombre de nadie— y que la historia no se reescribe
  const section = sections.find((s) => s.title === 'Si `verify` da 1').text;
  const says = (text) => section.toLowerCase().includes(text.toLowerCase());
  for (const [what, text] of [['el caso del repo privado', 'privado'], ['el caso del repo público', 'público'], ['quién decide', 'el dueño del arnés'],
    ['que la historia no se reescribe', 'no se reescribe'], ['cómo se apaga la publicación', 'TYCON_MIRROR_ENABLED']]) {
    assert.ok(says(text), `la sección dice ${what} («${text}»)`);
  }
  assert.match(section, /decide\s+\**el dueño del arnés/i, 'quien decide es un rol');

  // los mensajes del guion remiten a secciones de la guía que existen
  const source = fs.readFileSync(MIRROR, 'utf8');
  assert.ok(source.includes(`'${rel}'`), 'el guion nombra la guía');
  const cited = [...new Set([...source.matchAll(/§«([^»]+)»/g)].map((m) => m[1].replace(/\\`/g, '`')))];
  for (const title of ['Cambios ajenos', 'Alertas de prueba en GitHub', 'Si `verify` da 1']) assert.ok(cited.includes(title), `el guion remite a §«${title}»`);
  for (const title of cited) assert.ok(titles.includes(title), `el guion remite a §«${title}», y la guía tiene esa sección`);
});

// ── Lo que encontró el pase adversarial de la tanda A (2026-10-03) ─────────────────────────────────────────────────
// Cada prueba nació roja contra el guion de ese día, por la causa que nombra.

/** Un correo de una persona de afuera, con un dominio inventado que no es de ejemplo: por partes, como los demás. */
const OUTSIDER = { name: 'Colaboradora De Afuera', email: ['colaboradora', 'correo-inventado.dev'].join('@') };
const OUTSIDER_NOREPLY = ['12345+colaboradora', 'users.noreply.github.com'].join('@');
const identityOf = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
// lo que el guion escribe donde iría una ruta que ES un hallazgo: en sus salidas, y en el cuerpo del pull request
const HIDDEN_PATH = '(una ruta con un hallazgo: no se imprime)';
const HIDDEN_IN_BODY = '- (una ruta que no se nombra)';

/** Un servidor de esta máquina que anota lo que le llega y contesta 404: para ver a quién le habla git, y con qué. */
function listener(headers = null) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization || null });
      // con `headers` (una función del pedido), contesta una redirección con esas cabeceras
      if (headers) res.writeHead(301, headers(req));
      else res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, seen,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
    }));
  });
}

/** Como `labWithFakeExporter`, pero el exportador de mentira, corrido, hace lo que diga `body`. */
function labWithExporterBody(fx, name, body) {
  const lab = path.join(fx.dir, name);
  fs.mkdirSync(path.join(lab, 'scripts', 'publishing'), { recursive: true });
  fs.mkdirSync(path.join(lab, 'scripts', 'lib'), { recursive: true });
  copyVersionRule(lab);
  fs.copyFileSync(MIRROR, path.join(lab, 'scripts', 'publishing', 'mirror.js'));
  fs.copyFileSync(path.join(PUBLISHING, 'detector.js'), path.join(lab, 'scripts', 'publishing', 'detector.js'));
  fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', 'skills-dir.js'), path.join(lab, 'scripts', 'lib', 'skills-dir.js'));
  fs.writeFileSync(path.join(lab, 'scripts', 'publishing', 'export.js'), ["'use strict';",
    `module.exports = require(${JSON.stringify(EXPORTER)});`, 'if (require.main === module) {', body, '}', ''].join('\n'));
  return path.join(lab, 'scripts', 'publishing', 'mirror.js');
}

// ── causas 19, 21 y 24 · AC 11, 23 ─────────────────────────────────────────────────────────────────────────────────
test('Mirror_Sync_DeletedPathWithDeniedName_StillPublishes', async () => {
  // una ruta ya publicada lleva un nombre que la lista aprende DESPUÉS; el interno la renombra
  const name = 'Kramerica';
  const old = `guides/${name}-notas.md`;
  let fx = await fixture();
  write(fx.harness, { [old]: '# Notas\n\nSin nombres adentro.\n' });
  commit(fx.harness, 'una guía con un nombre que la lista todavía no conoce');
  seedPublication(fx);
  fx.config(withTerm(name));
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, `control: la lista nueva encuentra la ruta en lo publicado\n${r.all}`);
  assert.deepStrictEqual(partsOf(r), ['b']);
  write(fx.harness, { [old]: null, 'guides/notas.md': '# Notas\n\nSin nombres adentro.\n' });
  commit(fx.harness, 'la guía, con un nombre que se puede publicar');

  // `plan` cuenta el borrado y no imprime la ruta: es lo hallado
  for (const args of [['plan', '--json'], ['plan']]) {
    const planned = await mirrorReadOnly(fx, args);
    assert.strictEqual(planned.code, 0, planned.all);
    assert.ok(!planned.all.includes(name), `${args.join(' ')}: la ruta borrada no se imprime\n${planned.all}`);
    assert.ok(planned.all.includes(HIDDEN_PATH), `${args.join(' ')}: dice que hay una ruta que no imprime\n${planned.all}`);
    if (!planned.json) continue;
    assert.strictEqual(planned.json.state, 'changes');
    assert.deepStrictEqual(planned.json.counts, { added: 1, modified: 0, deleted: 1 }, 'la cuenta es la de siempre');
    assert.deepStrictEqual(planned.json.paths, [{ status: 'deleted', path: HIDDEN_PATH }, { status: 'added', path: 'guides/notas.md' }]);
    assert.strictEqual(planned.json.pathsHidden, 1);
  }

  // `sync` publica el arreglo: empuja y abre el pull request, sin el nombre en ningún texto
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, `el arreglo del interno se puede publicar\n${r.all}`);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'created' });
  assert.strictEqual(r.json.pathsHidden, 1);
  assert.ok(!r.all.includes(name), `ninguna salida trae el nombre\n${r.all}`);
  const body = fx.api.state.pulls[0].body;
  assert.ok(!JSON.stringify(fx.api.writes().map((q) => q.body)).includes(name), 'ningún texto escrito por la API trae el nombre');
  assert.ok(body.includes('1 agregado(s), 0 modificado(s), 1 borrado(s)'), `el borrado se cuenta\n${body}`);
  assert.deepStrictEqual(body.split('\n').filter((l) => /^[+~-] /.test(l)), [HIDDEN_IN_BODY, '+ guides/notas.md'], 'la ruta borrada no se escribe: va su lugar');
  assert.ok(!commitFacts(fx.bare, r.json.commit).body.includes(name));
  // sin --json dice lo mismo, y la segunda corrida no cambia nada
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.ok(!r.all.includes(name) && r.out.includes(HIDDEN_PATH), r.all);
  // mergeado, la ruta ya no está en main: la parte (b) queda en cero
  mergeSync(fx);
  assert.ok(!gitFx(fx.bare, ['ls-tree', '-r', '--name-only', 'main']).includes(name), 'main ya no trae la ruta');
  r = await verifyRun(fx);
  assert.ok(!partsOf(r).includes('b'), `la parte (b), en cero\n${r.all}`);

  // un commit ajeno agrega en el público una ruta con un término; el interno lo descarta: la sincronización la saca
  ({ fx } = await published({ change: false }));
  const foreign = publicCommit(fx, { parents: [tipOf(fx.bare, MAIN_REF)], files: { [`docs/${TERM}-notas.md`]: '# Notas\n' }, message: 'Un cambio mergeado en GitHub' });
  commit(fx.harness, `chore: descarta un cambio ajeno del repo público\n\nPublic-Commit: ${foreign}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
  const planned = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(planned.code, 0, planned.all);
  assert.deepStrictEqual(planned.json.counts, { added: 0, modified: 0, deleted: 1 });
  assert.deepStrictEqual(planned.json.foreign, [{ commit: foreign, paths: [HIDDEN_PATH], absorbed: true, discarded: true }], 'la ruta del cambio ajeno tampoco se imprime');
  assert.ok(!planned.all.includes(TERM), planned.all);
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.ok(!r.all.includes(TERM) && !fx.api.state.pulls[0].body.includes(TERM));
  assert.ok(!gitFx(fx.bare, ['ls-tree', '-r', '--name-only', r.json.commit]).includes(TERM), 'el commit de la sincronización saca la ruta');

  // sin absorber, el mensaje de «cambios ajenos» tampoco la imprime
  ({ fx } = await published({ change: false }));
  const pending = publicCommit(fx, { parents: [tipOf(fx.bare, MAIN_REF)], files: { [`docs/${TERM}-notas.md`]: '# Notas\n' }, message: 'Un cambio mergeado en GitHub' });
  r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.ok(r.err.includes(`· ${pending} — ${HIDDEN_PATH}`), r.err);
  assert.ok(!r.all.includes(TERM), r.all);
});

// ── causa 16 · AC 13, 14 ───────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Bases_PlainHttpOnlyToThisMachine_Exit2BeforeToken', async () => {
  const fx = await fixture();
  seedPublication(fx);
  const github = fakeGit(fx);
  const a = await listener();
  const b = await listener();
  try {
    const GIT = 'TYCON_MIRROR_GIT_BASE';
    const API = 'TYCON_MIRROR_API_URL';
    // [la variable, el valor, lo que dice]: ninguno llega a hablar con nadie
    const refused = [
      [GIT, 'http://example.org', /sin cifrar \(http:\/\/\) sólo se habla con la propia máquina/],
      [GIT, 'http://127.0.0.2', /sin cifrar/],
      [GIT, 'http://localhost.example.org', /sin cifrar/],
      // la barra invertida: node lee un servidor y git, otro
      [GIT, `http://127.0.0.1:${a.port}\\@127.0.0.1:${b.port}`, /caracteres/],
      [GIT, `http://127.0.0.1:${a.port}\\@example.org`, /caracteres/],
      [GIT, `http://lector@127.0.0.1:${a.port}`, /caracteres|usuario/],
      [GIT, `http://127.0.0.1:${a.port}/%5c@example.org`, /caracteres/],
      [GIT, `http://127.0.0.1:${a.port}/ otra`, /caracteres/],
      [GIT, 'https://example.org/?x=1', /caracteres|«\?»/],
      [GIT, 'file://example.org/srv/git', /file:\/\//],
      [GIT, 'ssh://example.org/git', /va con/],
      [API, 'http://example.org', /sin cifrar \(http:\/\/\) sólo se habla con la propia máquina/],
      [API, `http://127.0.0.1:${a.port}\\@example.org`, /caracteres/],
      [API, `http://lector:clave@127.0.0.1:${a.port}`, /caracteres|usuario/],
      [API, `file://${fx.github}`, /va con/],
    ];
    for (const [variable, value, reason] of refused) {
      for (const command of ['plan', 'first', 'sync', 'verify']) {
        const r = await mirrorReadOnly(fx, [command], { credential: WRITER, env: { ...github.env, [variable]: value } });
        assert.strictEqual(r.code, 2, `${variable}=${value}, ${command}: sale 2\n${r.all}`);
        assert.ok(r.err.includes(variable), `${variable}=${value}, ${command}: nombra la variable\n${r.err}`);
        assert.match(r.err, reason, `${variable}=${value}, ${command}: dice por qué`);
        assert.ok(!r.all.includes(WRITER) && !r.all.includes(base64(WRITER)), 'el token no aparece');
      }
    }
    assert.deepStrictEqual(remoteCalls(github), [], 'antes de usar el token: git no le habló a nadie');
    assert.deepStrictEqual(fx.api.requests, [], 'ni un pedido a la API');
    assert.deepStrictEqual([a.seen, b.seen], [[], []], 'ni a ningún otro servidor');

    // control: sin cifrar hacia la propia máquina sí. git le habla a ESE servidor, con la URL que se validó (la
    // normalizada, no el texto crudo) y con la cabecera
    let r = await mirrorReadOnly(fx, ['plan'], { credential: WRITER, env: { ...github.env, [GIT]: `HTTP://127.0.0.1:${a.port}/` } });
    assert.strictEqual(r.code, 2, `el servidor de mentira contesta 404: no pude leer\n${r.all}`);
    assert.match(r.err, /no pude leer/);
    assert.ok(a.seen.length > 0 && a.seen.every((q) => q.url.startsWith(`/${PUBLIC.org}/${PUBLIC.repo}.git/`)), JSON.stringify(a.seen));
    assert.ok(a.seen.every((q) => String(q.authorization).toLowerCase() === `basic ${base64(WRITER)}`.toLowerCase()), 'con la cabecera de la corrida');
    assert.deepStrictEqual(b.seen, []);
    const asked = remoteCalls(github, 'ls-remote');
    assert.strictEqual(asked.length, 1);
    assert.ok(asked[0].args.includes(` http://127.0.0.1:${a.port}/${PUBLIC.org}/${PUBLIC.repo}.git `), `a git le llega la URL normalizada\n${asked[0].args}`);
    assert.strictEqual(asked[0].env.GIT_CONFIG_KEY_0, `http.http://127.0.0.1:${a.port}/.extraheader`, 'y la cabecera va para esa misma base');
    // las tres formas de nombrar a la propia máquina valen en la base de la API (`plan` no la llama: alcanza con que arranque)
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      r = await mirrorReadOnly(fx, ['plan'], { credential: WRITER, env: { [API]: `http://${host}:${a.port}` } });
      assert.strictEqual(r.code, 0, `${host}: ${r.all}`);
    }
    // y lo cifrado va a donde sea: la regla es sobre http://
    r = await mirrorReadOnly(fx, ['plan'], { credential: WRITER, env: { [API]: 'https://api.example.org/v3' } });
    assert.strictEqual(r.code, 0, r.all);
  } finally {
    await a.close();
    await b.close();
  }
});

// ── causa 14 · AC 8 ────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Foreign_TreeTrailerAlone_IsNotASync', async () => {
  const fixed = require(EXPORTER).COMMIT_IDENTITY;
  const own = identityOf(fixed.nombre, fixed.email);
  const outsider = identityOf('Alguien De Afuera', 'afuera@example.com');
  const internal = (fx) => `Mirror-Harness-Commit: ${headOf(fx.harness)}\nMirror-Agent-Skills-Commit: ${headOf(fx.skills)}\n`;
  // [el caso, la identidad, el mensaje según su árbol]: un commit que agrega un archivo, mergeado en GitHub con commit de merge
  const cases = [
    ['otro autor, y sólo el trailer de su árbol', outsider, () => (tree) => `Un aporte externo\n\nMirror-Tree: ${tree}\n`],
    ['otro autor, con los tres trailers', outsider, (fx) => (tree) => `Sincronización\n\n${internal(fx)}Mirror-Tree: ${tree}\n`],
    ['la identidad de la copia, y sólo el trailer de su árbol', own, () => (tree) => `Sincronización\n\nMirror-Tree: ${tree}\n`],
    ['la identidad de la copia sólo como autor', { ...own, GIT_COMMITTER_NAME: 'Alguien De Afuera', GIT_COMMITTER_EMAIL: 'afuera@example.com' },
      (fx) => (tree) => `Sincronización\n\n${internal(fx)}Mirror-Tree: ${tree}\n`],
    ['un trailer interno que no es un sha', own, (fx) => (tree) => `Sincronización\n\nMirror-Harness-Commit: main\nMirror-Agent-Skills-Commit: ${headOf(fx.skills)}\nMirror-Tree: ${tree}\n`],
  ];
  for (const [name, identity, message] of cases) {
    const { fx, seed } = await published({ change: false });
    const head = publicCommit(fx, { parents: [seed.commit], files: { 'docs/aporte.md': '# Aporte\n' }, ref: null, message: message(fx), identity });
    const merged = publicCommit(fx, { parents: [seed.commit, head], from: head, message: 'Merge pull request #9 from alguien/aporte' });
    let r = await mirrorReadOnly(fx, ['plan', '--json']);
    assert.strictEqual(r.code, 1, `${name}: plan\n${r.all}`);
    assert.strictEqual(r.json.state, 'foreign-changes', name);
    assert.deepStrictEqual(r.json.foreign, [{ commit: merged, paths: ['docs/aporte.md'], absorbed: false, discarded: false }], name);
    r = await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 1, `${name}: sync\n${r.all}`);
    assert.match(r.err, /cambios ajenos sin traer/, name);
    r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: verify\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), ['f'], name);
  }
  // un merge como segundo padre tampoco: la sincronización es UN commit sobre la punta pública
  const { fx, seed } = await published({ change: false });
  const side = publicCommit(fx, { parents: [seed.commit], files: { 'docs/lado.md': '# Lado\n' }, ref: null, message: 'Un lado', identity: own });
  const two = publicCommit(fx, { parents: [seed.commit, side], from: side, ref: null, identity: own, message: (tree) => `Sincronización\n\n${internal(fx)}Mirror-Tree: ${tree}\n` });
  const merged = publicCommit(fx, { parents: [seed.commit, two], from: two, message: 'Merge pull request #9' });
  let r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.foreign.map((f) => f.commit), [merged]);
  // control: la sincronización de verdad, mergeada, no es un cambio ajeno
  gitFx(fx.bare, ['update-ref', MAIN_REF, seed.commit]);
  internalChange(fx);
  r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  mergeSync(fx);
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unchanged');
  assert.deepStrictEqual(r.json.foreign, []);
});

// ── causa 20 · AC 15 (c) ───────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Verify_PullOnlyCommits_ThirdPartyEmailNotJudged', async () => {
  const fx = await fixture();
  const seed = seedPublication(fx);
  const reset = () => {
    for (const ref of refsOf(fx.bare).split('\n').filter(Boolean).map((l) => l.split(' ')[0])) gitFx(fx.bare, ['update-ref', '-d', ref]);
    gitFx(fx.bare, ['update-ref', MAIN_REF, seed.commit]);
  };
  const aporte = (ref, identity, files = { 'docs/typo.md': '# Typo\n\nA small fix.\n' }, message = 'Fix a typo') => publicCommit(fx, { parents: [seed.commit], files, message, ref, identity });
  const secrets = [OUTSIDER.email, OUTSIDER_NOREPLY, OUTSIDER.name];
  const clean = (r, name) => { for (const s of secrets) assert.ok(!r.all.toLowerCase().includes(s.toLowerCase()), `${name}: ninguna salida trae la identidad\n${r.all}`); };

  // alguien de afuera abre un pull request con su correo de siempre, con el anónimo de GitHub, o desde la web
  const outside = [
    ['su correo de siempre', identityOf(OUTSIDER.name, OUTSIDER.email)],
    ['su correo anónimo de GitHub', identityOf(OUTSIDER.name, OUTSIDER_NOREPLY)],
    ['hecho desde la web', { ...identityOf(OUTSIDER.name, OUTSIDER_NOREPLY), GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: WEB_COMMITTER }],
  ];
  for (const [name, identity] of outside) {
    reset();
    aporte('refs/pull/7/head', identity);
    for (const args of [[], ['--strict']]) {
      const r = await verifyRun(fx, args, { credential: READER });
      assert.strictEqual(r.code, 0, `${name} ${args.join(' ')}: un pull request de afuera no deja verify en 1\n${r.all}`);
      assert.deepStrictEqual(r.json.findings, [], name);
      assert.strictEqual(r.json.pullOnlyCommits, 1, `${name}: dice cuántos commits quedaron bajo la excepción`);
      clean(r, name);
    }
  }
  const h = await verifyPlain(fx);
  assert.match(h.out, /1 commit\(s\) alcanzables sólo desde cabezas de pull request/, h.all);

  // la excepción es de la regla genérica de correos, y de esos commits: lo demás se sigue buscando ahí
  const still = [
    ['un nombre de la lista en la identidad', () => aporte('refs/pull/7/head', identityOf(TERM, OUTSIDER.email)), ['c'], 'cliente'],
    ['un nombre de la lista en el mensaje', () => aporte('refs/pull/7/head', identityOf(OUTSIDER.name, OUTSIDER.email), undefined, `Fix a typo, for ${TERM}`), ['c'], 'cliente'],
    ['un nombre de la lista en el contenido', () => aporte('refs/pull/7/head', identityOf(OUTSIDER.name, OUTSIDER.email), { 'docs/typo.md': `De parte de ${TERM}.\n` }), ["a'"], 'cliente'],
    // el contenido de un pull request se mira como siempre: un correo ahí sí es un hallazgo
    ['un correo en el contenido', () => aporte('refs/pull/7/head', identityOf(OUTSIDER.name, OUTSIDER.email), { 'docs/typo.md': `Escribile a ${OUTSIDER.email}.\n` }), ["a'"], 'email'],
    // el mismo correo en un commit alcanzable desde una rama o una etiqueta: no cambia nada
    ['el correo, en un commit de main', () => aporte(MAIN_REF, identityOf(OUTSIDER.name, OUTSIDER.email)), ['c', 'f'], null],
    ['el correo, en un commit de otra rama', () => aporte('refs/heads/otra', identityOf(OUTSIDER.name, OUTSIDER.email)), ['c'], 'email'],
    ['el correo, en un commit con una etiqueta', () => gitFx(fx.bare, ['tag', 'v0', aporte(null, identityOf(OUTSIDER.name, OUTSIDER.email))]), ['c'], 'email'],
    ['el correo, en la cabeza de un pull request que además está en una rama', () => {
      const sha = aporte('refs/pull/7/head', identityOf(OUTSIDER.name, OUTSIDER.email));
      gitFx(fx.bare, ['update-ref', 'refs/heads/otra', sha]);
    }, ['c'], 'email'],
  ];
  for (const [name, mutate, parts, category] of still) {
    reset();
    mutate();
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), parts, `${name}\n${r.all}`);
    if (category) assert.ok(r.json.findings.every((f) => f.category === category), `${name}: ${category}\n${r.all}`);
    clean(r, name);
    assert.ok(!r.all.includes(TERM), `${name}: sin el texto hallado`);
  }
});

// ── causa 25 · AC 5 ────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Exporter_DiesWithoutFindings_Exit2WithReason', async () => {
  const fx = await fixture();
  const long = 'x'.repeat(600);
  // [el caso, lo que hace el exportador corrido, lo que tiene que decir]
  const cases = [
    ['muere antes de arrancar (node sale 1, sin JSON)', "  throw new Error('MOTIVO-DEL-HIJO: algo se rompió antes de main()');", /MOTIVO-DEL-HIJO: algo se rompió antes de main\(\)/],
    ['sale 1 con un JSON sin hallazgos', "  process.stdout.write('{}'); process.exitCode = 1;", /sin decir por qué|ningún hallazgo/],
    ['sale 1 con algo que no es JSON', "  process.stdout.write('<html>'); process.stderr.write('MOTIVO-DEL-HIJO: otra cosa\\n'); process.exitCode = 1;", /MOTIVO-DEL-HIJO: otra cosa/],
    ['muere con un motivo larguísimo', `  throw new Error('MOTIVO-DEL-HIJO ${long}');`, /MOTIVO-DEL-HIJO x+…/],
  ];
  for (const [name, body, reason] of cases) {
    const script = labWithExporterBody(fx, `lab-${cases.findIndex((c) => c[0] === name)}`, body);
    for (const command of ['plan', 'first']) {
      const r = await mirrorReadOnly(fx, [command], { script, credential: WRITER });
      assert.strictEqual(r.code, 2, `${name}, ${command}: «no pude», no «hallazgos»\n${r.all}`);
      assert.match(r.err, /el exportador no pudo armar la copia \(salió 1\)/, `${name}, ${command}`);
      assert.doesNotMatch(r.err, /0 hallazgo/, `${name}, ${command}: no inventa una cuenta de hallazgos`);
      assert.match(r.err, reason, `${name}, ${command}: con el motivo del hijo\n${r.err}`);
      const line = r.err.split('\n').find((l) => reason.test(l));
      assert.ok(line.length < 320, `${name}, ${command}: en una línea recortada (${line.length})`);
      assert.doesNotMatch(r.err, /\n\s+at /, `${name}, ${command}: sin la pila del hijo`);
    }
    const j = await mirrorReadOnly(fx, ['plan', '--json'], { script });
    assert.strictEqual(j.code, 2, j.all);
    assert.strictEqual(j.json.exit, 2);
    assert.strictEqual(j.json.exporter.exit, 1, `${name}: el código del hijo, tal cual`);
    assert.match(j.json.exporter.reason, reason, name);
    assert.strictEqual(j.json.exporter.findings, undefined, name);
  }
  // control: con hallazgos de verdad sigue siendo 1 (T6), y un 2 del hijo sigue siendo 2 con su motivo
  const script = labWithExporterBody(fx, 'lab-control', "  process.stderr.write('MOTIVO-DEL-HIJO: no pude\\n'); process.exitCode = 2;");
  const r = await mirrorReadOnly(fx, ['plan'], { script });
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /salió 2[\s\S]*MOTIVO-DEL-HIJO: no pude/);
});

// ── causa 10 · AC 8 ────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_ShallowInternalClone_Exit2NotAVerdict', async () => {
  const { fx, seed } = await published({ change: false });
  const fixedInGithub = '# Guía\n\nCorregida en GitHub.\n';
  const foreign = publicCommit(fx, { parents: [seed.commit], files: { 'guides/guia.md': fixedInGithub }, message: 'Un cambio mergeado en GitHub' });
  write(fx.harness, { 'guides/guia.md': fixedInGithub });
  commit(fx.harness, `fix: trae la corrección del repo público\n\nPublic-Commit: ${foreign}`);
  internalChange(fx, { 'scripts/despues.js': "'use strict';\nmodule.exports = 9;\n" });
  const shallowOf = (dir, depth) => {
    const out = path.join(path.dirname(dir), `shallow-${path.basename(dir)}-${depth}`);
    const c = spawnSync('git', ['clone', '-q', '--depth', String(depth), `file://${dir}`, out], { encoding: 'utf8', env: { ...withoutGit(process.env), ...ISOLATED } });
    assert.strictEqual(c.status, 0, c.stderr);
    assert.strictEqual(headOf(out), headOf(dir), 'control: el mismo HEAD');
    assert.strictEqual(gitFx(out, ['rev-parse', '--is-shallow-repository']), 'true', 'control: el clon es superficial');
    return out;
  };

  // control: con la historia completa, el cambio ajeno está absorbido
  let r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.foreign.map((f) => f.absorbed), [true]);

  // con el arnés superficial —traiga o no la marca en lo que trajo—, o con agent-skills superficial: «no pude leer la historia»
  const clones = [
    ['el arnés, con 1 commit', { TYCON_GUIDES_DIR: shallowOf(fx.harness, 1) }, /el arnés/],
    ['el arnés, con 2 commits', { TYCON_GUIDES_DIR: shallowOf(fx.harness, 2) }, /el arnés/],
    ['agent-skills, con 1 commit', { TYCON_SKILLS_DIR: shallowOf(fx.skills, 1) }, /agent-skills/],
  ];
  for (const [name, env, who] of clones) {
    r = await mirrorReadOnly(fx, ['plan', '--json'], { env });
    assert.strictEqual(r.code, 2, `${name}, plan: no es un veredicto\n${r.all}`);
    assert.match(r.err, /no pude leer la historia/, name);
    assert.match(r.err, /superficial/, name);
    assert.match(r.err, who, `${name}: dice de qué repo`);
    assert.strictEqual(r.json.state, undefined, `${name}: no dice «cambios ajenos sin traer»`);
    r = await syncWithoutWrites(fx, [], { env });
    assert.strictEqual(r.code, 2, `${name}, sync\n${r.all}`);
    assert.match(r.err, /no pude leer la historia/, name);
    r = await verifyRun(fx, [], { env });
    assert.strictEqual(r.code, 2, `${name}, verify: no pudo mirar (f)\n${r.all}`);
    assert.deepStrictEqual(r.json.findings, [], `${name}: sin un hallazgo que no existe`);
    assert.deepStrictEqual(r.json.couldNotLook.map((x) => x.part), ['f'], name);
    assert.match(r.json.couldNotLook[0].reason, /superficial/, name);
  }
  // un repo sin publicar no necesita la historia interna: `plan` contesta igual
  const empty = await fixture();
  r = await mirrorReadOnly(empty, ['plan', '--json'], { env: { TYCON_GUIDES_DIR: shallowOf(empty.harness, 1) } });
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.state, 'unpublished');
});

// ── lo que `verify` no miraba ──────────────────────────────────────────────────────────────────────────────────────
/** Un público recién publicado, y cómo volver a dejarlo así: `main` en la primera publicación y ninguna otra ref. */
async function verifyLab(parts = {}) {
  const fx = await fixture();
  if (Object.keys(parts).length) fx.config(parts);
  const seed = seedPublication(fx);
  const reset = () => {
    for (const ref of refsOf(fx.bare).split('\n').filter(Boolean).map((l) => l.split(' ')[0])) gitFx(fx.bare, ['update-ref', '-d', ref]);
    gitFx(fx.bare, ['update-ref', MAIN_REF, seed.commit]);
    fx.api.reset();
  };
  /** Otra primera publicación: el mismo árbol más `files`. No es un cambio ajeno. */
  const republish = (files, subject) => syncCommit(fx, seed, { files, subject, ref: MAIN_REF });
  /** Lo que queda cuando una sincronización saca algo y alguien la mergea: `old` pasa a ser historia de `main`. */
  const superseded = (old) => {
    const fixed = syncCommit(fx, seed, { parent: old });
    return publicCommit(fx, { parents: [old, fixed], from: fixed, message: 'Merge pull request #1' });
  };
  return { fx, seed, reset, republish, superseded };
}
const withoutTerm = (r, name) => assert.ok(!r.all.toLowerCase().includes(TERM.toLowerCase()), `${name}: ninguna salida trae el texto hallado\n${r.all}`);

// ── causa 3 · AC 15 ────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Verify_LooksAtEveryRefTheServerServes', async () => {
  const { fx, seed, reset } = await verifyLab();
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, `control: ${r.all}`);
  // [el caso, lo que alguien dejó en el público fuera de ramas, etiquetas y pull requests, las partes que lo encuentran]
  const cases = [
    ['una nota de git (refs/notes/commits)', () => gitFx(fx.bare, ['notes', 'add', '-m', `Revisado por pedido de ${TERM}`, seed.commit]), ["a'"]],
    ['un commit bajo otro espacio de refs, con el nombre en un archivo', () => publicCommit(fx, { parents: [seed.commit], files: { 'docs/b.md': `Lo pidió ${TERM}.\n` }, message: 'Respaldo', ref: 'refs/backup/antes' }), ["a'"]],
    ['un commit bajo otro espacio de refs, con el nombre en el mensaje', () => publicCommit(fx, { parents: [seed.commit], files: { 'docs/b.md': '# B\n' }, message: `Respaldo para ${TERM}`, ref: 'refs/backup/antes' }), ['c']],
    ['el nombre de una ref de otro espacio', () => gitFx(fx.bare, ['update-ref', `refs/backup/${TERM}`, seed.commit]), ['c']],
  ];
  for (const [name, mutate, parts] of cases) {
    reset();
    mutate();
    r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), parts, `${name}\n${r.all}`);
    assert.deepStrictEqual(r.json.couldNotLook, [], name);
    withoutTerm(r, name);
  }
});

// ── causas 2 y 15 · AC 15 ──────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Verify_PathNamesInEveryReachableTree', async () => {
  const { fx, seed, reset, republish, superseded } = await verifyLab();
  const rel = `docs/${TERM}/nota.md`;
  const clean = { [rel]: '# Nota limpia\n' };
  const guide = gitFx(fx.bare, ['show', `${seed.commit}:guides/guia.md`]);
  // [el caso, dónde queda una ruta con el nombre y el CONTENIDO limpio]: nunca en la punta de main
  const cases = [
    ['un árbol viejo de main', () => superseded(republish(clean))],
    ['la cabeza de un pull request', () => publicCommit(fx, { parents: [seed.commit], files: clean, message: 'Un aporte', ref: 'refs/pull/8/head' })],
    ['la rama de la sincronización', () => syncCommit(fx, seed, { parent: seed.commit, files: clean, ref: SYNC_REF })],
    ['un commit que sólo cuelga de una etiqueta', () => gitFx(fx.bare, ['tag', 'v0', publicCommit(fx, { parents: [seed.commit], files: clean, message: 'Una entrega', ref: null })])],
    // el mismo blob sigue en main con un nombre limpio: el contenido no es nuevo, la ruta sí
    ['un archivo renombrado, en un árbol viejo de main', () => superseded(republish({ [`docs/${TERM}.md`]: `${guide}\n` }))],
  ];
  for (const [name, mutate] of cases) {
    reset();
    mutate();
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), ["a'"], `${name}: lo dice la parte (a')\n${r.all}`);
    assert.ok(r.json.findings.every((f) => f.category === 'cliente'), `${name}\n${r.all}`);
    assert.strictEqual(r.json.findings.length, 1, `${name}: un hallazgo, el de la ruta\n${r.all}`);
    assert.match(r.json.findings[0].place, /una ruta/, `${name}: dice que es una ruta`);
    assert.match(r.json.findings[0].place, /el objeto [0-9a-f]{12}/, `${name}: y cómo ubicarla sin imprimirla`);
    withoutTerm(r, name);
    const h = await verifyPlain(fx);
    assert.strictEqual(h.code, 1, `${name}, sin --json: ${h.all}`);
    withoutTerm(h, `${name}, sin --json`);
  }
  // con el nombre también adentro: dos hallazgos en (a'), y ninguno remite a una parte que calla
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { [rel]: `Lo pidió ${TERM}.\n` }, message: 'Un aporte', ref: 'refs/pull/8/head' });
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ["a'"]);
  assert.strictEqual(r.json.findings.length, 2, r.all);
  assert.ok(r.json.findings.every((f) => !f.place.includes('la parte (b)')), `(b) no dice nada de esa ruta: no se remite a ella\n${r.all}`);
  withoutTerm(r, 'ruta y contenido');
  // control: en la punta de main lo sigue diciendo (b), y el hallazgo de adentro remite a ella
  reset();
  republish({ [rel]: `Lo pidió ${TERM}.\n` });
  r = await verifyRun(fx);
  assert.deepStrictEqual(partsOf(r), ['a', 'b'], r.all);
  assert.ok(r.json.findings.some((f) => f.place.includes('la parte (b)')), r.all);
  // y una excepción por ruta de la lista vale igual que para el exportador: la lista de rutas se mira bajo su nombre
  reset();
  const denied = denylist();
  denied.permitidos.push({ archivo: 'rutas-de-la-copia.txt', motivo: 'laboratorio: una ruta con un nombre de la lista' });
  fx.config({ denied });
  publicCommit(fx, { parents: [seed.commit], files: clean, message: 'Un aporte', ref: 'refs/pull/8/head' });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
});

// ── causas 6, 17 y 23 · AC 15 (c) ──────────────────────────────────────────────────────────────────────────────────
test('Mirror_Verify_NestedTagsAndDeclaredTagName', async () => {
  const { fx, seed, reset } = await verifyLab();
  const tagger = { GIT_COMMITTER_NAME: TERM, GIT_COMMITTER_EMAIL: 'alguien@example.com' };
  /** Una etiqueta anotada dentro de otra, con la ref de la de adentro borrada: sólo se llega por la de afuera. */
  const nested = (message, env = {}) => () => {
    gitFx(fx.bare, ['tag', '-a', 'adentro', '-m', message, seed.commit], { env });
    gitFx(fx.bare, ['tag', '-a', 'afuera', '-m', 'Entrega', 'adentro']);
    gitFx(fx.bare, ['update-ref', '-d', 'refs/tags/adentro']);
  };
  const cases = [
    ['el mensaje de una etiqueta dentro de otra', nested(`Entrega para ${TERM}`), /mensaje/],
    ['quien creó una etiqueta dentro de otra', nested('Entrega', tagger), /quien lo creó/],
    ['tres niveles', () => {
      gitFx(fx.bare, ['tag', '-a', 'uno', '-m', `Entrega para ${TERM}`, seed.commit]);
      gitFx(fx.bare, ['tag', '-a', 'dos', '-m', 'Entrega', 'uno']);
      gitFx(fx.bare, ['tag', '-a', 'tres', '-m', 'Entrega', 'dos']);
      for (const name of ['uno', 'dos']) gitFx(fx.bare, ['update-ref', '-d', `refs/tags/${name}`]);
    }, /mensaje/],
    // la receta de siempre para renombrar una etiqueta: el objeto conserva el nombre con que se lo creó
    ['el nombre que declara el objeto, distinto del de la ref', () => {
      gitFx(fx.bare, ['tag', '-a', `${TERM}-v1`, '-m', 'Entrega', seed.commit]);
      gitFx(fx.bare, ['update-ref', 'refs/tags/v1', gitFx(fx.bare, ['rev-parse', `refs/tags/${TERM}-v1`])]);
      gitFx(fx.bare, ['update-ref', '-d', `refs/tags/${TERM}-v1`]);
    }, /nombre que declara/],
  ];
  for (const [name, mutate, where] of cases) {
    reset();
    mutate();
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), ['c'], `${name}\n${r.all}`);
    assert.ok(r.json.findings.every((f) => f.category === 'cliente' && /el tag [0-9a-f]{40}/.test(f.place)), `${name}: el lugar es el tag\n${r.all}`);
    assert.ok(r.json.findings.some((f) => where.test(f.place)), `${name}: dice qué del tag\n${r.all}`);
    withoutTerm(r, name);
  }
  // control: etiquetas anidadas limpias no son un hallazgo
  reset();
  nested('Entrega')();
  const r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
});

// ── causas 11 y 22 · AC 15 (c), AC 8 ───────────────────────────────────────────────────────────────────────────────
test('Mirror_ControlByteInMessage_NothingSkipped', async () => {
  const { fx, seed, reset, republish } = await verifyLab();
  const SEP = '\x01';   // el separador que el guion ponía dentro del formato de `git log`
  // control: sin el byte, el mensaje se revisa; lo que se cuenta en (c) es el punto de comparación
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/a.md': '# A\n' }, message: `Un aporte\npara ${TERM}`, ref: 'refs/pull/7/head' });
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['c']);
  const counted = r.json.looked.c;
  const cases = [
    ['en la cabeza de un pull request', () => publicCommit(fx, { parents: [seed.commit], files: { 'docs/a.md': '# A\n' }, message: `Un aporte${SEP}para ${TERM}`, ref: 'refs/pull/7/head' }), counted],
    ['en un commit de main', () => republish({}, `Primera publicación ${SEP} para ${TERM}`), counted - 2],
  ];
  for (const [name, mutate, expected] of cases) {
    reset();
    mutate();
    r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: lo que sigue al byte también se revisa\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), ['c'], name);
    assert.match(r.json.findings[0].place, /el commit [0-9a-f]{40} \(mensaje/, name);
    assert.strictEqual(r.json.looked.c, expected, `${name}: sin un commit fantasma en la cuenta`);
    withoutTerm(r, name);
  }

  // un cambio ajeno con ese byte en el mensaje es un cambio ajeno como cualquiera: con su sha y sus rutas
  reset();
  const foreign = publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: `Un cambio${SEP}mergeado en GitHub\n\notra línea${SEP}\n` });
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.foreign, [{ commit: foreign, paths: ['docs/ajeno.md'], absorbed: false, discarded: false }]);
  // y la marca del interno se lee entera aunque el mensaje lo traiga: el descarte va en el mismo commit
  commit(fx.harness, `chore: descarta un cambio ajeno\n\nPublic-Commit: ${foreign}\n${SEP}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.foreign, [{ commit: foreign, paths: ['docs/ajeno.md'], absorbed: true, discarded: true }]);
});

test('Mirror_Verify_MessageInAnotherEncoding_StillReviewed', async () => {
  // un nombre con una letra que no es ASCII, en un commit y en una etiqueta que declaran otra codificación: el objeto
  // se lee crudo, y hay que leerlo en la codificación que dice
  const name = 'Peñalba';
  const denied = denylist();
  denied.terminos.push({ patron: name, categoria: 'cliente', palabra: true });
  const replacements = clone(REPLACEMENTS);
  replacements.pares.push({ real: name, categoria: 'cliente', palabra: true, formas: [{ texto: name, anonimo: 'ClienteB' }] });
  const { fx, seed, reset } = await verifyLab({ denied, replacements });
  const file = path.join(fx.dir, 'mensaje-latin1.txt');
  fs.writeFileSync(file, Buffer.from(`Un aporte\n\nLo pidió ${name}.\n`, 'latin1'));
  const latin1 = ['-c', 'i18n.commitEncoding=ISO-8859-1'];
  const cases = [
    ['un commit', () => {
      const sha = gitFx(fx.bare, [...latin1, 'commit-tree', seed.tree, '-p', seed.commit, '-F', file]);
      assert.match(gitFx(fx.bare, ['cat-file', 'commit', sha]), /^encoding ISO-8859-1$/m, 'control: el commit declara su codificación');
      gitFx(fx.bare, ['update-ref', 'refs/pull/7/head', sha]);
    }, /el commit [0-9a-f]{40} \(mensaje, línea 3\)/],
    // lo declarado no es lo escrito: dice ISO-8859-1 y los bytes son UTF-8. Se lee de las dos maneras
    ['un commit que declara una codificación y está escrito en otra', () => {
      const utf8 = path.join(fx.dir, 'mensaje-utf8.txt');
      fs.writeFileSync(utf8, Buffer.from(`Un aporte\n\nLo pidió ${name}.\n`, 'utf8'));
      gitFx(fx.bare, ['update-ref', 'refs/pull/7/head', gitFx(fx.bare, [...latin1, 'commit-tree', seed.tree, '-p', seed.commit, '-F', utf8])]);
    }, /el commit [0-9a-f]{40} \(mensaje, línea 3\)/],
  ];
  for (const [what, mutate, place] of cases) {
    reset();
    mutate();
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${what}: sale 1\n${r.all}`);
    assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['c cliente'], what);
    assert.match(r.json.findings[0].place, place, what);
    assert.ok(!r.all.includes(name), `${what}: sin el texto hallado`);
  }
});

// ── causas 7 y 9 · AC 15 (a') ──────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Verify_SameBlobUnderTwoPaths_VerdictPerPath', async () => {
  // una excepción POR RUTA: ese contenido, en ese archivo, está permitido
  const denied = denylist();
  denied.permitidos.push({ archivo: 'docs/permitido.md', patron: escapeRegex(TERM), motivo: 'laboratorio: el nombre, en ese archivo' });
  const { fx, seed, reset, republish } = await verifyLab({ denied });
  const content = `Lo pidió ${TERM}.\n`;
  const pull = (n, files) => publicCommit(fx, { parents: [seed.commit], files, message: 'Un aporte', ref: `refs/pull/${n}/head` });
  // control: en la ruta de la excepción no es un hallazgo, ni en main ni en la cabeza de un pull request
  for (const mutate of [() => republish({ 'docs/permitido.md': content }), () => pull(7, { 'docs/permitido.md': content })]) {
    reset();
    mutate();
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 0, `control: ${r.all}`);
  }
  // el MISMO blob, además, en una ruta sin excepción: es un hallazgo esté donde esté la otra copia y venga en el orden que venga
  const cases = [
    ['en un árbol viejo de main, con la copia permitida en la punta', () => {
      const old = republish({ 'docs/fuga.md': content });
      const fixed = syncCommit(fx, seed, { parent: old, files: { 'docs/permitido.md': content } });
      publicCommit(fx, { parents: [old, fixed], from: fixed, message: 'Merge pull request #1' });
    }, 'docs/fuga.md:1'],
    ['en el mismo commit, antes en el orden de los nombres', () => pull(7, { 'docs/permitido.md': content, 'docs/a-otra.md': content }), 'docs/a-otra.md:1'],
    ['en el mismo commit, después en el orden de los nombres', () => pull(7, { 'docs/permitido.md': content, 'docs/z-otra.md': content }), 'docs/z-otra.md:1'],
    ['en otro pull request, más viejo que el de la copia permitida', () => { pull(8, { 'docs/otra.md': content }); pull(7, { 'docs/permitido.md': content }); }, 'docs/otra.md:1'],
    ['en otro pull request, más nuevo que el de la copia permitida', () => { pull(7, { 'docs/permitido.md': content }); pull(8, { 'docs/otra.md': content }); }, 'docs/otra.md:1'],
    ['en un pull request, con la copia permitida en main', () => { republish({ 'docs/permitido.md': content }); publicCommit(fx, { parents: [tipOf(fx.bare, MAIN_REF)], files: { 'docs/otra.md': content }, message: 'Un aporte', ref: 'refs/pull/7/head' }); }, 'docs/otra.md:1'],
  ];
  for (const [name, mutate, place] of cases) {
    reset();
    mutate();
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ["a' cliente"], `${name}\n${r.all}`);
    assert.ok(r.json.findings[0].place.includes(place), `${name}: en la ruta sin excepción (${place})\n${r.all}`);
    withoutTerm(r, name);
  }
});

// ── causa 5 · AC 5 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Plan_ExporterFindings_PathThatIsAFindingNotPrinted', async () => {
  const mail = OUTSIDER.email;
  // [el caso, los archivos del interno, con la tabla de reemplazos o sin ella, la categoría del hallazgo de adentro]
  const cases = [
    ['una ruta con el nombre, y otro hallazgo adentro', { [`guides/${TERM}/nota.md`]: `# Nota\n\nEscribir a ${mail}.\n` }, true, 'email'],
    ['el nombre en la ruta y en el texto, sin par de reemplazo', { [`guides/${TERM}-alta.md`]: `# Alta\n\nLo usa ${TERM}.\n` }, false, 'cliente'],
  ];
  for (const [name, files, pairs, category] of cases) {
    const fx = await fixture();
    seedPublication(fx);
    if (!pairs) fx.config({ replacements: { pares: [], afuera: [] } });
    write(fx.harness, files);
    commit(fx.harness, 'un cambio');
    for (const args of [['plan'], ['plan', '--json'], ['sync']]) {
      const r = await mirrorReadOnly(fx, args, { credential: WRITER });
      assert.strictEqual(r.code, 1, `${name}, ${args.join(' ')}: ${r.all}`);
      withoutTerm(r, `${name}, ${args.join(' ')}`);
      assert.ok(!r.all.includes(mail), `${name}: ni el otro texto hallado`);
      assert.match(r.err, /hallazgo\(s\) en lo que se publicaría/, name);
      if (!r.json) continue;
      assert.ok(r.json.exporter.findings.some((f) => f.section === 'detector' && f.category === category && f.file === null && f.line === 3),
        `${name}: el hallazgo de adentro se cuenta, con su línea y sin su ruta\n${JSON.stringify(r.json.exporter)}`);
    }
  }
  // control: una ruta limpia sí se imprime (T6 lo prueba con README.md:3)
});

// ── del revisor de seguridad: lo que viene del público se imprime saneado ──────────────────────────────────────────
test('Mirror_Output_TextFromThePublicRepoIsSanitized', async () => {
  const { fx, seed, reset } = await verifyLab();
  const ESC = '\x1b';
  const command = '##vso[task.setvariable variable=robado]1';
  const group = '##[error]un texto que Azure pintaría como error';
  // rutas que un tercero elige: con una orden para el agente de Azure, un salto de línea, un escape de terminal, y larguísima
  const hostile = [`docs/${command}\n${group}.md`, `docs/${ESC}[31mrojo.md`, `docs/${'largo-'.repeat(200)}.md`];
  const dangerous = (r, name) => {
    assert.ok(!r.all.includes('##vso['), `${name}: ninguna orden para el agente\n${r.all}`);
    assert.ok(!r.all.includes('##['), `${name}: ni las de formato\n${r.all}`);
    assert.ok(!r.all.includes(ESC), `${name}: ningún escape de terminal`);
    assert.ok(r.all.split('\n').every((l) => l.length < 1200), `${name}: ninguna línea larguísima`);
  };

  // `verify`: el contenido trae el nombre, y el lugar del hallazgo es esa ruta
  for (const rel of hostile) {
    reset();
    publicCommit(fx, { parents: [seed.commit], files: { [rel]: `Lo pidió ${TERM}.\n` }, message: 'Un aporte', ref: 'refs/pull/7/head' });
    for (const run of [verifyRun, verifyPlain]) {
      const r = await run(fx);
      assert.strictEqual(r.code, 1, r.all);
      dangerous(r, `verify, ${JSON.stringify(rel.slice(0, 30))}`);
      if (r.json) {
        assert.deepStrictEqual(partsOf(r), ["a'"]);
        assert.ok(r.json.findings.every((f) => !/[\x00-\x1f\x7f]/.test(f.place) && f.place.length < 600), `el lugar, en una línea acotada\n${JSON.stringify(r.json.findings)}`);
        assert.ok(r.json.findings[0].place.startsWith('docs/'), 'y sigue diciendo dónde');
      } else {
        assert.strictEqual(r.out.split('\n').filter((l) => l.startsWith('  · ')).length, 1, `un hallazgo, en una línea\n${r.out}`);
      }
    }
  }

  // `plan` y `sync`: las rutas de un cambio ajeno, y las de lo que se borraría
  for (const rel of [...hostile, 'docs/a.md\n```\n\n# Un título que no es del guion\n\n```text\nb.md']) {
    const { fx: other, seed: published } = await verifyLab();
    const foreign = publicCommit(other, { parents: [published.commit], files: { [rel]: '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
    for (const args of [['plan'], ['plan', '--json'], ['sync']]) {
      const r = await mirrorReadOnly(other, args, { credential: WRITER });
      assert.strictEqual(r.code, 1, `${args.join(' ')}: ${r.all}`);
      assert.ok(r.all.includes(foreign), 'control: nombra el commit');
      dangerous(r, `${args.join(' ')}, cambio ajeno`);
      if (r.json) assert.ok(r.json.foreign[0].paths.every((p) => !/[\x00-\x1f\x7f]/.test(p) && p.length < 400), JSON.stringify(r.json.foreign));
    }
    commit(other.harness, `chore: descarta un cambio ajeno\n\nPublic-Commit: ${foreign}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
    let r = await mirrorReadOnly(other, ['plan', '--json']);
    assert.strictEqual(r.code, 0, r.all);
    assert.deepStrictEqual(r.json.paths.map((p) => p.status), ['deleted']);
    assert.ok(!/[\x00-\x1f\x7f]/.test(r.json.paths[0].path) && r.json.paths[0].path.length < 400, JSON.stringify(r.json.paths));
    dangerous(r, 'plan, lo que se borraría');
    // y el cuerpo del pull request, que es público: la ruta va en UNA línea, sin poder cerrar el bloque ni abrir otro
    r = await syncRun(other, ['--json']);
    assert.strictEqual(r.code, 0, r.all);
    dangerous(r, 'sync');
    const body = other.api.state.pulls[0].body;
    assert.strictEqual(body.split('\n').filter((l) => /^[+~-] /.test(l)).length, 1, `una ruta, una línea\n${body}`);
    assert.strictEqual(body.split('\n').filter((l) => l.startsWith('```')).length, 2, `el bloque de rutas se abre y se cierra una vez\n${body}`);
    assert.ok(!body.includes(ESC) && body.split('\n').every((l) => l.length < 400), body);
  }

  // lo que dice GitHub al rechazar un push sale tal cual, salvo lo que el agente leería como una orden
  reset();
  internalChange(fx);
  const hook = path.join(fx.bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, ['#!/bin/sh', 'cat > /dev/null', `echo "error: GH006: rama protegida" >&2`, `echo "${command}" >&2`, 'exit 1', ''].join('\n'));
  fs.chmodSync(hook, 0o755);
  const r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.ok(r.err.includes('remote: error: GH006: rama protegida'), `el texto de GitHub, tal cual\n${r.err}`);
  assert.ok(r.err.includes('task.setvariable variable=robado'), 'control: la línea está');
  dangerous(r, 'un push rechazado');
});

// ── contrato de la salida ──────────────────────────────────────────────────────────────────────────────────────────
// ── causa 12 · AC 4, 8 ─────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Foreign_PathsAreTheRealPaths', async () => {
  const { fx, seed } = await published({ change: false });
  // rutas que git, sin que se lo pidan de otra manera, escribe entre comillas y con escapes
  const files = { 'guides/guía nueva.md': '# Guía nueva\n', 'docs/con "comillas".md': '# Comillas\n', 'docs/con\ttabulador.md': '# Tabulador\n' };
  const real = ['docs/con?tabulador.md', 'docs/con "comillas".md', 'guides/guía nueva.md'];   // el de control, en una línea
  const foreign = publicCommit(fx, { parents: [seed.commit], files, message: 'Un cambio mergeado en GitHub' });
  let r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.foreign, [{ commit: foreign, paths: real, absorbed: false, discarded: false }], 'las rutas, como son');
  r = await mirrorReadOnly(fx, ['plan']);
  assert.ok(r.all.includes(`· ${foreign} — ${real.join(', ')}`), `el mensaje dice las mismas\n${r.all}`);
  // absorbido: las dos listas de rutas de la misma salida dicen lo mismo
  commit(fx.harness, `chore: descarta un cambio ajeno\n\nPublic-Commit: ${foreign}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
  r = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.paths.map((p) => p.path), real);
  assert.deepStrictEqual(r.json.foreign[0].paths, r.json.paths.map((p) => p.path), 'la de los cambios ajenos y la de lo que cambiaría');
  // la raíz de un público que no salió de una publicación también
  const alien = await fixture();
  const root = publicCommit(alien, { files: { 'guides/guía.md': '# Otra\n' }, message: 'Initial commit' });
  r = await mirrorReadOnly(alien, ['plan', '--json']);
  assert.deepStrictEqual(r.json.foreign.map((f) => `${f.commit} ${f.paths.join(',')}`), [`${root} guides/guía.md`]);
});

// ── causa 26 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Json_EveryRunCarriesItsMessage', async () => {
  const fx = await fixture();
  const said = [];
  /** Corre con --json y devuelve el objeto: toda corrida trae `command`, `exit` y un `message` que dice algo. */
  const run = async (args, opts = {}) => {
    const r = await mirror(fx, [...args, '--json'], { credential: WRITER, ...opts });
    assert.ok(r.json, `${args.join(' ')}: ${r.all}`);
    assert.strictEqual(r.json.command, args[0]);
    assert.strictEqual(r.json.exit, r.code, args.join(' '));
    assert.ok(typeof r.json.message === 'string' && r.json.message.trim().length > 0, `${args.join(' ')} (exit ${r.code}): trae message\n${r.out}`);
    said.push(`${args.join(' ')} → ${r.code}`);
    return r.json;
  };
  let j = await run(['plan']);
  assert.strictEqual(j.message, 'no publicado');
  j = await run(['first']);
  assert.strictEqual(j.exit, 0, JSON.stringify(j));
  assert.match(j.message, /primera publicación/);
  assert.ok(typeof j.verify.message === 'string' && /sin hallazgos/.test(j.verify.message), 'el verify de adentro también');
  j = await run(['verify', '--strict']);
  assert.strictEqual(j.exit, 0);
  assert.strictEqual(j.message, 'sin hallazgos');
  j = await run(['verify'], { credential: null });
  assert.strictEqual(j.exit, 0);
  assert.match(j.message, /sin hallazgos.*NO MEDIDO \(g\)/, 'lo que no se midió también se dice ahí');
  j = await run(['plan']);
  assert.strictEqual(j.message, 'sin cambios');
  j = await run(['sync']);
  assert.strictEqual(j.message, 'sin cambios');
  internalChange(fx);
  j = await run(['plan']);
  assert.strictEqual(j.message, 'cambios');
  j = await run(['sync']);
  assert.strictEqual(j.message, 'cambios');
  // y las que frenan, como siempre
  j = await run(['first']);
  assert.strictEqual(j.exit, 2);
  fx.api.state.vulnerabilityReporting = { enabled: false };
  j = await run(['verify']);
  assert.strictEqual(j.exit, 1);
  j = await run(['sync'], { credential: null });
  assert.strictEqual(j.exit, 2);
  assert.strictEqual(said.length, 11);
});

// ── del revisor de fallos silenciosos: lo que quedó hecho cuando el paso siguiente falla ───────────────────────────
test('Mirror_Sync_FailsAfterPush_SaysWhatWasDone', async () => {
  const failing = (method, pattern, status = 500) => (q) => (q.method === method && pattern.test(q.path) ? { status, json: { message: 'Server Error' } } : null);

  // crear el pull request falla, con la rama recién empujada
  let { fx } = await published();
  fx.api.override = failing('POST', /\/pulls$/);
  let r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF], 'control: el empuje llegó');
  assert.strictEqual(r.json.outcome, 'incomplete');
  assert.strictEqual(r.json.pushed, true, 'el --json dice que empujó');
  assert.strictEqual(r.json.commit, tipOf(fx.bare, SYNC_REF), 'y qué commit');
  assert.strictEqual(r.json.pullRequest, null, 'y que no hay pull request');
  assert.strictEqual(r.json.state, 'changes');
  assert.match(r.json.message, /la API contestó 500 al crear el pull request/);
  assert.match(r.err, /Lo que quedó hecho: el commit [0-9a-f]{12} se empujó a mirror\/sync/);
  assert.match(r.err, /la corrida siguiente lo crea sin volver a empujar/i);
  // la misma, otra vez: ya no empuja, y lo dice
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(r.pushed, []);
  assert.strictEqual(r.json.pushed, false);
  assert.strictEqual(r.json.commit, tipOf(fx.bare, SYNC_REF));
  assert.match(r.err, /ya estaba en mirror\/sync/);

  // actualizar el pull request falla, con la rama recién empujada
  ({ fx } = await published());
  r = await syncRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  const before = fx.api.state.pulls[0].body;
  internalChange(fx);
  fx.api.override = failing('PATCH', /\/pulls\/1$/);
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 2, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.strictEqual(r.json.outcome, 'incomplete');
  assert.strictEqual(r.json.pushed, true);
  assert.strictEqual(r.json.commit, tipOf(fx.bare, SYNC_REF));
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'not-updated' });
  assert.match(r.json.message, /la API contestó 500 al actualizar el pull request nº 1/);
  assert.match(r.err, /se empujó a mirror\/sync/, 'el texto también lo dice al actualizar');
  assert.match(r.err, /el pull request nº 1 quedó con el texto de antes/);
  assert.strictEqual(fx.api.state.pulls[0].body, before, 'control: el pull request quedó como estaba');
  // la corrida siguiente lo actualiza sin volver a empujar
  fx.api.override = null;
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, []);
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'updated' });

  // cerrar el pull request (ya no hay diferencias): falla el cierre con el comentario ya escrito, o falla el comentario
  const stale = () => [{ number: 4, state: 'open', title: 'Sincronización', body: 'Lo de antes', head: { ref: 'mirror/sync' }, base: { ref: 'main' } }];
  for (const [name, override, action, text, writes] of [
    ['falla el cierre', failing('PATCH', /\/pulls\/4$/), 'commented', /el comentario ya quedó escrito en el pull request nº 4, que sigue abierto/, 1],
    ['falla el comentario', failing('POST', /\/issues\/4\/comments$/), 'not-closed', /el pull request nº 4 quedó sin tocar/, 0],
  ]) {
    ({ fx } = await published({ change: false }));
    fx.api.state.pulls = stale();
    fx.api.override = override;
    r = await syncRun(fx, ['--json']);
    assert.strictEqual(r.code, 2, `${name}: ${r.all}`);
    assert.deepStrictEqual(r.pushed, [], name);
    assert.strictEqual(r.json.outcome, 'incomplete', name);
    assert.strictEqual(r.json.pushed, false, name);
    assert.deepStrictEqual(r.json.pullRequest, { number: 4, action }, name);
    assert.deepStrictEqual(r.json.closed, [], name);
    assert.strictEqual(r.json.state, 'unchanged', name);
    assert.match(r.err, text, name);
    assert.strictEqual(fx.api.state.comments.length, writes, `${name}: control`);
    assert.strictEqual(openPulls(fx).length, 1, `${name}: sigue abierto`);
  }
});

// ── la segunda vuelta de seguridad: tres lugares donde `verify` daba «limpio» sin haber mirado ─────────────────────
test('Mirror_Verify_ReplaceRefs_NeverHideWhatIsPublished', async () => {
  const { fx, seed, reset } = await verifyLab();
  /** Lo que hace `git replace` en el público: desde ahí, git lee `clean` cada vez que le piden `hidden`. */
  const replace = (hidden, clean) => gitFx(fx.bare, ['update-ref', `refs/replace/${hidden}`, clean]);
  const cases = [
    ['un commit con el nombre en el mensaje, tapado por uno limpio', () => {
      const hidden = publicCommit(fx, { parents: [seed.commit], files: { 'docs/a.md': '# A\n' }, message: `Un aporte para ${TERM}`, ref: 'refs/pull/7/head' });
      replace(hidden, publicCommit(fx, { parents: [seed.commit], files: { 'docs/a.md': '# A\n' }, message: 'Un aporte', ref: null }));
      return hidden;
    }, 'c', (hidden) => new RegExp(`el commit ${hidden} \\(mensaje`)],
    ['un archivo de main con el nombre adentro, tapado por uno limpio', () => {
      syncCommit(fx, seed, { files: { 'docs/nota.md': `Lo pidió ${TERM}.\n` }, ref: MAIN_REF });
      const hidden = gitFx(fx.bare, ['rev-parse', 'refs/heads/main:docs/nota.md']);
      replace(hidden, gitFx(fx.bare, ['hash-object', '-w', '--stdin'], { input: 'Nada que ver.\n' }));
      return hidden;
    }, 'a', () => /docs\/nota\.md:1/],
  ];
  for (const [name, mutate, part, place] of cases) {
    reset();
    const hidden = mutate();
    assert.notStrictEqual(gitFx(fx.bare, ['cat-file', '-p', hidden]), gitFx(fx.bare, ['--no-replace-objects', 'cat-file', '-p', hidden]), `${name}: control, el reemplazo tapa el objeto`);
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    const found = r.json.findings.map((f) => `${f.part} ${f.category}`);
    assert.ok(found.includes(`${part} cliente`), `${name}: lo publicado se lee tal cual, sin el reemplazo\n${r.all}`);
    assert.ok(r.json.findings.some((f) => f.category === 'cliente' && place(hidden).test(f.place)), `${name}: con su lugar\n${r.all}`);
    assert.ok(found.includes('c replace-ref'), `${name}: y la ref de reemplazo es un hallazgo\n${r.all}`);
    withoutTerm(r, name);
  }
  // una ref de reemplazo que no tapa nada sucio también se dice: nunca es «limpio»
  reset();
  replace(seed.commit, syncCommit(fx, seed, {}));
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(r.json.findings.map((f) => `${f.part} ${f.category}`), ['c replace-ref']);
  assert.match(r.json.findings[0].place, /una ref de reemplazo/);
  const h = await verifyPlain(fx);
  assert.match(h.out, /\[replace-ref\] .*una ref de reemplazo/);
  // control: sin refs de reemplazo, 0
  reset();
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
});

test('Mirror_Verify_WideEncodingOrUnknown_ReviewedOrCouldNotLook', async () => {
  const { fx, seed, reset } = await verifyLab();
  const stamp = '1700009000 +0000';
  /** Un commit escrito crudo en el público (git no deja crear uno con bytes nulos): encabezados, y el mensaje en esos bytes. */
  const rawCommit = ({ encoding, message, author = 'Fixture <fixture@example.com>', ref = 'refs/pull/7/head' }) => {
    const head = [`tree ${seed.tree}`, `parent ${seed.commit}`, `author ${author} ${stamp}`, `committer Fixture <fixture@example.com> ${stamp}`,
      ...(encoding ? [`encoding ${encoding}`] : []), '', ''].join('\n');
    const file = path.join(fx.dir, `objeto-${++serial}`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(head, 'utf8'), message]));
    const sha = gitFx(fx.bare, ['hash-object', '-t', 'commit', '-w', '--literally', file]);
    gitFx(fx.bare, ['update-ref', ref, sha]);
    return sha;
  };
  const text = `Un aporte\n\npara ${TERM}\n`;
  const be = (s) => Buffer.from(s, 'utf16le').swap16();
  // [el caso, el commit]: el nombre está en el mensaje, en 16 bits
  const reviewed = [
    ['UTF-16 con marca de orden', { encoding: 'UTF-16', message: Buffer.from(`﻿${text}`, 'utf16le') }],
    ['UTF-16 sin marca de orden', { encoding: 'UTF-16', message: Buffer.from(text, 'utf16le') }],
    // un byte más en los encabezados: el mensaje empieza en la otra paridad, y leer el objeto entero en 16 bits lo pierde
    ['UTF-16, con los encabezados de otro largo', { encoding: 'UTF-16', message: Buffer.from(text, 'utf16le'), author: 'Fixtures <fixture@example.com>' }],
    ['UTF-16, y los bytes en el otro orden', { encoding: 'UTF-16', message: be(`﻿${text}`) }],
    ['UTF-16BE', { encoding: 'UTF-16BE', message: be(text) }],
    ['UCS-2', { encoding: 'UCS-2', message: Buffer.from(text, 'utf16le') }],
    // la codificación declarada no es la de los bytes: se mira de las dos maneras
    ['declara ISO-8859-1 y el mensaje está en UTF-8', { encoding: 'ISO-8859-1', message: Buffer.from(text, 'utf8') }],
    ['en un commit de main', { encoding: 'UTF-16', message: Buffer.from(text, 'utf16le'), ref: MAIN_REF }],
  ];
  for (const [name, commit] of reviewed) {
    reset();
    const sha = rawCommit(commit);
    const r = await verifyRun(fx);
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.ok(r.json.findings.some((f) => f.part === 'c' && f.category === 'cliente' && f.place.startsWith(`el commit ${sha} (mensaje, línea 3`)), `${name}: el mensaje se revisó\n${r.all}`);
    assert.strictEqual(r.json.findings.filter((f) => f.part === 'c' && f.category === 'cliente').length, 1, `${name}: una vez, se lea como se lea\n${r.all}`);
    withoutTerm(r, name);
  }
  // lo que no se puede leer con certeza no sale limpio: «no pude mirar» (2)
  const unsure = [
    ['una codificación de 32 bits', { encoding: 'UTF-32', message: Buffer.from(text, 'utf16le') }],
    ['una codificación que nadie conoce', { encoding: 'x-inventada', message: Buffer.from(text, 'utf8').map((b) => b ^ 0x80) }],
    ['16 bits sin declararlo', { encoding: null, message: Buffer.from(text, 'utf16le') }],
    ['16 bits, declarando otra de 8', { encoding: 'ISO-8859-1', message: Buffer.from(text, 'utf16le') }],
  ];
  for (const [name, commit] of unsure) {
    reset();
    const sha = rawCommit(commit);
    for (const args of [[], ['--strict']]) {
      const r = await verifyRun(fx, args, { credential: READER });
      assert.strictEqual(r.code, 2, `${name} ${args.join(' ')}: sale 2, no 0\n${r.all}`);
      assert.deepStrictEqual(r.json.couldNotLook.map((x) => x.part), ['c'], `${name}\n${r.all}`);
      assert.ok(r.json.couldNotLook[0].reason.includes(`el commit ${sha}`), `${name}: dice cuál\n${r.all}`);
      assert.match(r.json.couldNotLook[0].reason, /codificación/, name);
      assert.match(r.err, /no pude mirar \(c\)/, name);
      withoutTerm(r, name);
    }
    const h = await verifyPlain(fx);
    assert.match(h.out, /\(c\) .*: NO PUDE MIRAR/, name);
  }
  // un tag que declara una codificación que no se sabe leer, igual
  reset();
  const tag = path.join(fx.dir, 'tag-crudo');
  fs.writeFileSync(tag, Buffer.concat([Buffer.from(`object ${seed.commit}\ntype commit\ntag v1\ntagger Fixture <fixture@example.com> ${stamp}\nencoding UTF-32\n\n`, 'utf8'), Buffer.from(text, 'utf16le')]));
  const sha = gitFx(fx.bare, ['hash-object', '-t', 'tag', '-w', '--literally', tag]);
  gitFx(fx.bare, ['update-ref', 'refs/tags/v1', sha]);
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.ok(r.json.couldNotLook[0].reason.includes(`el tag ${sha}`), r.all);
  // con un hallazgo además: 1, y las dos cosas dichas
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/a.md': `Lo pidió ${TERM}.\n` }, message: 'Un aporte', ref: 'refs/pull/9/head' });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ["a'"]);
  assert.deepStrictEqual(r.json.couldNotLook.map((x) => x.part), ['c']);
  // control: un mensaje en UTF-8 con una letra que no es ASCII no es «no pude»
  reset();
  rawCommit({ encoding: null, message: Buffer.from('Un aporte, con eñe y acentos: está bien.\n', 'utf8') });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
});

test('Mirror_Git_NeverFollowsRedirects', async () => {
  // al nivel de los argumentos: toda llamada de git que habla con el público lleva la opción
  for (const command of ['plan', 'first', 'sync', 'verify']) {
    const fx = await fixture();
    if (command !== 'first') seedPublication(fx);
    if (command === 'sync') internalChange(fx);
    const github = fakeGit(fx);
    const r = await mirror(fx, [command], { credential: WRITER, env: github.env });
    assert.strictEqual(r.code, 0, `${command}: ${r.all}`);
    const remote = remoteCalls(github);
    const kinds = { plan: ['ls-remote', 'fetch'], first: ['ls-remote', 'push', 'fetch'], sync: ['ls-remote', 'fetch', 'push'], verify: ['fetch'] }[command];
    for (const kind of kinds) assert.ok(remote.some((c) => c.args.includes(` ${kind} `)), `${command}: control, hubo un ${kind}`);
    for (const c of remote) assert.ok(c.args.includes(' -c http.followRedirects=false '), `${command}: sin seguir redirecciones (${c.args.slice(0, 120)})`);
  }

  // y de verdad: el servidor del público contesta una redirección a otro servidor. Nadie la sigue, y el token no viaja
  const fx = await fixture();
  const b = await listener();
  const a = await listener((req) => ({ Location: `http://127.0.0.1:${b.port}${req.url}` }));
  try {
    for (const command of ['plan', 'first', 'sync', 'verify']) {
      const before = a.seen.length;
      const r = await mirrorReadOnly(fx, [command, '--json'], { credential: WRITER, env: { TYCON_MIRROR_GIT_BASE: `http://127.0.0.1:${a.port}` } });
      assert.strictEqual(r.code, 2, `${command}: sale 2\n${r.all}`);
      assert.ok(a.seen.length > before, `${command}: control, git le habló al servidor del público`);
      assert.match(command === 'verify' ? r.json.couldNotLook[0].reason : r.json.message, /no pude leer/, command);
      assert.ok(!r.all.includes(String(b.port)), `${command}: sin la dirección a la que mandaban`);
    }
    assert.deepStrictEqual(b.seen, [], 'el otro servidor no recibió nada: ni el pedido, ni la cabecera con el token');
  } finally {
    await a.close();
    await b.close();
  }
});

// ══ story 8.13, tanda D (AC 24, T30) — la versión numerada: `version.json` ══════════════════════════════════════════
// La mitad del espejo de T30 (la del exportador está en export.test.js). Lo que no se puede perder:
//   · que una sincronización sin cambios publicables no numere ni empuje;
//   · que el número sea función de lo publicado y de los commits internos, nunca del reloj: un reintento da el mismo commit;
//   · que dos sincronizaciones del mismo día den `.1` y `.2`, con merge en el medio o sin él;
//   · que `verify` valide el archivo en su parte (i), y que su ausencia en un `main` que nunca lo tuvo no sea un hallazgo.
// LAS FECHAS VAN FIJADAS A MANO: el reloj de la fixture es global a este archivo (cada commit, cien segundos después del
// anterior) y cruza la medianoche UTC según cuántas pruebas corrieron antes. Acá cada commit interno lleva su fecha.
const VERSION_FILE = 'version.json';
const DAY_ONE = '2030.01.15';
const DAY_TWO = '2030.01.16';
const utcAt = (day, hour, minute = 0) => {
  const [y, m, d] = day.split('.').map(Number);
  return Date.UTC(y, m - 1, d, hour, minute, 0) / 1000;
};

/** Un cambio en el arnés interno de mentira con la fecha de committer FIJADA: de ella sale la fecha de la versión. */
function internalChangeAt(fx, epoch, files) {
  changeCount += 1;
  write(fx.harness, files || { [`scripts/cambio-${changeCount}.js`]: `'use strict';\nmodule.exports = ${changeCount};\n` });
  const date = `@${epoch} +0000`;
  gitFx(fx.harness, ['add', '-A']);
  gitFx(fx.harness, ['commit', '-q', '-m', `un cambio interno (${changeCount})`], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  return headOf(fx.harness);
}

/** El `version.json` de una ref del público: su texto, leído (o `null` si esa ref no lo trae) y su blob. */
function versionOf(fx, ref) {
  const blob = gitFx(fx.bare, ['rev-parse', '--verify', '--quiet', `${ref}:${VERSION_FILE}`], { tolerate: true });
  if (blob.status !== 0) return null;
  const text = gitFx(fx.bare, ['show', `${ref}:${VERSION_FILE}`], { tolerate: true }).stdout;
  return { blob: blob.stdout.trim(), text, json: JSON.parse(text) };
}
const versionText = (version, harness, skills) => require(EXPORTER).versionFileBytes({ version, source: { harness, agent_skills: skills } }).toString('utf8');

/**
 * Una sincronización armada a mano en el público, con la fecha a elección y el `version.json` que se le pase (`file`: un
 * texto; `null` lo saca; sin `file`, queda el del árbol de partida). Los trailers son los de `seed`: así se rompe UNA cosa.
 */
function datedSync(fx, seed, { parent = null, from = parent || seed.commit, epoch, file, ref = null }) {
  const date = `@${epoch} +0000`;
  return publicCommit(fx, {
    parents: parent ? [parent] : [], from, ref, files: file === undefined ? {} : { [VERSION_FILE]: file },
    identity: { ...mirrorIdentity(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    message: (tree) => `Sincronización\n\nMirror-Harness-Commit: ${seed.harness}\nMirror-Agent-Skills-Commit: ${seed.skills}\nMirror-Tree: ${tree}\n`,
  });
}

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — la regla del número: la fecha por aritmética y el orden en el día', () => {
  // 🔴 rojo previo: «rule.versionDay is not a function» (mirror.js no exportaba la regla)
  const rule = require(MIRROR);
  // la fecha UTC de un instante, sin el reloj ni el huso de la máquina: contra la de node, barriendo de 1970 a 2100
  const iso = (epoch) => new Date(epoch * 1000).toISOString().slice(0, 10).replace(/-/g, '.');
  for (const epoch of [0, 86399, 86400, utcAt('2000.02.29', 0), utcAt('2000.02.29', 23, 59), utcAt('2024.02.29', 12), utcAt('2024.12.31', 23, 59),
    utcAt('2025.01.01', 0), utcAt('2030.01.15', 0), utcAt('2030.01.15', 23, 59), utcAt('2100.02.28', 23, 59), utcAt('2100.03.01', 0)]) {
    assert.strictEqual(rule.versionDay(epoch), iso(epoch), `la fecha de ${epoch}`);
  }
  for (let epoch = 0; epoch < utcAt('2100.12.31', 0); epoch += 37 * 3600 + 11) {
    if (rule.versionDay(epoch) !== iso(epoch)) assert.fail(`la fecha de ${epoch}: ${rule.versionDay(epoch)}, y es ${iso(epoch)}`);
  }
  assert.strictEqual(rule.versionDay(utcAt(DAY_ONE, 23, 59)), DAY_ONE);
  // lo que no es un instante no da una fecha inventada
  for (const bad of [NaN, -1, 1.5, '1700000000', null, undefined]) assert.throws(() => rule.versionDay(bad), /fecha/, `versionDay(${String(bad)})`);

  // el orden en el día (D1): 1 + el mayor de los publicados con ESA fecha; si ninguno es de esa fecha, 1
  const cases = [
    [[], `${DAY_ONE}.1`, 'nada publicado'],
    [[null, null], `${DAY_ONE}.1`, 'ni main ni la rama lo traen'],
    [[`${DAY_ONE}.1`, null], `${DAY_ONE}.2`, 'main trae el .1 del día'],
    [[null, `${DAY_ONE}.1`], `${DAY_ONE}.2`, 'la rama trae el .1 del día y main nada'],
    [[`${DAY_ONE}.1`, `${DAY_ONE}.4`], `${DAY_ONE}.5`, 'el mayor de los dos'],
    [[`${DAY_ONE}.4`, `${DAY_ONE}.1`], `${DAY_ONE}.5`, 'el mayor, esté donde esté'],
    [[`${DAY_ONE}.9`, null], `${DAY_ONE}.10`, 'el orden es un número, no un texto'],
    [['2030.01.14.7', '2029.12.31.3'], `${DAY_ONE}.1`, 'los de otra fecha no cuentan'],
    [['2030.01.14.7', `${DAY_ONE}.2`], `${DAY_ONE}.3`, 'sólo cuenta el de la misma fecha'],
    [[`${DAY_TWO}.6`, null], `${DAY_ONE}.1`, 'uno de una fecha posterior tampoco'],
  ];
  for (const [published, expected, name] of cases) assert.strictEqual(rule.nextVersion(DAY_ONE, published), expected, name);
  // un publicado sin forma no se cuenta como «no hay»: tira
  for (const bad of ['1.2', `${DAY_ONE}.0`, `${DAY_ONE}+abc1234`, 7]) assert.throws(() => rule.nextVersion(DAY_ONE, [bad]), /forma/, `nextVersion con ${String(bad)}`);
  assert.throws(() => rule.nextVersion('2030.1.15', []), /fecha/);

  // A18: sin `faketime` ni una variable que mueva la fecha — el código de la versión no lee el reloj, y eso se afirma acá
  for (const file of [MIRROR, EXPORTER]) {
    const source = fs.readFileSync(file, 'utf8');
    const reads = source.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /\bDate\b|performance\.now|hrtime/.test(line));
    assert.deepStrictEqual(reads.map(([n]) => n), [], `${path.basename(file)} no lee el reloj: ni Date, ni performance.now, ni hrtime`);
  }
});

// T62 (story 8.26, tanda E · AC 44): la fecha y el número que sigue viven en UN lugar, scripts/setup/harness/version-order.js
// (que viaja en la copia: lo usa también el merge por pedido). La sincronización los toma de ahí.
test('T62 NextVersion_OneImplementation_SharedWithTheSync', () => {
  // 🔴 rojo previo: «shared.day is not a function» (version-order.js sólo comparaba)
  const rule = require(MIRROR);
  const shared = require(path.join(path.dirname(MIRROR), '..', 'setup', 'harness', 'version-order.js'));
  const outcome = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e.message }; } };
  // los mismos resultados y los mismos motivos, entrada por entrada
  for (const epoch of [0, 86399, 86400, utcAt('2000.02.29', 23, 59), utcAt(DAY_ONE, 0), utcAt(DAY_ONE, 23, 59), NaN, -1, 1.5, '1700000000', null, undefined]) {
    assert.deepStrictEqual(outcome(() => rule.versionDay(epoch)), outcome(() => shared.day(epoch)), `la fecha de ${String(epoch)}`);
  }
  const lists = [[], [null, null], [`${DAY_ONE}.1`, null], [`${DAY_ONE}.4`, `${DAY_ONE}.1`], [`${DAY_ONE}.9`, null], ['2030.01.14.7', `${DAY_ONE}.2`],
    [`${DAY_TWO}.6`, null], ['1.2'], [`${DAY_ONE}.0`], [`${DAY_ONE}+abc1234`], [7]];
  for (const published of lists) {
    assert.deepStrictEqual(outcome(() => rule.nextVersion(DAY_ONE, published)), outcome(() => shared.next(DAY_ONE, published)), `el número que sigue a ${JSON.stringify(published)}`);
  }
  assert.deepStrictEqual(outcome(() => rule.nextVersion('2030.1.15', [])), outcome(() => shared.next('2030.1.15', [])));
  // la sincronización sigue saliendo con su código de «no pude» (2), no con un error suelto
  assert.throws(() => rule.nextVersion(DAY_ONE, ['1.2']), (e) => e.exit === 2 && /forma/.test(e.message));
  assert.throws(() => rule.versionDay(-1), (e) => e.exit === 2 && /fecha/.test(e.message));
  // y no hay dos copias de la cuenta: mirror.js llama a la compartida
  const source = fs.readFileSync(MIRROR, 'utf8');
  assert.match(source, /versionOrder\(\)\.day\(/, 'mirror.js toma la fecha de version-order.js');
  assert.match(source, /versionOrder\(\)\.next\(/, 'mirror.js toma el número que sigue de version-order.js');
  assert.doesNotMatch(source, /146097/, 'la cuenta del calendario ya no está copiada en mirror.js');
  // la compartida tampoco lee el reloj
  const sharedSource = fs.readFileSync(path.join(path.dirname(MIRROR), '..', 'setup', 'harness', 'version-order.js'), 'utf8');
  assert.doesNotMatch(sharedSource, /\bDate\b|performance\.now|hrtime/, 'version-order.js no lee el reloj');
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — dos sincronizaciones del mismo día dan .1 y .2, con merge en el medio y sin él; el merge no cambia el número; el día siguiente vuelve a .1', async () => {
  // 🔴 rojo previo: `r.json.version` undefined (sync no numeraba) y el commit sin version.json
  for (const merged of [true, false]) {
    const name = merged ? 'con merge en el medio' : 'sin merge en el medio';
    const { fx, seed } = await published({ change: false });
    assert.strictEqual(versionOf(fx, MAIN_REF), null, 'control: la primera publicación de la fixture salió sin version.json');

    internalChangeAt(fx, utcAt(DAY_ONE, 10));
    let r = await syncRun(fx, ['--json']);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.deepStrictEqual(r.pushed, [SYNC_REF], name);
    assert.strictEqual(r.json.version, `${DAY_ONE}.1`, `${name}: la primera del día`);
    const one = tipOf(fx.bare, SYNC_REF);
    assertMirrorCommit(fx, one, { parents: [seed.commit], tree: r.json.tree, subject: 'Sincronización', version: `${DAY_ONE}.1` }, name);
    assert.notStrictEqual(r.json.tree, r.json.exportedTree, `${name}: el árbol final no es el de la exportación: lleva version.json`);
    // el archivo no cuenta entre los cambios ni figura entre las rutas; el cuerpo del pull request dice la versión
    assert.deepStrictEqual(r.json.counts, { added: 1, modified: 0, deleted: 0 }, `${name}: las cuentas no cuentan version.json`);
    assert.ok(!r.json.paths.some((p) => p.path === VERSION_FILE), `${name}: ni lo listan`);
    assert.ok(openPulls(fx)[0].body.split('\n').includes(`Versión \`${DAY_ONE}.1\``), `${name}: el cuerpo dice la versión\n${openPulls(fx)[0].body}`);
    assert.ok(!openPulls(fx)[0].body.includes(VERSION_FILE), `${name}: y no lista el archivo`);

    if (merged) mergeSync(fx);
    internalChangeAt(fx, utcAt(DAY_ONE, 18));
    r = await syncRun(fx, ['--json']);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.deepStrictEqual(r.pushed, [SYNC_REF], name);
    assert.strictEqual(r.json.version, `${DAY_ONE}.2`, `${name}: la segunda del mismo día`);
    const two = tipOf(fx.bare, SYNC_REF);
    assertMirrorCommit(fx, two, { parents: [tipOf(fx.bare, MAIN_REF)], tree: r.json.tree, subject: 'Sincronización', version: `${DAY_ONE}.2` }, name);
    assert.deepStrictEqual(r.json.counts, { added: merged ? 1 : 2, modified: 0, deleted: 0 }, `${name}: las cuentas, contra main`);
    assert.ok(openPulls(fx)[0].body.split('\n').includes(`Versión \`${DAY_ONE}.2\``), `${name}: el cuerpo dice la versión nueva`);

    // el merge del pull request no cambia el número: la versión estable ES la que había en la rama
    const before = versionOf(fx, SYNC_REF);
    mergeSync(fx);
    const stable = versionOf(fx, MAIN_REF);
    assert.strictEqual(stable.blob, before.blob, `${name}: en main, el mismo archivo`);
    assert.strictEqual(stable.json.version, `${DAY_ONE}.2`, name);
    r = await syncWithoutWrites(fx, ['--json']);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.strictEqual(r.json.outcome, 'unchanged', `${name}: mergeado, sin cambios (se compara sin version.json)`);
    assert.strictEqual(r.json.version, `${DAY_ONE}.2`, `${name}: la versión que quedó publicada`);
    assert.strictEqual(r.json.tree, gitFx(fx.bare, ['rev-parse', `${MAIN_REF}^{tree}`]), `${name}: y su árbol, el de main`);
    const planned = await mirrorReadOnly(fx, ['plan', '--json']);
    assert.strictEqual(planned.json.state, 'unchanged', `${name}: ${planned.all}`);
    assert.strictEqual(planned.json.version, `${DAY_ONE}.2`, name);

    // un commit interno del día siguiente: vuelve a .1
    internalChangeAt(fx, utcAt(DAY_TWO, 9));
    const next = await mirrorReadOnly(fx, ['plan', '--json'], { credential: WRITER });
    assert.strictEqual(next.json.state, 'changes', `${name}: ${next.all}`);
    assert.strictEqual(next.json.version, `${DAY_TWO}.1`, `${name}: plan anuncia el número`);
    r = await syncRun(fx, ['--json']);
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.strictEqual(r.json.version, `${DAY_TWO}.1`, `${name}: el día siguiente`);
    assert.strictEqual(r.json.tree, next.json.tree, `${name}: plan y sync calculan lo mismo`);
    assertMirrorCommit(fx, tipOf(fx.bare, SYNC_REF), { parents: [tipOf(fx.bare, MAIN_REF)], tree: r.json.tree, subject: 'Sincronización', version: `${DAY_TWO}.1` }, name);

    // y lo que quedó publicado cumple la regla: la parte (i) de verify miró los dos archivos y no encontró nada
    const v = await verifyRun(fx);
    assert.strictEqual(v.code, 0, `${name}: ${v.all}`);
    assert.deepStrictEqual(v.json.findings, [], name);
    assert.strictEqual(v.json.looked.i, 2, `${name}: el de main y el de la rama`);
  }
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — un reintento con las mismas entradas: el mismo commit, no empuja y no sube N', async () => {
  // 🔴 rojo previo: `one.json.version` undefined
  const { fx, seed } = await published({ change: false });
  // 10:30 UTC del día uno: en Kiritimati (UTC+14) ya es el día dos, y la versión es la del día UTC
  internalChangeAt(fx, utcAt(DAY_ONE, 10, 30));
  const one = await syncRun(fx, ['--json'], { env: { TZ: 'Pacific/Kiritimati', LANG: 'C', LC_ALL: 'C' } });
  assert.strictEqual(one.code, 0, one.all);
  assert.deepStrictEqual(one.pushed, [SYNC_REF]);
  assert.strictEqual(one.json.version, `${DAY_ONE}.1`, 'la fecha es la del commit interno en UTC, no la del huso de la corrida');
  const branch = tipOf(fx.bare, SYNC_REF);
  assertMirrorCommit(fx, branch, { parents: [seed.commit], tree: one.json.tree, subject: 'Sincronización', version: `${DAY_ONE}.1` }, 'la primera');

  // el reintento, con otro huso, otro idioma y otra máscara: mismos shas internos y mismo padre → es esta misma corrida
  const written = fx.api.writes().length;
  const two = await syncWithoutWrites(fx, ['--json'], { env: { TZ: 'America/Anchorage', LANG: 'es_AR.UTF-8', LC_ALL: 'es_AR.UTF-8' }, umask: '077' });
  assert.strictEqual(two.code, 0, two.all);
  assert.strictEqual(two.json.outcome, 'synced');
  assert.strictEqual(two.json.commit, branch, 'el mismo commit');
  assert.strictEqual(two.json.pushed, false, 'no empuja');
  assert.strictEqual(two.json.version, `${DAY_ONE}.1`, 'y no sube N: sin el atajo, la rama ya trae el .1 y saldría .2');
  assert.strictEqual(two.json.tree, one.json.tree);
  assert.deepStrictEqual(two.json.pullRequest, { number: 1, action: 'unchanged' });
  assert.strictEqual(fx.api.writes().length, written);
  // sin --json dice la versión
  const said = await syncWithoutWrites(fx);
  assert.ok(said.out.includes(`${DAY_ONE}.1`), said.out);

  // «un día después» (A18): no hay reloj que mover. Lo que se prueba es la construcción: con la rama borrada, la corrida
  // vuelve a armar EXACTAMENTE ese commit —la base es main, que no cambió—, corra cuando corra
  gitFx(fx.bare, ['update-ref', '-d', SYNC_REF]);
  const three = await syncRun(fx, ['--json'], { env: { TZ: 'UTC', LANG: 'en_US.UTF-8' }, umask: '002' });
  assert.strictEqual(three.code, 0, three.all);
  assert.deepStrictEqual(three.pushed, [SYNC_REF]);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), branch, 'el mismo sha en una corrida aparte');
  assert.strictEqual(three.json.version, `${DAY_ONE}.1`);

  // control del atajo: con los mismos shas internos pero OTRO padre (alguien mergeó), ya no es la misma corrida.
  // Mergeada, la exportación es la de main: sin cambios, y la rama queda como estaba
  mergeSync(fx);
  const four = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(four.json.outcome, 'unchanged', four.all);
  assert.strictEqual(four.json.version, `${DAY_ONE}.1`);
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — sin cambios publicables: no numera ni empuja, aunque los commits internos y el día cambien', async () => {
  // 🔴 rojo previo: con version.json en main, la corrida daba «cambios» (comparaba el árbol entero) y empujaba
  const { fx } = await published({ change: false });
  internalChangeAt(fx, utcAt(DAY_ONE, 10));
  let r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.json.version, `${DAY_ONE}.1`, r.all);
  mergeSync(fx);
  const main = tipOf(fx.bare, MAIN_REF);
  const stamped = versionOf(fx, MAIN_REF);
  assert.strictEqual(stamped.json.version, `${DAY_ONE}.1`, 'control: main quedó con el .1');

  // un commit interno que no cambia nada de lo que sale (una carpeta que nunca sale), y al día siguiente
  const unpublished = internalChangeAt(fx, utcAt(DAY_TWO, 10), { 'tasks/nota.md': '# Una nota del equipo\n' });
  assert.notStrictEqual(unpublished, stamped.json.source.harness, 'control: el commit interno es otro');
  r = await syncWithoutWrites(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.outcome, 'unchanged');
  assert.strictEqual(r.json.version, `${DAY_ONE}.1`, 'la versión sigue siendo la publicada: no hay número nuevo');
  assert.strictEqual(tipOf(fx.bare, MAIN_REF), main);
  assert.strictEqual(versionOf(fx, MAIN_REF).blob, stamped.blob, 'el version.json publicado, intacto');
  const planned = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(planned.json.state, 'unchanged', planned.all);
  assert.strictEqual(planned.json.counts, null);
  // sin --json: sin cambios
  r = await syncWithoutWrites(fx);
  assert.match(r.out, /sin cambios/);

  // el espejo: un cambio que SÍ sale, ese mismo día, numera — y es el .1 del día nuevo
  internalChangeAt(fx, utcAt(DAY_TWO, 11));
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.strictEqual(r.json.version, `${DAY_TWO}.1`);
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — first: la primera publicación sale con el .1, y plan lo anuncia', async () => {
  // 🔴 rojo previo: `planned.json.version` undefined, y el commit raíz sin version.json
  const fx = await fixture();
  internalChangeAt(fx, utcAt(DAY_ONE, 10));
  const planned = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(planned.json.state, 'unpublished', planned.all);
  assert.strictEqual(planned.json.version, `${DAY_ONE}.1`, 'plan dice el número con que saldría');
  assert.notStrictEqual(planned.json.tree, planned.json.exportedTree);

  const r = await mirror(fx, ['first', '--json'], { credential: WRITER });
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.version, `${DAY_ONE}.1`);
  assert.strictEqual(r.json.tree, planned.json.tree, 'first y plan calculan lo mismo');
  assert.strictEqual(r.json.exportedTree, planned.json.exportedTree);
  const tip = tipOf(fx.bare, MAIN_REF);
  assertMirrorCommit(fx, tip, { parents: [], tree: planned.json.tree, subject: 'Primera publicación', version: `${DAY_ONE}.1` }, 'first');
  // su verify --strict miró el archivo en la parte (i), y no encontró nada
  assert.strictEqual(r.json.verify.exit, 0);
  assert.deepStrictEqual(r.json.verify.findings, []);
  assert.strictEqual(r.json.verify.looked.i, 1);
  // sin --json dice la versión
  const other = await fixture();
  internalChangeAt(other, utcAt(DAY_ONE, 10));
  const h = await mirror(other, ['first'], { credential: WRITER });
  assert.strictEqual(h.code, 0, h.all);
  assert.ok(h.out.includes(`${DAY_ONE}.1`), h.out);
  assert.match(h.out, /\(i\)[^\n]*sin hallazgos/, 'y la parte (i) figura en lo que miró verify');

  // la sincronización siguiente del mismo día cuenta desde el de main: .2
  internalChangeAt(fx, utcAt(DAY_ONE, 11));
  const s = await syncRun(fx, ['--json']);
  assert.strictEqual(s.code, 0, s.all);
  assert.strictEqual(s.json.version, `${DAY_ONE}.2`);
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — verify, parte (i): valida el archivo si está, y falla nombrando', async () => {
  // 🔴 rojo previo: verify salía 0 con shas que no eran los de los trailers (no había parte (i): `looked.i` undefined)
  const fx = await fixture();
  const seed = seedPublication(fx);
  const reset = () => {
    for (const ref of refsOf(fx.bare).split('\n').filter(Boolean).map((l) => l.split(' ')[0])) gitFx(fx.bare, ['update-ref', '-d', ref]);
    fx.api.reset();
  };
  const good = (n, day = DAY_ONE) => versionText(`${day}.${n}`, seed.harness, seed.skills);
  const onlyVersion = (r, name) => {
    assert.strictEqual(r.code, 1, `${name}: sale 1\n${r.all}`);
    assert.deepStrictEqual(partsOf(r), ['i'], `${name}: la parte (i), y ninguna otra\n${r.all}`);
  };

  // un main sin version.json (la primera publicación salió sin él): sin hallazgo, y la parte dice que no había nada que mirar
  gitFx(fx.bare, ['update-ref', MAIN_REF, seed.commit]);
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.strictEqual(r.json.looked.i, 0);
  let h = await verifyPlain(fx);
  assert.match(h.out, /\(i\)[^\n]*sin hallazgos/);
  // ese main, con la primera sincronización numerada esperando en la rama: tampoco
  datedSync(fx, seed, { parent: seed.commit, epoch: utcAt(DAY_ONE, 10), file: good(1), ref: SYNC_REF });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.looked.i, 1, 'el de la rama');

  // lo sano: main con su .1, y la rama con el .2 del mismo día encima
  reset();
  let root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1), ref: MAIN_REF });
  datedSync(fx, seed, { parent: root, epoch: utcAt(DAY_ONE, 12), file: good(2), ref: SYNC_REF });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.strictEqual(r.json.looked.i, 2);
  // y mergeada: el archivo de main es el mismo blob que el de su última sincronización
  const pending = tipOf(fx.bare, SYNC_REF);
  publicCommit(fx, { parents: [root, pending], from: pending, message: 'Merge pull request #1 from example-org/mirror/sync' });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);

  // shas que no coinciden con los trailers de su sincronización: 1, nombrando la fuente, el trailer y el commit
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: versionText(`${DAY_ONE}.1`, 'f'.repeat(40), seed.skills), ref: MAIN_REF });
  r = await verifyRun(fx);
  onlyVersion(r, 'shas que no coinciden');
  assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-source']);
  assert.ok(r.json.findings[0].place.includes(root) && /harness/.test(r.json.findings[0].place) && r.json.findings[0].place.includes('Mirror-Harness-Commit'),
    `nombra la fuente, su trailer y el commit\n${r.json.findings[0].place}`);
  assert.ok(!/agent_skills/.test(r.json.findings[0].place), 'y sólo la que no coincide');
  h = await verifyPlain(fx);
  assert.strictEqual(h.code, 1, h.all);
  assert.ok(h.all.includes('· (i) [version-source] '), h.all);
  // una fuente de más, o una de menos: el conjunto de `source` es el de los trailers del commit
  for (const [name, source] of [['una fuente de más', { harness: seed.harness, agent_skills: seed.skills, extra: 'e'.repeat(40) }], ['una de menos', { harness: seed.harness }]]) {
    reset();
    datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: require(EXPORTER).versionFileBytes({ version: `${DAY_ONE}.1`, source }).toString('utf8'), ref: MAIN_REF });
    r = await verifyRun(fx);
    onlyVersion(r, name);
    assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-source'], name);
  }

  // un número fuera de la regla: la fecha que no es la de su commit…
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1, DAY_TWO), ref: MAIN_REF });
  r = await verifyRun(fx);
  onlyVersion(r, 'la fecha no es la del commit');
  assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-number']);
  assert.ok(r.json.findings[0].place.includes(root) && r.json.findings[0].place.includes(`${DAY_TWO}.1`) && r.json.findings[0].place.includes(DAY_ONE), r.json.findings[0].place);
  // … una primera publicación que no es el .1 …
  reset();
  datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(3), ref: MAIN_REF });
  r = await verifyRun(fx);
  onlyVersion(r, 'una raíz que no es el .1');
  assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-number']);
  // … y una sincronización cuyo orden no es mayor que el del commit sobre el que se armó, el mismo día
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1), ref: MAIN_REF });
  const repeated = datedSync(fx, seed, { parent: root, epoch: utcAt(DAY_ONE, 12), file: good(1), ref: SYNC_REF });
  r = await verifyRun(fx);
  onlyVersion(r, 'el orden no sube');
  assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-number']);
  assert.ok(r.json.findings[0].place.includes(repeated), `nombra el commit de la rama\n${r.json.findings[0].place}`);
  // el espejo: con el día siguiente, el .1 encima de un .1 está bien
  datedSync(fx, seed, { parent: root, epoch: utcAt(DAY_TWO, 9), file: good(1, DAY_TWO), ref: SYNC_REF });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);

  // un archivo que no se deja leer: hallazgo, no «no está»
  for (const [name, broken] of [['JSON roto', '{ "version": '], ['un número sin forma', versionText(`${DAY_ONE}.1`, seed.harness, seed.skills).replace(`${DAY_ONE}.1`, '1.2')], ['sin source', `${JSON.stringify({ version: `${DAY_ONE}.1` })}\n`]]) {
    reset();
    datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: broken, ref: MAIN_REF });
    r = await verifyRun(fx);
    onlyVersion(r, name);
    assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-file'], name);
  }

  // en main, un archivo que no es el de su última sincronización mergeada (alguien lo cambió allá): (i), además del cambio ajeno
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1), ref: MAIN_REF });
  publicCommit(fx, { parents: [root], files: { [VERSION_FILE]: good(7) }, message: 'Un cambio hecho a mano en GitHub' });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 1, r.all);
  assert.deepStrictEqual(partsOf(r), ['f', 'i']);
  assert.deepStrictEqual(r.json.findings.filter((f) => f.part === 'i').map((f) => f.category), ['version-file']);
  assert.ok(r.json.findings.find((f) => f.part === 'i').place.includes(root), 'nombra la sincronización de la que tendría que ser');

  // la ausencia es un hallazgo sólo si ya estaba: una sincronización que lo saca, mergeada…
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1), ref: MAIN_REF });
  const without = datedSync(fx, seed, { parent: root, epoch: utcAt(DAY_ONE, 12), file: null });
  publicCommit(fx, { parents: [root, without], from: without, message: 'Merge pull request #1 from example-org/mirror/sync' });
  assert.strictEqual(versionOf(fx, MAIN_REF), null, 'control: main quedó sin el archivo');
  r = await verifyRun(fx);
  onlyVersion(r, 'main dejó de traerlo');
  assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-missing']);
  // … o que espera en la rama, armada sobre un main que sí lo trae
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1), ref: MAIN_REF });
  const dropped = datedSync(fx, seed, { parent: root, epoch: utcAt(DAY_ONE, 12), file: null, ref: SYNC_REF });
  r = await verifyRun(fx);
  onlyVersion(r, 'la rama no lo trae y su padre sí');
  assert.deepStrictEqual(r.json.findings.map((f) => f.category), ['version-missing']);
  assert.ok(r.json.findings[0].place.includes(dropped), r.json.findings[0].place);
  // una rama que no es una sincronización no se valida: no es de la cadena (sync la reemplaza)
  reset();
  root = datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: good(1), ref: MAIN_REF });
  publicCommit(fx, { parents: [root], files: { [VERSION_FILE]: '{ roto' }, message: 'Algo que no es una sincronización', ref: SYNC_REF });
  r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.looked.i, 1, 'sólo el de main');
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — un version.json que no se deja leer en el público es un 2, nunca «empiezo en .1»', async () => {
  // 🔴 rojo previo: sync salía 0 y empujaba (no leía el archivo del público)
  for (const [name, broken] of [['JSON roto', '{ "version": '], ['un número sin forma', '{ "version": "1.2", "source": {} }\n'], ['no es un objeto', '"2030.01.15.1"\n']]) {
    const { fx, seed } = await published({ change: false });
    // main pasa a ser una primera publicación con ese archivo roto (una raíz de la sincronización: no es un cambio ajeno)
    datedSync(fx, seed, { epoch: utcAt(DAY_ONE, 10), file: broken, ref: MAIN_REF });
    internalChangeAt(fx, utcAt(DAY_ONE, 12));
    const r = await syncWithoutWrites(fx, ['--json']);
    assert.strictEqual(r.code, 2, `${name}: ${r.all}`);
    assert.match(r.err, /version\.json[^\n]*main[^\n]*no se deja leer/, `${name}: dice cuál y dónde`);
    assert.strictEqual(tipOf(fx.bare, SYNC_REF), '', `${name}: no empujó nada`);
    const planned = await mirrorReadOnly(fx, ['plan']);
    assert.strictEqual(planned.code, 2, `${name}, plan: ${planned.all}`);
  }

  // el de la rama de la sincronización también cuenta, si su punta es una sincronización
  let { fx, seed } = await published({ change: false });
  internalChangeAt(fx, utcAt(DAY_ONE, 12));
  const unreadable = datedSync(fx, seed, { parent: seed.commit, epoch: utcAt(DAY_ONE, 10), file: '{ "version": ', ref: SYNC_REF });
  let r = await syncWithoutWrites(fx);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /version\.json[^\n]*mirror\/sync[^\n]*no se deja leer/);
  assert.strictEqual(tipOf(fx.bare, SYNC_REF), unreadable);
  // el espejo: una rama que NO es una sincronización no cuenta, traiga lo que traiga — se reemplaza, y la versión es el .1
  ({ fx, seed } = await published({ change: false }));
  internalChangeAt(fx, utcAt(DAY_ONE, 12));
  publicCommit(fx, { parents: [seed.commit], files: { [VERSION_FILE]: '{ "version": ' }, message: 'Algo que no es una sincronización', ref: SYNC_REF });
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.strictEqual(r.json.version, `${DAY_ONE}.1`);
  // y una sincronización de la rama SIN el archivo (una de antes de esta story) tampoco suma: .1
  ({ fx, seed } = await published({ change: false }));
  internalChangeAt(fx, utcAt(DAY_ONE, 12));
  datedSync(fx, seed, { parent: seed.commit, epoch: utcAt(DAY_ONE, 10), ref: SYNC_REF });
  r = await syncRun(fx, ['--json']);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.version, `${DAY_ONE}.1`);

  // una exportación que ya trae version.json no se publica: el archivo lo agrega la sincronización, no sale de una fuente
  ({ fx } = await published({ change: false }));
  write(fx.harness, { [VERSION_FILE]: '{ "version": "de la fuente" }\n' });
  internalChangeAt(fx, utcAt(DAY_ONE, 12));
  const list = clone(ALLOWLIST);
  list.packages.core.arnes.in.push(VERSION_FILE);
  fx.config({ allowlist: list });
  for (const command of ['plan', 'sync']) {
    r = command === 'plan' ? await mirrorReadOnly(fx, ['plan']) : await syncWithoutWrites(fx);
    assert.strictEqual(r.code, 2, `${command}: ${r.all}`);
    assert.match(r.err, /ya trae version\.json/, command);
  }
});

// ── story 8.18 · AC 23 y 24 ────────────────────────────────────────────────────────────────────────────────────────
// Los dos repos internos pasan a ser UNO, con las dos historias unidas. Lo que no se puede perder:
//   · que de un solo repo salga UN commit y los dos trailers nombren ese mismo: nada de lo publicado cambia de forma
//     (`version.json`, `isSyncCommit` y `verify` siguen leyendo los dos trailers);
//   · que la primera sincronización después de la unión siga la cadena de lo publicado desde dos repos, y que frene —
//     sin empujar— si el repo desde el que corre no trae el commit de agent-skills de esa publicación: en esa historia
//     viven las marcas de los cambios ajenos ya traídos, y lo que no se ve no es «no hay».
// El repo único de juguete se arma como el de verdad: del lado de agent-skills se va su `.gitignore` (queda el del
// arnés) y las dos historias se unen con un merge, sin reescribir ningún commit.
// Que un commit ES del repo único lo dice su árbol, con el criterio del exportador: las skills del pipeline, los
// revisores y la lista blanca del equipo en la misma raíz. El arnés de juguete trae sólo lo último (`teamList`): solo,
// sigue siendo uno de dos repos; unido con agent-skills, es el repo único.

const TEAM_LIST = 'scripts/publishing/allowlist.json';

/** El arnés de juguete pasa a traer la lista blanca en su lugar de siempre, como el de verdad (acá, un archivo cualquiera). */
function teamList(fx) {
  write(fx.harness, { [TEAM_LIST]: `${JSON.stringify({ __doc: 'la lista blanca del arnés de juguete: sólo marca el lugar' }, null, 2)}\n` });
  return commit(fx.harness, 'el arnés trae su lista blanca');
}

/** Una fixture publicada desde DOS repos (como la deja `first`), con el arnés ya con su lista blanca. */
async function publishedFromTwo({ change = false } = {}) {
  const fx = await fixture();
  teamList(fx);
  const seed = seedPublication(fx);
  if (change) internalChange(fx);
  return { fx, seed };
}

/**
 * Los dos internos de la fixture, unidos en UN repo. Con `joined: false`, los archivos de agent-skills entran en un
 * commit cualquiera, SIN su historia. Devuelve la fixture vista desde ese repo (el arnés y las skills son la misma
 * carpeta, con su propia lista blanca) y `exporterNote`: con qué exportador se midió.
 */
function unite(fx, { joined = true } = {}) {
  const id = ++serial;
  const dir = path.join(fx.dir, `single-${id}`);
  gitFx(fx.dir, ['clone', '-q', fx.harness, dir]);
  if (joined) {
    const side = path.join(fx.dir, `skills-side-${id}`);
    gitFx(fx.dir, ['clone', '-q', fx.skills, side]);
    write(side, { '.gitignore': null });
    commit(side, 'agent-skills deja su .gitignore: en el repo único queda el del arnés');
    gitFx(dir, ['fetch', '-q', side, 'HEAD']);
    const date = nextDate();
    gitFx(dir, ['merge', '-q', '--no-ff', '--allow-unrelated-histories', '-m', 'la unión de las dos historias', 'FETCH_HEAD'],
      { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  } else {
    const files = {};
    for (const rel of gitFx(fx.skills, ['ls-files', '-z']).split('\0').filter((f) => f && f !== '.gitignore')) files[rel] = fs.readFileSync(path.join(fx.skills, rel));
    write(dir, files);
    commit(dir, 'agent-skills entra como archivos, sin su historia');
  }
  const single = { ...fx, harness: dir, skills: path.join(dir, 'skills'), cfg: { ...fx.cfg, allowlist: path.join(fx.dir, 'cfg', `allowlist-single-${id}.json`) } };
  // en el repo único agent-skills ya no trae `.gitignore`: el que hay es el del arnés
  const allow = clone(ALLOWLIST);
  allow.packages.core['agent-skills'].in = allow.packages.core['agent-skills'].in.filter((g) => g !== '.gitignore');
  const save = () => fs.writeFileSync(single.cfg.allowlist, `${JSON.stringify(allow, null, 2)}\n`);
  save();
  assert.ok(require(MIRROR).isSingleRepoTree(gitFx(dir, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean)),
    'control: el repo único de juguete tiene la forma del de verdad (¿le falta `teamList` al arnés?)');
  // 🔴 Sin salida de respaldo (revisión del tramo 2, vuelta 1): antes, si el exportador leía DOS repos, esta función le
  // agregaba a la lista de la fixture la mitad de la otra fuente como excluida y T23/T24 seguían verdes con el exportador
  // viejo. El exportador ya lee UNA fuente física partida por ruta (AC 19): que lea dos es un error, no otra forma de medir.
  const probe = runExporter(single).r;
  assert.strictEqual(probe.status, 0, `la fixture no pudo exportar el repo único: ${probe.stderr}\n${probe.stdout}`);
  let physical;
  try { physical = JSON.parse(probe.stdout).physicalSources; } catch (e) { assert.fail(`el --json del exportador no se pudo leer: ${e.message}\n${probe.stdout}`); }
  assert.strictEqual(physical, 1, 'el exportador lee el repo único como UNA fuente física, partida por ruta');
  single.onePhysicalSource = true;
  single.exporterNote = 'medido con el exportador de una fuente física: parte el repo único en sus dos fuentes lógicas, por ruta';
  return single;
}

// ── T23 de la 8.18 · AC 23 ─────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_OneCommit_BothTrailersSame_VersionJsonShapeKept', async (t) => {
  // 🔴 rojo previo: desde un repo único, sin decir ningún commit, el guion tomaba agent-skills de «origin/main» —otro
  // commit del mismo repo— y los dos trailers nombraban commits distintos

  // qué es «el repo único»: lo dice el árbol del commit, y el guion y el exportador tienen que decir lo mismo. El
  // criterio vive en new-names.js (`unifiedTree`), que el guion no puede cargar sin traer medio arnés: acá se cruzan
  const rule = require(MIRROR).isSingleRepoTree;
  const reference = require(path.join(PUBLISHING, 'new-names.js')).unifiedTree;
  const whole = ['README.md', 'skills/tycon-pipeline/SKILL.md', 'agents/un-revisor.md', TEAM_LIST];
  const trees = [whole, ...whole.map((gone) => whole.filter((p) => p !== gone)), [], ['skills/otra/SKILL.md', 'agents/un-revisor.md', TEAM_LIST],
    ['skills/tycon-pipeline', 'agents', TEAM_LIST], ['skills/tycon-pipeline/a/b.js', 'agents/x/y.md', TEAM_LIST, 'packs/p/pack.json']];
  for (const paths of trees) {
    assert.strictEqual(rule(paths), reference(paths.map((ruta) => ({ ruta }))), `el guion y el exportador dicen lo mismo de [${paths.join(', ')}]`);
  }
  assert.strictEqual(rule(whole), true, 'control: el árbol entero es el del repo único');
  assert.strictEqual(rule(whole.slice(1, 3)), false, 'control: sin la lista blanca (un clon de agent-skills solo) no lo es');

  const fx = await fixture();
  teamList(fx);
  const single = unite(fx);
  t.diagnostic(single.exporterNote);
  const own = { refs: false };   // sin --agent-skills: como lo llama el pipeline
  const head = headOf(single.harness);
  assert.notStrictEqual(tipOf(single.harness, 'refs/remotes/origin/main'), head, 'control: en el repo único, origin/main NO es el commit que se publica');

  // plan: UN commit interno, el del arnés, para las dos fuentes
  const planned = await mirrorReadOnly(single, ['plan', '--json'], own);
  assert.strictEqual(planned.code, 0, planned.all);
  assert.strictEqual(planned.json.state, 'unpublished');
  assert.strictEqual(planned.json.harness.sha, head);
  assert.strictEqual(planned.json.agentSkills.sha, head, 'agent-skills sale del MISMO commit, no de origin/main');
  assert.strictEqual(planned.json.singleRepo, true, 'y la corrida lo dice');
  assert.deepStrictEqual(planned.json.warnings, []);
  const said = await mirrorReadOnly(single, ['plan'], own);
  assert.match(said.out, /un solo repo interno/, `sin --json también lo dice\n${said.out}`);

  // first: los dos trailers con ese commit, `source` con las dos claves iguales, y la fecha, la de ese commit
  let r = await mirror(single, ['first', '--json'], { credential: WRITER, ...own });
  assert.strictEqual(r.code, 0, r.all);
  const root = tipOf(single.bare, MAIN_REF);
  assertMirrorCommit(single, root, { parents: [], tree: planned.json.tree, subject: 'Primera publicación' }, 'first, desde el repo único');
  const stamped = JSON.parse(gitFx(single.bare, ['show', `${root}:version.json`]));
  assert.deepStrictEqual(Object.keys(stamped.source), ['harness', 'agent_skills'], 'version.json no cambia de forma: las dos claves de siempre');
  assert.strictEqual(stamped.source.harness, head);
  assert.strictEqual(stamped.source.agent_skills, head);
  // verify —con su parte (i), que compara cada fuente con SU trailer— no cambió, y no encuentra nada
  assert.strictEqual(r.json.verify.exit, 0);
  assert.deepStrictEqual(r.json.verify.findings, []);
  assert.strictEqual(r.json.verify.looked.i, 1);

  // sync: lo mismo sobre la punta pública, y un reintento da el mismo commit (el atajo compara los dos trailers)
  internalChange(single);
  r = await syncRun(single, ['--json'], own);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.outcome, 'synced');
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assert.strictEqual(r.json.singleRepo, true);
  const branch = tipOf(single.bare, SYNC_REF);
  assertMirrorCommit(single, branch, { parents: [root], tree: r.json.tree, subject: 'Sincronización' }, 'sync, desde el repo único');
  const again = await syncWithoutWrites(single, ['--json'], own);
  assert.strictEqual(again.code, 0, again.all);
  assert.strictEqual(again.json.commit, branch, 'un reintento: el mismo commit');
  assert.strictEqual(again.json.pushed, false);

  // `isSyncCommit` lo sigue reconociendo: mergeada, es el ancla de los cambios ajenos y lo publicado queda «sin cambios»
  mergeSync(single);
  const merged = await syncWithoutWrites(single, ['--json'], own);
  assert.strictEqual(merged.code, 0, merged.all);
  assert.strictEqual(merged.json.outcome, 'unchanged');
  assert.deepStrictEqual(merged.json.foreign, [], 'el merge de la sincronización no es un cambio ajeno');
  const v = await verifyRun(single, [], own);
  assert.strictEqual(v.code, 0, v.all);
  assert.deepStrictEqual(v.json.findings, []);
  assert.ok(v.json.looked.i >= 1, 'la parte (i) miró el archivo publicado');

  // el mismo commit dicho con otra referencia se acepta (así lo llaman las demás pruebas: --agent-skills HEAD)…
  const same = await mirrorReadOnly(single, ['plan', '--json']);
  assert.strictEqual(same.code, 0, same.all);
  assert.strictEqual(same.json.agentSkills.sha, headOf(single.harness));
  // …y otro commit para agent-skills no existe en un repo único: 2, nombrando los dos, sin escribir nada
  const other = gitFx(single.harness, ['rev-parse', 'HEAD~1']);
  for (const command of ['plan', 'sync']) {
    const bad = command === 'plan' ? await mirrorReadOnly(single, ['plan', '--agent-skills', other], own) : await syncWithoutWrites(single, ['--agent-skills', other], own);
    assert.strictEqual(bad.code, 2, `${command}: ${bad.all}`);
    assert.match(bad.err, /un solo repo interno/, `${command}: dice por qué`);
    assert.ok(bad.err.includes(other.slice(0, 12)) && bad.err.includes(headOf(single.harness).slice(0, 12)), `${command}: nombra los dos commits\n${bad.err}`);
  }

  // Lo decide el commit, no el disco: con el clon viejo de agent-skills todavía a mano (una máquina en transición, o la
  // variable apuntando ahí), el repo único sigue siendo UNO y el otro clon ni se mira (ni el guion ni el exportador, que
  // `unite` ya comprobó que lee una fuente física).
  assert.strictEqual(single.onePhysicalSource, true, 'control: el exportador lee el repo único como una fuente física');
  const elsewhere = { ...single, skills: fx.skills };
  const there = await mirrorReadOnly(elsewhere, ['plan', '--json'], own);
  assert.strictEqual(there.code, 0, there.all);
  assert.strictEqual(there.json.singleRepo, true, 'con TYCON_SKILLS_DIR en otro clon, el repo único sigue siendo uno');
  assert.strictEqual(there.json.agentSkills.sha, headOf(single.harness));

  // el espejo: con dos repos físicos todo sigue como siempre — un commit por repo, cada uno en su trailer
  const two = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(two.code, 0, two.all);
  assert.strictEqual(two.json.singleRepo, false);
  assert.strictEqual(two.json.harness.sha, headOf(fx.harness));
  assert.strictEqual(two.json.agentSkills.sha, headOf(fx.skills));
  assert.notStrictEqual(two.json.harness.sha, two.json.agentSkills.sha);
});

// ── T24 de la 8.18 · AC 24 ─────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_FirstSyncAfterUnion_RecognizesPrevious_StopsIfUnknown', async (t) => {
  // 🔴 rojo previo: sin la historia de agent-skills, sync publicaba igual (no miraba si conocía la sincronización anterior)
  const own = { refs: false };

  // (a) publicado desde DOS repos: la punta pública nombra dos commits internos distintos. Después, la unión
  const { fx, seed } = await publishedFromTwo();
  assert.notStrictEqual(seed.harness, seed.skills, 'control: la publicación de la fixture nombra dos commits internos');
  const single = unite(fx);
  t.diagnostic(single.exporterNote);
  let r = await mirrorReadOnly(single, ['plan', '--json'], own);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.publicTip, seed.commit);
  assert.strictEqual(r.json.state, 'unchanged', 'la reconoce como la anterior, y el árbol es el mismo salga de dos repos o de uno');
  assert.deepStrictEqual(r.json.foreign, []);
  // un cambio interno: el commit nuevo tiene a esa punta de padre, y nombra UN commit en sus dos trailers
  internalChange(single);
  r = await syncRun(single, ['--json'], own);
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(r.json.outcome, 'synced');
  assert.deepStrictEqual(r.pushed, [SYNC_REF]);
  assertMirrorCommit(single, tipOf(single.bare, SYNC_REF), { parents: [seed.commit], tree: r.json.tree, subject: 'Sincronización' }, 'la primera sincronización después de la unión');

  // (b) una marca escrita en la historia de agent-skills ANTES de la unión se sigue viendo desde el repo único
  const { fx: marked, seed: markedSeed } = await publishedFromTwo();
  const foreign = publicCommit(marked, { parents: [markedSeed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  commit(marked.skills, `chore: descarta un cambio ajeno del repo público\n\nPublic-Commit: ${foreign}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
  r = await mirrorReadOnly(unite(marked), ['plan', '--json'], own);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.foreign.map((f) => [f.commit, f.absorbed, f.discarded]), [[foreign, true, true]], 'la marca vive en la historia unida');

  // (c) un pull request de sincronización abierto desde dos repos, sin mergear: el repo único lo reemplaza
  const { fx: open, seed: openSeed } = await publishedFromTwo({ change: true });
  r = await syncRun(open);
  assert.deepStrictEqual(r.pushed, [SYNC_REF], `control: la sincronización desde dos repos quedó en la rama\n${r.all}`);
  const pending = tipOf(open.bare, SYNC_REF);
  const openSingle = unite(open);
  internalChange(openSingle);
  r = await syncRun(openSingle, ['--json'], own);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.pushed, [SYNC_REF], 'no es más nueva que el repo único: se reemplaza');
  assert.notStrictEqual(tipOf(open.bare, SYNC_REF), pending);
  assert.deepStrictEqual(r.json.pullRequest, { number: 1, action: 'updated' }, 'el mismo pull request, actualizado');
  assertMirrorCommit(openSingle, tipOf(open.bare, SYNC_REF), { parents: [openSeed.commit], tree: r.json.tree, subject: 'Sincronización' }, 'sobre la punta de main, no sobre la rama');

  // (d) el error: el repo desde el que corre NO trae la historia de agent-skills. Frena nombrando el commit y la causa
  const { fx: cut, seed: lost } = await publishedFromTwo();
  const alone = unite(cut, { joined: false });
  internalChange(alone);
  for (const command of ['sync', 'plan']) {
    r = command === 'sync' ? await syncWithoutWrites(alone, [], own) : await mirrorReadOnly(alone, ['plan'], own);
    assert.strictEqual(r.code, 2, `${command}, sin la historia de agent-skills: ${r.all}`);
    assert.ok(r.err.includes(lost.skills), `${command}: nombra el commit de agent-skills que no encuentra\n${r.err}`);
    assert.ok(!r.err.includes(lost.harness), `${command}: el del arnés sí está: no lo nombra`);
    assert.match(r.err, /la historia de agent-skills no está unida/, `${command}: dice la causa`);
    assert.match(r.err, /sincronización anterior/, command);
  }
  assert.strictEqual(tipOf(cut.bare, SYNC_REF), '', 'no empujó nada');
  assert.deepStrictEqual(pushes(cut), [], 'ningún push llegó al público');

  // (e) el otro error: un clon recortado del repo único, que no trae esos commits
  const shallow = path.join(fx.dir, 'single-shallow');
  const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${single.harness}`, shallow], { encoding: 'utf8', env: { ...withoutGit(process.env), ...ISOLATED } });
  assert.strictEqual(cloned.status, 0, cloned.stderr);
  const trimmed = { ...single, harness: shallow, skills: path.join(shallow, 'skills') };
  r = await syncWithoutWrites(trimmed, [], own);
  assert.strictEqual(r.code, 2, `un clon recortado: ${r.all}`);
  assert.ok(r.err.includes(seed.harness) || r.err.includes(seed.skills), `nombra el commit que no encuentra\n${r.err}`);
  assert.match(r.err, /superficial/, 'y la causa');

  // (f) y (g): los dos caminos de `requirePreviousSync` que no tenían prueba (revisión del tramo 2, vuelta 1). La
  // sincronización anterior, ya mergeada en main, sale de C1, un cambio interno sobre la unión
  const { fx: branched } = await publishedFromTwo();
  const bs = unite(branched);
  const union = headOf(bs.harness);
  const c1 = internalChange(bs);
  r = await syncRun(bs, ['--json'], own);
  assert.strictEqual(r.json && r.json.outcome, 'synced', `control: la sincronización desde C1\n${r.all}`);
  mergeSync(bs);
  // (f) una rama divergida: C2 es hermano de C1 (los dos sobre la unión). Publicar C2 dejaría afuera lo ya publicado: 2
  gitFx(bs.harness, ['checkout', '-q', '-b', 'divergida', union]);
  const c2 = internalChange(bs);
  for (const command of ['plan', 'sync']) {
    r = command === 'plan' ? await mirrorReadOnly(bs, ['plan'], own) : await syncWithoutWrites(bs, [], own);
    assert.strictEqual(r.code, 2, `${command}, desde una rama divergida: ${r.all}`);
    assert.match(r.err, /no está en la historia del commit que se publicaría/, `${command}: dice la causa\n${r.err}`);
    assert.ok(r.err.includes(c1) && r.err.includes(c2.slice(0, 12)), `${command}: nombra el commit publicado y el que se publicaría\n${r.err}`);
  }
  assert.deepStrictEqual(pushes(branched).filter((ref) => ref !== SYNC_REF), [], 'nada llegó a main');
  // (g) una corrida vieja: publica la unión misma, ANTERIOR a C1. La comprobación la deja pasar (no es una rama que no
  // trae lo publicado: lo publicado la contiene) y la decide lo de siempre: «hay cambios», sin «no pude mirar»
  gitFx(bs.harness, ['checkout', '-q', '--detach', union]);
  r = await mirrorReadOnly(bs, ['plan', '--json'], own);
  assert.strictEqual(r.code, 0, `una corrida vieja sigue: ${r.all}`);
  assert.doesNotMatch(r.all, /no está en la historia|no lo conoce/, 'sin el freno de la sincronización anterior');
  assert.strictEqual(r.json.harness.sha, union);
  assert.strictEqual(r.json.state, 'changes', 'lo de siempre: el árbol de la unión no es el publicado desde C1');

  // el espejo: con dos repos físicos esta comprobación no corre — todo sigue como siempre
  const still = await mirrorReadOnly(fx, ['plan', '--json']);
  assert.strictEqual(still.code, 0, still.all);
});

// Pase adversarial del tramo 2 de la 8.18 (clase 16): `verify` (parte f) desde un solo repo interno no comprobaba que el
// repo conociera la sincronización anterior. Sin la historia de agent-skills, las marcas que viven ahí no se ven y un
// cambio ajeno ya descartado salía como hallazgo —manda a buscar algo que no existe—, cuando `plan` y `sync` frenan con 2.
// 🔴 rojo previo verificado: verify salía 1 con findings [{ part: 'f', category: 'foreign-change' }] y nada en couldNotLook.
test('Mirror_SingleRepo_Verify_UnknownPreviousSync_PartFCouldNotLook — sin la historia de agent-skills, la parte f es «no pude mirar»', async () => {
  const own = { refs: false };
  for (const joined of [false, true]) {
    const { fx: marked, seed } = await publishedFromTwo();
    const foreign = publicCommit(marked, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
    commit(marked.skills, `chore: descarta un cambio ajeno del repo público\n\nPublic-Commit: ${foreign}\nPublic-Commit-Discarded: no lo queremos`, { allowEmpty: true });
    const r = await verifyRun(unite(marked, { joined }), [], own);
    const f = r.json && r.json.findings.filter((x) => x.part === 'f');
    const cant = r.json && r.json.couldNotLook.filter((x) => x.part === 'f');
    if (!joined) {
      assert.strictEqual(r.code, 2, `sin la historia: no pude mirar\n${r.all}`);
      assert.deepStrictEqual(f, [], 'ningún cambio ajeno inventado');
      assert.strictEqual(cant.length, 1, r.all);
      assert.ok(cant[0].reason.includes(seed.skills), `nombra el commit que no encuentra: ${cant[0].reason}`);
      assert.match(cant[0].reason, /la historia de agent-skills no está unida/, 'y la causa');
    } else {
      // el espejo: con la historia unida, la marca se ve y no hay nada que decir
      assert.strictEqual(r.code, 0, `con la historia unida\n${r.all}`);
      assert.deepStrictEqual([f, cant], [[], []]);
    }
  }
});

// ══ story 8.13.1, tanda A (AC 6, T7) — la lista de transformados viaja en el version.json publicado ═══════════════════
// El version.json que llega al público lo escribe ESTA sincronización (`numberRun`, en `first` y en `sync`), no el
// exportador: sin la lista acá, cada máquina con la capa privada vería «capa de otra versión». La lista es la del
// exportador de esa corrida (su --json), y `verify` comprueba que nombra exactamente las rutas publicadas cuyo blob no
// es el del commit interno de su sincronización. La mitad del exportador está en export.test.js.

/** Las rutas de una ref del público (sin version.json) cuyo blob no es el de los internos de mentira en su HEAD. */
function differingFromInternal(fx, ref) {
  const blobs = (dir, rev) => gitFx(dir, ['ls-tree', '-r', rev]).split('\n').filter(Boolean).map((l) => l.split('\t'))
    .filter(([meta]) => meta.split(' ')[1] === 'blob').map(([meta, rel]) => [rel, meta.split(' ')[2]]);
  // los dos internos, el arnés primero: una ruta que traen los dos (el .gitignore) se compara con la del arnés
  const internal = new Map([...blobs(fx.skills, 'HEAD'), ...blobs(fx.harness, 'HEAD')]);
  // lo que sale sólo en el público (LICENSE, los papeles de .github/) no difiere de nada interno: no cuenta
  return blobs(fx.bare, ref).filter(([rel, b]) => rel !== VERSION_FILE && internal.has(rel) && internal.get(rel) !== b).map(([rel]) => rel).sort();
}

test('T7 Export_And_MirrorSync_VersionJsonTransformed_Deterministic_NoPrivate_VerifyCatchesUndeclared — mirror.js: first y sync la escriben, verify la comprueba y frena con una ruta sin nombre', async () => {
  const fx = await fixture();
  // un papel de public-files/ que reemplaza una ruta que el interno también trae (guides/guia.md, con otro blob)
  const allowlist = clone(ALLOWLIST);
  allowlist.packages.core.arnes.out.push({ glob: 'guides/guia.md', reason: 'la copia trae la suya, de public-files' });
  allowlist.synthetic.push(paper('guides/guia.md'));
  fx.config({ allowlist });
  internalChangeAt(fx, utcAt(DAY_ONE, 10), { [`${PAPERS_DIR}/guides/guia.md`]: '# Guía\n\nLa versión de afuera.\n' });
  const r = await mirror(fx, ['first', '--json'], { credential: WRITER });
  assert.strictEqual(r.code, 0, r.all);

  // first: el version.json de la primera publicación trae la lista, con las rutas publicadas que difieren del interno
  const one = versionOf(fx, MAIN_REF);
  assert.ok(one && Array.isArray(one.json.transformed), `la primera publicación trae «transformed»\n${one && one.text}`);
  assert.deepStrictEqual(one.json.transformed.map((t) => t.path), differingFromInternal(fx, MAIN_REF), 'exactamente las rutas que difieren, en orden');
  const exported = runExporter(fx);
  assert.strictEqual(exported.r.status, 0, exported.r.stderr);
  const exportedJson = JSON.parse(exported.r.stdout);
  const byPath = new Map(one.json.transformed.map((t) => [t.path, t.transform]));
  assert.ok(String(byPath.get('guides/guia.md')).split('+').includes('sinteticos'), `guides/guia.md: con el ajuste que la reemplaza: ${byPath.get('guides/guia.md')}\n${one.text}`);
  // el ajuste del papel se anota con el prefijo de su fuente (arnes/guides/guia.md); la lista trae la ruta publicada
  assert.ok(exportedJson.ajustes.some((a) => a.transformacion === 'sinteticos' && a.archivo === 'arnes/guides/guia.md'), 'control: el ajuste trae el prefijo de su fuente');
  // LICENSE sale sólo en el público: no difiere de nada interno
  assert.ok(gitFx(fx.bare, ['ls-tree', '--name-only', MAIN_REF, '--', 'LICENSE']) === 'LICENSE', 'control: LICENSE se publicó');
  assert.ok(!byPath.has('LICENSE'), `lo que sale sólo afuera no es un transformado\n${one.text}`);
  assert.ok(!one.json.transformed.some((t) => /^(arnes|agent-skills)\//.test(t.path)), 'la ruta publicada, sin el prefijo de su fuente');
  assert.ok(!one.json.transformed.some((t) => t.path === VERSION_FILE || /(^|\+)generated(\+|$)/.test(t.transform)), 'sin generated');
  // es la lista del exportador de esa corrida, tal cual
  assert.deepStrictEqual(one.json.transformed, exportedJson.transformed, 'la misma lista que trae el --json del exportador');
  // y su verify --strict la miró, sin hallazgos
  assert.strictEqual(r.json.verify.exit, 0, r.all);
  assert.deepStrictEqual(r.json.verify.findings, []);
  assert.strictEqual(r.json.verify.looked.j, 1, 'la parte (j) miró la lista de la primera publicación');

  // sync (`numberRun`): la rama también la trae, y es la misma en las dos corridas (el cambio interno no se transforma)
  internalChangeAt(fx, utcAt(DAY_ONE, 11));
  const s = await syncRun(fx, ['--json']);
  assert.strictEqual(s.code, 0, s.all);
  const two = versionOf(fx, SYNC_REF);
  assert.ok(two && Array.isArray(two.json.transformed), `la sincronización trae «transformed»\n${two && two.text}`);
  assert.deepStrictEqual(two.json.transformed.map((t) => t.path), differingFromInternal(fx, SYNC_REF));
  assert.deepStrictEqual(two.json.transformed, one.json.transformed, 'la misma lista en las dos corridas');
  let v = await verifyRun(fx);
  assert.strictEqual(v.code, 0, v.all);
  assert.strictEqual(v.json.looked.j, 2, 'la de main y la de la rama');

  // nada privado en el version.json publicado: el detector con la lista de la prueba, en 0
  const publishedFile = path.join(fx.dir, 'version-publicado.json');
  fs.writeFileSync(publishedFile, two.text);
  const d = spawnSync(process.execPath, [path.join(PUBLISHING, 'detector.js'), '--config', fx.cfg.denied, publishedFile], { encoding: 'utf8' });
  assert.strictEqual(d.status, 0, `el detector sobre version.json: ${d.stdout}${d.stderr}`);
  assert.ok(!two.text.toLowerCase().includes(TERM.toLowerCase()), 'ni el nombre del cliente de la fixture');

  // un transformado quitado de la lista a mano: verify sale 1 en (j), nombrando la ruta y el commit
  const main = tipOf(fx.bare, MAIN_REF);
  const branch = tipOf(fx.bare, SYNC_REF);
  const seed = { commit: branch, harness: two.json.source.harness, skills: two.json.source.agent_skills };
  const bytes = (transformed) => require(EXPORTER).versionFileBytes({ version: two.json.version, source: two.json.source, transformed }).toString('utf8');
  const tampered = (transformed) => datedSync(fx, seed, { parent: main, from: branch, epoch: utcAt(DAY_ONE, 11), ref: SYNC_REF,
    file: transformed === undefined ? require(EXPORTER).versionFileBytes({ version: two.json.version, source: two.json.source }).toString('utf8') : bytes(transformed) });
  let bad = tampered(two.json.transformed.filter((t) => t.path !== 'guides/guia.md'));
  v = await verifyRun(fx);
  assert.strictEqual(v.code, 1, v.all);
  assert.deepStrictEqual(partsOf(v), ['j'], `sólo la parte (j)\n${v.all}`);
  assert.deepStrictEqual(v.json.findings.map((f) => f.category), ['transformed-undeclared']);
  assert.ok(v.json.findings[0].place.includes('guides/guia.md') && v.json.findings[0].place.includes(bad), `nombra la ruta y el commit\n${v.json.findings[0].place}`);
  const plain = await verifyPlain(fx);
  assert.strictEqual(plain.code, 1, plain.all);
  assert.ok(plain.all.includes('· (j) [transformed-undeclared] ') && plain.all.includes('guides/guia.md'), plain.all);
  // una ruta de más (una que no difiere): también, nombrándola
  bad = tampered([...two.json.transformed, { path: 'README.md', transform: 'inventada' }]);
  v = await verifyRun(fx);
  assert.strictEqual(v.code, 1, v.all);
  assert.deepStrictEqual(v.json.findings.map((f) => `${f.part} ${f.category}`), ['j transformed-extra']);
  assert.ok(v.json.findings[0].place.includes('README.md') && v.json.findings[0].place.includes(bad), v.json.findings[0].place);
  // una sincronización sin la lista, armada sobre un main que la trae: hallazgo (la cadena ya la traía)
  bad = tampered(undefined);
  v = await verifyRun(fx);
  assert.strictEqual(v.code, 1, v.all);
  assert.deepStrictEqual(v.json.findings.map((f) => `${f.part} ${f.category}`), ['j transformed-missing']);
  assert.ok(v.json.findings[0].place.includes(bad), v.json.findings[0].place);
  // el espejo: con la lista entera otra vez, verify en 0
  tampered(two.json.transformed);
  v = await verifyRun(fx);
  assert.strictEqual(v.code, 0, v.all);
});

test.after(async () => {
  if (api) await api.close();
  for (const d of [...created, template && template.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});
