'use strict';
/**
 * review-rounds.test.js — el tope de vueltas de revisores: la misma vuelta pedida dos veces no suma, el tope (de fábrica,
 * de la organización y del repo), qué pasa al llegar con algo abierto, el cierre que no deja pasar callado lo de seguridad
 * o datos, y la línea del cierre.
 *
 * Corre pipeline.js y marker.js de verdad sobre una corrida de juguete, con HOME temporal. 0 deps (node:test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';

const SCRIPTS = path.join(__dirname, '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const MARKER = path.join(SCRIPTS, 'marker.js');
const SID = 'test-rounds';
const RUN = '9.8-20261020000000';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const FECHA = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
// stable-data: la conversación va después del arranque de la corrida, que se anota con el reloj real
const T = (seg) => new Date(Date.now() + 60000 + seg * 1000).toISOString();

/** Un repo con una story, la carpeta de la corrida y su marcador en una HOME propia. */
function laboratorio({ findings = null, fotos = [], servidas = [], advisorsYaml = null, org = null } = {}) {
  const repo = tmp('rr-repo-');
  const home = tmp('rr-home-');
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, ...FECHA } });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), '// base\n');
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, ['---', 'story: 9.8', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  if (advisorsYaml) { fs.mkdirSync(path.join(repo, '.tycon')); fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), advisorsYaml); }
  const run = path.join(repo, '.advisors', 'pipeline-runs', RUN);
  fs.mkdirSync(path.join(run, 'rethink'), { recursive: true });
  if (findings) fs.writeFileSync(path.join(run, 'findings.json'), JSON.stringify(findings, null, 2));
  if (servidas.length) fs.writeFileSync(path.join(run, 'rethink', 'served.json'), JSON.stringify({ served: servidas }));
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'base');
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const iterations = {};
  for (const n of fotos) iterations[n] = { ts: new Date().toISOString(), files: {} };
  const markerFile = path.join(state, 'active', `${SID}.json`);
  fs.writeFileSync(markerFile, JSON.stringify({ storyId: '9.8', storyPath: story, repoPath: repo, sessionId: SID,
    startedAt: new Date(Date.now() - 1000).toISOString(), stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8], iterations, fileEvents: [], checks: {} }));
  let arbol = null;
  if (org) {
    arbol = tmp('rr-arbol-');
    fs.mkdirSync(path.join(arbol, 'scripts'));
    fs.writeFileSync(path.join(arbol, 'scripts', 'install-tycon-hooks.sh'), '#!/bin/bash\n');
    fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify({ version: 1,
      public: { platform: 'github', org: 'acme', repo: 'h' }, profile: { platform: 'github', org: 'acme', repo: 'p' }, operations: { platform: 'github', org: 'acme', repo: 'o' },
      review: org }));
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_TODAY: '2026-10-20', TYCON_LANE_LLM: '0' };
  for (const k of ['TYCON_REVIEW_MAX_ROUNDS', 'TYCON_GUIDES_DIR', 'NODE_TEST_CONTEXT']) delete env[k];
  if (arbol) env.TYCON_GUIDES_DIR = arbol;
  const lab = { repo, home, story, run, state, markerFile, env };
  lab.reloop = (iter, extra = [], envExtra = {}) => spawnSync(process.execPath,
    [PIPELINE, 'smart-reloop', '--iter', String(iter), '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: { ...env, ...envExtra } });
  lab.cmd = (bin, args, envExtra = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: repo, env: { ...env, ...envExtra } });
  lab.foto = (n) => { const m = JSON.parse(fs.readFileSync(markerFile, 'utf8')); m.iterations[n] = { ts: new Date().toISOString(), files: {} }; fs.writeFileSync(markerFile, JSON.stringify(m)); };
  // el ajuste de la máquina: un archivo en la carpeta de estado, donde el agente no escribe
  lab.maquina = (n) => fs.writeFileSync(path.join(state, 'review-max-rounds.json'), JSON.stringify({ max_rounds: n }));
  lab.servidas = () => { try { return JSON.parse(fs.readFileSync(path.join(run, 'rethink', 'served.json'), 'utf8')).served; } catch (_) { return []; } };
  lab.conversar = (regs) => {
    const dir = path.join(home, '.claude', 'projects', '-repo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), regs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  return lab;
}
const delDev = (texto, ts = T(1)) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: texto } });
const hallazgo = (rule, severity, disposition, extra = {}) => ({ rule_id: rule, severity, advisor: 'tycon-plugin-security-basics', file: 'src/a.js', disposition, reason: 'x', ...extra });
const gates = (lab) => { try { return fs.readFileSync(path.join(lab.state, 'gates.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };

test('Rounds_SameRoundTwice_DoesNotCount @story-7.37 @ac-1', () => {
  // la vuelta 1 se lanzó; se pide dos veces la 2 sin lanzar revisores en el medio: es la misma vuelta
  const lab = laboratorio({ fotos: [1], servidas: [1] });
  const a = lab.reloop(2);
  assert.equal(a.status, 0, a.stderr);
  const b = lab.reloop(2);
  assert.equal(b.status, 0, `la misma vuelta pedida dos veces no es otra: ${b.stderr}`);
  assert.deepEqual(lab.servidas(), [1, 2]);
  // con los revisores de la 2 lanzados, el pedido siguiente es la 3, como siempre (con el tope alto, pide la nota)
  lab.foto(2);
  lab.maquina(6);
  const c = lab.reloop(2);
  assert.equal(c.status, 3, c.stderr);
  assert.match(c.stderr, /vuelta 3/i);
  // subir el tope con el ajuste de la máquina pasa, pero queda anotado y se dice
  assert.match(c.stderr, /el ajuste de esta máquina.*lo sube a 6: queda anotado/);
  assert.ok(gates(lab).some((g) => g.name === 'review-cap-machine' && g.iter === 3));
  const linea = lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo]);
  assert.match(linea.stdout, /tope 6, puesto por el ajuste de esta máquina/);
});

test('Rounds_RunCost_CountsRoundsWithReviewers @story-7.37 @ac-2', () => {
  const lab = laboratorio({ fotos: [1, 2] });
  // el registro de revisores con cuatro arranques del paso 5 (dos sin revisores)
  const runs = path.join(lab.state, 'advisor-runs');
  fs.mkdirSync(runs, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(runs, `${SID}.jsonl`), [{ event: 'step5-start' }, { advisor: 'tycon-plugin-security-basics' }, { event: 'step5-start' },
    { event: 'step5-start' }, { advisor: 'tycon-plugin-security-basics' }, { event: 'step5-start' }].map((x) => JSON.stringify({ ts, ...x })).join('\n') + '\n');
  const rr = lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo, '--json']);
  assert.equal(rr.status, 0, rr.stderr);
  assert.equal(JSON.parse(rr.stdout).vueltas, 2);
  const c = lab.cmd(MARKER, ['clear']);
  assert.match(c.stdout + c.stderr, /en 2 iteración/, 'el costo del run cuenta las vueltas con revisores');
});

