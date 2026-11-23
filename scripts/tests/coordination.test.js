'use strict';
// coordination.test.js — the coordinator's recipe: the guide, /coordinate, the machine status, the signature files and
// opening sessions. Nothing here reads the real HOME: every case builds its own HOME, profile and toy launcher.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process'); // spawn: un proceso vivo ajeno (T47)

const ROOT = path.join(__dirname, '..', '..');
const COORD = path.join(ROOT, 'scripts', 'tools', 'coordination.js');
const C = require(COORD);
const { stateDir, claudeDir } = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

const NOW = Date.parse('2026-10-25T14:00:00.000Z');
// A project folder outside the temporary one: a derived name there is a real session, not an internal agent.
const PROJECT = path.join(path.sep, 'srv', 'repos', 'proyecto');
const mins = (n) => NOW - n * 60000;
// espera sin ceder el turno: el registro de git va por segundos, y un caso necesita dos momentos distintos
const esperar = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
  // an empty repos root: without it the review count (scripts/lib/review-load.js) walks the real repos next to the harness clone
  const repos = path.join(root, 'repos');
  fs.mkdirSync(repos);
  const opts = { home, arnes, env: { TYCON_REPOS_ROOT: repos }, now: NOW };
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
  'Al dueño van firmas, contraseñas, decisiones de producto y lo que sale de la casa': 'nadie',
  'Las preguntas de las sesiones van a la coordinadora': 'nadie',
  'La coordinadora cierra los detalles con la opción más segura': 'nadie',
  'Cada sesión con un nombre puesto por una persona': 'aviso',
  'No más sesiones trabajando que el tope': 'freno',
  'No abrir más cuando lo que espera la revisión de la persona llega a su tope': 'aviso',
  'Con la fila de la suite larga no se abren sesiones para programar': 'nadie',
  'Una suite completa por vez': 'freno',
  'Pases adversariales de a uno': 'freno',
  'Las sesiones de fondo quietas se cierran o reciben trabajo': 'aviso',
  'Una sesión se cierra sin nada pendiente': 'freno',
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
  'Un arreglo rápido con pantalla lleva maqueta y captura': 'freno',
  'Lo pesado de a uno, con turno': 'nadie',
  'Mirar el diff antes de aprobar un pedido ajeno': 'nadie',
  'Una sesión que espera anota qué hace': 'nadie',
  'Comprobar que un pedido sigue en la cola': 'nadie',
  'Las decisiones del dueño con su contexto': 'nadie',
  'Lo que ve el dueño, sin jerga': 'aviso',
  'La guía llega sola a la coordinadora': 'aviso',
  'La coordinadora no aprueba lo que le da más poder': 'nadie',
  'Las sesiones no se escriben entre sí': 'nadie',
  'Una sesión no abre un cuadro en su pestaña': 'nadie',
  'Una sesión trabada se avisa con la respuesta recomendada': 'aviso',
  'Preguntarle a la sesión antes de decir «te toca»': 'nadie',
  '«Te toca» sólo para lo que se puede hacer ahora': 'nadie',
  'Cada pedido al dueño viene completo': 'nadie',
  'Preguntarle a la sesión cuando el dueño pregunta cómo va': 'nadie',
  'Mirar la sesión que pasó el doble de lo que dijo': 'nadie',
  'Dimensionar antes de asignar': 'nadie',
  'Una sesión que termina recibe trabajo o se cierra': 'aviso',
  'Una sesión que espera recibe lo liviano': 'aviso',
  'Con lugar, memoria y trabajo listo, la coordinadora no cierra su turno': 'freno',
  'Un rojo no se deja': 'nadie',
  'No aflojar una revisión, no hacer papeleo': 'nadie',
  'Comprobar un mensaje para el equipo': 'nadie',
  'La coordinadora no cambia código ni guías ella misma': 'freno',
  'Un plan para el dueño pasa antes por un revisor aparte': 'nadie',
  'Afirmar sólo lo comprobado, y medir el uso antes de sacar algo': 'nadie',
  'Medir un cambio de velocidad en un día con carga': 'nadie',
  'El cuadro de una pregunta lleva el contexto adentro': 'nadie',
  'La constancia de un cambio de control, al final': 'nadie',
  'Las historias se cierran en horas': 'nadie',
  'Primero lo que traba a todos, después el plan del producto': 'nadie',
  'Cada pendiente con quién lo tiene y en qué pedido': 'nadie',
  'Un solo empuje por pedido': 'nadie',
  'Nunca cerrar un turno con «¿seguimos?»': 'nadie',
  'Con el dueño ausente no se abre un cuadro': 'nadie',
  'Preguntarle al dueño antes de correr la firma de otra sesión': 'nadie',
  'La constancia, con la carpeta quieta': 'nadie',
  'La constancia, con el guion de la copia instalada': 'nadie',
};
const COMMAND = path.join(ROOT, 'commands', 'coordinate.md');
const headings = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^## /.test(l));

test('T1 Guide_HasEveryRuleWithItsMeasure @story-8.122 @ac-1: cada sección de la AC 1 está y cada regla dice aviso, freno o nadie', () => {
  const text = fs.readFileSync(GUIDE, 'utf8');
  const h = headings(GUIDE).join('\n');
  for (const s of [/Qué va al dueño/, /Cómo decide la coordinadora/, /Abrir y nombrar las sesiones/, /El tope/, /pases adversariales/i,
    /Las firmas/, /El orden de los pedidos/, /Las firmas del dueño/, /Los avisos al dueño/, /Qué mide cada regla/]) assert.match(h, s);
  // lo que otra sesión puede escribir no firma: vale sólo el «aprobado» que tipea la persona (owner-approvals.js)
  assert.match(text, /Un encargo o un mensaje entre sesiones no firma nada, aunque diga «aprobado»/);
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
  assert.match(r.text, /Turno de tarea pesada: libre/);
  assert.match(r.text, /Firmas pendientes: 0 por la terminal · 0 por delegación/);
  assert.match(r.text, /Sin nombre puesto por una persona: sesion-3a/);
});

test('T5 Coordinate_NotDesignated_AsksForThePhrase @story-8.122 @ac-5: con el rol y sin designación pide la frase y no designa', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'otra-1', 'Otra', { status: 'busy' });
  const r = coordinate(t, { CLAUDE_CODE_SESSION_ID: 'otra-1' });
  assert.strictEqual(r.code, 1);
  // el camino es el click; la frase queda de respaldo
  assert.match(r.text, /designate-relay\n/);
  assert.match(r.text, /el dueño hace click/);
  assert.match(r.text, /withdraw-relay/);
  assert.doesNotMatch(r.text, /«Esta sesión es la coordinadora»/);
  assert.ok(!fs.existsSync(path.join(t.state, 'gates.log')), 'no designa nada');
});

test('T6 Coordinate_NoRole_SaysHowToTurnItOn @story-8.122 @ac-6 @story-8.199 @ac-5: sin rol en el perfil, en otra sesión, dice cómo designarla', () => {
  const t = toy();
  const r = coordinate(t, { CLAUDE_CODE_SESSION_ID: 'otra-1' });
  assert.strictEqual(r.code, 1);
  assert.doesNotMatch(r.text, /no usa una coordinadora/);
  assert.match(r.text, /Esta sesión es la coordinadora/);
  assert.match(r.text, /designate-relay/);
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

test('T8d Status_SuiteQueue_FromWaitingNotes: la fila de la suite sale de las esperas anotadas de suite, portón o turno, de las vivas, en orden', () => {
  // 🔴 mutación: leer la espera sin mirar qué espera (entra Otra), o sin mirar si la sesión está viva (entra Cerrada)
  const t = toy();
  const doing = path.join(t.state, 'doing');
  fs.mkdirSync(doing, { recursive: true });
  const note = (sid, waitingFor, minutesAgo) => fs.writeFileSync(path.join(doing, `${sid}.json`),
    JSON.stringify({ text: 'implementar la historia', at: new Date(mins(minutesAgo)).toISOString(), waitingFor, waitingSince: new Date(mins(minutesAgo)).toISOString() }));
  session(t, 's-1', 'Uno'); note('s-1', 'Turno de la suite completa', 10);
  session(t, 's-2', 'Dos', { status: 'busy' }); note('s-2', 'que me den el portón', 40);
  session(t, 's-3', 'Otra'); note('s-3', 'que el dueño conteste', 60);
  session(t, 's-4', 'Cerrada', { pid: 999999 }); note('s-4', 'turno de suite', 90);
  session(t, 's-5', 'SinNota');
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.suiteWaiting.map((w) => [w.session, w.since]).sort((a, b) => a[1] - b[1]), [['Dos', mins(40)], ['Uno', mins(10)]]);
  assert.strictEqual(s.suite, null);
  // sin ninguna espera anotada, la línea del estado no sale
  for (const sid of ['s-1', 's-2']) fs.unlinkSync(path.join(doing, `${sid}.json`));
  assert.ok(!/Esperando turno de suite/.test(C.statusText(C.status(t.opts))));
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
  const r = C.open({ ...t.opts, ...caller(t), repo, slot: true, name: 'n1', task: 'implementá la 9.9', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  const l = launched(t);
  assert.strictEqual(fs.realpathSync(l.cwd), slotOf(repo, 1));
  assert.strictEqual(branchIn(slotOf(repo, 1)), 'wt/n1');
  assert.match(l.argv[l.argv.length - 1], /^implementá la 9\.9/);
  assert.match(l.argv[l.argv.length - 1], /work-slots\.js" release "/, 'el encargo dice cómo soltar el puesto');
  assert.ok(r.message.includes(slotOf(repo, 1)), r.message);
  const b = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, slot: true, name: 'n2', branch: 'feat/x', task: 'otra', launcher: launcher(t) });
  assert.strictEqual(b.ok, true, b.message);
  assert.strictEqual(branchIn(slotOf(repo, 2)), 'feat/x');
});

test('T40b Open_WithRepo_NoName_SkipsNamesWithABranch: con el repo y sin nombre, un nombre que ya tiene rama wt/<nombre> no se reusa', () => {
  const t = toy({ profile: { coordination: { max_working: 3, session_names: ['Norte', 'Sur'] } } });
  const repo = toyRepo(t);
  gitToy(repo, 'branch', 'wt/norte');
  const r = C.open({ ...t.opts, ...caller(t), repo, slot: true, task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(launched(t).argv[2], 'Sur');
  assert.strictEqual(branchIn(slotOf(repo, 1)), 'wt/Sur');
  // con --branch la rama es otra y el primero sigue libre
  const b = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, slot: true, branch: 'feat/y', task: 'otra', launcher: launcher(t) });
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
  const r = C.open({ ...t.opts, ...caller(t), repo, slot: true, name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /no hay puesto libre/);
  assert.match(r.message, /no la abrí/);
  assert.strictEqual(launched(t), null);
});

test('T42 Open_WithRepo_LaunchFails_FreesTheSlot: si el lanzador falla, el puesto vuelve a quedar libre y la rama nueva no queda', () => {
  const t = toy({ profile: { coordination: { max_working: 1 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, slot: true, name: 'n1', task: 'algo', launcher: launcher(t, 'error') });
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

// ── Closing a session ────────────────────────────────────────────────────────────────────────────────────────────────

const COORD_SID = 'coord-close';
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim();
// A repo with its origin (a local bare one) and main pushed, plus the toy machine with its coordinator.
function closeLab() {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  designate(t, COORD_SID);
  const origin = path.join(t.root, 'origin.git');
  const repo = path.join(t.root, 'repo');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'a@b');
  git(repo, 'config', 'user.name', 'a');
  git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  return { ...t, repo, closeOpts: { ...t.opts, env: { CLAUDE_CODE_SESSION_ID: COORD_SID } } };
}
function commitIn(dir, file = 'b.txt') {
  fs.writeFileSync(path.join(dir, file), 'y\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'trabajo');
}
const bg = (t, name, cwd, extra = {}) => session(t, `sid-${name}`, name, { cwd, kind: 'bg', jobId: `job-${name}`, startedAt: 1000, ...extra });
// A toy launcher that keeps every call and answers as told, by verb.
function closer(t, fail = {}) {
  const script = path.join(t.root, 'closer.js');
  fs.writeFileSync(script, `
const fs = require('fs');
const [verb, id] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(t.root, 'closed.log'))}, verb + ' ' + id + '\\n');
const f = ${JSON.stringify(fail)};
if (f[verb]) { process.stderr.write(f[verb] + '\\n'); process.exit(1); }
`);
  return { bin: process.execPath, prefix: [script] };
}
const closed = (t) => { try { return fs.readFileSync(path.join(t.root, 'closed.log'), 'utf8').trim().split('\n'); } catch { return []; } };
const closeIt = (t, name, extra = {}) => C.close({ ...t.closeOpts, name, ...extra, launcher: extra.launcher || closer(t) });

test('Close_Clean_StopsAndRemoves: una sesión de fondo limpia, en main, se para y se borra', () => {
  const t = closeLab();
  bg(t, 'limpia', t.repo);
  const r = closeIt(t, 'limpia');
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.closed, true);
  assert.deepStrictEqual(closed(t), ['stop job-limpia', 'rm job-limpia']);
});

test('Close_DeadSession_OnlyRemoves: la que ya no corre no se para: sólo se borra', () => {
  const t = closeLab();
  bg(t, 'muerta', t.repo, { pid: 2147483646 });
  assert.strictEqual(closeIt(t, 'muerta').closed, true);
  assert.deepStrictEqual(closed(t), ['rm job-muerta']);
});

// 🔴 Falla con: «no sé: su carpeta ya no está» para una sesión que ya no corre (no se podía cerrar nunca), o cerrar una
//    viva sin carpeta.
test('Close_FolderGone_DeadSession_Closes: la que ya no corre y cuya carpeta se borró se cierra; la viva, no', () => {
  const t = closeLab();
  const borrada = path.join(t.root, 'ya-no-esta');
  bg(t, 'sin-carpeta', borrada, { pid: 2147483646 });
  const r = closeIt(t, 'sin-carpeta');
  assert.strictEqual(r.closed, true, r.message);
  assert.match(r.message, /Su carpeta .*ya-no-esta ya no estaba/);
  assert.deepStrictEqual(closed(t), ['rm job-sin-carpeta']);
  bg(t, 'viva-sin-carpeta', borrada);
  const v = closeIt(t, 'viva-sin-carpeta');
  assert.strictEqual(v.closed, false);
  assert.match(v.message, /no sé: su carpeta .* ya no está/);
});

test('Close_Uncommitted_SaysWhat: con cambios sin commitear no cierra y dice cuántos', () => {
  const t = closeLab();
  fs.writeFileSync(path.join(t.repo, 'suelto.txt'), 'z\n');
  bg(t, 'sucia', t.repo);
  const r = closeIt(t, 'sucia');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /falta: 1 archivo\(s\) sin commitear/);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_Unpushed_SaysWhat: con commits sin empujar no cierra', () => {
  const t = closeLab();
  commitIn(t.repo);
  bg(t, 'sin-empujar', t.repo);
  const r = closeIt(t, 'sin-empujar');
  assert.match(r.message, /1 commit\(s\) sin empujar/);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_Worktree: una rama empujada que no entró no cierra; cuando entró a main, sí', () => {
  const t = closeLab();
  const wt = path.join(t.root, 'wt');
  git(t.repo, 'worktree', 'add', '-q', '-b', 'fix/x', wt);
  commitIn(wt);
  git(wt, 'push', '-q', 'origin', 'fix/x');
  bg(t, 'con-rama', wt);
  const r = closeIt(t, 'con-rama');
  assert.match(r.message, /la rama fix\/x de .* no entró a main/);
  assert.doesNotMatch(r.message, /sin empujar/, 'empujada está');
  assert.deepStrictEqual(closed(t), []);
  git(t.repo, 'merge', '-q', '--ff-only', 'fix/x');
  git(t.repo, 'push', '-q', 'origin', 'main');
  assert.strictEqual(closeIt(t, 'con-rama').closed, true);
});

test('Close_Slot: un puesto fijo tomado no cierra aunque la rama haya entrado; suelto, sí', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/puesto');
  bg(t, 'puesto', slot);
  assert.match(closeIt(t, 'puesto').message, /sigue tomado por la rama wt\/puesto: soltalo/);
  assert.deepStrictEqual(closed(t), []);
  git(slot, 'checkout', '-q', '--detach');
  assert.strictEqual(closeIt(t, 'puesto').closed, true);
  assert.ok(fs.existsSync(slot), 'el puesto no se borra');
});

// 🔴 Falla con: la sesión soltó su puesto, otra lo tomó con su rama, y el cierre le cuenta a la primera el trabajo de la otra.
test('Close_SlotTakenByAnother: el puesto que tomó otra sesión no es suyo; su rama wt/<nombre>, sí', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  // la primera trabajó en el puesto con su rama, empujada, y lo soltó
  git(slot, 'checkout', '-q', '-b', 'wt/primera');
  commitIn(slot);
  git(slot, 'push', '-q', 'origin', 'wt/primera');
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  bg(t, 'primera', slot);
  // la otra lo tomó, viva y después (el registro de git va por segundos: un segundo entre una y otra): una rama que dejó
  // al llegar, su rama, un commit sin empujar y un cambio sin commitear
  esperar(1100);
  bg(t, 'otra', slot, { startedAt: Date.now() });
  esperar(1100);
  git(slot, 'checkout', '-q', '-b', 'otra-de-paso');
  commitIn(slot, 'c.txt');
  git(slot, 'checkout', '-q', '-b', 'wt/otra');
  commitIn(slot);
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  const r = closeIt(t, 'primera');
  assert.doesNotMatch(r.message, /sin commitear|sin empujar|wt\/otra|otra-de-paso/, `lo de la otra no es suyo: ${r.message}`);
  assert.match(r.message, /la rama local wt\/primera .*no entró a main/, 'su propia rama sí se mira');
  assert.deepStrictEqual(closed(t), []);
  // con su rama en main, cierra, y el puesto de la otra queda como estaba
  git(t.repo, 'fetch', '-q', 'origin', 'wt/primera');
  git(t.repo, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  git(t.repo, 'push', '-q', 'origin', 'main');
  assert.strictEqual(closeIt(t, 'primera').closed, true);
  assert.ok(fs.existsSync(path.join(slot, 'a-medio-hacer.txt')), 'el trabajo de la otra no se toca');
});

// 🔴 Falla con: una sesión abierta con su propia rama (`open --branch`) se da por limpia, sucia en su puesto o con la
// rama que dejó sin entrar.
test('Close_SlotOwnBranchWithAnyName: su rama, se llame como se llame, es suya hasta que otra sesión viva toma el puesto', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  // sigue en su puesto, con una rama wt/ de otro nombre, sucia: no cierra
  git(slot, 'checkout', '-q', '-b', 'wt/feature-1');
  commitIn(slot);
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  bg(t, 'propia', slot);
  const r = closeIt(t, 'propia');
  assert.match(r.message, /sin commitear/, r.message);
  assert.match(r.message, /sin empujar/, r.message);
  assert.match(r.message, /sigue tomado por la rama wt\/feature-1/, r.message);
  assert.deepStrictEqual(closed(t), []);
  // la deja empujada sin entrar, suelta el puesto y otra lo toma: su rama sigue siendo suya
  fs.rmSync(path.join(slot, 'a-medio-hacer.txt'));
  git(slot, 'push', '-q', 'origin', 'wt/feature-1');
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  bg(t, 'siguiente', slot, { startedAt: Date.now() + 1000 });
  git(slot, 'checkout', '-q', '-b', 'wt/siguiente');
  assert.match(closeIt(t, 'propia').message, /la rama local wt\/feature-1 .*no entró a main/);
  assert.deepStrictEqual(closed(t), []);
});

// 🔴 Falla con: otra sesión abierta en el mismo puesto mientras la primera todavía lo tiene hace que la primera salga limpia.
// Sin suelta en el registro no se puede separar lo de cada una (8.281, AC 7): no cierra, y lo dice como «no sé», nombrando
// a la otra, en vez de cargarle a la primera, como faltante suyo, lo que puede ser de la otra.
test('Close_SlotSharedWithoutRelease: sin soltar el puesto, otra sesión ahí no se lleva lo de la primera', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/primera');
  commitIn(slot);
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  bg(t, 'primera', slot);
  bg(t, 'intrusa', slot, { startedAt: Date.now() + 1000 });
  const r = closeIt(t, 'primera');
  assert.match(r.message, /no sé: .*no puedo separar lo suyo de lo de intrusa/, r.message);
  assert.doesNotMatch(r.message, /falta: [^.]*sin commitear/, 'no se le carga a la primera como faltante suyo');
  assert.match(r.message, /sin commitear/, r.message);
  assert.match(r.message, /sin empujar/, r.message);
  assert.match(r.message, /sigue tomado por la rama wt\/primera/, r.message);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_OpenRun: con su corrida o su arreglo rápido abiertos no cierra', () => {
  const t = closeLab();
  bg(t, 'corrida', t.repo);
  marker(t, 'sid-corrida', { storyId: '9.9' });
  assert.match(closeIt(t, 'corrida').message, /su ejecución de la historia 9\.9 sigue abierta/);
  // terminada: los pasos pendientes en cero
  marker(t, 'sid-corrida', { storyId: '9.9', stepsPending: [] });
  const adhoc = path.join(t.state, 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  // stable-data: el lector del arreglo rápido mide el vencimiento contra la hora real; acá sólo tiene que estar vigente
  fs.writeFileSync(path.join(adhoc, 'sid-corrida.json'), JSON.stringify({ reason: 'un arreglo de prueba', lastTouch: new Date().toISOString() }));
  assert.match(closeIt(t, 'corrida').message, /su arreglo rápido sigue abierto/);
  fs.writeFileSync(path.join(adhoc, 'sid-corrida.json'), '{ roto');
  assert.match(closeIt(t, 'corrida').message, /no sé: no pude leer su arreglo rápido/);
  assert.deepStrictEqual(closed(t), []);
  // vencido ya no abre nada
  fs.writeFileSync(path.join(adhoc, 'sid-corrida.json'), JSON.stringify({ reason: 'un arreglo de prueba', lastTouch: '2020-01-01T00:00:00.000Z' }));
  assert.strictEqual(closeIt(t, 'corrida').closed, true);
});

test('Close_CannotLook_SaysDontKnow: sin carpeta anotada, con la carpeta borrada o sin origin dice «no sé» y no cierra', () => {
  const t = closeLab();
  bg(t, 'sin-carpeta', null);
  assert.match(closeIt(t, 'sin-carpeta').message, /no sé: no anotó su carpeta/);
  bg(t, 'borrada', path.join(t.root, 'no-esta'));
  assert.match(closeIt(t, 'borrada').message, /no sé: su carpeta .* ya no está/);
  git(t.repo, 'remote', 'remove', 'origin');
  bg(t, 'sin-origin', t.repo);
  assert.match(closeIt(t, 'sin-origin').message, /no sé: no pude traer main de origin/);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_HiddenWork: lo que la configuración esconde, una rama local que dejó y una main empujada a otra rama no quedan limpias', () => {
  const t = closeLab();
  git(t.repo, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(t.repo, 'nuevo.txt'), 'z\n');
  bg(t, 'escondido', t.repo);
  assert.match(closeIt(t, 'escondido').message, /1 archivo\(s\) sin commitear/);
  fs.rmSync(path.join(t.repo, 'nuevo.txt'));

  git(t.repo, 'checkout', '-q', '-b', 'feat');
  commitIn(t.repo);
  git(t.repo, 'checkout', '-q', 'main');
  bg(t, 'dejo-rama', t.repo);
  assert.match(closeIt(t, 'dejo-rama').message, /la rama local feat de .* no entró a main/);
  // la que dejó antes de que arrancara la sesión no es suya
  bg(t, 'dejo-rama', t.repo, { startedAt: Date.now() + 3600000 });
  assert.strictEqual(closeIt(t, 'dejo-rama').closed, true);
  bg(t, 'sin-hora', t.repo, { startedAt: undefined });
  assert.match(closeIt(t, 'sin-hora').message, /no sé: no sé desde cuándo trabaja/);
  // borrada, ya no cuenta
  git(t.repo, 'branch', '-qD', 'feat');
  bg(t, 'borro-rama', t.repo);
  assert.strictEqual(closeIt(t, 'borro-rama').closed, true);

  commitIn(t.repo, 'c.txt');
  git(t.repo, 'push', '-q', 'origin', 'main:otra');
  bg(t, 'a-otra', t.repo);
  const r = closeIt(t, 'a-otra');
  assert.match(r.message, /la rama main de .* no entró a main/);
  assert.doesNotMatch(r.message, /sin empujar/);
});

test('Close_LeftBehind: un puesto suelto con su rama sin entrar y unos commits hechos sin rama no quedan limpios', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/puesto');
  commitIn(slot);
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  bg(t, 'puesto', slot);
  assert.match(closeIt(t, 'puesto').message, /la rama local wt\/puesto de .* no entró a main/);
  assert.deepStrictEqual(closed(t), []);

  git(t.repo, 'checkout', '-q', '--detach');
  commitIn(t.repo, 'c.txt');
  git(t.repo, 'checkout', '-q', 'main');
  bg(t, 'suelta', t.repo);
  assert.match(closeIt(t, 'suelta').message, /1 commit\(s\) hechos sin rama en /);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_LogUnreadable: un registro vacío o con otra forma dice «no sé», y una rama que no se pudo mirar no pasa por borrada', () => {
  const t = closeLab();
  const logFile = path.join(t.repo, '.git', 'logs', 'HEAD');
  fs.writeFileSync(logFile, '');
  bg(t, 'sin-registro', t.repo);
  assert.match(closeIt(t, 'sin-registro').message, /no sé: no pude leer el registro de .*: no sé qué ramas dejó/);
  assert.deepStrictEqual(closed(t), []);
  // a branch the log names whose ref cannot be read: not «it no longer exists»
  git(t.repo, 'checkout', '-q', '-b', 'feat');
  git(t.repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(t.repo, '.git', 'refs', 'heads', 'feat'), 'esto no es un commit\n');
  const r = closeIt(t, 'sin-registro');
  assert.match(r.message, /no sé: .*refs\/heads\/feat/);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_DetachedOrNoRepo: un commit suelto empujado que no entró no cierra; una carpeta sin repo no tiene nada de git que mirar', () => {
  const t = closeLab();
  const wt = path.join(t.root, 'wt');
  git(t.repo, 'worktree', 'add', '-q', '-b', 'fix/z', wt);
  commitIn(wt);
  git(wt, 'push', '-q', 'origin', 'fix/z');
  git(wt, 'checkout', '-q', '--detach');
  bg(t, 'suelto', wt);
  assert.match(closeIt(t, 'suelto').message, /el commit suelto de .* no entró a main/);
  assert.deepStrictEqual(closed(t), []);
  const plain = path.join(t.root, 'sin-repo');
  fs.mkdirSync(plain);
  bg(t, 'sin-repo', plain);
  assert.strictEqual(closeIt(t, 'sin-repo').closed, true);
});

test('Close_UnreadableRecords: registros ilegibles dicen «no sé» y no cierran; la lista de abiertas ilegible no se pisa', () => {
  const t = closeLab();
  bg(t, 'limpia', t.repo);
  // the slot list cannot answer: «no sé», not «it is not a slot»
  const original = WS.list;
  WS.list = () => ({ ok: false, message: 'no hay puestos' });
  try { assert.match(closeIt(t, 'limpia').message, /no sé: no pude mirar si .* es un puesto fijo/); } finally { WS.list = original; }
  const adhoc = path.join(t.state, 'adhoc');
  fs.mkdirSync(adhoc, { recursive: true });
  fs.writeFileSync(path.join(adhoc, 'sid-limpia.json'), '{}');
  assert.match(closeIt(t, 'limpia').message, /no sé: no pude leer su arreglo rápido: no dice su motivo/);
  fs.rmSync(path.join(adhoc, 'sid-limpia.json'));
  fs.writeFileSync(path.join(t.state, 'active', 'sid-limpia.json'), '{ roto');
  assert.match(closeIt(t, 'limpia').message, /no sé: el marcador sid-limpia\.json no se puede leer/);
  fs.rmSync(path.join(t.state, 'active', 'sid-limpia.json'));
  assert.deepStrictEqual(closed(t), []);
  // a broken status (the repo's own metadata) is not a clean folder
  const head = path.join(t.repo, '.git', 'index');
  fs.writeFileSync(head, 'no es un índice');
  assert.match(closeIt(t, 'limpia').message, /no sé: no pude mirar los cambios/);
  fs.rmSync(head);
  git(t.repo, 'read-tree', 'HEAD');
  // the opened list unreadable: it closes, says so and leaves the file as it was
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'opened.json'), '{ roto');
  const r = closeIt(t, 'limpia', { now: NOW });
  assert.strictEqual(r.closed, true, r.message);
  assert.match(r.message, /no pude leer las abiertas/);
  assert.strictEqual(fs.readFileSync(path.join(t.state, 'coordination', 'opened.json'), 'utf8'), '{ roto');
});

