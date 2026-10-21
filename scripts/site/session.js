'use strict';
/*
 * session.js — la cookie de sesión del sitio de la organización, y la del intento de inicio.
 *
 * Sin estado en el servidor: el sitio puede tener más de una réplica, dormirse o reiniciarse en el medio, y quien entró
 * sigue adentro. Las dos cookies van firmadas con HMAC-SHA256 y `SITE_SESSION_KEY`:
 *
 *   __Host-site   la sesión, 8 horas FIJAS desde que se entró (no se renueva). Lleva el correo (en minúsculas), la
 *                 identidad estable del proveedor (`sub`: oid+tid, sub, o el id de GitHub), el proveedor y el emisor, el
 *                 vencimiento y el token de doble envío (`tok`): 32 bytes al azar que nacen con la
 *                 sesión; la pestaña Configuración lo pone en la página y exige que cada escritura lo traiga en
 *                 `X-Site-Token` (la cookie es HttpOnly: el script de otro sitio no lo puede leer). NO lleva el rol: el rol
 *                 se recalcula en cada pedido con la configuración vigente.
 *   __Host-login  el intento de inicio, 10 minutos: state, nonce y el verificador PKCE. Se borra en la vuelta.
 *   __Host-salio  la marca de «salió», 30 días, valor fijo `1` (sin firma ni datos de la persona). La deja «Salir» y la
 *                 borra la vuelta que crea una sesión. Con ella y sin sesión, el sitio no vuelve a entrar solo: muestra
 *                 «Saliste» y, al entrar, pide elegir la cuenta (Casos: scripts/tests/site-sign-out-mark.test.js).
 *
 * Una cookie alterada, sin firma, firmada con otra llave, vencida, o de otro proveedor o emisor, es «sin sesión».
 * Atributos: `__Host-` exige Secure, Path=/ y sin Domain; HttpOnly y SameSite=Lax.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESION = '__Host-site';
const INTENTO = '__Host-login';
const DURACION_SESION_MS = 8 * 60 * 60 * 1000;
const DURACION_INTENTO_MS = 10 * 60 * 1000;
const MARCA = '__Host-salio';
const DURACION_MARCA_MS = 30 * 24 * 60 * 60 * 1000;

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
const marcaDeSalida = () => cookie(MARCA, '1', DURACION_MARCA_MS / 1000);
const tieneMarca = (cookies) => Boolean(cookies) && cookies[MARCA] === '1';

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

const CARPETA_CERRADAS = 'sesiones-cerradas';
const PODA_CADA_MS = 10 * 60 * 1000;
const AVISO_CADA_MS = 60 * 1000;
// el aviso a quien mantiene sigue arriba de las pestañas hasta 5 minutos después del último fallo: no parpadea con cada pedido
const VERIFICABLE_TRAS_MS = 5 * 60 * 1000;
const huellaDe = (tok) => crypto.createHash('sha256').update(String(tok)).digest('hex');
const ES_HUELLA = /^[0-9a-f]{64}$/;

/**
 * La lista de sesiones cerradas: «Salir» crea un archivo en `<dataDir>/sesiones-cerradas/` cuyo nombre es la huella (sha256)
 * del `tok` de la sesión y cuyo contenido es su vencimiento. Una cookie cuyo `tok` tiene archivo no entra aunque su firma
 * valga. Un archivo por sesión: dos cierres a la vez (de una o de varias réplicas sobre el mismo disco) no se pisan, y
 * cada pedido mira un solo archivo en vez de recorrer la lista. Un archivo que existe pero no se puede leer cuenta como
 * cerrado. Al cerrar se borran, como mucho cada diez minutos, los archivos vencidos. Sin `dataDir` la lista vive en
 * memoria: bloquea en este proceso, pero `cerrar` devuelve false porque un reinicio la pierde.
 */
