'use strict';
/**
 * apply-hooks.test.js — la lista única de hooks y el aplicador que la lee (story 8.17, tanda W3 · AC 23, 24, 25, 28;
 * T33 a T37; y de la tanda W4 lo que el aplicador hace en Windows · AC 29).
 * stable-data: no crea commits ni lee el reloj; «commit» sale de `cat-file -e <ref>^{commit}` (sólo mira si el
 *   commit fijo de la versión anterior está en el clon).
 *
 * EL CASO. Hasta la W3 cada instalador llevaba su lista de hooks (`HOOKS_CANONICAL` y `OPTIN_HOOKS` en el `.sh`,
 * `$HooksCanonical` en el `.ps1`) y su propio código para escribir `settings.json` (un bloque de Python en el `.sh`, uno
 * de PowerShell en el `.ps1`). Medido en un agente Windows el 2026-10-04: el `.ps1` registraba 29 de los 42 controles
 * del `.sh`. Ahora hay UNA lista (`scripts/setup/hooks-list.json`) y UN aplicador (`scripts/setup/apply-hooks.js`).
 *
 * QUÉ MIDE. Sobre carpetas de juguete (nunca la carpeta de usuario real): la forma de la lista real (T33); que cada
 * hook entra según su `when`, con el intérprete de su extensión, en su lugar, y que lo reemplazado, lo viejo y lo
 * apagado se saca sin tocar lo ajeno (T34); que una segunda corrida no reescribe, que escribe atómico con copia y que
 * `--check` no escribe (T35); que un guion que falta se nombra (T36); que una lista o un `settings.json` rotos no
 * escriben nada (T37); y, en Windows, la ruta del bash de Git, `\r\n` y las rutas que un shell leería mal (AC 29, 67).
 *
 * Correr:   node --test scripts/tests/apply-hooks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const APPLY = path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js');
const LIST = path.join(ROOT, 'scripts', 'setup', 'hooks-list.json');
const EFFECTS = path.join(ROOT, 'scripts', 'setup', 'install-effects.json');
const mod = require(APPLY);

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'ausente');
function hashTree(dir) {
  const out = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${path.relative(dir, p)}:${sha(p)}`);
    }
  })(dir);
  return out.join('\n');
}

/** Una máquina de juguete: el repo de guías con sus hooks, las skills, una HOME y una lista propia. */
function lab(t, { list, files, settings } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-hooks-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hooksDir = path.join(base, 'tcg', 'scripts', 'hooks');
  const skills = path.join(base, 'tcg', 'skills');
  const home = path.join(base, 'home');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  for (const f of files || []) {
    const abs = f.startsWith('@tcg:') ? path.join(hooksDir, f.slice(5)) : path.join(skills, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// hook de juguete\n');
  }
  const listPath = path.join(base, 'hooks-list.json');
  if (list !== undefined) fs.writeFileSync(listPath, typeof list === 'string' ? list : JSON.stringify(list, null, 2));
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n');
  const abs = (spec) => (spec.startsWith('@tcg:') ? path.join(hooksDir, spec.slice(5)) : path.join(skills, spec));
  return { base, hooksDir, skills, home, listPath, settingsPath, abs };
}

/** Corre el aplicador como lo corren los instaladores. */
function runRaw(L, args = [], env = {}) {
  const reportOut = path.join(L.base, 'report.txt');
  const jsonOut = path.join(L.base, 'report.json');
  const r = spawnSync(process.execPath, [APPLY, '--settings', L.settingsPath, '--hooks-dir', L.hooksDir, '--skills', L.skills,
    '--list', L.listPath, '--effects', EFFECTS, '--report-out', reportOut, '--json-out', jsonOut, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: L.home, USERPROFILE: L.home, TYCON_PROFILE: '0', TYCON_NO_NIGHTLY_EXAM: '1', ...env },
  });
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  let json = null;
  try { json = JSON.parse(read(jsonOut)); } catch (_) { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: read(reportOut), json };
}
const run = runRaw;
const settingsOf = (L) => JSON.parse(fs.readFileSync(L.settingsPath, 'utf8'));
const commandsOf = (s, ev) => (s.hooks[ev] || []).flatMap((e) => (e.hooks || []).map((h) => h.command));

const H = (event, matcher, spec, extra = {}) => ({ event, matcher, spec, label: `etiqueta de ${spec}`, when: 'always', platforms: { windows: true }, steps: ['all'], effect: 'records', ...extra });
const LIST_OF = (hooks, extra = {}) => ({ __doc: 'lista de juguete', hooks, superseded: ['tycon-pipeline/scripts/on-edit.js'], legacy_fragments: ['.claude/hooks/engram-pre-commit.sh'], ...extra });

// ── T33 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T33 HooksList_Schema_EveryRecordOnce_NoListLeftInAppliers', () => {
  const list = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  assert.deepStrictEqual(mod.validateList(list), [], 'la lista real pasa su validación');
  assert.ok(list.hooks.length >= 40, `la lista trae ${list.hooks.length} registros`);
  const keys = list.hooks.map((h) => `${h.event}|${mod.normMatcher(h.matcher)}|${h.spec}`);
  assert.strictEqual(new Set(keys).size, keys.length, 'ningún registro repetido');
  for (const h of list.hooks) {
    assert.ok(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'Notification', 'SessionEnd'].includes(h.event), `${h.spec}: evento ${h.event}`);
    assert.match(h.when, /^(always|integration:[a-z]+|optin:TYCON_[A-Z_]+)$/, `${h.spec}: when ${h.when}`);
    assert.strictEqual(typeof h.platforms.windows, 'boolean', `${h.spec}: platforms.windows`);
    assert.ok(h.label && typeof h.label === 'string', `${h.spec}: label`);
    // los pasos y el efecto los muestra «Cómo trabaja»: el aplicador los acepta ausentes, la lista real los trae siempre
    assert.ok(Array.isArray(h.steps) && h.steps.length, `${h.spec}: steps`);
    assert.ok(typeof h.effect === 'string', `${h.spec}: effect`);
  }
  // ninguno de los dos instaladores lleva una lista propia (AC 23)
  for (const rel of ['scripts/install-tycon-hooks.sh', 'scripts/install-tycon-hooks.ps1']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const marker of ['HOOKS_CANONICAL=(', 'OPTIN_HOOKS', '$HooksCanonical']) {
      assert.ok(!text.includes(marker), `${rel} todavía nombra ${marker}`);
    }
  }
  // un campo fuera del vocabulario da rojo nombrando el registro
  const bad = JSON.parse(JSON.stringify(list));
  bad.hooks[0].when = 'a veces';
  assert.ok(mod.validateList(bad).some((p) => p.includes(bad.hooks[0].spec) && p.includes('when')));
  // los pasos y el efecto de cada control (los muestra «Cómo trabaja» del sitio): fuera del vocabulario, rojo
  for (const [campo, valor] of [['steps', []], ['steps', ['paso cinco']], ['effect', 'grita']]) {
    const mal = JSON.parse(JSON.stringify(list));
    mal.hooks[1][campo] = valor;
    assert.ok(mod.validateList(mal).some((p) => p.includes(mal.hooks[1].spec) && p.includes(campo)), `${campo} = ${JSON.stringify(valor)}`);
  }
  // ausentes, la lista se aplica igual (una lista armada a mano o de otra versión no se rechaza por datos de pantalla)
  const sinDatos = JSON.parse(JSON.stringify(list));
  delete sinDatos.hooks[1].steps; delete sinDatos.hooks[1].effect;
  assert.deepStrictEqual(mod.validateList(sinDatos), [], 'sin steps ni effect, la lista pasa');
});

