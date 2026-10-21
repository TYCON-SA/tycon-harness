'use strict';

/**
 * mirror.test.js — la sincronización con el repo público.
 *
 * Lo que no se puede perder, en orden de gravedad:
 *   · Que nada llegue al repo público sin pasar por el exportador y sus controles, y que fuera de la primera publicación
 *     ningún camino escriba en `main`: todo lo demás va a la rama `mirror/sync` y a UN pull request.
 *   · Que «no pude leer» nunca se lea como «no hay nada»: 2, sin escribir.
 *   · Que el token salga sólo de su variable, viaje por el ambiente y no aparezca en ninguna salida.
 *   · Que `verify` mire TODO lo publicado, también lo que no es git —versiones, pedidos, issues, comentarios, cada
 *     lista hasta su última página—, y que cada hallazgo diga qué hacer (T24 y T65).
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
        in: ['README.md', 'README.es.md', '.gitignore', 'scripts/**', 'guides/**', 'commands/**'],
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
    // la portada en castellano: las dos portadas viven en la raíz del arnés, no son papeles
    'README.es.md': '# Arnés de mentira\n\nPara probar la publicación, en castellano.\n',
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
  // lo publicado que no es git: lo que `verify` lee por la API, cada lista de a páginas
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
 * Corre mirror.js: `args[0]` es el subcomando (sólo `verify`). Por defecto pasa la lista de
 * denegación y el nombre público sintéticos por opción; `config: false` deja los valores por defecto.
 */
function mirror(fx, args, opts = {}) {
  const extra = [];
  if (opts.config !== false) extra.push('--denied', fx.cfg.denied, '--public-repos', fx.cfg.publicRepos);
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

/** La identidad fija con que el guion firma sus commits, como ambiente de git: sale del exportador, no se copia acá. */
function mirrorIdentity() {
  const fixed = require(EXPORTER).COMMIT_IDENTITY;
  return { GIT_AUTHOR_NAME: fixed.nombre, GIT_AUTHOR_EMAIL: fixed.email, GIT_COMMITTER_NAME: fixed.nombre, GIT_COMMITTER_EMAIL: fixed.email };
}

// Lo publicado de partida: un árbol limpio, escrito directo en el público (el público es la fuente y
// el exportador no arma la copia que se sembraba acá). `harness` y `skills` son los commits de los internos de
// mentira, para los trailers de `syncCommit`: `verify` no los compara con nada.
const SEED_FILES = {
  'README.md': '# Arnés de mentira\n\nPara probar la verificación de lo publicado.\n',
  'LICENSE': PAPERS.LICENSE,
  'guides/guia.md': '# Guía\n\nSegunda versión.\n',
  'scripts/hola.js': "'use strict';\nmodule.exports = () => 'hola';\n",
  'skills/tycon-pipeline/SKILL.md': '---\nname: tycon-pipeline\n---\n\nOrquesta el pipeline.\n',
};

/** Deja en `main` del público un commit raíz con el árbol de partida y la identidad fija de la copia. */
function seedPublication(fx) {
  const harness = gitFx(fx.harness, ['rev-parse', 'HEAD']);
  const skills = gitFx(fx.skills, ['rev-parse', 'HEAD']);
  const commit = publicCommit(fx, { files: SEED_FILES, identity: mirrorIdentity(),
    message: (tree) => `Primera publicación\n\nMirror-Harness-Commit: ${harness}\nMirror-Agent-Skills-Commit: ${skills}\nMirror-Tree: ${tree}\n` });
  const tree = gitFx(fx.bare, ['rev-parse', `${commit}^{tree}`]);
  return { commit, tree, harness, skills };
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
/** La cabecera con la que git se presenta ante GitHub: el valor que el guion le pasa por el ambiente. */
const authHeader = (credential) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${credential}`).toString('base64')}`;

// Centinelas: no tienen forma de token de nadie, sólo son únicos.
const READER = 'lector-de-mentira-0001';

// ── T1 ──────────────────────────────────────────────────────────────────────────────────────────────────────
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
    for (const command of ['verify']) {
      const r = await mirrorReadOnly(fx, [command, '--public-repos', file], { credential: READER });
      assert.strictEqual(r.code, 2, `${name}, ${command}: sale 2\n${r.all}`);
      assert.match(r.err, reason, `${name}, ${command}: dice el motivo`);
    }
  }
  // con --json el motivo también va en el objeto
  const r = await mirrorReadOnly(fx, ['verify', '--json', '--public-repos', path.join(fx.dir, 'cfg', 'no-existe.json')]);
  assert.strictEqual(r.code, 2, r.all);
  assert.strictEqual(r.json.exit, 2);
  assert.match(r.json.message, /no pude leer el nombre público/);
  // un subcomando que no existe (`import`, `push`) o vacío también es 2, sin tocar nada
  for (const command of ['import', 'push', '']) {
    const u = await mirrorReadOnly(fx, [command], { credential: READER });
    assert.strictEqual(u.code, 2, `«${command}»: sale 2\n${u.all}`);
    assert.match(u.err, /subcomando/, `«${command}»: dice por qué`);
  }
  assert.deepStrictEqual(fx.api.requests, [], 'ningún pedido a la API');
  assert.deepStrictEqual(pushes(fx), [], 'ningún push');
});

