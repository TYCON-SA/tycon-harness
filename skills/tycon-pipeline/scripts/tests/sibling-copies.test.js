#!/usr/bin/env node
'use strict';
// sibling-copies.test.js — una historia de un producto de tres repos que trabaja en copias aparte
// (`<Repo>--wt-<nombre>`, las que arma scripts/tools/tycon-worktree.sh) y declara sus archivos como
// `<RepoHermano>/archivo`.
//
//   C1-C2  la comparación con main ubica el archivo en la copia del hermano con el mismo sufijo, escrito como
//          `<Hermano>/x` o como `../<Hermano>/x`: no pide exención por «sin repo»
//   C3     un hermano sin copia con ese sufijo sigue como hoy: sin repo
//   C4     una carpeta con el sufijo que NO es una copia del hermano (otro repo con ese nombre) no cuenta
//   C4b    tampoco una carpeta suelta con el sufijo que comparte el `.git` del hermano sin ser raíz de repo
//   C6b    sin copias, `../<Hermano>/x` también se ubica en el repo hermano
//   C5     la copia del hermano con OTRO sufijo no cuenta
//   C6     sin copias: `<Hermano>/x` se ubica en el repo hermano de la corrida con ese nombre
//   C7     una ruta de hermano mal escrita (`//`, `a/../`) se normaliza: un comando que cambió no pasa sin compararse
//   M1     el control del commit calcula la matriz sobre una copia temporal de la historia: encuentra la carpeta de
//          los repos igual que la matriz del pipeline, aunque la historia no viva bajo `specs/`
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/sibling-copies.test.js < /dev/null

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const cp = () => require(path.join(SCRIPTS, 'lib', 'compare-previous.js'));
const rm = () => require(path.join(SCRIPTS, 'runtime-matrix.js'));

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const FECHA = '2026-01-01T10:00:00';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],{ env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

// Un comando con dos subcomandos: el cambio cae en `build`.
const CLI = ['#!/usr/bin/env node', "'use strict';", 'const sub = process.argv[2];', 'switch (sub) {', "  case 'build':", "    console.log('armado');", '    break;', '  default:', "    console.log('uso');", '}', ''].join('\n');
const CLI_CAMBIADO = CLI.replace("console.log('armado');", "console.log('armado!');");

function escribir(dir, archivos) {
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
}
/** Un repo con `main` y esos archivos commiteados. */
function repo(dir, archivos) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  escribir(dir, archivos);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  return dir;
}
/** La copia `<repo>--wt-<sufijo>` en su rama, como la arma tycon-worktree.sh. */
function copia(base, sufijo) {
  const destino = `${base}--wt-${sufijo}`;
  git(base, 'worktree', 'add', '-q', '-b', `wt/${sufijo}`, destino);
  return destino;
}

function historia(dir, archivos) {
  const p = path.join(dir, 'stories', 'story-1.1-fixture.md');
  escribir(dir, { 'stories/story-1.1-fixture.md': ['---', 'story: 1.1', 'status: in-progress', 'files_to_modify:', ...archivos.map((a) => `  - ${a}`), '---', '', '# Historia 1.1', ''].join('\n') });
  return p;
}

/**
 * El producto: `Prod` (historias), `ProdForms` (formularios: un comando y una configuración de pruebas) y `ProdBack`.
 * Con `sufijo`, la historia y los formularios trabajan en sus copias; el cambio al comando, sin commitear.
 */
function producto({ sufijo = 'x' } = {}) {
  const raiz = tmp('sibling-copies-');
  const prod = repo(path.join(raiz, 'Prod'), { 'README.md': 'prod\n' });
  const forms = repo(path.join(raiz, 'ProdForms'), { 'build-form.js': CLI, 'operador/jest.config.cjs': 'module.exports = {};\n' });
  const back = repo(path.join(raiz, 'ProdBack'), { 'tool.js': CLI });
  const prodCopia = sufijo ? copia(prod, sufijo) : prod;
  const formsCopia = sufijo ? copia(forms, sufijo) : forms;
  fs.writeFileSync(path.join(formsCopia, 'build-form.js'), CLI_CAMBIADO);
  fs.writeFileSync(path.join(formsCopia, 'operador', 'jest.config.cjs'), 'module.exports = { verbose: true };\n');
  return { raiz, prod, forms, back, prodCopia, formsCopia };
}

const resumen = (r) => ({ candidatos: r.candidatos.map((c) => [c.archivo, c.repo]), sinRepo: r.sinRepo.map((s) => s.archivo) });

test('C1 copias --wt-x: «ProdForms/build-form.js» se ubica en ProdForms--wt-x y no pide exención', () => {
  const P = producto();
  const storyPath = historia(P.prodCopia, ['ProdForms/build-form.js', 'ProdForms/operador/jest.config.cjs']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prodCopia, P.formsCopia] }));
  assert.deepStrictEqual(r.sinRepo, [], 'ningún archivo queda «sin repo»');
  // el comando es candidato (se compara con main); la configuración de pruebas no es un comando
  assert.deepStrictEqual(r.candidatos, [['build-form.js', P.formsCopia]]);
});

