'use strict';
/*
 * demo.js — EL MODO DEMO DEL SITIO DE LA ORGANIZACIÓN.
 *
 * Con `SITE_DEMO=1` el mismo servidor (server.js) arranca sin proveedor de inicio de sesión ni credenciales y muestra todas
 * sus funciones con los datos de ejemplo de «acme» (demo/data.js): abierto con un link, sin cuenta, de sólo lectura de
 * punta a punta. Este módulo trae lo propio de ese modo:
 *
 *   · `validarDemo(env)`      la lista cerrada de variables: acepta sólo SITE_DEMO, PORT y SITE_PUBLIC_URL. Cualquier otra
 *                             variable del sitio o de identidad de la plataforma hace que no arranque, y dice cuál.
 *   · `ponerFreno(…)`         el freno central (demo-guard.js, que server.js carga antes que nada): nada de conexiones
 *                             afuera, de procesos ni de escrituras fuera de la carpeta temporal propia. Cada intento se
 *                             anota y falla. También dentro de cada hilo aparte (`worker_threads` no hereda el freno).
 *   · `crearFuentesDemo(…)`   las fuentes del sitio sobre los datos de ejemplo: el mismo armado del modelo que las reales
 *                             (`construirDesdeClon`, `leerCorridas`), sin git, sin buzón y sin red.
 *   · `fetchDemo`             lo que en el sitio real se pregunta a la plataforma (pipelines, stages, tipos y campos de
 *                             pedido, la política de revisión del perfil) se contesta de adentro del proceso.
 *   · `crearModoDemo(…)`      todo junto para server.js: configuración, fuentes, vigía de la última versión, invitaciones
 *                             de ejemplo, la sesión de ejemplo y el selector «Ver como».
 *
 * Casos: scripts/tests/site-demo.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATOS = require('./demo/data.js');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── lo que el sitio demo le "pregunta" a la plataforma ──────────────────────────────────────────────────────────────────
// Las direcciones, los repos y las respuestas de la plataforma de ejemplo las trae la nube (cloud/, demo/platform.js): el
// núcleo no nombra ninguna. Nadie resuelve esas direcciones: `fetchDemo` las contesta de adentro del proceso.
const PLATAFORMA = () => require('./demo/platform.js').plataformaDeEjemplo();
/** El `fetch` del sitio demo: datos de ejemplo, sin abrir ninguna conexión. */
const fetchDemo = (...args) => PLATAFORMA().fetch(...args);

// ── las fuentes de ejemplo ──────────────────────────────────────────────────────────────────────────────────────────
/** Escribe `archivos` (`ruta → objeto o texto`) bajo `raiz`. */
function escribirArchivos(raiz, archivos) {
  const ORG = require('../lib/org-config.js');
  fs.rmSync(raiz, { recursive: true, force: true });
  for (const [rel, v] of Object.entries(archivos)) {
    const ruta = path.join(raiz, rel);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, typeof v === 'string' ? v : ORG.formatJson(v));
  }
}

/** El índice de versiones de una carpeta sin git: la versión de cada archivo como la daría git (`{ archivos: { ruta: oid } }`). */
function indiceDe(raiz) {
  const ORG = require('../lib/org-config.js');
  const archivos = {};
  const recorrer = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) recorrer(path.join(dir, e.name), r);
      else archivos[r] = ORG.versionDeTexto(fs.readFileSync(path.join(dir, e.name), 'utf8'), 40);
    }
  };
  recorrer(raiz, '');
  return { archivos };
}

/**
 * Una conversación corta de cada ejecución de ejemplo, al lado de su volcado (como la deja la subida de ejecuciones): dos
 * ediciones con su antes y su después. De ahí salen los textos del detalle de una ejecución.
 */
