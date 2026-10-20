'use strict';
// harness-team-local.test.js — la capa del equipo desde un repo git de LA MÁQUINA: el perfil de un dev solo,
// que nace local con `team-init --local`. La misma lista cerrada, la misma validación y la misma caché que GitHub y Azure;
// sólo cambia de dónde salen los objetos: el git de la máquina, sobre el commit de `main`.
//
//   T1 · `--team` entiende una ruta absoluta y `~/…` como repo local; una relativa no; una carpeta que no existe frena al abrirla.
//   T2 · la capa sale del último commit de `main`: lo que está sin commitear no aparece.
//   T3 · la lista cerrada y la validación son las de siempre: un archivo fuera de la lista no se apila; los casos del examen
//        de un paquete (`packs/<p>/exam/<x>.json`) sí.
//   T4 · bajar: a la caché con su manifiesto; la segunda vez, desde la caché; un commit conocido da `unchanged`.
//   T5 · una carpeta sin git o un repo sin `main`: frena con el motivo y no escribe caché.
//   T5b · leer el repo no ejecuta nada de él: un hook y un fsmonitor plantados en su configuración no corren.
//   T6 · un repo con objetos sha256 se dice como tal (no «no tiene la rama main»); T7 · un enlace simbólico commiteado no se apila.
//
// Uso: node --test scripts/tests/harness-team-local.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEAM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'team.js'));
const VERSION = '2026.10.09.1';

