'use strict';
/**
 * integrations-toggle.test.js — las integraciones de prender y apagar (`kind: "toggle"`) y los instintos como la primera.
 * stable-data: no crea commits ni lee el reloj.
 *
 * POR QUÉ. Las integraciones que no se eligen entre varias sino que están o no están (hoy, los instintos) tenían sus
 * hooks en la lista del núcleo con `when: integration:<llave>`: el núcleo los nombraba. Con su manifiesto en
 * `integrations/<nombre>/`, el núcleo sólo conoce el tipo; la llave que las prende sigue siendo la del lector de
 * configuración (`integrations.<nombre>`, con su variable).
 *
 * QUÉ MIDE. El manifiesto del tipo nuevo y sus motivos de rotura (T55); que el aplicador registra los mismos hooks de
 * instintos que antes, prendidos y apagados, en Mac y en Windows (T56); que una instalación de hoy se actualiza sin
 * rutas muertas (T57); que sin poder decidir (configuración rota o sin lector, manifiesto roto) queda como estaba
 * mientras el archivo viejo exista y, si ya se movió, no queda apuntando a la nada (T57b); que Codex los toma del manifiesto (T59);
 * y que la tabla de efectos, los textos del sitio y «Cómo trabaja» los muestran con el id nuevo (T60).
 *
 * Nada toca el HOME real: cada casa es una carpeta temporal.
 *
 * Correr:   node --test scripts/tests/integrations-toggle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const INT = require(path.join(ROOT, 'scripts', 'lib', 'integrations.js'));
const AH = require(path.join(ROOT, 'scripts', 'setup', 'apply-hooks.js'));
const LIST = path.join(ROOT, 'scripts', 'setup', 'hooks-list.json');
const INTS = path.join(ROOT, 'integrations');
const OBSERVE = '@int:instincts/scripts/instinct-observe.js';
const NOTICE = '@int:instincts/scripts/instincts-notice.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function casa() { const h = tmp('toggle-home-'); fs.mkdirSync(path.join(h, '.claude'), { recursive: true }); return h; }
function env(home, extra = {}) {
  const e = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_PROFILE: '0' }, extra);
  for (const k of ['TYCON_INSTINCTS', 'TYCON_TIME_TRACKING', 'TYCON_CLOCKIFY', 'TYCON_INTEGRATIONS_DIR']) if (!(k in extra)) delete e[k];
  return e;
}
/** Una carpeta de integraciones de juguete con un manifiesto por entrada. */
function intDir(manifests) {
  const dir = tmp('toggle-ints-');
  for (const m of manifests) {
    fs.mkdirSync(path.join(dir, m.name, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, m.name, 'integration.json'), JSON.stringify(m));
    for (const h of m.hooks || []) fs.writeFileSync(path.join(dir, m.name, h.script), '// hook de juguete\n');
  }
  return dir;
}
const HOOK = (script, extra = {}) => ({ event: 'SessionStart', matcher: '', script, label: `etiqueta de ${script}`, platforms: { windows: true }, ...extra });
const decideFor = (list, values, platform = 'posix', profile = 'full') => AH.decide(list, { env: {}, integ: { state: 'ok', values, timeTracking: 'none' }, profile: { state: 'ok', value: profile }, minimalIds: AH.loadMinimalIds ? AH.loadMinimalIds(path.join(ROOT, 'scripts', 'setup', 'install-effects.json')) : null, platform });
const commandsOf = (settings) => Object.values(settings.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command);

