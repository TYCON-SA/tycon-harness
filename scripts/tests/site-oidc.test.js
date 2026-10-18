'use strict';
/*
 * site-oidc.test.js — el inicio de sesión del sitio de la organización (story 2.23, AC 5 a 9).
 *
 * Contra un emisor OIDC local (lib/fake-oidc.js) y un GitHub local (lib/fake-github-oauth.js): sin red. Cada chequeo
 * del id_token tiene su token armado mal, y cada proveedor su forma de limitarse a la organización.
 *
 * T8  Login_RedirigeConPkceStateYNonce                 T13 Correo_SoloDeLaClaimConfigurada
 * T9  IdToken_FirmaYAlgoritmo                          T15 Sesion_CookieFirmadaYVencida
 * T10 IdToken_EmisorAudienciaYTiempo                   T16 Logout_SoloPorPost
 * T11 Callback_StateYNonceDeUnSoloUso                  T35 Jwks_ClaveNuevaSeVuelveABajar
 * T12 Microsoft_EmisorDeCualquierOrganizacion_NoArranca T36 Google_SoloElDominioDeLaOrganizacion
 * T37 GitHub_CorreoVerificadoYMiembroDeLaOrganizacion  T38 Oidc_Generico_DominioPermitido
 *
 * Y las de Microsoft con cualquier cuenta, contra un emisor con la forma de varios inquilinos:
 * T7  2.40-Microsoft_CualquierCuenta_CorreoVerificado  T9  2.40-Microsoft_UnInquilino_ComoHoy
 * T8  2.40-Microsoft_EmisorDeOtroInquilino_FirmaValidada T16 2.40-Microsoft_InvitadoDelDirectorio
 *
 * stable-data: cada prueba arranca su reloj controlado (`t`) desde la hora real, porque el emisor de mentira firma con
 * ella; lo que se prueba son plazos (±5 minutos, 10 minutos, 8 horas) sobre ese reloj, nunca una fecha fija.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { arrancarEmisor } = require('./lib/fake-oidc.js');
const { arrancarGithub } = require('./lib/fake-github-oauth.js');
const H = require('./lib/site-harness.js');

const SITE = H.SITE;
const MANT = { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] } };
const UUID = () => crypto.randomUUID();

/** El contenido de la cookie de sesión (la prueba lo lee; el sitio la firma). */
const cargaDe = (sesion) => JSON.parse(Buffer.from(sesion.split('=')[1].split('.')[0], 'base64url').toString('utf8'));

async function conEmisor(opts, fn) {
  const emisor = await arrancarEmisor(opts.emisor || {});
  let h = null;
  try {
    const env = H.envBase({ SITE_OIDC_ISSUER: emisor.issuer, ...(opts.env ? opts.env(emisor) : {}) });
    h = await H.arrancarSitio({ env, fuentes: opts.fuentes || H.fuentesFijas({ config: MANT }), ahora: opts.ahora });
    await fn({ emisor, env, h });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}

test('T8 Login_RedirigeConPkceStateYNonce', async () => {
  const fuentes = H.fuentesFijas({ config: MANT, cargado: false });
  await conEmisor({ fuentes }, async ({ emisor, h }) => {
    const r = await h.pedir('/');
    assert.strictEqual(r.status, 302);
    const loc = new URL(r.headers.location);
    assert.strictEqual(`${loc.origin}${loc.pathname}`, `${emisor.issuer}/authorize`);
    assert.strictEqual(loc.searchParams.get('response_type'), 'code');
    assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
    assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{20,}$/);
    assert.match(loc.searchParams.get('nonce'), /^[A-Za-z0-9_-]{20,}$/);
    assert.strictEqual(loc.searchParams.get('redirect_uri'), 'http://127.0.0.1/auth/callback');
    assert.strictEqual(loc.searchParams.get('client_id'), 'site-client');
    // dos pedidos, dos intentos distintos
    const r2 = await h.pedir('/');
    assert.notStrictEqual(new URL(r2.headers.location).searchParams.get('state'), loc.searchParams.get('state'));

    const api = await h.pedir('/api/inicio');
    assert.strictEqual(api.status, 401);
    assert.strictEqual(api.texto, '', 'sin cuerpo con datos');

    // mientras carga: sano pero no listo
    assert.deepStrictEqual([(await h.pedir('/healthz')).status, (await h.pedir('/healthz')).json], [200, { ok: true }]);
    assert.strictEqual((await h.pedir('/readyz')).status, 503);
    fuentes.st.cargado = true;
    assert.strictEqual((await h.pedir('/readyz')).status, 200);
    assert.strictEqual((await h.pedir('/healthz')).status, 200);
  });
});