// ── T34 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T34 ApplyHooks_ByWhen_InterpreterByExtension_RemovesReplacedOldAndOptinOff_CanonicalPlace', (t) => {
  const list = LIST_OF([
    H('PreToolUse', 'Bash|PowerShell', 'tycon-pipeline/scripts/a.js'),
    H('PreToolUse', 'Bash|PowerShell', '@tcg:b.sh'),
    H('PreToolUse', 'Bash|PowerShell', '@tcg:c.py'),
    H('SessionStart', '', '@tcg:integ.js', { when: 'integration:nightly' }),
    H('SessionStart', '', '@tcg:off-de-fabrica.js', { when: 'optin:TYCON_SESSION_GUARD', default: 'off' }),
    H('PreToolUse', 'Bash|PowerShell', '@tcg:freno.sh', { when: 'optin:TYCON_SAFETY_GUARD', default: 'on', brake: true }),
    H('PostToolUse', '', 'clocki/scripts/touch.js', { when: 'integration:clockify', async: true }),
  ]);
  const files = ['tycon-pipeline/scripts/a.js', '@tcg:b.sh', '@tcg:c.py', '@tcg:integ.js', '@tcg:off-de-fabrica.js', '@tcg:freno.sh',
    'clocki/scripts/touch.js', 'tycon-pipeline/scripts/on-edit.js'];
  const L = lab(t, { list, files });
  const alien = { type: 'command', command: 'node "/otra/carpeta/mio.js"' };
  fs.writeFileSync(L.settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [alien, { type: 'command', command: `bash "${L.abs('@tcg:freno.sh')}"` }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: `node "${L.abs('tycon-pipeline/scripts/on-edit.js')}"` }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash "/x/.claude/hooks/engram-pre-commit.sh"' }] }],
    },
    otra: { cosa: 1 },
  }, null, 2) + '\n');
  const r = run(L, [], { TYCON_NIGHTLY: '1', TYCON_CLOCKIFY: '0', TYCON_SAFETY_GUARD: '0' });
  assert.strictEqual(r.status, 0, r.stderr);
  const s = settingsOf(L);
  const pre = commandsOf(s, 'PreToolUse');
  assert.strictEqual(pre[0], alien.command, 'lo ajeno queda primero, intacto');
  assert.ok(pre.includes(`node "${L.abs('tycon-pipeline/scripts/a.js')}"`), '.js con node');
  assert.ok(pre.includes(`bash "${L.abs('@tcg:b.sh')}"`), '.sh con bash');
  assert.ok(pre.includes(`python3 "${L.abs('@tcg:c.py')}"`), '.py con python3');
  assert.ok(!pre.some((c) => c.includes('freno.sh')), 'el opt-in apagado por su variable se saca');
  assert.ok(commandsOf(s, 'SessionStart').some((c) => c.includes('integ.js')), 'integración prendida: entra');
  assert.ok(!commandsOf(s, 'SessionStart').some((c) => c.includes('off-de-fabrica.js')), 'opt-in apagado de fábrica: no entra');
  assert.ok(!commandsOf(s, 'PostToolUse').some((c) => c.includes('touch.js')), 'integración apagada: no entra');
  assert.ok(!commandsOf(s, 'PostToolUse').some((c) => c.includes('on-edit.js')), 'el reemplazado se saca');
  assert.ok(!s.hooks.UserPromptSubmit, 'la forma vieja se saca (y su evento vacío se va)');
  assert.deepStrictEqual(s.otra, { cosa: 1 }, 'lo que no es de hooks no se toca');
  // el orden de la lista: a.js, b.sh, c.py en ese orden después de lo ajeno
  const ours = pre.filter((c) => c !== alien.command);
  assert.deepStrictEqual(ours.map((c) => path.basename(c.replace(/"$/, ''))), ['a.js', 'b.sh', 'c.py']);
  assert.match(r.report, /^REMOVED:3$/m);
  assert.match(r.report, /disabled by env var/);
  assert.match(r.report, /superseded by H10 dispatcher/);
  // un hook que vuelve entra en su lugar canónico, no al final
  const s2 = settingsOf(L);
  s2.hooks.PreToolUse[0].hooks = s2.hooks.PreToolUse[0].hooks.filter((h) => !h.command.includes('b.sh'));
  fs.writeFileSync(L.settingsPath, JSON.stringify(s2, null, 2) + '\n');
  assert.strictEqual(run(L, [], { TYCON_NIGHTLY: '1', TYCON_CLOCKIFY: '0', TYCON_SAFETY_GUARD: '0' }).status, 0);
  const again = commandsOf(settingsOf(L), 'PreToolUse').filter((c) => c !== alien.command).map((c) => path.basename(c.replace(/"$/, '')));
  assert.deepStrictEqual(again, ['a.js', 'b.sh', 'c.py']);
});

// ── T35 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T35 ApplyHooks_NoChangeNoRewrite_AtomicWithBackup_CheckWritesNothing_ReportJson', (t) => {
  const list = LIST_OF([H('Stop', '', '@tcg:s.js'), H('PreToolUse', 'Bash', '@tcg:p.js')]);
  const L = lab(t, { list, files: ['@tcg:s.js', '@tcg:p.js'], settings: { hooks: {} } });
  const run = (L0, args = [], env = {}) => runRaw(L0, args, { TYCON_HARNESS_SHARED_DONE: '1', ...env });   // sólo hooks: las dos claves, aparte
  // --check no escribe nada (la carpeta, idéntica por hash) y dice lo que falta
  const before = hashTree(L.home);
  const c = run(L, ['--check']);
  assert.strictEqual(c.status, 0, c.stderr);
  assert.strictEqual(hashTree(L.home), before, '--check no escribe');
  assert.match(c.report, /^ADDED:2$/m);
  // primera corrida: escribe, con copia
  const pieces = path.join(L.base, 'pieces.tsv');
  const r1 = run(L, [], { TYCON_REPORT_PIECES: pieces });
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.match(r1.report, /^BACKUP:.*settings\.json\.bak\./m);
  const bak = fs.readdirSync(path.dirname(L.settingsPath)).filter((n) => n.startsWith('settings.json.bak.'));
  assert.strictEqual(bak.length, 1, 'una copia');
  assert.ok(!fs.readdirSync(path.dirname(L.settingsPath)).some((n) => n.startsWith('.settings.')), 'sin temporales');
  const lines = fs.readFileSync(pieces, 'utf8').trim().split('\n');
  assert.deepStrictEqual(lines.sort(), [`hook\t${L.settingsPath}\tPreToolUse:@tcg:p.js`, `hook\t${L.settingsPath}\tStop:@tcg:s.js`].sort(),
    'el reporte de piezas con la forma de la 8.13');
  // segunda corrida: byte a byte igual, sin reescribir (ni copia nueva)
  const h1 = sha(L.settingsPath);
  const m1 = fs.statSync(L.settingsPath).mtimeMs;
  const r2 = run(L);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(sha(L.settingsPath), h1);
  assert.strictEqual(fs.statSync(L.settingsPath).mtimeMs, m1, 'no se reescribió');
  assert.match(r2.report, /^EXISTED:2$/m);
  // con TYCON_HARNESS_SNAPSHOT_DIR no hay copia propia
  const s = settingsOf(L); s.hooks = {}; fs.writeFileSync(L.settingsPath, JSON.stringify(s, null, 2) + '\n');
  const r3 = run(L, [], { TYCON_HARNESS_SNAPSHOT_DIR: path.join(L.base, 'snap') });
  assert.strictEqual(r3.status, 0);
  assert.doesNotMatch(r3.report, /^BACKUP:/m);
  assert.strictEqual(fs.readdirSync(path.dirname(L.settingsPath)).filter((n) => n.startsWith('settings.json.bak.')).length, 1);
  // el informe en JSON (lo lee el .ps1)
  assert.ok(r3.json && Array.isArray(r3.json.added) && r3.json.added.length === 2 && r3.json.changed === true);
});

// ── T36 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T36 ApplyHooks_MissingHookFile_NamedNeverSilent', (t) => {
  const list = LIST_OF([H('Stop', '', '@tcg:esta.js'), H('Stop', '', '@tcg:no-esta.js')]);
  const L = lab(t, { list, files: ['@tcg:esta.js'], settings: { hooks: {} } });
  for (const args of [['--check'], []]) {
    const r = run(L, args);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.report, /^MISSING:1$/m);
    assert.match(r.report, /^ {2}! Stop \(matcher='\*'\) → @tcg:no-esta\.js$/m);
  }
  assert.ok(commandsOf(settingsOf(L), 'Stop').some((c) => c.includes('esta.js')), 'el que está, registrado');
});

