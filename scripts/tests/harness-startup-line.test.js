'use strict';
/**
 * harness-startup-line.test.js — la migración de la línea de arranque (`scripts/setup/harness/startup-line.js`)
 * (story 8.13, tanda A · T8 y la parte .js de T28).
 *
 * Lo que no se puede perder:
 *   T8  · primero el piso de Node: con un `node` viejo NO se toca ninguna línea y el aviso lo dice; cada forma conocida de
 *         `scripts/tests/fixtures/startup-lines.json` (Mac y Windows, incluida la que deja el `bootstrap-heal` viejo) se
 *         reconoce por ESTRUCTURA y se reemplaza UNA vez por la nueva, con copia de `settings.json` y escritura atómica;
 *         los hooks ajenos y su orden quedan intactos; una forma desconocida no se toca y el aviso trae la línea entera y
 *         la nueva; una segunda corrida no cambia nada.
 *   T28 · la línea de Windows va con barras normales y comillas como el resto del `.ps1` (`install-tycon-hooks.ps1:421`).
 *
 * 🔴 rojo previo verificado: sin `scripts/setup/harness/startup-line.js` nada de esto existe.
 * 🔴 Nada toca el HOME real: cada caso arma su `settings.json` en el temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const MODULE = path.join(RAIZ, 'scripts', 'setup', 'harness', 'startup-line.js');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'startup-lines.json'), 'utf8'));
const KNOWN = FIXTURE.forms.filter((f) => f.expect === 'known');
const UNKNOWN = FIXTURE.forms.filter((f) => f.expect === 'unknown');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-startup-line-'));
require('./lib/lab-guard.js').labGuard(BASE, 'harness-startup-line');
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));

const BOOTSTRAP_MARK = '.tycon-pipeline/harness/bootstrap.js';
const ALIEN_BEFORE = { type: 'command', command: 'node "/Users/Lab-user/bin/alien-first.js"' };
const ALIEN_AFTER = { type: 'command', command: 'bash "/Users/Lab-user/bin/alien-last.sh" || true', async: true };

let n = 0;
/** Un settings.json de juguete con un hook ajeno antes, la línea del arnés en el medio y otro ajeno después. */
function settingsWith(form, extra = {}) {
  const dir = path.join(BASE, `s${++n}`); fs.mkdirSync(dir, { recursive: true });
  const hook = { type: 'command', command: form.command };
  if (form.async) hook.async = true;
  const s = Object.assign({ cleanupPeriodDays: 365, permissions: { allow: ['Bash(git status)'] }, hooks: {
    SessionStart: [{ hooks: [ALIEN_BEFORE] }, { hooks: [hook] }, { hooks: [ALIEN_AFTER] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/Users/Lab-user/bin/alien-pre.js"' }] }],
  } }, extra);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  return file;
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sessionStart = (f) => read(f).hooks.SessionStart.map((e) => e.hooks[0]);
const backups = (f) => fs.readdirSync(path.dirname(f)).filter((x) => x.startsWith('settings.json.bak.'));
const platformOf = (form) => (form.platform === 'windows' ? 'win32' : 'darwin');
const HOME_POSIX = '/Users/Lab-user';
const HOME_WIN = 'C:\\Users\\Lab-user';
const homeOf = (form) => (form.platform === 'windows' ? HOME_WIN : HOME_POSIX);

function mod() { return require(MODULE); }

// ─── la fixture y la línea nueva ──────────────────────────────────────────────────────────────────────────────────────

test('T8 · la fixture trae las formas medidas, cada una con id, plataforma, async, expect y comando', () => {
  const ids = new Set();
  for (const f of FIXTURE.forms) {
    for (const k of ['id', 'platform', 'async', 'expect', 'command']) assert.ok(k in f, `la forma ${f.id} no trae «${k}»`);
    assert.ok(!ids.has(f.id), `id repetido: ${f.id}`); ids.add(f.id);
    assert.ok(['posix', 'windows'].includes(f.platform) && ['known', 'unknown'].includes(f.expect), f.id);
    // sin nombres reales: lo mide new-names.js en el pre-commit (T1 lo corre sobre scripts/setup/); acá, que el usuario sea el inventado
    // el usuario inventado empieza en mayúscula a propósito: el detector de publicación toma `/Users/<minúscula>…/` por
    // una ruta de máquina real (la tanda A rompió así la copia pública del núcleo, 2026-10-02)
    assert.ok(!/\/Users\/(?!Lab-user\b)[\w.-]+/.test(f.command), `${f.id}: un usuario que no es el inventado (Lab-user)`);
  }
  for (const id of ['canonical-posix', 'canonical-windows', 'sourcecode-clone-no-engram', 'no-engram', 'no-installer', 'no-ff', 'canonical-posix-async-false', 'heal-appended']) {
    assert.ok(ids.has(id), `falta la forma «${id}» en la fixture`);
  }
  assert.ok(UNKNOWN.length >= 1, 'hace falta al menos una forma inventada (expect: unknown)');
  assert.strictEqual(FIXTURE.forms.find((f) => f.id === 'canonical-posix-async-false').async, false);
  assert.ok(FIXTURE.forms.find((f) => f.id === 'heal-appended').command.includes('\nbash "'), 'heal-appended lleva el instalador pegado con salto de línea');
});

test('T8 · newLine: la de Mac/Linux es la del AC 4d tal cual, async: true', () => {
  const r = mod().newLine(HOME_POSIX, 'darwin');
  assert.strictEqual(r.command, FIXTURE.new.posix);
  assert.strictEqual(r.async, true);
  assert.strictEqual(mod().newLine(HOME_POSIX, 'linux').command, FIXTURE.new.posix);
});

test('T28 · newLine en Windows: barras normales, comillas como el .ps1 (:421), <HOME> resuelto', () => {
  const r = mod().newLine(HOME_WIN, 'win32');
  assert.strictEqual(r.async, true);
  assert.strictEqual(r.command, FIXTURE.new.windows.replace(/<HOME>/g, 'C:/Users/Lab-user'));
  assert.ok(!r.command.includes('\\'), `barras invertidas en la línea de Windows: ${r.command}`);
  assert.ok(/^pwsh -NoProfile -ExecutionPolicy Bypass -Command "/.test(r.command), r.command);
  assert.ok(r.command.includes("node 'C:/Users/Lab-user/.claude/.tycon-pipeline/harness/bootstrap.js'"), r.command);
  assert.ok(r.command.includes("& 'C:/Users/Lab-user/.claude/.tycon-pipeline/harness/bootstrap-fallback.ps1'"), r.command);
  assert.ok(/-Command "[^"]*"$/.test(r.command), 'la -Command va entre comillas dobles y adentro sólo simples');
  // en Windows los hooks se escriben con `/` y comillas dobles: desde la story 8.17 (W3) los escribe el aplicador,
  // scripts/setup/apply-hooks.js con --platform windows (antes, install-tycon-hooks.ps1). La línea nueva sigue esa regla.
  // Desde que el arnés tiene su propio Node, un `.js` arranca con el intérprete que elige el aplicador (`jsPrefix`).
  const applier = fs.readFileSync(path.join(RAIZ, 'scripts', 'setup', 'apply-hooks.js'), 'utf8');
  assert.ok(applier.includes('const absCmd = windows ? fwd(abs) : abs;') && applier.includes('command = `${runner === \'node\' ? jsPrefix : runner} "${absCmd}"`'),
    'el aplicador ya no escribe los hooks de Windows con / y comillas como antes: revisar la línea nueva');
});

// ─── classify / isNew ─────────────────────────────────────────────────────────────────────────────────────────────────

test('T8 · classify reconoce por estructura cada forma conocida y devuelve su id', () => {
  const { classify } = mod();
  for (const f of KNOWN) assert.strictEqual(classify(f.command), f.classify_as || f.id, `${f.id}: ${classify(f.command)}`);
});

test('T8 · classify: las formas inventadas dan null; la nueva no es una forma vieja; lo que no es del arnés tampoco', () => {
  const { classify, isNew } = mod();
  for (const f of UNKNOWN) assert.strictEqual(classify(f.command), null, f.id);
  assert.strictEqual(classify(FIXTURE.new.posix), null);
  assert.strictEqual(classify(mod().newLine(HOME_WIN, 'win32').command), null);
  assert.strictEqual(classify('node "/Users/Lab-user/bin/alien.js"'), null);
  assert.strictEqual(classify('cd ~/SourceCode/otro-repo && git pull --ff-only'), null);
  assert.strictEqual(classify(''), null);
  assert.strictEqual(isNew(FIXTURE.new.posix), true);
  assert.strictEqual(isNew(mod().newLine(HOME_WIN, 'win32').command), true);
  for (const f of KNOWN.filter((x) => x.id !== 'heal-appended')) assert.strictEqual(isNew(f.command), false, f.id);
});

test('T8 · classify por estructura: flags en cualquier orden, con o sin redirecciones, un solo repo no alcanza', () => {
  const { classify } = mod();
  const okFlags = 'cd ~/.claude/tycon-claude-guides && git pull --autostash --ff-only; cd ~/.claude/agent-skills && git pull --quiet --autostash --ff-only; bash ~/.claude/tycon-claude-guides/scripts/install-tycon-hooks.sh';
  assert.strictEqual(classify(okFlags), 'no-engram');
  const oneRepo = 'engram sync --import >/dev/null 2>&1 || true; cd ~/.claude/tycon-claude-guides && git pull --ff-only --quiet --autostash 2>/dev/null || true; bash ~/.claude/tycon-claude-guides/scripts/install-tycon-hooks.sh 2>/dev/null || true';
  assert.strictEqual(classify(oneRepo), null, 'sin el pull de agent-skills no es una forma conocida');
  const labClone = 'cd /tmp/lab/clones/harness && git pull --ff-only --quiet --autostash 2>/dev/null || true; cd /tmp/lab/home/.claude/agent-skills && git pull --ff-only --quiet --autostash 2>/dev/null || true; bash /tmp/lab/clones/harness/scripts/install-tycon-hooks.sh 2>/dev/null || true';
  assert.strictEqual(classify(labClone), 'sourcecode-clone-no-engram', 'un clon en una carpeta sin el nombre del repo se reconoce por la ruta del instalador');
});

// ─── migrate: una vez por forma, con copia, atómica, ajenos intactos; segunda corrida sin cambios ──────────────────────

for (const form of KNOWN) {
  test(`T8 · migrate reemplaza UNA vez la forma «${form.id}» (${form.platform}) y la segunda corrida no cambia nada`, () => {
    const { migrate } = mod();
    const file = settingsWith(form);
    const before = fs.readFileSync(file, 'utf8');
    const r = migrate(file, { home: homeOf(form), platform: platformOf(form), nodeOk: true, nodeVersion: '20.19.6' });
    assert.strictEqual(r.changed, true, `${form.id}: ${r.reason}`);
    assert.strictEqual(r.before, form.command);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0 && r.reason.includes(form.classify_as || form.id), `la línea de qué cambió no nombra la forma: ${r.reason}`);
    const expected = mod().newLine(homeOf(form), platformOf(form)).command;
    assert.strictEqual(r.after, expected);
    const ss = sessionStart(file);
    assert.strictEqual(ss.length, 3, 'la cantidad de entradas de SessionStart cambió');
    assert.deepStrictEqual(ss[0], ALIEN_BEFORE, 'el hook ajeno de antes cambió');
    assert.deepStrictEqual(ss[2], ALIEN_AFTER, 'el hook ajeno de después cambió');
    assert.strictEqual(ss[1].command, expected);
    assert.strictEqual(ss[1].async, true, 'la línea nueva va con async: true');
    assert.strictEqual(ss[1].type, 'command');
    const s = read(file);
    assert.strictEqual(s.cleanupPeriodDays, 365); assert.deepStrictEqual(s.permissions, { allow: ['Bash(git status)'] });
    assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].command, 'node "/Users/Lab-user/bin/alien-pre.js"');
    // copia de seguridad con el contenido de antes
    const b = backups(file);
    assert.strictEqual(b.length, 1, `copias: ${b.join(', ')}`);
    assert.strictEqual(r.backup, path.join(path.dirname(file), b[0]));
    assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), before);
    assert.ok(!fs.readdirSync(path.dirname(file)).some((x) => x.endsWith('.tmp') || x.startsWith('.settings.')), 'quedó un temporal de la escritura atómica');
    // segunda corrida: nada
    const after1 = fs.readFileSync(file, 'utf8');
    const r2 = migrate(file, { home: homeOf(form), platform: platformOf(form), nodeOk: true, nodeVersion: '20.19.6' });
    assert.strictEqual(r2.changed, false, `${form.id}: la segunda corrida cambió algo: ${r2.reason}`);
    assert.ok(/ya es la nueva|sin cambios/i.test(r2.reason), r2.reason);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), after1, 'la segunda corrida reescribió el archivo');
    assert.strictEqual(backups(file).length, 1, 'la segunda corrida dejó otra copia');
  });
}

