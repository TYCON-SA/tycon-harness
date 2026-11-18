'use strict';
/*
 * tabs/learnings.js — LA PESTAÑA «APRENDIZAJES»: LO QUE LA NOCHE PROPONE QUE EL EQUIPO APRENDA, Y DECIDIRLO.
 *
 * Qué resuelve: la noche de la organización (scripts/instincts/instinct-nightly.js) cuenta lo que se repite en las
 * máquinas del equipo y deja una propuesta por patrón en `inbox/instincts/propuestas/<huella>.json` del repo de
 * operaciones. Acá quien mantiene las decide sin abrir el repo, como en Mantenimiento: marca Aprobar o Rechazar en cada
 * tarjeta (las marcas quedan en el navegador) y envía todo junto. Cada tarjeta dice qué recomienda la noche
 * (`.dashboard/instincts/recomendaciones.json`), y se puede seguir la recomendación o rechazar varias con un motivo.
 *
 * Al enviar:
 *   1. si hay aprobadas, UN pedido al repo del perfil agrega cada regla, con el texto que confirmó quien mantiene y su
 *      huella (`<!-- aprendizaje:<huella> -->`), al bloque `packs/<paquete>/claude-md-blocks/team-learnings.md`: llega a
 *      todas las máquinas como regla con la próxima actualización. Una huella que el bloque ya trae no se repite;
 *   2. UN pedido al repo de operaciones cambia cada archivo de propuesta a `aprobada` o `rechazada` con su `decision`,
 *      escrito con `archivoDecidido` de la noche: lo que escribe el sitio es lo que la noche lee.
 * Nada se escribe en main desde acá: todo va por pedido (o se aplica solo con `site.auto_apply`).
 *
 * Qué espera aprobación sale de los pedidos abiertos de ramas `team-config/aprendizajes…` de los dos repos: en
 * operaciones por sus archivos, en el perfil por las `aprendizaje: <huella>` de su cuerpo. Una lista por repo y los
 * archivos de cada pedido, guardado un minuto. Si la plataforma no contesta, una frase, y no se ofrece enviar. Con un
 * pedido de aprendizajes abierto en el perfil, aprobar espera a que se cierre: dos pedidos cambiarían el mismo bloque.
 *
 * «No pude leer» nunca es una lista vacía: sin la carpeta de propuestas, con la noche apagada, sin medir o con un
 * archivo que no se lee, una frase distinta. Ninguna máquina ni persona aparece como autora de lo repetido; quien
 * decidió sale por lo de antes de la arroba.
 *
 * Rutas (todas `maintainer`: otro rol no ve la pestaña en el menú): GET /aprendizajes · GET /api/aprendizajes · POST
 * /api/aprendizajes/enviar · GET /aprendizajes/cliente.js. Casos: scripts/tests/site-learnings.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ORG = require('../../lib/org-config.js');
const RP = require('../../lib/repo-proposal.js');
// las piezas de la noche de los instintos (scripts/instincts/): la que arma la decisión y la del borrador para el arnés
const DE_LA_NOCHE = (nombre) => path.join(__dirname, '..', '..', 'instincts', nombre);
const NIGHT = require(DE_LA_NOCHE('instinct-nightly.js'));
const views = require('../views.js');
const TX = require('../texts.js');
const BUSY = require('../busy.js');
const { defensaDeEscritura } = require('./config.js');
const HOW = require('./how-it-works.js');

const DIR_PROPUESTAS = NIGHT.PROPUESTAS;
const DIR_INFORMES = '.dashboard/instincts';
/** Lo que la pestaña lee del repo de operaciones: la copia del contenedor lo trae (operations-copy.js `RUTAS`). */
const LECTURAS = Object.freeze([`${DIR_PROPUESTAS}/`, `${DIR_INFORMES}/`]);
const HUELLA = /^[0-9a-f]{10}$/;
const INFORME = /^instintos-(\d{4}-\d{2}-\d{2})\.json$/;
const ENLACE = /^https:\/\/[^\s"'<>\\]{1,500}$/;
const PAQUETE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// las acciones del envío, en inglés como las de Mantenimiento; el texto de cada botón sale de su clave en castellano
const ACCIONES = ['approve', 'reject', 'repropose'];
const CLAVE_DEL_BOTON = { approve: 'aprobar', reject: 'rechazar' };
// el texto aprobado y el motivo de un rechazo: una línea, de 1 a 300 caracteres, para que cada regla sea un renglón del bloque
const TEXTO_MAX = 300;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
// el techo del bloque del equipo, en bytes UTF-8: el bloque viaja en el contexto de cada sesión de cada máquina
const TECHO = 4000;
const TOPE_ENVIO = 200;
// hasta acá, la descripción del pedido nombra cada decisión; con más, las cuenta: los archivos del pedido ya las traen
const NOMBRADAS_MAX = 50;
// lo que la noche deja en su archivo de recomendaciones (instinct-nightly.js)
const REGLAS = ['conteo_sin_leccion', 'carpeta_de_trabajo', 'ruta_de_una_maquina', 'un_solo_proyecto', 'sin_propuesta', 'confianza', 'ya_decidida', 'cubierta'];
const SIN_RECOMENDACION = ['tope', 'fallo', 'sin_modelo', 'sin_llave', 'sin_redaccion', 'respuesta_ilegible'];
const ACCION_RECOMENDADA = { aprobar: 'approve', rechazar: 'reject' };
const VIGENCIA_PEDIDOS_MS = 60 * 1000;
const VIGENCIA_HISTORIA_MS = 30 * 24 * 3600 * 1000;
const RAMA = 'team-config/aprendizajes';
const EN_EL_CUERPO = /aprendizaje: ([0-9a-f]{10})/g;
const bloqueDe = (paquete) => `packs/${paquete}/claude-md-blocks/team-learnings.md`;
const marcaDe = (huella) => `<!-- aprendizaje:${huella} -->`;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const json = (status, obj) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj) });
// lo que se muestra de un archivo pasa por el mismo saneado que la grabadora (rutas de la casa, credenciales), aunque la
// noche ya lo haya saneado al escribir: el archivo pudo llegar de otro lado
const { sanear } = require('../../metrics/tokens-digest.js');
const corto = (s, n = 300) => (typeof s === 'string' ? sanear(s).slice(0, n) : null);
const dia = (f) => (typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : '');
// quién decidió, sin su correo: lo de antes de la arroba (como el historial de Mantenimiento)
const alias = (q) => { const m = /^([a-z0-9][a-z0-9._+-]{0,63})@/.exec(String(q || '').trim().toLowerCase()); return m ? m[1] : null; };
/** La versión de un archivo como la calcula git (el hash de su blob): sirve igual con un clon que con la copia sin git. */
const oidDe = (texto) => (texto === null ? null : crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(texto)}\0`), Buffer.from(texto)])).digest('hex'));
// una línea, y sin marcas de comentario: un texto que abre o cierra un comentario podría imitar la huella de otra regla
// del bloque; el cierre tiene dos formas, `-->` y `--!>`
const unaLinea = (s) => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= TEXTO_MAX && !CONTROL.test(s) && !/<!--|--!?>/.test(s);
const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? null : undefined; } };
const sha12 = (lineas) => crypto.createHash('sha1').update([...lineas].sort().join('\n')).digest('hex').slice(0, 12);

/** Las propuestas del clon: `{ estado: 'sin_carpeta' | 'leido', lista: [{ huella, doc, texto }], ilegibles: [ruta] }`. */
function leerPropuestas(dir) {
  const d = path.join(dir, DIR_PROPUESTAS);
  let nombres;
  try { nombres = fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort(); } catch (e) {
    return e && e.code === 'ENOENT' ? { estado: 'sin_carpeta', lista: [], ilegibles: [] } : { estado: 'leido', lista: [], ilegibles: [`${DIR_PROPUESTAS}/`] };
  }
  const lista = [];
  const ilegibles = [];
  for (const n of nombres) {
    const huella = n.slice(0, -'.json'.length);
    if (!HUELLA.test(huella)) continue;
    const texto = leer(path.join(d, n));
    let doc = null;
    try { doc = JSON.parse(texto); } catch { /* abajo */ }
    if (!isObject(doc) || doc.huella !== huella || typeof doc.estado !== 'string') { ilegibles.push(`${DIR_PROPUESTAS}/${n}`); continue; }
    lista.push({ huella, doc, texto });
  }
  return { estado: 'leido', lista, ilegibles };
}

/** El último informe de la noche: `{ informe }`, `{ ilegible: ruta }` o null si no hay ninguno. */
function ultimoInforme(dir) {
  let nombres;
  try { nombres = fs.readdirSync(path.join(dir, DIR_INFORMES)).filter((n) => INFORME.test(n)).sort(); } catch (e) {
    return e && e.code === 'ENOENT' ? null : { ilegible: `${DIR_INFORMES}/` };
  }
  if (!nombres.length) return null;
  const n = nombres[nombres.length - 1];
  try {
    const informe = JSON.parse(fs.readFileSync(path.join(dir, DIR_INFORMES, n), 'utf8'));
    return isObject(informe) ? { informe } : { ilegible: `${DIR_INFORMES}/${n}` };
  } catch { return { ilegible: `${DIR_INFORMES}/${n}` }; }
}

/** Lo que la noche recomendó: `{ estado: 'leido' | 'sin_archivo' | 'ilegible', por }`, con `por` indexado por huella. */
function leerRecomendaciones(dir) {
  const texto = leer(path.join(dir, NIGHT.RECOMENDACIONES));
  if (texto === null) return { estado: 'sin_archivo', por: {} };
  let doc = null;
  try { doc = JSON.parse(texto); } catch { /* abajo */ }
  return isObject(doc) && isObject(doc.por_huella) ? { estado: 'leido', por: doc.por_huella } : { estado: 'ilegible', por: {} };
}

/**
 * El borrador para el arnés de una propuesta que lo sugiere (`redaccion.tycon_artifact_suggestion`): `{ url, archivo }`
 * o null. `generateDraft` espera la forma de un instinto: el sitio la arma desde la propuesta, en una carpeta temporal
 * que se borra. El enlace abre un issue nuevo del repo público con el borrador escrito: lo envía quien mantiene con su
 * cuenta; el sitio no escribe el borrador en ningún repo.
 */
function borradorAlArnes(p, { idioma, publicRepo, version, tmpBase = os.tmpdir() }) {
  const r = isObject(p) && isObject(p.redaccion) ? p.redaccion : null;
  if (!r || !publicRepo || !/^(advisor|skill|hook|guide):.+$/.test(String(r.tycon_artifact_suggestion || ''))) return null;
  const inst = { hash: p.huella, evidence_count: p.veces, project: p.repo, trigger: r.trigger, action: r.action, domain: r.domain, scope: r.scope,
    confidence: r.confidence, reasoning: r.reasoning, tycon_artifact_suggestion: r.tycon_artifact_suggestion };
  const tmp = fs.mkdtempSync(path.join(tmpBase, 'aprendizaje-'));
  try {
    const d = require(DE_LA_NOCHE('instinct-draft.js')).generateDraft(inst, tmp);
    if (!d) return null;
    const archivo = path.basename(d.path);
    const { url } = HOW.buildIssueUrl({ publicRepo, piece: archivo, stepName: TX.t(idioma, 'aprend.alArnesPaso'), version, text: d.content, t: (k, v) => TX.t(idioma, k === 'comoTrabaja.mejoraOrigen' ? 'aprend.mejoraOrigen' : k, v), max: HOW.ISSUE_URL_MAX });
    return url ? { url, archivo } : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function crearRutas({ cfg, fuentes, ahora = Date.now, fetch = globalThis.fetch, urlBase = {}, urlBasePerfil = urlBase, remotos = {}, log = () => {}, versionImagen = null }) {
  const T = (idioma, k, v) => TX.t(idioma, k, v);
  const clones = () => (typeof fuentes.clones === 'function' ? fuentes.clones() : null) || {};
  const dirOps = () => { const o = clones().operaciones; return o && o.dir ? o.dir : null; };
  const dirPerfil = () => { const p = clones().perfil; return cfg.profileRepo && p && p.dir ? p.dir : null; };
  const REPOS = {
    operaciones: { remote: () => remotos.operaciones || ORG.remoteOf(cfg.operationsRepo), cred: () => cfg.escritura && cfg.escritura.operaciones, urlBase },
    perfil: { remote: () => remotos.perfil || ORG.remoteOf(cfg.profileRepo), cred: () => (cfg.escritura && cfg.escritura.perfil) || (cfg.profileCredencial && cfg.profileCredencial.token) || null, urlBase: urlBasePerfil },
  };
  // el enlace de un pedido que viene de un archivo se pinta sólo si es de la plataforma de uno de los dos repos
  const hostDe = (u) => { try { return new URL(u).host; } catch { return null; } };
  const dePlataforma = (u) => {
    if (!ENLACE.test(String(u || ''))) return false;
    const hosts = ['operaciones', 'perfil'].map((k) => { const r = REPOS[k].remote(); return r && r.web ? hostDe(r.web) : null; }).filter(Boolean);
    return hosts.includes(hostDe(u));
  };
  const aplicaSolo = () => { const c = typeof fuentes.config === 'function' ? fuentes.config() : null; return Boolean(c && isObject(c.site) && c.site.auto_apply === true); };
  const publicRepo = HOW.publicRepoOf();

  /** Lo que le falta a cada botón para escribir: `{ rechazar, aprobar }`, null si puede. */
  function escritura(idioma) {
    const ops = cfg.escritura && cfg.escritura.operaciones ? null : T(idioma, 'aprend.falta', { variable: 'SITE_OPERATIONS_WRITE_TOKEN' });
    const perfil = !cfg.profileRepo ? T(idioma, 'aprend.falta', { variable: 'SITE_PROFILE_REPO' })
      : !(cfg.escritura && cfg.escritura.perfil) ? T(idioma, 'aprend.falta', { variable: 'SITE_PROFILE_WRITE_TOKEN' }) : null;
    return { rechazar: ops, aprobar: [ops, perfil].filter(Boolean).join(' · ') || null };
  }

  // ── lo que espera aprobación: los pedidos de aprendizajes abiertos de los dos repos ──
  let guardada = null;
  let ultima = null;
  let enCamino = null;
  let intentada = -Infinity;
  async function leerRepo(nombre) {
    const r = REPOS[nombre];
    const remote = r.remote();
    if (!remote || !remote.platform) return { estado: 'no_se_pudo', error: 'sin plataforma' };
    const credencial = r.cred();
    const p = await RP.pedidosAbiertos({ remote, credencial, urlBase: r.urlBase, fetch });
    if (p.error) return { estado: 'no_se_pudo', error: p.error };
    const porHuella = new Map();
    const abiertos = [];
    for (const x of p.pedidos.filter((y) => String(y.rama).startsWith(RAMA) && Number.isInteger(y.numero)).sort((a, b) => a.numero - b.numero)) {
      const a = await RP.archivosDelPedido({ remote, credencial, numero: x.numero, urlBase: r.urlBase, fetch });
      if (a.error) return { estado: 'no_se_pudo', error: a.error };
      const enlace = ENLACE.test(String(x.enlace)) ? x.enlace : null;
      const huellas = nombre === 'operaciones'
        ? a.archivos.map((f) => (new RegExp(`^${DIR_PROPUESTAS}/([0-9a-f]{10})\\.json$`).exec(f) || [])[1]).filter(Boolean)
        : [...String(a.cuerpo).matchAll(EN_EL_CUERPO)].map((m) => m[1]);
      abiertos.push({ numero: x.numero, enlace });
      for (const h of huellas) if (!porHuella.has(h)) porHuella.set(h, { repo: nombre, numero: x.numero, enlace });
    }
    return { estado: 'leido', porHuella, abiertos };
  }
  async function leerMembresia() {
    const operaciones = await leerRepo('operaciones').catch((e) => ({ estado: 'no_se_pudo', error: (e && e.code) || 'error' }));
    const perfil = cfg.profileRepo ? await leerRepo('perfil').catch((e) => ({ estado: 'no_se_pudo', error: (e && e.code) || 'error' })) : { estado: 'sin_perfil', porHuella: new Map(), abiertos: [] };
    for (const [n, x] of [['operaciones', operaciones], ['perfil', perfil]]) if (x.estado === 'no_se_pudo') log(`aprendizajes: no se pudo ver qué espera aprobación en ${n} (${String(x.error).slice(0, 120)})`);
    return { operaciones, perfil };
  }
  /** `{ operaciones, perfil }`, cada uno `{ estado: 'leido', porHuella, abiertos }` o `{ estado: 'no_se_pudo' }`. */
  async function membresia() {
    if (guardada && ahora() - guardada.t < VIGENCIA_PEDIDOS_MS) return guardada.r;
    const r = await leerMembresia();
    const leida = r.operaciones.estado === 'leido' && r.perfil.estado !== 'no_se_pudo';
    guardada = leida ? { t: ahora(), r } : null;
    if (leida) ultima = r;
    return r;
  }
  const esperandoDe = (m, h) => {
    for (const x of [m.operaciones, m.perfil]) if (x && x.estado === 'leido' && x.porHuella.has(h)) return x.porHuella.get(h);
    return null;
  };

  /** Las propuestas que esperan decisión, para el número del menú: sin preguntar a la plataforma, con lo último que contestó. */
  function cuantasEsperan() {
    const dir = dirOps();
    if (!dir) return null;
    const l = leerPropuestas(dir);
    if (!ultima && !enCamino && ahora() - intentada >= VIGENCIA_PEDIDOS_MS) {
      intentada = ahora();
      enCamino = membresia().catch(() => null).finally(() => { enCamino = null; });
    }
    // con algo que no se pudo leer, el menú no da un número: «no sé» no es «nada esperando»
    if (l.ilegibles.length) return null;
    return l.lista.filter((x) => x.doc.estado === 'pendiente' && !(ultima && esperandoDe(ultima, x.huella))).length;
  }

  // ── el perfil: sus paquetes y el bloque del equipo ──

  /**
   * `{ estado, lista: [{ nombre, activo, conBloque }], elegido, frena, aviso, huellas: Set }`. Viene elegido el paquete
   * que ya tiene el bloque; con uno solo, ése; si no, lo elige quien mantiene. Sin paquetes, aprobar se frena (un
   * paquete sin revisores es un paquete roto: no se crea uno sólo para los aprendizajes).
   */
  function paquetes(idioma) {
    const dir = dirPerfil();
    const vacio = { estado: 'sin_perfil', lista: [], elegido: null, frena: T(idioma, 'aprend.sinPerfil'), aviso: null, huellas: null };
    if (!dir) return vacio;
    let nombres = [];
    try { nombres = fs.readdirSync(path.join(dir, 'packs')).filter((n) => PAQUETE.test(n) && fs.existsSync(path.join(dir, 'packs', n, 'pack.json'))).sort(); } catch (e) {
      if (!(e && e.code === 'ENOENT')) return { ...vacio, estado: 'ilegible', frena: T(idioma, 'aprend.perfilIlegible') };
    }
    // sin `packs.default`, ningún paquete activo (el valor de fábrica del lector); un perfil que no se lee no es «ninguno»
    let def = 'none';
    const texto = leer(path.join(dir, 'team-profile.json'));
    let perfil = null;
    try { perfil = typeof texto === 'string' ? JSON.parse(texto) : null; } catch { /* abajo */ }
    if (texto === undefined || (typeof texto === 'string' && !isObject(perfil))) return { ...vacio, estado: 'ilegible', frena: T(idioma, 'aprend.perfilIlegible') };
    if (perfil && isObject(perfil.packs) && perfil.packs.default !== undefined) def = perfil.packs.default;
    const activo = (n) => def === 'all' || (Array.isArray(def) && def.includes(n));
    const huellas = new Set();
    let bloqueIlegible = false;
    const lista = nombres.map((n) => {
      const t = leer(path.join(dir, bloqueDe(n)));
      if (t === undefined) bloqueIlegible = true;
      if (typeof t === 'string') for (const m of t.matchAll(/<!-- aprendizaje:([0-9a-f]{10}) -->/g)) huellas.add(m[1]);
      return { nombre: n, activo: activo(n), conBloque: typeof t === 'string' };
    });
    // un bloque que no se lee: no se sabe qué reglas ya están, así que no se dice «no llegó» ni se aprueba a ciegas
    if (bloqueIlegible) return { ...vacio, estado: 'ilegible', lista, frena: T(idioma, 'aprend.perfilIlegible') };
    const conBloque = lista.filter((x) => x.conBloque);
    const elegido = conBloque.length ? conBloque[0].nombre : lista.length === 1 ? lista[0].nombre : null;
    const e = lista.find((x) => x.nombre === elegido);
    return { estado: 'leido', lista, elegido, frena: lista.length ? null : T(idioma, 'aprend.sinPaquetes'), aviso: e && !e.activo ? T(idioma, 'aprend.inactivo', { paquete: e.nombre }) : null, huellas };
  }

  // ── el modelo de la pantalla ──

  /** Qué recomienda la noche para una pendiente: el nombre del modelo no sale de acá, y lo que no tiene forma no se muestra. */
  function recomendacionDe(huella, recos, idioma) {
    const sin = (motivo) => ({ recomendacion: null, sinRecomendacion: T(idioma, `aprend.sinRec.${motivo}`) });
    if (recos.estado === 'ilegible') return sin('ilegible');
    const e = recos.por[huella];
    if (!isObject(e)) return sin('todavia');
    if (!isObject(e.recomendacion)) return sin(SIN_RECOMENDACION.includes(e.sin_recomendacion) ? e.sin_recomendacion : 'todavia');
    const r = e.recomendacion;
    const accion = Object.hasOwn(ACCION_RECOMENDADA, r.accion) ? ACCION_RECOMENDADA[r.accion] : null;
    if (r.por === 'regla' && accion === 'reject' && REGLAS.includes(r.regla)) return { recomendacion: { accion, por: 'regla', regla: r.regla, porque: T(idioma, `aprend.regla.${r.regla}`) }, sinRecomendacion: null };
    const porque = corto(r.porque);
    if (r.por === 'modelo' && accion && unaLinea(porque)) return { recomendacion: { accion, por: 'modelo', regla: null, porque }, sinRecomendacion: null };
    return sin('todavia');
  }

  function filaPendiente(x, m, idioma, recos) {
    const p = x.doc;
    const r = isObject(p.redaccion) && typeof p.redaccion.trigger === 'string' ? p.redaccion : null;
    const confianza = r && Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : null;
    let alArnes = null;
    try { const b = borradorAlArnes(p, { idioma, publicRepo, version: versionImagen }); alArnes = b ? b.url : null; } catch (e) { log(`aprendizajes: el borrador de ${x.huella} no se pudo armar (${(e && e.code) || 'error'})`); }
    return {
      huella: x.huella, herramienta: corto(p.herramienta, 60), patron: corto(p.patron), repo: corto(p.repo, 120),
      maquinas: Number.isInteger(p.maquinas) ? p.maquinas : null, veces: Number.isInteger(p.veces) ? p.veces : null, desde: corto(p.desde, 10), hasta: corto(p.hasta, 10),
      regla: r ? { trigger: corto(r.trigger), action: corto(r.action), confianza } : null,
      sinRedaccion: r ? null : T(idioma, 'aprend.sinRedaccion', { motivo: T(idioma, `aprend.motivo.${['tope', 'fallo', 'sin_modelo', 'sin_llave'].includes(p.sin_redaccion) ? p.sin_redaccion : 'otro'}`) }),
      sugerida: r ? `${corto(r.trigger, 140)}: ${corto(r.action, 150)}`.slice(0, TEXTO_MAX) : '',
      esperando: esperandoDe(m, x.huella), alArnes, ...recomendacionDe(x.huella, recos, idioma),
    };
  }

  async function modelo(idioma) {
    const vacio = { pendientes: [], historial: [], noche: null, pedidos: null, paquetes: null, escritura: escritura(idioma), aplicaSolo: aplicaSolo() };
    const dir = dirOps();
    if (!dir) return { ...vacio, estado: 'sin_clon', frase: T(idioma, 'aprend.sinClon') };
    const l = leerPropuestas(dir);
    const inf = ultimoInforme(dir);
    const informe = inf && inf.informe ? inf.informe : null;
    const recos = leerRecomendaciones(dir);
    const ilegibles = [...l.ilegibles, ...(inf && inf.ilegible ? [inf.ilegible] : []), ...(recos.estado === 'ilegible' ? [NIGHT.RECOMENDACIONES] : [])];
    const estado = ilegibles.length ? 'ilegible' : informe && informe.estado === 'apagado' ? 'apagado' : informe && informe.estado === 'no_medido' ? 'no_medido'
      : l.estado === 'sin_carpeta' ? 'sin_propuestas' : 'leido';
    const frase = estado === 'ilegible' ? T(idioma, 'aprend.ilegible', { archivos: ilegibles.join(', ') })
      : estado === 'apagado' ? T(idioma, 'aprend.apagado')
        : estado === 'no_medido' ? T(idioma, 'aprend.noMedido', { motivo: corto(informe.motivo, 60) || '?' })
          : estado === 'sin_propuestas' ? T(idioma, 'aprend.sinPropuestas') : null;
    const m = await membresia();
    const pq = paquetes(idioma);
    const pendientes = l.lista.filter((x) => x.doc.estado === 'pendiente')
      .sort((a, b) => (b.doc.maquinas || 0) - (a.doc.maquinas || 0) || (b.doc.veces || 0) - (a.doc.veces || 0) || a.huella.localeCompare(b.huella))
      .map((x) => filaPendiente(x, m, idioma, recos));
    const desde = new Date(ahora() - VIGENCIA_HISTORIA_MS).toISOString().slice(0, 10);
    const perfilLeido = m.perfil.estado === 'leido';
    const historial = l.lista.filter((x) => ['aprobada', 'rechazada'].includes(x.doc.estado) && isObject(x.doc.decision) && typeof x.doc.decision.el === 'string' && x.doc.decision.el >= desde)
      .sort((a, b) => b.doc.decision.el.localeCompare(a.doc.decision.el) || a.huella.localeCompare(b.huella))
      .map((x) => {
        const d = x.doc.decision;
        const aprobada = x.doc.estado === 'aprobada';
        const enPerfil = aprobada && pq.huellas ? pq.huellas.has(x.huella) : null;
        const esperando = esperandoDe(m, x.huella);
        return { huella: x.huella, estado: x.doc.estado, patron: corto(x.doc.patron), quien: alias(d.por), el: corto(d.el, 10), texto: aprobada ? corto(d.texto) : null, motivo: aprobada ? null : corto(d.motivo),
          pedido: dePlataforma(d.pedido) ? d.pedido : null, enPerfil, esperando, reproponer: aprobada && enPerfil === false && !esperando && perfilLeido && unaLinea(d.texto) };
      });
    const suma = (o) => Object.values(o).filter(Number.isInteger).reduce((a, b) => a + b, 0);
    // lo que no se pudo redactar espera sin archivo: cuenta también; lo que espera por el tope es lo normal
    const sinRedactar = (i) => {
      if (!isObject(i.sin_redaccion) && !isObject(i.en_espera_por)) return null;
      const { tope: _tope, ...porFalta } = isObject(i.en_espera_por) ? i.en_espera_por : {};
      return suma(isObject(i.sin_redaccion) ? i.sin_redaccion : {}) + suma(porFalta);
    };
    const noche = informe ? { fecha: corto(informe.fecha, 10), estado: corto(informe.estado, 20),
      modelo: isObject(informe.modelo) && informe.modelo.model ? `${corto(informe.modelo.provider, 30)} · ${corto(informe.modelo.model, 60)}` : null,
      sinRedactar: sinRedactar(informe), filtradas: isObject(informe.filtradas) ? suma(informe.filtradas) : null } : null;
    const leidos = m.operaciones.estado === 'leido' && m.perfil.estado !== 'no_se_pudo';
    return { ...vacio, estado, frase, noche, pendientes, historial, paquetes: { lista: pq.lista, elegido: pq.elegido, frena: pq.frena, aviso: pq.aviso },
      pedidos: leidos ? { estado: 'leido', frase: null } : { estado: 'no_se_pudo', frase: T(idioma, 'aprend.sinPedidos') } };
  }

  // ── la página ──

  function seccion(m, idioma, tok) {
    const t = (k, v) => T(idioma, k, v);
    const frases = [m.frase, m.pedidos && m.pedidos.frase, m.paquetes && m.paquetes.aviso].filter(Boolean).map((x) => `<p class="q-note">${esc(x)}</p>`).join('');
    const n = m.noche;
    const noche = n ? `<p class="a-noche">${esc(t('aprend.noche', { dia: dia(n.fecha), estado: t(`aprend.estadoNoche.${['medido', 'apagado', 'no_medido'].includes(n.estado) ? n.estado : 'otro'}`), modelo: n.modelo || t('aprend.sinModelo'), n: n.sinRedactar === null ? '?' : n.sinRedactar, filtradas: n.filtradas === null ? '?' : n.filtradas }))}</p>` : '';
    const puedeEnviar = m.pedidos && m.pedidos.estado === 'leido';
    const puedeRechazar = puedeEnviar && !m.escritura.rechazar;
    const boton = (accion, falta, recomendada) => `<button type="button" class="a-elegir${recomendada ? ' recomendada' : ''}" data-accion="${accion}"${falta || !puedeEnviar ? ` disabled title="${esc(falta || m.pedidos.frase)}"` : ''} aria-pressed="false">${esc(t(`aprend.${CLAVE_DEL_BOTON[accion]}`))}</button>`;
    // el porqué del modelo está en castellano: `lang` para quien lo lee en voz alta, y la nota en otro idioma
    const recomendacion = (p) => {
      const r = p.recomendacion;
      if (!r) return `<p class="a-sin">${esc(p.sinRecomendacion)}</p>`;
      const titulo = `<b>${esc(t(r.accion === 'approve' ? 'aprend.recomiendaAprobar' : 'aprend.recomiendaRechazar'))}</b>`;
      if (r.por === 'regla') return `<p class="a-recomienda">${titulo} ${esc(r.porque)}</p>`;
      return `<p class="a-recomienda">${titulo} <span lang="es">${esc(r.porque)}</span>${idioma === 'es' ? '' : ` ${esc(t('aprend.razonEnCastellano'))}`} <span class="a-meta">${esc(t('aprend.propusoModelo'))}</span></p>`;
    };
    const enlace = (texto, url) => (url && ENLACE.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(texto)}</a>` : esc(texto));
    const carta = (p) => {
      const numeros = t('aprend.numeros', { maquinas: p.maquinas === null ? '?' : p.maquinas, veces: p.veces === null ? '?' : p.veces, desde: dia(p.desde), hasta: dia(p.hasta) });
      const regla = p.regla ? `<p class="a-regla"><b>${esc(t('aprend.reglaSugerida'))}</b> ${esc(p.regla.trigger)} → ${esc(p.regla.action)}${p.regla.confianza === null ? '' : ` <span class="a-meta">${esc(t('aprend.confianza', { n: Math.round(p.regla.confianza * 100) }))}</span>`}</p>`
        : `<p class="a-sin">${esc(p.sinRedaccion)}</p>`;
      // lo que ya espera un pull request no se vuelve a decidir: ni botones, ni casilla, ni resaltado
      const recomendada = p.esperando || !p.recomendacion ? null : p.recomendacion.accion;
      const pie = p.esperando ? `<p class="a-espera">${enlace(t('aprend.esperando'), p.esperando.enlace)}</p>`
        : `<div class="a-decidir"><p class="a-decidir-tit">${esc(t('aprend.decidir'))}</p><div class="a-acciones" role="group">${boton('approve', m.escritura.aprobar || (m.paquetes && m.paquetes.frena), recomendada === 'approve')}${boton('reject', m.escritura.rechazar, recomendada === 'reject')}</div>`
          + `<label class="a-casilla"><input type="checkbox" class="a-elige"${puedeRechazar ? '' : ' disabled'}> ${esc(t('aprend.elegir'))}</label>`
          + `<label class="a-texto-caja" hidden>${esc(t('aprend.textoAprobado'))} <input type="text" class="a-texto" maxlength="${TEXTO_MAX}" value="${esc(p.sugerida)}" autocomplete="off"></label>`
          + `<label class="a-motivo-caja" hidden>${esc(t('aprend.motivoRechazo'))} <input type="text" class="a-motivo" maxlength="${TEXTO_MAX}" autocomplete="off"></label></div>`;
      const arnes = p.alArnes ? `<p><a class="btn" href="${esc(p.alArnes)}" rel="noopener noreferrer" target="_blank">${esc(t('aprend.alArnes'))}</a></p>` : '';
      const datos = `${recomendada ? ` data-recomendada="${recomendada}" data-porque="${esc(p.recomendacion.porque)}"` : ''}${recomendada && p.recomendacion.regla ? ` data-regla="${esc(p.recomendacion.regla)}"` : ''}`;
      return `<article class="a-carta" data-huella="${esc(p.huella)}"${datos}><header><b class="a-nombre">${esc(p.herramienta || '?')} · ${esc(p.patron || '')}</b> <span class="a-meta">${esc(p.repo || '')}</span></header>`
        + `<p class="a-meta">${esc(numeros)}</p>${regla}${recomendacion(p)}${arnes}${pie}</article>`;
    };
    const pendientes = `<div class="a-bloque"><h2>${esc(t('aprend.titulo', { n: m.pendientes.length }))}</h2>${m.pendientes.length ? m.pendientes.map(carta).join('') : `<p class="q-note">${esc(t('aprend.vacio'))}</p>`}</div>`;
    const decidida = (x) => {
      const que = x.estado === 'aprobada' ? `${t('aprend.aprobada')}: ${x.texto || ''}` : `${t('aprend.rechazada')}: ${x.motivo || ''}`;
      const perfil = x.estado !== 'aprobada' ? '' : x.esperando ? ` · ${enlace(t('aprend.esperando'), x.esperando.enlace)}`
        : x.enPerfil === true ? ` · ${esc(t('aprend.enElPerfil'))}` : x.enPerfil === false ? ` · ${enlace(t('aprend.noLlego'), x.pedido)}` : '';
      const volver = x.reproponer && !m.escritura.aprobar && puedeEnviar ? ` <button type="button" class="btn a-reproponer" data-huella="${esc(x.huella)}">${esc(t('aprend.reproponer'))}</button>` : '';
      return `<li data-huella="${esc(x.huella)}"><b>${esc(x.patron || x.huella)}</b> <span class="a-meta">${esc([que, x.quien, dia(x.el)].filter(Boolean).join(' · '))}</span>${perfil}${volver}</li>`;
    };
    const historial = `<details class="a-historial a-bloque"><summary>${esc(t('aprend.historial', { n: m.historial.length }))}</summary><ul class="a-lista">${m.historial.map(decidida).join('')}</ul></details>`;
    const pq = m.paquetes || { lista: [] };
    const elegir = pq.lista.length > 1 || (pq.lista.length && !pq.elegido)
      ? `<label>${esc(t('aprend.paquete'))} <select class="a-paquete">${pq.elegido ? '' : `<option value="">${esc(t('aprend.elegiPaquete'))}</option>`}${pq.lista.map((x) => `<option value="${esc(x.nombre)}"${x.nombre === pq.elegido ? ' selected' : ''}>${esc(x.nombre)}${x.activo ? '' : ` (${esc(t('aprend.noActivo'))})`}</option>`).join('')}</select></label>` : '';
    const textos = ['elegidas', 'faltaTexto', 'faltaMotivo', 'enviando', 'error', 'aprobar', 'rechazar', 'omitidas', 'sobran', 'elegidasGrupo'].map((k) => ` data-t-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${esc(t(`aprend.barra.${k}`))}"`).join('');
    // seguir las recomendaciones, y rechazar varias con un solo motivo: nada de esto envía, sólo marca
    const porDecidir = m.pendientes.filter((p) => !p.esperando);
    const cuantasPorRegla = REGLAS.map((regla) => [regla, porDecidir.filter((p) => p.recomendacion && p.recomendacion.regla === regla).length]).filter(([, n]) => n);
    const inactivo = puedeRechazar ? '' : ' disabled';
    const grupo = porDecidir.length ? `<button type="button" class="btn a-seguir" data-t="${esc(t('aprend.seguir', { n: '{n}' }))}" disabled>${esc(t('aprend.seguir', { n: porDecidir.filter((p) => p.recomendacion).length }))}</button>`
      + `<div class="a-grupo">${cuantasPorRegla.map(([regla, n]) => `<button type="button" class="btn a-elegir-regla" title="${esc(t('aprend.elegirReglaAyuda'))}"${inactivo} data-regla="${regla}">${esc(t('aprend.elegirRegla', { regla: t(`aprend.reglaNombre.${regla}`), n }))}</button>`).join('')}`
      + `<span class="a-grupo-cuenta" aria-live="polite"></span><label>${esc(t('aprend.motivoGrupo'))} <input type="text" class="a-motivo-grupo" maxlength="${TEXTO_MAX}" autocomplete="off"${inactivo}></label>`
      + `<button type="button" class="btn a-rechazar-elegidas" disabled>${esc(t('aprend.rechazarElegidas'))}</button></div>` : '';
    const barra = m.pendientes.length || m.historial.some((x) => x.reproponer)
      ? `<div class="a-barra" data-tope="${TOPE_ENVIO}"${textos}><span class="a-cuenta" aria-live="polite"></span>${elegir}<button type="button" class="btn prim a-enviar" disabled>${esc(t(m.aplicaSolo ? 'aprend.enviarSolo' : 'aprend.enviar'))}</button><button type="button" class="btn a-borrar">${esc(t('aprend.borrar'))}</button>${grupo}<span class="a-estado" aria-live="polite"></span></div>`
      : '';
    const contenido = m.estado === 'sin_clon' ? '' : noche + pendientes + historial + barra;
    return `<section id="aprendizajes" class="a-pantalla" data-token="${esc(tok)}">${frases}${contenido}<script src="/aprendizajes/cliente.js" defer></script></section>`;
  }

  // ── enviar ──

  async function enviar(body, ctx, idioma) {
    const invalido = json(400, { ok: false, message: T(idioma, 'aprend.pedidoInvalido') });
    if (!isObject(body) || typeof body.marca !== 'string' || !RP.FORMA_DE_MARCA.test(body.marca) || !Array.isArray(body.decisiones)) return invalido;
    const lista = body.decisiones;
    if (!lista.length || lista.length > TOPE_ENVIO) return invalido;
    if (body.paquete !== undefined && body.paquete !== null && !(typeof body.paquete === 'string' && PAQUETE.test(body.paquete))) return invalido;
    for (const d of lista) {
      if (!isObject(d) || typeof d.huella !== 'string' || !HUELLA.test(d.huella) || !ACCIONES.includes(d.accion)) return invalido;
      // el motivo va sólo en un rechazo y el texto sólo en una aprobación: una línea, que no se recorta
      if ((d.accion === 'reject') !== (d.motivo !== undefined) || (d.motivo !== undefined && !unaLinea(d.motivo))) return invalido;
      if (d.texto !== undefined && (d.accion !== 'approve' || !unaLinea(d.texto))) return invalido;
    }
    if (new Set(lista.map((d) => d.huella)).size !== lista.length) return invalido;
    const dir = dirOps();
    if (!dir) return json(200, { ok: false, codigo: 'sin_clon', message: T(idioma, 'aprend.sinClon') });
    const quien = String((ctx.sesion && ctx.sesion.email) || (ctx.quien && ctx.quien.email) || '').trim().toLowerCase();
    const falta = escritura(idioma);
    const vaAOps = lista.some((d) => d.accion !== 'repropose');
    const vaAlPerfil = lista.some((d) => d.accion !== 'reject');
    if (!quien || (vaAOps && falta.rechazar) || (vaAlPerfil && falta.aprobar)) return json(200, { ok: false, codigo: 'sin_identidad', message: (vaAlPerfil && falta.aprobar) || falta.rechazar || T(idioma, 'aprend.sinQuien') });
    const m = await membresia();
    if (m.operaciones.estado !== 'leido' || (vaAlPerfil && m.perfil.estado !== 'leido')) return json(200, { ok: false, codigo: 'sin_pedidos', message: T(idioma, 'aprend.sinPedidos') });
    const pq = paquetes(idioma);
    // el pedido al perfil de esta misma marca (un reenvío): sus huellas no cuentan como «ya esperando»
    const previo = vaAlPerfil ? await RP.pedidoDeMarca({ remote: REPOS.perfil.remote(), credencial: cfg.escritura.perfil, marca: body.marca, urlBase: REPOS.perfil.urlBase, fetch, ahora: ahora() }) : null;
    if (previo && previo.error) return json(200, { ok: false, codigo: 'sin_pedidos', message: T(idioma, 'aprend.sinPedidos') });
    const esperaOtro = (h) => { const e = esperandoDe(m, h); return Boolean(e) && !(previo && e.repo === 'perfil' && e.enlace === previo.enlace); };
    const porHuella = new Map(leerPropuestas(dir).lista.map((x) => [x.huella, x]));
    const omitidas = [];
    let van = [];
    for (const d of lista) {
      const x = porHuella.get(d.huella);
      const p = x && x.doc;
      const sirve = d.accion === 'repropose'
        ? p && p.estado === 'aprobada' && isObject(p.decision) && unaLinea(p.decision.texto) && pq.huellas && !pq.huellas.has(d.huella)
        : p && p.estado === 'pendiente';
      if (!sirve || esperaOtro(d.huella)) { omitidas.push(d.huella); continue; }
      // la misma regla que muestra la pantalla: saneada (rutas de la casa, credenciales) antes de ir al bloque
      const armada = isObject(p.redaccion) && typeof p.redaccion.trigger === 'string' ? sanear(`${p.redaccion.trigger}: ${p.redaccion.action || ''}`).slice(0, TEXTO_MAX) : null;
      // la regla sugerida la escribió un modelo: pasa el mismo control de una línea que el texto de quien mantiene
      const sugerida = unaLinea(armada) ? armada : null;
      // una propuesta sin redacción (o con una que no es una línea) no se aprueba sin el texto de quien mantiene
      if (d.accion === 'approve' && d.texto === undefined && !sugerida) return json(400, { ok: false, codigo: 'falta_texto', message: T(idioma, 'aprend.faltaTexto') });
      const texto = d.accion === 'approve' ? (d.texto !== undefined ? d.texto.trim() : sugerida) : d.accion === 'repropose' ? p.decision.texto.trim() : null;
      van.push({ ...d, x, texto, motivo: d.motivo !== undefined ? d.motivo.trim() : null });
    }
    if (!van.length) return json(200, { ok: false, codigo: 'nada_que_enviar', message: T(idioma, 'aprend.nadaQueEnviar'), omitidas });
    const el = new Date(ahora()).toISOString().slice(0, 10);
    const now = new Date(ahora());
    const exclusivo = fuentes.exclusivo || ((fn) => fn());
    const aplicarSolo = aplicaSolo();
    try {
      // 1. el perfil: las reglas aprobadas al bloque del paquete
      let perfil = null;
      const alPerfil = van.filter((v) => v.accion !== 'reject');
      if (alPerfil.length) {
        const r = await alBloque(alPerfil, { body, pq, quien, now, exclusivo, aplicarSolo, idioma, m, previo });
        if (!r.ok) return json(200, { ...r, omitidas });
        perfil = r.perfil;
      }
      // 2. operaciones: cada propuesta decidida
      const aOps = van.filter((v) => v.accion !== 'repropose');
      if (!aOps.length) return json(200, { ok: true, codigo: perfil && perfil.codigo === 'aplicado' ? 'aplicado' : 'abierto', perfil, operaciones: null, enviadas: van.map((v) => v.huella), omitidas, queSigue: queSigue(perfil, null, idioma) });
      const r = await alRepoDeOperaciones(aOps, { perfil, quien, el, now, exclusivo, aplicarSolo, idioma, omitidas });
      if (!r.ok) {
        const message = perfil ? T(idioma, 'aprend.envio.opsFallo', { perfil: perfil.enlace || '', motivo: r.message }) : r.message;
        return json(200, { ...r, message, perfil, omitidas });
      }
      return json(200, { ok: true, codigo: r.codigo, perfil, operaciones: { enlace: r.enlace || null }, enviadas: r.enviadas, omitidas, queSigue: queSigue(perfil, r, idioma) });
    } finally {
      // la próxima lectura vuelve a mirar qué espera aprobación
      guardada = null;
    }
  }

  /** Qué sigue, en una línea: quién aprueba cada pedido y cuándo llega a las máquinas. */
  function queSigue(perfil, ops, idioma) {
    const aplicado = (x) => !x || x.codigo === 'aplicado';
    return { texto: T(idioma, aplicado(perfil) && aplicado(ops) ? 'aprend.sigue.solo' : 'aprend.sigue.aprobar') };
  }

  /**
   * El pedido al perfil con las reglas: reusa el de la misma marca; con otro pedido de aprendizajes abierto, espera;
   * agrega sólo las huellas que el bloque no trae, sin pasar el techo, y sube la capa si es anterior a los bloques de
   * paquete. `{ ok: true, perfil: { enlace, codigo } | null }` o `{ ok: false, codigo, message }`.
   */
  async function alBloque(van, { body, pq, quien, now, exclusivo, aplicarSolo, idioma, m, previo }) {
    // un perfil que no se pudo leer no deja aprobar: sin sus huellas no se sabe qué reglas ya están
    if (pq.estado === 'ilegible') return { ok: false, codigo: 'perfil_ilegible', message: pq.frena || T(idioma, 'aprend.perfilIlegible') };
    const paquete = body.paquete && pq.lista.some((x) => x.nombre === body.paquete) ? body.paquete : pq.elegido;
    if (!pq.lista.length || !paquete) return { ok: false, codigo: 'sin_paquete', message: pq.frena || T(idioma, 'aprend.elegiPaquete') };
    const dir = dirPerfil();
    const R = REPOS.perfil;
    if (previo) {
      // la misma marca reusa su pedido sólo si es el mismo envío: cada regla que va tiene que estar en ese pedido o ya en
      // el perfil; si no, es otro envío con una marca vieja y el pedido previo no la lleva
      const enPrevio = (h) => { const e = esperandoDe(m, h); return Boolean(e) && e.repo === 'perfil' && e.enlace === previo.enlace; };
      if (van.some((v) => !enPrevio(v.huella) && !(pq.huellas && pq.huellas.has(v.huella)))) return { ok: false, codigo: 'marca_otro_envio', message: T(idioma, 'aprend.marcaOtroEnvio') };
      return { ok: true, perfil: { enlace: previo.enlace, codigo: previo.estado === 'aplicado' ? 'aplicado' : 'abierto' } };
    }
    const abierto = m.perfil.abiertos && m.perfil.abiertos[0];
    if (abierto) return { ok: false, codigo: 'perfil_abierto', enlace: abierto.enlace, message: T(idioma, 'aprend.perfilAbierto', { enlace: abierto.enlace || '' }) };
    let bloque = leer(path.join(dir, bloqueDe(paquete)));
    let capa = leer(path.join(dir, 'team-layer.json'));
    if (bloque === undefined || capa === undefined) return { ok: false, codigo: 'perfil_ilegible', message: T(idioma, 'aprend.perfilIlegible') };
    for (let intento = 0; intento < 3; intento += 1) {
      // lo que ya está en el bloque de este paquete o de otro no se agrega: una regla va una sola vez al perfil
      const nuevas = van.filter((v) => !(bloque || '').includes(marcaDe(v.huella)) && !(pq.huellas && pq.huellas.has(v.huella)));
      // reenviar a cualquier hora nunca duplica una regla: lo que el bloque ya trae no se agrega
      if (!nuevas.length) return { ok: true, perfil: null };
      const base = bloque === null ? `${T('es', 'aprend.tituloDelBloque')}\n\n` : bloque.endsWith('\n') ? bloque : `${bloque}\n`;
      const contenido = `${base}${nuevas.map((v) => `- ${v.texto} ${marcaDe(v.huella)}`).join('\n')}\n`;
      if (Buffer.byteLength(contenido, 'utf8') > TECHO) return { ok: false, codigo: 'techo', message: T(idioma, 'aprend.techo', { techo: TECHO, paquete }) };
      const archivos = [{ archivo: bloqueDe(paquete), contenido, oidEsperado: oidDe(bloque) }];
      const subida = ORG.packBlocksLayer(capa);
      if (subida && subida.problema) return { ok: false, codigo: 'capa_ilegible', message: subida.problema };
      if (subida) archivos.push({ archivo: subida.archivo, contenido: subida.contenido, oidEsperado: oidDe(capa) });
      const secciones = nuevas.map((v) => `aprendizaje: ${v.huella}`);
      const r = await RP.proponer({
        clon: dir, archivos, idCorto: `aprendizajes-perfil-${sha12(secciones)}`, secciones, quien, credencial: cfg.escritura.perfil, remote: R.remote(), urlBase: R.urlBase,
        exclusivo, now, fetch, log, aplicarSolo, marca: body.marca, titulo: `Aprendizajes del equipo (${nuevas.length})`,
      });
      if (r && r.codigo === 'cambio' && typeof r.textoActual === 'string') {
        // otro cambió el bloque o la capa desde la foto: se pone encima de lo de main y se vuelve a proponer
        if ((r.archivo || archivos[0].archivo) === 'team-layer.json') capa = r.textoActual; else bloque = r.textoActual;
        continue;
      }
      if (r && (r.ok || r.codigo === 'aplicado') && r.enlace) return { ok: true, perfil: { enlace: r.enlace, codigo: r.codigo === 'aplicado' ? 'aplicado' : 'abierto' } };
      return { ok: false, codigo: (r && r.codigo) || 'error', message: T(idioma, 'aprend.envio.perfilFallo', { motivo: (r && r.message) || '?' }) };
    }
    return { ok: false, codigo: 'cambio', message: T(idioma, 'aprend.cambio') };
  }

  /** El pedido a operaciones: cada archivo decidido, con la versión de la foto. `cambio` con una ya decidida la saca. */
  async function alRepoDeOperaciones(van, { perfil, quien, el, now, exclusivo, aplicarSolo, idioma, omitidas }) {
    let clon = dirOps();
    if (clones().operaciones.indice) {
      if (typeof fuentes.clonDeEscritura !== 'function') return { ok: false, codigo: 'sin_clon', message: TX.t('es', 'config.sinClonEscritura') };
      const e = await fuentes.clonDeEscritura();
      if (!e || !e.dir) return { ok: false, codigo: 'sin_clon', message: TX.t('es', 'config.clonFallo', { motivo: (e && e.motivo) || TX.t('es', 'config.noSeArmoClon') }) };
      clon = e.dir;
    }
    const R = REPOS.operaciones;
    let lista = van;
    for (;;) {
      const archivos = lista.map((v) => ({
        archivo: `${DIR_PROPUESTAS}/${v.huella}.json`,
        contenido: NIGHT.archivoDecidido(v.x.doc, v.accion === 'approve' ? { estado: 'aprobada', por: quien, el, texto: v.texto, pedido: perfil ? perfil.enlace : null } : { estado: 'rechazada', por: quien, el, motivo: v.motivo }),
        oidEsperado: oidDe(v.x.texto),
      }));
      const decisiones = lista.map((v) => `${v.huella} → ${v.accion}`);
      const cuantas = (accion) => lista.filter((v) => v.accion === accion).length;
      const secciones = lista.length <= NOMBRADAS_MAX ? decisiones : [`${cuantas('approve')} se aprueban`, `${cuantas('reject')} se rechazan`];
      const r = await RP.proponer({
        clon, archivos, idCorto: `aprendizajes-${sha12(decisiones)}`, secciones, quien, credencial: R.cred(), remote: R.remote(), urlBase: R.urlBase,
        exclusivo, now, fetch, log, aplicarSolo, titulo: `Decisiones sobre los aprendizajes (${lista.length})`,
      });
      if (r && r.codigo === 'cambio') {
        // la propuesta cambió en main: si ya está decidida, sale de la lista; si no, no se pisa
        const archivo = r.archivo || archivos[0].archivo;
        let actual = null;
        try { actual = JSON.parse(r.textoActual); } catch { /* abajo */ }
        if (!isObject(actual) || !['aprobada', 'rechazada'].includes(actual.estado)) return { ok: false, codigo: 'cambio', message: T(idioma, 'aprend.cambio') };
        lista = lista.filter((v) => `${DIR_PROPUESTAS}/${v.huella}.json` !== archivo);
        omitidas.push(path.basename(archivo, '.json'));
        if (!lista.length) return { ok: false, codigo: 'nada_que_enviar', message: T(idioma, 'aprend.nadaQueEnviar') };
        continue;
      }
      if (r && (r.ok || r.codigo === 'aplicado')) return { ok: true, codigo: r.codigo === 'aplicado' ? 'aplicado' : 'abierto', enlace: r.enlace, enviadas: lista.map((v) => v.huella) };
      return { ok: false, codigo: (r && r.codigo) || 'error', message: T(idioma, 'aprend.envio.opsSolo', { motivo: (r && r.message) || '?' }) };
    }
  }

  const solo = ['maintainer'];
  return [
    {
      method: 'GET', path: '/aprendizajes', needs: solo, pestana: { id: 'aprendizajes', titulo: 'Aprendizajes', orden: 26, cuenta: () => cuantasEsperan() }, handler: async (ctx) => {
        const idioma = views.idiomaDe(ctx);
        const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok.replace(/[^A-Za-z0-9_-]/g, '') : '';
        const cuerpo = ctx.quien && ctx.quien.rol === 'maintainer' ? seccion(await modelo(idioma), idioma, tok) : '';
        return { status: 200, tipo: 'text/html; charset=utf-8', cuerpo: views.layout(ctx, T(idioma, 'pestana.aprendizajes'), cuerpo, T(idioma, 'aprend.lede')) };
      },
    },
    { method: 'GET', path: '/api/aprendizajes', needs: solo, handler: async (ctx) => json(200, await modelo(views.idiomaDe(ctx))) },
    {
      method: 'POST', path: '/api/aprendizajes/enviar', needs: solo, handler: async (ctx) => {
        const e = await defensaDeEscritura(cfg, ctx);
        if (e.error) return e.error;
        return enviar(e.body, ctx, views.idiomaDe(ctx));
      },
    },
    { method: 'GET', path: '/aprendizajes/cliente.js', needs: solo, handler: () => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: CLIENTE }) },
  ];
}

