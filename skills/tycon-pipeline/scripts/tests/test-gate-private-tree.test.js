#!/usr/bin/env node
/**
 * test-gate-private-tree.test.js — el portón mide el repo privado ADELGAZADO sobre el árbol armado.
 *
 * El privado adelgazado (`.tycon/internal-forms.json` con `layout: thin` y `scripts/ci/overlay-harness.js`) no trae lo
 * que es del público. Medido solo, sus suites de `agent-skills` corrían sobre el arnés INSTALADO
 * (`~/.claude/agent-skills`): el verde no decía nada de la rama (medido sobre el privado real: 21 rojas y 241 ausentes). Ahora el
 * portón arma el árbol en una carpeta temporal —un clon del privado, sus cambios del disco y el público de la rama
 * debajo— y corre ahí sólo las suites que leen lo tocado.
 *
 * Cada prueba arma un laboratorio de dos repos git efímeros (`Priv` y `Pub`, hermanos) y una HOME de juguete con un
 * `~/.claude/agent-skills` propio. El guion de superposición del privado es de juguete (el real vive en el repo privado
 * y no viaja): hace lo mismo que el de verdad en lo que el portón usa —pone el público encima, deja un commit local y
 * escribe su informe—. El humo de la story corre el de verdad sobre el privado real.
 *
 * Correr: env -u NODE_TEST_CONTEXT node --test skills/tycon-pipeline/scripts/tests/test-gate-private-tree.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const TEST_GATE = path.join(SCRIPTS, 'test-gate.sh');

const DEL_ENTORNO = ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'DOD_BYPASS',
  'TYCON_TEST_SCOPE', 'TYCON_TEST_GATE', 'TYCON_TEST_GATE_COMPANION', 'TYCON_TEST_GATE_PART', 'TYCON_EVIDENCE_DIR',
  'TYCON_EVIDENCE_KEY', 'TYCON_EVIDENCE_KEY_FAILED', 'TYCON_COVERAGE_BASE', 'STOP_AUTONOMY', 'TYCON_SKILLS_DIR',
  'HARNESS_TEAM_DIR', 'TYCON_PRIVATE_TREE_TMP', 'TYCON_SUITE_HOMES_ROOT', 'TF_BUILD', 'TYCON_HOME'];

function entorno(home, extra) {
  const env = { ...process.env };
  for (const k of DEL_ENTORNO) delete env[k];
  // fechas fijas en los commits del laboratorio: la misma historia en cada corrida. La casa del arnés es del
  // laboratorio (y USERPROFILE también): en Windows la carpeta de usuario no sale de HOME, y sin esto se leería la
  // configuración de quien corre la prueba.
  return { ...env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon-del-laboratorio'), GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@lab', GIT_COMMITTER_NAME: 'lab',
    GIT_COMMITTER_EMAIL: 'lab@lab', GIT_AUTHOR_DATE: '2026-10-19T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T12:00:00Z',
    ...(extra || {}) };
}
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: entorno(os.homedir()) }).trim();
}
function escribir(raiz, rel, texto) {
  const abs = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, texto);
  return abs;
}
function repoGit(dir, archivos) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, texto] of Object.entries(archivos)) escribir(dir, rel, texto);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const tmp = (pre) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));

// El guion de superposición de juguete: el mismo contrato de línea de comandos que scripts/ci/overlay-harness.js
// --after-cut. Pone el público encima (lo que el privado ya tiene gana: es su forma propia), deja un commit local y
// escribe su informe. Con --team-from copia el perfil del equipo, como el de verdad.
const OVERLAY_DE_JUGUETE = `#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
if (!a.includes('--after-cut')) { console.error('sólo --after-cut'); process.exit(2); }
const repo = opt('--repo'), from = opt('--from'), report = opt('--report'), team = opt('--team-from');
if (process.env.LAB_OVERLAY_FAILS) { console.error('el público no coincide: ' + process.env.LAB_OVERLAY_FAILS); process.exit(1); }
if (!fs.existsSync(path.join(from, 'version.json'))) { console.error('no pude traer el arnés de GitHub: no trae version.json'); process.exit(1); }
const added = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (r === '.git' || r === 'version.json') continue;
    if (e.isDirectory()) { walk(r); continue; }
    if (fs.existsSync(path.join(repo, r))) continue;
    fs.mkdirSync(path.dirname(path.join(repo, r)), { recursive: true });
    fs.copyFileSync(path.join(from, r), path.join(repo, r));
    added.push(r);
  }
})('');
if (team) fs.copyFileSync(path.join(team, 'team-profile.json'), path.join(repo, 'team-profile.json'));
execFileSync('git', ['-C', repo, 'add', '-A', '-f']);
execFileSync('git', ['-C', repo, '-c', 'user.name=lab', '-c', 'user.email=lab@lab', 'commit', '-q', '--allow-empty', '-m', 'superposición local (no se empuja)']);
if (report) fs.writeFileSync(report, JSON.stringify({ mode: 'after-cut', layout: 'thin', added, team: team || null }) + '\\n');
console.log('superpuse lo público sobre el repo adelgazado: ' + added.length + ' del público que entran');
`;

// Una suite de agent-skills que prueba la skill de juguete: sale 0 si `lib.js` devuelve 1.
const SUITE_SKILL = "const v = require('../lib.js')(); if (v !== 1) { console.error('la skill devolvió ' + v); process.exit(1); } console.log('ok skill');\n";
const SKILL_SANA = 'module.exports = () => 1;\n';
const SKILL_ROTA = 'module.exports = () => 2;\n';

const STORY = (modificar) => ['---', 'epic: 9', 'story: "9.36"', 'title: "laboratorio del privado adelgazado"',
  'status: in-progress', 'files_to_create: []', 'files_to_modify:', ...modificar.map((x) => `  - ${x}`), '---', '',
  '# Story 9.36', ''].join('\n');

/**
 * El laboratorio: `Priv` (adelgazado: su lista, su guion de superposición, su suites.json que nombra suites del público)
 * y `Pub` (el público: version.json, una skill con su suite y un guion con la suya). `home`: una HOME de juguete con un
 * `~/.claude/agent-skills` cuya skill es `instalada` (sana por defecto).
 */
