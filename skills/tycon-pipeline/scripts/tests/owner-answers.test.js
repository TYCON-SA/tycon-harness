'use strict';
/*
 * owner-answers.test.js — lo que contesta el dueño lo contesta el dueño.
 *
 * Contestar «skip» a la pregunta del pase del código pide la firma `review-skip` de la persona (su ventana, su click o
 * su «aprobado»), nunca la delegación. Las otras respuestas no piden firma. La coordinadora contesta «skip» sin firma
 * sólo con `--by-profile`, y el guion comprueba que el dueño cuenta como ausente y que la celda de «dueño ausente» de la
 * organización dice `skip` para ese diff. Corre marker.js de verdad sobre una casa de juguete.
 * Correr: node --test skills/tycon-pipeline/scripts/tests/owner-answers.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));

const SID = 'ses-oa';
const COORD = 'ses-coord-oa';

/**
 * Una casa con la ejecución de `SID` sobre un repo con un cambio chico de código, la coordinadora designada y, con
 * `celda`, la configuración de la organización con `deep_review.small_routine_owner_away` en ese valor.
 */
function laboratorio(t, { celda = null } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-answers-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(home);
  const fecha = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, ...fecha } });
  git('init', '-q'); git('config', 'user.email', 'noreply@example.com'); git('config', 'user.name', 'lab');
  const story = path.join(repo, 'specs', 'story-9.95-juguete.md');
  fs.writeFileSync(story, ['---', 'story: "9.95"', 'title: "juguete"', 'status: in-progress', 'files_to_modify:', '  - a.js', '---', '', '# Story 9.95', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 2;\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_PROFILE: '0' };
  for (const k of ['TYCON_HOME', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'TYCON_GUIDES_DIR', 'TCG']) delete env[k];
  if (celda) {
    // el árbol del arnés con la configuración de la organización: los guiones son los de este árbol
    const arbol = path.join(base, 'arbol');
    fs.mkdirSync(arbol);
    fs.symlinkSync(path.join(RAIZ, 'scripts'), path.join(arbol, 'scripts'));
    const acme = (r) => ({ platform: 'github', org: 'acme', repo: r });
    fs.writeFileSync(path.join(arbol, 'team-repos.json'), JSON.stringify({ version: 1, public: acme('harness'), profile: acme('team-profile'), operations: acme('team-operations'),
      deep_review: { small_routine_day: 'ask', small_routine_owner_away: celda } }));
    env.TYCON_GUIDES_DIR = arbol;
  }
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const lab = { base, repo, home, env, estado, story };
  lab.marker = (sid, args, ventana) => spawnSync(process.execPath, [MARKER, ...args], { cwd: repo, encoding: 'utf8', input: '',
    env: ventana ? conVentana({ ...env, CLAUDE_CODE_SESSION_ID: sid }, ventana) : { ...env, CLAUDE_CODE_SESSION_ID: sid } });
  const set = lab.marker(SID, ['set', JSON.stringify({ storyId: '9.95', storyPath: story, repoPath: repo })]);
  assert.strictEqual(set.status, 0, set.stderr);
  // la coordinadora designada y confirmada, como la deja el click del dueño
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-10-27T08:00:00.000Z', sesion: COORD, rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, '2026-10-27T08:01:00.000Z'))}\n`);
  lab.gates = () => { try { return fs.readFileSync(path.join(estado, 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
  lab.respuestas = () => lab.gates().filter((g) => g.name === 'review-answer');
  /** La marca de ausente, escrita como la deja `owner-away set`. */
  // stable-data: la marca vence a las 24 h del reloj de marker.js, que corre aparte: se pone con la hora de ahora
  lab.ausente = () => fs.writeFileSync(path.join(estado, 'owner-away.json'), JSON.stringify({ setAt: new Date().toISOString(), quien: `sesión ${COORD}`, frase: 'me voy' }));
  lab.preguntar = () => {
    const r = lab.marker(SID, ['review-ask', '--kind', 'code']);
    assert.strictEqual(r.status, 0, r.stderr);
  };
  return lab;
}

test('T20 ReviewAnswer_CodeSkip_NeedsPerson @story-8.256 @ac-19 — «skip» del código lo firma la persona, y queda su vía', (t) => {
  // el freno lo pide como firma de nivel 2; las otras respuestas y --by-profile, no
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js review-answer --kind code --choice skip')], ['review-skip']);
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js review-answer --for-session ses-a --kind code --choice skip --reason "dueño"')], ['review-skip']);
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js review-answer --kind code --choice skip --by-profile')], []);
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js review-answer --kind code --choice review')], []);
  assert.deepStrictEqual([...ow.firmasDelComando('node marker.js review-answer --kind plan --choice skip')], []);
  const cat = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
  const nivel = cat.LEVELS.find((l) => l.id === 'review-skip');
  assert.ok(nivel && nivel.level === 2, 'review-skip es de nivel 2');
  assert.match(DS.delegaSinVentana({ firma: 'review-skip', sesion: COORD, destino: SID, perfil: () => ({ delegated_signing: ['review-skip'] }) }).motivo, /no se delega/);

  const lab = laboratorio(t);
  lab.preguntar();
  const sin = lab.marker(SID, ['review-answer', '--kind', 'code', '--choice', 'skip']);
  assert.notStrictEqual(sin.status, 0, `sin la persona no se anota: ${sin.stdout}${sin.stderr}`);
  assert.strictEqual(lab.respuestas().length, 0, 'nada escrito');
  const con = lab.marker(SID, ['review-answer', '--kind', 'code', '--choice', 'skip'], { via: 'click' });
  assert.strictEqual(con.status, 0, con.stderr);
  const r = lab.respuestas();
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].choice, 'skip');
  assert.strictEqual(r[0].via, 'click', 'el renglón lleva la vía de la firma');
});

test('T21 ReviewAnswer_OtherAnswers_NoSignature @story-8.256 @ac-20 — «review», «wait» y las del plan se anotan sin firma, como hoy', (t) => {
  const lab = laboratorio(t);
  lab.preguntar();
  for (const choice of ['review', 'wait']) {
    const r = lab.marker(SID, ['review-answer', '--kind', 'code', '--choice', choice]);
    assert.strictEqual(r.status, 0, `${choice}: ${r.stderr}`);
  }
  // la del plan: con el plan escrito en la carpeta de la corrida
  const runDir = require(PIPELINE).resolveRunDir(lab.repo, '9.95', true, lab.story);
  fs.writeFileSync(path.join(runDir, 'step-02-bmad-plan.md'), '# Plan\n\n1. cambiar a.js\n');
  const plan = lab.marker(SID, ['review-answer', '--kind', 'plan', '--choice', 'skip']);
  assert.strictEqual(plan.status, 0, plan.stderr);
  assert.deepStrictEqual(lab.respuestas().map((g) => `${g.kind}:${g.choice}:${g.via || '-'}`), ['code:review:-', 'code:wait:-', 'plan:skip:-']);
});

test('T22 ReviewAnswer_ByProfile_OnlyWhenAwayAndCellSkips @story-8.256 @ac-21 — la coordinadora contesta «skip» por el perfil sólo con el dueño ausente y la celda en skip', (t) => {
  const por = ['review-answer', '--for-session', SID, '--kind', 'code', '--choice', 'skip', '--by-profile', '--reason', 'dueño ausente'];
  // celda en skip y marca de ausente puesta: anota sin firma, con por: 'perfil'
  const a = laboratorio(t, { celda: 'skip' });
  a.preguntar();
  a.ausente();
  const r = a.marker(COORD, por);
  assert.strictEqual(r.status, 0, r.stderr);
  const resp = a.respuestas();
  assert.strictEqual(resp.length, 1);
  assert.strictEqual(resp[0].por, 'perfil');
  assert.strictEqual(resp[0].choice, 'skip');
  // sin marca y con la pregunta recién hecha: el dueño no cuenta como ausente
  const b = laboratorio(t, { celda: 'skip' });
  b.preguntar();
  const rb = b.marker(COORD, por);
  assert.strictEqual(rb.status, 2, rb.stderr);
  assert.match(rb.stderr, /no cuenta como ausente/);
  assert.strictEqual(b.respuestas().length, 0);
  // la celda en run: el perfil no contesta «skip»
  const c = laboratorio(t, { celda: 'run' });
  c.preguntar();
  c.ausente();
  const rc = c.marker(COORD, por);
  assert.strictEqual(rc.status, 2, rc.stderr);
  assert.match(rc.stderr, /celda de «dueño ausente»/);
  assert.strictEqual(c.respuestas().length, 0);
  // --by-profile con otra respuesta no vale
  const rd = c.marker(COORD, ['review-answer', '--for-session', SID, '--kind', 'code', '--choice', 'review', '--by-profile']);
  assert.strictEqual(rd.status, 2, rd.stderr);
});
