'use strict';
/*
 * fake-gcs.js — un Cloud Storage de mentira para las pruebas del buzón gcs (scripts/tests/mailbox-gcs.test.js).
 *
 * Un servidor node:http en 127.0.0.1 que imita lo que usa el conector integrations/gcs/:
 *   · la API XML con una clave HMAC: el PUT de un objeto y el listado de prueba (GET del bucket). Verifica la firma
 *     GOOG4-HMAC-SHA256 con su propia receta, a partir del secreto de prueba: una firma que no casa es 403
 *     SignatureDoesNotMatch. Con `x-goog-if-generation-match: 0` y el objeto ya guardado contesta 412
 *     PreconditionFailed; un Content-MD5 que no casa con el cuerpo es 400 BadDigest;
 *   · la API JSON con un token Bearer: el listado paginado (`pageToken`, `nextPageToken`) y la bajada con `alt=media`;
 *   · el servidor de metadatos: el token de la identidad del entorno, con `Metadata-Flavor: Google`.
 * Cada pedido queda anotado en `pedidos` (método, ruta, consulta, cabeceras, bytes, si la firma valió). Lo que contesta
 * se cambia en `modo` (ver `crear`). `colgado()` arranca otro servidor que acepta la conexión y nunca contesta.
 *
 * La receta de la firma acá está escrita aparte de la del conector a propósito: si las dos compartieran un error, la
 * prueba pasaría y Cloud Storage lo rechazaría. Esa diferencia la cubre la prueba en vivo contra el bucket de laboratorio.
 */
const http = require('http');
const crypto = require('crypto');

const ERRORES = {
  AccessDenied: [403, 'AccessDenied'],
  SignatureDoesNotMatch: [403, 'SignatureDoesNotMatch'],
  KeyInactive: [401, 'KeyInactive'],
  NoSuchBucket: [404, 'NoSuchBucket'],
  BadDigest: [400, 'BadDigest'],
  PreconditionFailed: [412, 'PreconditionFailed'],
  NoSuchKey: [404, 'NoSuchKey'],
  503: [503, 'ServiceUnavailable'],
  429: [429, 'SlowDown'],
  408: [408, 'RequestTimeout'],
};

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** La firma que espera Cloud Storage para un pedido, recalculada con el secreto. */
function firmaEsperada(req, u, secreto) {
  const auth = String(req.headers.authorization || '');
  const m = /^GOOG4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/storage\/goog4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return { valida: false, motivo: 'sin cabecera Authorization GOOG4' };
  const [, accessId, dia, firmadas, firma] = m;
  const fecha = String(req.headers['x-goog-date'] || '');
  if (!fecha.startsWith(dia)) return { valida: false, motivo: 'la fecha del alcance no es la de x-goog-date' };
  const cab = firmadas.split(';');
  for (const c of ['host', 'x-goog-date', 'x-goog-content-sha256']) if (!cab.includes(c)) return { valida: false, motivo: `${c} sin firmar` };
  const canonCab = cab.map((c) => `${c}:${String(req.headers[c] === undefined ? '' : req.headers[c]).trim()}\n`).join('');
  const ruta = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
  const consulta = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonico = [req.method, ruta, consulta, canonCab, firmadas, String(req.headers['x-goog-content-sha256'] || '')].join('\n');
  const alcance = `${dia}/auto/storage/goog4_request`;
  const aFirmar = ['GOOG4-HMAC-SHA256', fecha, alcance, crypto.createHash('sha256').update(canonico).digest('hex')].join('\n');
  let k = hmac(`GOOG4${secreto}`, dia);
  for (const p of ['auto', 'storage', 'goog4_request']) k = hmac(k, p);
  const esperada = crypto.createHmac('sha256', k).update(aFirmar).digest('hex');
  return { valida: esperada === firma, accessId, firmadas, motivo: esperada === firma ? null : 'la firma no casa' };
}

