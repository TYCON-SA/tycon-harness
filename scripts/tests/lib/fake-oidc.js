'use strict';
/*
 * fake-oidc.js — un emisor OIDC local para las pruebas del sitio de la organización (story 2.23).
 *
 * Sirve lo que un emisor real publica —el descubrimiento, el JWKS, la autorización y el canje del código— en
 * http://127.0.0.1:<puerto><prefijo>. NUNCA habla con la red. Con `prefijo` se imita la forma de cada proveedor: un
 * emisor de Entra ID es `/<inquilino>/v2.0`; uno genérico, la raíz.
 *
 * Qué permite:
 *   · `emitirCodigo({ claims, nonce, challenge })` → un código de un solo uso: el canje devuelve un id_token firmado con
 *     esas claims (más iss, aud, iat, exp y el nonce del intento). El canje exige el `client_secret` y el `code_verifier`
 *     cuyo S256 es el challenge del intento: un PKCE roto contesta 400.
 *   · `firmar(claims, { alg, kid, clave })` → un id_token armado a mano (para las pruebas de la verificación).
 *   · `rotar()` → una clave nueva en el JWKS (la vieja sale): la prueba de «kid desconocido».
 *   · `cuantas.jwks` / `cuantas.descubrimiento` → cuántas veces se bajaron.
 *   · `apagar()` / `prender()` → el emisor contesta 503 a todo (el arranque sin emisor).
 *
 * Los tokens se arman al correr: ninguno vive escrito en un archivo.
 *
 * stable-data: el emisor firma `iat` y `exp` con la hora real, como uno de verdad; quien quiere otra hora la pasa en las
 * claims. Lo que las pruebas comparan son plazos contra el reloj del sitio, nunca una fecha fija.
 */
const http = require('http');
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');

function claveNueva(tipo = 'RS256') {
  const par = tipo === 'ES256'
    ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { tipo, kid: crypto.randomBytes(6).toString('hex'), privada: par.privateKey, publica: par.publicKey };
}

function jwkDe(c) {
  return { ...c.publica.export({ format: 'jwk' }), kid: c.kid, alg: c.tipo, use: 'sig' };
}

/** Firma un JWT con `alg` (RS256, ES256, HS256 con un secreto, o none) y la clave dada. */
function firmarJwt(claims, { alg = 'RS256', kid, clave, secreto } = {}) {
  const cab = { alg, typ: 'JWT', ...(kid ? { kid } : {}) };
  const datos = `${b64u(JSON.stringify(cab))}.${b64u(JSON.stringify(claims))}`;
  if (alg === 'none') return `${datos}.`;
  if (alg === 'HS256') return `${datos}.${b64u(crypto.createHmac('sha256', secreto).update(datos).digest())}`;
  const firma = alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(datos), { key: clave, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', Buffer.from(datos), clave);
  return `${datos}.${b64u(firma)}`;
}

function leerCuerpo(req) {
  return new Promise((resolve) => {
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => resolve(Buffer.concat(trozos).toString('utf8')));
  });
}

/**
 * Arranca el emisor. `prefijo` es la ruta del emisor (sin barra final), `clientId` y `clientSecret` los del cliente
 * registrado, `tipo` el algoritmo de su clave.
 */
