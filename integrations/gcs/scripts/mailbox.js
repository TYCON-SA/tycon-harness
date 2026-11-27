'use strict';
/*
 * mailbox.js — el buzón de ejecuciones sobre Google Cloud Storage: el conector de tipo `mailbox` del proveedor `gcs`.
 *
 * El núcleo (scripts/lib/integrations.js → mailboxConnector) lo carga por su proveedor y le pide:
 *
 *   · del perfil del equipo: `problemasDelBuzon(mb)` → `[{ path, message }]` (sus campos de `site.mailbox`, además de
 *     provider y threads, los dice el manifiesto en `mailboxFields`: el lector del perfil los lee sin cargar este guion);
 *   · de la llave de las máquinas (corridas-buzon.json): `validarLlave(cfg, ruta)` → `{ cfg }` o
 *     `{ estado: 'config_ilegible', motivo }`. Ningún motivo repite un valor de la llave: el secreto podría estar en
 *     cualquier campo mal puesto;
 *   · de la subida (scripts/metrics/upload-runs.js): `almacenDeSubida(cfg, { urlBase })` → `{ destino, probarListado,
 *     poner, clasificar, pisada }`. La cuenta de servicio sólo tiene storage.objects.create: cada PUT lleva
 *     `x-goog-if-generation-match: 0` (no pisar vale aunque el permiso dejara) y Content-MD5, firmado con
 *     GOOG4-HMAC-SHA256 con la clave HMAC, sin SDK. Antes de cada tanda, el listado de prueba: una llave que puede
 *     listar no es la del buzón;
 *   · del sitio (scripts/site/sources.js): `PROVEEDORES_DE_BUZON`, `bajarBuzon(opts)` y `bajarUnaCorrida(opts)`, con la
 *     misma forma que scripts/site/cloud/azure.js. El sitio corre en Cloud Run con `SITE_MAILBOX_IDENTITY=managed`: el
 *     token sale del servidor de metadatos de su entorno (tope de 2 s: fuera de GCP no hay identidad y se dice
 *     `sin_configurar`), y la lista y la bajada van por la API JSON con el rol de lector del bucket. La bajada en sí es
 *     la de siempre (`bajar()` de scripts/metrics/download-runs.js), con el almacén de este conector: el espejo queda en
 *     las mismas rutas que con Azure. `GCE_METADATA_HOST` cambia el host del servidor de metadatos (la variable de las
 *     librerías de Google; las pruebas apuntan a su doble);
 *   · de la bajada de una máquina (scripts/metrics/download-runs.js, por `almacenDeBajadaDeLaLlave` de upload-runs.js):
 *     `almacenDeBajada(cfg, { urlBase })` → `{ destino, listar, leer }`, con el token de la sesión de gcloud de la persona
 *     (`gcloud auth print-access-token`, sin preguntar; `TYCON_GCLOUD_BIN` reemplaza el binario) y el mismo listado y la
 *     misma lectura que el sitio. Sin gcloud, sin sesión o sin el rol (403), el listado contesta `permiso: true`.
 *
 * Los códigos de respuesta son los medidos en el bucket de laboratorio (ver la guía). Casos:
 * scripts/tests/mailbox-gcs.test.js.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');

const PROVIDER = 'gcs';
const PROVEEDORES_DE_BUZON = Object.freeze([PROVIDER]);
// el nombre de un bucket: 3 a 63 minúsculas, números, guiones, guiones bajos o puntos; empieza y termina en letra o número
const FORMA_BUCKET = /^[a-z0-9](?:[a-z0-9._-]{1,61})[a-z0-9]$/;
const FORMA_ACCESS_ID = /^[A-Za-z0-9]{16,128}$/;
const FORMA_SECRETO = /^[A-Za-z0-9+/]{20,128}={0,2}$/;
const HOST_DE_STORAGE = 'https://storage.googleapis.com';
const HOST_DE_METADATOS = 'metadata.google.internal';
const TOPE_METADATOS_MS = 2000;
// las mil páginas de la bajada de Azure (scripts/metrics/download-runs.js → listarTodo)
const TOPE_PAGINAS = 1000;
// lo más que se lee de un objeto que no salió en el listado de este almacén (los que salieron se cortan en su `size`)
const TOPE_SIN_LISTAR = 256 * 1024 * 1024;
const BAJADA = path.join(__dirname, '..', '..', '..', 'scripts', 'metrics', 'download-runs.js');

const esTexto = (v) => typeof v === 'string' && v.trim() !== '';
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`)) && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
// RFC 3986: lo que encodeURIComponent deja sin codificar y la firma no acepta
const codificar = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// ── el perfil del equipo ──────────────────────────────────────────────────────────────────────────────────────────

/** Los problemas de los campos de gcs en `site.mailbox` (las claves permitidas las mira el núcleo). */
function problemasDelBuzon(mb) {
  if (typeof mb.bucket === 'string' && FORMA_BUCKET.test(mb.bucket)) return [];
  return [{ path: 'site.mailbox.bucket', message: 'tiene que tener la forma de un bucket de Cloud Storage (3 a 63 minúsculas, números, guiones, guiones bajos o puntos; empieza y termina en letra o número)' }];
}

