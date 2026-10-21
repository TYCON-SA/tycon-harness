'use strict';
/**
 * team-stories-templates.test.js — las plantillas genéricas del repo de stories de un equipo nuevo (T44).
 * Viven en el núcleo (`scripts/setup/harness/team-stories/`) y las usa `harness.js team-init`. Lo que se mide:
 *   - están todas: las comunes y el portón de cada plataforma;
 *   - no nombran ningún producto (las de productos BIZUIT viven en el perfil del equipo de TYCON);
 *   - cada marcador `{{…}}` es uno de los que `team-init` sabe llenar (`STORIES_MARKERS`): uno que no está quedaría
 *     escrito tal cual en el repo de la persona;
 *   - el portón de GitHub pasa las reglas que valen para cualquier workflow de un repo público
 *     (`check-public-workflow.js`): sin `pull_request_target`, sin secretos, acciones por sha y sólo `contents: read`.
 * Correr: node --test scripts/tests/team-stories-templates.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts', 'setup', 'harness', 'team-stories');
const COMMON = ['CLAUDE.md', 'README.md', 'specs-README.md', 'githooks-pre-commit', 'tycon-advisors.yaml'];
const PLATFORM = { azure: ['azure/stories-gate.yml', 'azure/tycon-ado-config.yaml'], github: ['github/stories-gate.yml'] };
const ALL = [...COMMON, ...PLATFORM.azure, ...PLATFORM.github];
// palabras de un producto: nada de esto entra en una plantilla para un equipo cualquiera (el nombre del producto, armado
// por partes: el núcleo no lo escribe entero)
const PRODUCT = new RegExp(`\\b${'biz' + 'uit'}\\b|\\bplugins?\\b|formularios?|\\.cs\\b|\\bproductos?\\b|\\{\\{PRODUCT|BACKEND_REPO|FORMS_REPO`, 'i');

test('T44 TeamStoriesTemplates_AllPresent — las comunes y el portón de cada plataforma', () => {
  const missing = ALL.filter((f) => !fs.existsSync(path.join(DIR, f)));
  assert.deepStrictEqual(missing, [], `faltan: ${missing.join(', ')}`);
  assert.ok(fs.statSync(path.join(DIR, 'githooks-pre-commit')).mode & 0o111, 'githooks-pre-commit es ejecutable');
});

test('T44 TeamStoriesTemplates_Generic_NoProductNames — ninguna nombra un producto', () => {
  const hits = ALL.flatMap((f) => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')
    .map((l, i) => (PRODUCT.test(l) ? `${f}:${i + 1}: ${l.trim()}` : null)).filter(Boolean));
  assert.deepStrictEqual(hits, [], `nombran un producto:\n${hits.join('\n')}`);
});

test('T44 TeamStoriesTemplates_MarkersAreFilledByTeamInit — cada marcador lo llena team-init', () => {
  const { STORIES_MARKERS } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team-init.js'));
  assert.ok(Array.isArray(STORIES_MARKERS) && STORIES_MARKERS.length > 0, 'team-init exporta STORIES_MARKERS');
  const unknown = [];
  for (const f of ALL) {
    for (const m of fs.readFileSync(path.join(DIR, f), 'utf8').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
      if (!STORIES_MARKERS.includes(m[1])) unknown.push(`${f}: {{${m[1]}}}`);
    }
  }
  assert.deepStrictEqual(unknown, [], `marcadores que team-init no llena: ${unknown.join(', ')}`);
  // el de GitHub no trae marcadores de Azure, y al revés
  const gh = fs.readFileSync(path.join(DIR, 'github', 'stories-gate.yml'), 'utf8');
  assert.ok(!/\{\{ADO_/.test(gh), 'el portón de GitHub no lleva marcadores de Azure DevOps');
});

// el hook de pre-commit del repo de historias, corrido de verdad en un repo de juguete:
// una story con el frontmatter roto no entra ni renombrada, ni con tildes en el nombre, ni con espacios
test('T44 TeamStoriesTemplates_PreCommitHook_CatchesRenamedAccentedAndSpacedStories', (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('NO MEDIDO: sin git en esta máquina');
  const os = require('os');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stories-hook-'));
  const gitEnv = Object.assign({}, process.env, { GIT_AUTHOR_DATE: '2026-10-16T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-16T12:00:00Z' });   // fecha fija: nada depende del reloj
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { encoding: 'utf8', env: gitEnv });
  const story = (rel, id, status) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), `---\nepic: 1\nstory: "${id}"\ntitle: x\nstatus: ${status}\n---\n# cuerpo\n`); };
  const hook = () => spawnSync('bash', [path.join(DIR, 'githooks-pre-commit')], { cwd: repo, encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_GUIDES_DIR: ROOT }) });
  try {
    git('init', '-q', '-b', 'main');
    story('.specs/story-1.1.md', '1.1', 'draft');
    git('add', '-A'); git('commit', '-q', '-m', 'inicio');
    const cases = [
      ['control: la misma story rota, sin renombrar', () => story('.specs/story-1.1.md', '1.1', '[draft')],
      ['renombrada y rota', () => { git('mv', '.specs/story-1.1.md', '.specs/story-1.3.md'); story('.specs/story-1.3.md', '1.3', '[draft'); }],
      ['con tildes en el nombre', () => story('.specs/story-1.4-migración.md', '1.4', '[draft')],
      ['con espacios en el nombre', () => story('.specs/story 1.5.md', '1.5', '[draft')],
    ];
    for (const [what, make] of cases) {
      git('reset', '-q', '--hard'); git('clean', '-qfd');
      make(); git('add', '-A');
      const r = hook();
      assert.strictEqual(r.status, 1, `${what}: el hook tenía que rechazar el commit (salió ${r.status}): ${(r.stdout + r.stderr).slice(-300)}`);
    }
    git('reset', '-q', '--hard'); git('clean', '-qfd');
    story('.specs/story 1.6 válida.md', '1.6', 'draft'); git('add', '-A');
    assert.strictEqual(hook().status, 0, 'una story válida con espacios y tildes en el nombre pasa');
    // un `git diff --cached` que falla no deja pasar el commit sin revisar
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'team-stories-git-'));
    try {
      fs.writeFileSync(path.join(fake, 'git'), '#!/bin/sh\necho "fatal: roto a propósito" >&2\nexit 128\n', { mode: 0o755 });
      const r = spawnSync('bash', [path.join(DIR, 'githooks-pre-commit')], { cwd: repo, encoding: 'utf8', env: Object.assign({}, process.env, { TYCON_GUIDES_DIR: ROOT, PATH: `${fake}${path.delimiter}${process.env.PATH}` }) });
      assert.strictEqual(r.status, 1, `con git diff roto el hook sale 1 (salió ${r.status}): ${r.stderr}`);
      assert.match(r.stderr, /no pude leer qué trae el commit/);
    } finally { fs.rmSync(fake, { recursive: true, force: true }); }
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('T44 TeamStoriesTemplates_GithubGate_PublicWorkflowRules — las reglas de cualquier workflow público', () => {
  const { check } = require(path.join(ROOT, 'scripts', 'ci', 'check-public-workflow.js'));
  const text = fs.readFileSync(path.join(DIR, 'github', 'stories-gate.yml'), 'utf8');
  const generic = ['pull-request-target', 'secrets', 'uses-by-sha', 'permissions'];
  const broken = check(text).filter((b) => generic.includes(b.rule));
  assert.deepStrictEqual(broken, [], broken.map((b) => `${b.rule}: ${b.detail}`).join('\n'));
  assert.match(text, /GATE="\$\{TCG\}\/scripts\/ci\/tycon-ci-gate\.js"/, 'el portón es el del arnés público clonado');
  assert.match(text, /node "\$\{GATE\}" --repo "\$\{GITHUB_WORKSPACE\}" --base "origin\/\$\{BASE\}"/, 'corre el portón contra la rama destino del pedido');
  assert.match(text, /^on:\n {2}pull_request:/m, 'corre en los pedidos');
  // Actions corre los pasos con `bash -e`: el código de gitleaks se captura sin cortar el paso, así un hallazgo se muestra
  // antes del rojo
  assert.match(text, /2>&1\) && RC=0 \|\| RC=\$\?/, 'el código de gitleaks se captura sin que bash -e corte el paso');
  assert.ok(!/^\s*RC=\$\?\s*$/m.test(text), 'ningún RC=$? suelto después de una sustitución que puede salir distinto de 0');
  // el espejo: la misma plantilla con un secreto sale rota en la regla `secrets`
  assert.ok(check(`${text}\n# \${{ secrets.X }}\n`).some((b) => b.rule === 'secrets'), 'el control ve un secreto agregado');
});
