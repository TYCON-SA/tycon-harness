'use strict';
/**
 * refresh-after-main.test.js — el clasificador de la refirma tras traer `main` (scripts/lib/refresh-after-main.js).
 *
 * Cada prueba arma un repo de git: `main` con un archivo de control, un pedido que lo cambia con la constancia del
 * dueño, `main` que avanza sobre la misma ruta y el merge de `main` en el pedido. Sólo es refirma cuando el blob que se
 * firma es exactamente lo que git da al traer `main` sobre lo que el dueño firmó; todo lo demás es `control-change`.
 *
 * stable-data: los commits llevan fecha y autor fijos; ninguna prueba compara contra la hora real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ram = require('../lib/refresh-after-main.js');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
delete ENV.GIT_DIR; delete ENV.GIT_INDEX_FILE; delete ENV.GIT_WORK_TREE;

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env: ENV, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}
const LABS = [];
test.after(() => { for (const d of LABS) fs.rmSync(d, { recursive: true, force: true }); });

const F = 'scripts/hooks/control.sh';
const LINEAS = Array.from({ length: 12 }, (_, i) => `linea ${i + 1}`);
const texto = (cambios) => `${LINEAS.map((l, i) => (cambios[i + 1] !== undefined ? cambios[i + 1] : l)).join('\n')}\n`;

function escribir(dir, rel, contenido) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contenido);
}
function commit(dir, msg) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); }
const blob = (dir, rev, p = F) => git(dir, 'rev-parse', `${rev}:${p}`);
function hashOf(rules) {
  return crypto.createHash('sha256').update(rules.map((e) => `${e.path}\t${e.blob}\n`).sort().join('')).digest('hex');
}
const constancia = (rules, extra) => ({ hash: hashOf(rules), rules, at: '2026-01-01', by: 'dueño', ...(extra || {}) });

/**
 * El caso de siempre: el pedido cambia la línea 1 y el dueño lo firma; `main` cambia la línea 10; el pedido trae `main`.
 * Devuelve el repo, la constancia anterior y la entrada que se firma ahora.
 */
function refirmaReal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-after-main-'));
  LABS.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  escribir(dir, F, texto({}));
  commit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'pedido');
  escribir(dir, F, texto({ 1: 'linea 1 endurecida' }));
  const c = commit(dir, 'el cambio propio');
  const anterior = constancia([{ path: F, blob: blob(dir, c) }]);
  git(dir, 'checkout', '-q', 'main');
  escribir(dir, F, texto({ 10: 'linea 10 de main' }));
  commit(dir, 'main avanza');
  git(dir, 'checkout', '-q', 'pedido');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  return { dir, anterior, entrada: { path: F, blob: blob(dir, 'HEAD') } };
}
const clasificar = (dir, o) => ram.classify({ root: dir, base: 'main', tip: 'HEAD', approvals: [], baseHashes: new Set(), ...o });

test('RefreshAfterMain_TraerMain_EsRefirma (T40)', () => {
  const { dir, anterior, entrada } = refirmaReal();
  const r = clasificar(dir, { entries: [entrada], approvals: [anterior] });
  assert.strictEqual(r.clase, 'refresh-after-main', r.motivo);
  assert.strictEqual(r.refirma_de, anterior.hash);
});

test('RefreshAfterMain_CambioPropioNuevo_EsControl (T40)', () => {
  const { dir, anterior } = refirmaReal();
  // después de traer main, el pedido afloja otra línea: eso no lo firmó el dueño
  const actual = fs.readFileSync(path.join(dir, F), 'utf8');
  escribir(dir, F, actual.replace('linea 5', 'linea 5 aflojada'));
  commit(dir, 'otro cambio');
  const r = clasificar(dir, { entries: [{ path: F, blob: blob(dir, 'HEAD') }], approvals: [anterior] });
  assert.strictEqual(r.clase, 'control-change');
});

