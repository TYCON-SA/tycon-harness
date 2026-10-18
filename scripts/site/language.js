'use strict';
/*
 * language.js — EL IDIOMA DE CADA PEDIDO Y DÓNDE SE RECUERDA.
 *
 * Dos idiomas, cerrados: `es` y `en`. Ningún valor que mande el navegador (preferencia, cookie, `Accept-Language`) se
 * usa tal cual: o es uno de la lista, o no cuenta.
 *
 * EL ORDEN, en cada pedido: la preferencia guardada de la persona con sesión → la cookie `sitio-idioma` → el
 * primer `es*` o `en*` del `Accept-Language` según su `q` → castellano. Hasta que la persona elige, no se guarda nada.
 *
 * DÓNDE SE RECUERDA: en `SITE_DATA_DIR/idiomas.json`, `{ huella: idioma }`. La huella es un HMAC-sha256 del
 * correo de la persona (en minúsculas) con la llave de sesión del sitio: el disco no guarda ningún correo. Quien sale de
 * la lista del sitio pierde su entrada cuando el sitio lee la lista nueva (`podar`). Sin volumen, vale sólo la cookie.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IDIOMAS = Object.freeze(['es', 'en']);
const POR_DEFECTO = 'es';
const COOKIE = 'sitio-idioma';
const ARCHIVO = 'idiomas.json';

const valido = (x) => (typeof x === 'string' && IDIOMAS.includes(x) ? x : null);

/** El primer idioma conocido del `Accept-Language`, por su `q` (el orden de aparición desempata); null si ninguno. */
function delNavegador(cabecera) {
  if (typeof cabecera !== 'string' || !cabecera) return null;
  const opciones = [];
  cabecera.split(',').slice(0, 30).forEach((parte, i) => {
    const [etiqueta, ...params] = parte.trim().split(';');
    const base = String(etiqueta || '').trim().toLowerCase().split('-')[0];
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q) || q <= 0) return;
    if (valido(base)) opciones.push({ idioma: base, q, i });
  });
  opciones.sort((a, b) => b.q - a.q || a.i - b.i);
  return opciones.length ? opciones[0].idioma : null;
}

/** El idioma de un pedido: `persona` (la guardada), `cookie`, `navegador` (la cabecera `Accept-Language`). */
function elegir({ persona = null, cookie = null, navegador = null } = {}) {
  return valido(persona) || valido(cookie) || delNavegador(navegador) || POR_DEFECTO;
}

/** La cookie del idioma: sin datos de la persona, para todo el sitio, `Secure` fuera de la propia máquina. */
function cookieDe(idioma, { https = true } = {}) {
  return `${COOKIE}=${idioma}; Path=/; Max-Age=31536000; SameSite=Lax${https ? '; Secure' : ''}`;
}

/**
 * Las preferencias guardadas. `dataDir` null = sin volumen: no guarda nada, y lo dice una vez en el registro la primera
 * vez que alguien elige. `llave`: la de sesión del sitio (un Buffer).
 */
function crearPreferencias({ dataDir = null, llave, log = () => {} } = {}) {
  const archivo = dataDir ? path.join(dataDir, ARCHIVO) : null;
  let dicho = false;
  let cache = null;
  // el archivo existe y no se pudo leer: no se escribe encima (borraría las preferencias de todos); se vuelve a probar
  // en la próxima escritura
  let ilegible = false;
  let podaAvisada = false;
  const huella = (correo) => crypto.createHmac('sha256', llave).update(String(correo || '').trim().toLowerCase()).digest('hex');

  function leerTodo() {
    if (!archivo) return {};
    if (cache && !ilegible) return cache;
    try {
      const doc = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      const leido = {};
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) for (const [k, v] of Object.entries(doc)) if (/^[0-9a-f]{64}$/.test(k) && valido(v)) leido[k] = v;
      // lo elegido mientras el archivo no se podía leer vale encima de lo leído
      cache = { ...leido, ...(ilegible && cache ? cache : {}) };
      ilegible = false;
    } catch (e) {
      if (e && e.code === 'ENOENT') { cache = cache || {}; ilegible = false; return cache; }
      if (!ilegible) log(`las preferencias de idioma no se pudieron leer (${(e && e.code) || 'ilegible'}): no se escriben hasta poder leerlas; mientras, vale lo elegido en este arranque y el navegador`);
      ilegible = true;
      cache = cache || {};
    }
    return cache;
  }
  function escribir(doc) {
    const tmp = `${archivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, archivo);
  }

  return {
    disponible: Boolean(archivo),
    /** La preferencia de una persona (cualquiera de sus correos: el primero que tenga una). */
    leer(correos) {
      const doc = leerTodo();
      for (const c of [].concat(correos || [])) { const v = doc[huella(c)]; if (v) return v; }
      return null;
    },
    /** Guarda la elección de una persona. Sin volumen, nada (y una línea en el registro, una sola vez). */
    guardar(correo, idioma) {
      if (!valido(idioma)) return false;
      if (!archivo) {
        if (!dicho) { dicho = true; log('el idioma elegido se recuerda sólo en la cookie del navegador: sin SITE_DATA_DIR no hay dónde guardarlo por persona'); }
        return false;
      }
      // la elección vale en este arranque aunque no se pueda guardar: si no, ganaría la preferencia vieja y el selector
      // parecería no hacer nada
      const doc = { ...leerTodo(), [huella(correo)]: idioma };
      cache = doc;
      if (ilegible) return false;
      try {
        escribir(doc);
        return true;
      } catch (e) { log(`no se pudo guardar el idioma elegido (${(e && e.code) || 'error'}): vale hasta que el sitio se reinicie`); return false; }
    },
    /** Deja sólo las entradas de los correos que siguen en la lista del sitio. -1 si no se pudo (se vuelve a probar). */
    podar(correosDeLaLista) {
      if (!archivo) return 0;
      const doc = leerTodo();
      if (ilegible) return -1;
      const quedan = new Set([].concat(correosDeLaLista || []).map(huella));
      const nuevo = Object.fromEntries(Object.entries(doc).filter(([k]) => quedan.has(k)));
      const borradas = Object.keys(doc).length - Object.keys(nuevo).length;
      if (borradas > 0) {
        try { escribir(nuevo); cache = nuevo; podaAvisada = false; } catch (e) {
          // se reintenta en cada pedido, pero se dice una vez (con el disco roto, el registro no se llena)
          if (!podaAvisada) { podaAvisada = true; log(`no se pudieron borrar las preferencias de idioma de quien salió de la lista (${(e && e.code) || 'error'}): se vuelve a probar en cada pedido`); }
          return -1;
        }
      }
      return borradas;
    },
  };
}

module.exports = { IDIOMAS, POR_DEFECTO, COOKIE, ARCHIVO, valido, delNavegador, elegir, cookieDe, crearPreferencias };
