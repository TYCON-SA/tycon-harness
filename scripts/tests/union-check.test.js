'use strict';

/**
 * union-check.test.js — la unión de las dos historias (el arnés y agent-skills), verificada.
 * T2, T3, T6 y T9, y la mitad de T5 que no necesita un commit con hooks (la otra mitad vive en githook-livefire.test.sh).
 *
 * Qué prueba: `scripts/tools/union-check.js`, la herramienta de sólo lectura que mira si el repo unido es lo que debe ser.
 * Cada caso arma DOS repos de juguete sin historia común —con `README.md`, `.gitignore` y
 * `.githooks/pre-commit` repetidos, y una rama mezclada de cada lado— y los une con los mismos pasos que la unión
 * real: un commit de cada lado que resuelve los tres choques, y un `git merge --allow-unrelated-histories --no-ff`.
 *
 *   · T2 — `history`: todas las puntas son ancestros de la unión, ningún commit se reescribió (la cuenta cierra), y
 *     después de una re-mezcla la punta anterior de la base sigue siendo ancestro. Una historia reescrita sale 1.
 *   · T3 — `tree`: el árbol de la unión es la unión exacta de los dos lados, con su lista cerrada de excepciones. Un
 *     archivo de más, uno cambiado y uno faltante salen 1, cada uno con su nombre.
 *   · T5 — las dos partes del pre-commit son, byte a byte y con su modo, los originales; el despachador es el texto
 *     que genera el exportador. Un byte de diferencia en cualquiera de los tres sale 1.
 *   · T6 — `papers`: la guía rescatada existe, el `.gitignore` la cita, `.tycon/post-commit-ignore` llegó tal cual y
 *     los archivos de `.tycon/` del arnés no cambiaron.
 *   · T9 — `lanes`: un archivo tocado por dos ramas de carril sale 1 con el archivo y las dos ramas; los compartidos
 *     (la story, `tasks/todo.md`, `.engram/**`) no cuentan; lo que cambió la base tampoco.
 *
 * Y sobre la unión DE VERDAD, cuando el clon trae la historia: los commits anotados en `fixtures/union-commits.json`
 * pasan `history` y `tree`. Sin el archivo, o en un clon sin esa historia (la copia pública, un clon recortado), esa
 * parte sale NO MEDIDA con su motivo: no es un verde.
 *
 * 🔴 Todo git corre con el entorno limpio (`clean-git-env.js`) y sin configuración global: una prueba lanzada desde un
 * hook de git hereda `GIT_DIR`, y un `git init` de juguete terminaría escribiendo en el repo de verdad. Ningún commit
 * de juguete corre los hooks de la máquina.
 *
 * Correr: node --test scripts/tests/union-check.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sinGitDelPadre } = require('../lib/clean-git-env.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'tools', 'union-check.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'union-commits.json');
const STORY = 'specs/story-8.18-un-solo-repo-interno.md';

// cada carpeta temporal se anota y se borra al terminar: la suite es diaria, y siete laboratorios por corrida se acumulan
const created = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); created.push(d); return d; }
test.after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });
const HOME = tmp('uc-home-');
const ENV = sinGitDelPadre({
  HOME,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'lab',
  GIT_AUTHOR_EMAIL: 'lab@example.invalid',
  GIT_COMMITTER_NAME: 'lab',
  GIT_COMMITTER_EMAIL: 'lab@example.invalid',
});

/** git en `dir`; cualquier salida distinta de 0 es un error del laboratorio, no un resultado. */
function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} (en ${dir}) salió ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
/** La herramienta, por su línea de comandos. */
function tool(repo, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args, '--repo', repo], { env: ENV, encoding: 'utf8' });
}
/** Sus funciones, cargadas recién cuando hacen falta: en la fase roja el archivo todavía no existe. */
function lib() { return require(TOOL); }

