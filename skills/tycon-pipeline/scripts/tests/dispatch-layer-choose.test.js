#!/usr/bin/env node
'use strict';
/**
 * dispatch-layer-choose.test.js — el despachador, cuando la capa de plataforma carga pero su `choose` tira.
 *
 * El aviso del pedido de trabajo de una historia nueva corre si la capa de plataforma elige dónde crearlo
 * (`platform.choose('work-item.create')`). Si `choose` tira, el despachador no sabe: no da el aviso y lo dice por stderr
 * con el motivo. Con `choose` que elige, sí; con uno que no, no, y calla. Arma un arnés de juguete con TYCON_GUIDES_DIR y
 * corre el despachador aparte.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/dispatch-layer-choose.test.js < /dev/null
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DISPATCH = path.join(__dirname, '..', 'dispatch.js');

function elige(cuerpoDeChoose) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'despachador-capa-')));
  const arnes = path.join(raiz, 'arnes');
  fs.mkdirSync(path.join(arnes, 'scripts', 'lib', 'platform'), { recursive: true });
  // lo que hace que la carpeta cuente como el arnés (lib/harness-path.js)
  fs.writeFileSync(path.join(arnes, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(arnes, 'scripts', 'lib', 'platform', 'platform.js'), `module.exports = { choose() { ${cuerpoDeChoose} } };\n`);
  const home = path.join(raiz, 'home');
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(DISPATCH)}).layerChoosesWorkItems()))`],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_GUIDES_DIR: arnes } });
  assert.strictEqual(r.status, 0, r.stderr);
  return { elige: r.stdout, avisos: r.stderr };
}

test('T1 Despachador_ChooseTira_NoAvisaYLoDice', () => {
  const r = elige("throw new Error('el perfil no se pudo leer');");
  assert.strictEqual(r.elige, 'false');
  assert.match(r.avisos, /no supo si la capa elige dónde crearlo \(el perfil no se pudo leer\)/, r.avisos);
});

test('T2 Despachador_ChooseContesta_SiONo_SinAviso', () => {
  const si = elige("return { ok: true, connector: 'azure-devops' };");
  assert.strictEqual(si.elige, 'true');
  assert.doesNotMatch(si.avisos, /no supo si la capa/, si.avisos);
  const no = elige("return { ok: false, reason: 'sin conector' };");
  assert.strictEqual(no.elige, 'false');
  assert.doesNotMatch(no.avisos, /no supo si la capa/, no.avisos);
});
