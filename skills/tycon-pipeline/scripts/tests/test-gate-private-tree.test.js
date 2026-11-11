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
  'HARNESS_TEAM_DIR', 'TYCON_PRIVATE_TREE_TMP', 'TYCON_SUITE_HOMES_ROOT', 'TF_BUILD', 'TYCON_HOME',
  'TYCON_GATE_ALL_SUITES'];

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
  // una story sólo del privado: el público suelto va en su versión del servidor
  const lab = laboratorio({ modificar: ['specs/s.md'] });
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
  // una story sólo del privado: con la del público, la versión del servidor no mide lo suyo (la prueba de abajo)
  const lab = laboratorio({ modificar: ['specs/s.md'] });
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

// Una story que declara archivos del público y el público fuera de su rama: la versión del servidor no trae esos
// cambios, y medirla daba un verde que no decía nada de la story. No se arma el árbol y el portón no sale verde.
// 🔴 Falla con: armar sobre la versión del servidor y avisar en un renglón informativo.
test('PrivateTree_ServerVersion_StoryDeclaresPublic_Red', () => {
  const lab = laboratorio({ modificar: ['Pub/skills/demo/lib.js', 'Pub/skills/demo/nuevo.js'] });
  git(lab.pub, 'update-ref', 'refs/remotes/origin/main', git(lab.pub, 'rev-parse', 'HEAD'));
  git(lab.priv, 'checkout', '-q', '-b', 'story/9.36-lab');
  git(lab.pub, 'checkout', '-q', '-b', 'fix/otra-sesion');
  const dir = tmp('privado-arbol-');
  const b = spawnSync(process.execPath, [path.join(SCRIPTS, 'lib', 'private-tree.js'), 'build', lab.priv, lab.story, dir],
    { encoding: 'utf8', env: entorno(lab.home) });
  assert.strictEqual(b.status, 4, b.stdout + b.stderr);
  assert.match(b.stderr, /declara archivos del público/, b.stderr);
  const r = portón(lab);
  assert.strictEqual(r.code, 4, r.salida);
  assert.match(r.salida, /fix\/otra-sesion/, `nombra la rama en que está el público\n${r.salida}`);
  assert.ok(!nombra(r, 'demo.test.js') && !nombra(r, 'pub-lib.test.js'), `no corrió nada\n${r.salida}`);
  // un archivo nuevo que todavía no existe en ninguna carpeta también es del público
  const solo = laboratorio({ modificar: ['Pub/skills/demo/nuevo.js'] });
  git(solo.pub, 'update-ref', 'refs/remotes/origin/main', git(solo.pub, 'rev-parse', 'HEAD'));
  git(solo.priv, 'checkout', '-q', '-b', 'story/9.36-lab');
  git(solo.pub, 'checkout', '-q', '-b', 'fix/otra-sesion');
  assert.strictEqual(portón(solo).code, 4);
});

// La ruta de la story no se encuentra (relativa, lanzada desde otra carpeta): sin ella el portón no sabe qué público
// medir ni qué tocó la story. Frena con un mensaje claro y no corre nada.
// 🔴 Falla con: seguir como si no hubiera story.
test('TestGate_StoryNotFound_Stops', () => {
  const lab = laboratorio();
  const r = spawnSync('bash', [TEST_GATE, lab.priv, 'specs/s.md'], { encoding: 'utf8', cwd: lab.raiz,
    env: entorno(lab.home, { TYCON_PRIVATE_TREE_TMP: path.join(lab.raiz, 'tmp') }), timeout: 120000 });
  const salida = `${r.stdout}\n${r.stderr}`;
  assert.strictEqual(r.status, 2, salida);
  assert.match(salida, /no encontré la story «specs\/s\.md»/, salida);
  assert.ok(salida.includes(fs.realpathSync(lab.raiz)) || salida.includes(lab.raiz), `dice desde qué carpeta\n${salida}`);
  assert.match(salida, /ruta absoluta/, salida);
  assert.ok(!/árbol armado/.test(salida) && !/ok {7}/.test(salida), `no corrió nada\n${salida}`);
});