test('RefreshAfterMain_Conflicto_EsControl (T40)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-after-main-'));
  LABS.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  escribir(dir, F, texto({}));
  commit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'pedido');
  escribir(dir, F, texto({ 3: 'linea 3 del pedido' }));
  const c = commit(dir, 'el cambio propio');
  const anterior = constancia([{ path: F, blob: blob(dir, c) }]);
  git(dir, 'checkout', '-q', 'main');
  escribir(dir, F, texto({ 3: 'linea 3 de main' }));
  commit(dir, 'main toca la misma línea');
  git(dir, 'checkout', '-q', 'pedido');
  spawnSync('git', ['-C', dir, 'merge', '-q', '--no-edit', 'main'], { env: ENV });
  // el conflicto lo resuelve la sesión a mano: la resolución no la firmó nadie
  escribir(dir, F, texto({ 3: 'linea 3 resuelta' }));
  commit(dir, 'merge resuelto');
  const r = clasificar(dir, { entries: [{ path: F, blob: blob(dir, 'HEAD') }], approvals: [anterior] });
  assert.strictEqual(r.clase, 'control-change');
});

test('RefreshAfterMain_SinConstanciaOSinBase_EsControl (T40)', () => {
  const { dir, anterior, entrada } = refirmaReal();
  assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [] }).clase, 'control-change');
  assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [anterior], base: null }).clase, 'control-change');
  assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [anterior], base: '' }).clase, 'control-change');
});

test('RefreshAfterMain_SumaIgualEnOtroLugar_EsControl (T40)', () => {
  const { dir, anterior } = refirmaReal();
  // las mismas líneas que el merge, pero la del pedido en otro lugar del archivo: el diff línea por línea la aceptaría
  const lineas = fs.readFileSync(path.join(dir, F), 'utf8').split('\n');
  const [primera] = lineas.splice(0, 1, 'linea 1');
  lineas.splice(6, 1, primera);
  escribir(dir, F, lineas.join('\n'));
  commit(dir, 'la suma en otro lugar');
  const r = clasificar(dir, { entries: [{ path: F, blob: blob(dir, 'HEAD') }], approvals: [anterior] });
  assert.strictEqual(r.clase, 'control-change');
});

test('RefreshAfterMain_RefirmaSobreRefirma_EsControl (T40)', () => {
  const { dir, anterior, entrada } = refirmaReal();
  const delegada = { ...anterior, via: 'delegacion', clase: 'refresh-after-main', refirma_de: 'x', maquina: 'm', signed_by_session: 's' };
  const r = clasificar(dir, { entries: [entrada], approvals: [delegada] });
  assert.strictEqual(r.clase, 'control-change');
});

test('RefreshAfterMain_BorradoNuevoOErrorDeGit_EsControl (T40)', () => {
  // una entrada borrada: la ruta firmada ya no está en la punta
  {
    const r = refirmaReal();
    git(r.dir, 'rm', '-q', F);
    git(r.dir, 'commit', '-q', '-m', 'borra');
    const b = clasificar(r.dir, { entries: [r.entrada], approvals: [r.anterior] });
    assert.strictEqual(b.clase, 'control-change');
    assert.match(b.motivo, /no está en la punta/);
  }
  const { dir, anterior, entrada } = refirmaReal();
  // un archivo nuevo que cambió: no está en main, así que no hay qué traer
  escribir(dir, 'scripts/hooks/nuevo.sh', 'uno\n');
  const c = commit(dir, 'nuevo');
  const previa = constancia([{ path: 'scripts/hooks/nuevo.sh', blob: blob(dir, c, 'scripts/hooks/nuevo.sh') }]);
  escribir(dir, 'scripts/hooks/nuevo.sh', 'dos\n');
  commit(dir, 'nuevo cambia');
  const nuevo = { path: 'scripts/hooks/nuevo.sh', blob: blob(dir, 'HEAD', 'scripts/hooks/nuevo.sh') };
  assert.strictEqual(clasificar(dir, { entries: [nuevo], approvals: [previa] }).clase, 'control-change');
  // un commit que git no encuentra (un clon superficial, o un --base que no resuelve)
  assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [anterior], base: 'f'.repeat(40) }).clase, 'control-change');
  assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [anterior], root: path.join(dir, 'no-es-un-repo') }).clase, 'control-change');
});