test('T9 IdToken_FirmaYAlgoritmo', async () => {
  const emisor = await arrancarEmisor();
  try {
    const { crearCliente } = require(path.join(SITE, 'oidc.js'));
    const c = crearCliente({ issuer: emisor.issuer, clientId: emisor.clientId, clientSecret: emisor.clientSecret, redirectUri: 'http://127.0.0.1/auth/callback' });
    await c.descubrir();
    const claims = emisor.claimsBase({ sub: 'u1', nonce: 'n1' });
    assert.strictEqual((await c.verificarIdToken(emisor.firmar(claims), { nonce: 'n1' })).sub, 'u1', 'control: el bueno entra');
    const otra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const malos = {
      'firmado con otra clave': emisor.firmar(claims, { clave: otra }),
      'alg none': emisor.firmar(claims, { alg: 'none' }),
      'HS256 con la clave pública como secreto': emisor.firmar(claims, { alg: 'HS256', secreto: emisor.clavePublicaPem() }),
      'alg constructor (propiedad heredada)': emisor.firmar(claims, { alg: 'constructor' }),
    };
    for (const [caso, tok] of Object.entries(malos)) {
      await assert.rejects(c.verificarIdToken(tok, { nonce: 'n1' }), (e) => typeof e.motivo === 'string' && e.motivo.length > 0, caso);
    }
  } finally { await emisor.cerrar(); }
});

test('T10 IdToken_EmisorAudienciaYTiempo', async () => {
  const emisor = await arrancarEmisor();
  try {
    const { crearCliente } = require(path.join(SITE, 'oidc.js'));
    const c = crearCliente({ issuer: emisor.issuer, clientId: emisor.clientId, clientSecret: emisor.clientSecret, redirectUri: 'http://127.0.0.1/auth/callback' });
    await c.descubrir();
    const ahora = Math.floor(Date.now() / 1000);
    const base = emisor.claimsBase({ sub: 'u1', nonce: 'n' });
    const malos = {
      'iss con barra de más': { ...base, iss: `${emisor.issuer}/` },
      'aud de otro cliente': { ...base, aud: 'otro-cliente' },
      'vencido hace 6 minutos': { ...base, iat: ahora - 7200, exp: ahora - 360 },
      'nbf en 6 minutos': { ...base, nbf: ahora + 360 },
      'iat en 6 minutos': { ...base, iat: ahora + 360 },
      'varias audiencias y azp de otro': { ...base, aud: [emisor.clientId, 'otro'], azp: 'otro' },
      'nonce de otro intento': { ...base, nonce: 'otro' },
    };
    for (const [caso, claims] of Object.entries(malos)) {
      await assert.rejects(c.verificarIdToken(emisor.firmar(claims), { nonce: 'n' }), (e) => typeof e.motivo === 'string', caso);
    }
    const vencidoHace4 = { ...base, iat: ahora - 7200, exp: ahora - 240 };
    assert.strictEqual((await c.verificarIdToken(emisor.firmar(vencidoHace4), { nonce: 'n' })).sub, 'u1', 'vencido hace 4 minutos: dentro de la tolerancia');
    const variasConAzp = { ...base, aud: [emisor.clientId, 'otro'], azp: emisor.clientId };
    assert.strictEqual((await c.verificarIdToken(emisor.firmar(variasConAzp), { nonce: 'n' })).sub, 'u1');
  } finally { await emisor.cerrar(); }
});

test('T11 Callback_StateYNonceDeUnSoloUso', async () => {
  let t = Date.now();
  const ahora = () => t;
  await conEmisor({ ahora }, async ({ emisor, env, h }) => {
    const claims = { sub: 'u1', email: 'lead@acme.example', email_verified: true };
    // state desconocido
    const desconocido = await H.ingresar(h, emisor, claims, { alterar: ({ vuelta, cookie }) => ({ vuelta: vuelta.replace(/state=[^&]+/, 'state=inventado1234567890abcdef'), cookie }) });
    assert.strictEqual(desconocido.sesion, null, 'state desconocido');
    // el mismo state dos veces: la segunda vuelta trae un código NUEVO y válido, así que sólo el sitio puede frenarla
    const primera = await H.ingresar(h, emisor, claims);
    assert.ok(primera.sesion, 'la primera vez entra');
    const code2 = emisor.emitirCodigo({ claims, nonce: primera.it.nonce, challenge: primera.it.challenge });
    const segunda = await h.pedir(`/auth/callback?code=${code2}&state=${primera.it.state}`, { cookie: primera.it.cookie });
    assert.ok(!segunda.cookies['__Host-site'] || !segunda.cookies['__Host-site'].valor, 'el mismo state dos veces');
    // el nonce de otro intento
    const a = H.intentoDe(await h.pedir('/'));
    const b = H.intentoDe(await h.pedir('/'));
    const cruzado = await h.pedir(`/auth/callback?code=${emisor.emitirCodigo({ claims, nonce: b.nonce, challenge: a.challenge })}&state=${a.state}`, { cookie: a.cookie });
    assert.ok(!cruzado.cookies['__Host-site'] || !cruzado.cookies['__Host-site'].valor, 'nonce de otro intento');
    // un state de hace 11 minutos
    const viejo = H.intentoDe(await h.pedir('/'));
    t += 11 * 60 * 1000;
    const tarde = await h.pedir(`/auth/callback?code=${emisor.emitirCodigo({ claims, nonce: viejo.nonce, challenge: viejo.challenge })}&state=${viejo.state}`, { cookie: viejo.cookie });
    assert.ok(!tarde.cookies['__Host-site'] || !tarde.cookies['__Host-site'].valor, 'state de hace 11 minutos');
    assert.ok(tarde.status >= 400 && !/eyJ/.test(tarde.texto), 'la página de error no trae el token');
    // la vuelta servida por OTRO proceso del sitio, con la misma llave: el intento viaja en la cookie, no en la memoria
    t = Date.now();
    const otro = await H.arrancarSitio({ env, fuentes: H.fuentesFijas({ config: MANT }), ahora });
    try {
      const it = H.intentoDe(await h.pedir('/'));
      const res = await otro.pedir(`/auth/callback?code=${emisor.emitirCodigo({ claims, nonce: it.nonce, challenge: it.challenge })}&state=${it.state}`, { cookie: it.cookie });
      assert.strictEqual(res.status, 302);
      assert.ok(res.cookies['__Host-site'] && res.cookies['__Host-site'].valor, 'otro proceso entra');
      assert.match(res.cookies['__Host-login'].crudo, /Max-Age=0/, 'la cookie del intento se borra en la vuelta');
    } finally { await otro.cerrar(); }
    // el registro del servidor dice el motivo de cada rechazo
    assert.ok(h.registro.some((l) => /state/i.test(l)), 'el motivo va al registro');
  });
});