test('T8 · con el piso de Node sin cumplir NO toca ninguna forma y el aviso lo dice', () => {
  const { migrate } = mod();
  for (const form of KNOWN) {
    const file = settingsWith(form);
    const before = fs.readFileSync(file, 'utf8');
    const r = migrate(file, { home: homeOf(form), platform: platformOf(form), nodeOk: false, nodeVersion: '18.0.0' });
    assert.strictEqual(r.changed, false, form.id);
    assert.ok(/Node 18\.0\.0 < 20/.test(r.reason) && /no se migra/.test(r.reason) && /Node 20\+/.test(r.reason), `${form.id}: ${r.reason}`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, `${form.id}: el archivo cambió con Node viejo`);
    assert.strictEqual(backups(file).length, 0, `${form.id}: dejó una copia sin migrar`);
  }
});

test('T8 · checkNode usa el node del PATH que recibe: con uno de mentira v18 dice que no alcanza', () => {
  const { checkNode } = mod();
  const bin = path.join(BASE, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node-version.js'), 'Object.defineProperty(process.versions, "node", { value: "18.0.0" });\n');
  const wrapper = path.join(bin, 'node');
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then echo v18.0.0; exit 0; fi\nexec "${process.execPath}" -r "${path.join(bin, 'node-version.js')}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  assert.strictEqual(execFileSync(wrapper, ['--version'], { encoding: 'utf8' }).trim(), 'v18.0.0');
  const old = checkNode({ env: Object.assign({}, process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }) });
  assert.strictEqual(old.ok, false); assert.strictEqual(old.version, '18.0.0');
  const cur = checkNode({ env: process.env });
  assert.strictEqual(cur.ok, true); assert.strictEqual(cur.version, process.versions.node);
  const none = checkNode({ env: Object.assign({}, process.env, { PATH: bin + '-no-existe' }) });
  assert.strictEqual(none.ok, false); assert.strictEqual(none.version, null);
});