// T36: la mitad que llevaba la copia del exportador al público y absorbía los cambios ajenos no
// existe. Cada uno de sus tres subcomandos sale 2 diciendo que no existe —no «subcomando desconocido», que se leería
// como un error de tipeo—, sin leer el público, sin la API y sin empujar; también con --json y con las opciones que
// tenían. Lo que queda es verify, y `module.exports` no trae nada de la sincronización.
test('T36 Exporter_ClassifiesAndVerifiesOnly_AbsorbHalfRemoved — mirror.js: plan, first y sync ya no existen; queda verify', async () => {
  const fx = await fixture();
  seedPublication(fx);
  for (const command of ['plan', 'first', 'sync']) {
    for (const extra of [[], ['--json'], ['--harness', 'HEAD', '--agent-skills', 'HEAD']]) {
      const r = await mirrorReadOnly(fx, [command, ...extra], { credential: WRITER_T36 });
      assert.strictEqual(r.code, 2, `${command} ${extra.join(' ')}: sale 2\n${r.all}`);
      assert.match(r.err, new RegExp(`${command} ya no existe: el repo público es la fuente`), `${command}: dice que ya no existe\n${r.all}`);
      assert.doesNotMatch(r.err, /subcomando desconocido/, `${command}: no se confunde con un error de tipeo`);
      if (extra.includes('--json')) assert.strictEqual(r.json && r.json.exit, 2, `${command} --json: el código también en el objeto`);
    }
  }
  assert.deepStrictEqual(fx.api.requests, [], 'ninguno leyó la API');
  assert.deepStrictEqual(pushes(fx), [], 'ningún push');
  // verify sigue, y es directo aunque no se lo pidan: las tres partes de la sincronización dicen «no aplica»
  const v = await verifyRun(fx);
  assert.strictEqual(v.code, 0, v.all);
  assert.deepStrictEqual(v.json.notApplicable.map((x) => x.part).sort(), ['f', 'i', 'j'], 'f, i y j: no aplica');
  assert.strictEqual(v.json.direct, true, 'verify es siempre directo');
  const mod = require(MIRROR);
  assert.deepStrictEqual(mod.COMMANDS, ['verify'], 'el único subcomando');
  for (const gone of ['STATES', 'TRAILERS', 'MARKS', 'nextVersion', 'versionDay', 'isSingleRepoTree']) {
    assert.strictEqual(mod[gone], undefined, `module.exports ya no trae ${gone}`);
  }
  assert.ok(!fs.readFileSync(MIRROR, 'utf8').includes("'--output'"), 'el guion no le pide al exportador que arme ninguna copia');
});
const WRITER_T36 = 'escritor-de-mentira-t36';

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

// ── T24 ────────────────────────────────────────────────────────────────────────────────────────────────────
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

// ── lo publicado que no es git, qué hacer con cada hallazgo, y el modo directo ────────
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
    // hasta dónde llegó: una versión, un texto de un pedido/issue/comentario, o algo del repo
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

