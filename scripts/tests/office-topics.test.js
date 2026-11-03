'use strict';
// office-topics.test.js — el tema de cada trabajo de la oficina: lo guardado, el modelo, el respaldo y el gasto. El modelo es
// siempre de juguete: ninguna prueba sale a la red.
// stable-data: toda fecha entra por argumento.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOPICS =path.join(__dirname, '..', 'tools', 'office', 'topics.js');
const T = require(TOPICS);

const NOW = Date.parse('2026-11-03T14:00:00.000Z');
const MIN = 60000;

const orgOf = (nightly, table) => ({
  version: 1,
  public: { platform: 'github', org: 'acme', repo: 'harness' },
  profile: { platform: 'github', org: 'acme', repo: 'harness-profile' },
  operations: { platform: 'github', org: 'acme', repo: 'harness-ops' },
  models: { ...(nightly ? { nightly } : {}), providers: { ollama: table } },
});

// Una máquina de juguete: su carpeta de estado y la configuración de la organización, con el modelo de la noche.
function toy({ nightly = { provider: 'ollama', level: 'economy' }, table = { economy: 'gemma-chico' }, pending = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-topics-'));
  const sdir = path.join(dir, 'estado');
  fs.mkdirSync(path.join(sdir, 'office'), { recursive: true });
  const orgConfig = path.join(dir, 'team-repos.json');
  fs.writeFileSync(orgConfig, JSON.stringify(orgOf(nightly, table)));
  if (pending.length) T.writePending(sdir, pending);
  return { dir, sdir, orgConfig };
}

// El servicio local de juguete: contesta los modelos registrados y una tanda de temas; anota cada pedido.
function localService({ models = ['gemma-chico-cloud'], answer = (titles) => titles.map(() => 'Oficina'), tokens = { prompt_eval_count: 100, eval_count: 20 } } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: models.map((name) => ({ name })) }), text: async () => JSON.stringify({ models: models.map((name) => ({ name })) }) };
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, prompt: body.messages[0].content });
    const titles = JSON.parse(body.messages[0].content.split('Títulos:\n')[1]);
    const content = answer(titles);
    const text = JSON.stringify({ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, ...tokens });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { impl, calls };
}
const opts = (m, svc, more = {}) => ({ sdir: m.sdir, orgConfig: m.orgConfig, env: {}, fetchImpl: svc.impl, nowMs: NOW, namesFile: null, ...more });
const work = (titulo, clave = T.workKey({ titulo }), more = {}) => ({ clave, titulo, ...more });
const saved = (m) => T.readTopics(m.sdir).temas;

test('T1 Classify_SendsOnlyNewTitles @story-8.184 @ac-6 @ac-10: el pedido lleva un título y los temas usados, nada más', async () => {
  const m = toy({ pending: [work('Título viejo', 'titulo:viejo'), work('Título nuevo', 'titulo:nuevo', { quien: 'SesionSecreta', nota: 'nota-secreta', carpeta: '/carpeta/secreta', cwd: '/cwd/secreto' })] });
  T.saveTopics(m.sdir, { 'titulo:viejo': 'Frenos y firmas' });
  const svc = localService();
  await T.classify(opts(m, svc));
  assert.strictEqual(svc.calls.length, 1);
  const { prompt } = svc.calls[0];
  assert.ok(prompt.includes('Título nuevo'));
  assert.ok(prompt.includes('Frenos y firmas'), 'lleva los temas usados');
  assert.ok(!prompt.includes('Título viejo'), 'lo guardado no se manda');
  for (const never of ['SesionSecreta', 'nota-secreta', '/carpeta/secreta', '/cwd/secreto', 'titulo:nuevo']) assert.ok(!prompt.includes(never), `no lleva ${never}`);
  assert.deepStrictEqual(Object.keys(svc.calls[0].body).sort(), ['messages', 'model', 'options', 'stream']);
  assert.strictEqual(svc.calls[0].body.messages.length, 1);
  assert.strictEqual(saved(m)['titulo:nuevo'], 'Oficina');
});

test('T2 Classify_SavesAndNeverAsksAgain @story-8.184 @ac-6 @ac-7 @ac-27: una sola llamada; sin títulos nuevos, ninguna', async () => {
  const m = toy({ pending: [work('Uno')] });
  const svc = localService();
  await T.classify(opts(m, svc));
  await T.classify(opts(m, svc, { nowMs: NOW + 10 * MIN }));
  assert.strictEqual(svc.calls.length, 1, 'lo guardado no se vuelve a preguntar');
  T.writePending(m.sdir, []);
  await T.classify(opts(m, svc, { nowMs: NOW + 20 * MIN }));
  assert.strictEqual(svc.calls.length, 1, 'sin títulos no hay llamada');
  assert.deepStrictEqual(T.readUsage(m.sdir).dias['2026-11-03'].llamadas, 1);
});

test('T3 WorkKey_StoryThenPrThenTitle @story-8.184 @ac-7: la misma clave y el mismo tema con otro título', async () => {
  assert.strictEqual(T.workKey({ historia: '8.184', titulo: 'Uno' }), T.workKey({ historia: '8.184', titulo: 'Otro' }));
  assert.strictEqual(T.workKey({ pedido: { repo: 'R', numero: 12 }, titulo: 'Uno' }), T.workKey({ pedido: { repo: 'r', numero: 12 }, titulo: 'Otro' }));
  assert.notStrictEqual(T.workKey({ historia: '8.184', pedido: { repo: 'r', numero: 12 } }), T.workKey({ pedido: { repo: 'r', numero: 12 } }), 'la historia va primero');
  assert.strictEqual(T.workKey({ titulo: '  La Lámpara, de pie! ' }), T.workKey({ titulo: 'la lampara de pie' }), 'el título, normalizado');
  const temas = { [T.workKey({ historia: '8.184' })]: 'Oficina' };
  assert.strictEqual(T.topicOf({ clave: T.workKey({ historia: '8.184', titulo: 'Otro título' }), titulo: 'Otro título' }, { temas }), 'Oficina');
});

test('T4 OtherProject_NotSent @story-8.184 @ac-9: va a «Otro proyecto», sin llamada', async () => {
  const card = { titulo: 'Mesa de otro proyecto', clave: 'titulo:mesa', otro: true };
  assert.strictEqual(T.topicOf(card, { temas: {} }), 'Otro proyecto');
  assert.deepStrictEqual(T.pendingWorks([card], {}), []);
  const m = toy();
  T.writePending(m.sdir, T.pendingWorks([card], {}));
  const svc = localService();
  await T.classify(opts(m, svc));
  assert.strictEqual(svc.calls.length, 0);
});

test('T5 PrivateName_NotSent @story-8.184 @ac-9: con la lista no se manda y va a «Otros»; sin lista, se manda', async () => {
  const m = toy({ pending: [work('Lo que pidió Fulano', 'titulo:a'), work('Lo de la oficina', 'titulo:b')] });
  const namesFile = path.join(m.dir, 'lista.json');
  fs.writeFileSync(namesFile, JSON.stringify({ terminos: [{ patron: 'fulano', categoria: 'persona' }, { patron: 'oficina', categoria: 'interno' }], patrones: [] }));
  const svc = localService();
  await T.classify(opts(m, svc, { namesFile }));
  assert.ok(!svc.calls[0].prompt.includes('Fulano'));
  assert.ok(svc.calls[0].prompt.includes('Lo de la oficina'), 'sólo cuenta la categoría de personas');
  assert.strictEqual(saved(m)['titulo:a'], 'Otros');
  const n = toy({ pending: [work('Lo que pidió Fulano', 'titulo:a')] });
  const svc2 = localService();
  await T.classify(opts(n, svc2, { namesFile: path.join(n.dir, 'no-existe.json') }));
  assert.ok(svc2.calls[0].prompt.includes('Fulano'), 'sin lista, la comprobación no aplica');
  // una lista que no se puede leer no deja pasar nada
  const b = toy({ pending: [work('Lo que pidió Fulano', 'titulo:a')] });
  const broken = path.join(b.dir, 'rota.json');
  fs.writeFileSync(broken, '{ rota');
  const svc3 = localService();
  const r = await T.classify(opts(b, svc3, { namesFile: broken }));
  assert.strictEqual(svc3.calls.length, 0);
  assert.match(r.fallo, /lista privada/);
});

const allowedToy = () => {
  const m = toy({ pending: [work('Uno')] });
  const doc = orgOf({ provider: 'ollama', level: 'economy' }, { economy: 'gemma-chico' });
  doc.models.allowed = { ollama: ['otro-modelo'] };
  fs.writeFileSync(m.orgConfig, JSON.stringify(doc));
  return m;
};

test('T6 Model_FromNightly_NoOtherProvider @story-8.184 @ac-12: sin configurar, fuera de la lista, sin llave y sin servicio no prueba otro', async () => {
  const cases = [
    ['sin configurar', toy({ nightly: null, pending: [work('Uno')] }), { models: [] }],
    ['sin modelo en la tabla', toy({ table: {}, pending: [work('Uno')] }), { models: ['otro-modelo-cloud'] }],
    ['fuera de la lista de permitidos', allowedToy(), {}],
    ['sin llave y sin ese modelo en el servicio', toy({ pending: [work('Uno')] }), { models: ['otro-modelo-cloud'] }],
  ];
  for (const [name, m, service] of cases) {
    const svc = localService(service);
    await T.classify(opts(m, svc));
    assert.strictEqual(svc.calls.length, 0, name);
    const st = T.readState(m.sdir).state;
    assert.strictEqual(st.sinModelo, true, name);
    assert.ok(st.motivo, `${name}: dice por qué`);
    assert.deepStrictEqual(saved(m), {}, name);
  }
  // sin servicio: la consulta falla, y es «sin modelo», no una falla del modelo
  const m = toy({ pending: [work('Uno')] });
  await T.classify(opts(m, { impl: async () => { throw new Error('ECONNREFUSED'); } }));
  assert.strictEqual(T.readState(m.sdir).state.sinModelo, true);
  // Anthropic sin su llave no cae en el servicio local
  const a = toy({ nightly: { provider: 'anthropic', level: 'economy' }, pending: [work('Uno')] });
  const svc = localService();
  await T.classify(opts(a, svc));
  assert.strictEqual(svc.calls.length, 0);
  assert.strictEqual(T.readState(a.sdir).state.sinModelo, true);
});

