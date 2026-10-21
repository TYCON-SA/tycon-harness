'use strict';

/**
 * new-names.test.js — el freno de nombres reales nuevos en lo que se publica.
 *
 * Lo que no se puede perder:
 *   · Que un commit que mete un nombre real en un archivo que sale en la copia pública no se cree, y que el mensaje
 *     diga dónde, qué y cómo salir.
 *   · Que no frene lo que ya estaba: retocar, mover o renombrar una línea que ya tenía el nombre, o traer `main` a una
 *     rama. Un freno que salta por eso se termina salteando.
 *   · Que «no pude mirar» frene, y que apagado lo diga en cada commit.
 *
 * Arma en un temporal un arnés y un agent-skills DE LABORATORIO con git de verdad y configuraciones SINTÉTICAS
 * (AcmeCorp, Globex, Initech, Vandelay…): nunca lee la lista de denegación ni la tabla de reemplazos reales, que son
 * privadas y en la copia pública, donde esta suite también corre, no existen. Los registros van a una HOME temporal.
 * Una sola excepción (T25): `Unified_RealUnionRange_PassesBothSources` corre el freno sobre el commit de la
 * unión de verdad, sólo en el clon del equipo, y mira su código de salida y sus conteos — nunca un texto encontrado.
 */

const test = require('./lib/suite-parts.js').test;   // se corre por partes: lib/suite-parts.js
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const NEW_NAMES = path.join(RAIZ, 'scripts', 'publishing', 'new-names.js');
// el guion de los controles del pre-commit según el layout: `.githooks/pre-commit` sólo llama a
// `.githooks/pre-commit-checks`, que es el de verdad (lo elige scripts/tests/lib/pre-commit-hook.js)
const { preCommitHook } = require('./lib/pre-commit-hook.js');
const HOOK = preCommitHook('harness', RAIZ);

// ── git del laboratorio: sin la configuración de la máquina ni las variables que git le pasa a sus hooks ───────
function cleanEnv(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('TYCON_')) e[k] = v;
  return {
    ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    ...extra,
  };
}
function git(dir, args, { tolerate = false } = {}) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { env: cleanEnv(), encoding: 'utf8' });
  if (r.status !== 0 && !tolerate) throw new Error(`git ${args.join(' ')} (${dir}): ${r.stderr}`);
  return tolerate ? r : r.stdout.trim();
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
const stage = (repo, files) => { write(repo, files); git(repo, ['add', '-A']); };
const commit = (repo, msg) => { git(repo, ['commit', '-q', '-m', msg]); return git(repo, ['rev-parse', 'HEAD']); };
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── la configuración sintética ─────────────────────────────────────────────────────────────────────────────────
const LIST = {
  __doc: 'Lista blanca de laboratorio.',
  packages: {
    core: {
      arnes: {
        in: ['README.md', 'guides/**', 'scripts/**', 'adapters/**'],
        out: [{ glob: 'guides/fuera.md', reason: 'prueba: queda afuera' }, { glob: 'onboarding/**', reason: 'prueba: lo interno del equipo' }],
      },
      'agent-skills': {
        in: ['agents/*.md', 'skills/tycon-*/**'],
        out: [{ glob: 'packs/**', reason: 'viajan con su paquete' }, { glob: 'README.md', reason: 'prueba: lo trae otra story', until: '8.7' }],
      },
    },
    bizuit: {
      arnes: { in: ['guides/bizuit/x.md'], out: [] },
      'agent-skills': { in: ['packs/bizuit/pack.json', 'agents/revisor-publico.md'], out: [] },
    },
  },
  suitesOutside: [],
  casesOutside: [],
  empty: { 'scripts/config.json': ['maquina'] },
  synthetic: [{ target: 'scripts/ci/deuda.json', from: 'scripts/publishing/synthetic/deuda.json', reason: 'prueba: el real es del equipo' }],
};
const DENIED = {
  terminos: [
    { patron: 'AcmeCorp', categoria: 'cliente', palabra: true },
    { patron: 'Globex', categoria: 'cliente', palabra: true },
    { patron: 'Initech', categoria: 'cliente', palabra: true },
    { patron: 'Vandelay', categoria: 'persona', palabra: true },
  ],
  permitidos: [{ archivo: 'guides/permitido.md', patron: '^Initech$', motivo: 'prueba: una excepción que ya estaba' }],
};
const TABLE = {
  pares: [
    { real: 'AcmeCorp', categoria: 'cliente', palabra: true, formas: [{ texto: 'AcmeCorp', anonimo: 'Ceibo' }] },
    { real: 'Globex', categoria: 'cliente', palabra: true, formas: [{ texto: 'Globex', anonimo: 'Gamma' }] },
    { real: 'Initech', categoria: 'cliente', palabra: true, formas: [{ texto: 'Initech', anonimo: 'Iris' }] },
  ],
  afuera: [{ glob: 'arnes/guides/privado.md', motivo: 'prueba: afuera privado' }],
};
const CEILING = {
  __doc: 'Techo de laboratorio.',
  __last_change: { fecha: '2026-01-01', sentido: 'inicial', motivo: 'prueba' },
  core: { content: 10, paths: 0, glued: 1 },
  bizuit: { content: 0, paths: 0, glued: 0 },
};
const CATALOG = [
  '# Catálogo', '', 'Intro.', '',
  '## Núcleo — `revisor-nucleo`', '', 'Reglas NUC-C1.', '',
  '## Público — `revisor-publico`', '', 'Reglas PUB-C1.', '',
  '## Cliente — `revisor-cliente`', '', 'Reglas CLI-C1.', '',
].join('\n');
const agent = (name, body) => `---\nname: ${name}\ndescription: Revisor de laboratorio\n---\n\n${body}\n`;

// ── el laboratorio: se arma una vez y cada prueba trabaja sobre su copia ─────────────────────────────────────
let template = null;
function buildTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-names-template-'));
  const arnes = path.join(dir, 'arnes');
  const skills = path.join(dir, 'agent-skills');
  for (const d of [arnes, skills]) { fs.mkdirSync(d, { recursive: true }); git(d, ['init', '-q', '-b', 'main']); }
  // c0 y c1: la historia previa a la configuración (T10 la repite con --config-from disk)
  write(arnes, { 'README.md': '# Arnés de laboratorio\n', 'guides/viejo.md': '# Viejo\n\nLínea limpia.\n' });
  git(arnes, ['add', '-A']); commit(arnes, 'c0');
  write(arnes, { 'guides/viejo.md': '# Viejo\n\nLínea limpia.\nLo usa AcmeCorp.\n' });
  git(arnes, ['add', '-A']);
  const c1 = commit(arnes, 'c1: un nombre, antes de que existiera la lista blanca');
  write(arnes, {
    'scripts/publishing/allowlist.json': LIST,
    'scripts/publishing/denylist.json': DENIED,
    'scripts/publishing/replacements.json': TABLE,
    'scripts/publishing/names-ceiling.json': CEILING,
    'scripts/publishing/synthetic/deuda.json': '{ "deuda": [] }\n',
    'scripts/ci/deuda.json': '{ "deuda": ["del equipo"] }\n',
    'scripts/ci/product-parity.json': { grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/x' }] } },
    'scripts/config.json': '{\n  "maquina": "",\n  "hora": "02:00"\n}\n',
    'scripts/app.js': "'use strict';\nmodule.exports = 1;\n",
    'scripts/controls-bench/cases/advisors/revisor-cliente.json': '{ "casos": ["lo de AcmeCorp"] }\n',
    'guides/x.md': '# Guía\n\nPrimera línea.\nSegunda línea.\n',
    'guides/m.md': '# M\n\nLínea dos.\n',
    'guides/ya-nombra.md': '# Ya nombra\n\nEsto lo usa AcmeCorp desde siempre.\nOtra línea.\n',
    'guides/fuera.md': '# Fuera\n\nLo usa AcmeCorp.\n',
    'guides/privado.md': '# Privado\n\nLo usa AcmeCorp.\n',
    'guides/hooli.md': '# Hooli\n\nLo usa Hooli.\n',
    'guides/permitido.md': '# Permitido\n',
    'guides/limpio.md': '# Limpio\n',
    'guides/advisor-rules-catalog.md': CATALOG,
    'guides/maintaining/incident-log.md': '# Incidentes\n',
    'adapters/codex/agents/MANIFEST.json': { advisors: ['revisor-nucleo', 'revisor-publico', 'revisor-cliente'] },
    'adapters/codex/agents/revisor-nucleo.toml': 'name = "revisor-nucleo"\n',
    'specs/x.md': '# Story\n',
    'onboarding/x.md': '# Onboarding\n',
    'perfil-equipo.json': '{}\n',
  });
  git(arnes, ['add', '-A']); commit(arnes, 'c2: la configuración');
  write(skills, {
    'agents/revisor-nucleo.md': agent('revisor-nucleo', 'Revisa el núcleo.'),
    'agents/revisor-publico.md': agent('revisor-publico', 'Revisa lo público.'),
    'agents/revisor-cliente.md': agent('revisor-cliente', 'Revisa lo de AcmeCorp.'),
    'packs/bizuit/pack.json': { name: 'bizuit', reviewers: [{ agent: 'revisor-publico', group: 'base' }] },
    'packs/clients/pack.json': { name: 'clients', reviewers: [{ agent: 'revisor-cliente', group: 'condicional' }] },
    'skills/tycon-x/SKILL.md': '# Skill\n',
    'README.md': '# Interno\n',
  });
  git(skills, ['add', '-A']); commit(skills, 'base');
  return { dir, c1 };
}

const created = [];
function lab() {
  if (!template) template = buildTemplate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-names-'));
  created.push(dir);
  fs.cpSync(template.dir, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'home'));
  return { dir, arnes: path.join(dir, 'arnes'), skills: path.join(dir, 'agent-skills'), home: path.join(dir, 'home'), c1: template.c1 };
}