// Texto publicado que ninguna de las listas de la prueba de arriba trae.
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
  // T70: cada hallazgo dice además hasta dónde llegó (`reach`), no sólo en el texto del consejo.
  // El aviso lo lee para saber qué es «de la historia de main».
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
  // (un commit escrito directo en `main` no es un «cambio ajeno»: el público es la fuente)
  reset();
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
  const direct = await verifyRun(fx);
  assert.strictEqual(direct.code, 0, `un commit directo en main no es un hallazgo\n${direct.all}`);
  // con el repo privado el consejo toca sólo lo que nombraba la purga
  fx.api.state.credential = READER;
  fx.api.state.repo.private = true;
  reset();
  gitFx(fx.bare, ['update-ref', `refs/replace/${seed.commit}`, seed.commit]);
  await one('una ref de reemplazo', 'replace-ref', (f) => assert.deepStrictEqual([f.part, f.action], ['c', 'delete']));
  reset();
  fx.api.state.alerts = [{ number: 3, state: 'open' }];
  await one('una alerta del escaneo de secretos', 'secret-alert', (f) => {
    assert.deepStrictEqual([f.part, f.action, f.rotateFirst], ['g', 'see-guide', true]);
    assert.match(f.todo, /^es un secreto: se rota PRIMERO .*después, qué hacer: guides\//);
  }, { credential: READER });

  // ── hasta dónde llegó se dice por los COMMITS que lo traen, no por el objeto ──
  // 🔴 un submódulo que llegó a main y después se sacó. Su objeto es un commit de OTRO repo: nunca está entre los
  // alcanzables de éste, y mirado por su objeto saldría siempre como «cuelga de una rama: se borra».
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
  // agota el cupo de la hora (de ahí en más la API contesta 403 a todo), las alertas ya se leyeron. Con otro orden
  // quedarían «no medidas» la misma noche en que más importan.
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
    // de adentro de un evento de la línea de tiempo, si viene y no es un texto, tampoco es «sin texto»
    ['un comentario de revisión sin el fragmento del cambio', (s) => { s.reviewComments = [{ id: 1, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', path: 'docs/aporte.md' }]; }, ['m']],
    ['un comentario de revisión sin su ruta', (s) => { s.reviewComments = [{ id: 1, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', diff_hunk: '@@ -0,0 +1 @@\n+Limpio.' }]; }, ['m']],
    ['un comentario de revisión con una ruta que no es un texto', (s) => { s.reviewComments = [{ id: 1, pull_request_url: 'https://api.example.test/repos/o/r/pulls/7', body: 'Bien.', path: ['docs'], diff_hunk: '' }]; }, ['m']],
    ['un comentario sobre un commit con una ruta que no es un texto', (s) => { s.commitComments = [{ id: 1, commit_id: 'a'.repeat(40), body: 'Visto.', path: { nombre: 'x' } }]; }, ['m']],
    ['un evento con un título anterior que no es un texto', (s) => { s.issueEvents = [{ id: 1, event: 'renamed', issue: { number: 7 }, rename: { from: ['Un título'], to: 'Otro' } }]; }, ['l', 'm']],
    ['un evento con un «rename» que no es un objeto', (s) => { s.issueEvents = [{ id: 1, event: 'renamed', issue: { number: 7 }, rename: 7 }]; }, ['l', 'm']],
    ['un evento con una etiqueta que no es un objeto', (s) => { s.issueEvents = [{ id: 1, event: 'labeled', issue: { number: 7 }, label: [{ name: 'bug' }] }]; }, ['l', 'm']],
    // …y en cualquier parte que lee la API: donde va un texto, otra cosa (un objeto, un número, una lista) no se lee
    // como «[object Object]», que saldría limpio
    ['el cuerpo de un comentario que es un objeto', (s) => { s.issueComments = [{ id: 1, issue_url: 'https://api.example.test/repos/o/r/issues/7', body: { texto: 'Bien.' } }]; }, ['m']],
    ['el cuerpo de una revisión que es una lista', (s) => { s.reviews = { 7: [{ id: 1, body: ['Bien.'] }] }; }, ['m']],
    ['el cuerpo de un issue que es un número', (s) => { s.issues = [pr7, { number: 9, state: 'open', title: 'Un bug', body: 7 }]; }, ['l', 'm']],
    ['las notas de una versión que son una lista', (s) => { s.releases = [{ id: 1, name: 'v', tag_name: 'v', body: ['Notas.'], assets: [] }]; }, ['k']],
    ['la descripción del repo que es un objeto', (s) => { s.repo.description = { texto: 'Un arnés' }; }, ['d']],
    ['el título del pedido abierto de la sincronización que es un objeto', () => { fx.api.override = (q) => (q.method === 'GET' && q.path.endsWith('/pulls') && q.query.state === 'open' ? { status: 200, json: [{ number: 1, title: {}, body: '', head: { ref: 'mirror/sync' } }] } : null); }, ['e']],
    ['un comentario sobre un commit que no es un objeto', (s) => { s.commitComments = ['x']; }, ['m']],
    ['una revisión que no es un objeto', (s) => { s.reviews = { 7: [{ id: 1, body: '' }, null] }; }, ['m']],
    // las dos partes más viejas que leen la API tienen que fallar igual de a la vista: el pedido abierto de la
    // sincronización y los temas del repo
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
  const KEYS = ['action', 'category', 'part', 'place', 'reach', 'rotateFirst', 'todo'];   // `reach`: hasta dónde llegó
  assert.deepStrictEqual(written.findings.map((f) => Object.keys(f).sort()), [KEYS, KEYS]);
  assert.deepStrictEqual(written.findings.map((f) => f.reach), ['conversation', 'conversation']);
  assert.strictEqual(written.private, false);
  // T70: con el repo privado el secreto se sigue rotando primero, y ninguno de los dos pide la purga
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
  // paso que avisa lee este archivo: sin él diría «no dejó un informe», no el motivo
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
  assert.deepStrictEqual(lib.reportForFile(crashed), { exit: 2, message: 'error no previsto (el detalle, en el registro de la ejecución)', data: {} }, 'la traza de un error no previsto no va al informe (termina en un aviso)');
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

  // sin --direct es lo mismo (verify es siempre directo): ese commit no es ajeno, y el `noreply` no es
  // un hallazgo
  let r = await verifyRun(fx);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.strictEqual(r.json.direct, true);

  // con --direct: el público es la fuente. Ese commit no es ajeno, y las tres partes de la sincronización dicen «no aplica»
  r = await verifyRun(fx, ['--direct']);
  assert.strictEqual(r.code, 0, r.all);
  assert.deepStrictEqual(r.json.findings, []);
  assert.deepStrictEqual(r.json.couldNotLook, []);
  assert.strictEqual(r.json.direct, true);
  assert.deepStrictEqual(r.json.notApplicable.map((n) => n.part).sort(), ['f', 'i', 'j']);
  for (const n of r.json.notApplicable) assert.match(n.reason, /el público es la fuente/);
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
  // las opciones de los internos ya no existen: se rechazan, no se ignoran en silencio
  r = await verifyRun(fx, ['--direct', '--harness', 'HEAD']);
  assert.strictEqual(r.code, 2, r.all);
  assert.match(r.err, /opción desconocida: --harness/);

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
  // un correo que NO es noreply sigue siendo un hallazgo (la regla genérica de correos)
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

// ── T25 ────────────────────────────────────────────────────────────────────────────────────────────────
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

  // un commit escrito directo en main no es un cambio ajeno (el público es la fuente): 0
  publicCommit(fx, { parents: [seed.commit], files: { 'docs/ajeno.md': '# Ajeno\n' }, message: 'Un cambio mergeado en GitHub' });
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
  assert.deepStrictEqual(r.json.notApplicable.map((n) => n.part).sort(), ['f', 'g', 'h', 'i', 'j'], 'g y h con el repo privado; f, i y j siempre');
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
  // issues, comentarios)
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

// ── el token y las credenciales ──────────────────────────────────────────────────────────────────────────────────────
const WRITER = 'escritor-de-mentira-0002';
const AMBIENT = 'credencial-del-ambiente-0003';
const MAIN_REF = 'refs/heads/main';
const SYNC_REF = 'refs/heads/mirror/sync';
const tipOf = (bare, ref) => gitFx(bare, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { tolerate: true }).stdout.trim();
const base64 = (credential) => authHeader(credential).split(' ').pop();

// ── T23 ────────────────────────────────────────────────────────────────────────────────────────────────────
test('Mirror_Token_OnlyExplicitNeverInArgsNorDisk', async () => {
  // la cabecera con que git se presenta, con la base por defecto: una entrada de configuración por el ambiente
  assert.deepStrictEqual(require(MIRROR).gitAuth('abc', 'https://github.com'), {
    GIT_ASKPASS: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: authHeader('abc'),
  });

  // sin el token explícito y con credenciales de la máquina en el ambiente: verify lee lo que es público, y esas
  // credenciales no viajan: ni a git ni a la API
  let fx = await fixture();
  seedPublication(fx);
  let github = fakeGit(fx);
  const ambient = { ...github.env, GH_TOKEN: AMBIENT, GITHUB_TOKEN: AMBIENT };
  for (const command of ['verify']) {
    const r = await mirrorReadOnly(fx, [command, '--json'], { env: ambient });
    assert.strictEqual(r.code, 0, `${command}: ${r.all}`);
    assert.ok(!r.all.includes(AMBIENT), `${command}: la credencial del ambiente no aparece`);
  }
  assert.ok(remoteCalls(github).length >= 1, 'control: git habló con el público');
  assert.ok(gitCalls(github).every((c) => !('GIT_CONFIG_COUNT' in c.env) && !('GIT_CONFIG_VALUE_0' in c.env)), 'git no recibe ninguna cabecera');
  assert.ok(fx.api.requests.length > 0, 'control: verify habló con la API');
  assert.ok(fx.api.requests.every((q) => q.headers.authorization === undefined), 'la API no recibe ninguna credencial');
  assert.ok(!JSON.stringify(fx.api.requests).includes(AMBIENT));

  // con el token explícito: verify lo manda a git por el ambiente y a la API en su cabecera, y a ningún otro lado
  const header = authHeader(WRITER);
  for (const [command, extra] of [['verify', ['--json']], ['verify', []]]) {
    const name = `${command} ${extra.join(' ')}`;
    fx = await fixture();
    seedPublication(fx);
    const tmp = path.join(fx.dir, 'tmp');
    fs.mkdirSync(tmp);
    github = fakeGit(fx, { requires: WRITER, watch: { dir: tmp, needles: [WRITER, base64(WRITER)] } });
    fx.api.state.credential = WRITER;
    const r = await mirror(fx, [command, ...extra], { credential: WRITER, env: { ...github.env, TMPDIR: tmp, GH_TOKEN: AMBIENT, GITHUB_TOKEN: AMBIENT } });
    assert.strictEqual(r.code, 0, `${name}: ${r.all}`);
    assert.deepStrictEqual(pushes(fx), [], `${name}: verify no empuja`);
    // ninguna salida lo trae, ni entero ni en la cabecera
    for (const secret of [WRITER, base64(WRITER), AMBIENT]) assert.ok(!r.all.includes(secret), `${name}: el token no aparece en ninguna salida`);
    // ningún argumento de git lo trae; el ambiente trae la cabecera sólo cuando git habla con el público
    const calls = gitCalls(github);
    const remote = calls.filter((c) => / (ls-remote|fetch|push) /.test(c.args));
    assert.ok(remote.some((c) => / fetch /.test(c.args)), `${name}: control, git habló con el público`);
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
    assert.deepStrictEqual(holding(WRITER), [fake], `${name}: el token no quedó en ningún archivo de la ejecución`);
    assert.deepStrictEqual(holding(base64(WRITER)), [fake, github.log].sort(), `${name}: la cabecera tampoco`);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], `${name}: el temporal de la ejecución no queda`);
    // la API lo recibe en su cabecera, y nunca la credencial del ambiente
    assert.ok(fx.api.requests.length > 0 && fx.api.requests.every((q) => q.headers.authorization === `Bearer ${WRITER}`), `${name}: a la API le habla con el token`);
    assert.ok(!JSON.stringify(fx.api.requests).includes(AMBIENT), `${name}: la credencial del ambiente no viaja`);
  }
});

const openPulls = (fx) => fx.api.state.pulls.filter((p) => p.state === 'open');

// ── BLOQUE T21-T22: inicio ───────────────────────────────────────────────────────────────────────────────────────
// El token de instalación de la App: `github-app-token.js` contra una API de mentira en 127.0.0.1,
// con un par de llaves generado en cada prueba. El servidor vive en este mismo proceso: el guion se lanza con `spawn` y
// una promesa, nunca con `spawnSync` (el servidor no contesta mientras el proceso espera, y la prueba se cuelga).
const tokenScript = path.join(RAIZ, 'scripts', 'publishing', 'github-app-token.js');
// los permisos de la tarea humana TH2: los que usa la sincronización, ni uno más
const tokenPermissions = Object.freeze({
  contents: 'write', pull_requests: 'write', workflows: 'write',
  metadata: 'read', administration: 'read', secret_scanning_alerts: 'read',
  // la lista de issues y su línea de tiempo no entran con ningún otro permiso
  issues: 'read',
});
// T72 · Qué permiso acepta GitHub para cada dirección que `verify` lee (cualquiera de los de la fila alcanza). Sale de
// la tabla de GitHub «Permissions required for GitHub Apps», leída fila por fila. Una dirección nueva sin su permiso en el
// token da un 403 recién en una corrida de verdad: con esta tabla, es un rojo de la suite.
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

// ── T28 ────────────────────────────────────────────────────────────────────────────────────────────────────
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
  const rel = 'guides/maintaining/publicacion-espejo.md';
  const whole = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  // lo que sale en la copia: sin los bloques internos. En la copia no están, y la prueba da lo mismo
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
  for (const title of ['Alertas de prueba en GitHub', 'Si `verify` da 1']) assert.ok(cited.includes(title), `el guion remite a §«${title}»`);
  for (const title of cited) assert.ok(titles.includes(title), `el guion remite a §«${title}», y la guía tiene esa sección`);
});

// ── Casos de borde del pase adversarial ────────────────────────────────────────────────────────────────────────────
// Cada prueba falla contra un guion que no cubra la causa que nombra.

/** Un correo de una persona de afuera, con un dominio inventado que no es de ejemplo: por partes, como los demás. */
const OUTSIDER = { name: 'Colaboradora De Afuera', email: ['colaboradora', 'correo-inventado.dev'].join('@') };
const OUTSIDER_NOREPLY = ['12345+colaboradora', 'users.noreply.github.com'].join('@');
const identityOf = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });

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

// ── las bases sólo por http hacia esta máquina ────────────────────────────────────────────────────────────────────
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
      for (const command of ['verify']) {
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
    const nobody = await closedPort();
    let r = await mirrorReadOnly(fx, ['verify'], { credential: WRITER, env: { ...github.env, [GIT]: `HTTP://127.0.0.1:${a.port}/`, [API]: `http://127.0.0.1:${nobody}` } });
    assert.strictEqual(r.code, 2, `el servidor de mentira contesta 404: no pude leer\n${r.all}`);
    assert.match(r.all, /no pude leer/);
    assert.ok(a.seen.length > 0 && a.seen.every((q) => q.url.startsWith(`/${PUBLIC.org}/${PUBLIC.repo}.git/`)), JSON.stringify(a.seen));
    assert.ok(a.seen.every((q) => String(q.authorization).toLowerCase() === `basic ${base64(WRITER)}`.toLowerCase()), 'con la cabecera de la ejecución');
    assert.deepStrictEqual(b.seen, []);
    const asked = remoteCalls(github, 'fetch');
    assert.strictEqual(asked.length, 1);
    assert.ok(asked[0].args.includes(` http://127.0.0.1:${a.port}/${PUBLIC.org}/${PUBLIC.repo}.git `), `a git le llega la URL normalizada\n${asked[0].args}`);
    assert.strictEqual(asked[0].env.GIT_CONFIG_KEY_0, `http.http://127.0.0.1:${a.port}/.extraheader`, 'y la cabecera va para esa misma base');
    // las tres formas de nombrar a la propia máquina valen en la base de la API: la regla de la base no la frena (nadie
    // escucha en ese puerto, así que lo que dice es «no pude leer», nunca «sin cifrar»)
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      r = await mirrorReadOnly(fx, ['verify'], { credential: WRITER, env: { [API]: `http://${host}:${nobody}` } });
      assert.doesNotMatch(r.all, /sin cifrar|TYCON_MIRROR_API_URL/, `${host}: la base se acepta\n${r.all}`);
    }
    // y lo cifrado va a donde sea: la regla es sobre http://
    r = await mirrorReadOnly(fx, ['verify'], { credential: WRITER, env: { [API]: `https://127.0.0.1:${nobody}/v3` } });
    assert.doesNotMatch(r.all, /sin cifrar|TYCON_MIRROR_API_URL/, r.all);
  } finally {
    await a.close();
    await b.close();
  }
});

