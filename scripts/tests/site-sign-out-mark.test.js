'use strict';
/*
 * site-sign-out-mark.test.js — «Salir» no vuelve a entrar solo: la salida se queda en el sitio y la marca de «salió».
 *
 * T1 Salir_DetrasDelCandado_VaDirectoASaliste       T2 Salir_SinCandado_VaASaliste
 * T3 ConMarca_SinSesion_MuestraSaliste              T4 ConMarca_Api_Sigue401
 * T5 ConMarca_Entrar_PideElegirCuenta               T6 EntrarBien_BorraLaMarca
 * T7 IngresoRechazado_DejaLaMarca                   T8 Marca_SinDatosYConSusAtributos
 * T9 Guia_SalirNoPasaPorMicrosoft                 T11 Salir_DesdeOtroSitio_403AunSinSesion
 * T12 ConMarca_DosPuertas_SalisteOfreceLasPuertas   T13 ConMarca_PostSinSesion_NoMuestraSaliste
 *
 * El sitio corre en este proceso contra un emisor OIDC local; el disco es una carpeta temporal.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { arrancarEmisor, arrancarEmisorMicrosoft } = require('./lib/fake-oidc.js');
const H = require('./lib/site-harness.js');

const ROOT = path.join(__dirname, '..', '..');
const LEAD = 'lead@acme.example';
const ORIGEN = 'http://127.0.0.1';
const FORM = 'application/x-www-form-urlencoded';
const MARCA = '__Host-salio=1';
const config = () => ({ version: 1, owners: { default: LEAD }, site: { maintainers: [LEAD] } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'site-sign-out-mark-'));
const limpiar = (d) => { try { fs.chmodSync(d, 0o700); } catch { /* ya no está */ } fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };

async function conSitio(fn, { disco = true } = {}) {
  const emisor = await arrancarEmisor();
  const dir = disco ? tmp() : null;
  const h = await H.arrancarSitio({ env: H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...(dir ? { SITE_DATA_DIR: dir } : {}) }), fuentes: H.fuentesFijas({ config: config() }) });
  try { await fn({ h, emisor, dir }); } finally { await h.cerrar(); await emisor.cerrar(); if (dir) limpiar(dir); }
}
/** El sitio con dos puertas (Microsoft con la de los invitados). */
async function conDosPuertas(fn) {
  const emisor = await arrancarEmisorMicrosoft();
  let h = null;
  try {
    h = await H.arrancarSitio({ env: H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: '11111111-2222-4333-8444-555555555555', SITE_OIDC_ISSUER: emisor.issuer }), fuentes: H.fuentesFijas({ config: config() }) });
    await fn({ h, emisor });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}
const entrar = async (h, emisor) => (await H.ingresar(h, emisor, { sub: 's-lead', email: LEAD, email_verified: true })).sesion;
/** «Salir» como lo manda el botón: el origen del sitio y el token de la sesión que trae la barra. */
async function salir(h, sesion, headers = {}) {
  const barra = await h.pedir('/', { cookie: sesion });
  const tok = /name="tok" value="([^"]+)"/.exec(barra.texto)[1];
  return h.pedir('/auth/logout', { method: 'POST', cookie: sesion, headers: { origin: ORIGEN, 'content-type': FORM, ...headers }, body: new URLSearchParams({ tok }).toString() });
}
const setCookies = (r) => [].concat(r.headers['set-cookie'] || []);
const marcaDe = (r) => setCookies(r).find((c) => c.startsWith('__Host-salio='));
const esSaliste = (p) => p.status === 200 && p.headers.location === undefined && p.texto.includes('Entrar de nuevo') && p.texto.includes('/auth/login?otra=1');
/** El viaje del inicio desde `/auth/login` con la marca puesta: devuelve la vuelta del sitio. */
async function entrarConMarca(h, emisor, { state } = {}) {
  const ida = await h.pedir('/auth/login', { cookie: MARCA });
  assert.strictEqual(ida.status, 302, 'con la marca, /auth/login va al emisor');
  const loc = new URL(ida.headers.location);
  const code = emisor.emitirCodigo({ claims: { sub: 's-lead', email: LEAD, email_verified: true }, nonce: loc.searchParams.get('nonce'), challenge: loc.searchParams.get('code_challenge') });
  const intento = `__Host-login=${ida.cookies['__Host-login'].valor}`;
  return h.pedir(`/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || loc.searchParams.get('state'))}`, { cookie: `${intento}; ${MARCA}` });
}

test('T1 Salir_DetrasDelCandado_VaDirectoASaliste @story-2.51 @ac-1', async () => {
  await conSitio(async ({ h, emisor }) => {
    const sesion = await entrar(h, emisor);
    const r = await salir(h, sesion, { 'X-MS-CLIENT-PRINCIPAL-NAME': LEAD });
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/saliste', 'la salida no sale del sitio');
    assert.match(setCookies(r).join('\n'), /__Host-site=;[^\n]*Max-Age=0/, 'borra la sesión');
    assert.ok(marcaDe(r), 'deja la marca de «salió»');
  });
});