/** Corre el freno como lo corre el hook: parado en el repo, con el otro repo y la HOME del laboratorio. */
function brake(l, { repo = l.arnes, args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [NEW_NAMES, '--repo', repo, ...args], {
    cwd: repo, encoding: 'utf8',
    env: cleanEnv({ TYCON_GUIDES_DIR: l.arnes, TYCON_SKILLS_DIR: l.skills, HOME: l.home, ...env }),
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const skillsBrake = (l, opts = {}) => brake(l, { repo: l.skills, args: ['--source', 'agent-skills', ...(opts.args || [])], env: opts.env });
const resetLab = (repo) => { git(repo, ['reset', '-q', '--hard']); git(repo, ['clean', '-qfd']); };
const edit = (repo, rel, fn) => fs.readFileSync(path.join(repo, rel), 'utf8').split('\n').map(fn).join('\n');

// ── T1 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_NewNameInShippedFile_Blocks', () => {
  const l = lab();
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nPrimera línea.\nLo usa AcmeCorp.\n' });
  const r = brake(l);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.strictEqual(r.code, 1, `un hallazgo es 1 (2 es «no pude mirar»)\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:\d+[^\n]*AcmeCorp/, 'el freno miró y nombró el hallazgo (no es un node que no arrancó)');
});

// ── T2 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_MessageSaysWhereWhatAndHowOut', () => {
  const l = lab();
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nPrimera línea.\nLo usa AcmeCorp.\n' });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/x\.md:4/, 'archivo:línea');
  assert.match(r.out, /cliente/);
  assert.match(r.out, /AcmeCorp/);
  assert.match(r.out, /«Ceibo»/, 'el nombre inventado de la tabla');
  const a = r.out.indexOf('(a)');
  const b = r.out.indexOf('(b)');
  const c = r.out.indexOf('(c)');
  assert.ok(a > 0 && a < b && b < c, `las salidas (a), (b) y (c), en ese orden\n${r.out}`);
  assert.match(r.out.slice(c), /sólo si lo decide una persona, en un commit aparte/i);
  assert.match(r.out.slice(b, c), /incident-log/, '(b) dice dónde vive el caso');
  // el freno no manda a enlazar el registro desde una guía; eso lo mira internal-history.js
  assert.match(r.out.slice(b, c), /no se enlaza/, '(b) no manda a enlazar el registro desde la prosa');
  assert.match(r.out.slice(b, c), /internal-history\.js/);
  // un término sin par en la tabla: la salida (a) ofrece el sujeto genérico o un par nuevo
  resetLab(l.arnes);
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nPrimera línea.\nLo firmó Vandelay.\n' });
  const s = brake(l);
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /Vandelay/);
  assert.match(s.out, /persona/);
  assert.match(s.out, /sin par/i);
  assert.match(s.out.slice(s.out.indexOf('(a)'), s.out.indexOf('(b)')), /sujeto genérico[\s\S]*par nuevo/);
});

// ── T33 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// El mensaje no manda a escribir «el nombre inventado de la tabla». Esos inventados corresponden uno a uno a un real:
// usarlos en un ejemplo nuevo es dejar una pista. La salida (a) manda a un nombre NEUTRO; el de la tabla se muestra
// sólo como lo que la copia va a poner si el real queda.
test('T33 NewNames_Message_SendsToNeutralNames — la salida (a) manda a un nombre neutro, no al inventado de la tabla', () => {
  // la otra mitad del criterio: la sección de la guía dice lo mismo
  {
    const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'guides', 'maintaining', 'publicacion-espejo.md'), 'utf8');
    const from = guide.indexOf('El núcleo sin nombres');
    assert.ok(from >= 0, 'la guía trae la sección «El núcleo sin nombres»');
    const section = guide.slice(from);
    assert.match(section, /nombre neutro/i, 'la sección manda a un nombre neutro');
    // una guía que se publica dice el porqué, no la story que cambió la regla
    assert.match(section, /inventados de la tabla de reemplazos \*\*no\*\* se usan para escribir algo nuevo/, 'la sección dice que los inventados de la tabla no se usan en lo nuevo');
    assert.match(section, /cada uno corresponde a un\s+real/, 'y por qué: cada inventado corresponde a un real');
  }
  const l = lab();
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nPrimera línea.\nLo usa AcmeCorp.\n' });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  const a = r.out.slice(r.out.indexOf('(a)'), r.out.indexOf('(b)'));
  assert.match(a, /nombre neutro/i, '(a) dice «un nombre neutro»');
  assert.match(a, /`acme`/, '(a) da el ejemplo de un cliente neutro');
  assert.match(a, /«Cliente A»/, '(a) da el ejemplo en prosa');
  assert.match(a, /example\.com/, '(a) da el dominio de ejemplo');
  assert.match(a, /inicial/, '(a) dice qué no puede conservar');
  assert.doesNotMatch(r.out, /El nombre inventado de la tabla/, 'ya no manda al inventado de la tabla');
  const finding = r.out.split('\n').find((line) => /guides\/x\.md:4/.test(line));
  assert.match(finding, /la tabla lo tapa con «Ceibo»/, 'el de la tabla se muestra como lo que tapa, no como lo que hay que escribir');
});

// ── T3 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_EditMoveAndRename_DoNotBlock', () => {
  const l = lab();
  const cases = [
    ['retoque', () => stage(l.arnes, { 'guides/ya-nombra.md': '# Ya nombra\n\nEsto lo usa AcmeCorp hace años.\nOtra línea.\n' })],
    ['movida', () => stage(l.arnes, { 'guides/ya-nombra.md': '# Ya nombra\n\nOtra línea.\nEsto lo usa AcmeCorp desde siempre.\n' })],
    ['sangría', () => stage(l.arnes, { 'guides/ya-nombra.md': edit(l.arnes, 'guides/ya-nombra.md', (x) => (x.includes('AcmeCorp') ? `    ${x}` : x)) })],
    ['git mv', () => git(l.arnes, ['mv', 'guides/ya-nombra.md', 'guides/ya-nombra-2.md'])],
  ];
  for (const [what, doIt] of cases) {
    doIt();
    const r = brake(l);
    assert.strictEqual(r.code, 0, `${what}: no frena\n${r.out}`);
    assert.strictEqual(r.out, '', `${what}: y no dice nada`);
    resetLab(l.arnes);
  }
});

// ── T4 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_Merge_CountsAgainstAllParents', () => {
  const l = lab();
  git(l.arnes, ['checkout', '-q', '-b', 'x']);
  write(l.arnes, { 'guides/m.md': '# M\n\nLo usa AcmeCorp.\n' });
  git(l.arnes, ['add', '-A']); commit(l.arnes, 'x: agrega el nombre');
  git(l.arnes, ['checkout', '-q', 'main']);
  write(l.arnes, { 'guides/m.md': '# M\n\nLo usa nadie.\n' });
  git(l.arnes, ['add', '-A']); commit(l.arnes, 'main: otra línea');
  const m = git(l.arnes, ['merge', 'x', '-m', 'merge'], { tolerate: true });
  assert.notStrictEqual(m.status, 0, 'el merge tiene que quedar con conflicto');
  stage(l.arnes, { 'guides/m.md': '# M\n\nLo usa AcmeCorp.\n' });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `lo que ya estaba en un padre no frena\n${r.out}`);
  assert.strictEqual(r.out, '');
  stage(l.arnes, { 'guides/m.md': '# M\n\nLo usa AcmeCorp y Globex.\n' });
  r = brake(l);
  assert.strictEqual(r.code, 1, `un nombre que aparece recién en la resolución frena\n${r.out}`);
  assert.match(r.out, /Globex/);
  assert.doesNotMatch(r.out, /«AcmeCorp»/, 'el que venía de un padre no se nombra');
});

// ── T5 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_GluedName_Blocks', () => {
  const l = lab();
  stage(l.arnes, { 'scripts/app.js': "'use strict';\nconst AcmeCorpBackend = 1;\nmodule.exports = AcmeCorpBackend;\n" });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /AcmeCorpBackend/);
});

// ── T6 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_PathWithName_Blocks', () => {
  const l = lab();
  stage(l.arnes, { 'guides/acmecorp-notas.md': '# Notas\n' });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(ruta\)[^\n]*guides\/acmecorp-notas\.md/);
  resetLab(l.arnes);
  git(l.arnes, ['mv', 'guides/limpio.md', 'scripts/AcmeCorpBackend.js']);
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(ruta\)[^\n]*scripts\/AcmeCorpBackend\.js/);
});

// ── T7 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_FileThatDoesNotShip_Silent', () => {
  const l = lab();
  const add = (rel) => stage(l.arnes, { [rel]: `${fs.readFileSync(path.join(l.arnes, rel), 'utf8')}Lo usa AcmeCorp.\n` });
  for (const rel of ['specs/x.md', 'guides/maintaining/incident-log.md', 'onboarding/x.md', 'scripts/controls-bench/cases/advisors/revisor-cliente.json']) {
    if (rel.endsWith('.json')) stage(l.arnes, { [rel]: '{ "casos": ["lo de AcmeCorp", "y más de AcmeCorp"] }\n' });
    else add(rel);
    const r = brake(l);
    assert.strictEqual(r.code, 0, `${rel}\n${r.out}`);
    assert.strictEqual(r.out, '', `${rel}: no dice nada`);
    resetLab(l.arnes);
  }
  // la sección del catálogo de un revisor del paquete de clientes
  stage(l.arnes, { 'guides/advisor-rules-catalog.md': CATALOG.replace('Reglas CLI-C1.', 'Reglas CLI-C1, para AcmeCorp.') });
  let r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
  // un revisor del paquete de clientes, en agent-skills
  stage(l.skills, { 'agents/revisor-cliente.md': agent('revisor-cliente', 'Revisa lo de AcmeCorp y de Initech.') });
  r = skillsBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
});

// ── T8 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_ContentTransformedLikeTheCopy', () => {
  const l = lab();
  const cases = [
    ['una clave vaciada', { 'scripts/config.json': '{\n  "maquina": "AcmeCorp-01",\n  "hora": "02:00"\n}\n' }, 0],
    ['una traducción a Codex', { 'adapters/codex/agents/revisor-nucleo.toml': 'name = "revisor-nucleo"\n# AcmeCorp\n' }, 0],
    ['la sección de un revisor de un paquete público pendiente', { 'guides/advisor-rules-catalog.md': CATALOG.replace('Reglas PUB-C1.', 'Reglas PUB-C1, para AcmeCorp.') }, 1],
    ['el destino de un sintético', { 'scripts/ci/deuda.json': '{ "deuda": ["AcmeCorp"] }\n' }, 0],
  ];
  for (const [what, files, expected] of cases) {
    stage(l.arnes, files);
    const r = brake(l);
    assert.strictEqual(r.code, expected, `${what}\n${r.out}`);
    if (expected === 1) assert.match(r.out, /guides\/advisor-rules-catalog\.md:11 /, 'la línea REAL del archivo, no la del texto transformado');
    resetLab(l.arnes);
  }
});

// ── T9 ────────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_UnclassifiedEntry_Blocks', () => {
  const l = lab();
  stage(l.arnes, { 'carpeta-nueva/x.md': '# Nada que ver\n' });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /carpeta-nueva/);
  assert.match(r.out, /«in»/);
  assert.match(r.out, /«out»/);
  commit(l.arnes, 'la carpeta entra sin clasificar (por otro camino)');
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nPrimera línea cambiada.\nSegunda línea.\n' });
  r = brake(l);
  assert.strictEqual(r.code, 0, `un commit que no toca esa carpeta sigue su curso\n${r.out}`);
});

// ── T10 ───────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_OtherRepoAndConfig', () => {
  const l = lab();
  // (a) sin el otro repo: aviso fuerte, y deja pasar
  const empty = fs.mkdtempSync(path.join(l.dir, 'vacia-'));
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nLo usa AcmeCorp.\n' });
  let r = brake(l, { env: { TYCON_SKILLS_DIR: empty } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no encontré agent-skills[\s\S]*no se miró si entran nombres/i);
  resetLab(l.arnes);
  // (b) --range clasifica con la punta: la punta saca el «out» de un archivo que ya tenía el nombre
  const base = git(l.arnes, ['rev-parse', 'HEAD']);
  const list = clone(LIST);
  list.packages.core.arnes.out = list.packages.core.arnes.out.filter((x) => x.glob !== 'guides/fuera.md');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list });
  commit(l.arnes, 'la punta deja salir guides/fuera.md');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/fuera\.md/);
  // (c) un commit anterior a la lista blanca: con la de la punta no se puede mirar; con la del disco, sí
  r = brake(l, { args: ['--range', `${l.c1}^..${l.c1}`] });
  assert.strictEqual(r.code, 2, `sin lista blanca en ese commit: no pude mirar\n${r.out}`);
  assert.match(r.out, /no pude mirar/);
  r = brake(l, { args: ['--range', `${l.c1}^..${l.c1}`, '--config-from', 'disk'] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/viejo\.md:4/);
});

// ── T11 ───────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_Reclassify_WhitelistPrivateOutAndPack', () => {
  const l = lab();
  // (1) el commit saca el «out» de la lista blanca
  const list = clone(LIST);
  list.packages.core.arnes.out = list.packages.core.arnes.out.filter((x) => x.glob !== 'guides/fuera.md');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/fuera\.md/);
  resetLab(l.arnes);
  // (2) el commit saca el «afuera» privado de la tabla
  stage(l.arnes, { 'scripts/publishing/replacements.json': { ...clone(TABLE), afuera: [] } });
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/privado\.md/);
  resetLab(l.arnes);
  // (3) el commit de agent-skills mueve el revisor del paquete de clientes a uno público: su caso del banco sale
  stage(l.skills, {
    'packs/bizuit/pack.json': { name: 'bizuit', reviewers: [{ agent: 'revisor-publico', group: 'base' }, { agent: 'revisor-cliente', group: 'condicional' }] },
    'packs/clients/pack.json': { name: 'clients', reviewers: [] },
  });
  r = skillsBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/controls-bench\/cases\/advisors\/revisor-cliente\.json/);
  resetLab(l.skills);
  // (4) el commit trae su propio export.js, que deja de excluir el registro de incidentes: el freno clasifica el después con ESE
  // código (compilado desde el índice, no el del disco) y el registro, que ya tenía un nombre, se mira entero
  stage(l.arnes, { 'guides/maintaining/incident-log.md': '# Incidentes\n\nEl de AcmeCorp.\n' });
  commit(l.arnes, 'el incident-log con un nombre (no sale: exclusión fija)');
  const own = fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'export.js'), 'utf8');
  const other = own.replace(/^ {2}\{ fuente: 'arnes', glob: 'guides\/maintaining\/incident-log\.md'.*\n/m, '');
  assert.notStrictEqual(other, own, 'la prueba necesita sacar la exclusión fija del incident-log');
  stage(l.arnes, { 'scripts/publishing/export.js': other });
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/maintaining\/incident-log\.md:3/);
});

// ── T12 ───────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_SameListAndExceptions', () => {
  const l = lab();
  // el commit suma el término y el archivo ya lo tenía: lo que ya existía no frena
  const denied = clone(DENIED);
  denied.terminos.push({ patron: 'Hooli', categoria: 'cliente', palabra: true });
  const table = clone(TABLE);
  table.pares.push({ real: 'Hooli', categoria: 'cliente', palabra: true, formas: [{ texto: 'Hooli', anonimo: 'Halo' }] });
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied, 'scripts/publishing/replacements.json': table });
  let r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
  resetLab(l.arnes);
  // una excepción que ya estaba en HEAD
  stage(l.arnes, { 'guides/permitido.md': '# Permitido\n\nInitech\n' });
  r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

// ── T13 ───────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_ExceptionWithItsName_Blocks', () => {
  const l = lab();
  const withName = { 'guides/x.md': '# Guía\n\nLo usa Initech.\n' };
  const denied = clone(DENIED);
  denied.permitidos.push({ archivo: 'guides/x.md', patron: '^Initech$', motivo: 'prueba: la excepción del mismo commit' });
  stage(l.arnes, { ...withName, 'scripts/publishing/denylist.json': denied });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /la excepción va en un commit aparte, y la decide una persona/);
  resetLab(l.arnes);
  const list = clone(LIST);
  list.packages.core.arnes.out.push({ glob: 'guides/x.md', reason: 'prueba: el afuera del mismo commit' });
  stage(l.arnes, { ...withName, 'scripts/publishing/allowlist.json': list });
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /la excepción va en un commit aparte, y la decide una persona/);
  resetLab(l.arnes);
  // la excepción sola, en su commit, pasa
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied });
  r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

// ── T14 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_CouldNotLook_Blocks', () => {
  const l = lab();
  const name = { 'guides/x.md': '# Guía\n\nLo usa AcmeCorp.\n' };
  const cases = [
    ['la lista no se lee', { ...name, 'scripts/publishing/denylist.json': '{ esto no es JSON' }],
    ['un regex que no compila', { ...name, 'scripts/publishing/denylist.json': { ...clone(DENIED), patrones: [{ nombre: 'roto', categoria: 'cliente', regex: '(' }] } }],
    ['la clasificación tira', { ...name, 'scripts/publishing/allowlist.json': { __doc: 'sin paquetes' } }],
    ['el exportador del commit no compila', { ...name, 'scripts/publishing/export.js': "'use strict';\nmodule.exports = {;\n" }],
    ['el manifiesto de Codex no se lee', { ...name, 'adapters/codex/agents/MANIFEST.json': '{ roto' }],
  ];
  for (const [what, files] of cases) {
    stage(l.arnes, files);
    const r = brake(l);
    assert.strictEqual(r.code, 2, `${what}\n${r.out}`);
    assert.match(r.out, /no pude mirar/, what);
    resetLab(l.arnes);
  }
  // las listas privadas rotas no se citan: ni un pedazo del JSON ni el valor que nombra un error de validación
  const privados = [
    ['la lista rota con un nombre adentro', { ...name, 'scripts/publishing/denylist.json': '{ "terminos": [{ "patron": "Umbrellacorp", ' }],
    ['un término sin categoría', { ...name, 'scripts/publishing/denylist.json': { terminos: [...clone(DENIED).terminos, { patron: 'Umbrellacorp' }] } }],
    ['la tabla rota con un nombre adentro', { ...name, 'scripts/publishing/replacements.json': '{ "pares": [{ "real": "Umbrellacorp", ' }],
    ['un par sin categoría', { ...name, 'scripts/publishing/replacements.json': { ...clone(TABLE), pares: [...clone(TABLE).pares, { real: 'Umbrellacorp', formas: [{ texto: 'Umbrellacorp', anonimo: 'Uva' }] }] } }],
  ];
  for (const [what, files] of privados) {
    stage(l.arnes, files);
    const r = brake(l);
    assert.strictEqual(r.code, 2, `${what}\n${r.out}`);
    assert.match(r.out, /no pude mirar/, what);
    assert.doesNotMatch(r.out, /Umbrellacorp/, `${what}: el mensaje no cita la lista privada`);
    resetLab(l.arnes);
  }
  // git que falla
  const bin = path.join(l.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "git de mentira" >&2\nexit 1\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  stage(l.arnes, name);
  const r = brake(l, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
});

// ── T15 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_PublicCopyLabAndProfile', () => {
  const l = lab();
  const mini = (name, { profile = false, script = false } = {}) => {
    const repo = path.join(l.dir, name);
    fs.mkdirSync(path.join(repo, '.githooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(repo, '.githooks', 'pre-commit'));
    if (profile) write(repo, { 'perfil-equipo.json': '{}\n' });
    if (script) {
      // el freno, el exportador y el detector, en su carpeta
      for (const f of ['publishing/new-names.js', 'publishing/export.js', 'publishing/detector.js']) {
        fs.mkdirSync(path.dirname(path.join(repo, 'scripts', f)), { recursive: true });
        fs.copyFileSync(path.join(RAIZ, 'scripts', f), path.join(repo, 'scripts', f));
      }
      fs.cpSync(path.join(RAIZ, 'scripts', 'lib'), path.join(repo, 'scripts', 'lib'), { recursive: true });
    }
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']); commit(repo, 'base');
    stage(repo, { 'guides/x.txt': 'Lo usa AcmeCorp.\n' });
    const r = spawnSync('bash', [path.join(repo, '.githooks', 'pre-commit')], {
      cwd: repo, encoding: 'utf8', env: cleanEnv({ TYCON_SKILLS_DIR: l.skills, HOME: l.home }),
    });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  let r = mini('copia-publica');
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /nombres/i, 'sin lista, sin perfil y sin el guion: no dice nada');
  r = mini('perfil-sin-lista', { profile: true, script: true });
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /no pude mirar/);
  r = mini('perfil-sin-guion', { profile: true });
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /no pude mirar/);
});

// ── T16 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_Disabled_SaysItEveryTime', () => {
  const l = lab();
  for (const n of [1, 2]) {
    stage(l.arnes, { [`guides/n${n}.md`]: `Lo usa AcmeCorp (${n}).\n` });
    const r = brake(l, { env: { TYCON_NEW_NAMES: '0' } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /apagado[\s\S]*no se miró si entran nombres/i, `commit ${n}`);
    commit(l.arnes, `commit ${n} con el freno apagado`);
  }
});

// ── T17 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_LogWithoutNames', () => {
  const l = lab();
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nLo usa AcmeCorp.\n' });
  assert.strictEqual(brake(l).code, 1);
  resetLab(l.arnes);
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nUna línea limpia.\n' });
  assert.strictEqual(brake(l).code, 0);
  resetLab(l.arnes);
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nLo usa AcmeCorp.\n' });
  assert.strictEqual(brake(l, { env: { TYCON_NEW_NAMES: '0' } }).code, 0);
  const dir = path.join(l.home, '.claude', '.tycon-pipeline');
  const own = fs.readFileSync(path.join(dir, 'new-names.jsonl'), 'utf8');
  const brakes = fs.readFileSync(path.join(dir, 'frenos.jsonl'), 'utf8');
  const ownLines = own.trim().split('\n').map((x) => JSON.parse(x));
  const brakeLines = brakes.trim().split('\n').map((x) => JSON.parse(x));
  assert.strictEqual(ownLines.length, 3, own);
  assert.strictEqual(brakeLines.length, 3, brakes);
  assert.deepStrictEqual(brakeLines.map((x) => x.veredicto), ['bloqueo', 'paso', 'escape']);
  assert.ok(brakeLines.every((x) => x.freno === 'new-names'));
  assert.deepStrictEqual(ownLines.map((x) => x.blocked), [true, false, false]);
  assert.strictEqual(ownLines[0].findings.cliente, 1, 'conteos por categoría');
  for (const x of ownLines) for (const k of ['ts', 'repo', 'files', 'findings', 'blocked', 'outcome', 'ms']) assert.ok(k in x, `${k} en ${JSON.stringify(x)}`);
  assert.ok(brakeLines.slice(0, 2).every((x) => /^[0-9a-f]{64}$/.test(x.sha256)), 'la huella, no el texto');
  assert.doesNotMatch(own + brakes, /AcmeCorp|Ceibo|guides\/x\.md/, 'ningún texto encontrado ni ruta');
});

// ── T18 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_NothingThatShips_DoesNotLoad', () => {
  const l = lab();
  stage(l.arnes, { 'scripts/publishing/denylist.json': '{ la lista rota' });
  commit(l.arnes, 'la lista queda rota (por otro camino)');
  stage(l.arnes, { 'specs/x.md': '# Story\n\nLo usa AcmeCorp.\n' });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `sólo specs/: no carga la lista\n${r.out}`);
  assert.strictEqual(r.out, '');
  resetLab(l.arnes);
  stage(l.arnes, { 'onboarding/x.md': '# Onboarding\n\nLo usa AcmeCorp.\n' });
  r = brake(l);
  assert.strictEqual(r.code, 0, `sólo lo que la lista blanca deja afuera: no carga la lista\n${r.out}`);
  assert.strictEqual(r.out, '');
  assert.ok(!fs.existsSync(path.join(l.home, '.claude', '.tycon-pipeline', 'new-names.jsonl')), 'y no deja registro: no tuvo nada que mirar');
  resetLab(l.arnes);
  stage(l.arnes, { 'scripts/ci/product-parity.json': { grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/y' }] } } });
  r = brake(l);
  assert.strictEqual(r.code, 2, `product-parity.json dispara: la lista rota es «no pude mirar»\n${r.out}`);
  assert.match(r.out, /no pude mirar/);
});

// ── T19 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_Range_SameVerdictAndEmpty', () => {
  const l = lab();
  const base = git(l.arnes, ['rev-parse', 'HEAD']);
  git(l.arnes, ['checkout', '-q', '-b', 'rama']);
  stage(l.arnes, { 'guides/x.md': '# Guía\n\nLo usa AcmeCorp.\n' });
  const c1 = commit(l.arnes, 'un nombre nuevo');
  stage(l.arnes, { 'guides/ya-nombra.md': '# Ya nombra\n\nEsto lo usa AcmeCorp hace años.\nOtra línea.\n' });
  const c2 = commit(l.arnes, 'un retoque');
  stage(l.arnes, { 'specs/y.md': '# Story\n\nLo usa Globex.\n' });
  const c3 = commit(l.arnes, 'un archivo que no sale');
  const r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/x\.md/);
  assert.doesNotMatch(r.out, /ya-nombra|specs\/y\.md/);
  const one = (c) => brake(l, { args: ['--range', `${c}^..${c}`] }).code;
  assert.deepStrictEqual([one(c1), one(c2), one(c3)], [1, 0, 0], 'commit a commit, el mismo veredicto');
  const e = brake(l, { args: ['--range', 'HEAD...HEAD'] });
  assert.strictEqual(e.code, 0, e.out);
  assert.match(e.out, /no medido: el rango no trae commits/);
});

// ── T20 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_CeilingRisesOnlyWithTheList', () => {
  const l = lab();
  const ceiling = clone(CEILING);
  ceiling.core.content = 12;
  stage(l.arnes, { 'scripts/publishing/names-ceiling.json': ceiling });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /core\.content/);
  assert.match(r.out, /10[\s\S]*12/);
  resetLab(l.arnes);
  const denied = clone(DENIED);
  denied.terminos.push({ patron: 'Hooli', categoria: 'cliente', palabra: true });
  const table = clone(TABLE);
  table.pares.push({ real: 'Hooli', categoria: 'cliente', palabra: true, formas: [{ texto: 'Hooli', anonimo: 'Halo' }] });
  stage(l.arnes, { 'scripts/publishing/names-ceiling.json': ceiling, 'scripts/publishing/denylist.json': denied, 'scripts/publishing/replacements.json': table });
  r = brake(l);
  assert.strictEqual(r.code, 0, `sube con un término nuevo en el mismo commit: pasa\n${r.out}`);
  resetLab(l.arnes);
  const sinCifra = clone(CEILING);
  delete sinCifra.core.glued;
  stage(l.arnes, { 'scripts/publishing/names-ceiling.json': sinCifra });
  r = brake(l);
  assert.strictEqual(r.code, 1, `una cifra que desaparece deja el techo sin límite: frena\n${r.out}`);
  assert.match(r.out, /core\.glued pasa de 1 a sin cifra/);
});

// ── T21 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_NewProductWithoutTerm_Blocks', () => {
  const l = lab();
  const parity = { grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/x' }, { producto: 'Wonka', ruta: 'Wonka/x' }] } };
  stage(l.arnes, { 'scripts/ci/product-parity.json': parity });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /Wonka/);
  assert.match(r.out, /denylist\.json/);
  assert.match(r.out, /replacements\.json/);
  resetLab(l.arnes);
  const denied = clone(DENIED);
  denied.terminos.push({ patron: 'Wonka', categoria: 'cliente', palabra: true });
  const table = clone(TABLE);
  table.pares.push({ real: 'Wonka', categoria: 'cliente', palabra: true, formas: [{ texto: 'Wonka', anonimo: 'Wren' }] });
  stage(l.arnes, { 'scripts/ci/product-parity.json': parity, 'scripts/publishing/denylist.json': denied, 'scripts/publishing/replacements.json': table });
  r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

// ── T49 ──────────────────────────────────────────────────────────────────────────────────────────────
test('NewNames_TermWithoutPairInIndex_Blocks', () => {
  const l = lab();
  const denied = clone(DENIED);
  denied.terminos.push({ patron: 'Zorblax', categoria: 'cliente', palabra: true });
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /terminos\[4\]/);
  assert.match(r.out, /cliente/);
  assert.doesNotMatch(r.out, /Zorblax/, 'por su posición y su categoría, nunca por su valor');
  const table = clone(TABLE);
  table.pares.push({ real: 'Zorblax', categoria: 'cliente', palabra: true, formas: [{ texto: 'Zorblax', anonimo: 'Zenit' }] });
  stage(l.arnes, { 'scripts/publishing/replacements.json': table });
  r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

// ── Casos de borde del pase adversarial: una prueba por defecto ───────────────
test('NewNames_Adversarial_VaciarEntryRemoved_Blocks', () => {
  // sacar de `empty` la entrada entera de un archivo publica la clave que se vaciaba: se mira
  const l = lab();
  stage(l.arnes, { 'scripts/config.json': '{\n  "maquina": "AcmeCorp-01",\n  "hora": "02:00"\n}\n' });
  commit(l.arnes, 'la máquina con nombre, vaciada');
  const list = clone(LIST);
  list.empty = {};
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/config\.json:2 [^\n]*AcmeCorp/);
});

test('NewNames_Adversarial_PathOfWhatStartsShipping_Blocks', () => {
  const l = lab();
  stage(l.arnes, { 'onboarding/acmecorp-notas.md': '# Notas\n' });
  commit(l.arnes, 'una ruta con nombre donde no se publica');
  // (a) la configuración empieza a publicarla: se mira también la ruta
  const list = clone(LIST);
  list.packages.core.arnes.in.push('onboarding/**');
  list.packages.core.arnes.out = list.packages.core.arnes.out.filter((x) => x.glob !== 'onboarding/**');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(ruta\)[^\n]*onboarding\/acmecorp-notas\.md/);
  resetLab(l.arnes);
  // (b) un git mv desde donde no se publica: la ruta vieja no descuenta
  git(l.arnes, ['mv', 'onboarding/acmecorp-notas.md', 'guides/acmecorp-notas.md']);
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(ruta\)[^\n]*guides\/acmecorp-notas\.md/);
});

test('NewNames_Adversarial_SyntheticFromANonShippedSource_Blocks', () => {
  // el destino de un sintético sale con el contenido de su `from`, aunque el `from` no salga en su propia ruta
  const l = lab();
  const list = clone(LIST);
  list.synthetic.push({ target: 'scripts/ci/otra.json', from: 'onboarding/otra.json', reason: 'prueba' });
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list, 'scripts/ci/otra.json': '{}\n', 'onboarding/otra.json': '{}\n' });
  commit(l.arnes, 'un sintético cuyo desde no sale');
  stage(l.arnes, { 'onboarding/otra.json': '{ "x": "AcmeCorp" }\n' });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/ci\/otra\.json:1 [^\n]*AcmeCorp/);
});

test('NewNames_Adversarial_SuiteEntryStartsShipping_Blocks', () => {
  // una entrada de suites.json sale cuando su suite sale: agregar la suite publica la entrada
  const l = lab();
  stage(l.arnes, {
    'scripts/tests/uno.test.js': "'use strict';\n",
    'scripts/tests/suites.json': { diarias: [{ raiz: 'arnes', ruta: 'tests/uno.test.js', requiere: [] }, { __nota: 'la de AcmeCorp', raiz: 'arnes', ruta: 'tests/nueva.test.js', requiere: [] }] },
  });
  commit(l.arnes, 'una entrada con nombre de una suite que todavía no existe');
  stage(l.arnes, { 'scripts/tests/nueva.test.js': "'use strict';\n" });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/tests\/suites\.json:\d+ [^\n]*AcmeCorp/);
});

// Una suite que la base deja fuera y que el cambio renombra sigue tapada con su nombre nuevo — es
// el mismo archivo. Sólo si el mapa de renombres lo declara y el archivo se mudó de verdad (sin esto, renombrar una
// prueba con datos que no salen frenaría el PR entero sin orden de commits que pasara).
function suiteHiddenThenRenamed({ withMap = true, mapOld = 'scripts/tests/before-lab.test.sh', mapText = null } = {}) {
  const l = lab();
  const list = clone(LIST);
  list.suitesOutside = [{ root: 'arnes', path: 'tests/before-lab.test.sh', reason: 'prueba: sus datos no salen' }];
  const suites = (ruta) => ({ diarias: [{ raiz: 'arnes', ruta, requiere: [] }] });
  stage(l.arnes, {
    'scripts/tests/before-lab.test.sh': '#!/usr/bin/env bash\necho "lo usa AcmeCorp"\n',
    'scripts/tests/suites.json': suites('tests/before-lab.test.sh'),
    'scripts/publishing/allowlist.json': list,
  });
  commit(l.arnes, 'una suite con datos que no salen, fuera desde antes');
  git(l.arnes, ['mv', 'scripts/tests/before-lab.test.sh', 'scripts/tests/after-lab.test.sh']);
  const after = clone(list);
  after.suitesOutside = [{ root: 'arnes', path: 'tests/after-lab.test.sh', reason: 'prueba: sus datos no salen' }];
  stage(l.arnes, {
    'scripts/tests/suites.json': suites('tests/after-lab.test.sh'),
    'scripts/publishing/allowlist.json': after,
    ...(withMap ? { 'scripts/lib/renames.json': mapText !== null ? mapText : { entries: [{ kind: 'file', old: mapOld, new: 'scripts/tests/after-lab.test.sh', batch: 'C2', callers: ['same-repo'] }] } } : {}),
  });
  return brake(l);
}

test('NewNames_HiddenSuiteRenamed_StaysHidden_Passes', () => {
  const r = suiteHiddenThenRenamed();
  assert.strictEqual(r.code, 0, r.out);
});

test('NewNames_HiddenSuiteRenamed_WithoutTheMap_Blocks', () => {
  // sin la entrada del mapa, la excepción con el nombre nuevo es una excepción de este mismo commit
  const r = suiteHiddenThenRenamed({ withMap: false });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/tests\/after-lab\.test\.sh:\d+[^\n]*AcmeCorp/);
});

test('NewNames_HiddenSuiteRenamed_BrokenMap_BlocksAndSaysWhy', () => {
  // un mapa que no se deja leer no tapa nada (el freno queda más estricto) y lo DICE: sin el aviso, quien renombra ve
  // «excepción nueva» sin pista de que la causa es el mapa
  const r = suiteHiddenThenRenamed({ mapText: '{ roto' });
  // frena: 1 (la excepción cuenta como nueva) o 2 (el exportador tampoco puede leer el mapa: «no pude mirar») — nunca 0
  assert.ok(r.code === 1 || r.code === 2, `un mapa roto nunca deja pasar (exit ${r.code})\n${r.out}`);
  assert.match(r.out, /renames\.json del después no es JSON válido/);
});

test('NewNames_HiddenSuiteRenamed_MapNamesAnotherFile_Blocks', () => {
  // un mapa que nombra un viejo que la base no tenía no tapa nada: la mudanza tiene que ser de verdad
  const r = suiteHiddenThenRenamed({ mapOld: 'scripts/tests/never-existed.test.sh' });
  assert.strictEqual(r.code, 1, r.out);
});

// Lo mismo con un caso del banco que la base deja fuera (`casesOutside`, rutas enteras
// del arnés, sin el prefijo `scripts/` de las suites).
function caseHiddenThenRenamed({ withMap = true, mapOld = 'scripts/controls-bench/cases/hooks/before-lab.json', mapText = null } = {}) {
  const l = lab();
  const list = clone(LIST);
  list.casesOutside = [{ path: 'scripts/controls-bench/cases/hooks/before-lab.json', reason: 'prueba: sus datos no salen' }];
  const caseDef = '{ "script": "lab-hook.js", "cases": [{ "id": "lab-1", "nota": "lo usa AcmeCorp" }] }\n';
  stage(l.arnes, {
    'scripts/controls-bench/cases/hooks/before-lab.json': caseDef,
    'scripts/publishing/allowlist.json': list,
  });
  commit(l.arnes, 'un caso del banco con datos que no salen, fuera desde antes');
  git(l.arnes, ['mv', 'scripts/controls-bench/cases/hooks/before-lab.json', 'scripts/controls-bench/cases/hooks/after-lab.json']);
  const after = clone(list);
  after.casesOutside = [{ path: 'scripts/controls-bench/cases/hooks/after-lab.json', reason: 'prueba: sus datos no salen' }];
  stage(l.arnes, {
    'scripts/publishing/allowlist.json': after,
    ...(withMap ? { 'scripts/lib/renames.json': mapText !== null ? mapText : { entries: [{ kind: 'file', old: mapOld, new: 'scripts/controls-bench/cases/hooks/after-lab.json', batch: 'C2', callers: ['same-repo'] }] } } : {}),
  });
  return brake(l);
}

test('NewNames_HiddenCaseRenamed_StaysHidden_Passes', () => {
  const r = caseHiddenThenRenamed();
  assert.strictEqual(r.code, 0, r.out);
});

test('NewNames_HiddenCaseRenamed_WithoutTheMap_Blocks', () => {
  // sin la entrada del mapa, la excepción con la ruta nueva es una excepción de este mismo commit
  const r = caseHiddenThenRenamed({ withMap: false });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /scripts\/controls-bench\/cases\/hooks\/after-lab\.json:\d+[^\n]*AcmeCorp/);
});

test('NewNames_HiddenCaseRenamed_BrokenMap_BlocksAndSaysWhy', () => {
  // un mapa que no se deja leer no tapa nada y lo dice
  const r = caseHiddenThenRenamed({ mapText: '{ roto' });
  assert.ok(r.code === 1 || r.code === 2, `un mapa roto nunca deja pasar (exit ${r.code})\n${r.out}`);
  assert.match(r.out, /renames\.json del después no es JSON válido/);
});

test('NewNames_HiddenCaseRenamed_MapNamesAnotherFile_Blocks', () => {
  // un mapa que nombra un viejo que la base no tenía no tapa nada: la mudanza tiene que ser de verdad
  const r = caseHiddenThenRenamed({ mapOld: 'scripts/controls-bench/cases/hooks/never-existed.json' });
  assert.strictEqual(r.code, 1, r.out);
});

// Una guía que el núcleo deja afuera y que el cambio muda de carpeta, con su
// `out` mudado en el mismo commit, sigue tapada con su ruta nueva — es el mismo archivo y la base ya lo tapaba. Sin esto,
// mudar una guía privada frenaría el commit y el PR (el rango compara contra la base) sin orden de commits que pasara.
function guideOutThenMoved({ withMap = true, outNew = 'guides/decisions/fuera.md', extra = {}, mapOld = 'guides/fuera.md' } = {}) {
  const l = lab();
  const guide = '# Guía\nlo usa AcmeCorp\n';
  stage(l.arnes, { 'guides/fuera.md': guide });
  commit(l.arnes, 'una guía con datos que no salen, afuera desde antes');
  git(l.arnes, ['rm', '-q', 'guides/fuera.md']);
  stage(l.arnes, { 'guides/decisions/fuera.md': guide });
  const after = clone(LIST);
  after.packages.core.arnes.out[0] = { glob: outNew, reason: 'prueba: queda afuera' };
  stage(l.arnes, {
    'scripts/publishing/allowlist.json': after,
    ...extra,
    ...(withMap ? { 'scripts/lib/renames.json': { entries: [{ kind: 'file', old: mapOld, new: 'guides/decisions/fuera.md', batch: 'R5', callers: ['same-repo'] }] } } : {}),
  });
  return brake(l);
}

test('NewNames_HiddenGuideMovedWithItsOut_StaysHidden_Passes', () => {
  const r = guideOutThenMoved();
  assert.strictEqual(r.code, 0, r.out);
});

test('NewNames_HiddenGuideMovedWithItsOut_WithoutTheMap_Blocks', () => {
  // sin la entrada del mapa, el `out` con la ruta nueva es una excepción de este mismo commit
  const r = guideOutThenMoved({ withMap: false });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/decisions\/fuera\.md:\d+[^\n]*AcmeCorp/);
});

test('NewNames_HiddenGuideMoved_MapNamesAnotherFile_Blocks', () => {
  // un mapa que nombra un viejo que la base no tenía no traslada nada: la mudanza tiene que ser de verdad. La ruta vieja
  // puede seguir existiendo después (el reemplazo .md que deja la mudanza), así que eso no se exige
  const r = guideOutThenMoved({ mapOld: 'guides/never-existed.md' });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/decisions\/fuera\.md:\d+[^\n]*AcmeCorp/);
});

test('NewNames_HiddenGuideMoved_OutWidenedToAnotherFile_Blocks', () => {
  // el traslado tapa sólo el archivo mudado: un `out` que de paso tapa otro archivo nuevo con el nombre es excepción nueva
  const r = guideOutThenMoved({ outNew: 'guides/decisions/*.md', extra: { 'guides/decisions/otra.md': '# Otra\nlo usa AcmeCorp\n' } });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/decisions\/otra\.md:\d+[^\n]*AcmeCorp/);
  assert.doesNotMatch(r.out, /guides\/decisions\/fuera\.md:\d+/);
});

// la misma clase con el afuera privado de la tabla: la guía mudada con su glob privado sigue tapada
function privateGuideThenMoved({ withMap = true, globNew = 'arnes/guides/decisions/privado.md', extra = {} } = {}) {
  const l = lab();
  const guide = '# Privado\nlo usa AcmeCorp\n';
  stage(l.arnes, { 'guides/privado.md': guide });
  commit(l.arnes, 'una guía privada, afuera desde antes');
  git(l.arnes, ['rm', '-q', 'guides/privado.md']);
  stage(l.arnes, {
    'guides/decisions/privado.md': guide,
    'scripts/publishing/replacements.json': { ...clone(TABLE), afuera: [{ glob: globNew, motivo: 'prueba: afuera privado' }] },
    ...extra,
    ...(withMap ? { 'scripts/lib/renames.json': { entries: [{ kind: 'file', old: 'guides/privado.md', new: 'guides/decisions/privado.md', batch: 'R5', callers: ['same-repo'] }] } } : {}),
  });
  return brake(l);
}

test('NewNames_PrivateAfueraGuideMovedWithItsGlob_StaysHidden_Passes', () => {
  const r = privateGuideThenMoved();
  assert.strictEqual(r.code, 0, r.out);
});

test('NewNames_PrivateAfueraGuideMoved_WithoutTheMap_Blocks', () => {
  const r = privateGuideThenMoved({ withMap: false });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/decisions\/privado\.md:\d+[^\n]*AcmeCorp/);
});

test('NewNames_PrivateAfueraGuideMoved_WidenedToAnotherFile_Blocks', () => {
  const r = privateGuideThenMoved({ globNew: 'arnes/guides/decisions/*.md', extra: { 'guides/decisions/otra.md': '# Otra\nlo usa AcmeCorp\n' } });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/decisions\/otra\.md:\d+[^\n]*AcmeCorp/);
  assert.doesNotMatch(r.out, /guides\/decisions\/privado\.md:\d+/);
});

test('NewNames_Adversarial_NewHidingInTheSameCommit_Blocks', () => {
  // una clave nueva en `empty` en el mismo commit que el nombre que tapa: la excepción va aparte
  const l = lab();
  const list = clone(LIST);
  list.empty = { 'scripts/config.json': ['maquina', 'hora'] };
  stage(l.arnes, { 'scripts/config.json': '{\n  "maquina": "",\n  "hora": "AcmeCorp"\n}\n', 'scripts/publishing/allowlist.json': list });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /la excepción va en un commit aparte, y la decide una persona/);
});

test('NewNames_Adversarial_PermitReordered_Passes', () => {
  // un permitido que ya estaba, con sus claves en otro orden y otro motivo, no es una excepción nueva
  const l = lab();
  const denied = clone(DENIED);
  denied.permitidos = [{ motivo: 'prueba: el mismo permiso, reescrito', patron: '^Initech$', archivo: 'guides/permitido.md' }];
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied, 'guides/permitido.md': '# Permitido\n\nInitech\n' });
  const r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

test('NewNames_Adversarial_MergeThatStartsPublishing_Blocks', () => {
  // un lado agrega un nombre donde no se publicaba; el otro le saca el afuera: el merge lo publica
  const l = lab();
  git(l.arnes, ['checkout', '-q', '-b', 'a']);
  stage(l.arnes, { 'guides/fuera.md': '# Fuera\n\nLo usa AcmeCorp.\nY Globex.\n' });
  commit(l.arnes, 'a: un nombre donde no se publica');
  git(l.arnes, ['checkout', '-q', 'main']);
  const list = clone(LIST);
  list.packages.core.arnes.out = list.packages.core.arnes.out.filter((x) => x.glob !== 'guides/fuera.md');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list });
  commit(l.arnes, 'main: fuera.md empieza a salir (por otro camino)');
  git(l.arnes, ['merge', '--no-commit', '--no-ff', 'a'], { tolerate: true });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/fuera\.md:4 [^\n]*Globex/);
  assert.doesNotMatch(r.out, /«AcmeCorp»/, 'lo que main ya publicaba no se nombra');
});

test('NewNames_Adversarial_TomlOutsideTheManifest_Blocks', () => {
  // sólo se regenera la traducción de un revisor del manifiesto: la que no está ahí sale tal cual, y se mira
  const l = lab();
  stage(l.arnes, { 'adapters/codex/agents/suelto.toml': 'name = "suelto"\n# para AcmeCorp\n' });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /adapters\/codex\/agents\/suelto\.toml:2/);
});

test('NewNames_Adversarial_AfueraGlobEdited_Passes', () => {
  // ensanchar un afuera que ya tapaba el archivo no es una excepción nueva
  const l = lab();
  const list = clone(LIST);
  list.packages.core.arnes.out = list.packages.core.arnes.out.map((x) => (x.glob === 'guides/fuera.md' ? { ...x, glob: 'guides/fuera*.md' } : x));
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list });
  const r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

test('NewNames_Adversarial_FixingABrokenList_Passes', () => {
  // con la lista blanca de HEAD rota, el commit que la arregla se puede crear
  const l = lab();
  stage(l.arnes, { 'scripts/publishing/allowlist.json': '{ rota' });
  commit(l.arnes, 'la lista blanca queda rota (por otro camino)');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': LIST });
  const r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no se pudo clasificar con su propia configuración[\s\S]*se usa la del después/, 'el atajo se dice, no se calla');
});

test('NewNames_Adversarial_SameTextInTwoPackages_CountsOnce', () => {
  // un archivo que sale en dos paquetes es una sola exposición: un hallazgo, no dos
  const l = lab();
  stage(l.arnes, { 'guides/bizuit/x.md': '# Bizuit\n\nLo usa AcmeCorp.\n' });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual((r.out.match(/«AcmeCorp»/g) || []).length, 1, r.out);
});

test('NewNames_Adversarial_TermRemovedWithItsMention_Blocks', () => {
  // sacar un término de la lista en el mismo commit que trae su mención también es una excepción: va aparte
  const l = lab();
  const denied = clone(DENIED);
  denied.terminos = denied.terminos.filter((t) => t.patron !== 'Globex');
  const table = clone(TABLE);
  table.pares = table.pares.filter((p) => p.real !== 'Globex');
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied, 'scripts/publishing/replacements.json': table, 'guides/x.md': '# Guía\n\nLo usa Globex.\n' });
  let r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /la excepción va en un commit aparte, y la decide una persona/);
  resetLab(l.arnes);
  // el término sacado solo, en su commit, pasa (las menciones que ya estaban no son nuevas)
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied, 'scripts/publishing/replacements.json': table });
  r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
});

// ── apagar la forma pegada en el mismo commit que la trae es una excepción ──────────────────────────────────────
// La identidad de un término tiene que traer `glued`: si no, poner `"glued": false` en el mismo commit que agrega el
// nombre pegado pasaría callado, a diferencia de sacar el término o cambiarle `palabra`/`mayusculas`.
test('8.10.2 T18 NewNames_GluedFalseInTheSameCommit_IsAnException — apagar la forma pegada en el mismo commit que la trae frena', () => {
  const mention = { 'guides/x.md': '# Guía\n\nstage: DeployZrbStaging\n' };
  const withZrb = (l) => {
    const denied = clone(DENIED);
    denied.terminos.push({ patron: 'ZRB', categoria: 'cliente', palabra: true, mayusculas: true });
    const table = clone(TABLE);
    table.pares.push({ real: 'ZRB', categoria: 'cliente', palabra: true, mayusculas: true, formas: [{ texto: 'ZRB', anonimo: 'QXV' }] });
    stage(l.arnes, { 'scripts/publishing/denylist.json': denied, 'scripts/publishing/replacements.json': table });
    commit(l.arnes, 'base: ZRB en la lista, con sus formas pegadas');
    return denied;
  };
  const withChange = (change) => {
    const l = lab();
    const denied = clone(withZrb(l));
    change(denied.terminos.find((t) => t.patron === 'ZRB'));
    stage(l.arnes, { 'scripts/publishing/denylist.json': denied, ...mention });
    return brake(l);
  };
  // el control: sólo el texto, frena
  const sola = lab();
  withZrb(sola);
  stage(sola.arnes, mention);
  let r = brake(sola);
  assert.strictEqual(r.code, 1, `control: el nombre pegado solo frena\n${r.out}`);
  // cambiar `mayusculas` en el mismo commit: frena
  r = withChange((t) => { t.mayusculas = false; });
  assert.strictEqual(r.code, 1, `cambiar mayusculas en el mismo commit\n${r.out}`);
  // apagar la forma pegada en el mismo commit: también es una excepción
  r = withChange((t) => { t.glued = false; });
  assert.strictEqual(r.code, 1, `glued:false en el mismo commit que la trae\n${r.out}`);
  assert.match(r.out, /la excepción va en un commit aparte, y la decide una persona/);
});

// ── una configuración de base rota no se reemplaza callada ─────────────
test('NewNames_BrokenBaseList_SaysExceptionsAreBlind', () => {
  // la lista blanca de HEAD rota (alguien salteó el freno): el commit que la arregla pasa, pero dice que las
  // excepciones que agrega no se pueden separar de las que ya estaban
  const l = lab();
  stage(l.arnes, { 'scripts/publishing/allowlist.json': '{ rota' });
  commit(l.arnes, 'la lista blanca queda rota (por otro camino)');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': LIST });
  const r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /allowlist\.json del antes no es JSON válido[\s\S]*no se distinguen de las que ya estaban/, r.out);
});

test('NewNames_BrokenBaseDenied_CeilingNotExcused', () => {
  // con denylist.json de HEAD rota no se sabe qué términos suma el commit: una suba del techo no se excusa
  const l = lab();
  stage(l.arnes, { 'scripts/publishing/denylist.json': '{ rota' });
  commit(l.arnes, 'la lista de denegación queda rota (por otro camino)');
  const ceiling = clone(CEILING);
  ceiling.core.content = 12;
  stage(l.arnes, { 'scripts/publishing/denylist.json': DENIED, 'scripts/publishing/names-ceiling.json': ceiling });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /core\.content/);
  assert.match(r.out, /denylist\.json del antes no es JSON válido[\s\S]*el techo no se excusa/, r.out);
  assert.doesNotMatch(r.out, /rota/, 'el contenido de la lista privada no se cita');
});

test('NewNames_BrokenBaseParity_AllProductsCountAndSaysSo', () => {
  // con la paridad de HEAD rota, todos los productos cuentan como nuevos (más estricto), y se dice
  const l = lab();
  stage(l.arnes, { 'scripts/ci/product-parity.json': '{ rota' });
  commit(l.arnes, 'la paridad queda rota (por otro camino)');
  stage(l.arnes, { 'scripts/ci/product-parity.json': { grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/x' }, { producto: 'Wonka', ruta: 'Wonka/x' }] } } });
  const r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /Wonka/);
  assert.match(r.out, /product-parity\.json del antes no es JSON válido[\s\S]*todos sus productos cuentan como nuevos/, r.out);
});

// ── el paquete del núcleo cambia de nombre en la lista blanca ───────────────────────────────────────────────
// En el commit del renombre la base nombra al núcleo con el nombre viejo y la punta con `core`: es el MISMO paquete. Si el
// freno los viera como dos, `core` no tendría los «out» de la base y guides/fuera.md (que nombra a AcmeCorp) «empezaría
// a salir». El viejo sale del mapa de renombres, nunca escrito acá; sin mapa (la copia pública) no hay nombre viejo.
const OLD_CORE = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const e = m.entries.find((x) => x && x.kind === 'value' && x.new === 'core' && x.where === 'scripts/publishing/export.js');
    return e ? e.old : null;
  } catch (_) {
    return null;
  }
})();
const renamedCore = (to) => {
  const list = clone(LIST);
  const packages = {};
  for (const [k, v] of Object.entries(list.packages)) packages[k === 'core' ? to : k] = v;
  return { ...list, packages };
};

test('NewNames_CorePackageRenamed_SamePackageNotNewShipping', { skip: OLD_CORE ? false : 'sin el mapa de renombres no hay nombre viejo' }, () => {
  const l = lab();
  stage(l.arnes, { 'scripts/publishing/allowlist.json': renamedCore(OLD_CORE) });
  commit(l.arnes, 'la lista blanca de antes del renombre');
  const base = git(l.arnes, ['rev-parse', 'HEAD']);
  // lo stageado: la punta vuelve a `core`
  stage(l.arnes, { 'scripts/publishing/allowlist.json': LIST });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `el renombre del paquete no es «empezar a salir»\n${r.out}`);
  assert.doesNotMatch(r.out, /guides\/fuera\.md/);
  // lo mismo por --range, como lo mira el pull request
  commit(l.arnes, 'el paquete se llama core');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 0, r.out);
  // control: un nombre que el mapa NO declara sí es otro paquete, y lo que tapaba la base empieza a salir
  const b2 = git(l.arnes, ['rev-parse', 'HEAD']);
  stage(l.arnes, { 'scripts/publishing/allowlist.json': renamedCore('otro') });
  commit(l.arnes, 'un paquete nuevo, sin el afuera de antes');
  r = brake(l, { args: ['--range', `${b2}...HEAD`] });
  assert.strictEqual(r.code, 1, `el control tiene que frenar: si no, la prueba de arriba no prueba nada\n${r.out}`);
  assert.match(r.out, /guides\/fuera\.md/);
});

// ── el exportador se muda antes que su carpeta ────────────────────────────────────────────
// En el commit de la mudanza, la foto anterior trae el exportador en su ruta vieja, con sus `require` relativos a ella (el
// detector, al lado suyo). Compilado en la ruta nueva no carga, y el commit de la mudanza —y todo --range que lo cruce—
// saldría «no pude mirar». La ruta vieja sale del mapa, nunca escrita acá; sin mapa (la copia pública) no hay mudanza.
const OLD_EXPORTER = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const e = m.entries.find((x) => x && x.kind === 'file' && x.new === 'scripts/publishing/export.js');
    return e ? e.old : null;
  } catch (_) {
    return null;
  }
})();

test('NewNames_ExporterMoved_BeforeSnapshotLoadsFromItsOldPath', { skip: OLD_EXPORTER ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const l = lab();
  const own = fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'export.js'), 'utf8');
  // el exportador previo a la mudanza: el detector y el freno de castellano, en su misma carpeta. El
  // actual también los pide al lado suyo (los tres viven en scripts/publishing/), así que es el mismo texto
  const before = own;
  assert.match(own, /require\('\.\/detector\.js'\)/, 'la prueba necesita los require relativos del exportador');
  stage(l.arnes, { [OLD_EXPORTER]: before });
  commit(l.arnes, 'el exportador en su ruta vieja');
  const base = git(l.arnes, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(l.arnes, 'scripts', 'publishing'), { recursive: true });
  git(l.arnes, ['mv', OLD_EXPORTER, 'scripts/publishing/export.js']);
  stage(l.arnes, { 'scripts/publishing/export.js': own });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `la foto de antes se clasifica con su exportador, cargado desde su ruta vieja\n${r.out}`);
  // compilado en la ruta nueva no carga y el freno cae, avisando, a la configuración del después: pasa igual, pero a ciegas
  // (el aviso que no tiene que salir: «no se pudo clasificar con su propia configuración (el exportador de esa foto no carga…»)
  assert.doesNotMatch(r.out, /no se pudo clasificar con su propia configuración|no pude mirar/, r.out);
  // lo mismo por --range, como lo mira el pull request
  commit(l.arnes, 'el exportador en su carpeta nueva');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /no se pudo clasificar con su propia configuración|no pude mirar/, r.out);
});

// ── la configuración se muda, y la lista, la tabla y la de denegación cambian de nombre ──────────────────────────
// En el pull request de la mudanza (y en su pre-commit, contra HEAD) la base tiene la configuración en su ruta vieja. El
// freno lee primero la nueva y, si en esa foto no está, la vieja que dice el mapa: la entrada `file` del archivo, o la
// `folder` de su carpeta. Sin eso, los permisos de la base cuentan como nuevos (frena sin salida) y el techo de la base
// no se ve (sube callado). Las rutas viejas salen del mapa real, nunca escritas acá; sin mapa (la copia pública), no hay
// mudanza que probar.
const CONFIG_FILES = ['allowlist.json', 'denylist.json', 'replacements.json', 'names-ceiling.json'].map((f) => `scripts/publishing/${f}`);
const OLD_CONFIG = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const out = {};
    for (const nu of CONFIG_FILES) {
      const file = m.entries.find((x) => x && x.kind === 'file' && x.new === nu && typeof x.old === 'string');
      const folder = m.entries.filter((x) => x && x.kind === 'folder' && typeof x.new === 'string' && typeof x.old === 'string' && nu.startsWith(`${x.new}/`))
        .sort((a, b) => b.new.length - a.new.length)[0];
      const old = file ? file.old : folder ? `${folder.old}/${nu.slice(folder.new.length + 1)}` : null;
      if (!old || old === nu) return null;
      out[nu] = old;
    }
    return out;
  } catch (_) {
    return null;
  }
})();
const configToOldFolder = (l) => {
  for (const [nu, old] of Object.entries(OLD_CONFIG)) {
    fs.mkdirSync(path.dirname(path.join(l.arnes, old)), { recursive: true });
    git(l.arnes, ['mv', nu, old]);
  }
  return commit(l.arnes, 'la configuración, todavía en su carpeta vieja');
};
const configToNewFolder = (l) => { for (const [nu, old] of Object.entries(OLD_CONFIG)) git(l.arnes, ['mv', old, nu]); };
const PERMITTED = { 'guides/permitido.md': '# Permitido\n\nInitech\n' };   // lo que tapa el permiso que ya estaba en la base

test('NewNames_BaseConfigUnderOldFolder_ReadsItViaTheMap', { skip: OLD_CONFIG ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const l = lab();
  const base = configToOldFolder(l);
  // la mudanza con un nombre que la base ya permitía: el permiso es de la base, leída por su ruta vieja
  configToNewFolder(l);
  stage(l.arnes, PERMITTED);
  let r = brake(l);
  assert.strictEqual(r.code, 0, `el permiso de la base no es una excepción nueva\n${r.out}`);
  commit(l.arnes, 'la mudanza');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 0, `lo mismo por --range, como lo mira el pull request\n${r.out}`);
  // y el techo de la base, también por su ruta vieja: subirlo en la mudanza sin un término nuevo frena
  git(l.arnes, ['reset', '-q', '--hard', base]);
  configToNewFolder(l);
  const ceiling = clone(CEILING);
  ceiling.core.content = 11;
  stage(l.arnes, { 'scripts/publishing/names-ceiling.json': ceiling });
  r = brake(l);
  assert.strictEqual(r.code, 1, `el techo de la base se lee por su ruta vieja: subirlo frena\n${r.out}`);
  assert.match(r.out, /core\.content[\s\S]*10[\s\S]*11/);
  commit(l.arnes, 'la mudanza con el techo más alto');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /core\.content/);
});

// Un rango cuya PUNTA es anterior a la mudanza (repetir un rango histórico con el código actual) tiene la
// configuración en la carpeta vieja; lo tocado se reconoce por las dos rutas, si no el techo que sube pasa.
test('NewNames_TipConfigUnderOldFolder_StillSeesTheCeiling', { skip: OLD_CONFIG ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const l = lab();
  const base = configToOldFolder(l);
  const ceiling = clone(CEILING);
  ceiling.core.content = 11;
  stage(l.arnes, { [OLD_CONFIG['scripts/publishing/names-ceiling.json']]: ceiling });
  commit(l.arnes, 'el techo más alto, todavía en la carpeta vieja');
  const r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, `subir el techo en la carpeta vieja frena igual\n${r.out}`);
  assert.match(r.out, /core\.content[\s\S]*10[\s\S]*11/);
});

test('NewNames_BaseConfigUnderNewFolder_ReadsTheNewOne',{ skip: OLD_CONFIG ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const l = lab();
  // una copia vieja y distinta que quedó en la base al lado de la nueva: manda la nueva (la vieja, sólo si la nueva falta)
  const staleDenied = { ...clone(DENIED), permitidos: [] };
  const staleCeiling = clone(CEILING);
  staleCeiling.core.content = 99;
  stage(l.arnes, { [OLD_CONFIG['scripts/publishing/denylist.json']]: staleDenied, [OLD_CONFIG['scripts/publishing/names-ceiling.json']]: staleCeiling });
  const base = commit(l.arnes, 'copias viejas al lado de la configuración');
  stage(l.arnes, PERMITTED);
  let r = brake(l);
  assert.strictEqual(r.code, 0, `el permiso está en la lista nueva de la base\n${r.out}`);
  resetLab(l.arnes);
  const ceiling = clone(CEILING);
  ceiling.core.content = 11;
  stage(l.arnes, { 'scripts/publishing/names-ceiling.json': ceiling });
  r = brake(l);
  assert.strictEqual(r.code, 1, `el techo de la base es el de la ruta nueva (10), no el de la copia vieja\n${r.out}`);
  assert.match(r.out, /core\.content[\s\S]*10[\s\S]*11/);
  commit(l.arnes, 'el techo más alto');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, r.out);
});

// ── las claves de la lista blanca y el registro de productos, en inglés ─────────────────────────────────────────
// La base de un rango (o el HEAD del commit que las muda) trae la lista con las claves viejas y el registro de productos
// por su nombre viejo. El freno lee las dos fotos con las claves actuales (`readKeysDeep`) y el registro por los dos
// nombres; una lista con una clave vieja y su nueva con valores distintos es «no pude mirar». Las claves y la ruta viejas
// salen del mapa real en tiempo de ejecución, nunca escritas acá; sin mapa (la copia pública) no hay nada que probar.
const D1_MAP = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const keys = new Map(m.entries.filter((x) => x && x.kind === 'key' && x.where === 'scripts/publishing/allowlist.json').map((x) => [x.new, x.old]));
    const parity = m.entries.find((x) => x && x.kind === 'file' && x.new === 'scripts/ci/product-parity.json');
    return keys.size && parity ? { keys, parityOld: parity.old } : null;
  } catch (_) {
    return null;
  }
})();
/** La lista con las claves viejas (del mapa). */
const withOldKeys = (v) => {
  if (Array.isArray(v)) return v.map(withOldKeys);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [D1_MAP.keys.get(k) || k, withOldKeys(x)]));
};

test('BatchD1_BaseListWithOldKeys_SameListNotNewShipping', { skip: D1_MAP ? false : 'sin el mapa de renombres no hay claves viejas' }, () => {
  const l = lab();
  const old = withOldKeys(LIST);
  assert.ok(!('packages' in old) && Object.keys(old).length === Object.keys(LIST).length, 'la lista de laboratorio, con las claves viejas');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': old });
  const base = commit(l.arnes, 'la lista blanca con las claves de antes de la D1');
  // lo stageado: la misma lista con las claves nuevas. Si la base no se leyera con las nuevas, sus «out» no taparían
  // nada y guides/fuera.md (que nombra a AcmeCorp) «empezaría a salir» por una excepción de este commit
  stage(l.arnes, { 'scripts/publishing/allowlist.json': LIST });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `renombrar las claves no es «empezar a salir»\n${r.out}`);
  assert.doesNotMatch(r.out, /guides\/fuera\.md|no se pudo clasificar|no pude mirar/, r.out);
  // lo mismo por --range, como lo mira el pull request
  commit(l.arnes, 'las claves en inglés');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /guides\/fuera\.md|no se pudo clasificar|no pude mirar/, r.out);
  // control: el mismo rango frena si la punta además saca un «out» (la prueba de arriba no pasa por no mirar)
  const tip = clone(LIST);
  tip.packages.core.arnes.out = tip.packages.core.arnes.out.filter((x) => x.glob !== 'guides/fuera.md');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': tip });
  commit(l.arnes, 'la punta deja salir guides/fuera.md');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/fuera\.md/);
});

// En el commit del cambio de nombres (y en su pull request) la base trae además SU exportador, que lee las claves de su época: el freno
// se la devuelve con esas claves. El exportador de laboratorio de la base es el actual detrás de una puerta que exige las
// claves viejas (como un exportador anterior al cambio de nombres): si le llegaran las nuevas, el antes caería callado a la configuración del
// después («no se pudo clasificar con su propia configuración»).
test('BatchD1_BaseExporterReadsOldKeys_GetsThemBack', { skip: D1_MAP ? false : 'sin el mapa de renombres no hay claves viejas' }, () => {
  const l = lab();
  const real = path.join(RAIZ, 'scripts', 'publishing', 'export.js');
  const legacy = path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js');
  const oldExporter = [
    "'use strict';",
    `const real = require(${JSON.stringify(real)});`,
    `const ln = require(${JSON.stringify(legacy)});`,
    "const W = 'scripts/publishing/allowlist.json';",
    'const OLDS = new Set(ln.usableEntries(ln.loadMap()).filter((e) => e.kind === \'key\' && e.where === W).map((e) => e.old));',
    'const gate = (l) => {',
    "  if (!l || 'packages' in l || !Object.keys(l).some((k) => OLDS.has(k))) throw new Error('el exportador de laboratorio lee las claves de antes de la D1');",
    '  return ln.readKeysDeep(l, W);',
    '};',
    'const conv = (ctx) => ({ ...ctx, lista: gate(ctx.lista) });',
    'module.exports = { ...real, validarLista: (l, r) => real.validarLista(gate(l), r), whatShips: (ctx) => real.whatShips(conv(ctx)), primerNivel: (ctx, f) => real.primerNivel(conv(ctx), f) };',
    '',
  ].join('\n');
  stage(l.arnes, { 'scripts/publishing/export.js': oldExporter, 'scripts/publishing/allowlist.json': withOldKeys(LIST) });
  const base = commit(l.arnes, 'la base: su exportador y su lista, con las claves de antes de la D1');
  // el después: sin exportador propio (usa el actual) y la lista con las claves nuevas
  stage(l.arnes, { 'scripts/publishing/export.js': null, 'scripts/publishing/allowlist.json': LIST });
  let r = brake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /no se pudo clasificar con su propia configuración|no pude mirar/, r.out);
  commit(l.arnes, 'las claves en inglés');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /no se pudo clasificar con su propia configuración|no pude mirar/, r.out);
  // control: la puerta de verdad cierra con las claves nuevas (si no, la prueba no prueba nada): la punta con ese
  // exportador y la lista nueva no se deja clasificar
  stage(l.arnes, { 'scripts/publishing/export.js': oldExporter });
  commit(l.arnes, 'el exportador viejo con la lista nueva');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /claves de antes de la D1/, r.out);
});

// Un archivo de `empty` que el commit renombra sigue
// vaciándose con su nombre nuevo, pero las claves del después valen sólo si cada una es una de la base o su nombre nuevo
// según el mapa. Cambiar la clave vaciada por otra de la misma cantidad es una excepción de este commit, como sin renombre.
function emptyRenamed(afterKeys) {
  const l = lab();
  git(l.arnes, ['mv', 'scripts/config.json', 'scripts/configuration.json']);
  const list = clone(LIST);
  list.empty = { 'scripts/configuration.json': afterKeys };
  stage(l.arnes, {
    'scripts/configuration.json': '{\n  "maquina": "",\n  "hora": "AcmeCorp"\n}\n',
    'scripts/publishing/allowlist.json': list,
    'scripts/lib/renames.json': { entries: [{ kind: 'file', old: 'scripts/config.json', new: 'scripts/configuration.json', batch: 'lab', callers: ['same-repo'] }] },
  });
  return brake(l);
}
test('BatchD1 false-negative-classification-1 — renombrar un archivo de empty y cambiar la clave vaciada es una excepción', () => {
  const exception = /la excepción va en un commit aparte, y la decide una persona/;
  // la sonda: el mismo tamaño, otra clave
  let r = emptyRenamed(['hora']);
  assert.strictEqual(r.code, 1, `cambiar la clave vaciada al renombrar el archivo frena\n${r.out}`);
  assert.match(r.out, exception);
  assert.match(r.out, /scripts\/configuration\.json:3[^\n]*AcmeCorp/);
  // control: una clave de más también
  r = emptyRenamed(['maquina', 'hora']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, exception);
  // control: sin renombre, lo mismo
  const l = lab();
  const list = clone(LIST);
  list.empty = { 'scripts/config.json': ['hora'] };
  stage(l.arnes, { 'scripts/config.json': '{\n  "maquina": "",\n  "hora": "AcmeCorp"\n}\n', 'scripts/publishing/allowlist.json': list });
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, exception);
});

// La otra cara: un archivo de empty que se muda Y renombra su clave vaciada según el mapa (el examen lo hace)
// sigue tapado. El archivo y la clave salen del mapa real en tiempo de ejecución (por la clave: escrito acá, el nombre del
// archivo haría que las claves del laboratorio de esta prueba contaran como suyas en --stale-mentions).
const EXAM = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const key = m.entries.find((x) => x && x.kind === 'key' && x.new === 'designated_machine' && typeof x.where === 'string');
    const file = key && m.entries.find((x) => x && x.kind === 'file' && x.new === key.where);
    return file && key ? { oldPath: file.old, newPath: file.new, oldKey: key.old, newKey: key.new } : null;
  } catch (_) {
    return null;
  }
})();
test('BatchD1_EmptyFileAndKeyRenamedByMap_StaysHidden', { skip: EXAM ? false : 'sin el mapa de renombres no hay clave vieja' }, () => {
  const l = lab();
  // la base vacía dos claves: la de la máquina (con su nombre viejo, que el mapa renombra) y «otra»
  const base = clone(LIST);
  base.empty = { ...base.empty, [EXAM.oldPath]: [EXAM.oldKey, 'otra'] };
  stage(l.arnes, { [EXAM.oldPath]: { [EXAM.oldKey]: 'AcmeCorp-01', otra: '', tercera: '' }, 'scripts/publishing/allowlist.json': base });
  commit(l.arnes, 'la máquina del examen, vaciada, con su nombre y su clave de antes');
  const mapEntry = { kind: 'file', old: EXAM.oldPath, new: EXAM.newPath, batch: 'lab', callers: ['same-repo'] };
  const moveTo = (keys, content) => {
    git(l.arnes, ['mv', EXAM.oldPath, EXAM.newPath]);
    const after = clone(LIST);
    after.empty = { ...after.empty, [EXAM.newPath]: keys };
    stage(l.arnes, { [EXAM.newPath]: content, 'scripts/publishing/allowlist.json': after, 'scripts/lib/renames.json': { entries: [mapEntry] } });
    const r = brake(l);
    resetLab(l.arnes);
    return r;
  };
  const exception = /la excepción va en un commit aparte, y la decide una persona/;
  // el renombre de verdad: la clave de la máquina con su nombre nuevo (del mapa) y «otra», que no cambia
  let r = moveTo([EXAM.newKey, 'otra'], { [EXAM.newKey]: 'AcmeCorp-01', otra: '', tercera: '' });
  assert.strictEqual(r.code, 0, `la clave vaciada con su nombre nuevo (del mapa) es la misma: no es una excepción\n${r.out}`);
  // MENOS claves que la base, pero una que no es renombre de ninguna (comparar tamaños la dejaría pasar): excepción
  const hidden = { [EXAM.newKey]: '', otra: '', tercera: 'AcmeCorp-02' };
  r = moveTo(['tercera'], hidden);
  assert.strictEqual(r.code, 1, `vaciar en el mismo commit una clave que no es renombre frena\n${r.out}`);
  assert.match(r.out, exception);
  // el mismo tamaño, cambiando una clave por otra que el mapa no declara: también
  r = moveTo(['otra', 'tercera'], hidden);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, exception);
});

test('BatchD1_BaseListWithBothKeysDistinct_Exit2', { skip: D1_MAP ? false : 'sin el mapa de renombres no hay claves viejas' }, () => {
  const l = lab();
  // una entrada de «out» con su motivo por los dos nombres, distintos: el freno no elige uno
  const both = clone(LIST);
  both.packages.core.arnes.out[0][D1_MAP.keys.get('reason')] = 'otro motivo, con la clave vieja';
  stage(l.arnes, { 'scripts/publishing/allowlist.json': both });
  const base = commit(l.arnes, 'la lista con una clave vieja y su nueva, distintas (por otro camino)');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': LIST });
  let r = brake(l);
  assert.strictEqual(r.code, 2, `dos valores para la misma clave es «no pude mirar»\n${r.out}`);
  assert.match(r.out, new RegExp(`«reason»[^\\n]*«${D1_MAP.keys.get('reason')}»`), 'nombra las dos claves');
  commit(l.arnes, 'la lista sana');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 2, r.out);
  // con los dos valores iguales queda la nueva, y pasa
  const same = clone(LIST);
  same.packages.core.arnes.out[0][D1_MAP.keys.get('reason')] = same.packages.core.arnes.out[0].reason;
  stage(l.arnes, { 'scripts/publishing/allowlist.json': same });
  const b2 = commit(l.arnes, 'la clave vieja con el mismo valor');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': LIST });
  commit(l.arnes, 'sin la clave vieja');
  r = brake(l, { args: ['--range', `${b2}...HEAD`] });
  assert.strictEqual(r.code, 0, r.out);
});

test('BatchD1_BaseParityUnderOldName_ReadsItViaTheMap', { skip: D1_MAP ? false : 'sin el mapa de renombres no hay ruta vieja' }, () => {
  const l = lab();
  // la base tiene el registro por su nombre viejo, con un producto que la lista no ve (entró por otro camino)
  const parity = { grupos: { g: [{ producto: 'AcmeCorp', ruta: 'AcmeCorp/x' }, { producto: 'Wonka', ruta: 'Wonka/x' }] } };
  git(l.arnes, ['mv', 'scripts/ci/product-parity.json', D1_MAP.parityOld]);
  stage(l.arnes, { [D1_MAP.parityOld]: parity });
  const base = commit(l.arnes, 'el registro por su nombre viejo, con un producto sin término');
  // la mudanza: el mismo registro con el nombre nuevo no trae productos nuevos
  git(l.arnes, ['mv', D1_MAP.parityOld, 'scripts/ci/product-parity.json']);
  let r = brake(l);
  assert.strictEqual(r.code, 0, `el producto ya estaba en la base, leída por su nombre viejo\n${r.out}`);
  commit(l.arnes, 'la mudanza del registro');
  r = brake(l, { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(r.code, 0, r.out);
  // control: un producto nuevo en la mudanza sí frena
  stage(l.arnes, { 'scripts/ci/product-parity.json': { grupos: { g: [...parity.grupos.g, { producto: 'Zorgon', ruta: 'Zorgon/x' }] } } });
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /product-parity\.json: el producto «Zorgon»/);
  assert.doesNotMatch(r.out, /«Wonka»/, 'el que ya estaba en la base no se reclama');
});

// ── T19 — el commit que estrena `inbox/` (el buzón de decisiones del equipo) no frena ──
// La carpeta nueva de primer nivel la clasifica la exclusión fija `inbox/**` del exportador en el mismo commit: el freno
// no la ve «sin clasificar», ni cuando el commit la crea ni cuando le mueve entera la carpeta de los instintos con
// `git mv`. El nombre viejo de esa carpeta sale del mapa de renombres, nunca escrito acá (esta prueba también sale en
// la copia); sin mapa —la copia pública— la mudanza no se prueba.
const INBOX_OLD = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'lib', 'renames.json'), 'utf8'));
    const e = m.entries.find((x) => x && x.kind === 'folder' && x.new === 'inbox/instincts');
    return e ? e.old : null;
  } catch (_) {
    return null;
  }
})();

test('T19 R2_Inbox_ExporterGlobAndFirstLevel — el commit que estrena inbox/ no frena', () => {
  const l = lab();
  stage(l.arnes, {
    'inbox/instincts/README.md': '# Instintos\n\nLo que el observador propone y el equipo decide.\n',
    'inbox/instincts/pending/instinto-1.json': '{ "id": "instinto-1" }\n',
  });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `inbox/ está clasificada por la exclusión fija\n${r.out}`);
  assert.strictEqual(r.out, '', 'y no dice nada');

  // control: el mismo commit en una carpeta de primer nivel que nadie clasifica sí frena (la prueba mira de verdad)
  resetLab(l.arnes);
  stage(l.arnes, { 'buzon-sin-clasificar/x.md': '# Nada\n' });
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /buzon-sin-clasificar/);
});

test('T19 R2_Inbox_ExporterGlobAndFirstLevel — la mudanza con git mv a inbox/instincts/ no frena', { skip: INBOX_OLD ? false : 'NO MEDIDO — copia pública sin el mapa' }, () => {
  const l = lab();
  write(l.arnes, { [`${INBOX_OLD}/README.md`]: '# Instintos\n', [`${INBOX_OLD}/archived/instinto-0.json`]: '{ "id": "instinto-0" }\n' });
  git(l.arnes, ['add', '-A']); commit(l.arnes, 'la carpeta de antes');
  fs.mkdirSync(path.join(l.arnes, 'inbox'), { recursive: true });
  git(l.arnes, ['mv', INBOX_OLD, 'inbox/instincts']);
  const r = brake(l);
  assert.strictEqual(r.code, 0, `el git mv a inbox/ no frena\n${r.out}`);
  assert.strictEqual(r.out, '');
});

// ── el repo unido: una fuente física y dos lógicas, partidas por ruta ───────────────────────────────────────────
// El arnés y agent-skills son UN repo y su pre-commit corre las dos partes sobre la misma raíz: el freno con
// `--source arnes` y con `--source agent-skills`. Cada corrida mira sólo lo de SU fuente lógica (agent-skills es
// agents/, skills/, packs/, .tycon/post-commit-ignore y .githooks/pre-commit-skills; el arnés, todo lo demás), sin
// leer «el otro repo».
// 🔴 Sin esa partición, agregar `guides/x.md` saldría 1 por la parte de skills
//    («guides/ sin clasificar: el commit le agrega archivos»), y un archivo nuevo en `skills/`, 1 por la parte del
//    arnés: ningún commit que agregara un archivo se podría crear.
/** El laboratorio con la forma del repo unido: agent-skills adentro del arnés, en su misma raíz. */
function unifiedLab() {
  const l = lab();
  for (const top of ['agents', 'packs', 'skills']) fs.cpSync(path.join(l.skills, top), path.join(l.arnes, top), { recursive: true });
  write(l.arnes, {
    'skills/tycon-pipeline/SKILL.md': '# Pipeline\n',
    '.tycon/post-commit-ignore': 'skills/x-*\n',
    '.githooks/pre-commit-skills': '#!/usr/bin/env bash\nexit 0\n',
  });
  git(l.arnes, ['add', '-A']); commit(l.arnes, 'la unión: agent-skills adentro del arnés');
  return l;
}
/** Una parte del pre-commit del repo unido: el freno parado en esa raíz, que es el arnés y es agent-skills. */
const unifiedBrake = (l, source, { args = [], env = {} } = {}) => brake(l, {
  args: ['--source', source, ...args], env: { TYCON_GUIDES_DIR: l.arnes, TYCON_SKILLS_DIR: l.arnes, ...env },
});

test('Unified_AddInHarnessArea_SkillsPartDoesNotSeeIt — un archivo nuevo del arnés lo mira la parte del arnés, y la de skills calla', () => {
  const l = unifiedLab();
  stage(l.arnes, { 'guides/nuevo.md': '# Nuevo\n\nUna línea limpia.\n', 'onboarding/nuevo.md': '# Nuevo\n' });
  let h = unifiedBrake(l, 'arnes');
  let s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(h.code, 0, `la parte del arnés: ${h.out}`);
  assert.strictEqual(s.code, 0, `la parte de skills no frena lo que no es suyo: ${s.out}`);
  assert.doesNotMatch(s.out, /sin clasificar/);
  resetLab(l.arnes);
  // con un nombre real: frena la parte del arnés, con su archivo; la de skills sigue callada
  stage(l.arnes, { 'guides/con-nombre.md': '# Guía\n\nLo usa AcmeCorp.\n' });
  h = unifiedBrake(l, 'arnes');
  s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(h.code, 1, h.out);
  assert.match(h.out, /guides\/con-nombre\.md:3/);
  assert.strictEqual(s.code, 0, s.out);
  resetLab(l.arnes);
  // una carpeta de primer nivel que el commit estrena es del arnés: la frena esa parte, no la otra
  stage(l.arnes, { 'carpeta-nueva/x.md': '# Nada que ver\n' });
  h = unifiedBrake(l, 'arnes');
  s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(h.code, 1, h.out);
  assert.match(h.out, /carpeta-nueva/);
  assert.strictEqual(s.code, 0, s.out);
});

test('Unified_AddInSkillsArea_HarnessPartDoesNotSeeIt — un archivo nuevo de skills/ lo mira la parte de skills, con sus reglas', () => {
  const l = unifiedLab();
  stage(l.arnes, { 'skills/tycon-x/limpio.md': '# Limpio\n' });
  let h = unifiedBrake(l, 'arnes');
  let s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(h.code, 0, `la parte del arnés no frena lo que no es suyo: ${h.out}`);
  assert.doesNotMatch(h.out, /sin clasificar/);
  assert.strictEqual(s.code, 0, s.out);
  resetLab(l.arnes);
  stage(l.arnes, { 'skills/tycon-x/con-nombre.md': '# Skill\n\nLo usa AcmeCorp.\n' });
  h = unifiedBrake(l, 'arnes');
  s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /skills\/tycon-x\/con-nombre\.md:3/);
  assert.strictEqual(h.code, 0, h.out);
  resetLab(l.arnes);
  // lo que la lista blanca deja afuera de agent-skills sigue afuera: un paquete con un nombre no frena
  stage(l.arnes, { 'packs/clients/notas.md': 'Lo usa AcmeCorp.\n' });
  s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(s.code, 0, s.out);
});

test('Unified_NeverReadsTheOtherRepo_RangeToo — sin «el otro repo» a mano mira igual, y por rango da el mismo veredicto', () => {
  const l = unifiedLab();
  const empty = fs.mkdtempSync(path.join(l.dir, 'vacia-'));
  const nowhere = { TYCON_GUIDES_DIR: empty, TYCON_SKILLS_DIR: empty };
  stage(l.arnes, { 'guides/con-nombre.md': '# Guía\n\nLo usa AcmeCorp.\n', 'skills/tycon-x/con-nombre.md': '# Skill\n\nLo usa Globex.\n' });
  const h = unifiedBrake(l, 'arnes', { env: nowhere });
  const s = unifiedBrake(l, 'agent-skills', { env: nowhere });
  assert.strictEqual(h.code, 1, `la parte del arnés miró sin el otro repo: ${h.out}`);
  assert.strictEqual(s.code, 1, `la parte de skills miró sin el otro repo: ${s.out}`);
  for (const r of [h, s]) assert.doesNotMatch(r.out, /no encontré (agent-skills|arnes)/);
  assert.match(h.out, /guides\/con-nombre\.md:3/);
  assert.doesNotMatch(h.out, /skills\/tycon-x/);
  assert.match(s.out, /skills\/tycon-x\/con-nombre\.md:3/);
  assert.doesNotMatch(s.out, /guides\/con-nombre/);
  // por rango, sobre el commit hecho: cada parte, lo suyo
  const base = git(l.arnes, ['rev-parse', 'HEAD']);
  commit(l.arnes, 'los dos nombres entran (por otro camino)');
  const hr = unifiedBrake(l, 'arnes', { args: ['--range', `${base}...HEAD`] });
  const sr = unifiedBrake(l, 'agent-skills', { args: ['--range', `${base}...HEAD`] });
  assert.strictEqual(hr.code, 1, hr.out);
  assert.match(hr.out, /guides\/con-nombre\.md:3/);
  assert.strictEqual(sr.code, 1, sr.out);
  assert.match(sr.out, /skills\/tycon-x\/con-nombre\.md:3/);
});

test('Unified_RenameAcrossSources_AddForOneRemovalForTheOther — un renombre que cruza de fuente es un alta para una parte y una baja para la otra', () => {
  const l = unifiedLab();
  // guides/ya-nombra.md trae un nombre «desde siempre»: movido adentro de skills/ es un archivo NUEVO de agent-skills
  git(l.arnes, ['mv', 'guides/ya-nombra.md', 'skills/tycon-x/ya-nombra.md']);
  const h = unifiedBrake(l, 'arnes');
  const s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(s.code, 1, `para la parte de skills es un alta, con su nombre: ${s.out}`);
  assert.match(s.out, /skills\/tycon-x\/ya-nombra\.md:3/);
  assert.strictEqual(h.code, 0, `para la parte del arnés es una baja: ${h.out}`);
  resetLab(l.arnes);
  // adentro de la misma fuente sigue siendo un renombre: no frena (lo que ya estaba)
  git(l.arnes, ['mv', 'guides/ya-nombra.md', 'guides/ya-nombra-otra.md']);
  const same = unifiedBrake(l, 'arnes');
  assert.strictEqual(same.code, 0, same.out);
});

// La detección de renombres se hace por fuente, no sobre el árbol ENTERO. Si se hiciera sobre el árbol entero, un
// archivo de la otra mitad con el mismo texto se quedaría con el origen del renombre, y el movido dentro de la propia
// mitad pasaría a ser un alta: sus nombres de siempre saldrían como nuevos. El veredicto de la parte del
// arnés dependería de cambios de skills/ que no le tocan.
// 🔴 Sin eso: (a) la parte del arnés saldría 1 con «guides/movido.md:3 [cliente] AcmeCorp»; (b) el rango
//    que cruza la unión, lo mismo (y desde la unión, sin cruzarla, 0).
const ORIGINAL_GUIDE = '# Ya nombra\n\nEsto lo usa AcmeCorp desde siempre.\nOtra línea.\n';
test('Unified_RenameWithinHalf_TwinInOtherHalf_StillARename — un gemelo en la otra mitad no le roba el renombre a la propia', () => {
  // (a) lo stageado: el movido y retocado en el arnés, y en el MISMO commit un gemelo exacto en skills/ (que ni sale)
  const l = unifiedLab();
  git(l.arnes, ['mv', 'guides/ya-nombra.md', 'guides/movido.md']);
  stage(l.arnes, { 'guides/movido.md': `${ORIGINAL_GUIDE}Línea limpia nueva.\n`, 'skills/other-x/copia.md': ORIGINAL_GUIDE });
  let h = unifiedBrake(l, 'arnes');
  let s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(h.code, 0, `el movido sigue siendo un renombre dentro del arnés: ${h.out}`);
  assert.doesNotMatch(h.out, /movido\.md:3/);
  assert.strictEqual(s.code, 0, `la copia de skills/ no sale: ${s.out}`);
  // el espejo: el mismo movimiento con una línea NUEVA con un nombre frena, por esa línea y no por la de siempre
  resetLab(l.arnes);
  git(l.arnes, ['mv', 'guides/ya-nombra.md', 'guides/movido.md']);
  stage(l.arnes, { 'guides/movido.md': `${ORIGINAL_GUIDE}Y ahora Initech.\n`, 'skills/other-x/copia.md': ORIGINAL_GUIDE });
  h = unifiedBrake(l, 'arnes');
  assert.strictEqual(h.code, 1, h.out);
  assert.match(h.out, /guides\/movido\.md:5/);
  assert.doesNotMatch(h.out, /movido\.md:3/, 'el nombre de siempre no se nombra');

  // (b) un rango que cruza la unión: agent-skills trae desde siempre un gemelo de la guía; después se mueve la guía
  const u = lab();
  const main = git(u.arnes, ['rev-parse', 'HEAD']);
  stage(u.skills, { 'skills/tycon-pipeline/SKILL.md': '# Pipeline\n', 'skills/tycon-x/copia.md': ORIGINAL_GUIDE, 'README.md': null });
  commit(u.skills, 'el lado de skills, con un gemelo de la guía');
  git(u.arnes, ['checkout', '-q', '-b', 'union']);
  git(u.arnes, ['fetch', '-q', u.skills, 'HEAD']);
  git(u.arnes, ['merge', '-q', '--no-commit', '--allow-unrelated-histories', 'FETCH_HEAD']);
  const union = commit(u.arnes, 'la unión');
  git(u.arnes, ['mv', 'guides/ya-nombra.md', 'guides/movido.md']);
  stage(u.arnes, { 'guides/movido.md': `${ORIGINAL_GUIDE}Línea limpia nueva.\n` });
  commit(u.arnes, 'mover y retocar la guía');
  const empty = fs.mkdtempSync(path.join(u.dir, 'vacia-'));
  const nowhere = { TYCON_GUIDES_DIR: empty, TYCON_SKILLS_DIR: empty };
  for (const range of [`${main}...HEAD`, `${union}...HEAD`]) {
    for (const source of ['arnes', 'agent-skills']) {
      const r = unifiedBrake(u, source, { args: ['--range', range], env: nowhere });
      assert.strictEqual(r.code, 0, `${source} sobre ${range}: el movido es un renombre de su mitad — ${r.out}`);
    }
  }
});

test('Unified_RangeWhoseTipPredatesTheUnion_FallsBackToTwoRepos — un rango de antes de la unión se mira como dos repos', () => {
  const l = unifiedLab();
  const empty = fs.mkdtempSync(path.join(l.dir, 'vacia-'));
  // la punta del rango (c1) es anterior a la unión: su árbol no trae skills/ ni agents/, así que no se parte por ruta
  const range = ['--range', `${l.c1}^..${l.c1}`, '--config-from', 'disk'];
  let r = unifiedBrake(l, 'arnes', { args: range, env: { TYCON_SKILLS_DIR: l.skills } });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/viejo\.md:4/);
  // y sin el otro repo a mano lo dice, como siempre con dos repos (el repo unido no cuenta para esa punta)
  r = unifiedBrake(l, 'arnes', { args: range, env: { TYCON_SKILLS_DIR: empty } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no encontré agent-skills/);
});

test('Unified_TwoReposStillWork — con dos repos de verdad el freno sigue leyendo el otro (hasta el retiro del modo de dos repos)', () => {
  const l = lab();
  stage(l.skills, { 'skills/tycon-x/con-nombre.md': '# Skill\n\nLo usa AcmeCorp.\n' });
  const s = skillsBrake(l);
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /skills\/tycon-x\/con-nombre\.md:3/);
  const empty = fs.mkdtempSync(path.join(l.dir, 'vacia-'));
  const alone = skillsBrake(l, { env: { TYCON_GUIDES_DIR: empty } });
  assert.strictEqual(alone.code, 0, alone.out);
  assert.match(alone.out, /no encontré arnes/);
});

// ── T25 · un rango que CRUZA la unión: el pull request del corte ─────────────────────────────────
// El pull request que lleva la unión a `main` sale de un `main` de ANTES de la unión: a su base le falta una mitad
// entera, que entra con su historia por el merge de la unión. Esa mitad no es nueva —cada commit suyo ya pasó por este
// freno en su repo—: se compara contra el commit desde donde entró (el padre con la forma del otro repo). Lo que el
// propio merge, o un commit posterior, cambia sobre esa historia se mira como cualquier cambio: el rango pasa porque
// el freno sabe de dónde viene cada mitad, nunca porque la saltee.
// 🔴 Con la base de antes de la unión, la parte de skills vería TODO `skills/` como recién
//    agregado y frenaría un nombre que agent-skills trae desde siempre; y el rango desde el padre de skills frenaría
//    lo mismo del lado del arnés.
/** El laboratorio con la unión hecha como la de verdad: las dos historias, juntadas por un merge en una rama. */
function unionMergeLab({ inTheMerge = null } = {}) {
  const l = lab();
  l.main = git(l.arnes, ['rev-parse', 'HEAD']);
  // el lado de skills: la forma que el repo unido reconoce, y un archivo que sale y nombra a un cliente «desde siempre»
  stage(l.skills, {
    'skills/tycon-pipeline/SKILL.md': '# Pipeline\n',
    'skills/tycon-x/ya-nombra.md': '# Skill\n\nLo usa Globex desde siempre.\n',
    'README.md': null,   // el del arnés es el que queda en la raíz
  });
  l.side = commit(l.skills, 'el lado de skills, listo para unirse');
  git(l.arnes, ['checkout', '-q', '-b', 'union']);
  git(l.arnes, ['fetch', '-q', l.skills, 'HEAD']);
  git(l.arnes, ['merge', '-q', '--no-commit', '--allow-unrelated-histories', 'FETCH_HEAD']);
  if (inTheMerge) stage(l.arnes, inTheMerge);
  l.union = commit(l.arnes, 'la unión: las dos historias en un merge');
  return l;
}

test('Unified_RangeCrossingTheUnion_EachHalfAgainstItsOwnHistory — T25: el rango del pull request que trae la unión pasa, y lo nuevo de después frena', () => {
  const l = unionMergeLab();
  const empty = fs.mkdtempSync(path.join(l.dir, 'vacia-'));
  const nowhere = { TYCON_GUIDES_DIR: empty, TYCON_SKILLS_DIR: empty };
  const both = (range) => ['arnes', 'agent-skills'].map((source) => unifiedBrake(l, source, { args: ['--range', range], env: nowhere }));
  // el rango entero del pull request (desde el main de antes), y el del commit de la unión desde cada padre
  for (const range of [`${l.main}...HEAD`, `${l.union}^1...${l.union}`, `${l.union}^2...${l.union}`]) {
    for (const r of both(range)) {
      assert.strictEqual(r.code, 0, `${range}: lo que cada mitad ya traía en su historia no es nuevo — ${r.out}`);
      assert.doesNotMatch(r.out, /no encontré (agent-skills|arnes)/, 'sin buscar «el otro repo»');
    }
  }
  // no es saltear: lo que entra DESPUÉS de la unión frena, cada nombre por su parte y sólo su archivo
  stage(l.arnes, { 'skills/tycon-x/nuevo.md': '# Skill\n\nLo usa Initech.\n', 'guides/nuevo.md': '# Guía\n\nLo usa AcmeCorp.\n' });
  commit(l.arnes, 'dos nombres nuevos, después de la unión');
  const [h, s] = both(`${l.main}...HEAD`);
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /skills\/tycon-x\/nuevo\.md:3/);
  assert.doesNotMatch(s.out, /ya-nombra|guides\/nuevo/, 'ni lo que ya estaba, ni lo de la otra parte');
  assert.strictEqual(h.code, 1, h.out);
  assert.match(h.out, /guides\/nuevo\.md:3/);
  assert.doesNotMatch(h.out, /skills\//, 'lo de skills/ lo mira la parte de skills');
});

test('Unified_RangeCrossingTheUnion_ChangedInTheMergeItself_Blocks — lo que el commit de la unión cambia sobre su historia se mira', () => {
  const l = unionMergeLab({ inTheMerge: { 'skills/tycon-x/ya-nombra.md': '# Skill\n\nLo usa Globex desde siempre.\nY ahora Initech.\n' } });
  for (const range of [`${l.main}...HEAD`, `${l.union}^1...${l.union}`, `${l.union}^2...${l.union}`]) {
    const s = unifiedBrake(l, 'agent-skills', { args: ['--range', range] });
    assert.strictEqual(s.code, 1, `${range}: ${s.out}`);
    assert.match(s.out, /skills\/tycon-x\/ya-nombra\.md:4 [^\n]*Initech/);
    assert.doesNotMatch(s.out, /«Globex»/, 'el nombre que ya estaba en esa historia no se nombra');
  }
});

test('Unified_RangeCrossingTheUnion_HalfWithoutHistory_IsAllNew — sin la historia (la mitad agregada por un commit común) se mira entera', () => {
  const l = lab();
  const main = git(l.arnes, ['rev-parse', 'HEAD']);
  for (const top of ['agents', 'packs', 'skills']) fs.cpSync(path.join(l.skills, top), path.join(l.arnes, top), { recursive: true });
  stage(l.arnes, { 'skills/tycon-pipeline/SKILL.md': '# Pipeline\n', 'skills/tycon-x/ya-nombra.md': '# Skill\n\nLo usa Globex desde siempre.\n' });
  commit(l.arnes, 'agent-skills copiado adentro, sin su historia');
  const s = unifiedBrake(l, 'agent-skills', { args: ['--range', `${main}...HEAD`] });
  assert.strictEqual(s.code, 1, `sin de dónde comparar, la mitad es nueva y se mira: ${s.out}`);
  assert.match(s.out, /skills\/tycon-x\/ya-nombra\.md:3/);
});

test('Unified_RangeCrossingTheUnion_TwoSidesMerged_ComparedWithTheLatest — si la otra historia entró dos veces, el antes es su última punta', () => {
  const l = unionMergeLab();
  // agent-skills siguió avanzando en su repo, y la rama unida lo vuelve a traer
  stage(l.skills, { 'skills/tycon-x/segunda.md': '# Skill\n\nLo usa Vandelay desde su repo.\n' });
  commit(l.skills, 'agent-skills avanza después de la unión');
  git(l.arnes, ['fetch', '-q', l.skills, 'HEAD']);
  git(l.arnes, ['merge', '-q', '--no-edit', 'FETCH_HEAD']);
  for (const source of ['arnes', 'agent-skills']) {
    const r = unifiedBrake(l, source, { args: ['--range', `${l.main}...HEAD`] });
    assert.strictEqual(r.code, 0, `${source}: lo que vino con la segunda mezcla tampoco es nuevo — ${r.out}`);
  }
});

// La topología real del pull request del corte: el lado de skills
// de la unión (S1) sale de una rama aparte, y el main de agent-skills (A1) sigue desde el mismo punto y se mezcla
// después: ninguno contiene al otro, y la mitad de skills se compara contra LOS DOS. Un nombre que A1 limpió seguiría
// «estando» en S1 (que nunca lo limpió), así que volver a meterlo después pasaría la red del pull request.
// 🔴 Sin eso, `--range <main de antes>...HEAD` saldría 0 ({"outcome":"clean"}); desde la mezcla de A1, 1.
/** Las dos historias de agent-skills que no se contienen: S1 (rama aparte, en la unión) y A1 (main, mezclado después). */
function twoSidesLab({ sideOnly = null } = {}) {
  const l = lab();
  l.main = git(l.arnes, ['rev-parse', 'HEAD']);
  stage(l.skills, { 'skills/tycon-pipeline/SKILL.md': '# Pipeline\n', 'skills/tycon-x/ya-nombra.md': '# Skill\n\nLo usa Globex desde siempre.\n' });
  l.a0 = commit(l.skills, 'A0: el main de agent-skills');
  git(l.skills, ['checkout', '-q', '-b', 'side']);
  stage(l.skills, { 'README.md': null, ...(sideOnly || {}) });
  l.s1 = commit(l.skills, 'S1: el lado de la unión, en una rama aparte');
  git(l.arnes, ['checkout', '-q', '-b', 'union']);
  git(l.arnes, ['fetch', '-q', l.skills, 'side']);
  git(l.arnes, ['merge', '-q', '--no-commit', '--allow-unrelated-histories', 'FETCH_HEAD']);
  l.union = commit(l.arnes, 'la unión');
  git(l.skills, ['checkout', '-q', 'main']);
  stage(l.skills, { 'skills/tycon-x/ya-nombra.md': '# Skill\n\nLo usa un cliente desde siempre.\n' });
  l.a1 = commit(l.skills, 'A1: el main de agent-skills limpia el nombre');
  git(l.arnes, ['fetch', '-q', l.skills, 'main']);
  git(l.arnes, ['merge', '-q', '--no-edit', 'FETCH_HEAD']);
  l.m2 = git(l.arnes, ['rev-parse', 'HEAD']);
  return l;
}
test('Unified_RangeCrossingTheUnion_TwoSidesNotContained_ComparedWithTheLatest — un nombre que la última punta limpió no vuelve por la red del pull request', () => {
  const empty = (l) => { const d = fs.mkdtempSync(path.join(l.dir, 'vacia-')); return { TYCON_GUIDES_DIR: d, TYCON_SKILLS_DIR: d }; };
  // (a) vuelve con una línea nueva
  let l = twoSidesLab();
  assert.notStrictEqual(git(l.arnes, ['merge-base', '--is-ancestor', l.s1, l.a1], { tolerate: true }).status, 0, 'control: S1 no es ancestro de A1');
  const clean = fs.readFileSync(path.join(l.arnes, 'skills/tycon-x/ya-nombra.md'), 'utf8');
  stage(l.arnes, { 'skills/tycon-x/ya-nombra.md': `${clean}Y otra vez Globex.\n` });
  commit(l.arnes, 'C3: vuelve el nombre');
  let r = unifiedBrake(l, 'agent-skills', { args: ['--range', `${l.main}...HEAD`], env: empty(l) });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /skills\/tycon-x\/ya-nombra\.md:4 [^\n]*Globex/);
  // control: desde la mezcla de A1 (un solo antes), lo mismo
  r = unifiedBrake(l, 'agent-skills', { args: ['--range', `${l.m2}...HEAD`], env: empty(l) });
  assert.strictEqual(r.code, 1, r.out);

  // (b) vuelve EXACTO: el archivo queda igual que en S1 (deshacer lo que limpió A1)
  l = twoSidesLab();
  stage(l.arnes, { 'skills/tycon-x/ya-nombra.md': '# Skill\n\nLo usa Globex desde siempre.\n' });
  commit(l.arnes, 'C3: deshace la limpieza');
  r = unifiedBrake(l, 'agent-skills', { args: ['--range', `${l.main}...HEAD`], env: empty(l) });
  assert.strictEqual(r.code, 1, `deshacer la limpieza de la última punta es volver a meter el nombre: ${r.out}`);
  assert.match(r.out, /skills\/tycon-x\/ya-nombra\.md:3 [^\n]*Globex/);

  // el espejo: lo que trajo sólo el lado viejo (S1) y la última punta nunca tocó sigue siendo «de su historia»
  l = twoSidesLab({ sideOnly: { 'skills/tycon-x/del-lado.md': '# Del lado\n\nLo usa Globex, desde la rama de la unión.\n' } });
  stage(l.arnes, { 'guides/limpio-nuevo.md': '# Limpio\n' });
  commit(l.arnes, 'un commit cualquiera después');
  for (const source of ['arnes', 'agent-skills']) {
    r = unifiedBrake(l, source, { args: ['--range', `${l.main}...HEAD`], env: empty(l) });
    assert.strictEqual(r.code, 0, `${source}: lo que cada lado ya traía en su historia no es nuevo — ${r.out}`);
  }
});

// ── el doble aviso ─────────────────────────────────────────────────────
// En el repo unido las dos partes ven cambiar las DOS mitades en el mismo commit. Cada hallazgo sale UNA vez: lo que el
// commit toca lo mira la parte de su fuente; lo que no toca y empieza a salir, la parte de la fuente que lo reclasifica.
// 🔴 Con un cambio de la lista blanca en el commit, la parte del arnés reportaría también el
//    archivo nuevo de skills/ (que ya reporta su parte): el mismo hallazgo dos veces, y doble en el registro.
test('Unified_BothHalvesInOneCommit_EachFindingOnce — el doble aviso: cada hallazgo lo reporta una sola parte', () => {
  const l = unifiedLab();
  stage(l.arnes, { 'skills/other-x/notas.md': '# Notas\n\nLo usa Globex.\n' });
  commit(l.arnes, 'una skill que la lista blanca no publica, con un nombre');
  // un solo commit: la lista empieza a publicar esa skill (del arnés), y skills/ estrena un archivo con otro nombre
  const list = clone(LIST);
  list.packages.core['agent-skills'].in.push('skills/other-x/**');
  stage(l.arnes, { 'scripts/publishing/allowlist.json': list, 'skills/tycon-x/con-nombre.md': '# Skill\n\nLo usa AcmeCorp.\n' });
  const h = unifiedBrake(l, 'arnes');
  const s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(h.code, 1, h.out);
  assert.match(h.out, /agent-skills: skills\/other-x\/notas\.md:3/, 'lo que empieza a salir por la lista lo reporta la parte del arnés');
  assert.doesNotMatch(h.out, /con-nombre/, 'el archivo nuevo de skills/ es de la otra parte');
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /skills\/tycon-x\/con-nombre\.md:3/);
  assert.doesNotMatch(s.out, /other-x/, 'lo que reclasifica la lista ya lo reportó la parte del arnés');
});