/**
 * El doble. `modo` (se cambia en cualquier momento):
 *   listado      la respuesta al listado XML de prueba: 'AccessDenied' (la de una llave que sólo crea), 'ok' (200),
 *                otro nombre de ERRORES, o 'corte' (corta la conexión sin responder)
 *   forzar       { '<parte del nombre del objeto>': '<nombre de ERRORES>' | 'corte' }: lo que contesta un PUT de ese objeto
 *   pisar        lo que contesta un PUT SIN precondición de un objeto que ya está: 'AccessDenied' (la cuenta no puede
 *                borrar) u 'ok' (lo pisa)
 *   json         la respuesta del listado JSON: 'ok', '401', '403' o '404'
 *   media        la respuesta a la bajada de un objeto (?alt=media): 'ok', '401', '403', '500' o 'inflado' (sirve 32 MB
 *                para un objeto listado con pocos bytes, como la transcodificación de un objeto con Content-Encoding gzip;
 *                `servidos` cuenta lo que llegó a escribir)
 *   leerXml      lo que contesta un GET firmado de un objeto por la API XML: 'AccessDenied' (la cuenta sólo crea) u 'ok'
 *                (la cuenta lee por nombre: el objeto, o 404 NoSuchKey si no está)
 *   pagina       cuántos objetos trae cada página del listado JSON
 *   metadatos    'ok' o '404'
 */
