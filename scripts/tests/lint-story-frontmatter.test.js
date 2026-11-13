#!/usr/bin/env node
/**
 * lint-story-frontmatter.test.js — el lint tiene que ver las stories DEL REPO, no sólo las que
 * están en `specs/stories/`.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────────────────────
 * El lint protege contra el peor modo de falla del harness: una story cuyo frontmatter no se
 * puede leer no da error — **desaparece en silencio** del validator, del backfill, de los
 * scripts de status y del hook de DoD.
 *
 * Pero decidir QUÉ lintear por la RUTA (`<repo>/specs/stories/`) no alcanza: en un repo con
 * otro layout el lint no miraría nada y diría "✅ OK": el
 * control que existe para que nada se pierda en silencio, perdiéndose en silencio.
 *
 * Por eso "esto es una story" es una decisión ESTRUCTURAL:
 *   (a) el archivo vive en una carpeta donde YA hay stories legibles, o
 *   (b) su frontmatter declara alguno de `story:` / `epic:` / `status:`.
 * (a) es la que importa: una story ROTA no se puede reconocer por sus campos —justamente porque
 * están rotos— pero sí por la compañía en la que vive.
 *
 * Correr: node --test scripts/tests/lint-story-frontmatter.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const LINT = path.join(RAIZ, 'scripts', 'lib', 'lint-story-frontmatter.js');

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}
function story(root, rel, fm) {
  return write(root, rel, `---\n${fm.join('\n')}\n---\n\n# story\n`);
}
function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync('node', [LINT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('lint: encuentra las stories del repo aunque no vivan en specs/stories/', () => {
  const root = mkRepo('lint-layout-');
  story(root, 'specs/bizuit-bpmn-mcp/4-42-sana.md', ['story: "4.42"', 'epic: 4', 'status: done']);
  // Rota: el frontmatter NUNCA cierra → el harness la saltea en silencio.
  write(root, 'specs/bizuit-bpmn-mcp/4-43-rota.md', '---\nstory: "4.43"\nepic: 4\nstatus: done\n\n# sin cierre\n');

  const r = run([], root);

  assert.equal(r.code, 1, `tiene que fallar: hay una story ilegible\n${r.out}`);
  assert.match(r.out, /4-43-rota\.md/, 'y nombrarla');
  assert.match(r.out, /frontmatter NO cierra/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: una story rota se reconoce por la COMPAÑÍA, no por sus campos', () => {
  // Es el caso que (b) sola no puede cubrir: si los campos están rotos, no hay campo que mirar.
  const root = mkRepo('lint-vecindad-');
  story(root, 'docs/epicas/1-1-sana.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  write(root, 'docs/epicas/1-2-rota.md', '---\nstory: "1.2"\nepic: 1\nstatus: done\n\n# sin cierre\n');
  // Un .md cualquiera en OTRA carpeta, con frontmatter que no es de story: no se lintea.
  write(root, 'docs/guias/como-desplegar.md', '---\ntitle: "guía"\n---\n\n# nada que ver\n');

  const r = run([], root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1-2-rota\.md/);
  assert.ok(!/como-desplegar/.test(r.out), `un doc que no es story no se lintea:\n${r.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: con el repo sano dice OK y CUÁNTAS revisó (un cero no es un OK)', () => {
  const root = mkRepo('lint-ok-');
  story(root, 'specs/mcp/1-1-a.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  story(root, 'specs/mcp/1-2-b.md', ['story: "1.2"', 'epic: 1', 'status: ready-for-dev']);

  const r = run([], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 revisadas/, `tiene que decir cuántas miró — "OK" sobre cero archivos no es OK:\n${r.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: por argumentos, filtra lo que NO es story (el hook puede pasarle todos los .md)', () => {
  const root = mkRepo('lint-args-');
  story(root, 'specs/mcp/1-1-a.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  const doc = write(root, 'README.md', '---\ntitle: "léeme"\n---\n\n# hola\n');
  const codigo = write(root, 'CHANGELOG.md', '# cambios\n');

  const r = run([path.join(root, 'specs/mcp/1-1-a.md'), doc, codigo], root);

  assert.equal(r.code, 0, `un README con frontmatter propio no puede reportarse como story rota:\n${r.out}`);
  assert.match(r.out, /1 revisadas/, 'sólo la story cuenta');

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: la evidencia de QA (specs/qa/<sid>-legibilidad.md, con «veredicto:») no es una story, aunque declare `story:`', () => {
  const root = mkRepo('lint-qa-');
  story(root, 'specs/story-2.1-primera.md', ['epic: 2', 'story: "2.1"', 'status: done']);
  // lo que deja la revisión de legibilidad: la identidad de la story a la que pertenece y el veredicto, nada de epic ni status
  const legibilidad = story(root, 'specs/qa/2.1-legibilidad.md', ['story: "2.1"', 'veredicto: OK', 'marcas: 3', 'resueltas: 3']);
  const ui = story(root, 'specs/qa/2.1-legibilidad-ui.md', ['story: "2.1"', 'veredicto: OK']);

  const todo = run([], root);
  assert.equal(todo.code, 0, `el repo con una revisión de legibilidad está sano:\n${todo.out}`);
  assert.match(todo.out, /1 revisadas/, 'sólo la story cuenta, no su evidencia de QA');
  const porArgumentos = run([legibilidad, ui], root);
  assert.equal(porArgumentos.code, 0, `pasada por argumento tampoco se lintea:\n${porArgumentos.out}`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: una story de verdad dentro de una carpeta qa/ (sin «veredicto:») sigue linteándose', () => {
  const root = mkRepo('lint-qa2-');
  const rota = story(root, 'qa/3-1-roto.md', ['story: "3.1"', 'status: ready-for-dev']);   // le falta epic:
  const sin = story(root, 'specs/qa/3.2-sin-veredicto.md', ['story: "3.2"', 'marcas: 1']);   // declara story: y no es evidencia

  const r = run([rota, sin], root);
  assert.equal(r.code, 1, `sin «veredicto:» sigue siendo una story, y está rota:\n${r.out}`);
  assert.match(r.out, /epic/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('lint: un archivo pasado por argumento que SÍ declara campos de story se lintea igual', () => {
  const root = mkRepo('lint-args2-');
  // Sin vecinas legibles: la única señal es que declara `story:`. Y le falta `epic:`.
  const rota = story(root, 'nuevo/2-1-primera.md', ['story: "2.1"', 'status: ready-for-dev']);

  const r = run([rota], root);
  assert.equal(r.code, 1, `le falta epic: y tiene que cazarlo\n${r.out}`);
  assert.match(r.out, /epic/);

  fs.rmSync(root, { recursive: true, force: true });
});

// ── T23 · R3_Lib_MovedRequires ─────────────────────────────────────────────────────────
// El lint vive en scripts/lib/: compila desde ahí, cada ruta relativa que escribe (`require('./x')`, o
// `path.join(__dirname, …)`) apunta a un archivo que existe —sus vecinos no llevan `lib/` adelante y el vocabulario de
// causas queda un nivel más arriba—, y lintea una story de juguete con `followup_reason:` sin perder el vocabulario. En
// la ruta de siempre queda el reemplazo generado (lo llaman los pre-commit de producto y agent-skills); esa ruta sale del
// mapa, y la copia pública, que no lo lleva, lo dice.

/** Las rutas relativas escritas en `file`: `require('./x')`, `require('../x')` y `path.join|resolve(__dirname, 'a', …)`. */
function relativePaths(file) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const out = [];
  for (const m of src.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) out.push({ spec: m[2], abs: path.resolve(dir, m[2]) });
  for (const m of src.matchAll(/path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]+\2)+)\s*\)/g)) {
    const parts = [...m[1].matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2]);
    out.push({ spec: `__dirname, ${parts.join(', ')}`, abs: path.resolve(dir, ...parts) });
  }
  return out;
}
const exists = (abs) => { try { require.resolve(abs); return true; } catch { return fs.existsSync(abs); } };
// Sólo la copia pública —que no lleva el mapa— se saltea. Con el mapa presente, ilegible o sin la entrada es un rojo:
// tratarlo como «copia pública» dejaría pasar en verde un reemplazo que falta.
const MAP_PATH = path.join(RAIZ, 'scripts', 'lib', 'renames.json');
const HAS_MAP = fs.existsSync(MAP_PATH);

