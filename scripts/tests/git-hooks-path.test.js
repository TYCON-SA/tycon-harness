'use strict';
// git-hooks-path.test.js — la carpeta GLOBAL de hooks de git que pone `harness.js` (scripts/setup/harness/git-hooks-path.js).
//
// El caso (2026-10-14): una máquina con la versión bajada, mudada desde un clon, tenía los hooks del arnés en ~/.git-hooks
// y git sin carpeta global de hooks: el freno antes de publicar no corría. `doctor` mandaba a `harness.js apply`, y el
// aplicador sólo avisaba. Lo de punta a punta (install, apply, el arranque, el perfil mínimo, uninstall) lo mide
// harness-install.test.sh, sección HP; acá, el módulo, igual en cualquier sistema:
//
//   G1 · git sin ninguna, perfil full, con el pre-push del arnés en la carpeta: la pone y la relee.
//   G2 · no la pone: con otra carpeta (la configuración queda byte a byte), sin el pre-push del arnés, con otro perfil o
//        sin perfil, y con TYCON_NO_GIT_HOOKS=1.
//   G3 · git no deja escribir: 'failed', con el comando a mano, y nada escrito.
//   G4 · el aviso de «git no tiene» (con su comando) sale de los avisos; los demás quedan.
//   G5 · release: la saca si es la que puso; si la persona la cambió, no; sin anotación, nada.
//   G6 · en Windows se escribe con `/`.
//   G7 · wouldSet (para el aviso con la política ask) no escribe; stripNotices saca sólo los avisos de esta pieza.
//
// Cada caso con su propia configuración global (GIT_CONFIG_GLOBAL en un temporal): nunca la de quien corre.
// Uso: node --test scripts/tests/git-hooks-path.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'git-hooks-path.js'));

/** Una HOME de juguete con su configuración global de git vacía, y la carpeta de hooks con (o sin) el pre-push del arnés. */
function lab({ prePush = 'ours' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-path-'));
  const home = path.join(dir, 'home');
  const hooks = path.join(home, '.git-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  if (prePush === 'ours') fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/usr/bin/env bash\n# git-pre-push-global.sh\nexit 0\n');
  if (prePush === 'foreign') fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, '');
  const env = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', HOME: home });
  delete env.TYCON_GIT_HOOKS_DIR;
  delete env.TYCON_NO_GIT_HOOKS;
  return { dir, home, hooks, cfg, env, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const value = (env) => { try { return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { env, encoding: 'utf8' }).trim(); } catch (_) { return ''; } };
const setValue = (env, v) => execFileSync('git', ['config', '--global', 'core.hooksPath', v], { env });

test('G1 · git sin ninguna, full, con el pre-push del arnés: la pone y la relee', () => {
  const L = lab();
  try {
    assert.equal(G.read({ env: L.env }).status, 'unset');
    const r = G.ensure({ home: L.home, env: L.env, platform: 'darwin', profile: 'full' });
    assert.equal(r.status, 'set');
    assert.equal(r.value, L.hooks);
    assert.equal(value(L.env), L.hooks);
    assert.match(r.line, /^✓ git usa ahora la carpeta global de hooks del arnés/);
    assert.match(r.line, /git config --global --unset core\.hooksPath/);
    // otra vez: ya la tiene, no se toca ni se dice nada
    const again = G.ensure({ home: L.home, env: L.env, platform: 'darwin', profile: 'full' });
    assert.equal(again.status, 'skipped');
    assert.equal(again.line, null);
  } finally { L.done(); }
});

test('G2 · no la pone: otra carpeta, sin el pre-push del arnés, otro perfil, sin perfil, TYCON_NO_GIT_HOOKS=1', () => {
  const L = lab();
  try {
    setValue(L.env, path.join(L.dir, 'otra'));
    const before = fs.readFileSync(L.cfg);
    assert.equal(G.ensure({ home: L.home, env: L.env, profile: 'full' }).status, 'skipped');
    assert.deepEqual(fs.readFileSync(L.cfg), before, 'la configuración con otra carpeta quedó byte a byte');
  } finally { L.done(); }
  for (const [name, opts, env] of [
    ['sin el pre-push', { prePush: 'none' }, {}],
    ['con un pre-push ajeno', { prePush: 'foreign' }, {}],
    ['TYCON_NO_GIT_HOOKS=1', {}, { TYCON_NO_GIT_HOOKS: '1' }],
  ]) {
    const M = lab(opts);
    try {
      const r = G.ensure({ home: M.home, env: Object.assign({}, M.env, env), profile: 'full' });
      assert.equal(r.status, 'skipped', name);
      assert.equal(value(M.env), '', `${name}: no la puso`);
    } finally { M.done(); }
  }
  for (const profile of ['minimal', null]) {
    const M = lab();
    try {
      assert.equal(G.ensure({ home: M.home, env: M.env, profile }).status, 'skipped', `perfil ${profile}`);
      assert.equal(value(M.env), '', `perfil ${profile}: no la puso`);
    } finally { M.done(); }
  }
});

test('G3 · git no deja escribir: failed, con el comando a mano, y nada escrito', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'sin permisos de carpeta que midan (Windows o root)' : false }, () => {
  const L = lab();
  const closed = path.join(L.dir, 'cerrada');
  fs.mkdirSync(closed);
  const cfg = path.join(closed, 'gitconfig');
  fs.writeFileSync(cfg, '');
  fs.chmodSync(closed, 0o555);
  try {
    const env = Object.assign({}, L.env, { GIT_CONFIG_GLOBAL: cfg });
    const r = G.ensure({ home: L.home, env, profile: 'full' });
    assert.equal(r.status, 'failed');
    assert.match(r.line, /^⚠ git no tiene carpeta global de hooks y no pude ponerla/);
    assert.ok(r.line.includes(`git config --global core.hooksPath "${L.hooks}"`), r.line);
    assert.equal(fs.readFileSync(cfg, 'utf8'), '');
  } finally { fs.chmodSync(closed, 0o755); L.done(); }
});