test('T7 Model_LocalService_WithoutKey @story-8.184 @ac-12: Ollama sin llave llama al servicio local con el sufijo de la nube', async () => {
  const m = toy({ pending: [work('Uno')] });
  const svc = localService();
  await T.classify(opts(m, svc));
  assert.strictEqual(svc.calls[0].url, 'http://localhost:11434/api/chat');
  assert.strictEqual(svc.calls[0].body.model, 'gemma-chico-cloud');
  // con su llave va por `llamar`, a la API directa y sin el sufijo
  const k = toy({ pending: [work('Uno')] });
  const direct = localService({ models: [] });
  const toyValue = 'de juguete';
  await T.classify(opts(k, direct, { env: { OLLAMA_API_KEY: toyValue } }));
  assert.strictEqual(direct.calls[0].url, 'https://ollama.com/api/chat');
  assert.strictEqual(direct.calls[0].body.model, 'gemma-chico');
});

test('T8 NoModel_FallsBackToPrTitles_NotSaved @story-8.184 @ac-13: tema por título o «Otros»; nada guardado; dice por qué', async () => {
  const prs = T.prScopes(['feat(office): la lámpara se prende con un click', 'fix(freno): el corchete del guardado', 'docs: sin alcance', 'fix(office): otra cosa']);
  assert.deepStrictEqual(prs.map((p) => p.tema), ['Office', 'Office', 'Freno']);
  const ctx = { temas: {}, sinModelo: true, prs };
  assert.strictEqual(T.topicOf({ titulo: 'La lámpara se prende con un click', clave: 'a' }, ctx), 'Office', 'por el título del pedido');
  assert.strictEqual(T.topicOf({ titulo: 'Otro arreglo del freno', clave: 'b' }, ctx), 'Freno', 'por la palabra del alcance');
  assert.strictEqual(T.topicOf({ titulo: 'Nada que ver con esto', clave: 'c' }, ctx), 'Otros');
  assert.strictEqual(T.topicOf({ titulo: 'Otro arreglo del freno', clave: 'b' }, { temas: {}, prs }), 'Otros', 'con modelo, lo no clasificado todavía no toma el respaldo');
  const m = toy({ nightly: null, pending: [work('Otro arreglo del freno')] });
  await T.classify(opts(m, localService()));
  assert.deepStrictEqual(saved(m), {}, 'el respaldo no se guarda');
  assert.strictEqual(T.tableNote(T.readState(m.sdir).state, NOW), 'Sin modelo: los temas salen de los títulos de los pedidos');
  // cuando hay modelo, se clasifica: pasó su plazo y el pendiente sigue
  fs.writeFileSync(m.orgConfig, JSON.stringify(orgOf({ provider: 'ollama', level: 'economy' }, { economy: 'gemma-chico' })));
  const svc = localService();
  await T.classify(opts(m, svc, { nowMs: NOW + 6 * MIN }));
  assert.strictEqual(svc.calls.length, 1);
  assert.strictEqual(T.readState(m.sdir).state.sinModelo, undefined);
});

test('T9 Usage_PerDay_AndReport @story-8.184 @ac-14: suma por día; sin tokens, cuenta títulos y dice que no se midió', async () => {
  const m = toy({ pending: [work('Uno'), work('Dos')] });
  const svc = localService();
  await T.classify(opts(m, svc));
  T.writePending(m.sdir, [work('Tres')]);
  await T.classify(opts(m, svc, { nowMs: NOW + MIN }));
  T.writePending(m.sdir, [work('Cuatro')]);
  await T.classify(opts(m, svc, { nowMs: NOW + 24 * 60 * MIN }));
  const u = T.readUsage(m.sdir).dias;
  assert.deepStrictEqual(u['2026-11-03'], { entrada: 200, salida: 40, llamadas: 2, titulos: 3, titulosSinMedir: 0 });
  assert.deepStrictEqual(u['2026-11-04'], { entrada: 100, salida: 20, llamadas: 1, titulos: 1, titulosSinMedir: 0 });
  assert.match(T.report(m.sdir, NOW), /2026-11-03: 240 tokens \(200 de entrada, 40 de salida\), 2 llamadas, 3 títulos/);
  const n = toy({ pending: [work('Uno'), work('Dos')] });
  await T.classify(opts(n, localService({ tokens: {} })));
  assert.deepStrictEqual(T.readUsage(n.sdir).dias['2026-11-03'], { entrada: 0, salida: 0, llamadas: 1, titulos: 2, titulosSinMedir: 2 });
  assert.match(T.report(n.sdir, NOW), /tokens no medidos.*2 títulos/);
  assert.match(T.report(toy().sdir, NOW), /Sin llamadas al modelo/);
});

test('T10 DailyCap_StopsAndSays @story-8.184 @ac-15: en el tope no llama, lo nuevo va a «Otros» y lo dice', async () => {
  const usage = (dia) => fs.writeFileSync(path.join(dia.sdir, 'office', 'topics-usage.json'), JSON.stringify({ version: 1, dias: { '2026-11-03': dia.u } }));
  const m = toy({ pending: [work('Uno')] });
  m.u = { entrada: 15000, salida: 5000, llamadas: 9, titulos: 100, titulosSinMedir: 0 };
  usage(m);
  const svc = localService();
  await T.classify(opts(m, svc));
  assert.strictEqual(svc.calls.length, 0);
  const st = T.readState(m.sdir).state;
  assert.strictEqual(T.tableNote(st, NOW), 'Llegó al tope de hoy: lo nuevo va a «Otros» hasta mañana');
  assert.strictEqual(T.topicOf({ titulo: 'Uno', clave: 'a' }, { temas: {}, prs: [] }), 'Otros');
  assert.strictEqual(T.tableNote(st, NOW + 24 * 60 * MIN), null, 'al otro día ya no');
  // otro día, sí llama
  await T.classify(opts(m, svc, { nowMs: NOW + 24 * 60 * MIN }));
  assert.strictEqual(svc.calls.length, 1);
  // la variable lo cambia
  const n = toy({ pending: [work('Uno')] });
  n.u = { entrada: 15000, salida: 5000, llamadas: 9, titulos: 100, titulosSinMedir: 0 };
  usage(n);
  const svc2 = localService();
  await T.classify(opts(n, svc2, { env: { TYCON_OFFICE_TOPICS_TOKENS: '30000' } }));
  assert.strictEqual(svc2.calls.length, 1);
  // sin tokens informados, el tope es en títulos
  const s = toy({ pending: [work('Uno')] });
  s.u = { entrada: 0, salida: 0, llamadas: 20, titulos: 600, titulosSinMedir: 600 };
  usage(s);
  const svc3 = localService({ tokens: {} });
  await T.classify(opts(s, svc3));
  assert.strictEqual(svc3.calls.length, 0);
  assert.strictEqual(T.tableNote(T.readState(s.sdir).state, NOW), 'Llegó al tope de hoy: lo nuevo va a «Otros» hasta mañana');
  await T.classify(opts(s, svc3, { nowMs: NOW + 5 * MIN, env: { TYCON_OFFICE_TOPICS_TITLES: '700' } }));
  assert.strictEqual(svc3.calls.length, 0, 'su plazo sigue hasta el otro día');
});

test('T11 ModelFails_NoSave_Backoff @story-8.184 @ac-21: error, 30 s y texto ilegible: nada guardado; a los 4 min no llama, a los 6 min sí', async () => {
  const faults = {
    error: async (url) => { if (String(url).endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'gemma-chico-cloud' }] }) }; return { ok: false, status: 500, text: async () => 'mal' }; },
    tiempo: async (url, init) => { if (String(url).endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'gemma-chico-cloud' }] }) }; return new Promise((_, reject) => { init.signal.addEventListener('abort', () => { const e = new Error('abort'); e.name = 'AbortError'; reject(e); }); }); },
    ilegible: localService({ answer: () => 'no sé qué decirte' }).impl,
  };
  for (const [name, impl] of Object.entries(faults)) {
    const m = toy({ pending: [work('Uno')] });
    const r = await T.classify(opts(m, { impl }, { timeoutMs: 30 }));
    assert.strictEqual(r.fallo != null, true, name);
    assert.deepStrictEqual(saved(m), {}, name);
    assert.strictEqual(T.readState(m.sdir).state.nextAt, NOW + 5 * MIN, name);
    const svc = localService();
    await T.classify(opts(m, svc, { nowMs: NOW + 4 * MIN }));
    assert.strictEqual(svc.calls.length, 0, `${name}: un proceso nuevo a los 4 min no llama`);
    await T.classify(opts(m, svc, { nowMs: NOW + 6 * MIN }));
    assert.strictEqual(svc.calls.length, 1, `${name}: a los 6 min, sí`);
  }
  assert.strictEqual(T.DEFAULT_TIMEOUT_MS, 30000);
});

test('T12 BadAnswer_SavesOnlyValid @story-8.184 @ac-22: menos temas o uno largo: sólo los válidos, y el JSON puede venir en un bloque de código', async () => {
  const m = toy({ pending: [work('Uno', 'a'), work('Dos', 'b'), work('Tres', 'c')] });
  await T.classify(opts(m, localService({ answer: () => ['Oficina', 'Un tema de muchas palabras de más'] })));
  assert.deepStrictEqual(saved(m), { a: 'Oficina' });
  assert.strictEqual(T.readState(m.sdir).state.nextAt, NOW + 5 * MIN, 'lo que quedó no se vuelve a preguntar enseguida');
  const n = toy({ pending: [work('Uno', 'a')] });
  await T.classify(opts(n, localService({ answer: () => '```json\n["Frenos y firmas"]\n```' })));
  assert.deepStrictEqual(saved(n), { a: 'Frenos y firmas' });
  // hasta 30 títulos por proceso
  const b = toy({ pending: Array.from({ length: 35 }, (_, i) => work(`Título ${i}`, `k${i}`)) });
  const svc = localService();
  await T.classify(opts(b, svc));
  assert.strictEqual(Object.keys(saved(b)).length, 30);
});

