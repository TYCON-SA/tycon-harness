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

test('T28 EnCurso_MitadDeCamino_SeVeComoHoy @story-8.195 @ac-28 — la tarjeta de una ejecución a mitad de camino sigue diciendo su paso', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Medio', status: 'busy', extra: { kind: 'pipeline', current: 'implement', steps: STEPS, progress: 50 } }]), nowMs: NOW });
  assert.strictEqual(byName(data, 'Medio').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Medio').haciendo, 'Va por el paso «Implementar».');
});

test('T22 Oficina_TerminadaSinCerrar_LaTarjetaLoDice @story-8.195 @ac-22 — la tarjeta de la terminada sin cerrar está en «cerrar» y lo dice', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Hecha', status: 'idle', extra: { kind: 'finished', finishedOpen: true, nothingToSave: true, storyId: '7.7' } },
      { session: 'Revisar', status: 'idle', extra: { kind: 'finished', finishedOpen: true, finishedReview: true, nothingToSave: true, storyId: '7.8' } },
      { session: 'Ocupada', status: 'busy', extra: { kind: 'finished', finishedOpen: true, nothingToSave: true, storyId: '7.9' } },
    ]),
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Hecha').estado, 'cerrar');
  assert.strictEqual(byName(data, 'Hecha').haciendo, 'Terminó la story 7.7: falta cerrarla.');
  assert.strictEqual(byName(data, 'Revisar').estado, 'cerrar');
  assert.strictEqual(byName(data, 'Revisar').haciendo, 'Terminó la story 7.8: falta revisar lo cambiado después de los revisores.');
  // ocupada: trabaja, y la oración sigue diciendo que falta cerrarla
  assert.strictEqual(byName(data, 'Ocupada').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Ocupada').haciendo, 'Terminó la story 7.9: falta cerrarla.');
});

test('T23 Oficina_CaminoCortoConPedido_LaTarjetaLoDice @story-8.195 @ac-23 — el camino corto con su pedido abierto está en «cerrar», con el número', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Corto', status: 'idle', extra: { kind: 'loose', text: 'arreglo chico', finishedOpen: true, openPr: 'pedido 41 abierto' } }]),
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Corto').estado, 'cerrar');
  assert.strictEqual(byName(data, 'Corto').haciendo, 'Terminó «arreglo chico»: falta cerrar el camino corto (pedido 41 abierto).');
});

test('T23c Oficina_CaminoCortoConArchivoDeSesion_DiceQueFaltaCerrar @story-8.195 @ac-23 — con el archivo de la sesión, la tarjeta del camino corto con pedido sigue diciendo que falta cerrarlo', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Corto', sid: 'sid-Corto', status: 'idle', extra: { kind: 'loose', text: 'arreglo chico', finishedOpen: true, openPr: 'pedido 41 abierto' } }]),
    sessionFiles: [{ session: 'sid-Corto', tool: 'claude', sentence: 'arreglo chico', pid: 123, updatedAt: new Date(NOW - 60000).toISOString() }],
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Corto').estado, 'cerrar');
  assert.strictEqual(byName(data, 'Corto').haciendo, 'Terminó «arreglo chico»: falta cerrar el camino corto (pedido 41 abierto).');
});

test('T24 Oficina_EstadoNuevo_EnLaLista @story-8.195 @ac-24 — «cerrar» está en AGENT_STATES y en la página, con su texto', () => {
  const { AGENT_STATES } = require(path.join(path.dirname(OFFICE), 'office', 'fields.js'));
  assert.ok(AGENT_STATES.includes('cerrar'));
  assert.match(PAGE_CODE(), /\bcerrar:\["Terminado, falta cerrar","#[0-9a-f]{6}"\]/);
});

test('T1 EstadoPorSesion: firma, coordina, espera, prueba, trabajando y libre salen de lo que dice /wip', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'sesion-a', status: 'waiting_for_permission', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'sesion-b', sid: 'coord', extra: { kind: 'note' } },
      { session: 'sesion-c', extra: { kind: 'entering' } },
      { session: 'sesion-d', extra: { kind: 'stalled' } },
      { session: 'sesion-e', sid: 'e', extra: { kind: 'pipeline', current: 'run-tests', steps: STEPS, progress: 50 } },
      { session: 'sesion-f', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'sesion-g', extra: { kind: 'activity' } },
    ], { free: ['sesion-h'] }),
    coordinatorSid: 'coord',
    sessionFiles: [{ session: 'e', tool: 'claude', pid: 10 }],
    processes: [{ pid: 11, ppid: 10, comando: 'bash /x/test-gate.sh /repo' }],
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
  assert.strictEqual(byName(data, 'sesion-b').haciendo, 'Va por el paso «Correr las pruebas». No se sabe si hay pruebas corriendo.');
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

test('T12 HoraPasada: una hora de fin que ya pasó no es un pronóstico: dice que se pasó, por vieja que sea; nunca «en hora»', () => {
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
  assert.strictEqual(old.termina, 'se pasó de la hora');
  assert.strictEqual(old.pronosticoIso, undefined, 'una hora que pasó no se muestra como pronóstico');
  assert.strictEqual(late.pronosticoIso, undefined);
  const { finTxt } = pageTimeHelpers();
  assert.deepStrictEqual(finTxt(late), { hora: 'se pasó de la hora', dif: '', cls: 'late' });
  assert.deepStrictEqual(finTxt(old), { hora: 'se pasó de la hora', dif: '', cls: 'late' });
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
    ], { halfwayItems: [{ kind: 'adhoc', text: 'ad hoc de la sesión zeta', cleanAfter: null, left: [{ folder: '/x/th-zeta', branch: 'fix/zeta', changes: 2, ahead: 0 }] }] }),
    signatures: [{ id: 'f1', title: 'saltar el pase de 5.2', at: NOW }, { id: 'f2' }],
    nowMs: NOW,
  });
  assert.deepStrictEqual(data.items.map((i) => [i.quien, i.estado]), [
    ['sesion-a', 'riesgo'], ['sesion-b', 'espera'], ['sesion-c', 'firma'], ['sesion-d', 'curso'], ['vos', 'firma'], ['—', 'riesgo'],
  ]);
  assert.strictEqual(data.items[5].titulo, 'th-zeta: 2 archivos sin guardar', 'sin el comando de limpieza');
  assert.match(data.items[5].accion, /Era «ad hoc de la sesión zeta»\. Abrí una sesión en esa carpeta/);
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

