#!/usr/bin/env node
/**
 * old-judge-report.test.js — el informe del aplicador no le manda a un juez viejo hooks que no entiende.
 *
 * El caso: una versión bajada (2026.10.20.52) con integraciones prendidas y el arnés detrás de un enlace (Windows) no
 * podía actualizar. La salud que juzga una actualización es la del programa viejo; su `hookFile` sólo conoce `@tcg:` y
 * mandaba `@int:<integración>/…` a una ruta que no existe, así que cada versión nueva volvía sola. Los ids le llegaban en
 * el informe del aplicador NUEVO. Ahora el aplicador sólo informa los prefijos que quien lo lanza declara entender
 * (`TYCON_REPORT_HOOK_PREFIXES`, que pone el `harness.js` nuevo con los de su salud); el arranque siguiente corre la salud
 * nueva si la última no la corrió esta versión.
 *
 * stable-data: git sólo se lee (`cat-file` y `archive` de un commit fijo); la prueba no crea commits ni lee el reloj
 * para comparar contra una fecha fija (las horas de T5/T6 son textos fijos).
 *
 * Los módulos de la versión vieja (OLD_REF) salen de git (`git archive`), sin tocar: si el commit no está en el clon, la prueba queda NO
 * MEDIDA (salteada con el motivo), nunca verde.
 *
 * 🔴 Mutaciones que los ponen en rojo: informar `@int:` sin la variable (T1, T4, T8), no informarlo con ella (T2), que
 * `harness.js` no pase los prefijos de su salud (T3), saltear la salud del arranque con la marca de otra versión (T5),
 * volver atrás sola cuando esa salud falla (T6), cambiar cómo se lee un `@int:` guardado como «hook» (T7).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const APPLY = path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js');
const EFFECTS = path.join(ROOT, 'scripts', 'setup', 'install-effects.json');
const OLD_REF = '44615524';   // v2026.10.20.52: la versión bajada que quedaba trabada (fija: es la que corre en la máquina)

const H = (event, spec) => ({ event, matcher: '', spec, label: spec, when: 'always', platforms: { windows: true }, steps: ['all'], effect: 'records' });

/** Una máquina de juguete con un hook del arnés (`@tcg:`), uno sin prefijo y uno de integración (`@int:`), todos presentes. */
function lab(t, extraHooks = []) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'old-judge-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tcg = path.join(base, 'tcg');
  const hooksDir = path.join(tcg, 'scripts', 'hooks');
  const skills = path.join(tcg, 'skills');
  const home = path.join(base, 'home');
  for (const d of [hooksDir, path.join(skills, 'tycon-pipeline', 'scripts'), path.join(tcg, 'integrations', 'clockify', 'scripts'), path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'p.js'), '// hook\n');
  fs.writeFileSync(path.join(skills, 'tycon-pipeline', 'scripts', 'on-prompt.js'), '// hook\n');
  fs.writeFileSync(path.join(tcg, 'integrations', 'clockify', 'scripts', 'on-prompt.js'), '// hook\n');
  const hooks = [H('PreToolUse', '@tcg:p.js'), H('UserPromptSubmit', 'tycon-pipeline/scripts/on-prompt.js'), H('UserPromptSubmit', '@int:clockify/scripts/on-prompt.js'), ...extraHooks];
  const listPath = path.join(base, 'list.json');
  fs.writeFileSync(listPath, JSON.stringify({ __doc: 'juguete', hooks, superseded: [], legacy_fragments: [] }));
  return { base, tcg, hooksDir, skills, home, listPath, settingsPath: path.join(home, '.claude', 'settings.json') };
}