// El cliente: marcar Aprobar (con el texto, editable) o Rechazar (con su motivo) en cada tarjeta; las marcas quedan en
// el navegador hasta enviarlas o borrarlas. «Seguir las recomendaciones» marca lo que recomienda la noche, y «Rechazar las
// elegidas» marca varias con un motivo: ninguno envía. Un envío lleva su marca: reenviarlo después de una falla no abre
// otro pedido al perfil. «Volver a proponer al perfil» manda sólo esa propuesta.
const CLIENTE = `(function () {
  var s = document.getElementById('aprendizajes');
  var barra = s && s.querySelector('.a-barra');
  if (!s || !barra) return;
  var GUARDA = 'aprend-marcas', GUARDA_MARCA = 'aprend-marca';
  var t = function (n) { return barra.getAttribute('data-t-' + n) || ''; };
  var marcas = {};
  try { marcas = JSON.parse(localStorage.getItem(GUARDA) || '{}') || {}; } catch (e) { marcas = {}; }
  var vivas = {};
  Array.prototype.forEach.call(s.querySelectorAll('article[data-huella]'), function (c) { vivas[c.getAttribute('data-huella')] = true; });
  Object.keys(marcas).forEach(function (k) { if (!vivas[k] || ['approve', 'reject'].indexOf(marcas[k] && marcas[k].accion) < 0) delete marcas[k]; });
  var enviando = false;
  var elegidas = {};
  var TOPE = Number(barra.getAttribute('data-tope')) || 0;
  var motivoGrupo = barra.querySelector('.a-motivo-grupo');
  var cartaDe = function (k) { return s.querySelector('article[data-huella="' + String(k).replace(/"/g, '') + '"]'); };
  var sePuede = function (c, a) { var b = c.querySelector('button[data-accion="' + a + '"]'); return Boolean(b) && !b.disabled; };
  var recomendadas = function () { return Array.prototype.filter.call(s.querySelectorAll('article[data-recomendada]'), function (c) { return sePuede(c, c.getAttribute('data-recomendada')); }); };
${BUSY.TRABAJANDO}
  var linea = function (x) { return String(x || '').replace(/[\\u0000-\\u001f\\u007f\\u2028\\u2029]+/g, ' ').trim(); };
  function guardar() { try { localStorage.setItem(GUARDA, JSON.stringify(marcas)); } catch (e) { /* sin almacenamiento: se pierde al recargar */ } }
  function marcaDelEnvio() {
    var m = null;
    try { m = localStorage.getItem(GUARDA_MARCA); } catch (e) { m = null; }
    if (!/^[0-9a-f]{32}$/.test(m || '')) {
      var b = new Uint8Array(16); crypto.getRandomValues(b);
      m = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      try { localStorage.setItem(GUARDA_MARCA, m); } catch (e) { /* sin almacenamiento: la marca vale para este envío */ }
    }
    return m;
  }
  function falta() {
    return Object.keys(marcas).some(function (k) { var x = marcas[k]; return x.accion === 'reject' ? !linea(x.motivo) : !linea(x.texto); });
  }
  function pintar() {
    Array.prototype.forEach.call(s.querySelectorAll('article[data-huella]'), function (c) {
      var k = c.getAttribute('data-huella'); var x = marcas[k] || {};
      Array.prototype.forEach.call(c.querySelectorAll('button[data-accion]'), function (b) { b.setAttribute('aria-pressed', x.accion === b.getAttribute('data-accion') ? 'true' : 'false'); });
      var tc = c.querySelector('.a-texto-caja'), mc = c.querySelector('.a-motivo-caja');
      if (tc) { tc.hidden = x.accion !== 'approve'; var ti = tc.querySelector('input'); if (x.accion === 'approve' && typeof x.texto === 'string' && ti.value !== x.texto) ti.value = x.texto; ti.disabled = enviando; }
      if (mc) { mc.hidden = x.accion !== 'reject'; var mi = mc.querySelector('input'); if (x.accion === 'reject' && mi.value !== (x.motivo || '')) mi.value = x.motivo || ''; mi.disabled = enviando; }
      var casilla = c.querySelector('.a-elige'); if (casilla) casilla.checked = Boolean(elegidas[k]);
    });
    var n = Object.keys(marcas).length;
    var sobran = TOPE && n > TOPE ? n - TOPE : 0;
    barra.querySelector('.a-cuenta').textContent = n ? t('elegidas').replace('{n}', n) + (falta() ? ' ' + t('falta-motivo') : '') + (sobran ? ' ' + t('sobran').replace('{n}', sobran) : '') : '';
    barra.querySelector('.a-enviar').disabled = !n || enviando || falta() || sobran > 0;
    var seguir = barra.querySelector('.a-seguir');
    if (seguir) { var r = recomendadas().length; seguir.textContent = seguir.getAttribute('data-t').replace('{n}', r); seguir.disabled = enviando || !r; }
    if (motivoGrupo) {
      var g = Object.keys(elegidas).length;
      barra.querySelector('.a-grupo-cuenta').textContent = g ? t('elegidas-grupo').replace('{n}', g) : '';
      barra.querySelector('.a-rechazar-elegidas').disabled = enviando || !g || !linea(motivoGrupo.value);
    }
    guardar();
  }
  s.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-accion]');
    if (b && !enviando && !b.disabled) {
      var c = b.closest('article[data-huella]'); var k = c.getAttribute('data-huella'); var a = b.getAttribute('data-accion');
      if (marcas[k] && marcas[k].accion === a) delete marcas[k];
      else marcas[k] = a === 'approve' ? { accion: a, texto: c.querySelector('.a-texto').value } : { accion: a, motivo: '' };
      pintar();
      var campo = marcas[k] && c.querySelector(a === 'approve' ? '.a-texto' : '.a-motivo'); if (campo) campo.focus();
      return;
    }
    var r = ev.target.closest('button.a-reproponer');
    if (r && !enviando) mandar([{ huella: r.getAttribute('data-huella'), accion: 'repropose' }], r);
  });
  s.addEventListener('input', function (ev) {
    var c = ev.target.closest('article[data-huella]'); if (!c) return;
    // la casilla «Elegir» también dispara este evento, antes que «change»: repintar acá la desmarcaría
    var esTexto = ev.target.classList.contains('a-texto'); if (!esTexto && !ev.target.classList.contains('a-motivo')) return;
    var k = c.getAttribute('data-huella'); if (!marcas[k]) return;
    if (esTexto) marcas[k].texto = ev.target.value; else marcas[k].motivo = ev.target.value;
    pintar();
  });
  s.addEventListener('change', function (ev) {
    if (!ev.target.classList.contains('a-elige')) return;
    var k = ev.target.closest('article[data-huella]').getAttribute('data-huella');
    if (ev.target.checked) elegidas[k] = true; else delete elegidas[k];
    pintar();
  });
  barra.addEventListener('click', function (ev) {
    if (enviando) return;
    if (ev.target.closest('.a-seguir')) {
      recomendadas().forEach(function (c) {
        var a = c.getAttribute('data-recomendada');
        marcas[c.getAttribute('data-huella')] = a === 'approve' ? { accion: a, texto: c.querySelector('.a-texto').value } : { accion: a, motivo: c.getAttribute('data-porque') || '' };
      });
      pintar();
      return;
    }
    var porRegla = ev.target.closest('.a-elegir-regla');
    if (porRegla && !porRegla.disabled) {
      Array.prototype.forEach.call(s.querySelectorAll('article[data-regla="' + porRegla.getAttribute('data-regla') + '"]'), function (c) { if (c.querySelector('.a-elige')) elegidas[c.getAttribute('data-huella')] = true; });
      pintar();
      return;
    }
    if (ev.target.closest('.a-rechazar-elegidas')) {
      var motivo = linea(motivoGrupo.value);
      if (!motivo) return;
      Object.keys(elegidas).forEach(function (k) { var c = cartaDe(k); if (c && sePuede(c, 'reject')) marcas[k] = { accion: 'reject', motivo: motivo }; });
      elegidas = {}; motivoGrupo.value = '';
      pintar();
    }
  });
  if (motivoGrupo) motivoGrupo.addEventListener('input', pintar);
  barra.querySelector('.a-borrar').addEventListener('click', function () { marcas = {}; pintar(); });
  function mandar(decisiones, boton) {
    var estado = barra.querySelector('.a-estado');
    var cuerpo = { marca: marcaDelEnvio(), decisiones: decisiones };
    var sel = barra.querySelector('.a-paquete'); if (sel && sel.value) cuerpo.paquete = sel.value;
    enviando = true; pintar();
    return trabajando(boton, t('enviando'), function () {
      return fetch('/api/aprendizajes/enviar', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-site-token': s.getAttribute('data-token') || '' }, body: JSON.stringify(cuerpo) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, message: String(r.status) }; }); })
        .then(function (j) {
          enviando = false; estado.textContent = '';
          var quitar = function (k) {
            delete marcas[k]; delete elegidas[k];
            var c = s.querySelector('[data-huella="' + String(k).replace(/"/g, '') + '"] .a-acciones'); if (c) c.parentNode.removeChild(c);
            var carta = cartaDe(k); if (!carta) return;
            var casilla = carta.querySelector('.a-casilla'); if (casilla) casilla.parentNode.removeChild(casilla);
            carta.removeAttribute('data-recomendada'); carta.removeAttribute('data-regla');
          };
          var omitidas = (j && j.omitidas) || [];
          if (j && j.ok) {
            try { localStorage.removeItem(GUARDA_MARCA); } catch (e) { /* nada */ }
            (j.enviadas || []).concat(omitidas).forEach(quitar);
            estado.textContent = ((j.queSigue && j.queSigue.texto) || '') + (omitidas.length ? ' ' + t('omitidas').replace('{n}', omitidas.length) : '');
          } else {
            // otro envío con la marca vieja: la próxima vez sale con una nueva
            if (j && j.codigo === 'marca_otro_envio') { try { localStorage.removeItem(GUARDA_MARCA); } catch (e) { /* nada */ } }
            if (j && j.codigo === 'nada_que_enviar') omitidas.forEach(quitar);
            estado.textContent = t('error').replace('{motivo}', (j && j.message) || '');
          }
          pintar();
          return j;
        }, function (e) { enviando = false; estado.textContent = t('error').replace('{motivo}', String(e && e.message || e)); pintar(); return { ok: false }; });
    }, { muestraSuError: true });
  }
  barra.querySelector('.a-enviar').addEventListener('click', function () {
    var ks = Object.keys(marcas); if (!ks.length || falta()) return;
    mandar(ks.map(function (k) { var x = marcas[k]; return x.accion === 'reject' ? { huella: k, accion: 'reject', motivo: linea(x.motivo) } : { huella: k, accion: 'approve', texto: linea(x.texto) }; }), barra.querySelector('.a-enviar'));
  });
  pintar();
})();
`;

module.exports = { crearRutas, borradorAlArnes, leerPropuestas, LECTURAS, CLIENTE, TECHO };