test('RefreshAfterMain_CambioRevertidoEnMain_EsControl (T40)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-after-main-'));
  LABS.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  escribir(dir, F, texto({}));
  commit(dir, 'base');
  // un aflojamiento firmado por el dueño, mergeado en main y después revertido
  escribir(dir, F, texto({ 1: 'linea 1 aflojada' }));
  const w = commit(dir, 'aflojado y firmado');
  const vieja = constancia([{ path: F, blob: blob(dir, w) }]);
  escribir(dir, 'scripts/ci/approvals.jsonl', `${JSON.stringify(vieja)}\n`);
  commit(dir, 'la constancia');
  escribir(dir, F, texto({}));
  commit(dir, 'revert');
  // un pedido nuevo lo reaplica; main avanza; el pedido trae main
  git(dir, 'checkout', '-q', '-b', 'pedido');
  escribir(dir, F, texto({ 1: 'linea 1 aflojada' }));
  commit(dir, 'reaplica');
  git(dir, 'checkout', '-q', 'main');
  escribir(dir, F, texto({ 10: 'linea 10 de main' }));
  commit(dir, 'main avanza');
  git(dir, 'checkout', '-q', 'pedido');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  const r = clasificar(dir, { entries: [{ path: F, blob: blob(dir, 'HEAD') }], approvals: [vieja], baseHashes: new Set([vieja.hash]) });
  assert.strictEqual(r.clase, 'control-change');
  assert.match(r.motivo, /base/);
});

test('RefreshAfterMain_RenombreOModo_EsControl (T40)', () => {
  // main renombra la ruta que el pedido editó
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-after-main-'));
    LABS.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    escribir(dir, F, texto({}));
    commit(dir, 'base');
    git(dir, 'checkout', '-q', '-b', 'pedido');
    escribir(dir, F, texto({ 1: 'linea 1 endurecida' }));
    const c = commit(dir, 'el cambio propio');
    const anterior = constancia([{ path: F, blob: blob(dir, c) }]);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'mv', F, 'scripts/hooks/otro.sh');
    commit(dir, 'main renombra');
    git(dir, 'checkout', '-q', 'pedido');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    const r = clasificar(dir, { entries: [{ path: 'scripts/hooks/otro.sh', blob: blob(dir, 'HEAD', 'scripts/hooks/otro.sh') }], approvals: [anterior] });
    assert.strictEqual(r.clase, 'control-change');
  }
  // un cambio de modo sin cambio de contenido
  {
    const { dir, anterior, entrada } = refirmaReal();
    fs.chmodSync(path.join(dir, F), 0o755);
    git(dir, 'update-index', '--cacheinfo', `100755,${git(dir, 'rev-parse', `:${F}`)},${F}`);
    git(dir, 'commit', '-q', '-m', 'modo');
    assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [anterior] }).clase, 'control-change');
  }
  // un enlace cuyo destino es el texto que daría el merge: el mismo blob, otro tipo
  {
    const { dir, anterior, entrada } = refirmaReal();
    const contenido = git(dir, 'cat-file', 'blob', entrada.blob);
    const tree = git(dir, 'ls-tree', 'HEAD', '--', F);
    assert.ok(tree.startsWith('100644'), tree);
    spawnSync('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `120000,${entrada.blob},${F}`], { env: ENV });
    git(dir, 'commit', '-q', '-m', 'enlace');
    assert.ok(contenido.length > 0);
    assert.strictEqual(blob(dir, 'HEAD'), entrada.blob);
    assert.strictEqual(clasificar(dir, { entries: [entrada], approvals: [anterior] }).clase, 'control-change');
  }
});

test('RefreshAfterMain_MainAvanzaDespues_MismoResultado (T40)', () => {
  const { dir, anterior, entrada } = refirmaReal();
  const antes = clasificar(dir, { entries: [entrada], approvals: [anterior] });
  git(dir, 'checkout', '-q', 'main');
  escribir(dir, F, texto({ 10: 'linea 10 de main', 12: 'linea 12 de main' }));
  commit(dir, 'main vuelve a avanzar');
  git(dir, 'checkout', '-q', 'pedido');
  const despues = clasificar(dir, { entries: [entrada], approvals: [anterior] });
  assert.strictEqual(antes.clase, 'refresh-after-main');
  assert.deepStrictEqual(despues, antes);
});