test('T8 · una forma desconocida queda intacta y el aviso trae la línea entera y el texto de la nueva', () => {
  const { migrate, newLine } = mod();
  for (const form of UNKNOWN) {
    const file = settingsWith(form);
    const before = fs.readFileSync(file, 'utf8');
    const r = migrate(file, { home: homeOf(form), platform: platformOf(form), nodeOk: true, nodeVersion: '20.19.6' });
    assert.strictEqual(r.changed, false, form.id);
    assert.ok(/no la reconozco|desconocida/i.test(r.reason), `${form.id}: ${r.reason}`);
    assert.ok(r.reason.includes(form.command), `${form.id}: el aviso no trae la línea entera`);
    assert.ok(r.reason.includes(newLine(homeOf(form), platformOf(form)).command), `${form.id}: el aviso no trae la línea nueva`);
    assert.strictEqual(r.before, form.command);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, `${form.id}: el archivo cambió`);
    assert.strictEqual(backups(file).length, 0);
  }
});

test('T8 · sin ninguna línea del arnés no toca nada (y con addIfMissing la registra, async: true)', () => {
  const { migrate, newLine } = mod();
  const file = settingsWith({ command: 'node "/Users/Lab-user/bin/alien-middle.js"', async: false });
  const before = fs.readFileSync(file, 'utf8');
  const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
  assert.strictEqual(r.changed, false); assert.ok(/sin línea de arranque/i.test(r.reason), r.reason);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  const r2 = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
  assert.strictEqual(r2.changed, true, r2.reason);
  const ss = sessionStart(file);
  assert.strictEqual(ss.length, 4);
  assert.deepStrictEqual(ss.slice(0, 3).map((h) => h.command), [ALIEN_BEFORE.command, 'node "/Users/Lab-user/bin/alien-middle.js"', ALIEN_AFTER.command]);
  assert.deepStrictEqual(ss[3], { type: 'command', command: newLine(HOME_POSIX, 'darwin').command, async: true });
  assert.strictEqual(backups(file).length, 1);
  const r3 = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
  assert.strictEqual(r3.changed, false, r3.reason);
});