const casa = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `team-local-${name}-`)));
  if (d.startsWith(ROOT) || /agent-skills|\.claude\/|\.tycon\//.test(d)) throw new Error(`el laboratorio cayó en ${d}`);
  return d;
};
// fecha fija (ningún sha depende de la hora) y sin el mantenimiento automático de git (queda corriendo desprendido)
const gitEnv = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com', GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
const git = (args, cwd) => { const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'utf8', env: gitEnv }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const write = (dir, rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

const LAYER = '{ "schema": 1, "name": "solo", "requires": { "harness": ">= 2026.10.01.1" } }\n';
const PROFILE = '{ "packs": { "default": ["mi-stack"] }, "install": { "profile": "minimal" }, "update": { "apply": "ask" } }\n';
const PACK = '{ "name": "mi-stack", "description": "las reglas de mi stack", "reviewers": [] }\n';
const EXAM = '{ "advisor": "mi-revisor", "cases": [] }\n';

/** Un repo del perfil de juguete en la máquina, con un commit en `main`, y la casa del arnés de juguete. */
function lab(name, { extra = {} } = {}) {
  const dir = casa(name);
  const repo = path.join(dir, 'solo-profile');
  fs.mkdirSync(repo);
  write(repo, 'team-layer.json', LAYER);
  write(repo, 'team-profile.json', PROFILE);
  write(repo, 'packs/mi-stack/pack.json', PACK);
  write(repo, 'packs/mi-stack/exam/mi-revisor.json', EXAM);
  for (const [rel, text] of Object.entries(extra)) write(repo, rel, text);
  git(['init', '-q', '-b', 'main'], repo); git(['add', '-A'], repo); git(['commit', '-q', '-m', 'el perfil'], repo);
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.tycon'), { recursive: true });
  const env = { HOME: home, TYCON_HOME: path.join(home, '.tycon'), PATH: process.env.PATH };
  const ctx = { home, env };
  const open = (p = repo) => TEAM.openSource(p, { ctx });
  const resolve = (o, p) => { const s = open(p); assert.equal(s.ok, true, s.reason); return s.resolve(Object.assign({ version: VERSION, readerTree: ROOT, home, env }, o)); };
  return { dir, repo, home, env, ctx, open, resolve, head: () => git(['rev-parse', 'main'], repo), stop: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('T1 ParseTeam_LocalPath', () => {
  const home = path.join(os.tmpdir(), 'casa-de-juguete');
  const abs = TEAM.parseTeam(path.join(home, 'solo-profile'));
  assert.equal(abs.ok, true, abs.problem);
  assert.equal(abs.host, 'local');
  assert.equal(abs.repo, path.join(home, 'solo-profile'));
  assert.equal(abs.name, 'solo-profile');
  const tilde = TEAM.parseTeam('~/solo-profile', { home });
  assert.equal(tilde.ok, true, tilde.problem);
  assert.equal(tilde.host, 'local');
  assert.equal(tilde.repo, path.join(home, 'solo-profile'));
  for (const bad of ['solo-profile/', './solo-profile', '../x/y']) {
    const r = TEAM.parseTeam(bad);
    assert.equal(r.ok, false, `«${bad}» tendría que rechazarse`);
  }
  // lo de siempre no cambia
  assert.equal(TEAM.parseTeam('acme/harness-team-profile').host, 'github');
  assert.equal(TEAM.parseTeam('https://dev.azure.com/acme/p/_git/r').host, 'azure');
  // una carpeta que no existe: se entiende la forma, frena al abrirla con el motivo
  const L = lab('t1');
  try {
    const gone = L.open(path.join(L.dir, 'no-existe'));
    assert.equal(gone.ok, false);
    assert.match(gone.reason, /no existe/);
  } finally { L.stop(); }
});

test('T2 Resolve_CommittedMainOnly', () => {
  const L = lab('t2');
  try {
    write(L.repo, 'packs/mi-stack/agents/sin-commitear.md', '---\nname: sin-commitear\n---\nno\n');
    fs.writeFileSync(path.join(L.repo, 'team-profile.json'), '{ "packs": { "default": "none" } }\n');
    const r = L.resolve();
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.host, 'local');
    assert.equal(r.commit, L.head());
    assert.deepEqual(r.declaration, { name: 'solo', requires: '2026.10.01.1' });
    assert.ok(!r.files.some((f) => /sin-commitear/.test(f.path)), 'lo sin commitear no entra');
    // el perfil juzgado es el commiteado (pide mi-stack), no el de la carpeta (none)
    assert.ok(r.profileEntries.some((e) => /packs/.test(e.ruta) && JSON.stringify(e.valor).includes('mi-stack')), JSON.stringify(r.profileEntries));
  } finally { L.stop(); }
});

test('T3 Resolve_ClosedListAndValidation', () => {
  const L = lab('t3');
  try {
    const r = L.resolve();
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.files.some((f) => f.path === 'packs/mi-stack/exam/mi-revisor.json'), r.files.map((f) => f.path).join(', '));
    // un archivo fuera de la lista cerrada (un guion) no se apila: con el motivo
    write(L.repo, 'scripts/hook-malo.js', 'require("child_process").execSync("echo pwn")\n');
    git(['add', '-A'], L.repo); git(['commit', '-q', '-m', 'un guion'], L.repo);
    const bad = L.resolve();
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /scripts\/hook-malo\.js/);
    assert.match(bad.reason, /no se apila/);
    // un examen en un nivel más profundo, o que no es .json, tampoco
    git(['rm', '-q', 'scripts/hook-malo.js'], L.repo);
    write(L.repo, 'packs/mi-stack/exam/sub/a.json', '{}\n');
    git(['add', '-A'], L.repo); git(['commit', '-q', '-m', 'un examen anidado'], L.repo);
    const deep = L.resolve();
    assert.equal(deep.ok, false);
    assert.match(deep.reason, /exam\/sub\/a\.json/);
    // la versión que va a quedar no cumple la mínima: la misma validación que el remoto
    git(['rm', '-q', 'packs/mi-stack/exam/sub/a.json'], L.repo); git(['commit', '-q', '-m', 'fuera'], L.repo);
    const old = L.resolve({ version: '2026.09.01.1' });
    assert.equal(old.ok, false); assert.match(old.reason, /2026\.10\.01\.1/);
  } finally { L.stop(); }
});

test('T4 Fetch_CacheAndUnchanged', () => {
  const L = lab('t4');
  try {
    const s = L.open();
    const r = L.resolve();
    assert.equal(r.ok, true, r.reason);
    const f1 = s.fetch(r, { env: L.env });
    assert.equal(f1.ok, true, f1.reason);
    assert.equal(f1.fromCache, false);
    assert.ok(f1.cacheDir.startsWith(path.join(L.home, '.tycon')), f1.cacheDir);
    assert.equal(fs.readFileSync(path.join(f1.cacheDir, 'packs', 'mi-stack', 'pack.json'), 'utf8'), PACK);
    const m = TEAM.readTeamManifest(f1.cacheDir);
    assert.equal(m.commit, L.head()); assert.equal(m.repo, L.repo);
    const f2 = s.fetch(L.resolve(), { env: L.env });
    assert.equal(f2.ok, true, f2.reason);
    assert.equal(f2.fromCache, true);
    const known = L.resolve({ knownCommits: [L.head()] });
    assert.equal(known.ok, true); assert.equal(known.unchanged, true);
  } finally { L.stop(); }
});

