'use strict';
// office-fixtures.js — what the office test files share: the toy /wip results, toy machines, toy repos and the helpers
// that read the page. Each office-<zone>.test.js takes from here only what it uses. Nothing here reads the real HOME:
// the command-line helpers run with a toy HOME.
// stable-data: every date comes in by argument or by --now.

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OFFICE = path.join(__dirname, '..', '..', 'tools', 'office.js');
const { buildOffice, page, importMap, MODULES, prsNamedIn, waitedPrsSaid, askWaitingPrs, tokensTxt, tokensCard } = require(OFFICE);
// el código de la página: la oficina viva lo pide aparte, y lo mismo el sitio
const PAGE_CODE = () => fs.readFileSync(path.join(path.dirname(OFFICE), 'office', 'page.js'), 'utf8');

const NOW = Date.parse('2026-10-18T14:00:00.000Z');
const STEPS = [{ id: 'implement', name: 'Implementar', done: true }, { id: 'run-tests', name: 'Correr las pruebas', done: false }];

// A /wip result with one row per entry: `{ session, sid, status, extra, meanwhile }`.
function wip(entries, more = {}) {
  return {
    rows: entries.map((e) => ({ work: e.work || `Story ${e.session}`, state: e.state || 'en curso', end: e.end || '15:00', session: e.session, folder: 'repo-a', ...(e.meanwhile ? { meanwhile: e.meanwhile } : {}) })),
    details: entries.map((e) => ({ sid: e.sid || `sid-${e.session}`, status: 'status' in e ? e.status : 'busy', statusAt: e.statusAt || null })),
    extra: entries.map((e) => e.extra || { kind: 'loose' }),
    free: [],
    halfway: [],
    unreadable: [],
    ...more,
  };
}

const byName = (data, name) => data.agents.find((a) => a.nombre === name);

// The page's own time helpers (from DAYS to finTxt), run outside the browser.
function pageTimeHelpers() {
  const html = page({ agents: [], items: [], meta: { teToca: [] }, rows: [], free: [], unreadable: [] });
  const code = html.slice(html.indexOf('const DAYS='), html.indexOf('function renderTop'));
  return new Function(`${code.replace(/^(const (AST|SHIRT|agents)=|let agents|function setData|setData\(DATA\)).*$/gm, '')}; return { finTxt };`)();
}

// A toy HOME with the pipeline's state folder and one quiet session.
function toyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  const state = path.join(home, '.claude', '.tycon-pipeline');
  for (const d of ['active', 'adhoc', 'timing-history']) fs.mkdirSync(path.join(state, d), { recursive: true });
  const sessions = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'sesion-a', status: 'idle', statusUpdatedAt: NOW - 20 * 60000 }));
  return { home, state };
}

// sin el sitio de la organización: el perfil del equipo, puesto encima del árbol en la validación, sí trae site.url
const run = (home, args) => execFileSync('node', [OFFICE, ...args], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_LINK: '0' }, stdio: 'pipe' }).toString();

// ---------- los datos de la tarjeta: la hora de fin, el título, los textos en llano y lo que quedó a medio camino ----------

const { buildWip } = require(path.join(__dirname, '..', '..', 'tools', 'work-in-progress.js'));
const { stateDir } = require(path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const MARKER = path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');

// A toy machine for /wip: state, sessions and stories in one throwaway folder.
function toyMachine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-b0-'));
  const state = path.join(root, 'state');
  const sessions = path.join(root, 'sessions');
  for (const d of ['active', 'adhoc', 'doing', 'timing-history']) fs.mkdirSync(path.join(state, d), { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  return { root, state, sessions };
}
const liveSession = (m, sid, name) => fs.writeFileSync(path.join(m.sessions, `${sid}.json`),
  JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: NOW }));
function storyFile(m, id, title, pipelines = '') {
  const p = path.join(m.root, `story-${id}.md`);
  fs.writeFileSync(p, `---\nstory: "${id}"\ntitle: "${title}"\n${pipelines}---\n# Story\n`);
  return p;
}
const runMarker = (home, sid, args) => {
  try {
    execFileSync('node', [MARKER, ...args], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid }, stdio: 'pipe' });
    return 0;
  } catch (e) { return e.status; }
};

