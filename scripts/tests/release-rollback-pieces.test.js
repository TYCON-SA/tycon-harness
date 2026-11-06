#!/usr/bin/env node
/**
 * release-rollback-pieces.test.js — cuando una versión bajada no queda sana y vuelve sola, lo que esa versión agregó a la
 * máquina se va con ella.
 *
 * El caso: una actualización registró en settings.json un gancho que la versión anterior no trae (sobre el cuadro de
 * opciones). La salud falló y la versión volvió sola, pero el gancho quedó registrado, apuntando a un archivo que ya no
 * está. Para el freno era un gancho ajeno que escucha el cuadro, y ningún click valía.
 *
 * Hogares de juguete en carpetas temporales; sin red ni git.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RB = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'rollback.js'));
// lo que declara el aplicador de la versión que quedó: los eventos y prefijos que informa
const DECLARADO = { TYCON_REPORT_HOOK_EVENTS: 'PreToolUse,Stop', TYCON_REPORT_HOOK_PREFIXES: '@tcg:,@int:' };

function lab(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-back-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const tree = path.join(home, '.tycon', 'harness');
  fs.mkdirSync(path.join(tree, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'hooks', 'p.js'), '// hook\n');
  const settings = path.join(home, '.claude', 'settings.json');
  const cmd = (n) => ({ type: 'command', command: `node "${path.join(tree, 'scripts', 'hooks', n)}"` });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: {
    PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [cmd('background-question-guard.js')] }],
    Stop: [{ matcher: '', hooks: [cmd('p.js')] }],
  } }, null, 2));
  const viejo = { kind: 'hook', where: settings, id: 'Stop:@tcg:p.js', version: '2026.11.04.19' };
  const nuevo = { kind: 'hook', where: settings, id: 'PreToolUse:@tcg:background-question-guard.js', version: '2026.11.06.14' };
  return { home, tree, settings, viejo, nuevo };
}

test('ReleaseBack_DropsWhatTheFailedVersionAdded', (t) => {
  const L = lab(t);
  const state = { managed: [L.viejo, L.nuevo] };
  // el aplicador de la versión que quedó informa sólo lo suyo
  const r = RB.dropUnreported(state, { report: [{ kind: 'hook', where: L.settings, id: L.viejo.id }], shared: [] }, { home: L.home, env: {}, tree: L.tree, version: '2026.11.04.19', declared: DECLARADO });
  assert.strictEqual(r.ok, true, (r.lines || []).join(' · '));
  const s = JSON.parse(fs.readFileSync(L.settings, 'utf8'));
  assert.doesNotMatch(JSON.stringify(s.hooks), /background-question-guard/, 'el gancho de la versión que falló quedó registrado');
  assert.match(JSON.stringify(s.hooks), /p\.js/, 'el gancho de la versión que quedó no se toca');
  assert.strictEqual(s.theme, 'dark', 'lo del dev no se toca');
  assert.deepStrictEqual(state.managed.map((p) => p.id), [L.viejo.id], 'el registro queda con lo que la versión trae');
});

test('ReleaseBack_NoReport_RemovesNothing', (t) => {
  const L = lab(t);
  const state = { managed: [L.viejo, L.nuevo] };
  const r = RB.dropUnreported(state, { report: null, shared: [] }, { home: L.home, env: {}, tree: L.tree, version: '2026.11.04.19', declared: DECLARADO });
  assert.strictEqual(r.ok, false);
  assert.match(JSON.stringify(JSON.parse(fs.readFileSync(L.settings, 'utf8')).hooks), /background-question-guard/, 'sin reporte no se sabe qué es de quién: no se quita nada');
  assert.strictEqual(state.managed.length, 2);
});

test('ReleaseBack_HookThatDidNotTravel_IsKept', (t) => {
  // el aplicador deja afuera del informe un hook cuyo evento no declara: no viajó, pero la versión lo trae
  const L = lab(t);
  const state = { managed: [L.viejo, L.nuevo] };
  const soloStop = { report: [{ kind: 'hook', where: L.settings, id: L.viejo.id }], shared: [] };
  const sigue = () => /background-question-guard/.test(JSON.stringify(JSON.parse(fs.readFileSync(L.settings, 'utf8')).hooks));
  RB.dropUnreported(state, soloStop, { home: L.home, env: {}, tree: L.tree, declared: { ...DECLARADO, TYCON_REPORT_HOOK_EVENTS: 'Stop' } });
  assert.ok(sigue(), 'un hook que no viajó se quitó');
  // sin saber qué declaró el aplicador, no se quita ningún hook
  RB.dropUnreported(state, soloStop, { home: L.home, env: {}, tree: L.tree });
  assert.ok(sigue(), 'sin lo declarado se quitó un hook');
});

test('ReleaseBack_UpdateFailure_DropsPieces', () => {
  // la vuelta sola de la versión bajada corre la quita después del aplicador de la versión que quedó, con lo que declaró
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', 'release.js'), 'utf8');
  assert.match(src, /const again = H\.runApplier\(ctx, own\.harness[\s\S]{0,600}?dropUnreported\(state, again[^\n]*declared \}/, 'la vuelta sola no quita lo que agregó la versión que falló');
  const hsrc = fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'harness.js'), 'utf8');
  assert.match(hsrc, /function releaseHelpers[\s\S]{0,300}?applierReportEnv,/, 'release.js no recibe lo que declara el aplicador');
});
