'use strict';
/**
 * review-rounds.test.js — el tope de vueltas de revisores: la misma vuelta pedida dos veces no suma, el tope (de fábrica,
 * de la organización y del repo), qué pasa al llegar con algo abierto, el cierre que no deja pasar callado lo de seguridad
 * o datos, y la línea del cierre.
 *
 * Corre pipeline.js y marker.js de verdad sobre una corrida de juguete, con HOME temporal. 0 deps (node:test).
 */
// sin el perfil del equipo: la prueba fija su ambiente (scripts/tests/lib/without-team-profile.js)
require('../../../../scripts/tests/lib/without-team-profile.js');
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
const { conVentana } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
const SID = 'test-rounds';
const RUN = '9.8-20261020000000';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const FECHA = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
// stable-data: la conversación va después del arranque de la corrida, que se anota con el reloj real
const T = (seg) => new Date(Date.now() + 60000 + seg * 1000).toISOString();

// El tope de estas pruebas: 2 vueltas, puesto por el repo (commiteado). El de fábrica (3) lo mide Cap_Default_Three.
const TOPE_DOS = 'review:\n  max_rounds: 2\n';

/** Un repo con una story, la carpeta de la corrida y su marcador en una HOME propia. `advisorsYaml: null`: sin el archivo. */
function laboratorio({ findings = null, fotos = [], servidas = [], advisorsYaml = TOPE_DOS, org = null } = {}) {
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
  lab.reloop = (iter, extra = [], envExtra = {}, { ventana = false } = {}) => spawnSync(process.execPath,
    [PIPELINE, 'smart-reloop', '--iter', String(iter), '--repo', repo, '--story', story, '--files', 'src/a.js', ...extra],
    { encoding: 'utf8', env: ventana ? conVentana({ ...env, ...envExtra }) : { ...env, ...envExtra } });
  lab.cmd = (bin, args, envExtra = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: repo, env: { ...env, ...envExtra } });
  lab.foto = (n) => { const m = JSON.parse(fs.readFileSync(markerFile, 'utf8')); m.iterations[n] = { ts: new Date().toISOString(), files: {} }; fs.writeFileSync(markerFile, JSON.stringify(m)); };
  // el ajuste viejo de la máquina: un archivo en la carpeta de estado, que ya no sube el tope
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
  // con los revisores de la 2 lanzados, el pedido siguiente es la 3, como siempre: al tope de 2, lo dice
  lab.foto(2);
  const c = lab.reloop(2);
  assert.equal(c.status, 3, c.stderr);
  assert.match(c.stderr, /vuelta 3/i);
});

test('Cap_MachineFile_IgnoredAndSaidOnce (T58) @story-8.221 @ac-46', () => {
  // el ajuste por máquina ya no existe: el archivo viejo no sube el tope, y se dice una sola vez
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2] });
  lab.maquina(6);
  const rr = () => JSON.parse(lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo, '--json']).stdout);
  const a = rr();
  assert.deepEqual([a.tope, a.tope_de], [2, 'repo']);
  assert.match(a.problemas.join(' '), /review-max-rounds\.json.*ya no existe y se ignora/);
  assert.doesNotMatch(rr().problemas.join(' '), /review-max-rounds/, 'una sola vez');
  assert.equal(gates(lab).filter((g) => g.name === 'review-cap-machine-ignored').length, 1);
  const r = lab.reloop(3);
  assert.equal(r.status, 3, 'el archivo no sube el tope');
  assert.match(r.stderr, /tope de 2 vueltas/);
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
  const c = lab.cmd(MARKER, ['clear', '--discard']);
  assert.match(c.stdout + c.stderr, /en 2 iteración/, 'el costo del run cuenta las vueltas con revisores');
});

// El laboratorio tiene cambios sin el ok de guardar: el cierre es `clear --discard`, que vuelca el costo igual.
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
  const c = lab.cmd(MARKER, ['clear', '--discard']);
  assert.match(c.stdout + c.stderr, /costo del run: 2 agentes/, c.stderr);
  assert.equal(costoDelVolcado(lab).spawns, 2);
});

test('RunCost_AdhocAfterStart_Counts @story-7.49 @ac-2', () => {
  const lab = laboratorio({ fotos: [1] });
  registro(lab, [{ ts: antes(), advisor: 'Explore' }, { ts: despues(), advisor: 'Explore' }, { ts: despues(), advisor: 'tycon-story-validator', story: '9.8' }]);
  lab.cmd(MARKER, ['clear', '--discard']);
  const costo = costoDelVolcado(lab);
  assert.deepEqual([costo.spawns, costo.adhoc], [2, 1]);
});