// ── T37 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('T37 ApplyHooks_BrokenListOrSettings_WritesNothing_NeverReadAsEmpty', (t) => {
  const good = LIST_OF([H('Stop', '', '@tcg:s.js')]);
  const cases = [
    ['ausente', undefined, /no existe|no está/],
    ['no es JSON', '{ esto no', /no es JSON/],
    ['campo inválido', LIST_OF([H('Stop', '', '@tcg:s.js', { when: 'a veces' })]), /when/],
    ['sin hooks', { __doc: 'x' }, /hooks/],
  ];
  for (const [name, list, why] of cases) {
    const L = lab(t, { list, files: ['@tcg:s.js'], settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/ajeno.js"' }] }] } } });
    const before = sha(L.settingsPath);
    const r = run(L);
    assert.notStrictEqual(r.status, 0, `${name}: sale distinto de 0`);
    assert.ok((r.stderr + r.stdout).includes(L.listPath), `${name}: nombra el archivo`);
    assert.match(r.stderr + r.stdout, why, `${name}: dice el motivo`);
    assert.strictEqual(sha(L.settingsPath), before, `${name}: settings.json intacto`);
  }
  // settings.json que no es JSON: no lo toca y lo dice
  const L = lab(t, { list: good, files: ['@tcg:s.js'], settings: '{ roto' });
  const r = run(L);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /settings\.json/);
  assert.strictEqual(fs.readFileSync(L.settingsPath, 'utf8'), '{ roto');
  // configuración rota: los de integración quedan como estaban (8.3, AC 2) — ni entran ni se sacan
  const integ = LIST_OF([H('SessionStart', '', '@tcg:integ.js', { when: 'integration:nightly' }), H('Stop', '', '@tcg:s.js')]);
  const L2 = lab(t, { list: integ, files: ['@tcg:integ.js', '@tcg:s.js'] });
  fs.writeFileSync(L2.settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${L2.abs('@tcg:integ.js')}"` }] }] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(L2.home, '.claude', 'tycon.json'), '{ roto');
  const r2 = run(L2);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(commandsOf(settingsOf(L2), 'SessionStart').some((c) => c.includes('integ.js')), 'rota: queda como estaba');
  // …y con la integración apagada (configuración legible) se saca
  fs.writeFileSync(path.join(L2.home, '.claude', 'tycon.json'), '{}');
  assert.strictEqual(run(L2).status, 0);
  assert.ok(!settingsOf(L2).hooks.SessionStart, 'apagada: se saca');
});

