'use strict';
// coordination.test.js — the coordinator's recipe: the guide, /coordinate, the machine status, the signature files and
// opening sessions. Nothing here reads the real HOME: every case builds its own HOME, profile and toy launcher.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const COORD = path.join(ROOT, 'scripts', 'tools', 'coordination.js');
const C = require(COORD);
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const NOW = Date.parse('2026-10-25T14:00:00.000Z');
// A project folder outside the temporary one: a derived name there is a real session, not an internal agent.
const PROJECT = path.join(path.sep, 'srv', 'repos', 'proyecto');
const mins = (n) => NOW - n * 60000;

// A toy machine: HOME with its Claude folder, the pipeline state and a profile outside HOME.
function toy({ profile = {}, machine = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const state = stateDir(home);
  fs.mkdirSync(path.join(state, 'active'), { recursive: true });
  const arnes = path.join(root, 'arnes');
  fs.mkdirSync(arnes);
  fs.writeFileSync(path.join(arnes, 'perfil-equipo.json'), JSON.stringify(profile));
  if (machine) fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify(machine));
  const opts = { home, arnes, env: {}, now: NOW };
  return { root, home, state, arnes, opts };
}

// A session file as Claude Code writes it, alive by default (this process's pid).
function session(t, sid, name, extra = {}) {
  fs.writeFileSync(path.join(t.home, '.claude', 'sessions', `${sid}.json`), JSON.stringify({
    pid: process.pid, sessionId: sid, name, nameSource: 'user', status: 'idle', statusUpdatedAt: mins(20), cwd: t.root, ...extra,
  }));
}
function marker(t, sid, fields) {
  fs.writeFileSync(path.join(t.state, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, stepsPending: [4], lastTouch: new Date(NOW).toISOString(), ...fields }));
}
// Codex's state base with one thread per entry: [id, name, minutes since its last activity].
function codexBase(t, threads) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(t.home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, name TEXT, cwd TEXT, updated_at_ms INTEGER)');
  for (const [id, name, ago] of threads) db.prepare('INSERT INTO threads (id, title, name, cwd, updated_at_ms) VALUES (?, ?, ?, ?, ?)').run(id, 'resumen', name, t.root, mins(ago));
  db.close();
}
// A designation of this machine's coordinator, as `marker.js designate-relay` leaves it in the gates log.
function designate(t, sid) {
  fs.appendFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify({ ts: new Date(NOW).toISOString(), name: 'relay-designation', status: 'ok', sesion: sid, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
}
// A toy launcher: writes the arguments it got and the folder it ran in, and answers as told.
function launcher(t, behavior = 'ok') {
  const script = path.join(t.root, 'launcher.js');
  fs.writeFileSync(script, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(t.root, 'launched.json'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const b = ${JSON.stringify(behavior)};
if (b === 'untrusted') { process.stderr.write('Error: Workspace not trusted. Open it once to trust it.\\n'); process.exit(1); }
if (b === 'error') { process.stderr.write('boom: algo salió mal\\nsegundo renglón\\n'); process.exit(4); }
if (b === 'hang') setTimeout(() => {}, 60000);
if (b === 'killed') process.kill(process.pid, 'SIGKILL');
`);
  return { bin: process.execPath, prefix: [script] };
}
const launched = (t) => { try { return JSON.parse(fs.readFileSync(path.join(t.root, 'launched.json'), 'utf8')); } catch { return null; } };
// The session that calls `open`, as Claude Code leaves it: its id in the environment and its conversation in
// `projects/<folder>/<sid>.jsonl`, with one person's message per permission mode, the last one being the current
// mode. `pad` adds that many bytes of conversation without a mode after them; `mtime` dates the file.
const CALLER_SID = 'coord-sid';
function callerTranscript(t, modes, { sid = CALLER_SID, folder = t.root.replace(/[^A-Za-z0-9-]/g, '-'), pad = 0, mtime = null } = {}) {
  const dir = path.join(claudeDir(t.home), 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  const lines = modes.map((m) => JSON.stringify({ type: 'user', permissionMode: m, message: { content: 'hola' } }));
  if (pad) lines.push(JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(pad) } }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime != null) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}
// The calling session for the opening cases: in bypass unless the case wrote its own conversation.
function caller(t, sid = CALLER_SID) {
  const file = path.join(claudeDir(t.home), 'projects', t.root.replace(/[^A-Za-z0-9-]/g, '-'), `${sid}.jsonl`);
  if (!fs.existsSync(file)) callerTranscript(t, ['bypassPermissions'], { sid });
  return { env: { ...t.opts.env, CLAUDE_CODE_SESSION_ID: sid } };
}

// ── The guide and the command (AC 1-7) ───────────────────────────────────────────────────────────────────────────

const GUIDE = path.join(ROOT, 'guides', 'coordination.md');
const GUIDE_EN = path.join(ROOT, 'guides', 'coordination.en.md');
// What measures each rule of the guide, in the order of its table: a notice, a brake or nobody.
const MEASURES = {
  'Al dueño van firmas, contraseñas y decisiones de producto': 'nadie',
  'Las preguntas de las sesiones van a la coordinadora': 'nadie',
  'La coordinadora cierra los detalles con la opción más segura': 'nadie',
  'Cada sesión con un nombre puesto por una persona': 'aviso',
  'No más sesiones trabajando que el tope': 'freno',
  'Una suite completa por vez': 'freno',
  'Pases adversariales de a uno': 'freno',
  'Las sesiones de fondo quietas se cierran o reciben trabajo': 'aviso',
  'Un pedido listo no queda sin encolar': 'aviso',
  '«Termina» quiere decir funcionando': 'nadie',
  'Confirmar que una firma falta antes de pedirla': 'nadie',
  'Un archivo por firma, borrado al firmar': 'aviso',
  'Pedidos en orden': 'nadie',
  'Avisos cortos y llanos': 'aviso',
  'Codex no coordina': 'aviso',
  'Una firma del dueño en un mensaje aparte': 'nadie',
  'Ensayar lo que viene antes de pasar un comando de firma': 'nadie',
  'El comando de firma con su carpeta': 'nadie',
  'La hora del trabajo terminado': 'nadie',
  'Un número de historia nunca solo': 'nadie',
  'Una pestaña que no pide permisos no firma por la ventana': 'freno',
  'Lo pesado de a uno, con turno': 'nadie',
  'Mirar el diff antes de aprobar un pedido ajeno': 'nadie',
  'Una sesión que espera anota qué hace': 'nadie',
  'Comprobar que un pedido sigue en la cola': 'nadie',
  'Las decisiones del dueño con su contexto': 'nadie',
  'Lo que ve el dueño, sin jerga': 'aviso',
};
const COMMAND = path.join(ROOT, 'commands', 'coordinate.md');
const headings = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^## /.test(l));

test('T1 Guide_HasEveryRuleWithItsMeasure @story-8.122 @ac-1: cada sección de la AC 1 está y cada regla dice aviso, freno o nadie', () => {
  const text = fs.readFileSync(GUIDE, 'utf8');
  const h = headings(GUIDE).join('\n');
  for (const s of [/Qué va al dueño/, /Cómo decide la coordinadora/, /Abrir y nombrar las sesiones/, /El tope/, /pases adversariales/i,
    /Las firmas/, /El orden de los pedidos/, /Las firmas del dueño/, /Los avisos al dueño/, /Qué mide cada regla/]) assert.match(h, s);
  // @story-8.139: una frase no firma nada, así que no hay frase que otra sesión no pueda escribir
  assert.match(text, /no firma nada: el arnés no lee la conversación para\s+firmar/);
  // the measure table: one row per rule, each with a notice, a brake or nobody, and why
  const table = text.split('## Qué mide cada regla')[1] || '';
  const rows = table.split('\n').filter((l) => /^\| /.test(l) && !/^\| Regla/.test(l) && !/^\|---/.test(l));
  assert.ok(rows.length >= 8, `${rows.length} reglas en la tabla`);
  for (const r of rows) assert.match(r, /\| (aviso|freno|nadie) \|/, r);
  // what measures each rule is fixed: a brake that turns into «nobody» (or the reverse) changes what the guide promises
  const measure = Object.fromEntries(rows.map((r) => r.split('|').map((c) => c.trim())).map((c) => [c[1], c[2]]));
  for (const [rule, by] of Object.entries(MEASURES)) assert.strictEqual(measure[rule], by, `«${rule}» la mide ${by}`);
  assert.strictEqual(rows.length, Object.keys(MEASURES).length, 'cada regla de la tabla tiene su medida fijada en la prueba');
  // what was measured goes as a limit; what was not, as the owner's test
  assert.match(text, /cada worktree nuevo pide su propia aprobación/i);
  assert.match(text, /prueba del dueño/);
  assert.match(text, /codex queue/);
});

test('T2 Guide_EnglishMatchesSpanish @story-8.122 @ac-2: mismas secciones, en el mismo orden', () => {
  const es = headings(GUIDE);
  const en = headings(GUIDE_EN);
  assert.strictEqual(en.length, es.length, `${en.join(' / ')}`);
  assert.ok(en.length >= 10);
  const tableRows = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^\| /.test(l)).length;
  assert.strictEqual(tableRows(GUIDE_EN), tableRows(GUIDE));
  // the measure column says the same in both: the English guide keeps the Spanish labels
  const measures = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^\| .* \| (aviso|freno|nadie) \|/.test(l)).map((l) => l.split('|')[2].trim());
  assert.deepStrictEqual(measures(GUIDE_EN), measures(GUIDE));
  assert.deepStrictEqual(measures(GUIDE), Object.values(MEASURES));
});

test('T3 Guide_NoRealNames @story-8.122 @ac-3: el detector de nombres no encuentra nada en la guía, la versión en inglés ni el comando', (t) => {
  const files = [GUIDE, GUIDE_EN, COMMAND];
  // the private list travels only in the team's repo; in the public copy the names part is not measured
  const denied = path.join(ROOT, 'scripts', 'publishing', 'denylist.json');
  if (fs.existsSync(denied)) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publishing', 'detector.js'), '--config', denied, ...files], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  } else t.diagnostic('NO MEDIDO: esta copia no trae la lista privada (scripts/publishing/denylist.json)');
  // no machine paths in any of the three, with or without the private list
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /\/Users\/|C:\\Users\\|\/home\/\w/, f);
  }
});

const coordinate = (t, env) => C.coordinate({ ...t.opts, env: { ...t.opts.env, ...env } });

test('T4 Coordinate_Designated_ShowsStatus @story-8.122 @ac-4: la sesión designada ve el estado con las cinco cosas', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  session(t, 'work-1', 'Una', { status: 'busy' });
  session(t, 'free-1', 'sesion-3a', { nameSource: 'derived', cwd: PROJECT });
  designate(t, 'coord-1');
  const r = coordinate(t, { CLAUDE_CODE_SESSION_ID: 'coord-1' });
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, /Trabajando: 2 de 3/);
  assert.match(r.text, /Esperando/);
  assert.match(r.text, /Pase adversarial en vuelo: ninguno/);
  assert.match(r.text, /Firmas pendientes: 0 por la terminal · 0 por delegación/);
  assert.match(r.text, /Sin nombre puesto por una persona: sesion-3a/);
});

test('T5 Coordinate_NotDesignated_AsksForThePhrase @story-8.122 @ac-5: con el rol y sin designación pide la frase y no designa', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'otra-1', 'Otra', { status: 'busy' });
  const r = coordinate(t, { CLAUDE_CODE_SESSION_ID: 'otra-1' });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /Esta sesión es la coordinadora/);
  assert.match(r.text, /designate-relay/);
  assert.ok(!fs.existsSync(path.join(t.state, 'gates.log')), 'no designa nada');
});

test('T6 Coordinate_NoRole_SaysHowToTurnItOn @story-8.122 @ac-6: sin rol en el perfil, una línea y sale', () => {
  const t = toy();
  const r = coordinate(t, { CLAUDE_CODE_SESSION_ID: 'otra-1' });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.text.trim().split('\n').length, 1, r.text);
  assert.match(r.text, /no usa una coordinadora/);
  assert.match(r.text, /Configuración/);
});

test('T7 Coordinate_Codex_CannotCoordinate @story-8.122 @ac-7: en Codex lo dice y sale', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  const r = coordinate(t, { CODEX_SESSION_ID: 'cdx-1' });
  assert.strictEqual(r.code, 1);
  assert.match(r.text, /Codex no puede coordinar/);
});

// ── The machine status (AC 8-10) ─────────────────────────────────────────────────────────────────────────────────

test('T8 Status_CountsOnlyBusy @story-8.122 @ac-8: dos busy y la de Codex de hace 2 min trabajan; el resto, con su motivo', () => {
  const t = toy({ profile: { coordination: { max_working: 4 } } });
  session(t, 'busy-1', 'Uno', { status: 'busy' });
  session(t, 'busy-2', 'Dos', { status: 'busy' });
  session(t, 'idle-1', 'Tres');
  marker(t, 'idle-1', { storyId: '9.9' });
  session(t, 'idle-2', 'Cuatro');
  codexBase(t, [['cdx-1', 'DeCodex', 2], ['cdx-2', 'CodexQuieto', 10]]);
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.working.map((w) => w.session).sort(), ['DeCodex', 'Dos', 'Uno']);
  const why = Object.fromEntries(s.waiting.map((w) => [w.session, w.why]));
  assert.match(why.Tres, /9\.9/);
  assert.match(why.Cuatro, /sin trabajo/);
  assert.match(why.CodexQuieto, /Codex/);
  assert.deepStrictEqual(s.cap, { value: 4, origin: 'perfil' });
  // the same through the command line, as JSON
  const cli = spawnSync(process.execPath, [COORD, 'status', '--json'], { encoding: 'utf8', input: '',
    env: { PATH: process.env.PATH, HOME: t.home, USERPROFILE: t.home, TYCON_PROFILE: path.join(t.arnes, 'perfil-equipo.json') } });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const j = JSON.parse(cli.stdout);
  assert.strictEqual(j.working.length, 2, 'la de Codex de mentira está fuera de la hora del reloj real');
  assert.deepStrictEqual(j.cap, { value: 4, origin: 'perfil' });
});

test('T8b Status_AdversarialInFlightAndUnnamed @story-8.122 @ac-4: el pase en vuelo sale de los marcadores, y las derived se nombran', () => {
  const t = toy();
  session(t, 'pase-1', 'ConPase', { status: 'busy' });
  marker(t, 'pase-1', { storyId: '7.7', adversarial: { launchedAt: new Date(mins(12)).toISOString(), runId: 'wf_1' } });
  session(t, 'cerro-1', 'Cerro');
  marker(t, 'cerro-1', { storyId: '7.8', adversarial: { launchedAt: new Date(mins(50)).toISOString(), runId: 'wf_2' }, deepReviewDone: true });
  session(t, 'der-1', 'carpeta-9f', { nameSource: 'derived', cwd: PROJECT });
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.adversarial.map((a) => [a.storyId, a.session]), [['7.7', 'ConPase']]);
  assert.deepStrictEqual(s.unnamed, ['carpeta-9f']);
  assert.deepStrictEqual(s.cap, { value: 3, origin: 'sin-valor' });
});

test('T10 Signature_TerminalPath_WritesOnceOrPrints @story-8.122 @ac-10: uno escrito y ejecutable con su pendiente; el segundo no; sin carpeta sólo imprime; done borra los dos', () => {
  const t = toy();
  const folder = path.join(t.root, 'firmas');
  const machine = { coordination: { owner_folder: folder } };
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify(machine));
  const ask = { ...t.opts, kind: 'control-change', title: 'Firmar los controles de la 9.9', cwd: t.root, command: ['node', 'scripts/x.js', 'approve', '--story', '9.9'] };
  const a = C.signature(ask);
  assert.strictEqual(a.wrote, true, a.message);
  const ext = process.platform === 'win32' ? '.cmd' : '.command';
  assert.strictEqual(path.basename(a.file), `2026-10-25-control-change${ext}`);
  const body = fs.readFileSync(a.file, 'utf8');
  assert.match(body, /Firmar los controles de la 9\.9/);
  assert.ok(body.includes(t.root), 'entra a la carpeta');
  assert.match(body, /approve/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(a.file).mode & 0o100, 'es ejecutable');
  assert.strictEqual(C.status(t.opts).signatures.terminal, 1);
  // the same command again: nothing new is written
  const b = C.signature(ask);
  assert.strictEqual(b.wrote, false);
  assert.match(b.message, /ya hay un archivo/);
  assert.strictEqual(fs.readdirSync(folder).length, 1);
  // signature-done removes the file and the pending entry
  const d = C.signatureDone(a.id, t.opts);
  assert.strictEqual(d.ok, true, d.message);
  assert.deepStrictEqual(fs.readdirSync(folder), []);
  assert.strictEqual(C.status(t.opts).signatures.terminal, 0);
  // without a folder: nothing on disk, the command printed for the chat
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), '{}');
  const p = C.signature(ask);
  assert.strictEqual(p.wrote, false);
  assert.strictEqual(p.file, null);
  assert.match(p.message, /node scripts\/x\.js approve --story 9\.9/);
  assert.strictEqual(C.status(t.opts).signatures.terminal, 0);
});

// ── Opening and naming (AC 23-29) ────────────────────────────────────────────────────────────────────────────────

const open = (t, args) => C.open({ ...t.opts, ...caller(t), cwd: t.root, ...args });

test('T24 Open_LaunchesRealSession @story-8.122 @ac-24: llama al lanzador con nombre, carpeta y encargo; devuelve cómo entrar', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'implementá la 9.9', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  const l = launched(t);
  assert.deepStrictEqual(l.argv, ['--bg', '-n', 'n1', '--permission-mode', 'bypassPermissions', '--remote-control', 'n1', '--', 'implementá la 9.9']);
  assert.strictEqual(fs.realpathSync(l.cwd), fs.realpathSync(t.root));
  assert.match(r.message, /claude attach n1/);
  assert.strictEqual(C.status(t.opts).working.some((w) => w.session === 'n1'), true, 'la recién abierta cuenta');
});

test('T25 Open_UntrustedFolder_SaysWhatToDo @story-8.122 @ac-25: carpeta sin aprobar, lanzador ausente, otro error y sin volver: una línea, sin reintentar ni anotar', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t, 'untrusted') });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /aprob/);
  assert.ok(r.message.includes(t.root), 'dice qué carpeta');
  assert.match(r.message, /la abre el dueño/);
  assert.match(r.message, /Mientras tanto, la sesión la abre el dueño y yo le doy el encargo/);
  assert.ok(!fs.existsSync(path.join(t.home, '.claude', 'settings.json')), 'no toca la configuración de la herramienta');
  const fails = [
    open(t, { name: 'n2', task: 'algo', launcher: { bin: path.join(t.root, 'no-esta'), prefix: [] } }),
    open(t, { name: 'n3', task: 'algo', launcher: launcher(t, 'error') }),
    open(t, { name: 'n4', task: 'algo', launcher: launcher(t, 'hang'), timeoutMs: 400 }),
  ];
  assert.match(fails[0].message, /no está instalado/);
  assert.match(fails[1].message, /boom: algo salió mal/);
  assert.doesNotMatch(fails[1].message, /segundo renglón/);
  assert.match(fails[2].message, /no volvió/);
  for (const f of [r, ...fails]) {
    assert.strictEqual(f.ok, false);
    assert.strictEqual(f.message.trim().split('\n').length, 1, f.message);
  }
  assert.deepStrictEqual(C.status(t.opts).working, [], 'ninguna apertura fallida cuenta para el tope');
});

test('T26 Open_AtCap_DoesNotOpen @story-8.122 @ac-26: en el tope no llama al lanzador', () => {
  const t = toy();
  for (const s of ['a', 'b', 'c']) session(t, `busy-${s}`, s, { status: 'busy' });
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /3 trabajando.*tope.*3/);
  assert.strictEqual(launched(t), null);
});

test('T27 Open_BadOrTakenName_DoesNotOpen @story-8.122 @ac-27: un nombre en uso o con caracteres raros no abre', () => {
  const t = toy();
  session(t, 'viva-1', 'Usado');
  for (const name of ['Usado', '../x', 'con espacio', '', 'a;b']) {
    const r = open(t, { name, task: 'algo', launcher: launcher(t) });
    assert.strictEqual(r.ok, false, name);
    assert.match(r.message, name === 'Usado' ? /ya lo usa/ : /letras, números, guion/, name);
  }
  assert.strictEqual(launched(t), null);
});

test('T24b Open_TaskSaysNothingHeavyWithoutTurn: con coordinadora, el encargo dice que lo pesado pide turno; sin ella, queda tal cual', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  assert.ok(open(t, { name: 'n1', task: 'implementá la 9.9', launcher: launcher(t) }).ok);
  assert.match(launched(t).argv.at(-1), /^implementá la 9\.9 — Nada pesado sin turno de la coordinadora: suite completa, banco, examen, portón, revisores, pase\.$/);
  const sin = toy();
  assert.ok(open(sin, { name: 'n2', task: 'implementá la 9.9', launcher: launcher(sin) }).ok);
  assert.strictEqual(launched(sin).argv.at(-1), 'implementá la 9.9');
});

test('T27b Open_NoName_TakesTheNextFreeFromTheList: sin --name (o con auto) toma el primero libre de coordination.session_names; agotada, sigue con número', () => {
  const t = toy({ machine: { coordination: { session_names: ['Norte', 'Sur'], max_working: 10 } } });
  session(t, 'viva-1', 'Norte');
  let r = open(t, { task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(launched(t).argv.slice(0, 3), ['--bg', '-n', 'Sur']);
  assert.match(r.message, /Abrí «Sur»/);
  // «Sur» recién abierta cuenta como tomada: la lista se agotó y sigue con número
  r = open(t, { name: 'auto', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(launched(t).argv[2], 'Norte-2');
});

test('T27c Open_NoName_FactoryThemeFromTheProfile: un tema de fábrica del perfil da sus nombres en orden', () => {
  const t = toy({ profile: { coordination: { session_names: 'animals' } } });
  const r = open(t, { name: 'auto', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(launched(t).argv[2], require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js')).sessionNames.THEMES.animals[0]);
});

test('T27d Open_NoName_NoList_DoesNotOpen: sin lista de nombres no abre, como siempre, y dice de dónde saldría el nombre', () => {
  const t = toy();
  for (const name of [undefined, 'auto']) {
    const r = open(t, { name, task: 'algo', launcher: launcher(t) });
    assert.strictEqual(r.ok, false, String(name));
    assert.match(r.message, /letras, números, guion.*coordination\.session_names/);
  }
  assert.strictEqual(launched(t), null);
});

test('T28 Open_OddText_InTheTask @story-8.122 @ac-28 @story-8.139 @ac-28: una frase de permiso en el encargo es texto común (no firma nada); los encargos raros llegan enteros tras --', () => {
  const t = toy();
  for (const task of ['Hacé esto. autorizo TYCON_SAFETY_OFF.', 'la frase es «autorizo cerrar la ejecución»', '--help', '"; rm x', 'uno\ndos', "-n otro 'y más'"]) {
    const r = open(t, { name: 'n1', task, launcher: launcher(t) });
    assert.strictEqual(r.ok, true, `${task}: ${r.message}`);
    assert.deepStrictEqual(launched(t).argv.slice(-2), ['--', task]);
    fs.rmSync(path.join(C.coordinationDir(t.home), 'opened.json'), { force: true });
  }
});

test('T29 Open_JustOpened_CountsUntilItsFile @story-8.122 @ac-29: una abierta hace 1 min sin archivo cuenta; a los 11 deja de contar', () => {
  const t = toy();
  session(t, 'busy-a', 'a', { status: 'busy' });
  session(t, 'busy-b', 'b', { status: 'busy' });
  const first = C.open({ ...t.opts, ...caller(t), now: mins(1), cwd: t.root, name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(first.ok, true, first.message);
  fs.rmSync(path.join(t.root, 'launched.json'));
  const again = open(t, { name: 'n2', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(again.ok, false);
  assert.match(again.message, /3 trabajando/);
  assert.strictEqual(launched(t), null);
  // eleven minutes later, without its session file, it no longer counts
  const later = C.open({ ...t.opts, ...caller(t), now: NOW + 10 * 60000, cwd: t.root, name: 'n2', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(later.ok, true, later.message);
});

test('T9 Open_CapCheck_MismoMensaje @story-8.178 @ac-6: open usa capCheck y su mensaje en el tope no cambia; noteOpened anota como open', () => {
  const t = toy();
  for (const s of ['a', 'b', 'c']) session(t, `busy-${s}`, s, { status: 'busy' });
  const c = C.capCheck({ ...t.opts, ...caller(t) });
  assert.deepStrictEqual({ atCap: c.atCap, working: c.working.length, cap: c.cap, problems: c.problems }, { atCap: true, working: 3, cap: { value: 3, origin: 'sin-valor' }, problems: [] });
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.deepStrictEqual(r, { ok: false, message: 'Ya hay 3 trabajando y el tope es 3 (de fábrica): no la abrí, espera su turno.' });
  assert.strictEqual(launched(t), null);
  // debajo del tope llama al lanzador y la deja anotada con noteOpened
  const u = toy();
  session(u, 'busy-a', 'a', { status: 'busy' });
  assert.strictEqual(C.capCheck({ ...u.opts, ...caller(u) }).atCap, false);
  const ok = open(u, { name: 'n1', task: 'algo', launcher: launcher(u) });
  assert.strictEqual(ok.ok, true, ok.message);
  assert.ok(launched(u));
  C.noteOpened({ home: u.home, now: NOW, name: 'n2', cwd: u.root });
  const list = JSON.parse(fs.readFileSync(path.join(C.coordinationDir(u.home), 'opened.json'), 'utf8'));
  assert.deepStrictEqual(list.map((o) => o.name), ['n1', 'n2']);
  assert.strictEqual(C.capCheck({ ...u.opts, ...caller(u) }).atCap, true);
});

// ── What the adversarial pass reproduced (regressions) ───────────────────────────────────────────────────────────

test('T8c Status_SkipsInternalAgents @story-8.122 @ac-8: un agente interno (nombre armado, carpeta temporal) no cuenta ni se pide nombrar', () => {
  const t = toy();
  session(t, 'busy-1', 'Uno', { status: 'busy' });
  session(t, 'int-1', 'tmp-adv-xyz', { status: 'busy', nameSource: 'derived', cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'adv-')) });
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.working.map((w) => w.session), ['Uno']);
  assert.deepStrictEqual(s.unnamed, []);
  assert.ok(!s.waiting.some((w) => w.session === 'tmp-adv-xyz'));
});

test('T8d Status_CodexOnlyInteractiveRecentThreads @story-8.122 @ac-8: ni exec, ni subagentes, ni archivados, ni los de hace más de 3 h', () => {
  const t = toy();
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.join(t.home, '.codex'), { recursive: true });
  const db = new DatabaseSync(path.join(t.home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, source TEXT, thread_source TEXT, archived INTEGER, updated_at_ms INTEGER)');
  const add = (id, name, source, ts, archived, ago) => db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(id, name, source, ts, archived, mins(ago));
  add('a', 'Interactiva', 'cli', 'user', 0, 1);
  add('b', 'Quieta', 'vscode', 'user', 0, 30);
  add('c', 'Revisor', 'exec', 'user', 0, 1);
  add('d', 'Sub', '{"subagent":{}}', 'subagent', 0, 1);
  add('e', 'Archivada', 'cli', 'user', 1, 1);
  add('f', 'Vieja', 'cli', 'user', 0, 600);
  db.close();
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.working.map((w) => w.session), ['Interactiva']);
  assert.deepStrictEqual(s.waiting.map((w) => w.session), ['Quieta']);
});

test('T29b Open_JustOpened_CountsEvenIfIdle @story-8.122 @ac-29: abierta hace 1 min con su archivo en idle sigue contando', () => {
  const t = toy();
  session(t, 'busy-a', 'a', { status: 'busy' });
  session(t, 'busy-b', 'b', { status: 'busy' });
  assert.strictEqual(C.open({ ...t.opts, ...caller(t), now: mins(1), cwd: t.root, name: 'n1', task: 'algo', launcher: launcher(t) }).ok, true);
  session(t, 'n1-sid', 'n1');
  const s = C.status(t.opts);
  assert.strictEqual(s.working.length, 3, JSON.stringify(s.working));
  assert.ok(!s.waiting.some((w) => w.session === 'n1'));
});

test('T8e Status_BrokenOpenedFile_IsAProblem @story-8.122 @ac-8: un opened.json roto se dice, no tumba el estado', () => {
  const t = toy();
  fs.mkdirSync(C.coordinationDir(t.home), { recursive: true });
  for (const body of ['{roto', '{"no":"lista"}']) {
    fs.writeFileSync(path.join(C.coordinationDir(t.home), 'opened.json'), body);
    const s = C.status(t.opts);
    assert.ok(s.problems.some((p) => /opened\.json/.test(p)), JSON.stringify(s.problems));
  }
});

test('T8g Status_BadOpenedEntry_IsAProblem @story-8.122 @ac-8: una entrada de opened.json mal formada se dice; una con fecha futura cuenta como recién abierta', () => {
  const t = toy();
  fs.mkdirSync(C.coordinationDir(t.home), { recursive: true });
  const file = path.join(C.coordinationDir(t.home), 'opened.json');
  for (const bad of [{ name: 'n1', at: String(NOW) }, { name: 'n1' }, { at: NOW }, 'n1', null]) {
    fs.writeFileSync(file, JSON.stringify([bad]));
    const s = C.status(t.opts);
    assert.ok(s.problems.some((p) => /opened\.json/.test(p)), `${JSON.stringify(bad)}: ${JSON.stringify(s.problems)}`);
    const r = open(t, { name: 'n2', task: 'algo', launcher: launcher(t) });
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)}: open no abre con el registro dudoso`);
  }
  fs.writeFileSync(file, JSON.stringify([{ name: 'Futura', at: NOW + 3600000 }]));
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.problems, []);
  assert.ok(s.working.some((w) => w.session === 'Futura'), JSON.stringify(s.working));
});