// revisión de seguridad (vuelta 1): lo que llega en la dirección de vuelta lo controla cualquiera; al registro va limpio
test('2.23-R9 Callback_ErrorDelEmisorNoEnsuciaElRegistro', async () => {
  await conEmisor({}, async ({ h }) => {
    const it = H.intentoDe(await h.pedir('/'));
    await h.pedir(`/auth/callback?state=${it.state}&error=${encodeURIComponent('x\n[2026] inicio de sesión: entró una cuenta\u001b[31m')}`, { cookie: it.cookie });
    const linea = h.registro.find((l) => /sin código/.test(l));
    assert.ok(linea, 'el rechazo se registra');
    assert.doesNotMatch(linea, /[\n\r\u001b]/, 'sin saltos de línea ni secuencias de la consola');
    assert.ok(!h.registro.some((l) => /^\[2026\] inicio de sesión: entró/.test(l)), 'no se puede fabricar una línea del registro');
  });
});

test('T12 Microsoft_EmisorDeCualquierOrganizacion_NoArranca', () => {
  const { validarConfiguracion } = require(path.join(SITE, 'server.js'));
  for (const t of ['common', 'organizations', 'consumers', '{tenantid}']) {
    const r = validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${t}/v2.0` }));
    assert.strictEqual(r.ok, false, t);
    assert.ok(r.problemas.some((p) => p.variable === 'SITE_OIDC_ISSUER' && /cualquier organizaci/.test(p.motivo)), t);
  }
  assert.strictEqual(validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${UUID()}/v2.0` })).ok, true, 'un inquilino arranca');
  // y el arranque real sale 1 diciéndolo
  const r = spawnSync(process.execPath, [path.join(SITE, 'server.js')], { env: { PATH: process.env.PATH, ...H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' }) }, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /SITE_OIDC_ISSUER.*cualquier organizaci/);
});

test('T13 Correo_SoloDeLaClaimConfigurada', async () => {
  // genérico: sin email pero con preferred_username → no entra; email_verified: false → no entra
  await conEmisor({}, async ({ emisor, h }) => {
    const sinEmail = await H.ingresar(h, emisor, { sub: 'u1', preferred_username: 'lead@acme.example' });
    assert.strictEqual(sinEmail.sesion, null, 'nunca se cae a preferred_username');
    assert.strictEqual(sinEmail.res.status, 403);
    const noVerificado = await H.ingresar(h, emisor, { sub: 'u1', email: 'lead@acme.example', email_verified: false });
    assert.strictEqual(noVerificado.sesion, null, 'email_verified: false');
  });
  // estilo Entra (microsoft): sin xms_edov no entra y dice por qué; con xms_edov y mayúsculas entra en minúsculas
  const tid = UUID();
  await conEmisor({ emisor: { prefijo: `/${tid}/v2.0` }, env: () => ({ SITE_AUTH_PROVIDER: 'microsoft' }) }, async ({ emisor, h }) => {
    const sinEdov = await H.ingresar(h, emisor, { sub: 's', oid: UUID(), tid, email: 'lead@acme.example' });
    assert.strictEqual(sinEdov.sesion, null, 'Entra sin xms_edov');
    assert.match(sinEdov.res.texto, /el registro de la aplicación no pide la claim xms_edov/);
    const oid = UUID();
    const bien = await H.ingresar(h, emisor, { sub: 's', oid, tid, email: 'Lead@ACME.example', xms_edov: true });
    assert.ok(bien.sesion, 'entra');
    const carga = cargaDe(bien.sesion);
    assert.strictEqual(carga.email, 'lead@acme.example');
    assert.strictEqual(carga.sub, `${oid}:${tid}`, 'la identidad estable de Entra es oid+tid');
  });
});

test('T15 Sesion_CookieFirmadaYVencida', async () => {
  let t = Date.now();
  await conEmisor({ ahora: () => t }, async ({ emisor, h }) => {
    const { res, sesion } = await H.ingresar(h, emisor, { sub: 'u1', email: 'lead@acme.example', email_verified: true });
    const crudo = res.cookies['__Host-site'].crudo;
    for (const attr of [/^__Host-site=/, /;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=Lax/i, /;\s*Path=\//]) assert.match(crudo, attr);
    assert.doesNotMatch(crudo, /Domain=/i, '__Host- no lleva Domain');
    assert.strictEqual((await h.pedir('/', { cookie: sesion })).status, 200, 'control: con la sesión, la página');
    const [nombre, valor] = sesion.split('=');
    const [carga, firma] = valor.split('.');
    const otraCarga = Buffer.from(JSON.stringify({ ...cargaDe(sesion), email: 'otro@acme.example' })).toString('base64url');
    const alterada = `${nombre}=${otraCarga}.${firma}`;
    const otraLlave = `${nombre}=${carga}.${crypto.createHmac('sha256', crypto.randomBytes(32)).update(carga).digest('base64url')}`;
    const sinFirma = `${nombre}=${carga}`;
    for (const [caso, c] of [['alterada', alterada], ['firmada con otra llave', otraLlave], ['sin firma', sinFirma]]) {
      assert.strictEqual((await h.pedir('/', { cookie: c })).status, 302, caso);
    }
    t += (8 * 60 + 1) * 60 * 1000;
    assert.strictEqual((await h.pedir('/', { cookie: sesion })).status, 302, 'de hace 8 h 1 min');
  });
});

test('T16 Logout_SoloPorPost', async () => {
  await conEmisor({}, async ({ emisor, h }) => {
    const { sesion } = await H.ingresar(h, emisor, { sub: 'u1', email: 'lead@acme.example', email_verified: true });
    const get = await h.pedir('/auth/logout', { cookie: sesion });
    assert.ok(!get.cookies['__Host-site'], 'GET no toca la cookie');
    assert.notStrictEqual(get.status, 200);
    const post = await h.pedir('/auth/logout', { method: 'POST', cookie: sesion });
    assert.match(post.cookies['__Host-site'].crudo, /Max-Age=0/, 'POST la borra');
  });
});

test('T35 Jwks_ClaveNuevaSeVuelveABajar', async () => {
  const emisor = await arrancarEmisor();
  try {
    let t = Date.now();
    const { crearCliente } = require(path.join(SITE, 'oidc.js'));
    const c = crearCliente({ issuer: emisor.issuer, clientId: emisor.clientId, clientSecret: emisor.clientSecret, redirectUri: 'http://127.0.0.1/auth/callback', ahora: () => t });
    await c.descubrir();
    assert.strictEqual(emisor.cuantas.jwks, 1);
    emisor.rotar();
    const claims = emisor.claimsBase({ sub: 'u1', nonce: 'n' });
    assert.strictEqual((await c.verificarIdToken(emisor.firmar(claims), { nonce: 'n' })).sub, 'u1', 'la clave nueva se acepta sin reiniciar');
    assert.strictEqual(emisor.cuantas.jwks, 2, 'una sola bajada más');
    for (let i = 0; i < 3; i++) await assert.rejects(c.verificarIdToken(emisor.firmar(claims, { kid: `inventado${i}` }), { nonce: 'n' }));
    assert.strictEqual(emisor.cuantas.jwks, 2, 'un kid inventado no dispara otra bajada en el mismo minuto');
    t += 61 * 1000;
    await assert.rejects(c.verificarIdToken(emisor.firmar(claims, { kid: 'inventado-tarde' }), { nonce: 'n' }));
    assert.strictEqual(emisor.cuantas.jwks, 3, 'pasado el minuto, sí');
  } finally { await emisor.cerrar(); }
});

test('T36 Google_SoloElDominioDeLaOrganizacion', async () => {
  const { validarConfiguracion } = require(path.join(SITE, 'server.js'));
  const sinDominios = validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'google', SITE_OIDC_ISSUER: '' }));
  assert.strictEqual(sinDominios.ok, false);
  assert.ok(sinDominios.problemas.some((p) => p.variable === 'SITE_AUTH_ALLOWED_DOMAINS'));
  const otroEmisor = validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'google', SITE_AUTH_ALLOWED_DOMAINS: 'acme.example', SITE_OIDC_ISSUER: 'https://otro.example' }));
  assert.ok(otroEmisor.problemas.some((p) => p.variable === 'SITE_OIDC_ISSUER'), 'google tiene su emisor fijo');
  assert.strictEqual(validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'google', SITE_AUTH_ALLOWED_DOMAINS: 'acme.example', SITE_OIDC_ISSUER: '' })).ok, true);
  await conEmisor({ env: () => ({ SITE_AUTH_PROVIDER: 'google', SITE_AUTH_ALLOWED_DOMAINS: 'acme.example' }) }, async ({ emisor, h }) => {
    const casos = [
      ['otro hd', { sub: 'g1', email: 'lead@otra.example', email_verified: true, hd: 'otra.example' }, false],
      ['sin hd (cuenta personal)', { sub: 'g1', email: 'lead@acme.example', email_verified: true }, false],
      ['email_verified: false', { sub: 'g1', email: 'lead@acme.example', email_verified: false, hd: 'acme.example' }, false],
      ['el hd de la organización', { sub: 'g1', email: 'lead@acme.example', email_verified: true, hd: 'acme.example' }, true],
    ];
    for (const [caso, claims, entra] of casos) {
      const r = await H.ingresar(h, emisor, claims);
      assert.strictEqual(Boolean(r.sesion), entra, caso);
    }
  });
});