// Un `node` con la hora fija, para probar el cambio de día de una hora declarada.
function markerAt(home, sid, localMs, args) {
  const pre = path.join(home, 'now.js');
  fs.writeFileSync(pre, `const t=${localMs};Date.now=()=>t;`);
  return require('child_process').spawnSync('node', ['-r', pre, MARKER, ...args], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' });
}

// ---------- la oficina viva: una tarjeta, el sitio, abrir sin cmd, los escritorios y la promesa de cada corrida ----------

const { openFile, deskSlots } = require(OFFICE);

// ── El tablero de la coordinadora: <estado>/coordination/tablero.json, en un panel aparte ─────────────────────────────

const BOARD = {
  meta: { actualizado: '2026-10-18T10:55', resumen: 'Dos cosas en curso y una esperando tu firma.', teToca: ['Firmar el ok de guardar de la B'] },
  agentes: [{ nombre: 'Almeida', estado: 'curso' }],
  pendientes: [
    { titulo: 'Más adelante uno', estado: 'espera', grupo: 'Más adelante', orden: 1, quien: 'Beto', nota: 'Cuando haya lugar' },
    { titulo: 'La oficina en vivo', estado: 'curso', grupo: 'Hoy', orden: 2, quien: 'Almeida', estimadaIso: '2026-10-18T12:00', pronosticoIso: '2026-10-18T12:30', nota: 'Falta guardar' },
    { titulo: 'Primero de hoy', estado: 'firma', grupo: 'Hoy', orden: 1, quien: 'vos', termina: 'cuando firmes' },
    { titulo: 'Esta semana uno', estado: 'riesgo', grupo: 'Esta semana', orden: 1, quien: 'Angelito', estimadaIso: '2026-10-20T18:00' },
    { titulo: 'La excepción del GUID', estado: 'hecho', grupo: 'Hoy', orden: 3, quien: 'Angelito', realIso: '2026-10-18T09:10' },
    { titulo: 'Otro grupo', estado: 'curso', grupo: 'Algún día', orden: 1, quien: 'Beto' },
  ],
};

async function collectWith(text) {
  const { collect } = require(OFFICE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tab-'));
  for (const d of ['active', 'adhoc', 'doing', 'office', 'coordination']) fs.mkdirSync(path.join(stateDir(home), d), { recursive: true });
  if (text != null) fs.writeFileSync(path.join(stateDir(home), 'coordination', 'tablero.json'), text);
  return collect({ home, now: new Date(NOW).toISOString(), siteUrl: async () => ({ code: 3, out: '' }) });
}

// ── La sala arriba, el tablero abajo y compacto ──────────────────────────────────────────────────────────────────────

// Un DOM mínimo: lo justo para correr la función del tablero de la página tal cual.
function tinyDom() {
  const node = (tag) => {
    const n = { tag, className: '', textContent: '', hidden: false, children: [], style: { setProperty() {} }, attrs: {} };
    n.appendChild = (c) => { n.children.push(c); return c; };
    n.append = (...cs) => { cs.forEach((c) => n.children.push(typeof c === 'string' ? { tag: '#text', textContent: c, children: [] } : c)); };
    n.replaceChildren = () => { n.children = []; };
    n.setAttribute = (k, v) => { n.attrs[k] = v; };
    return n;
  };
  const byId = { board: node('section'), boardBody: node('div') };
  return { document: { createElement: node, getElementById: (id) => byId[id] || null }, byId };
}
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => all(c, pred, out)); return out; };
const textOf = (n) => (n.textContent || '') + (n.children || []).map(textOf).join('');