test('T13 BrokenFile_DoesNotThrow_KeepsCopy @story-8.184 @ac-23: lo dice, deja copia, no tira', async () => {
  const m = toy({ pending: [work('Uno', 'a')] });
  const file = path.join(m.sdir, 'office', 'topics.json');
  fs.writeFileSync(file, '{ roto');
  const r = T.readTopics(m.sdir);
  assert.deepStrictEqual(r.temas, {});
  assert.match(r.problem, /topics\.json/);
  await T.classify(opts(m, localService()));
  const copies = fs.readdirSync(path.join(m.sdir, 'office')).filter((f) => f.startsWith('topics.json.roto'));
  assert.strictEqual(copies.length, 1, 'no se reescribe sin dejar copia');
  assert.strictEqual(fs.readFileSync(path.join(m.sdir, 'office', copies[0]), 'utf8'), '{ roto');
  assert.strictEqual(saved(m).a, 'Oficina');
  // de otra versión, igual
  const n = toy();
  fs.writeFileSync(path.join(n.sdir, 'office', 'topics.json'), JSON.stringify({ version: 99, temas: { a: 'x' } }));
  assert.match(T.readTopics(n.sdir).problem, /versión/);
  assert.deepStrictEqual(T.readTopics(n.sdir).temas, {});
  // row-prs.json
  const rows = path.join(n.sdir, 'office', 'row-prs.json');
  fs.writeFileSync(rows, 'nada');
  const got = T.readRowPrs(n.sdir);
  assert.deepStrictEqual(got.filas, {});
  assert.match(got.problem, /row-prs\.json/);
  T.saveRowPrs(n.sdir, { fila: { repo: 'r', numero: 1 } });
  assert.strictEqual(fs.readdirSync(path.join(n.sdir, 'office')).filter((f) => f.startsWith('row-prs.json.roto')).length, 1);
  assert.deepStrictEqual(T.readRowPrs(n.sdir).filas, { fila: { repo: 'r', numero: 1 } });
});

test('T14 Lock_OneAtATime_AtomicWrite @story-8.184 @ac-24: no corre con un candado de 1 min; corre con uno de 3 min; sin restos', async () => {
  const m = toy({ pending: [work('Uno', 'a')] });
  const lock = path.join(m.sdir, 'office', 'topics.lock');
  const at = (ms) => { fs.writeFileSync(lock, ''); fs.utimesSync(lock, new Date(ms), new Date(ms)); };
  at(NOW - MIN);
  const svc = localService();
  const r = await T.classify(opts(m, svc));
  assert.strictEqual(r.ran, false);
  assert.strictEqual(svc.calls.length, 0);
  assert.ok(fs.existsSync(lock), 'el candado ajeno vigente queda');
  at(NOW - 3 * MIN);
  await T.classify(opts(m, svc));
  assert.strictEqual(svc.calls.length, 1);
  assert.ok(!fs.existsSync(lock), 'suelta el suyo');
  assert.deepStrictEqual(fs.readdirSync(path.join(m.sdir, 'office')).filter((f) => f.endsWith('.tmp')), [], 'escribe aparte y renombra');
  // dos a la vez: una sola llamada
  const n = toy({ pending: [work('Uno', 'a')] });
  const both = localService();
  await Promise.all([T.classify(opts(n, both)), T.classify(opts(n, both))]);
  assert.strictEqual(both.calls.length, 1);
});

// Las tablas se arman en office.js: de acá para abajo se prueban con él, con resultados de /wip de juguete.
const OFFICE = path.join(__dirname, '..', 'tools', 'office.js');
const { buildOffice, buildBoard, buildTables, page, askWaitingPrs, rowPrsNow, applyRowPrs, settleRowPrs, workCards } = require(OFFICE);
const SUNDAY = Date.parse('2026-10-18T14:00:00.000Z');
function wip(entries, more = {}) {
  return {
    rows: entries.map((e) => ({ work: e.work || `Story ${e.session}`, state: 'en curso', end: '15:00', session: e.session, folder: 'repo-a' })),
    details: entries.map((e) => ({ sid: e.sid || `sid-${e.session}`, status: 'status' in e ? e.status : 'busy', statusAt: null })),
    extra: entries.map((e) => e.extra || { kind: 'loose' }),
    free: [],
    halfway: [],
    unreadable: [],
    ...more,
  };
}
const byName = (data, name) => data.agents.find((a) => a.nombre === name);
function originRepo(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-topics-repo-'));
  execFileSync('git', ['-c', 'maintenance.auto=false', '-C', dir, 'init', '-q'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url], { stdio: 'ignore' });
  return dir;
}
const waitingWip = (cwd, waitingFor, waitingSince = 1000) => wip([{ session: 'Paz', sid: 'p', extra: { kind: 'note', text: 'x', cwd, waitingFor, waitingSince } }]);
const readerOf = (answers, asked = []) => async (qs) => qs.map((q) => { asked.push(q); return answers[q.numero] ? { pr: answers[q.numero] } : { error: 'no se pudo' }; });
const NO_OPEN = { measured: true, prs: [] };

// ── Las tablas por tema ──────────────────────────────────────────────────────────────────────────────────────────────

// SUNDAY es domingo 18/10: las horas de los pendientes se dicen por su día.
const dayAt = (daysFromNow, h, m = 0) => { const d = new Date(SUNDAY); d.setDate(d.getDate() + daysFromNow); d.setHours(h, m, 0, 0); return d.getTime(); };
const kanbanOf = (cols, more = {}) => ({ columnas: ['sinEmpezar', 'curso', 'firma', 'entrando', 'hechos'].map((id) => ({ id, tarjetas: cols[id] || [] })), medioCamino: more.medioCamino || [], anteriores: more.anteriores || [] });
const card = (titulo, tema, more = {}) => ({ titulo, quien: 'Paz', hora: 'sin hora estimada', clave: `titulo:${titulo}`, ...(tema ? { tema } : {}), ...more });
const hours = (n, at) => Array.from({ length: n }, (_, i) => card(`Curso ${i}`, 'Frenos', { finMs: at + i * 60000 }));
const rowOfTopic = (table, grupo) => table.filas.find((f) => f.grupo === grupo);

test('T15 Tables_GroupByTopic_SameCardsAsKanban @story-8.184 @ac-1 @ac-25: toda tarjeta en una fila; el kanban sigue igual', () => {
  const k = kanbanOf({
    curso: [card('Uno', 'Frenos'), card('Dos', 'Oficina'), card('Tres', 'Frenos')],
    firma: [card('Cuatro', 'Frenos')],
    entrando: [card('Cinco', 'Oficina')],
    hechos: [card('Seis', 'Oficina')],
    sinEmpezar: [card('Siete', 'Producto')],
  }, { medioCamino: [{ titulo: 'Ocho', accion: 'x' }] });
  const t = buildTables({ kanban: k, nowMs: SUNDAY });
  const hoy = t.hoy.filas.flatMap((f) => f.trabajos.map((w) => w.titulo)).sort();
  assert.deepStrictEqual(hoy, ['Cinco', 'Cuatro', 'Dos', 'Seis', 'Tres', 'Uno']);
  const pend = t.pendientes.filas.flatMap((f) => f.trabajos.map((w) => w.titulo)).sort();
  assert.deepStrictEqual(pend, ['Ocho', 'Siete']);
  assert.deepStrictEqual(t.hoy.columnas, ['Tema', 'Qué tendremos', 'Cómo va']);
  assert.deepStrictEqual(t.pendientes.columnas, ['Tema', 'Qué queda', 'Cuándo']);
  // por cantidad de trabajos, y «Otro proyecto» y «Otros» al final
  const order = buildTables({ kanban: kanbanOf({ curso: [card('A', 'Otros'), card('B', 'Otros'), card('C', 'Otros'), card('D', null, { otro: true }), card('E', 'Uno'), card('F', 'Dos'), card('G', 'Dos')] }), nowMs: SUNDAY });
  assert.deepStrictEqual(order.hoy.filas.map((f) => f.grupo), ['Dos', 'Uno', 'Otro proyecto', 'Otros']);
  // lo que usa la tabla no se ve en la tarjeta: una tarjeta de verdad no gana campos, y la foto no lleva la clave
  const { data } = buildOffice({ wip: wip([{ session: 'Paz', extra: { kind: 'pipeline', current: 'implement', storyId: '8.5', title: 'La historia' } }]), nowMs: SUNDAY });
  const real = data.kanban.columnas.find((c) => c.id === 'curso').tarjetas[0];
  assert.deepStrictEqual(Object.keys(real).sort(), ['hora', 'quien', 'titulo']);
  assert.strictEqual(real.clave, 'historia:8.5');
  assert.doesNotMatch(JSON.stringify(data.kanban), /historia:8\.5/);
  assert.deepStrictEqual(data.kanban.columnas.map((c) => c.id), ['sinEmpezar', 'curso', 'firma', 'entrando', 'hechos']);
});

test('T16 Tables_StatusLineInWords @story-8.184 @ac-2: la línea sale contada de las tarjetas', () => {
  const k = kanbanOf({
    curso: hours(5, dayAt(0, 23, 30)),
    entrando: [card('E1', 'Frenos'), card('E2', 'Frenos')],
    hechos: Array.from({ length: 6 }, (_, i) => card(`H${i}`, 'Frenos')),
  });
  assert.strictEqual(rowOfTopic(buildTables({ kanban: k, nowMs: SUNDAY }).hoy, 'Frenos').col, '5 en curso, el próximo termina a las 23:30 · 2 esperan entrar · 6 terminados hoy');
  const one = kanbanOf({ curso: [card('C', 'A', { finMs: dayAt(2, 18) })], firma: [card('F', 'A')], entrando: [card('E', 'A')], hechos: [card('H', 'A')] });
  assert.strictEqual(rowOfTopic(buildTables({ kanban: one, nowMs: SUNDAY }).hoy, 'A').col, '1 en curso, el próximo termina el martes 18:00 · 1 espera tu firma · 1 espera entrar · 1 terminado hoy');
  const late = kanbanOf({ curso: [card('C1', 'A', { finMs: SUNDAY - 60000 }), card('C2', 'A', { finMs: SUNDAY - 120000 }), card('C3', 'A')], firma: [card('F1', 'A'), card('F2', 'A')] });
  assert.strictEqual(rowOfTopic(buildTables({ kanban: late, nowMs: SUNDAY }).hoy, 'A').col, '3 en curso, 2 pasaron su hora · 2 esperan tu firma');
});

test('T17 Pending_SaysLateAndNext @story-8.184 @ac-2: cuántas pasaron su hora y cuál es la próxima', () => {
  const line = (cards, more) => rowOfTopic(buildTables({ kanban: kanbanOf({ sinEmpezar: cards }, more), nowMs: SUNDAY }).pendientes, 'P').col;
  const P = (t, finMs) => card(t, 'P', { ...(finMs ? { finMs } : {}) });
  assert.strictEqual(line([P('a', dayAt(-2, 9)), P('b', dayAt(-1, 9)), P('c', dayAt(2, 18))]), '2 pasaron su hora, desde el viernes · la próxima, martes 18:00');
  assert.strictEqual(line([P('a', dayAt(-1, 9)), P('c', dayAt(6, 18))]), '1 pasó su hora, el sábado · la próxima, sábado 18:00');
  assert.strictEqual(line([P('c', dayAt(6, 18)), P('d'), P('e')]), 'La próxima, sábado 18:00 · 2 sin hora');
  assert.strictEqual(line([P('d')]), '1 sin hora');
  assert.strictEqual(line([P('c', SUNDAY + 3600000)]), `La próxima, hoy ${new Date(SUNDAY + 3600000).toTimeString().slice(0, 5)}`);
  const halfway = buildTables({ kanban: kanbanOf({}, { medioCamino: [{ titulo: 'Quedó', accion: 'x' }] }), nowMs: SUNDAY }).pendientes;
  assert.strictEqual(halfway.filas[0].col, '1 a medio camino');
});