test('T55 Toggle_Manifest_WhenAndAlways @story-7.40 @ac-23', () => {
  const dir = intDir([
    { name: 'instincts', label: 'Instintos', kind: 'toggle', hooks: [HOOK('scripts/a.js', { event: 'PostToolUse', async: true }), HOOK('scripts/b.js', { always: true })] },
    { name: 'acmefoo', label: 'Otra', kind: 'toggle', hooks: [HOOK('scripts/a.js')] },
    { name: 'horas', label: 'Horas', kind: 'timeTracking', hooks: [HOOK('scripts/a.js', { always: true })] },
    { name: 'engram', label: 'Memoria', kind: 'toggle', hooks: [HOOK('scripts/a.js', { always: false })] },
    { name: 'nightly', label: 'Noche', kind: 'toggle', hooks: [], settings: [{ key: 'integrations.nightly.url', from: 'profile', type: 'url' }] },
    { name: 'mailbox', label: 'Buzón', kind: 'toggle', hooks: [HOOK('scripts/a.js'), HOOK('scripts/a.js', { always: true })] },
    { name: 'codex', label: 'Codex', kind: 'toggle', hooks: [HOOK('scripts/a.js', { event: 'PostToolUse', matcher: 'Edit|Write' }), HOOK('scripts/a.js', { event: 'PostToolUse', matcher: 'Write|Edit' })] },
  ]);
  const { manifests, problems } = INT.listManifests({ dir });
  const ok = manifests.find((m) => m.name === 'instincts');
  assert.ok(ok, `el manifiesto de prender y apagar vale: ${JSON.stringify(problems)}`);
  const entries = INT.hookEntries(ok, { tool: 'claude' });
  assert.deepStrictEqual(entries.map((e) => [e.spec, e.when]), [['@int:instincts/scripts/a.js', 'integration:instincts'], ['@int:instincts/scripts/b.js', 'always']]);
  assert.strictEqual(entries[0].async, true);
  const why = Object.fromEntries(problems.map((p) => [p.name, p.reasons.join(' · ')]));
  assert.match(why.acmefoo || '', /llave/, 'un nombre que no es una llave del lector: roto con su motivo');
  assert.match(why.horas || '', /always/, '«always» en una integración de horas: roto');
  assert.match(why.engram || '', /always.*true/, '«always» vale sólo true');
  assert.match(why.nightly || '', /perfil/, 'una de prender y apagar no lleva ajustes del perfil');
  assert.match(why.mailbox || '', /dos veces/, 'el mismo hook con y sin always: roto, no frena la instalación');
  assert.match(why.codex || '', /dos veces/, 'matchers con las mismas partes en otro orden: el mismo registro');
  assert.deepStrictEqual(manifests.map((m) => m.name), ['instincts'], 'los rotos no se usan');
  // un manifiesto roto no frena la lista: el aplicador la carga con lo demás
  assert.doesNotThrow(() => AH.loadList(LIST, { integrationsDir: dir }));
});

test('T56 Instincts_FromManifest_SameHooksOnAndOff @story-7.40 @ac-24', () => {
  const real = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  assert.ok(!real.hooks.some((h) => /instinct/.test(h.spec)), 'la lista del núcleo ya no trae los hooks de instintos');
  const m = INT.find('instincts');
  assert.ok(m && m.kind === 'toggle', 'integrations/instincts/ es de prender y apagar');
  const list = AH.loadList(LIST, { integrationsDir: INTS });
  const rec = list.hooks.filter((h) => h.spec === OBSERVE);
  const not = list.hooks.filter((h) => h.spec === NOTICE);
  assert.deepStrictEqual(rec.map((h) => [h.event, h.matcher, h.when, h.async, h.platforms.windows, h.effect]), [['PostToolUse', '', 'integration:instincts', true, true, 'records']]);
  assert.deepStrictEqual(not.map((h) => [h.event, h.when, h.platforms.windows, h.effect]), [['SessionStart', 'always', true, 'warns']]);
  for (const platform of ['posix', 'windows']) {
    const on = decideFor(list, { instincts: '1' }, platform).active.map((h) => h.spec);
    assert.ok(on.includes(OBSERVE) && on.includes(NOTICE), `${platform}: prendida, los dos`);
    const off = decideFor(list, { instincts: '0' }, platform);
    assert.ok(!off.active.some((h) => h.spec === OBSERVE) && off.known.includes(OBSERVE), `${platform}: apagada, la grabadora sale`);
    assert.ok(off.active.some((h) => h.spec === NOTICE), `${platform}: el aviso queda, para decir lo de las variables viejas`);
    // el perfil mínimo trata a los dos como antes: la grabadora sí (si está prendida), el aviso no
    const min = decideFor(list, { instincts: '1' }, platform, 'minimal').active.map((h) => h.spec);
    assert.ok(min.includes(OBSERVE) && !min.includes(NOTICE), `${platform}: perfil mínimo: ${min.filter((s) => /instinct/.test(s)).join(', ')}`);
  }
  for (const f of ['scripts/instinct-observe.js', 'scripts/instincts-notice.js']) assert.ok(fs.existsSync(path.join(INTS, 'instincts', f)), `${f} vive en la integración`);
  for (const f of ['instinct-observe.js', 'instincts-notice.js']) assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'hooks', f)), `${f} ya no está en scripts/hooks/`);
});

