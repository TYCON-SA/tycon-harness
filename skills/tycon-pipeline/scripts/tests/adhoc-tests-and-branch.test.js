#!/usr/bin/env node
'use strict';
/**
 * adhoc-tests-and-branch.test.js — las pruebas y la rama del camino corto.
 *
 *   T40 `adhoc test` corre el comando y anota el final de la salida, la hora, el código y la huella; sale con el código
 *       del comando; sin carril no corre nada
 *   T41 sin corrida, o con la corrida en rojo, guardar frena con «faltan las pruebas» y el comando
 *   T42 en verde con la huella de hoy, guardar pasa al sí; editar código después la vence y vuelve a frenar
 *   T43 un carril que sólo tocó guías o datos guarda sin corrida
 *   T44 con `sobreCupo`, en la rama principal del remoto frena con «creá una rama»; sin poder leerla, main y master
 *       frenan con aviso; en otra rama, con las pruebas en verde, commit y push pasan al sí; sin ellas, frena
 *   T45 sin `sobreCupo` (dentro del tope) la rama principal no frena por esta regla; con una corrida abierta, manda ella
 *
 * stable-data: crea repos de git en carpetas temporales con commits propios; nunca toca el repo real.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/adhoc-tests-and-branch.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const saveBrake = require(path.join(SCRIPTS, 'lib', 'save-brake.js'));

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitear = (dir, msg = 'x') => git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** Un repo con su origen y `main` empujada; `origin/HEAD` apunta a la rama por defecto del remoto. */
function repo(raiz, nombre, { rama = 'main' } = {}) {
  const origen = path.join(raiz, `${nombre}-origen.git`);
  const dir = path.join(raiz, nombre);
  execFileSync('git', ['init', '-q', '--bare', '-b', rama, origen]);
  execFileSync('git', ['init', '-q', '-b', rama, dir]);
  git(dir, 'remote', 'add', 'origin', origen);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  commitear(dir, 'base');
  git(dir, 'push', '-q', 'origin', rama);
  git(dir, 'remote', 'set-head', 'origin', rama);
  return dir;
}
function escribir(dir, rel, txt = 'x\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), txt);
  return path.join(dir, rel);
}
const estado = (h) => path.join(h, '.claude', '.tycon-pipeline');
function conCarril(home, sid, extra = {}) {
  const state = estado(home);
  fs.mkdirSync(path.join(state, 'adhoc'), { recursive: true });
  const ts = new Date().toISOString();
  const a = { reason: 'arreglo del combo de clientes', maxFiles: 5, files: [], declaredAt: ts, lastTouch: ts, firmadaEn: ts, datos: 'sin-cambio', ...extra };
  fs.writeFileSync(path.join(state, 'adhoc', `${sid}.json`), JSON.stringify(a));
  fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts, name: 'adhoc-lane-signed', status: 'ok', destino: sid })}\n`);
  return state;
}
const leerCarril = (h, sid) => JSON.parse(fs.readFileSync(path.join(estado(h), 'adhoc', `${sid}.json`), 'utf8'));
function marker(h, sid, args, { cwd } = {}) {
  const env = { ...process.env, HOME: h, USERPROFILE: h, CLAUDE_CODE_SESSION_ID: sid };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [MARKER, ...args], { cwd, encoding: 'utf8', env });
}
const guardar = (dir, sid, home, command = 'git commit -m x') => saveBrake.decidir({ command, cwd: dir, sid, home });
/** Un carril con lista y un archivo de código preparado para el commit. */
function conCodigo(raiz, h, sid, extra = {}) {
  const dir = repo(raiz, 'producto');
  const a = escribir(dir, 'src/a.js');
  git(dir, 'add', '.');
  conCarril(h, sid, { allowedFiles: [a], files: [a], bases: { [dir]: { sha: git(dir, 'rev-parse', 'HEAD'), traida: true } }, ...extra });
  return { dir, a };
}
const verde = (h, sid, cwd) => marker(h, sid, ['adhoc', 'test', '--', process.execPath, '-e', 'process.exit(0)'], { cwd });

test('T40 AdhocTest_CorreYAnota — @story-8.174 @ac-37', () => {
  const raiz = tmp('t40-');
  const h = tmp('home-');
  const { dir } = conCodigo(raiz, h, 's40');
  const r = marker(h, 's40', ['adhoc', 'test', '--', process.execPath, '-e', 'console.log("ok 1 - el combo"); process.exit(3)'], { cwd: dir });
  assert.equal(r.status, 3, 'sale con el código del comando');
  assert.match(r.stdout, /ok 1 - el combo/);
  const p = leerCarril(h, 's40').pruebas;
  assert.equal(p.codigo, 3);
  assert.match(p.salida, /ok 1 - el combo/);
  assert.ok(Date.parse(p.at) > 0);
  assert.match(p.huella, /^[0-9a-f]{64}$/);
  assert.match(p.comando, /process\.exit\(3\)/);
  // sin carril abierto no corre nada
  const h2 = tmp('home-');
  const marca = path.join(raiz, 'corrio');
  const sin = marker(h2, 'nadie', ['adhoc', 'test', '--', process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marca)}, "x")`], { cwd: dir });
  assert.notEqual(sin.status, 0);
  assert.match(sin.stderr, /no tiene un camino corto abierto/);
  assert.ok(!fs.existsSync(marca), 'no corrió el comando');
});