test('C2 copias --wt-x: «../ProdForms/build-form.js» también va a la copia, no al repo base', () => {
  const P = producto();
  const storyPath = historia(P.prodCopia, ['../ProdForms/build-form.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prodCopia, P.formsCopia] }));
  assert.deepStrictEqual(r, { candidatos: [['build-form.js', P.formsCopia]], sinRepo: [] });
});

test('C3 un hermano sin copia --wt-x sigue como hoy: sin repo', () => {
  const P = producto();
  const storyPath = historia(P.prodCopia, ['ProdBack/tool.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prodCopia, P.formsCopia] }));
  assert.deepStrictEqual(r, { candidatos: [], sinRepo: ['ProdBack/tool.js'] });
});

test('C4 una carpeta ProdBack--wt-x que no es copia de ProdBack no cuenta (sufijo falseado)', () => {
  const P = producto();
  // otro repo, con el archivo igual a main: si contara, el comando no sería candidato y no se pediría nada
  const falsa = repo(path.join(P.raiz, 'ProdBack--wt-x'), { 'tool.js': CLI });
  const storyPath = historia(P.prodCopia, ['ProdBack/tool.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prodCopia, P.formsCopia, falsa] }));
  assert.deepStrictEqual(r, { candidatos: [], sinRepo: ['ProdBack/tool.js'] });
});

test('C5 la copia de ProdForms con otro sufijo (--wt-y) no cuenta para una historia en --wt-x', () => {
  const P = producto();
  const ajena = copia(P.forms, 'y');
  const storyPath = historia(P.prodCopia, ['ProdForms/build-form.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prodCopia, ajena] }));
  assert.deepStrictEqual(r, { candidatos: [], sinRepo: ['ProdForms/build-form.js'] });
});

test('C6 sin copias: «ProdForms/build-form.js» se ubica en el repo hermano de la corrida', () => {
  const P = producto({ sufijo: null });
  const storyPath = historia(P.prod, ['ProdForms/build-form.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prod, P.forms] }));
  assert.deepStrictEqual(r, { candidatos: [['build-form.js', P.forms]], sinRepo: [] });
});

test('C4b una carpeta ProdBack--wt-x que comparte .git con ProdBack sin ser raíz de repo no cuenta', () => {
  // la carpeta de los repos es ella misma un repo, y ProdBack y ProdBack--wt-x son carpetas sueltas adentro
  // (el comando, sin commitear: si la carpeta suelta contara, el archivo quedaría «ubicado» y no pediría nada)
  const raiz = repo(tmp('sibling-copies-padre-'), { 'ProdBack/.keep': '', 'ProdBack--wt-x/.keep': '' });
  const prodCopia = copia(repo(path.join(tmp('sibling-copies-'), 'Prod'), { 'README.md': 'prod\n' }), 'x');
  const suelta = path.join(raiz, 'ProdBack--wt-x');
  fs.writeFileSync(path.join(suelta, 'tool.js'), CLI_CAMBIADO);
  const storyPath = historia(prodCopia, ['ProdBack/tool.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [prodCopia, suelta] }));
  assert.deepStrictEqual(r, { candidatos: [], sinRepo: ['ProdBack/tool.js'] });
});

test('C6b sin copias: «../ProdForms/build-form.js» se ubica en el repo hermano', () => {
  const P = producto({ sufijo: null });
  const storyPath = historia(P.prod, ['../ProdForms/build-form.js']);
  const r = resumen(cp().candidatos({ storyPath, repos: [P.prod, P.forms] }));
  assert.deepStrictEqual(r, { candidatos: [['build-form.js', P.forms]], sinRepo: [] });
});

test('C7 una ruta de hermano mal escrita («ProdForms//x», «ProdForms/a/../x») se compara igual: no pasa sin frenar', () => {
  const P = producto();
  for (const ruta of ['ProdForms//build-form.js', 'ProdForms/operador/../build-form.js']) {
    const storyPath = historia(P.prodCopia, [ruta]);
    const r = resumen(cp().candidatos({ storyPath, repos: [P.prodCopia, P.formsCopia] }));
    assert.deepStrictEqual(r, { candidatos: [['build-form.js', P.formsCopia]], sinRepo: [] }, ruta);
  }
});

test('M1 la matriz sobre la copia temporal del commit encuentra la carpeta de los repos, como la del pipeline', () => {
  const P = producto();
  escribir(P.prodCopia, { '.advisors/dod-runtime/.keep': '' });
  const storyPath = historia(P.prodCopia, ['ProdForms/build-form.js']);
  fs.appendFileSync(storyPath, ['## Acceptance Criteria', '', '1. **Given** un formulario, **Then** se arma.', ''].join('\n'));
  const delPipeline = rm().compute({ storyPath });
  // lo que hace el control del commit: el contenido staged en una carpeta temporal, con la ruta real y el repo aparte
  const copiaTmp = path.join(tmp('sibling-copies-staged-'), path.basename(storyPath));
  fs.copyFileSync(storyPath, copiaTmp);
  const delCommit = rm().compute({ storyPath: copiaTmp, keyStoryPath: storyPath, workspaceRoot: null, repoRoot: rm().discoverRepoRoot(storyPath) });
  assert.strictEqual(delPipeline.wsRoot, P.raiz);
  assert.strictEqual(delCommit.wsRoot, delPipeline.wsRoot);
  const noLeido = (m) => (m.warnings || []).filter((w) => /^No pude leer ProdForms\//.test(w));
  assert.deepStrictEqual(noLeido(delCommit), noLeido(delPipeline));
  assert.deepStrictEqual(noLeido(delCommit), []);
});
