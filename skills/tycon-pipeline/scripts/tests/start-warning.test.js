#!/usr/bin/env node
'use strict';
// start-warning.test.js — la parte del Arranque que está prendida pero no anda (la herramienta de horas no contesta,
// `az` no está) se declara con `marker.js start-warning <parte> "<motivo>"`: queda su motivo en el marcador y una línea
// en gates.log, y `next` sigue. Lo que no se admite sale 2; repetir lo mismo no escribe otra línea.
//
// Corre los comandos reales con un HOME temporal (el skill enlazado, como en una máquina) y el id de sesión fijado en
// el proceso hijo.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/start-warning.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'start-warning-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-partes.md');
  fs.writeFileSync(story, [
    '---', 'story: "9.9"', 'title: "partes"', 'status: ready-for-dev', 'ado_work_item: 123',
    'files_to_modify:', '  - src/a.js', '---', '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  const env = (sid, extra) => ({
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid, TYCON_LANE_LLM: '0', TYCON_HOME: '',
    TYCON_TIME_TRACKING: 'clockify', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', ...(extra || {}),
  });
  const correr = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo,
  });
  const estado = () => [path.join(home, '.tycon', 'state'), path.join(home, '.claude', '.tycon-pipeline')].find((d) => fs.existsSync(path.join(d, 'active')));
  const leer = (sid) => JSON.parse(fs.readFileSync(path.join(estado(), 'active', `${sid}.json`), 'utf8'));
  const escribir = (sid, m) => fs.writeFileSync(path.join(estado(), 'active', `${sid}.json`), JSON.stringify(m));
  const lineas = () => {
    const f = path.join(estado(), 'gates.log');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.name === 'start-warning');
  };
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  };
  // una integración de horas de juguete que contesta bien, para el reintento de T14
  const integracion = () => {
    const dir = path.join(base, 'integraciones', 'juguete');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'integration.json'), JSON.stringify({ name: 'juguete', label: 'Juguete', kind: 'timeTracking',
      offer: { does: 'registra horas de juguete', needs: 'nada' }, onWork: 'scripts/on-work.js', hooks: [], settings: [] }));
    fs.writeFileSync(path.join(dir, 'scripts', 'on-work.js'), "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.stringify({ok:true}));});\n");
    return { TYCON_TIME_TRACKING: 'juguete', TYCON_INTEGRATIONS_DIR: path.join(base, 'integraciones') };
  };
  return { correr, leer, escribir, lineas, arrancar, estado, integracion };
}

test('T13 StartWarning_HorasYAdo_ConMotivo @story-8.93 @ac-7 — cada parte caída queda con su motivo, su línea y next sigue', () => {
  const E = entorno();
  const sid = 's-t13';
  E.arrancar(sid);
  for (const [parte, motivo] of [['time-tracking', 'MCP sin respuesta'], ['ado', 'az no instalado']]) {
    const r = E.correr('marker.js', ['start-warning', parte, motivo], sid);
    assert.strictEqual(r.status, 0, r.stderr);
  }
  const m = E.leer(sid);
  assert.deepStrictEqual(m.startWarnings.map((w) => [w.part, w.message]), [['time-tracking', 'MCP sin respuesta'], ['ado', 'az no instalado']]);
  const ls = E.lineas();
  assert.deepStrictEqual(ls.map((l) => [l.part, l.motivo]), [['time-tracking', 'MCP sin respuesta'], ['ado', 'az no instalado']]);
  assert.ok(ls.every((l) => typeof l.at === 'string' && l.at.length > 0), 'cada línea con su hora');
  const n = E.correr('pipeline.js', ['next'], sid);
  assert.strictEqual(n.status, 0, n.stderr);
  const j = JSON.parse(n.stdout);
  assert.ok(!(j.start_parts || []).length, 'las partes avisadas ya no se piden');
  assert.strictEqual(j.next_step, 'validate-story');
  // el volcado de la ejecución lo trae
  assert.strictEqual(E.correr('marker.js', ['clear'], sid).status, 0);
  const hist = path.join(E.estado(), 'timing-history');
  const v = fs.readdirSync(hist).filter((f) => /^9\.9-[\dT-]+\.json$/.test(f));
  assert.strictEqual(v.length, 1, v.join(', '));
  const volcado = JSON.parse(fs.readFileSync(path.join(hist, v[0]), 'utf8'));
  assert.deepStrictEqual(volcado.marker.startWarnings.map((w) => [w.part, w.message]), [['time-tracking', 'MCP sin respuesta'], ['ado', 'az no instalado']]);
});

test('T14 StartWarning_OtraParteMotivoVacioYYaCorrida @story-8.93 @ac-7 — lo que no se admite sale 2; repetir no escribe', () => {
  const E = entorno();
  const sid = 's-t14';
  E.arrancar(sid);
  const otra = E.correr('marker.js', ['start-warning', 'implement', 'x'], sid);
  assert.strictEqual(otra.status, 2, 'una parte fuera de la lista');
  assert.match(otra.stderr, /time-tracking \| ado/);
  for (const vacio of [[], [''], ['   ']]) {
    const r = E.correr('marker.js', ['start-warning', 'time-tracking', ...vacio], sid);
    assert.strictEqual(r.status, 2, `motivo vacío ${JSON.stringify(vacio)}`);
    assert.match(r.stderr, /motivo/);
  }
  assert.strictEqual(E.lineas().length, 0, 'nada de lo rechazado escribió');

  // la parte ya hecha: «ya corrió»
  E.escribir(sid, { ...E.leer(sid), workSignalStarted: true });
  const hecha = E.correr('marker.js', ['start-warning', 'time-tracking', 'MCP caído'], sid);
  assert.strictEqual(hecha.status, 2);
  assert.match(hecha.stderr, /ya corrió/);

  // el mismo motivo dos veces: una sola línea
  assert.strictEqual(E.correr('marker.js', ['start-warning', 'ado', 'az no instalado'], sid).status, 0);
  const dos = E.correr('marker.js', ['start-warning', 'ado', 'az no instalado'], sid);
  assert.strictEqual(dos.status, 0, dos.stderr);
  assert.strictEqual(E.lineas().length, 1, 'repetir no escribe otra línea');

  // otro motivo: reemplaza y escribe su línea
  assert.strictEqual(E.correr('marker.js', ['start-warning', 'ado', 'az sin sesión (401)'], sid).status, 0);
  assert.deepStrictEqual(E.leer(sid).startWarnings.map((w) => [w.part, w.message]), [['ado', 'az sin sesión (401)']]);
  assert.strictEqual(E.lineas().length, 2);

  // el aviso sale cuando el arnés pone la bandera de la parte: un reintento de `work-signal start` que salió bien
  E.escribir(sid, { ...E.leer(sid), workSignalStarted: false });
  assert.strictEqual(E.correr('marker.js', ['start-warning', 'time-tracking', 'MCP caído'], sid).status, 0);
  assert.ok(E.leer(sid).startWarnings.some((w) => w.part === 'time-tracking'));
  const re = E.correr('pipeline.js', ['work-signal', 'start'], sid, E.integracion());
  assert.strictEqual(re.status, 0, re.stderr);
  const m = E.leer(sid);
  assert.strictEqual(m.workSignalStarted, true);
  assert.ok(!m.startWarnings.some((w) => w.part === 'time-tracking'), 'la parte quedó hecha: su aviso sale');
  assert.ok(m.startWarnings.some((w) => w.part === 'ado'), 'el de la otra parte queda');
});