function laboratorio({ instalada = SKILL_SANA, conSkills = true, declarar = true, modificar } = {}) {
  const raiz = tmp('privado-lab-');
  const suites = [
    { raiz: 'agent-skills', ruta: 'demo/tests/demo.test.js', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/pub-lib.test.js', requiere: [] },
    { raiz: 'arnes', ruta: 'tests/otra.test.js', requiere: [] },
  ];
  const pub = repoGit(path.join(raiz, 'Pub'), {
    'version.json': '{ "version": "2026.10.19.1" }\n',
    ...(conSkills ? { 'skills/demo/lib.js': SKILL_SANA, 'skills/demo/tests/demo.test.js': SUITE_SKILL } : {}),
    'scripts/lib/pub-lib.js': 'module.exports = 1;\n',
    'scripts/tests/pub-lib.test.js': "if (require('../lib/pub-lib.js') !== 1) process.exit(1); console.log('ok pub-lib');\n",
    'scripts/lib/otra.js': 'module.exports = 1;\n',
    'scripts/tests/otra.test.js': "if (require('../lib/otra.js') !== 1) process.exit(1); console.log('ok otra');\n",
  });
  const priv = repoGit(path.join(raiz, 'Priv'), {
    '.tycon/internal-forms.json': '{ "layout": "thin", "own": {}, "mirror": {} }\n',
    'scripts/ci/overlay-harness.js': OVERLAY_DE_JUGUETE,
    'scripts/tests/suites.json': JSON.stringify({ diarias: suites }, null, 2) + '\n',
    'specs/s.md': STORY(modificar || ['Pub/skills/demo/lib.js']),
    ...(declarar ? { '.tycon/advisors.yaml': 'evidence:\n  companion_repos:\n    - ../Pub\n' } : {}),
    '.gitignore': '.advisors/\n',
  });
  const home = tmp('privado-home-');
  escribir(home, '.claude/agent-skills/skills/demo/lib.js', instalada);
  escribir(home, '.claude/agent-skills/skills/demo/tests/demo.test.js', SUITE_SKILL);
  return { raiz, pub, priv, home, story: path.join(priv, 'specs', 's.md') };
}

function portón(lab, extra) {
  const r = spawnSync('bash', [TEST_GATE, lab.priv, lab.story], { encoding: 'utf8', cwd: lab.priv,
    env: entorno(lab.home, { TYCON_PRIVATE_TREE_TMP: path.join(lab.raiz, 'tmp'), ...(extra || {}) }), timeout: 120000 });
  fs.mkdirSync(path.join(lab.raiz, 'tmp'), { recursive: true });
  const salida = `${r.stdout}\n${r.stderr}`;
  let resumen = null;
  // el informe que deja el portón: lo que lee el revisor de cobertura
  try {
    const art = JSON.parse(fs.readFileSync(path.join(lab.priv, '.advisors', 'tests-result.json'), 'utf8'));
    const t = art.totals || {};
    resumen = { ausentes: t.missing_paths || [], deferred_suites: t.deferred_suites || [], art };
  } catch (_e) { resumen = null; }
  return { code: r.status, salida, resumen };
}
// una suite corrió si el corredor la anotó (`ok`/`FALLA` con su nombre) en la salida
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nombra = (r, nombre) => new RegExp(`^(ok {7}|ROJO\\(\\d+\\) ).*${esc(nombre)}`, 'm').test(r.salida);
const temporalesVivas = (lab) => { try { return fs.readdirSync(path.join(lab.raiz, 'tmp')); } catch (_e) { return []; } };

// ── El árbol armado ────────────────────────────────────────────────────────────────────────────────────────────

test('PrivateTree_Detected_BuildsOverlay @story-7.36 @ac-1', () => {
  const lab = laboratorio({ modificar: ['Pub/skills/demo/lib.js', 'Pub/scripts/lib/pub-lib.js'] });
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  const r = portón(lab);
  assert.match(r.salida, /árbol armado/, r.salida);
  assert.ok(nombra(r, 'pub-lib.test.js'), `la suite del público corrió en el árbol\n${r.salida}`);
  assert.ok(!(r.resumen.ausentes || []).some((a) => a.includes('pub-lib')), r.salida);
});

test('PrivateTree_UsesStoryBranchPublic @story-7.36 @ac-2', () => {
  const lab = laboratorio();
  // un worktree del público en la rama de la story (el número de la story en el nombre de la rama)
  git(lab.priv, 'checkout', '-q', '-b', 'story/9.36-lab');
  const wt = path.join(lab.raiz, 'Pub-wt-936');
  git(lab.pub, 'worktree', 'add', '-q', '-b', 'story/9.36-lab', wt);
  escribir(wt, 'skills/demo/lib.js', SKILL_ROTA);
  const r = portón(lab);
  const commit = git(wt, 'rev-parse', 'HEAD');
  assert.match(r.salida, new RegExp(`público debajo: ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*story/9\\.36-lab.*${commit.slice(0, 12)}`), r.salida);
  assert.notStrictEqual(r.code, 0, `midió el worktree de la rama (con la skill rota): rojo\n${r.salida}`);
});

// La superposición deja el público en un commit local del árbol, y el árbol no declara su punta como rama del servidor:
// esa punta puede ser la rama del pedido, y el freno de guiones reconoce un guion del arnés sólo si está en main. Las
// suites que pasan un guion del arnés por el freno arman su propia copia (scripts/tests/lib/harness-copy.js).
// 🔴 Falla con: declarar la punta del público como rama del servidor (un guion reescrito en la rama del pedido pasa por
//    publicado).
test('PrivateTree_PublicTip_IsNotAServerBranch', () => {
  const lab = laboratorio();
  const dir = tmp('privado-arbol-');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'private-tree.js'), 'build', lab.priv, lab.story, dir],
    { encoding: 'utf8', env: entorno(lab.home) });
  assert.strictEqual(r.status, 0, r.stderr);
  const arbol = JSON.parse(r.stdout).tree;
  const ramas = git(arbol, 'for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').filter(Boolean);
  assert.deepStrictEqual(ramas.filter((ref) => !ref.startsWith('refs/remotes/origin/')), [], 'sólo las ramas del servidor del privado');
  assert.ok(!ramas.some((ref) => git(arbol, 'rev-parse', ref) === git(lab.pub, 'rev-parse', 'HEAD')), 'ninguna apunta a la punta del público');
});

