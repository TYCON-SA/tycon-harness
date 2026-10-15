'use strict';
/**
 * harness-snapshot.test.js — la copia de seguridad del mecanismo de instalación (story 8.13, tanda B · T20 y la parte
 * del aplicador `.sh` de T21).
 *
 * Lo que no se puede perder:
 *   T20 · `Snapshot_ManifestFixedListDedupRetention5_InstallPinned` (AC 17): antes de cada cambio el mecanismo copia una
 *         lista FIJA y declarada de archivos (la de la medición §2) a `~/.claude/.tycon-pipeline/harness/backups/
 *         <YYYYMMDD-HHMMSS>/` con su `manifest.json`; si el conjunto no cambió no crea otra; retiene 5 más la copia
 *         `install` más vieja (la única que no rota); nunca toca los `.bak` que el dev ya tiene, y los cuenta.
 *   T21 · `Applier_NoLegacyBakUnderHarness_YesStandalone` (AC 18, la parte del `install-tycon-hooks.sh`): con
 *         `TYCON_HARNESS_SNAPSHOT_DIR` puesta el aplicador no escribe sus `.bak` propios; suelto, como hoy.
 *         (La parte de `sync-claude-md-blocks.sh` vive en `sync-codex-detection.test.sh`; el `.ps1`, por lectura.)
 *
 * 🔴 rojo previo verificado: sin `scripts/setup/harness/snapshot.js` los casos T20 fallan en el `require`; T21 falla
 *    mientras el aplicador escriba `settings.json.bak.<ts>` y `pre-commit.bak-<ts>` aunque la variable esté puesta.
 * 🔴 Nada toca el HOME real: cada caso arma su HOME en el temporal; el aplicador real corre con un esqueleto de
 *    agent-skills (nunca un enlace al real), launchd de mentira, sin examen nocturno, sin entorno gráfico y sin Codex.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const SNAPSHOT = path.join(RAIZ, 'scripts', 'setup', 'harness', 'snapshot.js');
const INSTALLER = path.join(RAIZ, 'scripts', 'install-tycon-hooks.sh');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-harness-snapshot-'));
require('./lib/lab-guard.js').labGuard(BASE, 'harness-snapshot');
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));

const snapshot = () => require(SNAPSHOT);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Un HOME de juguete, con `~/.claude/.tycon-pipeline` y nada más. */
function makeHome(name) {
  const h = path.join(BASE, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(h, '.claude', '.tycon-pipeline'), { recursive: true });
  return h;
}
/** Un árbol de juguete con los dos comandos del arnés que la medición §2 cuenta («`~/.claude/commands/*.md` (2 archivos)»). */
function makeTree(name, commands = ['tycon-instincts.md', 'tycon-vigilante.md']) {
  const t = path.join(BASE, `tree-${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(t, 'commands'), { recursive: true });
  for (const c of commands) fs.writeFileSync(path.join(t, 'commands', c), `# ${c}\n`);
  fs.writeFileSync(path.join(t, 'commands', 'README.txt'), 'no es un comando\n');
  return t;
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const backupsDir = (home) => path.join(home, '.claude', '.tycon-pipeline', 'harness', 'backups');
const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
/** Un reloj que avanza un minuto por llamada: cada copia cae en un segundo distinto, en orden. */
function clock(startIso = '2026-10-02T12:00:00Z') {
  let t = Date.parse(startIso);
  return () => { const d = new Date(t); t += 60 * 1000; return d; };
}

// ─── T20 · Snapshot_ManifestFixedListDedupRetention5_InstallPinned ────────────────────────────────────────────────

test('T20 · files() es la lista fija de la medición §2 (AC 17), con sus rutas por defecto', () => {
  const home = '/Users/Lab-user';
  const tree = makeTree('list');
  // La tabla de la medición (tasks/measurement-8.13-un-solo-mecanismo/medicion-2026-09-30.md §2) y el AC 17 de la
  // story: settings.json y CLAUDE.md (bloques TYCON_BLOCK), tycon.json, el espejo y el despliegue de Codex (AGENTS.md,
  // hooks.json, config.toml), los git hooks globales y sus `.local`, los `~/.claude/commands/*.md` DEL ARNÉS (2) y
  // los dos LaunchAgents. Lo que la medición marca fuera (candado, sellos, logs, sqlite3, engram, los perfiles de
  // Codex por agente, los AGENTS.md punteros de los repos de producto) no entra: no es «cómo estaba la máquina».
  // Los comandos son un SUPERCONJUNTO a propósito de «los del arnés» de la medición (pase adversarial F8): además de
  // los que trae el árbol, cada `~/.claude/commands/*.md` que ya exista — un comando nuevo de una actualización puede
  // llamarse igual que uno propio del dev y pisarlo. Este HOME de laboratorio no existe: sólo aparecen los del árbol.
  const expected = [
    '/Users/Lab-user/.claude/settings.json',
    '/Users/Lab-user/.claude/CLAUDE.md',
    '/Users/Lab-user/.claude/tycon.json',
    '/Users/Lab-user/.codex/AGENTS.md',
    '/Users/Lab-user/.codex/hooks.json',
    '/Users/Lab-user/.codex/config.toml',
    '/Users/Lab-user/.git-hooks/pre-commit',
    '/Users/Lab-user/.git-hooks/post-commit',
    '/Users/Lab-user/.git-hooks/pre-push',
    '/Users/Lab-user/.git-hooks/pre-commit.local',
    '/Users/Lab-user/.git-hooks/post-commit.local',
    '/Users/Lab-user/.git-hooks/pre-push.local',
    '/Users/Lab-user/.claude/commands/tycon-instincts.md',
    '/Users/Lab-user/.claude/commands/tycon-vigilante.md',
    '/Users/Lab-user/Library/LaunchAgents/ar.com.tycon.harness-env.plist',
    '/Users/Lab-user/Library/LaunchAgents/ar.com.tycon.examen-periodico.plist',
  ];
  assert.deepStrictEqual(snapshot().files({ home, env: {}, tree }), expected);
  // una variable vacía vale lo mismo que no tenerla
  assert.deepStrictEqual(
    snapshot().files({ home, env: { TYCON_SETTINGS_PATH: '', CLAUDE_MD_PATH: '', CODEX_HOME: '', TYCON_GIT_HOOKS_DIR: '' }, tree }),
    expected);
});

test('T20 · files() respeta TYCON_SETTINGS_PATH, CLAUDE_MD_PATH, CODEX_HOME y TYCON_GIT_HOOKS_DIR', () => {
  const home = '/Users/Lab-user';
  const env = {
    TYCON_SETTINGS_PATH: '/srv/Lab/settings-x.json',
    CLAUDE_MD_PATH: '/srv/Lab/CLAUDE-x.md',
    CODEX_HOME: '/srv/Lab/codex',
    TYCON_GIT_HOOKS_DIR: '/srv/Lab/git-hooks',
  };
  const list = snapshot().files({ home, env, tree: makeTree('env', ['tycon-instincts.md']) });
  for (const p of ['/srv/Lab/settings-x.json', '/srv/Lab/CLAUDE-x.md', '/srv/Lab/codex/AGENTS.md', '/srv/Lab/codex/hooks.json',
    '/srv/Lab/codex/config.toml', '/srv/Lab/git-hooks/pre-commit', '/srv/Lab/git-hooks/post-commit', '/srv/Lab/git-hooks/pre-push',
    '/srv/Lab/git-hooks/pre-commit.local', '/srv/Lab/git-hooks/post-commit.local', '/srv/Lab/git-hooks/pre-push.local']) {
    assert.ok(list.includes(p), `falta ${p} en ${JSON.stringify(list)}`);
  }
  for (const p of ['/Users/Lab-user/.claude/settings.json', '/Users/Lab-user/.claude/CLAUDE.md', '/Users/Lab-user/.codex/hooks.json',
    '/Users/Lab-user/.git-hooks/pre-commit']) {
    assert.ok(!list.includes(p), `con la variable puesta no debería estar ${p}`);
  }
  assert.ok(list.includes('/Users/Lab-user/.claude/commands/tycon-instincts.md'));
  assert.ok(!list.some((p) => p.endsWith('tycon-vigilante.md')), 'sólo los comandos que trae el árbol');
});

test('T20 · take() copia tal cual, escribe el manifiesto, marca existed:false y finish() escribe sha256_after', () => {
  const S = snapshot();
  const home = makeHome('take'); const tree = makeTree('take');
  const settings = path.join(home, '.claude', 'settings.json');
  write(settings, '{"hooks":{}}\n');
  write(path.join(home, '.git-hooks', 'pre-commit'), '#!/bin/sh\necho del dev\n');
  const r = S.take({ home, env: {}, tree, reason: 'install', from: null, to: '2026.10.02+abc1234', now: new Date('2026-10-02T12:34:56Z') });
  assert.strictEqual(r.created, true);
  assert.strictEqual(path.dirname(r.dir), backupsDir(home));
  assert.strictEqual(path.basename(r.dir), '20261002-123456');
  assert.ok(!fs.existsSync(`${r.dir}.tmp`), 'no quedó el temporal de la escritura atómica');
  const m = manifestOf(r.dir);
  assert.strictEqual(m.schema, 1);
  assert.strictEqual(m.reason, 'install');
  assert.strictEqual(m.from, null);
  assert.strictEqual(m.to, '2026.10.02+abc1234');
  assert.ok(typeof m.at === 'string' && !Number.isNaN(Date.parse(m.at)), `at: ${m.at}`);
  assert.match(m.hash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(m.files.map((f) => f.path), S.files({ home, env: {}, tree }));
  const s = m.files.find((f) => f.path === settings);
  assert.strictEqual(s.existed, true);
  assert.strictEqual(s.sha256, sha('{"hooks":{}}\n'));
  assert.strictEqual(s.sha256_after, null);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, s.copy), 'utf8'), '{"hooks":{}}\n', 'la copia es el archivo tal cual');
  const toml = m.files.find((f) => f.path === path.join(home, '.codex', 'config.toml'));
  assert.deepStrictEqual({ existed: toml.existed, sha256: toml.sha256, copy: toml.copy }, { existed: false, sha256: null, copy: null });
  // el cambio y el «después»
  write(settings, '{"hooks":{"x":1}}\n');
  fs.rmSync(path.join(home, '.git-hooks', 'pre-commit'));
  write(path.join(home, '.codex', 'config.toml'), 'model = "lab"\n');
  S.finish(r.dir, { home, env: {} });
  const after = manifestOf(r.dir);
  const byPath = Object.fromEntries(after.files.map((f) => [f.path, f]));
  assert.strictEqual(byPath[settings].sha256_after, sha('{"hooks":{"x":1}}\n'));
  assert.strictEqual(byPath[settings].sha256, sha('{"hooks":{}}\n'), 'finish no pisa el «antes»');
  assert.strictEqual(byPath[path.join(home, '.git-hooks', 'pre-commit')].sha256_after, null, 'borrado después: null');
  assert.strictEqual(byPath[path.join(home, '.codex', 'config.toml')].sha256_after, sha('model = "lab"\n'));
});

