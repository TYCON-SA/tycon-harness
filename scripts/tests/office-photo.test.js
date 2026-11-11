'use strict';
// office-photo.test.js — the photo of the office: the state, the sentence and the work of each session, its agents, its tokens and what it waits for. The shared toys live in lib/office-fixtures.js.
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
  OFFICE, PAGE_CODE, NOW, STEPS, byName, run, MARKER, liveSession, runMarker, all, sessionFile, STEP_LIB, col,
  titles, hm, IDS, runMarkerFile, BEFORE_PLAN, CLOSED, sessionWith, noPrs, atIso, collectAt, ddmm, ymd, parked,
  oldHours, mixedOffice, PLATFORMS, waitingWip, readerOf, NO_OPEN, codexFile, wip, toyHome, toyMachine, storyFile,
  toyRepo, ownerMachine, parkMachine, originRepo, toyCodexBase, execFileSync, buildOffice, page, prsNamedIn,
  waitedPrsSaid, askWaitingPrs, tokensTxt, tokensCard, buildWip, stateDir, spawnSync, wipNow, createEnvelopes
} = require('./lib/office-fixtures.js');

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

test('T88 OwnerSignature_PlanAndSave @story-2.81 @ac-46: lo que espera al dueño es «Tu firma», también en Codex', async () => {
  const { now, w } = await ownerMachine();
  const { data } = buildOffice({ wip: w, nowMs: now, sessionFiles: [sessionFile('cx', { tool: 'codex', pid: null, name: 'Codina', step: 'Aprobar el plan', sentence: 'Va por el paso «Aprobar el plan».', busy: false })] });
  assert.strictEqual(byName(data, 'Plan').estado, 'firma');
  assert.strictEqual(byName(data, 'Plan').espera, 'que apruebes el plan');
  assert.strictEqual(byName(data, 'Guardar').estado, 'firma');
  assert.strictEqual(byName(data, 'Guardar').espera, 'abrir el pull request');
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
  assert.strictEqual(row.state, 'Terminó: espera tu sí para abrir el pull request');
  assert.match(row.work, /^9\.9 · Espera guardar/);
  assert.ok(!w.free.includes('Guardar'));
  assert.match(w.text, /Terminó: espera tu sí para abrir el pull request/);
});

test('8.242-T16 Oficina_EsperaTuSiParaElPedido: la corrida terminada espera tu sí para abrir el pull request, y el tablero lo pide como «Tu firma»', async () => {
  const { now, w } = await ownerMachine();
  const row = w.rows.find((r) => r.session === 'Guardar');
  assert.strictEqual(row.state, 'Terminó: espera tu sí para abrir el pull request');
  const { data } = buildOffice({ wip: w, nowMs: now });
  const tarjeta = col(data, 'firma').tarjetas.find((t) => t.quien === 'Guardar');
  assert.ok(tarjeta, 'la corrida terminada no está en «Tu firma»');
  assert.strictEqual(tarjeta.espera, 'abrir el pull request');
  const { realState } = require(path.join(path.dirname(OFFICE), 'work-in-progress.js'));
  const r = realState({ kind: 'finished' }, { status: 'idle' }, null);
  assert.strictEqual(`Tu firma: ${r.espera}`, 'Tu firma: abrir el pull request');
  assert.ok(!/ok para guardar/.test(JSON.stringify(data)), 'la oficina todavía dice «el ok para guardar»');
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
  assert.strictEqual(byName(data, 'Dora').espera, 'abrir el pull request');
  assert.match(line('Dora'), /Terminó: espera tu sí para abrir el pull request/);
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

test('T220 Step_RunTests_Codex_NotKnown: con Codex, no encontrarlas no dice que no haya', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Eva', sid: 'e', status: null, extra: { kind: 'pipeline', current: 'run-tests', steps: STEPS } }]), sessionFiles: [{ session: 'e', tool: 'codex', pid: 10, busy: true }], processes: [{ pid: 11, ppid: 10, comando: 'sleep 5' }], nowMs: NOW });
  assert.match(byName(data, 'Eva').haciendo, /No se sabe si hay pruebas corriendo\.$/);
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

test('T233 SameText_NoRepeat: si lo que hace es lo que anotó, la tarjeta no lo dice dos veces; un título sigue sin números de pedido', () => {
  const { plain: plainOf } = require(OFFICE);
  const html = page(mixedOffice());
  assert.match(html, /else if\(a\.haciendo!==a\.titulo&&!SOLO_COORDINA\.test\(a\.haciendo\|\|""\)\)add\("Haciendo",a\.haciendo\)/);
  assert.strictEqual(plainOf('espera que entren el #907 y el 6106', { keepPrs: true }), 'espera que entren el #907 y el 6106');
  assert.strictEqual(plainOf('espera que entren el #907 y el 6106'), 'espera que entren y el 6106', 'los títulos siguen sin números de pedido');
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

test('T248 WaysOfWorking_Coordinator: la coordinadora dice que coordina, también con un arreglo abierto', () => {
  const { data } = buildOffice({ nowMs: NOW, coordinatorSid: 'sid-Ana', coordinatorName: 'Ana', wip: wip([{ session: 'Ana', extra: { kind: 'loose', text: 'Un arreglo' } }, { session: 'Beto', extra: { kind: 'loose', text: 'Otro' } }]) });
  assert.deepStrictEqual(data.agents.map((a) => [a.nombre, a.comoTrabaja]), [['Ana', 'Coordinando'], ['Beto', 'Camino corto']]);
  const free = buildOffice({ nowMs: NOW, coordinatorName: 'Ana', wip: wip([], { free: ['Ana'], freeSids: ['s'], freeStatus: ['idle'] }) });
  assert.strictEqual(free.data.agents[0].comoTrabaja, 'Coordinando');
});

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