// ── commits de pull: el correo de un tercero no se juzga ──────────────────────────────────────────────────────────
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
    ['el correo, en un commit de main', () => aporte(MAIN_REF, identityOf(OUTSIDER.name, OUTSIDER.email)), ['c'], 'email'],
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

// ── lo que `verify` tiene que mirar ──────────────────────────────────────────────────────────────────────────────────────
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

// ── `verify` mira todas las refs que el servidor sirve ────────────────────────────────────────────────────────────
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

// ── los nombres de ruta de todo árbol alcanzable ──────────────────────────────────────────────────────────────────
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

// ── etiquetas anidadas y el nombre de etiqueta declarado ──────────────────────────────────────────────────────────
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

// ── byte de control en un mensaje: nada se saltea ─────────────────────────────────────────────────────────────────
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

// ── mismo blob bajo dos rutas: un veredicto por ruta ──────────────────────────────────────────────────────────────
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

});

// ── cada corrida con --json lleva su mensaje ──────────────────────────────────────────────────────────────────────
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
  seedPublication(fx);
  let j = await run(['verify', '--strict']);
  assert.strictEqual(j.exit, 0);
  assert.strictEqual(j.message, 'sin hallazgos');
  j = await run(['verify'], { credential: null });
  assert.strictEqual(j.exit, 0);
  assert.match(j.message, /sin hallazgos.*NO MEDIDO \(g\)/, 'lo que no se midió también se dice ahí');
  // y las que frenan, como siempre: hallazgos (1) y los subcomandos que ya no existen (2)
  fx.api.state.vulnerabilityReporting = { enabled: false };
  j = await run(['verify']);
  assert.strictEqual(j.exit, 1);
  j = await mirror(fx, ['sync', '--json'], { credential: WRITER });
  assert.strictEqual(j.code, 2, j.all);
  assert.ok(j.json && j.json.exit === 2 && /ya no existe/.test(j.json.message), `sync --json: el motivo va en message\n${j.all}`);
  assert.strictEqual(said.length, 3);
});