test('RunCost_NoTimestamp_Said @story-7.49 @ac-3', () => {
  const lab = laboratorio({ fotos: [1] });
  registro(lab, [{ advisor: 'tycon-story-validator', story: '9.8' }, { ts: 'no es una hora', advisor: 'Explore' }, { event: 'step5-start' },
    // sin hora pero de otra story: no es de esta corrida, ni para contarla como «sin hora»
    { advisor: 'tycon-story-validator', story: '9.7' }, '{ esto no es JSON',
    { ts: despues(), advisor: 'tycon-story-validator', story: '9.8' }]);
  lab.cmd(MARKER, ['clear', '--discard']);
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
  lab.cmd(MARKER, ['clear', '--discard']);
  const costo = costoDelVolcado(lab);
  assert.equal(costo.spawns, 1);
  assert.equal(costo.sin_arranque, true);
});

test('Cap_OrgBadPrefixElement_DropsTheList (T58) @story-8.221 @ac-46 — un elemento malo de blocking_prefixes no queda contando', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rounds-prefijos-')));
  try {
    const arbol = path.join(base, 'arbol');
    fs.mkdirSync(arbol); fs.mkdirSync(path.join(base, 'home'));
    const acme = (repo) => ({ platform: 'github', org: 'acme', repo });
    fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify({ version: 1, public: acme('harness'), profile: acme('team-profile'), operations: acme('team-operations'),
      review: { max_rounds: 2, blocking_prefixes: ['PAGOS', 'datos'] } }));
    fs.symlinkSync(path.join(SCRIPTS, '..', '..', '..', 'scripts'), path.join(arbol, 'scripts'));
    const RR = require(path.join(SCRIPTS, 'lib', 'review-rounds.js'));
    const p = RR.prefijos({ env: { ...process.env, TYCON_GUIDES_DIR: arbol }, home: path.join(base, 'home') });
    assert.match(p.problems.join(' '), /blocking_prefixes\.1/);
    // la lista con un elemento malo cae entera: «datos» (DATOS-C1) no frena como seguridad, y PAGOS tampoco queda
    assert.equal(RR.clase('DATOS-C1', { prefijos: p }), null);
    assert.ok(!p.seguridad.includes('PAGOS'), JSON.stringify(p.seguridad));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('Cap_Default_Three @story-7.37 @ac-3 @story-8.221 @ac-46', () => {
  const lab = laboratorio({ fotos: [1, 2, 3], servidas: [1, 2, 3], advisorsYaml: null });
  const r = lab.reloop(4);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /tope de 3 vueltas/);
  assert.match(r.stderr, /no quedó nada abierto|quedó abierto/i);
  // una variable de ambiente antepuesta al comando (la podría poner el propio agente) no sube el tope
  const v = lab.reloop(4, [], { TYCON_REVIEW_MAX_ROUNDS: '99' });
  assert.equal(v.status, 3);
  assert.match(v.stderr, /tope de 3 vueltas/);
});

test('Cap_OrgAndRepo_RepoWins_BadValueSaid @story-7.37 @ac-4', () => {
  const rr = (lab) => JSON.parse(lab.cmd(PIPELINE, ['review-rounds', '--story', lab.story, '--repo', lab.repo, '--json']).stdout);
  const org = laboratorio({ org: { max_rounds: 3 }, advisorsYaml: null });
  assert.deepEqual([rr(org).tope, rr(org).tope_de], [3, 'organizacion']);
  const repo = laboratorio({ org: { max_rounds: 3 }, advisorsYaml: 'review:\n  max_rounds: 2\n' });
  assert.deepEqual([rr(repo).tope, rr(repo).tope_de], [2, 'repo']);
  // el tope se baja, no se sube: 4 y 9 no se usan y se dice
  for (const v of ['4', '9']) {
    const m = rr(laboratorio({ org: { max_rounds: 3 }, advisorsYaml: `review:\n  max_rounds: ${v}\n` }));
    assert.deepEqual([m.tope, m.tope_de], [3, 'organizacion'], v);
    assert.match(m.problemas.join(' '), /max_rounds.*de 1 a 3.*no se usa/, v);
  }
  const org4 = rr(laboratorio({ org: { max_rounds: 4 }, advisorsYaml: null }));
  assert.deepEqual([org4.tope, org4.tope_de], [3, 'fabrica']);
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

// ── La vuelta extra pedida para otra sesión ───────────────────────────────────────────────────────────────────────────
//
// La coordinadora corre `smart-reloop --extra-round --for-session <D>`: el pedido lo arma `decidir` de verdad con el
// evento de la coordinadora, y el guion lo verifica de verdad con el árbol de procesos de la prueba (window-passed.js).

const ow = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'lib', 'owner-window.js'));
const { arbolDelFreno, arbolDelGuion } = require(path.join(SCRIPTS, '..', '..', '..', 'scripts', 'tests', 'lib', 'window-passed.js'));
const COORD = 'ses-coord';
// stable-data: el pedido se registra con esta hora y el guion lo verifica un minuto después
const AHORA = Date.now();

