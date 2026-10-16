'use strict';
/*
 * site-harness.js — lo compartido de las suites del sitio de la organización (story 2.23).
 *
 *   · `envBase(extra)`        las variables mínimas de un arranque válido (dirección de prueba http://127.0.0.1).
 *   · `fuentesFijas(…)`       unas fuentes de mentira con el contrato de scripts/site/sources.js (estado, config, modelo,
 *                             refrescar), para probar el servidor sin repo ni buzón.
 *   · `arrancarSitio(…)`      el sitio en el proceso de la prueba, en un puerto libre; devuelve `pedir(ruta, opts)`.
 *   · `ingresar(…)`           el viaje entero del inicio de sesión contra el emisor local: pide `/`, sigue el 302 hasta
 *                             el emisor (sin navegador: lee state, nonce y challenge de la dirección), emite el código y
 *                             vuelve a `/auth/callback` con la cookie del intento. Devuelve la cookie de la sesión.
 *
 * Nada de esto habla con la red: el emisor, GitHub, el repo y el buzón son locales.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const SITE = path.join(__dirname, '..', '..', 'site');

/** Una llave de sesión de 32 bytes, armada al correr (ningún secreto escrito). */
const llave = () => crypto.randomBytes(32).toString('base64');

function envBase(extra = {}) {
  return {
    SITE_PUBLIC_URL: 'http://127.0.0.1',
    SITE_SESSION_KEY: llave(),
    SITE_AUTH_PROVIDER: 'oidc',
    SITE_OIDC_CLIENT_ID: 'site-client',
    SITE_OIDC_CLIENT_SECRET: 'site-secret',
    SITE_OIDC_ISSUER: 'http://127.0.0.1:9/no-usado',
    SITE_OPERATIONS_REPO: 'https://git.acme.example/ops.git',
    SITE_OPERATIONS_TOKEN: 'tok-de-prueba',
    ...extra,
  };
}

/** Fuentes de mentira: lo que el servidor pide a scripts/site/sources.js, con setters para la prueba. */
function fuentesFijas({ config = { version: 1, owners: { default: 'lead@acme.example' } }, modelo = {}, cargado = true, frenado = null, bandaConfig = null, bandaRefresco = null } = {}) {
  const st = { config, modelo, cargado, frenado, bandaConfig, bandaRefresco, refrescos: 0 };
  return {
    st,
    estado: () => ({ cargado: st.cargado, frenado: st.frenado, bandaConfig: st.bandaConfig, bandaRefresco: st.bandaRefresco }),
    config: () => st.config,
    modelo: () => st.modelo,
    refrescar: async () => { st.refrescos += 1; },
    detener: () => {},
  };
}

function leerCookies(setCookie) {
  const out = {};
  for (const c of [].concat(setCookie || [])) {
    const [par] = c.split(';');
    const i = par.indexOf('=');
    out[par.slice(0, i).trim()] = { valor: par.slice(i + 1), crudo: c };
  }
  return out;
}

