'use strict';
// stable-data: los repos de juguete sólo se inicializan (git init), nunca se commitea en ellos; las horas son las de los
// archivos recién escritos, corridas a mano con utimes.
// live-sessions.test.js — who else lives in a checkout: other sessions by their transcript (counting the subagents' files)
// and by their pipeline marker (fresh, waiting for a turn, or parked on purpose). Each case builds a toy HOME and a toy
// state folder; none looks at the machine's real sessions.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib', 'live-sessions.js');
const live = require(LIB);

const MIN = 60 * 1000;
const HORA = 60 * MIN;

function toy() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ls-')));
  const home = path.join(root, 'home');
  const stateDir = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'active'), { recursive: true });
  return { root, home, stateDir };
}
function repo(t, name) {
  const d = path.join(t.root, name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', d]);
  return d;
}
function edad(file, ms, now) {
  const when = new Date(now - ms);
  fs.utimesSync(file, when, when);
}
// Una transcripción como la escribe Claude Code: en la carpeta con el nombre del cwd, con `cwd` en su renglón.
function transcript(t, cwd, id, { ageMs = 0, now = Date.now(), pedido = `pedido de ${id}` } = {}) {
  const dir = path.join(t.home, '.claude', 'projects', cwd.replace(/[/\\:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: pedido } })}\n`);
  edad(file, ageMs, now);
  return { dir, file };
}
function marker(t, id, fields, { now = Date.now() } = {}) {
  const m = { sessionId: id, storyId: '9.9', stepsPending: ['implement'], lastTouch: new Date(now).toISOString(), ...fields };
  fs.writeFileSync(path.join(t.stateDir, 'active', `${id}.json`), JSON.stringify(m));
  return m;
}
const ids = (r) => r.sessions.map((s) => s.id).sort();
const de = (r, id) => r.sessions.find((s) => s.id === id);

test('LS1 Transcript_MainQuiet_SubagentFresh_IsAlive @story-8.292 @ac-1', () => {
  // 🔴 mutación: mirar sólo la fecha de la transcripción principal (la sesión con un subagente en vuelo parece muerta)
  const t = toy();
  const now = Date.now();
  const checkout = repo(t, 'producto');
  const { dir } = transcript(t, checkout, 'otra-con-subagente', { ageMs: 10 * MIN, now });
  const sub = path.join(dir, 'otra-con-subagente', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const agente = path.join(sub, 'agent-x.jsonl');
  fs.writeFileSync(agente, '{}\n');
  edad(agente, 1 * MIN, now);
  transcript(t, checkout, 'otra-quieta-sin-subagente', { ageMs: 10 * MIN, now });

  const r = live.others({ root: checkout, selfSessionId: 'la-mia', now, home: t.home, stateDir: t.stateDir });
  assert.deepStrictEqual(ids(r), ['otra-con-subagente'], JSON.stringify(r));
  assert.strictEqual(de(r, 'otra-con-subagente').why, 'subagente');
  assert.match(de(r, 'otra-con-subagente').lastPrompt, /pedido de otra-con-subagente/);
});

test('LS2 Marker_SameRepoPath_IsAlive_EvenQuiet @story-8.292 @ac-1', () => {
  // 🔴 mutación: vencer a las 24 h en vez de las 6 h de listOtherMarkers, contar un terminado, contar una marca de otra
  // historia, o cargar un módulo del arnés (la lib viaja suelta con el guardián)
  const t = toy();
  const now = Date.now();
  const checkout = repo(t, 'producto');
  const otraCopia = repo(t, 'producto--wt-X');
  // macOS: /var y /private/var son la misma carpeta; el marcador puede traer cualquiera de las dos
  const comoSeEscribio = checkout.startsWith('/private/var/') ? checkout.slice('/private'.length) : checkout;
  marker(t, 'a-vigente', { repoPath: comoSeEscribio, lastTouch: new Date(now - 1 * HORA).toISOString(), storyId: '1.1' });
  marker(t, 'b-dejada', { repoPath: checkout, lastTouch: new Date(now - 30 * HORA).toISOString(), storyId: '2.2', startedAt: new Date(now - 40 * HORA).toISOString() });
  fs.mkdirSync(path.join(t.stateDir, 'parked'), { recursive: true });
  fs.writeFileSync(path.join(t.stateDir, 'parked', 'b-dejada.json'), JSON.stringify({ story: '2.2', kind: 'queue', at: new Date(now - 35 * HORA).toISOString() }));
  marker(t, 'c-esperando', { repoPath: checkout, lastTouch: new Date(now - 30 * HORA).toISOString(), storyId: '3.3' });
  fs.mkdirSync(path.join(t.stateDir, 'doing'), { recursive: true });
  fs.writeFileSync(path.join(t.stateDir, 'doing', 'c-esperando.json'), JSON.stringify({ waitingFor: 'el turno de la suite', waitingSince: new Date(now - 2 * HORA).toISOString() }));
  marker(t, 'd-vencida', { repoPath: checkout, lastTouch: new Date(now - 7 * HORA).toISOString() });
  marker(t, 'e-sin-story', { repoPath: checkout, storyId: undefined });
  marker(t, 'f-otra-copia', { repoPath: otraCopia });
  marker(t, 'g-terminada', { repoPath: checkout, stepsPending: [] });
  // la marca de dejada de OTRA historia no la protege
  marker(t, 'h-marca-ajena', { repoPath: checkout, lastTouch: new Date(now - 30 * HORA).toISOString(), storyId: '4.4' });
  fs.writeFileSync(path.join(t.stateDir, 'parked', 'h-marca-ajena.json'), JSON.stringify({ story: '5.5', kind: 'queue', at: new Date(now - 35 * HORA).toISOString() }));

  const r = live.others({ root: checkout, selfSessionId: 'la-mia', now, home: t.home, stateDir: t.stateDir });
  assert.deepStrictEqual(ids(r), ['a-vigente', 'b-dejada', 'c-esperando'], JSON.stringify(r));
  assert.strictEqual(de(r, 'a-vigente').why, 'corrida');
  assert.strictEqual(de(r, 'a-vigente').story, '1.1');
  assert.strictEqual(de(r, 'b-dejada').why, 'dejada');
  assert.strictEqual(de(r, 'c-esperando').why, 'esperando');

  // la lib no carga nada fuera de fs, path y os: viaja suelta junto al guardián
  const texto = fs.readFileSync(LIB, 'utf8');
  const requeridos = [...texto.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(requeridos)].sort(), ['fs', 'os', 'path'], `requiere: ${requeridos.join(', ')}`);
});

test('LS3 BothSources_OnceAndSelfExcluded @story-8.292 @ac-1', () => {
  // 🔴 mutación: no unir por id (la misma sesión sale dos veces), o no sacar la propia
  const t = toy();
  const now = Date.now();
  const checkout = repo(t, 'producto');
  transcript(t, checkout, 'otra', { now });
  marker(t, 'otra', { repoPath: checkout, storyId: '7.7' });
  transcript(t, checkout, 'la-mia', { now });
  marker(t, 'la-mia', { repoPath: checkout });

  const r = live.others({ root: checkout, selfSessionId: 'la-mia', now, home: t.home, stateDir: t.stateDir });
  assert.deepStrictEqual(ids(r), ['otra'], JSON.stringify(r));
  assert.strictEqual(de(r, 'otra').story, '7.7', 'el marcador pone su historia');
  assert.match(de(r, 'otra').lastPrompt, /pedido de otra/, 'la transcripción pone su último pedido');

  // sin id propio (`_nosession`) no se saca nada por id: cuenta de más, nunca de menos
  const sinId = live.others({ root: checkout, selfSessionId: '_nosession', now, home: t.home, stateDir: t.stateDir });
  assert.deepStrictEqual(ids(sinId), ['la-mia', 'otra']);
});

test('LS4 Unreadable_GoesToProblems @story-8.292 @ac-1 @ac-11', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'chmod no niega la lectura acá' : false }, () => {
  // 🔴 mutación: tragarse lo que no se puede leer (sin motivo en problems) o contarlo como viva
  const t = toy();
  const now = Date.now();
  const checkout = repo(t, 'producto');
  fs.writeFileSync(path.join(t.stateDir, 'active', 'rota.json'), '{ esto no es JSON');
  const projects = path.join(t.home, '.claude', 'projects');
  fs.chmodSync(projects, 0o000);
  try {
    const r = live.others({ root: checkout, selfSessionId: 'la-mia', now, home: t.home, stateDir: t.stateDir });
    assert.deepStrictEqual(r.sessions, []);
    assert.ok(r.problems.some((p) => /transcripciones/.test(p)), JSON.stringify(r.problems));
    assert.ok(r.problems.some((p) => /rota\.json/.test(p)), JSON.stringify(r.problems));
  } finally { fs.chmodSync(projects, 0o755); }

  // la CLI dice lo mismo y sale 0
  const cli = spawnSync(process.execPath, [LIB, '--root', checkout, '--state-dir', t.stateDir, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: t.home, USERPROFILE: t.home } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  assert.ok(JSON.parse(cli.stdout).problems.some((p) => /rota\.json/.test(p)));
});
