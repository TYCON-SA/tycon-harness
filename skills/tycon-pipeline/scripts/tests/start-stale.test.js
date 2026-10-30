#!/usr/bin/env node
'use strict';
// start-stale.test.js — el Arranque con un arnés viejo. Si los pasos salen de una carpeta que no es la del arnés que
// corre (una copia vieja en ~/.claude/agent-skills), `next` frena con exit 2 y dice qué carpeta es, cuál debería ser y
// cómo se arregla. El aviso que el arranque de la sesión dejó en el estado del arnés (una versión nueva, una
// actualización que falló) sale una vez por ejecución, antes de las partes del Arranque.
//
// Corre `pipeline.js` real con un HOME temporal y el id de sesión fijado en el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/start-stale.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const F = () => require(path.join(SCRIPTS, 'lib', 'harness-freshness.js'));

function entorno({ skills = 'enlace' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'start-stale-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const as = path.join(home, '.claude', 'agent-skills');
  if (skills === 'enlace') fs.symlinkSync(RAIZ, as);
  if (skills === 'dos-enlaces') { fs.symlinkSync(RAIZ, path.join(base, 'intermedio')); fs.symlinkSync(path.join(base, 'intermedio'), as); }
  // una carpeta real con los pasos de antes, en lugar del enlace: la actualización no la reemplaza
  const copiaVieja = () => {
    fs.unlinkSync(as);
    const steps = path.join(as, 'skills', 'tycon-pipeline', 'steps');
    fs.mkdirSync(steps, { recursive: true });
    for (const f of fs.readdirSync(path.join(SCRIPTS, '..', 'steps'))) fs.copyFileSync(path.join(SCRIPTS, '..', 'steps', f), path.join(steps, f));
    fs.writeFileSync(path.join(steps, 'step-00b-clocki-start.md'), '# el paso viejo\n');
  };
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-viejo.md');
  fs.writeFileSync(story, ['---', 'story: "9.9"', 'title: "viejo"', 'status: ready-for-dev', '---', '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', ''].join('\n'));
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid) => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none' });
  const correr = (args, sid) => spawnSync(process.execPath, [path.join(SCRIPTS, 'pipeline.js'), ...args], { encoding: 'utf8', env: env(sid), input: '', cwd: repo });
  const estado = (s) => {
    const d = path.join(home, '.claude', '.tycon-pipeline');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'harness-state.json'), typeof s === 'string' ? s : JSON.stringify(s));
  };
  return { base, home, repo, story, correr, estado, copiaVieja };
}

