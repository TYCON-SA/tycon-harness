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

/** Un árbol de juguete con el lector de la configuración y, si se pasa, un team-repos.json. */
function arbol(dir, models) {
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'adapters'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'scripts', 'lib', 'team-repos.js'), path.join(dir, 'scripts', 'lib', 'team-repos.js'));
  fs.writeFileSync(path.join(dir, 'adapters', 'rev.toml'), 'model = "gpt-5.6-luna"\nsandbox_mode = "read-only"\n');
  if (models) {
    fs.writeFileSync(path.join(dir, 'team-repos.json'), JSON.stringify({
      version: 1, public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' },
      operations: { platform: 'github', org: 'acme', repo: 'o' }, models,
    }));
  }
}

test('A6 RunnerProfile_DeployedLikeTheDeployer — el examen prepara el perfil como el desplegador: «inherit» lo deja sin modelo; sin configuración, igual que hoy', () => enHome((home) => {
  const R = require(RUNNER);
  for (const [caso, models, esperado] of [['sin configuración', null, 'model = "gpt-5.6-luna"\nsandbox_mode = "read-only"\n'], ['inherit', { codex_reviewers: 'inherit' }, 'sandbox_mode = "read-only"\n']]) {
    const root = path.join(home, caso.replace(/ /g, '-'));
    const codex = path.join(home, `codex-${caso.replace(/ /g, '-')}`);
    fs.mkdirSync(codex, { recursive: true });
    arbol(root, models);
    R.ensureCodexProfile('rev', { root, adaptersDir: path.join(root, 'adapters'), codexHome: codex });
    assert.strictEqual(fs.readFileSync(path.join(codex, 'rev.config.toml'), 'utf8'), esperado, caso);
  }
}));

/** Lo que el examinador escribe por stderr mientras corre fn. */
function avisos(fn) {
  const dichos = [];
  const orig = console.error;
  console.error = (...a) => dichos.push(a.join(' '));
  try { fn(); } finally { console.error = orig; }
  return dichos.join('\n');
}

test('A7 RunnerProfile_GeneratorFails_StopsOrSaysWhy — si el desplegador falla, el examen frena; si no puede leer la configuración, el perfil de hoy y el aviso', () => enHome((home) => {
  const R = require(RUNNER);
  const crudo = 'model = "gpt-5.6-luna"\nsandbox_mode = "read-only"\n';
  const codex = path.join(home, 'codex');
  fs.mkdirSync(codex, { recursive: true });
  // sin el desplegador: frena con el motivo y no escribe el perfil
  const root = path.join(home, 'arbol');
  arbol(root, { codex_reviewers: 'inherit' });
  assert.throws(() => R.ensureCodexProfile('rev', { root, adaptersDir: path.join(root, 'adapters'), codexHome: codex, generator: path.join(home, 'no-existe.js') }), /no pude aplicar el modelo de la organización a rev/);
  assert.ok(!fs.existsSync(path.join(codex, 'rev.config.toml')), 'no dejó un perfil a medias');
  // con un team-repos.json y sin su lector: el perfil de hoy y el aviso del desplegador
  const sinLector = path.join(home, 'sin-lector');
  arbol(sinLector, { codex_reviewers: 'inherit' });
  fs.rmSync(path.join(sinLector, 'scripts', 'lib', 'team-repos.js'));
  const dicho2 = avisos(() => R.ensureCodexProfile('rev', { root: sinLector, adaptersDir: path.join(sinLector, 'adapters'), codexHome: codex }));
  assert.strictEqual(fs.readFileSync(path.join(codex, 'rev.config.toml'), 'utf8'), crudo);
  assert.match(dicho2, /no pude leer la configuración de la organización/);
}));

// Sin `engram` alcanzable, el examen no se cae al querer levantar la memoria: los casos que la piden salen «no
// medidos» con su motivo y el reporte se escribe. El caso de memoria se saltea antes de llamar a un modelo.
test('T6 NoEngram_ReportWithUnmeasuredCases — sin engram en el PATH, reporte con los casos de memoria no medidos', () => enHome((home) => {
  const out = path.join(home, 'reporte.json');
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USERPROFILE: home };
  const r = spawnSync(process.execPath, [RUNNER, '--tool', 'claude', '--runs', '1', '--only', 'tycon-retrospective-capturer::retro-captura-decision', '--json', out],
    { env, encoding: 'utf8', timeout: 120000 });
  const dicho = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(dicho, /spawn engram ENOENT|Unhandled 'error' event/, `el examen se cayó al lanzar engram:\n${dicho.slice(-800)}`);
  assert.ok(fs.existsSync(out), `sin reporte (exit ${r.status}):\n${dicho.slice(-800)}`);
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  const caso = rep.results['tycon-retrospective-capturer::retro-captura-decision'];
  assert.ok(caso && caso.tools && caso.tools.claude, `el caso de memoria no está en el reporte: ${JSON.stringify(rep.results).slice(0, 300)}`);
  assert.strictEqual(caso.tools.claude.skipped, true, 'no medido, nunca verde ni rojo');
  assert.strictEqual(caso.tools.claude.motivo, 'engram no está en el PATH');
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
