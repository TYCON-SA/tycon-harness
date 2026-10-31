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
  assert.strictEqual(data.meta.extra, 3, 'ocho personas, cinco escritorios');
});

test('T2 CoordinadoraQuieta_NoEstaLibre: la coordinadora sin fila de trabajo coordina', () => {
  const { data } = buildOffice({ wip: wip([], { free: ['sesion-a', 'coordinadora'] }), coordinatorName: 'coordinadora', nowMs: NOW });
  assert.strictEqual(byName(data, 'coordinadora').estado, 'coordina');
  assert.strictEqual(byName(data, 'sesion-a').estado, 'libre');
  assert.deepStrictEqual(data.items, [], 'la coordinadora quieta no es un pendiente');
});

test('T3 MientrasTanto: la segunda burbuja y la fila de la tabla dicen lo que hace mientras tanto', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'sesion-a', meanwhile: 'arregla la guía', extra: { kind: 'stalled' } }]), nowMs: NOW });
  assert.strictEqual(byName(data, 'sesion-a').mientras, 'arregla la guía');
  assert.match(data.rows[0].state, /Mientras tanto: arregla la guía\./);
});

test('T10 EnLlano: sin números de historia ni de pedidos, y una oración por sesión', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'sesion-a', work: '8.85 · El núcleo dice qué hace', state: 'Pedidos sin encolar · repo-a !6008 (borrador) (choca con main) · repo-b #842', meanwhile: '8.85-E: portables como la CI', extra: { kind: 'stalled' } },
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
  return new Function(`${code.replace(/^const (AST|SHIRT|agents)=.*$/gm, '')}; return { finTxt };`)();
}

test('T12 HoraPasada: si la hora de fin ya pasó dice el atraso real en rojo; si es vieja, «sin hora estimada»; nunca «en hora»', () => {
  const { data } = buildOffice({
    wip: wip([
      { session: 'Muñe', extra: { kind: 'entering', endAt: NOW - 5 * 3600000 } },
      { session: 'Vieja', extra: { kind: 'entering', endAt: NOW - 13 * 3600000 } },
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
    ], { halfway: ['ad hoc de sesion-z · limpiar: marker.js adhoc clear'] }),
    signatures: [{ id: 'f1', title: 'saltar el pase de 5.2', at: NOW }, { id: 'f2' }],
    nowMs: NOW,
  });
  assert.deepStrictEqual(data.items.map((i) => [i.quien, i.estado]), [
    ['sesion-a', 'riesgo'], ['sesion-b', 'espera'], ['sesion-c', 'firma'], ['sesion-d', 'curso'], ['vos', 'firma'], ['—', 'riesgo'],
  ]);
  assert.strictEqual(data.items[5].titulo, 'ad hoc de sesion-z', 'sin el comando de limpieza');
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