test('G4 · el aviso de «git no tiene» y su comando salen de los avisos; los demás quedan', () => {
  const lines = [
    '⚠ otro aviso del aplicador',
    '    con su detalle',
    '⚠ git no tiene core.hooksPath global — los hooks del arnés NO corren. Activalo con:',
    '    git config --global core.hooksPath /h/.git-hooks',
    '⚠ el último',
  ];
  assert.deepEqual(G.withoutUnsetWarning(lines), ['⚠ otro aviso del aplicador', '    con su detalle', '⚠ el último']);
  assert.deepEqual(G.withoutUnsetWarning([]), []);
});

test('G5 · release: la saca si es la que puso; si la persona la cambió, no; sin anotación, nada', () => {
  const L = lab();
  try {
    const r = G.ensure({ home: L.home, env: L.env, profile: 'full' });
    assert.equal(r.status, 'set');
    assert.equal(G.release({ env: L.env, recorded: null }).status, 'none');
    assert.equal(value(L.env), L.hooks, 'sin anotación no la toca');
    const other = path.join(L.dir, 'de-la-persona');
    setValue(L.env, other);
    const kept = G.release({ env: L.env, recorded: { value: r.value } });
    assert.equal(kept.status, 'kept');
    assert.equal(value(L.env), other, 'la que cambió la persona queda');
    setValue(L.env, r.value);
    const removed = G.release({ env: L.env, recorded: { value: r.value } });
    assert.equal(removed.status, 'removed');
    assert.equal(value(L.env), '');
    assert.match(removed.line, /^quitado: la carpeta global de hooks de git que puso el arnés/);
  } finally { L.done(); }
});

test('G6 · en Windows se escribe con /; la carpeta sale de TYCON_GIT_HOOKS_DIR o de ~/.git-hooks', () => {
  assert.equal(G.valueFor('C:\\Users\\u\\.git-hooks', 'win32'), 'C:/Users/u/.git-hooks');
  assert.equal(G.valueFor('/home/u/.git-hooks', 'linux'), '/home/u/.git-hooks');
  assert.equal(G.hooksDir({ home: '/h', env: {} }), path.join('/h', '.git-hooks'));
  assert.equal(G.hooksDir({ home: '/h', env: { TYCON_GIT_HOOKS_DIR: '/x/hooks' } }), '/x/hooks');
});

test('G7 · wouldSet dice lo mismo que ensure sin escribir; stripNotices saca sólo los avisos de esta pieza', () => {
  const L = lab();
  try {
    const before = fs.readFileSync(L.cfg);
    assert.equal(G.wouldSet({ home: L.home, env: L.env, profile: 'full' }), true);
    assert.deepEqual(fs.readFileSync(L.cfg), before, 'wouldSet no escribe nada');
    assert.equal(G.wouldSet({ home: L.home, env: L.env, profile: 'minimal' }), false);
    assert.equal(G.wouldSet({ home: L.home, env: Object.assign({}, L.env, { TYCON_NO_GIT_HOOKS: '1' }), profile: 'full' }), false);
    const r = G.ensure({ home: L.home, env: L.env, profile: 'full' });
    assert.equal(r.status, 'set');
    assert.ok(r.notice.startsWith(G.NOTICE_SET) && !r.notice.includes(' · ') && !r.notice.includes('\n'), `el aviso es una línea: ${r.notice}`);
    assert.equal(G.wouldSet({ home: L.home, env: L.env, profile: 'full' }), false, 'ya puesta, no la pondría');
  } finally { L.done(); }
  const other = 'hay versión nueva: 1 → 2';
  assert.equal(G.stripNotices(`${other} · ${G.NOTICE_ASK}`), other);
  assert.equal(G.stripNotices(`${G.NOTICE_SET} (core.hooksPath = /h/.git-hooks): x`), null);
  assert.equal(G.stripNotices(`${G.NOTICE_FAILED} (git config salió 255): y · ${other}`), other);
  assert.equal(G.stripNotices(null), null);
});