function pedirA(base, ruta, { method = 'GET', headers = {}, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ruta, base);
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    const req = http.request(u, { method, headers: h }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto, cookies: leerCookies(res.headers['set-cookie']), json: (() => { try { return JSON.parse(texto); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Arranca el sitio en este proceso. `opts` va tal cual a crearSitio (env, fuentes, ahora, …). */
async function arrancarSitio(opts) {
  const { crearSitio } = require(path.join(SITE, 'server.js'));
  const registro = [];
  const sitio = crearSitio({ log: (l) => registro.push(l), ...opts });
  await sitio.iniciar();
  await new Promise((r) => sitio.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${sitio.server.address().port}`;
  return {
    sitio, base, registro,
    pedir: (ruta, o) => pedirA(base, ruta, o),
    cerrar: () => sitio.cerrar(),
  };
}

/** El intento que el sitio mandó al emisor, leído de la dirección del 302. */
function intentoDe(res) {
  const loc = new URL(res.headers.location);
  return {
    loc,
    state: loc.searchParams.get('state'),
    nonce: loc.searchParams.get('nonce'),
    challenge: loc.searchParams.get('code_challenge'),
    cookie: `__Host-login=${res.cookies['__Host-login'] && res.cookies['__Host-login'].valor}`,
  };
}

/** El viaje entero contra un emisor OIDC local. Devuelve { res, sesion } (sesion = 'name=valor' o null). */
async function ingresar(h, emisor, claims, { alterar } = {}) {
  const ida = await h.pedir('/');
  if (ida.status !== 302) return { res: ida, sesion: null };
  const it = intentoDe(ida);
  const code = emisor.emitirCodigo({ claims, nonce: it.nonce, challenge: it.challenge });
  let vuelta = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(it.state)}`;
  let cookie = it.cookie;
  if (alterar) ({ vuelta, cookie } = alterar({ vuelta, cookie, it, code }));
  const res = await h.pedir(vuelta, { cookie });
  const s = res.cookies['__Host-site'];
  return { res, it, sesion: s && s.valor ? `__Host-site=${s.valor}` : null };
}

/** El viaje entero contra el GitHub local. */
async function ingresarGithub(h, gh, usuario, { alterar } = {}) {
  const ida = await h.pedir('/');
  if (ida.status !== 302) return { res: ida, sesion: null };
  const it = intentoDe(ida);
  const code = gh.emitirCodigo({ usuario, challenge: it.challenge });
  let vuelta = `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(it.state)}`;
  let cookie = it.cookie;
  if (alterar) ({ vuelta, cookie } = alterar({ vuelta, cookie, it, code }));
  const res = await h.pedir(vuelta, { cookie });
  const s = res.cookies['__Host-site'];
  return { res, it, sesion: s && s.valor ? `__Host-site=${s.valor}` : null };
}

/**
 * Un buzón de Azure Blob de mentira (lista XML paginada y GET de blobs). `blobs` = { '<maquina>/<archivo>': contenido }.
 * Anota cada pedido (ruta, consulta, cabecera Authorization). `modo`: 'ok' | <status> (todo contesta ese status).
 */
async function arrancarBuzon({ blobs = {}, contenedor = 'runs' } = {}) {
  const pedidos = [];
  const st = { modo: 'ok', blobs: { ...blobs }, fallar: new Set() };   // fallar: nombres cuyo GET contesta 500
  const md5 = (b) => crypto.createHash('md5').update(b).digest('base64');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    pedidos.push({ ruta: decodeURIComponent(u.pathname), query: u.search, auth: req.headers.authorization || null });
    if (st.modo !== 'ok') { res.writeHead(Number(st.modo)); res.end('<Error/>'); return; }
    const partes = decodeURIComponent(u.pathname).split('/').filter(Boolean);
    if (partes.shift() !== contenedor) { res.writeHead(404); res.end(); return; }
    if (u.searchParams.get('comp') === 'list') {
      const items = Object.keys(st.blobs).sort().map((n) => { const b = Buffer.from(st.blobs[n]); return `<Blob><Name>${n}</Name><Properties><Content-Length>${b.length}</Content-Length><Content-MD5>${md5(b)}</Content-MD5><Etag>e-${md5(b)}</Etag></Properties></Blob>`; });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><EnumerationResults><Blobs>${items.join('')}</Blobs><NextMarker/></EnumerationResults>`);
      return;
    }
    const nombre = partes.join('/');
    if (st.fallar.has(nombre)) { res.writeHead(500); res.end('<Error/>'); return; }
    if (!(nombre in st.blobs)) { res.writeHead(404); res.end(); return; }
    const b = Buffer.from(st.blobs[nombre]);
    res.writeHead(200, { 'content-md5': md5(b) });
    res.end(b);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`, contenedor, pedidos, st,
    cerrar: () => new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

/** Una SAS de contenedor de mentira con estos parámetros (armada al correr). */
function sas(extra = {}) {
  const { __crudo, ...resto } = extra;   // __crudo: un parámetro más, tal cual (por ejemplo, uno repetido)
  const p = new URLSearchParams({ sv: '2023-11-03', sr: 'c', sp: 'rl', si: 'lectura-sitio', se: '2099-01-01T00:00:00Z', sig: crypto.randomBytes(16).toString('base64'), ...resto });
  for (const [k, v] of Object.entries(resto)) if (v === null) p.delete(k);
  return __crudo ? `${p.toString()}&${__crudo}` : p.toString();
}

/** Un volcado de corrida (lo que sube upload-runs.js), con su sesión e inicio. */
const volcado = (sid, inicio, extra = {}) => JSON.stringify({ archivedAt: inicio, marker: { sessionId: sid, startedAt: inicio, lastTouch: inicio, stepsCompleted: [], ...extra } });

/** Los archivos de un repo de operaciones con todas las fuentes del día `hoy` (nombres inventados). */
function archivosDeOperaciones({ hoy = '2026-10-15', ayer = '2026-10-14', config, extra = {} } = {}) {
  return {
    'operations.json': config || { version: 1, owners: { default: 'lead@acme.example' }, site: { maintainers: ['lead@acme.example'] } },
    'scripts/nightly/dependencies/repos.json': { azure: { org: 'https://dev.example/acme' }, repos: [{ producto: 'Producto X', ruta: 'X/repo', ado: 'Proyecto X/Repo X', tipo: 'npm', activo: true }] },
    'scripts/nightly/dashboard/sources.json': { sources: [
      { id: 'dependencias', pattern: 'dependencias-*.json', dir: 'dependencias', max_age_days: 2 },
      { id: 'vigilante', pattern: 'vigilante-*.json', dir: 'vigilante', max_age_days: 2 },
      { id: 'banco', pattern: 'banco-*.json', dir: 'controls-bench', max_age_days: 2 },
      { id: 'suites', pattern: 'suites-*.json', dir: 'controls-bench', max_age_days: 2 },
    ], thresholds: {} },
    'scripts/nightly/dashboard/declared.json': { declared: [{ id: 'dato-uno', review_before: '2026-10-20' }] },
    [`.dashboard/dependencias/dependencias-${hoy}.json`]: { fecha: hoy, resumen: { rubros: {
      nuevos: { valor: [{ id: 'f1', paquete: 'pkg-uno', proyectos: ['Proyecto X'] }], motivo: null },
      aceptadas_sin_resolver: { valor: [], motivo: null }, rechazadas_sin_deuda: { valor: [], motivo: null },
      vivas_por_proyecto: { valor: [{ proyecto: 'Proyecto X', ids: ['f1', 'f2'] }], motivo: null },
      pedidos_cerrados_con_vivas: { valor: [], motivo: null } } } },
    [`.dashboard/vigilante/vigilante-${hoy}.json`]: { fecha: hoy, productos: { 'producto-x': { ok: true } }, resumen: { rubros: { pendientes: { valor: [], motivo: null }, aceptadas_sin_story: { valor: [], motivo: null } } } },
    [`.dashboard/controls-bench/banco-${hoy}.json`]: { ts: `${hoy}T05:00:00Z`, ran: 10, failed: 0, estado: 'completo', results: {} },
    [`.dashboard/controls-bench/suites-${hoy}.json`]: { ts: `${hoy}T05:00:00Z`, corridas: 10, failures: [], unmeasured: [], complete: true },
    [`.dashboard/controls-bench/suites-${ayer}.json`]: { ts: `${ayer}T05:00:00Z`, corridas: 10, failures: [], unmeasured: [], complete: true },
    '.dashboard/proyectos/Proyecto X__Repo X.json': { v: 1, generated_at: `${hoy}T06:00:00Z`, proyecto: 'Proyecto X', repo: 'Repo X', stories: [{ id: '1.1', titulo: 'un título', grupo: 'en_curso', canonico: 'in-progress', dias_en_estado: 3 }] },
    'artifacts/tablero-del-arnes.html': '<!doctype html><html><head><style>b{color:red}</style></head><body><h1>Seis preguntas</h1></body></html>',
    ...extra,
  };
}

module.exports = { SITE, envBase, fuentesFijas, arrancarSitio, pedirA, ingresar, ingresarGithub, intentoDe, leerCookies, llave, arrancarBuzon, sas, volcado, archivosDeOperaciones };
