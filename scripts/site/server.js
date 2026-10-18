#!/usr/bin/env node
'use strict';
/*
 * server.js — EL SITIO DE LA ORGANIZACIÓN (story 2.23).
 *
 * Un servidor Node sin dependencias, en Docker o con Node solo, para toda la organización: cada persona entra con la
 * cuenta de su organización y ve lo suyo; quienes mantienen el arnés ven todo. El filtro lo hace el servidor (S6): la
 * pantalla nunca recibe lo que no puede ver.
 *
 * LA TABLA DE RUTAS es el único camino de los datos (AC 11). Cada ruta declara quién puede verla (`needs`:
 * 'maintainer', 'person') y recibe el modelo YA FILTRADO por access.js para quien pide. Una ruta sin esa declaración
 * hace que el sitio NO ARRANQUE. Una ruta puede tener parámetros (`/api/corridas/:id`, story 2.27): llegan en
 * `ctx.params`, y la ruta sigue declarando quién la ve. Las únicas rutas sin sesión son la vida (`/livez`), la salud (`/healthz`), la carga
 * (`/readyz`), el inicio de sesión (`/auth/*`) y los dos archivos estáticos.
 *
 *   /livez    200 {"ok":true} mientras el proceso escucha; nada más (la sonda de vida y el HEALTHCHECK de la imagen).
 *   /healthz  200 {"ok":true}, también mientras carga; 503 {"ok":false,"motivo":…} sólo con el sitio FRENADO por la
 *             configuración de la organización (AC 15). El motivo nunca nombra direcciones, hosts, rutas ni cuentas; dice
 *             desde cuándo no valida (el primer refresco fallido), y la página del freno, desde cuándo está frenado.
 *   /readyz   503 con Retry-After hasta la primera lectura de las fuentes; después 200 (también frenado).
 *
 * LA IDENTIDAD sale sólo del inicio de sesión del propio sitio (decisión 9): ninguna cabecera de un proxy o de la
 * plataforma cambia quién pide. El rol se recalcula en CADA pedido con la configuración vigente (decisión 12).
 *
 * ARRANQUE (AC 1): lee las variables de abajo; si falta una obligatoria o tiene mala forma, no arranca, sale 1 y dice
 * cuál y por qué. El registro dice qué variable está presente, nunca su valor.
 *   obligatorias  SITE_PUBLIC_URL (https://, o http://127.0.0.1 en pruebas) · SITE_SESSION_KEY (≥ 32 bytes) ·
 *                 SITE_AUTH_PROVIDER (`oidc` o el nombre de un archivo de auth-providers/) · SITE_OIDC_CLIENT_ID ·
 *                 SITE_OIDC_CLIENT_SECRET · y lo que pida cada proveedor (la cabecera de su archivo: el emisor, los
 *                 dominios, la organización) · SITE_OPERATIONS_REPO (https) y su credencial: SITE_OPERATIONS_TOKEN o
 *                 SITE_OPERATIONS_IDENTITY=managed (la identidad administrada de la plataforma: lo de cada nube vive en cloud/)
 *   opcionales    SITE_OIDC_EMAIL_CLAIM · PORT (8080) · SITE_MAILBOX_SAS o SITE_MAILBOX_IDENTITY=managed ·
 *                 SITE_FIRST_MAINTAINER (un correo) · SITE_AUTH_ALLOWED_DOMAINS (donde el proveedor no la exige) ·
 *                 SITE_DATA_DIR (un disco persistente; sin ella, una carpeta temporal, y se dice)
 *   de la pestaña Configuración (story 2.29, decisión 11; todas apagadas por defecto: sin una, su sección queda en sólo
 *   lectura o «no configurado», y el sitio arranca igual)
 *                 SITE_OPERATIONS_WRITE_TOKEN (proponer cambios al repo de operaciones: rama y pedido, nunca main) ·
 *                 SITE_PROFILE_REPO (https) y SITE_PROFILE_TOKEN (leer el perfil del equipo) · SITE_PROFILE_WRITE_TOKEN
 *                 (proponer al perfil) · SITE_PIPELINES_TOKEN (sólo lectura de definiciones y corridas: la propuesta de stages)
 *
 * Uso: node scripts/site/server.js        (la imagen: scripts/site/Dockerfile)
 */
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
const { limpiarLinea, dentroDe } = require('./sources.js');
const { BRAND_LOGO } = require('../lib/operations-config.js');