// ── Windows (AC 29 y 67): la ruta del bash de Git, la forma vieja reescrita una vez, \r\n y rutas inseguras ─────────
test('W4 ApplyHooks_Windows_ShWithGitBashPath_OldFormRewrittenOnce_CrlfAndUnsafeNotRegistered', (t) => {
  const list = LIST_OF([
    H('PreToolUse', 'Bash|PowerShell', '@tcg:freno.sh'),
    H('PreToolUse', 'Bash|PowerShell', '@tcg:crlf.sh'),
    H('Stop', '', '@tcg:s.js'),
    H('SessionStart', '', '@tcg:solo-mac.js', { platforms: { windows: false } }),
  ]);
  const L = lab(t, { list, files: ['@tcg:freno.sh', '@tcg:s.js', '@tcg:solo-mac.js'] });
  fs.writeFileSync(L.abs('@tcg:crlf.sh'), '#!/bin/bash\r\nexit 0\r\n');
  const fwd = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: {} }, null, 2) + '\n');
  const r = run(L, ['--platform', 'windows']);
  assert.strictEqual(r.status, 0, r.stderr);
  // desvío medido del AC 29 (182 #11979): un .sh va con `bash` a secas y barras normales, como en la W3a
  assert.deepStrictEqual(commandsOf(settingsOf(L), 'PreToolUse'), [`bash "${fwd(L.abs('@tcg:freno.sh'))}"`], 'el .sh con bash a secas; el de \\r\\n, afuera');
  assert.ok(r.json.notInstalled.some((n) => n.kind === 'crlf' && n.relpath === 'crlf.sh'), 'el \\r\\n se dice');
  assert.ok(!commandsOf(settingsOf(L), 'SessionStart').length, 'lo que Windows excluye no se registra');
  // segunda corrida: nada cambia
  const h = sha(L.settingsPath);
  assert.strictEqual(run(L, ['--platform', 'windows']).status, 0);
  assert.strictEqual(sha(L.settingsPath), h, 'la segunda corrida no cambia nada');
  // una carpeta del clon con `$`: el hook no se registra y se dice (el comando lo lee un shell)
  const L2 = lab(t, { list: LIST_OF([H('Stop', '', '@tcg:s.js')]), settings: { hooks: {} } });
  L2.hooksDir = path.join(L2.base, 'clon$raro', 'scripts', 'hooks');
  fs.mkdirSync(L2.hooksDir, { recursive: true });
  fs.writeFileSync(path.join(L2.hooksDir, 's.js'), '// hook\n');
  const r4 = run(L2, ['--platform', 'windows']);
  assert.strictEqual(r4.status, 0, r4.stderr);
  assert.ok(r4.json.notInstalled.some((n) => n.kind === 'unsafe-path' && n.char === '$'));
  assert.ok(!settingsOf(L2).hooks.Stop);
});

test('W4 ApplyHooks_Windows_NarrowMatcher_WidenedInOneRun_CommandKept', (t) => {
  // un freno de antes del matcher ampliado (`Bash`): en UNA corrida queda con el matcher nuevo y su comando tal cual
  const L = lab(t, { list: LIST_OF([H('PreToolUse', 'Bash|PowerShell', '@tcg:freno.sh')]), files: ['@tcg:freno.sh'] });
  const fwd = (p) => p.replace(/\\/g, '/');
  const cmd = `bash "${fwd(L.abs('@tcg:freno.sh'))}"`;
  fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }] } }, null, 2) + '\n');
  assert.strictEqual(run(L, ['--platform', 'windows']).status, 0);
  assert.deepStrictEqual(settingsOf(L).hooks.PreToolUse, [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: cmd }] }]);
  const h = sha(L.settingsPath);
  assert.strictEqual(run(L, ['--platform', 'windows']).status, 0);
  assert.strictEqual(sha(L.settingsPath), h, 'la segunda corrida no cambia nada');
});

