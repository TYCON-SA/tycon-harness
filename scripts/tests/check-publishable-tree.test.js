'use strict';
/**
 * check-publishable-tree.test.js — el control del repo interno que cuida la verificación de lo publicado (story 8.23,
 * tanda B · T20).
 *
 * EL CASO (2026-10-06, revisión I3). Una máquina sin git instala el arnés bajando el comprimido de un commit publicado y lo
 * da por bueno si el árbol que trae es el del commit. Tres cosas del repo rompen eso sin que nadie lo note hasta la
 * primera instalación: un `export-ignore` o `export-subst` en un `.gitattributes` (el comprimido no trae lo que el
 * commit trae, o lo trae cambiado), un enlace simbólico (`120000`) o un submódulo (`160000`) en una ruta publicada (el
 * lector propio los rechaza antes de escribir). El control frena eso en el pre-commit y en la validación de cada rama.
 *
 * Qué fija:
 *   · frena las cuatro cosas en rutas PUBLICADAS (lo decide la lista blanca del exportador y sus excluidos); la misma
 *     cosa en una ruta privada (specs/) pasa;
 *   · sale 0 con el repo limpio, 1 con hallazgos, 2 si no pudo mirar (sin git, lista blanca ilegible);
 *   · `--staged` mira sólo lo que el commit en curso agrega o cambia.
 * 🔴 Todo en un repo de juguete en el temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CHECK = path.join(ROOT, 'scripts', 'ci', 'check-publishable-tree.js');
const EXPORTER = path.join(ROOT, 'scripts', 'publishing', 'export.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (dir, args, extra = {}) => spawnSync('git', ['-C', dir, ...args], Object.assign({ encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com' }) }, extra));
const run = (args) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });

/** Un repo de juguete con una lista blanca propia: scripts/** y la raíz se publican; specs/** no. */
function toyRepo() {
  const dir = tmp('publishable-');
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# juguete\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'specs', 'story.md'), '# privada\n');
  const allowlist = path.join(dir, 'allowlist.json');
  fs.writeFileSync(allowlist, JSON.stringify({ packages: { core: { arnes: { in: ['README.md', '.gitattributes', 'scripts/**'], out: ['scripts/privado/**'] } } } }));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'limpio']);
  return { dir, allowlist };
}
const base = (r, extra = []) => ['--repo', r.dir, '--allowlist', r.allowlist, '--exporter', EXPORTER, ...extra];

test('T20 · el repo limpio sale 0 y no dice nada', () => {
  const r = toyRepo();
  const out = run(base(r));
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
});