// Los proveedores: el `oidc` genérico y uno por archivo de auth-providers/ (el nombre del archivo es el valor de
// SITE_AUTH_PROVIDER). El núcleo no nombra a ninguno: lo propio de cada uno vive en su archivo.
const PROVEEDORES = (() => {
  const dir = path.join(__dirname, 'auth-providers');
  const out = { oidc: { problemasDeConfig: oidc.problemasDeConfig, crear: oidc.crearGenerico } };
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z][a-z0-9-]*\.js$/.test(x)).sort()) out[f.slice(0, -3)] = require(path.join(dir, f));
  return out;
})();
const VARIABLES = ['SITE_PUBLIC_URL', 'SITE_SESSION_KEY', 'SITE_AUTH_PROVIDER', 'SITE_OIDC_CLIENT_ID', 'SITE_OIDC_CLIENT_SECRET', 'SITE_OIDC_ISSUER',
  'SITE_OIDC_EMAIL_CLAIM', 'SITE_AUTH_ALLOWED_DOMAINS', 'SITE_AUTH_GITHUB_ORG', 'SITE_OPERATIONS_REPO', 'SITE_OPERATIONS_TOKEN', 'SITE_OPERATIONS_IDENTITY',
  'SITE_MAILBOX_SAS', 'SITE_MAILBOX_IDENTITY', 'SITE_FIRST_MAINTAINER', 'SITE_DATA_DIR', 'PORT',
  'SITE_OPERATIONS_WRITE_TOKEN', 'SITE_PROFILE_REPO', 'SITE_PROFILE_TOKEN', 'SITE_PROFILE_WRITE_TOKEN', 'SITE_PIPELINES_TOKEN',
  'SITE_OPERATIONS_SOURCE', 'SITE_OPERATIONS_COPY', 'SITE_OPERATIONS_COPY_SAS'];
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
  else if (!repo || !(repo.protocol === 'https:' || esLoopback(repo)) || repo.username || repo.password) falta('SITE_OPERATIONS_REPO', 'tiene que ser una dirección https://, sin usuario ni credencial adentro');
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

  // la pestaña Configuración (story 2.29, decisión 11): todas opcionales
  if (env.SITE_PROFILE_REPO) {
    let perfil = null;
    try { perfil = new URL(env.SITE_PROFILE_REPO); } catch { /* abajo */ }
    if (!perfil || !(perfil.protocol === 'https:' || esLoopback(perfil)) || perfil.username || perfil.password) falta('SITE_PROFILE_REPO', 'tiene que ser una dirección https://, sin usuario ni credencial adentro');
    else if (!env.SITE_PROFILE_TOKEN) falta('SITE_PROFILE_TOKEN', 'falta: la credencial de lectura del perfil del equipo (SITE_PROFILE_REPO está puesta)');
    cfg.profileRepo = env.SITE_PROFILE_REPO;
    cfg.profileCredencial = env.SITE_PROFILE_TOKEN ? { token: env.SITE_PROFILE_TOKEN } : null;
  } else cfg.profileRepo = null;
  cfg.escritura = { operaciones: env.SITE_OPERATIONS_WRITE_TOKEN || null, perfil: env.SITE_PROFILE_WRITE_TOKEN || null };
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
  return VARIABLES.map((v) => `${v}: ${env[v] !== undefined && env[v] !== '' ? 'presente' : 'ausente'}`);
}

