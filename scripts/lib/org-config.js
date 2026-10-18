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
 *   · La regla de la capa del equipo (`TEAM_REPOS_SINCE`, y `MERGE_SUITES_SINCE` y `MODELS_SINCE` para las claves que
 *     llegaron después), la plataforma del remoto, el formato con que se escribe.
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
  Object.freeze({ id: 'paquetes', titulo: 'Paquetes', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['packs'], idCorto: 'profile', necesita: ['packs'] }),
  // story 2.31: lo que cambia la experiencia de cada dev, en el perfil del equipo, validado por el mismo lector de la
  // máquina. `rutas` (opcional): las hojas que la sección cambia dentro de sus `claves`; lo demás de esas claves queda
  // como estaba (Telegram y CodeGraph, de cada máquina, no se editan desde la sección de integraciones).
  Object.freeze({ id: 'respuesta', titulo: 'Cómo contesta Claude', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['response'], idCorto: 'profile', necesita: ['response'] }),
  Object.freeze({ id: 'integraciones', titulo: 'Integraciones', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['integrations'], rutas: Object.freeze(['integrations.clockify', 'integrations.engram', 'integrations.mailbox', 'integrations.codex', 'integrations.nightly']), idCorto: 'profile', necesita: ['integrations'] }),
  Object.freeze({ id: 'ado', titulo: 'Azure DevOps', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['ado'], rutas: Object.freeze(['ado.org']), idCorto: 'profile', necesita: ['ado'] }),
  Object.freeze({ id: 'actualizacion', titulo: 'Cómo se actualizan las máquinas', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['update'], rutas: Object.freeze(['update.channel', 'update.apply']), idCorto: 'profile', necesita: ['update'] }),
  Object.freeze({ id: 'instalacion', titulo: 'Perfil de instalación', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['install'], rutas: Object.freeze(['install.profile']), idCorto: 'profile', necesita: ['install'] }),
  // las conversaciones de las corridas: el interruptor del sitio, en operations.json (decisión 8 de la 2.31)
  // la marca de la organización en el sitio (el nombre, el logo del repo de operaciones y qué hacer con él en oscuro)
  Object.freeze({ id: 'organizacion', titulo: 'La organización', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['site'], rutas: Object.freeze(['site.brand.name', 'site.brand.logo', 'site.brand.dark']), idCorto: 'operations', necesita: ['site'] }),
  Object.freeze({ id: 'hilos', titulo: 'Conversaciones de las corridas', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['site'], rutas: Object.freeze(['site.mailbox.threads']), idCorto: 'operations', necesita: ['site'] }),
  // el interruptor de la organización: con `true`, «Proponer» aprueba y completa el pedido con la identidad del sitio si
  // las políticas de main lo dejan. Cuenta el valor de main, nunca el del cambio que se propone (scripts/site/tabs/config.js)
  Object.freeze({ id: 'aplicar', titulo: 'Los cambios de un mantenedor', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['site'], rutas: Object.freeze(['site.auto_apply']), idCorto: 'operations', necesita: ['site'] }),
  // dos partes de team-repos.json con su propia sección (tanda C): dónde corren las suites al mergear (story 7.28) y el
  // modelo de cada trabajo del pipeline (story 7.29). Un lector anterior no las conoce: la sección dice «no sabe leer».
  // Comparten el identificador de rama con «repos»: un pedido abierto sobre el archivo frena los otros (un pedido por archivo)
  Object.freeze({ id: 'suites', titulo: 'Dónde corren las suites completas al mergear', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['merge_suites'], idCorto: 'repos', necesita: ['merge_suites'] }),
  Object.freeze({ id: 'modelos', titulo: 'Modelos de cada trabajo del pipeline', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['models'], idCorto: 'repos', necesita: ['models'] }),
  // el plazo del aviso de espera (story 7.20): cuántos minutos espera una corrida a una persona antes de avisar
  Object.freeze({ id: 'espera', titulo: 'Aviso de espera', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['wait_notice'], idCorto: 'repos', necesita: ['wait_notice'] }),
  // el umbral de cobertura de las líneas nuevas: el control de pruebas avisa por debajo de este porcentaje
  Object.freeze({ id: 'cobertura', titulo: 'Cobertura de las pruebas', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['coverage'], idCorto: 'repos', necesita: ['coverage'] }),
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
/**
 * 🔴 Las claves de `team-repos.json` que llegaron después del archivo, con la primera versión cuyo lector las conoce (la
 * etiqueta del merge que las trajo): `merge_suites` (story 7.28) y `models` (story 7.29). Una máquina con un lector
 * anterior ve una clave desconocida y rechaza la capa entera; por eso, con una de ellas en el archivo propuesto, el
 * perfil tiene que pedir al menos su versión, y con varias, la mayor.
 */
const MERGE_SUITES_SINCE = '2026.10.16.3';
const MODELS_SINCE = '2026.10.16.10';
// `wait_notice` (story 7.20): la etiqueta del merge que lo trajo al lector
const WAIT_NOTICE_SINCE = '2026.10.17.8';
// `coverage`: la etiqueta del merge que lo trajo al lector
const COVERAGE_SINCE = '2026.10.17.45';
const CLAVES_CON_VERSION = Object.freeze([['merge_suites', MERGE_SUITES_SINCE], ['models', MODELS_SINCE], ['wait_notice', WAIT_NOTICE_SINCE], ['coverage', COVERAGE_SINCE]]);
/** La versión que tiene que pedir el perfil para este `team-repos.json` (sin archivo, la de siempre), y las claves por las que la pide. */
function versionQuePide(doc) {
  let version = TEAM_REPOS_SINCE; const claves = [];
  for (const [k, min] of CLAVES_CON_VERSION) {
    if (!isObject(doc) || doc[k] === undefined) continue;
    claves.push(k);
    if (!versionAtLeast(version, min)) version = min;
  }
  return { version, claves };
}
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
function profileGateProblem(layerText, doc) {
  let decl;
  try { decl = JSON.parse(String(layerText)); } catch (e) {
    return `no pude leer team-layer.json del perfil (${(e && e.message) || e}), y sin él no sé qué versión del arnés piden las máquinas`;
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  const { version, claves } = versionQuePide(doc);
  if (m && versionAtLeast(m[1], version)) return null;
  if (claves.length) return `todavía no se puede proponer: el perfil pide «${req || 'nada'}» en team-layer.json, y una máquina con una versión anterior a la ${version} no sabe leer ${claves.join(' ni ')} de team-repos.json y rechazaría la capa entera. Primero se sube requires.harness a «>= ${version}» (o más)`;
  return `todavía no se puede proponer: el perfil pide «${req || 'nada'}» en team-layer.json, y una máquina con una versión anterior a la ${TEAM_REPOS_SINCE} rechazaría la capa entera si trae team-repos.json. Primero se sube requires.harness a «>= ${TEAM_REPOS_SINCE}» (o más)`;
}

/**
 * 🔴 La primera versión del arnés cuyo lector conoce `response` en el perfil del equipo (story 2.31: la etiqueta del merge
 * que la trajo). Una máquina con un lector anterior ve una clave desconocida y rechaza el perfil ENTERO; por eso, con
 * `response` en el perfil propuesto, el perfil tiene que pedir al menos esta versión.
 */
const RESPONSE_SINCE = '2026.10.17.9';
/**
 * `null` si un `team-profile.json` así lo leen todas las máquinas que pide el perfil; si no, el motivo en llano. Junta
 * las dos reglas del perfil: una LISTA de paquetes pide la versión del sitio (`packsListGateProblem`) y `response` pide
 * `RESPONSE_SINCE`. Las otras claves las lee cualquier versión que admite la capa.
 */
function teamProfileGateProblem({ layerText, versionImagen, doc, actual }) {
  // con el archivo actual, sólo frena lo que el pedido CAMBIA: una lista de paquetes o un `response` que ya están en el
  // perfil no traban la edición de otra sección (pase adversarial de la 2.31); sin él, todo lo que trae el archivo
  const cambia = (k) => !isObject(actual) || canonico(actual[k]) !== canonico(isObject(doc) ? doc[k] : undefined);
  const paquetes = cambia('packs') ? packsListGateProblem({ layerText, versionImagen, valor: isObject(doc) && isObject(doc.packs) ? doc.packs.default : undefined }) : null;
  if (paquetes) return paquetes;
  if (!isObject(doc) || doc.response === undefined || !cambia('response')) return null;
  let decl;
  try { decl = JSON.parse(String(layerText)); } catch (e) {
    return `no pude leer team-layer.json del perfil (${(e && e.message) || e}), y sin él no sé qué versión del arnés piden las máquinas`;
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  if (m && versionAtLeast(m[1], RESPONSE_SINCE)) return null;
  return `todavía no se puede proponer: el perfil pide «${req || 'nada'}» en team-layer.json, y una máquina con una versión anterior a la ${RESPONSE_SINCE} no sabe leer response de team-profile.json y rechazaría el perfil entero. Primero se sube requires.harness a «>= ${RESPONSE_SINCE}» (o más)`;
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
    if (!valido(u)) { problems.push({ path: `thresholds.${k}`, message: 'falta elegir si es mejor más alto o más bajo, o alguno de los dos límites (el del verde y el del rojo)' }); continue; }
    // con el verde del lado del rojo, el tablero pintaría un número de dos colores a la vez
    if (u.direction === 'menor_es_mejor' && !(u.ok_max < u.bad_min)) problems.push({ path: `thresholds.${k}`, message: 'si es mejor más bajo, el límite del verde tiene que ser menor que el del rojo' });
    if (u.direction === 'mayor_es_mejor' && !(u.ok_min > u.bad_max)) problems.push({ path: `thresholds.${k}`, message: 'si es mejor más alto, el límite del verde tiene que ser mayor que el del rojo' });
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
  if (seccion.rutas) {
    // sólo esas hojas: lo demás de la clave queda como estaba; una hoja que el borrador no trae se saca, y el objeto que
    // queda vacío por eso, también (no se escribe un `{}` que antes no estaba)
    for (const ruta of seccion.rutas) {
      const partes = ruta.split('.');
      const valor = partes.reduce((o, k) => (isObject(o) ? o[k] : undefined), b);
      const cadena = [base];
      for (const k of partes.slice(0, -1)) {
        const padre = cadena[cadena.length - 1];
        if (!isObject(padre[k])) { if (valor === undefined) break; padre[k] = {}; }
        cadena.push(padre[k]);
      }
      if (cadena.length !== partes.length) continue;
      const hoja = partes[partes.length - 1];
      if (valor === undefined) delete cadena[cadena.length - 1][hoja]; else cadena[cadena.length - 1][hoja] = clone(valor);
      for (let i = cadena.length - 1; i > 0; i -= 1) { if (Object.keys(cadena[i]).length) break; delete cadena[i - 1][partes[i - 1]]; }
    }
    return base;
  }
  for (const k of seccion.claves) { if (b[k] === undefined) delete base[k]; else base[k] = clone(b[k]); }
  return base;
}

/**
 * Las hojas que un archivo propuesto cambia contra el actual DENTRO de las claves de la sección pero fuera de sus `rutas`
 * (story 2.31): lo que «Proponer» rechaza. Sin `rutas`, ninguna: la sección es dueña de sus claves enteras.
 */
function hojasAjenas(seccion, actual, doc) {
  if (!seccion || !seccion.rutas) return [];
  const out = [];
  const mirar = (a, b, p) => {
    if (seccion.rutas.includes(p)) return;   // una hoja de la sección: puede cambiar
    // un objeto contra otro (o contra nada: la sección lo puede crear o sacar por sus hojas) se mira hoja por hoja
    if ((isObject(a) || a === undefined) && (isObject(b) || b === undefined) && (isObject(a) || isObject(b))) {
      const oa = isObject(a) ? a : {}; const ob = isObject(b) ? b : {};
      for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) mirar(oa[k], ob[k], `${p}.${k}`);
      return;
    }
    if (canonico(a) !== canonico(b)) out.push(p);
  };
  for (const k of seccion.claves) mirar(isObject(actual) ? actual[k] : undefined, isObject(doc) ? doc[k] : undefined, k);
  return out;
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
    // la misma diferencia declarada en varios grupos se renueva o se cierra de una vez (`grupos`); `grupo` es uno solo
    const grupos = Array.isArray(b.grupos) && b.grupos.length ? [...new Set(b.grupos)] : [b.grupo];
    const indices = [];
    for (const g of grupos) {
      const j = lista.findIndex((d) => isObject(d) && d.grupo === g && d.rasgo === b.rasgo);
      if (j < 0) return { ok: false, problems: [{ path: 'diferencias_declaradas', message: `no hay una diferencia declarada ${g}/${b.rasgo}`, sinCampo: true }], texto: null };
      indices.push(j);
    }
    const i = indices[0];
    const nueva = clone(actual);
    let aviso = null;
    if (b.accion === 'close') {
      for (const j of [...indices].sort((x, y) => y - x)) nueva.diferencias_declaradas.splice(j, 1);
      aviso = 'si la diferencia sigue en los pipelines, vuelve a aparecer como divergencia la noche siguiente a la del merge';
    } else if (b.accion === 'renew') {
      const problems = [];
      if (!diaValido(b.revision)) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: 'la fecha de revisión tiene que ser un día con la forma AAAA-MM-DD' });
      else if (b.revision <= dia) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: `la fecha de revisión tiene que ser posterior a hoy (${dia})` });
      else if (b.revision > unAnioDespues(dia)) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: `la fecha de revisión es como mucho a un año (${unAnioDespues(dia)})` });
      if (typeof b.motivo !== 'string' || !b.motivo.trim()) problems.push({ path: `diferencias_declaradas.${i}.motivo`, message: 'el motivo es obligatorio: por qué sigue valiendo la diferencia' });
      if (problems.length) return { ok: false, problems, texto: null };
      for (const j of indices) nueva.diferencias_declaradas[j] = { ...nueva.diferencias_declaradas[j], motivo: b.motivo.trim(), fecha: dia, revision: b.revision };
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
  const base = actual || (s.archivo === 'operations.json' ? { version: 1, owners: { default: '' } } : s.archivo === 'team-profile.json' ? {} : { version: 1 });
  let doc = aplicarSeccion(base, s, borrador);
  // lo que el borrador trae fuera de la sección se pone igual: el lector lo rechaza con su ruta, y eso va arriba
  for (const k of ajenas) doc[k] = clone(borrador[k]);
  const salida = formatJson(doc);
  const r = lector.parse(salida);
  const problems = [...(r.problems || []), ...problemasDeSeccion(s, r, actual, doc)].map((p) => ({ ...p, sinCampo: ajenas.some((k) => p.path === k || String(p.path).startsWith(`${k}.`)) || p.path === '' }));
  return { ok: Boolean(r.ok) && problems.length === 0, problems, texto: r.ok && problems.length === 0 ? salida : null };
}