test('Unified_BothHalvesInOneCommit_PackReclassifies_SkillsPartReports — lo que reclasifica un paquete lo reporta la parte de skills, una vez', () => {
  const l = unifiedLab();
  // el revisor del paquete de clientes pasa a uno público: su caso del banco (del arnés, sin tocar) empieza a salir;
  // el mismo commit toca además un archivo del arnés
  stage(l.arnes, {
    'packs/bizuit/pack.json': { name: 'bizuit', reviewers: [{ agent: 'revisor-publico', group: 'base' }, { agent: 'revisor-cliente', group: 'condicional' }] },
    'packs/clients/pack.json': { name: 'clients', reviewers: [] },
    'guides/limpio.md': '# Limpio\n\nUna línea más.\n',
  });
  const h = unifiedBrake(l, 'arnes');
  const s = unifiedBrake(l, 'agent-skills');
  assert.strictEqual(s.code, 1, s.out);
  assert.match(s.out, /scripts\/controls-bench\/cases\/advisors\/revisor-cliente\.json/);
  assert.strictEqual(h.code, 0, `la parte del arnés no repite lo que reclasificó un paquete: ${h.out}`);
});

// ── T25 · la unión DE VERDAD ────────────────────────────────────────────────────────────────
// La única prueba de esta suite que corre el freno sobre el repo real (con sus listas privadas): mira sólo el código de
// salida y los conteos del --json, nunca un texto encontrado. Los commits están anotados en
// scripts/tests/fixtures/union-commits.json; en un clon que no trae esa historia (la copia pública, un clon recortado)
// o que no es el del equipo, sale NO MEDIDA.
test('Unified_RealUnionRange_PassesBothSources — T25: el rango del commit de la unión de verdad pasa con las dos fuentes', (t) => {
  const fixture = path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'union-commits.json');
  if (!fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) || !fs.existsSync(fixture)) { t.skip('NO MEDIDO: no es el clon del equipo (sin perfil o sin los commits de la unión anotados)'); return; }
  const u = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const has = (sha) => spawnSync('git', ['-C', RAIZ, 'cat-file', '-e', `${sha}^{commit}`], { env: cleanEnv() }).status === 0;
  const need = [u.union, u.harness_resolved, u.skills_resolved, u.tips && u.tips.harness_main, u.tips && u.tips.skills_main];
  if (!need.every((sha) => sha && has(sha))) { t.skip('NO MEDIDO: este clon no trae los commits de la unión (¿clon recortado?)'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'new-names-real-'));
  created.push(home);
  const empty = fs.mkdtempSync(path.join(home, 'vacia-'));
  // 🔴 La salida 0 también la dan «quiet» (no había nada que mirar) y «not-measured» (no pudo): cada rango y cada fuente
  // tiene su resultado ESPERADO. Un rango que cruza la unión
  // compara la mitad que su base no trae con la historia de esa mitad: la mitad que llega entera por la unión no trae
  // nada nuevo y da «quiet»; la que cambió en la resolución de los choques MIRA (clean, con archivos). Cada fuente mira
  // en al menos un rango: si una dejara de clasificar su mitad, su «clean» pasaría a otra cosa.
  const expected = [
    [`${u.harness_resolved}...${u.union}`, { arnes: 'quiet', 'agent-skills': 'quiet' }],
    [`${u.skills_resolved}...${u.union}`, { arnes: 'quiet', 'agent-skills': 'quiet' }],
    [`${u.tips.harness_main}...${u.union}`, { arnes: 'clean', 'agent-skills': 'quiet' }],   // el rango del pull request de la unión
    [`${u.tips.skills_main}...${u.union}`, { arnes: 'quiet', 'agent-skills': 'clean' }],
  ];
  for (const [range, bySource] of expected) {
    for (const source of ['arnes', 'agent-skills']) {
      const r = spawnSync(process.execPath, [NEW_NAMES, '--repo', RAIZ, '--source', source, '--range', range, '--json'], {
        cwd: RAIZ, encoding: 'utf8', env: cleanEnv({ HOME: home, TYCON_GUIDES_DIR: empty, TYCON_SKILLS_DIR: empty }),
      });
      // sin el texto de la salida: nombra lo que encontró, y esa lista es privada
      assert.strictEqual(r.status, 0, `${source} sobre ${range.slice(0, 12)}…: salió ${r.status} (${(r.stdout || '').trim().split('\n').pop()})`);
      assert.doesNotMatch(r.stderr || '', /no encontré (agent-skills|arnes)/, 'sin buscar «el otro repo»');
      let j;
      try { j = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { j = { outcome: '(el --json no se pudo leer)' }; }
      assert.strictEqual(j.outcome, bySource[source], `${source} sobre ${range.slice(0, 12)}…: esperaba «${bySource[source]}» y salió «${j.outcome}»`);
      if (j.outcome === 'clean') assert.ok(j.files > 0, `${source} sobre ${range.slice(0, 12)}…: «clean» sin haber mirado ningún archivo`);
    }
  }
});

