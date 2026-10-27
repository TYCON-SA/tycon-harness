'use strict';
// windows-stuck-update.test.js — una actualización trabada por un archivo tomado dice qué hacer; el registro del buzón trae el
// sistema de la máquina; la guía de Windows tiene la salida. Hogares de juguete en carpetas temporales; sin red.
// stable-data: las dos lecturas del reloj fechan una falla o un candado contra la hora de archivos recién escritos, con
// minutos de margen: no dependen del día en que corre.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'report.js'));

const held = { since: '2026-10-14T12:49:56.000Z', count: 26, kind: 'update', last: '2026-10-20T09:00:00.000Z',
  reason: 'no pude apartar la versión activa (EPERM: C:\\Users\\usuario\\.tycon\\harness → C:\\Users\\usuario\\.tycon\\previous): un archivo está tomado; la actualización espera al próximo arranque' };

test('T1 UpdateFailure_HeldFile_SaysWhatToDo @story-8.79 @ac-1: un archivo tomado dice qué cerrar y qué correr', () => {
  const t = R.updateFailureText(held);
  assert.match(t, /no se pudo actualizar desde 2026-10-14/);
  for (const words of ['VS Code', 'agente', 'terminales', 'npx @tyconsa/harness@latest', 'reinici']) assert.ok(t.includes(words), `falta «${words}»: ${t}`);
  // también con los otros códigos de un archivo tomado
  for (const code of ['EBUSY', 'EACCES']) assert.match(R.updateFailureText({ ...held, reason: `no pude apartar la versión activa (${code})` }), /npx @tyconsa\/harness@latest/);
});

test('T2 UpdateFailure_OtherReason_Unchanged @story-8.79 @ac-2: otro motivo queda como hoy, sin los pasos', () => {
  const t = R.updateFailureText({ since: '2026-10-06T10:00:00.000Z', count: 3, reason: 'sin red', kind: 'update' });
  assert.strictEqual(t, 'no se pudo actualizar desde 2026-10-06T10:00:00.000Z (3 arranques): sin red — harness.js doctor lo detalla');
  assert.strictEqual(R.updateFailureText({ ...held, count: 1 }), null, 'con un solo arranque fallido no se dice nada');
});

test('T3 PlaceFacts_HasPlatform @story-8.79 @ac-3: el registro del buzón trae el sistema de la máquina', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-home-'));
  const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const st = stateDir(home);
  fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'harness-state.json'), JSON.stringify({ mode: 'managed', version: { number: '2026.10.20.1' } }));
  const old = process.env.HOME; const oldUp = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const U = require(path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js'));
    const facts = U.placeFactsForMailbox('2026-10-20');
    assert.ok(facts, 'sin registro');
    assert.strictEqual(facts.platform, process.platform);
  } finally { process.env.HOME = old; if (oldUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUp; }
});

test('T5 InstallSuccess_ClearsOldFailure @story-8.79 @ac-5: una instalación que sale bien borra el aviso viejo', () => {
  const fs2 = require('fs');
  for (const file of ['scripts/setup/harness/release.js', 'scripts/setup/harness.js']) {
    const src = fs2.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, /una instalación que salió bien deja la máquina al día[\s\S]{0,200}clearUpdateFailure\(ctx\.home\)/, file);
  }
  // y el efecto: una falla anotada se borra con clearUpdateFailure
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-clear-'));
  R.recordUpdateFailure(home, 'no pude apartar la versión activa (EPERM)');
  R.recordUpdateFailure(home, 'no pude apartar la versión activa (EPERM)');
  assert.ok(R.updateFailureText(R.readUpdateFailure(home)));
  R.clearUpdateFailure(home);
  assert.strictEqual(R.readUpdateFailure(home), null);
});