test('T8h Status_CodexWithoutDate_Waits @story-8.122 @ac-8: un hilo de Codex sin fecha de actividad no desaparece', () => {
  const t = toy();
  codexBase(t, []);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(t.home, '.codex', 'state_5.sqlite'));
  db.prepare('INSERT INTO threads (id, title, name, cwd, updated_at_ms) VALUES (?, ?, ?, ?, NULL)').run('cdx-9', 'resumen', 'SinFecha', t.root);
  db.close();
  const s = C.status(t.opts);
  const w = s.waiting.find((x) => x.session === 'SinFecha');
  assert.ok(w, JSON.stringify(s));
  assert.match(w.why, /sin fecha de actividad/);
});

test('T25b Open_MissingFolder_SaysSo @story-8.122 @ac-25: una carpeta que no existe no se confunde con el lanzador ausente', () => {
  const t = toy();
  const r = C.open({ ...t.opts, ...caller(t), cwd: path.join(t.root, 'no-existe'), name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /no existe/);
  assert.doesNotMatch(r.message, /no está instalado/);
});

test('T10b Signature_WindowsFileKeepsTextLiteral @story-8.122 @ac-10: en el .cmd, & | < > % del título y del comando no se interpretan', () => {
  const body = C.signatureBody({ title: 'a & b | c > d %X%', cwd: 'C:\\x y', command: ['node', 'x.js', '--quote', '100% «ok» & listo'], windows: true });
  const lines = body.split('\r\n');
  const echo = lines.find((l) => /^echo /.test(l) && l !== 'echo.');
  assert.match(echo, /\^&/); assert.match(echo, /\^\|/); assert.match(echo, /\^>/); assert.match(echo, /%%X%%/);
  assert.ok(lines.some((l) => l.includes('"100%% «ok» & listo"')), body);
});

test('T10c Signature_IdNeverRepeatsAPending @story-8.122 @ac-10: si el archivo de una pendiente ya no está, la nueva no reusa su id', () => {
  const t = toy();
  const folder = path.join(t.root, 'firmas');
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify({ coordination: { owner_folder: folder } }));
  const base = { ...t.opts, kind: 'control-change', title: 'Firmar', cwd: t.root };
  const a = C.signature({ ...base, command: ['node', 'a.js'] });
  fs.rmSync(a.file);
  const b = C.signature({ ...base, command: ['node', 'b.js'] });
  assert.strictEqual(b.wrote, true, b.message);
  assert.notStrictEqual(b.id, a.id);
});

