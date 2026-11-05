'use strict';
// permission-notice.test.js — una sesión frenada en un cuadro de permiso: lo que anota session-state.js, cómo se entera
// la coordinadora (`coordination.js owner-wait` y `capNotice`), la línea «Trabadas» de `status`, el lanzador de Windows
// de `open` y `close`, y lo que dice la guía.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'hooks', 'session-state.js');
const SS = require(HOOK);
const LIB = require(path.join(ROOT, 'scripts', 'lib', 'session-state.js'));
const C = require(path.join(ROOT, 'scripts', 'tools', 'coordination.js'));
const WN = require(path.join(ROOT, 'scripts', 'hooks', 'wait-notice.js'));
const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
const { stateDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const NOW = Date.parse('2026-11-04T14:00:00.000Z');
const mins = (n) => NOW - n * 60000;
const COORD = 'coord-sid-1';
const OTRA = 'otra-sid-2';
// La coordinadora confirmada pide approvals.relay_session en el perfil del árbol del arnés, y el clon de trabajo no lo
// trae: en el proceso de la prueba se lee de una carpeta con ese perfil, y owner-wait corre desde una copia del arnés
// que lo tiene.
const CON_CLAVE = require('./lib/harness-copy.js').harnessCopy();
fs.writeFileSync(path.join(CON_CLAVE, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
const confirmadaSinClave = OA.coordinadoraConfirmada;
OA.coordinadoraConfirmada = (casa, o = {}) => confirmadaSinClave(casa, { arnes: CON_CLAVE, ...o });
const COORD_SCRIPT = path.join(CON_CLAVE, 'scripts', 'tools', 'coordination.js');

/** Una máquina de juguete: la carpeta de la persona, el estado y el perfil con el rol de coordinadora. */
function toy({ designated = COORD, confirmed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-notice-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  if (designated) {
    const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: designated, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
    const lines = [JSON.stringify(d), ...(confirmed ? [JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))] : [])];
    fs.writeFileSync(path.join(state, 'gates.log'), `${lines.join('\n')}\n`);
  }
  const t = { root, home, state, arnes, opts: { home, arnes, env: {}, now: NOW, sessionId: COORD } };
  claudeFile(t, COORD, 'Coordinadora', { status: 'busy', statusUpdatedAt: mins(0) });
  return t;
}
/** El archivo de sesión de Claude Code, vivo (el pid de este proceso) salvo `dead`. */
function claudeFile(t, sid, name, extra = {}) {
  fs.writeFileSync(path.join(t.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({
    pid: extra.dead ? 999999 : process.pid, sessionId: sid, name, nameSource: 'user', status: 'idle', statusUpdatedAt: mins(20), cwd: t.root, kind: 'bg', ...extra,
  }));
}
/** El archivo de estado de una sesión, con lo que se le pase. */
function stateFile(t, sid, patch) {
  LIB.update(t.state, sid, patch, { create: true, tool: 'claude', env: {} });
}
const readState = (t, sid) => LIB.read(t.state, sid).state;
const ev = (sid, extra) => ({ session_id: sid, hook_event_name: 'PermissionRequest', cwd: '/tmp', permission_mode: 'default', ...extra });
const frenada = (t, sid, tool = 'Write', detail = '/r/specs/x.md', minutesAgo = 3) => stateFile(t, sid, {
  waitingForOwner: true, waitingFor: 'un permiso', permission: { tool, detail, since: new Date(mins(minutesAgo)).toISOString() },
});

// ── Lo que se anota (AC 1 a 5) ─────────────────────────────────────────────────────────────────────────────────────

test('T1 PermissionRequest_Bash_AnotaComandoTapado @story-8.202 @ac-1', () => {
  const t = toy();
  const cmd = `curl -H token=abc123secreto https://x ${'a'.repeat(400)}`;
  SS.handle(ev(OTRA, { tool_name: 'Bash', tool_input: { command: cmd } }), {}, t.home);
  const s = readState(t, OTRA);
  assert.strictEqual(s.waitingForOwner, true);
  assert.strictEqual(s.waitingFor, 'un permiso');
  assert.strictEqual(s.permission.tool, 'Bash');
  assert.ok(s.permission.detail.length <= 200, s.permission.detail.length);
  assert.doesNotMatch(s.permission.detail, /abc123secreto/);
  assert.match(s.permission.detail, /<tapado>/);
  // stable-data: el gancho anota la hora real del pedido; se compara contra ahora con un minuto de margen
  assert.ok(Math.abs(Date.parse(s.permission.since) - Date.now()) < 60000, 'since es de ahora');
});

test('T2 PermissionRequest_WriteReadWebFetchMcp_DetalleSegunHerramienta @story-8.202 @ac-1', () => {
  const cases = [
    ['Write', { file_path: '/r/a.md', content: 'x' }, '/r/a.md'],
    ['Read', { file_path: '/fuera/b.txt' }, '/fuera/b.txt'],
    ['NotebookEdit', { notebook_path: '/r/n.ipynb' }, '/r/n.ipynb'],
    ['Glob', { path: '/fuera', pattern: '*.js' }, '/fuera'],
    ['WebFetch', { url: 'https://acme.example/x' }, 'https://acme.example/x'],
    ['Grep', { pattern: 'foo.*bar' }, 'foo.*bar'],
    ['mcp__x__y', { secreto: 'no va' }, null],
  ];
  for (const [tool, input, want] of cases) {
    const p = SS.permissionOf({ tool_name: tool, tool_input: input }, NOW);
    assert.strictEqual(p.tool, tool);
    assert.strictEqual(p.detail, want, tool);
  }
  const multi = SS.permissionOf({ tool_name: 'Bash', tool_input: { command: 'echo a\necho b' } }, NOW);
  assert.strictEqual(multi.detail, 'echo a echo b', 'en una línea');
});

test('T3 PermissionRequest_SaleCeroSinImprimir @story-8.202 @ac-2', () => {
  const t = toy();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(ev(OTRA, { tool_name: 'Write', tool_input: { file_path: '/r/a.md' } })),
    env: { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_HOME: '' }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '', 'nada en la salida: el cuadro sigue como siempre');
  assert.ok(Date.now() - t0 < 1000 || process.env.CI, `tardó ${Date.now() - t0} ms`);
  assert.strictEqual(readState(t, OTRA).permission.detail, '/r/a.md');
});

test('T4 PermissionRequest_Apagado_NoAnota @story-8.202 @ac-2', () => {
  const t = toy();
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(ev(OTRA, { tool_name: 'Write', tool_input: { file_path: '/r/a.md' } })),
    env: { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_HOME: '', TYCON_SESSION_STATE: '0' }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(readState(t, OTRA), null);
});

test('T5 Notificacion_DespuesDelPedido_NoBorraElDetalle @story-8.202 @ac-3', () => {
  const t = toy();
  SS.handle(ev(OTRA, { tool_name: 'Bash', tool_input: { command: 'rm -rf /r/tmp' } }), {}, t.home);
  SS.handle({ session_id: OTRA, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, {}, t.home);
  const s = readState(t, OTRA);
  assert.strictEqual(s.permission.detail, 'rm -rf /r/tmp');
  assert.strictEqual(s.waitingForOwner, true);
});

test('T6 Notificacion_SoloElAviso_AnotaLaHerramientaSinDetalle @story-8.202 @ac-3', () => {
  const t = toy();
  SS.handle({ session_id: OTRA, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Skill' }, {}, t.home);
  const s = readState(t, OTRA);
  assert.strictEqual(s.permission.tool, 'Skill');
  assert.strictEqual(s.permission.detail, null);
  assert.ok(s.permission.since);
});

test('T7 SiguioOSeCerro_BorraElPermiso @story-8.202 @ac-4', () => {
  const t = toy();
  const pedir = () => SS.handle(ev(OTRA, { tool_name: 'Write', tool_input: { file_path: '/r/a.md' } }), {}, t.home);
  for (const fin of [
    { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'Stop' },
  ]) {
    pedir();
    SS.handle({ session_id: OTRA, ...fin }, {}, t.home);
    const s = readState(t, OTRA);
    assert.ok(!('permission' in s), fin.hook_event_name);
    assert.strictEqual(s.waitingForOwner, false, fin.hook_event_name);
  }
  pedir();
  SS.handle({ session_id: OTRA, hook_event_name: 'SessionEnd' }, {}, t.home);
  assert.strictEqual(readState(t, OTRA), null, 'SessionEnd borra el archivo');
  pedir();
  SS.handle({ session_id: OTRA, hook_event_name: 'PostToolUse', tool_name: 'Read' }, {}, t.home);
  const s = readState(t, OTRA);
  assert.strictEqual(s.permission.tool, 'Write', 'el final de otra herramienta no lo borra');
  assert.strictEqual(s.waitingForOwner, true, 'ni baja la espera');
});

test('T8 EscuchasDelCuadro_ConElGancho_NoEsAjeno @story-8.202 @ac-5', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'setup', 'hooks-list.json'), 'utf8'));
  const hooks = (list.hooks || list).filter((h) => h.event === 'PermissionRequest' && /session-state\.js$/.test(h.spec));
  assert.strictEqual(hooks.length, 1, 'un renglón PermissionRequest de session-state.js');
  const m = hooks[0].matcher;
  assert.ok(m && m !== '*', 'nunca vacío ni *');
  assert.strictEqual(OA.alcanzaAlCuadro(m), false, 'no alcanza al cuadro de firmas');
  for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__x__y']) {
    assert.ok(new RegExp(`^(?:${m})$`).test(tool), tool);
  }
  const t = toy();
  const settings = { hooks: { PermissionRequest: [{ matcher: m, hooks: [{ type: 'command', command: `node ${HOOK}` }] }] } };
  fs.writeFileSync(path.join(t.home, '.claude', 'settings.json'), JSON.stringify(settings));
  const r = OA.escuchasDelCuadro({ casa: t.home, cwd: t.root });
  assert.deepStrictEqual(r.ajenos, [], JSON.stringify(r));
  assert.ok(OA.PERMITIDOS.includes('session-state.js'), 'PERMITIDOS no cambia');
});

