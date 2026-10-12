'use strict';

/**
 * third-party-skills.test.js — el manifiesto de las skills de terceros y su control sin red (story 8.5, tanda A).
 *
 * Lo que no se puede perder:
 *   · Que un manifiesto mal formado no pase: una entrada que agrupa carpetas, un commit que es una rama, una licencia
 *     vacía o inventada, una propietaria que se bajaría. Sale 2 nombrando la entrada y el campo.
 *   · Que cada ruta versionada de agent-skills caiga en exactamente un universo, que una declaración muerta o un retiro a
 *     medias se vean, y que un enlace simbólico versionado no pase callado.
 *   · Que el pre-commit de agent-skills frene la skill ajena el día que se copia, y que un commit que no toca esas rutas
 *     no pague nada.
 *
 * Todo con repos de juguete (git de verdad, env de scripts/lib/clean-git-env.js) y manifiestos SINTÉTICOS por
 * --manifest; nunca el real (ése lo mira third-party-real.test.sh). T22 lee la documentación real del arnés.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');
const { resolveSkillsDirs } = require('../lib/skills-dir.js');
const { preCommitHook } = require('./lib/pre-commit-hook.js');

const ROOT = path.resolve(__dirname, '..', '..');
const COVERAGE = path.join(ROOT, 'scripts', 'publishing', 'third-party-coverage.js');
const TREE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);

// ── laboratorio ───────────────────────────────────────────────────────────────────────────────────────────────
function labEnv(extra = {}) {
  return sinGitDelPadre({
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  }, extra);
}
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args], { env: labEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assert.doesNotMatch(d, /tycon-claude-guides|agent-skills|\.claude/, 'el laboratorio no puede vivir bajo una ruta del arnés');
  return d;
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
/** Un agent-skills de juguete con `files` versionados (y `links`: ruta → destino del enlace). */
function toyRepo(files, links = {}, ignore = '') {
  const repo = tmp('third-party-repo-');
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, files);
  for (const [rel, to] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.symlinkSync(to, path.join(repo, rel));
  }
  if (ignore) fs.writeFileSync(path.join(repo, '.gitignore'), ignore);
  git(repo, ['add', '-A', '--force']); // --force: lo escrito se versiona aunque el .gitignore lo cubra (retiro a medias)
  git(repo, ['commit', '-q', '-m', 'lab']);
  return repo;
}
function baseManifest(overrides = {}) {
  return {
    __doc: 'manifiesto de laboratorio',
    retirement: 'pending',
    own: [{ glob: 'skills/zorblax-*', why: 'del equipo de prueba' }, { glob: 'skills/bizuit-sdd', why: 'propia' },
      { glob: 'skills/core/*', why: 'propia' }, { glob: '.gitignore', why: 'del repo' }, { glob: 'README.md', why: 'del repo' }],
    derived: [{ target: 'skills/acme-story', repo: 'agent-skills', based_on: { origin: 'https://example.com/acme/skills' },
      license: 'MIT', license_source: 'LICENSE del repo', copyright: 'Copyright (c) 2026 AcmeCorp', used_by: [], why: 'con cambios del equipo' }],
    origins: { 'acme@bbbbbbbb': { origin: 'https://example.com/acme/skills', commit: COMMIT } },
    third_party: [{
      target: 'skills/acme-helper', from: 'acme@bbbbbbbb', path: 'skills/acme-helper', tree: TREE, omit: [],
      license: 'MIT', license_source: 'LICENSE del repo', copyright: 'Copyright (c) 2026 AcmeCorp',
      install: 'download', used_by: [], why: 'ajena de prueba',
    }],
    ...overrides,
  };
}
function runCoverage(repo, manifest, extraArgs = [], env = {}) {
  const dir = tmp('third-party-manifest-');
  const file = path.join(dir, 'third-party-skills.json');
  fs.writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  const r = spawnSync(process.execPath, [COVERAGE, '--repo', repo, '--manifest', file, ...extraArgs], { env: labEnv(env), encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const EMPTY_REPO_FILES = { 'README.md': '# lab\n', 'skills/zorblax-one/SKILL.md': 'x\n' };

// ── T1 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T1 Manifest_ShapeUniversesOneEntryPerTarget — cada manifiesto inválido sale 2 nombrando entrada y campo; el válido pasa', () => {
  const repo = toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-story/SKILL.md': 's\n' });
  const tp = (patch) => baseManifest({ third_party: [{ ...baseManifest().third_party[0], ...patch }] });
  const invalid = [
    ['una entrada que agrupa dos carpetas', tp({ target: 'skills/acme-{helper,other}' }), /skills\/acme-\{helper,other\}.*target/],
    ['un target lista', tp({ target: ['skills/acme-helper', 'skills/acme-other'] }), /target/],
    ['un origen que es una opción de git', baseManifest({ origins: { 'acme@bbbbbbbb': { origin: '--upload-pack=touch /tmp/pwned', commit: COMMIT } } }), /origins\.acme@bbbbbbbb.*origin/],
    ['un origen sin esquema', tp({ from: undefined, origin: 'example.com/acme/skills', commit: COMMIT }), /skills\/acme-helper.*origin/],
    ['un commit que es una rama', baseManifest({ origins: { 'acme@bbbbbbbb': { origin: 'https://example.com/acme/skills', commit: 'main' } } }), /skills\/acme-helper.*commit/],
    ['una licencia vacía', tp({ license: '' }), /skills\/acme-helper.*license/],
    ['una licencia inventada', tp({ license: 'Libre-Para-Todos' }), /skills\/acme-helper.*license/],
    ['NOASSERTION sin license_source', tp({ license: 'NOASSERTION', license_source: '' }), /skills\/acme-helper.*license_source/],
    ['una propietaria que se bajaría', tp({ license: 'LicenseRef-Proprietary', install: 'download' }), /skills\/acme-helper.*install/],
    ['un install desconocido', tp({ install: 'copiar' }), /skills\/acme-helper.*install/],
    ['un plugin oficial con árbol', tp({ install: 'official-plugin', plugin: 'docs@acme' }), /skills\/acme-helper.*(tree|path)/],
    ['un omit sin motivo', tp({ omit: [{ file: 'x.md' }] }), /skills\/acme-helper.*omit/],
    ['una derivada sin copyright', baseManifest({ derived: [{ ...baseManifest().derived[0], copyright: '' }] }), /skills\/acme-story.*copyright/],
    ['un retiro con otro valor', baseManifest({ retirement: 'mañana' }), /retirement/],
    ['dos entradas con el mismo target', baseManifest({ third_party: [baseManifest().third_party[0], baseManifest().third_party[0]] }), /skills\/acme-helper.*(duplic|repet|dos veces)/i],
    // 2026-10-05: `publish: true` pide que la copia pública la baje aunque nada de lo que sale la use; sólo vale en
    // una entrada que se baja y con licencia libre (MIT o Apache-2.0): en otra, la marca mentiría y se rechaza
    ['un publish que no es booleano', tp({ publish: 'sí' }), /skills\/acme-helper.*publish/],
    ['un publish con licencia sin declarar', tp({ publish: true, license: 'NOASSERTION', license_source: 'ninguna' }), /skills\/acme-helper.*publish/],
    ['un publish en una entrada que no se baja', tp({ publish: true, install: 'retire', path: undefined, tree: undefined, omit: undefined }), /skills\/acme-helper.*publish/],
  ];
  for (const [name, m, re] of invalid) {
    const r = runCoverage(repo, m, ['--skip-content']);
    assert.strictEqual(r.status, 2, `${name}: esperaba 2, salió ${r.status}\n${r.out}`);
    assert.match(r.out, re, `${name}: el mensaje no nombra la entrada y el campo\n${r.out}`);
  }
  const ok = runCoverage(repo, baseManifest(), ['--skip-content']);
  assert.strictEqual(ok.status, 0, ok.out);
  const okPublish = runCoverage(repo, tp({ publish: true }), ['--skip-content']);
  assert.strictEqual(okPublish.status, 0, `publish: true en una libre que se baja es válido\n${okPublish.out}`);
  assert.strictEqual(runCoverage(repo, '{ esto no es json').status, 2);
});

// ── T3 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T3 Coverage_PathWithoutUniverseOrRepeated_Red — sin universo o en dos: 1 nombrándola; las propias, verde; sin red', () => {
  const repo = toyRepo({
    ...EMPTY_REPO_FILES,
    'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-story/SKILL.md': 's\n',
    'skills/bizuit-sdd/SKILL.md': 'b\n', 'skills/core/zorblax-core/SKILL.md': 'c\n',
    'skills/foo/SKILL.md': 'ajena copiada sin declarar\n',
  });
  git(repo, ['remote', 'add', 'origin', 'https://127.0.0.1:9/nadie/agent-skills']);
  const red = runCoverage(repo, baseManifest(), ['--skip-content']);
  assert.strictEqual(red.status, 1, red.out);
  assert.match(red.out, /skills\/foo/);
  assert.doesNotMatch(red.out, /skills\/bizuit-sdd|skills\/core/, 'las propias no son hallazgo');

  const twice = baseManifest({ own: [...baseManifest().own, { glob: 'skills/acme-helper', why: 'error de prueba' }] });
  const r2 = runCoverage(toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-story/SKILL.md': 's\n' }), twice, ['--skip-content']);
  assert.strictEqual(r2.status, 1, r2.out);
  assert.match(r2.out, /skills\/acme-helper.*(own|third_party).*(own|third_party)/);

  const src = fs.readFileSync(COVERAGE, 'utf8');
  assert.doesNotMatch(src, /['"](fetch|clone|ls-remote|pull)['"]|https?\.request|require\(['"]https?['"]\)/, 'el control no abre la red');
});

// ── story 8.7 (AC 10 y 11; pase adversarial de la tanda A) · el repo único y la derivada renombrada ───────────────────
// En la copia de un solo repo el arnés vive en la misma raíz: el control mira sólo lo de agent-skills (skills/, agents/,
// packs/, .agents/, .claude/), no LICENSE, guides/ ni el resto del arnés. Y una derivada declarada por su ruta exacta
// gana sobre un patrón de las propias (la copia publica `tycon-create-story` como `tycon-create-story`, que también cae
// en `skills/tycon-*`): no es «en dos universos».
test('SingleRepo_Coverage_AgentSkillsAreaOnly_DerivedOverOwnGlob', () => {
  const derivada = { ...baseManifest().derived[0], target: 'skills/zorblax-story' };
  const m = baseManifest({ derived: [derivada] });
  const unico = toyRepo({
    ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/zorblax-story/SKILL.md': 's\n',
    'scripts/publishing/third-party-coverage.js': '// el arnés, en la misma raíz\n', 'LICENSE': 'Apache\n', 'guides/x.md': '# guía\n',
  });
  const ok = runCoverage(unico, m, ['--skip-content']);
  assert.strictEqual(ok.status, 0, `el repo único con el arnés en la raíz y la derivada bajo un patrón propio: ${ok.out}`);
  const ajena = toyRepo({
    ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/zorblax-story/SKILL.md': 's\n', 'skills/foo/SKILL.md': 'ajena\n',
    'scripts/publishing/third-party-coverage.js': '// el arnés\n', 'LICENSE': 'Apache\n',
  });
  const r = runCoverage(ajena, m, ['--skip-content']);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /skills\/foo/, 'lo de agent-skills se sigue mirando');
  assert.doesNotMatch(r.out, /LICENSE/, 'lo del arnés no');
  // sin el arnés en la raíz (el agent-skills de siempre), un archivo suelto sigue siendo un hallazgo
  const interno = toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/zorblax-story/SKILL.md': 's\n', 'guides/x.md': '# guía\n' });
  const r3 = runCoverage(interno, m, ['--skip-content']);
  assert.strictEqual(r3.status, 1, r3.out);
  assert.match(r3.out, /guides\/x\.md/);
});

// ── story 8.18 (AC 26, T26) · el repo unido del equipo, con el retiro hecho ─────────────────────────────────────────
// El arnés y agent-skills son un repo: los destinos del manifiesto se resuelven contra la raíz que trae skills/, y el
// retiro se juzga con el .gitignore de ESA raíz (el unido). Sin --repo, la raíz sale de TYCON_SKILLS_DIR, que puede
// nombrar el clon o su carpeta skills/. (Verde de entrada: el control ya miraba sólo el área de agent-skills desde la
// story 8.7; estos casos lo dejan atado al repo unido.)
test('Unified_Coverage_RetirementDone_TargetsAgainstTheSameRoot — T26: en el repo unido el retiro se juzga contra su propio árbol y su .gitignore', () => {
  const manifest = baseManifest({ retirement: 'done',
    own: [...baseManifest().own, { glob: 'agents/*.md', why: 'los revisores, propios' }, { glob: 'skills/tycon-*', why: 'del equipo' }] });
  const files = {
    ...EMPTY_REPO_FILES, 'skills/acme-story/SKILL.md': 's\n', 'skills/tycon-pipeline/SKILL.md': 'p\n', 'agents/lab-reviewer.md': '# revisor\n',
    'scripts/publishing/third-party-coverage.js': '// el arnés, en la misma raíz\n', 'guides/x.md': '# guía\n', 'perfil-equipo.json': '{}\n',
  };
  // el destino ajeno, retirado e ignorado por el .gitignore de la raíz: verde, y lo del arnés ni se mira
  const unified = toyRepo(files, {}, 'skills/acme-helper/\n');
  const ok = runCoverage(unified, manifest);
  assert.strictEqual(ok.status, 0, ok.out);
  // lo mismo sin --repo: la raíz sale de TYCON_SKILLS_DIR, dada como el clon o como su carpeta skills/
  const dir = tmp('third-party-manifest-');
  const file = path.join(dir, 'third-party-skills.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  for (const given of [unified, path.join(unified, 'skills')]) {
    const r = spawnSync(process.execPath, [COVERAGE, '--manifest', file], { env: labEnv({ TYCON_SKILLS_DIR: given }), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `TYCON_SKILLS_DIR=${given}: ${r.stdout}${r.stderr}`);
  }
  // sin su línea en el .gitignore de la raíz: el retiro está incompleto
  const noIgnore = runCoverage(toyRepo(files), manifest);
  assert.strictEqual(noIgnore.status, 1, noIgnore.out);
  assert.match(noIgnore.out, /skills\/acme-helper: retiro incompleto — no está en el \.gitignore/);
  // vuelta a versionar dentro de skills/ del repo unido: el retiro está incompleto, y se nombra
  const again = runCoverage(toyRepo({ ...files, 'skills/acme-helper/SKILL.md': 'h\n' }, {}, 'skills/acme-helper/\n'), manifest);
  assert.strictEqual(again.status, 1, again.out);
  assert.match(again.out, /skills\/acme-helper: retiro incompleto — el retiro está hecho y todavía está versionado/);
  assert.doesNotMatch(again.out, /guides\/x\.md|perfil-equipo/, 'lo del arnés no es asunto de este control');
});

// ── T4 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T4 Coverage_DeadDeclarationAndIncompleteRetirement — tres salidas 1, cada una con su motivo', () => {
  // retiro pendiente, destino no versionado → declaración muerta
  const r1 = runCoverage(toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-story/SKILL.md': 's\n' }), baseManifest(), ['--skip-content']);
  assert.strictEqual(r1.status, 1, r1.out);
  assert.match(r1.out, /skills\/acme-helper.*declaración muerta/);
  // retiro hecho, destino todavía versionado
  const done = baseManifest({ retirement: 'done' });
  const r2 = runCoverage(toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-story/SKILL.md': 's\n' }, {}, 'skills/acme-helper/\n'), done, ['--skip-content']);
  assert.strictEqual(r2.status, 1, r2.out);
  assert.match(r2.out, /skills\/acme-helper.*retiro incompleto.*versionad/);
  // retiro hecho, destino fuera del árbol pero sin ignorar
  const r3 = runCoverage(toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-story/SKILL.md': 's\n' }), done, ['--skip-content']);
  assert.strictEqual(r3.status, 1, r3.out);
  assert.match(r3.out, /skills\/acme-helper.*retiro incompleto.*\.gitignore/);
  // control: retiro hecho, fuera del árbol e ignorado → verde
  const r4 = runCoverage(toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-story/SKILL.md': 's\n' }, {}, 'skills/acme-helper/\n'), done, ['--skip-content']);
  assert.strictEqual(r4.status, 0, r4.out);
});

// ── Regresiones del pase adversarial (tanda A): cómo se decide «está en el .gitignore» y los `links` ─────────────
test('adv-E Coverage_IgnoreCheck_FolderWithDotAndOnlyTheRepoGitignore — carpeta con punto ignorada = verde; un *.md o un exclude ajeno no cuentan', () => {
  const dotted = baseManifest({ retirement: 'done', third_party: [{ ...baseManifest().third_party[0], target: 'skills/next.js', path: 'skills/next.js' }] });
  const files = { ...EMPTY_REPO_FILES, 'skills/acme-story/SKILL.md': 's\n' };
  assert.strictEqual(runCoverage(toyRepo(files, {}, 'skills/next.js/\n'), dotted, ['--skip-content']).status, 0, 'una carpeta con punto, ignorada con patrón de carpeta');
  const done = baseManifest({ retirement: 'done' });
  const r1 = runCoverage(toyRepo(files, {}, '*.md\n'), done, ['--skip-content']);
  assert.strictEqual(r1.status, 1, `un *.md no ignora la carpeta de la skill\n${r1.out}`);
  assert.match(r1.out, /skills\/acme-helper.*\.gitignore/);
  const viaExclude = toyRepo(files);
  fs.writeFileSync(path.join(viaExclude, '.git', 'info', 'exclude'), 'skills/acme-helper/\n');
  assert.strictEqual(runCoverage(viaExclude, done, ['--skip-content']).status, 1, 'el exclude local de UNA máquina no es el .gitignore del repo');
});

test('adv-G Links_DuplicatedOrRegularFile — el mismo enlace en dos entradas sale 2; un archivo común donde se declaró un enlace sale 1', () => {
  const two = baseManifest({ third_party: [
    { ...baseManifest().third_party[0], links: ['.claude/skills/y'] },
    { ...baseManifest().third_party[0], target: 'skills/acme-other', path: 'skills/acme-other', links: ['.claude/skills/y'] },
  ] });
  const files = { ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-other/SKILL.md': 'o\n', 'skills/acme-story/SKILL.md': 's\n' };
  const r = runCoverage(toyRepo(files), two, ['--skip-content']);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /\.claude\/skills\/y.*(dos|duplic)/);
  const one = baseManifest({ third_party: [{ ...baseManifest().third_party[0], links: ['.claude/skills/y'] }] });
  const regular = runCoverage(toyRepo({ ...files, '.claude/skills/y': 'no soy un enlace\n' }), one, ['--skip-content']);
  assert.strictEqual(regular.status, 1, regular.out);
  assert.match(regular.out, /\.claude\/skills\/y.*no es un enlace/);
});

// ── T5 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T5 Links_VersionedAnywhere_Red — un enlace sin declarar sale 1; el declarado con retiro pendiente se informa', () => {
  const files = { ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-story/SKILL.md': 's\n', 'docs/readme.md': 'd\n' };
  const m = baseManifest({
    own: [...baseManifest().own, { glob: 'docs/*', why: 'prueba' }],
    third_party: [{ ...baseManifest().third_party[0], links: ['.claude/skills/y'] }],
  });
  const repo = toyRepo(files, { 'docs/x': '../README.md', '.claude/skills/y': '../../skills/acme-helper', 'skills/z': '../../.agents/skills/z' });
  const r = runCoverage(repo, m, ['--skip-content']);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /docs\/x/);
  assert.match(r.out, /skills\/z/);
  assert.match(r.out, /\.claude\/skills\/y/, 'el declarado se informa');
  const onlyDeclared = toyRepo(files, { '.claude/skills/y': '../../skills/acme-helper' });
  const r2 = runCoverage(onlyDeclared, m, ['--skip-content']);
  assert.strictEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /\.claude\/skills\/y/);
});

// ── AC 5 (con contenido): el árbol declarado es el de hoy ───────────────────────────────────────────────────────
test('T5b Coverage_ContentByTree — con el retiro pendiente, un árbol distinto sale 1 nombrando entrada y archivo', () => {
  const repo = toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-helper/ref.md': 'r\n', 'skills/acme-story/SKILL.md': 's\n' });
  const tree = git(repo, ['rev-parse', 'HEAD:skills/acme-helper']);
  const m = baseManifest({ third_party: [{ ...baseManifest().third_party[0], tree }] });
  assert.strictEqual(runCoverage(repo, m).status, 0);
  write(repo, { 'skills/acme-helper/ref.md': 'tocado\n' });
  git(repo, ['commit', '-q', '-am', 'toco una ajena']);
  const r = runCoverage(repo, m);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /skills\/acme-helper/);
  assert.match(r.out, /ref\.md/);
});