test('T57 Instincts_UpgradeFromToday_NoDeadPaths @story-7.40 @ac-25', () => {
  const list = AH.loadList(LIST, { integrationsDir: INTS });
  const old = path.join(os.tmpdir(), 'acme-casa', '.claude', 'tycon-harness', 'scripts', 'hooks');
  const today = () => ({ hooks: {
    PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `node "${old}/instinct-observe.js"`, async: true }, { type: 'command', command: `bash "${old}/instinct-observe.sh"` }] }],
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `node "${old}/instincts-notice.js"` }] }],
  } });
  const o = (decision, platform = 'posix') => ({ list, decision, platform, hooksDir: path.join(ROOT, 'scripts', 'hooks'), skills: path.join(ROOT, 'skills'), integrationsDir: INTS, env: {} });
  for (const platform of ['posix', 'windows']) {
    const s = today();
    AH.applyToSettings(s, o(decideFor(list, { instincts: '1' }, platform), platform));
    AH.applyToSettings(s, o(decideFor(list, { instincts: '1' }, platform), platform));
    const cmds = commandsOf(s).map((c) => c.replace(/\\/g, '/'));
    assert.ok(!cmds.some((c) => c.includes('scripts/hooks/instinct')), `${platform}: ninguna ruta vieja queda: ${cmds.join(' | ')}`);
    for (const f of ['instinct-observe.js', 'instincts-notice.js']) {
      assert.strictEqual(cmds.filter((c) => c.includes(`integrations/instincts/scripts/${f}`)).length, 1, `${platform}: ${f} una vez, con la ruta nueva`);
    }
  }
  // el reenvío viejo lleva a la grabadora nueva
  const fwd = fs.readFileSync(path.join(ROOT, 'scripts', 'hooks', 'instinct-observe.sh'), 'utf8');
  assert.match(fwd, /integrations\/instincts\/scripts\/instinct-observe\.js/);
});