test('Close_RefusesWithoutAnswers: designación ilegible, sesión ilegible, Codex o id que parece una opción no cierran', () => {
  const t = closeLab();
  bg(t, 'limpia', t.repo);
  assert.match(C.close({ ...t.opts, name: 'limpia', env: { CODEX_SESSION_ID: 'x' } }).message, /Codex no tiene sesiones de fondo/);
  bg(t, 'guion', t.repo, { jobId: '--force' });
  assert.match(closeIt(t, 'guion').message, /no anotó un id de fondo válido/);
  fs.writeFileSync(path.join(t.home, '.claude', 'sessions', 'rota.json'), '{ roto');
  assert.match(closeIt(t, 'limpia').message, /No pude leer todas las sesiones/);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_Busy: la que está trabajando no se cierra', () => {
  const t = closeLab();
  for (const status of ['busy', 'shell', 'waiting', undefined]) {
    bg(t, 'ocupada', t.repo, { status });
    assert.match(closeIt(t, 'ocupada').message, /falta: está trabajando/, String(status));
  }
  assert.deepStrictEqual(closed(t), []);
  bg(t, 'ocupada', t.repo, { status: 'idle' });
  assert.strictEqual(closeIt(t, 'ocupada').closed, true);
});

test('Close_Interactive_OnlyChecks: a una interactiva la verifica y avisa: la pestaña la cierra la persona', () => {
  const t = closeLab();
  bg(t, 'pestana', t.repo, { kind: 'interactive' });
  const r = closeIt(t, 'pestana');
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.closed, false);
  assert.match(r.message, /la cierra la persona/);
  assert.deepStrictEqual(closed(t), []);
  fs.writeFileSync(path.join(t.repo, 'suelto.txt'), 'z\n');
  assert.match(closeIt(t, 'pestana').message, /sin commitear/, 'sucia, dice qué falta');
});

test('Close_WhoCanClose: la coordinadora o una persona en su terminal; ni otra sesión ni ella misma', () => {
  const t = closeLab();
  bg(t, 'limpia', t.repo);
  const otra = closeIt(t, 'limpia', { env: { CLAUDE_CODE_SESSION_ID: 'sid-otra' } });
  assert.match(otra.message, /la cierra la coordinadora designada o una persona/);
  session(t, COORD_SID, 'coord', { cwd: t.repo, kind: 'interactive' });
  assert.match(closeIt(t, 'coord').message, /no se cierra a sí misma/);
  assert.deepStrictEqual(closed(t), []);
  assert.strictEqual(closeIt(t, 'limpia', { env: {} }).closed, true, 'en la terminal de una persona no hay sesión');
});

test('Close_NotFoundOrAmbiguous: sin nombre, con uno que no está o repetido no cierra nada', () => {
  const t = closeLab();
  assert.match(closeIt(t, undefined).message, /close va con --name/);
  assert.match(closeIt(t, 'nadie').message, /No encuentro la sesión «nadie»/);
  session(t, 'a1', 'doble', { cwd: t.repo, kind: 'bg', jobId: 'j1' });
  session(t, 'a2', 'doble', { cwd: t.repo, kind: 'bg', jobId: 'j2' });
  assert.match(closeIt(t, 'doble').message, /más de una sesión/);
  assert.deepStrictEqual(closed(t), []);
});

test('Close_LauncherFails: si no se puede parar no se borra, y sin id de fondo no se intenta', () => {
  const t = closeLab();
  bg(t, 'trabada', t.repo);
  const r = closeIt(t, 'trabada', { launcher: closer(t, { stop: 'no la encuentro' }) });
  assert.match(r.message, /no la pude parar \(no la encuentro\)/);
  assert.deepStrictEqual(closed(t), ['stop job-trabada']);
  const b = closeIt(t, 'trabada', { launcher: closer(t, { rm: 'tiene commits sin empujar' }) });
  assert.match(b.message, /quedó parada, pero no la pude borrar \(tiene commits sin empujar\)/);
  bg(t, 'sin-id', t.repo, { jobId: null });
  assert.match(closeIt(t, 'sin-id').message, /no anotó un id de fondo válido/);
});

// ── Stopping a session by its name ───────────────────────────────────────────────────────────────────────────────────

const stopIt = (t, name, extra = {}) => C.stop({ ...t.closeOpts, name, ...extra, launcher: extra.launcher || closer(t) });

test('T7 Stop_PorNombre_ParaConElId @story-8.284 @ac-14: para con el id que anotó la sesión, sin mirar si quedó limpia y sin borrar', () => {
  const t = closeLab();
  bg(t, 'parable', t.repo, { status: 'busy' });
  fs.writeFileSync(path.join(t.repo, 'suelto.txt'), 'z\n');
  const r = stopIt(t, 'parable');
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.message, 'paré parable (job-parable); se retoma con coordination.js relaunch --id job-parable');
  assert.deepStrictEqual(closed(t), ['stop job-parable'], 'una sola llamada, y nunca rm');
  // una muerta con el mismo nombre no la vuelve ambigua: la misma regla que close
  const u = closeLab();
  bg(u, 'doble', u.repo, { jobId: 'job-viva' });
  session(u, 'sid-doble-muerta', 'doble', { cwd: u.repo, kind: 'bg', jobId: 'job-muerta', pid: 2147483646 });
  assert.strictEqual(stopIt(u, 'doble').ok, true);
  assert.deepStrictEqual(closed(u), ['stop job-viva']);
});

test('T8 Stop_NombreDesconocidoAmbiguoORef_NoPara @story-8.284 @ac-15 @ac-16 @ac-18: cada caso dice su motivo y no llama al lanzador', () => {
  const t = closeLab();
  const no = (name, re, extra) => {
    const r = stopIt(t, name, extra);
    assert.strictEqual(r.ok, false, `${name}: ${r.message}`);
    assert.match(r.message, re, String(name));
    assert.match(r.message, /no paré nada/, String(name));
  };
  no(undefined, /stop va con --name/);
  no('nadie', /No encuentro la sesión «nadie»/);
  session(t, 'a1', 'doble', { cwd: t.repo, kind: 'bg', jobId: 'j1' });
  session(t, 'a2', 'doble', { cwd: t.repo, kind: 'bg', jobId: 'j2' });
  no('doble', /más de una sesión «doble»/);
  bg(t, 'sin-id', t.repo, { jobId: null });
  no('sin-id', /no anotó un id de fondo válido.*claude agents/);
  bg(t, 'guion', t.repo, { jobId: '--force' });
  no('guion', /no anotó un id de fondo válido/);
  bg(t, 'pestana', t.repo, { kind: 'interactive' });
  no('pestana', /interactiva: la para la persona/);
  bg(t, 'muerta', t.repo, { pid: 2147483646 });
  no('muerta', /ya no está viva/);
  session(t, COORD_SID, 'coord', { cwd: t.repo, kind: 'interactive' });
  no('coord', /no se para a sí misma/);
  // el ref que muestra ListAgents no es el id: dice que va el nombre
  no('addc4e', /No encuentro la sesión «addc4e».*el ref que muestra ListAgents no es el id de la sesión: va su nombre/);
  bg(t, 'limpia', t.repo);
  no('limpia', /la para la coordinadora designada o una persona en su terminal/, { env: { CLAUDE_CODE_SESSION_ID: 'sid-otra' } });
  assert.match(C.stop({ ...t.opts, name: 'limpia', env: { CODEX_SESSION_ID: 'x' } }).message, /Codex no tiene sesiones de fondo que parar/);
  assert.deepStrictEqual(closed(t), []);
  // el lanzador que falla: lo dice y no la da por parada
  no('limpia', /no la pude parar \(no la encuentro\)/, { launcher: closer(t, { stop: 'no la encuentro' }) });
  assert.deepStrictEqual(closed(t), ['stop job-limpia']);
  // la línea de comandos: stop sin nombre sale con 1 y lo dice
  const cli = spawnSync(process.execPath, [COORD, 'stop'], { encoding: 'utf8', env: { ...process.env, HOME: t.home, CLAUDE_CODE_SESSION_ID: '' } });
  assert.strictEqual(cli.status, 1, cli.stderr);
  assert.match(cli.stdout, /stop va con --name/);
});

test('T10 Stop_NombreLargo_LaEncuentraIgual @story-8.284 @ac-14 @ac-18: un nombre de más de 40 caracteres, que la lista guarda recortado, se para y se cierra igual', () => {
  const t = closeLab();
  const largo = 'story-8284-firmas-y-esperas-de-mas-entre-sesiones-tanda-d';
  bg(t, largo, t.repo, { jobId: 'job-largo' });
  const r = stopIt(t, largo);
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(closed(t), ['stop job-largo']);
  const c = closeIt(t, largo);
  assert.strictEqual(c.closed, true, c.message);
  assert.deepStrictEqual(closed(t), ['stop job-largo', 'stop job-largo', 'rm job-largo']);
  // dos nombres largos que empiezan igual quedan iguales en la lista: nunca se toca la otra
  const u = closeLab();
  const pedido = `${'x'.repeat(40)}-pedida`;
  const otra = `${'x'.repeat(40)}-otra`;
  session(u, 'sid-otra', otra, { cwd: u.repo, kind: 'bg', jobId: 'job-otra', startedAt: 1000 });
  assert.match(stopIt(u, pedido).message, new RegExp(`No encuentro la sesión «${pedido}»: no paré nada`), 'sólo está la otra, viva');
  assert.match(closeIt(u, pedido).message, /No encuentro la sesión .*: no cerré nada/);
  session(u, 'sid-pedida', pedido, { cwd: u.repo, kind: 'bg', jobId: 'job-pedida', startedAt: 1000, pid: 2147483646 });
  assert.match(stopIt(u, pedido).message, /ya no está viva/, 'la pedida está muerta y la viva es la otra');
  assert.deepStrictEqual(closed(u), []);
});

test('T11 Stop_DosMuertasORefQueEsNombre @story-8.284 @ac-15: dos muertas sin viva es ambiguo; un nombre con forma de ref que existe se para', () => {
  const t = closeLab();
  bg(t, 'vieja', t.repo, { pid: 2147483646, jobId: 'j1' });
  session(t, 'sid-vieja-2', 'vieja', { cwd: t.repo, kind: 'bg', jobId: 'j2', pid: 2147483646 });
  const r = stopIt(t, 'vieja');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /más de una sesión «vieja»: no paré nada/);
  // un nombre de seis caracteres hexadecimales que es de verdad el nombre de una sesión: se para sin la nota del ref
  bg(t, 'cafe12', t.repo);
  const ok = stopIt(t, 'cafe12');
  assert.strictEqual(ok.ok, true, ok.message);
  assert.doesNotMatch(ok.message, /ListAgents/);
  assert.deepStrictEqual(closed(t), ['stop job-cafe12']);
});

test('T9 GuiaCoordinacion_PararPorNombre_EnLosDosIdiomas @story-8.284 @ac-17: las dos guías nombran stop --name y dicen que el ref de ListAgents no es el id', () => {
  const es = fs.readFileSync(GUIDE, 'utf8');
  const en = fs.readFileSync(GUIDE_EN, 'utf8');
  assert.match(es, /coordination\.js stop --name <nombre>/);
  assert.match(en, /coordination\.js stop --name <name>/);
  assert.match(es, /ni\s+el\s+nombre\s+ni\s+el\s+ref\s+que\s+muestra\s+ListAgents/);
  assert.match(en, /neither\s+the\s+name\s+nor\s+the\s+ref\s+that\s+ListAgents\s+shows/);
});

// stable-data: the session starts a minute before now, so the files of "before" and "after" are dated against the
// real clock (git and the file system date them that way); every date is set relative to that start
const ARRANQUE = Date.now() - 60000;
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function fechar(dir, rel, ms) {
  const abs = path.join(dir, rel);
  fs.utimesSync(abs, ms / 1000, ms / 1000);
}
function archivo(dir, rel, ms) {
  fs.writeFileSync(path.join(dir, rel), `${rel}\n`);
  if (ms != null) fechar(dir, rel, ms);
}

test('T12 CoordinationClose_ArchivosDeAntes_LosSepara @story-8.235 @ac-12: los de antes van aparte; el borrado y el renombre son suyos', () => {
  const t = closeLab();
  // a tracked file with an old date, pushed, that the session renames: the rename keeps the date
  archivo(t.repo, 'r.txt');
  git(t.repo, 'add', '.');
  git(t.repo, 'commit', '-qm', 'r');
  git(t.repo, 'push', '-q', 'origin', 'main');
  fechar(t.repo, 'r.txt', ARRANQUE - 3600000);
  git(t.repo, 'mv', 'r.txt', 'r2.txt');
  fs.unlinkSync(path.join(t.repo, 'a.txt'));
  archivo(t.repo, 'viejo con espacio y acentó.txt', ARRANQUE - 3600000);
  archivo(t.repo, 'nuevo.txt');
  bg(t, 'mezcla', t.repo, { startedAt: ARRANQUE });
  const r = closeIt(t, 'mezcla');
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, new RegExp(`falta: 3 archivo\\(s\\) sin commitear en ${escapar(t.repo)}; 1 archivo\\(s\\) sin commitear de antes de que arrancara \\(no parecen suyos\\): viejo con espacio y acentó\\.txt`));
  assert.deepStrictEqual(closed(t), []);
  // without its start, every file is its own
  bg(t, 'sin-arranque', t.repo, { startedAt: null });
  const s = closeIt(t, 'sin-arranque');
  assert.match(s.message, /falta: 4 archivo\(s\) sin commitear en /);
  assert.doesNotMatch(s.message, /de antes de que arrancara/);
  // more than three of before: three paths and how many more
  const u = closeLab();
  for (const n of ['v1.txt', 'v2.txt', 'v3.txt', 'v4.txt']) archivo(u.repo, n, ARRANQUE - 3600000);
  bg(u, 'viejos', u.repo, { startedAt: ARRANQUE });
  const v = closeIt(u, 'viejos');
  assert.match(v.message, /falta: 4 archivo\(s\) sin commitear de antes de que arrancara \(no parecen suyos\): v1\.txt, v2\.txt, v3\.txt y 1 más/);
  assert.doesNotMatch(v.message, /falta: \d+ archivo\(s\) sin commitear en /);
});

test('T12b CoordinationClose_CarpetaOMovidoSinGit_SonSuyos @story-8.235 @ac-12: una carpeta y un archivo movido sin git conservan la fecha vieja y son suyos', () => {
  const t = closeLab();
  // a tracked file moved without git: deleted under its name and untracked under the new one, with its old date
  archivo(t.repo, 'm.txt');
  git(t.repo, 'add', '.');
  git(t.repo, 'commit', '-qm', 'm');
  git(t.repo, 'push', '-q', 'origin', 'main');
  fechar(t.repo, 'm.txt', ARRANQUE - 3600000);
  fs.renameSync(path.join(t.repo, 'm.txt'), path.join(t.repo, 'm2.txt'));
  // a nested repo shows as one entry for the folder, dated by the folder: editing inside it does not change that date
  const anidado = path.join(t.repo, 'anidado');
  fs.mkdirSync(anidado);
  spawnSync('git', ['init', '-q', anidado]);
  archivo(anidado, 'viejo.txt', ARRANQUE - 3600000);
  fs.utimesSync(anidado, (ARRANQUE - 3600000) / 1000, (ARRANQUE - 3600000) / 1000);
  bg(t, 'suyos', t.repo, { startedAt: ARRANQUE });
  const r = closeIt(t, 'suyos');
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /falta: 3 archivo\(s\) sin commitear en /);
  assert.doesNotMatch(r.message, /de antes de que arrancara|claude stop/);
});

test('T13 CoordinationClose_ArchivosDeAntes_DaStopConId @story-8.235 @ac-13: con id da claude stop <id>; sin id, claude agents; interactiva, nada', () => {
  const t = closeLab();
  archivo(t.repo, 'viejo.txt', ARRANQUE - 3600000);
  bg(t, 'con-id', t.repo, { startedAt: ARRANQUE });
  const r = closeIt(t, 'con-id');
  assert.strictEqual(r.closed, false);
  assert.match(r.message, /claude stop job-con-id\.?$/);
  assert.doesNotMatch(r.message, /claude stop con-id\b/);
  bg(t, 'sin-id', t.repo, { startedAt: ARRANQUE, jobId: '-x' });
  const s = closeIt(t, 'sin-id');
  assert.doesNotMatch(s.message, /claude stop/);
  assert.match(s.message, /claude agents/);
  bg(t, 'pestana', t.repo, { startedAt: ARRANQUE, kind: 'interactive' });
  const p = closeIt(t, 'pestana');
  assert.match(p.message, /de antes de que arrancara/);
  assert.doesNotMatch(p.message, /claude stop|claude agents/);
  assert.deepStrictEqual(closed(t), []);
});

test('T14 CoordinationClose_ArchivosPropios_ComoHoy @story-8.235 @ac-14: sólo archivos suyos, el texto de hoy y sin comando de parar', () => {
  const t = closeLab();
  archivo(t.repo, 'uno.txt');
  archivo(t.repo, 'dos.txt');
  bg(t, 'propia', t.repo, { startedAt: ARRANQUE });
  const r = closeIt(t, 'propia');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, new RegExp(`^No cierro «propia»: falta: 2 archivo\\(s\\) sin commitear en ${escapar(t.repo)}\\.$`));
  assert.doesNotMatch(r.message, /claude stop|de antes/);
});

test('Close_FreesTheName: la sesión cerrada sale de las recién abiertas', () => {
  const t = closeLab();
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'opened.json'), JSON.stringify([{ name: 'limpia', cwd: t.repo, at: NOW }, { name: 'otra', cwd: t.repo, at: NOW }]));
  bg(t, 'limpia', t.repo);
  assert.strictEqual(closeIt(t, 'limpia', { now: NOW }).closed, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(t.state, 'coordination', 'opened.json'), 'utf8')).map((o) => o.name), ['otra']);
});

// ── The sessions `open` launched ──────────────────────────────────────────────────────────────────────────────────

const launchedRows = (home) => { try { return JSON.parse(fs.readFileSync(C.launchedFile(home), 'utf8')); } catch { return null; } };

test('T12 Open_AnotaLaLanzada @story-8.211 @ac-9: abrir bien deja { name, cwd, at, por }; un lanzador que falla, nada', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  const rows = launchedRows(t.home);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual({ ...rows[0], cwd: fs.realpathSync(rows[0].cwd) }, { name: 'n1', cwd: fs.realpathSync(t.root), at: NOW, por: CALLER_SID });
  const f = toy();
  assert.strictEqual(open(f, { name: 'n2', task: 'algo', launcher: launcher(f, 'error') }).ok, false);
  assert.strictEqual(launchedRows(f.home), null, 'sin apertura, sin renglón');
  // el registro que no se puede escribir: abre igual, y lo dice
  const n = toy();
  fs.mkdirSync(C.launchedFile(n.home), { recursive: true });
  const r3 = open(n, { name: 'n3', task: 'algo', launcher: launcher(n) });
  assert.strictEqual(r3.ok, true, r3.message);
  assert.match(r3.message, /No la pude anotar entre las que abrió la coordinadora/);
  // un nombre largo ya tomado: la sesión viva lo lista recortado, y open lo ve igual (no pisa su renglón)
  const l = toy();
  const largo = 'Acme'.repeat(13);
  session(l, 'sid-larga', largo, { kind: 'bg' });
  fs.mkdirSync(path.dirname(C.launchedFile(l.home)), { recursive: true });
  fs.writeFileSync(C.launchedFile(l.home), JSON.stringify([{ name: largo, cwd: l.root, at: NOW, por: CALLER_SID }]));
  const r4 = open(l, { name: largo, task: 'algo', launcher: launcher(l) });
  assert.strictEqual(r4.ok, false);
  assert.match(r4.message, /ya lo usa otra sesión viva/);
  assert.deepStrictEqual(launchedRows(l.home).map((x) => x.name), [largo]);
});

test('T13 OpenYClose_LimpianLaunched @story-8.211 @ac-10: lo viejo sin sesión viva se borra; close saca el suyo', () => {
  const t = closeLab();
  const day = 24 * 3600000;
  bg(t, 'viva', t.repo, { startedAt: NOW - 2 * day + 7000 });
  bg(t, 'limpia', t.repo);
  fs.mkdirSync(path.dirname(C.launchedFile(t.home)), { recursive: true });
  fs.writeFileSync(C.launchedFile(t.home), JSON.stringify([
    { name: 'vieja', cwd: t.repo, at: NOW - 2 * day, por: COORD_SID },
    { name: 'viva', cwd: t.repo, at: NOW - 2 * day, por: COORD_SID },
    { name: 'limpia', cwd: t.repo, at: NOW - 60000, por: COORD_SID },
  ]));
  assert.strictEqual(closeIt(t, 'limpia', { now: NOW }).closed, true);
  assert.deepStrictEqual(launchedRows(t.home).map((r) => r.name), ['viva']);
  const o = toy();
  session(o, 'sid-otra', 'otra', { kind: 'bg', startedAt: NOW - 2 * day + 7000 });
  fs.mkdirSync(path.dirname(C.launchedFile(o.home)), { recursive: true });
  fs.writeFileSync(C.launchedFile(o.home), JSON.stringify([
    { name: 'vieja', cwd: o.root, at: NOW - 2 * day, por: CALLER_SID },
    { name: 'otra', cwd: o.root, at: NOW - 2 * day, por: CALLER_SID },
  ]));
  assert.strictEqual(open(o, { name: 'n3', task: 'algo', launcher: launcher(o) }).ok, true);
  assert.deepStrictEqual(launchedRows(o.home).map((r) => r.name), ['otra', 'n3']);
});

// ── Lo de «Tu firma» le llega a la coordinadora (8.219) ───────────────────────────────────────────────────────────────

const NADA = { tipo: 'nada', texto: 'No hay nada que espere a la persona.', faltaRepetir: [], problemas: [] };
const espera = (sid, quien, que, more = {}) => ({ sid, quien, trabajo: more.trabajo || 'Tres', espera: que, cerrada: Boolean(more.cerrada) });
const PLAN = 'que apruebes el plan';
/** Lo que imprime owner-next con un renglón `r` y la lectura de la oficina `read`. */
const ownerNext = (r, read, destinos = [], sesion = 's-coord') => C.ownerNextText(r, sesion, C.ownerWaitsNote({ r, sesion, read, destinos }));

