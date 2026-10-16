'use strict';
/*
 * org-config.js — EL NÚCLEO COMÚN DE LA CONFIGURACIÓN DE LA ORGANIZACIÓN (story 2.29).
 *
 * Qué resuelve: la configuración de una organización vive en tres archivos de dos repos —`team-repos.json` del perfil
 * del equipo, `operations.json` y `scripts/nightly/dashboard/sources.json` del repo de operaciones— más la lista de
 * paridad (`scripts/ci/product-parity.json`, también en operaciones). Dos pantallas los muestran por secciones: la
 * página local (`harness.js team-config`, scripts/setup/harness/team-config.js) y la pestaña Configuración del sitio
 * (scripts/site/tabs/config.js). Las dos sólo cambian el transporte; lo que es común vive acá:
 *   · LAS SECCIONES: qué parte de qué archivo, de qué repo, con qué lector y con qué identificador corto de rama.
 *   · LOS LECTORES: cada sección se valida con el `parse` del MISMO lector que usa el arnés (team-repos.js,
 *     operations-config.js, la lectura de las declaradas que exporta check-product-parity.js). Acá no hay un
 *     validador propio: `thresholdsParse` sólo recorre `thresholds` y llama a `umbralValido` de common.js (AC 11).
 *   · REVISAR: aplicar el borrador de una sección sobre el archivo tal como está (el resto queda byte por byte,
 *     AC 23) y validar el archivo entero.
 *   · La regla de la capa del equipo (`TEAM_REPOS_SINCE`), la plataforma del remoto, el formato con que se escribe.
 *   · La tabla de versiones por máquina (AC 13) y la vista de paridad por producto (AC 25), que no editan nada.
 *   · EL CÓDIGO DE PANTALLA (`pantalla()`): el JS que la pestaña sirve como `/static/config.js`, sin nada en línea.
 *
 * Este archivo viaja en la imagen del sitio y en la copia fija del programa: no carga nada de `scripts/lib/` por ruta
 * relativa al cargar; los lectores se piden al árbol que se le pasa (`loadReader`) o se inyectan. No nombra ninguna
 * configuración de máquina (T20) ni ningún valor de una organización (T23). Casos: scripts/tests/site-config.test.js.
 */
const fs = require('fs');
const path = require('path');

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Cómo queda escrito un archivo: dos espacios y un salto final (lo que espera el diff de quien revisa el pedido). */
const formatJson = (data) => `${JSON.stringify(data, null, 2)}\n`;

/**
 * Las secciones. `archivo` es la ruta en el repo; `repo` 'perfil' u 'operaciones'; `lector` el archivo de scripts/lib
 * (o de scripts/ci) que la valida; `claves` las claves del archivo que la sección edita (null = el archivo entero);
 * `idCorto` el identificador de la rama del pedido (AC 14); `necesita` claves que el lector tiene que conocer para que
 * esta versión del arnés «sepa leer» la sección (una versión anterior a la story que la crea no las trae).
 */
const SECCIONES = Object.freeze([
  Object.freeze({ id: 'repos', titulo: 'Dónde vive cada repo', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: null, idCorto: 'repos', necesita: [] }),
  Object.freeze({ id: 'responsables', titulo: 'A quién se asignan avisos y pedidos', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['owners', 'reviewers'], idCorto: 'operations', necesita: ['owners'] }),
  Object.freeze({ id: 'despliegues', titulo: 'Despliegues por producto', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['deployments'], idCorto: 'operations', necesita: ['deployments'] }),
  Object.freeze({ id: 'canal', titulo: 'El canal del aviso', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['notify'], idCorto: 'operations', necesita: ['notify'] }),
  Object.freeze({ id: 'personas', titulo: 'Personas y máquinas', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['people'], idCorto: 'operations', necesita: ['people'] }),
  Object.freeze({ id: 'sitio', titulo: 'El sitio: los que mantienen, el buzón, el refresco, la dirección', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['site'], idCorto: 'operations', necesita: ['site'] }),
  Object.freeze({ id: 'umbrales', titulo: 'Umbrales', archivo: 'scripts/nightly/dashboard/sources.json', repo: 'operaciones', lector: 'thresholds', claves: ['thresholds'], idCorto: 'thresholds', necesita: [] }),
  Object.freeze({ id: 'paridad', titulo: 'Paridad: las diferencias declaradas', archivo: 'scripts/ci/product-parity.json', repo: 'operaciones', lector: 'check-product-parity.js', claves: ['diferencias_declaradas'], idCorto: 'parity', necesita: [] }),
  // qué paquetes activa la organización (`packs.default`: all, none o una lista). El perfil se llama team-profile.json; un
  // repo del perfil que todavía usa el nombre de antes se lee y se propone con ése (`archivoViejo`)
  Object.freeze({ id: 'paquetes', titulo: 'Paquetes', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['packs'], idCorto: 'packs', necesita: ['packs'] }),
]);
const seccionPorId = (id) => SECCIONES.find((s) => s.id === id) || null;

/** El lector de una sección, del árbol del arnés; `null` si esta versión no lo trae. `lectores` (inyectados) manda. */
function loadReader(tree, nombre, lectores) {
  if (lectores && Object.prototype.hasOwnProperty.call(lectores, nombre)) return lectores[nombre];
  if (nombre === 'thresholds') return { parse: (t, o) => thresholdsParse(t, o) };
  // el lector de la configuración del arnés (el perfil del equipo): lo ubica pack-pieces.js, que lo carga a su lado
  if (nombre === 'harness-config') {
    const f = path.join(tree, 'scripts', 'lib', 'pack-pieces.js');
    if (!fs.existsSync(f)) return null;
    const r = require(f).configReader();
    return r && typeof r.parse === 'function' ? r : null;
  }
  const carpeta = nombre === 'check-product-parity.js' ? 'ci' : 'lib';
  const f = path.join(tree, 'scripts', carpeta, nombre);
  if (!fs.existsSync(f)) return null;
  const r = require(f);
  if (nombre === 'check-product-parity.js') return r && typeof r.leerDeclaradas === 'function' ? r : null;
  return r && typeof r.parse === 'function' ? r : null;
}

/** ¿El lector de esta versión conoce las claves que la sección edita? (`KEYS` del lector; sin lista, se confía.) */
function lectorSabe(lector, seccion) {
  if (!lector) return false;
  if (seccion.lector === 'check-product-parity.js') return typeof lector.leerDeclaradas === 'function';
  if (!seccion.necesita.length || !Array.isArray(lector.KEYS)) return true;
  return seccion.necesita.every((k) => lector.KEYS.includes(k));
}