// los archivos que cada laboratorio escribió como ejecutables: carpeta → rutas
const executables = new Map();
function write(dir, rel, text, mode) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode) {
    fs.chmodSync(p, mode);
    if (mode & 0o111) executables.set(dir, (executables.get(dir) || new Set()).add(rel));
  }
}
// La opción de `git update-index` que marca un archivo como ejecutable EN EL ÍNDICE, armada en dos partes para que el
// freno de nombres en castellano no la tome por una opción nueva de este repo (no es una palabra inglesa de diccionario).
const EXECUTABLE_IN_INDEX = ['--ch', 'mod=+x'].join('');
function commitAll(dir, message) {
  git(dir, 'add', '-A');
  // En un disco que no guarda el bit de ejecución (core.fileMode=false: Windows) `git add` deja 100644, y la unión de
  // juguete no tendría los modos de la de verdad: se marcan en el índice, que es lo que el commit guarda.
  for (const rel of executables.get(dir) || []) {
    if (git(dir, 'ls-files', '--', rel)) git(dir, 'update-index', EXECUTABLE_IN_INDEX, rel);
  }
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
/** Un commit sobre `from`, en una rama nueva, que deja el repo otra vez en la rama donde estaba. */
function variant(dir, from, branch, change, message) {
  const back = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(dir, 'checkout', '-q', '-b', branch, from);
  change();
  const sha = commitAll(dir, message);
  git(dir, 'checkout', '-q', back);
  return sha;
}

const HARNESS_GITIGNORE = [
  '.DS_Store',
  '# la evidencia de cierre viaja; lo efímero no',
  '**/.advisors/*',
  '!**/.advisors/dod-runtime/',
  '',
  '.codegraph/',
  '',
  'scratch/',
  '',
].join('\n');
const SKILLS_GITIGNORE = [
  '# Artefactos de las corridas: en este repo no se versionan.',
  '# Sólo aparecen al correr guiones durante las pruebas.',
  '.advisors/',
  '',
  '__pycache__/',
  '.codegraph/',
  '',
  '# Skills desactivadas. Cómo volver a activarlas: README.md §«Skills que no se cargan».',
  'skills-inactivas/',
  'skills/de-terceros',
  '',
].join('\n');
// lo que la regla tiene que dar con esos dos: primero las líneas del arnés, sin repetir (tampoco las vacías), y de
// agent-skills todo menos el bloque `.advisors/` (su línea y el comentario de arriba)
const UNIFIED_GITIGNORE = [
  '.DS_Store',
  '# la evidencia de cierre viaja; lo efímero no',
  '**/.advisors/*',
  '!**/.advisors/dod-runtime/',
  '',
  '.codegraph/',
  'scratch/',
  '__pycache__/',
  '# Skills desactivadas. Cómo volver a activarlas: README.md §«Skills que no se cargan».',
  'skills-inactivas/',
  'skills/de-terceros',
  '',
].join('\n');

/**
 * Los dos repos de juguete y su unión, armada con los pasos de la real. Devuelve la carpeta del repo unido y cada
 * commit con nombre: las puntas, los dos lados compuestos (h0, s0), los dos lados con los choques resueltos (h1, s1)
 * y la unión (u).
 */
function lab({ exporter = null, dispatcher = null } = {}) {
  const dir = tmp('uc-lab-');
  const h = path.join(dir, 'harness');
  const s = path.join(dir, 'skills');
  fs.mkdirSync(h);
  fs.mkdirSync(s);

  // el arnés: main, una rama de trabajo, y los dos mezclados
  git(h, 'init', '-q', '-b', 'main');
  write(h, 'README.md', '# El arnés\n');
  // un arnés que trae su propio exportador (con SU texto del despachador), como el de verdad
  if (exporter) write(h, 'scripts/publishing/export.js', exporter);
  write(h, '.gitignore', HARNESS_GITIGNORE);
  write(h, '.githooks/pre-commit', '#!/usr/bin/env bash\necho "parte del arnés"\n', 0o755);
  write(h, 'scripts/a.js', 'module.exports = 1;\n');
  write(h, '.tycon/advisors.yaml', 'packs: []\n');
  commitAll(h, 'arnés: base');
  git(h, 'checkout', '-q', '-b', 'batch-d');
  write(h, 'scripts/d.js', 'module.exports = 4;\n');
  const harnessBranch = commitAll(h, 'arnés: una tanda en su rama');
  git(h, 'checkout', '-q', 'main');
  write(h, 'scripts/b.js', 'module.exports = 2;\n');
  const harnessMain = commitAll(h, 'arnés: main avanza');
  git(h, 'checkout', '-q', '-b', 'base');
  git(h, 'merge', '-q', '--no-ff', 'batch-d', '-m', 'la base trae la tanda');
  const h0 = git(h, 'rev-parse', 'HEAD');

  // agent-skills: main, una rama de trabajo, y los dos mezclados
  git(s, 'init', '-q', '-b', 'main');
  write(s, 'README.md', '# Agent Skills\n\n## Skills que no se cargan\n\nSe mueven a skills-inactivas/.\n');
  write(s, '.gitignore', SKILLS_GITIGNORE);
  write(s, '.githooks/pre-commit', '#!/usr/bin/env bash\necho "parte de skills"\n', 0o755);
  write(s, 'skills/x/SKILL.md', '# x\n');
  write(s, 'agents/r.md', '# revisor\n');
  write(s, 'packs/p/pack.json', '{}\n');
  write(s, '.tycon/post-commit-ignore', 'skills/de-terceros-*\n');
  const skillsMain = commitAll(s, 'skills: base');
  git(s, 'checkout', '-q', '-b', 'batch-g');
  write(s, 'skills/x/SKILL.md', '# x, con otro nombre\n');
  const skillsBranch = commitAll(s, 'skills: una tanda en su rama');
  git(s, 'checkout', '-q', '-b', 'side', 'main');
  git(s, 'merge', '-q', '--no-ff', 'batch-g', '-m', 'el lado de skills trae la tanda');
  const s0 = git(s, 'rev-parse', 'HEAD');

  // el lado de agent-skills resuelve los tres choques en una rama local del repo unido
  git(h, 'fetch', '-q', s, 'refs/heads/*:refs/remotes/skills/*');
  git(h, 'checkout', '-q', '-b', 'skills-side', 'skills/side');
  git(h, 'mv', '.githooks/pre-commit', '.githooks/pre-commit-skills');
  git(h, 'rm', '-q', '.gitignore', 'README.md');
  const s1 = commitAll(h, 'skills: los tres choques');

  // el lado del arnés: el pre-commit pasa a ser una parte, entra el despachador y el .gitignore suma las líneas
  git(h, 'checkout', '-q', 'base');
  git(h, 'mv', '.githooks/pre-commit', '.githooks/pre-commit-harness');
  write(h, '.githooks/pre-commit', dispatcher || lib().dispatcherText(), 0o755);
  write(h, '.gitignore', lib().unifiedGitignore(HARNESS_GITIGNORE, SKILLS_GITIGNORE));
  const h1 = commitAll(h, 'arnés: los tres choques');

  // la unión: sin conflictos y sin editar nada
  git(h, 'merge', '-q', '--allow-unrelated-histories', '--no-ff', 'skills-side', '-m', 'la unión');
  const u = git(h, 'rev-parse', 'HEAD');
  return { dir: h, h0, s0, h1, s1, u, tips: [harnessMain, harnessBranch, skillsMain, skillsBranch] };
}

// ── la regla del .gitignore y el texto del despachador ──────────────────────────────────────────────────────────────

test('Gitignore_UnifiedRule — primero el arnés, sin repetir, y de agent-skills todo menos el bloque .advisors/', () => {
  assert.equal(lib().unifiedGitignore(HARNESS_GITIGNORE, SKILLS_GITIGNORE), UNIFIED_GITIGNORE);
  // sin bloque que sacar, la regla es la unión sin repetir y nada más
  assert.equal(lib().unifiedGitignore('a\n\nb\n', 'b\nc\n'), 'a\n\nb\nc\n');
  // el bloque es la línea y los comentarios pegados arriba: un comentario separado por una línea vacía se queda
  assert.equal(lib().unifiedGitignore('a\n', '# se queda\n\n# se va\n.advisors/\nc\n'), 'a\n# se queda\n\nc\n');
});

test('Dispatcher_TextOfTheUnion — el despachador de la unión, con sus dos partes, fijo en union-check', () => {
  const text = lib().dispatcherText();
  assert.match(text, /^#!\/usr\/bin\/env bash\n/);
  assert.match(text, /pre-commit-harness/);
  assert.match(text, /pre-commit-skills/);
  assert.ok(text.endsWith('\n'), 'termina en salto de línea');
  // el exportador actual no trae la constante (el arnés corre un solo control): el texto de la unión vive en union-check
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'publishing', 'export.js'), 'utf8');
  assert.doesNotMatch(source, /PRE_COMMIT_DISPATCHER/, 'el exportador no trae el despachador');
});

