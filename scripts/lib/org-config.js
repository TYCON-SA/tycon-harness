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
// Un comentario en un archivo de la organización: la clave empieza con «_» (`_comment`, `_note`, `__doc`) y su valor es
// texto. Vale donde las claves son nombres de campos; donde son datos (productos, personas) se sigue mirando «__», para no
// tapar un nombre. Un «_» solo con forma de secreto, o que guarda un objeto, se revisa como cualquier clave; «__» sigue
// siendo comentario con cualquier valor, como antes.
const esComentario = (k, v) => k.startsWith('__') || (k.startsWith('_') && !/token|secret|sas|password|passwd|pwd|key|credential/i.test(k) && (typeof v === 'string' || (Array.isArray(v) && v.every((s) => typeof s === 'string'))));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Cómo queda escrito un archivo: dos espacios y un salto final (lo que espera el diff de quien revisa el pedido). */
const formatJson = (data) => `${JSON.stringify(data, null, 2)}\n`;

/**
 * Las secciones. `archivo` es la ruta en el repo; `repo` 'perfil' u 'operaciones'; `lector` el archivo de scripts/lib
 * (o de scripts/ci) que la valida; `claves` las claves del archivo que la sección edita (null = el archivo entero);
 * `idCorto` el identificador de la rama del pedido (AC 14); `necesita` claves que el lector tiene que conocer para que
 * esta versión del arnés «sepa leer» la sección (una versión anterior a la story que la crea no las trae).
 */
// los mensajes de este archivo viven en la tabla del sitio (scripts/site/texts.js, `org.*`); acá se arman en castellano
// y el sitio los dice en el idioma de cada pedido
const M = (clave, valores) => require('../site/texts.js').t('es', clave, valores);

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
  // como estaba (Telegram, de cada máquina, no se edita desde la sección de integraciones).
  // quién puede reenviar el ok de un dev para eximir un crítico (approvals.relay_session; vale sólo desde el perfil)
  Object.freeze({ id: 'aprobaciones', titulo: 'Quién reenvía el ok de un dev', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['approvals'], rutas: Object.freeze(['approvals.relay_session']), idCorto: 'profile', necesita: ['approvals'] }),
  Object.freeze({ id: 'pruebaAMano', titulo: 'Prueba a mano de cada criterio', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['qa'], rutas: Object.freeze(['qa.manual_check']), idCorto: 'profile', necesita: ['qa'] }),
  Object.freeze({ id: 'respuesta', titulo: 'Cómo contesta Claude', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['response'], idCorto: 'profile', necesita: ['response'] }),
  Object.freeze({ id: 'integraciones', titulo: 'Integraciones', archivo: 'team-profile.json', archivoViejo: 'perfil-equipo.json', repo: 'perfil', lector: 'harness-config', claves: ['integrations'], rutas: Object.freeze(['integrations.clockify', 'integrations.engram', 'integrations.mailbox', 'integrations.codex', 'integrations.nightly', 'integrations.codegraph']), idCorto: 'profile', necesita: ['integrations'] }),
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
  // las fichas del tablero nocturno que el sitio no muestra (la lista es la de scripts/site/tabs/cards.js)
  Object.freeze({ id: 'fichas', titulo: 'Fichas que muestra el sitio', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['site'], rutas: Object.freeze(['site.hidden_cards']), idCorto: 'operations', necesita: ['site'] }),
  // el pedido de trabajo de una vulnerabilidad: su tipo, los campos fijos y los de cada gravedad. Un lector
  // que no conoce `work_items` deja la sección en «todavía no sabe leer»
  Object.freeze({ id: 'pedidos', titulo: 'Pedidos de vulnerabilidades', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['work_items'], idCorto: 'operations', necesita: ['work_items'] }),
  // cómo se mantiene al día el sitio: «automático» o «sólo aviso», en la misma pestaña que el sitio
  Object.freeze({ id: 'aldia', titulo: 'Cómo se actualiza el sitio', archivo: 'operations.json', repo: 'operaciones', lector: 'operations-config.js', claves: ['site'], rutas: Object.freeze(['site.update']), idCorto: 'operations', necesita: ['site'] }),
  // dos partes de team-repos.json con su propia sección (tanda C): dónde corren las suites al mergear (story 7.28) y el
  // modelo de cada trabajo del pipeline (story 7.29). Un lector anterior no las conoce: la sección dice «no sabe leer».
  // Comparten el identificador de rama con «repos»: un pedido abierto sobre el archivo frena los otros (un pedido por archivo)
  Object.freeze({ id: 'suites', titulo: 'Dónde corren las suites completas al mergear', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['merge_suites'], idCorto: 'repos', necesita: ['merge_suites'] }),
  Object.freeze({ id: 'modelos', titulo: 'Modelos de cada trabajo del pipeline', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['models'], idCorto: 'repos', necesita: ['models'] }),
  // el plazo del aviso de espera (story 7.20): cuántos minutos espera una corrida a una persona antes de avisar
  Object.freeze({ id: 'espera', titulo: 'Aviso de espera', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['wait_notice'], idCorto: 'repos', necesita: ['wait_notice'] }),
  // el umbral de cobertura de las líneas nuevas: el control de pruebas avisa por debajo de este porcentaje
  Object.freeze({ id: 'cobertura', titulo: 'Cobertura de las pruebas', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['coverage'], idCorto: 'repos', necesita: ['coverage'] }),
  // el tope de vueltas de revisores de una story y los prefijos de reglas que cuentan como seguridad o datos
  Object.freeze({ id: 'revision', titulo: 'Vueltas de revisores', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['review'], idCorto: 'repos', necesita: ['review'] }),
  // la tecnología de la organización: terminaciones que también son código, herramientas de prueba y las reglas
  Object.freeze({ id: 'tecnologia', titulo: 'Tu tecnología', archivo: 'team-repos.json', repo: 'perfil', lector: 'team-repos.js', claves: ['stack'], idCorto: 'repos', necesita: ['stack'] }),
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
  if (!seccion.necesita.every((k) => lector.KEYS.includes(k))) return false;
  // una sección sobre una hoja de `site` pide además que el lector conozca esa hoja: si no, un lector viejo
  // daría por buena una sección sobre una clave que rechaza, y el sitio se frenaría al leer el archivo
  for (const ruta of seccion.rutas || []) {
    const [arriba, hoja] = ruta.split('.');
    if (arriba === 'site' && hoja && Array.isArray(lector.SITE_KEYS) && !lector.SITE_KEYS.includes(hoja)) return false;
  }
  return true;
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
// `review`: la etiqueta del merge que lo trajo al lector
const REVIEW_SINCE = '2026.10.20.43';
// `stack`: la etiqueta del merge que trajo `stack.rules` al lector (las terminaciones y las herramientas llegaron antes;
// se pide la versión que lee la clave entera)
const STACK_SINCE = '2026.10.19.11';
// los niveles de modelo: un lector anterior acepta `models` sólo con los nombres de Claude y, con un nivel
// adentro, descarta toda la configuración de modelos (techo incluido). Se pide sólo si el archivo trae algún nivel; con
// nombres, sigue MODELS_SINCE. Provisoria hasta la etiqueta del merge que la trae (como REVIEW_SINCE)
const MODEL_LEVELS_SINCE = '2026.10.21.8';
const CLAVES_CON_VERSION = Object.freeze([['merge_suites', MERGE_SUITES_SINCE], ['models', MODELS_SINCE], ['wait_notice', WAIT_NOTICE_SINCE], ['coverage', COVERAGE_SINCE], ['review', REVIEW_SINCE], ['stack', STACK_SINCE]]);
/** La versión que tiene que pedir el perfil para este `team-repos.json` (sin archivo, la de siempre), y las claves por las que la pide. */
function versionQuePide(doc) {
  let version = TEAM_REPOS_SINCE; const claves = [];
  for (const [k, min] of CLAVES_CON_VERSION) {
    if (!isObject(doc) || doc[k] === undefined) continue;
    claves.push(k);
    if (!versionAtLeast(version, min)) version = min;
  }
  if (isObject(doc) && conNivelDeModelo(doc.models) && !versionAtLeast(version, MODEL_LEVELS_SINCE)) version = MODEL_LEVELS_SINCE;
  return { version, claves };
}
/** ¿`models` trae algún nivel (en cualquier clave, también adentro de un objeto)? Un comentario («_…») no cuenta. */
function conNivelDeModelo(v) {
  if (typeof v === 'string') return require('./team-repos.js').MODEL_LEVELS.includes(v);
  return isObject(v) && Object.entries(v).some(([k, x]) => !k.startsWith('_') && conNivelDeModelo(x));
}
/**
 * `models` con cada nombre de Claude pasado a su nivel, con el lector del árbol (`MODEL_NAMES` y `MODEL_LEVELS`, en el
 * mismo orden): lo que la pantalla muestra y propone. Un lector sin niveles lo deja como está.
 */
function modelosEnNiveles(v, lector) {
  if (!lector || !Array.isArray(lector.MODEL_LEVELS) || !Array.isArray(lector.MODEL_NAMES)) return v;
  if (typeof v === 'string') return lector.MODEL_NAMES.includes(v) ? lector.MODEL_LEVELS[lector.MODEL_NAMES.indexOf(v)] : v;
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'fable_question' || k.startsWith('_') ? x : modelosEnNiveles(x, lector)]));
}
/**
 * Las equivalencias de Codex del árbol que sirve el sitio (`build/equivalences.json → models`, por modelo de Claude):
 * la línea chica debajo de cada nivel. `{ equivalencias, motivo }`: sin el archivo o sin la clave, `equivalencias: null`
 * y la pantalla dice «sin equivalencia»; un archivo que está y no se pudo leer trae además el `motivo`, que la pantalla
 * muestra («no pude leer» nunca se ve igual que «no hay»).
 */
function equivalenciasDe(tree) {
  const f = path.join(String(tree), 'build', 'equivalences.json');
  let texto;
  try { texto = fs.readFileSync(f, 'utf8'); } catch (e) {
    return { equivalencias: null, motivo: e && e.code === 'ENOENT' ? null : M('org.equivalenciasIlegibles', { error: (e && e.code) || String(e) }) };
  }
  try {
    const j = JSON.parse(texto);
    return { equivalencias: isObject(j) && isObject(j.models) ? j.models : null, motivo: null };
  } catch (e) { return { equivalencias: null, motivo: M('org.equivalenciasIlegibles', { error: String((e && e.message) || e).split('\n')[0] }) }; }
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
    return M('org.capaIlegible', { error: (e && e.message) || e });
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  const { version, claves } = versionQuePide(doc);
  if (m && versionAtLeast(m[1], version)) return null;
  if (claves.length) return M('org.capaPideRepos', { req: req || M('org.nada'), version, claves: claves.join(' ni ') });
  return M('org.capaSinRepos', { req: req || M('org.nada'), version: TEAM_REPOS_SINCE });
}

/**
 * 🔴 La primera versión del arnés cuyo lector conoce `response` en el perfil del equipo (story 2.31: la etiqueta del merge
 * que la trajo). Una máquina con un lector anterior ve una clave desconocida y rechaza el perfil ENTERO; por eso, con
 * `response` en el perfil propuesto, el perfil tiene que pedir al menos esta versión.
 */
const RESPONSE_SINCE = '2026.10.17.9';
/**
 * 🔴 La primera versión del arnés cuyo lector conoce `approvals`. Es la etiqueta del merge que la trae: se
 * fija con la etiqueta real al entrar a main (la pone el merge), y el pedido al perfil del equipo que declara la clave
 * sube `requires.harness` a esa versión. Una máquina anterior no aplica esa capa y sigue con la que tenía.
 */
const APPROVALS_SINCE = '2026.10.20.3';
/**
 * 🔴 La primera versión del arnés cuyo lector conoce `qa` (la marca a mano de cada criterio): la etiqueta del merge que la
 * trajo. El pedido al perfil del equipo que declara la clave sube `requires.harness` a esa versión.
 */
const QA_SINCE = '2026.10.20.39';
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
  // las claves del perfil que una versión anterior no sabe leer, con la versión que las lee y su mensaje
  const pedidas = [['response', RESPONSE_SINCE, 'org.capaSinResponse'], ['approvals', APPROVALS_SINCE, 'org.capaSinApprovals'], ['qa', QA_SINCE, 'org.capaSinQa']]
    .filter(([k]) => isObject(doc) && doc[k] !== undefined && cambia(k));
  if (!pedidas.length) return null;
  let decl;
  try { decl = JSON.parse(String(layerText)); } catch (e) {
    return M('org.capaIlegible', { error: (e && e.message) || e });
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  for (const [, version, mensaje] of pedidas) {
    if (!(m && versionAtLeast(m[1], version))) return M(mensaje, { req: req || M('org.nada'), version });
  }
  return null;
}

/**
 * `null` si el valor de `packs.default` que se propone lo leen todas las máquinas del perfil; si no, el motivo. `all` y
 * `none` los lee cualquier versión. Una LISTA la lee sólo un arnés que la conoce: el perfil tiene que pedir
 * (`requires.harness` de team-layer.json) al menos la versión del sitio, que sí la conoce. Sin la versión del sitio no se
 * puede saber: no se propone.
 */
function packsListGateProblem({ layerText, versionImagen, valor }) {
  if (!Array.isArray(valor)) return null;
  if (!versionImagen) return M('org.sinVersionSitio');
  let decl;
  try { decl = JSON.parse(String(layerText)); } catch (e) {
    return M('org.capaIlegible', { error: (e && e.message) || e });
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  if (m && versionAtLeast(m[1], versionImagen)) return null;
  return M('org.listaDePaquetes', { req: req || M('org.nada'), version: versionImagen });
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
    return { ok: false, data: null, problems: [{ path: '', message: M('org.noEsJsonValido', { error: String((e && e.message) || e).split('\n')[0] }) }], avisos: [], soloLectura: true };
  }
  if (!isObject(doc)) return { ok: false, data: null, problems: [{ path: '', message: M('org.tieneQueSerObjeto') }], avisos: [], soloLectura: true };
  if (formatJson(doc) !== String(text)) return { ok: false, data: null, problems: [{ path: '', message: M('org.formatoDelArnes') }], avisos: [], soloLectura: true };
  const th = doc.thresholds === undefined ? {} : doc.thresholds;
  if (!isObject(th)) return { ok: false, data: null, problems: [{ path: 'thresholds', message: M('org.umbralesObjeto') }], avisos: [], soloLectura: false };
  const valido = umbralValidoDe(opts);
  const conocidas = opts.arnes && isObject(opts.arnes.thresholds) ? Object.keys(opts.arnes.thresholds) : null;
  const problems = []; const avisos = [];
  for (const [k, u] of Object.entries(th)) {
    if (esComentario(k, u)) continue;
    if (conocidas && !conocidas.includes(k)) {
      // una fila que YA estaba en el archivo y el arnés dejó de usar no bloquea; una que se agrega, sí
      if ((opts.previas || Object.keys(th)).includes(k)) { avisos.push({ path: `thresholds.${k}`, message: M('org.claveQueNoSeUsa') }); continue; }
      problems.push({ path: `thresholds.${k}`, message: M('org.claveDesconocida') });
      continue;
    }
    if (!valido(u)) { problems.push({ path: `thresholds.${k}`, message: M('org.faltaSentido') }); continue; }
    // con el verde del lado del rojo, el tablero pintaría un número de dos colores a la vez
    if (u.direction === 'menor_es_mejor' && !(u.ok_max < u.bad_min)) problems.push({ path: `thresholds.${k}`, message: M('org.menorEsMejor') });
    if (u.direction === 'mayor_es_mejor' && !(u.ok_min > u.bad_max)) problems.push({ path: `thresholds.${k}`, message: M('org.mayorEsMejor') });
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
    // el archivo entero, pero los comentarios del archivo se conservan si el borrador no los trae
    const out = clone(isObject(borrador) ? borrador : {});
    for (const k of Object.keys(base)) if (esComentario(k, base[k]) && out[k] === undefined) out[k] = base[k];
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

/**
 * Los umbrales del borrador con los comentarios del archivo que el borrador no trae: los del bloque y los de cada fila
 * que sigue. El borrador reemplaza el bloque entero; la pantalla no muestra los comentarios, así que no los manda.
 */
function conComentarios(previo, borrador) {
  if (!isObject(previo)) return borrador;
  const out = clone(borrador);
  for (const [k, v] of Object.entries(previo)) {
    if (esComentario(k, v)) { if (out[k] === undefined) out[k] = clone(v); continue; }
    if (!isObject(v) || !isObject(out[k])) continue;
    for (const [c, nota] of Object.entries(v)) if (esComentario(c, nota) && out[k][c] === undefined) out[k][c] = clone(nota);
  }
  return out;
}

/** Las claves del borrador que la sección no edita (una clave que no tiene campo en la pantalla va arriba). */
function clavesAjenas(seccion, borrador) {
  if (!isObject(borrador) || seccion.claves === null) return [];
  return Object.keys(borrador).filter((k) => !seccion.claves.includes(k) && !esComentario(k, borrador[k]));
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
  if (!s) return { ok: false, problems: [{ path: '', message: M('org.seccionDesconocida'), sinCampo: true }], texto: null };
  const actual = docDe(texto);
  if (texto !== null && texto !== undefined && actual === null) return { ok: false, problems: [{ path: '', message: M('org.noEsObjeto', { archivo: s.archivo }), sinCampo: true }], texto: null };

  if (s.id === 'umbrales') {
    const previas = actual && isObject(actual.thresholds) ? Object.keys(actual.thresholds) : [];
    const base = texto === null || texto === undefined ? { sources: [], thresholds: {} } : actual;
    const salida = formatJson(aplicarSeccion(base, s, { thresholds: conComentarios(base.thresholds, isObject(borrador) ? borrador : {}) }));
    const r = thresholdsParse(salida, { arnes, previas, tree, umbralValido });
    return { ok: r.ok, problems: r.problems, avisos: r.avisos, texto: r.ok ? salida : null, soloLectura: r.soloLectura };
  }

  if (s.id === 'paridad') {
    const lector = lectores['check-product-parity.js'] || loadReader(tree || '', 'check-product-parity.js', lectores);
    if (!lector) return { ok: false, problems: [{ path: '', message: M('org.noLeeDeclaradas'), sinCampo: true }], texto: null };
    if (!actual) return { ok: false, problems: [{ path: '', message: M('org.paridadSinLista'), sinCampo: true }], texto: null };
    const dia = hoy || new Date().toISOString().slice(0, 10);
    const b = isObject(borrador) ? borrador : {};
    const lista = Array.isArray(actual.diferencias_declaradas) ? actual.diferencias_declaradas : [];
    // la misma diferencia declarada en varios grupos se renueva o se cierra de una vez (`grupos`); `grupo` es uno solo
    const grupos = Array.isArray(b.grupos) && b.grupos.length ? [...new Set(b.grupos)] : [b.grupo];
    const indices = [];
    for (const g of grupos) {
      const j = lista.findIndex((d) => isObject(d) && d.grupo === g && d.rasgo === b.rasgo);
      if (j < 0) return { ok: false, problems: [{ path: 'diferencias_declaradas', message: M('org.sinDeclarada', { cual: `${g}/${b.rasgo}` }), sinCampo: true }], texto: null };
      indices.push(j);
    }
    const i = indices[0];
    const nueva = clone(actual);
    let aviso = null;
    if (b.accion === 'close') {
      for (const j of [...indices].sort((x, y) => y - x)) nueva.diferencias_declaradas.splice(j, 1);
      aviso = M('org.avisoRenovar');
    } else if (b.accion === 'renew') {
      const problems = [];
      if (!diaValido(b.revision)) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: M('org.fechaForma') });
      else if (b.revision <= dia) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: M('org.fechaPosterior', { dia }) });
      else if (b.revision > unAnioDespues(dia)) problems.push({ path: `diferencias_declaradas.${i}.revision`, message: M('org.fechaUnAnio', { dia: unAnioDespues(dia) }) });
      if (typeof b.motivo !== 'string' || !b.motivo.trim()) problems.push({ path: `diferencias_declaradas.${i}.motivo`, message: M('org.motivoObligatorio') });
      if (problems.length) return { ok: false, problems, texto: null };
      for (const j of indices) nueva.diferencias_declaradas[j] = { ...nueva.diferencias_declaradas[j], motivo: b.motivo.trim(), fecha: dia, revision: b.revision };
    } else return { ok: false, problems: [{ path: '', message: M('org.accionRenovar'), sinCampo: true }], texto: null };
    // la validación es la del control (P7): la misma lectura que juzga de noche
    const r = lector.leerDeclaradas(nueva, dia);
    if (r.problemas && r.problemas.length) return { ok: false, problems: r.problemas.map((p) => ({ path: p.path || 'diferencias_declaradas', message: p.message })), texto: null };
    return { ok: true, problems: [], texto: formatJson(nueva), aviso };
  }

  const lector = lectores[s.lector] || loadReader(tree || '', s.lector, lectores);
  if (!lectorSabe(lector, s)) return { ok: false, problems: [{ path: '', message: M('org.noLee', { que: `${s.archivo}${s.claves ? ` → ${s.claves.join(', ')}` : ''}` }), sinCampo: true }], texto: null };
  const ajenas = clavesAjenas(s, borrador);
  // un archivo que todavía no existe nace con lo mínimo que su lector pide (el perfil del equipo, vacío)
  const base = actual || (s.archivo === 'operations.json' ? { version: 1, owners: { default: '' } } : s.archivo === 'team-profile.json' ? {} : { version: 1 });
  let doc = aplicarSeccion(base, s, borrador);
  // lo que el borrador trae fuera de la sección se pone igual: el lector lo rechaza con su ruta, y eso va arriba
  for (const k of ajenas) doc[k] = clone(borrador[k]);
  const salida = formatJson(doc);
  const r = lector.parse(salida);
  const problems = [...(r.problems || []), ...problemasDeSeccion(s, r, actual, doc), ...problemasDelTope(s, lector, doc)].map((p) => ({ ...p, sinCampo: ajenas.some((k) => p.path === k || String(p.path).startsWith(`${k}.`)) || p.path === '' }));
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

/**
 * Los trabajos de la sección de modelos declarados por encima del tope obligatorio: problemas para el sitio,
 * que no deja proponerlos. Los da el lector del árbol (`modelsAboveCeiling`); uno anterior que no la trae, ninguno.
 */
function problemasDelTope(seccion, lector, doc) {
  if (!seccion || seccion.id !== 'modelos' || !lector || typeof lector.modelsAboveCeiling !== 'function' || !isObject(doc)) return [];
  return lector.modelsAboveCeiling(doc.models);
}

/**
 * Qué pasa con las suites de un repo sin pipeline, por regla: `{ <regla>: 'machine' | 'server-if-any-check' }`
 * del lector del árbol, para la pantalla (corre en el navegador y no carga el lector); `null` con un lector anterior.
 */
function sinPipelinePorRegla(lector) {
  if (!lector || typeof lector.suitesWithoutPipeline !== 'function' || !Array.isArray(lector.MERGE_RULES)) return null;
  return Object.fromEntries(lector.MERGE_RULES.map((r) => [r, lector.suitesWithoutPipeline(r)]));
}

/**
 * Qué hace cada regla, por regla: `{ <regla>: 'server-if-required' | 'machine-always' | 'server-only' }` del lector del
 * árbol, para la línea debajo de cada selector de la pantalla; `null` con un lector anterior (y la pantalla no la pone).
 */