test('T18 Tables_NamesTwoAndCounts @story-8.184 @ac-2: nombra hasta dos y «y N más»', () => {
  const names = (n) => rowOfTopic(buildTables({ kanban: kanbanOf({ curso: Array.from({ length: n }, (_, i) => card(`T${i}`, 'A')) }), nowMs: SUNDAY }).hoy, 'A').que;
  assert.strictEqual(names(5), 'T0; T1; y 3 más');
  assert.strictEqual(names(2), 'T0; T1');
  assert.strictEqual(names(1), 'T0');
});

test('T19 Tables_ChangeWithReality_NoOldText @story-8.184 @ac-4: cambia con la foto; «Armada a las», nunca «vieja»', () => {
  const before = buildTables({ kanban: kanbanOf({ entrando: [card('E', 'A')] }), nowMs: SUNDAY });
  const after = buildTables({ kanban: kanbanOf({ hechos: [card('E', 'A')] }), nowMs: SUNDAY });
  assert.strictEqual(rowOfTopic(before.hoy, 'A').col, '1 espera entrar');
  assert.strictEqual(rowOfTopic(after.hoy, 'A').col, '1 terminado hoy');
  for (const t of [before.hoy, before.pendientes]) {
    assert.match(t.escrito, /^Armada a las \d\d:\d\d/);
    assert.doesNotMatch(`${t.escrito} ${t.cruce}`, /vieja|Escrita|por el arnés/);
  }
  assert.match(before.hoy.cruce, /Agrupa por tema/);
  assert.match(before.hoy.cruce, /1 esperan entrar/);
  assert.strictEqual(before.hoy.contar, undefined);
  // la nota del modelo, una sola vez
  const said = buildTables({ kanban: kanbanOf({}), nowMs: SUNDAY, nota: 'Sin modelo: los temas salen de los títulos de los pedidos' });
  assert.strictEqual(`${said.hoy.escrito}${said.pendientes.escrito}`.match(/Sin modelo/g).length, 1);
});