// El origin/main de una carpeta que nadie pone al día está tan atrás como su main: antes de usarlo, se trae.
// 🔴 Falla con: leer el origin/main tal como quedó en la última traída.
test('PrivateTree_ServerVersion_FetchedFirst', () => {
  const lab = laboratorio({ modificar: ['specs/s.md'] });
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

// ── Traer main no repite lo que ya se midió (lib/after-main.js, en el árbol armado) ────────────────────────────────

const SOLO_MAIN = /lo único que cambió es lo que trajo main/;
const MEDIDO = (lab) => path.join(lab.priv, '.advisors', 'test-gate-measured.json');

/**
 * Un laboratorio con la historia en el privado: `historia` y `falla` nombran su archivo, `trae` nombra uno que traerá main,
 * y las del público son las de siempre. `falla` sale roja si existe `<estado>/roja`. Con `publicoEnRama`, el público está en
 * la rama de la historia; sin eso, debajo va su versión del servidor. Cada suite anota su nombre al correr.
 */
function labTrasMain({ publicoEnRama = false } = {}) {
  const lab = laboratorio({ modificar: ['lib/priv.js'] });
  lab.estado = tmp('privado-estado-');
  const suite = (nombre, nombra, extra = '') => `// ${nombra}\nconst fs = require('fs');\nfs.appendFileSync(process.env.LAB_STATE + '/corridas', '${nombre}\\n');\n${extra}`;
  escribir(lab.priv, 'lib/priv.js', 'module.exports = 1;\n');
  escribir(lab.priv, 'lib/trae.js', 'module.exports = 1;\n');
  escribir(lab.priv, 'scripts/tests/historia.test.js', suite('historia', 'lib/priv.js'));
  escribir(lab.priv, 'scripts/tests/falla.test.js', suite('falla', 'lib/priv.js', "if (fs.existsSync(process.env.LAB_STATE + '/roja')) process.exit(1);\n"));
  escribir(lab.priv, 'scripts/tests/trae.test.js', suite('trae', 'lib/trae.js'));
  escribir(lab.pub, 'scripts/tests/otra.test.js', `${suite('otra', 'scripts/lib/otra.js')}if (require('../lib/otra.js') < 1) process.exit(1);\n`);
  escribir(lab.pub, 'scripts/tests/pub-lib.test.js', `${suite('pub-lib', 'scripts/lib/pub-lib.js')}if (require('../lib/pub-lib.js') < 1) process.exit(1);\n`);
  escribir(lab.priv, 'scripts/tests/suites.json', `${JSON.stringify({ diarias: ['historia', 'falla', 'trae', 'otra', 'pub-lib'].map((n) => ({ raiz: 'arnes', ruta: `tests/${n}.test.js`, requiere: [] })) }, null, 2)}\n`);
  for (const repo of [lab.priv, lab.pub]) {
    git(repo, 'add', '-A', '-f');
    git(repo, 'commit', '-q', '-m', 'las suites del laboratorio');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    if (repo === lab.priv || publicoEnRama) git(repo, 'checkout', '-q', '-b', 'story/9.36-lab');
  }
  return lab;
}
const portónTM = (lab, extra) => portón(lab, { LAB_STATE: lab.estado, ...(extra || {}) });
const corridasTM = (lab) => { try { return fs.readFileSync(path.join(lab.estado, 'corridas'), 'utf8').split('\n').filter(Boolean).sort(); } catch (_) { return []; } };
const borrarCorridasTM = (lab) => fs.rmSync(path.join(lab.estado, 'corridas'), { force: true });

/** Main de `repo` suma un commit que cambia `rel`, sin tocar la carpeta; devuelve su sha. */
function mainAvanzaTM(repo, rel, texto = 'module.exports = 3;\n') {
  const wt = tmp('privado-main-');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'refs/remotes/origin/main');
  escribir(wt, rel, texto);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'lo de main');
  const sha = git(wt, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'remove', '--force', wt);
  git(repo, 'update-ref', 'refs/remotes/origin/main', sha);
  return sha;
}