// sin el sitio de la organización: el perfil del equipo, puesto encima del árbol en la validación, sí trae site.url
const run = (home, args) => execFileSync('node', [OFFICE, ...args], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_LINK: '0' }, stdio: 'pipe' }).toString();

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
  // una hora que todavía no pasó, a cualquier hora que corra la prueba y en cualquier huso: marker.js usa el reloj real
  const later = new Date(Date.now() + 3600000);
  const HORA = `${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-until-'));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'arreglos rápidos de la oficina', declaredAt: new Date().toISOString() }));
  assert.strictEqual(runMarker(home, 's2', ['adhoc', 'until', '25:99']), 2, 'la hora se valida primero, aunque no haya carril');
  assert.strictEqual(runMarker(home, 's2', ['adhoc', 'until', HORA]), 1, 'sin carril no hay dónde anotarla');
  assert.ok(!fs.existsSync(path.join(sdir, 'adhoc', 's2.json')), 'sin carril no se crea nada');
  assert.strictEqual(runMarker(home, 's1', ['adhoc', 'until', HORA]), 0);
  assert.strictEqual(runMarker(home, 's3', ['doing', 'espero turno para el banco de controles', '--until', HORA]), 0);
  const until = JSON.parse(fs.readFileSync(path.join(sdir, 'adhoc', 's1.json'), 'utf8')).until;
  const endAt = JSON.parse(fs.readFileSync(path.join(sdir, 'doing', 's3.json'), 'utf8')).endAt;
  for (const iso of [until, endAt]) {
    const d = new Date(iso);
    assert.deepStrictEqual([d.getHours(), d.getMinutes()], [later.getHours(), later.getMinutes()]);
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
  assert.strictEqual(runMarker(home, 's5', ['adhoc', 'until', HORA]), 0);
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 's5.json'), JSON.stringify({ pid: process.pid, sessionId: 's5', name: 'Muñe', status: 'busy', statusUpdatedAt: Date.now() }));
  for (const [sid, name] of [['s1', 'Alfa'], ['s3', 'Zeta']]) fs.writeFileSync(path.join(sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: Date.now() }));
  const w = buildWip({ stateDir: sdir, sessionsDir: sessions, now: new Date().toISOString() });
  const { data } = buildOffice({ wip: w, nowMs: Date.now() });
  for (const name of ['Alfa', 'Zeta']) {
    const a = byName(data, name);
    assert.strictEqual(a.pronosticoIso.slice(11), HORA, name);
    assert.strictEqual(a.termina, undefined, `${name} tiene hora`);
    assert.match(w.rows.find((r) => r.session === name).end, new RegExp(HORA), `/wip la muestra en «Fin estimado» (${name})`);
  }
  // una hora guardada ilegible se dice, no pasa por «sin estimación»
  fs.writeFileSync(path.join(sdir, 'adhoc', 's7.json'), JSON.stringify({ reason: 'arreglo con la hora rota', declaredAt: new Date().toISOString(), until: 'mañana' }));
  fs.writeFileSync(path.join(sessions, 's7.json'), JSON.stringify({ pid: process.pid, sessionId: 's7', name: 'Rota', status: 'busy', statusUpdatedAt: Date.now() }));
  const w2 = buildWip({ stateDir: sdir, sessionsDir: sessions, now: new Date().toISOString() });
  assert.strictEqual(w2.rows.find((r) => r.session === 'Rota').end, 'hora declarada ilegible');
  const withRun = byName(data, 'Muñe');
  assert.strictEqual(withRun.tipo, 'pipeline', 'la sesión con corrida es su corrida');
  assert.ok(!String(withRun.pronosticoIso || '').endsWith(HORA), 'la hora del carril no pisa la de la corrida');
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
  assert.strictEqual(rows.length, 0, 'sin carpetas con algo sin terminar, no hay filas');
  const seen = JSON.stringify(rows);
  for (const bad of ['ad-hoc', 'dead-', 'limpiar: node', 'clear-session', 'marker.js', '9.9']) assert.ok(!seen.includes(bad), `sale «${bad}»`);
  const unknown = buildOffice({ wip: wip([], { halfwayItems: [{ kind: 'adhoc', text: 'arreglo de fecha rota', cleanAfter: 'unknown' }] }), nowMs: now }).data;
  assert.deepStrictEqual(unknown.kanban.medioCamino, [], 'lo que no se sabe no es una fila');
  assert.match(unknown.kanban.medioCaminoNoSe, /^De un trabajo de una sesión cerrada no se pudo saber/);
  assert.match(unknown.kanban.medioCaminoLeido, /^Leído a las \d\d:\d\d$/, 'dice a qué hora se leyó');
  assert.strictEqual(buildOffice({ wip: wip([]), nowMs: now }).data.kanban.medioCaminoLeido, undefined, 'sin nada a medio camino, no dice nada');
  assert.ok((page(data).match(/medioCaminoLeido/g) || []).length >= 2, 'la sección y el panel muestran la hora');
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
  const expect = { Pasada: ['', 'late'], Prometida: ['+30 min tarde', 'late'], Justa: ['en hora', 'ontime'], Suelta: ['', ''], Temprana: ['30 min antes', 'early'] };
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
  // el título de la historia viaja aparte del trabajo, con o sin tanda en curso
  for (const [n, t] of [['Alfa', long], ['Beto', 'Una historia con tandas sin ninguna en curso'], ['Cata', long]]) assert.strictEqual(byName(data, n).historiaTitulo, t, n);
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
  const item = buildOffice({ wip: wip([], { halfwayItems: [{ kind: 'run', text: title, cleanAfter: null, left: [{ folder: '/x/th-a', branch: 'fix/a', changes: 0, ahead: 3 }] }] }), nowMs: NOW }).data.items[0];
  assert.strictEqual(item.titulo, 'th-a: 3 commits que no entraron a main');
  assert.ok(item.accion.includes(`Era «${title}»`), item.accion);
  assert.match(item.accion, /Abrí un pedido con la rama fix\/a/);
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

test('T294 FirstCorrection_ReplacesThePromise: sólo la primera, en los 10 minutos de la primera hora; corregir seguido no renueva la ventana', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-correct-'));
  const sdir = stateDir(home);
  const at = (mi) => new Date(2026, 9, 31, 0, mi).getTime();
  const hour = (h, mi) => new Date(2026, 9, 31, h, mi).getTime();
  const note = (sid, mi, until) => {
    const r = markerAt(home, sid, at(mi), ['doing', 'una tarea con su hora', '--until', until]);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = JSON.parse(fs.readFileSync(path.join(sdir, 'doing', `${sid}.json`), 'utf8'));
    return [Date.parse(d.endAt), d.promisedAt ? Date.parse(d.promisedAt) : null];
  };
  note('a', 8, '12:00');
  assert.deepStrictEqual(note('a', 9, '01:30'), [hour(1, 30), null], 'la primera corrección reemplaza lo prometido');
  assert.deepStrictEqual(note('a', 11, '02:30'), [hour(2, 30), hour(1, 30)], 'la segunda ya no: la promesa es la corregida');
  assert.deepStrictEqual(note('a', 13, '03:30'), [hour(3, 30), hour(1, 30)], 'ni renueva la ventana');
  note('justo', 8, '12:00');
  assert.deepStrictEqual(note('justo', 18, '01:30'), [hour(1, 30), null], 'a los 10 minutos justos todavía corrige');
  note('tarde', 8, '12:00');
  assert.deepStrictEqual(note('tarde', 19, '01:30'), [hour(1, 30), hour(12, 0)], 'pasados los 10 minutos, la promesa queda');
  note('igual', 8, '12:00');
  note('igual', 9, '12:00');
  assert.deepStrictEqual(note('igual', 10, '01:30'), [hour(1, 30), hour(12, 0)], 'repetir la misma hora la confirma: ya no se corrige');
  // la misma hora tipeada, a un lado y otro del corte de 12 h, cae en otro día: la repite, no la corrige
  const cross = (mi, h) => markerAt(home, 'corte', new Date(2026, 9, 31, h, mi).getTime(), ['doing', 'una tarea con su hora', '--until', '08:00']);
  assert.strictEqual(cross(55, 19).status, 0);
  assert.strictEqual(cross(5, 20).status, 0);
  const corte = JSON.parse(fs.readFileSync(path.join(sdir, 'doing', 'corte.json'), 'utf8'));
  assert.strictEqual(Date.parse(corte.promisedAt), new Date(2026, 9, 31, 8, 0).getTime(), 'la promesa se conserva');
  assert.ok(!corte.hourCorrected, 'no gastó la corrección');
  const vieja = path.join(sdir, 'doing', 'vieja.json');
  fs.writeFileSync(vieja, JSON.stringify({ text: 'una tarea con su hora', at: new Date(at(8)).toISOString(), endAt: new Date(hour(12, 0)).toISOString() }));
  assert.deepStrictEqual(note('vieja', 9, '01:30'), [hour(1, 30), hour(12, 0)], 'una nota de antes de este cambio no sabe cuándo se anotó: conserva su promesa');
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
  const handler = (PAGE_CODE().match(/ws\.onmessage=([^\n]*);\n/) || [])[1];
  assert.ok(handler, 'la página viva tiene su manejador');
  // se corre el manejador de verdad: una foto que no se puede dibujar avisa; la siguiente que se dibuja saca el aviso
  const ovl = { textContent: '', hidden: true };
  let breakIt = true;
  const errors = [];
  const run = new Function('document', 'window', 'setData', 'renderTop', 'renderCrew', 'console', 'relojTick', 'agents', 'meta', 'BORRADO', `return (${handler});`);
  const onmessage = run({ getElementById: (id) => (id === 'ovl' ? ovl : null) }, { tablero: {} },
    () => { if (breakIt) throw new Error('dibujo roto'); }, () => {}, () => {}, { error: (e) => errors.push(e) }, () => {}, [], null);
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
  // la foto fija lleva sus datos adentro; la del proceso local, sólo su token
  const fixed = page(data);
  const block = fixed.match(/<script type="application\/json" id="officeData">(.*)<\/script>/);
  assert.ok(block, 'la foto fija lleva el bloque de datos');
  assert.strictEqual(JSON.parse(block[1]).agents[0].titulo, 'documentar __OFFICE_LIVE__ y __OFFICE_DATA__');
  assert.doesNotMatch(fixed, /__OFFICE_(ATTRS|BAR|IMPORTMAP|CODE|DATA_BLOCK)__/);
  const live = page(data, { live: { token: 'abc' } });
  assert.match(live, /data-source="local"/);
  assert.match(live, /data-token="abc"/);
  assert.doesNotMatch(live, /documentar|id="officeData"/, 'los datos llegan por la conexión');
  assert.doesNotMatch(live, /__OFFICE_(ATTRS|BAR|IMPORTMAP|CODE|DATA_BLOCK)__/);
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

test('T68 Board_Grouped: las filas van en el orden de la semana y por su orden, cada una con su columna y su hora', () => {
  const { buildBoard } = require(OFFICE);
  const t = buildBoard(BOARD);
  assert.deepStrictEqual(t.filas.map((f) => f.titulo), ['Primero de hoy', 'La oficina en vivo', 'La excepción del GUID', 'Esta semana uno', 'Más adelante uno', 'Otro grupo']);
  assert.deepStrictEqual(t.filas.map((f) => f.columna), ['firma', 'curso', 'hechos', 'curso', 'sinEmpezar', 'curso']);
  const live = t.filas[1];
  assert.strictEqual(live.quien, 'Almeida');
  assert.strictEqual(live.nota, 'Falta guardar');
  assert.strictEqual(live.fin, 'dom 12:30', 'la hora esperable es la del pronóstico, con su día');
  assert.strictEqual(t.filas[0].fin, 'cuando firmes', 'el texto propio de la coordinadora gana');
  assert.strictEqual(t.filas[3].fin, 'mar 18:00');
  assert.strictEqual(t.filas[3].marca, 'riesgo', 'en riesgo va a «En curso» con esa marca');
  assert.strictEqual(t.filas[4].fin, 'sin hora estimada');
  assert.strictEqual(t.filas[2].fin, 'dom 09:10', 'un hecho dice su hora real');
  assert.deepStrictEqual(t.teToca, ['Firmar el ok de guardar de la B']);
  assert.ok(!('resumen' in t), 'meta.resumen se ignora: la línea de arriba se arma sola (8.198, AC 28)');
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
  assert.strictEqual(t.filas.length, 1);
  assert.strictEqual(t.filas[0].grupo, '');
  assert.deepStrictEqual(t.filas[0], { titulo: 'Bien', quien: '', nota: '', fin: 'sin hora estimada', finAt: null, realAt: null, estado: 'curso', grupo: '', columna: 'curso', marca: null, historia: null, pedido: null, numero: null });
  assert.deepStrictEqual(t.teToca, ['ok']);
  // `historia` y `pedido` tienen forma: lo que no la tiene no llega a una consulta
  const p = buildBoard({ pendientes: [
    { titulo: 'a', historia: '2.81', pedido: { repo: 'tycon-harness', numero: 885 } },
    { titulo: 'b', historia: 7, pedido: { repo: 'x; rm', numero: 885 } },
    { titulo: 'c', pedido: { repo: 'tycon-harness', numero: '885; rm' } },
    { titulo: 'd', pedido: 'tycon-harness#885' },
  ] }).filas;
  assert.deepStrictEqual(p.map((f) => [f.historia, f.pedido]), [['2.81', { repo: 'tycon-harness', numero: 885 }], [null, null], [null, null], [null, null]]);
});

test('T71 Board_Page_Panel: la página trae el panel del tablero y lo dibuja con texto, nunca como HTML', async () => {
  const data = await collectWith(JSON.stringify(BOARD));
  assert.ok(data.tablero && !('resumen' in data.tablero), 'meta.resumen se ignora (8.198, AC 28)');
  assert.ok(data.kanban.linea, 'la línea de arriba se arma sola de las tarjetas');
  assert.ok(data.kanban.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.some((t) => t.titulo === 'La oficina en vivo'), 'sin una sesión viva no está en curso');
  const html = page(data);
  assert.match(html, /id="board"/);
  const fn = (html.match(/function renderBoard\(\)\{[\s\S]*?\n\}/) || [])[0];
  assert.ok(fn, 'la página tiene su función del tablero');
  assert.ok(!/innerHTML/.test(fn), 'el tablero se escribe con textContent');
  assert.match(html, /renderBoard\(\);renderTop\(\);renderCrew\(\)|renderBoard\(\)/);
});

test('T72 SiteLink_OnlyFromPage_OnlyWeb: el enlace al sitio sale de la página armada, sólo si es web, nunca del WebSocket', () => {
  const html = page({ agents: [], items: [], meta: { actualizado: '10:00', sitio: 'https://sitio.example/x' }, rows: [], free: [], unreadable: [] }, { live: { token: 'abc' } });
  assert.match(html, /data-site="https:\/\/sitio\.example\/x"/, 'el enlace lo arma office.js');
  const code = PAGE_CODE();
  const line = (code.match(/^const SITE=(.*);$/m) || [])[1];
  assert.ok(line, 'la página calcula el enlace una vez');
  const site = (sitio) => new Function('RAIZ', `return ${line};`)({ dataset: { site: sitio } });
  assert.strictEqual(site('https://sitio.example/x'), 'https://sitio.example/x');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hola', 'vbscript:x', '', undefined, 'no es una dirección']) assert.strictEqual(site(bad), null, String(bad));
  // nada de la página toma el sitio de los datos que llegan después
  assert.doesNotMatch(code, /meta\.sitio/, 'la página no mira meta.sitio');
});

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

test('T73 Office_FirstThenBoard: la sala 3D es lo primero que se ve; el tablero va abajo, después de las sesiones', async () => {
  const data = await collectWith(JSON.stringify(BOARD));
  const html = page(data);
  const body = html.slice(html.indexOf('<body>'));
  const at = (re) => body.search(re);
  assert.ok(at(/id="office"/) > 0 && at(/id="board"/) > 0, 'están las dos');
  assert.ok(at(/id="office"/) < at(/id="board"/), 'la sala va antes que el tablero');
  assert.ok(at(/id="office"/) < at(/id="crew"/), 'la sala va antes que las tarjetas de las sesiones');
  // en un monitor ancho la página usa el ancho: no queda en una columna angosta en el medio
  const width = Number((html.match(/main\{max-width:(\d+)px/) || [])[1]);
  assert.ok(width >= 1500, `ancho máximo ${width}`);
});

// La función del kanban de la página, corrida fuera del navegador con un DOM mínimo.
function drawKanban(data) {
  const html = page(data);
  const fn = (html.match(/function renderBoard\(\)\{[\s\S]*?\n\}/) || [])[0];
  const el = (html.match(/const el=(\([^\n]*\});\n/) || [])[1];
  assert.ok(fn && el, 'la página trae la función y el ayudante');
  const { document, byId } = tinyDom();
  const state = (html.match(/function estadoDeHora\(i\)[^\n]*\n/) || [''])[0];
  new Function('document', 'DATA', `const el=${el};${state}${fn};renderBoard();`)(document, data);
  return { html, fn, body: byId.boardBody, sec: byId.board };
}

test('T74 Board_Compact: cada tarjeta dice título, quién y hora, en su columna; a medio camino va plegado debajo', async () => {
  const data = await collectWith(JSON.stringify(BOARD));
  const { html, body } = drawKanban(data);
  const cols = all(body, (n) => /\bcol\b/.test(n.className));
  assert.strictEqual(cols.length, 5, 'las cinco columnas');
  const firma = textOf(cols[2]);
  assert.match(firma, /Primero de hoy/);
  assert.match(firma, /vos/);
  assert.match(firma, /cuando firmes/);
  // el grupo se dice en la tarjeta
  assert.match(textOf(cols[0]), /Algún día/);
  assert.match(textOf(cols[4]), /La excepción del GUID/, 'lo hecho va en su columna');
  assert.ok(!all(cols[1], (n) => /La excepción del GUID/.test(n.textContent || '')).length, 'y no en otra');
  // las columnas se acomodan solas al ancho: varias en un monitor ancho, una en una pantalla angosta
  assert.match(html, /\.board \.cols\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(/);
});

// ---------- el archivo de estado de cada sesión ----------

// Un archivo de sesión como lo escriben el gancho y marker.js, con lo que la prueba cambie.
const sessionFile = (session, fields = {}) => ({
  schema: 1, session, tool: 'claude', name: null, sentence: 'Trabaja sin pipeline.', step: null, endAt: null, endWithoutHour: null,
  waitingForOwner: false, waitingFor: null, updatedAt: new Date(NOW - 60000).toISOString(), pid: process.pid, ...fields,
});

test('T25 Office_PrefersSessionFile @story-2.81 @ac-24 — el archivo manda en lo que sabe; lo demás, /wip', () => {
  const later = NOW + 2 * 3600000;
  const { data } = buildOffice({
    wip: wip([
      { session: 'ConArchivo', sid: 's-a', extra: { kind: 'pipeline', current: 'implement', steps: STEPS, endAt: NOW + 3600000 } },
      { session: 'SinArchivo', sid: 's-b', extra: { kind: 'pipeline', current: 'implement', steps: [{ id: 'implement', name: 'Implementar', done: false }] } },
      { session: 'Entrando', sid: 's-c', extra: { kind: 'entering', endAt: NOW - 600000 } },
    ], { halfwayItems: [{ kind: 'run', text: 'La historia de Codex', cleanAfter: null, sid: 's-d' }, { kind: 'adhoc', text: 'otro carril', cleanAfter: null, sid: 's-x', left: [{ folder: '/x/th-x', branch: 'fix/x', changes: 1, ahead: 0 }] }] }),
    sessionFiles: [
      sessionFile('s-a', { name: 'ConArchivo', step: 'Revisores', sentence: 'Va por el paso «Revisores».', endAt: new Date(later).toISOString(), waitingForOwner: true, waitingFor: 'un permiso' }),
      sessionFile('s-c', { name: 'Entrando' }),
      sessionFile('s-d', { tool: 'codex', pid: null, step: 'Implementar', sentence: 'Va por el paso «Implementar».' }),
    ],
    codexNames: new Map([['s-d', 'Lola']]),
    nowMs: NOW,
  });
  const a = byName(data, 'ConArchivo');
  assert.strictEqual(a.estado, 'firma', 'la espera sale del archivo');
  assert.strictEqual(a.espera, 'un permiso');
  assert.strictEqual(a.haciendo, 'Va por el paso «Revisores».');
  assert.strictEqual(a.paso, 'Revisores');
  assert.strictEqual(a.pronosticoIso, (() => { const d = new Date(later); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; })(), 'la hora sale del archivo');
  assert.strictEqual(byName(data, 'SinArchivo').haciendo, 'Va por el paso «Implementar».', 'sin archivo, la derivación de hoy');
  const c = byName(data, 'Entrando');
  assert.strictEqual(c.haciendo, 'Terminó: sus cambios están entrando a los repos.', 'lo que el archivo no sabe sigue saliendo de /wip');
  assert.strictEqual(c.termina, 'esperando entrar');
  const d = byName(data, 'Lola');
  assert.ok(d, 'la sesión de Codex sin fila se dibuja con su nombre');
  assert.strictEqual(d.haciendo, 'Va por el paso «Implementar».');
  assert.strictEqual(d.estado, 'trabajando');
  assert.ok(!data.items.some((i) => i.titulo === 'La historia de Codex'), 'y no sale además en «A medio camino»');
  assert.ok(data.items.some((i) => i.titulo === 'th-x: 1 archivo sin guardar'), 'lo de otras sesiones sin archivo queda');
});

test('T26 Office_BrokenSessionFile_FallsBack @story-2.81 @ac-25 — un archivo roto o de otro esquema se dice y la sesión sale igual', () => {
  const { home, state } = toyHome();
  const sdir = path.join(home, '.claude', '.tycon-pipeline');
  assert.strictEqual(state, sdir);
  fs.mkdirSync(path.join(sdir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'sessions', 's1.json'), '{roto');
  fs.writeFileSync(path.join(home, '.claude', 'sessions', 's9.json'), JSON.stringify({ pid: process.pid, sessionId: 's9', name: 'sesion-9', status: 'idle', statusUpdatedAt: NOW - 20 * 60000 }));
  fs.writeFileSync(path.join(sdir, 'sessions', 's9.json'), JSON.stringify(sessionFile('s9', { schema: 9, name: 'sesion-9', sentence: 'del esquema 9' })));
  fs.writeFileSync(path.join(sdir, 'sessions', 'sx.json'), JSON.stringify(sessionFile('sx', { tool: 'otra', name: 'sesion-x' })));
  const data = JSON.parse(run(home, ['--json', '--now', new Date(NOW).toISOString()]));
  const said = data.unreadable.join('\n');
  assert.match(said, /s1\.json[^\n]*JSON|s1\.json[^\n]*roto/i, said);
  assert.match(said, /s9\.json[^\n]*schema/i, said);
  assert.match(said, /sx\.json[^\n]*herramienta/i, said);
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.estado]).sort(), [['sesion-9', 'libre'], ['sesion-a', 'libre']], 'cada sesión sale con la derivación de hoy');
  assert.ok(!data.agents.some((a) => a.haciendo === 'del esquema 9'));
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

test('T43 Page_QuietClock_ConfigurableThreshold @story-2.81 @ac-39 — el reloj de la página marca las calladas con el umbral, sin pedir nada', async () => {
  const html = PAGE_CODE();
  assert.match(html, /setInterval\(\s*\(\)\s*=>\s*\{[^}]*relojTick/, 'el reloj corre cada minuto en la página');
  const { relojTick, umbral, calls } = pageClock(html);
  const people = () => [
    { nombre: 'A', estado: 'trabajando', haciendo: 'x', novedadMs: NOW - 16 * 60000, sinPid: false },
    { nombre: 'B', estado: 'trabajando', haciendo: 'y', novedadMs: NOW - 5 * 60000, sinPid: false },
    { nombre: 'C', estado: 'trabajando', haciendo: 'z', novedadMs: NOW - (2 * 3600000 + 60000), sinPid: true },
  ];
  let list = people();
  relojTick(list, NOW, { quietMin: undefined });
  assert.match(list[0].callada, /^sin novedades desde las \d\d:\d\d$/);
  assert.ok(!list[1].callada);
  assert.strictEqual(list[2].estado, 'inactiva', 'sin pid y más de 2 h: inactiva, sin foto nueva');
  assert.match(list[2].haciendo, /sin novedades desde las \d\d:\d\d/);
  list = people();
  relojTick(list, NOW, { quietMin: 30 });
  assert.ok(!list[0].callada && !list[1].callada, 'con 30, ninguna');
  for (const bad of ['abc', 0, -5, null]) assert.strictEqual(umbral({ quietMin: bad }), 15, String(bad));
  assert.strictEqual(calls.net, 0, 'el reloj no hace ningún pedido de red');
  // collect pasa el umbral del perfil del equipo, y uno roto cae al de por defecto
  const { collect } = require(OFFICE);
  const { home } = toyHome();
  const at = new Date(NOW).toISOString();
  const quiet = async (code, out) => (await collect({ home, now: at, siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code, out }) })).meta.quietMin;
  assert.strictEqual(await quiet(3, ''), 15, 'sin configurar');
  assert.strictEqual(await quiet(0, '30\n'), 30);
  assert.strictEqual(await quiet(0, 'abc'), 15, 'roto: el de por defecto');
  assert.strictEqual(await quiet(0, '0'), 15);
});

test('T83 Coordinator_FileWait_Shows @story-2.81 @ac-24 — la coordinadora que espera un permiso se ve esperando, con archivo o sin él', () => {
  const asking = sessionFile('s-co', { name: 'Coordinadora', waitingForOwner: true, waitingFor: 'un permiso' });
  // con fila de /wip
  let { data } = buildOffice({ wip: wip([{ session: 'Coordinadora', sid: 's-co', extra: { kind: 'activity' } }]), coordinatorSid: 's-co', sessionFiles: [asking], nowMs: NOW });
  assert.strictEqual(byName(data, 'Coordinadora').estado, 'firma');
  assert.strictEqual(byName(data, 'Coordinadora').espera, 'un permiso');
  // libre en /wip
  ({ data } = buildOffice({ wip: wip([], { free: ['Coordinadora'], freeSids: ['s-co'] }), coordinatorName: 'Coordinadora', sessionFiles: [asking], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Coordinadora').estado, 'firma');
  // sin espera, coordina
  ({ data } = buildOffice({ wip: wip([], { free: ['Coordinadora'], freeSids: ['s-co'] }), coordinatorName: 'Coordinadora', sessionFiles: [sessionFile('s-co', { name: 'Coordinadora' })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Coordinadora').estado, 'coordina');
});

test('T84 NoPid_OldFile_PhotoAndClockAgree @story-2.81 @ac-23 — sin pid y callada más de 2 h, la foto ya la dice inactiva; el reloj corre al abrir y con cada foto', () => {
  const old = sessionFile('s-np', { name: 'SinPid', tool: 'codex', pid: null, waitingForOwner: true, waitingFor: 'una respuesta', updatedAt: new Date(NOW - 3 * 3600000).toISOString() });
  const { data } = buildOffice({ wip: wip([{ session: 'SinPid', sid: 's-np', extra: { kind: 'loose', text: 'algo' } }]), sessionFiles: [old], nowMs: NOW });
  const a = byName(data, 'SinPid');
  assert.strictEqual(a.estado, 'inactiva');
  assert.match(a.haciendo, /^Inactiva: sin novedades desde las \d\d:\d\d\.$/);
  assert.ok(!a.espera, 'la espera vieja no se muestra');
  const html = PAGE_CODE();
  const after = html.slice(html.indexOf('// fin del reloj'));
  assert.match(after, /^\/\/ fin del reloj\n(?:\/\/[^\n]*\n)*if\(!CON_OFICINAS\)\{relojTick\(agents,Date\.now\(\),meta\);renderTop\(\);renderCrew\(\);/, 'al abrir, el reloj antes del primer dibujo');
  assert.match(html, /setData\(m\.data\);relojTick\(agents,Date\.now\(\),meta\);renderTop\(\)/, 'con cada foto nueva, el reloj antes de dibujar');
});

// ---------- el estado real, «Tu firma», el trabajo de ahora, el kanban, la hora y la marca ----------

const { spawnSync } = require('child_process');
const { wipNow } = require(path.join(__dirname, '..', 'tools', 'work-in-progress.js'));
const { collect, buildBoard, createEnvelopes } = require(OFFICE);
const STEP_LIB = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));

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

test('T85 RealStatus_BusyIdleWaiting @story-2.81 @ac-44: el estado sale de si la sesión trabaja, no del paso', () => {
  const impl = { kind: 'pipeline', current: 'implement', steps: [{ id: 'implement', name: 'Implementar', done: false }] };
  const tests = { kind: 'pipeline', current: 'run-tests', steps: [{ id: 'run-tests', name: 'Correr las pruebas', done: false }] };
  const at2010 = new Date(2026, 9, 18, 20, 10).getTime();
  const { data } = buildOffice({
    wip: wip([
      { session: 'Uno', status: 'busy', extra: impl },
      { session: 'Dos', status: 'shell', extra: impl },
      { session: 'Tres', status: 'idle', statusAt: at2010, extra: impl },
      { session: 'Cuatro', status: 'waiting', extra: impl },
      { session: 'Cinco', sid: 'c5', status: 'busy', extra: tests },
      { session: 'Seis', status: null, extra: tests },
      { session: 'Coord', sid: 'co', status: 'idle', extra: impl },
    ]),
    coordinatorSid: 'co',
    sessionFiles: [{ session: 'c5', tool: 'claude', pid: 10 }],
    processes: [{ pid: 11, ppid: 10, comando: 'bash /x/test-gate.sh /repo' }],
    nowMs: NOW,
  });
  const st = (n) => byName(data, n).estado;
  assert.deepStrictEqual(['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis', 'Coord'].map(st), ['trabajando', 'trabajando', 'parada', 'pregunta', 'prueba', 'trabajando', 'coordina']);
  assert.strictEqual(byName(data, 'Tres').parada, 'parada desde las 20:10');
  assert.strictEqual(byName(data, 'Tres').haciendo, 'Va por el paso «Implementar».');
  assert.strictEqual(byName(data, 'Cuatro').espera, 'tu respuesta en su pantalla');
  assert.strictEqual(byName(data, 'Uno').parada, undefined);
  assert.ok(!JSON.stringify(data).includes('input needed'), 'el waitingFor de Claude, en inglés, no se muestra');
  assert.match(page(data), /parada:\["Parada"/, 'la página conoce el estado nuevo');
});

test('T87 Codex_BusyInOffice @story-2.81 @ac-45: Codex dice ocupada o parada igual que Claude', () => {
  const work = { tool: 'codex', pid: null, step: 'Implementar', sentence: 'Va por el paso «Implementar».' };
  const { data } = buildOffice({
    wip: wip([]),
    sessionFiles: [
      sessionFile('c1', { ...work, name: 'Ocupada', busy: true }),
      sessionFile('c2', { ...work, name: 'Parada', busy: false }),
      sessionFile('c3', { ...work, name: 'Vieja', busy: null }),
      sessionFile('c4', { tool: 'codex', pid: null, name: 'SinTrabajo', busy: false }),
      sessionFile('c5', { tool: 'codex', pid: null, name: 'SoloOcupada', busy: true }),
    ],
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Ocupada').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Parada').estado, 'parada');
  assert.match(byName(data, 'Parada').parada, /^parada desde las \d\d:\d\d$/);
  assert.strictEqual(byName(data, 'Vieja').estado, 'trabajando', 'un archivo de antes, como hoy');
  assert.strictEqual(byName(data, 'SinTrabajo').estado, 'libre');
  assert.strictEqual(byName(data, 'SoloOcupada').estado, 'trabajando', 'ocupada sin trabajo declarado también trabaja');
});

test('T119 Codex_BusyStuck_QuietThenInactive @story-2.81 @ac-45: un turno cortado primero dice «sin novedades» y a las 2 h «inactiva»', () => {
  const stuck = (min) => sessionFile('cx', { tool: 'codex', pid: null, name: 'Cortada', step: 'Implementar', sentence: 'Va por el paso «Implementar».', busy: true, updatedAt: atIso(NOW - min * 60000) });
  const at = (min) => byName(buildOffice({ wip: wip([]), sessionFiles: [stuck(min)], nowMs: NOW }).data, 'Cortada');
  assert.strictEqual(at(5).callada, undefined);
  assert.strictEqual(at(20).estado, 'trabajando');
  assert.match(at(20).callada, /^sin novedades desde las \d\d:\d\d$/);
  assert.strictEqual(at(130).estado, 'inactiva');
});

test('T120 Waiting_WinsOverBusy_UnknownStatusAsToday @story-2.81 @ac-44 @ac-46: lo que pide un permiso espera; sin estado legible, por su paso', () => {
  const plan = { kind: 'pipeline', current: 'approve-plan', steps: [{ id: 'approve-plan', name: 'Aprobar el plan', done: false }] };
  const { data } = buildOffice({
    wip: wip([
      { session: 'Pide', sid: 's-pide', status: 'busy', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'SinDato', status: null, extra: plan },
    ]),
    sessionFiles: [sessionFile('s-pide', { name: 'Pide', waitingForOwner: true, waitingFor: 'un permiso' })],
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Pide').estado, 'firma');
  assert.strictEqual(byName(data, 'Pide').espera, 'un permiso');
  assert.strictEqual(byName(data, 'SinDato').estado, 'trabajando');
  assert.strictEqual(byName(data, 'SinDato').espera, undefined);
  assert.deepStrictEqual(data.meta.teToca, [], 'sin saber que está parada, no le toca a nadie');
});

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

test('T88 OwnerSignature_PlanAndSave @story-2.81 @ac-46: lo que espera al dueño es «Tu firma», también en Codex', async () => {
  const { now, w } = await ownerMachine();
  const { data } = buildOffice({ wip: w, nowMs: now, sessionFiles: [sessionFile('cx', { tool: 'codex', pid: null, name: 'Codina', step: 'Aprobar el plan', sentence: 'Va por el paso «Aprobar el plan».', busy: false })] });
  assert.strictEqual(byName(data, 'Plan').estado, 'firma');
  assert.strictEqual(byName(data, 'Plan').espera, 'que apruebes el plan');
  assert.strictEqual(byName(data, 'Guardar').estado, 'firma');
  assert.strictEqual(byName(data, 'Guardar').espera, 'el ok para guardar');
  assert.strictEqual(byName(data, 'Ocupada').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Codina').estado, 'firma');
  assert.strictEqual(byName(data, 'Codina').espera, 'que apruebes el plan');
  const firma = col(data, 'firma').tarjetas.map((t) => t.quien);
  for (const n of ['Plan', 'Guardar', 'Codina']) assert.ok(firma.includes(n), `${n} en «Tu firma»: ${firma}`);
  assert.ok(!firma.includes('Ocupada'));
  assert.ok(data.meta.teToca.some((t) => /Espera el plan/.test(t)), data.meta.teToca.join(' | '));
  assert.ok(data.meta.teToca.some((t) => /Espera guardar/.test(t)), data.meta.teToca.join(' | '));
});

test('T89 Wip_SaveRow_NotFree @story-2.81 @ac-46: en /wip la corrida que espera guardar es una fila, no una sesión libre', async () => {
  const { w } = await ownerMachine();
  const row = w.rows.find((r) => r.session === 'Guardar');
  assert.ok(row, w.text);
  assert.strictEqual(row.state, 'Terminó: espera el ok para guardar');
  assert.match(row.work, /^9\.9 · Espera guardar/);
  assert.ok(!w.free.includes('Guardar'));
  assert.match(w.text, /Terminó: espera el ok para guardar/);
});

test('T121 SaveSignal_DirtyTree_NotSaveOk @story-2.81 @ac-46: la señal de guardar sale del árbol del repo', async () => {
  const closed = async (repoOpts, extra = {}, mutate = () => {}) => {
    const m = toyMachine();
    const repo = toyRepo(m, 'r', repoOpts);
    mutate(repo);
    fs.writeFileSync(path.join(m.state, 'active', 'g.json'), JSON.stringify({ sessionId: 'g', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Espera guardar'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, ...extra }));
    sessionWith(m, 'g', 'Guardar', 'idle', NOW - 20 * 60000);
    const w = await wipNow({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(NOW), home: m.root, queryAll: noPrs });
    return { w, data: buildOffice({ wip: w, nowMs: NOW }).data };
  };
  const dirty = await closed({ dirty: true });
  assert.strictEqual(byName(dirty.data, 'Guardar').estado, 'firma');
  // limpio: no espera ningún ok, y falta cerrarla
  const clean = await closed({ dirty: false });
  assert.strictEqual(byName(clean.data, 'Guardar').estado, 'cerrar');
  assert.ok(clean.w.rows.every((r) => /^terminado, falta cerrar/.test(r.state)), clean.w.text);
  // sólo la carpeta de la corrida sin commitear: no es trabajo sin guardar
  const onlyRun = await closed({ dirty: false }, {}, (repo) => { fs.mkdirSync(path.join(repo, '.advisors', 'pipeline-runs'), { recursive: true }); fs.writeFileSync(path.join(repo, '.advisors', 'pipeline-runs', 'x.md'), 'x'); });
  assert.strictEqual(byName(onlyRun.data, 'Guardar').estado, 'cerrar', onlyRun.w.text);
  // con el ok ya dado, sigue trabajando
  const ok = await closed({ dirty: true }, { saveOk: { storyId: '9.9' } });
  assert.strictEqual(byName(ok.data, 'Guardar').estado, 'trabajando');
  assert.strictEqual(byName(ok.data, 'Guardar').espera, undefined);
  // un repo que no se puede leer no dice que espera, y se dice por qué
  const broken = await closed({ dirty: true }, {}, (repo) => fs.rmSync(path.join(repo, '.git', 'objects'), { recursive: true, force: true }));
  assert.notStrictEqual(byName(broken.data, 'Guardar').estado, 'firma');
  assert.ok(broken.data.unreadable.some((u) => /no se pudo leer|git/.test(u) && /9\.9|r\b/.test(u)), broken.data.unreadable.join(' | '));
});

test('T90 Meanwhile_OnlyRecentAndAfterStart @story-2.81 @ac-47: el «mientras tanto» es de ahora; /wip sigue mostrando los tres', async () => {
  const m = toyMachine();
  const steps = BEFORE_PLAN;
  const when = (min) => atIso(NOW - min * 60000);
  runMarkerFile(m, 'a', '9.1', 'Vieja', steps, { startedAt: when(210), lastTouch: when(1) });
  fs.writeFileSync(path.join(m.state, 'adhoc', 'a.json'), JSON.stringify({ reason: 'carril de otra cosa', declaredAt: when(150), lastTouch: when(150) }));
  runMarkerFile(m, 'b', '9.2', 'Anterior', steps, { startedAt: when(20), lastTouch: when(1) });
  fs.writeFileSync(path.join(m.state, 'doing', 'b.json'), JSON.stringify({ text: 'nota de antes del arranque', at: when(30) }));
  runMarkerFile(m, 'c', '9.3', 'Reciente', steps, { startedAt: when(210), lastTouch: when(1) });
  fs.writeFileSync(path.join(m.state, 'doing', 'c.json'), JSON.stringify({ text: 'nota de hace poco', at: when(10) }));
  sessionWith(m, 'a', 'A', 'busy'); sessionWith(m, 'b', 'B', 'busy'); sessionWith(m, 'c', 'C', 'busy');
  const w = await wipNow({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(NOW), home: m.root });
  const { data } = buildOffice({ wip: w, nowMs: NOW });
  assert.strictEqual(byName(data, 'A').mientras, undefined);
  assert.strictEqual(byName(data, 'B').mientras, undefined);
  assert.strictEqual(byName(data, 'C').mientras, 'nota de hace poco');
  const said = (s) => w.rows.find((r) => r.session === s).meanwhile;
  assert.match(said('A'), /carril de otra cosa.*sin tocar desde/);
  assert.match(said('B'), /nota de antes del arranque/);
  assert.match(said('C'), /nota de hace poco/);
});

test('T91 ClosedRun_DoesNotOwnNewWork @story-2.81 @ac-48: la corrida cerrada no se queda con la tarjeta del trabajo nuevo', async () => {
  const m = toyMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'cerrada');
  const closure = { sessionId: 's', storyId: '9.9', storyPath: storyFile(m, '9.9', 'La historia cerrada'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, startedAt: atIso(now - 3 * 3600000), estimate_min: 60, lastTouch: atIso(now - 90 * 60000), stepTimings: { 'prepare-commit': { completedAt: atIso(now - 90 * 60000) } } };
  fs.writeFileSync(path.join(m.state, 'timing-history', 'h.json'), JSON.stringify({ archivedAt: atIso(now - 90 * 60000), marker: closure }));
  sessionWith(m, 's', 'Sigue', 'busy', now);
  const queue = async (qs) => qs.map(() => ({ prs: [{ number: 5, draft: false, conflict: false, offQueue: false }] }));
  // sin carril ni nota, como hoy
  let w = await wipNow({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(now), home: m.root, queryAll: queue });
  let a = byName(buildOffice({ wip: w, nowMs: now }).data, 'Sigue');
  assert.strictEqual(a.estado, 'espera');
  assert.strictEqual(a.titulo, 'La historia cerrada');
  // con un carril declarado después, la tarjeta es el carril
  fs.writeFileSync(path.join(m.state, 'adhoc', 's.json'), JSON.stringify({ reason: 'Arreglo el aviso del pedido', declaredAt: atIso(now - 30 * 60000), lastTouch: atIso(now - 30 * 60000) }));
  w = await wipNow({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(now), home: m.root, queryAll: queue });
  const { data } = buildOffice({ wip: w, nowMs: now });
  a = byName(data, 'Sigue');
  assert.strictEqual(a.estado, 'trabajando');
  assert.strictEqual(a.haciendo, 'Arreglo el aviso del pedido');
  assert.strictEqual(a.titulo, 'Arreglo el aviso del pedido');
  assert.strictEqual(a.termina, 'sin hora estimada');
  for (const k of ['avance', 'pasos', 'pronosticoIso', 'atrasoMin']) assert.strictEqual(a[k], undefined, k);
  assert.ok(col(data, 'entrando').tarjetas.some((t) => t.titulo === 'La historia cerrada' && t.quien === 'Sigue'), JSON.stringify(col(data, 'entrando')));
  assert.ok(col(data, 'curso').tarjetas.some((t) => t.titulo === 'Arreglo el aviso del pedido' && t.quien === 'Sigue'));
  // /wip sigue como hoy: la corrida, con su «mientras tanto»
  assert.match(w.rows[0].meanwhile, /Arreglo el aviso del pedido/);
});

test('T92 NotePromise_PerDeclaration @story-2.81 @ac-49: una nota nueva con el mismo texto empieza una promesa nueva', () => {
  const note = (declaredAt, endAt) => ({ session: 'Nota', extra: { kind: 'note', text: 'Ordeno las pruebas', endAt, hourAt: declaredAt, promiseAt: declaredAt } });
  const first = buildOffice({ wip: wip([note(NOW - 2 * 3600000, NOW - 3600000)]), nowMs: NOW - 90 * 60000 });
  const { data } = buildOffice({ wip: wip([note(NOW - 30 * 60000, NOW + 30 * 60000)]), promises: first.promises, nowMs: NOW });
  assert.deepStrictEqual([byName(data, 'Nota').fin.dif, byName(data, 'Nota').fin.cls], ['en hora', 'ontime']);
});

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

test('T93 Kanban_FiveColumns_FromRealStateAndBoard @story-2.81 @ac-50: cinco columnas, del estado real y del tablero', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Ana', status: 'busy', work: '9.1 · Una', extra: { kind: 'pipeline', title: 'Una', storyId: '9.1', current: 'implement', endAt: NOW + 3600000 } },
      { session: 'Eva', status: 'idle', work: '9.2 · Dos', extra: { kind: 'pipeline', title: 'Dos', storyId: '9.2', current: 'implement' } },
      { session: 'Pepa', status: 'idle', work: '9.3 · Tres', extra: { kind: 'pipeline', title: 'Tres', storyId: '9.3', current: 'approve-plan' } },
      { session: 'Lia', status: 'busy', work: '9.4 · Cuatro', extra: { kind: 'entering', title: 'Cuatro', storyId: '9.4', endAt: NOW + 3600000 } },
    ], { free: ['Mimi'], halfwayItems: [{ kind: 'adhoc', text: 'un arreglo que quedó', cleanAfter: null, sid: 'x' }] }),
    signatures: [{ id: 'f1', title: 'la primera firma', at: NOW }, { id: 'f2', title: 'la segunda firma', at: NOW }],
    board: buildBoard(KANBAN_BOARD),
    nowMs: NOW,
  });
  assert.deepStrictEqual(data.kanban.columnas.map((c) => c.nombre), ['Sin sesión', 'En curso', 'Tu firma', 'Esperan entrar', 'Terminados']);
  assert.deepStrictEqual(titles(data, 'firma').sort(), ['Firma: la primera firma', 'Firma: la segunda firma', 'Tres'].sort());
  assert.deepStrictEqual(titles(data, 'curso').sort(), ['Dos', 'Una'].sort());
  assert.deepStrictEqual(titles(data, 'entrando'), ['Cuatro']);
  // la fila de Ana ya no se esconde detrás de su tarjeta: Ana no dice su número, así que va a «Sin sesión» (8.198, AC 8)
  assert.deepStrictEqual(titles(data, 'sinEmpezar').sort(), ['Lo de alguien sin sesión', 'Lo de la persona con sesión', 'Sin arrancar', 'Espera turno'].sort(), 'lo que nadie vivo hace va acá');
  assert.deepStrictEqual(titles(data, 'hechos').sort(), ['Hecho dos', 'Hecho uno']);
  assert.deepStrictEqual(data.kanban.medioCamino, [], 'sin nada sin terminar en sus carpetas, no queda a medio camino');
  for (const c of data.kanban.columnas) for (const t of c.tarjetas) assert.ok('titulo' in t && 'quien' in t && 'hora' in t, JSON.stringify(t));
  const una = col(data, 'curso').tarjetas.find((t) => t.titulo === 'Una');
  assert.strictEqual(una.quien, 'Ana');
  assert.ok(una.hora);
  assert.ok(!JSON.stringify(data.kanban).includes('9.1'), 'sin números de historia');
  // el panel de la pared cuenta lo mismo
  assert.match(page(data), /function drawPanel\(\)\{[^\n]*kanban/);
});

test('T124 Board_Riesgo_WholeWordName @story-2.81 @ac-50: «riesgo» sin una sesión viva conserva su marca; «Ana» no es «Ananda»', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Ana', status: 'busy', extra: { kind: 'loose', text: 'el arreglo de Ana' } }]),
    board: buildBoard({ pendientes: [{ titulo: 'Lo de Ananda', estado: 'curso', quien: 'Ananda' }, { titulo: 'Puede fallar', estado: 'riesgo', quien: 'Rita' }, { titulo: 'En la cola', estado: 'entrando', quien: 'Rita' }] }),
    nowMs: NOW,
  });
  const riesgo = col(data, 'sinEmpezar').tarjetas.find((t) => t.titulo === 'Puede fallar');
  assert.strictEqual(riesgo.marca, 'riesgo');
  assert.ok(titles(data, 'sinEmpezar').includes('Lo de Ananda'), 'la fila de Ananda queda en el kanban');
  assert.deepStrictEqual(titles(data, 'entrando'), ['En la cola']);
});

test('T94 Kanban_NoBoard_StillColumns @story-2.81 @ac-50: sin tablero, el kanban sale igual', async () => {
  const data = await collectWith(null);
  assert.deepStrictEqual(data.kanban.columnas.map((c) => c.tarjetas.length), [0, 0, 0, 0, 0]);
  assert.strictEqual(data.kanban.medioCamino.length, 0);
  assert.strictEqual(data.tablero, null);
  assert.ok(!data.unreadable.some((u) => /tablero/.test(u)), data.unreadable.join(' | '));
});

test('T95 Kanban_Page_TextOnly_WallSameColumns @story-2.81 @ac-50: la página dibuja las cinco columnas como texto', () => {
  const data = { agents: [], items: [], meta: { teToca: [], actualizado: '10:00' }, rows: [], free: [], unreadable: [], tablero: null, kanban: {
    columnas: [
      { id: 'firma', nombre: 'Tu firma', tarjetas: [{ titulo: '<b>no es html</b>', quien: 'Ana', hora: 'dom 10:00', espera: 'el ok para guardar' }] },
      { id: 'curso', nombre: 'En curso', tarjetas: [{ titulo: 'Una', quien: 'Eva', hora: 'sin hora estimada', marca: 'En fila para pruebas', nota: 'Lo de hoy' }, { titulo: 'Dos', quien: 'Lia', hora: '', motivo: 'en borrador' }] },
      { id: 'entrando', nombre: 'Esperan entrar', tarjetas: [] },
      { id: 'sinEmpezar', nombre: 'Sin empezar', tarjetas: [] },
      { id: 'hechos', nombre: 'Hechos', tarjetas: [] },
    ],
    medioCamino: [{ titulo: 'Lo que quedó', quien: '—', accion: 'Abrí una sesión en esa carpeta' }],
  } };
  const { fn, body, sec } = drawKanban(data);
  assert.strictEqual(sec.hidden, false);
  assert.ok(!/innerHTML/.test(fn), 'se escribe con textContent');
  const cols = all(body, (n) => /\bcol\b/.test(n.className));
  assert.deepStrictEqual(cols.map((c) => textOf(c.children[0])), ['Tu firma · 1', 'En curso · 2', 'Esperan entrar · 0', 'Sin empezar · 0', 'Hechos · 0']);
  assert.match(textOf(cols[2]), /Nada/);
  assert.match(textOf(cols[0]), /<b>no es html<\/b>/);
  assert.match(textOf(cols[0]), /el ok para guardar/);
  assert.match(textOf(cols[1]), /En fila para pruebas/);
  assert.match(textOf(cols[1]), /en borrador/);
  assert.match(textOf(cols[1]), /Lo de hoy/);
  assert.doesNotMatch(textOf(body), /Lo que quedó/, 'a medio camino va aparte, en las dos vistas');
  const html = page(data);
  assert.ok(!/const GROUPS=\[\["riesgo"/.test(html), 'el panel de la pared no cuenta otras columnas');
  assert.match(html, /function abrirTablero\(\)\{[^\n]*kanban/);
});

test('T97 Regression_ChangedOnPurpose @story-2.81 @ac-52: las salidas de antes siguen, y las suites vecinas siguen verdes', { timeout: 600000 }, () => {
  const { home } = toyHome();
  const at = new Date(NOW).toISOString();
  const data = JSON.parse(run(home, ['--json', '--now', at]));
  assert.ok(Array.isArray(data.agents) && data.kanban && data.meta);
  const out = path.join(home, 'foto.html');
  assert.match(run(home, ['--out', out, '--now', at]), /La oficina está en/);
  assert.ok(!fs.existsSync(path.join(stateDir(home), 'office', 'server.json')), 'la foto fija no arranca ningún proceso');
  const r = spawnSync(process.execPath, ['--test', path.join(__dirname, 'work-in-progress.test.js')], { encoding: 'utf8', env: { ...process.env, TYCON_SESSION_STATE: '0' } });
  assert.strictEqual(r.status, 0, `work-in-progress.test.js: ${r.stdout.slice(-2000)}`);
});

test('T99 Office_NoPipeline_ShowsTheThree @story-2.81 @ac-53 @ac-54: sin pipeline, lo que dice su conversación', () => {
  const said = { encargo: 'Ordená las pruebas', haciendoAhora: 'Sigo con el kanban.', ultimaAccion: 'Editar · office.js · hace 4 min', lastWriteMs: NOW - 240000 };
  const { data } = buildOffice({
    wip: wip([
      { session: 'Suelta', sid: 'a', extra: { kind: 'activity' } },
      { session: 'Nota', sid: 'b', extra: { kind: 'note', text: 'mido el disco' } },
      { session: 'Corre', sid: 'c', extra: { kind: 'pipeline', current: 'implement', steps: STEPS, title: 'Su historia' } },
      { session: 'Muda', sid: 'd', extra: { kind: 'activity', lastAt: NOW - 600000 } },
    ]),
    transcripts: new Map([['a', said], ['b', said], ['c', said], ['d', { encargo: null, haciendoAhora: null, ultimaAccion: null, lastWriteMs: null }]]),
    nowMs: NOW,
  });
  const a = byName(data, 'Suelta');
  assert.strictEqual(a.haciendo, 'Sigo con el kanban.');
  assert.strictEqual(a.titulo, null, 'el encargo son instrucciones de quien la abrió: no es su título');
  assert.strictEqual(a.encargo, 'Ordená las pruebas');
  assert.strictEqual(col(data, 'curso').tarjetas.find((t) => t.quien === 'Suelta').titulo, 'Sigo con el kanban.', 'la tarjeta dice su último mensaje');
  assert.strictEqual(a.haciendoAhora, 'Sigo con el kanban.');
  assert.strictEqual(a.ultimaAccion, 'Editar · office.js · hace 4 min');
  const b = byName(data, 'Nota');
  assert.strictEqual(b.titulo, 'mido el disco');
  assert.strictEqual(b.haciendoAhora, undefined, 'lo anotado le gana a lo que se deduce de su último mensaje');
  assert.strictEqual(b.haciendo, 'mido el disco');
  assert.strictEqual(b.encargo, 'Ordená las pruebas');
  const c = byName(data, 'Corre');
  assert.strictEqual(c.titulo, 'Su historia');
  assert.strictEqual(c.encargo, undefined, 'con corrida abierta no cambia');
  assert.strictEqual(c.haciendo, 'Va por el paso «Implementar».');
  assert.strictEqual(byName(data, 'Muda').haciendo, `Sin novedades desde las ${hm(NOW - 600000)}`);
  const html = page(data);
  for (const label of ['Encargo', 'Haciendo ahora', 'Última acción']) assert.match(html, new RegExp(label), `la página lo nombra: ${label}`);
  const crew = html.slice(html.indexOf('function renderCrew()'), html.indexOf('// sin 3D, la tabla queda abierta'));
  assert.ok(crew.includes('Haciendo ahora') && !/innerHTML/.test(crew), 'como texto');
});

test('T103 NewWorkOnTop_OldRunPaused @story-2.81 @ac-56: el trabajo nuevo arriba y la corrida vieja debajo, sin hora', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Dos', work: '9.1 · La vieja', extra: { kind: 'pipeline', storyId: '9.1', title: 'La vieja', current: 'implement', steps: STEPS, progress: 50, activityAt: NOW - 3.5 * 3600000, endAt: NOW + 3600000, hourAt: NOW - 3.5 * 3600000, meanwhile: 'el arreglo rápido de ahora', meanwhileAt: NOW - 10 * 60000, meanwhileKind: 'loose', runStartedAt: NOW - 5 * 3600000 } }]),
    nowMs: NOW,
  });
  const a = byName(data, 'Dos');
  assert.strictEqual(a.haciendo, 'el arreglo rápido de ahora');
  assert.strictEqual(a.titulo, 'el arreglo rápido de ahora');
  assert.strictEqual(a.enPausa, 'La vieja');
  assert.strictEqual(a.mientras, undefined);
  assert.strictEqual(a.termina, 'sin hora estimada');
  for (const k of ['pasos', 'avance', 'pronosticoIso']) assert.strictEqual(a[k], undefined, k);
  assert.match(page(data), /En pausa/);
});

const hourRun = (fields) => ({ kind: 'pipeline', storyId: '9.1', title: 'Una', current: 'implement', steps: STEPS, ...fields });

test('T104 ExpiredEnd_NoActivity_WorkChanged @story-2.81 @ac-56: vencida y sin actividad, el trabajo cambió', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Quieta', extra: hourRun({ endAt: NOW - 3.5 * 3600000, hourAt: NOW - 4.5 * 3600000, activityAt: NOW - 4 * 3600000 }) }]), nowMs: NOW });
  const a = byName(data, 'Quieta');
  assert.deepStrictEqual(a.fin, { hora: 'sin hora: el trabajo cambió', dif: '', cls: '' });
  for (const k of ['atrasoMin', 'atrasada', 'pronosticoIso']) assert.strictEqual(a[k], undefined, k);
});

test('T105 Hour_StableBetweenPhotos @story-2.81 @ac-57: dos fotos del mismo paso dicen la misma hora, aunque cambien las medianas', () => {
  const m = toyMachine();
  const h = (implement) => fs.writeFileSync(path.join(m.state, 'timing-history', 'h.json'), JSON.stringify({ archivedAt: atIso(NOW - 86400000), marker: { startedAt: atIso(NOW - 2 * 86400000), stepTimings: { implement: { startedAt: atIso(NOW - 2 * 86400000), completedAt: atIso(NOW - 2 * 86400000 + implement * 60000) } } } }));
  const at = NOW + 2 * 3600000;
  runMarkerFile(m, 's', '9.1', 'Una', BEFORE_PLAN.concat('approve-plan'), { startedAt: atIso(NOW - 3600000), lastTouch: atIso(NOW - 60000), horaDelPaso: { step: 'implement', at: atIso(at), computedAt: atIso(NOW - 60000) } });
  sessionWith(m, 's', 'Una', 'busy');
  const see = () => { const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(NOW), home: m.root }); return [w, byName(buildOffice({ wip: w, nowMs: NOW }).data, 'Una')]; };
  h(30);
  const [w1, a1] = see();
  h(500);
  const [w2, a2] = see();
  assert.strictEqual(a1.fin.hora, a2.fin.hora);
  assert.strictEqual(a1.pronosticoIso.slice(11), hm(at));
  assert.match(w1.rows[0].end, new RegExp(hm(at)));
  assert.strictEqual(w1.rows[0].end, w2.rows[0].end);
  // un marcador con la hora de otro paso calcula como hoy
  runMarkerFile(m, 'o', '9.2', 'Otra', BEFORE_PLAN.concat('approve-plan'), { lastTouch: atIso(NOW - 60000), horaDelPaso: { step: 'plan', at: atIso(at), computedAt: atIso(NOW - 60000) } });
  sessionWith(m, 'o', 'Otra', 'busy');
  const other = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(NOW), home: m.root }).extra.find((x) => x.storyId === '9.2');
  assert.strictEqual(other.hourStep, undefined);
});

test('T106 Hour_RecalculatedOnStep_SaysWhy @story-2.81 @ac-57: al pasar de paso dice por qué cambió, y el atraso se mide contra lo prometido', () => {
  const m = toyMachine();
  const at = NOW - 15 * 60000;
  runMarkerFile(m, 's', '9.1', 'Una', BEFORE_PLAN.concat('approve-plan', 'implement'), { startedAt: atIso(NOW - 5 * 3600000), estimate_min: 60, lastTouch: atIso(NOW - 60000), horaDelPaso: { step: 'run-tests', at: atIso(at), computedAt: atIso(NOW - 30 * 60000) } });
  sessionWith(m, 's', 'Una', 'busy');
  const { data } = buildOffice({ wip: buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(NOW), home: m.root }), nowMs: NOW });
  const a = byName(data, 'Una');
  assert.strictEqual(a.atrasoMin, 240, 'contra la promesa, no contra la hora del paso');
  assert.deepStrictEqual([a.fin.hora, a.fin.cls], ['se pasó de la hora', 'late']);
  assert.match(a.fin.dif, /^sin novedades desde las \d\d:\d\d$/);
  assert.strictEqual(a.estimadaIso.slice(11), hm(NOW - 4 * 3600000), '«Prometido» sigue siendo la promesa del arranque');
  assert.match(page(data), /Prometido/);
});

test('T107 Hour_Old_Passed @story-2.81 @ac-58: una hora calculada hace rato que ya pasó dice que se pasó', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Vieja', extra: hourRun({ endAt: NOW - 30 * 60000, hourAt: NOW - 3.5 * 3600000, activityAt: NOW - 30 * 60000 }) },
      { session: 'Reciente', extra: hourRun({ endAt: NOW - 15 * 60000, hourAt: NOW - 30 * 60000, activityAt: NOW - 30 * 60000 }) },
      { session: 'Carril', extra: { kind: 'loose', text: 'un arreglo', endAt: NOW - 2 * 3600000, hourAt: NOW - 3.5 * 3600000 } },
    ]),
    nowMs: NOW,
  });
  const v = byName(data, 'Vieja');
  assert.deepStrictEqual(v.fin, { hora: 'se pasó de la hora', dif: `sin novedades desde las ${hm(NOW - 30 * 60000)}`, cls: 'late' });
  assert.strictEqual(byName(data, 'Reciente').atrasoMin, 15);
  assert.strictEqual(byName(data, 'Reciente').fin.cls, 'late');
  assert.deepStrictEqual(byName(data, 'Carril').fin, { hora: 'se pasó de la hora', dif: '', cls: 'late' });
});

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

test('T108 Park_Until_ShownAndExpired @story-2.81 @ac-59: «En pausa hasta», «venció», igual sin marca, y de vuelta su paso', async () => {
  const m = parkMachine();
  const now = Date.now();
  const until = now + 2 * 86400000;
  runMarkerFile(m, 's', '2.81', 'La tanda', BEFORE_PLAN.concat('approve-plan'), { startedAt: atIso(now - 3600000), lastTouch: atIso(now - 60000) });
  sessionWith(m, 's', 'Viva', 'busy', now);
  assert.strictEqual(runMarker(m.home, 'otra', ['park', '2.81', '--until', ymd(until)]), 0);
  let data = await collectAt(m, now);
  let w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  let a = byName(data, 'Viva');
  assert.strictEqual(a.marca, `En pausa hasta el ${ddmm(until)}`);
  assert.strictEqual(a.haciendo, `En pausa hasta el ${ddmm(until)}`);
  for (const k of ['pronosticoIso', 'atrasoMin', 'atrasada']) assert.strictEqual(a[k], undefined, k);
  assert.strictEqual(a.fin.hora, `En pausa hasta el ${ddmm(until)}`);
  assert.match(w.text, new RegExp(`En pausa hasta el ${ddmm(until)}`));
  // pasada la fecha, venció, sin limpiar (y sigue viéndose aunque el marcador tenga más de un día)
  const later = until + 86400000;
  fs.rmSync(path.join(m.sessions, 's.json'));
  data = await collectAt(m, later);
  w = await wipNow({ home: m.home, now: atIso(later), queryAll: noPrs });
  const it = data.items.find((i) => i.titulo === 'La tanda');
  assert.strictEqual(it.marca, `En pausa: venció el ${ddmm(until)}`);
  assert.ok(!JSON.stringify(it).includes('limpiar'), JSON.stringify(it));
  assert.match(w.text, /venció/);
  assert.doesNotMatch(w.text, /limpiar/);
  // sacar la marca: vuelve su paso
  sessionWith(m, 's', 'Viva', 'busy', now);
  assert.strictEqual(runMarker(m.home, 'otra', ['unpark', '2.81']), 0);
  data = await collectAt(m, now);
  a = byName(data, 'Viva');
  assert.strictEqual(a.marca, undefined);
  assert.strictEqual(a.haciendo, 'Va por el paso «Implementar».');
  // sin marca, con `paused_until:` en la historia, dice lo mismo
  const story = path.join(m.root, 'story-2.82.md');
  fs.writeFileSync(story, `---\nstory: "2.82"\ntitle: "La pausada"\npaused_until: ${ymd(until)}\n---\n# Story\n`);
  fs.writeFileSync(path.join(m.state, 'active', 'p.json'), JSON.stringify({ sessionId: 'p', storyId: '2.82', storyPath: story, stepScheme: STEP_LIB.SCHEME, stepsCompleted: BEFORE_PLAN, stepsPending: IDS.filter((s) => !BEFORE_PLAN.includes(s)), lastTouch: atIso(now - 60000) }));
  sessionWith(m, 'p', 'Pausada', 'busy', now);
  data = await collectAt(m, now);
  assert.strictEqual(byName(data, 'Pausada').marca, `En pausa hasta el ${ddmm(until)}`);
  data = await collectAt(m, later);
  assert.ok(data.items.some((i) => i.marca === `En pausa: venció el ${ddmm(until)}`), JSON.stringify(data.items));
});

