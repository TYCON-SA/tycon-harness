#!/usr/bin/env node
'use strict';
// hook-failures-notice.test.js — el aviso de arranque que cuenta las fallas de los controles de las últimas 24 horas en
// hook-errors.log: una línea por control, con las veces que dejó pasar y las que frenó; las formas de línea de cada
// escritor; lo viejo, lo del freno de producción y lo que no es una falla no cuentan; calla sin registro y dice cuando no
// lo puede leer. Corre `main` con un HOME temporal y una hora fija.
// stable-data: la hora es fija (AHORA) y los sellos del registro se arman a partir de ella.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const { main } = require(path.join(SCRIPTS, 'hooks', 'hook-failures-notice.js'));
const { stateDir } = require(path.join(SCRIPTS, 'setup', 'harness', 'tycon-home.js'));

const AHORA = Date.parse('2026-11-14T12:00:00.000Z');
const hace = (horas) => new Date(AHORA - horas * 3600 * 1000).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hook-failures-notice-'));

function correr(home) {
  let out = '';
  main({ home, now: AHORA, write: (t) => { out += t; } });
  return out;
}
function sembrar(registros) {
  const home = tmp();
  const dir = stateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hook-errors.log'), registros.join(''), 'utf8');
  return home;
}

test('T16 Notice_CountsLast24hPerControl @story-8.257 @ac-11 @ac-14', () => {
  // 🔴 rojo si: no cuenta una de las formas, cuenta lo viejo, lo de producción o lo que no es una falla, o rompe.
  const home = sembrar([
    `[${hace(1)}] dispatch handler "on-write-collision" FAILED OPEN: Error: x\n\n`,
    `[${hace(2)}] dispatch handler "on-write-collision" FAILED OPEN: Error: x\n\n`,
    `[${hace(3)}] dispatch handler "on-write-collision" FAILED OPEN (frena desde 2026-11-28): Error: x\n\n`,
    `[${hace(1)}] dispatch handler "on-dod-evidence-guard" FAILED CLOSED: SyntaxError: y\n\n`,
    `[${hace(1)}] safety-guard ERR-FAIL-OPEN línea 190: grep -q zz "$CMD"\n\n`,
    `[${hace(1)}] on-frontmatter-write.js FAILED OPEN — DoD gate NO aplicado:\nError: z\n    at algo (x.js:1:1)\n\n`,
    `[${hace(1)}] on-skill-invoke FAILED OPEN: Error: w\n    at f (y.js:2:2)\n\n`,
    `[${hace(1)}] on-bash-write-gate FRENÓ POR FALLA: Error: v\n\n`,
    `[${hace(1)}] dispatch FAILED OPEN: entrada ilegible\n\n`,
    `[${hace(1)}] algo raro FAILED OPEN: sin nombre\n\n`,
    `[${hace(72)}] dispatch handler "on-red-test-edit" FAILED CLOSED: viejo\n\n`,
    `[${hace(1)}] prod-access-guard FAILED OPEN: del freno de producción\n\n`,
    `[${hace(1)}] coordination-write: no pude anotar\n\n`,
  ]);
  const out = correr(home);
  const linea = (nombre) => out.split('\n').find((l) => l.includes(`· ${nombre}:`)) || '';
  assert.match(linea('on-write-collision'), /3 dejando pasar/);
  assert.doesNotMatch(linea('on-write-collision'), /frenando/);
  assert.match(linea('on-dod-evidence-guard'), /1 frenando/);
  assert.match(linea('safety-guard'), /1 dejando pasar/);
  assert.match(linea('on-frontmatter-write'), /1 dejando pasar/);
  assert.match(linea('on-skill-invoke'), /1 dejando pasar/);
  assert.match(linea('on-bash-write-gate'), /1 frenando/);
  assert.match(linea('dispatch'), /1 dejando pasar/);
  assert.match(linea('control sin nombre'), /1 dejando pasar/);
  assert.doesNotMatch(out, /on-red-test-edit/, 'contó una falla de hace 3 días');
  assert.doesNotMatch(out, /prod-access-guard/, 'contó una línea del freno de producción');
  assert.doesNotMatch(out, /coordination-write/, 'contó un renglón sin marca de falla');
  assert.doesNotMatch(out, /on-frontmatter-write\.js/, 'el nombre lleva el .js');
  assert.ok(out.includes(path.join(stateDir(home), 'hook-errors.log')), 'falta la ruta del registro');
  assert.equal(out.split('\n').filter((l) => l.includes('· ')).length, 8, `una línea por control:\n${out}`);
});