test('T37 GitHub_CorreoVerificadoYMiembroDeLaOrganizacion', async () => {
  const { validarConfiguracion } = require(path.join(SITE, 'server.js'));
  const gh = await arrancarGithub();
  try {
    const env = H.envBase({ SITE_AUTH_PROVIDER: 'github', SITE_OIDC_ISSUER: '', SITE_OIDC_CLIENT_ID: gh.clientId, SITE_OIDC_CLIENT_SECRET: gh.clientSecret, SITE_GITHUB_URL: gh.base, SITE_GITHUB_API_URL: gh.api, SITE_AUTH_GITHUB_ORG: 'acme-org' });
    const sinOrg = validarConfiguracion({ ...env, SITE_AUTH_GITHUB_ORG: '' });
    assert.ok(sinOrg.problemas.some((p) => p.variable === 'SITE_AUTH_GITHUB_ORG'), 'sin organización no arranca');
    assert.ok(validarConfiguracion({ ...env, SITE_GITHUB_URL: 'https://gh.otro.example' }).problemas.some((p) => p.variable === 'SITE_GITHUB_URL'), 'GitHub tiene su dirección fija');
    const h = await H.arrancarSitio({ env, fuentes: H.fuentesFijas({ config: MANT }) });
    try {
      const usuario = (extra) => ({ id: 4242, login: 'lead@acme.example', emails: [{ email: 'Lead@Acme.Example', primary: true, verified: true }], orgs: { 'acme-org': 'active' }, ...extra });
      const bien = await H.ingresarGithub(h, gh, usuario());
      assert.ok(bien.sesion, 'miembro activo con correo primario verificado');
      assert.deepStrictEqual([cargaDe(bien.sesion).email, cargaDe(bien.sesion).sub], ['lead@acme.example', 'github:4242'], 'el id de GitHub, nunca el login');
      const casos = [
        ['no miembro', usuario({ orgs: {} })],
        ['miembro pendiente', usuario({ orgs: { 'acme-org': 'pending' } })],
        ['primario sin verificar', usuario({ emails: [{ email: 'lead@acme.example', primary: true, verified: false }, { email: 'otro@acme.example', primary: false, verified: true }] })],
      ];
      for (const [caso, u] of casos) assert.strictEqual((await H.ingresarGithub(h, gh, u)).sesion, null, caso);
      const cambiado = await H.ingresarGithub(h, gh, usuario(), { alterar: ({ vuelta, cookie }) => ({ vuelta: vuelta.replace(/state=([^&]+)/, 'state=$1x'), cookie }) });
      assert.strictEqual(cambiado.sesion, null, 'state cambiado');
    } finally { await h.cerrar(); }
  } finally { await gh.cerrar(); }
});

