'use strict';
/*
 * oidc.js — el inicio de sesión OIDC genérico del sitio de la organización (story 2.23, AC 5 a 8; decisiones 9 a 11).
 *
 * Código de autorización con PKCE (S256), `state` y `nonce`. Sin dependencias de afuera (decisión 10): la firma del
 * id_token la verifica `crypto` de Node con las claves del JWKS del emisor; lo nuestro son comparaciones, cada una con
 * su prueba (scripts/tests/site-oidc.test.js, T9, T10 y T35).
 *
 * El id_token se acepta SÓLO si:
 *   · `alg` es RS256 o ES256 (none, HS256 y cualquier otro se rechazan: con HS256 la clave pública haría de secreto);
 *   · la firma es válida con una clave del JWKS cuyo `kid` coincide y cuyo tipo es el del algoritmo;
 *   · `iss` es EXACTAMENTE el emisor configurado (una barra de más es otro emisor);
 *   · `aud` contiene el cliente, y si hay varias audiencias (o viene `azp`), `azp` es el cliente;
 *   · `exp`, `iat` y `nbf` valen con 5 minutos de tolerancia;
 *   · el `nonce` es el del intento.
 * El descubrimiento y el JWKS se bajan al arrancar; ante un `kid` desconocido el JWKS se vuelve a bajar, como mucho una
 * vez por minuto (un `kid` inventado no puede usar al sitio para martillar al emisor).
 *
 * Lo que se leyó de la documentación (Task 0, 2026-10-15): OpenID Connect Discovery 1.0 §4 —
 * `<emisor>/.well-known/openid-configuration`, y el `issuer` del documento tiene que ser idéntico al emisor pedido. Lo
 * propio de cada proveedor (sus claims, su emisor) está en la cabecera de su archivo en auth-providers/.
 *
 * Cada proveedor (auth-providers/<proveedor>.js) dice de dónde sale el correo y cómo se limita a la organización; el
 * proveedor `oidc` genérico vive acá: el correo de `SITE_OIDC_EMAIL_CLAIM` (por defecto `email`), con `email_verified:
 * true` si el emisor la publica, y el dominio en `SITE_AUTH_ALLOWED_DOMAINS` si está puesta. Nunca `preferred_username`.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const TOLERANCIA_SEG = 5 * 60;
const MIN_ENTRE_BAJADAS_MS = 60 * 1000;
const ALGORITMOS = { RS256: 'RSA', ES256: 'EC' };
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Un error del token o del canje: `motivo` va al registro, nunca a la pantalla. */
class ErrorOidc extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo; }
}
/** Un rechazo de la identidad: `pantalla` es una frase fija que puede ver quien intentó entrar; `motivo`, el registro. */
class ErrorDeIngreso extends Error {
  constructor(pantalla, motivo) { super(motivo || pantalla); this.pantalla = pantalla; this.motivo = motivo || pantalla; }
}

