#!/usr/bin/env node
'use strict';
// bench-copied-deps.test.js — el aviso del pedido cuando un gancho que los casos del banco copian a mano suma una
// dependencia que esos casos no copian (scripts/ci/bench-copied-deps.js).
//
// Cada prueba arma un árbol de juguete en una carpeta temporal, con su propio `git init`, y corre el guion como
// proceso aparte. stable-data: no lee el reloj; los commits de los repos de prueba llevan fechas fijas.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'ci', 'bench-copied-deps.js');

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: 'prueba', GIT_AUTHOR_EMAIL: 'prueba@example.com', GIT_COMMITTER_NAME: 'prueba', GIT_COMMITTER_EMAIL: 'prueba@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[k];

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function escribir(dir, archivos) {
  for (const [ruta, texto] of Object.entries(archivos)) {
    const p = path.join(dir, ruta);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, texto);
  }
}

const COPIA_A_MANO = 'mkdir -p tcg/scripts/hooks tcg/scripts/lib && cp $TCG/scripts/hooks/aviso.js tcg/scripts/hooks/ && cp $TCG/scripts/lib/config.js $(ls $TCG/scripts/lib/vieja.js 2>/dev/null) tcg/scripts/lib/';

/** Un repo con la base (el gancho, su biblioteca y el caso que los copia) y un commit con `punta` encima. */
function repo(t, punta, { caso = COPIA_A_MANO } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-copied-deps-'));
  temporales.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  escribir(dir, {
    'scripts/hooks/aviso.js': "const c = require('../lib/config.js');\nconsole.log(c);\n",
    'scripts/lib/config.js': "const v = require('./vieja.js');\nmodule.exports = v;\n",
    'scripts/lib/vieja.js': 'module.exports = 1;\n',
    'scripts/lib/nueva.js': 'module.exports = 2;\n',
    'scripts/controls-bench/cases/hooks/10-aviso.json': JSON.stringify({ cases: [{ id: 'A1', setup: [caso] }] }, null, 2),
  });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  escribir(dir, punta);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'pedido');
  return { dir, base, tip: git(dir, 'rev-parse', 'HEAD') };
}

function correr({ dir, base, tip }) {
  return spawnSync(process.execPath, [TOOL, '--root', dir, '--range', `${base}...${tip}`], { encoding: 'utf8', env: GIT_ENV });
}

// 🔴 Falla con: un gancho que los casos copian a mano suma una biblioteca que esos casos no copian, y el pedido da
// verde; el banco de la base se cae recién en la cola (el caso del #1576, con profile-only.js).
test('T1 DependenciaNueva_QueElCasoNoCopia_Avisa — nombra el caso, el archivo copiado y la dependencia', (t) => {
  const r = correr(repo(t, { 'scripts/lib/config.js': "const v = require('./vieja.js');\nconst n = require('./nueva');\nmodule.exports = v + n;\n" }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /⚠️ bench-copied-deps: scripts\/controls-bench\/cases\/hooks\/10-aviso\.json: /);
  assert.match(r.stdout, /scripts\/lib\/config\.js.*scripts\/lib\/nueva\.js/);
  assert.match(r.stdout, /⚠️ bench-copied-deps: 1 dependencia/);
});

test('T2 LoQueYaSeCopiaba_OLoViejo_NoAvisa — una dependencia que el caso copia, o que ya estaba en la base', (t) => {
  // la nueva la suma también al caso, en el mismo pedido
  let r = correr(repo(t, {
    'scripts/lib/config.js': "const n = require('./nueva.js');\nmodule.exports = n;\n",
    'scripts/controls-bench/cases/hooks/10-aviso.json': JSON.stringify({ cases: [{ id: 'A1', setup: [`${COPIA_A_MANO} && cp $TCG/scripts/lib/nueva.js tcg/scripts/lib/`] }] }),
  }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /no copia/);
  assert.match(r.stdout, /✅ bench-copied-deps/);
  // el pedido cambia el archivo sin sumarle dependencias
  r = correr(repo(t, { 'scripts/lib/config.js': "const v = require('./vieja.js');\nmodule.exports = v + 1;\n" }));
  assert.doesNotMatch(r.stdout, /no copia/);
  // una carpeta copiada entera cubre lo que tiene adentro
  r = correr(repo(t, { 'scripts/lib/config.js': "module.exports = require('./nueva.js');\n" }, { caso: 'cp -r $TCG/scripts/lib tcg/scripts/ && cp $TCG/scripts/hooks/aviso.js tcg/scripts/hooks/' }));
  assert.doesNotMatch(r.stdout, /no copia/);
  // un archivo que ningún caso copia a mano no le importa al banco: carga desde el árbol entero
  r = correr(repo(t, { 'scripts/lib/nueva.js': "module.exports = require('./otra.js');\n", 'scripts/lib/otra.js': 'module.exports = 3;\n' }));
  assert.doesNotMatch(r.stdout, /no copia/);
});

test('T4 DependenciaEnUnTry_NoAvisa — con su salida si falta, el gancho carga igual; fuera del try, sí avisa', (t) => {
  let r = correr(repo(t, { 'scripts/lib/config.js': "let n = 0;\ntry { n = require('./nueva.js'); } catch { /* sin ella */ }\nfunction f() {\n  try {\n    if (n) { return require('./otra.js'); }\n  } catch { return 0; }\n}\nmodule.exports = n + f();\n" }));
  assert.doesNotMatch(r.stdout, /no copia/, r.stdout);
  // un try que ya cerró no ampara lo que viene después
  r = correr(repo(t, { 'scripts/lib/config.js': "try { require('./vieja.js'); } catch { }\nconst n = require('./nueva.js');\nmodule.exports = n;\n" }));
  assert.match(r.stdout, /no copia scripts\/lib\/nueva\.js/);
});

test('T3 NuncaFrena — sin rango, o sin poder leerlo, lo dice y sale 0', (t) => {
  const { dir } = repo(t, {});
  let r = spawnSync(process.execPath, [TOOL, '--root', dir], { encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /sin --range no aplica/);
  r = spawnSync(process.execPath, [TOOL, '--root', dir, '--range', 'nada...tampoco'], { encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /⚠️ bench-copied-deps: no pude medir/);
});