// El techo de los nombres reales es el mismo antes y después de la unión. El commit de la unión no lo toca: si lo
// tocara, la cuenta «igual» se conseguiría subiendo el techo. Compara sin imprimir el contenido (es privado).
test('Unified_RealUnion_NamesCeilingUnchanged — T25: names-ceiling.json es el mismo del lado del arnés que en el repo unido', (t) => {
  const fixture = path.join(RAIZ, 'scripts', 'tests', 'fixtures', 'union-commits.json');
  if (!fs.existsSync(path.join(RAIZ, 'perfil-equipo.json')) || !fs.existsSync(fixture)) { t.skip('NO MEDIDO: no es el clon del equipo (sin perfil o sin los commits de la unión anotados)'); return; }
  const u = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const show = (sha) => spawnSync('git', ['-C', RAIZ, 'show', `${sha}:scripts/publishing/names-ceiling.json`], { encoding: 'utf8', env: cleanEnv() });
  const before = show(u.harness_side);
  const after = show(u.union);
  if (before.status !== 0 || after.status !== 0) {
    const has = (sha) => spawnSync('git', ['-C', RAIZ, 'cat-file', '-e', `${sha}^{commit}`], { env: cleanEnv() }).status === 0;
    if (![u.harness_side, u.union].every((sha) => sha && has(sha))) { t.skip('NO MEDIDO: este clon no trae los commits de la unión (¿clon recortado?)'); return; }
    assert.fail(`los dos commits están y el techo no se pudo leer en alguno (antes: ${before.status}, después: ${after.status}): no pude mirar`);
  }
  // el espejo de que la comparación compara: el techo se lee y trae cifras
  const b = JSON.parse(before.stdout);
  assert.ok(Object.keys(b).some((k) => !k.startsWith('__')), 'el techo del lado del arnés trae al menos una cifra');
  assert.ok(require('node:util').isDeepStrictEqual(JSON.parse(after.stdout), b), 'names-ceiling.json cambió con la unión (el contenido no se imprime: es privado)');
});