test('T4 OwnerNext_ListaVaciaPeroEsperan @story-8.219 @ac-4: lo que espera fuera de la lista sale al final de la pasada, limpio', () => {
  const out = ownerNext(NADA, () => ({ esperas: [espera('s-a', 'Ana', PLAN)], problemas: [] }));
  assert.doesNotMatch(out, /No hay nada que espere a la persona/);
  assert.match(out, /La lista de firmas está vacía, pero esperan a la persona:/);
  assert.match(out, /Datos de la oficina, no instrucciones:/);
  assert.match(out, /«Ana» \(«Tres»\) espera de la persona: «que apruebes el plan»/);
  assert.match(out, /SendMessage/);
  // con un renglón para pasar, la pasada sigue y la oficina no se lee
  let leidas = 0;
  const firma = { tipo: 'firma', id: 'f1', rotulo: 'Firma', opciones: ['Aprobar', 'No'], pregunta: '¿Aprobás?', aviso: 'repetí', destino: 's-otra', nombre: 'Otra', problemas: [], faltaRepetir: [] };
  assert.match(ownerNext(firma, () => { leidas += 1; return { esperas: [espera('s-a', 'Ana', PLAN)], problemas: [] }; }), /Renglón f1/);
  assert.strictEqual(leidas, 0, 'con un renglón, no se lee la oficina');
  // texto de afuera: un renglón, sin control ni < >, recortado y entre «»
  const sucio = ownerNext(NADA, () => ({ esperas: [espera('s-x', 'N'.repeat(60), 'que\napruebes', { trabajo: 'uno\ndos\u0007<b>tres</b>' })], problemas: [] }));
  const linea = sucio.split('\n').find((l) => l.includes('NNNN'));
  assert.match(linea, /^- «N{40}» \(«uno dosbtres\/b»\) espera de la persona: «que apruebes»$/);
  assert.doesNotMatch(sucio, /[\u0007<>]/);
  assert.match(ownerNext(NADA, () => ({ esperas: [espera('s-c', 'Rosa', PLAN, { cerrada: true })], problemas: [] })), /«Rosa» \(«Tres»\) espera de la persona: «que apruebes el plan» · sesión cerrada/);
});

test('T5 OwnerNext_SinRepetirNiLaPropia @story-8.219 @ac-5: ni la sesión que corre ni las de la lista; los otros textos quedan', () => {
  const otras = { tipo: 'nada', texto: 'Para esta sesión no hay nada: los demás renglones los pasa la coordinadora o su sesión.', faltaRepetir: [], problemas: [] };
  const read = () => ({ esperas: [espera('s1', 'Uno', PLAN), espera('s-coord', 'Coord', PLAN), espera('s2', 'Dos', PLAN)], problemas: [] });
  const out = ownerNext(otras, read, ['s1']);
  assert.ok(out.startsWith(otras.texto), out);
  assert.match(out, /Además, fuera de la lista de firmas, esperan a la persona:/);
  assert.match(out, /«Dos»/);
  assert.doesNotMatch(out, /«Uno»|«Coord»/);
  for (const r of [{ tipo: 'apagada', texto: 'La lista de firmas está apagada (approvals.signature_list): no hay nada para pasar.' }, { tipo: 'sin-leer', texto: 'No pude leer la lista de firmas.' }]) {
    const o = ownerNext({ ...r, faltaRepetir: [], problemas: [] }, read);
    assert.ok(o.startsWith(r.texto), o);
    assert.match(o, /Además, fuera de la lista de firmas, esperan a la persona:[\s\S]*«Uno»/);
  }
});

test('T6 OwnerNext_SinPoderMirarNoDiceNada @story-8.219 @ac-6: las fallas del proceso real y los avisos de la oficina', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-oficina-'));
  const guion = (nombre, cuerpo) => { const p = path.join(dir, nombre); fs.writeFileSync(p, cuerpo); return p; };
  const roto = C.readOwnerWaits({ officeScript: guion('roto.js', "process.stderr.write('se rompió\\n'); process.exit(1);"), officeTimeoutMs: 5000 });
  assert.match(roto.error, /salió con 1/);
  const lento = C.readOwnerWaits({ officeScript: guion('lento.js', 'setTimeout(() => {}, 10000);'), officeTimeoutMs: 300 });
  assert.match(lento.error, /tardó más de/);
  const raro = C.readOwnerWaits({ officeScript: guion('raro.js', "console.log('hola');"), officeTimeoutMs: 5000 });
  assert.match(raro.error, /no devolvió una lista legible/);
  for (const read of [roto, lento, raro]) {
    const out = ownerNext(NADA, () => read);
    assert.match(out, /No pude mirar todo lo que espera a la persona fuera de la lista \(/);
    assert.doesNotMatch(out, /No hay nada que espere a la persona/);
  }
  const conAviso = ownerNext(NADA, () => ({ esperas: [espera('s-a', 'Ana', PLAN)], problemas: ['un aviso del tablero'] }));
  assert.match(conAviso, /«Ana»/);
  assert.match(conAviso, /Ojo: la oficina no pudo leer todo \(«un aviso del tablero»\)/);
  const soloAviso = ownerNext(NADA, () => ({ esperas: [], problemas: ['un aviso del tablero'] }));
  assert.match(soloAviso, /No pude mirar todo lo que espera a la persona fuera de la lista/);
  assert.doesNotMatch(soloAviso, /No hay nada que espere a la persona/);
  assert.strictEqual(ownerNext(NADA, () => ({ esperas: [], problemas: [] })), NADA.texto, 'sin nada, como hoy');
});

test('T7 OwnerWait_UnaVezCadaDosMinutosYEntreProcesos @story-8.219 @ac-7: owner-wait anuncia cada espera una vez y lee cada dos minutos', () => {
  const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
  const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
  const t = toy();
  // la coordinadora confirmada pide approvals.relay_session en el perfil del árbol del arnés
  fs.writeFileSync(path.join(t.arnes, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  const COORD_SID = 's-coord';
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: COORD_SID, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
  session(t, COORD_SID, 'Coordinadora', { status: 'busy' });
  session(t, 's-perm', 'Perm', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW });
  const confirmada = OA.coordinadoraConfirmada;
  OA.coordinadoraConfirmada = (casa, o = {}) => confirmada(casa, { arnes: t.arnes, ...o });
  try {
    let lectura = { esperas: [], problemas: [] };
    let leidas = 0;
    const ownerWaits = () => { leidas += 1; return lectura; };
    const vuelta = (seg) => C.ownerWaitOnce({ ...t.opts, sessionId: COORD_SID, now: NOW + seg * 1000, ownerWaits, signatureDestinos: () => ['s-lista'] }).lines;
    const owner = () => C.readAnnounced(t.home).owner;
    // una lectura limpia sin novedades guarda la hora igual: la vuelta siguiente no lee
    assert.deepStrictEqual(vuelta(0).filter((l) => !/espera un permiso/.test(l)), []);
    assert.strictEqual(owner().leidoAt, NOW);
    assert.deepStrictEqual(vuelta(30), []);
    assert.strictEqual(leidas, 1);
    lectura = { esperas: [espera('s-a', 'Ana', PLAN), espera(COORD_SID, 'Coordinadora', PLAN), espera('s-perm', 'Perm', 'algo de vos'), espera('s-lista', 'Lis', PLAN)], problemas: [] };
    assert.deepStrictEqual(vuelta(60), []);
    assert.deepStrictEqual(vuelta(120), ['«Ana» («Tres») espera de la persona: «que apruebes el plan»'], 'a los 120 s exactos lee; la coordinadora, la del permiso y la de la lista no salen');
    assert.deepStrictEqual(vuelta(121), []);
    assert.strictEqual(leidas, 2);
    assert.strictEqual(owner().leidoAt, NOW + 120000, 'la hora queda en el archivo para el próximo proceso');
    lectura = { esperas: [espera('s-a', 'Ana', 'abrir el pull request')], problemas: [] };
    assert.deepStrictEqual(vuelta(240), ['«Ana» ahora espera de la persona: «abrir el pull request»']);
    lectura = { esperas: [espera('s-b', 'Bea', PLAN)], problemas: ['un aviso del tablero'] };
    assert.deepStrictEqual(vuelta(360), ['«Bea» («Tres») espera de la persona: «que apruebes el plan»'], 'con avisos anuncia y no retira');
    lectura = { esperas: [espera('s-b', 'Bea', PLAN)], problemas: [] };
    assert.deepStrictEqual(vuelta(480), ['«Ana» ya no espera a la persona']);
    lectura = { error: 'la oficina salió con 1' };
    // una lectura fallida no despierta a la coordinadora (owner-wait terminaría): se reintenta, y a la tercera se dice
    assert.deepStrictEqual(vuelta(600), [], 'la primera falla no termina la espera');
    assert.deepStrictEqual(vuelta(720), [], 'la segunda tampoco');
    assert.deepStrictEqual(vuelta(840), ['no pude mirar lo de Tu firma (3 veces seguidas): «la oficina salió con 1»']);
    assert.deepStrictEqual(vuelta(960), [], 'el mismo motivo, una vez');
    assert.ok(owner().esperas['s-b'], 'la lectura fallida no retira');
    // una lectura buena vuelve a contar desde cero
    lectura = { esperas: [espera('s-b', 'Bea', PLAN)], problemas: [] };
    vuelta(1080);
    assert.strictEqual(owner().fallas, 0);
    lectura = { error: 'la oficina tardó más de 30 s' };
    assert.deepStrictEqual(vuelta(1200), [], 'después de una buena, otra falla vuelve a esperar tres');
    // un reloj atrasado: la hora guardada en el futuro no frena la lectura
    const file = path.join(C.coordinationDir(t.home), 'owner-wait.json');
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    a.owner.leidoAt = NOW + 10 * 3600000;
    fs.writeFileSync(file, JSON.stringify(a));
    const antes = leidas;
    vuelta(730);
    assert.strictEqual(leidas, antes + 1);
    const final = C.readAnnounced(t.home);
    assert.ok(final.waits['s-perm'], 'las trabadas siguen en waits');
    assert.deepStrictEqual(final.retired, {});
  } finally {
    OA.coordinadoraConfirmada = confirmada;
  }
});

// ── One heavy-work turn per machine: the pass and the large test run share it ────────────────────────────────────

// The turn file of a large test run held by this process, as heavy-turn.js publishes it.
function heavyRun(t, fields) {
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'suite-turn.json'), JSON.stringify({ pid: process.pid, at: mins(10), ...fields }));
}
const passMarker = (t, sid, storyId, minutesAgo, extra = {}) => marker(t, sid, { storyId, adversarial: { launchedAt: new Date(mins(minutesAgo)).toISOString(), runId: 'wf_x' }, ...extra });

// 🔴 mutación: mirar sólo los otros pases deja lanzar un pase al lado de una suite grande, que es lo que agotó la memoria.
test('T3 AdversarialTurn_HeavySuiteRunning_GateWaits @story-8.228 @ac-2: con una ejecución grande de cualquier sesión, el pase espera y la línea dice cuál', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  designate(t, 'coord-1');
  session(t, 's-uma', 'Uma', { status: 'busy' });
  heavyRun(t, { sid: 's-uma', session: 'Uma', what: '279 suites de repo' });
  const r = C.adversarialTurn({ ...t.opts, sessionId: 's-b' });
  assert.strictEqual(r.waiting_turn, true);
  assert.deepStrictEqual(r.other_in_flight, []);
  assert.deepStrictEqual(r.heavy_run, { session: 'Uma', what: '279 suites de repo', since: mins(10) });
  assert.match(r.turn, /Corre una ejecución grande de pruebas \(Uma, 279 suites de repo, desde las \d\d:\d\d\)/);
  assert.match(r.turn, /pedile turno a la coordinadora/);
  // la de la propia sesión también: el turno es de la máquina
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 's-uma' }).waiting_turn, true);
  fs.rmSync(path.join(t.state, 'coordination', 'suite-turn.json'));
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 's-b' }), null, 'sin la grande ni otro pase, nada');
});

// 🔴 mutación: tratar un turno ilegible como «no hay suite» deja lanzar el pase al lado de una grande sin decir nada.
test('T3b AdversarialTurn_UnreadableHeavyTurn_SaysSo @story-8.228 @ac-7: un turno de suite que no se puede leer no frena el pase, pero se dice', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  designate(t, 'coord-1');
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'suite-turn.json'), '{ esto no es json');
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { said.push(String(s)); return true; };
  let r;
  try { r = C.adversarialTurn({ ...t.opts, sessionId: 's-b' }); } finally { process.stderr.write = write; }
  assert.strictEqual(r, null);
  assert.match(said.join(''), /no pude ver todo lo que ocupa la máquina para el turno del pase \(el turno de las ejecuciones grandes .* no se puede leer/);
  assert.ok(C.status(t.opts).problems.some((p) => /turno de las ejecuciones grandes/.test(p)), 'el estado también lo dice');
});

// 🔴 mutación: dejar los dos renglones separados vuelve a decir que el pase y la suite pueden ir juntos.
test('T5 CoordinationStatus_OneHeavyTurnLine @story-8.228 @ac-4: un solo renglón de turno de tarea pesada, con quién lo tiene y qué es', () => {
  const t = toy();
  session(t, 'pase-1', 'ConPase', { status: 'busy' });
  passMarker(t, 'pase-1', '7.7', 12);
  const withPass = C.status(t.opts);
  assert.deepStrictEqual(withPass.heavyTurn, { kind: 'pass', storyId: '7.7', session: 'ConPase', since: new Date(mins(12)).toISOString() });
  const text = C.statusText(withPass);
  assert.match(text, /^Turno de tarea pesada: pase adversarial de la 7\.7 \(ConPase, desde las \d\d:\d\d\)$/m);
  assert.doesNotMatch(text, /Pase adversarial en vuelo|Suite completa en curso/);
  fs.unlinkSync(path.join(t.state, 'active', 'pase-1.json'));
  heavyRun(t, { sid: 'pase-1', session: 'ConPase', what: '279 suites de repo' });
  // con una corriendo, el renglón suma si entra una segunda (8.291): la memoria inyectada, para no depender de la máquina
  const withSuite = C.status({ ...t.opts, readMemory: reader(62) });
  assert.strictEqual(withSuite.heavyTurn.kind, 'suite');
  assert.match(C.statusText(withSuite), /^Turno de tarea pesada: ConPase \(279 suites de repo, desde las \d\d:\d\d\); segundo turno libre \(memoria libre 62 %, piso 50 %\)$/m);
});

// 🔴 mutación: seguir mirando `deepReviewDone` deja a un pase no medido frenando al de otra sesión.
test('T11 AdversarialTurn_NoMedidoPass_DoesNotBlockAnother @story-8.228 @ac-3: un pase no medido ya terminó y no frena a otro; relanzado, sí', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  designate(t, 'coord-1');
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  const noMedido = { adversarialPasses: [{ ts: new Date(mins(2)).toISOString(), tipo: '5b', veredicto: 'no-medido' }], deepReviewDone: false };
  passMarker(t, 'otra-2', '9.2', 5, noMedido);
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }), null);
  passMarker(t, 'otra-2', '9.2', 1, noMedido);
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }).waiting_turn, true);
});

// ── A finished pass nobody recorded ──────────────────────────────────────────────────────────────────────────────────

// The run record Claude Code leaves for a Workflow in the folder of the session that launched it. `raw` writes the text
// as is (an unreadable record).
function workflowRecord(t, sid, runId, status, { raw = null, folder = '-srv-repos-proyecto' } = {}) {
  const dir = path.join(claudeDir(t.home), 'projects', folder, sid, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId}.json`), raw !== null ? raw : JSON.stringify({ runId, status, workflowName: 'adversarial-verify' }));
}
function machineWithPass(t) {
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  designate(t, 'coord-1');
  session(t, 'otra-2', 'Vecina', { status: 'busy' });
  passMarker(t, 'otra-2', '9.2', 5);
}

// 🔴 mutación: mirar sólo el resultado anotado deja trabado el turno con un pase que ya terminó y nadie anotó.
test('T9 AdversarialTurn_FinishedWithoutResult_NotInFlight @story-8.277 @ac-10: un pase de otra sesión con su Workflow terminado no toma el turno, aunque nadie haya anotado su resultado', () => {
  for (const status of ['completed', 'killed']) {
    const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
    machineWithPass(t);
    workflowRecord(t, 'otra-2', 'wf_x', status);
    assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }), null, status);
    assert.deepStrictEqual(C.heavyPassesInFlight({ ...t.opts, sessionId: 'propia-1' }).passes, [], status);
  }
});

// 🔴 mutación: soltar el pase con cualquier registro, o sin él, deja lanzar dos pases a la vez.
test('T9 AdversarialTurn_Running_StillInFlight @story-8.277 @ac-12 @ac-21: sin registro, con otro estado o con uno ilegible, el pase sigue en vuelo', () => {
  const cases = [['sin registro', null], ['corriendo', { status: 'running' }], ['ilegible', { raw: '{ no es json' }], ['de otro pase', { status: 'completed', runId: 'wf_otro' }]];
  for (const [what, rec] of cases) {
    const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
    machineWithPass(t);
    if (rec) workflowRecord(t, 'otra-2', rec.runId || 'wf_x', rec.status || null, { raw: rec.raw == null ? null : rec.raw });
    const said = [];
    const write = process.stderr.write;
    process.stderr.write = (s) => { said.push(String(s)); return true; };
    let r;
    try { r = C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }); } finally { process.stderr.write = write; }
    assert.strictEqual(r.waiting_turn, true, what);
    // el ilegible se dice: «no pude mirar» no se lee igual que «no terminó»
    if (what === 'ilegible') assert.match(said.join(''), /no pude leer .*wf_x\.json .*el pase wf_x cuenta como en vuelo/, what);
    else assert.doesNotMatch(said.join(''), /no pude leer/, what);
  }
  // un nombre de sólo puntos no arma una ruta
  assert.strictEqual(C.passFinished({ home: toy().home, sessionId: '..', runId: 'wf_x' }), false);
  // la carpeta de los proyectos que no se puede leer: en vuelo, y se dice
  const t = toy();
  fs.writeFileSync(path.join(claudeDir(t.home), 'projects'), 'no es una carpeta');
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { said.push(String(s)); return true; };
  let fin;
  try { fin = C.passFinished({ home: t.home, sessionId: 'otra-2', runId: 'wf_x' }); } finally { process.stderr.write = write; }
  assert.strictEqual(fin, false);
  assert.match(said.join(''), /no pude leer .*projects .*el pase wf_x cuenta como en vuelo/);
});

// 🔴 mutación: tomar el reporte de la corrida como señal suelta el turno con un pase que todavía escribe.
test('T9 AdversarialTurn_PartialReport_StillInFlight @story-8.277 @ac-10 @ac-12: un reporte a medias en la carpeta de la corrida no es la señal de término', () => {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  machineWithPass(t);
  const run = path.join(t.root, 'repo', '.advisors', 'pipeline-runs', '9.2-x');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'step-05b-adversarial.json'), '{ "confirmed": [');
  assert.strictEqual(C.adversarialTurn({ ...t.opts, sessionId: 'propia-1' }).waiting_turn, true);
});

// 🔴 mutación: dejar el estado con su propio criterio dice «pase en vuelo» de una sesión que el turno ya da por libre.
test('T9b Status_FinishedPass_NotInFlight @story-8.277 @ac-10: el estado y el turno dicen lo mismo de un pase terminado sin anotar', () => {
  const t = toy();
  session(t, 'bg-pase', 'ConPase', { kind: 'bg', status: 'idle', statusUpdatedAt: mins(30) });
  passMarker(t, 'bg-pase', '9.5', 25);
  const before = C.status({ ...t.opts, noTranscripts: true });
  assert.strictEqual(before.heavyTurn && before.heavyTurn.kind, 'pass');
  assert.deepStrictEqual(before.quiet, []);
  workflowRecord(t, 'bg-pase', 'wf_x', 'completed');
  const after = C.status({ ...t.opts, noTranscripts: true });
  assert.strictEqual(after.heavyTurn, null, JSON.stringify(after.heavyTurn));
  assert.deepStrictEqual(after.adversarial, []);
  assert.deepStrictEqual(after.quiet.map((q) => q.session), ['ConPase']);
});

// `pipeline.js next` with a toy run marker of this session: the pass launched by itself, the tests closed.
const PIPELINE = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js');
const ALL_STEPS = ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'];
function nextWithOwnPass(t, { pending, exempt = false, status = 'completed' }) {
  const repo = path.join(t.root, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const story = path.join(repo, 'specs', 'story-9.1.md');
  fs.writeFileSync(story, ['---', 'story: "9.1"', 'epic: 9', 'status: in-progress', ...(exempt ? ['dod_runtime_exempt: true', 'dod_runtime_exempt_reason: "de juguete"'] : []), '---', '', '# Story 9.1', '', '## Acceptance Criteria', '', '1. algo', ''].join('\n'));
  marker(t, 'propia-1', {
    storyId: '9.1', storyPath: story, repoPath: repo, startedAt: new Date(mins(60)).toISOString(),
    stepScheme: 2, stepsCompleted: ALL_STEPS.filter((s) => !pending.includes(s)), stepsPending: pending, timeTrackingDone: true,
    adversarial: { launchedAtStep: 'run-tests', runId: 'wf_own', sessionId: 'propia-1', launchedAt: new Date(mins(20)).toISOString() },
  });
  workflowRecord(t, 'propia-1', 'wf_own', status);
  const env = { ...process.env, HOME: t.home, CLAUDE_CODE_SESSION_ID: 'propia-1' };
  for (const k of ['TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_5B_EARLY', 'TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS']) delete env[k];
  const r = spawnSync(process.execPath, [PIPELINE, 'next'], { encoding: 'utf8', env, cwd: repo });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// 🔴 mutación: dejar el pedido sólo en el JSON hace que la instrucción diga «Sigue …» sin pedir que se anote.
test('T10 Next_OwnFinishedPassWithoutResult_AsksToRecord @story-8.277 @ac-11: la dueña del pase terminado recibe el pedido de anotarlo, en la instrucción y antes del paso, en sus tres formas', () => {
  const forms = [['con paso que sigue', { pending: ['reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'] }],
    ['con «Probar en vivo» exenta', { pending: ['live-check', 'prepare-commit'], exempt: true }],
    ['sin pasos pendientes', { pending: [] }]];
  for (const [what, opts] of forms) {
    const n = nextWithOwnPass(toy(), opts);
    assert.strictEqual(n.pending_action && n.pending_action.kind, 'anotar-resultado-del-pase', `${what}: ${JSON.stringify(n.pending_action)}`);
    assert.match(n.pending_action.message, /mark-adversarial-result/, what);
    const at = n.note.indexOf('ANTES, pase adversarial:');
    assert.ok(at >= 0, `${what}: ${n.note}`);
    assert.match(n.note.slice(at), /mark-adversarial-result/, what);
    const step = n.note.search(/Sigue «|No quedan pasos pendientes/);
    assert.ok(step > at, `${what}: el pedido va antes del paso — ${n.note}`);
  }
  // corriendo todavía: nada de eso, como hoy
  const running = nextWithOwnPass(toy(), { pending: ['reviewers', 'adversarial-pass', 'findings', 'live-check', 'prepare-commit'], status: 'running' });
  assert.ok(!running.pending_action || running.pending_action.kind !== 'anotar-resultado-del-pase', JSON.stringify(running.pending_action));
  assert.doesNotMatch(running.note, /ANTES, pase adversarial:/);
});

// ── Opening in a sibling copy ────────────────────────────────────────────────────────────────────────────────────

const copyOf = (repo, name) => `${repo}--wt-${name}`;
const branchExists = (repo, b) => spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`], { encoding: 'utf8' }).status === 0;
// A toy launcher that counts its calls (one line each) and answers as told.
function countingLauncher(t, behavior = 'ok') {
  const script = path.join(t.root, 'counting-launcher.js');
  fs.writeFileSync(script, `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(t.root, 'calls.log'))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (${JSON.stringify(behavior)} === 'untrusted') { process.stderr.write('Error: Workspace not trusted. Open it once to trust it.\\n'); process.exit(1); }
`);
  return { bin: process.execPath, prefix: [script] };
}
const calls = (t) => { try { return fs.readFileSync(path.join(t.root, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const slotsOf = (repo) => fs.readdirSync(path.dirname(repo)).filter((d) => d.startsWith(`${path.basename(repo)}--slot-`));

test('8.187 T1 Open_ConRepo_CreaCopiaHermana_YAbreAhi @story-8.187 @ac-1: crea <repo>--wt-<nombre> desde origin/main y abre ahí; el encargo nombra copia y rama, pide el pedido abierto y no habla de puestos', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'implementá la 9.9', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  const copy = copyOf(repo, 'n1');
  const l = launched(t);
  assert.strictEqual(fs.realpathSync(l.cwd), copy);
  assert.strictEqual(branchIn(copy), 'wt/n1');
  assert.strictEqual(gitToy(copy, 'rev-parse', 'HEAD'), gitToy(repo, 'rev-parse', 'origin/main'));
  const job = l.argv[l.argv.length - 1];
  assert.match(job, /^implementá la 9\.9/);
  assert.ok(job.includes(copy), job);
  assert.ok(job.includes('wt/n1'), job);
  assert.match(job, /commiteado, empujado y con su pedido abierto/);
  assert.doesNotMatch(job, /puesto|work-slots/);
  assert.ok(r.message.includes(copy), r.message);
  // con --branch, la rama es ésa
  const b = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, name: 'n2', branch: 'feat/x', task: 'otra', launcher: launcher(t) });
  assert.strictEqual(b.ok, true, b.message);
  assert.strictEqual(branchIn(copyOf(repo, 'n2')), 'feat/x');
  assert.deepStrictEqual(slotsOf(repo), [], 'no crea puestos');
});

test('8.187 T2 Open_ConSlot_TomaUnPuesto @story-8.187 @ac-2: con --slot toma un puesto como hoy; sin él no se crea ninguno; la línea de comandos lee --slot sin valor', () => {
  const t = toy({ profile: { coordination: { max_working: 2 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, slot: true, name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(fs.realpathSync(launched(t).cwd), slotOf(repo, 1));
  assert.ok(!fs.existsSync(copyOf(repo, 'n1')), 'con --slot no hay copia');
  const t2 = toy({ profile: { coordination: { max_working: 2 } } });
  const repo2 = toyRepo(t2);
  assert.strictEqual(C.open({ ...t2.opts, ...caller(t2), repo: repo2, name: 'n1', task: 'algo', launcher: launcher(t2) }).ok, true);
  assert.deepStrictEqual(slotsOf(repo2), []);
  // la línea de comandos: --slot no se come el argumento siguiente ni pide un valor
  const f = C.flags(['--name', 'x', '--repo', '/r', '--slot', '--', 'el encargo entero']);
  assert.strictEqual(f.slot, true);
  assert.strictEqual(f.repo, '/r');
  assert.deepStrictEqual(f.rest, ['el encargo entero']);
  assert.strictEqual(C.flags(['--repo', '/r', '--slot']).slot, true);
});

test('8.187 T3 Open_FallaDelLanzador_BorraLoQueCreo @story-8.187 @ac-3: una falla del lanzador que no es «not trusted» borra la copia y la rama nueva; una rama que ya existía queda', () => {
  // «not trusted» ya no borra: deja la carpeta para que una persona la apruebe (fila 159, F159 T1)
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: launcher(t, 'error') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(launched(t).cwd, copyOf(repo, 'n1'), 'probó en la copia hermana');
  assert.ok(!fs.existsSync(copyOf(repo, 'n1')), 'la copia no queda');
  assert.strictEqual(branchExists(repo, 'wt/n1'), false, 'la rama nueva no queda');
  gitToy(repo, 'branch', 'feat/existe', 'origin/main');
  const r2 = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, name: 'n2', branch: 'feat/existe', task: 'algo', launcher: launcher(t, 'error') });
  assert.strictEqual(r2.ok, false);
  assert.ok(!fs.existsSync(copyOf(repo, 'n2')), 'la copia no queda');
  assert.strictEqual(branchExists(repo, 'feat/existe'), true, 'la rama que ya existía queda');
});

test('8.187 T4 Open_NotTrusted_NombraLaCopia @story-8.187 @ac-4: una línea que nombra la copia (no culpa a la principal) y cómo reintentar reusándola; una sola llamada; ~/.claude.json igual', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const cfg = path.join(t.home, '.claude.json');
  fs.writeFileSync(cfg, '{ esto no es json');
  const antes = fs.readFileSync(cfg);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: countingLauncher(t, 'untrusted') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message.trim().split('\n').length, 1, r.message);
  assert.ok(r.message.includes(`cd '${copyOf(repo, 'n1')}'`), `nombra la copia: ${r.message}`);
  assert.doesNotMatch(r.message, /falta aprobar la carpeta principal/, r.message);
  assert.doesNotMatch(r.message, /--slot-\d/, 'no habla de un puesto');
  assert.match(r.message, /--reuse\b/, 'dice cómo reintentar reusándola');
  assert.strictEqual(calls(t).length, 1, 'no reintenta');
  assert.strictEqual(calls(t)[0].cwd, copyOf(repo, 'n1'), 'lo intentó en la copia hermana');
  assert.deepStrictEqual(fs.readFileSync(cfg), antes, 'no toca ~/.claude.json');
});

test('8.187 T5 Open_CopiaORamaExistente_SeNiega @story-8.187 @ac-5: con la copia o la rama wt/<nombre> ya presentes se niega y no toca nada', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const copy = copyOf(repo, 'n1');
  fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, 'de-otra.txt'), 'algo\n');
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /ya existe/);
  assert.strictEqual(r.message.trim().split('\n').length, 1);
  assert.deepStrictEqual(fs.readdirSync(copy), ['de-otra.txt']);
  assert.strictEqual(calls(t).length, 0);
  gitToy(repo, 'branch', 'wt/n2', 'origin/main');
  const tip = gitToy(repo, 'rev-parse', 'wt/n2');
  const r2 = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, name: 'n2', task: 'algo', launcher: countingLauncher(t) });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.message, /ya existe/);
  assert.ok(!fs.existsSync(copyOf(repo, 'n2')));
  assert.strictEqual(gitToy(repo, 'rev-parse', 'wt/n2'), tip);
  assert.strictEqual(calls(t).length, 0);
});