// Las suites que miden «lo propio de la rama» lo cortan con `merge-base origin/main HEAD`. Un clon de un repo local toma
// como origin/main la rama main LOCAL de ese repo, que en un checkout que nadie pone al día queda atrás: lo que ya entró
// a main se veía como propio de la rama. El árbol trae el origin/main del repo de origen; sin él, el de siempre.
// 🔴 Falla con: el árbol y su público con origin/main igual a la rama main local de su repo de origen.
test('PrivateTree_OriginMain_IsTheSourceServerBranch', () => {
  const lab = laboratorio();
  const servidor = {};
  for (const [repo, nombre] of [[lab.priv, 'priv'], [lab.pub, 'pub']]) {
    const local = git(repo, 'rev-parse', 'main');
    escribir(repo, 'ya-en-main.txt', `${nombre}\n`);
    git(repo, 'add', 'ya-en-main.txt');
    git(repo, 'commit', '-q', '-m', 'entró a main en el servidor');
    servidor[nombre] = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', servidor[nombre]);
    git(repo, 'update-ref', 'refs/heads/main', local);   // la rama main local, atrás
    git(repo, 'checkout', '-q', '--detach', servidor[nombre]);
  }
  // una rama local que es el comienzo de una del servidor no frena el armado
  git(lab.priv, 'branch', 'story');
  git(lab.priv, 'update-ref', 'refs/remotes/origin/story/x', servidor.priv);
  const dir = tmp('privado-arbol-');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'private-tree.js'), 'build', lab.priv, lab.story, dir],
    { encoding: 'utf8', env: entorno(lab.home) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(git(JSON.parse(r.stdout).tree, 'rev-parse', 'refs/remotes/origin/main'), servidor.priv, 'el árbol: el origin/main del privado');
  assert.strictEqual(git(path.join(dir, 'publico'), 'rev-parse', 'refs/remotes/origin/main'), servidor.pub, 'el público: su origin/main');
  // sin origin/main en el repo de origen, el clon se queda con lo que git le da (su main)
  const solo = repoGit(tmp('sin-servidor-'), { 'a.txt': 'a\n' });
  const dest = path.join(tmp('sin-servidor-clon-'), 'c');
  require(path.join(SCRIPTS, 'lib', 'private-tree.js')).cloneWithDisk(solo, dest);
  assert.strictEqual(git(dest, 'rev-parse', 'refs/remotes/origin/main'), git(solo, 'rev-parse', 'main'));
});

