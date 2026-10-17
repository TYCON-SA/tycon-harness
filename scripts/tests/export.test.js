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
// (el del medio es un revisor de paquete de juguete: los revisores reales del stack viven en su paquete, en la capa)
const REVISORES = ['revisor-nucleo', 'revisor-del-paquete', 'revisor-cliente'];
const agente = (nombre, cuerpo) =>
  `---\nname: ${nombre}\ndescription: Revisor de mentira ${nombre}\nmodel: sonnet\ntools: Read, Grep, Glob\n---\n\n${cuerpo}\n`;

const MANIFIESTO = `${JSON.stringify({ advisors: REVISORES }, null, 2)}\n`;
const LINEA_BASE = `${JSON.stringify({
  fixed_at: '2026-01-01T00:00:00Z', tool: 'claude', runs: 1,
  cases: {
    'revisor-nucleo::caso-1': true,
    'revisor-del-paquete::caso-1': true,
    'revisor-nucleo::limpio': true,
    'revisor-cliente::caso-1': false,
  },
}, null, 2)}\n`;
const CATALOGO = [
  '# Catálogo de reglas', '', 'Intro.', '',
  '## Núcleo — `revisor-nucleo`', '', 'Reglas NUC-C1.', '',
  '## .NET — `revisor-del-paquete`', '', 'Reglas DOTNET-C1.', '', '```text', '~~~', '## esto no es un encabezado', '```', '',
  '## Cliente — `revisor-cliente`', '', 'Reglas XPAT-C1.', '',
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
        in: ['packs/bizuit/pack.json', 'agents/revisor-del-paquete.md', 'skills/bizuit-sdd/**'],
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
    'agents/revisor-del-paquete.md': agente('revisor-del-paquete', 'Revisa convenciones .NET.'),
    'agents/revisor-cliente.md': agente('revisor-cliente', 'Revisa lo del cliente.'),
    'packs/bizuit/pack.json': `${JSON.stringify({ name: 'bizuit', reviewers: [{ agent: 'revisor-del-paquete', group: 'base' }] }, null, 2)}\n`,
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

const sinArchivo = (tabla) => tabla.exclusionesSinArchivo.map((x) => `${x.origen} ${x.fuente}/${x.glob}`).sort();

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

// ══ story 8.7, tanda A — los papeles y el repo único ════════════════════════════════════════════════════════════════
// Los marcadores de bloque se arman por partes: ninguna línea de este archivo es exactamente un marcador (el exportador
// frena un marcador solo en su línea fuera de un `.md`).
const MARCA = {
  IS: '<!-- tycon:' + 'internal-start -->',
  IE: '<!-- tycon:' + 'internal-end -->',
  PS: '<!-- tycon:' + 'public-only',
  PE: '-' + '->',
};
const PAPELES = 'scripts/publishing/public-files';
// EL REPO PRIVADO ADELGAZADO (story 8.26, tanda I, 2026-10-13). Ahí las pruebas corren sobre el árbol armado: lo público
// llega encima, y con él los guiones de entrada y la lista de remotos en scripts/setup/. «En el interno no existe» no se
// puede cumplir, así que esas dos afirmaciones no se exigen cuando la lista del privado (.tycon/internal-forms.json) dice
// `layout: thin`; lo demás de cada caso (la plantilla, su declaración en la lista blanca) sí. Sin esa lista —el público,
// o un privado de antes— no cambia nada.
const THIN_PRIVATE = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, '.tycon', 'internal-forms.json'), 'utf8')).layout === 'thin'; } catch (_) { return false; }
})();