test('T20 · siete cambios tras install: quedan 5 más la install más vieja; dos iguales no duplican; los .bak del dev intactos y contados', () => {
  const S = snapshot();
  const home = makeHome('retention'); const tree = makeTree('retention');
  const now = clock();
  const settings = path.join(home, '.claude', 'settings.json');
  // los .bak que el dev ya tiene al lado de sus archivos (de corridas sueltas del aplicador) y uno ajeno a la lista
  const devBaks = {
    [path.join(home, '.claude', 'settings.json.bak.2026-01-01T00-00-00')]: 'settings viejo\n',
    [path.join(home, '.claude', 'CLAUDE.md.bak.2026-02-02T00-00-00')]: 'claude viejo\n',
    [path.join(home, '.git-hooks', 'pre-commit.bak-20250303000000')]: 'hook viejo\n',
  };
  for (const [f, t] of Object.entries(devBaks)) write(f, t);
  write(path.join(home, '.claude', 'otra-cosa.bak'), 'no está al lado de nada de la lista\n');
  assert.strictEqual(S.countBak({ home, env: {}, tree }), 3, 'cuenta sólo los .bak al lado de los archivos de la lista');

  write(settings, 'v0\n');
  const install = S.take({ home, env: {}, tree, reason: 'install', from: null, to: 'v0', now: now() });
  assert.strictEqual(install.created, true);
  // el mismo conjunto otra vez: no crea otra, devuelve la misma
  const same = S.take({ home, env: {}, tree, reason: 'startup', from: 'v0', to: 'v0', now: now() });
  assert.strictEqual(same.created, false, 'el mismo conjunto no crea otra copia');
  assert.strictEqual(same.dir, install.dir, 'devuelve la copia más reciente');

  const made = [];
  for (let i = 1; i <= 7; i++) {
    write(settings, `v${i}\n`);
    // la segunda también es `install` (una reinstalación): cuenta dentro de las 5, no queda fija
    const r = S.take({ home, env: {}, tree, reason: i === 1 ? 'install' : 'update', from: `v${i - 1}`, to: `v${i}`, now: now() });
    assert.strictEqual(r.created, true, `cambio ${i}: tenía que crear copia`);
    made.push(r.dir);
    // dos iguales seguidos: el segundo no duplica
    const again = S.take({ home, env: {}, tree, reason: 'apply', from: `v${i}`, to: `v${i}`, now: now() });
    assert.strictEqual(again.created, false, `cambio ${i} repetido: no tenía que duplicar`);
    assert.strictEqual(again.dir, r.dir);
  }
  S.prune(home);
  const left = fs.readdirSync(backupsDir(home)).sort();
  const expected = [install.dir, ...made.slice(2)].map((d) => path.basename(d)).sort();
  assert.deepStrictEqual(left, expected, 'quedan las 5 más nuevas y la install más vieja');
  assert.ok(!fs.existsSync(made[0]), 'la segunda install (no la más vieja) rota como cualquiera');
  assert.ok(!fs.existsSync(made[1]), 'la más vieja no fija se borró');
  assert.ok(fs.existsSync(install.dir), 'la install más vieja no rota');
  // list(): más nueva primero
  const listed = S.list(home);
  assert.deepStrictEqual(listed.map((b) => b.dir), [...made.slice(2).reverse(), install.dir]);
  assert.strictEqual(listed[listed.length - 1].manifest.reason, 'install');
  // una pasada más de prune no cambia nada
  S.prune(home);
  assert.deepStrictEqual(fs.readdirSync(backupsDir(home)).sort(), expected);
  // los .bak del dev: intactos, byte a byte, y contados
  for (const [f, t] of Object.entries(devBaks)) assert.strictEqual(fs.readFileSync(f, 'utf8'), t, `${f} cambió`);
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'otra-cosa.bak'), 'utf8'), 'no está al lado de nada de la lista\n');
  assert.strictEqual(S.countBak({ home, env: {}, tree }), 3);
});