// Sin una rama de la story en el público, el hermano declarado es la carpeta que esté al lado: el main local de un clon
// que nadie pone al día, o la rama de otra sesión con sus cambios sin commit. Lo que va debajo es la versión del
// servidor (el origin/main del público), sin copiar su disco, y lo de esa carpeta no cuenta como tocado por la story.
// 🔴 Falla con: el armado de siempre (HEAD de la carpeta vecina y su disco encima).
test('PrivateTree_PublicNotOfStory_UsesServerVersion', () => {
  const lab = laboratorio();
  const servidor = git(lab.pub, 'rev-parse', 'HEAD');
  git(lab.pub, 'update-ref', 'refs/remotes/origin/main', servidor);
  git(lab.priv, 'checkout', '-q', '-b', 'story/9.36-lab');
  // la carpeta vecina: en la rama de otra sesión, con un commit propio y un cambio sin commit, los dos rompen la skill
  git(lab.pub, 'checkout', '-q', '-b', 'fix/otra-sesion');
  escribir(lab.pub, 'skills/demo/lib.js', SKILL_ROTA);
  git(lab.pub, 'commit', '-q', '-am', 'otra sesión rompe la skill');
  escribir(lab.pub, 'scripts/lib/otra.js', 'module.exports = 2;\n');
  const arbol = (story) => {
    const dir = tmp('privado-arbol-');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'private-tree.js'), 'build', lab.priv, story, dir],
      { encoding: 'utf8', env: entorno(lab.home) });
    assert.strictEqual(r.status, 0, r.stderr);
    return { dir, j: JSON.parse(r.stdout) };
  };
  const { dir, j } = arbol(lab.story);
  assert.strictEqual(j.base.source, 'server', JSON.stringify(j.base));
  assert.strictEqual(j.base.commit, servidor);
  assert.strictEqual(j.base.uncommitted, false);
  assert.strictEqual(git(path.join(dir, 'publico'), 'rev-parse', 'HEAD'), servidor, 'debajo va el origin/main del público');
  assert.strictEqual(fs.readFileSync(path.join(j.tree, 'skills/demo/lib.js'), 'utf8'), SKILL_SANA, 'ni el commit de la otra rama');
  assert.strictEqual(fs.readFileSync(path.join(j.tree, 'scripts/lib/otra.js'), 'utf8'), 'module.exports = 1;\n', 'ni su disco');
  // el portón lo dice, y lo de la carpeta vecina no cuenta como tocado: la story no tocó nada (sin acotar, 7), y nada
  // de lo roto en esa carpeta se mide
  const r = portón(lab);
  assert.match(r.salida, /público debajo: versión del servidor/, r.salida);
  assert.strictEqual(r.code, 7, r.salida);
  assert.ok(!/ROJO\(/.test(r.salida) && !nombra(r, 'otra.test.js') && !nombra(r, 'demo.test.js'), `lo de la carpeta vecina no es de la story\n${r.salida}`);
  // con el público en la rama de la story, se mide esa rama con su disco, como siempre
  git(lab.pub, 'checkout', '-q', '-b', 'story/9.36-lab');
  const deLaStory = arbol(lab.story).j;
  assert.strictEqual(deLaStory.base.source, 'story', JSON.stringify(deLaStory.base));
  assert.strictEqual(deLaStory.base.uncommitted, true);
  // sin servidor conocido (un público sin origin/main), lo que hay, como siempre
  git(lab.pub, 'checkout', '-q', 'fix/otra-sesion');
  git(lab.pub, 'update-ref', '-d', 'refs/remotes/origin/main');
  assert.strictEqual(arbol(lab.story).j.base.source, 'disk');
});

// El origin/main de una carpeta que nadie pone al día está tan atrás como su main: antes de usarlo, se trae.
// 🔴 Falla con: leer el origin/main tal como quedó en la última traída.
test('PrivateTree_ServerVersion_FetchedFirst', () => {
  const lab = laboratorio();
  const servidor = path.join(lab.raiz, 'servidor.git');
  git(lab.raiz, 'clone', '-q', '--bare', lab.pub, servidor);
  git(lab.pub, 'remote', 'add', 'origin', servidor);
  git(lab.pub, 'fetch', '-q', 'origin');
  // en el servidor entra algo después de la última traída de la carpeta
  const otro = path.join(lab.raiz, 'otro-clon');
  git(lab.raiz, 'clone', '-q', servidor, otro);
  escribir(otro, 'entro-despues.txt', 'nuevo\n');
  git(otro, 'add', '-A');
  git(otro, '-c', 'user.email=prueba@ejemplo.invalid', '-c', 'user.name=prueba', 'commit', '-q', '-m', 'entró al servidor');
  git(otro, 'push', '-q', 'origin', 'HEAD:main');
  const nuevo = git(otro, 'rev-parse', 'HEAD');
  git(lab.priv, 'checkout', '-q', '-b', 'story/9.36-lab');
  git(lab.pub, 'checkout', '-q', '-b', 'fix/otra-sesion');
  const dir = tmp('privado-arbol-');
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'private-tree.js'), 'build', lab.priv, lab.story, dir],
    { encoding: 'utf8', env: entorno(lab.home) });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.base.source, 'server');
  assert.strictEqual(j.base.commit, nuevo, 'lo que está hoy en el servidor');
  assert.ok(j.base.date, 'con su fecha');
});