test('T38 Oidc_Generico_DominioPermitido', async () => {
  await conEmisor({ env: () => ({ SITE_AUTH_ALLOWED_DOMAINS: 'acme.example' }) }, async ({ emisor, h }) => {
    assert.ok((await H.ingresar(h, emisor, { sub: 'u1', email: 'dev@acme.example', email_verified: true })).sesion, '@acme.example entra');
    assert.strictEqual((await H.ingresar(h, emisor, { sub: 'u2', email: 'dev@otra.example', email_verified: true })).sesion, null, '@otra.example no');
  });
});

// ── Microsoft con cualquier cuenta, y los invitados del directorio ───────────────────────────────────────
// La forma que publica Entra: el descubrimiento de `common` publica
// el emisor `…/{tenantid}/v2.0`; cada token trae el emisor de su inquilino; las cuentas personales vienen del inquilino
// 9188040d-6c67-4c5b-b112-36a304b66dad.
const { arrancarEmisorMicrosoft } = require('./lib/fake-oidc.js');
const PERSONALES = '9188040d-6c67-4c5b-b112-36a304b66dad';

async function conMicrosoft({ tenant, config = MANT, env = {} }, fn) {
  const emisor = await arrancarEmisorMicrosoft();
  let h = null;
  try {
    const e = H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: tenant, SITE_OIDC_ISSUER: emisor.issuer, ...env });
    h = await H.arrancarSitio({ env: e, fuentes: H.fuentesFijas({ config }) });
    await fn({ emisor, h });
  } finally { if (h) await h.cerrar(); await emisor.cerrar(); }
}
/** El viaje entero desde una dirección de inicio (`/auth/login` o la de los invitados). */
async function ingresarPor(h, emisor, ruta, claims, { idToken } = {}) {
  const ida = await h.pedir(ruta);
  if (ida.status !== 302) return { res: ida, sesion: null, ida };
  const it = H.intentoDe(ida);
  const code = emisor.emitirCodigo({ claims, nonce: it.nonce, challenge: it.challenge, idToken: idToken && idToken(it) });
  const res = await h.pedir(`/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(it.state)}`, { cookie: it.cookie });
  const s = res.cookies['__Host-site'];
  return { res, ida, sesion: s && s.valor ? `__Host-site=${s.valor}` : null };
}