test('8.187 T16 Open_FallaGit_NoAbre_LoDice @story-8.187 @ac-15: fetch o worktree add que fallan: un renglón con el error y el lanzador no se llama', { skip: process.platform === 'win32' ? 'permisos POSIX' : false }, () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  gitToy(repo, 'remote', 'set-url', 'origin', path.join(t.root, 'no-esta.git'));
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message.trim().split('\n').length, 1, r.message);
  assert.match(r.message, /origin|main|repository|repositorio/i);
  assert.match(r.message, /no la abrí/);
  assert.ok(!fs.existsSync(copyOf(repo, 'n1')), 'sin red no crea la copia desde una punta vieja');
  assert.strictEqual(calls(t).length, 0);
  // worktree add que falla: la carpeta de los repos sin permiso de escritura
  const t2 = toy({ profile: { coordination: { max_working: 3 } } });
  const repo2 = toyRepo(t2);
  const parent = path.dirname(repo2);
  fs.chmodSync(parent, 0o555);
  try {
    const r2 = C.open({ ...t2.opts, ...caller(t2), repo: repo2, name: 'n1', task: 'algo', launcher: countingLauncher(t2) });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.message.trim().split('\n').length, 1, r2.message);
    assert.match(r2.message, /no la abrí/);
    assert.strictEqual(calls(t2).length, 0);
    assert.strictEqual(branchExists(repo2, 'wt/n1'), false, 'la rama a medias no queda');
  } finally { fs.chmodSync(parent, 0o755); }
});

test('8.187 T17 Open_ConCwd_Y_TopeSinCambios @story-8.187 @ac-16: --cwd abre como hoy; el tope cuenta igual una sesión en una copia', () => {
  const t = toy({ profile: { coordination: { max_working: 1 } } });
  const repo = toyRepo(t);
  const r = open(t, { name: 'c1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(fs.realpathSync(launched(t).cwd), fs.realpathSync(t.root));
  const t2 = toy({ profile: { coordination: { max_working: 1 } } });
  const repo2 = toyRepo(t2);
  session(t2, 'busy-copia', 'otra', { status: 'busy', cwd: copyOf(repo2, 'otra') });
  const r2 = C.open({ ...t2.opts, ...caller(t2), repo: repo2, name: 'n1', task: 'algo', launcher: countingLauncher(t2) });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.message, /1 trabajando.*tope.*1/);
  assert.strictEqual(calls(t2).length, 0);
  assert.ok(!fs.existsSync(copyOf(repo2, 'n1')), 'en el tope no crea la copia');
  assert.ok(repo);
});

test('8.187 T6 Barrido_CopiaHermana_LaSacaSoloMergeada @story-8.187 @ac-6: el barrido saca la copia mergeada y la que no tiene trabajo con main adelante; deja y nombra la que tiene commits', () => {
  const t = toy();
  const repo = toyRepo(t);
  const mk = (name) => { const c = copyOf(repo, name); gitToy(repo, 'worktree', 'add', '-q', '-b', `wt/${name}`, c, 'origin/main'); return c; };
  const mergeada = mk('mergeada');
  fs.writeFileSync(path.join(mergeada, 'm.txt'), 'm\n');
  gitToy(mergeada, 'add', 'm.txt');
  gitToy(mergeada, 'commit', '-q', '-m', 'trabajo mergeado');
  const vacia = mk('vacia');
  const conTrabajo = mk('con-trabajo');
  fs.writeFileSync(path.join(conTrabajo, 'c.txt'), 'c\n');
  gitToy(conTrabajo, 'add', 'c.txt');
  gitToy(conTrabajo, 'commit', '-q', '-m', 'trabajo sin mergear');
  // la mergeada entra a main, y main avanza: la vacía queda atrás
  gitToy(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'wt/mergeada');
  gitToy(repo, 'push', '-q', 'origin', 'HEAD:main');
  gitToy(repo, 'fetch', '-q', 'origin');
  const SWEEP = path.join(ROOT, 'scripts', 'hooks', 'worktree-sweep.js');
  const r = spawnSync(process.execPath, [SWEEP, '--force'], {
    cwd: t.root, encoding: 'utf8',
    env: { ...GIT_ENV, HOME: t.home, USERPROFILE: t.home, TYCON_REPOS_ROOT: path.dirname(repo), TYCON_WORKTREE_SWEEP_IDLE_HOURS: '0', TYCON_WORKTREE_SWEEP: '', TYCON_EVAL_SANDBOX: '' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(mergeada), `la mergeada sigue: ${r.stdout}`);
  assert.ok(!fs.existsSync(vacia), `la vacía sigue: ${r.stdout}`);
  assert.ok(fs.existsSync(conTrabajo), 'borró la que tiene commits');
  assert.match(r.stdout, /con-trabajo/);
});

test('8.187 T18 Cierre_CopiaSinEmpujar_NoEstaLimpia @story-8.187 @ac-17: la copia con un commit sin empujar no está limpia y se nombra, sin hablar de puestos', () => {
  const t = closeLab();
  const copy = `${t.repo}--wt-n1`;
  git(t.repo, 'worktree', 'add', '-q', '-b', 'wt/n1', copy);
  commitIn(copy);
  bg(t, 'n1', copy);
  const r = closeIt(t, 'n1');
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /1 commit\(s\) sin empujar/);
  assert.ok(r.message.includes(copy), r.message);
  assert.doesNotMatch(r.message, /puesto/);
  assert.deepStrictEqual(closed(t), []);
  assert.ok(fs.existsSync(copy), 'el cierre no borra la copia');
});

test('8.187 T19 Guias_NoDescribenElCaminoViejo @story-8.187 @ac-18: pending-trust y los puestos aparecen sólo en la sección de la opción --slot', () => {
  const PAGES = ['guides/coordination.md', 'guides/coordination.en.md', 'guides/working-with-a-coordinator.md', 'guides/working-with-a-coordinator.en.md', 'guides/git-worktrees.md', 'INSTALL.md', 'getting-started/reference.md', 'getting-started/reference.es.md'];
  const OLD = /pending-trust|\bpuestos? fijos?\b|\bfixed (work )?slots?\b|work-slots\.js/i;
  const SLOT_SECTION = /--slot/;
  for (const rel of PAGES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // cada sección (título ## o ###) con el camino viejo tiene que ser la de la opción --slot
    const sections = text.split(/\n(?=#{2,3} )/);
    for (const s of sections) {
      if (!OLD.test(s)) continue;
      const title = s.split('\n')[0];
      assert.match(`${title}\n${s}`, SLOT_SECTION, `${rel}: la sección «${title.slice(0, 80)}» describe los puestos sin la opción --slot`);
      assert.match(title, /--slot|slot|puesto/i, `${rel}: «${title.slice(0, 80)}» habla de puestos fuera de la sección de --slot`);
    }
  }
});

test('8.187 T3b Open_FallaDelLanzador_SinPoderBorrar_LoDice @story-8.187 @ac-3: si la copia no se puede borrar, el mensaje no dice «borré»: dice que queda para el barrido', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  // el lanzador bloquea la copia antes de fallar: `worktree remove --force` no saca una bloqueada
  const script = path.join(t.root, 'locking-launcher.js');
  fs.writeFileSync(script, `
require('child_process').spawnSync('git', ['worktree', 'lock', process.cwd()], { cwd: process.cwd() });
process.stderr.write('boom: algo salió mal\\n'); process.exit(4);
`);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: { bin: process.execPath, prefix: [script] } });
  assert.strictEqual(r.ok, false);
  assert.doesNotMatch(r.message, /Borré la copia/, r.message);
  assert.match(r.message, /No pude borrar la copia .*barrido/, r.message);
  spawnSync('git', ['-C', repo, 'worktree', 'unlock', copyOf(repo, 'n1')]);
});

// ── Fila 159: Claude Code 2.1.330 asks to approve each copy and slot, even with the main folder approved ─────────────

const UNTRUSTED_LINE = 'Error: Workspace not trusted. Open it once to trust it.';

test('F159 T1 Open_CopiaSinAprobar_LaDejaYDiceCómoAprobarla: «not trusted» deja la copia y su rama, nombra la copia (no la principal), dice cómo aprobarla y cómo reintentar, y trae lo que dijo Claude Code', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const copy = copyOf(repo, 'n1');
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: countingLauncher(t, 'untrusted') });
  assert.strictEqual(r.ok, false);
  assert.ok(fs.existsSync(copy), 'la copia queda para que la aprueben');
  assert.strictEqual(branchIn(copy), 'wt/n1', 'con su rama');
  assert.strictEqual(r.message.trim().split('\n').length, 1, r.message);
  assert.ok(r.message.includes(`cd '${copy}'`), r.message);
  assert.match(r.message, /no está aprobada en esta versión de Claude Code/);
  assert.match(r.message, /una persona/);
  assert.doesNotMatch(r.message, /falta aprobar la carpeta principal|Borré/, r.message);
  assert.ok(r.message.includes(UNTRUSTED_LINE), `trae lo que dijo Claude Code: ${r.message}`);
  // el comando para reintentar es uno que la línea de comandos entiende
  const cmd = r.message.match(/open (--name .*?) -- /);
  assert.ok(cmd, r.message);
  const f = C.flags(cmd[1].match(/'[^']*'|\S+/g).map((x) => x.replace(/^'|'$/g, '')));
  assert.strictEqual(f.name, 'n1');
  assert.strictEqual(f.repo, repo);
  assert.strictEqual(f.reuse, true);
  assert.notStrictEqual(f.slot, true);
  assert.match(r.message, new RegExp(`worktree remove '${escapar(copy)}'`), 'dice cómo sacarla si no se usa');
  assert.strictEqual(calls(t).length, 1, 'no reintenta');
});

test('F159 T2 Open_PuestoSinAprobar_QuedaTomado: «not trusted» deja el puesto tomado y con su rama; el mensaje dice cómo aprobarlo, reintentar o soltarlo', () => {
  const t = toy({ profile: { coordination: { max_working: 2 } } });
  const repo = toyRepo(t);
  const r = C.open({ ...t.opts, ...caller(t), repo, slot: true, name: 'n1', task: 'algo', launcher: launcher(t, 'untrusted') });
  assert.strictEqual(r.ok, false);
  const s1 = WS.list({ ...t.opts, repo }).slots[0];
  assert.strictEqual(s1.free, false, 'el puesto sigue tomado');
  assert.strictEqual(s1.branch, 'wt/n1', 'con su rama');
  assert.strictEqual(branchExists(repo, 'wt/n1'), true);
  assert.strictEqual(r.message.trim().split('\n').length, 1, r.message);
  assert.ok(r.message.includes(`cd '${slotOf(repo, 1)}'`), r.message);
  assert.match(r.message, /no está aprobada en esta versión de Claude Code/);
  assert.match(r.message, /--slot --reuse/);
  assert.ok(r.message.includes(`release '${slotOf(repo, 1)}'`), r.message);
  assert.ok(r.message.includes(UNTRUSTED_LINE), r.message);
  assert.doesNotMatch(r.message, /carpeta principal/);
});

test('F159 T3 Open_Reuse_AbreEnLaMismaCarpeta: después de aprobarla, --reuse abre en la misma copia o el mismo puesto, sin crear otra carpeta', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const copy = copyOf(repo, 'n1');
  assert.strictEqual(C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: launcher(t, 'untrusted') }).ok, false);
  // lo que deja quien la aprueba (sin commitear) sigue ahí: es la misma carpeta, no una nueva con el mismo nombre
  fs.writeFileSync(path.join(copy, 'de-la-aprobacion.txt'), 'x\n');
  const r = C.open({ ...t.opts, ...caller(t), now: NOW + 1000, repo, name: 'n1', reuse: true, task: 'implementá la 9.9', launcher: launcher(t) });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(fs.realpathSync(launched(t).cwd), copy);
  assert.ok(fs.existsSync(path.join(copy, 'de-la-aprobacion.txt')), 'la misma copia');
  const job = launched(t).argv[launched(t).argv.length - 1];
  assert.ok(job.includes(copy) && job.includes('wt/n1'), job);
  assert.match(job, /commiteado, empujado y con su pedido abierto/);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(repo)).filter((d) => d.includes('--wt-')), ['proyecto--wt-n1'], 'no crea otra copia');
  // con un puesto: el mismo puesto, y el otro sigue libre
  const t2 = toy({ profile: { coordination: { max_working: 2 } } });
  const repo2 = toyRepo(t2);
  assert.strictEqual(C.open({ ...t2.opts, ...caller(t2), repo: repo2, slot: true, name: 'n1', task: 'algo', launcher: launcher(t2, 'untrusted') }).ok, false);
  assert.strictEqual(branchIn(slotOf(repo2, 1)), 'wt/n1', 'el puesto quedó tomado para reintentar');
  const r2 = C.open({ ...t2.opts, ...caller(t2), now: NOW + 1000, repo: repo2, slot: true, reuse: true, name: 'n1', task: 'algo', launcher: launcher(t2) });
  assert.strictEqual(r2.ok, true, r2.message);
  assert.strictEqual(fs.realpathSync(launched(t2).cwd), slotOf(repo2, 1));
  assert.match(launched(t2).argv[launched(t2).argv.length - 1], /release/);
  assert.strictEqual(WS.list({ ...t2.opts, repo: repo2 }).slots[1].free, true, 'no toma otro puesto');
});

test('F159 T4 Open_Reuse_SeNiegaSinCarpetaOConOtraSesion: --reuse sin repo, sin nombre, sin carpeta que reusar, en otra rama o con una sesión viva ahí no abre; si el lanzador falla, no borra lo reusado', () => {
  const t = toy({ profile: { coordination: { max_working: 3, session_names: ['Norte'] } } });
  const repo = toyRepo(t);
  const copy = copyOf(repo, 'n1');
  const sinRepo = C.open({ ...t.opts, ...caller(t), cwd: t.root, reuse: true, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.match(sinRepo.message, /--reuse va con --repo/);
  const sinNombre = C.open({ ...t.opts, ...caller(t), repo, reuse: true, task: 'algo', launcher: countingLauncher(t) });
  assert.match(sinNombre.message, /--reuse va con --name/);
  const nada = C.open({ ...t.opts, ...caller(t), repo, reuse: true, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.strictEqual(nada.ok, false);
  assert.match(nada.message, /no hay qué reusar/);
  const nadaSlot = C.open({ ...t.opts, ...caller(t), repo, slot: true, reuse: true, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.match(nadaSlot.message, /no hay qué reusar/);
  assert.strictEqual(calls(t).length, 0);
  // la copia en otra rama no es la de este trabajo
  gitToy(repo, 'worktree', 'add', '-q', '-b', 'otra', copy, 'origin/main');
  const otraRama = C.open({ ...t.opts, ...caller(t), repo, reuse: true, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.strictEqual(otraRama.ok, false);
  assert.match(otraRama.message, /rama otra/);
  gitToy(copy, 'switch', '-q', '-c', 'wt/n1');
  // la persona la aprobó y dejó claude abierto ahí: dos sesiones en la misma carpeta no
  session(t, 'aprobando', 'aprueba', { cwd: copy });
  const viva = C.open({ ...t.opts, ...caller(t), repo, reuse: true, name: 'n1', task: 'algo', launcher: countingLauncher(t) });
  assert.strictEqual(viva.ok, false);
  assert.match(viva.message, /sesión viva/);
  assert.strictEqual(calls(t).length, 0);
  fs.rmSync(path.join(t.home, '.claude', 'sessions', 'aprobando.json'));
  const falla = C.open({ ...t.opts, ...caller(t), repo, reuse: true, name: 'n1', task: 'algo', launcher: launcher(t, 'error') });
  assert.strictEqual(falla.ok, false);
  assert.ok(fs.existsSync(copy), 'no borra una copia que no creó');
  assert.strictEqual(branchExists(repo, 'wt/n1'), true);
  // la línea de comandos lee --reuse sin valor
  const f = C.flags(['--name', 'n1', '--repo', '/r', '--reuse', '--', 'el encargo']);
  assert.strictEqual(f.reuse, true);
  assert.deepStrictEqual(f.rest, ['el encargo']);
});

test('F159 T5 Open_CarpetaSinAprobar_TraeLoQueDijoClaudeCode: con --cwd, el mensaje de siempre más la primera línea cruda de Claude Code, recortada', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t, 'untrusted') });
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes(UNTRUSTED_LINE), r.message);
  assert.strictEqual(r.message.trim().split('\n').length, 1);
  const largo = path.join(t.root, 'largo.js');
  fs.writeFileSync(largo, `process.stderr.write('\\n  Workspace not trusted: ' + 'x'.repeat(500) + '\\notra línea\\n'); process.exit(1);`);
  const r2 = open(t, { name: 'n2', task: 'algo', launcher: { bin: process.execPath, prefix: [largo] } });
  assert.ok(r2.message.includes('Workspace not trusted: xxx'), r2.message);
  assert.doesNotMatch(r2.message, /x{300}/, 'recortada');
  assert.doesNotMatch(r2.message, /otra línea/);
});

// What the shell reads from a pasted command: each word on its own line, with nothing run.
function shellWords(t, args) {
  const r = spawnSync('sh', ['-c', `printf '%s\\n' ${args}`], { cwd: t.root, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, '').split('\n');
}

test('F159 T6 Open_CitaLaLineaQueDiceNotTrusted: la cita es la línea que dice «not trusted», no un aviso que salió antes', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const script = path.join(t.root, 'aviso-antes.js');
  fs.writeFileSync(script, `process.stderr.write('Update available\\n(node) DeprecationWarning: algo viejo\\nError: Workspace not trusted.\\n'); process.exit(1);`);
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: { bin: process.execPath, prefix: [script] } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('Claude Code dijo: «Error: Workspace not trusted.»'), r.message);
  assert.doesNotMatch(r.message, /Update available|DeprecationWarning/);
  // con --cwd, lo mismo
  const r2 = open(t, { name: 'n2', task: 'algo', launcher: { bin: process.execPath, prefix: [script] } });
  assert.ok(r2.message.includes('Claude Code dijo: «Error: Workspace not trusted.»'), r2.message);
});

test('F159 T7 Open_CitaLimpia: la cita sale sin secuencias de terminal enteras ni caracteres de control, y el recorte no parte un carácter', () => {
  const t = toy();
  const color = path.join(t.root, 'color.js');
  fs.writeFileSync(color, `process.stderr.write('\\x1b[31mError:\\x1b[0m Workspace \\x1b]0;titulo\\x07not trusted\\u202e\\x07 fin\\r\\n'); process.exit(1);`);
  const r = open(t, { name: 'n1', task: 'algo', launcher: { bin: process.execPath, prefix: [color] } });
  assert.ok(r.message.includes('«Error: Workspace not trusted fin»'), JSON.stringify(r.message));
  assert.doesNotMatch(r.message, /\[31m|\[0m|titulo|[\u0000-\u001f\u007f-\u009f\u202e]/, JSON.stringify(r.message));
  // 199 letras y un emoji: el recorte de 200 caracteres deja el emoji entero
  const emoji = path.join(t.root, 'emoji.js');
  fs.writeFileSync(emoji, `process.stderr.write('a'.repeat(199) + '\\u{1F600}' + 'resto Workspace not trusted\\n'); process.exit(1);`);
  const r2 = open(t, { name: 'n2', task: 'algo', launcher: { bin: process.execPath, prefix: [emoji] } });
  assert.ok(r2.message.includes(`${'a'.repeat(199)}\u{1F600}…`), r2.message);
  assert.doesNotMatch(r2.message, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'medio emoji');
});

test('F159 T8 Open_ComandosCitadosParaElShell: el reintento, el cd y el soltar llevan cada valor entre comillas simples; pegados, no corren nada', { skip: process.platform === 'win32' ? 'sh' : false }, () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const branch = "a'b;touch${IFS}pwn";
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', branch, task: 'algo', launcher: launcher(t, 'untrusted') });
  assert.strictEqual(r.ok, false);
  const retry = r.message.match(/ open (.*?) -- <el mismo encargo>/);
  assert.ok(retry, r.message);
  assert.deepStrictEqual(shellWords(t, retry[1]), ['--name', 'n1', '--repo', repo, '--branch', branch, '--reuse']);
  const cd = r.message.match(/ cd ('(?:[^']|'\\'')*')/);
  assert.ok(cd, r.message);
  assert.deepStrictEqual(shellWords(t, cd[1]), [copyOf(repo, 'n1')]);
  const remove = r.message.match(/git -C (.*?) worktree remove ('(?:[^']|'\\'')*')/);
  assert.ok(remove, r.message);
  assert.deepStrictEqual(shellWords(t, `${remove[1]} ${remove[2]}`), [repo, copyOf(repo, 'n1')]);
  assert.ok(!fs.existsSync(path.join(t.root, 'pwn')), 'pegarlo no corrió nada');
  // el puesto: soltarlo también va citado
  const t2 = toy({ profile: { coordination: { max_working: 1 } } });
  const repo2 = toyRepo(t2);
  const r2 = C.open({ ...t2.opts, ...caller(t2), repo: repo2, slot: true, name: 'n1', task: 'algo', launcher: launcher(t2, 'untrusted') });
  const rel = r2.message.match(/node ('(?:[^']|'\\'')*') release ('(?:[^']|'\\'')*')/);
  assert.ok(rel, r2.message);
  assert.deepStrictEqual(shellWords(t2, `${rel[1]} ${rel[2]}`), [path.join(ROOT, 'scripts', 'tools', 'work-slots.js'), slotOf(repo2, 1)]);
});

test('F159 T9 Open_SinRespuesta_DiceCómoSacarLoQueCreó: si el lanzador no vuelve, no borra nada y dice cómo sacar la copia o soltar el puesto si no abrió', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const repo = toyRepo(t);
  const copy = copyOf(repo, 'n1');
  const r = C.open({ ...t.opts, ...caller(t), repo, name: 'n1', task: 'algo', launcher: launcher(t, 'hang'), timeoutMs: 400 });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /no sé si abrió/);
  assert.ok(fs.existsSync(copy), 'no borra: no se sabe si abrió');
  assert.ok(r.message.includes(`worktree remove '${copy}'`), r.message);
  assert.strictEqual(r.message.trim().split('\n').length, 1);
  const t2 = toy({ profile: { coordination: { max_working: 1 } } });
  const repo2 = toyRepo(t2);
  const r2 = C.open({ ...t2.opts, ...caller(t2), repo: repo2, slot: true, name: 'n1', task: 'algo', launcher: launcher(t2, 'hang'), timeoutMs: 400 });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(WS.list({ ...t2.opts, repo: repo2 }).slots[0].free, false, 'el puesto sigue tomado');
  assert.ok(r2.message.includes(`release '${slotOf(repo2, 1)}'`), r2.message);
  // con --cwd no creó nada: el mensaje de siempre
  const r3 = open(t, { name: 'n3', task: 'algo', launcher: launcher(t, 'hang'), timeoutMs: 400 });
  assert.doesNotMatch(r3.message, /worktree remove|release/);
});