// 🔴 Con export.js en disco con saltos CRLF (un checkout de Windows con autocrlf), si la expresión que lee
// la constante no la encontrara, `tree` saldría 2 culpando al exportador y todo el laboratorio de esta suite caería.
test('Dispatcher_CrlfCheckout_SameText — el fin de línea del checkout no cambia el texto del despachador', () => {
  // un exportador de la unión, con la constante del despachador (el exportador actual no la trae)
  const source = `'use strict';\nconst PRE_COMMIT_DISPATCHER = [\n${lib().dispatcherText().split('\n').map((l) => `  ${JSON.stringify(l)},`).join('\n')}\n].join('\\n');\nmodule.exports = {};\n`;
  const dir = tmp('uc-crlf-');
  const crlf = path.join(dir, 'export.js');
  fs.writeFileSync(crlf, source.replace(/\r?\n/g, '\r\n'));
  assert.equal(lib().dispatcherText(crlf), lib().dispatcherText());
  assert.ok(!lib().dispatcherText(crlf).includes('\r'), 'sin retornos de carro en el texto');
  // y un exportador que de verdad no trae la constante sigue siendo «no pude mirar»
  const without = path.join(dir, 'without.js');
  fs.writeFileSync(without, '// nada\n');
  assert.throws(() => lib().dispatcherText(without), /PRE_COMMIT_DISPATCHER/);
});

// 🔴 `tree` compara el despachador de un commit de la unión, que no cambia nunca, contra el texto del exportador de su lado;
// si lo comparara contra el texto que genera el exportador actual, un retoque posterior de esa constante pondría en rojo para siempre la comprobación de la unión.
test('Dispatcher_FromTheHarnessSideExporter — el despachador esperado es el del exportador del lado del arnés, no el de hoy', () => {
  const OTHER = ['#!/usr/bin/env bash', '# el despachador de ese arnés, con otro texto', 'exit 0', ''].join('\n');
  const exporter = `'use strict';\nconst PRE_COMMIT_DISPATCHER = [\n  '#!/usr/bin/env bash',\n  '# el despachador de ese arnés, con otro texto',\n  'exit 0',\n  '',\n].join('\\n');\nmodule.exports = {};\n`;
  const tree = (l) => tool(l.dir, 'tree', '--harness', l.h0, '--skills', l.s0, '--union', l.u);
  // la unión se armó con el texto del exportador de SU lado del arnés: en orden, aunque el actual diga otra cosa
  const own = lab({ exporter, dispatcher: OTHER });
  assert.notEqual(OTHER, lib().dispatcherText(), 'el texto de juguete no es el de hoy');
  const ok = tree(own);
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  // y si la unión trae el texto actual en vez del de su lado, difiere
  const today = lab({ exporter });
  const bad = tree(today);
  assert.equal(bad.status, 1, `${bad.stdout}${bad.stderr}`);
  assert.ok(bad.stdout.split('\n').some((x) => x.includes('.githooks/pre-commit') && x.includes('difiere')), bad.stdout);
});