test('T7 2.40-Microsoft_CualquierCuenta_CorreoVerificado @story-2.40 @ac-7', async () => {
  const org = UUID();
  const otra = UUID();
  await conMicrosoft({ tenant: org }, async ({ emisor, h }) => {
    // la página de inicio ofrece las dos puertas
    const inicio = await h.pedir('/');
    assert.strictEqual(inicio.status, 200);
    assert.match(inicio.texto, /href="\/auth\/login"/);
    assert.match(inicio.texto, /href="\/auth\/login\?via=invitado"/);
    assert.match(inicio.texto, /invitado del directorio de la organización/);
    // la puerta principal va al emisor de varios inquilinos
    const ida = await h.pedir('/auth/login');
    assert.strictEqual(ida.status, 302);
    assert.ok(ida.headers.location.startsWith(`${emisor.base}/common/v2.0/authorize`), ida.headers.location);
    // una cuenta de trabajo de otro inquilino con el correo verificado: entra, con oid:tid
    const oid = UUID();
    const bien = await ingresarPor(h, emisor, '/auth/login', { sub: 's', oid, tid: otra, email: 'Dev@Otra.example', xms_edov: true });
    assert.ok(bien.sesion, bien.res.texto);
    assert.strictEqual(cargaDe(bien.sesion).email, 'dev@otra.example');
    assert.strictEqual(cargaDe(bien.sesion).sub, `${oid}:${otra}`);
    // sin xms_edov, o con xms_edov false: no entra, y dice por qué
    for (const edov of [undefined, false]) {
      const r = await ingresarPor(h, emisor, '/auth/login', { sub: 's', oid: UUID(), tid: otra, email: 'dev@otra.example', ...(edov === undefined ? {} : { xms_edov: edov }) });
      assert.strictEqual(r.sesion, null);
      assert.strictEqual(r.res.status, 403);
      assert.match(r.res.texto, /correo verificado/);
    }
    // una cuenta personal que entra directo: no se acepta (parte A), y la página la manda a la puerta de los invitados
    const personal = await ingresarPor(h, emisor, '/auth/login', { sub: 's', oid: UUID(), tid: PERSONALES, email: 'alguien@hotmail.example', xms_edov: true });
    assert.strictEqual(personal.sesion, null);
    assert.match(personal.res.texto, /cuentas personales de Microsoft/);
    assert.match(personal.res.texto, /href="\/auth\/login\?via=invitado"/);
    assert.ok(h.registro.some((l) => /cuenta personal/.test(l) && !l.includes('hotmail')), h.registro.join('\n'));
  });
});