/** La primera ejecución: el cambio de la historia, sólo preparado, medido y anotado. */
function primeraTM(lab, { roja = false, extra } = {}) {
  escribir(lab.priv, 'lib/priv.js', 'module.exports = 2;\n');
  git(lab.priv, 'add', 'lib/priv.js');
  if (roja) fs.writeFileSync(path.join(lab.estado, 'roja'), '');
  const r = portónTM(lab, extra);
  assert.strictEqual(r.code, roja ? 1 : 0, r.salida);
  assert.ok(fs.existsSync(MEDIDO(lab)), `queda anotado lo medido\n${r.salida}`);
  fs.rmSync(path.join(lab.estado, 'roja'), { force: true });
  borrarCorridasTM(lab);
  return r;
}

test('Arbol_SoloMainDelPrivado_CorreLaQueFalloYLasQueLoNombran — el caso real: traer main no repite lo de la historia', () => {
  // 🔴 mutación: dejar el atajo sólo fuera del árbol (la condición de antes) corre también `historia`.
  const lab = labTrasMain();
  primeraTM(lab, { roja: true });
  git(lab.priv, 'merge', '-q', '--ff-only', mainAvanzaTM(lab.priv, 'lib/trae.js'));
  const r = portónTM(lab);
  assert.strictEqual(r.code, 0, r.salida);
  assert.match(r.salida, SOLO_MAIN, r.salida);
  assert.deepStrictEqual(corridasTM(lab), ['falla', 'trae'], r.salida);
});

test('Arbol_SoloMainDelPublico_CorreLoMismo — con el público en su versión del servidor y en la rama de la historia', () => {
  // 🔴 mutación: mirar sólo el privado da «no cambió nada» cuando el que avanzó es el público, que se trae solo en cada ejecución.
  const servidor = labTrasMain();
  primeraTM(servidor);
  mainAvanzaTM(servidor.pub, 'scripts/lib/otra.js');
  const a = portónTM(servidor);
  assert.strictEqual(a.code, 0, a.salida);
  assert.match(a.salida, SOLO_MAIN, a.salida);
  assert.deepStrictEqual(corridasTM(servidor), ['otra'], a.salida);

  const enRama = labTrasMain({ publicoEnRama: true });
  primeraTM(enRama);
  git(enRama.pub, 'merge', '-q', '--ff-only', mainAvanzaTM(enRama.pub, 'scripts/lib/otra.js'));
  const b = portónTM(enRama);
  assert.strictEqual(b.code, 0, b.salida);
  assert.match(b.salida, SOLO_MAIN, b.salida);
  assert.deepStrictEqual(corridasTM(enRama), ['otra'], b.salida);
});

test('Arbol_SinSuitesElegidas_NoEsSinAcotar — main trae algo que ninguna suite lee: verde, no la salida 7', () => {
  // 🔴 mutación: dejar `--only-touched` al elegir por main sale 7, y el portón pide una CI por un cambio que ya está en main.
  const lab = labTrasMain();
  primeraTM(lab);
  git(lab.priv, 'merge', '-q', '--ff-only', mainAvanzaTM(lab.priv, 'lib/nadie.js'));
  const r = portónTM(lab);
  assert.strictEqual(r.code, 0, r.salida);
  assert.match(r.salida, SOLO_MAIN, r.salida);
  assert.deepStrictEqual(corridasTM(lab), [], r.salida);
});

test('Arbol_RetoqueEnUnRepo_CorreLoDeSiempre — un cambio propio de más, en cualquiera de los dos, lo apaga', () => {
  // 🔴 mutación: comparar sólo contra main, o un solo repo, deja pasar sin medir el retoque.
  const priv = labTrasMain();
  primeraTM(priv);
  git(priv.priv, 'merge', '-q', '--ff-only', mainAvanzaTM(priv.priv, 'lib/trae.js'));
  escribir(priv.priv, 'lib/priv.js', 'module.exports = 4;\n');
  const a = portónTM(priv);
  assert.doesNotMatch(a.salida, SOLO_MAIN, a.salida);
  assert.ok(corridasTM(priv).includes('historia'), a.salida);

  const pub = labTrasMain({ publicoEnRama: true });
  primeraTM(pub);
  git(pub.pub, 'merge', '-q', '--ff-only', mainAvanzaTM(pub.pub, 'scripts/lib/otra.js'));
  escribir(pub.pub, 'scripts/lib/pub-lib.js', 'module.exports = 4;\n');
  const b = portónTM(pub);
  assert.doesNotMatch(b.salida, SOLO_MAIN, b.salida);
  assert.ok(corridasTM(pub).includes('pub-lib'), b.salida);
});

