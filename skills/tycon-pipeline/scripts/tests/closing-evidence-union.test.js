'use strict';
/**
 * closing-evidence-union.test.js — el freno del commit suma las TRES fuentes por AC (2026-10-14).
 *
 * El caso: desde el 2026-10-13, casi todo commit que pasaba una story a `review` en un producto del equipo
 * rebotaba con «Evidencia encontrada: … PERO no menciona ACs: #…». El freno elegía UN archivo (el que
 * nombra más criterios) y le exigía que nombrara todos; la evidencia real estaba repartida entre el
 * registro de pruebas de humo, los gates E2E y las firmas del dev, y la matriz por AC la sumaba bien
 * (VERDE). La salida era habilitar a mano una escritura para que el agente redactara un `-cierre.md`.
 *
 * Estas pruebas corren el hook DE VERDAD (on-pre-commit.js por stdin, como lo llama Claude Code) sobre
 * un repo armado en una carpeta temporal, con una HOME temporal (gates.log y firmas de ahí, nunca las
 * reales). Los cuatro casos que pidió el dueño:
 *   1. los tres orígenes repartidos, sin `-cierre.md` → pasa;
 *   2. un AC que no está en ninguno → frena, y el mensaje nombra el AC y las tres fuentes;
 *   3. un smoke con salida ≠ 0 → no cuenta (frena);
 *   4. una firma vencida (la declaración del AC cambió después de firmar) → no cuenta (frena).
 * Y uno más: si existe un `-cierre.md` que nombra todo, sigue contando.
 *
 * 🔴 rojo previo verificado: con el on-pre-commit.js de antes del cambio, el caso 1 sale 2 («no menciona ACs»).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const HOOK = path.join(SCRIPTS, 'on-pre-commit.js');
const waiverLib = require(path.join(SCRIPTS, 'lib', 'runtime-waiver.js'));
const { coberturaDeLaUnion } = require(path.join(SCRIPTS, 'lib', 'closing-evidence.js'));

// La carpeta del estado de una HOME, preguntada a quien la decide (como el hook).
function stateDirDe(home) {
  const lib = path.join(SCRIPTS, '..', '..', '..', 'scripts', 'setup', 'harness', 'tycon-home.js');
  if (fs.existsSync(lib)) {
    const env = { ...process.env }; delete env.TYCON_HOME;
    const out = execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(lib)}).stateDir(${JSON.stringify(home)}))`],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out;
  }
  return path.join(home, '.claude', '.tycon-pipeline');
}

const DECL_3 = 'el envío real lo hace un servicio externo';
function storyMd(status, { decl3 = DECL_3, conAc4 = false } = {}) {
  return [
    '---',
    'story: 9.9',
    `status: ${status}`,
    'runtime_not_verifiable:',
    '  - ac: 3',
    `    reason: "${decl3}"`,
    '    covered_by: T3',
    '---',
    '',
    '# Story 9.9 — Fixture de la unión (E2E y smoke runtime)',
    '',
    '## Acceptance Criteria',
    '',
    '1. **Given** un catálogo, **Then** el listado lo muestra con su nombre.',
    '2. **Given** un catálogo protegido, **Then** la pantalla lo marca como protegido.',
    '3. **Given** un catálogo nuevo, **Then** el aviso queda registrado en el servicio externo.',
    ...(conAc4 ? ['4. **Given** un catálogo vacío, **Then** el listado lo indica.'] : []),
    '',
    '### Tests',
    '',
    '| ID | Test | AC | Nivel | Escenario | Esperado |',
    '|---|---|---|---|---|---|',
    '| T3 | `AvisoTests.Registra` | 3 | unit | x | y |',
    '| E1 | `story-9-9.spec.ts::protegido` | 2 | e2e | x | y |',
    '',
  ].join('\n');
}

const SIN_MS = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const COMPACTO = (d) => SIN_MS(d).replace(/[-:]/g, '');

/** Arma el repo, la HOME y las tres fuentes. `opts` rompe una a la vez. */
function armar(t, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-union-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repo, 'specs', 'stories'), { recursive: true });
  const estado = stateDirDe(home);
  fs.mkdirSync(estado, { recursive: true });
  const gatesLog = path.join(estado, 'gates.log');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main', '.');
  const storyRel = 'specs/stories/9-9-fixture.md';
  fs.writeFileSync(path.join(repo, storyRel), storyMd('ready-for-dev', opts));
  git('add', storyRel); git('commit', '-q', '-m', 'base');

  const dod = path.join(repo, '.advisors', 'dod-runtime');
  fs.mkdirSync(dod, { recursive: true });
  const ahora = new Date(Date.now() - 60 * 1000);
  // 1. pruebas de humo: AC 1 (salida 0, o la que diga el caso), con su copia en gates.log como la escribe smoke-run.sh.
  const ts = SIN_MS(ahora);
  const exit = opts.smokeExit === undefined ? 0 : opts.smokeExit;
  fs.writeFileSync(path.join(dod, '9.9-smoke-ledger.jsonl'),
    JSON.stringify({ ts, story: '9.9', acs: [1], cmd: 'curl -s http://app/catalogos # AC #1', exit, via: 'smoke-run.sh' }) + '\n');
  fs.appendFileSync(gatesLog, JSON.stringify({ type: 'smoke-run', ts, story: '9.9', acs: [1], exit }) + '\n');
  // 2. gate E2E PASS con su copia run-check: cubre la fila E1 → AC 2. El texto del gate no nombra criterios.
  fs.writeFileSync(path.join(dod, `9.9-e2e-gate-${COMPACTO(ahora)}.md`), [
    '# DoD Runtime Evidence — Story 9.9 — Playwright Gate (scoped)',
    '**Spec filter**: story-9-9.spec.ts', '```', 'verdict=PASS', 'total=1', 'passed=1', '```', '',
  ].join('\n'));
  fs.appendFileSync(gatesLog, JSON.stringify({ ts: new Date().toISOString(), check: 'dod', status: 'green',
    provenance: 'run-check', cmd: 'bash e2e-gate.sh /fe 9.9 /dir story-9-9.spec.ts', exit: 0 }) + '\n');
  // AC 3: lo cubre un test (suite verde) y lo firmó el dev desde su terminal, anclado a su declaración.
  fs.writeFileSync(path.join(repo, '.advisors', 'tests-result.json'),
    JSON.stringify({ ts: new Date().toISOString(), story_id: '9.9', suite_green: true }));
  const declFirmada = opts.firmaVieja ? 'la razón que se firmó antes de cambiarla' : DECL_3;
  waiverLib.appendWaiver({ story: '9.9', acs: [3], matrixHash: 'cualquiera', approvedBy: 'deva', nowIso: new Date().toISOString(),
    declHashByAc: { 3: waiverLib.declHashFor(declFirmada, 'T3') }, logPath: path.join(repo, '.tycon', 'runtime-waivers.jsonl') });
  if (opts.cierre) fs.writeFileSync(path.join(dod, '9.9-cierre.md'), opts.cierre);

  fs.writeFileSync(path.join(repo, storyRel), storyMd('review', opts));
  git('add', storyRel);
  return { repo, home, storyRel };
}