test('T20 · dos copias en el mismo segundo no se pisan (sufijo -2)', () => {
  const S = snapshot();
  const home = makeHome('same-second'); const tree = makeTree('same-second');
  const at = new Date('2026-10-02T08:00:00Z');
  const settings = path.join(home, '.claude', 'settings.json');
  write(settings, 'a\n');
  const a = S.take({ home, env: {}, tree, reason: 'update', from: '1', to: '2', now: at });
  write(settings, 'b\n');
  const b = S.take({ home, env: {}, tree, reason: 'update', from: '2', to: '3', now: at });
  assert.strictEqual(path.basename(a.dir), '20261002-080000');
  assert.strictEqual(path.basename(b.dir), '20261002-080000-2');
  const ca = manifestOf(a.dir).files.find((f) => f.path === settings);
  const cb = manifestOf(b.dir).files.find((f) => f.path === settings);
  assert.strictEqual(fs.readFileSync(path.join(a.dir, ca.copy), 'utf8'), 'a\n');
  assert.strictEqual(fs.readFileSync(path.join(b.dir, cb.copy), 'utf8'), 'b\n');
  assert.deepStrictEqual(S.list(home).map((x) => x.dir), [b.dir, a.dir], 'la del sufijo es la más nueva');
});

test('T20 · take() respeta las variables: copia el settings.json y el pre-commit de donde apuntan', () => {
  const S = snapshot();
  const home = makeHome('take-env'); const tree = makeTree('take-env', []);
  const env = {
    TYCON_SETTINGS_PATH: path.join(home, 'otro', 'settings.json'),
    CLAUDE_MD_PATH: path.join(home, 'otro', 'CLAUDE.md'),
    CODEX_HOME: path.join(home, 'codex-lab'),
    TYCON_GIT_HOOKS_DIR: path.join(home, 'hooks-lab'),
  };
  write(env.TYCON_SETTINGS_PATH, 'S\n'); write(env.CLAUDE_MD_PATH, 'C\n');
  write(path.join(env.CODEX_HOME, 'AGENTS.md'), 'A\n'); write(path.join(env.TYCON_GIT_HOOKS_DIR, 'pre-commit'), 'P\n');
  const r = S.take({ home, env, tree, reason: 'apply', from: '1', to: '1', now: new Date('2026-10-02T09:00:00Z') });
  const m = manifestOf(r.dir);
  for (const [p, t] of [[env.TYCON_SETTINGS_PATH, 'S\n'], [env.CLAUDE_MD_PATH, 'C\n'], [path.join(env.CODEX_HOME, 'AGENTS.md'), 'A\n'],
    [path.join(env.TYCON_GIT_HOOKS_DIR, 'pre-commit'), 'P\n']]) {
    const f = m.files.find((x) => x.path === p);
    assert.ok(f && f.existed, `${p} no está en el manifiesto o no figura como existente`);
    assert.strictEqual(fs.readFileSync(path.join(r.dir, f.copy), 'utf8'), t);
  }
  write(path.join(env.TYCON_GIT_HOOKS_DIR, 'pre-commit.bak-20250101000000'), 'viejo\n');
  assert.strictEqual(S.countBak({ home, env, tree }), 1, 'countBak mira donde apuntan las variables');
});