function crearCerradas({ dataDir = null, ahora = Date.now, log = () => {} } = {}) {
  const carpeta = dataDir ? path.join(dataDir, CARPETA_CERRADAS) : null;
  const memoria = new Map();
  let ultimaPoda = -Infinity;
  let ultimoAviso = -Infinity;
  // si la última consulta pudo mirar la carpeta: con la carpeta ilegible la sesión entra igual (abrir es mejor que dejar
  // el sitio sin entrada) y quien mantiene lo ve arriba de las pestañas
  let ultimoFallo = -Infinity;

  // a lo sumo una línea por minuto: un disco caído no llena el registro con un renglón por pedido
  function avisar(linea) {
    const t = ahora();
    if (t - ultimoAviso < AVISO_CADA_MS) return;
    ultimoAviso = t;
    log(linea);
  }

  // el vencimiento de un archivo: sólo un entero positivo vale (Number('') es 0, y un archivo vacío no es «vencido en 1970»);
  // cualquier otra cosa es ilegible: la sesión sigue cerrada y el archivo se poda por su fecha
  const venceEn = (archivo) => {
    try { const t = fs.readFileSync(archivo, 'utf8').trim(); return /^[1-9]\d*$/.test(t) ? Number(t) : null; } catch { return null; }
  };

  function podar() {
    const t = ahora();
    if (t - ultimaPoda < PODA_CADA_MS) return;
    ultimaPoda = t;
    let nombres;
    try { nombres = fs.readdirSync(carpeta); } catch (e) {
      if (e && e.code !== 'ENOENT') avisar(`la lista de sesiones cerradas no se pudo podar (${e.code || 'error'}): los vencidos quedan en el disco`);
      return;
    }
    for (const n of nombres) {
      const archivo = path.join(carpeta, n);
      try {
        if (ES_HUELLA.test(n)) {
          const exp = venceEn(archivo);
          if (exp !== null ? exp <= t : fs.statSync(archivo).mtimeMs < t - DURACION_SESION_MS) fs.rmSync(archivo, { force: true });
        } else if (n.endsWith('.tmp') && fs.statSync(archivo).mtimeMs < t - DURACION_SESION_MS) fs.rmSync(archivo, { force: true });
      } catch (e) {
        if (e && e.code !== 'ENOENT') avisar(`la lista de sesiones cerradas no se pudo podar (${e.code || 'error'}): los vencidos quedan en el disco`);
      }
    }
  }

  return {
    /** Anota la sesión como cerrada. true sólo si el archivo quedó en el disco; false = no se pudo (la cookie del navegador se borra igual). */
    cerrar(ses) {
      if (!ses || typeof ses.tok !== 'string' || !ses.tok || !Number.isFinite(ses.exp)) return false;
      const huella = huellaDe(ses.tok);
      if (!carpeta) { memoria.set(huella, ses.exp); return false; }
      const destino = path.join(carpeta, huella);
      const tmp = `${destino}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.mkdirSync(carpeta, { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, String(ses.exp), { mode: 0o600 });
        fs.renameSync(tmp, destino);
        if (!fs.existsSync(destino)) throw Object.assign(new Error('falta'), { code: 'falta' });
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ya no está */ }
        avisar(`la lista de sesiones cerradas no se pudo escribir (${(e && e.code) || 'error'}): una sesión cerrada podría seguir valiendo con una copia de la cookie`);
        return false;
      }
      podar();
      return true;
    },
    /** ¿La sesión salió? Mira sólo el archivo de su huella. Si la carpeta no se puede leer, no se sabe: vale como no cerrada. */
    cerrada(ses) {
      if (!ses || typeof ses.tok !== 'string' || !ses.tok) return false;
      const huella = huellaDe(ses.tok);
      if (!carpeta) {
        const exp = memoria.get(huella);
        if (exp === undefined) return false;
        if (exp <= ahora()) { memoria.delete(huella); return false; }
        return true;
      }
      const archivo = path.join(carpeta, huella);
      try { fs.statSync(archivo); } catch (e) {
        if (!e || e.code !== 'ENOENT') { ultimoFallo = ahora(); avisar(`la lista de sesiones cerradas no se pudo leer (${(e && e.code) || 'error'}): no se sabe qué sesiones salieron`); }
        return false;
      }
      // existe: cerrada, aunque su contenido no se lea; sólo un vencimiento legible y pasado la deja entrar a podar
      const exp = venceEn(archivo);
      if (exp !== null && exp <= ahora()) { try { fs.rmSync(archivo, { force: true }); } catch { /* otro proceso */ } return false; }
      return true;
    },
    /** ¿La última consulta pudo mirar la lista? false = una sesión cerrada podría estar entrando. */
    verificable() { return ahora() - ultimoFallo >= VERIFICABLE_TRAS_MS; },
  };
}

module.exports = { CARPETA_CERRADAS, crearCerradas, SESION, INTENTO, MARCA, DURACION_SESION_MS, DURACION_INTENTO_MS, DURACION_MARCA_MS, marcaDeSalida, tieneMarca, firmar, verificar, leerCookies, cookie, borrar, nuevaSesion, leerSesion, nuevoIntento, leerIntento };
