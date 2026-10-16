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
]);
const seccionPorId = (id) => SECCIONES.find((s) => s.id === id) || null;

/** El lector de una sección, del árbol del arnés; `null` si esta versión no lo trae. `lectores` (inyectados) manda. */
function loadReader(tree, nombre, lectores) {
  if (lectores && Object.prototype.hasOwnProperty.call(lectores, nombre)) return lectores[nombre];
  if (nombre === 'thresholds') return { parse: (t, o) => thresholdsParse(t, o) };
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
  const base = actual || (s.archivo === 'operations.json' ? { version: 1, owners: { default: '' } } : { version: 1 });
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
// Sólo usa setAttribute, appendChild, addEventListener, textContent y replaceChildren: las pruebas lo corren sobre un
// documento mínimo con eso nada más.
(function () {
  var meta = document.querySelector('meta[name="site-token"]');
  var TOKEN = meta ? meta.getAttribute('content') : '';
  var app = document.getElementById('config-app');
  if (!app) return;
  function el(tag, attrs) {
    var e = document.createElement(tag); attrs = attrs || {};
    // un atributo sin valor no se pone: setAttribute('disabled', undefined) igual deshabilita
    Object.keys(attrs).forEach(function (k) { var v = attrs[k]; if (v === undefined || v === null) return; if (k === 'text') e.textContent = v; else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); });
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

  // ── lo que ve la persona de cada sección: el nombre llano, para qué sirve, y en qué bloque va ──
  var PLANO = {
    sitio: { t: 'Quién mantiene el sitio', d: 'Sólo estas personas ven esta pestaña y pueden proponer cambios. Si te sacás de la lista, perdés el acceso cuando se apruebe.', corto: 'Quién mantiene el sitio' },
    personas: { t: 'Personas y máquinas', d: 'Cada máquina que manda corridas tiene que estar a nombre de alguien. Así cada persona ve lo suyo en el sitio.', corto: 'Personas y máquinas' },
    responsables: { t: 'A quién le llegan los avisos y los pedidos', d: 'Cuando algo de la noche necesita a una persona (una dependencia vieja, un hallazgo del vigilante) se le asigna a quien figure acá.', corto: 'Responsables' },
    repos: { t: 'Dónde vive cada repo', d: 'Llega a todas las máquinas del equipo: con esto cada una sabe de dónde se instala el arnés y dónde queda lo de la noche.', corto: 'Repos' },
    despliegues: { t: 'Despliegues de cada producto', d: 'Con esto el sitio sabe qué paso de cada pipeline es la prueba y cuál es producción, para decir qué versión está afuera.', corto: 'Despliegues' },
    canal: { t: 'Dónde llega el resumen de cada mañana', d: 'El canal donde la noche deja su resumen.', corto: 'Aviso diario' },
    umbrales: { t: 'Umbrales: cuándo algo se pinta verde o rojo', d: 'El tablero colorea cada número según estos límites. Entre los dos, se pinta amarillo.', corto: 'Umbrales' },
    paridad: { t: 'Diferencias aceptadas entre productos', d: 'Cada noche se comparan los productos entre sí. Lo que uno hace distinto a propósito se anota acá, con una fecha para volver a mirarlo.', corto: 'Diferencias entre productos' },
  };
  var BLOQUES = [['Personas y equipo', ['sitio', 'personas', 'responsables']], ['Dónde vive todo', ['repos', 'despliegues', 'canal']], ['Reglas de la noche', ['umbrales', 'paridad']]];
  var REPO_DE = { operaciones: 'el repo de operaciones', perfil: 'el repo del equipo' };
  function plano(s) { return PLANO[s.id] || { t: s.titulo, d: '', corto: s.titulo }; }
  function bloqueada(s) { return s.estado === 'no_reader' || s.estado === 'ilegible' || s.estado === 'no_configurado'; }
  /** El estado de una sección en una palabra: [clase, texto]. */
  function estadoDe(s) {
    if (s.estado === 'ilegible') return ['bad', 'hay que arreglarla a mano'];
    if (s.estado === 'no_reader') return ['nm', 'todavía no disponible'];
    if (s.estado === 'no_configurado') return ['nm', 'sin configurar'];
    if (s.soloLectura) return ['nm', 'sólo para mirar'];
    var n = (S.problemas[s.id] || []).length;
    if (n) return ['warn', n + ' para corregir'];
    if (S.textos[s.id]) return ['ok', 'revisada'];
    if (s.estado === 'nuevo') return ['nm', 'se crea al proponer'];
    if (s.id === 'personas' && s.extras && (s.extras.porConfirmar || []).length) return ['warn', s.extras.porConfirmar.length + ' por confirmar'];
    return ['ok', 'al día'];
  }
  /** Un aviso con una frase llana arriba y el motivo exacto del arnés, plegado, abajo. */
  function aviso(clase, titulo, detalle) {
    var box = el('div', { class: 'msg ' + clase }, el('b', { text: titulo }));
    if (detalle) box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: 'Detalle' }), el('span', { text: detalle })));
    return box;
  }

  function problemasEn(lista, p) { return (lista || []).filter(function (x) { return x.path === p; }); }
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
    var refresco = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Cada cuánto se actualiza el sitio' }), campo('Minutos, entre 5 y 120', site.refresh_minutes, function (v) { site.refresh_minutes = v === '' ? undefined : Number(v); }, 'site.refresh_minutes', pr, { inputmode: 'numeric' }));
    lista.appendChild(refresco);
    if (s.campos && s.campos.url) lista.appendChild(el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'La dirección del sitio' }), campo('', site.url, function (v) { site.url = v || undefined; }, 'site.url', pr)));
    var mb = site.mailbox || {};
    var buzon = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Dónde dejan sus corridas las máquinas' }), el('p', { class: 'sub-d', text: 'Las contraseñas no van acá: se cargan en la nube.' }));
    var f = el('div', { class: 'fila' });
    [['provider', 'Servicio'], ['account', 'Cuenta'], ['container', 'Carpeta']].forEach(function (par) { var k = par[0]; f.appendChild(campo(par[1], mb[k], function (v) { site.mailbox = site.mailbox || {}; site.mailbox[k] = v; }, 'site.mailbox.' + k, pr)); });
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
  function textoDeEntradas(lista) {
    return (lista || []).map(function (e) { if (!e || typeof e !== 'object') return String(e); if (e.environment) return e.environment + (e.repo ? ' (' + e.repo + ')' : ''); return (e.stages || []).join(', ') + (e.pipeline ? ' (' + e.pipeline + ')' : ''); }).join(' · ') || '—';
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
    var agregar = el('div', { class: 'sub' }, el('p', { class: 'sub-t', text: 'Agregar un producto' }), el('p', { class: 'sub-d', text: 'Elegís el pipeline y el sitio te muestra sus pasos para que marques cuál es la prueba y cuál producción.' }),
      el('div', { class: 'fila' }, producto, sel, nombrePipeline, el('button', { class: 'sec', type: 'button', text: 'Ver sus pasos', onclick: function () {
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
      var num = function (c, etiqueta) { var mios = problemasEn(pr, 'thresholds.' + k + '.' + c); var i = el('input', { value: u[c] == null ? '' : String(u[c]), inputmode: 'decimal', 'aria-label': etiqueta, 'data-path': 'thresholds.' + k + '.' + c, oninput: function (e) { var v = e.target.value; if (v === '') delete u[c]; else u[c] = Number(v); } }); if (mios.length) i.setAttribute('class', 'bad'); return i; };
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
    if (v.definicion) box.appendChild(el('details', { class: 'mas-info' }, el('summary', { text: 'Qué se compara (se cambia en el repo, no acá)' }), el('pre', { text: JSON.stringify(v.definicion, null, 2) })));
    return box;
  }
  var EDITORES = { repos: editorRepos, responsables: editorResponsables, despliegues: editorDespliegues, canal: function (s, d, pr) { return editorGenerico(s, d, pr, 'notify', 'El canal, como texto'); }, personas: editorPersonas, sitio: editorSitio, umbrales: editorUmbrales, paridad: editorParidad };

  function revisarSeccion(s, borrador) {
    return api('/revisar', { seccion: s.id, borrador: borrador === undefined ? S.borradores[s.id] : borrador }).then(function (r) {
      S.problemas[s.id] = r.problems || []; S.avisos[s.id] = r.avisos || [];
      if (r.borrador) S.borradores[s.id] = r.borrador;
      S.textos[s.id] = r.ok ? r.texto : null;
      S.notas[s.id] = r.ok ? { ok: true, text: 'Revisado: está bien escrito.' + (r.aviso ? ' ' + r.aviso : '') + (r.advertencia ? ' ' + r.advertencia : '') } : { ok: false, text: r.message || 'Hay que corregir lo marcado.' };
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
    if (arriba.length) { var ul = el('ul', { class: 'renglones' }); arriba.forEach(function (x) { ul.appendChild(el('li', { class: 'err', text: (x.path ? x.path + ': ' : '') + x.message })); }); sec.appendChild(ul); }
    var editor = EDITORES[s.id];
    if (editor) sec.appendChild(editor(s, S.borradores[s.id], pr));
    var n = S.notas[s.id];
    var prop = S.extras.proponer && S.extras.proponer[s.repo];
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
      bar.appendChild(el('span', { class: 'por-que', text: !habilitado ? motivoProponer(prop && prop.motivo) : (S.textos[s.id] ? 'Se abre un pedido de cambio en ' + (REPO_DE[s.repo] || 'su repo') + '. Entra cuando alguien lo aprueba.' : 'Primero revisá: así sabés si está bien antes de proponerlo.') }));
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
    var toc = el('nav', { class: 'toc', 'aria-label': 'Secciones' });
    BLOQUES.forEach(function (b) { b[1].forEach(function (id) { var s = porId[id]; if (!s) return; var e = estadoDe(s)[0]; toc.appendChild(el('a', { href: '#seccion-' + id }, el('span', { class: 'dot ' + (e === 'ok' ? '' : e) }), el('span', { text: plano(s).corto }))); }); });
    partes.push(toc);
    var vistas = {};
    BLOQUES.forEach(function (b) {
      var pila = el('div', { class: 'pila' });
      b[1].forEach(function (id) { if (porId[id]) { pila.appendChild(seccion(porId[id])); vistas[id] = true; } });
      partes.push(el('h3', { class: 'block', text: b[0] }));
      partes.push(pila);
    });
    // una sección que el arnés sume y esta pantalla no conozca todavía, igual se muestra
    var otras = S.secciones.filter(function (s) { return !vistas[s.id]; });
    if (otras.length) { var po = el('div', { class: 'pila' }); otras.forEach(function (s) { po.appendChild(seccion(s)); }); partes.push(el('h3', { class: 'block', text: 'Otras' })); partes.push(po); }
    partes.push(el('h3', { class: 'block' }, el('span', { text: 'Para mirar' }), el('span', { class: 'aside', text: 'no se cambia desde acá' })));
    var mirar = el('div', { class: 'pila' });
    var prod = tablaDeMirar('Productos', 'Los que revisa la noche. Se agregan en la lista de la revisión de dependencias.', (ex.productos || []).map(function (p) { return { producto: p.producto, origen: p.origen === 'deployments' ? 'Despliegues' : 'revisión de dependencias', repo: p.repo || p.ruta, estado: p.activo === false ? 'apagado' + (p.motivo ? ' (' + p.motivo + ')' : '') : 'activo', edita: p.origen === 'deployments' ? 'sí, en Despliegues' : 'no' }; }), [['producto', 'Producto'], ['origen', 'De dónde sale'], ['repo', 'Repo'], ['estado', 'Estado'], ['edita', 'Se cambia acá']], 'productos');
    if (ex.productosMotivo) prod.appendChild(aviso('bad', 'La lista de productos no se pudo leer: los de la revisión de dependencias no se muestran.', ex.productosMotivo));
    if (ex.productosEnlace) prod.appendChild(el('p', {}, el('a', { class: 'enlace-fuerte', href: ex.productosEnlace, text: 'Abrir la lista de la revisión de dependencias →' })));
    mirar.appendChild(prod);
    var ver = tablaDeMirar('Qué versión del arnés tiene cada máquina', 'La que informó cada una con su última corrida. Se actualizan solas al arrancar.', (ex.versiones || []).map(function (v) { return { maquina: v.maquina, persona: v.persona || 'sin confirmar', version: v.version, dia: v.diaTexto, texto: v.texto }; }), [['maquina', 'Máquina'], ['persona', 'Persona'], ['version', 'Versión'], ['dia', 'Última noticia'], ['texto', 'Estado']], 'versiones');
    if (ex.versionesMotivo) ver.appendChild(aviso('bad', 'No se pudo leer lo que informan las máquinas: la versión de cada una no se sabe.', ex.versionesMotivo));
    mirar.appendChild(ver);
    partes.push(mirar);
    app.replaceChildren.apply(app, partes);
  }
  function cargar() {
    return api('').then(function (r) {
      if (!r.ok) { app.replaceChildren(el('div', { class: 'msg bad' }, el('b', { text: 'No se pudo leer la configuración.' }), el('span', { text: r.message || '' }))); return; }
      S.secciones = r.secciones; S.extras = r;
      r.secciones.forEach(function (s) { S.borradores[s.id] = copia(s.borrador === undefined ? {} : s.borrador); S.problemas[s.id] = s.problems || []; S.textos[s.id] = null; S.avisos[s.id] = s.avisos || []; });
      render();
    });
  }
  cargar().catch(function (e) { app.replaceChildren(el('div', { class: 'msg bad' }, el('b', { text: 'No pude cargar la pestaña.' }), el('span', { text: e.message }))); });
})();
`;
}

module.exports = {
  SECCIONES, seccionPorId, loadReader, lectorSabe, formatJson, remoteOf, TEAM_REPOS_SINCE, versionAtLeast, profileGateProblem,
  thresholdsParse, aplicarSeccion, revisar, versionesDeMaquinas, paridadPorProducto, ramaDePropuesta, tituloDePropuesta, cuerpoDePropuesta, pantalla,
  SIN_NOTICIAS_DIAS,
};