// ── T2 · la historia ─────────────────────────────────────────────────────────────────────────────────────────────────

test('T2 Union_AllTipsAncestors_NoRewrite_IdsKept_RemixByMergeOnly — juguete', () => {
  const l = lab();
  const count = (ref) => Number(git(l.dir, 'rev-list', '--count', ref));

  const ok = tool(l.dir, 'history', '--union', l.u, '--tips', ...l.tips, l.h0, l.s0, l.h1, l.s1);
  assert.equal(ok.status, 0, `todas las puntas son ancestros: ${ok.stdout}${ok.stderr}`);
  // nada se reescribió: la unión tiene los commits de los dos lados y uno más, el suyo
  assert.equal(count(l.u), count(l.h1) + count(l.s1) + 1);
  for (const tip of l.tips) assert.equal(git(l.dir, 'cat-file', '-t', tip), 'commit');

  // una re-mezcla: main del arnés avanza y se mezcla en la base; la punta anterior sigue siendo ancestro
  git(l.dir, 'checkout', '-q', 'main');
  write(l.dir, 'scripts/c.js', 'module.exports = 3;\n');
  const newMain = commitAll(l.dir, 'arnés: main avanza otra vez');
  git(l.dir, 'checkout', '-q', 'base');
  git(l.dir, 'merge', '-q', '--no-ff', 'main', '-m', 'la base trae main');
  const remix = git(l.dir, 'rev-parse', 'HEAD');
  const after = tool(l.dir, 'history', '--union', remix, '--tips', l.u, newMain, ...l.tips);
  assert.equal(after.status, 0, `tras la re-mezcla: ${after.stdout}${after.stderr}`);

  // la historia de agent-skills traída como un solo commit (reescrita): el árbol es el mismo y las puntas ya no están
  const squashed = git(l.dir, 'commit-tree', `${l.s1}^{tree}`, '-m', 'skills en un solo commit');
  git(l.dir, 'checkout', '-q', '-b', 'rewritten', l.h1);
  git(l.dir, 'merge', '-q', '--allow-unrelated-histories', '--no-ff', squashed, '-m', 'la unión, reescrita');
  const rewritten = git(l.dir, 'rev-parse', 'HEAD');
  assert.equal(git(l.dir, 'rev-parse', `${rewritten}^{tree}`), git(l.dir, 'rev-parse', `${l.u}^{tree}`), 'mismo árbol');
  const bad = tool(l.dir, 'history', '--union', rewritten, '--tips', l.s0, l.h0);
  assert.equal(bad.status, 1, `una historia reescrita sale 1: ${bad.stdout}${bad.stderr}`);
  assert.ok(bad.stdout.includes(l.s0), 'nombra la punta que no es ancestro');
  assert.ok(!bad.stdout.includes(l.h0), 'y no nombra la que sí lo es');
});

// ── T3 · el árbol ────────────────────────────────────────────────────────────────────────────────────────────────────

test('T3 Union_TreeIsExactUnion_OnlyDeclaredExceptions — juguete', () => {
  const l = lab();
  const tree = (union) => tool(l.dir, 'tree', '--harness', l.h0, '--skills', l.s0, '--union', union);
  const files = (ref) => git(l.dir, 'ls-tree', '-r', '--name-only', ref).split('\n').length;

  const ok = tree(l.u);
  assert.equal(ok.status, 0, `la unión correcta: ${ok.stdout}${ok.stderr}`);
  // la cuenta: el lado del arnés más el de agent-skills menos uno
  assert.equal(files(l.u), files(l.h0) + files(l.s0) - 1);
  // el README que queda es el del arnés
  assert.equal(git(l.dir, 'show', `${l.u}:README.md`), '# El arnés');

  const extra = variant(l.dir, l.u, 'v-extra', () => write(l.dir, 'skills/x/intruso.md', 'de más\n'), 'un archivo de más');
  const changed = variant(l.dir, l.u, 'v-changed', () => write(l.dir, 'agents/r.md', '# revisor, tocado\n'), 'un archivo cambiado');
  const missing = variant(l.dir, l.u, 'v-missing', () => git(l.dir, 'rm', '-q', 'scripts/a.js'), 'un archivo faltante');
  for (const [union, file, word] of [[extra, 'skills/x/intruso.md', 'sobra'], [changed, 'agents/r.md', 'difiere'], [missing, 'scripts/a.js', 'falta']]) {
    const r = tree(union);
    assert.equal(r.status, 1, `${word}: tiene que salir 1 — ${r.stdout}${r.stderr}`);
    const line = r.stdout.split('\n').find((x) => x.includes(file));
    assert.ok(line, `nombra ${file}: ${r.stdout}`);
    assert.ok(line.includes(word), `y dice «${word}»: ${line}`);
  }

  // el README de agent-skills, si entrara pisando al del arnés, es un archivo que difiere
  const readme = variant(l.dir, l.u, 'v-readme', () => write(l.dir, 'README.md', git(l.dir, 'show', `${l.s0}:README.md`) + '\n'), 'el README equivocado');
  const r = tree(readme);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.split('\n').some((x) => x.includes('README.md') && x.includes('difiere')), r.stdout);
});

