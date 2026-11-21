'use strict';
// stable-data: los repos de juguete sólo se inicializan (git init), nunca se commitea en ellos; las horas son relativas al
// momento de la prueba (las fechas de los archivos se fijan con utimes).
// live-sessions.test.js — quién más vive en un checkout: por su transcripción (con los subagentes,
// también los de un Workflow) y por su marcador del pipeline (aunque la transcripción esté quieta). Cada caso arma una
// HOME de juguete y repos de juguete; ninguno mira las sesiones reales de la máquina.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib', 'live-sessions.js');
const LS = require(LIB);

const MIN = 60 * 1000;
function toy() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsn-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return { root, home, state: path.join(home, '.claude', '.tycon-pipeline') };
}
function repo(t, name) {
  const d = path.join(t.root, name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', d]);
  return d;
}
const folderOf = (t, cwd) => path.join(t.home, '.claude', 'projects', cwd.replace(/[/\\:]/g, '-'));
const age = (file, ms) => { const when = new Date(Date.now() - ms); fs.utimesSync(file, when, when); };
function transcript(t, cwd, id, { ageMs = 0, prompt = `pedido de ${id}` } = {}) {
  const dir = folderOf(t, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: prompt } })}\n`);
  age(file, ageMs);
  return file;
}
function marker(t, sid, fields, { name = `${sid}.json` } = {}) {
  const dir = path.join(t.state, 'active');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof fields === 'string' ? fields : JSON.stringify({ sessionId: sid, storyId: '9.1', stepsPending: ['plan'], lastTouch: new Date().toISOString(), startedAt: new Date(Date.now() - 60 * MIN).toISOString(), ...fields }));
  return file;
}
const others = (t, root, extra = {}) => LS.others({ root, selfSessionId: 'la-mia', home: t.home, now: Date.now(), ...extra });

test('LS1 Transcript_MainQuiet_SubagentFresh_IsAlive @story-8.292 @ac-1', () => {
  // 🔴 mutación: mirar sólo `<carpeta>/*.jsonl` (como hoy) o sólo el primer nivel de `subagents/` (el Workflow anida)
  const t = toy();
  const checkout = repo(t, 'producto');
  transcript(t, checkout, 'aaaa1111-otra', { ageMs: 10 * MIN });
  // (a) un subagente de primer nivel, tocado hace 1 minuto
  const sub = path.join(folderOf(t, checkout), 'aaaa1111-otra', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const agent = path.join(sub, 'agent-x.jsonl');
  fs.writeFileSync(agent, '{}\n');
  age(agent, 1 * MIN);
  let r = others(t, checkout);
  assert.deepStrictEqual(r.sessions.map((s) => s.id), ['aaaa1111-otra'], JSON.stringify(r));
  assert.match(r.sessions[0].why, /subagente/);
  // (b) sólo un agente de un Workflow, anidado: el de primer nivel ya es viejo
  age(agent, 30 * MIN);
  const wf = path.join(sub, 'workflows', 'wf_x');
  fs.mkdirSync(wf, { recursive: true });
  const nested = path.join(wf, 'agent-y.jsonl');
  fs.writeFileSync(nested, '{}\n');
  age(nested, 1 * MIN);
  r = others(t, checkout);
  assert.deepStrictEqual(r.sessions.map((s) => s.id), ['aaaa1111-otra'], JSON.stringify(r));
  assert.match(r.sessions[0].why, /subagente/);
  // sin subagentes recientes y la principal quieta, no está viva
  age(nested, 30 * MIN);
  assert.deepStrictEqual(others(t, checkout).sessions, []);
});

test('LS2 Marker_SameRepoPath_IsAlive_EvenQuiet @story-8.292 @ac-1', () => {
  // 🔴 mutación: comparar repoPath sin ruta real, contar el de 30 h, o no contar la corrida dejada a propósito
  const t = toy();
  const checkout = repo(t, 'producto');
  const otraCopia = repo(t, 'producto--wt-x');
  // el repoPath escrito por el enlace (/var y /private/var en macOS; en Linux, un enlace propio)
  const link = path.join(t.root, 'enlace');
  fs.symlinkSync(t.root, link);
  marker(t, 'bbbb2222-otra', { storyId: '9.1', repoPath: path.join(link, 'producto') });
  marker(t, 'cccc3333-copia', { storyId: '9.2', repoPath: otraCopia });
  const vieja = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  marker(t, 'dddd4444-vieja', { storyId: '9.3', repoPath: checkout, lastTouch: vieja, startedAt: vieja });
  marker(t, 'eeee5555-dejada', { storyId: '9.4', repoPath: checkout, lastTouch: vieja, startedAt: vieja });
  fs.mkdirSync(path.join(t.state, 'parked'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'parked', 'eeee5555-dejada.json'), JSON.stringify({ story: '9.4', at: new Date().toISOString() }));
  const r = others(t, checkout);
  const ids = r.sessions.map((s) => s.id).sort();
  assert.deepStrictEqual(ids, ['bbbb2222-otra', 'eeee5555-dejada'], JSON.stringify(r));
  assert.strictEqual(r.sessions.find((s) => s.id === 'bbbb2222-otra').story, '9.1');
  // para saber de quién es un archivo cuentan todos, también el de 30 h
  const dueños = LS.claims({ root: checkout, home: t.home }).markers.map((m) => m.sessionId).sort();
  assert.ok(dueños.includes('dddd4444-vieja'), dueños.join(','));
  // la historia en pausa también lo mantiene vivo
  const historia = path.join(t.root, 'story-9.3.md');
  fs.writeFileSync(historia, '---\nstory: "9.3"\npaused_until: 2099-01-01\n---\n');
  marker(t, 'dddd4444-vieja', { storyId: '9.3', repoPath: checkout, lastTouch: vieja, startedAt: vieja, storyPath: historia });
  assert.ok(others(t, checkout).sessions.some((s) => s.id === 'dddd4444-vieja'));
  assert.strictEqual(LS.storyPausedUntil(historia), '2099-01-01');
});

test('LS3 BothSources_OnceAndSelfExcluded @story-8.292 @ac-1', () => {
  // 🔴 mutación: no deduplicar por id, o contar la propia por alguna de las dos fuentes
  const t = toy();
  const checkout = repo(t, 'producto');
  transcript(t, checkout, 'ffff6666-otra');
  marker(t, 'ffff6666-otra', { repoPath: checkout });
  transcript(t, checkout, 'la-mia');
  marker(t, 'la-mia', { repoPath: checkout });
  const r = others(t, checkout);
  assert.deepStrictEqual(r.sessions.map((s) => s.id), ['ffff6666-otra'], JSON.stringify(r));
  // la propia también se reconoce por su transcripción
  const r2 = LS.others({ root: checkout, selfSessionId: 'x', selfTranscript: path.join(folderOf(t, checkout), 'la-mia.jsonl'), home: t.home, now: Date.now() });
  assert.ok(!r2.sessions.some((s) => s.id === 'la-mia'), JSON.stringify(r2));
  // la CLI toma la propia del entorno
  const env = { ...process.env, HOME: t.home, USERPROFILE: t.home, CLAUDE_CODE_SESSION_ID: 'la-mia' };
  delete env.TYCON_HOME;
  const cli = spawnSync(process.execPath, [LIB, '--root', checkout, '--json'], { env, encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.deepStrictEqual(JSON.parse(cli.stdout).sessions.map((s) => s.id), ['ffff6666-otra']);
});

test('LS4 Unreadable_GoesToProblems @story-8.292 @ac-1 @ac-11', { skip: process.getuid && process.getuid() === 0 ? 'como root se lee todo' : false }, () => {
  // 🔴 mutación: callar lo que no se pudo leer, o contar el marcador roto como vivo
  const t = toy();
  const checkout = repo(t, 'producto');
  marker(t, 'roto', '{ esto no es json', { name: 'roto.json' });
  const projects = path.join(t.home, '.claude', 'projects');
  fs.chmodSync(projects, 0o000);
  try {
    const r = others(t, checkout);
    assert.deepStrictEqual(r.sessions, []);
    assert.ok(r.problems.some((p) => /transcripciones/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /roto\.json/.test(p)), r.problems.join('\n'));
  } finally { fs.chmodSync(projects, 0o755); }
});

test('LS6 Transcript_RepoPathWithUnderscoreOrSpace_IsFound @story-8.292 @ac-1', () => {
  // 🔴 mutación: cambiar sólo separadores y puntos; Claude Code cambia por `-` todo lo que no sea letra o número
  const t = toy();
  for (const nombre of ['mi_repo', 'mi repo', 'mi~repo']) {
    const checkout = repo(t, nombre);
    const dir = path.join(t.home, '.claude', 'projects', checkout.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'aaaa1111-otra.jsonl'), `${JSON.stringify({ type: 'user', cwd: checkout, message: { role: 'user', content: 'pedido' } })}\n`);
    assert.deepStrictEqual(others(t, checkout).sessions.map((s) => s.id), ['aaaa1111-otra'], nombre);
  }
});

test('LS5 NoOwnCopy_HarnessCopiesAndAgentSkills @story-8.292 @ac-5', () => {
  // 🔴 mutación: mirar sólo el último tramo de la ruta (no ve la copia --wt- del arnés)
  const t = toy();
  const arnes = repo(t, 'tycon-harness');
  execFileSync('git', ['-C', arnes, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const copia = path.join(t.root, 'tycon-harness--wt-x');
  execFileSync('git', ['-C', arnes, 'worktree', 'add', '-q', '-b', 'wt/x', copia]);
  assert.strictEqual(LS.noOwnCopy(arnes), true);
  assert.strictEqual(LS.noOwnCopy(copia), true);
  assert.strictEqual(LS.noOwnCopy(repo(t, 'agent-skills')), true);
  assert.strictEqual(LS.noOwnCopy(repo(t, 'producto')), false);
  assert.strictEqual(LS.noOwnCopy(repo(t, 'harness-maintainers')), false);
});