// ── El aviso a la coordinadora (AC 6 a 13) ─────────────────────────────────────────────────────────────────────────

/** Una vuelta de owner-wait, sin dormir: las líneas que lo harían terminar. */
const vuelta = (t, extra = {}) => C.ownerWaitOnce({ ...t.opts, ...extra });

test('T9 OwnerWait_SesionFrenada_TerminaConLaLinea @story-8.202 @ac-6', () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting', waitingFor: 'permission prompt' });
  frenada(t, OTRA, 'Write', '/r/specs/x.md', 0);
  const r = vuelta(t);
  assert.strictEqual(r.lines.length, 1, JSON.stringify(r));
  assert.match(r.lines[0], /^hora-mensajes espera un permiso desde las \d\d:\d\d: Write \/r\/specs\/x\.md\. Para entrar: claude attach hora-mensajes$/);
});

test('T10 OwnerWait_YaAnunciada_NoTerminaDeNuevo @story-8.202 @ac-6', () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA);
  assert.strictEqual(vuelta(t).lines.length, 1);
  assert.deepStrictEqual(vuelta(t).lines, [], 'la misma espera no lo vuelve a terminar');
});

test('T11 OwnerWait_SesionSiguio_AvisaUnaVez @story-8.202 @ac-7', () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  claudeFile(t, 'tercera-3', 'tercera', { status: 'waiting' });
  frenada(t, OTRA);
  frenada(t, 'tercera-3', 'Bash', 'npm i');
  assert.strictEqual(vuelta(t).lines.length, 2);
  stateFile(t, OTRA, { permission: null, waitingForOwner: false, waitingFor: null });
  claudeFile(t, 'tercera-3', 'tercera', { status: 'busy', statusUpdatedAt: mins(0) });   // una negación: sigue con permission
  const r = vuelta(t);
  assert.deepStrictEqual(r.lines.sort(), ['hora-mensajes siguió: el permiso ya no está abierto', 'tercera siguió: el permiso ya no está abierto']);
  assert.deepStrictEqual(vuelta(t).lines, [], 'una sola vez');
});