// ── What the reviewers found (regressions) ──────────────────────────────────────────────────────────────────────────

const POSIX_PERMS = { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'permisos POSIX de un usuario común' : false };
const withFolder = (t) => {
  const folder = path.join(t.root, 'firmas');
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), JSON.stringify({ coordination: { owner_folder: folder } }));
  return { folder, base: { ...t.opts, kind: 'control-change', title: 'Firmar', cwd: t.root } };
};

test('T10d Signature_LineBreakInCommand_Refused @story-8.122 @ac-10: un salto de línea en el comando o la carpeta no llega al archivo', () => {
  const t = toy();
  const { folder, base } = withFolder(t);
  for (const r of [C.signature({ ...base, command: ['git', 'a\ncalc.exe'] }), C.signature({ ...base, cwd: `${t.root}\r\nx`, command: ['node', 'a.js'] })]) {
    assert.strictEqual(r.wrote, false, r.message);
    assert.match(r.message, /salto de línea/);
  }
  assert.ok(!fs.existsSync(folder) || fs.readdirSync(folder).length === 0);
});

test('T10e Signature_DoneOnlyDeletesItsOwnFile @story-8.122 @ac-10: una pendiente que apunta afuera de la carpeta de firmas no borra nada', () => {
  const t = toy();
  withFolder(t);
  const victim = path.join(t.root, 'importante.txt');
  fs.writeFileSync(victim, 'no borrar');
  fs.mkdirSync(C.coordinationDir(t.home), { recursive: true });
  fs.writeFileSync(path.join(C.coordinationDir(t.home), 'signatures.json'), JSON.stringify([{ id: 'x', key: 'k', file: victim }]));
  const r = C.signatureDone('x', t.opts);
  assert.strictEqual(r.ok, false);
  assert.ok(fs.existsSync(victim));
});

