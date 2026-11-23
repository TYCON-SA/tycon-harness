'use strict';
// office-board.test.js — the board and the kanban of the office: its columns, «Tu firma», «En curso» and the pull requests. The shared toys live in lib/office-fixtures.js.
// Through that library the cases run scripts/tools/office.js and skills/tycon-pipeline/scripts/marker.js: named
// here so the dependency reader of the validation follows them from this file, as it follows what a suite names.
// Nothing here reads the real HOME: the command-line tests run with a toy HOME.
// stable-data: every date comes in by argument or by --now.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OFFICE, PAGE_CODE, NOW, STEPS, byName, run, runMarker, BOARD, all, textOf, sessionFile, STEP_LIB, col, titles, hm,
  IDS, runMarkerFile, BEFORE_PLAN, CLOSED, sessionWith, atIso, KANBAN_BOARD, collectAt, localIsoAt, mixedOffice,
  WALL_ORDER, toyKanban, firmaCard, firmaData, wip, toyHome, toyMachine, storyFile, collectWith, drawKanban, toyRepo,
  parkMachine, openWallPanel, wallTexts, firmaOffice, filesOf, buildOffice, page, collect, buildBoard,
  createEnvelopes, ownerWaitsOf, tinyDom
} = require('./lib/office-fixtures.js');

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
  assert.deepStrictEqual(data.kanban.columnas.map((c) => c.nombre), ['Sin sesión', 'En curso', 'Tu firma', 'Esperan entrar', 'Terminados hoy']);
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
      { id: 'firma', nombre: 'Tu firma', tarjetas: [{ titulo: '<b>no es html</b>', quien: 'Ana', hora: 'dom 10:00', espera: 'abrir el pull request' }] },
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
  assert.match(textOf(cols[0]), /abrir el pull request/);
  assert.match(textOf(cols[1]), /En fila para pruebas/);
  assert.match(textOf(cols[1]), /en borrador/);
  assert.match(textOf(cols[1]), /Lo de hoy/);
  assert.doesNotMatch(textOf(body), /Lo que quedó/, 'a medio camino va aparte, en las dos vistas');
  const html = page(data);
  assert.ok(!/const GROUPS=\[\["riesgo"/.test(html), 'el panel de la pared no cuenta otras columnas');
  assert.match(html, /function abrirTablero\(\)\{[^\n]*kanban/);
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

test('T206 Coordinator_NotAPending: la coordinadora no es una tarjeta de «En curso», salvo que su trabajo sea una fila del tablero', () => {
  const board = buildBoard({ pendientes: [{ titulo: 'Ordenar los pedidos', estado: 'curso', id: 'T-9' }] });
  const photo = (extra) => buildOffice({ wip: wip([{ session: 'Coord', sid: 'co', status: 'busy', extra }]), coordinatorSid: 'co', board, nowMs: NOW }).data;
  assert.deepStrictEqual(titles(photo({ kind: 'activity' }), 'curso'), []);
  // coordinar no es una tarea: «En curso» decía 6 y eran 5
  assert.deepStrictEqual(titles(photo({ kind: 'note', text: 'ordeno los pedidos del día' }), 'curso'), []);
  assert.deepStrictEqual(titles(photo({ kind: 'note', text: 'T-8: un número sin fila' }), 'curso'), [], 'el número tiene que ser de una fila');
  assert.deepStrictEqual(titles(photo({ kind: 'note', text: 'T-9: ordeno los pedidos del día' }), 'curso'), ['T-9: ordeno los pedidos del día']);
});

// La tarjeta de la coordinadora sin fila del tablero no sale, y queda dicho por qué: en una lista del kanban que no se
// enumera (no viaja a la página ni al sitio) y que la oficina escribe en su registro. No es un problema: `problems` no cambia.
test('8.281 T5 Tablero_CoordinadoraSinFila_NoSaleYDejaRenglon @story-8.281 @ac-9 @ac-10 @ac-23: sin fila no sale y queda en la lista de ocultas con su motivo; con fila sale y la lista está vacía', () => {
  const board = buildBoard({ pendientes: [{ titulo: 'Ordenar los pedidos', estado: 'curso', id: 'T-9' }] });
  const photo = (extra) => buildOffice({ wip: wip([{ session: 'Coord', sid: 'co', status: 'busy', extra }]), coordinatorSid: 'co', board, nowMs: NOW }).data;
  const sin = photo({ kind: 'note', text: 'ordeno los pedidos del día' });
  assert.deepStrictEqual(titles(sin, 'curso'), []);
  assert.deepStrictEqual(sin.kanban.ocultas, [{ quien: 'Coord', motivo: 'coordina y su trabajo anotado no es una fila del tablero' }]);
  assert.ok(!Object.keys(sin.kanban).includes('ocultas'), 'la lista no viaja con el kanban');
  assert.ok(!JSON.stringify(sin).includes('no es una fila del tablero'), 'ni a la página ni a los avisos');
  const con = photo({ kind: 'note', text: 'T-9: ordeno los pedidos del día' });
  assert.deepStrictEqual(titles(con, 'curso'), ['T-9: ordeno los pedidos del día']);
  assert.deepStrictEqual(con.kanban.ocultas, []);
  // una sesión sin columna no es una tarjeta oculta
  const libre = buildOffice({ wip: wip([{ session: 'Libre', sid: 'li', status: 'idle', extra: { kind: 'activity' } }]), board, nowMs: NOW }).data;
  assert.deepStrictEqual(libre.kanban.ocultas, []);
  // el renglón del registro de la oficina, una vez por cambio de la lista
  const { hiddenCardsLine } = require(OFFICE);
  const seen = { last: null };
  assert.match(hiddenCardsLine(sin.kanban.ocultas, seen), /no muestro la tarjeta de Coord: coordina y su trabajo anotado no es una fila del tablero/);
  assert.strictEqual(hiddenCardsLine(sin.kanban.ocultas, seen), null, 'la misma lista no se repite en cada refresco');
  assert.strictEqual(hiddenCardsLine([], seen), null, 'que deje de estar oculta no es un renglón');
  // un nombre con un salto de línea no parte el renglón del registro
  const partido = hiddenCardsLine([{ quien: 'Coord\n2026-11-15T00:00:00Z otro renglón', motivo: 'm' }], {});
  assert.ok(!/[\r\n]/.test(partido), partido);
});

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

// La tarjeta va en una línea con puntos al final: lo que va al final de un título largo no se ve. Cuántas firmas esperan
// va al principio, donde se ve siempre; el renglón de la pared, que no se corta, sigue diciendo «y N más».
test('Office_FirmasDeUnaSesion_CuantasVaDelante @DEF-8.248-tarjeta-y-mas', () => {
  const largo = 'marcar como probado a mano el criterio de la pantalla de la estación con su detalle completo';
  const fila = (title, extra = {}) => ({ tipo: 'firma', id: `f-${title}`, firma: 'manual-test', destino: 'b', title, at: NOW - 60000, ...extra });
  let { data } = buildOffice({ wip: wip([{ session: 'Bruno', sid: 'b', status: 'busy', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Bruno' } }]),
    signatures: [fila(largo), fila('otro criterio', { at: NOW }), fila('un tercero', { at: NOW })], nowMs: NOW });
  assert.deepStrictEqual(titles(data, 'firma'), [`Firmas (3): ${largo}`], 'cuántas esperan, antes del título');
  assert.match(data.meta.teToca[0], / y 2 más \(Bruno\)$/, 'la pared sigue diciendo cuántas más');
  // una sola: como siempre
  ({ data } = buildOffice({ wip: wip([{ session: 'Bruno', sid: 'b', status: 'busy', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Bruno' } }]),
    signatures: [fila(largo)], nowMs: NOW }));
  assert.deepStrictEqual(titles(data, 'firma'), [`Firma: ${largo}`]);
  // varios permisos de una sesión: el número delante, sin «Firma»
  ({ data } = buildOffice({ wip: wip([]), signatures: [{ tipo: 'permiso', id: 'p1', destino: 'c', nombre: 'Ciro', title: 'Permiso: Bash', at: NOW }, { tipo: 'permiso', id: 'p2', destino: 'c', nombre: 'Ciro', title: 'Permiso: Edit', at: NOW }], nowMs: NOW }));
  assert.deepStrictEqual(titles(data, 'firma'), ['(2) Permiso: Bash']);
  // las aprobadas que esperan que la sesión las repita, igual
  ({ data } = buildOffice({ wip: wip([{ session: 'Bruno', sid: 'b', status: 'busy', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Bruno' } }]),
    signatures: [fila(largo, { aprobada: true }), fila('otro criterio', { aprobada: true, at: NOW })], nowMs: NOW }));
  assert.deepStrictEqual(col(data, 'curso').tarjetas.filter((c) => /^Firmas? /.test(c.titulo)).map((c) => c.titulo), [`Firmas (2): ${largo}`]);
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
  assert.deepStrictEqual(titles(data, 'firma'), ['Firmas (2): marcar un criterio'], 'una por sesión, con cuántas esperan delante');
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

test('T278 Kanban_Finished_OnlyToday: «Terminados hoy» es lo de hoy con su hora, lo último primero; lo demás va a la tabla «Hechos»', () => {
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
  assert.deepStrictEqual(data.kanban.columnas.map((c) => c.nombre), ['Sin sesión', 'En curso', 'Tu firma', 'Esperan entrar', 'Terminados hoy']);
  assert.deepStrictEqual(titles(data, 'hechos'), ['Con pedido', 'De hace un rato', 'De esta mañana'], 'la hora del pedido manda sobre la anotada');
  assert.deepStrictEqual(data.kanban.anteriores.map((c) => c.titulo), ['De ayer', 'Sin hora']);
  for (const c of [...col(data, 'hechos').tarjetas, ...data.kanban.anteriores]) assert.ok(!('terminadoMs' in c), 'el dato interno no sale');
});

test('T287 InProgress_ByEndHour: lo que termina antes va arriba; lo que espera o no tiene hora, después; la coordinadora, al final', () => {
  const end = (min) => ({ kind: 'loose', text: 'algo', endAt: NOW + min * 60000, hourAt: NOW - 60000, promiseAt: NOW - 60000 });
  const { data } = buildOffice({
    wip: wip([
      // la coordinadora entra a «En curso» sólo con un trabajo que es una fila del tablero
      { session: 'Coord', sid: 'c', extra: { kind: 'note', text: 'T-1: el tablero' } },
      { session: 'Sinhora', extra: { kind: 'loose', text: 'sin hora' } },
      { session: 'Espera', extra: { kind: 'note', text: 'espera', waitingFor: 'un aviso', waitingSince: NOW - 60000, endAt: NOW + 60000 } },
      { session: 'Tarde', extra: end(90) },
      { session: 'Pronto', extra: end(10) },
    ]),
    board: buildBoard({ pendientes: [{ titulo: 'Ordenar el tablero', estado: 'curso', id: 'T-1' }] }),
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

test('T1 TuFirma_TarjetasConSesionYOrigen @story-8.219 @ac-1: cada tarjeta de «Tu firma» dice de qué sesión y de qué fuente sale, sin cambiar lo que se ve', () => {
  const data = firmaOffice();
  const cards = col(data, 'firma').tarjetas;
  const of = (titulo) => cards.find((t) => t.titulo === titulo);
  assert.deepStrictEqual(cards.map((t) => t.titulo).sort(), ['Cinco', 'Firma del tablero', 'Firma: la firma de la terminal', 'Firma: la firma de otra', 'Tres'].sort());
  assert.deepStrictEqual([of('Tres').sid, of('Tres').origen], ['s-pepa', 'sesion']);
  assert.deepStrictEqual([of('Cinco').sid, of('Cinco').origen], ['s-rosa', 'medio']);
  assert.deepStrictEqual([of('Firma: la firma de otra').sid, of('Firma: la firma de otra').origen], ['s-otra', 'lista']);
  assert.strictEqual(of('Firma: la firma de la terminal').sid, null, 'la de la terminal, sin sesión');
  assert.ok(Object.prototype.hasOwnProperty.call(of('Firma: la firma de la terminal'), 'sid'), 'sid: null explícito');
  assert.strictEqual(of('Firma: la firma de la terminal').origen, 'lista');
  assert.deepStrictEqual([of('Firma del tablero').sid, of('Firma del tablero').origen], [null, 'tablero']);
  assert.doesNotMatch(JSON.stringify(cards), /"sid"|"origen"/, 'la tarjeta que se ve queda como hoy');
});

test('T2 OwnerWaitsOf_SoloSesionYMedio @story-8.219 @ac-2: sólo lo que espera una sesión, una vez por sesión, con sus respaldos', () => {
  assert.deepStrictEqual(ownerWaitsOf(firmaOffice()), [
    { sid: 's-pepa', quien: 'Pepa', trabajo: 'Tres', espera: 'que apruebes el plan', cerrada: false },
    { sid: 's-rosa', quien: 'Rosa', trabajo: 'Cinco', espera: 'que apruebes el plan', cerrada: true },
  ]);
  // la misma sesión con tarjeta propia y a medio camino: una sola, la de la sesión
  const doble = firmaData([firmaCard({ titulo: 'Seis', quien: 'Ida', espera: 'abrir el pull request' }, 's-ida', 'medio'), firmaCard({ titulo: 'Seis', quien: 'Ida', espera: 'que apruebes el plan' }, 's-ida', 'sesion')]);
  assert.deepStrictEqual(ownerWaitsOf(doble), [{ sid: 's-ida', quien: 'Ida', trabajo: 'Seis', espera: 'que apruebes el plan', cerrada: false }]);
  // trabajando, con una pregunta abierta y una sesión de prueba: no esperan al dueño en «Tu firma»
  const plan = { kind: 'pipeline', title: 'Siete', storyId: '9.7', current: 'approve-plan' };
  const { data } = buildOffice({
    wip: wip([
      { session: 'Uno', status: 'busy', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'Preg', sid: 's-preg', status: 'busy', extra: { kind: 'pipeline', current: 'implement' } },
      { session: 'Prueba', sid: 's-prueba', status: 'idle', extra: plan },
    ]),
    sessionFiles: [sessionFile('s-preg', { name: 'Preg', waitingForOwner: true, waitingFor: 'una respuesta' })],
    testSessions: new Set(['s-prueba']),
    nowMs: NOW,
  });
  assert.deepStrictEqual(ownerWaitsOf(data), []);
  // los respaldos: sin nombre, el id corto; sin espera, «algo de vos»
  const sinDatos = firmaData([firmaCard({ titulo: 'Ocho', quien: '—' }, 'abcdef1234567', 'medio'), firmaCard({ titulo: 'Nueve', quien: 'Ema' }, 's-ema', 'sesion')]);
  assert.deepStrictEqual(ownerWaitsOf(sinDatos), [
    { sid: 'abcdef1234567', quien: '— (abcdef12)', trabajo: 'Ocho', espera: 'algo de vos', cerrada: true },
    { sid: 's-ema', quien: 'Ema', trabajo: 'Nueve', espera: 'algo de vos', cerrada: false },
  ]);
});

test('T3 OwnerWaits_ComoProcesoSinEscribir @story-8.219 @ac-3: --owner-waits da la lista y no escribe nada en la casa', () => {
  const { home, state } = toyHome();
  const storyPath = storyFile({ root: home }, '9.7', 'Siete');
  fs.writeFileSync(path.join(state, 'active', 's1.json'), JSON.stringify({ sessionId: 's1', storyId: '9.7', storyPath, stepScheme: STEP_LIB.SCHEME, stepsCompleted: BEFORE_PLAN, stepsPending: IDS.filter((s) => !BEFORE_PLAN.includes(s)) }));
  const antes = filesOf(home);
  const out = JSON.parse(run(home, ['--owner-waits', '--now', new Date(NOW).toISOString()]));
  assert.ok(Array.isArray(out.problemas), JSON.stringify(out));
  assert.deepStrictEqual(out.esperas.map((e) => [e.sid, e.quien, e.espera, e.cerrada]), [['s1', 'sesion-a', 'que apruebes el plan', false]]);
  assert.deepStrictEqual(filesOf(home), antes, 'ningún archivo cambió ni apareció');
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

test('T315 Card_TaskNumber_FromNote: «T-126/T-127» en una nota no es una ruta, y el número de la nota de un camino corto une su fila', () => {
  const board = buildBoard({ pendientes: [{ titulo: 'Oficina: defectos', estado: 'curso', id: 'T-126' }, { titulo: 'Un arreglo', estado: 'curso', id: 'T-72' }] });
  const { data } = buildOffice({ wip: wip([
    { session: 'Ana', work: 'nota', extra: { kind: 'note', text: 'T-126/T-127: armando tandas' } },
    { session: 'Beto', work: 'arreglo', extra: { kind: 'loose', text: 'el motivo del carril, sin número', noteText: 'T-72: sigo con el arreglo' } },
  ]), board, nowMs: NOW });
  assert.strictEqual(byName(data, 'Ana').titulo, 'T-126/T-127: armando tandas', 'los números quedan en el título');
  const all = data.kanban.columnas.flatMap((c) => c.tarjetas);
  assert.strictEqual(all.find((c) => c.quien === 'Ana').numero, 'T-126');
  assert.strictEqual(all.find((c) => c.quien === 'Beto').numero, 'T-72', 'la nota del camino corto une su fila');
  assert.deepStrictEqual(titles(data, 'sinEmpezar'), [], 'ninguna fila sale repetida en «Sin sesión»');
});

test('T316 OpenPr_JoinsItsRow: un pedido que nombra su fila o es su recordado no sale suelto; la fila sin sesión pasa a «Esperan entrar» con él', () => {
  const board = buildBoard({ pendientes: [
    { titulo: 'Arreglo con pedido', estado: 'espera', id: 'T-40' },
    { titulo: 'Recordado', estado: 'espera', id: 'T-41' },
    { titulo: 'Espera tu firma', estado: 'firma', id: 'T-42' },
  ] });
  board.filas.find((f) => f.numero === 'T-41').recordado = { repo: 'pub', numero: 902 };
  const { data } = buildOffice({ wip: wip([]), board, nowMs: NOW, openPrs: [
    { repoName: 'pub', repo: 'org/pub', number: 901, mark: '#', branch: 'fix/t-40-arreglo', title: 'fix: el arreglo', inQueue: true, waiting: true },
    { repoName: 'pub', repo: 'org/pub', number: 902, mark: '#', branch: 'fix/otro', title: 'el recordado', inQueue: false, waiting: true, conflict: true },
    { repoName: 'pub', repo: 'org/pub', number: 903, mark: '#', branch: 'fix/suelto', title: 'nada que ver', inQueue: false, waiting: true },
    { repoName: 'pub', repo: 'org/pub', number: 904, mark: '#', branch: 'fix/t-40-otro', title: 'otro pedido de la T-40', inQueue: true, waiting: true },
    { repoName: 'pub', repo: 'org/pub', number: 905, mark: '#', branch: 'fix/t-42', title: 'el de la firma', inQueue: true, waiting: true },
    { repoName: 'priv', repo: 'org/priv', number: 901, mark: '!', branch: 'fix/t-40-privado', title: 'el mismo número en otro repo', inQueue: true, waiting: true },
  ] });
  assert.deepStrictEqual(titles(data, 'entrando').sort(), ['Arreglo con pedido', 'Recordado', 'el de la firma', 'el mismo número en otro repo', 'nada que ver', 'otro pedido de la T-40']);
  const row = col(data, 'entrando').tarjetas.find((c) => c.numero === 'T-40');
  assert.strictEqual(row.hora, 'en la cola');
  assert.strictEqual(row.pedido.numero, 901);
  const remembered = col(data, 'entrando').tarjetas.find((c) => c.numero === 'T-41');
  assert.strictEqual(remembered.motivo, 'choca con main', 'lleva lo que dice su pedido');
  assert.deepStrictEqual(titles(data, 'sinEmpezar'), [], 'ninguna fila queda además en «Sin sesión»');
  assert.deepStrictEqual(titles(data, 'firma'), ['Espera tu firma'], 'la fila de otra columna no se mueve, y su pedido sale suelto');
});

test('T317 Finished_TodayAndBefore: la columna dice «Terminados hoy» y la página abre «N anteriores» desde la tabla «Hechos»', () => {
  const code = PAGE_CODE();
  assert.match(code, /c\.id==="hechos"&&DATA\.tablas&&DATA\.tablas\.hechos/, 'lo anterior sale de la tabla que también viaja al sitio');
  assert.match(code, /" anterior":" anteriores"/);
  assert.match(code, /aria-expanded/);
});

// 🔴 Falla con: el botón «N anteriores» que la página arma mal (otra cuenta, «1 anteriores», abierto de entrada, no se
// abre al tocarlo) o filas de «Hechos» sin su texto; T317 sólo compara el código de la página con una expresión.
test('Oficina_NAnteriores_EjecutaLaPagina @story-8.282 @ac-25', () => {
  const datos = (filas) => ({ agents: [], items: [], meta: { actualizado: '10:00', teToca: [] }, rows: [], free: [], unreadable: [], tablero: null,
    kanban: { escrito: `Tablero escrito a las ${hm(NOW)}`, columnas: [{ id: 'hechos', nombre: 'Terminados hoy', tarjetas: [] }], medioCamino: [] },
    tablas: { hechos: { filas } } });
  const boton = (body) => all(body, (n) => n.tag === 'button' && / anterior(es)?$/.test(n.textContent))[0];
  const lista = (body) => all(body, (n) => n.className === 'anteriores-lista')[0];
  // una sola fila, con sólo su grupo
  const uno = drawKanban(datos([{ grupo: 'T-50' }])).body;
  assert.strictEqual(boton(uno).textContent, '1 anterior');
  assert.strictEqual(textOf(lista(uno)), 'T-50');
  // tres, una de un pedido con sesión: su qué y su columna van en la línea de abajo
  const tres = drawKanban(datos([{ grupo: 'T-50' }, { grupo: 'Historia 9.1', que: 'pedido 901 de la sesión ses-a', col: 'Terminado' }, { grupo: 'T-52', que: 'el arreglo' }])).body;
  const b = boton(tres);
  const l = lista(tres);
  assert.strictEqual(b.textContent, '3 anteriores');
  assert.strictEqual(b.attrs['aria-expanded'], 'false', 'empieza cerrado');
  assert.strictEqual(l.hidden, true);
  assert.deepStrictEqual(l.children.map(textOf), ['T-50', 'Historia 9.1pedido 901 de la sesión ses-a · Terminado', 'T-52el arreglo']);
  b.onclick();
  assert.strictEqual(b.attrs['aria-expanded'], 'true', 'se abre al tocarlo');
  assert.strictEqual(l.hidden, false);
  b.onclick();
  assert.strictEqual(b.attrs['aria-expanded'], 'false', 'y se vuelve a cerrar');
  // sin filas viejas, no hay botón
  assert.strictEqual(boton(drawKanban(datos([])).body), undefined);
});

// ── «Tu firma» dice a quién espera: la firma aprobada y sin repetir ────────────────────────────────────────────────────

// una firma del registro como la deja collect; `aprobada` la marca aprobadasSinRepetir (signature-list.js)
const firmaDe = (destino, title, extra = {}) => ({ tipo: 'firma', id: `f-${destino}-${title}`, firma: 'manual-test', destino, title, at: NOW - 60000, ...extra });
// la del plan, con la firma que lo aprueba (signatures.js)
const planDe = (destino, title, extra = {}) => firmaDe(destino, title, { firma: 'plan-approval', ...extra });
const doraPlan = (extra = {}) => wip([{ session: 'Dora', sid: 'd', status: 'idle', extra: { kind: 'pipeline', current: 'approve-plan', title: 'Lo de Dora', storyId: '9.9', ...extra } }]);
const teTocaDe = (data) => data.meta.teToca.join(' | ');

test('T14 Office_FirmaAprobadaSinRepetir_EsperaALaSesion @story-8.234 @ac-14: la firma aprobada sale de «Tu firma» y dice que espera a la sesión', () => {
  // caso 1: la sesión espera su plan y la firma del plan ya está aprobada
  let { data } = buildOffice({ wip: doraPlan(), signatures: [planDe('d', 'aprobar el plan de una story', { aprobada: true })], nowMs: NOW });
  assert.deepStrictEqual(col(data, 'firma').tarjetas, [], 'no queda nada en «Tu firma»');
  const enCurso = col(data, 'curso').tarjetas.find((c) => c.titulo === 'Lo de Dora');
  assert.ok(enCurso, JSON.stringify(data.kanban.columnas));
  assert.strictEqual(enCurso.espera, 'aprobada: espera que Dora la repita');
  assert.strictEqual(byName(data, 'Dora').estado, 'parada');
  assert.strictEqual(byName(data, 'Dora').mano, undefined, 'sin la mano «Espera tu firma»');
  assert.doesNotMatch(teTocaDe(data), /Dora|aprobar el plan/, 'ni el renglón de la lista ni el «Aprobar el plan» de la sesión');
  assert.deepStrictEqual(ownerWaitsOf(data), [], 'a la coordinadora no le llega como algo del dueño');
  assert.match(data.kanban.linea, /Tu firma: 0/);
  assert.match(data.kanban.linea, /Trabado: 0/, 'no se cuenta como trabada');

  // caso 2: el plan aprobado y otra firma sin aprobar: el plan ya no le toca al dueño; la otra sí, sola en «Tu firma»
  // («Te toca» no puede pedir un plan ya aprobado ni esconder la firma que de verdad falta)
  ({ data } = buildOffice({ wip: doraPlan(), signatures: [planDe('d', 'aprobar el plan de una story', { aprobada: true }), firmaDe('d', 'marcar un criterio')], nowMs: NOW }));
  assert.deepStrictEqual(titles(data, 'firma'), ['Firma: marcar un criterio'], JSON.stringify(col(data, 'firma').tarjetas));
  assert.strictEqual(byName(data, 'Dora').estado, 'parada');
  assert.strictEqual(byName(data, 'Dora').mano, 'dueno', 'la mano es por la firma que falta');
  assert.match(data.kanban.linea, /Tu firma: 1/);
  assert.match(teTocaDe(data), /Firmar: marcar un criterio \(Dora\)/);
  assert.doesNotMatch(teTocaDe(data), /Aprobar el plan|aprobar el plan de una story/, 'la aprobada no suma');
  assert.deepStrictEqual(ownerWaitsOf(data), [], 'la coordinadora no recibe el plan aprobado');

  // caso 2b: el plan aprobado y otra firma también aprobada: las dos se ven, ninguna se pierde
  ({ data } = buildOffice({ wip: doraPlan(), signatures: [planDe('d', 'aprobar el plan de una story', { aprobada: true }), firmaDe('d', 'pedir una vuelta más', { aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Dora').estado, 'parada');
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.titulo === 'Firma: pedir una vuelta más' && c.espera === 'aprobada: espera que Dora la repita'), JSON.stringify(col(data, 'curso').tarjetas));
  assert.deepStrictEqual(col(data, 'firma').tarjetas, []);

  // caso 2c: el plan aprobado con un cuadro de permiso en pantalla: el cuadro lo contesta el dueño, no se esconde
  ({ data } = buildOffice({ wip: wip([{ session: 'Dora', sid: 'd', status: 'waiting_for_permission', extra: { kind: 'pipeline', current: 'approve-plan', title: 'Lo de Dora' } }]),
    signatures: [planDe('d', 'aprobar el plan de una story', { aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Dora').estado, 'firma');
  assert.strictEqual(byName(data, 'Dora').mano, 'dueno');
  assert.match(teTocaDe(data), /Aprobar el plan: Lo de Dora \(Dora\)/);
  assert.match(data.kanban.linea, /Tu firma: 1/);
  // lo mismo con el cuadro anotado en el archivo de la sesión
  ({ data } = buildOffice({ wip: doraPlan(), sessionFiles: [sessionFile('d', { name: 'Dora', waitingForOwner: true, waitingFor: 'un permiso' })],
    signatures: [planDe('d', 'aprobar el plan de una story', { aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Dora').estado, 'firma');

  // caso 3: la sesión que se dibuja desde su archivo (Codex, sin fila en /wip), sin nombre: su id corto
  ({ data } = buildOffice({ wip: wip([]), sessionFiles: [sessionFile('abcdef1234567', { tool: 'codex', busy: false, step: 'Aprobar el plan', sentence: 'Espera el plan.' })],
    signatures: [planDe('abcdef1234567', 'aprobar el plan de otra story', { aprobada: true })], nowMs: NOW }));
  assert.deepStrictEqual(col(data, 'firma').tarjetas, []);
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.espera === 'aprobada: espera que abcdef12 la repita'), JSON.stringify(col(data, 'curso').tarjetas));
  assert.doesNotMatch(teTocaDe(data), /Aprobar el plan/);

  // caso 4: un cuadro de permiso en pantalla no se toca, aunque un renglón suyo esté aprobado
  ({ data } = buildOffice({ wip: wip([{ session: 'Alma', sid: 'a', status: 'waiting_for_permission', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Alma' } }]),
    signatures: [firmaDe('a', 'marcar un criterio', { aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Alma').estado, 'firma');
  assert.strictEqual(col(data, 'firma').tarjetas.length, 1);
  // y la aprobada no se pierde: su tarjeta en «En curso» dice que espera a la sesión
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.titulo === 'Firma: marcar un criterio' && c.espera === 'aprobada: espera que Alma la repita'), JSON.stringify(col(data, 'curso').tarjetas));

  // caso 5: una sesión trabajando en otra cosa, con una firma aprobada: sigue trabajando, y la firma va a «En curso»
  ({ data } = buildOffice({ wip: wip([{ session: 'Bruno', sid: 'b', status: 'busy', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Bruno' } }]),
    signatures: [firmaDe('b', 'marcar un criterio', { aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Bruno').estado, 'trabajando');
  assert.deepStrictEqual(col(data, 'firma').tarjetas, []);
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.titulo === 'Firma: marcar un criterio' && c.espera === 'aprobada: espera que Bruno la repita'));
  assert.strictEqual(byName(data, 'Bruno').mano, undefined);
  // dos aprobadas de la misma sesión: una tarjeta, con la más vieja y cuántas más
  ({ data } = buildOffice({ wip: wip([{ session: 'Bruno', sid: 'b', status: 'busy', extra: { kind: 'pipeline', current: 'implement', title: 'Lo de Bruno' } }]),
    signatures: [firmaDe('b', 'marcar un criterio', { aprobada: true }), firmaDe('b', 'otro criterio', { aprobada: true, at: NOW })], nowMs: NOW }));
  assert.deepStrictEqual(col(data, 'curso').tarjetas.filter((c) => /^Firmas? /.test(c.titulo)).map((c) => c.titulo), ['Firmas (2): marcar un criterio']);

  // caso 5b: el guardado aprobado (firma `save`) deja de pedir el ok de guardar, igual que el plan
  ({ data } = buildOffice({ wip: wip([{ session: 'Eva', sid: 'e', status: 'idle', extra: { kind: 'finished', title: 'Lo de Eva' } }]),
    signatures: [firmaDe('e', 'guardar la story', { firma: 'save', aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Eva').estado, 'parada', JSON.stringify(byName(data, 'Eva')));
  assert.strictEqual(byName(data, 'Eva').espera, 'aprobada: espera que Eva la repita');
  assert.deepStrictEqual(col(data, 'firma').tarjetas, []);
  assert.deepStrictEqual(data.meta.teToca, []);
  // sin aprobar, el guardado sigue siendo del dueño
  ({ data } = buildOffice({ wip: wip([{ session: 'Eva', sid: 'e', status: 'idle', extra: { kind: 'finished', title: 'Lo de Eva' } }]),
    signatures: [firmaDe('e', 'guardar la story', { firma: 'save' })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Eva').estado, 'firma');

  // caso 5c: una aprobada de una sesión que no se dibuja: su tarjeta en «En curso» con el id corto
  ({ data } = buildOffice({ wip: wip([]), signatures: [firmaDe('fedcba9876543', 'marcar un criterio', { aprobada: true })], nowMs: NOW }));
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.titulo === 'Firma: marcar un criterio' && c.quien === '— (fedcba98)' && c.espera === 'aprobada: espera que — (fedcba98) la repita'), JSON.stringify(col(data, 'curso').tarjetas));

  // caso 6: la sesión espera su plan y lo aprobado es otra firma: el plan sigue siendo del dueño
  ({ data } = buildOffice({ wip: doraPlan(), signatures: [firmaDe('d', 'marcar un criterio', { aprobada: true })], nowMs: NOW }));
  assert.strictEqual(byName(data, 'Dora').estado, 'firma');
  assert.strictEqual(byName(data, 'Dora').espera, 'que apruebes el plan');
  assert.match(teTocaDe(data), /Aprobar el plan: Lo de Dora \(Dora\)/);
  assert.match(data.kanban.linea, /Tu firma: 1/);
  assert.ok(col(data, 'curso').tarjetas.some((c) => c.titulo === 'Firma: marcar un criterio' && c.espera === 'aprobada: espera que Dora la repita'));
});

test('T15 Office_FirmaSinAprobar_ComoHoy @story-8.234 @ac-15: sin aprobación, la firma sale como hoy', () => {
  const { data } = buildOffice({ wip: doraPlan(), signatures: [planDe('d', 'aprobar el plan de una story')], nowMs: NOW });
  assert.strictEqual(byName(data, 'Dora').estado, 'firma');
  assert.strictEqual(byName(data, 'Dora').espera, 'que apruebes el plan');
  assert.strictEqual(byName(data, 'Dora').mano, 'dueno');
  assert.strictEqual(col(data, 'firma').tarjetas.length, 1);
  assert.match(data.kanban.linea, /Tu firma: 1/);
  assert.match(teTocaDe(data), /Aprobar el plan: Lo de Dora \(Dora\)/);
  assert.deepStrictEqual(ownerWaitsOf(data).map((w) => w.quien), ['Dora']);
  // la sesión desde su archivo, igual que hoy
  const { data: d2 } = buildOffice({ wip: wip([]), sessionFiles: [sessionFile('abcdef1234567', { tool: 'codex', busy: false, step: 'Aprobar el plan', sentence: 'Espera el plan.' })],
    signatures: [planDe('abcdef1234567', 'aprobar el plan de otra story')], nowMs: NOW });
  assert.strictEqual(col(d2, 'firma').tarjetas.length, 1);
  assert.match(teTocaDe(d2), /Aprobar el plan/);
});

// la foto real: collect lee el registro y marca las ya aprobadas con el mismo chequeo que owner-next
const slG = require('../lib/signature-list.js');
const oaG = require('../lib/owner-approvals.js');
const MARKER_G = path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
function homeConFirma() {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-g-'));
  for (const d of ['active', 'adhoc', 'doing', 'office', 'coordination']) fs.mkdirSync(path.join(stateDir(home), d), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'tycon.json'), JSON.stringify({ approvals: { signature_list: 'on' } }));
  fs.writeFileSync(path.join(home, '.claude', 'sessions', 'ses-a.json'), JSON.stringify({ pid: process.pid, sessionId: 'ses-a', name: 'Ana', nameSource: 'user', status: 'idle', cwd: '/r' }));
  const comando = `node ${MARKER_G} mark-tested --acs 3`;
  slG.anotarFirma({ casa: home, firma: 'manual-test', titulo: 'marcar un criterio como probado a mano', sesion: 'ses-a', destino: 'ses-a', comando, palabras: require('../lib/owner-window.js').canonica(comando), cwd: '/r', ahora: NOW - 10 * 60000 });
  const pregunta = slG.siguiente({ casa: home, sesion: 'ses-a', ahora: NOW, arbol: [], validar: () => ({ ok: false }) }).pregunta;
  const clickHace = (min) => oaG.anotar(home, { tipo: 'click', sesion: 'ses-a', ts: new Date(NOW - min * 60000).toISOString(), tool_use_id: `tu-${min}`, pregunta, respuesta: oaG.APRUEBA });
  return { home, clickHace };
}
const fotoG = (home, more = {}) => collect({ home, now: new Date(NOW).toISOString(), siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), arbol: [], ...more });
const firmaG = (data) => JSON.stringify(data.kanban.columnas.find((c) => c.id === 'firma').tarjetas);
const cursoG = (data) => data.kanban.columnas.find((c) => c.id === 'curso').tarjetas;

test('T14 Office_FirmaAprobadaSinRepetir_EsperaALaSesion (la foto) @story-8.234 @ac-14: collect la marca y sale de «Tu firma»', async (t) => {
  const { home, clickHace } = homeConFirma();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  clickHace(2);
  const data = await fotoG(home, { validarAprobacion: () => ({ ok: true }) });
  assert.doesNotMatch(firmaG(data), /marcar un criterio/);
  assert.ok(cursoG(data).some((c) => /marcar un criterio/.test(c.titulo) && c.espera === 'aprobada: espera que Ana la repita'), JSON.stringify(cursoG(data)));
  assert.doesNotMatch(data.meta.teToca.join(' | '), /marcar un criterio/);
});

test('T15 Office_FirmaSinAprobar_ComoHoy (la foto) @story-8.234 @ac-15: vencida o sin poder leerla, sale como hoy y el motivo va a los avisos', async (t) => {
  // vencida (31 minutos): en «Tu firma», sin aviso
  let m = homeConFirma();
  t.after(() => fs.rmSync(m.home, { recursive: true, force: true }));
  m.clickHace(31);
  let data = await fotoG(m.home, { validarAprobacion: () => ({ ok: true }) });
  // como hoy: en «Tu firma», contada, en «Te toca» y con la mano «Espera tu firma» en Ana
  const comoHoy = (d) => {
    assert.match(firmaG(d), /marcar un criterio/);
    assert.match(d.kanban.linea, /Tu firma: 1/);
    assert.match(d.meta.teToca.join(' | '), /marcar un criterio/);
    assert.strictEqual(byName(d, 'Ana').mano, 'dueno', JSON.stringify(d.agents.map((a) => [a.nombre, a.estado, a.mano])));
  };
  comoHoy(data);
  assert.doesNotMatch(data.unreadable.join(' | '), /está aprobada/);
  // el click de esta firma que no se pudo leer: en «Tu firma», con el motivo en los avisos de la foto
  m = homeConFirma();
  t.after(() => fs.rmSync(m.home, { recursive: true, force: true }));
  m.clickHace(2);
  data = await fotoG(m.home, { validarAprobacion: () => ({ ok: false, motivo: 'no encontré la transcripción de la sesión ses-a', noLeida: true }) });
  comoHoy(data);
  assert.match(data.unreadable.join(' | '), /no pude saber si «marcar un criterio.*» de ses-a está aprobada: .*no encontré la transcripción/);
  // sin los procesos de la máquina, ninguna se da por aprobada, y se dice
  data = await fotoG(m.home, { arbol: null, validarAprobacion: () => ({ ok: true }) });
  comoHoy(data);
  assert.match(data.unreadable.join(' | '), /no pude leer los procesos de la máquina/);
});

// ── Las líneas de «Te toca» vencen ──────────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3600 * 1000;
// un tablero con cada línea y las horas que tiene: `{ 'texto': horas }`
const tocaBoard = (ages) => ({ pendientes: [], meta: { teToca: Object.keys(ages), teTocaDesde: Object.fromEntries(Object.entries(ages).map(([line, h]) => [line, localIsoAt(NOW - h * HOUR_MS)])) } });
const oldSignature = { id: 'f1', title: 'la firma vieja', at: NOW - 72 * HOUR_MS };

test('T5 Oficina_LineaVencida_NoSeMuestraYSeAvisa — @story-8.306 @ac-4 @ac-6', async () => {
  const { pick } = require(path.join(path.dirname(OFFICE), 'office', 'fields.js'));
  const photo = (ages) => {
    const board = buildBoard(tocaBoard(ages), { now: NOW, writtenAt: NOW });
    return { board, data: buildOffice({ wip: wip([]), signatures: [oldSignature], nowMs: NOW, board }).data };
  };
  const two = photo({ Vigente: 2, 'Vencida uno': 24, 'Vencida dos': 30 });
  assert.deepStrictEqual(two.data.meta.teToca, ['Firmar: la firma vieja', 'Vigente'], 'de esta lista leen la pared, el contador y el panel');
  for (const seen of [JSON.stringify(two.data), JSON.stringify(pick(two.data, '/home/nadie'))]) assert.ok(!seen.includes('Vencida'), 'el texto vencido no está en ninguna parte');
  const twoNotice = 'el tablero: 2 líneas de «Te toca» vencieron (más de 24 h sin confirmar) y no se muestran: la coordinadora las confirma o las saca con board.js due';
  const oneNotice = 'el tablero: 1 línea de «Te toca» venció (más de 24 h sin confirmar) y no se muestra: la coordinadora la confirma o la saca con board.js due';
  assert.strictEqual(two.data.meta.tocaAviso, twoNotice);
  assert.strictEqual(pick(two.data, '/home/nadie').meta.tocaAviso, twoNotice, 'viaja al sitio: sólo dice la cantidad');
  assert.deepStrictEqual(two.board.avisos, [], 'no es algo que la oficina no pudo leer');
  assert.strictEqual(photo({ Vigente: 2, Vencida: 30 }).data.meta.tocaAviso, oneNotice);
  assert.ok(!('tocaAviso' in photo({ Vigente: 2 }).data.meta), 'sin vencidas no hay aviso');
  // se ve sin nada más en la página: el bloque que se pliega queda oculto, abierto o no, y el aviso está afuera
  const html = page(two.data);
  const summary = html.match(/const RESUMEN_KEY=[\s\S]*?b\.onclick=[^\n]*\n/)[0];
  const paintNotice = html.match(/function pintarAvisoToca\(.*\n/)[0];
  const el = html.match(/const el=(\([^\n]*\});\n/)[1];
  const drawNotice = (notice, saved) => {
    const { document, byId } = tinyDom();
    for (const id of ['resumen', 'resumenLinea', 'resumenListas', 'tocaAviso']) byId[id] = document.createElement('div');
    byId.resumen.classList = { toggle() {} };
    byId.tocaAviso.hidden = true;
    document.createTextNode = (textContent) => ({ textContent });
    new Function('document', 'localStorage', `const el=${el};${summary}${paintNotice};pintarResumen(0,0);pintarAvisoToca(${JSON.stringify(notice)});`)(document, { getItem: () => saved, setItem() {} });
    return byId;
  };
  for (const saved of [null, '1']) {
    const shown = drawNotice(twoNotice, saved);
    assert.strictEqual(shown.resumenListas.hidden, true, 'sin nada que mostrar, las listas no se abren');
    assert.strictEqual(shown.tocaAviso.hidden, false, 'el aviso se ve igual');
    assert.strictEqual(shown.tocaAviso.textContent, twoNotice);
  }
  assert.strictEqual(drawNotice(undefined, null).tocaAviso.hidden, true, 'sin vencidas queda oculto');
  const between = html.slice(html.indexOf('<div class="resumen" id="resumen">'), html.indexOf('id="resumenListas"'));
  assert.ok(between.includes('id="tocaAviso"'), 'dentro de #resumen y antes de lo que se pliega');
  assert.ok(!between.includes('</div>'), 'sin cerrar #resumen antes');
  assert.match(html, /pintarAvisoToca\(meta&&meta\.tocaAviso\)/, 'cada foto lo vuelve a pintar');
  // por el camino entero: no entra en «No se pudo leer», que es lo que la coordinadora lee para saber si miró todo
  const raw = JSON.stringify(tocaBoard({ Vigente: 2, Vencida: 30 }));
  const data = await collectWith(raw);
  assert.deepStrictEqual(data.meta.teToca, ['Vigente']);
  assert.strictEqual(data.meta.tocaAviso, oneNotice);
  assert.ok(!data.unreadable.some((u) => /Te toca/.test(u)), data.unreadable.join(' | '));
  const { home, state } = toyHome();
  fs.mkdirSync(path.join(state, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(state, 'coordination', 'tablero.json'), raw);
  const waits = JSON.parse(run(home, ['--owner-waits', '--now', new Date(NOW).toISOString()]));
  assert.ok(!waits.problemas.some((p) => /Te toca/.test(p)), waits.problemas.join(' | '));
});

test('T13 Regresion_FirmasYPreguntasViejas_NoVencen — @story-8.306 @ac-13', () => {
  const board = buildBoard(tocaBoard({ Vencida: 30 }), { now: NOW, writtenAt: NOW });
  const asking = wip([{ session: 'Alma', sid: 'a', status: 'waiting_for_input', statusAt: NOW - 72 * HOUR_MS, extra: { kind: 'loose' } }]);
  const { data } = buildOffice({ wip: asking, signatures: [oldSignature], nowMs: NOW, board });
  assert.deepStrictEqual(data.meta.teToca, ['Firmar: la firma vieja', 'Contestar: Story Alma (Alma)']);
  // `sync` sin hechos no escribe, ni con una línea sin fecha ni sin tablero
  const boardTool = require(path.join(path.dirname(OFFICE), 'office', 'board.js'));
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-toca-'));
  const file = boardTool.paths(sdir).board;
  assert.deepStrictEqual(boardTool.sync(sdir, [], { now: NOW, live: [] }).written, false);
  assert.ok(!fs.existsSync(file), 'sin tablero no lo crea');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pendientes: [], meta: { teToca: ['Sin fecha'] } }));
  const before = { text: fs.readFileSync(file, 'utf8'), at: fs.statSync(file).mtimeMs };
  assert.strictEqual(boardTool.sync(sdir, [], { now: NOW, live: [] }).written, false);
  assert.deepStrictEqual({ text: fs.readFileSync(file, 'utf8'), at: fs.statSync(file).mtimeMs }, before);
});

// ---------- 8.313: las historias abiertas en main, por grupo, el proyecto principal y la hora del dato ----------

const OFFICE_8313 = require(OFFICE);
const { buildTables } = OFFICE_8313;
const { execFileSync } = require('child_process');
const PS_8313 = require(path.join(path.dirname(OFFICE), 'office', 'project-stories.js'));
const SD_8313 = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const HOUR_8313 = 3600e3;
const ymd8313 = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ab8313 = (id, estado = 'ready-for-dev', extra = {}) => ({ id, archivo: `story-${id}.md`, estado, ...extra });
const key8313 = (nombre) => `github/acme/${nombre}`;
/** Un proyecto de la lectura de fondo, con sus abiertas; su lugar es una carpeta de mentira. */
const proy8313 = (nombre, abiertas, extra = {}) => ({ nombre, traidoAt: atIso(NOW - 5 * HOUR_8313), deTuCopia: false, sinLeer: 0, repos: [key8313(nombre)], remoto: key8313(nombre), commit: 'c'.repeat(40), lugar: { repo: `/r/${nombre}`, ref: 'origin/main', common: `/r/${nombre}/.git` }, historias: [], abiertas, ...extra });
const snap8313 = (proyectos, at = NOW - 10 * 60e3) => ({ at: atIso(at), proyectos, sinHistorias: [], commitsPropios: { medido: true } });
// la carpeta de cada repo de mentira es de su proyecto: /r/<nombre> → github/acme/<nombre>
const remoteOf8313 = (dir) => { const m = /^\/r\/([^/]+)/.exec(String(dir || '')); return m ? key8313(m[1]) : null; };
const coord8313 = (nombre) => ({ sid: 'coord', cwd: `/r/${nombre}`, remote: key8313(nombre) });
/** Lo que la foto le pasa a la cuenta: la lectura, las ejecuciones y quién coordina. */
const open8313 = (snap, more = {}) => OFFICE_8313.openStories({ snap, runs: [], alive: new Set(), stopped: [], sessionStories: [], coordinator: coord8313('acme'), remoteOf: remoteOf8313, fetchedOf: () => null, nowMs: NOW, ...more });
const nums8313 = (p) => p && { total: p.total, enCurso: p.enCurso, enEspera: p.enEspera, sinComenzar: p.sinComenzar, conParte: p.conParte };
/** La foto de la oficina con la lectura de fondo y dos filas del tablero sin sesión. */
const office8313 = (projectStories, filas = []) => buildOffice({
  wip: wip([]), nowMs: NOW,
  board: OFFICE_8313.buildBoard({ pendientes: filas }),
  projectStories: { runs: [], alive: new Set(), stopped: [], coordinator: coord8313('acme'), remoteOf: remoteOf8313, fetchedOf: () => null, ...projectStories },
}).data;
const FILAS_8313 = [{ id: 'T-1', titulo: 'Fila uno', estado: 'espera', grupo: 'Hoy', orden: 1 }, { id: 'T-2', titulo: 'Fila dos', estado: 'espera', grupo: 'Hoy', orden: 2 }];

test('T3 Grupos_CadaHistoriaEnUnoYSumanElTotal @story-8.313 @ac-2 @ac-3 — cada camino en su grupo, la suma da el total y conParte cuenta la in-progress sola', () => {
  const hoy = ymd8313(NOW);
  const ayer = ymd8313(NOW - 24 * HOUR_8313);
  const acme = proy8313('acme', [
    ab8313('3.1', 'in-progress'), ab8313('3.2', 'in-progress'), ab8313('3.3', 'ready-for-dev'),
    ab8313('3.4', 'review'), ab8313('3.5', 'blocked'), ab8313('3.6', 'ready-for-dev', { pendientes: ['9.9'] }),
    ab8313('3.7', 'ready-for-dev', { pausa: hoy }), ab8313('3.8', 'ready-for-dev', { pausa: ayer }),
    ab8313('3.9', 'ready-for-dev'), ab8313('3.10', 'in-progress'),
  ]);
  const a = open8313(snap8313([acme]), {
    runs: [{ archivo: 'story-3.1.md', sessionId: 'viva', activo: true, repoPath: '/r/acme/wt' }],
    alive: new Set(['viva']),
    stopped: [{ storyId: '3.2', archivo: 'story-3.2.md', repoPath: '/r/acme' }],
    sessionStories: [{ id: '3.3', remote: key8313('acme') }],
  });
  assert.ok(a.principal, JSON.stringify(a));
  assert.deepStrictEqual(nums8313(a.principal), { total: 10, enCurso: 3, enEspera: 4, sinComenzar: 3, conParte: 1 });
  assert.strictEqual(a.principal.enCurso + a.principal.enEspera + a.principal.sinComenzar, a.principal.total);
  assert.strictEqual(a.principal.total, acme.abiertas.length, 'el total es la cantidad de abiertas');
  assert.strictEqual(a.principal.nombre, 'acme');
  assert.strictEqual(a.principal.leidoAt, atIso(NOW - 10 * 60e3));
  assert.strictEqual(a.principal.commit, 'c'.repeat(40));
  assert.strictEqual(a.linea, 'Abiertas: 10 · 3 en curso · 4 en espera · 3 sin comenzar');
  assert.strictEqual(a.principal.detalle, 'Abiertas: 10 · 3 en curso · 4 en espera · 3 sin comenzar (1 con una parte hecha)');
});

test('T4 Grupos_MarcadorDeSesionMuerta_NoEsEnCurso @story-8.313 @ac-3 — sesión muerta, cierre reciente, la coordinadora y lo de otro repo con el mismo archivo no son «en curso»', () => {
  const acme = proy8313('acme', [ab8313('4.1'), ab8313('4.2'), ab8313('4.3'), ab8313('4.4'), ab8313('4.5')]);
  const a = open8313(snap8313([acme]), {
    runs: [
      { archivo: 'story-4.1.md', sessionId: 'muerta', activo: true, repoPath: '/r/acme' },
      { archivo: 'story-4.2.md', sessionId: 'cerro', activo: false, repoPath: '/r/acme' },
      { archivo: 'story-4.3.md', sessionId: 'coord', activo: true, repoPath: '/r/acme' },
      { archivo: 'story-4.4.md', sessionId: 'viva', activo: true, repoPath: '/r/otro' },
    ],
    alive: new Set(['cerro', 'coord', 'viva']),
    stopped: [{ storyId: '4.5', archivo: 'story-4.5.md', repoPath: '/r/otro' }],
  });
  assert.deepStrictEqual(nums8313(a.principal), { total: 5, enCurso: 0, enEspera: 0, sinComenzar: 5, conParte: 0 });
  // en la foto, la sesión coordinadora con tarjeta que nombra una historia tampoco cuenta
  const data = buildOffice({
    wip: wip([{ session: 'Coordinadora', sid: 'coord', work: 'Story 4.3', extra: { kind: 'pipeline', storyId: '4.3', current: 'implement', steps: STEPS } }]),
    nowMs: NOW, coordinatorSid: 'coord', coordinatorName: 'Coordinadora',
    projectStories: { snap: snap8313([acme]), runs: [], alive: new Set(['coord']), stopped: [], coordinator: coord8313('acme'), remoteOf: remoteOf8313, fetchedOf: () => null },
  }).data;
  assert.strictEqual(data.kanban.abiertas.principal.enCurso, 0, JSON.stringify(data.kanban.abiertas));
});

test('T5 Principal_EsElProyectoDeLaCoordinadora @story-8.313 @ac-2 @ac-5 — dos proyectos, la coordinadora en una copia del segundo: office.js --json trae sus números', () => {
  const { home } = toyHome();
  const sdir = SD_8313.stateDir(home);
  // la carpeta de la coordinadora: una copia de trabajo del segundo proyecto, con su remoto (sin red)
  const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'office-8313-copia-'));
  const g = (...args) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: copia, stdio: 'pipe' });
  g('init', '-q');
  g('remote', 'add', 'origin', 'https://github.com/acme/dos.git');
  const key = PS_8313.remoteKey(copia);
  assert.ok(key, 'el remoto de la copia se reconoce');
  const now = Date.now();
  const uno = { ...proy8313('uno', [ab8313('1.1'), ab8313('1.2')]), traidoAt: null };
  const dos = { ...proy8313('dos', [ab8313('2.1', 'review'), ab8313('2.2'), ab8313('2.3', 'in-progress')]), remoto: key, repos: [key], traidoAt: null };
  fs.mkdirSync(path.join(sdir, 'office'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'office', 'project-stories.json'), JSON.stringify(snap8313([uno, dos], now - 60e3)));
  fs.writeFileSync(path.join(sdir, 'gates.log'), `${JSON.stringify({ name: 'relay-designation', status: 'ok', sesion: 'coord', via: 'click', ts: atIso(now - HOUR_8313) })}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'sessions', 'coord.json'), JSON.stringify({ pid: process.pid, sessionId: 'coord', name: 'Coordinadora', status: 'idle', statusUpdatedAt: now, cwd: copia }));
  const data = JSON.parse(run(home, ['--json', '--now', new Date(now).toISOString()]));
  const a = data.kanban.abiertas;
  assert.ok(a && a.principal, JSON.stringify(a));
  assert.strictEqual(a.principal.nombre, 'dos');
  assert.deepStrictEqual(nums8313(a.principal), { total: 3, enCurso: 0, enEspera: 1, sinComenzar: 2, conParte: 1 });
  assert.deepStrictEqual(a.otros.map((p) => [p.nombre, p.total]), [['uno', 2]]);
  assert.strictEqual(a.linea, 'Abiertas: 3 · 0 en curso · 1 en espera · 2 sin comenzar');
  assert.ok(!JSON.stringify(a).includes('/r/'), 'ni la ruta de un repo');
});

test('T6 Otros_VanAparteYNoSeSuman @story-8.313 @ac-6 — el principal cuenta lo suyo; el otro va aparte con sus grupos y su renglón', () => {
  const a = open8313(snap8313([proy8313('acme', [ab8313('6.1'), ab8313('6.2', 'review'), ab8313('6.3')]), proy8313('beta', [ab8313('7.1', 'blocked'), ab8313('7.2')])]));
  assert.strictEqual(a.principal.total, 3);
  assert.strictEqual(a.otros.length, 1);
  assert.deepStrictEqual(nums8313(a.otros[0]), { total: 2, enCurso: 0, enEspera: 1, sinComenzar: 1, conParte: 0 });
  assert.strictEqual(a.otros[0].renglon, 'beta: 2 abiertas · 0 en curso · 1 en espera · 1 sin comenzar');
});

test('T7 SinPrincipal_DiceElMotivo @story-8.313 @ac-13 — sin coordinadora, sin carpeta, repo ajeno y empate: sin principal, todos en otros y la nota', () => {
  const ps = [proy8313('acme', [ab8313('7.1')]), proy8313('beta', [ab8313('7.2')])];
  const empate = [proy8313('acme', [ab8313('7.1')]), proy8313('beta', [ab8313('7.2')], { remoto: key8313('acme') })];
  const casos = [
    ['sin coordinadora', { coordinator: null }, ps, /no hay coordinadora designada/],
    ['sin carpeta', { coordinator: { sid: 'coord', cwd: null, remote: null } }, ps, /no sé en qué carpeta trabaja la coordinadora/],
    ['repo ajeno', { coordinator: coord8313('gamma') }, ps, /no es de ningún proyecto leído/],
    ['empate', {}, empate, /más de un proyecto/],
  ];
  for (const [nombre, more, proyectos, motivo] of casos) {
    const a = open8313(snap8313(proyectos), more);
    assert.strictEqual(a.principal, undefined, nombre);
    assert.strictEqual(a.otros.length, 2, `${nombre}: todos en otros`);
    assert.match(a.nota, /^Sin proyecto principal: /, nombre);
    assert.match(a.nota, motivo, nombre);
    assert.strictEqual(a.linea, a.nota, `${nombre}: la pantalla muestra la nota en lugar del número`);
  }
});

test('T8 Abiertas_SinLecturaOVieja_NoDaNumero @story-8.313 @ac-12 — sin archivo, roto, de 61 minutos o de antes del cambio: sin números, con nota', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-8313-lectura-'));
  const sinArchivo = dir();
  const roto = dir();
  fs.mkdirSync(path.join(roto, 'office'));
  fs.writeFileSync(path.join(roto, 'office', 'project-stories.json'), '{ roto');
  const vieja = dir();
  fs.mkdirSync(path.join(vieja, 'office'));
  fs.writeFileSync(path.join(vieja, 'office', 'project-stories.json'), JSON.stringify(snap8313([proy8313('acme', [ab8313('8.1')])], NOW - 61 * 60e3)));
  for (const [nombre, sd] of [['sin archivo', sinArchivo], ['rota', roto], ['de 61 minutos', vieja]]) {
    const r = PS_8313.readSnapshot(sd, NOW);
    const a = open8313(r.snap, { nota: r.nota });
    assert.strictEqual(a.principal, undefined, nombre);
    assert.ok(!('total' in a) && !(a.otros || []).length, `${nombre}: sin números`);
    assert.strictEqual(a.linea, 'Abiertas: sin dato', nombre);
    assert.strictEqual(a.nota, r.nota, `${nombre}: con el motivo de readSnapshot`);
  }
  const antes = snap8313([{ ...proy8313('acme', [ab8313('8.1')]), abiertas: undefined }]);
  const a = open8313(antes);
  assert.strictEqual(a.linea, 'Abiertas: sin dato');
  assert.match(a.nota, /antes del número de abiertas: se relee en el próximo control/);
  // en pantalla
  const data = office8313({ snap: null, nota: 'No pude leer los pendientes de tus proyectos' });
  assert.ok(wallTexts(data).includes('Abiertas: sin dato'), 'la pared lo dice');
  assert.ok(!wallTexts(data).some((t) => /^Abiertas: \d/.test(t)), 'nunca un número');
});

test('T11 Pantalla_MuestraElNumeroYSuHora @story-8.313 @ac-4 @ac-11 — pared, detalle y kanban dicen el número y de cuándo es', () => {
  const snap = snap8313([proy8313('acme', [ab8313('11.1'), ab8313('11.2', 'review')])]);
  const leido = `Leído a las ${hm(NOW - 10 * 60e3)}`;
  const con = (fetchedOf, more = {}) => office8313({ snap, fetchedOf, ...more });
  const linea = 'Abiertas: 2 · 0 en curso · 1 en espera · 1 sin comenzar';
  const enLasTres = (data, hora) => {
    const pared = wallTexts(data);
    assert.ok(pared.includes(linea), `la pared: ${pared.join(' | ')}`);
    assert.ok(pared.includes(hora), `la pared, la hora: ${pared.join(' | ')}`);
    const detalle = textOf(openWallPanel(data));
    assert.ok(detalle.includes(linea) && detalle.includes(hora) && detalle.includes('acme'), `el detalle: ${detalle}`);
    const kanban = textOf(drawKanban(data).body);
    assert.ok(kanban.includes(linea) && kanban.includes(hora) && kanban.includes('acme'), `el kanban: ${kanban}`);
  };
  enLasTres(con(() => atIso(NOW - 3 * 60e3)), `${leido} · main traído hace 3 min`);
  enLasTres(con(() => atIso(NOW - 3 * HOUR_8313)), `${leido} · main traído hace 3 h`);
  // un fetch más nuevo sin releer: se ve en la foto siguiente
  enLasTres(con(() => atIso(NOW - 60e3)), `${leido} · main traído hace 1 min`);
  // sin poder leer el FETCH_HEAD, vale el guardado (hace 5 h)
  enLasTres(con(() => null), `${leido} · main traído hace 5 h`);
  // sin ninguna de las dos
  const sinHora = snap8313([proy8313('acme', [ab8313('11.1'), ab8313('11.2', 'review')], { traidoAt: null })]);
  enLasTres(office8313({ snap: sinHora, fetchedOf: () => null }), `${leido} · no sé cuándo se trajo main`);
  // leída de la copia
  const copia = snap8313([proy8313('acme', [ab8313('11.1'), ab8313('11.2', 'review')], { deTuCopia: true, commit: null })]);
  enLasTres(office8313({ snap: copia, fetchedOf: () => null }), `${leido} · de tu copia`);
});

test('T12 Detalle_ListaLosOtrosProyectos @story-8.313 @ac-4 @ac-6 @ac-14 — los otros con sus avisos en el detalle; el principal con su parte hecha; la pared no los nombra', () => {
  const snap = snap8313([
    proy8313('acme', [ab8313('12.1', 'in-progress'), ab8313('12.2')]),
    proy8313('beta', [ab8313('13.1')], { sinLeer: 1 }),
    proy8313('gamma', [ab8313('14.1'), ab8313('14.2')], { deTuCopia: true, commit: null }),
  ]);
  const data = office8313({ snap });
  const detalle = textOf(openWallPanel(data));
  assert.ok(detalle.includes('(1 con una parte hecha)'), detalle);
  assert.ok(detalle.includes('Otros proyectos'), detalle);
  assert.ok(detalle.includes('beta: 1 abiertas · 0 en curso · 0 en espera · 1 sin comenzar · 1 no se pudo leer'), detalle);
  assert.ok(detalle.includes('gamma: 2 abiertas · 0 en curso · 0 en espera · 2 sin comenzar · de tu copia'), detalle);
  const pared = wallTexts(data).join(' | ');
  assert.ok(!/beta|gamma/.test(pared), `la pared no los muestra: ${pared}`);
  assert.strictEqual(data.kanban.abiertas.principal.total, 2, 'no se suman al principal');
});

test('T13 SinSesion_NoCuentaLasPlegadas @story-8.313 @ac-7 — 2 filas y 3 historias plegadas: la columna dice 2 en todos lados y la línea plegada 3', () => {
  const hist = (id) => ({ id, archivo: `story-${id}.md`, titulo: `La historia ${id}`, estado: 'ready-for-dev', prioridad: null, trabajo: null });
  const acme = proy8313('acme', [ab8313('5.1'), ab8313('5.2'), ab8313('5.3')], { historias: [hist('5.1'), hist('5.2'), hist('5.3')] });
  const data = office8313({ snap: snap8313([acme]) }, FILAS_8313);
  const { body } = drawKanban(data);
  const nodos = all(body, () => true);
  assert.ok(nodos.some((n) => n.tag === 'h3' && n.textContent === 'Sin sesión · 2'), 'el encabezado');
  assert.ok(nodos.some((n) => n.tag === 'button' && n.textContent === 'Historias de tus proyectos · 3'), 'la línea plegada');
  const pared = wallTexts(data);
  const i = pared.indexOf('Sin sesión');
  assert.strictEqual(pared[i - 1], '2', `la pared: ${pared.join(' | ')}`);
  const detalle = all(openWallPanel(data), (n) => n.className === 'cnt').map(textOf);
  assert.ok(detalle.includes('2Sin sesión'), `el detalle: ${detalle.join(' | ')}`);
  const t = buildTables({ kanban: data.kanban, nowMs: NOW, sinModelo: true });
  assert.match(t.pendientes.cruce, /\b2 sin sesión\b/);
});

test('Regresion_ParedSinPrincipal_ElMotivoEntero @story-8.313 @ac-13 — en la pared, el motivo largo de «Sin proyecto principal» entra en el ancho del panel, sin cortarse', () => {
  const data = office8313({ snap: snap8313([proy8313('beta', [ab8313('1.1')])]), coordinator: coord8313('gamma') });
  const motivo = data.kanban.abiertas.linea;
  assert.match(motivo, /^Sin proyecto principal: el repo de la coordinadora no es de ningún proyecto leído$/);
  // la pared, con un lienzo que mide: cada letra ocupa lo que dice su tamaño de letra
  const html = page(data);
  const fn = (html.match(/function drawPanel\(\)\{[\s\S]*?texPanel\.needsUpdate=true;\}/) || [])[0];
  const order = (html.match(/function paredEnOrden\(K\)\{.*\}\n/) || [])[0];
  assert.ok(fn && order, 'la página trae el dibujo de la pared');
  const lines = [];
  const state = { font: '26px x' };
  const px = () => Number((/(\d+)px/.exec(state.font) || [0, 26])[1]);
  const g = new Proxy({}, {
    get: (_, k) => (k === 'fillText' ? (t, x) => lines.push({ t: String(t), x, w: String(t).length * px() * 0.55 })
      : k === 'measureText' ? (t) => ({ width: String(t).length * px() * 0.55 }) : k === 'font' ? state.font : () => {}),
    set: (_, k, v) => { if (k === 'font') state.font = v; return true; },
  });
  new Function('texPanel', 'T', 'KCOL', 'HALF', 'FONT', 'stampOf', `${order}${fn};drawPanel();`)({ userData: { g } }, { kanban: () => data.kanban, meta: () => data.meta }, {}, '#f00', 'x', () => 'sello');
  const parts = lines.filter((l) => motivo.includes(l.t.trim()) && l.t.trim().length > 3);
  assert.ok(parts.length, `la pared dice el motivo: ${lines.map((l) => l.t).join(' | ')}`);
  assert.strictEqual(parts.map((l) => l.t.trim()).join(' '), motivo, 'el motivo entero, aunque vaya en dos renglones');
  for (const l of parts) assert.ok(l.x + l.w <= 768 - 36, `«${l.t}» entra en el panel (termina en ${Math.round(l.x + l.w)})`);
});

test('Regresion_PrincipalConNoLeidas_LoDice @story-8.313 @ac-14 — si el proyecto principal tiene historias sin leer, la pared, el detalle y el kanban lo dicen junto al número', () => {
  const data = office8313({ snap: snap8313([proy8313('acme', [ab8313('9.1'), ab8313('9.2', 'review')], { sinLeer: 2 })]) });
  assert.strictEqual(data.kanban.abiertas.principal.total, 2, 'las no leídas no entran en el total');
  const aviso = '2 no se pudieron leer';
  assert.ok(wallTexts(data).some((t) => t.includes(aviso)), `la pared: ${wallTexts(data).join(' | ')}`);
  assert.ok(textOf(openWallPanel(data)).includes(aviso), 'el detalle');
  assert.ok(textOf(drawKanban(data).body).includes(aviso), 'el kanban');
});

test('T20 Regresion_TarjetasYColumnasIguales @story-8.313 @ac-20 — la misma foto con y sin abiertas: tarjetas, filas «De tus proyectos» y columnas iguales', () => {
  const hist = (id) => ({ id, archivo: `story-${id}.md`, titulo: `La historia ${id}`, estado: 'ready-for-dev', prioridad: null, trabajo: null });
  const con = proy8313('acme', [ab8313('20.1'), ab8313('20.2', 'draft')], { historias: [hist('20.1')] });
  const sin = { ...con };
  delete sin.abiertas;
  const a = office8313({ snap: snap8313([con]) }, FILAS_8313);
  const b = office8313({ snap: snap8313([sin]) }, FILAS_8313);
  assert.ok(a.kanban.abiertas.principal && !b.kanban.abiertas.principal, 'una trae el número y la otra no');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.kanban.columnas)), JSON.parse(JSON.stringify(b.kanban.columnas)));
  const ta = buildTables({ kanban: a.kanban, nowMs: NOW, sinModelo: true });
  const tb = buildTables({ kanban: b.kanban, nowMs: NOW, sinModelo: true });
  assert.deepStrictEqual(ta.pendientes.filas, tb.pendientes.filas);
  assert.strictEqual(ta.pendientes.cruce, tb.pendientes.cruce);
});

test('T343 Kanban_FirmaDeSesionQueNoEsta_SinSesion: una firma del tablero para una sesión que ya no está no espera al dueño', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Ana', status: 'busy', work: '9.1 · Una', extra: { kind: 'pipeline', title: 'Una', storyId: '9.1', current: 'implement' } }]),
    board: buildBoard({ pendientes: [
      { titulo: 'La de una sesión cerrada', estado: 'firma', quien: 'Muerta-6' },
      { titulo: 'La de Ana', estado: 'firma', quien: 'Ana (la tanda B)' },
      { titulo: 'La tuya', estado: 'firma', quien: 'vos' },
      { titulo: 'Sin nombre', estado: 'firma' },
    ] }),
    nowMs: NOW,
  });
  assert.deepStrictEqual(titles(data, 'firma').sort(), ['La de Ana', 'La tuya', 'Sin nombre'].sort(), 'la de una sesión viva, la del dueño y la que no nombra a nadie siguen en «Tu firma»');
  const sin = col(data, 'sinEmpezar').tarjetas.find((t) => t.titulo === 'La de una sesión cerrada');
  assert.ok(sin, 'la de la sesión que ya no está va a «Sin sesión»');
  assert.strictEqual(sin.motivo, 'la sesión que la esperaba ya no está');
  assert.ok(!JSON.stringify((data.meta.esperan || {}).dueno || []).includes('Muerta-6'), '«Esperan al dueño» no la nombra');
  // el nombre entero: una sesión viva «Tero» no retiene la firma de «Tero-2», que ya no está. Lo que no es un nombre de
  // sesión (el dueño dicho de otra forma, un texto) se queda; la hora de la que se mueve es la de «Sin sesión»
  const otra = buildOffice({
    wip: wip([{ session: 'Tero', status: 'busy', work: '9.1 · Una', extra: { kind: 'pipeline', title: 'Una', storyId: '9.1', current: 'implement' } }]),
    board: buildBoard({ pendientes: [
      { titulo: 'De Tero-2', estado: 'firma', quien: 'Tero-2' },
      { titulo: 'De Tero', estado: 'firma', quien: 'tero' },
      { titulo: 'Vos decidís', estado: 'firma', quien: 'Vos decidís' },
      { titulo: 'La dueña', estado: 'firma', quien: 'la dueña' },
      { titulo: 'Con hora', estado: 'firma', quien: 'Pinola-6', pronosticoIso: '2026-10-18T08:00' },
    ] }),
    nowMs: NOW,
  }).data;
  assert.deepStrictEqual(titles(otra, 'firma').sort(), ['De Tero', 'La dueña', 'Vos decidís'].sort());
  // un nombre de más de 40 letras: la lista de sesiones lo muestra cortado con «…», y la firma escrita con el nombre
  // entero sigue siendo de esa sesión viva
  const largo = 'fila-de-prueba-con-un-nombre-que-pasa-de-los-cuarenta';
  const conLargo = buildOffice({
    wip: wip([{ session: largo.slice(0, 39) + '…', status: 'busy', work: '9.2 · Otra', extra: { kind: 'pipeline', title: 'Otra', storyId: '9.2', current: 'implement' } }]),
    board: buildBoard({ pendientes: [{ titulo: 'De la larga', estado: 'firma', quien: largo }] }),
    nowMs: NOW,
  }).data;
  assert.deepStrictEqual(titles(conLargo, 'firma'), ['De la larga'], 'la sesión de nombre largo está viva: su firma se queda');
  const hora = col(otra, 'sinEmpezar').tarjetas.find((t) => t.titulo === 'Con hora');
  assert.ok(col(otra, 'sinEmpezar').tarjetas.some((t) => t.titulo === 'De Tero-2'), 'la de Tero-2 va a «Sin sesión»');
  assert.ok(hora && /^estaba para /.test(hora.hora) && !hora.cls, `sin sesión no hay nadie atrasado: ${JSON.stringify(hora)}`);
});