test('T8 2.40-Microsoft_EmisorDeOtroInquilino_FirmaValidada @story-2.40 @ac-7', async () => {
  const org = UUID();
  const t1 = UUID();
  const t2 = UUID();
  await conMicrosoft({ tenant: org }, async ({ emisor, h }) => {
    const ahora = Math.floor(Date.now() / 1000);
    const base = (it, extra) => ({ aud: emisor.clientId, iat: ahora, exp: ahora + 3600, nonce: it.nonce, sub: 's', oid: UUID(), email: 'dev@otra.example', xms_edov: true, ...extra });
    const casos = [
      ['el iss de otro inquilino que su tid', (it) => emisor.firmar(base(it, { tid: t1, iss: emisor.deInquilino(t2) }))],
      ['el iss con la plantilla sin reemplazar', (it) => emisor.firmar(base(it, { tid: t1, iss: `${emisor.base}/{tenantid}/v2.0` }))],
      ['un tid que no es un inquilino', (it) => emisor.firmar(base(it, { tid: 'common', iss: emisor.deInquilino('common') }))],
      ['firmado con otra llave', (it) => emisor.firmar(base(it, { tid: t1, iss: emisor.deInquilino(t1) }), { clave: claveNuevaRsa() })],
      ['el iss de otro emisor', (it) => emisor.firmar(base(it, { tid: t1, iss: `https://otro.example/${t1}/v2.0` }))],
    ];
    for (const [caso, armar] of casos) {
      const r = await ingresarPor(h, emisor, '/auth/login', { tid: t1 }, { idToken: armar });
      assert.strictEqual(r.sesion, null, caso);
      assert.notStrictEqual(r.res.status, 302, caso);
    }
    // y el mismo token bien armado entra: los rechazos son por lo que cambia
    const ok = await ingresarPor(h, emisor, '/auth/login', { tid: t1 }, { idToken: (it) => emisor.firmar(base(it, { tid: t1, iss: emisor.deInquilino(t1) })) });
    assert.ok(ok.sesion, ok.res.texto);
  });
});
function claveNuevaRsa() { return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey; }