// ── Pase adversarial y revisores de la W3W4 (2026-10-05): cada caso, con su rojo previo ─────────────────────────────
test('W3W4 ApplyHooks_SettingsWithBom_IsRead_ModeKept_DuplicateTokenMatcherIsTheSame', (t) => {
  // clase 7: un settings.json con BOM (válido en Windows) hacía caer al instalador entero; clase 8/13: al escribir quedaba
  // 0644 (el Python lo dejaba 0600 y settings.json guarda tokens); clase 10: «Bash|Bash» no contaba como «Bash»
  const L = lab(t, { list: LIST_OF([H('Stop', '', '@tcg:s.js'), H('PreToolUse', 'Bash', '@tcg:p.js')]), files: ['@tcg:s.js', '@tcg:p.js'] });
  fs.writeFileSync(L.settingsPath, '﻿' + JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Bash', hooks: [{ type: 'command', command: `node "${L.abs('@tcg:p.js')}"` }] }] } }, null, 2) + '\n');
  fs.chmodSync(L.settingsPath, 0o600);
  const r = run(L, [], { TYCON_HARNESS_SHARED_DONE: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(commandsOf(settingsOf(L), 'PreToolUse').length, 1, 'el matcher con un nombre repetido es el mismo: no se duplica');
  assert.strictEqual(fs.statSync(L.settingsPath).mode & 0o777, 0o600, 'conserva los permisos del archivo');
  // uno que no existía nace 0600
  const L2 = lab(t, { list: LIST_OF([H('Stop', '', '@tcg:s.js')]), files: ['@tcg:s.js'] });
  assert.strictEqual(run(L2, [], { TYCON_HARNESS_SHARED_DONE: '1' }).status, 0);
  assert.strictEqual(fs.statSync(L2.settingsPath).mode & 0o777, 0o600, 'un settings.json nuevo nace 0600');
});

test('W3W4 ApplyHooks_FullOnlyOptinMustBeBornOn_PlanUnwritableFails_UnsafeDirOnPosix_EffectsUnreadable', (t) => {
  // clase 5: `profile: full-only` ignoraba `default` — un opt-in full-only que nace apagado se prendía igual: la lista lo rechaza
  const bad = LIST_OF([H('PreToolUse', 'Bash', '@tcg:x.sh', { when: 'optin:TYCON_X', default: 'off', profile: 'full-only' })]);
  assert.ok(mod.validateList(bad).some((p) => p.includes('full-only')), 'full-only con default off es un error de la lista');
  // clase 16: con --check, un plan que no se puede anotar no se ignora: sale distinto de 0 (el plan quedaría incompleto)
  const L = lab(t, { list: LIST_OF([H('Stop', '', '@tcg:s.js')]), files: ['@tcg:s.js'], settings: { hooks: {} } });
  const r = run(L, ['--check'], { TYCON_PLAN_PIECES: path.join(L.base, 'no-existe', 'plan.tsv') });
  assert.notStrictEqual(r.status, 0, 'un plan que no se pudo anotar no sale 0');
  assert.match(r.stderr, /plan/);
  // revisor de seguridad: en Mac y Linux una carpeta con `$` tampoco se escribe en un comando (lo lee un shell)
  const L3 = lab(t, { list: LIST_OF([H('Stop', '', '@tcg:s.js')]), settings: { hooks: {} } });
  L3.hooksDir = path.join(L3.base, 'clon$raro', 'scripts', 'hooks');
  fs.mkdirSync(L3.hooksDir, { recursive: true });
  fs.writeFileSync(path.join(L3.hooksDir, 's.js'), '// hook\n');
  const r3 = run(L3, ['--platform', 'posix'], { TYCON_HARNESS_SHARED_DONE: '1' });
  assert.strictEqual(r3.status, 0, r3.stderr);
  assert.ok(!settingsOf(L3).hooks.Stop, 'no se registra');
  assert.match(r3.report, /^UNSAFE:1$/m);
  assert.ok(r3.json.notInstalled.some((n) => n.kind === 'unsafe-path' && n.char === '$'), 'y se dice');
  // revisor de cobertura: sin la lista de efectos, minimal no se puede decidir y queda como estaba (nunca «todo de full»)
  assert.strictEqual(mod.loadMinimalIds(path.join(L.base, 'no-hay-efectos.json')), null);
  fs.writeFileSync(path.join(L.base, 'efectos-rotos.json'), '{ roto');
  assert.strictEqual(mod.loadMinimalIds(path.join(L.base, 'efectos-rotos.json')), null);
  const d = mod.decide(LIST_OF([H('Stop', '', '@tcg:s.js')]), { env: {}, integ: { state: 'ok', values: {} }, profile: { state: 'ok', value: 'minimal' }, minimalIds: null, platform: 'posix', has: () => false });
  assert.deepStrictEqual([d.active.length, d.known.length, d.leave.has('@tcg:s.js')], [0, 0, true], 'minimal sin su lista: ni entra ni se saca');
});

// Pase adversarial de la W3W4 (clase 11): el desinstalador sólo reconocía `node|bash|sh|python3 "<ruta>"`; la forma que
// escribe la W4 para un .sh en Windows (la ruta del bash de Git entre comillas) quedaba registrada después de desinstalar.
// 🔴 rojo previo: isHarnessCommand daba false para esa forma.
test('W4 Remove_QuotedGitBashForm_IsTheHarnessHook', () => {
  const { isHarnessCommand } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
  const roots = ['C:/Users/dev/.claude/tycon-claude-guides'];
  const rel = '@tcg:safety-guard-pre.sh';
  assert.ok(isHarnessCommand('"C:/Program Files/Git/bin/bash.exe" "C:/Users/dev/.claude/tycon-claude-guides/scripts/hooks/safety-guard-pre.sh"', rel, roots), 'con barras normales');
  assert.ok(isHarnessCommand('"C:\\Program Files\\Git\\bin\\bash.exe" "C:\\Users\\dev\\.claude\\tycon-claude-guides\\scripts\\hooks\\safety-guard-pre.sh"', rel, roots), 'con barras de Windows');
  assert.ok(isHarnessCommand('bash "C:/Users/dev/.claude/tycon-claude-guides/scripts/hooks/safety-guard-pre.sh"', rel, roots), 'la forma de la W3a sigue');
  // otro programa entre comillas no es el bash: un comando ajeno que nombra el guion no es el hook del arnés
  assert.ok(!isHarnessCommand('"C:/tools/otro.exe" "C:/Users/dev/.claude/tycon-claude-guides/scripts/hooks/safety-guard-pre.sh"', rel, roots), 'otro intérprete, no');
});

// Pase adversarial de la W3W4 (clases 2, 3, 9 y 14): el respaldo de enlace duro de los revisores (AC 39) no lo sacaba
// nadie: el desinstalador decía «es un archivo real, no un enlace: no lo toco». Ahora canonical-path.js anota cada duro
// que crea, y el desinstalador saca el anotado (y sólo ése). 🔴 rojo previo: quedaba en ~/.claude/agents.
test('W4 Remove_HardLinkRecordedByTheHarness_IsRemoved_OwnFileStays', (t) => {
  const { removePieces } = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
  const cp = require(path.join(ROOT, 'scripts', 'lib', 'canonical-path.js'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-hard-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tree = path.join(base, 'tree'); const home = path.join(base, 'home');
  fs.mkdirSync(path.join(tree, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'agents', 'r.md'), '# revisor\n');
  const ours = path.join(home, '.claude', 'agents', 'r.md');
  fs.linkSync(path.join(tree, 'agents', 'r.md'), ours);
  const theirs = path.join(home, '.claude', 'agents', 'propio.md');
  fs.writeFileSync(theirs, '# mío\n');
  const s = fs.lstatSync(ours, { bigint: true });
  const dir = fs.realpathSync(path.dirname(ours));
  fs.mkdirSync(path.dirname(cp.hardLinksFile(home)), { recursive: true });
  fs.writeFileSync(cp.hardLinksFile(home), JSON.stringify({ schema: 1, links: [{ where: path.join(dir, 'r.md'), target: path.join(tree, 'agents', 'r.md'), id: { dev: String(s.dev), ino: String(s.ino), mtime: String(s.mtimeNs), size: String(s.size) } }] }));
  assert.ok(cp.ownHardLink({ where: ours, home, tree }), 'canonical-path lo reconoce como del arnés');
  const dry = removePieces([{ kind: 'link', where: ours, id: 'agents/r.md' }], { home, tree, dryRun: true });
  assert.strictEqual(dry.removed.length, 1, 'el plan lo da por sacado');
  assert.ok(fs.existsSync(ours), '…sin borrarlo');
  const out = removePieces([{ kind: 'link', where: ours, id: 'agents/r.md' }, { kind: 'link', where: theirs, id: 'agents/propio.md' }], { home, tree });
  assert.ok(!fs.existsSync(ours), 'el duro anotado se saca');
  assert.ok(fs.existsSync(theirs), 'un archivo propio con otro nombre queda');
  assert.ok(!fs.existsSync(cp.hardLinksFile(home)), 'y deja de estar anotado');
  assert.strictEqual(out.removed.length, 1);
});

test('W4 ApplyHooks_Windows_SameHookByRepoPath_NotDuplicatedByOtherRoot', (t) => {
  const list = LIST_OF([H('Stop', '', '@tcg:s.js'), H('Stop', '', 'tycon-pipeline/scripts/k.js')]);
  const L = lab(t, { list, files: ['@tcg:s.js', 'tycon-pipeline/scripts/k.js'] });
  // registrados desde OTRA raíz (el enlace ~/.claude/tycon-claude-guides, o la forma /c/… de Git Bash)
  fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: 'command', command: 'node "/c/Users/x/.claude/tycon-claude-guides/scripts/hooks/s.js"' },
    { type: 'command', command: 'node "C:/otra/raiz/skills/tycon-pipeline/scripts/k.js"' },
  ] }] } }, null, 2) + '\n');
  const h = sha(L.settingsPath);
  const r = run(L, ['--platform', 'windows']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(sha(L.settingsPath), h, 'ya están: no se duplican');
  // y en Mac/Linux, otra carpeta es otro archivo (la regla del .sh, story 8.18)
  const r2 = run(L, ['--platform', 'posix']);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(commandsOf(settingsOf(L), 'Stop').length, 4);
});