test('8.187 T5b Open_NombreAuto_SaltaLasCopiasQueQuedaron @story-8.187 @ac-5: sin --name no elige un nombre cuya copia todavía existe, aunque su rama sea otra', () => {
  const t = toy({ profile: { coordination: { max_working: 3, session_names: ['Norte', 'Sur'] } } });
  const repo = toyRepo(t);
  const first = C.open({ ...t.opts, ...caller(t), repo, branch: 'feat/a', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(first.ok, true, first.message);
  assert.ok(fs.existsSync(copyOf(repo, 'Norte')));
  // once minutos después la sesión ya no está viva y su apertura salió de las recientes; la copia quedó
  const second = C.open({ ...t.opts, ...caller(t), now: NOW + 11 * 60000, repo, task: 'algo', launcher: launcher(t) });
  assert.strictEqual(second.ok, true, second.message);
  assert.ok(fs.existsSync(copyOf(repo, 'Sur')), second.message);
});

test('8.187 T16b Open_SlotSinRepo_SeNiega @story-8.187 @ac-2: --slot sin --repo no se ignora en silencio', () => {
  const t = toy({ profile: { coordination: { max_working: 3 } } });
  const r = C.open({ ...t.opts, ...caller(t), cwd: t.root, slot: true, name: 'n1', task: 'algo', launcher: launcher(t) });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /--slot va con --repo/);
});

test('8.212 T11 Guia_LaReglaDiceFreno @story-8.212 @ac-10: la regla de no cambiar archivos la mide un freno, con su límite, en las dos guías', () => {
  const fila = (f, regla) => fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(`| ${regla} |`)) || '';
  const es = fila(GUIDE, 'La coordinadora no cambia código ni guías ella misma');
  const en = fila(GUIDE_EN, 'The coordinator does not change code or guides itself');
  assert.match(es, /\| freno \|/, es);
  assert.match(en, /\| freno \|/, en);
  // the limit: what a script saved in a file writes from inside is left out on purpose
  assert.match(es, /guion guardado en un archivo/i, es);
  assert.match(en, /script saved in a file/i, en);
});

test('8.289 T7 Guia_LaSesionQueEspera_EnLosDosIdiomas @story-8.289 @ac-10: la regla está en las reglas del día a día y su renglón en qué mide cada regla, en las dos guías', () => {
  const section = (f, from, to) => { const t = fs.readFileSync(f, 'utf8'); return (t.split(from)[1] || '').split(to)[0]; };
  const es = section(GUIDE, '## Las reglas del día a día', '## Qué mide cada regla');
  const en = section(GUIDE_EN, '## The everyday rules', '## What measures each rule');
  assert.match(es, /\*\*Una sesión que espera \(la CI, la cola o una firma\) no queda quieta\.\*\* La coordinadora le da lo liviano de la fila:\s+papeleo, choques, borradores\. Una historia nueva con pipeline va en una sesión nueva, no en la que espera, que sólo\s+vigila su pedido y se cierra al entrar\. Con dos o más esperando el portón, la coordinadora para las últimas de la fila\s+y reabre una ejecución detenida con plan firmado\. Por qué:/);
  assert.match(en, /\*\*A session that waits \(the CI, the queue or a signature\) does not sit idle\.\*\*[\s\S]*?a new session, not in the one that\s+waits[\s\S]*?reopens a stopped run with a signed plan\. Why:/);
  const fila = (f, regla) => fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(`| ${regla} |`)) || '';
  assert.match(fila(GUIDE, 'Una sesión que espera recibe lo liviano'), /\| aviso \| El aviso de cada turno de la coordinadora/);
  assert.match(fila(GUIDE_EN, 'A waiting session gets the light work'), /\| aviso \| The coordinator's notice on each turn/);
});

test('8.307 T16 Guia_MaquinaLlena_EnLosDosIdiomas @story-8.307 @ac-18: la regla, keep-free, los 30 minutos, los tres bloqueos y su renglón freno, en las dos guías', () => {
  const flat = (f, from, to) => { const t = fs.readFileSync(f, 'utf8'); return ((t.split(from)[1] || '').split(to)[0]).replace(/\s+/g, ' '); };
  const es = flat(GUIDE, '## Las reglas del día a día', '## Qué mide cada regla');
  const en = flat(GUIDE_EN, '## The everyday rules', '## What measures each rule');
  assert.ok(es.includes('**Con lugar, memoria y trabajo listo, la coordinadora no cierra su turno.** Abre o retoma sesiones, o anota por qué no con `coordination.js keep-free`. Parar sesiones para cuidar la memoria no cuenta: el piso para abrir es 40 %. Por qué:'), es.slice(0, 200));
  assert.ok(en.includes('**With a free slot, free memory and ready work, the coordinator does not close her turn.**'), 'la regla en inglés');
  assert.ok(/does not close her turn\.\*\*[^|]*`coordination\.js keep-free`[^|]*40 %\. Why:/.test(en), 'la regla en inglés nombra keep-free, el piso y su porqué');
  const fila = (f, regla) => fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith(`| ${regla} |`)) || '';
  assert.match(fila(GUIDE, 'Con lugar, memoria y trabajo listo, la coordinadora no cierra su turno'), /\| freno \| .*keep-free.*30 min.*tres bloqueos/);
  assert.match(fila(GUIDE_EN, 'With a free slot, free memory and ready work, the coordinator does not close her turn'), /\| freno \| .*keep-free.*30 min.*three blocks/);
  assert.match(flat(GUIDE, '## El tope', '\n## '), /keep-free.*30 min.*tres bloqueos seguidos/);
  assert.match(flat(GUIDE_EN, '## The cap', '\n## '), /keep-free.*30 min.*three blocks in a row/);
});

// ── pr-wait: the read-only watcher of a pull request, through the platform layer (@story-8.270, AC 26) ───────────────
// A toy platform connector answers `change-request.read` from a list, one answer per call, and logs every operation.
// The core names no platform tool: the connector is the only one that would talk to Azure DevOps or GitHub.
const PLATFORM_FAKE = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-platform');
function toyPlatform(answers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-pr-'));
  const ints = path.join(root, 'integrations');
  fs.cpSync(PLATFORM_FAKE, path.join(ints, 'fake-platform'), { recursive: true });
  const log = path.join(root, 'calls.jsonl');
  const count = path.join(root, 'count');
  fs.writeFileSync(path.join(root, 'answers.json'), JSON.stringify(answers));
  fs.writeFileSync(path.join(ints, 'fake-platform', 'scripts', 'connector.js'), `'use strict';
const fs = require('fs');
module.exports = { run: (operacion, args) => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ operacion, args }) + '\\n');
  let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(count)}, 'utf8')); } catch (_) { n = 0; }
  fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
  const a = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'answers.json'))}, 'utf8'))[n];
  if (a === 'fail') return { ok: false, reason: 'no_medido', detail: 'sin conexión con la plataforma' };
  return { ok: true, value: { number: args.number, state: a, draft: false, autoComplete: false, mergedAt: null, mergeCommit: null, title: 'x' } };
} };
`);
  const tree = path.join(root, 'tree');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ integrations: { platform: { default: 'fake-platform' } } }));
  // el repo no declara plataforma: cae en la del perfil (el conector de prueba)
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' },
    profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_INTEGRATIONS_DIR: ints, TYCON_TREE: tree,
    TYCON_FAKE_PLATFORM_TOKEN: ['tok', 'falso'].join('-') };
  for (const k of Object.keys(env)) if (/^TYCON_(ADO_ORG|ADO_CMD|PLATFORM|PROFILE)$|^FAKE_PLATFORM_/.test(k)) delete env[k];
  const run = (args) => spawnSync(process.execPath, [COORD, 'pr-wait', ...args], { encoding: 'utf8', input: '', timeout: 60000, env });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { run, calls };
}

test('PrWait_OnlyReadsAndStopsWhenNotOpen @story-8.270 @ac-26 — only reads the pull request through the platform layer, and ends when it stops being open', () => {
  const a = toyPlatform(['open', 'open', 'merged']);
  const r = a.run(['--repo', 'acme/portal', '--number', '7', '--interval', '1']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.stdout.trim(), 'merged');
  const calls = a.calls();
  assert.strictEqual(calls.length, 3, JSON.stringify(calls));
  for (const c of calls) assert.deepStrictEqual([c.operacion, c.args.number], ['change-request.read', 7]);
  // three failures in a row: exit 2 with the reason
  const b = toyPlatform(['fail', 'fail', 'fail']);
  const rb = b.run(['--repo', 'acme/portal', '--number', '7', '--interval', '1']);
  assert.strictEqual(rb.status, 2, rb.stdout + rb.stderr);
  assert.match(rb.stderr, /sin conexión con la plataforma/);
  assert.strictEqual(b.calls().length, 3);
  // a failure between answers does not add up: only three in a row stop it
  const c = toyPlatform(['fail', 'open', 'fail', 'fail', 'closed']);
  const rc = c.run(['--repo', 'acme/portal', '--number', '7', '--interval', '1']);
  assert.strictEqual(rc.status, 0, rc.stderr);
  assert.strictEqual(rc.stdout.trim(), 'closed');
  // another shape is refused before reading anything
  for (const bad of [['--number', '7'], ['--repo', 'acme/portal'], ['--repo', 'acme/portal', '--number', '0'], ['--repo', 'acme/portal', '--number', 'x7'],
    ['--repo', 'acme', '--number', '7'], ['--repo', 'acme/portal', '--number', '7', '--interval', '0'], ['--repo', 'acme/portal', '--number', '7', 'extra'], ['--ado', '7']]) {
    const d = toyPlatform(['merged']);
    const rd = d.run(bad);
    assert.strictEqual(rd.status, 2, `${bad.join(' ')}: ${rd.stdout}${rd.stderr}`);
    assert.strictEqual(d.calls().length, 0, `${bad.join(' ')}: leyó igual`);
  }
});

test('PrWait_AdoRepoDeclared_ReadsWithItsProject @story-8.270 @ac-26 — a repo declared in team-repos.json is read with its whole identity (Azure DevOps needs the project)', async () => {
  // the adversarial pass of the 8.270 found it: with the plain text `org/repo` the Azure DevOps connector has no
  // project and every read is refused
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-pr-ado-'));
  fs.writeFileSync(path.join(tree, 'team-profile.json'), '{}');
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify({ version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' },
    profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'azure', org: 'acme', project: 'Operaciones', repo: 'operaciones' } }));
  const vistos = [];
  const leer = async (number, repo) => { vistos.push(repo); return { ok: true, value: { number, state: 'merged' } }; };
  const r = await C.prWait({ rest: [], repo: 'acme/operaciones', number: '6508' }, { leer, tree });
  assert.deepStrictEqual(r, { code: 0, text: 'merged' });
  assert.deepStrictEqual(vistos[0], { platform: 'azure', org: 'acme', project: 'Operaciones', repo: 'operaciones' });
  // a repo the file does not declare keeps its `org/repo` text (GitHub reads it as is)
  const r2 = await C.prWait({ rest: [], repo: 'acme/portal', number: '7' }, { leer, tree });
  assert.strictEqual(r2.code, 0);
  assert.strictEqual(vistos[1], 'acme/portal');
  // (vuelta 2 de revisores) un estado que no es open, merged ni closed no termina la espera: cuenta como lectura fallida
  const raro = async () => ({ ok: true, value: { state: 'draft' } });
  const r3 = await C.prWait({ rest: [], repo: 'acme/portal', number: '7', interval: '1' }, { leer: raro, tree, sleep: async () => {} });
  assert.strictEqual(r3.code, 2, JSON.stringify(r3));
  assert.match(r3.error, /estado que no conozco: draft/);
  // un team-repos.json que no se lee: la lectura sigue con org/repo, y si falla, el motivo lo dice
  const roto = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-pr-roto-'));
  fs.writeFileSync(path.join(roto, 'team-repos.json'), '{ roto');
  const falla = async () => ({ ok: false, reason: 'rechazado', detail: 'falta el proyecto' });
  const r4 = await C.prWait({ rest: [], repo: 'acme/operaciones', number: '7', interval: '1' }, { leer: falla, tree: roto, sleep: async () => {} });
  assert.strictEqual(r4.code, 2);
  assert.match(r4.error, /falta el proyecto/);
  assert.match(r4.error, /team-repos\.json/, `el motivo no dice que la identidad no se resolvió: ${r4.error}`);
});

// ── El pase al lado de un portón acotado (8.286) ─────────────────────────────────────────────────────────────────

// El registro de un portón sin turno de un proceso vivo (este, salvo que se diga otro), como lo deja heavy-turn.js.
function gateRec(t, fields) {
  const dir = path.join(t.state, 'coordination', 'gates');
  fs.mkdirSync(dir, { recursive: true });
  const pid = fields.pid || process.pid;
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sid: 's-ana', session: 'Ana', at: mins(5), ...fields }));
}
const mem = (pct) => () => ({ pct, why: null });
function coordToy() {
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  designate(t, 'coord-1');
  return t;
}
// un proceso vivo que no es éste, para un segundo portón
function otherAlive(tt) {
  const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  tt.after(() => { try { c.kill('SIGKILL'); } catch { /* ya terminó */ } });
  return c.pid;
}

// 🔴 mutación: tratar cualquier portón como pesado deja al pase esperando unas pocas suites.
test('T15 AdversarialTurn_SmallGateRunning_PassLaunches @story-8.286 @ac-5: un portón de 20 suites con memoria libre no frena el pase', () => {
  const t = coordToy();
  gateRec(t, { suites: 20, what: '20 suites de repo' });
  const r = C.adversarialTurn({ ...t.opts, sessionId: 's-b', readMemory: mem(60) });
  assert.ok(r === null || r.waiting_turn === false, JSON.stringify(r));
});

// 🔴 mutación: no mirar los portones (como hoy), o leer la cantidad de cualquier número del texto, deja lanzar el pase
// al lado de un portón largo o de dos; y nombrar sólo pases rompe el aviso de la coordinadora cuando lo ocupa un portón.
test('T16 AdversarialTurn_BigOrManyGates_PassWaits @story-8.286 @ac-6 @ac-7: un portón largo, dos portones o uno sin cantidad legible hacen esperar al pase', (tt) => {
  const ask = (t) => C.adversarialTurn({ ...t.opts, sessionId: 's-b', readMemory: mem(90) });
  // (a) uno de 60 suites
  const a = coordToy();
  gateRec(a, { suites: 60, what: '60 suites de repo' });
  const ra = ask(a);
  assert.strictEqual(ra.waiting_turn, true);
  assert.deepStrictEqual(ra.gates_running, [{ session: 'Ana', suites: 60, since: mins(5) }]);
  assert.match(ra.turn, /Ana/);
  assert.match(ra.turn, /60 suites/);
  // (g) el aviso de la coordinadora para quien espera su pase nombra al portón y no se rompe sin pases en vuelo
  session(a, 'bg-debe', 'Rita', { kind: 'bg', status: 'idle', statusUpdatedAt: mins(40) });
  marker(a, 'bg-debe', { storyId: '9.8', adversarialGate: { run: true, files: ['a.js'] } });
  assert.match(C.capNotice({ ...a.opts, sessionId: 'coord-1' }), /Rita espera su turno de pase adversarial \(lo tiene Ana, con un portón de 60 suites\)/);
  // (b) dos de 10
  const b = coordToy();
  gateRec(b, { suites: 10, what: '10 suites de repo' });
  gateRec(b, { pid: otherAlive(tt), session: 'Bea', suites: 10, what: '10 suites de repo' });
  assert.strictEqual(ask(b).waiting_turn, true);
  // (c) sin el campo, con la cantidad al principio del texto
  const c = coordToy();
  gateRec(c, { what: '85 suites de x' });
  const rc = ask(c);
  assert.strictEqual(rc.waiting_turn, true);
  assert.strictEqual(rc.gates_running[0].suites, 85);
  // (d) sin el campo ni número, y (f) con un número que no es la cantidad: cuentan como más de 40
  for (const what of ['portón acotado', 'portón de 3 pruebas']) {
    const d = coordToy();
    gateRec(d, { what });
    const rd = ask(d);
    assert.strictEqual(rd.waiting_turn, true, what);
    assert.strictEqual(rd.gates_running[0].suites, null, what);
  }
  // (e) el de (a) con su proceso ya muerto no frena
  const e = coordToy();
  const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  gateRec(e, { pid: Number(dead), suites: 60, what: '60 suites de repo' });
  assert.strictEqual(ask(e), null);
});

// 🔴 mutación: no mirar la memoria del lado del pase deja lanzarlo con la máquina justa y un portón corriendo.
test('T17 AdversarialTurn_SmallGateLowMemory_PassWaits @story-8.286 @ac-9: con un portón chico y poca memoria libre el pase espera', () => {
  const t = coordToy();
  gateRec(t, { suites: 10, what: '10 suites de repo' });
  const r = C.adversarialTurn({ ...t.opts, sessionId: 's-b', readMemory: mem(30) });
  assert.strictEqual(r.waiting_turn, true);
  assert.match(r.turn, /30 %/);
  assert.match(r.turn, /40 %/);
});

// 🔴 mutación: no decir el pase en el renglón del portón deja a la coordinadora sin saber que van juntos.
test('T18 CoordinationStatus_GateBesidePass_Line @story-8.286 @ac-12 @ac-14 @ac-15: el renglón del portón dice si va al lado del pase; lo ilegible no frena; sin coordinadora, nada', () => {
  // (a) con un pase en vuelo
  const a = coordToy();
  session(a, 'pase-1', 'ConPase', { status: 'busy' });
  passMarker(a, 'pase-1', '7.7', 12);
  gateRec(a, { suites: 12, what: '12 suites de repo' });
  assert.match(C.statusText(C.status(a.opts)), /^Portón acotado en curso: Ana \(12 suites de repo, al lado del pase de la 7\.7, desde las \d\d:\d\d\)$/m);
  // (d) sin pase
  const d = coordToy();
  gateRec(d, { suites: 12, what: '12 suites de repo' });
  const td = C.statusText(C.status(d.opts));
  assert.match(td, /Portón acotado en curso: Ana \(12 suites de repo, desde/);
  assert.doesNotMatch(td, /al lado del pase/);
  // (b) la carpeta de los portones no se puede leer: no frena el pase y se anota
  const b = coordToy();
  fs.mkdirSync(path.join(b.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(b.state, 'coordination', 'gates'), 'no es una carpeta');
  const sb = C.status(b.opts);
  assert.ok(sb.problems.some((p) => /portones en curso/.test(p)), JSON.stringify(sb.problems));
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { assert.strictEqual(C.adversarialTurn({ ...b.opts, sessionId: 's-b', readMemory: mem(90) }), null); } finally { process.stderr.write = write; }
  // (c) sin coordinadora designada, o con el turno apagado, un portón largo no frena el pase
  const c = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  gateRec(c, { suites: 60, what: '60 suites de repo' });
  assert.strictEqual(C.adversarialTurn({ ...c.opts, sessionId: 's-b', readMemory: mem(90) }), null);
  const off = coordToy();
  gateRec(off, { suites: 60, what: '60 suites de repo' });
  assert.strictEqual(C.adversarialTurn({ ...off.opts, env: { TYCON_SUITE_TURN: '0' }, sessionId: 's-b', readMemory: mem(90) }), null);
});

// ── 8.281: la espera del dueño no se despierta por sesiones de otros proyectos ──────────────────────────────────────

// Una carpeta con su remoto: el repo del que es una sesión sale de ahí, como en la oficina.
function repoWithRemote(t, name, url) {
  const dir = path.join(t.root, name);
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
  return dir;
}
// La foto de pedidos que deja el aviso de pedidos trabados: de ahí salen los repos que sigue el arnés.
function prsPhoto(t, repos, at = new Date(NOW).toISOString()) {
  fs.writeFileSync(path.join(t.state, 'stuck-prs-photo.json'), JSON.stringify({ at, lecturas: Object.fromEntries(repos.map((r) => [r, { ok: true, value: [] }])) }));
}
// Una vuelta de owner-wait con la coordinadora confirmada.
function ownerWaitLab() {
  const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
  const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
  const t = toy();
  fs.writeFileSync(path.join(t.arnes, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: 's-coord', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
  session(t, 's-coord', 'Coordinadora', { status: 'busy' });
  const confirmada = OA.coordinadoraConfirmada;
  OA.coordinadoraConfirmada = (casa, o = {}) => confirmada(casa, { arnes: t.arnes, ...o });
  const vuelta = (seg = 0) => C.ownerWaitOnce({ ...t.opts, sessionId: 's-coord', now: NOW + seg * 1000, ownerWaits: () => ({ esperas: [], problemas: [] }), signatureDestinos: () => [] }).lines;
  return { t, vuelta, restore: () => { OA.coordinadoraConfirmada = confirmada; } };
}
const perm = { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW };

test('8.281 T1 OwnerWait_OtroProyecto_NoDespierta @story-8.281 @ac-1 @ac-3: la sesión de otro proyecto con un permiso abierto no despierta; la que no se sabe de qué proyecto es, sí', () => {
  const { t, vuelta, restore } = ownerWaitLab();
  try {
    prsPhoto(t, ['acme/arnes']);
    session(t, 's-otro', 'DeOtro', { ...perm, cwd: repoWithRemote(t, 'otro', 'https://github.com/acme/otro.git') });
    session(t, 's-nose', 'SinCarpeta', { ...perm, cwd: path.join(t.root, 'no-existe') });
    session(t, 's-sinrem', 'SinRemoto', { ...perm, cwd: repoWithRemote(t, 'local', '') });
    const lines = vuelta();
    assert.ok(!lines.some((l) => /DeOtro/.test(l)), `la de otro proyecto no despierta: ${lines.join(' | ')}`);
    assert.ok(lines.some((l) => /SinCarpeta espera un permiso/.test(l)), `la que no se sabe, despierta: ${lines.join(' | ')}`);
    assert.ok(lines.some((l) => /SinRemoto espera un permiso/.test(l)), `sin remoto, despierta: ${lines.join(' | ')}`);
    // ni la nombra después como «siguió» o «se cerró»
    assert.deepStrictEqual(vuelta(30).filter((l) => /DeOtro/.test(l)), []);
    // sin la foto de pedidos no se sabe qué repos sigue el arnés: ante la duda, despierta
    const u = ownerWaitLab();
    try {
      session(u.t, 's-otro', 'DeOtro', { ...perm, cwd: repoWithRemote(u.t, 'otro', 'https://github.com/acme/otro.git') });
      assert.ok(u.vuelta().some((l) => /DeOtro espera un permiso/.test(l)), 'sin foto, despierta');
    } finally { u.restore(); }
  } finally { restore(); }
});

test('8.281 T2 OwnerWait_SesionDelArnes_DespiertaComoHoy @story-8.281 @ac-2 @ac-22: una sesión del arnés con un permiso abierto despierta, aunque la foto de pedidos sea vieja', () => {
  const { t, vuelta, restore } = ownerWaitLab();
  try {
    prsPhoto(t, ['acme/arnes'], new Date(NOW - 5 * 3600000).toISOString());
    session(t, 's-arnes', 'DelArnes', { ...perm, cwd: repoWithRemote(t, 'arnes', 'https://github.com/acme/arnes.git') });
    session(t, 's-otro', 'DeOtro', { ...perm, cwd: repoWithRemote(t, 'otro', 'https://github.com/acme/otro.git') });
    const lines = vuelta();
    assert.ok(lines.some((l) => /DelArnes espera un permiso/.test(l)), lines.join(' | '));
    assert.ok(!lines.some((l) => /DeOtro/.test(l)), 'la foto vieja sirve para saber qué repos sigue el arnés');
  } finally { restore(); }
});

// ── 8.281: el cierre ve su puesto ────────────────────────────────────────────────────────────────────────────────────

// 🔴 Falla con: la otra sesión arrancó antes de que la primera soltara el puesto (el caso del 8/11, Quintero y Pratto):
// la suelta queda fuera de la ventana que corta el ARRANQUE de la otra, y a la primera se le cargan sus cambios y su rama.
test('8.281 T4 Close_OtraSesionSinReflog_SoloLoPropio @story-8.281 @ac-7 @ac-8: la otra cuenta desde que llegó al puesto, no desde que arrancó; sin suelta, «no sé» con la otra nombrada', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/primera');
  commitIn(slot);
  git(slot, 'push', '-q', 'origin', 'wt/primera');
  bg(t, 'primera', slot);
  // la otra arranca ANTES de que la primera suelte el puesto, y llega después
  esperar(1100);
  bg(t, 'otra', slot, { startedAt: Date.now() });
  esperar(1100);
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  esperar(1100);
  git(slot, 'checkout', '-q', '-b', 'wt/otra');
  commitIn(slot);
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  const r = closeIt(t, 'primera');
  assert.doesNotMatch(r.message, /sin commitear|sin empujar|wt\/otra/, `lo de la otra no es suyo: ${r.message}`);
  assert.match(r.message, /la rama local wt\/primera .*no entró a main/, 'su propia rama sí se mira');
  assert.deepStrictEqual(closed(t), []);
  // con su rama en main, cierra, y el trabajo de la otra queda como estaba
  git(t.repo, 'fetch', '-q', 'origin', 'wt/primera');
  git(t.repo, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  git(t.repo, 'push', '-q', 'origin', 'main');
  assert.strictEqual(closeIt(t, 'primera').closed, true, closeIt(t, 'primera').message);
  assert.ok(fs.existsSync(path.join(slot, 'a-medio-hacer.txt')), 'el trabajo de la otra no se toca');
});

// 🔴 Falla con: el «no sé» del puesto compartido sale también con una suelta en el registro, cuando la que cierra volvió
// a su propia rama: ahí el registro sí dice de quién es lo de ahora (de ella), y se mira todo como suyo, como siempre.
test('8.281 T4b Close_SoltoYVolvioASuRama_LoMiraComoSuyo @story-8.281 @ac-7: con suelta y la rama de ahora entre las suyas, falta lo suyo; no es «no sé»', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/primera');
  commitIn(slot);
  bg(t, 'primera', slot);
  esperar(1100);
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  esperar(1100);
  git(slot, 'checkout', '-q', 'wt/primera');
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  bg(t, 'otra', slot, { startedAt: Date.now() + 1000 });
  const r = closeIt(t, 'primera');
  assert.doesNotMatch(r.message, /no puedo separar/, r.message);
  assert.match(r.message, /falta: [^.]*sin commitear/, r.message);
  assert.deepStrictEqual(closed(t), []);
});

// ── El aviso de cada turno con otros proyectos, y el cierre con sueltas de antes de que llegara la otra ─────────────

// 🔴 Falla con: el aviso de cada turno de la coordinadora (capNotice → ownerWaitLines) no filtra la trabada de otro
// proyecto, y como owner-wait ya no la anota, la nombra en cada turno.
test('8.281 T1b AvisoDelTurno_OtroProyecto_NoLaNombra @story-8.281 @ac-1: el aviso de cada turno de la coordinadora tampoco nombra la trabada de otro proyecto', () => {
  const { t, vuelta, restore } = ownerWaitLab();
  try {
    prsPhoto(t, ['acme/arnes']);
    const desde = { ...perm, statusUpdatedAt: NOW - 5 * 60000 };
    session(t, 's-otro', 'DeOtro', { ...desde, cwd: repoWithRemote(t, 'otro', 'https://github.com/acme/otro.git') });
    session(t, 's-arnes', 'DelArnes', { ...desde, cwd: repoWithRemote(t, 'arnes', 'https://github.com/acme/arnes.git') });
    vuelta();
    const turno = (n) => JSON.stringify(C.capNotice({ ...t.opts, now: NOW + n * 1000, env: { CLAUDE_CODE_SESSION_ID: 's-coord' } }));
    for (const n of [0, 60]) assert.doesNotMatch(turno(n), /DeOtro/, `turno ${n}`);
    // y una ya anunciada que pasa a ser de otro proyecto sale de lo anunciado aunque la vuelta no traiga novedades
    const file = path.join(C.coordinationDir(t.home), 'owner-wait.json');
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    a.waits['s-otro'] = { since: NOW, session: 'DeOtro', key: 'x' };
    fs.writeFileSync(file, JSON.stringify(a));
    vuelta(30);
    assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).waits['s-otro'], 'la sacada queda escrita');
  } finally { restore(); }
});

// 🔴 Falla con: la que cierra soltó el puesto y tomó una rama nueva ANTES de que arrancara la otra; la suelta vieja se toma
// como la llegada de la otra y el cierre da por limpia a una sesión con trabajo sin empujar.
test('8.281 T4c Close_SoltoYTomoOtraRamaAntesDeLaOtra_NoCierra @story-8.281 @ac-7 @ac-8: una suelta de antes del arranque de la otra, seguida de una rama propia, no es la llegada de la otra', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/primera');
  bg(t, 'primera', slot);
  esperar(1100);
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  esperar(1100);
  git(slot, 'checkout', '-q', '-b', 'wt/nueva');
  commitIn(slot);
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  esperar(1100);
  bg(t, 'otra', slot, { startedAt: Date.now() });
  const r = closeIt(t, 'primera');
  assert.strictEqual(r.closed, false, r.message);
  assert.match(r.message, /sin commitear/, r.message);
  assert.deepStrictEqual(closed(t), []);
});

