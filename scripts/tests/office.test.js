'use strict';
// office.test.js — the /office page: the work in progress drawn as an office, built from toy /wip results and toy
// state folders. Nothing here reads the real HOME: the command-line tests run with a toy HOME.
// stable-data: every date comes in by argument or by --now.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OFFICE = path.join(__dirname, '..', 'tools', 'office.js');
const { buildOffice, page, importMap, MODULES } = require(OFFICE);

const NOW = Date.parse('2026-10-18T14:00:00.000Z');
const STEPS = [{ id: 'implement', name: 'Implementar', done: true }, { id: 'run-tests', name: 'Correr las pruebas', done: false }];

// A /wip result with one row per entry: `{ session, sid, status, extra, meanwhile }`.
function wip(entries, more = {}) {
  return {
    rows: entries.map((e) => ({ work: e.work || `Story ${e.session}`, state: e.state || 'en curso', end: e.end || '15:00', session: e.session, folder: 'repo-a', ...(e.meanwhile ? { meanwhile: e.meanwhile } : {}) })),
    details: entries.map((e) => ({ sid: e.sid || `sid-${e.session}`, status: e.status || 'busy' })),
    extra: entries.map((e) => e.extra || { kind: 'loose' }),
    free: [],
    halfway: [],
    unreadable: [],
    ...more,
  };
}

const byName = (data, name) => data.agents.find((a) => a.nombre === name);

test('T1 EstadoPorSesion: firma, coordina, espera, prueba, trabajando y libre salen de lo que dice /wip', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'sesion-a', status: 'waiting_for_input', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'sesion-b', sid: 'coord', extra: { kind: 'note' } },
      { session: 'sesion-c', extra: { kind: 'entering' } },
      { session: 'sesion-d', extra: { kind: 'stalled' } },
      { session: 'sesion-e', extra: { kind: 'pipeline', current: 'reviewers', steps: STEPS, progress: 50 } },
      { session: 'sesion-f', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'sesion-g', extra: { kind: 'activity' } },
    ], { free: ['sesion-h'] }),
    coordinatorSid: 'coord',
    nowMs: NOW,
  });
  const states = Object.fromEntries(data.agents.map((a) => [a.nombre, a.estado]));
  assert.deepStrictEqual(states, {
    'sesion-a': 'firma', 'sesion-b': 'coordina', 'sesion-c': 'espera', 'sesion-d': 'espera',
    'sesion-e': 'prueba', 'sesion-f': 'trabajando', 'sesion-g': 'trabajando', 'sesion-h': 'libre',
  });
  assert.deepStrictEqual(byName(data, 'sesion-e').pasos, STEPS);
  assert.strictEqual(byName(data, 'sesion-e').avance, 50);
  assert.strictEqual(data.meta.extra, 0, 'ocho personas, ocho escritorios');
  assert.strictEqual(data.meta.puestos.length, 8);
});

test('T2 CoordinadoraQuieta_NoEstaLibre: la coordinadora sin fila de trabajo coordina', () => {
  const { data } = buildOffice({ wip: wip([], { free: ['sesion-a', 'coordinadora'] }), coordinatorName: 'coordinadora', nowMs: NOW });
  assert.strictEqual(byName(data, 'coordinadora').estado, 'coordina');
  assert.strictEqual(byName(data, 'sesion-a').estado, 'libre');
  assert.deepStrictEqual(data.items, [], 'la coordinadora quieta no es un pendiente');
});

test('T3 MientrasTanto: la segunda burbuja y la fila de la tabla dicen lo que hace mientras tanto', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'sesion-a', meanwhile: 'arreglo rápido «arregla la guía»', extra: { kind: 'stalled', meanwhile: 'arregla la guía' } }]), nowMs: NOW });
  assert.strictEqual(byName(data, 'sesion-a').mientras, 'arregla la guía');
  assert.match(data.rows[0].state, /Mientras tanto: arregla la guía\./);
});

test('T10 EnLlano: sin números de historia ni de pedidos, y una oración por sesión', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'sesion-a', work: '8.85 · El núcleo dice qué hace', state: 'Pedidos sin encolar · repo-a !6008 (borrador) (choca con main) · repo-b #842', meanwhile: '8.85-E: portables como la CI', extra: { kind: 'stalled', meanwhile: '8.85-E: portables como la CI' } },
      { session: 'sesion-b', work: '4.7 · El minado', extra: { kind: 'pipeline', current: 'run-tests', steps: STEPS } },
      { session: 'sesion-c', work: 'no se ve qué hace', state: 'Trabajando sin pipeline · no tocó archivos en las últimas 3 h', extra: { kind: 'activity' } },
    ]),
    signatures: [{ id: 'f1', title: 'saltar el pase de 5.2 en el pedido #900' }],
    nowMs: NOW,
  });
  const a = byName(data, 'sesion-a');
  assert.strictEqual(a.titulo, 'El núcleo dice qué hace');
  assert.strictEqual(a.mientras, 'portables como la CI');
  assert.strictEqual(a.haciendo, 'Terminó, pero sus pedidos no están en la cola y su pedido choca con main.');
  assert.strictEqual(a.termina, 'sin hora estimada');
  assert.strictEqual(byName(data, 'sesion-b').haciendo, 'Va por el paso «Correr las pruebas».');
  assert.strictEqual(byName(data, 'sesion-c').titulo, null);
  assert.strictEqual(byName(data, 'sesion-c').haciendo, 'Trabaja sin pipeline.');
  assert.deepStrictEqual(data.meta.teToca, ['Firmar: saltar el pase de 5.2 en el pedido']);
  const seen = JSON.stringify({ agents: data.agents.map(({ pasos, ...rest }) => rest), items: data.items, rows: data.rows, meta: data.meta });
  assert.doesNotMatch(seen, /[!#]\d+|\b\d+\.\d+\s*[·:]|8\.85-E|\d+\.\d+ ·/);
});

test('T11 ComoElTablero: la nota es la oración, sin hora dice «sin hora estimada», orden fijo y sin resumen', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Zeta', work: 'espero turno para el ba…', meanwhile: 'arreglo rápido «Guía de…»', extra: { kind: 'note', text: 'espero turno para el banco contra la base !6008', meanwhile: 'Guía de coordinación: las lecciones del día' } },
      { session: 'Beto', sid: 'coord', extra: { kind: 'activity' } },
      { session: 'Alfa', extra: { kind: 'loose', text: 'arreglos rápidos de la oficina' } },
      { session: 'Mona', extra: { kind: 'entering' } },
    ]),
    coordinatorSid: 'coord',
    nowMs: NOW,
  });
  assert.deepStrictEqual(data.agents.map((a) => a.nombre), ['Beto', 'Alfa', 'Mona', 'Zeta'], 'la coordinadora primero; después, por nombre');
  assert.deepStrictEqual(data.agents.map((a) => a.orden), [0, 1, 2, 3]);
  const z = byName(data, 'Zeta');
  assert.strictEqual(z.haciendo, 'espero turno para el banco contra la base');
  assert.strictEqual(z.mientras, 'Guía de coordinación: las lecciones del día', 'el texto entero, sin cortar');
  assert.strictEqual(byName(data, 'Alfa').haciendo, 'arreglos rápidos de la oficina');
  assert.strictEqual(byName(data, 'Mona').termina, 'sin hora estimada');
  assert.strictEqual(byName(data, 'Beto').termina, undefined, 'la coordinadora no termina');
  assert.strictEqual(data.meta.resumen, undefined);
  const html = page(data);
  assert.doesNotMatch(html, /class="side"><\/span>|y mientras tanto: /, 'el mientras tanto va en la etiqueta, como en el tablero');
});