test('T23 R3_Lib_MovedRequires — el lint compila desde scripts/lib/ y cada ruta relativa que escribe existe', () => {
  const chk = require('child_process').spawnSync(process.execPath, ['--check', LINT], { encoding: 'utf8' });
  assert.strictEqual(chk.status, 0, `compila desde scripts/lib/ (${chk.stderr})`);
  const rutas = relativePaths(LINT);
  assert.ok(rutas.length >= 4, `encontró sus rutas relativas (${rutas.length})`);
  const muertas = rutas.filter((r) => !exists(r.abs)).map((r) => r.spec);
  assert.deepStrictEqual(muertas, [], 'toda ruta relativa del lint resuelve desde scripts/lib/');
  assert.ok(!/require\(\s*path\.join\(\s*__dirname\s*,\s*['"]lib['"]/.test(fs.readFileSync(LINT, 'utf8')), 'sus vecinos de lib/ se piden sin `lib/` adelante');
});

test('T23 R3_Lib_MovedRequires — desde scripts/lib/ lintea una story de juguete y lee el vocabulario de causas', () => {
  const root = mkRepo('lint-t23-');
  story(root, 'specs/mcp/1-1-a.md', ['story: "1.1"', 'epic: 1', 'status: done']);
  const nueva = story(root, 'specs/mcp/1-2-b.md',
    ['story: "1.2"', 'epic: 1', 'status: ready-for-dev', 'followup_of: "1.1"', 'followup_reason: "defecto-propio"']);
  const env = { ...process.env };
  delete env.TYCON_CAUSES_PATH;
  let r;
  try {
    r = { code: 0, out: execFileSync('node', [LINT, nueva], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { r = { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /1 revisadas/, r.out);
  assert.ok(!/vocabulario de causas/.test(r.out), `encuentra rework-causes.json desde scripts/lib/:\n${r.out}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('T23 R3_Lib_MovedRequires — en la ruta de siempre queda el reemplazo generado que lanza el de lib/',
  { skip: !HAS_MAP && 'NO MEDIDO — copia pública sin el mapa' }, () => {
    const L = require(path.join(RAIZ, 'scripts', 'lib', 'legacy-names.js'));
    const R3_ENTRY = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')).entries
      .find((e) => e && e.batch === 'R3' && e.new === 'scripts/lib/lint-story-frontmatter.js');
    assert.ok(R3_ENTRY, 'el mapa no tiene la entrada de scripts/lib/lint-story-frontmatter.js');
    const viejo = path.join(RAIZ, R3_ENTRY.old);
    assert.ok(fs.existsSync(viejo), `${R3_ENTRY.old} existe`);
    assert.ok(L.isGeneratedShim(R3_ENTRY.old, fs.readFileSync(viejo, 'utf8')), `${R3_ENTRY.old} es el reemplazo generado, tal cual`);
    assert.strictEqual(path.resolve(L.shimTarget(viejo)), LINT, `${R3_ENTRY.old} lanza el de scripts/lib/`);
  });

// ── Los archivos a modificar existen ─────────────────────────────────────────────────────────────────────────────────
// Una story que nombra una carpeta de funcionalidad del backend y un modal del frontend que nadie creó se frena al
// nacer. El producto de juguete tiene el repo de historias y los dos de código al lado.
// Los commits de las pruebas, con fecha fija y sin el mantenimiento automático de git.
const GIT_ENV = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const commit = (cwd, ...args) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', ...args], { cwd, env: GIT_ENV });

function productoConCodigo({ conFront = true } = {}) {
  const prod = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-rutas-'));
  const proj = path.join(prod, 'Project');
  fs.mkdirSync(proj);
  execFileSync('git', ['init', '-q'], { cwd: proj });
  execFileSync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Acme/_git/Project'], { cwd: proj });
  commit(proj, '--allow-empty', '-m', 'inicio');
  write(prod, 'Backend/.git/HEAD', 'ref: refs/heads/main\n');
  write(prod, 'Backend/.git/config', '[remote "origin"]\n\turl = https://dev.azure.com/acme/Acme/_git/Backend\n');
  write(prod, 'Backend/src/AcmeBackend/Features/Acciones/AccionesService.cs', '// acciones\n');
  if (conFront) {
    write(prod, 'FrontEnd/.git/HEAD', 'ref: refs/heads/main\n');
    write(prod, 'FrontEnd/.git/config', '[remote "origin"]\n\turl = https://dev.azure.com/acme/Acme/_git/FrontEnd\n');
    write(prod, 'FrontEnd/acme-admin/src/screens/GestoresScreen.tsx', '// pantalla\n');
  }
  return { prod, proj };
}
const HISTORIA_65 = (modificar, crear = []) => [
  'story: "6.5"', 'epic: 6', 'status: ready-for-dev',
  'files_to_modify:', ...modificar.map((f) => `  - "${f}"`),
  ...(crear.length ? ['files_to_create:', ...crear.map((f) => `  - "${f}"`)] : []),
];

test('T41 FilesToModify_Inventados_StoryNueva_Frena: nombra las rutas que no existen en el código del producto', () => {
  const { proj } = productoConCodigo();
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65([
    'src/AcmeBackend/Features/AbmGestores/GestoresEndpoints.cs',
    'acme-admin/src/components/modals/GestorFormModal.tsx',
    'acme-admin/src/screens/GestoresScreen.tsx',
    'src/AcmeBackend/Features/Acciones/AccionesService.cs',
  ]));
  const r = run([f], proj);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /AbmGestores\/GestoresEndpoints\.cs/);
  assert.match(r.out, /GestorFormModal\.tsx/);
  const problema = (r.out.match(/Problema: .*no existen.*/) || [''])[0];
  assert.doesNotMatch(problema, /GestoresScreen\.tsx|AccionesService\.cs/, 'las que existen no se nombran');
});

test('T42 FilesToModify_Existen_Y_ACrearNuevos_Pasa: files_to_create está exento', () => {
  const { proj } = productoConCodigo();
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65(
    ['acme-admin/src/screens/GestoresScreen.tsx', 'Backend/src/AcmeBackend/Features/Acciones/AccionesService.cs'],
    ['acme-admin/src/components/modals/GestorFormModal.tsx']));
  const r = run([f], proj);
  assert.strictEqual(r.code, 0, r.out);
});

test('T43 FilesToModify_RepoDeCodigoSinClonar_Avisa: no frena, dice que no encuentra dónde está', () => {
  const { proj } = productoConCodigo({ conFront: false });
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65(['acme-admin/src/components/modals/GestorFormModal.tsx']));
  const r = run([f], proj);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /no encuentro.*GestorFormModal\.tsx/s);
});

test('T44 FilesToModify_StoryQueYaExistia_Avisa: una story vieja con un archivo que se movió no frena', () => {
  const { proj } = productoConCodigo();
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65(['src/AcmeBackend/Features/AbmGestores/GestoresEndpoints.cs']));
  execFileSync('git', ['add', '.'], { cwd: proj });
  commit(proj, '-m', 'story');
  const r = run([f], proj);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /ya existían.*AbmGestores/s);
});

test('T45 FilesToModify_NotasYComodines_NoSeJuzgan: lo que no es una ruta clara se saltea', () => {
  const { proj } = productoConCodigo();
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', [
    'story: "6.5"', 'epic: 6', 'status: ready-for-dev', 'files_to_modify:',
    '  - "(tanda B) src/AcmeBackend/Features/Otra/X.cs"',
    '  - src/AcmeBackend/Features/*/Y.cs',
    '  - acme-admin/src/{a,b}.tsx',
    '  - agents/<los revisores>.md   # se borran',
  ]);
  const r = run([f], proj);
  assert.strictEqual(r.code, 0, r.out);
});

test('T46 FilesToModify_DesdeUnWorktree_LeeElCompaneroDeclarado: la ruta relativa del compañero se resuelve desde el checkout principal', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-wt-'));
  const code = path.join(base, 'code');
  write(base, 'code/scripts/lib/real.js', '// real\n');
  execFileSync('git', ['init', '-q'], { cwd: code });
  const priv = path.join(base, 'privado');
  fs.mkdirSync(priv);
  execFileSync('git', ['init', '-q'], { cwd: priv });
  write(priv, '.tycon/advisors.yaml', 'evidence:\n  companion_repos:\n    - ../code\n');
  write(priv, 'scripts/x.js', '// el privado también tiene scripts/\n');
  execFileSync('git', ['add', '.'], { cwd: priv });
  commit(priv, '-m', 'inicio');
  const wt = path.join(base, 'worktrees', 'privado-wt');
  execFileSync('git', ['-c', 'maintenance.auto=false', 'worktree', 'add', '-q', wt], { cwd: priv, env: GIT_ENV });
  const f = story(wt, 'specs/story-9.1-algo.md', ['story: "9.1"', 'epic: 9', 'status: ready-for-dev', 'files_to_modify:', '  - "scripts/lib/real.js"']);
  const r = run([f], wt);
  assert.strictEqual(r.code, 0, r.out);
});

test('T47 FilesToModify_SoloEnElRemoto_NoFrena: un clon atrasado no hace inventado un archivo que ya está en su rama principal', () => {
  const { prod, proj } = productoConCodigo();
  const back = path.join(prod, 'Backend');
  fs.rmSync(path.join(back, '.git'), { recursive: true, force: true });
  execFileSync('git', ['init', '-q'], { cwd: back });
  execFileSync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Acme/_git/Backend'], { cwd: back });
  write(prod, 'Backend/src/AcmeBackend/Features/Nuevo/NuevoService.cs', '// nuevo\n');
  execFileSync('git', ['add', '.'], { cwd: back });
  commit(back, '-m', 'con el archivo');
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: back });
  fs.rmSync(path.join(back, 'src', 'AcmeBackend', 'Features', 'Nuevo'), { recursive: true, force: true });
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65(['src/AcmeBackend/Features/Nuevo/NuevoService.cs']));
  const r = run([f], proj);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /al día/);
});

// 🔴 Falla con: la consulta a un repo hermano hereda el GIT_DIR que git le pone al gancho de un commit. Esa variable le
// gana a `-C`: se le pregunta al repo del commit, y un archivo que está en la rama principal del hermano se da por
// inventado; o al revés, el repo del commit contesta por un hermano que no tiene el archivo.
function hermanoConArchivoSoloEnElRemoto(prod) {
  const back = path.join(prod, 'Backend');
  fs.rmSync(path.join(back, '.git'), { recursive: true, force: true });
  execFileSync('git', ['init', '-q'], { cwd: back, env: GIT_ENV });
  execFileSync('git', ['remote', 'add', 'origin', 'https://dev.azure.com/acme/Acme/_git/Backend'], { cwd: back, env: GIT_ENV });
  write(prod, 'Backend/src/AcmeBackend/Features/Nuevo/NuevoService.cs', '// nuevo\n');
  execFileSync('git', ['add', '.'], { cwd: back, env: GIT_ENV });
  commit(back, '-m', 'con el archivo');
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: back, env: GIT_ENV });
  fs.rmSync(path.join(back, 'src', 'AcmeBackend', 'Features', 'Nuevo'), { recursive: true, force: true });
}
function dentroDelCommitDe(repo) {
  const gitDir = path.join(repo, '.git');
  return { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: path.join(gitDir, 'index') };
}
function runConEnv(args, cwd, env) {
  try {
    return { code: 0, out: execFileSync('node', [LINT, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('T48 FilesToModify_DentroDeUnCommit_MiraAlHermano: el GIT_DIR del commit no tapa la rama principal del repo hermano', () => {
  const { prod, proj } = productoConCodigo();
  hermanoConArchivoSoloEnElRemoto(prod);
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65(['src/AcmeBackend/Features/Nuevo/NuevoService.cs']));
  const r = runConEnv([f], proj, dentroDelCommitDe(proj));
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /al día/);
});

test('T49 FilesToModify_DentroDeUnCommit_OtroRepoNoContesta: el repo del GIT_DIR no responde por los del producto', () => {
  const { prod, proj } = productoConCodigo();
  hermanoConArchivoSoloEnElRemoto(prod);
  const ruta = 'src/AcmeBackend/Features/Inventado/Inventado.cs';
  const otro = mkRepo('lint-otro-repo-');
  write(otro, ruta, '// sólo en otro repo\n');
  execFileSync('git', ['add', '.'], { cwd: otro, env: GIT_ENV });
  commit(otro, '-m', 'con el archivo');
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: otro, env: GIT_ENV });
  const f = story(proj, 'specs/story-6.5-cbu-del-gestor.md', HISTORIA_65([ruta]));
  const r = runConEnv([f], proj, dentroDelCommitDe(otro));
  assert.notStrictEqual(r.code, 0, r.out);
  assert.match(r.out, /Inventado\.cs/);
});

// 🔴 Falla con: un comentario en el renglón de `files:` o entre `files:` y su primer ítem, que el lint tomaba como «no es
// una lista» y frenaba una historia que el lector del bloque acepta.
test('Q18 FilesDeParte_ComentarioAntesDeLosItems_NoFrena: el lint lee la lista como el lector del bloque', () => {
  const { filesDeParteMalos } = require(LINT);
  const { parsePipelinesBlock } = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'story-checks.js'));
  const bloques = [
    'pipelines:\n  - name: A\n    files:\n      # el código de la parte\n\n      - src/a.js\n',
    'pipelines:\n  - name: A\n    files:   # los de la tanda A\n      - src/a.js\n',
    'pipelines:\n  - name: A\n    files: # el código de la parte\n      # y un comentario más\n      - src/a.js\n',
  ];
  for (const fm of bloques) {
    assert.deepStrictEqual(filesDeParteMalos(fm), [], fm);
    assert.deepStrictEqual(parsePipelinesBlock(`---\n${fm}---\n`)[0].files, ['src/a.js'], fm);
  }
  // un comentario sin ítems debajo sigue sin ser una lista
  assert.deepStrictEqual(filesDeParteMalos('pipelines:\n  - name: A\n    files: # nada\n    status: pending\n'), ['A']);
});

// ── «Nace» durante un merge ──────────────────────────────────────────────────────────────────────────────────────────
// Traer main a una rama atrasada mete en lo preparado para el commit las historias que main tiene y la rama no conocía.
// Su historia de git vive en la cabeza del merge, no en HEAD: si «nace» sólo pregunta a HEAD, el lint las trata como
// recién escritas y frena por reglas que a una historia vieja sólo le avisan.
// 🔴 Falla con: `naceAhora` mirando sólo HEAD (el merge no se puede commitear sin tocar las historias de main).
const gitT = (cwd, ...args) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
  { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FOLLOWUP_OF = path.join(RAIZ, 'scripts', 'lib', 'followup-of.js');
const HISTORIA_DE_MAIN = [
  'story: "9.1"', 'epic: 9', 'status: ready-for-dev', 'ado_work_item: 101',
  'followup_of:', '  - id: "1.1"', '    type: "fix"',
  'files_to_modify:', '  - "src/AcmeBackend/Features/AbmGestores/GestoresEndpoints.cs"',
];
// las tres reglas que a una historia nueva la frenan (o, la del nombre viejo del pedido, la anotan) y a una vieja sólo
// le avisan: causa del reproceso, archivos inventados y `ado_work_item:`
const CAMPO_VIEJO = (nombre) => new RegExp(`${nombre.replace(/\./g, '\\.')}: nace con \`ado_work_item:\``);

/** El producto de juguete con una rama creada antes de que main tuviera su historia de seguimiento (y lo que se pida en main). */
function ramaAtrasada(enMain = {}) {
  const { prod, proj } = productoConCodigo();
  const principal = gitT(proj, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  gitT(proj, 'branch', 'atrasada');
  story(proj, 'specs/story-9.1-de-main.md', HISTORIA_DE_MAIN);
  for (const [rel, fm] of Object.entries(enMain)) story(proj, rel, fm);
  gitT(proj, 'add', '.');
  gitT(proj, 'commit', '-q', '-m', 'historias de main');
  gitT(proj, 'checkout', '-q', 'atrasada');
  write(proj, 'notas.txt', 'trabajo de la rama\n');
  gitT(proj, 'add', '.');
  gitT(proj, 'commit', '-q', '-m', 'trabajo de la rama');
  return { prod, proj, principal };
}
const traerMain = (proj, principal) => gitT(proj, 'merge', '--no-ff', '--no-commit', principal);
const mergeHeadDe = (proj) => path.resolve(proj, gitT(proj, 'rev-parse', '--git-path', 'MERGE_HEAD').trim());

test('NaceAhora_MergeBringsMainStory_IsExisting @story-8.269 @ac-6', () => {
  const { proj, principal } = ramaAtrasada();
  traerMain(proj, principal);
  assert.ok(fs.existsSync(mergeHeadDe(proj)), 'hay un merge en curso');
  const r = run([path.join(proj, 'specs', 'story-9.1-de-main.md')], proj);
  assert.strictEqual(r.code, 0, `la historia de main no frena el merge\n${r.out}`);
  assert.match(r.out, /ya existían.*story-9\.1-de-main\.md/s, 'el archivo inventado se avisa como de una historia vieja');
  assert.match(r.out, /story\(s\) con seguimiento .*sin causa declarada/, 'sin `followup_reason:` suma a las que ya existían');
  assert.doesNotMatch(r.out, CAMPO_VIEJO('story-9.1-de-main.md'), 'el nombre viejo del pedido no se anota en una historia vieja');
});

test('NaceAhora_MergeBringsRenamedStory_FoundByStoryId @story-8.269 @ac-7', () => {
  // la rama escribe la historia con otro nombre: ese nombre no tiene historia en HEAD ni en main, y sólo la identidad
  // declarada (`story:`) la encuentra en la cabeza del merge
  const { proj, principal } = ramaAtrasada({ 'specs/story-9.2-nombre-de-main.md': ['story: "9.2"', 'epic: 9', 'status: ready-for-dev'] });
  const deLaRama = story(proj, 'specs/story-9.2-nombre-de-la-rama.md', ['story: "9.2"', 'epic: 9', 'status: ready-for-dev']);
  const { naceAhora } = require(FOLLOWUP_OF);
  assert.strictEqual(naceAhora(deLaRama, '9.2'), true, 'sin merge en curso nace: ni HEAD ni su nombre la conocen');
  traerMain(proj, principal);
  assert.strictEqual(naceAhora(deLaRama, '9.2'), false, 'durante el merge, main ya tiene una historia con ese `story:`');
});

test('NaceAhora_NewStoryDuringMerge_StillStops @story-8.269 @ac-8', () => {
  const { proj, principal } = ramaAtrasada();
  traerMain(proj, principal);
  const nueva = story(proj, 'specs/story-9.3-nueva.md', [
    'story: "9.3"', 'epic: 9', 'status: ready-for-dev',
    'files_to_modify:', '  - "src/AcmeBackend/Features/Inexistente/Inexistente.cs"',
  ]);
  const seguimiento = story(proj, 'specs/story-9.6-seguimiento.md', [
    'story: "9.6"', 'epic: 9', 'status: ready-for-dev', 'ado_work_item: 102',
    'followup_of:', '  - id: "1.1"', '    type: "fix"',
  ]);
  const r = run([path.join(proj, 'specs', 'story-9.1-de-main.md'), nueva, seguimiento], proj);
  assert.strictEqual(r.code, 1, `las historias nuevas de la rama frenan como siempre\n${r.out}`);
  const frenadas = (r.out.match(/^❌ (?!\d).*$/mg) || []).join('\n');
  assert.match(frenadas, /story-9\.3-nueva\.md/, 'la historia nueva con un archivo inventado frena');
  assert.match(r.out, /Problema: .*Inexistente\.cs/);
  assert.match(frenadas, /story-9\.6-seguimiento\.md/, 'la historia nueva de seguimiento sin causa frena');
  assert.match(r.out, /Problema: la story NACE declarando `followup_of:`/);
  assert.match(r.out, CAMPO_VIEJO('story-9.6-seguimiento.md'), 'el nombre viejo del pedido se anota en la historia nueva');
  assert.doesNotMatch(frenadas, /story-9\.1-de-main\.md/, 'la historia de main no frena: ni por la causa ni por los archivos');
  assert.doesNotMatch(r.out, CAMPO_VIEJO('story-9.1-de-main.md'), 'ni se anota por el nombre viejo del pedido');
});

/** `naceAhora` en un proceso aparte, con cada llamada a git anotada (vale igual en Windows que en Linux y Mac). */
function naceAhoraContando(abs, storyId) {
  const programa = `
    const cp = require('child_process');
    const original = cp.execFileSync;
    const llamadas = [];
    cp.execFileSync = (cmd, args, opts) => { if (cmd === 'git') llamadas.push(args); return original(cmd, args, opts); };
    const { naceAhora } = require(${JSON.stringify(FOLLOWUP_OF)});
    const nace = naceAhora(${JSON.stringify(abs)}, ${JSON.stringify(storyId)});
    process.stdout.write(JSON.stringify({ nace, llamadas }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', programa], { encoding: 'utf8' }));
}

test('NaceAhora_UnreadableMergeHead_CountsAsExisting @story-8.269 @ac-9 @ac-10', () => {
  const { proj } = ramaAtrasada();
  const nueva = story(proj, 'specs/story-9.4-nueva.md', ['story: "9.4"', 'epic: 9', 'status: ready-for-dev']);
  const vieja = path.join(proj, 'specs', 'story-9.4-vieja.md');
  story(proj, 'specs/story-9.4-vieja.md', ['story: "9.5"', 'epic: 9', 'status: ready-for-dev']);
  gitT(proj, 'add', vieja);
  gitT(proj, 'commit', '-q', '-m', 'historia vieja');
  const mergeHead = mergeHeadDe(proj);

  // sin merge en curso: la historia nueva nace, y la única llamada nueva es la que ubica MERGE_HEAD, al final
  const sinMerge = naceAhoraContando(nueva, '9.4');
  assert.strictEqual(sinMerge.nace, true);
  assert.deepStrictEqual(sinMerge.llamadas.at(-1), ['rev-parse', '--git-path', 'MERGE_HEAD']);
  assert.strictEqual(sinMerge.llamadas.length, 7, `las seis de siempre más la de MERGE_HEAD: ${JSON.stringify(sinMerge.llamadas)}`);

  // una historia con historia en HEAD: las dos llamadas de siempre, ninguna de más
  const conHistoria = naceAhoraContando(vieja, '9.5');
  assert.strictEqual(conHistoria.nace, false);
  assert.deepStrictEqual(conHistoria.llamadas, [['rev-parse', '--verify', 'HEAD'], ['log', '-1', '--follow', '--format=%H', '--', 'story-9.4-vieja.md']]);

  // un MERGE_HEAD vacío cuenta como sin merge
  fs.writeFileSync(mergeHead, '');
  assert.strictEqual(naceAhoraContando(nueva, '9.4').nace, true, 'MERGE_HEAD vacío: lo mismo que sin merge');

  // una cabeza que no existe en el repo: no se puede decidir, cuenta como existente (avisa, no frena)
  fs.writeFileSync(mergeHead, `${'0123456789abcdef'.repeat(2)}01234567\n`);
  assert.strictEqual(naceAhoraContando(nueva, '9.4').nace, false, 'una cabeza que no resuelve: existente');

  // un MERGE_HEAD que no se puede leer (acá, una carpeta en su lugar): no se puede decidir, existente
  fs.rmSync(mergeHead, { force: true });
  fs.mkdirSync(mergeHead);
  assert.strictEqual(naceAhoraContando(nueva, '9.4').nace, false, 'MERGE_HEAD ilegible: existente');
  fs.rmSync(mergeHead, { recursive: true, force: true });
});

// 🔴 Falla con: la búsqueda por `story:` sin comillas como texto fijo — `story: 9.2` aparece dentro de `story: 9.26`, y
// una historia nueva cuyo número es el comienzo de otro que ya existe se da por existente (el lint no la frena).
test('NaceAhora_StoryIdPrefixOfAnother_StillBorn @story-8.269 @ac-7', () => {
  const { proj, principal } = ramaAtrasada({ 'specs/story-9.27-de-main.md': ['story: 9.27', 'epic: 9', 'status: ready-for-dev'] });
  story(proj, 'specs/story-9.26-vieja.md', ['story: 9.26', 'epic: 9', 'status: ready-for-dev']);
  gitT(proj, 'add', '.');
  gitT(proj, 'commit', '-q', '-m', 'historia vieja de la rama');
  const { naceAhora } = require(FOLLOWUP_OF);
  const enHead = story(proj, 'specs/story-9.2-nueva.md', ['story: 9.2', 'epic: 9', 'status: ready-for-dev']);
  assert.strictEqual(naceAhora(enHead, '9.2'), true, 'HEAD tiene la 9.26, no la 9.2');
  assert.strictEqual(naceAhora(enHead, '9.26'), false, 'el número entero sí la encuentra');
  traerMain(proj, principal);
  assert.strictEqual(naceAhora(enHead, '9.2'), true, 'la cabeza del merge tiene la 9.27, no la 9.2');
});