// ── La tabla de rutas ─────────────────────────────────────────────────────────────────────────────────────────────
const html = (cuerpo, status = 200) => ({ status, tipo: 'text/html; charset=utf-8', cuerpo });
const RUTAS = [
  { method: 'GET', path: '/', needs: ['maintainer', 'person'], pestana: { id: 'inicio', titulo: 'Inicio', orden: 10 }, handler: (ctx) => html(views.paginaInicio(ctx)) },
  { method: 'GET', path: '/proyectos', needs: ['maintainer', 'person'], pestana: { id: 'proyectos', titulo: 'Proyectos', orden: 30 }, handler: (ctx) => html(views.paginaProyectos(ctx)) },
  { method: 'GET', path: '/arnes', needs: ['maintainer'], pestana: { id: 'arnes', titulo: 'Arnés', orden: 40 }, handler: (ctx) => html(views.paginaArnes(ctx)) },
  { method: 'GET', path: '/arnes/tablero', needs: ['maintainer'], handler: (ctx) => html(views.tableroServido(ctx)) },
  { method: 'GET', path: '/api/inicio', needs: ['maintainer', 'person'], handler: (ctx) => ({ status: 200, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(views.inicioJson(ctx)) }) },
];

/**
 * Una ruta con parámetros (story 2.27): un tramo `:nombre` vale un tramo cualquiera, sin `/`. Devuelve la función que
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

function leerEstatico() {
  const { CSS_BASE, CSS_CHIPS } = require('../nightly/dashboard/common.js');
  const dir = path.join(__dirname, 'static');
  return {
    '/static/site.css': { tipo: 'text/css; charset=utf-8', cuerpo: `${CSS_BASE}\n${CSS_CHIPS}\n${fs.readFileSync(path.join(dir, 'site.css'), 'utf8')}` },
    '/static/site.js': { tipo: 'text/javascript; charset=utf-8', cuerpo: fs.readFileSync(path.join(dir, 'site.js'), 'utf8') },
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
 * detener); `ahora` (ms) y `log` se inyectan en las pruebas; `rutasExtra` es como las stories 2.27 y 2.29 suman las suyas.
 */
