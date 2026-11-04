'use strict';
// office-inbox-watch.test.js — the watcher each session arms at start and at the end of every turn: it takes a message the
// owner wrote in /office, writes it to stderr and exits 2 so the tool wakes the session. Real hook, toy HOME.
// stable-data: the clock is the process clock; every wait is bounded and short.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'office-inbox-watch.js');
const om = require(path.join(ROOT, 'scripts', 'lib', 'office-messages.js'));
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const WIN = process.platform === 'win32';

const started = new Set();
test.after(() => { for (const c of started) { try { c.kill('SIGKILL'); } catch { /* ya salió */ } } });

function toy() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-watch-'));
  return { home, sdir: stateDir(home) };
}
// el gancho de verdad, con el evento por su entrada; `done` resuelve con su código y lo que escribió
function hook(m, { sid = 's1', env = {}, event = 'SessionStart' } = {}) {
  const c = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: m.home, USERPROFILE: m.home, TYCON_OFFICE_WATCH_POLL_MS: '200', TYCON_OFFICE_WATCH_MAX_MS: '8000', TYCON_EVAL_SANDBOX: '', TYCON_OFFICE_MESSAGES: '', TYCON_OFFICE_WATCH_ANY_PARENT: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  started.add(c);
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sid }));
  const done = new Promise((resolve) => c.on('close', (code) => { started.delete(c); resolve({ code, out, err }); }));
  return { child: c, done };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); }
const inboxFiles = (m, sid = 's1') => { try { return fs.readdirSync(om.paths(m.sdir).inbox(sid)).filter((f) => f.endsWith('.json')); } catch { return []; } };

test('T5 Vigilante_ConMensaje_Sale2ConElTexto @story-8.183 @ac-8: código 2, el sobre por la salida de error y el buzón vacío', async () => {
  const m = toy();
  const h = hook(m);
  assert.ok(await until(() => om.watcherState(m.sdir, 's1').alive), 'el vigilante quedó vivo');
  const left = om.leave(m.sdir, { sid: 's1', text: 'revisá el pedido 12', now: Date.now() });
  const r = await h.done;
  assert.strictEqual(r.code, 2);
  assert.strictEqual(r.err, om.envelope('revisá el pedido 12', { id: left.id }));
  assert.strictEqual(r.out, '');
  assert.deepStrictEqual(inboxFiles(m), []);
  const st = om.watcherState(m.sdir, 's1');
  assert.strictEqual(st.alive, false);
  assert.ok(Number.isFinite(st.deliveredAt), 'el candado dice que entregó');
  assert.ok(om.readLog(m.sdir).rows.some((x) => x.id === left.id && x.estado === 'recibido'));
});

test('T6 Vigilante_ConOtroVivo_SeVaSinHacerNada @story-8.183 @ac-7: con un vigilante vivo, el nuevo sale 0 sin tomar nada', async () => {
  const m = toy();
  const first = hook(m);
  assert.ok(await until(() => om.watcherState(m.sdir, 's1').alive));
  const second = await hook(m).done;
  assert.strictEqual(second.code, 0);
  assert.strictEqual(second.err, '');
  assert.strictEqual(om.watcherState(m.sdir, 's1').pid, first.child.pid, 'sigue el primero');
  first.child.kill('SIGTERM');
  await first.done;
  assert.strictEqual(om.watcherState(m.sdir, 's1').alive, false, 'al irse suelta el candado');
});

test('T7 Vigilante_MensajeAnterior_LoToma @story-8.183 @ac-7 @ac-8: un mensaje que ya estaba al arrancar sale enseguida', async () => {
  const m = toy();
  const left = om.leave(m.sdir, { sid: 's1', text: 'estaba antes', now: Date.now(), deadlineMs: 60000 });
  const r = await hook(m, { event: 'Stop' }).done;
  assert.strictEqual(r.code, 2);
  assert.match(r.err, new RegExp(`^\\[oficina ${left.id}\\] `));
  assert.match(r.err, /Dice: estaba antes$/);
});