// La otra arrancó ANTES que la que cierra (el otro orden del caso del 8/11) y llegó después de la suelta: también cuenta
// desde que llegó (AC 7).
test('8.281 T4d Close_OtraArrancoAntesQueLaQueCierra_CuentaDesdeQueLlego @story-8.281 @ac-7: la otra más vieja que llegó después de la suelta hereda el puesto', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  bg(t, 'otra', slot, { startedAt: 500 });
  git(slot, 'checkout', '-q', '-b', 'wt/primera');
  commitIn(slot);
  git(slot, 'push', '-q', 'origin', 'wt/primera');
  bg(t, 'primera', slot);
  esperar(1100);
  git(slot, 'checkout', '-q', '--detach', 'origin/main');
  esperar(1100);
  git(slot, 'checkout', '-q', '-b', 'wt/otra');
  commitIn(slot, 'c.txt');
  fs.writeFileSync(path.join(slot, 'a-medio-hacer.txt'), 'x\n');
  const r = closeIt(t, 'primera');
  assert.doesNotMatch(r.message, /sin commitear|sin empujar|wt\/otra/, `lo de la otra no es suyo: ${r.message}`);
  assert.match(r.message, /la rama local wt\/primera .*no entró a main/, r.message);
});

// 🔴 Falla con: con el puesto compartido sin suelta, las ramas que se dejaron en el puesto se cargan como «falta» de la que
// cierra, aunque pueden ser de la otra.
test('8.281 T4e Close_PuestoCompartido_RamasDejadas_EnNoSe @story-8.281 @ac-7: sin suelta y con otra sesión, las ramas dejadas también van a «no sé»', () => {
  const t = closeLab();
  const slot = path.join(t.root, 'repo--slot-1');
  git(t.repo, 'worktree', 'add', '-q', '--detach', slot, 'origin/main');
  git(slot, 'checkout', '-q', '-b', 'wt/una');
  commitIn(slot);
  bg(t, 'primera', slot);
  esperar(1100);
  git(slot, 'checkout', '-q', '-b', 'wt/dos');
  bg(t, 'intrusa', slot, { startedAt: Date.now() + 1000 });
  const r = closeIt(t, 'primera');
  assert.strictEqual(r.closed, false, r.message);
  assert.doesNotMatch(r.message, /falta:/, r.message);
  assert.match(r.message, /no puedo separar.*la rama local wt\/una/, r.message);
});

// ── 8.275: owner-next da el detalle del cuadro debajo de la pregunta, sin la lista de archivos ───────────────────────

// 🔴 Falla con: un detalle que no llega a quien muestra el cuadro, o que trae las rutas de los archivos de la firma.
test('OwnerNext_PrintsDetailBelowQuestion_WithoutFileList (T15) @story-8.275 @ac-13', (t) => {
  const sl = require('../lib/signature-list.js');
  const ow = require('../lib/owner-window.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-detalle-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const casa = path.join(raiz, 'casa');
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(casa, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(casa, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: 'on' } }));
  fs.writeFileSync(path.join(casa, '.claude', 'sessions', 'ses-a.json'), JSON.stringify({ pid: process.pid, sessionId: 'ses-a', name: 'A', nameSource: 'user', status: 'idle', cwd: '/r' }));
  const arnes = path.join(raiz, 'arnes');
  fs.mkdirSync(arnes);
  // la corrida de la sesión, con su plan de 11 archivos
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...a], { encoding: 'utf8' });
  git('init', '-q');
  const historia = path.join(repo, 'specs', 'story-9.99-prueba.md');
  fs.writeFileSync(historia, '---\nstory: "9.99"\ntitle: "Prueba"\nstatus: in-progress\n---\n\n# Story 9.99\n');
  fs.writeFileSync(path.join(estado, 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: historia, repoPath: repo, startedAt: '2026-11-04T12:00:00Z',
    stepScheme: 2, stepsCompleted: ['validate-story', 'plan'], stepsPending: ['approve-plan', 'implement'] }));
  // la carpeta de la corrida, la misma que lee la fuente del plan
  const run = require(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'run-dir.js')).resolveRunDir(repo, '9.99', true, historia);
  const archivos = ['scripts/lib/a.js', 'scripts/lib/b.js', 'scripts/lib/c.js', 'scripts/tools/d.js', 'scripts/tests/a.test.js', 'scripts/tests/b.test.js', 'scripts/tests/c.test.js',
    'guides/x.md', 'guides/y.md', 'specs/story-9.99-prueba.md', 'scripts/tests/suites.json'];
  const planRuta = path.join(run, 'step-02-bmad-plan.md');
  fs.writeFileSync(planRuta, ['# Plan', '', '## Qué hace', '', 'Hace algo.', '', '## Archivos', '', ...archivos.map((a) => `- ${a}`), ''].join('\n'));
  // los tres controles, cambiados en un commit
  const controles = ['scripts/ci/a.sh', 'scripts/ci/b.sh', 'scripts/ci/c.sh'];
  fs.mkdirSync(path.join(repo, 'scripts', 'ci'), { recursive: true });
  for (const r of controles) fs.writeFileSync(path.join(repo, r), 'a=1\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  for (const r of controles) fs.writeFileSync(path.join(repo, r), 'a=1\nb=2\n');
  git('commit', '-qam', 'cambio');
  const entradas = JSON.stringify(controles.map((p) => ({ path: p, blob: git('rev-parse', `HEAD:${p}`).stdout.trim() })));
  const MARKER = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
  const CONTROLES = path.join(__dirname, '..', 'ci', 'run-base-controls.sh');
  const pedidos = {
    'plan-approval': `node ${MARKER} complete-step approve-plan --approved "pido el click del dueño"`,
    'control-change': `bash ${CONTROLES} approve --root ${repo} --base ${base} --entries '${entradas}'`,
  };
  const ahora = Date.parse('2026-11-04T12:30:00Z');
  for (const [firma, comando] of Object.entries(pedidos)) {
    fs.rmSync(sl.archivo(casa), { force: true });
    sl.anotarFirma({ casa, firma, titulo: firma, sesion: 'ses-a', destino: 'ses-a', comando, palabras: ow.canonica(comando), cwd: repo, ahora: ahora - 60000 });
    const r = sl.siguiente({ casa, sesion: 'ses-a', ahora, arnes, env: {}, arbol: [] });
    assert.strictEqual(r.tipo, 'firma', `${firma}: ${r.texto}`);
    assert.ok(Array.isArray(r.detalle) && r.detalle.length, `${firma}: sin detalle`);
    const out = C.ownerNextText(r, 'ses-a');
    const i = out.indexOf('Detalle (no va en el cuadro; mostralo si la persona lo pide):');
    assert.ok(i > out.indexOf(r.pregunta), `${firma}: ${out}`);
    // lo que ve la persona: la pregunta y el detalle; el comando a repetir es de la sesión
    const visto = out.slice(0, out.indexOf('Con «'));
    for (const a of [...archivos, ...controles]) assert.ok(!visto.includes(a), `${firma}: se ve ${a}:\n${visto}`);
    if (firma === 'plan-approval') assert.ok(visto.includes(planRuta), visto);
    else assert.match(visto, /Completo en: \S+\.patch/);
    // el texto de decidir para el mismo pedido
    const q = ow.cuadroPara({ firma, comando, palabras: ow.canonica(comando), destino: 'ses-a', sesion: 'ses-a', cwd: repo, casa });
    const d = ow.negarSinVentana('sin ventana', [firma], 'ses-a', q, true);
    assert.ok(d.texto.includes('Detalle (no va en el cuadro; mostralo si la persona lo pide):'), d.texto);
    for (const a of [...archivos, ...controles]) assert.ok(!d.texto.includes(a), `${firma}: decidir nombra ${a}`);
  }
});

// 🔴 Falla con: el cuadro de un permiso cambiado por el formato nuevo de las firmas.
test('SignatureList_PermissionBox_Unchanged (T15) @story-8.275 @ac-18', () => {
  const sl = require('../lib/signature-list.js');
  const pedido = 'rm -rf /r/repo/node_modules && npm ci';
  const f = { id: 'p1', destino: 'ses-a', herramienta: 'Bash', carpeta: '/r/repo', pedido };
  const c = sl.cuadroDePermiso(f);
  const sha = require('crypto').createHash('sha256').update(pedido).digest('hex').slice(0, 8);
  assert.strictEqual(c.pregunta, `¿Aprobás este pedido de Bash? (permiso p1 · sesión ses-a · código ${sha}) Carpeta: /r/repo. Pedido:\n${pedido}`);
});

// ── El segundo turno de ejecución grande, como lo ve la coordinadora (@story-8.291) ─────────────────────────────────

const HTURN = require(path.join(ROOT, 'scripts', 'tools', 'heavy-turn.js'));
// Un lugar del turno de un proceso vivo (este, salvo que se diga otro), como lo publica heavy-turn.js: 0 el primero, 1 el segundo.
function slot(t, i, fields) {
  const file = HTURN.slotFiles(t.home)[i];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: mins(i ? 5 : 10), ...fields }));
}
const reader = (pct) => { const r = () => { r.calls += 1; return pct == null ? { pct: null, why: 'memory_pressure no dio el porcentaje' } : { pct, why: null }; }; r.calls = 0; return r; };
function coordinated(profile = { approvals: { relay_session: 'coordinadora' } }) {
  const t = toy({ profile });
  session(t, 'coord-1', 'Coordinadora', { status: 'busy' });
  designate(t, 'coord-1');
  return t;
}

// 🔴 mutación: mirar sólo la más vieja deja lanzar el pase al lado de la segunda ejecución grande.
test('T44 AdversarialTurn_TwoHeavyRuns_PassWaits @story-8.291 @ac-8: con dos ejecuciones grandes, el pase espera y la línea nombra a las dos', () => {
  const t = coordinated();
  slot(t, 0, { sid: 's-uma', session: 'Uma', what: '204 suites de repo' });
  slot(t, 1, { sid: 's-bea', session: 'Bea', what: '129 suites de repo' });
  const r = C.adversarialTurn({ ...t.opts, sessionId: 's-b' });
  assert.strictEqual(r.waiting_turn, true);
  assert.deepStrictEqual(r.heavy_run, { session: 'Uma', what: '204 suites de repo', since: mins(10) });
  assert.deepStrictEqual(r.heavy_runs.map((h) => h.session), ['Uma', 'Bea']);
  assert.match(r.turn, /Uma, 204 suites de repo/);
  assert.match(r.turn, /Bea, 129 suites de repo/);
  // sólo la segunda (la primera terminó): también espera, y el formato de heavy_run es el de siempre
  fs.rmSync(HTURN.slotFiles(t.home)[0]);
  const s = C.adversarialTurn({ ...t.opts, sessionId: 's-b' });
  assert.deepStrictEqual(s.heavy_run, { session: 'Bea', what: '129 suites de repo', since: mins(5) });
});

// 🔴 mutación: medir con dos o con ninguna, decir «libre» con la memoria debajo, o contar quieta a la que corre la segunda.
test('T45 Status_SecondTurnLine @story-8.291 @ac-11 @ac-13: el renglón del turno dice si la segunda entra, con la memoria y el piso', () => {
  const t = coordinated();
  const line = (s) => C.statusText(s).split('\n').find((l) => l.startsWith('Turno de tarea pesada:'));
  // (e) ninguna: libre, como hoy, y sin medir
  const none = reader(62);
  const e = C.status({ ...t.opts, readMemory: none });
  assert.strictEqual(line(e), 'Turno de tarea pesada: libre');
  assert.deepStrictEqual([e.suites, e.secondTurn.freePct, e.secondTurn.open, none.calls], [[], null, false, 0]);
  assert.deepStrictEqual([e.secondTurn.minFreePct, e.secondTurn.origin], [50, 'sin-valor']);
  slot(t, 0, { sid: 's-uma', session: 'Uma', what: '204 suites de repo' });
  // (a) una, 62 %
  const a = C.status({ ...t.opts, readMemory: reader(62) });
  assert.match(line(a), /^Turno de tarea pesada: Uma \(204 suites de repo, desde las \d\d:\d\d\); segundo turno libre \(memoria libre 62 %, piso 50 %\)$/);
  assert.deepStrictEqual([a.secondTurn.freePct, a.secondTurn.open], [62, true]);
  assert.strictEqual(a.suite.session, 'Uma', 'suite sigue siendo la más vieja');
  // (b) una, 41 %
  const b = C.status({ ...t.opts, readMemory: reader(41) });
  assert.match(line(b), /; segundo turno cerrado \(memoria libre 41 %, piso 50 %\)$/);
  assert.strictEqual(b.secondTurn.open, false);
  // (c) una, sin medir
  const c = C.status({ ...t.opts, readMemory: reader(null) });
  assert.match(line(c), /; segundo turno cerrado \(no pude medir la memoria libre\)$/);
  assert.deepStrictEqual([c.secondTurn.freePct, c.secondTurn.open], [null, false]);
  // (d) dos, 20 %: las dos se muestran, la memoria no se mide, y la de fondo que corre la segunda no está quieta
  session(t, 's-bea', 'Bea', { kind: 'bg', status: 'idle', statusUpdatedAt: mins(40) });
  slot(t, 1, { sid: 's-bea', session: 'Bea', what: '129 suites de repo' });
  const low = reader(20);
  const d = C.status({ ...t.opts, readMemory: low });
  assert.match(line(d), /^Turno de tarea pesada: Uma \(204 suites de repo, desde las \d\d:\d\d\) y Bea \(129 suites de repo, desde las \d\d:\d\d\)$/);
  assert.deepStrictEqual([d.suites.map((x) => x.session), d.secondTurn.freePct, d.secondTurn.open, low.calls], [['Uma', 'Bea'], null, false, 0]);
  assert.ok(!d.quiet.some((q) => q.session === 'Bea'), `la que corre la segunda no está quieta: ${JSON.stringify(d.quiet)}`);
});

// 🔴 mutación: callar con una corriendo (como antes), o imprimir un porcentaje vacío cuando no se pudo medir.
test('T46 CapNotice_QueueWithOneRunning @story-8.291 @ac-12: con gente en la fila, el aviso dice si la segunda entra y a quién darle el «arrancá»', () => {
  const t = coordinated();
  const opts = (pct) => ({ ...t.opts, sessionId: 'coord-1', readMemory: reader(pct) });
  session(t, 's-ana', 'Ana', { status: 'idle', statusUpdatedAt: mins(30) });
  const doing = path.join(t.state, 'doing');
  fs.mkdirSync(doing, { recursive: true });
  fs.writeFileSync(path.join(doing, 's-ana.json'), JSON.stringify({ text: 'implementar la historia', at: new Date(mins(10)).toISOString(), waitingFor: 'turno de suite', waitingSince: new Date(mins(10)).toISOString() }));
  // (d) ninguna corriendo: el texto de hoy
  assert.match(C.capNotice(opts(62)), /^Coordinación: no corre ninguna suite completa y hay 1 esperando turno: dale el «arrancá» a Ana: heavy-turn\.js grant --to [\w-]+\.$/m);
  slot(t, 0, { sid: 's-uma', session: 'Uma', what: '204 suites de repo' });
  // (a) una, 62 %
  assert.match(C.capNotice(opts(62)), /^Coordinación: corre Uma \(204 suites de repo, desde las \d\d:\d\d\); hay lugar para una segunda \(memoria libre 62 %, piso 50 %\): dale el «arrancá» a Ana: heavy-turn\.js grant --to [\w-]+\.$/m);
  // (b) una, 41 %
  assert.match(C.capNotice(opts(41)), /^Coordinación: corre Uma \(.*\); la segunda no entra \(memoria libre 41 %, piso 50 %\): cuando termine, sigue Ana\.$/m);
  // (e) una, sin medir: ni «null» ni un porcentaje vacío
  const e = C.capNotice(opts(null));
  assert.match(e, /la segunda no entra \(no pude medir la memoria libre\): cuando termine, sigue Ana\./);
  assert.doesNotMatch(e, /null|\( ?%|libre +%/);
  // (c) dos
  slot(t, 1, { sid: 's-bea', session: 'Bea', what: '129 suites de repo' });
  assert.match(C.capNotice(opts(62)), /^Coordinación: corren Uma \(.*\) y Bea \(.*\); cuando termine una, sigue Ana\.$/m);
});

// 🔴 mutación: dar el segundo lugar con el otro ilegible, frenar por el lector caído, o medir sin coordinadora.
test('T47 Status_UnreadableSlot_And_NoCoordinator @story-8.291 @ac-14 @ac-15: lo que no se lee no da el segundo turno y se dice; sin coordinadora, nada', (t) => {
  const m = coordinated();
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { other.kill('SIGKILL'); } catch { /* ya terminó */ } });
  slot(m, 0, { pid: other.pid, sid: 's-uma', session: 'Uma', what: '204 suites de repo', at: Date.now() - 60000 });
  fs.writeFileSync(HTURN.slotFiles(m.home)[1], '{ esto no es json');
  const mem = reader(90);
  const r = HTURN.take({ home: m.home, arnes: m.arnes, env: { CLAUDE_CODE_SESSION_ID: 's-b' }, pid: process.pid, what: 'x', readMemory: mem });
  assert.strictEqual(r.ok, false, 'con el otro lugar ilegible no se da el segundo');
  assert.match(r.message, /no se puede leer/);
  assert.ok(C.status({ ...m.opts, now: Date.now(), readMemory: reader(90) }).problems.some((p) => /turno de las ejecuciones grandes/.test(p)), 'el estado lo dice');
  // (b) el perfil roto: el piso de fábrica, y se dice
  const roto = coordinated();
  fs.writeFileSync(path.join(roto.arnes, 'perfil-equipo.json'), '{ roto');
  const f = HTURN.secondTurnFloor({ home: roto.home, env: {}, arnes: roto.arnes });
  assert.deepStrictEqual([f.value, f.origin], [HTURN.SECOND_HEAVY_MIN_FREE_PCT, 'sin-valor']);
  assert.ok(f.problem, 'dice que no pudo leer la configuración');
  // (c) sin coordinadora designada: nada se toma ni se mide
  const libre = toy({ profile: { approvals: { relay_session: 'coordinadora' } } });
  const none = reader(90);
  for (const pid of [process.pid, other.pid]) {
    const x = HTURN.take({ home: libre.home, arnes: libre.arnes, env: {}, pid, what: 'x', readMemory: none });
    assert.deepStrictEqual([x.ok, x.taken], [true, false]);
  }
  assert.strictEqual(none.calls, 0);
});

// 🔴 mutación: tragar el error del lector de memoria: el estado dice «no pude medir» sin decir por qué.
test('T48 Status_MemoryReaderThrows_SaysWhy @story-8.291 @ac-11 @ac-14: si medir la memoria falla, el estado lo cierra y anota el motivo', () => {
  const t = coordinated();
  slot(t, 0, { sid: 's-uma', session: 'Uma', what: '204 suites de repo' });
  const s = C.status({ ...t.opts, readMemory: () => { throw new Error('memory_pressure no está'); } });
  assert.deepStrictEqual([s.secondTurn.freePct, s.secondTurn.open], [null, false]);
  assert.ok(s.problems.some((p) => /memoria libre.*memory_pressure no está/.test(p)), JSON.stringify(s.problems));
});

// ── La firma desviada a la coordinadora: el aviso de la lista y owner-next (@story-8.295) ─────────────────────────────

test('Aviso_SeparaLasDeLaCoordinadoraDeLasDelDueno (T21) — @story-8.295 @ac-7 @ac-2', () => {
  const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
  const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
  const sl = require(path.join(ROOT, 'scripts', 'lib', 'signature-list.js'));
  const t = toy({ profile: { approvals: { relay_session: 'coordinadora' } }, machine: { approvals: { signature_list: 'on' } } });
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: 's-coord', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
  session(t, 's-coord', 'Coordinadora', { kind: 'interactive', cwd: '/c' });
  session(t, 'ses-a', 'Alma', { kind: 'interactive' });
  const confirmada = OA.coordinadoraConfirmada;
  OA.coordinadoraConfirmada = (casa, o = {}) => confirmada(casa, { arnes: t.arnes, ...o });
  try {
    const ow = require(path.join(ROOT, 'scripts', 'lib', 'owner-window.js'));
    const extra = `node ${path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'pipeline.js')} smart-reloop --iter 3 --extra-round`;
    const desviado = `${extra} --repo /r --for-session ses-a`;
    sl.anotarFirma({ casa: t.home, firma: 'extra-round', titulo: 'pedir una vuelta más', sesion: 'ses-a', destino: 'ses-a', comando: extra, palabras: ow.canonica(extra), cwd: '/r', ahora: NOW - 60000,
      delegable: { comando: desviado, coordinadora: 's-coord', cwd: '/c', tool_use_id: 'toolu_01', plazo_min: 10 } });
    // sólo la desviada: la cuenta suya, sin «sin firmar nada vos»
    let n = C.listNotice({ ...t.opts, sessionId: 's-coord', prompt: 'volví' });
    assert.match(n, /1 firma la firmás vos por delegación/);
    assert.doesNotMatch(n, /sin firmar nada vos/);
    assert.doesNotMatch(n, /esperan a la persona/);
    // y una común: las dos cuentas por separado, y la frase sólo para la de la persona
    const marcar = `node ${path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'marker.js')} mark-tested --acs 3`;
    sl.anotarFirma({ casa: t.home, firma: 'manual-test', titulo: 'marcar un criterio', sesion: 'ses-a', destino: 'ses-a', comando: marcar, palabras: ow.canonica(marcar), cwd: '/r', ahora: NOW - 60000 });
    n = C.listNotice({ ...t.opts, sessionId: 's-coord', prompt: 'volví de nuevo' });
    assert.match(n, /esperan a la persona 1 firma\./);
    assert.match(n, /1 firma la firmás vos por delegación/);
    assert.strictEqual((n.match(/sin firmar nada vos/g) || []).length, 1, n);
  } finally { OA.coordinadoraConfirmada = confirmada; }
  // owner-next: el comando literal, sin cuadro
  const comando = 'node /h/marker.js approve-pending --id DEF-x --repo /r --for-session ses-a';
  const txt = C.ownerNextText({ tipo: 'delegable', id: 'firma-ab12', destino: 'ses-a', nombre: 'Alma', comando, cwd: '/c', problemas: [], faltaRepetir: [], saltados: [] }, 's-coord');
  assert.ok(txt.includes(`Firmala vos por delegación, en tu pestaña, desde /c: ${comando}`), txt);
  assert.doesNotMatch(txt, /AskUserQuestion/);
  assert.match(txt, /avisale a Alma/);
});