// ── la llave ──────────────────────────────────────────────────────────────────────────────────────────────────────

const CAMPOS_DE_LA_LLAVE = ['provider', 'bucket', 'accessId', 'secret', 'vence', 'rotar'];

/** `{ cfg }` con la llave limpia y `destino` (`gcs/<bucket>`), o `{ estado: 'config_ilegible', motivo }` sin valores. */
function validarLlave(cfg, ruta) {
  const no = (motivo) => ({ estado: 'config_ilegible', motivo: `${ruta}: ${motivo}` });
  // el campo de más no se nombra: su nombre también podría ser el secreto mal puesto
  for (const k of Object.keys(cfg)) if (!k.startsWith('__') && !CAMPOS_DE_LA_LLAVE.includes(k)) return no(`hay un campo que no es de una llave gcs (los campos son ${CAMPOS_DE_LA_LLAVE.join(', ')}; el nombre no se muestra)`);
  for (const k of ['bucket', 'accessId', 'secret', 'vence']) if (!esTexto(cfg[k])) return no(`falta "${k}" (texto)`);
  const bucket = cfg.bucket.trim();
  if (!FORMA_BUCKET.test(bucket)) return no('"bucket" no tiene la forma de un bucket de Cloud Storage');
  if (!FORMA_ACCESS_ID.test(cfg.accessId.trim())) return no('"accessId" no tiene la forma del id de una clave HMAC');
  if (!FORMA_SECRETO.test(cfg.secret.trim())) return no('"secret" no tiene la forma del secreto de una clave HMAC (el valor no se muestra)');
  if (!fechaValida(cfg.vence.trim())) return no('"vence" tiene que ser una fecha AAAA-MM-DD: la fecha de rotación que fija el equipo');
  const rotar = cfg.rotar;
  if (!(esTexto(rotar) || (Array.isArray(rotar) && rotar.length && rotar.every(esTexto)))) return no('falta "rotar": los pasos para rotar la llave (un texto o una lista de textos)');
  return { cfg: { provider: PROVIDER, bucket, accessId: cfg.accessId.trim(), secret: cfg.secret.trim(), vence: cfg.vence.trim(), rotar, destino: `${PROVIDER}/${bucket}` } };
}

// ── la firma ──────────────────────────────────────────────────────────────────────────────────────────────────────

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

/**
 * Las cabeceras de un pedido firmado con GOOG4-HMAC-SHA256: las dadas, `host`, `x-goog-date`, `x-goog-content-sha256`
 * (UNSIGNED-PAYLOAD) y `authorization`. Se firman todas las que se pasan. `ruta` es el camino ya codificado.
 */