test('T109 Park_Queue_NeverClean @story-2.81 @ac-60: la corrida en fila nunca dice «limpiar»; la que no está marcada, como hoy', async () => {
  const m = parkMachine();
  const now = Date.now();
  runMarkerFile(m, 'fila', '8.176', 'En la fila', BEFORE_PLAN.concat('approve-plan'), { lastTouch: atIso(now - 60000) });
  runMarkerFile(m, 'suelta', '8.177', 'Sin marca', BEFORE_PLAN.concat('approve-plan'), { lastTouch: atIso(now - 60000) });
  assert.strictEqual(runMarker(m.home, 'otra', ['park', '8.176', '--queue']), 0);
  const data = await collectAt(m, now);
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  const card = col(data, 'sinEmpezar').tarjetas.find((t) => t.titulo === 'En la fila');
  assert.strictEqual(card.marca, 'En fila para pruebas');
  assert.strictEqual(card.quien, '', 'el id de una sesión cerrada no se muestra');
  assert.ok(!titles(data, 'curso').includes('En la fila'), 'sin una sesión viva no está en curso');
  assert.ok(!JSON.stringify(card).includes('limpiar'));
  assert.ok(!data.kanban.medioCamino.some((x) => x.titulo === 'En la fila'), 'no queda a medio camino');
  assert.ok(!data.kanban.medioCamino.some((x) => x.titulo === 'Sin marca'), 'sin nada sin terminar en una carpeta, tampoco');
  assert.match(w.halfway.find((h) => /8\.176/.test(h)), /En fila para pruebas/);
  assert.doesNotMatch(w.halfway.find((h) => /8\.176/.test(h)), /limpiar/);
  assert.match(w.halfway.find((h) => /8\.177/.test(h)), /limpiar: node/);
});

test('T111 OwnerColumn_CountsClosedSessions @story-2.81 @ac-61: «Tu firma» cuenta también a las sesiones cerradas', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'sin-guardar', { dirty: true });
  runMarkerFile(m, 'p1', '9.1', 'Plan uno', BEFORE_PLAN, { lastTouch: atIso(now - 60000) });
  runMarkerFile(m, 'p2', '9.2', 'Plan dos', BEFORE_PLAN, { lastTouch: atIso(now - 60000) });
  fs.writeFileSync(path.join(m.state, 'active', 'g1.json'), JSON.stringify({ sessionId: 'g1', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Guardar uno'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, lastTouch: atIso(now - 60000) }));
  runMarkerFile(m, 'o1', '9.3', 'Otro paso', BEFORE_PLAN.concat('approve-plan'), { lastTouch: atIso(now - 60000) });
  assert.strictEqual(runMarker(m.home, 'otra', ['park', '9.2', '--queue']), 0);
  const data = await collectAt(m, now);
  const firma = titles(data, 'firma');
  for (const t of ['Plan uno', 'Plan dos', 'Guardar uno']) assert.ok(firma.includes(t), `${t}: ${firma}`);
  assert.ok(!firma.includes('Otro paso'));
  assert.strictEqual(data.meta.teToca.length, 3, data.meta.teToca.join(' | '));
  assert.ok(col(data, 'firma').tarjetas.every((t) => t.quien && t.quien !== '—'), 'con el nombre de la sesión');
  const marked = col(data, 'firma').tarjetas.find((t) => t.titulo === 'Plan dos');
  assert.strictEqual(marked.marca, 'En fila para pruebas', 'la marcada conserva su texto');
  assert.ok(!data.kanban.medioCamino.some((x) => firma.includes(x.titulo)), 'y no se repite a medio camino');
  assert.ok(!titles(data, 'firma').includes('Otro paso'));
});

test('T112 OfficeAndWip_SayTheSame @story-2.81 @ac-62: /office y /wip dicen lo mismo de cada sesión', async () => {
  const m = parkMachine();
  const now = Date.now();
  const at = (min) => atIso(now - min * 60000);
  const repo = toyRepo(m, 'con-cambios', { dirty: true });
  const mk = (sid, id, title, done, name, status, extra = {}) => { runMarkerFile(m, sid, id, title, done, { startedAt: at(300), lastTouch: at(1), ...extra }); if (name) sessionWith(m, sid, name, status, now - 600000); };
  const next = BEFORE_PLAN.concat('approve-plan');
  mk('a', '9.1', 'Parada', next, 'Ana', 'idle');
  mk('b', '9.2', 'Pide', next, 'Bea', 'waiting_for_permission');
  mk('c', '9.3', 'Plan', BEFORE_PLAN, 'Cata', 'idle');
  fs.writeFileSync(path.join(m.state, 'active', 'd.json'), JSON.stringify({ sessionId: 'd', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Guardar'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, lastTouch: at(1) }));
  sessionWith(m, 'd', 'Dora', 'idle', now - 600000);
  mk('e', '9.4', 'Sin cambios', next, 'Eva', 'busy', { lastTouch: at(240), horaDelPaso: { step: 'implement', at: at(210), computedAt: at(270) } });
  mk('f', '9.5', 'Vieja', next, 'Fani', 'busy', { lastTouch: at(30), horaDelPaso: { step: 'implement', at: at(100), computedAt: at(200) } });
  mk('g', '9.6', 'Pausada', next, 'Gina', 'busy');
  mk('h', '9.7', 'Fila', next, null, null);
  assert.strictEqual(runMarker(m.home, 'otra', ['park', '9.6', '--until', ymd(now + 2 * 86400000)]), 0);
  assert.strictEqual(runMarker(m.home, 'otra', ['park', '9.7', '--queue']), 0);
  const data = await collectAt(m, now);
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  const line = (name) => w.text.split('\n').find((l) => l.includes(`| ${name} |`)) || '';
  assert.strictEqual(byName(data, 'Ana').estado, 'parada');
  assert.match(line('Ana'), new RegExp(byName(data, 'Ana').parada));
  assert.strictEqual(byName(data, 'Bea').estado, 'firma');
  assert.match(line('Bea'), new RegExp(`Tu firma: ${byName(data, 'Bea').espera}`));
  assert.strictEqual(byName(data, 'Cata').espera, 'que apruebes el plan');
  assert.match(line('Cata'), /Tu firma: que apruebes el plan/);
  assert.strictEqual(byName(data, 'Dora').espera, 'el ok para guardar');
  assert.match(line('Dora'), /Terminó: espera el ok para guardar/);
  assert.strictEqual(byName(data, 'Eva').fin.hora, 'sin hora: el trabajo cambió');
  assert.match(line('Eva'), /sin hora: el trabajo cambió/);
  assert.strictEqual(byName(data, 'Fani').fin.hora, 'se pasó de la hora');
  assert.match(line('Fani'), /se pasó de la hora/);
  assert.strictEqual(byName(data, 'Gina').marca, `En pausa hasta el ${ddmm(now + 2 * 86400000)}`);
  assert.match(line('Gina'), new RegExp(byName(data, 'Gina').marca));
  assert.doesNotMatch(line('Gina'), /limpiar/);
  const fila = data.items.find((i) => i.titulo === 'Fila');
  assert.strictEqual(fila.marca, 'En fila para pruebas');
  assert.match(w.text, /En fila para pruebas/);
  assert.doesNotMatch(w.halfway.find((h) => /9\.7/.test(h)), /limpiar/);
});

test('T113 Desks_WorkersFirst_StablePlaces @story-2.81 @ac-63: con más de 10 sesiones, los escritorios son para las que trabajan', () => {
  const work = { kind: 'pipeline', current: 'implement', steps: STEPS };
  const entries = (over = {}) => [
    { session: 'Zoe', sid: 'co', status: 'idle', extra: work },
    ...['Omar', 'Pia', 'Quim', 'Rosa'].map((session) => ({ session, status: over[session] || 'busy', extra: work })),
    ...['Vero', 'Walter'].map((session) => ({ session, status: 'waiting', extra: work })),
    ...['Tita', 'Ulises'].map((session) => ({ session, status: 'idle', extra: work })),
  ];
  const free = ['Ada', 'Bruno', 'Celia', 'Dani'];
  const build = (over) => buildOffice({ wip: wip(entries(over), { free }), coordinatorSid: 'co', nowMs: NOW }).data;
  const data = build();
  assert.deepStrictEqual(data.agents.slice(0, 10).map((a) => a.nombre), ['Zoe', 'Ada', 'Omar', 'Pia', 'Quim', 'Rosa', 'Tita', 'Ulises', 'Vero', 'Walter']);
  assert.deepStrictEqual(data.agents.slice(10).map((a) => a.nombre), ['Bruno', 'Celia', 'Dani']);
  assert.strictEqual(data.meta.extra, 3);
  assert.strictEqual(data.meta.puestos.length, 10);
  // una que pasa de ocupada a parada no mueve a nadie
  assert.deepStrictEqual(build({ Pia: 'idle' }).agents.map((a) => a.nombre), data.agents.map((a) => a.nombre));
  // con 10 o menos, el orden de hoy
  const few = buildOffice({ wip: wip(entries().slice(0, 9), { free: ['Ada'] }), coordinatorSid: 'co', nowMs: NOW }).data;
  assert.deepStrictEqual(few.agents.map((a) => a.nombre), ['Zoe', 'Ada', 'Omar', 'Pia', 'Quim', 'Rosa', 'Tita', 'Ulises', 'Vero', 'Walter']);
});

test('T114 Board_RowWithStory_RunDecides @story-2.81 @ac-64: con corrida, la fila aporta la nota y manda la corrida', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Eva', status: 'idle', extra: { kind: 'pipeline', storyId: '2.81', title: 'La tanda', current: 'implement', steps: STEPS, endAt: NOW + 3600000 } }]),
    board: buildBoard({ pendientes: [{ titulo: 'Lo de la 2.81', historia: '2.81', estado: 'hecho', nota: 'Lo de hoy' }, { titulo: 'Suelta', estado: 'curso' }] }),
    nowMs: NOW,
  });
  assert.deepStrictEqual(titles(data, 'curso'), ['La tanda']);
  assert.deepStrictEqual(titles(data, 'sinEmpezar'), ['Suelta']);
  assert.deepStrictEqual(titles(data, 'hechos'), []);
  const card = col(data, 'curso').tarjetas.find((t) => t.titulo === 'La tanda');
  assert.strictEqual(card.nota, 'Lo de hoy');
  assert.ok(card.hora && card.hora !== 'sin hora estimada');
});

test('T123 Board_StoryWithoutRun_StoryAndPr @story-2.81 @ac-64: sin corrida, la columna del archivo o la del pedido; con corrida, no se consulta', async () => {
  const asked = [];
  const queryPrs = async (qs) => qs.map((q) => { asked.push(q.numero); return { pr: { state: 'merged', mergedAt: atIso(NOW - 3600000) } }; });
  const m = toyMachine();
  fs.mkdirSync(path.join(m.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'coordination', 'tablero.json'), JSON.stringify({ pendientes: [
    { titulo: 'Sin corrida ni pedido', historia: '7.1', estado: 'sin-empezar' },
    { titulo: 'Sin corrida con pedido', historia: '7.2', estado: 'curso', pedido: { repo: 'tycon-harness', numero: 100 } },
    { titulo: 'Con corrida y pedido', historia: '7.3', estado: 'hecho', pedido: { repo: 'tycon-harness', numero: 101 } },
  ] }));
  runMarkerFile(m, 's', '7.3', 'La corrida', BEFORE_PLAN.concat('approve-plan'), { lastTouch: atIso(NOW) });
  sessionWith(m, 's', 'Eva', 'busy');
  const data = await collect({ stateDir: m.state, sessionsDir: m.sessions, home: m.root, now: atIso(NOW), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), queryPrs });
  assert.deepStrictEqual(titles(data, 'sinEmpezar'), ['Sin corrida ni pedido']);
  assert.deepStrictEqual(titles(data, 'hechos'), ['Sin corrida con pedido']);
  assert.deepStrictEqual(titles(data, 'curso'), ['La corrida']);
  assert.deepStrictEqual(asked, [100], 'con corrida no se consulta');
});

test('T115 Board_RowWithPr_StateFromPr @story-2.81 @ac-65: el estado de la fila sale de su pedido, a lo sumo una vez por minuto', async () => {
  const { cachedQuery } = require(path.join(__dirname, '..', 'tools', 'office', 'server.js'));
  const answers = {
    1: { pr: { state: 'open', draft: false, autoComplete: true, inQueue: true } },
    2: { pr: { state: 'open', draft: true, autoComplete: false } },
    3: { pr: { state: 'open', draft: false, autoComplete: false, inQueue: false } },
    4: { pr: { state: 'merged', mergedAt: atIso(NOW - 3600000) } },
    5: { error: 'la capa de plataforma: no_medido: se cayó la red' },
  };
  let calls = 0;
  const asked = [];
  const queryPrs = cachedQuery(async (qs) => { calls += 1; return qs.map((q) => { asked.push(q.numero); return answers[q.numero]; }); });
  const m = toyMachine();
  fs.mkdirSync(path.join(m.state, 'coordination'), { recursive: true });
  const row = (titulo, numero, estado = 'sin-empezar') => ({ titulo, estado, pedido: { repo: 'tycon-harness', numero } });
  fs.writeFileSync(path.join(m.state, 'coordination', 'tablero.json'), JSON.stringify({ pendientes: [row('En la cola', 1), row('Borrador', 2), row('Fuera', 3), row('Entró', 4), row('Falla', 5, 'curso'), { titulo: 'Sin pedido', estado: 'hecho' }] }));
  const photo = () => collect({ stateDir: m.state, sessionsDir: m.sessions, home: m.root, now: atIso(NOW), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), queryPrs });
  const data = await photo();
  assert.deepStrictEqual(titles(data, 'entrando'), ['En la cola', 'Borrador', 'Fuera']);
  const entra = col(data, 'entrando').tarjetas;
  assert.strictEqual(entra[0].motivo, undefined);
  assert.strictEqual(entra[1].motivo, 'en borrador');
  assert.strictEqual(entra[2].motivo, 'fuera de la cola');
  const hecho = col(data, 'hechos').tarjetas.find((t) => t.titulo === 'Entró');
  assert.ok(hecho.hora && /\d\d:\d\d/.test(hecho.hora), JSON.stringify(hecho));
  assert.ok(titles(data, 'curso').includes('Falla'), 'lo que falla queda donde dice el archivo: no saber no es «entró»');
  assert.ok(data.unreadable.some((u) => /se cayó la red/.test(u)), data.unreadable.join(' | '));
  await photo();
  assert.strictEqual(calls, 1, 'dos fotos seguidas: una sola consulta');
  assert.deepStrictEqual(asked.sort(), [1, 2, 3, 4, 5], 'cada uno una vez, y ninguno que el tablero no nombra');
});

test('T116 Stamp_UpToDate_BoardWrittenAt @story-2.81 @ac-66: «Al día a las» y la hora de escritura del tablero', async () => {
  const html = page({ agents: [], items: [], meta: { actualizado: '10:00', teToca: [] }, rows: [], free: [], unreadable: [], kanban: { columnas: [], medioCamino: [] } });
  assert.match(html, /"Al día a las "\+meta\.actualizado/);
  assert.doesNotMatch(html, /Foto de las/);
  const m = toyMachine();
  const file = path.join(m.state, 'coordination', 'tablero.json');
  const photo = (now) => collect({ stateDir: m.state, sessionsDir: m.sessions, home: m.root, now: atIso(now), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }) });
  // sin tablero, el kanban no dice ninguna hora
  assert.strictEqual((await photo(NOW)).kanban.escrito, undefined);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pendientes: [] }));
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  assert.strictEqual((await photo(NOW + 10 * 60000)).kanban.escrito, `Tablero escrito a las ${hm(NOW)}`);
  assert.strictEqual((await photo(NOW + 20 * 60000)).kanban.escrito, `Tablero escrito a las ${hm(NOW)} (vieja)`);
  // el kanban y el panel de la pared usan esa hora; sin tablero, la pared dice «Al día»
  assert.match(html, /escrito\|\|"Al día a las "/);
  const { body } = drawKanban({ agents: [], items: [], meta: { actualizado: '10:00', teToca: [] }, rows: [], free: [], unreadable: [], tablero: null, kanban: { escrito: `Tablero escrito a las ${hm(NOW)}`, columnas: [], medioCamino: [] } });
  assert.match(textOf(body), new RegExp(`Tablero escrito a las ${hm(NOW)}`));
});

// ── Las regresiones del pase adversarial del estado real ─────────────────────────────────────────────────────────────

const parked = (m, sid, body) => { fs.mkdirSync(path.join(m.state, 'parked'), { recursive: true }); fs.writeFileSync(path.join(m.state, 'parked', `${sid}.json`), body); };
const oldHours = (now, h) => atIso(now - h * 3600000);

test('T126 PausedUntil_ProtectsLikeAMark @story-2.81 @ac-59 @ac-60: `paused_until:` de la historia protege de limpiar y de la poda', () => {
  const m = parkMachine();
  const now = Date.now();
  const story = path.join(m.root, 'story-9.21.md');
  fs.writeFileSync(story, `---\nstory: "9.21"\ntitle: "Pausada"\npaused_until: ${ymd(now + 5 * 86400000)}\n---\n# Story\n`);
  const base = { storyId: '9.21', storyPath: story, stepScheme: STEP_LIB.SCHEME, stepsCompleted: BEFORE_PLAN, stepsPending: IDS.filter((s) => !BEFORE_PLAN.includes(s)), startedAt: oldHours(now, 40), lastTouch: oldHours(now, 30) };
  fs.writeFileSync(path.join(m.state, 'active', 'pa.json'), JSON.stringify({ sessionId: 'pa', ...base }));
  fs.writeFileSync(path.join(m.state, 'active', 'pb.json'), JSON.stringify({ sessionId: 'pb', ...base }));
  assert.strictEqual(runMarker(m.home, 'otra', ['clear-session', 'pa']), 1);
  assert.ok(fs.existsSync(path.join(m.state, 'active', 'pa.json')), 'limpiarla se niega');
  assert.strictEqual(runMarker(m.home, 'otra', ['list-all']), 0);
  assert.ok(fs.existsSync(path.join(m.state, 'active', 'pb.json')), 'la poda no la borra');
});

test('T127 Mark_Unreadable_Protects @story-2.81 @ac-60: una marca que está y no se lee protege; `--until` vale en cualquier huso', () => {
  const m = parkMachine();
  const now = Date.now();
  runMarkerFile(m, 'rota', '9.22', 'Rota', BEFORE_PLAN, { startedAt: oldHours(now, 40), lastTouch: oldHours(now, 30) });
  parked(m, 'rota', '{ esto no es json');
  assert.strictEqual(runMarker(m.home, 'otra', ['clear-session', 'rota']), 1);
  assert.strictEqual(runMarker(m.home, 'otra', ['list-all']), 0);
  assert.ok(fs.existsSync(path.join(m.state, 'active', 'rota.json')));
  // +14 h: las 12:00 locales caen el día anterior en UTC
  runMarkerFile(m, 'huso', '9.23', 'Huso', BEFORE_PLAN, { lastTouch: atIso(now) });
  const out = execFileSync('node', [MARKER, 'park', '9.23', '--until', '2030-03-10'], { input: '', env: { ...process.env, TZ: 'Pacific/Kiritimati', HOME: m.home, USERPROFILE: m.home, CLAUDE_CODE_SESSION_ID: 'otra' }, encoding: 'utf8' });
  assert.match(out, /en pausa hasta 2030-03-10/);
});

