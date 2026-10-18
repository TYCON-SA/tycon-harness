'use strict';
/*
 * cloud/azure.js — LO ÚNICO DE AZURE DEL NÚCLEO DEL SITIO (story 2.23, AC 4 y 13).
 *
 * El núcleo no depende de ninguna nube: corre igual en Azure Container Apps, Render, Google Cloud Run o una máquina con
 * Docker. Lo de Azure vive acá y sólo se usa con `SITE_OPERATIONS_IDENTITY=managed` o `SITE_MAILBOX_IDENTITY=managed`:
 *
 *   · `tokenDeIdentidad(recurso)` pide el token de la IDENTIDAD ADMINISTRADA del contenedor al endpoint que la
 *     plataforma inyecta (`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`, la forma de App Service y Container Apps,
 *     api-version 2019-08-01). Sin esas variables —el sitio no está en Azure— dice por qué y no inventa nada.
 *   · Los recursos: el almacenamiento (`https://storage.azure.com/`, para leer el buzón con el rol de lector de datos) y
 *     Azure DevOps (el id PÚBLICO de la aplicación de Azure DevOps en Entra, el mismo para todas las organizaciones —no
 *     es un valor de ninguna—; leído en Microsoft Learn, «Use service principals & managed identities in Azure DevOps»,
 *     2026-10-15). La identidad se agrega a la organización de Azure DevOps una vez (2.30).
 *   · La lectura de Azure Blob la hace `bajar()` de scripts/metrics/download-runs.js, con la credencial que le pasa el
 *     sitio: la SAS de sólo lectura o este token.
 *   · `almacenDeCopia()`: el contenedor de la copia de operaciones, para `operations-copy.js` (el sitio lee,
 *     el trabajo que copia escribe con la sesión de `az`).
 *
 * El token nunca se escribe en disco ni en el registro: vive en la memoria del proceso lo que dura un refresco.
 */
const { pedir } = require('../oidc.js');

const RECURSO_ALMACENAMIENTO = 'https://storage.azure.com/';
const RECURSO_AZURE_DEVOPS = '499b84ac-1321-427f-aa17-267ca6975798';

/** { token } o { estado, motivo }. Nunca rechaza. */
async function tokenDeIdentidad(recurso, env = process.env) {
  const endpoint = env.IDENTITY_ENDPOINT;
  const cabecera = env.IDENTITY_HEADER;
  if (!endpoint || !cabecera) return { estado: 'sin_configurar', motivo: 'no hay identidad administrada en esta plataforma (faltan IDENTITY_ENDPOINT e IDENTITY_HEADER): fuera de Azure va la credencial por variable' };
  let u;
  try { u = new URL(endpoint); } catch { return { estado: 'sin_configurar', motivo: 'IDENTITY_ENDPOINT no es una dirección' }; }
  u.searchParams.set('resource', recurso);
  u.searchParams.set('api-version', '2019-08-01');
  const r = await pedir(u.toString(), { headers: { 'X-IDENTITY-HEADER': cabecera, accept: 'application/json' }, timeoutMs: 15000 });
  if (r.error) return { estado: 'sin_red', motivo: `el endpoint de la identidad administrada no respondió (${r.error.code || r.error.message})` };
  if (r.status === 401 || r.status === 403) return { estado: 'credencial_rechazada', motivo: `el endpoint de la identidad administrada contestó ${r.status}` };
  let json = null;
  try { json = JSON.parse(r.cuerpo); } catch { /* abajo */ }
  if (r.status !== 200 || !json || typeof json.access_token !== 'string' || !json.access_token) return { estado: 'sin_permiso', motivo: `el endpoint de la identidad administrada contestó ${r.status} sin token` };
  return { token: json.access_token };
}

// ── Lo que el núcleo le pide a una nube (sources.js recorre cloud/ y no nombra a ninguna) ──────────────────────────
/** Los proveedores de buzón (`site.mailbox.provider`) que esta nube sabe leer. */
const PROVEEDORES_DE_BUZON = ['azure-blob'];

/**
 * Baja el buzón con `bajar()` de download-runs.js: { codigo, res }. Sin `sinHilos: false` explícito, no baja las
 * conversaciones ni los cambios de git (lo seguro); la pestaña Corridas los pide con `site.mailbox.threads` (story 2.27).
 */