function queHacePorRegla(lector) {
  if (!lector || typeof lector.suitesWithRule !== 'function' || !Array.isArray(lector.MERGE_RULES)) return null;
  return Object.fromEntries(lector.MERGE_RULES.map((r) => [r, lector.suitesWithRule(r)]));
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
  if (!tree) return { hoy: null, motivo: M('org.sinArbol') };
  let skills = [];
  try { skills = fs.readdirSync(path.join(String(tree), 'skills')).sort(); } catch (e) {
    return { hoy: null, motivo: e && e.code === 'ENOENT' ? M('org.sinSkills') : M('org.skillsIlegibles', { codigo: (e && e.code) || 'error' }) };
  }
  let motivo = M('org.sinModelosDeHoy');
  for (const n of skills) {
    const f = path.join(String(tree), 'skills', n, 'scripts', 'lib', 'models.js');
    if (!fs.existsSync(f)) continue;
    try {
      const m = require(f);
      if (isObject(m.DEFAULTS) && Array.isArray(m.MODELS)) return { hoy: clone(m.DEFAULTS), motivo: null };
      motivo = M('org.modelsSinValores', { archivo: `skills/${n}/scripts/lib/models.js` });
    } catch (e) { motivo = M('org.modelsNoCarga', { archivo: `skills/${n}/scripts/lib/models.js`, error: String((e && e.message) || e).split('\n')[0] }); }
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
      if (e && e.code !== 'ENOENT') { out.push({ maquina: m, persona: personas && personas[m] ? personas[m] : null, version: null, dia: null, diaTexto: M('org.sinFecha'), estado: 'no_medido', texto: M('org.registrosIlegibles', { codigo: e.code || 'error' }) }); continue; }
    }
    let ruta = null; let dia = null;
    if (carpetas.length) { const c = carpetas[carpetas.length - 1]; ruta = path.join(reg, c, 'place.json'); const d = CARPETA_CON_FECHA.exec(c); dia = `${d[1]}-${d[2]}-${d[3]}`; }
    else if (fs.existsSync(path.join(reg, 'place.json'))) ruta = path.join(reg, 'place.json');
    if (!ruta) continue;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { doc = null; }
    const version = doc && isObject(doc.install) && typeof doc.install.version === 'string' ? doc.install.version : null;
    const persona = personas && typeof personas === 'object' && personas[m] ? personas[m] : null;
    const fila = { maquina: m, persona, version, dia, diaTexto: dia || M('org.sinFecha'), estado: 'no_medido', texto: '' };
    if (!versionImagen) { fila.estado = 'no_medido'; fila.texto = M('org.imagenSinVersion'); }
    else if (!doc) { fila.texto = M('org.placeIlegible'); }
    else if (!version) { fila.texto = M('org.placeSinVersion'); }
    else if (dia && (Date.parse(`${dia}T00:00:00Z`) < ahora - SIN_NOTICIAS_DIAS * 86400000)) { fila.estado = 'sin_noticias'; fila.texto = M('org.sinNoticias', { dia }); }
    else if (versionAtLeast(version, versionImagen)) { fila.estado = 'al_dia'; fila.texto = M('org.alDia'); }
    else if (versionParts(version)) { fila.estado = 'atrasada'; fila.texto = M('org.atrasada', { version: versionImagen }); }
    else { fila.texto = M('org.sinFormaDeVersion', { version }); }
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
  if (!isObject(lista)) return { estado: 'sin_lista', texto: M('org.paridadSinLista'), productos: [], definicion: null };
  if (typeof lista.sin_productos === 'string' && lista.sin_productos.trim()) return { estado: 'sin_productos', texto: M('org.paridadSinProductos', { motivo: lista.sin_productos.trim() }), productos: [], definicion: null };
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
  const textos = { medido: M('org.paridadMedido'), parcial: M('org.paridadParcial'), no_medido: M('org.paridadNoMedido'), sin_productos: M('org.paridadSinProductosCorto'), sin_resultado: M('org.paridadSinResultado'), resultado_ilegible: M('org.paridadIlegible') };
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

// ── la diferencia por renglones ──────────────────────────────────────────────────────────────────────────────────
// Por encima de este producto de renglones (medio de antes × medio de después) no se busca la subsecuencia común: el
// medio entero se marca como cambiado, así un archivo enorme nunca cuelga la página.
const TOPE_DE_CELDAS = 4000000;

/** Los renglones de un texto; el salto final no abre un renglón vacío. */
function renglonesDe(texto) {
  const t = String(texto == null ? '' : texto);
  if (t === '') return [];
  const l = t.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** La versión de un texto como la da git (`git hash-object`): con eso se sabe si la base que manda la página es la que dice. */
function versionDeTexto(texto, largo = 40) {
  const cuerpo = Buffer.from(String(texto), 'utf8');
  const algoritmo = largo === 64 ? 'sha256' : 'sha1';
  return require('crypto').createHash(algoritmo).update(Buffer.concat([Buffer.from(`blob ${cuerpo.length}\0`), cuerpo])).digest('hex');
}

/**
 * Lo propuesto sobre una base vieja, puesto encima de lo actual, hoja por hoja (la ruta de cada valor; una lista o un
 * objeto vacío cuenta como un valor). Lo mío son las hojas que cambian de `base` a `mio`; lo de afuera, de `base` a
 * `actual`. Se pisan si la misma ruta, o una que la contiene, cambia en los dos con valores distintos. Devuelve
 * `{ doc, conflictos: [{ camino, ruta, tuyo, ahora }] }`: `doc` es lo actual con todo lo mío encima (también en los
 * choques: lo escrito no se pierde) y cada choque trae la ruta más corta con los dos valores (`undefined` = sacado).
 */
// cada clave se escribe como propia (también `__proto__`, `constructor` o `prototype`, que pueden ser el nombre de una
// máquina o de un producto): con `=`, `__proto__` cambiaría el prototipo del objeto en vez de guardar el valor
const ponerPropia = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
function reaplicar({ base, mio, actual }) {
  const hojas = (v, camino, out) => {
    if (isObject(v) && Object.keys(v).length) for (const k of Object.keys(v)) hojas(v[k], [...camino, k], out);
    else out.set(JSON.stringify(camino), camino);
    return out;
  };
  const en = (doc, camino) => camino.reduce((o, k) => (isObject(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), doc);
  // un valor sacado no es lo mismo que un null: `canonico` los iguala, la mezcla no
  const firma = (v) => (v === undefined ? '(ausente)' : canonico(v));
  /** El tramo más corto de `camino` que en `doc` no existe (lo que se sacó entero); `camino` si existe todo. */
  const ausente = (doc, camino) => { for (let i = 1; i <= camino.length; i += 1) if (en(doc, camino.slice(0, i)) === undefined) return camino.slice(0, i); return camino; };
  // lo que alguien sacó entero cuenta como un cambio en lo que sacó, no hoja por hoja: así choca con lo que otro sumó
  // adentro, en vez de borrarlo en silencio
  const cambios = (a, b) => {
    const todas = new Map([...hojas(a, [], new Map()), ...hojas(b, [], new Map())]);
    const out = new Map();
    // la ruta raíz (`[]`) sale sólo de un documento vacío: no es una hoja
    for (const c of todas.values()) {
      if (!c.length || firma(en(a, c)) === firma(en(b, c))) continue;
      const camino = ausente(b, c);
      out.set(JSON.stringify(camino), camino);
    }
    return [...out.values()];
  };
  const mios = cambios(base, mio);
  const suyos = cambios(base, actual);
  const contiene = (corto, largo) => corto.length <= largo.length && corto.every((k, i) => k === largo[i]);
  const choques = new Map();
  for (const m of mios) {
    for (const s of suyos) {
      if (!contiene(m, s) && !contiene(s, m)) continue;
      const camino = m.length <= s.length ? m : s;
      if (firma(en(mio, camino)) === firma(en(actual, camino))) continue;
      choques.set(JSON.stringify(camino), camino);
    }
  }
  // un choque que cae dentro de otro más corto se dice una vez, en el más corto
  const caminos = [...choques.values()].filter((c, _, todos) => !todos.some((o) => o !== c && o.length < c.length && contiene(o, c)));
  const doc = isObject(actual) ? clone(actual) : {};
  for (const camino of [...mios].sort((a, b) => a.length - b.length)) {
    const valor = en(mio, camino);
    let o = doc;
    for (const k of camino.slice(0, -1)) {
      const hijo = Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
      if (!isObject(hijo)) { if (valor === undefined) { o = null; break; } ponerPropia(o, k, {}); }
      o = o[k];
    }
    if (!o) continue;
    const hoja = camino[camino.length - 1];
    if (valor === undefined) delete o[hoja]; else ponerPropia(o, hoja, clone(valor));
  }
  const conflictos = caminos.map((camino) => ({ camino, ruta: camino.join('.'), tuyo: clone(en(mio, camino)), ahora: clone(en(actual, camino)) }));
  return { doc, conflictos };
}

/**
 * La diferencia entre dos textos, por renglones y sin librerías: una lista de tramos que la pantalla dibuja.
 *   · `{ renglones: [{ tipo: 'igual' | 'sale' | 'entra', linea, a, b }] }` — un tramo: cada cambio con `contexto`
 *     renglones iguales alrededor. `a` es el número (desde 1) del renglón en `antes` y `b` en `despues`; el que sale
 *     no tiene `b` y el que entra no tiene `a` (null).
 *   · `{ iguales: N }` — entre dos tramos, los N renglones iguales que se saltan.
 * Dos textos iguales dan una lista vacía. Se recorta primero lo igual del principio y del final; del medio se saca la
 * subsecuencia común más larga, salvo que pase de TOPE_DE_CELDAS: entonces todo el medio cuenta como cambiado.
 * Va escrita en ES5 simple para poder viajar tal cual dentro del código de pantalla.
 */
function diferencia(antes, despues, contexto) {
  var ctx = contexto === undefined ? 3 : contexto;
  var A = renglonesDe(antes);
  var B = renglonesDe(despues);
  var ini = 0;
  while (ini < A.length && ini < B.length && A[ini] === B[ini]) ini += 1;
  var finA = A.length;
  var finB = B.length;
  while (finA > ini && finB > ini && A[finA - 1] === B[finB - 1]) { finA -= 1; finB -= 1; }
  if (ini === A.length && ini === B.length) return [];
  var na = finA - ini;
  var nb = finB - ini;
  // las filas del resultado, en orden: [tipo, índice en A o -1, índice en B o -1]
  var filas = [];
  var i;
  var j;
  for (i = 0; i < ini; i += 1) filas.push(['igual', i, i]);
  if (na * nb > TOPE_DE_CELDAS) {
    for (i = 0; i < na; i += 1) filas.push(['sale', ini + i, -1]);
    for (j = 0; j < nb; j += 1) filas.push(['entra', -1, ini + j]);
  } else {
    // largo[i][j]: la subsecuencia común más larga de A[ini+i..] y B[ini+j..]
    var ancho = nb + 1;
    var largo = new Uint32Array((na + 1) * ancho);
    for (i = na - 1; i >= 0; i -= 1) {
      for (j = nb - 1; j >= 0; j -= 1) {
        largo[i * ancho + j] = A[ini + i] === B[ini + j] ? largo[(i + 1) * ancho + j + 1] + 1 : Math.max(largo[(i + 1) * ancho + j], largo[i * ancho + j + 1]);
      }
    }
    i = 0; j = 0;
    while (i < na && j < nb) {
      if (A[ini + i] === B[ini + j]) { filas.push(['igual', ini + i, ini + j]); i += 1; j += 1; }
      else if (largo[(i + 1) * ancho + j] >= largo[i * ancho + j + 1]) { filas.push(['sale', ini + i, -1]); i += 1; }
      else { filas.push(['entra', -1, ini + j]); j += 1; }
    }
    while (i < na) { filas.push(['sale', ini + i, -1]); i += 1; }
    while (j < nb) { filas.push(['entra', -1, ini + j]); j += 1; }
  }
  for (i = finA; i < A.length; i += 1) filas.push(['igual', i, finB + (i - finA)]);
  // los tramos: cada renglón que cambia arrastra `ctx` de cada lado; lo que queda entre dos tramos se cuenta
  var cerca = [];
  var k;
  for (k = 0; k < filas.length; k += 1) cerca.push(false);
  for (k = 0; k < filas.length; k += 1) {
    if (filas[k][0] === 'igual') continue;
    for (j = Math.max(0, k - ctx); j <= Math.min(filas.length - 1, k + ctx); j += 1) cerca[j] = true;
  }
  var out = [];
  var tramo = null;
  var saltados = 0;
  for (k = 0; k < filas.length; k += 1) {
    if (!cerca[k]) { saltados += 1; continue; }
    if (!tramo) {
      if (saltados > 0 && out.length) out.push({ iguales: saltados });
      tramo = { renglones: [] };
      out.push(tramo);
    } else if (saltados > 0) {
      out.push({ iguales: saltados });
      tramo = { renglones: [] };
      out.push(tramo);
    }
    saltados = 0;
    var f = filas[k];
    tramo.renglones.push({ tipo: f[0], linea: f[1] >= 0 && f[0] !== 'entra' ? A[f[1]] : B[f[2]], a: f[1] >= 0 ? f[1] + 1 : null, b: f[2] >= 0 ? f[2] + 1 : null });
  }
  return out;
}

// ── el código de pantalla ────────────────────────────────────────────────────────────────────────────────────────
/**
 * El JS de la pestaña Configuración, servido por el sitio como `/static/config.js` (AC 4): un solo archivo, sin nada de
 * afuera, con `textContent` siempre (lo que trae un archivo —un nombre, un motivo del lector— no puede volverse
 * marcado). Lee el token de doble envío del `<meta name="site-token">` que arma el servidor y lo manda en cada
 * escritura en `X-Site-Token` (AC 3). Habla con /api/config (leer), /api/config/revisar, /api/config/stages y
 * /api/config/proponer. «Descargar el archivo» no es una ruta: arma la descarga con el texto que «Revisar» devolvió.
 */
function pantalla(idioma = 'es') {
  // los textos de la pantalla, en el idioma pedido: la tabla del sitio, `pantalla.*`. La página local
  // (harness.js team-config) la pide sin idioma y sale en castellano, como siempre
  const { textosCon } = require('../site/texts.js');
  const textos = JSON.stringify(textosCon(idioma, 'pantalla.')).replace(/</g, '\\u003c');
  return String.raw`'use strict';
// config.js — la pestaña Configuración del sitio de la organización (story 2.29). Lo sirve scripts/lib/org-config.js.
// Sólo usa setAttribute, appendChild, addEventListener, textContent y replaceChildren: las pruebas lo corren sobre un
// documento mínimo con eso nada más (lo del navegador —location, history, closest, scrollIntoView— se mira antes de usar).
(function () {
  // cada texto visible sale de TX, que el servidor arma en el idioma de la página; una clave que falta se ve como clave
  var TX = ${textos};
  // el idioma de la página: elige el de cada pieza de lo que instala el arnés; el resto ya viene en TX
  var IDIOMA = ${JSON.stringify(idioma === 'en' ? 'en' : 'es')};
  function T(k, v) {
    var s = Object.prototype.hasOwnProperty.call(TX, k.slice(9)) ? TX[k.slice(9)] : k;
    return v ? s.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(v, n) ? String(v[n]) : m; }) : s;
  }
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
    // siempre termina con un mensaje (un cuerpo JSON que no es un objeto, como null, cuenta como un cuerpo sin mensaje): un pedido cortado no deja la nota en «proponiendo…» para siempre. Un rechazo sin
    // mensaje (un cuerpo vacío o que no es JSON: lo que está delante del sitio, o una versión vieja) dice qué hacer según
    // su estado, nunca «respuesta N» suelto
    var llano = function (status) {
      if (status === 401) return T('pantalla.laSesionVencioOSe');
      // el sitio manda su motivo en cada 403: uno sin motivo lo dio lo que está delante (el inicio de sesión de la nube)
      if (status === 403) return T('pantalla.elPedidoLoRechazoLo');
      if (status === 503) return T('pantalla.elSitioEstaCargandoO');
      return T('pantalla.elSitioContestoConUn') + status + ')';
    };
    // «sinRespuesta» marca lo que no vino del sitio (la red caída, un cuerpo que no es JSON, un 5xx sin su mensaje): quien
    // propuso consulta entonces si el pedido se abrió antes de dar el error. «pista» dice que el mensaje ya trae el consejo
    return fetch('/api/config' + ruta, o).then(function (r) { return r.json().then(function (j) { if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, sinRespuesta: true, message: llano(r.status) }; if (r.status >= 500 && j && !j.message) j.sinRespuesta = true; if (r.status >= 400 && j && !j.message) j.message = llano(r.status); return j; }, function () { return { ok: false, sinRespuesta: true, message: llano(r.status) }; }); })
      .catch(function (e) { return { ok: false, sinRespuesta: true, pista: true, message: T('pantalla.noPudeHablarConEl') + (e && e.message ? e.message : T('pantalla.sinRespuesta')) + T('pantalla.siEstabasProponiendoRecargaY') }; });
  }
  var copia = function (v) { return JSON.parse(JSON.stringify(v)); };
  // bases: la versión de cada sección sobre la que se carga ({ texto, oid }); conflictos: los valores que se pisaron con
  // un cambio de afuera; recuperar: lo que quedó guardado de antes de recargar, hasta que la persona elige
  var S = { pestana: null, secciones: [], borradores: {}, originales: {}, problemas: {}, avisos: {}, notas: {}, textos: {}, extras: null, diferencias: {}, resumenes: {}, marcas: {}, proponiendo: {}, terminadas: {}, bases: {}, conflictos: {}, recuperar: {} };
  // cuánto espera la página antes de cada consulta por el pedido de una propuesta cortada; la prueba pasa los suyos
  var ESPERAS = typeof esperasConsulta !== 'undefined' && esperasConsulta ? esperasConsulta : [2000, 5000, 10000];
  // con el pedido abierto, cada cuánto pregunta si ya entró y cuántas veces (10 s, hasta 10 minutos); la prueba pasa los suyos
  var SEGUIR = typeof seguimientoPedido !== 'undefined' && seguimientoPedido ? seguimientoPedido : { cada: 10000, vueltas: 60 };
  // cuánto se espera la respuesta de «Proponer» antes de preguntar por la marca si el pedido ya se abrió (las pruebas lo achican)
  var ESPERA_RESPUESTA = typeof esperaRespuesta !== 'undefined' && esperaRespuesta ? esperaRespuesta : 20000;

  // ── lo cargado sin proponer, por sección, en sessionStorage (vive lo que la pestaña) ──
  // todo acceso puede fallar (navegador privado, almacén bloqueado o lleno): entonces la página sigue sin guardarlo y no
  // dice nada, porque no hay nada que la persona pueda hacer
  var PREFIJO = 'configuracion-del-sitio:';
  function almacen() { try { return typeof sessionStorage !== 'undefined' && sessionStorage ? sessionStorage : null; } catch (e) { return null; } }
  function guardadoDe(id) {
    try { var a = almacen(); var t = a ? a.getItem(PREFIJO + id) : null; var v = t ? JSON.parse(t) : null; return v && typeof v === 'object' && 'borrador' in v ? v : null; } catch (e) { return null; }
  }
  function guardar(id, v) { try { var a = almacen(); if (a) a.setItem(PREFIJO + id, JSON.stringify(v)); } catch (e) { return; } }
  function olvidar(id) { try { var a = almacen(); if (a) a.removeItem(PREFIJO + id); } catch (e) { return; } }
  /** El valor como texto con las claves ordenadas: sacar un campo y volver a ponerlo cambia el orden, no el valor. */
  function canonDe(v) {
    if (Array.isArray(v)) return '[' + v.map(canonDe).join(',') + ']';
    if (esObjeto(v)) return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canonDe(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function mismo(a, b) { return canonDe(a) === canonDe(b); }
  function cambiada(id) { return !mismo(S.borradores[id], S.originales[id]); }
  function guardarBorradores() {
    S.secciones.forEach(function (s) {
      // lo guardado de antes de recargar espera que la persona elija: no se pisa
      if (S.recuperar[s.id] || !S.bases[s.id]) return;
      if (cambiada(s.id)) guardar(s.id, { oid: S.bases[s.id].oid, base: S.bases[s.id].texto, borrador: S.borradores[s.id], original: S.originales[s.id] });
      else olvidar(s.id);
    });
  }
  /** La base de la sección: la versión sobre la que se cargó lo que hay en sus campos. */
  function baseDe(s) { return S.bases[s.id] || { texto: s.texto, oid: s.oid }; }
  /** Lo que el servidor dice que es la versión de hoy de la sección: la base nueva y su borrador sin tocar. */
  function ponerBase(s, sec) {
    S.bases[s.id] = { texto: sec.texto === undefined ? null : sec.texto, oid: sec.oid === undefined ? null : sec.oid };
    S.originales[s.id] = copia(sec.borrador === undefined ? {} : sec.borrador);
  }

  // ── la pestaña oculta no pregunta: lo pendiente espera a que vuelva a verse ──
  var alVerse = [];
  function oculta() { return document.hidden === true; }
  function cuandoSeVea(fn) { if (oculta()) alVerse.push(fn); else fn(); }
  if (document.addEventListener) document.addEventListener('visibilitychange', function () { if (oculta()) return; var l = alVerse; alVerse = []; l.forEach(function (f) { f(); }); });
  /** Un setTimeout que no retiene al proceso cuando la página corre en una prueba de Node. */
  function despues(ms, fn) { var t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }
  /** La marca de una propuesta: 16 bytes al azar, en 32 caracteres hexadecimales en minúscula. */
  function nuevaMarca() {
    var b = [], i;
    if (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) { var a = new Uint8Array(16); crypto.getRandomValues(a); for (i = 0; i < 16; i++) b.push(a[i]); }
    else for (i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256));
    return b.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
  }

  // ── lo que ve la persona de cada sección: el nombre llano, para qué sirve, y en qué bloque va ──
  var PLANO = {
    organizacion: { t: T('pantalla.laOrganizacion'), d: T('pantalla.elNombreYElLogo'), corto: T('pantalla.laOrganizacion') },
    sitio: { t: T('pantalla.quienEntraAlSitio'), d: T('pantalla.laListaDeQuienEntra'), corto: T('pantalla.quienEntraAlSitio') },
    personas: { t: T('pantalla.personasYMaquinas'), d: T('pantalla.cadaMaquinaQueMandaCorridas'), corto: T('pantalla.personasYMaquinas') },
    responsables: { t: T('pantalla.aQuienLeLleganLos'), d: T('pantalla.cuandoAlgoDeLaNoche'), corto: T('pantalla.responsables') },
    repos: { t: T('pantalla.dondeViveCadaRepo'), d: T('pantalla.llegaATodasLasMaquinas'), corto: T('pantalla.repos') },
    despliegues: { t: T('pantalla.desplieguesDeCadaProducto'), d: T('pantalla.conEstoElSitioSabe'), corto: T('pantalla.despliegues') },
    canal: { t: T('pantalla.dondeLlegaElResumenDe'), d: T('pantalla.elCanalDondeLaNoche'), corto: T('pantalla.avisoDiario') },
    umbrales: { t: T('pantalla.umbralesCuandoAlgoSePinta'), d: T('pantalla.elTableroColoreaCadaNumero'), corto: T('pantalla.umbrales') },
    suites: { t: T('pantalla.dondeCorrenLasPruebasCompletas'), d: T('pantalla.llegaATodasLasMaquinas2'), corto: T('pantalla.pruebasAlMergear') },
    modelos: { t: T('pantalla.queModeloUsaCadaTrabajo'), d: T('pantalla.llegaATodasLasMaquinas3'), corto: T('pantalla.modelos') },
    paridad: { t: T('pantalla.diferenciasAceptadasEntreProductos'), d: T('pantalla.cadaNocheSeComparanLos'), corto: T('pantalla.diferenciasEntreProductos') },
    espera: { t: T('pantalla.avisoDeEspera'), d: T('pantalla.llegaATodasLasMaquinas4'), corto: T('pantalla.avisoDeEspera') },
    cobertura: { t: T('pantalla.coberturaDeLasPruebas'), d: T('pantalla.llegaATodasLasMaquinas5'), corto: T('pantalla.coberturaDeLasPruebas') },
    revision: { t: T('pantalla.vueltasDeRevisores'), d: T('pantalla.vueltasDeRevisoresAyuda'), corto: T('pantalla.vueltasDeRevisores') },
    tecnologia: { t: T('pantalla.tecTuTecnologia'), d: T('pantalla.tecLlegaATodasLasMaquinas'), corto: T('pantalla.tecTuTecnologia') },
    respuesta: { t: T('pantalla.comoContestaClaude'), d: T('pantalla.elIdiomaElEstiloY'), corto: T('pantalla.comoContestaClaude') },
    aprobaciones: { t: T('pantalla.quienReenviaElOkTitulo'), d: T('pantalla.quienReenviaElOkDescripcion'), corto: T('pantalla.quienReenviaElOkTitulo') },
    pruebaAMano: { t: T('pantalla.pruebaAManoTitulo'), d: T('pantalla.pruebaAManoDescripcion'), corto: T('pantalla.pruebaAManoTitulo') },
    integraciones: { t: T('pantalla.integraciones'), d: T('pantalla.queServiciosUsaCadaMaquina'), corto: T('pantalla.integraciones') },
    ado: { t: 'Azure DevOps', d: T('pantalla.laOrganizacionDeLaPlataforma', { plataforma: 'Azure DevOps' }), corto: 'Azure DevOps' },
    actualizacion: { t: T('pantalla.comoSeActualizanLasMaquinas'), d: T('pantalla.queVersionTomaCadaMaquina'), corto: T('pantalla.actualizacion') },
    paquetes: { t: T('pantalla.paquetesDeLaOrganizacion'), d: T('pantalla.quePaquetesDelArnesRevisores'), corto: T('pantalla.paquetes') },
    instalacion: { t: T('pantalla.perfilDeInstalacion'), d: T('pantalla.cuantoInstalaElArnesEn'), corto: T('pantalla.instalacion') },
    hilos: { t: T('pantalla.conversacionesDeLasCorridas'), d: T('pantalla.siElSitioBajaTambien'), corto: T('pantalla.conversaciones') },
    fichas: { t: T('pantalla.fichasQueMuestraElSitio'), d: T('pantalla.lasFichasDelTablero'), corto: T('pantalla.fichas') },
    pedidos: { t: T('pantalla.pedidosDeVulnerabilidades'), d: T('pantalla.pedidosDeVulnerabilidadesAyuda'), corto: T('pantalla.pedidosDeVulnerabilidades') },
    aplicar: { t: T('pantalla.losCambiosDeUnMantenedor'), d: T('pantalla.siUnCambioQuePropone'), corto: T('pantalla.losCambiosDeUnMantenedor') },
    aldia: { t: T('pantalla.comoSeActualizaElSitio'), d: T('pantalla.siElSitioSePone'), corto: T('pantalla.actualizacionDelSitio') },
  };
  // las pestañas: [id, nombre, secciones, tablas para mirar]. Se ve una por vez; el resumen de arriba, en todas
  var PESTANAS = [['personas', T('pantalla.personas'), ['organizacion', 'sitio', 'aplicar', 'aldia', 'personas', 'responsables'], []], ['repos', T('pantalla.reposYProductos'), ['repos', 'despliegues', 'paridad', 'ado'], ['productos']], ['avisos', T('pantalla.avisosYLaNoche'), ['canal', 'espera', 'umbrales', 'fichas', 'pedidos'], []], ['claude', T('pantalla.comoTrabajaClaude'), ['respuesta', 'modelos', 'suites', 'cobertura', 'revision', 'tecnologia', 'aprobaciones', 'pruebaAMano', 'integraciones', 'hilos'], []], ['instalacion', T('pantalla.instalacionYActualizacion'), ['actualizacion', 'instalacion', 'paquetes'], ['contenido', 'versiones']]];
  /** La pestaña de un ancla (#pestana-x, #seccion-x o una tabla para mirar); null si no es de ninguna. */
  function pestanaDe(ancla) {
    var id = String(ancla || '').replace(/^#/, '');
    var hit = null;
    PESTANAS.forEach(function (p) { if (hit) return; if (id === 'pestana-' + p[0] || p[2].some(function (x) { return id === 'seccion-' + x; }) || p[3].indexOf(id) >= 0) hit = p[0]; });
    // una sección que esta pantalla no conoce va a la última pestaña, donde se muestra
    if (!hit && id.indexOf('seccion-') === 0 && S.secciones.some(function (s) { return 'seccion-' + s.id === id; })) hit = PESTANAS[PESTANAS.length - 1][0];
    return hit;
  }
  var REPO_DE = { operaciones: T('pantalla.elRepoDeOperaciones'), perfil: T('pantalla.elRepoDelEquipo') };
  function plano(s) { return PLANO[s.id] || { t: s.titulo, d: '', corto: s.titulo }; }
  function bloqueada(s) { return s.estado === 'no_reader' || s.estado === 'ilegible' || s.estado === 'no_configurado' || s.estado === 'bajando'; }
  /** El estado de una sección en una palabra: [clase, texto]. */
  function estadoDe(s) {
    if (s.estado === 'ilegible') return ['bad', T('pantalla.hayQueArreglarlaAMano')];
    if (s.estado === 'no_reader') return ['nm', T('pantalla.todaviaNoDisponible')];
    if (s.estado === 'no_configurado') return ['nm', s.falta ? T('pantalla.falta') + s.falta : T('pantalla.sinConfigurar')];
    if (s.estado === 'bajando') return ['nm', T('pantalla.bajandoElRepoDelEquipo')];
    if (s.soloLectura) return ['nm', T('pantalla.soloParaMirar')];
    var n = (S.problemas[s.id] || []).length;
    if (n) return ['warn', n + T('pantalla.paraCorregir')];
    if (S.textos[s.id]) return ['ok', T('pantalla.revisada')];
    if (s.estado === 'nuevo') return ['nm', T('pantalla.seCreaAlProponer')];
    if (s.id === 'personas' && s.extras && (s.extras.porConfirmar || []).length) return ['warn', s.extras.porConfirmar.length + T('pantalla.porConfirmar')];
    return ['ok', T('pantalla.alDia')];
  }
  // ── los mensajes de los lectores, en castellano llano: la ruta con nombres de la pantalla y sin claves del archivo ──
  var PALABRAS = {
    site: T('pantalla.elSitio'), maintainers: T('pantalla.quienMantieneElSitio'), mailbox: T('pantalla.dondeDejanSusCorridas'), provider: T('pantalla.servicio'), account: T('pantalla.cuenta'), container: T('pantalla.carpeta'), threads: T('pantalla.conversaciones2'), refresh_minutes: T('pantalla.cadaCuantoSeActualiza'), url: T('pantalla.direccion'),
    people: T('pantalla.palabraPersonas'), machines: T('pantalla.maquinas'), projects: T('pantalla.proyectos'), person: T('pantalla.persona'), reported_sha256: T('pantalla.correoInformado'), confirmed_by: T('pantalla.confirmadaPor'), confirmed_on: T('pantalla.confirmadaEl'), add: T('pantalla.suma'), remove: T('pantalla.saca'),
    owners: T('pantalla.palabraResponsables'), reviewers: T('pantalla.revisores'), default: T('pantalla.porDefecto'), by_project: T('pantalla.porProyecto'), dependencies: T('pantalla.dependencias'), watcher: T('pantalla.vigilante'),
    deployments: T('pantalla.palabraDespliegues'), products: T('pantalla.palabraProductos'), staging: T('pantalla.prueba'), production: T('pantalla.produccion'), pipeline: T('pantalla.pipeline'), stages: T('pantalla.pasos'), environment: T('pantalla.entorno'), workflow: T('pantalla.workflow'),
    work_items: T('pantalla.pedidosDeVulnerabilidades'), type: T('pantalla.pedidosTipo'), fixed_fields: T('pantalla.pedidosCamposFijos'), by_severity: T('pantalla.pedidosPorGravedad'),
    notify: T('pantalla.avisoDiario2'), channel: T('pantalla.palabraCanal'), thresholds: T('pantalla.palabraUmbrales'), direction: T('pantalla.mejorSiEs'), ok_min: T('pantalla.verdeDesde'), ok_max: T('pantalla.verdeHasta'), bad_max: T('pantalla.rojoHasta'), bad_min: T('pantalla.rojoDesde'),
    merge_suites: T('pantalla.pruebasAlMergear2'), rule: T('pantalla.regla'), full_tests_pipeline: T('pantalla.pipelineDeLasPruebasCompletas'), models: T('pantalla.palabraModelos'), mandatory_ceiling: T('pantalla.techoObligatorio'), ceiling: T('pantalla.techo'), reviewer: T('pantalla.revisor'), reviewers_reloop: T('pantalla.revisoresDeLaSegundaVuelta'), adversarial: T('pantalla.paseAdversarial'), helpers: T('pantalla.ayudantes'), session: T('pantalla.sesion'), model: T('pantalla.modelo'), heavy: T('pantalla.pesado'), fable_question: T('pantalla.preguntaAntesDeUsarFable'), low: T('pantalla.liviano'), normal: T('pantalla.normal'),
    wait_notice: T('pantalla.avisoDeEspera2'), minutes: T('pantalla.minutos'), coverage: T('pantalla.coberturaDeLasPruebas2'), min_touched_lines_pct: T('pantalla.porcentajeMinimoDeLasLineas'), review: T('pantalla.vueltasDeRevisores2'), max_rounds: T('pantalla.topeDeVueltas'), blocking_prefixes: T('pantalla.prefijosDeSeguridadODatos'), public: T('pantalla.repoPublico'), profile: T('pantalla.repoDelEquipo'), operations: T('pantalla.repoDeOperaciones'), org: T('pantalla.organizacion'), project: T('pantalla.proyecto'), repo: T('pantalla.repo'), repos: T('pantalla.palabraRepos'), platform: T('pantalla.plataforma'),
    // las hojas de «Cómo contesta Claude» y «Cómo se actualizan»: con el nombre de su campo, también en un valor que se pisó
    style: T('pantalla.estilo'), language: T('pantalla.idioma'), max_chars: T('pantalla.largoMaximoDeProsaEn').split(' (')[0], apply: T('pantalla.comoSeAplica'),
    stack: T('pantalla.tecTuTecnologia2'), code_extensions: T('pantalla.tecTerminaciones'), test_runners: T('pantalla.tecHerramientasDePrueba'), rules: T('pantalla.tecReglas'), test_names: T('pantalla.tecEstiloDeNombres2'), screen_test: T('pantalla.tecPantallasConPrueba'), ui_language: T('pantalla.tecIdiomaDeLaApp2'), name: T('pantalla.tecNombre2'), detect: T('pantalla.tecArchivoQueLaDetecta2'), command: T('pantalla.tecComando2'), results: T('pantalla.tecReporte'), format: T('pantalla.tecFormato'), path: T('pantalla.tecRuta'),
    response: T('pantalla.comoContestaClaude2'), integrations: T('pantalla.palabraIntegraciones'), ado: 'Azure DevOps', update: T('pantalla.actualizacion2'), install: T('pantalla.instalacion2'), packs: T('pantalla.palabraPaquetes'), diferencias_declaradas: T('pantalla.diferenciasDeclaradas'), version: T('pantalla.version'),
  };
  /** La ruta de un problema con los nombres de la pantalla: «personas › máquinas › «mac-1»»; un número es la fila. */
  function rutaLlana(ruta) {
    if (!ruta) return '';
    return String(ruta).split('.').map(function (p) { return /^\d+$/.test(p) ? T('pantalla.fila') + (Number(p) + 1) : PALABRAS[p] || '«' + p + '»'; }).join(' › ');
  }
  // [patrón, frase]: los mensajes que nombran claves del archivo, dichos con las palabras de la pantalla
  var FRASES = [
    [/^clave desconocida( \(secciones válidas:.*)?$/, T('pantalla.elArnesNoConoceEste')],
    [/^falta$/, T('pantalla.faltaCompletarlo')],
    [/^tiene que ser (un objeto|una lista)\b.*$/, T('pantalla.estaEscritoConUnaForma')],
    [/^tiene que ser true o false.*$/, T('pantalla.tieneQueSerSiO')],
    [/^un techo sin «mandatory_ceiling: true» no limita nada$/, T('pantalla.unTechoQueNoEs')],
    [/^con techo obligatorio falta «ceiling»$/, T('pantalla.conElTechoObligatorioFalta')],
    [/^este repo ya tiene una entrada en merge_suites\.repos$/, T('pantalla.esteRepoYaEstaEn')],
    [/^tiene que traer rule o full_tests_pipeline.*$/, T('pantalla.tieneQueDecirLaRegla')],
    [/^(«[^»]*») está en add y en remove: va en una sola$/, T('pantalla.1EstaParaSumarY')],
    [/^tiene que declarar staging, production o los dos$/, T('pantalla.tieneQueTenerElPaso')],
    [/^sólo va en staging: (.*)$/, T('pantalla.soloVaEnElPaso')],
    [/^tiene que ser «ask» o «never»(.*)$/, T('pantalla.tieneQueSerPreguntarO')],
    [/^pasa el tope obligatorio \(([a-z]+)\)$/, T('pantalla.pasaElTopeObligatorio')],
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
    if (detalle) box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: T('pantalla.detalle') }), el('span', { text: detalle })));
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
    box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: T('pantalla.editarComoTexto') }), editorGenerico(s, d, pr, clave, titulo)));
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
  function quitar(onclick) { return el('button', { class: 'sec', type: 'button', text: '✕', title: T('pantalla.quitar'), 'aria-label': T('pantalla.quitar'), onclick: onclick }); }
  function listaDeTextos(titulo, ayuda, lista, set, p, problemas, nombre, agregar) {
    var box = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: titulo }), ayuda ? el('p', { class: 'sub-d', text: ayuda }) : null);
    if (!(lista || []).length) box.appendChild(el('p', { class: 'muted', text: T('pantalla.nadieTodavia') }));
    (lista || []).forEach(function (v, i) {
      box.appendChild(el('div', { class: 'fila quitar' }, campo('', v, function (nv) { lista[i] = nv; set(lista); }, p + '.' + i, problemas, { placeholder: nombre }), quitar(function () { lista.splice(i, 1); set(lista); render(); })));
    });
    box.appendChild(el('button', { class: 'mas', type: 'button', text: '+ ' + (agregar || T('pantalla.agregar')), onclick: function () { lista.push(''); set(lista); render(); } }));
    problemasEn(problemas, p).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function repoFila(titulo, ayuda, repo, set, p, problemas) {
    var r = repo || { platform: 'azure', org: '', project: '', repo: '' };
    var plat = el('select', { 'data-path': p + '.platform', 'aria-label': T('pantalla.donde'), onchange: function (e) { var v = e.target.value; var nr = { platform: v, org: r.org || '', repo: r.repo || '' }; if (v === 'azure') nr.project = r.project || ''; set(nr); render(); } },
      el('option', { value: 'azure', text: 'Azure DevOps' }), el('option', { value: 'github', text: T('pantalla.github') }));
    plat.value = r.platform === 'github' ? 'github' : 'azure';
    var upd = function (k) { return function (v) { r[k] = v; set(r); }; };
    return el('div', { class: 'fila repo' }, el('div', { class: 'k', text: titulo }, el('small', { text: ayuda })), el('div', { class: 'campo' }, el('label', { text: T('pantalla.donde') }), plat),
      campo(T('pantalla.organizacion2'), r.org, upd('org'), p + '.org', problemas), r.platform === 'github' ? campo(T('pantalla.proyecto2'), '', function () {}, p + '.project', problemas, { disabled: 'disabled', placeholder: T('pantalla.noAplicaEnGithub') }) : campo(T('pantalla.proyecto2'), r.project, upd('project'), p + '.project', problemas), campo(T('pantalla.repo2'), r.repo, upd('repo'), p + '.repo', problemas));
  }

  // ── los editores por sección ──
  var REPO_SLOTS = [['public', T('pantalla.elArnes'), T('pantalla.elQueSeInstala')], ['profile', T('pantalla.elDelEquipo'), T('pantalla.llegaACadaMaquina')], ['operations', T('pantalla.operaciones'), T('pantalla.loDeLaNocheNo')], ['maintainers', T('pantalla.mantenimiento'), T('pantalla.opcional')]];
  function editorRepos(s, d, pr) {
    var box = el('div', {});
    REPO_SLOTS.forEach(function (par) { var k = par[0]; if (k === 'maintainers' && !d[k]) { box.appendChild(el('button', { class: 'mas', type: 'button', text: T('pantalla.agregarElRepoDeMantenimiento'), onclick: function () { d[k] = { platform: 'azure', org: '', project: '', repo: '' }; render(); } })); return; } box.appendChild(repoFila(par[1], par[2], d[k], function (v) { d[k] = v; }, k, pr)); });
    return box;
  }
  function editorResponsables(s, d, pr) {
    d.owners = d.owners || { default: '' }; d.reviewers = d.reviewers || {};
    var box = el('div', { class: 'pila' }, campo(T('pantalla.responsablePorDefectoSuUsuario'), d.owners.default, function (v) { d.owners.default = v; }, 'owners.default', pr));
    var byp = d.owners.by_project || {};
    var sub = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.responsablePorProyecto') }), el('p', { class: 'sub-d', text: T('pantalla.opcionalUnProyectoQueNo') }));
    Object.keys(byp).forEach(function (name) { sub.appendChild(el('div', { class: 'fila quitar3' }, campo('', name, function () {}, 'owners.by_project', pr, { disabled: 'disabled' }), campo('', byp[name], function (v) { byp[name] = v; }, 'owners.by_project.' + name, pr, { placeholder: T('pantalla.usuario') }), quitar(function () { delete byp[name]; if (!Object.keys(byp).length) delete d.owners.by_project; render(); }))); });
    var np = el('input', { placeholder: T('pantalla.nombreDelProyecto'), 'aria-label': T('pantalla.proyectoNuevo') });
    sub.appendChild(el('div', { class: 'fila quitar' }, np, el('button', { class: 'sec', type: 'button', text: T('pantalla.agregarProyecto'), onclick: function () { var v = np.value.trim(); if (!v) return; d.owners.by_project = d.owners.by_project || {}; d.owners.by_project[v] = ''; render(); } })));
    box.appendChild(sub);
    box.appendChild(listaDeTextos(T('pantalla.revisanLosPedidosDeDependencias'), null, d.reviewers.dependencies = d.reviewers.dependencies || [], function (l) { d.reviewers.dependencies = l; }, 'reviewers.dependencies', pr, T('pantalla.usuario'), T('pantalla.agregarPersona')));
    box.appendChild(listaDeTextos(T('pantalla.revisanLosHallazgosDelVigilante'), null, d.reviewers.watcher = d.reviewers.watcher || [], function (l) { d.reviewers.watcher = l; }, 'reviewers.watcher', pr, T('pantalla.usuario'), T('pantalla.agregarPersona')));
    return box;
  }
  // quién entra al sitio y con qué rol: una tabla con un renglón por persona: el rol, sus
  // correos como etiquetas con su ✕ y un + para sumar otro, y el ✕ que quita a la persona. Sólo cambia cómo se ve: cada
  // entrada sigue siendo { role, emails[] }
  var CORREO_A_ENFOCAR = null;
  function editorAcceso(site, pr, ex) {
    var box = el('div', { class: 'pila' });
    if (ex.inicioDeSesion) box.appendChild(el('p', { class: 'sub-d', text: T('pantalla.conQueSeEntra') + ex.inicioDeSesion.texto + T('pantalla.estoSeCambiaEnLa') }));
    if (ex.migracion) box.appendChild(aviso('warn', T('pantalla.laListaTodaviaNoEsta'), ex.migracion));
    box.appendChild(el('p', { class: 'sub-d', text: T('pantalla.nadieEntraSiNoEsta') }));
    var acc = site.access = site.access || [];
    var tabla = el('div', { class: 'personas', role: 'table', 'aria-label': T('pantalla.lasPersonas') },
      el('div', { class: 'h', role: 'row' }, el('span', { role: 'columnheader', text: T('pantalla.rol') }), el('span', { role: 'columnheader', text: T('pantalla.correos') }), el('span', { role: 'columnheader' })));
    acc.forEach(function (e, i) {
      var p = 'site.access.' + i;
      // todo problema de la persona va en su renglón, también el de una clave que la tabla no dibuja
      var mios = (pr || []).filter(function (x) { return x.path === p || String(x.path).indexOf(p + '.') === 0; });
      MOSTRADOS = MOSTRADOS.concat(mios);
      var quitarPersona = el('div', { class: 'acc', role: 'cell' }, el('button', { class: 'quitar-persona', type: 'button', text: '✕', title: T('pantalla.quitarPersona'), 'aria-label': T('pantalla.quitarPersona'), onclick: function () { acc.splice(i, 1); render(); } }));
      var conAvisos = function (fila, propios) {
        var errores = el('div', { class: 'err-fila', role: 'cell' });
        propios.forEach(function (texto) { errores.appendChild(el('div', { class: 'err', text: texto })); });
        fila.appendChild(errores);
      };
      // una entrada que no es una persona se ve con su aviso y se puede quitar: dibujarla no la cambia
      if (!esObjeto(e)) {
        var rara = el('div', { class: 'persona con-error', role: 'row' }, el('div', { class: 'rol', role: 'cell' }), el('div', { class: 'correos', role: 'cell' }, el('span', { class: 'muted', text: JSON.stringify(e) })), quitarPersona);
        conAvisos(rara, [T('pantalla.entradaNoEsPersona')].concat(mios.map(function (x) { return x.message; })));
        tabla.appendChild(rara);
        return;
      }
      if (e.emails == null) e.emails = [];
      var con = function (ruta) { return mios.some(function (x) { return x.path === ruta; }); };
      var fila = el('div', { class: 'persona' + (mios.length || !Array.isArray(e.emails) ? ' con-error' : ''), role: 'row' });
      var rol = el('select', { 'aria-label': T('pantalla.rol'), 'data-path': p + '.role', class: con(p + '.role') ? 'bad' : undefined, onchange: function (ev) { e.role = ev.target.value; } },
        el('option', { value: 'maintainer', text: T('pantalla.mantieneElSitio') }), el('option', { value: 'dev', text: T('pantalla.dev') }));
      rol.value = e.role == null ? '' : String(e.role);
      fila.appendChild(el('div', { class: 'rol', role: 'cell' }, rol));
      var correos = el('div', { class: 'correos', role: 'cell' });
      // correos que no son una lista: se muestran tal cual, con su aviso; el + los reemplaza por una lista nueva
      if (!Array.isArray(e.emails)) correos.appendChild(el('span', { class: 'muted', text: JSON.stringify(e.emails) }));
      (Array.isArray(e.emails) ? e.emails : []).forEach(function (m, j) {
        var ruta = p + '.emails.' + j;
        if (m === '') {
          // el correo recién sumado: se guarda al tipear, sin redibujar (así no se pierde el clic en «Revisar cambios»)
          var nuevo = el('input', { class: 'nuevo' + (con(ruta) ? ' bad' : ''), type: 'email', value: '', placeholder: T('pantalla.correo'), 'aria-label': T('pantalla.agregarCorreoUno'), 'data-path': ruta,
            oninput: function (ev) { e.emails[j] = ev.target.value; },
            onkeydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); CORREO_A_ENFOCAR = null; render(); } } });
          correos.appendChild(nuevo);
          if (CORREO_A_ENFOCAR === ruta) { CORREO_A_ENFOCAR = null; setTimeout(function () { if (nuevo.focus) nuevo.focus(); }, 0); }
          return;
        }
        correos.appendChild(el('span', { class: 'correo' + (con(ruta) ? ' bad' : ''), title: m, 'data-path': ruta }, el('span', { text: m }),
          el('button', { class: 'chip-x', type: 'button', text: '✕', title: T('pantalla.quitarCorreo') + ' ' + m, 'aria-label': T('pantalla.quitarCorreo') + ' ' + m, onclick: function () { e.emails.splice(j, 1); render(); } })));
      });
      correos.appendChild(el('button', { class: 'sumar', type: 'button', text: '+', title: T('pantalla.agregarCorreoUno'), 'aria-label': T('pantalla.agregarCorreoUno'), onclick: function () { if (!Array.isArray(e.emails)) e.emails = []; e.emails.push(''); CORREO_A_ENFOCAR = p + '.emails.' + (e.emails.length - 1); render(); } }));
      fila.appendChild(correos);
      fila.appendChild(quitarPersona);
      var avisos = Array.isArray(e.emails) ? [] : [T('pantalla.correosNoSonLista')];
      mios.forEach(function (x) {
        // con su correo adelante, salvo que el mensaje ya lo nombre (el del servidor: «x» no es un correo)
        var j = /\.emails\.(\d+)$/.exec(String(x.path));
        var escrito = j && Array.isArray(e.emails) ? e.emails[j[1]] : null;
        var nombra = typeof escrito === 'string' && escrito !== '' && String(x.message).indexOf(escrito) >= 0;
        avisos.push((j && Array.isArray(e.emails) && !nombra ? (escrito || T('pantalla.correo')) + ': ' : '') + x.message);
      });
      if (avisos.length) conAvisos(fila, avisos);
      tabla.appendChild(fila);
    });
    if (acc.length) box.appendChild(tabla);
    else box.appendChild(el('p', { class: 'muted', text: T('pantalla.nadieTodavia') }));
    box.appendChild(el('button', { class: 'mas', type: 'button', text: T('pantalla.agregarPersona2'), onclick: function () { acc.push({ role: 'dev', emails: [''] }); CORREO_A_ENFOCAR = 'site.access.' + (acc.length - 1) + '.emails.0'; render(); } }));
    problemasEn(pr, 'site.access').forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function editorSitio(s, d, pr) {
    d.site = d.site || {};
    var site = d.site;
    var ex = s.extras || {};
    var lista = el('div', { class: 'pila' });
    if (ex.conAcceso) { delete site.maintainers; lista.appendChild(editorAcceso(site, pr, ex)); }
    else {
      var mant = listaDeTextos(T('pantalla.lasPersonas'), null, site.maintainers = site.maintainers || [], function (l) { site.maintainers = l; }, 'site.maintainers', pr, T('pantalla.correo'), T('pantalla.agregarPersona'));
      mant.setAttribute('class', 'pila');
      lista.appendChild(mant);
    }
    var refresco = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.cadaCuantoSeActualizaEl') }), el('p', { class: 'sub-d', text: T('pantalla.queReleeElSitio') }), campo(T('pantalla.minutosEntre5Y120'), site.refresh_minutes, function (v) { site.refresh_minutes = v === '' ? undefined : numOTexto(v); }, 'site.refresh_minutes', pr, { inputmode: 'numeric' }), el('p', { class: 'sub-d', text: T('pantalla.siNoLoDeclarasQuinceMinutos') }));
    lista.appendChild(refresco);
    if (s.campos && s.campos.url) lista.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.laDireccionDelSitio') }), campo('', site.url, function (v) { site.url = v || undefined; }, 'site.url', pr)));
    var mb = site.mailbox || {};
    var buzon = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.dondeDejanSusCorridasLas') }), el('p', { class: 'sub-d', text: T('pantalla.lasContrasenasNoVanAca') }));
    var f = el('div', { class: 'fila' });
    var servicios = (s.extras && s.extras.servicios) || null;
    var SERVICIO = { 'azure-blob': 'Azure Blob Storage' };
    [['provider', T('pantalla.servicio2')], ['account', T('pantalla.cuenta2')], ['container', T('pantalla.carpeta2')]].forEach(function (par) {
      var k = par[0]; var poner = function (v) { site.mailbox = site.mailbox || {}; if (v === '') delete site.mailbox[k]; else site.mailbox[k] = v; };
      if (k === 'provider' && servicios) f.appendChild(selector(par[1], mb[k], [['', T('pantalla.elegiElServicio')]].concat(servicios.map(function (x) { return [x, SERVICIO[x] || x]; })), poner, 'site.mailbox.' + k, pr));
      else f.appendChild(campo(par[1], mb[k], function (v) { site.mailbox = site.mailbox || {}; site.mailbox[k] = v; }, 'site.mailbox.' + k, pr));
    });
    buzon.appendChild(f);
    lista.appendChild(buzon);
    if (s.avisoLista) lista.appendChild(el('div', { class: 'aviso', text: s.avisoLista }));
    return lista;
  }
  function editorGenerico(s, d, pr, clave, titulo) {
    // una sección sin formulario propio: se edita como texto de esa parte
    var ta = el('textarea', { rows: '8', spellcheck: 'false', 'aria-label': titulo, 'data-path': clave, oninput: function (e) { try { d[clave] = JSON.parse(e.target.value); S.notas[s.id] = null; } catch (err) { S.notas[s.id] = { ok: false, text: T('pantalla.elTextoNoEstaBien') + err.message }; } } });
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
      return (e.stages || []).map(function (id) { return nombres[id] || id; }).join(', ') + (pipe ? T('pantalla.pipeline2') + pipe + ')' : '');
    }).join(' · ') || '—';
  }
  function editorDespliegues(s, d, pr) {
    var box = el('div', { class: 'pila' });
    var prods = d.deployments && d.deployments.products && typeof d.deployments.products === 'object' ? d.deployments.products : {};
    var nombres = Object.keys(prods).filter(function (k) { return k.indexOf('__') !== 0; });
    if (!nombres.length) box.appendChild(el('p', { class: 'muted', text: T('pantalla.ningunProductoTodavia') }));
    nombres.forEach(function (n) {
      var p = prods[n] || {};
      box.appendChild(el('div', { class: 'despliegue' }, el('div', {}, el('div', { class: 'lab', text: T('pantalla.producto') }), el('div', { class: 'prod', text: n })),
        el('div', {}, el('div', { class: 'lab', text: T('pantalla.prueba2') }), el('div', { text: textoDeEntradas(p.staging) })),
        el('div', {}, el('div', { class: 'lab', text: T('pantalla.produccion2') }), el('div', { text: textoDeEntradas(p.production) }))));
    });
    var producto = el('input', { placeholder: T('pantalla.nombreDelProducto'), 'aria-label': T('pantalla.producto') });
    var sel = el('input', { placeholder: T('pantalla.numeroDelPipelineODueno'), 'aria-label': T('pantalla.pipeline3') });
    var nombrePipeline = el('input', { placeholder: T('pantalla.proyectoNombreDelPipeline', { plataforma: 'Azure' }), 'aria-label': T('pantalla.nombreDelPipeline') });
    var nota = el('div', {});
    // con la lista del proyecto de operaciones, el pipeline se elige por su nombre y completa los dos campos de abajo
    var ex = s.extras || {};
    var lista = ex.plataforma === 'azure' ? listaDePipelines(pipelinesDe(ex.org, ex.proyecto)) : null;
    var eleccion = lista ? selector(T('pantalla.pipeline3'), '', [['', T('pantalla.elegiElPipeline')]].concat(lista.map(function (x) { return [String(x.id), x.nombre]; })), function (v) {
      var x = lista.filter(function (y) { return String(y.id) === v; })[0];
      sel.value = x ? ex.proyecto + '/' + x.id : ''; nombrePipeline.value = x ? ex.proyecto + '/' + x.nombre : '';
    }, 'deployments.pipeline', pr) : null;
    var agregar = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.agregarUnProducto') }), el('p', { class: 'sub-d', text: T('pantalla.elegisElPipelineYEl') }),
      eleccion,
      el('div', { class: 'fila' }, producto, lista ? el('details', { class: 'mas-info' }, el('summary', { text: T('pantalla.escribirloAMano') }), sel, nombrePipeline) : sel, lista ? null : nombrePipeline, el('button', { class: 'sec', type: 'button', text: T('pantalla.verSusPasos'), onclick: function () {
        api('/stages', { pipeline: sel.value }).then(function (r) {
          nota.replaceChildren();
          if (!r.ok) { nota.appendChild(el('div', { class: 'err', text: r.message })); return; }
          var ul = el('ul', { class: 'renglones' });
          (r.propuestos || []).forEach(function (st) { ul.appendChild(el('li', {}, el('span', { class: 'quien', text: st.nombre || st.identificador }), el('span', { class: 'dato', text: st.nombre ? st.identificador : '' }), el('span', { class: 'acc' }, el('button', { class: 'sec', type: 'button', text: T('pantalla.esLaPrueba'), onclick: function () { confirmarStage(d, producto.value, sel.value, nombrePipeline.value, 'staging', st.identificador); } }), el('button', { class: 'sec', type: 'button', text: T('pantalla.esProduccion'), onclick: function () { confirmarStage(d, producto.value, sel.value, nombrePipeline.value, 'production', st.identificador); } })))); });
          nota.appendChild(el('p', { class: 'muted', text: T('pantalla.nadaSeGuardaHastaQue') }));
          nota.appendChild(ul);
        });
      } })), nota);
    box.appendChild(agregar);
    box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: T('pantalla.editarComoTexto') }), editorGenerico(s, d, pr, 'deployments', T('pantalla.desplieguesComoTexto'))));
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
    if (ex.vencido) box.appendChild(aviso('bad', T('pantalla.laListaDePersonasEsta'), ex.vencido));
    if (ex.ultimoBueno) box.appendChild(aviso('warn', T('pantalla.seMuestraLaUltimaVersion'), ex.ultimoBueno));
    var pc = el('ul', { class: 'renglones' });
    (ex.porConfirmar || []).forEach(function (m) {
      var persona = el('input', { value: m.correo || '', placeholder: T('pantalla.correoDeLaPersona'), 'aria-label': T('pantalla.correoDeLaPersona2') });
      pc.appendChild(el('li', {}, el('span', { class: 'quien', text: m.maquina }), el('span', { class: 'dato', text: (m.correo ? T('pantalla.diceSerDe') + m.correo : T('pantalla.noDiceDeQuienEs')) + T('pantalla.ultimaNoticia') + (m.dia || T('pantalla.sinFecha')) + ' · ' + (m.corridas == null ? T('pantalla.corridasSinContar') : m.corridas + T('pantalla.corridas')) }),
        el('span', { class: 'acc' }, persona, el('button', { type: 'button', text: T('pantalla.confirmar'), onclick: function () { revisarSeccion(s, { accion: 'confirm', maquina: m.maquina, person: persona.value, people: d.people }); } }))));
    });
    box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: T('pantalla.porConfirmar2') }), (ex.porConfirmar || []).length ? pc : el('p', { class: 'muted', text: T('pantalla.ninguna') })));
    // las que nunca dieron señales (sin place.json, sin fecha, sin corridas): suelen ser laboratorios o pruebas que
    // escribieron en el buzón; se nombran, sin ofrecer confirmarlas
    if ((ex.sinActividad || []).length) {
      var sa = el('ul', { class: 'renglones' });
      ex.sinActividad.forEach(function (m) { sa.appendChild(el('li', {}, el('span', { class: 'quien', text: m.maquina }), el('span', { class: 'dato', text: T('pantalla.sinCorridasSinFechaY') }))); });
      box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: T('pantalla.sinActividad') + ex.sinActividad.length + ')' }),
        el('p', { class: 'muted', text: T('pantalla.carpetasDelBuzonQueNunca') }), sa));
    }
    var machines = d.people.machines || {};
    var conf = el('ul', { class: 'renglones' });
    Object.keys(machines).forEach(function (m) {
      var e = machines[m] || {};
      var li = el('li', {}, el('span', { class: 'quien', text: m }), el('span', { class: 'dato', text: T('pantalla.de') + (e.person || T('pantalla.sinPersona')) + T('pantalla.confirmadaPor2') + (e.confirmed_by || T('pantalla.sinDato')) + T('pantalla.el') + (e.confirmed_on || T('pantalla.sinFecha')) }), el('span', { class: 'acc' }, quitar(function () { delete machines[m]; if (!Object.keys(machines).length) delete d.people.machines; render(); })));
      problemasEn(pr, 'people.machines.' + m).concat(problemasEn(pr, 'people.machines.' + m + '.confirmed_on')).forEach(function (x) { li.appendChild(el('span', { class: 'err', text: x.message })); });
      conf.appendChild(li);
    });
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.confirmadas') }), Object.keys(machines).length ? conf : el('p', { class: 'muted', text: T('pantalla.ninguna') })));
    // Lo que ve cada persona es sólo lo declarado (add). Los «quitados» (remove) de antes ya no hacen nada: se avisa
    // una vez y salen del borrador, así el próximo Proponer los limpia del archivo.
    var proyectos = d.people.projects || {};
    Object.keys(proyectos).forEach(function (k) {
      var f = proyectos[k];
      if (!f || typeof f !== 'object' || f.remove === undefined) return;
      ex.quitadosViejos = true;
      delete f.remove;
      if (!Object.keys(f).length) delete proyectos[k];
    });
    var donde = el('ul', { class: 'renglones' });
    (ex.personas || []).forEach(function (p) {
      // la clave que ya tiene en el archivo (otro de sus correos, o con mayúsculas); sin ninguna, su primer correo
      var clave = p.clave || p.correo;
      var fix = (d.people.projects || {})[clave] || {};
      var declarados = Array.isArray(fix.add) ? fix.add : [];
      var deLaPersona = function () { d.people.projects = d.people.projects || {}; var f = d.people.projects[clave] = d.people.projects[clave] || {}; f.add = Array.isArray(f.add) ? f.add : []; return f; };
      var agregar = el('input', { placeholder: T('pantalla.producto2'), 'aria-label': T('pantalla.producto') });
      var acciones = el('span', { class: 'acc' });
      declarados.forEach(function (prod) {
        acciones.appendChild(el('button', { class: 'sec', type: 'button', text: T('pantalla.quitar'), 'data-producto': prod, 'aria-label': T('pantalla.quitar') + ' ' + prod, onclick: function () { var f = deLaPersona(); f.add = f.add.filter(function (x) { return x !== prod; }); if (!f.add.length) delete d.people.projects[clave]; render(); } }));
      });
      (p.sugeridos || []).filter(function (s2) { return declarados.indexOf(s2) < 0; }).forEach(function (prod) {
        acciones.appendChild(el('span', { class: 'dato', text: T('pantalla.sugerido') + prod }));
        acciones.appendChild(el('button', { class: 'sec', type: 'button', text: T('pantalla.aceptar'), 'data-producto': prod, onclick: function () { var f = deLaPersona(); if (f.add.indexOf(prod) < 0) f.add.push(prod); render(); } }));
      });
      acciones.appendChild(agregar);
      acciones.appendChild(el('button', { class: 'sec', type: 'button', text: T('pantalla.agregar'), onclick: function () { var v = agregar.value.trim(); if (!v) return; var f = deLaPersona(); if (f.add.indexOf(v) < 0) f.add.push(v); render(); } }));
      donde.appendChild(el('li', {}, el('span', { class: 'quien', text: p.correo }), el('span', { class: 'dato', text: T('pantalla.ve') + (declarados.join(', ') || T('pantalla.nada2')) + (p.caida ? T('pantalla.susMaquinasNoMandanNoticias') : '') }), acciones));
    });
    var sub = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.enQueProyectosTrabajaCada') }), el('p', { class: 'sub-d', text: T('pantalla.elSitioLoDeduceDe') }));
    if (ex.quitadosViejos) sub.appendChild(aviso('warn', T('pantalla.quitadosViejos'), T('pantalla.quitadosViejosDetalle')));
    sub.appendChild((ex.personas || []).length ? donde : el('p', { class: 'muted', text: T('pantalla.nadieTodavia') }));
    box.appendChild(sub);
    return box;
  }
  // los nombres de los umbrales, como los titula el tablero; uno que no está acá se muestra con su clave
  var UMBRAL = {
    dod: T('pantalla.cierresQueDejaronPruebaDe'), rework: T('pantalla.storiesQueVuelvenConUn'), mutacion: T('pantalla.puntajeDeMutacionDeLas'),
    cobertura_tocada_evaluo: T('pantalla.corridasQueMidieronLaCobertura'), qa_guia: T('pantalla.cierresConLaGuiaPara'), estilo: T('pantalla.respuestasDentroDelLargoPedido'),
    bloqueo: T('pantalla.turnosSinPasosLargosQue'), vigilados: T('pantalla.productosConSuProduccionVigilada'), bus_factor_productos_en_riesgo: T('pantalla.productosQueHizoCasiUna'),
    escapes_regla_dominante: T('pantalla.escapesConcentradosEnUnaSola'), banco_rojos: T('pantalla.casosRojosDelBancoDe'), suites_rojas: T('pantalla.suitesDelArnesEnRojo'),
    deps_hallazgos: T('pantalla.hallazgosDeDependencias'), contrato_v2: T('pantalla.registrosPorMergeConEl'), corridas_al_final: T('pantalla.corridasQueLleganAlUltimo'), corridas_con_error: T('pantalla.corridasDondeUnControlEncontro'),
  };
  var CANTIDADES = { bus_factor_productos_en_riesgo: 1, banco_rojos: 1, suites_rojas: 1, deps_hallazgos: 1 };
  function editorUmbrales(s, d, pr) {
    var box = el('div', {}, el('div', { class: 'thr h' }, el('span', { text: T('pantalla.numero') }), el('span', { text: T('pantalla.mejorSiEs2') }), el('span', { text: T('pantalla.verde') }), el('span', { text: T('pantalla.rojo') })));
    Object.keys(d).forEach(function (k) {
      if (k.charAt(0) === '_' || !d[k] || typeof d[k] !== 'object') return;
      var u = d[k];
      var mayor = u.direction !== 'menor_es_mejor';
      var verde = mayor ? 'ok_min' : 'ok_max'; var rojo = mayor ? 'bad_max' : 'bad_min';
      var dir = el('select', { 'aria-label': T('pantalla.mejorSiEs2'), 'data-path': 'thresholds.' + k + '.direction', onchange: function (e) {
        // cambiar el sentido mueve los dos números a sus claves del otro sentido
        var nuevo = e.target.value; if (nuevo === u.direction) return;
        var a = u[verde], b = u[rojo]; delete u[verde]; delete u[rojo]; u.direction = nuevo;
        if (nuevo === 'menor_es_mejor') { if (a !== undefined) u.ok_max = a; if (b !== undefined) u.bad_min = b; } else { if (a !== undefined) u.ok_min = a; if (b !== undefined) u.bad_max = b; }
        render();
      } }, el('option', { value: 'mayor_es_mejor', text: T('pantalla.masAlto') }), el('option', { value: 'menor_es_mejor', text: T('pantalla.masBajo') }));
      dir.value = mayor ? 'mayor_es_mejor' : 'menor_es_mejor';
      var num = function (c, etiqueta) { var mios = problemasEn(pr, 'thresholds.' + k + '.' + c); var i = el('input', { value: u[c] == null ? '' : String(u[c]), inputmode: 'decimal', 'aria-label': etiqueta, 'data-path': 'thresholds.' + k + '.' + c, oninput: function (e) { var v = e.target.value; if (v === '') delete u[c]; else u[c] = numOTexto(v); } }); if (mios.length) i.setAttribute('class', 'bad'); return i; };
      var fila = el('div', { class: 'thr' }, el('span', { text: UMBRAL[k] || k.replace(/_/g, ' ') }, el('span', { class: 'hint', text: CANTIDADES[k] ? T('pantalla.unaCantidad') : T('pantalla.unaProporcion05Es') })), dir,
        num(verde, mayor ? T('pantalla.verdeDesde2') : T('pantalla.verdeHasta2')), num(rojo, mayor ? T('pantalla.rojoHasta2') : T('pantalla.rojoDesde2')));
      pr.filter(function (x) { return x.path === 'thresholds.' + k || String(x.path).indexOf('thresholds.' + k + '.') === 0; }).forEach(function (x) { fila.appendChild(el('div', { class: 'err', text: x.message })); });
      (S.avisos[s.id] || []).filter(function (a) { return a.path === 'thresholds.' + k; }).forEach(function (a) { fila.appendChild(el('div', { class: 'aviso', text: a.message })); });
      box.appendChild(fila);
    });
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.siEsMejorMasAlto') }));
    return box;
  }
  function editorParidad(s, d, pr) {
    var box = el('div', { class: 'pila' });
    var v = s.vista || {};
    // cada rasgo con su descripción de la lista («que»); sin ella, la clave con espacios
    var QUE = {}; ((v.definicion && v.definicion.rasgos) || []).forEach(function (r) { if (r && r.id) QUE[r.id] = r.que || r.id; });
    function queDe(rasgo) { return QUE[rasgo] || String(rasgo || '').replace(/-/g, ' '); }
    function lista(xs, fmt, nada) { var vistos = {}; var out = []; (xs || []).forEach(function (x) { var t = fmt(x); if (!vistos[t]) { vistos[t] = true; out.push(t); } }); return out.join('; ') || nada; }
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.comparacionDeHoy') + (v.texto || T('pantalla.noMedida')) + (v.fecha ? ' (' + v.fecha + ')' : '') }));
    // sólo los productos con algo para mirar; los que coinciden (salvo lo aceptado) van en una línea
    var conAlgo = (v.productos || []).filter(function (p) { return (p.faltan || []).length || (p.tiene || []).length || (p.vencidas || []).length; });
    var enOrden = (v.productos || []).length - conAlgo.length;
    if ((v.productos || []).length) box.appendChild(el('div', { class: 'msg ' + (conAlgo.length ? 'warn' : 'ok') }, el('b', { text: conAlgo.length ? conAlgo.length + T('pantalla.producto3') + (conAlgo.length === 1 ? '' : 's') + T('pantalla.conAlgoParaMirar') + (enOrden ? T('pantalla.losOtros') + enOrden + T('pantalla.coincidenConLosDemas') : '') + '.' : T('pantalla.los') + enOrden + T('pantalla.productosCoincidenConLosDemas') })));
    var prods = el('ul', { class: 'renglones' });
    conAlgo.forEach(function (p) {
      prods.appendChild(el('li', {}, el('span', { class: 'quien', text: p.producto + ' · ' + p.grupos.join(', ') }),
        el('span', { class: 'dato', text: T('pantalla.leFalta') + lista(p.faltan, function (x) { return QUE[x.rasgo] || x.que || queDe(x.rasgo); }, T('pantalla.nada2')) + T('pantalla.haceAlgoQueLosDemas') + lista(p.tiene, function (x) { return QUE[x.rasgo] || x.que || queDe(x.rasgo); }, T('pantalla.nada2')) + T('pantalla.aceptadas') + lista(p.declaradas, function (x) { return queDe(x.rasgo) + T('pantalla.hasta') + x.revision + ')'; }, T('pantalla.ninguna2')) + T('pantalla.vencidas') + lista(p.vencidas, function (x) { return queDe(x.rasgo) + ' (' + x.revision + ')'; }, T('pantalla.ninguna2')) })));
    });
    if (conAlgo.length) box.appendChild(prods);
    // la misma diferencia declarada en varios grupos va en un solo renglón; Renovar y Cerrar actúan sobre todos sus grupos
    var porRasgo = {}; var orden = [];
    (v.declaradas || []).forEach(function (x) { if (!x || !x.rasgo) return; if (!porRasgo[x.rasgo]) { porRasgo[x.rasgo] = []; orden.push(x.rasgo); } porRasgo[x.rasgo].push(x); });
    var dcl = el('ul', { class: 'renglones' });
    orden.forEach(function (rasgo) {
      var xs = porRasgo[rasgo]; var grupos = xs.map(function (x) { return x.grupo; });
      var fechas = lista(xs, function (x) { return x.revision || T('pantalla.sinFecha'); }, T('pantalla.sinFecha'));
      var motivos = lista(xs, function (x) { return x.motivo || T('pantalla.sinMotivo'); }, T('pantalla.sinMotivo'));
      var fecha = el('input', { placeholder: 'AAAA-MM-DD', 'aria-label': T('pantalla.volverAMirarEl') }); var motivo = el('input', { placeholder: T('pantalla.porQueSigueValiendo'), 'aria-label': T('pantalla.porQue') });
      dcl.appendChild(el('li', {}, el('span', { class: 'quien', text: queDe(rasgo) }), el('span', { class: 'dato' }, el('span', { text: T('pantalla.en') + grupos.join(' y ') + T('pantalla.volverAMirarEl2') + fechas }), el('details', { class: 'mas-info' }, el('summary', { text: T('pantalla.porQue') }), el('span', { text: motivos }))), el('span', { class: 'acc' }, fecha, motivo,
        el('button', { class: 'sec', type: 'button', text: T('pantalla.renovar'), onclick: function () { revisarSeccion(s, { accion: 'renew', grupos: grupos, grupo: grupos[0], rasgo: rasgo, revision: fecha.value, motivo: motivo.value }); } }),
        el('button', { class: 'sec', type: 'button', text: T('pantalla.cerrar'), onclick: function () { revisarSeccion(s, { accion: 'close', grupos: grupos, grupo: grupos[0], rasgo: rasgo }); } }))));
    });
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.lasDiferenciasAceptadas') }), orden.length ? dcl : el('p', { class: 'muted', text: T('pantalla.ninguna') })));
    if (v.definicion) {
      var t = el('table', { class: 'tabla' }, el('thead', {}, el('tr', {}, el('th', { text: T('pantalla.queSeCompara') }))));
      var tb = el('tbody', {});
      ((v.definicion.rasgos) || []).forEach(function (r) { if (r && r.id) tb.appendChild(el('tr', {}, el('td', { text: queDe(r.id) }))); });
      t.appendChild(tb);
      box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: T('pantalla.queSeComparaSeCambia') }), el('div', { class: 'tbl-wrap' }, t)));
    }
    return box;
  }
  function editorPaquetes(s, d, pr) {
    var box = el('div', {});
    var ex = s.extras || {};   // los paquetes de la versión del sitio y los que activa el valor de hoy
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.losPaquetesSumanRevisoresY') + ((ex.activos || []).join(', ') || T('pantalla.ninguno')) + '.' }));
    d.packs = d.packs || {};
    var actual = Array.isArray(d.packs.default) ? d.packs.default.join(', ') : (d.packs.default || '');
    var val = d.packs.default;
    var modo = val === undefined ? '' : val === 'all' || val === 'none' ? val : 'some';
    box.appendChild(selector(T('pantalla.quePaquetesSeActivan'), modo, [['', T('pantalla.sinDeclararNinguno')], ['all', T('pantalla.todosLosInstalados')], ['none', T('pantalla.ninguno')], ['some', T('pantalla.soloLosQueMarco')]], function (v) {
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
        lista.appendChild(el('label', {}, c, el('span', { text: ' ' + n + ((ex.instalados || []).indexOf(n) < 0 ? T('pantalla.estaVersionNoLoTrae') : '') })));
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
  var ESTILOS = [['executive', T('pantalla.ejecutivoLaConclusionPrimeroY')], ['detailed', T('pantalla.detalladoLaConclusionPrimeroY')], ['neutral', T('pantalla.neutroClaroYAlPunto')]];
  function editorRespuesta(s, d, pr) {
    var r = d.response || {}; var ex = s.extras || {}; var vg = ex.vigente || {}; var og = ex.origen || {};
    var box = el('div', { class: 'pila' });
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.hoy') + vg.style + ' · ' + vg.language + ' · ' + vg.max_chars + T('pantalla.caracteres') + (og.style === 'perfil' ? T('pantalla.delPerfil') : T('pantalla.porDefecto')) + ')' }));
    box.appendChild(selector(T('pantalla.idioma'), r.language, [['', T('pantalla.sinDeclararCastellano')], ['es', T('pantalla.castellano')], ['en', T('pantalla.ingles')]], function (v) { hoja(d, 'response', 'language', v); }, 'response.language', pr));
    box.appendChild(selector(T('pantalla.estilo'), r.style, [['', T('pantalla.sinDeclararNeutro')]].concat(ESTILOS), function (v) { hoja(d, 'response', 'style', v); }, 'response.style', pr));
    box.appendChild(campo(T('pantalla.largoMaximoDeProsaEn'), r.max_chars, function (v) { hoja(d, 'response', 'max_chars', v === '' ? '' : numOTexto(v)); }, 'response.max_chars', pr, { inputmode: 'numeric' }));
    return box;
  }
  var INTEGRACIONES = [['clockify', T('pantalla.clockifyRegistraLasHorasDe')], ['engram', T('pantalla.memoriaEntreSesionesEngram')], ['mailbox', T('pantalla.buzonDeCorridasCadaMaquina')], ['codex', T('pantalla.codexElArnesTambienSe')], ['nightly', T('pantalla.procesosDeLaNocheDel')], ['codegraph', T('pantalla.codegraphIndiceDeCodigo')]];
  // story 2.59: un renglón por integración, el nombre y su descripción a la izquierda y un selector corto a la derecha
  function editorIntegraciones(s, d, pr) {
    var i = d.integrations || {};
    var box = el('div', { class: 'pila' });
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.telegramSeConfigura') }));
    var t = tabla('integ', T('pantalla.integraciones'));
    INTEGRACIONES.forEach(function (par) {
      var k = par[0];
      var opciones = [['', T('pantalla.sinDeclararApagada')], ['true', T('pantalla.prendida2')], ['false', T('pantalla.apagada2')]].concat(k === 'codex' ? [['detect', T('pantalla.siEstaInstalado')]] : []);
      var p = 'integrations.' + k;
      var c = corto(par[1], i[k] === undefined ? '' : String(i[k]), opciones, function (v) { hoja(d, 'integrations', k, v === 'true' ? true : v === 'false' ? false : v); }, p, pr);
      // «Nombre: qué hace» → el nombre en negrita; sin dos puntos, todo es el nombre
      var dos = par[1].indexOf(': ');
      var que = el('div', { class: 'que', role: 'cell' }, el('b', { text: dos < 0 ? par[1] : par[1].slice(0, dos) }), dos < 0 ? null : el('span', { text: par[1].slice(dos) }));
      t.appendChild(renglon([que, el('div', { class: 'sel', role: 'cell' }, c.sel)], c.mios));
    });
    box.appendChild(t);
    return box;
  }
  // ── story 2.59: las tablas de renglones de Modelos, Repos e Integraciones ──
  // cada renglón es «contents» en la hoja: sus celdas caen en la grilla de la tabla y en teléfono bajan a dos líneas
  function tabla(clase, titulo, columnas) {
    var t = el('div', { class: 'tabla2 ' + clase, role: 'table', 'aria-label': titulo });
    if (columnas) { var h = el('div', { class: 'h', role: 'row' }); columnas.forEach(function (c) { h.appendChild(el('span', { role: 'columnheader', text: c })); }); t.appendChild(h); }
    return t;
  }
  // un selector corto: lo declarado se ve en negrita; con un problema en su ruta, en rojo (sus mensajes los dibuja el renglón)
  function corto(label, valor, opciones, onChange, p, problemas) {
    var mios = problemasEn(problemas, p);
    var sel = el('select', { class: 'corto' + (valor ? ' declarado' : '') + (mios.length ? ' bad' : ''), 'aria-label': label, 'data-path': p, onchange: function (e) { onChange(e.target.value); } });
    opciones.forEach(function (o) { sel.appendChild(el('option', { value: o[0], text: o[1] })); });
    sel.value = valor == null ? '' : String(valor);
    return { sel: sel, mios: mios };
  }
  // un renglón: sus celdas y, debajo, los mensajes de sus problemas
  function renglon(celdas, mios, clase) {
    var fila = el('div', { class: 'r' + (clase ? ' ' + clase : '') + (mios.length ? ' mal' : ''), role: 'row' });
    celdas.forEach(function (c) { fila.appendChild(c); });
    mios.forEach(function (x) { fila.appendChild(el('div', { class: 'err err-fila', text: x.message })); });
    return fila;
  }
  function editorAprobaciones(s, d, pr) {
    var box = el('div', { class: 'pila' }, campo(T('pantalla.quienReenviaElOk'), (d.approvals || {}).relay_session, function (v) { hoja(d, 'approvals', 'relay_session', v); }, 'approvals.relay_session', pr));
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.quienReenviaElOkAyuda') }));
    return box;
  }
  function editorPruebaAMano(s, d, pr) {
    var v = (d.qa || {}).manual_check;
    var box = el('div', { class: 'pila' }, selector(T('pantalla.pruebaAMano'), v === 'required' ? 'required' : '', [['', T('pantalla.pruebaAManoNo')], ['required', T('pantalla.pruebaAManoSi')]], function (x) { hoja(d, 'qa', 'manual_check', x); }, 'qa.manual_check', pr));
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.pruebaAManoAyuda') }));
    return box;
  }
  function editorAdo(s, d, pr) {
    var ex = s.extras || {};
    var box = el('div', { class: 'pila' }, campo(T('pantalla.laOrganizacionSuDireccionEn', { plataforma: 'Azure DevOps' }), (d.ado || {}).org, function (v) { hoja(d, 'ado', 'org', v); }, 'ado.org', pr));
    if (ex.proyecto) box.appendChild(el('p', { class: 'muted', text: T('pantalla.elProyecto') + ex.proyecto + '.' }));
    if (ex.pedidos) box.appendChild(el('p', { class: 'muted', text: T('pantalla.losPedidosDeTrabajo') + ex.pedidos + '.' }));
    return box;
  }
  function editorActualizacion(s, d, pr) {
    var u = d.update || {};
    return el('div', { class: 'pila' },
      selector(T('pantalla.queVersionTomaCadaMaquina2'), u.channel, [['', T('pantalla.sinDeclararEstable')], ['latest', T('pantalla.laUltimaCadaMaquinaToma')], ['stable', T('pantalla.estableSoloLasVersionesMarcadas')]], function (v) { hoja(d, 'update', 'channel', v); }, 'update.channel', pr),
      selector(T('pantalla.comoSeAplica'), u.apply, [['', T('pantalla.sinDeclararPreguntando')], ['auto', T('pantalla.solaLaMaquinaSeActualiza')], ['ask', T('pantalla.preguntandoLaMaquinaAvisaY')]], function (v) { hoja(d, 'update', 'apply', v); }, 'update.apply', pr));
  }
  function editorInstalacion(s, d, pr) {
    var ex = (s.extras || {}).perfiles || {};
    var box = el('div', { class: 'pila' }, selector(T('pantalla.cuantoInstalaElArnes'), (d.install || {}).profile, [['', T('pantalla.sinDeclararCompleto')], ['full', T('pantalla.completo')], ['minimal', T('pantalla.minimo')]], function (v) { hoja(d, 'install', 'profile', v); }, 'install.profile', pr));
    if (ex.motivo) box.appendChild(aviso('bad', T('pantalla.noSePudoLeerQue'), ex.motivo));
    var min = ex.minimal || []; var full = ex.full || [];
    var clave = function (f) { return f.title + '\u0000' + f.does; };
    var enMin = {}; min.forEach(function (f) { enMin[clave(f)] = true; });
    var suma = full.filter(function (f) { return !enMin[clave(f)]; });
    box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: T('pantalla.elMinimoTrae') + min.length + T('pantalla.cosas') }), porGrupo(min)));
    box.appendChild(el('div', {}, el('p', { class: 'sub-t', text: T('pantalla.elCompletoSumaEstas') + suma.length }), porGrupo(suma)));
    return box;
  }
  // los grupos de lo que instala el arnés, en el orden en que se muestran; uno que la pantalla no conoce va al final
  var GRUPOS = [['safety', T('pantalla.frenosDeSeguridad')], ['assistant', T('pantalla.comoContestaYTrabajaEl')], ['notices', T('pantalla.avisosAlArrancarYAl')], ['pipeline', T('pantalla.revisoresYPipeline')],
    ['memory', T('pantalla.memoriaEntreSesiones')], ['time', T('pantalla.registroDeTiempo')], ['install', T('pantalla.instalacionYActualizacion')], ['codex', T('pantalla.codex')]];
  /** Un texto de una pieza en el idioma de la página: el inglés de «en» si la página está en inglés y la pieza lo trae. */
  function dePieza(f, k) { return IDIOMA !== 'es' && f.en && f.en[k] ? f.en[k] : f[k]; }
  /** Si viene prendida o apagada y dónde se cambia: lo de la organización, en Configuración; lo de una máquina, se dice. */
  function dondeSeCambia(f) {
    var pestana = function (idSeccion) { var t = PESTANAS.filter(function (p) { return p[2].indexOf(idSeccion) >= 0; })[0]; return t ? t[1] + ' → ' : ''; };
    var base = f.default === 'off' ? T('pantalla.vieneApagado') : String(f.when || '').indexOf('integration:') === 0 ? T('pantalla.vieneConSuIntegracion') : T('pantalla.vienePrendido');
    if (f.site_section) return base + T('pantalla.seCambiaEnConfiguracion') + pestana(f.site_section) + (PLANO[f.site_section] ? PLANO[f.site_section].corto : f.site_section) + '.';
    var resto = f.switch ? T('pantalla.soloEnTuMaquinaCon') + dePieza(f, 'switch') + '.' : T('pantalla.esParteDelArnesNo');
    var pend = f.site_pending ? T('pantalla.pendienteQueSePuedaCambiar') + ((PESTANAS.filter(function (p) { return p[0] === f.site_pending; })[0] || [])[1] || f.site_pending) + '.' : '';
    return base + resto + pend;
  }
  function porGrupo(lista) {
    var cont = el('div', { class: 'pila' });
    var conocidos = GRUPOS.map(function (g) { return g[0]; });
    GRUPOS.concat([[null, T('pantalla.otras')]]).forEach(function (g) {
      var xs = lista.filter(function (f) { return g[0] ? f.group === g[0] : conocidos.indexOf(f.group) < 0; });
      if (!xs.length) return;
      var ul = el('ul', { class: 'efectos' });
      xs.forEach(function (f) { ul.appendChild(el('li', {}, el('details', {}, el('summary', { text: dePieza(f, 'title') }), el('p', { text: dePieza(f, 'does') }), el('p', { class: 'muted', text: dondeSeCambia(f) })))); });
      cont.appendChild(el('details', { class: 'grupo' }, el('summary', { text: g[1] + ' (' + xs.length + ')' }), ul));
    });
    if (!lista.length) cont.appendChild(el('p', { class: 'muted', text: T('pantalla.nada') }));
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
      campo(T('pantalla.elNombreDeLaOrganizacion'), b.name, function (v) { poner('name', String(v).trim()); }, 'site.brand.name', pr, { placeholder: T('pantalla.comoQueresQueSeLea') }),
      campo(T('pantalla.elLogoSuRutaEn'), b.logo, function (v) { poner('logo', String(v).trim()); }, 'site.brand.logo', pr, { placeholder: T('pantalla.marcaLogoPng') }),
      selector(T('pantalla.enElTemaOscuro'), b.dark, [['', T('pantalla.sinDeclararInvertirlo')], ['invert', T('pantalla.invertirloParaUnLogoOscuro')], ['keep', T('pantalla.dejarloComoEstaParaUn')]], function (v) { poner('dark', v); }, 'site.brand.dark', pr));
    box.appendChild(el('p', { class: 'muted', text: T('pantalla.elArchivoDelLogoEntra') }));
    if (b.logo) box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.asiSeVeHoy') }), el('img', { class: 'logo logo-previa' + (b.dark === 'keep' ? '' : ' invierte'), src: '/marca/logo', alt: b.name || T('pantalla.elLogoDeLaOrganizacion') })));
    return box;
  }
  function editorHilos(s, d, pr) {
    var mb = (d.site || {}).mailbox || {};
    return el('div', { class: 'pila' }, selector(T('pantalla.bajarLasConversaciones'), mb.threads === undefined ? '' : String(mb.threads), [['', T('pantalla.sinDeclararNo')], ['true', T('pantalla.siBajaTambienLoQue')], ['false', T('pantalla.noSoloLosNumerosDe')]], function (v) {
      if (!esObjeto(d.site)) d.site = {};
      if (v === '') { if (esObjeto(d.site.mailbox)) delete d.site.mailbox.threads; return; }
      if (!esObjeto(d.site.mailbox)) d.site.mailbox = {};
      d.site.mailbox.threads = v === 'true';
    }, 'site.mailbox.threads', pr));
  }
  function editorAplicar(s, d, pr) {
    var st = d.site || {};
    return el('div', { class: 'pila' }, selector(T('pantalla.losCambiosDeQuienMantiene'), st.auto_apply === undefined ? '' : String(st.auto_apply), [['', T('pantalla.sinDeclararNo')], ['true', T('pantalla.siSeAplicanSolosEl')], ['false', T('pantalla.noQuedaElPedidoPara')]], function (v) {
      if (!esObjeto(d.site)) d.site = {};
      if (v === '') { delete d.site.auto_apply; return; }
      d.site.auto_apply = v === 'true';
    }, 'site.auto_apply', pr), el('p', { class: 'muted', text: T('pantalla.quedaEscritoQuienPidioCada') }));
  }
  // una casilla por ficha; tildada = se muestra. Lo destildado es site.hidden_cards, en el orden de la lista.
  function editorFichas(s, d, pr) {
    var ex = s.extras || {};
    var todas = Array.isArray(ex.fichas) ? ex.fichas : [];
    var ocultas = ((d.site || {}).hidden_cards || []).slice();
    var box = el('div', { class: 'pila' });
    if (!todas.length) { box.appendChild(el('p', { class: 'muted', text: T('pantalla.sinListaDeFichas') })); return box; }
    var grupos = [['arnes', T('pantalla.enArnes')], ['proyectos', T('pantalla.enProyectos')], ['corridas', T('pantalla.enCorridas')]];
    grupos.forEach(function (g) {
      var fs = todas.filter(function (f) { return f.pestana === g[0]; });
      if (!fs.length) return;
      box.appendChild(el('p', { class: 'sub-t', text: g[1] }));
      fs.forEach(function (f) {
        var c = el('input', { type: 'checkbox', 'aria-label': f.titulo, 'data-path': 'site.hidden_cards.' + f.id, onchange: function (e) {
          var ya = ((d.site || {}).hidden_cards || []).filter(function (x) { return x !== f.id; });
          if (!e.target.checked) ya.push(f.id);
          var orden = todas.map(function (x) { return x.id; });
          ya = ya.filter(function (x) { return orden.indexOf(x) >= 0; }).sort(function (a, b) { return orden.indexOf(a) - orden.indexOf(b); }).concat(ya.filter(function (x) { return orden.indexOf(x) < 0; }));
          if (!esObjeto(d.site)) d.site = {};
          if (ya.length) d.site.hidden_cards = ya; else { delete d.site.hidden_cards; if (!Object.keys(d.site).length) delete d.site; }
        } });
        c.checked = ocultas.indexOf(f.id) < 0;
        box.appendChild(el('label', {}, c, el('span', { text: ' ' + f.titulo }), el('span', { class: 'muted', text: ' — ' + f.paraQue })));
      });
    });
    var raras = ocultas.filter(function (id) { return !todas.some(function (f) { return f.id === id; }); });
    if (raras.length) box.appendChild(el('p', { class: 'muted', text: T('pantalla.fichasOcultasDesconocidas', { ids: raras.join(', ') }) }));
    return box;
  }

  function editorActualizacionSitio(s, d, pr) {
    var st = d.site || {};
    return el('div', { class: 'pila' }, selector(T('pantalla.comoSeActualizaElSitio'), st.update === undefined ? '' : String(st.update), [['', T('pantalla.sinDeclararSoloAviso')], ['auto', T('pantalla.automaticoElNocturnoInstalaLa')], ['notice', T('pantalla.soloAvisoElSitioDice')]], function (v) {
      if (!esObjeto(d.site)) d.site = {};
      if (v === '') { delete d.site.update; return; }
      d.site.update = v;
    }, 'site.update', pr), el('p', { class: 'muted', text: T('pantalla.elAutomaticoPideElNocturno') }));
  }
  // lo que trae la organización en el repo del equipo (AC 17): se mira y se abre en el repo, no se edita acá
  function tablaDeContenido(filas) {
    var sec = el('section', { class: 'card form-block', id: 'contenido' }, el('div', { class: 'fb-head' }, el('div', {}, el('h4', { text: T('pantalla.loQueTraeLaOrganizacion') }), el('p', { class: 'reach', text: T('pantalla.skillsRevisoresGuiasDeAlta') }))));
    if (!filas || !filas.length) { sec.appendChild(el('p', { class: 'muted', text: filas ? T('pantalla.nadaQueMostrar') : T('pantalla.elRepoDelEquipoTodavia') })); return sec; }
    var tabla = el('table', { class: 'tabla' }); var thead = el('thead', {}); var tr = el('tr', {});
    [T('pantalla.queEs'), T('pantalla.dondeEsta')].forEach(function (t) { tr.appendChild(el('th', { text: t })); }); thead.appendChild(tr); tabla.appendChild(thead);
    var tbody = el('tbody', {});
    filas.forEach(function (f) { var ruta = f.enlace ? el('a', { href: f.enlace, text: f.ruta }) : el('span', { text: f.ruta }); tbody.appendChild(el('tr', {}, el('td', { text: f.tipo }), el('td', {}, ruta))); });
    tabla.appendChild(tbody); sec.appendChild(el('div', { class: 'tbl-wrap' }, tabla));
    return sec;
  }
  // ── los nombres en lugar de los números: los pipelines de un proyecto y los nombres de los pasos, pedidos una vez ──
  var PIPES = {}; var PASOS = {};
  // los tipos de pedido y los campos de cada tipo, pedidos una vez por página: { estado: 'cargando' | 'listo', r }
  var TIPOS_PEDIDO = null; var CAMPOS_PEDIDO = {}; var OPCIONES_N = 0;
  function tiposDePedidoLeidos() {
    if (!TIPOS_PEDIDO) { TIPOS_PEDIDO = { estado: 'cargando' }; api('/tipos-de-pedido', {}).then(function (r) { TIPOS_PEDIDO = { estado: 'listo', r: r }; render(); }); }
    return TIPOS_PEDIDO;
  }
  function camposDeTipoLeidos(tipo) {
    if (!CAMPOS_PEDIDO[tipo]) { CAMPOS_PEDIDO[tipo] = { estado: 'cargando' }; api('/campos-de-pedido', { tipo: tipo }).then(function (r) { CAMPOS_PEDIDO[tipo] = { estado: 'listo', r: r }; render(); }); }
    return CAMPOS_PEDIDO[tipo];
  }
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
    if (r.platform !== 'azure') return campo(T('pantalla.controlObligatorioDeLasPruebas'), e.full_tests_pipeline, escribir, p, pr, { placeholder: T('pantalla.elNombreDelControlEn') });
    var L = pipelinesDe(r.org, r.project);
    var lista = listaDePipelines(L);
    var actual = e.full_tests_pipeline;
    if (lista) {
      var porNombre = lista.filter(function (x) { return x.nombre === actual; })[0];
      var valor = actual == null ? '' : porNombre ? String(porNombre.id) : String(actual);
      var opciones = [['', T('pantalla.ninguno')]].concat(lista.map(function (x) { return [String(x.id), x.nombre + (x.carpeta ? ' · ' + x.carpeta : '')]; }));
      if (valor && !lista.some(function (x) { return String(x.id) === valor; })) opciones.push([valor, (typeof actual === 'number' ? T('pantalla.elPipeline') + actual : actual) + T('pantalla.noEstaEnElProyecto')]);
      return selector(T('pantalla.pipelineDePruebasCompletas'), valor, opciones, function (v) { if (!v) delete e.full_tests_pipeline; else e.full_tests_pipeline = /^\d+$/.test(v) ? Number(v) : v; }, p, pr);
    }
    var box = campo(T('pantalla.pipelineDePruebasCompletasSu'), actual, escribir, p, pr, { placeholder: T('pantalla.numeroDelPipeline'), inputmode: 'numeric' });
    if (!L) box.appendChild(el('p', { class: 'muted', text: T('pantalla.completaLaOrganizacionYEl') }));
    else if (L.estado === 'cargando') box.appendChild(el('p', { class: 'muted', text: T('pantalla.buscandoLosPipelinesDelProyecto') }));
    else box.appendChild(el('div', { class: 'aviso', text: (L.r && L.r.message) || T('pantalla.noSePudoTraerLa') }));
    return box;
  }
  var REGLAS = [['automatico', T('pantalla.automaticoElServidorSiLa')], ['siempre-en-la-maquina', T('pantalla.siempreEnLaMaquina')], ['confiar-en-el-servidor', T('pantalla.confiarEnElServidor')]];
  var REGLAS_CORTAS = [['automatico', T('pantalla.automatico2')], ['siempre-en-la-maquina', T('pantalla.siempreEnLaMaquina')], ['confiar-en-el-servidor', T('pantalla.confiarEnElServidor')]];
  // los repos abiertos con ✎, por su lugar en la lista; sacar uno los cierra a todos (los lugares se corren)
  var ABIERTOS = {};
  // las pruebas completas de un repo: su pipeline; sin pipeline, qué pasa con la regla que le toca (la suya; si no, la
  // de la organización; si no, automático), con la respuesta del lector que el servidor manda en «sinPipeline»
  function pruebasDe(e, r, ms, sp) {
    var pl = e.full_tests_pipeline;
    var regla = e.rule != null ? e.rule : ms.default != null ? ms.default : 'automatico';
    if (pl != null && pl !== '') {
      var lista = typeof pl === 'number' ? listaDePipelines(pipelinesDe(r.org, r.project)) : null;
      var nombre = lista && lista.filter(function (x) { return String(x.id) === String(pl); })[0];
      // con «siempre en la máquina» el merge no mira el pipeline: se muestra atenuado y con su nota
      return { declarado: true, noUsado: regla === 'siempre-en-la-maquina', texto: nombre ? nombre.nombre : typeof pl === 'number' ? T('pantalla.elPipeline') + pl : String(pl) };
    }
    var que = sp && sp[regla];
    return { declarado: false, texto: que === 'machine' ? T('pantalla.correnEnLaMaquinaDelDev') : que === 'server-if-any-check' ? T('pantalla.elServidorSiLaRama') : T('pantalla.sinPipeline') };
  }
  // story 2.59.2: qué hace la regla elegida, con la respuesta del lector que el servidor manda en «queHace» (como la nota
  // «sin pipeline»). La organización sin declarar es automático. Un repo sin regla propia dice qué hace la de la
  // organización (story 2.61.3): «como la organización: …», con la regla de arriba de ese momento. Sin esa respuesta (un
  // lector anterior), o con un valor que la pantalla no conoce, ninguna línea
  var QUE_HACE = { 'server-if-required': 'pantalla.queHaceAutomatico', 'machine-always': 'pantalla.queHaceSiempre', 'server-only': 'pantalla.queHaceConfiar' };
  function textoQueHace(regla, qh) {
    var k = QUE_HACE[qh[regla == null || regla === '' ? 'automatico' : regla]];
    return k ? T(k) : null;
  }
  function queHace(regla, qh, deRepo, deLaOrg) {
    if (!qh) return null;
    var vacia = regla == null || regla === '';
    var texto = vacia && deRepo ? textoQueHace(deLaOrg, qh) : textoQueHace(regla, qh);
    if (!texto) return null;
    return el('span', { class: 'que-hace', text: vacia && deRepo ? T('pantalla.comoLaOrganizacion', { queHace: texto }) : texto });
  }
  function editorSuites(s, d, pr) {
    MOSTRADOS = [];
    var box = el('div', { class: 'pila' });
    // con otra forma (no es un objeto, repos no es una lista, una entrada no es un objeto) se edita sólo como texto
    if ('merge_suites' in d && (!esObjeto(d.merge_suites) || (d.merge_suites.repos !== undefined && (!Array.isArray(d.merge_suites.repos) || d.merge_suites.repos.some(function (e) { return !esObjeto(e); }))))) {
      box.appendChild(el('p', { class: 'muted', text: T('pantalla.estaParteDelArchivoNo') }));
      box.appendChild(restoYTexto(s, d, pr, 'merge_suites', T('pantalla.lasSuitesAlMergearComo')));
      return box;
    }
    d.merge_suites = d.merge_suites || {};
    var ms = d.merge_suites;
    var qh = s.extras && s.extras.queHace;
    var deOrg = selector(T('pantalla.laReglaDeLaOrganizacion'), ms.default, [['', T('pantalla.sinDeclararAutomatico')]].concat(REGLAS), function (v) { if (v) ms.default = v; else delete ms.default; render(); }, 'merge_suites.default', pr);
    var lineaOrg = queHace(ms.default, qh, false);
    if (lineaOrg) deOrg.appendChild(lineaOrg);
    box.appendChild(deOrg);
    var sub = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.porRepo') }), el('p', { class: 'sub-d', text: T('pantalla.cadaRepoUsaLaRegla') }));
    ms.repos = ms.repos || [];
    if (!ms.repos.length) sub.appendChild(el('p', { class: 'muted', text: T('pantalla.ningunRepoTodavia') }));
    // story 2.59: un renglón por repo (dónde, el repo entero, la regla, las pruebas completas, ✎ y ✕); ✎ abre los campos
    // debajo. Se abre solo un repo con un problema en su ruta o sin organización o nombre (el recién agregado)
    var t = tabla('repos', T('pantalla.porRepo'), [T('pantalla.donde'), T('pantalla.repo2'), T('pantalla.regla2'), T('pantalla.pruebasCompletas'), '']);
    var sp = s.extras && s.extras.sinPipeline;
    ms.repos.forEach(function (e, i) {
      var at = 'merge_suites.repos.' + i;
      var r = esObjeto(e.repo) ? e.repo : {};
      var gh = r.platform === 'github';
      var texto = [r.org, gh ? null : r.project, r.repo].filter(function (x) { return x != null && x !== ''; }).join(' / ');
      var suyos = (pr || []).filter(function (x) { return x.path === at || String(x.path).indexOf(at + '.') === 0; });
      var abierto = ABIERTOS[i] === true || suyos.length > 0 || !r.org || !r.repo;
      var regla = corto(T('pantalla.regla2') + ' · ' + texto, e.rule, [['', T('pantalla.laDeLaOrganizacion')]].concat(REGLAS_CORTAS), function (v) { if (v) e.rule = v; else delete e.rule; render(); }, at + '.rule', pr);
      var pc = pruebasDe(e, r, ms, sp);
      var editar = el('button', { class: 'editar', type: 'button', text: '✎', title: T('pantalla.editarElRepo'), 'aria-label': T('pantalla.editarElRepo') + ' ' + texto, 'aria-expanded': abierto ? 'true' : 'false', onclick: function () { ABIERTOS[i] = !abierto; render(); } });
      var sacar = el('button', { class: 'quitar-fila', type: 'button', text: '✕', title: T('pantalla.quitarElRepo'), 'aria-label': T('pantalla.quitarElRepo') + ' ' + texto, onclick: function () { ms.repos.splice(i, 1); ABIERTOS = {}; render(); } });
      var celdas = [el('div', { class: 'donde', role: 'cell' }, el('span', { class: 'ic', role: 'img', title: gh ? 'GitHub' : 'Azure DevOps', 'aria-label': gh ? 'GitHub' : 'Azure DevOps', text: gh ? 'GH' : 'Az' })),
        el('div', { class: 'repo-t', role: 'cell', title: texto, text: texto }), el('div', { class: 'regla', role: 'cell' }, regla.sel, queHace(e.rule, qh, true, ms.default)),
        pc.noUsado
          ? el('div', { class: 'pc', role: 'cell', title: pc.texto + ' · ' + T('pantalla.noSeUsaConEstaRegla') }, el('span', { class: 'ignorado', text: pc.texto }), el('span', { class: 'nota', text: T('pantalla.noSeUsaConEstaRegla') }))
          : el('div', { class: 'pc' + (pc.declarado ? '' : ' vacio'), role: 'cell', title: pc.texto, text: pc.texto }), el('div', { class: 'acc', role: 'cell' }, editar, sacar)];
      // los campos se arman antes que los mensajes del renglón: los que se dibujan junto a su campo no se repiten abajo
      if (abierto) celdas.push(el('div', { class: 'edit' }, repoFila(T('pantalla.repo3') + (i + 1), '', e.repo, function (v) { e.repo = v; }, at + '.repo', pr),
        campoPipeline(e, at + '.full_tests_pipeline', pr), el('div', { class: 'listo' }, el('button', { class: 'sec', type: 'button', text: T('pantalla.listo'), onclick: function () { ABIERTOS[i] = false; render(); } }))));
      var resto = suyos.filter(function (x) { return MOSTRADOS.indexOf(x) < 0 || regla.mios.indexOf(x) >= 0; });
      MOSTRADOS = MOSTRADOS.concat(resto);
      t.appendChild(renglon(celdas, resto.map(function (x) { return { message: (x.donde && regla.mios.indexOf(x) < 0 ? x.donde + ': ' : '') + x.message }; }), abierto ? 'abierto' : ''));
    });
    sub.appendChild(t);
    sub.appendChild(el('button', { class: 'mas', type: 'button', text: T('pantalla.agregarRepo'), onclick: function () { ms.repos.push({ repo: { platform: 'azure', org: '', project: '', repo: '' }, rule: 'automatico' }); ABIERTOS[ms.repos.length - 1] = true; render(); } }));
    box.appendChild(sub);
    problemasEn(pr, 'merge_suites.repos').forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    box.appendChild(restoYTexto(s, d, pr, 'merge_suites', T('pantalla.lasSuitesAlMergearComo')));
    return box;
  }
  // la pantalla habla en niveles (copia de LEVELS de models.js, en el orden de MODELOS: cada nivel es el modelo
  // de su posición). Lo guardado con un nombre se muestra y se propone como su nivel
  var MODELOS = ['haiku', 'sonnet', 'opus', 'fable'];
  var NIVELES = ['economy', 'balanced', 'strong', 'max'];
  function nivelDe(v) { var i = MODELOS.indexOf(v); return i >= 0 ? NIVELES[i] : v; }
  function modeloDe(v) { var i = NIVELES.indexOf(v); return i >= 0 ? MODELOS[i] : (MODELOS.indexOf(v) >= 0 ? v : null); }
  function nombreNivel(v) { return NIVELES.indexOf(nivelDe(v)) >= 0 ? T('pantalla.nivel.' + nivelDe(v)) : v; }
  function enNiveles(v) {
    if (typeof v === 'string') return nivelDe(v);
    if (!esObjeto(v)) return v;
    Object.keys(v).forEach(function (k) { if (k !== 'fable_question' && k.charAt(0) !== '_') v[k] = enNiveles(v[k]); });
    return v;
  }
  // el nombre llano de cada revisor, por su identificador sin el prefijo de quien lo publica; uno que no está acá se
  // muestra con su identificador
  var REVISOR = {
    'ac-coverage-checker': T('pantalla.queCadaCriterioDeLa'), 'deferral-tracker': T('pantalla.loQueLaStoryDejo'),
    'dod-runtime-checker': T('pantalla.queSeProboAndandoNo'), 'e2e-realness-checker': T('pantalla.queLasPruebasDePunta'),
    'plugin-security-basics': T('pantalla.seguridadBasicaDelCambio'), 'plugin-tests-coverage': T('pantalla.queLasPruebasCubranLo'),
    'retrospective-capturer': T('pantalla.loAprendidoDespuesDeCada'), 'signed-scope-audit': T('pantalla.elPlanContraLoFirmado'),
    'silent-failure-hunter': T('pantalla.fallasQuePasanEnSilencio'), 'spec-first-checker': T('pantalla.queNoSeHagaMas'),
    'story-validator': T('pantalla.queLaStoryEsteCompleta'), 'llm-cost-reviewer': T('pantalla.costoDelUsoDeModelos'),
    'i18n-hardcoded-text-reviewer': T('pantalla.textosEscritosFijosDondeVa'),
    'plugin-dotnet-conventions': T('pantalla.convencionesDeLosBackendsNet'), 'plugin-react-conventions': T('pantalla.convencionesDeLosFormulariosReact'),
    'plugin-nextjs-conventions': T('pantalla.convencionesDeNextJs'), 'sibling-pattern-reviewer': T('pantalla.queSigaLoQueYa'),
    'feature-wiring-checker': T('pantalla.queLoHechoEsteConectado'),
  };
  function nombreRevisor(id) { var n = REVISOR[id] || REVISOR[String(id).slice(String(id).indexOf('-') + 1)]; return n ? n + ' (' + id + ')' : id; }
  // story 2.59: tres tablas (revisores; pase adversarial; ayudantes y sesión), un renglón por trabajo: el trabajo, su
  // valor por defecto y un selector corto. Los revisores en particular son renglones de la tabla de revisores; el tope,
  // un renglón al pie. Un trabajo por encima del tope llega como problema de su ruta y su renglón se ve en rojo
  function editorModelos(s, d, pr) {
    MOSTRADOS = [];
    var hoy = (s.extras && s.extras.hoy) || null;
    var box = el('div', { class: 'pila' });
    if ('models' in d && !esObjeto(d.models)) {
      box.appendChild(el('p', { class: 'muted', text: T('pantalla.estaParteDelArchivoNo') }));
      box.appendChild(restoYTexto(s, d, pr, 'models', T('pantalla.losModelosComoTexto')));
      return box;
    }
    d.models = enNiveles(d.models || {});
    var m = d.models;
    var equiv = (s.extras && s.extras.equivalencias) || null;
    // la línea chica debajo de un selector: a qué modelo equivale el nivel en cada herramienta (sin nivel, ninguna)
    var motivoEquiv = (s.extras && s.extras.motivoEquivalencias) || null;
    function lineaEquiv(v) {
      var mod = modeloDe(v);
      if (!mod) return '';
      var codex = equiv && Object.prototype.hasOwnProperty.call(equiv, mod) && equiv[mod] ? equiv[mod] : (motivoEquiv || T('pantalla.sinEquivalenciaCodex'));
      return T('pantalla.equivalenciaDelNivel', { claude: mod, codex: codex });
    }
    if (!hoy) box.appendChild(el('p', { class: 'muted', text: T('pantalla.noSeLosModelosDe') + ((s.extras && s.extras.motivoHoy) || T('pantalla.sinMotivo')) + T('pantalla.sinDeclararUsaLosDe') }));
    var DE_MODELOS = [['', T('pantalla.elPorDefecto')]].concat(NIVELES.map(function (x) { return [x, T('pantalla.nivel.' + x)]; }));
    function de(obj, k) { return obj && typeof obj === 'object' ? obj[k] : undefined; }
    function cabeza(titulo) { box.appendChild(el('p', { class: 'sub-t', text: titulo })); return tabla('modelos', titulo, [T('pantalla.trabajo'), T('pantalla.porDefecto2'), T('pantalla.tuOrganizacionUsa')]); }
    // pone o saca una hoja de models («sub»: dentro de un objeto, que sale si queda vacío)
    function poner(k, sub, v) {
      if (!sub) { if (v) m[k] = v; else delete m[k]; return; }
      m[k] = esObjeto(m[k]) ? m[k] : {};
      if (v) m[k][sub] = v; else { delete m[k][sub]; if (!Object.keys(m[k]).length) delete m[k]; }
    }
    // un renglón de modelo: «que» es el contenido de la primera celda; «quitarlo», la ✕ de un revisor en particular
    // «h» es el valor por defecto como viene (un modelo); con «conEquiv», el renglón lleva la línea de equivalencias
    function fila(t, que, label, k, sub, opciones, h, quitarlo, conEquiv) {
      var p = 'models.' + k + (sub ? '.' + sub : '');
      var linea = conEquiv ? el('small', { class: 'equiv muted' }) : null;
      var pintar = function (v) { if (linea) linea.textContent = lineaEquiv(v || h); };
      var c = corto(label, sub ? de(m[k], sub) : m[k], opciones, function (v) { poner(k, sub, v); pintar(v); }, p, pr);
      pintar(sub ? de(m[k], sub) : m[k]);
      var acc = el('div', { class: 'acc', role: 'cell' }, c.sel);
      if (linea) acc.appendChild(linea);
      if (quitarlo) acc.appendChild(el('button', { class: 'quitar-fila', type: 'button', text: '✕', title: T('pantalla.quitarEsteRevisor'), 'aria-label': T('pantalla.quitarEsteRevisor') + ': ' + label, onclick: quitarlo }));
      var celda = el('div', { class: 'que', role: 'cell' });
      [].concat(que).forEach(function (n) { celda.appendChild(n); });
      t.appendChild(renglon([celda, el('div', { class: 'hoy', role: 'cell', text: h == null ? '—' : (conEquiv ? nombreNivel(h) : h) }), acc], c.mios));
    }
    function trabajo(t, label, k, sub) { fila(t, el('span', { text: label }), label, k, sub, DE_MODELOS, sub ? de(de(hoy, k), sub) : de(hoy, k), null, true); }

    var rev = cabeza(T('pantalla.losRevisores'));
    trabajo(rev, T('pantalla.primeraVuelta'), 'reviewers');
    trabajo(rev, T('pantalla.lasVueltasSiguientes'), 'reviewers_reloop');
    // los revisores en particular: los declarados (con su ✕) y los que tienen un valor por defecto propio
    var rv = esObjeto(m.reviewer) ? m.reviewer : null;
    var conHoy = Object.keys(de(hoy, 'reviewer') || {});
    if (m.reviewer !== undefined && !rv) box.appendChild(rev);
    else {
      Object.keys(rv || {}).concat(conHoy.filter(function (id) { return !rv || !(id in rv); })).forEach(function (id) {
        var nombre = nombreRevisor(id);
        var declarado = !!rv && (id in rv);
        fila(rev, [el('span', { text: nombre }), el('small', { text: ' · ' + T('pantalla.unRevisorEnParticular2') })], nombre, 'reviewer', id, DE_MODELOS, de(de(hoy, 'reviewer'), id),
          declarado ? function () { delete m.reviewer[id]; if (!Object.keys(m.reviewer).length) delete m.reviewer; render(); } : null, true);
      });
      box.appendChild(rev);
      var conocidos = ((s.extras && s.extras.revisores) || []).filter(function (id) { return (!rv || !(id in rv)) && conHoy.indexOf(id) < 0; });
      if (conocidos.length) {
        var elegir = el('select', { class: 'corto', 'aria-label': T('pantalla.revisor2') }, el('option', { value: '', text: T('pantalla.elegiUnRevisor') }));
        conocidos.forEach(function (id) { elegir.appendChild(el('option', { value: id, text: nombreRevisor(id) })); });
        box.appendChild(el('div', { class: 'agregar-revisor' }, elegir, el('button', { class: 'mas', type: 'button', text: T('pantalla.agregarUnRevisorEnParticular'), onclick: function () { if (!elegir.value) return; m.reviewer = rv || {}; m.reviewer[elegir.value] = 'balanced'; render(); } })));
      }
    }
    if (m.reviewer !== undefined && !rv) box.appendChild(editorGenerico(s, m, pr, 'reviewer', T('pantalla.revisorYModeloComoTexto')));
    problemasEn(pr, 'models.reviewer').forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });

    var adv = cabeza(T('pantalla.elPaseAdversarial'));
    trabajo(adv, T('pantalla.unaStoryNormal'), 'adversarial', 'model');
    trabajo(adv, T('pantalla.unaStoryPesada'), 'adversarial', 'heavy');
    var fq = de(de(hoy, 'adversarial'), 'fable_question');
    fila(adv, el('span', { text: T('pantalla.preguntarAntesDeUsarFable') }), T('pantalla.preguntarAntesDeUsarFable'), 'adversarial', 'fable_question',
      [['', T('pantalla.elPorDefecto')], ['ask', T('pantalla.preguntar')], ['never', T('pantalla.nunca')]], fq ? (fq === 'ask' ? T('pantalla.preguntar') : T('pantalla.nunca')) : null);
    box.appendChild(adv);

    var ayu = cabeza(T('pantalla.losAyudantesYLaSesion'));
    trabajo(ayu, T('pantalla.losAyudantes'), 'helpers');
    trabajo(ayu, T('pantalla.sesionStoryLiviana'), 'session', 'low');
    trabajo(ayu, T('pantalla.sesionStoryNormal'), 'session', 'normal');
    trabajo(ayu, T('pantalla.sesionStoryPesada'), 'session', 'heavy');
    box.appendChild(ayu);

    // el tope obligatorio, un renglón al pie: la casilla, «ningún trabajo pasa de» y el modelo
    var techo = el('input', { type: 'checkbox', 'aria-label': T('pantalla.topeObligatorio'), 'data-path': 'models.mandatory_ceiling', onchange: function (e) { if (e.target.checked) m.mandatory_ceiling = true; else { delete m.mandatory_ceiling; delete m.ceiling; } render(); } });
    techo.checked = m.mandatory_ceiling === true;
    var lineaTope = el('small', { class: 'equiv muted', text: lineaEquiv(m.ceiling) });
    var c = corto(T('pantalla.topeObligatorio'), m.ceiling, [['', T('pantalla.elegiUno')]].concat(NIVELES.map(function (x) { return [x, T('pantalla.nivel.' + x)]; })), function (v) { if (v) m.ceiling = v; else delete m.ceiling; lineaTope.textContent = lineaEquiv(v); }, 'models.ceiling', pr);
    if (m.mandatory_ceiling !== true) c.sel.setAttribute('disabled', 'disabled');
    var tope = el('div', { class: 'tope' }, el('label', {}, techo, el('b', { text: ' ' + T('pantalla.topeObligatorio') + ':' })), el('span', { text: T('pantalla.ningunTrabajoPasaDe2') }), c.sel,
      lineaTope, el('span', { class: 'muted', text: T('pantalla.loPagaLaOrganizacionNingun') }));
    c.mios.concat(problemasEn(pr, 'models.mandatory_ceiling')).forEach(function (x) { tope.appendChild(el('div', { class: 'err', text: x.message })); });
    box.appendChild(tope);
    box.appendChild(restoYTexto(s, d, pr, 'models', T('pantalla.losModelosComoTexto')));
    return box;
  }
  // el plazo del aviso de espera (story 7.20): minutos enteros de 1 a 120; vacío, el de siempre (5)
  function editorEspera(s, d, pr) {
    var w = esObjeto(d.wait_notice) ? d.wait_notice : {};
    return el('div', { class: 'pila' }, campo(T('pantalla.minutosQueEsperaUnaCorrida'), w.minutes, function (v) {
      if (v === '') { if (esObjeto(d.wait_notice)) { delete d.wait_notice.minutes; if (!Object.keys(d.wait_notice).length) delete d.wait_notice; } return; }
      if (!esObjeto(d.wait_notice)) d.wait_notice = {};
      d.wait_notice.minutes = numOTexto(v);
    }, 'wait_notice.minutes', pr, { inputmode: 'numeric' }));
  }
  // los pedidos de vulnerabilidades: el tipo, los campos fijos y una fila por gravedad, cada campo con su
  // nombre (la referencia, como «Microsoft.VSTS.Common.Priority») y su valor. Todo lo escrito lo valida el lector al
  // revisar; los comentarios «__…» del archivo se conservan y no se muestran
  var GRAVEDADES = [['critical', T('pantalla.gravedadCritica')], ['high', T('pantalla.gravedadAlta')], ['moderate', T('pantalla.gravedadMedia')], ['low', T('pantalla.gravedadBaja')]];
  // la lista que leyó el sitio, si la hay: los nombres de los campos del tipo y los valores permitidos de cada uno se
  // ofrecen para elegir; escribir otra cosa sigue valiendo (lo valida el lector)
  function opciones(id, valores) { var d = el('datalist', { id: id }); (valores || []).forEach(function (v) { d.appendChild(el('option', { value: v })); }); return d; }
  function camposDePedido(titulo, ayuda, mapa, set, p, pr, catalogo) {
    var m = esObjeto(mapa) ? mapa : {};
    var porRef = {}; (catalogo || []).forEach(function (c) { porRef[c.referencia] = c; });
    var box = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: titulo }), ayuda ? el('p', { class: 'sub-d', text: ayuda }) : null);
    var nombres = Object.keys(m).filter(function (k) { return k.indexOf('__') !== 0; });
    if (!nombres.length) box.appendChild(el('p', { class: 'muted', text: T('pantalla.pedidosSinCampos') }));
    // renombrar un campo arma el mapa de nuevo, en el mismo orden: el nombre vigente vive en ref
    // un nombre que ya tiene otro campo de la lista no se aplica (pisaría su valor): se dice junto al campo
    var reArmar = function (viejo, nuevo, valor) { if (nuevo !== viejo && Object.prototype.hasOwnProperty.call(m, nuevo)) return false; var out = {}; Object.keys(m).forEach(function (k) { if (k === viejo) out[nuevo] = valor; else out[k] = m[k]; }); m = out; set(m); return true; };
    nombres.forEach(function (k) {
      var ref = { k: k };
      var aviso = el('div', { class: 'err', 'data-path': p + '.' + k + '.repetido' });
      var idValores = 'pedidos-valores-' + (++OPCIONES_N);   // único en la página: un nombre de campo no lo arma
      var valores = porRef[k] && porRef[k].valores.length ? porRef[k].valores : null;
      if (valores) box.appendChild(opciones(idValores, valores));
      box.appendChild(el('div', { class: 'fila quitar' },
        campo(T('pantalla.pedidosCampo'), k, function (v) { var ok = reArmar(ref.k, v, m[ref.k]); if (ok) ref.k = v; aviso.textContent = ok ? '' : T('pantalla.pedidosCampoRepetido'); }, p + '.' + k, pr, { placeholder: 'Microsoft.VSTS.Common.Priority', list: catalogo ? 'pedidos-campos' : null }),
        campo(T('pantalla.pedidosValor'), m[k], function (v) { m[ref.k] = numOTexto(v); set(m); }, p + '.' + k + '.valor', pr, { list: valores ? idValores : null }),
        quitar(function () { delete m[ref.k]; set(m); render(); })));
      box.appendChild(aviso);
    });
    box.appendChild(el('button', { class: 'mas', type: 'button', text: '+ ' + T('pantalla.pedidosAgregarCampo'), onclick: function () { var n = ''; while (Object.prototype.hasOwnProperty.call(m, n)) n += ' '; m[n] = ''; set(m); render(); } }));
    problemasEn(pr, p).forEach(function (x) { box.appendChild(el('div', { class: 'err', text: x.message })); });
    return box;
  }
  function editorPedidos(s, d, pr) {
    var w = function () { if (!esObjeto(d.work_items)) d.work_items = {}; return d.work_items; };
    // una parte que queda vacía se saca: no se propone un «{}»
    var limpiar = function () { var x = d.work_items; if (!esObjeto(x)) return; ['fixed_fields', 'by_severity'].forEach(function (k) { if (esObjeto(x[k]) && !Object.keys(x[k]).length) delete x[k]; }); if (!Object.keys(x).length) delete d.work_items; };
    var actual = esObjeto(d.work_items) ? d.work_items : {};
    var box = el('div', { class: 'pila' });
    var L = tiposDePedidoLeidos();
    var tipos = L.estado === 'listo' && L.r && L.r.ok && Array.isArray(L.r.tipos) ? L.r.tipos : null;
    if (tipos) box.appendChild(opciones('pedidos-tipos', tipos));
    box.appendChild(campo(T('pantalla.pedidosTipo'), actual.type, function (v) { if (v === '') { if (esObjeto(d.work_items)) delete d.work_items.type; } else w().type = v; limpiar(); }, 'work_items.type', pr, { placeholder: T('pantalla.pedidosTipoEjemplo'), list: tipos ? 'pedidos-tipos' : null, onchange: function () { render(); } }));
    box.appendChild(el('p', { class: 'sub-d', text: T('pantalla.pedidosTipoAyuda') }));
    // sin la lista se escribe a mano, como siempre; la pantalla dice por qué no hay lista
    if (L.estado === 'listo' && !tipos) box.appendChild(el('p', { class: 'muted', 'data-path': 'work_items.lista', text: T('pantalla.pedidosSinLista', { motivo: (L.r && L.r.message) || T('pantalla.pedidosSinRespuesta') }) }));
    if (tipos && L.r.sinLeer && L.r.sinLeer.length) box.appendChild(el('p', { class: 'muted', 'data-path': 'work_items.lista', text: T('pantalla.pedidosListaParcial', { proyectos: L.r.sinLeer.map(function (x) { return x.proyecto; }).join(', ') }) }));
    var C = tipos && typeof actual.type === 'string' && tipos.indexOf(actual.type) >= 0 ? camposDeTipoLeidos(actual.type) : null;
    var catalogo = C && C.estado === 'listo' && C.r && C.r.ok && Array.isArray(C.r.campos) ? C.r.campos : null;
    if (catalogo) box.appendChild(opciones('pedidos-campos', catalogo.map(function (c) { return c.referencia; })));
    if (C && C.estado === 'listo' && !catalogo) box.appendChild(el('p', { class: 'muted', 'data-path': 'work_items.campos', text: T('pantalla.pedidosSinCamposLeidos', { motivo: (C.r && C.r.message) || T('pantalla.pedidosSinRespuesta') }) }));
    box.appendChild(camposDePedido(T('pantalla.pedidosCamposFijos'), T('pantalla.pedidosCamposFijosAyuda'), actual.fixed_fields, function (m) { w().fixed_fields = m; limpiar(); }, 'work_items.fixed_fields', pr, catalogo));
    var gs = esObjeto(actual.by_severity) ? actual.by_severity : {};
    var tabla = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.pedidosPorGravedad') }), el('p', { class: 'sub-d', text: T('pantalla.pedidosPorGravedadAyuda') }));
    GRAVEDADES.forEach(function (g) {
      tabla.appendChild(camposDePedido(g[1], '', gs[g[0]], function (m) { var x = w(); if (!esObjeto(x.by_severity)) x.by_severity = {}; if (Object.keys(m).length) x.by_severity[g[0]] = m; else delete x.by_severity[g[0]]; limpiar(); }, 'work_items.by_severity.' + g[0], pr, catalogo));
    });
    problemasEn(pr, 'work_items.by_severity').forEach(function (x) { tabla.appendChild(el('div', { class: 'err', text: x.message })); });
    box.appendChild(tabla);
    box.appendChild(restoYTexto(s, d, pr, 'work_items', T('pantalla.pedidosComoTexto')));
    return box;
  }
  // el umbral de cobertura: un porcentaje entero de 1 a 100; vacío, el de siempre (75)
  function editorCobertura(s, d, pr) {
    var c = esObjeto(d.coverage) ? d.coverage : {};
    return el('div', { class: 'pila' }, campo(T('pantalla.porcentajeMinimoDeLasLineas2'), c.min_touched_lines_pct, function (v) {
      if (v === '') { if (esObjeto(d.coverage)) { delete d.coverage.min_touched_lines_pct; if (!Object.keys(d.coverage).length) delete d.coverage; } return; }
      if (!esObjeto(d.coverage)) d.coverage = {};
      d.coverage.min_touched_lines_pct = numOTexto(v);
    }, 'coverage.min_touched_lines_pct', pr, { inputmode: 'numeric' }));
  }
  // las vueltas de revisores: el tope (entero de 1 a 6; vacío, el de fábrica, 2) y los prefijos que la organización suma
  // a los de fábrica como «seguridad o datos». Una clave que queda vacía se saca: no se propone un «{}»
  function editorRevision(s, d, pr) {
    var r = esObjeto(d.review) ? d.review : {};
    function limpiar() { if (esObjeto(d.review) && !Object.keys(d.review).length) delete d.review; }
    var box = el('div', { class: 'pila' }, campo(T('pantalla.topeDeVueltasCampo'), r.max_rounds, function (v) {
      if (v === '') { if (esObjeto(d.review)) { delete d.review.max_rounds; limpiar(); } return; }
      if (!esObjeto(d.review)) d.review = {};
      d.review.max_rounds = numOTexto(v);
    }, 'review.max_rounds', pr, { inputmode: 'numeric' }));
    var prefijos = Array.isArray(r.blocking_prefixes) ? r.blocking_prefixes : [];
    box.appendChild(listaDeTextos(T('pantalla.prefijosDeSeguridadODatosCampo'), T('pantalla.prefijosDeSeguridadODatosAyuda'), prefijos, function (l) {
      if (!l.length) { if (esObjeto(d.review)) { delete d.review.blocking_prefixes; limpiar(); } return; }
      if (!esObjeto(d.review)) d.review = {};
      d.review.blocking_prefixes = l;
    }, 'review.blocking_prefixes', pr, T('pantalla.prefijoEjemplo'), T('pantalla.agregarPrefijo')));
    return box;
  }
  // «Tu tecnología»: lo que el arnés ya conoce, las terminaciones de la organización, las herramientas de prueba (de
  // fábrica, cambiadas o agregadas) y las tres reglas. Una clave que queda vacía se saca: no se propone un «{}»
  var TEC_FORM = null;     // la herramienta que se está cambiando: { name, r, fabrica }
  var TEC_AGENTE = false;  // se tocó «Pedíselo a tu agente»
  var TEC_NOMBRES = { dotnet: '.NET', vitest: 'Vitest', jest: 'Jest', node: 'Node (node --test)', pytest: 'pytest (Python)', go: 'Go', maven: 'Maven (Java)', gradle: 'Gradle (Java, Kotlin)', karma: 'Karma (Angular)', playwright: 'Playwright (punta a punta)' };
  var TEC_ARCHIVOS = { dotnet: '.sln, .csproj', vitest: 'package.json (vitest)', jest: 'package.json (jest)', node: 'package.json (node --test)' };
  function stackDe(d) { if (!esObjeto(d.stack)) d.stack = {}; return d.stack; }
  function limpiarStack(d) {
    if (!esObjeto(d.stack)) return;
    ['code_extensions', 'test_runners'].forEach(function (k) { if (Array.isArray(d.stack[k]) && !d.stack[k].length) delete d.stack[k]; });
    if (esObjeto(d.stack.rules) && !Object.keys(d.stack.rules).length) delete d.stack.rules;
    if (!Object.keys(d.stack).length) delete d.stack;
  }
  function guardarRunner(d, r) {
    var l = (Array.isArray(stackDe(d).test_runners) ? d.stack.test_runners : []).filter(function (x) { return !x || x.name !== r.name; });
    l.push(r); d.stack.test_runners = l;
  }
  function quitarRunner(d, name) {
    if (!esObjeto(d.stack) || !Array.isArray(d.stack.test_runners)) return;
    d.stack.test_runners = d.stack.test_runners.filter(function (x) { return !x || x.name !== name; });
    limpiarStack(d);
  }
  function boton(texto, onclick) { return el('button', { class: 'sec', type: 'button', text: texto, onclick: onclick }); }
  function formRunner(d) {
    var f = TEC_FORM; var r = f.r;
    var upd = function (k) { return function (v) { r[k] = v; }; };
    var dentro = function (o, k) { return function (v) { if (!esObjeto(r[o])) r[o] = {}; r[o][k] = v; }; };
    var res = esObjeto(r.results) ? r.results : {}; var cov = esObjeto(r.coverage) ? r.coverage : null;
    return el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.tecCambiarLaHerramienta', { nombre: TEC_NOMBRES[r.name] || r.name }) }),
      el('div', { class: 'msg warn' }, el('b', { text: T('pantalla.tecElComandoCorreEnCadaComputadora') })),
      campo(T('pantalla.tecArchivoQueLaDetecta'), r.detect, upd('detect'), 'runner.detect', []),
      campo(T('pantalla.tecComando'), r.command, upd('command'), 'runner.command', []),
      selector(T('pantalla.tecQueReporteDeja'), res.format, [['junit', T('pantalla.tecReporteJunit')], ['jest-json', T('pantalla.tecReporteJest')]], dentro('results', 'format'), 'runner.results.format', []),
      campo(T('pantalla.tecDondeQuedaElReporte'), res.path, dentro('results', 'path'), 'runner.results.path', []),
      selector(T('pantalla.tecMideLaCobertura'), cov ? cov.format : '', [['', T('pantalla.tecNoMide')], ['cobertura', 'Cobertura'], ['lcov', 'lcov'], ['istanbul-json', 'istanbul'], ['jacoco', 'JaCoCo'], ['go-cover', 'Go']], function (v) {
        if (!v) delete r.coverage; else { if (!esObjeto(r.coverage)) r.coverage = { path: '' }; r.coverage.format = v; }
        render();
      }, 'runner.coverage.format', []),
      cov ? campo(T('pantalla.tecDondeQuedaLaCobertura'), cov.path, dentro('coverage', 'path'), 'runner.coverage.path', []) : null,
      f.fabrica ? el('p', { class: 'sub-d', text: T('pantalla.tecAlGuardarUsaEsta') }) : null,
      el('div', { class: 'fila' }, el('button', { type: 'button', text: T('pantalla.tecGuardar'), onclick: function () { guardarRunner(d, r); TEC_FORM = null; render(); } }), boton(T('pantalla.tecCancelar'), function () { TEC_FORM = null; render(); })));
  }
  function editorTecnologia(s, d, pr) {
    var ex = s.extras || {};
    var st = esObjeto(d.stack) ? d.stack : {};
    var box = el('div', { class: 'pila' }, el('p', { class: 'sub-d', text: T('pantalla.tecYaReconoce') }));
    // 1. las terminaciones que también son código
    var exts = Array.isArray(st.code_extensions) ? st.code_extensions.slice() : [];
    box.appendChild(listaDeTextos(T('pantalla.tecLenguajesQueNoConoce'), T('pantalla.tecLenguajesAyuda'), exts, function (l) { stackDe(d).code_extensions = l; limpiarStack(d); }, 'stack.code_extensions', pr, T('pantalla.tecTerminacionEjemplo'), T('pantalla.tecAgregarTerminacion')));
    // 2. las herramientas de prueba
    var org = Array.isArray(st.test_runners) ? st.test_runners : [];
    var deOrg = {}; org.forEach(function (r) { if (r && r.name) deOrg[r.name] = r; });
    var fabrica = ex.fabrica || [];
    var tabla = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.tecComoSeCorrenLasPruebas') }), el('p', { class: 'sub-d', text: T('pantalla.tecComoSeCorrenAyuda') }));
    (ex.internos || []).forEach(function (n) {
      tabla.appendChild(el('div', { class: 'fila', 'data-runner': n }, el('span', { text: TEC_NOMBRES[n] || n }), el('span', { class: 'muted', text: TEC_ARCHIVOS[n] || '' }), el('span', { text: T('pantalla.tecDeFabricaLaCorreLaPuerta') })));
    });
    // el motivo exacto, plegado: lo arma el servidor y no está traducido
    if (!ex.fabrica) tabla.appendChild(aviso('nm', T('pantalla.tecSinListaDeFabrica'), ex.motivo || null));
    fabrica.forEach(function (f) {
      var mia = deOrg[f.name];
      var acciones = el('span', {}, boton(T('pantalla.tecCambiar'), function () { TEC_FORM = { name: f.name, r: copia(mia || { name: f.name, detect: f.detect, command: f.command, results: f.results, coverage: f.coverage }), fabrica: f }; if (!TEC_FORM.r.coverage) delete TEC_FORM.r.coverage; render(); }));
      if (mia) acciones.appendChild(boton(T('pantalla.tecVolverALaDeFabrica'), function () { quitarRunner(d, f.name); render(); }));
      tabla.appendChild(el('div', { class: 'fila', 'data-runner': f.name }, el('span', { text: TEC_NOMBRES[f.name] || f.name }), el('span', { class: 'muted', text: (f.files || []).join(', ') }), el('span', { text: mia ? T('pantalla.tecCambiadaPorTuOrganizacion') : T('pantalla.tecDeFabrica') }), acciones));
    });
    org.forEach(function (r) {
      if (!r || !r.name || fabrica.some(function (f) { return f.name === r.name; })) return;
      tabla.appendChild(el('div', { class: 'fila', 'data-runner': r.name }, el('span', { text: r.name }), el('span', { class: 'muted', text: r.detect || '' }), el('span', { text: T('pantalla.tecAgregadaPorTuOrganizacion') }),
        el('span', {}, boton(T('pantalla.tecCambiar'), function () { TEC_FORM = { name: r.name, r: copia(r), fabrica: null }; render(); }), boton(T('pantalla.tecBorrar'), function () { quitarRunner(d, r.name); render(); }))));
    });
    (pr || []).filter(function (x) { return String(x.path).indexOf('stack.test_runners') === 0; }).forEach(function (x) { MOSTRADOS.push(x); tabla.appendChild(el('div', { class: 'err', text: x.donde + ': ' + x.message })); });
    tabla.appendChild(el('p', { class: 'sub-d', text: T('pantalla.tecComoReemplazarUnaDeLaPuerta') }));
    box.appendChild(tabla);
    if (TEC_FORM) box.appendChild(formRunner(d));
    // pedirle al agente una herramienta que no está: la frase, y qué pasa después
    var frase = T('pantalla.tecFraseParaElAgente');
    var agente = el('div', { class: 'sub' }, el('p', { class: 'sub-d', text: T('pantalla.tecUsanOtraHerramienta') }), boton(T('pantalla.tecPediseloATuAgente'), function () {
      TEC_AGENTE = true;
      try { if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(frase).catch(function () {}); } catch (e) { /* sin portapapeles, la frase queda a la vista */ }
      render();
    }));
    if (TEC_AGENTE) agente.appendChild(el('div', { class: 'msg ok' }, el('b', { text: T('pantalla.tecPegaEstaFrase') }), el('p', { text: '«' + frase + '»' }), el('p', { text: T('pantalla.tecElAgenteMira') })));
    box.appendChild(agente);
    // 3. las reglas del equipo
    var reglas = esObjeto(st.rules) ? st.rules : {};
    var regla = function (k) { return function (v) { var x = stackDe(d); if (!esObjeto(x.rules)) x.rules = {}; if (v === '') delete x.rules[k]; else x.rules[k] = v; limpiarStack(d); }; };
    box.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: T('pantalla.tecReglasDeTuEquipo') }),
      selector(T('pantalla.tecEstiloDeNombres'), reglas.test_names, [['', T('pantalla.tecSinDeclararCualquiera')], ['any', T('pantalla.tecCualquierNombre')], ['pascal', T('pantalla.tecPascal')], ['snake', T('pantalla.tecSnake')]], regla('test_names'), 'stack.rules.test_names', pr),
      selector(T('pantalla.tecQuePantallas'), reglas.screen_test, [['', T('pantalla.tecSinDeclararTodas')], ['ui', T('pantalla.tecTodas')], ['react', T('pantalla.tecSoloReact')], ['off', T('pantalla.tecNinguna')]], regla('screen_test'), 'stack.rules.screen_test', pr),
      campo(T('pantalla.tecIdiomaDeLaApp'), reglas.ui_language, regla('ui_language'), 'stack.rules.ui_language', pr, { placeholder: T('pantalla.tecIdiomaEjemplo') }),
      el('p', { class: 'sub-d', text: T('pantalla.tecIdiomaVacio') })));
    return box;
  }
  var EDITORES = { pedidos: editorPedidos, tecnologia: editorTecnologia, fichas: editorFichas, organizacion: editorOrganizacion, espera: editorEspera, cobertura: editorCobertura, revision: editorRevision, respuesta: editorRespuesta, integraciones: editorIntegraciones, aprobaciones: editorAprobaciones, pruebaAMano: editorPruebaAMano, ado: editorAdo, actualizacion: editorActualizacion, instalacion: editorInstalacion, hilos: editorHilos, aplicar: editorAplicar, aldia: editorActualizacionSitio, suites: editorSuites, modelos: editorModelos, paquetes: editorPaquetes, repos: editorRepos, responsables: editorResponsables, despliegues: editorDespliegues, canal: function (s, d, pr) { return editorGenerico(s, d, pr, 'notify', T('pantalla.elCanalComoTexto')); }, personas: editorPersonas, sitio: editorSitio, umbrales: editorUmbrales, paridad: editorParidad };

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
    var b = baseDe(s);
    return api('/revisar', { seccion: s.id, borrador: sinVacios(s, borrador === undefined ? S.borradores[s.id] : borrador), base: b.texto === null || b.texto === undefined ? '' : b.texto, oid: b.oid === undefined ? null : b.oid }).then(function (r) {
      S.problemas[s.id] = llanos(r.problems); S.avisos[s.id] = llanos(r.avisos);
      if (r.borrador) S.borradores[s.id] = r.borrador;
      // revisado sin problemas: lo que quedaba por elegir de un choque se toma como está en los campos
      if (r.ok) delete S.conflictos[s.id];
      // el texto revisado se armó sobre otra versión (lo que se arma siempre sobre la de hoy): «Proponer» manda ésa
      if (r.ok && r.version && r.version.oid !== baseDe(s).oid) S.bases[s.id] = { texto: r.version.texto === undefined ? null : r.version.texto, oid: r.version.oid === undefined ? null : r.version.oid };
      S.textos[s.id] = r.ok ? r.texto : null;
      S.diferencias[s.id] = r.ok ? (r.diferencia || []) : []; S.resumenes[s.id] = r.ok ? (r.resumen || []) : [];
      S.notas[s.id] = r.ok ? { ok: true, text: T('pantalla.revisadoEstaBienEscrito') + (r.aviso ? ' ' + r.aviso : '') + (r.advertencia ? ' ' + r.advertencia : '') } : { ok: false, text: mensajeLlano(r.message) || T('pantalla.hayQueCorregirLoMarcado') };
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
    if (!m || /identidad de escritura|write identity/.test(m)) return T('pantalla.paraProponerDesdeAcaEl');
    if (/plataforma|platform/.test(m)) return T('pantalla.elSitioNoReconoceDonde');
    return T('pantalla.proponerDesdeAcaNoEsta') + m;
  }
  /** Qué pasa al proponer: se aplica solo (la opción de la organización, con políticas que el sitio cumple) o queda el pedido. */
  function textoProponer(s, prop) {
    var repo = REPO_DE[s.repo] || T('pantalla.suRepo');
    if (prop && prop.aplicaSolo) return T('pantalla.seAplicaSoloElSitio') + repo + '.';
    return T('pantalla.seAbreUnPedidoDe') + repo + '. ' + (prop && prop.motivoAplicar ? prop.motivoAplicar : T('pantalla.entraCuandoAlguienLoAprueba'));
  }
  /** Lo que cambia, para mirar antes de confirmar: el resumen, los renglones que difieren y, cerrados, los archivos enteros. */
  function vistaDeLaDiferencia(s) {
    var caja = el('div', { class: 'propuesta' });
    var res = S.resumenes[s.id] || [];
    if (res.length) { var ul = el('ul', { class: 'resumen' }); res.forEach(function (f) { ul.appendChild(el('li', { text: f })); }); caja.appendChild(ul); }
    var dif = el('div', { class: 'dif', role: 'group' });
    (S.diferencias[s.id] || []).forEach(function (tr) {
      if (tr.iguales !== undefined) { dif.appendChild(el('div', { class: 'dif-salto', text: T('pantalla.nRenglonesIguales', { n: tr.iguales }) })); return; }
      (tr.renglones || []).forEach(function (r) {
        var tipo = r.tipo === 'sale' ? 'sale' : r.tipo === 'entra' ? 'entra' : 'igual';
        dif.appendChild(el('div', { class: 'dif-r dif-' + tipo }, el('span', { class: 'dif-signo', text: tipo === 'sale' ? '\u2212' : tipo === 'entra' ? '+' : ' ' }), el('span', { class: 'dif-texto', text: r.linea })));
      });
    });
    caja.appendChild(dif);
    caja.appendChild(el('details', { class: 'archivos-enteros' }, el('summary', { text: T('pantalla.verLosArchivosEnteros') }),
      el('div', { class: 'antes-despues' },
        el('div', {}, el('div', { class: 'lab', text: T('pantalla.hoy4') }), el('pre', { text: baseDe(s).texto || T('pantalla.todaviaNoHayNadaGuardado2') })),
        el('div', {}, el('div', { class: 'lab', text: T('pantalla.despuesDelCambio') }), el('pre', { text: S.textos[s.id] })))));
    return caja;
  }
  function empezarAProponer(s) { S.marcas[s.id] = nuevaMarca(); S.notas[s.id] = { confirmar: true }; render(); }
  /** Termina la propuesta de una marca: la primera respuesta buena la cierra y ninguna posterior la pisa. */
  function terminarPropuesta(s, marca, nota, bien) {
    if (S.terminadas[marca]) { delete S.proponiendo[s.id]; render(); return; }
    delete S.proponiendo[s.id];
    if (bien) { S.terminadas[marca] = true; S.originales[s.id] = copia(S.borradores[s.id]); delete S.conflictos[s.id]; olvidar(s.id); }
    S.notas[s.id] = nota; render();
    if (!bien) return;
    // aplicado: la versión nueva ya está; abierto: se pregunta hasta que entre o se cierre, y entonces se relee (decisión 10)
    if (nota.codigo === 'aplicado') { cargar(true).catch(alFallarLaRelectura(s)); return; }
    cargar().catch(alFallarLaRelectura(s));
    seguir(s, marca, 0);
  }
  /** Lo inesperado al dibujar lo releído se dice en la sección que propuso, sin tapar el enlace de su pedido. */
  function alFallarLaRelectura(s) {
    return function (e) {
      var n = S.notas[s.id] || {};
      S.notas[s.id] = { ok: false, text: (n.text ? n.text + ' · ' : '') + T('pantalla.noPudeCargarLaPestana') + ' ' + (e && e.message ? e.message : ''), enlace: n.enlace || null };
      render();
    };
  }
  /** Con el pedido abierto, pregunta cada tanto si sigue abierto; cuando entra o se cierra, el sitio relee y la página también. */
  function seguir(s, marca, vuelta) {
    if (vuelta >= SEGUIR.vueltas) return;
    despues(SEGUIR.cada, function () {
      cuandoSeVea(function () {
        api('/propuesta?seccion=' + encodeURIComponent(s.id) + '&marca=' + marca).then(function (r) {
          if (r && r.ok && (r.estado === 'aplicado' || r.estado === 'no_hay')) return cargar(true).catch(alFallarLaRelectura(s));
          seguir(s, marca, vuelta + 1);
        });
      });
    });
  }
  /** El archivo cambió en main desde la base: la propuesta vuelve puesta encima de la versión nueva, o con lo que se pisa. */
  function otraVersion(s, r) {
    delete S.proponiendo[s.id];
    if (r.seccion) ponerBase(s, r.seccion);
    if (r.borrador) S.borradores[s.id] = copia(r.borrador);
    if (r.codigo === 'reaplicado') {
      S.textos[s.id] = r.texto; S.diferencias[s.id] = r.diferencia || []; S.resumenes[s.id] = r.resumen || [];
      delete S.conflictos[s.id];
      // es otra propuesta: la de antes quedó contestada con esta respuesta
      S.marcas[s.id] = nuevaMarca();
      S.notas[s.id] = { confirmar: true, ok: true, text: r.message };
    } else {
      S.conflictos[s.id] = copia(r.conflictos || []); S.textos[s.id] = null; S.diferencias[s.id] = []; S.resumenes[s.id] = [];
      S.notas[s.id] = { ok: false, text: r.message };
    }
    guardarBorradores(); render();
  }
  function mostrarValor(v) { return v === undefined ? T('pantalla.sacado') : JSON.stringify(v, null, 2); }
  /** Pone v en camino dentro de obj (undefined lo saca). */
  function poner(obj, camino, v) {
    // cada clave como propia: una máquina o un producto puede llamarse __proto__, y con «=» se tocaría el prototipo
    var propia = function (o, k, x) { Object.defineProperty(o, k, { value: x, enumerable: true, writable: true, configurable: true }); };
    var tiene = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var o = obj;
    for (var i = 0; i < camino.length - 1; i++) { if (!(tiene(o, camino[i]) && esObjeto(o[camino[i]]))) { if (v === undefined) return; propia(o, camino[i], {}); } o = o[camino[i]]; }
    if (v === undefined) delete o[camino[camino.length - 1]]; else propia(o, camino[camino.length - 1], copia(v));
  }
  /** La persona elige, para un valor que se pisó, el suyo o el de ahora. */
  function elegir(s, i, cual) {
    var c = (S.conflictos[s.id] || [])[i]; if (!c) return;
    if (!c.camino || !c.camino.length) S.borradores[s.id] = c[cual] === undefined ? {} : copia(c[cual]);
    else poner(S.borradores[s.id], c.camino, c[cual]);
    S.conflictos[s.id].splice(i, 1);
    S.textos[s.id] = null;
    if (!S.conflictos[s.id].length) { delete S.conflictos[s.id]; S.notas[s.id] = { ok: true, text: T('pantalla.elegisteTodoRevisa') }; }
    guardarBorradores(); render();
  }
  function recuperar(s) {
    var g = S.recuperar[s.id]; if (!g) return;
    S.borradores[s.id] = copia(g.borrador === undefined ? {} : g.borrador);
    if (g.original !== undefined) S.originales[s.id] = copia(g.original);
    S.bases[s.id] = { texto: typeof g.base === 'string' ? g.base : null, oid: g.oid === undefined ? null : g.oid };
    delete S.recuperar[s.id];
    S.textos[s.id] = null;
    S.notas[s.id] = { ok: true, text: T('pantalla.recuperadoRevisa') };
    guardarBorradores(); render();
  }
  function descartar(s) { delete S.recuperar[s.id]; olvidar(s.id); render(); }
  /** Pregunta hasta tres veces si el pedido de la marca existe; da la respuesta que lo encuentra o null. */
  function buscarElPedido(s, marca, i) {
    if (i >= ESPERAS.length) return Promise.resolve(null);
    return new Promise(function (ok) { setTimeout(ok, ESPERAS[i]); }).then(function () {
      return api('/propuesta?seccion=' + encodeURIComponent(s.id) + '&marca=' + marca);
    }).then(function (r) {
      if (r && r.ok && (r.estado === 'abierto' || r.estado === 'aplicado')) return r;
      if (r && !r.ok && !r.sinRespuesta) return null;
      return buscarElPedido(s, marca, i + 1);
    });
  }
  function confirmarPropuesta(s) {
    if (S.proponiendo[s.id]) return;
    var marca = S.marcas[s.id] || (S.marcas[s.id] = nuevaMarca());
    var b = baseDe(s);
    S.proponiendo[s.id] = marca; render();
    // una respuesta que tarda (el sitio esperando algo largo) no deja la sección en «proponiendo…»: pasado el tope se
    // pregunta por la marca, y si el pedido ya se abrió o ya entró, la propuesta se cierra con eso
    var sigueEsperando = function () { return S.proponiendo[s.id] === marca && !S.terminadas[marca]; };
    var vigilar = function (vuelta) {
      if (!sigueEsperando()) return;
      // sin respuesta y sin pedido a la vista después de todas las vueltas: no se queda en «proponiendo…», dice qué hacer
      if (vuelta >= SEGUIR.vueltas) return terminarPropuesta(s, marca, { ok: false, text: T('pantalla.noPudeHablarConEl') + T('pantalla.sinRespuesta') + T('pantalla.siEstabasProponiendoRecargaY'), enlace: null }, false);
      // con la pestaña oculta no pregunta, como el seguimiento del pedido
      cuandoSeVea(function () {
        api('/propuesta?seccion=' + encodeURIComponent(s.id) + '&marca=' + marca).then(function (h) {
          if (!sigueEsperando()) return;
          if (h && h.ok && (h.estado === 'abierto' || h.estado === 'aplicado')) return terminarPropuesta(s, marca, { ok: true, text: h.estado === 'aplicado' ? T('pantalla.pedidoAplicado') : T('pantalla.pedidoAbierto'), enlace: h.enlace || null, codigo: h.estado }, true);
          despues(SEGUIR.cada, function () { vigilar(vuelta + 1); });
        });
      });
    };
    despues(ESPERA_RESPUESTA, function () { vigilar(0); });
    api('/proponer', { seccion: s.id, texto: S.textos[s.id], oid: b.oid === undefined ? null : b.oid, base: b.texto === null || b.texto === undefined ? '' : b.texto, marca: marca }).then(function (r) {
      if (!r.sinRespuesta && !S.terminadas[marca] && (r.codigo === 'reaplicado' || r.codigo === 'se_pisan' || r.codigo === 'no_valida')) return otraVersion(s, r);
      if (!r.sinRespuesta || S.terminadas[marca]) return terminarPropuesta(s, marca, { ok: r.ok, text: r.message, enlace: r.enlace || null, codigo: r.codigo }, r.ok);
      return buscarElPedido(s, marca, 0).then(function (h) {
        if (h) return terminarPropuesta(s, marca, { ok: true, text: h.estado === 'aplicado' ? T('pantalla.pedidoAplicado') : T('pantalla.pedidoAbierto'), enlace: h.enlace || null, codigo: h.estado }, true);
        terminarPropuesta(s, marca, { ok: false, text: r.message + (r.pista ? '' : ' ' + T('pantalla.recargaYMiraSiElPedidoSeAbrio')), enlace: null }, false);
      });
    }).catch(function (e) {
      // lo inesperado también cierra la propuesta: sin esto la sección quedaría en «proponiendo…» con todo apagado
      terminarPropuesta(s, marca, { ok: false, text: T('pantalla.noPudeHablarConEl') + (e && e.message ? e.message : T('pantalla.sinRespuesta')) + T('pantalla.siEstabasProponiendoRecargaY'), enlace: null }, false);
    });
  }
  /** Dibuja la sección; mientras propone, todo lo que tiene nace apagado (un solo envío). */
  function seccion(s) {
    var antes = SOLO_LECTURA;
    SOLO_LECTURA = antes || !!S.proponiendo[s.id];
    try { return dibujarSeccion(s); } finally { SOLO_LECTURA = antes; }
  }
  function dibujarSeccion(s) {
    var p = plano(s);
    var est = estadoDe(s);
    var sec = el('section', { class: 'card form-block', id: 'seccion-' + s.id }, el('div', { class: 'fb-head' }, el('div', {}, el('h4', { text: p.t }), el('p', { class: 'reach', text: p.d })), el('span', { class: 'pill ' + est[0], text: est[1] })));
    if (s.estado === 'no_reader') { sec.appendChild(aviso('nm', T('pantalla.estaVersionDelArnesTodavia'), s.motivo)); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'ilegible') { sec.appendChild(aviso('bad', T('pantalla.loGuardadoEnEstaParte'), s.motivo)); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'no_configurado') { sec.appendChild(aviso('nm', T('pantalla.estaParteTodaviaNoEsta'), s.motivo)); if (s.id !== 'paridad') return sec; }
    if (s.estado === 'nuevo') sec.appendChild(el('p', { class: 'muted', text: T('pantalla.todaviaNoHayNadaGuardado') }));
    if (s.soloLectura) sec.appendChild(aviso('nm', T('pantalla.porAhoraSePuedeMirar'), s.motivo));
    if (S.recuperar[s.id]) {
      sec.appendChild(el('div', { class: 'msg recuperar' }, el('b', { text: T('pantalla.teniasCambiosSinProponer') }),
        el('div', { class: 'bar' }, el('button', { type: 'button', text: T('pantalla.recuperarLoQueEstabas'), onclick: function () { recuperar(s); } }), el('button', { class: 'sec', type: 'button', text: T('pantalla.descartar'), onclick: function () { descartar(s); } }))));
    }
    var pr = S.problemas[s.id] || [];
    var arriba = pr.filter(function (x) { return x.sinCampo; });
    if (arriba.length) { var ul = el('ul', { class: 'renglones' }); arriba.forEach(function (x) { ul.appendChild(el('li', { class: 'err', text: (x.donde ? x.donde + ': ' : '') + x.message })); }); sec.appendChild(ul); }
    var editor = EDITORES[s.id];
    if (editor) { var previa = SOLO_LECTURA; SOLO_LECTURA = previa || !!s.soloLectura; try { sec.appendChild(editor(s, S.borradores[s.id], pr)); } finally { SOLO_LECTURA = previa; } }
    var choques = S.conflictos[s.id] || [];
    if (choques.length) {
      var caja = el('div', { class: 'conflictos', role: 'group' }, el('b', { text: T('pantalla.sePisanElegi') }));
      choques.forEach(function (c, i) {
        caja.appendChild(el('div', { class: 'conflicto' }, el('div', { class: 'lab', text: rutaLlana(c.ruta) }),
          el('div', { class: 'dos' }, el('div', {}, el('span', { class: 'lab', text: T('pantalla.loTuyo') }), el('pre', { text: mostrarValor(c.tuyo) })), el('div', {}, el('span', { class: 'lab', text: T('pantalla.loDeAhora') }), el('pre', { text: mostrarValor(c.ahora) }))),
          el('div', { class: 'bar' }, el('button', { type: 'button', text: T('pantalla.quedarmeConElMio'), onclick: function () { elegir(s, i, 'tuyo'); } }), el('button', { class: 'sec', type: 'button', text: T('pantalla.tomarElDeAhora'), onclick: function () { elegir(s, i, 'ahora'); } }))));
      });
      sec.appendChild(caja);
    }
    var n = S.notas[s.id];
    var prop = S.extras.proponer && S.extras.proponer[s.repo];
    // story 2.30: con una política con filtro de ruta, el estado del archivo de la sección manda sobre el del repo
    if (prop && prop.porArchivo && prop.porArchivo[s.archivo]) prop = prop.porArchivo[s.archivo];
    var habilitado = prop && prop.habilitado;
    var confirmando = n && n.confirmar;
    if (!confirmando && n && n.text) {
      var nota = el('div', { class: 'msg ' + (n.ok ? 'ok' : 'bad') }, el('b', { text: n.text }));
      if (n.enlace) nota.appendChild(el('a', { href: n.enlace, text: T('pantalla.verElPedidoDeCambio') }));
      sec.appendChild(nota);
    }
    if (!s.soloLectura && !bloqueada(s) && s.id !== 'paridad') {
      var bar = el('div', { class: 'bar' }, el('button', { class: 'sec', type: 'button', text: T('pantalla.revisarCambios'), onclick: function () { revisarSeccion(s); } }));
      bar.appendChild(el('button', { class: 'sec', type: 'button', text: T('pantalla.descargar'), disabled: S.textos[s.id] ? undefined : 'disabled', onclick: function () { descargar(s); } }));
      if (habilitado) bar.appendChild(el('button', { type: 'button', text: T('pantalla.proponerElCambio'), disabled: S.textos[s.id] ? undefined : 'disabled', onclick: function () { empezarAProponer(s); } }));
      bar.appendChild(el('span', { class: 'por-que', text: !habilitado ? motivoProponer(prop && prop.motivo) : (S.textos[s.id] ? textoProponer(s, prop) : T('pantalla.primeroRevisaAsiSabesSi')) }));
      if (!confirmando) sec.appendChild(bar);
    }
    if (s.id === 'paridad' && S.textos[s.id] && habilitado && !confirmando) sec.appendChild(el('div', { class: 'bar' }, el('button', { type: 'button', text: T('pantalla.proponerElCambio'), onclick: function () { empezarAProponer(s); } })));
    if (confirmando) {
      var proponiendo = !!S.proponiendo[s.id];
      if (n.text && !proponiendo) sec.appendChild(el('div', { class: 'msg ' + (n.ok ? 'ok' : 'bad') }, el('b', { text: n.text })));
      sec.appendChild(vistaDeLaDiferencia(s));
      if (proponiendo) sec.appendChild(el('div', { class: 'msg ok' }, el('b', { text: T('pantalla.proponiendo') })));
      sec.appendChild(el('div', { class: 'bar' }, el('button', { type: 'button', text: T('pantalla.confirmarYProponer'), onclick: function () { confirmarPropuesta(s); } }), el('button', { class: 'sec', type: 'button', text: T('pantalla.cancelar'), onclick: function () { S.notas[s.id] = null; render(); } }), el('span', { class: 'por-que', text: T('pantalla.miraLaDiferenciaAntesDe') })));
    }
    return sec;
  }
  function tablaDeMirar(titulo, ayuda, filas, columnas, id) {
    var sec = el('section', { class: 'card form-block', id: id }, el('div', { class: 'fb-head' }, el('div', {}, el('h4', { text: titulo }), el('p', { class: 'reach', text: ayuda }))));
    if (!filas || !filas.length) { sec.appendChild(el('p', { class: 'muted', text: T('pantalla.nadaQueMostrar') })); return sec; }
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
      kpi(porConfirmar ? 'st-warn' : 'st-good', '#seccion-personas', T('pantalla.maquinasPorConfirmar'), porConfirmar, porConfirmar ? T('pantalla.pidenQueDigasDeQuienSon') : T('pantalla.todasANombreDeAlguien')),
      kpi(aCorregir.length ? 'st-warn' : 'st-good', aCorregir.length ? '#seccion-' + aCorregir[0].id : null, T('pantalla.seccionesConAlgoParaArreglar'), aCorregir.length, aCorregir.length ? aCorregir.map(function (s) { return plano(s).corto; }).join(', ') : T('pantalla.ninguna2')),
      kpi('st-good', null, T('pantalla.seccionesAlDia'), alDia + T('pantalla.de2') + S.secciones.length, T('pantalla.sinNadaPendiente')),
      kpi(viejas ? 'st-warn' : '', '#versiones', T('pantalla.maquinasConUnaVersionVieja'), viejas, T('pantalla.de') + (ex.versiones || []).length + T('pantalla.queInforman'))));
    var prod = tablaDeMirar(T('pantalla.productos'), T('pantalla.losQueRevisaLaNoche'), (ex.productos || []).map(function (p) { return { producto: p.producto, origen: p.origen === 'deployments' ? T('pantalla.despliegues') : T('pantalla.revisionDeDependencias'), repo: p.repo || p.ruta, estado: p.activo === false ? T('pantalla.apagado') + (p.motivo ? ' (' + p.motivo + ')' : '') : T('pantalla.activo'), edita: p.origen === 'deployments' ? T('pantalla.siEnDespliegues') : T('pantalla.no') }; }), [['producto', T('pantalla.producto')], ['origen', T('pantalla.deDondeSale')], ['repo', T('pantalla.repo2')], ['estado', T('pantalla.estado')], ['edita', T('pantalla.seCambiaAca')]], 'productos');
    if (ex.productosMotivo) prod.appendChild(aviso('bad', T('pantalla.laListaDeProductosNo'), ex.productosMotivo));
    if (ex.productosEnlace) prod.appendChild(el('p', {}, el('a', { class: 'enlace-fuerte', href: ex.productosEnlace, text: T('pantalla.abrirLaListaDeLa') })));
    var ver = tablaDeMirar(T('pantalla.queVersionDelArnesTiene'), T('pantalla.laQueInformoCadaUna'), (ex.versiones || []).map(function (v) { return { maquina: v.maquina, persona: v.persona || T('pantalla.sinConfirmar'), version: v.version, dia: v.diaTexto, texto: v.texto }; }), [['maquina', T('pantalla.maquina')], ['persona', T('pantalla.persona2')], ['version', T('pantalla.version2')], ['dia', T('pantalla.ultimaNoticia2')], ['texto', T('pantalla.estado')]], 'versiones');
    if (ex.versionesMotivo) ver.appendChild(aviso('bad', T('pantalla.noSePudoLeerLo'), ex.versionesMotivo));
    var tablas = { productos: prod, versiones: ver };
    if (ex.contenido !== undefined) tablas.contenido = tablaDeContenido(ex.contenido);
    // lo pendiente de las tablas para mirar: una lista que no se pudo leer, o máquinas atrasadas
    var pendTabla = { productos: ex.productosMotivo ? 1 : 0, versiones: (ex.versionesMotivo ? 1 : 0) + viejas, contenido: 0 };
    var activa = S.pestana || PESTANAS[0][0];
    var barra = el('nav', { class: 'pestanas', role: 'tablist', 'aria-label': T('pantalla.partesDeLaConfiguracion') });
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
      var marca = pend ? el('span', { class: 'cuenta ' + (malas ? 'bad' : 'warn'), title: pend + T('pantalla.paraMirar'), text: String(pend) }) : null;
      barra.appendChild(el('a', { href: '#pestana-' + p[0], id: 'tab-' + p[0], role: 'tab', 'aria-selected': sel ? 'true' : 'false', 'aria-controls': 'pestana-' + p[0], class: sel ? 'activa' : undefined }, el('span', { text: p[1] }), marca));
      var panel = el('div', { class: 'pestana-panel', id: 'pestana-' + p[0], role: 'tabpanel', 'aria-labelledby': 'tab-' + p[0], hidden: sel ? undefined : 'hidden' });
      var pila = el('div', { class: 'pila' });
      secs.forEach(function (s) { pila.appendChild(seccion(s)); });
      panel.appendChild(pila);
      var mirar = p[3].filter(function (t) { return tablas[t]; });
      if (mirar.length) {
        panel.appendChild(el('h3', { class: 'block' }, el('span', { text: T('pantalla.paraMirar2') }), el('span', { class: 'aside', text: T('pantalla.noSeCambiaDesdeAca') })));
        var pm = el('div', { class: 'pila' });
        mirar.forEach(function (t) { pm.appendChild(tablas[t]); });
        panel.appendChild(pm);
      }
      paneles.push(panel);
    });
    partes.push(barra);
    paneles.forEach(function (x) { partes.push(x); });
    app.replaceChildren.apply(app, partes);
    guardarBorradores();
  }
  /** Lee la configuración; con releer, el sitio relee antes sus fuentes (tras un pedido que entró). */
  function cargar(releer) {
    return api(releer ? '?releer=1' : '').then(function (r) {
      // una relectura que falla después de la primera no borra la pantalla (la nota con el enlace, lo cargado): queda
      // lo que había, y la próxima propuesta se pone encima de la versión de main igual
      if (!r.ok && S.secciones.length) return;
      if (!r.ok) { app.replaceChildren(el('div', { class: 'msg bad' }, el('b', { text: T('pantalla.noSePudoLeerLa') }), el('span', { text: r.message || '' }))); return; }
      var primera = !S.secciones.length;
      S.secciones = r.secciones; S.extras = r;
      r.secciones.forEach(function (s) {
        var fresco = copia(s.borrador === undefined ? {} : s.borrador);
        // lo cargado sin proponer se queda con su base: al revisar, el servidor lo pone encima de la versión de hoy
        var n = S.notas[s.id];
        var conservar = !primera && S.bases[s.id] && (cambiada(s.id) || S.proponiendo[s.id] || (S.conflictos[s.id] || []).length || (n && n.confirmar));
        if (!conservar) { S.borradores[s.id] = fresco; S.originales[s.id] = copia(fresco); S.bases[s.id] = { texto: s.texto === undefined ? null : s.texto, oid: s.oid === undefined ? null : s.oid }; S.textos[s.id] = null; }
        S.problemas[s.id] = llanos(s.problems); S.avisos[s.id] = llanos(s.avisos);
        // al abrir la página: lo que quedó cargado antes de recargar se ofrece, si es distinto de lo de hoy
        if (primera) { var g = guardadoDe(s.id); if (g && !mismo(g.borrador, fresco)) S.recuperar[s.id] = g; else if (g) olvidar(s.id); }
      });
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
  // cada cambio de un campo deja lo cargado guardado (el evento sube desde el campo hasta la pestaña)
  app.addEventListener('input', guardarBorradores);
  app.addEventListener('change', guardarBorradores);
  app.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var h = a.getAttribute('href');
    if (h.indexOf('#pestana-') === 0 && typeof history !== 'undefined' && history.replaceState) { e.preventDefault(); history.replaceState(null, '', h); irA(h); return; }
    if (h === ancla()) irA(h);
  });
  cargar().then(function () { var h = ancla(); if (h && h.indexOf('#pestana-') !== 0) irA(h); }).catch(function (e) { app.replaceChildren(el('div', { class: 'msg bad' }, el('b', { text: T('pantalla.noPudeCargarLaPestana') }), el('span', { text: e.message }))); });
})();
`;
}

module.exports = {
  SECCIONES, seccionPorId, loadReader, lectorSabe, formatJson, remoteOf, TEAM_REPOS_SINCE, MERGE_SUITES_SINCE, MODELS_SINCE, MODEL_LEVELS_SINCE, WAIT_NOTICE_SINCE, COVERAGE_SINCE, REVIEW_SINCE, STACK_SINCE, RESPONSE_SINCE, APPROVALS_SINCE, QA_SINCE, versionQuePide, versionAtLeast, profileGateProblem, packsListGateProblem, teamProfileGateProblem,
  problemasDeSeccion, problemasDelTope, sinPipelinePorRegla, queHacePorRegla, hojasAjenas, modelosDeHoy, motivoDeHoy, modelosEnNiveles, equivalenciasDe,
  thresholdsParse, aplicarSeccion, revisar, versionesDeMaquinas, paridadPorProducto, ramaDePropuesta, tituloDePropuesta, cuerpoDePropuesta, pantalla, diferencia, reaplicar, versionDeTexto,
  SIN_NOTICIAS_DIAS,
};