/** La vuelta `iter` pedida por la coordinadora para la sesión del laboratorio; `pedir`: que el freno arme el pedido antes. */
function vueltaParaOtra(lab, iter, extra, { pedir = true, sesion = COORD } = {}) {
  const args = [PIPELINE, 'smart-reloop', '--iter', String(iter), '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js', ...extra];
  const cmd = `node ${args.join(' ')}`;
  if (pedir) {
    const p = ow.decidir({ evento: { session_id: COORD, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command: cmd } },
      escapes: [], arbol: arbolDelFreno(), pid: 201, casa: lab.home, ahora: AHORA, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null, comprobar: () => null });
    assert.equal(p.decision, 'ask', p.texto);
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8',
    env: conVentana({ ...lab.env, CLAUDE_CODE_SESSION_ID: sesion }, { arbol: { arbol: arbolDelGuion(lab.home, cmd), pid: 301, ahora: AHORA + 60000 } }) });
}
const vigentes = (lab) => { try { return fs.readdirSync(ow.carpeta(lab.home)).filter((f) => f.endsWith('.json')); } catch (_) { return []; } };

test('VueltaExtra_ForSession_SinFirmaPendiente_NoSirve @story-8.142 @ac-2', () => {
  // dentro del tope no hay firma que dar: otra sesión no saca el set de la corrida ajena por este camino
  const lab = laboratorio({ fotos: [1], servidas: [1] });
  const r = vueltaParaOtra(lab, 2, ['--extra-round', '--for-session', SID]);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /La vuelta 2 está dentro del tope de 2/);
  assert.deepEqual(lab.servidas(), [1], 'no anotó una vuelta servida');
  assert.equal(vigentes(lab).length, 1, 'el pedido sigue sin gastar');
  // una sesión sin marcador abierto: sale 2 antes de la firma
  const otra = vueltaParaOtra(laboratorio({ fotos: [1, 2], servidas: [1, 2] }), 3, ['--extra-round', '--for-session', 'ses-z'], { pedir: false });
  assert.equal(otra.status, 2, otra.stdout + otra.stderr);
  assert.match(otra.stderr, /ses-z/);
  // sin variable de sesión y sin --terminal: sale 2 sin pasar por la firma
  const tope = laboratorio({ fotos: [1, 2], servidas: [1, 2] });
  const sinSesion = vueltaParaOtra(tope, 3, ['--extra-round', '--for-session', SID], { pedir: false, sesion: '' });
  assert.equal(sinSesion.status, 2, sinSesion.stdout + sinSesion.stderr);
  assert.match(sinSesion.stderr, /--terminal/);
  // un marcador que no se puede leer no es «sin ejecución abierta», y el registro no se gasta
  fs.writeFileSync(path.join(tope.state, 'active', 'ses-rota.json'), '{ no es json');
  const rota = vueltaParaOtra(tope, 3, ['--extra-round', '--for-session', 'ses-rota']);
  assert.equal(rota.status, 2, rota.stdout + rota.stderr);
  assert.match(rota.stderr, /no pude leer/);
  assert.equal(vigentes(tope).length, 1, 'el pedido sigue sin gastar');
  // la corrida de la sesión destino es de otra historia que --story: sale 2 sin gastar el registro
  fs.writeFileSync(path.join(tope.state, 'active', 'ses-otra.json'), JSON.stringify({ storyId: '7.7', sessionId: 'ses-otra', startedAt: new Date().toISOString() }));
  const ajena = vueltaParaOtra(tope, 3, ['--extra-round', '--for-session', 'ses-otra']);
  assert.equal(ajena.status, 2, ajena.stdout + ajena.stderr);
  assert.match(ajena.stderr, /7\.7/);
  assert.equal(vigentes(tope).length, 2, 'ningún pedido gastado');
  assert.ok(!gates(tope).some((g) => g.name === 'extra-round'));
});