test('T12 OwnerWait_SesionMurio_LoDice @story-8.202 @ac-7', () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA);
  vuelta(t);
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting', dead: true });
  assert.deepStrictEqual(vuelta(t).lines, ['hora-mensajes se cerró con un permiso abierto']);
  fs.rmSync(LIB.pathOf(t.state, OTRA));
  assert.deepStrictEqual(vuelta(t).lines, [], 'una sola vez');
});

test('T13 OwnerWait_EsperaPrevia_TerminaEnseguida @story-8.202 @ac-8', async () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA);
  const r = await runOwnerWait(t, COORD, 10000);
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /hora-mensajes espera un permiso/);
  assert.ok(r.ms < 8000, `tardó ${r.ms} ms`);
});

/** owner-wait como proceso, desde la sesión `sid`; lo corta a los `max` ms. */
function runOwnerWait(t, sid, max, envExtra = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [COORD_SCRIPT, 'owner-wait'], {
      env: { ...process.env, HOME: t.home, USERPROFILE: t.home, TYCON_HOME: '', CLAUDE_CODE_SESSION_ID: sid, TYCON_GUIDES_DIR: t.arnes, TYCON_OWNER_WAIT_POLL_MS: '200', ...envExtra },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => child.kill(), max);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err, ms: Date.now() - t0, killed: code === null }); });
  });
}

