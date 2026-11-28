'use strict';
/**
 * review-cap-holes.test.js — las tres formas de sacar una vuelta de revisores más allá del tope sin una persona:
 * pedir el set desde otra sesión (o sin el marcador de la corrida), lanzar los revisores a mano con la herramienta de
 * agentes, y pedir la misma vuelta otra vez después de lanzar revisores o de cambiar archivos.
 *
 * Corre pipeline.js y el gancho de lanzamientos de verdad sobre una corrida de juguete, con HOME temporal. 0 deps.
 */
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
// el que anota los lanzamientos (en los dos perfiles) y el freno del tope (sólo en el completo)
const HOOK = path.join(SCRIPTS, 'on-advisor-run.js');
const FRENO = path.join(SCRIPTS, 'on-advisor-cap.js');
const SID = 'test-holes';
const RUN = '9.8-20261020000000';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const FECHA = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const HACE = (seg) => new Date(Date.now() - seg * 1000).toISOString();

/** Un repo con una story y su corrida al tope de fábrica (3), con el marcador de la sesión en una HOME propia. */
function laboratorio({ fotos = [1, 2, 3], servidas = [1, 2, 3], abierta = true } = {}) {
  const repo = tmp('rch-repo-');
  const home = tmp('rch-home-');
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, ...FECHA } });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), '// base\n');
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, ['---', 'story: 9.8', 'epic: 9', 'status: in-progress', '---', '', '## Acceptance Criteria', '- AC1: x', ''].join('\n'));
  const run = path.join(repo, '.advisors', 'pipeline-runs', RUN);
  fs.mkdirSync(path.join(run, 'rethink'), { recursive: true });
  // la nota de la vuelta 3: sin ella el pedido de la 3 frena antes de llegar al tope
  fs.writeFileSync(path.join(run, 'rethink', 'iter-3.json'), JSON.stringify({ iter: 3,
    repeated: 'los mismos avisos de manejo de errores en src/a.js, vuelta tras vuelta',
    keep: 'el enfoque sigue igual porque los avisos son de un archivo que la historia no cambia' }));
  const served = path.join(run, 'rethink', 'served.json');
  if (servidas.length) {
    fs.writeFileSync(served, JSON.stringify({ served: servidas }));
    // la última vuelta se sirvió hace diez minutos
    const t = new Date(Date.now() - 600000);
    fs.utimesSync(served, t, t);
  }
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'base');
  // la carpeta de trabajo tiene cambios: si no, el freno de la carpeta vacía corta antes
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), '// cambio\n');
  const state = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const iterations = {};
  for (const n of fotos) iterations[n] = { ts: HACE(900 - n), files: {} };
  const markerFile = path.join(state, 'active', `${SID}.json`);
  fs.writeFileSync(markerFile, JSON.stringify({ storyId: '9.8', storyPath: story, repoPath: repo, sessionId: SID,
    startedAt: HACE(3600), stepsCompleted: [0, 1, 2, 3, 4, 5, 6, 7], stepsPending: [8], iterations, fileEvents: [], checks: {} }));
  if (abierta) {
    fs.appendFileSync(path.join(state, 'gates.log'), `${JSON.stringify({ ts: HACE(3600), sessionId: SID, name: 'run-open', sesion: SID, story: '9.8', storyPath: story, repo, runDir: run })}\n`);
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: SID, TYCON_TODAY: '2026-10-20', TYCON_LANE_LLM: '0' };
  for (const k of ['TYCON_REVIEW_MAX_ROUNDS', 'TYCON_GUIDES_DIR', 'NODE_TEST_CONTEXT', 'TYCON_SPAWN_GOVERNANCE']) delete env[k];
  const lab = { repo, home, story, run, served, state, markerFile, env };
  lab.pipeline = (args, envExtra = {}) => spawnSync(process.execPath, [PIPELINE, ...args], { encoding: 'utf8', cwd: repo, env: { ...env, ...envExtra } });
  const gancho = (archivo, agente, envExtra) => spawnSync(process.execPath, [archivo], {
    encoding: 'utf8', cwd: repo, env: { ...env, ...envExtra },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: SID, cwd: repo, tool_input: { subagent_type: agente, prompt: 'revisá' } }),
  });
  // los dos ganchos del lanzamiento, como en el perfil completo: si el freno niega, lo que se ve es su salida
  lab.hook = (agente, envExtra = {}) => {
    const freno = gancho(FRENO, agente, envExtra);
    const anota = gancho(HOOK, agente, envExtra);
    return freno.status === 2 ? freno : anota;
  };
  lab.soloAnota = (agente, envExtra = {}) => gancho(HOOK, agente, envExtra);
  lab.marcador = (cambio) => { const m = JSON.parse(fs.readFileSync(markerFile, 'utf8')); cambio(m); fs.writeFileSync(markerFile, JSON.stringify(m)); };
  lab.registro = (lineas) => {
    fs.mkdirSync(path.join(state, 'advisor-runs'), { recursive: true });
    fs.appendFileSync(path.join(state, 'advisor-runs', `${SID}.jsonl`), lineas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  lab.gates = () => { try { return fs.readFileSync(path.join(state, 'gates.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
  return lab;
}

// ── 1. Sin el marcador de la corrida ────────────────────────────────────────────────────────────────────────────────

test('CapHoles_OtherSessionNoStory_Blocked (T1)', () => {
  const lab = laboratorio();
  const r = lab.pipeline(['advisors', '--repo', lab.repo, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(r.status, 3, `otra sesión saca el set completo de una corrida al tope: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /sesión de la corrida/);
});

test('CapHoles_OtherSessionCopiedStory_Blocked (T2)', () => {
  const lab = laboratorio();
  const copia = path.join(lab.repo, 'copia.md');
  fs.writeFileSync(copia, fs.readFileSync(lab.story, 'utf8').replace('story: 9.8', 'story: 9.99'));
  const r = lab.pipeline(['advisors', '--repo', lab.repo, '--story', copia, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(r.status, 3, `una copia de la historia con otro número saca el set: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /sesión de la corrida/);
});

test('CapHoles_OtherSessionDeletedServed_Blocked (T3)', () => {
  const lab = laboratorio();
  fs.unlinkSync(lab.served);
  const r = lab.pipeline(['smart-reloop', '--iter', '1', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(r.status, 3, `otra sesión, sin served.json: ${r.stdout.slice(0, 200)}`);
});

test('CapHoles_OwnSessionNoOpenRunOfOthers_Passes (T4)', () => {
  // sin corridas abiertas de otra sesión en el repo, fuera de una corrida la vuelta 1 pasa como siempre
  const lab = laboratorio({ abierta: false, servidas: [] });
  const r = lab.pipeline(['advisors', '--repo', lab.repo, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(r.status, 0, r.stderr);
});

test('CapHoles_DeletedServed_MirrorKeepsCount (T5)', () => {
  // la corrida ya cerró (sin apertura vigente): borrar served.json no baja la cuenta, que también queda fuera del repo
  const lab = laboratorio({ abierta: false, servidas: [], fotos: [] });
  const a = lab.pipeline(['smart-reloop', '--iter', '1', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(a.status, 0, a.stderr);
  const espejo = lab.gates().filter((g) => g.name === 'review-served');
  assert.equal(espejo.length, 1, 'la vuelta servida queda anotada fuera del repo');
  assert.equal(espejo[0].iter, 1);
  // tres vueltas servidas en el registro de fuera del repo, y served.json borrado
  for (const n of [2, 3]) fs.appendFileSync(path.join(lab.state, 'gates.log'), `${JSON.stringify({ ts: HACE(60), name: 'review-served', runDir: lab.run, iter: n })}\n`);
  fs.unlinkSync(lab.served);
  const b = lab.pipeline(['smart-reloop', '--iter', '1', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(b.status, 3, `borrar served.json bajó la cuenta: ${b.stdout.slice(0, 200)}`);
  assert.match(b.stderr, /tope de 3/);
});

test('CapHoles_OtherSessionSubfolderRepo_Blocked (T13)', () => {
  // --repo en una subcarpeta del repo es el mismo repo
  const lab = laboratorio();
  const r = lab.pipeline(['advisors', '--repo', path.join(lab.repo, 'src'), '--files', 'a.js'], { CLAUDE_CODE_SESSION_ID: 'otra-sesion' });
  assert.equal(r.status, 3, `una subcarpeta del repo saca el set: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /sesión de la corrida/);
});

test('CapHoles_OtherSessionWithOwnMarker_Blocked (T14)', () => {
  // una sesión con su propio marcador, de otra historia en otro repo, tampoco usa la corrida al tope de esta
  const lab = laboratorio();
  const otro = tmp('rch-otro-');
  fs.writeFileSync(path.join(otro, 'story.md'), '---\nstory: 1.1\n---\n');
  fs.writeFileSync(path.join(lab.state, 'active', 'sesion-b.json'), JSON.stringify({ storyId: '1.1', storyPath: path.join(otro, 'story.md'), repoPath: otro, sessionId: 'sesion-b', iterations: {} }));
  const r = lab.pipeline(['smart-reloop', '--iter', '1', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'sesion-b' });
  assert.equal(r.status, 3, `otra sesión con marcador propio saca el set: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /sesión de la corrida/);
});

test('CapHoles_OwnSessionCopiedStory_Blocked (T18)', () => {
  // la misma sesión, con las fotos en una sola clave, pide el set con una copia de la historia con otro número
  const lab = laboratorio({ fotos: [1] });
  const copia = path.join(lab.repo, 'copia.md');
  fs.writeFileSync(copia, fs.readFileSync(lab.story, 'utf8').replace('story: 9.8', 'story: 9.99'));
  const r = lab.pipeline(['advisors', '--repo', lab.repo, '--story', copia, '--files', 'src/a.js']);
  assert.equal(r.status, 3, `la propia sesión saca el set con una copia de la historia: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /otra historia/);
});

test('CapHoles_NestedWorktreeRunOfOther_DoesNotBlockMain (T15)', () => {
  // una corrida de otra sesión en una copia de trabajo anidada es de otro repo: no frena el principal
  const lab = laboratorio({ abierta: false, servidas: [] });
  const wt = path.join(lab.repo, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nada\n');
  fs.appendFileSync(path.join(lab.state, 'gates.log'), `${JSON.stringify({ ts: HACE(60), name: 'run-open', sesion: 'otra', story: '1.1', repo: wt, runDir: path.join(wt, '.advisors', 'pipeline-runs', '1.1-x') })}\n`);
  const r = lab.pipeline(['advisors', '--repo', lab.repo, '--files', 'src/a.js'], { CLAUDE_CODE_SESSION_ID: 'tercera' });
  assert.equal(r.status, 0, r.stderr);
});

// ── 2. Lanzar los revisores a mano ──────────────────────────────────────────────────────────────────────────────────

test('CapHoles_ManualLaunchAtCap_Denied (T6)', () => {
  const lab = laboratorio();
  const r = lab.hook('tycon-plugin-security-basics');
  assert.equal(r.status, 2, `el lanzamiento a mano de un revisor al tope pasa: ${r.stderr}`);
  assert.match(r.stderr, /tope de 3 vueltas/);
  assert.ok(lab.gates().some((g) => g.name === 'review-cap-launch-denied' && g.advisor === 'tycon-plugin-security-basics'), 'el freno queda anotado');
  let lanzados = [];
  try { lanzados = fs.readFileSync(path.join(lab.state, 'advisor-runs', `${SID}.jsonl`), 'utf8').split('\n').filter(Boolean); } catch (_) { lanzados = []; }
  assert.equal(lanzados.length, 0, 'un lanzamiento negado no se registra como lanzado');
});

test('CapHoles_PerfilMinimo_SinFreno_NoCuentaComoLanzado (T20)', () => {
  // sin el freno (perfil mínimo), el que anota deja correr al revisor pero no lo anota: no cuenta como revisado
  const lab = laboratorio();
  const r = lab.soloAnota('tycon-plugin-security-basics');
  assert.equal(r.status, 0, 'el que anota nunca bloquea');
  let lanzados = [];
  try { lanzados = fs.readFileSync(path.join(lab.state, 'advisor-runs', `${SID}.jsonl`), 'utf8').split('\n').filter(Boolean); } catch (_) { lanzados = []; }
  assert.equal(lanzados.length, 0, 'el lanzamiento fuera de la vuelta abierta no se registra');
  assert.ok(!lab.gates().some((g) => g.name === 'review-cap-launch-denied'), 'sin el freno, no se anota un freno');
});

test('CapHoles_ManualLaunchNotReviewer_Allowed (T7)', () => {
  const lab = laboratorio();
  for (const a of ['tycon-story-validator', 'general-purpose', 'tycon-dod-runtime-checker', 'frontend-design']) {
    const r = lab.hook(a);
    assert.equal(r.status, 0, `${a}: ${r.stderr}`);
  }
});

test('CapHoles_ManualLaunchBelowCap_Allowed (T8)', () => {
  const lab = laboratorio({ fotos: [1, 2], servidas: [1, 2] });
  const r = lab.hook('tycon-plugin-security-basics');
  assert.equal(r.status, 0, r.stderr);
});

test('CapHoles_ManualLaunchOpenRoundAtCap_Allowed (T12)', () => {
  // con la foto ya tomada al servir la vuelta, sus propios revisores pasan una vez; relanzarlo es una vuelta más
  const lab = laboratorio();
  lab.registro([{ ts: HACE(30), event: 'step5-start', expected: ['tycon-plugin-security-basics', 'tycon-plugin-tests-coverage'], iter: 3 }]);
  const a = lab.hook('tycon-plugin-security-basics');
  assert.equal(a.status, 0, a.stderr);
  const b = lab.hook('tycon-plugin-security-basics');
  assert.equal(b.status, 2, 'el mismo revisor otra vez en la vuelta al tope');
});

test('CapHoles_ManualLaunchServedCountWithoutPhotos_Denied (T16)', () => {
  // las fotos caen en la misma clave si las vueltas se piden sin --iter: cuentan también las servidas
  const lab = laboratorio({ fotos: [1] });
  const r = lab.hook('tycon-plugin-security-basics');
  assert.equal(r.status, 2, `con tres vueltas servidas y una sola foto, el lanzamiento a mano pasa: ${r.stderr}`);
});

test('CapHoles_ManualLaunchExtraRoundSignedByOwner_Allowed (T19)', () => {
  // la vuelta extra que firmó el dueño sigue: su revisor lanzado a mano no lo frena el tope
  const lab = laboratorio();
  fs.appendFileSync(path.join(lab.state, 'gates.log'), `${JSON.stringify({ ts: HACE(30), name: 'extra-round', status: 'ok', story: '9.8', iter: 4, quien: 'dueño', via: 'ventana' })}\n`);
  const r = lab.hook('tycon-plugin-security-basics');
  assert.equal(r.status, 0, r.stderr);
});

// ── 3. La misma vuelta pedida otra vez ──────────────────────────────────────────────────────────────────────────────

test('CapHoles_SameRoundAfterLaunch_CountsAsNew (T9)', () => {
  // la vuelta 3 se sirvió y se lanzaron revisores sin completar el set (no hay foto de la 3): pedirla otra vez es la 4
  const lab = laboratorio({ fotos: [1, 2] });
  fs.mkdirSync(path.join(lab.run, 'rethink'), { recursive: true });
  lab.registro([
    { ts: HACE(590), event: 'step5-start', expected: ['tycon-plugin-security-basics', 'tycon-plugin-tests-coverage'], iter: 3 },
    { ts: HACE(300), advisor: 'tycon-plugin-security-basics', repo: lab.repo, story: '9.8' },
  ]);
  const r = lab.pipeline(['smart-reloop', '--iter', '3', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js']);
  assert.equal(r.status, 3, `la vuelta 3 se volvió a servir con revisores ya lanzados: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /tope de 3/);
});

test('CapHoles_SameRoundAfterEdit_CountsAsNew (T10)', () => {
  const lab = laboratorio({ fotos: [1, 2] });
  lab.marcador((m) => { m.filesTouchedAt = { [path.join(lab.repo, 'src', 'a.js')]: { hash: 'x', ts: Date.now() - 60000 } }; });
  const r = lab.pipeline(['smart-reloop', '--iter', '3', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js']);
  assert.equal(r.status, 3, `la vuelta 3 se volvió a servir con archivos cambiados: ${r.stdout.slice(0, 200)}`);
  assert.match(r.stderr, /tope de 3/);
});

test('CapHoles_SameRoundAfterNonReviewerLaunch_StillSame (T17)', () => {
  // un agente que no es revisor del set (otra herramienta) no cuenta como vuelta lanzada
  const lab = laboratorio({ fotos: [1, 2] });
  lab.registro([{ ts: HACE(60), advisor: 'web-fetch', repo: lab.repo, story: '9.8' }]);
  const r = lab.pipeline(['smart-reloop', '--iter', '3', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js']);
  assert.equal(r.status, 0, r.stderr);
});

test('CapHoles_SameRoundNothingInBetween_StillSame (T11)', () => {
  // sin revisores lanzados ni archivos cambiados desde que se sirvió, sigue siendo la misma vuelta (no la frena el tope)
  const lab = laboratorio({ fotos: [1, 2] });
  const r = lab.pipeline(['smart-reloop', '--iter', '3', '--repo', lab.repo, '--story', lab.story, '--files', 'src/a.js']);
  assert.equal(r.status, 0, r.stderr);
});