test('T8 · un settings.json ilegible o inexistente no se toca y el motivo lo nombra', () => {
  const { migrate } = mod();
  const dir = path.join(BASE, 'broken'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json'); fs.writeFileSync(file, '{ esto no es json');
  const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
  assert.strictEqual(r.changed, false); assert.ok(/ilegible/i.test(r.reason), r.reason);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ esto no es json');
  const r2 = migrate(path.join(dir, 'no-existe.json'), { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
  assert.strictEqual(r2.changed, false); assert.ok(/no existe/i.test(r2.reason), r2.reason);
  assert.strictEqual(fs.existsSync(path.join(dir, 'no-existe.json')), false, 'sin addIfMissing no se crea nada');
});

// Story 8.7, AC 19 (medido el 2026-10-03 en la máquina limpia): una HOME que nunca usó Claude Code no tiene
// settings.json. `install` (addIfMissing) tiene que dejar la línea nueva igual: sin esto el instalador creaba después su
// esqueleto, la línea no quedaba en ningún lado y el reparador de arranque hablaba en la primera sesión.
test('T8 · install sobre una HOME sin settings.json lo crea con la línea nueva (y no hay qué respaldar)', () => {
  const { migrate, newLine } = mod();
  const dir = path.join(BASE, 'fresh-home', '.claude');   // la carpeta tampoco existe: es la primera escritura
  const file = path.join(dir, 'settings.json');
  const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
  assert.strictEqual(r.changed, true, r.reason);
  assert.strictEqual(r.backup, null, 'no había archivo: no hay copia que hacer');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: newLine(HOME_POSIX, 'darwin').command, async: true }] }] } });
  assert.strictEqual(backups(file).length, 0);
  const r2 = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
  assert.strictEqual(r2.changed, false, 'la segunda corrida no cambia nada');
  // el espejo: con un Node que no alcanza no se crea nada, aunque sea install
  const other = path.join(BASE, 'fresh-home-old-node', 'settings.json');
  const r3 = migrate(other, { home: HOME_POSIX, platform: 'darwin', nodeOk: false, nodeVersion: '18.0.0', addIfMissing: true });
  assert.strictEqual(r3.changed, false); assert.strictEqual(fs.existsSync(other), false);
  // y si la carpeta no se puede crear (en su lugar hay un archivo), no tira: lo dice y no registra nada
  const blocked = path.join(BASE, 'fresh-home-blocked'); fs.writeFileSync(blocked, 'un archivo donde iría la carpeta\n');
  const r4 = migrate(path.join(blocked, '.claude', 'settings.json'), { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
  assert.strictEqual(r4.changed, false); assert.ok(/no pude crear .*la línea de arranque no se registró/.test(r4.reason), r4.reason);
});