function firmar({ metodo, host, ruta, consulta = [], cabeceras = {}, accessId, secret, ahora = new Date() }) {
  const fecha = ahora.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dia = fecha.slice(0, 8);
  const h = {};
  for (const [k, v] of Object.entries(cabeceras)) h[k.toLowerCase()] = String(v);
  Object.assign(h, { host, 'x-goog-date': fecha, 'x-goog-content-sha256': 'UNSIGNED-PAYLOAD' });
  const nombres = Object.keys(h).sort();
  const canonCab = nombres.map((n) => `${n}:${h[n].trim()}\n`).join('');
  const firmadas = nombres.join(';');
  const canonConsulta = consulta.map(([k, v]) => [codificar(k), codificar(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonico = [metodo, ruta, canonConsulta, canonCab, firmadas, 'UNSIGNED-PAYLOAD'].join('\n');
  const alcance = `${dia}/auto/storage/goog4_request`;
  const aFirmar = ['GOOG4-HMAC-SHA256', fecha, alcance, crypto.createHash('sha256').update(canonico).digest('hex')].join('\n');
  let k = hmac(`GOOG4${secret}`, dia);
  for (const p of ['auto', 'storage', 'goog4_request']) k = hmac(k, p);
  const firma = crypto.createHmac('sha256', k).update(aFirmar).digest('hex');
  h.authorization = `GOOG4-HMAC-SHA256 Credential=${accessId}/${alcance}, SignedHeaders=${firmadas}, Signature=${firma}`;
  return h;
}

/**
 * Un pedido HTTP: `{ status, cuerpo, cabeceras }` o `{ error }`; nunca rechaza. `topeMs` corta todo el pedido.
 * `topeBytes` corta la respuesta apenas pasa ese largo: el cuerpo llega con `topeBytes + 1` bytes y `excedido: true`, y
 * lo que sigue no se lee.
 */
function pedir(url, { metodo = 'GET', cabeceras = {}, cuerpo = null, timeoutMs = 60000, topeMs = null, topeBytes = null } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { resolve({ error: e }); return; }
    let hecho = false;
    let reloj = null;
    const fin = (r) => { if (!hecho) { hecho = true; if (reloj) clearTimeout(reloj); resolve(r); } };
    const req = (u.protocol === 'http:' ? http : https).request(u, { method: metodo, headers: cabeceras, timeout: timeoutMs }, (res) => {
      const trozos = [];
      let largo = 0;
      res.on('data', (c) => {
        if (hecho) return;
        trozos.push(c);
        largo += c.length;
        if (topeBytes !== null && largo > topeBytes) {
          fin({ status: res.statusCode, cuerpo: Buffer.concat(trozos).subarray(0, topeBytes + 1), cabeceras: res.headers, excedido: true });
          req.destroy();
        }
      });
      res.on('end', () => fin({ status: res.statusCode, cuerpo: Buffer.concat(trozos), cabeceras: res.headers }));
      res.on('error', (e) => fin({ error: e }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => fin({ error: e }));
    if (topeMs) reloj = setTimeout(() => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); fin({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }); }, topeMs);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

const codigoXml = (cuerpo) => ((cuerpo ? cuerpo.toString('utf8') : '').match(/<Code>([^<]*)<\/Code>/) || [])[1] || null;
const esDelServicio = (status) => status >= 500 || status === 429 || status === 408;

// ── la subida ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * El almacén de la subida para una llave gcs ya validada. `urlBase` (las pruebas) reemplaza el host de Cloud Storage.
 *   · probarListado() → `{ ok: true }` (403 AccessDenied al listar y al leer un objeto por su nombre: la llave sólo
 *     crea) o `{ codigo, estado, motivo }`;
 *   · poner(nombre, cuerpo, md5, timeoutMs, { pisar }) → `{ status, codigo }` o `{ error }`; sin `pisar`, con la
 *     precondición de no pisar;
 *   · clasificar(r) → `{ tipo, motivo? }`, con el vocabulario de la subida (creado, ya_existe, sin_permiso, llave,
 *     servicio, otro);
 *   · pisada(r) → 'no_pisa' (403 AccessDenied: la cuenta no puede borrar) · 'piso' (200) · null.
 */
function almacenDeSubida(cfg, { urlBase = null } = {}) {
  const base = String(urlBase || HOST_DE_STORAGE).replace(/\/+$/, '');
  const host = new URL(base).host;
  const prefijo = new URL(base).pathname.replace(/\/+$/, '');
  const rutaDe = (nombre) => `${prefijo}/${codificar(cfg.bucket)}${nombre ? `/${nombre.split('/').map(codificar).join('/')}` : ''}`;
  const firmado = (metodo, ruta, consulta, cabeceras) => firmar({ metodo, host, ruta, consulta, cabeceras, accessId: cfg.accessId, secret: cfg.secret });
  const url = (ruta, consulta = []) => `${base.slice(0, base.length - prefijo.length)}${ruta}${consulta.length ? `?${consulta.map(([k, v]) => `${codificar(k)}=${codificar(v)}`).join('&')}` : ''}`;

  async function probarListado() {
    const ruta = rutaDe('');
    const consulta = [['max-keys', '1']];
    const r = await pedir(url(ruta, consulta), { cabeceras: firmado('GET', ruta, consulta, {}), timeoutMs: 30000 });
    if (r.error) return { codigo: 1, estado: 'sin_red', motivo: `sin red o sin respuesta del buzón al probar la llave (${r.error.code || r.error.message}): no se sube nada` };
    const codigo = codigoXml(r.cuerpo);
    const visto = `${r.status}${codigo ? ` ${codigo}` : ''}`;
    if (r.status === 403 && codigo === 'AccessDenied') return probarLectura();
    if (r.status === 200) return { codigo: 2, estado: 'llave_con_lectura', motivo: `la llave del buzón puede listar el bucket ${cfg.bucket} (${visto}): sólo se acepta una cuenta con storage.objects.create. No se sube nada` };
    if (r.status === 404) return { codigo: 1, estado: 'llave_invalida', motivo: `el bucket ${cfg.bucket} no existe o la llave no lo ve (${visto}): revisar "bucket" en corridas-buzon.json. No se sube nada` };
    if (r.status === 401 || r.status === 403) return { codigo: 1, estado: 'llave_invalida', motivo: `el buzón rechazó la llave (${visto}): desactivada, borrada o inválida — hay que rotarla (corridas-buzon.json → "rotar", vence ${cfg.vence}). No se sube nada` };
    if (esDelServicio(r.status)) return { codigo: 1, estado: 'servicio_fallo', motivo: `el servicio del buzón falló al probar la llave (${visto}): se reintenta en el próximo arranque` };
    return { codigo: 1, estado: 'otro', motivo: `el buzón contestó ${visto} al probar la llave: no se sube nada` };
  }

  // Una cuenta con storage.objects.get y sin storage.objects.list no lista, pero lee cualquier objeto cuyo nombre sepa: la
  // llave de las máquinas tampoco puede leer. Se pide por la API XML un nombre que no existe: la que sólo crea contesta
  // 403 AccessDenied; la que lee, 404 NoSuchKey
  async function probarLectura() {
    const ruta = rutaDe(`tycon-sonda-de-lectura-${crypto.randomBytes(8).toString('hex')}`);
    const r = await pedir(url(ruta), { cabeceras: firmado('GET', ruta, [], {}), timeoutMs: 30000, topeBytes: 64 * 1024 });
    if (r.error) return { codigo: 1, estado: 'sin_red', motivo: `sin red o sin respuesta del buzón al probar la llave (${r.error.code || r.error.message}): no se sube nada` };
    const codigo = codigoXml(r.cuerpo);
    const visto = `${r.status}${codigo ? ` ${codigo}` : ''}`;
    if (r.status === 403 && codigo === 'AccessDenied') return { ok: true };
    if (r.status === 404 || r.status === 200) return { codigo: 2, estado: 'llave_con_lectura', motivo: `la llave del buzón puede leer objetos del bucket ${cfg.bucket} por su nombre (${visto}): sólo se acepta una cuenta con storage.objects.create. No se sube nada` };
    if (esDelServicio(r.status)) return { codigo: 1, estado: 'servicio_fallo', motivo: `el servicio del buzón falló al probar la llave (${visto}): se reintenta en el próximo arranque` };
    return { codigo: 1, estado: 'otro', motivo: `el buzón contestó ${visto} al probar si la llave lee: no se sube nada` };
  }

  function poner(nombre, cuerpo, md5, timeoutMs, { pisar = false } = {}) {
    const ruta = rutaDe(nombre);
    const aFirmar = { 'content-md5': md5 };
    if (pisar !== true) aFirmar['x-goog-if-generation-match'] = '0';
    const cabeceras = { ...firmado('PUT', ruta, [], aFirmar), 'content-length': String(cuerpo.length), 'content-type': 'application/octet-stream' };
    return pedir(url(ruta), { metodo: 'PUT', cabeceras, cuerpo, timeoutMs }).then((r) => (r.error ? r : { status: r.status, codigo: codigoXml(r.cuerpo) }));
  }

  function clasificar(r) {
    if (r.status === 200) return { tipo: 'creado' };
    if (r.status === 412) return { tipo: 'ya_existe' };
    if (r.status === 403 && r.codigo === 'AccessDenied') return { tipo: 'sin_permiso' };
    if (r.status === 404) return { tipo: 'llave', motivo: `el bucket ${cfg.bucket} no existe o la llave no lo ve (404${r.codigo ? ` ${r.codigo}` : ''}): revisar "bucket" en corridas-buzon.json` };
    if (r.status === 401 || r.status === 403) return { tipo: 'llave' };
    if (r.status === 400 && r.codigo === 'BadDigest') return { tipo: 'otro', motivo: 'el contenido no llegó entero (400 BadDigest): el Content-MD5 no coincide con lo que recibió el buzón' };
    if (esDelServicio(r.status)) return { tipo: 'servicio' };
    return { tipo: 'otro' };
  }

  function pisada(r) {
    if (r.status === 403 && r.codigo === 'AccessDenied') return 'no_pisa';
    if (r.status === 200) return 'piso';
    return null;
  }

  return { destino: cfg.destino, probarListado, poner, clasificar, pisada };
}

// ── el sitio ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** El token de la identidad del entorno: `{ token }` o `{ estado: 'sin_configurar', motivo }`. Nunca rechaza. */
async function tokenDelEntorno(env = process.env) {
  const host = String(env.GCE_METADATA_HOST || HOST_DE_METADATOS).trim();
  const r = await pedir(`http://${host}/computeMetadata/v1/instance/service-accounts/default/token`, { cabeceras: { 'Metadata-Flavor': 'Google', accept: 'application/json' }, timeoutMs: TOPE_METADATOS_MS, topeMs: TOPE_METADATOS_MS });
  const fuera = 'fuera de GCP no hay identidad del entorno y este buzón no se lee';
  if (r.error) return { estado: 'sin_configurar', motivo: `no hay identidad del entorno: el servidor de metadatos no contestó en ${TOPE_METADATOS_MS / 1000} s (${r.error.code || r.error.message}); ${fuera}` };
  let json = null;
  try { json = JSON.parse(r.cuerpo.toString('utf8')); } catch (_) { /* abajo */ }
  if (r.status !== 200 || !json || !esTexto(json.access_token)) return { estado: 'sin_configurar', motivo: `no hay identidad del entorno: el servidor de metadatos contestó ${r.status} sin token` };
  return { token: json.access_token };
}

/**
 * Quién lee el buzón por la API JSON, y cómo se dice. El sitio, con la identidad de su entorno: un 403 es un estado de la
 * bajada (`sin_permiso`). Una máquina, con la sesión de gcloud de la persona: un 403 es la falta del rol, que la bajada
 * de la máquina toma como `permiso: true` (sale 0, sin carpeta, una vez por día), igual que con Azure.
 */
const LECTOR_SITIO = Object.freeze({ quien: 'la identidad del sitio', sinRol: (bucket) => ({ estado: 'sin_permiso', motivo: `la identidad del sitio no tiene el rol de lector del bucket ${bucket} (403)` }) });
const LECTOR_MAQUINA = Object.freeze({ quien: 'tu sesión de gcloud', sinRol: (bucket) => ({ permiso: true, motivo: `tu cuenta de gcloud no tiene el rol de lector del bucket ${bucket} (403): sólo lo lee quien fue autorizado` }) });

/** El almacén de la API JSON: `{ destino, listar(prefijo), leer(nombre, timeoutMs) }`, para el sitio o una máquina. */
function almacenDelSitio(bucket, token, base, lector = LECTOR_SITIO) {
  const cab = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const raiz = `${base}/storage/v1/b/${codificar(bucket)}/o`;
  // el `size` de cada objeto listado: la bajada no lee más que eso. Cloud Storage sirve descomprimido un objeto guardado
  // con Content-Encoding gzip (la transcodificación): sin el tope, pocos bytes subidos con la llave de sólo crear serían
  // GB juntados en memoria del sitio
  const largos = new Map();
  async function listar(prefijo = '') {
    const blobs = [];
    let pagina = '';
    for (let vuelta = 0; vuelta < TOPE_PAGINAS; vuelta++) {
      const q = [['maxResults', '1000'], ...(prefijo ? [['prefix', prefijo]] : []), ...(pagina ? [['pageToken', pagina]] : [])];
      const r = await pedir(`${raiz}?${q.map(([k, v]) => `${k}=${codificar(v)}`).join('&')}`, { cabeceras: cab, timeoutMs: 60000 });
      if (r.error) return { estado: 'sin_red', motivo: `sin red o sin respuesta del buzón al listar (${r.error.code || r.error.message}): no se bajó nada` };
      if (r.status === 401) return { estado: 'credencial_rechazada', motivo: `el buzón rechazó el token de ${lector.quien} al listar (401): venció o no vale` };
      if (r.status === 403) return lector.sinRol(bucket);
      if (r.status === 404) return { estado: 'sin_contenedor', motivo: `el bucket ${bucket} no existe (404)` };
      if (r.status !== 200) return { estado: 'servicio_fallo', motivo: `el buzón contestó ${r.status} al listar: no se bajó nada` };
      let doc = null;
      try { doc = JSON.parse(r.cuerpo.toString('utf8')); } catch (_) { /* abajo */ }
      // el listado de Cloud Storage siempre dice qué es (`kind: storage#objects`): otro 200 no es el bucket vacío, y tomarlo
      // por vacío haría que la poda borre el espejo
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.kind !== 'storage#objects' || (doc.items !== undefined && !Array.isArray(doc.items))) return { estado: 'servicio_fallo', motivo: 'el buzón contestó 200 al listar con algo que no es un listado: no se bajó nada' };
      for (const it of doc.items || []) {
        if (!it || typeof it.name !== 'string') continue;
        const fecha = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
        blobs.push({ nombre: it.name, largo: Number(it.size), md5: it.md5Hash || null, etag: it.etag || null, creado: fecha(it.timeCreated), modificado: fecha(it.updated) });
        if (Number.isSafeInteger(Number(it.size)) && Number(it.size) >= 0) largos.set(it.name, Number(it.size));
      }
      if (!doc.nextPageToken) return { blobs };
      pagina = String(doc.nextPageToken);
    }
    return { estado: 'servicio_fallo', motivo: `el listado del buzón pasó las ${TOPE_PAGINAS} páginas sin terminar: no se bajó nada` };
  }
  // un 401 al bajar es el token que venció o no vale, como al listar: la bajada lo toma de `estado` (un 403 sigue siendo
  // el permiso que falta, y lo clasifica la bajada como siempre). Lo que pasa del `size` listado se corta: el cuerpo
  // llega con un byte de más y la bajada lo cuenta como «llegó distinto», ese objeto solo
  async function leer(nombre, timeoutMs) {
    const topeBytes = largos.has(nombre) ? largos.get(nombre) : TOPE_SIN_LISTAR;
    const r = await pedir(`${raiz}/${codificar(nombre)}?alt=media`, { cabeceras: { authorization: cab.authorization }, timeoutMs, topeBytes });
    if (r.status === 401) return { ...r, estado: 'credencial_rechazada', motivo: `el buzón rechazó el token de ${lector.quien} al bajar ${nombre} (401): venció o no vale` };
    return r;
  }
  return { destino: `${PROVIDER}/${bucket}`, listar, leer };
}

// ── la bajada de una máquina ──────────────────────────────────────────────────────────────────────────────────────

// el tope del token de az en la bajada de Azure (scripts/metrics/download-runs.js → tokenDeAz)
const TOPE_GCLOUD_MS = 45000;

/**
 * El token de la sesión de gcloud que ya existe: `{ token }` o `{ motivo }`. Nunca pregunta: la entrada va cerrada,
 * `CLOUDSDK_CORE_DISABLE_PROMPTS=1` y 45 s de tope. `TYCON_GCLOUD_BIN` reemplaza el binario (las pruebas). En Windows se
 * llama `gcloud` sin buscar `gcloud.cmd`, como `az`. Ningún motivo repite la salida: podría traer el token.
 */
function tokenDeGcloud(env = process.env) {
  const bin = String(env.TYCON_GCLOUD_BIN || '').trim() || 'gcloud';
  const r = spawnSync(bin, ['auth', 'print-access-token'], { windowsHide: true, encoding: 'utf8', timeout: TOPE_GCLOUD_MS, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } });
  // en Windows gcloud se instala como gcloud.cmd, que spawnSync no encuentra por su nombre: el motivo lo dice y no confunde
  if (r.error && r.error.code === 'ENOENT' && process.platform === 'win32' && !env.TYCON_GCLOUD_BIN) return { motivo: 'en Windows la bajada todavía no busca gcloud.cmd: el buzón sólo lo leen, por ahora, las máquinas Mac y Linux con su sesión de gcloud' };
  if (r.error && r.error.code === 'ENOENT') return { motivo: `no hay gcloud en esta máquina (${bin}): el buzón sólo lo leen quienes tienen el rol de lectura, con su sesión de gcloud` };
  if (r.error) return { motivo: `gcloud no respondió (${r.error.code || r.error.message}): no se pide un login desde acá` };
  const token = String(r.stdout || '').trim();
  if (r.status !== 0 || !token || /\s/.test(token)) return { motivo: `gcloud no tiene una sesión que sirva para el buzón (salió ${r.status}${token ? '' : ', sin token'}): no se pide un login desde acá` };
  return { token };
}

/**
 * El almacén de la bajada de una máquina para una llave gcs ya validada: `{ destino, listar, leer }`, con la forma del de
 * Azure. Lista y lee con la sesión de gcloud de la persona, por la API JSON (`urlBase` reemplaza el host: las pruebas).
 * El token se pide la primera vez que lista: sin gcloud o sin sesión, el listado contesta `{ permiso: true, motivo }` y
 * la bajada no crea nada.
 */
function almacenDeBajada(cfg, { urlBase = null } = {}) {
  const base = String(urlBase || HOST_DE_STORAGE).replace(/\/+$/, '');
  let interno = null;
  const preparar = () => {
    if (!interno) {
      const tk = tokenDeGcloud();
      interno = tk.token ? almacenDelSitio(cfg.bucket, tk.token, base, LECTOR_MAQUINA) : { falla: tk.motivo };
    }
    return interno;
  };
  return {
    destino: `${PROVIDER}/${cfg.bucket}`,
    listar: async (prefijo = '') => { const a = preparar(); return a.falla ? { permiso: true, motivo: a.falla } : a.listar(prefijo); },
    leer: async (nombre, timeoutMs) => { const a = preparar(); return a.falla ? { estado: 'sin_permiso', motivo: a.falla } : a.leer(nombre, timeoutMs); },
  };
}

/** Lo que devuelve la bajada cuando no llegó a pedir nada: la forma de `bajar()`, no completa. */
function noBajado(codigo, estado, motivo) {
  return { codigo, res: { bajado: false, estado, motivo, codigo, completo: false, blobs: 0, bajados: 0, bytes: 0, sin_tiempo: 0, registros_enteros: false, volcados_enteros: false } };
}

/** El almacén del sitio para `opts` (`buzon`, `credencial`, `urlBase`), o `{ falla }` con la forma de la bajada. */
async function prepararSitio(opts) {
  const mb = opts.buzon || {};
  if (typeof mb.bucket !== 'string' || !FORMA_BUCKET.test(mb.bucket)) return { falla: noBajado(2, 'config_rota', 'site.mailbox.bucket no tiene la forma de un bucket de Cloud Storage: no se pide nada') };
  if (!(opts.credencial && opts.credencial.managed === true)) return { falla: noBajado(1, 'sin_configurar', 'el buzón de Cloud Storage lo lee el sitio con la identidad de su entorno (SITE_MAILBOX_IDENTITY=managed): una SAS no sirve') };
  const tk = await tokenDelEntorno();
  if (!tk.token) return { falla: noBajado(1, tk.estado, tk.motivo) };
  return { almacen: almacenDelSitio(mb.bucket, tk.token, String(opts.urlBase || HOST_DE_STORAGE).replace(/\/+$/, '')) };
}

/** Baja el buzón al espejo del sitio con `bajar()` de la bajada de siempre: `{ codigo, res }`. */
async function bajarBuzon({ dir, log, sinHilos = true, budgetMs = 120000, resumenes = false, topeBytesHilos = null, hiloTopeBytes = null, podar = false, confiarIndice = false, jornadas = false, soloHuellas = false, ...opts } = {}) {
  const p = await prepararSitio(opts);
  if (p.falla) return p.falla;
  return require(BAJADA).bajar({ almacen: p.almacen, dir, sinHilos: sinHilos !== false, budgetMs, log, resumenes, topeBytesHilos, hiloTopeBytes, podar, confiarIndice, jornadas: jornadas === true, soloHuellas: soloHuellas === true });
}

/** La conversación y el cambio de UNA corrida, para el detalle a demanda. */
async function bajarUnaCorrida({ maquina, base, dir, ...opts } = {}) {
  const p = await prepararSitio(opts);
  if (p.falla) return p.falla;
  return require(BAJADA).bajarUnaCorrida({ almacen: p.almacen, maquina, base, dir });
}

module.exports = {
  PROVIDER, PROVEEDORES_DE_BUZON, FORMA_BUCKET,
  problemasDelBuzon, validarLlave, almacenDeSubida, almacenDeBajada, firmar, tokenDelEntorno, bajarBuzon, bajarUnaCorrida,
};
