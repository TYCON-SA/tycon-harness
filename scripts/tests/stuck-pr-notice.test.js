'use strict';
// stuck-pr-notice.test.js — el aviso de arranque de los pedidos trabados (scripts/hooks/stuck-pr-notice.js): corre el
// guion real, en un repo del arnés de mentira, contra el az de mentira (scripts/tests/lib/fake-az.sh), con una casa y un
// árbol temporales. El reloj se prueba escribiendo el estado guardado con `vistoDesde` de hace 61 minutos.
// stable-data: cada fecha es «ahora menos N minutos», la misma cuenta que hace el aviso con su reloj; el resultado no
// depende del día en que corre, y lo demás del reloj mide cuánto tarda.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'stuck-pr-notice.js');
const FAKE_AZ = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-az.sh');
const { stateDir } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'));
const HARNESS_URL = 'https://dev.azure.com/acme/Harness/_git/harness';
const HACE_61 = () => new Date(Date.now() - 61 * 60000).toISOString();

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const azRepo = (repo) => ({ platform: 'azure', org: 'acme', project: 'Harness', repo });

function repoGit(origin) {
  const d = tmp('spn-repo-');
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', origin]);
  return d;
}

/** Un pedido como lo devuelve Azure, del repo del arnés `harness-maintainers` salvo que se diga otro. */
function pr(n, o = {}) {
  return {
    pullRequestId: n, isDraft: false, mergeStatus: 'succeeded', status: 'active', title: `pedido ${n}`,
    autoCompleteSetBy: { id: 'quien' }, sourceRefName: `refs/heads/story/${n}`, creationDate: '2026-10-25T10:00:00Z',
    lastMergeSourceCommit: { commitId: `${n}`.padStart(40, 'a') }, repository: { name: 'harness-maintainers' }, ...o,
  };
}

/** Un mundo: árbol con team-repos.json, casa, repo del arnés y az de mentira con los pedidos dados. */
function mundo(prs, teamRepos) {
  const tree = tmp('spn-tree-');
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(teamRepos || {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: azRepo('harness-team-profile'),
    operations: azRepo('harness-team-operations'),
    maintainers: azRepo('harness-maintainers'),
  }));
  const home = tmp('spn-home-');
  const fix = tmp('spn-fixaz-');
  const az = path.join(tmp('spn-az-'), 'az');
  fs.copyFileSync(FAKE_AZ, az);
  fs.chmodSync(az, 0o755);
  const w = { tree, home, fix, az, cwd: repoGit(HARNESS_URL) };
  ponerPedidos(w, prs);
  return w;
}
function ponerPedidos(w, prs) { fs.writeFileSync(path.join(w.fix, 'prs-0.json'), JSON.stringify({ count: prs.length, value: prs })); }
const estadoArchivo = (w) => path.join(stateDir(w.home), 'stuck-prs.json');
const fotoArchivo = (w) => path.join(stateDir(w.home), 'stuck-prs-photo.json');
function leerEstado(w) { return JSON.parse(fs.readFileSync(estadoArchivo(w), 'utf8')); }
function escribirEstado(w, estado) { fs.mkdirSync(stateDir(w.home), { recursive: true }); fs.writeFileSync(estadoArchivo(w), JSON.stringify(estado)); }
const clave = (n, repo = 'harness-maintainers') => `acme/Harness/${repo}#${n}`;
const llamadas = (w) => { try { return fs.readFileSync(path.join(w.fix, 'llamadas.log'), 'utf8').split('\n').filter((l) => /pullRequests/.test(l)).length; } catch { return 0; } };

function correr(w, extra = {}, cwd = w.cwd) {
  const env = {
    PATH: process.env.PATH, HOME: w.home, TYCON_TREE: w.tree, TYCON_ADO_CMD: w.az, FIXAZ: w.fix, TYCON_PROFILE: '0',
    TYCON_HARNESS_IDENTITIES: HARNESS_URL, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra,
  };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ source: 'startup', cwd, session_id: 't' }), env, encoding: 'utf8', timeout: 30000 });
  return { rc: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || ''), ms: Date.now() - t0 };
}