// ── tres lugares donde `verify` daría «limpio» sin haber mirado ─────────────────────
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
  for (const command of ['verify']) {
    const fx = await fixture();
    seedPublication(fx);
    const github = fakeGit(fx);
    const r = await mirror(fx, [command], { credential: WRITER, env: github.env });
    assert.strictEqual(r.code, 0, `${command}: ${r.all}`);
    const remote = remoteCalls(github);
    const kinds = ['fetch'];
    for (const kind of kinds) assert.ok(remote.some((c) => c.args.includes(` ${kind} `)), `${command}: control, hubo un ${kind}`);
    for (const c of remote) assert.ok(c.args.includes(' -c http.followRedirects=false '), `${command}: sin seguir redirecciones (${c.args.slice(0, 120)})`);
  }

  // y de verdad: el servidor del público contesta una redirección a otro servidor. Nadie la sigue, y el token no viaja
  const fx = await fixture();
  const b = await listener();
  const a = await listener((req) => ({ Location: `http://127.0.0.1:${b.port}${req.url}` }));
  try {
    for (const command of ['verify']) {
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

// ── el repo único ─────────────────────────────────────────────────────────────────────────────────────────────────
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

// ══ T7 — la lista de transformados viaja en el version.json publicado ══════════════════════════════════════════════════
// El version.json que llega al público lo escribe ESTA sincronización (`numberRun`, en `first` y en `sync`), no el
// exportador: sin la lista acá, cada máquina con la capa privada vería «capa de otra versión». La lista es la del
// exportador de esa corrida (su --json), y `verify` comprueba que nombra exactamente las rutas publicadas cuyo blob no
// es el del commit interno de su sincronización. La mitad del exportador está en export.test.js.

test.after(async () => {
  if (api) await api.close();
  for (const d of [...created, template && template.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});