/**
 * Los problemas que el lector da aparte, sin anular el archivo (`sectionProblems`: hoy, los de `models`, decisión 13 de
 * la 7.29), que tocan a esta sección: los de sus claves; en la sección del archivo entero, los de una clave que el
 * archivo propuesto cambia contra el actual (`actual` null: todas). Sin esto, un modelo mal escrito se propondría,
 * porque el lector dice «válido».
 */
function problemasDeSeccion(seccion, r, actual, doc) {
  const sp = r && isObject(r.sectionProblems) ? r.sectionProblems : {};
  const out = [];
  for (const [k, ps] of Object.entries(sp)) {
    const toca = seccion.claves ? seccion.claves.includes(k) : (!isObject(actual) || canonico(actual[k]) !== canonico(isObject(doc) ? doc[k] : undefined));
    if (toca && Array.isArray(ps)) out.push(...ps);
  }
  return out;
}

/** El valor como texto con las claves ordenadas: el orden en que vienen no es un cambio. */
function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * Los modelos de hoy, sin configuración: `DEFAULTS` de `scripts/lib/models.js` del skill del pipeline, en el árbol (el
 * único skill que lo trae; se busca por el archivo para no nombrar el skill acá). `null` si el árbol no lo trae.
 * `motivoDeHoy(tree)` dice por qué no están: «no pude leer» nunca se muestra igual que «no hay».
 */