test('decide: el perfil minimal, el perfil sin saber, los frenos y engram (la lógica del bash, en una función pura)', () => {
  const list = LIST_OF([
    H('Stop', '', '@tcg:de-minimal.js'),
    H('Stop', '', '@tcg:de-full.js'),
    H('PreToolUse', 'Bash', '@tcg:freno.sh', { when: 'optin:TYCON_SAFETY_GUARD', default: 'on', brake: true }),
    H('PreToolUse', 'Bash', '@tcg:pruebas.sh', { when: 'optin:TYCON_TEST_SCOPE_GUARD', default: 'on', profile: 'full-only', brake: true }),
    H('SessionStart', '', '@tcg:tg.sh', { when: 'optin:TYCON_TG_ZOMBIE_SWEEP', default: 'on', profile: 'full-only', needs: 'telegram-plugin' }),
    H('PreToolUse', 'Bash', '@tcg:engram.sh', { when: 'integration:engram', override: 'TYCON_ENGRAM_HOOK' }),
  ]);
  const minimalIds = new Set(['Stop:@tcg:de-minimal.js']);
  const integOk = { state: 'ok', values: { engram: '0' } };
  const names = (d) => d.active.map((h) => h.spec.slice(5)).sort();
  // minimal: lo de minimal y el freno de comandos; lo demás se saca con su motivo
  let d = mod.decide(list, { env: {}, integ: integOk, profile: { state: 'ok', value: 'minimal' }, minimalIds, platform: 'posix', has: () => true });
  assert.deepStrictEqual(names(d), ['de-minimal.js', 'freno.sh']);
  assert.ok(d.profileOff.has('@tcg:de-full.js') && d.profileOff.has('@tcg:pruebas.sh'));
  // perfil roto: lo de full queda como está (ni entra ni se saca), los dos frenos entran igual
  d = mod.decide(list, { env: {}, integ: integOk, profile: { state: 'rota' }, minimalIds, platform: 'posix', has: () => true });
  assert.deepStrictEqual(names(d), ['de-minimal.js', 'freno.sh', 'pruebas.sh']);
  assert.ok(!d.known.includes('@tcg:de-full.js') && !d.known.includes('@tcg:tg.sh'), 'lo que depende del perfil, sin tocar');
  // full: todo; engram apagado → se saca; TYCON_ENGRAM_HOOK=1 manda por encima
  d = mod.decide(list, { env: { TYCON_ENGRAM_HOOK: '1' }, integ: integOk, profile: { state: 'ok', value: 'full' }, minimalIds, platform: 'posix', has: () => true });
  assert.deepStrictEqual(names(d), ['de-full.js', 'de-minimal.js', 'engram.sh', 'freno.sh', 'pruebas.sh', 'tg.sh']);
  // sin el plugin de Telegram no entra, y se saca si estaba
  d = mod.decide(list, { env: {}, integ: integOk, profile: { state: 'ok' }, minimalIds, platform: 'posix', has: () => false });
  assert.ok(!names(d).includes('tg.sh') && d.known.includes('@tcg:tg.sh'));
  assert.ok(!names(d).includes('engram.sh') && d.known.includes('@tcg:engram.sh'), 'engram apagado y legible: se saca');
  // configuración rota y sin la variable: engram queda como estaba
  d = mod.decide(list, { env: {}, integ: { state: 'rota', values: {} }, profile: { state: 'ok' }, minimalIds, platform: 'posix', has: () => true });
  assert.ok(!d.known.includes('@tcg:engram.sh'));
});

// ── story 8.39: el Node propio del arnés en el comando de cada hook .js ───────────────────────────────────────────
const HN = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'harness-node.js'));
const NODE_VERSION = HN.readList(ROOT).list.version;
/**
 * El Node del arnés de juguete en `<casa>/node/`: una versión con un `bin/node` (o `node.exe`) que es un GUION que dice
 * la versión de la lista y si no llama al node real por su ruta absoluta —nunca un enlace a un binario real— y el enlace
 * `current`. Devuelve la ruta del binario por `current`.
 */
function fakeHarnessNode(casa, { windows = false, version = NODE_VERSION } = {}) {
  const v = path.join(casa, 'node', 'versions', version);
  const bin = windows ? path.join(v, 'node.exe') : path.join(v, 'bin', 'node');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  try { fs.unlinkSync(path.join(casa, 'node', 'current')); } catch (_) { /* no había */ }
  fs.symlinkSync(v, path.join(casa, 'node', 'current'), 'dir');
  return windows ? path.join(casa, 'node', 'current', 'node.exe') : path.join(casa, 'node', 'current', 'bin', 'node');
}