// The page's own time helpers (from DAYS to finTxt), run outside the browser.
function pageTimeHelpers() {
  const html = page({ agents: [], items: [], meta: { teToca: [] }, rows: [], free: [], unreadable: [] });
  const code = html.slice(html.indexOf('const DAYS='), html.indexOf('function renderTop'));
  return new Function(`${code.replace(/^(const (AST|SHIRT|agents)=|let agents|function setData|setData\(DATA\)).*$/gm, '')}; return { finTxt };`)();
}

test('T12 HoraPasada: si la hora de fin de una corrida abierta ya pasó dice el atraso real en rojo; si es vieja, «sin hora estimada»; nunca «en hora»', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Muñe', extra: { kind: 'pipeline', endAt: NOW - 5 * 3600000 } },
      { session: 'Vieja', extra: { kind: 'pipeline', endAt: NOW - 13 * 3600000 } },
      { session: 'Justa', extra: { kind: 'pipeline', endAt: NOW + 10 * 60000 } },
    ]),
    nowMs: NOW,
  });
  const late = byName(data, 'Muñe');
  assert.strictEqual(late.atrasoMin, 300);
  assert.strictEqual(late.atrasada, true);
  const old = byName(data, 'Vieja');
  assert.strictEqual(old.termina, 'sin hora estimada');
  assert.strictEqual(old.pronosticoIso, undefined, 'una hora vieja no se muestra');
  const { finTxt } = pageTimeHelpers();
  assert.deepStrictEqual(finTxt(late), { hora: finTxt(late).hora, dif: '+5 h 00 tarde', cls: 'late' });
  assert.deepStrictEqual(finTxt(old), { hora: 'sin hora estimada', dif: '', cls: '' });
  assert.strictEqual(finTxt(byName(data, 'Justa')).dif, 'en hora', 'la que todavía no llegó a su hora sigue en hora');
});

test('T4 HoraPrometida: la primera hora vista se guarda y la de ahora se compara contra ella', () => {
  const first = NOW + 30 * 60000;
  const later = NOW + 90 * 60000;
  const one = buildOffice({ wip: wip([{ session: 'sesion-a', sid: 's1', extra: { kind: 'pipeline', storyId: '5.1', endAt: first } }]), nowMs: NOW });
  assert.deepStrictEqual(Object.keys(one.promises), ['s1|5.1']);
  const two = buildOffice({ wip: wip([{ session: 'sesion-a', sid: 's1', extra: { kind: 'pipeline', storyId: '5.1', endAt: later, late: true } }]), promises: one.promises, nowMs: NOW + 60000 });
  const a = byName(two.data, 'sesion-a');
  assert.notStrictEqual(a.estimadaIso, a.pronosticoIso, 'la hora nueva no pisa la prometida');
  assert.strictEqual(Date.parse(a.pronosticoIso) - Date.parse(a.estimadaIso), 60 * 60000);
  assert.strictEqual(a.atrasada, true);
  assert.strictEqual(two.promises['s1|5.1'].at, first);
  assert.strictEqual(two.promises['s1|5.1'].seen, NOW + 60000);
});

test('T5 HoraPrometida_SeOlvidaALas24h: una promesa que no se vio en un día no se guarda', () => {
  const old = { 'viejo|1.1': { at: NOW - 3 * 3600000, seen: NOW - 25 * 3600000 }, 'roto|1.2': { at: 'x', seen: NOW } };
  const { promises } = buildOffice({ wip: wip([]), promises: old, nowMs: NOW });
  assert.deepStrictEqual(promises, {});
});

test('T6 PanelYTeToca: el panel cuenta el trabajo, las firmas y lo que quedó a medio camino; «te toca» sólo pide firmar', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'sesion-a', work: 'Story 5.1', extra: { kind: 'stalled' } },
      { session: 'sesion-b', extra: { kind: 'entering' } },
      { session: 'sesion-c', status: 'permission', extra: { kind: 'loose' } },
      { session: 'sesion-d', extra: { kind: 'pipeline', current: 'implement' } },
    ], { halfwayItems: [{ kind: 'adhoc', text: 'ad hoc de la sesión zeta', cleanAfter: null }] }),
    signatures: [{ id: 'f1', title: 'saltar el pase de 5.2', at: NOW }, { id: 'f2' }],
    nowMs: NOW,
  });
  assert.deepStrictEqual(data.items.map((i) => [i.quien, i.estado]), [
    ['sesion-a', 'riesgo'], ['sesion-b', 'espera'], ['sesion-c', 'firma'], ['sesion-d', 'curso'], ['vos', 'firma'], ['—', 'riesgo'],
  ]);
  assert.strictEqual(data.items[5].titulo, 'ad hoc de la sesión zeta', 'sin el comando de limpieza');
  assert.strictEqual(data.items[5].accion, 'Ya se puede limpiar: pedíselo a la coordinadora');
  assert.deepStrictEqual(data.meta.teToca, ['Firmar: saltar el pase de 5.2'], 'encolar lo hace la sesión, no el dueño');
});

test('T7 Pagina_SinNadaDeAfuera: la librería va adentro, sin importaciones relativas ni direcciones de internet', () => {
  const map = JSON.parse(importMap()).imports;
  assert.deepStrictEqual(Object.keys(map).sort(), Object.keys(MODULES).sort());
  for (const [key, url] of Object.entries(map)) {
    assert.match(url, /^data:text\/javascript;base64,/, key);
    const src = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
    assert.doesNotMatch(src, /(from|import)\s*['"]\.{1,2}\//, `${key} conserva una importación relativa`);
    for (const m of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) assert.ok(m[1] in map, `${key} importa ${m[1]}, que no está en el mapa`);
  }
  const html = page({ agents: [], items: [], meta: { teToca: [] }, rows: [], free: [], unreadable: [] });
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html, /__OFFICE_(IMPORTMAP|DATA)__/);
});

test('T8 Pagina_DatosNoCierranElGuion: un «<» de los datos no puede cerrar la etiqueta del guion', () => {
  const html = page({ agents: [{ nombre: '</script><b>x', estado: 'libre' }], items: [], meta: { teToca: [] }, rows: [], free: [], unreadable: [] });
  assert.doesNotMatch(html, /<\/script><b>x/);
  assert.match(html, /\\u003c\/script>\\u003cb>x/);
});

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

const run = (home, args) => execFileSync('node', [OFFICE, ...args], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'pipe' }).toString();