// ── El chequeo antes de la ventana ────────────────────────────────────────────────────────────────────────────────────
//
// El freno corre el guion en modo de chequeo antes de abrir la ventana: si se negaría, no la abre. Cada requisito de la
// vuelta extra con su prueba: dentro del tope, ya autorizada y, desde la tercera, sin su nota de repensar.

/** El pedido de la ventana de la sesión de la corrida, con el chequeo de verdad en la HOME del laboratorio. */
function pedirConChequeo(lab, iter, extra = []) {
  const cmd = `node ${[PIPELINE, 'smart-reloop', '--iter', String(iter), '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js', '--extra-round', ...extra].join(' ')}`;
  return ow.decidir({ evento: { session_id: SID, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command: cmd }, cwd: lab.repo },
    escapes: [], arbol: arbolDelFreno(), pid: 201, casa: lab.home, ahora: AHORA, delegacion: () => ({ ok: false, motivo: 'sin delegación en la prueba' }), clasificar: () => null,
    comprobar: (o) => ow.comprobarConElGuion({ ...o, env: lab.env }) });
}
const NOTA = ['--repeated', 'El mismo hallazgo de seguridad en las dos vueltas sobre el mismo archivo',
  '--change', 'Cambia el enfoque: la validación pasa a la entrada del endpoint, antes de tocar la base'];

// 🔴 Falla con: la ventana para una vuelta que no necesita firma (dentro del tope), o el guion que la sirve igual.
test('Precheck_VueltaExtraDentroDelTope_NoAbreLaVentana', () => {
  const lab = laboratorio({ fotos: [1], servidas: [1] });
  const p = pedirConChequeo(lab, 2);
  assert.equal(p.decision, 'deny', p.texto);
  assert.match(p.texto, /No abrí la ventana/);
  assert.match(p.texto, /no necesita la vuelta extra/);
  assert.equal(vigentes(lab).length, 0, 'sin pedido');
  // el guion solo, aunque llegue la firma, tampoco la gasta
  const r = lab.reloop(2, ['--extra-round'], {}, { ventana: true });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /no necesita la vuelta extra/);
  assert.deepEqual(lab.servidas(), [1]);
  assert.ok(!gates(lab).some((g) => /^extra-round/.test(g.name)), 'sin firma ni vuelta anotada');
});

// ── La vuelta dentro del tope pedida para otra sesión dice el tope (8.271) ────────────────────────────────────────────
//
// «No se pide para otra sesión» se leía como «--for-session está prohibido». Lo que pasa es que la vuelta no necesita
// firma: está dentro del tope, o la vuelta extra ya está autorizada. El mensaje lo dice y dice quién la pide.

test('VueltaExtra_ForSession_DentroDelTope_DiceElTope @story-8.271 @ac-4', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2], advisorsYaml: 'review:\n  max_rounds: 3\n' });
  const r = vueltaParaOtra(lab, 3, ['--extra-round', '--for-session', SID]);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /La vuelta 3 está dentro del tope de 3: no necesita la vuelta extra ni la firma/);
  assert.match(r.stderr, /la sesión de la corrida, con el set sin --extra-round ni --for-session/);
  assert.doesNotMatch(r.stderr, /no se pide para otra sesión/);
  assert.deepEqual(lab.servidas(), [1, 2], 'no sirvió el set');
  assert.equal(vigentes(lab).length, 1, 'el pedido sigue sin gastar');
});

// ── La vuelta extra para otra sesión sale de la corrida de esa sesión (8.272) ────────────────────────────────────────
//
// La coordinadora corre el comando desde su propia carpeta: el repo, la historia y los archivos salen del marcador de la
// sesión destino, no del directorio de trabajo. Sin esa corrida, o sin lo que hace falta de ella, sale 2 sin armar nada.