test('T8 Vigilante_ErrorDeLectura_NoMuestraError @story-8.183 @ac-36: con la carpeta ilegible sale 0 sin escribir nada', { skip: WIN || (process.getuid && process.getuid() === 0) }, async () => {
  const m = toy();
  fs.mkdirSync(om.paths(m.sdir).dir, { recursive: true });
  fs.chmodSync(om.paths(m.sdir).dir, 0o000);
  try {
    const r = await hook(m).done;
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.err, '');
    assert.strictEqual(r.out, '');
  } finally { fs.chmodSync(om.paths(m.sdir).dir, 0o700); }
});

test('T41 Vigilante_MensajeVencido_NoLoEntrega @story-8.183 @ac-39: sin oficina, uno vencido sale del buzón sin texto y anotado', async () => {
  const m = toy();
  const old = om.leave(m.sdir, { sid: 's1', text: 'indicación vieja', now: Date.now() - 60000, deadlineMs: 10000 });
  const h = hook(m, { env: { TYCON_OFFICE_WATCH_MAX_MS: '1500' } });
  const r = await h.done;
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
  assert.deepStrictEqual(inboxFiles(m), []);
  const row = om.readLog(m.sdir).rows.find((x) => x.id === old.id && x.estado === 'no-entregado');
  assert.ok(row, 'quedó anotado');
  assert.strictEqual(row.motivo, 'vencido');
});

test('Vigilante_Apagado_NoArma (8.183 T18, gancho) @story-8.183 @ac-28: con TYCON_OFFICE_MESSAGES=0 no deja candado ni toma nada', async () => {
  const m = toy();
  om.leave(m.sdir, { sid: 's1', text: 'no debería salir', now: Date.now(), deadlineMs: 60000 });
  const r = await hook(m, { env: { TYCON_OFFICE_MESSAGES: '0' } }).done;
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
  assert.strictEqual(inboxFiles(m).length, 1);
  assert.ok(!fs.existsSync(om.paths(m.sdir).watcher('s1')));
});

test('T43 Vigilante_SinLaHerramienta_SeVaEnseguida @story-8.183 @ac-40: lanzado por la prueba sale 0 enseguida, sin candado y sin tomar nada', async () => {
  const m = toy();
  om.leave(m.sdir, { sid: 's1', text: 'no debería salir', now: Date.now(), deadlineMs: 60000 });
  const t0 = Date.now();
  const r = await hook(m, { env: { TYCON_OFFICE_WATCH_ANY_PARENT: '' } }).done;
  assert.ok(Date.now() - t0 < 3000, `tardó ${Date.now() - t0} ms`);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
  assert.strictEqual(inboxFiles(m).length, 1);
  assert.ok(!fs.existsSync(om.paths(m.sdir).watcher('s1')));
});

test('T44 Vigilante_NombreDeLaHerramienta_LoReconoce @story-8.183 @ac-40: los nombres reales del proceso de la herramienta, y no otros', () => {
  const { isToolName } = require(HOOK);
  for (const yes of ['claude', '/usr/local/bin/claude', 'claude bg-spare', '/Users/x/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe']) assert.strictEqual(isToolName(yes), true, yes);
  for (const no of ['node', '/bin/zsh', 'claude-helper', 'myclaude', '']) assert.strictEqual(isToolName(no), false, no);
});

test('Vigilante_SinPlazoPropio_SeVaSolo (8.183 T7, plazo) @story-8.183 @ac-7 @ac-36: pasado su plazo sale 0 y suelta el candado', async () => {
  const m = toy();
  const r = await hook(m, { env: { TYCON_OFFICE_WATCH_MAX_MS: '600' } }).done;
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.err, '');
  assert.strictEqual(om.watcherState(m.sdir, 's1').alive, false);
  assert.ok(!fs.existsSync(om.paths(m.sdir).watcher('s1')));
});