test('T128 FinishedAndMarked_CleanTree_NoSignature @story-2.81 @ac-46 @ac-62: marcada, cerrada y con el árbol limpio no pide el ok', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'limpio');
  fs.writeFileSync(path.join(m.state, 'active', 'g.json'), JSON.stringify({ sessionId: 'g', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Limpia'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, startedAt: oldHours(now, 3), lastTouch: atIso(now - 60000) }));
  sessionWith(m, 'g', 'Bea', 'idle', now - 600000);
  parked(m, 'g', JSON.stringify({ story: '9.9', kind: 'queue', at: atIso(now - 60000) }));
  const data = await collectAt(m, now);
  assert.notStrictEqual(byName(data, 'Bea').estado, 'firma');
  assert.strictEqual(byName(data, 'Bea').marca, 'En fila para pruebas');
  assert.deepStrictEqual(data.meta.teToca, []);
  assert.deepStrictEqual(titles(data, 'firma'), []);
  assert.ok(titles(data, 'curso').includes('Limpia'), 'y sigue en curso');
});

test('T129 FinishedWithChanges_DoesNotVanishAfterADay @story-2.81 @ac-46 @ac-61: lo terminado sin guardar sigue pidiendo el ok a las 30 h y la poda no lo borra', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'sucio', { dirty: true });
  fs.writeFileSync(path.join(m.state, 'active', 'g.json'), JSON.stringify({ sessionId: 'g', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Sin guardar'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, startedAt: oldHours(now, 40), lastTouch: oldHours(now, 30) }));
  const data = await collectAt(m, now);
  assert.ok(titles(data, 'firma').includes('Sin guardar'));
  assert.strictEqual(data.meta.teToca.length, 1);
  assert.strictEqual(runMarker(m.home, 'otra', ['list-all']), 0);
  assert.ok(fs.existsSync(path.join(m.state, 'active', 'g.json')), 'la poda no la borra');
});

test('T130 UnsavedChanges_OnlyThisRun @story-2.81 @ac-46: rutas citadas, renombres, otra rama y un repo que no contesta', () => {
  const m = parkMachine();
  const repo = toyRepo(m, 'lector');
  const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=true', '-C', repo, ...a], { stdio: 'ignore' });
  const { unsavedChanges } = require(path.join(path.dirname(OFFICE), 'work-in-progress.js'));
  const ask = (id) => unsavedChanges({ storyId: id, repoPath: repo }, { until: Date.now() + 5000, cache: new Map() });
  fs.mkdirSync(path.join(repo, '.advisors'));
  fs.writeFileSync(path.join(repo, '.advisors', 'con espacio ñ.txt'), 'a');
  fs.writeFileSync(path.join(repo, 'codigo.js'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, '.advisors', 'con espacio ñ.txt'), 'b');
  assert.strictEqual(ask('9.9').dirty, false, '.advisors/ con espacio y acento no es trabajo');
  git('checkout', '-q', '.');
  git('mv', '.advisors/con espacio ñ.txt', 'movido.js');
  assert.strictEqual(ask('9.9').dirty, true, 'un renombre hacia el código es trabajo');
  assert.strictEqual(ask('9.1').dirty, false, 'en la rama de otra historia, los cambios no son de ésta');
  git('checkout', '-q', '-b', 'main');
  assert.strictEqual(ask('9.9').dirty, false, 'en la rama principal tampoco');
  git('checkout', '-q', 'story/9.9-algo');
  const late = unsavedChanges({ storyId: '9.9', repoPath: repo }, { until: 0, cache: new Map() });
  assert.strictEqual(late.dirty, false);
  assert.match(late.problems.join(' '), /tope/, 'el tope de tiempo se dice');
});

test('T131 ClosedSession_UnreadableRepo_Said @story-2.81 @ac-46 @ac-61: con la sesión cerrada, un repo roto queda en «no se pudo leer»', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'roto');
  fs.writeFileSync(path.join(m.state, 'active', 'g.json'), JSON.stringify({ sessionId: 'g', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Rota'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, lastTouch: atIso(now - 60000) }));
  fs.rmSync(path.join(repo, '.git', 'HEAD'));
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[roto');
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  assert.match(w.unreadable.join(' '), /no se pudo leer si le quedan cambios|roto/, w.unreadable.join(' | '));
});

test('T132 Finished_NoLatePromise @story-2.81 @ac-62: una corrida terminada no sale atrasada por su promesa', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Ana', status: 'idle', extra: { kind: 'finished', storyId: '9.9', title: 'T', promisedAt: NOW - 3600000 } }]), nowMs: NOW });
  const a = byName(data, 'Ana');
  assert.strictEqual(a.atrasada, undefined);
  assert.strictEqual(a.atrasoMin, undefined);
  assert.strictEqual(a.fin.hora, 'sin hora estimada');
  assert.strictEqual(a.espera, 'el ok para guardar');
});

test('T133 NewerWork_DoesNotHideMarkOrOwner @story-2.81 @ac-56 @ac-59 @ac-61: lo nuevo no tapa una marca ni lo que espera al dueño, y una sin encolar sigue en riesgo', () => {
  const newer = { meanwhile: 'Otra cosa', meanwhileKind: 'note', meanwhileAt: NOW - 60000, activityAt: NOW - 3600000 };
  const { data } = buildOffice({
    wip: wip([
      { session: 'Mar', extra: { kind: 'pipeline', storyId: '9.1', title: 'Marcada', mark: 'En fila para pruebas', ...newer } },
      { session: 'Pla', status: 'idle', extra: { kind: 'pipeline', storyId: '9.2', title: 'Plan', current: 'approve-plan', ...newer } },
      { session: 'Pau', extra: { kind: 'pipeline', storyId: '9.3', title: 'Pausada', current: 'implement', ...newer } },
      { session: 'Sta', extra: { kind: 'stalled', storyId: '9.4', title: 'Sin encolar', closedAt: NOW - 3600000, meanwhile: 'Otra', meanwhileKind: 'note', meanwhileAt: NOW - 60000 } },
    ]),
    nowMs: NOW,
    board: { filas: [{ titulo: 'Fila', historia: '9.3', estado: 'hecho', columna: 'hechos', nota: 'de la coordinadora', quien: '', fin: '' }] },
  });
  assert.strictEqual(byName(data, 'Mar').marca, 'En fila para pruebas');
  assert.strictEqual(byName(data, 'Mar').mientras, 'Otra cosa');
  assert.ok(data.meta.teToca.some((t) => /Aprobar el plan/.test(t)), data.meta.teToca.join());
  assert.strictEqual(byName(data, 'Pau').enPausa, 'Pausada');
  assert.deepStrictEqual(titles(data, 'hechos'), [], 'la fila de una corrida en pausa no manda');
  assert.strictEqual(col(data, 'curso').tarjetas.find((t) => t.quien === 'Pau').nota, 'de la coordinadora');
  const sta = col(data, 'entrando').tarjetas.find((t) => t.titulo === 'Sin encolar');
  assert.strictEqual(sta.marca, 'riesgo');
  assert.notStrictEqual(sta.hora, 'esperando entrar');
});

test('T134 PausedByNewer_SameInWip @story-2.81 @ac-56 @ac-62: la hora de la corrida tapada, y la nota nueva sobre un carril viejo', async () => {
  const m = parkMachine();
  const now = Date.now();
  runMarkerFile(m, 's', '9.3', 'Tapada', BEFORE_PLAN.concat('approve-plan'), { startedAt: oldHours(now, 5), lastTouch: oldHours(now, 3) });
  sessionWith(m, 's', 'Sol', 'busy', now);
  fs.writeFileSync(path.join(m.state, 'adhoc', 's.json'), JSON.stringify({ reason: 'carril viejo', declaredAt: oldHours(now, 2), lastTouch: oldHours(now, 2) }));
  fs.writeFileSync(path.join(m.state, 'doing', 's.json'), JSON.stringify({ text: 'nota nueva', at: atIso(now - 60000) }));
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  const i = w.rows.findIndex((r) => r.session === 'Sol');
  assert.strictEqual(w.extra[i].meanwhileKind, 'note');
  assert.strictEqual(w.rows[i].end, 'sin hora estimada (en pausa)');
  const data = await collectAt(m, now);
  assert.strictEqual(byName(data, 'Sol').enPausa, 'Tapada');
  assert.strictEqual(byName(data, 'Sol').titulo, 'nota nueva');
});

test('T135 Wip_SaysTheSignature @story-2.81 @ac-61 @ac-62: /wip dice «Tu firma» en una marcada y no ofrece limpiar un plan que espera', async () => {
  const m = parkMachine();
  const now = Date.now();
  runMarkerFile(m, 'v', '9.1', 'Viva', BEFORE_PLAN, { startedAt: oldHours(now, 1), lastTouch: atIso(now - 60000) });
  sessionWith(m, 'v', 'Vera', 'idle', now - 600000);
  parked(m, 'v', JSON.stringify({ story: '9.1', kind: 'queue', at: atIso(now - 60000) }));
  runMarkerFile(m, 'c', '9.2', 'Cerrada', BEFORE_PLAN, { lastTouch: atIso(now - 60000) });
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  assert.match(w.text.split('\n').find((l) => l.includes('| Vera |')), /Tu firma: que apruebes el plan/);
  const h = w.halfway.find((x) => /9\.2/.test(x));
  assert.match(h, /Tu firma: que apruebes el plan/);
  assert.doesNotMatch(h, /limpiar/);
});

test('T136 FreeSession_Waiting_IsASignature @story-2.81 @ac-44 @ac-62: la sesión sin trabajo que espera es «Tu firma», también pasadas 3 h', async () => {
  const { data } = buildOffice({ wip: wip([], { free: ['Lia', 'Ana'], freeSids: ['l', 'a'], freeStatus: ['waiting_for_permission', 'idle'] }), nowMs: NOW });
  assert.strictEqual(byName(data, 'Lia').estado, 'firma');
  assert.strictEqual(byName(data, 'Lia').espera, 'tu respuesta en su pantalla');
  assert.strictEqual(byName(data, 'Ana').estado, 'libre');
  const m = parkMachine();
  const now = Date.now();
  sessionWith(m, 'l', 'Lia', 'waiting', now - 5 * 3600000);
  fs.writeFileSync(path.join(m.sessions, 'l.json'), JSON.stringify({ pid: process.pid, sessionId: 'l', name: 'Lia', status: 'waiting', statusUpdatedAt: now - 5 * 3600000, updatedAt: now - 5 * 3600000 }));
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  assert.ok(w.free.includes('Lia') || w.rows.some((r) => r.session === 'Lia'), JSON.stringify({ free: w.free, idle: w.idle }));
  assert.ok(!w.idle.some((t) => t.startsWith('Lia')), 'no está sin uso');
});

test('T137 CodexFileCard_MarkAndLane @story-2.81 @ac-59 @ac-62 @ac-53: la tarjeta de Codex lleva su marca y su carril como título', () => {
  const file = (session, more) => ({ session, tool: 'codex', pid: process.pid, updatedAt: atIso(NOW - 60000), busy: true, ...more });
  const { data } = buildOffice({
    wip: wip([], { halfwayItems: [{ kind: 'run', sid: 'cxm', text: 'Marcada', name: 'Cx1', storyId: '9.1', mark: 'En fila para pruebas' }] }),
    sessionFiles: [file('cxm', { name: 'Cx1', step: 'Implementar', endAt: atIso(NOW + 3600000) }), file('cxl', { name: 'Cx2', sentence: 'Arreglo el aviso del pedido' })],
    transcripts: new Map([['cxl', { encargo: 'Sos Tina. El encargo inicial', haciendoAhora: 'Reviso.', ultimaAccion: null, lastWriteMs: NOW }]]),
    isAlive: () => true,
    nowMs: NOW,
  });
  const m = byName(data, 'Cx1');
  assert.strictEqual(m.marca, 'En fila para pruebas');
  assert.strictEqual(m.pronosticoIso, undefined);
  assert.strictEqual(m.fin.hora, 'En fila para pruebas');
  const l = byName(data, 'Cx2');
  assert.strictEqual(l.titulo, 'Arreglo el aviso del pedido');
  assert.strictEqual(l.haciendo, 'Arreglo el aviso del pedido', 'lo que anotó le gana a su último mensaje');
  assert.strictEqual(l.encargo, 'Sos Tina. El encargo inicial');
});

test('T138 MarkedEntering_GoesToCurso @story-2.81 @ac-59: una marcada que espera entrar va a «En curso», viva o cerrada', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Ana', extra: { kind: 'entering', storyId: '9.1', title: 'Entra', mark: 'En fila para pruebas' } }]), nowMs: NOW });
  assert.ok(titles(data, 'curso').includes('Entra'));
  assert.ok(!titles(data, 'entrando').includes('Entra'));
});

test('T139 Board_Forms @story-2.81 @ac-64 @ac-65: ids y pedidos reales, lo que no se reconoce se dice, un estado raro no tira la foto y los grupos en su orden', () => {
  const b = buildBoard({ pendientes: [
    { titulo: 'a', historia: 'OC-5', estado: 'constructor', grupo: 'Zeta', orden: 9 },
    { titulo: 'b', historia: '8.85-E', pedido: { repo: 'Mi Repo', numero: '123' }, grupo: 'Alfa', orden: 1 },
    { titulo: 'c', historia: 'con espacio', pedido: { repo: 'x', numero: 'no' }, grupo: 'Zeta', orden: 2 },
  ] });
  const f = Object.fromEntries(b.filas.map((x) => [x.titulo, x]));
  assert.strictEqual(f.a.historia, 'OC-5');
  assert.strictEqual(f.a.columna, 'sinEmpezar');
  assert.strictEqual(f.b.historia, '8.85-E');
  assert.deepStrictEqual(f.b.pedido, { repo: 'Mi Repo', numero: 123 });
  assert.strictEqual(f.c.historia, null);
  // las dos de la historia y el pedido, y una de las filas sin número (8.198, AC 7)
  assert.strictEqual(b.avisos.length, 3, b.avisos.join(' | '));
  assert.match(b.avisos[2], /sin número/);
  assert.deepStrictEqual(b.filas.map((x) => x.titulo), ['c', 'a', 'b'], 'los grupos, en el orden en que aparecen');
});

test('T140 Board_LeftoverRun_FileRules_AndOpenRepoKnown @story-2.81 @ac-64 @ac-65: lo que quedó sin tarjeta consulta su pedido, y el repo de una corrida abierta se reconoce', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'propio');
  runMarkerFile(m, 'a', '9.9', 'Abierta', BEFORE_PLAN.concat('approve-plan'), { repoPath: repo, lastTouch: atIso(now - 60000) });
  sessionWith(m, 'a', 'Ana', 'busy', now);
  runMarkerFile(m, 'b', '9.8', 'Quedó', BEFORE_PLAN.concat('approve-plan'), { lastTouch: atIso(now - 60000) });
  fs.mkdirSync(path.join(m.state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'coordination', 'tablero.json'), JSON.stringify({ pendientes: [
    { titulo: 'Fila del pedido', historia: '9.8', estado: 'curso', pedido: { repo: 'propio', numero: 501 } },
  ] }));
  const asked = [];
  const data = await collectAt(m, now, { queryPrs: async (qs) => { asked.push(...qs); return qs.map(() => ({ pr: { state: 'merged', mergedAt: atIso(now) } })); } });
  assert.strictEqual(asked.length, 1, 'el pedido de una fila sin tarjeta se consulta');
  assert.deepStrictEqual(asked[0].identity, { platform: 'github', org: 'acme', repo: 'propio' });
  assert.ok(titles(data, 'hechos').includes('Fila del pedido'));
});

test('T141 SameName_StableOrder @story-2.81 @ac-52: dos sesiones con el mismo nombre no cambian de escritorio', () => {
  const orden = (entries) => buildOffice({ wip: wip(entries), nowMs: NOW }).data.agents.map((a) => a.haciendo);
  const x = { session: 'Ana', sid: 'a1', extra: { kind: 'note', text: 'Primera' } };
  const y = { session: 'Ana', sid: 'a2', extra: { kind: 'note', text: 'Segunda' } };
  assert.deepStrictEqual(orden([x, y]), orden([y, x]));
});

test('T142 Plain_NoTechnicalNoNumbersNoSecrets @story-2.81 @ac-53: lo que dice la conversación sale en llano y sin datos sensibles', () => {
  const { plain } = require(OFFICE);
  assert.strictEqual(plain('Reviso `office.js` y `stuck-pr-notice` ahora'), 'Reviso y ahora');
  assert.strictEqual(plain('Mirá **office.js** ya'), 'Mirá ya');
  assert.strictEqual(plain('Toco office.js:241 ahora'), 'Toco ahora');
  assert.strictEqual(plain('Revisá C:\\Users\\x\\office.js ya'), 'Revisá ya');
  assert.strictEqual(plain('Implementá la 2.81 tanda C'), 'Implementá la historia tanda C');
  assert.strictEqual(plain('Seguí con la 8.171-B y el pedido 885'), 'Seguí con la historia y el pedido');
  assert.strictEqual(plain('La reunión es a la 1.30 con 2.5 horas'), 'La reunión es a la 1.30 con 2.5 horas');
  for (const leak of [`mi correo es ana${'@'}acme.com`, 'llamá al +54 11 4444-5555', 'la clave=abc123', `usá ${'ghp'}_abcdefghij${'0123456789'}xyz`, `el token ${'eyJ'}hbGciOi.${'eyJ'}zdWIiOiIx.c2lnbmF0dXJl9 vence`]) {
    assert.doesNotMatch(plain(leak), /@|4444|abc123|ghp_|eyJ/, leak);
  }
  assert.strictEqual(plain('Fue el 2026-11-02 a las 10-12'), 'Fue el 2026-11-02 a las 10-12');
});

test('T143 ClosedRunWithLane_ReadsItsConversation @story-2.81 @ac-53: la sesión cuya corrida terminó y declaró un carril trae su conversación', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'entra');
  fs.writeFileSync(path.join(m.state, 'active', 's.json'), JSON.stringify({ sessionId: 's', storyId: '9.9', storyPath: storyFile(m, '9.9', 'Entrando'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, startedAt: oldHours(now, 3), lastTouch: oldHours(now, 1), stepTimings: { 'prepare-commit': { completedAt: oldHours(now, 1) } } }));
  fs.writeFileSync(path.join(m.sessions, 's.json'), JSON.stringify({ pid: process.pid, sessionId: 's', name: 'Sol', status: 'busy', statusUpdatedAt: now, cwd: repo }));
  fs.writeFileSync(path.join(m.state, 'adhoc', 's.json'), JSON.stringify({ reason: 'el carril', declaredAt: atIso(now - 60000), lastTouch: atIso(now - 60000) }));
  const dir = path.join(m.home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), `${[
    { type: 'user', timestamp: atIso(now - 120000), message: { content: 'Sos Sol. El encargo' } },
    { type: 'assistant', timestamp: atIso(now - 60000), message: { content: [{ type: 'text', text: 'Sigo con el kanban.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n')}\n`);
  const data = await collectAt(m, now, { queryAll: async (qs) => qs.map(() => ({ prs: [{ number: 5, title: 't', autoComplete: true, inQueue: true }] })) });
  const a = byName(data, 'Sol');
  assert.strictEqual(a.titulo, 'el carril');
  assert.strictEqual(a.haciendoAhora, undefined, 'su carril es lo anotado');
  assert.strictEqual(a.encargo, 'El encargo', 'su nombre no es el encargo');
});