/** La vuelta `iter` pedida desde `cwd` (la carpeta de la coordinadora), sólo con los argumentos de `extra`. */
function vueltaDesdeOtraCarpeta(lab, cwd, iter, extra, { pedir = true, delegada = false } = {}) {
  const args = [PIPELINE, 'smart-reloop', '--iter', String(iter), ...extra];
  const cmd = `node ${args.join(' ')}`;
  if (pedir) {
    const p = ow.decidir({ evento: { session_id: COORD, tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command: cmd }, cwd },
      escapes: [], arbol: arbolDelFreno(), pid: 201, casa: lab.home, ahora: AHORA, clasificar: () => null, comprobar: () => null,
      delegacion: () => (delegada ? { ok: true, maquina: 'm-prueba' } : { ok: false, motivo: 'sin delegación en la prueba' }) });
    assert.deepEqual([p.decision, p.via], delegada ? ['allow', 'delegacion'] : ['ask', undefined], p.texto);
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd,
    env: conVentana({ ...lab.env, CLAUDE_CODE_SESSION_ID: COORD }, delegada ? { delegadaPor: COORD } : { arbol: { arbol: arbolDelGuion(lab.home, cmd), pid: 301, ahora: AHORA + 60000 } }) });
}
/** El laboratorio al tope, con la nota de la tercera vuelta y lo que tocó la corrida (uno en el repo, uno fuera). */
function alTopeConNota({ marcador = {} } = {}) {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2], findings: [hallazgo('SEC-C1', 'CRITICAL', 'open')] });
  assert.equal(lab.reloop(3).status, 3);
  const nota = lab.cmd(MARKER, ['rethink', '--iter', '3', '--repeated', 'El mismo hallazgo de seguridad en las dos vueltas sobre el mismo archivo',
    '--change', 'Cambia el enfoque: la validación pasa a la entrada del endpoint, antes de tocar la base', '--repo', lab.repo, '--story', lab.story]);
  assert.equal(nota.status, 0, nota.stderr);
  const m = JSON.parse(fs.readFileSync(lab.markerFile, 'utf8'));
  Object.assign(m, { filesTouched: [path.join(lab.repo, 'src', 'a.js'), path.join(os.tmpdir(), 'fuera-del-repo.js')] }, marcador);
  for (const [k, v] of Object.entries(marcador)) if (v === undefined) delete m[k];
  fs.writeFileSync(lab.markerFile, JSON.stringify(m));
  return lab;
}

test('T16 ExtraRound_ForSessionWithoutMarker_Exit2 @story-8.272 @ac-17 @ac-18', () => {
  const coord = tmp('rr-coord-');
  const lab = alTopeConNota();
  // sin marcador: «no encontré la corrida» con el motivo, salida 2, sin servir nada
  const sin = vueltaDesdeOtraCarpeta(lab, coord, 3, ['--extra-round', '--for-session', 'ses-z'], { pedir: false });
  assert.equal(sin.status, 2, sin.stdout + sin.stderr);
  assert.match(sin.stderr, /no encontré la corrida de la sesión ses-z/i);
  assert.match(sin.stderr, /no está su marcador/);
  // marcador ilegible: lo mismo, con su motivo
  fs.writeFileSync(path.join(lab.state, 'active', 'ses-rota.json'), '{ no es json');
  const rota = vueltaDesdeOtraCarpeta(lab, coord, 3, ['--extra-round', '--for-session', 'ses-rota'], { pedir: false });
  assert.equal(rota.status, 2, rota.stdout + rota.stderr);
  assert.match(rota.stderr, /no encontré la corrida de la sesión ses-rota/i);
  assert.match(rota.stderr, /no pude leer/);
  // la corrida no dice su repo y no vino --repo: sale 2 diciendo qué falta
  const sinRepo = alTopeConNota({ marcador: { repoPath: undefined } });
  const r3 = vueltaDesdeOtraCarpeta(sinRepo, coord, 3, ['--extra-round', '--for-session', SID], { pedir: false });
  assert.equal(r3.status, 2, r3.stdout + r3.stderr);
  assert.match(r3.stderr, /no dice su repo.*--repo/);
  // la corrida no tocó archivos en ese repo y no vino --files: sale 2 diciendo qué falta
  const sinArchivos = alTopeConNota({ marcador: { filesTouched: [path.join(os.tmpdir(), 'fuera-del-repo.js')] } });
  const r4 = vueltaDesdeOtraCarpeta(sinArchivos, coord, 3, ['--extra-round', '--for-session', SID], { pedir: false });
  assert.equal(r4.status, 2, r4.stdout + r4.stderr);
  assert.match(r4.stderr, /no tocó archivos en .*--files/);
  for (const l of [lab, sinRepo, sinArchivos]) assert.deepEqual(l.servidas(), [1, 2], 'ninguna vuelta armada');
  // un marcador legible sin historia: el texto de hoy, también con salida 2
  fs.writeFileSync(path.join(lab.state, 'active', 'ses-sin.json'), JSON.stringify({ sessionId: 'ses-sin', startedAt: new Date().toISOString() }));
  const sinHistoria = vueltaDesdeOtraCarpeta(lab, coord, 3, ['--extra-round', '--for-session', 'ses-sin'], { pedir: false });
  assert.equal(sinHistoria.status, 2, sinHistoria.stdout + sinHistoria.stderr);
  assert.match(sinHistoria.stderr, /no tiene una ejecución abierta/);
});