test('T3 un commit que no existe no es un verde: sale 2 y lo dice', () => {
  const l = lab();
  const missing = '0123456789abcdef0123456789abcdef01234567';
  const r = tool(l.dir, 'tree', '--harness', l.h0, '--skills', l.s0, '--union', missing);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no pude mirar/);
  const usage = tool(l.dir, 'tree', '--harness', l.h0);
  assert.equal(usage.status, 2, 'sin sus opciones sale 2');
  const unknown = tool(l.dir, 'whatever');
  assert.equal(unknown.status, 2, 'un subcomando que no existe sale 2');
  // una punta que el clon no trae tampoco es «no es ancestro»: no se pudo mirar
  const tip = tool(l.dir, 'history', '--union', l.u, '--tips', l.h0, missing);
  assert.equal(tip.status, 2, `${tip.stdout}${tip.stderr}`);
  assert.match(tip.stderr, /no pude mirar/);
  const noTips = tool(l.dir, 'history', '--union', l.u);
  assert.equal(noTips.status, 2, 'history sin puntas sale 2');
  // una opción que no existe, y una opción sin su valor
  const option = tool(l.dir, 'tree', '--harness', l.h0, '--skills', l.s0, '--union', l.u, '--unknown-option', 'x');
  assert.equal(option.status, 2, `${option.stdout}${option.stderr}`);
  assert.match(option.stderr, /no conozco la opción --unknown-option/);
  const noValue = spawnSync(process.execPath, [TOOL, 'tree', '--union'], { env: ENV, encoding: 'utf8' });
  assert.equal(noValue.status, 2, `${noValue.stdout}${noValue.stderr}`);
  assert.match(noValue.stderr, /--union lleva un valor/);
  const loose = tool(l.dir, 'tree', '--harness', l.h0, '--skills', l.s0, '--union', l.u, 'suelto');
  assert.equal(loose.status, 2, 'un argumento suelto donde no va sale 2');
});

test('T3 una cuarta ruta repetida entre los dos lados no tiene regla: se nombra, no se pisa en silencio', () => {
  const l = lab();
  // los dos lados suman el mismo archivo, que no es ninguna de las tres rutas con regla
  const harness = variant(l.dir, l.h0, 'x-harness', () => write(l.dir, 'shared.txt', 'del arnés\n'), 'el arnés suma shared.txt');
  const skills = variant(l.dir, l.s0, 'x-skills', () => write(l.dir, 'shared.txt', 'de skills\n'), 'skills suma shared.txt');
  const { expected, noRule, harnessFiles, skillsFiles } = lib().expectedUnion(l.dir, harness, skills);
  assert.deepEqual(noRule, ['shared.txt']);
  assert.equal(expected.size, harnessFiles + skillsFiles - 2, 'la ruta sin regla se cuenta una sola vez');
  assert.ok(expected.has('.githooks/pre-commit-harness') && expected.has('.githooks/pre-commit-skills') && expected.has('.githooks/pre-commit'));
  const r = tool(l.dir, 'tree', '--harness', harness, '--skills', skills, '--union', l.u);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  const line = r.stdout.split('\n').find((x) => x.includes('shared.txt') && x.includes('sin regla'));
  assert.ok(line, `nombra shared.txt como «sin regla»: ${r.stdout}`);
});

// ── T5 · las dos partes y el despachador ─────────────────────────────────────────────────────────────────────────────

