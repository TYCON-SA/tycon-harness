#!/usr/bin/env node
'use strict';
/**
 * provenance-without-run-dir.test.js — la procedencia de una prueba con un marcador que no guarda su carpeta de corrida.
 *
 * `procedencia` (lib/frozen-tree.js) dice de qué corrida es una prueba: la carpeta que guarda el marcador, o la que
 * calcula el pipeline para su historia. Sin carpeta, `run` va en null y `run_error` dice por qué, de dos formas: el
 * marcador no nombra una historia, o la historia todavía no tiene carpeta de corrida. Ninguna de las dos inventa una.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/provenance-without-run-dir.test.js < /dev/null
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const { procedencia } = require(path.join(LIB, 'frozen-tree.js'));
const { stateDir } = require(path.join(LIB, 'state-dir.js'));

/** Una casa de juguete con el marcador `m` de la sesión `sid`, y un repo vacío. */
function conMarcador(sid, m) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'procedencia-')));
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const activo = path.join(stateDir(home), 'active');
  fs.mkdirSync(activo, { recursive: true });
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(activo, `${sid}.json`), JSON.stringify({ repoPath: repo, ...m }));
  return { home, repo };
}

test('T1 Procedencia_MarcadorSinCarpetaNiHistoria_DiceQueNoNombraHistoria', () => {
  const { home, repo } = conMarcador('s-sin-historia', { sessionId: 's-sin-historia' });
  const p = procedencia(repo, { env: { CLAUDE_CODE_SESSION_ID: 's-sin-historia' }, home });
  assert.strictEqual(p.run, null);
  assert.strictEqual(p.run_error, 'el marcador no nombra una historia');
  assert.deepStrictEqual(p.by, { session: 's-sin-historia', model: null });
});

test('T2 Procedencia_HistoriaSinCarpetaTodavia_LoDice', () => {
  const { home, repo } = conMarcador('s-sin-carpeta', { sessionId: 's-sin-carpeta', storyId: '9.9' });
  const p = procedencia(repo, { env: { CLAUDE_CODE_SESSION_ID: 's-sin-carpeta' }, home });
  assert.strictEqual(p.run, null);
  assert.strictEqual(p.run_error, 'la historia del marcador todavía no tiene carpeta de corrida');
  // con la carpeta en el marcador, es ésa y no hay error
  const conCarpeta = conMarcador('s-con-carpeta', { sessionId: 's-con-carpeta', storyId: '9.9', runDir: '/r/.advisors/pipeline-runs/9.9-x' });
  const q = procedencia(conCarpeta.repo, { env: { CLAUDE_CODE_SESSION_ID: 's-con-carpeta' }, home: conCarpeta.home });
  assert.strictEqual(q.run, '/r/.advisors/pipeline-runs/9.9-x');
  assert.ok(!('run_error' in q), JSON.stringify(q));
});
