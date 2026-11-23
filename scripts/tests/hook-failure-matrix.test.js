'use strict';
// hook-failure-matrix.test.js — la matriz de fallas de los frenos (historia 8.159): cada freno de la tabla
// (scripts/setup/hook-failure-policy.json), con cada modo de falla, contra lo que pide su clase; y los caminos que hoy
// frenan al fallar, protegidos. Hoy la tabla trae el freno de publicación (la tanda 0).
// Todo aislado: casa temporal, un clon falso, sin red. Nada escribe en los registros de la máquina.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test hook-failure-matrix.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, GUARD, LAUNCHER, lab } = require('./lib/public-guard-lab.js');

const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hook-failure-policy.json'), 'utf8'));
const fila = POLICY.frenos.find((f) => f.guion === 'public-push-guard.js');
const EN_TERRENO = 'gh pr create -R TYCON-SA/tycon-harness --title t --body b';
const FUERA = 'ls -la';

test('Policy_PublicPush_RowWithClassTerrainAndPaths @story-8.159 @ac-0 — su renglón: crítico, su terreno, sus caminos y ningún timeout', () => {
  assert.ok(fila, 'el freno de publicación tiene su renglón');
  assert.strictEqual(fila.clase, 'critico');
  assert.match(fila.terreno, /gh/);
  assert.match(fila.terreno, /push/);
  assert.deepStrictEqual(fila.salidas_1_a_proposito, [], 'publicación no usa salidas 1');
  assert.strictEqual(fila.timeout_del_instalador, null);
  assert.strictEqual(fila.lanzador, 'node-missing-launcher.sh');
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const reg = list.hooks.find((h) => h.spec === '@tcg:public-push-guard.js');
  assert.ok(reg && reg.effect === 'blocks' && reg.event === fila.evento, 'el renglón corresponde a un registro que frena');
  assert.strictEqual(reg.launcher, fila.lanzador, 'la lista registra el mismo lanzador');
});

test('T11 Matrix_FailClosedToday_EveryPathStillBlocks @story-8.159 @ac-0 — cada camino que hoy frena al fallar sigue frenando', (t) => {
  const L = lab(t);
  const casos = {
    'entrada-sin-comando-con-gh': () => L.correr(`esto no es json ${EN_TERRENO}`),
    'error-propio-con-gh-o-push': () => [L.correr(L.evento(EN_TERRENO), { guion: L.sola }), L.correr(L.evento('git push origin main'), { guion: L.sola })],
    'error-en-la-salida-principal': () => [L.correr(L.evento(EN_TERRENO), { guion: L.roto('throw') }), L.correr(L.evento(FUERA), { guion: L.roto('throw') })],
    'sin-node-en-su-terreno': () => L.correr(L.evento(EN_TERRENO), { argv: ['/bin/bash', LAUNCHER, 'node-que-no-esta', GUARD] }),
    'reloj-vencido-en-su-terreno': () => L.correr(L.evento(EN_TERRENO), { guion: L.roto('hang'), extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '400' } }),
  };
  for (const c of [...fila.fail_closed_today, ...fila.fail_closed_new]) {
    assert.ok(casos[c.camino], `el camino «${c.camino}» tiene su caso en la matriz`);
    for (const r of [].concat(casos[c.camino]())) assert.strictEqual(r.code, 2, `${c.camino}: frena (${r.err.slice(0, 160)})`);
  }
});

test('Matrix_PublicPush_EveryModeInTerrainBlocks_OutsidePasses @story-8.159 @ac-0 — cada modo de falla, con y sin su terreno', (t) => {
  const L = lab(t);
  const sinGit = L.pathSin('git');
  const modos = {
    'no es JSON': (cmd) => L.correr(`no es json ${cmd}`),
    'JSON sin el campo': (cmd) => L.correr(JSON.stringify({ tool_input: { otra: cmd } })),
    'sin sus bibliotecas': (cmd) => L.correr(L.evento(cmd), { guion: L.sola }),
    'sin node': (cmd) => L.correr(L.evento(cmd), { argv: ['/bin/bash', LAUNCHER, 'node-que-no-esta', GUARD] }),
    'reloj vencido': (cmd) => L.correr(L.evento(cmd), { guion: L.roto('hang'), extra: { TYCON_PUBLIC_GUARD_CLOCK_MS: '400' } }),
  };
  // la entrada vacía no puede traer un `gh`: sólo tiene su variante fuera del terreno
  const vacia = L.correr('');
  assert.strictEqual(vacia.code, 0, `vacía: pasa (${vacia.err.slice(0, 160)})`);
  assert.match(vacia.err, /no freno, pero tampoco miré/, 'vacía: lo dice');
  // sin git el freno no queda ciego: revisa el texto y decide igual que con git (en el laboratorio, sin la lista del
  // equipo, deja pasar el `gh` revisado). Lo que se exige es que no lo tome por una falla propia
  for (const cmd of [EN_TERRENO, FUERA]) {
    const con = L.correr(L.evento(cmd));
    const sin = L.correr(L.evento(cmd), { extra: { PATH: sinGit } });
    assert.strictEqual(sin.code, con.code, `sin git, ${cmd}: decide igual que con git (${sin.err.slice(0, 160)})`);
    assert.doesNotMatch(sin.err, /falló por dentro/, `sin git, ${cmd}: no es una falla propia`);
  }
  for (const [modo, correr] of Object.entries(modos)) {
    const dentro = correr(EN_TERRENO);
    assert.strictEqual(dentro.code, 2, `${modo}, con un gh que publica: frena (${dentro.err.slice(0, 160)})`);
    const fuera = correr(FUERA);
    assert.strictEqual(fuera.code, 0, `${modo}, fuera de su terreno: pasa (${fuera.err.slice(0, 160)})`);
  }
});
