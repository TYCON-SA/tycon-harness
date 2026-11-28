'use strict';
/**
 * codex-deny-rules.test.js — las reglas que le prohíben a Codex borrar la raíz del disco o la carpeta personal entera
 * (build/deploy-codex-rules.js), escritas desde la misma lista que las deny de Claude Code
 * (scripts/setup/harness/deny-permissions.js). A62.
 *
 * Cada caso tiene su casa y su carpeta de Codex de juguete (mkdtemp): nunca la casa real. El caso que le pregunta a Codex
 * si el archivo frena corre sólo si `codex` está instalado; `codex execpolicy check` sólo mira las reglas, no ejecuta nada.
 *
 * Correr: node --test scripts/tests/codex-deny-rules.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RULES_JS = path.join(ROOT, 'build', 'deploy-codex-rules.js');
const DP = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'deny-permissions.js'));
const R = () => require(RULES_JS);

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deny-'));
  dirs.push(home);
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  return { home, codexHome, file: path.join(codexHome, 'rules', 'harness-deny.rules') };
}
const env = (w, extra = {}) => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^TYCON_|^CODEX_/.test(k)) e[k] = v;
  return { ...e, HOME: w.home, USERPROFILE: w.home, CODEX_HOME: w.codexHome, ...extra };
};
const run = (w, extra) => spawnSync(process.execPath, [RULES_JS], { env: env(w, extra), encoding: 'utf8' });
// el comando de una regla deny de Claude Code, en palabras: `Bash(rm -r -f ~)` → ['rm', '-r', '-f', '~']
const words = (rule) => rule.replace(/^Bash\(/, '').replace(/\)$/, '').split(' ');

test('A62-1 Reglas_MismaListaQueClaude — cada deny de Claude Code tiene su regla de Codex, «forbidden» y con su id', () => {
  const pats = R().patterns();
  const claude = DP.ourRules().map(words);
  assert.deepStrictEqual(pats.map((p) => p.pattern), claude, 'las mismas formas, en el mismo orden');
  for (const p of pats) assert.match(p.justification, /^FS-C[23]: /);
  const text = R().rulesText();
  assert.match(text.split('\n')[0], /^# harness-deny: /, 'el archivo dice de quién es en el primer renglón');
  assert.strictEqual((text.match(/prefix_rule\(/g) || []).length, claude.length);
  assert.strictEqual((text.match(/decision = "forbidden"/g) || []).length, claude.length);
});

test('A62-2 Despliegue_ArchivoPropio_NoTocaDefault — escribe su archivo en rules/, una vez, y deja default.rules de la persona', () => {
  const w = world();
  fs.mkdirSync(path.dirname(w.file), { recursive: true });
  const suyo = path.join(w.codexHome, 'rules', 'default.rules');
  fs.writeFileSync(suyo, 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n');
  const r1 = run(w);
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.strictEqual(fs.readFileSync(w.file, 'utf8'), R().rulesText());
  const t1 = fs.statSync(w.file).mtimeMs;
  const r2 = run(w);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(fs.statSync(w.file).mtimeMs, t1, 'igual: no se reescribe');
  assert.strictEqual(fs.readFileSync(suyo, 'utf8'), 'prefix_rule(pattern = ["git", "status"], decision = "allow")\n', 'default.rules queda como estaba');
});

test('A62-3 Despliegue_ArchivoAjeno_NoSePisa — un archivo con el mismo nombre que no es del arnés queda y se avisa', () => {
  const w = world();
  fs.mkdirSync(path.dirname(w.file), { recursive: true });
  fs.writeFileSync(w.file, '# mío\n');
  const r = run(w);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(w.file, 'utf8'), '# mío\n');
  assert.match(r.stdout, /⚠ tycon\/codex: .*harness-deny\.rules/);
});

test('A62-4 Interruptor_LoApaga — con TYCON_NO_DENY_RULES=1 no se escribe, y el del arnés se saca; uno ajeno, no', () => {
  const w = world();
  assert.strictEqual(run(w).status, 0);
  assert.ok(fs.existsSync(w.file));
  assert.strictEqual(run(w, { TYCON_NO_DENY_RULES: '1' }).status, 0);
  assert.ok(!fs.existsSync(w.file), 'apagado: se saca el archivo del arnés');
  fs.writeFileSync(w.file, '# mío\n');
  run(w, { TYCON_NO_DENY_RULES: '1' });
  assert.strictEqual(fs.readFileSync(w.file, 'utf8'), '# mío\n', 'uno ajeno no se toca');
});

test('A62-8 Perfil_LosDos — como todo el lado Codex, va también en el perfil mínimo (lo de una integración va en los dos)', () => {
  const w = world();
  const r = run(w, { TYCON_INSTALL_PROFILE: 'minimal' });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.ok(fs.existsSync(w.file), r.stdout);
});

test('A62-5 Piezas_LoCuentaYLoSaca — el archivo del arnés es una pieza de Codex (se saca al desinstalar); uno ajeno no', () => {
  const T = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tools.js'));
  const w = world();
  run(w);
  const ids = () => T.codexPieces({ tree: ROOT, home: w.home, env: env(w) }).map((p) => p.id);
  assert.ok(ids().includes('rules/harness-deny.rules'));
  fs.writeFileSync(w.file, '# mío\n');
  assert.ok(!ids().includes('rules/harness-deny.rules'));
});

test('A62-6 DespliegueDeCodex_LoCorreYLoExige — el paso está en el despliegue, y sin el archivo el despliegue se repone', () => {
  const src = fs.readFileSync(path.join(ROOT, 'build', 'deploy-codex-all.js'), 'utf8');
  assert.match(src, /script: 'deploy-codex-rules\.js'/);
  assert.match(src, /R\.wanted\(process\.env\) && !fs\.existsSync\(R\.rulesFile\(CODEX_HOME\)\)/, 'outputsPresent lo exige cuando la máquina lo lleva');
  const w = world();
  assert.strictEqual(R().wanted(env(w)), true);
  assert.strictEqual(R().wanted(env(w, { TYCON_INSTALL_PROFILE: 'minimal' })), true, 'también en el mínimo');
  assert.strictEqual(R().wanted(env(w, { TYCON_NO_DENY_RULES: '1' })), false);
  const all = require(path.join(ROOT, 'build', 'deploy-codex-all.js'));
  assert.notStrictEqual(all.fingerprint({ ...process.env, TYCON_NO_DENY_RULES: '1' }), all.fingerprint({ ...process.env, TYCON_NO_DENY_RULES: '0' }), 'apagarlas redespliega');
});

const CODEX = (() => { const w = world(); return spawnSync('codex', ['--version'], { encoding: 'utf8', env: env(w) }).status === 0; })();
test('A62-7 Codex_FrenaLoQueTieneQueFrenar — el verificador de Codex da «forbidden» a la raíz y a la casa, y nada a /tmp/x', { skip: CODEX ? false : 'codex no está instalado' }, () => {
  const w = world();
  run(w);
  // con la casa y la carpeta de Codex de juguete: Codex anota cosas en su carpeta al correr
  const check = (cmd) => JSON.parse(spawnSync('codex', ['execpolicy', 'check', '--rules', w.file, '--', ...cmd], { encoding: 'utf8', env: env(w) }).stdout);
  const rm = 'r' + 'm';
  for (const p of R().patterns()) assert.strictEqual(check(p.pattern).decision, 'forbidden', p.pattern.join(' '));
  assert.strictEqual(check([rm, '-rf', '/', '--no-preserve-root']).decision, 'forbidden');
  assert.deepStrictEqual(check([rm, '-rf', '/tmp/x']).matchedRules, []);
  assert.deepStrictEqual(check([rm, '-rf', '~/.cache/x']).matchedRules, []);
});

test('A62-9 Desinstalar_ArchivoReemplazado_NoSeBorra — si la persona puso el suyo en el lugar del del arnés, desinstalar no lo borra', () => {
  const RM = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'remove.js'));
  const w = world();
  run(w);
  const pieza = { kind: 'codex', where: w.file, id: 'rules/harness-deny.rules' };
  fs.writeFileSync(w.file, '# mío\n');
  const out = RM.removePieces([pieza], { home: w.home, env: env(w), tree: ROOT });
  assert.strictEqual(fs.readFileSync(w.file, 'utf8'), '# mío\n');
  assert.strictEqual(out.kept.length, 1);
  // el del arnés sí se va
  fs.rmSync(w.file);
  run(w);
  RM.removePieces([pieza], { home: w.home, env: env(w), tree: ROOT });
  assert.ok(!fs.existsSync(w.file));
});

test('A62-10 Paridad_MideLasReglas — la auditoría de Claude Code contra Codex da rojo sin el archivo y verde con el del arnés', () => {
  const w = world();
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = w.codexHome;
  try {
    const P = require(path.join(ROOT, 'scripts', 'lib', 'harness-parity.js'));
    const sup = () => P.collect(P.buildCtx({ tools: ['claude', 'codex'], recorded: true })).find((s) => s.name === 'deny-rules');
    assert.strictEqual(sup().ok, false);
    run(w);
    assert.strictEqual(sup().ok, true, sup().detail);
    fs.writeFileSync(w.file, '# mío\n');
    assert.strictEqual(sup().ok, false);
  } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
});