test.after(() => {
  for (const d of [...created, template && template.dir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

// ── `empty` con una ruta de puntos: el freno la entiende como el exportador
test('8.10.3 NewNames_EmptyWithDottedPath_IsUnderstood — una clave anidada declarada en `empty` no deja al freno en «no pude mirar»', () => {
  const l = lab();
  const list = clone(LIST);
  list.empty = { 'scripts/config.json': ['maquina', 'reducer.maquinas'] };
  stage(l.arnes, { 'scripts/config.json': '{\n  "maquina": "",\n  "reducer": { "ventana": 7, "maquinas": [] }\n}\n', 'scripts/publishing/allowlist.json': list });
  let r = brake(l);
  assert.strictEqual(r.code, 0, `la clave anidada existe: el freno mira y deja pasar\n${r.out}`);
  // la misma ruta, cuando no existe en el archivo: «la lista blanca declara lo que no está» (2), como en el exportador
  const l2 = lab();
  const list2 = clone(LIST);
  list2.empty = { 'scripts/config.json': ['maquina', 'reducer.no_existe'] };
  stage(l2.arnes, { 'scripts/config.json': '{\n  "maquina": "",\n  "reducer": { "ventana": 7 }\n}\n', 'scripts/publishing/allowlist.json': list2 });
  r = brake(l2);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /reducer\.no_existe/);
});

// El freno le pasa las excepciones exactas al control de nombres pegados, pero no cuando mira RUTAS. El exportador no
// acepta excepción en una ruta: un nombre pegado en una ruta se arregla renombrando. Si el freno las aplicara a las
// rutas, con un permitido de glob amplio el commit pasaría y la publicación frenaría.
test('8.10.3 NewNames_GluedNameInAPath_NoAllowanceApplies — un pegado en una ruta frena aunque haya una excepción que lo nombre', () => {
  const l = lab();
  // la excepción ya está en HEAD (una nueva es, por sí sola, un hallazgo del freno)
  const denied = clone(DENIED);
  denied.permitidos.push({ archivo: '**', patron: '^AcmeCorpBackend$', motivo: 'un identificador declarado (prueba)' });
  stage(l.arnes, { 'scripts/publishing/denylist.json': denied });
  commit(l.arnes, 'la lista ya trae la excepción');
  // en el CONTENIDO la excepción vale
  stage(l.arnes, { 'scripts/app.js': "'use strict';\nconst AcmeCorpBackend = 1;\nmodule.exports = AcmeCorpBackend;\n" });
  let r = brake(l);
  assert.doesNotMatch(r.out, /nombre pegado/, `con su excepción, el pegado del contenido no es un nombre nuevo\n${r.out}`);
  resetLab(l.arnes);
  // en la RUTA, no
  git(l.arnes, ['mv', 'guides/limpio.md', 'scripts/AcmeCorpBackend.js']);
  r = brake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(ruta\)[^\n]*AcmeCorpBackend/);
});

// ══ T79 — el árbol que ES la forma publicada ═══════════════════════════════════════════════════════════════════
// Quien mantiene commitea en un clon del repo PÚBLICO: ese árbol no trae la lista, la tabla ni el perfil, y si el freno
// callara («ahí no hay lista por diseño»), el nombre se vería recién al empujar, con el commit ya hecho. Acá se arma un
// clon del público DE JUGUETE (trae scripts/setup/public-remotes.json y los guiones; nunca una lista), una máquina de
// laboratorio (HOME y TYCON_HOME propios: la configuración real queda fuera de alcance) y un clon de mantenimiento de
// juguete con una lista SINTÉTICA. Corre el freno del propio clon de juguete, como en el hook: «el arnés desde el que
// corre» es el árbol que se commitea, y su lista —si alguien la planta— no puede valer.
const T79 = 'T79 MaintainerMachine_CommitLooksWithMachineList_DoctorNamesGuard_HooksPathElsewhereWarned_StaleListWarned';
const TYCON_HOME_LIB = require(path.join(RAIZ, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const MACHINE_LIST = {
  terminos: [
    { patron: 'AcmeCorp', categoria: 'cliente', palabra: true },
    { patron: 'Vandelay', categoria: 'persona', palabra: true },
  ],
  permitidos: [{ archivo: 'guides/permitido.md', patron: '^AcmeCorp$', motivo: 'prueba: una excepción de la lista de la máquina' }],
};
const LIST_REL = 'scripts/publishing/denylist.json';
const MARK_REL = 'scripts/setup/public-remotes.json';
const withName = '# Guía\n\nPrimera línea.\nLo usa AcmeCorp.\n';

let publishedTemplate = null;
function buildPublishedTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-names-published-template-'));
  created.push(dir);   // se borra al final, con los laboratorios
  const pub = path.join(dir, 'pub');
  // lo que el freno necesita para correr, que la copia publicada trae: sus guiones (el freno, el exportador, el detector),
  // el freno antes de publicar y quien sabe dónde vive el arnés. Nunca un .json de scripts/publishing/ (en el clon del
  // equipo ahí viven la lista y la tabla de verdad). Sin los demás controles del pre-commit: los que no están, no corren.
  fs.cpSync(path.join(RAIZ, 'scripts', 'lib'), path.join(pub, 'scripts', 'lib'), { recursive: true });
  for (const f of ['publishing/new-names.js', 'publishing/export.js', 'publishing/public-copy.js', 'publishing/detector.js', 'hooks/public-push-guard.js', 'setup/harness/tycon-home.js']) {
    fs.mkdirSync(path.dirname(path.join(pub, 'scripts', f)), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, 'scripts', f), path.join(pub, 'scripts', f));
  }
  // el pre-commit como viaja en la copia: el despachador y sus dos guiones
  fs.mkdirSync(path.join(pub, '.githooks'));
  for (const f of fs.readdirSync(path.join(RAIZ, '.githooks'))) {
    fs.copyFileSync(path.join(RAIZ, '.githooks', f), path.join(pub, '.githooks', f));
    fs.chmodSync(path.join(pub, '.githooks', f), 0o755);
  }
  write(pub, {
    [MARK_REL]: { __doc: 'De laboratorio: sólo existe en la copia publicada.', remotes: [] },
    'README.md': '# Copia publicada de laboratorio\n',
    'guides/x.md': '# Guía\n\nPrimera línea.\nSegunda línea.\n',
    'guides/ya-nombra.md': '# Ya nombra\n\nEsto lo usa AcmeCorp desde siempre.\nOtra línea.\n',
    'guides/permitido.md': '# Permitido\n',
    'skills/tycon-x/SKILL.md': '# Skill\n',
    'agents/revisor-nucleo.md': agent('revisor-nucleo', 'Revisa el núcleo.'),
  });
  git(pub, ['init', '-q', '-b', 'main']);
  git(pub, ['add', '-A']); commit(pub, 'la copia publicada');
  const maint = path.join(dir, 'maint');
  write(maint, { [LIST_REL]: MACHINE_LIST, 'README.md': '# Clon de mantenimiento de laboratorio\n' });
  git(maint, ['init', '-q', '-b', 'main']);
  git(maint, ['add', '-A']); commit(maint, 'la lista');
  return { dir };
}
/**
 * Una máquina de laboratorio con su clon del público. `maintainers`: la máquina declara su clon de mantenimiento
 * (`paths.maintainers`); `team`: su arnés instalado (una versión bajada, en TYCON_HOME) trae el perfil del equipo.
 */
function publishedLab({ maintainers = true, team = false } = {}) {
  if (!publishedTemplate) publishedTemplate = buildPublishedTemplate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-names-published-'));
  created.push(dir);
  fs.cpSync(publishedTemplate.dir, dir, { recursive: true });
  const l = { dir, pub: path.join(dir, 'pub'), maint: path.join(dir, 'maint'), home: path.join(dir, 'home'), tycon: path.join(dir, 'tycon') };
  fs.mkdirSync(l.home);
  fs.mkdirSync(l.tycon);
  if (maintainers) write(l.tycon, { 'config.json': { paths: { maintainers: l.maint } } });
  if (team) write(l.tycon, { 'harness/perfil-equipo.json': '{}\n' });
  return l;
}
/** El freno del clon de juguete, como lo corre su hook: parado en el repo, con la máquina del laboratorio. */
function pubBrake(l, { repo = l.pub, args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'publishing', 'new-names.js'), '--repo', repo, ...args], {
    cwd: repo, encoding: 'utf8', env: cleanEnv({ HOME: l.home, TYCON_HOME: l.tycon, ...env }),
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const stateFileOf = (l, name) => [path.join(l.tycon, 'state', name), path.join(l.home, '.claude', '.tycon-pipeline', name)].find((f) => fs.existsSync(f)) || null;
const jsonl = (file) => (file ? fs.readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : []);
/** `git commit` de verdad en el clon de juguete, con SU pre-commit cableado (el despachador y sus dos guiones). */
function pubCommit(l, repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', `core.hooksPath=${path.join(repo, '.githooks')}`, 'commit', '-q', ...args], {
    encoding: 'utf8', env: cleanEnv({ HOME: l.home, TYCON_HOME: l.tycon }),
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const commitsIn = (repo) => Number(git(repo, ['rev-list', '--count', 'HEAD']));
/** El clon de mantenimiento queda atrás: su rama principal remota conocida trae OTRA lista (un término más). */
function leaveMaintBehind(l) {
  git(l.maint, ['checkout', '-q', '-b', 'adelante']);
  write(l.maint, { [LIST_REL]: { ...MACHINE_LIST, terminos: [...MACHINE_LIST.terminos, { patron: 'Globex', categoria: 'cliente', palabra: true }] } });
  git(l.maint, ['add', '-A']); commit(l.maint, 'un término más');
  git(l.maint, ['update-ref', 'refs/remotes/origin/main', 'adelante']);
  git(l.maint, ['checkout', '-q', 'main']);
}

// a
test(`${T79} — a · un término de la lista de la máquina en un archivo cualquiera frena, y dice archivo y línea, no el término`, () => {
  const l = publishedLab();
  stage(l.pub, { 'guides/x.md': withName });
  const r = pubBrake(l);
  assert.strictEqual(r.code, 1, `un hallazgo es 1 (2 es «no pude mirar»)\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:4\b[^\n]*\[cliente\]/, 'archivo, línea y categoría');
  assert.doesNotMatch(r.out, /AcmeCorp|Vandelay/, 'nunca el texto encontrado ni otro término de la lista');
  assert.match(r.out, /permitidos/, 'cómo salir de un freno falso: la excepción con motivo en la lista privada');
  assert.match(r.out, /TYCON_NEW_NAMES=0/, 'y el apagado, que lo dice');
  // deja su línea de conteos: fue el modo de la forma publicada, y de dónde salió la lista (la fuente, nunca su contenido)
  const own = jsonl(stateFileOf(l, 'new-names.jsonl'));
  assert.strictEqual(own.length, 1, JSON.stringify(own));
  assert.strictEqual(own[0].form, 'published');
  assert.strictEqual(own[0].list, 'maintainers');
  assert.strictEqual(own[0].blocked, true);
  assert.strictEqual(own[0].findings.cliente, 1, 'conteos por categoría');
  assert.doesNotMatch(JSON.stringify(own), /AcmeCorp|guides\/x\.md/, 'ni el texto encontrado ni la ruta');
  assert.deepStrictEqual(jsonl(stateFileOf(l, 'frenos.jsonl')).map((x) => [x.freno, x.veredicto]), [['new-names', 'bloqueo']]);
  // el espejo: una línea limpia pasa callada (un freno que rechaza todo también está roto)
  resetLab(l.pub);
  stage(l.pub, { 'guides/x.md': '# Guía\n\nPrimera línea.\nOtra línea limpia.\n' });
  const ok = pubBrake(l);
  assert.strictEqual(ok.code, 0, ok.out);
  assert.strictEqual(ok.out, '', 'limpio: no dice nada');
  // y un término de OTRA categoría, en un archivo que no es una guía
  resetLab(l.pub);
  stage(l.pub, { 'scripts/lib/nuevo.js': "'use strict';\n// lo pidió Vandelay\nmodule.exports = 1;\n" });
  const p = pubBrake(l);
  assert.strictEqual(p.code, 1, p.out);
  assert.match(p.out, /scripts\/lib\/nuevo\.js:2\b[^\n]*\[persona\]/);
});

// b · «no pude mirar» nunca es verde
test(`${T79} — b · la máquina declara su clon de mantenimiento y la lista no está, o no se deja leer: no pude mirar (2)`, () => {
  const l = publishedLab();
  stage(l.pub, { 'guides/x.md': withName });
  // declarada, y ahí no hay lista
  fs.rmSync(path.join(l.maint, LIST_REL));
  let r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  assert.match(r.out, /paths\.maintainers/, 'dice qué lugar declarado quedó sin lista');
  // la carpeta declarada no está
  write(l.tycon, { 'config.json': { paths: { maintainers: path.join(l.dir, 'no-existe') } } });
  r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  // está y no se deja leer (un término sin categoría): el motivo no cita un pedazo de la lista
  write(l.tycon, { 'config.json': { paths: { maintainers: l.maint } } });
  write(l.maint, { [LIST_REL]: { terminos: [{ patron: 'Umbrellacorp' }] } });
  r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  assert.doesNotMatch(r.out, /Umbrellacorp|AcmeCorp/, 'el mensaje no cita la lista privada');
  // la configuración de la máquina no se deja leer: no se sabe dónde declaró la lista
  write(l.maint, { [LIST_REL]: MACHINE_LIST });
  write(l.tycon, { 'config.json': '{ "paths": { "maintainers": ' });
  r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  // cada «no pude mirar» queda anotado como un bloqueo
  const brakes = jsonl(stateFileOf(l, 'frenos.jsonl'));
  assert.ok(brakes.length === 4 && brakes.every((x) => x.freno === 'new-names' && x.veredicto === 'bloqueo' && x.regla === 'could-not-look'), JSON.stringify(brakes));
});

// c · sin declarar nada
test(`${T79} — c · sin lista en ningún lugar: la máquina del equipo lo dice en una línea y deja pasar; la de afuera calla`, () => {
  // alguien de afuera con su copia: no hay lista por diseño
  const l = publishedLab({ maintainers: false });
  stage(l.pub, { 'guides/x.md': withName });
  let r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '', 'calla');
  assert.strictEqual(stateFileOf(l, 'new-names.jsonl'), null, 'y no deja registro');
  // la misma máquina con el arnés instalado del equipo, en sus dos formas: una versión bajada, y un clon
  const installed = { release: path.join(l.tycon, 'harness'), clone: TYCON_HOME_LIB.placePath(l.home) };
  for (const team of ['release', 'clone']) {
    write(installed[team], { 'scripts/install-tycon-hooks.sh': '#!/usr/bin/env bash\n', 'perfil-equipo.json': '{}\n' });
    r = pubBrake(l);
    assert.strictEqual(r.code, 0, `${team}\n${r.out}`);
    const lines = r.out.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, `${team}: UNA línea\n${r.out}`);
    assert.match(lines[0], /nombres nuevos: esta máquina no tiene la lista privada/, team);
    assert.match(lines[0], /no miré los nombres de este commit/, `${team}: no es «miré y está limpio»`);
    assert.match(lines[0], /se miran al empujar/, team);
    assert.match(lines[0], /harness\.js config set paths\.maintainers/, `${team}: el comando para quien mantiene`);
    fs.rmSync(installed[team], { recursive: true, force: true });
  }
  assert.deepStrictEqual(jsonl(stateFileOf(l, 'new-names.jsonl')).map((x) => x.outcome), ['no-list', 'no-list'], 'y queda anotado que no miró');
  assert.deepStrictEqual(jsonl(stateFileOf(l, 'frenos.jsonl')).map((x) => [x.veredicto, x.regla]), [['paso', 'no-list'], ['paso', 'no-list']], 'en el registro de frenos, con su regla por nombre');
  // un commit sin nada que mirar (sólo borra) no dice la línea, ni en la máquina del equipo
  write(installed.release, { 'perfil-equipo.json': '{}\n' });
  resetLab(l.pub);
  git(l.pub, ['rm', '-q', 'guides/ya-nombra.md']);
  r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
  // «¿es del equipo?» no se contesta a ciegas. Con la carpeta propia del arnés mal declarada no se sabe dónde está el
  // instalado (ni la configuración de la máquina): no pude mirar
  resetLab(l.pub);
  stage(l.pub, { 'guides/x.md': withName });
  r = pubBrake(l, { env: { TYCON_HOME: 'una-ruta-relativa' } });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  const nn = require(NEW_NAMES);
  assert.throws(() => nn.isTeamMachine({ TYCON_HOME: 'una-ruta-relativa' }),
    (e) => e instanceof nn.CouldNotLook && /no pude ubicar el arnés instalado/.test(e.message), 'la misma pregunta, hecha suelta');
  // y sin tycon-home.js en el árbol (la copia publicada lo trae), tampoco
  fs.rmSync(path.join(l.pub, 'scripts', 'setup', 'harness', 'tycon-home.js'));
  r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar[^\n]*no trae scripts\/setup\/harness\/tycon-home\.js/, 'lo dice, no revienta al cargarlo');
});

// d · en la forma publicada no hay exportador que saque tasks/ o specs/ (el atajo «nada de lo tocado sale» no aplica)
test(`${T79} — d · un archivo nuevo bajo tasks/ o specs/ con el término frena: en la forma publicada todo lo que se commitea sale`, () => {
  const l = publishedLab();
  // sólo rutas que el exportador saca siempre: con el atajo de por medio, este commit no cargaba nada
  const out = ['tasks/todo.md', 'specs/story-1.md', 'inbox/x.md', '.engram/manifest.json'];
  stage(l.pub, Object.fromEntries(out.map((rel) => [rel, 'Pendiente.\nLo pidió AcmeCorp.\n'])));
  const r = pubBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  for (const rel of out) assert.ok(r.out.includes(`${rel}:2`), `${rel}: archivo y línea\n${r.out}`);
});

// e · la lista es la de la MÁQUINA, nunca la del árbol que se commitea
test(`${T79} — e · una lista plantada en el propio árbol que se commitea no se usa: ni para frenar ni para dejar pasar`, () => {
  // la plantada frenaría «Globex» y dejaría pasar «AcmeCorp»; la de la máquina, al revés
  const planted = {
    terminos: [{ patron: 'Globex', categoria: 'cliente', palabra: true }],
    permitidos: [{ archivo: '**', patron: '^AcmeCorp$', motivo: 'prueba: plantada para dejar pasar' }],
  };
  const both = '# Guía\n\nLo usa Globex.\nLo usa AcmeCorp.\n';
  // 1 · en el disco, sin preparar (el lugar «el arnés desde el que corre el freno» es este mismo árbol)
  let l = publishedLab();
  write(l.pub, { [LIST_REL]: planted, 'guides/x.md': both });
  git(l.pub, ['add', 'guides/x.md']);
  let r = pubBrake(l);
  assert.strictEqual(r.code, 1, `en el disco\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:4\b/, 'frena lo que frena la lista de la máquina');
  assert.doesNotMatch(r.out, /guides\/x\.md:3\b/, 'y no lo que frenaría la plantada');
  // 2 · preparada en el mismo commit: la lista que un commit se trae a sí mismo no vale, y se mira como cualquier archivo
  l = publishedLab();
  stage(l.pub, { [LIST_REL]: planted, 'guides/x.md': both });
  r = pubBrake(l);
  assert.strictEqual(r.code, 1, `en el commit\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:4\b/);
  assert.doesNotMatch(r.out, /guides\/x\.md:3\b/);
  assert.match(r.out, /scripts\/publishing\/denylist\.json:\d+/, 'la plantada nombra un término de la lista de la máquina: también frena');
  // 3 · sin lista en la máquina, la plantada no pasa a ser «la lista»: la de afuera calla, la del equipo dice que no miró
  l = publishedLab({ maintainers: false });
  write(l.pub, { [LIST_REL]: planted, 'guides/x.md': both });
  git(l.pub, ['add', 'guides/x.md']);
  r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '', 'no frena con la plantada');
  write(l.tycon, { 'harness/perfil-equipo.json': '{}\n' });
  r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /esta máquina no tiene la lista privada/, 'ni cuenta como que la máquina tiene lista');
  // 4 · declarada por la variable, apuntando adentro del árbol: no pude mirar
  r = pubBrake(l, { env: { TYCON_PUBLISH_DENYLIST: path.join(l.pub, LIST_REL) } });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  // 5 · la máquina nombra ESTE MISMO clon con otras mayúsculas (un disco que no las distingue): sigue siendo el árbol que
  //     se commitea, y la lista plantada ahí no vale. Comparadas letra por letra, las dos rutas serían carpetas
  //     distintas y la plantada saldría como «la lista privada de esta máquina»
  const otherCase = path.join(l.dir, 'PUB');
  let sameFolder = false;
  try { sameFolder = fs.realpathSync.native(otherCase) === fs.realpathSync.native(l.pub); } catch { sameFolder = false; }
  if (!sameFolder) {
    console.log('⏭ T79 e: NO MEDIDO — este disco distingue mayúsculas: el mismo clon no se puede nombrar con otra caja');
    return;
  }
  write(l.tycon, { 'config.json': { paths: { maintained: otherCase } } });
  r = pubBrake(l);
  assert.strictEqual(r.code, 0, `el clon que mantiene, con otra caja\n${r.out}`);
  assert.match(r.out, /esta máquina no tiene la lista privada/, 'no es un lugar: no hay lista');
  assert.doesNotMatch(r.out, /guides\/x\.md:\d/, 'no miró con la plantada');
  write(l.tycon, { 'config.json': { paths: { maintainers: otherCase } } });
  r = pubBrake(l);
  assert.strictEqual(r.code, 2, `el clon de mantenimiento declarado, con otra caja\n${r.out}`);
  assert.match(r.out, /no pude mirar/);
  assert.doesNotMatch(r.out, /guides\/x\.md:\d/);
  // y al revés: el freno corrido nombrando el repo (y su propio guion) con la otra caja — «el arnés desde el que corre»
  // sigue siendo el árbol que se commitea
  fs.rmSync(path.join(l.tycon, 'config.json'));
  r = pubBrake(l, { repo: otherCase });
  assert.strictEqual(r.code, 0, `el repo nombrado con otra caja\n${r.out}`);
  assert.match(r.out, /esta máquina no tiene la lista privada/);
  assert.doesNotMatch(r.out, /guides\/x\.md:\d/);
});

// f · neto, como siempre
test(`${T79} — f · retocar o mover lo que ya traía el término no frena; el término en la ruta de un archivo nuevo, sí`, () => {
  const l = publishedLab();
  // en un mismo commit: retocar y mover la línea que ya lo traía, y renombrar otro archivo que ya lo traía
  write(l.pub, { 'guides/tambien-nombra.md': '# También\n\nLo usa AcmeCorp.\n' });
  git(l.pub, ['add', '-A']); commit(l.pub, 'otro archivo que ya nombra');
  write(l.pub, { 'guides/ya-nombra.md': '# Ya nombra\n\nOtra línea.\nEsto lo usa AcmeCorp desde siempre, retocada.\n' });
  git(l.pub, ['mv', 'guides/tambien-nombra.md', 'guides/renombrado.md']);
  git(l.pub, ['add', '-A']);
  let r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
  // una mención MÁS en ese archivo sí es nueva
  resetLab(l.pub);
  stage(l.pub, { 'guides/ya-nombra.md': '# Ya nombra\n\nEsto lo usa AcmeCorp desde siempre.\nOtra línea.\nY también AcmeCorp acá.\n' });
  r = pubBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/ya-nombra\.md:5\b/, 'la línea nueva, no la que ya estaba');
  assert.doesNotMatch(r.out, /guides\/ya-nombra\.md:3\b/);
  // el término en la RUTA de un archivo nuevo y en la de uno renombrado: frena, y la ruta —que es lo hallado— no se imprime
  resetLab(l.pub);
  write(l.pub, { 'guides/clientes/AcmeCorp.md': '# Un cliente\n' });
  git(l.pub, ['mv', 'guides/x.md', 'guides/acmecorp-x.md']);
  git(l.pub, ['add', '-A']);
  r = pubBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(2 hallazgo\(s\)\)/, `las dos rutas\n${r.out}`);
  assert.match(r.out, /\(ruta\)[^\n]*\[cliente\]/);
  assert.doesNotMatch(r.out, /acmecorp/i, 'la ruta con el término no se imprime');
  // renombrar un archivo cuya ruta YA traía el término no estrena nada
  git(l.pub, ['add', '-A']); commit(l.pub, 'las rutas ya nombran');
  git(l.pub, ['mv', 'guides/clientes/AcmeCorp.md', 'guides/clientes/AcmeCorp-2.md']);
  r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
});

// g · las excepciones de la lista privada valen como en el detector
test(`${T79} — g · un término con su excepción en «permitidos» de la lista de la máquina pasa`, () => {
  const l = publishedLab();
  stage(l.pub, { 'guides/permitido.md': '# Permitido\n\nLo usa AcmeCorp.\n' });
  let r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
  // la excepción es de ESE archivo y de ESE término
  resetLab(l.pub);
  stage(l.pub, { 'guides/permitido.md': '# Permitido\n\nLo firmó Vandelay.\n', 'guides/x.md': withName });
  r = pubBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/permitido\.md:3\b[^\n]*\[persona\]/);
  assert.match(r.out, /guides\/x\.md:4\b[^\n]*\[cliente\]/);
});

// h · controles: el modo nuevo no se mete donde no es
test(`${T79} — h · un árbol interno sin lista y con perfil sigue saliendo 2, y un laboratorio sin la señal sigue callando`, () => {
  const l = publishedLab();   // una máquina que declara su lista: los controles de abajo NO la tienen que usar
  // el interno al que le borraron la lista: no trae la señal, y NO pasa a mirar con la lista de la máquina
  const i = lab();
  git(i.arnes, ['rm', '-q', LIST_REL]); commit(i.arnes, 'sin la lista');
  stage(i.arnes, { 'guides/x.md': withName });
  let r = brake(i, { env: { TYCON_HOME: l.tycon } });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  assert.match(r.out, /perfil-equipo\.json/, 'el motivo de siempre: el equipo tiene lista, y sin ella no se mira');
  // --range es de la validación y sigue igual: en la forma publicada no mira con la lista de la máquina
  const named = (n) => ({ [`guides/n${n}.md`]: 'Lo usa AcmeCorp.\n' });
  stage(l.pub, named(1)); commit(l.pub, 'un commit con el término');
  r = pubBrake(l, { args: ['--range', 'HEAD~1..HEAD'] });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
  // la señal está y el freno antes de publicar no: la copia publicada trae los dos, así que es «no pude mirar»
  const guard = 'scripts/hooks/public-push-guard.js';
  fs.renameSync(path.join(l.pub, guard), path.join(l.dir, 'guard.js'));
  stage(l.pub, named(2));
  r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  resetLab(l.pub);
  // el commit que SACA la señal no se saca el freno a sí mismo…
  git(l.pub, ['rm', '-q', MARK_REL]);
  stage(l.pub, named(3));
  r = pubBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/n3\.md:1\b/);
  // …y un árbol que ya no la trae (un laboratorio: sin la señal ni perfil) calla, aunque la máquina declare una lista
  git(l.pub, ['reset', '-q', '--', 'guides/n3.md']); commit(l.pub, 'un laboratorio: sin la señal');
  const lines = jsonl(stateFileOf(l, 'new-names.jsonl')).length;
  stage(l.pub, named(3));
  r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '', 'sin la señal positiva no hay modo nuevo');
  assert.strictEqual(jsonl(stateFileOf(l, 'new-names.jsonl')).length, lines, 'y no deja registro');
});

// i · las dos variables se dicen: la que cambia la lista y la que apaga el freno
test(`${T79} — i · TYCON_PUBLISH_DENYLIST: mira con ésa, lo dice y queda anotado; TYCON_NEW_NAMES=0 apaga y lo dice`, () => {
  const l = publishedLab();
  const other = path.join(l.dir, 'otra-lista.json');
  fs.writeFileSync(other, JSON.stringify({ terminos: [{ patron: 'Globex', categoria: 'cliente', palabra: true }] }));
  // con la de la variable frena lo suyo…
  stage(l.pub, { 'guides/x.md': '# Guía\n\nLo usa Globex.\n' });
  let r = pubBrake(l, { env: { TYCON_PUBLISH_DENYLIST: other } });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/x\.md:3\b/);
  assert.match(r.out, /TYCON_PUBLISH_DENYLIST/, 'lo dice');
  // …y deja pasar lo que la lista de la máquina frenaría: lo dice y queda anotado como escape
  resetLab(l.pub);
  stage(l.pub, { 'guides/x.md': withName });
  r = pubBrake(l, { env: { TYCON_PUBLISH_DENYLIST: other } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /nombres nuevos:[^\n]*TYCON_PUBLISH_DENYLIST/, 'lo dice en cada commit, también cuando pasa');
  assert.strictEqual(r.out.split('\n').filter(Boolean).length, 1, `una línea\n${r.out}`);
  const own = jsonl(stateFileOf(l, 'new-names.jsonl'));
  assert.deepStrictEqual(own.map((x) => x.list), ['env', 'env'], JSON.stringify(own));
  assert.deepStrictEqual(jsonl(stateFileOf(l, 'frenos.jsonl')).map((x) => x.veredicto), ['bloqueo', 'escape']);
  // …con su regla por nombre: el registro de frenos la conoce (si no, saldría como «otra» y no se podría contar)
  assert.deepStrictEqual(jsonl(stateFileOf(l, 'frenos.jsonl')).map((x) => x.regla), ['new-name', 'list-from-env']);
  // apagado: lo dice, no mira (ni con la lista de la máquina) y queda anotado
  r = pubBrake(l, { env: { TYCON_NEW_NAMES: '0' } });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /APAGADO \(TYCON_NEW_NAMES=0\)/);
  assert.deepStrictEqual(jsonl(stateFileOf(l, 'frenos.jsonl')).map((x) => x.veredicto), ['bloqueo', 'escape', 'escape']);
});

// j · el hook de verdad (y todo `git` sobre otro repo, sin las variables que deja un hook)
test(`${T79} — j · git commit de verdad en el clon del público: el commit no se crea (también con -a, desde un árbol enlazado)`, () => {
  const l = publishedLab();
  leaveMaintBehind(l);   // así el freno le pregunta a git por OTRO repo desde adentro del hook
  const before = commitsIn(l.pub);
  // lo preparado
  stage(l.pub, { 'guides/x.md': withName });
  let r = pubCommit(l, l.pub, ['-m', 'un nombre nuevo']);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.strictEqual(commitsIn(l.pub), before, `el commit no se crea\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:4\b[^\n]*\[cliente\]/, 'dice dónde');
  assert.strictEqual((r.out.match(/guides\/x\.md:4\b/g) || []).length, 1, `el hallazgo sale una vez, aunque el hook corra el freno por las dos fuentes\n${r.out}`);
  assert.doesNotMatch(r.out, /AcmeCorp/);
  // el espejo: una línea limpia entra, por el hook entero
  resetLab(l.pub);
  stage(l.pub, { 'guides/x.md': '# Guía\n\nPrimera línea.\nOtra línea limpia.\n' });
  r = pubCommit(l, l.pub, ['-m', 'una línea limpia']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(commitsIn(l.pub), before + 1);
  // `commit -a` desde un árbol enlazado. Con -a git le pasa al hook OTRO índice (sin `git add`, el de siempre no trae el
  // cambio); y en un árbol enlazado le deja GIT_DIR: el freno mira ESTE commit, y al clon de la lista le pregunta sin
  // esas variables (si no, mediría el repo que se commitea: «1 commit atrás» sale del clon de mantenimiento)
  const linked = path.join(l.dir, 'pub-enlazado');
  git(l.pub, ['worktree', 'add', '-q', '-b', 'otra', linked]);
  write(linked, { 'guides/x.md': '# Guía\n\nPrimera línea.\nOtra línea limpia.\nLo usa AcmeCorp.\n' });
  const head = git(linked, ['rev-parse', 'HEAD']);
  r = pubCommit(l, linked, ['-a', '-m', 'commit -a, desde un árbol enlazado']);
  assert.notStrictEqual(r.code, 0, r.out);
  assert.strictEqual(git(linked, ['rev-parse', 'HEAD']), head, `el commit no se crea\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:5\b/);
  assert.match(r.out, /la lista sale de un clon atrasado[^\n]*1 commit\(s\) atrás/, 'midió el clon de mantenimiento, no el que se commitea');
  assert.ok(r.out.includes(fs.realpathSync(l.maint)) || r.out.includes(l.maint), 'y nombra ese clon');
  // los registros quedaron en la máquina del laboratorio
  assert.strictEqual(jsonl(stateFileOf(l, 'new-names.jsonl')).length, 3);
});

// k · en el commit
test(`${T79} — k · la lista de un clon atrasado: el aviso sale junto al veredicto y no lo cambia`, () => {
  // (con el clon al día el freno no avisa: lo miden los casos a y g, que piden la salida vacía o sin esa línea)
  const l = publishedLab();
  // el veredicto con la lista al día, para comparar: el término frena
  stage(l.pub, { 'guides/x.md': withName });
  const fresh = pubBrake(l);
  assert.strictEqual(fresh.code, 1, fresh.out);
  assert.doesNotMatch(fresh.out, /atrasado/, 'al día no avisa');
  leaveMaintBehind(l);
  for (const [what, files, code] of [
    ['frena', { 'guides/x.md': withName }, 1],
    // el término que el remoto sumó y este clon no trajo: con la lista vieja pasa — por eso el aviso
    ['pasa con la lista vieja', { 'guides/x.md': '# Guía\n\nLo usa Globex.\n' }, 0],
  ]) {
    stage(l.pub, files);
    const r = pubBrake(l);
    assert.strictEqual(r.code, code, `${what}: el mismo veredicto que con la lista al día\n${r.out}`);
    assert.match(r.out, /nombres nuevos:[^\n]*la lista sale de un clon atrasado[^\n]*1 commit\(s\) atrás de su rama principal remota, y la lista cambió/, what);
    assert.match(r.out, /git -C "[^"\n]+" pull/, `${what}: cómo ponerlo al día`);
    assert.doesNotMatch(r.out, /adelante|un término más|Globex/, `${what}: ni ramas, ni asuntos, ni términos del repo privado`);
  }
  // una lista ilegible en un clon atrasado: «no pude mirar», y dice que ese clon está atrasado (es lo primero a descartar)
  write(l.maint, { [LIST_REL]: '<<<<<<< un merge a medias\n' });
  const r = pubBrake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar/);
  assert.match(r.out, /clon atrasado/);
});

// k2 · el clon de la lista ADELANTE de su remoto (una excepción commiteada ahí y sin subir, que es la salida que el
// propio freno indica): no está atrasado, y «traé ese clon» no lo arregla. El consejo lo da el freno antes de publicar.
test(`${T79} — k2 · la lista de un clon adelantado: el aviso dice que hay que subirlo, no que hay que traerlo`, () => {
  const l = publishedLab();
  // su rama principal remota, como la conoce el clon, queda en el commit de antes: el clon está UN commit adelante
  git(l.maint, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  write(l.maint, { [LIST_REL]: { ...MACHINE_LIST, terminos: [...MACHINE_LIST.terminos, { patron: 'Globex', categoria: 'cliente', palabra: true }] } });
  git(l.maint, ['add', '-A']); commit(l.maint, 'una entrada propia, sin subir');
  stage(l.pub, { 'guides/x.md': withName });
  const r = pubBrake(l);
  assert.strictEqual(r.code, 1, `el veredicto no cambia\n${r.out}`);
  assert.match(r.out, /nombres nuevos:[^\n]*git -C "[^"\n]+" push/, `dice cómo subirlo\n${r.out}`);
  assert.doesNotMatch(r.out, /clon atrasado|traé ese clon|pull/, `no manda a traer un clon que no está atrás\n${r.out}`);
  assert.doesNotMatch(r.out, /una entrada propia|Globex/, 'ni asuntos ni términos del repo privado');
});

// l · una sola línea por commit
test(`${T79} — l · el pre-commit corre el freno por las dos fuentes: una sola línea, y cada hallazgo una vez`, () => {
  const twice = (l) => [pubBrake(l, { args: ['--source', 'arnes'] }), pubBrake(l, { args: ['--source', 'agent-skills'], env: { TYCON_GUIDES_DIR: l.pub, TYCON_SKILLS_DIR: l.pub } })];
  // hallazgos en las dos mitades del repo: los dice una corrida, cada uno una vez; la otra calla
  let l = publishedLab();
  stage(l.pub, { 'guides/x.md': withName, 'skills/tycon-x/SKILL.md': '# Skill\n\nLo usa AcmeCorp.\n', 'agents/revisor-nucleo.md': agent('revisor-nucleo', 'Revisa lo de Vandelay.') });
  let [a, s] = twice(l);
  assert.strictEqual(a.code, 1, a.out);
  assert.strictEqual(s.code, 0, s.out);
  assert.strictEqual(s.out, '', 'la corrida de agent-skills calla');
  for (const where of [/guides\/x\.md:4\b/g, /skills\/tycon-x\/SKILL\.md:3\b/g, /agents\/revisor-nucleo\.md:\d+/g]) {
    assert.strictEqual(((a.out + s.out).match(where) || []).length, 1, `${where}: una vez\n${a.out}${s.out}`);
  }
  assert.strictEqual(jsonl(stateFileOf(l, 'new-names.jsonl')).length, 1, 'una línea de conteos por commit');
  // sin lista en una máquina del equipo: la línea sale una vez (también si el commit sólo toca la mitad de las skills)
  l = publishedLab({ maintainers: false, team: true });
  stage(l.pub, { 'skills/tycon-x/SKILL.md': '# Skill\n\nLo usa AcmeCorp.\n' });
  [a, s] = twice(l);
  assert.strictEqual(a.code, 0, a.out);
  assert.strictEqual(s.code, 0, s.out);
  assert.strictEqual(((a.out + s.out).match(/esta máquina no tiene la lista privada/g) || []).length, 1, `${a.out}${s.out}`);
});

// m · lo que NO es de este freno: lo mira el freno al empujar
test(`${T79} — m · sólo nombres: un secreto, un correo, un binario o un enlace no son de este freno, y un binario no frena`, () => {
  const l = publishedLab();
  // (armados por partes: este archivo también se publica, y el detector de la copia mira su texto)
  const mail = ['alguien', 'empresa-de-verdad.com.ar'].join('@');
  const machinePath = ['', 'Users', 'alguien', 'proyecto'].join('/');
  write(l.pub, {
    'guides/x.md': ['# Guía', '', `Escribile a ${mail}`, `La ruta: ${machinePath}`, ''].join('\n'),
    'scripts/lib/clave.txt': ['token = ghp', 'a1B2'.repeat(9)].join('_'),
  });
  // un binario que trae los bytes del término, y un enlace cuyo destino lo nombra: no se miran, y no frenan
  fs.writeFileSync(path.join(l.pub, 'guides', 'logo.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('AcmeCorp'), Buffer.from([0, 0])]));
  try { fs.symlinkSync('AcmeCorp-no-existe.md', path.join(l.pub, 'guides', 'enlace.md')); } catch { /* una máquina que no deja crear enlaces: se mide sin él */ }
  git(l.pub, ['add', '-A']);
  let r = pubBrake(l);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out, '');
  // el control: en ese mismo commit, un nombre SÍ frena — y es el único hallazgo (el binario y el enlace no cuentan)
  stage(l.pub, { 'guides/y.md': 'Lo usa AcmeCorp.\n' });
  r = pubBrake(l);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /\(1 hallazgo\(s\)\)/, r.out);
  assert.match(r.out, /guides\/y\.md:1\b/);
});

// n · la forma del árbol es la que el árbol ERA. Si sólo se mirara cómo queda el índice, un commit
// en un clon INTERNO que sacara la lista y agregara la señal caería al modo nuevo y saldría 0; con la forma del árbol previo, sale 2.
test(`${T79} — n · la forma se decide por lo que el árbol era: un commit no cambia de modo trayendo la señal ni sacando la lista`, () => {
  const asTheHook = (repo) => ({ TYCON_GUIDES_DIR: repo, TYCON_SKILLS_DIR: repo });   // el despachador: una sola raíz
  const guide = { 'guides/zz.md': 'Lo usa AcmeCorp.\n' };
  const mark = { [MARK_REL]: { remotes: [] } };
  // 1 · un clon INTERNO (su lista y su perfil): el commit saca la lista —del índice y del disco— y agrega la señal. Sigue
  //     siendo «no pude mirar», también en una máquina del equipo que nombra ESE clon como el que mantiene
  const i = lab();
  const machine = path.join(i.dir, 'tycon');
  write(machine, { 'config.json': { paths: { maintained: i.arnes } }, 'harness/perfil-equipo.json': '{}\n' });
  git(i.arnes, ['rm', '-q', LIST_REL]);
  write(i.arnes, { ...mark, ...guide });
  git(i.arnes, ['add', '-A']);
  let r = brake(i, { env: { TYCON_HOME: machine } });
  assert.strictEqual(r.code, 2, `el commit que saca la lista y trae la señal\n${r.out}`);
  assert.match(r.out, /no pude mirar[^\n]*perfil-equipo\.json/, 'el motivo de siempre');
  // 2 · la lista ya se había borrado en un commit ANTERIOR (ese árbol ya salía 2): agregar la señal no lo vuelve verde
  commit(i.arnes, 'sin la lista (y con la señal)');
  git(i.arnes, ['rm', '-q', MARK_REL]); commit(i.arnes, 'el interno sin lista, como estaba');
  write(i.arnes, { ...mark, 'guides/zz2.md': 'Lo usa AcmeCorp.\n' });
  git(i.arnes, ['add', '-A']);
  r = brake(i);
  assert.strictEqual(r.code, 2, `el commit que sólo trae la señal\n${r.out}`);
  assert.match(r.out, /no pude mirar[^\n]*perfil-equipo\.json/);
  // 3 · un clon del público con una lista YA versionada (alguien la plantó en un commit anterior): «trae lista propia»,
  //     no es la forma publicada y va por el camino de siempre — que ahí no tiene con qué clasificar: no pude mirar
  const l = publishedLab();
  write(l.pub, { [LIST_REL]: { terminos: [{ patron: 'Globex', categoria: 'cliente', palabra: true }] } });
  git(l.pub, ['add', '-A']); commit(l.pub, 'una lista versionada en el clon del público');
  stage(l.pub, guide);
  r = pubBrake(l, { env: asTheHook(l.pub) });
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar[^\n]*allowlist\.json/, 'el camino de siempre');
  assert.ok(jsonl(stateFileOf(l, 'new-names.jsonl')).every((x) => x.form !== 'published'), 'no fue el modo de la forma publicada');
  // …también si esa lista vive en su ruta de antes (la del mapa de renombres; sin mapa no hay ruta vieja)
  const [legacy] = require(NEW_NAMES).legacyPathsOf(LIST_REL);
  if (legacy) {
    resetLab(l.pub);
    fs.mkdirSync(path.dirname(path.join(l.pub, legacy)), { recursive: true });
    git(l.pub, ['mv', LIST_REL, legacy]); commit(l.pub, 'la lista, en su ruta de antes');
    stage(l.pub, guide);
    r = pubBrake(l, { env: asTheHook(l.pub) });
    assert.strictEqual(r.code, 2, `la lista en ${legacy}\n${r.out}`);
    assert.match(r.out, /no pude mirar[^\n]*allowlist\.json/);
  } else console.log('⏭ T79 n: NO MEDIDO — la ruta vieja de la lista (sin el mapa de renombres no hay ninguna)');
  // 4 · en un clon del público, la señal que el commit MUEVE a otra ruta y la «lista» que llega por un renombre no
  //     cambian nada: el árbol era la forma publicada y se mira con la lista de la máquina
  const p = publishedLab();
  git(p.pub, ['mv', MARK_REL, 'scripts/setup/otra.json']);
  git(p.pub, ['mv', 'guides/permitido.md', LIST_REL]);
  stage(p.pub, guide);
  r = pubBrake(p);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /guides\/zz\.md:1\b[^\n]*\[cliente\]/);
});

// ── El perfil del equipo con su nombre actual (team-profile.json): sigue diciendo «este árbol es del equipo» ──────────────
test('NewNames_TeamProfileNewName_StillTeamTree_FindsAndMissingListSaysWhichProfile', () => {
  const l = lab();
  git(l.arnes, ['mv', 'perfil-equipo.json', 'team-profile.json']); commit(l.arnes, 'el perfil con su nombre de hoy');
  // con la lista: mira igual que con el nombre viejo
  stage(l.arnes, { 'guides/x.md': withName });
  let r = brake(l);
  assert.strictEqual(r.code, 1, `con team-profile.json el árbol sigue siendo del equipo y mira\n${r.out}`);
  assert.match(r.out, /guides\/x\.md:\d+[^\n]*AcmeCorp/);
  resetLab(l.arnes);
  // sin la lista: «no pude mirar», nombrando el perfil que el árbol trae
  git(l.arnes, ['rm', '-q', LIST_REL]); commit(l.arnes, 'sin la lista');
  stage(l.arnes, { 'guides/x.md': withName });
  r = brake(l);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /no pude mirar[^\n]*el arnés tiene team-profile\.json/);
});