test('Notice_ConflictOverHour_Shown @story-8.131 @ac-8', () => {
  const w = mundo([pr(5458, { isDraft: true, mergeStatus: 'conflicts' })]);
  escribirEstado(w, { [clave(5458)]: { estado: 'conflict+borrador', punta: '5458'.padStart(40, 'a'), vistoDesde: HACE_61() } });
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /pedido 5458 \(harness-maintainers\) en choque hace 1 h · story\/5458/);
  assert.strictEqual(r.out.split('\n').length, 1, r.out);
});

test('Notice_ConflictUnderHour_RecordsFirstSeen @story-8.131 @ac-8', () => {
  const w = mundo([pr(5352, { mergeStatus: 'conflicts' })]);
  const antes = Date.now();
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(r.out, '');
  const e = leerEstado(w)[clave(5352)];
  assert.ok(e, 'guarda el pedido');
  assert.strictEqual(e.punta, '5352'.padStart(40, 'a'));
  assert.ok(Date.parse(e.vistoDesde) >= antes - 1000, e.vistoDesde);
});

test('Notice_NotEnteredOverHour_Shown @story-8.131 @ac-9', () => {
  for (const [mergeStatus, estado] of [['succeeded', 'clean'], ['queued', 'pending'], ['rejectedByPolicy', 'unknown']]) {
    const w = mundo([pr(5444, { mergeStatus })]);
    escribirEstado(w, { [clave(5444)]: { estado, punta: '5444'.padStart(40, 'a'), vistoDesde: HACE_61() } });
    const r = correr(w);
    assert.strictEqual(r.rc, 0, r.err);
    assert.match(r.out, new RegExp(`pedido 5444 \\(harness-maintainers\\) con auto-completar no entró hace 1 h \\(${estado}\\) · story/5444`), `${estado}: ${r.out}`);
  }
});

test('Notice_QuietCases_Silent @story-8.131 @ac-10', () => {
  // borrador limpio, y sin auto-completar en choque: viejos, y aun así callan
  const w = mundo([pr(1, { isDraft: true }), pr(2, { mergeStatus: 'conflicts', autoCompleteSetBy: undefined })]);
  escribirEstado(w, {
    [clave(1)]: { estado: 'clean+borrador', punta: '1'.padStart(40, 'a'), vistoDesde: HACE_61() },
    [clave(2)]: { estado: 'conflict', punta: '2'.padStart(40, 'a'), vistoDesde: HACE_61() },
  });
  let r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(r.out, '', 'borrador limpio y sin auto-completar');
  // un pedido trabado, pero fuera de un repo del arnés, o con el aviso apagado
  const v = mundo([pr(3, { mergeStatus: 'conflicts' })]);
  escribirEstado(v, { [clave(3)]: { estado: 'conflict', punta: '3'.padStart(40, 'a'), vistoDesde: HACE_61() } });
  r = correr(v, {}, repoGit('https://dev.azure.com/acme/Producto/_git/Backend'));
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(r.out, '', 'fuera de un repo del arnés');
  assert.strictEqual(llamadas(v), 0, 'fuera del arnés no sale a la red');
  r = correr(v, { TYCON_STUCK_PR_NOTICE: '0' });
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(r.out, '', 'apagado');
  assert.strictEqual(llamadas(v), 0, 'apagado no sale a la red');
});