function correrHook({ repo, home }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_CLOSURE_RECORD: 'off', TYCON_ADVISORS_GATE: 'off' };
  delete env.TYCON_HOME; delete env.NODE_TEST_CONTEXT; delete env.TYCON_WAIVER_LOG;
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repo, env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'union-test', cwd: repo, tool_name: 'Bash', tool_input: { command: 'git commit -m "story 9.9 a review"' } }),
  });
  return { code: r.status, err: r.stderr || '' };
}

test('1. los tres orígenes repartidos, sin -cierre.md: el commit pasa', (t) => {
  const r = correrHook(armar(t));
  assert.equal(r.code, 0, `esperaba 0 y salió ${r.code}:\n${r.err}`);
  assert.doesNotMatch(r.err, /Criterios sin evidencia|no menciona ACs/);
});

test('2. un AC que no está en ninguna fuente frena, y el mensaje lo nombra con las tres fuentes', (t) => {
  const r = correrHook(armar(t, { conAc4: true }));
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /Criterios sin evidencia: #4\b/);
  assert.doesNotMatch(r.err, /Criterios sin evidencia: [^\n]*#[123]\b/, 'los cubiertos por la unión no se nombran como faltantes');
  assert.match(r.err, /pruebas de humo: .*9\.9-smoke-ledger\.jsonl/);
  assert.match(r.err, /gates E2E: 9\.9-e2e-gate-/);
  assert.match(r.err, /firmas del dev: .*runtime-waivers\.jsonl/);
});

test('3. un smoke con salida distinta de 0 no cuenta, aunque su texto nombre el AC', (t) => {
  const r = correrHook(armar(t, { smokeExit: 1 }));
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /Criterios sin evidencia: #1\b/);
});

test('4. una firma vencida (la declaración cambió después de firmar) no cuenta', (t) => {
  const r = correrHook(armar(t, { firmaVieja: true }));
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /Criterios sin evidencia: #3\b/);
});

test('5. un -cierre.md que nombra todo sigue contando (no hace falta, pero no se rompe)', (t) => {
  const r = correrHook(armar(t, { cierre: '# Cierre 9.9\n- AC #1 verificado\n- AC #2 verificado\n- AC #3 verificado\n' }));
  assert.equal(r.code, 0, r.err);
});

test('la unión lee el veredicto de la matriz, no texto: sin matriz no cubre nada', () => {
  assert.equal(coberturaDeLaUnion(null).cubiertos.size, 0);
  assert.equal(coberturaDeLaUnion({ structuralError: 'x' }).cubiertos.size, 0);
  const u = coberturaDeLaUnion({ perAc: {
    1: { verdict: 'RUNTIME', fuentes: { smoke: ['t'], e2e: [] } },
    2: { verdict: 'RUNTIME', fuentes: { smoke: [], e2e: ['g.md'] } },
    3: { verdict: 'WAIVED-USER', fuentes: { smoke: [], e2e: [] } },
    4: { verdict: 'NOT-VERIFIABLE', fuentes: { smoke: [], e2e: [] } },
    5: { verdict: 'NOT-RUN', fuentes: { smoke: [], e2e: [] } },
  } });
  assert.deepEqual([...u.cubiertos].sort(), [1, 2, 3]);
  assert.deepEqual(u.porAc.get(3), ['firma']);
});