// ── Lo que se mide ─────────────────────────────────────────────────────────────────────────────────────────────

test('PrivateTree_SkillsFromTree_NeverInstalled @story-7.36 @ac-3', () => {
  const lab = laboratorio({ instalada: SKILL_ROTA });
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  const r = portón(lab);
  assert.strictEqual(r.code, 0, `la skill del árbol está sana: verde aunque la instalada esté rota\n${r.salida}`);
  assert.ok(nombra(r, 'demo.test.js'), r.salida);
  assert.ok(!r.salida.includes(path.join(lab.home, '.claude', 'agent-skills')), `nunca lee lo instalado\n${r.salida}`);
});

test('PrivateTree_NoSkills_Unmeasured @story-7.36 @ac-4', () => {
  const lab = laboratorio({ conSkills: false, modificar: ['Pub/skills/demo/lib.js'] });
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  const r = portón(lab);
  assert.notStrictEqual(r.code, 0, `sin skills en el árbol no es verde\n${r.salida}`);
  assert.match(r.salida, /NO MEDIDA .*demo/, r.salida);
});

test('PrivateTree_NoMissingFromPublic @story-7.36 @ac-5', () => {
  const lab = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  const r = portón(lab);
  assert.deepStrictEqual(r.resumen && r.resumen.ausentes, [], `ninguna suite del público sale ausente\n${r.salida}`);
});

test('PrivateTree_NoPublic_Exit4 @story-7.36 @ac-6', () => {
  const lab = laboratorio({ declarar: false });
  const r = portón(lab);
  assert.strictEqual(r.code, 4, r.salida);
  assert.match(r.salida, /no encontré el público/, r.salida);
  assert.ok(!nombra(r, 'demo.test.js') && !nombra(r, 'pub-lib.test.js') && !/corriendo scripts\/tests\/suites\.json/.test(r.salida), `no corrió nada\n${r.salida}`);
  // sin un público al lado en la rama de la story, el comando de la corrida cruzada va con el hueco a llenar
  assert.ok(r.salida.includes(`test-gate.sh' '<clon o worktree del público>' '${fs.realpathSync(lab.story)}'`), `nombra la corrida cruzada\n${r.salida}`);
});

test('PrivateTree_NoPublic_FromWorktree_NamesCrossRunReady', () => {
  // el worktree del privado no trae el hermano declarado; el del público está al lado, en la misma rama
  const lab = laboratorio({ declarar: false });
  git(lab.priv, 'checkout', '-q', '-b', 'story/x-arreglo');
  git(lab.pub, 'checkout', '-q', '-b', 'story/x-arreglo');
  const r = portón(lab);
  assert.strictEqual(r.code, 4, r.salida);
  assert.ok(r.salida.includes(`test-gate.sh' '${fs.realpathSync(lab.pub)}' '${fs.realpathSync(lab.story)}'`), `el comando va listo, con el público de la rama\n${r.salida}`);
  assert.ok(!nombra(r, 'demo.test.js') && !nombra(r, 'pub-lib.test.js'), `no corrió nada\n${r.salida}`);
});

test('PrivateTree_BrokenBranch_Red_EvenIfInstalledGreen @story-7.36 @ac-9', () => {
  // La prueba que se escribió primero: hoy daba VERDE porque la suite leía la skill instalada (sana).
  const lab = laboratorio({ instalada: SKILL_SANA });
  // la rama de la story en el público, commiteada: lo tocado sale de la bifurcación con main
  git(lab.pub, 'checkout', '-q', '-b', 'story/9.36-lab');
  escribir(lab.pub, 'skills/demo/lib.js', SKILL_ROTA);
  git(lab.pub, 'commit', '-q', '-am', 'la rama rompe la skill');
  const r = portón(lab);
  assert.notStrictEqual(r.code, 0, `la skill de la rama está rota: rojo aunque la instalada esté sana\n${r.salida}`);
  assert.match(r.salida, /ROJO\(\d+\) .*skills\/demo\/tests\/demo\.test\.js/, `la roja es la suite de la skill, leída del árbol\n${r.salida}`);
});

test('PrivateTree_UncommittedChanges_Measured @story-7.36 @ac-10', () => {
  const lab = laboratorio({ modificar: ['Pub/skills/demo/lib.js', 'scripts/tests/suites.json'] });
  // un cambio sin commit en el público que rompe su suite
  escribir(lab.pub, 'skills/demo/lib.js', SKILL_ROTA);
  assert.notStrictEqual(portón(lab).code, 0, 'el cambio sin commit del público se midió');
  escribir(lab.pub, 'skills/demo/lib.js', SKILL_SANA);
  // un cambio sin commit en el privado: su suites.json nombra una suite que no existe
  const sj = JSON.parse(fs.readFileSync(path.join(lab.priv, 'scripts/tests/suites.json'), 'utf8'));
  sj.diarias.push({ raiz: 'arnes', ruta: 'tests/no-existe.test.js', requiere: [] });
  escribir(lab.priv, 'scripts/tests/suites.json', JSON.stringify(sj, null, 2) + '\n');
  const r = portón(lab);
  assert.notStrictEqual(r.code, 0, `el cambio sin commit del privado se midió\n${r.salida}`);
  assert.match(r.salida, /AUSENTE .*no-existe\.test\.js/, r.salida);
  // deshecho, verde
  git(lab.priv, 'checkout', '--', 'scripts/tests/suites.json');
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  assert.strictEqual(portón(lab).code, 0, 'sin los cambios, verde');
});

