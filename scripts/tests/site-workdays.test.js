'use strict';
/**
 * site-workdays.test.js — los días de horas y tokens en el sitio: la bajada del buzón al espejo (por el camino real del
 * sitio, `cloud/azure.js bajarBuzon` → `bajar()`), la tabla de la pestaña «Horas y tokens» (scripts/site/tabs/workdays.js),
 * quién la ve, el modo demostración, el inglés y la guía. T25 a T35, E1 y E2.
 *
 * Sin red: el buzón es uno de mentira local (scripts/tests/lib/site-harness.js). Las máquinas son inventadas
 * (`maquina-a`, `maquina-b`, `maquina-c`). E1 y E2 corren en un navegador de verdad, el Chromium fijo del arnés
 * (scripts/lib/pinned-playwright.js); sin él se saltean con constancia, salvo con la llave exigente (E2E_REQUIRED=1).
 *
 * stable-data: los días son fechas fijas; el «ayer» del sitio se inyecta.
 *
 * Correr: node --test scripts/tests/site-workdays.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'scripts', 'site');
const H = require('./lib/site-harness.js');
const WD = () => require(path.join(SITE, 'tabs', 'workdays.js'));

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const dia = (d, { arnes = 3600, sesion = 5400, sesiones = 2, lectura = 1000, escritura = 200, cache = 50000, horas, tokens } = {}) => ({
  v: 1, dia: d, tz: '-03:00',
  horas: horas || { arnes_segundos: arnes, sesion_segundos: sesion, sesiones, medido: true },
  tokens: tokens || { lectura, escritura, cache, medido: true },
});
function espejo(maquinas) {
  const dir = tmp('espejo-jornadas-');
  for (const [maq, dias] of Object.entries(maquinas)) {
    fs.mkdirSync(path.join(dir, maq, 'jornadas'), { recursive: true });
    for (const [d, contenido] of Object.entries(dias)) fs.writeFileSync(path.join(dir, maq, 'jornadas', `${d}.json`), typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
  }
  return dir;
}
const DIAS5 = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];

test('T25 Sitio_Bajada_TraeLosDias @story-8.209 @ac-15', async () => {
  const viejo = JSON.stringify(dia('2026-11-09', { arnes: 60 }));
  const nuevo = JSON.stringify(dia('2026-11-09', { arnes: 120 }));
  const buzon = await H.arrancarBuzon({ blobs: {
    'maquina-a/jornadas/v20261110T120000000Z/2026-11-09.json': viejo,
    'maquina-a/jornadas/v20261110T130000000Z/2026-11-09.json': nuevo,
  } });
  try {
    const { bajar } = require(path.join(ROOT, 'scripts', 'metrics', 'download-runs.js'));
    const directo = tmp('bajada-directa-');
    await bajar({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, dir: directo, budgetMs: 60000, jornadas: true });
    assert.strictEqual(fs.readFileSync(path.join(directo, 'maquina-a', 'jornadas', '2026-11-09.json'), 'utf8'), nuevo, 'la versión más nueva');
    // el camino del sitio: la opción no se pierde en cloud/azure.js
    const { bajarBuzon } = require(path.join(SITE, 'cloud', 'azure.js'));
    const delSitio = tmp('bajada-sitio-');
    await bajarBuzon({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, dir: delSitio, budgetMs: 60000, jornadas: true });
    assert.strictEqual(fs.readFileSync(path.join(delSitio, 'maquina-a', 'jornadas', '2026-11-09.json'), 'utf8'), nuevo);
    // sin la opción no se bajan
    const sin = tmp('bajada-sin-');
    await bajar({ cuenta: 'cuentax', contenedor: 'runs', credencial: { sas: H.sas() }, urlBase: buzon.base, dir: sin, budgetMs: 60000 });
    assert.ok(!fs.existsSync(path.join(sin, 'maquina-a', 'jornadas')));
  } finally { await buzon.cerrar(); }
});

test('T26 Sitio_Tabla_DiasPorMaquina @story-8.209 @ac-16 @ac-26', () => {
  const maquinas = {};
  for (const m of ['maquina-a', 'maquina-b', 'maquina-c']) maquinas[m] = Object.fromEntries(DIAS5.map((d) => [d, dia(d)]));
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  assert.strictEqual(t.dias.length, 30);
  assert.strictEqual(t.dias[0], '2026-11-09');
  assert.deepStrictEqual(t.maquinas, ['maquina-a', 'maquina-b', 'maquina-c']);
  const c = t.celdas['2026-11-09']['maquina-b'];
  assert.strictEqual(c.estado, 'medido');
  assert.strictEqual(c.horas.arnes_segundos, 3600);
  assert.strictEqual(c.horas.sesion_segundos, 5400);
  assert.strictEqual(c.tokens.lectura, 1000);
  const tot = t.totales['2026-11-09'];
  assert.strictEqual(tot.arnes_segundos, 3 * 3600, 'las horas con el arnés trabajando se suman entre máquinas');
  assert.strictEqual(tot.sesion_segundos, 3 * 5400);
  assert.strictEqual(tot.no_medidas, 0);
  const html = WD().htmlTabla(t, 'es');
  assert.match(html, /Horas con el arnés trabajando/);
  assert.match(html, /Horas de sesión/);
  assert.match(html, /1\.0 h/);
  assert.match(html, /1\.5 h/);
  assert.match(html, /50k/);
});

test('T27 Sitio_SinArchivo_NoMedido @story-8.209 @ac-17', () => {
  const t = WD().armarTabla(WD().leerJornadas(espejo({ 'maquina-a': { '2026-11-09': dia('2026-11-09') }, 'maquina-b': { '2026-11-08': dia('2026-11-08') } })), { ayer: '2026-11-09' });
  assert.strictEqual(t.celdas['2026-11-09']['maquina-b'].estado, 'no_medido');
  assert.strictEqual(t.totales['2026-11-09'].no_medidas, 1);
  const html = WD().htmlTabla(t, 'es');
  assert.match(html, /no medido/);
  assert.match(html, /1 máquina sin medir/);
  // un día sin ninguna máquina medida: el total dice «no medido», no cero
  assert.match(html, /<th scope="row">2026-11-07<\/th>(?:<td class="no-medido">no medido<\/td>){2}<td class="total"><div>no medido<\/div><div>2 máquinas sin medir<\/div><\/td>/);
});

test('T28 Sitio_TokensNoMedidos_ConMotivo @story-8.209 @ac-17', () => {
  const d = dia('2026-11-09', { tokens: { medido: false, motivo: 'una conversación no se pudo leer (EACCES)' } });
  const t = WD().armarTabla(WD().leerJornadas(espejo({ 'maquina-a': { '2026-11-09': d } })), { ayer: '2026-11-09' });
  const c = t.celdas['2026-11-09']['maquina-a'];
  assert.strictEqual(c.estado, 'medido');
  assert.ok(c.horas);
  assert.strictEqual(c.tokens, null);
  const html = WD().htmlTabla(t, 'es');
  assert.match(html, /tokens no medidos/);
  assert.match(html, /title="una conversación no se pudo leer \(EACCES\)"/);
});

// el sitio demo en este proceso; la vista se elige con su cookie
async function arrancarDemo(extra = {}) {
  const dir = tmp('demo-horas-');
  const sitio = require(path.join(SITE, 'server.js')).crearSitioDemo({ env: { SITE_DEMO: '1', ...extra }, dir, log: () => {} });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  return { sitio, base, pedir: (ruta, o) => H.pedirA(base, ruta, o), cerrar: () => sitio.cerrar() };
}

test('T29 Sitio_Programador_403 @story-8.209 @ac-18', async () => {
  const h = await arrancarDemo();
  try {
    const cookie = 'sitio-demo-vista=persona';
    const inicio = await h.pedir('/', { cookie });
    assert.doesNotMatch(inicio.texto, /href="\/horas"/, 'sin la pestaña');
    assert.strictEqual((await h.pedir('/horas', { cookie })).status, 403);
    assert.strictEqual((await h.pedir('/api/horas', { cookie })).status, 403);
  } finally { await h.cerrar(); }
});

test('T30 Sitio_QuienMantiene_200 @story-8.209 @ac-16 @ac-18', async () => {
  const h = await arrancarDemo();
  try {
    const cookie = 'sitio-demo-vista=mantenedor';
    const inicio = await h.pedir('/', { cookie });
    assert.match(inicio.texto, /href="\/horas"/, 'con la pestaña');
    const pag = await h.pedir('/horas', { cookie });
    assert.strictEqual(pag.status, 200);
    assert.match(pag.texto, /Horas con el arnés trabajando/);
    const api = await h.pedir('/api/horas', { cookie });
    assert.strictEqual(api.status, 200);
    assert.ok(Array.isArray(api.json.dias) && api.json.dias.length === 30);
  } finally { await h.cerrar(); }
});

test('T31 Sitio_Demo_MaquinasInventadas @story-8.209 @ac-19', async () => {
  const h = await arrancarDemo();
  try {
    const api = await h.pedir('/api/horas', { cookie: 'sitio-demo-vista=mantenedor' });
    assert.deepStrictEqual(api.json.maquinas, ['maquina-a', 'maquina-b']);
    const celdas = Object.values(api.json.celdas).flatMap((porMaquina) => Object.values(porMaquina));
    assert.ok(celdas.some((c) => c.estado === 'no_medido'), 'un día no medido');
    assert.ok(celdas.some((c) => c.estado === 'medido'));
    assert.ok(!celdas.some((c) => c.estado === 'raro'), 'los datos de ejemplo tienen la forma que el sitio entiende');
  } finally { await h.cerrar(); }
});

test('T32 Sitio_ArchivoRaro_NoMedidoYElResto @story-8.209 @ac-20', () => {
  const sinCampo = dia('2026-11-07');
  delete sinCampo.tokens;
  const negativo = dia('2026-11-08', { arnes: -5 });
  const t = WD().armarTabla(WD().leerJornadas(espejo({ 'maquina-a': {
    '2026-11-06': { ...dia('2026-11-06'), v: 3 }, '2026-11-07': sinCampo, '2026-11-08': negativo, '2026-11-05': '{roto', '2026-11-09': dia('2026-11-09'),
  } })), { ayer: '2026-11-09' });
  for (const d of ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) assert.strictEqual(t.celdas[d]['maquina-a'].estado, 'raro', d);
  assert.strictEqual(t.celdas['2026-11-09']['maquina-a'].estado, 'medido', 'el resto igual');
  assert.match(WD().htmlTabla(t, 'es'), /no medido \(no se entendió el archivo\)/);
  // la carpeta de una máquina que no se puede leer: la máquina sigue en la tabla, «no se pudo leer»
  const dir = espejo({ 'maquina-a': { '2026-11-09': dia('2026-11-09') }, 'maquina-b': { '2026-11-09': dia('2026-11-09') } });
  fs.chmodSync(path.join(dir, 'maquina-b', 'jornadas'), 0o000);
  try {
    const j = WD().leerJornadas(dir);
    assert.ok(j.ilegibles['maquina-b']);
    const t2 = WD().armarTabla(j, { ayer: '2026-11-09' });
    assert.deepStrictEqual(t2.maquinas, ['maquina-a', 'maquina-b']);
    assert.strictEqual(t2.celdas['2026-11-09']['maquina-b'].estado, 'ilegible');
    assert.match(WD().htmlTabla(t2, 'es'), /no medido \(no se pudo leer\)/);
  } finally { fs.chmodSync(path.join(dir, 'maquina-b', 'jornadas'), 0o700); }
  // el espejo entero ilegible se dice, no es «no llegó nada»
  const raiz = tmp('espejo-ilegible-');
  fs.chmodSync(raiz, 0o000);
  try { assert.ok(WD().leerJornadas(raiz).problema); } finally { fs.chmodSync(raiz, 0o700); }
  assert.deepStrictEqual(WD().leerJornadas(path.join(raiz, 'no-existe')).problema, undefined, 'que no exista no es un problema');
});

test('T33 Sitio_Ingles_Textos @story-8.209 @ac-21', async () => {
  const h = await arrancarDemo();
  try {
    const pag = await h.pedir('/horas', { cookie: 'sitio-demo-vista=mantenedor; sitio-idioma=en' });
    assert.strictEqual(pag.status, 200);
    assert.match(pag.texto, /Hours and tokens/);
    assert.match(pag.texto, /not measured/);
    assert.doesNotMatch(pag.texto, /no medido/);
  } finally { await h.cerrar(); }
});

test('T34 Guia_DiceQueMideYQuienLaVe @story-8.209 @ac-22', () => {
  const es = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.md'), 'utf8');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.en.md'), 'utf8');
  for (const [texto, palabras] of [
    [es, [/Horas y tokens/, /s[óo]lo (la ve )?quien mantiene/i, /Horas con el arnés trabajando/, /Horas de sesión/, /tokens/, /no medido/, /TYCON_WORKDAYS=0/, /Codex/]],
    [en, [/Hours and tokens/, /maintainers? only|only (the )?maintainers?/i, /Hours with the harness working/, /Session hours/, /tokens/, /not measured/, /TYCON_WORKDAYS=0/, /Codex/]],
  ]) for (const p of palabras) assert.match(texto, p);
});

test('T35 NoRegresion_LasSeisSuites @story-8.209 @ac-23 @ac-24', () => {
  // lo que hoy anota de Codex no cambia: sus tres momentos de siempre dicen lo mismo
  const { decide } = require(path.join(ROOT, 'scripts', 'hooks', 'session-state.js'));
  assert.deepStrictEqual(decide({ hook_event_name: 'UserPromptSubmit' }, true), { patch: { busy: true, waitingForOwner: false, waitingFor: null } });
  assert.deepStrictEqual(decide({ hook_event_name: 'Stop' }, true), { patch: { busy: false } });
  assert.deepStrictEqual(decide({ hook_event_name: 'SessionStart' }, true), { patch: {} });
  // las tres suites nuevas están anotadas y las seis del AC 23 siguen ahí
  const suites = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'tests', 'suites.json'), 'utf8')));
  for (const s of ['worked-time.test.js', 'workday-upload.test.js', 'site-workdays.test.js', 'session-state.test.js', 'session-transcript.test.js',
    'upload-runs.test.sh', 'download-runs.test.sh', 'site-views.test.js', 'site-demo.test.js']) assert.ok(suites.includes(s), s);
});

// ── E1-E2: en un navegador de verdad, contra el sitio de demostración ─────────────────────────────────────────────
const PINNED_PW = require('../lib/pinned-playwright.js');
const PLAYWRIGHT = PINNED_PW.load();
const SIN_NAVEGADOR = process.env.E2E_REQUIRED === '1' ? false : (!PLAYWRIGHT && PINNED_PW.locate().why);

test('T48 Total_SinHorasMedidas_NoEsCero @story-8.209 @ac-17', () => {
  // las dos máquinas tienen archivo pero ninguna midió horas: el total de horas dice «no medidas», no 0.0 h
  const sinHoras = { medido: false, motivo: 'el gancho de estado no anotó ese día (apagado o sin instalar)' };
  const j = WD().leerJornadas(espejo({ 'maquina-a': { '2026-11-09': dia('2026-11-09', { horas: sinHoras }) }, 'maquina-b': { '2026-11-09': dia('2026-11-09', { horas: sinHoras }) } }));
  const t = WD().armarTabla(j, { ayer: '2026-11-09' });
  const fila = WD().htmlTabla(t, 'es').split('<tr>').find((r) => r.includes('2026-11-09'));
  const total = fila.slice(fila.indexOf('class="total"'));
  assert.doesNotMatch(total, /0\.0 h/);
  assert.match(total, /horas no medidas/i);
  assert.match(total, /Tokens/, 'los tokens, que sí se midieron, siguen en el total');
});

test('T49 Ventana_ArchivoRaroOFechaImposible_NoLaCorre @story-8.209 @ac-16', () => {
  // un archivo que no se entendió o un nombre con forma de fecha que no existe no corren la tabla al futuro
  const j = WD().leerJornadas(espejo({ 'maquina-a': { '2026-11-09': dia('2026-11-09'), '2099-01-01': '{roto', '2026-13-45': dia('2026-13-45') } }));
  const t = WD().armarTabla(j, { ayer: '2026-11-09' });
  assert.strictEqual(t.dias[0], '2026-11-09');
  assert.ok(!t.dias.includes('2026-13-45'));
});

test('E1 E2E_HorasYTokens_QuienMantiene @story-8.209 @ac-16 @ac-17',{ skip: SIN_NAVEGADOR, timeout: 120000 }, async () => {
  assert.ok(PLAYWRIGHT, `con la llave exigente prendida, Playwright tiene que estar: ${PINNED_PW.locate().why}`);
  const h = await arrancarDemo();
  const navegador = await PLAYWRIGHT.chromium.launch();
  try {
    const ctx = await navegador.newContext();
    await ctx.setExtraHTTPHeaders({ cookie: 'sitio-demo-vista=mantenedor' });
    const page = await ctx.newPage();
    await page.goto(`${h.base}/`);
    await page.getByRole('link', { name: 'Horas y tokens' }).first().click();
    await page.waitForURL(/\/horas$/);
    // arriba, el resumen de la semana por persona; la tabla de cada día, plegada abajo
    const resumen = page.locator('table.horas-personas');
    await resumen.waitFor({ timeout: 20000 });
    assert.match(await page.locator('.fichas').innerText(), /sin dato de modelo/);
    // la evolución: dos gráficos, horas por persona y tokens
    assert.strictEqual(await page.locator('figure.grafico svg').count(), 2);
    await page.getByText('Ver día por día', { exact: true }).click();
    await page.locator('table.por-persona').waitFor({ timeout: 20000 });
    await page.getByText('Ver por máquina', { exact: true }).click();
    const tabla = page.locator('table.horas');
    await tabla.waitFor({ timeout: 20000 });
    const texto = await tabla.innerText();
    assert.match(texto, /Horas con el arnés trabajando/);
    assert.match(texto, /Horas de sesión/);
    assert.match(texto, /no medido/);
    assert.match(texto, /Total/);
    if (process.env.TYCON_E2E_CAPTURE) await page.screenshot({ path: path.join(process.env.TYCON_E2E_CAPTURE, 'horas-y-tokens.png'), fullPage: true });
  } finally { await navegador.close(); await h.cerrar(); }
});

test('E2 E2E_HorasYTokens_ProgramadorNoLaVe @story-8.209 @ac-18', { skip: SIN_NAVEGADOR, timeout: 120000 }, async () => {
  assert.ok(PLAYWRIGHT, `con la llave exigente prendida, Playwright tiene que estar: ${PINNED_PW.locate().why}`);
  const h = await arrancarDemo();
  const navegador = await PLAYWRIGHT.chromium.launch();
  try {
    const ctx = await navegador.newContext();
    await ctx.setExtraHTTPHeaders({ cookie: 'sitio-demo-vista=persona' });
    const page = await ctx.newPage();
    await page.goto(`${h.base}/`);
    assert.strictEqual(await page.getByRole('link', { name: 'Horas y tokens' }).count(), 0, 'sin la pestaña en el menú');
    const r = await page.goto(`${h.base}/horas`);
    assert.strictEqual(r.status(), 403);
  } finally { await navegador.close(); await h.cerrar(); }
});

// ── O-horas, parte 1: el resumen de la semana y la tabla por persona ───────────────────────────────────────────────

const PEOPLE = {
  machines: {
    'maquina-a': { person: 'ana@acme.example', reported_sha256: null, confirmed_by: 'lider@acme.example', confirmed_on: '2026-11-01' },
    'maquina-b': { person: 'ana@acme.example', reported_sha256: null, confirmed_by: 'lider@acme.example', confirmed_on: '2026-11-01' },
    'maquina-c': { person: 'beto@acme.example', reported_sha256: null, confirmed_by: 'lider@acme.example', confirmed_on: '2026-11-01' },
  },
  hidden_machines: { 'maquina-vieja': { reason: 'not-team', hidden_by: 'lider@acme.example', hidden_on: '2026-11-02' } },
};
// la semana son los 7 días de SEMANA; la anterior, los 7 de antes
const SEMANA = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];

test('OH1 Resumen_PorPersona_SinMedirNoEsCero — las máquinas de una persona suman en su fila; una oculta o sin horas no sale', () => {
  const maquinas = {
    // ana: dos máquinas, 1 h cada una los 7 días
    'maquina-a': Object.fromEntries(SEMANA.map((d) => [d, dia(d, { arnes: 3600, lectura: 1000, escritura: 200 })])),
    'maquina-b': Object.fromEntries(SEMANA.map((d) => [d, dia(d, { arnes: 3600, lectura: 1000, escritura: 200 })])),
    // beto: sólo dos días medidos de la semana
    'maquina-c': { '2026-11-08': dia('2026-11-08', { arnes: 7200, sesion: 9000 }), '2026-11-09': dia('2026-11-09', { arnes: 7200, sesion: 9000 }) },
    // sin persona, con horas: sale con su nombre
    'maquina-d': { '2026-11-09': dia('2026-11-09', { arnes: 1800 }) },
    // oculta: no sale
    'maquina-vieja': { '2026-11-09': dia('2026-11-09', { arnes: 3000 }) },
    // sin ningún día con horas (sólo tokens medidos): no sale
    'runner-ci': { '2026-11-09': dia('2026-11-09', { horas: { medido: false, motivo: 'sin apertura' } }) },
  };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  const r = WD().resumen(t, PEOPLE);
  assert.deepStrictEqual(r.semana.dias, SEMANA.slice().reverse(), 'la semana son los 7 días más nuevos');
  const fila = (p) => r.personas.find((x) => x.persona === p);
  assert.deepStrictEqual(r.personas.map((x) => x.persona), ['ana@acme.example', 'beto@acme.example', 'maquina-d']);
  assert.deepStrictEqual(fila('ana@acme.example').maquinas, ['maquina-a', 'maquina-b']);
  assert.strictEqual(fila('ana@acme.example').segundos, 14 * 3600, 'las dos máquinas suman');
  assert.strictEqual(fila('ana@acme.example').diasMedidos, 7);
  assert.strictEqual(fila('ana@acme.example').promedioDia, 2 * 3600);
  assert.strictEqual(fila('beto@acme.example').diasMedidos, 2);
  assert.strictEqual(fila('beto@acme.example').promedioDia, 7200, 'el promedio es por día medido, no por los 7');
  assert.strictEqual(fila('ana@acme.example').tokens, 14 * 1200, 'tokens sin caché: lectura más escritura');
  assert.ok(!r.personas.some((x) => x.maquinas.includes('maquina-vieja')), 'la oculta no sale');
  assert.ok(!r.personas.some((x) => x.maquinas.includes('runner-ci')), 'la que nunca midió horas no sale');
  assert.strictEqual(r.fuera, 2, 'se dice cuántas quedaron afuera');
  // las fichas: el promedio del equipo es por persona-día medido; los días sin medir cuentan máquina × día
  assert.strictEqual(r.semana.promedioDia, (14 * 3600 + 2 * 7200 + 1800) / (7 + 2 + 1));
  assert.strictEqual(r.semana.sinMedir, (7 - 2) + (7 - 1), 'beto 5 días y maquina-d 6 días sin medir');
  // la semana anterior no se midió: no es cero
  assert.strictEqual(r.anterior.promedioDia, null);
  const html = WD().htmlResumen(r, 'es');
  assert.match(html, /ana@acme\.example/);
  assert.match(html, /2 de 7/, 'beto: días medidos');
  assert.match(html, /sin dato de modelo/i, 'los días de la versión 1 no tienen el reparto por modelo: el costo no es cero');
  assert.doesNotMatch(html, /maquina-vieja|runner-ci/);
});

test('OH2 Resumen_PersonaSinNingunDiaEnLaSemana_DiceNoMedido — una persona con horas de antes pero no de esta semana no sale en cero', () => {
  const maquinas = { 'maquina-c': { '2026-10-30': dia('2026-10-30', { arnes: 3600 }) }, 'maquina-a': { '2026-11-09': dia('2026-11-09') } };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  const r = WD().resumen(t, PEOPLE);
  const beto = r.personas.find((x) => x.persona === 'beto@acme.example');
  assert.strictEqual(beto.diasMedidos, 0);
  assert.strictEqual(beto.promedioDia, null);
  assert.strictEqual(beto.segundos, null);
  assert.strictEqual(r.anterior.promedioDia, 3600, 'la semana anterior sí tiene un día medido');
  const html = WD().htmlResumen(r, 'es');
  assert.match(html, /beto@acme\.example[\s\S]*?no medido/);
});

// ── O-horas, parte 2: la evolución de 6 semanas, la flecha, la máquina que no sube horas y el día a día por persona ────

const diasAtras = (desde, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${desde}T00:00:00Z`) - i * 864e5).toISOString().slice(0, 10));

test('OH3 Semanas_SeisSemanas_SinMedirVaciaNoCero — horas por persona por semana; una semana sin medir queda vacía y rotulada', () => {
  const todos = diasAtras('2026-11-09', 42);
  // ana todos los días 1 h; beto sólo la semana más nueva, 2 h; la cuarta semana nadie midió
  const cuarta = new Set(todos.slice(21, 28));
  const maquinas = {
    'maquina-a': Object.fromEntries(todos.filter((d) => !cuarta.has(d)).map((d) => [d, dia(d, { arnes: 3600, lectura: 1000, escritura: 0 })])),
    'maquina-c': Object.fromEntries(todos.slice(0, 7).map((d) => [d, dia(d, { arnes: 7200, sesion: 9000, lectura: 500, escritura: 0 })])),
  };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09', dias: 42 });
  assert.strictEqual(t.dias.length, 42);
  const r = WD().resumen(t, PEOPLE);
  assert.strictEqual(r.semanas.length, 6);
  assert.deepStrictEqual(r.semanas.map((s) => s.hasta), [todos[0], todos[7], todos[14], todos[21], todos[28], todos[35]]);
  assert.strictEqual(r.semanas[0].porPersona['ana@acme.example'], 7 * 3600);
  assert.strictEqual(r.semanas[0].porPersona['beto@acme.example'], 7 * 7200);
  assert.strictEqual(r.semanas[1].porPersona['beto@acme.example'], null, 'beto no midió la segunda: null, no cero');
  assert.strictEqual(r.semanas[3].medida, false, 'la cuarta semana nadie midió');
  assert.strictEqual(r.semanas[3].tokens, null);
  assert.strictEqual(r.semanas[0].tokens, 7 * 1000 + 7 * 500);
  const svg = WD().htmlSemanas(r, 'es');
  assert.match(svg, /<svg[^>]*role="img"/);
  assert.strictEqual((svg.match(/class="barra-persona"/g) || []).length, 6, 'ana en las 5 semanas medidas y beto en 1');
  assert.match(svg, /sin medir/, 'la semana sin medir se rotula');
  assert.match(svg, /ana@acme\.example/, 'leyenda con la persona');
  assert.match(svg, /<title>[^<]*ana@acme\.example[^<]*7\.0 h/, 'cada barra dice su valor al pasar el mouse');
  // horas y tokens en dos gráficos, nunca en dos escalas del mismo
  assert.strictEqual((svg.match(/<svg/g) || []).length, 2);
});

test('OH4 Flecha_YMaquinaQueNoSubeHoras — la flecha contra la semana anterior y el aviso de la máquina que sube ejecuciones pero no horas', () => {
  const todos = diasAtras('2026-11-09', 14);
  const maquinas = { 'maquina-a': Object.fromEntries(todos.map((d, i) => [d, dia(d, { arnes: i < 7 ? 7200 : 3600, sesion: 9000 })])) };
  const dir = espejo(maquinas);
  // una máquina con ejecuciones y sin días de horas, y una oculta igual: sólo la primera se avisa
  for (const m of ['maquina-nb', 'maquina-vieja']) { fs.mkdirSync(path.join(dir, m), { recursive: true }); fs.writeFileSync(path.join(dir, m, 's1.json'), '{}'); }
  const t = WD().armarTabla(WD().leerJornadas(dir), { ayer: '2026-11-09' });
  const r = WD().resumen(t, PEOPLE);
  assert.deepStrictEqual(r.sinHoras, ['maquina-nb']);
  const html = WD().htmlResumen(r, 'es');
  assert.match(html, /maquina-nb[^<]*sube ejecuciones pero no horas/);
  assert.match(html, /↑/, 'esta semana trabajó más que la anterior');
});

test('OH5 DiaADia_PorPersona — la tabla diaria plegada tiene una fila por persona y «no medido» donde no hubo horas', () => {
  const maquinas = { 'maquina-a': { '2026-11-09': dia('2026-11-09'), '2026-11-08': dia('2026-11-08') }, 'maquina-b': { '2026-11-09': dia('2026-11-09') }, 'maquina-c': { '2026-11-07': dia('2026-11-07') } };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  const r = WD().resumen(t, PEOPLE);
  const html = WD().htmlDiaPorPersona(t, r, 'es');
  const fila = (p) => (html.match(new RegExp(`<tr><th scope="row">${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</th>(.*?)</tr>`)) || [])[1] || '';
  const celdas = (f) => [...f.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
  assert.deepStrictEqual(celdas(fila('ana@acme.example')).slice(0, 3), ['2.0 h', '1.0 h', 'no medido'], 'ana: las dos máquinas suman el 9');
  assert.deepStrictEqual(celdas(fila('beto@acme.example')).slice(0, 3), ['no medido', 'no medido', '1.0 h']);
});

// ── O-horas, parte 3: el costo estimado por modelo (los días de la versión 2 traen el reparto) ─────────────────────────

const dia2 = (d, porModelo, opts = {}) => {
  const base = dia(d, opts);
  const suma = (k) => Object.values(porModelo).reduce((a, m) => a + m[k], 0);
  return { ...base, v: 2, tokens: { lectura: suma('lectura'), escritura: suma('escritura'), cache: suma('cache'), medido: true, por_modelo: porModelo } };
};
const PRECIOS = {
  'claude-opus-5-5': { lectura: 4, escritura: 20, cache: 0.2, fuente: 'https://precios.example/claude', fecha: '2026-11-27' },
  'gpt-5.6-terra': { lectura: 2, escritura: 12, cache: 0.2, fuente: 'https://precios.example/openai', fecha: '2026-11-27' },
};

test('OH10 Costo_V1yV2_EstimadoNuncaCero — la versión 1 dice «sin dato de modelo», un modelo sin precio lo dice, y lo medido suma «estimado»', () => {
  const M = 1e6;
  const maquinas = {
    // ana: dos días de la versión 2 con precio: 1 M de lectura y 0,1 M de escritura de opus = 4 + 2 = US$ 6 por día
    'maquina-a': { '2026-11-09': dia2('2026-11-09', { 'claude-opus-5-5': { lectura: M, escritura: 0.1 * M, cache: 0 } }), '2026-11-08': dia2('2026-11-08', { 'claude-opus-5-5': { lectura: M, escritura: 0.1 * M, cache: 0 } }) },
    // ana, la otra máquina: un día de la versión 1, sin reparto
    'maquina-b': { '2026-11-09': dia('2026-11-09') },
    // beto: sólo un modelo sin precio
    'maquina-c': { '2026-11-09': dia2('2026-11-09', { 'kimi-k2.7-code:cloud': { lectura: M, escritura: M, cache: 0 } }) },
    // maquina-d: sólo la versión 1
    'maquina-d': { '2026-11-09': dia('2026-11-09') },
  };
  const jornadas = WD().leerJornadas(espejo(maquinas));
  assert.ok(jornadas.maquinas['maquina-a']['2026-11-09'].ok, 'la versión 2 se entiende');
  assert.ok(jornadas.maquinas['maquina-b']['2026-11-09'].ok, 'la versión 1 se sigue entendiendo');
  const t = WD().armarTabla(jornadas, { ayer: '2026-11-09' });
  const r = WD().resumen(t, PEOPLE, PRECIOS);
  const fila = (p) => r.personas.find((x) => x.persona === p);
  assert.strictEqual(fila('ana@acme.example').costo.usd, 12, 'los dos días con precio');
  assert.strictEqual(fila('ana@acme.example').costo.sinModelo, 1, 'el día de la versión 1 se cuenta aparte, no como cero');
  assert.strictEqual(fila('beto@acme.example').costo.usd, null, 'sin ningún precio no hay costo, ni cero');
  assert.deepStrictEqual(fila('beto@acme.example').costo.sinPrecio, ['kimi-k2.7-code:cloud']);
  assert.strictEqual(fila('maquina-d').costo.usd, null);
  assert.strictEqual(r.semana.costo.usd, 12);
  const html = WD().htmlResumen(r, 'es');
  assert.match(html, /US\$\s?12\.00 estimado/, 'la ficha dice «estimado»');
  assert.match(html, /sin precio para kimi-k2\.7-code:cloud/);
  assert.match(html, /sin dato de modelo/);
  assert.doesNotMatch(html, /US\$\s?0\.00/, 'nada sin medir sale en cero');
  // sin tabla de precios: todo dice que no hay precio, nunca cero
  const sinTabla = WD().htmlResumen(WD().resumen(t, PEOPLE, null), 'es');
  assert.doesNotMatch(sinTabla, /US\$/);
  assert.match(sinTabla, /sin precio para claude-opus-5-5/);
  // en inglés también dice «estimated»
  assert.match(WD().htmlResumen(r, 'en'), /US\$\s?12\.00 estimated/);
});

test('OH11 Costo_DiaV2RaroYSinModelo — un reparto mal formado es un archivo raro; los tokens sin modelo cuentan como sin dato', () => {
  const malo = dia2('2026-11-09', { 'claude-opus-5-5': { lectura: -1, escritura: 0, cache: 0 } });
  assert.strictEqual(WD().validarDia(malo, '2026-11-09').ok, false);
  assert.strictEqual(WD().validarDia({ ...dia('2026-11-09'), v: 3 }, '2026-11-09').ok, false, 'una versión que no se conoce');
  const maquinas = { 'maquina-a': { '2026-11-09': dia2('2026-11-09', { 'claude-opus-5-5': { lectura: 1e6, escritura: 0, cache: 0 }, sin_modelo: { lectura: 5, escritura: 0, cache: 0 } }) } };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  const c = WD().resumen(t, PEOPLE, PRECIOS).personas[0].costo;
  assert.strictEqual(c.usd, 4, 'la parte con modelo y precio');
  assert.strictEqual(c.sinModelo, 1, 'y el día se marca con tokens sin modelo');
});

test('OH14 Costo_RepartoQueNoSuma_SinDatoYLasHorasQuedan — un reparto que no da los totales no vale como costo, ni en cero; las horas se ven igual', () => {
  const noSuma = { ...dia2('2026-11-09', { 'claude-opus-5-5': { lectura: 1e6, escritura: 0, cache: 0 } }) };
  noSuma.tokens = { ...noSuma.tokens, lectura: 5e6 };
  const vacio = dia2('2026-11-08', {});
  vacio.tokens = { ...vacio.tokens, lectura: 5e6 };
  const maquinas = { 'maquina-a': { '2026-11-09': noSuma, '2026-11-08': vacio } };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  assert.strictEqual(t.celdas['2026-11-09']['maquina-a'].estado, 'medido', 'el día se lee, con sus horas');
  const r = WD().resumen(t, PEOPLE, PRECIOS);
  const c = r.personas[0].costo;
  assert.strictEqual(c.usd, null);
  assert.strictEqual(c.sinModelo, 2);
  assert.doesNotMatch(WD().htmlResumen(r, 'es'), /US\$/);
});

test('OH15 Costo_DiasSinModelo_SonDiasNoMaquinas — dos máquinas de una persona sin reparto el mismo día son un día', () => {
  const maquinas = { 'maquina-a': { '2026-11-09': dia('2026-11-09') }, 'maquina-b': { '2026-11-09': dia('2026-11-09') } };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  const r = WD().resumen(t, PEOPLE, PRECIOS);
  assert.strictEqual(r.personas.find((x) => x.persona === 'ana@acme.example').costo.sinModelo, 1);
});

// ── O-horas-cache: la escritura de caché con su precio propio ──────────────────────────────────────────────────────

test('OH17 Costo_EscrituraDeCache_ConSuPrecio — se cobra con el precio de su plazo; sin ese precio no se cuenta como entrada, se dice', () => {
  const M = 1e6;
  const repartoOpus = { 'claude-opus-5-5': { lectura: 3 * M, escritura: 0, cache: 0, cache_escrita_5m: M, cache_escrita_1h: M } };
  const maquinas = { 'maquina-a': { '2026-11-09': dia2('2026-11-09', repartoOpus) } };
  const t = WD().armarTabla(WD().leerJornadas(espejo(maquinas)), { ayer: '2026-11-09' });
  // 1 M de entrada a 4 + 1 M de 5 minutos a 5 + 1 M de 1 hora a 8 = 17
  const conPrecio = { 'claude-opus-5-5': { ...PRECIOS['claude-opus-5-5'], cache_escrita_5m: 5, cache_escrita_1h: 8 } };
  assert.strictEqual(WD().resumen(t, PEOPLE, conPrecio).personas[0].costo.usd, 17);
  // sin el precio de la escritura de caché: sólo la entrada, y lo que falta se dice
  const c = WD().resumen(t, PEOPLE, PRECIOS).personas[0].costo;
  assert.strictEqual(c.usd, 4);
  assert.deepStrictEqual(c.sinPrecio, []);
  assert.deepStrictEqual(c.sinPrecioCache, ['claude-opus-5-5']);
  assert.match(WD().htmlResumen(WD().resumen(t, PEOPLE, PRECIOS), 'es'), /sin precio de escritura de caché para claude-opus-5-5/);
  assert.match(WD().htmlResumen(WD().resumen(t, PEOPLE, PRECIOS), 'en'), /no cache-write price for claude-opus-5-5/);
  // una escritura de caché mayor que la lectura no cierra: sin dato de modelo, y el día se lee igual
  const malo = dia2('2026-11-08', { 'claude-opus-5-5': { lectura: 10, escritura: 0, cache: 0, cache_escrita_1h: 11 } });
  const v = WD().validarDia(malo, '2026-11-08');
  assert.ok(v.ok);
  assert.strictEqual(v.tokens.porModelo, null);
});

// 🔴 Falla con (A123, recorrido F21): en «Ver por máquina» la fecha de cada fila se partía en dos renglones, y la página
//    mezclaba tres formatos de fecha (año-mes-día, día/mes y mes-día).
test('A123 Horas_LasFechasNoSeParten_YDiaPorDiaComoLosGraficos', () => {
  const t = WD().armarTabla(WD().leerJornadas(espejo({ 'maquina-a': Object.fromEntries(DIAS5.map((d) => [d, dia(d)])) })), { ayer: '2026-11-09' });
  const r = WD().resumen(t, {});
  const html = WD().htmlDiaPorPersona(t, r, 'es');
  assert.match(html, /<th>09\/11<\/th>/, 'el día como en los gráficos: día/mes');
  assert.doesNotMatch(html, /<th>11-09<\/th>/);
  const css = fs.readFileSync(path.join(SITE, 'static', 'site.css'), 'utf8');
  assert.match(css, /table\.horas th\[scope="?row"?\][^{]*\{[^}]*white-space:nowrap/, 'la fecha de cada fila no se parte');
});