// Regresión del pase adversarial de la 8.272 B: el código de la corrida vive en el repo hermano de la historia, una
// --story relativa se lee contra el repo de la corrida, y lo que la corrida tocó y ya no está (un probe del pase, un
// archivo borrado) no tumba la vuelta

// ── Después del tope no hay vuelta extra ─────────────────────────────────────────────────
//
// Caso: dos historias de un producto hicieron 7 y 10 vueltas de revisores, cada una pedida con una vuelta extra firmada
// (muchas por delegación). Ahora el tope es fijo y no se sube: con algo de seguridad o de datos abierto en la última, la
// persona lo exime o abre una historia de arreglo; lo demás queda como deuda.

test('Cap_SecurityCritical_WaiveOrFixStory_NoExtraRound', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2], findings: [hallazgo('SEC-C1', 'CRITICAL', 'open'), hallazgo('TEST-W2', 'WARNING', 'open')] });
  const r = lab.reloop(3);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /SEC-C1/);
  assert.match(r.stderr, /seguridad o (de )?datos/);
  assert.match(r.stderr, /historia de arreglo/);
  assert.match(r.stderr, /waive-critical/);
  assert.doesNotMatch(r.stderr, /--extra-round|--for-session/, 'no ofrece la vuelta extra');
  // pedida igual, con la ventana, delegada o con nota de repensar: se niega y no se anota nada
  assert.equal(lab.cmd(MARKER, ['rethink', '--iter', '3', ...NOTA, '--repo', lab.repo, '--story', lab.story]).status, 0);
  for (const extra of [['--extra-round'], ['--extra-round', '--delegated'], ['--extra-round', '--approved-by', 'Dev de Prueba']]) {
    const x = lab.reloop(3, extra, {}, { ventana: true });
    assert.equal(x.status, 3, `${extra.join(' ')}: ${x.stdout}${x.stderr}`);
    assert.match(x.stderr, /la vuelta extra de revisores ya no existe/);
  }
  assert.deepEqual(lab.servidas(), [1, 2], 'no sirvió la vuelta');
  assert.ok(!gates(lab).some((g) => /^extra-round/.test(g.name)), 'ni firma ni vuelta anotada');
  // una vuelta extra autorizada antes del cambio tampoco se sirve
  fs.appendFileSync(path.join(lab.state, 'gates.log'), `${JSON.stringify({ ts: new Date().toISOString(), name: 'extra-round', status: 'ok', story: '9.8', iter: 3 })}\n`);
  const vieja = lab.reloop(3);
  assert.equal(vieja.status, 3, vieja.stdout + vieja.stderr);
  assert.deepEqual(lab.servidas(), [1, 2]);
});

// 🔴 Falla con: la ventana abierta para una vuelta que el guion va a negar (el «Sí» se perdería).
test('Precheck_ExtraRoundPastTheCap_WindowDoesNotOpen', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2], findings: [hallazgo('SEC-C1', 'CRITICAL', 'open')] });
  assert.equal(lab.cmd(MARKER, ['rethink', '--iter', '3', ...NOTA, '--repo', lab.repo, '--story', lab.story]).status, 0);
  const p = pedirConChequeo(lab, 3);
  assert.equal(p.decision, 'deny', p.texto);
  assert.match(p.texto, /No abrí la ventana/);
  assert.match(p.texto, /ya no existe/);
  assert.equal(vigentes(lab).length, 0, 'sin pedido');
  // pedida para otra sesión, tampoco: sale sin escribir
  const r = vueltaParaOtra(lab, 3, ['--extra-round', '--for-session', SID], { pedir: false });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /ya no existe/);
  assert.deepEqual(lab.servidas(), [1, 2], 'no sirvió el set');
  assert.ok(!gates(lab).some((g) => /^extra-round/.test(g.name)));
});