test('T14 OwnerWait_CoordinadoraMuertaOOtra_SaleCallado @story-8.202 @ac-9', async () => {
  // su sesión muere: termina sin imprimir
  const t = toy();
  claudeFile(t, COORD, 'Coordinadora', { dead: true });
  assert.deepStrictEqual(vuelta(t), { lines: [], stop: true });
  // se designa otra: sin imprimir
  const t2 = toy({ designated: 'otra-coord' });
  claudeFile(t2, 'otra-coord', 'Nueva', { status: 'busy' });
  claudeFile(t2, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t2, OTRA);
  assert.deepStrictEqual(vuelta(t2), { lines: [], stop: true });
  // sin coordinadora confirmada, o desde otra sesión: sale 0 enseguida con la línea
  const t3 = toy({ confirmed: false });
  const r3 = await runOwnerWait(t3, COORD, 8000);
  assert.strictEqual(r3.code, 0);
  assert.match(r3.out, /no hay coordinadora confirmada en esta máquina: no espero nada/);
  const t4 = toy();
  const r4 = await runOwnerWait(t4, OTRA, 8000);
  assert.strictEqual(r4.code, 0);
  assert.match(r4.out, /no hay coordinadora confirmada en esta máquina: no espero nada/);
});

test('T15 OwnerWait_Segundo_SaleCeroYLoDice @story-8.202 @ac-9', async () => {
  const t = toy();
  const first = runOwnerWait(t, COORD, 4000);
  await new Promise((r) => setTimeout(r, 1200));
  const second = await runOwnerWait(t, COORD, 4000);
  assert.strictEqual(second.code, 0);
  assert.match(second.out, /ya hay uno/);
  const f = await first;
  assert.ok(f.killed, 'el primero seguía esperando');
});

test('T16 CapNotice_SinOwnerWait_DaElComando @story-8.202 @ac-10', () => {
  const t = toy();
  const n = C.capNotice(t.opts) || '';
  assert.match(n, /coordination\.js"? owner-wait/);
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'owner-wait.pid'), String(process.pid));
  assert.doesNotMatch(C.capNotice(t.opts) || '', /owner-wait/);
});

