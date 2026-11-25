'use strict';
/**
 * clocki-state-dir.test.js — el estado del registro de horas vive en la carpeta de los registros sueltos, y la mudanza
 * lo pasa a la carpeta del estado dejando un enlace en el lugar viejo.
 *
 * El registro de horas (integrations/clockify/scripts/lib.js) toma su carpeta de `scripts/lib/loose-logs.js`: la del
 * estado del arnés en una máquina que vive en la casa propia, la de Claude Code si no. `loose-logs.js --move-old` la
 * muda con un renombre y deja un enlace (una unión en Windows), porque la skill de una versión anterior y las
 * instrucciones propias de una persona nombran la ruta vieja. La mudanza nunca pisa ni borra: lo que no puede mudar,
 * queda donde estaba.
 *
 * Cada caso arma su HOME de juguete; los ganchos corren en un Node aparte con esa HOME.
 * 🔴 Nada toca el HOME real.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOOSE_JS = path.join(ROOT, 'scripts', 'lib', 'loose-logs.js');
const CLOCKI = path.join(ROOT, 'integrations', 'clockify', 'scripts');
const CLAUDE = '.' + 'claude';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `clocki-${name}-`));
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } };

/** Una HOME de juguete; con `own`, vive en la casa propia (existe `.tycon/state`). */
function toyHome(name, { own = true } = {}) {
  const home = tmp(name);
  fs.mkdirSync(path.join(home, CLAUDE), { recursive: true });
  if (own) fs.mkdirSync(path.join(home, '.tycon', 'state'), { recursive: true });
  return home;
}

function envFor(home, extra = {}) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home }, extra);
  for (const k of ['TYCON_HOME', 'TYCON_EVAL_SANDBOX', 'TYCON_TIME_TRACKING']) if (!(k in extra)) delete env[k];
  return env;
}

/** Un timer abierto de la sesión `sid` en `dir/active/<sid>.json`. */
function timer(dir, sid) {
  fs.mkdirSync(path.join(dir, 'active'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'active', `${sid}.json`), JSON.stringify({ '/repo': { entryId: 'E1' } }));
}

function freshLoose() {
  delete require.cache[require.resolve(LOOSE_JS)];
  return require(LOOSE_JS);
}

// ── T1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: lib.js armando su carpeta a mano en la de Claude Code, o un gancho que se cae al cargar sin tycon-home.js.
test('T1 ClockiDir_FollowsLooseLogs @story-8.335 @ac-1 — la carpeta sale de loose-logs.js; sin tycon-home.js, el gancho sale 0 y lo dice', () => {
  const read = (home) => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require(process.argv[1]).STATE_DIR))', path.join(CLOCKI, 'lib.js')], { env: envFor(home), encoding: 'utf8' });
  const own = toyHome('t1-own');
  const r1 = read(own);
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.strictEqual(r1.stdout, path.join(own, '.tycon', 'state', 'clocki'), 'en la casa propia, la carpeta del estado');
  const old = toyHome('t1-old', { own: false });
  const r2 = read(old);
  assert.strictEqual(r2.stdout, path.join(old, CLAUDE, 'clocki'), 'sin la casa propia, la de Claude Code');

  // un árbol con la integración y loose-logs.js, pero sin tycon-home.js
  const tree = tmp('t1-tree');
  fs.cpSync(CLOCKI, path.join(tree, 'integrations', 'clockify', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(LOOSE_JS, path.join(tree, 'scripts', 'lib', 'loose-logs.js'));
  const home = toyHome('t1-broken');
  const r3 = spawnSync(process.execPath, [path.join(tree, 'integrations', 'clockify', 'scripts', 'on-prompt.js')], {
    env: envFor(home), encoding: 'utf8', input: JSON.stringify({ session_id: 's1', cwd: home, prompt: 'implementemos la story 2.3' }),
  });
  assert.strictEqual(r3.status, 0, r3.stderr);
  assert.match(r3.stderr, /clocki: no sé dónde guardar el estado/);
  assert.strictEqual(r3.stdout, '', 'no avisa nada');
  assert.ok(!lexists(path.join(home, CLAUDE, 'clocki')) && !lexists(path.join(home, '.tycon', 'state', 'clocki')), 'no escribe');
});