test('T144 HourForStep_NotFrozenOnGitTimeout @story-2.81 @ac-57: una hora calculada sin la entrada a un repo no se fija para todo el paso', () => {
  const { hourForStep, endOf } = require(path.join(path.dirname(OFFICE), 'work-in-progress.js'));
  const m = parkMachine();
  const repo = toyRepo(m, 'lento');
  const now = Date.now();
  fs.mkdirSync(path.join(m.state, 'timing-history'), { recursive: true });
  const done = BEFORE_PLAN.concat('approve-plan');
  const pending = IDS.filter((s) => !done.includes(s));
  const timings = Object.fromEntries(IDS.map((s, n) => [s, { startedAt: atIso(now - 3600000 + n * 120000), completedAt: atIso(now - 3600000 + n * 120000 + 60000) }]));
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(m.state, 'timing-history', `h${i}.json`), JSON.stringify({ marker: { startedAt: oldHours(now, 1), stepScheme: STEP_LIB.SCHEME, stepTimings: timings } }));
  const marker = { storyId: '9.9', repoPath: repo, stepScheme: STEP_LIB.SCHEME, stepsCompleted: done, stepsPending: pending, stepTimings: { [pending[0]]: { startedAt: atIso(now - 1000) } } };
  const fakeBin = path.join(m.root, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh\nsleep 3\nexit 1\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${before}`;
  try {
    const e = endOf(marker, { home: m.home, stateDir: m.state, now });
    assert.ok(e.endAt != null, `sin hora: ${e.endWithoutHour}`);
    assert.strictEqual(e.partial, true);
    assert.strictEqual(hourForStep(marker, { home: m.home, stateDir: m.state, now }), null);
  } finally { process.env.PATH = before; }
});

// ---------- los datos que se veían mal: título, hora, pruebas, pendientes, tablas y ficha ----------

test('T201 RunningTests_OnlyWithAProcess: se reconoce el proceso de prueba bajo la sesión; nombrarlas no es correrlas', () => {
  const { runningTests } = require(path.join(__dirname, '..', 'tools', 'office.js'));
  const tree = (comando) => [{ pid: 20, ppid: 10, comando: '/bin/zsh -c source x' }, { pid: 21, ppid: 20, comando }, { pid: 30, ppid: 99, comando: 'bash /x/test-gate.sh /otra' }];
  assert.strictEqual(runningTests(10, tree('bash /x/test-gate.sh /repo')), true);
  assert.strictEqual(runningTests(10, tree('node /x/node_modules/.bin/vitest run')), true);
  assert.strictEqual(runningTests(10, tree('bash scripts/tests/base-controls.test.sh')), true);
  assert.strictEqual(runningTests(10, tree('grep vitest a.txt')), false, 'una búsqueda las nombra');
  assert.strictEqual(runningTests(10, tree('/bin/zsh -c npm test')), false, 'el comando de una consola las nombra; si corren, es su hijo');
  assert.strictEqual(runningTests(10, tree('sleep 5')), false);
  assert.strictEqual(runningTests(99, tree('sleep 5')), true, 'las de otra sesión son de ella');
  assert.strictEqual(runningTests(10, null), null, 'sin la lista de procesos no se sabe');
  assert.strictEqual(runningTests(null, tree('sleep 5')), null, 'sin su proceso no se sabe');
  assert.strictEqual(runningTests(10, tree('sleep 5'), 'codex'), null, 'Codex corre sus comandos en otro lado');
});

test('T202 Step_RunTests_SaysIfTheyRun: «Corriendo pruebas» sólo con pruebas corriendo, y lo que no se sabe se dice', () => {
  const run = { kind: 'pipeline', current: 'run-tests', steps: STEPS };
  const photo = (processes) => buildOffice({ wip: wip([{ session: 'Eva', sid: 'e', status: 'busy', extra: run }]), sessionFiles: [{ session: 'e', tool: 'claude', pid: 10 }], processes, nowMs: NOW }).data;
  assert.strictEqual(byName(photo([{ pid: 11, ppid: 10, comando: 'bash test-gate.sh r' }]), 'Eva').estado, 'prueba');
  const none = byName(photo([{ pid: 10, ppid: 1, comando: 'claude' }]), 'Eva');
  assert.strictEqual(none.estado, 'trabajando');
  assert.match(none.haciendo, /Ahora no hay pruebas corriendo\.$/);
  const unknown = byName(photo(null), 'Eva');
  assert.strictEqual(unknown.estado, 'trabajando');
  assert.match(unknown.haciendo, /No se sabe si hay pruebas corriendo\.$/);
});

test('T203 Overdue_SaysItPassed: se pasó de la hora, y la última novedad es la más nueva que se conoce', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Eva', sid: 'e', status: 'busy', extra: { kind: 'pipeline', current: 'implement', steps: STEPS, endAt: NOW - 600000, activityAt: NOW - 200000 } }]),
    sessionFiles: [{ session: 'e', tool: 'claude', pid: 10, updatedAt: atIso(NOW - 9 * 3600000) }],
    lastWrites: new Map([['e', NOW - 120000]]),
    nowMs: NOW,
  });
  const a = byName(data, 'Eva');
  assert.deepStrictEqual(a.fin, { hora: 'se pasó de la hora', dif: `sin novedades desde las ${hm(NOW - 120000)}`, cls: 'late' });
  assert.ok(!/tarde/.test(JSON.stringify(data.rows)), 'ni el atraso se dice como pronóstico');
  assert.strictEqual(a.callada, undefined, 'y no se la da por callada si escribió hace un rato');
});

test('T204 Stopped_ButStillWriting: parada sólo si dejó de escribir su conversación', () => {
  const impl = { kind: 'activity' };
  const stop = NOW - 30 * 60000;
  const { data } = buildOffice({
    wip: wip([
      { session: 'Sigue', sid: 'a', status: 'idle', statusAt: stop, extra: impl },
      { session: 'Paro', sid: 'b', status: 'idle', statusAt: stop, extra: impl },
      { session: 'Cierre', sid: 'c', status: 'idle', statusAt: stop, extra: impl },
    ]),
    lastWrites: new Map([['a', NOW - 60000], ['b', NOW - 20 * 60000], ['c', stop + 3000]]),
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Sigue').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Paro').parada, `parada desde las ${hm(NOW - 20 * 60000)}`, 'paró cuando dejó de escribir');
  assert.strictEqual(byName(data, 'Cierre').parada, `parada desde las ${hm(stop)}`, 'el fin de un turno escribe enseguida: sigue parada');
});

const localIsoAt = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

test('T205 Kanban_LiveOnly_OnceEach: en curso sólo lo que tiene una sesión viva, y una marca vieja no duplica su fila', () => {
  const halfwayItems = [
    { kind: 'run', text: 'La revisión de la semana se configura desde el sitio: el tope y el material', sid: 'aaaa1111-x', name: 'aaaa1111', storyId: '2.58', mark: 'En fila para pruebas' },
    { kind: 'run', text: 'Lo que afloja un control', sid: 'bbbb2222-x', name: 'bbbb2222', storyId: '8.176', mark: 'En fila para pruebas' },
    { kind: 'run', text: 'Con historia cruzada', sid: 'cccc3333-x', name: 'cccc3333', storyId: '9.9', mark: 'En pausa hasta el 04/11' },
    { kind: 'adhoc', text: 'Ya entró a main', cleanAfter: null, sid: 'x', entered: true },
  ];
  const board = buildBoard({ pendientes: [
    { titulo: 'La revisión semanal se configura desde el sitio', estado: 'espera', quien: 'Beto' },
    { titulo: 'Los frenos cuando algo falla', estado: 'espera', quien: 'Rita' },
    { titulo: 'Otro nombre', historia: '9.9', estado: 'espera', quien: 'Nina' },
    { titulo: 'Nadie lo hace', estado: 'curso', quien: 'Lola', pronosticoIso: localIsoAt(NOW - 3600000) },
    { titulo: 'Riesgo sin nadie', estado: 'riesgo' },
  ] });
  const { data } = buildOffice({ wip: wip([{ session: 'Ana', sid: 'a', status: 'busy', extra: { kind: 'loose', text: 'el arreglo de Ana' } }], { halfwayItems }), board, nowMs: NOW });
  assert.deepStrictEqual(titles(data, 'curso'), ['el arreglo de Ana']);
  const sin = col(data, 'sinEmpezar').tarjetas;
  assert.strictEqual(sin.filter((t) => /revisión/i.test(t.titulo)).length, 1, 'una sola vez');
  const fila = sin.find((t) => t.titulo === 'La revisión semanal se configura desde el sitio');
  assert.deepStrictEqual([fila.quien, fila.marca], ['Beto', 'En fila para pruebas'], 'con el nombre de su fila y su marca');
  assert.strictEqual(sin.find((t) => t.titulo === 'Otro nombre').marca, 'En pausa hasta el 04/11', 'por su historia');
  assert.strictEqual(sin.find((t) => t.titulo === 'Los frenos cuando algo falla').marca, undefined, 'otro trabajo con palabras en común no se cruza');
  const sola = sin.find((t) => t.titulo === 'Lo que afloja un control');
  assert.deepStrictEqual([sola.quien, sola.marca], ['', 'En fila para pruebas'], 'sin fila, su tarjeta; sin el id de la sesión');
  const nadie = sin.find((t) => t.titulo === 'Nadie lo hace');
  assert.match(nadie.hora, /^estaba para /, 'sin una sesión que la haga, nadie está atrasado');
  assert.strictEqual(nadie.cls, undefined);
  assert.strictEqual(sin.find((t) => t.titulo === 'Riesgo sin nadie').marca, 'riesgo');
  assert.deepStrictEqual(data.kanban.medioCamino, [], 'lo que ya entró a main no queda a medio camino');
  assert.ok(!JSON.stringify(data.kanban).includes('aaaa1111'));
});

test('T206 Coordinator_NotAPending: la coordinadora no es una tarjeta de «En curso», salvo que anote un trabajo', () => {
  const photo = (extra) => buildOffice({ wip: wip([{ session: 'Coord', sid: 'co', status: 'busy', extra }]), coordinatorSid: 'co', nowMs: NOW }).data;
  assert.deepStrictEqual(titles(photo({ kind: 'activity' }), 'curso'), []);
  assert.deepStrictEqual(titles(photo({ kind: 'note', text: 'ordeno los pedidos del día' }), 'curso'), ['ordeno los pedidos del día']);
});

test('T207 Note_Hour_FirstPromise_Waiting: la sesión anota su hora, se compara con la primera, y quien espera dice qué espera', async () => {
  const m = parkMachine();
  const now = Date.now();
  const hh = (ms) => hm(ms);
  sessionWith(m, 'nota-1', 'Ana', 'busy', now);
  assert.strictEqual(runMarker(m.home, 'nota-1', ['doing', 'mido el disco de la máquina', '--until', hh(now + 3600000)]), 0);
  const first = await collectAt(m, now);
  assert.strictEqual(byName(first, 'Ana').fin.dif, 'en hora');
  // repetir la hora la confirma: lo que siga ya no es corregir un tipeo
  assert.strictEqual(runMarker(m.home, 'nota-1', ['doing', '--until', hh(now + 3600000)]), 0);
  assert.strictEqual(runMarker(m.home, 'nota-1', ['doing', '--until', hh(now + 2 * 3600000)]), 0, 'sin texto, cambia sólo la hora');
  const later = byName(await collectAt(m, now), 'Ana');
  assert.strictEqual(later.titulo, 'mido el disco de la máquina');
  assert.strictEqual(later.fin.dif, '+1 h 00 tarde', 'contra la primera que prometió');
  assert.strictEqual(later.estimadaIso.slice(11), hh(now + 3600000));
  assert.strictEqual(runMarker(m.home, 'nota-1', ['doing', '--waiting-for', 'que entre lo de Beto']), 0);
  const waits = byName(await collectAt(m, now), 'Ana');
  assert.strictEqual(waits.fin.hora, 'espera que entre lo de Beto');
  assert.match(waits.fin.dif, /^desde las \d\d:\d\d$/);
  assert.strictEqual(waits.estimadaIso, undefined, 'quien espera no tiene hora: no se la inventa');
  assert.notStrictEqual(runMarker(m.home, 'nota-1', ['doing', 'otra', '--until', hh(now)]), 0, 'texto corto');
  assert.notStrictEqual(runMarker(m.home, 'nota-1', ['doing', 'una nota larga', '--until', hh(now), '--waiting-for', 'algo que espera']), 0, 'una de las dos');
});

test('T208 Note_Hour_OnALane: con un arreglo rápido abierto, la nota le da la hora sin abrir otra fila', async () => {
  const m = parkMachine();
  const now = Date.now();
  sessionWith(m, 'nota-2', 'Eva', 'busy', now);
  fs.mkdirSync(path.join(m.state, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'adhoc', 'nota-2.json'), JSON.stringify({ reason: 'un arreglo de Eva', declaredAt: atIso(now - 60000), lastTouch: atIso(now - 60000) }));
  assert.strictEqual(runMarker(m.home, 'nota-2', ['doing', 'una nota con su hora', '--until', hm(now + 3600000)]), 0);
  const data = await collectAt(m, now);
  assert.strictEqual(data.agents.filter((a) => a.nombre === 'Eva').length, 1);
  const a = byName(data, 'Eva');
  assert.strictEqual(a.titulo, 'un arreglo de Eva');
  assert.strictEqual(a.fin.dif, 'en hora');
});

const { buildTables } = require(path.join(__dirname, '..', 'tools', 'office.js'));
const KANBAN_FOR_TABLES = { columnas: [
  { id: 'firma', tarjetas: [{ titulo: 'Firmar algo', hora: '' }] },
  { id: 'curso', tarjetas: [{ titulo: 'Con hora', hora: 'lun 12:00 · en hora' }, { titulo: 'Sin hora', hora: 'sin hora estimada' }] },
  { id: 'entrando', tarjetas: [{ titulo: 'En la cola', hora: 'esperando entrar' }] },
  { id: 'sinEmpezar', tarjetas: [{ titulo: 'Después', hora: 'sáb 18:00' }] },
  { id: 'hechos', tarjetas: [{ titulo: 'Hecho', hora: 'lun 09:00' }] },
], medioCamino: [{ titulo: 'Quedó', accion: 'x' }] };

test('T211 Tables_PageDrawsText: la página dibuja las tablas arriba del tablero, como texto', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  data.tablas = buildTables({ kanban: KANBAN_FOR_TABLES, nowMs: NOW });
  const html = page(data);
  assert.ok(html.indexOf('id="tablas"') < html.indexOf('id="board"'));
  const fn = (html.match(/function renderTablas\(\)\{[\s\S]*?\n?\}\)\}/) || [])[0];
  assert.ok(fn && !/innerHTML/.test(fn), 'como texto');
});

test('T212 Card_And_Panel_OneFicha: la tarjeta y el panel pintan la misma ficha, sin perder ningún dato', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  assert.strictEqual((html.match(/function ficha\(a,abiertos\)/g) || []).length, 1, 'un solo lugar');
  const crew = html.slice(html.indexOf('function renderCrew()'), html.indexOf('function ficha(a,abiertos)'));
  assert.match(crew, /pintarFicha\(a,k,false\)/);
  const abrir = html.slice(html.indexOf('function abrir(nombre'), html.indexOf('const ray=new THREE.Raycaster()'));
  assert.match(abrir, /T\.pintarFicha\(a,panel,true\)/);
  assert.doesNotMatch(abrir, /row\("Trabajo"/);
  const ficha = html.slice(html.indexOf('function ficha(a,abiertos)'), html.indexOf('// sin 3D, la tabla queda abierta'));
  for (const k of ['Trabajo', 'De la historia', 'Historia', 'Encargo', 'Haciendo ahora', 'Haciendo', 'Última acción', 'Espera', 'Parada', 'Mientras tanto', 'En pausa', 'Termina', 'Por qué', 'Prometido', 'Avance', 'Carpeta', 'Pasos de la ejecución']) assert.ok(ficha.includes(`"${k}"`), k);
  assert.doesNotMatch(html, /Pasos de la corrida/);
});

test('T214 Halfway_NamedPr: un trabajo que nombra su pedido entró si el pedido entró; si no se pudo saber, lo dice', async () => {
  const m = parkMachine();
  const now = Date.now();
  const { spawnSync } = require('child_process');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-pedido-')));
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'fix/otra');
  g('remote', 'add', 'origin', 'https://github.com/org/repo.git');
  fs.writeFileSync(path.join(repo, 'a.js'), 'a');
  fs.mkdirSync(path.join(m.state, 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'adhoc', 'muerta-1.json'), JSON.stringify({ reason: 'el rojo de la cola del #878', files: [path.join(repo, 'a.js')], declaredAt: atIso(now - 3600000), lastTouch: atIso(now - 3600000) }));
  const asked = [];
  const photo = (state) => collectAt(m, now, { queryPrs: async (qs) => qs.map((q) => { asked.push(q.numero); return state; }) });
  assert.deepStrictEqual((await photo({ pr: { state: 'merged' } })).kanban.medioCamino, [], 'el pedido entró');
  assert.deepStrictEqual(asked, [878]);
  const open = (await photo({ pr: { state: 'open' } })).kanban.medioCamino;
  assert.strictEqual(open.length, 1);
  assert.match(open[0].titulo, /: 1 archivo sin guardar$/);
  assert.match(open[0].accion, /Abrí una sesión en esa carpeta/);
  assert.strictEqual((await photo({ error: 'se cayó la red' })).kanban.medioCamino.length, 1, 'sin respuesta no se da por entrado');
});

test('T215 Run_Folder_IsTheRuns: la tarjeta de una ejecución dice su carpeta, no la del último archivo que tocó', () => {
  const photo = (extra) => byName(buildOffice({ wip: wip([{ session: 'Eva', status: 'busy', extra: { kind: 'pipeline', current: 'implement', steps: STEPS, title: 'Su historia', runFolder: '~/su-carpeta', ...extra } }]), nowMs: NOW }).data, 'Eva').carpeta;
  assert.strictEqual(photo({}), '~/su-carpeta');
  assert.strictEqual(photo({ meanwhile: 'un arreglo nuevo', meanwhileKind: 'loose', meanwhileAt: NOW - 60000, activityAt: NOW - 3600000 }), 'repo-a', 'si el trabajo nuevo toma la tarjeta, es la de ese trabajo');
});

test('T216 RunningTests_MoreRunners_AndUnknownPid: se reconocen más corredores, y un proceso que no está en la lista no dice que no haya', () => {
  const { runningTests } = require(path.join(__dirname, '..', 'tools', 'office.js'));
  const under = (comando) => runningTests(1, [{ pid: 2, ppid: 1, comando }]);
  for (const c of ['node /x/node_modules/vitest/vitest.mjs run', 'node /x/node_modules/jest/bin/jest.js', 'pnpm test', 'yarn test', 'npm t', 'bun test', 'go test ./...', 'cargo test', 'dotnet vstest a.dll', 'vitest.cmd run', '/x/cat/vitest run']) assert.strictEqual(under(c), true, c);
  for (const c of ['grep jest a.txt', '/usr/bin/grep vitest a', 'sleep 5']) assert.strictEqual(under(c), false, c);
  assert.strictEqual(runningTests(7, [{ pid: 2, ppid: 1, comando: 'sleep 5' }]), null, 'el proceso de la sesión no está en la lista');
});

test('T217 Plain_Dates_Survive: una fecha no es una ruta ni un teléfono', () => {
  const { plainWhole } = require(path.join(__dirname, '..', 'tools', 'office.js'));
  assert.strictEqual(plainWhole('Terminé el 12/10/2025 sin problemas.'), 'Terminé el 12/10/2025 sin problemas.');
  assert.strictEqual(plainWhole('Reunión el 2026-11-02 10:00 con el equipo.'), 'Reunión el 2026-11-02 10:00 con el equipo.');
  assert.strictEqual(plainWhole('Mirá scripts/lib/a.js ahora.'), null, 'una ruta sigue sin decirse');
  assert.strictEqual(plainWhole('Llamé el 2026-05-12 1155551234 sin suerte.'), null, 'un teléfono después de una fecha sigue sin decirse');
  assert.strictEqual(plainWhole('Llamé el 2026-05-12 (11) 5555-1234 sin suerte.'), null);
  assert.strictEqual(plainWhole('El dato 12/34/5678/90 no es una fecha.'), null, 'con dos o más barras, sólo una fecha pasa');
});

test('T219 Room_Rhythm_NeverStops: la sala se dibuja con ritmo, y un error en un cuadro no la deja quieta', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  assert.match(html, /const ritmo=\(\)=>reduce\?0:performance\.now\(\)<hastaTocando\?FPS_TOCANDO:T\.chica\?FPS_QUIETA:desks\.some\(/);
  assert.match(html, /FPS_TOCANDO=30,FPS_MOVIMIENTO=15,FPS_QUIETA=4/);
  assert.match(html, /function loop\(\)\{if\(apagada\|\|!enVista\|\|document\.hidden\)\{timer=null;return\}try\{dibujar\(\)\}finally\{programar\(\)\}\}/);
  assert.match(html, /setPixelRatio\(Math\.min\(devicePixelRatio,1\.25\)\)/);
  assert.match(html, /new IntersectionObserver\(/);
});

test('T310 Room_Rhythm_CameraChangeIsRealOnly: la cámara quieta no cuenta como toque, y una que se mueve o acerca sí', () => {
  // 🔴 rojo: el control de la cámara ortogonal avisa «change» en cada cuadro, cada aviso contaba como toque y la sala
  // dibujaba siempre a 30 cuadros por segundo
  const src = PAGE_CODE();
  const decl = (src.match(/const camVista=\{[^\n]*\};/) || [])[0];
  const fn = (src.match(/function camaraCambio\(\)\{[^\n]*\}return c\}/) || [])[0];
  assert.ok(decl && fn, 'la página trae camaraCambio');
  assert.match(src, /controls\.addEventListener\("change",\(\)=>\{if\(!camaraCambio\(\)\)return;tagsAlDia=false;tocar\(\)\}\);/);
  class V {
    constructor(...n) { this.n = n; }
    clone() { return new V(...this.n); }
    copy(o) { this.n = [...o.n]; return this; }
    distanceToSquared(o) { return this.n.reduce((s, x, i) => s + (x - o.n[i]) ** 2, 0); }
    dot(o) { return this.n.reduce((s, x, i) => s + x * o.n[i], 0); }
  }
  const cam = { position: new V(35, 26.9, 35), quaternion: new V(0, 0, 0, 1), zoom: 1 };
  const cambio = new Function('cam', `${decl}\n${fn}\nreturn camaraCambio;`)(cam);
  assert.strictEqual(cambio(), false, 'sin moverse, no hay cambio');
  assert.strictEqual(cambio(), false, 'ni en el cuadro siguiente');
  cam.position.n[0] += 0.5;
  assert.strictEqual(cambio(), true, 'la cámara que gira es un cambio');
  assert.strictEqual(cambio(), false, 'y queda como la nueva vista');
  cam.position.n[0] += 0.0001;
  assert.strictEqual(cambio(), false, 'un resto de la amortiguación por debajo del umbral del control no cuenta');
  cam.zoom = 1.25;
  assert.strictEqual(cambio(), true, 'acercar es un cambio');
  const a = Math.sin(0.1); cam.quaternion.n = [0, a, 0, Math.cos(0.1)];
  assert.strictEqual(cambio(), true, 'girar sin moverse también');
});

test('T220 Step_RunTests_Codex_NotKnown: con Codex, no encontrarlas no dice que no haya', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Eva', sid: 'e', status: null, extra: { kind: 'pipeline', current: 'run-tests', steps: STEPS } }]), sessionFiles: [{ session: 'e', tool: 'codex', pid: 10, busy: true }], processes: [{ pid: 11, ppid: 10, comando: 'sleep 5' }], nowMs: NOW });
  assert.match(byName(data, 'Eva').haciendo, /No se sabe si hay pruebas corriendo\.$/);
});

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

test('T223 Numbers_PanelMatchesItsList: cada número del panel coincide con su lista, con la pared y con el kanban', () => {
  const data = mixedOffice();
  assert.strictEqual(col(data, 'entrando').tarjetas.length, 2, 'los dos pedidos que esperan; el quieto no');
  assert.strictEqual(data.kanban.medioCamino.length, 1, 'la nota no cuenta');
  const panel = openWallPanel(data);
  const counts = all(panel, (n) => n.className === 'cnt').map((c) => [textOf(c.children[1]), Number(textOf(c.children[0]))]);
  assert.strictEqual(counts.length, 6, 'las cinco columnas y A medio camino');
  // cada número: su título con la misma cantidad, y justo debajo esa cantidad de filas
  const kids = panel.children;
  for (const [nombre, n] of counts) {
    const at = kids.findIndex((k) => k.tag === 'h4' && textOf(k).startsWith(`${nombre} · `));
    if (n === 0) { assert.strictEqual(at, -1, `${nombre} dice 0 y tiene lista`); continue; }
    assert.strictEqual(textOf(kids[at]), `${nombre} · ${n}`);
    assert.strictEqual(kids[at + 1].children.length, n, `${nombre} dice ${n}`);
  }
  // la pared dice los mismos números
  const wall = wallTexts(data);
  for (const [nombre, n] of counts) assert.strictEqual(wall[wall.indexOf(nombre) - 1], String(n), `la pared, en ${nombre}`);
  // y la vista de abajo también
  const { body } = drawKanban(data);
  const heads = all(body, (x) => x.tag === 'h3').map(textOf);
  for (const c of data.kanban.columnas) assert.ok(heads.includes(`${c.nombre} · ${c.tarjetas.length}`), c.nombre);
});

test('T224 Panel_CoversWhatIsBehind: el panel tapa lo que tiene atrás y va arriba de las etiquetas', () => {
  const css = (page(mixedOffice()).match(/\.panel3\{[^}]*\}/) || [])[0];
  assert.match(css, /background:#[0-9a-f]{6}/i, 'un fondo sin transparencia');
  assert.doesNotMatch(css, /background:rgba/);
});

test('T225 Views_OnePerTime: «El trabajo» muestra Tablas o Kanban, una por vez, y recuerda la última', () => {
  const html = page(mixedOffice());
  assert.match(html, /<h2 id="trabajoTitle">El trabajo<\/h2>/);
  assert.match(html, /name="vista" value="tablas"/);
  assert.match(html, /name="vista" value="kanban"/);
  assert.match(html, /<div class="seg" role="radiogroup"/, 'un interruptor de dos posiciones');
  assert.match(html, /\.seg input:checked\+span\{background:var\(--accent\)/, 'la opción activa bien marcada, con los colores de cada tema');
  assert.match(html, /\.seg input:focus-visible\+span\{outline/, 'y el teclado se ve');
  assert.doesNotMatch(html, /\.seg input\{[^}]*display:none/, 'sin sacarle el teclado a los botones');
  assert.doesNotMatch(html, /id="boardTitle"/, 'la sección ya no se llama Pendientes');
  assert.match(html, /\[hidden\]\{display:none!important\}/, 'un display propio no le gana a hidden');
  // la lógica de la vista, fuera del navegador
  const code = (html.match(/const VISTA_KEY=[\s\S]*?(?=\/\/ los dos resúmenes)/) || [])[0];
  assert.ok(code, 'la página trae las vistas');
  const run = (store, DATA) => {
    const nodes = { tablas: { hidden: false }, board: { hidden: false }, trabajo: { hidden: false } };
    const radios = ['tablas', 'kanban'].map((value) => ({ value, checked: false, addEventListener(_, f) { this.f = f; } }));
    const document = { getElementById: (id) => nodes[id], querySelectorAll: () => radios };
    const api = new Function('document', 'localStorage', 'DATA', `${code};return { pintarVista };`)(document, store, DATA);
    api.pintarVista();
    return { nodes, radios };
  };
  const memory = (v) => ({ saved: v, getItem() { return this.saved; }, setItem(_, x) { this.saved = x; } });
  const both = { tablas: {}, kanban: {} };
  let r = run(memory(null), both);
  assert.deepStrictEqual([r.nodes.tablas.hidden, r.nodes.board.hidden], [false, true], 'de entrada, las tablas');
  const store = memory('kanban');
  r = run(store, both);
  assert.deepStrictEqual([r.nodes.tablas.hidden, r.nodes.board.hidden], [true, false], 'recuerda el kanban');
  r.radios[0].checked = true;
  r.radios[0].f();
  assert.strictEqual(store.saved, 'tablas', 'guarda la elegida');
  assert.deepStrictEqual([r.nodes.tablas.hidden, r.nodes.board.hidden], [false, true]);
  const broken = { getItem() { throw new Error('sin permiso'); }, setItem() { throw new Error('sin permiso'); } };
  r = run(broken, both);
  assert.strictEqual(r.nodes.tablas.hidden, false, 'sin dónde guardar, igual se ve');
  r.radios[1].checked = true;
  r.radios[1].f();
  assert.strictEqual(r.nodes.board.hidden, false, 'y se puede cambiar');
});

test('T226 PlainTable_OnlyWithout3D: «Ver como tabla» no se ve, salvo sin 3D; la nota de las horas va junto a las tarjetas', () => {
  const html = page(mixedOffice());
  assert.match(html, /<details class="tablewrap" id="tablewrap" hidden>/);
  assert.match(html, /function sinTresD\(msg\)\{[^\n]*t\.hidden=false;t\.open=true/);
  const crew = html.indexOf('id="crew"');
  const note = html.indexOf('«Prometido» es la hora');
  const work = html.indexOf('id="trabajo"');
  assert.ok(crew > 0 && crew < note && note < work, 'después de las tarjetas y antes del trabajo');
  assert.ok(html.indexOf('id="noRead"') < html.indexOf('id="tablewrap"'), 'lo que no se pudo leer se ve siempre');
});

test('T227 Halfway_OnlyWhatReallyLeft: sólo archivos sin guardar o commits fuera de main, por carpeta, y lo que no se sabe una vez', () => {
  const item = (more) => ({ kind: 'adhoc', text: 'un arreglo', sid: 's', ...more });
  const halfway = (items, more = {}) => buildOffice({ wip: wip([], { halfwayItems: items }), nowMs: NOW, ...more }).data.kanban;
  const dirty = { folder: '/x/th-a', branch: 'fix/a', changes: 2, ahead: 1 };
  const one = halfway([item({ left: [dirty] })]);
  assert.strictEqual(one.medioCamino[0].titulo, 'th-a: 2 archivos sin guardar y 1 commit que no entraron a main');
  assert.deepStrictEqual(halfway([item({ left: [dirty] }), item({ left: [dirty], sid: 't' })]).medioCamino.length, 1, 'una fila por carpeta');
  assert.deepStrictEqual(halfway([item({ left: [] })]).medioCamino, [], 'sin nada en la carpeta, no aparece');
  assert.strictEqual(halfway([item({ left: [] })]).medioCaminoNoSe, undefined);
  assert.deepStrictEqual(halfway([{ kind: 'note', text: 'en main; pendientes', sid: 'n', unknown: true, left: [dirty] }]).medioCamino, [], 'una nota nunca');
  assert.deepStrictEqual(halfway([item({ left: [{ ...dirty, changes: 0 }] })], { openPrs: [{ branch: 'fix/a', number: 1 }] }).medioCamino, [], 'la rama con su pedido abierto está entrando');
  const unsure = halfway([item({ unknown: true }), item({ unknown: true, sid: 't' })]);
  assert.deepStrictEqual(unsure.medioCamino, []);
  assert.match(unsure.medioCaminoNoSe, /^De 2 trabajos/, 'se dice una sola vez');
});

test('T228 Halfway_ReadsTheRealFolder: la lista mira la carpeta de verdad y las que ya no están no dejan nada', () => {
  const m = toyMachine();
  const repo = path.join(m.root, 'th-real');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.js'), 'a');
  g('add', '.');
  g('commit', '-q', '-m', 'uno');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('switch', '-q', '-c', 'fix/real');
  fs.writeFileSync(path.join(repo, 'a.js'), 'b');
  g('commit', '-qam', 'dos');
  fs.writeFileSync(path.join(repo, 'b.js'), 'sin guardar');
  const adhoc = (sid, files) => fs.writeFileSync(path.join(m.state, 'adhoc', `${sid}.json`), JSON.stringify({ reason: `trabajo ${sid}`, files, lastTouch: new Date(NOW - 3600000).toISOString() }));
  adhoc('viva-no', [path.join(repo, 'a.js')]);
  adhoc('borrada', [path.join(m.root, 'carpeta-que-no-esta', 'x.js')]);
  const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root });
  const of = (sid) => w.halfwayItems.find((h) => h.sid === sid);
  assert.deepStrictEqual(of('viva-no').left.map((l) => [path.basename(l.folder), l.branch, l.changes, l.ahead]), [['th-real', 'fix/real', 1, 1]]);
  assert.strictEqual(of('viva-no').unknown, false);
  assert.deepStrictEqual(of('borrada').left, [], 'la carpeta que no está no deja nada');
  assert.strictEqual(of('borrada').unknown, false, 'y no es un «no se sabe»');
  assert.strictEqual(buildOffice({ wip: w, nowMs: NOW }).data.kanban.medioCamino.length, 1);
});

test('T229 OpenPrs_FromThePhoto: «Esperan entrar» cuenta los pedidos reales, dice qué mide y, sin lectura reciente, que no midió', async () => {
  const m = toyMachine();
  const photo = (at, lecturas) => fs.writeFileSync(path.join(m.state, 'stuck-prs-photo.json'), JSON.stringify({ at: atIso(at), repos: Object.keys(lecturas), lecturas }));
  const read = () => collect({ stateDir: m.state, sessionsDir: m.sessions, home: m.root, now: atIso(NOW), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }) });
  const pr = (number, more) => ({ number, title: `fix(algo): arreglo ${number}`, sourceBranch: `fix/${number}`, draft: false, autoComplete: false, inQueue: false, ...more });
  fs.writeFileSync(path.join(m.state, 'own-prs.json'), JSON.stringify({ at: atIso(NOW - 60000), lecturas: { 'org/pub': { ok: true, value: [pr(909, { inQueue: true }), pr(721), pr(800, { draft: true, autoComplete: true })] }, 'bizuit/proj/priv': { ok: true, value: [pr(6101, { autoComplete: true, mergeState: 'conflict' })] } } }));
  photo(NOW - 60000, {
    'org/pub': { ok: true, value: [pr(909, { inQueue: true }), pr(721), pr(800, { draft: true, autoComplete: true })] },
    'bizuit/proj/priv': { ok: true, value: [pr(6101, { autoComplete: true, mergeState: 'conflict' })] },
    'org/roto': { ok: false, error: 'sin permiso' },
  });
  const data = await read();
  const c = col(data, 'entrando');
  assert.deepStrictEqual(c.tarjetas.map((t) => [t.quien, t.titulo, t.hora, t.motivo]), [
    ['pedido #909', 'arreglo 909', 'en la cola', undefined],
    ['pedido !6101', 'arreglo 6101', 'con auto-completar', 'choca con main'],
  ]);
  assert.match(c.nota, new RegExp(`leídos a las ${hm(NOW - 60000)}\\. No se pudo leer roto\\.$`));
  photo(NOW - 16 * 60000, { 'org/pub': { ok: true, value: [pr(909, { inQueue: true })] } });
  const old = col(await read(), 'entrando');
  assert.deepStrictEqual(old.tarjetas, [], 'una foto vieja no dice qué sigue abierto');
  assert.match(old.nota, /no se midieron/);
  fs.rmSync(path.join(m.state, 'stuck-prs-photo.json'));
  assert.match(col(await read(), 'entrando').nota, /no se midieron/, 'sin foto, tampoco');
});

test('T231 Card_WaitAndNewHour: lo que espera lleva su pedido; la hora que anotó una ejecución manda si es suya o si la de su paso venció', () => {
  const run = { kind: 'pipeline', current: 'implement', steps: STEPS, title: 'Su historia', storyId: '9.1' };
  const later = NOW + 3600000;
  const { data } = buildOffice({
    wip: wip([
      { session: 'Espera', sid: 'e', status: 'busy', extra: { ...run, waitingFor: 'que entren el #907 y el pedido 6106', waitingSince: NOW - 60000 } },
      { session: 'Nueva', sid: 'n', status: 'busy', extra: { ...run, endAt: NOW - 3 * 3600000, noteEnd: later, noteEndAt: NOW - 60000 } },
      { session: 'Vencida', sid: 'v', status: 'busy', extra: { ...run, endAt: NOW - 3 * 3600000 } },
    ]),
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Espera').fin.hora, 'espera que entren el #907 y el pedido 6106');
  const nueva = byName(data, 'Nueva');
  assert.notStrictEqual(nueva.fin.hora, 'se pasó de la hora');
  assert.strictEqual(nueva.fin.hora.slice(-5), hm(later));
  assert.strictEqual(nueva.horaPorque, `la anotó a las ${hm(NOW - 60000)}`);
  assert.strictEqual(byName(data, 'Vencida').fin.hora, 'se pasó de la hora', 'sin nada anotado, sigue diciéndolo');
  // la lista sólo le da la hora de la nota a la ejecución si la nombra o si su hora venció
  const m = toyMachine();
  const pipe = { stepsCompleted: ['start'], stepsPending: ['plan', 'implement'] };
  const note = (sid, text) => fs.writeFileSync(path.join(m.state, 'doing', `${sid}.json`), JSON.stringify({ text, at: new Date(NOW).toISOString(), endAt: new Date(later).toISOString() }));
  fs.writeFileSync(path.join(m.state, 'active', 's1.json'), JSON.stringify({ sessionId: 's1', storyId: '9.1', storyPath: storyFile(m, '9.1', 'La uno'), ...pipe }));
  fs.writeFileSync(path.join(m.state, 'active', 's2.json'), JSON.stringify({ sessionId: 's2', storyId: '9.2', storyPath: storyFile(m, '9.2', 'La dos'), ...pipe }));
  note('s1', '9.1: programo la tanda');
  note('s2', 'mientras espero, miro el banco');
  liveSession(m, 's1', 'Uno');
  liveSession(m, 's2', 'Dos');
  const w = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: new Date(NOW).toISOString(), home: m.root });
  const ex = (name) => w.extra[w.rows.findIndex((r) => r.session === name)];
  assert.strictEqual(ex('Uno').noteEnd, later, 'la nombra');
  assert.strictEqual(ex('Dos').noteEnd, undefined, 'es de lo que hace mientras tanto');
});

test('T232 Stopped_NotOnTime: una sesión parada no dice «en hora» sin decir qué espera', () => {
  const stopped = { kind: 'note', text: 'el arreglo', endAt: NOW + 3600000, hourAt: NOW - 60000, promiseAt: NOW - 60000 };
  const { data } = buildOffice({ wip: wip([
    { session: 'Parada', sid: 'p', status: 'idle', statusAt: NOW - 600000, extra: stopped },
    { session: 'Avisa', sid: 'q', status: 'idle', statusAt: NOW - 600000, extra: { kind: 'note', text: 'el otro', waitingFor: 'la cola', waitingSince: NOW - 60000 } },
  ]), nowMs: NOW });
  const p = byName(data, 'Parada');
  assert.strictEqual(p.estado, 'parada');
  assert.strictEqual(p.fin.dif, 'parada, no anotó qué espera');
  assert.notStrictEqual(p.fin.cls, 'ontime');
  assert.strictEqual(byName(data, 'Avisa').fin.hora, 'espera la cola');
});

test('T233 SameText_NoRepeat: si lo que hace es lo que anotó, la tarjeta no lo dice dos veces; un título sigue sin números de pedido', () => {
  const { plain: plainOf } = require(OFFICE);
  const html = page(mixedOffice());
  assert.match(html, /else if\(a\.haciendo!==a\.titulo&&!SOLO_COORDINA\.test\(a\.haciendo\|\|""\)\)add\("Haciendo",a\.haciendo\)/);
  assert.strictEqual(plainOf('espera que entren el #907 y el 6106', { keepPrs: true }), 'espera que entren el #907 y el 6106');
  assert.strictEqual(plainOf('espera que entren el #907 y el 6106'), 'espera que entren y el 6106', 'los títulos siguen sin números de pedido');
});

test('Office_UnaTarjetaPorSesion (T8) — @story-8.153 @ac-8: un renglón de la lista de firmas no duplica la tarjeta de su sesión', () => {
  const fila = (destino, title, extra = {}) => ({ tipo: 'firma', id: `f-${destino}-${title}`, destino, title, at: NOW - 60000, ...extra });
  // la sesión ya esperando la firma: una sola tarjeta, la suya
  let { data } = buildOffice({ wip: wip([{ session: 'Alma', sid: 'a', status: 'waiting_for_permission', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Alma' } }]),
    signatures: [fila('a', 'marcar un criterio')], nowMs: NOW });
  assert.strictEqual(col(data, 'firma').tarjetas.length, 1, JSON.stringify(col(data, 'firma').tarjetas));
  assert.strictEqual(col(data, 'firma').tarjetas[0].quien, 'Alma');
  assert.strictEqual(data.meta.teToca.length, 1, 'la pared cuenta lo mismo');
  assert.match(data.meta.teToca[0], /marcar un criterio.*Alma/);
  assert.match(page(data), /"Te toca: "\+toca\.length/, 'el contador de la pared es el largo de teToca');

  // trabajando en otra cosa: dos tarjetas, cada una en su columna, y el renglón con su nombre
  ({ data } = buildOffice({ wip: wip([{ session: 'Bruno', sid: 'b', status: 'busy', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Bruno' } }]),
    signatures: [fila('b', 'marcar un criterio'), fila('b', 'otro criterio')], nowMs: NOW }));
  assert.deepStrictEqual(titles(data, 'curso'), ['Lo de Bruno']);
  assert.deepStrictEqual(titles(data, 'firma'), ['Firma: marcar un criterio y 1 más'], 'una por sesión');
  assert.strictEqual(col(data, 'firma').tarjetas[0].quien, 'Bruno');
  assert.strictEqual(data.meta.teToca.length, col(data, 'firma').tarjetas.length, 'coincide con la columna');

  // un permiso de una sesión sin tarjeta: su título, sin el pedido
  ({ data } = buildOffice({ wip: wip([]), signatures: [{ tipo: 'permiso', id: 'p', destino: 'sin-tarjeta', nombre: 'Ciro', herramienta: 'Bash', pedido: 'rm -rf algo-secreto', title: 'Permiso: Bash', at: NOW }], nowMs: NOW }));
  assert.deepStrictEqual(titles(data, 'firma'), ['Permiso: Bash']);
  assert.strictEqual(col(data, 'firma').tarjetas[0].quien, 'Ciro');
  assert.doesNotMatch(JSON.stringify(data), /algo-secreto/);
  assert.strictEqual(data.meta.teToca.length, 1);

  // quien ya espera aprobar el plan no se cuenta dos veces
  ({ data } = buildOffice({ wip: wip([{ session: 'Dora', sid: 'd', status: 'idle', extra: { kind: 'pipeline', current: 'approve-plan', title: 'Lo de Dora', storyId: '9.9' } }]),
    signatures: [fila('d', 'aprobar el plan de una story')], nowMs: NOW }));
  assert.strictEqual(col(data, 'firma').tarjetas.length, 1);
  assert.strictEqual(data.meta.teToca.length, 1);
  // lo de la terminal, como siempre
  ({ data } = buildOffice({ wip: wip([]), signatures: [{ id: 't', title: 'por la terminal', at: NOW }], nowMs: NOW }));
  assert.deepStrictEqual(data.meta.teToca, ['Firmar: por la terminal']);
  assert.strictEqual(col(data, 'firma').tarjetas[0].quien, 'vos');
});

test('T246 WaysOfWorking_FromItsMark: una ejecución es una historia, un arreglo es camino corto, y lo demás es otra cosa', () => {
  const { data } = buildOffice({
    nowMs: NOW,
    wip: wip([
      { session: 'Ana', extra: { kind: 'pipeline', storyId: '8.181', current: 'implement', title: 'Algo' } },
      { session: 'Beto', extra: { kind: 'entering', storyId: '8.2', title: 'Otra' } },
      { session: 'Caro', extra: { kind: 'loose', text: 'Conviene una historia' } },
      { session: 'Dani', extra: { kind: 'note', text: 'Estoy en camino corto' } },
      { session: 'Eli', extra: { kind: 'activity' } },
    ], { free: ['Fede'], freeSids: ['sid-Fede'], freeStatus: ['idle'] }),
  });
  const como = Object.fromEntries(data.agents.map((a) => [a.nombre, a.comoTrabaja]));
  assert.deepStrictEqual(como, { Ana: 'Historia 8.181', Beto: 'Historia 8.2', Caro: 'Camino corto', Dani: 'Otra cosa', Eli: 'Otra cosa', Fede: 'Otra cosa' });
});

test('T247 Envelopes_OnlyInTheLiveOffice: la página sabe volar un sobre y pedir la conversación, y la foto fija no trae ni sobres ni texto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /lanzarSobres/);
  assert.match(html, /conversacion\?t=/);
  assert.match(html, /Tus últimos 20 mensajes con sus respuestas/);
  const { home } = toyHome();
  const data = JSON.parse(run(home, ['--json', '--now', new Date(NOW).toISOString()]));
  assert.strictEqual('sobres' in data, false, '--json no crea los sobres: viven en el proceso de la oficina');
});

test('T248 WaysOfWorking_Coordinator: la coordinadora dice que coordina, también con un arreglo abierto', () => {
  const { data } = buildOffice({ nowMs: NOW, coordinatorSid: 'sid-Ana', coordinatorName: 'Ana', wip: wip([{ session: 'Ana', extra: { kind: 'loose', text: 'Un arreglo' } }, { session: 'Beto', extra: { kind: 'loose', text: 'Otro' } }]) });
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.comoTrabaja]), [['Ana', 'Coordinando'], ['Beto', 'Camino corto']]);
  const free = buildOffice({ nowMs: NOW, coordinatorName: 'Ana', wip: wip([], { free: ['Ana'], freeSids: ['s'], freeStatus: ['idle'] }) });
  assert.strictEqual(free.data.agents[0].comoTrabaja, 'Coordinando');
});

// Un document mínimo: nodos con hijos y texto, sin ningún intérprete de HTML. Si el formato usara innerHTML, se notaría acá.
function fakeDom() {
  const node = (tagName) => ({ tagName, children: [], textContent: '', append(...k) { this.children.push(...k); } });
  return { createElement: (t) => node(t.toUpperCase()), createTextNode: (t) => ({ tagName: '#text', children: [], textContent: t }) };
}
const shape = (n) => (n.tagName === '#text' ? n.textContent : [n.tagName.toLowerCase(), ...(n.children.length ? n.children.map(shape) : [n.textContent])]);

test('T249 MessageFormat_NodesOnly: negritas, código y listas se arman con nodos, y lo que traiga el mensaje queda como texto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const src = html.slice(html.indexOf('function enLinea('), html.indexOf('function msg('));
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, 'nada del mensaje se inserta como HTML');
  const formatear = new Function('document', `${src}; return formatear;`)(fakeDom());
  const fmt = (t) => formatear(t).map(shape);
  assert.deepStrictEqual(fmt('Es **importante** y `npm test` anda.'), [['p', 'Es ', ['strong', 'importante'], ' y ', ['code', 'npm test'], ' anda.']]);
  assert.deepStrictEqual(fmt('Mirá:\n- uno\n- **dos**\n\n1. tres'), [['p', 'Mirá:'], ['ul', ['li', 'uno'], ['li', ['strong', 'dos']]], ['ol', ['li', 'tres']]]);
  assert.deepStrictEqual(fmt('```js\nconst a = 1;\nconst b = 2;\n```'), [['pre', ['code', 'const a = 1;\nconst b = 2;']]]);
  assert.deepStrictEqual(fmt('## Título'), [['p', ['strong', 'Título']]]);
  assert.deepStrictEqual(fmt('<img src=x onerror=alert(1)> **<b>hola</b>**'), [['p', '<img src=x onerror=alert(1)> ', ['strong', '<b>hola</b>']]]);
  assert.deepStrictEqual(fmt('```\n<script>alert(1)</script>'), [['pre', ['code', '<script>alert(1)</script>']]], 'un bloque sin cerrar queda como código');
  assert.deepStrictEqual(fmt('5 * 3 y 2 ** 4 sin formato'), [['p', '5 * 3 y 2 ** 4 sin formato']]);
});

