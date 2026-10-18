'use strict';
/*
 * session.js — la cookie de sesión del sitio de la organización, y la del intento de inicio (story 2.23, decisión 12).
 *
 * Sin estado en el servidor: el sitio puede tener más de una réplica, dormirse o reiniciarse en el medio, y quien entró
 * sigue adentro. Las dos cookies van firmadas con HMAC-SHA256 y `SITE_SESSION_KEY`:
 *
 *   __Host-site   la sesión, 8 horas FIJAS desde que se entró (no se renueva). Lleva el correo (en minúsculas), la
 *                 identidad estable del proveedor (`sub`: oid+tid, sub, o el id de GitHub), el proveedor y el emisor, el
 *                 vencimiento y el token de doble envío (`tok`, story 2.29, AC 3): 32 bytes al azar que nacen con la
 *                 sesión; la pestaña Configuración lo pone en la página y exige que cada escritura lo traiga en
 *                 `X-Site-Token` (la cookie es HttpOnly: el script de otro sitio no lo puede leer). NO lleva el rol: el rol
 *                 se recalcula en cada pedido con la configuración vigente.
 *   __Host-login  el intento de inicio, 10 minutos: state, nonce y el verificador PKCE. Se borra en la vuelta.
 *
 * Una cookie alterada, sin firma, firmada con otra llave, vencida, o de otro proveedor o emisor, es «sin sesión».
 * Atributos: `__Host-` exige Secure, Path=/ y sin Domain; HttpOnly y SameSite=Lax.
 */
const crypto = require('crypto');

const SESION = '__Host-site';
const INTENTO = '__Host-login';
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;
const DURACION_INTENTO_MS = 10 * 60 * 1000;

const b64u = (b) => Buffer.from(b).toString('base64url');

function firmar(carga, llave) {
  const datos = b64u(JSON.stringify(carga));
  return `${datos}.${crypto.createHmac('sha256', llave).update(datos).digest('base64url')}`;
}

/** La carga de un valor firmado, o null si la firma no es la de esta llave o la forma no es la nuestra. */
function verificar(valor, llave) {
  if (typeof valor !== 'string') return null;
  const partes = valor.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const esperada = crypto.createHmac('sha256', llave).update(partes[0]).digest();
  let recibida;
  try { recibida = Buffer.from(partes[1], 'base64url'); } catch { return null; }
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return null;
  try {
    const carga = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    return carga && typeof carga === 'object' && !Array.isArray(carga) ? carga : null;
  } catch { return null; }
}

/** Las cookies de un pedido: { nombre: valor }. Un nombre repetido se queda con el primero, como los navegadores. */
function leerCookies(cabecera) {
  const out = {};
  for (const parte of String(cabecera || '').split(';')) {
    const i = parte.indexOf('=');
    if (i <= 0) continue;
    const nombre = parte.slice(0, i).trim();
    if (!(nombre in out)) out[nombre] = parte.slice(i + 1).trim();
  }
  return out;
}

function cookie(nombre, valor, maxAgeSeg) {
  return `${nombre}=${valor}; Max-Age=${Math.max(0, Math.floor(maxAgeSeg))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
const borrar = (nombre) => `${nombre}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

/** La cookie de una sesión nueva. `ident` = { email, sub, prov, iss }. */
function nuevaSesion(ident, llave, ahora) {
  const carga = { email: String(ident.email).trim().toLowerCase(), sub: String(ident.sub), prov: ident.prov, iss: ident.iss, exp: ahora + DURACION_SESION_MS, tok: b64u(crypto.randomBytes(32)) };
  return cookie(SESION, firmar(carga, llave), DURACION_SESION_MS / 1000);
}

/** La sesión del pedido, o null. Tiene que ser de este proveedor y de este emisor. */
function leerSesion(cookies, llave, ahora, { prov, iss }) {
  const c = verificar(cookies[SESION], llave);
  if (!c || typeof c.email !== 'string' || typeof c.sub !== 'string' || !Number.isFinite(c.exp)) return null;
  if (c.exp <= ahora || c.prov !== prov || c.iss !== iss) return null;
  return c;
}

/** Un intento nuevo: state, nonce y verificador PKCE al azar, con su cookie. */
function nuevoIntento(llave, ahora, { via = null } = {}) {
  // `via`: por cuál puerta del proveedor salió el intento; va firmado, y la vuelta usa ésa
  const it = { state: b64u(crypto.randomBytes(24)), nonce: b64u(crypto.randomBytes(24)), verifier: b64u(crypto.randomBytes(32)), exp: ahora + DURACION_INTENTO_MS, via: typeof via === 'string' ? via : null };
  return { intento: it, challenge: b64u(crypto.createHash('sha256').update(it.verifier).digest()), cookie: cookie(INTENTO, firmar(it, llave), DURACION_INTENTO_MS / 1000) };
}

function leerIntento(cookies, llave, ahora) {
  const it = verificar(cookies[INTENTO], llave);
  if (!it || typeof it.state !== 'string' || typeof it.nonce !== 'string' || typeof it.verifier !== 'string' || !Number.isFinite(it.exp)) return { motivo: 'sin la cookie del intento, o con la firma de otra llave' };
  if (it.exp <= ahora) return { motivo: 'el intento venció (más de 10 minutos)' };
  return { intento: it };
}

module.exports = { SESION, INTENTO, DURACION_SESION_MS, DURACION_INTENTO_MS, firmar, verificar, leerCookies, cookie, borrar, nuevaSesion, leerSesion, nuevoIntento, leerIntento };