test('Notice_StateOrTipChange_ResetsClock @story-8.131 @ac-11', () => {
  const punta = '9'.padStart(40, 'a');
  const w = mundo([pr(9)]);
  escribirEstado(w, { [clave(9)]: { estado: 'conflict', punta, vistoDesde: HACE_61() } });
  // choque → limpio: el reloj vuelve a cero, y no avisa
  let antes = Date.now();
  let r = correr(w);
  assert.strictEqual(r.out, '');
  let e = leerEstado(w)[clave(9)];
  assert.strictEqual(e.estado, 'clean');
  assert.ok(Date.parse(e.vistoDesde) >= antes - 1000, `choque → limpio: ${e.vistoDesde}`);
  // limpio → choque: otra vez a cero
  escribirEstado(w, { [clave(9)]: { ...e, vistoDesde: HACE_61() } });
  fs.rmSync(fotoArchivo(w), { force: true });
  ponerPedidos(w, [pr(9, { mergeStatus: 'conflicts' })]);
  antes = Date.now();
  r = correr(w);
  assert.strictEqual(r.out, '');
  e = leerEstado(w)[clave(9)];
  assert.strictEqual(e.estado, 'conflict');
  assert.ok(Date.parse(e.vistoDesde) >= antes - 1000, `limpio → choque: ${e.vistoDesde}`);
  // otra punta de rama, mismo estado: a cero
  escribirEstado(w, { [clave(9)]: { ...e, vistoDesde: HACE_61() } });
  fs.rmSync(fotoArchivo(w), { force: true });
  ponerPedidos(w, [pr(9, { mergeStatus: 'conflicts', lastMergeSourceCommit: { commitId: 'b'.repeat(40) } })]);
  antes = Date.now();
  r = correr(w);
  assert.strictEqual(r.out, '');
  e = leerEstado(w)[clave(9)];
  assert.strictEqual(e.punta, 'b'.repeat(40));
  assert.ok(Date.parse(e.vistoDesde) >= antes - 1000, `otra punta: ${e.vistoDesde}`);
});

test('Notice_PlatformNoMedido_SaysSo @story-8.131 @ac-12', () => {
  const w = mundo([pr(1)]);
  const guardado = {
    [clave(1)]: { estado: 'conflict', punta: 'x', vistoDesde: HACE_61() },
    [clave(2)]: { estado: 'clean', punta: 'y', vistoDesde: HACE_61() },
    [clave(3, 'harness-team-profile')]: { estado: 'pending', punta: 'z', vistoDesde: HACE_61() },
  };
  escribirEstado(w, guardado);
  const r = correr(w, { TYCON_AZ_FAIL: 'prs' });
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /^pedidos trabados: no medido \(.*harness-maintainers: /);
  assert.deepStrictEqual(leerEstado(w), guardado, 'con no_medido el estado no se toca');
  // todos los repos en GitHub: la capa contesta no_soportado y el aviso calla
  const v = mundo([pr(1)], { version: 1, public: { platform: 'github', org: 'acme', repo: 'harness' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'ops' } });
  const s = correr(v);
  assert.strictEqual(s.rc, 0, s.err);
  assert.strictEqual(s.out, '', 'no_soportado calla');
});