// La función del kanban de la página, corrida fuera del navegador con un DOM mínimo.
function drawKanban(data) {
  const html = page(data);
  const fn = (html.match(/function renderBoard\(\)\{[\s\S]*?\n\}/) || [])[0];
  const el = (html.match(/const el=(\([^\n]*\});\n/) || [])[1];
  assert.ok(fn && el, 'la página trae la función y el ayudante');
  const { document, byId } = tinyDom();
  const state = (html.match(/function estadoDeHora\(i\)[^\n]*\n/) || [''])[0];
  // lo abierto del kanban vive fuera de la función, para que una foto nueva no lo cierre; `redraw` dibuja otra foto
  const open = (html.match(/const historiasAbiertas=new Set\(\);\n/) || [''])[0];
  const { redraw } = new Function('document', 'DATA', `const el=${el};${open}${state}${fn};renderBoard();return {redraw:(d)=>{DATA=d;renderBoard();}};`)(document, data);
  return { html, fn, body: byId.boardBody, sec: byId.board, redraw };
}

// ---------- el archivo de estado de cada sesión ----------

// Un archivo de sesión como lo escriben el gancho y marker.js, con lo que la prueba cambie.
const sessionFile = (session, fields = {}) => ({
  schema: 1, session, tool: 'claude', name: null, sentence: 'Trabaja sin pipeline.', step: null, endAt: null, endWithoutHour: null,
  waitingForOwner: false, waitingFor: null, updatedAt: new Date(NOW - 60000).toISOString(), pid: process.pid, ...fields,
});

// The page clock, run outside the browser with a fake time and counted network calls.
function pageClock(html) {
  const from = html.indexOf('// el reloj de la página');
  const to = html.indexOf('// fin del reloj');
  assert.ok(from > 0 && to > from, 'la página trae su reloj');
  const calls = { net: 0 };
  const count = () => { calls.net += 1; };
  const fn = new Function('fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', `${html.slice(from, to)}; return { relojTick, umbral };`);
  return { ...fn(count, function W() { count(); }, function X() { count(); }, function E() { count(); }), calls };
}

// ---------- el estado real, «Tu firma», el trabajo de ahora, el kanban, la hora y la marca ----------

const { spawnSync } = require('child_process');
const { wipNow } = require(path.join(__dirname, '..', '..', 'tools', 'work-in-progress.js'));
const { collect, buildBoard, createEnvelopes } = require(OFFICE);
const STEP_LIB = require(path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));

const col = (data, id) => data.kanban.columnas.find((c) => c.id === id);
const titles = (data, id) => col(data, id).tarjetas.map((t) => t.titulo);
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const IDS = STEP_LIB.STEPS.filter((s) => !s.flag).map((s) => s.id);
// un marcador con los pasos por nombre, con `done` hechos
const runMarkerFile = (m, sid, id, title, done, extra = {}) => fs.writeFileSync(path.join(m.state, 'active', `${sid}.json`), JSON.stringify({
  sessionId: sid, storyId: id, storyPath: storyFile(m, id, title), stepScheme: STEP_LIB.SCHEME, stepsCompleted: done, stepsPending: IDS.filter((s) => !done.includes(s)), ...extra,
}));
const BEFORE_PLAN = ['start', 'validate-story', 'plan'];
const CLOSED = { stepsCompleted: IDS, stepsPending: [] };
const sessionWith = (m, sid, name, status, at = NOW) => fs.writeFileSync(path.join(m.sessions, `${sid}.json`),
  JSON.stringify({ pid: process.pid, sessionId: sid, name, status, statusUpdatedAt: at }));
// un repo de verdad, en una rama de historia, con `origin` en GitHub: `dirty` deja un archivo sin commitear
function toyRepo(m, name, { dirty = false } = {}) {
  const dir = path.join(m.root, name);
  fs.mkdirSync(dir);
  // stable-data: el commit de juguete lleva fecha fija y el mantenimiento de git apagado
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA } });
  git('init', '-q', '-b', 'story/9.9-algo');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');
  if (dirty) fs.writeFileSync(path.join(dir, 'a.txt'), 'dos\n');
  return dir;
}
const noPrs = async (qs) => qs.map(() => ({ prs: [] }));
const atIso = (ms) => new Date(ms).toISOString();

