'use strict';
/**
 * advisor-runner-agents-dir.test.js — el examen de revisores encuentra los revisores donde el arnés los instala.
 *
 * En una máquina sólo con Codex no existe la carpeta de Claude Code (`~/.claude/agent-skills/agents`): el examen la
 * buscaba ahí y salía con ENOENT antes de correr un caso. Ahora, sin `TYCON_AGENTS_DIR`, toma la carpeta `agents` del
 * árbol del arnés (la misma que usa el pipeline); `TYCON_AGENTS_DIR` sigue mandando.
 *
 * No llama a ningún modelo: carga el examinador sin correrlo y lee la carpeta que eligió.
 * Correr: node scripts/tests/advisor-runner-agents-dir.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const RUNNER = path.join(RAIZ, 'scripts', 'controls-bench', 'advisor-runner.js');

/** La carpeta de revisores que elige el examinador con esa HOME y ese ambiente, y de dónde la sacó. */
function carpeta(home, extra = {}) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home }, extra);
  if (!('TYCON_SKILLS_DIR' in extra)) delete env.TYCON_SKILLS_DIR;
  if (!('TYCON_AGENTS_DIR' in extra)) delete env.TYCON_AGENTS_DIR;
  const r = spawnSync(process.execPath, ['-e', 'const m=require(process.argv[1]);process.stdout.write(JSON.stringify([m.AGENTS_DIR,m.AGENTS_ORIGEN]))', RUNNER], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const [dir, origen] = JSON.parse(r.stdout);
  return { dir, origen };
}
const enHome = (fn) => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-agents-')); try { fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); } };

test('A1 RunnerAgentsDir_NoClaudeFolder_UsesHarnessTree — sin la carpeta de Claude Code, la del árbol del arnés', () => enHome((home) => {
  const { dir, origen } = carpeta(home);
  assert.strictEqual(fs.realpathSync(dir), fs.realpathSync(path.join(RAIZ, 'agents')), `no eligió la carpeta del árbol: ${dir}`);
  assert.strictEqual(origen, 'el árbol del arnés');
}));

test('A2 RunnerAgentsDir_VariableWins — TYCON_AGENTS_DIR sigue mandando', () => enHome((home) => {
  assert.deepStrictEqual(carpeta(home, { TYCON_AGENTS_DIR: '/una/carpeta' }), { dir: '/una/carpeta', origen: 'TYCON_AGENTS_DIR' });
}));

test('A4 RunnerAgentsDir_TreeWithoutAgents_FallsBackToClaudeAndSaysWhy — un árbol sin agents/: la de Claude Code, con el motivo', () => enHome((home) => {
  const vacio = path.join(home, 'arbol-vacio');
  fs.mkdirSync(path.join(vacio, 'skills'), { recursive: true });
  const { dir, origen } = carpeta(home, { TYCON_SKILLS_DIR: vacio });
  assert.strictEqual(dir, path.join(home, '.claude', 'agent-skills', 'agents'));
  assert.match(origen, /Claude Code: el árbol no trae/);
}));

test('A5 Runner_AgentsDirMissing_StopsWithReason — sin la carpeta de revisores, el examen frena antes de llamar a un modelo', () => enHome((home) => {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_AGENTS_DIR: path.join(home, 'no-existe') });
  const r = spawnSync(process.execPath, [RUNNER, '--tool', 'codex', '--runs', '1', '--only', 'tycon-plugin-security-basics'], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /no encuentro la carpeta de los revisores .*no-existe.*TYCON_AGENTS_DIR/);
  assert.ok(!/advisor-bench:/.test(r.stdout), 'no llegó a armar las corridas');
}));

test('A3 Runner_RequiredAsModule_DoesNotRun — cargarlo como módulo no corre el examen', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-agents-'));
  try {
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', RUNNER], { env, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/advisor-bench:|reporte:/.test(r.stdout), `corrió el examen: ${r.stdout.slice(0, 200)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