test('Arbol_CambioElPerfilDelEquipo_CorreLoDeSiempre — la capa del equipo entra al árbol: otra capa es otro árbol', () => {
  // 🔴 mutación: no anotar el perfil elige por main un árbol que además cambió de perfil, y nadie mide ese cambio.
  const lab = labTrasMain();
  const equipo = repoGit(path.join(lab.raiz, 'Perfil'), { 'team-profile.json': '{ "name": "acme" }\n' });
  primeraTM(lab, { extra: { HARNESS_TEAM_DIR: equipo } });
  git(lab.priv, 'merge', '-q', '--ff-only', mainAvanzaTM(lab.priv, 'lib/trae.js'));
  escribir(equipo, 'team-profile.json', '{ "name": "otra" }\n');
  const r = portónTM(lab, { HARNESS_TEAM_DIR: equipo });
  assert.match(r.salida, /corre lo de siempre: cambió el perfil del equipo/, r.salida);
  assert.ok(corridasTM(lab).includes('historia'), r.salida);
});

test('Arbol_PublicoCambioDeRamaAServidor_CorreLoDeSiempre — lo de debajo salió de otro lado', () => {
  // 🔴 mutación: comparar el público sin mirar de dónde salió trata la rama vieja como si fuera un antecesor del servidor.
  const lab = labTrasMain({ publicoEnRama: true });
  primeraTM(lab);
  git(lab.pub, 'checkout', '-q', '--detach', 'refs/remotes/origin/main');
  const r = portónTM(lab);
  assert.match(r.salida, /corre lo de siempre: el público de debajo salió de otro lado/, r.salida);
});

test('Arbol_CarpetaCambioAlArmar_NoAnota — lo que cambió mientras se armaba o mientras corría no queda como medido', () => {
  // 🔴 mutación: no comparar la huella del armado anota como medido lo que el árbol no trae.
  const lab = labTrasMain();
  const am = path.join(SCRIPTS, 'lib', 'after-main.js');
  const huella = (repo) => git(repo, 'rev-parse', 'HEAD^{tree}');
  const servidor = git(lab.pub, 'rev-parse', 'HEAD');
  const foto = (privada) => spawnSync(process.execPath, [am, 'snapshot-tree', lab.priv, lab.pub, 'server', servidor, '-', privada, huella(lab.pub)], { encoding: 'utf8', env: entorno(lab.home) });
  assert.strictEqual(foto(huella(lab.priv)).status, 0, 'con la misma huella, anota');
  const distinta = foto('0'.repeat(40));
  assert.notStrictEqual(distinta.status, 0, distinta.stdout);
  assert.match(distinta.stderr, /cambió mientras se armaba/);

  // una suite que escribe en el repo de verdad mientras corre: mide algo que ya no es lo que hay
  const mientras = labTrasMain();
  escribir(mientras.priv, 'lib/priv.js', 'module.exports = 2;\n');
  escribir(mientras.priv, 'scripts/tests/historia.test.js', `// lib/priv.js\nrequire('fs').writeFileSync(${JSON.stringify(path.join(mientras.priv, 'lib/priv.js'))}, 'module.exports = 5;\\n');\n`);
  const r = portónTM(mientras);
  assert.match(r.salida, /no anoto lo medido: una carpeta cambió mientras corría/, r.salida);
  assert.ok(!fs.existsSync(MEDIDO(mientras)), r.salida);
});