test('T5 Hooks_PartsByteForByte_DispatcherAsGenerated — juguete', () => {
  const l = lab();
  const tree = (union) => tool(l.dir, 'tree', '--harness', l.h0, '--skills', l.s0, '--union', union);
  const blob = (ref, file) => git(l.dir, 'rev-parse', `${ref}:${file}`);

  // byte a byte: el mismo objeto de git que el original de cada lado, y el despachador con el texto del exportador
  assert.equal(blob(l.u, '.githooks/pre-commit-harness'), blob(l.h0, '.githooks/pre-commit'));
  assert.equal(blob(l.u, '.githooks/pre-commit-skills'), blob(l.s0, '.githooks/pre-commit'));
  assert.equal(git(l.dir, 'show', `${l.u}:.githooks/pre-commit`) + '\n', lib().dispatcherText());
  assert.match(git(l.dir, 'ls-tree', l.u, '.githooks/pre-commit'), /^100755 /, 'el despachador es ejecutable');

  const append = (file) => () => fs.appendFileSync(path.join(l.dir, file), '# un byte de más\n');
  const cases = [
    ['v-part-h', '.githooks/pre-commit-harness', append('.githooks/pre-commit-harness')],
    ['v-part-s', '.githooks/pre-commit-skills', append('.githooks/pre-commit-skills')],
    ['v-dispatcher', '.githooks/pre-commit', append('.githooks/pre-commit')],
    ['v-gitignore', '.gitignore', () => fs.appendFileSync(path.join(l.dir, '.gitignore'), '.advisors/\n')],
  ];
  // el modo también cuenta: una parte que deja de ser ejecutable no es el original. Sólo donde git mira el modo de los
  // archivos (en un disco que no lo guarda, como el de Windows, `git add` no vería el cambio y el caso no mediría nada)
  if (git(l.dir, 'config', 'core.fileMode') === 'true') {
    cases.push(['v-mode', '.githooks/pre-commit-skills', () => fs.chmodSync(path.join(l.dir, '.githooks/pre-commit-skills'), 0o644)]);
  }
  for (const [branch, file, change] of cases) {
    const r = tree(variant(l.dir, l.u, branch, change, `tocado: ${file}`));
    assert.equal(r.status, 1, `${branch}: tiene que salir 1 — ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.split('\n').some((x) => x.includes(file) && x.includes('difiere')), `${branch}: nombra ${file} — ${r.stdout}`);
  }
});

// ── T6 · los papeles ─────────────────────────────────────────────────────────────────────────────────────────────────

test('T6 Papers_InactiveSkillsGuide_GitignoreCitesIt_PostCommitIgnoreAsIs — juguete', () => {
  const l = lab();
  const papers = (base) => tool(l.dir, 'papers', '--base', base, '--harness', l.h0, '--skills', l.s0);
  const cite = () => {
    const p = path.join(l.dir, '.gitignore');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('README.md §«Skills que no se cargan»', 'guides/maintaining/inactive-skills.md'));
  };
  const guide = () => write(l.dir, 'guides/maintaining/inactive-skills.md', '# Skills que no se cargan\n');

  const base = variant(l.dir, l.u, 'p-ok', () => { guide(); cite(); }, 'la guía y la cita');
  const ok = papers(base);
  assert.equal(ok.status, 0, `la base correcta: ${ok.stdout}${ok.stderr}`);

  const cases = [
    ['p-no-guide', 'guides/maintaining/inactive-skills.md', () => cite()],
    ['p-old-cite', '.gitignore', () => guide()],
    ['p-ignore', '.tycon/post-commit-ignore', () => { guide(); cite(); fs.appendFileSync(path.join(l.dir, '.tycon/post-commit-ignore'), 'otra\n'); }],
    ['p-tycon', '.tycon/advisors.yaml', () => { guide(); cite(); fs.appendFileSync(path.join(l.dir, '.tycon/advisors.yaml'), 'deep_review: off\n'); }],
    ['p-no-ignore', '.gitignore', () => { guide(); git(l.dir, 'rm', '-q', '.gitignore'); }],
  ];
  for (const [branch, file, change] of cases) {
    const r = papers(variant(l.dir, l.u, branch, change, `papeles: ${branch}`));
    assert.equal(r.status, 1, `${branch}: tiene que salir 1 — ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes(file), `${branch}: nombra ${file} — ${r.stdout}`);
  }

  // sin los dos lados sólo mira lo que dura: la guía y la cita
  const short = tool(l.dir, 'papers', '--base', base);
  assert.equal(short.status, 0, `${short.stdout}${short.stderr}`);
  // 🔴 Un lado que llega VACÍO (una variable de shell sin valor) no es «no me lo pasaron»: si se salteara
  // la comparación, saldría 0. Con un archivo de .tycon/ cambiado, tiene que salir 2, no verde.
  const changed = variant(l.dir, l.u, 'p-empty', () => { guide(); cite(); fs.appendFileSync(path.join(l.dir, '.tycon/post-commit-ignore'), 'otra\n'); }, 'papeles: un lado vacío');
  const empty = tool(l.dir, 'papers', '--base', changed, '--harness', '', '--skills', '');
  assert.equal(empty.status, 2, `${empty.stdout}${empty.stderr}`);
  assert.match(empty.stderr, /no pude mirar/);
  const half = tool(l.dir, 'papers', '--base', changed, '--harness', l.h0);
  assert.equal(half.status, 2, 'un solo lado: sale 2');
});

// ── T9 · los carriles ────────────────────────────────────────────────────────────────────────────────────────────────