// ── la plataforma del remoto ─────────────────────────────────────────────────────────────────────────────────────
/** La plataforma y la dirección del repo, leídas de la dirección del remoto. */
function remoteOf(url) {
  const u = String(url || '').trim();
  let m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (m) return { platform: 'github', org: m[1], repo: m[2], web: `https://github.com/${m[1]}/${m[2]}` };
  m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/.exec(u.replace(/\/\/[^@/]+@/, '//'))
    || /([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/.exec(u.replace(/\/\/[^@/]+@/, '//'));
  if (m) return { platform: 'azure', org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), web: `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}` };
  return { platform: null, web: null };
}

// ── la capa del equipo ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * 🔴 La primera versión del arnés cuya lista cerrada de la capa admite `team-repos.json` (scripts/setup/harness/team.js).
 * Una máquina con una versión anterior rechaza la capa ENTERA si el perfil trae ese archivo. Por eso un cambio a
 * `team-repos.json` se propone SÓLO si el `team-layer.json` del perfil pide al menos esta versión (`requires.harness`).
 */
const TEAM_REPOS_SINCE = '2026.10.13.10';
const versionParts = (v) => { const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d+)$/.exec(String(v || '').trim()); return m ? m.slice(1).map(Number) : null; };
const versionAtLeast = (v, min) => {
  const a = versionParts(v); const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
/**
 * `null` si el perfil (el texto de su team-layer.json) ya pide una versión que admite team-repos.json; si no, el motivo
 * en llano. Es la parte COMÚN del texto: cada transporte suma su cola (la página local, «El archivo quedó guardado en
 * tu clon»; el sitio, nada: no hay clon de la persona).
 */
function profileGateProblem(layerText) {
  let decl;
  try { decl = JSON.parse(String(layerText)); } catch (e) {
    return `no pude leer team-layer.json del perfil (${(e && e.message) || e}), y sin él no sé qué versión del arnés piden las máquinas`;
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  if (m && versionAtLeast(m[1], TEAM_REPOS_SINCE)) return null;
  return `todavía no se puede proponer: el perfil pide «${req || 'nada'}» en team-layer.json, y una máquina con una versión anterior a la ${TEAM_REPOS_SINCE} rechazaría la capa entera si trae team-repos.json. Primero se sube requires.harness a «>= ${TEAM_REPOS_SINCE}» (o más)`;
}

/**
 * `null` si el valor de `packs.default` que se propone lo leen todas las máquinas del perfil; si no, el motivo. `all` y
 * `none` los lee cualquier versión. Una LISTA la lee sólo un arnés que la conoce: el perfil tiene que pedir
 * (`requires.harness` de team-layer.json) al menos la versión del sitio, que sí la conoce. Sin la versión del sitio no se
 * puede saber: no se propone.
 */
function packsListGateProblem({ layerText, versionImagen, valor }) {
  if (!Array.isArray(valor)) return null;
  if (!versionImagen) return 'no sé la versión de este sitio, y una lista de paquetes sólo la lee un arnés que la conoce: se propone a mano';
  let decl;
  try { decl = JSON.parse(String(layerText)); } catch (e) {
    return `no pude leer team-layer.json del perfil (${(e && e.message) || e}), y sin él no sé qué versión del arnés piden las máquinas`;
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  if (m && versionAtLeast(m[1], versionImagen)) return null;
  return `una lista de paquetes sólo la lee un arnés que la conoce: el perfil pide «${req || 'nada'}» en team-layer.json; primero se sube requires.harness a «>= ${versionImagen}» (o más), o se propone all o none`;
}

// ── los umbrales ─────────────────────────────────────────────────────────────────────────────────────────────────
/** `umbralValido` de common.js, pedida al árbol o inyectada; sin árbol, la misma regla (es de cuatro líneas, y se prueba igual). */
function umbralValidoDe(opts) {
  if (opts && typeof opts.umbralValido === 'function') return opts.umbralValido;
  if (opts && opts.tree) {
    try { const c = require(path.join(opts.tree, 'scripts', 'nightly', 'dashboard', 'common.js')); if (typeof c.umbralValido === 'function') return c.umbralValido; } catch { /* abajo */ }
  }
  return (u) => {
    if (!u || typeof u !== 'object') return false;
    if (u.direction === 'mayor_es_mejor') return Number.isFinite(u.ok_min) && Number.isFinite(u.bad_max);
    if (u.direction === 'menor_es_mejor') return Number.isFinite(u.ok_max) && Number.isFinite(u.bad_min);
    return false;
  };
}

/**
 * El lector de la sección Umbrales (AC 11): un envoltorio sobre `umbralValido`, con problemas por ruta
 * `thresholds.<clave>`. Precondición: el archivo está en el formato que escribe el arnés (`formatJson`); si no, la
 * sección es sólo de lectura (`soloLectura: true`), porque reescribirlo cambiaría el archivo entero. Una clave que el
 * arnés (`opts.arnes.thresholds`) no conoce es un problema; una que el archivo ya trae y el arnés ya no usa es un aviso
 * (`avisos`), sin bloquear. `{ ok, data: thresholds, problems, avisos, soloLectura }`.
 */
function thresholdsParse(text, opts = {}) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch (e) {
    return { ok: false, data: null, problems: [{ path: '', message: `no es JSON válido: ${String((e && e.message) || e).split('\n')[0]}` }], avisos: [], soloLectura: true };
  }
  if (!isObject(doc)) return { ok: false, data: null, problems: [{ path: '', message: 'el archivo tiene que ser un objeto JSON' }], avisos: [], soloLectura: true };
  if (formatJson(doc) !== String(text)) return { ok: false, data: null, problems: [{ path: '', message: 'el archivo no está en el formato que escribe el arnés (dos espacios y un salto final): se edita a mano, no desde acá' }], avisos: [], soloLectura: true };
  const th = doc.thresholds === undefined ? {} : doc.thresholds;
  if (!isObject(th)) return { ok: false, data: null, problems: [{ path: 'thresholds', message: 'tiene que ser un objeto { "<clave>": { direction, … } }' }], avisos: [], soloLectura: false };
  const valido = umbralValidoDe(opts);
  const conocidas = opts.arnes && isObject(opts.arnes.thresholds) ? Object.keys(opts.arnes.thresholds) : null;
  const problems = []; const avisos = [];
  for (const [k, u] of Object.entries(th)) {
    if (k.startsWith('__')) continue;
    if (conocidas && !conocidas.includes(k)) {
      // una fila que YA estaba en el archivo y el arnés dejó de usar no bloquea; una que se agrega, sí
      if ((opts.previas || Object.keys(th)).includes(k)) { avisos.push({ path: `thresholds.${k}`, message: 'el arnés ya no usa esta clave' }); continue; }
      problems.push({ path: `thresholds.${k}`, message: 'el arnés no conoce esta clave: no juzga nada con ella' });
      continue;
    }
    if (!valido(u)) problems.push({ path: `thresholds.${k}`, message: 'umbral mal formado: direction (mayor_es_mejor con ok_min y bad_max, o menor_es_mejor con ok_max y bad_min) y sus dos números' });
  }
  return { ok: problems.length === 0, data: problems.length ? null : th, problems, avisos, soloLectura: false };
}

// ── revisar: aplicar el borrador de una sección y validar el archivo entero ──────────────────────────────────────
const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const diaValido = (v) => { const m = typeof v === 'string' ? DIA.exec(v) : null; if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const unAnioDespues = (hoy) => { const d = new Date(`${hoy}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };

/** El documento con el borrador de la sección aplicado: sólo cambian sus claves; lo demás queda como estaba. */
function aplicarSeccion(doc, seccion, borrador) {
  const base = isObject(doc) ? clone(doc) : {};
  if (seccion.claves === null) {
    // el archivo entero, pero los comentarios `__` del archivo se conservan si el borrador no los trae
    const out = clone(isObject(borrador) ? borrador : {});
    for (const k of Object.keys(base)) if (k.startsWith('__') && out[k] === undefined) out[k] = base[k];
    return out;
  }
  const b = isObject(borrador) ? borrador : {};
  for (const k of seccion.claves) { if (b[k] === undefined) delete base[k]; else base[k] = clone(b[k]); }
  return base;
}

/** Las claves del borrador que la sección no edita (una clave que no tiene campo en la pantalla va arriba). */
function clavesAjenas(seccion, borrador) {
  if (!isObject(borrador) || seccion.claves === null) return [];
  return Object.keys(borrador).filter((k) => !seccion.claves.includes(k) && !k.startsWith('__'));
}

/** El texto de un archivo como objeto, o null. */
const docDe = (text) => { if (text === null || text === undefined) return null; try { const v = JSON.parse(String(text)); return isObject(v) ? v : null; } catch { return null; } };

/**
 * Revisar un cambio (AC 6, 11, 23, 26): `{ ok, problems: [{ path, message, sinCampo? }], texto, aviso?, avisos? }`.
 * `texto` es el archivo entero tal como se propondría (dos espacios y salto final) si validó. `texto` de entrada es el
 * archivo actual (null si no existe todavía). Los `lectores` van por nombre de archivo (`operations-config.js`…).
 */
function revisar({ seccion, texto, borrador, lectores = {}, arnes = null, hoy = null, tree = null, umbralValido = null }) {
  const s = typeof seccion === 'string' ? seccionPorId(seccion) : seccion;
  if (!s) return { ok: false, problems: [{ path: '', message: 'sección desconocida', sinCampo: true }], texto: null };
  const actual = docDe(texto);
  if (texto !== null && texto !== undefined && actual === null) return { ok: false, problems: [{ path: '', message: `${s.archivo} no es un objeto JSON legible: se corrige a mano`, sinCampo: true }], texto: null };

  if (s.id === 'umbrales') {
    const previas = actual && isObject(actual.thresholds) ? Object.keys(actual.thresholds) : [];
    const base = texto === null || texto === undefined ? { sources: [], thresholds: {} } : actual;
    const salida = formatJson(aplicarSeccion(base, s, { thresholds: isObject(borrador) ? borrador : {} }));
    const r = thresholdsParse(salida, { arnes, previas, tree, umbralValido });
    return { ok: r.ok, problems: r.problems, avisos: r.avisos, texto: r.ok ? salida : null, soloLectura: r.soloLectura };
  }

  if (s.id === 'paridad') {
    const lector = lectores['check-product-parity.js'] || loadReader(tree || '', 'check-product-parity.js', lectores);
    if (!lector) return { ok: false, problems: [{ path: '', message: 'esta versión del arnés todavía no sabe leer las diferencias declaradas', sinCampo: true }], texto: null };
    if (!actual) return { ok: false, problems: [{ path: '', message: 'la lista de paridad no está en el repo de operaciones', sinCampo: true }], texto: null };
    const dia = hoy || new Date().toISOString().slice(0, 10);
    const b = isObject(borrador) ? borrador : {};
    const lista = Array.isArray(actual.diferencias_declaradas) ? actual.diferencias_declaradas : [];
    const i = lista.findIndex((d) => isObject(d) && d.grupo === b.grupo && d.rasgo === b.rasgo);
    if (i < 0) return { ok: false, problems: [{ path: 'diferencias_declaradas', message: `no hay una diferencia declarada ${b.grupo}/${b.rasgo}`, sinCampo: true }], texto: null };
    const nueva = clone(actual);
    let aviso = null;
    if (b.accion === 'close') {
      nueva.diferencias_declaradas.splice(i, 1);
      aviso = 'si la diferencia sigue en los pipelines, vuelve a aparecer como divergencia la noche siguiente a la del merge';
    } else if (b.accion === 'renew') {
      const problems = [];
      if (!diaValido(b.revision)) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: 'la fecha de revisión tiene que ser un día con la forma AAAA-MM-DD' });
      else if (b.revision <= dia) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: `la fecha de revisión tiene que ser posterior a hoy (${dia})` });
      else if (b.revision > unAnioDespues(dia)) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: `la fecha de revisión es como mucho a un año (${unAnioDespues(dia)})` });
      if (typeof b.motivo !== 'string' || !b.motivo.trim()) problems.push({ path: `diferencias_declaradas.${i}.motivo`, message: 'el motivo es obligatorio: por qué sigue valiendo la diferencia' });
      if (problems.length) return { ok: false, problems, texto: null };
      const d = nueva.diferencias_declaradas[i];
      nueva.diferencias_declaradas[i] = { ...d, motivo: b.motivo.trim(), fecha: dia, revision: b.revision };
    } else return { ok: false, problems: [{ path: '', message: 'la acción tiene que ser renew (renovar) o close (cerrar)', sinCampo: true }], texto: null };
    // la validación es la del control (P7): la misma lectura que juzga de noche
    const r = lector.leerDeclaradas(nueva, dia);
    if (r.problemas && r.problemas.length) return { ok: false, problems: r.problemas.map((p) => ({ path: p.path || 'diferencias_declaradas', message: p.message })), texto: null };
    return { ok: true, problems: [], texto: formatJson(nueva), aviso };
  }

  const lector = lectores[s.lector] || loadReader(tree || '', s.lector, lectores);
  if (!lectorSabe(lector, s)) return { ok: false, problems: [{ path: '', message: `esta versión del arnés todavía no sabe leer ${s.archivo}${s.claves ? ` → ${s.claves.join(', ')}` : ''}`, sinCampo: true }], texto: null };
  const ajenas = clavesAjenas(s, borrador);
  // un archivo que todavía no existe nace con lo mínimo que su lector pide (el perfil del equipo, vacío)
  const base = actual || (s.archivo === 'operations.json' ? { version: 1, owners: { default: '' } } : s.id === 'paquetes' ? {} : { version: 1 });
  let doc = aplicarSeccion(base, s, borrador);
  // lo que el borrador trae fuera de la sección se pone igual: el lector lo rechaza con su ruta, y eso va arriba
  for (const k of ajenas) doc[k] = clone(borrador[k]);
  const salida = formatJson(doc);
  const r = lector.parse(salida);
  const problems = (r.problems || []).map((p) => ({ ...p, sinCampo: ajenas.some((k) => p.path === k || String(p.path).startsWith(`${k}.`)) || p.path === '' }));
  return { ok: Boolean(r.ok) && problems.length === 0, problems, texto: r.ok && problems.length === 0 ? salida : null };
}

// ── las versiones de cada máquina (AC 13) ────────────────────────────────────────────────────────────────────────
const SIN_NOTICIAS_DIAS = 14;
const CARPETA_CON_FECHA = /^v(\d{4})(\d{2})(\d{2})T\d{6}\d{3}Z$/;
/**
 * Del espejo del buzón (`<espejo>/<máquina>/registros[/v<AAAAMMDDTHHMMSSmmmZ>]/place.json`), una fila por máquina:
 * `{ maquina, version, dia, diaTexto, estado: 'al_dia' | 'atrasada' | 'sin_noticias' | 'no_medido', texto }`. La
 * referencia es la versión de la imagen del sitio; sin ella, todas «no medido». Sin red.
 */
function versionesDeMaquinas({ espejo, versionImagen, ahora = Date.now(), personas = null }) {
  let maquinas = [];
  try { maquinas = fs.readdirSync(espejo, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch { return []; }
  const out = [];
  for (const m of maquinas) {
    const reg = path.join(espejo, m, 'registros');
    let carpetas = [];
    try { carpetas = fs.readdirSync(reg).filter((n) => CARPETA_CON_FECHA.test(n) && fs.existsSync(path.join(reg, n, 'place.json'))).sort(); } catch (e) {
      // sin registros no es una máquina; con registros que no se pueden leer, sí: sale «no medido», no desaparece
      if (e && e.code !== 'ENOENT') { out.push({ maquina: m, persona: personas && personas[m] ? personas[m] : null, version: null, dia: null, diaTexto: 'sin fecha', estado: 'no_medido', texto: `no medido: sus registros no se pudieron leer (${e.code || 'error'})` }); continue; }
    }
    let ruta = null; let dia = null;
    if (carpetas.length) { const c = carpetas[carpetas.length - 1]; ruta = path.join(reg, c, 'place.json'); const d = CARPETA_CON_FECHA.exec(c); dia = `${d[1]}-${d[2]}-${d[3]}`; }
    else if (fs.existsSync(path.join(reg, 'place.json'))) ruta = path.join(reg, 'place.json');
    if (!ruta) continue;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { doc = null; }
    const version = doc && isObject(doc.install) && typeof doc.install.version === 'string' ? doc.install.version : null;
    const persona = personas && typeof personas === 'object' && personas[m] ? personas[m] : null;
    const fila = { maquina: m, persona, version, dia, diaTexto: dia || 'sin fecha', estado: 'no_medido', texto: '' };
    if (!versionImagen) { fila.estado = 'no_medido'; fila.texto = 'no medido: la imagen no declara su versión'; }
    else if (!doc) { fila.texto = 'no medido: su place.json no se pudo leer'; }
    else if (!version) { fila.texto = 'no medido: su place.json no declara la versión del arnés'; }
    else if (dia && (Date.parse(`${dia}T00:00:00Z`) < ahora - SIN_NOTICIAS_DIAS * 86400000)) { fila.estado = 'sin_noticias'; fila.texto = `sin noticias desde ${dia}`; }
    else if (versionAtLeast(version, versionImagen)) { fila.estado = 'al_dia'; fila.texto = 'al día'; }
    else if (versionParts(version)) { fila.estado = 'atrasada'; fila.texto = `atrasada (la imagen puede estar atrasada: compara contra ${versionImagen})`; }
    else { fila.texto = `no medido: «${version}» no tiene forma de versión`; }
    out.push(fila);
  }
  return out;
}

// ── la paridad por producto (AC 25) ──────────────────────────────────────────────────────────────────────────────
/**
 * La vista de la sección Paridad: por producto de la lista, agrupado por su grupo, los rasgos en que queda del lado
 * distinto, los declarados que lo amparan y los vencidos. `lista` es product-parity.json (o null); `resultado`, el
 * archivo de hoy (o null). La definición (grupos y rasgos) se muestra y no se edita (P3).
 */
function paridadPorProducto({ lista, resultado, hoy, resultadoIlegible = false }) {
  if (!isObject(lista)) return { estado: 'sin_lista', texto: 'la lista de paridad no está en el repo de operaciones', productos: [], definicion: null };
  if (typeof lista.sin_productos === 'string' && lista.sin_productos.trim()) return { estado: 'sin_productos', texto: `sin productos (${lista.sin_productos.trim()})`, productos: [], definicion: null };
  const grupos = isObject(lista.grupos) ? lista.grupos : {};
  const definicion = { grupos: clone(grupos), rasgos: Array.isArray(lista.rasgos) ? clone(lista.rasgos) : [] };
  const porProducto = new Map();
  const rutaDe = new Map();   // ruta → { producto, grupo }
  for (const [grupo, def] of Object.entries(grupos)) {
    const repos = Array.isArray(def) ? def : (isObject(def) && Array.isArray(def.repos) ? def.repos : []);
    for (const r of repos) {
      if (!isObject(r) || typeof r.ruta !== 'string') continue;
      const producto = typeof r.producto === 'string' && r.producto ? r.producto : r.ruta;
      if (!porProducto.has(producto)) porProducto.set(producto, { producto, grupos: new Set(), rutas: new Set(), faltan: [], tiene: [], declaradas: [], vencidas: [] });
      const p = porProducto.get(producto); p.grupos.add(grupo); p.rutas.add(r.ruta);
      // el control nombra cada repo en divergencias[] por su producto, o «producto (ruta)» si el grupo lo repite
      // (nombresDelGrupo de check-product-parity.js): se busca por los tres nombres (pase adversarial de la 2.29)
      for (const k of [r.ruta, producto, `${producto} (${r.ruta})`]) if (!rutaDe.has(`${grupo}\u0000${k}`)) rutaDe.set(`${grupo}\u0000${k}`, { producto, grupo });
    }
  }
  const estado = resultadoIlegible ? 'resultado_ilegible' : !isObject(resultado) ? 'sin_resultado' : (resultado.fecha && hoy && resultado.fecha !== hoy ? 'sin_resultado' : (resultado.estado || 'no_medido'));
  if (isObject(resultado) && estado !== 'sin_resultado') {
    for (const d of (Array.isArray(resultado.divergencias) ? resultado.divergencias : [])) {
      if (!isObject(d)) continue;
      const tienen = Array.isArray(d.tienen) ? d.tienen : []; const noTienen = Array.isArray(d.no_tienen) ? d.no_tienen : [];
      const item = { grupo: d.grupo, rasgo: d.rasgo, que: d.que || d.rasgo };
      // el lado distinto: lo que le falta cuando está en no_tienen y no son la mayoría los que tampoco lo tienen; lo que
      // tiene cuando la mayoría no. Con empate no hay mayoría: los dos lados se muestran
      const de = (nombre) => rutaDe.get(`${d.grupo}\u0000${nombre}`);
      for (const n of noTienen) { const x = de(n); if (x && tienen.length >= noTienen.length) porProducto.get(x.producto).faltan.push(item); }
      for (const n of tienen) { const x = de(n); if (x && tienen.length <= noTienen.length) porProducto.get(x.producto).tiene.push(item); }
    }
    const aplicar = (lista2, campo) => {
      for (const d of (Array.isArray(lista2) ? lista2 : [])) {
        if (!isObject(d)) continue;
        for (const p of porProducto.values()) if (p.grupos.has(d.grupo)) p[campo].push({ grupo: d.grupo, rasgo: d.rasgo, revision: d.revision || null });
      }
    };
    aplicar(resultado.declaradas, 'declaradas'); aplicar(resultado.vencidas, 'vencidas');
  }
  const textos = { medido: 'medido', parcial: 'parcial: la noche no pudo medir todos los repos', no_medido: 'no medido', sin_productos: 'sin productos', sin_resultado: 'no medido: la noche no dejó la paridad', resultado_ilegible: 'no medido: no se pudo leer el resultado de hoy de la paridad' };
  return {
    estado, texto: textos[estado] || estado, fecha: isObject(resultado) ? resultado.fecha || null : null, definicion,
    productos: [...porProducto.values()].map((p) => ({ ...p, grupos: [...p.grupos], rutas: [...p.rutas] })),
    declaradas: Array.isArray(lista.diferencias_declaradas) ? clone(lista.diferencias_declaradas) : [],
  };
}

// ── el pedido ────────────────────────────────────────────────────────────────────────────────────────────────────
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const ramaDePropuesta = (idCorto, now = new Date()) => `team-config/${idCorto}-${stamp(now)}`;
const tituloDePropuesta = (archivo) => `Configuración de la organización: ${archivo}`;
const cuerpoDePropuesta = (secciones, quien) => `Secciones cambiadas: ${(secciones || []).join(', ') || '(sin nombrar)'}. Pedido por ${quien} desde el sitio.`;

// ── el código de pantalla ────────────────────────────────────────────────────────────────────────────────────────
/**
 * El JS de la pestaña Configuración, servido por el sitio como `/static/config.js` (AC 4): un solo archivo, sin nada de
 * afuera, con `textContent` siempre (lo que trae un archivo —un nombre, un motivo del lector— no puede volverse
 * marcado). Lee el token de doble envío del `<meta name="site-token">` que arma el servidor y lo manda en cada
 * escritura en `X-Site-Token` (AC 3). Habla con /api/config (leer), /api/config/revisar, /api/config/stages y
 * /api/config/proponer. «Descargar el archivo» no es una ruta: arma la descarga con el texto que «Revisar» devolvió.
 */
function pantalla() {
  return String.raw`'use strict';
// config.js — la pestaña Configuración del sitio de la organización (story 2.29). Lo sirve scripts/lib/org-config.js.
(function () {
  var meta = document.querySelector('meta[name="site-token"]');
  var TOKEN = meta ? meta.getAttribute('content') : '';
  var app = document.getElementById('config-app');
  if (!app) return;
  function el(tag, attrs) {
    var e = document.createElement(tag); attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) { var v = attrs[k]; if (k === 'text') e.textContent = v; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]);
    return e;
  }
  function api(ruta, cuerpo) {
    var o = { method: cuerpo ? 'POST' : 'GET', headers: {}, credentials: 'same-origin' };
    if (cuerpo) { o.headers['Content-Type'] = 'application/json'; o.headers['X-Site-Token'] = TOKEN; o.body = JSON.stringify(cuerpo); }
    // siempre termina con un mensaje: un pedido cortado no deja la nota en «proponiendo…» para siempre
    return fetch('/api/config' + ruta, o).then(function (r) { return r.json().catch(function () { return { ok: false, message: 'respuesta ' + r.status }; }).then(function (j) { if (r.status >= 400 && j && !j.message) j.message = 'respuesta ' + r.status; return j; }); })
      .catch(function (e) { return { ok: false, message: 'no pude hablar con el sitio (' + (e && e.message ? e.message : 'sin respuesta') + '): si estabas proponiendo, recargá y mirá si el pedido se abrió antes de repetirlo' }; });
  }
  var copia = function (v) { return JSON.parse(JSON.stringify(v)); };
  var S = { secciones: [], borradores: {}, problemas: {}, avisos: {}, notas: {}, textos: {}, extras: null };

  function problemasEn(lista, p) { return (lista || []).filter(function (x) { return x.path === p; }); }
  function campo(label, valor, onInput, p, problemas, attrs) {
    var mios = problemasEn(problemas, p);
    var input = el('input', Object.assign({ value: valor == null ? '' : String(valor), oninput: function (e) { onInput(e.target.value); }, 'data-path': p }, attrs || {}));
    if (mios.length) input.className = 'bad';
    var box = el('div', { class: 'campo' }, el('label', { text: label }), input);
    mios.forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function listaDeTextos(label, lista, set, p, problemas, nombre) {
    var box = el('div', {}, el('label', { text: label }));
    (lista || []).forEach(function (v, i) {
      box.appendChild(el('div', { class: 'fila' }, campo(nombre, v, function (nv) { lista[i] = nv; set(lista); }, p + '.' + i, problemas), el('button', { class: 'sec', type: 'button', text: 'Quitar', onclick: function () { lista.splice(i, 1); set(lista); render(); } })));
    });
    box.appendChild(el('button', { class: 'sec', type: 'button', text: 'Agregar', onclick: function () { lista.push(''); set(lista); render(); } }));
    problemasEn(problemas, p).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function repoFila(titulo, repo, set, p, problemas) {
    var r = repo || { platform: 'azure', org: '', project: '', repo: '' };
    var plat = el('select', { 'data-path': p + '.platform', onchange: function (e) { var v = e.target.value; var nr = { platform: v, org: r.org || '', repo: r.repo || '' }; if (v === 'azure') nr.project = r.project || ''; set(nr); render(); } },
      el('option', { value: 'azure', text: 'Azure DevOps' }), el('option', { value: 'github', text: 'GitHub' }));
    plat.value = r.platform === 'github' ? 'github' : 'azure';
    var upd = function (k) { return function (v) { r[k] = v; set(r); }; };
    return el('div', { class: 'fila' }, el('div', { class: 'k', text: titulo }), el('div', {}, el('label', { text: 'plataforma' }), plat),
      campo('organización', r.org, upd('org'), p + '.org', problemas), r.platform === 'github' ? el('div', {}) : campo('proyecto', r.project, upd('project'), p + '.project', problemas), campo('repo', r.repo, upd('repo'), p + '.repo', problemas));
  }

  // ── los editores por sección ──
  var REPO_SLOTS = [['public', 'El arnés público'], ['profile', 'El perfil del equipo'], ['operations', 'Las operaciones'], ['maintainers', 'El mantenimiento (opcional)']];
  function editorRepos(s, d, pr) {
    var box = el('div', {});
    REPO_SLOTS.forEach(function (par) { var k = par[0]; if (k === 'maintainers' && !d[k]) { box.appendChild(el('button', { class: 'sec', type: 'button', text: 'Agregar: el mantenimiento', onclick: function () { d[k] = { platform: 'azure', org: '', project: '', repo: '' }; render(); } })); return; } box.appendChild(repoFila(par[1], d[k], function (v) { d[k] = v; }, k, pr)); });
    return box;
  }
  function editorResponsables(s, d, pr) {
    d.owners = d.owners || { default: '' }; d.reviewers = d.reviewers || {};
    var box = el('div', {}, campo('Responsable por defecto (la identidad en la plataforma)', d.owners.default, function (v) { d.owners.default = v; }, 'owners.default', pr));
    var byp = d.owners.by_project || {};
    Object.keys(byp).forEach(function (name) { box.appendChild(el('div', { class: 'fila' }, campo('proyecto', name, function () {}, 'owners.by_project', pr, { disabled: 'disabled' }), campo('responsable', byp[name], function (v) { byp[name] = v; }, 'owners.by_project.' + name, pr), el('button', { class: 'sec', type: 'button', text: 'Quitar', onclick: function () { delete byp[name]; if (!Object.keys(byp).length) delete d.owners.by_project; render(); } }))); });
    var np = el('input', { placeholder: 'nombre del proyecto' });
    box.appendChild(el('div', { class: 'fila' }, np, el('button', { class: 'sec', type: 'button', text: 'Agregar proyecto', onclick: function () { var v = np.value.trim(); if (!v) return; d.owners.by_project = d.owners.by_project || {}; d.owners.by_project[v] = ''; render(); } })));
    box.appendChild(listaDeTextos('Revisan los pedidos de dependencias', d.reviewers.dependencies = d.reviewers.dependencies || [], function (l) { d.reviewers.dependencies = l; }, 'reviewers.dependencies', pr, 'identidad'));
    box.appendChild(listaDeTextos('Revisan los del vigilante', d.reviewers.watcher = d.reviewers.watcher || [], function (l) { d.reviewers.watcher = l; }, 'reviewers.watcher', pr, 'identidad'));
    return box;
  }
  function editorSitio(s, d, pr) {
    d.site = d.site || {};
    var site = d.site;
    var box = el('div', {}, listaDeTextos('Los que mantienen (correos)', site.maintainers = site.maintainers || [], function (l) { site.maintainers = l; }, 'site.maintainers', pr, 'correo'));
    box.appendChild(campo('Refresco (minutos, 5 a 120)', site.refresh_minutes, function (v) { site.refresh_minutes = v === '' ? undefined : Number(v); }, 'site.refresh_minutes', pr));
    if (s.campos && s.campos.url) box.appendChild(campo('La dirección del sitio', site.url, function (v) { site.url = v || undefined; }, 'site.url', pr));
    var mb = site.mailbox || {};
    box.appendChild(el('h4', { text: 'El buzón de corridas (sin credenciales: esas viven en la plataforma)' }));
    ['provider', 'account', 'container'].forEach(function (k) { box.appendChild(campo(k, mb[k], function (v) { site.mailbox = site.mailbox || {}; site.mailbox[k] = v; }, 'site.mailbox.' + k, pr)); });
    if (s.avisoLista) box.appendChild(el('div', { class: 'aviso', text: s.avisoLista }));
    return box;
  }
  function editorGenerico(s, d, pr, clave) {
    // una sección cuyo lector llega con otra story (despliegues, canal): se edita como JSON de esa clave
    var ta = el('textarea', { rows: '8', 'data-path': clave, oninput: function (e) { try { d[clave] = JSON.parse(e.target.value); S.notas[s.id] = null; } catch (err) { S.notas[s.id] = { ok: false, text: clave + ': ' + err.message }; } } });
    ta.value = JSON.stringify(d[clave] === undefined ? {} : d[clave], null, 2);
    var box = el('div', {}, el('label', { text: clave + ' (JSON)' }), ta);
    problemasEn(pr, clave).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function editorDespliegues(s, d, pr) {
    var box = editorGenerico(s, d, pr, 'deployments');
    var producto = el('input', { placeholder: 'producto' });
    var sel = el('input', { placeholder: 'pipeline (número de la definición, o dueño/repo del producto)' });
    var nombrePipeline = el('input', { placeholder: 'proyecto/nombre exacto del pipeline (Azure)' });
    box.appendChild(el('div', { class: 'fila' }, producto, nombrePipeline));
    var nota = el('div', {});
    box.appendChild(el('div', { class: 'fila' }, sel, el('button', { class: 'sec', type: 'button', text: 'Proponer los stages de este pipeline', onclick: function () {
      api('/stages', { pipeline: sel.value }).then(function (r) {
        nota.replaceChildren();
        if (!r.ok) { nota.appendChild(el('div', { class: 'err', text: r.message })); return; }
        var ul = el('ul', {});
        (r.propuestos || []).forEach(function (st) { ul.appendChild(el('li', {}, el('span', { text: st.identificador + ' (propuesto' + (st.nombre ? ', se ve como «' + st.nombre + '»' : '') + ') ' }), el('button', { class: 'sec', type: 'button', text: 'staging', onclick: function () { confirmarStage(d, producto.value, sel.value, nombrePipeline.value, 'staging', st.identificador); } }), el('button', { class: 'sec', type: 'button', text: 'production', onclick: function () { confirmarStage(d, producto.value, sel.value, nombrePipeline.value, 'production', st.identificador); } }))); });
        nota.appendChild(el('div', { class: 'muted', text: 'nada se guarda hasta confirmar cada stage; después, Revisar y Proponer' }));
        nota.appendChild(ul);
      });
    } })), nota);
    return box;
  }
  // confirmar un stage arma la entrada en la forma del lector de la 2.22: Azure { pipeline, stages: [id] }; GitHub { repo, environment }
  function confirmarStage(d, producto, pipeline, nombre, lado, id) {
    if (!producto) return;
    d.deployments = d.deployments || {}; var esGithub = /\//.test(pipeline) && !/^\d+$/.test(pipeline);
    d.deployments.provider = d.deployments.provider || (esGithub ? 'github' : 'azure');
    var prods = d.deployments.products = d.deployments.products || {}; var p = prods[producto] = prods[producto] || {}; var lista = p[lado] = p[lado] || [];
    if (esGithub) lista.push({ repo: pipeline, environment: id });
    else { var ent = lista.filter(function (e) { return e.pipeline === nombre; })[0]; if (ent) { if (ent.stages.indexOf(id) < 0) ent.stages.push(id); } else lista.push({ pipeline: nombre, stages: [id] }); }
    render();
  }
  function editorPersonas(s, d, pr) {
    d.people = d.people || {};
    var box = el('div', {});
    var ex = (s.extras || {});
    box.appendChild(el('h4', { text: 'Máquinas por confirmar' }));
    if (ex.vencido) box.appendChild(el('div', { class: 'err', text: ex.vencido }));
    if (ex.ultimoBueno) box.appendChild(el('div', { class: 'aviso', text: ex.ultimoBueno }));
    (ex.porConfirmar || []).forEach(function (m) {
      var persona = el('input', { value: m.correo || '', placeholder: 'correo de la persona' });
      box.appendChild(el('div', { class: 'fila' }, el('span', { class: 'k', text: m.maquina }), el('span', { text: (m.correo ? 'informa ' + m.correo : 'no informa correo') + ' · ' + (m.dia || 'sin día') + ' · ' + (m.corridas == null ? '?' : m.corridas) + ' corridas' }), persona,
        el('button', { type: 'button', text: 'Confirmar', onclick: function () { revisarSeccion(s, { accion: 'confirm', maquina: m.maquina, person: persona.value, people: d.people }); } })));
    });
    box.appendChild(el('h4', { text: 'Confirmadas' }));
    var machines = d.people.machines || {};
    Object.keys(machines).forEach(function (m) { var e = machines[m]; box.appendChild(el('div', { class: 'fila' }, el('span', { class: 'k', text: m }), el('span', { text: (e.person || '') + ' · confirmada por ' + (e.confirmed_by || '') + ' el ' + (e.confirmed_on || '') }), el('button', { class: 'sec', type: 'button', text: 'Quitar', onclick: function () { delete machines[m]; if (!Object.keys(machines).length) delete d.people.machines; render(); } }))); problemasEn(pr, 'people.machines.' + m).concat(problemasEn(pr, 'people.machines.' + m + '.confirmed_on')).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); }); });
    box.appendChild(el('h4', { text: 'Dónde trabaja cada persona' }));
    (ex.personas || []).forEach(function (p) {
      var fix = (d.people.projects || {})[p.correo] || {};
      var agregar = el('input', { placeholder: 'producto' });
      box.appendChild(el('div', { class: 'fila' }, el('span', { class: 'k', text: p.correo }), el('span', { text: 'deducido: ' + ((p.deducidos || []).join(', ') || 'nada') + (p.caida ? ' · todas sus máquinas caídas' : '') + ' · agrega: ' + ((fix.add || []).join(', ') || '—') + ' · quita: ' + ((fix.remove || []).join(', ') || '—') }), agregar,
        el('button', { class: 'sec', type: 'button', text: 'Agregar', onclick: function () { var v = agregar.value.trim(); if (!v) return; d.people.projects = d.people.projects || {}; var f = d.people.projects[p.correo] = d.people.projects[p.correo] || {}; f.add = f.add || []; f.add.push(v); render(); } }),
        el('button', { class: 'sec', type: 'button', text: 'Quitar', onclick: function () { var v = agregar.value.trim(); if (!v) return; d.people.projects = d.people.projects || {}; var f = d.people.projects[p.correo] = d.people.projects[p.correo] || {}; f.remove = f.remove || []; f.remove.push(v); render(); } })));
    });
    return box;
  }
  function editorUmbrales(s, d, pr) {
    var box = el('div', {});
    Object.keys(d).forEach(function (k) {
      var u = d[k] || {};
      var fila = el('div', { class: 'fila' }, el('span', { class: 'k', text: k }));
      ['direction', 'ok_min', 'bad_max', 'ok_max', 'bad_min'].forEach(function (c) { fila.appendChild(campo(c, u[c], function (v) { d[k] = d[k] || {}; if (v === '') delete d[k][c]; else d[k][c] = c === 'direction' ? v : Number(v); }, 'thresholds.' + k + '.' + c, pr)); });
      problemasEn(pr, 'thresholds.' + k).forEach(function (x) { fila.appendChild(el('div', { class: 'err', text: x.message })); });
      (S.avisos[s.id] || []).filter(function (a) { return a.path === 'thresholds.' + k; }).forEach(function (a) { fila.appendChild(el('div', { class: 'aviso', text: a.message })); });
      box.appendChild(fila);
    });
    return box;
  }
  function editorParidad(s, d, pr) {
    var box = el('div', {});
    var v = s.vista || {};
    box.appendChild(el('p', { class: 'muted', text: 'Estado del archivo de hoy: ' + (v.texto || 'no medido') + (v.fecha ? ' (' + v.fecha + ')' : '') }));
    (v.productos || []).forEach(function (p) {
      box.appendChild(el('div', { class: 'fila' }, el('span', { class: 'k', text: p.producto + ' (' + p.grupos.join(', ') + ')' }),
        el('span', { text: 'le falta: ' + (p.faltan.map(function (x) { return x.que; }).join('; ') || '—') + ' · tiene y la mayoría no: ' + (p.tiene.map(function (x) { return x.que; }).join('; ') || '—') + ' · declaradas: ' + (p.declaradas.map(function (x) { return x.rasgo + ' hasta ' + x.revision; }).join('; ') || '—') + ' · vencidas: ' + (p.vencidas.map(function (x) { return x.rasgo + ' (' + x.revision + ')'; }).join('; ') || '—') })));
    });
    box.appendChild(el('h4', { text: 'Las diferencias declaradas' }));
    (v.declaradas || []).forEach(function (dcl) {
      var fecha = el('input', { placeholder: 'AAAA-MM-DD' }); var motivo = el('input', { placeholder: 'motivo' });
      box.appendChild(el('div', { class: 'fila' }, el('span', { class: 'k', text: dcl.grupo + '/' + dcl.rasgo }), el('span', { text: (dcl.motivo || '') + ' · hasta ' + (dcl.revision || '') }), fecha, motivo,
        el('button', { class: 'sec', type: 'button', text: 'Renovar', onclick: function () { revisarSeccion(s, { accion: 'renew', grupo: dcl.grupo, rasgo: dcl.rasgo, revision: fecha.value, motivo: motivo.value }); } }),
        el('button', { class: 'sec', type: 'button', text: 'Cerrar', onclick: function () { revisarSeccion(s, { accion: 'close', grupo: dcl.grupo, rasgo: dcl.rasgo }); } })));
    });
    if (v.definicion) box.appendChild(el('details', {}, el('summary', { text: 'Grupos y rasgos (se editan en el archivo, no acá)' }), el('pre', { text: JSON.stringify(v.definicion, null, 2) })));
    return box;
  }
  function editorPaquetes(s, d, pr) {
    var box = el('div', {});
    var ex = s.extras || {};
    box.appendChild(el('p', { class: 'muted', text: 'Instalados en esta versión: ' + ((ex.instalados || []).join(', ') || 'ninguno') + ' · activos para la organización: ' + ((ex.activos || []).join(', ') || 'ninguno') }));
    d.packs = d.packs || {};
    var actual = Array.isArray(d.packs.default) ? d.packs.default.join(', ') : (d.packs.default || '');
    box.appendChild(el('div', { class: 'fila' }, el('span', { class: 'k', text: 'packs.default' }),
      campo('valor (all, none o la lista separada por comas)', actual, function (v) {
        var t = String(v).trim();
        if (t === '') delete d.packs.default;
        else d.packs.default = (t === 'all' || t === 'none') ? t : t.split(',').map(function (x) { return x.trim(); });
      }, 'packs.default', pr)));
    return box;
  }
  var EDITORES = { paquetes: editorPaquetes, repos: editorRepos, responsables: editorResponsables, despliegues: editorDespliegues, canal: function (s, d, pr) { return editorGenerico(s, d, pr, 'notify'); }, personas: editorPersonas, sitio: editorSitio, umbrales: editorUmbrales, paridad: editorParidad };

  function revisarSeccion(s, borrador) {
    return api('/revisar', { seccion: s.id, borrador: borrador === undefined ? S.borradores[s.id] : borrador }).then(function (r) {
      S.problemas[s.id] = r.problems || []; S.avisos[s.id] = r.avisos || [];
      if (r.borrador) S.borradores[s.id] = r.borrador;
      S.textos[s.id] = r.ok ? r.texto : null;
      S.notas[s.id] = r.ok ? { ok: true, text: 'Está bien escrito.' + (r.aviso ? ' ' + r.aviso : '') + (r.advertencia ? ' ' + r.advertencia : '') } : { ok: false, text: r.message || 'Hay que corregir lo marcado.' };
      render();
      return r;
    });
  }
  function descargar(s) {
    var texto = S.textos[s.id]; if (!texto) return;
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texto], { type: 'application/json' })); a.download = s.archivo.split('/').pop(); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function seccion(s) {
    var sec = el('section', { class: 'q', id: 'seccion-' + s.id }, el('div', { class: 'q-head' }, el('h2', { text: s.titulo })), el('p', { class: 'muted', text: 'Archivo: ' + s.archivo + ', en el repo de ' + s.repo + '. Lector: ' + s.lector + '.' }));
    if (s.estado === 'no_reader' || s.estado === 'ilegible' || s.estado === 'no_configurado') { sec.appendChild(el('p', { class: s.estado === 'ilegible' ? 'err' : 'muted', text: s.motivo })); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'nuevo') sec.appendChild(el('p', { class: 'muted', text: 'el archivo todavía no existe: se crea con el pedido' }));
    if (s.soloLectura) sec.appendChild(el('p', { class: 'aviso', text: 'sólo lectura: ' + s.motivo }));
    var pr = S.problemas[s.id] || [];
    var arriba = pr.filter(function (x) { return x.sinCampo; });
    if (arriba.length) { var ul = el('ul', {}); arriba.forEach(function (x) { ul.appendChild(el('li', { class: 'err', text: (x.path ? x.path + ': ' : '') + x.message })); }); sec.appendChild(ul); }
    var editor = EDITORES[s.id];
    if (editor) sec.appendChild(editor(s, S.borradores[s.id], pr));
    if (!s.soloLectura && s.estado !== 'no_reader' && s.estado !== 'ilegible' && s.estado !== 'no_configurado' && s.id !== 'paridad') {
      var bar = el('div', { class: 'bar' }, el('button', { class: 'sec', type: 'button', text: 'Revisar', onclick: function () { revisarSeccion(s); } }));
      bar.appendChild(el('button', { class: 'sec', type: 'button', text: 'Descargar el archivo', disabled: S.textos[s.id] ? undefined : 'disabled', onclick: function () { descargar(s); } }));
      if (S.extras.proponer && S.extras.proponer[s.repo] && S.extras.proponer[s.repo].habilitado) bar.appendChild(el('button', { type: 'button', text: 'Proponer', disabled: S.textos[s.id] ? undefined : 'disabled', onclick: function () { S.notas[s.id] = { confirmar: true }; render(); } }));
      else bar.appendChild(el('span', { class: 'muted', text: 'Proponer apagado: ' + ((S.extras.proponer && S.extras.proponer[s.repo] && S.extras.proponer[s.repo].motivo) || 'sin identidad de escritura') }));
      sec.appendChild(bar);
    }
    if (s.id === 'paridad' && S.textos[s.id] && S.extras.proponer && S.extras.proponer[s.repo] && S.extras.proponer[s.repo].habilitado) sec.appendChild(el('div', { class: 'bar' }, el('button', { type: 'button', text: 'Proponer', onclick: function () { S.notas[s.id] = { confirmar: true }; render(); } })));
    var n = S.notas[s.id];
    if (n && n.confirmar) {
      sec.appendChild(el('h4', { text: 'Antes' })); sec.appendChild(el('pre', { text: s.texto || '(el archivo no existe todavía)' }));
      sec.appendChild(el('h4', { text: 'Después' })); sec.appendChild(el('pre', { text: S.textos[s.id] }));
      sec.appendChild(el('div', { class: 'bar' }, el('button', { type: 'button', text: 'Confirmar y proponer', onclick: function () {
        S.notas[s.id] = { ok: true, text: 'proponiendo…' }; render();
        api('/proponer', { seccion: s.id, texto: S.textos[s.id], oid: s.oid }).then(function (r) { S.notas[s.id] = { ok: r.ok, text: r.message, enlace: r.enlace || null }; render(); if (r.ok) cargar(); });
      } }), el('button', { class: 'sec', type: 'button', text: 'Cancelar', onclick: function () { S.notas[s.id] = null; render(); } })));
    } else if (n && n.text) {
      var nota = el('div', { class: n.ok ? 'okmsg' : 'err', text: n.text });
      if (n.enlace) nota.appendChild(el('a', { href: n.enlace, text: ' ' + n.enlace }));
      sec.appendChild(nota);
    }
    return sec;
  }
  function soloLectura(titulo, filas, columnas) {
    var sec = el('section', { class: 'q' }, el('div', { class: 'q-head' }, el('h2', { text: titulo })));
    if (!filas || !filas.length) { sec.appendChild(el('p', { class: 'muted', text: 'nada que mostrar' })); return sec; }
    var tabla = el('table', { class: 'tabla' }); var thead = el('thead', {}); var tr = el('tr', {});
    columnas.forEach(function (c) { tr.appendChild(el('th', { text: c[1] })); }); thead.appendChild(tr); tabla.appendChild(thead);
    var tbody = el('tbody', {});
    filas.forEach(function (f) { var r = el('tr', {}); columnas.forEach(function (c) { var v = f[c[0]]; r.appendChild(el('td', { text: v == null ? '—' : String(v) })); }); tbody.appendChild(r); });
    tabla.appendChild(tbody); sec.appendChild(tabla);
    return sec;
  }
  function render() {
    var partes = S.secciones.map(seccion);
    var ex = S.extras || {};
    var prod = soloLectura('Productos', (ex.productos || []).map(function (p) { return { producto: p.producto, origen: p.origen, repo: p.repo || p.ruta, estado: p.activo === false ? 'apagado' + (p.motivo ? ' (' + p.motivo + ')' : '') : 'activo', edita: p.origen === 'deployments' ? 'sí (Despliegues)' : 'no' }; }), [['producto', 'Producto'], ['origen', 'Origen'], ['repo', 'Repo'], ['estado', 'Estado'], ['edita', 'Se edita acá']]);
    if (ex.productosMotivo) prod.appendChild(el('p', { class: 'err', text: ex.productosMotivo }));
    if (ex.productosEnlace) prod.appendChild(el('p', {}, el('a', { href: ex.productosEnlace, text: 'la lista de la revisión de dependencias (repos.json)' })));
    partes.push(prod);
    if (ex.versionesMotivo) partes.push(el('p', { class: 'err', text: ex.versionesMotivo }));
    partes.push(soloLectura('Versiones de cada máquina', ex.versiones || [], [['maquina', 'Máquina'], ['persona', 'Persona'], ['version', 'Versión del arnés'], ['diaTexto', 'Día'], ['texto', 'Estado']]));
    app.replaceChildren.apply(app, partes);
  }
  function cargar() {
    return api('').then(function (r) {
      if (!r.ok) { app.replaceChildren(el('p', { class: 'err', text: r.message || 'no se pudo leer la configuración' })); return; }
      S.secciones = r.secciones; S.extras = r;
      r.secciones.forEach(function (s) { S.borradores[s.id] = copia(s.borrador === undefined ? {} : s.borrador); S.problemas[s.id] = s.problems || []; S.textos[s.id] = null; S.avisos[s.id] = s.avisos || []; });
      render();
    });
  }
  cargar().catch(function (e) { app.replaceChildren(el('p', { class: 'err', text: 'No pude cargar la pestaña: ' + e.message })); });
})();
`;
}

module.exports = {
  SECCIONES, seccionPorId, loadReader, lectorSabe, formatJson, remoteOf, TEAM_REPOS_SINCE, versionAtLeast, profileGateProblem, packsListGateProblem,
  thresholdsParse, aplicarSeccion, revisar, versionesDeMaquinas, paridadPorProducto, ramaDePropuesta, tituloDePropuesta, cuerpoDePropuesta, pantalla,
  SIN_NOTICIAS_DIAS,
};