test('T20 WrittenTables_Ignored_CommandRetired @story-8.184 @ac-5: se ignoran sin error; --write-tables contesta y sale distinto de cero', () => {
  const b = buildBoard({ tablas: { hoy: 'mal', pendientes: [{ grupo: 'G', que: 'Escrita', cuando: 'x' }] }, pendientes: [] });
  assert.deepStrictEqual(b.avisos, []);
  assert.strictEqual(b.tablas, undefined);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-sin-tablas-'));
  let res;
  try { res = { status: 0, out: execFileSync('node', [OFFICE, '--write-tables', 'x.json'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { res = { status: e.status, out: `${e.stdout}${e.stderr}` }; }
  assert.notStrictEqual(res.status, 0);
  assert.match(res.out, /las tablas se arman solas/);
});

test('T21 RowTopic_WinsAndCannotWriteState @story-8.184 @ac-8: gana el tema de la fila; la línea sale de lo real', () => {
  const board = buildBoard({ pendientes: [{ titulo: 'Fila del tablero', estado: 'espera', tema: 'Mi tema', col: 'todo perfecto', cuando: 'todo perfecto', hoy: 'todo perfecto', linea: 'todo perfecto', pronosticoIso: '2026-10-20T18:00' }] });
  const { data } = buildOffice({ wip: wip([]), board, nowMs: SUNDAY });
  const t = buildTables({ kanban: data.kanban, nowMs: SUNDAY, temas: { 'titulo:fila del tablero': 'Lo guardado' } });
  const row = rowOfTopic(t.pendientes, 'Mi tema');
  assert.ok(row, 'gana el tema de la fila');
  assert.strictEqual(row.col, 'La próxima, martes 18:00');
  assert.doesNotMatch(JSON.stringify(t), /todo perfecto/);
  // y no queda pendiente de clasificar
  assert.deepStrictEqual(T.pendingWorks(data.kanban.columnas.flatMap((c) => c.tarjetas), {}), []);
});

test('Tables_ConversationNeverClassified @story-8.184 @ac-10: la tarjeta sin título anotado muestra su conversación, y eso no se manda', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Sin', sid: 's', extra: { kind: 'activity' } }, { session: 'Con', sid: 'c', extra: { kind: 'note', text: 'Un trabajo anotado' } }]),
    sessionFiles: [{ session: 's', tool: 'claude', pid: 10 }],
    transcripts: new Map([['s', { haciendoAhora: 'Una frase de su conversación', lastWriteMs: SUNDAY }]]),
    nowMs: SUNDAY,
  });
  assert.ok(JSON.stringify(data.kanban).includes('Una frase de su conversación'), 'la tarjeta la muestra');
  assert.deepStrictEqual(T.pendingWorks(workCards(data.kanban), {}).map((w) => w.titulo), ['Un trabajo anotado']);
  // de lo que quedó a medio camino se manda el trabajo que era, nunca su título, que nombra una carpeta
  const halfway = { columnas: [], medioCamino: [Object.defineProperty({ titulo: 'carpeta-secreta: 2 archivos sin guardar', accion: 'x' }, 'trabajo', { value: 'El trabajo que era' })] };
  assert.deepStrictEqual(T.pendingWorks(workCards(halfway), {}).map((w) => w.titulo), ['El trabajo que era']);
  const saved = { [T.pendingWorks(workCards(halfway), {})[0].clave]: 'Oficina' };
  assert.ok(rowOfTopic(buildTables({ kanban: { ...halfway, columnas: [] }, nowMs: SUNDAY, temas: saved }).pendientes, 'Oficina'), 'y queda en el tema de ese trabajo');
  assert.strictEqual(T.topicOf({ titulo: 'x', clave: 'k', sinTitulo: true }, { temas: {} }), 'Otros');
});

test('T22 Wait_FallsWhenItsPrEntered @story-8.184 @ac-16: se cae si entró después de anotarla, nombrado o por su rama; la que entró antes, no', async () => {
  const dir = originRepo('https://github.com/acme/repo.git');
  const mergedAt = '2026-11-02T20:00:00Z';
  const at = Date.parse(mergedAt);
  const answers = { 913: { state: 'merged', mergedAt } };
  const ask = (w, since, more = {}) => askWaitingPrs(waitingWip(dir, w, since), NO_OPEN, { queryPrs: readerOf(answers), ...more }, new Map());
  assert.strictEqual((await ask('la cola de #913', at - 1000)).get('p').all, true, 'entró después de anotarla');
  assert.strictEqual((await ask('la cola de #913', at + 1000)).size, 0, 'entró antes de anotarla: esa espera es de otra cosa');
  const sessionPrs = { p: { repo: 'repo', numero: 913, identity: { platform: 'github', org: 'acme', repo: 'repo' } } };
  assert.strictEqual((await ask('el turno de la suite', at - 1000, { sessionPrs })).get('p').all, true, 'por su rama');
  assert.strictEqual((await ask('el turno de la suite', at + 1000, { sessionPrs })).size, 0);
  assert.strictEqual((await ask('el turno de la suite', at - 1000)).size, 0, 'sin pedido en su rama, sigue');
  // abierto en la lectura: no pregunta, y sigue esperando
  const asked = [];
  const open = { measured: true, prs: [{ number: 913, mark: '#', repoName: 'repo' }] };
  assert.strictEqual((await askWaitingPrs(waitingWip(dir, 'el turno', at - 1000), open, { queryPrs: readerOf(answers, asked), sessionPrs }, new Map())).size, 0);
  assert.strictEqual(asked.length, 0);
  // la tarjeta no la dice ni la marca «Esperando»
  const { data } = buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', extra: { kind: 'note', text: 'x', waitingFor: 'el turno', waitingSince: at - 1000 } }]), waitingPrs: new Map([['p', { text: 'El 913 ya entró', all: true }]]), nowMs: at + 60000 });
  assert.notStrictEqual(byName(data, 'Paz').estado, 'esperando');
  assert.doesNotMatch(JSON.stringify(byName(data, 'Paz').fin), /el turno/);
});

test('T23 Wait_FallsWhenSessionWorked @story-8.184 @ac-17: trabajó más de 5 min después: se cae; quieta: sigue, y dice desde cuándo', () => {
  const since = SUNDAY - 20 * 60000;
  const run = (status, extra, lastWrite) => {
    const { data } = buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', status, extra: { kind: 'note', text: 'Su trabajo', waitingFor: 'que entre el #907', waitingSince: since, ...extra } }]), lastWrites: new Map(lastWrite ? [['p', lastWrite]] : []), nowMs: SUNDAY });
    return byName(data, 'Paz');
  };
  assert.notStrictEqual(run('busy', { activityAt: since + 6 * 60000 }).estado, 'esperando', 'tocó archivos 6 min después');
  assert.notStrictEqual(run('busy', {}, since + 6 * 60000).estado, 'esperando', 'ocupada, y su conversación siguió');
  assert.doesNotMatch(JSON.stringify(run('busy', {}, since + 6 * 60000).fin), /#907/);
  assert.strictEqual(run('busy', { activityAt: since + 4 * 60000 }).estado, 'esperando', 'a los 4 min, todavía no');
  const quiet = run('idle', {}, since + 6 * 60000);
  assert.strictEqual(quiet.estado, 'esperando', 'quieta: recibir un mensaje no es trabajar');
  assert.match(quiet.fin.dif, /^desde las /);
  assert.match(quiet.fin.hora, /#907/);
});

test('T24 RowPr_RememberedAndMoves @story-8.184 @ac-18: recuerda el pedido de la única fila; al entrar, «Terminados»; cerrado, se olvida', () => {
  const pendientes = [{ titulo: 'Tope', estado: 'curso', quien: 'Paz' }, { titulo: 'Otra', estado: 'curso', quien: 'Ana' }, { titulo: 'Otra más', estado: 'curso', quien: 'Ana' }, { titulo: 'Hecha', estado: 'hecho', quien: 'Beto' }];
  const boardNow = () => buildBoard({ pendientes });
  const sessions = [{ nombre: 'Paz', sid: 'p', repo: 'repo-a', identity: { platform: 'github', org: 'acme', repo: 'repo-a' }, branch: 'story/tope' }, { nombre: 'Ana', sid: 'a', repo: 'repo-a', identity: {}, branch: 'fix/ana' }, { nombre: 'Beto', sid: 'b', repo: 'repo-a', identity: {}, branch: 'fix/beto' }, { nombre: 'Enzo', sid: 'e', repo: 'repo-a', identity: {}, branch: 'main' }];
  const openPrs = [{ repoName: 'repo-a', number: 901, branch: 'story/tope' }, { repoName: 'repo-a', number: 902, branch: 'fix/ana' }, { repoName: 'repo-a', number: 903, branch: 'fix/beto' }];
  const mem = rowPrsNow({ filas: boardNow().filas, memory: { filas: {}, sesiones: {} }, openPrs, sessions });
  assert.deepStrictEqual(Object.keys(mem.filas), ['titulo:tope'], 'sólo la única fila abierta que nombra a su sesión');
  assert.strictEqual(mem.filas['titulo:tope'].numero, 901);
  assert.strictEqual(mem.sesiones.p.numero, 901, 'la rama de cada sesión, para sus esperas');
  // la sesión sigue viva y su pedido abierto: la fila no se duplica ni se mueve
  const alive = boardNow();
  applyRowPrs(alive, mem);
  const live = buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', extra: { kind: 'note', text: 'Tope' } }]), board: alive, nowMs: SUNDAY }).data.kanban;
  assert.deepStrictEqual(live.columnas.find((c) => c.id === 'curso').tarjetas.map((x) => x.quien), ['Paz'], 'no se duplica');
  // se cerró la sesión y entró el pedido
  const later = rowPrsNow({ filas: boardNow().filas, memory: mem, openPrs: [], sessions: [] });
  assert.strictEqual(later.filas['titulo:tope'].numero, 901, 'lo sigue recordando sin la sesión');
  const merged = boardNow();
  applyRowPrs(merged, later);
  const mergedAt = new Date(SUNDAY - 3600000).toISOString();
  const answers = new Map([['repo-a#901', { pr: { state: 'merged', mergedAt } }]]);
  const settled = settleRowPrs(merged, answers, later);
  assert.strictEqual(settled.filas['titulo:tope'].mergedAt, mergedAt);
  const k = buildOffice({ wip: wip([]), board: merged, prAnswers: answers, nowMs: SUNDAY }).data.kanban;
  const done = k.columnas.find((c) => c.id === 'hechos').tarjetas.find((c) => c.titulo === 'Tope');
  assert.ok(done, 'pasa a «Terminados»');
  assert.match(done.hora, /\d\d:\d\d$/, 'con la hora en que entró');
  // ya entró: la fila se resuelve sin preguntar otra vez
  const again = boardNow();
  applyRowPrs(again, settled);
  assert.strictEqual(again.filas.find((f) => f.titulo === 'Tope').recordado.mergedAt, mergedAt);
  // cerrado sin entrar: se olvida, y queda donde dice su estado
  const closedBoard = boardNow();
  applyRowPrs(closedBoard, later);
  const closedAnswers = new Map([['repo-a#901', { pr: { state: 'closed', mergedAt: null } }]]);
  const forgot = settleRowPrs(closedBoard, closedAnswers, later);
  assert.strictEqual(forgot.filas['titulo:tope'], undefined);
  assert.strictEqual(closedBoard.filas.find((f) => f.titulo === 'Tope').recordado, undefined);
  const k2 = buildOffice({ wip: wip([]), board: closedBoard, prAnswers: closedAnswers, nowMs: SUNDAY }).data.kanban;
  const row = k2.columnas.find((c) => c.id === 'sinEmpezar').tarjetas.find((c) => c.titulo === 'Tope');
  assert.ok(row);
  assert.strictEqual(row.motivo, undefined, 'como si nunca lo hubiera recordado');
  // la rama principal no es un pedido de nadie, y lo que ya no está en el tablero se olvida
  assert.strictEqual(mem.sesiones.e, undefined);
  assert.deepStrictEqual(rowPrsNow({ filas: [], memory: mem, openPrs: [], sessions: [] }).filas, {});
});

test('T25 NoCoordinator_TablesStillThere @story-8.184 @ac-19: sin tablero, las dos tablas por tema, con los pedidos y su línea', () => {
  const { data } = buildOffice({ wip: wip([]), openPrs: [{ waiting: true, repoName: 'r', number: 77, mark: '#', title: 'Un pedido', inQueue: true }], nowMs: SUNDAY });
  const t = buildTables({ kanban: data.kanban, nowMs: SUNDAY, temas: { 'pedido:r#77': 'Oficina' } });
  assert.strictEqual(rowOfTopic(t.hoy, 'Oficina').col, '1 espera entrar');
  assert.deepStrictEqual(t.pendientes.filas, []);
  assert.strictEqual(t.pendientes.vacio, 'No hay pendientes');
  assert.ok(t.hechos);
  assert.strictEqual(t.hechos.escrito, 'Lo terminado antes de hoy');
});

test('T26 Unmatched_OnlyPrints @story-8.184 @ac-20: imprime las filas sin tarjeta; el archivo no cambia', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-unmatched-'));
  const { stateDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
  const sdir = stateDir(home);
  fs.mkdirSync(path.join(sdir, 'coordination'), { recursive: true });
  const file = path.join(sdir, 'coordination', 'tablero.json');
  const text = JSON.stringify({ pendientes: [{ titulo: 'Fila con su tarjeta acá', estado: 'espera' }], tablas: { hoy: [{ grupo: 'G', que: 'Fila con su tarjeta acá', hoy: 'x' }], pendientes: [{ grupo: 'H', que: 'Algo que no tiene tarjeta', cuando: 'y' }] } });
  fs.writeFileSync(file, text);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_OFFICE_LINK: '0' };
  const out = execFileSync('node', [TOPICS, '--unmatched'], { env, encoding: 'utf8' });
  assert.match(out, /pendientes · H · Algo que no tiene tarjeta/);
  assert.doesNotMatch(out, /Fila con su tarjeta/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
});

test('T27 Page_FoldsAndKeepsOpen @story-8.184 @ac-3: la fila se abre y sigue abierta al redibujar', () => {
  const html = page(buildOffice({ wip: wip([]), nowMs: SUNDAY }).data);
  const code = (html.match(/const temasAbiertos=[\s\S]*?(?=\nfunction renderCrew\()/) || [])[0];
  assert.ok(code, 'la página trae las filas que se abren');
  assert.ok(!/innerHTML/.test(code), 'como texto');
  // un DOM mínimo: lo justo para dibujar la tabla, tocar una fila y buscar lo dibujado
  const node = (tag) => ({ tag, children: [], attrs: {}, dataset: {}, handlers: {}, hidden: false, textContent: '', className: '',
    appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; }, setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(t, f) { this.handlers[t] = f; }, focus() {} });
  const walk = (n, out = []) => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
  const section = node('div');
  const document = { createElement: node, getElementById: () => section };
  const el = (t, c, txt) => { const e = node(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
  const DATA = { tablas: {
    hoy: { titulo: 'Hoy', columnas: ['Tema', 'Qué tendremos', 'Cómo va'], escrito: 'Armada a las 10:00', filas: [{ grupo: 'Oficina', que: 'A; B', col: '2 en curso', trabajos: [{ titulo: 'A', quien: 'Paz', como: 'En curso' }, { titulo: 'B', quien: 'Ana', como: 'En curso' }] }] },
    pendientes: { titulo: 'Pendientes', columnas: ['Tema', 'Qué queda', 'Cuándo'], escrito: 'Armada a las 10:00', filas: [], vacio: 'No hay pendientes' },
    hechos: { titulo: 'Hechos', columnas: ['Qué', 'Quién', 'Cuándo'], escrito: 'x', filas: [{ grupo: 'Viejo', que: 'Paz', col: 'lun 09:00' }] },
  } };
  const api = new Function('document', 'el', 'DATA', `${code};return { renderTablas };`)(document, el, DATA);
  api.renderTablas();
  const find = () => walk(section);
  const button = () => find().find((n) => n.className === 'temaBoton');
  const detail = () => find().find((n) => n.className === 'temaTrabajos');
  assert.strictEqual(button().textContent, 'Oficina');
  assert.strictEqual(button().attrs['aria-expanded'], 'false');
  assert.strictEqual(detail().hidden, true, 'de entrada, cerrada');
  assert.ok(find().some((n) => n.textContent === 'No hay pendientes'));
  // se toca la fila: el botón es lo que recibe el teclado, y el click sube hasta la fila
  find().find((n) => n.className === 'temaFila').handlers.click();
  assert.strictEqual(detail().hidden, false);
  assert.strictEqual(button().attrs['aria-expanded'], 'true');
  const shown = walk(detail()).map((n) => n.textContent).join(' ');
  for (const said of ['A', 'Paz', 'En curso', 'B', 'Ana']) assert.ok(shown.includes(said), said);
  // llega una foto nueva: sigue abierta
  api.renderTablas();
  assert.strictEqual(detail().hidden, false, 'sigue abierta con la foto nueva');
  find().find((n) => n.className === 'temaFila').handlers.click();
  assert.strictEqual(detail().hidden, true);
  // «Hechos» no se abre: no tiene trabajos
  assert.strictEqual(find().filter((n) => n.className === 'temaFila').length, 1);
});

// ── Lo que encontró el pase adversarial ─────────────────────────────────────────────────────────────────────────────

const { pick } = require(path.join(__dirname, '..', 'tools', 'office', 'fields.js'));
const { collect, createEnvelopes } = require(OFFICE);
const { stateDir: stateDirOf, claudeDir } = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'state-dir.js'));
const { buildWip } = require(path.join(__dirname, '..', 'tools', 'work-in-progress.js'));
const tablesOf = (data, more = {}) => buildTables({ kanban: data.kanban, nowMs: SUNDAY, ...more });
const sentOf = (tablas) => JSON.stringify(pick({ tablas }, os.homedir()).tablas);
const pendingOf = (data) => T.pendingWorks(workCards(data.kanban), {}).map((w) => w.titulo);
const columnOf = (data, id) => data.kanban.columnas.find((c) => c.id === id).tarjetas;
function machine(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pase-'));
  const sdir = stateDirOf(home);
  for (const d of ['active', 'adhoc', 'doing', 'office', 'coordination']) fs.mkdirSync(path.join(sdir, d), { recursive: true });
  fs.mkdirSync(path.join(claudeDir(home), 'sessions'), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(sdir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return { home, sdir };
}
const photoOf = (m, repos, atMs) => fs.writeFileSync(path.join(m.sdir, 'stuck-prs-photo.json'), JSON.stringify({ at: new Date(atMs).toISOString(), lecturas: Object.fromEntries(repos.map((r) => [r, { ok: true, value: [] }])) }));
const liveOf = (m, opts = {}) => collect({ home: m.home, now: new Date().toISOString(), envelopes: createEnvelopes(), noTranscripts: true, siteUrl: async () => ({ code: 3, out: '' }), quietMinutes: async () => ({ code: 3, out: '' }), ...opts });
const pendingFile = (m) => T.readPending(m.sdir).map((w) => w.titulo);

test('Regresion_OtroProyecto_LoQueNoEsUnaSesionViva @story-8.184 @ac-9 @ac-26: ni la ejecución cerrada ni lo que quedó de una sesión cerrada van al modelo o al sitio', () => {
  const closed = buildOffice({
    wip: wip([{ session: 'Mesa', sid: 'm', extra: { kind: 'entering', storyId: '9.1', title: 'SECRETO corrida', runFolder: '~/ajeno', closedAt: SUNDAY - 3600000, meanwhile: 'otra cosa', meanwhileKind: 'note', meanwhileAt: SUNDAY - 60000 } }]),
    otherProjects: new Set(['m']),
    nowMs: SUNDAY,
  }).data;
  assert.strictEqual(columnOf(closed, 'entrando').find((c) => /SECRETO/.test(c.titulo)).otro, true);
  assert.ok(!pendingOf(closed).some((t) => /SECRETO/.test(t)));
  assert.ok(!/SECRETO/.test(sentOf(tablesOf(closed))));
  const left = [{ folder: '/x/ajeno', branch: 'b', changes: 2, ahead: 0 }];
  const halfway = buildOffice({
    wip: wip([], { halfwayItems: [{ kind: 'run', sid: 'c1', storyId: '9.8', text: 'SECRETO a medio camino', left }, { kind: 'run', sid: 'c2', storyId: '9.9', text: 'SECRETO en firma', awaits: 'plan', left }, { kind: 'run', sid: 'c3', storyId: '9.7', text: 'SECRETO marcada', mark: 'riesgo', left: [] }] }),
    otherProjects: new Set(['c3']),
    projectOf: (f) => (f === '/x/ajeno' ? 'otro' : 'nuestro'),
    nowMs: SUNDAY,
  }).data;
  assert.deepStrictEqual(pendingOf(halfway), []);
  assert.ok(!/SECRETO/.test(sentOf(tablesOf(halfway))));
  assert.ok(/SECRETO/.test(JSON.stringify(tablesOf(halfway))), 'en la máquina se sigue viendo');
});

test('Regresion_OtroProyecto_NoSeSabe @story-8.184 @ac-9 @ac-26: lo que no se sabe de qué proyecto es no se manda; en una fila mezclada se tapa sólo eso', () => {
  const { data } = buildOffice({
    wip: wip([{ session: 'Paz', sid: 'p', extra: { kind: 'note', text: 'SECRETO sin saber', cwd: '/x/nada' } }, { session: 'Ana', sid: 'a', extra: { kind: 'note', text: 'Lo nuestro de hoy', cwd: '/x/repo' } }]),
    projectOf: (f) => (f === '/x/repo' ? 'nuestro' : 'nose'),
    nowMs: SUNDAY,
  });
  assert.deepStrictEqual(pendingOf(data), ['Lo nuestro de hoy']);
  const sent = pick({ tablas: tablesOf(data) }, os.homedir()).tablas.hoy.filas[0];
  assert.strictEqual(sent.grupo, 'Otros');
  assert.strictEqual(sent.que, 'Otro proyecto', 'la frase de la fila junta títulos');
  assert.deepStrictEqual(sent.trabajos.map((w) => w.titulo).sort(), ['Lo nuestro de hoy', 'Otro proyecto']);
  assert.strictEqual(tablesOf(data).hoy.filas[0].trabajos.length, 2);
  // la firma sigue el proyecto de su sesión, y la de ninguna no se sabe
  const signed = buildOffice({ wip: wip([]), signatures: [{ title: 'SECRETO firma', at: SUNDAY }], projectOf: () => 'nose', nowMs: SUNDAY }).data;
  assert.ok(!pendingOf(signed).some((t) => /SECRETO/.test(t)));
  // el tema de la fila no le saca la marca a una tarjeta de otro proyecto: es la que tapa su título
  assert.strictEqual(T.topicOf({ otro: true, tema: 'Tema de la fila', clave: 'k' }, {}), T.OTHER_PROJECT);
});

test('Regresion_OtroProyecto_PorLaFotoReal @story-8.184 @ac-9 @ac-26: pedido propio de un repo que no se sigue; foto vieja; sin foto; carpeta sin remoto', async () => {
  const m = machine();
  photoOf(m, ['acme/repo'], Date.now() - 60000);
  fs.writeFileSync(path.join(m.sdir, 'own-prs.json'), JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), lecturas: { 'cliente/ajeno': { ok: true, value: [{ number: 77, title: 'fix: SECRETO del pedido', sourceBranch: 'x', inQueue: true }] } } }));
  const d = await liveOf(m);
  assert.deepStrictEqual(pendingFile(m), []);
  assert.ok(!/SECRETO/.test(sentOf(d.tablas)));
  assert.ok(/SECRETO/.test(JSON.stringify(d.tablas)));
  // una sesión viva en un repo ajeno, con una foto vieja: qué repos se siguen no cambia en 15 minutos
  const session = (n, cwd) => {
    fs.writeFileSync(path.join(claudeDir(n.home), 'sessions', 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Paz', status: 'busy', statusUpdatedAt: Date.now(), cwd }));
    fs.writeFileSync(path.join(n.sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'SECRETO de la sesión', declaredAt: new Date().toISOString(), cwd }));
  };
  const old = machine();
  photoOf(old, ['acme/repo'], Date.now() - 3600000);
  session(old, originRepo('https://github.com/otra/ajeno.git'));
  const dOld = await liveOf(old);
  assert.deepStrictEqual(pendingFile(old), [], 'foto vieja');
  assert.ok(!/SECRETO/.test(sentOf(dOld.tablas)));
  const none = machine();
  session(none, originRepo('https://github.com/acme/repo.git'));
  const dNone = await liveOf(none);
  assert.deepStrictEqual(pendingFile(none), [], 'sin foto no se sabe');
  assert.ok(!/SECRETO/.test(sentOf(dNone.tablas)));
  const bare = machine();
  photoOf(bare, ['acme/repo'], Date.now() - 60000);
  session(bare, fs.mkdtempSync(path.join(os.tmpdir(), 'office-sin-repo-')));
  await liveOf(bare);
  assert.deepStrictEqual(pendingFile(bare), [], 'carpeta sin remoto');
  const ours = machine();
  photoOf(ours, ['acme/repo'], Date.now() - 60000);
  session(ours, originRepo('https://github.com/acme/repo.git'));
  await liveOf(ours);
  assert.deepStrictEqual(pendingFile(ours), ['SECRETO de la sesión'], 'el repo seguido sí se clasifica');
});

test('Regresion_TemaDeLaFila_LlegaALaTarjetaReal @story-8.184 @ac-7 @ac-8: fila con `quien` y sin historia; dos tarjetas de una historia', () => {
  const board = buildBoard({ pendientes: [{ titulo: 'Lo de Paz', estado: 'curso', quien: 'Paz', tema: 'Tema corregido' }] });
  const { data } = buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', extra: { kind: 'note', text: 'Lo de Paz' } }]), board, nowMs: SUNDAY });
  assert.deepStrictEqual(pendingOf(data), [], 'no se le pregunta al modelo');
  assert.deepStrictEqual(tablesOf(data).hoy.filas.map((f) => f.grupo), ['Tema corregido']);
  const two = buildOffice({
    wip: wip([{ session: 'Paz', sid: 'p', extra: { kind: 'pipeline', storyId: '5.5', title: 'Parte A', current: 'implement' } }, { session: 'Ana', sid: 'a', extra: { kind: 'pipeline', storyId: '5.5', title: 'Parte B', current: 'implement' } }]),
    board: buildBoard({ pendientes: [{ titulo: 'La historia', estado: 'curso', historia: '5.5', tema: 'Tema Fila' }] }),
    nowMs: SUNDAY,
  }).data;
  assert.deepStrictEqual(tablesOf(two).hoy.filas.map((f) => [f.grupo, f.trabajos.length]), [['Tema Fila', 2]], 'el trabajo no se parte en dos filas');
});

test('Regresion_PedidoDeLaFila @story-8.184 @ac-16 @ac-18: nombres parecidos, tablero ilegible, otra rama, rama compartida y pedido ajeno', () => {
  const id = {};
  const s = (nombre, sid, branch) => ({ nombre, sid, repo: 'r', identity: id, branch });
  const prs = [{ repoName: 'r', number: 111, branch: 'rama-a' }, { repoName: 'r', number: 222, branch: 'rama-b' }, { repoName: 'r', number: 500, branch: 'dev' }, { repoName: 'r', number: 600, branch: 'de-otro', ajeno: true }];
  const none = { filas: {}, sesiones: {} };
  const both = [s('Almeida A', 'a', 'rama-a'), s('Almeida B', 'b', 'rama-b')];
  const one = rowPrsNow({ filas: buildBoard({ pendientes: [{ titulo: 'De B', estado: 'curso', quien: 'Almeida B' }] }).filas, memory: none, openPrs: prs, sessions: both });
  assert.strictEqual(one.filas['titulo:de b'].numero, 222, 'la sesión con ese nombre entero');
  const twoRows = rowPrsNow({ filas: buildBoard({ pendientes: [{ titulo: 'De A', estado: 'curso', quien: 'Almeida A' }, { titulo: 'De B', estado: 'curso', quien: 'Almeida B' }] }).filas, memory: none, openPrs: prs, sessions: both });
  assert.strictEqual(twoRows.filas['titulo:de a'].numero, 111, 'dos filas de dos sesiones no son la misma');
  assert.strictEqual(twoRows.filas['titulo:de b'].numero, 222);
  assert.deepStrictEqual(rowPrsNow({ filas: buildBoard({ pendientes: [{ titulo: 'De quién', estado: 'curso', quien: 'Almeida' }] }).filas, memory: none, openPrs: prs, sessions: both }).filas, {}, 'con dos posibles no se sabe');
  // un tablero ilegible no dice que las filas no estén
  const memory = { filas: { 'titulo:lo de paz': { repo: 'r', numero: 901 } }, sesiones: {} };
  assert.deepStrictEqual(rowPrsNow({ filas: null, memory, openPrs: [], sessions: [] }).filas, memory.filas);
  // la memoria de una sesión es de su rama
  const was = rowPrsNow({ filas: [], memory: none, openPrs: prs, sessions: [s('Paz', 'p', 'rama-a')] });
  assert.strictEqual(was.sesiones.p.numero, 111);
  assert.strictEqual(rowPrsNow({ filas: [], memory: was, openPrs: [], sessions: [s('Paz', 'p', 'rama-a')] }).sesiones.p.numero, 111, 'en su rama, sigue');
  assert.strictEqual(rowPrsNow({ filas: [], memory: was, openPrs: prs, sessions: [s('Paz', 'p', 'otra')] }).sesiones.p, undefined, 'cambió de rama: se olvida');
  // las ramas compartidas y los pedidos ajenos no son de la sesión
  assert.deepStrictEqual(rowPrsNow({ filas: [], memory: none, openPrs: prs, sessions: [s('Paz', 'p', 'dev'), s('Ana', 'a', 'de-otro')] }).sesiones, {});
});

test('Regresion_PedidoDeLaFila_PorLaFotoReal @story-8.184 @ac-18: tablero roto; la carpeta es la de la ejecución; sesión quieta sin trabajo', async () => {
  const m = machine();
  const saved = { version: 1, filas: { 'titulo:lo de paz': { repo: 'r', numero: 901 } }, sesiones: {} };
  fs.writeFileSync(path.join(m.sdir, 'office', 'row-prs.json'), JSON.stringify(saved));
  fs.writeFileSync(path.join(m.sdir, 'coordination', 'tablero.json'), '{"pendientes": [');
  await liveOf(m);
  assert.deepStrictEqual(T.readRowPrs(m.sdir).filas, saved.filas, 'una foto con el tablero a medio escribir no borra nada');
  // una sesión viva y quieta, sin trabajo anotado: la que dejó su pedido en la cola
  const q = machine();
  photoOf(q, ['acme/repo'], Date.now() - 60000);
  const repo = originRepo('https://github.com/acme/repo.git');
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', '-C', repo, 'commit', '-q', '--allow-empty', '-m', 'x'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'fix/x'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(q.sdir, 'stuck-prs-photo.json'), JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), lecturas: { 'acme/repo': { ok: true, value: [{ number: 901, sourceBranch: 'fix/x', title: 'x' }] } } }));
  fs.writeFileSync(path.join(q.sdir, 'own-prs.json'), JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), lecturas: { 'acme/repo': { ok: true, value: [{ number: 901, sourceBranch: 'fix/x', title: 'x' }] } } }));
  fs.writeFileSync(path.join(q.sdir, 'coordination', 'tablero.json'), JSON.stringify({ pendientes: [{ titulo: 'Tope de la oficina', estado: 'curso', quien: 'Paz' }] }));
  fs.writeFileSync(path.join(claudeDir(q.home), 'sessions', 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Paz', status: 'idle', statusUpdatedAt: Date.now(), cwd: repo }));
  await liveOf(q, { queryPrs: async (list) => list.map(() => ({})) });
  assert.strictEqual(T.readRowPrs(q.sdir).filas['titulo:tope de la oficina'].numero, 901);
});

test('Regresion_EsperaQueNombraUnPedido @story-8.184 @ac-16: se cae por el que nombra, tenga o no pedido en su rama', async () => {
  const dir = originRepo('https://github.com/acme/repo.git');
  const mergedAt = '2026-11-02T20:00:00Z';
  const at = Date.parse(mergedAt);
  const sessionPrs = { p: { repo: 'repo', numero: 901, identity: { platform: 'github', org: 'acme', repo: 'repo' } } };
  const open = { measured: true, prs: [{ number: 901, mark: '#', repoName: 'repo' }] };
  const said = await askWaitingPrs(waitingWip(dir, 'que entre el #900', at - 1000), open, { queryPrs: readerOf({ 900: { state: 'merged', mergedAt } }), sessionPrs }, new Map());
  assert.strictEqual(said.get('p').all, true);
});

test('Regresion_TrabajoDespuesDeLaEspera @story-8.184 @ac-17: las sesiones sin ejecución también cuentan los archivos que tocaron', () => {
  const m = machine();
  const since = Date.now() - 30 * 60000;
  fs.writeFileSync(path.join(claudeDir(m.home), 'sessions', 's1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', name: 'Paz', status: 'idle', statusUpdatedAt: Date.now() }));
  fs.writeFileSync(path.join(m.sdir, 'adhoc', 's1.json'), JSON.stringify({ reason: 'Su arreglo', declaredAt: new Date(since).toISOString() }));
  fs.mkdirSync(path.join(m.sdir, 'file-events'), { recursive: true });
  const touched = since + 20 * 60000;
  fs.writeFileSync(path.join(m.sdir, 'file-events', 's1.jsonl'), `${JSON.stringify({ path: path.join(m.home, 'a.js'), ts: new Date(touched).toISOString() })}\n`);
  const w = buildWip({ stateDir: m.sdir, sessionsDir: path.join(claudeDir(m.home), 'sessions'), now: new Date().toISOString(), home: m.home });
  assert.strictEqual(w.extra[0].touchedAt, touched);
  const run = (status, extra, lastWrite) => byName(buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', status, extra: { kind: 'note', text: 'Su trabajo', waitingFor: 'x', waitingSince: since, ...extra } }]), lastWrites: new Map(lastWrite ? [['p', lastWrite]] : []), nowMs: Date.now() }).data, 'Paz').estado;
  assert.notStrictEqual(run('idle', { touchedAt: touched }), 'esperando');
  assert.notStrictEqual(run('shell', {}, touched), 'esperando', 'corriendo un comando también está ocupada');
});

test('Regresion_MedioCamino_SuClaveYSuRespaldo @story-8.184 @ac-7 @ac-13: usa la clave de su historia; sin modelo, el trabajo que era', () => {
  const left = [{ folder: '/x/repo', branch: 'b', changes: 2, ahead: 0 }];
  const { data } = buildOffice({ wip: wip([], { halfwayItems: [{ kind: 'run', sid: 'c', storyId: '9.8', text: 'La lampara de la oficina', left }] }), nowMs: SUNDAY });
  assert.deepStrictEqual(T.pendingWorks(workCards(data.kanban), { 'historia:9.8': 'Guardado' }), [], 'ya tiene tema por su historia');
  assert.ok(rowOfTopic(tablesOf(data, { temas: { 'historia:9.8': 'Guardado' } }).pendientes, 'Guardado'));
  const prs = T.prScopes(['feat(office): la lampara de la oficina']);
  assert.ok(rowOfTopic(tablesOf(data, { sinModelo: true, prs }).pendientes, 'Office'));
});

test('Regresion_Respaldo_AlcancesEnOrdenFijo @story-8.184 @ac-13: el mismo tema en cualquier orden; el alcance de varias palabras', () => {
  const titles = ['feat(frenos): algo', 'fix(firmas): otra cosa'];
  const said = 'Arreglo de frenos y firmas';
  assert.strictEqual(T.topicOf({ titulo: said }, { sinModelo: true, prs: T.prScopes(titles) }), T.topicOf({ titulo: said }, { sinModelo: true, prs: T.prScopes([...titles].reverse()) }));
  assert.strictEqual(T.topicOf({ titulo: 'Arreglar freno de escrituras hoy' }, { sinModelo: true, prs: T.prScopes(['fix(freno de escrituras): algo', 'fix(freno): otra']) }), 'Freno de escrituras');
});

test('Regresion_LlamadaFallida_SeCuenta @story-8.184 @ac-14 @ac-21: cuenta en el reporte; sus títulos, si pudo haber gastado', async () => {
  const tags = { ok: true, status: 200, json: async () => ({ models: [{ name: 'gemma-chico-cloud' }] }) };
  const m = toy({ pending: [work('Uno'), work('Dos')] });
  await T.classify(opts(m, { impl: async (url) => (String(url).endsWith('/api/tags') ? tags : { ok: false, status: 500 }) }));
  const day = () => Object.values(T.readUsage(m.sdir).dias)[0];
  assert.strictEqual(day().llamadas, 1);
  assert.strictEqual(day().fallidas, 1);
  assert.strictEqual(day().titulos, 0, 'lo que el servicio rechazó no gastó');
  assert.match(T.report(m.sdir), /1 llamada \(1 fallida\)/);
  // el cuerpo se cuelga después de los encabezados: cuenta como tiempo, deja su plazo y suelta el candado
  const n = toy({ pending: [work('Uno'), work('Dos')] });
  const r = await T.classify(opts(n, { impl: async (url) => (String(url).endsWith('/api/tags') ? tags : { ok: true, status: 200, text: () => new Promise(() => {}) }) }, { timeoutMs: 50 }));
  assert.strictEqual(r.fallo, 'tiempo');
  assert.ok(Number.isFinite(T.readState(n.sdir).state.nextAt));
  assert.strictEqual(Object.values(T.readUsage(n.sdir).dias)[0].titulos, 2, 'pudo haber gastado');
  assert.strictEqual(fs.existsSync(path.join(n.sdir, 'office', 'topics.lock')), false);
});

test('Regresion_NombresReservados @story-8.184 @ac-1 @ac-22: el modelo no marca un trabajo propio como otro proyecto; «Otros» no se ofrece; misma caja', async () => {
  const m = toy({ pending: [work('Lo mio'), work('Lo tuyo')] });
  fs.writeFileSync(path.join(m.sdir, 'office', 'topics.json'), JSON.stringify({ version: 1, temas: { 'titulo:viejo': 'Otros', 'titulo:otro viejo': 'Frenos' } }));
  const svc = localService({ answer: () => ['Otro proyecto', 'otros'] });
  await T.classify(opts(m, svc));
  assert.strictEqual(saved(m)['titulo:lo mio'], 'Otros');
  assert.strictEqual(saved(m)['titulo:lo tuyo'], 'Otros');
  assert.match(svc.calls[0].prompt, /Temas usados: \["Frenos"\]/);
  const k = kanbanOf({ curso: [card('Uno', 'Frenos'), card('Dos', 'frenos'), card('Tres', 'otros'), card('Cuatro', 'Zeta')] });
  assert.deepStrictEqual(buildTables({ kanban: k, nowMs: SUNDAY }).hoy.filas.map((f) => f.grupo), ['Frenos', 'Zeta', 'Otros']);
});

test('Regresion_ServicioLocal_ElNombreRegistrado @story-8.184 @ac-12: con o sin etiqueta', async () => {
  for (const [modelo, registrado] of [['glm-5.3', 'glm-5.3:cloud'], ['x-cloud', 'x-cloud:latest'], ['gemma', 'gemma-cloud']]) {
    const m = toy({ table: { economy: modelo }, pending: [work('Uno')] });
    const svc = localService({ models: [registrado] });
    await T.classify(opts(m, svc));
    assert.strictEqual(svc.calls[0].body.model, registrado);
  }
});

test('Regresion_ListaPrivada @story-8.184 @ac-9: un término sin `palabra` vale pegado; las banderas son las del detector; si no se lee, se dice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-lista-'));
  const list = path.join(dir, 'lista.json');
  fs.writeFileSync(list, JSON.stringify({ terminos: [{ patron: 'fulano', categoria: 'persona' }, { patron: 'mengano', categoria: 'persona', palabra: true }], patrones: [{ regex: 'a\\-b', categoria: 'persona' }] }));
  const m = toy({ pending: [work('Arreglo de FulanoMartinez'), work('Lo de menganos'), work('Lo de mengano'), work('Algo de a-b')] });
  const svc = localService();
  await T.classify(opts(m, svc, { namesFile: list }));
  assert.deepStrictEqual(JSON.parse(svc.calls[0].prompt.split('Títulos:\n')[1]), ['Lo de menganos'], 'sólo lo que no nombra a nadie');
  // una lista que no se puede leer se dice en la tabla
  fs.writeFileSync(list, '{ rota');
  const n = toy({ pending: [work('Uno')] });
  await T.classify(opts(n, localService(), { namesFile: list }));
  assert.strictEqual(T.tableNote(T.readState(n.sdir).state, NOW), T.NOTE_LIST);
});