test('T9 2.40-Microsoft_UnInquilino_ComoHoy @story-2.40 @ac-7 @ac-12', () => {
  const { validarConfiguracion } = require(path.join(SITE, 'server.js'));
  const org = UUID();
  const ms = (extra) => validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', ...extra }));
  // el modo de hoy, explícito o por defecto: los emisores de varios inquilinos no arrancan
  for (const modo of [undefined, 'organization']) {
    const r = ms({ SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0', ...(modo ? { SITE_AUTH_MICROSOFT_ACCOUNTS: modo } : {}) });
    assert.strictEqual(r.ok, false, String(modo));
    assert.ok(r.problemas.some((p) => p.variable === 'SITE_OIDC_ISSUER'), String(modo));
    assert.strictEqual(ms({ SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${org}/v2.0`, ...(modo ? { SITE_AUTH_MICROSOFT_ACCOUNTS: modo } : {}) }).ok, true, `${modo}: un inquilino arranca`);
  }
  // el modo nuevo pide un emisor de varios inquilinos y el inquilino de la organización (los invitados)
  assert.strictEqual(ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: org, SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' }).ok, true);
  assert.strictEqual(ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: org, SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/organizations/v2.0' }).ok, true);
  const sinInquilino = ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' });
  assert.ok(sinInquilino.problemas.some((p) => p.variable === 'SITE_AUTH_MICROSOFT_TENANT'));
  const deUnInquilino = ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: org, SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${org}/v2.0` });
  assert.ok(deUnInquilino.problemas.some((p) => p.variable === 'SITE_OIDC_ISSUER' && /common|organizations/.test(p.motivo)));
  const personales = ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: org, SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/consumers/v2.0' });
  assert.strictEqual(personales.ok, false, 'sólo cuentas personales: no');
  assert.ok(ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'cualquiera', SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${org}/v2.0` }).problemas.some((p) => p.variable === 'SITE_AUTH_MICROSOFT_ACCOUNTS'));
  assert.ok(ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: 'no-es-un-inquilino', SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' }).problemas.some((p) => p.variable === 'SITE_AUTH_MICROSOFT_TENANT'));
});

test('T16 2.40-Microsoft_InvitadoDelDirectorio @story-2.40 @ac-7b @ac-12', async () => {
  const org = UUID();
  const INVITADO = 'invitada@personal.example';
  const config = { version: 1, owners: { default: 'lead@acme.example' }, site: { access: [{ role: 'maintainer', emails: ['lead@acme.example'] }, { role: 'dev', emails: [INVITADO] }] } };
  await conMicrosoft({ tenant: org, config }, async ({ emisor, h }) => {
    // la puerta de los invitados va al emisor del inquilino de la organización
    const ida = await h.pedir('/auth/login?via=invitado');
    assert.ok(ida.headers.location.startsWith(`${emisor.deInquilino(org)}/authorize`), ida.headers.location);
    // un invitado con cuenta personal entra por ahí, con el correo verificado, como hoy
    const oid = UUID();
    const r = await ingresarPor(h, emisor, '/auth/login?via=invitado', { sub: 's', oid, tid: org, email: 'Invitada@Personal.example', xms_edov: true, acct: 1 });
    assert.ok(r.sesion, r.res.texto);
    assert.strictEqual(cargaDe(r.sesion).sub, `${oid}:${org}`);
    const ini = await h.pedir('/', { cookie: r.sesion });
    assert.match(ini.texto, /href="\/proyectos"/, 'la lista lo reconoce por su correo: es dev');
    // por la puerta de los invitados sólo entra el inquilino de la organización
    const deOtro = await ingresarPor(h, emisor, '/auth/login?via=invitado', { sub: 's', oid: UUID(), tid: UUID(), email: INVITADO, xms_edov: true });
    assert.strictEqual(deOtro.sesion, null);
    // y por la principal, la misma persona con su cuenta personal es personal: no entra, y la página le dice por dónde
    const personal = await ingresarPor(h, emisor, '/auth/login', { sub: 's', oid: UUID(), tid: PERSONALES, email: INVITADO, xms_edov: true });
    assert.strictEqual(personal.sesion, null);
    assert.match(personal.res.texto, /invitado/);
    // una vía desconocida es la principal, no un error
    assert.ok((await h.pedir('/auth/login?via=otra')).headers.location.startsWith(`${emisor.base}/common/v2.0/authorize`));
  });
});

// Entra publica el inquilino en minúsculas aunque se lo pida en mayúsculas: el inquilino de la organización escrito en
// mayúsculas no puede dejar al sitio sin poder entrar (las dos puertas tienen que estar listas)
test('2.40-R1 Microsoft_InquilinoEnMayusculas_EntraIgual @story-2.40 @ac-7b', async () => {
  const org = UUID();
  const { validarConfiguracion } = require(path.join(SITE, 'server.js'));
  const env = H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: org.toUpperCase(), SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' });
  assert.strictEqual(validarConfiguracion(env).cfg.opciones.tenant, org, 'el inquilino queda en minúsculas');
  const config = { version: 1, owners: { default: 'lead@acme.example' }, site: { access: [{ role: 'maintainer', emails: ['lead@acme.example'] }] } };
  await conMicrosoft({ tenant: org.toUpperCase(), config }, async ({ emisor, h }) => {
    const ida = await h.pedir('/auth/login?via=invitado');
    assert.strictEqual(ida.status, 302, 'la puerta de los invitados arrancó');
    assert.ok(ida.headers.location.startsWith(`${emisor.deInquilino(org)}/authorize`), ida.headers.location);
    const r = await ingresarPor(h, emisor, '/auth/login?via=invitado', { sub: 's', oid: UUID(), tid: org, email: 'lead@acme.example', xms_edov: true });
    assert.ok(r.sesion, r.res.texto);
  });
  // en el modo de un inquilino, un emisor con el inquilino en mayúsculas no arranca (y dice por qué)
  const una = validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${org.toUpperCase()}/v2.0` }));
  assert.ok(una.problemas.some((p) => p.variable === 'SITE_OIDC_ISSUER' && /minúsculas/.test(p.motivo)), JSON.stringify(una.problemas));
});

// El inquilino de las cuentas personales nunca es el de la organización: ni como inquilino de los invitados ni como emisor
// de un solo inquilino. Y la puerta de los invitados tampoco deja entrar a una cuenta personal directa.
test('2.40-R2 Microsoft_InquilinoDeCuentasPersonales_NoArranca @story-2.40 @ac-7 @ac-7b', async () => {
  const { validarConfiguracion } = require(path.join(SITE, 'server.js'));
  const ms = (extra) => validarConfiguracion(H.envBase({ SITE_AUTH_PROVIDER: 'microsoft', ...extra }));
  const any = ms({ SITE_AUTH_MICROSOFT_ACCOUNTS: 'any', SITE_AUTH_MICROSOFT_TENANT: PERSONALES, SITE_OIDC_ISSUER: 'https://login.microsoftonline.com/common/v2.0' });
  assert.ok(any.problemas.some((p) => p.variable === 'SITE_AUTH_MICROSOFT_TENANT' && /cuentas personales/.test(p.motivo)), JSON.stringify(any.problemas));
  for (const t of [PERSONALES, PERSONALES.toUpperCase()]) {
    const una = ms({ SITE_OIDC_ISSUER: `https://login.microsoftonline.com/${t}/v2.0` });
    assert.ok(una.problemas.some((p) => p.variable === 'SITE_OIDC_ISSUER'), t);
  }
  // aun mal instalado, la puerta de los invitados no acepta el inquilino de las cuentas personales
  const microsoft = require(path.join(SITE, 'auth-providers', 'microsoft.js'));
  const emisor = await arrancarEmisorMicrosoft();
  try {
    const cfg = { issuer: emisor.issuer, clientId: emisor.clientId, clientSecret: emisor.clientSecret, redirectUri: 'http://127.0.0.1/auth/callback', allowedDomains: [], opciones: { modo: 'any', tenant: PERSONALES } };
    const p = microsoft.crear(cfg, { ahora: Date.now });
    await p.preparar();
    const it = { state: 's', nonce: 'n', challenge: 'c' };
    const code = emisor.emitirCodigo({ claims: { sub: 's', oid: UUID(), tid: PERSONALES, email: 'lead@acme.example', xms_edov: true }, nonce: 'n' });
    await assert.rejects(() => p.completar({ code, verifier: 'v', nonce: it.nonce, via: 'invitado' }), (e) => /cuentas personales/.test(e.pantalla));
  } finally { await emisor.cerrar(); }
});