// Pase adversarial de la tanda C de la 8.7 (2026-10-03): el hermano del caso de arriba. Un settings.json que existe
// pero está VACÍO (0 bytes, un salto de línea, sólo espacios: una escritura truncada, un `touch`). El aplicador lo lee
// como `{}` y le escribe sus hooks; `install` lo daba por «ilegible» y la máquina quedaba instalada sin línea de arranque.
test('T8 · install sobre un settings.json VACÍO lo trata como {} y registra la línea nueva (migrar a secas no lo toca)', () => {
  const { migrate, newLine } = mod();
  const dir = path.join(BASE, 'empty-settings'); fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of [['zero', ''], ['newline', '\n'], ['spaces', '  \n\t\n']]) {
    const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, content);
    // sin addIfMissing (la migración de cada arranque): un archivo vacío no tiene nada que migrar y no se toca
    const r0 = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
    assert.strictEqual(r0.changed, false, `${name}: ${r0.reason}`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content, `${name}: migrar a secas no escribe`);
    const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
    assert.strictEqual(r.changed, true, `${name}: ${r.reason}`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
      { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: newLine(HOME_POSIX, 'darwin').command, async: true }] }] } }, name);
  }
  // el espejo: un archivo con contenido que NO es JSON sigue siendo ilegible, también en install
  const broken = path.join(dir, 'broken.json'); fs.writeFileSync(broken, '{ esto no es json');
  const rb = migrate(broken, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6', addIfMissing: true });
  assert.strictEqual(rb.changed, false); assert.ok(/ilegible/i.test(rb.reason), rb.reason);
  assert.strictEqual(fs.readFileSync(broken, 'utf8'), '{ esto no es json');
});

test('T8 · dos líneas viejas conocidas en el mismo settings.json se funden en UNA nueva', () => {
  const { migrate, newLine } = mod();
  const a = FIXTURE.forms.find((f) => f.id === 'canonical-posix');
  const b = FIXTURE.forms.find((f) => f.id === 'no-installer');
  const file = settingsWith(a);
  const s = read(file); s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: b.command, async: true }] });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
  assert.strictEqual(r.changed, true, r.reason);
  const cmds = sessionStart(file).map((h) => h.command);
  assert.deepStrictEqual(cmds, [ALIEN_BEFORE.command, newLine(HOME_POSIX, 'darwin').command, ALIEN_AFTER.command]);
});

test('T8 · el módulo es núcleo público: no hace require del perfil, de legacy-names ni de renames', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  assert.ok(!/legacy-names|renames\.json|perfil-equipo|team-profile/.test(src), 'startup-line.js depende de algo que la copia pública no trae');
});

// ─── Regresiones del pase adversarial y de los revisores (iteración 1, 2026-10-02) ───────────────────────────────────