async function arrancarEmisor({ prefijo = '', clientId = 'site-client', clientSecret = 'site-secret', tipo = 'RS256' } = {}) {
  let clave = claveNueva(tipo);
  let apagado = false;
  const codigos = new Map();
  const cuantas = { jwks: 0, descubrimiento: 0, canjes: 0 };
  const emisor = { issuer: null, clientId, clientSecret, cuantas };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const responder = (status, cuerpo, tipoCont = 'application/json') => { res.writeHead(status, { 'content-type': tipoCont }); res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)); };
    if (apagado) return responder(503, { error: 'apagado' });
    if (!u.pathname.startsWith(prefijo)) return responder(404, { error: 'no' });
    const ruta = u.pathname.slice(prefijo.length);
    if (ruta === '/.well-known/openid-configuration') {
      cuantas.descubrimiento += 1;
      return responder(200, {
        issuer: emisor.issuer,
        authorization_endpoint: `${emisor.issuer}/authorize`,
        token_endpoint: `${emisor.issuer}/token`,
        jwks_uri: `${emisor.issuer}/jwks`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: [tipo],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (ruta === '/jwks') { cuantas.jwks += 1; return responder(200, { keys: [jwkDe(clave)] }); }
    if (ruta === '/token' && req.method === 'POST') {
      cuantas.canjes += 1;
      const p = new URLSearchParams(await leerCuerpo(req));
      const intento = codigos.get(p.get('code'));
      codigos.delete(p.get('code'));
      if (!intento) return responder(400, { error: 'invalid_grant' });
      if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return responder(401, { error: 'invalid_client' });
      if (p.get('grant_type') !== 'authorization_code') return responder(400, { error: 'unsupported_grant_type' });
      const verificador = p.get('code_verifier') || '';
      if (intento.challenge && b64u(crypto.createHash('sha256').update(verificador).digest()) !== intento.challenge) return responder(400, { error: 'invalid_grant', motivo: 'pkce' });
      const ahora = Math.floor(Date.now() / 1000);
      const claims = { iss: emisor.issuer, aud: clientId, iat: ahora, exp: ahora + 3600, nonce: intento.nonce, ...intento.claims };
      return responder(200, { access_token: 'a', token_type: 'Bearer', id_token: intento.idToken || firmarJwt(claims, { alg: tipo, kid: clave.kid, clave: clave.privada }) });
    }
    if (ruta === '/authorize') return responder(200, 'autorización', 'text/plain');
    return responder(404, { error: 'no' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  emisor.issuer = `http://127.0.0.1:${server.address().port}${prefijo}`;

  emisor.emitirCodigo = ({ claims, nonce, challenge, idToken }) => {
    const code = crypto.randomBytes(12).toString('hex');
    codigos.set(code, { claims, nonce, challenge, idToken });
    return code;
  };
  emisor.firmar = (claims, opts = {}) => firmarJwt(claims, { alg: opts.alg || tipo, kid: opts.kid === undefined ? clave.kid : opts.kid, clave: opts.clave || clave.privada, secreto: opts.secreto });
  emisor.claimsBase = (extra = {}) => { const ahora = Math.floor(Date.now() / 1000); return { iss: emisor.issuer, aud: clientId, iat: ahora, exp: ahora + 3600, ...extra }; };
  emisor.clavePublicaPem = () => clave.publica.export({ type: 'spki', format: 'pem' });
  emisor.rotar = () => { clave = claveNueva(tipo); return clave.kid; };
  emisor.kid = () => clave.kid;
  emisor.apagar = () => { apagado = true; };
  emisor.prender = () => { apagado = false; };
  emisor.cerrar = () => new Promise((r) => server.close(() => r()));
  return emisor;
}

/**
 * Un emisor con la forma de Microsoft para varios inquilinos, la que publica Entra: `/common/v2.0` y
 * `/organizations/v2.0` publican un descubrimiento cuyo `issuer`
 * es la plantilla `<base>/{tenantid}/v2.0`; `/<inquilino>/v2.0` publica el suyo con el inquilino puesto. Las dos usan el
 * mismo JWKS. El id_token sale con `iss` = `<base>/<tid de sus claims>/v2.0`, salvo que las claims traigan su `iss`.
 * `emisor.issuer` es el de `common`; `emisor.base`, la raíz; `emisor.deInquilino(t)`, el emisor de un inquilino.
 */
async function arrancarEmisorMicrosoft({ clientId = 'site-client', clientSecret = 'site-secret' } = {}) {
  const clave = claveNueva('RS256');
  const codigos = new Map();
  const cuantas = { jwks: 0, descubrimiento: 0, canjes: 0, autorizaciones: [] };
  const emisor = { clientId, clientSecret, cuantas };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const responder = (status, cuerpo, tipoCont = 'application/json') => { res.writeHead(status, { 'content-type': tipoCont }); res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)); };
    if (u.pathname === '/common/discovery/v2.0/keys') { cuantas.jwks += 1; return responder(200, { keys: [jwkDe(clave)] }); }
    const m = /^\/([^/]+)\/v2\.0(\/.*)$/.exec(u.pathname);
    if (!m) return responder(404, { error: 'no' });
    const [, segPedido, ruta] = m;
    // Entra publica el inquilino en minúsculas aunque se lo pida en mayúsculas
    const seg = segPedido.toLowerCase();
    const propio = `${emisor.base}/${seg}/v2.0`;
    if (ruta === '/.well-known/openid-configuration') {
      cuantas.descubrimiento += 1;
      const multi = seg === 'common' || seg === 'organizations';
      return responder(200, { issuer: multi ? `${emisor.base}/{tenantid}/v2.0` : propio, authorization_endpoint: `${propio}/authorize`, token_endpoint: `${propio}/token`,
        jwks_uri: `${emisor.base}/common/discovery/v2.0/keys`, response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    }
    if (ruta === '/authorize') { cuantas.autorizaciones.push(seg); return responder(200, 'autorización', 'text/plain'); }
    if (ruta === '/token' && req.method === 'POST') {
      cuantas.canjes += 1;
      const p = new URLSearchParams(await leerCuerpo(req));
      const intento = codigos.get(p.get('code'));
      codigos.delete(p.get('code'));
      if (!intento) return responder(400, { error: 'invalid_grant' });
      if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret) return responder(401, { error: 'invalid_client' });
      if (intento.challenge && b64u(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) !== intento.challenge) return responder(400, { error: 'invalid_grant' });
      const ahora = Math.floor(Date.now() / 1000);
      const claims = { iss: `${emisor.base}/${intento.claims.tid}/v2.0`, aud: clientId, iat: ahora, exp: ahora + 3600, nonce: intento.nonce, ...intento.claims };
      return responder(200, { access_token: 'a', token_type: 'Bearer', id_token: intento.idToken || firmarJwt(claims, { kid: clave.kid, clave: clave.privada }) });
    }
    return responder(404, { error: 'no' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  emisor.base = `http://127.0.0.1:${server.address().port}`;
  emisor.issuer = `${emisor.base}/common/v2.0`;
  emisor.deInquilino = (t) => `${emisor.base}/${t}/v2.0`;
  emisor.emitirCodigo = ({ claims, nonce, challenge, idToken }) => {
    const code = crypto.randomBytes(12).toString('hex');
    codigos.set(code, { claims, nonce, challenge, idToken });
    return code;
  };
  emisor.firmar = (claims, opts = {}) => firmarJwt(claims, { kid: opts.kid === undefined ? clave.kid : opts.kid, clave: opts.clave || clave.privada });
  emisor.cerrar = () => new Promise((r) => server.close(() => r()));
  return emisor;
}

module.exports = { arrancarEmisor, arrancarEmisorMicrosoft, firmarJwt, claveNueva };
