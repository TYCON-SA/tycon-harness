'use strict';
// El hook que cierra la regla de firewall al terminar la sesión sólo llega a las máquinas autorizadas a tocar
// producción: lo instala `install-guard.sh` (con sudo, en la configuración administrada) y ningún otro instalador.
// Una máquina sin autorizar corre sólo el instalador del arnés; si ése lo registrara, la máquina quedaría con un hook
// que llama a Azure al cerrar cada sesión. Se mide con lo que de verdad decide cada instalador, no con un grep.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AH = require(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'));
const DCH = require(path.join(ROOT, 'build', 'deploy-codex-hooks.js'));
const HOOK = /prod-firewall-close\.js/;

test('UnauthorizedMachine_HarnessInstallerNeverRegistersTheFirewallHook', () => {
  const list = AH.loadList(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), { integrationsDir: path.join(ROOT, 'integrations') });
  // todas las combinaciones que el instalador del arnés puede tomar: perfil, plataforma y cada integración prendida
  // (el lector de la configuración da '1' por cada una; ésta lo da para cualquier nombre que se le pregunte)
  const todas = new Proxy({}, { get: () => '1' });
  for (const profile of ['full', 'minimal']) {
    for (const platform of ['posix', 'windows']) {
      for (const timeTracking of ['none', 'clockify', 'solidtime']) {
        const r = AH.decide(list, { env: {}, integ: { state: 'ok', values: todas, timeTracking }, profile: { state: 'ok', value: profile }, minimalIds: null, platform });
        const lo = r.active.filter((h) => HOOK.test(h.spec || ''));
        assert.deepStrictEqual(lo, [], `${profile}/${platform}/${timeTracking}: el instalador del arnés registra el hook del firewall`);
      }
    }
  }
  assert.ok(!list.hooks.some((h) => HOOK.test(h.spec || '')), 'la lista del arnés no lo nombra');
});

test('UnauthorizedMachine_CodexHooksNeverIncludeTheFirewallHook', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  const r = DCH.activeFragment(raw, { env: { HOME: path.join(ROOT, 'no-existe') }, tcg: ROOT });
  const comandos = Object.values(r.fragment.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command || '');
  assert.deepStrictEqual(comandos.filter((c) => HOOK.test(c)), []);
  assert.ok(!HOOK.test(JSON.stringify(raw)), 'el adaptador de Codex no lo nombra');
});

test('AuthorizedMachine_OnlyTheGuardInstallerCarriesIt', () => {
  // la contraparte: el instalador con sudo lo copia y la configuración administrada lo registra en los dos eventos
  const guard = fs.readFileSync(path.join(ROOT, 'scripts', 'production', 'install-guard.sh'), 'utf8');
  assert.match(guard, /instalar scripts\/hooks\/prod-firewall-close\.js/);
  const plantilla = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'production', 'managed-settings.tycon-production.json.template'), 'utf8'));
  for (const ev of ['SessionEnd', 'SessionStart']) {
    const lo = (plantilla.hooks[ev] || []).flatMap((g) => g.hooks || []).filter((h) => HOOK.test(h.command || ''));
    assert.strictEqual(lo.length, 1, `${ev}: la configuración administrada lo registra una vez`);
  }
});
