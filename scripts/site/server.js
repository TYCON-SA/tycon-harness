#!/usr/bin/env node
'use strict';
/*
 * server.js — EL SITIO DE LA ORGANIZACIÓN.
 *
 * Un servidor Node sin dependencias, en Docker o con Node solo, para toda la organización: cada persona entra con la
 * cuenta de su organización y ve lo suyo; quienes mantienen el arnés ven todo. El filtro lo hace el servidor: la
 * pantalla nunca recibe lo que no puede ver.
 *
 * LA TABLA DE RUTAS es el único camino de los datos. Cada ruta declara quién puede verla (`needs`:
 * 'maintainer', 'person') y recibe el modelo YA FILTRADO por access.js para quien pide. Una ruta sin esa declaración
 * hace que el sitio NO ARRANQUE. Una ruta puede tener parámetros (`/api/corridas/:id`): llegan en
 * `ctx.params`, y la ruta sigue declarando quién la ve. Las únicas rutas sin sesión son la vida (`/livez`), la salud (`/healthz`), la carga
 * (`/readyz`), el inicio de sesión (`/auth/*`) y los dos archivos estáticos.
 *
 *   /livez    200 {"ok":true} mientras el proceso escucha; nada más (la sonda de vida y el HEALTHCHECK de la imagen).
 *   /healthz  200 {"ok":true}, también mientras carga; 503 {"ok":false,"motivo":…} sólo con el sitio FRENADO por la
 *             configuración de la organización. El motivo nunca nombra direcciones, hosts, rutas ni cuentas; dice
 *             desde cuándo no valida (el primer refresco fallido), y la página del freno, desde cuándo está frenado.
 *   /readyz   503 con Retry-After hasta la primera lectura de las fuentes; después 200 (también frenado).
 *   /idioma   POST: cambia el idioma de las páginas, con y sin sesión, con el candado de origen de las
 *             escrituras; vuelve a la página en la que estaba (sólo una ruta propia).
 *
 * LA IDENTIDAD sale sólo del inicio de sesión del propio sitio: ninguna cabecera de un proxy o de la
 * plataforma cambia quién pide. El rol se recalcula en CADA pedido con la configuración vigente.
 *
 * ARRANQUE: lee las variables de abajo; si falta una obligatoria o tiene mala forma, no arranca, sale 1 y dice
 * cuál y por qué. El registro dice qué variable está presente, nunca su valor.
 *   obligatorias  SITE_PUBLIC_URL (https://, o http://127.0.0.1 en pruebas) · SITE_SESSION_KEY (≥ 32 bytes) ·
 *                 SITE_AUTH_PROVIDER (`oidc` o el nombre de un archivo de auth-providers/) · SITE_OIDC_CLIENT_ID ·
 *                 SITE_OIDC_CLIENT_SECRET · y lo que pida cada proveedor (la cabecera de su archivo: el emisor, los
 *                 dominios, la organización) · SITE_OPERATIONS_REPO (https) y su credencial: SITE_OPERATIONS_TOKEN o
 *                 SITE_OPERATIONS_IDENTITY=managed (la identidad administrada de la plataforma: lo de cada nube vive en cloud/)
 *   opcionales    SITE_OIDC_EMAIL_CLAIM · PORT (8080) · SITE_MAILBOX_SAS o SITE_MAILBOX_IDENTITY=managed ·
 *                 SITE_FIRST_MAINTAINER (un correo) · SITE_AUTH_ALLOWED_DOMAINS (donde el proveedor no la exige) ·
 *                 SITE_DATA_DIR (un disco persistente; sin ella, una carpeta temporal, y se dice)
 *   de la pestaña Configuración (todas apagadas por defecto: sin una, su sección queda en sólo
 *   lectura o «no configurado», y el sitio arranca igual)
 *                 SITE_OPERATIONS_WRITE_TOKEN (proponer cambios al repo de operaciones: rama y pedido, nunca main) ·
 *                 SITE_PROFILE_REPO (https) y SITE_PROFILE_TOKEN (leer el perfil del equipo) · SITE_PROFILE_WRITE_TOKEN
 *                 (proponer al perfil) · SITE_PIPELINES_TOKEN (sólo lectura de definiciones y corridas: la propuesta de stages) ·
 *                 SITE_PRODUCTS_WRITE_TOKEN (leer y proponer el .tycon/advisors.yaml de los repos de producto: rama y pedido,
 *                 nunca main ni completar el pedido; sin ella la sección por repo lee con SITE_OPERATIONS_TOKEN y no propone)
 *
 * EL MODO DEMO (`SITE_DEMO=1`, scripts/site/demo.js): el mismo servidor, sin proveedor de inicio de sesión ni credenciales,
 *   sobre los datos de ejemplo de «acme» (scripts/site/demo/), abierto y de sólo lectura de punta a punta. Acepta sólo
 *   SITE_DEMO, PORT y SITE_PUBLIC_URL; con cualquier otra variable del sitio o de identidad de la plataforma no arranca y dice
 *   cuál, y con SITE_DEMO en otro valor que 1 tampoco. Un freno central (red, procesos y escrituras fuera de su carpeta
 *   temporal propia) se pone al cargar este archivo, antes que fuentes y pestañas. Cada visita entra con la sesión de ejemplo
 *   (quien mantiene, o una persona del equipo con el selector «Ver como»), cada página lleva la franja «Datos de ejemplo»,
 *   toda respuesta pide `noindex` y cada dirección tiene un tope de pedidos por minuto. El sitio real dice `demo: false` en su
 *   línea de arranque y en /livez.
 *
 * Uso: node scripts/site/server.js        (la imagen: scripts/site/Dockerfile)
 */
// SITE_DEMO=1: el freno de red, de procesos y de escrituras se pone ANTES de cargar nada más (demo-guard.js). Un módulo que guardara
// una referencia a `fetch` o a `spawn` antes de ese momento lo esquivaría
const FRENO_DEMO = require.main === module && process.env.SITE_DEMO === '1' ? require('./demo-guard.js').frenoTemprano() : null;
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const session = require('./session.js');
const oidc = require('./oidc.js');
const access = require('./access.js');
const views = require('./views.js');
const LANG = require('./language.js');
const { t: texto, traducirMensaje } = require('./texts.js');
const { limpiarLinea, dentroDe } = require('./sources.js');
const { BRAND_LOGO } = require('../lib/operations-config.js');

// Los proveedores: el `oidc` genérico y uno por archivo de auth-providers/ (el nombre del archivo es el valor de
// SITE_AUTH_PROVIDER). El núcleo no nombra a ninguno: lo propio de cada uno vive en su archivo.
const PROVEEDORES = (() => {
  const dir = path.join(__dirname, 'auth-providers');
  const out = { oidc: { problemasDeConfig: oidc.problemasDeConfig, crear: oidc.crearGenerico, describir: () => texto('es', 'proveedor.oidc') } };
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z][a-z0-9-]*\.js$/.test(x)).sort()) out[f.slice(0, -3)] = require(path.join(dir, f));
  return out;
})();
const VARIABLES = ['SITE_PUBLIC_URL', 'SITE_SESSION_KEY', 'SITE_AUTH_PROVIDER', 'SITE_OIDC_CLIENT_ID', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OIDC_ISSUER',
  'SITE_OIDC_EMAIL_CLAIM', 'SITE_AUTH_ALLOWED_DOMAINS', 'SITE_AUTH_GITHUB_ORG', 'SITE_OPERATIONS_REPO', 'SITE_OPERATIONS_TOKEN', 'SITE_OPERATIONS_IDENTITY',
  'SITE_MAILBOX_SAS', 'SITE_MAILBOX_IDENTITY', 'SITE_FIRST_MAINTAINER', 'SITE_DATA_DIR', 'PORT',
  'SITE_OPERATIONS_WRITE_TOKEN', 'SITE_PROFILE_REPO', 'SITE_PROFILE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'SITE_PIPELINES_TOKEN', 'SITE_PRODUCTS_WRITE_TOKEN',
  'SITE_OPERATIONS_SOURCE', 'SITE_OPERATIONS_COPY', 'SITE_OPERATIONS_COPY_SAS',
  // invitar desde Personas (invitations.js): el tope por día
  'SITE_INVITATIONS_PER_DAY',
  // las propias de cada proveedor, que las declara su archivo (`variables`)
  ...new Set(Object.values(PROVEEDORES).flatMap((p) => (Array.isArray(p.variables) ? p.variables : [])))];