test('T44 Arranque_PasosDeOtraCarpeta_Frena @story-8.93 @ac-23 — pasos de una copia vieja, o sin el paso que toca, frenan', () => {
  // la carpeta correcta, y la correcta por dos enlaces: sigue
  for (const skills of ['enlace', 'dos-enlaces']) {
    const E = entorno({ skills });
    assert.strictEqual(E.correr(['start', '--story', E.story, '--repo', E.repo, '--brief'], `s-t44-${skills}`).status, 0);
    const n = E.correr(['next'], `s-t44-${skills}`);
    assert.strictEqual(n.status, 0, `${skills}: ${n.stderr}`);
    assert.strictEqual(JSON.parse(n.stdout).next_step, 'validate-story');
  }
  // una copia vieja en ~/.claude/agent-skills: frena con exit 2 y dice las dos carpetas y el arreglo
  const E = entorno();
  assert.strictEqual(E.correr(['start', '--story', E.story, '--repo', E.repo, '--brief'], 's-t44-vieja').status, 0);
  E.copiaVieja();
  const n = E.correr(['next'], 's-t44-vieja');
  assert.strictEqual(n.status, 2, n.stderr + n.stdout);
  assert.match(n.stderr, /arnés viejo/);
  assert.match(n.stderr, new RegExp(path.join('.claude', 'agent-skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(n.stderr, new RegExp(fs.realpathSync(path.join(SCRIPTS, '..', 'steps')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(n.stderr, /harness\.js install/);
  // la carpeta correcta sin el paso que toca: frena igual
  const r = F().revisar({ stepsDir: path.join(SCRIPTS, '..', 'steps'), nextFile: path.join(SCRIPTS, '..', 'steps', 'step-00b-clocki-start.md'),
    scriptDir: SCRIPTS, leerEstado: () => ({ status: 'missing' }) });
  assert.match(r.error, /step-00b-clocki-start\.md/);
  // una instalación administrada cuyo árbol no es el de los pasos: frena, por next
  const otra = fs.mkdtempSync(path.join(os.tmpdir(), 'start-stale-arbol-'));
  const A = entorno();
  A.estado({ schema: 1, mode: 'managed', tree: otra, sources: [] });
  assert.strictEqual(A.correr(['start', '--story', A.story, '--repo', A.repo, '--brief'], 's-t44-arbol').status, 0);
  const na = A.correr(['next'], 's-t44-arbol');
  assert.strictEqual(na.status, 2, na.stderr + na.stdout);
  assert.match(na.stderr, /arnés viejo/);
  // un enlace roto en ~/.claude/agent-skills también es el arnés viejo, y frena
  const B = entorno();
  assert.strictEqual(B.correr(['start', '--story', B.story, '--repo', B.repo, '--brief'], 's-t44-roto').status, 0);
  fs.unlinkSync(path.join(B.home, '.claude', 'agent-skills'));
  fs.symlinkSync(path.join(B.base, 'no-existe'), path.join(B.home, '.claude', 'agent-skills'));
  assert.strictEqual(B.correr(['next'], 's-t44-roto').status, 2);
  const r2 = F().revisar({ stepsDir: path.join(SCRIPTS, '..', 'steps'), nextFile: null, scriptDir: SCRIPTS,
    leerEstado: () => ({ status: 'ok', state: { mode: 'managed', tree: otra } }) });
  assert.match(r2.error, /arnés viejo/);
});

test('T45 Arranque_VersionAtras_LoDiceAntesDeLasHoras @story-8.93 @ac-23 — el aviso del estado sale una vez, antes de las partes del Arranque', () => {
  const pasos = path.join(SCRIPTS, '..', 'steps');
  const revisar = (st) => F().revisar({ stepsDir: pasos, nextFile: null, scriptDir: SCRIPTS, leerEstado: () => st });
  // una versión nueva con la política «preguntar», una actualización que falló: el aviso, con el comando para verlo
  for (const notice of ['hay una versión nueva: 2026.10.22.60 (con harness.js update)', 'la actualización 2026.10.20.36 → 2026.10.22.41 no quedó sana']) {
    const r = revisar({ status: 'ok', state: { mode: 'developer', tree: RAIZ, notice } });
    assert.ok(r.aviso.includes(notice), r.aviso);
    assert.match(r.aviso, /harness\.js doctor/);
  }
  assert.deepStrictEqual(revisar({ status: 'ok', state: { mode: 'developer', tree: RAIZ, notice: null } }), {}, 'sin aviso, nada');
  assert.deepStrictEqual(revisar({ status: 'missing', state: null }), {}, 'sin estado (un clon, una casa de prueba), nada');
  assert.match(revisar({ status: 'broken', state: null, reason: 'JSON ilegible' }).sinEstado, /no sé si está al día/);

  // por next: el primer renglón del Arranque, antes de las partes; en el segundo next ya no
  const E = entorno();
  E.estado({ schema: 1, mode: 'developer', tree: RAIZ, sources: [], notice: 'hay una versión nueva: 2026.10.22.60' });
  assert.strictEqual(E.correr(['start', '--story', E.story, '--repo', E.repo, '--brief'], 's-t45').status, 0);
  const uno = JSON.parse(E.correr(['next'], 's-t45').stdout);
  assert.match(uno.harness_notice, /hay una versión nueva/);
  assert.ok(uno.note.startsWith('arnés: hay una versión nueva'), uno.note);
  const dos = JSON.parse(E.correr(['next'], 's-t45').stdout);
  assert.strictEqual(dos.harness_notice, undefined, 'una vez por ejecución');
  // un estado ilegible: «no sé si está al día», una vez
  const E2 = entorno();
  E2.estado('{roto');
  assert.strictEqual(E2.correr(['start', '--story', E2.story, '--repo', E2.repo, '--brief'], 's-t45b').status, 0);
  assert.match(JSON.parse(E2.correr(['next'], 's-t45b').stdout).harness_notice, /no sé si está al día/);
  assert.strictEqual(JSON.parse(E2.correr(['next'], 's-t45b').stdout).harness_notice, undefined);
});