test('Arbol_Cobertura_NoSeCalculaAlElegirPorMain — la historia no corrió: su porcentaje mentiría', () => {
  // 🔴 mutación: dejar lo tocado de los dos repos para el informe calcula el porcentaje sin las suites de la historia.
  const lab = labTrasMain();
  primeraTM(lab);
  git(lab.priv, 'merge', '-q', '--ff-only', mainAvanzaTM(lab.priv, 'lib/trae.js'));
  const r = portónTM(lab);
  assert.strictEqual(r.code, 0, r.salida);
  const cov = r.resumen.art.coverage;
  assert.strictEqual(cov.touched_lines_pct, null, JSON.stringify(cov));
  assert.match(cov.touched_no_cross_check, /eligió sólo lo que trajo main/);
});

test('Arbol_ServidorQueNoDesciende_CorreLoDeSiempre — si la versión del servidor se reescribió, lo medido ya no es su antecesor', () => {
  // 🔴 mutación: no mirar la descendencia trata como «lo que trajo main» un servidor que perdió commits.
  const lab = labTrasMain();
  primeraTM(lab);
  const wt = tmp('privado-main-');
  git(lab.pub, 'worktree', 'add', '-q', '--detach', wt, 'refs/remotes/origin/main~1');
  escribir(wt, 'scripts/lib/otra.js', 'module.exports = 9;\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'otra historia');
  const sha = git(wt, 'rev-parse', 'HEAD');
  git(lab.pub, 'worktree', 'remove', '--force', wt);
  git(lab.pub, 'update-ref', 'refs/remotes/origin/main', sha);
  const r = portónTM(lab);
  assert.match(r.salida, /corre lo de siempre: la versión del servidor del público no desciende de la medida/, r.salida);
});

test('Arbol_LoAnotadoSinHash_NoAcota — lo que no es un hash no llega a git', () => {
  // 🔴 mutación: aceptar cualquier texto deja que un valor con guion se lea como una opción de git.
  const { decidir, decidirDelArbol } = require(path.join(SCRIPTS, 'lib', 'after-main.js'));
  const hash = 'a'.repeat(40);
  const bien = { head: hash, tree: hash };
  const mala = { head: hash, tree: '--output=/tmp/x' };
  assert.match(decidir({ repo: '.', anotado: { ...mala, failed: [] }, ahora: hash }).no, /no dejó qué midió/);
  for (const parte of [{ privado: mala, publico: bien }, { privado: bien, publico: mala }]) {
    const d = decidirDelArbol({ anotado: { origen: { fuente: 'server' }, failed: [], ...parte }, ahora: { origen: { fuente: 'server' }, privado: bien, publico: bien } });
    assert.match(d.no, /no dejó qué midió/);
  }
});

// ── Lo guardado de la última completa, en el árbol armado ─────────────────────────────────────────────────────────────
// Con un marcador de corrida: lo guardado vive en el marcador de la sesión.
// stable-data: el marcador lleva la hora de ahora a propósito, para que marker.js no lo dé por abandonado; no se compara.
function conMarcador(lab, sid) {
  const activo = path.join(lab.home, '.claude', '.tycon-pipeline', 'active', `${sid}.json`);
  fs.mkdirSync(path.dirname(activo), { recursive: true });
  fs.writeFileSync(activo, JSON.stringify({ storyId: '9.36', storyPath: lab.story, repoPath: lab.priv, baseSha: git(lab.priv, 'rev-parse', 'HEAD'),
    sessionId: sid, startedAt: new Date().toISOString(), lastTouch: new Date().toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5],
    stepsPending: [6, 7, 8, 9, 10, 11], filesTouched: [], iterations: {}, fileEvents: [], checks: {} }));
  return { CLAUDE_CODE_SESSION_ID: sid, leer: () => JSON.parse(fs.readFileSync(activo, 'utf8')) };
}