const CORREO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DOMINIO = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const NEEDS = new Set(['maintainer', 'person']);
// la versión: la del manifiesto de una versión bajada (trae el número de la etiqueta que puso el merge); si no hay, la de
// version.json (desde que el número lo pone el merge, ese archivo dice el piso)
const VERSION = (() => {
  const raiz = path.join(__dirname, '..', '..');
  for (const f of ['.tycon-release.json', 'version.json']) {
    try { const v = JSON.parse(fs.readFileSync(path.join(raiz, f), 'utf8')).version; if (v) return v; } catch { /* el siguiente */ }
  }
  return null;
})();
// de qué imagen es este sitio (el nombre en el registro, sin etiqueta): lo deja el workflow que la arma, adentro. Contra
// esa imagen se compara `stable`; una imagen armada por la organización desde su copia compara contra la suya
const IMAGEN = (() => {
  try { const i = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.tycon-release.json'), 'utf8')).image; return typeof i === 'string' && i ? i : null; } catch { return null; }
})();

const esLoopback = (u) => u.protocol === 'http:' && u.hostname === '127.0.0.1';

/** { ok, problemas: [{ variable, motivo }], cfg } — sin valores en los motivos. */
function validarConfiguracion(env) {
  const problemas = [];
  const falta = (v, motivo) => problemas.push({ variable: v, motivo });
  const cfg = {};

  let pub = null;
  try { pub = new URL(env.SITE_PUBLIC_URL || ''); } catch { /* abajo */ }
  if (!env.SITE_PUBLIC_URL) falta('SITE_PUBLIC_URL', 'falta: la dirección pública del sitio (https://…)');
  else if (!pub || !(pub.protocol === 'https:' || esLoopback(pub)) || pub.pathname !== '/' || pub.search) falta('SITE_PUBLIC_URL', 'tiene que ser https:// (sólo en pruebas, http://127.0.0.1), sin ruta');
  else cfg.publicUrl = `${pub.protocol}//${pub.host}`;

  if (!env.SITE_SESSION_KEY) falta('SITE_SESSION_KEY', 'falta: la llave de la sesión (al menos 32 bytes al azar)');
  else if (Buffer.byteLength(env.SITE_SESSION_KEY, 'utf8') < 32) falta('SITE_SESSION_KEY', 'es corta: tiene que tener al menos 32 bytes');
  else cfg.sessionKey = Buffer.from(env.SITE_SESSION_KEY, 'utf8');

  const prov = env.SITE_AUTH_PROVIDER;
  if (!prov) falta('SITE_AUTH_PROVIDER', `falta: ${Object.keys(PROVEEDORES).join(', ')}`);
  else if (!PROVEEDORES[prov]) falta('SITE_AUTH_PROVIDER', `tiene que ser uno de: ${Object.keys(PROVEEDORES).join(', ')}`);
  cfg.provider = prov;
  for (const v of ['SITE_OIDC_CLIENT_ID', 'SITE_OIDC_CLIENT_SECRET']) if (!env[v]) falta(v, 'falta: la de la aplicación registrada en el proveedor');
  cfg.clientId = env.SITE_OIDC_CLIENT_ID;
  cfg.clientSecret = env.SITE_OIDC_CLIENT_SECRET;

  const dominios = String(env.SITE_AUTH_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (dominios.some((d) => !DOMINIO.test(d))) falta('SITE_AUTH_ALLOWED_DOMAINS', 'tiene que ser una lista de dominios separados por coma');
  cfg.allowedDomains = dominios;
  if (env.SITE_OIDC_EMAIL_CLAIM && !/^[A-Za-z0-9_.:-]{1,64}$/.test(env.SITE_OIDC_EMAIL_CLAIM)) falta('SITE_OIDC_EMAIL_CLAIM', 'no tiene la forma del nombre de una claim');
  cfg.emailClaim = env.SITE_OIDC_EMAIL_CLAIM || 'email';

  if (PROVEEDORES[prov]) {
    problemas.push(...PROVEEDORES[prov].problemasDeConfig(env, { dominios }));
    // lo propio de un proveedor que el sitio muestra (su modo), sin valores secretos
    cfg.opciones = typeof PROVEEDORES[prov].opcionesDe === 'function' ? PROVEEDORES[prov].opcionesDe(env) : null;
    // con qué se entra, en palabras: Configuración lo muestra de sólo lectura (se cambia en la instalación)
    cfg.inicioDeSesion = { proveedor: prov, modo: cfg.opciones && cfg.opciones.modo ? cfg.opciones.modo : null,
      texto: typeof PROVEEDORES[prov].describir === 'function' ? PROVEEDORES[prov].describir(cfg.opciones || {}) : texto('es', 'proveedor.otro', { prov }) };
    // un proveedor con lo suyo fijo (emisor, direcciones, organización) lo completa él; los demás usan SITE_OIDC_ISSUER
    if (typeof PROVEEDORES[prov].completarConfig === 'function') PROVEEDORES[prov].completarConfig(env, cfg);
    else if (env.SITE_OIDC_ISSUER) {
      let iss = null;
      try { iss = new URL(env.SITE_OIDC_ISSUER); } catch { /* abajo */ }
      if (!iss || !(iss.protocol === 'https:' || esLoopback(iss))) falta('SITE_OIDC_ISSUER', 'tiene que ser una dirección https:// (sólo en pruebas, http://127.0.0.1)');
      cfg.issuer = env.SITE_OIDC_ISSUER;
    }
  }

  let repo = null;
  try { repo = new URL(env.SITE_OPERATIONS_REPO || ''); } catch { /* abajo */ }
  if (!env.SITE_OPERATIONS_REPO) falta('SITE_OPERATIONS_REPO', 'falta: la dirección https del repo de operaciones');
  else if (!repo || !(repo.protocol === 'https:' || esLoopback(repo)) || repo.username || repo.password) falta('SITE_OPERATIONS_REPO', 'tiene que ser una dirección https:// (o http en la propia máquina, para probar), sin usuario ni credencial adentro');
  cfg.operationsRepo = env.SITE_OPERATIONS_REPO;
  // de dónde se lee operaciones: `repo` (lo de siempre, un clon) o `copy` (la foto que deja un trabajo en
  // un contenedor de almacenamiento). Leer de la copia es una elección explícita: sin la variable, el repo
  const fuente = env.SITE_OPERATIONS_SOURCE === undefined || env.SITE_OPERATIONS_SOURCE === '' ? 'repo' : env.SITE_OPERATIONS_SOURCE;
  if (fuente !== 'repo' && fuente !== 'copy') falta('SITE_OPERATIONS_SOURCE', 'los valores son repo (o ausente) y copy');
  cfg.operationsSource = fuente;
  cfg.operationsCopy = null;
  if (fuente === 'copy') {
    // con la copia, el permiso del repo sobra: una sola credencial de lectura, como hoy
    for (const v of ['SITE_OPERATIONS_TOKEN', 'SITE_OPERATIONS_IDENTITY']) if (env[v]) falta(v, 'sobra: con SITE_OPERATIONS_SOURCE=copy el sitio lee la copia, no el repo; sacala');
    const m = /^([a-z0-9]{3,24})\/([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62})$/.exec(env.SITE_OPERATIONS_COPY || '');
    if (!m) falta('SITE_OPERATIONS_COPY', 'falta o no tiene forma: <cuenta>/<contenedor> de la copia de operaciones');
    const sas = env.SITE_OPERATIONS_COPY_SAS;
    if (sas) {
      const q = new URLSearchParams(String(sas).replace(/^\?/, ''));
      const sp = q.get('sp') || '';
      if (q.get('sr') !== 'c' || !sp.includes('r') || /[^rl]/.test(sp) || !q.get('se') || !q.get('sig')) falta('SITE_OPERATIONS_COPY_SAS', 'tiene que ser una SAS del contenedor (sr=c) sólo de lectura (sp=r o rl), con vencimiento');
    }
    if (m) cfg.operationsCopy = { cuenta: m[1], contenedor: m[2], credencial: sas ? { sas: String(sas).replace(/^\?/, '') } : { managed: true } };
    cfg.operationsCredencial = null;
  } else {
    for (const v of ['SITE_OPERATIONS_COPY', 'SITE_OPERATIONS_COPY_SAS']) if (env[v]) falta(v, 'sobra: sólo se usa con SITE_OPERATIONS_SOURCE=copy');
    if (env.SITE_OPERATIONS_TOKEN && env.SITE_OPERATIONS_IDENTITY) falta('SITE_OPERATIONS_IDENTITY', 'va una sola credencial del repo de operaciones: el token o la identidad administrada');
    else if (env.SITE_OPERATIONS_IDENTITY && env.SITE_OPERATIONS_IDENTITY !== 'managed') falta('SITE_OPERATIONS_IDENTITY', 'el único valor es managed');
    else if (!env.SITE_OPERATIONS_TOKEN && !env.SITE_OPERATIONS_IDENTITY) falta('SITE_OPERATIONS_TOKEN', 'falta la credencial del repo de operaciones: SITE_OPERATIONS_TOKEN o SITE_OPERATIONS_IDENTITY=managed');
    cfg.operationsCredencial = env.SITE_OPERATIONS_TOKEN ? { token: env.SITE_OPERATIONS_TOKEN } : (env.SITE_OPERATIONS_IDENTITY === 'managed' ? { managed: true } : null);
  }

  if (env.SITE_MAILBOX_SAS && env.SITE_MAILBOX_IDENTITY) falta('SITE_MAILBOX_IDENTITY', 'va una sola credencial del buzón: la SAS de lectura o la identidad administrada');
  else if (env.SITE_MAILBOX_IDENTITY && env.SITE_MAILBOX_IDENTITY !== 'managed') falta('SITE_MAILBOX_IDENTITY', 'el único valor es managed');
  cfg.mailboxCredencial = env.SITE_MAILBOX_SAS ? { sas: env.SITE_MAILBOX_SAS } : (env.SITE_MAILBOX_IDENTITY === 'managed' ? { managed: true } : null);

  if (env.SITE_FIRST_MAINTAINER !== undefined) {
    const fm = String(env.SITE_FIRST_MAINTAINER);
    if (!CORREO.test(fm)) falta('SITE_FIRST_MAINTAINER', 'tiene que ser UN correo, sin espacios ni separadores');
    else cfg.firstMaintainer = fm.toLowerCase();
  }

  // la pestaña Configuración: todas opcionales
  if (env.SITE_PROFILE_REPO) {
    let perfil = null;
    try { perfil = new URL(env.SITE_PROFILE_REPO); } catch { /* abajo */ }
    if (!perfil || !(perfil.protocol === 'https:' || esLoopback(perfil)) || perfil.username || perfil.password) falta('SITE_PROFILE_REPO', 'tiene que ser una dirección https:// (o http en la propia máquina, para probar), sin usuario ni credencial adentro');
    else if (!env.SITE_PROFILE_TOKEN) falta('SITE_PROFILE_TOKEN', 'falta: la credencial de lectura del perfil del equipo (SITE_PROFILE_REPO está puesta)');
    cfg.profileRepo = env.SITE_PROFILE_REPO;
    cfg.profileCredencial = env.SITE_PROFILE_TOKEN ? { token: env.SITE_PROFILE_TOKEN } : null;
  } else cfg.profileRepo = null;
  cfg.escritura = { operaciones: env.SITE_OPERATIONS_WRITE_TOKEN || null, perfil: env.SITE_PROFILE_WRITE_TOKEN || null, productos: env.SITE_PRODUCTS_WRITE_TOKEN || null };
  cfg.pipelinesToken = env.SITE_PIPELINES_TOKEN || null;

  if (env.PORT !== undefined && env.PORT !== '') {
    const p = Number(env.PORT);
    if (!Number.isInteger(p) || p < 1 || p > 65535) falta('PORT', 'tiene que ser un puerto (1 a 65535)');
    else cfg.port = p;
  }
  if (!cfg.port) cfg.port = 8080;
  cfg.dataDir = env.SITE_DATA_DIR || null;
  cfg.redirectUri = cfg.publicUrl ? `${cfg.publicUrl}/auth/callback` : null;
  return { ok: problemas.length === 0, problemas, cfg };
}

/** Lo que dice el registro del arranque: qué variable está, nunca su valor. */
function lineasDeArranque(env) {
  // el modo demo se dice siempre: el sitio real dice `demo: false`, así se puede probar que no lo tiene
  return [...VARIABLES.map((v) => `${v}: ${env[v] !== undefined && env[v] !== '' ? 'presente' : 'ausente'}`), `demo: ${env.SITE_DEMO === '1'}`];
}

// ── La tabla de rutas ─────────────────────────────────────────────────────────────────────────────────────────────
const html = (cuerpo, status = 200) => ({ status, tipo: 'text/html; charset=utf-8', cuerpo });
const RUTAS = [
  { method: 'GET', path: '/', needs: ['maintainer', 'person'], pestana: { id: 'inicio', titulo: 'Inicio', orden: 10 }, handler: (ctx) => html(views.paginaInicio(ctx)) },
  { method: 'GET', path: '/proyectos', needs: ['maintainer', 'person'], pestana: { id: 'proyectos', titulo: 'Proyectos', orden: 30 }, handler: (ctx) => html(views.paginaProyectos(ctx)) },
  { method: 'GET', path: '/arnes', needs: ['maintainer'], pestana: { id: 'arnes', titulo: 'Arnés', orden: 40 }, handler: (ctx) => html(views.paginaArnes(ctx)) },
  { method: 'GET', path: '/api/inicio', needs: ['maintainer', 'person'], handler: (ctx) => ({ status: 200, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(views.inicioJson(ctx)) }) },
];

/**
 * Una ruta con parámetros: un tramo `:nombre` vale un tramo cualquiera, sin `/`. Devuelve la función que
 * compara una ruta pedida y da `{ nombre: valor }` (o null). Sin parámetros, la comparación es exacta, como siempre.
 */
function patronDe(p) {
  const tramos = p.split('/');
  const nombres = tramos.filter((t) => t.startsWith(':')).map((t) => t.slice(1));
  if (!nombres.length) return (ruta) => (ruta === p ? {} : null);
  const rx = new RegExp(`^${tramos.map((t) => (t.startsWith(':') ? '([^/]+)' : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
  return (ruta) => {
    const m = rx.exec(ruta);
    if (!m) return null;
    try { return Object.fromEntries(nombres.map((n, i) => [n, decodeURIComponent(m[i + 1])])); } catch { return null; }
  };
}

/** Valida una tabla de rutas: cada una con método, ruta, `needs` del vocabulario y su función. Tira nombrando la ruta. */
function validarRutas(rutas) {
  const vistas = new Set();
  for (const r of rutas) {
    const nombre = `${r && r.method} ${r && r.path}`;
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/') || typeof r.method !== 'string') throw new Error(`ruta mal formada: ${nombre}`);
    if (r.path.split('/').some((t) => t.startsWith(':') && !/^:[a-z][a-zA-Z0-9]*$/.test(t))) throw new Error(`ruta mal formada: ${nombre} (un parámetro es «:nombre»)`);
    if (!Array.isArray(r.needs) || r.needs.length === 0 || r.needs.some((n) => !NEEDS.has(n))) throw new Error(`la ruta ${nombre} no declara quién puede verla (needs: maintainer, person): el sitio no arranca con una ruta abierta`);
    if (typeof r.handler !== 'function') throw new Error(`la ruta ${nombre} no tiene función`);
    if (vistas.has(nombre)) throw new Error(`la ruta ${nombre} está dos veces`);
    vistas.add(nombre);
  }
  return rutas;
}

// base-uri y form-action (revisión de seguridad): sin ellas, un <base> o un formulario inyectado cambiaría adónde van los
// enlaces y los envíos aunque no corra ningún script
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// el logo de la organización: hasta este tamaño, y un svg sin nada que corra ni que salga a buscar afuera
const LOGO_MAX = 512 * 1024;
const SVG_CON_CODIGO = /<script|<foreignObject|<iframe|<!ENTITY|\bon[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["']?\s*(?!#)[a-z]/i;
const isObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// menos que esto no vale lo que cuesta comprimirlo
const MIN_COMPRIMIR = 1024;
// la etiqueta de un cuerpo que no cambia mientras el proceso vive: se calcula una vez por texto
const etiquetas = new Map();
function etiquetaDe(cuerpo) {
  const guardable = typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo);
  if (guardable && etiquetas.has(cuerpo)) return etiquetas.get(cuerpo);
  const e = `"${crypto.createHash('sha256').update(cuerpo).digest('base64url').slice(0, 27)}"`;
  if (guardable && etiquetas.size < 32) etiquetas.set(cuerpo, e);
  return e;
}

/**
 * Las rutas que contestan sin sesión y que un candado delante del sitio tiene que dejar pasar: la vida y la salud, la
 * página de salida con lo que carga (hoja de estilo, código y letra) y el selector de idioma. Rutas exactas, sin comodines.
 */
const SONDAS = new Set(['/livez', '/healthz', '/readyz']);
const RUTAS_SIN_SESION = ['/healthz', '/livez', '/saliste', '/idioma', '/static/site.css', '/static/site.js', '/static/fonts/lato-400.woff2', '/static/fonts/lato-700.woff2'];

function leerEstatico() {
  const { CSS_BASE, CSS_CHIPS } = require('../nightly/dashboard/common.js');
  const dir = path.join(__dirname, 'static');
  return {
    '/static/site.css': { tipo: 'text/css; charset=utf-8', cuerpo: `${CSS_BASE}\n${CSS_CHIPS}\n${fs.readFileSync(path.join(dir, 'site.css'), 'utf8')}` },
    '/static/site.js': { tipo: 'text/javascript; charset=utf-8', cuerpo: fs.readFileSync(path.join(dir, 'site.js'), 'utf8') },
    // el editor de texto largo, una sola pieza para los cuadros de texto largo de las pestañas
    '/static/long-text-editor.js': { tipo: 'text/javascript; charset=utf-8', cuerpo: fs.readFileSync(path.join(dir, 'long-text-editor.js'), 'utf8') },
    // la letra del sitio viaja con él: la política no deja cargar nada de afuera
    '/static/fonts/lato-400.woff2': { tipo: 'font/woff2', cuerpo: fs.readFileSync(path.join(dir, 'fonts', 'lato-400.woff2')) },
    '/static/fonts/lato-700.woff2': { tipo: 'font/woff2', cuerpo: fs.readFileSync(path.join(dir, 'fonts', 'lato-700.woff2')) },
    // la licencia y los créditos de la versión que corre, para el pie de cada página
    '/licencia': textoDeLaRaiz('LICENSE'),
    '/creditos': textoDeLaRaiz('NOTICE', [['Lato (la letra del sitio)', path.join(dir, 'fonts', 'OFL.txt')]]),
  };
}

/** Un archivo de texto de la raíz del arnés, con anexos; sin él, la página dice que esta instalación no lo trae. */
function textoDeLaRaiz(nombre, anexos = []) {
  const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const base = leer(path.join(__dirname, '..', '..', nombre));
  const partes = [base === null ? `${nombre}: esta instalación del sitio no lo trae.` : base];
  for (const [titulo, f] of anexos) { const t = leer(f); if (t !== null) partes.push(`\n\n── ${titulo} ──\n\n${t}`); }
  return { tipo: 'text/plain; charset=utf-8', cuerpo: partes.join('') };
}

/**
 * El sitio, sin escuchar todavía. `fuentes` cumple el contrato de sources.js (estado, config, modelo, refrescar,
 * detener); `ahora` (ms) y `log` se inyectan en las pruebas; `rutasExtra` es como las pestañas Corridas y Configuración suman las suyas.
 */
function crearSitio({ env = process.env, fuentes, ahora = Date.now, log = (l) => process.stdout.write(`${l}\n`), rutasExtra = [], version = VERSION, vigia = null, alEntrar = null, demo = null } = {}) {
  // el modo demo (demo.js) trae su propia configuración, sin proveedor ni credenciales
  const v = demo ? { ok: true, cfg: demo.cfg } : validarConfiguracion(env);
  if (!v.ok) throw Object.assign(new Error(v.problemas.map((p) => `${p.variable}: ${p.motivo}`).join('\n')), { problemas: v.problemas });
  const cfg = v.cfg;
  // la última publicada en `stable`: una vez por hora como máximo, sin credenciales, guardada en el disco.
  // Nunca frena un pedido: se mira de fondo y la página dice lo que se sabe hasta ahí
  const ultima = vigia || require('./latest-release.js').crearVigia({ imagen: IMAGEN, dataDir: cfg.dataDir, ahora, log: (l) => log(l) });
  const rutas = validarRutas([...RUTAS, ...rutasExtra]).map((r) => ({ ...r, coincide: patronDe(r.path) }));
  if (!fuentes) throw new Error('crearSitio necesita las fuentes (scripts/site/sources.js)');
  const proveedor = demo ? demo.proveedor : PROVEEDORES[cfg.provider].crear(cfg, { ahora });
  const estatico = leerEstatico();
  const consumidos = new Map();   // state → vencimiento: sólo para RECHAZAR repeticiones en este proceso
  const https = cfg.publicUrl.startsWith('https:');
  let reintento = null;

  // 🔴 al registro va cada línea sin caracteres de control: lo que llega en un pedido no puede fabricar una línea nueva
  const registrar = (l) => { try { log(limpiarLinea(l)); } catch { /* el registro no tumba un pedido */ } };
  // dónde se decide lo del Inicio de quien mantiene: el repo de operaciones, si es una dirección https navegable
  const enlaceOperaciones = (() => { try { const u = new URL(cfg.operationsRepo); return u.protocol === 'https:' ? `${u.origin}${u.pathname.replace(/\.git$/, '')}` : null; } catch { return null; } })();

  function cabeceras(res, tipo) {
    res.setHeader('Content-Type', tipo);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // el Referer viaja sólo dentro del sitio (nunca a otro). Con `no-referrer`, el candado de la plataforma (el inicio de
    // sesión integrado de una nube) tomaría cada POST de Configuración por falsificado: su anti-CSRF mira el Referer, no el
    // Origin (403, subestado 60)
    res.setHeader('Referrer-Policy', 'same-origin');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // un sitio público sin cuenta: que ningún buscador lo indexe
    if (demo) res.setHeader('X-Robots-Tag', 'noindex');
  }
  function enviar(res, { status, tipo = 'text/html; charset=utf-8', cuerpo = '', extra = {} }) {
    cabeceras(res, tipo);
    // el modo demo: «Datos de ejemplo» arriba de cada página (también las de error) y en su título
    if (demo && typeof cuerpo === 'string' && /^text\/html/.test(tipo) && res.req) {
      const cookies = session.leerCookies(res.req.headers.cookie);
      const u = (() => { try { return new URL(res.req.url, 'http://sitio.invalid'); } catch { return null; } })();
      cuerpo = demo.marcar(cuerpo, { idioma: idiomaSinSesion(res.req, cookies), como: demo.comoDe(cookies), url: u });
    }
    for (const [k, val] of Object.entries(extra)) res.setHeader(k, val);
    const pedido = res.req || {};
    const pide = (k) => String((pedido.headers && pedido.headers[k]) || '');
    // los estilos y el código de pantalla no traen nada de nadie: el navegador los guarda y pregunta si cambiaron (304)
    if (status === 200 && /^(text\/(css|javascript)|font\/)/.test(tipo) && !extra['Cache-Control']) {
      const etiqueta = etiquetaDe(cuerpo);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etiqueta);
      if (pide('if-none-match').split(',').map((x) => x.trim()).includes(etiqueta)) { res.statusCode = 304; return res.end(); }
    }
    res.statusCode = status;
    // comprimido, para quien lo acepta: la página de Corridas y su lista pasan de unos 3,5 MB a unos 0,3 MB por visita
    let datos = cuerpo;
    if (Buffer.byteLength(datos) >= MIN_COMPRIMIR && !/^(font|image)\//.test(tipo) && /\bgzip\b/.test(pide('accept-encoding')) && !res.getHeader('Content-Encoding')) {
      datos = zlib.gzipSync(datos, { level: 5 });
      res.setHeader('Content-Encoding', 'gzip');
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.end(datos);
  }
  const json = (res, status, obj, extra) => enviar(res, { status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj), extra });

  /** La marca de la organización (site.brand de operations.json): el nombre, si hay logo, y qué hacer con él en oscuro. */
  function marcaDe(config) {
    const b = config && isObjeto(config.site) && isObjeto(config.site.brand) ? config.site.brand : {};
    return { nombre: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null, logo: typeof b.logo === 'string' && BRAND_LOGO.test(b.logo), oscuro: b.dark === 'keep' ? 'keep' : 'invert' };
  }
  /**
   * El logo, del repo de operaciones (el repo del equipo se copia a cada máquina y no lleva archivos fuera de su lista): un .png con su firma o un .svg sin código ni enlaces afuera, de hasta LOGO_MAX bytes,
   * leído adentro del clon. Se sirve con una política que no deja correr nada, aunque se abra solo.
   */
  function logo() {
    const no = { status: 404, tipo: 'text/plain; charset=utf-8', cuerpo: '' };
    const config = fuentes.config();
    const rel = config && isObjeto(config.site) && isObjeto(config.site.brand) ? config.site.brand.logo : null;
    const cl = typeof fuentes.clones === 'function' ? fuentes.clones() : null;
    const dir = cl && cl.operaciones && cl.operaciones.dir;
    if (typeof rel !== 'string' || !BRAND_LOGO.test(rel) || !dir) return no;
    const f = path.join(dir, rel);
    let datos;
    try { if (!dentroDe(dir, f)) return no; const st = fs.statSync(f); if (!st.isFile() || st.size > LOGO_MAX) return no; datos = fs.readFileSync(f); } catch { return no; }
    let tipo;
    if (rel.endsWith('.png')) {
      if (datos.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') { registrar(`el logo ${rel} no es un png: no se sirve`); return no; }
      tipo = 'image/png';
    } else {
      if (SVG_CON_CODIGO.test(datos.toString('utf8'))) { registrar(`el logo ${rel} trae código o enlaces afuera: no se sirve`); return no; }
      tipo = 'image/svg+xml';
    }
    return { status: 200, tipo, cuerpo: datos, extra: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'private, max-age=300' } };
  }

  function pestanasPara(rol, idioma) {
    // una pestaña sin su clave en la tabla se ve con su título de la tabla de rutas, y se dice en el registro
    const titulo = (p) => { try { return texto(idioma, `pestana.${p.id}`); } catch (e) { registrar(`idioma: la pestaña ${p.id} no tiene su título en la tabla de textos (${e.message})`); return p.titulo; } };
    // `cuenta`: cuántas cosas esperan en la pestaña, al lado de su nombre («Mantenimiento (3)»); en cero o si no se
    // pudo contar, sólo el nombre: el menú sale igual
    const cuenta = (p) => { if (typeof p.cuenta !== 'function') return 0; try { const n = p.cuenta(); return Number.isInteger(n) && n > 0 ? n : 0; } catch (e) { registrar(`menú: la pestaña ${p.id} no pudo contar (${e.message})`); return 0; } };
    return rutas.filter((r) => r.pestana && r.needs.includes(rol)).map((r) => {
      const { cuenta: _c, ...p } = r.pestana;
      const n = cuenta(r.pestana);
      return { ...p, titulo: n ? `${titulo(p)} (${n})` : titulo(p), path: r.path };
    }).sort((a, b) => a.orden - b.orden);
  }

  // ── el idioma de cada pedido y dónde se recuerda (language.js) ──
  const preferencias = LANG.crearPreferencias({ dataDir: cfg.dataDir, llave: cfg.sessionKey, log: (l) => registrar(l) });
  /** El idioma de un pedido sin sesión (o antes de saber quién es): la cookie, después el navegador. */
  const idiomaSinSesion = (req, cookies) => LANG.elegir({ cookie: cookies[LANG.COOKIE] || null, navegador: req.headers['accept-language'] });
  /** Con sesión: la preferencia guardada de la persona va primero. */
  const idiomaDePersona = (req, cookies, quien) => LANG.elegir({ persona: quien && quien.rol !== 'none' ? preferencias.leer(quien.correos || [quien.email]) : null, cookie: cookies[LANG.COOKIE] || null, navegador: req.headers['accept-language'] });
  // quien sale de la lista del sitio pierde su preferencia: se poda cada vez que el sitio lee una lista nueva
  let configPodada = null;
  function podarSiCambio(config) {
    if (!config || config === configPodada || !preferencias.disponible) return;
    const correos = access.listaDeAcceso(config).entradas.flatMap((e) => e.emails || []);
    if (cfg.firstMaintainer) correos.push(cfg.firstMaintainer);
    const borradas = preferencias.podar(correos);
    // una poda que no pudo (el archivo ilegible, el disco) se vuelve a probar en el próximo pedido
    if (borradas < 0) return;
    configPodada = config;
    if (borradas) registrar(`idioma: se borró la preferencia de ${borradas} persona(s) que salieron de la lista del sitio`);
  }
  /** El candado de origen de las escrituras: el `Origin` del sitio; sin él, un `Referer` del sitio o `Sec-Fetch-Site`. */
  function delSitio(req) {
    const h = req.headers;
    if (h.origin) return h.origin === cfg.publicUrl;
    if (h.referer) return h.referer === cfg.publicUrl || h.referer.startsWith(`${cfg.publicUrl}/`);
    return h['sec-fetch-site'] === 'same-origin';
  }
  /** El cuerpo de un formulario chico (hasta 2 KB). */
  const leerFormulario = (req) => new Promise((resolve) => {
    let n = 0; const partes = [];
    req.on('data', (c) => { n += c.length; if (n <= 2048) partes.push(c); });
    req.on('end', () => { try { resolve(n > 2048 ? new URLSearchParams() : new URLSearchParams(Buffer.concat(partes).toString('utf8'))); } catch { resolve(new URLSearchParams()); } });
    req.on('error', () => resolve(new URLSearchParams()));
  });
  /** POST /idioma: elegir el idioma (con sesión se guarda por persona; siempre, la cookie) y volver a la página. */
  const cerradas = session.crearCerradas({ dataDir: cfg.dataDir, ahora, log: (l) => registrar(l) });
  /** La sesión de la cookie, o null: vencida, de otro proveedor, alterada o cerrada con «Salir» es «sin sesión». */
  const sesionDe = (cookies) => {
    const s = session.leerSesion(cookies, cfg.sessionKey, ahora(), { prov: proveedor.nombre, iss: proveedor.emisor });
    return s && !cerradas.cerrada(s) ? s : null;
  };
  /** ¿El token del formulario es el de la sesión? Tiempo constante. */
  const mismoToken = (ses, recibido) => {
    const a = Buffer.from(typeof ses.tok === 'string' ? ses.tok : '');
    const b = Buffer.from(String(recibido || ''));
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  async function cambiarIdioma(req, res, cookies) {
    if (req.method !== 'POST') return enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'POST' } });
    if (!delSitio(req)) { registrar('idioma: cambio rechazado, el pedido viene de otro origen'); return enviar(res, { status: 403, tipo: 'text/plain; charset=utf-8', cuerpo: '' }); }
    const form = await leerFormulario(req);
    const pedida = String(form.get('volver') || '');
    // sólo una ruta propia, en caracteres que una cabecera admite: nada de otra dirección (`//x`, `/\x`), de controles ni
    // de un carácter fuera de ASCII (la cabecera Location lo rechaza y el pedido terminaría en la página de error)
    const volver = /^\/(?![/\\])[\x21-\x7e]{0,500}$/.test(pedida) ? pedida : '/';
    const idioma = LANG.valido(form.get('idioma'));
    if (!idioma) return enviar(res, { status: 303, cuerpo: '', extra: { Location: volver } });
    // el sitio demo no tiene cuentas: el idioma vale sólo en la cookie, nada se guarda
    const ses = demo ? null : sesionDe(cookies);
    if (ses) {
      const st = fuentes.estado();
      const config = st.navegable || st.cargado ? fuentes.config() : null;
      const quien = config ? access.quienPide(ses, { config, firstMaintainer: cfg.firstMaintainer }) : null;
      if (quien && quien.rol !== 'none') preferencias.guardar(quien.email, idioma);
      // sin la lista leída no se sabe quién es: vale la cookie, y se dice (lo guardado antes podría volver a ganar)
      else if (!config) registrar('idioma: el sitio todavía no leyó la lista: la elección vale sólo en la cookie del navegador');
    }
    return enviar(res, { status: 303, cuerpo: '', extra: { Location: volver, 'Set-Cookie': LANG.cookieDe(idioma, { https }) } });
  }

  // las puertas de un proveedor que tiene más de una (la de los invitados del directorio); una vía que no
  // es suya es la principal
  const vias = Array.isArray(proveedor.vias) && proveedor.vias.length > 1 ? proveedor.vias : null;
  const viaDe = (v) => (vias && vias.some((x) => x.id && x.id === v) ? v : null);
  // las puertas con su texto en el idioma de la página; null con una sola
  const puertas = (idioma) => (vias ? vias.map((v) => ({ ...v, texto: traducirMensaje(idioma, v.texto) })) : null);

  /**
   * Al emisor. `otraCuenta`: el proveedor pide elegir la cuenta (quien entró con una que no está en la lista);
   * `via`: por cuál de sus puertas (queda en el intento firmado, y la vuelta la usa).
   */
  function irAlEmisor(res, { otraCuenta = false, via = null, idioma = LANG.POR_DEFECTO, url = null } = {}) {
    if (!proveedor.listo()) return enviar(res, { status: 503, cuerpo: views.paginaSimple(texto(idioma, 'servidor.loginNoListoTitulo'), texto(idioma, 'servidor.loginNoListo'), { idioma, url }), extra: { 'Retry-After': '10' } });
    const t = ahora();
    const nuevo = session.nuevoIntento(cfg.sessionKey, t, { via: viaDe(via) });
    return enviar(res, { status: 302, cuerpo: '', extra: { Location: proveedor.urlDeInicio({ state: nuevo.intento.state, nonce: nuevo.intento.nonce, challenge: nuevo.challenge, otraCuenta, via: nuevo.intento.via }), 'Set-Cookie': nuevo.cookie } });
  }

  async function vuelta(req, res, u, cookies) {
    const idioma = idiomaSinSesion(req, cookies);
    const T = (k, v) => texto(idioma, k, v);
    const borrarIntento = session.borrar(session.INTENTO);
    const rechazo = (status, pantalla, motivo, enlace = null) => {
      registrar(`inicio de sesión rechazado: ${motivo}`);
      // lo que dice el proveedor, en el idioma de la página
      const link = enlace ? { ...enlace, texto: traducirMensaje(idioma, enlace.texto) } : null;
      return enviar(res, { status, cuerpo: views.paginaNoEntro(pantalla, link, { idioma, url: u }), extra: { 'Set-Cookie': borrarIntento } });
    };
    const t = ahora();
    for (const [s, exp] of consumidos) if (exp <= t) consumidos.delete(s);
    const li = session.leerIntento(cookies, cfg.sessionKey, t);
    if (!li.intento) return rechazo(400, T('servidor.intentoVencido'), li.motivo);
    const it = li.intento;
    const state = u.searchParams.get('state');
    if (!state || state !== it.state) return rechazo(400, T('servidor.intentoVencido'), 'el state no es el del intento');
    if (consumidos.has(state)) return rechazo(400, T('servidor.intentoVencido'), 'el state ya se usó');
    consumidos.set(state, it.exp);
    const code = u.searchParams.get('code');
    // el `error` de la vuelta lo controla cualquiera: al registro va sólo con la forma de un código de OAuth
    const errorDelEmisor = String(u.searchParams.get('error') || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
    if (!code) return rechazo(400, T('servidor.sinCodigo'), `sin código${errorDelEmisor ? ` (${errorDelEmisor})` : ''}`);
    let ident;
    try {
      ident = await proveedor.completar({ code, verifier: it.verifier, nonce: it.nonce, via: viaDe(it.via) });
    } catch (e) {
      if (e instanceof oidc.ErrorDeIngreso) return rechazo(403, T('servidor.noSePudoEntrar', { pantalla: traducirMensaje(idioma, e.pantalla) }), e.motivo, e.enlace);
      return rechazo(400, T('servidor.noSeCompleto'), (e && e.motivo) || (e && e.message) || String(e));
    }
    const ses = session.nuevaSesion({ ...ident, prov: proveedor.nombre, iss: proveedor.emisor }, cfg.sessionKey, ahora());
    // el porqué de una página sin datos, sin el correo: la lista se lee con la configuración vigente
    const config = fuentes.estado().navegable || fuentes.estado().cargado ? fuentes.config() : null;
    const sinLista = config && access.quienPide(ident, { config, firstMaintainer: cfg.firstMaintainer }).rol === 'none';
    registrar(`inicio de sesión: entró una cuenta (${proveedor.nombre})${sinLista ? ' que no está en la lista del sitio: ve la página sin datos' : ''}`);
    // quien entra y estaba invitado queda «aceptada» (invitations.js); un ingreso nunca falla por esto
    if (alEntrar && !sinLista) { try { alEntrar(ident.email); } catch (e) { registrar(`inicio de sesión: no pude anotar el ingreso para las invitaciones (${(e && e.message) || e})`); } }
    return enviar(res, { status: 302, cuerpo: '', extra: { Location: '/', 'Set-Cookie': [ses, borrarIntento, session.borrar(session.MARCA)] } });
  }

  async function manejar(req, res) {
    let u;
    try { u = new URL(req.url, 'http://sitio.invalid'); } catch { return enviar(res, { status: 400, cuerpo: '' }); }
    const ruta = u.pathname;
    const st = fuentes.estado();

    // el tope de pedidos del sitio demo: por dirección, salvo las sondas de la plataforma
    if (demo && !SONDAS.has(ruta)) {
      const tope = demo.tope(req);
      if (!tope.ok) return enviar(res, { status: 429, tipo: 'text/plain; charset=utf-8', cuerpo: '', extra: { 'Retry-After': String(tope.reintentarEn) } });
    }
    if (ruta === '/livez') return json(res, 200, { ok: true, demo: Boolean(demo) });
    if (ruta === '/healthz') return st.frenado ? json(res, 503, { ok: false, motivo: `la configuración de la organización no valida desde ${views.hora(Number.isFinite(st.frenado.fallaDesde) ? st.frenado.fallaDesde : st.frenado.desde)}` }) : json(res, 200, { ok: true });
    if (ruta === '/readyz') return st.cargado ? json(res, 200, { ok: true }) : json(res, 503, { ok: false, motivo: 'cargando' }, { 'Retry-After': '5' });
    if (estatico[ruta] && req.method === 'GET') return enviar(res, { status: 200, ...estatico[ruta] });

    const cookies = session.leerCookies(req.headers.cookie);
    // el idioma antes de saber quién pide: la cookie y el navegador; con sesión, abajo, la persona primero
    let idioma = idiomaSinSesion(req, cookies);
    if (ruta === '/idioma') return cambiarIdioma(req, res, cookies);
    if (demo) {
      // sin cuentas: ni inicio ni cierre de sesión; «Ver como» sólo cambia la vista (una cookie), con el candado de origen
      if (ruta.startsWith('/auth/') || ruta === '/saliste') return enviar(res, { status: 303, cuerpo: '', extra: { Location: '/' } });
      if (ruta === '/demo/ver-como') {
        if (req.method !== 'POST') return enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'POST' } });
        if (!delSitio(req)) return enviar(res, { status: 403, tipo: 'text/plain; charset=utf-8', cuerpo: '' });
        const form = await leerFormulario(req);
        const pedida = String(form.get('volver') || '');
        const volver = /^\/(?![/\\])[\x21-\x7e]{0,500}$/.test(pedida) ? pedida : '/';
        const como = demo.comoValido(form.get('como'));
        return enviar(res, { status: 303, cuerpo: '', extra: { Location: volver, ...(como ? { 'Set-Cookie': demo.cookieDeVista(como, { https }) } : {}) } });
      }
    }
    // tras «Salir» (la marca), entrar pide siempre elegir la cuenta: el proveedor conserva su sesión
    if (ruta === '/auth/login') return req.method === 'GET' ? irAlEmisor(res, { otraCuenta: u.searchParams.get('otra') === '1' || session.tieneMarca(cookies), via: u.searchParams.get('via'), idioma, url: u }) : enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'GET' } });
    if (ruta === '/auth/callback') return req.method === 'GET' ? vuelta(req, res, u, cookies) : enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'GET' } });
    if (ruta === '/saliste') return req.method === 'GET' ? enviar(res, { status: 200, cuerpo: views.paginaSaliste({ idioma, url: u, vias: puertas(idioma), sinInvalidar: u.searchParams.get('sin_invalidar') === '1' }) }) : enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'GET' } });
    if (ruta === '/auth/logout') {
      if (req.method !== 'POST') return enviar(res, { status: 405, cuerpo: views.paginaSimple(texto(idioma, 'servidor.salirTitulo'), texto(idioma, 'servidor.salirTexto'), { idioma, url: u }), extra: { Allow: 'POST' } });
      const ses = sesionDe(cookies);
      // desde otro sitio el navegador no manda la cookie de la sesión (SameSite=Lax): sin este freno, el sitio no ve sesión,
      // contesta 303 y el navegador borra la sesión y guarda la marca igual
      if (!ses && !delSitio(req)) {
        registrar('salir: pedido rechazado, no viene del sitio');
        return enviar(res, { status: 403, cuerpo: views.paginaSimple(texto(idioma, 'servidor.salirTitulo'), texto(idioma, 'servidor.salirNoValido'), { idioma, url: u }) });
      }
      // con sesión, «Salir» exige que el pedido venga del sitio y que traiga el token de la sesión: otra página no puede sacar a nadie
      const form = ses ? await leerFormulario(req) : null;
      if (ses && !(delSitio(req) && mismoToken(ses, form.get('tok')))) {
        registrar('salir: pedido rechazado, no viene del sitio o no trae el token de la sesión');
        // la página trae la barra con «Salir» y el token vigente (base64url, sin nada que escapar): quien tenía una pestaña vieja sale desde acá
        const cfgLeida = st.navegable || st.cargado ? fuentes.config() : null;
        const quienSalir = cfgLeida ? access.quienPide(ses, { config: cfgLeida, firstMaintainer: cfg.firstMaintainer }) : null;
        const cuerpo403 = quienSalir
          ? views.paginaSimple(texto(idioma, 'servidor.salirTitulo'), texto(idioma, 'servidor.salirNoValido'), { quien: quienSalir, sesion: ses, pestanas: pestanasPara(quienSalir.rol, idioma), idioma, url: u })
          : views.paginaSimple(texto(idioma, 'servidor.salirTitulo'), texto(idioma, 'servidor.salirNoValido'), { idioma, url: u }).replace('</main>', `<form class="salir" method="post" action="/auth/logout"><input type="hidden" name="tok" value="${ses.tok}"> <button type="submit">${texto(idioma, 'barra.salir')}</button></form></main>`);
        return enviar(res, { status: 403, cuerpo: cuerpo403 });
      }
      const invalidada = ses ? cerradas.cerrar(ses) : true;
      if (!invalidada) registrar('salir: la sesión se cerró en el navegador pero no se pudo anotar como cerrada en el servidor');
      // la vuelta se queda en el sitio: pasar por la salida del candado lleva al proveedor (otro origen), y el navegador corta
      // la navegación de un formulario que sale del sitio; la marca hace que, sin sesión, nada vuelva a entrar solo
      return enviar(res, { status: 303, cuerpo: '', extra: { Location: invalidada ? '/saliste' : '/saliste?sin_invalidar=1', 'Set-Cookie': [session.borrar(session.SESION), session.marcaDeSalida()] } });
    }

    // el sitio demo: cada visita entra con la sesión de ejemplo (la vista que eligió, sin cuenta)
    const ses = demo ? demo.sesion(cookies) : sesionDe(cookies);
    const esApi = ruta.startsWith('/api/');
    // un rechazo de /api/ dice por qué y qué hacer: la pantalla lo muestra tal cual (sin esto mostraría «respuesta 403»).
    // Nunca nombra a otra persona: a lo sumo, el correo de la propia sesión
    const rechazoApi = (status, codigo, message, extra) => json(res, status, { ok: false, codigo, message }, extra);
    if (!ses) {
      if (esApi) return rechazoApi(401, 'sesion_vencida', texto(idioma, 'servidor.apiSesionVencida'));
      // quien salió no vuelve a entrar sin un clic: al abrir una página, «Saliste» (con las puertas, si hay más de una);
      // otro método sigue como sin la marca
      if (session.tieneMarca(cookies) && (req.method === 'GET' || req.method === 'HEAD')) return enviar(res, { status: 200, cuerpo: views.paginaSaliste({ idioma, url: u, vias: puertas(idioma) }) });
      // con más de una puerta, se elige en la página de entrada; con una, directo al emisor
      return vias ? enviar(res, { status: 200, cuerpo: views.paginaEntrar(puertas(idioma), { idioma, url: u }) }) : irAlEmisor(res, { idioma, url: u });
    }
    if (ruta === '/marca/logo' && req.method === 'GET') return enviar(res, logo());

    // la preferencia de la persona, si el sitio ya sabe quién es (con la configuración leída)
    const configLeida = st.navegable || st.cargado ? fuentes.config() : null;
    if (configLeida) { podarSiCambio(configLeida); idioma = idiomaDePersona(req, cookies, access.quienPide(ses, { config: configLeida, firstMaintainer: cfg.firstMaintainer })); }
    if (st.frenado) return esApi ? rechazoApi(503, 'frenado', texto(idioma, 'servidor.apiFrenado', { desde: views.hora(st.frenado.desde, idioma) })) : enviar(res, { status: 503, cuerpo: views.paginaFrenado({ desde: st.frenado.desde, idioma, url: u }), extra: { 'Retry-After': '60' } });
    // la espera es POR FUENTE: con el repo de operaciones leído (`navegable`) el sitio se navega aunque el buzón siga
    // bajando; cada pestaña dice lo suyo (Corridas, «cargando las corridas»). /readyz, arriba, sigue esperando todo
    if (!st.cargado && !st.navegable) return esApi ? rechazoApi(503, 'cargando', texto(idioma, 'servidor.apiCargando'), { 'Retry-After': '5' }) : enviar(res, { status: 503, cuerpo: views.paginaCargando({ idioma, url: u }), extra: { 'Retry-After': '5' } });

    const config = fuentes.config();
    const quien = access.quienPide(ses, { config, firstMaintainer: cfg.firstMaintainer });
    if (quien.rol === 'none') {
      if (esApi && quien.sinMantenedores) return rechazoApi(403, 'sin_mantenedores', texto(idioma, 'servidor.apiSinMantenedores'));
      if (esApi) return rechazoApi(403, 'sin_rol', texto(idioma, 'servidor.apiSinRol', { cuenta: quien.correoDeIngreso || quien.email }));
      return enviar(res, { status: 200, cuerpo: quien.sinMantenedores ? views.paginaSinMantenedores({ quien, sesion: ses, idioma, url: u }) : views.paginaSinRol({ quien, sesion: ses, idioma, url: u }) });
    }
    let params = null;
    const r = rutas.find((x) => x.method === req.method && (params = x.coincide(ruta)) !== null);
    if (!r) return esApi ? enviar(res, { status: 404, tipo: 'text/plain; charset=utf-8', cuerpo: '' }) : enviar(res, { status: 404, cuerpo: views.paginaSimple(texto(idioma, 'servidor.noExisteTitulo'), texto(idioma, 'servidor.noExiste'), { quien, sesion: ses, pestanas: pestanasPara(quien.rol, idioma), idioma, url: u }) });
    if (!r.needs.includes(quien.rol)) return esApi ? rechazoApi(403, 'sin_rol', texto(idioma, 'servidor.apiNoMantiene', { cuenta: quien.email })) : enviar(res, { status: 403, cuerpo: views.paginaSimple(texto(idioma, 'servidor.sinPermisoTitulo'), texto(idioma, 'servidor.sinPermiso'), { quien, sesion: ses, pestanas: pestanasPara(quien.rol, idioma), idioma, url: u }) });

    // la regla de quién es quién (people.js) en cada pedido, con la configuración vigente y lo informado por las
    // máquinas, que viaja aparte del modelo: ningún correo informado llega a una vista
    const personas = typeof fuentes.personas === 'function' ? fuentes.personas() : null;
    const modelo = access.filtrar(fuentes.modelo(), quien, access.crearReglas({ config, modelo: fuentes.modelo(), personas }));
    const ctx = {
      req, sesion: ses, params: params || {}, url: u,
      modelo, quien, idioma, pestanas: pestanasPara(quien.rol, idioma), activa: r.pestana ? r.pestana.id : null, marca: marcaDe(config),
      bandaRefresco: st.bandaRefresco || null,
      bandaConfig: quien.rol === 'maintainer' ? (st.bandaConfig || null) : null,
      avisoVariable: quien.rol === 'maintainer' && quien.variableSobrante,
      avisoSesiones: !demo && quien.rol === 'maintainer' && !cerradas.verificable(),
      enlaceOperaciones: quien.rol === 'maintainer' ? enlaceOperaciones : null,
      // el remoto de operaciones ya resuelto: sólo lo trae el modo demo (sus direcciones de ejemplo no las reconoce remoteOf)
      remotoOperaciones: quien.rol === 'maintainer' && demo ? demo.remotoOperaciones || null : null,
      version, ahora: ahora(),
      // sólo quienes mantienen saben de la última publicada (los que pueden actuar); el modo sale de site.update
      ultima: quien.rol === 'maintainer' ? ultima.estado() : null,
      modoActualizacion: config && config.site && config.site.update === 'auto' ? 'auto' : 'notice',
    };
    if (quien.rol === 'maintainer') ultima.mirar();
    // una ruta puede ser asíncrona y leer el pedido (las escrituras de la pestaña Configuración)
    const salida = await r.handler(ctx);
    return enviar(res, salida);
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(manejar(req, res)).catch((e) => {
      registrar(`error inesperado en ${req.method} ${String(req.url).split('?')[0]}: ${e && e.stack ? e.stack : e}`);
      if (!res.headersSent) { const i = LANG.elegir({ cookie: session.leerCookies(req.headers.cookie)[LANG.COOKIE] || null, navegador: req.headers['accept-language'] }); enviar(res, { status: 500, cuerpo: views.paginaSimple(texto(i, 'servidor.errorTitulo'), texto(i, 'servidor.error'), { idioma: i }) }); }
      else res.end();
    });
  });

  async function prepararProveedor() {
    try { await proveedor.preparar(); registrar(`el proveedor de inicio de sesión (${proveedor.nombre}) está listo`); return true; } catch (e) {
      registrar(`el proveedor de inicio de sesión no respondió: ${(e && e.motivo) || (e && e.message) || e} — se reintenta en 30 s`);
      return false;
    }
  }

  return {
    server, cfg, rutas,
    /** Baja el descubrimiento (si el emisor no responde, se reintenta solo cada 30 s; el sitio arranca igual). */
    async iniciar() {
      if (!(await prepararProveedor())) {
        const lazo = async () => { if (!(await prepararProveedor())) reintento = setTimeout(lazo, 30000); else reintento = null; };
        reintento = setTimeout(lazo, 30000);
        if (reintento.unref) reintento.unref();
      }
    },
    cerrar: () => new Promise((resolve) => {
      if (reintento) clearTimeout(reintento);
      try { fuentes.detener(); } catch { /* nada */ }
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    }),
  };
}

