#!/usr/bin/env node
'use strict';
// compare-matrix.test.js — la medida de dos versiones de la matriz: sólo lee, y por salida sólo da rótulos.
//
// stable-data: no lee el reloj; los commits de los repos de prueba llevan fechas fijas.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.resolve(__dirname, '..', 'tools', 'compare-matrix.js');

const temporales = [];
after(() => { for (const d of temporales) fs.rmSync(d, { recursive: true, force: true }); });
function carpeta() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'comparar-')));
  temporales.push(d);
  return d;
}

const ENTORNO_GIT = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '1790000000 +0000', GIT_COMMITTER_DATE: '1790000000 +0000' };
function git(repo, args) {
  const r = spawnSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...ENTORNO_GIT, HOME: repo } });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** Un repo con historias: `TITULO-SECRETO` y la carpeta no pueden aparecer en la salida. */
function repoConHistorias(nombres = ['cambia', 'igual', 'roja', 'exenta']) {
  const raiz = carpeta();
  const repo = path.join(raiz, 'repo-privado-de-prueba');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo de prueba\n');
  nombres.forEach((n, i) => {
    fs.writeFileSync(path.join(repo, 'specs', `1-${i + 1}-${n}.md`), [
      '---', `story: "1.${i + 1}"`, 'epic: 1', 'status: review', `title: "TITULO-SECRETO ${n}"`, '---', '', `# ${n}`, '',
    ].join('\n'));
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'historias']);
  return repo;
}

/** Una versión de la matriz de juguete: `compute` devuelve según el nombre del archivo de la historia. */
function version(cuerpo, marcas) {
  const dir = carpeta();
  const ruta = path.join(dir, 'skills', 'tycon-pipeline', 'scripts');
  fs.mkdirSync(ruta, { recursive: true });
  fs.writeFileSync(path.join(ruta, 'runtime-matrix.js'), `
    const fs = require('fs');
    const path = require('path');
    const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const marca = ${JSON.stringify(marcas || null)};
    function compute({ storyPath }) {
      const n = path.basename(storyPath);
      if (marca) fs.appendFileSync(marca, 'entra ' + n + '\\n');
      dormir(5);
      const r = (${cuerpo})(n);
      if (marca) fs.appendFileSync(marca, 'sale ' + n + '\\n');
      return r;
    }
    module.exports = { compute };
  `);
  return dir;
}

const fila = (green, v = 'RUNTIME') => `{ green: ${green}, acs: [1], perAc: { 1: { verdict: "${v}" } } }`;
const LANZA = '(() => { throw Object.assign(new Error("x"), { code: "ROTA" }); })()';
// cambia: verde a rojo · igual: verde · roja: rojo igual · exenta: exenta en las dos · sube: rojo a verde · mueve: rojo con
// otro veredicto · rota: no se puede calcular · media: exenta antes y roja después · nula, incompleta y vacia: un resultado
// que no se sabe leer (nada, sin perAc, sin criterios)
const ANTES = `(n) => /exenta|media/.test(n) ? { exempt: true } : /roja|sube|mueve/.test(n) ? ${fila(false, 'NOT-RUN')} : /rota/.test(n) ? ${LANZA} : ${fila(true)}`;
const DESPUES = `(n) => /exenta/.test(n) ? { exempt: true } : /cambia|roja|media/.test(n) ? ${fila(false, 'NOT-RUN')} : /mueve/.test(n) ? ${fila(false, 'SIN-EVIDENCIA')} : /rota/.test(n) ? { structuralError: "x" }`
  + ` : /nula/.test(n) ? null : /incompleta/.test(n) ? { green: true, acs: [1] } : /vacia/.test(n) ? { green: true, acs: [], perAc: {} } : ${fila(true)}`;