test('T250 WaysOfWorking_Icon: cada caso tiene su forma, y al ícono no entra el texto de la foto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const src = html.slice(html.indexOf('const COMO_ICONO='), html.indexOf('function pintarFicha('));
  const fake = (tag) => ({ tag, attrs: {}, kids: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(n) { this.kids.push(n); } });
  const doc = { createElement: fake, createElementNS: (_, tag) => fake(tag) };
  const icono = new Function('document', `${src}; return iconoComo;`)(doc);
  const shape = (t) => { const s = icono(t); return s.textContent || JSON.stringify(s.kids.map((k) => [k.attrs, k.kids.map((p) => [p.tag, p.attrs])])); };
  const forms = ['Camino corto', 'Historia 8.181', 'Otra cosa', 'Coordinando'].map(shape);
  assert.strictEqual(new Set(forms).size, 4, 'una forma por caso');
  assert.strictEqual(shape('Coordinando'), '→', 'la coordinadora conserva la flecha de su estado');
  assert.strictEqual(shape('Historia'), shape('Historia 8.181'));
  assert.strictEqual(shape('<img src=x onerror=alert(1)>'), shape('Otra cosa'), 'lo desconocido es otra cosa, y su texto no entra');
  assert.doesNotMatch(forms.join(''), /fill="(?!none)|stroke="#/, 'el ícono no depende de un color: usa el del texto');
  assert.match(html, /T\.iconoComo\(a\.comoTrabaja\)/, 'la etiqueta del dibujo lo lleva');
  assert.match(html, /chips\.appendChild\(etiquetaComo\(a\.comoTrabaja,a\.tarea\)\)/, 'la tarjeta lo lleva como etiqueta, junto al estado');
  assert.match(html, /T\.etiquetaComo\(a\.comoTrabaja\)/, 'el detalle también');
  assert.doesNotMatch(html, /add\("Cómo trabaja"/, 'ya no es un renglón');
});

// ── Cómo trabaja sale de su marca, no de la nota ─────────────────────────────────────────────────────────────────

test('T260 WaysOfWorking_NoteKeepsTheRun: una nota no cambia cómo trabaja una sesión; un arreglo rápido más nuevo sí', () => {
  const now = Date.parse('2026-11-02T20:00:00Z');
  const fresh = { meanwhileAt: now - 60000, activityAt: now - 180000 };
  const { data } = buildOffice({
    wip: wip([
      { session: 'Abierta', extra: { kind: 'pipeline', storyId: '8.90', title: 'La 8.90', ...fresh, meanwhileKind: 'note', meanwhile: 'segunda vuelta' } },
      { session: 'Terminada', extra: { kind: 'note', text: 'espera la constancia', finishedStoryId: '8.153' } },
      { session: 'SinMarca', extra: { kind: 'note', text: 'una medición' } },
      { session: 'ConArreglo', extra: { kind: 'pipeline', storyId: '8.91', title: 'La 8.91', ...fresh, meanwhileKind: 'loose', meanwhile: 'un arreglo' } },
      { session: 'EnEjecucion', extra: { kind: 'pipeline', storyId: '8.92', title: 'La 8.92' } },
    ]),
    nowMs: now,
  });
  const como = Object.fromEntries(data.agents.map((a) => [a.nombre, a.comoTrabaja]));
  assert.deepStrictEqual(como, { Abierta: 'Historia 8.90', Terminada: 'Historia 8.153', SinMarca: 'Otra cosa', ConArreglo: 'Camino corto', EnEjecucion: 'Historia 8.92' });
});

// ── Las notas de espera que nombran un pedido ────────────────────────────────────────────────────────────────────

test('T261 WaitingPrs_NamedInANote: reconoce las formas en uso, y un número suelto no es un pedido', () => {
  const nums = (t) => prsNamedIn(t).map((n) => `${n.sign || ''}${n.numero}`);
  assert.deepStrictEqual(nums('la cola del pedido 913'), ['913']);
  assert.deepStrictEqual(nums('el aviso para encolar #915 y 6116'), ['#915', '6116']);
  assert.deepStrictEqual(nums('que entre !6101, 6106 y #907'), ['!6101', '6106', '#907']);
  assert.deepStrictEqual(nums('el pedido de la 8.182'), [], 'una historia no es un pedido');
  assert.deepStrictEqual(nums('a las 1900 y 2000'), [], 'un número suelto tampoco');
  assert.deepStrictEqual(nums(''), []);
});

test('T262 WaitingPrs_Said: dice lo que terminó; lo abierto o lo que no se sabe sigue como espera', () => {
  const st = (...a) => a.map(([numero, state]) => ({ numero, state }));
  assert.deepStrictEqual(waitedPrsSaid(st([913, 'merged'])), { text: 'El 913 ya entró', all: true });
  assert.deepStrictEqual(waitedPrsSaid(st([913, 'closed'])), { text: 'El 913 se cerró sin entrar', all: true });
  assert.deepStrictEqual(waitedPrsSaid(st([915, 'merged'], [6116, 'merged'])), { text: 'El 915 y el 6116 ya entraron', all: true });
  assert.deepStrictEqual(waitedPrsSaid(st([915, 'merged'], [6116, null])), { text: 'El 915 ya entró', all: false });
  assert.strictEqual(waitedPrsSaid(st([913, null])), null);
});

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

for (const [name, sign, url, otherSign] of PLATFORMS) {
  test(`T263 WaitingPrs_${name}: entró y se cerró se dicen igual, y se pregunta una sola vez`, async () => {
    const m = parkMachine();
    const dir = originRepo(m, 'repo', url);
    const asked = [];
    const known = new Map();
    const opts = { queryPrs: readerOf({ 913: { state: 'merged', mergedAt: '2026-11-02T20:00:00Z' }, 914: { state: 'closed', mergedAt: null } }, asked) };
    const said = await askWaitingPrs(waitingWip(dir, `la cola de ${sign}913`), NO_OPEN, opts, known);
    assert.deepStrictEqual(said.get('p'), { text: 'El 913 ya entró', all: true });
    assert.strictEqual(asked.length, 1);
    assert.ok(asked[0].identity, 'pregunta por el conector del repo');
    await askWaitingPrs(waitingWip(dir, `la cola de ${sign}913`), NO_OPEN, opts, known);
    assert.strictEqual(asked.length, 1, 'lo que terminó no se vuelve a preguntar');
    assert.deepStrictEqual((await askWaitingPrs(waitingWip(dir, `${sign}914`), NO_OPEN, opts, known)).get('p'), { text: 'El 914 se cerró sin entrar', all: true });
    // la marca de la otra plataforma es de otro repo: no se le pregunta a éste
    const before = asked.length;
    assert.strictEqual((await askWaitingPrs(waitingWip(dir, `${otherSign}913`), NO_OPEN, opts, new Map())).size, 0);
    assert.strictEqual(asked.length, before);
  });
}

test('T264 WaitingPrs_OnlyWithEvidence: abierto, sin lectura, sin respuesta o de otro repo, la espera queda como está', async () => {
  const m = parkMachine();
  const dir = originRepo(m, 'repo', 'https://github.com/acme/repo.git');
  const asked = [];
  const merged = { state: 'merged', mergedAt: '2026-11-02T20:00:00Z' };
  const opts = { queryPrs: readerOf({ 913: merged }, asked) };
  const note = waitingWip(dir, 'el pedido #913');
  const open = { measured: true, prs: [{ number: 913, mark: '#' }] };
  assert.strictEqual((await askWaitingPrs(note, open, opts, new Map())).size, 0, 'sigue abierto');
  assert.strictEqual(asked.length, 0, 'lo abierto no se pregunta');
  assert.strictEqual((await askWaitingPrs(note, { measured: false, prs: [] }, opts, new Map())).size, 0, 'sin lectura de pedidos no se sabe');
  assert.strictEqual(asked.length, 0);
  assert.strictEqual((await askWaitingPrs(waitingWip(dir, 'el pedido #555'), NO_OPEN, opts, new Map())).size, 0, 'sin respuesta no dice que entró');
  // un número sin marca puede ser de otro repo: entró antes de la nota, así que no es ése
  const after = Date.parse(merged.mergedAt) + 1000;
  assert.strictEqual((await askWaitingPrs(waitingWip(dir, 'la cola del pedido 913', after), NO_OPEN, opts, new Map())).size, 0);
  const before = Date.parse(merged.mergedAt) - 1000;
  assert.strictEqual((await askWaitingPrs(waitingWip(dir, 'la cola del pedido 913', before), NO_OPEN, opts, new Map())).get('p').text, 'El 913 ya entró');
  const closed = { queryPrs: readerOf({ 913: { state: 'closed', mergedAt: null } }) };
  assert.strictEqual((await askWaitingPrs(waitingWip(dir, 'la cola del pedido 913', before), NO_OPEN, closed, new Map())).size, 0, 'un cerrado sin marca no se puede cruzar');
});

test('T265 WaitingPrs_Card: lo que terminó reemplaza a la espera; si queda algo, sigue esperando', () => {
  const now = Date.parse('2026-11-02T20:00:00Z');
  const card = (said) => byName(buildOffice({ wip: waitingWip('/x', 'el aviso para #915 y 6116', now - 60000), nowMs: now, waitingPrs: said ? new Map([['p', said]]) : null }).data, 'Paz');
  assert.match(card(null).termina, /^espera el aviso para #915 y 6116$/);
  const partial = card({ text: 'El 915 ya entró', all: false });
  assert.strictEqual(partial.termina, 'espera el aviso para #915 y 6116 · El 915 ya entró');
  const all = card({ text: 'El 915 y el 6116 ya entraron', all: true });
  assert.strictEqual(all.termina, 'El 915 y el 6116 ya entraron');
  assert.strictEqual(all.fin.hora, 'El 915 y el 6116 ya entraron');
  assert.ok(!all.fin.dif, 'ya no espera desde ninguna hora');
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /add\("Espera",h\.slice\(7\)/, 'la espera se dice «Espera», no «Termina»');
  assert.match(html, /\^El \\d\+ \/\.test\(h\)\)r\.push\(\{k:"",v:h\}\)/, 'lo que pasó con el pedido va sin título');
});

// ── Los tokens de la tarjeta ─────────────────────────────────────────────────────────────────────────────────────

test('T266 Tokens_Plain: números en llano, y sin ventana no hay porcentaje', () => {
  assert.deepStrictEqual([850, 1000, 762000, 999400, 999600, 1000000, 1040000, 4600000, 95600000, 1175000000].map(tokensTxt),
    ['850', '1 mil', '762 mil', '999 mil', '1 millón', '1 millón', '1 millón', '4,6 millones', '95,6 millones', '1.175 millones']);
  const base = { lectura: 762000, escritura: 233000, cache: 95600000, agentes: 12 };
  assert.deepStrictEqual(tokensCard({ ...base, contexto: 610000, limite: 700000 }), { contexto: '610 mil de 700 mil · 87 %', consumidos: 'Read 762 mil · Write 233 mil · Cache Read 95,6 millones', agentes: 12 });
  assert.strictEqual(tokensCard({ ...base, contexto: 180000, limite: null }).contexto, '180 mil · porcentaje no medido');
  assert.deepStrictEqual(tokensCard({ noMedido: true }), { noMedido: true });
});

test('T268 Tokens_OnlyInTheOpenOffice: con la oficina abierta llegan por nombre; la foto fija no los lee; al sitio viajan', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'cuenta');
  fs.writeFileSync(path.join(m.sessions, 's.json'), JSON.stringify({ pid: process.pid, sessionId: 's', name: 'Sol', status: 'busy', statusUpdatedAt: now, cwd: repo }));
  fs.writeFileSync(path.join(m.state, 'doing', 's.json'), JSON.stringify({ text: 'una medición', at: atIso(now - 60000) }));
  const dir = path.join(m.home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500000, output_tokens: 2000 };
  fs.writeFileSync(path.join(dir, 's.jsonl'), `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage } })}\n`);
  const live = await collectAt(m, now, { envelopes: createEnvelopes() });
  assert.deepStrictEqual(live.tokens.Sol, { contexto: '501 mil de 1 millón · 50 %', consumidos: 'Read 1 mil · Write 2 mil · Cache Read 500 mil', agentes: 0 });
  assert.strictEqual((await collectAt(m, now)).tokens, undefined, 'la foto fija no lee conversaciones enteras');
  const { pick } = require(path.join(path.dirname(OFFICE), 'office', 'fields.js'));
  // viajan al sitio: el sitio lleva todo lo de la oficina local
  assert.deepStrictEqual(pick(live, m.home).tokens, live.tokens, 'viajan al sitio, por nombre');
});

test('T270 Tokens_CodexWithoutName: una sesión de Codex sin nombre propio tiene sus tokens bajo el nombre de su tarjeta', async () => {
  const m = parkMachine();
  const now = Date.now();
  fs.mkdirSync(path.join(m.state, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'sessions', 'cx-1.json'), JSON.stringify(sessionFile('cx-1', { tool: 'codex', pid: null, step: 'Implementar', sentence: 'Va por el paso «Implementar».', updatedAt: atIso(now - 60000) })));
  const d = new Date(now);
  const dir = path.join(m.home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const info = { total_token_usage: { input_tokens: 532881, cached_input_tokens: 483200, output_tokens: 4753 }, last_token_usage: { input_tokens: 64593 }, model_context_window: 258400 };
  fs.writeFileSync(path.join(dir, 'rollout-2026-cx-1.jsonl'), `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info } })}\n`);
  const data = await collectAt(m, now, { envelopes: createEnvelopes() });
  const card = data.agents.find((a) => a.nombre === 'cx-1');
  assert.ok(card, 'tiene su tarjeta');
  assert.deepStrictEqual(data.tokens['cx-1'], { contexto: '65 mil de 258 mil · 25 %', consumidos: 'Read 50 mil · Write 5 mil · Cache Read 483 mil', agentes: 0 });
});

// ── Los cuadros, las paradas, lo trabado y las tablas ────────────────────────────────────────────────────────────

test('T271 Dialogs_QuestionIsNotASignature: una pregunta es «Te pregunta» y entra en «Te toca»; un permiso y un plan siguen siendo firma', () => {
  const run = (current = 'implement') => ({ kind: 'pipeline', current, title: 'El tope' });
  const { data } = buildOffice({
    wip: wip([
      { session: 'Paz', status: 'waiting', extra: run() },
      { session: 'Eva', status: 'waiting_for_permission', extra: run() },
      { session: 'Lia', status: 'waiting', extra: run('approve-plan') },
    ], { free: ['Mimi'], freeSids: ['m'], freeStatus: ['waiting'] }),
    nowMs: NOW,
  });
  assert.deepStrictEqual(['Paz', 'Eva', 'Lia', 'Mimi'].map((n) => byName(data, n).estado), ['pregunta', 'firma', 'firma', 'pregunta']);
  assert.strictEqual(byName(data, 'Paz').espera, 'tu respuesta en su pantalla');
  assert.strictEqual(byName(data, 'Lia').espera, 'que apruebes el plan');
  assert.ok(data.meta.teToca.includes('Contestar: El tope (Paz)'), JSON.stringify(data.meta.teToca));
  assert.ok(data.meta.teToca.includes('Contestar: su pregunta (Mimi)'));
  assert.deepStrictEqual(col(data, 'firma').tarjetas.map((c) => c.quien).sort(), ['Eva', 'Lia']);
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.quien === 'Paz'), 'una pregunta sigue en curso');
});

test('T272 Dialogs_TestSession: la sesión que lanzó otra sesión no cuenta; sin árbol de procesos, cuenta como una más', async () => {
  const m = parkMachine();
  const now = Date.now();
  const session = (sid, name, pid, status) => fs.writeFileSync(path.join(m.sessions, `${sid}.json`), JSON.stringify({ pid, sessionId: sid, name, status, statusUpdatedAt: now, cwd: m.root }));
  session('hija', 'sonda', process.pid, 'waiting');
  session('madre', 'Rojas', process.ppid, 'busy');
  const tree = [{ pid: process.pid, ppid: 77777 }, { pid: 77777, ppid: process.ppid }, { pid: process.ppid, ppid: 1 }];
  const seen = await collectAt(m, now, { processes: tree });
  const a = byName(seen, 'sonda');
  assert.strictEqual(a.comoTrabaja, 'Sesión de prueba');
  assert.ok(!['firma', 'pregunta'].includes(a.estado), a.estado);
  assert.ok(!a.espera, 'no dice que espera tu respuesta');
  assert.deepStrictEqual(seen.meta.teToca, [], 'no le toca a nadie');
  const { wipNow } = require(path.join(path.dirname(OFFICE), 'work-in-progress.js'));
  const said = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs, processes: tree });
  assert.doesNotMatch(said.text, /Te pregunta|Tu firma/, '/wip dice lo mismo');
  assert.match(said.text, /sonda/);
  const blind = await collectAt(m, now, { processes: null });
  assert.strictEqual(byName(blind, 'sonda').estado, 'pregunta', 'sin árbol no se sabe');
  const unrelated = await collectAt(m, now, { processes: [{ pid: process.pid, ppid: 1 }] });
  assert.strictEqual(byName(unrelated, 'sonda').estado, 'pregunta', 'una sesión de verdad no desciende de otra');
});

test('T273 Stopped_NeverLate: la sesión parada no se pasó de la hora: la de una persona la espera, y una de fondo no anotó qué espera', () => {
  const idle = { status: 'idle', statusAt: NOW - 3600000 };
  const late = { kind: 'loose', text: 'la mesa del 4/11', endAt: NOW - 1800000, hourAt: NOW - 7200000, promiseAt: NOW - 7200000 };
  const said = new Map([['p', { encargo: 'la clase 8', haciendoAhora: null }], ['b', { encargo: 'el encargo', haciendoAhora: null }]]);
  const { data } = buildOffice({
    wip: wip([{ session: 'Mesa', sid: 'p', ...idle, extra: late }, { session: 'Fondo', sid: 'b', ...idle, extra: late }]),
    personSessions: new Set(['p']),
    transcripts: said,
    nowMs: NOW,
  });
  const person = byName(data, 'Mesa');
  assert.strictEqual(person.estado, 'parada');
  assert.strictEqual(person.fin.hora, 'espera a su persona');
  assert.match(person.fin.dif, /^desde las \d\d:\d\d$/);
  assert.strictEqual(person.fin.cls, '');
  assert.strictEqual(person.encargo, undefined, 'su primer mensaje no contradice al trabajo de ahora');
  assert.ok(!person.atrasada && !person.atrasoMin && !person.estimadaIso);
  const bg = byName(data, 'Fondo');
  assert.strictEqual(bg.fin.dif, 'parada, no anotó qué espera');
  assert.strictEqual(bg.fin.cls, '');
  assert.strictEqual(bg.encargo, 'el encargo');
  assert.doesNotMatch(JSON.stringify(data.agents), /se pasó de la hora/);
});

test('T274 Stuck_GroupedAndNeverGreen: quien declaró una espera sale «Esperando», y se agrupa por a quién espera', () => {
  const note = (waitingFor) => ({ kind: 'note', text: 'algo', waitingFor, waitingSince: NOW - 60000 });
  const { data } = buildOffice({
    wip: wip([
      { session: 'Coordinadora', sid: 'c', extra: { kind: 'note', text: 'coordina' } },
      { session: 'Casco', extra: note('que la Coordinadora le muestre el texto') },
      { session: 'Solari', extra: note('la CI del #919 y la decisión de la coordinadora') },
      { session: 'Rojas', extra: note('que entren #915 y #6117') },
      { session: 'Enzo', extra: note('la prueba del dueño') },
      { session: 'Paz', extra: { kind: 'note', text: 'sigue' } },
      { session: 'Dora', status: 'waiting_for_permission', extra: note('otra cosa') },
    ]),
    coordinatorSid: 'c',
    coordinatorName: 'Coordinadora',
    nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Casco').estado, 'esperando');
  assert.strictEqual(byName(data, 'Paz').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Dora').estado, 'firma', 'lo que te pide a vos manda');
  assert.deepStrictEqual(data.meta.trabado, [
    { titulo: '2 esperan a la Coordinadora', filas: ['Casco: que la Coordinadora le muestre el texto', 'Solari: la CI del #919 y la decisión de la coordinadora'] },
    { titulo: '1 espera al dueño', filas: ['Enzo: la prueba del dueño'] },
    { titulo: '1 espera otra cosa', filas: ['Rojas: que entren #915 y #6117'] },
  ]);
  const none = buildOffice({ wip: wip([{ session: 'Paz', extra: { kind: 'note', text: 'sigue' } }]), nowMs: NOW }).data;
  assert.deepStrictEqual(none.meta.trabado, []);
});

test('T275 YourTurn_OnlySignaturesAndTheList: «Te toca» suma la lista del tablero; lo que diga una nota no aparece', () => {
  const board = buildBoard({ meta: { teToca: ['Decidir el tercer cambio'] }, pendientes: [{ titulo: 'CI del público', estado: 'espera', nota: 'falta tu decisión' }] });
  const { data } = buildOffice({ wip: wip([]), board, signatures: [{ id: 'f', title: 'el tope', at: NOW }], nowMs: NOW });
  assert.strictEqual(data.meta.teToca.length, 2, JSON.stringify(data.meta.teToca));
  assert.match(data.meta.teToca[0], /el tope/);
  assert.strictEqual(data.meta.teToca[1], 'Decidir el tercer cambio');
  const html = page(data);
  assert.match(html, /Nada por ahora: no hay firmas pendientes ni pedidos en el tablero\./);
  assert.match(html, /<div class="resumen" id="resumen">/, 'siempre a la vista');
  assert.ok(html.indexOf('id="resumen"') < html.indexOf('id="office"'), 'arriba de todo');
  assert.ok(html.indexOf('id="you"') > html.indexOf('id="resumenListas"'), 'las listas se abren desde la línea');
  assert.ok(html.indexOf('id="trabado"') > html.indexOf('id="resumenListas"'));
  assert.doesNotMatch(html, /"Te toca: "\+t\.teToca/, 'no se dice dos veces');
});

test('T278 Kanban_Finished_OnlyToday: «Terminados» es lo de hoy con su hora, lo último primero; lo demás va a la tabla «Hechos»', () => {
  const d = new Date(NOW);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (x, hh) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${hh}`;
  const before = new Date(NOW - 86400000);
  const board = buildBoard({ pendientes: [
    { titulo: 'De esta mañana', estado: 'hecho', realIso: iso(d, '00:10') },
    { titulo: 'De hace un rato', estado: 'hecho', realIso: iso(d, '00:20') },
    { titulo: 'De ayer', estado: 'hecho', realIso: iso(before, '23:00') },
    { titulo: 'Sin hora', estado: 'hecho' },
    { titulo: 'Con pedido', estado: 'hecho', realIso: iso(before, '10:00'), pedido: { repo: 'r', numero: 5 } },
  ] });
  const prAnswers = new Map([['r#5', { pr: { state: 'merged', mergedAt: new Date(NOW - 60000).toISOString() } }]]);
  const { data } = buildOffice({ wip: wip([]), board, prAnswers, nowMs: NOW });
  assert.deepStrictEqual(data.kanban.columnas.map((c) => c.nombre), ['Sin sesión', 'En curso', 'Tu firma', 'Esperan entrar', 'Terminados']);
  assert.deepStrictEqual(titles(data, 'hechos'), ['Con pedido', 'De hace un rato', 'De esta mañana'], 'la hora del pedido manda sobre la anotada');
  assert.deepStrictEqual(data.kanban.anteriores.map((c) => c.titulo), ['De ayer', 'Sin hora']);
  for (const c of [...col(data, 'hechos').tarjetas, ...data.kanban.anteriores]) assert.ok(!('terminadoMs' in c), 'el dato interno no sale');
});

test('T279 OtherProject_NotCounted: una sesión de un repo que el arnés no sigue se dibuja y no cuenta; si no se sabe, cuenta', async () => {
  const m = parkMachine();
  const now = Date.now();
  const ours = originRepo(m, 'nuestro', 'https://github.com/acme/repo.git');
  const theirs = originRepo(m, 'ajeno', 'https://github.com/otra/ajeno.git');
  const session = (sid, name, cwd) => {
    fs.writeFileSync(path.join(m.sessions, `${sid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, name, status: 'busy', statusUpdatedAt: now, cwd }));
    fs.writeFileSync(path.join(m.state, 'doing', `${sid}.json`), JSON.stringify({ text: `lo de ${name}`, at: atIso(now - 60000), cwd }));
  };
  session('n', 'Nuestra', ours);
  session('a', 'Mesa', theirs);
  fs.writeFileSync(path.join(m.state, 'stuck-prs-photo.json'), JSON.stringify({ at: new Date(now).toISOString(), lecturas: { 'acme/repo': { ok: true, value: [] } } }));
  const data = await collectAt(m, now);
  assert.strictEqual(byName(data, 'Mesa').comoTrabaja, 'Otro proyecto');
  assert.notStrictEqual(byName(data, 'Nuestra').comoTrabaja, 'Otro proyecto');
  const card = col(data, 'curso').tarjetas.find((c) => /Mesa/.test(c.quien));
  assert.strictEqual(card.quien, 'Mesa · Otro proyecto');
  assert.strictEqual(card.otro, true);
  assert.ok(!col(data, 'curso').tarjetas.find((c) => c.quien === 'Nuestra').otro);
  assert.match(page(data), /list\.filter\(i=>!i\.otro\)\.length/, 'la columna no lo cuenta');
  fs.unlinkSync(path.join(m.state, 'stuck-prs-photo.json'));
  assert.notStrictEqual(byName(await collectAt(m, now), 'Mesa').comoTrabaja, 'Otro proyecto', 'sin la lista de repos no se sabe');
});