/**
 * El sitio en modo demo, sin escuchar todavía: las fuentes y las pestañas sobre los datos de ejemplo (demo.js), la sesión de
 * ejemplo y el tope de pedidos. `dir` es la carpeta temporal propia del modo: todo lo que se escribe queda adentro.
 */
function crearSitioDemo({ env = process.env, dir, log = (l) => process.stdout.write(`${l}\n`), ahora = Date.now, version = VERSION } = {}) {
  const modo = require('./demo.js').crearModoDemo({ env, dir, log, ahora, version, skillsDir: env.TYCON_SKILLS_DIR || null });
  // sin versión propia, el demo corre con la de ejemplo de sus datos: la misma en la página y en las máquinas
  return crearSitio({ env, fuentes: modo.fuentes, log, ahora, rutasExtra: modo.rutasExtra, version: modo.version, vigia: modo.vigia, demo: modo });
}

async function main() {
  const env = process.env;
  const log = (l) => process.stdout.write(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${l}\n`);
  for (const l of lineasDeArranque(env)) log(l);
  // SITE_DEMO puesta con cualquier valor pide el modo demo: sólo con «1» arranca, y nunca cae callado al sitio real
  if (env.SITE_DEMO !== undefined) return arrancarDemo(env, log);
  const v = validarConfiguracion(env);
  if (!v.ok) {
    for (const p of v.problemas) process.stderr.write(`🔴 ${p.variable}: ${p.motivo}\n`);
    process.stderr.write('el sitio no arranca\n');
    process.exit(1);
  }
  const { crearFuentes } = require('./sources.js');
  let dataDir = v.cfg.dataDir;
  if (!dataDir) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-data-'));
    log('SITE_DATA_DIR ausente: se usa una carpeta temporal; al dormir o reiniciar se pierde el último bueno de la configuración');
  }
  let sitio;
  try {
    const fuentes = crearFuentes({ cfg: v.cfg, dataDir, log });
    // invitar desde Personas (con un proveedor que sabe invitar y el disco del sitio): lo que falta enviar se recalcula
    // al terminar cada ciclo de fuentes
    const invitaciones = require('./invitations.js').crearInvitaciones({ cfg: v.cfg, env, dataDir: v.cfg.dataDir, llave: v.cfg.sessionKey, log });
    fuentes.alRefrescar(() => { invitaciones.enviarPendientes(fuentes.config()); });
    const rutasExtra = [
      ...require('./tabs/config.js').crearRutas({ cfg: v.cfg, fuentes, versionImagen: VERSION, log, invitaciones }),
      // la pestaña Cómo trabaja: el recorrido de una historia, con los revisores propios editables
      ...require('./tabs/how-it-works.js').crearRutas({ cfg: v.cfg, fuentes, versionImagen: VERSION, log }),
      // la pestaña Corridas: arma su vista en un hilo aparte con el espejo del buzón
      ...require('./tabs/runs.js').crearRutas({ cfg: v.cfg, fuentes, version: VERSION, skillsDir: env.TYCON_SKILLS_DIR || null, log }),
      // la pestaña Mantenimiento: lo que encontró la noche, que quien mantiene decide con un clic
      ...require('./tabs/findings.js').crearRutas({ cfg: v.cfg, fuentes, log }),
      // la pestaña Ayuda: la guía del sitio que viaja en la imagen, con lo que le toca a cada rol
      ...require('./help.js').crearRutas({ log }),
    ];
    sitio = crearSitio({ env, fuentes, log, rutasExtra, alEntrar: (correo) => invitaciones.entro(correo) });
    await sitio.iniciar();
    fuentes.arrancar();
  } catch (e) {
    process.stderr.write(`🔴 ${e.message}\nel sitio no arranca\n`);
    process.exit(1);
  }
  sitio.server.listen(v.cfg.port, () => log(`escuchando en el puerto ${v.cfg.port}`));
  const salir = () => sitio.cerrar().then(() => process.exit(0));
  process.on('SIGTERM', salir);
  process.on('SIGINT', salir);
}

/** Arranca el sitio demo: la lista cerrada de variables, la carpeta temporal propia (con el freno ya puesto) y el servidor. */
async function arrancarDemo(env, log) {
  const D = require('./demo.js');
  const v = D.validarDemo(env);
  if (!v.ok) {
    for (const p of v.problemas) process.stderr.write(`🔴 ${p.variable}: ${p.motivo}\n`);
    process.stderr.write('el sitio no arranca\n');
    process.exit(1);
  }
  // el freno se puso al cargar este archivo (FRENO_DEMO); sus intentos van al registro
  const freno = FRENO_DEMO || require('./demo-guard.js').frenoActual();
  if (!freno) { process.stderr.write('🔴 el modo demo no arranca sin su freno de red, de procesos y de escrituras\nel sitio no arranca\n'); process.exit(1); }
  // una salida que el freno no pudo tapar es un hueco en un sitio público: no se arranca con él
  if (freno.faltantes.length) {
    for (const f of freno.faltantes) process.stderr.write(`🔴 freno: ${f.detalle}\n`);
    process.stderr.write('el sitio no arranca\n');
    process.exit(1);
  }
  require('./demo-guard.js').alIntentar((i) => log(`freno: ${i.tipo}: ${i.detalle}`));
  log('sitio demo: datos de ejemplo de «acme», sólo lectura, sin cuentas ni conexiones afuera');
  let sitio;
  try {
    sitio = crearSitioDemo({ env, dir: freno.dir, log });
    await sitio.iniciar();
  } catch (e) {
    process.stderr.write(`🔴 ${e.message}\nel sitio no arranca\n`);
    process.exit(1);
  }
  sitio.server.listen(v.cfg.port, () => log(`escuchando en el puerto ${v.cfg.port}`));
  const salir = () => sitio.cerrar().then(() => process.exit(0));
  process.on('SIGTERM', salir);
  process.on('SIGINT', salir);
}

module.exports = { RUTAS_SIN_SESION, crearSitio, crearSitioDemo, validarConfiguracion, validarRutas, lineasDeArranque, RUTAS, CSP, VARIABLES, VERSION };

if (require.main === module) main();