test('T2 Salir_SinCandado_VaASaliste @story-2.51 @ac-2', async () => {
  await conSitio(async ({ h, emisor }) => {
    const r = await salir(h, await entrar(h, emisor));
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/saliste');
    assert.ok(marcaDe(r), 'deja la marca');
  });
  // sin disco la sesión no se puede anotar cerrada: igual se queda en el sitio y deja la marca
  await conSitio(async ({ h, emisor }) => {
    const r = await salir(h, await entrar(h, emisor), { 'X-MS-CLIENT-PRINCIPAL-NAME': LEAD });
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.location, '/saliste?sin_invalidar=1');
    assert.ok(marcaDe(r), 'deja la marca');
  }, { disco: false });
});

test('T3 ConMarca_SinSesion_MuestraSaliste @story-2.51 @ac-3', async () => {
  await conSitio(async ({ h }) => {
    for (const ruta of ['/', '/corridas', '/no-existe-esto']) {
      const p = await h.pedir(ruta, { cookie: MARCA });
      assert.ok(esSaliste(p), `${ruta}: «Saliste» sin redirigir (status ${p.status}, location ${p.headers.location})`);
    }
    assert.strictEqual((await h.pedir('/')).status, 302, 'sin la marca, como hoy');
  });
  await conDosPuertas(async ({ h }) => {
    const p = await h.pedir('/', { cookie: MARCA });
    assert.strictEqual(p.status, 200, 'con dos puertas, sin redirigir');
    assert.strictEqual(p.headers.location, undefined);
    assert.ok(p.texto.includes('Cerraste la sesión') && p.texto.includes('/auth/login?otra=1'), 'es «Saliste», no la página de las puertas');
  });
});

test('T4 ConMarca_Api_Sigue401 @story-2.51 @ac-3', async () => {
  await conSitio(async ({ h }) => {
    const a = await h.pedir('/api/inicio', { cookie: MARCA, headers: { accept: 'application/json' } });
    assert.strictEqual(a.status, 401);
    assert.strictEqual(a.json && a.json.codigo, 'sesion_vencida');
  });
});

test('T5 ConMarca_Entrar_PideElegirCuenta @story-2.51 @ac-4', async () => {
  const prompt = (r) => new URL(r.headers.location).searchParams.get('prompt');
  await conSitio(async ({ h }) => {
    for (const ruta of ['/auth/login', '/auth/login?otra=1']) {
      const r = await h.pedir(ruta, { cookie: MARCA });
      assert.strictEqual(r.status, 302, ruta);
      assert.strictEqual(prompt(r), 'select_account', `${ruta}: con la marca pide elegir la cuenta`);
    }
    assert.strictEqual(prompt(await h.pedir('/auth/login')), null, 'sin la marca, /auth/login sin prompt');
  });
  await conDosPuertas(async ({ h }) => {
    const r = await h.pedir('/auth/login?via=invitado', { cookie: MARCA });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(prompt(r), 'select_account', 'la puerta de los invitados también');
  });
});

test('T6 EntrarBien_BorraLaMarca @story-2.51 @ac-5', async () => {
  await conSitio(async ({ h, emisor }) => {
    const vuelta = await entrarConMarca(h, emisor);
    assert.strictEqual(vuelta.status, 302, 'entra');
    assert.ok(vuelta.cookies['__Host-site'] && vuelta.cookies['__Host-site'].valor, 'crea la sesión');
    const m = marcaDe(vuelta);
    assert.ok(m && /Max-Age=0/.test(m), 'borra la marca');
    assert.strictEqual((await h.pedir('/')).status, 302, 'después, sin sesión, va al emisor como hoy');
  });
});

test('T7 IngresoRechazado_DejaLaMarca @story-2.51 @ac-5', async () => {
  await conSitio(async ({ h, emisor }) => {
    const vuelta = await entrarConMarca(h, emisor, { state: 'otro-state' });
    assert.strictEqual(vuelta.status, 400, 'rechazado');
    assert.strictEqual(marcaDe(vuelta), undefined, 'no toca la marca');
    assert.ok(esSaliste(await h.pedir('/', { cookie: MARCA })), 'sigue mostrando «Saliste»');
  });
});

