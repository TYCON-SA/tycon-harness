#!/usr/bin/env node
'use strict';
// `marker.js update-story-status <historia> done` fuera de una corrida mira la matriz de evidencia en vivo: con la
// matriz verde en esta carpeta, o con la constancia de la matriz verde que dejó la corrida de esa historia en esta
// máquina (posterior a su última vuelta a in-progress), pasa; sin ninguna de las dos, frena y dice qué hacer.
// 🔴 Falla con: pasar a done sin mirar la matriz, aceptar la constancia de otra historia o una anterior a la última vuelta a
//    in-progress, o frenar sin decir cómo se sale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const MARKER_JS = path.join(SCRIPTS, 'marker.js');
const TYCON_HOME = path.join(SCRIPTS, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
const stateDirOf = fs.existsSync(TYCON_HOME) ? require(TYCON_HOME).stateDir : (h) => path.join(h, '.claude', '.tycon-pipeline');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const HISTORIA = (estado) => `---
epic: 9
story: "9.1"
title: "x"
status: ${estado}
---

# Story 9.1: x

Status: ${estado}

## Acceptance Criteria

1. **Given** una cosa **When** pasa otra **Then** se ve.
`;

function corral(estado = 'review') {
  const home = tmp('done-matriz-home-');
  const repo = tmp('done-matriz-repo-');
  fs.mkdirSync(path.join(repo, 'specs'));
  const story = path.join(repo, 'specs', 'story-9.1-x.md');
  fs.writeFileSync(story, HISTORIA(estado));
  spawnSync('git', ['init', '-q', repo]);
  return { home, repo, story, state: stateDirOf(home) };
}

function marker(c, ...args) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TYCON_|CLAUDE_CODE_SESSION_ID|CODEX_SESSION_ID|NODE_TEST_CONTEXT)/.test(k)) env[k] = v;
  return spawnSync(process.execPath, [MARKER_JS, ...args], { cwd: c.repo, encoding: 'utf8', env: { ...env, HOME: c.home, TYCON_SESSION_ID: 'done-matriz' } });
}

// el renglón que deja la corrida al pasar la matriz en verde, como lo escribe complete-step
function constancia(c, { ts, storyRel = 'specs/story-9.1-x.md' } = {}) {
  fs.mkdirSync(c.state, { recursive: true });
  const comun = path.join(c.repo, '.git');
  fs.appendFileSync(path.join(c.state, 'gates.log'), `${JSON.stringify({ ts, name: 'acmatrix-green', story: '9.1', storyPath: c.story, storyRel, repoCommon: comun })}\n`);
}
function vuelta(c, status, ts) {
  fs.mkdirSync(c.state, { recursive: true });
  fs.appendFileSync(path.join(c.state, 'gates.log'), `${JSON.stringify({ ts, name: 'story-status', status, story: '9.1', storyPath: c.story, storyRel: 'specs/story-9.1-x.md', repoCommon: path.join(c.repo, '.git') })}\n`);
}
const estadoDe = (c) => (fs.readFileSync(c.story, 'utf8').match(/^status: (\S+)/m) || [])[1];

test('T1 DoneSinMatrizNiConstancia_FrenaYDiceQueHacer', () => {
  const c = corral();
  const r = marker(c, 'update-story-status', c.story, 'done');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(estadoDe(c), 'review', 'la historia no cambia');
  assert.match(r.stderr, /matriz/);
  assert.match(r.stderr, /runtime-matrix\.js --story/, 'dice cómo correr la matriz');
  assert.match(r.stderr, /close/, 'dice cómo cerrar con la corrida');
});

test('T2 DoneConLaConstanciaDeLaCorrida_Pasa', () => {
  const c = corral();
  vuelta(c, 'in-progress', '2026-11-20T10:00:00.000Z');
  constancia(c, { ts: '2026-11-20T12:00:00.000Z' });
  const r = marker(c, 'update-story-status', c.story, 'done');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(estadoDe(c), 'done');
});

test('T3 ConstanciaVieja_DeOtraHistoriaODeAntesDeReabrir_NoVale', () => {
  const otra = corral();
  constancia(otra, { ts: '2026-11-20T12:00:00.000Z', storyRel: 'specs/story-9.2-otra.md' });
  assert.strictEqual(marker(otra, 'update-story-status', otra.story, 'done').status, 1, 'la de otra historia no vale');
  const vieja = corral();
  constancia(vieja, { ts: '2026-11-20T12:00:00.000Z' });
  vuelta(vieja, 'in-progress', '2026-11-21T09:00:00.000Z');
  assert.strictEqual(marker(vieja, 'update-story-status', vieja.story, 'done').status, 1, 'la de antes de reabrir no vale');
  assert.strictEqual(estadoDe(vieja), 'review');
});

test('T4 LosOtrosEstados_NoMiranLaMatriz_YQuedanAnotados', () => {
  const c = corral();
  for (const e of ['in-progress', 'review', 'blocked']) assert.strictEqual(marker(c, 'update-story-status', c.story, e).status, 0, e);
  const log = fs.readFileSync(path.join(c.state, 'gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.name === 'story-status' && l.status === 'in-progress' && l.storyRel === 'specs/story-9.1-x.md'), JSON.stringify(log));
});

// lo que encontró el pase: un `status:` de una tanda antes del de la historia, y la constancia de una sola tanda
test('T6 TandaEnDone_NoEsLaHistoriaEnDone_YUnaTandaNoValeParaTodas', () => {
  const conTandas = (c, estadoTandaA) => fs.writeFileSync(c.story, HISTORIA('review').replace('title: "x"\n',
    `title: "x"\npipelines:\n  - name: A\n    status: ${estadoTandaA}\n  - name: B\n    status: pending\n`));
  const c = corral();
  conTandas(c, 'done');
  assert.strictEqual(marker(c, 'update-story-status', c.story, 'done').status, 1, 'la tanda A en done no es la historia en done');
  const linea = (batch, ts) => fs.appendFileSync(path.join(c.state, 'gates.log'), `${JSON.stringify({ ts, name: 'acmatrix-green', batch, storyRel: 'specs/story-9.1-x.md', repoCommon: path.join(c.repo, '.git') })}\n`);
  fs.mkdirSync(c.state, { recursive: true });
  linea('A', '2026-11-20T12:00:00.000Z');
  assert.strictEqual(marker(c, 'update-story-status', c.story, 'done').status, 1, 'la constancia de una tanda no vale para la historia');
  linea('B', '2026-11-20T13:00:00.000Z');
  const r = marker(c, 'update-story-status', c.story, 'done');
  assert.strictEqual(r.status, 0, `con la constancia de cada tanda, pasa: ${r.stderr}`);
});

test('T5 YaEnDone_RepetirNoFrena', () => {
  const c = corral('done');
  assert.strictEqual(marker(c, 'update-story-status', c.story, 'done').status, 0);
});