test('T16 ApplyHooks_NodeDelArnes_FormaDelComando @story-8.39 @ac-5', (t) => {
  const list = LIST_OF([H('Stop', '', '@tcg:s.js'), H('PreToolUse', 'Bash', '@tcg:b.sh')]);
  const cases = [
    { name: 'casa simple', dir: 'casa', want: (bin) => `${bin} ` },
    { name: 'casa con espacios', dir: 'mi casa', want: (bin) => `"${bin}" ` },
    { name: 'casa con $', dir: 'ca$a', want: () => 'node ' },
  ];
  for (const c of cases) {
    const L = lab(t, { list, files: ['@tcg:s.js', '@tcg:b.sh'], settings: { hooks: {} } });
    const casa = path.join(L.base, c.dir, '.tycon');
    const bin = fakeHarnessNode(casa);
    const env = { TYCON_HOME: casa, TYCON_HARNESS_SHARED_DONE: '1' };
    const r = run(L, [], env);
    assert.strictEqual(r.status, 0, r.stderr);
    const stop = commandsOf(settingsOf(L), 'Stop');
    assert.deepStrictEqual(stop, [`${c.want(bin)}"${L.abs('@tcg:s.js')}"`], `${c.name}: la forma del .js`);
    assert.deepStrictEqual(commandsOf(settingsOf(L), 'PreToolUse'), [`bash "${L.abs('@tcg:b.sh')}"`], `${c.name}: el .sh no cambia`);
    // el instalador corrido suelto otra vez (sin harness.js ni TYCON_NODE_BIN): la misma forma, nada que cambiar
    const h = sha(L.settingsPath);
    assert.strictEqual(run(L, [], env).status, 0);
    assert.strictEqual(sha(L.settingsPath), h, `${c.name}: una corrida suelta no cambia la forma`);
  }
  // sin Node del arnés, o con otra versión, o apagado: `node`, como siempre
  for (const [name, prep, extra] of [['sin current', () => null, {}], ['otra versión', (casa) => fakeHarnessNode(casa, { version: 'v1.0.0' }), {}], ['apagado', (casa) => fakeHarnessNode(casa), { TYCON_HARNESS_NODE: '0' }]]) {
    const L = lab(t, { list, files: ['@tcg:s.js', '@tcg:b.sh'], settings: { hooks: {} } });
    const casa = path.join(L.base, 'casa', '.tycon');
    prep(casa);
    assert.strictEqual(run(L, [], { TYCON_HOME: casa, TYCON_HARNESS_SHARED_DONE: '1', ...extra }).status, 0);
    assert.deepStrictEqual(commandsOf(settingsOf(L), 'Stop'), [`node "${L.abs('@tcg:s.js')}"`], `${name}: node`);
  }
  // Windows: la forma sin comillas sólo con la medición en verde (decisión 22) y una ruta C:/ sin espacios
  const winBare = 'C:/Users/dev/.tycon/node/current/node.exe';
  assert.strictEqual(HN.formFor(winBare, 'win32').prefix, HN.WINDOWS_FORM.measured ? winBare : 'node');
  assert.strictEqual(HN.formFor('C:/Users/Nombre Apellido/.tycon/node/current/node.exe', 'win32').prefix, 'node', 'una carpeta con espacio: node (decisión 22)');
  const L = lab(t, { list, files: ['@tcg:s.js'], settings: { hooks: {} } });
  const casa = path.join(L.base, 'casa', '.tycon');
  fakeHarnessNode(casa, { windows: true });
  const rw = run(L, ['--platform', 'windows'], { TYCON_HOME: casa });
  assert.strictEqual(rw.status, 0, rw.stderr);
  assert.match(commandsOf(settingsOf(L), 'Stop')[0], /^node "/, 'una carpeta sin letra de unidad no entra en la forma de Windows: node, y el hook se registra igual');
});

test('T17 ApplyHooks_CambioDeForma_EnElLugarSinDuplicar @story-8.39 @ac-6', (t) => {
  const list = LIST_OF([H('PostToolUse', 'Edit|Write', '@tcg:p.js', { async: true })]);
  const L = lab(t, { list, files: ['@tcg:p.js', 'tycon-pipeline/scripts/on-edit.js'] });
  const casa = path.join(L.base, 'casa', '.tycon');
  const bin = fakeHarnessNode(casa);
  const before = { type: 'command', command: 'node "/ajeno/antes.js"' };
  const after = { type: 'command', command: 'bash "/ajeno/despues.sh"' };
  const write = (cmd) => fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [before, { type: 'command', command: cmd, async: true }, after, { type: 'command', command: `${bin} "${L.abs('tycon-pipeline/scripts/on-edit.js')}"` }] }] } }, null, 2) + '\n');
  // de `node` al Node del arnés
  write(`node "${L.abs('@tcg:p.js')}"`);
  let r = run(L, [], { TYCON_HOME: casa, TYCON_HARNESS_SHARED_DONE: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  let hooks = settingsOf(L).hooks.PostToolUse;
  assert.strictEqual(hooks.length, 1, 'un solo grupo');
  assert.deepStrictEqual(hooks[0].hooks.map((h) => h.command), [before.command, `${bin} "${L.abs('@tcg:p.js')}"`, after.command], 'misma posición, sin duplicar; el reemplazado (en la forma nueva) se fue');
  assert.strictEqual(hooks[0].hooks[1].async, true, 'el async queda');
  assert.match(r.report, /^REFORMED:1$/m, 'se informa como cambio de forma');
  assert.match(r.report, /superseded by H10 dispatcher/, 'el reemplazado se reconoce en la forma nueva');
  // y de vuelta: sin current, al `node`
  fs.unlinkSync(path.join(casa, 'node', 'current'));
  r = run(L, [], { TYCON_HOME: casa, TYCON_HARNESS_SHARED_DONE: '1' });
  hooks = settingsOf(L).hooks.PostToolUse;
  assert.deepStrictEqual(hooks[0].hooks.map((h) => h.command), [before.command, `node "${L.abs('@tcg:p.js')}"`, after.command], 'de vuelta a node, en su lugar');
  assert.strictEqual(hooks[0].hooks[1].async, true);
  // la forma con comillas (una casa con espacios) también se reconoce
  const casa2 = path.join(L.base, 'mi casa', '.tycon');
  const bin2 = fakeHarnessNode(casa2);
  write(`"${bin2}" "${L.abs('@tcg:p.js')}"`);
  r = run(L, [], { TYCON_HOME: casa, TYCON_HARNESS_SHARED_DONE: '1' });
  assert.deepStrictEqual(settingsOf(L).hooks.PostToolUse[0].hooks.map((h) => h.command), [before.command, `node "${L.abs('@tcg:p.js')}"`, after.command], 'la forma con comillas pasa a node en su lugar');
  // otro comando que empieza distinto (no un Node) no se toca
  assert.strictEqual(after.command, 'bash "/ajeno/despues.sh"');
});