test('Regresion_SinModelo_SeLimpiaAunqueNoHayaPendientes @story-8.184 @ac-13: si el modelo volvió, deja de decirlo', async () => {
  const m = toy();
  fs.writeFileSync(path.join(m.sdir, 'office', 'topics-state.json'), JSON.stringify({ version: 1, sinModelo: true, nextAt: NOW - 1000 }));
  await T.classify(opts(m, localService()));
  assert.strictEqual(T.tableNote(T.readState(m.sdir).state, NOW), null);
});

test('Regresion_NotaDeEstado_NoEsElTitulo @story-8.184 @ac-1 @ac-7 @ac-10: en la tabla sale el trabajo y la nota queda de detalle; al modelo va el trabajo', () => {
  // la ejecución que siguió con una nota: su título
  const run = (extra) => buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', extra: { storyId: '9.1', title: 'La historia de verdad', runFolder: '/x/repo', meanwhile: 'portón 61 de 62', meanwhileKind: 'note', meanwhileAt: SUNDAY - 60000, ...extra } }]), nowMs: SUNDAY }).data;
  const closed = run({ kind: 'entering', closedAt: SUNDAY - 3600000 });
  const row = tablesOf(closed).hoy.filas[0];
  assert.doesNotMatch(row.que, /portón/);
  assert.match(row.que, /La historia de verdad/);
  assert.strictEqual(row.que, 'La historia de verdad', 'los dos son el mismo trabajo: no se nombra dos veces');
  assert.ok(row.trabajos.some((w) => w.titulo === 'La historia de verdad' && /portón 61 de 62/.test(w.como)), 'la nota queda de detalle');
  assert.deepStrictEqual(pendingOf(closed), ['La historia de verdad']);
  assert.ok(columnOf(closed, 'curso').some((c) => c.titulo === 'portón 61 de 62'), 'el kanban sigue igual');
  // la nota cambia y el trabajo no: no hay nada nuevo que clasificar
  const later = buildOffice({ wip: wip([{ session: 'Paz', sid: 'p', extra: { kind: 'entering', closedAt: SUNDAY - 3600000, storyId: '9.1', title: 'La historia de verdad', runFolder: '/x/repo', meanwhile: 'portón 62 de 62', meanwhileKind: 'note', meanwhileAt: SUNDAY - 1000 } }]), nowMs: SUNDAY }).data;
  assert.deepStrictEqual(T.pendingWorks(workCards(later.kanban), Object.fromEntries(T.pendingWorks(workCards(closed.kanban), {}).map((w) => [w.clave, 'Tema']))), []);
  // una nota con su fila del tablero: el título de la fila
  const withRow = buildOffice({ wip: wip([{ session: 'Ana', sid: 'a', extra: { kind: 'note', text: 'en main; falta encolar' } }]), board: buildBoard({ pendientes: [{ titulo: 'El trabajo de la fila', estado: 'curso', quien: 'Ana' }] }), nowMs: SUNDAY }).data;
  assert.strictEqual(tablesOf(withRow).hoy.filas[0].que, 'El trabajo de la fila');
  assert.deepStrictEqual(pendingOf(withRow), ['El trabajo de la fila']);
  // lo que dice su conversación tampoco es el título, si hay una fila
  const talking = buildOffice({ wip: wip([{ session: 'Ana', sid: 'a', extra: { kind: 'activity' } }]), sessionFiles: [{ session: 'a', tool: 'claude', pid: 10 }], transcripts: new Map([['a', { haciendoAhora: 'Una frase de su conversación', lastWriteMs: SUNDAY }]]), board: buildBoard({ pendientes: [{ titulo: 'El trabajo de la fila', estado: 'curso', quien: 'Ana' }] }), nowMs: SUNDAY }).data;
  assert.deepStrictEqual(pendingOf(talking), ['El trabajo de la fila']);
  // un carril es un trabajo: su motivo es el título. Y una nota sola, sin nada más que diga cuál es el trabajo, se dice como está
  const loose = buildOffice({ wip: wip([{ session: 'Ana', sid: 'a', extra: { kind: 'loose', text: 'Un arreglo chico' } }]), nowMs: SUNDAY }).data;
  assert.strictEqual(tablesOf(loose).hoy.filas[0].que, 'Un arreglo chico');
  const alone = buildOffice({ wip: wip([{ session: 'Ana', sid: 'a', extra: { kind: 'note', text: 'Una nota sola' } }]), nowMs: SUNDAY }).data;
  assert.strictEqual(tablesOf(alone).hoy.filas[0].que, 'Una nota sola');
  // de otro proyecto, ni el título ni la nota salen de la máquina
  const other = buildOffice({ wip: wip([{ session: 'Mesa', sid: 'm', extra: { kind: 'entering', closedAt: SUNDAY - 3600000, storyId: '9.2', title: 'SECRETO historia', runFolder: '/x/ajeno', meanwhile: 'SECRETO nota', meanwhileKind: 'note', meanwhileAt: SUNDAY - 60000 } }]), otherProjects: new Set(['m']), nowMs: SUNDAY }).data;
  assert.deepStrictEqual(pendingOf(other), []);
  assert.ok(!/SECRETO/.test(sentOf(tablesOf(other))));
});

