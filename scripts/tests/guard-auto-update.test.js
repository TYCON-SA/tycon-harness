'use strict';
// guard-auto-update.test.js — the session-start hook that launches the passwordless update of the production guard
// and the three cases of the production notice when the guard is old. Nothing here touches
// the real system: a fake system root, a fake HOME and a fake `sudo` that only writes down how it was called.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'guard-auto-update.js');
const GA = require(HOOK);
const NOTICE = require(path.join(ROOT, 'scripts', 'hooks', 'guard-update-notice.js'));

// A machine: the fake root with /opt/tycon, the downloaded harness with its manifest, and its team profile.
// `stale` is the judgment of the startup notice (production-notice.js): true = the guard is old, false = up to date,
// 'error' = it could not compare.
function lab({ permission = true, update = 'auto', installed = 'aaa', running = 'bbb', opt = true, log = null, downloadedAt = null, stale = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-auto-')));
  const sys = path.join(root, 'sys');
  const prod = path.join(sys, 'opt', 'tycon', 'production');
  if (opt) fs.mkdirSync(path.join(sys, 'opt', 'tycon', 'setup'), { recursive: true });
  if (opt) fs.mkdirSync(prod, { recursive: true });
  if (opt && permission) fs.writeFileSync(path.join(prod, 'auto-update.json'), '{}');
  if (opt && installed) fs.writeFileSync(path.join(prod, 'installed-release.json'), JSON.stringify({ commit: installed.padEnd(40, '0'), version: `v-${installed}` }));
  if (opt && log) fs.writeFileSync(path.join(prod, 'update-log.jsonl'), log.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, '.tycon-release.json'), JSON.stringify({ commit: running.padEnd(40, '0'), version: `v-${running}`, downloaded_at: downloadedAt || '2026-11-01T00:00:00Z', files: [] }));
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify(update ? { guard: { update } } : {}));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const calls = path.join(root, 'sudo.calls');
  const sudo = path.join(root, 'sudo');
  // printf, not echo: on Linux /bin/sh is dash, whose echo takes the leading -n as its own option
  fs.writeFileSync(sudo, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${'sleep ${SUDO_SLEEP:-0}'}\nexit 0\n`, { mode: 0o755 });
  const isStale = () => { if (stale === 'error') throw new Error('no pude leer lo publicado'); return stale; };
  const opts = { root: sys, home, arnes, env: {}, sudo, logDir: path.join(root, 'logs'), isStale };
  return { root, sys, prod, arnes, home, calls, opts };
}
const sudoCalls = (l) => { try { return fs.readFileSync(l.calls, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
// stable-data: el reloj sólo mide cuánto esperar al proceso de fondo; ningún dato de la prueba depende de la fecha
const waitFor = (fn, ms = 3000) => { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } return fn(); };

test('8.187 T20 AutoUpdate_Gancho_LanzaSoloConPermisoYAutoYViejo @story-8.187 @ac-19: lanza sólo con la marca, auto y el freno viejo; sin /opt/tycon no lanza; no espera a sudo', { skip: process.platform === 'win32' ? 'sudo de mentira en sh' : false }, () => {
  const cases = [
    [{}, true],
    [{ permission: false }, false],
    [{ update: 'password' }, false],
    [{ update: null }, false],
    [{ running: 'aaa' }, false],
    [{ opt: false }, false],
  ];
  for (const [over, launches] of cases) {
    const l = lab(over);
    const d = GA.decide(l.opts);
    assert.strictEqual(d.launch, launches, `${JSON.stringify(over)}: ${d.reason}`);
    GA.run(l.opts);
    assert.strictEqual(waitFor(() => sudoCalls(l).length > 0, launches ? 3000 : 300), launches, JSON.stringify(over));
    if (launches) assert.deepStrictEqual(sudoCalls(l), [`-n ${path.join(l.sys, 'opt', 'tycon', 'setup', 'update-guard.sh')}`]);
  }
  // un sudo que tarda: el gancho vuelve sin esperarlo, y la salida va a un registro de la carpeta de estado
  const slow = lab();
  const t0 = Date.now();
  GA.run({ ...slow.opts, env: { SUDO_SLEEP: '5' } });
  assert.ok(Date.now() - t0 < 1500, `el gancho esperó ${Date.now() - t0} ms`);
  assert.ok(waitFor(() => fs.existsSync(slow.opts.logDir) && fs.readdirSync(slow.opts.logDir).length > 0), 'la salida va a un registro');
});

test('8.187 T20e AutoUpdate_Gancho_SinShell @story-8.187 @ac-19: sudo y la ruta del freno llegan como argumentos, sin armar un comando de shell', { skip: process.platform === 'win32' ? 'sudo de mentira en sh' : false }, () => {
  const cp = require('child_process');
  const original = cp.spawn;
  const lanzados = [];
  // a fake process: the test writes down the call and launches nothing (T20 runs the real one against the fake sudo)
  cp.spawn = (cmd, args) => {
    lanzados.push([cmd, ...args]);
    const hijo = new (require('events'))();
    hijo.unref = () => {};
    return hijo;
  };
  delete require.cache[HOOK];
  try {
    const l = lab();
    require(HOOK).run(l.opts);
    assert.strictEqual(lanzados.length, 1, JSON.stringify(lanzados));
    const [cmd, ...args] = lanzados[0];
    assert.ok(!/(^|\/)[a-z]*sh$/.test(cmd) && !args.includes('-c'), `sin shell: ${JSON.stringify(lanzados[0])}`);
    assert.deepStrictEqual(args.slice(-2), [l.opts.sudo, path.join(l.sys, 'opt', 'tycon', 'setup', 'update-guard.sh')], 'sudo y la ruta del freno van como argumentos propios');
  } finally {
    cp.spawn = original;
    delete require.cache[HOOK];
  }
});

test('8.187 T21 AutoUpdate_Gancho_NoReintentaLaMismaVersion @story-8.187 @ac-19: con una falla anotada de la versión que corre no lanza; con otra versión, sí', () => {
  const fail = { status: 'failed', attempted_version: 'v-bbb', reason: 'el ensayo frenó', at: '2026-11-09T00:00:00Z' };
  const same = lab({ log: [fail] });
  assert.strictEqual(GA.decide(same.opts).launch, false);
  assert.match(GA.decide(same.opts).reason, /v-bbb/);
  const other = lab({ log: [{ ...fail, attempted_version: 'v-zzz' }] });
  assert.strictEqual(GA.decide(other.opts).launch, true, GA.decide(other.opts).reason);
  // una falla vieja seguida de una actualización buena a otra versión no frena
  const after = lab({ log: [fail, { at: '2026-11-09T01:00:00Z', to_version: 'v-ccc', to: 'c'.repeat(40) }], running: 'ddd' });
  assert.strictEqual(GA.decide(after.opts).launch, true);
});

test('8.187 T20b AutoUpdate_Gancho_ConElFrenoAlDia_NoLanza @story-8.187 @ac-19: una versión nueva del arnés que no cambia el freno no lanza; sin poder juzgarlo, tampoco, y lo dice', () => {
  const upToDate = lab({ stale: false });
  const d = GA.decide(upToDate.opts);
  assert.strictEqual(d.launch, false, d.reason);
  assert.match(d.reason, /al día/);
  const unknown = lab({ stale: 'error' });
  const u = GA.decide(unknown.opts);
  assert.strictEqual(u.launch, false, u.reason);
  assert.strictEqual(u.problema, true);
  assert.match(u.reason, /no pude saber si el freno quedó viejo.*no pude leer lo publicado/);
});

test('8.187 T21b AutoUpdate_Gancho_FallaSinVersion_NoReintenta @story-8.187 @ac-19: una falla anotada sin versión, posterior a la bajada de la que corre, no se relanza en cada sesión; una anterior a la bajada, sí', () => {
  const noVersion = { status: 'failed', attempted_version: null, reason: 'no hay origen de confianza fijado', at: '2026-11-09T00:00:00Z' };
  const afterDownload = lab({ log: [noVersion], downloadedAt: '2026-11-08T00:00:00Z' });
  const d = GA.decide(afterDownload.opts);
  assert.strictEqual(d.launch, false, d.reason);
  assert.match(d.reason, /no hay origen de confianza/);
  // la falla es de antes de bajar la versión que corre: con la nueva se vuelve a intentar
  const beforeDownload = lab({ log: [noVersion], downloadedAt: '2026-11-10T00:00:00Z' });
  assert.strictEqual(GA.decide(beforeDownload.opts).launch, true);
});

test('8.187 T20c AutoUpdate_Gancho_ConfiguracionIlegible_LoDice @story-8.187 @ac-19: sin poder leer guard.update no lanza y lo dice como problema, no como «la organización no eligió»', () => {
  const l = lab();
  fs.writeFileSync(path.join(l.arnes, 'perfil-equipo.json'), '{ esto no es json');
  const d = GA.decide(l.opts);
  assert.strictEqual(d.launch, false);
  assert.strictEqual(d.problema, true, d.reason);
  assert.match(d.reason, /no pude leer si la organización eligió.*JSON ilegible/);
});

test('8.187 T20d AutoUpdate_Gancho_SudoQueFalla_DejaSuSalida @story-8.187 @ac-22: si sudo sale con error, el registro del gancho lo anota y el aviso de arranque lo dice con el comando con contraseña', { skip: process.platform === 'win32' ? 'sudo de mentira en sh' : false }, () => {
  const l = lab({ downloadedAt: new Date().toISOString() });
  fs.writeFileSync(l.opts.sudo, '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n', { mode: 0o755 });
  GA.run(l.opts);
  const exited = () => { try { return fs.readdirSync(l.opts.logDir).some((f) => /exit=1/.test(fs.readFileSync(path.join(l.opts.logDir, f), 'utf8'))); } catch { return false; } };
  assert.ok(waitFor(exited), 'el registro del gancho anota con qué salió sudo');
  const a = NOTICE.atraso({ prod: l.prod, arnes: l.arnes, logDir: l.opts.logDir });
  assert.strictEqual(a.caso, 'no-arranco', JSON.stringify(a));
  assert.strictEqual(a.pideContrasena, true);
  assert.match(a.texto, /a password is required/);
  assert.match(a.texto, /sudo bash .*install-guard\.sh/);
});

test('8.187 T26 AvisoProduccion_ConPermiso_DistingueLosTresCasos @story-8.187 @ac-23: candado vivo o menos de 24 h: se está actualizando; con falla, lo del AC 22; más de 24 h sin renglón: trabado; otro instalador: contraseña', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const args = (l, extra = {}) => ({ prod: l.prod, arnes: l.arnes, now, ...extra });
  // candado de un proceso vivo
  const lock = lab({ downloadedAt: '2026-11-01T00:00:00Z' });
  fs.mkdirSync(path.join(lock.prod, 'update.lock'));
  fs.writeFileSync(path.join(lock.prod, 'update.lock', 'pid'), `${process.pid}\n`);
  const c1 = NOTICE.atraso(args(lock));
  assert.strictEqual(c1.caso, 'actualizando');
  assert.strictEqual(c1.pideContrasena, false);
  // bajada hace menos de 24 h
  const fresh = lab({ downloadedAt: '2026-11-10T02:00:00Z' });
  assert.strictEqual(NOTICE.atraso(args(fresh)).caso, 'actualizando');
  // con una falla anotada
  const failed = lab({ log: [{ status: 'failed', attempted_version: 'v-bbb', reason: 'el ensayo frenó ls', at: '2026-11-09T00:00:00Z' }] });
  const c3 = NOTICE.atraso(args(failed));
  assert.strictEqual(c3.caso, 'fallo');
  assert.strictEqual(c3.pideContrasena, true);
  assert.match(c3.texto, /v-bbb/);
  assert.match(c3.texto, /el ensayo frenó ls/);
  assert.match(c3.texto, /sudo bash/);
  // más de 24 h sin renglón
  const stuck = lab({ downloadedAt: '2026-11-08T00:00:00Z' });
  const c4 = NOTICE.atraso(args(stuck));
  assert.strictEqual(c4.caso, 'trabado');
  assert.strictEqual(c4.pideContrasena, true);
  assert.match(c4.texto, /sudo bash/);
  // otro instalador: siempre la contraseña, aunque esté fresca
  const other = lab({ downloadedAt: '2026-11-10T02:00:00Z' });
  fs.mkdirSync(path.join(other.arnes, 'scripts', 'production'), { recursive: true });
  fs.writeFileSync(path.join(other.arnes, 'scripts', 'production', 'install-guard.sh'), '# nuevo\n');
  fs.writeFileSync(path.join(other.sys, 'opt', 'tycon', 'setup', 'install-guard.sh'), '# viejo\n');
  const c5 = NOTICE.atraso(args(other));
  assert.strictEqual(c5.caso, 'otro-instalador');
  assert.strictEqual(c5.pideContrasena, true);
  // sin la fecha de la bajada: del lado de pedir la contraseña
  const unknown = lab();
  const rel = JSON.parse(fs.readFileSync(path.join(unknown.arnes, '.tycon-release.json'), 'utf8'));
  delete rel.downloaded_at;
  fs.writeFileSync(path.join(unknown.arnes, '.tycon-release.json'), JSON.stringify(rel));
  assert.strictEqual(NOTICE.atraso(args(unknown)).caso, 'trabado');
});
