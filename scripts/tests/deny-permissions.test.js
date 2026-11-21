'use strict';
// deny-permissions.test.js — las reglas deny del arnés (permissions.deny de Claude Code): niegan borrar la raíz del disco
// y la carpeta personal entera aunque los ganchos estén apagados. Salen de RULES en deny-permissions.js; el freno de mano sigue como
// segunda red y frena cada una con el mismo id; el instalador las suma sin pisar las del dev y desinstalar saca sólo
// las suyas.
// Todo en una casa de juguete en una carpeta temporal. Nada lee ni escribe la casa real.
// Correr: cd scripts/tests && HOME=$(mktemp -d) node --test deny-permissions.test.js < /dev/null

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const H = path.join(ROOT, 'scripts', 'setup', 'harness');
const DP = require(path.join(H, 'deny-permissions.js'));
const SH = require(path.join(H, 'shared.js'));
const RM = require(path.join(H, 'remove.js'));
const M = require(path.join(H, 'managed.js'));
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh');

function casa(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tree = path.join(home, '.tycon', 'harness');
  fs.mkdirSync(path.join(tree, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  return { home, tree, settings, env: { TYCON_SETTINGS_PATH: settings, TYCON_NO_COMMANDS_SYNC: '1', TYCON_NO_READ_PERMISSIONS: '1', TYCON_NO_MODS: '1' } };
}
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const instalar = (c, extra = {}) => SH.applyShared({ home: c.home, env: c.env, tree: c.tree, backup: false, settings: true, ...extra });
const ADENTRO = (c) => (leer(c.settings).permissions || {}).deny || [];

test('T1 DenyRules_SonLasDosDeclaradas — la raíz y la carpeta personal entera, en forma exacta y sin comodín', () => {
  const cat = DP.catalog();
  assert.deepStrictEqual(cat.map((r) => r.id), ['FS-C2', 'FS-C3']);
  for (const r of cat) assert.ok(r.porque && r.porque.length > 20, `${r.id} dice por qué nunca necesita emergencia`);
  const reglas = DP.ourRules();
  assert.ok(reglas.includes('Bash(rm -rf /)'));
  assert.ok(reglas.includes('Bash(rm -rf ~)'));
  assert.ok(reglas.includes('Bash(rm -fr $HOME/)'));
  for (const r of reglas) {
    assert.match(r, /^Bash\(rm [-rRfF ]+ (\/|~\/?|\$HOME\/?)\)$/, r);
    assert.doesNotMatch(r, /\*/, `${r}: sin comodín, que frenaría también rm -rf /tmp/x`);
  }
  assert.strictEqual(new Set(reglas).size, reglas.length, 'sin repetidas');
});

test('T2 DenyRules_ElFrenoDeManoFrenaCadaUna — la segunda red frena lo mismo, con el mismo id', () => {
  for (const r of DP.catalog()) {
    for (const regla of r.deny) {
      const cmd = /^Bash\((.*)\)$/.exec(regla)[1];
      const res = spawnSync('bash', [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: os.tmpdir() }), encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dp-guard-')) } });
      assert.strictEqual(res.status, 2, `${cmd}: el freno de mano no lo frenó (${res.stderr.slice(0, 200)})`);
      assert.ok(res.stderr.includes(`[${r.id}]`), `${cmd}: frenó con otro id (${res.stderr.slice(0, 200)})`);
    }
  }
});

test('T3 Install_SumaSinPisarLasDelDev — las del dev quedan en su orden; una igual es del dev y no se anota', (t) => {
  const c = casa(t);
  fs.writeFileSync(c.settings, JSON.stringify({ permissions: { deny: ['Bash(git push --force *)', 'Bash(rm -rf /)'], allow: ['Bash(ls *)'] } }, null, 2));
  const r = instalar(c);
  assert.ok(r.ok, r.reason);
  const deny = ADENTRO(c);
  assert.deepStrictEqual(deny.slice(0, 2), ['Bash(git push --force *)', 'Bash(rm -rf /)'], 'lo del dev, primero y en su orden');
  for (const regla of DP.ourRules()) assert.strictEqual(deny.filter((x) => x === regla).length, 1, `${regla} una sola vez`);
  assert.deepStrictEqual(leer(c.settings).permissions.allow, ['Bash(ls *)'], 'allow no se toca');
  const ids = r.pieces.filter((p) => DP.isRuleId(p.id)).map((p) => DP.ruleOf(p.id));
  assert.ok(!ids.includes('Bash(rm -rf /)'), 'la que ya tenía el dev es suya: no se anota');
  assert.strictEqual(ids.length, DP.ourRules().length - 1);
  for (const p of r.pieces.filter((x) => DP.isRuleId(x.id))) assert.strictEqual(M.present(p, { home: c.home, env: c.env }), true, p.id);
  const otra = instalar(c, { previous: r.pieces });
  assert.deepStrictEqual(otra.changed.filter((x) => DP.isRuleId(x)), [], 'la segunda vez no cambia nada');
});

test('T4 Remove_SacaSoloLasPropias — desinstalar saca las anotadas; las del dev quedan', (t) => {
  const c = casa(t);
  fs.writeFileSync(c.settings, JSON.stringify({ permissions: { deny: ['Bash(git push --force *)', 'Bash(rm -rf /)'] } }, null, 2));
  const r = instalar(c);
  RM.removePieces(r.pieces.filter((p) => DP.isRuleId(p.id)), { home: c.home, env: c.env });
  assert.deepStrictEqual(ADENTRO(c), ['Bash(git push --force *)', 'Bash(rm -rf /)'], 'quedan exactamente las del dev');
  // sin nada del dev: desinstalar deja settings.json sin permissions
  const d = casa(t);
  fs.writeFileSync(d.settings, '{}');
  const r2 = instalar(d);
  RM.removePieces(r2.pieces.filter((p) => DP.isRuleId(p.id)), { home: d.home, env: d.env });
  assert.strictEqual(leer(d.settings).permissions, undefined);
});

test('T5 Install_ApagadoOPerfilMinimo_NoSuma — con TYCON_NO_DENY_RULES=1 o en el perfil mínimo no se suman', (t) => {
  const c = casa(t);
  fs.writeFileSync(c.settings, '{}');
  instalar(c, { env: { ...c.env, TYCON_NO_DENY_RULES: '1' } });
  assert.deepStrictEqual(ADENTRO(c), []);
  const d = casa(t);
  fs.writeFileSync(d.settings, '{}');
  SH.applyShared({ home: d.home, env: { ...d.env, TYCON_NO_READ_PERMISSIONS: '' }, tree: d.tree, backup: false, settings: false });
  assert.deepStrictEqual((leer(d.settings).permissions || {}).deny || [], [], 'el perfil mínimo sólo trae las reglas de lectura');
});

test('T6 Install_ListaConOtraForma_NoSeToca — un deny que no es una lista no se toca y se dice', (t) => {
  const c = casa(t);
  fs.writeFileSync(c.settings, JSON.stringify({ permissions: { deny: 'Bash(rm *)' } }));
  const r = instalar(c);
  assert.strictEqual(leer(c.settings).permissions.deny, 'Bash(rm *)');
  assert.ok(r.notes.some((n) => /permissions\.deny» no es una lista/.test(n)), r.notes.join(' | '));
});

// Pase adversarial (21/11): pasar al perfil mínimo las saca; una regla anotada que ya no es del arnés se saca en el camino
// real (applyShared con reads: false); y el módulo anda solo, como en la copia fija del programa (sólo los .js).
test('T7 Profile_PasarAMinimoLasSaca — su efecto declara sólo el perfil completo', (t) => {
  const c = casa(t);
  fs.writeFileSync(c.settings, '{}');
  const r = instalar(c);
  const deny = r.pieces.filter((p) => DP.isRuleId(p.id));
  const PR = require(path.join(H, 'profile.js'));
  const effects = M.readEffects(ROOT).effects;
  const fuera = PR.toRemove(deny, [], () => false, { effects, profile: 'minimal' });
  assert.strictEqual(fuera.length, deny.length, 'el cambio a mínimo saca todas');
  assert.ok(require(path.join(H, 'plan.js')).effectFor(deny[0], effects), 'el plan las describe');
});

test('T8 Install_ReglaAnotadaQueYaNoEsDelArnes_SeSaca — también con reads: false, como lo llama harness.js', (t) => {
  const c = casa(t);
  fs.writeFileSync(c.settings, JSON.stringify({ permissions: { deny: ['Bash(rm -rf /vieja)', 'Bash(npm publish *)'] } }));
  const vieja = { kind: 'setting', where: c.settings, id: DP.pieceId('Bash(rm -rf /vieja)'), value: 'Bash(rm -rf /vieja)' };
  const r = instalar(c, { reads: false, previous: [vieja] });
  const deny = ADENTRO(c);
  assert.ok(!deny.includes('Bash(rm -rf /vieja)'), 'la anotada que ya no está en la lista se saca');
  assert.ok(deny.includes('Bash(npm publish *)'), 'la del dev queda');
  assert.ok(r.notes.some((n) => /saqué .* regla\(s\) deny/.test(n)), r.notes.join(' | '));
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness.js'), 'utf8');
  assert.match(src, /reads, previous: managedBefore\(ctx, log\) \}\)/, 'harness.js le pasa el registro siempre');
});

test('T9 Module_AndaSoloComoEnLaCopiaFija — sólo los .js de la carpeta, sin archivos de datos', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-copia-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  for (const f of fs.readdirSync(H).filter((x) => x.endsWith('.js'))) fs.copyFileSync(path.join(H, f), path.join(d, f));
  const copia = require(path.join(d, 'deny-permissions.js'));
  assert.deepStrictEqual(copia.ourRules(), DP.ourRules());
});