// ── Etiquetas, avioncito, coordinadora y orden ───────────────────────────────────────────────────────────────────

test('T284 Labels_Switch: siempre por defecto, y la elección se recuerda; si no puede recordarla, vuelve a «Siempre»', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /<input type="radio" name="etiquetas" value="siempre" checked>/, 'como hoy, por defecto');
  assert.match(html, /value="mouse"><span>Al pasar el mouse<\/span>/);
  assert.ok(html.indexOf('name="etiquetas"') < html.indexOf('id="stage"'), 'arriba del dibujo');
  const src = html.slice(html.indexOf('const ETIQUETAS_KEY='), html.indexOf('function modoEtiquetas('));
  const run = (storage) => new Function('localStorage', `${src}; return { etiquetasGuardadas, guardarEtiquetas };`)(storage);
  const kept = new Map();
  const ok = run({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) });
  assert.strictEqual(ok.etiquetasGuardadas(), 'siempre');
  ok.guardarEtiquetas('mouse');
  assert.strictEqual(ok.etiquetasGuardadas(), 'mouse');
  kept.set('office.etiquetas', '<raro>');
  assert.strictEqual(ok.etiquetasGuardadas(), 'siempre');
  const broken = run({ getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } });
  assert.strictEqual(broken.etiquetasGuardadas(), 'siempre');
  assert.doesNotThrow(() => broken.guardarEtiquetas('mouse'));
  assert.match(html, /\.stage\.solo-mouse \.tag\{opacity:0;pointer-events:none\}/, 'ocultas, pero el teclado llega');
  assert.match(html, /\.stage\.solo-mouse \.tag\.ver,\.stage\.solo-mouse \.tag\.sel,\.stage\.solo-mouse \.tag:focus-visible\{opacity:1/);
  assert.match(html, /e\.pointerType==="touch"&&!\(h&&\(h\.object===pnlFace\|\|h\.object===signFace\|\|h\.object===lampHit\)\)\)\{verEtiqueta/, 'al tocar, muestra la etiqueta y no abre el detalle');
  assert.doesNotMatch(html, /solo-mouse[^}]*\.sobre/, 'el avioncito no se oculta');
});

test('T285 PaperPlane: el mensaje vuela como avioncito, apuntando adonde va, y su rótulo lleva un dibujo sin internet', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.doesNotMatch(html, /sobreGeo|solapaGeo|✉/, 'el sobre ya no está');
  assert.match(html, /new THREE\.Mesh\(avionGeo,avionMat\)/);
  assert.match(html, /v\.m\.rotation\.set\(-Math\.cos\(k\*Math\.PI\)\*\.3,Math\.atan2\(/, 'con la nariz hacia su destino');
  assert.match(html, /dib\.append\(T\.dibujo\(T\.AVION_ICONO\)\)/);
  assert.match(html, /v\.s\.de\+" → "\+v\.s\.a/, 'el rótulo dice quién a quién, sin el texto');
});

test('T286 Coordinator_NoHourNoRepeat: coordinar no tiene hora de fin, y «Coordinando» se dice una vez', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Coord', sid: 'c', extra: { kind: 'note', text: 'el tablero', endAt: NOW - 3600000, hourAt: NOW - 7200000, promiseAt: NOW - 7200000 } }]),
    coordinatorSid: 'c',
    coordinatorName: 'Coord',
    nowMs: NOW,
  });
  const a = byName(data, 'Coord');
  assert.strictEqual(a.estado, 'coordina');
  assert.strictEqual(a.fin, null);
  for (const k of ['termina', 'estimadaIso', 'pronosticoIso', 'atrasada', 'atrasoMin']) assert.ok(!(k in a), k);
  const html = page(data);
  assert.match(html, /a\.comoTrabaja&&a\.comoTrabaja!==s\[0\]\)chips\.appendChild\(etiquetaComo/, 'en la tarjeta');
  assert.match(html, /a\.comoTrabaja&&a\.comoTrabaja!==s\[0\]\)panel\.querySelector\("\.chips"\)/, 'en el detalle');
  assert.match(html, /a\.comoTrabaja&&a\.comoTrabaja!==s\[0\]\?\[T\.iconoComo/, 'en el dibujo');
  const only = html.slice(html.indexOf('const SOLO_COORDINA='), html.indexOf('\n', html.indexOf('const SOLO_COORDINA=')));
  const re = new Function(`${only}; return SOLO_COORDINA;`)();
  assert.ok(re.test('Coordina las sesiones de esta máquina') && re.test('Coordina las sesiones de esta máquina.'));
  assert.ok(!re.test('Coordina las sesiones y revisa el tablero'), 'lo que diga algo más se muestra');
});

test('T287 InProgress_ByEndHour: lo que termina antes va arriba; lo que espera o no tiene hora, después; la coordinadora, al final', () => {
  const end = (min) => ({ kind: 'loose', text: 'algo', endAt: NOW + min * 60000, hourAt: NOW - 60000, promiseAt: NOW - 60000 });
  const { data } = buildOffice({
    wip: wip([
      { session: 'Coord', sid: 'c', extra: { kind: 'note', text: 'el tablero' } },
      { session: 'Sinhora', extra: { kind: 'loose', text: 'sin hora' } },
      { session: 'Espera', extra: { kind: 'note', text: 'espera', waitingFor: 'un aviso', waitingSince: NOW - 60000, endAt: NOW + 60000 } },
      { session: 'Tarde', extra: end(90) },
      { session: 'Pronto', extra: end(10) },
    ]),
    coordinatorSid: 'c',
    coordinatorName: 'Coord',
    nowMs: NOW,
  });
  const order = col(data, 'curso').tarjetas.map((c) => c.quien);
  assert.deepStrictEqual(order.slice(0, 2), ['Pronto', 'Tarde']);
  assert.deepStrictEqual(order.slice(2, 4).sort(), ['Espera', 'Sinhora']);
  assert.strictEqual(order[order.length - 1], 'Coord');
});

test('T289 InProgress_StateAtAGlance: cada tarjeta de «En curso» dice cómo va, de lo que calculó la oficina con su margen de 15 minutos', () => {
  const end = (min, promised) => ({ kind: 'loose', text: 'algo', endAt: NOW + min * 60000, hourAt: NOW - 60000, promiseAt: NOW - 60000, promisedAt: NOW + promised * 60000 });
  const { data } = buildOffice({
    wip: wip([
      { session: 'Enhora', extra: end(30, 30) },
      { session: 'Margen', extra: end(40, 30) },
      { session: 'Antes', extra: end(10, 60) },
      { session: 'Tarde', extra: end(60, 30) },
      { session: 'Pasada', extra: end(-10, -10) },
      { session: 'Espera', extra: { kind: 'note', text: 'espera', waitingFor: 'un aviso', waitingSince: NOW - 60000 } },
      { session: 'Sinhora', extra: { kind: 'loose', text: 'sin hora' } },
    ]),
    nowMs: NOW,
  });
  const html = page(data);
  const fn = html.slice(html.indexOf('function estadoDeHora('), html.indexOf('function renderBoard('));
  const stateOf = new Function(`${fn}; return estadoDeHora;`)();
  const said = Object.fromEntries(col(data, 'curso').tarjetas.map((c) => [c.quien, (stateOf(c) || [null])[0]]));
  assert.deepStrictEqual(said, { Enhora: 'En hora', Margen: 'En hora', Antes: 'En hora', Tarde: 'Pasada de la hora', Pasada: 'Pasada de la hora', Espera: 'Esperando', Sinhora: null });
  assert.match(html, /c\.id==="curso"&&estadoDeHora\(i\)/, 'sólo en «En curso»');
});

test('T290 OpenPrs_OnlyMine: la columna muestra sólo los pedidos de la persona, de cualquier repo; sin saber quién es, ninguno y lo dice', async () => {
  const m = toyMachine();
  const read = () => collect({ envelopes: createEnvelopes(), stateDir: m.state, sessionsDir: m.sessions, home: m.root, now: atIso(NOW), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }) });
  const pr = (number, more) => ({ number, title: `fix(algo): arreglo ${number}`, sourceBranch: `fix/${number}`, draft: false, autoComplete: true, inQueue: false, ...more });
  const own = (o) => fs.writeFileSync(path.join(m.state, 'own-prs.json'), JSON.stringify({ at: atIso(NOW - 60000), lecturas: {}, fallos: [], ...o }));
  fs.writeFileSync(path.join(m.state, 'stuck-prs-photo.json'), JSON.stringify({ at: atIso(NOW - 60000), lecturas: { 'org/pub': { ok: true, value: [pr(1), pr(2)] } } }));
  own({ lecturas: { 'org/pub': { ok: true, value: [pr(1)] }, 'biz/Mora/Back': { ok: true, value: [pr(8, { mergeState: 'conflict' }), pr(9, { draft: true })] } } });
  let data = await read();
  assert.deepStrictEqual(col(data, 'entrando').tarjetas.map((c) => [c.quien, c.motivo]).sort(), [['pedido !8', 'choca con main'], ['pedido #1', undefined]], 'lo suyo en cualquier repo; sin el de otro, sin el borrador');
  assert.match(col(data, 'entrando').nota, /^Tus pedidos en la cola o con auto-completar, leídos a las /);
  assert.ok(!('pedidosProyectos' in data), 'el grupo de otros autores ya no está');
  own({ lecturas: { 'org/pub': { ok: true, value: [pr(1)] } }, fallos: ['biz'] });
  data = await read();
  assert.deepStrictEqual(col(data, 'entrando').tarjetas.map((c) => c.quien), ['pedido #1']);
  assert.match(col(data, 'entrando').nota, /No pude leer tus pedidos de biz\.$/);
  fs.rmSync(path.join(m.state, 'own-prs.json'));
  data = await read();
  assert.deepStrictEqual(col(data, 'entrando').tarjetas, []);
  assert.match(col(data, 'entrando').nota, /No muestro pedidos: no pude saber quién sos en esta máquina\.$/);
  own({ at: atIso(NOW - 16 * 60000), lecturas: { 'org/pub': { ok: true, value: [pr(1)] } } });
  assert.deepStrictEqual(col(await read(), 'entrando').tarjetas, [], 'una lectura vieja no dice qué sigue abierto');
});

test('T293 Late_AlwaysAgainstThePromise: otra hora, anotada o de su paso, no pone «en hora»; la tarjeta, el kanban y /wip dicen lo mismo', async () => {
  const m = toyMachine();
  const promised = { startedAt: atIso(NOW - 9 * 3600000), estimate_min: 60, lastTouch: atIso(NOW - 60000) };
  const step = { step: 'run-tests', at: atIso(NOW + 30 * 60000), computedAt: atIso(NOW - 60000) };
  runMarkerFile(m, 'p', '9.1', 'Paso', BEFORE_PLAN.concat('approve-plan', 'implement'), { ...promised, horaDelPaso: step });
  sessionWith(m, 'p', 'Paso', 'busy');
  runMarkerFile(m, 'j', '9.2', 'Justa', BEFORE_PLAN.concat('approve-plan', 'implement'), { startedAt: atIso(NOW - 3600000), estimate_min: 85, lastTouch: atIso(NOW - 60000), horaDelPaso: step });
  sessionWith(m, 'j', 'Justa', 'busy');
  runMarkerFile(m, 'f', '9.3', 'Fila', BEFORE_PLAN.concat('approve-plan', 'implement'), { ...promised, horaDelPaso: step });
  sessionWith(m, 'f', 'Fila', 'idle');
  fs.mkdirSync(path.join(m.state, 'parked'), { recursive: true });
  fs.writeFileSync(path.join(m.state, 'parked', 'f.json'), JSON.stringify({ story: '9.3', kind: 'queue', at: atIso(NOW - 60000), by: 'alguien' }));
  const old = NOW - 5 * 3600000;
  runMarkerFile(m, 'd', '9.4', 'Dormida', BEFORE_PLAN.concat('approve-plan', 'implement'), { ...promised, lastTouch: atIso(old), horaDelPaso: { step: 'run-tests', at: atIso(old + 600000), computedAt: atIso(old) } });
  sessionWith(m, 'd', 'Dormida', 'idle');
  const wipData = buildWip({ stateDir: m.state, sessionsDir: m.sessions, now: atIso(NOW), home: m.root });
  const { data } = buildOffice({ wip: wipData, nowMs: NOW });
  const late = byName(data, 'Paso');
  assert.deepStrictEqual([late.fin.dif, late.fin.cls], ['+8 h 30 tarde', 'late'], 'no se pone en hora por recalcular');
  assert.deepStrictEqual([byName(data, 'Justa').fin.dif, byName(data, 'Justa').fin.cls], ['en hora', 'ontime'], 'dentro del margen sigue en hora');
  const card = col(data, 'curso').tarjetas.find((c) => c.quien === 'Paso');
  assert.match(card.hora, /\+8 h 30 tarde$/, 'el kanban dice lo mismo');
  const row = (name) => wipData.rows.find((r) => String(r.session).includes(name));
  assert.match(row('Paso').promise, /^\+8 h 30 tarde, prometida /, '/wip dice lo mismo');
  assert.match(wipData.text, /· \+8 h 30 tarde, prometida /, 'y en su tabla');
  assert.strictEqual(row('Justa').promise, undefined);
  assert.strictEqual(row('Fila').promise, undefined, 'una ejecución en fila no dice atraso');
  assert.ok(!/tarde/.test(JSON.stringify(byName(data, 'Fila').fin)), 'ni en la tarjeta');
  assert.strictEqual(row('Dormida').promise, undefined, 'una ejecución dormida tampoco');
  assert.ok(!/tarde/.test(JSON.stringify(byName(data, 'Dormida').fin)), 'ni en la tarjeta');
});

test('T295 Lamp_TogglesAndRemembers: un click la prende y la apaga con su luz, se recuerda por navegador y no le avisa a nadie', () => {
  const html = PAGE_CODE();
  const from = html.indexOf('const LAMPARA_KEY=');
  const block = html.slice(from, html.indexOf('prenderLampara(lamparaGuardada());', from));
  const load = (localStorage) => {
    const lampShade = { material: { emissiveIntensity: 9 } };
    const lampLight = { intensity: 9 };
    // eslint-disable-next-line no-new-func
    const api = new Function('localStorage', 'lampShade', 'lampLight', `${block};return{lamparaGuardada,prenderLampara,tocarLampara}`)(localStorage, lampShade, lampLight);
    api.prenderLampara(api.lamparaGuardada());
    return { ...api, lampShade, lampLight };
  };
  const store = new Map();
  const memory = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const lit = (l) => [l.lampShade.material.emissiveIntensity, l.lampLight.intensity];
  const first = load(memory);
  assert.deepStrictEqual(lit(first), [0.75, 11], 'de entrada, prendida');
  first.tocarLampara();
  assert.deepStrictEqual(lit(first), [0, 0], 'apagada, sin su luz');
  assert.deepStrictEqual(lit(load(memory)), [0, 0], 'el navegador la recuerda apagada');
  first.tocarLampara();
  assert.deepStrictEqual(lit(first), [0.75, 11]);
  assert.deepStrictEqual(lit(load(memory)), [0.75, 11]);
  const blocked = { getItem() { throw new Error('sin permiso'); }, setItem() { throw new Error('sin permiso'); } };
  const noStore = load(blocked);
  assert.deepStrictEqual(lit(noStore), [0.75, 11], 'sin dónde guardar, prendida');
  noStore.tocarLampara();
  assert.deepStrictEqual(lit(noStore), [0, 0], 'y el click anda igual');
  assert.match(html, /intersectObjects\(\[pnlFace,lampHit,/, 'se puede apuntar, y el cursor cambia con lo apuntado');
  assert.match(html, /if\(h\.object===lampHit\)\{tocarLampara\(\);return\}/, 'el click llega');
  assert.ok(!/fetch|sendBeacon|XMLHttpRequest/.test(block), 'no le avisa a nadie: las sesiones no se enteran');
});

test('T288 Conversation_ButtonAtTheBottom: el botón va abajo de cada tarjeta, alineado entre las de la misma fila', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /\.card\{[^}]*display:flex;flex-direction:column/, 'la tarjeta es una columna, y las de una fila miden lo mismo');
  assert.match(html, /\.card \.verCharla\{margin-top:auto\}/);
});

