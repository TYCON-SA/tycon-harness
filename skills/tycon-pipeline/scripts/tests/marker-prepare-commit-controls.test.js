'use strict';
/**
 * marker-prepare-commit-controls.test.js — la foto del paso 11 es de lo que el commit va a guardar.
 *
 * Al cerrar «Preparar el pedido», `marker.js` corre antes de la foto los controles del commit de cada repo de la corrida,
 * en sólo lectura (`fotoDelPedido` de `lib/save-ok.js`). Un pre-commit que regeneraría un archivo y lo sumaría al
 * commit vencería la foto después del commit, sin que nadie haya tocado nada: el paso no cierra y dice qué commitear.
 * Lo que no se puede mirar (un control colgado) tampoco cierra.
 *
 * Laboratorio por prueba: un repo de git descartable con su `origin/main` y un gancho pre-commit propio
 * (`core.hooksPath`).
 *
 * stable-data: ninguna prueba compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SO = require('../lib/save-ok.js');

const GIT_ENV = { GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' };
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
function repo(t) {
  const d = tmp(t, 'foto-pedido-');
  sh(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'LEEME.md'), 'hola\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh(d, 'checkout', '-q', '-b', 'story/la-prueba');
  fs.writeFileSync(path.join(d, 'app.js'), 'module.exports = 1;\n');
  return d;
}
/** El gancho pre-commit del repo, fuera de él: `cuerpo` es bash. */
function gancho(t, d, cuerpo) {
  const dir = tmp(t, 'foto-gancho-');
  fs.writeFileSync(path.join(dir, 'pre-commit'), `#!/usr/bin/env bash\n${cuerpo}\n`, { mode: 0o755 });
  sh(d, 'config', 'core.hooksPath', dir);
}

// 🔴 Falla con: un paso 11 que toma la foto aunque el pre-commit regeneraría un archivo (el pedido frenaría después del
// commit sin que nadie toque nada), un control colgado tomado por verde, o un mensaje que pide una firma en lugar de
// decir qué commitear.
test('8.242-PrepararElPedido_ControlesDelCommitAntesDeLaFoto (T29) @story-8.242 @ac-20', (t) => {
  // un pre-commit que regenera un archivo: en sólo lectura no escribe y frena porque hacía falta
  const a = repo(t);
  gancho(t, a, '[ "${TYCON_PRECOMMIT_READ_ONLY:-}" = 1 ] && { echo "mapa público viejo: hay que regenerarlo (generado.html)" >&2; exit 1; }\necho x > generado.html; git add generado.html');
  let r = SO.fotoDelPedido({ repos: [a] });
  assert.ok(!r.huellas, `sin foto: ${JSON.stringify(r)}`);
  assert.strictEqual(r.codigo, 2);
  assert.match(r.motivo, /generado\.html/, 'nombra el control y el archivo');
  assert.match(r.motivo, /commiteá lo regenerado y volvé a cerrar «Preparar el pull request»/, r.motivo);
  assert.doesNotMatch(r.motivo, /firma/, 'no pide una firma');
  assert.ok(!fs.existsSync(path.join(a, 'generado.html')), 'el chequeo no escribe en el repo');
  // un pre-commit que pasa: la foto se toma, igual a la huella de ahora
  const b = repo(t);
  gancho(t, b, 'exit 0');
  r = SO.fotoDelPedido({ repos: [b] });
  assert.ok(Array.isArray(r.huellas), JSON.stringify(r));
  assert.strictEqual(r.huellas[0].arbol, SO.huella(b).arbol);
  // un pre-commit que no termina en el plazo: no poder mirar no es verde
  const c = repo(t);
  gancho(t, c, 'sleep 5');
  r = SO.fotoDelPedido({ repos: [c], timeoutMs: 500 });
  assert.strictEqual(r.codigo, 2);
  assert.match(r.motivo, /no terminaron/);
  assert.match(r.motivo, /volvé a cerrar «Preparar el pull request»/);
});

/**
 * Una ejecución de laboratorio que llega al cierre de «Preparar el pull request» con los portones de antes en verde (las
 * pruebas, la prueba en vivo con su humo, los hallazgos y el pase): sólo queda la foto. `ganchoLectura` es lo que hace
 * el pre-commit del repo en sólo lectura; `extra` pisa campos del marcador antes del cierre.
 */