test('T5 NotARepo_NoMain', () => {
  const L = lab('t5');
  try {
    const plain = path.join(L.dir, 'carpeta-suelta'); fs.mkdirSync(plain); write(plain, 'team-layer.json', LAYER);
    const r1 = L.open(plain);
    const res1 = r1.ok ? r1.resolve({ version: VERSION, readerTree: ROOT, home: L.home, env: L.env }) : r1;
    assert.equal(res1.ok, false); assert.match(res1.reason, /no es un repo git/);
    const other = path.join(L.dir, 'otra-rama'); fs.mkdirSync(other); write(other, 'team-layer.json', LAYER);
    git(['init', '-q', '-b', 'trabajo'], other); git(['add', '-A'], other); git(['commit', '-q', '-m', 'x'], other);
    const r2 = L.open(other);
    assert.equal(r2.ok, true, r2.reason);
    const res2 = r2.resolve({ version: VERSION, readerTree: ROOT, home: L.home, env: L.env });
    assert.equal(res2.ok, false); assert.match(res2.reason, /rama main/);
    assert.equal(fs.existsSync(path.join(L.home, '.tycon', 'team')), false, 'no se escribió caché');
  } finally { L.stop(); }
});

test('T5b Read_RunsNothingFromTheRepo', () => {
  const L = lab('t5b');
  try {
    const mark = path.join(L.dir, 'corrio');
    const evil = path.join(L.dir, 'evil.sh');
    fs.writeFileSync(evil, `#!/bin/sh\ntouch "${mark}"\n`); fs.chmodSync(evil, 0o755);
    git(['config', 'core.fsmonitor', evil], L.repo);
    git(['config', 'core.hooksPath', L.dir], L.repo);
    for (const h of ['post-checkout', 'reference-transaction']) { fs.copyFileSync(evil, path.join(L.dir, h)); fs.chmodSync(path.join(L.dir, h), 0o755); }
    const s = L.open();
    const r = L.resolve();
    assert.equal(r.ok, true, r.reason);
    assert.equal(s.fetch(r, { env: L.env }).ok, true);
    assert.equal(fs.existsSync(mark), false, 'leer el repo ejecutó algo de él');
  } finally { L.stop(); }
});

test('T6 Sha256Repo_SaidClearly', () => {
  const L = lab('t6');
  try {
    const repo = path.join(L.dir, 'sha256-profile'); fs.mkdirSync(repo);
    write(repo, 'team-layer.json', LAYER); write(repo, 'team-profile.json', PROFILE);
    const init = spawnSync('git', ['-c', 'maintenance.auto=false', 'init', '-q', '--object-format=sha256', '-b', 'main'], { cwd: repo, encoding: 'utf8', env: gitEnv });
    if (init.status !== 0) return;   // un git sin sha256 no arma el caso
    git(['add', '-A'], repo); git(['commit', '-q', '-m', 'sha256'], repo);
    const r = L.resolve({}, repo);
    assert.equal(r.ok, false);
    assert.match(r.reason, /sha256/);
    assert.doesNotMatch(r.reason, /no tiene la rama main/);
  } finally { L.stop(); }
});

test('T7 SymlinkInCommit_Refused', () => {
  const L = lab('t7');
  try {
    const secret = path.join(L.dir, 'secreto.md'); fs.writeFileSync(secret, '---\nname: x\n---\nfuera del repo\n');
    fs.mkdirSync(path.join(L.repo, 'packs', 'mi-stack', 'agents'), { recursive: true });
    fs.symlinkSync(secret, path.join(L.repo, 'packs', 'mi-stack', 'agents', 'enlace.md'));
    git(['add', '-A'], L.repo); git(['commit', '-q', '-m', 'un enlace'], L.repo);
    const r = L.resolve();
    assert.equal(r.ok, false, 'un enlace simbólico commiteado no se apila');
    assert.match(r.reason, /enlace\.md/);
  } finally { L.stop(); }
});