test('T6 HarnessNode_HeldRename_RetriesThenSaysWhatToDo @story-8.79 @ac-6: el Node propio espera al archivo tomado y, si sigue, dice qué hacer', () => {
  const HN = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'harness-node.js'));
  const err = (code) => Object.assign(new Error(code), { code });
  let calls = 0;
  const twice = HN.renameWaiting('a', 'b', { rename: () => { calls += 1; if (calls < 3) throw err('EPERM'); }, sleep: () => {}, waitsMs: [1, 1, 1] });
  assert.deepStrictEqual([twice.ok, calls], [true, 3], 'reintenta y sale bien');
  const always = HN.renameWaiting('a', 'b', { rename: () => { throw err('EPERM'); }, sleep: () => {}, waitsMs: [1, 1] });
  assert.strictEqual(always.ok, false);
  assert.match(always.reason, /archivo está tomado.*npx @tyconsa\/harness@latest/);
  const other = HN.renameWaiting('a', 'b', { rename: () => { throw err('ENOSPC'); }, sleep: () => { throw new Error('no espera'); }, waitsMs: [1] });
  assert.strictEqual(other.ok, false);
  assert.doesNotMatch(other.reason, /npx/, 'otro error no reintenta ni da los pasos');
});

// Un hogar de juguete con la versión activa como en Windows: `~/.tycon/harness` es un enlace a `versions/<v>/`.
function homeWithActive(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-active-'));
  pointActive(home, version);
  return home;
}
function pointActive(home, version) {
  const own = path.join(home, '.tycon');
  const dir = path.join(own, 'versions', version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version }));
  const link = path.join(own, 'harness');
  try { fs.unlinkSync(link); } catch (_) { /* no estaba */ }
  fs.symlinkSync(dir, link, 'dir');
}
const withOwnHome = (fn) => {
  const old = process.env.TYCON_HOME; delete process.env.TYCON_HOME;
  try { return fn(); } finally { if (old !== undefined) process.env.TYCON_HOME = old; }
};

test('T7 UpdateFailure_ActiveChangedSince_NotShown: una falla anotada con otra versión activa no se muestra', () => withOwnHome(() => {
  const home = homeWithActive('2026.10.20.36');
  R.recordUpdateFailure(home, 'la versión 2026.10.22.42 no quedó sana');
  R.recordUpdateFailure(home, 'la versión 2026.10.22.42 no quedó sana');
  assert.ok(R.updateFailureText(R.readUpdateFailure(home)), 'con la misma versión activa, el aviso sale');
  pointActive(home, '2026.10.27.22');
  assert.strictEqual(R.updateFailureText(R.readUpdateFailure(home)), null, 'la versión activa cambió después de la falla: el aviso no es cierto');
  // un arranque que falla después cuenta desde cero, con la versión de hoy
  const next = R.recordUpdateFailure(home, 'sin red');
  assert.strictEqual(next.count, 1);
  assert.strictEqual(R.updateFailureText(R.readUpdateFailure(home)), null, 'un solo arranque fallido no se dice');
}));

test('T8 UpdateFailure_LegacyRecord_ActiveSwappedAfter_NotShown: una falla vieja, sin la versión anotada, tampoco', () => withOwnHome(() => {
  const home = homeWithActive('2026.10.27.22');
  const file = path.join(require(path.join(ROOT, 'scripts', 'setup', 'harness', 'state.js')).paths(home).failuresFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // como la de la máquina del reporte: anotada el 22/10, antes de que el enlace pasara a la versión de hoy
  fs.writeFileSync(file, JSON.stringify({ since: '2026-10-22T10:00:00.000Z', count: 2, reason: 'la versión 2026.10.22.42 no quedó sana', last: '2026-10-22T11:00:00.000Z', kind: 'update' }));
  assert.strictEqual(R.updateFailureText(R.readUpdateFailure(home)), null, 'el enlace cambió después de la última falla');
  // el espejo: una falla anotada DESPUÉS del último cambio de versión sigue saliendo
  const later = new Date(Date.now() + 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ since: '2026-10-22T10:00:00.000Z', count: 2, reason: 'sin red', last: later, kind: 'update' }));
  assert.match(R.updateFailureText(R.readUpdateFailure(home)), /no se pudo actualizar desde 2026-10-22/);
}));

test('T9 UpdateFailure_NoReleaseInstall_Unchanged: en un clon (sin versión bajada) el aviso queda como hoy', () => withOwnHome(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-clone-'));
  R.recordUpdateFailure(home, 'sin red');
  R.recordUpdateFailure(home, 'sin red');
  assert.match(R.updateFailureText(R.readUpdateFailure(home)), /\(2 arranques\): sin red/);
}));

