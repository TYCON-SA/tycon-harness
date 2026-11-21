'use strict';
// command-readers.test.js — el lector de los comandos de una plataforma vive en su conector, y el núcleo lo busca por el
// programa que lee, sin nombrar la plataforma.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CARGADOR = path.join(ROOT, 'scripts', 'lib', 'command-readers.js');
const USAN = ['scripts/hooks/pr-auto-complete-guard.js', 'scripts/hooks/pr-one-per-repo-guard.js', 'scripts/hooks/public-push-guard.js',
  'scripts/hooks/retro-pending.js', 'scripts/lib/ci-bypass.js', 'scripts/lib/external-pr.js'];
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('CommandReaders_ElLectorDeGhViveEnSuConector: el núcleo lo busca por el programa y quien lo usa no nombra su ruta', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'gh-pr.js')), 'ya no está en el núcleo');
  const C = require(CARGADOR);
  const gh = C.lectorDe('gh');
  for (const f of ['comandosGh', 'pareceGh', 'repoDe', 'repoDeRuta']) assert.strictEqual(typeof gh[f], 'function', f);
  assert.deepStrictEqual(gh.programas, ['gh']);
  const cargador = fs.readFileSync(CARGADOR, 'utf8');
  assert.doesNotMatch(cargador, /'github'|'azure-devops'|gh-pr\.js/, 'el cargador no nombra ninguna plataforma');
  for (const f of USAN) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /gh-pr\.js'|'gh-pr\.js/, `${f} no carga el lector por su ruta`);
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'neutrality-allowlist.json'), 'utf8'));
  assert.ok(!JSON.stringify(lista).includes('scripts/lib/gh-pr.js'), 'sale de la lista de neutralidad');
});

test('CommandReaders_SinLector: un programa sin lector es un error al pedirlo y null al buscarlo', () => {
  const C = require(CARGADOR);
  assert.throws(() => C.lectorDe('programa-que-no-existe'), /no hay lector de comandos para programa-que-no-existe/);
  assert.strictEqual(C.buscarLector('programa-que-no-existe'), null);
  // un árbol sin conectores (un hook copiado suelto): buscar calla, pedir falla
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'command-readers-'));
  dirs.push(d);
  assert.strictEqual(C.buscarLector('gh', { raiz: d }), null);
  assert.throws(() => C.lectorDe('gh', { raiz: d }), /no hay lector de comandos para gh/);
});