// 🔴 Falla con: en Windows, `npm` es un .cmd y sin consola no arranca: el carril con código no guardaba nunca (pase de la
// 8.245, clase 17). La CI de Windows de cada pedido es la que la ejercita.
test('T40b AdhocTest_NpmArranca — @story-8.174 @ac-37', () => {
  const raiz = tmp('t40b-');
  const h = tmp('home-');
  const { dir } = conCodigo(raiz, h, 's40b');
  const r = marker(h, 's40b', ['adhoc', 'test', '--', 'npm', '--version'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(leerCarril(h, 's40b').pruebas.codigo, 0);
});

test('T41 Guardar_SinPruebas_Frena — @story-8.174 @ac-38', () => {
  const raiz = tmp('t41-');
  const h = tmp('home-');
  const { dir } = conCodigo(raiz, h, 's41');
  git(dir, 'switch', '-q', '-c', 'arreglo');
  const g = guardar(dir, 's41', h);
  assert.ok(g && g.texto && /faltan las pruebas/.test(g.texto) && /adhoc test --/.test(g.texto), JSON.stringify(g));
  // con la corrida en rojo, también
  marker(h, 's41', ['adhoc', 'test', '--', process.execPath, '-e', 'process.exit(1)'], { cwd: dir });
  const g2 = guardar(dir, 's41', h);
  assert.ok(g2 && g2.texto && /faltan las pruebas/.test(g2.texto) && /sali[oó] con 1/.test(g2.texto), JSON.stringify(g2));
});

test('T42 Guardar_ConPruebasDeHoy_Pasa_YVencen — @story-8.174 @ac-39', () => {
  const raiz = tmp('t42-');
  const h = tmp('home-');
  const { dir, a } = conCodigo(raiz, h, 's42');
  git(dir, 'switch', '-q', '-c', 'arreglo');
  assert.equal(verde(h, 's42', dir).status, 0);
  const g = guardar(dir, 's42', h);
  assert.ok(g && !g.texto && typeof g.pregunta === 'string', JSON.stringify(g));
  // editar un archivo de código después vence la corrida
  fs.writeFileSync(a, 'y\n');
  const g2 = guardar(dir, 's42', h);
  assert.ok(g2 && g2.texto && /faltan las pruebas/.test(g2.texto) && /cambi[oó] despu[eé]s/.test(g2.texto), JSON.stringify(g2));
});

test('T43 Guardar_SinCodigo_NoPidePruebas — @story-8.174 @ac-40', () => {
  const raiz = tmp('t43-');
  const dir = repo(raiz, 'producto');
  const h = tmp('home-');
  const guia = escribir(dir, 'docs/guia.md');
  const datos = escribir(dir, 'data/precios.csv', 'a,b\n');
  git(dir, 'add', '.');
  conCarril(h, 's43', { allowedFiles: [guia, datos], files: [guia, datos], bases: { [dir]: { sha: git(dir, 'rev-parse', 'HEAD'), traida: true } } });
  const g = guardar(dir, 's43', h);
  assert.ok(g && !g.texto && typeof g.pregunta === 'string', JSON.stringify(g));
});

test('T44 SobreCupo_RamaPrincipalFrena_OtraPasa — @story-8.174 @ac-41', () => {
  const raiz = tmp('t44-');
  const h = tmp('home-');
  const { dir } = conCodigo(raiz, h, 's44', { sobreCupo: true, cupoPedido: 9, maxFiles: 9, eligio: 'persona' });
  assert.equal(verde(h, 's44', dir).status, 0);
  // en la rama por defecto del remoto: frena con «creá una rama» y el comando, aunque las pruebas estén en verde
  const g = guardar(dir, 's44', h);
  assert.ok(g && g.texto && /creá una rama/.test(g.texto) && /git switch -c/.test(g.texto), JSON.stringify(g));
  const p = guardar(dir, 's44', h, 'git push origin HEAD:main');
  assert.ok(p && p.texto && /creá una rama/.test(p.texto), JSON.stringify(p));
  // la rama por defecto del remoto es la que manda: con `trunk`, `trunk` frena
  const raiz2 = tmp('t44b-');
  const h2 = tmp('home-');
  const otro = repo(raiz2, 'producto', { rama: 'trunk' });
  const b = escribir(otro, 'src/b.js');
  git(otro, 'add', '.');
  conCarril(h2, 's44b', { allowedFiles: [b], files: [b], sobreCupo: true, cupoPedido: 9, maxFiles: 9, bases: { [otro]: { sha: git(otro, 'rev-parse', 'HEAD'), traida: true } } });
  assert.equal(verde(h2, 's44b', otro).status, 0);
  assert.match((guardar(otro, 's44b', h2) || {}).texto || '', /creá una rama.*\(trunk\)/);
  // sin poder leer la del remoto: main y master frenan, con aviso
  git(dir, 'remote', 'set-head', 'origin', '-d');
  const g3 = guardar(dir, 's44', h);
  assert.ok(g3 && g3.texto && /creá una rama/.test(g3.texto), JSON.stringify(g3));
  assert.match(fs.readFileSync(path.join(estado(h), 'gates.log'), 'utf8'), /main y master/);
  // en otra rama, con las pruebas en verde: commit y push pasan al sí
  git(dir, 'switch', '-q', '-c', 'arreglo-grande');
  assert.equal(verde(h, 's44', dir).status, 0);
  for (const command of ['git commit -m x', 'git push origin arreglo-grande']) {
    const d = guardar(dir, 's44', h, command);
    assert.ok(d && !d.texto && typeof d.pregunta === 'string', `${command}: ${JSON.stringify(d)}`);
  }
  // 🔴 Falla con: un push de todas las ramas desde otra rama, que se llevaba también la principal (pase de la 8.245)
  for (const command of ['git push --all origin', 'git push --mirror origin', 'git push --al origin', 'git push --mir origin', 'git push --bra origin']) {
    assert.match((guardar(dir, 's44', h, command) || {}).texto || '', /creá una rama/, command);
  }
  // 🔴 Falla con: un push sin rama escrita cuyo destino elige la configuración de git (la rama de arriba es main, el
  // remoto es espejo, o push.default=matching): llegaba a main sin que el freno lo viera (pase de la 8.245, clase 5)
  const conConfig = (pares, command) => {
    for (const [k, v] of pares) git(dir, 'config', k, v);
    try { return (guardar(dir, 's44', h, command) || {}).texto || ''; } finally { for (const [k] of pares) git(dir, 'config', '--unset', k); }
  };
  assert.match(conConfig([['push.default', 'upstream'], ['branch.arreglo-grande.remote', 'origin'], ['branch.arreglo-grande.merge', 'refs/heads/main']], 'git push'), /creá una rama/);
  assert.match(conConfig([['remote.origin.mirror', 'true']], 'git push origin'), /creá una rama/);
  assert.match(conConfig([['push.default', 'matching']], 'git push origin'), /creá una rama/);
  assert.match(conConfig([['remote.origin.push', 'refs/heads/*:refs/heads/*']], 'git push origin'), /creá una rama/);
  // la rama de arriba que no es la principal no frena por esta regla
  assert.doesNotMatch(conConfig([['push.default', 'upstream'], ['branch.arreglo-grande.remote', 'origin'], ['branch.arreglo-grande.merge', 'refs/heads/arreglo-grande']], 'git push'), /creá una rama/);
  // sin ellas, frena por las pruebas
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'cambio\n');
  assert.match((guardar(dir, 's44', h) || {}).texto || '', /faltan las pruebas/);
});

test('T45 SinSobreCupo_LaRamaNoFrena — @story-8.174 @ac-43', () => {
  const raiz = tmp('t45-');
  const h = tmp('home-');
  const { dir } = conCodigo(raiz, h, 's45');
  assert.equal(verde(h, 's45', dir).status, 0);
  // dentro del tope, en main: no frena por la rama
  const g = guardar(dir, 's45', h);
  assert.ok(g && !g.texto && typeof g.pregunta === 'string', JSON.stringify(g));
  // cerrado con `adhoc clear`: no hay carril, y la rama no frena
  assert.equal(marker(h, 's45', ['adhoc', 'clear'], { cwd: dir }).status, 0);
  assert.ok(!(guardar(dir, 's45', h) || {}).texto);
  // con una corrida de historia abierta manda la corrida: pregunta por la historia, no por la rama
  const h3 = tmp('home-');
  conCodigo(tmp('t45c-'), h3, 's45c', { sobreCupo: true, cupoPedido: 9, maxFiles: 9 });
  const run = path.join(estado(h3), 'runs');
  fs.mkdirSync(run, { recursive: true });
  const markerPath = require(path.join(SCRIPTS, 'lib', 'open-runs.js')).markerPath('s45c', h3);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({ storyId: '9.9', repos: [dir] }));
  const d = guardar(dir, 's45c', h3);
  assert.ok(!d || !d.texto || !/creá una rama/.test(d.texto), JSON.stringify(d));
});