test('T9 Comando: --json imprime los datos, sin --json escribe la página, y sin carpeta de estado sale 2', () => {
  const { home } = toyHome();
  const data = JSON.parse(run(home, ['--json', '--now', new Date(NOW).toISOString()]));
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.estado]), [['sesion-a', 'libre']]);
  const out = path.join(home, 'oficina.html');
  assert.match(run(home, ['--out', out, '--now', new Date(NOW).toISOString()]), /La oficina está en/);
  assert.match(fs.readFileSync(out, 'utf8'), /<title>Oficina del arnés<\/title>/);
  let code = 0;
  try { run(fs.mkdtempSync(path.join(os.tmpdir(), 'office-vacia-')), ['--json']); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  code = 0;
  try { run(home, ['--out']); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2, '--out sin valor');
});

// ---------- los datos de la tarjeta: la hora de fin, el título, los textos en llano y lo que quedó a medio camino ----------

const { buildWip } = require(path.join(__dirname, '..', 'tools', 'work-in-progress.js'));
const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const MARKER = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');

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

test('T37 LooseAndNote_DeclaredEnd_Shown: el arreglo rápido y la nota dicen su hora de fin si la declaran', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-until-'));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'arreglos rápidos de la oficina', declaredAt: new Date().toISOString() }));
  assert.strictEqual(runMarker(home, 's2', ['adhoc', 'until', '25:99']), 2, 'la hora se valida primero, aunque no haya carril');
  assert.strictEqual(runMarker(home, 's2', ['adhoc', 'until', '19:30']), 1, 'sin carril no hay dónde anotarla');
  assert.ok(!fs.existsSync(path.join(sdir, 'adhoc', 's2.json')), 'sin carril no se crea nada');
  assert.strictEqual(runMarker(home, 's1', ['adhoc', 'until', '19:30']), 0);
  assert.strictEqual(runMarker(home, 's3', ['doing', 'espero turno para el banco de controles', '--until', '19:30']), 0);
  const until = JSON.parse(fs.readFileSync(path.join(sdir, 'adhoc', 's1.json'), 'utf8')).until;
  const endAt = JSON.parse(fs.readFileSync(path.join(sdir, 'doing', 's3.json'), 'utf8')).endAt;
  for (const iso of [until, endAt]) {
    const d = new Date(iso);
    assert.deepStrictEqual([d.getHours(), d.getMinutes()], [19, 30]);
    // hoy, mañana si quedaría más de 12 h atrás, ayer si quedaría más de 18 h adelante
    assert.ok(Date.parse(iso) > Date.now() - 12 * 3600000 && Date.parse(iso) <= Date.now() + 18 * 3600000, `${iso} cae entre 12 h atrás y 18 h adelante`);
  }
  // la de más de 12 h atrás pasa a mañana: una hora 13 h antes de ahora queda en el futuro
  const back = new Date(Date.now() - 13 * 3600000);
  const hhBack = `${String(back.getHours()).padStart(2, '0')}:${String(back.getMinutes()).padStart(2, '0')}`;
  fs.writeFileSync(path.join(sdir, 'adhoc', 's4.json'), JSON.stringify({ reason: 'otro arreglo', declaredAt: new Date().toISOString() }));
  assert.strictEqual(runMarker(home, 's4', ['adhoc', 'until', hhBack]), 0);
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(path.join(sdir, 'adhoc', 's4.json'), 'utf8')).until) > Date.now(), `${hhBack} pasa a mañana`);
  fs.rmSync(path.join(sdir, 'adhoc', 's4.json'));
  // una hora que pasó hace menos de 12 h se anota igual y avisa (salvo justo después de medianoche, donde sería de ayer)
  const ago = new Date(Date.now() - 2 * 3600000);
  if (ago.getDate() === new Date().getDate()) {
    const hhAgo = `${String(ago.getHours()).padStart(2, '0')}:${String(ago.getMinutes()).padStart(2, '0')}`;
    const r = require('child_process').spawnSync('node', [MARKER, 'doing', 'una nota con la hora ya pasada', '--until', hhAgo], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: 's6' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'se anota igual');
    assert.match(r.stderr, /ya pasó/, 'y avisa');
    fs.rmSync(path.join(sdir, 'doing', 's6.json'));
  }
  // con una corrida abierta, el carril anota la hora pero la oficina usa la de la corrida
  fs.mkdirSync(path.join(sdir, 'active'), { recursive: true });
  const runStory = path.join(home, 'story-7.7.md');
  fs.writeFileSync(runStory, '---\nstory: "7.7"\ntitle: "Una historia con corrida"\n---\n');
  fs.writeFileSync(path.join(sdir, 'active', 's5.json'), JSON.stringify({ sessionId: 's5', storyId: '7.7', storyPath: runStory, stepsCompleted: ['start'], stepsPending: ['validate-story'] }));
  fs.writeFileSync(path.join(sdir, 'adhoc', 's5.json'), JSON.stringify({ reason: 'arreglo con corrida', declaredAt: new Date().toISOString() }));
  assert.strictEqual(runMarker(home, 's5', ['adhoc', 'until', '19:30']), 0);
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 's5.json'), JSON.stringify({ pid: process.pid, sessionId: 's5', name: 'Muñe', status: 'busy', statusUpdatedAt: Date.now() }));
  for (const [sid, name] of [['s1', 'Alfa'], ['s3', 'Zeta']]) fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: Date.now() }));
  const w = buildWip({ stateDir: sdir, sessionsDir: sessions, now: new Date().toISOString() });
  const { data } = buildOffice({ wip: w, nowMs: Date.now() });
  for (const name of ['Alfa', 'Zeta']) {
    const a = byName(data, name);
    assert.strictEqual(a.pronosticoIso.slice(11), '19:30', name);
    assert.strictEqual(a.termina, undefined, `${name} tiene hora`);
    assert.match(w.rows.find((r) => r.session === name).end, /19:30/, `/wip la muestra en «Fin estimado» (${name})`);
  }
  // una hora guardada ilegible se dice, no pasa por «sin estimación»
  fs.writeFileSync(path.join(sdir, 'adhoc', 's7.json'), JSON.stringify({ reason: 'arreglo con la hora rota', declaredAt: new Date().toISOString(), until: 'mañana' }));
  fs.writeFileSync(path.join(sessions, 's7.json'), JSON.stringify({ pid: process.pid, sessionId: 's7', name: 'Rota', status: 'busy', statusUpdatedAt: Date.now() }));
  const w2 = buildWip({ stateDir: sdir, sessionsDir: sessions, now: new Date().toISOString() });
  assert.strictEqual(w2.rows.find((r) => r.session === 'Rota').end, 'hora declarada ilegible');
  const withRun = byName(data, 'Muñe');
  assert.strictEqual(withRun.tipo, 'pipeline', 'la sesión con corrida es su corrida');
  assert.ok(!String(withRun.pronosticoIso || '').endsWith('19:30'), 'la hora del carril no pisa la de la corrida');
});