// El costo del cierre cuenta sólo esta corrida: desde que arrancó y, si la línea nombra una story, la de esta.
function costoDelVolcado(lab) {
  const dir = path.join(lab.state, 'timing-history');
  const f = fs.readdirSync(dir).filter((x) => x.startsWith('9.8-')).sort().pop();
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).costo;
}
function registro(lab, lineas) {
  const runs = path.join(lab.state, 'advisor-runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, `${SID}.jsonl`), lineas.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
}
const antes = () => new Date(Date.now() - 3600000).toISOString();
const despues = () => new Date(Date.now() + 1000).toISOString();

test('RunCost_OnlyThisStory @story-7.49 @ac-1', () => {
  const lab = laboratorio({ fotos: [1] });
  registro(lab, [
    { ts: antes(), advisor: 'tycon-plugin-security-basics', story: '9.7' }, { ts: antes(), advisor: 'tycon-story-validator', story: '9.7' },
    { ts: antes(), advisor: 'tycon-ac-coverage-checker', story: '9.7' },
    { ts: despues(), event: 'step5-start' },
    { ts: despues(), advisor: 'tycon-plugin-security-basics', story: '9.8' }, { ts: despues(), advisor: 'tycon-story-validator', story: '9.8' },
    // otra story que corrió en la misma sesión, después del arranque de ésta, tampoco es de esta corrida
    { ts: despues(), advisor: 'tycon-plugin-tests-coverage', story: '9.6' },
  ]);
  const c = lab.cmd(MARKER, ['clear']);
  assert.match(c.stdout + c.stderr, /costo del run: 2 agentes/, c.stderr);
  assert.equal(costoDelVolcado(lab).spawns, 2);
});

test('RunCost_AdhocAfterStart_Counts @story-7.49 @ac-2', () => {
  const lab = laboratorio({ fotos: [1] });
  registro(lab, [{ ts: antes(), advisor: 'Explore' }, { ts: despues(), advisor: 'Explore' }, { ts: despues(), advisor: 'tycon-story-validator', story: '9.8' }]);
  lab.cmd(MARKER, ['clear']);
  const costo = costoDelVolcado(lab);
  assert.deepEqual([costo.spawns, costo.adhoc], [2, 1]);
});

test('RunCost_NoTimestamp_Said @story-7.49 @ac-3', () => {
  const lab = laboratorio({ fotos: [1] });
  registro(lab, [{ advisor: 'tycon-story-validator', story: '9.8' }, { ts: 'no es una hora', advisor: 'Explore' }, { event: 'step5-start' },
    // sin hora pero de otra story: no es de esta corrida, ni para contarla como «sin hora»
    { advisor: 'tycon-story-validator', story: '9.7' }, '{ esto no es JSON',
    { ts: despues(), advisor: 'tycon-story-validator', story: '9.8' }]);
  lab.cmd(MARKER, ['clear']);
  const costo = costoDelVolcado(lab);
  assert.equal(costo.spawns, 1);
  assert.equal(costo.sin_hora, 3);
  assert.equal(costo.ilegibles, 1);
});

test('RunCost_NoStart_OnlyThisStorySaid @story-7.49 @ac-1 @ac-3', () => {
  // un marcador sin hora de arranque: cuentan sólo las líneas que nombran esta story, y el volcado lo dice
  const lab = laboratorio({ fotos: [1] });
  const m = JSON.parse(fs.readFileSync(lab.markerFile, 'utf8')); delete m.startedAt; fs.writeFileSync(lab.markerFile, JSON.stringify(m));
  registro(lab, [{ ts: antes(), advisor: 'Explore' }, { ts: antes(), advisor: 'tycon-story-validator', story: '9.7' }, { ts: despues(), advisor: 'tycon-story-validator', story: '9.8' }]);
  lab.cmd(MARKER, ['clear']);
  const costo = costoDelVolcado(lab);
  assert.equal(costo.spawns, 1);
  assert.equal(costo.sin_arranque, true);
});

test('Cap_Default_Two @story-7.37 @ac-3', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2] });
  const r = lab.reloop(3);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /tope de 2 vueltas/);
  assert.match(r.stderr, /no quedó nada abierto|quedó abierto/i);
  // una variable de ambiente antepuesta al comando (la podría poner el propio agente) no sube el tope
  const v = lab.reloop(3, [], { TYCON_REVIEW_MAX_ROUNDS: '99' });
  assert.equal(v.status, 3);
  assert.match(v.stderr, /tope de 2 vueltas/);
});

