#!/usr/bin/env node
'use strict';
/**
 * dispatch-work-items-list.test.js — el despachador dice por qué no mira si el repo declara pedidos de trabajo.
 *
 * El aviso del pedido de trabajo de una historia nueva corre si el repo de la historia declara sus pedidos (los archivos
 * que lista `work-items-config.js` en `FILES`). Con la pieza que carga pero no exporta esa lista, el despachador
 * salteaba el aviso sin dejar rastro. Una pieza que no está sigue sin aviso:
 * un arnés sin ella no es una falla. Arma un arnés de juguete con TYCON_GUIDES_DIR y corre el despachador aparte.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/dispatch-work-items-list.test.js < /dev/null
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DISPATCH = path.join(__dirname, '..', 'dispatch.js');

/** Un arnés de juguete con `work-items-config.js` como `contenido` (o sin él con null), y un repo con `.tycon/x.yaml`. */
function arnesConPieza(contenido) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'despachador-lista-')));
  const arnes = path.join(raiz, 'arnes');
  fs.mkdirSync(path.join(arnes, 'scripts', 'lib', 'platform'), { recursive: true });
  // lo que hace que la carpeta cuente como el arnés (lib/harness-path.js)
  fs.writeFileSync(path.join(arnes, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  if (contenido !== null) fs.writeFileSync(path.join(arnes, 'scripts', 'lib', 'platform', 'work-items-config.js'), contenido);
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'work-items.yaml'), 'x: 1\n');
  return { arnes, story: path.join(repo, 'specs', 's.md'), home: path.join(raiz, 'home') };
}

function declara(lab) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(DISPATCH)}).repoDeclaresWorkItems(process.argv[1])))`, lab.story],
    { encoding: 'utf8', env: { ...process.env, HOME: lab.home, USERPROFILE: lab.home, TYCON_GUIDES_DIR: lab.arnes } });
  assert.strictEqual(r.status, 0, r.stderr);
  return { declara: r.stdout, avisos: r.stderr };
}

test('T1 Despachador_PiezaSinLista_LoDice', () => {
  const r = declara(arnesConPieza('module.exports = {};\n'));
  assert.strictEqual(r.declara, 'false');
  assert.match(r.avisos, /no exporta FILES/, r.avisos);
});

test('T2 Despachador_ConLista_Declara_YSinPieza_Calla', () => {
  const con = declara(arnesConPieza("module.exports = { FILES: ['work-items.yaml'] };\n"));
  assert.strictEqual(con.declara, 'true');
  assert.doesNotMatch(con.avisos, /work-items-config/, con.avisos);
  const sin = declara(arnesConPieza(null));
  assert.strictEqual(sin.declara, 'false');
  assert.doesNotMatch(sin.avisos, /work-items-config/, sin.avisos);
});