test('T17 CapNotice_Trabada2Min_LaLinea @story-8.202 @ac-11', () => {
  const vivo = (t) => { fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true }); fs.writeFileSync(path.join(t.state, 'coordination', 'owner-wait.pid'), String(process.pid)); };
  const t = toy();
  vivo(t);
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA, 'Write', '/r/x.md', 2);
  assert.match(C.capNotice(t.opts) || '', /hora-mensajes espera un permiso desde las \d\d:\d\d: Write \/r\/x\.md/);
  const t1 = toy();
  vivo(t1);
  claudeFile(t1, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t1, OTRA, 'Write', '/r/x.md', 1);
  assert.doesNotMatch(C.capNotice(t1.opts) || '', /espera un permiso/, 'debajo de los 2 minutos');
  const t2 = toy();
  vivo(t2);
  claudeFile(t2, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t2, OTRA, 'Write', '/r/x.md', 5);
  vuelta(t2);
  assert.doesNotMatch(C.capNotice(t2.opts) || '', /espera un permiso/, 'ya anunciada');
  const t3 = toy();
  vivo(t3);
  claudeFile(t3, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t3, OTRA, 'Write', '/r/x.md', 5);
  assert.strictEqual(C.capNotice({ ...t3.opts, sessionId: OTRA }), null, 'en otra sesión, nada');
});

test('T18 SinCanalNiPipeline_ElAvisoIgual @story-8.202 @ac-12', () => {
  const t = toy();
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify({ integrations: { notify: { channels: [] } } }));
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  SS.handle(ev(OTRA, { tool_name: 'Write', tool_input: { file_path: '/r/a.md' } }), {}, t.home);
  assert.strictEqual(fs.readdirSync(path.join(t.state, 'active')).length, 0, 'sin marcador de pipeline');
  assert.match(vuelta(t).lines.join('\n'), /hora-mensajes espera un permiso/);
  const t2 = toy();
  fs.mkdirSync(path.join(t2.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t2.state, 'coordination', 'owner-wait.pid'), String(process.pid));
  claudeFile(t2, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t2, OTRA, 'Write', '/r/a.md', 3);
  assert.match(C.capNotice(t2.opts) || '', /hora-mensajes espera un permiso/);
});