// ── T9 · story 8.7, AC 14 — el nombre público, en un solo lugar ─────────────────────────────────────────────────────────
// AC 14 · la clasificación de cada commit (whatShips, la que usan los frenos) lee el nombre público del MISMO commit: un
// archivo roto es «no pude mirar» (tira), nunca «sin nombre público»; ausente (la copia pública no lo trae), sigue sin él.
// Revisión de fallos silenciosos de la tanda A: antes se tragaba cualquier error del lector.
test('PublicNameExceptions_Reader_EveryEntryWithPathAndWhy_NoDuplicates', () => {
  // las excepciones de la dirección del repo público: cada archivo con su motivo, una sola vez
  const ex = require(EXPORTAR);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excepciones-nombre-'));
  try {
    const leer = (datos) => { const f = path.join(dir, 'x.json'); fs.writeFileSync(f, typeof datos === 'string' ? datos : JSON.stringify(datos)); return ex.readPublicNameExceptions(f); };
    assert.deepStrictEqual(leer({ files: [{ path: 'a.js', why: ' una etiqueta ' }, { path: 'carpeta/', why: 'datos' }] }), [{ path: 'a.js', why: 'una etiqueta' }, { path: 'carpeta/', why: 'datos' }]);
    for (const [que, datos, re] of [
      ['sin lista', {}, /no traen "files"/],
      ['sin motivo', { files: [{ path: 'a.js', why: '  ' }] }, /a\.js no trae "why"/],
      ['sin ruta', { files: [{ why: 'x' }] }, /no trae "path"/],
      ['repetida', { files: [{ path: 'a.js', why: 'x' }, { path: 'a.js', why: 'y' }] }, /a\.js está dos veces/],
      ['JSON roto', '{ "files": ', /./],
    ]) assert.throws(() => leer(datos), re, que);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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

// ── story 8.13, tanda D (decisión A1) — el archivo que dice cuál es el remoto público ───────────────────────────────────
// La copia lleva `scripts/setup/public-remotes.json` con el nombre público ya puesto: con él, el programa de instalación
// reconoce un clon del público. Es un papel más (vive en public-files/ con los marcadores y llega por un sintético); en
// el interno ese archivo no existe en `scripts/setup/`, así que un clon interno nunca es «público».
const REMOTOS = 'scripts/setup/public-remotes.json';
const PLANTILLA_REMOTOS = '{ "remotes": ["https://github.com/{{public-org}}/{{public-repo}}"] }\n';

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
// el despachador de un commit del repo unido anterior al control único (corría las dos partes)
const OLD_DISPATCHER = '#!/usr/bin/env bash\n# despachador de mentira: corre pre-commit-harness y pre-commit-skills\nexit 0\n';

test('Export_SplitHooks_Direct_PartAlreadyThere_OneControl_NothingToSplit', () => {
  const ex = require(EXPORTAR);
  assert.strictEqual(typeof ex.splitHooks, 'function', 'el exportador exporta splitHooks (su prueba fuerza el camino de error)');
  const b = (t) => ({ datos: Buffer.from(t, 'utf8') });
  const full = () => new Map([
    ['arnes/.githooks/pre-commit', b(OLD_DISPATCHER)],
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
  // el control único (.githooks/pre-commit y .githooks/pre-commit-checks, los dos del arnés): no hay nada que partir
  const unico = new Map([['arnes/.githooks/pre-commit', b('#!/usr/bin/env bash\nexec .githooks/pre-commit-checks\n')], ['arnes/.githooks/pre-commit-checks', b(HARNESS_HOOK)]]);
  const ajustesUnico = [];
  ex.splitHooks(unico, ajustesUnico);
  assert.deepStrictEqual([[...unico.keys()].sort(), ajustesUnico], [['arnes/.githooks/pre-commit', 'arnes/.githooks/pre-commit-checks'], []]);
  // …salvo que el envoltorio salga sin la parte que ejecuta: NoPudo, no un pre-commit que llama a un archivo que no está
  const cojo = new Map([['arnes/.githooks/pre-commit', b('#!/usr/bin/env bash\nexec .githooks/pre-commit-checks\n')]]);
  assert.throws(() => ex.splitHooks(cojo, []), (e) => e instanceof ex.NoPudo && /no arnes\/\.githooks\/pre-commit-checks/.test(e.message));
  // un pre-commit suelto que no llama a ninguna parte (el de un commit viejo) sale como está
  const suelto = new Map([['arnes/.githooks/pre-commit', b(HARNESS_HOOK)]]);
  ex.splitHooks(suelto, []);
  assert.deepStrictEqual([...suelto.keys()], ['arnes/.githooks/pre-commit']);
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

// story 8.41, AC 33 (T26): el exportador ya no trae la transformación que juntaba dos pre-commit con un despachador generado
test('T26 Export_NoMergedHooksTransform', () => {
  const ex = require(EXPORTAR);
  assert.ok(!ex.TRANSFORMACIONES.some((c) => c.nombre === 'merged-hooks'), 'la lista de transformaciones no nombra merged-hooks');
  assert.ok(ex.TRANSFORMACIONES.some((c) => c.nombre === 'split-hooks'), 'la de partir el pre-commit de un commit viejo sigue');
  assert.strictEqual(ex.PRE_COMMIT_DISPATCHER, undefined, 'el exportador no trae el texto de un despachador');
  const src = fs.readFileSync(EXPORTAR, 'utf8');
  assert.doesNotMatch(src, /const PRE_COMMIT_DISPATCHER\b/, 'el exportador no arma el despachador');
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

// ── story 8.10.3, tanda B · pase de fallos silenciosos (W8) y pase adversarial (clases 1-4, 6-8): la marca y su control
// cuentan lo mismo sobre el mismo corpus — sobre el texto sin marcar, el control encuentra exactamente lo que la marca
// marca; sobre el texto marcado, nada. Así no pueden desincronizarse en silencio ni frenar algo que la marca no arregla.
test('Exporter_PathsNotInCopy_AgreesWithMarkOnCorpus', () => {
  const ex = require(EXPORTAR);
  const pc = require(path.join(RAIZ, 'scripts', 'publishing', 'public-copy.js'));
  const equipo = new Set(['tasks', 'tasks/x.md', 'scripts', 'scripts/y.js', 'guides', 'guides/vecina.md', 'guides/a.md', 'guides/maintaining/incident-log.md',
    '.tycon', '.tycon/advisors.yaml', 'inbox', 'specs', 'specs/story-1.2-algo.md', 'guides/sub', 'guides/sub/specs', 'guides/sub/specs/x.md', 'skills', 'skills/s', 'skills/s/steps', 'skills/s/steps/p.md']);
  const copia = new Set(['guides', 'guides/a.md', 'skills', 'skills/s', 'skills/s/steps', 'skills/s/steps/p.md']);
  const opts = { inRepo: (p) => equipo.has(p), inCopy: (p) => copia.has(p), conventions: ['.tycon/', 'specs', 'tasks/todo.md'], installPrefixes: ['~/.claude/acme-lugar/', [/^~\/\.claude\/acme-sk\//, 'skills/']] };
  const corpus = [
    ['guides/a.md', 'Ver `tasks/x.md`, `vecina.md`, `a.md`, `inbox` y `scripts/zzz.js`.\nLa config: `.tycon/advisors.yaml`; `specs`; `specs/story-1.2-algo.md`.\n'],
    ['guides/a.md', 'El caso: `guides/maintaining/incident-log.md#x-2026-01-01` y `guides/maintaining/incident-log.md`.\nCon línea `scripts/y.js:3-4`, `~/.claude/acme-lugar/tasks/x.md` y `~/.claude/acme-sk/s/steps/q.md`.\n'],
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
    // story 8.26 (AC 36): el exportador ya no arma; la lista se valida igual al clasificar
    const r = exportar(fx, ['--explain']);
    assert.strictEqual(r.code, 2, `${JSON.stringify(extra)} sale 2\n${r.err}\n${r.out}`);
    assert.match(`${r.err}${r.out}`, /readerConventions/);
  });
  assert.deepStrictEqual(temporales(fx), []);
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

// ── story 8.26, AC 36 (T36) · el exportador queda como control: clasifica y no arma ──────────────────────────────────
// Desde el corte a GitHub el repo público es la fuente y nadie arma una copia. Pedirle una al exportador sale 2 diciéndolo
// —con cualquiera de las opciones con que se la pedía, también con --json—, sin escribir nada ni tocar las fuentes. La
// clasificación sigue: `--explain` clasifica el primer nivel (0) y `whatShips` sigue siendo la biblioteca de los frenos.
// La cuenta de las pruebas de este archivo: 95 antes, 17 después (salieron las 79 que medían la copia armada; una pasó a
// medir el control y ésta es nueva).
test('T36 Exporter_ClassifiesAndVerifiesOnly — pedirle la copia sale 2 sin escribir nada; --explain clasifica', () => {
  const fx = fixture();
  const antes = [fx.arnes, fx.skills].map((d) => gitFx(d, ['status', '--porcelain', '--untracked-files=all']));
  const pedidos = [
    ['--package', 'core', '--output', fx.salida('t36-a')],
    ['--package', 'core,bizuit', '--single-repo', '--output', fx.salida('t36-b')],
    ['--package', 'core,bizuit', '--single-repo', '--stamp-version', '2026.10.14.1', '--output', fx.salida('t36-c')],
    [],
  ];
  for (const args of pedidos) {
    const r = exportar(fx, args);
    assert.strictEqual(r.code, 2, `${args.join(' ') || '(sin opciones)'}: sale 2\n${r.err}${r.out}`);
    assert.match(r.err, /ya no arma la copia: el repo público es la fuente/, args.join(' '));
    const j = exportar(fx, [...args, '--json']);
    assert.strictEqual(j.code, 2);
    assert.deepStrictEqual(j.json && [j.json.resultado, /ya no arma la copia/.test(j.json.motivo)], [2, true], `--json: el motivo en el objeto\n${j.out}`);
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(fx.dir, 'out')), [], 'no quedó ninguna copia, ni temporal, ni listado');
  assert.deepStrictEqual([fx.arnes, fx.skills].map((d) => gitFx(d, ['status', '--porcelain', '--untracked-files=all'])), antes, 'las fuentes, sin tocar');

  // el control sigue: el primer nivel clasificado, sin entradas sin clasificar
  const e = exportar(fx, ['--explain', '--json']);
  assert.strictEqual(e.code, 0, `${e.err}${e.out}`);
  assert.ok(e.json && e.json.primerNivel.length > 0, 'clasifica el primer nivel');
  assert.deepStrictEqual(e.json.sinClasificar, []);
  const ex = require(EXPORTAR);
  for (const f of ['whatShips', 'coincide', 'readPublicRepo', 'validarLista', 'primerNivel']) assert.strictEqual(typeof ex[f], 'function', `la biblioteca sigue trayendo ${f}`);
  const fuente = fs.readFileSync(EXPORTAR, 'utf8');
  for (const armado of ['function exportar(', 'function commitear(', 'function escribirListado(', 'function regenerarCodex(']) {
    assert.ok(!fuente.includes(armado), `el código que armaba la copia ya no está (${armado})`);
  }
});