test('Cap_OrgAndRepo_RepoWins_BadValueSaid @story-7.37 @ac-4', () => {
  const rr = (lab) => JSON.parse(lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo, '--json']).stdout);
  const org = laboratorio({ org: { max_rounds: 3 } });
  assert.deepEqual([rr(org).tope, rr(org).tope_de], [3, 'organizacion']);
  const repo = laboratorio({ org: { max_rounds: 3 }, advisorsYaml: 'review:\n  max_rounds: 4\n' });
  assert.deepEqual([rr(repo).tope, rr(repo).tope_de], [4, 'repo']);
  const mal = laboratorio({ org: { max_rounds: 3 }, advisorsYaml: 'review:\n  max_rounds: 9\n' });
  const m = rr(mal);
  assert.deepEqual([m.tope, m.tope_de], [3, 'organizacion']);
  assert.match(m.problemas.join(' '), /max_rounds.*de 1 a 6.*no se usa/);
});

test('Cap_SecurityCritical_AsksThePerson @story-7.37 @ac-5', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2], findings: [hallazgo('SEC-C1', 'CRITICAL', 'open'), hallazgo('TEST-W2', 'WARNING', 'open')] });
  const r = lab.reloop(3);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /SEC-C1/);
  assert.match(r.stderr, /seguridad o (de )?datos/);
  assert.match(r.stderr, /--extra-round/);
  assert.match(r.stderr, /waive-critical/);
  // un «no» a otra vuelta, o un ok que no la nombra, no la autoriza
  for (const dice of ['no hace falta otra vuelta, lo eximo', 'ok, seguí']) {
    lab.conversar([delDev(dice)]);
    const no = lab.reloop(3, ['--extra-round', '--approved-by', 'Dev de Prueba', '--quote', dice]);
    assert.equal(no.status, 3, `«${dice}» no autoriza otra vuelta`);
    assert.match(no.stderr, /No se autorizó la vuelta extra/);
  }
  // con el ok de la persona, la vuelta extra se sirve (la tercera, además, pide su nota de repensar)
  lab.conversar([delDev('dale, una vuelta más para arreglar el SEC-C1')]);
  const nota = lab.cmd(MARKER, ['rethink', '--iter', '3', '--repeated', 'El mismo hallazgo de seguridad en las dos vueltas sobre el mismo archivo',
    '--change', 'Cambia el enfoque: la validación pasa a la entrada del endpoint, antes de tocar la base', '--repo', lab.repo, '--story', lab.story]);
  assert.equal(nota.status, 0, nota.stderr);
  const ok = lab.reloop(3, ['--extra-round', '--approved-by', 'Dev de Prueba', '--quote', 'dale, una vuelta más para arreglar el SEC-C1']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(gates(lab).some((g) => g.name === 'extra-round' && g.iter === 3), 'la vuelta extra queda anotada');
});