test('T19 WaitNotice_ConCoordinadora_SinLineaDePermiso @story-8.202 @ac-13', () => {
  const espera = (t) => {
    const dir = path.join(t.state, 'wait-notice', 'waits');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${OTRA}.json`), JSON.stringify({
      session: OTRA, story: '9.9', step: 'implement', kind: 'permission', waiting: 'permiso para Bash', openedAt: new Date(mins(6)).toISOString(),
      coordinatorSid: COORD, waitingName: 'hora-mensajes', ownerAt: new Date(mins(-24)).toISOString(),
    }));
  };
  const t = toy();
  espera(t);
  assert.deepStrictEqual(WN.coordinatorLines({ home: t.home, coordinatorSid: COORD }), [], 'con coordinadora confirmada, no la da');
  const t2 = toy({ confirmed: false });
  espera(t2);
  assert.strictEqual(WN.coordinatorLines({ home: t2.home, coordinatorSid: COORD }).length, 1, 'sin confirmar, como hoy');
});

// ── Lo que dice status (AC 14, 15) ─────────────────────────────────────────────────────────────────────────────────

test('T20 Status_RecienAbiertaYFrenada_SaleTrabada @story-8.202 @ac-14', () => {
  const t = toy();
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'opened.json'), JSON.stringify([{ name: 'recien', at: mins(2), cwd: t.root }]));
  claudeFile(t, 'recien-4', 'recien', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: mins(2) });
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA, 'Write', '/r/specs/x.md', 3);
  claudeFile(t, 'negada-5', 'negada', { status: 'busy', statusUpdatedAt: mins(0) });
  frenada(t, 'negada-5', 'Bash', 'ls');
  claudeFile(t, 'quieta-7', 'quieta', { status: 'idle' });   // negada con Esc: sin Stop ni PostToolUse, queda quieta
  frenada(t, 'quieta-7', 'Bash', 'ls');
  claudeFile(t, 'muerta-6', 'muerta', { dead: true });
  frenada(t, 'muerta-6', 'Bash', 'ls');
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.stalled.map((x) => x.session).sort(), ['hora-mensajes', 'recien']);
  assert.ok(!s.working.some((w) => w.session === 'recien'), 'no cuenta como trabajando para el tope');
  const text = C.statusText(s);
  assert.match(text, /Trabadas: .*hora-mensajes: esperando un permiso \(Write \/r\/specs\/x\.md\), hace 3 min/);
  assert.doesNotMatch(text, /recien.*todavía arrancando/);
});

test('T21 Status_Json_TraeStalled @story-8.202 @ac-15', () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA, 'Write', '/r/x.md', 3);
  const s = C.status(t.opts);
  assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(s)).stalled[0]).sort(), ['detail', 'session', 'sid', 'since', 'tool']);
  assert.strictEqual(s.stalled[0].sid, OTRA);
  assert.strictEqual(s.stalled[0].tool, 'Write');
});

// ── Windows (AC 16 a 19) ───────────────────────────────────────────────────────────────────────────────────────────

const NPM_CMD_NODE = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
const NPM_CMD_EXE = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

/** Un Windows de mentira: los archivos que hay, el PATH y quién lee qué. */
function win(files, { path: p = 'C:\\npm;C:\\Windows' } = {}) {
  const norm = (f) => f.toLowerCase();
  const set = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    platform: 'win32', env: { PATH: p, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    exists: (f) => set.has(norm(f)),
    read: (f) => { if (!set.has(norm(f)) || set.get(norm(f)) === null) throw new Error('EACCES'); return set.get(norm(f)); },
    exec: () => { throw new Error('where no se corre'); },
    nodePath: 'C:\\node\\node.exe',
  };
}

test('T22 Open_Windows_CmdDeNpm_LanzaElPrograma @story-8.202 @ac-16 @ac-17', () => {
  const viaNode = C.claudeLauncher(win({ 'C:\\npm\\claude.cmd': NPM_CMD_NODE }));
  assert.deepStrictEqual(viaNode, { bin: 'C:\\node\\node.exe', prefix: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
  const viaNodeLocal = C.claudeLauncher(win({ 'C:\\npm\\claude.cmd': NPM_CMD_NODE, 'C:\\npm\\node.exe': '' }));
  assert.deepStrictEqual(viaNodeLocal, { bin: 'C:\\npm\\node.exe', prefix: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
  const viaExe = C.claudeLauncher(win({ 'C:\\npm\\claude.cmd': NPM_CMD_EXE }));
  assert.deepStrictEqual(viaExe, { bin: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', prefix: [] });
  const exe = C.claudeLauncher(win({ 'C:\\Users\\a\\.local\\bin\\claude.exe': '' }, { path: 'C:\\Users\\a\\.local\\bin' }));
  assert.deepStrictEqual(exe, { bin: 'C:\\Users\\a\\.local\\bin\\claude.exe', prefix: [] });
  assert.deepStrictEqual(C.claudeLauncher({ platform: 'darwin' }), { bin: 'claude', prefix: [] }, 'en Mac, como hoy');
  // open y close lanzan con lo que resolvió, y los argumentos de Mac van detrás del programa
  assert.deepStrictEqual(C.resolveLauncher({ windows: win({ 'C:\\npm\\claude.cmd': NPM_CMD_NODE }) }), viaNode);
  assert.deepStrictEqual(C.resolveLauncher({ launcher: { bin: 'x', prefix: [] }, windows: win({}) }), { bin: 'x', prefix: [] }, 'el inyectado gana');
  assert.deepStrictEqual(C.launchArgv(viaNode, ['--bg', '-n', 'prueba']), ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '--bg', '-n', 'prueba']);
  const src = fs.readFileSync(COORD_SCRIPT, 'utf8');
  assert.strictEqual((src.match(/resolveLauncher\(opts\b/g) || []).length, 2, 'open y close usan el mismo lanzador');
  assert.doesNotMatch(src, /opts\.launcher \|\| \{ bin: 'claude'/, 'ninguno lanza «claude» a secas');
});

test('T23 Open_Windows_CmdIlegibleONinguno_ElMensajeJusto @story-8.202 @ac-18 @ac-19', () => {
  const raro = C.claudeLauncher(win({ 'C:\\npm\\claude.cmd': '@echo hola\r\n' }));
  assert.match(raro.error, /^encontré C:\\npm\\claude\.cmd pero no pude leer a qué programa apunta: no abrí la sesión\.$/);
  const ilegible = C.claudeLauncher(win({ 'C:\\npm\\claude.cmd': null }));
  assert.match(ilegible.error, /encontré C:\\npm\\claude\.cmd pero no pude leer a qué programa apunta/);
  const ninguno = C.claudeLauncher(win({}));
  assert.match(ninguno.error, /Claude Code no está instalado en esta máquina/);
  // un claude.cmd en la carpeta de la sesión, fuera del PATH: no se usa y no se corre where
  const plantado = C.claudeLauncher({ ...win({ 'C:\\sesion\\claude.cmd': NPM_CMD_NODE }), cwd: 'C:\\sesion' });
  assert.match(plantado.error, /Claude Code no está instalado/);
});

// ── La guía (AC 20) ────────────────────────────────────────────────────────────────────────────────────────────────

test('T24 Guia_DiceOwnerWaitMirarLaOficinaYElModoAutomatico @story-8.202 @ac-20', () => {
  const es = fs.readFileSync(path.join(ROOT, 'guides', 'coordination.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'coordination.en.md'), 'utf8');
  assert.match(es, /owner-wait/);
  assert.match(es, /de fondo/);
  assert.match(es, /no hay nada para vos/);
  assert.match(es, /«Tu firma»/);
  assert.match(es, /modo automático no evita el cuadro/);
  assert.match(es, /Una sesión trabada se avisa[^\n]*al instante, con `owner-wait`/);
  assert.match(en, /owner-wait/);
  assert.match(en, /in the background/);
  assert.match(en, /nothing for you/);
  assert.match(en, /auto mode does not avoid the dialog/);
  assert.match(en, /A stuck session is reported[^\n]*instantly, with `owner-wait`/);
});

// ── No-regresión y Codex (AC 21, 22) ───────────────────────────────────────────────────────────────────────────────

test('T25 NoRegresion_LasCincoSuites @story-8.202 @ac-21', () => {
  const t = toy();
  for (const e of [
    { hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, { hook_event_name: 'Stop' },
  ]) SS.handle({ session_id: OTRA, ...e }, {}, t.home);
  assert.ok(!('permission' in readState(t, OTRA)), 'una sesión que no se frena no anota nada nuevo');
  if (process.env.TYCON_PERMISSION_NOTICE_NESTED) return;
  for (const suite of ['session-state', 'wait-notice', 'coordination', 'coordination-notice', 'owner-approvals']) {
    const file = path.join(ROOT, 'scripts', 'tests', `${suite}.test.js`);
    // sin NODE_TEST_CONTEXT: con ella, el hijo se cree parte de esta corrida y no corre sus pruebas
    const env = { ...process.env, TYCON_PERMISSION_NOTICE_NESTED: '1' };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env, timeout: 600000 });
    assert.strictEqual(r.status, 0, `${suite}: ${(r.stdout || '').split('\n').filter((l) => /^not ok|# fail/.test(l)).join('\n')}`);
    assert.match(r.stdout, /^# pass [1-9]/m, `${suite}: no corrió ninguna prueba`);
  }
});

// ── Lo que confirmó el pase adversarial: un permiso que ya no está abierto no se da por abierto ──────────────────

test('Adv1 Notificacion_SinNombre_LaCierraCualquierHerramienta @story-8.202 @ac-3 @ac-4', () => {
  const t = toy();
  // el texto real de Claude Code no siempre trae «to use X»: se anota sin nombre y lo cierra el final de cualquier herramienta
  SS.handle({ session_id: OTRA, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, {}, t.home);
  assert.strictEqual(readState(t, OTRA).permission.via, 'notification');
  SS.handle({ session_id: OTRA, hook_event_name: 'PostToolUse', tool_name: 'Artifact' }, {}, t.home);
  assert.ok(!('permission' in readState(t, OTRA)));
  assert.strictEqual(readState(t, OTRA).waitingForOwner, false);
  // el nombre visible («Fetch») tampoco es el de la herramienta (WebFetch): lo cierra igual
  SS.handle({ session_id: OTRA, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Fetch' }, {}, t.home);
  SS.handle({ session_id: OTRA, hook_event_name: 'PostToolUse', tool_name: 'WebFetch' }, {}, t.home);
  assert.ok(!('permission' in readState(t, OTRA)));
});

test('Adv2 Negado_ConEsc_NoEsTrabadaYOwnerWaitDiceSiguio @story-8.202 @ac-7 @ac-14', () => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting', waitingFor: 'permission prompt' });
  SS.handle(ev(OTRA, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), {}, t.home);
  assert.strictEqual(vuelta(t).lines.length, 1);
  // Esc: Claude la deja quieta, sin Stop ni PostToolUse, y el archivo de estado sigue con el permiso
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'idle' });
  assert.ok(readState(t, OTRA).permission);
  assert.deepStrictEqual(C.status(t.opts).stalled, []);
  assert.deepStrictEqual(vuelta(t).lines, ['hora-mensajes siguió: el permiso ya no está abierto']);
  const W = require(path.join(ROOT, 'scripts', 'tools', 'work-in-progress.js'));
  assert.notStrictEqual(W.realState({ kind: 'pipeline' }, { status: 'idle' }, readState(t, OTRA)).estado, 'firma', 'la oficina tampoco la da en firma');
  assert.notStrictEqual(W.realState({ kind: 'pipeline' }, { status: 'busy' }, readState(t, OTRA)).estado, 'firma', 'ni cuando falla la herramienta y sigue ocupada');
});

test('Adv3 OwnerWait_LaHoraCambiaDeFuente_NoAnunciaDosVeces @story-8.202 @ac-6', () => {
  const t = toy();
  // primero Claude la da esperando un permiso, sin nada anotado; después llega el permiso anotado
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: mins(1) });
  assert.strictEqual(vuelta(t).lines.length, 1);
  frenada(t, OTRA, 'Bash', 'npm i', 0);
  assert.deepStrictEqual(vuelta(t).lines, [], 'la misma espera no se anuncia de nuevo');
  // sin hora de Claude ni permiso anotado, tampoco se repite en cada vuelta
  const t2 = toy();
  claudeFile(t2, OTRA, 'hora-mensajes', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: undefined });
  assert.strictEqual(vuelta(t2).lines.length, 1);
  assert.deepStrictEqual(vuelta(t2).lines, []);
});