test('T20 · export-ignore y export-subst, un enlace y un submódulo en rutas publicadas frenan; los mismos en una privada pasan', () => {
  const r = toyRepo();
  fs.writeFileSync(path.join(r.dir, '.gitattributes'), '* text=auto\nguides/** export-ignore\n');
  fs.writeFileSync(path.join(r.dir, 'scripts', '.gitattributes'), 'lib/a.js export-subst\n');
  fs.writeFileSync(path.join(r.dir, 'specs', '.gitattributes'), '* export-ignore\n');
  fs.symlinkSync('lib/a.js', path.join(r.dir, 'scripts', 'enlace.js'));
  fs.symlinkSync('story.md', path.join(r.dir, 'specs', 'enlace.md'));
  // en una ruta que la lista blanca deja AFUERA (out) tampoco frena
  fs.mkdirSync(path.join(r.dir, 'scripts', 'privado'));
  fs.symlinkSync('../lib/a.js', path.join(r.dir, 'scripts', 'privado', 'x.js'));
  git(r.dir, ['add', '-A']);
  // un submódulo (gitlink 160000) en una ruta publicada y otro en una privada, sin clonar nada: directo al índice,
  // DESPUÉS del add (un `add -A` saca del índice lo que no está en el disco)
  const sha = git(r.dir, ['rev-parse', 'HEAD']).stdout.trim();
  git(r.dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},scripts/vendor`]);
  git(r.dir, ['update-index', '--add', '--cacheinfo', `160000,${sha},specs/vendor`]);
  const out = run(base(r));
  assert.strictEqual(out.status, 1, out.stdout + out.stderr);
  const text = out.stdout + out.stderr;
  assert.match(text, /\.gitattributes.*export-ignore/, 'el export-ignore de la raíz');
  assert.match(text, /scripts\/\.gitattributes.*export-subst/, 'el export-subst publicado');
  assert.match(text, /scripts\/enlace\.js.*enlace/, 'el enlace publicado');
  assert.match(text, /scripts\/vendor.*subm[oó]dulo/, 'el submódulo publicado');
  assert.doesNotMatch(text, /specs\//, 'nada de specs/ (privada)');
  assert.doesNotMatch(text, /scripts\/privado/, 'nada de lo que la lista deja afuera');
  const n = (text.match(/^ {2}[·-] |^❌/gm) || []).length;
  assert.strictEqual((text.match(/hallazgo/g) || []).length >= 1, true);
  void n;
});

test('T20 · --staged mira sólo lo que el commit agrega o cambia', () => {
  const r = toyRepo();
  // un enlace YA commiteado en una ruta publicada: con --staged no se reclama (no es de este commit); sin --staged sí
  fs.symlinkSync('lib/a.js', path.join(r.dir, 'scripts', 'viejo.js'));
  git(r.dir, ['add', '-A']);
  git(r.dir, ['commit', '-q', '-m', 'un enlace viejo']);
  fs.writeFileSync(path.join(r.dir, 'scripts', 'lib', 'b.js'), 'module.exports = 2;\n');
  git(r.dir, ['add', '-A']);
  const staged = run(base(r, ['--staged']));
  assert.strictEqual(staged.status, 0, staged.stdout + staged.stderr);
  const all = run(base(r));
  assert.strictEqual(all.status, 1);
  assert.match(all.stdout + all.stderr, /scripts\/viejo\.js/);
  // y lo que este commit agrega sí se reclama
  fs.writeFileSync(path.join(r.dir, 'scripts', '.gitattributes'), 'lib/b.js export-subst\n');
  git(r.dir, ['add', '-A']);
  const staged2 = run(base(r, ['--staged']));
  assert.strictEqual(staged2.status, 1, staged2.stdout + staged2.stderr);
  assert.match(staged2.stdout + staged2.stderr, /scripts\/\.gitattributes.*export-subst/);
  assert.doesNotMatch(staged2.stdout + staged2.stderr, /viejo\.js/);
});

test('T20 · --staged también ve un archivo que pasa a ser enlace (T), y mira todo si el commit toca la lista blanca', () => {
  const r = toyRepo();
  // a.js deja de ser archivo y pasa a ser enlace: para git es un cambio de TIPO, no A/M
  fs.rmSync(path.join(r.dir, 'scripts', 'lib', 'a.js'));
  fs.writeFileSync(path.join(r.dir, 'scripts', 'lib', 'real.js'), 'module.exports = 1;\n');
  fs.symlinkSync('real.js', path.join(r.dir, 'scripts', 'lib', 'a.js'));
  git(r.dir, ['add', '-A']);
  const staged = run(base(r, ['--staged']));
  assert.strictEqual(staged.status, 1, staged.stdout + staged.stderr);
  assert.match(staged.stdout + staged.stderr, /scripts\/lib\/a\.js.*enlace/);
  git(r.dir, ['reset', '-q', '--hard']);
  // un enlace viejo en scripts/privado/ (que la lista dejaba AFUERA) se vuelve publicado porque ESTE commit amplía la
  // lista blanca: sin mirar el índice entero, el pre-commit no lo vería
  fs.mkdirSync(path.join(r.dir, 'scripts', 'privado'));
  fs.symlinkSync('../lib/a.js', path.join(r.dir, 'scripts', 'privado', 'enlace.js'));
  git(r.dir, ['add', '-A']);
  git(r.dir, ['commit', '-q', '-m', 'enlace privado']);
  assert.strictEqual(run(base(r)).status, 0, 'afuera de la lista no se reclama');
  fs.writeFileSync(r.allowlist, JSON.stringify({ packages: { core: { arnes: { in: ['README.md', 'scripts/**'] } } } }));
  git(r.dir, ['add', '-A']);
  const widened = run(base(r, ['--staged']));
  assert.strictEqual(widened.status, 1, widened.stdout + widened.stderr);
  assert.match(widened.stdout + widened.stderr, /índice entero/);
  assert.match(widened.stdout + widened.stderr, /scripts\/privado\/enlace\.js/);
});

test('T20 · nombres que Windows no escribe, dos rutas que sólo difieren en mayúsculas, y atributos que cambian bytes frenan; un # en el medio del patrón no es comentario', () => {
  const r = toyRepo();
  fs.writeFileSync(path.join(r.dir, 'scripts', 'lib', 'con:dos.js'), 'module.exports = 4;\n');
  fs.writeFileSync(path.join(r.dir, '.gitattributes'), '*.sh eol=crlf\n*.js ident\n# scripts/** export-ignore\nscripts/#raro.js export-ignore\n*.md filter=lfs\n');
  git(r.dir, ['add', '-A', '--', '.gitattributes', 'scripts/lib/con:dos.js']);
  // A.js junto a a.js: en un disco que no distingue mayúsculas (este Mac) una pisa a la otra, así que va directo al
  // índice, como llegaría desde un commit hecho en Linux. («.git» como segmento lo rechaza git mismo: no hace falta probarlo)
  const blob = git(r.dir, ['hash-object', '-w', '--stdin'], { input: 'module.exports = 3;\n' }).stdout.trim();
  git(r.dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},scripts/lib/A.js`]);
  const out = run(base(r));
  const text = out.stdout + out.stderr;
  assert.strictEqual(out.status, 1, text);
  assert.match(text, /con:dos\.js.*Windows/);
  assert.match(text, /A\.js.*mayúsculas.*a\.js/);
  assert.match(text, /eol=crlf/);
  assert.match(text, /«ident»/);
  assert.match(text, /filter=lfs/);
  assert.match(text, /#raro\.js export-ignore/, 'el # en el medio es parte del patrón');
  assert.doesNotMatch(text, /:3 — /, 'la línea que empieza con # es comentario');
});

test('T20 · sin lista blanca legible, o sin repo git, sale 2: no medido no es verde', () => {
  const r = toyRepo();
  fs.writeFileSync(r.allowlist, '{ roto');
  assert.strictEqual(run(base(r)).status, 2);
  const noRepo = tmp('publishable-norepo-');
  const out = run(['--repo', noRepo, '--allowlist', path.join(ROOT, 'scripts', 'publishing', 'allowlist.json'), '--exporter', EXPORTER]);
  assert.strictEqual(out.status, 2);
});

test('T20 · sobre el repo del arnés, con su propia lista blanca y su exportador, hoy sale 0', () => {
  const out = run(['--repo', ROOT]);
  assert.strictEqual(out.status, 0, out.stdout + out.stderr);
});