test('T10 UpdateFailure_StaleRecord_ClearedSoRollbackDoesNotRevive: una falla de otra versión se borra, y volver atrás no la revive', () => withOwnHome(() => {
  const home = homeWithActive('2026.10.20.36');
  const file = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'state.js')).paths(home).failuresFile;
  R.recordUpdateFailure(home, 'la versión 2026.10.22.42 no quedó sana');
  R.recordUpdateFailure(home, 'la versión 2026.10.22.42 no quedó sana');
  // el espejo: con la misma versión, borrar la clase `busy` no toca una falla `update`
  R.clearUpdateFailure(home, { kind: 'busy' });
  assert.ok(fs.existsSync(file), 'una falla vigente de otra clase queda');
  pointActive(home, '2026.10.27.22');
  R.clearUpdateFailure(home, { kind: 'busy' });
  assert.ok(!fs.existsSync(file), 'la falla era de otra versión: se borra aunque sea de otra clase');
  pointActive(home, '2026.10.20.36');
  assert.strictEqual(R.readUpdateFailure(home), null, 'volver a la versión anterior no revive el aviso');
}));

// Una instalación sin enlaces (harness/ es una carpeta): su version.json dice el piso, el número de verdad está en el
// manifiesto de la versión bajada
function singleInstall(version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-single-'));
  const dir = path.join(home, '.tycon', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '2026.10.15.48', numbering: 'merge-tag' }));
  setManifestVersion(dir, version);
  return { home, dir };
}
function setManifestVersion(dir, version) { fs.writeFileSync(path.join(dir, '.tycon-release.json'), JSON.stringify({ schema: 1, version, files: [] })); }

test('T11 UpdateFailure_SingleLayout_ReadsManifestVersion: sin enlaces, la versión activa sale del manifiesto y no del piso', () => withOwnHome(() => {
  const { home, dir } = singleInstall('2026.10.27.22');
  R.recordUpdateFailure(home, 'sin red');
  R.recordUpdateFailure(home, 'sin red');
  assert.ok(R.updateFailureText(R.readUpdateFailure(home)), 'con la misma versión, el aviso sale');
  setManifestVersion(dir, '2026.10.27.23');
  assert.strictEqual(R.readUpdateFailure(home), null, 'la versión bajada cambió: el aviso no es cierto aunque version.json siga en el piso');
}));

test('T12 Derive_ReleaseTree_NumberFromManifest: el número de una versión bajada es el de su manifiesto, no el piso', () => {
  const { dir } = singleInstall('2026.10.27.23');
  assert.strictEqual(R.derive({ tree: dir, sources: [], mode: 'managed' }).number, '2026.10.27.23');
  // el espejo: un árbol sin manifiesto (un clon) sigue diciendo su version.json
  fs.rmSync(path.join(dir, '.tycon-release.json'));
  assert.strictEqual(R.derive({ tree: dir, sources: [], mode: 'managed' }).number, '2026.10.15.48');
  // una versión bajada sin número (por commit) no muestra el piso: fecha de la bajada y commit, como un árbol sin número
  fs.writeFileSync(path.join(dir, '.tycon-release.json'), JSON.stringify({ schema: 1, version: null, commit: 'abcdef1234567890', downloaded_at: '2026-10-27T14:28:57.550Z', files: [] }));
  assert.strictEqual(R.derive({ tree: dir, sources: [], mode: 'managed' }).number, '2026.10.27+abcdef1');
});