function escribirHilos(dirBuzon) {
  const zlib = require('zlib');
  const ediciones = [
    [20, 'src/lista.js', 'const limite = 10;', 'const limite = 25;\n// la lista pagina de a 25'],
    [45, 'src/lista.test.js', "expect(pagina(1)).toHaveLength(10);", "expect(pagina(1)).toHaveLength(25);"],
  ];
  for (const maquina of fs.readdirSync(dirBuzon)) {
    const dm = path.join(dirBuzon, maquina);
    if (!fs.statSync(dm).isDirectory()) continue;
    for (const f of fs.readdirSync(dm).filter((x) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/.test(x))) {
      const m = JSON.parse(fs.readFileSync(path.join(dm, f), 'utf8')).marker || {};
      const t0 = Date.parse(m.startedAt);
      if (!Number.isFinite(t0) || !m.repoPath) continue;
      const lineas = ediciones.map(([min, archivo, viejo, nuevo]) => JSON.stringify({ type: 'assistant', timestamp: new Date(t0 + min * 60000).toISOString(),
        message: { id: `${m.sessionId}-${min}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 40, output_tokens: 600, cache_creation_input_tokens: 3000 },
          content: [{ type: 'tool_use', id: `t-${min}`, name: 'Edit', input: { file_path: `${m.repoPath}/${archivo}`, old_string: viejo, new_string: nuevo } }] } }));
      fs.writeFileSync(path.join(dm, f.replace(/\.json$/, '.hilo.jsonl.gz')), zlib.gzipSync(`${lineas.join('\n')}\n`));
    }
  }
}

/**
 * Las fuentes del sitio sobre los datos de ejemplo, con el contrato de sources.js. `dir`: la carpeta temporal propia del
 * modo demo (todo lo que se escribe queda adentro). Los datos se arman con la fecha de hoy y se rehacen al cambiar el día:
 * una demo que lleva días encendida sigue mostrando datos al día.
 */
function crearFuentesDemo({ dir, ahora = Date.now, log = () => {} }) {
  const SRC = require('./sources.js');
  const OPS = require('../lib/operations-config.js');
  const people = require('../lib/people.js');
  const dirOps = path.join(dir, 'operaciones');
  const dirPerfil = path.join(dir, 'perfil');
  const dirBuzon = path.join(dir, 'buzon');
  let st = null;
  let cola = Promise.resolve();

  function generar() {
    const t = ahora();
    escribirArchivos(dirOps, DATOS.operaciones({ ahora: t, access: ACCESO,
      invitaciones: { [DATOS.INVITADA]: { por: DATOS.LEAD, el: new Date(t).toISOString().slice(0, 10) } } }));
    escribirArchivos(dirPerfil, DATOS.archivosDelPerfil({ extra: DATOS.PAQUETE_DE_REVISORES }));
    // el espejo del buzón: cada blob es un archivo (`<máquina>/<archivo>`), como lo deja la bajada del sitio real
    fs.rmSync(dirBuzon, { recursive: true, force: true });
    for (const [rel, texto] of Object.entries(DATOS.blobsDelBuzon(t))) {
      fs.mkdirSync(path.dirname(path.join(dirBuzon, rel)), { recursive: true });
      fs.writeFileSync(path.join(dirBuzon, rel), texto);
    }
    escribirHilos(dirBuzon);
    const leida = OPS.load(path.join(dirOps, 'operations.json'));
    if (!leida.ok) throw new Error(`los datos de ejemplo no validan: ${(leida.problems || []).map((p) => `${p.path}: ${p.message}`).join(' · ')}`);
    const dia = new Date(t).toISOString().slice(0, 10);
    const c = SRC.leerCorridas(dirBuzon);
    delete c._motivo;
    const corridas = { ...c, fecha: dia };
    const fichas = require('./tabs/cards.js').fichasDelClon({ clon: dirOps, dirBuzon, buzonLeido: corridas.estado === 'medido', ahora: t, log: (l) => log(`fichas: ${l}`) });
    const repos = SRC.leerRepos(dirOps);
    st = {
      dia, config: leida.data, fichas,
      modelo: SRC.construirDesdeClon(dirOps, { ahora: t, corridas, carpetas: null, fichas, log }),
      personas: { informados: people.leerCorreosInformados(dirBuzon), repos: repos.repos },
      clones: { operaciones: { dir: dirOps, indice: indiceDe(dirOps) }, perfil: { dir: dirPerfil, indice: indiceDe(dirPerfil), estado: 'medido', motivo: null } },
    };
  }
  // los datos de hoy: al cambiar el día se rehacen
  const vigente = () => { if (!st || st.dia !== new Date(ahora()).toISOString().slice(0, 10)) generar(); return st; };
  generar();

  return {
    arrancar() { /* los datos ya están: no hay nada que leer afuera */ },
    // una falla al rehacer los datos se anota y no deja la cola rechazada: el refresco siguiente se intenta igual
    refrescar: () => { const p = cola.then(() => { generar(); }); cola = p.catch((e) => { try { log(`sitio demo: no se pudieron rehacer los datos de ejemplo (${(e && e.message) || e})`); } catch { /* el registro no cambia lo que pasó */ } }); return p; },
    estado: () => { vigente(); return { cargado: true, navegable: true, frenado: null, bandaConfig: null, bandaRefresco: null }; },
    config: () => vigente().config,
    modelo: () => vigente().modelo,
    personas: () => vigente().personas,
    detener() { /* sin temporizador */ },
    clones: () => vigente().clones,
    exclusivo: (fn) => { const p = cola.then(() => fn()); cola = p.catch(() => {}); return p; },
    dirBuzon,
    hilos: () => true,
    /** En el sitio demo no hay buzón del que bajar nada: los textos de cada ejecución ya están en su carpeta. */
    bajarCorrida: async () => ({ codigo: 1, res: { estado: 'sin_partes', motivo: 'el sitio demo no baja nada' } }),
    buzonEstado: () => ({ completo: true, generacion: 1, siguiendo: false }),
    proximoRefrescoMs: () => 15 * 60000,
    alRefrescar() { /* el refresco no tiene fin que avisar */ },
    clonDeEscritura: undefined,
  };
}

// ── la lista cerrada de variables ───────────────────────────────────────────────────────────────────────────────────────
// El modo demo acepta sólo estas tres. Cualquier otra variable del sitio, o una de identidad de la plataforma (la que
// da a un proceso el token de una identidad administrada), hace que no arranque: un error de instalación no puede dejar
// una credencial real en una instancia pública.
const VARIABLES_DEL_MODO = Object.freeze(['SITE_DEMO', 'PORT', 'SITE_PUBLIC_URL']);

/** `{ ok, problemas: [{ variable, motivo }], cfg: { port, publicUrl } }` — sin valores en los motivos. */
function validarDemo(env) {
  const problemas = [];
  const falta = (variable, motivo) => problemas.push({ variable, motivo });
  if (env.SITE_DEMO !== '1') falta('SITE_DEMO', 'el modo demo se prende sólo con SITE_DEMO=1; con otro valor el sitio no arranca (nunca cae al sitio real)');
  for (const k of Object.keys(env).sort()) {
    if (env[k] === undefined || env[k] === '') continue;
    if (/^SITE_/.test(k) && !VARIABLES_DEL_MODO.includes(k)) falta(k, 'el sitio demo no admite ninguna credencial ni configuración de la organización: sacala');
    else if (PLATAFORMA().variablesDeIdentidad.includes(k)) falta(k, 'el sitio demo no admite una identidad de la plataforma: sacala (la instancia demo se instala sin identidad)');
  }
  const cfg = { port: 8080, publicUrl: null };
  if (env.PORT !== undefined && env.PORT !== '') {
    const n = Number(env.PORT);
    if (!Number.isInteger(n) || n < 1 || n > 65535) falta('PORT', 'tiene que ser un puerto (1 a 65535)'); else cfg.port = n;
  }
  if (env.SITE_PUBLIC_URL !== undefined && env.SITE_PUBLIC_URL !== '') {
    let u = null;
    try { u = new URL(env.SITE_PUBLIC_URL); } catch { /* abajo */ }
    const local = u && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (!u || !(u.protocol === 'https:' || local) || u.pathname !== '/' || u.search || u.username || u.password) falta('SITE_PUBLIC_URL', 'tiene que ser https:// (sólo en la propia máquina, http://localhost), sin ruta');
    else cfg.publicUrl = `${u.protocol}//${u.host}`;
  }
  if (!cfg.publicUrl) cfg.publicUrl = `http://localhost:${cfg.port}`;
  return { ok: problemas.length === 0, problemas, cfg };
}

// ── el freno central ────────────────────────────────────────────────────────────────────────────────────────────────────
// Vive en demo-guard.js, que no carga nada del sitio (se pone antes que todo): acá se reexporta.
const { ponerFreno, frenoTemprano, frenoActual, alIntentar } = require('./demo-guard.js');

// ── lo mínimo de un sitio público ───────────────────────────────────────────────────────────────────────────────────────
/** La dirección de un pedido: la ÚLTIMA de X-Forwarded-For (la agrega la entrada de la plataforma; las anteriores las inventa quien pide); sin ella, la del socket. */
function direccionDe(req) {
  const cab = req.headers && req.headers['x-forwarded-for'];
  const partes = String(Array.isArray(cab) ? cab.join(',') : (cab || '')).split(',').map((x) => x.trim()).filter(Boolean);
  return partes.length ? partes[partes.length - 1] : ((req.socket && req.socket.remoteAddress) || 'desconocida');
}

/** El tope de pedidos por dirección: `porMinuto` en una ventana de un minuto. `(req) → { ok } | { ok: false, reintentarEn }` (segundos). */
function crearTope({ ahora = Date.now, porMinuto = 60 } = {}) {
  const VENTANA = 60000;
  const MAX_DIRECCIONES = 10000;
  const cuentas = new Map();
  return (req) => {
    const t = ahora();
    const d = direccionDe(req);
    let c = cuentas.get(d);
    if (!c || t - c.desde >= VENTANA) {
      c = { desde: t, n: 0 };
      cuentas.delete(d);
      cuentas.set(d, c);
      // sin límite, direcciones nuevas llenarían la memoria: se sueltan las vencidas, y si hace falta las más viejas
      if (cuentas.size > MAX_DIRECCIONES) {
        for (const [k, v] of cuentas) if (t - v.desde >= VENTANA) cuentas.delete(k);
        while (cuentas.size > MAX_DIRECCIONES) cuentas.delete(cuentas.keys().next().value);
      }
    }
    c.n += 1;
    return c.n > porMinuto ? { ok: false, reintentarEn: Math.max(1, Math.ceil((c.desde + VENTANA - t) / 1000)) } : { ok: true };
  };
}

// ── la sesión de ejemplo y el selector «Ver como» ───────────────────────────────────────────────────────────────────────
const COOKIE_VISTA = 'sitio-demo-vista';
const VISTAS = Object.freeze(['mantenedor', 'persona']);
const comoValido = (x) => (VISTAS.includes(x) ? x : null);
const comoDe = (cookies) => comoValido(cookies && cookies[COOKIE_VISTA]) || 'mantenedor';
const cookieDeVista = (como, { https = true } = {}) => `${COOKIE_VISTA}=${como}; Path=/; Max-Age=31536000; SameSite=Lax${https ? '; Secure' : ''}`;

/** La franja fija de arriba de cada página y el título: «Datos de ejemplo». `url`: la página (a ella vuelve «Ver como»). */
function marcarPagina(html, { idioma, como, url }) {
  const TX = require('./texts.js');
  const { esc } = require('../nightly/dashboard/common.js');
  const T = (k) => TX.t(idioma, k);
  const volver = url && /^\/(?![/\\])/.test(`${url.pathname}${url.search}`) ? `${url.pathname}${url.search}` : '/';
  const opcion = (v, k) => `<option value="${v}"${como === v ? ' selected' : ''}>${esc(T(k))}</option>`;
  const franja = `<div class="franja-demo" role="note"><b>${esc(T('demo.franja'))}</b><span class="franja-texto">${esc(T('demo.franjaTexto'))}</span>`
    + `<form method="post" action="/demo/ver-como"><label>${esc(T('demo.verComo'))} <select name="como">${opcion('mantenedor', 'demo.comoMantiene')}${opcion('persona', 'demo.comoPersona')}</select></label>`
    + `<input type="hidden" name="volver" value="${esc(volver)}"><button type="submit">${esc(T('demo.cambiar'))}</button></form></div>`;
  return html
    .replace(/<form class="salir"[\s\S]*?<\/form>/, '')
    // con función de reemplazo: la franja lleva la URL de la página, y un `$&`, `$\`` o `$'` en ella no es una orden de reemplazo
    .replace('<title>', () => `<title>${esc(T('demo.franja'))} · `)
    .replace('<body>', () => `<body class="demo">${franja}`);
}

// ── lo que el sitio real mira afuera, fijo ──────────────────────────────────────────────────────────────────────────────
/** El vigía de la última versión publicada: siempre «al día» (la del propio sitio), sin preguntar a ningún registro. */
function crearVigiaFijo({ version = null, ahora = Date.now } = {}) {
  const estado = () => ({ estado: 'medido', version: version || '0.0.0', huella: `sha256:${'0'.repeat(64)}`, creada: new Date(ahora()).toISOString(), fuente: null });
  return { mirar: () => Promise.resolve(), estado };
}

/** Las invitaciones de ejemplo (el contrato de invitations.js), sin proveedor: se pueden «hacer», y no hacen nada. */
function crearInvitacionesDemo() {
  const TX = require('./texts.js');
  const norm = (c) => String(c || '').trim().toLowerCase();
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return {
    disponibilidad: () => ({ boton: true, motivo: 'demo', texto: null }),
    permiso: async () => ({ ok: true, texto: null, comando: null }),
    async revisarCorreo(correoIn, config) {
      const correo = norm(correoIn);
      if (!EMAIL.test(correo)) return { ok: false, correo, motivo: TX.t('es', 'invitaciones.noEsCorreo', { correo: String(correoIn || '').trim().slice(0, 120) }) };
      const acceso = config && isObject(config.site) && Array.isArray(config.site.access) ? config.site.access : [];
      if (acceso.some((e) => isObject(e) && Array.isArray(e.emails) && e.emails.map(norm).includes(correo))) return { ok: false, correo, motivo: TX.t('es', 'invitaciones.yaEnLista', { correo }) };
      return { ok: true, correo };
    },
    enviarPendientes: async () => ({ enviadas: 0, fallas: 0, esperan: 0 }),
    entro() { /* nadie entra con cuenta */ },
    // el estado de ejemplo: lo que ya se invitó desde el sitio figura como enviado, sin haber hablado con ningún proveedor
    estados(config) {
      const inv = config && isObject(config.site) && isObject(config.site.invitations) ? config.site.invitations : {};
      return Object.fromEntries(Object.keys(inv).filter((k) => !k.startsWith('__')).map((c) => [norm(c), { estado: 'enviada', texto: TX.t('es', 'invitaciones.enviada'), portal: null }]));
    },
    portalDe: () => null,
    codigoPorCorreo: null,
    tope: 10,
  };
}

// ── todo junto, para server.js ──────────────────────────────────────────────────────────────────────────────────────────
/** La gente de ejemplo con su lugar en la lista: quien mantiene, una persona con máquina confirmada y una invitada. */
const ACCESO = Object.freeze([{ role: 'maintainer', emails: [DATOS.LEAD] }, { role: 'dev', emails: [DATOS.ANA] }, { role: 'dev', emails: [DATOS.INVITADA] }]);

/**
 * El sitio demo armado: la configuración, las fuentes, las rutas de las pestañas y lo de la sesión. `dir`: la carpeta
 * temporal propia. Tira si el entorno no es el de un sitio demo.
 */
function crearModoDemo({ env = { SITE_DEMO: '1' }, dir, log = () => {}, ahora = Date.now, version = null, skillsDir = null }) {
  const v = validarDemo(env);
  if (!v.ok) throw Object.assign(new Error(v.problemas.map((p) => `${p.variable}: ${p.motivo}`).join('\n')), { problemas: v.problemas });
  const TX = require('./texts.js');
  const fuentes = crearFuentesDemo({ dir, ahora, log });
  const cfg = {
    publicUrl: v.cfg.publicUrl, port: v.cfg.port, sessionKey: crypto.randomBytes(32), provider: 'demo', clientId: null, clientSecret: null,
    allowedDomains: [], emailClaim: 'email', redirectUri: null, dataDir: null, demo: true, firstMaintainer: undefined,
    inicioDeSesion: { proveedor: 'demo', modo: null, texto: TX.t('es', 'config.demoInicioDeSesion') },
    operationsSource: 'repo', operationsCopy: null, operationsCredencial: null, mailboxCredencial: null,
    operationsRepo: PLATAFORMA().remotos.operaciones.web, profileRepo: PLATAFORMA().remotos.perfil.web, profileCredencial: null,
    // identidades de ejemplo: la plataforma de ejemplo (fetchDemo) las acepta, ninguna sirve afuera
    escritura: { operaciones: 'ejemplo', perfil: 'ejemplo' }, pipelinesToken: 'ejemplo',
  };
  const invitaciones = crearInvitacionesDemo();
  const comun = { cfg, fuentes, ahora, log, fetch: fetchDemo, urlBase: PLATAFORMA().urlBase, remotos: PLATAFORMA().remotos };
  const rutasExtra = [
    ...require('./tabs/config.js').crearRutas({ ...comun, versionImagen: version, invitaciones, demo: true }),
    ...require('./tabs/how-it-works.js').crearRutas({ ...comun, versionImagen: version, demo: true }),
    // con la carpeta temporal propia como disco del sitio: las ejecuciones leen sus conversaciones de ejemplo
    ...require('./tabs/runs.js').crearRutas({ cfg: { ...cfg, dataDir: dir }, fuentes, version, skillsDir, log }),
    ...require('./help.js').crearRutas({ log }),
  ];
  // el token de la sesión de ejemplo: el mismo para todas las visitas (no hay nada que proteger de otra persona: nada se escribe)
  const tok = crypto.randomBytes(32).toString('base64url');
  const sesion = (cookies) => ({ email: comoDe(cookies) === 'persona' ? DATOS.ANA : DATOS.LEAD, sub: 'demo', prov: 'demo', iss: 'demo', exp: Number.MAX_SAFE_INTEGER, tok });
  const proveedor = { nombre: 'demo', emisor: 'demo', listo: () => true, preparar: async () => {}, urlDeInicio: () => '/', vias: null };
  return { cfg, fuentes, rutasExtra, vigia: crearVigiaFijo({ version, ahora }), invitaciones, proveedor, sesion, comoDe, comoValido, cookieDeVista, marcar: marcarPagina, tope: crearTope({ ahora }) };
}

module.exports = {
  get URL_BASE() { return PLATAFORMA().urlBase; }, get REMOTOS() { return PLATAFORMA().remotos; }, get PIPELINES() { return PLATAFORMA().pipelines; }, get STAGES() { return PLATAFORMA().stages; },
  fetchDemo, crearFuentesDemo, VARIABLES_DEL_MODO, validarDemo,
  ponerFreno, frenoTemprano, frenoActual, alIntentar, crearTope, direccionDe, comoDe, comoValido, cookieDeVista, marcarPagina, COOKIE_VISTA,
  crearVigiaFijo, crearInvitacionesDemo, crearModoDemo, ACCESO,
};