/** Corre el aplicador como lo corren los instaladores y devuelve los ids de hook del informe de piezas. */
function applyIds(L, env = {}) {
  const pieces = path.join(L.base, `pieces-${Math.random().toString(36).slice(2)}.tsv`);
  const r = spawnSync(process.execPath, [APPLY, '--settings', L.settingsPath, '--hooks-dir', L.hooksDir, '--skills', L.skills,
    '--list', L.listPath, '--effects', EFFECTS, '--report-out', path.join(L.base, 'r.txt'), '--json-out', path.join(L.base, 'r.json')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: L.home, USERPROFILE: L.home, TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1', TYCON_HARNESS_SHARED_DONE: '1', TYCON_REPORT_PIECES: pieces, ...env },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const lines = fs.existsSync(pieces) ? fs.readFileSync(pieces, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { ids: lines.filter((l) => l.startsWith('hook\t')).map((l) => l.split('\t')[2]), stdout: r.stdout, pieces };
}

const commandsOf = (L) => JSON.stringify(JSON.parse(fs.readFileSync(L.settingsPath, 'utf8')).hooks);

/** El árbol de la versión vieja en una carpeta temporal, o null (prueba NO MEDIDA) si el commit no está en este clon. */
function oldTree(t) {
  const has = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${OLD_REF}^{commit}`], { encoding: 'utf8' });
  if (has.status !== 0) { t.skip(`NO MEDIDO: el commit ${OLD_REF} (v2026.10.20.52) no está en la historia de este clon`); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'old-judge-2052-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tar = spawnSync('bash', ['-c', `git -C "${ROOT}" archive ${OLD_REF} scripts | tar -x -C "${dir}"`], { encoding: 'utf8' });
  assert.strictEqual(tar.status, 0, tar.stderr);
  return dir;
}

test('Report_WithoutPrefixesEnv_OmitsIntHooks @story-8.105 @ac-1', (t) => {
  const L = lab(t);
  const { ids, stdout } = applyIds(L);
  assert.ok(ids.includes('PreToolUse:@tcg:p.js'), ids.join(' · '));
  assert.ok(ids.includes('UserPromptSubmit:tycon-pipeline/scripts/on-prompt.js'), ids.join(' · '));
  assert.ok(!ids.some((i) => i.includes('@int:')), `un juez que no declara @int: lo recibió: ${ids.join(' · ')}`);
  // el hook sigue registrado: sólo no viaja en el informe
  assert.match(commandsOf(L), /integrations\/clockify\/scripts\/on-prompt\.js/);
  assert.match(stdout, /no van al informe/);
});

test('Report_WithPrefixesEnv_IncludesIntHooks @story-8.105 @ac-2', (t) => {
  const L = lab(t);
  const { ids } = applyIds(L, { TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' });
  assert.ok(ids.includes('UserPromptSubmit:@int:clockify/scripts/on-prompt.js'), ids.join(' · '));
  assert.ok(ids.includes('PreToolUse:@tcg:p.js'));
});

test('Harness_PassesHealthPrefixes_ToApplier @story-8.105 @ac-2', () => {
  const health = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'health.js'));
  assert.deepStrictEqual(health.HOOK_PREFIXES, ['@tcg:', '@int:']);
  const harness = require(path.join(ROOT, 'scripts', 'setup', 'harness.js'));
  assert.deepStrictEqual(harness.applierReportEnv(), { TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' });
  // y llega al proceso del aplicador: el ambiente con que se lanza la incluye
  const hsrc = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness.js'), 'utf8');
  assert.match(hsrc, /TYCON_HARNESS_GIT_BASH_HEALTH: '1' \}, applierReportEnv\(log\)\)/, 'runClaudeApplier no le pasa los prefijos al aplicador');
  // sin salud legible lo dice, y el informe va sólo con lo que entiende cualquier juez
  assert.strictEqual(health.HOOK_PREFIXES.every((p) => /^@[a-z0-9-]+:$/.test(p)), true);
  // y lo que la salud declara es lo que resuelve: cada prefijo da una ruta del árbol, no de las skills
  for (const p of health.HOOK_PREFIXES) {
    const f = health.hookFile(`${p}x/y.js`, { tree: '/arbol', skillsDir: '/skills' });
    assert.ok(f.split(path.sep).join('/').startsWith('/arbol/'), `${p} → ${f}`);
  }
});

test('OldJudge_AcceptsReport_FromNewApplier @story-8.105 @ac-1 @ac-5', (t) => {
  const old = oldTree(t);
  if (!old) return;
  const L = lab(t);
  const { pieces } = applyIds(L);
  // el informe tal como lo escribe el instalador (el arreglo JSON de las piezas)
  const report = fs.readFileSync(pieces, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [kind, where, id] = l.split('\t'); return { kind, where, id }; });
  const oldManaged = require(path.join(old, 'scripts', 'setup', 'harness', 'managed.js'));
  const parsed = oldManaged.parseReport(JSON.stringify(report));
  assert.ok(parsed.ok, `el lector de la 20.52 rechazó el informe: ${parsed.reason}`);
  const oldHealth = require(path.join(old, 'scripts', 'setup', 'harness', 'health.js'));
  const r = oldHealth.check({ home: L.home, env: { PATH: process.env.PATH, HOME: L.home }, platform: process.platform, tree: L.tcg },
    { tree: L.tcg, skillsDir: L.skills, report: parsed.pieces, applierOut: '', harnessJs: path.join(L.base, 'no-hay.js'), hookTimeoutMs: 5000 });
  const porHooks = (r.failures || []).filter((f) => /registrado y su archivo no está/.test(f));
  assert.deepStrictEqual(porHooks, [], `la salud de la 20.52 falló por hooks: ${porHooks.join(' · ')}`);

  // contraste: el mismo informe CON @int: es el que la trababa
  const conInt = applyIds(lab(t), { TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' });
  const rep2 = fs.readFileSync(conInt.pieces, 'utf8').trim().split('\n').map((l) => { const [kind, where, id] = l.split('\t'); return { kind, where, id }; });
  const r2 = oldHealth.check({ home: L.home, env: { PATH: process.env.PATH, HOME: L.home }, platform: process.platform, tree: L.tcg },
    { tree: L.tcg, skillsDir: L.skills, report: rep2, applierOut: '', harnessJs: path.join(L.base, 'no-hay.js'), hookTimeoutMs: 5000 });
  assert.ok(r2.failures.some((f) => /@int:clockify.*registrado y su archivo no está/.test(f)), 'el contraste no reprodujo la traba');
});

test('Startup_RunsHealth_WhenLastHealthByOtherVersion @story-8.105 @ac-3', () => {
  const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));
  const st = (marca) => ({ version: { number: '2026.10.24.1' }, last_health: '2026-10-24T00:00:00Z', ...(marca === undefined ? {} : { last_health_version: marca }) });
  assert.strictEqual(R.healthDueAtStartup(st(undefined), {}), true, 'sin marca (la puso un juez viejo): corre');
  assert.strictEqual(R.healthDueAtStartup(st('2026.10.20.52'), {}), true, 'marca de otra versión: corre');
  assert.strictEqual(R.healthDueAtStartup(st('2026.10.24.1'), {}), false, 'la corrió esta versión: no');
  assert.strictEqual(R.healthDueAtStartup(st('2026.10.24.1'), { force: true }), true, '--force: corre');
  assert.strictEqual(R.healthDueAtStartup({ last_health: '2026-10-24T00:00:00Z', last_health_version: '2026.10.24.1' }, {}), true, 'sin número de versión: corre (nunca un verde sin mirar)');

  // corrida: con la salud pasando, anota la marca de esta versión
  const calls = [];
  const H = { runHealth: (ctx, state, o) => { calls.push(o.report); return { ok: true, failures: [], warnings: [] }; } };
  const state = st(undefined);
  const out = R.startupHealth({}, state, H, { report: [{ kind: 'hook', id: 'UserPromptSubmit:@int:clockify/scripts/on-prompt.js' }], out: '' }, { log: () => {} });
  assert.strictEqual(out.ran, true);
  assert.strictEqual(calls.length, 1, 'la salud corrió una vez');
  assert.ok(calls[0].some((p) => p.id.includes('@int:')), 'la salud nueva recibe los hooks de integraciones');
  assert.strictEqual(state.last_health_version, '2026.10.24.1');
  const again = R.startupHealth({}, state, H, { report: [], out: '' }, { log: () => {} });
  assert.strictEqual(again.ran, false, 'el arranque siguiente no la repite');
});

test('Startup_HealthFails_SaysItWithoutRollingBack @story-8.105 @ac-3', () => {
  const R = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'));
  const state = { version: { number: '2026.10.24.1' }, last_health: '2026-10-24T00:00:00Z', last_health_version: '2026.10.20.52' };
  const H = { runHealth: () => ({ ok: false, failures: ['hook UserPromptSubmit:@int:clockify/scripts/on-prompt.js: registrado y su archivo no está (x)'], warnings: [] }) };
  const out = R.startupHealth({}, state, H, { report: [], out: '' }, { log: () => {} });
  assert.strictEqual(out.ran, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.line, /doctor/);
  assert.match(out.line, /rollback/);
  assert.strictEqual(state.version.number, '2026.10.24.1', 'no vuelve sola');
  assert.strictEqual(state.last_health_version, '2026.10.20.52', 'sin salud sana la marca queda como estaba');
  // y el arranque real la usa: startup llama a startupHealth y suma su línea al aviso (no la pierde detrás de otro)
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'), 'utf8');
  const body = src.slice(src.indexOf('function startup('), src.indexOf('\n}', src.indexOf('function startup(')));
  assert.match(body, /startupHealth\(ctx, state, H, a,/, 'startup no corre la salud del arranque');
  assert.match(body, /notice = notice \? `\$\{notice\} · \$\{sh\.line\}` : sh\.line/, 'el fallo de salud se pierde detrás de otro aviso');
});

test('OldState_IntAsHook_ReadsLikeToday @story-8.105 @ac-4', (t) => {
  const M = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js'));
  const L = lab(t);
  applyIds(L);   // deja el hook @int: registrado en settings.json
  const piece = { kind: 'hook', where: L.settingsPath, id: 'UserPromptSubmit:@int:clockify/scripts/on-prompt.js', version: '2026.10.23.19' };
  assert.strictEqual(M.present(piece, { home: L.home, env: {} }), true, 'el estado viejo lo encuentra en la máquina');
  assert.match(M.describe(piece), /hook UserPromptSubmit @int:clockify\/scripts\/on-prompt\.js/);
  const merged = M.merge([piece], [], { version: '2026.10.24.1', present: (p) => M.present(p, { home: L.home, env: {} }) });
  assert.ok(merged.some((p) => p.id === piece.id && p.kind === 'hook'), 'el registro lo conserva como «hook»');
  const U = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'uninstall.js'));
  const lines = U.describePlan({ remove: [piece], keep: [], review: [], pointers: [], home: L.home, stateFile: path.join(L.home, 'estado.json') }).join('\n');
  assert.match(lines, /hook/, `uninstall no lo cuenta como hook:\n${lines}`);
});

test('NewPrefix_NeverReachesAJudgeThatDoesNotDeclareIt @story-8.105 @ac-7', () => {
  const A = require(APPLY);
  for (const id of ['PreToolUse:@tcg:p.js', 'Stop:tycon-pipeline/scripts/on-stop-dod-gate.js']) {
    assert.strictEqual(A.reportableHookId(id, {}), true, `${id}: lo entiende cualquier juez`);
  }
  assert.strictEqual(A.reportableHookId('UserPromptSubmit:@int:clockify/scripts/on-prompt.js', {}), false);
  assert.strictEqual(A.reportableHookId('Stop:@zzz:algo/x.js', {}), false, 'un prefijo inventado no llega a un juez que no lo nombra');
  assert.strictEqual(A.reportableHookId('Stop:@zzz:algo/x.js', { TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' }), false);
  assert.strictEqual(A.reportableHookId('Stop:@zzz:algo/x.js', { TYCON_REPORT_HOOK_PREFIXES: '@zzz:' }), true);
  // la lista congelada: lo que entendía el juez más viejo que sigue en uso; agrandarla rompe a las versiones viejas
  assert.deepStrictEqual(A.OLD_JUDGE_PREFIXES, ['@tcg:']);
});

test('OldMerge_SettingsKeepIntHooks_NextStartupRecordsThem @story-8.105 @ac-6', (t) => {
  const old = oldTree(t);
  if (!old) return;
  const oldManaged = require(path.join(old, 'scripts', 'setup', 'harness', 'managed.js'));
  const L = lab(t);
  applyIds(L, { TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' });
  const intPiece = { kind: 'hook', where: L.settingsPath, id: 'UserPromptSubmit:@int:clockify/scripts/on-prompt.js', version: '2026.10.23.19' };
  const tcgPiece = { kind: 'hook', where: L.settingsPath, id: 'PreToolUse:@tcg:p.js', version: '2026.10.23.19' };
  const gone = { kind: 'hook', where: L.settingsPath, id: 'Stop:@tcg:ya-no-esta.js', version: '2026.10.23.19' };
  // el informe sin @int: (lo que manda ahora el aplicador al juez viejo); `present` como lo calcula la versión vieja
  const merged = oldManaged.merge([intPiece, tcgPiece, gone], [tcgPiece], { version: '2026.10.24.1', present: (p) => oldManaged.present(p, { home: L.home, env: {} }) });
  // el viejo no sabe encontrar un @int: en settings.json: si dijera «no está», lo descartaría del registro
  const kept = merged.some((p) => p.id === intPiece.id);
  // lo medido: el viejo no sabe encontrar un @int: en settings.json, lo da por ausente y lo saca de SU registro
  assert.strictEqual(oldManaged.present(intPiece, { home: L.home, env: {} }), false);
  assert.ok(!kept, 'si esto cambió, actualizá la story: el registro viejo ya no descarta los @int:');
  assert.ok(merged.some((p) => p.id === tcgPiece.id), 'lo que vino en el informe queda');
  assert.ok(!merged.some((p) => p.id === gone.id), 'una pieza que ya no está se descarta (como siempre)');
  // settings.json no lo toca el registro: el hook sigue
  assert.match(commandsOf(L), /integrations\/clockify\/scripts\/on-prompt\.js/);
  // y el arranque siguiente, con el código nuevo (informe con los prefijos de su salud), lo vuelve a anotar
  const M = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js'));
  const nuevo = applyIds(L, { TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' }).ids.map((id) => ({ kind: 'hook', where: L.settingsPath, id }));
  const back = M.merge(merged, nuevo, { version: '2026.10.24.1', present: (p) => M.present(p, { home: L.home, env: {} }) });
  assert.ok(back.some((p) => p.id === intPiece.id && p.kind === 'hook'), 'el arranque siguiente no lo volvió a anotar');
});