// ─── regresiones del pase adversarial (step-05b, filas F7-F9) ──────────────────────────────────────────────────────

test('T20 · F7 · copia el AGENTS.md que escribe el espejo (CODEX_AGENTS_MD_PATH o ~/.codex/AGENTS.md), no sólo el de CODEX_HOME', () => {
  // 🔴 rojo previo (probe traversal-completeness-2): con CODEX_HOME puesta, la copia miraba $CODEX_HOME/AGENTS.md y
  //    sync-claude-md-blocks.sh pisaba ~/.codex/AGENTS.md (no mira CODEX_HOME) sin copia y sin .bak.
  const S = snapshot();
  const home = makeHome('f7'); const tree = makeTree('f7', []);
  const mirror = path.join(home, '.codex', 'AGENTS.md');
  write(mirror, 'texto propio del dev\n');
  const env = { CODEX_HOME: path.join(home, 'alt-codex') };
  const list = S.files({ home, env, tree });
  assert.ok(list.includes(mirror), `falta el espejo ${mirror} en ${JSON.stringify(list)}`);
  assert.ok(list.includes(path.join(home, 'alt-codex', 'AGENTS.md')), 'el de CODEX_HOME también (no estorba)');
  assert.ok(list.includes(path.join(home, 'alt-codex', 'hooks.json')) && !list.includes(path.join(home, '.codex', 'hooks.json')),
    'hooks.json sigue en CODEX_HOME');
  const r = S.take({ home, env, tree, reason: 'update', now: new Date('2026-10-02T10:00:00Z') });
  const f = manifestOf(r.dir).files.find((x) => x.path === mirror);
  assert.ok(f && f.existed, 'el espejo tenía que copiarse');
  assert.strictEqual(fs.readFileSync(path.join(r.dir, f.copy), 'utf8'), 'texto propio del dev\n');
  // CODEX_AGENTS_MD_PATH manda sobre ~/.codex/AGENTS.md (como en el sync); vacía = sin poner
  const custom = '/srv/Lab/espejo/AGENTS.md';
  const withVar = S.files({ home, env: { CODEX_AGENTS_MD_PATH: custom }, tree });
  assert.ok(withVar.includes(custom), `falta ${custom} en ${JSON.stringify(withVar)}`);
  assert.strictEqual(withVar.filter((p) => p.endsWith('AGENTS.md')).length, 2, 'el de la variable y el de CODEX_HOME (por defecto ~/.codex)');
  const emptyVar = S.files({ home, env: { CODEX_AGENTS_MD_PATH: '' }, tree });
  assert.deepStrictEqual(emptyVar.filter((p) => p.endsWith('AGENTS.md')), [mirror], 'sin variables: un solo AGENTS.md, sin duplicados');
});