// ── T6 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T6 AgentSkillsPreCommit_StopsForeignCopy — frena la skill ajena copiada; un commit fuera de esas rutas no corre el control', () => {
  // el guion de agent-skills según el layout: en la copia pública de un solo repo es `pre-commit-skills`, no el despachador
  const hook = preCommitHook('skills', resolveSkillsDirs().repo);
  assert.ok(fs.existsSync(hook), `no encontré el pre-commit de agent-skills en ${hook}`);
  // un arnés de laboratorio: sólo el control y un manifiesto sintético (sin el freno de nombres: el hook avisa y sigue)
  const lab = tmp('third-party-harness-');
  fs.mkdirSync(path.join(lab, 'scripts', 'publishing'), { recursive: true });
  fs.copyFileSync(COVERAGE, path.join(lab, 'scripts', 'publishing', 'third-party-coverage.js'));
  const manifestPath = path.join(lab, 'scripts', 'publishing', 'third-party-skills.json');
  fs.writeFileSync(manifestPath, JSON.stringify(baseManifest({ own: [...baseManifest().own, { glob: 'notes/*', why: 'prueba' }] }), null, 2));
  const repo = toyRepo({ ...EMPTY_REPO_FILES, 'skills/acme-helper/SKILL.md': 'h\n', 'skills/acme-story/SKILL.md': 's\n' });
  fs.mkdirSync(path.join(repo, '.githooks'), { recursive: true });
  fs.copyFileSync(hook, path.join(repo, '.githooks', 'pre-commit'));
  fs.chmodSync(path.join(repo, '.githooks', 'pre-commit'), 0o755);
  const commitWithHook = (msg) => {
    const t0 = Date.now();
    const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=.githooks', 'commit', '-q', '-m', msg],
      { env: labEnv({ TYCON_GUIDES_DIR: lab }), encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
  };
  git(repo, ['add', '.githooks']);
  git(repo, ['commit', '-q', '-m', 'hook']);

  write(repo, { 'skills/foo/SKILL.md': 'ajena copiada\n' });
  git(repo, ['add', 'skills/foo']);
  const r1 = commitWithHook('copio una ajena');
  assert.strictEqual(r1.status, 1, r1.out);
  assert.match(r1.out, /skills\/foo/);
  assert.ok(r1.ms < 1000, `el control tardó ${r1.ms} ms`);
  git(repo, ['reset', '-q', '--hard', 'HEAD']);
  fs.rmSync(path.join(repo, 'skills', 'foo'), { recursive: true, force: true });

  // un enlace simbólico stageado FUERA de esas rutas también dispara el control (AC 9), y sin declarar frena
  fs.mkdirSync(path.join(repo, 'notes'), { recursive: true });
  fs.symlinkSync('../README.md', path.join(repo, 'notes', 'link'));
  git(repo, ['add', 'notes/link']);
  const rLink = commitWithHook('un enlace en notas');
  assert.strictEqual(rLink.status, 1, rLink.out);
  assert.match(rLink.out, /notes\/link.*enlace/);
  git(repo, ['reset', '-q', '--hard', 'HEAD']);

  // si el control corriera, este manifiesto ilegible frenaría el commit: pasar prueba que no corrió
  fs.writeFileSync(manifestPath, '{ roto');
  write(repo, { 'notes/today.md': 'n\n' });
  git(repo, ['add', 'notes']);
  const r2 = commitWithHook('sólo notas');
  assert.strictEqual(r2.status, 0, r2.out);
  assert.ok(r2.ms < 1000, `el commit sin rutas de skills tardó ${r2.ms} ms`);

  // si el git que pregunta «¿qué toca este commit?» falla, el control corre igual (con el manifiesto roto, frena):
  // un git de mentira que falla sólo en `diff --cached` y delega todo lo demás en el de verdad. El hook se corre
  // directo (no desde `git commit`): git antepone su propia carpeta al PATH de sus hooks y el de mentira no se vería.
  const realGit = spawnSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).stdout.trim();
  const fakeBin = tmp('third-party-fakegit-');
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--cached" ] && { echo "fatal: de mentira" >&2; exit 128; }; done\nexec "${realGit}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'git'), 0o755);
  write(repo, { 'notes/tomorrow.md': 'n\n' });
  git(repo, ['add', 'notes']);
  const r3 = spawnSync('bash', [path.join(repo, '.githooks', 'pre-commit')],
    { cwd: repo, env: labEnv({ TYCON_GUIDES_DIR: lab, PATH: `${fakeBin}:${process.env.PATH}` }), encoding: 'utf8' });
  assert.strictEqual(r3.status, 1, `con git fallando, el control tenía que correr (y frenar por el manifiesto roto): ${r3.stdout}${r3.stderr}`);
  assert.match(`${r3.stdout}${r3.stderr}`, /no pude mirar|third-party-coverage/);
});

// ── T22 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('T22 Docs_PointToManifest — cada guía nombra el manifiesto; INSTALL ya no manda a copiar tal cual; BMAD sin versión propia', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const rel of ['guides/bmad-contract.md', 'INSTALL.md', 'guides/publicacion-espejo.md', 'guides/piezas-del-arnes.md', 'README.md']) {
    assert.match(read(rel), /third-party-skills\.json/, `${rel} no nombra el manifiesto`);
  }
  assert.doesNotMatch(read('INSTALL.md'), /copiarla tal cual/);
  const bmad = read('guides/bmad-contract.md');
  const paragraphs = bmad.split(/\n\s*\n/).filter((p) => /third-party-skills\.json/.test(p));
  for (const p of paragraphs) assert.doesNotMatch(p, /\b\d+\.\d+\.\d+\b/, `bmad-contract.md afirma una versión junto al manifiesto: ${p.slice(0, 160)}`);
  assert.match(read('guides/publicacion-espejo.md'), /^#+ .*Las skills de terceros/m);
});