test('PrivateTree_TeamLayer_FromEnv_OrSaid @story-7.36 @ac-11 @ac-12', () => {
  const lab = laboratorio();
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  const sin = portón(lab);
  assert.match(sin.salida, /sin capa del equipo/, sin.salida);
  assert.match(sin.salida, /armado en \d+(\.\d+)? s/, sin.salida);
  const equipo = tmp('privado-equipo-');
  escribir(equipo, 'team-profile.json', '{ "name": "acme" }\n');
  const con = portón(lab, { HARNESS_TEAM_DIR: equipo });
  assert.match(con.salida, new RegExp(`capa del equipo: ${equipo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), con.salida);
  assert.match(con.salida, /armado en \d+(\.\d+)? s/, con.salida);
  assert.strictEqual(con.code, 0, con.salida);
});

// ── La capa del equipo que declara la máquina (paths.team) ─────────────────────────────────────────────────────────

/** Un clon de juguete del repo del perfil del equipo: su perfil y el texto del alta, como el de verdad. */
const cloneDelPerfil = (lab) => repoGit(path.join(lab.raiz, 'Perfil'), {
  'team-profile.json': '{ "name": "acme" }\n', 'onboarding/step-0.md': '# alta de juguete\n' });
/** Una casa del arnés de juguete cuya configuración declara `paths` (nada más). */
function casaQueDeclara(lab, paths) {
  const casa = path.join(lab.raiz, 'casa');
  escribir(casa, 'config.json', JSON.stringify({ paths }) + '\n');
  return casa;
}
const re = (t) => new RegExp(esc(t));

test('PrivateTree_TeamLayer_FromMachineDeclaration @story-7.36 @ac-11', () => {
  const lab = laboratorio();
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  const perfil = cloneDelPerfil(lab);
  const r = portón(lab, { TYCON_HOME: casaQueDeclara(lab, { team: perfil }) });
  assert.match(r.salida, re(`capa del equipo: ${perfil} (declarada por la máquina: paths.team)`), r.salida);
  assert.strictEqual(r.code, 0, r.salida);
});

test('PrivateTree_TeamLayer_EnvWinsOverDeclaration @story-7.36 @ac-11', () => {
  const lab = laboratorio();
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  const perfil = cloneDelPerfil(lab);
  const otro = tmp('privado-equipo-');
  escribir(otro, 'team-profile.json', '{ "name": "acme" }\n');
  const r = portón(lab, { TYCON_HOME: casaQueDeclara(lab, { team: perfil }), HARNESS_TEAM_DIR: otro });
  assert.match(r.salida, re(`capa del equipo: ${otro} (de HARNESS_TEAM_DIR)`), r.salida);
  assert.doesNotMatch(r.salida, re(`capa del equipo: ${perfil}`), r.salida);
  assert.strictEqual(r.code, 0, r.salida);
});

test('PrivateTree_TeamLayer_BadDeclaration_Said_NeverUsed @story-7.36 @ac-12', () => {
  for (const [nombre, declarar, motivo] of [
    ['no existe', (lab) => path.join(lab.raiz, 'no-esta'), /paths\.team nombra una carpeta que no está/],
    ['no es un clon', (lab) => { const d = path.join(lab.raiz, 'suelta'); escribir(d, 'team-profile.json', '{}\n'); escribir(d, 'onboarding/a.md', 'x\n'); return d; }, /no es un clon de git/],
    ['no es el perfil', (lab) => repoGit(path.join(lab.raiz, 'OtroRepo'), { 'README.md': 'otro\n' }), /no trae team-profile\.json/],
    ['sin el alta', (lab) => repoGit(path.join(lab.raiz, 'SinAlta'), { 'team-profile.json': '{}\n' }), /no trae el texto del alta/],
    ['relativa', () => 'Perfil', /paths\.team no es una ruta absoluta/],
  ]) {
    const lab = laboratorio();
    fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
    const r = portón(lab, { TYCON_HOME: casaQueDeclara(lab, { team: declarar(lab) }) });
    assert.match(r.salida, /sin capa del equipo: la máquina declara paths\.team y no sirve/, `${nombre}\n${r.salida}`);
    assert.match(r.salida, motivo, `${nombre}\n${r.salida}`);
    assert.doesNotMatch(r.salida, /capa del equipo: (?:\/|[A-Za-z]:[\\/])/, `${nombre}: no se usa otra cosa en silencio\n${r.salida}`);
    assert.strictEqual(r.code, 0, `${nombre}: no aborta\n${r.salida}`);
  }
});

test('PrivateTree_TeamLayer_NothingDeclared_SaysNone @story-7.36 @ac-12', () => {
  const lab = laboratorio();
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  // una configuración que declara otras claves y no paths.team: igual que sin configuración
  const r = portón(lab, { TYCON_HOME: casaQueDeclara(lab, { operations: lab.raiz }) });
  assert.match(r.salida, /sin capa del equipo \(ni HARNESS_TEAM_DIR ni paths\.team en la configuración de la máquina\)/, r.salida);
  assert.strictEqual(r.code, 0, r.salida);
});

test('PrivateTree_OnlyTouchedSuitesRun @story-7.36 @ac-13', () => {
  const lab = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  const r = portón(lab);
  assert.strictEqual(r.code, 0, r.salida);
  assert.ok(nombra(r, 'pub-lib.test.js'), `corre la que lee lo tocado\n${r.salida}`);
  assert.ok(!nombra(r, 'otra.test.js'), `la que no lo lee no corre\n${r.salida}`);
  assert.ok((r.resumen.deferred_suites || []).some((d) => JSON.stringify(d).includes('otra.test.js')), `queda diferida, con su motivo\n${r.salida}`);
  assert.ok(!(r.resumen.ausentes || []).some((a) => a.includes('otra')), r.salida);
  // el público que fue debajo no se vuelve a correr como repo hermano: ya se midió en el árbol
  assert.match(r.salida, /repo hermano Pub: se midió dentro del árbol armado/, r.salida);
  assert.doesNotMatch(r.salida, /repo hermano Pub: la story declara ahí/, r.salida);
});

// El árbol armado vive en la carpeta temporal: las HOME vacías de las portables van bajo `.advisors/` del privado de
// verdad, fuera de ella, porque hay suites que tratan la carpeta temporal como «de prueba».
// 🔴 mutación: no declarar TYCON_SUITE_HOMES_ROOT → la HOME queda bajo el árbol, dentro de la carpeta temporal.
test('PrivateTree_SuiteHomes_OutsideTheTree', () => {
  const lab = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  const anota = path.join(lab.raiz, 'casa.txt');
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  fs.appendFileSync(path.join(lab.pub, 'scripts/tests/pub-lib.test.js'), `require('fs').writeFileSync(${JSON.stringify(anota)}, process.env.HOME);\n`);
  const r = portón(lab);
  assert.strictEqual(r.code, 0, r.salida);
  const casa = fs.readFileSync(anota, 'utf8');
  assert.ok(casa.startsWith(path.join(lab.priv, '.advisors', 'suite-homes-')), `la HOME bajo .advisors del privado: ${casa}`);
  assert.ok(!casa.startsWith(path.join(lab.raiz, 'tmp')), `y no bajo el árbol armado: ${casa}`);
});

// ── Sin efectos ────────────────────────────────────────────────────────────────────────────────────────────────

test('PrivateTree_LeavesReposUntouched @story-7.36 @ac-8', () => {
  const lab = laboratorio();
  escribir(lab.pub, 'skills/demo/lib.js', SKILL_SANA + '// sin commit\n');
  escribir(lab.priv, 'specs/otra.md', 'sin commit\n');
  const antes = [git(lab.priv, 'status', '--porcelain'), git(lab.pub, 'status', '--porcelain'),
    git(lab.priv, 'rev-parse', 'HEAD'), git(lab.pub, 'rev-parse', 'HEAD'), git(lab.priv, 'worktree', 'list')];
  portón(lab);
  const despues = [git(lab.priv, 'status', '--porcelain').split('\n').filter((l) => !l.includes('.advisors')).join('\n'),
    git(lab.pub, 'status', '--porcelain'), git(lab.priv, 'rev-parse', 'HEAD'), git(lab.pub, 'rev-parse', 'HEAD'),
    git(lab.priv, 'worktree', 'list')];
  assert.deepStrictEqual(despues, antes);
  assert.deepStrictEqual(temporalesVivas(lab), [], 'la temporal se borró');
});

test('PrivateTree_Interrupted_TempRemoved @story-7.36 @ac-8', async () => {
  const lab = laboratorio();
  // una suite que tarda: da tiempo a cortar la corrida con el árbol ya armado
  escribir(lab.pub, 'skills/demo/tests/demo.test.js', "setTimeout(() => process.exit(0), 20000); console.log('arrancó');\n");
  git(lab.pub, 'commit', '-q', '-am', 'suite lenta');
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  const hijo = spawn('bash', [TEST_GATE, lab.priv, lab.story], { cwd: lab.priv,
    env: entorno(lab.home, { TYCON_PRIVATE_TREE_TMP: path.join(lab.raiz, 'tmp') }), stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  hijo.stderr.on('data', (d) => { salida += d; });
  await new Promise((resolve, reject) => {
    // espera por vueltas (600 de 100 ms), no por la hora
    let vueltas = 0;
    const iv = setInterval(() => {
      if (/árbol armado/.test(salida) && temporalesVivas(lab).length) { clearInterval(iv); resolve(); }
      else if (++vueltas > 600) { clearInterval(iv); reject(new Error(`no llegó a armar el árbol\n${salida}`)); }
    }, 100);
  });
  hijo.kill('SIGTERM');
  await new Promise((resolve) => hijo.on('close', resolve));
  assert.deepStrictEqual(temporalesVivas(lab), [], `la temporal se borró al cortar\n${salida}`);
  assert.strictEqual(git(lab.priv, 'worktree', 'list').split('\n').length, 1);
  // 🔴 pase adversarial: el corte mataba sólo el subshell; run-check, el corredor y la suite seguían vivos sobre el
  //    árbol ya borrado. Nada de este laboratorio puede quedar corriendo.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const vivos = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter((l) => l.includes(lab.raiz) || l.includes(path.join(lab.raiz, 'tmp')));
  assert.deepStrictEqual(vivos, [], `quedaron procesos del laboratorio vivos tras el corte:\n${vivos.join('\n')}`);
});

test('PrivateTree_FileBecomesFolder_AndBack_Builds @story-7.36 @ac-10', () => {
  // 🔴 pase adversarial (confirmado por cuatro verificadores): si el disco cambiaba un archivo por una carpeta, o una
  //    carpeta por un archivo, el armado se caía con EEXIST/EISDIR y el portón salía 4.
  const lab = laboratorio();
  escribir(lab.pub, 'docs/a/b.md', 'una carpeta\n');
  escribir(lab.pub, 'docs/c.md', 'un archivo\n');
  git(lab.pub, 'add', '-A');
  git(lab.pub, 'commit', '-q', '-m', 'una carpeta y un archivo');
  fs.rmSync(path.join(lab.pub, 'docs/a'), { recursive: true });
  escribir(lab.pub, 'docs/a', 'ahora es un archivo\n');
  fs.rmSync(path.join(lab.pub, 'docs/c.md'));
  escribir(lab.pub, 'docs/c.md/d.md', 'ahora es una carpeta\n');
  fs.appendFileSync(path.join(lab.pub, 'skills/demo/lib.js'), '// tocado\n');
  const r = portón(lab);
  assert.match(r.salida, /árbol armado/, r.salida);
  assert.strictEqual(r.code, 0, r.salida);
});

test('PrivateTree_TouchedLines_OnlyWhatTheStoryTouched @story-7.36 @ac-16', () => {
  // 🔴 pase adversarial (confirmado): el cruce de líneas tocadas comparaba el árbol armado contra la base del privado,
  //    y todo el público entraba como «tocado» (medido sobre el privado real: 994 archivos de código).
  const lab = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), 'module.exports.extra = 2;\n');
  const r = portón(lab);
  const cov = (r.resumen && r.resumen.art && r.resumen.art.coverage) || {};
  const nombrados = [...Object.keys((cov.touched_lines && cov.touched_lines.per_file) || {}),
    ...(cov.touched_files_without_coverage_data || [])];
  assert.ok(nombrados.length > 0, `el cruce no miró nada:\n${JSON.stringify(cov, null, 2)}\n${r.salida}`);
  assert.deepStrictEqual(nombrados.filter((f) => f !== 'scripts/lib/pub-lib.js'), [],
    `sólo lo que la story tocó entra al cruce:\n${JSON.stringify(cov, null, 2)}`);
});

test('PrivateTree_OverlayFails_Exit4_NoCompanions @story-7.36 @ac-6', () => {
  // revisor de alcance: con el público presente y el armado fallido, el portón salía 4 y al salir corría igual el
  // público entero como repo hermano
  const lab = laboratorio();
  const r = portón(lab, { LAB_OVERLAY_FAILS: 'un archivo en los dos sin declarar' });
  assert.strictEqual(r.code, 4, r.salida);
  assert.match(r.salida, /no pude poner el público/, r.salida);
  assert.match(r.salida, /repos hermanos: no se corren/, r.salida);
  assert.doesNotMatch(r.salida, /repo hermano Pub: la story declara ahí/, r.salida);
  assert.deepStrictEqual(temporalesVivas(lab), [], 'la temporal se borró');
});

test('PrivateTree_BrokenThinList_Exit4_NeverInstalled @story-7.36 @ac-17', () => {
  // 🔴 pase adversarial: con la lista del privado ilegible, o declarando `layout: thin` sin su guion de superposición,
  //    el portón medía el privado solo, sobre las skills instaladas, sin decir nada.
  for (const romper of [
    (lab) => fs.rmSync(path.join(lab.priv, 'scripts/ci/overlay-harness.js')),
    (lab) => escribir(lab.priv, '.tycon/internal-forms.json', '{ "layout": "thin", '),
  ]) {
    const lab = laboratorio();
    romper(lab);
    const r = portón(lab);
    assert.strictEqual(r.code, 4, r.salida);
    assert.match(r.salida, /privado adelgazado/, r.salida);
    assert.ok(!r.salida.includes(path.join(lab.home, '.claude', 'agent-skills')), `nunca lee lo instalado\n${r.salida}`);
  }
});