test('Regresion_TitulosSinLetras @story-8.184 @ac-7: dos títulos sin letras no comparten clave', () => {
  assert.notStrictEqual(T.workKey({ titulo: '🚀' }), T.workKey({ titulo: '— ✅ —' }));
});

test('Regresion_Lineas @story-8.184 @ac-2: una hora escrita no es «sin hora»; una fecha lejana dice cuál', () => {
  const written = kanbanOf({ sinEmpezar: [card('Uno', 'T', { hora: 'jueves 10:00' }), card('Dos', 'T', { hora: 'sin hora estimada' })] });
  assert.strictEqual(rowOfTopic(buildTables({ kanban: written, nowMs: SUNDAY }).pendientes, 'T').col, 'Jueves 10:00 · 1 sin hora');
  const hidden = kanbanOf({ sinEmpezar: [card('Uno', null, { hora: 'SECRETO jueves', otro: true })] });
  assert.ok(!/SECRETO/.test(sentOf(buildTables({ kanban: hidden, nowMs: SUNDAY }))), 'la hora escrita de otro proyecto no viaja');
  assert.strictEqual(rowOfTopic(buildTables({ kanban: hidden, nowMs: SUNDAY }).pendientes, T.OTHER_PROJECT).col, '1 con hora');
  const far = kanbanOf({ sinEmpezar: [card('Uno', 'T', { finMs: dayAt(30, 10) })] });
  assert.match(rowOfTopic(buildTables({ kanban: far, nowMs: SUNDAY }).pendientes, 'T').col, /La próxima, martes 17\/11 10:00/);
  const old = kanbanOf({ sinEmpezar: [card('Uno', 'T', { finMs: dayAt(-21, 10) })] });
  assert.match(rowOfTopic(buildTables({ kanban: old, nowMs: SUNDAY }).pendientes, 'T').col, /el domingo 27\/09/);
});

