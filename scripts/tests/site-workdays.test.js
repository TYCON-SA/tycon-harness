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
    '2026-11-06': { ...dia('2026-11-06'), v: 2 }, '2026-11-07': sinCampo, '2026-11-08': negativo, '2026-11-05': '{roto', '2026-11-09': dia('2026-11-09'),
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