function modelosDeHoy(tree) { return buscarModelosDeHoy(tree).hoy; }
function motivoDeHoy(tree) { return buscarModelosDeHoy(tree).motivo; }
function buscarModelosDeHoy(tree) {
  if (!tree) return { hoy: null, motivo: 'no sé dónde está el arnés de este sitio' };
  let skills = [];
  try { skills = fs.readdirSync(path.join(String(tree), 'skills')).sort(); } catch (e) {
    return { hoy: null, motivo: e && e.code === 'ENOENT' ? 'esta versión del sitio no trae los skills' : `no pude leer la carpeta de los skills (${(e && e.code) || 'error'})` };
  }
  let motivo = 'esta versión del sitio no trae los modelos de hoy';
  for (const n of skills) {
    const f = path.join(String(tree), 'skills', n, 'scripts', 'lib', 'models.js');
    if (!fs.existsSync(f)) continue;
    try {
      const m = require(f);
      if (isObject(m.DEFAULTS) && Array.isArray(m.MODELS)) return { hoy: clone(m.DEFAULTS), motivo: null };
      motivo = `skills/${n}/scripts/lib/models.js no trae los valores de hoy`;
    } catch (e) { motivo = `no pude cargar skills/${n}/scripts/lib/models.js (${String((e && e.message) || e).split('\n')[0]})`; }
  }
  return { hoy: null, motivo };
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
// Sólo usa setAttribute, appendChild, addEventListener, textContent y replaceChildren: las pruebas lo corren sobre un
// documento mínimo con eso nada más (lo del navegador —location, history, closest, scrollIntoView— se mira antes de usar).
(function () {
  var meta = document.querySelector('meta[name="site-token"]');
  var TOKEN = meta ? meta.getAttribute('content') : '';
  var app = document.getElementById('config-app');
  if (!app) return;
  var SOLO_LECTURA = false;
  var CONTROLES = { input: true, select: true, textarea: true, button: true };
  function el(tag, attrs) {
    var e = document.createElement(tag); attrs = attrs || {};
    // un atributo sin valor no se pone: setAttribute('disabled', undefined) igual deshabilita
    Object.keys(attrs).forEach(function (k) { var v = attrs[k]; if (v === undefined || v === null) return; if (k === 'text') e.textContent = v; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); });
    // dentro del editor de una sección de sólo lectura, nada se puede tocar: campos, selectores y botones nacen apagados
    if (SOLO_LECTURA && CONTROLES[tag]) e.setAttribute('disabled', 'disabled');
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) e.appendChild(arguments[i]);
    return e;
  }
  function api(ruta, cuerpo) {
    var o = { method: cuerpo ? 'POST' : 'GET', headers: {}, credentials: 'same-origin' };
    if (cuerpo) { o.headers['Content-Type'] = 'application/json'; o.headers['X-Site-Token'] = TOKEN; o.body = JSON.stringify(cuerpo); }
    // siempre termina con un mensaje: un pedido cortado no deja la nota en «proponiendo…» para siempre. Un rechazo sin
    // mensaje (un cuerpo vacío o que no es JSON: lo que está delante del sitio, o una versión vieja) dice qué hacer según
    // su estado, nunca «respuesta N» suelto
    var llano = function (status) {
      if (status === 401) return 'la sesión venció o se cerró: recargá la página para entrar de nuevo';
      // el sitio manda su motivo en cada 403: uno sin motivo lo dio lo que está delante (el inicio de sesión de la nube)
      if (status === 403) return 'el pedido lo rechazó lo que está delante del sitio, no el sitio: recargá la página y probá de nuevo; si sigue, avisale a quien mantiene el arnés';
      if (status === 503) return 'el sitio está cargando o frenado: probá de nuevo en unos segundos';
      return 'el sitio contestó con un error (' + status + ')';
    };
    return fetch('/api/config' + ruta, o).then(function (r) { return r.json().catch(function () { return { ok: false, message: llano(r.status) }; }).then(function (j) { if (r.status >= 400 && j && !j.message) j.message = llano(r.status); return j; }); })
      .catch(function (e) { return { ok: false, message: 'no pude hablar con el sitio (' + (e && e.message ? e.message : 'sin respuesta') + '): si estabas proponiendo, recargá y mirá si el pedido se abrió antes de repetirlo' }; });
  }
  var copia = function (v) { return JSON.parse(JSON.stringify(v)); };
  var S = { pestana: null, secciones: [], borradores: {}, originales: {}, problemas: {}, avisos: {}, notas: {}, textos: {}, extras: null };

  // ── lo que ve la persona de cada sección: el nombre llano, para qué sirve, y en qué bloque va ──
  var PLANO = {
    organizacion: { t: 'La organización', d: 'El nombre y el logo que muestra la barra de arriba de cada página, y el nombre del pie. El logo es un archivo del repo de operaciones; acá se elige cuál.', corto: 'La organización' },
    sitio: { t: 'Quién mantiene el sitio', d: 'Sólo estas personas ven esta pestaña y pueden proponer cambios. Si te sacás de la lista, perdés el acceso cuando se apruebe.', corto: 'Quién mantiene el sitio' },
    personas: { t: 'Personas y máquinas', d: 'Cada máquina que manda corridas tiene que estar a nombre de alguien. Así cada persona ve lo suyo en el sitio.', corto: 'Personas y máquinas' },
    responsables: { t: 'A quién le llegan los avisos y los pedidos', d: 'Cuando algo de la noche necesita a una persona (una dependencia vieja, un hallazgo del vigilante) se le asigna a quien figure acá.', corto: 'Responsables' },
    repos: { t: 'Dónde vive cada repo', d: 'Llega a todas las máquinas del equipo: con esto cada una sabe de dónde se instala el arnés y dónde queda lo de la noche.', corto: 'Repos' },
    despliegues: { t: 'Despliegues de cada producto', d: 'Con esto el sitio sabe qué paso de cada pipeline es la prueba y cuál es producción, para decir qué versión está afuera.', corto: 'Despliegues' },
    canal: { t: 'Dónde llega el resumen de cada mañana', d: 'El canal donde la noche deja su resumen.', corto: 'Aviso diario' },
    umbrales: { t: 'Umbrales: cuándo algo se pinta verde o rojo', d: 'El tablero colorea cada número según estos límites. Entre los dos, se pinta amarillo.', corto: 'Umbrales' },
    suites: { t: 'Dónde corren las pruebas completas al mergear', d: 'Llega a todas las máquinas. Al mergear, cada repo corre sus pruebas completas en la máquina o deja que las corra el servidor, según esta regla.', corto: 'Pruebas al mergear' },
    modelos: { t: 'Qué modelo usa cada trabajo del pipeline', d: 'Llega a todas las máquinas. Lo que no se declara usa el modelo de hoy. Con techo obligatorio, ningún trabajo pasa de ese modelo.', corto: 'Modelos' },
    paridad: { t: 'Diferencias aceptadas entre productos', d: 'Cada noche se comparan los productos entre sí. Lo que uno hace distinto a propósito se anota acá, con una fecha para volver a mirarlo.', corto: 'Diferencias entre productos' },
    espera: { t: 'Aviso de espera', d: 'Llega a todas las máquinas. Cuando una corrida espera a una persona, avisa pasado este plazo.', corto: 'Aviso de espera' },
    cobertura: { t: 'Cobertura de las pruebas', d: 'Llega a todas las máquinas. El control de pruebas avisa cuando las líneas nuevas de una story quedan por debajo de este porcentaje. Avisa, no frena; una máquina puede pedir otro con su propia variable de entorno.', corto: 'Cobertura de las pruebas' },
    respuesta: { t: 'Cómo contesta Claude', d: 'El idioma, el estilo y el largo de las respuestas en todas las máquinas. Llega a cada una con su próxima actualización, sin que el dev haga nada.', corto: 'Cómo contesta Claude' },
    integraciones: { t: 'Integraciones', d: 'Qué servicios usa cada máquina del equipo. Llega a cada una con su próxima actualización; una máquina puede apagar una para ella sola.', corto: 'Integraciones' },
    ado: { t: 'Azure DevOps', d: 'La organización de Azure DevOps del equipo. Llega a cada máquina con su próxima actualización.', corto: 'Azure DevOps' },
    actualizacion: { t: 'Cómo se actualizan las máquinas', d: 'Qué versión toma cada máquina y si se actualiza sola. Llega a cada una con su próxima actualización.', corto: 'Actualización' },
    paquetes: { t: 'Paquetes de la organización', d: 'Qué paquetes del arnés (revisores y guías de un producto o de un cliente) se activan en todas las máquinas. Llega a cada una con su próxima actualización.', corto: 'Paquetes' },
    instalacion: { t: 'Perfil de instalación', d: 'Cuánto instala el arnés en cada máquina. Llega a cada una con su próxima actualización.', corto: 'Instalación' },
    hilos: { t: 'Conversaciones de las corridas', d: 'Si el sitio baja también lo que se habló en cada corrida, además de sus números.', corto: 'Conversaciones' },
    aplicar: { t: 'Los cambios de un mantenedor', d: 'Si un cambio que propone quien mantiene el sitio entra solo, o queda un pedido para que lo apruebe otra persona. El cambio que prende esta opción no se aplica solo: la opción cuenta desde que entra.', corto: 'Los cambios de un mantenedor' },
  };
  // las pestañas: [id, nombre, secciones, tablas para mirar]. Se ve una por vez; el resumen de arriba, en todas
  var PESTANAS = [['personas', 'Personas', ['organizacion', 'sitio', 'aplicar', 'personas', 'responsables'], []], ['repos', 'Repos y productos', ['repos', 'despliegues', 'paridad', 'ado'], ['productos']], ['avisos', 'Avisos y la noche', ['canal', 'espera', 'umbrales'], []], ['claude', 'Cómo trabaja Claude', ['respuesta', 'modelos', 'suites', 'cobertura', 'integraciones', 'hilos'], []], ['instalacion', 'Instalación y actualización', ['actualizacion', 'instalacion', 'paquetes'], ['contenido', 'versiones']]];
  /** La pestaña de un ancla (#pestana-x, #seccion-x o una tabla para mirar); null si no es de ninguna. */
  function pestanaDe(ancla) {
    var id = String(ancla || '').replace(/^#/, '');
    var hit = null;
    PESTANAS.forEach(function (p) { if (hit) return; if (id === 'pestana-' + p[0] || p[2].some(function (x) { return id === 'seccion-' + x; }) || p[3].indexOf(id) >= 0) hit = p[0]; });
    // una sección que esta pantalla no conoce va a la última pestaña, donde se muestra
    if (!hit && id.indexOf('seccion-') === 0 && S.secciones.some(function (s) { return 'seccion-' + s.id === id; })) hit = PESTANAS[PESTANAS.length - 1][0];
    return hit;
  }
  var REPO_DE = { operaciones: 'el repo de operaciones', perfil: 'el repo del equipo' };
  function plano(s) { return PLANO[s.id] || { t: s.titulo, d: '', corto: s.titulo }; }
  function bloqueada(s) { return s.estado === 'no_reader' || s.estado === 'ilegible' || s.estado === 'no_configurado' || s.estado === 'bajando'; }
  /** El estado de una sección en una palabra: [clase, texto]. */
  function estadoDe(s) {
    if (s.estado === 'ilegible') return ['bad', 'hay que arreglarla a mano'];
    if (s.estado === 'no_reader') return ['nm', 'todavía no disponible'];
    if (s.estado === 'no_configurado') return ['nm', s.falta ? 'falta ' + s.falta : 'sin configurar'];
    if (s.estado === 'bajando') return ['nm', 'bajando el repo del equipo'];
    if (s.soloLectura) return ['nm', 'sólo para mirar'];
    var n = (S.problemas[s.id] || []).length;
    if (n) return ['warn', n + ' para corregir'];
    if (S.textos[s.id]) return ['ok', 'revisada'];
    if (s.estado === 'nuevo') return ['nm', 'se crea al proponer'];
    if (s.id === 'personas' && s.extras && (s.extras.porConfirmar || []).length) return ['warn', s.extras.porConfirmar.length + ' por confirmar'];
    return ['ok', 'al día'];
  }
  // ── los mensajes de los lectores, en castellano llano: la ruta con nombres de la pantalla y sin claves del archivo ──
  var PALABRAS = {
    site: 'el sitio', maintainers: 'quién mantiene el sitio', mailbox: 'dónde dejan sus corridas', provider: 'servicio', account: 'cuenta', container: 'carpeta', threads: 'conversaciones', refresh_minutes: 'cada cuánto se actualiza', url: 'dirección',
    people: 'personas', machines: 'máquinas', projects: 'proyectos', person: 'persona', reported_sha256: 'correo informado', confirmed_by: 'confirmada por', confirmed_on: 'confirmada el', add: 'suma', remove: 'saca',
    owners: 'responsables', reviewers: 'revisores', default: 'por defecto', by_project: 'por proyecto', dependencies: 'dependencias', watcher: 'vigilante',
    deployments: 'despliegues', products: 'productos', staging: 'prueba', production: 'producción', pipeline: 'pipeline', stages: 'pasos', environment: 'entorno', workflow: 'workflow',
    notify: 'aviso diario', channel: 'canal', thresholds: 'umbrales', direction: 'mejor si es', ok_min: 'verde desde', ok_max: 'verde hasta', bad_max: 'rojo hasta', bad_min: 'rojo desde',
    merge_suites: 'pruebas al mergear', rule: 'regla', full_tests_pipeline: 'pipeline de las pruebas completas', models: 'modelos', mandatory_ceiling: 'techo obligatorio', ceiling: 'techo', reviewer: 'revisor', reviewers_reloop: 'revisores de la segunda vuelta', adversarial: 'pase adversarial', helpers: 'ayudantes', session: 'sesión', model: 'modelo', heavy: 'pesado', fable_question: 'pregunta antes de usar Fable', low: 'liviano', normal: 'normal',
    wait_notice: 'aviso de espera', minutes: 'minutos', coverage: 'cobertura de las pruebas', min_touched_lines_pct: 'porcentaje mínimo de las líneas nuevas', public: 'repo público', profile: 'repo del equipo', operations: 'repo de operaciones', org: 'organización', project: 'proyecto', repo: 'repo', repos: 'repos', platform: 'plataforma',
    response: 'cómo contesta Claude', integrations: 'integraciones', ado: 'Azure DevOps', update: 'actualización', install: 'instalación', packs: 'paquetes', diferencias_declaradas: 'diferencias declaradas', version: 'versión',
  };
  /** La ruta de un problema con los nombres de la pantalla: «personas › máquinas › «mac-1»»; un número es la fila. */
  function rutaLlana(ruta) {
    if (!ruta) return '';
    return String(ruta).split('.').map(function (p) { return /^\d+$/.test(p) ? 'fila ' + (Number(p) + 1) : PALABRAS[p] || '«' + p + '»'; }).join(' › ');
  }
  // [patrón, frase]: los mensajes que nombran claves del archivo, dichos con las palabras de la pantalla
  var FRASES = [
    [/^clave desconocida( \(secciones válidas:.*)?$/, 'el arnés no conoce este dato'],
    [/^falta$/, 'falta completarlo'],
    [/^tiene que ser (un objeto|una lista)\b.*$/, 'está escrito con una forma que el arnés no sabe leer: hay que corregirlo a mano en el archivo'],
    [/^tiene que ser true o false.*$/, 'tiene que ser sí o no'],
    [/^un techo sin «mandatory_ceiling: true» no limita nada$/, 'un techo que no es obligatorio no limita nada'],
    [/^con techo obligatorio falta «ceiling»$/, 'con el techo obligatorio, falta elegir el modelo del techo'],
    [/^este repo ya tiene una entrada en merge_suites\.repos$/, 'este repo ya está en la lista'],
    [/^tiene que traer rule o full_tests_pipeline.*$/, 'tiene que decir la regla o el pipeline de las pruebas completas'],
    [/^(«[^»]*») está en add y en remove: va en una sola$/, '$1 está para sumar y para sacar a la vez: va en uno solo'],
    [/^tiene que declarar staging, production o los dos$/, 'tiene que tener el paso de prueba, el de producción o los dos'],
    [/^sólo va en staging: (.*)$/, 'sólo va en el paso de prueba: $1'],
    [/^tiene que ser «ask» o «never»(.*)$/, 'tiene que ser «preguntar» o «nunca»$1'],
  ];
  function mensajeLlano(m) {
    var t = String(m == null ? '' : m);
    for (var i = 0; i < FRASES.length; i++) if (FRASES[i][0].test(t)) return t.replace(FRASES[i][0], FRASES[i][1]);
    return t;
  }
  /** Los problemas o avisos de un lector, con el mensaje llano y la ruta con nombres (la ruta original queda para ubicarlos). */
  function llanos(lista) { return (lista || []).map(function (x) { var y = {}; Object.keys(x).forEach(function (k) { y[k] = x[k]; }); y.message = mensajeLlano(x.message); y.donde = rutaLlana(x.path); return y; }); }
  /** Un aviso con una frase llana arriba y el motivo exacto del arnés, plegado, abajo. */
  function aviso(clase, titulo, detalle) {
    var box = el('div', { class: 'msg ' + clase }, el('b', { text: titulo }));
    if (detalle) box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: 'Detalle' }), el('span', { text: detalle })));
    return box;
  }

  // lo que ya se dibujó junto a un campo: los editores de suites y modelos listan al final lo que quedó sin lugar
  var MOSTRADOS = [];
  function problemasEn(lista, p) { var r = (lista || []).filter(function (x) { return x.path === p; }); MOSTRADOS = MOSTRADOS.concat(r); return r; }
  function esObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  // los problemas de la clave que ningún campo mostró (una clave desconocida, un techo sin techo obligatorio, un repo
  // repetido) y el texto de la clave entera: sin eso, la sección diría «para corregir» sin decir qué ni dejar sacarlo
  function restoYTexto(s, d, pr, clave, titulo) {
    var box = el('div', { class: 'pila' });
    box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: 'Editar como texto' }), editorGenerico(s, d, pr, clave, titulo)));
    (pr || []).filter(function (x) { return !x.sinCampo && (x.path === clave || String(x.path).indexOf(clave + '.') === 0) && MOSTRADOS.indexOf(x) < 0; })
      .forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.donde + ': ' + x.message })); });
    return box;
  }
  // los campos numéricos: lo que es un número va como número; lo demás, tal cual, para que el lector diga «es "abc"»
  // (con Number, un texto daba NaN, el archivo escribía null y el aviso decía «es null» en vez de qué corregir)
  function numOTexto(v) { return /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v; }
  function campo(label, valor, onInput, p, problemas, attrs) {
    var mios = problemasEn(problemas, p);
    var input = el('input', Object.assign({ value: valor == null ? '' : String(valor), oninput: function (e) { onInput(e.target.value); }, 'data-path': p, 'aria-label': label }, attrs || {}));
    if (mios.length) input.setAttribute('class', 'bad');
    var box = el('div', { class: 'campo' }, label ? el('label', { text: label }) : null, input);
    mios.forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function quitar(onclick) { return el('button', { class: 'sec', type: 'button', text: '✕', title: 'Quitar', 'aria-label': 'Quitar', onclick: onclick }); }
  function listaDeTextos(titulo, ayuda, lista, set, p, problemas, nombre, agregar) {
    var box = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: titulo }), ayuda ? el('p', { class: 'sub-d', text: ayuda }) : null);
    if (!(lista || []).length) box.appendChild(el('p', { class: 'muted', text: 'Nadie todavía.' }));
    (lista || []).forEach(function (v, i) {
      box.appendChild(el('div', { class: 'fila quitar' }, campo('', v, function (nv) { lista[i] = nv; set(lista); }, p + '.' + i, problemas, { placeholder: nombre }), quitar(function () { lista.splice(i, 1); set(lista); render(); })));
    });
    box.appendChild(el('button', { class: 'mas', type: 'button', text: '+ ' + (agregar || 'Agregar'), onclick: function () { lista.push(''); set(lista); render(); } }));
    problemasEn(problemas, p).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function repoFila(titulo, ayuda, repo, set, p, problemas) {
    var r = repo || { platform: 'azure', org: '', project: '', repo: '' };
    var plat = el('select', { 'data-path': p + '.platform', 'aria-label': 'Dónde', onchange: function (e) { var v = e.target.value; var nr = { platform: v, org: r.org || '', repo: r.repo || '' }; if (v === 'azure') nr.project = r.project || ''; set(nr); render(); } },
      el('option', { value: 'azure', text: 'Azure DevOps' }), el('option', { value: 'github', text: 'GitHub' }));
    plat.value = r.platform === 'github' ? 'github' : 'azure';
    var upd = function (k) { return function (v) { r[k] = v; set(r); }; };
    return el('div', { class: 'fila repo' }, el('div', { class: 'k', text: titulo }, el('small', { text: ayuda })), el('div', { class: 'campo' }, el('label', { text: 'Dónde' }), plat),
      campo('Organización', r.org, upd('org'), p + '.org', problemas), r.platform === 'github' ? campo('Proyecto', '', function () {}, p + '.project', problemas, { disabled: 'disabled', placeholder: 'no aplica en GitHub' }) : campo('Proyecto', r.project, upd('project'), p + '.project', problemas), campo('Repo', r.repo, upd('repo'), p + '.repo', problemas));
  }

  // ── los editores por sección ──
  var REPO_SLOTS = [['public', 'El arnés', 'el que se instala'], ['profile', 'El del equipo', 'llega a cada máquina'], ['operations', 'Operaciones', 'lo de la noche; no se instala'], ['maintainers', 'Mantenimiento', 'opcional']];
  function editorRepos(s, d, pr) {
    var box = el('div', {});
    REPO_SLOTS.forEach(function (par) { var k = par[0]; if (k === 'maintainers' && !d[k]) { box.appendChild(el('button', { class: 'mas', type: 'button', text: '+ Agregar el repo de mantenimiento (opcional)', onclick: function () { d[k] = { platform: 'azure', org: '', project: '', repo: '' }; render(); } })); return; } box.appendChild(repoFila(par[1], par[2], d[k], function (v) { d[k] = v; }, k, pr)); });
    return box;
  }
  function editorResponsables(s, d, pr) {
    d.owners = d.owners || { default: '' }; d.reviewers = d.reviewers || {};
    var box = el('div', { class: 'pila' }, campo('Responsable por defecto (su usuario en la plataforma)', d.owners.default, function (v) { d.owners.default = v; }, 'owners.default', pr));
    var byp = d.owners.by_project || {};
    var sub = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Responsable por proyecto' }), el('p', { class: 'sub-d', text: 'Opcional. Un proyecto que no está acá va al responsable por defecto.' }));
    Object.keys(byp).forEach(function (name) { sub.appendChild(el('div', { class: 'fila quitar3' }, campo('', name, function () {}, 'owners.by_project', pr, { disabled: 'disabled' }), campo('', byp[name], function (v) { byp[name] = v; }, 'owners.by_project.' + name, pr, { placeholder: 'usuario' }), quitar(function () { delete byp[name]; if (!Object.keys(byp).length) delete d.owners.by_project; render(); }))); });
    var np = el('input', { placeholder: 'nombre del proyecto', 'aria-label': 'Proyecto nuevo' });
    sub.appendChild(el('div', { class: 'fila quitar' }, np, el('button', { class: 'sec', type: 'button', text: '+ Agregar proyecto', onclick: function () { var v = np.value.trim(); if (!v) return; d.owners.by_project = d.owners.by_project || {}; d.owners.by_project[v] = ''; render(); } })));
    box.appendChild(sub);
    box.appendChild(listaDeTextos('Revisan los pedidos de dependencias', null, d.reviewers.dependencies = d.reviewers.dependencies || [], function (l) { d.reviewers.dependencies = l; }, 'reviewers.dependencies', pr, 'usuario', 'Agregar persona'));
    box.appendChild(listaDeTextos('Revisan los hallazgos del vigilante', null, d.reviewers.watcher = d.reviewers.watcher || [], function (l) { d.reviewers.watcher = l; }, 'reviewers.watcher', pr, 'usuario', 'Agregar persona'));
    return box;
  }
  function editorSitio(s, d, pr) {
    d.site = d.site || {};
    var site = d.site;
    var lista = el('div', { class: 'pila' });
    var mant = listaDeTextos('Las personas', null, site.maintainers = site.maintainers || [], function (l) { site.maintainers = l; }, 'site.maintainers', pr, 'correo', 'Agregar persona');
    mant.setAttribute('class', 'pila');
    lista.appendChild(mant);
    var refresco = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Cada cuánto se actualiza el sitio' }), campo('Minutos, entre 5 y 120', site.refresh_minutes, function (v) { site.refresh_minutes = v === '' ? undefined : numOTexto(v); }, 'site.refresh_minutes', pr, { inputmode: 'numeric' }));
    lista.appendChild(refresco);
    if (s.campos && s.campos.url) lista.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'La dirección del sitio' }), campo('', site.url, function (v) { site.url = v || undefined; }, 'site.url', pr)));
    var mb = site.mailbox || {};
    var buzon = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Dónde dejan sus corridas las máquinas' }), el('p', { class: 'sub-d', text: 'Las contraseñas no van acá: se cargan en la nube.' }));
    var f = el('div', { class: 'fila' });
    var servicios = (s.extras && s.extras.servicios) || null;
    var SERVICIO = { 'azure-blob': 'Azure Blob Storage' };
    [['provider', 'Servicio'], ['account', 'Cuenta'], ['container', 'Carpeta']].forEach(function (par) {
      var k = par[0]; var poner = function (v) { site.mailbox = site.mailbox || {}; if (v === '') delete site.mailbox[k]; else site.mailbox[k] = v; };
      if (k === 'provider' && servicios) f.appendChild(selector(par[1], mb[k], [['', 'elegí el servicio']].concat(servicios.map(function (x) { return [x, SERVICIO[x] || x]; })), poner, 'site.mailbox.' + k, pr));
      else f.appendChild(campo(par[1], mb[k], function (v) { site.mailbox = site.mailbox || {}; site.mailbox[k] = v; }, 'site.mailbox.' + k, pr));
    });
    buzon.appendChild(f);
    lista.appendChild(buzon);
    if (s.avisoLista) lista.appendChild(el('div', { class: 'aviso', text: s.avisoLista }));
    return lista;
  }
  function editorGenerico(s, d, pr, clave, titulo) {
    // una sección sin formulario propio: se edita como texto de esa parte
    var ta = el('textarea', { rows: '8', spellcheck: 'false', 'aria-label': titulo, 'data-path': clave, oninput: function (e) { try { d[clave] = JSON.parse(e.target.value); S.notas[s.id] = null; } catch (err) { S.notas[s.id] = { ok: false, text: 'El texto no está bien escrito: ' + err.message }; } } });
    ta.value = JSON.stringify(d[clave] === undefined ? {} : d[clave], null, 2);
    var box = el('div', { class: 'pila' }, ta);
    problemasEn(pr, clave).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  // cada entrada con el nombre de sus pasos tal como los muestra el pipeline; el identificador, si no se sabe el nombre
  function textoDeEntradas(lista) {
    return (lista || []).map(function (e) {
      if (!e || typeof e !== 'object') return String(e);
      if (e.environment) return e.environment + (e.repo ? ' (' + e.repo + ')' : '');
      var nombres = pasosDe(e.pipeline);
      var pipe = e.pipeline ? String(e.pipeline).replace(/^[^/]+\//, '') : '';
      return (e.stages || []).map(function (id) { return nombres[id] || id; }).join(', ') + (pipe ? ' (pipeline ' + pipe + ')' : '');
    }).join(' · ') || '—';
  }
  function editorDespliegues(s, d, pr) {
    var box = el('div', { class: 'pila' });
    var prods = d.deployments && d.deployments.products && typeof d.deployments.products === 'object' ? d.deployments.products : {};
    var nombres = Object.keys(prods).filter(function (k) { return k.indexOf('__') !== 0; });
    if (!nombres.length) box.appendChild(el('p', { class: 'muted', text: 'Ningún producto todavía.' }));
    nombres.forEach(function (n) {
      var p = prods[n] || {};
      box.appendChild(el('div', { class: 'despliegue' }, el('div', {}, el('div', { class: 'lab', text: 'Producto' }), el('div', { class: 'prod', text: n })),
        el('div', {}, el('div', { class: 'lab', text: 'Prueba' }), el('div', { text: textoDeEntradas(p.staging) })),
        el('div', {}, el('div', { class: 'lab', text: 'Producción' }), el('div', { text: textoDeEntradas(p.production) }))));
    });
    var producto = el('input', { placeholder: 'nombre del producto', 'aria-label': 'Producto' });
    var sel = el('input', { placeholder: 'número del pipeline, o dueño/repo en GitHub', 'aria-label': 'Pipeline' });
    var nombrePipeline = el('input', { placeholder: 'proyecto/nombre del pipeline (Azure)', 'aria-label': 'Nombre del pipeline' });
    var nota = el('div', {});
    // con la lista del proyecto de operaciones, el pipeline se elige por su nombre y completa los dos campos de abajo
    var ex = s.extras || {};
    var lista = ex.plataforma === 'azure' ? listaDePipelines(pipelinesDe(ex.org, ex.proyecto)) : null;
    var eleccion = lista ? selector('Pipeline', '', [['', 'elegí el pipeline']].concat(lista.map(function (x) { return [String(x.id), x.nombre]; })), function (v) {
      var x = lista.filter(function (y) { return String(y.id) === v; })[0];
      sel.value = x ? ex.proyecto + '/' + x.id : ''; nombrePipeline.value = x ? ex.proyecto + '/' + x.nombre : '';
    }, 'deployments.pipeline', pr) : null;
    var agregar = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Agregar un producto' }), el('p', { class: 'sub-d', text: 'Elegís el pipeline y el sitio te muestra sus pasos para que marques cuál es la prueba y cuál producción.' }),
      eleccion,
      el('div', { class: 'fila' }, producto, lista ? el('details', { class: 'mas-info' }, el('summary', { text: 'Escribirlo a mano' }), sel, nombrePipeline) : sel, lista ? null : nombrePipeline, el('button', { class: 'sec', type: 'button', text: 'Ver sus pasos', onclick: function () {
        api('/stages', { pipeline: sel.value }).then(function (r) {
          nota.replaceChildren();
          if (!r.ok) { nota.appendChild(el('div', { class: 'err', text: r.message })); return; }
          var ul = el('ul', { class: 'renglones' });
          (r.propuestos || []).forEach(function (st) { ul.appendChild(el('li', {}, el('span', { class: 'quien', text: st.nombre || st.identificador }), el('span', { class: 'dato', text: st.nombre ? st.identificador : '' }), el('span', { class: 'acc' }, el('button', { class: 'sec', type: 'button', text: 'Es la prueba', onclick: function () { confirmarStage(d, producto.value, sel.value, nombrePipeline.value, 'staging', st.identificador); } }), el('button', { class: 'sec', type: 'button', text: 'Es producción', onclick: function () { confirmarStage(d, producto.value, sel.value, nombrePipeline.value, 'production', st.identificador); } })))); });
          nota.appendChild(el('p', { class: 'muted', text: 'Nada se guarda hasta que marques cada paso; después, revisá y proponé.' }));
          nota.appendChild(ul);
        });
      } })), nota);
    box.appendChild(agregar);
    box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: 'Editar como texto' }), editorGenerico(s, d, pr, 'deployments', 'Despliegues, como texto')));
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
    var box = el('div', { class: 'pila' });
    var ex = (s.extras || {});
    if (ex.vencido) box.appendChild(aviso('bad', 'La lista de personas está rota hace más de un día y hay que arreglarla a mano.', ex.vencido));
    if (ex.ultimoBueno) box.appendChild(aviso('warn', 'Se muestra la última versión buena: la actual tiene un error.', ex.ultimoBueno));
    var pc = el('ul', { class: 'renglones' });
    (ex.porConfirmar || []).forEach(function (m) {
      var persona = el('input', { value: m.correo || '', placeholder: 'correo de la persona', 'aria-label': 'Correo de la persona' });
      pc.appendChild(el('li', {}, el('span', { class: 'quien', text: m.maquina }), el('span', { class: 'dato', text: (m.correo ? 'dice ser de ' + m.correo : 'no dice de quién es') + ' · última noticia ' + (m.dia || 'sin fecha') + ' · ' + (m.corridas == null ? 'corridas sin contar' : m.corridas + ' corridas') }),
        el('span', { class: 'acc' }, persona, el('button', { type: 'button', text: 'Confirmar', onclick: function () { revisarSeccion(s, { accion: 'confirm', maquina: m.maquina, person: persona.value, people: d.people }); } }))));
    });
    box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: 'Por confirmar' }), (ex.porConfirmar || []).length ? pc : el('p', { class: 'muted', text: 'Ninguna.' })));
    // las que nunca dieron señales (sin place.json, sin fecha, sin corridas): suelen ser laboratorios o pruebas que
    // escribieron en el buzón; se nombran, sin ofrecer confirmarlas
    if ((ex.sinActividad || []).length) {
      var sa = el('ul', { class: 'renglones' });
      ex.sinActividad.forEach(function (m) { sa.appendChild(el('li', {}, el('span', { class: 'quien', text: m.maquina }), el('span', { class: 'dato', text: 'sin corridas, sin fecha y sin decir de quién es' }))); });
      box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: 'Sin actividad (' + ex.sinActividad.length + ')' }),
        el('p', { class: 'muted', text: 'Carpetas del buzón que nunca subieron una corrida ni dijeron de quién son: suelen ser de laboratorios o pruebas. No hay nada que confirmar; quien mantiene el buzón las puede borrar.' }), sa));
    }
    var machines = d.people.machines || {};
    var conf = el('ul', { class: 'renglones' });
    Object.keys(machines).forEach(function (m) {
      var e = machines[m] || {};
      var li = el('li', {}, el('span', { class: 'quien', text: m }), el('span', { class: 'dato', text: 'de ' + (e.person || 'sin persona') + ' · confirmada por ' + (e.confirmed_by || 'sin dato') + ' el ' + (e.confirmed_on || 'sin fecha') }), el('span', { class: 'acc' }, quitar(function () { delete machines[m]; if (!Object.keys(machines).length) delete d.people.machines; render(); })));
      problemasEn(pr, 'people.machines.' + m).concat(problemasEn(pr, 'people.machines.' + m + '.confirmed_on')).forEach(function (x) { li.appendChild(el('span', { class: 'err', text: x.message })); });
      conf.appendChild(li);
    });
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Confirmadas' }), Object.keys(machines).length ? conf : el('p', { class: 'muted', text: 'Ninguna.' })));
    var donde = el('ul', { class: 'renglones' });
    (ex.personas || []).forEach(function (p) {
      var fix = (d.people.projects || {})[p.correo] || {};
      var agregar = el('input', { placeholder: 'producto', 'aria-label': 'Producto' });
      donde.appendChild(el('li', {}, el('span', { class: 'quien', text: p.correo }), el('span', { class: 'dato', text: 'deducido: ' + ((p.deducidos || []).join(', ') || 'nada') + ' · se agrega: ' + ((fix.add || []).join(', ') || 'nada') + ' · se quita: ' + ((fix.remove || []).join(', ') || 'nada') + (p.caida ? ' · sus máquinas no mandan noticias' : '') }),
        el('span', { class: 'acc' }, agregar,
          el('button', { class: 'sec', type: 'button', text: 'Agregar', onclick: function () { var v = agregar.value.trim(); if (!v) return; d.people.projects = d.people.projects || {}; var f = d.people.projects[p.correo] = d.people.projects[p.correo] || {}; f.add = f.add || []; f.add.push(v); render(); } }),
          el('button', { class: 'sec', type: 'button', text: 'Quitar', onclick: function () { var v = agregar.value.trim(); if (!v) return; d.people.projects = d.people.projects || {}; var f = d.people.projects[p.correo] = d.people.projects[p.correo] || {}; f.remove = f.remove || []; f.remove.push(v); render(); } }))));
    });
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'En qué proyectos trabaja cada uno' }), el('p', { class: 'sub-d', text: 'El sitio lo deduce de lo que cada uno hizo. Acá corregís lo que deduce mal.' }), (ex.personas || []).length ? donde : el('p', { class: 'muted', text: 'Nadie todavía.' })));
    return box;
  }
  // los nombres de los umbrales, como los titula el tablero; uno que no está acá se muestra con su clave
  var UMBRAL = {
    dod: 'Cierres que dejaron prueba de que anda', rework: 'Stories que vuelven con un seguimiento', mutacion: 'Puntaje de mutación de las pruebas',
    cobertura_tocada_evaluo: 'Corridas que midieron la cobertura de lo tocado', qa_guia: 'Cierres con la guía para probar a mano', estilo: 'Respuestas dentro del largo pedido',
    bloqueo: 'Turnos sin pasos largos que traben la conversación', vigilados: 'Productos con su producción vigilada', bus_factor_productos_en_riesgo: 'Productos que hizo casi una sola persona',
    escapes_regla_dominante: 'Escapes concentrados en una sola regla', banco_rojos: 'Casos rojos del banco de controles', suites_rojas: 'Suites del arnés en rojo',
    deps_hallazgos: 'Hallazgos de dependencias', contrato_v2: 'Registros por merge con el formato completo', corridas_al_final: 'Corridas que llegan al último paso', corridas_con_error: 'Corridas donde un control encontró un error',
  };
  var CANTIDADES = { bus_factor_productos_en_riesgo: 1, banco_rojos: 1, suites_rojas: 1, deps_hallazgos: 1 };
  function editorUmbrales(s, d, pr) {
    var box = el('div', {}, el('div', { class: 'thr h' }, el('span', { text: 'Número' }), el('span', { text: 'Mejor si es' }), el('span', { text: 'Verde' }), el('span', { text: 'Rojo' })));
    Object.keys(d).forEach(function (k) {
      if (k.charAt(0) === '_' || !d[k] || typeof d[k] !== 'object') return;
      var u = d[k];
      var mayor = u.direction !== 'menor_es_mejor';
      var verde = mayor ? 'ok_min' : 'ok_max'; var rojo = mayor ? 'bad_max' : 'bad_min';
      var dir = el('select', { 'aria-label': 'Mejor si es', 'data-path': 'thresholds.' + k + '.direction', onchange: function (e) {
        // cambiar el sentido mueve los dos números a sus claves del otro sentido
        var nuevo = e.target.value; if (nuevo === u.direction) return;
        var a = u[verde], b = u[rojo]; delete u[verde]; delete u[rojo]; u.direction = nuevo;
        if (nuevo === 'menor_es_mejor') { if (a !== undefined) u.ok_max = a; if (b !== undefined) u.bad_min = b; } else { if (a !== undefined) u.ok_min = a; if (b !== undefined) u.bad_max = b; }
        render();
      } }, el('option', { value: 'mayor_es_mejor', text: 'más alto' }), el('option', { value: 'menor_es_mejor', text: 'más bajo' }));
      dir.value = mayor ? 'mayor_es_mejor' : 'menor_es_mejor';
      var num = function (c, etiqueta) { var mios = problemasEn(pr, 'thresholds.' + k + '.' + c); var i = el('input', { value: u[c] == null ? '' : String(u[c]), inputmode: 'decimal', 'aria-label': etiqueta, 'data-path': 'thresholds.' + k + '.' + c, oninput: function (e) { var v = e.target.value; if (v === '') delete u[c]; else u[c] = numOTexto(v); } }); if (mios.length) i.setAttribute('class', 'bad'); return i; };
      var fila = el('div', { class: 'thr' }, el('span', { text: UMBRAL[k] || k.replace(/_/g, ' ') }, el('span', { class: 'hint', text: CANTIDADES[k] ? 'una cantidad' : 'una proporción: 0.5 es la mitad' })), dir,
        num(verde, mayor ? 'Verde desde' : 'Verde hasta'), num(rojo, mayor ? 'Rojo hasta' : 'Rojo desde'));
      pr.filter(function (x) { return x.path === 'thresholds.' + k || String(x.path).indexOf('thresholds.' + k + '.') === 0; }).forEach(function (x) { fila.appendChild(el('div', { class: 'err', text: x.message })); });
      (S.avisos[s.id] || []).filter(function (a) { return a.path === 'thresholds.' + k; }).forEach(function (a) { fila.appendChild(el('div', { class: 'aviso', text: a.message })); });
      box.appendChild(fila);
    });
    box.appendChild(el('p', { class: 'muted', text: 'Si es mejor más alto: verde desde el primer número, rojo hasta el segundo. Si es mejor más bajo, al revés.' }));
    return box;
  }
  function editorParidad(s, d, pr) {
    var box = el('div', { class: 'pila' });
    var v = s.vista || {};
    // cada rasgo con su descripción de la lista («que»); sin ella, la clave con espacios
    var QUE = {}; ((v.definicion && v.definicion.rasgos) || []).forEach(function (r) { if (r && r.id) QUE[r.id] = r.que || r.id; });
    function queDe(rasgo) { return QUE[rasgo] || String(rasgo || '').replace(/-/g, ' '); }
    function lista(xs, fmt, nada) { var vistos = {}; var out = []; (xs || []).forEach(function (x) { var t = fmt(x); if (!vistos[t]) { vistos[t] = true; out.push(t); } }); return out.join('; ') || nada; }
    box.appendChild(el('p', { class: 'muted', text: 'Comparación de hoy: ' + (v.texto || 'no medida') + (v.fecha ? ' (' + v.fecha + ')' : '') }));
    // sólo los productos con algo para mirar; los que coinciden (salvo lo aceptado) van en una línea
    var conAlgo = (v.productos || []).filter(function (p) { return (p.faltan || []).length || (p.tiene || []).length || (p.vencidas || []).length; });
    var enOrden = (v.productos || []).length - conAlgo.length;
    if ((v.productos || []).length) box.appendChild(el('div', { class: 'msg ' + (conAlgo.length ? 'warn' : 'ok') }, el('b', { text: conAlgo.length ? conAlgo.length + ' producto' + (conAlgo.length === 1 ? '' : 's') + ' con algo para mirar' + (enOrden ? '; los otros ' + enOrden + ' coinciden con los demás' : '') + '.' : 'Los ' + enOrden + ' productos coinciden con los demás, salvo las diferencias aceptadas de abajo.' })));
    var prods = el('ul', { class: 'renglones' });
    conAlgo.forEach(function (p) {
      prods.appendChild(el('li', {}, el('span', { class: 'quien', text: p.producto + ' · ' + p.grupos.join(', ') }),
        el('span', { class: 'dato', text: 'le falta: ' + lista(p.faltan, function (x) { return QUE[x.rasgo] || x.que || queDe(x.rasgo); }, 'nada') + ' · hace algo que los demás no: ' + lista(p.tiene, function (x) { return QUE[x.rasgo] || x.que || queDe(x.rasgo); }, 'nada') + ' · aceptadas: ' + lista(p.declaradas, function (x) { return queDe(x.rasgo) + ' (hasta ' + x.revision + ')'; }, 'ninguna') + ' · vencidas: ' + lista(p.vencidas, function (x) { return queDe(x.rasgo) + ' (' + x.revision + ')'; }, 'ninguna') })));
    });
    if (conAlgo.length) box.appendChild(prods);
    // la misma diferencia declarada en varios grupos va en un solo renglón; Renovar y Cerrar actúan sobre todos sus grupos
    var porRasgo = {}; var orden = [];
    (v.declaradas || []).forEach(function (x) { if (!x || !x.rasgo) return; if (!porRasgo[x.rasgo]) { porRasgo[x.rasgo] = []; orden.push(x.rasgo); } porRasgo[x.rasgo].push(x); });
    var dcl = el('ul', { class: 'renglones' });
    orden.forEach(function (rasgo) {
      var xs = porRasgo[rasgo]; var grupos = xs.map(function (x) { return x.grupo; });
      var fechas = lista(xs, function (x) { return x.revision || 'sin fecha'; }, 'sin fecha');
      var motivos = lista(xs, function (x) { return x.motivo || 'sin motivo'; }, 'sin motivo');
      var fecha = el('input', { placeholder: 'AAAA-MM-DD', 'aria-label': 'Volver a mirar el' }); var motivo = el('input', { placeholder: 'por qué sigue valiendo', 'aria-label': 'Por qué' });
      dcl.appendChild(el('li', {}, el('span', { class: 'quien', text: queDe(rasgo) }), el('span', { class: 'dato' }, el('span', { text: 'en ' + grupos.join(' y ') + ' · volver a mirar el ' + fechas }), el('details', { class: 'mas-info' }, el('summary', { text: 'Por qué' }), el('span', { text: motivos }))), el('span', { class: 'acc' }, fecha, motivo,
        el('button', { class: 'sec', type: 'button', text: 'Renovar', onclick: function () { revisarSeccion(s, { accion: 'renew', grupos: grupos, grupo: grupos[0], rasgo: rasgo, revision: fecha.value, motivo: motivo.value }); } }),
        el('button', { class: 'sec', type: 'button', text: 'Cerrar', onclick: function () { revisarSeccion(s, { accion: 'close', grupos: grupos, grupo: grupos[0], rasgo: rasgo }); } }))));
    });
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Las diferencias aceptadas' }), orden.length ? dcl : el('p', { class: 'muted', text: 'Ninguna.' })));
    if (v.definicion) {
      var t = el('table', { class: 'tabla' }, el('thead', {}, el('tr', {}, el('th', { text: 'Qué se compara' }))));
      var tb = el('tbody', {});
      ((v.definicion.rasgos) || []).forEach(function (r) { if (r && r.id) tb.appendChild(el('tr', {}, el('td', { text: queDe(r.id) }))); });
      t.appendChild(tb);
      box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: 'Qué se compara (se cambia en el repo, no acá)' }), el('div', { class: 'tbl-wrap' }, t)));
    }
    return box;
  }
  function editorPaquetes(s, d, pr) {
    var box = el('div', {});
    var ex = s.extras || {};   // los paquetes de la versión del sitio y los que activa el valor de hoy
    box.appendChild(el('p', { class: 'muted', text: 'Los paquetes suman revisores y guías de un producto o de un cliente. Activos hoy: ' + ((ex.activos || []).join(', ') || 'ninguno') + '.' }));
    d.packs = d.packs || {};
    var actual = Array.isArray(d.packs.default) ? d.packs.default.join(', ') : (d.packs.default || '');
    var val = d.packs.default;
    var modo = val === undefined ? '' : val === 'all' || val === 'none' ? val : 'some';
    box.appendChild(selector('Qué paquetes se activan', modo, [['', 'sin declarar (ninguno)'], ['all', 'todos los instalados'], ['none', 'ninguno'], ['some', 'sólo los que marco']], function (v) {
      if (!v) delete d.packs.default; else if (v === 'some') d.packs.default = Array.isArray(val) ? val : []; else d.packs.default = v;
      render();
    }, 'packs.default', pr));
    if (modo === 'some') {
      var marcados = Array.isArray(val) ? val : [];
      var lista = el('div', { class: 'pila' });
      // un paquete marcado que esta versión no trae se muestra igual, para poder sacarlo
      (ex.instalados || []).concat(marcados.filter(function (n) { return (ex.instalados || []).indexOf(n) < 0; })).forEach(function (n) {
        var c = el('input', { type: 'checkbox', 'aria-label': n, 'data-path': 'packs.default', onchange: function (e) {
          var l = Array.isArray(d.packs.default) ? d.packs.default : [];
          d.packs.default = e.target.checked ? l.concat([n]) : l.filter(function (x) { return x !== n; });
        } });
        c.checked = marcados.indexOf(n) >= 0;
        lista.appendChild(el('label', {}, c, el('span', { text: ' ' + n + ((ex.instalados || []).indexOf(n) < 0 ? ' (esta versión no lo trae)' : '') })));
      });
      box.appendChild(lista);
    }
    return box;
  }
  // un selector con «sin declarar» primero: elegirlo saca la clave del archivo
  function selector(label, valor, opciones, onChange, p, problemas) {
    var sel = el('select', { 'aria-label': label, 'data-path': p, onchange: function (e) { onChange(e.target.value); } });
    opciones.forEach(function (o) { sel.appendChild(el('option', { value: o[0], text: o[1] })); });
    sel.value = valor == null ? '' : String(valor);
    var mios = problemasEn(problemas, p);
    if (mios.length) sel.setAttribute('class', 'bad');
    var box = el('div', { class: 'campo' }, label ? el('label', { text: label }) : null, sel);
    mios.forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  // ── story 2.31: las secciones del perfil que cambian la experiencia de cada dev ──
  // pone o saca (valor vacío) una hoja; el objeto que queda vacío también se saca: no se propone un «{}» que no estaba
  function hoja(d, clave, k, v) {
    if (v === '' || v === undefined || v === null) { if (esObjeto(d[clave])) { delete d[clave][k]; if (!Object.keys(d[clave]).length) delete d[clave]; } return; }
    if (!esObjeto(d[clave])) d[clave] = {};
    d[clave][k] = v;
  }
  var ESTILOS = [['executive', 'ejecutivo: la conclusión primero y sin el cómo, con un tope corto'], ['detailed', 'detallado: la conclusión primero y después el porqué y el cómo'], ['neutral', 'neutro: claro y al punto, sin reglas propias de la organización']];
  function editorRespuesta(s, d, pr) {
    var r = d.response || {}; var ex = s.extras || {}; var vg = ex.vigente || {}; var og = ex.origen || {};
    var box = el('div', { class: 'pila' });
    box.appendChild(el('p', { class: 'muted', text: 'Hoy: ' + vg.style + ' · ' + vg.language + ' · ' + vg.max_chars + ' caracteres (' + (og.style === 'perfil' ? 'del perfil' : 'por defecto') + ')' }));
    box.appendChild(selector('Idioma', r.language, [['', 'sin declarar (castellano)'], ['es', 'castellano'], ['en', 'inglés']], function (v) { hoja(d, 'response', 'language', v); }, 'response.language', pr));
    box.appendChild(selector('Estilo', r.style, [['', 'sin declarar (neutro)']].concat(ESTILOS), function (v) { hoja(d, 'response', 'style', v); }, 'response.style', pr));
    box.appendChild(campo('Largo máximo de prosa, en caracteres (300 a 4000; vacío: el del estilo)', r.max_chars, function (v) { hoja(d, 'response', 'max_chars', v === '' ? '' : numOTexto(v)); }, 'response.max_chars', pr, { inputmode: 'numeric' }));
    return box;
  }
  var INTEGRACIONES = [['clockify', 'Clockify: registra las horas de cada story'], ['engram', 'Memoria entre sesiones (engram)'], ['mailbox', 'Buzón de corridas: cada máquina sube sus corridas al sitio'], ['codex', 'Codex: el arnés también se enchufa a Codex'], ['nightly', 'Procesos de la noche del equipo']];
  function editorIntegraciones(s, d, pr) {
    var i = d.integrations || {};
    var box = el('div', { class: 'pila' });
    INTEGRACIONES.forEach(function (par) {
      var k = par[0];
      var opciones = [['', 'sin declarar (apagada)'], ['true', 'prendida'], ['false', 'apagada']].concat(k === 'codex' ? [['detect', 'prendida si Codex está instalado']] : []);
      box.appendChild(selector(par[1], i[k] === undefined ? '' : String(i[k]), opciones, function (v) { hoja(d, 'integrations', k, v === 'true' ? true : v === 'false' ? false : v); }, 'integrations.' + k, pr));
    });
    box.appendChild(el('p', { class: 'muted', text: 'Telegram y CodeGraph se configuran en cada máquina: son de cada persona, no del equipo.' }));
    return box;
  }
  function editorAdo(s, d, pr) {
    var ex = s.extras || {};
    var box = el('div', { class: 'pila' }, campo('La organización (su dirección en Azure DevOps)', (d.ado || {}).org, function (v) { hoja(d, 'ado', 'org', v); }, 'ado.org', pr));
    if (ex.proyecto) box.appendChild(el('p', { class: 'muted', text: 'El proyecto: ' + ex.proyecto + '.' }));
    if (ex.pedidos) box.appendChild(el('p', { class: 'muted', text: 'Los pedidos de trabajo: ' + ex.pedidos + '.' }));
    return box;
  }
  function editorActualizacion(s, d, pr) {
    var u = d.update || {};
    return el('div', { class: 'pila' },
      selector('Qué versión toma cada máquina', u.channel, [['', 'sin declarar (estable)'], ['latest', 'la última: cada máquina toma lo que entra a la rama principal'], ['stable', 'estable: sólo las versiones marcadas como estables']], function (v) { hoja(d, 'update', 'channel', v); }, 'update.channel', pr),
      selector('Cómo se aplica', u.apply, [['', 'sin declarar (preguntando)'], ['auto', 'sola: la máquina se actualiza al arrancar, sin preguntar'], ['ask', 'preguntando: la máquina avisa y el dev decide cuándo']], function (v) { hoja(d, 'update', 'apply', v); }, 'update.apply', pr));
  }
  function editorInstalacion(s, d, pr) {
    var ex = (s.extras || {}).perfiles || {};
    var box = el('div', { class: 'pila' }, selector('Cuánto instala el arnés', (d.install || {}).profile, [['', 'sin declarar (completo)'], ['full', 'completo'], ['minimal', 'mínimo']], function (v) { hoja(d, 'install', 'profile', v); }, 'install.profile', pr));
    if (ex.motivo) box.appendChild(aviso('bad', 'No se pudo leer qué trae cada perfil.', ex.motivo));
    var min = ex.minimal || []; var full = ex.full || [];
    var clave = function (f) { return f.title + '\u0000' + f.does; };
    var enMin = {}; min.forEach(function (f) { enMin[clave(f)] = true; });
    var suma = full.filter(function (f) { return !enMin[clave(f)]; });
    box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: 'El mínimo trae ' + min.length + ' cosas' }), porGrupo(min)));
    box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: 'El completo suma estas ' + suma.length }), porGrupo(suma)));
    return box;
  }
  // los grupos de lo que instala el arnés, en el orden en que se muestran; uno que la pantalla no conoce va al final
  var GRUPOS = [['safety', 'Frenos de seguridad'], ['assistant', 'Cómo contesta y trabaja el asistente'], ['notices', 'Avisos al arrancar y al trabajar'], ['pipeline', 'Revisores y pipeline'],
    ['memory', 'Memoria entre sesiones'], ['time', 'Registro de tiempo'], ['install', 'Instalación y actualización'], ['codex', 'Codex']];
  /** Si viene prendida o apagada y dónde se cambia: lo de la organización, en Configuración; lo de una máquina, se dice. */
  function dondeSeCambia(f) {
    var pestana = function (idSeccion) { var t = PESTANAS.filter(function (p) { return p[2].indexOf(idSeccion) >= 0; })[0]; return t ? t[1] + ' → ' : ''; };
    var base = f.default === 'off' ? 'Viene apagado. ' : String(f.when || '').indexOf('integration:') === 0 ? 'Viene con su integración. ' : 'Viene prendido. ';
    if (f.site_section) return base + 'Se cambia en Configuración → ' + pestana(f.site_section) + (PLANO[f.site_section] ? PLANO[f.site_section].corto : f.site_section) + '.';
    var resto = f.switch ? 'Sólo en tu máquina, con ' + f.switch + '.' : 'Es parte del arnés: no se apaga.';
    var pend = f.site_pending ? ' Pendiente: que se pueda cambiar desde Configuración → ' + ((PESTANAS.filter(function (p) { return p[0] === f.site_pending; })[0] || [])[1] || f.site_pending) + '.' : '';
    return base + resto + pend;
  }
  function porGrupo(lista) {
    var cont = el('div', { class: 'pila' });
    var conocidos = GRUPOS.map(function (g) { return g[0]; });
    GRUPOS.concat([[null, 'Otras']]).forEach(function (g) {
      var xs = lista.filter(function (f) { return g[0] ? f.group === g[0] : conocidos.indexOf(f.group) < 0; });
      if (!xs.length) return;
      var ul = el('ul', { class: 'efectos' });
      xs.forEach(function (f) { ul.appendChild(el('li', {}, el('details', {}, el('summary', { text: f.title }), el('p', { text: f.does }), el('p', { class: 'muted', text: dondeSeCambia(f) })))); });
      cont.appendChild(el('details', { class: 'grupo' }, el('summary', { text: g[1] + ' (' + xs.length + ')' }), ul));
    });
    if (!lista.length) cont.appendChild(el('p', { class: 'muted', text: 'Nada.' }));
    return cont;
  }
  // la marca: nombre, logo (una ruta del repo de operaciones) y qué hacer con el logo en el tema oscuro
  function editorOrganizacion(s, d, pr) {
    var b = esObjeto(d.site) && esObjeto(d.site.brand) ? d.site.brand : {};
    var poner = function (k, v) {
      if (v === '' || v == null) { if (esObjeto(d.site) && esObjeto(d.site.brand)) { delete d.site.brand[k]; if (!Object.keys(d.site.brand).length) delete d.site.brand; } return; }
      if (!esObjeto(d.site)) d.site = {};
      if (!esObjeto(d.site.brand)) d.site.brand = {};
      d.site.brand[k] = v;
    };
    var box = el('div', { class: 'pila' },
      campo('El nombre de la organización', b.name, function (v) { poner('name', String(v).trim()); }, 'site.brand.name', pr, { placeholder: 'como querés que se lea en la barra y en el pie' }),
      campo('El logo: su ruta en el repo de operaciones (.png o .svg)', b.logo, function (v) { poner('logo', String(v).trim()); }, 'site.brand.logo', pr, { placeholder: 'marca/logo.png' }),
      selector('En el tema oscuro', b.dark, [['', 'sin declarar (invertirlo)'], ['invert', 'invertirlo: para un logo oscuro sobre fondo claro'], ['keep', 'dejarlo como está: para un logo de colores']], function (v) { poner('dark', v); }, 'site.brand.dark', pr));
    box.appendChild(el('p', { class: 'muted', text: 'El archivo del logo entra con un pedido al repo de operaciones; acá sólo se elige cuál se muestra. Sin logo, la barra muestra el nombre.' }));
    if (b.logo) box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Así se ve hoy' }), el('img', { class: 'logo logo-previa' + (b.dark === 'keep' ? '' : ' invierte'), src: '/marca/logo', alt: b.name || 'el logo de la organización' })));
    return box;
  }
  function editorHilos(s, d, pr) {
    var mb = (d.site || {}).mailbox || {};
    return el('div', { class: 'pila' }, selector('Bajar las conversaciones', mb.threads === undefined ? '' : String(mb.threads), [['', 'sin declarar (no)'], ['true', 'sí: baja también lo que se habló en cada corrida; ocupa más y muestra más'], ['false', 'no: sólo los números de cada corrida']], function (v) {
      if (!esObjeto(d.site)) d.site = {};
      if (v === '') { if (esObjeto(d.site.mailbox)) delete d.site.mailbox.threads; return; }
      if (!esObjeto(d.site.mailbox)) d.site.mailbox = {};
      d.site.mailbox.threads = v === 'true';
    }, 'site.mailbox.threads', pr));
  }
  function editorAplicar(s, d, pr) {
    var st = d.site || {};
    return el('div', { class: 'pila' }, selector('Los cambios de quien mantiene el sitio', st.auto_apply === undefined ? '' : String(st.auto_apply), [['', 'sin declarar (no)'], ['true', 'sí: se aplican solos; el sitio aprueba y completa el pedido, si las políticas del repo lo dejan'], ['false', 'no: queda el pedido para aprobar']], function (v) {
      if (!esObjeto(d.site)) d.site = {};
      if (v === '') { delete d.site.auto_apply; return; }
      d.site.auto_apply = v === 'true';
    }, 'site.auto_apply', pr), el('p', { class: 'muted', text: 'Queda escrito quién pidió cada cambio: en el pedido y en el registro del sitio.' }));
  }
  // lo que trae la organización en el repo del equipo (AC 17): se mira y se abre en el repo, no se edita acá
  function tablaDeContenido(filas) {
    var sec = el('section', { class: 'card form-block', id: 'contenido' }, el('div', { class: 'fb-head' }, el('div', {}, el('h4', { text: 'Lo que trae la organización' }), el('p', { class: 'reach', text: 'Skills, revisores, guías de alta y paquetes del repo del equipo. Se cambian con un pedido en ese repo, no desde acá.' }))));
    if (!filas || !filas.length) { sec.appendChild(el('p', { class: 'muted', text: filas ? 'Nada que mostrar.' : 'El repo del equipo todavía no se bajó.' })); return sec; }
    var tabla = el('table', { class: 'tabla' }); var thead = el('thead', {}); var tr = el('tr', {});
    ['Qué es', 'Dónde está'].forEach(function (t) { tr.appendChild(el('th', { text: t })); }); thead.appendChild(tr); tabla.appendChild(thead);
    var tbody = el('tbody', {});
    filas.forEach(function (f) { var ruta = f.enlace ? el('a', { href: f.enlace, text: f.ruta }) : el('span', { text: f.ruta }); tbody.appendChild(el('tr', {}, el('td', { text: f.tipo }), el('td', {}, ruta))); });
    tabla.appendChild(tbody); sec.appendChild(el('div', { class: 'tbl-wrap' }, tabla));
    return sec;
  }
  // ── los nombres en lugar de los números: los pipelines de un proyecto y los nombres de los pasos, pedidos una vez ──
  var PIPES = {}; var PASOS = {};
  /** Los pipelines de un proyecto de Azure DevOps: null sin organización o proyecto; { estado: 'cargando' | 'listo', r }. */
  function pipelinesDe(org, proyecto) {
    if (!org || !proyecto) return null;
    var k = org + '\u0000' + proyecto;
    if (!PIPES[k]) { PIPES[k] = { estado: 'cargando' }; api('/pipelines', { org: org, project: proyecto }).then(function (r) { PIPES[k] = { estado: 'listo', r: r }; render(); }); }
    return PIPES[k];
  }
  function listaDePipelines(L) { return L && L.estado === 'listo' && L.r && L.r.ok && Array.isArray(L.r.pipelines) ? L.r.pipelines : null; }
  /** Los nombres de los pasos de un pipeline guardado («proyecto/nombre»): {} mientras no se sepan. */
  function pasosDe(pipeline) {
    if (!pipeline) return {};
    if (!PASOS[pipeline]) { PASOS[pipeline] = { nombres: {} }; api('/pasos', { pipeline: pipeline }).then(function (r) { if (r && r.ok && r.nombres && typeof r.nombres === 'object') { PASOS[pipeline] = { nombres: r.nombres }; render(); } }); }
    return PASOS[pipeline].nombres;
  }
  // el pipeline de pruebas completas de un repo: en Azure se elige de la lista del proyecto por su nombre y se guarda su
  // número; sin la lista, se escribe el número y la pantalla dice por qué. En GitHub es el nombre del control obligatorio
  function campoPipeline(e, p, pr) {
    var r = e.repo || {};
    var escribir = function (v) { var t = String(v).trim(); if (!t) delete e.full_tests_pipeline; else e.full_tests_pipeline = /^\d+$/.test(t) && r.platform === 'azure' ? Number(t) : t; };
    if (r.platform !== 'azure') return campo('Control obligatorio de las pruebas completas', e.full_tests_pipeline, escribir, p, pr, { placeholder: 'el nombre del control en GitHub' });
    var L = pipelinesDe(r.org, r.project);
    var lista = listaDePipelines(L);
    var actual = e.full_tests_pipeline;
    if (lista) {
      var porNombre = lista.filter(function (x) { return x.nombre === actual; })[0];
      var valor = actual == null ? '' : porNombre ? String(porNombre.id) : String(actual);
      var opciones = [['', 'ninguno']].concat(lista.map(function (x) { return [String(x.id), x.nombre + (x.carpeta ? ' · ' + x.carpeta : '')]; }));
      if (valor && !lista.some(function (x) { return String(x.id) === valor; })) opciones.push([valor, (typeof actual === 'number' ? 'el pipeline ' + actual : actual) + ' (no está en el proyecto)']);
      return selector('Pipeline de pruebas completas', valor, opciones, function (v) { if (!v) delete e.full_tests_pipeline; else e.full_tests_pipeline = /^\d+$/.test(v) ? Number(v) : v; }, p, pr);
    }
    var box = campo('Pipeline de pruebas completas (su número)', actual, escribir, p, pr, { placeholder: 'número del pipeline', inputmode: 'numeric' });
    if (!L) box.appendChild(el('p', { class: 'muted', text: 'Completá la organización y el proyecto del repo y revisá: la lista de pipelines aparece sola.' }));
    else if (L.estado === 'cargando') box.appendChild(el('p', { class: 'muted', text: 'buscando los pipelines del proyecto…' }));
    else box.appendChild(el('div', { class: 'aviso', text: (L.r && L.r.message) || 'no se pudo traer la lista de pipelines: escribí el número' }));
    return box;
  }
  var REGLAS = [['automatico', 'automático: el servidor, si la rama lo exige'], ['siempre-en-la-maquina', 'siempre en la máquina'], ['confiar-en-el-servidor', 'confiar en el servidor']];
  function editorSuites(s, d, pr) {
    MOSTRADOS = [];
    var box = el('div', { class: 'pila' });
    // con otra forma (no es un objeto, repos no es una lista, una entrada no es un objeto) se edita sólo como texto
    if ('merge_suites' in d && (!esObjeto(d.merge_suites) || (d.merge_suites.repos !== undefined && (!Array.isArray(d.merge_suites.repos) || d.merge_suites.repos.some(function (e) { return !esObjeto(e); }))))) {
      box.appendChild(el('p', { class: 'muted', text: 'Esta parte del archivo no tiene la forma que entiende la pantalla: se corrige como texto.' }));
      box.appendChild(restoYTexto(s, d, pr, 'merge_suites', 'Las suites al mergear, como texto'));
      return box;
    }
    d.merge_suites = d.merge_suites || {};
    var ms = d.merge_suites;
    box.appendChild(selector('La regla de la organización', ms.default, [['', 'sin declarar: automático']].concat(REGLAS), function (v) { if (v) ms.default = v; else delete ms.default; }, 'merge_suites.default', pr));
    var sub = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Por repo' }), el('p', { class: 'sub-d', text: 'Un repo que no sigue la regla de la organización, o que nombra su pipeline de pruebas completas.' }));
    ms.repos = ms.repos || [];
    if (!ms.repos.length) sub.appendChild(el('p', { class: 'muted', text: 'Ningún repo todavía.' }));
    ms.repos.forEach(function (e, i) {
      var at = 'merge_suites.repos.' + i;
      sub.appendChild(repoFila('Repo ' + (i + 1), '', e.repo, function (v) { e.repo = v; }, at + '.repo', pr));
      sub.appendChild(el('div', { class: 'fila quitar3' },
        selector('Regla', e.rule, [['', 'la de la organización']].concat(REGLAS), function (v) { if (v) e.rule = v; else delete e.rule; }, at + '.rule', pr),
        campoPipeline(e, at + '.full_tests_pipeline', pr),
        quitar(function () { ms.repos.splice(i, 1); render(); })));
      problemasEn(pr, at).forEach(function (x) { sub.appendChild(el('div', { class: 'err', text: x.message })); });
    });
    sub.appendChild(el('button', { class: 'mas', type: 'button', text: '+ Agregar repo', onclick: function () { ms.repos.push({ repo: { platform: 'azure', org: '', project: '', repo: '' }, rule: 'automatico' }); render(); } }));
    box.appendChild(sub);
    problemasEn(pr, 'merge_suites.repos').forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    box.appendChild(restoYTexto(s, d, pr, 'merge_suites', 'Las suites al mergear, como texto'));
    return box;
  }
  var MODELOS = ['haiku', 'sonnet', 'opus', 'fable'];
  // el nombre llano de cada revisor, por su identificador sin el prefijo de quien lo publica; uno que no está acá se
  // muestra con su identificador
  var REVISOR = {
    'ac-coverage-checker': 'Que cada criterio de la story esté hecho', 'deferral-tracker': 'Lo que la story dejó para después',
    'dod-runtime-checker': 'Que se probó andando, no sólo en el código', 'e2e-realness-checker': 'Que las pruebas de punta a punta prueben de verdad',
    'plugin-security-basics': 'Seguridad básica del cambio', 'plugin-tests-coverage': 'Que las pruebas cubran lo pedido',
    'retrospective-capturer': 'Lo aprendido después de cada merge', 'signed-scope-audit': 'El plan contra lo firmado con el cliente',
    'silent-failure-hunter': 'Fallas que pasan en silencio', 'spec-first-checker': 'Que no se haga más que lo pedido',
    'story-validator': 'Que la story esté completa antes de empezar', 'llm-cost-reviewer': 'Costo del uso de modelos de lenguaje',
    'i18n-hardcoded-text-reviewer': 'Textos escritos fijos donde va la traducción',
    'plugin-dotnet-conventions': 'Convenciones de los backends .NET', 'plugin-react-conventions': 'Convenciones de los formularios React',
    'plugin-nextjs-conventions': 'Convenciones de Next.js', 'sibling-pattern-reviewer': 'Que siga lo que ya resolvieron los plugins hermanos',
    'feature-wiring-checker': 'Que lo hecho esté conectado y se use',
  };
  function nombreRevisor(id) { var n = REVISOR[id] || REVISOR[String(id).slice(String(id).indexOf('-') + 1)]; return n ? n + ' (' + id + ')' : id; }
  // el modelo de un revisor en particular: una fila por revisor, elegido de los que conoce esta versión
  function editorPorRevisor(s, m, pr, hoy) {
    var sub = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Un revisor en particular' }), el('p', { class: 'sub-d', text: 'Opcional: un revisor que usa otro modelo que el resto.' + (hoy && hoy.reviewer && Object.keys(hoy.reviewer).length ? ' Hoy: ' + Object.keys(hoy.reviewer).map(function (k) { return nombreRevisor(k) + ' → ' + hoy.reviewer[k]; }).join(', ') + '.' : '') }));
    var rv = m.reviewer && typeof m.reviewer === 'object' && !Array.isArray(m.reviewer) ? m.reviewer : null;
    if (m.reviewer !== undefined && !rv) { sub.appendChild(editorGenerico(s, m, pr, 'reviewer', 'Revisor y modelo, como texto')); return sub; }
    Object.keys(rv || {}).forEach(function (id) {
      sub.appendChild(el('div', { class: 'fila quitar3' }, el('span', { class: 'k', text: nombreRevisor(id) }),
        selector('', rv[id], MODELOS.map(function (x) { return [x, x]; }), function (v) { rv[id] = v; }, 'models.reviewer.' + id, pr),
        quitar(function () { delete rv[id]; if (!Object.keys(rv).length) delete m.reviewer; render(); })));
    });
    var conocidos = ((s.extras && s.extras.revisores) || []).filter(function (id) { return !rv || !(id in rv); });
    if (conocidos.length) {
      var elegir = el('select', { 'aria-label': 'Revisor' }, el('option', { value: '', text: 'elegí un revisor' }));
      conocidos.forEach(function (id) { elegir.appendChild(el('option', { value: id, text: nombreRevisor(id) })); });
      sub.appendChild(el('div', { class: 'fila quitar' }, elegir, el('button', { class: 'sec', type: 'button', text: '+ Agregar', onclick: function () { if (!elegir.value) return; m.reviewer = rv || {}; m.reviewer[elegir.value] = 'sonnet'; render(); } })));
    }
    problemasEn(pr, 'models.reviewer').forEach(function (x) { sub.appendChild(el('div', { class: 'err', text: x.message })); });
    return sub;
  }
  function editorModelos(s, d, pr) {
    MOSTRADOS = [];
    var hoy = (s.extras && s.extras.hoy) || null;
    var box = el('div', { class: 'pila' });
    if ('models' in d && !esObjeto(d.models)) {
      box.appendChild(el('p', { class: 'muted', text: 'Esta parte del archivo no tiene la forma que entiende la pantalla: se corrige como texto.' }));
      box.appendChild(restoYTexto(s, d, pr, 'models', 'Los modelos, como texto'));
      return box;
    }
    d.models = d.models || {};
    var m = d.models;
    if (!hoy) box.appendChild(el('p', { class: 'muted', text: 'No sé los modelos de hoy (' + ((s.extras && s.extras.motivoHoy) || 'sin motivo') + '): «sin declarar» usa los de cada máquina.' }));
    function opciones(h) { return [['', 'sin declarar' + (h ? ' (hoy: ' + h + ')' : '')]].concat(MODELOS.map(function (x) { return [x, x]; })); }
    function de(obj, k) { return obj && typeof obj === 'object' ? obj[k] : undefined; }
    function uno(label, k, sub) {
      var actual = sub ? de(m[k], sub) : m[k];
      var h = sub ? de(de(hoy, k), sub) : de(hoy, k);
      var p = 'models.' + k + (sub ? '.' + sub : '');
      return selector(label, actual, opciones(h), function (v) {
        if (!sub) { if (v) m[k] = v; else delete m[k]; return; }
        m[k] = m[k] && typeof m[k] === 'object' ? m[k] : {};
        if (v) m[k][sub] = v; else { delete m[k][sub]; if (!Object.keys(m[k]).length) delete m[k]; }
      }, p, pr);
    }
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Los revisores' }), uno('Primera vuelta', 'reviewers'), uno('Las vueltas siguientes', 'reviewers_reloop')));
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'El pase adversarial' }), uno('Una story normal', 'adversarial', 'model'), uno('Una story pesada', 'adversarial', 'heavy'),
      selector('Preguntar antes de usar fable', de(m.adversarial, 'fable_question'), [['', 'sin declarar' + (de(de(hoy, 'adversarial'), 'fable_question') ? ' (hoy: ' + (de(de(hoy, 'adversarial'), 'fable_question') === 'ask' ? 'preguntar' : 'nunca') + ')' : '')], ['ask', 'preguntar'], ['never', 'nunca']], function (v) {
        m.adversarial = m.adversarial && typeof m.adversarial === 'object' ? m.adversarial : {};
        if (v) m.adversarial.fable_question = v; else { delete m.adversarial.fable_question; if (!Object.keys(m.adversarial).length) delete m.adversarial; }
      }, 'models.adversarial.fable_question', pr)));
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Los ayudantes y la sesión' }), uno('Los ayudantes', 'helpers'), uno('Sesión, story liviana', 'session', 'low'), uno('Sesión, story normal', 'session', 'normal'), uno('Sesión, story pesada', 'session', 'heavy')));
    var techo = el('input', { type: 'checkbox', 'aria-label': 'Techo obligatorio', 'data-path': 'models.mandatory_ceiling', onchange: function (e) { if (e.target.checked) m.mandatory_ceiling = true; else { delete m.mandatory_ceiling; delete m.ceiling; } render(); } });
    techo.checked = m.mandatory_ceiling === true;
    var tbox = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Techo obligatorio' }), el('p', { class: 'sub-d', text: 'Lo paga la organización: ningún trabajo pasa de este modelo, aunque se pida.' }), el('label', {}, techo, el('span', { text: ' ningún trabajo pasa de…' })));
    if (m.mandatory_ceiling === true) tbox.appendChild(selector('El techo', m.ceiling, [['', 'elegí uno']].concat(MODELOS.map(function (x) { return [x, x]; })), function (v) { if (v) m.ceiling = v; else delete m.ceiling; }, 'models.ceiling', pr));
    problemasEn(pr, 'models.mandatory_ceiling').forEach(function (x) { tbox.appendChild(el('div', { class: 'err', text: x.message })); });
    box.appendChild(tbox);
    box.appendChild(editorPorRevisor(s, m, pr, hoy));
    box.appendChild(restoYTexto(s, d, pr, 'models', 'Los modelos, como texto'));
    return box;
  }
  // el plazo del aviso de espera (story 7.20): minutos enteros de 1 a 120; vacío, el de siempre (5)
  function editorEspera(s, d, pr) {
    var w = esObjeto(d.wait_notice) ? d.wait_notice : {};
    return el('div', { class: 'pila' }, campo('Minutos que espera una corrida antes de avisar (1 a 120; vacío: 5)', w.minutes, function (v) {
      if (v === '') { if (esObjeto(d.wait_notice)) { delete d.wait_notice.minutes; if (!Object.keys(d.wait_notice).length) delete d.wait_notice; } return; }
      if (!esObjeto(d.wait_notice)) d.wait_notice = {};
      d.wait_notice.minutes = numOTexto(v);
    }, 'wait_notice.minutes', pr, { inputmode: 'numeric' }));
  }
  // el umbral de cobertura: un porcentaje entero de 1 a 100; vacío, el de siempre (75)
  function editorCobertura(s, d, pr) {
    var c = esObjeto(d.coverage) ? d.coverage : {};
    return el('div', { class: 'pila' }, campo('Porcentaje mínimo de las líneas nuevas cubiertas por pruebas (1 a 100; vacío: 75)', c.min_touched_lines_pct, function (v) {
      if (v === '') { if (esObjeto(d.coverage)) { delete d.coverage.min_touched_lines_pct; if (!Object.keys(d.coverage).length) delete d.coverage; } return; }
      if (!esObjeto(d.coverage)) d.coverage = {};
      d.coverage.min_touched_lines_pct = numOTexto(v);
    }, 'coverage.min_touched_lines_pct', pr, { inputmode: 'numeric' }));
  }
  var EDITORES = { organizacion: editorOrganizacion, espera: editorEspera, cobertura: editorCobertura, respuesta: editorRespuesta, integraciones: editorIntegraciones, ado: editorAdo, actualizacion: editorActualizacion, instalacion: editorInstalacion, hilos: editorHilos, aplicar: editorAplicar, suites: editorSuites, modelos: editorModelos, paquetes: editorPaquetes, repos: editorRepos, responsables: editorResponsables, despliegues: editorDespliegues, canal: function (s, d, pr) { return editorGenerico(s, d, pr, 'notify', 'El canal, como texto'); }, personas: editorPersonas, sitio: editorSitio, umbrales: editorUmbrales, paridad: editorParidad };

  // los editores de suites y modelos arman objetos vacíos para tener dónde escribir: no se mandan. Una clave vacía en el
  // archivo pediría al perfil una versión más nueva sin cambiar nada
  function vacio(v) { return v && typeof v === 'object' && !Array.isArray(v) ? !Object.keys(v).length : Array.isArray(v) && !v.length; }
  // Lo que ya estaba en el archivo se respeta aunque esté vacío: para el merge, «merge_suites: {}» no es lo mismo que no
  // tenerla (con la clave, la regla es «automatico»; sin ella, cada repo sigue su merge.mode)
  function sinVacios(s, b) {
    var clave = s.id === 'suites' ? 'merge_suites' : s.id === 'modelos' ? 'models' : null;
    if (!clave || !esObjeto(b) || !esObjeto(b[clave])) return b;
    var orig = esObjeto(S.originales[s.id]) ? S.originales[s.id] : {};
    var antes = esObjeto(orig[clave]) ? orig[clave] : null;
    var o = copia(b); var v = o[clave];
    Object.keys(v).forEach(function (k) { if (vacio(v[k]) && !(antes && k in antes)) delete v[k]; });
    if (vacio(v) && !(clave in orig)) delete o[clave];
    return o;
  }
  function revisarSeccion(s, borrador) {
    return api('/revisar', { seccion: s.id, borrador: sinVacios(s, borrador === undefined ? S.borradores[s.id] : borrador) }).then(function (r) {
      S.problemas[s.id] = llanos(r.problems); S.avisos[s.id] = llanos(r.avisos);
      if (r.borrador) S.borradores[s.id] = r.borrador;
      S.textos[s.id] = r.ok ? r.texto : null;
      S.notas[s.id] = r.ok ? { ok: true, text: 'Revisado: está bien escrito.' + (r.aviso ? ' ' + r.aviso : '') + (r.advertencia ? ' ' + r.advertencia : '') } : { ok: false, text: mensajeLlano(r.message) || 'Hay que corregir lo marcado.' };
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
  /** Por qué no se puede proponer, en llano; el motivo exacto del sitio queda en el detalle. */
  function motivoProponer(m) {
    if (!m || /identidad de escritura/.test(m)) return 'Para proponer desde acá, el sitio necesita permiso para escribir en el repo. Mientras tanto: revisá, descargá y subilo a mano.';
    if (/plataforma/.test(m)) return 'El sitio no reconoce dónde vive el repo. Revisá, descargá y subilo a mano.';
    return 'Proponer desde acá no está disponible: ' + m;
  }
  /** Qué pasa al proponer: se aplica solo (la opción de la organización, con políticas que el sitio cumple) o queda el pedido. */
  function textoProponer(s, prop) {
    var repo = REPO_DE[s.repo] || 'su repo';
    if (prop && prop.aplicaSolo) return 'Se aplica solo: el sitio aprueba y completa el pedido en ' + repo + '.';
    return 'Se abre un pedido de cambio en ' + repo + '. ' + (prop && prop.motivoAplicar ? prop.motivoAplicar : 'Entra cuando alguien lo aprueba.');
  }
  function seccion(s) {
    var p = plano(s);
    var est = estadoDe(s);
    var sec = el('section', { class: 'card form-block', id: 'seccion-' + s.id }, el('div', { class: 'fb-head' }, el('div', {}, el('h4', { text: p.t }), el('p', { class: 'reach', text: p.d })), el('span', { class: 'pill ' + est[0], text: est[1] })));
    if (s.estado === 'no_reader') { sec.appendChild(aviso('nm', 'Esta versión del arnés todavía no sabe leer esta parte. Se habilita sola cuando el sitio se actualice.', s.motivo)); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'ilegible') { sec.appendChild(aviso('bad', 'Lo guardado en esta parte no se puede leer: hay que arreglarlo a mano en el repo.', s.motivo)); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'no_configurado') { sec.appendChild(aviso('nm', 'Esta parte todavía no está configurada.', s.motivo)); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'nuevo') sec.appendChild(el('p', { class: 'muted', text: 'Todavía no hay nada guardado: se crea con el primer cambio que propongas.' }));
    if (s.soloLectura) sec.appendChild(aviso('nm', 'Por ahora se puede mirar, pero no cambiar.', s.motivo));
    var pr = S.problemas[s.id] || [];
    var arriba = pr.filter(function (x) { return x.sinCampo; });
    if (arriba.length) { var ul = el('ul', { class: 'renglones' }); arriba.forEach(function (x) { ul.appendChild(el('li', { class: 'err', text: (x.donde ? x.donde + ': ' : '') + x.message })); }); sec.appendChild(ul); }
    var editor = EDITORES[s.id];
    if (editor) { SOLO_LECTURA = !!s.soloLectura; try { sec.appendChild(editor(s, S.borradores[s.id], pr)); } finally { SOLO_LECTURA = false; } }
    var n = S.notas[s.id];
    var prop = S.extras.proponer && S.extras.proponer[s.repo];
    // story 2.30: con una política con filtro de ruta, el estado del archivo de la sección manda sobre el del repo
    if (prop && prop.porArchivo && prop.porArchivo[s.archivo]) prop = prop.porArchivo[s.archivo];
    var habilitado = prop && prop.habilitado;
    var confirmando = n && n.confirmar;
    if (!confirmando && n && n.text) {
      var nota = el('div', { class: 'msg ' + (n.ok ? 'ok' : 'bad') }, el('b', { text: n.text }));
      if (n.enlace) nota.appendChild(el('a', { href: n.enlace, text: 'Ver el pedido de cambio' }));
      sec.appendChild(nota);
    }
    if (!s.soloLectura && !bloqueada(s) && s.id !== 'paridad') {
      var bar = el('div', { class: 'bar' }, el('button', { class: 'sec', type: 'button', text: 'Revisar cambios', onclick: function () { revisarSeccion(s); } }));
      bar.appendChild(el('button', { class: 'sec', type: 'button', text: 'Descargar', disabled: S.textos[s.id] ? undefined : 'disabled', onclick: function () { descargar(s); } }));
      if (habilitado) bar.appendChild(el('button', { type: 'button', text: 'Proponer el cambio', disabled: S.textos[s.id] ? undefined : 'disabled', onclick: function () { S.notas[s.id] = { confirmar: true }; render(); } }));
      bar.appendChild(el('span', { class: 'por-que', text: !habilitado ? motivoProponer(prop && prop.motivo) : (S.textos[s.id] ? textoProponer(s, prop) : 'Primero revisá: así sabés si está bien antes de proponerlo.') }));
      if (!confirmando) sec.appendChild(bar);
    }
    if (s.id === 'paridad' && S.textos[s.id] && habilitado && !confirmando) sec.appendChild(el('div', { class: 'bar' }, el('button', { type: 'button', text: 'Proponer el cambio', onclick: function () { S.notas[s.id] = { confirmar: true }; render(); } })));
    if (confirmando) {
      sec.appendChild(el('div', { class: 'antes-despues' },
        el('div', {}, el('div', { class: 'lab', text: 'Hoy' }), el('pre', { text: s.texto || '(todavía no hay nada guardado)' })),
        el('div', {}, el('div', { class: 'lab', text: 'Después del cambio' }), el('pre', { text: S.textos[s.id] }))));
      sec.appendChild(el('div', { class: 'bar' }, el('button', { type: 'button', text: 'Confirmar y proponer', onclick: function () {
        S.notas[s.id] = { ok: true, text: 'proponiendo…' }; render();
        api('/proponer', { seccion: s.id, texto: S.textos[s.id], oid: s.oid }).then(function (r) { S.notas[s.id] = { ok: r.ok, text: r.message, enlace: r.enlace || null }; render(); if (r.ok) cargar(); });
      } }), el('button', { class: 'sec', type: 'button', text: 'Cancelar', onclick: function () { S.notas[s.id] = null; render(); } }), el('span', { class: 'por-que', text: 'Mirá la diferencia antes de confirmar.' })));
    }
    return sec;
  }
  function tablaDeMirar(titulo, ayuda, filas, columnas, id) {
    var sec = el('section', { class: 'card form-block', id: id }, el('div', { class: 'fb-head' }, el('div', {}, el('h4', { text: titulo }), el('p', { class: 'reach', text: ayuda }))));
    if (!filas || !filas.length) { sec.appendChild(el('p', { class: 'muted', text: 'Nada que mostrar.' })); return sec; }
    var tabla = el('table', { class: 'tabla' }); var thead = el('thead', {}); var tr = el('tr', {});
    columnas.forEach(function (c) { tr.appendChild(el('th', { text: c[1] })); }); thead.appendChild(tr); tabla.appendChild(thead);
    var tbody = el('tbody', {});
    filas.forEach(function (f) { var r = el('tr', {}); columnas.forEach(function (c) { var v = f[c[0]]; r.appendChild(el('td', { text: v == null ? '—' : String(v) })); }); tbody.appendChild(r); });
    tabla.appendChild(tbody); sec.appendChild(el('div', { class: 'tbl-wrap' }, tabla));
    return sec;
  }
  function kpi(clase, href, lab, val, den) {
    var a = el(href ? 'a' : 'div', { class: 'card kpi ' + clase, href: href || undefined }, el('span', { class: 'lab', text: lab }), el('span', { class: 'val', text: String(val) }), el('span', { class: 'den', text: den }));
    return a;
  }
  function render() {
    var ex = S.extras || {};
    var porId = {}; S.secciones.forEach(function (s) { porId[s.id] = s; });
    var partes = [];
    // el resumen: lo que pide atención, primero
    var personas = porId.personas;
    var porConfirmar = personas && personas.extras ? (personas.extras.porConfirmar || []).length : 0;
    var aCorregir = S.secciones.filter(function (s) { var e = estadoDe(s)[0]; return e === 'warn' || e === 'bad'; }).filter(function (s) { return s.id !== 'personas' || (S.problemas[s.id] || []).length; });
    var alDia = S.secciones.filter(function (s) { return estadoDe(s)[0] === 'ok'; }).length;
    var viejas = (ex.versiones || []).filter(function (v) { return v.estado === 'atrasada' || v.estado === 'sin_noticias'; }).length;
    partes.push(el('div', { class: 'grid' },
      kpi(porConfirmar ? 'st-warn' : 'st-good', '#seccion-personas', 'Máquinas por confirmar', porConfirmar, porConfirmar ? 'piden que digas de quién son' : 'todas a nombre de alguien'),
      kpi(aCorregir.length ? 'st-warn' : 'st-good', aCorregir.length ? '#seccion-' + aCorregir[0].id : null, 'Secciones con algo para arreglar', aCorregir.length, aCorregir.length ? aCorregir.map(function (s) { return plano(s).corto; }).join(', ') : 'ninguna'),
      kpi('st-good', null, 'Secciones al día', alDia + ' de ' + S.secciones.length, 'sin nada pendiente'),
      kpi(viejas ? 'st-warn' : '', '#versiones', 'Máquinas con una versión vieja o sin noticias', viejas, 'de ' + (ex.versiones || []).length + ' que informan')));
    var prod = tablaDeMirar('Productos', 'Los que revisa la noche. Se agregan en la lista de la revisión de dependencias.', (ex.productos || []).map(function (p) { return { producto: p.producto, origen: p.origen === 'deployments' ? 'Despliegues' : 'revisión de dependencias', repo: p.repo || p.ruta, estado: p.activo === false ? 'apagado' + (p.motivo ? ' (' + p.motivo + ')' : '') : 'activo', edita: p.origen === 'deployments' ? 'sí, en Despliegues' : 'no' }; }), [['producto', 'Producto'], ['origen', 'De dónde sale'], ['repo', 'Repo'], ['estado', 'Estado'], ['edita', 'Se cambia acá']], 'productos');
    if (ex.productosMotivo) prod.appendChild(aviso('bad', 'La lista de productos no se pudo leer: los de la revisión de dependencias no se muestran.', ex.productosMotivo));
    if (ex.productosEnlace) prod.appendChild(el('p', {}, el('a', { class: 'enlace-fuerte', href: ex.productosEnlace, text: 'Abrir la lista de la revisión de dependencias →' })));
    var ver = tablaDeMirar('Qué versión del arnés tiene cada máquina', 'La que informó cada una con su última corrida. Se actualizan solas al arrancar.', (ex.versiones || []).map(function (v) { return { maquina: v.maquina, persona: v.persona || 'sin confirmar', version: v.version, dia: v.diaTexto, texto: v.texto }; }), [['maquina', 'Máquina'], ['persona', 'Persona'], ['version', 'Versión'], ['dia', 'Última noticia'], ['texto', 'Estado']], 'versiones');
    if (ex.versionesMotivo) ver.appendChild(aviso('bad', 'No se pudo leer lo que informan las máquinas: la versión de cada una no se sabe.', ex.versionesMotivo));
    var tablas = { productos: prod, versiones: ver };
    if (ex.contenido !== undefined) tablas.contenido = tablaDeContenido(ex.contenido);
    // lo pendiente de las tablas para mirar: una lista que no se pudo leer, o máquinas atrasadas
    var pendTabla = { productos: ex.productosMotivo ? 1 : 0, versiones: (ex.versionesMotivo ? 1 : 0) + viejas, contenido: 0 };
    var activa = S.pestana || PESTANAS[0][0];
    var barra = el('nav', { class: 'pestanas', role: 'tablist', 'aria-label': 'Partes de la configuración' });
    var paneles = [];
    var vistas = {};
    PESTANAS.forEach(function (p, i) {
      var ids = p[2].filter(function (id) { return porId[id]; });
      ids.forEach(function (id) { vistas[id] = true; });
      // la última pestaña muestra también una sección que el arnés sume y esta pantalla no conozca todavía
      var otras = i === PESTANAS.length - 1 ? S.secciones.filter(function (s) { return !vistas[s.id] && PESTANAS.every(function (q) { return q[2].indexOf(s.id) < 0; }); }) : [];
      var secs = ids.map(function (id) { return porId[id]; }).concat(otras);
      var malas = secs.filter(function (s) { return estadoDe(s)[0] === 'bad'; }).length;
      var pend = secs.filter(function (s) { var e = estadoDe(s)[0]; return e === 'warn' || e === 'bad'; }).length + p[3].reduce(function (n, t) { return n + (tablas[t] ? pendTabla[t] : 0); }, 0);
      var sel = p[0] === activa;
      var marca = pend ? el('span', { class: 'cuenta ' + (malas ? 'bad' : 'warn'), title: pend + ' para mirar', text: String(pend) }) : null;
      barra.appendChild(el('a', { href: '#pestana-' + p[0], id: 'tab-' + p[0], role: 'tab', 'aria-selected': sel ? 'true' : 'false', 'aria-controls': 'pestana-' + p[0], class: sel ? 'activa' : undefined }, el('span', { text: p[1] }), marca));
      var panel = el('div', { class: 'pestana-panel', id: 'pestana-' + p[0], role: 'tabpanel', 'aria-labelledby': 'tab-' + p[0], hidden: sel ? undefined : 'hidden' });
      var pila = el('div', { class: 'pila' });
      secs.forEach(function (s) { pila.appendChild(seccion(s)); });
      panel.appendChild(pila);
      var mirar = p[3].filter(function (t) { return tablas[t]; });
      if (mirar.length) {
        panel.appendChild(el('h3', { class: 'block' }, el('span', { text: 'Para mirar' }), el('span', { class: 'aside', text: 'no se cambia desde acá' })));
        var pm = el('div', { class: 'pila' });
        mirar.forEach(function (t) { pm.appendChild(tablas[t]); });
        panel.appendChild(pm);
      }
      paneles.push(panel);
    });
    partes.push(barra);
    paneles.forEach(function (x) { partes.push(x); });
    app.replaceChildren.apply(app, partes);
  }
  function cargar() {
    return api('').then(function (r) {
      if (!r.ok) { app.replaceChildren(el('div', { class: 'msg bad' }, el('b', { text: 'No se pudo leer la configuración.' }), el('span', { text: r.message || '' }))); return; }
      S.secciones = r.secciones; S.extras = r;
      r.secciones.forEach(function (s) { S.borradores[s.id] = copia(s.borrador === undefined ? {} : s.borrador); S.originales[s.id] = copia(S.borradores[s.id]); S.problemas[s.id] = llanos(s.problems); S.textos[s.id] = null; S.avisos[s.id] = llanos(s.avisos); });
      if (!S.pestana) S.pestana = pestanaDe(ancla()) || PESTANAS[0][0];
      render();
    });
  }
  function ancla() { return typeof location !== 'undefined' && location ? location.hash : ''; }
  /** Un enlace a una pestaña, a una sección o a una tabla abre su pestaña; a una sección o tabla, además baja hasta ella. */
  function irA(hash) {
    var p = pestanaDe(hash);
    if (!p) return;
    if (p !== S.pestana) { S.pestana = p; render(); }
    var destino = String(hash).replace(/^#/, '');
    if (destino.indexOf('pestana-') === 0) return;
    var n = document.getElementById(destino);
    if (n && n.scrollIntoView) n.scrollIntoView();
  }
  if (typeof window !== 'undefined' && window && window.addEventListener) window.addEventListener('hashchange', function () { irA(ancla()); });
  // un enlace de pestaña no salta la página hasta el panel; un enlace al ancla que ya está puesta igual abre su pestaña
  app.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var h = a.getAttribute('href');
    if (h.indexOf('#pestana-') === 0 && typeof history !== 'undefined' && history.replaceState) { e.preventDefault(); history.replaceState(null, '', h); irA(h); return; }
    if (h === ancla()) irA(h);
  });
  cargar().then(function () { var h = ancla(); if (h && h.indexOf('#pestana-') !== 0) irA(h); }).catch(function (e) { app.replaceChildren(el('div', { class: 'msg bad' }, el('b', { text: 'No pude cargar la pestaña.' }), el('span', { text: e.message }))); });
})();
`;
}

module.exports = {
  SECCIONES, seccionPorId, loadReader, lectorSabe, formatJson, remoteOf, TEAM_REPOS_SINCE, MERGE_SUITES_SINCE, MODELS_SINCE, WAIT_NOTICE_SINCE, COVERAGE_SINCE, RESPONSE_SINCE, versionQuePide, versionAtLeast, profileGateProblem, packsListGateProblem, teamProfileGateProblem,
  problemasDeSeccion, hojasAjenas, modelosDeHoy, motivoDeHoy,
  thresholdsParse, aplicarSeccion, revisar, versionesDeMaquinas, paridadPorProducto, ramaDePropuesta, tituloDePropuesta, cuerpoDePropuesta, pantalla,
  SIN_NOTICIAS_DIAS,
};