test('Regresion_SinTarjeta @story-8.184 @ac-20: no toca nada, ni la red; una palabra; lo que quedó a medio camino; tablero que no es un objeto', () => {
  const k = { columnas: [{ id: 'curso', tarjetas: [{ titulo: 'Frenos' }] }], medioCamino: [{ titulo: 'Lo que quedó de la oficina' }] };
  const rows = { hoy: [{ grupo: 'G', que: 'Frenos' }, { grupo: 'G', que: 'Lo que quedó de la oficina' }, { grupo: 'G', que: 'Nada que ver acá' }] };
  assert.deepStrictEqual(T.unmatchedRows(rows, k).map((r) => r.que), ['Nada que ver acá']);
  const m = machine();
  const file = path.join(m.sdir, 'coordination', 'tablero.json');
  fs.writeFileSync(file, JSON.stringify({ pendientes: [{ titulo: 'Con pedido', estado: 'curso', quien: 'Paz' }], tablas: { hoy: [{ grupo: 'G', que: 'Algo sin tarjeta' }] } }));
  fs.writeFileSync(path.join(m.sdir, 'office', 'row-prs.json'), JSON.stringify({ version: 1, filas: { 'titulo:fila vieja': { repo: 'r', numero: 5 } }, sesiones: {} }));
  const before = fs.readFileSync(path.join(m.sdir, 'office', 'row-prs.json'), 'utf8');
  const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, TYCON_OFFICE_LINK: '0' };
  assert.match(execFileSync('node', [TOPICS, '--unmatched'], { env, encoding: 'utf8' }), /Algo sin tarjeta/);
  assert.strictEqual(fs.readFileSync(path.join(m.sdir, 'office', 'row-prs.json'), 'utf8'), before, 'la memoria sigue igual');
  assert.strictEqual(fs.existsSync(path.join(m.sdir, 'office', 'promises.json')), false, 'ni las horas prometidas');
  fs.writeFileSync(file, 'null');
  assert.throws(() => execFileSync('node', [TOPICS, '--unmatched'], { env, encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 2 && /no se pudo leer/.test(String(e.stderr)));
});