function comparar(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

function fotoDe(repo) {
  const archivos = git(repo, ['ls-files']).split('\n').map((f) => [f, fs.readFileSync(path.join(repo, f), 'utf8')]);
  return { status: git(repo, ['status', '--porcelain']), head: git(repo, ['rev-parse', 'HEAD']), archivos, lista: fs.readdirSync(repo) };
}

test('T24 CompareMatrix_Totales @story-8.193 @ac-23', () => {
  const repo = repoConHistorias(['cambia', 'igual', 'roja', 'exenta', 'sube', 'mueve', 'rota', 'media']);
  const otro = repoConHistorias(['cambia', 'igual']);
  const detalle = path.join(carpeta(), 'detalle.jsonl');
  const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, '--repo', `repo-b=${otro}`, '--detail', detalle, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const { repos, total } = JSON.parse(r.stdout);
  assert.deepStrictEqual(repos['repo-a'], { historias: 8, verdeARojo: 2, rojoAVerde: 1, rojoARojoCambia: 1, rojoARojoIgual: 1, verdeIgual: 1, exenta: 1, error: 1 });
  assert.deepStrictEqual(repos['repo-b'], { historias: 2, verdeARojo: 1, rojoAVerde: 0, rojoARojoCambia: 0, rojoARojoIgual: 0, verdeIgual: 1, exenta: 0, error: 0 });
  assert.deepStrictEqual(total, { historias: 10, verdeARojo: 3, rojoAVerde: 1, rojoARojoCambia: 1, rojoARojoIgual: 1, verdeIgual: 2, exenta: 1, error: 1 });
  // la que no se pudo calcular dice por qué, sin rutas
  const rota = fs.readFileSync(detalle, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.ruta.includes('rota'));
  assert.strictEqual(rota.cambio, 'error');
  assert.strictEqual(rota.motivo, 'antes: ROTA · después: error de estructura');
});

test('T54 CompareMatrix_ResultadoIlegible_EsError @story-8.193 @ac-23', () => {
  const repo = repoConHistorias(['igual', 'nula', 'incompleta', 'vacia']);
  const detalle = path.join(carpeta(), 'detalle.jsonl');
  const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, '--detail', detalle, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).total.error, 3);
  const motivos = fs.readFileSync(detalle, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cambio === 'error').map((l) => l.motivo).sort();
  assert.deepStrictEqual(motivos, ['después: resultado sin green, acs o perAc', 'después: sin resultado', 'después: sin un veredicto por criterio']);
});

test('T50 CompareMatrix_DeAUnaHistoria @story-8.193 @ac-23', () => {
  const marcas = path.join(carpeta(), 'marcas');
  const repo = repoConHistorias();
  const r = comparar(['--before', version(ANTES, marcas), '--after', version(DESPUES, marcas), '--repo', `repo-a=${repo}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = fs.readFileSync(marcas, 'utf8').trim().split('\n');
  assert.strictEqual(lineas.length, 4 * 2 * 2);
  // alternan: nadie entra antes de que salga el anterior
  lineas.forEach((l, i) => assert.ok(l.startsWith(i % 2 === 0 ? 'entra ' : 'sale '), `${i}: ${l}`));
  // en el orden de las historias, las dos versiones de cada una seguidas
  const entradas = lineas.filter((l) => l.startsWith('entra ')).map((l) => l.slice(6));
  for (let i = 0; i < entradas.length; i += 2) assert.strictEqual(entradas[i], entradas[i + 1]);
  const orden = entradas.filter((_, i) => i % 2 === 0);
  assert.deepStrictEqual(orden, [...orden].sort());
});

test('T25 CompareMatrix_NoEscribe @story-8.193 @ac-24', () => {
  const repo = repoConHistorias();
  const antes = fotoDe(repo);
  const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fotoDe(repo), antes);
});

test('T26 CompareMatrix_SalidaSoloRotulos @story-8.193 @ac-25', () => {
  const repo = repoConHistorias();
  const fuera = path.join(carpeta(), 'detalle.jsonl');
  for (const extra of [[], ['--json'], ['--detail', fuera]]) {
    const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, ...extra]);
    assert.strictEqual(r.status, 0, r.stderr);
    const salida = r.stdout + r.stderr;
    assert.match(salida, /repo-a/);
    for (const prohibido of ['repo-privado-de-prueba', 'TITULO-SECRETO', '1-1-cambia']) assert.ok(!salida.includes(prohibido), `la salida nombra ${prohibido}`);
  }
});

test('T27 CompareMatrix_DetalleDentroDelRepo_Sale2 @story-8.193 @ac-25', () => {
  const repo = repoConHistorias();
  const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, '--detail', path.join(repo, 'detalle.jsonl')]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /repo-a/);
  assert.ok(!fs.existsSync(path.join(repo, 'detalle.jsonl')));
});

test('T41 CompareMatrix_Detalle_UnaLineaPorHistoria @story-8.193 @ac-25', () => {
  const repo = repoConHistorias();
  const detalle = path.join(carpeta(), 'detalle.jsonl');
  const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, '--detail', detalle, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const lineas = fs.readFileSync(detalle, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lineas.length, 4);
  for (const l of lineas) {
    assert.strictEqual(l.rotulo, 'repo-a');
    assert.match(l.ruta, /^specs\/1-\d-/);
    assert.strictEqual(l.status, 'review');
  }
  assert.strictEqual(lineas.find((l) => l.ruta.includes('cambia')).cambio, 'verde-a-rojo');
  assert.strictEqual(fs.statSync(detalle).mode & 0o077, 0, 'la lista nombra proyectos: sólo la lee quien la escribió');
  const { total } = JSON.parse(r.stdout);
  assert.strictEqual(lineas.filter((l) => l.cambio === 'verde-a-rojo').length, total.verdeARojo);
});

test('T30 CompareMatrix_CarpetaInvalida_Sale2 @story-8.193 @ac-29', () => {
  const sinGit = carpeta();
  const sinHistorias = repoConHistorias([]);
  const todasRotas = repoConHistorias(['rota']);
  for (const dir of [path.join(sinGit, 'no-existe'), sinGit, sinHistorias, todasRotas]) {
    const r = comparar(['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-roto=${dir}`, '--json']);
    assert.strictEqual(r.status, 2, dir);
    assert.match(r.stderr, /repo-roto/);
    assert.strictEqual(r.stdout, '');
  }
});