function crear({ bucket, accessId, secreto, token = 'token-de-prueba' }) {
  const pedidos = [];
  const objetos = new Map();   // nombre → { cuerpo, md5, creado }
  const modo = { listado: 'AccessDenied', forzar: {}, pisar: 'AccessDenied', json: 'ok', media: 'ok', pagina: 1000, metadatos: 'ok', leerXml: 'AccessDenied' };
  const cuenta = { servidos: 0 };
  const xmlError = (res, clave) => {
    const [status, code] = ERRORES[clave];
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version='1.0' encoding='UTF-8'?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  };
  const jsonError = (res, status) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: status, message: `error ${status}` } })); };

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://doble');
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => {
      const cuerpo = Buffer.concat(trozos);
      const p = { metodo: req.method, ruta: decodeURIComponent(u.pathname), consulta: u.search, cabeceras: { ...req.headers }, bytes: cuerpo.length, sha256: crypto.createHash('sha256').update(cuerpo).digest('hex') };
      pedidos.push(p);

      // el servidor de metadatos
      if (u.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') {
        if (req.headers['metadata-flavor'] !== 'Google') { res.writeHead(403); return res.end('falta Metadata-Flavor'); }
        if (modo.metadatos !== 'ok') { res.writeHead(404); return res.end('sin cuenta de servicio'); }
        res.writeHead(200, { 'content-type': 'application/json', 'metadata-flavor': 'Google' });
        return res.end(JSON.stringify({ access_token: token, expires_in: 3599, token_type: 'Bearer' }));
      }

      // la API JSON (el sitio)
      if (u.pathname.startsWith('/storage/v1/b/')) {
        if (req.headers.authorization !== `Bearer ${token}`) return jsonError(res, 401);
        const resto = u.pathname.slice('/storage/v1/b/'.length).split('/');
        if (decodeURIComponent(resto[0]) !== bucket) return jsonError(res, 404);
        if (resto[1] !== 'o') return jsonError(res, 404);
        if (resto.length === 2) {
          if (modo.json !== 'ok') return jsonError(res, Number(modo.json));
          const prefijo = u.searchParams.get('prefix') || '';
          const nombres = [...objetos.keys()].filter((n) => n.startsWith(prefijo)).sort();
          const desde = Number(u.searchParams.get('pageToken') || 0);
          const tam = Math.min(modo.pagina, Number(u.searchParams.get('maxResults') || 1000));
          const items = nombres.slice(desde, desde + tam).map((n) => {
            const o = objetos.get(n);
            return { name: n, size: String(o.cuerpo.length), md5Hash: o.md5, etag: `e-${o.md5}`, timeCreated: o.creado, updated: o.creado };
          });
          const doc = { kind: 'storage#objects', items };
          if (desde + tam < nombres.length) doc.nextPageToken = String(desde + tam);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(doc));
        }
        const nombre = decodeURIComponent(resto.slice(2).join('/'));
        if (u.searchParams.get('alt') !== 'media') return jsonError(res, 400);
        if (modo.media === 'inflado') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          const trozo = Buffer.alloc(1024 * 1024, 0x20);
          let i = 0;
          const dar = () => { while (i < 32) { i += 1; cuenta.servidos += trozo.length; if (!res.write(trozo)) { res.once('drain', dar); return; } } res.end(); };
          res.on('close', () => { i = 32; });
          return dar();
        }
        if (modo.media !== 'ok') return jsonError(res, Number(modo.media));
        const o = objetos.get(nombre);
        if (!o) return jsonError(res, 404);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(o.cuerpo);
      }

      // la API XML (la subida, con la clave HMAC)
      const f = firmaEsperada(req, u, secreto);
      p.firmaValida = f.valida;
      p.firmadas = f.firmadas || null;
      const partes = u.pathname.split('/').slice(1).map(decodeURIComponent);
      if (partes[0] !== bucket) return xmlError(res, 'NoSuchBucket');
      if (!f.valida || f.accessId !== accessId) return xmlError(res, 'SignatureDoesNotMatch');
      if (req.method === 'GET' && partes.length === 1) {
        if (modo.listado === 'corte') return req.socket.destroy();
        if (modo.listado === 'ok') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version='1.0' encoding='UTF-8'?><ListBucketResult><Name>${bucket}</Name></ListBucketResult>`); }
        return xmlError(res, modo.listado);
      }
      if (req.method === 'GET' && partes.length >= 2 && modo.leerXml === 'ok') {
        const o = objetos.get(partes.slice(1).join('/'));
        if (!o) return xmlError(res, 'NoSuchKey');
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(o.cuerpo);
      }
      if (req.method !== 'PUT' || partes.length < 2) return xmlError(res, 'AccessDenied');
      const nombre = partes.slice(1).join('/');
      p.objeto = nombre;
      p.precondicion = req.headers['x-goog-if-generation-match'] === undefined ? null : String(req.headers['x-goog-if-generation-match']);
      for (const [parte, clave] of Object.entries(modo.forzar)) {
        if (!nombre.includes(parte)) continue;
        if (clave === 'corte') return req.socket.destroy();
        return xmlError(res, clave);
      }
      const md5 = crypto.createHash('md5').update(cuerpo).digest('base64');
      if (req.headers['content-md5'] !== md5) return xmlError(res, 'BadDigest');
      const ya = objetos.has(nombre);
      if (p.precondicion === '0' && ya) return xmlError(res, 'PreconditionFailed');
      if (p.precondicion === null && ya && modo.pisar !== 'ok') return xmlError(res, modo.pisar);
      // stable-data: la hora de creación y la generación del objeto sólo identifican la escritura; ninguna prueba compara su valor
      objetos.set(nombre, { cuerpo, md5, creado: new Date().toISOString() });
      res.writeHead(200, { etag: `"${md5}"`, 'x-goog-generation': String(Date.now()) });
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    resolve({
      url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, pedidos, objetos, modo,
      /** Los bytes que llegó a escribir la bajada inflada. */
      get servidos() { return cuenta.servidos; },
      /** Guarda un objeto en el bucket, como si alguien lo hubiera subido. */
      poner(nombre, cuerpo) { const b = Buffer.from(cuerpo); objetos.set(nombre, { cuerpo: b, md5: crypto.createHash('md5').update(b).digest('base64'), creado: new Date().toISOString() }); },
      cerrar: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }),
    });
  }));
}

/** Un servidor que acepta la conexión y nunca contesta (un servidor de metadatos colgado). */
function colgado() {
  const sockets = new Set();
  const srv = http.createServer(() => { /* nunca contesta */ });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    resolve({ host: `127.0.0.1:${port}`, cerrar: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }) });
  }));
}

module.exports = { crear, colgado, firmaEsperada, ERRORES };
