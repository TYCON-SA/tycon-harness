'use strict';

/**
 * export.test.js — la copia pública de cada paquete del arnés (épica 8, story 8.4, tanda A, 2026-09-27).
 *
 * Lo que no se puede perder, en orden de gravedad:
 *   · Que salga EXACTAMENTE lo del commit y de la lista blanca: nunca el árbol de trabajo, nunca lo privado de la
 *     publicación (denegados, reemplazos), nunca una superficie de un revisor de otro paquete.
 *   · Que con un hallazgo no quede ni copia ni temporal, y que «no pude mirar» sea 2 — nunca 0 ni 1.
 *   · Que cada repo de la copia sea UN commit, idéntico en cualquier máquina: plomería de git con la
 *     configuración de la máquina afuera.
 *
 * Arma en un temporal dos repos de mentira (un arnés y un agent-skills) con DOS commits cada uno, y pasa las tres
 * configuraciones SINTÉTICAS por opción: nunca lee la lista de denegación ni la tabla de reemplazos reales — son
 * privadas y en la copia pública, donde esta suite también corre, no existen.
 */

const test = require('./lib/suite-parts.js').test;   // se corre por partes: lib/suite-parts.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const EXPORTAR = path.join(RAIZ, 'scripts', 'publishing', 'export.js');
const DETECTOR = path.join(RAIZ, 'scripts', 'publishing', 'detector.js');

// ── git de la fixture: sin la configuración de la máquina, con autor y fechas fijas ────────────────
function sinGit(env) {
  const e = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_')) e[k] = v;
  return e;
}
const GIT_AISLADO = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

function gitFx(dir, args, opts = {}) {
  const env = {
    ...sinGit(process.env), ...GIT_AISLADO,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
    ...(opts.env || {}),
  };
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { env, encoding: 'utf8', input: opts.input });
  if (r.status !== 0 && !opts.tolerar) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return opts.tolerar ? r : r.stdout.trim();
}

let reloj = 1700000000;
function commitear(dir, mensaje, { sinAgregar = false } = {}) {
  reloj += 100;
  const fecha = `@${reloj} +0000`;
  if (!sinAgregar) gitFx(dir, ['add', '-A']);
  gitFx(dir, ['commit', '-q', '-m', mensaje], { env: { GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  return gitFx(dir, ['rev-parse', 'HEAD']);
}

/** Commitea sobre HEAD un árbol con una entrada cruda en `carpeta` (lo que sólo un árbol armado a mano puede traer). */
function agregarEntradaCruda(repo, carpeta, linea, mensaje) {
  const sub = gitFx(repo, ['ls-tree', `HEAD:${carpeta}`]);
  const nuevoSub = gitFx(repo, ['mktree'], { input: `${sub}\n${linea}\n` });
  const raiz = gitFx(repo, ['ls-tree', 'HEAD']).split('\n')
    .map((l) => (l.endsWith(`\t${carpeta}`) ? l.replace(/ tree [0-9a-f]+\t/, ` tree ${nuevoSub}\t`) : l)).join('\n');
  const arbol = gitFx(repo, ['mktree'], { input: `${raiz}\n` });
  reloj += 100;
  const fecha = `@${reloj} +0000`;
  const c = gitFx(repo, ['commit-tree', arbol, '-p', 'HEAD', '-m', mensaje], { env: { GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  gitFx(repo, ['update-ref', 'refs/heads/main', c]);
}
const arbolCon = (repo, lineas) => gitFx(repo, ['mktree'], { input: `${lineas.join('\n')}\n` });
const blob = (repo, contenido) => gitFx(repo, ['hash-object', '-w', '--stdin'], { input: contenido });

function escribir(raiz, archivos) {
  for (const [rel, contenido] of Object.entries(archivos)) {
    const abs = path.join(raiz, rel);
    if (contenido === null) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contenido);
  }
}

function listar(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listar(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return base === dir ? out.sort() : out;
}

const clonar = (x) => JSON.parse(JSON.stringify(x));
const existe = (salida, rel) => fs.existsSync(path.join(salida, rel));
const leer = (salida, rel) => fs.readFileSync(path.join(salida, rel), 'utf8');
/**
 * Un .gitignore de la copia de un solo repo, partido donde empieza el bloque de las carpetas de las que no sale nada
 * (story 8.26, AC 30): `{ own, folders }` — lo que venía del repo, tal cual, y las carpetas que sumó el exportador. El
 * comentario del bloque se le pide al exportador: si cambia, estas pruebas lo siguen.
 */
function splitPrivateBlock(texto) {
  const note = `${require(EXPORTAR).PRIVATE_FOLDERS_NOTE.join('\n')}\n`;
  const at = texto.indexOf(note);
  if (at === -1) return { own: texto, folders: [] };
  return { own: texto.slice(0, at), folders: texto.slice(at + note.length).split('\n').filter(Boolean) };
}

// ── contenido de la fixture ────────────────────────────────────────────────────────────────────────
const REVISORES = ['revisor-nucleo', 'tycon-plugin-dotnet-conventions', 'revisor-cliente'];
const DE_PAQUETE = ['tycon-plugin-dotnet-conventions', 'revisor-cliente'];
const agente = (nombre, cuerpo) =>
  `---\nname: ${nombre}\ndescription: Revisor de mentira ${nombre}\nmodel: sonnet\ntools: Read, Grep, Glob\n---\n\n${cuerpo}\n`;

const MANIFIESTO = `${JSON.stringify({ advisors: REVISORES }, null, 2)}\n`;
const LINEA_BASE = `${JSON.stringify({
  fixed_at: '2026-01-01T00:00:00Z', tool: 'claude', runs: 1,
  cases: {
    'revisor-nucleo::caso-1': true,
    'tycon-plugin-dotnet-conventions::caso-1': true,
    'revisor-nucleo::limpio': true,
    'revisor-cliente::caso-1': false,
  },
}, null, 2)}\n`;
const LINEA_BASE_NUCLEO = `${JSON.stringify({
  fixed_at: '2026-01-01T00:00:00Z', tool: 'claude', runs: 1,
  cases: { 'revisor-nucleo::caso-1': true, 'revisor-nucleo::limpio': true },
}, null, 2)}\n`;
const CATALOGO = [
  '# Catálogo de reglas', '', 'Intro.', '',
  '## Núcleo — `revisor-nucleo`', '', 'Reglas NUC-C1.', '',
  '## .NET — `tycon-plugin-dotnet-conventions`', '', 'Reglas DOTNET-C1.', '', '```text', '~~~', '## esto no es un encabezado', '```', '',
  '## Cliente — `revisor-cliente`', '', 'Reglas XPAT-C1.', '',
  '## Agregar una regla nueva', '', 'Pasos.', '',
].join('\n');
const CATALOGO_NUCLEO = [
  '# Catálogo de reglas', '', 'Intro.', '',
  '## Núcleo — `revisor-nucleo`', '', 'Reglas NUC-C1.', '',
  '## Agregar una regla nueva', '', 'Pasos.', '',
].join('\n');
const SUITES_BASE = `${JSON.stringify({ __doc: 'Suites de mentira.', diarias: [{ raiz: 'arnes', ruta: 'tests/uno.test.js', requiere: [] }] }, null, 2)}\n`;
const EXAMEN = [
  '{',
  '  "__doc": "Config del examen.",',
  '  "designated_machine": "Mac-Del-Equipo",',
  '  "days_between_runs": 2,',
  '  "scheduled_days": ["tuesday", "friday"],',
  '  "hour": "02:00"',
  '}', '',
].join('\n');
const DEUDA_REAL = '{\n  "debt": [\n    { "id": "X-1", "repo": "Equipo/Repo" }\n  ]\n}\n';
const DEUDA_SINTETICA = '{\n  "__doc": "sintética",\n  "debt": []\n}\n';

// La muestra de cada exclusión fija: un archivo que la exclusión cubre (así la regla «exclusión fija sin
// archivo» no salta en la fixture base, y cada prueba que la quiera ver roja borra una muestra).
function fijas() {
  try { return require(EXPORTAR).EXCLUIDOS_SIEMPRE || []; } catch { return []; }
}
function muestra(glob) {
  return glob.replace(/^\*\*\//, '').replace(/\/\*\*$/, '/muestra.txt').replace(/[*?]/g, 'x');
}
function muestras(fuente) {
  return fijas().filter((f) => f.fuente === fuente && !f.clase).map((f) => muestra(f.glob));
}

const LISTA_BASE = {
  __doc: 'Lista blanca sintética de la prueba.',
  packages: {
    core: {
      arnes: {
        in: ['README.md', '.gitignore', 'scripts/**', 'guides/**', 'build/**', 'adapters/**', 'commands/**'],
        out: [{ glob: 'guides/bizuit/*.md', reason: 'va al paquete bizuit' }],
      },
      'agent-skills': {
        in: ['.gitignore', 'skills/tycon-*/**', 'agents/*.md'],
        out: [
          { glob: 'packs/**', reason: 'cada manifiesto viaja con su paquete' },
          { glob: 'skills/bizuit-sdd/**', reason: 'va al paquete bizuit' },
        ],
      },
    },
    bizuit: {
      arnes: { in: ['guides/bizuit/bizuit-plugin.md'], out: [] },
      'agent-skills': {
        in: ['packs/bizuit/pack.json', 'agents/tycon-plugin-dotnet-conventions.md', 'skills/bizuit-sdd/**'],
        out: [{ glob: 'skills/bizuit-sdd/tests/fixtures/bpmn/**', reason: 'procesos reales de clientes', until: '8.6' }],
      },
    },
  },
  suitesOutside: [],
  casesOutside: [],
  empty: {},
  synthetic: [],
};
const REEMPLAZOS_BASE = {
  pares: [{
    real: 'AcmeCorp', categoria: 'cliente',
    formas: [{ texto: 'AcmeCorp', anonimo: 'ClienteA' }, { texto: 'ACME', anonimo: 'CLIENTEA' }, { texto: 'acmecorp', anonimo: 'clientea' }],
    palabra: true, mayusculas: true, anonimoProsa: 'Cliente A',
  }],
  afuera: [],
};
const DENEGADOS_BASE = {
  terminos: [
    { patron: 'AcmeCorp', categoria: 'cliente', palabra: true },
    { patron: 'ACME', categoria: 'cliente', palabra: true, mayusculas: true },
  ],
  emailsPermitidos: ['arnes@tycon.com.ar'],
};
// El nombre público de mentira (story 8.7, AC 14): el de verdad vive en scripts/publishing/public-repos.json, que no viaja.
const PUBLICO = { __doc: 'nombre público de mentira', org: 'example-org', repo: 'example-harness' };

// ── la fixture: se arma una vez y cada prueba trabaja sobre su copia ─────────────────────────────────
let plantilla = null;
function armarPlantilla() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-plantilla-'));
  const arnes = path.join(dir, 'arnes');
  const skills = path.join(dir, 'agent-skills');
  for (const d of [arnes, skills]) {
    fs.mkdirSync(d, { recursive: true });
    gitFx(d, ['init', '-q', '-b', 'main']);
  }
  const deArnes = {
    'README.md': '# Arnés de mentira\n\nLo usa AcmeCorp todos los días.\n',
    '.gitignore': 'node_modules/\n*.log\n',
    'scripts/hola.js': "'use strict';\nmodule.exports = () => 'hola';\n",
    'scripts/tests/uno.test.js': "'use strict';\nrequire('node:assert').ok(true);\n",
    'scripts/tests/suites.json': SUITES_BASE,
    'scripts/controls-bench/baseline/claude-advisors.json': LINEA_BASE,
    'scripts/controls-bench/exam-config.json': EXAMEN,
    'scripts/publishing/synthetic/pipeline-debt.json': DEUDA_SINTETICA,
    'guides/guia.md': '# Guía\n\nPrimera versión.\n',
    'guides/advisor-rules-catalog.md': CATALOGO,
    'guides/bizuit/bizuit-plugin.md': '# Plugins de Bizuit\n\nCómo se arma uno.\n',
    'build/generate.js': fs.readFileSync(path.join(RAIZ, 'build', 'generate.js')),
    'build/equivalences.json': fs.readFileSync(path.join(RAIZ, 'build', 'equivalences.json')),
    'adapters/codex/agents/MANIFEST.json': MANIFIESTO,
  };
  for (const a of REVISORES) deArnes[`scripts/controls-bench/cases/advisors/${a}.json`] = `{ "agente": "${a}", "casos": [] }\n`;
  for (const m of muestras('arnes')) deArnes[m] = 'muestra de una exclusión fija\n';
  deArnes['scripts/ci/pipeline-debt.json'] = DEUDA_REAL;
  // story 8.10 (AC 18): el exportador lee los productos del registro de paridad; el de la fixture, uno que la lista ve
  deArnes['scripts/ci/product-parity.json'] =`${JSON.stringify({ grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/Backend' }] } }, null, 2)}\n`;
  escribir(arnes, deArnes);

  const deSkills = {
    '.gitignore': 'node_modules/\n',
    'skills/tycon-pipeline/SKILL.md': '---\nname: tycon-pipeline\n---\n\nOrquesta el pipeline.\n',
    'skills/tycon-pipeline/scripts/paso.js': "'use strict';\nmodule.exports = 1;\n",
    'agents/revisor-nucleo.md': agente('revisor-nucleo', 'Revisa el núcleo.'),
    'agents/tycon-plugin-dotnet-conventions.md': agente('tycon-plugin-dotnet-conventions', 'Revisa convenciones .NET.'),
    'agents/revisor-cliente.md': agente('revisor-cliente', 'Revisa lo del cliente.'),
    'packs/bizuit/pack.json': `${JSON.stringify({ name: 'bizuit', reviewers: [{ agent: 'tycon-plugin-dotnet-conventions', group: 'base' }] }, null, 2)}\n`,
    'packs/clients/pack.json': `${JSON.stringify({ name: 'clients', reviewers: [{ agent: 'revisor-cliente', group: 'condicional' }, { agent: 'revisor-cliente', group: 'validacion' }] }, null, 2)}\n`,
    'skills/bizuit-sdd/SKILL.md': '---\nname: bizuit-sdd\n---\n\nProcesos BPM.\n',
    'skills/bizuit-sdd/tests/fixtures/bpmn/proceso.bpmn': '<definitions/>\n',
  };
  for (const m of muestras('agent-skills')) deSkills[m] = 'muestra de una exclusión fija\n';
  escribir(skills, deSkills);
  regenerarCodex(arnes, skills);

  const primero = { arnes: commitear(arnes, 'primero'), skills: commitear(skills, 'primero') };
  escribir(arnes, { 'scripts/segundo.js': "'use strict';\nmodule.exports = 2;\n", 'guides/guia.md': '# Guía\n\nSegunda versión.\n' });
  escribir(skills, { 'skills/tycon-pipeline/segundo.md': '# Segundo\n' });
  commitear(arnes, 'segundo');
  commitear(skills, 'segundo');
  return { dir, primero };
}

/** Las traducciones a Codex del arnés de mentira, con el generador REAL (copiado a la fixture). */
function regenerarCodex(arnes, skills) {
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-codex-'));
  const r = spawnSync(process.execPath, [path.join(arnes, 'build', 'generate.js')], {
    encoding: 'utf8',
    env: { ...sinGit(process.env), TYCON_AGENTS_DIR: path.join(skills, 'agents'), HOME: aux, CODEX_HOME: path.join(aux, 'codex') },
  });
  fs.rmSync(aux, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, `la fixture no pudo generar las traducciones a Codex: ${r.stderr}`);
}

const creados = [];
function fixture() {
  if (!plantilla) plantilla = armarPlantilla();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-'));
  creados.push(dir);
  fs.cpSync(plantilla.dir, dir, { recursive: true });
  const fx = {
    dir,
    arnes: path.join(dir, 'arnes'),
    skills: path.join(dir, 'agent-skills'),
    primero: plantilla.primero,
    cfg: {
      lista: path.join(dir, 'cfg', 'allowlist.json'), reemplazos: path.join(dir, 'cfg', 'replacements.json'), denegados: path.join(dir, 'cfg', 'denylist.json'),
      // story 8.7 (AC 14): el nombre público va siempre por opción — el de verdad no viaja en la copia, donde esta suite corre
      publicRepos: path.join(dir, 'cfg', 'public-repos.json'),
    },
    salida: (nombre) => path.join(dir, 'out', nombre),
    config({ lista, reemplazos, denegados, publicRepos } = {}) {
      if (lista) fs.writeFileSync(fx.cfg.lista, JSON.stringify(lista, null, 2));
      if (reemplazos) fs.writeFileSync(fx.cfg.reemplazos, JSON.stringify(reemplazos, null, 2));
      if (denegados) fs.writeFileSync(fx.cfg.denegados, JSON.stringify(denegados, null, 2));
      if (publicRepos) fs.writeFileSync(fx.cfg.publicRepos, JSON.stringify(publicRepos, null, 2));
    },
  };
  fs.mkdirSync(path.join(dir, 'cfg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fx.config({ lista: LISTA_BASE, reemplazos: REEMPLAZOS_BASE, denegados: DENEGADOS_BASE, publicRepos: PUBLICO });
  return fx;
}

/** Corre el exportador con las configuraciones de la fixture; las opciones que pasa la prueba mandan (van después). */
function exportar(fx, args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [EXPORTAR,
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--public-repos', fx.cfg.publicRepos,
    '--harness', 'HEAD', '--agent-skills', 'HEAD', ...args], {
    cwd: fx.dir,
    encoding: 'utf8',
    env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', json };
}

const temporales = (fx) => fs.readdirSync(path.join(fx.dir, 'out')).filter((n) => n.includes('.exportando-'));
const estadoFuentes = (fx) => [fx.arnes, fx.skills].map((d) => gitFx(d, ['status', '--porcelain', '--untracked-files=all']));
const archivosDelCommit = (repo, ref = 'HEAD') => gitFx(repo, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean).sort();
const gitCopia = (repo, args) => gitFx(repo, args);

// ── T1 · AC 1, 22 ─────────────────────────────────────────────────────────────────────────────────────
test('Exportador_CopiaDesdeElSha_NoDelArbol', () => {
  const fx = fixture();
  escribir(fx.arnes, {
    'README.md': '# Arnés de mentira\n\nCambio sin commitear.\n',
    'scripts/sin-commit.js': "'use strict';\n",
  });
  // Sin servicios en el PATH: un `az` o un `curl` de mentira anotan cualquier llamada.
  const bin = path.join(fx.dir, 'bin');
  const log = path.join(fx.dir, 'servicios.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(log, '');
  for (const h of ['git', 'bash']) {
    const donde = spawnSync('/bin/sh', ['-c', `command -v ${h}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(donde, path.join(bin, h));
  }
  for (const s of ['az', 'curl']) {
    fs.writeFileSync(path.join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${log}"\nexit 1\n`);
    fs.chmodSync(path.join(bin, s), 0o755);
  }
  const antes = estadoFuentes(fx);
  const salida = fx.salida('t1');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--harness', fx.primero.arnes, '--agent-skills', fx.primero.skills, '--json'],
    { env: { PATH: bin } });
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.fuentes.arnes.sha, fx.primero.arnes);
  assert.strictEqual(r.json.fuentes['agent-skills'].sha, fx.primero.skills);
  assert.match(leer(salida, 'arnes/guides/guia.md'), /Primera versión/, 'el contenido es el del commit exportado');
  assert.ok(!existe(salida, 'arnes/scripts/segundo.js'), 'lo que sólo está en el segundo commit no sale');
  assert.ok(!existe(salida, 'agent-skills/skills/tycon-pipeline/segundo.md'));
  assert.ok(!existe(salida, 'arnes/scripts/sin-commit.js'), 'lo no commiteado no sale');
  assert.doesNotMatch(leer(salida, 'arnes/README.md'), /sin commitear/);
  assert.deepStrictEqual(estadoFuentes(fx), antes, 'los repos fuente quedan como estaban');
  assert.strictEqual(fs.readFileSync(log, 'utf8'), '', 'no llamó a ningún servicio');
});

// ── T2 · AC 1 ─────────────────────────────────────────────────────────────────────────────────────────
test('Exportador_EnlaceOSubmodulo_Exit2', () => {
  const fx = fixture();
  fs.symlinkSync('hola.js', path.join(fx.arnes, 'scripts', 'enlace.js'));
  commitear(fx.arnes, 'enlace');
  let salida = fx.salida('t2a');
  let r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /scripts\/enlace\.js/);
  assert.match(r.err, /hola\.js/, 'nombra el destino del enlace');
  assert.ok(!fs.existsSync(salida));

  gitFx(fx.arnes, ['rm', '-q', 'scripts/enlace.js']);
  gitFx(fx.arnes, ['update-index', '--add', '--cacheinfo', `160000,${fx.primero.skills},scripts/sub`]);
  commitear(fx.arnes, 'submódulo', { sinAgregar: true });
  salida = fx.salida('t2b');
  r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /scripts\/sub/);
  assert.match(r.err, new RegExp(fx.primero.skills), 'nombra el commit al que apunta el submódulo');
  assert.ok(!fs.existsSync(salida));

  // Un árbol armado a mano: una ruta que sale de la copia («..»), una que pisaría su .git, y dos carpetas que sólo
  // difieren en mayúsculas (en un disco que no las distingue se pisan y un archivo pierde su +x).
  gitFx(fx.arnes, ['update-index', '--force-remove', 'scripts/sub']);
  commitear(fx.arnes, 'sin submódulo', { sinAgregar: true });
  const base = gitFx(fx.arnes, ['rev-parse', 'HEAD']);
  const escapa = arbolCon(fx.arnes, [`040000 tree ${arbolCon(fx.arnes, [`040000 tree ${arbolCon(fx.arnes, [`100644 blob ${blob(fx.arnes, 'fuera\n')}\tescapado.txt`])}\t..`])}\t..`]);
  const casos = [
    ['una ruta que se escapa de la copia', `040000 tree ${escapa}\tafuera`, /ruta insegura.*\.\./],
    ['una ruta que pisaría el .git de la copia', `040000 tree ${arbolCon(fx.arnes, [`100644 blob ${blob(fx.arnes, '[core]\n')}\tconfig`])}\t.git`, /ruta insegura.*\.git/],
    ['dos carpetas que sólo difieren en mayúsculas', null, /sólo difieren en mayúsculas/],
    ['dos nombres que sólo difieren en la forma de sus acentos', 'nfc', /forma de sus acentos/],
  ];
  casos.forEach(([nombre, linea, motivo], i) => {
    gitFx(fx.arnes, ['update-ref', 'refs/heads/main', base]);
    if (linea === 'nfc') {
      agregarEntradaCruda(fx.arnes, 'scripts', `100644 blob ${blob(fx.arnes, 'a\n')}\t${'café.md'.normalize('NFC')}`, 'NFC');
      agregarEntradaCruda(fx.arnes, 'scripts', `100644 blob ${blob(fx.arnes, 'b\n')}\t${'café.md'.normalize('NFD')}`, 'NFD');
    } else if (linea) agregarEntradaCruda(fx.arnes, 'scripts', linea, nombre);
    else {
      agregarEntradaCruda(fx.arnes, 'scripts', `040000 tree ${arbolCon(fx.arnes, [`100644 blob ${blob(fx.arnes, '# a\n')}\ta.md`])}\tDocs`, 'Docs');
      agregarEntradaCruda(fx.arnes, 'scripts', `040000 tree ${arbolCon(fx.arnes, [`100755 blob ${blob(fx.arnes, 'echo b\n')}\tb.sh`])}\tdocs`, 'docs');
    }
    const s = fx.salida(`t2-crudo-${i}`);
    const rr = exportar(fx, ['--package', 'core', '--output', s]);
    assert.strictEqual(rr.code, 2, `${nombre}: exit 2\n${rr.err}\n${rr.out}`);
    assert.match(rr.err, motivo, nombre);
    assert.ok(!fs.existsSync(s), `${nombre}: sin salida`);
  });
  assert.ok(!fs.existsSync(path.join(fx.dir, 'escapado.txt')) && !fs.existsSync(path.join(fx.dir, 'out', 'escapado.txt')), 'nada se escribió fuera de la copia');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T3 · AC 2, 3 ──────────────────────────────────────────────────────────────────────────────────────
test('Exportador_ListaBlanca_ExactoYExclusionesFijas', () => {
  const fx = fixture();
  const conArnes = (entra) => {
    const lista = clonar(LISTA_BASE);
    lista.packages.core.arnes.in = entra;
    return lista;
  };
  // Un `**` que cubre .engram/, tasks/ y scripts/ci/pipeline-debt.json no es error: se filtran y se cuentan.
  fx.config({ lista: conArnes(['**']) });
  let salida = fx.salida('t3a');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  // el termómetro de la copia se carga a mitad de la exportación y le pide funciones al exportador: con el arranque
  // antes de los exports salía «exporter.coincide is not a function» (story 8.9, tanda B3b)
  assert.ok(r.json.spanishNames && !r.json.spanishNames.error && typeof r.json.spanishNames.total === 'number',
    `el termómetro de la copia cuenta: ${JSON.stringify(r.json.spanishNames)}`);
  const quitar = new Set([...muestras('arnes'), 'guides/bizuit/bizuit-plugin.md']);
  for (const a of DE_PAQUETE) {
    for (const s of [`adapters/codex/agents/${a}.toml`, `adapters/codex/agents-native/${a}.toml`, `scripts/controls-bench/cases/advisors/${a}.json`]) quitar.add(s);
  }
  const esperados = archivosDelCommit(fx.arnes).filter((p) => !quitar.has(p));
  assert.deepStrictEqual(listar(path.join(salida, 'arnes')), esperados, 'exactamente lo que cubre «in», sin afuera ni fijas');
  for (const p of ['.engram/muestra.txt', 'tasks/muestra.txt', 'scripts/ci/pipeline-debt.json']) assert.ok(!existe(salida, `arnes/${p}`), p);
  assert.strictEqual(r.json.excluidosFijos.arnes, muestras('arnes').length, 'cada archivo filtrado por una fija se cuenta');

  // Una entrada de «in» que nombra una exclusión fija literalmente es un error de la lista.
  fx.config({ lista: conArnes(['README.md', '.gitignore', 'scripts/**', 'guides/**', 'build/**', 'adapters/**', 'commands/**', 'perfil-equipo.json']) });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t3b')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /perfil-equipo\.json/);

  // Una exclusión fija bajo `scripts/**` que no coincide con ningún archivo: ¿se renombró?
  fx.config({ lista: LISTA_BASE });
  escribir(fx.arnes, { 'scripts/metrics/corridas-buzon.json': null });
  commitear(fx.arnes, 'renombre');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t3c')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /exclusión fija sin archivo: .*scripts\/metrics\/corridas-buzon\.json — ¿se renombró\?/);
  // Qué fija «cae bajo» un glob de entra lo decide la intersección de los dos globs (no una muestra).
  const { intersectan } = require(EXPORTAR);
  assert.ok(intersectan('scripts/**', 'scripts/metrics/corridas-buzon.json'));
  assert.ok(intersectan('scripts/**', '**/denylist*.json'), 'una clase puede caer bajo cualquier carpeta');
  assert.ok(!intersectan('skills/tycon-*/**', 'skills/projects/**'));
  assert.ok(!intersectan('guides/ab.md', 'guides/ab.md.bak'), 'un nombre que es sólo el comienzo de otro no es la misma ruta');

  // Una carpeta nueva en la raíz que nada clasifica no queda ni afuera ni adentro en silencio.
  escribir(fx.arnes, { 'scripts/metrics/corridas-buzon.json': 'muestra\n', 'nueva/x.txt': 'algo\n' });
  commitear(fx.arnes, 'carpeta nueva');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t3d'), '--json']);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /sin clasificar: arnes\/nueva/);
  assert.deepStrictEqual(r.json.entradasSinClasificar, ['arnes/nueva']);
  // Un «out» que no toma los archivos de la carpeta no la clasifica (`**/?` sólo nombra archivos de un carácter).
  const flojo = clonar(LISTA_BASE);
  flojo.packages.core.arnes.out.push({ glob: '**/?', reason: 'no cubre nada entero (prueba)' });
  fx.config({ lista: flojo });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t3d2')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /sin clasificar: arnes\/nueva/);
  fx.config({ lista: LISTA_BASE });

  // --explain imprime la tabla del primer nivel con su motivo (texto y JSON) y no escribe nada.
  const explicar = (json) => spawnSync(process.execPath, [EXPORTAR, '--explain', ...(json ? ['--json'] : []),
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
  const ej = explicar(true);
  assert.strictEqual(ej.status, 0, ej.stderr);
  const tabla = JSON.parse(ej.stdout);
  assert.deepStrictEqual(tabla.sinClasificar, ['arnes/nueva']);
  const readme = tabla.primerNivel.find((x) => x.fuente === 'arnes' && x.entrada === 'README.md');
  assert.deepStrictEqual(readme.reglas.map((x) => [x.tipo, x.detalle]), [['entra', 'core']]);
  const engram = tabla.primerNivel.find((x) => x.fuente === 'arnes' && x.entrada === '.engram');
  assert.strictEqual(engram.reglas[0].tipo, 'fija', 'la clasifica su exclusión fija, con su motivo');
  assert.ok(engram.reglas[0].detalle.length > 10);
  assert.deepStrictEqual(tabla.transformaciones.map((t) => t.nombre), require(EXPORTAR).TRANSFORMACIONES.map((t) => t.nombre));
  assert.strictEqual(tabla.exclusionesFijas.length, require(EXPORTAR).EXCLUIDOS_SIEMPRE.length);
  const et = explicar(false);
  assert.strictEqual(et.status, 0, et.stderr);
  assert.match(et.stdout, /nueva\/\s+🛑 SIN CLASIFICAR/);
  assert.match(et.stdout, /README\.md\s+entra: core/);
  for (const t of require(EXPORTAR).TRANSFORMACIONES) assert.ok(et.stdout.includes(t.nombre), `--explain lista ${t.nombre}`);

  // Un `**` pegado a un nombre (el detector y la intersección lo leerían distinto) y un afuera cuyo archivo se
  // renombró (el archivo nuevo saldría en silencio) son errores de la lista.
  escribir(fx.arnes, { 'nueva/x.txt': null });
  commitear(fx.arnes, 'sin la carpeta nueva');
  const pegado = clonar(LISTA_BASE);
  pegado.packages.core.arnes.in.push('scripts/**.json');
  fx.config({ lista: pegado });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t3e')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /`\*\*` va solo en su segmento/);
  const renombrado = clonar(LISTA_BASE);
  renombrado.packages.core.arnes.out.push({ glob: 'guides/inventario-viejo.md', reason: 'inventario de un cliente' });
  fx.config({ lista: renombrado });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t3f')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /afuera sin archivo: arnes\/guides\/inventario-viejo\.md — ¿se renombró\?/);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T4 · AC 3, 4 ──────────────────────────────────────────────────────────────────────────────────────
test('Exportador_LoPrivadoNoSale', () => {
  const fx = fixture();
  // story 8.9, tanda C4: lo privado con el nombre que tuvo antes de la mudanza (una foto vieja, la base de un freno)
  // tampoco sale. Los nombres viejos salen del mapa, nunca escritos acá; sin mapa, no hay viejos que probar.
  const ln = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
  const viejos = ln.usableEntries(ln.loadMap())
    .filter((e) => e.kind === 'file' && ['scripts/publishing/denylist.json', 'scripts/publishing/replacements.json'].includes(e.new))
    .map((e) => e.old);
  if (ln.loadMap()) assert.strictEqual(viejos.length, 2, 'con mapa, la lista de denegación y la tabla tienen su nombre viejo');
  const privados =['denylist', 'replacements', ...viejos.map((v) => path.posix.basename(v, '.json'))];
  escribir(fx.arnes, {
    'scripts/publishing/denylist.json': '{ "terminos": [] }\n',
    'guides/extra/replacements-x.json': '{ "pares": [] }\n',
    'scripts/publishing/allowlist.json': '{ "__doc": "pública" }\n',
    'guides/cliente-notas.md': '# Notas de un cliente\n',
    ...Object.fromEntries(viejos.map((v) => [v, '{ "terminos": [] }\n'])),
  });
  commitear(fx.arnes, 'lo privado');
  fx.config({ reemplazos: { ...REEMPLAZOS_BASE, afuera: [{ glob: 'arnes/guides/cliente-*.md', motivo: 'notas de un cliente' }] } });
  const salida = fx.salida('t4');
  const r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const todo = listar(salida);
  assert.deepStrictEqual(todo.filter((p) => privados.some((n) => path.posix.basename(p).startsWith(n) && p.endsWith('.json'))), [],
    'nada de lo privado de la publicación, ni con su nombre de antes');
  assert.ok(!existe(salida, 'arnes/guides/cliente-notas.md'), 'el afuera privado lo aplica el exportador');
  assert.ok(existe(salida, 'arnes/scripts/publishing/allowlist.json'), 'la lista blanca no es privada');
});

// ── T5 · AC 5, 6 ──────────────────────────────────────────────────────────────────────────────────────
test('Exportador_Paquetes_RevisoresEnterosONada', () => {
  const fx = fixture();
  const n = fx.salida('t5n');
  let r = exportar(fx, ['--package', 'core', '--output', n, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  for (const a of DE_PAQUETE) {
    for (const s of [`agent-skills/agents/${a}.md`, `arnes/adapters/codex/agents/${a}.toml`,
      `arnes/adapters/codex/agents-native/${a}.toml`, `arnes/scripts/controls-bench/cases/advisors/${a}.json`]) {
      assert.ok(!existe(n, s), `superficie de un revisor de paquete en el núcleo: ${s}`);
    }
  }
  assert.ok(existe(n, 'agent-skills/agents/revisor-nucleo.md'));
  assert.ok(existe(n, 'arnes/adapters/codex/agents/revisor-nucleo.toml'));
  assert.strictEqual(leer(n, 'arnes/adapters/codex/agents/MANIFEST.json'), `${JSON.stringify({ advisors: ['revisor-nucleo'] }, null, 2)}\n`);
  assert.strictEqual(leer(n, 'arnes/scripts/controls-bench/baseline/claude-advisors.json'), LINEA_BASE_NUCLEO, 'línea base filtrada, en orden y con su formato');
  assert.strictEqual(leer(n, 'arnes/guides/advisor-rules-catalog.md'), CATALOGO_NUCLEO, 'catálogo sin las secciones de paquete');
  assert.ok(!listar(n).some((p) => p.includes('packs/')), 'ningún manifiesto de paquete en el núcleo');

  const b = fx.salida('t5b');
  r = exportar(fx, ['--package', 'bizuit', '--output', b, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(existe(b, 'agent-skills/agents/tycon-plugin-dotnet-conventions.md'));
  assert.ok(existe(b, 'agent-skills/packs/bizuit/pack.json'));
  assert.ok(existe(b, 'arnes/guides/bizuit/bizuit-plugin.md'));
  assert.ok(!existe(b, 'agent-skills/skills/bizuit-sdd/tests/fixtures/bpmn/proceso.bpmn'));
  assert.ok(!listar(b).some((p) => p.includes('revisor-cliente') || p.includes('packs/clients')), 'nada del paquete de clientes');
  const pend = r.json.pendientes.map((p) => `${p.ruta} → ${p.hasta}`);
  for (const s of ['arnes/adapters/codex/agents/tycon-plugin-dotnet-conventions.toml',
    'arnes/adapters/codex/agents-native/tycon-plugin-dotnet-conventions.toml',
    'arnes/scripts/controls-bench/cases/advisors/tycon-plugin-dotnet-conventions.json',
    'arnes/adapters/codex/agents/MANIFEST.json#tycon-plugin-dotnet-conventions',
    'arnes/scripts/controls-bench/baseline/claude-advisors.json#tycon-plugin-dotnet-conventions::*',
    'arnes/guides/advisor-rules-catalog.md#tycon-plugin-dotnet-conventions']) {
    // story 8.7 (AC 8): ya no esperan a una story; salen enteros en la unión con el núcleo
    assert.ok(pend.includes(`${s} → core,bizuit`), `pendiente hasta la unión core,bizuit: ${s}\n${pend.join('\n')}`);
  }
  assert.ok(pend.includes('agent-skills/skills/bizuit-sdd/tests/fixtures/bpmn/** → 8.6'), pend.join('\n'));
  assert.ok(!pend.some((p) => p.includes('revisor-cliente')), 'lo de clientes no es un pendiente: no sale nunca');
});

// ── T6 · AC 7, 8 ──────────────────────────────────────────────────────────────────────────────────────
test('Exportador_Reemplazos_TextoPorContenidoYFormas', () => {
  const fx = fixture();
  const binario = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x41, 0x63, 0x6d, 0x65]);
  escribir(fx.arnes, {
    'scripts/clave.js': "'use strict';\nconst mapa = { AcmeCorp: 1 };\nconst ACME_PATTERN = /x/;\nmodule.exports = { mapa, ACME_PATTERN };\n",
    'scripts/entorno.sh': '#!/bin/bash\nexport ACME_HOME=/opt/acmecorp\necho "$ACME_HOME"\n',
    'scripts/config.toml': 'nombre = "AcmeCorp"\n',
    'scripts/sin-extension': '#!/usr/bin/env bash\necho acmecorp\n',
    'guides/prosa.md': 'El cliente AcmeCorp usa ACME.\n',
    'guides/img.bin': binario,
    'scripts/otro.sh': '#!/bin/bash\necho GLOBEX globex Globex GloBex\n',
  });
  commitear(fx.arnes, 'formas');
  const reemplazos = clonar(REEMPLAZOS_BASE);
  // Sin `mayusculas: true` (como en denylist.json) el real no distingue caja: lo no declarado toma su caja.
  reemplazos.pares.push({ real: 'Globex', categoria: 'cliente', formas: [{ texto: 'Globex', anonimo: 'ClienteB' }], palabra: true });
  // Un par que ningún archivo usa: también va por su número.
  reemplazos.pares.push({ real: 'Initech', categoria: 'cliente', formas: [{ texto: 'Initech', anonimo: 'ClienteC' }], palabra: true });
  fx.config({ reemplazos });
  let salida = fx.salida('t6a');
  let r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 1, `un binario sin permiso no se da por limpio\n${r.err}\n${r.out}`);
  assert.match(r.out, /guides\/img\.bin.*sin-leer|sin-leer.*guides\/img\.bin/);
  assert.ok(!fs.existsSync(salida));

  fx.config({ denegados: { ...DENEGADOS_BASE, binariosPermitidos: ['**/*.bin'] } });
  salida = fx.salida('t6b');
  r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(salida, 'arnes/scripts/otro.sh'), '#!/bin/bash\necho CLIENTEB clienteb ClienteB ClienteB\n');
  assert.ok(!/AcmeCorp|Globex|Initech/i.test(r.out), 'el --json nombra a los pares por su número, nunca por el real');
  assert.ok(r.json.reemplazos['par-1'] > 0 && r.json.reemplazos['par-2'] === 4, JSON.stringify(r.json.reemplazos));
  assert.deepStrictEqual(r.json.paresSinUso, ['par-3'], 'el par sin uso, por su número');
  assert.match(fs.readFileSync(`${salida}.reemplazos.md`, 'utf8'), /## Pares sin uso \(informativo\)\n\n- Initech\n/, 'el real, sólo en el listado privado');
  assert.strictEqual(leer(salida, 'arnes/scripts/clave.js'),
    "'use strict';\nconst mapa = { ClienteA: 1 };\nconst CLIENTEA_PATTERN = /x/;\nmodule.exports = { mapa, CLIENTEA_PATTERN };\n");
  assert.strictEqual(leer(salida, 'arnes/scripts/entorno.sh'), '#!/bin/bash\nexport CLIENTEA_HOME=/opt/clientea\necho "$CLIENTEA_HOME"\n');
  assert.strictEqual(leer(salida, 'arnes/scripts/config.toml'), 'nombre = "ClienteA"\n', 'un .toml escrito a mano se reemplaza');
  assert.strictEqual(leer(salida, 'arnes/scripts/sin-extension'), '#!/usr/bin/env bash\necho clientea\n', 'texto por contenido, no por extensión');
  assert.strictEqual(leer(salida, 'arnes/guides/prosa.md'), 'El cliente Cliente A usa CLIENTEA.\n', 'la prosa, sólo en .md');
  assert.ok(fs.readFileSync(path.join(salida, 'arnes/guides/img.bin')).equals(binario), 'el binario sale intacto');
  for (const js of listar(salida).filter((p) => p.endsWith('.js'))) {
    assert.strictEqual(spawnSync(process.execPath, ['--check', path.join(salida, js)]).status, 0, `${js} compila`);
  }
});

// ── T7 · AC 9 ─────────────────────────────────────────────────────────────────────────────────────────
test('Exportador_TablaInvalida_Exit2', () => {
  const fx = fixture();
  const par = (real, anonimo, extra = {}) => ({ real, categoria: 'cliente', formas: [{ texto: real, anonimo }], palabra: true, ...extra });
  const casos = [
    ['dos reales con el mismo anónimo', [par('AcmeCorp', 'ClienteA'), par('Globex', 'ClienteA')], /AcmeCorp[\s\S]*Globex|Globex[\s\S]*AcmeCorp/],
    ['una marca como real', [par('Bizuit', 'ProductoA')], /Bizuit/],
    ['una marca como forma', [{ ...par('AcmeCorp', 'ClienteA'), formas: [{ texto: 'TYCON', anonimo: 'MarcaA' }] }], /TYCON/],
    ['un anónimo con espacio fuera de .md', [par('AcmeCorp', 'Cliente A')], /AcmeCorp/],
    ['una categoría inventada', [par('AcmeCorp', 'ClienteA', { categoria: 'proveedor' })], /proveedor/],
    ['una forma sin anónimo', [{ real: 'AcmeCorp', categoria: 'cliente', formas: [{ texto: 'AcmeCorp' }] }], /AcmeCorp/],
    // El refinamiento del 2026-09-28 no abre la puerta: un anónimo que AGREGA un signo que su forma no tiene sigue afuera.
    ['un anónimo que agrega una comilla que su forma no tiene',
      [{ real: 'AcmeCorp', categoria: 'cliente', formas: [{ texto: "org: 'acmecorp'", anonimo: 'org: "org-y"' }], palabra: true }], /AcmeCorp/],
  ];
  casos.forEach(([nombre, pares, nombra], i) => {
    fx.config({ reemplazos: { pares, afuera: [] } });
    const salida = fx.salida(`t7-${i}`);
    const r = exportar(fx, ['--package', 'core', '--output', salida]);
    assert.strictEqual(r.code, 2, `${nombre}: exit 2 (salió ${r.code})\n${r.err}`);
    assert.match(r.err, nombra, nombre);
    assert.ok(!fs.existsSync(salida) && !fs.existsSync(`${salida}.reemplazos.md`), `${nombre}: no escribe nada`);
  });
  // …y uno que CONSERVA la puntuación de su forma pasa y se aplica (AC 9, 2026-09-28): así se anonimiza `org: '<org>'`
  // en código, que el AC 8 pide y que con la regla vieja era imposible.
  const conPuntuacion = clonar(REEMPLAZOS_BASE);
  conPuntuacion.pares[0].formas.unshift({ texto: "org: 'acmecorp'", anonimo: "org: 'org-y'" });
  escribir(fx.arnes, { 'scripts/org.js': "'use strict';\nmodule.exports = { org: 'acmecorp' };\n" });
  commitear(fx.arnes, 'org entre comillas');
  fx.config({ reemplazos: conPuntuacion });
  const conSignos = fx.salida('t7-puntuacion');
  const rp = exportar(fx, ['--package', 'core', '--output', conSignos]);
  assert.strictEqual(rp.code, 0, `la forma con la misma puntuación pasa\n${rp.err}\n${rp.out}`);
  assert.strictEqual(leer(conSignos, 'arnes/scripts/org.js'), "'use strict';\nmodule.exports = { org: 'org-y' };\n");
  fs.writeFileSync(fx.cfg.reemplazos, '{ "pares": [');
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('t7-json')]);
  assert.strictEqual(r.code, 2, 'JSON inválido');
  assert.match(r.err, /reemplazos/);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T8 · AC 10 ────────────────────────────────────────────────────────────────────────────────────────
test('Exportador_NombrePegadoOCodigoRoto_Exit1', () => {
  const fx = fixture();
  escribir(fx.arnes, { 'scripts/pegado.js': "'use strict';\nconst AcmeCorpProject = 1;\nmodule.exports = AcmeCorpProject;\n" });
  commitear(fx.arnes, 'pegado');
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('t8a')]);
  assert.strictEqual(r.code, 1, `el borde de palabra deja pasar el nombre pegado: lo tiene que ver el exportador\n${r.err}\n${r.out}`);
  assert.match(r.out, /scripts\/pegado\.js:2/);

  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares[0].formas.unshift({ texto: 'AcmeCorpProject', anonimo: 'ClienteAProject' });
  fx.config({ reemplazos });
  const b = fx.salida('t8b');
  r = exportar(fx, ['--package', 'core', '--output', b]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.match(leer(b, 'arnes/scripts/pegado.js'), /const ClienteAProject = 1;/);

  // Un anónimo válido (`a.b`) que rompe `const Foo = 1`, y un comando que manda correr algo que no viaja.
  reemplazos.pares.push({ real: 'Foo', categoria: 'interno', formas: [{ texto: 'Foo', anonimo: 'a.b' }], palabra: true });
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: 'scripts/x/**', reason: 'no viaja (prueba)' });
  fx.config({ reemplazos, lista });
  escribir(fx.arnes, {
    'scripts/foo.js': "'use strict';\nconst Foo = 1;\nmodule.exports = Foo;\n",
    'scripts/x/y.js': "'use strict';\n",
    'commands/hacer.md': '# Hacer\n\nCorré `node scripts/x/y.js` para empezar.\n\nY `node <repo>/scripts/foo.js` · `node <repo>/scripts/x/y.js`.\n',
  });
  // Lo que sí viaja no es un comando colgado: un script del arnés citado desde una skill, uno de la propia skill
  // dicho desde su scripts/, y un marcador que no se puede resolver.
  escribir(fx.skills, {
    'skills/tycon-pipeline/SKILL.md': '---\nname: tycon-pipeline\n---\n\n`node scripts/hola.js` · `node paso.js` · `node .../scripts/marker.js` · `node <skill>/scripts/paso.js`\n',
    'skills/tycon-pipeline/steps/uno.md': '# Paso\n\nCorré `node <skill>/scripts/privado.js`.\n',
    'skills/tycon-pipeline/scripts/privado.js': "'use strict';\n",
    'skills/tycon-pipeline/steps/dos.md': '# Paso dos\n\n`node <arnés>/scripts/foo.js` · `node <arnes>/scripts/x/y.js`\n\n`node <repo>/scripts/nada.js`\n',
  });
  escribir(fx.arnes, { 'scripts/extglob.sh': '#!/bin/bash\nshopt -s extglob\ncase "a.txt" in\n  +([a-z]).txt) echo ok ;;\nesac\n' });
  lista.packages.core['agent-skills'].out.push({ glob: 'skills/tycon-pipeline/scripts/privado.js', reason: 'no viaja (prueba)' });
  fx.config({ reemplazos, lista });
  commitear(fx.arnes, 'roto y colgado');
  commitear(fx.skills, 'comandos que viajan');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t8c')]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.match(r.out, /scripts\/foo\.js/, 'el .js que dejó de compilar');
  assert.match(r.out, /commands\/hacer\.md:3.*scripts\/x\/y\.js/, 'el comando colgado, con archivo, línea y ruta');
  assert.doesNotMatch(r.out, /SKILL\.md/, 'los comandos que resuelven a un archivo de la copia no son hallazgos');
  assert.match(r.out, /steps\/uno\.md:3.*<skill>\/scripts\/privado\.js/, 'el marcador <skill> se resuelve a la skill del paso');
  // <arnés> (o <arnes>) es el arnés desde cualquier .md; <repo>, sólo desde un comando del arnés: en una skill no se juzga.
  assert.match(r.out, /steps\/dos\.md:3.*<arnes>\/scripts\/x\/y\.js/, 'el marcador <arnes> que apunta a algo que no viaja');
  assert.doesNotMatch(r.out, /<arnés>\/scripts\/foo\.js/, 'el marcador <arnés> que resuelve a la copia no es hallazgo');
  assert.match(r.out, /commands\/hacer\.md:5.*<repo>\/scripts\/x\/y\.js/, 'el marcador <repo> en un comando del arnés');
  assert.doesNotMatch(r.out, /<repo>\/scripts\/foo\.js/, 'el marcador <repo> que resuelve a la copia no es hallazgo');
  assert.doesNotMatch(r.out, /<repo>\/scripts\/nada\.js/, 'el marcador <repo> en una skill no se puede resolver: no se juzga');
  assert.doesNotMatch(r.out, /extglob\.sh/, 'un script que prende extglob compila');

  // Un nombre pegado en una RUTA pasa el borde de palabra igual que en el texto.
  escribir(fx.arnes, { 'scripts/foo.js': null, 'commands/hacer.md': null, 'scripts/AcmeCorpProject/notas.txt': 'nada\n' });
  commitear(fx.arnes, 'nombre pegado en una ruta');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t8d')]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.match(r.out, /\(ruta\) arnes\/scripts\/AcmeCorpProject/);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T9 · AC 11 ────────────────────────────────────────────────────────────────────────────────────────
test('Exportador_AdaptadoresCodex_Regenerados', () => {
  const fx = fixture();
  escribir(fx.skills, { 'agents/revisor-nucleo.md': agente('revisor-nucleo', 'Revisa el núcleo de AcmeCorp.') });
  commitear(fx.skills, 'el agente nombra al cliente');
  regenerarCodex(fx.arnes, fx.skills);
  commitear(fx.arnes, 'traducciones al día');
  assert.match(fs.readFileSync(path.join(fx.arnes, 'adapters/codex/agents/revisor-nucleo.toml'), 'utf8'), /AcmeCorp/,
    'control: en el interno la traducción nombra al cliente');
  const salida = fx.salida('t9');
  const r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const md = fs.readFileSync(path.join(salida, 'agent-skills/agents/revisor-nucleo.md'));
  const huella = crypto.createHash('sha256').update(md.toString('utf8')).digest('hex');
  for (const t of ['arnes/adapters/codex/agents/revisor-nucleo.toml', 'arnes/adapters/codex/agents-native/revisor-nucleo.toml']) {
    const toml = leer(salida, t);
    assert.doesNotMatch(toml, /acmecorp/i, `${t} no nombra al cliente`);
    assert.match(toml, new RegExp(`^# source_sha256: ${huella}$`, 'm'), `${t}: su huella es la del .md reemplazado`);
  }
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-check-'));
  const chk = spawnSync(process.execPath, [path.join(salida, 'arnes', 'build', 'generate.js'), '--check'], {
    encoding: 'utf8',
    env: { ...sinGit(process.env), TYCON_AGENTS_DIR: path.join(salida, 'agent-skills', 'agents'), HOME: aux, CODEX_HOME: path.join(aux, 'codex') },
  });
  fs.rmSync(aux, { recursive: true, force: true });
  assert.strictEqual(chk.status, 0, `generate.js --check en la copia: ${chk.stderr}`);

  // Si la lista deja afuera el .md de un revisor, su entrada del manifiesto y sus traducciones se van con él (antes,
  // generate.js no encontraba el canónico y la corrida salía 2).
  const sinRevisor = clonar(LISTA_BASE);
  sinRevisor.packages.core['agent-skills'].out.push({ glob: 'agents/revisor-nucleo.md', reason: 'no sale (prueba)' });
  fx.config({ lista: sinRevisor });
  const s2 = fx.salida('t9b');
  let r2 = exportar(fx, ['--package', 'core', '--output', s2]);
  assert.strictEqual(r2.code, 0, `${r2.err}\n${r2.out}`);
  assert.strictEqual(leer(s2, 'arnes/adapters/codex/agents/MANIFEST.json'), `${JSON.stringify({ advisors: [] }, null, 2)}\n`);
  assert.ok(!listar(path.join(s2, 'arnes')).some((p) => p.endsWith('.toml')), 'ninguna traducción sin su revisor');
  // Y si la lista deja afuera sólo la traducción de un revisor que sale, generate.js la volvería a crear: es un 2.
  const sinToml = clonar(LISTA_BASE);
  sinToml.packages.core.arnes.out.push({ glob: 'adapters/codex/agents-native/revisor-nucleo.toml', reason: 'no sale (prueba)' });
  fx.config({ lista: sinToml });
  const s3 = fx.salida('t9c');
  r2 = exportar(fx, ['--package', 'core', '--output', s3]);
  assert.strictEqual(r2.code, 2, `${r2.err}\n${r2.out}`);
  assert.match(r2.err, /generate\.js dejó .*agents-native\/revisor-nucleo\.toml/);
  assert.ok(!fs.existsSync(s3));
});

// ── T10 · AC 12 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_Informe_PrivadoDeterministaHermano', () => {
  const fx = fixture();
  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares.push({ real: 'Globex', categoria: 'cliente', formas: [{ texto: 'Globex', anonimo: 'ClienteB' }], palabra: true });
  fx.config({ reemplazos });
  escribir(fx.arnes, { 'guides/ambos.md': 'Globex y AcmeCorp.\n' });
  commitear(fx.arnes, 'dos pares en un archivo');
  const a = fx.salida('a');
  const b = fx.salida('b');
  for (const s of [a, b]) assert.strictEqual(exportar(fx, ['--package', 'core', '--output', s]).code, 0);
  for (const s of [a, b]) {
    const txt = fs.readFileSync(`${s}.reemplazos.md`, 'utf8');
    assert.match(txt.split('\n')[0], /PRIVADO: contiene los nombres reales, no se publica/);
    assert.match(txt, /paquete: core/);
    assert.ok(!listar(s).some((p) => p.endsWith('.reemplazos.md')), 'el listado nunca queda adentro de la copia');
    const rutas = [...txt.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(rutas, [...rutas].sort(), 'por archivo, ordenado por ruta');
    assert.match(txt, /### arnes\/guides\/ambos\.md\n- AcmeCorp: 1\n- Globex: 1\n/, 'y por par, en el orden de la tabla');
  }
  assert.strictEqual(fs.readFileSync(`${a}.reemplazos.md`, 'utf8'), fs.readFileSync(`${b}.reemplazos.md`, 'utf8'),
    'dos salidas, el mismo listado: no depende de dónde se escribe');

  // Una corrida que sale 2 borra un listado viejo en su ruta (y nunca un archivo que no es un listado).
  const c = fx.salida('c');
  fs.copyFileSync(`${a}.reemplazos.md`, `${c}.reemplazos.md`);
  let r = exportar(fx, ['--package', 'core', '--output', c, '--harness', '0000000']);
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(!fs.existsSync(`${c}.reemplazos.md`), 'el listado viejo se borra');
  const d = fx.salida('d');
  fs.writeFileSync(`${d}.reemplazos.md`, 'notas mías\n');
  r = exportar(fx, ['--package', 'core', '--output', d, '--harness', '0000000']);
  assert.strictEqual(r.code, 2, r.err);
  assert.strictEqual(fs.readFileSync(`${d}.reemplazos.md`, 'utf8'), 'notas mías\n', 'un archivo ajeno no se borra');

  // Con una corrida que saldría 0: un --report que apunta a un archivo ajeno o a una carpeta es un 2, y nada se pisa.
  const ajeno = path.join(fx.dir, 'out', 'ajeno.md');
  fs.writeFileSync(ajeno, 'notas mías\n');
  for (const [nombre, informe] of [['un archivo ajeno', ajeno], ['una carpeta', path.join(fx.dir, 'out')]]) {
    const s = fx.salida(`t10-${nombre.length}`);
    r = exportar(fx, ['--package', 'core', '--output', s, '--report', informe]);
    assert.strictEqual(r.code, 2, `${nombre}: ${r.err}`);
    assert.ok(!fs.existsSync(s), `${nombre}: sin salida`);
  }
  assert.strictEqual(fs.readFileSync(ajeno, 'utf8'), 'notas mías\n');
  // Si el listado no se puede escribir, no hay copia: el renombre es el único punto sin retorno.
  const cerrada = path.join(fx.dir, 'out', 'cerrada');
  fs.mkdirSync(cerrada);
  fs.chmodSync(cerrada, 0o555);
  const e = fx.salida('t10-cerrada');
  r = exportar(fx, ['--package', 'core', '--output', e, '--report', path.join(cerrada, 'listado.md'), '--json']);
  fs.chmodSync(cerrada, 0o755);
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(!fs.existsSync(e), 'un 2 nunca convive con una copia ya armada');
  assert.strictEqual(r.json.salida, null);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T11 · AC 13 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_DetectorPorFuente_ExcluidosCero', () => {
  const fx = fixture();
  escribir(fx.arnes, { 'scripts/datos/ejemplo.txt': 'contacto: juana@empresa.com.ar\n' });
  commitear(fx.arnes, 'un dato');
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('t11a')]);
  assert.strictEqual(r.code, 1, `control: sin excepción el dato dispara\n${r.out}`);

  fx.config({ denegados: { ...DENEGADOS_BASE, permitidos: [{ archivo: 'scripts/datos/**', patron: 'juana@empresa\\.com\\.ar', motivo: 'dato sintético de prueba' }] } });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t11b'), '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.detector.arnes.permitidos, 1, 'el permitido escrito relativo a la raíz de la fuente vale en la copia');
  assert.strictEqual(r.json.detector.arnes.excluidos, 0);

  fx.config({ denegados: { ...DENEGADOS_BASE, excluir: ['scripts/datos/**'] } });
  const salida = fx.salida('t11c');
  r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 2, `un archivo que sale y el detector no mira no es un archivo limpio\n${r.err}\n${r.out}`);
  assert.match(r.err, /scripts\/datos\/ejemplo\.txt/);
  assert.ok(!fs.existsSync(salida));
});

// ── T12 · AC 14 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_RutasYMetadatos_PasanElDetector', () => {
  const fx = fixture();
  escribir(fx.arnes, { 'guides/acmecorp-notas.md': '# Notas\n\nNada que ver.\n' });
  commitear(fx.arnes, 'ruta con nombre');
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('t12a')]);
  assert.strictEqual(r.code, 1, `la RUTA nombra al cliente aunque el contenido esté limpio\n${r.err}\n${r.out}`);
  assert.match(r.out, /acmecorp-notas\.md/);

  escribir(fx.arnes, { 'guides/acmecorp-notas.md': null });
  commitear(fx.arnes, 'sin la ruta');
  const salida = fx.salida('t12b');
  r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  for (const f of ['arnes', 'agent-skills']) {
    assert.deepStrictEqual(r.json.detector.metadatos[f].hallazgos, [], `metadatos del commit de ${f}`);
    const meta = path.join(fx.dir, `meta-${f}.txt`);
    fs.writeFileSync(meta, gitCopia(path.join(salida, f), ['cat-file', '-p', 'HEAD']));
    const d = spawnSync(process.execPath, [DETECTOR, '--config', fx.cfg.denegados, meta], { encoding: 'utf8' });
    assert.strictEqual(d.status, 0, `el detector real sobre el cat-file del commit de ${f}: ${d.stdout}${d.stderr}`);
  }
  fx.config({ denegados: { ...DENEGADOS_BASE, excluir: ['*.txt'] } });
  const x = fx.salida('t12c');
  r = exportar(fx, ['--package', 'core', '--output', x]);
  assert.strictEqual(r.code, 2, `si «excluir» tapa la lista de rutas, no se miró: ${r.err}`);
  assert.match(r.err, /no miró la lista de rutas/);
  assert.ok(!fs.existsSync(x));
});

// ── T14 · AC 16 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_ConHallazgos_NoDejaSalida', () => {
  const fx = fixture();
  // Un nombre que la tabla no tapa: un patrón de la lista (un término sin par es un 2 desde la 8.10, AC 41).
  fx.config({ denegados: { ...DENEGADOS_BASE, patrones: [{ nombre: 'host-de-globex', categoria: 'host-interno', regex: 'globex\\.interno' }] } });
  escribir(fx.arnes, { 'guides/proveedores.md': 'Trabajamos con globex.interno.\n' });
  commitear(fx.arnes, 'un nombre sin reemplazo');
  const salida = fx.salida('t14');
  const r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.match(r.out, /globex\.interno/, 'el informe del detector va a la salida estándar');
  assert.ok(!fs.existsSync(salida), 'sin salida');
  assert.deepStrictEqual(temporales(fx), [], 'sin temporal');
  const alLado = fs.readdirSync(path.join(fx.dir, 'out')).filter((x) => x.startsWith('t14'));
  assert.deepStrictEqual(alLado, ['t14.reemplazos.md'], 'al lado queda sólo el listado de reemplazos');
  assert.doesNotMatch(fs.readFileSync(`${salida}.reemplazos.md`, 'utf8'), /globex/i, 'el listado no trae el informe del detector');

  // Con miles de hallazgos, el --json supera el buffer de un pipe: tiene que llegar entero.
  escribir(fx.arnes, { 'guides/proveedores.md': 'Trabajamos con globex.interno.\n'.repeat(3000) });
  commitear(fx.arnes, 'muchos hallazgos');
  const g = exportar(fx, ['--package', 'core', '--output', fx.salida('t14b'), '--json']);
  assert.strictEqual(g.code, 1, g.err);
  assert.ok(g.out.length > 65536 && g.json, `JSON entero y legible (${g.out.length} bytes)`);
  assert.strictEqual(g.json.detector.arnes.hallazgos.length, 3000);
});

// ── T15 · AC 17 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_NoPudoMirar_Exit2', () => {
  const fx = fixture();
  const cero = clonar(LISTA_BASE);
  cero.packages.core.arnes.out = [{ glob: '**', reason: 'deja todo afuera (prueba)' }];
  const muerto = clonar(LISTA_BASE);
  muerto.packages.core.arnes.in.push('docs/**');
  const casos = [
    ['sin replacements.json', { args: ['--replacements', path.join(fx.dir, 'no-existe.json')] }, /reemplazos/],
    ['denylist.json ilegible', { antes: () => fs.writeFileSync(fx.cfg.denegados, '{ roto') }, /denylist/],
    ['una referencia que no es un commit', { args: ['--harness', '0000000'] }, /0000000/],
    ['la segunda referencia no es un commit (con --json)', { args: ['--agent-skills', '0000000'], json: 'resultado' }, /0000000/],
    ['un repo fuente que no está', { env: { TYCON_GUIDES_DIR: path.join(fx.dir, 'no-hay-repo') } }, /no-hay-repo/],
    ['el paquete privado', { paquete: 'clients' }, /clients/],
    ['un paquete desconocido', { paquete: 'otro' }, /otro/],
    ['una lista que deja cero archivos', { lista: cero }, /cero archivos/],
    ['un glob muerto', { lista: muerto, json: true }, /docs\/\*\*/],
    ['una referencia vacía', { args: ['--harness', ''] }, /necesita un valor/],
    ['una configuración vacía', { args: ['--allowlist', ''] }, /necesita un valor/],
  ];
  casos.forEach(([nombre, c, motivo], i) => {
    fx.config({ lista: c.lista || LISTA_BASE, reemplazos: REEMPLAZOS_BASE, denegados: DENEGADOS_BASE });
    if (c.antes) c.antes();
    const salida = fx.salida(`t15-${i}`);
    const r = exportar(fx, ['--package', c.paquete || 'core', '--output', salida, ...(c.json ? ['--json'] : []), ...(c.args || [])], { env: c.env || {} });
    assert.strictEqual(r.code, 2, `${nombre}: exit 2 — «no pude mirar» nunca es «limpio» (salió ${r.code})\n${r.err}\n${r.out}`);
    assert.match(r.err, motivo, `${nombre}: dice el motivo`);
    assert.ok(!fs.existsSync(salida) && !fs.existsSync(`${salida}.reemplazos.md`), `${nombre}: no queda nada escrito`);
    if (c.json === true) assert.deepStrictEqual(r.json.globsSinUso, ['arnes: docs/**'], `${nombre}: globsSinUso`);
    if (c.json === 'resultado') {
      assert.strictEqual(r.json && r.json.resultado, 2, `${nombre}: el --json dice 2 aunque una sola referencia haya resuelto`);
      assert.strictEqual(r.json.fuentes.arnes.sha.length >= 40, true, `${nombre}: trae la referencia que sí resolvió`);
    }
  });
  const viejo = fx.salida('t15-viejo');
  fs.writeFileSync(`${viejo}.reemplazos.md`, '# Listado de reemplazos — PRIVADO: contiene los nombres reales, no se publica\n');
  const rv = exportar(fx, ['--package', 'clients', '--output', viejo]);
  assert.strictEqual(rv.code, 2, rv.err);
  assert.ok(!fs.existsSync(`${viejo}.reemplazos.md`), 'un 2 temprano también borra el listado viejo');
  // …salvo que caiga dentro de un repo de git: sin haber ubicado los repos fuente, un 2 temprano no lo toca.
  const enRepo = path.join(fx.arnes, 'listado-viejo.md');
  fs.writeFileSync(enRepo, '# Listado de reemplazos — PRIVADO: contiene los nombres reales, no se publica\n');
  const re = exportar(fx, ['--package', 'clients', '--output', fx.salida('t15-en-repo'), '--report', enRepo]);
  assert.strictEqual(re.code, 2, re.err);
  assert.ok(fs.existsSync(enRepo), 'un listado dentro de un repo de git no se borra en un 2 temprano');
  assert.match(re.err, /dejé el listado viejo .*listado-viejo\.md.*dentro de un repo de git/, 'y lo dice: tiene nombres reales');
  fs.rmSync(enRepo);
  // Un listado que no se deja leer no es «no es un listado»: no se borra, no se pisa, y se dice por qué.
  const cerrado = fx.salida('t15-cerrado');
  const listadoCerrado = `${cerrado}.reemplazos.md`;
  fs.writeFileSync(listadoCerrado, '# Listado de reemplazos — PRIVADO: contiene los nombres reales, no se publica\n');
  fs.chmodSync(listadoCerrado, 0o000);
  const rc = exportar(fx, ['--package', 'clients', '--output', cerrado]);
  const rd = exportar(fx, ['--package', 'core', '--output', cerrado]);
  fs.chmodSync(listadoCerrado, 0o644);
  for (const [nombre, r] of [['un 2 temprano', rc], ['una corrida que saldría 0', rd]]) {
    assert.strictEqual(r.code, 2, `${nombre}: ${r.err}`);
    assert.match(r.err, /no pude leer .*t15-cerrado\.reemplazos\.md.*EACCES/, `${nombre}: dice que no lo pudo leer, no que no es un listado`);
    assert.ok(fs.existsSync(listadoCerrado), `${nombre}: lo que no pudo leer no lo borra`);
    assert.ok(!fs.existsSync(cerrado), `${nombre}: sin salida`);
  }
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T16 · AC 18, 20 ───────────────────────────────────────────────────────────────────────────────────
test('Exportador_UnCommitPorRepo_Plomeria', () => {
  const fx = fixture();
  escribir(fx.arnes, {
    'scripts/escondido.txt': 'lo esconde el ignore global de la máquina\n',
    'scripts/ejecutable.sh': '#!/bin/bash\necho hola\n',
    'scripts/crlf.txt': 'uno\r\ndos\r\n',
  });
  fs.chmodSync(path.join(fx.arnes, 'scripts', 'ejecutable.sh'), 0o755);
  commitear(fx.arnes, 'plomería');

  // Una configuración global hostil: hooks que fallan, firma obligatoria, un ignore que esconde, autocrlf,
  // fileMode apagado y sin rama por defecto.
  const home = path.join(fx.dir, 'home-hostil');
  const hooks = path.join(home, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const h of ['pre-commit', 'commit-msg', 'post-commit']) {
    fs.writeFileSync(path.join(hooks, h), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(hooks, h), 0o755);
  }
  fs.writeFileSync(path.join(home, 'ignore'), 'escondido.txt\n');
  fs.writeFileSync(path.join(home, '.gitconfig'),
    `[core]\n\thooksPath = ${hooks}\n\texcludesFile = ${path.join(home, 'ignore')}\n\tautocrlf = true\n\tfileMode = false\n[commit]\n\tgpgsign = true\n`);
  // Y lanzado desde un hook de git: GIT_DIR y GIT_INDEX_FILE heredados apuntarían todo a otro repo.
  const ajeno = path.join(fx.dir, 'repo-ajeno');
  fs.mkdirSync(ajeno);
  gitFx(ajeno, ['init', '-q', '-b', 'main']);
  const env = { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: path.join(ajeno, '.git'), GIT_INDEX_FILE: path.join(ajeno, '.git', 'index') };
  const sonda = path.join(fx.dir, 'sonda');
  fs.mkdirSync(sonda);
  const sondaEnv = { ...sinGit(process.env), HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['init', '-q', sonda], { env: sondaEnv });
  assert.strictEqual(spawnSync('git', ['-C', sonda, 'symbolic-ref', 'HEAD'], { env: sondaEnv, encoding: 'utf8' }).stdout.trim(),
    'refs/heads/master', 'control: en este entorno un git init sin -b da master');

  const salida = fx.salida('t16');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json'], { env });
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const ct = Math.max(...[fx.arnes, fx.skills].map((d) => Number(gitFx(d, ['log', '-1', '--format=%ct', 'HEAD']))));
  for (const f of ['arnes', 'agent-skills']) {
    const repo = path.join(salida, f);
    assert.strictEqual(gitCopia(repo, ['rev-list', '--count', 'HEAD']), '1', `${f}: un solo commit`);
    assert.strictEqual(gitCopia(repo, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    const meta = gitCopia(repo, ['cat-file', '-p', 'HEAD']);
    assert.match(meta, new RegExp(`^author TYCON <arnes@tycon\\.com\\.ar> ${ct} \\+0000$`, 'm'), meta);
    assert.match(meta, new RegExp(`^committer TYCON <arnes@tycon\\.com\\.ar> ${ct} \\+0000$`, 'm'), meta);
    assert.match(meta, /paquete core/, 'el mensaje cita el paquete');
    assert.match(meta, new RegExp(r.json.fuentes.arnes.sha), 'y los shas fuente');
    assert.strictEqual(gitCopia(repo, ['rev-parse', 'HEAD']), r.json.repos[f].commit);
    assert.strictEqual(gitCopia(repo, ['rev-parse', 'HEAD^{tree}']), r.json.repos[f].arbol);
  }
  const arnes = path.join(salida, 'arnes');
  assert.match(gitCopia(arnes, ['ls-tree', 'HEAD', 'scripts/escondido.txt']), /escondido\.txt/, 'el ignore de la máquina no esconde nada');
  assert.match(gitCopia(arnes, ['ls-tree', 'HEAD', 'scripts/ejecutable.sh']), /^100755 /, 'el +x va en el commit');
  assert.ok(fs.statSync(path.join(arnes, 'scripts', 'ejecutable.sh')).mode & 0o100, 'y en el árbol de trabajo');
  assert.strictEqual(gitCopia(arnes, ['rev-parse', 'HEAD:scripts/crlf.txt']), gitFx(fx.arnes, ['rev-parse', 'HEAD:scripts/crlf.txt']),
    'el contenido no pasa por autocrlf');
  for (const campo of ['paquete', 'fuentes', 'archivos', 'excluidosFijos', 'pendientes', 'globsSinUso', 'entradasSinClasificar',
    'paresSinUso', 'reemplazos', 'detector', 'informe', 'repos']) {
    assert.ok(campo in r.json, `--json trae ${campo}`);
  }
  assert.strictEqual(r.json.paquete, 'core');
  assert.strictEqual(r.json.archivos.arnes, listar(arnes).length);
  for (const f of ['arnes', 'agent-skills']) {
    assert.ok(!fs.existsSync(path.join(salida, f, '.git', 'logs')), `${f}: sin reflog (lo firmaría la identidad de la máquina)`);
    assert.strictEqual(gitCopia(path.join(salida, f), ['status', '--porcelain', '--untracked-files=all']), '', `${f}: el árbol coincide con el commit`);
  }
});

// ── T17 · AC 19 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_Reproducible_ArbolYCommit', () => {
  const fx = fixture();
  const salida = fx.salida('t17');
  const homeCon = (nombre, gitconfig) => {
    const h = path.join(fx.dir, nombre);
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, '.gitconfig'), gitconfig);
    return h;
  };
  const correr = (env, umask) => {
    const args = ['--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--public-repos', fx.cfg.publicRepos,
      '--harness', 'HEAD', '--agent-skills', 'HEAD', '--package', 'core', '--output', salida, '--json'];
    const r = spawnSync('/bin/bash', ['-c', `umask ${umask}; exec "$0" "$@"`, process.execPath, EXPORTAR, ...args], {
      cwd: fx.dir, encoding: 'utf8',
      env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills, ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const shas = () => Object.fromEntries(['arnes', 'agent-skills'].map((f) =>
    [f, [gitCopia(path.join(salida, f), ['rev-parse', 'HEAD^{tree}']), gitCopia(path.join(salida, f), ['rev-parse', 'HEAD'])]]));

  const r1 = correr({ TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: homeCon('h1', '') }, '022');
  assert.strictEqual(r1.code, 0, `${r1.err}\n${r1.out}`);
  const uno = { shas: shas(), informe: fs.readFileSync(`${salida}.reemplazos.md`, 'utf8') };
  fs.renameSync(salida, `${salida}-1`);
  fs.renameSync(`${salida}.reemplazos.md`, `${salida}-1.reemplazos.md`);

  const r2 = correr({
    TZ: 'America/Argentina/Buenos_Aires', LANG: 'es_AR.UTF-8', LC_ALL: 'es_AR.UTF-8',
    HOME: homeCon('h2', '[user]\n\tname = Otra Persona\n\temail = otra@example.com\n[core]\n\tautocrlf = true\n\tfileMode = false\n'),
  }, '077');
  assert.strictEqual(r2.code, 0, `${r2.err}\n${r2.out}`);
  assert.deepStrictEqual(shas(), uno.shas, 'mismo árbol y mismo commit por repo');
  assert.strictEqual(r2.out, r1.out, '--json idéntico byte a byte');
  assert.strictEqual(fs.readFileSync(`${salida}.reemplazos.md`, 'utf8'), uno.informe, 'listado idéntico byte a byte');

  escribir(fx.arnes, { 'scripts/roto.sh': '#!/bin/bash\necho )\n' });
  commitear(fx.arnes, 'un script roto');
  const roto = fx.salida('t17-roto');
  const a = exportar(fx, ['--package', 'core', '--output', roto, '--json']);
  const b = exportar(fx, ['--package', 'core', '--output', roto, '--json']);
  assert.strictEqual(a.code, 1, a.err);
  assert.strictEqual(a.json.controles.compilacion.length, 1);
  assert.strictEqual(a.out, b.out, 'con hallazgos el --json también es el mismo byte a byte');
});

// ── T18 · AC 21 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_SalidaExistenteODentroDeUnRepo_Exit2', () => {
  const fx = fixture();
  const existente = fx.salida('ya-existe');
  fs.mkdirSync(existente);
  fs.writeFileSync(path.join(existente, 'mio.txt'), 'no tocar\n');
  let r = exportar(fx, ['--package', 'core', '--output', existente]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /ya existe/);
  assert.deepStrictEqual(fs.readdirSync(existente), ['mio.txt']);
  assert.strictEqual(fs.readFileSync(path.join(existente, 'mio.txt'), 'utf8'), 'no tocar\n');

  const antes = estadoFuentes(fx);
  r = exportar(fx, ['--package', 'core', '--output', path.join(fx.arnes, 'copia')]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /dentro del repo/);
  assert.ok(!fs.existsSync(path.join(fx.arnes, 'copia')));
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t18b'), '--report', path.join(fx.skills, 'listado.md')]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /dentro del repo/);
  assert.deepStrictEqual(estadoFuentes(fx), antes, 'los repos fuente, intactos');

  const home = path.join(fx.dir, 'casa');
  fs.mkdirSync(home);
  r = exportar(fx, ['--package', 'core', '--output', home], { env: { HOME: home } });
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /HOME/);
  assert.deepStrictEqual(fs.readdirSync(home), []);
  // En un disco que no distingue mayúsculas, ARNES es la misma carpeta que arnes (en uno que sí, no existe): 2 igual.
  const otraCaja = path.join(fx.dir, 'ARNES', 'copia');
  r = exportar(fx, ['--package', 'core', '--output', otraCaja]);
  assert.strictEqual(r.code, 2, r.err);
  assert.deepStrictEqual(estadoFuentes(fx), antes, 'los repos fuente, intactos');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T19 · AC 23 ───────────────────────────────────────────────────────────────────────────────────────
test('Exportador_ManifiestosYConfig_Derivados', () => {
  const fx = fixture();
  const suites = [
    '{',
    '  "__doc": "Suites de mentira.",',
    '  "diarias": [',
    '    {', '      "raiz": "arnes",', '      "ruta": "tests/uno.test.js",', '      "requiere": []', '    },',
    '    {', '      "raiz": "arnes",', '      "ruta": "tests/privada.test.sh",', '      "requiere": ["repos-del-equipo"]', '    },',
    '    {', '      "raiz": "arnes",', '      "ruta": "tests/suites-coverage.test.js",', '      "requiere": []', '    },',
    '    {', '      "raiz": "arnes",', '      "ruta": "tests/vigilante.test.js",', '      "requiere": []', '    }',
    '  ],',
    '  "semanales": [',
    '    {', '      "raiz": "agent-skills",', '      "ruta": "bmad-x/tests/t.test.js",', '      "requiere": ["agent-skills"]', '    }',
    '  ]',
    '}', '',
  ].join('\n');
  const suitesEsperado = [
    '{',
    '  "__doc": "Suites de mentira.",',
    '  "diarias": [',
    '    {', '      "raiz": "arnes",', '      "ruta": "tests/uno.test.js",', '      "requiere": []', '    },',
    '    {', '      "raiz": "arnes",', '      "ruta": "tests/suites-coverage.test.js",', '      "requiere": []', '    }',
    '  ],',
    '  "semanales": []',
    '}', '',
  ].join('\n');
  const gitignore = [
    'node_modules/', '.dashboard/*', '!.dashboard/sdlc-stage-*.json', '**/.advisors/*', '!**/.advisors/dod-runtime/',
    '!**/.advisors/pipeline-runs/', '**/.advisors/pipeline-runs/*', '!**/.advisors/pipeline-runs/*/',
    '**/.advisors/pipeline-runs/*/*', '!**/.advisors/pipeline-runs/*/findings.json', '*.log', '',
  ].join('\n');
  const gitignoreEsperado = [
    'node_modules/', '.dashboard/*', '**/.advisors/*', '**/.advisors/pipeline-runs/*', '**/.advisors/pipeline-runs/*/*', '*.log', '',
  ].join('\n');
  escribir(fx.arnes, {
    'scripts/tests/suites.json': suites,
    'scripts/tests/suites-coverage.test.js': fs.readFileSync(path.join(__dirname, 'suites-coverage.test.js')),
    'scripts/tests/portable-suites.test.sh': '#!/bin/bash\n# se corre a mano\n',
    'scripts/tests/privada.test.sh': '#!/bin/bash\n',
    'scripts/tests/vigilante.test.js': "'use strict';\n",
    // Un .js con sintaxis de módulo (como el workflow del pase adversarial) y uno CommonJS con `return` suelto: en el
    // interno, sin package.json, node decide por el contenido; la copia tiene que decidir igual, con o sin un «module» arriba.
    'scripts/meta.workflow.js': "export const meta = { name: 'x' };\n",
    'scripts/cjs-return.js': "'use strict';\nif (process.argv.length > 99) return;\nmodule.exports = 1;\n",
    'scripts/controls-bench/cases/hooks/31-x.json': `${JSON.stringify({ hooks: [{ hook: 'x.js (algo)', script: '${FIXTURE}/x.sh', cases: [{ id: 'caso-a' }, { id: 'caso-b' }] }] }, null, 2)}\n`,
    'scripts/controls-bench/baseline/claude.json': `${JSON.stringify({ fixed_at: 'x', tool: 'claude', cases: { 'x.sh::caso-a': true, 'otro.js::caso': true, 'x.sh::caso-b': false } }, null, 2)}\n`,
    '.gitignore': gitignore,
  });
  escribir(fx.skills, { 'skills/bmad-x/tests/t.test.js': "'use strict';\n" });
  commitear(fx.arnes, 'suites y casos');
  commitear(fx.skills, 'una suite que no viaja');
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: 'scripts/tests/privada.test.sh', reason: 'necesita los repos del equipo' });
  lista.suitesOutside = [{ root: 'arnes', path: 'tests/vigilante.test.js', reason: 'su código no viaja' }];
  lista.casesOutside = [{ path: 'scripts/controls-bench/cases/hooks/31-x.json', reason: 'prueba algo que no viaja' }];
  lista.empty = { 'scripts/controls-bench/exam-config.json': ['designated_machine'] };
  lista.synthetic = [{ target: 'scripts/ci/pipeline-debt.json', from: 'scripts/publishing/synthetic/pipeline-debt.json', reason: 'pipeline-debt.test.js lo necesita' }];
  fx.config({ lista });
  // La salida bajo una carpeta con un package.json «module»: node leería cada .js de la copia como ESM.
  fs.writeFileSync(path.join(fx.dir, 'out', 'package.json'), '{ "type": "module" }\n');
  const salida = fx.salida('t19');
  let r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!fs.existsSync(path.join(salida, 'package.json')), 'la guarda de CommonJS no queda en la copia');
  fs.rmSync(path.join(fx.dir, 'out', 'package.json'));   // lo que sigue corre la copia misma: sin el «module» de arriba
  assert.strictEqual(leer(salida, 'arnes/scripts/controls-bench/baseline/claude.json'),
    `${JSON.stringify({ fixed_at: 'x', tool: 'claude', cases: { 'otro.js::caso': true } }, null, 2)}\n`, 'el caso fuera se lleva sus entradas de la línea base');

  assert.strictEqual(leer(salida, 'arnes/scripts/tests/suites.json'), suitesEsperado, 'la suite y su entrada salen juntas; el resto, igual');
  for (const p of ['scripts/tests/privada.test.sh', 'scripts/tests/vigilante.test.js', 'scripts/controls-bench/cases/hooks/31-x.json']) {
    assert.ok(!existe(salida, `arnes/${p}`), p);
  }
  const cob = spawnSync(process.execPath, [path.join(salida, 'arnes', 'scripts', 'tests', 'suites-coverage.test.js')], {
    encoding: 'utf8', env: { ...sinGit(process.env), TYCON_SKILLS_DIR: path.join(salida, 'agent-skills', 'skills') },
  });
  assert.strictEqual(cob.status, 0, `suites-cobertura de la copia en verde:\n${cob.stdout}${cob.stderr}`);
  assert.strictEqual(leer(salida, 'arnes/scripts/controls-bench/exam-config.json'), EXAMEN.replace('"Mac-Del-Equipo"', '""'),
    'la máquina del equipo no sale y el resto queda igual');
  assert.strictEqual(leer(salida, 'arnes/scripts/ci/pipeline-debt.json'), DEUDA_SINTETICA, 'el pipeline-debt de la copia es el sintético');
  assert.strictEqual(leer(salida, 'arnes/.gitignore'), gitignoreEsperado, 'sin las líneas que re-incluyen algo de una exclusión fija');
  for (const p of ['.dashboard/sdlc-stage-2026-09-27.json', '.advisors/pipeline-runs/r/findings.json', '.advisors/dod-runtime/x-matriz.md']) {
    assert.strictEqual(gitFx(fx.arnes, ['check-ignore', '-q', p], { tolerar: true }).status, 1, `control: en el interno ${p} viaja`);
    assert.strictEqual(gitFx(path.join(salida, 'arnes'), ['check-ignore', '-q', p], { tolerar: true }).status, 0, `en la copia ${p} se ignora`);
  }
  const informe = fs.readFileSync(`${salida}.reemplazos.md`, 'utf8');
  for (const ajuste of ['tests/vigilante.test.js', 'tests/privada.test.sh', 'bmad-x/tests/t.test.js', '31-x.json', 'designated_machine', 'scripts/ci/pipeline-debt.json', '.gitignore']) {
    assert.ok(informe.includes(ajuste), `el listado nombra el ajuste: ${ajuste}`);
  }

  // Una suite declarada fuera que no existe es un error de la lista.
  lista.suitesOutside.push({ root: 'arnes', path: 'tests/fantasma.test.js', reason: 'no existe' });
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t19b')]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /fantasma\.test\.js/);
});

// ── T28 · AC 30 (vuelta 1 de revisión de la tanda B) ─────────────────────────────────────────────────────────
test('Exportador_OtraCajaEnIdentificador_SeReemplaza', () => {
  const fx = fixture();
  fx.config({
    reemplazos: {
      pares: [
        { real: 'ACME', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'ACME', anonimo: 'BETA' }] },
        { real: 'Corvex', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'Corvex', anonimo: 'Delfin' }] },
        { real: 'GlobexCorp', categoria: 'cliente', formas: [{ texto: 'GlobexCorp', anonimo: 'Yatay' }] },
      ],
      afuera: [],
    },
    denegados: {
      terminos: [
        { patron: 'ACME', categoria: 'cliente', palabra: true, mayusculas: true },
        { patron: 'Corvex', categoria: 'cliente', palabra: true, mayusculas: true },
        { patron: 'GlobexCorp', categoria: 'cliente' },
      ],
      emailsPermitidos: ['arnes@tycon.com.ar'],
    },
  });
  escribir(fx.arnes, {
    // (story 8.10.2, AC 7) también la ruta de Windows, con la barra invertida
    'guides/identificadores.md': "repos/backend-acme/x.json\nGET /api/acme/ordenes\nproject: 'acme'\nel acme de la curva\nel repo globex-corp\nEL CASO CORVEX: seguía\nC:\\repos\\acme\\backend\n",
    // la lista de esta prueba es otra: el registro de productos, con uno que ella ve (story 8.10, AC 18)
    'scripts/ci/product-parity.json': `${JSON.stringify({ grupos: { g: [{ producto: 'ACME', ruta: 'ACME/Backend' }] } }, null, 2)}\n`,
    // …y la portada de mentira, sin el nombre compuesto de las otras pruebas: con `ACME` de sigla, `AcmeCorp` es la
    // sigla pegada en CamelCase, que el detector ve desde la 8.10.1 y la tabla no reemplaza (se arregla en la fuente)
    'README.md': '# Arnés de mentira\n',
  });
  commitear(fx.arnes, 'identificadores en otra caja');
  const salida = fx.salida('t28');
  const r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 0, `el identificador en otra caja se reemplaza: no queda nada que el detector vea\n${r.err}\n${r.out}`);
  const copia = leer(salida, 'arnes/guides/identificadores.md');
  assert.match(copia, /repos\/backend-beta\/x\.json/, 'pegado a un guion, en la caja de lo encontrado');
  assert.match(copia, /\/api\/beta\/ordenes/, 'entre barras');
  assert.match(copia, /project: 'beta'/, 'solo entre comillas');
  assert.match(copia, /el acme de la curva/, 'la palabra común en prosa queda como está');
  assert.match(copia, /el repo yatay/, 'el nombre de dos partes, separado por guion');
  assert.match(copia, /EL CASO DELFIN: seguía/, 'un nombre de caja mixta escrito entero en mayúsculas, en mayúsculas');
  assert.match(copia, /C:\\repos\\beta\\backend/, 'entre barras invertidas, como en una ruta de Windows');
  assert.doesNotMatch(copia, /acme[-/']|globex-corp|CORVEX/i, 'ni un identificador del real');

  // (story 8.10.1, AC 41) la sigla pegada en CamelCase —el nombre de una etapa de pipeline— no la reemplaza la tabla: el
  // detector la ve y la copia no sale. Se arregla en la fuente.
  escribir(fx.arnes, { 'scripts/etapa.sh': 'SYSTEM_STAGENAME=DeployAcmeStaging\n' });
  commitear(fx.arnes, 'la sigla pegada en el nombre de una etapa');
  const pegada = exportar(fx, ['--package', 'core', '--output', fx.salida('t28-pegada')]);
  assert.strictEqual(pegada.code, 1, `la sigla pegada en CamelCase frena la copia\n${pegada.err}\n${pegada.out}`);
  assert.match(`${pegada.err}\n${pegada.out}`, /scripts\/etapa\.sh:1\s+\[cliente\/ACME \(pegada en CamelCase\)\]/);
});

// ── T29 · AC 31 ─────────────────────────────────────────────────────────────────────────────────────────────────
// Story 8.10 (AC 24): la lista «Productos y clientes» dejó de ser un bloque de la guía; los clientes son los términos
// `cliente` de la lista de denegación, y un cliente sin par lo frena el control de términos sin par (AC 41).
test('Exportador_ListaDeClientes_SinParExit2', () => {
  const fx = fixture();
  escribir(fx.arnes, {
    'guides/reglas-para-revisores.md': '# Reglas para revisores\n\n## Nombres que se tachan antes de mandar\n\n'
      + 'Los términos `cliente` de la lista de denegación.\n\n## Otra cosa\n\nNada.\n',
  });
  commitear(fx.arnes, 'la guía sin el bloque de la lista');
  const a = fx.salida('t29a');
  let r = exportar(fx, ['--package', 'core', '--output', a]);
  assert.notStrictEqual(r.code, 2, `la guía ya no se lee como lista: sin el bloque no hay «no pude mirar»\n${r.err}\n${r.out}`);
  assert.doesNotMatch(`${r.err}${r.out}`, /Productos y clientes/, 'el control viejo no aparece');

  const denegados = clonar(DENEGADOS_BASE);
  denegados.terminos.push({ patron: 'Omega', categoria: 'cliente' });
  fx.config({ denegados });
  const b = fx.salida('t29b');
  r = exportar(fx, ['--package', 'core', '--output', b]);
  assert.strictEqual(r.code, 2, `un cliente de la lista sin par en la tabla: no hay copia\n${r.err}\n${r.out}`);
  assert.match(`${r.err}${r.out}`, /terminos\[\d+\] \(cliente\)/, 'lo nombra por su posición y su categoría');
  assert.doesNotMatch(`${r.err}${r.out}`, /Omega/, 'nunca por su valor: la lista es privada');
  assert.ok(!fs.existsSync(b), 'sin salida');
  assert.deepStrictEqual(temporales(fx), [], 'ni temporal');

  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares.push({ real: 'Omega', categoria: 'cliente', formas: [{ texto: 'Omega', anonimo: 'Sigma' }] });
  fx.config({ reemplazos, denegados });
  const c = fx.salida('t29c');
  r = exportar(fx, ['--package', 'core', '--output', c]);
  assert.notStrictEqual(r.code, 2, `con su par la corrida sigue\n${r.err}\n${r.out}`);
});

// ── T30 · AC 32 (la prueba del pase adversarial, traversal-completeness-3) ──────────────────────────────────────
test('Exportador_AnonimosProducidos_Exit2', () => {
  const denegados = clonar(DENEGADOS_BASE);
  denegados.terminos.push({ patron: 'Zenit', categoria: 'cliente', palabra: true });
  // (a) sin `mayusculas`, `AcmeCorp` → `Ceibo` también produce `CEIBO` (la caja de lo encontrado): el anónimo DECLARADO de otro real
  let fx = fixture();
  escribir(fx.arnes, { 'guides/clientes.md': 'ACMECORP y ZENIT son dos clientes distintos.\n' });
  commitear(fx.arnes, 'dos clientes');
  fx.config({
    reemplazos: {
      pares: [
        { real: 'AcmeCorp', categoria: 'cliente', palabra: true, formas: [{ texto: 'AcmeCorp', anonimo: 'Ceibo' }] },
        { real: 'Zenit', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'ZENIT', anonimo: 'CEIBO' }] },
      ],
      afuera: [],
    },
    denegados,
  });
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('t30a')]);
  assert.strictEqual(r.code, 2, `dos reales terminan en «CEIBO»: exit 2 antes de escribir\n${r.err}\n${r.out}`);
  assert.match(r.err, /AcmeCorp/);
  assert.match(r.err, /Zenit/);
  assert.ok(!fs.existsSync(fx.salida('t30a')));

  // (b) en cadena: el anónimo de `AcmeCorp` es el real de un par POSTERIOR, que lo vuelve a reemplazar
  fx = fixture();
  escribir(fx.arnes, { 'guides/cadena.md': 'AcmeCorp y Zenit son dos clientes distintos.\n' });
  commitear(fx.arnes, 'cadena');
  fx.config({
    reemplazos: {
      pares: [
        { real: 'AcmeCorp', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'AcmeCorp', anonimo: 'Zenit' }] },
        { real: 'Zenit', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'Zenit', anonimo: 'Orion' }] },
      ],
      afuera: [],
    },
    denegados,
  });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t30b')]);
  assert.strictEqual(r.code, 2, `el anónimo de uno lo reescribe otro: exit 2\n${r.err}\n${r.out}`);
  assert.match(r.err, /AcmeCorp/);
  assert.match(r.err, /Zenit/);
  assert.ok(!fs.existsSync(fx.salida('t30b')));
});

// ── T31 · AC 33 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('Exportador_PegadosYComandos_Bordes', () => {
  // (a) `Cam` (palabra + mayúsculas) no marca «Camino»: pegado es lo que sigue con mayúscula o dígito
  const fx = fixture();
  const denegados = clonar(DENEGADOS_BASE);
  denegados.terminos.push({ patron: 'Cam', categoria: 'persona', palabra: true, mayusculas: true });
  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares.push({ real: 'Cam', categoria: 'persona', palabra: true, mayusculas: true, formas: [{ texto: 'Cam', anonimo: 'Cid' }] });
  fx.config({ denegados, reemplazos });
  escribir(fx.arnes, { 'guides/equipo.md': 'Por el Camino, hasta la Campana.\n' });
  commitear(fx.arnes, 'palabras que empiezan con Cam');
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('t31a')]);
  assert.strictEqual(r.code, 0, `«Camino» no es «Cam» pegado\n${r.err}\n${r.out}`);
  escribir(fx.arnes, { 'guides/equipo.md': 'Por el Camino, en el repo CamBackend.\n' });
  commitear(fx.arnes, 'ahora sí pegado');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t31b')]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.match(r.out, /CamBackend/, 'el identificador pegado sí');
  assert.doesNotMatch(r.out, /Camino/, 'la palabra no');

  // (b) comandos con una opción entre el ejecutable y la ruta (la prueba del pase adversarial, false-negative-classification-4)
  const fy = fixture();
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: 'scripts/x/**', reason: 'no viaja (prueba)' });
  fy.config({ lista });
  escribir(fy.arnes, {
    'scripts/x/y.test.js': "'use strict';\n",
    'scripts/x/z.sh': '#!/bin/bash\necho z\n',
    'commands/hacer.md': '# Hacer\n\nCorré `node --test scripts/x/y.test.js` para empezar.\n\nDespués `bash -x scripts/x/z.sh`.\n',
  });
  commitear(fy.arnes, 'comandos con opción');
  r = exportar(fy, ['--package', 'core', '--output', fy.salida('t31c')]);
  assert.strictEqual(r.code, 1, `los dos mandan correr algo que no viaja\n${r.err}\n${r.out}`);
  assert.match(r.out, /commands\/hacer\.md:3.*scripts\/x\/y\.test\.js/);
  assert.match(r.out, /commands\/hacer\.md:5.*scripts\/x\/z\.sh/);
});

// ── story 8.10.3, tanda C (AC 12, T12) — un nombre pegado con su excepción exacta no frena ─────────────────────────
// El nombre de un repo interno es un término de palabra entera con su par; el nombre funcional del sitio de un servidor
// lo lleva pegado (`<Repo>API`) y tiene que quedar: quien lee la guía lo busca así en su servidor. El control de nombres
// pegados respeta una excepción de `permitidos` que nombre el archivo y el identificador ENTERO. Sin la excepción, con
// la de otro archivo o con otro identificador en el mismo archivo, sigue frenando.
test('Exporter_GluedNameWithExactAllowance_DoesNotBrake', () => {
  const fx = fixture();
  const denegados = clonar(DENEGADOS_BASE);
  denegados.terminos.push({ patron: 'ZetaRepo', categoria: 'interno', palabra: true });
  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares.push({ real: 'ZetaRepo', categoria: 'interno', palabra: true, formas: [{ texto: 'ZetaRepo', anonimo: 'PluginHost' }] });
  fx.config({ denegados, reemplazos });
  escribir(fx.arnes, { 'guides/sitio.md': 'El caso nació en ZetaRepo. El `web.config` del sitio (`*ZETARepoAPI`) lleva la regla.\n' });
  commitear(fx.arnes, 'el sitio lleva pegado el nombre del repo');
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('c12a')]);
  assert.strictEqual(r.code, 1, `sin excepción, el pegado frena\n${r.err}\n${r.out}`);
  assert.match(r.out, /guides\/sitio\.md:1.*ZETARepoAPI/);

  denegados.permitidos = [{ archivo: 'guides/otra.md', patron: '^ZETARepoAPI$', motivo: 'el sitio del host, en OTRO archivo (prueba)' }];
  fx.config({ denegados, reemplazos });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('c12b')]);
  assert.strictEqual(r.code, 1, `la excepción de otro archivo no cubre a éste\n${r.err}\n${r.out}`);

  denegados.permitidos = [{ archivo: 'guides/sitio.md', patron: '^ZETARepoAPI$', motivo: 'el nombre funcional del sitio del host (prueba)' }];
  fx.config({ denegados, reemplazos });
  const c = fx.salida('c12c');
  r = exportar(fx, ['--package', 'core', '--output', c]);
  assert.strictEqual(r.code, 0, `con la excepción exacta, no frena\n${r.err}\n${r.out}`);
  const salio = leer(c, 'arnes/guides/sitio.md');
  assert.match(salio, /nació en PluginHost\./, 'el nombre suelto sale reemplazado: la tabla es la red');
  assert.match(salio, /\*ZETARepoAPI/, 'el sitio del host queda tal cual: es lo que el lector busca en su servidor');

  // la excepción es del identificador ENTERO: otro pegado en el mismo archivo sigue frenando
  escribir(fx.arnes, { 'guides/sitio.md': 'El sitio `*ZETARepoAPI` y la clase ZetaRepoBackend.\n' });
  commitear(fx.arnes, 'otro pegado, sin excepción');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('c12d')]);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.match(r.out, /ZetaRepoBackend/);
  assert.doesNotMatch(r.out, /ZETARepoAPI/, 'el permitido no vuelve a salir como hallazgo');

  // …y en su CAJA (pase adversarial, determinism-ordering-2): las excepciones se compilan sin distinguir mayúsculas para
  // el detector, pero la de un pegado nombra UN identificador; el mismo nombre en otra caja es otro hallazgo
  escribir(fx.arnes, { 'guides/sitio.md': 'El sitio `*ZETARepoAPI` y, mal escrito, `*ZetaRepoApi`.\n' });
  commitear(fx.arnes, 'el mismo pegado en otra caja');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('c12e')]);
  assert.strictEqual(r.code, 1, `la excepción no cubre al mismo nombre en otra caja\n${r.err}\n${r.out}`);
  assert.match(r.out, /ZetaRepoApi/);
  assert.doesNotMatch(r.out, /«ZETARepoAPI»/);
});

// ── T25 · story 8.10, AC 7 — la clasificación que usa el freno de nombres nuevos es la de la copia ────────────────
// El freno (scripts/publishing/new-names.js) no reimplementa qué sale: pregunta `whatShips`. Si esa función y la
// copia dijeran cosas distintas, uno de los dos mentiría. Se comparan los ARCHIVOS de las dos copias con los de la
// función (más sus pendientes), y el CONTENIDO de un archivo de cada transformación.
test('Classification_Synthetic_EqualsTheCopy', () => {
  const fx = fixture();
  escribir(fx.arnes, {
    'scripts/controls-bench/cases/hooks/31-x.json': `${JSON.stringify({ hooks: [{ hook: 'x.js', script: '${FIXTURE}/x.sh', cases: [{ id: 'caso-a' }] }] }, null, 2)}\n`,
    'scripts/controls-bench/baseline/claude.json': `${JSON.stringify({ fixed_at: 'x', tool: 'claude', cases: { 'x.sh::caso-a': true, 'otro.js::caso': true } }, null, 2)}\n`,
    'scripts/tests/vigilante.test.js': "'use strict';\n",
    'scripts/tests/suites.json': `${JSON.stringify({ __doc: 'Suites de mentira.', diarias: [
      { raiz: 'arnes', ruta: 'tests/uno.test.js', requiere: [] }, { raiz: 'arnes', ruta: 'tests/vigilante.test.js', requiere: [] }] }, null, 2)}\n`,
    '.gitignore': 'node_modules/\n.dashboard/*\n!.dashboard/sdlc-stage-*.json\n',
  });
  commitear(fx.arnes, 'transformaciones');
  const lista = clonar(LISTA_BASE);
  lista.suitesOutside = [{ root: 'arnes', path: 'tests/vigilante.test.js', reason: 'su código no viaja' }];
  lista.casesOutside = [{ path: 'scripts/controls-bench/cases/hooks/31-x.json', reason: 'prueba algo que no viaja' }];
  lista.empty = { 'scripts/controls-bench/exam-config.json': ['designated_machine'] };
  lista.synthetic = [{ target: 'scripts/ci/pipeline-debt.json', from: 'scripts/publishing/synthetic/pipeline-debt.json', reason: 'la prueba lo necesita' }];
  fx.config({ lista });
  const copias = {};
  for (const P of ['core', 'bizuit']) {
    const r = exportar(fx, ['--package', P, '--output', fx.salida(`t25-${P}`), '--json']);
    assert.strictEqual(r.code, 0, `${P}: ${r.err}\n${r.out.slice(0, 400)}`);
    copias[P] = { salida: fx.salida(`t25-${P}`), json: r.json };
  }

  // eslint-disable-next-line global-require
  const ex = require(EXPORTAR);
  const ctx = { repos: { arnes: { dir: fx.arnes }, 'agent-skills': { dir: fx.skills } } };
  ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, fx.cfg);
  const ships = ex.whatShips(ctx);
  assert.deepStrictEqual(ships.packages.map((p) => p.pkg).sort(), ['bizuit', 'core'], 'los paquetes públicos, sin el de clientes');
  for (const p of ships.packages) {
    const { salida, json } = copias[p.pkg];
    // el `from` de un sintético cuenta como que sale (story 8.7, AC 13), aunque en la copia esté sólo en su destino
    assert.deepStrictEqual([...p.files].filter(([, a]) => a.kind !== 'synthetic-source').map(([k]) => k).sort(), listar(salida),
      `${p.pkg}: los archivos de la función son los de la copia`);
    assert.deepStrictEqual(p.pending, json.pendientes, `${p.pkg}: los pendientes de la función son los de la copia`);
    for (const [clave, a] of p.files) {
      if (!['copy', 'translation', 'synthetic', 'synthetic-source'].includes(a.kind)) assert.fail(`${clave}: «kind» desconocido (${a.kind})`);
    }
  }
  const nucleo = ships.packages.find((p) => p.pkg === 'core');
  assert.strictEqual(nucleo.files.get('arnes/scripts/ci/pipeline-debt.json').kind, 'synthetic', 'el destino de un sintético se declara: no se mira en su ruta real');
  assert.strictEqual(nucleo.files.get('arnes/adapters/codex/agents/revisor-nucleo.toml').kind, 'translation', 'las traducciones se regeneran: no se miran');
  // el contenido de un archivo de cada transformación, con la misma tabla aplicada, es el de la copia
  for (const clave of [
    'arnes/scripts/controls-bench/exam-config.json',             // vaciar
    'arnes/scripts/controls-bench/baseline/claude.json',         // línea base (caso fuera)
    'arnes/scripts/controls-bench/baseline/claude-advisors.json', // línea base (revisores de paquete)
    'arnes/adapters/codex/agents/MANIFEST.json',                 // manifiesto
    'arnes/scripts/tests/suites.json',                           // suites.json
    'arnes/guides/advisor-rules-catalog.md',                     // catálogo
    'arnes/.gitignore',
    'arnes/scripts/ci/pipeline-debt.json',                       // sintético
  ]) {
    const texto = nucleo.content(clave).toString('utf8');
    const esperado = fs.readFileSync(path.join(copias.core.salida, clave), 'utf8');
    assert.strictEqual(ex.reemplazar(texto, ctx.pares, clave.endsWith('.md')).texto, esperado, `${clave}: el contenido es el de la copia`);
  }
  // lo que se mira de un archivo: la copia de cada paquete que lo lleva, más sus pendientes; nada del paquete de clientes
  const catalogo = ships.ofFile('arnes', 'guides/advisor-rules-catalog.md');
  assert.deepStrictEqual(catalogo.map((x) => `${x.pkg}:${x.kind}`).sort(), ['bizuit:pending', 'core:copy']);
  const pendiente = catalogo.find((x) => x.kind === 'pending').text;
  assert.match(pendiente, /DOTNET-C1/, 'la sección del revisor de un paquete público cuenta aunque esté pendiente');
  assert.doesNotMatch(catalogo.map((x) => x.text).join('\n'), /XPAT-C1/, 'la del revisor de clientes no sale nunca');
  assert.deepStrictEqual(ships.ofFile('agent-skills', 'agents/revisor-cliente.md'), [], 'un revisor de clientes no sale');
  assert.deepStrictEqual(ships.ofFile('arnes', 'scripts/ci/pipeline-debt.json').map((x) => x.kind), ['synthetic']);
  assert.ok(ships.ofFile('agent-skills', 'skills/bizuit-sdd/tests/fixtures/bpmn/proceso.bpmn').some((x) => x.kind === 'pending'),
    'un «out» con «until» es un pendiente: cuenta como que sale');
});

// ── T26 · story 8.10, AC 18 — un producto del registro de paridad que la lista no ve: 2, nombrándolo ─────────────────
test('Exporter_ProductWithoutTerm_Exit2', () => {
  const fx = fixture();
  escribir(fx.arnes, { 'scripts/ci/product-parity.json': `${JSON.stringify({ grupos: { g: [
    { producto: 'AcmeCorp', ruta: 'AcmeCorp/Backend' }, { producto: 'Wonka', ruta: 'Wonka/Backend' }] } }, null, 2)}\n` });
  commitear(fx.arnes, 'un producto nuevo sin su término');
  const a = fx.salida('t26a');
  let r = exportar(fx, ['--package', 'core', '--output', a]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /«Wonka»/, 'lo nombra');
  assert.match(r.err, /product-parity\.json/);
  assert.doesNotMatch(r.err, /«AcmeCorp»/, 'el que la lista ve no se reclama');
  assert.ok(!fs.existsSync(a), 'sin salida');
  const denegados = clonar(DENEGADOS_BASE);
  denegados.terminos.push({ patron: 'Wonka', categoria: 'cliente', palabra: true });
  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares.push({ real: 'Wonka', categoria: 'cliente', palabra: true, formas: [{ texto: 'Wonka', anonimo: 'Wren' }] });
  fx.config({ denegados, reemplazos });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t26b')]);
  assert.strictEqual(r.code, 0, `con su término, la corrida sigue\n${r.err}\n${r.out}`);
});

// ── story 8.9, tanda D1 · un pack.json de antes de la D1 en el árbol del sha ───────────────────────────────────────
// Un sha de agent-skills de antes de la D1 trae los manifiestos de paquete con las claves viejas: `revisoresDePaquete`
// los lee con readKeysDeep, así el revisor del paquete privado se reconoce igual (no sale en el núcleo). Es historia de
// un sha, no un uso del nombre viejo: no se anota (record: false). Las claves viejas salen del mapa real.
const PACK_OLD = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const keys = new Map(m.entries.filter((x) => x && x.kind === 'key' && x.where === 'packs/pack.json').map((x) => [x.new, x.old]));
    return ['name', 'reviewers', 'agent', 'group'].every((k) => keys.has(k)) ? keys : null;
  } catch (_) {
    return null;
  }
})();
test('BatchD1_PackWithOldKeysInTheSha_PrivateReviewerStillRecognized', { skip: PACK_OLD ? false : 'sin el mapa de renombres no hay claves viejas' }, () => {
  const fx = fixture();
  const o = (k) => PACK_OLD.get(k);
  const pack = (name, reviewers) => `${JSON.stringify({ [o('name')]: name, [o('reviewers')]: reviewers.map(([a, g]) => ({ [o('agent')]: a, [o('group')]: g })) }, null, 2)}\n`;
  escribir(fx.skills, {
    'packs/bizuit/pack.json': pack('bizuit', [['tycon-plugin-dotnet-conventions', 'base']]),
    'packs/clients/pack.json': pack('clients', [['revisor-cliente', 'condicional']]),
  });
  commitear(fx.skills, 'los manifiestos con las claves de antes de la D1');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'export-d1-home-'));
  try {
    const salida = fx.salida('d1-pack-viejo');
    const r = exportar(fx, ['--package', 'core', '--output', salida], { env: { HOME: home } });
    assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
    assert.ok(!existe(salida, 'agent-skills/agents/revisor-cliente.md'), 'el revisor del paquete privado se reconoce con las claves viejas: no sale');
    assert.ok(!existe(salida, 'arnes/adapters/codex/agents/tycon-plugin-dotnet-conventions.toml'), 'el del paquete bizuit tampoco va al núcleo');
    assert.ok(existe(salida, 'agent-skills/agents/revisor-nucleo.md'), 'control: el del núcleo sale');
    const marks = path.join(home, '.claude', '.tycon-pipeline', 'legacy-names.d');
    const anotados = fs.existsSync(marks) ? fs.readdirSync(marks) : [];
    assert.deepStrictEqual(anotados, [], 'leer el manifiesto de un sha no anota el uso del nombre viejo');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── story 8.9, tanda D1 · el registro de productos se mudó: un sha de antes lo tiene por su nombre viejo ──────────────
// El exportador lo busca por los dos nombres (lee sus productos) y no deja salir el viejo (exclusión fija de clase). La
// ruta vieja sale del mapa real, nunca escrita acá; sin mapa (la copia pública) no hay ruta vieja.
const PARITY_OLD = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const e = m.entries.find((x) => x && x.kind === 'file' && x.new === 'scripts/ci/product-parity.json');
    return e ? e.old : null;
  } catch (_) {
    return null;
  }
})();
test('BatchD1_ParityUnderOldName_ReadAndNeverShipped', { skip: PARITY_OLD ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const fx = fixture();
  const parity = `${JSON.stringify({ grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/Backend' }, { producto: 'Wonka', ruta: 'Wonka/Backend' }] } }, null, 2)}\n`;
  // las dos rutas en el sha: el viejo no sale nunca (la clase lo tapa aunque no se le exija archivo)
  escribir(fx.arnes, { [PARITY_OLD]: parity });
  commitear(fx.arnes, 'una copia del registro por su nombre viejo');
  const ex = require(EXPORTAR);
  assert.ok(ex.EXCLUIDOS_SIEMPRE.some((x) => x.glob === PARITY_OLD && x.clase), 'el nombre viejo es una exclusión fija de clase');
  const ctx = { repos: { arnes: { dir: fx.arnes }, 'agent-skills': { dir: fx.skills } } };
  ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, fx.cfg);
  assert.deepStrictEqual(ex.whatShips(ctx).ofFile('arnes', PARITY_OLD), [], 'el registro por su nombre viejo no sale');
  // sólo el viejo en el sha: sus productos se leen igual (Wonka, que la lista no ve, frena con 2 nombrándolo)
  escribir(fx.arnes, { 'scripts/ci/product-parity.json': null });
  commitear(fx.arnes, 'el registro sólo por su nombre viejo');
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('d1-paridad')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /«Wonka»/, 'leyó los productos del registro por su nombre viejo');
});

// ── T48 · story 8.10, AC 41 — un término sin par: 2 antes de copiar, por su posición y su categoría ─────────────────
// Medido en laboratorio el 2026-09-28: un término sin par con una excepción de `permitidos` sale en la copia con el
// nombre y el exportador da 0. Con par, el reemplazo lo tapa aunque tenga la excepción.
test('Exporter_TermWithoutPair_Exit2', () => {
  const fx = fixture();
  const denegados = clonar(DENEGADOS_BASE);
  denegados.terminos.push({ patron: 'Zorblax', categoria: 'cliente', palabra: true });
  denegados.permitidos = [{ archivo: 'guides/**', patron: '^Zorblax$', motivo: 'prueba: la excepción puesta por error' }];
  fx.config({ denegados });
  escribir(fx.arnes, { 'guides/cliente-nuevo.md': 'Lo usa Zorblax.\n' });
  commitear(fx.arnes, 'un término sin par, con su excepción');
  const a = fx.salida('t48a');
  let r = exportar(fx, ['--package', 'core', '--output', a, '--json']);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /terminos\[2\]/, 'por su posición en la lista');
  assert.match(r.err, /cliente/, 'y su categoría');
  assert.doesNotMatch(`${r.err}${r.out}`, /Zorblax/, 'nunca por su valor: la salida estándar no es un canal privado');
  assert.ok(!fs.existsSync(a), 'antes de copiar nada');
  assert.deepStrictEqual(temporales(fx), []);
  const reemplazos = clonar(REEMPLAZOS_BASE);
  reemplazos.pares.push({ real: 'Zorblax', categoria: 'cliente', palabra: true, formas: [{ texto: 'Zorblax', anonimo: 'Zenit' }] });
  fx.config({ reemplazos });
  const b = fx.salida('t48b');
  r = exportar(fx, ['--package', 'core', '--output', b]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.doesNotMatch(leer(b, 'arnes/guides/cliente-nuevo.md'), /Zorblax/, 'con par, la copia no trae el nombre aunque tenga la excepción');
  assert.match(leer(b, 'arnes/guides/cliente-nuevo.md'), /Zenit/);
  // con la tabla vacía (la medición del termómetro) el control no corre, y lo dice
  fx.config({ reemplazos: { pares: [], afuera: [] } });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t48c'), '--json']);
  assert.strictEqual(r.code, 1, `con la tabla vacía, los nombres son hallazgos (1), no un 2\n${r.err}`);
  assert.match(r.err, /tabla de reemplazos vacía/);
});

// ── story 8.10, pase adversarial — «tiene par» lo decide la tabla: el reemplazo de verdad, con la caja del PAR ─────────
test('Exporter_TermHasPair_TheTableDecides', () => {
  const ex = require(EXPORTAR);
  const cats = ['cliente', 'persona', 'host-interno', 'maquina', 'interno'];
  const compilar = (pares) => ex.validarTabla({ pares, afuera: [] }, 'tabla de prueba', cats);
  const conMayusculas = { patron: 'Zorblax', categoria: 'cliente', palabra: true, mayusculas: true };
  // un par SIN mayusculas reemplaza cualquier caja: tapa al término aunque esté escrito en otra caja
  assert.ok(ex.termHasPair(conMayusculas, compilar([{ real: 'ZORBLAX', categoria: 'cliente', palabra: true, formas: [{ texto: 'ZORBLAX', anonimo: 'ZENIT' }] }])));
  // un par CON mayusculas sólo sus formas: un término sin caja escrito en otra caja no queda tapado
  const sinCaja = { patron: 'zorblax', categoria: 'cliente', palabra: true };
  assert.ok(!ex.termHasPair(sinCaja, compilar([{ real: 'Zorblax', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'Zorblax', anonimo: 'Zenit' }] }])));
  assert.deepStrictEqual(ex.termsWithoutPair([conMayusculas, sinCaja], compilar([{ real: 'Zorblax', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'Zorblax', anonimo: 'Zenit' }] }])),
    [{ indice: 1, categoria: 'cliente' }], 'por su posición y su categoría');
});

// ── 2026-10-05 (la validación en 15 min o menos) — el atajo de los reemplazos no cambia nada ─────────────────────────
// reemplazar() saltea un par si el texto, en minúsculas, no contiene la primera parte de ninguna de sus formas. Tiene
// que reemplazar igual cada caja, las partes separadas, el par que aparece recién después de otro reemplazo, y no
// atajear una forma con letras fuera de ASCII (la `i` de las expresiones y las minúsculas de JS pueden no coincidir).
test('Exporter_ReplaceShortcut_SameResultInEveryCase', () => {
  const ex = require(EXPORTAR);
  const cats = ['cliente', 'persona', 'host-interno', 'maquina', 'interno'];
  const pares = ex.validarTabla({ pares: [
    { real: 'ZorbCorp', categoria: 'cliente', palabra: true, formas: [{ texto: 'ZorbCorp', anonimo: 'AcmeCorp' }] },
    { real: 'Ñandúx', categoria: 'cliente', palabra: true, formas: [{ texto: 'Ñandúx', anonimo: 'Pato' }] },
  ], afuera: [] }, 'tabla de prueba', cats);
  const r = (t) => ex.reemplazar(t, pares, false);
  assert.deepStrictEqual([r('la ZorbCorp').texto, r('la ZORBCORP').texto, r('la zorbcorp').texto, r('la zorb-corp').texto, r('la Zorb Corp').texto],
    ['la AcmeCorp', 'la ACMECORP', 'la acmecorp', 'la acmecorp', 'la AcmeCorp'], 'cada caja y las partes separadas');
  assert.deepStrictEqual([...r('ZorbCorp y zorbcorp').cuenta], [['ZorbCorp', 2]], 'la cuenta, igual');
  assert.strictEqual(r('ÑANDÚX').texto, 'PATO', 'una forma con letras fuera de ASCII no se atajea');
  assert.deepStrictEqual([r('nada que ver').texto, r('nada que ver').cuenta.size], ['nada que ver', 0], 'sin la primera parte, nada');
});

// ── T64 · story 8.9, AC 60 (tanda C0) — `--explain --json` antes y después de mover una guía excluida por su nombre ────
// Una guía privada protegida por un glob con nombre de archivo (una exclusión fija o un «out») que se mueve a una carpeta
// nueva sin tocar el glob sale por su ruta nueva bajo `guides/**`. El control lo tiene que delatar, y el reemplazo `.md` que
// deja la mudanza en la ruta vieja NO cuenta como «el archivo sigue cubierto»: es la guía saliendo con el control en verde.
function explicarJson(fx) {
  const r = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json',
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
  assert.strictEqual(r.status, 0, `--explain --json sale 0 (informa, no frena): ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const sinArchivo = (tabla) => tabla.exclusionesSinArchivo.map((x) => `${x.origen} ${x.fuente}/${x.glob}`).sort();

test('T64 PreC1_ExporterExplainBeforeAfter — la guía privada movida sin tocar su glob, con y sin el reemplazo en la ruta vieja', () => {
  const fx = fixture();
  // la exclusión fija de guía con nombre de archivo (la del inventario de producción) y un «out» de una guía, como los reales
  const fija = fijas().find((x) => x.fuente === 'arnes' && !x.clase && /^guides\/[^/*]*\*?[^/]*\.md$/.test(x.glob));
  assert.ok(fija, 'EXCLUIDOS_SIEMPRE tiene una guía protegida por su nombre de archivo');
  const vieja = muestra(fija.glob);
  const privada = 'guides/inventario-privado.md';
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: privada, reason: 'inventario de un cliente (prueba)' });
  fx.config({ lista });
  escribir(fx.arnes, { [privada]: '# Inventario\n\nLos servidores de AcmeCorp.\n' });
  commitear(fx.arnes, 'la guía privada');

  // antes: las dos exclusiones cubren su archivo, y la tabla lo dice por exclusión
  const antes = explicarJson(fx);
  assert.deepStrictEqual(sinArchivo(antes), [], 'antes de mover, ninguna exclusión queda sin archivo');
  const de = (tabla, origen, glob) => tabla.coberturaExclusiones.find((x) => x.origen === origen && x.fuente === 'arnes' && x.glob === glob);
  assert.strictEqual(de(antes, 'fija', fija.glob).archivos, 1, 'la fija cubre su guía');
  assert.strictEqual(de(antes, 'afuera', privada).archivos, 1, 'el afuera cubre su guía');
  assert.strictEqual(de(antes, 'afuera', privada).paquete, 'core');

  // después de un `git mv` a una carpeta nueva sin tocar los globs: las dos quedan sin archivo, y la exportación no sale
  fs.mkdirSync(path.join(fx.arnes, 'guides', 'decisions'), { recursive: true });
  gitFx(fx.arnes, ['mv', vieja, `guides/decisions/${path.posix.basename(vieja)}`]);
  gitFx(fx.arnes, ['mv', privada, 'guides/decisions/inventario-privado.md']);
  commitear(fx.arnes, 'las guías a decisions/', { sinAgregar: true });
  const movidas = explicarJson(fx);
  assert.deepStrictEqual(sinArchivo(movidas), [`afuera arnes/${privada}`, `fija arnes/${fija.glob}`].sort(), 'el --explain delata las dos');
  let r = exportar(fx, ['--package', 'core', '--output', fx.salida('t64a')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /afuera sin archivo: arnes\/guides\/inventario-privado\.md/);

  // con el reemplazo `.md` que deja la mudanza en la ruta vieja: sigue sin archivo (el reemplazo no es la guía)
  const shim = (nueva) => `Movida a [\`${nueva}\`](decisions/x.md): este archivo queda en la ruta vieja hasta el retiro de los nombres viejos (story 8.9).\n<!-- ${require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js')).SHIM_MARK} ${nueva} -->\n`;
  escribir(fx.arnes, { [vieja]: shim(`guides/decisions/${path.posix.basename(vieja)}`), [privada]: shim('guides/decisions/inventario-privado.md') });
  commitear(fx.arnes, 'los reemplazos en la ruta vieja');
  const conReemplazo = explicarJson(fx);
  assert.deepStrictEqual(sinArchivo(conReemplazo), sinArchivo(movidas), 'el reemplazo no da la exclusión por cubierta');
  assert.strictEqual(de(conReemplazo, 'afuera', privada).archivos, 0);
  assert.strictEqual(de(conReemplazo, 'afuera', privada).reemplazos, 1, 'el reemplazo se cuenta aparte');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t64b')]);
  assert.strictEqual(r.code, 2, `el reemplazo no calla al control de la exportación\n${r.err}\n${r.out}`);
  assert.match(r.err, /afuera sin archivo: arnes\/guides\/inventario-privado\.md — ¿se renombró\? \(sólo queda su reemplazo\)/);
  assert.match(r.err, /exclusión fija sin archivo: arnes\/.*\(sólo queda su reemplazo\)/);

  // un «afuera» PRIVADO (el de la tabla de reemplazos) sin archivo: la exportación lo frena, y el --explain lo cuenta por
  // su posición, sin mostrar su glob (es privado)
  fx.config({ lista: LISTA_BASE, reemplazos: { ...REEMPLAZOS_BASE, afuera: [{ glob: 'arnes/guides/privada-movida.md', motivo: 'prueba' }] } });
  const priv = explicarJson(fx).coberturaExclusiones.find((x) => x.origen === 'afuera-privado');
  assert.deepStrictEqual([priv.indice, priv.archivos, 'glob' in priv], [0, 0, false], 'el afuera privado va por su posición, sin su glob');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t64c')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /afuera sin archivo: arnes\/guides\/privada-movida\.md — ¿se renombró\?/);
  assert.deepStrictEqual(temporales(fx), []);
});

// El caso real (AC 60): en el arnés del equipo, las guías privadas protegidas por su nombre de archivo (export.js y los
// «out» de la lista blanca) están cubiertas HOY por su archivo, no por un reemplazo. En la copia pública no están.
test('T64 PreC1_ExporterExplainBeforeAfter — las guías privadas reales, cada una cubierta por su archivo', { skip: !fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && 'copia pública: sin las guías privadas ni la configuración' }, () => {
  const r = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json', '--harness', 'HEAD', '--agent-skills', 'HEAD'], { cwd: RAIZ, encoding: 'utf8',
    env: { ...sinGit(process.env), TYCON_GUIDES_DIR: RAIZ } });
  assert.strictEqual(r.status, 0, r.stderr);
  const tabla = JSON.parse(r.stdout);
  assert.deepStrictEqual(tabla.exclusionesSinArchivo, [], 'ninguna exclusión del arnés queda sin su archivo');
  // las guías privadas por nombre de archivo, en guides/ o (desde la R5 de la 8.12) en guides/decisions/; las de
  // guides/bizuit/ van a su paquete, no son privadas
  const porNombre = tabla.coberturaExclusiones.filter((x) => x.fuente === 'arnes' && x.origen !== 'afuera-privado' && /^guides\/(?:decisions\/)?[^/]+\.md$/.test(x.glob));
  assert.ok(porNombre.length >= 3, `las tres guías privadas por nombre de archivo (hay ${porNombre.length})`);
  for (const x of porNombre) {
    assert.ok(x.archivos >= 1, `${x.origen} ${x.glob}: cubierta por su archivo real`);
    assert.strictEqual(x.reemplazos, 0, `${x.glob}: no por un reemplazo`);
  }
});

// ── T36 · story 8.12, AC 32 (tanda R5, primera red) — la guía protegida por su nombre de archivo, movida sin su glob ──
// El inventario de producción vive en `guides/decisions/` desde la R5 y la exclusión fija lo sigue. La red: si alguien lo
// mueve y deja el glob donde estaba (acá, el exportador con la línea de la fija de antes de la R5), con el reemplazo `.md`
// en la ruta vieja, el `--explain` lo delata y la exportación sale 2 con «exclusión fija sin archivo … — ¿se renombró?»:
// el reemplazo no cuenta como archivo (AC 4). Contenido de laboratorio, con un término de la denegación de laboratorio.
/** Una copia del exportador (y de las bibliotecas que carga) con la exclusión fija `nuevo` escrita como `viejo`. */
function exportadorConGlob(fx, nuevo, viejo) {
  const raiz = path.join(fx.dir, 'exportador-glob-viejo');
  for (const d of ['publishing', 'lib']) fs.cpSync(path.join(RAIZ, 'scripts', d), path.join(raiz, 'scripts', d), { recursive: true });
  const archivo = path.join(raiz, 'scripts', 'publishing', 'export.js');
  const fuente = fs.readFileSync(archivo, 'utf8');
  const literal = `glob: '${nuevo}'`;
  assert.strictEqual(fuente.split(literal).length - 1, 1, `export.js escribe la exclusión fija ${nuevo} una sola vez`);
  fs.writeFileSync(archivo, fuente.replace(literal, `glob: '${viejo}'`));
  return archivo;
}
function explicarCon(fx, exportador, extra = []) {
  return spawnSync(process.execPath, [exportador, '--explain', ...extra,
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
}

test('R5_Probe_MovedPrivateGuideWithoutGlob_Exit2 — el inventario movido a decisions/ con su reemplazo atrás y el glob viejo', () => {
  const fx = fixture();
  const fija = fijas().find((x) => x.fuente === 'arnes' && !x.clase && x.glob === 'guides/decisions/telemetria-produccion-inventario-*.md');
  assert.ok(fija, 'export.js protege el inventario de producción en su carpeta nueva, guides/decisions/ (AC 31)');
  const globViejo = fija.glob.replace('guides/decisions/', 'guides/');
  const nombre = 'telemetria-produccion-inventario-2099-01-01.md';
  const guia = `guides/decisions/${nombre}`;
  const reemplazo = `guides/${nombre}`;
  const marca = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js')).SHIM_MARK;
  escribir(fx.arnes, {
    [guia]: '# Inventario de laboratorio\n\nLos servidores de producción de AcmeCorp.\n',
    [reemplazo]: `Movida a [\`${guia}\`](decisions/${nombre}): este archivo queda en la ruta vieja hasta el retiro de los nombres viejos (story 8.9).\n<!-- ${marca} ${guia} -->\n`,
    // el reemplazo nace de su entrada en el mapa, como en el arnés real: sin ella saldría en la copia con un enlace a la
    // guía privada, que no sale (el control `links` de la story 8.7 lo frena)
    'scripts/lib/renames.json': `${JSON.stringify({ __about: 'mapa de laboratorio', retire_after: null, entries: [
      { kind: 'file', old: reemplazo, new: guia, batch: 'lab', callers: ['same-repo'] }] }, null, 2)}\n`,
  });
  commitear(fx.arnes, 'el inventario a decisions/, con su reemplazo en la ruta vieja');

  // con el glob viejo sin tocar: el --explain lo delata (el reemplazo se cuenta aparte, no como archivo)…
  const viejo = exportadorConGlob(fx, fija.glob, globViejo);
  let r = explicarCon(fx, viejo, ['--json']);
  assert.strictEqual(r.status, 0, `--explain --json informa, no frena: ${r.stderr}`);
  const tabla = JSON.parse(r.stdout);
  const fila = tabla.exclusionesSinArchivo.find((x) => x.origen === 'fija' && x.fuente === 'arnes' && x.glob === globViejo);
  assert.ok(fila, `el --explain delata la fija vieja sin archivo: ${JSON.stringify(tabla.exclusionesSinArchivo)}`);
  assert.deepStrictEqual([fila.archivos, fila.reemplazos], [0, 1], 'sólo queda su reemplazo, y no cuenta como archivo');
  r = explicarCon(fx, viejo);
  assert.match(r.stdout, /Exclusiones que ya no cubren ningún archivo[\s\S]*guides\/telemetria-produccion-inventario-\*\.md — sólo queda su reemplazo/, r.stdout);
  // …y la exportación sale 2 sin dejar copia ni temporales
  const salida = fx.salida('r5-viejo');
  r = spawnSync(process.execPath, [viejo, '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados,
    '--harness', 'HEAD', '--agent-skills', 'HEAD', '--package', 'core', '--output', salida],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
  assert.strictEqual(r.status, 2, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /exclusión fija sin archivo: arnes\/guides\/telemetria-produccion-inventario-\*\.md — ¿se renombró\? \(sólo queda su reemplazo\)/);
  assert.ok(!fs.existsSync(salida), 'sin copia');
  assert.deepStrictEqual(temporales(fx), []);

  // el exportador de verdad (la fija sigue a la guía): cubierta por su archivo, y la guía no viaja
  const tablaReal = explicarJson(fx);
  const real = tablaReal.coberturaExclusiones.find((x) => x.origen === 'fija' && x.fuente === 'arnes' && x.glob === fija.glob);
  assert.ok(real.archivos >= 1 && real.reemplazos === 0, `la fija nueva cubre la guía: ${JSON.stringify(real)}`);
  assert.ok(!tablaReal.exclusionesSinArchivo.some((x) => x.glob === fija.glob), 'ningún glob muerto');
  const buena = fx.salida('r5-real');
  const e = exportar(fx, ['--package', 'core', '--output', buena]);
  assert.strictEqual(e.code, 0, `${e.err}\n${e.out}`);
  assert.ok(!existe(buena, `arnes/${guia}`), 'el inventario no viaja');
});

// ── story 8.9, AC 19 + pregunta 10 (decisión del dueño, tanda C0) — entre repos, la ruta vieja se traduce en la copia ─
// agent-skills nombra guiones del arnés por su nombre viejo hasta el retiro (AC 1 d), y la copia sale de los dos repos
// juntos: sin traducir, el primer renombre que llama agent-skills dejaría la copia sin salir toda la transición. La ruta
// vieja que un repo nombra de SÍ MISMO sigue frenando.
test('BatchC0_CrossRepoOldPath_TranslatedInTheCopy', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'file', old: 'scripts/old-tool.js', new: 'scripts/tools/new-tool.js', batch: 'lab', callers: ['other-repo'] },
    { kind: 'folder', old: 'scripts/old-dir', new: 'scripts/nightly/new-dir', batch: 'lab', callers: ['other-repo'] },
  ] };
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'scripts/tools/new-tool.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/nightly/new-dir/x.js': "'use strict';\nmodule.exports = 2;\n",
  });
  escribir(fx.skills, { 'skills/tycon-pipeline/scripts/hook.sh': '#!/usr/bin/env bash\nnode "$TCG/scripts/old-tool.js" --check\nnode "${TCG}/scripts/old-dir/x.js"\n',
    // las otras dos formas de escribir la raíz del arnés (tanda C1): la de las skills y una variable de shell que se cierra
    'skills/tycon-pipeline/SKILL.md': '# Skill\n\nCorrer `node <arnés>/scripts/old-tool.js --repo x`.\n\n    node "${TYCON_GUIDES_DIR:-$HOME/.claude/x}/scripts/old-tool.js"\n' });
  commitear(fx.arnes, 'mudanza');
  commitear(fx.skills, 'nombra el viejo del arnés');
  const salida = fx.salida('c0-entre');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `entre repos no frena la copia\n${r.err}\n${r.out}`);
  const hook = leer(salida, 'agent-skills/skills/tycon-pipeline/scripts/hook.sh');
  assert.match(hook, /\$TCG\/scripts\/tools\/new-tool\.js" --check/, 'el archivo, al nombre nuevo');
  assert.match(hook, /\$\{TCG\}\/scripts\/nightly\/new-dir\/x\.js/, 'la carpeta, al nombre nuevo');
  assert.doesNotMatch(hook, /old-tool|old-dir/);
  const skill = leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.match(skill, /<arnés>\/scripts\/tools\/new-tool\.js --repo x/, 'la raíz escrita como <arnés>/');
  assert.match(skill, /\}\/scripts\/tools\/new-tool\.js"/, 'la raíz como variable de shell');
  assert.doesNotMatch(skill, /old-tool/);
  const informe = fs.readFileSync(`${path.resolve(salida)}.reemplazos.md`, 'utf8');
  assert.match(informe, /rutas-del-otro-repo/, 'el ajuste queda en el listado de la corrida');

  // la misma ruta vieja nombrada desde su propio repo sigue frenando
  escribir(fx.arnes, { 'scripts/usa-el-viejo.js': "'use strict';\n// node scripts/old-tool.js\nmodule.exports = 3;\n" });
  commitear(fx.arnes, 'el propio repo nombra el viejo');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('c0-mismo'), '--json']);
  assert.notStrictEqual(r.code, 0, `la ruta vieja del propio repo frena la copia\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.nombresViejos.map((h) => `${h.archivo}:${h.linea} ${h.ruta}`),
    ['arnes/scripts/usa-el-viejo.js:2 scripts/old-tool.js'], 'sólo el del propio repo es hallazgo; el del otro ya salió traducido');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T41 · story 8.12, AC 37 (tanda R6) — un nombre de la raíz que es también el de OTRO archivo (homónimo) ─────────────
// El nocturno de métricas del arnés y el pipeline de cada producto se llaman igual. En el propio repo, la entrada del mapa
// lista en `homonyms` los archivos donde el nombre es el del producto: ahí no frena; en cualquier otro, sí. Entre repos,
// el nombre suelto de un archivo de la raíz no se traduce ni frena (en agent-skills es el del producto), salvo detrás de
// la raíz del arnés escrita (`<arnés>/`, `$TCG/`…), que sí es el del arnés y se traduce.
test('T41 R6_Exporter_HomonymsAndBareRootNameAcrossRepos', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'file', old: 'lab-root.yml', new: 'pipelines/lab-root.yml', batch: 'lab', callers: ['ado', 'same-repo'],
      homonyms: [{ glob: 'scripts/product-note.js', reason: 'prueba: ahí es el yml del producto' },
        { glob: 'adapters/codex/agents-native/tycon-lab-reviewer.toml', reason: 'prueba: una traducción a Codex en la lista' }] },
  ] };
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'pipelines/lab-root.yml': 'trigger: none\n',
    'scripts/product-note.js': "'use strict';\n// cada producto tiene su lab-root.yml en la raíz\nmodule.exports = 1;\n",
    // la traducción a Codex de un agente de agent-skills es texto del otro repo: el nombre suelto ahí es el del producto
    'adapters/codex/agents/tycon-lab-reviewer.toml': 'name = "tycon-lab-reviewer"\ndeveloper_instructions = """\nMirá el lab-root.yml del producto.\n"""\n',
    // una traducción a Codex EN la lista de homonyms: sus globs se miran contra el repo donde vive el archivo (el arnés),
    // aunque su texto sea del otro repo — aun detrás de la raíz del arnés, ahí no frena
    'adapters/codex/agents-native/tycon-lab-reviewer.toml': 'name = "tycon-lab-reviewer"\ndeveloper_instructions = """\nComo `<arnés>/lab-root.yml`, el del producto.\n"""\n',
  });
  escribir(fx.skills, { 'skills/tycon-pipeline/SKILL.md': '# Skill\n\nEl `lab-root.yml` del producto dispara su build.\n\nEl del arnés: `<arnés>/lab-root.yml`.\n' });
  commitear(fx.arnes, 'mudanza a pipelines/');
  commitear(fx.skills, 'nombra los dos');
  const salida = fx.salida('r6-homonimos');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `el homónimo no frena la copia\n${r.err}\n${r.out}`);
  const skill = leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.match(skill, /El `lab-root\.yml` del producto/, 'el nombre suelto del otro repo no se traduce: es el del producto');
  assert.match(skill, /<arnés>\/pipelines\/lab-root\.yml/, 'detrás de la raíz del arnés sí es el del arnés: se traduce');
  assert.match(leer(salida, 'arnes/scripts/product-note.js'), /su lab-root\.yml en la raíz/, 'el archivo de homonyms sale igual');
  assert.match(leer(salida, 'arnes/adapters/codex/agents/tycon-lab-reviewer.toml'), /el lab-root\.yml del producto/, 'la traducción a Codex sale y no frena');
  assert.match(leer(salida, 'arnes/adapters/codex/agents-native/tycon-lab-reviewer.toml'), /`<arnés>\/lab-root\.yml`, el del producto/,
    'la traducción a Codex en homonyms sale tal cual: ni frena ni se traduce');

  // el mismo nombre suelto en un archivo del arnés que NO está en homonyms sigue frenando
  escribir(fx.arnes, { 'scripts/own-note.js': "'use strict';\n// el nocturno: lab-root.yml\nmodule.exports = 2;\n" });
  commitear(fx.arnes, 'el propio repo nombra el viejo fuera de la lista');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('r6-homonimos-2'), '--json']);
  assert.notStrictEqual(r.code, 0, `fuera de homonyms, frena\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.nombresViejos.map((h) => `${h.archivo}:${h.linea} ${h.ruta}`),
    ['arnes/scripts/own-note.js:2 lab-root.yml'], 'sólo el archivo fuera de la lista es hallazgo');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T19 · story 8.12, AC 16 (tanda R2) — el buzón de decisiones del equipo, `inbox/`, excluido por un glob fijo ──────
// La carpeta de los instintos pasa entera a `inbox/instincts/` (después llegaron `inbox/watcher/` e `inbox/dependencies/`,
// tanda F de la 8.9). La carpeta nueva de primer nivel queda clasificada en el mismo commit que la crea: `inbox/**` en
// EXCLUIDOS_SIEMPRE. Sin ese glob, la exportación sale 2 («sin clasificar»): el control que hace imposible olvidarlo.
// Su nombre de antes sale del mapa de renombres, nunca escrito acá (esta prueba también sale en la copia); sin mapa —la
// copia pública— esa verificación no se hace.
const BUZON_VIEJO = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const e = m.entries.find((x) => x && x.kind === 'folder' && x.new === 'inbox/instincts');
    return e ? e.old : null;
  } catch (_) {
    return null;
  }
})();
const BUZON = {
  'inbox/instincts/.gitignore': 'drafts/\n',
  'inbox/instincts/README.md': '# Instintos\n\nLo que el observador propone y el equipo decide.\n',
  'inbox/instincts/pending/instinto-1.json': '{ "id": "instinto-1", "estado": "pendiente" }\n',
  'inbox/instincts/archived/instinto-0.json': '{ "id": "instinto-0", "estado": "archivado" }\n',
};

test('T19 R2_Inbox_ExporterGlobAndFirstLevel — inbox/instincts/ excluida por el glob fijo inbox/**, --explain 0', () => {
  const fija = fijas().find((x) => x.fuente === 'arnes' && x.glob === 'inbox/**');
  assert.ok(fija, 'EXCLUIDOS_SIEMPRE tiene inbox/**');
  assert.ok(!fija.clase, 'inbox/** no es una clase: tiene que cubrir archivos (si se vacía, el --explain lo delata)');
  assert.match(fija.motivo, /buz[oó]n/i, 'el motivo dice que es el buzón de decisiones del equipo');
  if (BUZON_VIEJO) assert.ok(!fijas().some((x) => x.fuente === 'arnes' && x.glob === `${BUZON_VIEJO}/**`), 'el glob viejo se fue con la carpeta');

  const fx = fixture();
  escribir(fx.arnes, BUZON);
  commitear(fx.arnes, 'el buzón: inbox/instincts/');
  const tabla = explicarJson(fx);   // sale 0
  assert.deepStrictEqual(tabla.sinClasificar, [], 'inbox/ no queda sin clasificar');
  const fila = tabla.primerNivel.find((r) => r.fuente === 'arnes' && r.entrada === 'inbox');
  assert.ok(fila && fila.reglas.length, 'el primer nivel clasifica inbox/');
  const cob = tabla.coberturaExclusiones.find((x) => x.origen === 'fija' && x.fuente === 'arnes' && x.glob === 'inbox/**');
  assert.ok(cob && cob.archivos >= Object.keys(BUZON).length, `la exclusión cubre los archivos del buzón (${cob && cob.archivos})`);
  assert.deepStrictEqual(sinArchivo(tabla), []);

  const salida = fx.salida('t19');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(listar(path.join(salida, 'arnes')).filter((x) => x.startsWith('inbox/')), [], 'nada del buzón sale en la copia');
});

test('T19 R2_Inbox_ExporterGlobAndFirstLevel — sin el glob inbox/** la exportación sale 2 (entrada sin clasificar)', () => {
  const fx = fixture();
  escribir(fx.arnes, BUZON);
  commitear(fx.arnes, 'el buzón: inbox/instincts/');
  // el mismo exportador, con la línea de inbox/** quitada al cargarlo (nada se escribe en el exportador real)
  const gancho = path.join(fx.dir, 'sin-inbox.js');
  fs.writeFileSync(gancho, [
    "'use strict';",
    "const Module = require('module');",
    'const compilar = Module.prototype._compile;',
    `const OBJETIVO = ${JSON.stringify(EXPORTAR)};`,
    'Module.prototype._compile = function (codigo, archivo) {',
    '  if (archivo === OBJETIVO) {',
    "    const sin = codigo.split('\\n').filter((l) => !/glob: 'inbox\\/\\*\\*'/.test(l)).join('\\n');",
    "    if (sin === codigo) { process.stderr.write('GANCHO: el exportador no tiene la línea de inbox/**\\n'); process.exit(97); }",
    '    codigo = sin;',
    '  }',
    '  return compilar.call(this, codigo, archivo);',
    '};',
    '',
  ].join('\n'));
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('t19-sin')], { env: { NODE_OPTIONS: `--require ${gancho}` } });
  assert.notStrictEqual(r.code, 97, `el gancho no encontró la línea de inbox/** en el exportador\n${r.err}`);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /sin clasificar: arnes\/inbox/);
  assert.ok(!existe(fx.salida('t19-sin'), '.'), 'no quedó copia');
});

// ── story 8.9, tanda F — un árbol de ANTES de la mudanza, leído con el exportador de hoy (`--harness <commit viejo>`) ──
// La tanda F mudó cuatro carpetas y sus exclusiones siguieron al archivo. La del nocturno de dependencias vivía bajo un
// «in» (`scripts/**`): sin una exclusión por su ruta vieja, un árbol de antes de la mudanza dejaría salir en la copia la
// lista de repos del equipo. Queda excluida como «clase» (hoy esa carpeta sólo tiene reemplazos: no se le exige archivo)
// hasta el retiro del mapa. Las otras tres vivían en la raíz, fuera de todo «in»: un árbol viejo las trae como entradas
// del primer nivel sin clasificar y la exportación sale 2 sin escribir nada. La ruta vieja del nocturno sale del mapa de
// renombres, nunca escrita acá (esta prueba también sale en la copia).
// Cuándo se saltea: SÓLO si el archivo del mapa no está en el repo (la copia pública, que no lo lleva). Con el mapa en el
// repo, uno que no se deja leer, que no parsea o que no trae la entrada —o una variable que apunta el exportador a otro
// mapa— NO es «copia pública»: es justo el caso en que la exclusión se va en silencio, y la prueba falla diciendo por qué.
const MAPA_DEL_REPO = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
// el mapa que lee el exportador (scripts/lib/legacy-names.js): el de la variable si está, o el del repo
const MAPA_EN_USO = process.env.TYCON_LEGACY_NAMES_MAP || MAPA_DEL_REPO;
const SIN_MAPA = !fs.existsSync(MAPA_DEL_REPO) && 'NO MEDIDO — copia pública sin el mapa';
/** La carpeta vieja de una carpeta nueva, según el mapa que lee el exportador. Falla, con el motivo, si ese mapa no se
 *  deja leer, no parsea o no trae la mudanza. */
function carpetaViejaDe(nueva) {
  const cual = MAPA_EN_USO === MAPA_DEL_REPO ? 'el mapa de renombres del repo' : `el mapa al que apunta TYCON_LEGACY_NAMES_MAP (${MAPA_EN_USO})`;
  const sinEl = 'sin él, el exportador se queda sin la exclusión de la carpeta vieja y nadie lo ve';
  let texto;
  try { texto = fs.readFileSync(MAPA_EN_USO, 'utf8'); } catch (e) { assert.fail(`${cual} no se deja leer (${e.code || e.message}): ${sinEl}`); }
  let mapa;
  try { mapa = JSON.parse(texto); } catch (e) { assert.fail(`${cual} no parsea (${e.message}): ${sinEl}`); }
  const entradas = mapa && Array.isArray(mapa.entries) ? mapa.entries : [];
  const e = entradas.find((x) => x && x.kind === 'folder' && x.new === nueva);
  assert.ok(e && typeof e.old === 'string' && e.old.replace(/\/+$/, ''), `${cual} no trae la mudanza de la carpeta ${nueva} (kind: folder): ${sinEl}`);
  return e.old.replace(/\/+$/, '');
}

test('BatchF_OldTree_NightlyFolderStaysOut — la carpeta vieja del nocturno de dependencias no sale, aunque el árbol la traiga con sus .json', { skip: SIN_MAPA }, () => {
  const NOCTURNO_VIEJO = carpetaViejaDe('scripts/nightly/dependencies');
  const fx = fixture();
  // sin la carpeta vieja en el árbol (el de hoy): la exclusión no exige archivo
  assert.deepStrictEqual(sinArchivo(explicarJson(fx)), [], 'una clase no delata «exclusión sin archivo»');

  escribir(fx.arnes, {
    [`${NOCTURNO_VIEJO}/repos.json`]: '{ "repos": [{ "name": "lab-backend" }] }\n',
    [`${NOCTURNO_VIEJO}/tool.js`]: "'use strict';\nmodule.exports = 1;\n",
    'scripts/lab-neighbour/data.json': '{ "ok": true }\n',   // el testigo: un .json vecino bajo el mismo «in» sí sale
  });
  commitear(fx.arnes, 'un árbol de antes de la mudanza: la carpeta vieja del nocturno, con su lista de repos');
  const salida = fx.salida('f-viejo');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const copia = listar(path.join(salida, 'arnes'));
  assert.ok(copia.includes('scripts/lab-neighbour/data.json'), 'el testigo sale: `scripts/**` está en uso (si no, la prueba no mide nada)');
  assert.deepStrictEqual(copia.filter((x) => x.startsWith(`${NOCTURNO_VIEJO}/`)), [], 'nada de la carpeta vieja del nocturno sale en la copia');

  const fija = fijas().find((x) => x.fuente === 'arnes' && x.glob === `${NOCTURNO_VIEJO}/**`);
  assert.ok(fija, 'EXCLUIDOS_SIEMPRE tiene la carpeta vieja del nocturno');
  assert.strictEqual(fija.clase, true, 'como clase: hoy sólo quedan reemplazos ahí y no se le exige archivo');
  const nueva = fijas().find((x) => x.fuente === 'arnes' && x.glob === 'scripts/nightly/dependencies/**');
  assert.ok(nueva && !nueva.clase, 'la carpeta nueva sigue con su exclusión de verdad (la que exige archivo)');
  assert.strictEqual(fija.motivo, `${nueva.motivo}, con su nombre de antes de la story 8.9`, 'el motivo es el de la carpeta nueva, dicho como nombre viejo');
  assert.deepStrictEqual(sinArchivo(explicarJson(fx)), []);
});

// Las tres carpetas viejas de la raíz se arman por partes (enteras, este archivo —que sale en la copia— nombraría rutas
// viejas): así el caso corre también sin el mapa, en la copia pública. Con el mapa en el repo, además, cada una tiene que
// ser la que el mapa dice: si no, las partes de acá quedaron viejas (o el mapa está roto, y lo dice).
const RAIZ_VIEJAS = [
  ['inbox/dependencies', ['depend', 'encias'].join('')],
  ['inbox/watcher', ['vigil', 'ante'].join('')],
  ['onboarding/mini-class', ['mini', 'clase'].join('-')],
];

test('BatchF_OldTree_RootFoldersUnclassified — las tres carpetas viejas de la raíz no salen: un árbol que las trae sale 2 sin escribir nada', () => {
  for (const [nueva, vieja] of RAIZ_VIEJAS) {
    if (!SIN_MAPA) assert.strictEqual(carpetaViejaDe(nueva), vieja, `la carpeta vieja de ${nueva} según el mapa`);
    assert.ok(!fijas().some((x) => x.fuente === 'arnes' && (x.glob === `${vieja}/**` || x.glob.startsWith(`${vieja}/`))), `${vieja}: ninguna exclusión fija la nombra (no sale por estar sin clasificar)`);
    assert.ok(!LISTA_BASE.packages.core.arnes.in.some((g) => g === vieja || g.startsWith(`${vieja}/`)), 'ningún «in» la nombra');
    const fx = fixture();
    escribir(fx.arnes, { [`${vieja}/pending/lab-card.yaml`]: 'id: lab-card\nrepos: [lab-backend]\n' });
    commitear(fx.arnes, 'un árbol de antes de la mudanza: una carpeta vieja de la raíz');
    const salida = fx.salida(`f-raiz-${vieja}`);
    const r = exportar(fx, ['--package', 'core', '--output', salida]);
    assert.strictEqual(r.code, 2, `${vieja}: ${r.err}\n${r.out}`);
    assert.ok(r.err.includes(`sin clasificar: arnes/${vieja}`), `${vieja}: lo dice como entrada sin clasificar\n${r.err}`);
    assert.ok(!existe(salida, '.'), `${vieja}: no quedó copia`);
  }
});

// ── T45 · story 8.12, AC 41 (tanda R6) — los pipelines del equipo, `pipelines/`, excluidos por UN glob fijo ────────────
// Los seis yml de Azure DevOps pasan a `pipelines/` y su plantilla a `pipelines/templates/`: las dos exclusiones fijas de
// antes se vuelven una, `pipelines/**`, en el mismo commit que estrena la carpeta. Sin ese glob la exportación sale 2
// («sin clasificar»): un yml del equipo no puede viajar en la copia por olvido. Sus nombres de antes salen del mapa de
// renombres, nunca escritos acá (esta prueba también sale en la copia); sin mapa —la copia pública— esa parte no se mira.
const PIPES_VIEJOS = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    return m.entries.filter((x) => x && x.batch === 'R6' && /^pipelines(\/|$)/.test(String(x.new))).map((x) => String(x.old).replace(/\/+$/, ''));
  } catch (_) {
    return null;
  }
})();
const PIPES = {
  'pipelines/azure-pipelines-lab.yml': "trigger: none\nsteps:\n  - template: /pipelines/templates/plantilla-lab.yml\n",
  'pipelines/azure-pipelines-lab-noche.yml': "trigger: none\nschedules:\n  - cron: '0 5 * * *'\n    branches: { include: [main] }\n",
  'pipelines/templates/plantilla-lab.yml': 'parameters: []\nsteps: []\n',
  'pipelines/templates/README.md': '# Plantillas\n\nLo que trae los repos del equipo.\n',
};

test('T45 R6_ExplainAndNewNames — pipelines/ excluida por el glob fijo pipelines/**, --explain 0, nada sale en la copia', () => {
  const { coincide } = require(EXPORTAR);
  const fija = fijas().find((x) => x.fuente === 'arnes' && x.glob === 'pipelines/**');
  assert.ok(fija, 'EXCLUIDOS_SIEMPRE tiene pipelines/**');
  assert.ok(!fija.clase, 'pipelines/** no es una clase: tiene que cubrir archivos (si se vacía, el --explain lo delata)');
  assert.match(fija.motivo, /pipelines/i, 'el motivo dice que son los pipelines del equipo');
  if (PIPES_VIEJOS) {
    assert.ok(PIPES_VIEJOS.length >= 7, `el mapa trae los seis yml y la carpeta de plantillas (${PIPES_VIEJOS.join(', ')})`);
    // ninguna otra fija sigue cubriendo una ruta vieja: las dos de antes se fueron con los archivos (serían globs muertos)
    const muertas = [];
    for (const v of PIPES_VIEJOS) {
      for (const ruta of [v, `${v}/lab.yml`]) {
        for (const x of fijas()) if (x.fuente === 'arnes' && x.glob !== 'pipelines/**' && coincide(x.glob, ruta)) muertas.push(`${x.glob} cubre ${ruta}`);
      }
    }
    assert.deepStrictEqual(muertas, [], 'una exclusión fija de antes de la R6 quedó en el exportador');
  }

  const fx = fixture();
  escribir(fx.arnes, PIPES);
  commitear(fx.arnes, 'los pipelines: pipelines/ y pipelines/templates/');
  const tabla = explicarJson(fx);   // sale 0
  assert.deepStrictEqual(tabla.sinClasificar, [], 'pipelines/ no queda sin clasificar');
  const fila = tabla.primerNivel.find((r) => r.fuente === 'arnes' && r.entrada === 'pipelines');
  assert.ok(fila && fila.reglas.length, 'el primer nivel clasifica pipelines/');
  const cob = tabla.coberturaExclusiones.find((x) => x.origen === 'fija' && x.fuente === 'arnes' && x.glob === 'pipelines/**');
  assert.ok(cob && cob.archivos >= Object.keys(PIPES).length, `la exclusión cubre los yml y la plantilla (${cob && cob.archivos})`);
  assert.deepStrictEqual(sinArchivo(tabla), []);

  const salida = fx.salida('t45');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(listar(path.join(salida, 'arnes')).filter((x) => x.startsWith('pipelines/')), [], 'ningún yml del equipo sale en la copia');
});

test('T45 R6_ExplainAndNewNames — sin el glob pipelines/** la exportación sale 2 (entrada sin clasificar)', () => {
  const fx = fixture();
  escribir(fx.arnes, PIPES);
  commitear(fx.arnes, 'los pipelines: pipelines/ y pipelines/templates/');
  // el mismo exportador, con la línea de pipelines/** quitada al cargarlo (nada se escribe en el exportador real)
  const gancho = path.join(fx.dir, 'sin-pipelines.js');
  fs.writeFileSync(gancho, [
    "'use strict';",
    "const Module = require('module');",
    'const compilar = Module.prototype._compile;',
    `const OBJETIVO = ${JSON.stringify(EXPORTAR)};`,
    'Module.prototype._compile = function (codigo, archivo) {',
    '  if (archivo === OBJETIVO) {',
    "    const sin = codigo.split('\\n').filter((l) => !/glob: 'pipelines\\/\\*\\*'/.test(l)).join('\\n');",
    "    if (sin === codigo) { process.stderr.write('GANCHO: el exportador no tiene la línea de pipelines/**\\n'); process.exit(97); }",
    '    codigo = sin;',
    '  }',
    '  return compilar.call(this, codigo, archivo);',
    '};',
    '',
  ].join('\n'));
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('t45-sin')], { env: { NODE_OPTIONS: `--require ${gancho}` } });
  assert.notStrictEqual(r.code, 97, `el gancho no encontró la línea de pipelines/** en el exportador\n${r.err}`);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /sin clasificar: arnes\/pipelines/);
  assert.ok(!existe(fx.salida('t45-sin'), '.'), 'no quedó copia');
});

// ── T19b · story 8.12, tanda R2 — una carpeta vieja de UN solo pedazo es también una palabra común ─────────────────
// La de los instintos se llamaba como la palabra que usan la prosa y las descripciones de las skills («propone …»,
// «Revisar y accionar …»). Una carpeta así cuenta sólo escrita como ruta, con una barra detrás: la palabra suelta ni
// frena la copia ni se «traduce» a `inbox/…` en el otro repo. Nombre de laboratorio (`notions`): esta prueba también sale
// en la copia y no escribe el nombre viejo real.
test('T19b R2_SingleSegmentFolder_OnlyAsPath — la palabra suelta no frena ni se traduce; con barra detrás sí', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['same-repo'] },
  ] };
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'inbox/notions/README.md': '# Buzón de laboratorio\n',
    'scripts/prosa.js': "'use strict';\n// el grabador propone notions; las `notions` aceptadas se promueven\nmodule.exports = 1;\n",
  });
  escribir(fx.skills, { 'skills/tycon-pipeline/SKILL.md': '# Skill\n\nRevisar y accionar notions propuestas.\n\n    ls "$TCG/notions/pending/"\n' });
  commitear(fx.arnes, 'mudanza del buzón de laboratorio');
  commitear(fx.skills, 'nombra la palabra y la ruta vieja del arnés');
  const salida = fx.salida('t19b');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `la palabra suelta no frena la copia\n${r.err}\n${r.out}`);
  const skill = leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.match(skill, /Revisar y accionar notions propuestas\./, 'la palabra suelta del otro repo queda como está');
  assert.match(skill, /\$TCG\/inbox\/notions\/pending\//, 'la ruta vieja del otro repo, al nombre nuevo');
  assert.match(leer(salida, 'arnes/scripts/prosa.js'), /propone notions; las `notions` aceptadas/, 'la prosa del propio repo sale tal cual');

  // la carpeta vieja escrita como ruta desde su propio repo sigue frenando
  escribir(fx.arnes, { 'scripts/usa-la-vieja.js': "'use strict';\n// ls notions/pending/\nmodule.exports = 3;\n" });
  commitear(fx.arnes, 'el propio repo nombra la carpeta vieja');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t19b-mismo'), '--json']);
  assert.notStrictEqual(r.code, 0, `la ruta vieja del propio repo frena la copia\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.nombresViejos.map((h) => `${h.archivo}:${h.linea} ${h.ruta}`),
    ['arnes/scripts/usa-la-vieja.js:2 notions'], 'sólo la ruta con barra es hallazgo; la prosa no');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.9, tanda F · pase adversarial (clases 1 y 11) — la carpeta de un solo pedazo, nombrada desde el OTRO repo ──
// Con la barra detrás, una carpeta vieja de un solo pedazo se sigue escribiendo igual que otras cosas: «regla de <x>/config
// descartada» (prosa: «<x> o config») y las ramas de una cola, `<x>/<id>`. En su propio repo eso lo declara el mapa archivo
// por archivo (`homonyms`); en el otro repo no hay lista, y la copia salía 0 con la prosa de un revisor reescrita a la
// carpeta nueva. El criterio: en el otro repo esa carpeta se traduce —y cuenta como mención vieja— sólo si su entrada del
// mapa declara al otro repo como llamador (`callers` con `other-repo`); si no, sólo detrás de la raíz del arnés escrita
// (`$TCG/<x>/…`), que no deja dudas. Nombres de laboratorio (`ledgers`, `notions`), como en T19b.
test('BatchF_CrossRepo_SingleSegmentFolderNeedsDeclaredCaller — la prosa y las ramas del otro repo salen intactas; la ruta de verdad se traduce', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'folder', old: 'ledgers', new: 'inbox/ledgers', batch: 'lab', callers: ['docs', 'same-repo'] },          // nadie del otro repo la llama
    { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['other-repo', 'same-repo'] },   // el otro repo la llama
  ] };
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'inbox/ledgers/README.md': '# Una cola de laboratorio\n',
    'inbox/notions/README.md': '# Buzón de laboratorio\n',
  });
  escribir(fx.skills, { 'skills/tycon-pipeline/SKILL.md': [
    '# Skill', '',
    '- **regla de ledgers/config descartada.** La propuesta traía un aviso para un ledger o una config nuevos.',
    '',
    '    az repos pr list --source-branch ledgers/2026-10-02-lab-441f1b5b',
    '    git push origin ledgers/86f8ea97',
    '    ls "$TCG/ledgers/pending/"',
    '    ls notions/pending/',
    '',
  ].join('\n') });
  commitear(fx.arnes, 'dos mudanzas de laboratorio: una cola que el otro repo no llama y un buzón que sí');
  commitear(fx.skills, 'prosa y ramas con la palabra de la cola; una ruta de verdad a cada carpeta');
  const salida = fx.salida('f-otro-repo');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `ni la prosa ni las ramas frenan la copia\n${r.err}\n${r.out}`);
  const skill = leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.ok(skill.includes('regla de ledgers/config descartada.'), `la prosa del otro repo sale intacta\n${skill}`);
  assert.ok(skill.includes('--source-branch ledgers/2026-10-02-lab-441f1b5b'), `la rama de la cola sale intacta\n${skill}`);
  assert.ok(skill.includes('git push origin ledgers/86f8ea97'), `la rama de la cola sale intacta\n${skill}`);
  assert.ok(!skill.includes('inbox/ledgers/config') && !skill.includes('inbox/ledgers/2026') && !skill.includes('inbox/ledgers/86f8ea97'), `nada de eso se «traduce»\n${skill}`);
  assert.ok(skill.includes('ls "$TCG/inbox/ledgers/pending/"'), `detrás de la raíz del arnés es la carpeta: se traduce\n${skill}`);
  assert.ok(skill.includes('ls inbox/notions/pending/'), `la entrada que declara al otro repo como llamador se sigue traduciendo\n${skill}`);
  const ajuste = r.json.ajustes.filter((a) => a.transformacion === 'rutas-del-otro-repo' && a.archivo === 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.strictEqual(ajuste.length, 1, 'el ajuste queda en el listado de la corrida');
  assert.ok(ajuste[0].detalle.includes('ledgers → inbox/ledgers') && ajuste[0].detalle.includes('notions → inbox/notions'), ajuste[0].detalle);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T19c · story 8.12, tanda R2 · pase adversarial R2 (clases 6 y 7) — el exportador decide como --stale-mentions ──────
// Clase 6: una `\` DELANTE de la carpeta vieja de un solo pedazo es, como la `/`, parte de otra ruta (`scripts\<x>\`, la
// nueva `inbox\<x>\`): no es la vieja, ni frena la copia ni se «traduce» en el otro repo (antes se corrompía en
// `inbox\inbox/<x>\`). Detrás de la raíz del repo escrita a la Windows (`…\tycon-claude-guides\<x>\`) sí es la vieja.
// Clase 7: una `\` DETRÁS seguida de una letra de escape (`\n`, `\t`, `\b`, …) es un escape, no una barra de ruta;
// `\\` (la barra de Windows dentro de un string) sí lo es. Nombre de laboratorio (`notions`), como en T19b.
test('T19c R2Adversarial_ExporterBackslashBeforeAndEscapeAfter — adversarial R2: rutas nuevas a la Windows y escapes no son la vieja', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'folder', old: 'notions', new: 'inbox/notions', batch: 'lab', callers: ['same-repo'] },
  ] };
  const ajenas = [
    'Set-Location scripts\\notions\\',
    'Join-Path $TCG "inbox\\notions\\pending"',
    'C:\\src\\repo\\scripts\\notions\\x.js',
    'console.log("No hay notions\\n");',
    'echo "sin notions\\t(0)"',
    'const re = /notions\\b/;',
  ];
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'inbox/notions/README.md': '# Buzón de laboratorio\n',
    'scripts/notions/x.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/win-paths.js': `'use strict';\n${ajenas.map((l) => `// ${l}`).join('\n')}\nmodule.exports = 2;\n`,
  });
  const skill = `# Skill\n\n${ajenas.map((l) => `    ${l}`).join('\n')}\n`;
  escribir(fx.skills, { 'skills/tycon-pipeline/SKILL.md': skill });
  commitear(fx.arnes, 'mudanza del buzón de laboratorio');
  commitear(fx.skills, 'rutas a la Windows y escapes');
  const salida = fx.salida('t19c');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `ni la ruta nueva a la Windows ni un escape frenan la copia\n${r.err}\n${r.out}`);
  assert.strictEqual(leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md'), skill, 'en el otro repo no se «traduce» nada');

  // la vieja de verdad: suelta con «\» detrás, detrás de la raíz a la Windows, o con «\\» dentro de un string
  escribir(fx.arnes, { 'scripts/old-win.js': [
    "'use strict';",
    '// cd notions\\pending',
    '// C:\\src\\tycon-claude-guides\\notions\\pending\\',
    'const p = "notions\\\\pending";',
    'module.exports = p;',
    '',
  ].join('\n') });
  commitear(fx.arnes, 'el propio repo nombra la carpeta vieja a la Windows');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t19c-vieja'), '--json']);
  assert.notStrictEqual(r.code, 0, `la ruta vieja a la Windows frena la copia\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.nombresViejos.map((h) => `${h.archivo}:${h.linea} ${h.ruta}`),
    ['arnes/scripts/old-win.js:2 notions', 'arnes/scripts/old-win.js:3 notions', 'arnes/scripts/old-win.js:4 notions'],
    'sólo las tres rutas viejas; ninguna de win-paths.js');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T19f · story 8.12, tanda R3 · pase adversarial R3 — la raíz del arnés escrita como `<tcg>/` ────────────────────────
// Las skills y los agentes nombran la raíz del arnés con un marcador entre `<…>`: además de `<arnés>/`, `<tcg>/` (el
// capturador de la retro corre `node <tcg>/scripts/<viejo> --validate`). Sin reconocerlo, la ruta vieja del otro repo
// salía sin traducir en la copia pública, que no lleva reemplazos: un comando a un archivo que no existe. No vale
// cualquier `<…>/`: `<repo>/`, `<clon>/` o `<árbol>/` pueden ser el repo de un producto, con su propio `scripts/` —
// traducirlas sería inventar. Sólo los marcadores que nombran el arnés (o agent-skills). Nombres de laboratorio.
test('T19f R3Adversarial_CrossRepoOldPath_TcgPlaceholderRoot — adversarial R3: `<tcg>/` es la raíz del arnés; `<repo>/` no', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'file', old: 'scripts/lab-series.js', new: 'scripts/lib/lab-series.js', batch: 'lab', callers: ['other-repo'] },
  ] };
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'scripts/lib/lab-series.js': "'use strict';\nmodule.exports = 1;\n",
  });
  escribir(fx.skills, { 'skills/tycon-pipeline/SKILL.md': [
    '# Skill', '',
    '- Verificación: `node <tcg>/scripts/lab-series.js --validate`',
    '- En mayúsculas: `node <TCG>/scripts/lab-series.js`',
    '- Con el nombre del repo: `node <tycon-claude-guides>/scripts/lab-series.js`',
    '- El repo de un producto: `node <repo>/scripts/lab-series.js`',
    '',
  ].join('\n') });
  commitear(fx.arnes, 'mudanza a lib/');
  commitear(fx.skills, 'nombra el viejo del arnés con un marcador');
  const salida = fx.salida('t19f');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `entre repos no frena la copia\n${r.err}\n${r.out}`);
  const skill = leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.match(skill, /`node <tcg>\/scripts\/lib\/lab-series\.js --validate`/, '`<tcg>/`, al nombre nuevo');
  assert.match(skill, /`node <TCG>\/scripts\/lib\/lab-series\.js`/, '`<TCG>/`, al nombre nuevo');
  assert.match(skill, /`node <tycon-claude-guides>\/scripts\/lib\/lab-series\.js`/, '`<tycon-claude-guides>/`, al nombre nuevo');
  assert.match(skill, /`node <repo>\/scripts\/lab-series\.js`/, '`<repo>/` no es la raíz del arnés: queda como está');
  assert.deepStrictEqual(temporales(fx), []);
});

// T19g (pendiente DEF-8.12-R2-GIT-AMBIGUO, revisor de fallos silenciosos de la R2): en un 2 temprano, si el listado
// viejo cae dentro de un repo se deja; «no es un repo» lo borra. Un git que falla de verdad (acá, un .git/config roto)
// no es «no es un repo»: el listado se queda y el exportador dice el texto de git. Sin git en la máquina, lo de siempre
// (se borra), pero dicho.
test('T19g DEF812R2_GitFailsForReal_OldReportKeptAndSaid — un git roto no es «no es un repo»; sin git, se dice', () => {
  const fx = fixture();
  const LISTADO = '# Listado de reemplazos — PRIVADO: contiene los nombres reales, no se publica\n';
  // git falla de verdad: un repo de laboratorio con la configuración rota
  const roto = path.join(fx.dir, 'repo-roto');
  fs.mkdirSync(roto);
  gitFx(roto, ['init', '-q']);
  fs.appendFileSync(path.join(roto, '.git', 'config'), 'basura [[[\n');
  const enRoto = path.join(roto, 'listado-viejo.md');
  fs.writeFileSync(enRoto, LISTADO);
  const r = exportar(fx, ['--package', 'clients', '--output', fx.salida('t19g-roto'), '--report', enRoto]);
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(fs.existsSync(enRoto), 'un git que falla de verdad no es «no es un repo»: el listado no se borra en silencio');
  assert.match(r.err, /no pude armar la copia — no pude preguntarle a git si .*listado-viejo\.md.*bad config line/,
    'frena con el texto de git');
  // sin git en la máquina: se borra como hoy, pero lo dice
  const sinBin = path.join(fx.dir, 'bin-vacio');
  fs.mkdirSync(sinBin);
  const viejo = fx.salida('t19g-sin-git');
  fs.writeFileSync(`${viejo}.reemplazos.md`, LISTADO);
  const s = exportar(fx, ['--package', 'clients', '--output', viejo], { env: { PATH: sinBin } });
  assert.strictEqual(s.code, 2, s.err);
  assert.ok(!fs.existsSync(`${viejo}.reemplazos.md`), 'sin git: el listado fuera de un repo se borra, como hoy');
  assert.match(s.err, /git no está en esta máquina/, 'sin git: lo dice');
});

// ══ story 8.7, tanda A — los papeles y el repo único ════════════════════════════════════════════════════════════════
// Los marcadores de bloque se arman por partes: ninguna línea de este archivo es exactamente un marcador (el exportador
// frena un marcador solo en su línea fuera de un `.md`).
const MARCA = {
  IS: '<!-- tycon:' + 'internal-start -->',
  IE: '<!-- tycon:' + 'internal-end -->',
  PS: '<!-- tycon:' + 'public-only',
  PE: '-' + '->',
};
const CERCO = '`'.repeat(3);
const PAPELES = 'scripts/publishing/public-files';
// EL REPO PRIVADO ADELGAZADO (story 8.26, tanda I, 2026-10-13). Ahí las pruebas corren sobre el árbol armado: lo público
// llega encima, y con él los guiones de entrada y la lista de remotos en scripts/setup/. «En el interno no existe» no se
// puede cumplir, así que esas dos afirmaciones no se exigen cuando la lista del privado (.tycon/internal-forms.json) dice
// `layout: thin`; lo demás de cada caso (la plantilla, su declaración en la lista blanca) sí. Sin esa lista —el público,
// o un privado de antes— no cambia nada.
const THIN_PRIVATE = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, '.tycon', 'internal-forms.json'), 'utf8')).layout === 'thin'; } catch (_) { return false; }
})();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Los papeles dados (`{ destino: contenido }`) en public-files/ del arnés de mentira, cada uno con su sintético del núcleo. */
function conPapeles(fx, papeles, lista = clonar(LISTA_BASE)) {
  escribir(fx.arnes, Object.fromEntries(Object.entries(papeles).map(([t, c]) => [`${PAPELES}/${t}`, c])));
  if (!lista.packages.core.arnes.out.some((x) => x.glob === `${PAPELES}/**`)) {
    lista.packages.core.arnes.out.push({ glob: `${PAPELES}/**`, reason: 'los papeles llegan a su destino por un sintético' });
  }
  for (const t of Object.keys(papeles)) {
    if (!lista.synthetic.some((s) => s.target === t)) lista.synthetic.push({ target: t, from: `${PAPELES}/${t}`, packages: ['core'], reason: 'papel de prueba' });
  }
  return lista;
}
const ajustesDe = (json, transformacion) => json.ajustes.filter((a) => a.transformacion === transformacion).map((a) => a.archivo).sort();
function explicarTexto(fx) {
  const r = spawnSync(process.execPath, [EXPORTAR, '--explain',
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
  assert.strictEqual(r.status, 0, `--explain sale 0: ${r.stderr}`);
  return r.stdout;
}

// ── T1 · story 8.7, AC 9 — un sintético por paquete, y nunca pisando algo que sale ─────────────────────────────────────
test('Exportador_SinteticoPorPaquete', () => {
  const fx = fixture();
  const lista = conPapeles(fx, { 'PAPEL.md': '# Papel del núcleo\n' });
  lista.synthetic.unshift({ target: 'scripts/ci/pipeline-debt.json', from: 'scripts/publishing/synthetic/pipeline-debt.json', reason: 'como hoy' });
  fx.config({ lista });
  commitear(fx.arnes, 'un papel');
  // con `packages`, aplica en las exportaciones que incluyen alguno de ellos, sin mirar «in»
  const core = fx.salida('s1-core');
  let r = exportar(fx, ['--package', 'core', '--output', core, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(core, 'arnes/PAPEL.md'), '# Papel del núcleo\n');
  assert.ok(!existe(core, `arnes/${PAPELES}/PAPEL.md`), 'el papel no sale en su ruta');
  assert.strictEqual(leer(core, 'arnes/scripts/ci/pipeline-debt.json'), DEUDA_SINTETICA, 'pipeline-debt, como hoy');
  const biz = fx.salida('s1-bizuit');
  r = exportar(fx, ['--package', 'bizuit', '--output', biz, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!existe(biz, 'arnes/PAPEL.md'), 'un papel del núcleo no aplica exportando bizuit');
  assert.ok(!existe(biz, 'arnes/scripts/ci/pipeline-debt.json'), 'sin `packages`, la regla de hoy: ningún «in» de bizuit cubre el destino');

  // un destino que ya sale —de cualquiera de las dos fuentes— no se pisa en silencio: 2 nombrando la entrada
  ['skills/tycon-pipeline/SKILL.md', 'README.md'].forEach((target, i) => {
    const pisa = clonar(lista);
    pisa.synthetic.push({ target, from: `${PAPELES}/PAPEL.md`, packages: ['core'], reason: 'pisa (prueba)' });
    fx.config({ lista: pisa });
    const s = fx.salida(`s1-pisa-${i}`);
    const rr = exportar(fx, ['--package', 'core', '--output', s]);
    assert.strictEqual(rr.code, 2, `${target}: ${rr.err}\n${rr.out}`);
    assert.match(rr.err, new RegExp(`synthetic.*${escRe(target)}`), `${target}: nombra la entrada`);
    assert.ok(!fs.existsSync(s));
  });
  // un `from` que no existe, y un paquete que la lista no define (o el privado) en `packages`
  const casos = [
    ['from inexistente', { target: 'OTRO.md', from: `${PAPELES}/NO-ESTA.md`, packages: ['core'], reason: 'prueba' }, /NO-ESTA\.md/],
    ['paquete desconocido', { target: 'OTRO.md', from: `${PAPELES}/PAPEL.md`, packages: ['otro'], reason: 'prueba' }, /otro/],
    ['paquete privado', { target: 'OTRO.md', from: `${PAPELES}/PAPEL.md`, packages: ['clients'], reason: 'prueba' }, /clients/],
  ];
  casos.forEach(([nombre, sintetico, motivo], i) => {
    const mal = clonar(lista);
    mal.synthetic.push(sintetico);
    fx.config({ lista: mal });
    const s = fx.salida(`s1-mal-${i}`);
    const rr = exportar(fx, ['--package', 'core', '--output', s]);
    assert.strictEqual(rr.code, 2, `${nombre}: ${rr.err}\n${rr.out}`);
    assert.match(rr.err, motivo, nombre);
    assert.ok(!fs.existsSync(s));
  });
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T2 · story 8.7, AC 5 — bloques internos y sólo-públicos ─────────────────────────────────────────────────────────────
test('Exportador_BloquesInternosYPublicos', () => {
  const fx = fixture();
  const { IS, IE, PS, PE } = MARCA;
  escribir(fx.arnes, { 'guides/bloques.md': ['# Bloques', '', 'visible antes', IS, 'secreto del equipo', `${CERCO}bash`, 'echo interno', CERCO, IE,
    PS, 'texto sólo público', PE, 'visible después', ''].join('\n') });
  escribir(fx.skills, { 'skills/tycon-pipeline/notas.md': ['# Notas', IS, 'sólo del equipo', IE, 'fin', ''].join('\n') });
  commitear(fx.arnes, 'bloques');
  commitear(fx.skills, 'bloques');
  const s = fx.salida('s2');
  const r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(s, 'arnes/guides/bloques.md'), ['# Bloques', '', 'visible antes', 'texto sólo público', 'visible después', ''].join('\n'),
    'el interno se va con su cerco y sus marcadores; el sólo-público queda visible sin los suyos');
  assert.strictEqual(leer(s, 'agent-skills/skills/tycon-pipeline/notas.md'), '# Notas\nfin\n', 'también en agent-skills');
  assert.deepStrictEqual(ajustesDe(r.json, 'internal-blocks'), ['agent-skills/skills/tycon-pipeline/notas.md', 'arnes/guides/bloques.md']);
  assert.match(fs.readFileSync(`${s}.reemplazos.md`, 'utf8'), /arnes\/guides\/bloques\.md · internal-blocks/, 'el listado los nombra');
  assert.ok(fs.existsSync(path.join(fx.arnes, 'guides', 'bloques.md')) && fs.readFileSync(path.join(fx.arnes, 'guides', 'bloques.md'), 'utf8').includes('secreto del equipo'),
    'adentro no cambia nada');

  // los marcadores mal puestos: 2 con archivo y línea, sin copia
  const casos = [
    ['sin cierre', 'guides/mal.md', ['# Mal', '', IS, 'x'], 3],
    ['anidado', 'guides/mal.md', ['# Mal', IS, 'a', IS, 'b', IE, IE], 4],
    ['dentro de un cerco', 'guides/mal.md', ['# Mal', CERCO, IS, 'x', IE, CERCO], 3],
    ['entre dos filas de una tabla', 'guides/mal.md', ['| a | b |', '|---|---|', IS, '| c | d |', IE, '| e | f |'], 3],
    ['fuera de un .md', 'scripts/marca.js', ["'use strict';", '/*', IS, '*/', 'module.exports = 1;'], 3],
  ];
  casos.forEach(([nombre, archivo, lineas, linea], i) => {
    escribir(fx.arnes, { [archivo]: `${lineas.join('\n')}\n` });
    commitear(fx.arnes, nombre);
    const m = fx.salida(`s2-mal-${i}`);
    const rr = exportar(fx, ['--package', 'core', '--output', m]);
    assert.strictEqual(rr.code, 2, `${nombre}: exit 2\n${rr.err}\n${rr.out}`);
    assert.match(rr.err, new RegExp(`${escRe(archivo)}:${linea}\\b`), `${nombre}: nombra archivo y línea`);
    assert.ok(!fs.existsSync(m), `${nombre}: sin copia`);
    escribir(fx.arnes, { [archivo]: null });
    commitear(fx.arnes, `sin ${nombre}`);
  });
  assert.match(explicarTexto(fx), /internal-blocks/, '--explain lista la transformación');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.10.2, AC 1 — el bloque con la marca mal escrita, por el camino REAL del exportador ─────────────────────────
// El pase adversarial de la 8.10.1 (causa 1): el armado salteaba todo archivo sin el texto literal «tycon:» antes de
// mirar sus marcadores, así que la misma errata en la apertura y en el cierre dejaba salir el bloque entero con exit 0.
// La prueba de la 8.10.1 llamaba a la función de adentro y no pasaba por ese filtro: por eso daba verde.
test('Exportador_BloqueInternoConLaMarcaMalEscrita_Frena', () => {
  const fx = fixture();
  const abrir = '<' + '!--';
  const cerrar = '--' + '>';
  const variantes = {
    'dos guiones bajos': 'tycon__internal',
    'un punto': 'tycon.internal',
    'una barra': 'tycon/internal',
    'la primera palabra mal escrita': 'tycom:internal',
    'sin la primera palabra': 'internal',
    'en mayúsculas': 'TYCON:INTERNAL',
    'un espacio en vez de los dos puntos': 'tycon internal',
  };
  let i = 0;
  for (const [nombre, cuerpo] of Object.entries(variantes)) {
    for (const archivo of ['guides/errata.md', 'scripts/errata.sh']) {
      const lineas = archivo.endsWith('.md')
        ? ['# Errata', '', 'Público.', `${abrir} ${cuerpo}-start ${cerrar}`, 'SECRETO del equipo', `${abrir} ${cuerpo}-end ${cerrar}`, 'Fin.']
        : ['#!/bin/bash', `# ${abrir} ${cuerpo}-start ${cerrar}`, 'echo SECRETO del equipo', `# ${abrir} ${cuerpo}-end ${cerrar}`];
      escribir(fx.arnes, { [archivo]: `${lineas.join('\n')}\n` });
      commitear(fx.arnes, `${nombre} en ${archivo}`);
      const m = fx.salida(`errata-${i++}`);
      const r = exportar(fx, ['--package', 'core', '--output', m]);
      assert.strictEqual(r.code, 2, `${nombre} (${archivo}): la misma errata en los dos marcadores frena con 2\n${r.err}\n${r.out}`);
      const linea = archivo.endsWith('.md') ? 4 : 2;
      assert.match(r.err, new RegExp(`${escRe(archivo)}:${linea}\\b`), `${nombre} (${archivo}): nombra archivo y línea`);
      assert.ok(!fs.existsSync(m), `${nombre} (${archivo}): sin copia`);
      escribir(fx.arnes, { [archivo]: null });
      commitear(fx.arnes, `sin ${nombre} en ${archivo}`);
    }
  }
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T3 · story 8.7, AC 6 — enlaces relativos rotos ──────────────────────────────────────────────────────────────────────
test('Exportador_EnlacesRotos_Hallazgo', () => {
  const fx = fixture();
  const lista = clonar(LISTA_BASE);
  lista.synthetic = [{ target: 'scripts/ci/pipeline-debt.json', from: 'scripts/publishing/synthetic/pipeline-debt.json', reason: 'como hoy' }];
  fx.config({ lista });
  escribir(fx.arnes, { 'guides/enlaces.md': ['# Enlaces', '', 'ver [el plan](../tasks/plan.md)', `${CERCO}md`, '[en código](../tasks/plan.md)', CERCO,
    'la [deuda](../scripts/ci/pipeline-debt.json) y [afuera](https://example.com/tasks/plan.md)',
    // en la copia de dos repos, el hermano resuelve (plan §5.1)
    'la [skill](../../agent-skills/skills/tycon-pipeline/SKILL.md)', ''].join('\n') });
  commitear(fx.arnes, 'enlaces');
  const s = fx.salida('s3');
  const r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.links.map((h) => `${h.file}:${h.line} ${h.target}`), ['arnes/guides/enlaces.md:3 ../tasks/plan.md'],
    'sólo el enlace a lo que no sale; ni el del cerco, ni el sintético, ni el https://, ni el del repo hermano');
  assert.ok(!fs.existsSync(s), 'con un hallazgo no hay copia');
  const h = exportar(fx, ['--package', 'core', '--output', fx.salida('s3-humano')]);
  assert.strictEqual(h.code, 1, h.err);
  assert.match(h.out, /arnes\/guides\/enlaces\.md:3 .*\.\.\/tasks\/plan\.md/, 'el informe nombra archivo, línea y destino');
  assert.match(explicarTexto(fx), /\blinks\b/, '--explain lista el control');

  // bizuit solo: un enlace a algo que no sale no cuenta (decisión 13 del coordinador: el paquete solo es una capa sobre el
  // núcleo, no se publica suelto; los controles de la copia corren cuando la exportación incluye core)
  escribir(fx.arnes, { 'guides/bizuit/bizuit-plugin.md': '# Plugins de Bizuit\n\nVer el [caso](../incident-log.md#caso).\n' });
  commitear(fx.arnes, 'la guía del paquete enlaza el incident-log');
  const b = fx.salida('s3-bizuit');
  const rb = exportar(fx, ['--package', 'bizuit', '--output', b, '--json']);
  assert.strictEqual(rb.code, 0, `bizuit solo: el enlace no cuenta\n${rb.err}\n${rb.out}`);
  assert.ok(!('links' in rb.json.controles), 'sin el control: no corrió');
  assert.match(leer(b, 'arnes/guides/bizuit/bizuit-plugin.md'), /incident-log\.md/);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T4 · story 8.7, AC 2 — el NOTICE contra los `derived` del manifiesto ────────────────────────────────────────────────
test('Exportador_Atribuciones_ContraElManifiesto', () => {
  const fx = fixture();
  const derivada = (target, why) => ({ target, repo: 'tycon-claude-guides', based_on: { origin: 'https://example.com/ecc' }, license: 'MIT',
    license_source: 'LICENSE del origen', copyright: 'Copyright (c) 2026 Example', used_by: [], why });
  const manifiesto = { __doc: 'terceros de mentira', own: [{ glob: 'skills/tycon-*', why: 'del equipo' }],
    derived: [derivada('guides/guia.md', 'sale en la copia'), derivada('scripts/no-sale.js', 'no sale en la copia')], origins: {}, third_party: [] };
  escribir(fx.arnes, { 'scripts/publishing/third-party-skills.json': `${JSON.stringify(manifiesto, null, 2)}\n` });
  const notice = (...atribuciones) => ['Producto de mentira', 'Copyright 2026 TYCON', '', 'Atribuciones:', '', ...atribuciones, ''].join('\n');
  const correr = (nombre, texto) => {
    fx.config({ lista: conPapeles(fx, { NOTICE: texto }) });
    commitear(fx.arnes, nombre);
    return exportar(fx, ['--package', 'core', '--output', fx.salida(nombre), '--json']);
  };
  let r = correr('s4-falta', notice());
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.attributions.map((x) => x.path), ['guides/guia.md'], 'el que sale y el NOTICE no nombra');
  r = correr('s4-sobra', notice('* guides/guia.md — Example, MIT', '* scripts/no-sale.js — Example, MIT'));
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.attributions.map((x) => x.path), ['scripts/no-sale.js'], 'el que el NOTICE nombra y no sale');
  r = correr('s4-bien', notice('* guides/guia.md — Example, MIT'));
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.attributions, []);
  assert.match(leer(fx.salida('s4-bien'), 'arnes/NOTICE'), /^\* guides\/guia\.md/m);
  assert.match(explicarTexto(fx), /\battributions\b/, '--explain lista el control');
});

// ── T5 · story 8.7, AC 8 — la unión de paquetes, con los revisores enteros ──────────────────────────────────────────────
test('Exportador_UnionDePaquetes_RevisoresEnteros', () => {
  const fx = fixture();
  const lista = clonar(LISTA_BASE);
  // el paquete del stack ya no espera a otra story (AC 7): sin `until`, la unión no tiene pendientes
  lista.packages.bizuit['agent-skills'] = { in: ['packs/bizuit/pack.json', 'agents/tycon-plugin-dotnet-conventions.md'], out: [] };
  lista.packages.otra = { arnes: { in: ['guides/guia.md'], out: [] } };
  fx.config({ lista });
  const A = 'tycon-plugin-dotnet-conventions';
  const u = fx.salida('s5-union');
  let r = exportar(fx, ['--package', 'core,bizuit', '--output', u, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.paquete, 'core,bizuit');
  assert.deepStrictEqual(r.json.pendientes, [], 'la unión no deja nada pendiente');
  for (const s of [`agent-skills/agents/${A}.md`, `arnes/adapters/codex/agents/${A}.toml`, `arnes/adapters/codex/agents-native/${A}.toml`,
    `arnes/scripts/controls-bench/cases/advisors/${A}.json`, 'agent-skills/packs/bizuit/pack.json', 'arnes/guides/bizuit/bizuit-plugin.md']) {
    assert.ok(existe(u, s), `la unión trae ${s}`);
  }
  assert.strictEqual(leer(u, 'arnes/adapters/codex/agents/MANIFEST.json'), `${JSON.stringify({ advisors: ['revisor-nucleo', A] }, null, 2)}\n`);
  const base = JSON.parse(leer(u, 'arnes/scripts/controls-bench/baseline/claude-advisors.json')).cases;
  assert.deepStrictEqual(Object.keys(base).sort(), ['revisor-nucleo::caso-1', 'revisor-nucleo::limpio', `${A}::caso-1`].sort());
  assert.match(leer(u, 'arnes/guides/advisor-rules-catalog.md'), /DOTNET-C1/, 'la sección del revisor del stack está');
  assert.doesNotMatch(leer(u, 'arnes/guides/advisor-rules-catalog.md'), /XPAT-C1/, 'la del de clientes, no');
  assert.ok(!listar(u).some((p) => p.includes('revisor-cliente') || p.includes('packs/clients')), 'nada de clientes');
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-union-'));
  const chk = spawnSync(process.execPath, [path.join(u, 'arnes', 'build', 'generate.js'), '--check'], {
    encoding: 'utf8',
    env: { ...sinGit(process.env), TYCON_AGENTS_DIR: path.join(u, 'agent-skills', 'agents'), HOME: aux, CODEX_HOME: path.join(aux, 'codex') },
  });
  fs.rmSync(aux, { recursive: true, force: true });
  assert.strictEqual(chk.status, 0, `generate.js --check en la unión: ${chk.stderr}`);

  // el orden de la lista no cambia el commit
  const v = fx.salida('s5-al-reves');
  const r2 = exportar(fx, ['--package', 'bizuit,core', '--output', v, '--json']);
  assert.strictEqual(r2.code, 0, `${r2.err}\n${r2.out}`);
  assert.deepStrictEqual(r2.json.repos, r.json.repos, 'bizuit,core da el mismo HEAD que core,bizuit');
  // con el mapa de renombres, cada elemento pasa por el alias de nombres viejos
  const viejoCore = (() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
      const e = m.entries.find((x) => x && x.kind === 'value' && x.new === 'core' && x.where === 'scripts/publishing/export.js');
      return e ? e.old : null;
    } catch (_) { return null; }
  })();
  if (viejoCore) {
    const r3 = exportar(fx, ['--package', `${viejoCore},bizuit`, '--output', fx.salida('s5-viejo'), '--json']);
    assert.strictEqual(r3.code, 0, `${r3.err}\n${r3.out}`);
    assert.deepStrictEqual(r3.json.repos, r.json.repos, 'el nombre viejo del núcleo, en la lista, es la misma unión');
  }
  // sin core, con clients, con un paquete desconocido o con un elemento vacío: 2
  [['core,clients', /clients/], ['core,otro-mas', /otro-mas/], ['bizuit,otra', /core/], ['core,', /vac/]].forEach(([arg, motivo], i) => {
    const s = fx.salida(`s5-mal-${i}`);
    const rr = exportar(fx, ['--package', arg, '--output', s]);
    assert.strictEqual(rr.code, 2, `${arg}: ${rr.err}\n${rr.out}`);
    assert.match(rr.err, motivo, arg);
    assert.ok(!fs.existsSync(s));
  });
  // bizuit solo, como hoy: sus superficies del arnés quedan pendientes de la unión
  const b = fx.salida('s5-bizuit');
  r = exportar(fx, ['--package', 'bizuit', '--output', b, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!existe(b, `arnes/adapters/codex/agents/${A}.toml`));
  assert.ok(r.json.pendientes.some((p) => p.ruta === `arnes/adapters/codex/agents/${A}.toml` && p.hasta === 'core,bizuit'), JSON.stringify(r.json.pendientes));
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T6 · story 8.7, AC 10 — una skill publicada con otro nombre, con su lista cerrada de excepciones ─────────────────────
test('Exportador_SkillRenombrada_ConSusExcepciones', () => {
  const fx = fixture();
  const VIEJA = 'vendor-make-story';
  const NUEVA = 'tycon-make-story';
  const aviso = `# Aviso\n\nBasada en ${VIEJA} de Vendor; adentro conserva el nombre.\n`;
  const licencia = `MIT License\n\nCopyright (c) 2025 Vendor (${VIEJA})\n`;
  escribir(fx.skills, {
    [`skills/${VIEJA}/SKILL.md`]: `---\nname: ${VIEJA}\ndescription: Arma una story\n---\n\nUsala como \`${VIEJA}\`.\n`,
    [`skills/${VIEJA}/NOTICE.md`]: aviso,
    [`skills/${VIEJA}/LICENSE`]: licencia,
    'skills/tycon-pipeline/scripts/usa.js': `'use strict';\nmodule.exports = { skill: '${VIEJA}' };\n`,
    'agents/revisor-nucleo.md': agente('revisor-nucleo', `Revisa el núcleo; la story la arma ${VIEJA}.`),
  });
  commitear(fx.skills, 'la skill de un tercero');
  regenerarCodex(fx.arnes, fx.skills);
  const derivada = { target: `skills/${VIEJA}`, repo: 'agent-skills', based_on: { origin: 'https://example.com/vendor', path: `src/${VIEJA}` },
    license: 'MIT', license_source: `LICENSE de ${VIEJA}`, copyright: 'Copyright (c) 2025 Vendor', used_by: ['tycon-pipeline'], why: `${VIEJA} con cambios del equipo` };
  escribir(fx.arnes, {
    'scripts/publishing/third-party-skills.json': `${JSON.stringify({ __doc: 'terceros de mentira', own: [], derived: [derivada], origins: {}, third_party: [] }, null, 2)}\n`,
    'scripts/controls-bench/cases/hooks/29-story-gate.json': `${JSON.stringify({ hook: 'story-gate.js', cases: [{ id: 'skill', skill: VIEJA }] }, null, 2)}\n`,
  });
  const WHY = `publicada como \`${NUEVA}\`: la política de marca del tercero pide otro nombre`;
  const notice = `Producto de mentira\n\nAtribuciones:\n\n* skills/${NUEVA} — basada en ${VIEJA} de Vendor, MIT\n`;
  const lista = conPapeles(fx, { NOTICE: notice });
  lista.packages.core['agent-skills'].in.push(`skills/${VIEJA}/**`);
  lista.skillRenames = [{ source: 'agent-skills', from: `skills/${VIEJA}`, to: `skills/${NUEVA}`, why: WHY, reason: 'prueba' }];
  fx.config({ lista });
  commitear(fx.arnes, 'el manifiesto, el caso del banco y el NOTICE');
  assert.match(fs.readFileSync(path.join(fx.arnes, 'adapters/codex/agents/revisor-nucleo.toml'), 'utf8'), new RegExp(VIEJA), 'control: adentro la traducción la nombra');

  const s = fx.salida('s6');
  let r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!listar(s).some((p) => p.includes(`skills/${VIEJA}/`)), 'la carpeta vieja no está');
  assert.match(leer(s, `agent-skills/skills/${NUEVA}/SKILL.md`), new RegExp(`^name: ${NUEVA}$`, 'm'));
  for (const p of [`agent-skills/skills/${NUEVA}/SKILL.md`, 'agent-skills/skills/tycon-pipeline/scripts/usa.js', 'agent-skills/agents/revisor-nucleo.md',
    'arnes/adapters/codex/agents/revisor-nucleo.toml', 'arnes/adapters/codex/agents-native/revisor-nucleo.toml', 'arnes/scripts/controls-bench/cases/hooks/29-story-gate.json']) {
    assert.match(leer(s, p), new RegExp(NUEVA), `${p}: con el nombre nuevo`);
    assert.doesNotMatch(leer(s, p), new RegExp(VIEJA), `${p}: sin el viejo`);
  }
  assert.strictEqual(leer(s, 'arnes/NOTICE'), notice, 'el NOTICE, intacto');
  assert.strictEqual(leer(s, `agent-skills/skills/${NUEVA}/NOTICE.md`), aviso, 'el NOTICE.md de la carpeta, intacto');
  assert.strictEqual(leer(s, `agent-skills/skills/${NUEVA}/LICENSE`), licencia, 'el LICENSE de la carpeta, intacto');
  const m = JSON.parse(leer(s, 'arnes/scripts/publishing/third-party-skills.json'));
  assert.deepStrictEqual(m.derived[0].based_on, derivada.based_on, 'based_on describe el origen: intacto');
  assert.strictEqual(m.derived[0].license_source, derivada.license_source, 'license_source, intacto');
  assert.strictEqual(m.derived[0].why, WHY, 'el why pasa al texto fijo');
  assert.strictEqual(m.derived[0].target, `skills/${NUEVA}`);
  assert.deepStrictEqual(r.json.renamed, [{ from: `skills/${VIEJA}`, to: `skills/${NUEVA}` }]);
  const renombrados = ajustesDe(r.json, 'skill-rename');
  for (const p of [`agent-skills/skills/${VIEJA}/SKILL.md`, 'agent-skills/skills/tycon-pipeline/scripts/usa.js', 'agent-skills/agents/revisor-nucleo.md',
    'arnes/scripts/controls-bench/cases/hooks/29-story-gate.json', 'arnes/scripts/publishing/third-party-skills.json']) {
    assert.ok(renombrados.includes(p), `ajuste skill-rename en ${p}: ${renombrados.join(', ')}`);
  }
  assert.ok(fs.existsSync(path.join(fx.skills, 'skills', VIEJA, 'SKILL.md')), 'adentro no cambia nada');
  // la regla, tal como queda en la lista blanca de la copia (que también sale renombrada): `from` igual a `to`, no hace nada
  const enLaCopia = clonar(lista);
  enLaCopia.skillRenames = [{ ...lista.skillRenames[0], from: `skills/${NUEVA}` }];
  assert.doesNotThrow(() => require(EXPORTAR).validarLista(enLaCopia, 'la lista de la copia'));

  // una mención que la transformación no alcanza (un papel se pone después): 1 nombrando archivo y línea
  fx.config({ lista: conPapeles(fx, { '.github/README.md': `# Portada\n\nLa story la arma ${VIEJA}.\n` }, lista) });
  commitear(fx.arnes, 'un papel con el nombre viejo');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('s6-queda'), '--json']);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.skillRenameLeft.map((h) => `${h.file}:${h.line}`), ['arnes/.github/README.md:3']);
  assert.match(explicarTexto(fx), /skill-rename[\s\S]*skillRenameLeft|skillRenameLeft[\s\S]*skill-rename/, '--explain lista la transformación y su control');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T7 · story 8.7, AC 11 — un solo repo con las dos fuentes desde la raíz ─────────────────────────────────────────────
test('Exportador_UnSoloRepo_FuentesJuntas', () => {
  const fx = fixture();
  const HOOK_ARNES = ['#!/usr/bin/env bash', '# pre-commit de mentira del arnés: sale 0 temprano si el commit no toca algo suyo',
    'echo "arnes" >> "${HOOK_LOG:-/dev/null}"',
    "git diff --cached --name-only | grep -qE '^(scripts|guides)/' || exit 0", 'exit 0', ''].join('\n');
  const HOOK_SKILLS = ['#!/usr/bin/env bash', '# pre-commit de mentira de agent-skills: rechaza un .sh de skills/ que diga RECHAZAR',
    'echo "skills ${TYCON_SKILLS_DIR:-} ${TYCON_GUIDES_DIR:-}" >> "${HOOK_LOG:-/dev/null}"',
    "for f in $(git diff --cached --name-only -- 'skills/*.sh'); do",
    '  if grep -q RECHAZAR "$f"; then echo "pre-commit de agent-skills: $f rechazado" >&2; exit 1; fi',
    'done', 'exit 0', ''].join('\n');
  escribir(fx.arnes, { '.githooks/pre-commit': HOOK_ARNES });
  escribir(fx.skills, { '.githooks/pre-commit': HOOK_SKILLS, '.gitignore': 'node_modules/\ndist/\n' });
  fs.chmodSync(path.join(fx.arnes, '.githooks', 'pre-commit'), 0o755);
  fs.chmodSync(path.join(fx.skills, '.githooks', 'pre-commit'), 0o755);
  commitear(fx.arnes, 'hook');
  commitear(fx.skills, 'hook e ignore');
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.in.push('.githooks/**');
  lista.packages.core['agent-skills'].in.push('.githooks/**');
  fx.config({ lista });

  const s = fx.salida('s7');
  const r = exportar(fx, ['--package', 'core', '--single-repo', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(Object.keys(r.json.repos), [PUBLICO.repo], '`repos` trae uno solo, con el nombre público');
  assert.strictEqual(gitFx(s, ['rev-list', '--count', 'HEAD']), '1', 'un commit');
  assert.strictEqual(gitFx(s, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  assert.strictEqual(gitFx(s, ['rev-parse', 'HEAD']), r.json.repos[PUBLICO.repo].commit);
  const meta = gitFx(s, ['cat-file', '-p', 'HEAD']);
  assert.ok(meta.includes(r.json.fuentes.arnes.sha) && meta.includes(r.json.fuentes['agent-skills'].sha), 'el mensaje cita los dos shas');
  for (const p of ['README.md', 'scripts/hola.js', 'adapters/codex/agents/MANIFEST.json', 'agents/revisor-nucleo.md', 'skills/tycon-pipeline/SKILL.md']) {
    assert.ok(existe(s, p), `${p}, desde la raíz`);
  }
  assert.ok(!existe(s, 'arnes') && !existe(s, 'agent-skills'), 'sin una carpeta por fuente');
  // (después de esas líneas va el bloque de las carpetas de las que no sale nada —story 8.26—: lo mide su prueba, T83)
  const ignorado = splitPrivateBlock(leer(s, '.gitignore'));
  assert.strictEqual(ignorado.own, 'node_modules/\n*.log\ndist/\n', 'las líneas de los dos, primero las del arnés, sin repetir');
  assert.ok(ignorado.folders.length > 0 && ignorado.folders.every((l) => /^\/[^/]+\/$/.test(l)), `y después, sólo carpetas de la raíz: ${ignorado.folders.join(' ')}`);
  for (const h of ['.githooks/pre-commit', '.githooks/pre-commit-harness', '.githooks/pre-commit-skills']) {
    assert.ok(fs.statSync(path.join(s, h)).mode & 0o100, `${h} ejecutable`);
  }
  assert.strictEqual(leer(s, '.githooks/pre-commit-harness'), HOOK_ARNES);
  assert.strictEqual(leer(s, '.githooks/pre-commit-skills'), HOOK_SKILLS);
  assert.deepStrictEqual(ajustesDe(r.json, 'merged-gitignore'), ['agent-skills/.gitignore', 'arnes/.gitignore']);
  assert.deepStrictEqual(ajustesDe(r.json, 'merged-hooks'), ['.githooks/pre-commit', 'agent-skills/.githooks/pre-commit', 'arnes/.githooks/pre-commit']);
  assert.strictEqual(r.json.detector[PUBLICO.repo].archivos, listar(s).length, 'el detector miró cada archivo del repo, ni uno menos');
  assert.strictEqual(r.json.detector[PUBLICO.repo].excluidos, 0);
  // dos corridas iguales: el mismo HEAD
  const s2 = fx.salida('s7-otra');
  const r2 = exportar(fx, ['--package', 'core', '--single-repo', '--output', s2, '--json']);
  assert.strictEqual(r2.code, 0, `${r2.err}\n${r2.out}`);
  assert.strictEqual(gitFx(s2, ['rev-parse', 'HEAD']), gitFx(s, ['rev-parse', 'HEAD']));

  // el despachador corre los dos, cada uno en su proceso: el del arnés sale 0 temprano y el de agent-skills igual corre
  const log = path.join(fx.dir, 'hooks.log');
  const gitHooks = (args) => spawnSync('git', ['-C', s, '-c', 'core.hooksPath=.githooks', ...args], {
    encoding: 'utf8',
    env: { ...sinGit(process.env), ...GIT_AISLADO, HOOK_LOG: log, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' },
  });
  escribir(s, { 'skills/tycon-pipeline/malo.sh': '#!/bin/bash\n# RECHAZAR\n' });
  assert.strictEqual(gitHooks(['add', '-A']).status, 0);
  const malo = gitHooks(['commit', '-q', '-m', 'sólo skills/, rechazado']);
  assert.notStrictEqual(malo.status, 0, `el hook de agent-skills lo rechaza: el commit no se crea\n${malo.stderr}`);
  assert.match(malo.stderr, /rechazado/);
  assert.strictEqual(gitFx(s, ['rev-list', '--count', 'HEAD']), '1');
  const corridas = fs.readFileSync(log, 'utf8');
  assert.match(corridas, /^arnes$/m, 'el del arnés corrió');
  const skills = /^skills (\S+) (\S+)$/m.exec(corridas);
  assert.ok(skills, `el de agent-skills corrió aunque el del arnés salió temprano: ${corridas}`);
  assert.strictEqual(fs.realpathSync(skills[1]), fs.realpathSync(s), 'TYCON_SKILLS_DIR es la raíz del repo');
  assert.strictEqual(fs.realpathSync(skills[2]), fs.realpathSync(s), 'TYCON_GUIDES_DIR es la raíz del repo');
  assert.strictEqual(gitHooks(['rm', '-q', '--cached', 'skills/tycon-pipeline/malo.sh']).status, 0);
  fs.rmSync(path.join(s, 'skills', 'tycon-pipeline', 'malo.sh'));
  escribir(s, { 'skills/tycon-pipeline/bueno.md': '# Bien\n' });
  gitHooks(['add', '-A']);
  const bueno = gitHooks(['commit', '-q', '-m', 'sólo skills/, aceptado']);
  assert.strictEqual(bueno.status, 0, `si los dos pasan, el commit se crea\n${bueno.stderr}`);

  // una ruta que llega de las dos fuentes (fuera de las dos que se unen): 2 nombrándola
  escribir(fx.skills, { 'README.md': '# agent-skills de mentira\n' });
  commitear(fx.skills, 'un README');
  lista.packages.core['agent-skills'].in.push('README.md');
  fx.config({ lista });
  const choque = fx.salida('s7-choque');
  const rc = exportar(fx, ['--package', 'core', '--single-repo', '--output', choque]);
  assert.strictEqual(rc.code, 2, `${rc.err}\n${rc.out}`);
  assert.match(rc.err, /README\.md/);
  assert.ok(!fs.existsSync(choque));
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T8 · story 8.7, AC 12 — en la copia, sólo los terceros que se usan y tienen licencia libre ──────────────────────────
test('Exportador_TercerosPublicos_LosQueSeUsan', () => {
  const fx = fixture();
  const lineas = [
    '{',
    '  "__doc": "terceros de mentira",',
    '  "own": [ { "glob": "skills/tycon-*", "why": "del equipo" } ],',
    '  "derived": [',
    '    { "target": "scripts/no-sale.js", "repo": "tycon-claude-guides", "license": "MIT", "why": "no sale" }',
    '  ],',
    '  "origins": {',
    '    "libre@1": { "origin": "https://example.com/libre", "license": "MIT" },',
    '    "cerrado@1": { "origin": "https://example.com/cerrado", "license": "LicenseRef-Proprietary" }',
    '  },',
    '  "third_party": [',
    '    { "target": "skills/usada", "from": "libre@1", "install": "download", "used_by": ["tycon-pipeline"] },',
    '    { "target": "skills/de-la-usada", "from": "libre@1", "install": "download", "used_by": ["usada"] },',
    '    { "target": "skills/no-libre", "from": "cerrado@1", "install": "download", "used_by": ["tycon-pipeline"] },',
    '    { "target": "skills/sin-uso", "from": "libre@1", "install": "download", "used_by": [] },',
    '    { "target": ".claude/plugins/x", "from": "libre@1", "install": "official-plugin", "used_by": ["tycon-pipeline"] },',
    '    { "target": ".agents/skills/viejo", "from": "libre@1", "install": "retire", "used_by": ["tycon-pipeline"] }',
    '  ],',
    '  "retirement": "done"',
    '}',
    '',
  ];
  escribir(fx.arnes, { 'scripts/publishing/third-party-skills.json': lineas.join('\n') });
  commitear(fx.arnes, 'el manifiesto de terceros');
  const s = fx.salida('s8');
  const r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const copia = leer(s, 'arnes/scripts/publishing/third-party-skills.json');
  const i = lineas.indexOf('  "third_party": [');
  const esperado = [...lineas.slice(0, i + 2), lineas[i + 2].replace(/,$/, ''), ...lineas.slice(i + 7)].join('\n');
  assert.strictEqual(copia, esperado, 'quedan la usada y la que la usa; own, derived y el resto, byte a byte');
  const original = JSON.parse(lineas.join('\n'));
  const j = JSON.parse(copia);
  assert.deepStrictEqual(j.third_party.map((e) => e.target), ['skills/usada', 'skills/de-la-usada']);
  assert.deepStrictEqual([j.own, j.derived, j.origins], [original.own, original.derived, original.origins]);
  assert.deepStrictEqual(ajustesDe(r.json, 'public-third-party'), ['arnes/scripts/publishing/third-party-skills.json']);
  assert.ok(fs.readFileSync(path.join(fx.arnes, 'scripts/publishing/third-party-skills.json'), 'utf8') === lineas.join('\n'), 'adentro no cambia nada');
});

// ── T9 · story 8.7, AC 14 — el nombre público, en un solo lugar ─────────────────────────────────────────────────────────
// AC 14 · la clasificación de cada commit (whatShips, la que usan los frenos) lee el nombre público del MISMO commit: un
// archivo roto es «no pude mirar» (tira), nunca «sin nombre público»; ausente (la copia pública no lo trae), sigue sin él.
// Revisión de fallos silenciosos de la tanda A: antes se tragaba cualquier error del lector.
test('WhatShips_PublicRepos_BrokenIsCouldNotLook', () => {
  const ex = require(EXPORTAR);
  const clasificar = (fx) => {
    const ctx = { repos: { arnes: { dir: fx.arnes }, 'agent-skills': { dir: fx.skills } } };
    ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, fx.cfg);
    ex.whatShips(ctx);
    return ctx.publicRepo;
  };
  const sinArchivo = fixture();
  assert.strictEqual(clasificar(sinArchivo), null, 'sin el archivo en el commit, sin nombre público');
  const sano = fixture();
  escribir(sano.arnes, { 'scripts/publishing/public-repos.json': `${JSON.stringify(PUBLICO, null, 2)}\n` });
  commitear(sano.arnes, 'el nombre público');
  assert.deepStrictEqual(clasificar(sano), { org: 'example-org', repo: 'example-harness' }, 'el del commit');
  for (const [que, texto] of [['JSON roto', '{ "org": '], ['sin repo', '{ "org": "example-org" }\n'], ['carácter inválido', '{ "org": "example org", "repo": "x" }\n']]) {
    const roto = fixture();
    escribir(roto.arnes, { 'scripts/publishing/public-repos.json': texto });
    commitear(roto.arnes, `nombre público: ${que}`);
    assert.throws(() => clasificar(roto), /public-repos\.json|nombre público/, `${que}: tira nombrando el archivo, no sigue sin nombre`);
  }
});

test('Exportador_NombrePublico_UnSoloLugar', () => {
  const fx = fixture();
  const portada = (...extra) => ['# Portada', '', 'git clone https://github.com/{{public-org}}/{{public-repo}} tycon-harness',
    'El plugin de ejemplo: https://github.com/{{public-org}}/sample-plugin', 'Sin nombre público en esta línea.', ...extra, ''].join('\n');
  const lista = conPapeles(fx, { '.github/README.md': portada() });
  // el archivo del nombre público vive en el interno y no viaja (como el real)
  escribir(fx.arnes, { 'scripts/publishing/public-repos.json': `${JSON.stringify(PUBLICO, null, 2)}\n` });
  lista.packages.core.arnes.out.push({ glob: 'scripts/publishing/public-repos.json', reason: 'sólo lo lee el exportador (prueba)' });
  fx.config({ lista });
  commitear(fx.arnes, 'la portada');
  const { readPublicRepo } = require(EXPORTAR);
  assert.deepStrictEqual(readPublicRepo(fx.cfg.publicRepos), { org: 'example-org', repo: 'example-harness' });

  const a = fx.salida('s9-a');
  let r = exportar(fx, ['--package', 'core', '--output', a, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const lineasA = leer(a, 'arnes/.github/README.md').split('\n');
  assert.strictEqual(lineasA[2], 'git clone https://github.com/example-org/example-harness tycon-harness');
  assert.strictEqual(lineasA[3], 'El plugin de ejemplo: https://github.com/example-org/sample-plugin');
  assert.deepStrictEqual(ajustesDe(r.json, 'public-name'), ['arnes/.github/README.md']);
  assert.ok(!existe(a, 'arnes/scripts/publishing/public-repos.json'), 'el archivo del nombre no está en la copia');

  // otro nombre: cambian las URL de la copia y ninguna otra línea
  const otro = path.join(fx.dir, 'cfg', 'otro-nombre.json');
  fs.writeFileSync(otro, JSON.stringify({ org: 'other-org', repo: 'other-name' }));
  const b = fx.salida('s9-b');
  r = exportar(fx, ['--package', 'core', '--output', b, '--public-repos', otro]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(listar(b), listar(a));
  const distintas = [];
  for (const p of listar(a)) {
    const x = fs.readFileSync(path.join(a, p)).toString('latin1').split('\n');
    const y = fs.readFileSync(path.join(b, p)).toString('latin1').split('\n');
    assert.strictEqual(x.length, y.length, p);
    x.forEach((l, k) => { if (l !== y[k]) distintas.push(`${p}:${k + 1}`); });
  }
  assert.deepStrictEqual(distintas, ['arnes/.github/README.md:3', 'arnes/.github/README.md:4']);
  assert.strictEqual(leer(b, 'arnes/.github/README.md').split('\n')[2], 'git clone https://github.com/other-org/other-name tycon-harness');

  // sin una clave, con un carácter fuera de [A-Za-z0-9._-], o sin el archivo: 2 nombrando el problema
  const casos = [
    ['sin repo', { org: 'example-org' }, /repo/],
    ['un carácter inválido', { org: 'example org', repo: 'x' }, /org/],
    ['sin el archivo', null, /no-esta\.json/],
  ];
  casos.forEach(([nombre, contenido, motivo], i) => {
    const f = path.join(fx.dir, 'cfg', contenido ? `mal-${i}.json` : 'no-esta.json');
    if (contenido) fs.writeFileSync(f, JSON.stringify(contenido));
    const s = fx.salida(`s9-mal-${i}`);
    const rr = exportar(fx, ['--package', 'core', '--output', s, '--public-repos', f]);
    assert.strictEqual(rr.code, 2, `${nombre}: ${rr.err}\n${rr.out}`);
    assert.match(rr.err, motivo, nombre);
    assert.ok(!fs.existsSync(s), nombre);
    assert.throws(() => readPublicRepo(f), motivo, `${nombre}: readPublicRepo tira`);
  });
  // un marcador que el archivo no define: 2 nombrando papel y marcador
  fx.config({ lista: conPapeles(fx, { '.github/README.md': portada('Rama: {{public-branch}}') }, lista) });
  commitear(fx.arnes, 'un marcador desconocido');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('s9-marcador')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /\.github\/README\.md/);
  assert.match(r.err, /\{\{public-branch\}\}/);
  // la URL del repo público escrita a mano: rojo; la de otro repo de la organización, no
  fx.config({ lista: conPapeles(fx, { '.github/README.md': portada('A mano: https://github.com/example-org/example-harness.git') }, lista) });
  commitear(fx.arnes, 'la URL a mano');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('s9-a-mano'), '--json']);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.handWrittenPublicUrl.map((h) => `${h.file}:${h.line}`), ['arnes/.github/README.md:6']);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T15 · story 8.7, AC 5 — las rutas que nombran el README y el INSTALL existen en la copia ────────────────────────────
test('Exportador_RutasDelReadme_Existen', () => {
  const fx = fixture();
  escribir(fx.arnes, { 'README.md': ['# Arnés de mentira', '', 'Lo usa AcmeCorp todos los días.', '',
    'Ver `scripts/hola.js`, `tasks/plan.md`, `.tycon/advisors.yaml` y `~/.claude/settings.json`.', ''].join('\n') });
  commitear(fx.arnes, 'el README nombra rutas');
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('s15'), '--json']);
  assert.strictEqual(r.code, 1, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(r.json.controles.readmePaths.map((h) => `${h.file}:${h.line} ${h.path}`), ['arnes/README.md:5 tasks/plan.md'],
    'sólo la que no sale: ni la que sale, ni .tycon/, ni ~/.claude/');
  const h = exportar(fx, ['--package', 'core', '--output', fx.salida('s15-humano')]);
  assert.strictEqual(h.code, 1, h.err);
  assert.match(h.out, /arnes\/README\.md:5 .*tasks\/plan\.md/);
  assert.match(explicarTexto(fx), /readmePaths/, '--explain lista el control');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T38 · story 8.7, AC 30 (paso cero, decisión 1) — las rutas viejas, con el mapa; un reemplazo sin entrada frena ──────
test('Exportador_RutasViejas_SeReescribenConElMapa', () => {
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'file', old: 'scripts/old-tool.js', new: 'scripts/tools/new-tool.js', batch: 'lab', callers: ['other-repo'] },
    { kind: 'folder', old: 'scripts/old-dir', new: 'scripts/nightly/new-dir', batch: 'lab', callers: ['other-repo'] },
    { kind: 'env', old: 'TYCON_OLD_LAB', new: 'TYCON_NEW_LAB', batch: 'lab' },
  ] };
  // un reemplazo generado: la marca en su segunda línea (AC 4 de la 8.12)
  const reemplazo = (nuevo, rel) => `#!/usr/bin/env node\n// tycon-legacy-shim: ${nuevo}\n'use strict';\nmodule.exports = require(${JSON.stringify(rel)});\n`;
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'scripts/tools/new-tool.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/old-tool.js': reemplazo('scripts/tools/new-tool.js', './tools/new-tool.js'),
    'scripts/nightly/new-dir/x.js': "'use strict';\nmodule.exports = 2;\n",
    'scripts/old-dir/x.js': reemplazo('scripts/nightly/new-dir/x.js', '../nightly/new-dir/x.js'),
    'guides/nombres-en-ingles.md': '# Nombres\n\n`scripts/old-tool.js` pasó a `scripts/tools/new-tool.js`.\n',
  });
  escribir(fx.skills, {
    'skills/tycon-pipeline/config.json': `${JSON.stringify({ tool: '<arnés>/scripts/old-tool.js', dir: '<arnés>/scripts/old-dir/x.js',
      ya: '<arnés>/scripts/tools/new-tool.js', env: 'TYCON_OLD_LAB' }, null, 2)}\n`,
    'agents/revisor-nucleo.md': agente('revisor-nucleo', 'Corré `node <arnés>/scripts/old-tool.js --check`.'),
  });
  commitear(fx.skills, 'nombra las rutas viejas del arnés');
  regenerarCodex(fx.arnes, fx.skills);
  commitear(fx.arnes, 'la mudanza, con sus reemplazos');
  const s = fx.salida('s38');
  let r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(leer(s, 'agent-skills/skills/tycon-pipeline/config.json')), {
    tool: '<arnés>/scripts/tools/new-tool.js', dir: '<arnés>/scripts/nightly/new-dir/x.js', ya: '<arnés>/scripts/tools/new-tool.js', env: 'TYCON_OLD_LAB',
  }, 'el archivo y la carpeta, a la ruta nueva; la que ya era nueva y la variable, intactas');
  for (const p of ['agent-skills/agents/revisor-nucleo.md', 'arnes/adapters/codex/agents/revisor-nucleo.toml', 'arnes/adapters/codex/agents-native/revisor-nucleo.toml']) {
    assert.match(leer(s, p), /<arnés>\/scripts\/tools\/new-tool\.js --check/, `${p}: la ruta nueva`);
    assert.doesNotMatch(leer(s, p), /old-tool/, p);
  }
  assert.match(leer(s, 'arnes/guides/nombres-en-ingles.md'), /`scripts\/old-tool\.js`/, 'la guía de la convención, intacta');
  const tocados = ajustesDe(r.json, 'rutas-del-otro-repo');
  for (const p of ['agent-skills/agents/revisor-nucleo.md', 'agent-skills/skills/tycon-pipeline/config.json']) assert.ok(tocados.includes(p), `${p}: ${tocados}`);
  assert.ok(!existe(s, 'arnes/scripts/old-tool.js') && !existe(s, 'arnes/scripts/old-dir/x.js'), 'ningún reemplazo en la copia');
  const r2 = exportar(fx, ['--package', 'core', '--output', fx.salida('s38-otra'), '--json']);
  assert.strictEqual(r2.code, 0, r2.err);
  assert.deepStrictEqual(r2.json.repos, r.json.repos, 'dos corridas, el mismo HEAD');

  // un reemplazo generado cuya ruta el mapa no tiene, nombrado por algo que sale: 2 con archivo, línea y ruta, sin copia
  escribir(fx.arnes, {
    'scripts/tools/orphan-new.js': "'use strict';\nmodule.exports = 3;\n",
    'scripts/orphan-old.js': reemplazo('scripts/tools/orphan-new.js', './tools/orphan-new.js'),
    'guides/usa-huerfano.md': '# Huérfano\n\nCorré `node scripts/orphan-old.js`.\n',
  });
  commitear(fx.arnes, 'un reemplazo sin entrada en el mapa');
  const h = fx.salida('s38-huerfano');
  r = exportar(fx, ['--package', 'core', '--output', h]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /guides\/usa-huerfano\.md:3/);
  assert.match(r.err, /scripts\/orphan-old\.js/);
  assert.match(r.err, /renames\.json/, 'dice dónde se arregla');
  assert.ok(!fs.existsSync(h), 'sin copia');
  // el mapa ilegible: 2 nombrándolo
  escribir(fx.arnes, { 'guides/usa-huerfano.md': null, 'scripts/lib/renames.json': '{ roto' });
  commitear(fx.arnes, 'el mapa roto');
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('s38-roto')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /scripts\/lib\/renames\.json/);
  // sin mapa, --explain lo dice
  escribir(fx.arnes, { 'scripts/lib/renames.json': null });
  commitear(fx.arnes, 'sin mapa');
  assert.match(explicarTexto(fx), /sin mapa: no hay rutas viejas que reescribir/);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── pase adversarial de la tanda A de la story 8.7 (step-05b) ──────────────────────────────────────────────────────────
// traversal-completeness-1: los frenos de nombres miran el .md ENTERO, bloques internos incluidos (AC 5)
test('WhatShips_InternalBlocks_FrenosSeeWholeFile', () => {
  const fx = fixture();
  const { IS, IE, PS, PE } = MARCA;
  escribir(fx.arnes, { 'guides/x.md': ['# Guía', '', IS, 'Lo usa AcmeCorp.', IE, PS, 'sólo afuera', PE, ''].join('\n') });
  commitear(fx.arnes, 'un nombre dentro de un bloque interno');
  const ex = require(EXPORTAR);
  const ctx = { repos: { arnes: { dir: fx.arnes }, 'agent-skills': { dir: fx.skills } } };
  ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, fx.cfg);
  const piezas = ex.whatShips(ctx).ofFile('arnes', 'guides/x.md');
  assert.ok(piezas.length, 'sale');
  for (const p of piezas) {
    assert.match(p.text, /Lo usa AcmeCorp\./, `${p.pkg}: el freno ve lo que hay adentro del bloque interno`);
    assert.match(p.text, /sólo afuera/);
  }
});

// traversal-completeness-2: una skill anidada (skills/core/<x>/SKILL.md) se llama como su carpeta, no como la primera
test('PublicThirdParty_NestedSkill_CountsByItsFolder', () => {
  const fx = fixture();
  escribir(fx.skills, { 'skills/core/nested-skill/SKILL.md': '---\nname: nested-skill\n---\n\nAnidada.\n' });
  commitear(fx.skills, 'una skill anidada');
  const lineas = [
    '{',
    '  "own": [],',
    '  "derived": [],',
    '  "origins": { "libre@1": { "origin": "https://example.com/libre", "license": "MIT" } },',
    '  "third_party": [',
    '    { "target": "skills/helper", "from": "libre@1", "install": "download", "used_by": ["nested-skill"] },',
    '    { "target": "skills/sin-uso", "from": "libre@1", "install": "download", "used_by": ["core"] }',
    '  ]',
    '}',
    '',
  ];
  escribir(fx.arnes, { 'scripts/publishing/third-party-skills.json': lineas.join('\n') });
  commitear(fx.arnes, 'un tercero que usa la anidada');
  const lista = clonar(LISTA_BASE);
  lista.packages.core['agent-skills'].in.push('skills/core/**');
  fx.config({ lista });
  const s = fx.salida('adv-anidada');
  const r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(leer(s, 'arnes/scripts/publishing/third-party-skills.json')).third_party.map((e) => e.target), ['skills/helper'],
    'queda la que usa la skill anidada; «core» no es una skill');
});

// false-negative-classification-1: los papeles también pasan por internal-blocks (y un marcador en uno que no es .md, 2)
test('Papers_InternalBlocksApplied', () => {
  const fx = fixture();
  const { IS, IE } = MARCA;
  fx.config({ lista: conPapeles(fx, { '.github/README.md': ['# Portada', IS, 'SECRETO-DEL-EQUIPO', IE, 'fin', ''].join('\n') }) });
  commitear(fx.arnes, 'un papel .md con un bloque interno');
  const s = fx.salida('adv-papel-md');
  let r = exportar(fx, ['--package', 'core', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(s, 'arnes/.github/README.md'), '# Portada\nfin\n', 'sin el bloque ni sus marcadores');
  assert.ok(ajustesDe(r.json, 'internal-blocks').includes('arnes/.github/README.md'));
  fx.config({ lista: conPapeles(fx, { NOTICE: ['Producto', IS, 'SECRETO', IE, ''].join('\n') }) });
  commitear(fx.arnes, 'un papel que no es .md con marcadores');
  const n = fx.salida('adv-papel-notice');
  r = exportar(fx, ['--package', 'core', '--output', n]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /arnes\/NOTICE:2/);
  assert.ok(!fs.existsSync(n));
});

// false-negative-classification-2: con --single-repo, dos rutas de fuentes distintas que sólo difieren en mayúsculas chocan
test('SingleRepo_CaseCollisionAcrossSources_Exit2', () => {
  const fx = fixture();
  escribir(fx.skills, { 'readme.md': '# agent-skills\n' });
  commitear(fx.skills, 'un readme en minúsculas');
  const lista = clonar(LISTA_BASE);
  lista.packages.core['agent-skills'].in.push('readme.md');
  fx.config({ lista });
  const dos = fx.salida('adv-caja-dos');
  let r = exportar(fx, ['--package', 'core', '--output', dos]);
  assert.strictEqual(r.code, 0, `en dos repos no chocan: cada uno en su carpeta\n${r.err}\n${r.out}`);
  const uno = fx.salida('adv-caja-uno');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--output', uno]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /sólo difieren en mayúsculas[^\n]*README\.md[^\n]*readme\.md|sólo difieren en mayúsculas[^\n]*readme\.md[^\n]*README\.md/);
  assert.ok(!fs.existsSync(uno));
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.8, tanda A — la identidad fija del commit, exportada: la sincronización (mirror.js) firma con la misma ─────
test('Exporter_CommitIdentity_ExportedFrozen', () => {
  const exportador = require(EXPORTAR);
  const identidad = exportador.COMMIT_IDENTITY;
  assert.ok(identidad && typeof identidad === 'object', 'export.js exporta COMMIT_IDENTITY');
  assert.ok(Object.isFrozen(identidad), 'congelada: quien la usa no la puede cambiar');
  assert.deepStrictEqual(Object.keys(identidad).sort(), ['email', 'nombre'], 'sus dos campos, como están');
  // es la que firma hoy el commit de la copia, no una copia del valor
  const fx = fixture();
  const salida = fx.salida('identidad');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const firma = `${identidad.nombre} <${identidad.email}>`;
  for (const f of ['arnes', 'agent-skills']) {
    assert.strictEqual(gitCopia(path.join(salida, f), ['log', '-1', '--format=%an <%ae> / %cn <%ce>']), `${firma} / ${firma}`, `${f}: autor y committer`);
  }
  // la función que commitea no se exporta: quien necesite un commit lo arma con el git aislado
  assert.strictEqual(exportador.commitear, undefined);
});

// ══ story 8.13, tanda D (AC 24, T30) — `version.json`: los bytes, la opción del exportador y la lista blanca ═════════════
// La mitad del exportador de T30. En la sincronización el archivo lo agrega mirror.js (el número depende de lo publicado, y
// el exportador corre antes de leerlo): acá van la función que arma los bytes —una sola, la misma para los dos—, la opción
// que estampa un número dado en una copia suelta, y la clave `generated` de la lista blanca.
const VERSION_DE_PRUEBA = '2030.01.15.3';
const GENERADO = { target: 'version.json', reason: 'la versión numerada de la copia (prueba)' };
const listaConGenerado = (lista = clonar(LISTA_BASE)) => ({ ...lista, generated: [clonar(GENERADO)] });
const arbolSin = (repo, ruta) => gitFx(repo, ['ls-tree', '-r', 'HEAD']).split('\n').filter((l) => !l.endsWith(`\t${ruta}`)).join('\n');

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — los bytes: una función, la misma entrada da los mismos bytes', () => {
  // 🔴 rojo previo: «ex.versionFileBytes is not a function» (export.js no exportaba la función ni VERSION_FILE)
  const ex = require(EXPORTAR);
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  assert.strictEqual(ex.VERSION_FILE, 'version.json', 'el nombre del archivo, exportado: no se escribe en otro lado');
  const bytes = ex.versionFileBytes({ version: '2026.10.03.2', source: { harness: A, agent_skills: B } });
  assert.ok(Buffer.isBuffer(bytes), 'devuelve bytes, no un objeto que cada uno serializa a su modo');
  assert.strictEqual(bytes.toString('utf8'),
    `{\n  "version": "2026.10.03.2",\n  "source": {\n    "harness": "${A}",\n    "agent_skills": "${B}"\n  }\n}\n`,
    'la forma exacta: dos espacios de sangría, este orden de claves y un salto de línea al final');
  // el orden en que llegan los datos no cambia los bytes, y dos llamadas dan lo mismo
  assert.ok(bytes.equals(ex.versionFileBytes({ source: { agent_skills: B, harness: A }, version: '2026.10.03.2' })));
  const leido = JSON.parse(bytes.toString('utf8'));
  assert.deepStrictEqual(Object.keys(leido), ['version', 'source']);
  assert.deepStrictEqual(Object.keys(leido.source), ['harness', 'agent_skills']);
  assert.ok(!('built_at' in leido) && !('channel' in leido), 'sin built_at (la fecha de la corrida) ni channel (el mismo archivo llega a main)');
  // `source` es un mapa de fuente → commit: se escriben las claves que llegan (hoy son esas dos; la función no las cuenta)
  assert.deepStrictEqual(Object.keys(JSON.parse(ex.versionFileBytes({ version: '2026.10.03.2', source: { harness: A } }).toString('utf8')).source), ['harness']);
  // la forma del número, exportada: la usa quien lee el archivo
  assert.ok(ex.VERSION_SHAPE instanceof RegExp);
  for (const sano of ['2026.10.03.1', '2026.01.31.10', '1999.12.01.250']) assert.ok(ex.VERSION_SHAPE.test(sano), `${sano} tiene la forma`);
  // lo que no tiene forma no se escribe: tira, no arma un archivo a medias
  const source = { harness: A, agent_skills: B };
  const mal = [
    ['sin número de orden', { version: '2026.10.03', source }],
    ['orden cero', { version: '2026.10.03.0', source }],
    ['orden con cero adelante', { version: '2026.10.03.01', source }],
    ['mes de un dígito', { version: '2026.9.03.1', source }],
    ['mes 13', { version: '2026.13.03.1', source }],
    ['la versión derivada (+sha7)', { version: '2026.10.03+abc1234', source }],
    ['con un salto de línea', { version: '2026.10.03.1\n', source }],
    ['sin versión', { source }],
    ['un sha corto', { version: '2026.10.03.1', source: { harness: 'abc1234', agent_skills: B } }],
    ['un sha que no es hexadecimal', { version: '2026.10.03.1', source: { harness: A, agent_skills: 'z'.repeat(40) } }],
    ['sin ninguna fuente', { version: '2026.10.03.1', source: {} }],
    ['sin `source`', { version: '2026.10.03.1' }],
    ['`source` no es un mapa', { version: '2026.10.03.1', source: [A, B] }],
    ['una clave que no es un nombre', { version: '2026.10.03.1', source: { 'con espacio': A } }],
  ];
  for (const [que, datos] of mal) assert.throws(() => ex.versionFileBytes(datos), ex.NoPudo, `${que}: tira`);
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — --stamp-version: sólo con --single-repo, y sin la opción la copia no cambia', () => {
  // 🔴 rojo previo: «opción desconocida: --stamp-version» (exit 2 en el caso que tiene que dar 0)
  const ex = require(EXPORTAR);
  const fx = fixture();
  fx.config({ lista: listaConGenerado() });

  // sin la opción, la copia es la de siempre: declarar el generado en la lista no cambia ni un byte ni el commit
  const base = fx.salida('v-base');
  let r = exportar(fx, ['--package', 'core', '--single-repo', '--output', base, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!existe(base, 'version.json'), 'sin la opción no hay version.json');
  assert.deepStrictEqual(r.json.generated, [], 'y el --json lo dice: ningún generado');
  fx.config({ lista: clonar(LISTA_BASE) });
  const sinDeclarar = fx.salida('v-sin-declarar');
  const r0 = exportar(fx, ['--package', 'core', '--single-repo', '--output', sinDeclarar, '--json']);
  assert.strictEqual(r0.code, 0, `${r0.err}\n${r0.out}`);
  assert.strictEqual(gitFx(base, ['rev-parse', 'HEAD']), gitFx(sinDeclarar, ['rev-parse', 'HEAD']), 'el mismo commit con y sin la declaración');
  fx.config({ lista: listaConGenerado() });

  // con la opción: version.json en la raíz, con los bytes de la función y los shas de las dos fuentes
  const con = fx.salida('v-con');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', con, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  // (story 8.13.1, AC 6: con la lista de transformados de la corrida, que el --json también trae)
  const esperado = ex.versionFileBytes({ version: VERSION_DE_PRUEBA, source: { harness: r.json.fuentes.arnes.sha, agent_skills: r.json.fuentes['agent-skills'].sha }, transformed: r.json.transformed });
  assert.ok(fs.readFileSync(path.join(con, 'version.json')).equals(esperado), `los bytes son los de versionFileBytes\n${leer(con, 'version.json')}`);
  assert.strictEqual(r.json.fuentes.arnes.sha, gitFx(fx.arnes, ['rev-parse', 'HEAD']), 'control: el sha estampado es el del arnés');
  assert.match(gitFx(con, ['ls-tree', 'HEAD', '--', 'version.json']), /^100644 blob [0-9a-f]+\tversion\.json$/, 'está en el commit, como un archivo regular');
  assert.strictEqual(gitFx(con, ['status', '--porcelain', '--untracked-files=all']), '', 'y el árbol de trabajo es el del commit');
  assert.deepStrictEqual(r.json.generated, ['version.json']);
  assert.deepStrictEqual(ajustesDe(r.json, 'generated'), ['version.json'], 'ningún archivo cambia sin su ajuste');
  // pasó por los controles de la copia como cualquier archivo: el detector miró cada uno, ni uno menos
  assert.strictEqual(r.json.detector[PUBLICO.repo].archivos, listar(con).length);
  assert.strictEqual(r.json.detector[PUBLICO.repo].excluidos, 0);
  // y es lo ÚNICO que cambia: el resto del árbol es el de la copia sin la opción
  assert.strictEqual(arbolSin(con, 'version.json'), gitFx(base, ['ls-tree', '-r', 'HEAD']), 'sin version.json, el mismo árbol');
  assert.notStrictEqual(gitFx(con, ['rev-parse', 'HEAD']), gitFx(base, ['rev-parse', 'HEAD']), 'control: con el archivo, otro commit');

  // determinista: el mismo número da el mismo commit; otro número cambia sólo ese archivo
  const otraVez = fx.salida('v-otra-vez');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', otraVez, '--json'],
    { env: { TZ: 'Pacific/Kiritimati' } });
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(gitFx(otraVez, ['rev-parse', 'HEAD']), gitFx(con, ['rev-parse', 'HEAD']), 'mismas entradas, mismo commit (con otro huso)');
  const otro = fx.salida('v-otro-numero');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--stamp-version', '2030.01.15.4', '--output', otro, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(JSON.parse(leer(otro, 'version.json')).version, '2030.01.15.4');
  assert.strictEqual(arbolSin(otro, 'version.json'), arbolSin(con, 'version.json'));

  // lo que no puede ser: 2, diciendo por qué, y sin dejar nada
  const casos = [
    ['sin --single-repo: la raíz de la copia no es de ningún repo', ['--package', 'core', '--stamp-version', VERSION_DE_PRUEBA], /--stamp-version[^\n]*--single-repo/],
    ['un número sin forma', ['--package', 'core', '--single-repo', '--stamp-version', '2030.1.15.3'], /--stamp-version[^\n]*YYYY\.MM\.DD\.N/],
    ['la versión derivada', ['--package', 'core', '--single-repo', '--stamp-version', '2030.01.15+abc1234'], /--stamp-version[^\n]*YYYY\.MM\.DD\.N/],
    ['sin valor', ['--package', 'core', '--single-repo', '--stamp-version'], /--stamp-version necesita un valor/],
  ];
  casos.forEach(([nombre, args, motivo], i) => {
    const s = fx.salida(`v-mal-${i}`);
    const rr = exportar(fx, [...args.slice(0, args.indexOf('--stamp-version')), '--output', s, ...args.slice(args.indexOf('--stamp-version'))]);
    assert.strictEqual(rr.code, 2, `${nombre}: ${rr.err}\n${rr.out}`);
    assert.match(rr.err, motivo, nombre);
    assert.ok(!fs.existsSync(s), `${nombre}: no deja salida`);
  });
  // y sin la declaración en la lista blanca, el exportador no escribe un archivo que nadie declaró
  fx.config({ lista: clonar(LISTA_BASE) });
  const sinLista = fx.salida('v-sin-lista');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', sinLista]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /version\.json[^\n]*generated/, 'dice dónde se declara');
  assert.ok(!fs.existsSync(sinLista));
  assert.deepStrictEqual(temporales(fx), []);
});

test('Export_VersionJson_OnlyWhenTreeChanged_Deterministic_VerifyIgnores — generated: validada, listada por --explain, y sin choques', () => {
  // 🔴 rojo previo: `--explain --json` sin la clave «generated» (undefined), y una lista con un generado sin motivo aceptada
  const ex = require(EXPORTAR);
  const fx = fixture();
  fx.config({ lista: listaConGenerado() });

  // --explain la lista, en JSON y en texto; sin la clave, una lista vacía
  assert.deepStrictEqual(explicarJson(fx).generated, [GENERADO]);
  const texto = explicarTexto(fx);
  assert.match(texto, /Archivos generados/);
  assert.ok(texto.includes(GENERADO.reason) && /version\.json/.test(texto), 'con su destino y su motivo');
  fx.config({ lista: clonar(LISTA_BASE) });
  assert.deepStrictEqual(explicarJson(fx).generated, [], 'sin la clave: ninguno');

  // la forma: cada problema es un 2 antes de armar nada
  const base = clonar(LISTA_BASE);
  assert.doesNotThrow(() => ex.validarLista(listaConGenerado(), 'lista'), 'control: la sana pasa');
  const invalidas = [
    ['no es una lista', { ...base, generated: { target: 'version.json', reason: 'x' } }, /generated/],
    ['sin target', { ...base, generated: [{ reason: 'x' }] }, /generated[^\n]*target/],
    ['sin motivo', { ...base, generated: [{ target: 'version.json' }] }, /generated version\.json[^\n]*motivo/],
    ['motivo en blanco', { ...base, generated: [{ target: 'version.json', reason: '   ' }] }, /generated version\.json[^\n]*motivo/],
    ['un glob', { ...base, generated: [{ target: '*.json', reason: 'x' }] }, /generated[^\n]*\*\.json/],
    ['un segmento ..', { ...base, generated: [{ target: '../version.json', reason: 'x' }] }, /generated[^\n]*\.\.\/version\.json/],
    ['repetido', { ...base, generated: [clonar(GENERADO), clonar(GENERADO)] }, /generated version\.json[^\n]*dos veces/],
    ['uno que el exportador no sabe generar', { ...base, generated: [{ target: 'otro.json', reason: 'x' }] }, /generated otro\.json[^\n]*no sabe generar/],
  ];
  for (const [que, lista, motivo] of invalidas) {
    assert.throws(() => ex.validarLista(lista, 'lista'), (e) => e instanceof ex.NoPudo && motivo.test(e.message), `${que}: ${motivo}`);
  }
  // y por la línea de comandos: 2 nombrando la entrada, sin salida
  fx.config({ lista: { ...base, generated: [{ target: 'version.json' }] } });
  const mala = fx.salida('g-mala');
  let r = exportar(fx, ['--package', 'core', '--single-repo', '--output', mala]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /generated version\.json[^\n]*motivo/);
  assert.ok(!fs.existsSync(mala));

  // el choque: una fuente que ya trae ese destino. Sale 2 en las dos formas de la copia, con o sin la opción: en la
  // sincronización el archivo lo agrega mirror.js encima de esta misma copia, y pisaría el de la fuente sin avisar
  escribir(fx.arnes, { 'version.json': '{ "version": "de la fuente" }\n', 'scripts/version.json': '{ "otra": "cosa" }\n' });
  commitear(fx.arnes, 'un version.json propio, y otro que no está en la raíz');
  const choca = listaConGenerado();
  choca.packages.core.arnes.in.push('version.json');
  fx.config({ lista: choca });
  [['--single-repo'], [], ['--single-repo', '--stamp-version', VERSION_DE_PRUEBA]].forEach((extra, i) => {
    const s = fx.salida(`g-choque-${i}`);
    const rr = exportar(fx, ['--package', 'core', ...extra, '--output', s]);
    assert.strictEqual(rr.code, 2, `${extra.join(' ')}: ${rr.err}\n${rr.out}`);
    assert.match(rr.err, /generated version\.json[^\n]*ya sale[^\n]*arnes\/version\.json/, `${extra.join(' ')}: nombra el generado y quién lo trae`);
    assert.ok(!fs.existsSync(s));
  });
  // lo sano SÍ pasa: con el de la raíz afuera, el mismo nombre en otra carpeta no es el destino y la copia sale con los dos
  const sanaLista = listaConGenerado();
  sanaLista.packages.core.arnes.out.push({ glob: 'version.json', reason: 'prueba: el de la fuente queda afuera' });
  fx.config({ lista: sanaLista });
  const sana = fx.salida('g-sana');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', sana, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(sana, 'scripts/version.json'), '{ "otra": "cosa" }\n', 'el de la fuente, en su carpeta, tal cual');
  assert.strictEqual(JSON.parse(leer(sana, 'version.json')).version, VERSION_DE_PRUEBA, 'y el generado, en la raíz');
  assert.deepStrictEqual(temporales(fx), []);

  // con otra caja también choca: en un disco que no distingue mayúsculas son el mismo archivo
  const otra = fixture();
  escribir(otra.skills, { 'Version.JSON': '{}\n' });
  commitear(otra.skills, 'el mismo nombre con otra caja');
  const caja = listaConGenerado();
  caja.packages.core['agent-skills'].in.push('Version.JSON');
  otra.config({ lista: caja });
  const otraCaja = otra.salida('g-choque-caja');
  r = exportar(otra, ['--package', 'core', '--single-repo', '--output', otraCaja]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /generated version\.json[^\n]*ya sale[^\n]*agent-skills\/Version\.JSON/);
  assert.ok(!fs.existsSync(otraCaja));
  // un sintético con ese destino, lo mismo
  const conPapel = fixture();
  conPapel.config({ lista: conPapeles(conPapel, { 'version.json': '{ "version": "de un papel" }\n' }, listaConGenerado()) });
  commitear(conPapel.arnes, 'un papel con ese destino');
  const sintetico = conPapel.salida('g-choque-sintetico');
  r = exportar(conPapel, ['--package', 'core', '--single-repo', '--output', sintetico]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /generated version\.json[^\n]*ya sale[^\n]*arnes\/version\.json/);
  assert.ok(!fs.existsSync(sintetico));
});

// ── story 8.13, tanda D (decisión A1) — el archivo que dice cuál es el remoto público ───────────────────────────────────
// La copia lleva `scripts/setup/public-remotes.json` con el nombre público ya puesto: con él, el programa de instalación
// reconoce un clon del público. Es un papel más (vive en public-files/ con los marcadores y llega por un sintético); en
// el interno ese archivo no existe en `scripts/setup/`, así que un clon interno nunca es «público».
const REMOTOS = 'scripts/setup/public-remotes.json';
const PLANTILLA_REMOTOS = '{ "remotes": ["https://github.com/{{public-org}}/{{public-repo}}"] }\n';

test('Export_PublicRemotes_ShipsWithThePublicName — la copia lo trae con el nombre público; el interno no', () => {
  const fx = fixture();
  const lista = conPapeles(fx, { [REMOTOS]: PLANTILLA_REMOTOS });
  fx.config({ lista });
  commitear(fx.arnes, 'la plantilla de los remotos públicos');
  assert.ok(!existe(fx.arnes, REMOTOS), 'control: en el interno no está en scripts/setup/');
  assert.ok(existe(fx.arnes, `${PAPELES}/${REMOTOS}`), 'control: está la plantilla, entre los papeles');

  const s = fx.salida('remotos');
  let r = exportar(fx, ['--package', 'core', '--single-repo', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(leer(s, REMOTOS)), { remotes: ['https://github.com/example-org/example-harness'] },
    'con el nombre público de la configuración, sin marcadores');
  assert.ok(!existe(s, `${PAPELES}/${REMOTOS}`), 'la plantilla no viaja');
  assert.ok(ajustesDe(r.json, 'public-name').includes(`arnes/${REMOTOS}`), 'el reemplazo queda en los ajustes');
  assert.deepStrictEqual(r.json.controles.handWrittenPublicUrl, [], 'los marcadores no son una URL escrita a mano');
  // con otro nombre público cambia ese archivo: el nombre sigue viviendo en un solo lugar
  const otro = path.join(fx.dir, 'cfg', 'otro-nombre.json');
  fs.writeFileSync(otro, JSON.stringify({ org: 'other-org', repo: 'other-name' }));
  const b = fx.salida('remotos-otro');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--output', b, '--public-repos', otro]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(JSON.parse(leer(b, REMOTOS)).remotes, ['https://github.com/other-org/other-name']);
  // un paquete suelto no es un clon del público: sin el núcleo, no va
  const biz = fx.salida('remotos-bizuit');
  r = exportar(fx, ['--package', 'bizuit', '--output', biz]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!existe(biz, `arnes/${REMOTOS}`));
  assert.deepStrictEqual(temporales(fx), []);
});

test('Export_PublicRemotes_ShipsWithThePublicName — la plantilla real y su declaración en la lista blanca',
  { skip: !fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && 'copia pública: ahí el archivo ya está en su destino y la plantilla no viaja' }, () => {
    // 🔴 rojo previo: ENOENT de scripts/publishing/public-files/scripts/setup/public-remotes.json
    const plantilla = fs.readFileSync(path.join(RAIZ, PAPELES, REMOTOS), 'utf8');
    assert.strictEqual(plantilla, PLANTILLA_REMOTOS, 'el contrato con el programa de instalación: una lista «remotes» con la URL por marcadores');
    assert.deepStrictEqual(JSON.parse(plantilla), { remotes: ['https://github.com/{{public-org}}/{{public-repo}}'] });
    if (!THIN_PRIVATE) assert.ok(!fs.existsSync(path.join(RAIZ, REMOTOS)), 'en el interno no existe en scripts/setup/: un clon interno nunca es «público»');
    const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'allowlist.json'), 'utf8'));
    const sintetico = (real.synthetic || []).find((x) => x.target === REMOTOS);
    assert.ok(sintetico, `la lista blanca declara el sintético de ${REMOTOS}`);
    assert.strictEqual(sintetico.from, `${PAPELES}/${REMOTOS}`);
    assert.deepStrictEqual(sintetico.packages, ['core']);
    assert.ok(String(sintetico.reason || '').trim(), 'con su motivo');
    // y el generado de la versión, declarado con motivo
    const generado = (real.generated || []).find((x) => x.target === 'version.json');
    assert.ok(generado && String(generado.reason || '').trim(), 'la lista blanca declara version.json en «generated», con motivo');
    assert.doesNotThrow(() => require(EXPORTAR).validarLista(real, 'allowlist.json'));
  });

// ── story 8.18 (tramo 2) — el repo unido: UNA fuente física, dos lógicas partidas por ruta ─────────────────────────────
// El arnés y agent-skills pasan a ser un repo. La copia pública tiene que salir igual: el exportador lee un solo commit y
// lo parte por ruta (`agents/`, `skills/`, `packs/`, `.tycon/post-commit-ignore` y `.githooks/pre-commit-skills` son la
// fuente agent-skills; el resto, arnes). Con dos repos físicos —estas mismas pruebas de juguete— sigue andando como hoy.
const HARNESS_HOOK = '#!/usr/bin/env bash\n# pre-commit de mentira del arnés\nexit 0\n';
const SKILLS_HOOK = '#!/usr/bin/env bash\n# pre-commit de mentira de agent-skills\nexit 0\n';
// el del arnés trae una línea «!…» bajo una exclusión fija (la saca `gitignore-publico`) y una línea en blanco
const HARNESS_IGNORE = 'node_modules/\n*.log\n\n# evidencia de las corridas\n.advisors/tmp/\n!.advisors/dod-runtime/\n';
// el de agent-skills ignora `.advisors/` entero, con su comentario: es el bloque que la unión NO se lleva
const ADVISORS_BLOCK = ['# Artefactos de las corridas (acá no se versionan).', '# Segunda línea del comentario.', '.advisors/'];
const SKILLS_IGNORE = `${ADVISORS_BLOCK.join('\n')}\n\n# bytecode\n__pycache__/\nnode_modules/\n`;
const linesOf = (t) => t.split('\n').filter((l, i, todas) => !(i === todas.length - 1 && l === ''));
/** El .gitignore unido, con la regla del exportador al pie de la letra (primero las líneas del arnés, sin repetir
 *  ninguna) sobre el de agent-skills sin su bloque `.advisors/`: así se armó el de la unión de verdad. */
function joinedIgnore(arnes, skills) {
  const propias = linesOf(arnes);
  const sinBloque = linesOf(skills).filter((l) => !ADVISORS_BLOCK.includes(l));
  return `${[...new Set([...propias, ...sinBloque.filter((l) => !propias.includes(l))])].join('\n')}\n`;
}
const firstLevelOf = (repo) => new Map(gitFx(repo, ['ls-tree', 'HEAD']).split('\n').filter(Boolean).map((l) => {
  const [meta, nombre] = l.split('\t');
  return [nombre, meta.split(' ')[2]];
}));

/**
 * Los dos repos de juguete con lo que chocó en la unión de verdad (un pre-commit cada uno, dos .gitignore, un README en
 * agent-skills y `.tycon/` en los dos), exportados como hoy; y después la unión, con los mismos pasos que la real: los
 * tres choques resueltos de cada lado y las dos historias juntas con un merge, sin reescribir. Al volver, `fx.arnes` ES
 * el repo unido y `fx.skills` queda como el clon viejo de una máquina en transición.
 */
function unifiedFixture() {
  const ex = require(EXPORTAR);
  const fx = fixture();
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.in.push('.githooks/**');
  lista.packages.core.arnes.out.push({ glob: '.tycon/**', reason: 'la configuración del equipo para este repo' });
  lista.packages.core['agent-skills'].in.push('.githooks/**');
  lista.packages.core['agent-skills'].out.push({ glob: 'README.md', reason: 'la documentación interna del repo' },
    { glob: '.tycon/**', reason: 'la configuración del equipo para este repo' });
  fx.config({ lista });
  escribir(fx.arnes, {
    '.githooks/pre-commit': HARNESS_HOOK, '.gitignore': HARNESS_IGNORE, '.tycon/advisors.yaml': 'packs: []\n',
    // el repo unido se reconoce por su árbol: trae la lista blanca del equipo además de skills/ y agents/
    'scripts/publishing/allowlist.json': `${JSON.stringify(lista, null, 2)}\n`,
  });
  escribir(fx.skills, {
    '.githooks/pre-commit': SKILLS_HOOK, '.gitignore': SKILLS_IGNORE, 'README.md': '# agent-skills de mentira\n',
    '.tycon/post-commit-ignore': 'skills/ajena\n',
  });
  fs.chmodSync(path.join(fx.arnes, '.githooks', 'pre-commit'), 0o755);
  fs.chmodSync(path.join(fx.skills, '.githooks', 'pre-commit'), 0o755);
  const antes = { arnes: commitear(fx.arnes, 'el lado del arnés, antes de los choques'), skills: commitear(fx.skills, 'el lado de agent-skills, antes de los choques') };

  // la unión: del lado del arnés, su pre-commit pasa a ser una parte, entra el despachador y el .gitignore es el unido
  gitFx(fx.arnes, ['mv', '.githooks/pre-commit', '.githooks/pre-commit-harness']);
  escribir(fx.arnes, { '.githooks/pre-commit': ex.PRE_COMMIT_DISPATCHER, '.gitignore': joinedIgnore(HARNESS_IGNORE, SKILLS_IGNORE) });
  fs.chmodSync(path.join(fx.arnes, '.githooks', 'pre-commit'), 0o755);
  commitear(fx.arnes, 'los tres choques, del lado del arnés');
  // del lado de agent-skills: su pre-commit pasa a ser la otra parte; su .gitignore y su README no entran
  gitFx(fx.skills, ['mv', '.githooks/pre-commit', '.githooks/pre-commit-skills']);
  gitFx(fx.skills, ['rm', '-q', '.gitignore', 'README.md']);
  const resuelto = commitear(fx.skills, 'los tres choques, del lado de agent-skills');
  gitFx(fx.arnes, ['fetch', '-q', fx.skills, 'main']);
  reloj += 100;
  const fecha = `@${reloj} +0000`;
  gitFx(fx.arnes, ['merge', '-q', '--allow-unrelated-histories', '--no-edit', '-m', 'la unión', resuelto], { env: { GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  return { fx, lista, antes, union: gitFx(fx.arnes, ['rev-parse', 'HEAD']) };
}

/** El exportador sobre el repo unido: sin ningún otro clon a la vista (ni TYCON_SKILLS_DIR ni el lugar de instalación). */
function exportUnified(fx, args, env = {}) {
  const casa = path.join(fx.dir, 'casa-vacia');
  fs.mkdirSync(casa, { recursive: true });
  return exportar(fx, args, { env: { TYCON_SKILLS_DIR: path.join(fx.dir, 'no-hay-otro-clon'), HOME: casa, ...env } });
}

// ── story 8.18, pase adversarial del tramo 2 (clase 13): un --harness que no existe se dice por su nombre ─────────────
// En el repo unido, un commit del arnés que no se encuentra no decidía nada sobre «¿es unido?», el exportador se iba a
// buscar el otro clon y el error decía «el repo fuente agent-skills no está en …»: salía 2 igual, pero mandaba a
// arreglar otra cosa. Pasaba sólo con TYCON_SKILLS_DIR apuntando a una carpeta que no existe.
test('Export_UnifiedRepo_MissingHarnessRef_NamesTheCommit — un commit del arnés que no existe es «no encuentro el commit», no «falta agent-skills»', () => {
  const { fx } = unifiedFixture();
  // (sin --harness el default es origin/main, que este laboratorio trae: el caso es el mismo con cualquier ref ausente)
  for (const [what, args] of [['--harness que no existe', ['--harness', 'no-existe']]]) {
    const ref = 'no-existe';
    // 🔴 rojo previo: «el repo fuente agent-skills no está en …/no-hay-otro-clon»
    const r = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', fx.salida(`ref-${args.length}`), ...args, '--json']);
    assert.strictEqual(r.code, 2, `${what}: ${r.err}\n${r.out}`);
    assert.match(r.json.motivo, new RegExp(`no encuentro el commit «${ref}» en arnes`), what);
    assert.doesNotMatch(r.json.motivo, /agent-skills no está/, `${what}: no manda a buscar otro clon`);
    // --explain, lo mismo
    const casa = path.join(fx.dir, 'casa-vacia');
    const ej = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json', '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, ...args],
      { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: path.join(fx.dir, 'no-hay-otro-clon'), HOME: casa } });
    assert.strictEqual(ej.status, 2, `${what} (--explain): ${ej.stderr}`);
    assert.match(`${ej.stdout}${ej.stderr}`, new RegExp(`no encuentro el commit «${ref}» en arnes`), `${what} (--explain)`);
  }
  // el espejo: con el commit que sí está, el repo unido exporta sin buscar ningún otro clon
  const ok = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', fx.salida('ref-ok'), '--harness', 'HEAD', '--json']);
  assert.strictEqual(ok.code, 0, `${ok.err}\n${ok.out}`);
  assert.strictEqual(ok.json.physicalSources, 1);
});

// ── T19 · story 8.18, AC 19 y 22 ───────────────────────────────────────────────────────────────────────────────────────
test('Export_OnePhysicalSource_SplitByPath_TwoReposStillWork', () => {
  // 🔴 rojo previo: el exportador busca agent-skills en otro clon («el repo fuente agent-skills no está en …», exit 2)
  const ex = require(EXPORTAR);
  assert.strictEqual(typeof ex.PRE_COMMIT_DISPATCHER, 'string', 'el exportador exporta el texto del despachador (lo lee union-check.js)');
  const { fx, antes, union } = unifiedFixture();

  // (a) dos repos físicos, en los commits de antes de la unión: como hoy —aunque el clon del arnés ya sea el unido—
  const dos = fx.salida('u-dos-repos');
  const rDos = exportar(fx, ['--package', 'core', '--single-repo', '--output', dos, '--harness', antes.arnes, '--agent-skills', antes.skills, '--json']);
  assert.strictEqual(rDos.code, 0, `${rDos.err}\n${rDos.out}`);
  assert.deepStrictEqual(ajustesDe(rDos.json, 'merged-gitignore'), ['agent-skills/.gitignore', 'arnes/.gitignore'], 'con dos fuentes físicas, lo de hoy');
  assert.deepStrictEqual(ajustesDe(rDos.json, 'merged-hooks'), ['.githooks/pre-commit', 'agent-skills/.githooks/pre-commit', 'arnes/.githooks/pre-commit']);
  assert.notStrictEqual(rDos.json.fuentes.arnes.sha, rDos.json.fuentes['agent-skills'].sha, 'control: dos commits, uno por repo');

  // (b) el repo unido: UNA fuente física. Ningún otro clon a la vista, y sale igual
  const uno = fx.salida('u-unido');
  const r = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', uno, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(r.json.fuentes.arnes.sha, union, 'la fuente arnes es el commit de la unión');
  assert.strictEqual(r.json.fuentes['agent-skills'].sha, union, 'y la fuente agent-skills, el mismo commit');
  assert.deepStrictEqual(ajustesDe(r.json, 'merged-gitignore'), [], 'AC 22: con una fuente física merged-gitignore no hace nada');
  assert.deepStrictEqual(ajustesDe(r.json, 'merged-hooks'), [], 'AC 22: ni merged-hooks: lo que sale es lo que hay');
  assert.deepStrictEqual(r.json.globsSinUso, [], 'el «in» .gitignore de agent-skills no es un glob muerto: la unión lo dejó del lado del arnés');
  const meta = gitFx(uno, ['cat-file', '-p', 'HEAD']);
  assert.match(meta, new RegExp(`\\narnes: ${union}\\nagent-skills: ${union}$`), 'el mensaje cita las dos fuentes, con el mismo commit');
  assert.strictEqual(r.json.physicalSources, 1, 'el --json dice de cuántos repos se leyó: uno');
  assert.strictEqual(rDos.json.physicalSources, 2, 'y con dos repos, dos');
  // partido por ruta: las tres partes del pre-commit, cada una de su fuente y ejecutable
  assert.strictEqual(leer(uno, '.githooks/pre-commit'), ex.PRE_COMMIT_DISPATCHER);
  assert.strictEqual(leer(uno, '.githooks/pre-commit-harness'), HARNESS_HOOK);
  assert.strictEqual(leer(uno, '.githooks/pre-commit-skills'), SKILLS_HOOK);
  for (const h of ['.githooks/pre-commit', '.githooks/pre-commit-harness', '.githooks/pre-commit-skills']) {
    assert.ok(fs.statSync(path.join(uno, h)).mode & 0o100, `${h} ejecutable`);
  }
  assert.ok(!existe(uno, '.tycon'), '.tycon/ queda afuera en las dos fuentes');
  // el mismo árbol que con dos repos, carpeta de primer nivel por carpeta de primer nivel, salvo el .gitignore
  const a = firstLevelOf(dos);
  const d = firstLevelOf(uno);
  assert.deepStrictEqual([...d.keys()], [...a.keys()], 'las mismas entradas de primer nivel');
  assert.deepStrictEqual([...a.keys()].filter((k) => a.get(k) !== d.get(k)), ['.gitignore'], 'la única entrada que difiere es el .gitignore');
  const ignUno = splitPrivateBlock(leer(uno, '.gitignore'));
  const ignDos = splitPrivateBlock(leer(dos, '.gitignore'));
  assert.deepStrictEqual(linesOf(ignUno.own), linesOf(ignDos.own).filter((l) => !ADVISORS_BLOCK.includes(l)),
    'y difiere exactamente en el bloque .advisors/ de agent-skills (su línea y su comentario)');
  // story 8.26 (AC 30): las carpetas de las que no sale nada, ignoradas en las dos y con el mismo bloque. Con dos repos
  // `.advisors/` ya la ignoraba la línea de agent-skills, y el bloque la lleva igual: depende del árbol, no de lo que
  // el .gitignore ya diga (si no, la unión —que no se llevó esa línea— tendría una diferencia más que la declarada)
  assert.ok(ignDos.folders.includes('/.advisors/') && ignDos.folders.includes('/.tycon/'), `control: el bloque trae las carpetas de las que no sale nada (${ignDos.folders.join(' ')})`);
  assert.deepStrictEqual(ignUno.folders, ignDos.folders, 'el mismo bloque de carpetas desde dos repos que desde su unión');
  assert.ok(linesOf(leer(dos, '.gitignore')).includes('.advisors/'), 'control: con dos repos el bloque salía');
  assert.ok(!leer(uno, '.gitignore').includes('!.advisors/dod-runtime/'), 'gitignore-publico sigue sacando la línea «!…» bajo una exclusión fija');
  assert.strictEqual(r.json.archivos.arnes + r.json.archivos['agent-skills'], listar(uno).length, 'cada archivo de la copia es de una de las dos fuentes lógicas');

  // (c) --explain: el primer nivel, partido por ruta
  const casa = path.join(fx.dir, 'casa-vacia');
  const ej = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json', '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD'],
    { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: path.join(fx.dir, 'no-hay-otro-clon'), HOME: casa } });
  assert.strictEqual(ej.status, 0, ej.stderr);
  const explicado = JSON.parse(ej.stdout);
  const nivel = (f) => explicado.primerNivel.filter((x) => x.fuente === f).map((x) => x.entrada);
  assert.deepStrictEqual(nivel('agent-skills'), ['.githooks', '.tycon', 'agents', 'packs', 'skills'], 'la fuente lógica agent-skills: sus tres carpetas y sus dos archivos sueltos');
  assert.ok(!nivel('arnes').some((x) => ['agents', 'packs', 'skills'].includes(x)), 'la fuente arnes no trae las carpetas de agent-skills');
  assert.ok(nivel('arnes').includes('.gitignore') && nivel('arnes').includes('.githooks') && nivel('arnes').includes('.tycon'));
  assert.deepStrictEqual(explicado.sinClasificar, []);
  assert.strictEqual(explicado.fuentes.arnes.sha, union);
  assert.strictEqual(explicado.fuentes['agent-skills'].sha, union, 'sin --agent-skills, la fuente lógica sigue al arnés');

  // (d) una máquina en transición: el clon viejo de agent-skills sigue ahí, en otro commit. No se lee
  escribir(fx.skills, { 'skills/tycon-pipeline/extra.md': '# sólo está en el clon viejo: no sale\n' });
  commitear(fx.skills, 'un commit que sólo está en el clon viejo');
  const conViejo = fx.salida('u-con-el-clon-viejo');
  const rv = exportar(fx, ['--package', 'core', '--single-repo', '--output', conViejo, '--json']);
  assert.strictEqual(rv.code, 0, `${rv.err}\n${rv.out}`);
  assert.strictEqual(gitFx(conViejo, ['rev-parse', 'HEAD']), gitFx(uno, ['rev-parse', 'HEAD']), 'con el clon viejo a la vista, la misma copia: no se leyó');

  // (e) --agent-skills distinto de --harness en el repo unido: 2, y lo dice
  const mal = fx.salida('u-refs-distintos');
  const rm = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', mal, '--agent-skills', 'HEAD~1']);
  assert.strictEqual(rm.code, 2, `${rm.err}\n${rm.out}`);
  assert.match(rm.err, /--agent-skills/);
  assert.match(rm.err, /un solo repo|repo unido/);
  assert.ok(!fs.existsSync(mal), 'sin salida');
  // … y el mismo commit dicho de otra forma no es «distinto»
  const igual = fx.salida('u-refs-iguales');
  const ri = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', igual, '--harness', 'main', '--agent-skills', union]);
  assert.strictEqual(ri.code, 0, `${ri.err}\n${ri.out}`);
  assert.strictEqual(gitFx(igual, ['rev-parse', 'HEAD']), gitFx(uno, ['rev-parse', 'HEAD']));
  // … y uno que no existe sigue siendo «no encuentro el commit»
  const rn = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', fx.salida('u-ref-roto'), '--agent-skills', 'no-existe']);
  assert.strictEqual(rn.code, 2, `${rn.err}\n${rn.out}`);
  assert.match(rn.err, /no encuentro el commit «no-existe»/);

  // (f) sin --single-repo, el repo unido también arma la copia de dos repos de siempre. Ahí el despachador no sirve
  // (llamaría a una parte que quedó en el OTRO repo y ningún commit se podría crear): cada parte vuelve a ser el
  // .githooks/pre-commit del repo de su fuente — `split-hooks`, lo contrario de merged-hooks
  // 🔴 rojo previo: el repo «arnes» de la copia salía con el despachador y sin pre-commit-skills (export-real T21: «No such file»)
  const par = fx.salida('u-dos-carpetas');
  const rp = exportUnified(fx, ['--package', 'core', '--output', par, '--json']);
  assert.strictEqual(rp.code, 0, `${rp.err}\n${rp.out}`);
  assert.ok(existe(par, 'agent-skills/skills/tycon-pipeline/SKILL.md') && !existe(par, 'arnes/skills'), 'cada fuente lógica, en su repo');
  assert.strictEqual(leer(par, 'arnes/.githooks/pre-commit'), HARNESS_HOOK, 'el pre-commit del repo arnes es SU parte, no el despachador');
  assert.strictEqual(leer(par, 'agent-skills/.githooks/pre-commit'), SKILLS_HOOK, 'y el de agent-skills, la suya');
  for (const sobra of ['arnes/.githooks/pre-commit-harness', 'arnes/.githooks/pre-commit-skills', 'agent-skills/.githooks/pre-commit-skills', 'agent-skills/.githooks/pre-commit-harness']) {
    assert.ok(!existe(par, sobra), `${sobra} no sale en la copia de dos repos`);
  }
  for (const f of ['arnes', 'agent-skills']) assert.ok(fs.statSync(path.join(par, f, '.githooks', 'pre-commit')).mode & 0o100, `${f}/.githooks/pre-commit ejecutable`);
  assert.deepStrictEqual(ajustesDe(rp.json, 'split-hooks'), ['agent-skills/.githooks/pre-commit', 'arnes/.githooks/pre-commit'], 'ningún archivo cambia sin su ajuste');
  // y es la copia de dos repos de siempre: contra la que sale de los dos repos físicos, sólo cambia el .gitignore
  const parAntes = fx.salida('u-dos-carpetas-antes');
  const rpa = exportar(fx, ['--package', 'core', '--output', parAntes, '--harness', antes.arnes, '--agent-skills', antes.skills, '--json']);
  assert.strictEqual(rpa.code, 0, `${rpa.err}\n${rpa.out}`);
  assert.deepStrictEqual(ajustesDe(rpa.json, 'split-hooks'), [], 'con dos repos físicos no hay nada que repartir');
  const filesOf = (repo) => new Map(gitFx(repo, ['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean).map((l) => [l.split('\t')[1], l.split('\t')[0]]));
  for (const [f, soloAntes] of [['arnes', []], ['agent-skills', ['.gitignore']]]) {
    const x = filesOf(path.join(parAntes, f));
    const y = filesOf(path.join(par, f));
    const distintos = [...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)).sort();
    assert.deepStrictEqual(distintos, ['.gitignore'], `${f}: el mismo repo de la copia, salvo el .gitignore`);
    assert.deepStrictEqual([...x.keys()].filter((k) => !y.has(k)), soloAntes, `${f}: lo único que deja de salir`);
  }
  // la clasificación (`whatShips`) de un contexto armado por prepararFuentes dice lo mismo que esa copia: una fuente
  // física aunque le den dos carpetas, y los mismos archivos
  const ctx = { repos: { arnes: { dir: fx.arnes }, 'agent-skills': { dir: fx.skills } } };
  ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, fx.cfg);
  assert.strictEqual(ctx.unified, true, 'prepararFuentes reconoce el commit del repo unido');
  assert.strictEqual(ctx.repos['agent-skills'].dir, fx.arnes, 'y lee agent-skills del mismo repo, no de la otra carpeta');
  const core = ex.whatShips(ctx).packages.find((p) => p.pkg === 'core');
  assert.deepStrictEqual([...core.files.entries()].filter(([, a]) => a.kind !== 'synthetic-source').map(([k]) => k).sort(), listar(par), 'la clasificación trae los archivos de la copia de dos repos');
  // el control de commit del repo «arnes» de la copia anda solo: su hook corre y el commit se crea
  escribir(path.join(par, 'arnes'), { 'scripts/otro.js': "'use strict';\n" });
  gitFx(path.join(par, 'arnes'), ['add', '-A']);
  const conHook = spawnSync('git', ['-C', path.join(par, 'arnes'), '-c', 'core.hooksPath=.githooks', 'commit', '-q', '-m', 'con el pre-commit de la copia'], {
    encoding: 'utf8', env: { ...sinGit(process.env), ...GIT_AISLADO, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' },
  });
  assert.strictEqual(conHook.status, 0, `el commit con el pre-commit del repo arnes de la copia se crea: ${conHook.stderr}`);
  assert.strictEqual(gitFx(path.join(par, 'arnes'), ['rev-list', '--count', 'HEAD']), '2');

  // (g) C6: version.json conserva las dos claves, con el mismo commit
  fx.config({ lista: { ...JSON.parse(fs.readFileSync(fx.cfg.lista, 'utf8')), generated: [{ target: 'version.json', reason: 'la versión numerada de la copia' }] } });
  const conVersion = fx.salida('u-version');
  const rg = exportUnified(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', conVersion, '--json']);
  assert.strictEqual(rg.code, 0, `${rg.err}\n${rg.out}`);
  // (story 8.13.1, AC 6: y la lista de transformados de la corrida, la misma que trae el --json)
  assert.deepStrictEqual(JSON.parse(leer(conVersion, 'version.json')), { version: VERSION_DE_PRUEBA, source: { harness: union, agent_skills: union }, transformed: rg.json.transformed });
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.18, revisión del tramo 2 (vuelta 1): split-hooks con una parte que falta sale 2 y la nombra ─────────────────
// `splitHooks` volvía sin decir nada si faltaba una de las dos partes del pre-commit: la copia de dos repos salía con el
// despachador, que llama a un archivo que no está, y ningún commit se podía crear en ese repo de la copia. Ahora sale 2
// nombrando la parte que falta. Su error «ya sale» (una parte que iría donde ya hay un pre-commit) no se alcanza desde
// un repo de verdad —la partición por ruta nunca pone `.githooks/pre-commit` en agent-skills—: se fuerza llamando a la
// función, como las demás que «su prueba fuerza el camino de error».
test('Export_UnifiedRepo_SplitHooks_MissingPart_ExitsTwoNamingIt', () => {
  // 🔴 rojo previo: exit 0, y el repo «arnes» de la copia salía con el despachador y sin la parte que faltaba
  for (const [part, kept] of [['.githooks/pre-commit-skills', 'pre-commit-harness'], ['.githooks/pre-commit-harness', 'pre-commit-skills']]) {
    const { fx, lista } = unifiedFixture();
    gitFx(fx.arnes, ['rm', '-q', part]);
    commitear(fx.arnes, `sin ${part}`);
    if (part.endsWith('-skills')) {
      // la parte de skills es lo único de `.githooks/` que va a agent-skills: sin ella su «in» `.githooks/**` sería un glob
      // muerto, que ya sale 2 por otro motivo. Sin ese glob, el caso llega a split-hooks (una lista que no la publica)
      const sinGlob = clonar(lista);
      sinGlob.packages.core['agent-skills'].in = sinGlob.packages.core['agent-skills'].in.filter((g) => g !== '.githooks/**');
      fx.config({ lista: sinGlob });
    }
    const salida = fx.salida(`split-sin-${path.basename(part)}`);
    const r = exportUnified(fx, ['--package', 'core', '--output', salida, '--json']);
    assert.strictEqual(r.code, 2, `sin ${part}: ${r.err}\n${r.out}`);
    assert.match(r.json.motivo, /split-hooks/, `sin ${part}: lo dice la transformación`);
    assert.ok(r.json.motivo.includes(part), `sin ${part}: nombra la parte que falta — ${r.json.motivo}`);
    // la parte que está no aparece en el motivo en NINGUNA forma (vuelta 2 del revisor de pruebas: «falta A y B» no
    // contenía «falta B» y pasaba)
    assert.ok(!r.json.motivo.includes(kept), `sin ${part}: no nombra la que está (${kept}) — ${r.json.motivo}`);
    assert.ok(!fs.existsSync(salida), `sin ${part}: sin salida`);
  }
  // el espejo: con las dos partes, la copia de dos repos sale (T19 (f) mide qué sale)
  const { fx } = unifiedFixture();
  const r = exportUnified(fx, ['--package', 'core', '--output', fx.salida('split-con-las-dos'), '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.deepStrictEqual(ajustesDe(r.json, 'split-hooks'), ['agent-skills/.githooks/pre-commit', 'arnes/.githooks/pre-commit']);
});

test('Export_SplitHooks_Direct_PartAlreadyThere_DispatcherAlone_NothingToSplit', () => {
  const ex = require(EXPORTAR);
  assert.strictEqual(typeof ex.splitHooks, 'function', 'el exportador exporta splitHooks (su prueba fuerza el camino de error)');
  const b = (t) => ({ datos: Buffer.from(t, 'utf8') });
  const full = () => new Map([
    ['arnes/.githooks/pre-commit', b(ex.PRE_COMMIT_DISPATCHER)],
    ['arnes/.githooks/pre-commit-harness', b(HARNESS_HOOK)],
    ['agent-skills/.githooks/pre-commit-skills', b(SKILLS_HOOK)],
  ]);
  // «ya sale»: una parte iría donde ya hay un pre-commit de esa fuente → NoPudo, no se pisa
  const pisada = full();
  pisada.set('agent-skills/.githooks/pre-commit', b('#!/usr/bin/env bash\n# otro\n'));
  assert.throws(() => ex.splitHooks(pisada, []), (e) => e instanceof ex.NoPudo && /split-hooks: agent-skills\/\.githooks\/pre-commit ya sale/.test(e.message));
  // una sola parte, directo: NoPudo nombrando la que falta
  for (const missing of ['arnes/.githooks/pre-commit-harness', 'agent-skills/.githooks/pre-commit-skills']) {
    const copia = full();
    copia.delete(missing);
    assert.throws(() => ex.splitHooks(copia, []), (e) => e instanceof ex.NoPudo && e.message.includes(missing.replace(/^[^/]+\//, '')), `sin ${missing}`);
  }
  // el despachador solo, sin ninguna de sus partes: también NoPudo (llamaría a dos archivos que no están)
  const solo = new Map([['arnes/.githooks/pre-commit', b(ex.PRE_COMMIT_DISPATCHER)]]);
  assert.throws(() => ex.splitHooks(solo, []), (e) => e instanceof ex.NoPudo && /pre-commit-harness/.test(e.message) && /pre-commit-skills/.test(e.message));
  // los espejos: sin ningún pre-commit (una lista blanca que deja .githooks/ afuera) no hay nada que partir…
  const nada = new Map([['arnes/README.md', b('# x\n')]]);
  const ajustesNada = [];
  ex.splitHooks(nada, ajustesNada);
  assert.deepStrictEqual([[...nada.keys()], ajustesNada], [['arnes/README.md'], []]);
  // …y con las dos partes se parte, con un ajuste por archivo
  const sano = full();
  const ajustes = [];
  ex.splitHooks(sano, ajustes);
  assert.deepStrictEqual([...sano.keys()].sort(), ['agent-skills/.githooks/pre-commit', 'arnes/.githooks/pre-commit']);
  assert.strictEqual(sano.get('arnes/.githooks/pre-commit').datos.toString('utf8'), HARNESS_HOOK);
  assert.deepStrictEqual(ajustes.map((a) => a.archivo), ['arnes/.githooks/pre-commit', 'agent-skills/.githooks/pre-commit']);
});

// ── T21 · story 8.18, AC 20 — lo privado sigue afuera, las mismas exclusiones, ningún glob muerto ──────────────────────
test('Export_PrivateStaysOut_SameExclusions_NoDeadGlobs', () => {
  const { fx, lista, antes } = unifiedFixture();
  const explicar = (extra, env) => {
    const r = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json', '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, ...extra],
      { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, ...env } });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const casa = path.join(fx.dir, 'casa-vacia');
  fs.mkdirSync(casa, { recursive: true });
  const sinOtroClon = { TYCON_SKILLS_DIR: path.join(fx.dir, 'no-hay-otro-clon'), HOME: casa };
  const a = explicar(['--harness', antes.arnes, '--agent-skills', antes.skills], { TYCON_SKILLS_DIR: fx.skills });
  const d = explicar(['--harness', 'HEAD'], sinOtroClon);
  // 0 sin clasificar y 0 globs muertos, antes y después
  assert.deepStrictEqual([a.sinClasificar, d.sinClasificar], [[], []]);
  assert.deepStrictEqual([a.exclusionesSinArchivo, d.exclusionesSinArchivo], [[], []]);
  // las mismas exclusiones fijas, y cada exclusión cubre los mismos archivos; lo único que cambia es el README de
  // agent-skills, que no entró a la unión (manda el del arnés)
  assert.deepStrictEqual(d.exclusionesFijas, a.exclusionesFijas);
  const fila = (x) => `${x.origen}|${x.paquete || ''}|${x.fuente}|${x.glob !== undefined ? x.glob : `#${x.indice}`}`;
  const cuenta = (e) => new Map(e.coberturaExclusiones.map((x) => [fila(x), x.archivos]));
  const distintas = [...cuenta(a)].filter(([k, n]) => cuenta(d).get(k) !== n).map(([k, n]) => `${k}: ${n} → ${cuenta(d).get(k)}`);
  assert.deepStrictEqual(distintas, ['afuera|core|agent-skills|README.md: 1 → 0'], 'la misma lista de excluidos, salvo el README que la unión no trajo');
  assert.deepStrictEqual([...cuenta(d).keys()], [...cuenta(a).keys()], 'las mismas filas');

  // nada privado sale del repo unido: ni las skills de proyectos ni la infraestructura, ni el paquete de clientes, ni
  // su revisor con sus superficies
  const sAntes = fx.salida('u21-dos-repos');
  const rAntes = exportar(fx, ['--package', 'core,bizuit', '--single-repo', '--output', sAntes, '--harness', antes.arnes, '--agent-skills', antes.skills, '--json']);
  assert.strictEqual(rAntes.code, 0, `${rAntes.err}\n${rAntes.out}`);
  const s = fx.salida('u21');
  const r = exportUnified(fx, ['--package', 'core,bizuit', '--single-repo', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const sale = listar(s);
  assert.deepStrictEqual(sale, listar(sAntes), 'salen exactamente los mismos archivos que con dos repos');
  assert.deepStrictEqual(r.json.excluidosFijos, rAntes.json.excluidosFijos, 'y las exclusiones fijas dejan afuera lo mismo, contado en su fuente lógica');
  for (const privado of [/^skills\/projects\//, /^skills\/infrastructure\//, /^packs\/clients\//, /revisor-cliente/, /^\.tycon\//, /denylist|replacements/]) {
    assert.deepStrictEqual(sale.filter((p) => privado.test(p)), [], `${privado} no sale`);
  }
  assert.ok(sale.includes('packs/bizuit/pack.json') && sale.includes('agents/tycon-plugin-dotnet-conventions.md'), 'control: el paquete pedido sí sale, entero');
  assert.deepStrictEqual(r.json.globsSinUso, []);
  assert.deepStrictEqual(r.json.entradasSinClasificar, []);

  // el espejo: en el repo unido un glob muerto de verdad sigue siendo 2 …
  const muerta = clonar(lista);
  muerta.packages.core['agent-skills'].in.push('skills/no-existe/**');
  fx.config({ lista: muerta });
  let malo = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', fx.salida('u21-muerto'), '--json']);
  assert.strictEqual(malo.code, 2, `${malo.err}\n${malo.out}`);
  assert.deepStrictEqual(malo.json.globsSinUso, ['agent-skills: skills/no-existe/**']);
  // … y una entrada nueva del primer nivel sin clasificar, también, nombrada en su fuente lógica
  fx.config({ lista });
  escribir(fx.arnes, { 'carpeta-nueva/x.md': '# x\n', 'packs/otro/pack.json': '{ "name": "otro", "reviewers": [] }\n' });
  commitear(fx.arnes, 'una carpeta nueva sin clasificar');
  malo = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', fx.salida('u21-sin-clasificar'), '--json']);
  assert.strictEqual(malo.code, 2, `${malo.err}\n${malo.out}`);
  assert.deepStrictEqual(malo.json.entradasSinClasificar, ['arnes/carpeta-nueva'], 'packs/otro/ ya está clasificado en agent-skills (un afuera de la lista)');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T16 · story 8.17, tanda W1, AC 12 — el .gitattributes viaja a la raíz de la copia ──────────────────────────────────
// Sin él, quien clona la copia en Windows (core.autocrlf=true de fábrica) recibe los guiones de bash con \r\n. Sale el
// del arnés; el de agent-skills queda afuera con su motivo: en un solo repo los dos caerían en la misma ruta.
test('T16 Export_PublicCopy_ShipsGitattributes', () => {
  const REGLAS = '* text=auto eol=lf\n*.gz binary\n';
  const fx = fixture();
  escribir(fx.arnes, { '.gitattributes': REGLAS });
  escribir(fx.skills, { '.gitattributes': REGLAS });
  commitear(fx.arnes, 'finales de línea');
  commitear(fx.skills, 'finales de línea');

  // la lista real lo dice: entra por el arnés y, en agent-skills, queda afuera con su motivo
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'allowlist.json'), 'utf8')).packages.core;
  assert.ok(real.arnes.in.includes('.gitattributes'), 'allowlist.json: core.arnes.in trae .gitattributes');
  const afuera = real['agent-skills'].out.find((x) => x.glob === '.gitattributes');
  assert.ok(afuera && afuera.reason.length > 40, 'allowlist.json: el de agent-skills queda afuera, con su motivo');
  assert.ok(!real['agent-skills'].in.includes('.gitattributes'));

  // sin clasificar, la exportación no sale: una entrada nueva del primer nivel no viaja ni se pierde en silencio
  let r = exportar(fx, ['--package', 'core', '--single-repo', '--output', fx.salida('t16-sin'), '--json']);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /sin clasificar: [^\n]*\.gitattributes/);

  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.in.push('.gitattributes');
  lista.packages.core['agent-skills'].out.push({ glob: '.gitattributes', reason: afuera.reason });
  fx.config({ lista });

  // --explain --json: la tabla del primer nivel lo muestra en las dos fuentes, con el motivo del que queda afuera
  const e = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json',
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
  assert.strictEqual(e.status, 0, e.stderr);
  const tabla = JSON.parse(e.stdout);
  const fila = (fuente) => tabla.primerNivel.find((x) => x.fuente === fuente && x.entrada === '.gitattributes');
  assert.deepStrictEqual(fila('arnes').reglas.map((x) => [x.tipo, x.detalle]), [['entra', 'core']]);
  assert.deepStrictEqual(fila('agent-skills').reglas.map((x) => [x.tipo, x.detalle]), [['afuera', afuera.reason]]);
  assert.deepStrictEqual(tabla.sinClasificar, []);

  // la exportación de laboratorio, en un solo repo: está en la raíz, byte a byte, y los finales de línea son los suyos
  const s = fx.salida('t16');
  r = exportar(fx, ['--package', 'core', '--single-repo', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(s, '.gitattributes'), REGLAS);
  assert.ok(archivosDelCommit(s).includes('.gitattributes'), 'está en el commit de la copia, no sólo en el disco');
  assert.match(gitFx(s, ['check-attr', 'eol', '--', 'scripts/hola.js']), /eol: lf$/, 'y en la copia la regla ya rige');
  // y con un repo por fuente: sale en el del arnés
  const dos = fx.salida('t16-dos');
  r = exportar(fx, ['--package', 'core', '--output', dos, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(path.join(dos, 'arnes'), '.gitattributes'), REGLAS);
  assert.ok(!existe(path.join(dos, 'agent-skills'), '.gitattributes'));

  // el control del rojo: si los DOS entran, en un solo repo chocan — por eso uno queda afuera
  const chocan = clonar(LISTA_BASE);
  chocan.packages.core.arnes.in.push('.gitattributes');
  chocan.packages.core['agent-skills'].in.push('.gitattributes');
  fx.config({ lista: chocan });
  r = exportar(fx, ['--package', 'core', '--single-repo', '--output', fx.salida('t16-chocan'), '--json']);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(r.err, /la misma ruta llega de las dos fuentes[^\n]*\.gitattributes/);
});

test.after(() => {
  for (const d of [...creados, plantilla && plantilla.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

// ── story 8.16, tanda E (AC 41, T58) — los dos guiones de entrada de la portada ────────────────────────────────────
// `get-harness.sh` y `get-harness.ps1` son papeles: viven en public-files/ con los marcadores y llegan a
// `scripts/setup/` de la copia por un sintético, con la dirección del repo público ya puesta. `--explain --json` lista
// los sintéticos (con su origen y su motivo), como ya listaba los generados. En el interno no existen en scripts/setup/.
const ENTRY_SCRIPTS = ['scripts/setup/get-harness.sh', 'scripts/setup/get-harness.ps1'];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// El papel real `rel` (con sus marcadores), para dárselo de entrada al arnés de mentira. En el interno se lee de
// public-files/. En la copia pública los papeles no viajan: llegan a su destino (la misma ruta relativa) con el nombre
// real ya puesto por un reemplazo literal, así que se deshace ese reemplazo; el nombre sale de la línea REPO="<org>/<repo>"
// del guion de bash publicado (desde la story 8.23, tanda E, lo baja por la API; antes era SOURCE= con la URL de clon, que
// se sigue aceptando). Sin esa línea la copia está rota: se dice, no se saltea.
function papelReal(rel) {
  if (fs.existsSync(path.join(RAIZ, PAPELES, ENTRY_SCRIPTS[0]))) return fs.readFileSync(path.join(RAIZ, PAPELES, rel), 'utf8');
  const guion = fs.readFileSync(path.join(RAIZ, ENTRY_SCRIPTS[0]), 'utf8');
  const m = /^REPO="([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)"$/m.exec(guion)
    || /^SOURCE="https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)"$/m.exec(guion);
  assert.ok(m, `copia pública: ${ENTRY_SCRIPTS[0]} no trae su línea REPO="<org>/<repo>"`);
  const [, org, repo] = m;
  return fs.readFileSync(path.join(RAIZ, rel), 'utf8').split(`${org}/${repo}`).join('{{public-org}}/{{public-repo}}').split(repo).join('{{public-repo}}');
}

// 🔴 rojo previo: ENOENT de los dos guiones en public-files/, y un --explain --json sin la clave «synthetic»
test('Export_GetHarness_ByPlaceholder_InternalNeverNamesPublicRepo — la copia los trae con la dirección puesta', () => {
  const fx = fixture();
  const sources = Object.fromEntries(ENTRY_SCRIPTS.map((g) => [g, papelReal(g)]));
  // el párrafo del guion de las dos portadas reales (sólo ese párrafo: el resto de la portada enlaza a archivos que la
  // fixture no tiene): nombra la carpeta del guion por el marcador, y el exportador lo reemplaza (revisión de la tanda E)
  // De dónde sale hoy el bloque install:core de cada portada: desde que la referencia se mudó de la portada a
  // getting-started/ (2026-10-13), vive en la referencia de cada idioma. La portada de juguete lo sigue llevando.
  const blockSource = { '.github/README.md': 'getting-started/reference.md', '.github/README.es.md': 'getting-started/reference.es.md' };
  for (const readme of ['.github/README.md', '.github/README.es.md']) {
    // desde la story 8.23 (tanda E) el guion ES el bloque install:core de la portada: se toma ese bloque (nombra la
    // dirección por los marcadores, y el exportador la reemplaza)
    const real = papelReal(blockSource[readme]);
    const close = '<!-- /install:core -->';
    const start = real.indexOf('<!-- install:core -->');
    const end = real.indexOf(close);
    assert.ok(start >= 0 && end > start, `${readme}: falta el bloque install:core`);
    sources[readme] = `# Portada de prueba\n\n${real.slice(start, end + close.length)}\n`;
  }
  fx.config({ lista: conPapeles(fx, sources) });
  commitear(fx.arnes, 'los guiones de entrada');
  for (const g of ENTRY_SCRIPTS) assert.ok(!existe(fx.arnes, g), `control: en el interno ${g} no está en scripts/setup/`);

  const s = fx.salida('guiones');
  const r = exportar(fx, ['--package', 'core', '--single-repo', '--output', s, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  for (const g of ENTRY_SCRIPTS) {
    const text = leer(s, g);
    // desde la story 8.23 (tanda E) el guion nombra el repo como org/nombre (lo baja por la API), no como URL de clon
    assert.ok(text.includes('example-org/example-harness'), `${g}: la dirección del repo público, ya puesta`);
    assert.doesNotMatch(text, /\{\{public-/, `${g}: ningún marcador sin reemplazar`);
    assert.ok(ajustesDe(r.json, 'public-name').includes(`arnes/${g}`), `${g}: el reemplazo queda en los ajustes`);
    assert.ok(!existe(s, `${PAPELES}/${g}`), `${g}: la plantilla no viaja`);
  }
  assert.deepStrictEqual(r.json.controles.handWrittenPublicUrl, [], 'los marcadores no son una URL escrita a mano');
  for (const readme of ['.github/README.md', '.github/README.es.md']) {
    assert.ok(leer(s, readme).includes('https://api.github.com/repos/example-org/example-harness/contents/scripts/setup/get-harness.'), `${readme}: la bajada del guion por la API, con el nombre público ya puesto`);
    assert.doesNotMatch(leer(s, readme), /\{\{public-/, `${readme}: ningún marcador sin reemplazar`);
  }
  // el de bash, con la carpeta de fábrica ya nombrada, y sintaxis limpia
  assert.ok(leer(s, ENTRY_SCRIPTS[0]).split('\n').includes('REPO="example-org/example-harness"'), 'get-harness.sh: la dirección de fábrica es el repo público (org/nombre)');
  const syntax = spawnSync('bash', ['-n', path.join(s, ENTRY_SCRIPTS[0])], { encoding: 'utf8' });
  assert.strictEqual(syntax.status, 0, `bash -n de la copia: ${syntax.stderr}`);
  // el de PowerShell conserva su BOM (Windows PowerShell 5.1 lee mal un .ps1 sin él)
  assert.ok(fs.readFileSync(path.join(s, ENTRY_SCRIPTS[1])).subarray(0, 3).equals(BOM), 'get-harness.ps1: la copia conserva el BOM UTF-8');

  // --explain --json: los sintéticos, con su destino, su origen y su motivo
  const explained = spawnSync(process.execPath, [EXPORTAR, '--explain', '--json',
    '--allowlist', fx.cfg.lista, '--replacements', fx.cfg.reemplazos, '--denied', fx.cfg.denegados, '--harness', 'HEAD', '--agent-skills', 'HEAD'],
  { cwd: fx.dir, encoding: 'utf8', env: { ...sinGit(process.env), TYCON_GUIDES_DIR: fx.arnes, TYCON_SKILLS_DIR: fx.skills } });
  assert.strictEqual(explained.status, 0, explained.stderr);
  const table = JSON.parse(explained.stdout);
  assert.ok(Array.isArray(table.synthetic), '--explain --json trae la clave «synthetic»');
  for (const g of ENTRY_SCRIPTS) {
    const row = table.synthetic.find((x) => x.target === g);
    assert.ok(row, `--explain --json lista ${g}`);
    assert.strictEqual(row.from, `${PAPELES}/${g}`);
    assert.ok(String(row.reason || '').trim(), `${g}: con su motivo`);
  }
  assert.match(explicarTexto(fx), /scripts\/setup\/get-harness\.sh/, '--explain (texto) también los lista');
  assert.deepStrictEqual(temporales(fx), []);
});

test('Export_GetHarness_ByPlaceholder_InternalNeverNamesPublicRepo — la declaración real y el interno sin el nombre',
  { skip: !fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) && 'copia pública: ahí los guiones ya están en su destino y las plantillas no viajan' }, () => {
    const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'allowlist.json'), 'utf8'));
    const pr = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'public-repos.json'), 'utf8'));
    for (const g of ENTRY_SCRIPTS) {
      const entry = (real.synthetic || []).find((x) => x.target === g);
      assert.ok(entry, `la lista blanca declara el sintético de ${g}`);
      assert.strictEqual(entry.from, `${PAPELES}/${g}`);
      assert.deepStrictEqual(entry.packages, ['core']);
      assert.ok(String(entry.reason || '').trim(), `${g}: con su motivo`);
      if (!THIN_PRIVATE) assert.ok(!fs.existsSync(path.join(RAIZ, g)), `en el interno ${g} no existe en scripts/setup/: sólo su plantilla, entre los papeles`);
      const text = fs.readFileSync(path.join(RAIZ, PAPELES, g), 'utf8');
      assert.ok(text.includes('{{public-org}}/{{public-repo}}'), `${g}: la dirección va por marcadores`);
      for (const name of [pr.repo, `${pr.org}/${pr.repo}`]) {
        assert.ok(!text.toLowerCase().includes(String(name).toLowerCase()), `${g}: no escribe el nombre del repo público («${name}»)`);
      }
    }
    assert.ok(fs.readFileSync(path.join(RAIZ, PAPELES, ENTRY_SCRIPTS[1])).subarray(0, 3).equals(BOM), 'get-harness.ps1: con BOM UTF-8');
    assert.doesNotThrow(() => require(EXPORTAR).validarLista(real, 'allowlist.json'));
  });

// ══ story 8.13.1, tanda A (AC 6, T7) — la lista de transformados viaja en version.json ═════════════════════════════════
// Una máquina con la capa privada compara cada ruta pública con el commit interno: una con otro blob es, o un archivo
// que el exportador transformó, o uno de otra versión. Para distinguirlos, el version.json publicado trae `transformed`:
// las rutas PUBLICADAS cuyo blob difiere del interno en esa misma ruta, cada una con el nombre de su ajuste. La lista
// sale de lo que el exportador hizo en esa corrida (sus `ajustes` y los reemplazos, contra el blob interno), nunca de una
// lista escrita a mano. La mitad de mirror.js (la sincronización la escribe y `verify` la comprueba) está en mirror.test.js.

/** Ruta → blob de un árbol de git (sólo archivos). */
const blobsDe = (repo, ref) => new Map(gitFx(repo, ['ls-tree', '-r', ref]).split('\n').filter(Boolean)
  .map((l) => l.split('\t')).filter(([meta]) => meta.split(' ')[1] === 'blob').map(([meta, ruta]) => [ruta, meta.split(' ')[2]]));

test('T7 Export_And_MirrorSync_VersionJsonTransformed_Deterministic_NoPrivate_VerifyCatchesUndeclared — export.js --stamp-version: la lista, sin prefijo, sin generated, determinista y sin nada privado', () => {
  const ex = require(EXPORTAR);
  const { fx } = unifiedFixture();
  // dos papeles de public-files/: uno reemplaza una ruta que el interno también trae (guides/guia.md, con otro blob) y
  // otro sale sólo en el público (LICENSE: el interno no tiene nada en esa ruta)
  const PAPEL = 'scripts/publishing/public-files';
  const lista = JSON.parse(fs.readFileSync(fx.cfg.lista, 'utf8'));
  lista.packages.core.arnes.out.push({ glob: 'guides/guia.md', reason: 'la copia trae la suya, de public-files' },
    { glob: `${PAPEL}/**`, reason: 'los papeles llegan a su destino por un sintético' });
  lista.synthetic = ['guides/guia.md', 'LICENSE'].map((target) => ({ target, from: `${PAPEL}/${target}`, packages: ['core'], reason: 'papel de prueba' }));
  fx.config({ lista: { ...lista, generated: [clonar(GENERADO)] } });
  escribir(fx.arnes, { [`${PAPEL}/guides/guia.md`]: '# Guía\n\nLa versión de afuera.\n', [`${PAPEL}/LICENSE`]: 'Licencia de prueba\n' });
  const union = commitear(fx.arnes, 'los papeles de la copia');

  const copia = fx.salida('t7-copia');
  const r = exportUnified(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', copia, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const v = JSON.parse(leer(copia, 'version.json'));
  assert.deepStrictEqual(Object.keys(v), ['version', 'source', 'transformed'], `version.json trae la lista, después de source\n${leer(copia, 'version.json')}`);
  assert.ok(Array.isArray(v.transformed) && v.transformed.length > 0, 'una lista, y en la fixture no está vacía');
  for (const t of v.transformed) {
    assert.deepStrictEqual(Object.keys(t), ['path', 'transform'], `cada entrada, sólo la ruta y el nombre: ${JSON.stringify(t)}`);
    assert.ok(typeof t.transform === 'string' && t.transform.trim(), `${t.path}: con el nombre de su ajuste`);
  }

  // la lista es EXACTAMENTE lo que difiere: cada ruta publicada (sin version.json) que el interno también trae, con otro blob
  const publicadas = blobsDe(copia, 'HEAD');
  const internas = blobsDe(fx.arnes, union);
  const difieren = [...publicadas].filter(([ruta, b]) => ruta !== 'version.json' && internas.has(ruta) && internas.get(ruta) !== b).map(([ruta]) => ruta).sort();
  assert.ok(difieren.length >= 3, `control: la fixture tiene archivos transformados (${difieren.join(', ')})`);
  assert.deepStrictEqual(v.transformed.map((t) => t.path), difieren, 'las rutas que difieren del interno, ni una más ni una menos, en orden');
  // el papel que reemplaza una ruta interna, con el ajuste que la reemplaza; el que sale sólo afuera no es un transformado
  assert.ok(internas.has('guides/guia.md') && internas.get('guides/guia.md') !== publicadas.get('guides/guia.md'), 'control: guides/guia.md está en los dos, con otro blob');
  assert.ok(String(v.transformed.find((t) => t.path === 'guides/guia.md')?.transform).split('+').includes('sinteticos'), `guides/guia.md, con su ajuste\n${leer(copia, 'version.json')}`);
  assert.ok(publicadas.has('LICENSE') && !internas.has('LICENSE'), 'control: LICENSE sale y el interno no tiene nada en esa ruta');
  assert.ok(!v.transformed.some((t) => t.path === 'LICENSE'), 'lo que sale sólo en el público no difiere de nada interno: no es un transformado');
  assert.ok(!v.transformed.some((t) => t.path === 'version.json' || /(^|\+)generated(\+|$)/.test(t.transform)), 'sin generated: version.json no es un archivo transformado');

  // la ruta publicada, nunca con el prefijo de su fuente: el ajuste del .gitignore se anota como arnes/.gitignore
  assert.ok(r.json.ajustes.some((a) => a.transformacion === 'gitignore-publico' && a.archivo === 'arnes/.gitignore'), 'control: el ajuste trae el prefijo de su fuente');
  const porRuta = new Map(v.transformed.map((t) => [t.path, t.transform]));
  assert.ok(String(porRuta.get('.gitignore')).split('+').includes('gitignore-publico'), `.gitignore, con su ajuste: ${porRuta.get('.gitignore')}`);
  assert.ok(!v.transformed.some((t) => /^(arnes|agent-skills)\//.test(t.path)), 'ninguna ruta con el prefijo de una fuente');
  // un archivo que sólo cambió por un reemplazo también difiere, y tiene nombre
  assert.ok(String(porRuta.get('README.md')).split('+').includes('reemplazos'), `README.md (un reemplazo): ${porRuta.get('README.md')}`);
  // el --json trae la misma lista: la sincronización (mirror.js) la toma de ahí
  assert.deepStrictEqual(r.json.transformed, v.transformed, 'la misma lista en el --json');

  // determinista: otra corrida, con otro huso, da los mismos bytes; sin --stamp-version el --json trae la misma lista
  const otra = fx.salida('t7-otra');
  const r2 = exportUnified(fx, ['--package', 'core', '--single-repo', '--stamp-version', VERSION_DE_PRUEBA, '--output', otra, '--json'], { TZ: 'Pacific/Kiritimati' });
  assert.strictEqual(r2.code, 0, `${r2.err}\n${r2.out}`);
  assert.ok(fs.readFileSync(path.join(otra, 'version.json')).equals(fs.readFileSync(path.join(copia, 'version.json'))), 'los mismos bytes en las dos corridas');
  const sinNumero = fx.salida('t7-sin-numero');
  const r3 = exportUnified(fx, ['--package', 'core', '--single-repo', '--output', sinNumero, '--json']);
  assert.strictEqual(r3.code, 0, `${r3.err}\n${r3.out}`);
  assert.deepStrictEqual(r3.json.transformed, v.transformed, 'sin --stamp-version, la misma lista en el --json');

  // nada privado: ni el detector ni los nombres pegados del freno encuentran algo en version.json
  const texto = leer(copia, 'version.json');
  const d = spawnSync(process.execPath, [DETECTOR, '--config', fx.cfg.denegados, path.join(copia, 'version.json')], { encoding: 'utf8' });
  assert.strictEqual(d.status, 0, `el detector sobre version.json: ${d.stdout}${d.stderr}`);
  assert.deepStrictEqual(ex.nombresPegados([['version.json', texto]], DENEGADOS_BASE.terminos), [], 'ningún nombre pegado');
  assert.ok(!/acme/i.test(texto), 'control: el README interno nombra al cliente; la lista sólo trae su ruta');
  for (const a of r.json.ajustes) assert.ok(!texto.includes(a.detalle), `el detalle de un ajuste no viaja: ${a.detalle}`);

  // versionFileBytes: acepta la lista, la ordena por ruta y no escribe lo que no tiene forma
  const A = 'a'.repeat(40);
  const base = { version: VERSION_DE_PRUEBA, source: { harness: A, agent_skills: A } };
  const desordenada = ex.versionFileBytes({ ...base, transformed: [{ transform: 'y', path: 'b.md' }, { path: 'a.md', transform: 'x' }] });
  assert.strictEqual(desordenada.toString('utf8'), ex.versionFileBytes({ ...base, transformed: [{ path: 'a.md', transform: 'x' }, { path: 'b.md', transform: 'y' }] }).toString('utf8'), 'el orden de entrada no cambia los bytes');
  assert.deepStrictEqual(JSON.parse(desordenada.toString('utf8')).transformed, [{ path: 'a.md', transform: 'x' }, { path: 'b.md', transform: 'y' }]);
  assert.deepStrictEqual(JSON.parse(ex.versionFileBytes({ ...base, transformed: [] }).toString('utf8')).transformed, [], 'una lista vacía se escribe vacía');
  for (const [que, transformed] of [
    ['no es una lista', { path: 'a.md', transform: 'x' }],
    ['una entrada sin nombre', [{ path: 'a.md', transform: '' }]],
    ['una entrada sin ruta', [{ transform: 'x' }]],
    ['la misma ruta dos veces', [{ path: 'a.md', transform: 'x' }, { path: 'a.md', transform: 'y' }]],
    ['el propio version.json', [{ path: 'version.json', transform: 'generated' }]],
    ['una ruta absoluta', [{ path: '/a.md', transform: 'x' }]],
    ['una clave de más', [{ path: 'a.md', transform: 'x', detail: 'algo' }]],
  ]) assert.throws(() => ex.versionFileBytes({ ...base, transformed }), ex.NoPudo, `${que}: tira`);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── T40 · story 8.19, tanda C — un comando del arnés por cualquiera de los dos nombres del lugar ──────────────────
// Una guía o una skill manda correr `node ~/.claude/<lugar>/scripts/x.js`, o todavía `~/.claude/<viejo>/…`: los dos son
// el arnés, y `<arnés>/` y `<repo>/` (en un comando del arnés) van al lugar. Un nombre que sólo empieza igual no es el
// arnés. Los nombres salen de place.js: esta prueba también corre en la copia.
test('T40 Exporter_RecognizesBothRoots_CopyWithoutLegacyPlacePath', () => {
  const PLACE = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js'));
  const { candidatosDeComando, comandosColgados } = require(EXPORTAR);
  const md = 'agent-skills/skills/tycon-pipeline/SKILL.md';
  for (const root of [`~/.claude/${PLACE.PLACE_NAME}/`, `~/.claude/${PLACE.LEGACY_PLACE_NAME}/`, `$HOME/.claude/${PLACE.PLACE_NAME}/`, '<arnés>/']) {
    assert.deepStrictEqual(candidatosDeComando(`${root}scripts/lib/x.js`, md), ['arnes/scripts/lib/x.js'], `el arnés por ${root}`);
  }
  assert.deepStrictEqual(candidatosDeComando('<repo>/scripts/y.js', 'arnes/commands/c.md'), ['arnes/scripts/y.js'], '<repo>/ en un comando del arnés');
  assert.strictEqual(candidatosDeComando(`~/.claude/${PLACE.PLACE_NAME}-report-x/scripts/x.js`, md), null, 'un nombre que sólo empieza igual no es el arnés');
  // validado: existe por cualquiera de los dos nombres; colgado, también
  const existe = new Set(['arnes/scripts/lib/x.js']);
  const textos = [[md, `node ~/.claude/${PLACE.PLACE_NAME}/scripts/lib/x.js\nnode ~/.claude/${PLACE.LEGACY_PLACE_NAME}/scripts/lib/x.js\nnode ~/.claude/${PLACE.PLACE_NAME}/scripts/lib/no-esta.js\n`]];
  assert.deepStrictEqual(comandosColgados(textos, existe).map((h) => h.linea), [3], 'sólo el que no existe queda colgado');
});

// T40 (b) · la ruta vieja de un guion detrás del LUGAR se traduce como detrás del nombre viejo: una skill que manda
// correr `~/.claude/<lugar>/scripts/<viejo>` sale en la copia con el nombre nuevo (la copia no trae los envoltorios), igual
// que con `~/.claude/<viejo>/…`. Un nombre que sólo empieza como el lugar no es la raíz.
test('T40 Exporter_PlaceRootTranslatesOldScriptPaths — detrás del lugar, la ruta vieja de un guion se traduce', () => {
  const PLACE = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'place.js'));
  const fx = fixture();
  const mapa = { __about: 'mapa de laboratorio', retire_after: null, entries: [
    { kind: 'file', old: 'scripts/lab-root.sh', new: 'scripts/tools/lab-root.sh', batch: 'lab', callers: ['other-repo'] },
  ] };
  escribir(fx.arnes, {
    'scripts/lib/renames.json': `${JSON.stringify(mapa, null, 2)}\n`,
    'scripts/tools/lab-root.sh': '#!/usr/bin/env bash\nexit 0\n',
  });
  escribir(fx.skills, { 'skills/tycon-pipeline/SKILL.md': [
    '# Skill', '',
    `- Por el lugar: \`bash ~/.claude/${PLACE.PLACE_NAME}/scripts/lab-root.sh x\``,
    `- Por el viejo: \`bash ~/.claude/${PLACE.LEGACY_PLACE_NAME}/scripts/lab-root.sh x\``,
    `- Otro: \`bash ~/.claude/${PLACE.PLACE_NAME}-report-x/scripts/lab-root.sh x\``,
    '',
  ].join('\n') });
  commitear(fx.arnes, 'mudanza a tools/');
  commitear(fx.skills, 'nombra el guion viejo por los dos nombres del lugar');
  const salida = fx.salida('t40b');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `entre repos no frena la copia\n${r.err}\n${r.out}`);
  const skill = leer(salida, 'agent-skills/skills/tycon-pipeline/SKILL.md');
  assert.ok(skill.includes(`~/.claude/${PLACE.PLACE_NAME}/scripts/tools/lab-root.sh x`), `por el lugar, al nombre nuevo:\n${skill}`);
  assert.ok(skill.includes(`~/.claude/${PLACE.LEGACY_PLACE_NAME}/scripts/tools/lab-root.sh x`), 'por el viejo, al nombre nuevo');
  assert.ok(skill.includes(`~/.claude/${PLACE.PLACE_NAME}-report-x/scripts/lab-root.sh x`), 'un nombre que sólo empieza como el lugar no es la raíz');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.10.3, tanda A · T4 (AC 2) — `empty` con una ruta de puntos vacía una clave anidada ───────────
test('Exporter_EmptyWithDottedPath_EmptiesNestedKey', () => {
  const fx = fixture();
  const fuente = { reducer: { window_days: 7, expected_machines: [{ alias: 'maq-de-mentira', from: '2000-01-01' }] }, otra: 1 };
  escribir(fx.arnes, { 'scripts/nightly/dashboard/sources.json': `${JSON.stringify(fuente, null, 2)}\n` });
  commitear(fx.arnes, 'datos del tablero de mentira');
  const lista = clonar(LISTA_BASE);
  lista.empty = { 'scripts/nightly/dashboard/sources.json': ['reducer.expected_machines'] };
  fx.config({ lista });
  const salida = fx.salida('8103-empty');
  let r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const copia = JSON.parse(leer(salida, 'arnes/scripts/nightly/dashboard/sources.json'));
  assert.deepStrictEqual(copia.reducer.expected_machines, [], 'la clave anidada sale vacía');
  assert.strictEqual(copia.reducer.window_days, 7, 'el resto del objeto, igual');
  assert.strictEqual(copia.otra, 1);
  assert.ok(leer(fx.arnes, 'scripts/nightly/dashboard/sources.json').includes('maq-de-mentira'), 'la fuente no se toca');

  lista.empty = { 'scripts/nightly/dashboard/sources.json': ['reducer.no_existe'] };
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-empty-b')]);
  assert.strictEqual(r.code, 2, `una ruta que no existe sale 2\n${r.err}\n${r.out}`);
  assert.match(`${r.err}${r.out}`, /reducer\.no_existe/);
  assert.ok(!existe(fx.salida('8103-empty-b'), '.'), 'sin copia');
});

// ── story 8.10.3, tanda A · T6 (AC 5) — `publicTexts`: el texto exacto se reemplaza; si no está, sale 2 ──────
test('Exporter_PublicTexts_ReplacedOrStale', () => {
  const fx = fixture();
  const msg = "'use strict';\nconsole.log('pieza del equipo: corré scripts/interno.js');\nconsole.log('otra vez: corré scripts/interno.js');\n";
  const bloque = '# ── bloque del equipo\nif [ -f scripts/interno.js ]; then\n  node scripts/interno.js\nfi\n';
  const hook = `#!/bin/bash\necho antes\n${bloque}echo despues\n`;
  escribir(fx.arnes, { 'scripts/msg.js': msg, 'scripts/hook.sh': hook });
  commitear(fx.arnes, 'textos que mandan a una pieza del equipo');
  const lista = clonar(LISTA_BASE);
  lista.publicTexts = [
    { root: 'arnes', file: 'scripts/msg.js', text: 'corré scripts/interno.js', public: 'es una integración del equipo', count: 2, reason: 'la pieza no viaja' },
    { root: 'arnes', file: 'scripts/hook.sh', text: bloque, public: '', count: 1, reason: 'el bloque llama a una pieza que no viaja' },
  ];
  fx.config({ lista });
  const salida = fx.salida('8103-pt');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const m = leer(salida, 'arnes/scripts/msg.js');
  assert.ok(!m.includes('interno.js'), m);
  assert.strictEqual((m.match(/es una integración del equipo/g) || []).length, 2);
  assert.strictEqual(leer(salida, 'arnes/scripts/hook.sh'), '#!/bin/bash\necho antes\necho despues\n', 'el bloque de varios renglones sale entero');
  assert.strictEqual(leer(fx.arnes, 'scripts/msg.js'), msg, 'la fuente queda como estaba');

  // Un texto que ya no aparece esas veces (cambió en la fuente) frena la copia
  lista.publicTexts[0].count = 3;
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-pt-b')]);
  assert.strictEqual(r.code, 2, `cuenta distinta sale 2\n${r.err}\n${r.out}`);
  assert.match(`${r.err}${r.out}`, /scripts\/msg\.js/);
  lista.publicTexts[0] = { ...lista.publicTexts[0], count: 2, text: 'un texto que ya no está' };
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-pt-c')]);
  assert.strictEqual(r.code, 2, `texto ausente sale 2\n${r.err}\n${r.out}`);
  // Una entrada sin motivo es una configuración rota
  lista.publicTexts = [{ root: 'arnes', file: 'scripts/msg.js', text: 'corré scripts/interno.js', public: 'x', count: 2 }];
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-pt-d')]);
  assert.strictEqual(r.code, 2, `sin motivo sale 2\n${r.err}\n${r.out}`);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.10.3, tanda B · T9 (AC 8, 9) — la ruta que no viaja sale marcada; el control cuenta las que no ──────────
test('Exporter_PathThatDoesNotTravel_MarkedAndUnmarkedBrakes', () => {
  const fx = fixture();
  const ex = require(EXPORTAR);
  const cuerpo = 'Revisa el núcleo. El plan del equipo: `scripts/interno-equipo.js`. La configuración del repo: `.tycon/advisors.yaml`. Uno que viaja: `scripts/hola.js`.';
  escribir(fx.arnes, { 'scripts/interno-equipo.js': "'use strict';\n", '.tycon/advisors.yaml': 'packs: []\n' });
  escribir(fx.skills, { 'agents/revisor-nucleo.md': agente('revisor-nucleo', cuerpo) });
  regenerarCodex(fx.arnes, fx.skills);
  commitear(fx.arnes, 'una pieza del equipo y una convención');
  commitear(fx.skills, 'un revisor que las cita');
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: 'scripts/interno-equipo.js', reason: 'del equipo' });
  lista.packages.core.arnes.out.push({ glob: '.tycon/**', reason: 'la configuración del repo del equipo' });
  lista.readerConventions = [{ path: '.tycon/', reason: 'la carpeta de configuración que el arnés crea en el repo de quien lo usa' }];
  fx.config({ lista });
  const salida = fx.salida('8103-b');
  const r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  const md = leer(salida, 'agent-skills/agents/revisor-nucleo.md');
  const M = require(path.join(RAIZ, 'scripts', 'publishing', 'public-copy.js')).NOT_IN_COPY_MARK;
  assert.ok(md.includes(`\`scripts/interno-equipo.js\`${M}`), `la ruta que no viaja lleva la marca\n${md}`);
  assert.ok(md.includes('`.tycon/advisors.yaml`.') && md.includes('`scripts/hola.js`.'), 'la convención y la que viaja, sin marca');
  assert.deepStrictEqual(r.json.controles.pathsNotInCopy, [], 'el control, en 0 con todo marcado');
  assert.ok(r.json.ajustes.some((a) => a.transformacion === 'not-in-copy'), 'la transformación queda en los ajustes');
  assert.strictEqual(leer(fx.skills, 'agents/revisor-nucleo.md'), agente('revisor-nucleo', cuerpo), 'la fuente queda como estaba');
  // la traducción a Codex se regenera desde el .md ya marcado
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-check-'));
  const chk = spawnSync(process.execPath, [path.join(salida, 'arnes', 'build', 'generate.js'), '--check'], {
    encoding: 'utf8',
    env: { ...sinGit(process.env), TYCON_AGENTS_DIR: path.join(salida, 'agent-skills', 'agents'), HOME: aux, CODEX_HOME: path.join(aux, 'codex') },
  });
  fs.rmSync(aux, { recursive: true, force: true });
  assert.strictEqual(chk.status, 0, `generate.js --check en la copia: ${chk.stderr}`);

  // El control del AC 9, directo: una copia con una ruta del equipo sin su marca da el hallazgo con archivo y línea
  const enRepo = (p) => ['scripts/interno-equipo.js', 'scripts', '.tycon/advisors.yaml', '.tycon'].includes(p);
  const opts = { inRepo: enRepo, inCopy: () => false, conventions: ['.tycon/'] };
  const textos = [
    ['guides/a.md', `# A\n\nSin marca: \`scripts/interno-equipo.js\`.\nCon marca: \`scripts/interno-equipo.js\`${M}.\nConvención: \`.tycon/advisors.yaml\`.\n`],
    ['README.md', 'El README lo mira readmePaths: `scripts/interno-equipo.js`.\n'],
    ['scripts/x.js', '// no es un .md: `scripts/interno-equipo.js`\n'],
  ];
  assert.deepStrictEqual(ex.pathsNotInCopy(textos, opts), [{ archivo: 'guides/a.md', linea: 3, ruta: 'scripts/interno-equipo.js' }]);
  assert.ok(ex.COPY_CONTROLS.some((c) => c.nombre === 'pathsNotInCopy'), 'el control está en la lista de controles: un hallazgo es exit 1');
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.10.3, tanda B · pase de fallos silenciosos (W8) y pase adversarial (clases 1-4, 6-8): la marca y su control
// cuentan lo mismo sobre el mismo corpus — sobre el texto sin marcar, el control encuentra exactamente lo que la marca
// marca; sobre el texto marcado, nada. Así no pueden desincronizarse en silencio ni frenar algo que la marca no arregla.
test('Exporter_PathsNotInCopy_AgreesWithMarkOnCorpus', () => {
  const ex = require(EXPORTAR);
  const pc = require(path.join(RAIZ, 'scripts', 'publishing', 'public-copy.js'));
  const equipo = new Set(['tasks', 'tasks/x.md', 'scripts', 'scripts/y.js', 'guides', 'guides/vecina.md', 'guides/a.md', 'guides/incident-log.md',
    '.tycon', '.tycon/advisors.yaml', 'inbox', 'specs', 'specs/story-1.2-algo.md', 'guides/sub', 'guides/sub/specs', 'guides/sub/specs/x.md', 'skills', 'skills/s', 'skills/s/steps', 'skills/s/steps/p.md']);
  const copia = new Set(['guides', 'guides/a.md', 'skills', 'skills/s', 'skills/s/steps', 'skills/s/steps/p.md']);
  const opts = { inRepo: (p) => equipo.has(p), inCopy: (p) => copia.has(p), conventions: ['.tycon/', 'specs', 'tasks/todo.md'], installPrefixes: ['~/.claude/acme-lugar/', [/^~\/\.claude\/acme-sk\//, 'skills/']] };
  const corpus = [
    ['guides/a.md', 'Ver `tasks/x.md`, `vecina.md`, `a.md`, `inbox` y `scripts/zzz.js`.\nLa config: `.tycon/advisors.yaml`; `specs`; `specs/story-1.2-algo.md`.\n'],
    ['guides/a.md', 'El caso: `guides/incident-log.md#x-2026-01-01` y `guides/incident-log.md`.\nCon línea `scripts/y.js:3-4`, `~/.claude/acme-lugar/tasks/x.md` y `~/.claude/acme-sk/s/steps/q.md`.\n'],
    ['guides/a.md', 'el cerco abre con ``` y `scripts/y.js` lo lee\nver ``scripts/y.js:3-4` acá\n(`````scripts/y.js:3-4```\n````tasks/x.md```` y `` `scripts/y.js` ``\n'],
    ['guides/a.md', 'dice `algo\nsigue` y `scripts/y.js` fin\n\nuna `suelta\n\ny `tasks/x.md` acá\n'],
    ['skills/s/SKILL.md', 'Paso: `steps/p.md` y `steps/q.md`.\n```\n`scripts/y.js` en un cerco\n```\n'],
    ['README.md', 'El README: `tasks/x.md`.\n'],
    // vuelta 2 (fallos silenciosos): una vecina del equipo que se llama como una convención suelta
    ['guides/sub/doc.md', 'La carpeta `specs` de acá y `tasks/todo.md`.\n'],
  ];
  for (const [archivo, texto] of corpus) {
    const m = pc.markPathsNotInCopy(texto, archivo, opts);
    const antes = ex.pathsNotInCopy([[archivo, texto]], opts).map((h) => [h.linea, h.ruta]);
    assert.deepStrictEqual(antes, m.marked.map((x) => [x.line, x.path]), `${archivo}: el control ve exactamente lo que la marca marca\n${texto}`);
    assert.deepStrictEqual(ex.pathsNotInCopy([[archivo, m.text]], opts), [], `${archivo}: con la marca puesta, el control da 0\n${m.text}`);
  }
  // y el corpus no es vacío: la marca encontró algo en cada clase que tiene que marcar
  const total = corpus.reduce((n, [a, t]) => n + pc.markPathsNotInCopy(t, a, opts).marked.length, 0);
  assert.ok(total >= 10, `el corpus ejercita la marca (${total})`);
});

// ── story 8.10.3, tanda B · pase de cobertura (TEST-W4): una lista de convenciones mal escrita es una configuración rota
test('Exporter_ReaderConventions_Invalid_Exits2', () => {
  const fx = fixture();
  const malas = [
    { readerConventions: '.tycon/' },
    { readerConventions: [{ path: 'tasks/*.md', reason: 'glob' }] },
    { readerConventions: [{ path: '/abs', reason: 'absoluta' }] },
    { readerConventions: [{ path: 'a/../b', reason: 'con ..' }] },
    { readerConventions: [{ path: '.tycon/' }] },
  ];
  malas.forEach((extra, i) => {
    fx.config({ lista: { ...clonar(LISTA_BASE), ...extra } });
    const r = exportar(fx, ['--package', 'core', '--output', fx.salida(`8103-rc-${i}`)]);
    assert.strictEqual(r.code, 2, `${JSON.stringify(extra)} sale 2\n${r.err}\n${r.out}`);
    assert.match(`${r.err}${r.out}`, /readerConventions/);
  });
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.10.3, tanda B · pase adversarial (clase 9): un .md que no es UTF-8 válido no se reescribe en silencio
test('Exporter_NotInCopy_InvalidUtf8_Exits2', () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.arnes, 'guides'), { recursive: true });
  fs.writeFileSync(path.join(fx.arnes, 'guides', 'latin.md'), Buffer.concat([Buffer.from('Caf'), Buffer.from([0xe9]), Buffer.from(' ver `scripts/interno-equipo.js`.\n')]));
  escribir(fx.arnes, { 'scripts/interno-equipo.js': "'use strict';\n" });
  commitear(fx.arnes, 'una guía en latin-1 que cita algo del equipo');
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: 'scripts/interno-equipo.js', reason: 'del equipo' });
  fx.config({ lista });
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-utf8')]);
  assert.strictEqual(r.code, 2, `${r.err}\n${r.out}`);
  assert.match(`${r.err}${r.out}`, /guides\/latin\.md.*UTF-8/);
  assert.deepStrictEqual(temporales(fx), []);
});

// ── story 8.10.3, tanda A · T6 (AC 5, spec-first W2) — un guion de shell sin extensión también se compila ────────
test('Exporter_PublicTexts_ExtensionlessShellScript_IsCompiled', () => {
  const fx = fixture();
  // un archivo sin extensión que NO es un guion de shell (texto suelto, o un guion de node) no se compila con bash
  escribir(fx.arnes, { 'scripts/notas-sin-ext': 'texto ( suelto que bash no compila\n', 'scripts/node-sin-ext': '#!/usr/bin/env node\nif (1) { console.log(1); }\n' });
  commitear(fx.arnes, 'dos archivos sin extensión que no son de shell');
  const r0 = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-sinext-0'), '--json']);
  assert.strictEqual(r0.code, 0, `lo que no es un guion de shell no pasa por bash -n\n${r0.err}\n${r0.out}`);
  escribir(fx.arnes, { 'scripts/hook-sin-ext': '#!/usr/bin/env bash\nif [ -f x ]; then\n  echo x\nfi\n' });
  commitear(fx.arnes, 'un guion sin extensión');
  const lista = clonar(LISTA_BASE);
  // la versión pública deja el `if` sin su `fi`: el guion de la copia ya no compila
  lista.publicTexts = [{ root: 'arnes', file: 'scripts/hook-sin-ext', text: 'fi\n', public: '', count: 1, reason: 'prueba' }];
  fx.config({ lista });
  const r = exportar(fx, ['--package', 'core', '--output', fx.salida('8103-sinext'), '--json']);
  assert.strictEqual(r.code, 1, `un guion sin extensión que no compila frena la copia\n${r.err}\n${r.out}`);
  assert.ok(r.json && r.json.controles && r.json.controles.compilacion.some((f) => f.archivo.endsWith('scripts/hook-sin-ext')), r.out);
});

// ── story 8.22, tramo F (AC 35 b) · el exportador más rápido, con el mismo resultado ───────────────────────────────────
// Medido el 2026-10-07 sobre el núcleo real (37 s): 9,8 s se iban en compilar los ~400 .js de la copia con un proceso de
// node por archivo, y 2,6 s en volver a calcular, para cada archivo, qué busca el atajo de cada par de reemplazo.
test('T44 Export_CompileCheck_InProcessSameReport — los CommonJS se compilan en el mismo proceso, y el informe es el de `node --check` archivo por archivo', () => {
  const exp = require(EXPORTAR);
  const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'export-t44-'));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'export-t44-aux-'));
  try {
    const files = {
      'scripts/sano.js': "'use strict';\nconst a = require('fs');\nmodule.exports = () => a;\n",
      'scripts/con-guion.js': '#!/usr/bin/env node\nconsole.log(1);\n',
      'scripts/vuelve-arriba.js': "if (process.argv.length < 9) return;\nconsole.log('un return suelto vale en CommonJS');\n",
      'scripts/sano.cjs': 'module.exports = 1;\n',
      'scripts/roto.js': "'use strict';\nconst x = {;\n",
      'scripts/roto-dos.cjs': 'function ( {\n',
      'scripts/modulo.mjs': "import fs from 'node:fs';\nexport default fs;\n",
      'scripts/modulo-roto.mjs': 'export default {;\n',
      'paquete/package.json': '{ "type": "module" }\n',
      'paquete/esm.js': "import fs from 'node:fs';\nexport const y = fs;\n",
      'paquete/adentro/tambien-esm.js': 'export const z = 1;\n',
      'paquete/esm-roto.js': 'export const = 1;\n',
      'scripts/guion.sh': 'echo hola\n',
      'scripts/guion-roto.sh': 'if true; then\n',
      'notas.md': '# no se compila\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(copia, rel)), { recursive: true });
      fs.writeFileSync(path.join(copia, rel), body);
    }
    const rutas = Object.keys(files);
    const before = { spawned: [] };
    const after = { spawned: [] };
    const reference = exp.compilan(copia, rutas, aux, { inProcess: false, ...before });
    const got = exp.compilan(copia, rutas, aux, after);
    assert.deepStrictEqual(got, reference, 'las mismas fallas, con el mismo texto y en el mismo orden');
    assert.deepStrictEqual(got.map((f) => f.archivo), ['scripts/roto.js', 'scripts/roto-dos.cjs', 'scripts/modulo-roto.mjs', 'paquete/esm-roto.js', 'scripts/guion-roto.sh'],
      'frenan los cinco rotos; el .mjs sano y los dos del paquete declarado módulo no se dan por rotos');
    assert.ok(got.every((f) => f.detalle && !f.detalle.includes(copia)), 'el detalle no lleva la carpeta temporal');
    // lo que ya no lanza un proceso: los CommonJS sanos. Lo demás sigue como antes.
    const base = (list) => list.map((p) => path.relative(copia, p).split(path.sep).join('/')).sort();
    assert.deepStrictEqual(base(before.spawned), rutas.filter((r) => !r.endsWith('.md') && !r.endsWith('.json')).sort(), 'antes: un proceso por archivo de código');
    assert.deepStrictEqual(base(after.spawned), ['paquete/adentro/tambien-esm.js', 'paquete/esm-roto.js', 'paquete/esm.js', 'scripts/guion-roto.sh', 'scripts/guion.sh', 'scripts/modulo-roto.mjs', 'scripts/modulo.mjs', 'scripts/roto-dos.cjs', 'scripts/roto.js'],
      'después: los rotos (para el mismo detalle), los módulos y los .sh; ningún CommonJS sano');
  } finally {
    fs.rmSync(copia, { recursive: true, force: true });
    fs.rmSync(aux, { recursive: true, force: true });
  }
});

test('T45 Export_PairShortcut_ComputedOncePerPair — el atajo de los reemplazos contesta lo mismo que el cálculo de siempre, par por par y texto por texto', () => {
  const exp = require(EXPORTAR);
  const detector = require(DETECTOR);
  // el cálculo de antes del tramo F, tal cual: por cada forma, cada vez
  const asBefore = (par, lower) => par.formas.some((f) => !/^[\x20-\x7e]*$/.test(f.texto) || lower.includes(detector.partesDe(f.texto)[0].toLowerCase()));
  const pares = [
    { real: 'AcmeCorp', formas: [{ texto: 'AcmeCorp' }] },
    { real: 'acme', formas: [{ texto: 'acme' }, { texto: 'ACME Sociedad' }] },
    { real: 'Almacén', formas: [{ texto: 'Almacén' }] },
    { real: 'mixto', formas: [{ texto: 'Zeta' }, { texto: 'Ñandú' }] },
    { real: 'host', formas: [{ texto: 'srv-01.acme.example' }] },
  ];
  const textos = ['nada de eso', 'un AcmeCorp entero', 'sólo acme suelto', 'ACME-CORP partido', 'el almacen sin tilde', 'zeta en minúsculas', 'srv-01.acme.example y más', ''];
  for (const par of pares) {
    for (const t of textos) {
      const lower = t.toLowerCase();
      assert.strictEqual(exp.parPuedeEstar(par, lower), asBefore(par, lower), `${par.real} en «${t}»`);
      assert.strictEqual(exp.parPuedeEstar(par, lower), asBefore(par, lower), `${par.real} en «${t}», la segunda vez (ya calculado)`);
    }
  }
  // y de verdad se calcula una vez: después de la primera consulta, cambiar el texto de una forma ya no cambia la respuesta
  const par = { real: 'una-vez', formas: [{ texto: 'Primero' }] };
  assert.strictEqual(exp.parPuedeEstar(par, 'hay primero acá'), true);
  par.formas[0].texto = 'Otro';
  assert.strictEqual(exp.parPuedeEstar(par, 'hay primero acá'), true, 'lo que busca el atajo se calcula una vez por par');
});

// ── story 8.22, tramo F (AC 34) · una suite partida que no viaja sale entera: su archivo y todas sus partes ──────────────
// Una suite partida no está en suites.json: están sus partes. La lista de las que no viajan nombra el archivo entero (que
// si no saldría como archivo) Y cada parte (que si no saldría como una línea que carga un archivo que no está).
test('T46 Export_PartitionedSuiteOutside_GoesWithItsParts — el archivo entero y sus partes salen juntos; una parte olvidada frena', () => {
  const fx = fixture();
  const entrada = (ruta) => ['    {', '      "raiz": "arnes",', `      "ruta": "tests/${ruta}",`, '      "requiere": []', '    }'].join('\n');
  const lista3 = (rutas) => `{\n  "__doc": "Suites de mentira.",\n  "diarias": [\n${rutas.map(entrada).join(',\n')}\n  ],\n  "semanales": []\n}\n`;
  escribir(fx.arnes, {
    'scripts/tests/suites.json': lista3(['uno.test.js', 'nocturna.p1.test.sh', 'nocturna.p2.test.sh']),
    'scripts/tests/uno.test.js': "'use strict';\n",
    'scripts/tests/nocturna.test.sh': '#!/bin/bash\necho entera\n',
    'scripts/tests/nocturna.p1.test.sh': '#!/bin/bash\nSUITE_PART=1/2 exec bash "$(dirname "$0")/nocturna.test.sh"\n',
    'scripts/tests/nocturna.p2.test.sh': '#!/bin/bash\nSUITE_PART=2/2 exec bash "$(dirname "$0")/nocturna.test.sh"\n',
  });
  commitear(fx.arnes, 'una suite partida que no viaja');
  const fuera = (rutas) => rutas.map((p) => ({ root: 'arnes', path: `tests/${p}`, reason: 'prueba los nocturnos, que quedan afuera' }));
  const lista = clonar(LISTA_BASE);
  lista.suitesOutside = fuera(['nocturna.test.sh', 'nocturna.p1.test.sh', 'nocturna.p2.test.sh']);
  fx.config({ lista });
  const salida = fx.salida('t46');
  let r = exportar(fx, ['--package', 'core', '--output', salida]);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  for (const p of ['nocturna.test.sh', 'nocturna.p1.test.sh', 'nocturna.p2.test.sh']) assert.ok(!existe(salida, `arnes/scripts/tests/${p}`), `${p} no viaja`);
  assert.ok(existe(salida, 'arnes/scripts/tests/uno.test.js'), 'la otra suite viaja');
  assert.strictEqual(leer(salida, 'arnes/scripts/tests/suites.json'), lista3(['uno.test.js']), 'las entradas de las partes salen con ellas');

  // una parte olvidada: saldría como archivo, cargando un entero que no está
  lista.suitesOutside = fuera(['nocturna.test.sh', 'nocturna.p1.test.sh']);
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t46b')]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /nocturna\.test\.sh corre por partes y su parte tests\/nocturna\.p2\.test\.sh no está en la lista/);

  // las partes sin el entero: el archivo entero viajaría, sin nadie que lo corra y probando algo que no viaja
  lista.suitesOutside = fuera(['nocturna.p1.test.sh', 'nocturna.p2.test.sh']);
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t46c')]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /nocturna\.p1\.test\.sh es una parte de tests\/nocturna\.test\.sh, que no está en la lista/);

  // y lo de siempre: un nombre que no es ni una suite registrada ni una partida sigue siendo un error
  lista.suitesOutside = fuera(['fantasma.test.sh']);
  fx.config({ lista });
  r = exportar(fx, ['--package', 'core', '--output', fx.salida('t46d')]);
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /fantasma\.test\.sh no está en scripts\/tests\/suites\.json/);
});

// ── story 8.22, tramo I (AC 40) · el registro de partes de una suite que no viaja se va con ella ───────────────────────
// Regresión del tramo F, medida el 2026-10-08 con la copia armada desde `main`: `scripts/tests/suite-parts.json` viajaba
// entero y nombraba a heavy-suites.test.js, que no viaja. Dentro de la copia, suites-coverage («su parte no está
// registrada») y suite-parts (T42: «figura como partida y no existe») daban rojo; en el repo del equipo, todo verde.
test('T50 Export_PartitionedSuiteOutside_ItsEntryLeavesThePartsRegistry — la entrada de una suite partida que no viaja sale del registro de partes; el resto, igual', () => {
  const fx = fixture();
  const entrada = (ruta) => ['    {', '      "raiz": "arnes",', `      "ruta": "tests/${ruta}",`, '      "requiere": []', '    }'].join('\n');
  const lista = (rutas) => `{\n  "__doc": "Suites de mentira.",\n  "diarias": [\n${rutas.map(entrada).join(',\n')}\n  ],\n  "semanales": []\n}\n`;
  // El registro de partes, escrito como el de verdad: cada suite con sus partes y las duraciones de sus pruebas.
  const suite = (nombre, pruebas) => [`    "${nombre}": {`, '      "parts": 2,', '      "seconds": {', pruebas.map((p) => `        "${p}": 1.5`).join(',\n'), '      }', '    }'].join('\n');
  const registro = (suites) => `{\n  "__doc": "Las suites partidas, con lo que tarda cada prueba.",\n  "suites": {${suites.length ? `\n${suites.join(',\n')}\n  ` : ''}}\n}\n`;
  const VIAJA = suite('viaja.test.js', ['Uno_Caso — con raya', 'Dos_Caso']);
  const NOCTURNA = suite('nocturna.test.js', ['Nocturna_Caso']);
  const parte = (entero, k) => `'use strict';\nprocess.env.SUITE_PART = '${k}/2';\nrequire('./${entero}');\n`;
  escribir(fx.arnes, {
    'scripts/tests/suites.json': lista(['viaja.p1.test.js', 'viaja.p2.test.js', 'nocturna.p1.test.js', 'nocturna.p2.test.js']),
    'scripts/tests/suite-parts.json': registro([NOCTURNA, VIAJA]),
    'scripts/tests/viaja.test.js': "'use strict';\n",
    'scripts/tests/viaja.p1.test.js': parte('viaja.test.js', 1),
    'scripts/tests/viaja.p2.test.js': parte('viaja.test.js', 2),
    'scripts/tests/nocturna.test.js': "'use strict';\n",
    'scripts/tests/nocturna.p1.test.js': parte('nocturna.test.js', 1),
    'scripts/tests/nocturna.p2.test.js': parte('nocturna.test.js', 2),
  });
  commitear(fx.arnes, 'dos suites partidas: una viaja y la otra no');
  const fuera = (rutas) => rutas.map((p) => ({ root: 'arnes', path: `tests/${p}`, reason: 'prueba los nocturnos, que quedan afuera' }));
  const cfg = clonar(LISTA_BASE);
  cfg.suitesOutside = fuera(['nocturna.test.js', 'nocturna.p1.test.js', 'nocturna.p2.test.js']);
  fx.config({ lista: cfg });
  let salida = fx.salida('t50');
  let r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!existe(salida, 'arnes/scripts/tests/nocturna.test.js'), 'la suite no viaja');
  assert.strictEqual(leer(salida, 'arnes/scripts/tests/suite-parts.json'), registro([VIAJA]),
    'el registro de la copia trae sólo la que viaja, y el resto del archivo no cambia');
  assert.deepStrictEqual(r.json.ajustes.filter((a) => a.transformacion === 'suite-parts-json').map((a) => [a.archivo, a.detalle]),
    [['arnes/scripts/tests/suite-parts.json', 'sin la entrada nocturna.test.js (la suite no viaja)']], 'y el ajuste queda en el listado de la corrida');

  // no viaja ninguna: el registro queda, vacío (la biblioteca que lo lee viaja, y sin registro no se deja leer)
  cfg.suitesOutside = fuera(['nocturna.test.js', 'nocturna.p1.test.js', 'nocturna.p2.test.js', 'viaja.test.js', 'viaja.p1.test.js', 'viaja.p2.test.js']);
  fx.config({ lista: cfg });
  salida = fx.salida('t50b');
  r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(salida, 'arnes/scripts/tests/suite-parts.json'), registro([]));

  // viajan todas: el archivo sale tal cual y no hay ajuste que anotar
  cfg.suitesOutside = [];
  fx.config({ lista: cfg });
  salida = fx.salida('t50c');
  r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(leer(salida, 'arnes/scripts/tests/suite-parts.json'), registro([NOCTURNA, VIAJA]));
  assert.deepStrictEqual(r.json.ajustes.filter((a) => a.transformacion === 'suite-parts-json'), []);

  // la suite queda afuera por la otra vía —su archivo no sale, sin que la lista de suites la nombre—: su entrada también
  const porGlob = clonar(LISTA_BASE);
  porGlob.packages.core.arnes.out.push({ glob: 'scripts/tests/nocturna*', reason: 'prueba los nocturnos, que quedan afuera' });
  fx.config({ lista: porGlob });
  salida = fx.salida('t50e');
  r = exportar(fx, ['--package', 'core', '--output', salida, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);
  assert.ok(!existe(salida, 'arnes/scripts/tests/nocturna.test.js') && !existe(salida, 'arnes/scripts/tests/nocturna.p1.test.js'), 'ni el archivo ni sus partes viajan');
  assert.strictEqual(leer(salida, 'arnes/scripts/tests/suite-parts.json'), registro([VIAJA]), 'un archivo que no sale se lleva su entrada, esté o no en suitesOutside');

  // un registro que no se deja leer no se publica a medias: la exportación frena y dice cuál. Dos formas: un JSON
  // cortado, y un JSON sano que no trae «suites» como objeto.
  cfg.suitesOutside = fuera(['nocturna.test.js', 'nocturna.p1.test.js', 'nocturna.p2.test.js']);
  fx.config({ lista: cfg });
  for (const [que, roto, motivo] of [['cortado', '{ "suites": ', /suite-parts\.json del arnés no se deja leer/],
    ['con suites como lista', '{ "suites": [] }\n', /suite-parts\.json del arnés no se deja leer \(no trae «suites» como objeto\)/],
    ['sin suites', '{ "__doc": "nada" }\n', /no trae «suites» como objeto/]]) {
    escribir(fx.arnes, { 'scripts/tests/suite-parts.json': roto });
    commitear(fx.arnes, `el registro de partes, ${que}`);
    r = exportar(fx, ['--package', 'core', '--output', fx.salida(`t50-${que.replace(/ /g, '-')}`), '--json']);
    assert.strictEqual(r.code, 2, `${que}: ${r.err}\n${r.out}`);
    assert.match(r.err, motivo, que);
  }
});

// Pase adversarial del tramo F (5b): con una marca de orden de bytes (BOM) delante del `#!`, node no carga el archivo
// (el `#!` sólo vale en el primer carácter). El atajo sacaba el BOM y después el `#!`, y lo daba por compilado.
test('T44 — un .js con BOM delante del `#!` no se da por compilado en el mismo proceso: decide `node --check`, con el mismo informe', () => {
  const exp = require(EXPORTAR);
  const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'export-t44b-'));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'export-t44b-aux-'));
  try {
    fs.mkdirSync(path.join(copia, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(copia, 'scripts', 'bom-y-guion.js'), '\uFEFF#!/usr/bin/env node\nconsole.log(1);\n');
    fs.writeFileSync(path.join(copia, 'scripts', 'solo-bom.js'), "\uFEFF'use strict';\nmodule.exports = 1;\n");
    fs.writeFileSync(path.join(copia, 'scripts', 'solo-guion.js'), '#!/usr/bin/env node\nconsole.log(1);\n');
    const rutas = ['scripts/bom-y-guion.js', 'scripts/solo-bom.js', 'scripts/solo-guion.js'];
    const after = { spawned: [] };
    const reference = exp.compilan(copia, rutas, aux, { inProcess: false });
    assert.deepStrictEqual(exp.compilan(copia, rutas, aux, after), reference, 'el mismo informe que un proceso por archivo');
    assert.deepStrictEqual(after.spawned.map((p) => path.basename(p)), ['bom-y-guion.js'], 'el del BOM con guion va a node --check; los otros dos, en el mismo proceso');
  } finally {
    fs.rmSync(copia, { recursive: true, force: true });
    fs.rmSync(aux, { recursive: true, force: true });
  }
});

// ── T83 · story 8.26, AC 30 (el arreglo del 2026-10-12, antes del corte) ───────────────────────────────────────────────
// El ensayo general del corte le preguntó a git, parado en la copia real, por cada carpeta de primer nivel sin nada
// público: el .gitignore de la copia ignoraba 2 de 12. `gitignore-publico` sólo sacaba líneas «!…»; nadie agregaba las
// carpetas que el repo fuente trae y la copia no. En el repo que nace de esa copia, un `git add` común las subía.
// Sin los ignorados de la máquina de quien corre: sin `core.excludesFile` git lee igual `~/.config/git/ignore`, y una
// carpeta ignorada ahí daría verde sin que el .gitignore de la copia la nombre.
const NO_MACHINE_IGNORES = ['-c', 'core.excludesFile=/dev/null'];
/** ¿git ignora esta ruta, parado en ese repo? (0 sí · 1 no), por lo que dice el repo y nada más. */
const ignoredIn = (repo, rel) => gitFx(repo, [...NO_MACHINE_IGNORES, 'check-ignore', '-q', rel], { tolerar: true }).status;
const topFoldersOf = (repo) => gitFx(repo, ['ls-tree', '-d', '--name-only', 'HEAD']).split('\n').filter(Boolean);

test('PublicGitignore_IgnoresFoldersWithNothingPublic — la copia de un solo repo ignora cada carpeta de primer nivel de la que no sale nada', () => {
  const fx = fixture();
  // tres carpetas de primer nivel: una de la que no sale nada, una que la copia sólo recibe por un papel, y las mezcladas
  // de la plantilla (`guides/`, `scripts/`: sale una parte). El .gitignore del repo ya nombra una de las privadas con
  // la misma línea que escribe el exportador, y más abajo la vuelve a abrir con «!» (pase adversarial: dar la carpeta por
  // cubierta porque su línea ya está la dejaba commiteable en la copia; el bloque va entero y al final, donde gana).
  const lista = conPapeles(fx, { 'solo-papel/LEEME.md': '# Papel público\n' });
  lista.packages.core.arnes.out.push({ glob: 'cosas-del-equipo/**', reason: 'notas del equipo' }, { glob: 'solo-papel/**', reason: 'lo interno de la carpeta; el papel llega por su sintético' });
  fx.config({ lista });
  const propio = 'node_modules/\n*.log\n/cosas-del-equipo/\n!/cosas-del-equipo/\n';
  escribir(fx.arnes, { 'cosas-del-equipo/nota.md': 'del equipo\n', 'solo-papel/interno.md': 'no sale\n', '.gitignore': propio });
  commitear(fx.arnes, 'T83: una carpeta sin nada público y otra que sólo recibe un papel');

  const uno = fx.salida('t83-un-repo');
  const r = exportar(fx, ['--package', 'core', '--single-repo', '--output', uno, '--json']);
  assert.strictEqual(r.code, 0, `${r.err}\n${r.out}`);

  // lo que se espera sale de los árboles, no de una lista escrita acá: carpeta del repo fuente que la copia no trae
  const enLaCopia = topFoldersOf(uno);
  const privadas = [...new Set([...topFoldersOf(fx.arnes), ...topFoldersOf(fx.skills)])].filter((d) => !enLaCopia.includes(d)).sort();
  for (const d of ['cosas-del-equipo', 'specs', 'tasks', '.engram']) assert.ok(privadas.includes(d), `control: ${d}/ está en el repo fuente y no en la copia (${privadas.join(' ')})`);
  for (const d of ['solo-papel', 'guides', 'scripts']) assert.ok(enLaCopia.includes(d), `control: ${d}/ está en la copia (${enLaCopia.join(' ')})`);
  assert.ok(existe(uno, 'solo-papel/LEEME.md') && !existe(uno, 'solo-papel/interno.md'), 'control: de solo-papel/ sale el papel y nada más');

  // 🔴 rojo previo: cosas-del-equipo/ (y cada privada que el repo no ignoraba ya) NO estaba ignorada en la copia
  // (dos nombres por carpeta, uno en la raíz de la carpeta y uno adentro: una excepción «!» escrita para un archivo
  // puntual no deja pasar la carpeta entera por haber preguntado por otro)
  for (const d of privadas) {
    for (const f of ['algo-nuevo.txt', 'adentro/otro.md']) {
      assert.strictEqual(ignoredIn(uno, `${d}/${f}`), 0, `${d}/ no sale en la copia: su .gitignore la tiene que ignorar (${d}/${f})\n${leer(uno, '.gitignore')}`);
    }
  }
  // ni una de más: una carpeta que la copia trae —entera, en parte o por un papel— sigue recibiendo archivos nuevos
  for (const d of enLaCopia) assert.strictEqual(ignoredIn(uno, `${d}/algo-nuevo.txt`), 1, `${d}/ está en la copia: no se ignora\n${leer(uno, '.gitignore')}`);
  assert.strictEqual(gitFx(uno, [...NO_MACHINE_IGNORES, 'ls-files', '-ci', '--exclude-standard']), '', 'ningún archivo de la copia queda ignorado por su propio .gitignore');

  // la forma: las líneas del repo primero, tal cual; después el bloque, con una línea «/carpeta/» por CADA privada, en
  // orden —también la que el repo ya nombraba: el bloque depende del árbol y de nada más—
  const texto = leer(uno, '.gitignore');
  const partes = splitPrivateBlock(texto);
  assert.ok(partes.own.startsWith(propio), `las líneas del repo quedan primero y como estaban:\n${texto}`);
  assert.deepStrictEqual(partes.folders, privadas.map((d) => `/${d}/`), 'una línea anclada a la raíz por carpeta privada, en orden: ni una más, ni una menos');
  assert.ok(!linesOf(texto).some((l) => l.includes('perfil-equipo')), 'sólo carpetas: un archivo suelto de la raíz que no sale no entra al bloque');
  assert.ok(texto.endsWith('\n') && !texto.endsWith('\n\n'), 'termina en un solo salto de línea');

  // el ajuste lleva el nombre que ya existía y dice qué carpetas sumó; el archivo queda entre los transformados
  const ajuste = r.json.ajustes.filter((a) => a.transformacion === 'gitignore-publico' && a.archivo === 'arnes/.gitignore');
  assert.ok(ajuste.some((a) => a.detalle.includes('cosas-del-equipo')), `el ajuste nombra la carpeta que sumó: ${JSON.stringify(ajuste)}`);
  assert.ok(String(new Map(r.json.transformed.map((t) => [t.path, t.transform])).get('.gitignore')).split('+').includes('gitignore-publico'),
    `.gitignore, entre los transformados, con su ajuste: ${JSON.stringify(r.json.transformed)}`);

  // la copia de dos repos (la de antes del repo único) no cambia: cada .gitignore sale como está en su repo
  const dos = fx.salida('t83-dos-repos');
  const rDos = exportar(fx, ['--package', 'core', '--output', dos, '--json']);
  assert.strictEqual(rDos.code, 0, `${rDos.err}\n${rDos.out}`);
  assert.strictEqual(leer(dos, 'arnes/.gitignore'), propio, 'sin --single-repo, el .gitignore del arnés sale tal cual');
  assert.deepStrictEqual(ajustesDe(rDos.json, 'gitignore-publico'), [], 'y sin ningún ajuste');

  // una copia que no lleva .gitignore (el paquete solo) no gana uno: no hay archivo al que sumarle nada
  const solo = fx.salida('t83-paquete-solo');
  const rSolo = exportar(fx, ['--package', 'bizuit', '--single-repo', '--output', solo, '--json']);
  assert.strictEqual(rSolo.code, 0, `${rSolo.err}\n${rSolo.out}`);
  assert.ok(!existe(solo, '.gitignore'), 'el paquete solo no trae .gitignore y el exportador no le inventa uno');
});

// Los nombres raros, sobre la función misma (un árbol con esos nombres no se puede armar en disco en Windows): lo que git
// leería como patrón va escapado y de verdad ignora ESA carpeta; un salto de línea no se puede escribir y frena.
test('PublicGitignore_FolderNames_EscapedOrRefused — un nombre con caracteres de patrón se escapa; con un salto de línea, la copia no sale', () => {
  const ex = require(EXPORTAR);
  const shape = (texto) => new Map([['.gitignore', { fuente: 'arnes', ruta: '.gitignore', destino: '.gitignore', modo: '100644', datos: Buffer.from(texto, 'utf8') }],
    ['scripts/hola.js', { fuente: 'arnes', ruta: 'scripts/hola.js', destino: 'scripts/hola.js', modo: '100644', datos: Buffer.from('1\n') }]]);
  const treeOf = (...rutas) => ({ arboles: { arnes: rutas.map((ruta) => ({ ruta })), 'agent-skills': [] } });
  // (en Windows `\`, `*`, `?` y un espacio final no pueden estar en el nombre de una carpeta, y git lee `\` como barra:
  // ahí se mide con los que sí puede haber)
  const raras = ['con[corchetes]', '#numeral', '!negada', ...(process.platform === 'win32' ? [] : ['con*asterisco', 'con?pregunta', 'con\\barra', 'termina en espacio '])];

  const forma = shape('node_modules/');   // sin salto final: el bloque no se pega a la última línea
  const ajustes = [];
  ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'suelto.txt', ...raras.map((d) => `${d}/nota.md`)), forma, ajustes);
  const texto = forma.get('.gitignore').datos.toString('utf8');
  assert.ok(texto.startsWith(`node_modules/\n${ex.PRIVATE_FOLDERS_NOTE[0]}\n`), `la línea del repo queda entera y el bloque arranca en la suya:\n${texto}`);
  assert.strictEqual(ajustes.length, 1, 'un ajuste');
  // se le pregunta a git, en un repo vacío con ese .gitignore: ignora cada carpeta rara, y no ignora a sus vecinas
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'exportador-ignorados-'));
  creados.push(repo);
  gitFx(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), texto);
  for (const d of raras) assert.strictEqual(ignoredIn(repo, `${d}/algo-nuevo.txt`), 0, `«${d}/» queda ignorada\n${texto}`);
  for (const d of ['scripts', 'conXasterisco', 'con1', 'termina en espacio', 'numeral', 'negada', 'otra/con[corchetes]']) {
    assert.strictEqual(ignoredIn(repo, `${d}/algo-nuevo.txt`), 1, `«${d}/» no es ninguna de las privadas: no se ignora\n${texto}`);
  }

  // un salto de línea en el nombre (o un retorno de carro): no se escribe media línea ni se saltea la carpeta en silencio
  const antes = shape('node_modules/\n');
  for (const nombre of ['con\nsalto', 'con\rretorno']) {
    assert.throws(() => ex.ignorePrivateFolders(treeOf('scripts/hola.js', `${nombre}/nota.md`), antes, []), /salto de línea/, JSON.stringify(nombre));
  }
  assert.strictEqual(antes.get('.gitignore').datos.toString('utf8'), 'node_modules/\n', 'y el .gitignore queda como estaba');

  // las carpetas salen de las DOS fuentes lógicas: una privada que sólo está del lado de agent-skills entra igual
  const dosFuentes = shape('node_modules/\n');
  ex.ignorePrivateFolders({ arboles: { arnes: [{ ruta: 'scripts/hola.js' }, { ruta: 'del-arnes/nota.md' }], 'agent-skills': [{ ruta: 'de-skills/nota.md' }] } }, dosFuentes, []);
  assert.deepStrictEqual(splitPrivateBlock(dosFuentes.get('.gitignore').datos.toString('utf8')).folders, ['/de-skills/', '/del-arnes/']);

  // un .gitignore vacío: el bloque, sin una línea en blanco delante
  const vacio = shape('');
  ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'privada/nota.md'), vacio, []);
  assert.strictEqual(vacio.get('.gitignore').datos.toString('utf8'), `${ex.PRIVATE_FOLDERS_NOTE.join('\n')}\n/privada/\n`);
  // lo que el .gitignore ya traía queda BYTE A BYTE: saltos de Windows, y bytes que no son UTF-8 (pasarlo por texto los
  // cambiaba por el carácter de reemplazo, y esa línea dejaba de ignorar lo suyo). El bloque va detrás, siempre.
  const bloque = Buffer.from(`${ex.PRIVATE_FOLDERS_NOTE.join('\n')}\n/privada/\n`, 'utf8');
  for (const [que, bytes] of [['saltos de Windows y la línea ya escrita', Buffer.from('node_modules/\r\n/privada/\r\n')],
    ['un byte que no es UTF-8', Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('/\n')])],
    ['sin salto final', Buffer.from('node_modules/')]]) {
    const forma2 = shape('');
    forma2.set('.gitignore', { ...forma2.get('.gitignore'), datos: bytes });
    ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'privada/nota.md'), forma2, []);
    const pegamento = bytes[bytes.length - 1] === 0x0a ? Buffer.alloc(0) : Buffer.from('\n');
    assert.ok(forma2.get('.gitignore').datos.equals(Buffer.concat([bytes, pegamento, bloque])), `${que}: lo de antes, intacto, y el bloque detrás`);
  }

  // una carpeta privada que sólo difiere en mayúsculas de una que sale: en Mac y en Windows git aplica el .gitignore sin
  // distinguir la caja, y su línea ignoraría la pública entera. No se escribe: la copia no sale, nombrando las dos.
  const caja = shape('node_modules/\n');
  assert.throws(() => ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'Scripts/nota.md'), caja, []), /Scripts.*scripts|scripts.*Scripts/);
  assert.strictEqual(caja.get('.gitignore').datos.toString('utf8'), 'node_modules/\n', 'y el .gitignore queda como estaba');
  // el .gitignore unido de dos repos físicos no es de ninguna fuente: su ajuste se anota del lado del arnés
  const unido = shape('node_modules/\n');
  unido.set('.gitignore', { ...unido.get('.gitignore'), fuente: null });
  const ajustesUnido = [];
  ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'privada/nota.md'), unido, ajustesUnido);
  assert.deepStrictEqual(ajustesUnido.map((a) => `${a.transformacion} ${a.archivo}`), ['gitignore-publico arnes/.gitignore']);

  // nada que sumar (todo lo del árbol sale), o sin .gitignore en la copia: ni cambio ni ajuste
  const igual = shape('node_modules/\n');
  const sinAjustes = [];
  ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'suelto.txt'), igual, sinAjustes);
  assert.strictEqual(igual.get('.gitignore').datos.toString('utf8'), 'node_modules/\n');
  const sinArchivo = new Map([['scripts/hola.js', igual.get('scripts/hola.js')]]);
  ex.ignorePrivateFolders(treeOf('scripts/hola.js', 'privada/nota.md'), sinArchivo, sinAjustes);
  assert.ok(!sinArchivo.has('.gitignore') && sinAjustes.length === 0, 'sin .gitignore en la copia no se inventa uno');
});

// El nombre de una carpeta privada pasa a un archivo que SE PUBLICA. Si ese nombre es uno de los que no pueden salir, la
// copia no sale: el bloque entra antes de que el detector mire la copia, y la línea del .gitignore es un hallazgo más.
test('PublicGitignore_PrivateFolderWithDeniedName_StopsTheCopy — una carpeta privada con un nombre que no puede salir frena la copia', () => {
  const fx = fixture();
  const lista = clonar(LISTA_BASE);
  lista.packages.core.arnes.out.push({ glob: 'notas-de-globex.interno/**', reason: 'notas del equipo' });
  fx.config({ lista, denegados: { ...DENEGADOS_BASE, patrones: [{ nombre: 'host-de-globex', categoria: 'host-interno', regex: 'globex\\.interno' }] } });
  escribir(fx.arnes, { 'notas-de-globex.interno/nota.md': 'del equipo\n' });
  commitear(fx.arnes, 'T83: una carpeta privada con un nombre de la lista de denegación');

  // control: en la copia de dos repos nadie escribe ese nombre (la carpeta no sale y el .gitignore no cambia)
  const dos = exportar(fx, ['--package', 'core', '--output', fx.salida('t83-nombre-dos'), '--json']);
  assert.strictEqual(dos.code, 0, `${dos.err}\n${dos.out}`);

  const salida = fx.salida('t83-nombre-uno');
  const r = exportar(fx, ['--package', 'core', '--single-repo', '--output', salida, '--json']);
  assert.strictEqual(r.code, 1, `con el repo único el nombre llegaría al .gitignore publicado: la copia no sale\n${r.err}\n${r.out.slice(0, 600)}`);
  assert.ok(!fs.existsSync(salida), 'sin salida');
  const hallazgos = r.json.detector[PUBLICO.repo].hallazgos;
  assert.ok(hallazgos.length > 0 && hallazgos.every((h) => h.archivo === '.gitignore'), `el hallazgo es del .gitignore de la copia: ${JSON.stringify(hallazgos).slice(0, 400)}`);

  // Y el nombre PEGADO a otra palabra y en minúsculas, que el detector deja pasar (su borde de palabra no lo ve, y su
  // regla de CamelCase tampoco): lo ve el control de nombres pegados del exportador, que tiene que leer el .gitignore
  // que SALE (con el bloque) y no el del repo. 🔴 rojo previo: leyendo el del repo, esta copia salía.
  const fx2 = fixture();
  const lista2 = clonar(LISTA_BASE);
  lista2.packages.core.arnes.out.push({ glob: 'acmecorpnotas/**', reason: 'notas del equipo' });
  fx2.config({ lista: lista2 });
  escribir(fx2.arnes, { 'acmecorpnotas/nota.md': 'del equipo\n' });
  commitear(fx2.arnes, 'T83: una carpeta privada con un nombre pegado');
  const pegado = exportar(fx2, ['--package', 'core', '--single-repo', '--output', fx2.salida('t83-pegado')]);
  assert.strictEqual(pegado.code, 1, `el nombre pegado llegaría al .gitignore publicado: la copia no sale\n${pegado.err}\n${pegado.out.slice(0, 600)}`);
  assert.match(pegado.out, /\.gitignore:\d+/, 'el control nombra el .gitignore y la línea');
  assert.ok(!fs.existsSync(fx2.salida('t83-pegado')), 'sin salida');
});