test('Notice_Timeout_NotMeasured @story-8.131 @ac-12', () => {
  const w = mundo([pr(1)]);
  fs.writeFileSync(w.az, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(w.az, 0o755);
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /^pedidos trabados: no medido \(.*tope/);
  assert.ok(r.ms < 5000 + 3000, `tardó ${r.ms} ms`);
});

test('Notice_PhotoTenMinutes_NoSecondRead @story-8.131 @ac-14', () => {
  const w = mundo([pr(1, { mergeStatus: 'conflicts' }), pr(2, { repository: { name: 'harness-team-operations' } })]);
  correr(w);
  assert.strictEqual(llamadas(w), 1, 'los repos del mismo proyecto se leen con un solo az');
  // la segunda corrida, 3 minutos después: la foto vale y no se vuelve a leer
  const foto = JSON.parse(fs.readFileSync(fotoArchivo(w), 'utf8'));
  foto.at = new Date(Date.now() - 3 * 60000).toISOString();
  fs.writeFileSync(fotoArchivo(w), JSON.stringify(foto));
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.strictEqual(llamadas(w), 1, 'una sola lectura');
  // a los 11 minutos la foto venció
  foto.at = new Date(Date.now() - 11 * 60000).toISOString();
  fs.writeFileSync(fotoArchivo(w), JSON.stringify(foto));
  correr(w);
  assert.strictEqual(llamadas(w), 2, 'con la foto vencida, lee otra vez');
});

test('Notice_OutsideText_Sanitized_MaxFive @story-8.131 @ac-13', () => {
  const prs = []; const estado = {};
  for (let n = 1; n <= 8; n++) {
    const rama = n === 1 ? 'refs/heads/x##vso[task.setvariable variable=a]b\nsegunda' : `refs/heads/story/${n}`;
    prs.push(pr(n, { mergeStatus: 'conflicts', sourceRefName: rama }));
    estado[clave(n)] = { estado: 'conflict', punta: `${n}`.padStart(40, 'a'), vistoDesde: new Date(Date.now() - (70 - n) * 60000).toISOString() };   // el 1, el más viejo: sale primero
  }
  const w = mundo(prs);
  escribirEstado(w, estado);
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  const lineas = r.out.split('\n');
  assert.strictEqual(lineas.length, 6, r.out);
  assert.ok(!/##/.test(r.out), r.out);
  assert.match(r.out, /pedido 1 \(harness-maintainers\) en choque hace 1 h · x#vso\[task\.setvariable variable=a\]b segunda/);
  assert.match(lineas[5], /\(\+3 más\)/);
});

test('Notice_ReposFromConfig_HarnessCopiesNoMergeSuites @story-8.131 @ac-8', () => {
  // las copias del arnés se suman (sin repetir la de mantenimiento); los repos de merge_suites son de producto y no
  const w = mundo([pr(1, { mergeStatus: 'conflicts', repository: { name: 'harness-copia' } }), pr(2, { mergeStatus: 'conflicts', repository: { name: 'Backend' } })], {
    version: 1,
    public: { platform: 'github', org: 'acme', repo: 'harness' },
    profile: azRepo('harness-team-profile'),
    operations: azRepo('harness-team-operations'),
    maintainers: azRepo('harness-maintainers'),
    harness_copies: [azRepo('harness-maintainers'), azRepo('harness-copia')],
    merge_suites: { repos: [{ repo: azRepo('Backend'), rule: 'automatico' }] },
  });
  escribirEstado(w, {
    [clave(1, 'harness-copia')]: { estado: 'conflict', punta: '1'.padStart(40, 'a'), vistoDesde: HACE_61() },
    [clave(2, 'Backend')]: { estado: 'conflict', punta: '2'.padStart(40, 'a'), vistoDesde: HACE_61() },
  });
  let r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /pedido 1 \(harness-copia\) en choque hace 1 h/);
  assert.ok(!/Backend/.test(r.out), r.out);
  assert.strictEqual(r.out.split('\n').length, 1, r.out);
  // el umbral: con 2 h, 61 minutos no alcanzan
  r = correr(w, { TYCON_STUCK_PR_HOURS: '2' });
  assert.strictEqual(r.out, '', 'TYCON_STUCK_PR_HOURS=2');
});

test('Notice_OneRepoNotMeasured_OthersKept @story-8.131 @ac-12', () => {
  const w = mundo([]);
  const repos = ['acme/harness', 'acme/Harness/harness-team-profile', 'acme/Harness/harness-team-operations', 'acme/Harness/harness-maintainers'];
  const prOk = { number: 4, draft: false, autoComplete: true, mergeState: 'conflict', sourceBranch: 'story/4', sourceCommit: 'c4', createdAt: '', title: '' };
  // una foto vigente: el mantenimiento leído, operaciones sin medir, el perfil sin entrada (cuenta como sin medir)
  fs.mkdirSync(stateDir(w.home), { recursive: true });
  fs.writeFileSync(fotoArchivo(w), JSON.stringify({ at: new Date().toISOString(), repos, lecturas: {
    'acme/harness': { ok: false, reason: 'no_soportado', detail: 'GitHub no declara change-request.list' },
    'acme/Harness/harness-team-operations': { ok: false, reason: 'red', detail: 'ECONNRESET' },
    'acme/Harness/harness-maintainers': { ok: true, value: [prOk] },
  } }));
  const delOps = { estado: 'pending', punta: 'p', vistoDesde: HACE_61() };
  escribirEstado(w, { [clave(4)]: { estado: 'conflict', punta: 'c4', vistoDesde: HACE_61() }, [clave(5, 'harness-team-operations')]: delOps });
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /^pedidos trabados: no medido \(.*harness-team-profile: .*harness-team-operations: ECONNRESET/);
  assert.match(r.out, /pedido 4 \(harness-maintainers\) en choque hace 1 h · story\/4/);
  assert.deepStrictEqual(leerEstado(w)[clave(5, 'harness-team-operations')], delOps, 'el repo sin medir conserva su estado');
  assert.strictEqual(llamadas(w), 0, 'con la foto vigente no sale a la red');
});

test('Notice_StateNotSaved_SaysSo @story-8.131 @ac-11', () => {
  const w = mundo([pr(6, { mergeStatus: 'conflicts' })]);
  // el estado no se puede escribir: una carpeta en su lugar
  fs.mkdirSync(estadoArchivo(w), { recursive: true });
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /pedidos trabados: no pude guardar desde cuándo/);
});

test('Notice_SameClock_OldestCreatedFirst @story-8.131 @ac-13', () => {
  // la primera vez que la máquina ve varios pedidos, todos tienen el mismo reloj: el empate lo decide su fecha de
  // creación, no el orden en que Azure devuelve la lista (los más nuevos primero)
  const nums = [5470, 5465, 5460, 5444, 5401, 5300, 5282, 5242];
  const prs = nums.map((n, i) => pr(n, { mergeStatus: 'conflicts', creationDate: `2026-10-${String(24 - i).padStart(2, '0')}T10:00:00Z` }));
  const desde = HACE_61();
  const estado = {};
  for (const n of nums) estado[clave(n)] = { estado: 'conflict', punta: `${n}`.padStart(40, 'a'), vistoDesde: desde };
  const w = mundo(prs);
  escribirEstado(w, estado);
  const r = correr(w);
  assert.strictEqual(r.rc, 0, r.err);
  const vistos = [...r.out.matchAll(/pedido (\d+) /g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(vistos, [5242, 5282, 5300, 5401, 5444], r.out);
  assert.match(r.out, /\(\+3 más\)/);
});

test('Notice_ThresholdUnderHour_SaysMinutes @story-8.131 @ac-9', () => {
  const w = mundo([pr(8, { mergeStatus: 'conflicts' })]);
  escribirEstado(w, { [clave(8)]: { estado: 'conflict', punta: '8'.padStart(40, 'a'), vistoDesde: new Date(Date.now() - 16 * 60000).toISOString() } });
  const r = correr(w, { TYCON_STUCK_PR_HOURS: '0.25' });
  assert.strictEqual(r.rc, 0, r.err);
  assert.match(r.out, /pedido 8 \(harness-maintainers\) en choque hace 16 min · story\/8/);
});

test('Notice_Registered_BothTools @story-8.131 @ac-8', () => {
  const lista = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const hooks = Array.isArray(lista) ? lista : lista.hooks;
  assert.strictEqual(hooks.filter((h) => h.event === 'SessionStart' && /stuck-pr-notice\.js$/.test(h.spec)).length, 1, 'hooks-list.json');
  const efectos = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'install-effects.json'), 'utf8'));
  const lista2 = Array.isArray(efectos) ? efectos : (efectos.effects || efectos.items || Object.values(efectos).find(Array.isArray));
  assert.ok(lista2.some((e) => e.id === 'SessionStart:@tcg:stuck-pr-notice.js' && e.switch === 'TYCON_STUCK_PR_NOTICE=0'), 'install-effects.json');
  const codex = fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'hooks.json'), 'utf8');
  assert.match(codex, /scripts\/hooks\/stuck-pr-notice\.js/, 'adapters/codex/hooks.json');
});