test('T57b Instincts_UndecidedConfig_NoHookOnAMovedFile @story-7.40 @ac-25', () => {
  const list = AH.loadList(LIST, { integrationsDir: INTS });
  // una instalación de antes: con los guiones viejos todavía en disco (otro clon sin actualizar) o ya movidos
  const settingsAt = (dir) => ({ hooks: {
    PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `node "${dir}/instinct-observe.js"`, async: true }] }],
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `node "${dir}/instincts-notice.js"` }] }],
  } });
  const alive = path.join(tmp('toggle-alive-'), 'scripts', 'hooks');
  fs.mkdirSync(alive, { recursive: true });
  for (const f of ['instinct-observe.js', 'instincts-notice.js']) fs.writeFileSync(path.join(alive, f), '// de antes\n');
  const gone = path.join(tmp('toggle-gone-'), 'scripts', 'hooks');
  const NEW = (f) => `integrations/instincts/scripts/${f}`;
  const instincts = (s) => commandsOf(s).filter((c) => /instinct/.test(c)).map((c) => c.replace(/\\/g, '/'));
  const apply = (s, cfg, l = list, dir = INTS, platform = 'posix') => {
    const decision = AH.decide(l, { env: {}, integ: cfg.integ, profile: cfg.profile, minimalIds: null, platform });
    AH.applyToSettings(s, { list: l, decision, platform, hooksDir: path.join(ROOT, 'scripts', 'hooks'), skills: path.join(ROOT, 'skills'), integrationsDir: dir, env: {} });
    return instincts(s);
  };
  // la configuración como la ve el lector de verdad: rota (tycon.json que no es JSON) y sin lector
  const home = casa();
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), '{ no es json');
  const rota = AH.readConfig({ env: env(home) });
  assert.deepStrictEqual([rota.integ.state, rota.profile.state], ['rota', 'rota'], 'el lector real da rota la integración y el perfil');
  const sinLector = AH.readConfig({ env: env(casa()), libDir: tmp('toggle-nolib-') });
  assert.deepStrictEqual([sinLector.integ.state, sinLector.profile.state], ['sin-lector', 'sin-lector']);
  for (const [name, cfg] of [['rota', rota], ['sin lector', sinLector]]) {
    // con los guiones viejos en disco, queda como estaba
    const a = apply(settingsAt(alive), cfg);
    assert.deepStrictEqual(a.sort(), [`node "${alive}/instinct-observe.js"`, `node "${alive}/instincts-notice.js"`].map((c) => c.replace(/\\/g, '/')).sort(), `${name}, viejos en disco: ${a.join(' | ')}`);
    // con los guiones viejos movidos, ninguna ruta muerta: cada uno vuelve en su ruta nueva, una vez (estaba registrado)
    const g = apply(settingsAt(gone), cfg);
    assert.ok(!g.some((c) => c.includes(gone.replace(/\\/g, '/'))), `${name}, viejos movidos: ninguna ruta muerta: ${g.join(' | ')}`);
    for (const f of ['instinct-observe.js', 'instincts-notice.js']) assert.strictEqual(g.filter((c) => c.includes(NEW(f))).length, 1, `${name}: ${f} en su ruta nueva`);
    // en Windows: con los viejos en disco queda como estaba; con una ruta de unidad que ya no está, vuelve en la nueva
    const wa = apply(settingsAt(alive), cfg, list, INTS, 'windows');
    assert.strictEqual(wa.length, 2, `${name}, Windows, viejos en disco: ${wa.join(' | ')}`);
    assert.ok(wa.every((c) => c.includes(alive.replace(/\\/g, '/'))), `${name}, Windows, viejos en disco: quedan ésos`);
    const wg = apply(settingsAt('C:\\Users\\acme\\.claude\\tycon-harness\\scripts\\hooks'), cfg, list, INTS, 'windows');
    assert.ok(!wg.some((c) => c.includes('C:/Users/acme')), `${name}, Windows, viejos movidos: ninguna ruta muerta: ${wg.join(' | ')}`);
    for (const f of ['instinct-observe.js', 'instincts-notice.js']) assert.strictEqual(wg.filter((c) => c.includes(NEW(f))).length, 1, `${name}, Windows: ${f} en su ruta nueva`);
  }
  // una ruta vieja que no es absoluta (editada a mano con `$HOME`) no se puede comprobar: queda, y el informe lo dice
  const tilde = { hooks: { PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$HOME/.claude/tycon-harness/scripts/hooks/instinct-observe.js"' }] }] } };
  const decision = AH.decide(list, { env: {}, integ: rota.integ, profile: rota.profile, minimalIds: null, platform: 'posix' });
  const rep = AH.applyToSettings(tilde, { list, decision, platform: 'posix', hooksDir: path.join(ROOT, 'scripts', 'hooks'), skills: path.join(ROOT, 'skills'), integrationsDir: INTS, env: {} });
  assert.ok(instincts(tilde).some((c) => c.startsWith('node "$HOME/')), 'la ruta con $HOME queda');
  assert.ok(rep.missing.some((x) => /instinct-observe\.js.*no se puede comprobar/.test(x.relpath)), `y se dice: ${JSON.stringify(rep.missing)}`);
  // con el manifiesto roto: los guiones viejos en disco quedan; movidos, salen (no hay ruta nueva conocida) y se dice
  const broken = tmp('toggle-broken-');
  fs.cpSync(path.join(INTS, 'instincts'), path.join(broken, 'instincts'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'instincts', 'integration.json'), '{ no es json');
  const brokenList = AH.loadList(LIST, { integrationsDir: broken });
  assert.ok(brokenList.warnings.some((w) => w.includes('«instincts»')), `se dice: ${brokenList.warnings.join(' | ')}`);
  const ok = { integ: { state: 'ok', values: { instincts: '1' }, timeTracking: 'none' }, profile: { state: 'ok', value: 'full' } };
  assert.strictEqual(apply(settingsAt(alive), ok, brokenList, broken).length, 2, 'manifiesto roto, viejos en disco: quedan');
  assert.deepStrictEqual(apply(settingsAt(gone), ok, brokenList, broken), [], 'manifiesto roto, viejos movidos: no queda ninguna ruta muerta');
});