test('T38 PlainSentence_NoFilesBranchesFolders: la oración, el título y el «mientras tanto» van sin archivos, ramas ni carpetas', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Muñe', work: 'stuck-pr-notice mide de verdad en office.js', extra: { kind: 'loose', text: 'stuck-pr-notice mide de verdad en office.js por qué se cae cada pedido' } },
      { session: 'Beto', work: 'la cola de fix/arreglo-rapido', extra: { kind: 'note', text: 'pruebas de la cola en fix/arreglo-rapido-delegado-chico' } },
      { session: 'Gena', work: 'th-adhoc · fix/arreglo', extra: { kind: 'activity' } },
      { session: 'Lola', work: '4.7 · El minado', meanwhile: 'th-adhoc · fix/arreglo', extra: { kind: 'pipeline', current: 'implement', steps: STEPS } },
    ]),
    nowMs: NOW,
  });
  const seen = JSON.stringify({ agents: data.agents.map(({ pasos, ...rest }) => rest), rows: data.rows, items: data.items });
  for (const bad of ['stuck-pr-notice', 'office.js', 'fix/', 'th-adhoc', 'arreglo-rapido']) assert.ok(!seen.includes(bad), `sale «${bad}»`);
  assert.ok(byName(data, 'Muñe').haciendo.length > 8, 'queda una oración');
  assert.strictEqual(byName(data, 'Gena').titulo, null, 'sin carril ni nota no hay título');
  assert.strictEqual(byName(data, 'Lola').mientras, undefined, 'el «mientras tanto» no sale del último archivo tocado');
});

test('T39 ClosedWaiting_NotLate: esperar la cola no es atraso; una corrida abierta pasada de hora sí', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Angelito', extra: { kind: 'entering', endAt: NOW - 5 * 3600000 } },
      { session: 'Pronto', extra: { kind: 'entering', endAt: NOW + 20 * 60000 } },
      { session: 'Tarde', extra: { kind: 'pipeline', endAt: NOW - 60 * 60000 } },
      { session: 'Trabada', extra: { kind: 'stalled', endAt: NOW - 60 * 60000 } },
    ]),
    nowMs: NOW,
  });
  assert.notStrictEqual(byName(data, 'Trabada').termina, 'esperando entrar', 'los pedidos sin encolar no esperan entrar (AC 35)');
  const a = byName(data, 'Angelito');
  assert.strictEqual(a.termina, 'esperando entrar');
  assert.deepStrictEqual(a.fin, { hora: 'esperando entrar', dif: '', cls: '' });
  for (const k of ['pronosticoIso', 'atrasoMin', 'atrasada']) assert.strictEqual(a[k], undefined, k);
  assert.ok(byName(data, 'Pronto').pronosticoIso);
  assert.strictEqual(byName(data, 'Tarde').atrasoMin, 60);
  assert.strictEqual(byName(data, 'Tarde').fin.cls, 'late');
});