async function ownerMachine() {
  const m = toyMachine();
  const now = NOW;
  const repo = toyRepo(m, 'con-cambios', { dirty: true });
  runMarkerFile(m, 'p1', '9.1', 'Espera el plan', BEFORE_PLAN);
  sessionWith(m, 'p1', 'Plan', 'idle', now - 600000);
  fs.writeFileSync(path.join(m.state, 'active', 'g1.json'), JSON.stringify({ sessionId: 'g1', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Espera guardar'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED }));
  sessionWith(m, 'g1', 'Guardar', 'idle', now - 600000);
  runMarkerFile(m, 'b1', '9.2', 'Revisan el plan', BEFORE_PLAN);
  sessionWith(m, 'b1', 'Ocupada', 'busy');
  runMarkerFile(m, 'cx', '9.3', 'El plan de Codex', BEFORE_PLAN);
  const w = await wipNow({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(now), home: m.root, queryAll: noPrs });
  return { m, now, repo, w };
}

const KANBAN_BOARD = {
  pendientes: [
    { titulo: 'Sin arrancar', estado: 'sin-empezar', grupo: 'Hoy', orden: 1 },
    { titulo: 'Espera turno', estado: 'espera', grupo: 'Esta semana', orden: 1 },
    { titulo: 'Hecho uno', estado: 'hecho', realIso: '2026-10-18T09:10', quien: 'Beto' },
    { titulo: 'Hecho dos', estado: 'hecho', realIso: '2026-10-18T09:20', quien: 'Beto' },
    { titulo: 'Lo de la persona con sesión', estado: 'curso', quien: 'Ana (la tanda B)' },
    { titulo: 'Lo de alguien sin sesión', estado: 'curso', quien: 'Rita' },
  ],
};

const hourRun = (fields) => ({ kind: 'pipeline', storyId: '9.1', title: 'Una', current: 'implement', steps: STEPS, ...fields });

// Una máquina de juguete con la HOME entera, para correr marker.js y leer /office y /wip de verdad.
function parkMachine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-marca-'));
  const sdir = stateDir(home);
  for (const d of ['active', 'adhoc', 'doing', 'timing-history']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  const sessions = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const m = { root: home, state: sdir, sessions, home };
  return m;
}
const collectAt = (m, nowMs, more = {}) => collect({ home: m.home, now: atIso(nowMs), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), queryAll: noPrs, ...more });
const ddmm = (ms) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ── Las regresiones del pase adversarial del estado real ─────────────────────────────────────────────────────────────

const parked = (m, sid, body) => { fs.mkdirSync(path.join(m.state, 'parked'), { recursive: true }); fs.writeFileSync(path.join(m.state, 'parked', `${sid}.json`), body); };
const oldHours = (now, h) => atIso(now - h * 3600000);

// ---------- los datos que se veían mal: título, hora, pruebas, pendientes, tablas y ficha ----------

const localIsoAt = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

const { buildTables } = require(path.join(__dirname, '..', '..', 'tools', 'office.js'));
const KANBAN_FOR_TABLES = { columnas: [
  { id: 'firma', tarjetas: [{ titulo: 'Firmar algo', hora: '' }] },
  { id: 'curso', tarjetas: [{ titulo: 'Con hora', hora: 'lun 12:00 · en hora' }, { titulo: 'Sin hora', hora: 'sin hora estimada' }] },
  { id: 'entrando', tarjetas: [{ titulo: 'En la cola', hora: 'esperando entrar' }] },
  { id: 'sinEmpezar', tarjetas: [{ titulo: 'Después', hora: 'sáb 18:00' }] },
  { id: 'hechos', tarjetas: [{ titulo: 'Hecho', hora: 'lun 09:00' }] },
], medioCamino: [{ titulo: 'Quedó', accion: 'x' }] };

// ── Las vistas del trabajo, «A medio camino» de verdad y los números que cierran ─────────────────────────────────────

// El panel que se abre al tocar la pared, fuera del navegador.
const wallOrderCode = (html) => { const fn = (html.match(/function paredEnOrden\(K\)\{.*\}\n/) || [])[0]; assert.ok(fn, 'la página trae el orden del panel'); return fn; };
function openWallPanel(data, abiertos) {
  const html = page(data);
  const fn = (html.match(/function abrirTablero\(\)\{[\s\S]*?\n\n/) || [])[0];
  assert.ok(fn, 'la página trae el panel');
  const { document } = tinyDom();
  const panel = document.createElement('aside');
  panel.classList = { add() {}, remove() {} };
  if (abiertos) panel.abiertos = new Set(abiertos);
  new Function('document', 'panel', 'T', 'KCOL', 'HALF', 'stampOf', 'desks', 'pintarTag', `let sel=null;${wallOrderCode(html)}${fn};abrirTablero();`)(document, panel, { kanban: () => data.kanban, meta: () => data.meta }, {}, '#f00', () => 'sello', [], () => {});
  return panel;
}
// Lo que dibuja el panel de la pared: cada texto, en orden.
function wallTexts(data) {
  const html = page(data);
  const fn = (html.match(/function drawPanel\(\)\{[\s\S]*?texPanel\.needsUpdate=true;\}/) || [])[0];
  assert.ok(fn, 'la página trae el dibujo de la pared');
  const said = [];
  const g = new Proxy({}, { get: (_, k) => (k === 'fillText' ? (t) => said.push(String(t)) : () => {}), set: () => true });
  new Function('texPanel', 'T', 'KCOL', 'HALF', 'FONT', 'stampOf', `${wallOrderCode(html)}${fn};drawPanel();`)({ userData: { g } }, { kanban: () => data.kanban, meta: () => data.meta }, {}, '#f00', 'x', () => 'sello');
  return said;
}
// Datos con de todo: sesiones, pedidos reales, una fila del tablero y lo que quedó en una carpeta.
const mixedOffice = () => buildOffice({
  wip: wip([{ session: 'Ana', sid: 'a', status: 'busy', extra: { kind: 'note', text: 'el arreglo de Ana' } }], { halfwayItems: [
    { kind: 'adhoc', text: 'lo de Rita', sid: 'r', left: [{ folder: '/x/th-r', branch: 'fix/r', changes: 2, ahead: 0 }] },
    { kind: 'note', text: 'en main; pendientes', sid: 'n', left: [{ folder: '/x/th-n', branch: 'fix/n', changes: 9, ahead: 9 }] },
  ] }),
  board: buildBoard({ pendientes: [{ titulo: 'Sin nadie', estado: 'curso', quien: 'Lola' }, { titulo: 'Hecho', estado: 'hecho' }] }),
  openPrs: [
    { repoName: 'pub', number: 909, mark: '#', branch: 'fix/a', title: 'en la cola', inQueue: true, waiting: true },
    { repoName: 'priv', number: 6101, mark: '!', branch: 'fix/b', title: 'con auto', inQueue: false, waiting: true },
    { repoName: 'pub', number: 721, mark: '#', branch: 'fix/c', title: 'abierto y quieto', inQueue: false, waiting: false },
  ],
  openPrsNote: 'Cuenta los pedidos…',
  nowMs: NOW,
}).data;

// Un document mínimo: nodos con hijos y texto, sin ningún intérprete de HTML. Si el formato usara innerHTML, se notaría acá.
function fakeDom() {
  const node = (tagName) => ({ tagName, children: [], textContent: '', append(...k) { this.children.push(...k); } });
  return { createElement: (t) => node(t.toUpperCase()), createTextNode: (t) => ({ tagName: '#text', children: [], textContent: t }) };
}
const shape = (n) => (n.tagName === '#text' ? n.textContent : [n.tagName.toLowerCase(), ...(n.children.length ? n.children.map(shape) : [n.textContent])]);

// ── Cómo trabaja sale de su marca, no de la nota ─────────────────────────────────────────────────────────────────

// ── Las notas de espera que nombran un pedido ────────────────────────────────────────────────────────────────────

// A folder whose `origin` is that platform's: the question goes through the connector of the repo, whichever it is.
function originRepo(m, name, url) {
  const dir = path.join(m.root, name);
  fs.mkdirSync(dir);
  execFileSync('git', ['-c', 'maintenance.auto=false', '-C', dir, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url], { stdio: 'ignore' });
  return dir;
}
const PLATFORMS = [
  ['GitHub', '#', 'https://github.com/acme/repo.git', '!'],
  ['Azure DevOps', '!', 'https://dev.azure.com/acme/proy/_git/repo', '#'],
];
const waitingWip = (cwd, waitingFor, waitingSince = 1000) => wip([{ session: 'Paz', sid: 'p', extra: { kind: 'note', text: 'x', cwd, waitingFor, waitingSince } }]);
const readerOf = (answers, asked = []) => async (qs) => qs.map((q) => { asked.push(q); return answers[q.numero] ? { pr: answers[q.numero] } : { error: 'no se pudo' }; });
const NO_OPEN = { measured: true, prs: [] };

// ── Los tokens de la tarjeta ─────────────────────────────────────────────────────────────────────────────────────

// ── Los cuadros, las paradas, lo trabado y las tablas ────────────────────────────────────────────────────────────

// ── Etiquetas, avioncito, coordinadora y orden ───────────────────────────────────────────────────────────────────

// A toy Codex base: one thread per entry, `{ id, source, thread_source }`. The real base has many more columns.
function toyCodexBase(m, threads) {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(m.home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, name TEXT, source TEXT, thread_source TEXT)');
  const add = db.prepare('INSERT INTO threads (id, source, thread_source) VALUES (?, ?, ?)');
  for (const t of threads) add.run(t.id, t.source, t.thread_source || 'user');
  db.close();
  return dir;
}
const SESSION_STATE = require(path.join(__dirname, '..', '..', 'lib', 'session-state.js'));
const codexFile = (m, sid, patch = {}, now = NOW) => SESSION_STATE.update(m.state, sid, { sentence: SESSION_STATE.NO_PIPELINE, busy: false, ...patch }, { create: true, tool: 'codex', now });

// The per-session conversation code of the page, on a small stand-in for the DOM: only what those functions touch.
function perSessionCode() {
  class Fake {
    constructor(cls, text) { this.className = cls || ''; this.textContent = text || ''; this.children = []; this.attrs = {}; }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    replaceWith(...kids) { const at = this.parent.children.indexOf(this); for (const k of kids) k.parent = this.parent; this.parent.children.splice(at, 1, ...kids); }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    focus() { Fake.focused = this; }
  }
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const code = html.slice(html.indexOf('// Cuándo fue el último mensaje con una sesión'), html.indexOf('function pintarCharla('));
  const stubs = {
    el: (_tag, cls, text) => new Fake(cls, text),
    msg: (quien, at, texto, mio) => Object.assign(new Fake('msg'), { quien, texto, mio }),
    listaCharla: (filas, vacio) => { const box = new Fake(filas.length ? 'chat' : 'm', filas.length ? '' : vacio); box.append(...filas); return box; },
    DAYS: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  };
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(stubs), `${code}; return { charlaPorSesion, horaDeSesion };`)(...Object.values(stubs));
}
const toySessions = (n) => Array.from({ length: n }, (_, i) => ({ sesion: `S${i}`, at: Date.now() - i * 60000, mensajes: [{ de: `S${i}`, texto: `de S${i}`, at: Date.now() }, { de: 'Coordinadora', texto: 'dale', at: Date.now() }] }));

const WALL_ORDER = ['Tu firma', 'En curso', 'Esperan entrar', 'A medio camino', 'Sin sesión', 'Terminados'];
const toyCards = (n) => Array.from({ length: n }, (_, i) => ({ titulo: `Trabajo ${i}`, quien: 'Tero' }));
const toyKanban = (over = {}) => ({ columnas: [['sinEmpezar', 'Sin sesión'], ['curso', 'En curso'], ['firma', 'Tu firma'], ['entrando', 'Esperan entrar'], ['hechos', 'Terminados']].map(([id, nombre]) => ({ id, nombre, tarjetas: toyCards(over[id] || 0) })), medioCamino: toyCards(over.medio || 0).map((c) => ({ titulo: c.titulo, accion: 'Abrí un pedido' })) });

// ── Hablarle a una sesión desde la oficina ─────────────────────────────────────────────────────────────────────────

const { markRecipients, conversationOf, createEnvelopes: createEnvelopes8183 } = require(OFFICE);
const om8183 = require(path.join(__dirname, '..', '..', 'lib', 'office-messages.js'));
const { stateDir: stateDir8183 } = require(path.join(__dirname, '..', '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

// ---------- lo de «Tu firma» le llega a la coordinadora: de qué sesión y de qué fuente es cada tarjeta (8.219) ----------

const { ownerWaitsOf } = require(OFFICE);
// una tarjeta de «Tu firma» como las deja la oficina: la sesión y la fuente no viajan en el JSON
const firmaCard = (props, sid, origen) => Object.defineProperties({ ...props }, { sid: { value: sid }, origen: { value: origen } });
const firmaData = (tarjetas) => ({ kanban: { columnas: [{ id: 'firma', nombre: 'Tu firma', tarjetas }] } });

function firmaOffice() {
  return buildOffice({
    wip: wip([{ session: 'Pepa', sid: 's-pepa', status: 'idle', work: '9.3 · Tres', extra: { kind: 'pipeline', title: 'Tres', storyId: '9.3', current: 'approve-plan' } }],
      { halfwayItems: [{ kind: 'run', text: 'Cinco', cleanAfter: null, sid: 's-rosa', name: 'Rosa', storyId: '9.5', awaits: 'plan' }] }),
    signatures: [{ id: 'f1', title: 'la firma de otra', at: NOW, destino: 's-otra', nombre: 'Otra' }, { id: 'f2', title: 'la firma de la terminal', at: NOW }],
    board: buildBoard({ pendientes: [{ titulo: 'Firma del tablero', estado: 'firma', quien: 'Rita' }] }),
    nowMs: NOW,
  }).data;
}

// la lista de archivos de una carpeta con su tamaño y su fecha, para ver que nada cambió
function filesOf(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out[path.relative(dir, p)] = `${s.size}:${s.mtimeMs}`; } } };
  walk(dir);
  return out;
}

module.exports = {
  OFFICE,
  PAGE_CODE,
  NOW,
  STEPS,
  byName,
  run,
  MARKER,
  liveSession,
  runMarker,
  BOARD,
  all,
  textOf,
  sessionFile,
  STEP_LIB,
  col,
  titles,
  hm,
  IDS,
  runMarkerFile,
  BEFORE_PLAN,
  CLOSED,
  sessionWith,
  noPrs,
  atIso,
  KANBAN_BOARD,
  hourRun,
  collectAt,
  ddmm,
  ymd,
  parked,
  oldHours,
  localIsoAt,
  KANBAN_FOR_TABLES,
  wallOrderCode,
  mixedOffice,
  shape,
  PLATFORMS,
  waitingWip,
  readerOf,
  NO_OPEN,
  SESSION_STATE,
  codexFile,
  toySessions,
  WALL_ORDER,
  toyCards,
  toyKanban,
  om8183,
  firmaCard,
  firmaData,
  wip,
  pageTimeHelpers,
  toyHome,
  toyMachine,
  storyFile,
  markerAt,
  collectWith,
  tinyDom,
  drawKanban,
  pageClock,
  toyRepo,
  ownerMachine,
  parkMachine,
  openWallPanel,
  wallTexts,
  fakeDom,
  originRepo,
  toyCodexBase,
  perSessionCode,
  firmaOffice,
  filesOf,
  execFileSync,
  buildOffice,
  page,
  importMap,
  MODULES,
  prsNamedIn,
  waitedPrsSaid,
  askWaitingPrs,
  tokensTxt,
  tokensCard,
  buildWip,
  stateDir,
  openFile,
  deskSlots,
  spawnSync,
  wipNow,
  collect,
  buildBoard,
  createEnvelopes,
  buildTables,
  markRecipients,
  conversationOf,
  createEnvelopes8183,
  stateDir8183,
  ownerWaitsOf,
};