function bajarBuzon({ cuenta, contenedor, credencial, dir, urlBase, log, sinHilos = true, budgetMs = 120000, resumenes = false, topeBytesHilos = null, podar = false }) {
  const { bajar } = require('../../metrics/download-runs.js');
  return bajar({ cuenta, contenedor, credencial, dir, sinHilos: sinHilos !== false, urlBase, budgetMs, log, resumenes, topeBytesHilos, podar });
}

/** La conversación y el cambio de UNA corrida, para el detalle a demanda (download-runs.js → bajarUnaCorrida). */
function bajarUnaCorrida({ cuenta, contenedor, credencial, urlBase, maquina, base, dir }) {
  return require('../../metrics/download-runs.js').bajarUnaCorrida({ cuenta, contenedor, credencial, urlBase, maquina, base, dir });
}

/** El token de la identidad administrada para leer el repo de operaciones en Azure DevOps. */
const tokenParaRepo = () => tokenDeIdentidad(RECURSO_AZURE_DEVOPS);

// ── La copia de operaciones: el contenedor donde la deja el trabajo que copia ─────────────────────────
const X_MS_VERSION = '2021-08-06';

/** El token de almacenamiento de la sesión de `az` (el trabajo que copia). `TYCON_AZ_CMD` cambia el ejecutable. */
function tokenDeLineaDeOrdenes(env = process.env) {
  const r = require('child_process').spawnSync(env.TYCON_AZ_CMD || 'az', ['account', 'get-access-token', '--resource', RECURSO_ALMACENAMIENTO, '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8', windowsHide: true });
  const t = String(r.stdout || '').trim();
  if (r.status !== 0 || !t) return { estado: 'sin_permiso', motivo: `az no dio un token de almacenamiento (${String(r.stderr || r.error || '').trim().slice(0, 200)})` };
  return { token: t };
}

/**
 * El contenedor `cuenta/contenedor` de Azure Blob: `{ get, put, list, del }`, cada uno resuelve `{ status, cuerpo }` o
 * `{ error }` (nunca rechaza). La credencial: `{ token }`, `{ sas }`, `{ managed: true }` (la identidad administrada) o
 * `{ lineaDeOrdenes: true }` (la sesión de `az`, una vez por almacén). `urlBase` (las pruebas, Azurite): la base sin la
 * cuenta en el host.
 */