test('T59 Codex_InstinctsFromManifest @story-7.40 @ac-26', () => {
  const DCH = require(path.join(ROOT, 'build', 'deploy-codex-hooks.js'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  const rawCmds = Object.values(raw.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command);
  assert.ok(!rawCmds.some((c) => /scripts\/hooks\/instinct(s-notice|-observe)\.js/.test(c)), 'el fragmento fijo ya no los trae');
  const count = (frag, f) => commandsOf(frag).filter((c) => c.includes(`integrations/instincts/scripts/${f}`)).length;
  for (const [value, rec] of [['1', 1], ['0', 0]]) {
    const r = DCH.activeFragment(raw, { env: env(casa(), { TYCON_INSTINCTS: value }), tcg: ROOT });
    assert.strictEqual(count(r.fragment, 'instinct-observe.js'), rec, `Codex con TYCON_INSTINCTS=${value}: la grabadora ${rec} vez`);
    assert.strictEqual(count(r.fragment, 'instincts-notice.js'), 1, `Codex con TYCON_INSTINCTS=${value}: el aviso siempre`);
  }
  // con la configuración rota quedan los dos, como antes
  const home = casa();
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), '{ no es json');
  const r = DCH.activeFragment(raw, { env: env(home), tcg: ROOT });
  assert.strictEqual(count(r.fragment, 'instinct-observe.js'), 1, `configuración rota: la grabadora queda (${r.aviso})`);
  assert.strictEqual(count(r.fragment, 'instincts-notice.js'), 1);
});

test('T60 Instincts_PiecesWithNewIds @story-7.40 @ac-27', () => {
  // la lista de efectos que lee la instalación: el archivo y, de su manifiesto, los textos de los hooks de cada integración
  const effects = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'managed.js')).readEffects(ROOT);
  assert.ok(effects.ok, effects.reason);
  const rows = effects.effects.filter((e) => /instinct/.test(e.id || ''));
  const ids = rows.map((e) => e.id).sort();
  assert.deepStrictEqual(ids, [`PostToolUse:${OBSERVE}`, `SessionStart:${NOTICE}`]);
  const rec = rows.find((e) => e.id === `PostToolUse:${OBSERVE}`);
  assert.deepStrictEqual([rec.when, rec.switch, rec.title], ['integration:instincts', 'TYCON_INSTINCTS=0', 'Graba cada herramienta, para encontrar lo que el equipo repite']);
  const not = rows.find((e) => e.id === `SessionStart:${NOTICE}`);
  assert.strictEqual(not.when, 'always');
  const texts = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'texts.js'), 'utf8');
  assert.ok(!/control\.@tcg:instinct/.test(texts), 'sin claves con el id viejo');
  const HIW = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'how-it-works.js'));
  const controls = HIW.readControls(ROOT);
  const mine = (controls.controls || controls).filter((c) => /instinct/.test(c.spec || ''));
  // el texto de cada control lo trae su manifiesto (`control`), no los textos del sitio
  for (const c of mine) assert.ok(c.control && c.control.es && c.control.en, `texto de ${c.spec}, de su manifiesto`);
  assert.deepStrictEqual(mine.map((c) => [c.spec, c.script, c.integration || null]).sort(), [
    [OBSERVE, 'integrations/instincts/scripts/instinct-observe.js', 'instincts'],
    [NOTICE, 'integrations/instincts/scripts/instincts-notice.js', null],
  ]);
});