test('Cap_OtherOpen_BecomesDebt @story-7.37 @ac-6', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2], findings: [hallazgo('TEST-C1', 'CRITICAL', 'open'), hallazgo('REACT-W3', 'WARNING', 'deferred')] });
  const r = lab.reloop(3);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /deuda/);
  assert.match(r.stderr, /TEST-C1/);
  assert.doesNotMatch(r.stderr, /--extra-round/, 'sin nada de seguridad o datos no se ofrece la vuelta extra');
  // anotada como deuda con write-findings, la marca no se pierde y el cierre la nombra
  const f = path.join(lab.repo, 'deuda.json');
  fs.writeFileSync(f, JSON.stringify([{ ...hallazgo('TEST-C1', 'CRITICAL', 'deferred', { deuda: 'tope' }), advisor: 'orquestador' }]));
  const w = lab.cmd(PIPELINE, ['write-findings', '--story', lab.story, '--repo', lab.repo, '--findings', f]);
  assert.equal(w.status, 0, w.stderr);
  const escritos = JSON.parse(fs.readFileSync(path.join(lab.run, 'findings.json'), 'utf8'));
  assert.equal((Array.isArray(escritos) ? escritos : escritos.findings)[0].deuda, 'tope');
  const linea = lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo]);
  assert.match(linea.stdout, /1 como deuda \(TEST-C1\)/);
});

test('Close_BlockingCriticalOpen_Blocks @story-7.37 @ac-7', () => {
  for (const f of [hallazgo('TENANT-C1', 'CRITICAL', 'deferred'), hallazgo('SIGNALR-C2', 'CRITICAL', 'open', { advisor: 'pase adversarial' })]) {
    const lab = laboratorio({ fotos: [1, 2], findings: [f] });
    const r = lab.cmd(MARKER, ['complete-step', '8']);
    assert.notEqual(r.status, 0, f.rule_id);
    assert.match(r.stderr, new RegExp(`${f.rule_id}.*seguridad o (de )?datos|seguridad o (de )?datos.*${f.rule_id}`, 's'), r.stderr);
  }
});

test('Close_UnreadableFindings_NeverNothingOpen @story-7.37 @ac-7 @ac-8', () => {
  // no poder leer los hallazgos no es «no quedó nada abierto»: el paso 8 frena y la línea del cierre lo dice
  const lab = laboratorio({ fotos: [1, 2] });
  fs.writeFileSync(path.join(lab.run, 'findings.json'), '{ esto no es JSON');
  const c = lab.cmd(MARKER, ['complete-step', '8']);
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /findings\.json/, 'lo frena el control de findings.json');
  assert.doesNotMatch(c.stdout + c.stderr, /BLOQUEADO — 0 crítico/);
  const l = lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo]);
  assert.match(l.stdout, /lo abierto no lo pude mirar/);
  assert.doesNotMatch(l.stdout, /quedó abierto: nada/);
  const r = lab.reloop(3);
  assert.match(r.stderr, /No pude mirar lo abierto/);
});

test('Close_SaysRoundsAndOpen @story-7.37 @ac-8', () => {
  const lab = laboratorio({ fotos: [1, 2], findings: [hallazgo('SEC-C1', 'CRITICAL', 'fixed'), hallazgo('REACT-W3', 'WARNING', 'deferred', { deuda: 'tope' })] });
  const r = lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 vueltas de revisores \(tope 2\); quedó abierto: 1 como deuda \(REACT-W3\)\./);
  const paso8 = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  assert.match(paso8, /pipeline\.js review-rounds/);
});

test('Cap_ExtraRound_Judge: «tercera vuelta» y los ordinales autorizan; negarla o preguntarla, no', () => {
  const juez = require(path.join(SCRIPTS, 'lib', 'review-rounds.js')).juezDeLaVuelta();
  for (const t of ['dale, tercera vuelta', 'hacé una tercera vuelta para el SEC-C1', 'ok, 3ra vuelta', 'va la cuarta vuelta', 'dale, una vuelta más']) {
    assert.equal(juez(t), null, `«${t}» autoriza otra vuelta`);
  }
  for (const t of ['no hagas una tercera vuelta', 'sin tercera vuelta, cerrala', '¿tercera vuelta?', 'cerrá sin más vueltas', 'la tercera revisión']) {
    assert.ok(juez(t), `«${t}» no autoriza otra vuelta`);
  }
});