test('T53 CompareMatrix_SinMedir_Sale2 @story-8.193 @ac-25 @ac-29', () => {
  const repo = repoConHistorias();
  const fuera = carpeta();
  fs.symlinkSync(path.join(repo, 'specs', 'enlazado.jsonl'), path.join(fuera, 'enlace.jsonl'));
  fs.mkdirSync(path.join(fuera, 'es-carpeta'));
  const base = ['--before', version(ANTES), '--after', version(DESPUES)];
  for (const [nombre, args] of [
    ['--detail sin valor', [...base, '--repo', `repo-a=${repo}`, '--detail']],
    ['--detail seguido de otra opción', [...base, '--repo', `repo-a=${repo}`, '--detail', '--json']],
    ['--before sin valor', ['--before', '--after', version(DESPUES), '--repo', `repo-a=${repo}`]],
    ['rótulo repetido', [...base, '--repo', `repo-a=${repo}`, '--repo', `repo-a=${repoConHistorias()}`]],
    ['el mismo repo con dos rótulos', [...base, '--repo', `repo-a=${repo}`, '--repo', `repo-b=${path.join(repo, 'specs')}`]],
    ['--detail que es una carpeta', [...base, '--repo', `repo-a=${repo}`, '--detail', path.join(fuera, 'es-carpeta')]],
    ['versión de antes que no carga', ['--before', carpeta(), '--after', version(DESPUES), '--repo', `repo-a=${repo}`]],
    ['versión de después que no carga', ['--before', version(ANTES), '--after', carpeta(), '--repo', `repo-a=${repo}`]],
    ['--repo sin =', ['--before', version(ANTES), '--after', version(DESPUES), '--repo', repo]],
    ['sin --repo', ['--before', version(ANTES), '--after', version(DESPUES)]],
    ['--detail en una carpeta que no existe', ['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, '--detail', path.join(fuera, 'no', 'x.jsonl')]],
    ['--detail que es un enlace al repo', ['--before', version(ANTES), '--after', version(DESPUES), '--repo', `repo-a=${repo}`, '--detail', path.join(fuera, 'enlace.jsonl')]],
  ]) {
    const r = comparar(args);
    assert.strictEqual(r.status, 2, nombre);
    assert.strictEqual(r.stdout, '', nombre);
  }
  assert.ok(!fs.existsSync(path.join(repo, 'specs', 'enlazado.jsonl')), 'escribió a través del enlace');
  assert.ok(!fs.existsSync(path.join(process.cwd(), '--json')), 'tomó la opción siguiente como archivo');
  // un archivo que ya existía con permisos amplios queda sólo para quien lo escribe
  const viejo = path.join(fuera, 'viejo.jsonl');
  fs.writeFileSync(viejo, '', { mode: 0o644 });
  fs.chmodSync(viejo, 0o644);
  const r = comparar([...base, '--repo', `repo-a=${repo}`, '--detail', viejo]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.statSync(viejo).mode & 0o077, 0);
});