function crearSitio({ env = process.env, fuentes, ahora = Date.now, log = (l) => process.stdout.write(`${l}\n`), rutasExtra = [] } = {}) {
  const v = validarConfiguracion(env);
  if (!v.ok) throw Object.assign(new Error(v.problemas.map((p) => `${p.variable}: ${p.motivo}`).join('\n')), { problemas: v.problemas });
  const cfg = v.cfg;
  const rutas = validarRutas([...RUTAS, ...rutasExtra]).map((r) => ({ ...r, coincide: patronDe(r.path) }));
  if (!fuentes) throw new Error('crearSitio necesita las fuentes (scripts/site/sources.js)');
  const proveedor = PROVEEDORES[cfg.provider].crear(cfg, { ahora });
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
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  function enviar(res, { status, tipo = 'text/html; charset=utf-8', cuerpo = '', extra = {} }) {
    cabeceras(res, tipo);
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

  function pestanasPara(rol) {
    return rutas.filter((r) => r.pestana && r.needs.includes(rol)).map((r) => ({ ...r.pestana, path: r.path })).sort((a, b) => a.orden - b.orden);
  }

  function irAlEmisor(res) {
    if (!proveedor.listo()) return enviar(res, { status: 503, cuerpo: views.paginaSimple('El inicio de sesión todavía no está listo', 'El sitio no pudo hablar con el proveedor de la organización. Probá de nuevo en unos segundos.'), extra: { 'Retry-After': '10' } });
    const t = ahora();
    const nuevo = session.nuevoIntento(cfg.sessionKey, t);
    return enviar(res, { status: 302, cuerpo: '', extra: { Location: proveedor.urlDeInicio({ state: nuevo.intento.state, nonce: nuevo.intento.nonce, challenge: nuevo.challenge }), 'Set-Cookie': nuevo.cookie } });
  }

  async function vuelta(req, res, u, cookies) {
    const borrarIntento = session.borrar(session.INTENTO);
    const rechazo = (status, pantalla, motivo) => {
      registrar(`inicio de sesión rechazado: ${motivo}`);
      return enviar(res, { status, cuerpo: views.paginaSimple('No se pudo entrar', pantalla), extra: { 'Set-Cookie': borrarIntento } });
    };
    const t = ahora();
    for (const [s, exp] of consumidos) if (exp <= t) consumidos.delete(s);
    const li = session.leerIntento(cookies, cfg.sessionKey, t);
    if (!li.intento) return rechazo(400, 'El intento de inicio de sesión no es válido o venció. Volvé a entrar.', li.motivo);
    const it = li.intento;
    const state = u.searchParams.get('state');
    if (!state || state !== it.state) return rechazo(400, 'El intento de inicio de sesión no es válido o venció. Volvé a entrar.', 'el state no es el del intento');
    if (consumidos.has(state)) return rechazo(400, 'El intento de inicio de sesión no es válido o venció. Volvé a entrar.', 'el state ya se usó');
    consumidos.set(state, it.exp);
    const code = u.searchParams.get('code');
    // el `error` de la vuelta lo controla cualquiera: al registro va sólo con la forma de un código de OAuth
    const errorDelEmisor = String(u.searchParams.get('error') || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
    if (!code) return rechazo(400, 'El proveedor no devolvió un código. Volvé a entrar.', `sin código${errorDelEmisor ? ` (${errorDelEmisor})` : ''}`);
    let ident;
    try {
      ident = await proveedor.completar({ code, verifier: it.verifier, nonce: it.nonce });
    } catch (e) {
      if (e instanceof oidc.ErrorDeIngreso) return rechazo(403, `No se pudo entrar: ${e.pantalla}.`, e.motivo);
      return rechazo(400, 'No se pudo completar el inicio de sesión. Volvé a entrar.', (e && e.motivo) || (e && e.message) || String(e));
    }
    const ses = session.nuevaSesion({ ...ident, prov: proveedor.nombre, iss: proveedor.emisor }, cfg.sessionKey, ahora());
    registrar(`inicio de sesión: entró una cuenta (${proveedor.nombre})`);
    return enviar(res, { status: 302, cuerpo: '', extra: { Location: '/', 'Set-Cookie': [ses, borrarIntento] } });
  }

  async function manejar(req, res) {
    let u;
    try { u = new URL(req.url, 'http://sitio.invalid'); } catch { return enviar(res, { status: 400, cuerpo: '' }); }
    const ruta = u.pathname;
    const st = fuentes.estado();

    if (ruta === '/livez') return json(res, 200, { ok: true });
    if (ruta === '/healthz') return st.frenado ? json(res, 503, { ok: false, motivo: `la configuración de la organización no valida desde ${views.hora(Number.isFinite(st.frenado.fallaDesde) ? st.frenado.fallaDesde : st.frenado.desde)}` }) : json(res, 200, { ok: true });
    if (ruta === '/readyz') return st.cargado ? json(res, 200, { ok: true }) : json(res, 503, { ok: false, motivo: 'cargando' }, { 'Retry-After': '5' });
    if (estatico[ruta] && req.method === 'GET') return enviar(res, { status: 200, ...estatico[ruta] });

    const cookies = session.leerCookies(req.headers.cookie);
    if (ruta === '/auth/login') return req.method === 'GET' ? irAlEmisor(res) : enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'GET' } });
    if (ruta === '/auth/callback') return req.method === 'GET' ? vuelta(req, res, u, cookies) : enviar(res, { status: 405, cuerpo: '', extra: { Allow: 'GET' } });
    if (ruta === '/auth/logout') {
      if (req.method !== 'POST') return enviar(res, { status: 405, cuerpo: views.paginaSimple('Salir', 'Para salir, usá el botón «Salir».'), extra: { Allow: 'POST' } });
      return enviar(res, { status: 303, cuerpo: '', extra: { Location: '/', 'Set-Cookie': session.borrar(session.SESION) } });
    }

    const ses = session.leerSesion(cookies, cfg.sessionKey, ahora(), { prov: proveedor.nombre, iss: proveedor.emisor });
    const esApi = ruta.startsWith('/api/');
    if (!ses) return esApi ? enviar(res, { status: 401, tipo: 'text/plain; charset=utf-8', cuerpo: '' }) : irAlEmisor(res);
    if (ruta === '/marca/logo' && req.method === 'GET') return enviar(res, logo());

    if (st.frenado) return esApi ? enviar(res, { status: 503, tipo: 'text/plain; charset=utf-8', cuerpo: '' }) : enviar(res, { status: 503, cuerpo: views.paginaFrenado({ desde: st.frenado.desde }), extra: { 'Retry-After': '60' } });
    // la espera es POR FUENTE: con el repo de operaciones leído (`navegable`) el sitio se navega aunque el buzón siga
    // bajando; cada pestaña dice lo suyo (Corridas, «cargando las corridas»). /readyz, arriba, sigue esperando todo
    if (!st.cargado && !st.navegable) return esApi ? enviar(res, { status: 503, tipo: 'text/plain; charset=utf-8', cuerpo: '', extra: { 'Retry-After': '5' } }) : enviar(res, { status: 503, cuerpo: views.paginaCargando(), extra: { 'Retry-After': '5' } });

    const config = fuentes.config();
    const quien = access.quienPide(ses, { config, firstMaintainer: cfg.firstMaintainer });
    if (quien.rol === 'none') {
      if (esApi) return enviar(res, { status: 403, tipo: 'text/plain; charset=utf-8', cuerpo: '' });
      return enviar(res, { status: 200, cuerpo: quien.sinMantenedores ? views.paginaSinMantenedores({ quien }) : views.paginaSinRol({ quien }) });
    }
    let params = null;
    const r = rutas.find((x) => x.method === req.method && (params = x.coincide(ruta)) !== null);
    if (!r) return esApi ? enviar(res, { status: 404, tipo: 'text/plain; charset=utf-8', cuerpo: '' }) : enviar(res, { status: 404, cuerpo: views.paginaSimple('No existe', 'Esa página no existe.', { quien, pestanas: pestanasPara(quien.rol) }) });
    if (!r.needs.includes(quien.rol)) return esApi ? enviar(res, { status: 403, tipo: 'text/plain; charset=utf-8', cuerpo: '' }) : enviar(res, { status: 403, cuerpo: views.paginaSimple('Sin permiso', 'Esta página es para quienes mantienen el arnés.', { quien, pestanas: pestanasPara(quien.rol) }) });

    // la regla de quién es quién (people.js) en cada pedido, con la configuración vigente y lo informado por las
    // máquinas, que viaja aparte del modelo: ningún correo informado llega a una vista
    const personas = typeof fuentes.personas === 'function' ? fuentes.personas() : null;
    const modelo = access.filtrar(fuentes.modelo(), quien, access.crearReglas({ config, modelo: fuentes.modelo(), personas }));
    const ctx = {
      req, sesion: ses, params: params || {}, url: u,
      modelo, quien, pestanas: pestanasPara(quien.rol), activa: r.pestana ? r.pestana.id : null, marca: marcaDe(config),
      bandaRefresco: st.bandaRefresco || null,
      bandaConfig: quien.rol === 'maintainer' ? (st.bandaConfig || null) : null,
      avisoVariable: quien.rol === 'maintainer' && quien.variableSobrante,
      enlaceOperaciones: quien.rol === 'maintainer' ? enlaceOperaciones : null,
      version: VERSION, ahora: ahora(),
    };
    // una ruta puede ser asíncrona y leer el pedido (las escrituras de la pestaña Configuración, story 2.29)
    const salida = await r.handler(ctx);
    return enviar(res, salida);
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(manejar(req, res)).catch((e) => {
      registrar(`error inesperado en ${req.method} ${String(req.url).split('?')[0]}: ${e && e.stack ? e.stack : e}`);
      if (!res.headersSent) enviar(res, { status: 500, cuerpo: views.paginaSimple('Error', 'Algo falló en el sitio. Quedó en el registro.') });
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

async function main() {
  const env = process.env;
  const log = (l) => process.stdout.write(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${l}\n`);
  for (const l of lineasDeArranque(env)) log(l);
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
    const rutasExtra = [
      ...require('./tabs/config.js').crearRutas({ cfg: v.cfg, fuentes, versionImagen: VERSION, log }),
      // la pestaña Corridas (story 2.27): arma su vista en un hilo aparte con el espejo del buzón
      ...require('./tabs/runs.js').crearRutas({ cfg: v.cfg, fuentes, version: VERSION, skillsDir: env.TYCON_SKILLS_DIR || null, log }),
    ];
    sitio = crearSitio({ env, fuentes, log, rutasExtra });
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

module.exports = { crearSitio, validarConfiguracion, validarRutas, lineasDeArranque, RUTAS, CSP, VARIABLES, VERSION };

if (require.main === module) main();