// ── T2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: el registro de horas fuera de la mudanza, un timer que se pierde, o el lugar viejo sin su enlace.
test('T2 MoveOld_MovesClocki_LeavesLink @story-8.335 @ac-2 — la carpeta pasa entera a la del estado y el lugar viejo es un enlace', () => {
  const home = toyHome('t2');
  timer(path.join(home, CLAUDE, 'clocki'), 's1');
  const r = spawnSync(process.execPath, [LOOSE_JS, '--move-old'], { env: envFor(home), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const moved = path.join(home, '.tycon', 'state', 'clocki', 'active', 's1.json');
  assert.ok(fs.existsSync(moved), `el timer está en la carpeta del estado:\n${r.stdout}`);
  const at = path.join(home, CLAUDE, 'clocki');
  assert.ok(isLink(at), 'el lugar viejo es un enlace');
  assert.strictEqual(fs.realpathSync(path.join(at, 'active', 's1.json')), fs.realpathSync(moved), 'el enlace lo resuelve');
  assert.match(r.stdout, /queda un enlace a la carpeta nueva/);

  // una segunda corrida no lo toca: un enlace no se muda
  const again = spawnSync(process.execPath, [LOOSE_JS, '--move-old'], { env: envFor(home), encoding: 'utf8' });
  assert.ok(!/clocki/.test(again.stdout), again.stdout);
  assert.ok(isLink(at));
});

// ── T3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: una mudanza que pisa el destino o deja un enlace sobre el viejo.
test('T3 MoveOld_NeverOverwrites @story-8.335 @ac-2 — con el destino ya ocupado, el viejo queda donde estaba, sin enlace', () => {
  const home = toyHome('t3');
  timer(path.join(home, CLAUDE, 'clocki'), 's1');
  timer(path.join(home, '.tycon', 'state', 'clocki'), 's2');
  const r = spawnSync(process.execPath, [LOOSE_JS, '--move-old'], { env: envFor(home), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const at = path.join(home, CLAUDE, 'clocki');
  assert.ok(!isLink(at) && fs.existsSync(path.join(at, 'active', 's1.json')), 'el viejo sigue siendo la carpeta real');
  assert.ok(fs.existsSync(path.join(home, '.tycon', 'state', 'clocki', 'active', 's2.json')), 'el destino, intacto');
  assert.ok(!fs.existsSync(path.join(home, '.tycon', 'state', 'clocki', 'active', 's1.json')), 'nada se mezcla');
  assert.match(r.stdout, new RegExp(`clocki quedó donde está: .*ya existe`));
});

// ── T3b ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: un renombre fallido (una carpeta en uso en Windows) que tira o deja la carpeta a medias.
test('T3b MoveOld_RenameFails_Stays @story-8.335 @ac-2 — un renombre que falla deja el viejo donde estaba y lo dice', () => {
  const home = toyHome('t3b');
  timer(path.join(home, CLAUDE, 'clocki'), 's1');
  const busy = (src, dst) => { if (path.basename(src) === 'clocki') { const e = new Error('ocupada'); e.code = 'EBUSY'; throw e; } fs.renameSync(src, dst); };
  const r = freshLoose().moveOld(home, { rename: busy });
  const at = path.join(home, CLAUDE, 'clocki');
  assert.ok(!isLink(at) && fs.existsSync(path.join(at, 'active', 's1.json')), 'el viejo, en su lugar');
  assert.ok(!lexists(path.join(home, '.tycon', 'state', 'clocki')), 'sin destino a medias');
  const kept = r.kept.find(([src]) => src === at);
  assert.ok(kept && /EBUSY/.test(kept[2]) && /reintenta/.test(kept[2]), JSON.stringify(r.kept));
});

// ── T3c ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: un enlace que falla y deja el lugar viejo vacío, mirando a nada.
test('T3c MoveOld_LinkFails_UndoesRename @story-8.335 @ac-2 — si el enlace falla, la carpeta vuelve a su lugar', () => {
  const home = toyHome('t3c');
  timer(path.join(home, CLAUDE, 'clocki'), 's1');
  const noLink = () => { const e = new Error('sin permiso'); e.code = 'EPERM'; throw e; };
  const r = freshLoose().moveOld(home, { link: noLink });
  const at = path.join(home, CLAUDE, 'clocki');
  assert.ok(!isLink(at) && fs.existsSync(path.join(at, 'active', 's1.json')), 'la carpeta volvió al lugar viejo');
  assert.ok(!lexists(path.join(home, '.tycon', 'state', 'clocki')), 'y no quedó en la nueva');
  const kept = r.kept.find(([src]) => src === at);
  assert.ok(kept && /no pude dejar el enlace \(EPERM\): lo devolví/.test(kept[2]), JSON.stringify(r.kept));

  // y si el viejo reapareció entre el renombre y el enlace, queda la carpeta nueva y el viejo no se toca
  const home2 = toyHome('t3c-reaparece');
  timer(path.join(home2, CLAUDE, 'clocki'), 's1');
  const at2 = path.join(home2, CLAUDE, 'clocki');
  const reappears = (src, dst) => { fs.renameSync(src, dst); if (src === at2) fs.mkdirSync(path.join(at2, 'heartbeat'), { recursive: true }); };
  const r2 = freshLoose().moveOld(home2, { rename: reappears });
  assert.ok(!isLink(at2) && fs.existsSync(path.join(at2, 'heartbeat')), 'el viejo reaparecido, intacto y sin enlace');
  assert.ok(fs.existsSync(path.join(home2, '.tycon', 'state', 'clocki', 'active', 's1.json')), 'el timer, en la nueva');
  assert.ok(r2.moved.some(([src, , note]) => src === at2 && /reapareció/.test(note)), JSON.stringify(r2.moved));
});

// ── T4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: el aviso copiado suelto sellando en la carpeta de Claude Code.
test('T4 RetroStaleness_NoLooseDir_NoClaudeDir @story-8.335 @ac-3 — sin carpeta de registros sueltos, el sello no va a la de Claude Code', () => {
  const tree = tmp('t4-tree');
  fs.mkdirSync(path.join(tree, 'scripts', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-staleness-notice.js'), path.join(tree, 'scripts', 'hooks', 'retro-staleness-notice.js'));
  fs.mkdirSync(path.join(tree, '.dashboard'));
  fs.writeFileSync(path.join(tree, '.dashboard', 'metrics-2020-01-01.json'), '{}');
  const home = toyHome('t4', { own: false });
  const temp = tmp('t4-temp');
  const r = spawnSync(process.execPath, [path.join(tree, 'scripts', 'hooks', 'retro-staleness-notice.js')], {
    env: envFor(home, { TMPDIR: temp, TEMP: temp, TMP: temp }), encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /retro capturer: última ejecución/);
  assert.ok(!lexists(path.join(home, CLAUDE, '.tycon-retro-staleness-last-notice')), 'nada en la carpeta de Claude Code');
  assert.ok(fs.existsSync(path.join(temp, '.tycon-retro-staleness-last-notice')), 'el sello, en la carpeta temporal');
});

// ── T4b ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 Falla con: un aviso que le da al agente la ruta escrita a mano, o un uninstall que sigue el enlace.
test('T4b Notices_GiveRealPath_UninstallUnlinksOnly @story-8.335 @ac-3 — el aviso da la ruta real; uninstall saca sólo el enlace', () => {
  const home = toyHome('t4b');
  const state = path.join(home, '.tycon', 'state', 'clocki');
  timer(state, 'otra');
  require(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js')).makeLink(state, path.join(home, CLAUDE, 'clocki'));

  const r = spawnSync(process.execPath, [path.join(CLOCKI, 'on-prompt.js')], {
    env: envFor(home), encoding: 'utf8', input: JSON.stringify({ session_id: 's9', cwd: home, prompt: 'implementemos la story 2.3' }),
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(path.join(state, 'active', 's9.json')), `el aviso nombra el archivo real:\n${r.stdout}`);

  const U = require(path.join(ROOT, 'scripts', 'setup', 'harness', 'uninstall.js'));
  const ctx = { home, env: { HOME: home, TYCON_PRODUCTION_GUARD_DIR: path.join(home, 'sin-freno') } };
  const at = path.join(home, CLAUDE, 'clocki');
  const p = U.plan(ctx, { managed: [], tree: ROOT });
  assert.deepStrictEqual(p.storeLinks, [at]);
  assert.ok(!p.keep.some((l) => l.includes(at)), `no aconseja borrar el enlace:\n${p.keep.join('\n')}`);
  assert.ok(U.describePlan(p).some((l) => l.includes(`el enlace ${at}`) && l.includes('sólo el enlace')));
  const out = U.run(ctx, { managed: [], tree: ROOT });
  assert.ok(out.lines.some((l) => l.includes(`el enlace ${at}`)), out.lines.join('\n'));
  assert.ok(!lexists(at), 'el enlace se fue');
  assert.ok(fs.existsSync(path.join(state, 'active', 'otra.json')), 'la carpeta del estado, intacta');
});