test('T20 · F8 · copia también los ~/.claude/commands/*.md del dev que ya existen (unión con los del árbol, sin duplicados)', () => {
  // 🔴 rojo previo (probe traversal-completeness-4): la lista salía del árbol de ANTES del pull; un comando nuevo de la
  //    actualización con el mismo nombre que uno propio del dev lo pisaba sin copia.
  const S = snapshot();
  const home = makeHome('f8'); const tree = makeTree('f8', ['tycon-instincts.md']);
  const commands = path.join(home, '.claude', 'commands');
  write(path.join(commands, 'y.md'), 'DEV PROPIO\n');
  write(path.join(commands, 'tycon-instincts.md'), 'del arnés, ya instalado\n');
  write(path.join(commands, 'notas.txt'), 'no es un comando\n');
  const list = S.files({ home, env: {}, tree }).filter((p) => p.startsWith(commands + path.sep));
  assert.deepStrictEqual(list, [path.join(commands, 'tycon-instincts.md'), path.join(commands, 'y.md')], 'unión ordenada, sin duplicados');
  const r = S.take({ home, env: {}, tree, reason: 'update', now: new Date('2026-10-02T10:00:00Z') });
  const f = manifestOf(r.dir).files.find((x) => x.path === path.join(commands, 'y.md'));
  assert.ok(f && f.existed, 'el comando propio del dev tenía que copiarse');
  assert.strictEqual(fs.readFileSync(path.join(r.dir, f.copy), 'utf8'), 'DEV PROPIO\n');
});

test('T20 · F9 · con el reloj corregido hacia atrás, la copia recién tomada es la más nueva: no se borra y take no devuelve una carpeta que no existe', () => {
  // 🔴 rojo previo (probes determinism-ordering-1 y false-positive-edge-4): el orden salía del nombre de la carpeta (el
  //    reloj); con seis copias «del futuro», prune borraba en el acto la recién tomada y take devolvía su ruta borrada.
  const S = snapshot();
  const home = makeHome('f9'); const tree = makeTree('f9', []);
  const settings = path.join(home, '.claude', 'settings.json');
  for (let i = 0; i < 6; i++) {
    write(settings, `futuro ${i}\n`);
    S.take({ home, env: {}, tree, reason: i === 0 ? 'install' : 'apply', now: Date.UTC(2027, 0, 1, 0, 0, i) });
  }
  write(settings, 'ahora\n');
  const r = S.take({ home, env: {}, tree, reason: 'apply', now: Date.UTC(2026, 9, 2, 12) });
  assert.strictEqual(r.created, true);
  assert.ok(fs.existsSync(r.dir), `take devolvió ${r.dir}, que no existe`);
  assert.ok(!r.pruned.includes(r.dir), 'prune borró la copia recién tomada');
  assert.strictEqual(S.list(home)[0].dir, r.dir, 'la recién tomada es la más nueva');
  assert.ok(S.list(home)[0].manifest.seq > S.list(home)[1].manifest.seq, 'el orden sale de la secuencia del manifiesto');
  assert.doesNotThrow(() => S.finish(r.dir, { home, env: {} }));
  // el chequeo de duplicado también mira la secuencia: el mismo conjunto devuelve la recién tomada
  const again = S.take({ home, env: {}, tree, reason: 'startup', now: Date.UTC(2026, 9, 2, 12, 1) });
  assert.deepStrictEqual([again.created, again.dir], [false, r.dir]);
  assert.strictEqual(S.list(home).length, 6, 'cinco más la install más vieja');
  assert.strictEqual(S.list(home)[S.list(home).length - 1].manifest.reason, 'install');
});