test('T40 Halfway_PlainWithAction: «a medio camino» en llano y con qué hacer; /wip sigue igual', () => {
  const m = toyMachine();
  const now = NOW;
  fs.writeFileSync(path.join(m.state, 'adhoc', 'dead-1.json'), JSON.stringify({ reason: 'arreglo del aviso del arranque', lastTouch: new Date(now - 2 * 3600000).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'adhoc', 'dead-2.json'), JSON.stringify({ reason: 'ajuste de la guía de coordinación', lastTouch: new Date(now - 30 * 3600000).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'doing', 'dead-3.json'), JSON.stringify({ text: 'medición del disco del sitio', at: new Date(now - 30 * 3600000).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'active', 'dead-4.json'), JSON.stringify({ sessionId: 'dead-4', storyId: '9.9', storyPath: storyFile(m, '9.9', 'El tablero dice la verdad'), stepsCompleted: ['start'], stepsPending: ['validate-story'], lastTouch: new Date(now - 3600000).toISOString() }));
  const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root });
  const { data } = buildOffice({ wip: w, nowMs: now });
  const rows = data.items.filter((i) => i.estado === 'riesgo');
  assert.strictEqual(rows.length, 4);
  const seen = JSON.stringify(rows);
  for (const bad of ['ad-hoc', 'dead-', 'limpiar: node', 'clear-session', 'marker.js', '9.9']) assert.ok(!seen.includes(bad), `sale «${bad}»`);
  const by = (t) => rows.find((r) => r.titulo.includes(t));
  const hh = (ms) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`;
  assert.strictEqual(by('aviso del arranque').accion, `Se puede limpiar después de las ${hh(now - 2 * 3600000 + 24 * 3600000)}`);
  assert.strictEqual(by('guía de coordinación').accion, 'Ya se puede limpiar: pedíselo a la coordinadora');
  assert.strictEqual(by('disco del sitio').accion, 'Ya se puede limpiar: pedíselo a la coordinadora');
  assert.strictEqual(by('El tablero dice la verdad').accion, 'Ya se puede limpiar: pedíselo a la coordinadora');
  const unknown = buildOffice({ wip: wip([], { halfwayItems: [{ kind: 'adhoc', text: 'arreglo de fecha rota', cleanAfter: 'unknown' }] }), nowMs: now }).data.items[0];
  assert.strictEqual(unknown.accion, 'No se sabe desde cuándo se puede limpiar: preguntale a la coordinadora', 'una fecha ilegible no dice que ya se puede');
  assert.match(w.text, /ad-hoc «arreglo del aviso del arranque»/, 'la tabla de /wip no cambia');
  assert.match(page(data), /r\.accion/, 'la página muestra la acción');
});

test('T41 SameFin_CardTagDetailPanelTable: una sola hora y un solo estado por sesión, en todas las partes', () => {
  const promises = { 'sid-Temprana|5.4': { at: NOW + 60 * 60000, seen: NOW - 60000 }, 'sid-Prometida|5.2': { at: NOW + 30 * 60000, seen: NOW - 60000 }, 'sid-Pasada|5.1': { at: NOW - 5 * 3600000, seen: NOW - 60000 } };
  const { data } = buildOffice({
    wip: wip([
      { session: 'Pasada', extra: { kind: 'pipeline', storyId: '5.1', endAt: NOW - 5 * 3600000, late: true } },
      { session: 'Prometida', extra: { kind: 'pipeline', storyId: '5.2', endAt: NOW + 60 * 60000 } },
      { session: 'Justa', extra: { kind: 'pipeline', storyId: '5.3', endAt: NOW + 10 * 60000, late: true } },
      { session: 'Suelta', extra: { kind: 'loose', text: 'arreglos rápidos de la oficina' } },
      { session: 'Temprana', extra: { kind: 'pipeline', storyId: '5.4', endAt: NOW + 30 * 60000 } },
    ]),
    signatures: [{ id: 'f1', title: 'saltar el pase', at: NOW }],
    promises,
    nowMs: NOW,
  });
  const { finTxt } = pageTimeHelpers();
  const expect = { Pasada: ['+5 h 00 tarde', 'late'], Prometida: ['+30 min tarde', 'late'], Justa: ['en hora', 'ontime'], Suelta: ['', ''], Temprana: ['30 min antes', 'early'] };
  for (const [name, [dif, cls]] of Object.entries(expect)) {
    const a = byName(data, name);
    assert.ok(a.fin, `${name} trae su fin`);
    assert.deepStrictEqual([a.fin.dif, a.fin.cls], [dif, cls], name);
    assert.deepStrictEqual(finTxt(a), a.fin, `la etiqueta, la tarjeta y el detalle de ${name} usan el mismo fin`);
    assert.deepStrictEqual(data.items.find((i) => i.quien === name).fin, a.fin, `el panel de ${name} dice lo mismo`);
    assert.strictEqual(data.rows.find((r) => r.session === name).end, a.fin.hora + (a.fin.dif ? ` · ${a.fin.dif}` : ''), `la tabla de ${name} dice lo mismo`);
  }
  assert.strictEqual(byName(data, 'Suelta').fin.hora, 'sin hora estimada');
  assert.deepStrictEqual(data.items.find((i) => i.quien === 'vos').fin.dif, '', 'la firma, su hora sin diferencia');
  const html = page(data);
  assert.doesNotMatch(html, /\bdif\(|difTxt\(/, 'la página no calcula horas');
});

test('T42 Card_CurrentBatch_FullTitle: la tarjeta dice la tanda en curso, con el título entero', () => {
  const m = toyMachine();
  const long = 'La oficina de /office se actualiza sola por eventos, con el pre-flight de Claude y de Codex';
  const withBatch = storyFile(m, '9.1', long, 'pipelines:\n  - name: B0-datos\n    title: "Los datos de la tarjeta"\n    status: in-progress\n  - name: B-eventos\n    title: "La oficina se actualiza sola"\n    status: pending\n');
  const noneRunning = storyFile(m, '9.2', 'Una historia con tandas sin ninguna en curso', 'pipelines:\n  - name: A-uno\n    title: "La primera"\n    status: pending\n');
  const plainStory = storyFile(m, '9.3', long);
  const pipe = { stepsCompleted: ['start'], stepsPending: ['validate-story', 'plan'] };
  for (const [sid, id, p, name] of [['s1', '9.1', withBatch, 'Alfa'], ['s2', '9.2', noneRunning, 'Beto'], ['s3', '9.3', plainStory, 'Cata']]) {
    fs.writeFileSync(path.join(m.state, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: id, storyPath: p, ...pipe }));
    liveSession(m, sid, name);
  }
  const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root });
  const { data } = buildOffice({ wip: w, nowMs: NOW });
  assert.strictEqual(byName(data, 'Alfa').titulo, 'Los datos de la tarjeta');
  assert.strictEqual(byName(data, 'Alfa').historia, long);
  assert.strictEqual(byName(data, 'Beto').titulo, 'Una historia con tandas sin ninguna en curso');
  assert.strictEqual(byName(data, 'Beto').historia, undefined);
  assert.strictEqual(byName(data, 'Cata').titulo, long, 'entero, sin cortar');
  for (const a of data.agents) assert.ok(!String(a.titulo || '').endsWith('…'), a.nombre);
  assert.match(page(data), /De la historia/);
});

// Los bordes de la hora prometida, del filtro de nombres y del bloque de tandas.
test('T44 PromisePerJob: un arreglo o una nota nueva de la misma sesión no hereda la hora prometida de la anterior', () => {
  const first = buildOffice({ wip: wip([{ session: 'Uno', extra: { kind: 'loose', text: 'revisar los avisos de la mañana', endAt: NOW + 3600000 } }]), nowMs: NOW });
  assert.strictEqual(byName(first.data, 'Uno').fin.cls, 'ontime');
  const later = NOW + 2 * 3600000;
  const { data } = buildOffice({ wip: wip([{ session: 'Uno', extra: { kind: 'note', text: 'medir el banco de controles', endAt: later + 3 * 3600000 } }]), promises: first.promises, nowMs: later });
  assert.deepStrictEqual([byName(data, 'Uno').fin.dif, byName(data, 'Uno').fin.cls], ['en hora', 'ontime'], 'un trabajo nuevo empieza en hora');
});

test('T45 OpenRunPastHour_NeverOnTime: una corrida abierta pasada de hora sale tarde aunque la hora prometida no haya llegado', () => {
  const promises = { 'sid-Corre|6.1': { at: NOW + 3600000, seen: NOW - 60000 } };
  const { data } = buildOffice({ wip: wip([{ session: 'Corre', extra: { kind: 'pipeline', storyId: '6.1', endAt: NOW - 30 * 60000 } }]), promises, nowMs: NOW });
  const a = byName(data, 'Corre');
  assert.strictEqual(a.fin.cls, 'late');
  assert.ok(a.atrasoMin >= 30, `atraso ${a.atrasoMin}`);
});

test('T46 WaitingAfter12h_StillWaiting: lo que espera entrar sigue «esperando entrar» después de 12 h', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Lenta', extra: { kind: 'entering', endAt: NOW - 14 * 3600000 } }]), nowMs: NOW });
  assert.strictEqual(byName(data, 'Lenta').termina, 'esperando entrar');
});

test('T47 Plain_FilesGoneSpanishStays: se van los archivos de varios puntos, los ocultos y en mayúsculas; el castellano queda', () => {
  const said = (text) => byName(buildOffice({ wip: wip([{ session: 'P', extra: { kind: 'note', text } }]), nowMs: NOW }).data, 'P').haciendo;
  for (const [text, gone] of [
    ['corro las pruebas de office.test.js', 'office.test.js'],
    ['ajusto el archivo .gitignore', '.gitignore'],
    ['reviso README.MD', 'README.MD'],
    ['subo el paquete en work-in-progress', 'work-in-progress'],
    ['ordeno el carril dead-5', 'dead-5'],
  ]) {
    const s = said(text);
    assert.ok(!s.includes(gone) && !/\.(js|md)\b/i.test(s), `«${text}» → «${s}»`);
  }
  for (const text of ['reviso las páginas 10-12 del informe', 'un ajuste teórico-práctico con Node.js', 'el usuario y/o la coordinadora', 'un arreglo ad-hoc']) {
    assert.strictEqual(said(text), text, 'el castellano no se corta');
  }
});

test('T48 Batch_ReadLikeTheHarness: la tanda en curso se lee como la lee el resto del arnés', () => {
  const m = toyMachine();
  const variants = [
    ['8.1', 'pipelines:\n  - name: A\n    title: "La primera"\n    status: done\n\n  - name: B\n    title: "Con línea en blanco"\n    status: in-progress\n', 'Con línea en blanco'],
    ['8.2', 'pipelines:\n  - name: B\n    title: Con comentario\n    status: in-progress   # la tanda de hoy\n', 'Con comentario'],
    ['8.3', 'pipelines:\n- name: B\n  title: "Sin sangría"\n  status: in-progress\n', 'Sin sangría'],
    ['8.4', 'pipelines:\n  B-mapa:\n    title: "En forma de mapa"\n    status: in-progress\n', 'En forma de mapa'],
  ];
  variants.forEach(([id, block], i) => {
    const sid = `v${i}`;
    fs.writeFileSync(path.join(m.state, 'active', `${sid}.json`), JSON.stringify({ sessionId: sid, storyId: id, storyPath: storyFile(m, id, `Historia ${id}`, block), stepsCompleted: ['start'], stepsPending: ['validate-story'] }));
    liveSession(m, sid, `S${i}`);
  });
  const { data } = buildOffice({ wip: buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root }), nowMs: NOW });
  variants.forEach(([id, , title], i) => assert.strictEqual(byName(data, `S${i}`).titulo, title, id));
});

test('T49 Halfway_RunTitleWhole: una corrida a medio camino dice el título de su historia entero', () => {
  const title = 'El pre-flight de /office y de work-in-progress';
  const item = buildOffice({ wip: wip([], { halfwayItems: [{ kind: 'run', text: title, cleanAfter: null }] }), nowMs: NOW }).data.items[0];
  assert.strictEqual(item.titulo, title);
});

// Un `node` con la hora fija, para probar el cambio de día de una hora declarada.
function markerAt(home, sid, localMs, args) {
  const pre = path.join(home, 'now.js');
  fs.writeFileSync(pre, `const t=${localMs};Date.now=()=>t;`);
  return require('child_process').spawnSync('node', ['-r', pre, MARKER, ...args], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' });
}

test('T50 DeclaredHour_AfterMidnight: pasada la medianoche, una hora de anoche es de ayer y avisa; una de la noche, de hoy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-midnight-'));
  const sdir = stateDir(home);
  const at = (h, mi) => new Date(2026, 9, 31, h, mi).getTime();
  const r = markerAt(home, 'n1', at(0, 10), ['doing', 'cierro lo de anoche', '--until', '23:30']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(Date.parse(JSON.parse(fs.readFileSync(path.join(sdir, 'doing', 'n1.json'), 'utf8')).endAt), new Date(2026, 9, 30, 23, 30).getTime(), 'es la de ayer');
  assert.match(r.stderr, /ya pasó/);
  assert.strictEqual(markerAt(home, 'n2', at(8, 0), ['doing', 'la jornada larga', '--until', '21:00']).status, 0);
  assert.strictEqual(Date.parse(JSON.parse(fs.readFileSync(path.join(sdir, 'doing', 'n2.json'), 'utf8')).endAt), at(21, 0), 'trece horas adelante sigue siendo hoy');
});

test('T51 AdhocSet_KeepsDeclaredHour: agrandar el carril no borra la hora declarada', () => {
  const src = fs.readFileSync(MARKER, 'utf8');
  const set = src.slice(src.indexOf('const existing = io.readAdhoc(STATE_DIR, destino);'), src.indexOf('io.writeAdhoc(STATE_DIR, destino, obj);'));
  assert.match(set, /existing[^\n]*\.until/, 'adhoc set copia la hora del carril que ya existía');
});

// ---------- la oficina viva: una tarjeta, el sitio, abrir sin cmd, los escritorios y la promesa de cada corrida ----------

const { openFile, deskSlots } = require(OFFICE);

test('T34 Card_OneWorkOnly: la tarjeta dice un solo trabajo, el de la corrida o el del carril', () => {
  const m = toyMachine();
  const pipe = { stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'implement'] };
  fs.writeFileSync(path.join(m.state, 'active', 's1.json'), JSON.stringify({ sessionId: 's1', storyId: '9.1', storyPath: storyFile(m, '9.1', 'La historia de la corrida'), ...pipe }));
  fs.writeFileSync(path.join(m.state, 'doing', 's1.json'), JSON.stringify({ text: 'mientras espero, miro el banco', at: new Date(NOW).toISOString(), endAt: new Date(NOW + 3600000).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'adhoc', 's1.json'), JSON.stringify({ reason: 'otro arreglo de la misma sesión', declaredAt: new Date(NOW).toISOString(), until: new Date(NOW + 2 * 3600000).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'adhoc', 's2.json'), JSON.stringify({ reason: 'arreglo suelto', declaredAt: new Date(NOW).toISOString() }));
  liveSession(m, 's1', 'Alfa');
  liveSession(m, 's2', 'Beto');
  const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root });
  const { data } = buildOffice({ wip: w, nowMs: NOW });
  const alfa = byName(data, 'Alfa');
  assert.strictEqual(alfa.tipo, 'pipeline');
  assert.match(alfa.mientras || '', /miro el banco|otro arreglo/);
  for (const hh of [new Date(NOW + 3600000), new Date(NOW + 2 * 3600000)]) {
    assert.ok(!String(alfa.pronosticoIso || '').endsWith(`${String(hh.getHours()).padStart(2, '0')}:${String(hh.getMinutes()).padStart(2, '0')}`), 'la hora de la nota o del carril no es la de la corrida');
  }
  const beto = byName(data, 'Beto');
  assert.strictEqual(beto.termina, 'sin hora estimada');
  assert.strictEqual(beto.avance, undefined);
});

test('T35 SiteLink_FromProfile_OrNothing: el enlace al sitio sale del perfil, o no hay enlace', async () => {
  const { collect } = require(OFFICE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-site-'));
  for (const d of ['active', 'adhoc', 'doing']) fs.mkdirSync(path.join(stateDir(home), d), { recursive: true });
  const at = (code, out) => async () => ({ code, out });
  const ok = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: at(0, 'https://sitio.example\n') });
  assert.strictEqual(ok.meta.sitio, 'https://sitio.example');
  const html = page(ok);
  assert.match(html, /target="_blank" rel="noopener"|rel="noopener"/);
  for (const [code, out, note] of [[3, '', null], [2, 'perfil roto', /sitio/], [0, 'javascript:alert(1)', null]]) {
    const d = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: at(code, out) });
    assert.strictEqual(d.meta.sitio, undefined, `${code} ${out}`);
    if (note) assert.ok(d.unreadable.some((u) => note.test(u)), d.unreadable.join(' | '));
  }
});

test('T36 OpenFile_Windows_NoShell: en Windows abre con rundll32, sin cmd ni shell', () => {
  const target = 'C:\\Temp\\a&b|c^d "e"\\oficina.html';
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  openFile(target, { platform: 'win32', spawn: fake });
  assert.strictEqual(calls[0].cmd, 'rundll32');
  assert.deepStrictEqual(calls[0].args, ['url.dll,FileProtocolHandler', target]);
  assert.ok(!calls[0].args.includes('/c') && calls[0].cmd !== 'cmd');
  assert.ok(!calls[0].opts.shell, 'sin shell');
  openFile(target, { platform: 'darwin', spawn: fake });
  openFile(target, { platform: 'linux', spawn: fake });
  assert.deepStrictEqual(calls.slice(1).map((c) => [c.cmd, c.args]), [['open', [target]], ['xdg-open', [target]]]);
  let said = '';
  const failing = () => ({ on(ev, fn) { if (ev === 'error') fn(new Error('ENOENT')); }, unref() {} });
  const write = process.stderr.write;
  process.stderr.write = (s) => { said += s; return true; };
  try { openFile(target, { platform: 'win32', spawn: failing }); } finally { process.stderr.write = write; }
  assert.match(said, /abrila a mano: .*oficina\.html/);
});

test('T52 Desks_UpToTen_NotCappedByCoordination: hasta 10 escritorios según cuántas sesiones haya', () => {
  for (const [n, desks, extra] of [[6, 6, 0], [10, 10, 0], [12, 10, 2]]) {
    const entries = Array.from({ length: n }, (_, i) => ({ session: `s${String(i).padStart(2, '0')}`, extra: { kind: 'loose', text: `arreglo ${i}` } }));
    const { data } = buildOffice({ wip: wip(entries), nowMs: NOW });
    assert.strictEqual(data.meta.puestos.length, desks, `${n} sesiones`);
    assert.strictEqual(data.meta.extra, extra);
  }
  // hasta cinco, los cinco lugares de siempre; con seis o más, la grilla de diez; nunca más de diez
  const five = deskSlots(5);
  assert.deepStrictEqual(deskSlots(3), five.slice(0, 3));
  assert.deepStrictEqual(five[0], [5.6, 1.45, 0], 'el primero de los cinco de siempre');
  const ten = deskSlots(10);
  assert.strictEqual(ten.length, 10);
  assert.strictEqual(new Set(ten.map((s) => `${s[0]},${s[1]}`)).size, 10, 'diez lugares distintos');
  assert.ok(!ten.some((s) => five.some((f) => f[0] === s[0] && f[1] === s[1])), 'la grilla no reusa los cinco');
  assert.deepStrictEqual(deskSlots(6), ten.slice(0, 6));
  assert.strictEqual(deskSlots(12).length, 10, 'tope de diez');
  const html = page(buildOffice({ wip: wip([{ session: 'a' }]), nowMs: NOW }).data);
  assert.doesNotMatch(html, /max_working/, 'el tope de la coordinadora no cuenta');
  assert.match(html, /m\.puestos/, 'la página dibuja los puestos que le llegan');
  assert.doesNotMatch(html, /SLOTS/, 'sin los cinco lugares fijos');
});

test('T53 OwnPromise_DistinctDelays: cada corrida mide su atraso contra su propia promesa', () => {
  const m = toyMachine();
  const pipe = { stepsCompleted: ['start', 'validate-story'], stepsPending: ['plan', 'implement'] };
  // las dos pasadas de su tiempo: la promesa es su arranque más su estimado, los dos campos que el marcador guarda
  const arranque = (horasAtras, estimado) => ({ startedAt: new Date(NOW - horasAtras * 3600000).toISOString(), estimate_min: estimado });
  fs.writeFileSync(path.join(m.state, 'active', 's1.json'), JSON.stringify({ sessionId: 's1', storyId: '9.1', storyPath: storyFile(m, '9.1', 'Una'), ...pipe, ...arranque(5, 180) }));
  fs.writeFileSync(path.join(m.state, 'active', 's2.json'), JSON.stringify({ sessionId: 's2', storyId: '9.2', storyPath: storyFile(m, '9.2', 'Otra'), ...pipe, ...arranque(1.5, 60) }));
  fs.writeFileSync(path.join(m.state, 'active', 's3.json'), JSON.stringify({ sessionId: 's3', storyId: '9.3', storyPath: storyFile(m, '9.3', 'Sin promesa'), ...pipe }));
  liveSession(m, 's1', 'Alfa'); liveSession(m, 's2', 'Beto'); liveSession(m, 's3', 'Cata');
  const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root });
  // la oficina se abre después: las dos ven la misma hora, pero cada una tiene la suya
  const { data } = buildOffice({ wip: w, nowMs: NOW });
  const [a, b] = [byName(data, 'Alfa'), byName(data, 'Beto')];
  assert.strictEqual(a.estimadaIso.slice(11), new Date(NOW - 2 * 3600000).toTimeString().slice(0, 5));
  assert.strictEqual(b.estimadaIso.slice(11), new Date(NOW - 30 * 60000).toTimeString().slice(0, 5));
  assert.deepStrictEqual([a.atrasoMin, b.atrasoMin], [120, 30], 'cada atraso contra su promesa');
  assert.deepStrictEqual([a.fin.cls, b.fin.cls], ['late', 'late']);
  // sin promesa anotada sigue la regla de antes: la primera hora vista, que acá no hay (no hay historial)
  assert.strictEqual(byName(data, 'Cata').termina, 'sin hora estimada');
  // los dos campos llegan de verdad al marcador por `marker.js set`, el camino de `pipeline.js start`
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-promesa-'));
  const rc = runMarker(home, 'sid-promesa', ['set', JSON.stringify({ stepScheme: 2, storyId: '9.9', storyPath: '/x/s.md', repoPath: home, stepsPending: ['approve-plan'], estimate_min: 45 })]);
  assert.strictEqual(rc, 0);
  const escrito = JSON.parse(fs.readFileSync(path.join(stateDir(home), 'active', 'sid-promesa.json'), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(escrito.startedAt)), 'el marcador guarda su arranque');
  assert.strictEqual(escrito.estimate_min, 45, 'el marcador guarda su estimado');
});

test('T56 Entering_NoQueueHour_NotLate: lo que terminó y espera entrar sin hora de la cola no sale atrasado por su promesa', () => {
  const ent = (kind) => ({ session: kind, extra: { kind, storyId: '9.1', endAt: null, promisedAt: NOW - 3 * 3600000 } });
  const { data } = buildOffice({ wip: wip([ent('entering'), ent('stalled')]), nowMs: NOW });
  for (const n of ['entering', 'stalled']) {
    const a = byName(data, n);
    assert.notStrictEqual(a.fin && a.fin.cls, 'late', `${n}: su promesa vieja no es atraso`);
    assert.ok(!a.atrasoMin, `${n}: sin minutos de atraso`);
    assert.strictEqual(a.termina, 'sin hora estimada', `${n}: dice que no hay hora, como /wip`);
  }
});

test('T57 Plain_KeepsOrdinaryWords: el texto de la sesión conserva las palabras comunes', () => {
  const said = (text) => byName(buildOffice({ wip: wip([{ session: 'n', extra: { kind: 'note', text } }]), nowMs: NOW }).data, 'n').haciendo;
  assert.strictEqual(said('Migra el plugin de .NET a la versión 8'), 'Migra el plugin de .NET a la versión 8');
  assert.strictEqual(said('Arregla el paso-a-paso del alta'), 'Arregla el paso-a-paso del alta');
  assert.strictEqual(said('Pruebas end-to-end del alta'), 'Pruebas end-to-end del alta');
  assert.strictEqual(said('Revisa la escena de three.js'), 'Revisa la escena de three.js');
  assert.strictEqual(said('10.30: reunión con el cliente'), '10.30: reunión con el cliente');
  assert.strictEqual(said('#1 prioridad: el alta'), '#1 prioridad: el alta');
  // lo técnico se sigue sacando
  assert.strictEqual(said('Arregla scripts/tools/office.js en la rama'), 'Arregla en la rama');
  assert.strictEqual(said('8.85 · Corrige el pedido #842'), 'Corrige el pedido');
  assert.strictEqual(said('Toca on-bash-write-gate y el .gitignore'), 'Toca y el');
});

test('T65 Promises_Unreadable_Said: unas horas prometidas rotas se dicen, no se toman por vacías', async () => {
  const { collect } = require(OFFICE);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-prom-'));
  for (const d of ['active', 'adhoc', 'doing', 'office']) fs.mkdirSync(path.join(stateDir(home), d), { recursive: true });
  const none = async () => ({ code: 3, out: '' });
  const fresh = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: none });
  assert.ok(!fresh.unreadable.some((u) => /prometidas/.test(u)), 'sin archivo no hay aviso');
  const file = path.join(stateDir(home), 'office', 'promises.json');
  for (const text of ['{ roto', '[]', '"texto"']) {
    fs.writeFileSync(file, text);
    const broken = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: none });
    assert.ok(broken.unreadable.some((u) => /horas prometidas no se pudieron leer/.test(u)), `${text}: ${broken.unreadable.join(' | ')}`);
  }
  // ilegible (sin permiso): también se dice
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o000);
    const blocked = await collect({ home, now: new Date(NOW).toISOString(), siteUrl: none });
    fs.chmodSync(file, 0o600);
    assert.ok(blocked.unreadable.some((u) => /horas prometidas no se pudieron leer \(EACCES\)/.test(u)), blocked.unreadable.join(' | '));
  }
});

test('T66 Page_DrawFails_Said: si una foto nueva no se puede dibujar, la página lo dice', () => {
  const html = page({ agents: [], items: [], meta: { actualizado: '10:00' }, rows: [], free: [], unreadable: [] }, { live: { token: 'abc' } });
  const handler = (html.match(/ws\.onmessage=([^\n]*);\n/) || [])[1];
  assert.ok(handler, 'la página viva tiene su manejador');
  // se corre el manejador de verdad: una foto que no se puede dibujar avisa; la siguiente que se dibuja saca el aviso
  const ovl = { textContent: '', hidden: true };
  let breakIt = true;
  const errors = [];
  const run = new Function('document', 'window', 'setData', 'renderTop', 'renderCrew', 'console', 'BORRADO', `return (${handler});`);
  const onmessage = run({ getElementById: (id) => (id === 'ovl' ? ovl : null) }, { tablero: {} },
    () => { if (breakIt) throw new Error('dibujo roto'); }, () => {}, () => {}, { error: (e) => errors.push(e) });
  onmessage({ data: JSON.stringify({ type: 'foto', data: {} }) });
  assert.strictEqual(ovl.hidden, false);
  assert.match(ovl.textContent, /No pude dibujar la última novedad/);
  assert.strictEqual(errors.length, 1, 'el error queda en la consola');
  breakIt = false;
  onmessage({ data: JSON.stringify({ type: 'foto', data: {} }) });
  assert.strictEqual(ovl.hidden, true, 'una foto buena saca el aviso');
});

test('T58 Page_PlaceholderInData_DoesNotBreak: un título con el nombre de un marcador de la plantilla no rompe la página', () => {
  const data = { agents: [{ nombre: 's1', titulo: 'documentar __OFFICE_LIVE__ y __OFFICE_DATA__' }], items: [], meta: { actualizado: '10:00' }, rows: [], free: [], unreadable: [] };
  for (const live of [{ token: 'abc' }, null]) {
    const html = page(data, { live });
    const d = html.match(/^let DATA=(.*);$/m);
    const l = html.match(/^const LIVE=(.*);$/m);
    assert.ok(d && l, 'la plantilla conserva sus dos asignaciones');
    assert.strictEqual(JSON.parse(d[1]).agents[0].titulo, 'documentar __OFFICE_LIVE__ y __OFFICE_DATA__');
    assert.deepStrictEqual(JSON.parse(l[1]), live);
  }
});

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

test('T67 Board_Absent_NoPanel: sin el archivo de la coordinadora no hay tablero ni aviso', async () => {
  const data = await collectWith(null);
  assert.strictEqual(data.tablero, null);
  assert.ok(!data.unreadable.some((u) => /tablero/.test(u)), data.unreadable.join(' | '));
});

test('T68 Board_Grouped: los pendientes van por grupo, en el orden de la semana y por su orden; los hechos aparte', () => {
  const { buildBoard } = require(OFFICE);
  const t = buildBoard(BOARD);
  assert.deepStrictEqual(t.grupos.map((g) => g.nombre), ['Hoy', 'Esta semana', 'Más adelante', 'Algún día']);
  assert.deepStrictEqual(t.grupos[0].items.map((i) => i.titulo), ['Primero de hoy', 'La oficina en vivo']);
  const live = t.grupos[0].items[1];
  assert.strictEqual(live.quien, 'Almeida');
  assert.strictEqual(live.nota, 'Falta guardar');
  assert.strictEqual(live.fin, 'dom 12:30', 'la hora esperable es la del pronóstico, con su día');
  assert.strictEqual(t.grupos[0].items[0].fin, 'cuando firmes', 'el texto propio de la coordinadora gana');
  assert.strictEqual(t.grupos[1].items[0].fin, 'mar 18:00');
  assert.strictEqual(t.grupos[2].items[0].fin, 'sin hora estimada');
  assert.deepStrictEqual(t.hechos, [{ titulo: 'La excepción del GUID', quien: 'Angelito', real: 'dom 09:10' }]);
  assert.deepStrictEqual(t.teToca, ['Firmar el ok de guardar de la B']);
  assert.strictEqual(t.resumen, 'Dos cosas en curso y una esperando tu firma.');
  assert.strictEqual(t.actualizado, 'dom 10:55');
  assert.ok(!('agentes' in t), 'los escritorios salen de /wip: el tablero no los repite');
});

test('T69 Board_Broken_Said: un tablero roto se dice y no se dibuja', async () => {
  for (const text of ['{ roto', '[]', '{"pendientes":"no es lista"}']) {
    const data = await collectWith(text);
    assert.strictEqual(data.tablero, null, text);
    assert.ok(data.unreadable.some((u) => /el tablero de la coordinadora no se pudo leer/.test(u)), `${text}: ${data.unreadable.join(' | ')}`);
  }
});

test('T70 Board_OnlyStrings: lo que no es texto no llega a la página, y un renglón sin título se saltea', () => {
  const { buildBoard } = require(OFFICE);
  const t = buildBoard({ pendientes: [{ titulo: { x: 1 } }, null, 'texto', { titulo: 'Bien', quien: 42, nota: ['a'], grupo: 7, estado: 'curso' }], meta: { teToca: ['ok', 3, null] } });
  assert.strictEqual(t.grupos.length, 1);
  assert.strictEqual(t.grupos[0].nombre, 'Sin grupo');
  assert.deepStrictEqual(t.grupos[0].items[0], { titulo: 'Bien', quien: '', nota: '', fin: 'sin hora estimada', estado: 'curso' });
  assert.deepStrictEqual(t.teToca, ['ok']);
});

test('T71 Board_Page_Panel: la página trae el panel del tablero y lo dibuja con texto, nunca como HTML', async () => {
  const data = await collectWith(JSON.stringify(BOARD));
  assert.ok(data.tablero && data.tablero.grupos.length === 4);
  const html = page(data);
  assert.match(html, /id="board"/);
  const fn = (html.match(/function renderBoard\(\)\{[\s\S]*?\n\}/) || [])[0];
  assert.ok(fn, 'la página tiene su función del tablero');
  assert.ok(!/innerHTML/.test(fn), 'el tablero se escribe con textContent');
  assert.match(html, /renderBoard\(\);renderTop\(\);renderCrew\(\)|renderBoard\(\)/);
});