function cierrePorMarker(t, { ganchoLectura = 'exit 0', extra = {} } = {}) {
  const SCRIPTS = path.join(__dirname, '..');
  const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
  const base = tmp(t, 'foto-cierre-');
  const home = path.join(base, 'home');
  const d = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(d, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'src'));
  sh(base, 'init', '-q', '-b', 'feat/x', d);
  const story = path.join(d, 'specs', 'story-9.9-foto.md');
  fs.writeFileSync(story, ['---', 'story: "9.9"', 'title: "foto"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
    '# Story 9.9', '', '## Acceptance Criteria', '', '1. **Given** algo, **Then** resultado.', '', '### Tests', '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|', '| T1 | `a.caso1` | 1 | unit | x | y |', '',
    '## Tasks / Subtasks', '', '- [x] Task 1: hacerlo (AC: 1)', '', '## Change Log', '', '- escrita', ''].join('\n'));
  fs.writeFileSync(path.join(d, 'src', 'a.js'), '1\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'inicio');
  gancho(t, d, `[ "\${TYCON_PRECOMMIT_READ_ONLY:-}" = 1 ] && { ${ganchoLectura}; }\nexit 0`);
  const env = { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's-foto', TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none', TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '' };
  for (const k of ['NODE_TEST_CONTEXT', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID']) delete env[k];
  const correr = (args, input = '') => spawnSync(process.execPath, args, { encoding: 'utf8', env, input, cwd: d });
  let r = correr([path.join(SCRIPTS, 'pipeline.js'), 'start', '--story', story, '--repo', d, '--brief']);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  fs.writeFileSync(path.join(d, 'src', 'a.js'), '2\n');
  r = correr([path.join(SCRIPTS, 'pipeline.js'), 'write-findings', '--story', story, '--findings', '-'], '[]');
  assert.strictEqual(r.status, 0, r.stderr);
  r = spawnSync('bash', [path.join(SCRIPTS, 'smoke-run.sh'), path.join(d, '.advisors', 'dod-runtime'), story, '--acs', '1', '--pass-if', 'sale 0', '--', 'true'], { encoding: 'utf8', env, cwd: d });
  assert.strictEqual(r.status, 0, r.stderr);
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const activo = path.join(estado, 'active', 's-foto.json');
  const m = JSON.parse(fs.readFileSync(activo, 'utf8'));
  Object.assign(m, {
    dodRuntimeChecked: true, dodRuntimeEvidence: { verdict: 'PASS', evidencePath: 'humo' }, adversarialSkip: { motivo: 'LOW', at: '2026-01-01T00:00:00Z' },
    checks: { tests: 'green', acmatrix: 'green', advisors: 'green' }, checksProvenance: { tests: 'run-check', acmatrix: 'run-check', advisors: 'run-check' },
  }, extra);
  fs.writeFileSync(activo, JSON.stringify(m));
  r = correr([path.join(SCRIPTS, 'marker.js'), 'complete-step', 'prepare-commit', '--out-of-order']);
  const marcador = JSON.parse(fs.readFileSync(activo, 'utf8'));
  let gates = [];
  try { gates = fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { /* sin registro */ }
  return { r, salida: `${r.stdout}\n${r.stderr}`, marcador, gates: gates.filter((g) => g.name === 'prepare-commit-controls'), repo: d, base };
}

// 🔴 Falla con: un cierre por `marker.js` que toma la foto aunque el pre-commit frenaría, que deja la foto vieja de un
// cierre anterior, que no lo anota, o que cierra con salida 0 sin foto cuando no pudo ubicar los repos.
test('8.242-PrepararElPedido_CierrePorMarker_SinFotoSale2_ConVerdeLaToma (T29) @story-8.242 @ac-20', { skip: process.platform === 'win32' }, (t) => {
  // el pre-commit frenaría: sale 2, sin foto (tampoco la vieja), con su renglón en el registro
  let c = cierrePorMarker(t, { ganchoLectura: 'echo "regenerar generado.html" >&2; exit 1', extra: { prepareCommitHuellas: [{ repo: '/vieja', arbol: 'x' }] } });
  assert.strictEqual(c.r.status, 2, c.salida);
  assert.match(c.salida, /generado\.html/);
  assert.ok(!c.marcador.prepareCommitHuellas, 'la foto vieja no queda');
  assert.ok(!(c.marcador.stepsCompleted || []).includes('prepare-commit'), 'el paso no cierra');
  assert.strictEqual(c.gates.length, 1, 'un renglón del cierre frenado');
  assert.strictEqual(c.gates[0].status, 'blocked');
  // no pude ubicar los repos de la ejecución: tampoco cierra
  const fuera = tmp(t, 'foto-fuera-');
  c = cierrePorMarker(t, { extra: { repoPath: fuera, prepareCommitHuellas: [{ repo: '/vieja', arbol: 'x' }] } });
  assert.strictEqual(c.r.status, 2, c.salida);
  assert.match(c.salida, /no pude ubicar los repos/);
  assert.ok(!c.marcador.prepareCommitHuellas, 'sin repos, sin foto');
  assert.ok(!(c.marcador.stepsCompleted || []).includes('prepare-commit'), 'sin repos, el paso no cierra');
  // el pre-commit pasa: el paso cierra con la foto de lo de ahora
  c = cierrePorMarker(t);
  assert.strictEqual(c.r.status, 0, c.salida);
  assert.ok((c.marcador.stepsCompleted || []).includes('prepare-commit'), c.salida);
  assert.strictEqual(c.marcador.prepareCommitHuellas.length, 1);
  assert.strictEqual(c.marcador.prepareCommitHuellas[0].arbol, SO.huella(c.repo).arbol);
});

// 🔴 Falla con: un marcador del esquema de números que cierra el paso 8 sin tomar la foto (el pull request frena para
// siempre), o un cierre de otro paso que la toma.
test('8.242-PrepararElPedido_EsquemaViejo_ElPaso8TomaLaFoto @story-8.242 @ac-4', () => {
  const S = require('../lib/steps.js');
  const viejo = { stepsCompleted: ['0', '1', '2', '3', '4', '5', '6', '7'] };
  const nuevo = { stepScheme: S.SCHEME, stepsCompleted: ['start'] };
  assert.strictEqual(S.closesStep(viejo, S.resolveStepArg(viejo, '8').ids || S.resolveStepArg(viejo, '8'), 'prepare-commit'), true);
  assert.strictEqual(S.closesStep(nuevo, ['prepare-commit'], 'prepare-commit'), true);
  assert.strictEqual(S.closesStep(viejo, ['7'], 'prepare-commit'), false);
  assert.strictEqual(S.closesStep(nuevo, ['8'], 'prepare-commit'), false, 'en el esquema nuevo, «8» no es un paso');
  // marker.js toma la foto con la misma pregunta, no con el nombre suelto
  const marker = fs.readFileSync(path.join(__dirname, '..', 'marker.js'), 'utf8');
  assert.match(marker, /STEPS_LIB\.closesStep\(marker, ids, 'prepare-commit'\)/);
});