test('T16b Notice_LineSeparatorInMessage_StillCounts @story-8.257 @ac-14', () => {
  // 🔴 rojo si: un separador de renglón de Unicode (U+2028/U+2029) en el mensaje hace que el registro no se reconozca
  // y se saltee callado (prueba del pase adversarial).
  const home = sembrar([
    `[${hace(1)}] on-skill-invoke FAILED OPEN: Error: texto con separador\n\n`,
    `[${hace(1)}] dispatch handler "on-y" FAILED CLOSED: SyntaxError: x y\n\n`,
  ]);
  const out = correr(home);
  assert.match(out, /· on-skill-invoke: 1 dejando pasar/);
  assert.match(out, /· on-y: 1 frenando/);
});

test('T16c Notice_ContinuationAndBadStamp_NotCounted_UnnamedClosed @story-8.257 @ac-11 @ac-14', () => {
  // 🔴 rojo si: un renglón sin sello (o con un sello que no es una fecha) que trae una marca abre un registro y se
  // cuenta, o una falla cerrada sin nombre no llega a «control sin nombre».
  const home = sembrar([
    `[${hace(1)}] coordination-write: no pude anotar\nError: x FAILED OPEN en la pila\n    at f (y.js:1:1)\n\n`,
    `[basura] dispatch handler "on-z" FAILED OPEN: sin fecha\n\n`,
    `[2026-99-99T00:00:00Z] dispatch handler "on-z" FAILED OPEN: forma de fecha, fecha imposible\n\n`,
    `on-w FAILED OPEN: sin sello\n\n`,
    `[${hace(1)}] algo raro FAILED CLOSED: sin nombre\n\n`,
  ]);
  const out = correr(home);
  assert.doesNotMatch(out, /coordination-write|on-z|on-w/, `contó una continuación o un sello ilegible:\n${out}`);
  assert.match(out, /· control sin nombre: 1 frenando/);
  assert.equal(out.split('\n').filter((l) => l.includes('· ')).length, 1, out);
});

test('T17 Notice_NoLines_Silent @story-8.257 @ac-11 @ac-13', () => {
  // 🔴 rojo si: dice algo sin registro, con el registro vacío o sin fallas en las últimas 24 horas.
  assert.equal(correr(tmp()), '', 'sin archivo habló');
  assert.equal(correr(sembrar([])), '', 'con el archivo vacío habló');
  assert.equal(correr(sembrar([`[${hace(30)}] dispatch handler "x" FAILED OPEN: viejo\n\n`])), '', 'con sólo fallas viejas habló');
});

test('T18 Notice_UnreadableLog_SaysSo @story-8.257 @ac-13', () => {
  // 🔴 rojo si: un registro que no se puede leer se calla como «sin fallas», o el aviso rompe.
  const home = tmp();
  fs.mkdirSync(path.join(stateDir(home), 'hook-errors.log'), { recursive: true });
  assert.match(correr(home), /no pude leer el registro de fallas de los controles \(/);
});

test('T18b Notice_AsHook_UnreadableLog_ExitsZero @story-8.257 @ac-13', () => {
  // 🔴 rojo si: el gancho, lanzado como lo lanza la herramienta, sale distinto de 0 o calla con el registro ilegible.
  const home = tmp();
  fs.mkdirSync(path.join(stateDir(home), 'hook-errors.log'), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'hooks', 'hook-failures-notice.js')],
    { input: '{"source":"startup"}', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no pude leer el registro de fallas de los controles \(/);
});
