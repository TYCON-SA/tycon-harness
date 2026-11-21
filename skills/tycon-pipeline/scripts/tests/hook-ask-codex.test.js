'use strict';
/**
 * hook-ask-codex.test.js — en Codex, la pregunta de un gancho sale como negativa: Codex no tiene ventana de permiso,
 * cuenta un `ask` como gancho fallido y el comando corre (medición 562, 21/11). El freno de guardar, con el pedido
 * preparado, niega con la pregunta y cómo aprobarlo a mano; en Claude Code, pregunta.
 *
 * Vive aparte de save-brake.test.js porque esa suite es de las bajadas (scripts/tests/slow-suites-goal.json): no se le
 * suman casos. Laboratorio por prueba: una HOME vacía, un repo con su `origin` (un repo desnudo local) y la rama de la
 * story empujada con seguimiento, y el marcador de la corrida en el estado de esa HOME. El gancho (`on-pre-commit.js`)
 * corre como lo corre cada herramienta, con el evento por la entrada.
 *
 * stable-data: las horas de la corrida son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
// Sin arnés instalado packs.default no se puede leer: la suite fija el valor del perfil del equipo, como save-brake.test.js
// (antes de SIN_SESION, que copia el entorno al cargar).
process.env.TYCON_PACKS_DEFAULT = 'all';
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const SO_LIB = path.join(SCRIPTS, 'lib', 'save-ok.js');

const ANTES = '2026-10-29T10:00:00.000Z';
const RAMA = 'story/la-prueba';
const SID = 'ses-freno';
// la salida que abre la ventana de permiso
const VENTANA = /"permissionDecision":"ask"/;
const ABRO = /¿ABRO EL PULL REQUEST\?/;
const HASTA_EL_11 = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'];

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@example.com' };
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = (t, pre) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), pre)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function escribir(d, r, c) {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
}

/** Un repo con `origin` (desnudo, local), `main` empujada y la rama de la story empujada con seguimiento. */
function repoConOrigin(t) {
  const base = tmp(t, 'codex-ask-repo-');
  const origen = path.join(base, 'origen.git');
  const d = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'main');
  escribir(d, 'LEEME.md', 'hola\n');
  escribir(d, 'specs/story-9.99.md', '---\nstory_id: "9.99"\nstatus: in-progress\n---\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'remote', 'add', 'origin', origen);
  sh(d, 'push', '-q', 'origin', 'main');
  sh(d, 'checkout', '-q', '-b', RAMA);
  sh(d, 'push', '-q', '-u', 'origin', RAMA);
  return d;
}

/** La HOME vacía de la prueba, con la carpeta del estado. */
function home(t) {
  const h = tmp(t, 'codex-ask-home-');
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline', 'active'), { recursive: true });
  return h;
}

/** Abre la corrida con «Preparar el pull request» cerrado y la foto de ahora de su repo. */
function abrirPreparada(h, repo) {
  const so = require(SO_LIB);
  const m = {
    storyId: '9.99', startedAt: ANTES, sessionId: SID, repoPath: repo, storyPath: path.join(repo, 'specs', 'story-9.99.md'),
    stepScheme: 2, stepsCompleted: HASTA_EL_11, stepsPending: [], lastTouch: new Date().toISOString(),
    checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' }, iterations: { 1: { ts: ANTES } },
    stepTimings: { reviewers: { startedAt: ANTES, completedAt: ANTES } }, adversarialSkip: { motivo: 'LOW', at: ANTES },
  };
  m.prepareCommitHuellas = so.huellas(so.reposDeLaCorrida({ marker: m }));
  fs.writeFileSync(path.join(h, '.claude', '.tycon-pipeline', 'active', `${SID}.json`), JSON.stringify(m, null, 2));
}

const SIN_SESION = Object.fromEntries(Object.keys(process.env).filter((k) => !/^(CLAUDE_CODE_SESSION_ID|TYCON_SESSION_ID|CODEX_SESSION_ID)$/.test(k)).map((k) => [k, process.env[k]]));
/** El gancho con el evento de la herramienta: `{ status, stderr, stdout }`; `evento` suma campos al de Claude Code. */
function gancho(h, command, { cwd, env = {}, evento = {} } = {}) {
  const ev = { session_id: SID, tool_name: 'Bash', tool_input: { command }, cwd, ...evento };
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(ev), cwd, encoding: 'utf8', env: { ...SIN_SESION, ...GIT_ENV, HOME: h, USERPROFILE: h, ...env }, timeout: 60000,
  });
  return { status: r.status, stderr: String(r.stderr || ''), stdout: String(r.stdout || '') };
}

// 🔴 Falla con: en Codex, el pedido preparado que contesta `ask`: Codex no tiene ventana, cuenta el gancho como fallido y
// el comando corre (medición 562, 21/11). En Codex niega con la pregunta y cómo aprobarlo a mano; en Claude Code, pregunta.
test('Pedido_EnCodex_NiegaConLaPreguntaYComoAprobarlo', (t) => {
  const h = home(t);
  const a = repoConOrigin(t);
  abrirPreparada(h, a);
  const claude = gancho(h, 'gh pr create --fill', { cwd: a });
  assert.match(claude.stdout, VENTANA, claude.stdout + claude.stderr);
  for (const [como, opciones] of [['turn_id', { evento: { turn_id: 't1' } }], ['variable', { env: { CODEX_SESSION_ID: SID } }]]) {
    const r = gancho(h, 'gh pr create --fill', { cwd: a, ...opciones });
    assert.doesNotMatch(r.stdout, VENTANA, `${como}: ${r.stdout}`);
    const salida = JSON.parse(r.stdout).hookSpecificOutput;
    assert.strictEqual(salida.permissionDecision, 'deny', como);
    assert.match(salida.permissionDecisionReason, ABRO, como);
    assert.match(salida.permissionDecisionReason, /Codex no muestra la ventana de permiso/, como);
    assert.ok(salida.permissionDecisionReason.includes('gh pr create --fill'), `${como}: el comando para aprobarlo a mano`);
  }
});