// PRE_8_39_REF: el commit de `main` del público del que sale la rama de la story 8.39 (fijo: después del merge, «la base de
// la rama» ya traería esta story y la prueba compararía lo nuevo contra lo nuevo)
const PRE_8_39_REF = '105fa90';
/** El árbol de PRE_8_39_REF en una carpeta temporal (`git archive`: apply-hooks.js carga ./harness/ y no corre suelto), o
 *  null con la prueba SALTEADA y el motivo («no medido», nunca un verde) si el commit no está en este clon. */
function oldTree(t) {
  const has = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${PRE_8_39_REF}^{commit}`], { encoding: 'utf8' });
  if (has.status !== 0) { t.skip(`NO MEDIDO: el commit ${PRE_8_39_REF} no está en la historia de este clon`); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-hooks-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tar = spawnSync('bash', ['-c', `git -C "${ROOT}" archive ${PRE_8_39_REF} | tar -x -C "${dir}"`], { encoding: 'utf8' });
  assert.strictEqual(tar.status, 0, tar.stderr);
  return dir;
}

// T30: actualizar desde la versión anterior, con las piezas reales. El arnés viejo instaló los hooks con `node`; la
// actualización la corre el programa VIEJO con el aplicador NUEVO, sin Node del arnés todavía (AC 17): quedan con `node`
// y sin duplicar; en el arranque siguiente el programa nuevo baja el Node (acá, el Node de juguete aparece) y el aplicador
// nuevo los pasa a la forma nueva, en su lugar.
test('T30 DesdeLaVersionAnterior_ElSegundoArranqueCambia @story-8.39 @ac-17', (t) => {
  const old = oldTree(t);
  if (!old) return;
  const list = LIST_OF([H('Stop', '', '@tcg:s.js'), H('PreToolUse', 'Bash', '@tcg:p.js')]);
  const L = lab(t, { list, files: ['@tcg:s.js', '@tcg:p.js'], settings: { hooks: {} } });
  const casa = path.join(L.base, 'casa', '.tycon');
  const env = { TYCON_HOME: casa, TYCON_HARNESS_SHARED_DONE: '1' };
  const runOld = () => spawnSync(process.execPath, [path.join(old, 'scripts', 'setup', 'apply-hooks.js'), '--settings', L.settingsPath, '--hooks-dir', L.hooksDir, '--skills', L.skills,
    '--list', L.listPath, '--effects', EFFECTS], { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH, HOME: L.home, USERPROFILE: L.home, TYCON_PROFILE: '0' }, env) });
  assert.strictEqual(runOld().status, 0, 'el arnés viejo instala');
  const all = () => ['Stop', 'PreToolUse'].flatMap((ev) => commandsOf(settingsOf(L), ev));
  assert.ok(all().every((c) => c.startsWith('node "')), 'el viejo: todos con node');
  // la actualización: el aplicador nuevo, sin Node del arnés todavía
  assert.strictEqual(run(L, [], env).status, 0);
  assert.deepStrictEqual(all().map((c) => c.split(' ')[0]), ['node', 'node'], 'tras la actualización, con node y sin duplicar');
  // el arranque siguiente: el Node del arnés está
  const bin = fakeHarnessNode(casa);
  const r = run(L, [], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(all(), [`${bin} "${L.abs('@tcg:s.js')}"`, `${bin} "${L.abs('@tcg:p.js')}"`], 'tras el arranque siguiente, en la forma nueva, uno por guion');
  assert.match(r.report, /^REFORMED:2$/m);
});

test('T18 ApplyHooks_FormaNueva_ElAplicadorViejoNoDuplica @story-8.39 @ac-18', (t) => {
  const old = oldTree(t);
  if (!old) return;
  const OLD_APPLY = path.join(old, 'scripts', 'setup', 'apply-hooks.js');
  const list = LIST_OF([H('Stop', '', '@tcg:s.js')]);
  const runOld = (L, args = []) => spawnSync(process.execPath, [OLD_APPLY, '--settings', L.settingsPath, '--hooks-dir', L.hooksDir, '--skills', L.skills,
    '--list', L.listPath, '--effects', EFFECTS, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: L.home, USERPROFILE: L.home, TYCON_PROFILE: '0', TYCON_HARNESS_SHARED_DONE: '1' } });
  // posix, sin comillas: el aplicador viejo lo reconoce (contiene `node "` y nombra el mismo archivo)
  let L = lab(t, { list, files: ['@tcg:s.js'] });
  const bin = fakeHarnessNode(path.join(L.base, 'casa', '.tycon'));
  fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `${bin} "${L.abs('@tcg:s.js')}"` }] }] } }, null, 2) + '\n');
  assert.strictEqual(runOld(L).status, 0);
  assert.strictEqual(commandsOf(settingsOf(L), 'Stop').length, 1, 'posix sin comillas: cero duplicados con el aplicador viejo');
  // posix, con comillas: el duplicado declarado (riesgo 3 de la story)
  L = lab(t, { list, files: ['@tcg:s.js'] });
  const bin2 = fakeHarnessNode(path.join(L.base, 'mi casa', '.tycon'));
  fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${bin2}" "${L.abs('@tcg:s.js')}"` }] }] } }, null, 2) + '\n');
  assert.strictEqual(runOld(L).status, 0);
  assert.strictEqual(commandsOf(settingsOf(L), 'Stop').length, 2, 'posix con comillas: el aplicador viejo lo duplica (declarado en la story, riesgo 3)');
  // windows: invokesRepoPath de antes acepta cualquier intérprete
  L = lab(t, { list, files: ['@tcg:s.js'] });
  const fwd = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(L.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `C:/Users/dev/.tycon/node/current/node.exe "${fwd(L.abs('@tcg:s.js'))}"` }] }] } }, null, 2) + '\n');
  assert.strictEqual(runOld(L, ['--platform', 'windows']).status, 0);
  assert.strictEqual(commandsOf(settingsOf(L), 'Stop').length, 1, 'windows: cero duplicados con el aplicador viejo');
});
