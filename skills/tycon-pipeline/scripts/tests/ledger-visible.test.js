#!/usr/bin/env node
/**
 * ledger-visible.test.js — el portón no deja editar código por Bash con el pipeline abierto,
 * porque esa edición el registro NO la ve.
 *
 * Si una corrida edita con `sed`/heredocs —lo que el modo bypass del arnés INSTRUYE hacer—,
 * al re-loopear `smart-reloop` no puede calcular el delta: set COMPLETO, 7 revisores en vez de
 * 2-3. El aviso es honesto, pero llega con el trabajo ya hecho.
 *
 * Por eso se frena la edición invisible en vez de enseñarle al arnés a leerla: se ataca el
 * origen, sin relajar la garantía de `ledger-honesty` ni meter fechas inferidas en el registro que
 * usa el gate ATDD para el orden test-antes-que-código.
 *
 * Correr: node --test .../scripts/tests/ledger-visible.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const lv = require('../lib/ledger-visible.js');

const REPO = '/repo';
const dentro = (f, r) => String(f).startsWith(String(r) + '/');
const abierto = { repoPath: REPO, storyId: 'OC-1', stepsPending: [5, 6, 7, 8] };
const cerrado = { repoPath: REPO, storyId: 'OC-1', stepsPending: [] };

test('pipelineAbierto distingue corrida viva de corrida terminada', () => {
  assert.equal(lv.pipelineAbierto(abierto), true);
  assert.equal(lv.pipelineAbierto(cerrado), false, 'sin steps pendientes la corrida terminó');
  assert.equal(lv.pipelineAbierto({ repoPath: REPO }), false, 'sin stepsPending no hay corrida');
  assert.equal(lv.pipelineAbierto(null), false);
  assert.equal(lv.pipelineAbierto('nope'), false);
});

test('EL CASO: código del repo + pipeline abierto → frena', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro,
  });
  assert.equal(r.block, true);
  assert.deepEqual(r.files, ['/repo/src/Foo.cs']);
  const m = lv.mensaje(r.files, abierto.storyId);
  assert.match(m, /Edit/, 'tiene que decir QUÉ hacer, no sólo que está prohibido');
  assert.match(m, /smart-reloop|set COMPLETO/, 'y la consecuencia concreta');
  assert.match(m, /OC-1/, 'y de qué corrida se trata');
  assert.match(m, /TYCON_LEDGER_VISIBLE=off/, 'y el escape');
});

test('con el pipeline CERRADO pasa (no hay re-loop que proteger)', () => {
  const r = lv.evaluarVisibilidad({
    marker: cerrado, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro,
  });
  assert.equal(r.block, false);
  assert.match(r.reason, /sin pipeline abierto/);
});

test('sin marker pasa (edición suelta, fuera de toda corrida)', () => {
  assert.equal(lv.evaluarVisibilidad({ marker: null, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro }).block, false);
});

test('código FUERA del repo de la corrida pasa (scratchpad, otro repo)', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto,
    codeTargets: ['/tmp/scratch/probe.cs', '/otro-repo/src/Bar.cs'],
    dentroDelRepo: dentro,
  });
  assert.equal(r.block, false, 'el registro sólo mide el repo de la corrida');
});

test('sin targets de código pasa (.md, config y demás los filtra el llamador)', () => {
  assert.equal(lv.evaluarVisibilidad({ marker: abierto, codeTargets: [], dentroDelRepo: dentro }).block, false);
});

test('mezcla: frena SÓLO por los de adentro, y los nombra', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto,
    codeTargets: ['/tmp/scratch/x.cs', '/repo/src/A.cs', '/repo/tests/B.cs'],
    dentroDelRepo: dentro,
  });
  assert.equal(r.block, true);
  assert.deepEqual(r.files, ['/repo/src/A.cs', '/repo/tests/B.cs'], 'el de scratchpad no entra');
});

test('kill-switch off deja pasar todo, y lo dice', () => {
  const r = lv.evaluarVisibilidad({
    marker: abierto, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro, off: 'off',
  });
  assert.equal(r.block, false);
  assert.match(r.reason, /kill-switch/);
});

test('marker sin repoPath no frena (no hay contra qué comparar)', () => {
  const r = lv.evaluarVisibilidad({
    marker: { stepsPending: [5] }, codeTargets: ['/repo/src/Foo.cs'], dentroDelRepo: dentro,
  });
  assert.equal(r.block, false);
  assert.match(r.reason, /repoPath/);
});

// ── El texto según la herramienta: Codex edita con apply_patch, no tiene Edit ni Write ──
// El freno se corre entero (on-bash-write-gate.js) con un evento de cada herramienta: el de Codex trae `turn_id`.
// Con HOME de prueba: el estado del freno vive en una carpeta temporal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const bash = require(path.join(__dirname, '..', 'on-bash-write-gate.js'));
const SID = 'sesion-8108';

function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lv-8108-')));
  const estado = path.join(raiz, 'estado');
  const repo = path.join(raiz, 'repo');
  for (const d of [path.join(estado, 'active'), path.join(repo, 'src')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'viejo.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(estado, 'active', `${SID}.json`), JSON.stringify({
    storyId: '9.9', repoPath: repo, sessionId: SID, stepsCompleted: [0, 1, 2, 3], stepsPending: [4, 5, 6, 7, 8],
  }));
  return { estado, repo };
}
function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}
const ENV_BASE = { TYCON_LEDGER_VISIBLE: undefined, TYCON_STORY_GATE: undefined, TYCON_NO_RUN_CHANGE: '1' };
const ENV_CODEX = { ...ENV_BASE, CODEX_SESSION_ID: SID, CLAUDE_CODE_SESSION_ID: undefined };
const ENV_CLAUDE = { ...ENV_BASE, CODEX_SESSION_ID: undefined, CLAUDE_CODE_SESSION_ID: SID };
const evCodex = (command, cwd) => ({ tool_name: 'Bash', session_id: SID, turn_id: 't-1', cwd, tool_input: { command } });
const evClaude = (command, cwd) => ({ tool_name: 'Bash', session_id: SID, cwd, tool_input: { command } });
const HEREDOC = "cat > src/resta.js <<'EOF'\nmodule.exports = (a, b) => a - b;\nEOF";
const BORRAR = 'rm src/viejo.js';
const nombraEditOWrite = (t) => t.split('\n').filter((l) => /\bEdit\b|\bWrite\b/.test(l));

test('EdicionInvisible_BajoCodex_NombraApplyPatch @story-8.108 @ac-4', () => {
  const { estado, repo } = corral();
  conEnv(ENV_CODEX, () => {
    for (const cmd of [HEREDOC, BORRAR]) {
      const r = bash.handle(evCodex(cmd, repo), { stateDir: estado });
      assert.ok(r && r.block, `frena igual que antes: ${cmd}`);
      assert.match(r.block, /EDICIÓN INVISIBLE/);
      assert.match(r.block, /\(story 9\.9\):/, 'el encabezado nombra la story del marcador');
      assert.match(r.block, /apply_patch/);
      assert.match(r.block, /\*\*\* Begin Patch/);
      assert.match(r.block, /\*\*\* End Patch/);
      // el lazo de 691 vueltas del laboratorio: el parche entre comillas simples con código que trae comillas simples
      // («apply_patch accepts exactly one argument»), repetido igual cada vez
      assert.match(r.block, /comillas simples/);
      assert.match(r.block, /accepts exactly one argument/);
      assert.match(r.block, /no repitas el mismo comando/);
      assert.deepEqual(nombraEditOWrite(r.block), [], `ninguna línea nombra Edit ni Write (${cmd})`);
    }
  });
  // con todos los avisos prendidos a la vez: deshacer o borrar, destino armado y variables sin resolver
  const todo = lv.mensaje(['/repo/src/A.js'], '9.9', {
    codex: true, borrarODeshacer: true, armado: true, sinResolver: [{ file: '/repo/src/B.js', vars: ['NADIE'] }],
  });
  assert.match(todo, /apply_patch/);
  assert.deepEqual(nombraEditOWrite(todo), [], 'ninguna línea de ningún aviso nombra Edit ni Write');
});

test('EdicionInvisible_BajoClaude_SinCambios @story-8.108 @ac-4', () => {
  const { estado, repo } = corral();
  conEnv(ENV_CLAUDE, () => {
    const r = bash.handle(evClaude(HEREDOC, repo), { stateDir: estado });
    assert.ok(r && r.block, 'frena');
    assert.match(r.block, /tools \*\*Edit\*\* o \*\*Write\*\*/);
    assert.doesNotMatch(r.block, /apply_patch/);
  });
  assert.equal(lv.mensaje(['/repo/src/A.js'], '9.9', { borrarODeshacer: true, armado: true }),
    lv.mensaje(['/repo/src/A.js'], '9.9', { borrarODeshacer: true, armado: true, codex: false }),
    'sin la marca de Codex, el texto de siempre');
});