test('T20 · F9 · los manifiestos sin seq (copias viejas) ordenan por nombre y debajo de los que tienen seq', () => {
  const S = snapshot();
  const home = makeHome('f9-legacy'); const tree = makeTree('f9-legacy', []);
  const root = backupsDir(home);
  for (const name of ['20300101-000000', '20290101-000000']) {
    write(path.join(root, name, 'manifest.json'), JSON.stringify({ schema: 1, reason: 'apply', hash: name, files: [] }));
  }
  write(path.join(home, '.claude', 'settings.json'), 'x\n');
  const r = S.take({ home, env: {}, tree, reason: 'apply', now: Date.UTC(2026, 9, 2, 12) });
  assert.deepStrictEqual(S.list(home).map((b) => b.name), [path.basename(r.dir), '20300101-000000', '20290101-000000']);
  assert.strictEqual(S.list(home)[0].manifest.seq, 1, 'sin ninguna con seq, la primera es 1');
});

// ─── T23/T24 (tanda C, decisiones 1 y 2 del dueño): la copia siempre nueva al mover árboles y los commits en el manifiesto

test('T23 · take({ force: true }) crea una copia nueva aunque el conjunto sea igual al de la anterior, y se cierra con finish', () => {
  const S = snapshot();
  const home = makeHome('c-force'); const tree = makeTree('c-force', []);
  write(path.join(home, '.claude', 'settings.json'), '{"a":1}\n');
  const now = clock();
  const first = S.take({ home, env: {}, tree, reason: 'startup', now: now() });
  const same = S.take({ home, env: {}, tree, reason: 'update', now: now() });
  assert.deepStrictEqual([same.created, same.dir], [false, first.dir], 'sin force, el mismo conjunto no duplica (como en la B)');
  const forced = S.take({ home, env: {}, tree, reason: 'update', force: true, now: now() });
  assert.strictEqual(forced.created, true, 'con force la copia es nueva');
  assert.notStrictEqual(forced.dir, first.dir);
  assert.strictEqual(manifestOf(forced.dir).seq, manifestOf(first.dir).seq + 1, 'la forzada es la más nueva por seq');
  assert.strictEqual(manifestOf(forced.dir).hash, manifestOf(first.dir).hash, 'mismo conjunto, mismo hash');
  write(path.join(home, '.claude', 'settings.json'), '{"a":2}\n');
  const m = S.finish(forced.dir, { home, env: {} });
  const f = m.files.find((x) => x.path === path.join(home, '.claude', 'settings.json'));
  assert.strictEqual(f.sha256_after, sha('{"a":2}\n'), 'finish anota el «después» de la copia forzada');
  assert.strictEqual(S.list(home)[0].dir, forced.dir);
});

test('T24 · el manifiesto guarda los commits completos de cada fuente (sources), y una copia sin ellos queda en null', () => {
  const S = snapshot();
  const home = makeHome('c-sources'); const tree = makeTree('c-sources', []);
  write(path.join(home, '.claude', 'settings.json'), '{}\n');
  const now = clock();
  const sources = { harness: 'a'.repeat(40), agent_skills: 'b'.repeat(40) };
  const r = S.take({ home, env: {}, tree, reason: 'before-rollback', force: true, sources, now: now() });
  const man = manifestOf(r.dir);
  assert.deepStrictEqual(man.sources, sources);
  assert.strictEqual(man.reason, 'before-rollback');
  write(path.join(home, '.claude', 'settings.json'), '{"b":1}\n');
  const plain = S.take({ home, env: {}, tree, reason: 'apply', now: now() });
  assert.strictEqual(manifestOf(plain.dir).sources, null, 'sin sources, null (lo dice rollback: sólo archivos)');
  assert.throws(() => S.take({ home, env: {}, tree, reason: 'apply', sources: { harness: 'corto' }, now: now() }), /sources/,
    'un commit que no es un sha completo no se guarda: rollback --to no podría mover el árbol');
});