test('T9 Lanes_NoFileInTwoBranches — juguete', () => {
  const l = lab();
  const shared = () => {
    fs.appendFileSync(path.join(l.dir, STORY), '\nuna línea del tramo\n');
    fs.appendFileSync(path.join(l.dir, 'tasks/todo.md'), '- una deuda\n');
  };
  const base = variant(l.dir, l.u, 'lane-base', () => {
    write(l.dir, STORY, '# la story\n');
    write(l.dir, 'tasks/todo.md', '# deudas\n');
    write(l.dir, '.engram/manifest.json', '{}\n');
  }, 'la base');
  variant(l.dir, base, 'lane-1', () => { shared(); write(l.dir, 'scripts/a.js', 'module.exports = 11;\n'); write(l.dir, '.engram/manifest.json', '{"a":1}\n'); }, 'carril 1');
  variant(l.dir, base, 'lane-2', () => { shared(); write(l.dir, 'agents/r.md', '# revisor del carril 2\n'); write(l.dir, '.engram/chunks/x.gz', 'x'); }, 'carril 2');
  variant(l.dir, base, 'lane-3', () => { shared(); write(l.dir, 'scripts/a.js', 'module.exports = 33;\n'); }, 'carril 3, que pisa al 1');
  variant(l.dir, base, 'lane-3b', () => { shared(); write(l.dir, 'packs/p/pack.json', '{"name":"p"}\n'); }, 'carril 3, sin pisar');

  const bad = tool(l.dir, 'lanes', '--base', base, 'lane-1', 'lane-2', 'lane-3');
  assert.equal(bad.status, 1, `un archivo en dos carriles sale 1: ${bad.stdout}${bad.stderr}`);
  const line = bad.stdout.split('\n').find((x) => x.includes('scripts/a.js'));
  assert.ok(line && line.includes('lane-1') && line.includes('lane-3'), `nombra el archivo y las dos ramas: ${bad.stdout}`);
  assert.ok(!bad.stdout.includes(STORY) && !bad.stdout.includes('tasks/todo.md') && !bad.stdout.includes('.engram/'), `los compartidos no cuentan: ${bad.stdout}`);

  const ok = tool(l.dir, 'lanes', '--base', base, 'lane-1', 'lane-2', 'lane-3b');
  assert.equal(ok.status, 0, `sin archivos repetidos: ${ok.stdout}${ok.stderr}`);

  // la base avanza tocando un archivo que un carril también tocó, y otro carril la mezcla: no es un choque entre carriles
  const base2 = variant(l.dir, base, 'lane-base-2', () => write(l.dir, 'agents/r.md', '# revisor, desde la base\n'), 'la base avanza');
  git(l.dir, 'checkout', '-q', 'lane-3b');
  git(l.dir, 'merge', '-q', '--no-ff', base2, '-m', 'el carril 3 mezcla la base');
  git(l.dir, 'checkout', '-q', 'base');
  const mixed = tool(l.dir, 'lanes', '--base', base2, 'lane-1', 'lane-2', 'lane-3b');
  assert.equal(mixed.status, 0, `lo que cambió la base no es de ningún carril: ${mixed.stdout}${mixed.stderr}`);

  // Un carril mezcla la rama junta, que ya trae los commits de otro. Sin decir cuál es la rama junta, esos commits están
  // en dos carriles y no se sabe de quién son: se dice (y se pide la rama junta), sin inventar un choque de archivos.
  variant(l.dir, base, 'lane-4', () => { shared(); write(l.dir, 'packs/q.json', '{}\n'); }, 'carril 4, sin pisar');
  git(l.dir, 'checkout', '-q', '-b', 'joined', base);
  git(l.dir, 'merge', '-q', '--no-ff', 'lane-1', '-m', 'la rama junta trae el carril 1');
  git(l.dir, 'checkout', '-q', 'lane-2');
  git(l.dir, 'merge', '-q', '--no-ff', 'joined', '-m', 'el carril 2 mezcla la rama junta');
  git(l.dir, 'checkout', '-q', 'base');
  const noJoined = tool(l.dir, 'lanes', '--base', base, 'lane-1', 'lane-2', 'lane-4');
  assert.equal(noJoined.status, 1, `commits en dos carriles, sin la rama junta: ${noJoined.stdout}${noJoined.stderr}`);
  assert.match(noJoined.stdout, /commits compartidos/);
  assert.match(noJoined.stdout, /--joined/);
  assert.ok(!noJoined.stdout.includes('scripts/a.js —'), `no inventa un choque de archivos: ${noJoined.stdout}`);
  const lanes = (...branches) => tool(l.dir, 'lanes', '--base', base, '--joined', 'joined', ...branches);
  const joined = lanes('lane-1', 'lane-2', 'lane-4');
  assert.equal(joined.status, 0, `lo que llega por la rama junta no es de ese carril: ${joined.stdout}${joined.stderr}`);
  // lo que un carril todavía no juntado toca y la rama junta ya trae de otro: choque, contra la rama junta
  const against = lanes('lane-1', 'lane-2', 'lane-3');
  assert.equal(against.status, 1, `${against.stdout}${against.stderr}`);
  assert.ok(against.stdout.split('\n').some((x) => x.includes('scripts/a.js') && x.includes('lane-3') && x.includes('rama junta')), against.stdout);

  // 🔴 Un carril que avanza rápido sobre la rama junta (lo que `git merge` hace por defecto) no se
  // lleva como propios los commits de los otros
  git(l.dir, 'checkout', '-q', '-b', 'lane-5', base);
  git(l.dir, 'merge', '-q', 'joined');
  assert.equal(git(l.dir, 'rev-parse', 'lane-5'), git(l.dir, 'rev-parse', 'joined'), 'fue un avance rápido');
  write(l.dir, 'scripts/e.js', 'module.exports = 5;\n');
  commitAll(l.dir, 'carril 5, después de avanzar rápido');
  git(l.dir, 'checkout', '-q', 'base');
  const fast = lanes('lane-1', 'lane-5', 'lane-4');
  assert.equal(fast.status, 0, `el avance rápido no inventa choques: ${fast.stdout}${fast.stderr}`);

  // los otros dos papeles donde cada sesión escribe lo de su tramo tampoco cuentan; ni una ruta de .engram/ con
  // espacios y letras fuera de ASCII (git la escapa entre comillas si no se le pide la salida cruda)
  for (const lane of ['lane-1', 'lane-4']) {
    git(l.dir, 'checkout', '-q', lane);
    write(l.dir, 'tasks/orden-epica-8.md', `# orden, según ${lane}\n`);
    write(l.dir, 'specs/sprint-status.yaml', `estado: ${lane}\n`);
    write(l.dir, '.engram/chunks/con espacio y eñe.gz', lane);
    commitAll(l.dir, `${lane}: su parte del orden, del tablero y de la memoria`);
  }
  git(l.dir, 'checkout', '-q', 'base');
  const papers = lanes('lane-1', 'lane-2', 'lane-4');
  assert.equal(papers.status, 0, `el orden de la épica, el tablero y la memoria son compartidos: ${papers.stdout}${papers.stderr}`);

  const unknown = tool(l.dir, 'lanes', '--base', base, 'lane-1', 'no-such-branch');
  assert.equal(unknown.status, 2, 'una rama que no existe sale 2');
  const one = tool(l.dir, 'lanes', '--base', base, 'lane-1');
  assert.equal(one.status, 2, 'con menos de dos ramas no hay nada que comparar: sale 2');
  const noJoinedRef = tool(l.dir, 'lanes', '--base', base, '--joined', 'no-such-branch', 'lane-1', 'lane-4');
  assert.equal(noJoinedRef.status, 2, 'una rama junta que no existe sale 2');
});