/** Un pedido HTTP(S) que nunca rechaza: { status, cuerpo (texto), cabeceras } o { error }. */
function pedir(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ error: e }); return; }
    const mod = u.protocol === 'http:' ? http : https;
    let hecho = false;
    const fin = (r) => { if (!hecho) { hecho = true; resolve(r); } };
    const req = mod.request(u, { method, headers: { 'user-agent': 'harness-site', ...headers }, timeout: timeoutMs }, (res) => {
      const trozos = [];
      res.on('data', (c) => trozos.push(c));
      res.on('end', () => fin({ status: res.statusCode, cuerpo: Buffer.concat(trozos).toString('utf8'), cabeceras: res.headers }));
      res.on('error', (e) => fin({ error: e }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => fin({ error: e }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function pedirJson(url, opts) {
  const r = await pedir(url, { ...opts, headers: { accept: 'application/json', ...((opts && opts.headers) || {}) } });
  if (r.error) throw new ErrorOidc(`sin respuesta de ${new URL(url).host} (${r.error.code || r.error.message})`);
  let json = null;
  try { json = JSON.parse(r.cuerpo); } catch { /* se dice abajo */ }
  return { status: r.status, json };
}

const b64uJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
/** El `error` de una respuesta de OAuth, con la forma de un código: va al registro, y lo escribe un servidor de afuera. */
const codigoOAuth = (e) => String(e || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'sin código';
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

/**
 * El cliente OIDC de un emisor. `ahora` (ms) se inyecta en las pruebas.
 *   descubrir() · listo() · urlDeInicio({ state, nonce, challenge, scope }) · canjear(code, verifier) ·
 *   verificarIdToken(token, { nonce })
 */
function crearCliente({ issuer, clientId, clientSecret, redirectUri, ahora = Date.now }) {
  let doc = null;
  let claves = [];
  let ultimaRebajada = -Infinity;

  async function bajarJwks() {
    const r = await pedirJson(doc.jwks_uri);
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.keys)) throw new ErrorOidc(`el JWKS del emisor contestó ${r.status} sin claves`);
    claves = r.json.keys.filter((k) => k && typeof k === 'object');
  }

  async function descubrir() {
    const r = await pedirJson(`${issuer}/.well-known/openid-configuration`);
    if (r.status !== 200 || !r.json) throw new ErrorOidc(`el descubrimiento del emisor contestó ${r.status}`);
    if (r.json.issuer !== issuer) throw new ErrorOidc('el issuer del descubrimiento no es idéntico al emisor configurado');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof r.json[k] !== 'string') throw new ErrorOidc(`el descubrimiento no trae ${k}`);
    }
    doc = r.json;
    await bajarJwks();
  }

  function urlDeInicio({ state, nonce, challenge, scope = 'openid email profile', extra = {} }) {
    const u = new URL(doc.authorization_endpoint);
    const p = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256', ...extra };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function canjear(code, verifier) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }).toString();
    const r = await pedirJson(doc.token_endpoint, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    if (r.status !== 200 || !r.json || typeof r.json.id_token !== 'string') throw new ErrorOidc(`el canje del código contestó ${r.status}${r.json && r.json.error ? ` (${codigoOAuth(r.json.error)})` : ''}`);
    return r.json;
  }

  function claveDe(kid, kty) {
    const conTipo = claves.filter((k) => k.kty === kty);
    if (kid === undefined) return conTipo.length === 1 ? conTipo[0] : null;
    return conTipo.find((k) => k.kid === kid) || null;
  }

  async function verificarIdToken(token, { nonce }) {
    const partes = String(token || '').split('.');
    if (partes.length !== 3) throw new ErrorOidc('el id_token no tiene tres partes');
    let cab; let claims;
    try { cab = b64uJson(partes[0]); claims = b64uJson(partes[1]); } catch { throw new ErrorOidc('el id_token no es JSON legible'); }
    // sólo las claves PROPIAS de la tabla: `constructor` o `toString` existen en cualquier objeto y no son algoritmos
    const kty = typeof cab.alg === 'string' && Object.hasOwn(ALGORITMOS, cab.alg) ? ALGORITMOS[cab.alg] : null;
    if (!kty) throw new ErrorOidc(`algoritmo no admitido: ${String(cab.alg).slice(0, 20)} (sólo RS256 y ES256)`);
    let jwk = claveDe(cab.kid, kty);
    if (!jwk && ahora() - ultimaRebajada >= MIN_ENTRE_BAJADAS_MS) {
      ultimaRebajada = ahora();
      await bajarJwks();
      jwk = claveDe(cab.kid, kty);
    }
    if (!jwk) throw new ErrorOidc('ninguna clave del JWKS del emisor tiene ese kid');
    let clave;
    try { clave = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw new ErrorOidc('la clave del JWKS no se pudo leer'); }
    const firma = Buffer.from(partes[2], 'base64url');
    const datos = Buffer.from(`${partes[0]}.${partes[1]}`);
    const ok = cab.alg === 'ES256'
      ? crypto.verify('sha256', datos, { key: clave, dsaEncoding: 'ieee-p1363' }, firma)
      : crypto.verify('sha256', datos, clave, firma);
    if (!ok) throw new ErrorOidc('la firma del id_token no es válida');
    if (claims.iss !== issuer) throw new ErrorOidc('el iss del id_token no es exactamente el emisor configurado');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new ErrorOidc('el aud del id_token no es este cliente');
    if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) throw new ErrorOidc('varias audiencias y el azp no es este cliente');
    const t = Math.floor(ahora() / 1000);
    if (!Number.isFinite(claims.exp) || claims.exp + TOLERANCIA_SEG < t) throw new ErrorOidc('el id_token venció');
    if (!Number.isFinite(claims.iat) || claims.iat - TOLERANCIA_SEG > t) throw new ErrorOidc('el iat del id_token está en el futuro');
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf - TOLERANCIA_SEG > t)) throw new ErrorOidc('el id_token todavía no vale (nbf)');
    if (typeof nonce !== 'string' || claims.nonce !== nonce) throw new ErrorOidc('el nonce no es el de este intento');
    return claims;
  }

  return { descubrir, listo: () => doc !== null, urlDeInicio, canjear, verificarIdToken };
}