test('REG-H5 · la retención no poda la copia de antes de la versión instalada (la que rollback necesita)', () => {
  const S = snapshot();
  const home = makeHome('h5'); const tree = makeTree('h5', []);
  const settings = path.join(home, '.claude', 'settings.json');
  const now = clock();
  const v1 = { harness: '1'.repeat(40), agent_skills: '2'.repeat(40) };
  const v2 = { harness: '3'.repeat(40), agent_skills: '2'.repeat(40) };
  write(settings, '{"v":1}\n');
  const pre = S.take({ home, env: {}, tree, reason: 'update', force: true, sources: v1, now: now() });
  // seis arranques de la versión nueva, cada uno con settings.json cambiado (Claude Code escribe permisos)
  for (let i = 0; i < 6; i++) { write(settings, `{"v":2,"i":${i}}\n`); S.take({ home, env: {}, tree, reason: 'startup', sources: v2, now: now() }); }
  const dirs = S.list(home).map((b) => b.dir);
  assert.ok(dirs.includes(pre.dir), 'la copia con sources de la versión anterior sobrevive a la retención');
  assert.strictEqual(S.list(home).filter((b) => b.manifest.reason === 'startup').length, 5, 'las demás rotan como siempre: 5 más nuevas');
});

test('REG-H9 · take({ protect }) no poda la copia protegida (el destino de un rollback)', () => {
  const S = snapshot();
  const home = makeHome('h9'); const tree = makeTree('h9', []);
  const settings = path.join(home, '.claude', 'settings.json');
  const now = clock();
  const v = { harness: '4'.repeat(40) };
  const made = [];
  for (let i = 0; i < 5; i++) { write(settings, `{"i":${i}}\n`); made.push(S.take({ home, env: {}, tree, reason: 'apply', sources: v, now: now() }).dir); }
  const target = made[0];   // la quinta más nueva: la próxima copia la podaría
  S.take({ home, env: {}, tree, reason: 'before-rollback', force: true, sources: v, protect: [target], now: now() });
  assert.ok(fs.existsSync(target), 'la copia destino sigue');
});

// ─── T21 · Applier_NoLegacyBakUnderHarness_YesStandalone (la parte del install-tycon-hooks.sh) ─────────────────────

/**
 * Corre el `install-tycon-hooks.sh` REAL en un HOME de juguete (patrón de installer-cleanup-period.test.sh) con un
 * settings.json que obliga a escribir y un pre-commit/post-commit global VIEJO del arnés (difiere del actual: el
 * aplicador lo reemplaza y hoy deja un `.bak-<ts>`). Devuelve el HOME y la salida.
 */