test('Adv4 OwnerWait_SinPoderLeer_NoDiceSiguio @story-8.202 @ac-7', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX' : false }, (t2) => {
  const t = toy();
  claudeFile(t, OTRA, 'hora-mensajes', { status: 'waiting' });
  frenada(t, OTRA);
  assert.strictEqual(vuelta(t).lines.length, 1);
  // la carpeta de los archivos de estado deja de poder leerse: no se sabe si siguió, y no se dice que siguió
  const dir = LIB.dirOf(t.state);
  fs.chmodSync(dir, 0o000);
  t2.after(() => fs.chmodSync(dir, 0o700));
  assert.deepStrictEqual(vuelta(t).lines, []);
  fs.chmodSync(dir, 0o700);
  assert.deepStrictEqual(vuelta(t).lines, [], 'con la lectura buena, la espera sigue anunciada');
});

test('T26 Codex_NadaCambia @story-8.202 @ac-22', () => {
  const t = toy();
  SS.handle({ session_id: 'codex-1', turn_id: 't1', hook_event_name: 'UserPromptSubmit' }, { CODEX_HOME: t.root }, t.home);
  SS.handle({ session_id: 'codex-1', turn_id: 't1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }, { CODEX_HOME: t.root }, t.home);
  const s = readState(t, 'codex-1');
  assert.ok(!s || s.permission == null, 'Codex no anota permisos');
  assert.deepStrictEqual(C.status(t.opts).stalled, []);
});
