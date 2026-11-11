'use strict';
// office-board.test.js — the board and the kanban of the office: its columns, «Tu firma», «En curso» and the pull requests. The shared toys live in lib/office-fixtures.js.
// Through that library the cases run scripts/tools/office.js and skills/tycon-pipeline/scripts/marker.js: named
// here so the dependency reader of the validation follows them from this file, as it follows what a suite names.
// Nothing here reads the real HOME: the command-line tests run with a toy HOME.
// stable-data: every date comes in by argument or by --now.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  OFFICE, PAGE_CODE, NOW, STEPS, byName, run, runMarker, BOARD, all, textOf, sessionFile, STEP_LIB, col, titles, hm,
  IDS, runMarkerFile, BEFORE_PLAN, CLOSED, sessionWith, atIso, KANBAN_BOARD, collectAt, localIsoAt, mixedOffice,
  WALL_ORDER, toyKanban, firmaCard, firmaData, wip, toyHome, toyMachine, storyFile, collectWith, drawKanban, toyRepo,
  parkMachine, openWallPanel, wallTexts, firmaOffice, filesOf, buildOffice, page, collect, buildBoard,
  createEnvelopes, ownerWaitsOf
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
