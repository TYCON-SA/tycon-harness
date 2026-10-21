'use strict';

/**
 * comment-only-diff.test.js — el comando que dice si un cambio toca sólo comentarios
 * (scripts/publishing/comment-only-diff.js), con el lector de la zona `comment` del freno de historia interna.
 *
 * Lo que no se puede perder:
 *   · Que reescribir, borrar o agregar comentarios y líneas en blanco salga 0.
 *   · Que cambiar una línea de código, una cadena con `//` adentro, o agregar o borrar un archivo salga 1.
 *   · Que un archivo cuyo lenguaje no tiene lector de código cuente como «no se puede comparar», nunca como igual.
 *   · Que un archivo que se copia al freno de producción salga 1 aunque cambie sólo un comentario.
 *
 * Arma un repo de juguete con git de verdad.
 *
 * Uso: node --test scripts/tests/comment-only-diff.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const TOOL = path.join(RAIZ, 'scripts', 'publishing', 'comment-only-diff.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-only-diff-'));
  // fechas fijas y sin mantenimiento automático: el mismo commit da el mismo hash en cada corrida
  const env = { ...process.env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const g = (...a) => { const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-C', dir, ...a], { encoding: 'utf8', env }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'prueba@example.com');
  g('config', 'user.name', 'Prueba');
  g('config', 'commit.gpgsign', 'false');
  const write = (files) => { for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t); };
  const commit = (files, msg) => { write(files); g('add', '-A'); g('commit', '-q', '--no-verify', '-m', msg); return g('rev-parse', 'HEAD'); };
  return { dir, commit, write, g };
}
const run = (dir, ...args) => spawnSync(process.execPath, [TOOL, '--repo', dir, ...args], { encoding: 'utf8' });

const JS = '#!/usr/bin/env node\n// viejo comentario\nconst x = 1; // al lado\n/**\n * un bloque\n */\nconst s = "// dentro de una cadena";\n';
const SH = '#!/bin/bash\n# viejo\necho "#no es comentario" # al lado\nls\n';

test('T10 CommentOnlyDiff_CodeChangeFails @story-8.43 @ac-10 — sólo comentarios sale 0; cambiar código sale 1', () => {
  const r = repo();
  const base = r.commit({ 'a.js': JS, 'b.sh': SH }, 'base');
  const soloComentarios = r.commit({
    'a.js': '#!/usr/bin/env node\n// qué hace, en presente\n\nconst x = 1;\nconst s = "// dentro de una cadena";\n',
    'b.sh': '#!/bin/bash\necho "#no es comentario"\n\n# lista la carpeta\nls\n',
  }, 'comentarios');
  const ok = run(r.dir, '--range', `${base}...${soloComentarios}`);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /2 archivo\(s\), sólo comentarios/);

  const codigo = r.commit({ 'a.js': '#!/usr/bin/env node\n// qué hace, en presente\n\nconst x = 2;\nconst s = "// dentro de una cadena";\n' }, 'código');
  const mal = run(r.dir, '--range', `${soloComentarios}...${codigo}`);
  assert.strictEqual(mal.status, 1, mal.stdout);
  assert.match(mal.stdout, /a\.js: el código cambia/);

  const cadena = r.commit({ 'a.js': '#!/usr/bin/env node\n// qué hace, en presente\n\nconst x = 2;\nconst s = "// otra cadena";\n' }, 'cadena');
  assert.strictEqual(run(r.dir, '--range', `${codigo}...${cadena}`).status, 1, 'el texto de una cadena es código aunque traiga //');
});

test('T10b CommentOnlyDiff_AddedDeletedOrUnreadable @story-8.43 @ac-10 — archivo nuevo, borrado o sin lector: sale 1', () => {
  const r = repo();
  const base = r.commit({ 'a.js': JS, 'c.ps1': '# viejo\nWrite-Host 1\n' }, 'base');
  const nuevo = r.commit({ 'd.js': '// nuevo\n' }, 'nuevo');
  const j = JSON.parse(run(r.dir, '--range', `${base}...${nuevo}`, '--json').stdout);
  assert.deepStrictEqual(j.files.map((f) => [f.file, f.reason]), [['d.js', 'archivo nuevo']]);

  const ps = r.commit({ 'c.ps1': '# nuevo\nWrite-Host 1\n' }, 'ps');
  const out = run(r.dir, '--range', `${nuevo}...${ps}`);
  assert.strictEqual(out.status, 1);
  assert.match(out.stdout, /c\.ps1: no es código que este lector sepa leer/);

  r.g('rm', '-q', 'a.js');
  r.g('commit', '-q', '--no-verify', '-m', 'borra');
  const borrado = run(r.dir, '--range', `${ps}...HEAD`);
  assert.strictEqual(borrado.status, 1);
  assert.match(borrado.stdout, /a\.js: archivo borrado/);
});

test('T10c CommentOnlyDiff_AgainstWorkTree_AndBadArgs @story-8.43 @ac-10 — contra el árbol de trabajo; sin rango sale 2', () => {
  const r = repo();
  r.commit({ 'a.js': JS }, 'base');
  r.write({ 'a.js': JS.replace('// viejo comentario', '// nuevo comentario') });
  assert.strictEqual(run(r.dir, '--against', 'HEAD').status, 0);
  r.write({ 'a.js': JS.replace('const x = 1', 'const x = 3') });
  assert.strictEqual(run(r.dir, '--against', 'HEAD').status, 1);
  assert.strictEqual(run(r.dir).status, 2, 'sin --range ni --against no hay nada que comparar');
  assert.strictEqual(run(r.dir, '--range', 'no-existe...HEAD').status, 2, 'una referencia que no existe es «no pude mirar»');
});

test('T10d CommentOnlyDiff_ProductionGuardCopy @story-8.43 @ac-10 — un archivo que se copia al freno de producción sale 1, aunque cambie sólo un comentario', () => {
  const r = repo();
  fs.mkdirSync(path.join(r.dir, 'scripts', 'production'), { recursive: true });
  fs.mkdirSync(path.join(r.dir, 'scripts', 'hooks'), { recursive: true });
  const instalador = '#!/bin/bash\nARCHIVOS=(\n  scripts/hooks/freno.js\n  scripts/production/lanzador\n)\n';
  const base = r.commit({ 'scripts/production/install-guard.sh': instalador, 'scripts/hooks/freno.js': JS, 'a.js': JS }, 'base');
  const comentario = r.commit({
    'scripts/hooks/freno.js': JS.replace('// viejo comentario', '// nuevo comentario'),
    'a.js': JS.replace('// viejo comentario', '// nuevo comentario'),
  }, 'comentarios');
  const out = run(r.dir, '--range', `${base}...${comentario}`, '--json');
  assert.strictEqual(out.status, 1, out.stdout + out.stderr);
  const j = JSON.parse(out.stdout);
  assert.deepStrictEqual(j.files.map((f) => [f.file, f.result]), [['a.js', 'same'], ['scripts/hooks/freno.js', 'differs']]);
  assert.match(j.files[1].reason, /se copia al freno de producción/);

  // sin el instalador en la base (un repo sin freno) no hay lista: el archivo se compara como cualquier otro
  const s = repo();
  const b2 = s.commit({ 'freno.js': JS }, 'base');
  const c2 = s.commit({ 'freno.js': JS.replace('// viejo comentario', '// nuevo comentario') }, 'comentario');
  assert.strictEqual(run(s.dir, '--range', `${b2}...${c2}`).status, 0);
});