function runApplier(name, extraEnv) {
  const home = makeHome(name);
  fs.mkdirSync(path.join(home, '.claude', 'agent-skills', 'skills', 'tycon-pipeline'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  write(settings, '{"hooks":{}}\n');
  const gitHooks = path.join(home, 'git-hooks-lab');
  write(path.join(gitHooks, 'pre-commit'), '#!/bin/sh\n# git-pre-commit-global.sh (versión vieja)\nexit 0\n');
  write(path.join(gitHooks, 'post-commit'), '#!/bin/sh\n# git-post-commit-global.sh (versión vieja)\nexit 0\n');
  if (extraEnv && extraEnv.TYCON_TEST_SEED_PRE_PUSH) {
    // un pre-push propio de la persona, de antes del arnés (story 8.26, T55)
    fs.copyFileSync(extraEnv.TYCON_TEST_SEED_PRE_PUSH, path.join(gitHooks, 'pre-push'));
    fs.chmodSync(path.join(gitHooks, 'pre-push'), 0o755);
    extraEnv = Object.assign({}, extraEnv, { TYCON_TEST_SEED_PRE_PUSH: undefined });
  }
  const bin = path.join(home, 'bin-lab');
  write(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, 'launchctl'), 0o755);
  const env = Object.assign({}, process.env, {
    HOME: home, PATH: `${bin}:${process.env.PATH}`, LAUNCHCTL_BIN: path.join(bin, 'launchctl'),
    TYCON_SETTINGS_PATH: settings, CLAUDE_MD_PATH: path.join(home, '.claude', 'CLAUDE.md'),
    TYCON_GIT_HOOKS_DIR: gitHooks, CODEX_HOME: path.join(home, 'codex-home'),
    TYCON_CODEX: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_NO_GUI_ENV: '1', TYCON_BENCH_DAILY: '0', TYCON_STAGE_METRICS: '0',
    TYCON_NO_CANONICAL_PATH: '1', TYCON_NO_AZ_PROJECTS_REFRESH: '1', TYCON_NO_BOOTSTRAP_HEAL: '1', TYCON_NO_CLAUDEMD_SYNC: '1',
    TYCON_NO_COMMANDS_SYNC: '1', TYCON_NO_ENGRAM_PROJECT_CHECK: '1', TYCON_NO_ENGRAM_VERSION_CHECK: '1', TYCON_NO_SQLITE_CHECK: '1',
    TYCON_NO_AGENTSMD_POINTER: '1', TYCON_NO_THREAD_RESCUE: '1', TYCON_NO_UPLOAD_RUNS: '1', TYCON_NO_DOWNLOAD_RUNS: '1',
    TYCON_NO_COLLECT_FINDINGS: '1', TYCON_MAILBOX_URL_BASE: 'http://127.0.0.1:9',
  }, extraEnv);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  delete env.TF_BUILD;
  const r = spawnSync('bash', [INSTALLER], { encoding: 'utf8', timeout: 300000, env });
  return { home, settings, gitHooks, rc: r.status, all: (r.stdout || '') + (r.stderr || '') };
}
const listBak = (dir, base) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.bak`)) : []);

test('T21 · bajo harness.js (TYCON_HARNESS_SNAPSHOT_DIR puesta) el aplicador no deja settings.json.bak.* ni pre-commit.bak-*', () => {
  const r = runApplier('t21-harness', { TYCON_HARNESS_SNAPSHOT_DIR: path.join(BASE, 'snapshot-lab') });
  assert.strictEqual(r.rc, 0, `el aplicador salió ${r.rc}: ${r.all.slice(-2000)}`);
  assert.notStrictEqual(fs.readFileSync(r.settings, 'utf8'), '{"hooks":{}}\n', 'el settings.json tenía que cambiar (si no, la prueba no prueba nada)');
  assert.deepStrictEqual(listBak(path.dirname(r.settings), 'settings.json'), [], 'quedó un settings.json.bak.* bajo harness.js');
  assert.deepStrictEqual(listBak(r.gitHooks, 'pre-commit'), [], 'quedó un pre-commit.bak-* bajo harness.js');
  assert.deepStrictEqual(listBak(r.gitHooks, 'post-commit'), [], 'quedó un post-commit.bak-* bajo harness.js');
  assert.ok(/git-pre-commit-global\.sh/.test(fs.readFileSync(path.join(r.gitHooks, 'pre-commit'), 'utf8')), 'el pre-commit se actualizó igual');
});

// story 8.26, tanda F1 (AC 52): el pre-push global —el freno antes de publicar— lo deja el mismo aplicador
test('T55 · el aplicador deja el pre-push global del arnés, y el que la persona ya tenía pasa a pre-push.local', () => {
  const own = '#!/bin/sh\n# el pre-push propio de la persona\nexit 0\n';
  const seed = path.join(BASE, 't55-seed-pre-push');
  write(seed, own);
  const r = runApplier('t55-pre-push', { TYCON_HARNESS_SNAPSHOT_DIR: path.join(BASE, 'snapshot-lab-t55'), TYCON_TEST_SEED_PRE_PUSH: seed });
  assert.strictEqual(r.rc, 0, `el aplicador salió ${r.rc}: ${r.all.slice(-2000)}`);
  const placed = fs.readFileSync(path.join(r.gitHooks, 'pre-push'), 'utf8');
  assert.strictEqual(placed, fs.readFileSync(path.join(RAIZ, 'scripts', 'hooks', 'git-pre-push-global.sh'), 'utf8'), 'el pre-push global es el del arnés, byte a byte');
  assert.ok((fs.statSync(path.join(r.gitHooks, 'pre-push')).mode & 0o111) !== 0, 'el pre-push global quedó ejecutable');
  assert.strictEqual(fs.readFileSync(path.join(r.gitHooks, 'pre-push.local'), 'utf8'), own, 'el propio sigue, como pre-push.local');
  assert.ok((fs.statSync(path.join(r.gitHooks, 'pre-push.local')).mode & 0o111) !== 0, 'y sigue ejecutable');
  assert.match(r.all, /tu pre-push global anterior sigue corriendo desde/);
  assert.deepStrictEqual(listBak(r.gitHooks, 'pre-push'), [], 'no queda un pre-push.bak-*: el propio no se perdió, pasó a .local');
});

test('T21 · suelto (sin la variable) el aplicador sigue dejando su settings.json.bak.* y su pre-commit.bak-*, como hoy', () => {
  const r = runApplier('t21-standalone', { TYCON_HARNESS_SNAPSHOT_DIR: undefined });
  assert.strictEqual(r.rc, 0, `el aplicador salió ${r.rc}: ${r.all.slice(-2000)}`);
  assert.strictEqual(listBak(path.dirname(r.settings), 'settings.json').length, 1, 'suelto tenía que dejar su settings.json.bak.*');
  assert.strictEqual(listBak(r.gitHooks, 'pre-commit').length, 1, 'suelto tenía que dejar su pre-commit.bak-*');
});