test('T8 Marca_SinDatosYConSusAtributos @story-2.51 @ac-6', async () => {
  await conSitio(async ({ h, emisor }) => {
    const sesion = await entrar(h, emisor);
    const r = await salir(h, sesion);
    const m = marcaDe(r);
    assert.ok(m, 'la marca');
    const partes = m.split(';').map((s) => s.trim());
    assert.strictEqual(partes[0], MARCA, 'valor fijo, sin datos');
    for (const a of ['Max-Age=2592000', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(partes.includes(a), `lleva ${a}`);
    assert.ok(!partes.some((p) => /^Domain=/i.test(p)), 'sin Domain');
    assert.ok(!m.includes(LEAD) && !m.includes(sesion.split('=')[1].slice(0, 20)), 'ni el correo ni la sesión');
  });
});

test('T11 Salir_DesdeOtroSitio_403AunSinSesion @story-2.51 @ac-9', async () => {
  await conSitio(async ({ h, emisor }) => {
    // desde otro sitio el navegador no manda la cookie SameSite=Lax: el sitio no ve sesión
    const ajeno = { origin: 'https://otro.example', 'content-type': FORM };
    const sin = await h.pedir('/auth/logout', { method: 'POST', headers: ajeno, body: '' });
    assert.strictEqual(sin.status, 403, 'sin sesión y de otro origen: 403');
    assert.deepStrictEqual(setCookies(sin), [], 'no borra ni deja ninguna cookie');
    const sesion = await entrar(h, emisor);
    const con = await h.pedir('/auth/logout', { method: 'POST', cookie: sesion, headers: ajeno, body: '' });
    assert.strictEqual(con.status, 403, 'con sesión y de otro origen: 403');
    assert.strictEqual(marcaDe(con), undefined, 'sin la marca');
    assert.strictEqual((await h.pedir('/', { cookie: sesion })).status, 200, 'la sesión sigue');
    // sin sesión y desde el sitio (una pestaña vieja), sale como siempre
    const vieja = await h.pedir('/auth/logout', { method: 'POST', headers: { origin: ORIGEN, 'content-type': FORM }, body: '' });
    assert.strictEqual(vieja.status, 303);
    assert.ok(marcaDe(vieja), 'deja la marca');
  });
});

test('T12 ConMarca_DosPuertas_SalisteOfreceLasPuertas @story-2.51 @ac-10', async () => {
  await conDosPuertas(async ({ h }) => {
    for (const ruta of ['/', '/saliste']) {
      const p = await h.pedir(ruta, { cookie: MARCA });
      assert.strictEqual(p.status, 200, ruta);
      assert.match(p.texto, /href="\/auth\/login"/, `${ruta}: la puerta principal`);
      assert.match(p.texto, /href="\/auth\/login\?via=invitado"/, `${ruta}: la puerta de los invitados`);
      assert.ok(p.texto.includes('Soy invitado'), `${ruta}: con el texto de la puerta`);
      assert.match(p.texto, /href="\/auth\/login\?otra=1"/, `${ruta}: otra cuenta`);
    }
    const r = await h.pedir('/auth/login?via=invitado', { cookie: MARCA });
    assert.strictEqual(new URL(r.headers.location).searchParams.get('prompt'), 'select_account');
  });
});

test('T13 ConMarca_PostSinSesion_NoMuestraSaliste @story-2.51 @ac-11', async () => {
  await conSitio(async ({ h }) => {
    const sinMarca = await h.pedir('/', { method: 'POST', headers: { origin: ORIGEN, 'content-type': FORM }, body: '' });
    const conMarca = await h.pedir('/', { method: 'POST', cookie: MARCA, headers: { origin: ORIGEN, 'content-type': FORM }, body: '' });
    assert.strictEqual(conMarca.status, sinMarca.status, 'la misma respuesta que sin la marca');
    assert.ok(!esSaliste(conMarca), 'no es «Saliste»');
    const head = await h.pedir('/', { method: 'HEAD', cookie: MARCA });
    assert.strictEqual(head.status, 200, 'HEAD sí: como el GET');
    assert.strictEqual(head.headers.location, undefined);
  });
});

test('T9 Guia_SalirNoPasaPorMicrosoft @story-2.51 @ac-7', () => {
  // con los cortes de línea de la guía vueltos un espacio: una frase puede partirse en dos renglones
  const es = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.md'), 'utf8').replace(/\s+/g, ' ');
  const en = fs.readFileSync(path.join(ROOT, 'guides', 'organization-site.en.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(es, /«Salir» no pasa por el candado de la plataforma ni por Microsoft/);
  assert.match(es, /no vuelve a entrar sin un clic/);
  assert.match(es, /elegir la cuenta/);
  assert.match(es, /la sesión de Microsoft (sigue|queda)/);
  assert.match(en, /\*\*Sign out\*\* does not go through the platform's lock or through Microsoft/);
  assert.match(en, /does not sign you back in without a click/);
  assert.match(en, /choose the account/);
  assert.match(en, /Microsoft session (stays|remains)/);
  assert.ok(!/la vuelta pasa antes por el cierre de ese candado/.test(es), 'la frase vieja sale');
  assert.ok(!/goes first through that lock's own sign-out/.test(en), 'the old sentence goes');
});