test('T10f Signature_DanglingLink_NotFollowed @story-8.122 @ac-10: un enlace roto con el nombre de la firma no se sigue', { skip: process.platform === 'win32' ? 'enlaces en Windows' : false }, () => {
  const t = toy();
  const { folder, base } = withFolder(t);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(t.root, 'destino.sh');
  const d = new Date(NOW);
  const first = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-control-change.command`;
  fs.symlinkSync(target, path.join(folder, first));
  const r = C.signature({ ...base, now: NOW, command: ['node', 'a.js'] });
  assert.strictEqual(r.wrote, true, r.message);
  assert.ok(!fs.existsSync(target), 'no escribió a través del enlace');
  assert.notStrictEqual(path.basename(r.file), first);
});

test('T10g Signature_ControlCharsStripped @story-8.122 @ac-10: los caracteres de control del título y de un nombre de Codex no llegan a la pantalla', () => {
  const body = C.signatureBody({ title: 'a\x1b[2Jb\x07c', cwd: '/x', command: ['node', 'a.js'], windows: false });
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(body.replace(/\n/g, '')), JSON.stringify(body));
  const t = toy();
  codexBase(t, [['c1', `Codex\x1b[31m ${'x'.repeat(100)}`, 1]]);
  const text = C.statusText(C.status(t.opts));
  assert.ok(!text.includes('\x1b'));
  assert.ok(text.split('\n').every((l) => l.length < 120), text);
});

test('T26b Open_NameStartsWithLetterOrNumber @story-8.122 @ac-27: un nombre que empieza con guion no se pasa como bandera', () => {
  const t = toy();
  const r = open(t, { name: '-p', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(launched(t), null);
});

test('T8f Status_UnreadableFolders_AreProblems @story-8.122 @ac-8: la carpeta de Codex o la de marcadores sin permiso se dicen, no cuentan como vacías', POSIX_PERMS, () => {
  const t = toy();
  codexBase(t, [['c1', 'Una', 1]]);
  const codex = path.join(t.home, '.codex');
  const active = path.join(t.state, 'active');
  fs.chmodSync(codex, 0o000);
  fs.chmodSync(active, 0o000);
  try {
    const s = C.status(t.opts);
    assert.ok(s.problems.some((p) => /Codex/.test(p)), JSON.stringify(s.problems));
    assert.ok(s.problems.some((p) => /marcador/.test(p)), JSON.stringify(s.problems));
  } finally { fs.chmodSync(codex, 0o755); fs.chmodSync(active, 0o755); }
});

test('T29c Open_UnreadableState_Refuses @story-8.122 @ac-29: con la configuración o una sesión ilegible no abre (no sabe el tope ni los nombres)', () => {
  const t = toy();
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), '{roto');
  const a = open(t, { name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(a.ok, false, a.message);
  assert.match(a.message, /no la abrí/);
  const u = toy();
  fs.writeFileSync(path.join(u.home, '.claude', 'sessions', 'rota.json'), '{roto');
  const b = open(u, { name: 'n1', task: 'algo', launcher: launcher(u) });
  assert.strictEqual(b.ok, false, b.message);
  assert.strictEqual(launched(t), null);
  assert.strictEqual(launched(u), null);
});

test('T10h Signature_BrokenFiles_SaySo @story-8.122 @ac-10: con la configuración o el registro roto lo dice, no tira ni confunde con «sin carpeta»', () => {
  const t = toy();
  fs.writeFileSync(path.join(t.home, '.claude', 'tycon.json'), '{roto');
  const a = C.signature({ ...t.opts, kind: 'control-change', title: 'Firmar', cwd: t.root, command: ['node', 'a.js'] });
  assert.strictEqual(a.wrote, false);
  assert.match(a.message, /configuración/);
  const u = toy();
  const { base } = withFolder(u);
  fs.mkdirSync(C.coordinationDir(u.home), { recursive: true });
  fs.writeFileSync(path.join(C.coordinationDir(u.home), 'signatures.json'), '{roto');
  const b = C.signature({ ...base, command: ['node', 'a.js'] });
  assert.strictEqual(b.wrote, false);
  assert.match(b.message, /signatures\.json/);
  assert.strictEqual(C.signatureDone('x', u.opts).ok, false);
  fs.writeFileSync(path.join(C.coordinationDir(u.home), 'signatures.json'), '{"a":1}');
  const s = C.status(u.opts);
  assert.strictEqual(s.signatures.terminal, 0);
  assert.ok(s.problems.some((p) => /signatures\.json/.test(p)), JSON.stringify(s.problems));
});

test('T10i Signature_SameCommandFileWithoutRegistry @story-8.122 @ac-10: perdido el registro, el archivo de la carpeta con el mismo comando sigue contando', () => {
  const t = toy();
  const { base } = withFolder(t);
  const a = C.signature({ ...base, command: ['node', 'a.js', '--x'] });
  fs.rmSync(path.join(C.coordinationDir(t.home), 'signatures.json'));
  const b = C.signature({ ...base, command: ['node', 'a.js', '--x'] });
  assert.strictEqual(b.wrote, false, b.message);
  assert.strictEqual(b.file, a.file);
});

test('T29d Open_NotRecorded_SaysSo @story-8.122 @ac-29: si la sesión abrió pero no se pudo anotar, lo dice', POSIX_PERMS, () => {
  const t = toy();
  const dir = C.coordinationDir(t.home);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  try {
    const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t) });
    assert.strictEqual(r.ok, true, r.message);
    assert.match(r.message, /no la pude anotar/);
  } finally { fs.chmodSync(dir, 0o755); }
});

test('T25c Open_LauncherKilled_SaysTheSignal @story-8.122 @ac-25: un lanzador que muere por una señal lo dice', { skip: process.platform === 'win32' ? 'señales POSIX' : false }, () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t, 'killed') });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /SIGKILL/);
  assert.doesNotMatch(r.message, /null/);
});

// ── Opening in a fixed work slot ─────────────────────────────────────────────────────────────────────────────────

const WS = require(path.join(ROOT, 'scripts', 'tools', 'work-slots.js'));
// Pinned dates and no background maintenance: the toy commits are the same on every run.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
function gitToy(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// A repo cloned from its own origin, with one commit on main, inside the toy machine's folder.
function toyRepo(t) {
  const origin = path.join(t.root, 'origin.git');
  gitToy(t.root, 'init', '--bare', origin);
  const repo = path.join(fs.realpathSync(t.root), 'src', 'proyecto');
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  gitToy(t.root, 'clone', '-q', origin, repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\n');
  gitToy(repo, 'add', 'a.txt');
  gitToy(repo, 'commit', '-q', '-m', 'uno');
  gitToy(repo, 'push', '-q', 'origin', 'HEAD:main');
  return repo;
}
const slotOf = (repo, n) => path.join(path.dirname(repo), `${path.basename(repo)}--slot-${n}`);
const branchIn = (dir) => spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

test('T40 Open_WithRepo_TakesAFreeSlot: con el repo, abre la sesión en un puesto libre, en la rama del trabajo, y le dice cómo soltarlo', () => {
  const t = toy({ profile: { coordination: { max_working: 2 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'implementá la 9.9', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  const l = launched(t);
  assert.strictEqual(fs.realpathSync(l.cwd), slotOf(repo, 1));
  assert.strictEqual(branchIn(slotOf(repo, 1)), 'wt/n1');
  assert.match(l.argv[l.argv.length - 1], /^implementá la 9\.9/);
  assert.match(l.argv[l.argv.length - 1], /work-slots\.js" release "/, 'el encargo dice cómo soltar el puesto');
  assert.ok(r.message.includes(slotOf(repo, 1)), r.message);
  const b = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, name: 'n2', branch: 'feat/x', task: 'otra', launcher: launcher(t) });
  assert.strictEqual(b.ok, true, b.message);
  assert.strictEqual(branchIn(slotOf(repo, 2)), 'feat/x');
});

test('T40b Open_WithRepo_NoName_SkipsNamesWithABranch: con el repo y sin nombre, un nombre que ya tiene rama wt/<nombre> no se reusa', () => {
  const t = toy({ profile: { coordination: { max_working: 3, session_names: ['Norte', 'Sur'] } } });
  const repo = toyRepo(t);
  gitToy(repo, 'branch', 'wt/norte');
  const r = C.open({ ...t.opts, ...caller(t), repo, task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(launched(t).argv[2], 'Sur');
  assert.strictEqual(branchIn(slotOf(repo, 1)), 'wt/Sur');
  // con --branch la rama es otra y el primero sigue libre
  const b = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, branch: 'feat/y', task: 'otra', launcher: launcher(t) });
  assert.strictEqual(b.ok, true, b.message);
  assert.strictEqual(launched(t).argv[2], 'Norte');
});

test('T40c Open_OneAtATime: con otra apertura en curso espera su turno; si no se suelta, no abre; un candado viejo se descarta', () => {
  const t = toy({ machine: { coordination: { session_names: ['Norte', 'Sur'] } } });
  const lock = path.join(stateDir(t.home), 'coordination-open.lock');
  fs.mkdirSync(lock, { recursive: true });
  const r = open(t, { task: 'algo', launcher: launcher(t), lockWaitMs: 300 });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Otra apertura de sesión sigue en curso/);
  assert.strictEqual(launched(t), null);
  // un candado de hace meses: más viejo que cualquier apertura viva
  const viejo = new Date('2026-01-01T00:00:00.000Z');
  fs.utimesSync(lock, viejo, viejo);
  const r2 = open(t, { task: 'algo', launcher: launcher(t), lockWaitMs: 300 });
  assert.strictEqual(r2.ok, true, r2.message);
  assert.ok(!fs.existsSync(lock), 'suelta el candado al terminar');
});

test('T41 Open_WithRepo_NoFreeSlot_DoesNotOpen: sin puesto libre lo dice y no llama al lanzador', () => {
  const t = toy({ profile: { coordination: { max_working: 1 } } });
  const repo = toyRepo(t);
  assert.strictEqual(WS.take({ ...t.opts, repo, branch: 'feat/ocupa' }).ok, true);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /no hay puesto libre/);
  assert.match(r.message, /no la abrí/);
  assert.strictEqual(launched(t), null);
});

test('T42 Open_WithRepo_LaunchFails_FreesTheSlot: si el lanzador falla, el puesto vuelve a quedar libre y la rama nueva no queda', () => {
  const t = toy({ profile: { coordination: { max_working: 1 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: launcher(t, 'error') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(WS.list({ ...t.opts, repo }).slots[0].free, true);
  assert.strictEqual(gitToy(repo, 'branch', '--list', 'wt/n1'), '');
});

test('T43 Open_RepoAndCwd_Refuses: carpeta y repo a la vez es ambiguo: no la abre', () => {
  const t = toy();
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, cwd: t.root, name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /o la carpeta o el repo/);
  assert.strictEqual(launched(t), null);
});

// ── The opened session starts like the one that opens it ─────────────────────────────────────────────────────

const openAs = (t, env, args = {}) => C.open({ ...t.opts, env: { ...t.opts.env, ...env }, cwd: t.root, name: 'n1', task: 'algo', launcher: launcher(t), ...args });
const before = (argv, flag) => argv.indexOf(flag) !== -1 && argv.indexOf(flag) < argv.indexOf('--');

test('8.177 T1 Open_ModoBypass_LoPasaAlLanzador @story-8.177 @ac-1 @ac-5: en bypass, la sesión nueva arranca en bypass y con control remoto a su nombre', () => {
  const t = toy();
  callerTranscript(t, ['bypassPermissions']);
  const r = openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID });
  assert.strictEqual(r.ok, true, r.message);
  const { argv } = launched(t);
  assert.deepStrictEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'bypassPermissions']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('--remote-control'), argv.indexOf('--remote-control') + 2), ['--remote-control', 'n1']);
  assert.ok(before(argv, '--permission-mode') && before(argv, '--remote-control'), argv.join(' '));
  assert.deepStrictEqual(argv.slice(-2), ['--', 'algo']);
});

test('8.177 T2 Open_ModoDefault_NoPasaModo @story-8.177 @ac-2 @ac-5: en el modo por defecto no pasa modo (el lanzador ya arranca así), pero sí el control remoto', () => {
  const t = toy();
  callerTranscript(t, ['default']);
  const r = openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID });
  assert.strictEqual(r.ok, true, r.message);
  const { argv } = launched(t);
  assert.ok(!argv.includes('--permission-mode'), argv.join(' '));
  assert.ok(before(argv, '--remote-control'), argv.join(' '));
});

test('8.177 T3 Open_ModoCambiado_ValeElUltimo @story-8.177 @ac-3: si el modo cambió durante la sesión, vale el último', () => {
  const t = toy();
  callerTranscript(t, ['bypassPermissions', 'default', 'auto']);
  const r = openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID });
  assert.strictEqual(r.ok, true, r.message);
  const { argv } = launched(t);
  assert.strictEqual(argv[argv.indexOf('--permission-mode') + 1], 'auto');
});

function refuses(t, r, what) {
  assert.strictEqual(r.ok, false, `${what}: ${r.message}`);
  assert.match(r.message, /modo de permisos/, what);
  assert.match(r.message, /no la abrí/, what);
  assert.strictEqual(r.message.trim().split('\n').length, 1, what);
  assert.strictEqual(launched(t), null, `${what}: no llamó al lanzador`);
}

test('8.177 T4a Open_SinSid_NoAbre @story-8.177 @ac-4: sin id de la sesión que llama, o con uno que no entra en una ruta, no abre', () => {
  const t = toy();
  callerTranscript(t, ['bypassPermissions']);
  refuses(t, openAs(t, {}), 'sin sid');
  refuses(t, openAs(t, { CLAUDE_CODE_SESSION_ID: `../${CALLER_SID}` }), 'sid con ../');
});

test('8.177 T4b Open_SinTranscripcion_NoAbre @story-8.177 @ac-4: un id sin conversación guardada no abre', () => {
  const t = toy();
  refuses(t, openAs(t, { CLAUDE_CODE_SESSION_ID: 'nadie' }), 'sin transcripción');
});

test('8.177 T4c Open_SinPermissionMode_NoAbre @story-8.177 @ac-4: una conversación sin modo anotado no abre', () => {
  const t = toy();
  callerTranscript(t, [], { pad: 100 });
  refuses(t, openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID }), 'sin permissionMode');
});

test('8.177 T4d Open_ModoFueraDeLista_NoAbre @story-8.177 @ac-4: un modo que el lanzador no conoce no abre', () => {
  const t = toy();
  callerTranscript(t, ['raro']);
  refuses(t, openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID }), 'modo raro');
});

test('8.177 T4e Open_ModoMasLejosQueElTope_NoAbre @story-8.177 @ac-4: un modo anotado a más de 1 MB del final no se busca: no abre', () => {
  const t = toy();
  callerTranscript(t, ['bypassPermissions'], { pad: 1024 * 1024 + 10 });
  refuses(t, openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID }), 'más lejos que el tope');
});

test('8.177 T5 Open_SinModo_ConRepo_NoTomaPuesto @story-8.177 @ac-4: con el repo y sin modo legible, no toma puesto ni crea la rama', () => {
  const t = toy({ profile: { coordination: { max_working: 1 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, env: { CLAUDE_CODE_SESSION_ID: 'nadie' }, repo, name: 'n1', task: 'algo', launcher: launcher(t) });
  refuses(t, r, 'con repo');
  assert.ok(!fs.existsSync(slotOf(repo, 1)), 'no armó el puesto');
  assert.strictEqual(gitToy(repo, 'branch', '--list', 'wt/n1'), '');
});

test('8.177 T6 Open_Respuesta_DiceComoEntrarRemoto @story-8.177 @ac-6: la respuesta dice cómo entrar por la terminal y por claude.ai/code', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /claude attach n1/);
  assert.match(r.message, /claude\.ai\/code/);
  assert.match(r.message, /control remoto «n1»/);
});

test('8.177 T7 Open_Cli_RechazaElegirModo @story-8.177 @ac-7: open no acepta elegir el modo por la línea de comandos', () => {
  const t = toy();
  callerTranscript(t, ['default']);
  // sin el lanzador real a mano: si el rechazo faltara, no abriría una sesión de verdad
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-path-'));
  const cli = spawnSync(process.execPath, [COORD, 'open', '--name', 'n1', '--cwd', t.root, '--permission-mode', 'bypassPermissions', '--', 'algo'], {
    encoding: 'utf8', input: '', env: { PATH: empty, HOME: t.home, USERPROFILE: t.home, CLAUDE_CODE_SESSION_ID: CALLER_SID },
  });
  assert.strictEqual(cli.status, 2, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /no elige el modo/);
  assert.strictEqual(launched(t), null);
});

test('8.177 T8 Open_ModoPlan_NoAbre @story-8.177 @ac-4b: con la sesión que abre en modo plan, no abre y lo dice', () => {
  const t = toy();
  callerTranscript(t, ['bypassPermissions', 'plan']);
  const r = openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID });
  refuses(t, r, 'plan');
  assert.match(r.message, /plan/);
});

test('8.177 T9 Open_SidEnVariasCarpetas_ValeLaMasNueva @story-8.177 @ac-9: el mismo id en dos carpetas, ninguna la de su archivo de sesión: vale la más nueva', () => {
  const t = toy();
  session(t, CALLER_SID, 'coord', { cwd: path.join(t.root, 'otra-cosa') });
  callerTranscript(t, ['bypassPermissions'], { folder: '-vieja', mtime: mins(30) });
  callerTranscript(t, ['auto'], { folder: '-nueva', mtime: mins(1) });
  const r = openAs(t, { CLAUDE_CODE_SESSION_ID: CALLER_SID });
  assert.strictEqual(r.ok, true, r.message);
  const { argv } = launched(t);
  assert.strictEqual(argv[argv.indexOf('--permission-mode') + 1], 'auto');
});

test('8.177 T10 Guia_DiceQueOpenCopiaElModo_YSuLimite @story-8.177 @ac-8: las dos guías dicen que open copia el modo, con su límite', () => {
  for (const [file, gone] of [[GUIDE, /Hasta que `open` lo haga solo/], [GUIDE_EN, /Until `open` does it/]]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, gone, file);
    assert.match(text, /--permission-mode/, file);
    assert.match(text, /--remote-control/, file);
    assert.match(text, /Shift\+Tab/, file);
  }
});