test('REG-D11 · Windows: un HOME con apóstrofe va escapado dentro de las comillas simples de PowerShell', () => {
  const { newLine } = mod();
  const { command } = newLine("C:\\Users\\O'Brien", 'win32');
  assert.ok(command.includes("C:/Users/O''Brien/.claude/.tycon-pipeline/harness/bootstrap.js"), command);
  assert.ok(!/O'Brien/.test(command.replace(/O''Brien/g, '')), `quedó una comilla sin escapar: ${command}`);
});

test('REG-W1 · la línea mínima que deja el bootstrap-heal viejo (sólo el instalador, ruta entre comillas) es una forma conocida y se migra', () => {
  const { classify, migrate, newLine } = mod();
  const form = FIXTURE.forms.find((f) => f.id === 'installer-only');
  assert.ok(form, 'la fixture trae la forma installer-only');
  assert.strictEqual(classify(form.command), 'installer-only');
  const file = settingsWith(form);
  const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
  assert.strictEqual(r.changed, true, r.reason);
  assert.ok(sessionStart(file).some((h) => h.command === newLine(HOME_POSIX, 'darwin').command));
});

test('REG-W2 · pasos propios del dev (otro instalador, una redirección a un archivo, engram con argumentos) hacen la forma desconocida: no se tocan', () => {
  const { classify, migrate } = mod();
  for (const id of ['unknown-second-installer', 'unknown-redirect-step', 'unknown-engram-args']) {
    const form = FIXTURE.forms.find((f) => f.id === id);
    assert.ok(form, `la fixture trae ${id}`);
    assert.strictEqual(classify(form.command), null, `${id} se clasificó como conocida`);
    const file = settingsWith(form);
    const before = fs.readFileSync(file, 'utf8');
    const r = migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
    assert.strictEqual(r.changed, false, `${id}: ${r.reason}`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, `${id}: settings.json cambió`);
  }
});

test('REG-W3 · dos líneas nuevas junto a una vieja: queda UNA sola nueva', () => {
  const { migrate, newLine } = mod();
  const old = FIXTURE.forms.find((f) => f.id === 'canonical-posix');
  const file = settingsWith(old);
  const s = read(file);
  const nl = newLine(HOME_POSIX, 'darwin').command;
  s.hooks.SessionStart.push({ hooks: [{ type: 'command', command: nl, async: true }] }, { hooks: [{ type: 'command', command: nl, async: true }] });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  migrate(file, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' });
  const n = sessionStart(file).filter((h) => h.command.includes(BOOTSTRAP_MARK)).length;
  assert.strictEqual(n, 1, `quedaron ${n} líneas nuevas`);
});

test('T21 · Applier_NoLegacyBakUnderHarness_YesStandalone: bajo harness.js (backup:false o TYCON_HARNESS_SNAPSHOT_DIR) la migración no deja .bak; suelta, sí', () => {
  const { migrate } = mod();
  const old = FIXTURE.forms.find((f) => f.id === 'canonical-posix');
  const opts = { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '20.19.6' };
  const a = settingsWith(old);
  assert.strictEqual(migrate(a, Object.assign({ backup: false }, opts)).changed, true);
  assert.deepStrictEqual(backups(a), [], 'con backup:false dejó un .bak');
  const b = settingsWith(old);
  const prev = process.env.TYCON_HARNESS_SNAPSHOT_DIR;
  process.env.TYCON_HARNESS_SNAPSHOT_DIR = path.join(BASE, 'snap');
  try { assert.strictEqual(migrate(b, opts).changed, true); } finally { if (prev === undefined) delete process.env.TYCON_HARNESS_SNAPSHOT_DIR; else process.env.TYCON_HARNESS_SNAPSHOT_DIR = prev; }
  assert.deepStrictEqual(backups(b), [], 'con TYCON_HARNESS_SNAPSHOT_DIR dejó un .bak');
  const c = settingsWith(old);
  assert.strictEqual(migrate(c, opts).changed, true);
  assert.strictEqual(backups(c).length, 1, 'suelta no dejó su .bak');
});

// ─── story 8.17 · la línea de Windows corre igual por cualquier shell ────────────────────────────────────────
// En Windows, Claude Code le pasa el comando de un hook a Git Bash («Git Bash on Windows, or PowerShell when Git Bash
// isn't installed»): bash expande lo que empieza con `$` dentro de comillas dobles. La forma que escribió la 8.13
// (`if ($LASTEXITCODE -ne 0)`) salía 1 en cada sesión y el respaldo no corría nunca (medido en un agente Windows).

test('W-S1 · StartupLine_Windows_HasNothingAShellExpands: la línea nueva de Windows no trae `$`, acentos graves ni `!`', () => {
  const { newLine, isNew, isSuperseded } = mod();
  for (const home of [HOME_WIN, "C:\\Users\\O'Brien", 'D:\\gente\\Lab user']) {
    const { command } = newLine(home, 'win32');
    assert.doesNotMatch(command, /[$`!]/, `algo que bash expande dentro de comillas dobles: ${command}`);
    assert.ok(isNew(command));
    assert.strictEqual(isSuperseded(command), false);
    // una sola pareja de comillas dobles por fuera: adentro, sólo simples
    assert.strictEqual((command.match(/"/g) || []).length, 2, command);
  }
  // la anterior sí lo traía, y por eso se reconoce como «a reemplazar»
  const prev = FIXTURE.superseded.windows.replace(/<HOME>/g, 'C:/Users/Lab-user');
  assert.match(prev, /\$LASTEXITCODE/);
  assert.strictEqual(isNew(prev), true);
  assert.strictEqual(isSuperseded(prev), true);
  // con otra carpeta en cada lado no es la forma conocida: no se toca
  assert.strictEqual(isSuperseded(prev.replace("& 'C:/Users/Lab-user/", "& 'C:/Users/Otro/")), false);
  // la de Mac/Linux no cambia ni se confunde
  assert.strictEqual(isSuperseded(FIXTURE.new.posix), false);
});

test('W-S2 · StartupLine_SupersededWindows_IsRewrittenOnce: la forma anterior pasa a la de ahora, una sola vez, sin tocar lo ajeno', () => {
  const { migrate, newLine } = mod();
  const prev = FIXTURE.superseded.windows.replace(/<HOME>/g, 'C:/Users/Lab-user');
  const file = settingsWith({ command: prev, async: true });
  const before = read(file);
  const r = migrate(file, { home: HOME_WIN, platform: 'win32', nodeOk: true, nodeVersion: '22.1.0' });
  assert.strictEqual(r.changed, true, r.reason);
  assert.match(r.reason, /Git Bash/);
  assert.strictEqual(r.before, prev);
  const hooks = sessionStart(file);
  assert.deepStrictEqual(hooks[0], ALIEN_BEFORE);
  assert.deepStrictEqual(hooks[2], ALIEN_AFTER);
  assert.strictEqual(hooks[1].command, newLine(HOME_WIN, 'win32').command);
  assert.strictEqual(hooks[1].async, true);
  assert.deepStrictEqual(read(file).hooks.PreToolUse, before.hooks.PreToolUse);
  assert.strictEqual(backups(file).length, 1);
  // la segunda vez no cambia nada
  const again = migrate(file, { home: HOME_WIN, platform: 'win32', nodeOk: true, nodeVersion: '22.1.0' });
  assert.strictEqual(again.changed, false, again.reason);
  assert.match(again.reason, /ya es la nueva/);
  assert.strictEqual(backups(file).length, 1);
  // en Mac/Linux esa línea no es de la plataforma: no se toca
  const other = settingsWith({ command: prev, async: true });
  const posix = migrate(other, { home: HOME_POSIX, platform: 'darwin', nodeOk: true, nodeVersion: '22.1.0' });
  assert.strictEqual(posix.changed, false, posix.reason);
  assert.strictEqual(sessionStart(other)[1].command, prev);
});

const PWSH_BIN = String(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')).find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
test('W-S3 · StartupLine_Windows_RunsTheSameThroughBash: corrida de verdad, directa y por `bash -c`, con la copia fija de juguete', { skip: PWSH_BIN ? false : 'NO MEDIDO: no hay pwsh en el PATH (lo mide el pipeline de Windows)' }, () => {
  const { spawnSync } = require('child_process');
  const { newLine } = mod();
  const lab = (name, bootstrapExit) => {
    const home = path.join(BASE, name);
    const dir = path.join(home, '.claude', '.tycon-pipeline', 'harness');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bootstrap.js'), `require('fs').appendFileSync(${JSON.stringify(path.join(home, 'ran.txt'))}, 'bootstrap\\n'); process.exit(${bootstrapExit});\n`);
    fs.writeFileSync(path.join(dir, 'bootstrap-fallback.ps1'), `Add-Content -Path '${path.join(home, 'ran.txt').replace(/'/g, "''")}' -Value 'fallback'\nexit 0\n`);
    return home;
  };
  const env = { PATH: process.env.PATH, HOME: path.join(BASE, 'pwsh-home'), XDG_CACHE_HOME: path.join(BASE, 'xdg-c'), XDG_DATA_HOME: path.join(BASE, 'xdg-d'), XDG_CONFIG_HOME: path.join(BASE, 'xdg-g'), POWERSHELL_TELEMETRY_OPTOUT: '1' };
  fs.mkdirSync(env.HOME, { recursive: true });
  const ran = (home) => (fs.existsSync(path.join(home, 'ran.txt')) ? fs.readFileSync(path.join(home, 'ran.txt'), 'utf8').trim().split(/\r?\n/) : []);
  const launchers = {
    direct: (command) => spawnSync(command, { shell: true, encoding: 'utf8', env, timeout: 60000 }),
    'bash -c': (command) => spawnSync('bash', ['-c', command], { encoding: 'utf8', env, timeout: 60000 }),
  };
  for (const [how, launch] of Object.entries(launchers)) {
    // la copia fija sale 0: el respaldo no corre
    let home = lab(`ok-${how.replace(/\W/g, '')}`, 0);
    let r = launch(newLine(home, 'win32').command);
    assert.strictEqual(r.status, 0, `${how}: ${r.stderr}`);
    assert.deepStrictEqual(ran(home), ['bootstrap'], `${how}: con la copia fija sana corre sólo ella`);
    // la copia fija sale 3: el respaldo corre, y la línea termina bien
    home = lab(`bad-${how.replace(/\W/g, '')}`, 3);
    r = launch(newLine(home, 'win32').command);
    assert.deepStrictEqual(ran(home), ['bootstrap', 'fallback'], `${how}: si la copia fija falla, corre el respaldo — ${r.stderr}`);
    assert.strictEqual(r.status, 0, `${how}: ${r.stderr}`);
    // el control del rojo: la forma anterior, por bash, NO llega a correr el respaldo (es lo que se midió en Windows)
    if (how === 'bash -c') {
      home = lab('prev-bash', 3);
      const prev = FIXTURE.superseded.windows.replace(/<HOME>/g, () => home);
      r = launch(prev);
      assert.deepStrictEqual(ran(home), ['bootstrap'], 'la forma anterior por bash no dispara el respaldo: si lo dispara, esta prueba no mide nada');
      assert.notStrictEqual(r.status, 0);
    }
  }
});

// ─── story 8.17 · la línea vieja registrada con el PowerShell que trae Windows ───────────────────────────────
// El alta mandaba registrar la línea con el PowerShell que hubiera: con sólo el 5.1 quedaba `powershell`, y el
// mecanismo sólo reconocía las que empiezan con `pwsh`. Medido en una máquina Windows 11: esa máquina se quedaba con
// la línea vieja para siempre, y `doctor` decía «nada en rojo».

test('W-S4 · StartupLine_OldWindowsLine_WithWindowsPowerShell_IsKnownAndMigrated', () => {
  const { classify, migrate, newLine } = mod();
  const canonical = FIXTURE.forms.find((f) => f.id === 'canonical-windows');
  assert.ok(canonical && /^pwsh /.test(canonical.command));
  const lines = [
    canonical.command.replace(/^pwsh /, 'powershell '),
    canonical.command.replace(/^pwsh /, 'powershell.exe '),
    // la del texto del alta, tal como quedó en la máquina medida
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Set-Location $env:USERPROFILE\\SourceCode\\tycon-claude-guides; git pull --quiet; Set-Location $env:USERPROFILE\\.claude\\agent-skills; git pull --quiet --autostash; & $env:USERPROFILE\\SourceCode\\tycon-claude-guides\\scripts\\install-tycon-hooks.ps1 } catch {}"',
  ];
  for (const command of lines) {
    assert.strictEqual(classify(command), 'canonical-windows', command.slice(0, 40));
    const file = settingsWith({ command, async: true });
    const r = migrate(file, { home: HOME_WIN, platform: 'win32', nodeOk: true, nodeVersion: '22.1.0' });
    assert.strictEqual(r.changed, true, r.reason);
    const hooks = sessionStart(file);
    assert.strictEqual(hooks[1].command, newLine(HOME_WIN, 'win32').command, 'queda la nueva, que se escribe con pwsh');
    assert.match(hooks[1].command, /^pwsh /);
    assert.deepStrictEqual(hooks[0], ALIEN_BEFORE);
    assert.deepStrictEqual(hooks[2], ALIEN_AFTER);
  }
  // otro programa que se llame parecido no es una línea del arnés
  assert.strictEqual(classify(canonical.command.replace(/^pwsh /, 'powershellx ')), null);
  assert.strictEqual(classify(canonical.command.replace(/^pwsh /, 'cmd /c ')), null);
});

test('W-S5 · Doctor_OldStartupLine_IsSaid: con la línea de arranque en una forma vieja, doctor lo dice (rojo para una persona, aviso en la comprobación de salud)', () => {
  const { spawnSync } = require('child_process');
  const HARNESS = path.join(__dirname, '..', 'setup', 'harness.js');
  const lab = (name, command) => {
    const home = path.join(BASE, name);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }, null, 2));
    return { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  };
  const doctor = (env) => JSON.parse(spawnSync(process.execPath, [HARNESS, 'doctor', '--json'], { encoding: 'utf8', env, timeout: 60000 }).stdout);
  const canonical = FIXTURE.forms.find((f) => f.id === 'canonical-posix');
  const said = (list) => list.some((x) => /la línea de arranque de .* está en una forma vieja \(1\): esta máquina no se actualiza sola — harness\.js startup la pasa a la nueva/.test(x));
  // una forma vieja conocida
  let d = doctor(lab('doc-old', canonical.command));
  assert.ok(said(d.fail), JSON.stringify(d));
  // la misma, dentro de la comprobación de salud de una actualización: aviso, no rojo
  d = doctor(Object.assign(lab('doc-old-health', canonical.command), { TYCON_HARNESS_HEALTH: '1' }));
  assert.ok(said(d.warn) && !said(d.fail), JSON.stringify(d));
  // la nueva: nada que decir
  d = doctor(lab('doc-new', FIXTURE.new.posix));
  assert.ok(!said(d.fail) && !said(d.warn), JSON.stringify(d));
  // un hook ajeno en SessionStart no es una línea del arnés
  d = doctor(lab('doc-alien', 'node "/Users/Lab-user/bin/alien-first.js"'));
  assert.ok(!said(d.fail) && !said(d.warn), JSON.stringify(d));
});