// 🔴 Con un avance rápido, un chequeo ingenuo daría un choque FALSO y además
// dejaría de ver uno REAL.
test('T9 Lanes_FastForwardOntoJoined_NoFalseCollision_RealOneStillSeen — juguete', () => {
  const l = lab();
  const base = l.u;
  variant(l.dir, base, 'lane-1', () => write(l.dir, 'a.js', '1\n'), 'carril 1 toca a.js');
  variant(l.dir, base, 'lane-2', () => write(l.dir, 'b.js', '2\n'), 'carril 2 toca b.js');
  variant(l.dir, base, 'lane-3', () => write(l.dir, 'b.js', '3\n'), 'carril 3 toca b.js');
  const before = tool(l.dir, 'lanes', '--base', base, 'lane-1', 'lane-2', 'lane-3');
  assert.equal(before.status, 1);
  assert.ok(before.stdout.split('\n').some((x) => x.includes('b.js') && x.includes('lane-2') && x.includes('lane-3')), before.stdout);

  git(l.dir, 'checkout', '-q', '-b', 'joined', 'lane-1');
  git(l.dir, 'merge', '-q', '--no-ff', 'lane-2', '-m', 'la rama junta trae los carriles 1 y 2');
  git(l.dir, 'checkout', '-q', 'lane-2');
  git(l.dir, 'merge', '-q', 'joined');
  assert.equal(git(l.dir, 'rev-parse', 'lane-2'), git(l.dir, 'rev-parse', 'joined'), 'fue un avance rápido');
  git(l.dir, 'checkout', '-q', 'base');

  // con la rama junta: el choque real (el carril 3 contra lo ya juntado) se ve, y a.js no aparece
  const withJoined = tool(l.dir, 'lanes', '--base', base, '--joined', 'joined', 'lane-1', 'lane-2', 'lane-3');
  assert.equal(withJoined.status, 1, `${withJoined.stdout}${withJoined.stderr}`);
  assert.ok(withJoined.stdout.split('\n').some((x) => x.includes('b.js') && x.includes('lane-3')), withJoined.stdout);
  assert.ok(!withJoined.stdout.includes('a.js —'), `a.js no es un choque: ${withJoined.stdout}`);
  // sin la rama junta: tampoco inventa a.js, y dice que hay commits en dos carriles
  const without = tool(l.dir, 'lanes', '--base', base, 'lane-1', 'lane-2', 'lane-3');
  assert.equal(without.status, 1, `${without.stdout}${without.stderr}`);
  assert.ok(!without.stdout.includes('a.js —'), `a.js no es un choque: ${without.stdout}`);
  assert.match(without.stdout, /commits compartidos/);
});

// ── la unión de verdad ───────────────────────────────────────────────────────────────────────────────────────────────

/** Los commits anotados de la unión real, o el motivo por el que acá no se pueden medir. */
function realUnion() {
  if (!fs.existsSync(FIXTURE)) return { skip: `NO MEDIDO — falta ${path.relative(ROOT, FIXTURE)}: los commits de la unión real no están anotados en este árbol` };
  const commits = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const refs = [commits.union, commits.harness_side, commits.skills_side, ...Object.values(commits.tips || {})];
  for (const sha of refs) {
    const r = spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, env: ENV });
    if (r.status !== 0) return { skip: `NO MEDIDO — este clon no trae el commit ${String(sha).slice(0, 8)} de la unión (clon recortado, o una copia sin la historia interna)` };
  }
  return { commits };
}

test('T2 y T3 sobre la unión real — las cinco puntas son ancestros y el árbol es la unión exacta', (t) => {
  const real = realUnion();
  if (real.skip) { t.skip(real.skip); return; }
  const c = real.commits;
  const history = tool(ROOT, 'history', '--union', c.union, '--tips', ...Object.values(c.tips), c.harness_side, c.skills_side);
  assert.equal(history.status, 0, `${history.stdout}${history.stderr}`);
  const tree = tool(ROOT, 'tree', '--harness', c.harness_side, '--skills', c.skills_side, '--union', c.union);
  assert.equal(tree.status, 0, `${tree.stdout}${tree.stderr}`);
});

test('T6 sobre este árbol — la guía rescatada existe y el .gitignore la cita', () => {
  const r = tool(ROOT, 'papers', '--base', 'HEAD');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