// Una sesión anota que espera turno y su prueba pesada ya corre (la anotó después de arrancar, o el turno se lo dieron
// sin que la borrara): la nota y el registro de turnos no coinciden, y gana el registro. No entra en la fila ni recibe el
// «arrancá»: sin esto, la fila pide el «arrancá» para un portón que ya corre.
// 🔴 mutación: leer sólo la nota (como antes), o sacar de la fila también a la que no corre nada.
test('T49 Status_EsperaVieja_GanaElRegistroDeTurnos: con su portón o su lugar del turno corriendo, la que anotó la espera no está en la fila', () => {
  const t = coordinated();
  const opts = (pct) => ({ ...t.opts, sessionId: 'coord-1', readMemory: reader(pct) });
  const doing = path.join(t.state, 'doing');
  fs.mkdirSync(doing, { recursive: true });
  const waits = (sid, what) => fs.writeFileSync(path.join(doing, `${sid}.json`), JSON.stringify({ at: new Date(mins(2)).toISOString(), waitingFor: what, waitingSince: new Date(mins(2)).toISOString() }));
  session(t, 's-ana', 'Ana', { status: 'idle', statusUpdatedAt: mins(3) });
  session(t, 's-bea', 'Bea', { status: 'idle', statusUpdatedAt: mins(3) });
  waits('s-ana', 'portón final de pruebas de la 9.9');
  slot(t, 0, { sid: 's-uma', session: 'Uma', what: '204 suites de repo' });
  // sin registro de Ana: está en la fila, como hoy
  assert.match(C.capNotice(opts(62)), /dale el «arrancá» a Ana: heavy-turn\.js grant --to [\w-]+\./);
  // su portón corre, anotado antes que la nota: gana el registro
  gateRec(t, { sid: 's-ana', session: 'Ana', what: '81 suites de repo', suites: 81, at: mins(3) });
  const s = C.status(opts(62));
  assert.deepStrictEqual(s.suiteWaiting.map((x) => x.session), [], JSON.stringify(s.suiteWaiting));
  assert.doesNotMatch(String(C.capNotice(opts(62)) || ''), /Ana/);
  // la que tiene un lugar del turno tampoco espera, y la otra que espera sin correr nada sigue en la fila
  fs.rmSync(path.join(t.state, 'coordination', 'gates'), { recursive: true });
  slot(t, 1, { sid: 's-ana', session: 'Ana', what: '129 suites de repo' });
  waits('s-bea', 'el turno de la suite');
  const s2 = C.status(opts(62));
  assert.deepStrictEqual(s2.suiteWaiting.map((x) => x.session), ['Bea'], JSON.stringify(s2.suiteWaiting));
});

// ── 8.290: los nombres largos que no se pueden leer, la lista de recién abiertas y las respuestas tomadas ──

const longPair = () => ({ pedida: `${'y'.repeat(40)}-pedida`, otra: `${'y'.repeat(40)}-otra` });
const failRead = (code) => () => { const e = new Error(`falla ${code}`); e.code = code; throw e; };

test('T1 CloseStop_LongNameUnreadableFile_SaysCouldNotRead @story-8.290 @ac-1 @ac-2: «no pude leer» con la ruta cuando no se pudo leer; «No encuentro» sólo si se leyó y no está', () => {
  const posix = !POSIX_PERMS.skip;
  const { pedida, otra } = longPair();
  // (a) fullSessionName directo: la carpeta y el archivo que no se leen devuelven el problema con la ruta
  const a = closeLab();
  const dir = path.join(a.home, '.claude', 'sessions');
  bg(a, pedida, a.repo);
  assert.strictEqual(C.fullSessionName(a.home, `sid-${pedida}`), pedida);
  assert.strictEqual(C.fullSessionName(a.home, 'sid-nadie'), null, 'legible y no está: null, como hoy');
  const porLectura = C.fullSessionName(a.home, 'sid-nadie', { readSessionFile: failRead('EACCES') });
  assert.ok(porLectura && /\.json \(EACCES\)/.test(porLectura.problem), JSON.stringify(porLectura));
  if (posix) {
    fs.chmodSync(dir, 0o000);
    let r;
    try { r = C.fullSessionName(a.home, `sid-${pedida}`); } finally { fs.chmodSync(dir, 0o755); }
    assert.ok(r && r.problem.includes(dir) && /EACCES/.test(r.problem), JSON.stringify(r));
    const f = path.join(dir, `sid-${pedida}.json`);
    fs.chmodSync(f, 0o000);
    try { r = C.fullSessionName(a.home, `sid-${pedida}`); } finally { fs.chmodSync(f, 0o644); }
    assert.ok(r && r.problem.includes(f), JSON.stringify(r));
  }
  // (b) el archivo se vuelve ilegible entre las dos lecturas: «No pude leer <ruta> (<código>)», sin tocar nada
  const b = closeLab();
  bg(b, pedida, b.repo);
  const rb = closeIt(b, pedida, { readSessionFile: failRead('EACCES') });
  assert.strictEqual(rb.ok, false, rb.message);
  assert.match(rb.message, /No pude leer .*sid-y+-pedida\.json \(EACCES\): no cerré nada/);
  assert.doesNotMatch(rb.message, /No encuentro/);
  const sb = stopIt(b, pedida, { readSessionFile: failRead('EIO') });
  assert.match(sb.message, /No pude leer .*\(EIO\): no paré nada/);
  assert.deepStrictEqual(closed(b), []);
  // (c) ilegible desde antes: sale por la lectura de todas las sesiones, como hoy
  if (posix) {
    const c = closeLab();
    bg(c, pedida, c.repo);
    const f = path.join(c.home, '.claude', 'sessions', `sid-${pedida}.json`);
    fs.chmodSync(f, 0o000);
    let rc;
    try { rc = closeIt(c, pedida); } finally { fs.chmodSync(f, 0o644); }
    assert.match(rc.message, /No pude leer todas las sesiones/);
    assert.deepStrictEqual(closed(c), []);
  }
  // (d) legible y sin el nombre completo pedido: «No encuentro la sesión», como hoy
  const d = closeLab();
  bg(d, otra, d.repo);
  assert.match(closeIt(d, pedida).message, /No encuentro la sesión «y+-pedida»: no cerré nada/);
  assert.deepStrictEqual(closed(d), []);
});

test('T2 PruneLaunched_LongNamesSamePrefix_DropsOnlyTheNamed @story-8.290 @ac-3: abrir una de nombre largo no saca a otra que empieza igual', () => {
  const t = toy();
  const { pedida, otra } = longPair();
  fs.mkdirSync(path.dirname(C.launchedFile(t.home)), { recursive: true });
  fs.writeFileSync(C.launchedFile(t.home), JSON.stringify([{ name: pedida, cwd: t.root, at: NOW - 1000, por: null }, { name: otra, cwd: t.root, at: NOW - 1000, por: null }]));
  C.noteLaunched({ home: t.home, now: NOW, name: pedida, cwd: t.root });
  const rows = JSON.parse(fs.readFileSync(C.launchedFile(t.home), 'utf8'));
  assert.deepStrictEqual(rows.map((r) => [r.name, r.at]), [[otra, NOW - 1000], [pedida, NOW]]);
  assert.deepStrictEqual(C.pruneLaunched({ home: t.home, now: NOW, drop: pedida, sessions: new Map() }).map((r) => r.name), [otra]);
});

test('T3 PruneLaunched_ShortName_DropsAsToday @story-8.290 @ac-4: un nombre corto sale como hoy', () => {
  const t = toy();
  fs.mkdirSync(path.dirname(C.launchedFile(t.home)), { recursive: true });
  fs.writeFileSync(C.launchedFile(t.home), JSON.stringify([{ name: 'corta', cwd: t.root, at: NOW, por: null }, { name: 'otra', cwd: t.root, at: NOW, por: null }]));
  assert.deepStrictEqual(C.pruneLaunched({ home: t.home, now: NOW, drop: 'corta', sessions: new Map() }).map((r) => r.name), ['otra']);
});

// Las respuestas de la persona, armadas a mano: el renglón que anota recordOwnerReply y la conversación que lo confirma.
// A mano y no con recordOwnerReply, que pide una coordinadora confirmada y viva: lo que se prueba acá es la toma y la
// recuperación de los archivos, no la anotación. Los campos son los que escribe recordOwnerReply (sid, at, text, sha,
// transcript, from); las pruebas de coordination-notice.test.js anotan con recordOwnerReply y leen por el mismo camino.
const DEAD_PID = 2147483646;
function replyLab() {
  const t = toy();
  const file = path.join(C.coordinationDir(t.home), 'owner-replies.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const said = [];
  const transcript = path.join(t.home, '.claude', 'projects', '-repo', 'ses-a.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const row = (text) => {
    said.push(text);
    fs.writeFileSync(transcript, said.map((m) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: m }, origin: { kind: 'human' }, promptSource: 'typed', entrypoint: 'cli' })}\n`).join(''));
    const sha = require('crypto').createHash('sha256').update(text).digest('hex');
    return `${JSON.stringify({ sid: 'ses-a', at: new Date(NOW - 60000).toISOString(), text, sha, transcript, from: 0 })}\n`;
  };
  const read = (extra = {}) => { const problems = []; const lines = C.ownerReplyLines({ home: t.home, now: NOW, ...extra }, COORD_SID, problems); return { text: lines.join('\n'), problems }; };
  const taken = () => fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.leyendo')).sort();
  const times = (text, s) => text.split(`«${s}»`).length - 1;
  return { ...t, file, row, read, taken, times };
}

test('T4 OwnerReplies_OrphanTakenFile_DeliveredOnce @story-8.290 @ac-5: el tomado de un proceso que no vive se entrega una vez, con o sin archivo de respuestas', () => {
  const t = replyLab();
  fs.writeFileSync(`${t.file}.${DEAD_PID}.leyendo`, t.row('del huerfano'));
  fs.writeFileSync(t.file, t.row('nueva'));
  const r = t.read();
  assert.strictEqual(t.times(r.text, 'del huerfano'), 1, r.text);
  assert.strictEqual(t.times(r.text, 'nueva'), 1, r.text);
  assert.deepStrictEqual(r.problems, []);
  assert.deepStrictEqual(t.taken(), [], 'no queda ningún tomado');
  assert.doesNotMatch(t.read().text, /te contestaron/, 'la lectura siguiente no repite');
  // sin archivo de respuestas: el huérfano se recupera igual
  fs.writeFileSync(`${t.file}.${DEAD_PID}.abc123.leyendo`, t.row('solo huerfano'));
  assert.ok(!fs.existsSync(t.file));
  const s = t.read();
  assert.strictEqual(t.times(s.text, 'solo huerfano'), 1, s.text);
  assert.deepStrictEqual(t.taken(), []);
  // el mismo renglón en el huérfano y en el archivo (se cayó después de devolver los sin confirmar): sale una vez
  // (pase adversarial de la 8.290)
  const repetido = t.row('repetido');
  fs.writeFileSync(`${t.file}.${DEAD_PID}.def456.leyendo`, repetido);
  fs.writeFileSync(t.file, repetido);
  const d = t.read();
  assert.strictEqual(t.times(d.text, 'repetido'), 1, d.text);
  assert.deepStrictEqual(t.taken(), []);
});

test('T5 OwnerReplies_LiveOrUnknownTakenFile_LeftAndSaid @story-8.290 @ac-6: el de un proceso vivo no se toca; el ilegible y el de pid raro quedan y se dicen', () => {
  const t = replyLab();
  const vivo = `${t.file}.${process.pid}.k1.leyendo`;
  const contenido = t.row('lo esta leyendo otro');
  fs.writeFileSync(vivo, contenido);
  const raro = `${t.file}.abc.leyendo`;
  fs.writeFileSync(raro, t.row('pid raro'));
  // el 0 no es un proceso (le preguntaría al grupo), ni uno enorme
  const cero = `${t.file}.0.leyendo`;
  fs.writeFileSync(cero, t.row('pid cero'));
  const enorme = `${t.file}.${'9'.repeat(30)}.leyendo`;
  fs.writeFileSync(enorme, t.row('pid enorme'));
  // pasado el pid más alto que acepta process.kill: tampoco es un proceso (pase adversarial de la 8.290)
  const fueraDeRango = `${t.file}.2147483648.leyendo`;
  fs.writeFileSync(fueraDeRango, t.row('pid fuera de rango'));
  const ilegible = `${t.file}.${DEAD_PID}.k2.leyendo`;
  fs.writeFileSync(ilegible, t.row('ilegible'));
  const posix = !POSIX_PERMS.skip;
  if (posix) fs.chmodSync(ilegible, 0o000);
  let r;
  try { r = t.read(); } finally { if (posix) fs.chmodSync(ilegible, 0o644); }
  assert.strictEqual(fs.readFileSync(vivo, 'utf8'), contenido, 'el vivo queda intacto');
  assert.ok(!r.problems.some((p) => p.includes(vivo)), 'el vivo no es un problema');
  for (const f of [raro, cero, enorme, fueraDeRango]) assert.ok(fs.existsSync(f) && r.problems.some((p) => p.includes(f)), `${f}: ${JSON.stringify(r.problems)}`);
  if (posix) {
    assert.doesNotMatch(r.text, /te contestaron/, r.text);
    assert.ok(fs.existsSync(ilegible) && r.problems.some((p) => p.includes(ilegible)), JSON.stringify(r.problems));
  }
});

test('T6 OwnerReplies_OrphanTakenByOther_NotReadTwice @story-8.290 @ac-5: si otro lector lo tomó antes, no se lee ni se entrega', () => {
  const t = replyLab();
  const huerfano = `${t.file}.${DEAD_PID}.leyendo`;
  fs.writeFileSync(huerfano, t.row('ya lo tomo otro'));
  const r = t.read({ renameOrphan: () => { const e = new Error('lo tomó otro'); e.code = 'ENOENT'; throw e; } });
  assert.doesNotMatch(r.text, /te contestaron/, r.text);
  assert.deepStrictEqual(r.problems, []);
  assert.ok(fs.existsSync(huerfano), 'no se borró: no se leyó');
  // un renombre que falla por otro motivo tampoco lo lee, y lo dice con la ruta
  const otro = t.read({ renameOrphan: () => { const e = new Error('sin permiso'); e.code = 'EACCES'; throw e; } });
  assert.doesNotMatch(otro.text, /te contestaron/, otro.text);
  assert.ok(otro.problems.some((p) => p.includes(huerfano) && /EACCES/.test(p)), JSON.stringify(otro.problems));
  assert.ok(fs.existsSync(huerfano));
  // la carpeta que no se puede leer: lo dice y no entrega nada
  if (!POSIX_PERMS.skip) {
    const dir = path.dirname(t.file);
    fs.chmodSync(dir, 0o000);
    let sin;
    try { sin = t.read(); } finally { fs.chmodSync(dir, 0o755); }
    assert.doesNotMatch(sin.text, /te contestaron/, sin.text);
    assert.ok(sin.problems.some((p) => p.includes(dir) && /EACCES/.test(p)), JSON.stringify(sin.problems));
  }
  // el que se toma y no se puede leer vuelve a su nombre y lo dice
  if (!POSIX_PERMS.skip) {
    const leido = t.read({ renameOrphan: (de, a) => { fs.renameSync(de, a); fs.chmodSync(a, 0o000); } });
    assert.ok(fs.existsSync(huerfano), 'volvió a su nombre');
    fs.chmodSync(huerfano, 0o644);
    assert.ok(leido.problems.some((p) => p.includes(huerfano)), JSON.stringify(leido.problems));
    assert.deepStrictEqual(t.taken(), [path.basename(huerfano)], 'no quedó ningún tomado propio');
  }
});

test('T7 OwnerReplies_OwnPidLeftover_NotOverwritten @story-8.290 @ac-5 @ac-7: el tomado nuevo lleva su marca y no pisa uno viejo del mismo pid', () => {
  const t = replyLab();
  const viejo = `${t.file}.${process.pid}.leyendo`;
  const contenido = t.row('vieja');
  fs.writeFileSync(viejo, contenido);
  fs.writeFileSync(t.file, t.row('nueva'));
  const tomados = [];
  const r = t.read({ onTaken: (p) => tomados.push(p) });
  assert.strictEqual(t.times(r.text, 'nueva'), 1, r.text);
  assert.strictEqual(t.times(r.text, 'vieja'), 0, r.text);
  assert.strictEqual(fs.readFileSync(viejo, 'utf8'), contenido, 'el viejo no se pisó');
  assert.deepStrictEqual(t.taken(), [path.basename(viejo)]);
  assert.strictEqual(tomados.length, 1);
  assert.match(path.basename(tomados[0]), new RegExp(`^owner-replies\\.jsonl\\.${process.pid}\\.[0-9a-f]{8,}\\.leyendo$`));
});

// ── 8.326: el tope de lo que espera la revisión de la persona ────────────────────────────────────────────────────────
const RLIB = require(path.join(ROOT, 'scripts', 'lib', 'review-load.js'));
const cuentaDe = (total, partes = null, extra = {}) => ({ total, partes: partes || { firmas: total, terminados: 0, carpetas: 0, pedidos: 0 },
  noMedido: { terminados: 0, carpetas: 0 }, tope: { value: 8, origin: 'sin-valor' }, problems: [], ...extra });
function conModoRevision(modo, fn) {
  const antes = RLIB.MODO_TOPE_DE_REVISION;
  RLIB.MODO_TOPE_DE_REVISION = modo;
  try { return fn(); } finally { RLIB.MODO_TOPE_DE_REVISION = antes; }
}
const renglonesRevision = (t) => { try { return fs.readFileSync(path.join(t.state, 'gates.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.name === 'review-cap'); } catch { return []; } };

test('T6 Coordinacion_ClaveMaxAwaitingReview @story-8.326 @ac-4', () => {
  const tc = require(path.join(ROOT, 'scripts', 'lib', 'tycon-config.js'));
  assert.deepStrictEqual(tc.coordinacion(tc.cargar(toy().opts)).max_awaiting_review, { value: 8, origin: 'sin-valor' });
  const m = toy({ machine: { coordination: { max_awaiting_review: 12 } } });
  const v = tc.coordinacion(tc.cargar(m.opts)).max_awaiting_review;
  assert.strictEqual(v.value, 12);
  assert.notStrictEqual(v.origin, 'sin-valor');
  for (const malo of [0, 51]) {
    const t = toy({ machine: { coordination: { max_awaiting_review: malo } } });
    const cfg = tc.cargar(t.opts);
    assert.strictEqual(tc.coordinacion(cfg).max_awaiting_review.value, 8, `${malo}`);
    assert.ok(cfg.errores.some((e) => /max_awaiting_review/.test(e.clave || '')), `${malo}: ${JSON.stringify(cfg.errores)}`);
  }
  // el freno de producción la acepta, como las otras de coordination
  const prod = fs.readFileSync(path.join(ROOT, 'scripts', 'production', 'guard-libs', 'lib', 'tycon-config.js'), 'utf8');
  assert.match(prod, /max_awaiting_review: 'aceptada'/);
});

test('T7 Open_RevisionLlena_Freno_NoAbre @story-8.326 @ac-5', () => {
  const t = toy();
  const r = conModoRevision('block', () => open(t, { name: 'n1', task: 'algo', launcher: launcher(t), reviewLoad: () => cuentaDe(8, { firmas: 1, terminados: 2, carpetas: 3, pedidos: 2 }) }));
  assert.strictEqual(r.ok, false, r.message);
  assert.match(r.message, /8 cosas esperan revisión de la persona \(tope 8/);
  assert.match(r.message, /1 firmas, 2 terminados, 3 carpetas, 2 pedidos/);
  assert.match(r.message, /\/wip/);
  assert.doesNotMatch(r.message, /sub[ií] el tope/i);
  assert.strictEqual(launched(t), null, 'no llamó al lanzador');
});

test('T8 Open_RevisionLlena_Aviso_AbreYAnota @story-8.326 @ac-7', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t), reviewLoad: () => cuentaDe(9) });
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /Aviso: 9 cosas esperan revisión de la persona/);
  const rr = renglonesRevision(t);
  assert.strictEqual(rr.length, 1);
  assert.deepStrictEqual([rr[0].status, rr[0].total, rr[0].tope, rr[0].donde], ['warn', 9, 8, 'open']);
  assert.doesNotMatch(JSON.stringify(rr[0]), new RegExp(t.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'el renglón no lleva rutas');
});

test('T10 Open_DebajoDelTope_ComoHoy @story-8.326 @ac-8 @ac-13', () => {
  const t = toy();
  const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t), reviewLoad: () => cuentaDe(3) });
  assert.strictEqual(r.ok, true, r.message);
  assert.doesNotMatch(r.message, /revisión/);
  assert.strictEqual(renglonesRevision(t).length, 0);
  // con el tope de sesiones lleno manda ese, con su mensaje de siempre, y la cuenta de revisión ni se pide
  const u = toy({ machine: { coordination: { max_working: 1 } } });
  session(u, 'sid-a', 'Ana', { status: 'busy', statusUpdatedAt: mins(1) });
  let pidio = false;
  const c = conModoRevision('block', () => open(u, { name: 'n2', task: 'algo', launcher: launcher(u), reviewLoad: () => { pidio = true; return cuentaDe(0); } }));
  assert.strictEqual(c.ok, false);
  assert.match(c.message, /Ya hay 1 trabajando y el tope es 1/);
  assert.strictEqual(pidio, false);
});

test('T11 Open_NoMedidoNoFrena @story-8.326 @ac-9', () => {
  conModoRevision('block', () => {
    const t = toy();
    const r = open(t, { name: 'n1', task: 'algo', launcher: launcher(t), reviewLoad: () => cuentaDe(2, null, { noMedido: { terminados: 0, carpetas: 248 } }) });
    assert.strictEqual(r.ok, true, r.message);
    assert.match(r.message, /no pude mirar: 248 carpetas/);
    const u = toy();
    const n = open(u, { name: 'n1', task: 'algo', launcher: launcher(u), reviewLoad: () => cuentaDe(8, { firmas: 8, terminados: null, carpetas: 0, pedidos: 0 }) });
    assert.strictEqual(n.ok, false, n.message);
    assert.match(n.message, /\? terminados/);
  });
});

test('T15 CapNotice_LineaUnaVezPorCambio @story-8.326 @ac-11', () => {
  const t = toy();
  session(t, 's-coord', 'Coord');
  designate(t, 's-coord');
  const turno = () => C.capNotice({ ...t.opts, env: { CLAUDE_CODE_SESSION_ID: 's-coord' } }) || '';
  RLIB.escribirFoto(t.state, cuentaDe(8, { firmas: 1, terminados: 2, carpetas: 3, pedidos: 2 }), NOW - 3 * 60000);
  assert.match(turno(), /Coordinación: 8 cosas esperan revisión de la persona \(tope 8\): 1 firmas, 2 terminados, 3 carpetas, 2 pedidos \(foto hace 3 min\)\. Antes de abrir otra, cerrá o guardá algo\./);
  assert.doesNotMatch(turno(), /esperan revisión/, 'igual: no se repite');
  RLIB.escribirFoto(t.state, cuentaDe(9, { firmas: 1, terminados: 2, carpetas: 4, pedidos: 2 }), NOW - 60000);
  assert.match(turno(), /9 cosas esperan revisión/, 'con una carpeta más, sale de nuevo');
  // status y su texto la muestran al pie, con la edad
  assert.match(C.statusText(C.status(t.opts)), /Lo que espera tu revisión: 9 cosas esperan revisión de la persona \(tope 8, .*\(foto hace un momento\)/);
});

test('T18 Open_TopeDeDecisionAgotado_Abre @story-8.326 @ac-3 @ac-9', () => {
  // la cuenta de verdad, con un hijo que no contesta: vuelve en el tope más un segundo, suelta el candado y abre
  const lab = toy();
  const lento = path.join(lab.root, 'lento.js');
  fs.writeFileSync(lento, 'setTimeout(() => {}, 60000)');
  for (const modo of ['warn', 'block']) {
    const t = toy();
    // stable-data: mide cuánto tarda la cuenta con su tope, no es una fecha que la prueba compare
    const desde = Date.now();
    const r = conModoRevision(modo, () => open(t, { name: 'n1', task: 'algo', launcher: launcher(t), reviewLoad: () => RLIB.reviewLoadSync({ home: t.home, env: {}, topeMs: 300, script: lento }) }));
    assert.ok(Date.now() - desde < 5000, `${modo}: tardó ${Date.now() - desde} ms`);
    assert.strictEqual(r.ok, true, `${modo}: ${r.message}`);
    if (modo === 'block') assert.match(r.message, /no pude mirar: firmas, terminados, carpetas, pedidos/);
    // el candado quedó suelto: otra apertura entra enseguida
    assert.strictEqual(open(t, { name: 'n2', task: 'algo', launcher: launcher(t), reviewLoad: () => cuentaDe(0) }).ok, true, modo);
  }
});

// ── Fila 70: la sesión que espera a su agente callado, y la espera anotada que vence ─────────────────────────────────

// La conversación de una sesión de fondo que lanzó un agente (y, si `fin`, su aviso de fin), y el archivo del agente con
// su último paso y su fecha.
function agenteDeFondo(t, sid, { agente = 'a1', minutosCallado = 30, fin = false } = {}) {
  const dir = path.join(t.home, '.claude', 'projects', t.root.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
  const renglones = [JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'lanzado' }] }, toolUseResult: { status: 'async_launched', agentId: agente } })];
  if (fin) renglones.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `<task-notification><task-id>${agente}</task-id><status>completed</status></task-notification>` } }));
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${renglones.join('\n')}\n`);
  const archivo = path.join(dir, sid, 'subagents', `agent-${agente}.jsonl`);
  fs.writeFileSync(archivo, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'python3 -' } }] } })}\n`);
  const fecha = new Date(mins(minutosCallado));
  fs.utimesSync(archivo, fecha, fecha);
}

test('T70a Status_EsperaASuAgenteCallado_LoDiceYNoEsQuieta: la sesión que espera a un agente que no escribe hace 20 min', () => {
  // 🔴 mutación: no leer los agentes de la conversación (la sesión sale quieta y nadie sabe que su agente se trabó)
  const t = toy();
  session(t, 's-bg', 'Fondo', { kind: 'bg', statusUpdatedAt: mins(60) });
  agenteDeFondo(t, 's-bg', { minutosCallado: 30 });
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.agentSilent.map((a) => [a.session, a.agente, a.minutos, a.herramienta]), [['Fondo', 'a1', 30, 'Bash']]);
  assert.deepStrictEqual(s.quiet, [], 'espera a su agente: no está quieta');
  assert.match(C.statusText(s), /Fondo espera a su agente a1, que no escribe hace 30 min \(su último paso: «Bash»\)/);
  // el agente escribe: trabaja por la sesión, no se dice nada
  const t2 = toy();
  session(t2, 's-bg', 'Fondo', { kind: 'bg', statusUpdatedAt: mins(60) });
  agenteDeFondo(t2, 's-bg', { minutosCallado: 5 });
  const s2 = C.status(t2.opts);
  assert.deepStrictEqual([s2.agentSilent, s2.quiet], [[], []]);
  // el agente terminó: la sesión sí está quieta
  const t3 = toy();
  session(t3, 's-bg', 'Fondo', { kind: 'bg', statusUpdatedAt: mins(60) });
  agenteDeFondo(t3, 's-bg', { minutosCallado: 30, fin: true });
  const s3 = C.status(t3.opts);
  assert.deepStrictEqual(s3.agentSilent, []);
  assert.deepStrictEqual(s3.quiet.map((q) => q.session), ['Fondo']);
});

test('T70b Status_EsperaAnotada_VenceALaMediaHora: --waiting-for ya no calla por horas el aviso de quieta', () => {
  // 🔴 mutación: la nota con espera vale tres horas como cualquier nota (la sesión no sale quieta hasta entonces)
  const t = toy();
  const doing = path.join(t.state, 'doing');
  fs.mkdirSync(doing, { recursive: true });
  const nota = (sid, campos) => {
    const f = path.join(doing, `${sid}.json`);
    fs.writeFileSync(f, JSON.stringify({ text: 'algo', at: new Date(mins(1)).toISOString(), ...campos }));
    fs.utimesSync(f, new Date(mins(1)), new Date(mins(1)));
  };
  session(t, 's-vieja', 'Vieja', { kind: 'bg', statusUpdatedAt: mins(60) }); nota('s-vieja', { waitingFor: 'a mi agente', waitingSince: new Date(mins(50)).toISOString() });
  session(t, 's-nueva', 'Nueva', { kind: 'bg', statusUpdatedAt: mins(60) }); nota('s-nueva', { waitingFor: 'a mi agente', waitingSince: new Date(mins(10)).toISOString() });
  session(t, 's-hace', 'Hace', { kind: 'bg', statusUpdatedAt: mins(60) }); nota('s-hace', {});
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.quiet.map((q) => q.session), ['Vieja'], 'la espera de hace 50 min ya no calla; la de 10 sí; la nota sin espera, como antes');
});

test('T70c OwnerWait_AgenteCallado_UnaVez: owner-wait le dice a la coordinadora que una sesión espera a su agente callado', () => {
  const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
  const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
  const t = toy();
  fs.writeFileSync(path.join(t.arnes, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  const COORD_SID = 's-coord';
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: COORD_SID, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
  session(t, COORD_SID, 'Coordinadora', { status: 'busy' });
  session(t, 's-bg', 'Fondo', { kind: 'bg', statusUpdatedAt: mins(60) });
  agenteDeFondo(t, 's-bg', { minutosCallado: 30 });
  const confirmada = OA.coordinadoraConfirmada;
  OA.coordinadoraConfirmada = (casa, o = {}) => confirmada(casa, { arnes: t.arnes, ...o });
  try {
    const vuelta = (seg) => C.ownerWaitOnce({ ...t.opts, sessionId: COORD_SID, now: NOW + seg * 1000, ownerWaits: () => ({ esperas: [], problemas: [] }), signatureDestinos: () => [] }).lines;
    assert.deepStrictEqual(vuelta(0).filter((l) => /agente/.test(l)), ['Fondo espera a su agente a1, que no escribe hace 30 min (su último paso: «Bash»)']);
    assert.deepStrictEqual(vuelta(2).filter((l) => /agente/.test(l)), [], 'una vez');
  } finally {
    OA.coordinadoraConfirmada = confirmada;
  }
});

// ── Los planes que esperan su aprobación (defecto 11 de la fila de la coordinadora) ──
// Un plan cerrado que espera «Aprobar el plan» no pide su firma hasta que alguien la pide: no tiene renglón en la lista de
// firmas, y la coordinadora veía «0 firmas pendientes» mientras cinco sesiones esperaban 3 h.
const planEsperando = (t, sid, name, { story = '9.11', hace = 180, extra = {} } = {}) => {
  session(t, sid, name, { kind: 'bg' });
  marker(t, sid, { storyId: story, stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan'], stepsPending: ['approve-plan', 'implement'],
    stepTimings: { plan: { completedAt: new Date(mins(hace)).toISOString() } }, ...extra });
};

// Planes_EsperandoAprobacion_EnStatus
// 🔴 Falla con: status dice «0 firmas pendientes» con un plan cerrado esperando su aprobación hace 3 h.
test('Planes_EsperandoAprobacion_EnStatus: el plan que espera su aprobación sale en «Firmas pendientes» con su sesión y su espera', () => {
  const t = toy();
  planEsperando(t, 's-ana', 'Ana');
  // uno con el plan ya aprobado y otro sin el plan cerrado: no esperan
  session(t, 's-bea', 'Bea', { kind: 'bg' });
  marker(t, 's-bea', { storyId: '9.12', stepScheme: 2, stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan'], stepsPending: ['implement'] });
  session(t, 's-ceci', 'Ceci', { kind: 'bg' });
  marker(t, 's-ceci', { storyId: '9.13', stepScheme: 2, stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'approve-plan'] });
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.plansWaiting.map((p) => [p.sid, p.storyId, p.minutes]), [['s-ana', '9.11', 180]]);
  const texto = C.statusText(s);
  assert.match(texto, /Firmas pendientes: .*1 plan esperando su aprobación/);
  assert.match(texto, /Ana \(s-ana\): el plan de la 9\.11 espera su aprobación hace 180 min/);
  assert.ok(!texto.split('\n').some((l) => /espera su aprobación/.test(l) && /Bea|Ceci/.test(l)), texto);
});

// Planes_Delicado_LoApruebaLaPersona
// 🔴 Falla con: owner-next le dice a la coordinadora que puede dar el plan de una historia delicada porque el perfil nombra
// plan-approval:delicada (fila 127). El plan de una delicada lo aprueba una persona, diga lo que diga el perfil.
test('Planes_Delicado_LoApruebaLaPersona: aunque el perfil nombre plan-approval:delicada y la revisión lo aprobó, lo aprueba la persona', () => {
  const t = toy();
  planEsperando(t, 's-ana', 'Ana');
  planEsperando(t, 's-bea', 'Bea', { story: '9.12', hace: 30 });
  const deps = {
    revision: (sid) => (sid === 's-ana' ? { veredicto: 'aprobado', delicate: { value: true } } : { veredicto: 'rechazado', delicate: { value: true } }),
    delegada: () => true,
  };
  const rows = C.plansWaiting({ ...t.opts, planDeps: deps });
  assert.deepStrictEqual(rows.map((p) => [p.sid, p.review]), [['s-ana', 'aprobado'], ['s-bea', 'rechazado']]);
  const lineas = C.planWaitLines(rows);
  assert.match(lineas[0], /Ana \(s-ana\).*revisión: aprobado\) — lo aprueba la persona$/);
  for (const l of lineas) assert.doesNotMatch(l, /coordinadora|delega|--for-session/, l);
});

// Planes_OwnerNext_LosNombra
// 🔴 Falla con: owner-next dice «No hay nada que espere a la persona» con planes esperando su aprobación.
test('Planes_OwnerNext_LosNombra: owner-next suma los planes que esperan, aunque la lista de firmas esté vacía', () => {
  const t = toy();
  planEsperando(t, 's-ana', 'Ana');
  const r = { tipo: 'nada', texto: 'No hay nada que espere a la persona.', problemas: [], faltaRepetir: [] };
  const nota = C.ownerNextPlans({ ...t.opts, sesion: 's-coord' });
  assert.ok(nota && nota.length, 'hay líneas');
  const texto = C.ownerNextText(r, 's-coord', { reemplaza: true, lineas: nota });
  assert.doesNotMatch(texto, /No hay nada que espere a la persona/);
  assert.match(texto, /Ana \(s-ana\): el plan de la 9\.11 espera su aprobación/);
});

// Planes_DuenoAusente_SeJuntanParaLaVuelta
// 🔴 Falla con: con la marca de ausente, los planes no se juntan en el aviso para cuando vuelva la persona.
test('Planes_DuenoAusente_SeJuntanParaLaVuelta: con la marca de ausente, el aviso los junta sin cuadro; sin ella, no', () => {
  const rows = [
    { sid: 's-ana', session: 'Ana', storyId: '9.11', minutes: 180, review: 'aprobado', porCoordinadora: false },
    { sid: 's-bea', session: 'Bea', storyId: '9.12', minutes: 30, review: null, porCoordinadora: false },
  ];
  assert.deepStrictEqual(C.planAwayLines(rows, null), []);
  const l = C.planAwayLines(rows, { setAt: '2026-10-25T10:00:00.000Z' }).join('\n');
  assert.match(l, /para cuando vuelva la persona: 2 planes esperan su aprobación/);
  assert.match(l, /Ana \(9\.11, hace 180 min\)/);
  assert.match(l, /sin cuadro/);
  // en el aviso de la coordinadora: con la marca, una línea; sin ella, no
  const t = toy();
  designate(t, 'coord-1');
  session(t, 'coord-1', 'Coord', { kind: 'interactive' });
  planEsperando(t, 's-ana', 'Ana');
  const aviso = () => C.capNotice({ ...t.opts, sessionId: 'coord-1', readMemory: () => ({ pct: 62, why: null }) }) || '';
  assert.doesNotMatch(aviso(), /para cuando vuelva la persona/);
  require(path.join(ROOT, 'scripts', 'lib', 'owner-away.js')).set({ estado: t.state, quien: 'coordinadora', frase: 'me voy', ahora: mins(100) });
  assert.match(aviso(), /Coordinación: para cuando vuelva la persona: 1 plan espera su aprobación: Ana \(9\.11, hace 180 min\)/);
});

// ── Fila 86: relanzar una sesión de fondo la deja como abierta por la coordinadora ──────────────────────────────────────

// Un lanzador de juguete que, con `respawn <id>`, deja viva la sesión de fondo con ese id: su archivo de sesión, con el pid de
// esta prueba (vivo) y la hora de ahora, como la levanta Claude Code. `slowMs`: tarda eso después de dejarla viva.
function relauncher(t, { name = 'Relanzada', cwd = null, fail = null, appear = true, slowMs = 0 } = {}) {
  const script = path.join(t.root, 'relauncher.js');
  fs.writeFileSync(script, `