test('T13 Log_RotationInProgress_DoesNotClobberPrevious: si otra sesión está rotando el registro, no se pisa su .1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'));
  const file = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'state.js')).paths(home).log;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.1`, 'historial de la otra sesión\n');
  fs.writeFileSync(file, 'x'.repeat(R.LOG_MAX_BYTES + 1) + '\n');
  fs.mkdirSync(`${file}.rotating`);
  R.log(home, 'mientras otra rota');
  assert.strictEqual(fs.readFileSync(`${file}.1`, 'utf8'), 'historial de la otra sesión\n', 'el .1 de la otra sesión quedó');
  assert.match(fs.readFileSync(file, 'utf8'), /mientras otra rota\n$/, 'la línea se agregó al final');
  // un candado abandonado (más de un minuto) no frena la rotación para siempre
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(`${file}.rotating`, old, old);
  R.log(home, 'después');
  assert.ok(fs.statSync(`${file}.1`).size > R.LOG_MAX_BYTES, 'rotó: el .1 es el registro grande');
  assert.match(fs.readFileSync(file, 'utf8'), /^\S+ después\n$/, 'el registro nuevo arranca con la línea');
  assert.ok(!fs.existsSync(`${file}.rotating`), 'el candado no queda');
});

test('T14 Log_NullFilled_SetAsideAndSaysSo: un registro con bytes nulos se aparta y el nuevo lo dice', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'log-nul-'));
  const file = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'state.js')).paths(home).log;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const broken = Buffer.concat([Buffer.from('2026-10-27T15:34:22.458Z update: una línea\n'), Buffer.alloc(200000)]);
  fs.writeFileSync(file, broken);
  R.log(home, 'arranque');
  assert.ok(fs.readFileSync(`${file}.corrupt`).equals(broken), 'el registro roto quedó aparte, entero');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('\0'), 'el registro nuevo no tiene nulos');
  assert.match(text, /bytes nulos/, 'una línea dice qué pasó');
  assert.match(text, /\.corrupt/, 'y dónde quedó el roto');
  assert.match(text, /arranque\n$/);
  // el espejo: un registro sano no se aparta
  R.log(home, 'otro');
  assert.match(fs.readFileSync(file, 'utf8'), /arranque\n\S+ otro\n$/);
  // un segundo registro roto no pisa al primero apartado
  fs.writeFileSync(file, Buffer.concat([Buffer.from('segundo\n'), Buffer.alloc(10)]));
  R.log(home, 'tercero');
  assert.ok(fs.readFileSync(`${file}.corrupt`).equals(broken), 'el primero apartado sigue entero');
  const again = fs.readdirSync(path.dirname(file)).filter((n) => /^startup\.log\.corrupt\.\d+$/.test(n));
  assert.strictEqual(again.length, 1, `el segundo quedó con su propio nombre: ${again}`);
});

test('T15 AuditTree_ModGeneratedFiles_NotExtra: lo que Claude Code escribe al cargar un mod no es «de más»', () => {
  const REL = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));
  const GH = require(path.join(ROOT, 'scripts', 'lib', 'git-tree-hash.js'));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mods-'));
  const put = (rel, text) => { const abs = path.join(tree, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
  put('mods/harness-mods/hooks/hooks.json', '{}');
  fs.writeFileSync(path.join(tree, REL.MANIFEST_NAME), JSON.stringify({ schema: 1, version: '2026.10.27.23', tree: 'x', files: [{ path: 'mods/harness-mods/hooks/hooks.json', blob: GH.blobSha(Buffer.from('{}')) }] }));
  for (const rel of ['mods/harness-mods/tsconfig.json', 'mods/harness-mods/.claude-plugin/types/.gitignore', 'mods/harness-mods/.claude-plugin/types/tsconfig.json',
    'mods/harness-mods/.claude-plugin/types/claude-code/index.d.ts', 'mods/harness-mods/.claude-plugin/types/claude-code-mcp/index.d.ts']) put(rel, 'x');
  // el espejo: otro archivo ajeno dentro del mod sí es de más
  put('mods/harness-mods/notes.txt', 'x');
  const a = REL.auditTree({ env: process.env, home: tree }, tree);
  assert.ok(a.ok, a.reason);
  assert.deepStrictEqual(a.extra, ['mods/harness-mods/notes.txt']);
});

test('T4 WindowsGuide_StuckUpdateSection @story-8.79 @ac-4: la guía de Windows tiene la salida', () => {
  const g = fs.readFileSync(path.join(ROOT, 'getting-started', 'windows.md'), 'utf8');
  assert.match(g, /## Si el arnés no se actualiza/);
  const sec = g.split('## Si el arnés no se actualiza')[1].split('\n## ')[0];
  for (const words of ['npx @tyconsa/harness@latest', 'VS Code', 'Inicio', 'reinici', 'EPERM']) assert.ok(sec.includes(words), `falta «${words}»`);
});