test('T283 Conversation_CoordinatorTabs: la coordinadora tiene dos pestañas y abre en «Con vos»; una sesión común también abre en «Con vos» (8.183)', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const paint = html.slice(html.indexOf('function pintarCharla('), html.indexOf('\n// ', html.indexOf('function pintarCharla(')));
  assert.match(paint, /pestanasCharla\(\[\["Con vos",vos\],\s*\["Con las sesiones",charlaPorSesion\(/);
  assert.match(paint, /pestanasCharla\(\[\["Con vos",vos\],\["Con la coordinadora",listaCharla\(filas/, 'las sesiones comunes suman «Con vos» a su lista con la coordinadora');
  const src = html.slice(html.indexOf('function listaCharla('), html.indexOf('function pintarCharla('));
  const node = (tag) => { const n = { tag, kids: [], dataset: {}, attrs: {}, classList: { contains: (c) => (n.className || '').split(' ').includes(c) }, append(...k) { n.kids.push(...k); }, setAttribute(k, v) { n.attrs[k] = v; } }; return n; };
  const el = (tag, className, text) => { const n = node(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
  const { pestanasCharla, listaCharla } = new Function('el', 'document', `${src}; return { pestanasCharla, listaCharla };`)(el, { createElement: node });
  const una = listaCharla([node('m')], 'vacío');
  una.scrollHeight = 900;
  const otra = listaCharla([node('m')], 'vacío');
  otra.scrollHeight = 700;
  const [tabs, primera, segunda] = pestanasCharla([['Con vos', una], ['Con las sesiones', otra]]);
  const radios = tabs.kids.map((l) => l.kids[0]);
  assert.deepStrictEqual(radios.map((r) => r.checked), [true, false], 'abre en «Con vos»');
  assert.deepStrictEqual([primera.hidden, segunda.hidden], [false, true]);
  radios[1].onchange();
  assert.deepStrictEqual([primera.hidden, segunda.hidden], [true, false], 'una por vez');
  assert.strictEqual(otra.scrollTop, 700, 'arranca en lo último');
  otra.scrollTop = 10;
  radios[0].onchange();
  radios[1].onchange();
  assert.strictEqual(otra.scrollTop, 10, 'volver no le mueve lo que estaba leyendo');
  assert.strictEqual(listaCharla([], 'vacío').textContent, 'vacío');
});

test('T282 Conversation_PageStaysStill: con la ventana abierta la página de atrás no se mueve, y al cerrarla vuelve a moverse', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /html\.con-ventana\{overflow:hidden\}/);
  assert.match(html, /\.ventana \.panel3,\.ventana \.chat\{overscroll-behavior:contain\}/, 'llegar al final de la lista no pasa la rueda a la página');
  const fn = (name) => { const at = html.indexOf(`function ${name}(`); return html.slice(at, html.indexOf('\n', at)); };
  assert.match(html.slice(html.indexOf('function abrirCharla('), html.indexOf('function cerrarCharla(')), /classList\.add\("con-ventana"\)/);
  assert.match(fn('cerrarCharla'), /classList\.remove\("con-ventana"\)/);
});

test('T281 Summary_OneLine: dice cuánto te toca y cuánto está trabado, destaca lo tuyo, y sin nada no hay qué abrir', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  const src = html.slice(html.indexOf('const RESUMEN_KEY='), html.indexOf('function pintarResumen('));
  const run = (storage) => new Function('localStorage', `${src}; return { lineaResumen, resumenGuardado, guardarResumen };`)(storage);
  const { lineaResumen } = run({ getItem: () => null, setItem() {} });
  assert.deepStrictEqual(lineaResumen(4, 4), { texto: 'Te toca: 4 · Trabado: 4', pide: true, vacio: false });
  assert.deepStrictEqual(lineaResumen(0, 2), { texto: 'Te toca: 0 · Trabado: 2', pide: false, vacio: false });
  assert.deepStrictEqual(lineaResumen(1, 0), { texto: 'Te toca: 1 · Trabado: 0', pide: true, vacio: false });
  assert.deepStrictEqual(lineaResumen(0, 0), { texto: 'Nada por ahora', pide: false, vacio: true });
  // se recuerda en ese navegador, y si no puede, no pasa nada
  const kept = new Map();
  const memory = run({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) });
  assert.strictEqual(memory.resumenGuardado(), false, 'arranca cerrada');
  memory.guardarResumen(true);
  assert.strictEqual(memory.resumenGuardado(), true);
  memory.guardarResumen(false);
  assert.strictEqual(memory.resumenGuardado(), false);
  const broken = run({ getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } });
  assert.strictEqual(broken.resumenGuardado(), false);
  assert.doesNotThrow(() => broken.guardarResumen(true));
  assert.match(html, /pintarResumen\(you\.length,stuck\.reduce/, 'cada foto la vuelve a pintar');
});

test('T280 Titles_OneLine: en las tarjetas y el kanban, el título va en una línea; el detalle lo dice entero', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /\.una-linea\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(html, /r\.k==="Trabajo"&&!abiertos\)\{dd\.className="una-linea";dd\.title=r\.v\}/, 'sólo en la tarjeta, con el texto entero al pasar el mouse');
  assert.match(html, /tit=el\("b","una-linea",i\.titulo\|\|""\)/);
  assert.match(html, /T\.pintarFicha\(a,panel,true\)/, 'el detalle pinta abierto');
});

test('T269 WaysOfWorking_FinishedRunNote: una nota de la sesión cuya ejecución terminó sigue diciendo su historia', async () => {
  const m = parkMachine();
  const now = Date.now();
  const repo = toyRepo(m, 'termino');
  fs.writeFileSync(path.join(m.state, 'active', 's.json'), JSON.stringify({ sessionId: 's', storyId: '8.153', storyPath: storyFile(m, '8.153', 'La lista'), repoPath: repo, stepScheme: STEP_LIB.SCHEME, ...CLOSED, startedAt: oldHours(now, 3), lastTouch: oldHours(now, 1) }));
  fs.writeFileSync(path.join(m.sessions, 's.json'), JSON.stringify({ pid: process.pid, sessionId: 's', name: 'Quintero', status: 'busy', statusUpdatedAt: now, cwd: repo }));
  fs.writeFileSync(path.join(m.state, 'doing', 's.json'), JSON.stringify({ text: 'espera la cola', at: atIso(now - 60000) }));
  const a = byName(await collectAt(m, now), 'Quintero');
  // la ejecución terminada sin cerrar es la tarjeta, y la nota es lo que hace mientras tanto; ocupada, trabaja
  assert.strictEqual(a.tipo, 'finished');
  assert.strictEqual(a.estado, 'trabajando');
  assert.strictEqual(a.haciendo, 'Terminó la story 8.153: falta cerrarla.');
  assert.strictEqual(a.comoTrabaja, 'Historia 8.153');
  assert.strictEqual(a.mientras, 'espera la cola');
});

test('T267 Conversation_OnlyInItsWindow: el botón va sólo con la oficina viva, la ventana se cierra con Esc y la foto no trae el texto', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  // el botón va con de dónde pedirla: la oficina viva o el sitio; la foto fija no tiene
  assert.match(html, /if\(a\.nombre&&pedidoDeCharla\(p\)\)box\.appendChild\(botonCharla\(a\.nombre,p\)\)/, 'sin de dónde pedirla no hay botón');
  assert.match(html, /createTextNode\("Ver conversación"\)/);
  assert.match(html, /s\.appendChild\(dibujo\(CHARLA_ICONO\)\)/, 'lleva su ícono, dibujado en la página');
  assert.match(html, /\.ventana \.panel3\{[^}]*height:min\(920px,calc\(100dvh - 32px\)\)/, 'la ventana entra en la pantalla');
  assert.match(html, /\.ventana \.panel3 \.chat\{[^}]*overflow:hidden auto/, 'y los mensajes suben y bajan adentro');
  // Escape cierra la de arriba, y tocar afuera cierra sólo con un toque que empieza afuera (8.198, AC 33 y 34)
  assert.match(html, /e\.key!=="Escape"\)return;if\(!ventana\(\)\.hidden\)\{cerrarCharla\(\);return\}/);
  assert.match(html, /id="ventana" hidden/, 'arranca cerrada');
  assert.match(html, /v\.addEventListener\("click",e=>\{if\(e\.target===e\.currentTarget&&empezoAfuera\)cerrarCharla\(\)/, 'tocando afuera se cierra');
  const opensAt = html.indexOf('function abrirCharla(');
  assert.ok(opensAt >= 0);
  assert.strictEqual(html.indexOf('fetch(pedidoDeCharla('), html.indexOf('fetch(pedidoDeCharla(', opensAt), 'se lee sólo al abrirla');
  assert.doesNotMatch(html.slice(html.indexOf('function abrir(nombre'), html.indexOf('los sobres: quién')), /conversacion|pintarCharla/, 'el detalle ya no la lee');
});

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
const SESSION_STATE = require(path.join(__dirname, '..', 'lib', 'session-state.js'));
const codexFile = (m, sid, patch = {}, now = NOW) => SESSION_STATE.update(m.state, sid, { sentence: SESSION_STATE.NO_PIPELINE, busy: false, ...patch }, { create: true, tool: 'codex', now });

test('T296 CodexAgentsUnder: cuenta los agentes bajo la sesión, una vez cada uno, y no lo que sólo los nombra', () => {
  const { codexAgentsUnder } = require(OFFICE);
  const tree = [
    { pid: 11, ppid: 10, comando: '/bin/zsh -c codex exec -p revisor' },
    { pid: 12, ppid: 11, comando: 'node /opt/node/bin/codex exec -p revisor --sandbox read-only' },
    { pid: 13, ppid: 12, comando: '/opt/node/lib/vendor/bin/codex exec -p revisor --sandbox read-only' },
    { pid: 14, ppid: 10, comando: 'codex exec ok' },
    { pid: 15, ppid: 10, comando: 'grep codex exec notas.txt' },
    { pid: 16, ppid: 10, comando: 'node guion.js codex exec' },
    { pid: 17, ppid: 10, comando: 'codex resume' },
    { pid: 21, ppid: 20, comando: 'codex exec de otra sesion' },
  ];
  assert.strictEqual(codexAgentsUnder(10, tree), 2, 'el lanzador de Node y su programa son uno solo');
  assert.strictEqual(codexAgentsUnder(99, tree), 0);
  assert.strictEqual(codexAgentsUnder(10, null), null, 'sin la lista de procesos no se sabe');
  assert.strictEqual(codexAgentsUnder(null, tree), null, 'sin el proceso de la sesión tampoco');
});

test('T297 ClaudeAgentsActive: cuenta los archivos de agentes tocados hace poco, sueltos y en tandas', () => {
  const { claudeAgentsActive } = require(OFFICE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-agentes-'));
  const transcript = path.join(root, 's.jsonl');
  const subagents = path.join(root, 's', 'subagents');
  const batch = path.join(subagents, 'workflows', 'wf_nueva');
  const oldBatch = path.join(subagents, 'workflows', 'wf_vieja');
  fs.mkdirSync(batch, { recursive: true });
  fs.mkdirSync(oldBatch, { recursive: true });
  const now = Date.now();
  const write = (file, at) => { fs.writeFileSync(file, '{}\n'); fs.utimesSync(file, new Date(at), new Date(at)); };
  write(path.join(subagents, 'agent-a.jsonl'), now - 60000);
  write(path.join(subagents, 'agent-viejo.jsonl'), now - 4 * 60000);
  write(path.join(subagents, 'agent-a.meta.json'), now - 60000);
  write(path.join(batch, 'agent-b.jsonl'), now - 120000);
  write(path.join(batch, 'journal.jsonl'), now - 1000);
  write(path.join(oldBatch, 'agent-c.jsonl'), now - 1000);
  fs.utimesSync(oldBatch, new Date(now - 7 * 3600000), new Date(now - 7 * 3600000));
  assert.strictEqual(claudeAgentsActive(transcript, now), 2);
  assert.strictEqual(claudeAgentsActive(path.join(root, 'sin-agentes.jsonl'), now), 0);
});

test('T298 Agents_SaidOnTheCard: cuántos y qué hacen; «Unos» sólo con agentes de Claude, y nada sin agentes', () => {
  const said = (running, extra) => byName(buildOffice({
    wip: wip([{ session: 'Tero', sid: 't', extra }]), runningAgents: running ? new Map([['t', running]]) : new Map(), nowMs: NOW,
  }).data, 'Tero').agentesAhora;
  const adversarial = { kind: 'pipeline', current: 'adversarial-pass' };
  assert.strictEqual(said({ codex: 3, claude: 0 }, adversarial), '3 agentes revisando');
  assert.strictEqual(said({ codex: 3, claude: 0 }, { kind: 'pipeline', current: 'reviewers' }), '3 agentes revisando');
  assert.strictEqual(said({ codex: 3, claude: 0 }, { kind: 'pipeline', current: 'implement' }), '3 agentes trabajando');
  assert.strictEqual(said({ codex: 3, claude: 0 }, { kind: 'loose' }), '3 agentes trabajando');
  assert.strictEqual(said({ codex: 1, claude: 0 }, adversarial), '1 agente revisando');
  assert.strictEqual(said({ codex: 1, claude: 2 }, adversarial), 'Unos 3 agentes revisando');
  assert.strictEqual(said({ codex: 0, claude: 3 }, { kind: 'loose' }), 'Unos 3 agentes trabajando');
  assert.strictEqual(said(null, adversarial), undefined, 'sin agentes el renglón no aparece');
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html.slice(html.indexOf('function ficha(a,abiertos)')), /if\(a\.agentesAhora\)r\.push\(\{k:"",v:a\.agentesAhora\}\)/, 'la tarjeta y el panel lo dicen');
});

test('T299 Agents_NotFree: una sesión quieta con agentes corriendo trabaja y sale de «Libres»; sin agentes sigue libre', () => {
  const { data } = buildOffice({
    wip: wip([], { free: ['Tero', 'Hornero'], freeSids: ['t', 'h'] }), runningAgents: new Map([['t', { codex: 0, claude: 2 }]]), nowMs: NOW,
  });
  assert.strictEqual(byName(data, 'Tero').estado, 'trabajando');
  assert.strictEqual(byName(data, 'Tero').haciendo, 'Unos 2 agentes trabajando');
  assert.strictEqual(byName(data, 'Hornero').estado, 'libre');
  assert.deepStrictEqual(data.free, ['Hornero']);
});

test('T300 Agents_NotSessions: el Codex de un guion no ocupa lugar; una sesión de Codex y el que corre una ejecución sí', async () => {
  const m = parkMachine();
  const now = Date.now();
  const codexHome = toyCodexBase(m, [
    { id: '01a19f73-aaaa', source: 'exec' }, { id: '01a19f73-bbbb', source: 'exec' }, { id: 'sub-1', source: 'cli', thread_source: 'subagent' },
    { id: 'persona', source: 'cli' }, { id: 'exec-con-paso', source: 'exec' }, { id: 'exec-con-trabajo', source: 'exec' },
  ]);
  for (const sid of ['01a19f73-aaaa', '01a19f73-bbbb', 'sub-1', 'persona']) codexFile(m, sid, {}, now);
  codexFile(m, 'exec-con-paso', { step: 'Implementar' }, now);
  codexFile(m, 'exec-con-trabajo', { sentence: 'Arregla los avisos.' }, now);
  const data = await collectAt(m, now, { codexHome, processes: null });
  const names = data.agents.map((a) => a.nombre);
  assert.ok(!names.some((n) => n.startsWith('01a19f73') || n.startsWith('sub-1')), `salieron como personas: ${names}`);
  for (const sid of ['persona', 'exec-con-paso', 'exec-con-trabajo']) assert.ok(names.includes(sid.slice(0, 8)), `falta ${sid}: ${names}`);
  assert.deepStrictEqual(data.unreadable.filter((p) => /lista de sesiones de Codex/.test(p)), []);
});

test('T301 Agents_UnknownBase: si la base de Codex no se puede leer no se oculta a nadie, y se dice una sola vez', async () => {
  const m = parkMachine();
  const now = Date.now();
  const dir = path.join(m.home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state_5.sqlite'), 'esto no es una base');
  codexFile(m, 'exec-1', {}, now);
  codexFile(m, 'exec-2', {}, now);
  const data = await collectAt(m, now, { codexHome: dir, processes: null });
  assert.ok(data.agents.some((a) => a.nombre === 'exec-1'));
  assert.ok(data.agents.some((a) => a.nombre === 'exec-2'));
  const said = data.unreadable.filter((p) => p === 'No pude leer la lista de sesiones de Codex: alguna de estas personas puede ser un agente.');
  assert.strictEqual(said.length, 1);
});

test('T302 Agents_CountedForTheirSession: la foto cuenta los agentes bajo el proceso de la sesión; sin procesos no dice cuántos', async () => {
  const m = parkMachine();
  const now = Date.now();
  const codexHome = toyCodexBase(m, [{ id: 'agente-1', source: 'exec' }]);
  codexFile(m, 'agente-1', { busy: true }, now);
  fs.writeFileSync(path.join(m.sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'tero', name: 'Tero', status: 'idle', statusUpdatedAt: now - 3600000, updatedAt: now - 3600000 }));
  const processes = [{ pid: process.pid + 100000, ppid: process.pid, comando: 'node /x/bin/codex exec -p revisor' }];
  const withTree = await collectAt(m, now, { codexHome, processes });
  assert.strictEqual(byName(withTree, 'Tero').haciendo, '1 agente trabajando');
  assert.strictEqual(byName(withTree, 'agente-1'), undefined);
  const noTree = await collectAt(m, now, { codexHome, processes: null });
  assert.strictEqual(byName(noTree, 'Tero').estado, 'libre', 'sin la lista de procesos no dice cuántos, y nunca dice 0');
  assert.ok(!/agente/.test(JSON.stringify(byName(noTree, 'Tero'))));
});

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

test('T303 PerSession_Buttons: la más reciente abierta, en orden, y sus mensajes con los propios marcados', () => {
  const { charlaPorSesion } = perSessionCode();
  const box = charlaPorSesion('Coordinadora', toySessions(3), 'nada');
  const [fila, chat] = box.children;
  assert.deepStrictEqual(fila.children.map((b) => b.textContent), ['S0', 'S1', 'S2']);
  assert.deepStrictEqual(fila.children.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepStrictEqual(chat.children.map((m) => [m.quien, m.mio]), [['S0', false], ['Coordinadora', true]]);
  assert.strictEqual(fila.children[0].children[0].textContent.length, 5, 'el botón dice su hora');
});

test('T304 PerSession_Choosing: tocar otra sesión cambia los mensajes y cuál está elegida', () => {
  const { charlaPorSesion } = perSessionCode();
  const box = charlaPorSesion('Coordinadora', toySessions(3), 'nada');
  const fila = box.children[0];
  fila.children[2].onclick();
  assert.deepStrictEqual(fila.children.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assert.strictEqual(box.children[1].children[0].texto, 'de S2');
  assert.strictEqual(box.children.length, 2, 'una sola conversación a la vista');
});

test('T305 PerSession_TheOthers: de más de 8 quedan «Las otras N», que al tocarlo muestra el resto y se va; con 8 no aparece', () => {
  const { charlaPorSesion } = perSessionCode();
  const fila = charlaPorSesion('Coordinadora', toySessions(13), 'nada').children[0];
  assert.strictEqual(fila.children.length, 9);
  const mas = fila.children[8];
  assert.strictEqual(mas.textContent, 'Las otras 5');
  mas.onclick();
  assert.deepStrictEqual(fila.children.map((b) => b.textContent), Array.from({ length: 13 }, (_, i) => `S${i}`));
  fila.children[12].onclick();
  assert.strictEqual(fila.children[12].getAttribute('aria-pressed'), 'true', 'una de las otras se puede elegir');
  assert.ok(!charlaPorSesion('Coordinadora', toySessions(8), 'nada').children[0].children.some((b) => b.className === 'mas'));
});

test('T306 PerSession_Empty_AndTheHour: sin mensajes lo dice; la hora lleva el día si no es de hoy', () => {
  const { charlaPorSesion, horaDeSesion } = perSessionCode();
  const empty = charlaPorSesion('Coordinadora', [], 'No hay mensajes con las sesiones en lo último de su conversación.');
  assert.match(empty.textContent, /^No hay mensajes con las sesiones/);
  const hoy = new Date();
  hoy.setHours(9, 5, 0, 0);
  assert.strictEqual(horaDeSesion(hoy.getTime()), '09:05');
  const otro = new Date(hoy.getTime() - 3 * 86400000);
  assert.match(horaDeSesion(otro.getTime()), /^(dom|lun|mar|mié|jue|vie|sáb) 09:05$/);
  assert.strictEqual(horaDeSesion(null), '');
});

test('T307 PerSession_Page: la ventana usa la conversación por sesión y la nota habla de cada sesión', () => {
  const html = page({ agents: [], items: [], kanban: null, meta: null });
  assert.match(html, /\["Con las sesiones",charlaPorSesion\(nombre,d\.conSesiones\|\|\[\],/);
  assert.match(html, /los últimos 10 con cada sesión, en orden; primero la que habló último\./);
  assert.match(html, /@media \(max-width:600px\)\{\.ventana \.quienes\{flex-wrap:nowrap;overflow-x:auto/, 'en un teléfono, una sola fila');
});

const WALL_ORDER = ['Tu firma', 'En curso', 'Esperan entrar', 'A medio camino', 'Sin sesión', 'Terminados'];
const toyCards = (n) => Array.from({ length: n }, (_, i) => ({ titulo: `Trabajo ${i}`, quien: 'Tero' }));
const toyKanban = (over = {}) => ({ columnas: [['sinEmpezar', 'Sin sesión'], ['curso', 'En curso'], ['firma', 'Tu firma'], ['entrando', 'Esperan entrar'], ['hechos', 'Terminados']].map(([id, nombre]) => ({ id, nombre, tarjetas: toyCards(over[id] || 0) })), medioCamino: toyCards(over.medio || 0).map((c) => ({ titulo: c.titulo, accion: 'Abrí un pedido' })) });

test('T308 Wall_Order: el panel y su detalle listan primero lo que se está trabajando, y «Te toca» va primero', () => {
  const data = { agents: [], items: [], kanban: toyKanban({ sinEmpezar: 1, curso: 1, firma: 1, entrando: 1, hechos: 1, medio: 1 }), meta: { actualizado: '10:00', teToca: ['Firmar'] } };
  const wall = wallTexts(data);
  assert.deepStrictEqual(wall.filter((t) => WALL_ORDER.includes(t)), WALL_ORDER);
  assert.ok(wall.indexOf('Te toca: 1') < wall.indexOf('Tu firma'), 'el dibujo dice «Te toca» antes que las cuentas');
  const panel = openWallPanel(data);
  assert.deepStrictEqual(all(panel, (n) => n.className === 'cnt').map((c) => textOf(c.children[1])), WALL_ORDER);
  const heads = panel.children.filter((k) => k.tag === 'h4').map(textOf);
  assert.deepStrictEqual(heads, ['Te toca', ...WALL_ORDER.map((n) => `${n} · 1`)]);
});

test('T309 Wall_Folds: Sin sesión y Terminados se pliegan con más de 5; lo que se trabaja nunca, y lo abierto sigue abierto', () => {
  const data = { agents: [], items: [], kanban: toyKanban({ sinEmpezar: 12, curso: 7, hechos: 5, medio: 6 }), meta: { actualizado: '10:00', teToca: [] } };
  const panel = openWallPanel(data);
  const after = (name) => panel.children[panel.children.findIndex((k) => k.tag === 'h4' && textOf(k).startsWith(name)) + 1];
  assert.strictEqual(after('Sin sesión').className, 'verTodos');
  assert.strictEqual(textOf(after('Sin sesión')), 'Ver los 12');
  assert.strictEqual(after('En curso').children.length, 7, 'lo que se trabaja, siempre a la vista');
  assert.strictEqual(after('A medio camino').children.length, 6);
  assert.strictEqual(after('Terminados').children.length, 5, 'con 5 todavía no se pliega');
  const again = openWallPanel(data, ['sinEmpezar']);
  assert.strictEqual(again.children[again.children.findIndex((k) => k.tag === 'h4' && textOf(k).startsWith('Sin sesión')) + 1].children.length, 12, 'abierta, sigue abierta con la foto nueva');
});

test('T315 OldWait_BusySession_Works: una espera anotada hace rato no le gana a la sesión ocupada; la reciente, o con la sesión quieta, sigue', async () => {
  const m = parkMachine();
  const now = Date.now();
  runMarkerFile(m, 'g', '9.3', 'La suite de Gallardo', BEFORE_PLAN.concat('approve-plan'), { startedAt: oldHours(now, 5), lastTouch: oldHours(now, 1) });
  const wait = (sid, mins) => fs.writeFileSync(path.join(m.state, 'doing', `${sid}.json`), JSON.stringify({ at: atIso(now - mins * 60000), waitingFor: 'turno de suite (N.º 2)', waitingSince: atIso(now - mins * 60000) }));
  wait('g', 40);
  sessionWith(m, 'g', 'Gallardo', 'busy', now);
  const said = async () => {
    const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
    const i = w.rows.findIndex((r) => r.session === 'Gallardo');
    return { end: w.rows[i].end, card: byName(await collectAt(m, now), 'Gallardo') };
  };
  let r = await said();
  assert.doesNotMatch(r.end, /espera turno de suite/, r.end);
  assert.notStrictEqual(r.card.estado, 'esperando');
  assert.strictEqual(r.card.titulo, 'La suite de Gallardo');
  // quieta, la espera sigue siendo lo que hace
  sessionWith(m, 'g', 'Gallardo', 'idle', now);
  r = await said();
  assert.strictEqual(r.card.estado, 'esperando');
  // recién anotada, todavía es una espera aunque esté ocupada
  wait('g', 1);
  sessionWith(m, 'g', 'Gallardo', 'busy', now);
  r = await said();
  assert.strictEqual(r.card.estado, 'esperando');
});

test('T311 TurnWait_KeepsTheStory: la espera de un turno es de la historia, no otro trabajo; una nota con texto sí la tapa', async () => {
  const m = parkMachine();
  const now = Date.now();
  runMarkerFile(m, 's', '9.3', 'Esperando turno', BEFORE_PLAN.concat('approve-plan'), { startedAt: oldHours(now, 5), lastTouch: oldHours(now, 3) });
  sessionWith(m, 's', 'Sol', 'busy', now);
  fs.writeFileSync(path.join(m.state, 'doing', 's.json'), JSON.stringify({ at: atIso(now - 60000), waitingFor: 'turno de la suite', waitingSince: atIso(now - 60000) }));
  const w = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  const i = w.rows.findIndex((r) => r.session === 'Sol');
  assert.notStrictEqual(w.rows[i].end, 'sin hora estimada (en pausa)', w.rows[i].end);
  assert.strictEqual(w.extra[i].waitingFor, 'turno de la suite');
  const data = await collectAt(m, now);
  assert.strictEqual(byName(data, 'Sol').enPausa, undefined);
  assert.strictEqual(byName(data, 'Sol').titulo, 'Esperando turno');
  assert.strictEqual(byName(data, 'Sol').estado, 'esperando');
  fs.writeFileSync(path.join(m.state, 'doing', 's.json'), JSON.stringify({ text: 'otro trabajo encima', at: atIso(now - 60000) }));
  const w2 = await wipNow({ home: m.home, now: atIso(now), queryAll: noPrs });
  assert.strictEqual(w2.rows[w2.rows.findIndex((r) => r.session === 'Sol')].end, 'sin hora estimada (en pausa)');
});

// ── Hablarle a una sesión desde la oficina ─────────────────────────────────────────────────────────────────────────

const { markRecipients, conversationOf, createEnvelopes: createEnvelopes8183 } = require(OFFICE);
const om8183 = require(path.join(__dirname, '..', 'lib', 'office-messages.js'));
const { stateDir: stateDir8183 } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));

test('T23 Foto_PuedeRecibir_SegunElVigilante @story-8.183 @ac-22 @ac-25: vivo «si», muerto o sin candado «sin-vigilante», Codex «codex», recién entregado «espera-cierre»', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-recibe-'));
  const sdir = stateDir8183(home);
  const env = createEnvelopes8183();
  for (const [name, sid] of [['Vivo', 's1'], ['Muerto', 's2'], ['Nada', 's3'], ['Entrego', 's4']]) env.files.set(name, { file: '/x', sid });
  fs.mkdirSync(om8183.paths(sdir).watchers, { recursive: true });
  fs.writeFileSync(om8183.paths(sdir).watcher('s1'), JSON.stringify({ pid: 111, started: 'arranque-111' }));
  fs.writeFileSync(om8183.paths(sdir).watcher('s2'), JSON.stringify({ pid: 222, started: 'arranque-222' }));
  fs.writeFileSync(om8183.paths(sdir).watcher('s4'), JSON.stringify({ pid: null, deliveredAt: NOW }));
  const data = { agents: [{ nombre: 'Vivo', estado: 'libre' }, { nombre: 'Muerto', estado: 'trabajando' }, { nombre: 'Nada', estado: 'pregunta' }, { nombre: 'Entrego', estado: 'trabajando' }, { nombre: 'Cx', estado: 'libre' }, { nombre: 'SinConversacion', estado: 'libre' }] };
  const saved = process.env.TYCON_OFFICE_MESSAGES;
  delete process.env.TYCON_OFFICE_MESSAGES;
  try {
    markRecipients(data, env, [{ name: 'Cx', tool: 'codex' }], sdir, { isAlive: (pid) => pid === 111, startOf: (pid) => `arranque-${pid}` });
  } finally { if (saved !== undefined) process.env.TYCON_OFFICE_MESSAGES = saved; }
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.recibe]), [['Vivo', 'si'], ['Muerto', 'sin-vigilante'], ['Nada', 'sin-vigilante'], ['Entrego', 'espera-cierre'], ['Cx', 'codex'], ['SinConversacion', undefined]]);
  assert.strictEqual(env.recipients.get('Nada').cuadro, true);
  assert.strictEqual(env.recipients.get('Muerto').ocupada, true);
  // lo que viaja al sitio es una lista cerrada: `recibe` no está
  const { FIELDS } = require(path.join(__dirname, '..', 'tools', 'office', 'fields.js'));
  assert.ok(!JSON.stringify(FIELDS).includes('recibe'));
});

test('T52 Foto_CodexSinNombre_DiceCodex @story-8.183 @ac-25: una sesión de Codex sin nombre en su archivo, con el nombre que le pone la oficina, recibe «codex»', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-codex-'));
  const sdir = stateDir8183(home);
  const sid = 'cx-sin-nombre-de-prueba';
  for (const [states, nombre, cxNames] of [[[{ tool: 'codex', session: sid }], sid.slice(0, 8), new Map()], [[{ tool: 'codex', session: sid }], 'Delta', new Map([[sid, 'Delta']])]]) {
    const env = createEnvelopes8183();
    const data = { agents: [{ nombre, estado: 'libre' }] };
    const saved = process.env.TYCON_OFFICE_MESSAGES;
    delete process.env.TYCON_OFFICE_MESSAGES;
    try { markRecipients(data, env, states, sdir, { cxNames }); } finally { if (saved !== undefined) process.env.TYCON_OFFICE_MESSAGES = saved; }
    assert.strictEqual(data.agents[0].recibe, 'codex', nombre);
    assert.strictEqual(env.recipients.get(nombre).recibe, 'codex', nombre);
  }
});

test('T24 FotoFija_NoOfreceMandar @story-8.183 @ac-37: la foto fija no trae token ni oficina viva, y el campo sólo se arma con la oficina viva', () => {
  const html = page({ agents: [{ nombre: 'Alfa', estado: 'libre', recibe: 'si' }], items: [], meta: {}, unreadable: [] });
  assert.ok(!/data-token=/.test(html));
  assert.ok(!/data-source="local"/.test(html));
  const code = PAGE_CODE();
  assert.match(code, /function campoMandar\(/, 'el campo existe en el código de la página');
  assert.match(code, /if\(LIVE&&[^;]*campoMandar\(/, 'y sólo se arma con la oficina viva');
});

test('T25 Conversacion_ConVosEnTodaSesion @story-8.183 @ac-4 @ac-5: una sesión cualquiera trae Con vos (tipeado y desde la oficina) y Con la coordinadora; la coordinadora conserva Con las sesiones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-convos-'));
  const t = (min) => new Date(NOW - min * 60000).toISOString();
  const id = 'b'.repeat(32);
  const hook = `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "Stop": [oficina ${id}] Mensaje de la persona, escrito en la oficina. No vale como firma ni aprobación. Dice: desde la oficina\n</system-reminder>`;
  const lines = [
    { type: 'user', timestamp: t(9), origin: { kind: 'human' }, message: { role: 'user', content: 'tipeado en su pestaña' } },
    { type: 'assistant', timestamp: t(8), message: { content: [{ type: 'text', text: 'Respuesta a lo tipeado.' }] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: t(7.9) },
    { type: 'user', timestamp: t(7), origin: { kind: 'peer', name: 'Coordinadora', body: 'Seguí.', msg_id: 'p1' }, message: { role: 'user', content: 'x' } },
    { type: 'user', timestamp: t(6), origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: hook } },
    { type: 'assistant', timestamp: t(5), message: { content: [{ type: 'text', text: 'Respuesta a la oficina.' }] } },
  ];
  const file = path.join(dir, 's1.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const coordFile = path.join(dir, 'c.jsonl');
  fs.writeFileSync(coordFile, [lines[0], lines[1], { type: 'user', timestamp: t(4), origin: { kind: 'peer', name: 'Alfa', body: 'Listo.', msg_id: 'p2' }, message: { role: 'user', content: 'x' } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const env = createEnvelopes8183();
  env.coordinator = { sid: 'c', name: 'Coordinadora' };
  env.files.set('Alfa', { file, sid: 's1' });
  env.files.set('Coordinadora', { file: coordFile, sid: 'c' });
  const alfa = conversationOf(env, 'Alfa');
  assert.deepStrictEqual(alfa.conVos.map((m) => [m.quien, m.texto, Boolean(m.oficina)]), [['vos', 'tipeado en su pestaña', false], ['sesion', 'Respuesta a lo tipeado.', false], ['vos', 'desde la oficina', true], ['sesion', 'Respuesta a la oficina.', false]]);
  assert.deepStrictEqual(alfa.conCoordinadora.map((m) => m.texto), ['Seguí.']);
  const coord = conversationOf(env, 'Coordinadora');
  assert.deepStrictEqual(coord.conSesiones.map((s) => s.sesion), ['Alfa']);
  assert.deepStrictEqual(coord.conVos.map((m) => m.quien), ['vos', 'coordinadora']);
  // la página marca lo de la oficina y muestra Con vos en toda sesión
  const code = PAGE_CODE();
  assert.match(code, /desde la oficina/);
});

test('T312 Story_NumberAndTitle: el panel dice en un renglón fijo «Historia: número — título»; la tarjeta, sólo la historia', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  const fn = (name) => html.slice(html.indexOf(`function ${name}(`), html.indexOf('\n', html.indexOf(`function ${name}(`)));
  const historiaDe = new Function(`${fn('historiaDe')}; return historiaDe;`)();
  assert.strictEqual(historiaDe({ comoTrabaja: 'Historia 8.215', historiaTitulo: 'El pase', titulo: 'Una tanda' }), '8.215 — El pase');
  assert.strictEqual(historiaDe({ comoTrabaja: 'Historia 8.215', historia: 'De una foto vieja' }), '8.215 — De una foto vieja', 'una máquina con el arnés viejo');
  assert.strictEqual(historiaDe({ comoTrabaja: 'Historia 8.215' }), '8.215', 'sin título, el número solo');
  for (const como of ['Historia', 'Camino corto', 'Otra cosa', undefined]) assert.strictEqual(historiaDe({ comoTrabaja: como, historia: 'x' }), '', String(como));
  // la etiqueta de la tarjeta no lleva el título: recortado no se lee
  const etiqueta = new Function('el', 'iconoComo', `${fn('etiquetaComo')}; return etiquetaComo;`)((t, c, x) => ({ t: x, kids: [], appendChild(k) { this.kids.push(k); } }), () => ({}));
  assert.strictEqual(etiqueta('Historia 8.218', 'T-12').kids[1].t, 'Historia 8.218 · T-12');
  assert.strictEqual(etiqueta('Historia 8.218', undefined).kids[1].t, 'Historia 8.218', 'sin número, sólo la historia');
  assert.match(html, /\.como-chip>\.txt\{[^}]*text-overflow:ellipsis/);
  // el renglón fijo va sólo abierto (el panel y la ventana), junto al trabajo
  const ficha = html.slice(html.indexOf('function ficha(a,abiertos)'), html.indexOf('add("Encargo"'));
  assert.match(ficha, /add\("Trabajo",a\.titulo\);if\(!hist\)add\("De la historia",a\.historia\);else if\(abiertos\)add\("Historia",hist\)/);
  assert.match(html, /ficha\(a,abiertos\)\.forEach/);
});

test('T313 Card_OpensWindow: tocar la tarjeta de una persona abre su ventana, igual en la oficina local y en el sitio', () => {
  const { data } = buildOffice({ wip: wip([]), nowMs: NOW });
  const html = page(data);
  const fnAt = (name) => { const at = html.indexOf(`function ${name}(`); return html.slice(at, html.indexOf('\nfunction ', at + 1)); };
  assert.match(fnAt('renderCrew'), /pintarTarjetas\(crew,agents,abrirSesion\)/, 'la local');
  const oficina = fnAt('pintarOficina');
  assert.match(oficina, /pintarTarjetas\(f\.crew,lista,\(a,k\)=>\{.*?DATA=o\.foto\|\|\{\};try\{abrirSesion\(a,k\)\}finally/, 'el sitio, con la foto de esa oficina');
  assert.doesNotMatch(oficina, /T\.abrir\(/, 'el sitio ya no abre el panel de la sala');
  const abrir = fnAt('abrirSesion');
  assert.match(abrir, /fichaEnVentana\(a,box\)/, 'el mismo contenido que la ventana del tablero');
  assert.match(fnAt('abrirTarjeta'), /if\(a\)fichaEnVentana\(a,box\)/);
  assert.match(fnAt('fichaEnVentana'), /pintarFicha\(a,box,true\)/);
  // el toque de verdad: el click y Enter abren con la sesión y su tarjeta; un botón de adentro no abre
  const node = () => { const n = { kids: [], style: { setProperty() {} }, classList: { add() {} }, attrs: {}, appendChild(k) { this.kids.push(k); return k; }, append(...k) { this.kids.push(...k); }, setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren(...k) { this.kids = k; } }; return n; };
  const pintar = new Function('el', 'AST', 'SHIRT', 'etiquetaComo', 'pintarFicha', 'document', `${fnAt('pintarTarjetas')}\n; return pintarTarjetas;`)(
    () => node(), {}, ['#000'], () => node(), () => {}, { createTextNode: (t) => ({ t }) });
  const c = node(), abiertas = [], ana = { nombre: 'Ana', estado: 'trabajando' };
  pintar(c, [ana], (a, k) => abiertas.push([a, k]));
  const k = c.kids[0];
  k.onclick({ target: { closest: () => null } });
  k.onkeydown({ target: k, key: 'Enter', preventDefault() {} });
  k.onclick({ target: { closest: () => ({}) } });
  assert.deepStrictEqual(abiertas, [[ana, k], [ana, k]], 'el click y Enter abren; el botón de adentro no');
  assert.strictEqual(k.attrs.role, 'button');
  // y la ventana se abre con su nombre y la misma ficha que la del tablero
  const box = node(), v = { hidden: true, firstElementChild: box }, fichas = [];
  const abrirSesion = new Function('ventana', 'el', 'botonCerrar', 'cerrarCharla', 'fichaEnVentana', 'document', 'charlaDe', 'ultimoPedido', 'charlaVuelve', `${abrir}\n; return abrirSesion;`)(
    () => v, (tag, cls, t) => ({ tag, t }), () => ({ focus() {} }), null, (a, b) => fichas.push([a, b]), { documentElement: { classList: { add() {} } } }, null, 0, null);
  box.classList = { add() {} };
  abrirSesion(ana, k);
  assert.strictEqual(v.hidden, false, 'la ventana se abre');
  assert.deepStrictEqual(box.kids[0], { tag: 'h3', t: 'Ana' });
  assert.deepStrictEqual(fichas, [[ana, box]]);
});

test('T314 Card_TaskNumber: la sesión lleva el número de su fila del tablero, el mismo de su tarjeta del kanban; sin fila, ninguno', () => {
  const numbered = (rows) => buildBoard({ pendientes: rows.map((r, i) => ({ estado: 'curso', grupo: 'Hoy', orden: i, id: `T-${i + 1}`, ...r })) });
  const { data } = buildOffice({ wip: wip([
    { session: 'Ana', work: '8.1 · Una', extra: { kind: 'pipeline', title: 'Una', storyId: '8.1', current: 'implement', endAt: NOW + 3600000 } },
    { session: 'Beto', work: '8.2 · Otra', extra: { kind: 'pipeline', title: 'Otra', storyId: '8.2', current: 'implement', endAt: NOW + 3600000 } },
  ]), board: numbered([{ titulo: 'Otra cosa' }, { titulo: 'La historia', historia: '8.1' }]), nowMs: NOW });
  assert.strictEqual(byName(data, 'Ana').tarea, 'T-2');
  const card = data.kanban.columnas.flatMap((c) => c.tarjetas).find((c) => c.quien === 'Ana');
  assert.strictEqual(card.numero, byName(data, 'Ana').tarea, 'el mismo número que su tarjeta del kanban');
  assert.strictEqual(byName(data, 'Beto').tarea, undefined);
});