test('T14 PrivateTree_GreenAndRedSaved_ComparedPerRepo @story-8.263 @ac-8 @ac-9 — en el árbol armado se compara repo por repo', () => {
  const lab = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js', 'Pub/scripts/lib/otra.js'] });
  const perfil = cloneDelPerfil(lab);
  const m = conMarcador(lab, 'pt-verde');
  const env = { CLAUDE_CODE_SESSION_ID: m.CLAUDE_CODE_SESSION_ID, HARNESS_TEAM_DIR: perfil };
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  let r = portón(lab, env);
  assert.strictEqual(r.code, 0, r.salida);
  assert.ok((m.leer().testsGreenFull || []).length === 1, `guarda la completa verde del árbol\n${r.salida}`);
  // cambia un archivo del público: corre sólo la suite que lo lee
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/otra.js'), '// el arreglo\n');
  r = portón(lab, env);
  assert.strictEqual(r.code, 0, r.salida);
  assert.ok(nombra(r, 'otra.test.js') && !nombra(r, 'pub-lib.test.js'), `corre sólo la que lee lo cambiado\n${r.salida}`);
  assert.match(r.salida, /más 1 suites? por lo cambiado \(scripts\/lib\/otra\.js\)/, r.salida);
  // el perfil del equipo cambia: la completa como siempre
  fs.appendFileSync(path.join(perfil, 'team-profile.json'), '\n');
  r = portón(lab, env);
  assert.match(r.salida, /corre la completa como siempre: [^\n]*cambió el perfil del equipo/, r.salida);
  // un repo que no se puede comparar: la completa como siempre, con su motivo
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/otra.js'), '// otro\n');
  const bin = tmp('pt-bin-');
  const real = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
  escribir(bin, 'git', `#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == diff-tree ]] && { echo "fatal: de mentira" >&2; exit 128; }; done\nexec "${real}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  r = portón(lab, { ...env, PATH: `${bin}:${process.env.PATH}` });
  assert.match(r.salida, /corre la completa como siempre: no pude comparar/, r.salida);
  // la completa roja del árbol se guarda, y repetir sola su roja cierra como la 8.208 (el caso P9)
  const roja = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  const mr = conMarcador(roja, 'pt-roja');
  fs.writeFileSync(path.join(roja.pub, 'scripts/lib/pub-lib.js'), 'module.exports = 2;\n');
  r = portón(roja, { CLAUDE_CODE_SESSION_ID: mr.CLAUDE_CODE_SESSION_ID });
  assert.notStrictEqual(r.code, 0, r.salida);
  assert.ok((mr.leer().testsRedFull || []).length === 1, `guarda la completa roja del árbol\n${r.salida}`);
  fs.writeFileSync(path.join(roja.pub, 'scripts/lib/pub-lib.js'), 'module.exports = 1;\n');
  const sola = spawnSync('bash', [TEST_GATE, roja.priv, roja.story, '--suite', 'tests/pub-lib.test.js'], { encoding: 'utf8', cwd: roja.priv,
    env: entorno(roja.home, { TYCON_PRIVATE_TREE_TMP: path.join(roja.raiz, 'tmp'), CLAUDE_CODE_SESSION_ID: mr.CLAUDE_CODE_SESSION_ID }), timeout: 120000 });
  assert.strictEqual(sola.status, 0, `${sola.stdout}${sola.stderr}`);
  r = portón(roja, { CLAUDE_CODE_SESSION_ID: mr.CLAUDE_CODE_SESSION_ID });
  assert.strictEqual(r.code, 0, r.salida);
  assert.match(r.salida, /la carpeta cambió desde la completa roja \(scripts\/lib\/pub-lib\.js\)/, r.salida);
  assert.match(r.salida, /cierra con la completa de las \d\d:\d\d/, r.salida);
});

// El .gitignore real del privado deja dentro de git la carpeta de la evidencia, donde el portón deja su constancia.
const IGNORE_DEL_PRIVADO = '**/.advisors/*\n!**/.advisors/dod-runtime/\n';
function conIgnoreDelPrivado(lab) {
  escribir(lab.priv, '.gitignore', IGNORE_DEL_PRIVADO);
  git(lab.priv, 'add', '.gitignore');
  git(lab.priv, 'commit', '-q', '-m', 'ignore del privado');
}

test('PrivateTree_SavedRun_ClosesWhenNothingReadsTheChange @story-8.263 @ac-6 @ac-8 @ac-9 — lo que ninguna suite lee y la propia constancia del portón no impiden cerrar con lo guardado; un control del privado pide la completa', () => {
  // verde: un cambio del privado que ninguna suite lee cierra con lo guardado, no sale 7
  const lab = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  const perfil = cloneDelPerfil(lab);
  const m = conMarcador(lab, 'pt-nadie-lee');
  const env = { CLAUDE_CODE_SESSION_ID: m.CLAUDE_CODE_SESSION_ID, HARNESS_TEAM_DIR: perfil };
  fs.appendFileSync(path.join(lab.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  let r = portón(lab, env);
  assert.strictEqual(r.code, 0, r.salida);
  escribir(lab.priv, 'docs/nota.md', 'una nota que ninguna suite lee\n');
  r = portón(lab, env);
  assert.strictEqual(r.code, 0, r.salida);
  assert.doesNotMatch(r.salida, /sin acotar/, r.salida);
  assert.match(r.salida, /cierra con la completa de las \d\d:\d\d/, r.salida);
  // un control del privado (sus ganchos o sus pipelines) pide la completa, aunque ninguna suite lo lea
  for (const rel of ['scripts/hooks/nuevo.js', 'pipelines/nuevo.yml', 'scripts/hooks/nuevo+1.js']) {
    escribir(lab.priv, rel, '// un control\n');
    r = portón(lab, env);
    assert.match(r.salida, new RegExp(`corre la completa como siempre: cambió un control del privado \\(${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), r.salida);
  }
  // verde con el .gitignore del privado: volver a correr sin cambios no corre ninguna suite
  const otro = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  conIgnoreDelPrivado(otro);
  const perfil2 = cloneDelPerfil(otro);
  const m2 = conMarcador(otro, 'pt-ignore-verde');
  const env2 = { CLAUDE_CODE_SESSION_ID: m2.CLAUDE_CODE_SESSION_ID, HARNESS_TEAM_DIR: perfil2 };
  fs.appendFileSync(path.join(otro.pub, 'scripts/lib/pub-lib.js'), '// tocado\n');
  r = portón(otro, env2);
  assert.strictEqual(r.code, 0, r.salida);
  r = portón(otro, env2);
  assert.strictEqual(r.code, 0, r.salida);
  assert.match(r.salida, /la carpeta es la que midió la completa verde: no corro ninguna suite/, r.salida);
  // roja con el .gitignore del privado: la repetición sola deja su constancia y la completa igual cierra
  const roja = laboratorio({ modificar: ['Pub/scripts/lib/pub-lib.js'] });
  conIgnoreDelPrivado(roja);
  const mr = conMarcador(roja, 'pt-ignore-roja');
  fs.writeFileSync(path.join(roja.pub, 'scripts/lib/pub-lib.js'), 'module.exports = 2;\n');
  r = portón(roja, { CLAUDE_CODE_SESSION_ID: mr.CLAUDE_CODE_SESSION_ID });
  assert.notStrictEqual(r.code, 0, r.salida);
  fs.writeFileSync(path.join(roja.pub, 'scripts/lib/pub-lib.js'), 'module.exports = 1;\n');
  const sola = spawnSync('bash', [TEST_GATE, roja.priv, roja.story, '--suite', 'tests/pub-lib.test.js'], { encoding: 'utf8', cwd: roja.priv,
    env: entorno(roja.home, { TYCON_PRIVATE_TREE_TMP: path.join(roja.raiz, 'tmp'), CLAUDE_CODE_SESSION_ID: mr.CLAUDE_CODE_SESSION_ID }), timeout: 120000 });
  assert.strictEqual(sola.status, 0, `${sola.stdout}${sola.stderr}`);
  r = portón(roja, { CLAUDE_CODE_SESSION_ID: mr.CLAUDE_CODE_SESSION_ID });
  assert.strictEqual(r.code, 0, r.salida);
  assert.doesNotMatch(r.salida, /cambió después de repetir/, r.salida);
  assert.match(r.salida, /cierra con la completa de las \d\d:\d\d/, r.salida);
});
