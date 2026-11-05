'use strict';
// pruned-run-restore.test.js — una ejecución que espera un turno con la espera anotada (`marker.js doing --waiting-for`)
// no se poda por vieja, en ninguna de las tres podas (marker.js, on-prompt.js y story-gate-io.js); la que se poda deja una
// copia y `marker.js restore <sesión>` la rearma con sus pasos; la guía dice cómo.
//
// Corre los guiones reales en una HOME y un repo de juguete. Correr: node --test scripts/tests/pruned-run-restore.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
const IO = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const { conVentana } = require(path.join(ROOT, 'scripts', 'tests', 'lib', 'window-passed.js'));

const hace = (h) => new Date(Date.now() - h * 3600000).toISOString();

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pruned-run-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(ROOT, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  // stable-data: los commits de juguete llevan fecha fija y el mantenimiento de git apagado
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const historia = (n) => {
    const f = path.join(repo, 'specs', `story-${n}-espera.md`);
    fs.writeFileSync(f, ['---', `story: "${n}"`, 'title: "espera"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
      `# Story ${n}`, '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
    return f;
  };
  const story = historia('9.9');
  const stories = { 's-espera': story, 's-sin-nota': historia('9.8'), 's-nota-vieja': historia('9.7'), 's-podada': historia('9.6') };
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none',
      TYCON_MUTATION_CHECK: 'off', TYCON_GUIDES_DIR: ROOT });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return Object.assign(e, extra);
  };
  const correr = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo,
  });
  const estado = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  const activo = (sid) => path.join(estado, 'active', `${sid}.json`);
  const leer = (sid) => JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
  /** Una ejecución abierta de verdad, con el plan aprobado, y su último toque `horas` atrás. */
  const arrancar = (sid, horas) => {
    const r = correr('pipeline.js', ['start', '--story', stories[sid] || story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    const m = leer(sid);
    m.stepsCompleted = [...new Set([...(m.stepsCompleted || []), 'validate-story', 'plan', 'approve-plan'])];
    m.stepsPending = (m.stepsPending || []).filter((x) => !['validate-story', 'plan', 'approve-plan'].includes(x));
    m.lastTouch = hace(horas);
    fs.writeFileSync(activo(sid), JSON.stringify(m));
  };
  /** Un marcador de otra sesión escrito a mano, sin apertura: para la poda de on-prompt y del portón. */
  const marcador = (sid, horas) => {
    fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
    fs.writeFileSync(activo(sid), JSON.stringify({ storyId: '9.9', storyPath: story, repoPath: repo, sessionId: sid, lastTouch: hace(horas),
      startedAt: hace(horas + 1), stepsCompleted: ['start'], stepsPending: ['implement'] }));
  };
  const espera = (sid, horas) => {
    fs.mkdirSync(path.join(estado, 'doing'), { recursive: true });
    fs.writeFileSync(path.join(estado, 'doing', `${sid}.json`), JSON.stringify({ text: 'espera el turno de suite', at: hace(horas), waitingFor: 'el turno de suite de la coordinadora', waitingSince: hace(horas) }));
  };
  return { home, repo, story, estado, correr, activo, leer, arrancar, marcador, espera };
}

test('T37 Poda_EsperaDeTurno_NoSePodaEnMarker @story-8.202 @ac-33', () => {
  const E = entorno();
  E.arrancar('s-espera', 30);
  E.espera('s-espera', 1);
  E.arrancar('s-sin-nota', 30);
  E.arrancar('s-nota-vieja', 30);
  E.espera('s-nota-vieja', 30);
  const r = E.correr('marker.js', ['list-all'], 's-otra');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(E.activo('s-espera')), 'la que espera turno sigue');
  assert.ok(!fs.existsSync(E.activo('s-sin-nota')), 'sin nota, se poda');
  assert.ok(!fs.existsSync(E.activo('s-nota-vieja')), 'con la nota de más de 24 h, se poda');
});

test('T38 Poda_EsperaDeTurno_NoSePodaEnOnPrompt @story-8.202 @ac-34', () => {
  const E = entorno();
  E.marcador('s-espera', 8);
  E.espera('s-espera', 1);
  E.marcador('s-sin-nota', 8);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-prompt.js')], {
    input: JSON.stringify({ session_id: 's-otra', hook_event_name: 'UserPromptSubmit', prompt: 'implementemos la story 9.9', cwd: E.repo }),
    env: { ...process.env, HOME: E.home, USERPROFILE: E.home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: 's-otra' }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(E.activo('s-espera')), 'la que espera turno sigue');
  assert.match(r.stdout + r.stderr, /s-espera/, 'y la lista la cuenta como ocupada');
  assert.ok(!fs.existsSync(E.activo('s-sin-nota')), 'sin nota, se poda como hoy');
});

test('T39 StoryGate_EsperaDeTurno_SigueOcupada @story-8.202 @ac-34', () => {
  const E = entorno();
  E.marcador('s-espera', 8);
  E.espera('s-espera', 1);
  E.marcador('s-sin-nota', 8);
  const otras = IO.listOtherMarkers(E.estado, 's-yo', path.join(E.repo, 'src', 'a.js')).map((m) => m.sessionId);
  assert.deepStrictEqual(otras, ['s-espera']);
  assert.ok(IO.waitingTurn(E.estado, 's-espera'));
  assert.strictEqual(IO.waitingTurn(E.estado, 's-sin-nota'), null);
});

test('T40 Poda_GuardaCopia_YRestoreLaRearma @story-8.202 @ac-35', () => {
  const E = entorno();
  E.arrancar('s-podada', 30);
  const r = E.correr('marker.js', ['list-all'], 's-otra');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(E.activo('s-podada')), 'se podó');
  const copia = path.join(E.estado, 'pruned', 's-podada.json');
  assert.ok(fs.existsSync(copia), 'dejó la copia');
  assert.ok(JSON.parse(fs.readFileSync(copia, 'utf8')).stepsCompleted.includes('approve-plan'));
  const rr = E.correr('marker.js', ['restore', 's-podada'], 's-nueva', conVentana({}));
  assert.strictEqual(rr.status, 0, rr.stderr + rr.stdout);
  const m = E.leer('s-nueva');
  assert.strictEqual(String(m.storyId), '9.6');
  assert.ok(m.stepsCompleted.includes('approve-plan'), 'con sus pasos hechos');
  assert.ok(m.stepsPending.includes('implement') && !m.stepsPending.includes('plan'), 'y sus pendientes');
  assert.ok(!fs.existsSync(copia), 'la copia se borra');
  // sin copia ni apertura: el mensaje de siempre
  const rn = E.correr('marker.js', ['restore', 's-nadie'], 's-nueva2', conVentana({}));
  assert.notStrictEqual(rn.status, 0);
  assert.match(rn.stderr, /no tiene una ejecución abierta/);
});

test('T41 Guia_DiceComoSeRecuperaUnaPodada @story-8.202 @ac-36', () => {
  const es = fs.readFileSync(path.join(ROOT, 'guides', 'coordination.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'coordination.en.md'), 'utf8');
  for (const g of [es, en]) assert.match(g, /marker\.js restore <sesi(ó|o)n>|marker\.js restore <session>/);
  assert.match(es, /poda[^\n]*24 h/);
  assert.match(en, /pruned[^\n]*\n?[^\n]*24 h|24 h[^\n]*prun/);
});