const fs = require('fs');
const [verb, id] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(t.root, 'closed.log'))}, verb + ' ' + id + '\\n');
if (${JSON.stringify(fail)}) { process.stderr.write(${JSON.stringify(String(fail))} + '\\n'); process.exit(1); }
if (${JSON.stringify(appear)}) fs.writeFileSync(${JSON.stringify(path.join(t.home, '.claude', 'sessions', 'sid-relanzada.json'))}, JSON.stringify({ pid: ${process.pid}, sessionId: 'sid-relanzada', name: ${JSON.stringify(name)}, nameSource: 'user', kind: 'bg', jobId: id, status: 'idle', statusUpdatedAt: Date.now(), startedAt: Date.now(), cwd: ${JSON.stringify(cwd || t.root)} }));
if (${slowMs}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${slowMs});
`);
  return { bin: process.execPath, prefix: [script] };
}
const ID = 'abcd1234';

test('T86a Relaunch_QuedaComoAbiertaPorLaCoordinadora: la que relanza coordination.js relaunch cuenta como abierta por ella', () => {
  // 🔴 mutación: relanzar sin anotarla (una sesión relanzada a mano no está en el registro: sus firmas de rutina van al dueño)
  const t = closeLab();
  const r = C.relaunch({ ...t.closeOpts, id: ID, launcher: relauncher(t, { cwd: t.repo }) });
  assert.strictEqual(r.ok, true, r.message);
  assert.match(r.message, /relancé «Relanzada» \(abcd1234\)/);
  assert.deepStrictEqual(closed(t), [`respawn ${ID}`]);
  assert.deepStrictEqual(C.launchedBy({ home: t.home, sid: 'sid-relanzada' }), { launched: true });
  // la misma sesión relanzada a mano, sin pasar por coordination.js, no está en el registro
  const t2 = closeLab();
  spawnSync(process.execPath, [relauncher(t2).prefix[0], 'respawn', ID]);
  assert.deepStrictEqual(C.launchedBy({ home: t2.home, sid: 'sid-relanzada' }), { launched: false });
  // el lanzador tardó más que su tope pero la dejó viva: se anota igual
  const t3 = closeLab();
  const lenta = C.relaunch({ ...t3.closeOpts, id: ID, timeoutMs: 500, launcher: relauncher(t3, { slowMs: 3000 }) });
  assert.strictEqual(lenta.ok, true, lenta.message);
  assert.deepStrictEqual(C.launchedBy({ home: t3.home, sid: 'sid-relanzada' }), { launched: true });
});

test('T86b Relaunch_LoQueNoRelanza: otra sesión, un id incompleto, una viva, un archivo ilegible o un lanzador que falla no relanzan ni anotan', () => {
  const t = closeLab();
  const otra = C.relaunch({ ...t.opts, env: { CLAUDE_CODE_SESSION_ID: 'sid-otra' }, id: ID, launcher: relauncher(t) });
  assert.match(otra.message, /la coordinadora designada o una persona en su terminal/);
  // el id entero, de 8 caracteres: claude respawn toma el comienzo de un id y relanzaría una viva
  for (const id of ['-rm', 'abcd', 'job-rel']) assert.match(C.relaunch({ ...t.closeOpts, id, launcher: relauncher(t) }).message, /relaunch va con --id <el id de fondo, de 8 caracteres>/, id);
  bg(t, 'viva', t.repo, { jobId: 'beef0001' });
  assert.match(C.relaunch({ ...t.closeOpts, id: 'beef0001', launcher: relauncher(t) }).message, /«viva» \(beef0001\) está viva: no relancé nada/);
  const falla = C.relaunch({ ...t.closeOpts, id: ID, launcher: relauncher(t, { fail: 'no existe ese id' }) });
  assert.strictEqual(falla.ok, false);
  assert.match(falla.message, /no la pude relanzar \(no existe ese id\)/);
  assert.deepStrictEqual(closed(t), [`respawn ${ID}`], 'sólo el que falló llegó al lanzador');
  assert.deepStrictEqual(C.launchedBy({ home: t.home, sid: 'sid-relanzada' }), { launched: false });
  // el lanzador volvió bien pero la sesión no apareció: lo dice y no anota nada
  const t2 = closeLab();
  const muda = C.relaunch({ ...t2.closeOpts, id: ID, waitMs: 300, launcher: relauncher(t2, { appear: false }) });
  assert.strictEqual(muda.ok, true);
  assert.match(muda.message, /no la vi viva/);
  // con el lanzador vencido y sin verla, no dice que no pasó nada
  const t3 = closeLab();
  const vencido = C.relaunch({ ...t3.closeOpts, id: ID, timeoutMs: 300, waitMs: 300, launcher: relauncher(t3, { appear: false, slowMs: 3000 }) });
  assert.match(vencido.message, /no sé si la relanzó/);
  // un archivo de sesión que no se lee: puede ser la viva con ese id, y no se relanza
  const t4 = closeLab();
  fs.writeFileSync(path.join(t4.home, '.claude', 'sessions', 'sid-rota.json'), '{ roto');
  assert.match(C.relaunch({ ...t4.closeOpts, id: ID, launcher: relauncher(t4) }).message, /No pude leer todas las sesiones/);
  assert.deepStrictEqual(closed(t4), []);
});

test('T86c Relaunch_NombreDeOtraViva: si otra sesión viva ya usa su nombre, no la anota ni le borra el registro a la otra', () => {
  const t = closeLab();
  const at = Date.now();
  session(t, 'sid-abierta', 'Relanzada', { cwd: t.repo, kind: 'bg', jobId: 'aaaa0001', startedAt: at });
  fs.mkdirSync(path.join(t.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'coordination', 'launched.json'), JSON.stringify([{ name: 'Relanzada', cwd: t.repo, at, por: COORD_SID }]));
  assert.deepStrictEqual(C.launchedBy({ home: t.home, sid: 'sid-abierta' }), { launched: true });
  const r = C.relaunch({ ...t.closeOpts, id: ID, launcher: relauncher(t, { cwd: t.repo }) });
  assert.match(r.message, /otra sesión viva ya se llama «Relanzada»: no la anoté/);
  assert.deepStrictEqual(C.launchedBy({ home: t.home, sid: 'sid-abierta' }), { launched: true }, 'la otra conserva su registro');
});

// ── Fila 98: la sesión que dice que trabaja, pero no escribe hace rato y no corre nada ──────────────────────────────────

// La conversación de una sesión con su último paso, escrita hace `minutos`; con `agente`, un archivo de agente escrito hace
// `agenteMin` (en un lote de flujo si `lote`).
function conversacionQuieta(t, sid, { minutos, agenteMin = null, lote = false, dir: carpeta = null } = {}) {
  const dir = carpeta || path.join(t.home, '.claude', 'projects', t.root.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(archivo, `${JSON.stringify({ type: 'assistant', timestamp: new Date(mins(minutos)).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })}\n`);
  fs.utimesSync(archivo, new Date(mins(minutos)), new Date(mins(minutos)));
  if (agenteMin != null) {
    const sub = lote ? path.join(dir, sid, 'subagents', 'workflows', 'wf_1') : path.join(dir, sid, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const a = path.join(sub, 'agent-x1.jsonl');
    fs.writeFileSync(a, '{}\n');
    fs.utimesSync(a, new Date(mins(agenteMin)), new Date(mins(agenteMin)));
  }
}

test('T98a Status_OcupadaCalladaSinNadaCorriendo_LoDice: la que dice que trabaja y no escribe hace una hora, sin agentes, sale', () => {
  // 🔴 mutación: no mirar las ocupadas (una sesión trabada pasa por trabajando y nadie se entera)
  const t = toy();
  session(t, 's-trabada', 'Trabada', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t, 's-trabada', { minutos: 70 });
  session(t, 's-agente', 'ConAgente', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t, 's-agente', { minutos: 70, agenteMin: 5 });
  session(t, 's-lote', 'ConLote', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t, 's-lote', { minutos: 70, agenteMin: 5, lote: true });
  session(t, 's-reciente', 'Reciente', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t, 's-reciente', { minutos: 40 });
  session(t, 's-sin', 'SinConversacion', { status: 'busy', statusUpdatedAt: mins(90) });
  const s = C.status(t.opts);
  assert.deepStrictEqual(s.busySilent.map((b) => [b.session, b.minutos, b.herramienta]), [['Trabada', 70, 'Bash']]);
  assert.match(C.statusText(s), /Trabada dice que trabaja, pero no escribe hace 70 min y no corre nada \(su último paso: «Bash»\): ¿trabada\?/);
  assert.ok(s.working.some((w) => w.session === 'Trabada'), 'sigue contando como trabajando para el tope');
  // un agente viejo (hace 40 min) no cuenta como algo que corre
  const t2 = toy();
  session(t2, 's-trabada', 'Trabada', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t2, 's-trabada', { minutos: 70, agenteMin: 40 });
  assert.deepStrictEqual(C.status(t2.opts).busySilent.map((b) => b.session), ['Trabada']);
});

test('T98b OwnerWait_OcupadaCallada_UnaVez: owner-wait le dice a la coordinadora una vez por sesión, y se olvida si vuelve a escribir', () => {
  const OA = require(path.join(ROOT, 'scripts', 'lib', 'owner-approvals.js'));
  const DS = require(path.join(ROOT, 'scripts', 'lib', 'delegated-signing.js'));
  const t = toy();
  fs.writeFileSync(path.join(t.arnes, 'team-profile.json'), JSON.stringify({ approvals: { relay_session: 'coordinadora' } }));
  const COORD_SID = 's-coord';
  const d = { name: 'relay-designation', status: 'ok', ts: new Date(NOW).toISOString(), sesion: COORD_SID, rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' };
  fs.writeFileSync(path.join(t.state, 'gates.log'), `${JSON.stringify(d)}\n${JSON.stringify(DS.confirmationRecord(d, new Date(NOW).toISOString()))}\n`);
  session(t, COORD_SID, 'Coordinadora', { status: 'busy' });
  session(t, 's-trabada', 'Trabada', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t, 's-trabada', { minutos: 70 });
  const confirmada = OA.coordinadoraConfirmada;
  OA.coordinadoraConfirmada = (casa, o = {}) => confirmada(casa, { arnes: t.arnes, ...o });
  try {
    const vuelta = (seg) => C.ownerWaitOnce({ ...t.opts, sessionId: COORD_SID, now: NOW + seg * 1000, ownerWaits: () => ({ esperas: [], problemas: [] }), signatureDestinos: () => [] }).lines;
    assert.deepStrictEqual(vuelta(0).filter((l) => /trabada/.test(l)), ['Trabada dice que trabaja, pero no escribe hace 70 min y no corre nada (su último paso: «Bash»): ¿trabada?']);
    assert.deepStrictEqual(vuelta(2).filter((l) => /trabada/.test(l)), [], 'una vez');
    // el «¿seguís?» que le manda la coordinadora toca el archivo: no es que volvió a escribir, y no se la olvida
    const archivo = path.join(t.home, '.claude', 'projects', t.root.replace(/[^A-Za-z0-9-]/g, '-'), 's-trabada.jsonl');
    fs.appendFileSync(archivo, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(NOW + 2500).toISOString(), content: '¿seguís?' })}\n`);
    assert.deepStrictEqual(vuelta(3).filter((l) => /trabada/.test(l)), []);
    fs.utimesSync(archivo, new Date(mins(70)), new Date(mins(70)));
    assert.deepStrictEqual(vuelta(4).filter((l) => /trabada/.test(l)), [], 'no se la olvidó: no la repite');
  } finally {
    OA.coordinadoraConfirmada = confirmada;
  }
});

test('T98c Status_OcupadaCallada_LoQueLlegaNoEsSuPaso: un mensaje que le llega, el estado «shell» y un error de lectura no cambian lo que se dice', () => {
  // 🔴 un mensaje que le llega (el «¿seguís?» de la coordinadora) toca el archivo: no es la sesión trabajando
  const t = toy();
  session(t, 's-trabada', 'Trabada', { status: 'busy', statusUpdatedAt: mins(90) });
  conversacionQuieta(t, 's-trabada', { minutos: 70 });
  const archivo = path.join(t.home, '.claude', 'projects', t.root.replace(/[^A-Za-z0-9-]/g, '-'), 's-trabada.jsonl');
  fs.appendFileSync(archivo, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(mins(1)).toISOString(), content: '<cross-session-message>¿seguís?</cross-session-message>' })}\n`);
  fs.utimesSync(archivo, new Date(mins(1)), new Date(mins(1)));
  assert.deepStrictEqual(C.status(t.opts).busySilent.map((b) => [b.session, b.minutos]), [['Trabada', 70]]);
  // un paso suyo hace 2 min sí es la sesión trabajando
  fs.appendFileSync(archivo, `${JSON.stringify({ type: 'user', timestamp: new Date(mins(2)).toISOString(), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })}\n`);
  assert.deepStrictEqual(C.status(t.opts).busySilent, []);
  // «shell»: terminó su turno con un comando de fondo corriendo; no está trabada
  const t2 = toy();
  session(t2, 's-shell', 'ConComando', { status: 'shell', statusUpdatedAt: mins(90) });
  conversacionQuieta(t2, 's-shell', { minutos: 70 });
  assert.deepStrictEqual(C.status(t2.opts).busySilent, []);
  // una conversación que no se puede leer no es un problema que frene los avisos de las demás
  const t3 = toy();
  session(t3, 's-rota', 'Rota', { status: 'busy', statusUpdatedAt: mins(90) });
  fs.mkdirSync(path.join(t3.home, '.claude', 'projects', t3.root.replace(/[^A-Za-z0-9-]/g, '-'), 's-rota.jsonl'), { recursive: true });
  const s3 = C.status(t3.opts);
  assert.deepStrictEqual([s3.busySilent, s3.problems.filter((p) => /s-rota/.test(p))], [[], []]);
});

test('T98d Status_OcupadaCallada_CarpetaLarga: con un cwd largo, Claude Code corta el nombre de su carpeta y la conversación igual se encuentra', () => {
  const t = toy();
  const largo = path.join(t.root, ...Array.from({ length: 20 }, (_, i) => `carpeta-xxxxxxxx-${i}`));
  fs.mkdirSync(largo, { recursive: true });
  session(t, 's-larga', 'Larga', { status: 'busy', statusUpdatedAt: mins(90), cwd: largo });
  const codificado = largo.replace(/[^A-Za-z0-9-]/g, '-');
  assert.ok(codificado.length > 200);
  // la carpeta como la arma Claude Code para un nombre de más de 200 caracteres: su principio y una marca
  conversacionQuieta(t, 's-larga', { minutos: 70, dir: path.join(t.home, '.claude', 'projects', `${codificado.slice(0, 200)}-1a2b3c`) });
  assert.deepStrictEqual(C.status(t.opts).busySilent.map((b) => b.session), ['Larga']);
});
