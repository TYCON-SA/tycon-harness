'use strict';
/**
 * resume-state.test.js — lo que tiene que quedar en disco antes de cada punto de control, y el cierre de la sesión
 * al terminar la historia: releer la conversación entera es lo más caro de una ejecución.
 *
 *   T1 · fuera de un punto de control no pide nada; en «Aprobar el plan», las condiciones del pedido.
 *   T2 · en «Hallazgos», el informe de cada revisor lanzado; los agentes sueltos, los de otra historia y los de otros
 *        pasos (fuera del set esperado de «Revisores») no cuentan.
 *   T3 · marker.js conditions las anota, y next lo dice al llegar al punto de control.
 *   T4 · marker.js clear, al cerrar una historia, pide cerrar la sesión.
 *
 * stable-data: el marcador de T3 y T4 lleva la hora del momento para que los guiones lo vean vivo; ninguna aserción la compara.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const CD = require(path.join(SCRIPTS, 'lib', 'resume-state.js'));

function casa(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  return { home, repo, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 'sess-cd-1', TYCON_GUARD_STATE_DIR: '' } };
}
const correr = (c, script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { cwd: c.repo, env: c.env, encoding: 'utf8', timeout: 60000 });

// T1 FueraDePunto_NoPide_EnAprobarElPlan_LasCondiciones
// 🔴 Falla con: llegar a «Aprobar el plan» sin las condiciones del pedido en disco no se dice.
test('T1 FueraDePunto_NoPide_EnAprobarElPlan_LasCondiciones', () => {
  const m = { storyId: '9.1' };
  assert.deepStrictEqual(CD.faltantes({ marker: m, paso: 'implement' }), []);
  const f = CD.faltantes({ marker: m, paso: 'approve-plan' });
  assert.strictEqual(f.length, 1);
  assert.match(f[0].comando, /marker\.js conditions/);
  assert.deepStrictEqual(CD.faltantes({ marker: { ...m, requestConditions: { texto: 'ninguna' } }, paso: 'approve-plan' }), []);
  assert.strictEqual(CD.aviso([]), null);
  assert.match(CD.aviso(f), /^Antes de este punto de control, dejá en disco: .*sesión nueva/);
});

// T2 Hallazgos_CadaRevisorConSuInforme
// 🔴 Falla con: un revisor lanzado sin su informe en la carpeta de la ejecución no se dice en «Hallazgos».
test('T2 Hallazgos_CadaRevisorConSuInforme', () => {
  const m = { storyId: '9.1', startedAt: '2026-11-21T10:00:00Z', runDir: '/r', requestConditions: { texto: 'ninguna' } };
  const lineas = [
    // el validador de la historia corre antes de «Revisores»: no deja informe en su carpeta
    JSON.stringify({ ts: '2026-11-21T10:30:00Z', advisor: 'tycon-story-validator', story: '9.1' }),
    JSON.stringify({ ts: '2026-11-21T10:59:00Z', event: 'step5-start', expected: ['tycon-plugin-security-basics', 'tycon-plugin-tests-coverage', 'tycon-silent-failure-hunter', 'tycon-spec-first-checker'] }),
    JSON.stringify({ ts: '2026-11-21T11:00:00Z', advisor: 'tycon-plugin-security-basics', story: '9.1' }),
    JSON.stringify({ ts: '2026-11-21T11:01:00Z', advisor: 'tycon-plugin-security-basics', story: '9.1' }),
    JSON.stringify({ ts: '2026-11-21T11:02:00Z', advisor: 'general-purpose', story: '9.1' }),
    JSON.stringify({ ts: '2026-11-21T11:03:00Z', advisor: 'tycon-silent-failure-hunter', story: '9.2' }),
    JSON.stringify({ ts: '2026-11-21T09:00:00Z', advisor: 'tycon-spec-first-checker', story: '9.1' }),
    '{roto',
    JSON.stringify({ ts: '2026-11-21T11:04:00Z', advisor: 'tycon-plugin-tests-coverage', story: '9.1' }),
  ];
  const lanzados = CD.lanzadosDe({ lineas, marker: m });
  assert.deepStrictEqual(lanzados, ['tycon-plugin-security-basics', 'tycon-plugin-tests-coverage']);
  // sin la marca de «Revisores», ningún agente cuenta como revisor lanzado
  assert.deepStrictEqual(CD.lanzadosDe({ lineas: lineas.filter((l) => !l.includes('step5-start')), marker: m }), []);
  const hay = new Set([path.join('/r', CD.CARPETA_DE_INFORMES, 'tycon-plugin-tests-coverage.md')]);
  const f = CD.faltantes({ marker: m, paso: 'findings', lanzados, existe: (p) => hay.has(p) });
  assert.deepStrictEqual(f.map((x) => x.que), [`el informe de tycon-plugin-security-basics (${path.join('/r', CD.CARPETA_DE_INFORMES, 'tycon-plugin-security-basics.md')})`]);
  // sin carpeta de la ejecución: se dice, con el comando
  assert.match(CD.faltantes({ marker: { ...m, runDir: null }, paso: 'findings', lanzados })[0].comando, /run-dir/);
});

// T3 Conditions_SeAnotan_YNextLoDice
// 🔴 Falla con: no hay cómo anotar las condiciones del pedido, o next llega a «Aprobar el plan» sin decir que faltan.
test('T3 Conditions_SeAnotan_YNextLoDice', (t) => {
  const c = casa(t);
  const dir = path.join(c.home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-cd-1.json'), JSON.stringify({ sessionId: 'sess-cd-1', storyId: '9.1', repoPath: c.repo, startedAt: new Date().toISOString(),
    stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan'], stepsPending: ['approve-plan', 'implement'], lastTouch: new Date().toISOString() }));
  let r = correr(c, 'pipeline.js', ['next']);
  const antes = JSON.parse(r.stdout);
  assert.strictEqual(antes.next_step, 'approve-plan', r.stdout + r.stderr);
  assert.ok(Array.isArray(antes.checkpoint_disk) && antes.checkpoint_disk.length === 1, r.stdout);
  assert.match(antes.note || '', /Antes de este punto de control, dejá en disco/);
  // sin texto, no anota
  r = correr(c, 'marker.js', ['conditions']);
  assert.notStrictEqual(r.status, 0);
  r = correr(c, 'marker.js', ['conditions', 'no abras pedidos; suites sólo de lo tocado']);
  assert.strictEqual(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'sess-cd-1.json'), 'utf8'));
  assert.strictEqual(m.requestConditions.texto, 'no abras pedidos; suites sólo de lo tocado');
  const despues = JSON.parse(correr(c, 'pipeline.js', ['next']).stdout);
  assert.deepStrictEqual(despues.checkpoint_disk || [], []);
});

// T4 Clear_PideCerrarLaSesion
// 🔴 Falla con: al cerrar una historia, el cierre no dice que la sesión se cierra y la próxima va en una nueva.
test('T4 Clear_PideCerrarLaSesion', (t) => {
  const c = casa(t);
  const dir = path.join(c.home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-cd-1.json'), JSON.stringify({ sessionId: 'sess-cd-1', storyId: '9.1', repoPath: c.repo, startedAt: new Date().toISOString(),
    stepScheme: 2, stepsCompleted: [], stepsPending: ['start'], lastTouch: new Date().toISOString() }));
  const r = correr(c, 'marker.js', ['clear']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.split(CD.CIERRE_DE_SESION).length - 1, 1, `el renglón sale una sola vez:\n${r.stdout}`);
  // el respaldo: con la carpeta del volcado ilegible el archivo de la ejecución falla, y el renglón sale igual, una vez
  const c2 = casa(t);
  const dir2 = path.join(c2.home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'sess-cd-1.json'), JSON.stringify({ sessionId: 'sess-cd-1', storyId: '9.1', repoPath: c2.repo, startedAt: new Date().toISOString(),
    stepScheme: 2, stepsCompleted: [], stepsPending: ['start'], lastTouch: new Date().toISOString() }));
  fs.writeFileSync(path.join(c2.home, '.claude', '.tycon-pipeline', 'timing-history'), 'no es una carpeta');
  const r2 = correr(c2, 'marker.js', ['clear']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(r2.stdout.split(CD.CIERRE_DE_SESION).length - 1, 1, `con el archivo fallado, una sola vez:\n${r2.stdout}`);
});