const dominioDe = (correo) => correo.slice(correo.lastIndexOf('@') + 1).toLowerCase();

/** El correo de una claim, en minúsculas, o un rechazo con su frase. */
function correoDe(claims, claim) {
  const v = claims[claim];
  if (typeof v !== 'string' || !CORREO.test(v.trim())) throw new ErrorDeIngreso(`el emisor no mandó la claim ${claim} con un correo`, `sin la claim ${claim}`);
  return v.trim().toLowerCase();
}

function limitarDominio(correo, dominios) {
  if (dominios && dominios.length && !dominios.includes(dominioDe(correo))) {
    throw new ErrorDeIngreso('tu cuenta no es de un dominio de esta organización', `dominio ${dominioDe(correo)} fuera de SITE_AUTH_ALLOWED_DOMAINS`);
  }
}

/**
 * Un proveedor OIDC armado sobre el cliente: `identidad(claims)` → { email, sub } (o tira ErrorDeIngreso) es lo único
 * que cambia de un proveedor a otro.
 */
function proveedorSobreOidc({ nombre, issuer, clientId, clientSecret, redirectUri, ahora, scope, identidad }) {
  const cliente = crearCliente({ issuer, clientId, clientSecret, redirectUri, ahora });
  return {
    nombre,
    emisor: issuer,
    preparar: () => cliente.descubrir(),
    listo: () => cliente.listo(),
    urlDeInicio: ({ state, nonce, challenge }) => cliente.urlDeInicio({ state, nonce, challenge, scope }),
    async completar({ code, verifier, nonce }) {
      const tokens = await cliente.canjear(code, verifier);
      const claims = await cliente.verificarIdToken(tokens.id_token, { nonce });
      return identidad(claims);
    },
  };
}

/** Las variables que este proveedor necesita: [{ variable, motivo }]. */
function problemasDeConfig(env) {
  const p = [];
  if (!env.SITE_OIDC_ISSUER) p.push({ variable: 'SITE_OIDC_ISSUER', motivo: 'falta: el emisor OIDC de la organización (con oidc es obligatorio)' });
  return p;
}

/** El proveedor `oidc` genérico (Okta, Keycloak, Auth0, …). */
function crearGenerico(cfg, { ahora }) {
  const claim = cfg.emailClaim || 'email';
  return proveedorSobreOidc({
    nombre: 'oidc', issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri, ahora,
    identidad(claims) {
      const email = correoDe(claims, claim);
      if (claims.email_verified !== undefined && claims.email_verified !== true) throw new ErrorDeIngreso('el emisor dice que tu correo no está verificado', 'email_verified no es true');
      limitarDominio(email, cfg.allowedDomains);
      if (typeof claims.sub !== 'string' || !claims.sub) throw new ErrorDeIngreso('el emisor no mandó una identidad estable', 'sin sub');
      return { email, sub: claims.sub };
    },
  });
}

module.exports = { ErrorOidc, ErrorDeIngreso, codigoOAuth, pedir, pedirJson, crearCliente, proveedorSobreOidc, crearGenerico, problemasDeConfig, correoDe, limitarDominio, dominioDe, pkceChallenge, CORREO, TOLERANCIA_SEG };