function almacenDeCopia({ cuenta, contenedor, credencial, urlBase = null, timeoutMs = 60000 }) {
  if (!/^[a-z0-9]{3,24}$/.test(String(cuenta)) || !/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(String(contenedor))) {
    throw new Error('la cuenta o el contenedor de la copia no tienen la forma de Azure Storage');
  }
  const base = urlBase ? `${String(urlBase).replace(/\/$/, '')}/${cuenta}/${contenedor}` : `https://${cuenta}.blob.core.windows.net/${contenedor}`;
  let deLaSesion = null;
  async function cabeceras() {
    if (credencial && typeof credencial.token === 'string') return { headers: { Authorization: `Bearer ${credencial.token}` } };
    if (credencial && typeof credencial.sas === 'string') return { headers: {}, sas: credencial.sas.replace(/^\?/, '') };
    if (credencial && credencial.managed === true) {
      const t = await tokenDeIdentidad(RECURSO_ALMACENAMIENTO);
      return t.token ? { headers: { Authorization: `Bearer ${t.token}` } } : { falla: t };
    }
    if (credencial && credencial.lineaDeOrdenes === true) {
      if (!deLaSesion) deLaSesion = tokenDeLineaDeOrdenes();
      return deLaSesion.token ? { headers: { Authorization: `Bearer ${deLaSesion.token}` } } : { falla: deLaSesion };
    }
    return { falla: { estado: 'sin_configurar', motivo: 'la copia necesita una credencial: { token }, { managed: true }, { sas } o { lineaDeOrdenes: true }' } };
  }
  async function pedirBlob(metodo, nombre, { query = '', cuerpo = null, extra = {} } = {}) {
    const c = await cabeceras();
    if (c.falla) return { error: Object.assign(new Error(c.falla.motivo), { code: c.falla.estado }) };
    const ruta = nombre ? `/${nombre.split('/').map(encodeURIComponent).join('/')}` : '';
    const consulta = [query, c.sas].filter(Boolean).join('&');
    const u = new URL(`${base}${ruta}${consulta ? `?${consulta}` : ''}`);
    const headers = { 'x-ms-version': X_MS_VERSION, ...c.headers, ...extra };
    if (cuerpo) headers['content-length'] = String(cuerpo.length);
    return new Promise((resolve) => {
      let hecho = false;
      const fin = (r) => { if (!hecho) { hecho = true; resolve(r); } };
      const req = (u.protocol === 'http:' ? require('http') : require('https')).request(u, { method: metodo, headers, timeout: timeoutMs }, (res) => {
        const trozos = [];
        res.on('data', (t) => trozos.push(t));
        res.on('end', () => fin({ status: res.statusCode, cuerpo: Buffer.concat(trozos) }));
        res.on('error', (e) => fin({ error: e }));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => fin({ error: e }));
      if (cuerpo) req.write(cuerpo);
      req.end();
    });
  }
  return {
    get: (nombre) => pedirBlob('GET', nombre),
    put: (nombre, cuerpo, tipo = 'application/octet-stream') => pedirBlob('PUT', nombre, { cuerpo, extra: { 'x-ms-blob-type': 'BlockBlob', 'content-type': tipo } }),
    del: (nombre) => pedirBlob('DELETE', nombre),
    async list(prefijo) {
      const blobs = [];
      let marca = '';
      for (let vuelta = 0; vuelta < 100; vuelta++) {
        const r = await pedirBlob('GET', '', { query: `restype=container&comp=list&prefix=${encodeURIComponent(prefijo)}${marca ? `&marker=${encodeURIComponent(marca)}` : ''}` });
        if (r.error || r.status !== 200) return r;
        const xml = r.cuerpo.toString('utf8');
        for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
          const nombre = (/<Name>([\s\S]*?)<\/Name>/.exec(m[1]) || [])[1];
          const fecha = Date.parse((/<Last-Modified>([\s\S]*?)<\/Last-Modified>/.exec(m[1]) || [])[1] || '');
          if (nombre) blobs.push({ name: nombre.replace(/&amp;/g, '&'), modificado: fecha });
        }
        marca = (/<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml) || [])[1] || '';
        if (!marca) break;
      }
      // `truncado`: quedaron páginas sin pedir (más de 100): quien lista lo dice, no lo da por completo
      return { status: 200, blobs, truncado: Boolean(marca) };
    },
  };
}

// los hosts de esta nube que una respuesta sin sesión del sitio nunca puede nombrar (el almacenamiento y el repo):
// la prueba sin sesión (check-deploy.js) los busca en /healthz
const HOSTS_QUE_NO_SE_NOMBRAN = /\.windows\.net|dev\.azure\.com/i;

// la respuesta del inicio integrado de Container Apps (Easy Auth), delante del sitio: a un pedido que no parece de
// navegador le contesta 401, sin Location ni Cache-Control, con la cabecera de su intermediario. La prueba sin sesión
// la reconoce así y no le pide el no-store del sitio (el sitio ni la vio)
const esDelCandado = (headers) => Boolean(headers && typeof headers.get === 'function' && headers.get('x-ms-middleware-request-id'));

// por dónde sale quien entró por el candado de la plataforma: si el pedido trae la cabecera con el nombre de quien
// pasó el candado, hay que cerrar también su sesión ahí (si no, la plataforma lo vuelve a dejar entrar); si no, null
const salidaDelCandado = (headers) => (headers && headers['x-ms-client-principal-name'] ? '/.auth/logout' : null);

module.exports = { tokenDeIdentidad, almacenDeCopia, tokenParaRepo, bajarBuzon, bajarUnaCorrida, PROVEEDORES_DE_BUZON, RECURSO_ALMACENAMIENTO, RECURSO_AZURE_DEVOPS, HOSTS_QUE_NO_SE_NOMBRAN, esDelCandado, salidaDelCandado };
