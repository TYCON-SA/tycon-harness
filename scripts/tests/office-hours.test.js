'use strict';
// office-hours.test.js — the hours of the office: the promised hour of each work, how late it runs and the hour of its step. The shared toys live in lib/office-fixtures.js.
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
  OFFICE, NOW, STEPS, byName, run, MARKER, liveSession, runMarker, STEP_LIB, col, hm, IDS, runMarkerFile,
  BEFORE_PLAN, sessionWith, noPrs, atIso, hourRun, collectAt, ddmm, ymd, parked, oldHours, wip, pageTimeHelpers,
  toyMachine, storyFile, markerAt, toyRepo, parkMachine, buildOffice, page, buildWip, stateDir, wipNow, collect
} = require('./lib/office-fixtures.js');

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

test('T92 NotePromise_PerDeclaration @story-2.81 @ac-49: una nota nueva con el mismo texto empieza una promesa nueva', () => {
  const note = (declaredAt, endAt) => ({ session: 'Nota', extra: { kind: 'note', text: 'Ordeno las pruebas', endAt, hourAt: declaredAt, promiseAt: declaredAt } });
  const first = buildOffice({ wip: wip([note(NOW - 2 * 3600000, NOW - 3600000)]), nowMs: NOW - 90 * 60000 });
  const { data } = buildOffice({ wip: wip([note(NOW - 30 * 60000, NOW + 30 * 60000)]), promises: first.promises, nowMs: NOW });
  assert.deepStrictEqual([byName(data, 'Nota').fin.dif, byName(data, 'Nota').fin.cls], ['en hora', 'ontime']);
});

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

test('T132 Finished_NoLatePromise @story-2.81 @ac-62: una corrida terminada no sale atrasada por su promesa', () => {
  const { data } = buildOffice({ wip: wip([{ session: 'Ana', status: 'idle', extra: { kind: 'finished', storyId: '9.9', title: 'T', promisedAt: NOW - 3600000 } }]), nowMs: NOW });
  const a = byName(data, 'Ana');
  assert.strictEqual(a.atrasada, undefined);
  assert.strictEqual(a.atrasoMin, undefined);
  assert.strictEqual(a.fin.hora, 'sin hora estimada');
  assert.strictEqual(a.espera, 'abrir el pull request');
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
