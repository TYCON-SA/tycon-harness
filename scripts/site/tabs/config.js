'use strict';
/*
 * tabs/config.js — LA PESTAÑA CONFIGURACIÓN DEL SITIO DE LA ORGANIZACIÓN.
 *
 * Qué resuelve: quien mantiene el arnés en una organización configura lo de la organización desde el sitio —dónde vive
 * cada repo, a quién se asignan avisos y pedidos, los despliegues, el canal del aviso, personas y máquinas, el sitio
 * mismo, los umbrales y las diferencias declaradas de la paridad— con las MISMAS validaciones que usa el arnés, y cada
 * cambio se propone con una rama y un pedido al repo que corresponde (nunca se escribe la rama principal). No toca la
 * configuración de ninguna máquina; muestra, de sólo lectura, los productos y la versión del arnés de cada máquina.
 *
 * QUIÉN ENTRA: todas las rutas se registran en la tabla de rutas del sitio como `maintainer` (un dev recibe 403 sin
 * un dato; sin sesión, lo que manda el sitio). Cada ESCRITURA exige, en este orden: el `Origin` del sitio (o, sin `Origin`,
 * `Sec-Fetch-Site: same-origin`), `X-Site-Token` igual al token de la sesión (doble envío: nace con la sesión en la
 * cookie firmada y la página lo recibe en un `<meta>`), `Content-Type` JSON y un cuerpo de hasta 256 KB. Ninguna falta
 * crea nada en ningún repo.
 *
 * LO QUE LEE: los clones que mantienen las fuentes del sitio (`fuentes.clones()`): el de operaciones y, con
 * `SITE_PROFILE_REPO`, el del perfil; el espejo del buzón (`fuentes.dirBuzon`) para las versiones. Las secciones, sus
 * lectores y la revisión viven en scripts/lib/org-config.js (el núcleo común con la página local); la propuesta, en
 * scripts/lib/repo-proposal.js. «Descargar el archivo» no es una ruta: el navegador lo arma con lo que «Revisar» validó.
 *
 * Rutas: GET /configuracion (la página) · GET /static/config.js (su código, sin nada en línea) · GET /api/config (las
 * secciones) · POST /api/config/revisar · POST /api/config/stages (la propuesta de stages, sólo lee) ·
 * POST /api/config/proponer · GET /api/config/propuesta (si el pedido de una propuesta ya existe, por su marca) ·
 * GET /api/config/repo · POST /api/config/repo/revisar · POST /api/config/repo/proponer (la sección por repo: el
 * `advisors.yaml` de cada repo de producto, con las claves de `ORG.CLAVES_DEL_REPO`).
 * Casos: scripts/tests/site-config.test.js y scripts/tests/site-propose.test.js.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ORG = require('../../lib/org-config.js');
const RP = require('../../lib/repo-proposal.js');
const people = require('../../lib/people.js');
const access = require('../access.js');
const { esc } = require('../../nightly/dashboard/common.js');
const { FICHAS: FICHAS_DEL_SITIO } = require('./cards.js');
const views = require('../views.js');
const TX = require('../texts.js');
// los mensajes se arman en castellano (así los guarda el caché y los compara la página local) y se dicen en el idioma
// del pedido al salir de cada ruta (texts.js, `traducirRespuesta`)
const M = (clave, valores) => TX.t('es', clave, valores);
const { dentroDe } = require('../sources.js');
const LANG = require('../language.js');

const TREE = path.join(__dirname, '..', '..', '..');
const CUERPO_MAX = 256 * 1024;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// lo armado de la pestaña vale, a lo sumo, lo que el refresco de fondo de los datos
const VIGENCIA_MS = 15 * 60 * 1000;
const norm = (c) => String(c || '').trim().toLowerCase();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// la lista de quién entra: los correos de quienes mantienen, con la regla de people.js
const mantenedoresDe = (site) => people.listaDeAcceso({ site }).entradas.filter((e) => e.role === 'maintainer').flatMap((e) => e.emails);
const SIN_MANTENEDORES = M('config.sinMantenedores');
const json = (status, obj) => ({ status, tipo: 'application/json; charset=utf-8', cuerpo: JSON.stringify(obj) });
const rechazo = (status, message) => json(status, { ok: false, message });

/**
 * Un archivo de un clon: `{ estado: 'leido', texto, oid }` · `{ estado: 'nuevo' }` · `{ estado: 'ilegible', motivo }`.
 * Con la copia de operaciones la carpeta no tiene git: la versión de cada archivo la dice el `indice` de la foto.
 */
function leer(dir, rel, indice = null) {
  const ruta = path.join(dir, rel);
  let texto;
  try {
    if (fs.existsSync(ruta) && !dentroDe(dir, ruta)) return { estado: 'ilegible', motivo: M('config.noEsDelRepo', { rel }) };
    texto = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { estado: 'nuevo' };
    return { estado: 'ilegible', motivo: M('config.noSePudoLeer', { rel, codigo: (e && e.code) || 'error' }) };
  }
  if (indice) {
    const oid = isObject(indice.archivos) ? indice.archivos[rel] : null;
    if (typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/.test(oid)) return { estado: 'ilegible', motivo: M('config.copiaSinVersion', { rel }) };
    return { estado: 'leido', texto, oid };
  }
  const r = spawnSync('git', ['-C', dir, 'rev-parse', `HEAD:${rel}`], { encoding: 'utf8', windowsHide: true });
  // sin la versión del archivo, «Proponer» no puede saber si cambió: se dice, no se sigue con null
  if (r.status !== 0) return { estado: 'ilegible', motivo: M('config.gitSinVersion', { rel }) };
  return { estado: 'leido', texto, oid: r.stdout.trim() };
}
const docDe = (t) => { try { const v = JSON.parse(t); return isObject(v) ? v : null; } catch { return null; } };
/** El archivo de una sección en un clon: el de hoy, o el de antes (`archivoViejo`) si el repo todavía sólo trae ése. */
const archivoDe = (s, dir) => (s.archivoViejo && dir && !fs.existsSync(path.join(dir, s.archivo)) && fs.existsSync(path.join(dir, s.archivoViejo)) ? s.archivoViejo : s.archivo);
/**
 * Las herramientas de horas que trae el árbol del sitio, de sus manifiestos (`integrations/<n>/integration.json`, kind
 * `timeTracking`): `[{ name, label, url, token }]`. `url`: si pide la dirección de su instancia en el perfil; `token`: el
 * comando con que cada persona pone el suyo en su máquina (nunca se pide acá). Un manifiesto roto no se ofrece: se dice en
 * `problemas`, igual que la biblioteca que no carga (la pantalla los muestra, en vez de un selector mudo).
 */
function herramientasDeHoras() {
  let INT;
  try { INT = require(path.join(TREE, 'scripts', 'lib', 'integrations.js')); } catch (e) {
    return { horas: [], problemas: [M('config.horasSinBiblioteca', { motivo: (e && e.code) || (e && e.message) || 'error' })] };
  }
  const l = INT.listManifests({ dir: path.join(TREE, 'integrations') });
  const horas = l.manifests.filter((m) => m.kind === 'timeTracking').map((m) => {
    const secreto = m.settings.find((x) => x.type === 'secreto');
    // la dirección de la instancia va en `integrations.<nombre>.url`, la hoja que la sección sabe cambiar
    return { name: m.name, label: m.label, url: m.settings.some((x) => x.type === 'url' && x.from === 'profile' && x.key === `integrations.${m.name}.url`), token: secreto ? `harness.js config set ${secreto.key}` : null };
  });
  return { horas, problemas: l.problems.map((b) => M('config.horasManifiestoRoto', { nombre: b.name, motivo: b.reasons.join('; ') })) };
}
/** Los conectores de plataforma que trae el árbol del sitio (`kind: platform`): `[{ name, label }]`; ninguno si no se leen. */
function conectoresDePlataforma() {
  try {
    const INT = require(path.join(TREE, 'scripts', 'lib', 'integrations.js'));
    return INT.listManifests({ dir: path.join(TREE, 'integrations') }).manifests.filter((m) => m.kind === 'platform').map((m) => ({ name: m.name, label: m.label }));
  } catch (_) { return []; }
}
/** Los paquetes legibles de las carpetas `packs/` del árbol y del clon del perfil (la capa del equipo trae los suyos). */
function paquetesLegibles(perfilDir) {
  const out = [];
  for (const raiz of [TREE, perfilDir].filter(Boolean)) {
    try { out.push(...require('../../lib/pack-pieces.js').listPacks(path.join(raiz, 'packs')).packs); } catch { /* sin paquetes legibles ahí */ }
  }
  return out;
}
/** Los paquetes que trae esta versión del sitio o el perfil del equipo, y los que activa un valor de `packs.default`. */
function paquetesDe(valor, perfilDir) {
  const instalados = [...new Set(paquetesLegibles(perfilDir).map((p) => p.name))].sort();
  const activos = valor === 'all' ? instalados : Array.isArray(valor) ? instalados.filter((n) => valor.includes(n)) : [];
  return { instalados, activos };
}

/**
 * Cómo contesta el asistente según el perfil: `{ vigente: { language, style, max_chars }, origen }`. Lo que
 * el perfil no dice sale de lo que hace el lector de la máquina sin valor (su `DEFAULTS` y el tope de cada estilo).
 */
function respuestaVigente(lector, doc) {
  const r = doc && isObject(doc.response) ? doc.response : {};
  const def = (lector && lector.DEFAULTS) || {};
  const topes = (lector && lector.TOPE_POR_ESTILO) || {};
  const language = r.language || def['response.language'] || null;
  const style = r.style || def['response.style'] || null;
  const max = Number.isInteger(r.max_chars) ? r.max_chars : (topes[style] || null);
  return {
    vigente: { language, style, max_chars: max },
    origen: { language: r.language ? 'perfil' : 'por defecto', style: r.style ? 'perfil' : 'por defecto', max_chars: Number.isInteger(r.max_chars) ? 'perfil' : 'del estilo' },
  };
}
/**
 * Los revisores que conoce esta versión y el perfil del equipo: los de `agents/*.md` del árbol y del clon del perfil, y
 * los de sus paquetes (`reviewers` de cada pack.json), sin repetir y ordenados. Para elegir el modelo de un revisor por
 * nombre y no escribirlo a mano.
 */
// las herramientas que la puerta de pruebas corre por dentro, con su propia lógica: se muestran, no se cambian
const RUNNERS_INTERNOS = Object.freeze(['dotnet', 'vitest', 'jest', 'node']);
/**
 * Las terminaciones que el arnés ya cuenta como código, por lenguaje, del mismo lector que usan los controles
 * (`code-files.js` de la skill, buscado por su archivo); `null` si esta versión no lo trae: la pantalla no las inventa.
 */
function terminacionesQueReconoce() {
  let skills = [];
  try { skills = fs.readdirSync(path.join(TREE, 'skills')).sort(); }
  catch (e) { return { lista: null, motivo: `no pude listar las skills de esta versión (${(e && e.code) || 'error'})` }; }
  let motivo = 'esta versión del arnés no trae la lista de terminaciones';
  for (const n of skills) {
    const f = path.join(TREE, 'skills', n, 'scripts', 'lib', 'code-files.js');
    if (!fs.existsSync(f)) continue;
    try { const c = require(f); if (typeof c.byLanguage === 'function') return { lista: c.byLanguage(), motivo: null }; }
    catch (e) { motivo = `no pude leer la lista de terminaciones (${String((e && e.message) || e).split('\n')[0]})`; }
  }
  return { lista: null, motivo };
}
/** Lo de fábrica para la sección «Tu tecnología»; sin la tabla en esta versión, `fabrica: null` y el motivo. */
function tecnologiaDeFabrica() {
  try {
    // la skill que la trae se busca por su archivo, como los modelos de hoy (org-config.js, buscarModelosDeHoy)
    let skills = [];
    try { skills = fs.readdirSync(path.join(TREE, 'skills')).sort(); } catch (_) { skills = []; }
    for (const n of skills) {
      const f = path.join(TREE, 'skills', n, 'scripts', 'lib', 'test-runners.js');
      if (!fs.existsSync(f)) continue;
      const t = require(f);
      if (typeof t.factoryTable === 'function') return { fabrica: t.factoryTable(), internos: RUNNERS_INTERNOS };
    }
    return { fabrica: null, internos: RUNNERS_INTERNOS, motivo: 'esta versión del arnés no trae la lista de fábrica' };
  } catch (e) {
    return { fabrica: null, internos: RUNNERS_INTERNOS, motivo: `no pude leer la lista de fábrica (${(e && e.message) || e})` };
  }
}
function revisoresDelArbol(perfilDir) {
  const ids = new Set();
  for (const raiz of [TREE, perfilDir].filter(Boolean)) {
    try { for (const f of fs.readdirSync(path.join(raiz, 'agents'))) if (/^[a-z0-9-]+\.md$/.test(f)) ids.add(f.slice(0, -3)); } catch { /* sin carpeta: ninguno de ahí */ }
  }
  for (const p of paquetesLegibles(perfilDir)) {
    let doc = null; try { doc = JSON.parse(fs.readFileSync(p.file, 'utf8')); } catch { continue; }
    for (const r of Array.isArray(doc && doc.reviewers) ? doc.reviewers : []) if (r && typeof r.agent === 'string' && /^[a-z0-9-]+$/.test(r.agent)) ids.add(r.agent);
  }
  return [...ids].sort();
}

/**
 * Los mismos revisores, agrupados: los del arnés (`paquete: null`) y los de cada paquete, en el orden de su pack.json.
 * Cada uno con su modelo de fábrica, el `model:` de su archivo (como lo lee models.js), para que la pantalla diga qué
 * nivel toma sin que la organización lo elija.
 */
function revisoresPorPaquete(perfilDir) {
  const raices = [TREE, perfilDir].filter(Boolean);
  // { fabrica, ilegible }: sin archivo en una raíz se busca en la otra; un archivo que está y no se puede leer se dice
  const deFabrica = (id) => {
    let ilegible = false;
    for (const raiz of raices) {
      try {
        const fm = (fs.readFileSync(path.join(raiz, 'agents', `${id}.md`), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
        const m = (fm.match(/^model:\s*["']?([\w.-]+)/m) || [])[1];
        if (['haiku', 'sonnet', 'opus', 'fable'].includes(m)) return { fabrica: m };
      } catch (e) { if (!e || e.code !== 'ENOENT') ilegible = true; }
    }
    return ilegible ? { fabrica: null, ilegible: true } : { fabrica: null };
  };
  const revisor = (id) => ({ id, ...deFabrica(id) });
  const grupos = []; const vistos = new Set();
  for (const p of paquetesLegibles(perfilDir)) {
    // un paquete que no se puede leer va igual, vacío y marcado: la pantalla dice que no pudo leer su lista
    let doc = null; try { doc = JSON.parse(fs.readFileSync(p.file, 'utf8')); } catch { grupos.push({ paquete: p.name, ilegible: true, revisores: [] }); continue; }
    const ids = (Array.isArray(doc && doc.reviewers) ? doc.reviewers : []).map((r) => r && r.agent).filter((id) => typeof id === 'string' && /^[a-z0-9-]+$/.test(id) && !vistos.has(id));
    ids.forEach((id) => vistos.add(id));
    if (ids.length) grupos.push({ paquete: p.name, revisores: ids.map(revisor) });
  }
  // los del arnés y, aparte, los que trae sólo el perfil del equipo (los propios de la organización)
  const delArbol = new Set(revisoresDelArbol(null));
  const todos = revisoresDelArbol(perfilDir).filter((id) => !vistos.has(id));
  const propios = todos.filter((id) => !delArbol.has(id));
  if (propios.length) grupos.unshift({ paquete: null, propios: true, revisores: propios.map(revisor) });
  const nucleo = todos.filter((id) => delArbol.has(id));
  if (nucleo.length) grupos.unshift({ paquete: null, revisores: nucleo.map(revisor) });
  return grupos;
}

/**
 * Qué trae cada perfil de instalación, leído de install-effects.json del árbol y de los hooks de sus integraciones (los
 * textos de cada uno están en su manifiesto): `profiles` de cada entrada.
 */
function perfilesDeInstalacion() {
  try {
    const archivo = JSON.parse(fs.readFileSync(path.join(TREE, 'scripts', 'setup', 'install-effects.json'), 'utf8')).effects || [];
    // un árbol anterior, sin el lector de los manifiestos: sólo el archivo
    let ints = [];
    let faltan = [];
    const lector = path.join(TREE, 'scripts', 'setup', 'harness', 'managed.js');
    if (fs.existsSync(lector)) { const MG = require(lector); if (typeof MG.manifestEffects === 'function') ({ entries: ints, problems: faltan } = MG.manifestEffects(TREE)); }
    const lista = archivo.concat(ints);
    // cada pieza con lo que la pantalla muestra: el título y su grupo, el detalle, si viene prendida y dónde se cambia;
    // las piezas con el mismo título y el mismo detalle (un hook en dos eventos) van una vez; `en` lleva su inglés, y la
    // pantalla elige el idioma (así la respuesta guardada es una sola)
    const ficha = (e) => ({ title: e.title, group: e.group, does: e.does, default: e.default, when: e.when, switch: e.switch || null, site_section: e.site_section || null, site_pending: e.site_pending || null, en: isObject(e.en) ? e.en : null });
    const de = (p) => {
      const vistas = new Set();
      return lista.filter((e) => isObject(e) && Array.isArray(e.profiles) && e.profiles.includes(p) && typeof e.does === 'string' && typeof e.title === 'string')
        .map(ficha).filter((f) => { const k = `${f.title}\0${f.does}`; if (vistas.has(k)) return false; vistas.add(k); return true; });
    };
    // una integración que no se pudo leer no está en las listas: se dice
    return { minimal: de('minimal'), full: de('full'), motivo: faltan.length ? faltan.join(' · ') : null };
  } catch (e) { return { minimal: [], full: [], motivo: M('config.sinEfectos', { codigo: (e && e.code) || 'error' }) }; }
}
/** Lo que trae la organización en el repo del perfil: skills, revisores, guías de alta y paquetes. */
const CONTENIDO = [['agents', M('config.tipoRevisor'), (d, f) => f.endsWith('.md')], ['onboarding', M('config.tipoGuia'), (d, f) => f.endsWith('.md')], ['packs', M('config.tipoPaquete'), (d, f) => fs.existsSync(path.join(d, f, 'pack.json'))]];
// las skills: una carpeta con SKILL.md, hasta tres niveles bajo skills/ (`skills/<s>`, `skills/<grupo>/<s>`,
// `skills/projects/<cliente>/<s>`), como las acepta la capa del equipo
const PROFUNDIDAD_SKILLS = 3;
function skillsDe(raiz, rel, nivel, out, enlace) {
  let nombres = [];
  try { nombres = fs.readdirSync(path.join(raiz, rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch (e) {
    if (e && e.code !== 'ENOENT') out.push({ tipo: M('config.carpetaIlegible', { tipo: 'skill', codigo: e.code || 'error' }), ruta: rel, enlace: null });
    return;
  }
  for (const n of nombres) {
    const r = `${rel}/${n}`;
    if (fs.existsSync(path.join(raiz, r, 'SKILL.md'))) out.push({ tipo: 'skill', ruta: r, enlace: enlace(r.split('/').map(encodeURIComponent).join('/')) });
    else if (nivel < PROFUNDIDAD_SKILLS) skillsDe(raiz, r, nivel + 1, out, enlace);
  }
}
function contenidoDelPerfil(dir, enlace) {
  if (!dir) return null;
  const out = [];
  skillsDe(dir, 'skills', 1, out, enlace);
  for (const [carpeta, tipo, es] of CONTENIDO) {
    let nombres = [];
    // una carpeta que no está es «no trae»; una que está y no se deja leer se dice (no es lo mismo que vacía)
    try { nombres = fs.readdirSync(path.join(dir, carpeta)).sort(); } catch (e) {
      if (e && e.code !== 'ENOENT') out.push({ tipo: M('config.carpetaIlegible', { tipo, codigo: e.code || 'error' }), ruta: carpeta, enlace: null });
      continue;
    }
    // el enlace lleva cada parte de la ruta escapada: un nombre con «?» o «#» no rompe la dirección
    for (const f of nombres) if (es(path.join(dir, carpeta), f)) out.push({ tipo, ruta: `${carpeta}/${f}`, enlace: enlace(`${carpeta}/${encodeURIComponent(f)}`) });
  }
  return out;
}

// ── el resumen de lo que cambia una propuesta ──
/** Las hojas de un valor: la ruta de cada valor escalar (y de cada lista u objeto vacío) y lo que vale. */
function hojasDe(valor, ruta, out) {
  if (isObject(valor) && Object.keys(valor).length) for (const k of Object.keys(valor)) hojasDe(valor[k], ruta ? `${ruta}.${k}` : k, out);
  else if (Array.isArray(valor) && valor.length) valor.forEach((x, i) => hojasDe(x, `${ruta}.${i}`, out));
  else out.set(ruta, valor);
  return out;
}
// los valores con nombre propio: la ruta de la hoja y el texto de la pantalla con que se la llama
const ETIQUETAS = { 'response.max_chars': 'pantalla.largoMaximoDeProsaEn' };
// el título que la pantalla le pone a cada sección sale de su propio código (`PLANO`), para que el resumen diga lo mismo
let clavesDeTitulo = null;
function tituloVisible(s, idioma) {
  if (!clavesDeTitulo) {
    clavesDeTitulo = {};
    const rx = /\n\s+([a-z]+): \{ t: T\('(pantalla\.[A-Za-z0-9]+)'\)/g;
    const fuente = ORG.pantalla.toString();
    let m;
    while ((m = rx.exec(fuente))) clavesDeTitulo[m[1]] = m[2];
  }
  return clavesDeTitulo[s.id] ? TX.t(idioma, clavesDeTitulo[s.id]) : s.titulo;
}
/**
 * Las frases de lo que cambia una sección, en el idioma pedido: quién se suma o se saca de la lista de acceso, cada valor
 * con nombre propio, y «Cambiás N valores» para el resto. `antes` y `despues` son los archivos enteros, ya leídos.
 */
function resumenDe(s, antes, despues, idioma) {
  const dec = (clave, valores) => TX.t(idioma, clave, valores);
  const seccion = tituloVisible(s, idioma);
  const frases = [];
  const aparte = [];
  if (s.id === 'sitio') {
    const c = people.cambiosDeAcceso(antes, despues);
    for (const x of c.altas) frases.push(dec('config.resumenSuma', { correo: x.email, rol: x.role, seccion }));
    for (const x of c.bajas) frases.push(dec('config.resumenSaca', { correo: x.email, seccion }));
    for (const x of c.roles) frases.push(dec('config.resumenRol', { correo: x.email, de: x.de, a: x.a, seccion }));
    aparte.push('site.access', 'site.maintainers');
  }
  const ha = hojasDe(antes, '', new Map());
  const hd = hojasDe(despues, '', new Map());
  const mostrar = (v) => (v === undefined ? dec('config.resumenSinValor') : String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 80));
  let sueltos = 0;
  for (const k of [...new Set([...ha.keys(), ...hd.keys()])]) {
    if (!k || JSON.stringify(ha.get(k)) === JSON.stringify(hd.get(k)) || aparte.some((p) => k === p || k.startsWith(`${p}.`))) continue;
    if (ETIQUETAS[k]) frases.push(dec('config.resumenCambia', { etiqueta: dec(ETIQUETAS[k]).split(' (')[0], antes: mostrar(ha.get(k)), despues: mostrar(hd.get(k)) }));
    else sueltos += 1;
  }
  if (sueltos) frases.push(sueltos === 1 ? dec('config.resumenUnValor', { seccion }) : dec('config.resumenValores', { n: sueltos, seccion }));
  return frases;
}

// ── las marcas de las propuestas ──
// cada propuesta lleva una marca (16 bytes al azar, en 32 caracteres hexadecimales en minúscula)
const FORMA_DE_MARCA = RP.FORMA_DE_MARCA;
// cuántas propuestas terminadas recuerda el sitio, con su respuesta
const MARCAS_RECORDADAS = 200;
// «releé ya» (`GET /api/config?releer=1`): una relectura a la vez y no más de una cada RELECTURA_MS, para que muchas
// páginas abiertas no golpeen el repo
const RELECTURA_MS = 30 * 1000;
// después de aplicar solo, cuánto espera la respuesta al refresco antes de decir «se ve en el próximo refresco»
const ESPERA_REFRESCO_MS = 8 * 1000;

/**
 * Las rutas de la pestaña, para `rutasExtra` de crearSitio. `cfg` es la del servidor; `fuentes`, las del sitio.
 * Inyectables (pruebas): `lectores`, `versionImagen`, `ahora`, `hoy`, `fetch`, `urlBase` (la dirección de la API de cada plataforma) y
 * `remotos` ({ operaciones, perfil }: la plataforma de cada repo cuando la dirección no la dice) y `esperaRefrescoMs`.
 * `demo` (el sitio demo, demo.js): Proponer, Invitar y Revocar revisan como siempre y muestran lo que pasaría, sin abrir nada.
 */
function crearRutas({ cfg, fuentes, versionImagen = null, ahora = Date.now, hoy = null, lectores = {}, fetch = globalThis.fetch, urlBase = {}, remotos = {}, log = () => {}, esperaRefrescoMs = ESPERA_REFRESCO_MS, invitaciones = null, clavesDelRepo = ORG.CLAVES_DEL_REPO, urlDeProducto = ORG.urlDeRepo, demo = false, repoDeEjemplo = null }) {
  const dia = () => (hoy ? hoy() : new Date(ahora()).toISOString().slice(0, 10));
  const lector = (nombre) => ORG.loadReader(TREE, nombre, lectores);
  // los umbrales del arnés (los de la imagen): `{ thresholds, motivo }`; sin ellos, Umbrales no edita y lo dice
  const arnes = () => {
    let texto = null;
    try { texto = fs.readFileSync(path.join(TREE, 'scripts', 'nightly', 'dashboard', 'sources.json'), 'utf8'); } catch (e) { return { thresholds: {}, motivo: M('config.sinSources', { codigo: (e && e.code) || 'error' }) }; }
    const d = docDe(texto);
    return d && isObject(d.thresholds) ? { thresholds: d.thresholds, motivo: null } : { thresholds: {}, motivo: M('config.sourcesSinUmbrales') };
  };
  const clones = () => (typeof fuentes.clones === 'function' ? fuentes.clones() : { operaciones: null, perfil: null });
  /** `leer` con la versión del índice cuando `dir` es la carpeta de la copia de operaciones. */
  // el clon (o la carpeta de la copia, o la del sitio demo) con su índice de versiones lee sin git
  const leerDe = (dir, rel) => { const cl = clones(); const o = [cl.operaciones, cl.perfil].find((x) => x && x.dir === dir && x.indice); return leer(dir, rel, o ? o.indice : null); };
  const urlDe = (repo) => (repo === 'perfil' ? cfg.profileRepo : cfg.operationsRepo);
  const remoteDe = (repo) => remotos[repo] || ORG.remoteOf(urlDe(repo));

  // ── la defensa de las escrituras ──
  const escritura = (ctx) => defensaDeEscritura(cfg, ctx);

  // ── la vista de una sección ──
  function contextoPersonas(doc) {
    const pers = typeof fuentes.personas === 'function' ? fuentes.personas() : null;
    return { c: people.contexto({ operations: doc || {}, informados: pers && isObject(pers.informados) ? pers.informados : null }), informados: pers && isObject(pers.informados) ? pers.informados : null, pers };
  }

  function vista(s) {
    const base = { id: s.id, titulo: s.titulo, archivo: s.archivo, repo: s.repo, lector: s.lector, estado: 'cargado', motivo: null, soloLectura: false, borrador: {}, problems: [], avisos: [], texto: null, oid: null };
    const cl = clones();
    let dir = null;
    if (s.repo === 'perfil') {
      // `falta`: lo que hay que poner, dicho corto para la lista de secciones («falta el repo del perfil»)
      if (!cfg.profileRepo || !cl.perfil) return { ...base, estado: 'no_configurado', falta: M('config.elRepoDelPerfil'), motivo: M('config.faltaPerfil', { archivo: s.archivo }) };
      // todavía bajándose (el primer refresco después de arrancar): no es «sin configurar», y se dice
      if (!cl.perfil.dir && cl.perfil.estado === 'pendiente') return { ...base, estado: 'bajando', motivo: cl.perfil.motivo || M('config.perfilBajando') };
      if (!cl.perfil.dir) return { ...base, estado: 'no_configurado', motivo: cl.perfil.motivo || M('config.perfilSinBajar') };
      dir = cl.perfil.dir;
    } else {
      if (!cl.operaciones) return { ...base, estado: 'ilegible', motivo: M('config.opsSinBajar') };
      dir = cl.operaciones.dir;
    }
    base.archivo = archivoDe(s, dir);
    const a = leerDe(dir, base.archivo);
    if (a.estado === 'ilegible') return { ...base, estado: 'ilegible', motivo: M('config.seCorrigeAMano', { motivo: a.motivo }) };
    const doc = a.estado === 'leido' ? docDe(a.texto) : null;
    const v = { ...base, texto: a.texto || null, oid: a.estado === 'leido' ? a.oid : null };

    if (s.id === 'umbrales') {
      const ar = arnes();
      const th = ar.thresholds;
      if (ar.motivo) return { ...v, soloLectura: true, motivo: M('config.sinUmbralesDelArnes', { motivo: ar.motivo }), borrador: doc && isObject(doc.thresholds) ? doc.thresholds : {} };
      if (a.estado === 'nuevo') return { ...v, soloLectura: true, motivo: M('config.sinSourcesDeLaOrg'), borrador: th };
      const marca = leerDe(dir, '.dashboard/applied-config.json');
      const aplicado = marca.estado === 'leido' ? docDe(marca.texto) : null;
      if (marca.estado === 'ilegible' || (marca.estado === 'leido' && !aplicado)) return { ...v, soloLectura: true, motivo: M('config.marcaIlegible'), borrador: doc && isObject(doc.thresholds) ? doc.thresholds : th };
      const r = ORG.thresholdsParse(a.texto, { arnes: { thresholds: th }, tree: TREE });
      const borrador = doc && isObject(doc.thresholds) ? doc.thresholds : th;
      if (!aplicado || !isObject(aplicado.files) || !aplicado.files[s.archivo]) return { ...v, soloLectura: true, motivo: M('config.nocturnoNoLee'), borrador, avisos: r.avisos || [] };
      if (r.soloLectura) return { ...v, soloLectura: true, motivo: r.problems[0].message, borrador };
      return { ...v, borrador, problems: r.problems, avisos: r.avisos || [] };
    }

    if (s.id === 'paridad') {
      if (a.estado === 'nuevo') return { ...v, estado: 'no_configurado', motivo: M('org.paridadSinLista'), vista: ORG.paridadPorProducto({ lista: null }) };
      if (!doc) return { ...v, estado: 'ilegible', motivo: M('config.paridadIlegible') };
      const res = leerDe(dir, `.dashboard/paridad/paridad-${dia()}.json`);
      const leido = res.estado === 'leido' ? docDe(res.texto) : null;
      const vp = ORG.paridadPorProducto({ lista: doc, resultado: leido, hoy: dia(), resultadoIlegible: res.estado === 'ilegible' || (res.estado === 'leido' && !leido) });
      if (vp.estado === 'sin_productos' || vp.estado === 'sin_lista') return { ...v, estado: 'no_configurado', motivo: vp.texto, vista: vp };
      if (!lector('check-product-parity.js')) return { ...v, estado: 'no_reader', motivo: M('org.noLeeDeclaradas'), vista: vp };
      return { ...v, vista: vp, borrador: {} };
    }

    const lec = lector(s.lector);
    // la marca es una parte de site que un lector anterior no conoce: la sección dice qué parte
    if (s.id === 'organizacion' && !(Array.isArray(lec.SITE_KEYS) && lec.SITE_KEYS.includes('brand'))) return { ...base, estado: 'no_reader', motivo: M('config.noLeeMarca') };
    if (!ORG.lectorSabe(lec, s)) return { ...base, estado: 'no_reader', motivo: M('org.noLee', { que: `${s.archivo}${s.claves ? ` → ${(s.rutas && s.rutas.length === 1 ? s.rutas : s.claves).join(', ')}` : ''}` }) };
    if (a.estado === 'nuevo') v.estado = 'nuevo';
    // Personas tiene su propia regla con el archivo roto (abajo): el último bueno 24 horas
    else if (!doc && s.id !== 'personas') return { ...v, estado: 'ilegible', motivo: M('org.noEsObjeto', { archivo: s.archivo }) };
    const parsed = a.estado === 'leido' ? lec.parse(a.texto) : { ok: true, problems: [] };
    v.problems = (parsed.problems || []).filter((p) => !s.claves || s.claves.some((k) => p.path === k || String(p.path).startsWith(`${k}.`)));
    // lo que el lector da aparte sin anular el archivo (un modelo mal escrito) se ve en su sección
    if (s.claves) v.problems.push(...ORG.problemasDeSeccion(s, parsed, null, null));
    v.borrador = s.claves === null ? clone(doc || { version: 1 }) : Object.fromEntries(s.claves.filter((k) => doc && doc[k] !== undefined).map((k) => [k, clone(doc[k])]));
    if (s.id === 'sitio') v.campos = { url: Array.isArray(lec.SITE_KEYS) && lec.SITE_KEYS.includes('url') };
    // la marca es una parte de site que un lector anterior no conoce: la sección dice «todavía no sabe leer»
    if (s.id === 'organizacion' && !(Array.isArray(lec.SITE_KEYS) && lec.SITE_KEYS.includes('brand'))) return { ...base, estado: 'no_reader', motivo: M('config.noLeeMarca') };
    if (s.id === 'modelos') { const hoy = ORG.modelosDeHoy(TREE); v.extras = { hoy, motivoHoy: hoy ? null : ORG.motivoDeHoy(TREE), revisores: revisoresDelArbol(cl.perfil && cl.perfil.dir), porPaquete: revisoresPorPaquete(cl.perfil && cl.perfil.dir) }; const eq = ORG.equivalenciasDe(TREE); v.extras.equivalencias = eq.equivalencias; v.extras.motivoEquivalencias = eq.motivo; v.extras.proveedores = ORG.proveedoresDe(TREE); }
    // lo guardado con nombres de Claude se carga en niveles; el original también, así abrir no es un cambio y
    // el próximo «Proponer» de la sección lo escribe con niveles
    if (s.id === 'modelos' && v.borrador.models !== undefined) v.borrador.models = ORG.modelosEnNiveles(v.borrador.models, lec);
    // un trabajo declarado por encima del tope se marca al cargar (y «revisar» no lo deja proponer); los repos
    // sin pipeline dicen qué pasa, con la misma respuesta que da el lector al merge
    if (s.id === 'modelos' && doc) v.problems.push(...ORG.problemasDelTope(s, lec, doc));
    if (s.id === 'suites') v.extras = { sinPipeline: ORG.sinPipelinePorRegla(lec), queHace: ORG.queHacePorRegla(lec) };
    if (s.id === 'integraciones') { const h = herramientasDeHoras(); v.extras = { horas: h.horas, horasProblemas: h.problemas, plataformas: conectoresDePlataforma() }; }
    // las herramientas de prueba de fábrica de esta versión, para que «Cambiar» arranque desde ellas; las que la puerta
    // corre por dentro se listan sin poder cambiarse
    if (s.id === 'tecnologia') { const rs = reposDeLaOrganizacion(cl.operaciones && cl.operaciones.dir, doc); const tr = terminacionesQueReconoce(); v.extras = { ...tecnologiaDeFabrica(), reconocidas: tr.lista, reconocidasMotivo: tr.motivo, repos: rs.lista, reposMotivo: rs.motivo }; }
    // la lista de fichas es la de este sitio; un lector que no conoce la clave deja la sección en «no sabe leer»
    if (s.id === 'fichas') {
      if (!(Array.isArray(lec.SITE_KEYS) && lec.SITE_KEYS.includes('hidden_cards'))) return { ...base, estado: 'no_reader', motivo: 'esta versión del arnés todavía no sabe leer las fichas que muestra el sitio (site.hidden_cards)' };
      v.extras = { fichas: FICHAS_DEL_SITIO.map((f) => ({ id: f.id, titulo: f.titulo, paraQue: f.paraQue, pestana: f.pestana })) };
    }
    if (s.id === 'sitio') {
      // la lista de quién entra (si el lector la conoce) y con qué se entra, de sólo lectura
      const conAcceso = Array.isArray(lec.SITE_KEYS) && lec.SITE_KEYS.includes('access');
      v.extras = { servicios: Array.isArray(lec.MAILBOX_PROVIDERS) ? lec.MAILBOX_PROVIDERS : null, conAcceso, inicioDeSesion: cfg.inicioDeSesion || null };
      // sin la lista, la sección arranca con la armada con lo de hoy y la propone en lugar de site.maintainers
      const lista = conAcceso && doc && !(isObject(doc.site) && Array.isArray(doc.site.access)) ? people.listaDeAcceso(doc) : null;
      // lo que no se pudo leer queda afuera de la lista: se dice, para que nadie quede sin entrar sin saberlo (también si
      // no quedó nadie y no hay lista para proponer)
      const ojo = lista && lista.descartados ? M('config.ojoCorreos', { n: lista.descartados }) : '';
      if (lista && lista.entradas.length) {
        const site = clone(isObject(doc.site) ? doc.site : {});
        delete site.maintainers;
        site.access = lista.entradas;
        v.borrador = { site };
        v.extras.migracion = ojo ? M('config.migracionYOjo', { ojo }) : M('config.migracion');
      } else if (ojo) v.extras.migracion = ojo;
    }
    // la plataforma, la organización y el proyecto del repo de operaciones: ahí se elige por nombre el pipeline de un despliegue
    if (s.id === 'despliegues') { const r = remoteDe('operaciones') || {}; v.extras = { plataforma: r.platform || null, org: r.org || null, proyecto: r.project || null }; }
    if (s.id === 'paquetes') v.extras = paquetesDe(doc && isObject(doc.packs) ? doc.packs.default : undefined, cl.perfil && cl.perfil.dir);
    // las secciones del perfil que cambian la experiencia de cada dev
    if (s.id === 'respuesta') {
      v.extras = respuestaVigente(lec, doc);
      // con una capa que pide una versión que no lee `response`, se muestra y no se propone
      const capa = leerDe(dir, 'team-layer.json');
      const gate = ORG.teamProfileGateProblem({ layerText: capa.estado === 'leido' ? capa.texto : '', versionImagen, doc: { response: {} } });
      if (gate) { v.soloLectura = true; v.motivo = gate; }
    }
    // con una capa que pide una versión que no lee `approvals`, se muestra y no se propone (como `response`)
    if (s.id === 'aprobaciones') {
      const capa = leerDe(dir, 'team-layer.json');
      const gate = ORG.teamProfileGateProblem({ layerText: capa.estado === 'leido' ? capa.texto : '', versionImagen, doc: { approvals: {} } });
      if (gate) { v.soloLectura = true; v.motivo = gate; }
    }
    if (s.id === 'ado') {
      v.extras = {
        proyecto: M('config.adoProyecto'),
        pedidos: M('config.adoPedidos'),
      };
      if (remoteDe('perfil').platform === 'github') { v.soloLectura = true; v.motivo = M('config.noAplicaGithub'); }
    }
    if (s.id === 'instalacion') v.extras = { perfiles: perfilesDeInstalacion() };
    if (s.id === 'hilos' && !(doc && isObject(doc.site) && isObject(doc.site.mailbox))) {
      v.soloLectura = true; v.motivo = M('config.hilosSinBuzon');
    }
    if (s.id === 'personas') {
      // operations.json que no valida: el último bueno (24 h, la regla de people.js); el sitio frenado ya contesta 503
      let base2 = parsed.ok ? doc : null;
      const est = fuentes.estado();
      const extras = {};
      if (!base2) {
        base2 = fuentes.config();
        if (est.bandaConfig) extras.ultimoBueno = M('config.ultimoBueno', { desde: views.hora(est.bandaConfig.desde), motivo: est.bandaConfig.motivo });
        else { extras.vencido = M('config.peopleVencio'); v.soloLectura = true; v.motivo = extras.vencido; }
        v.borrador = { people: clone((base2 && base2.people) || {}) };
      }
      const { c, informados, pers } = contextoPersonas(base2);
      extras.porConfirmar = informados ? people.maquinasPorConfirmar(c) : [];
      extras.sinActividad = informados ? people.maquinasSinActividad(c) : [];
      const reglas = access.crearReglas({ config: base2, modelo: fuentes.modelo(), personas: pers });
      // Las personas salen de «Quién entra al sitio» (por su primer correo), más quien ya tenga algo declarado: con las
      // máquinas confirmadas, quien todavía no tiene máquina no aparecía. Sin lista de acceso, las de las máquinas.
      const lista = people.listaDeAcceso(base2);
      const deLaLista = lista.origen === 'lista' ? lista.entradas.filter((e) => e.role === 'dev').map((e) => e.emails[0]) : null;
      const candidatos = [...(deLaLista || Object.values(c.machines).filter(isObject).map((e) => norm(e.person))),
        ...Object.keys((base2 && isObject(base2.people) && isObject(base2.people.projects) ? base2.people.projects : {})).filter((k) => !k.startsWith('_')).map(norm)].filter(Boolean);
      const vistos = new Set();
      const correos = [];
      for (const correo of candidatos) {
        const suyos = people.correosDe(correo, c);
        if (suyos.some((x) => vistos.has(x)) || vistos.has(correo)) continue;
        [correo, ...suyos].forEach((x) => vistos.add(x));
        correos.push(correo);
      }
      correos.sort();
      const declarados = (base2 && isObject(base2.people) && isObject(base2.people.projects)) ? base2.people.projects : {};
      extras.personas = correos.map((correo) => {
        // todos sus correos: sus máquinas y lo declarado pueden estar a nombre de cualquiera de ellos
        const suyos = new Set([correo, ...people.correosDe(correo, c)]);
        const suyas = Object.entries(c.machines).filter(([, e]) => isObject(e) && suyos.has(norm(e.person))).map(([m]) => m);
        // la pantalla edita la clave que ya existe (con su grafía), así no crea una segunda para la misma persona
        const clave = Object.keys(declarados).find((k) => !k.startsWith('_') && suyos.has(norm(k))) || correo;
        return { correo, clave, sugeridos: reglas.sugeridosDe(correo), caida: suyas.length > 0 && suyas.every((m) => people.estadoDeMaquina(m, c).estado !== 'confirmada') };
      });
      v.extras = extras;
    }
    return v;
  }

  // la opción de la organización «los cambios de un mantenedor se aplican solos»: la de main, la que el sitio ya leyó,
  // nunca la del cambio que se propone (así prenderla nunca se aplica sola)
  const aplicarSolo = () => { const c = fuentes.config(); return Boolean(c && isObject(c.site) && c.site.auto_apply === true); };

  async function estadoProponer(repo) {
    const cred = cfg.escritura && cfg.escritura[repo];
    if (!cred) return { habilitado: false, motivo: M('config.sinIdentidad') };
    const remote = remoteDe(repo);
    if (!remote.platform) return { habilitado: false, motivo: M('config.sinPlataforma') };
    const una = async (archivo) => {
      try {
        const solo = aplicarSolo();
        const p = await RP.politicaDeRevision({ remote, credencial: cred, urlBase, fetch, archivo, aplicarSolo: solo });
        if (!p.ok) return { habilitado: false, motivo: p.message };
        return solo ? { habilitado: true, motivo: null, aplicaSolo: p.aplicaSolo === true, motivoAplicar: p.motivoAplicar || null } : { habilitado: true, motivo: null };
      } catch (e) { return { habilitado: false, motivo: M('config.sinPolitica', { codigo: (e && e.name) || 'error' }) }; }
    };
    // con una política con filtro de ruta, «Proponer» va archivo por archivo (`porArchivo`, que la
    // pantalla prefiere al estado del repo)
    // también el nombre de antes (`archivoViejo`): un repo que todavía lo usa lee y propone sobre ése, y la pantalla busca el
    // estado con el archivo que resolvió la sección
    const archivos = [...new Set(ORG.SECCIONES.filter((s) => s.repo === repo).flatMap((s) => [s.archivo, s.archivoViejo].filter(Boolean)))];
    const porArchivo = {};
    for (const a of archivos) porArchivo[a] = await una(a);
    const todos = Object.values(porArchivo);
    // con la opción de aplicar solo, el repo entero «se aplica solo» sólo si cada archivo se aplica solo
    const r = todos.length && todos.every((x) => x.habilitado) ? (todos.find((x) => x.aplicaSolo === false) || todos[0]) : (todos.find((x) => !x.habilitado) || await una(null));
    return { ...r, porArchivo };
  }

  /** Los productos: `{ lista, motivo }` — una lista que no se pudo leer lo dice; no es «ningún producto». */
  function productos(dirOps, opsDoc) {
    const out = [];
    const r = dirOps ? leerDe(dirOps, 'scripts/nightly/dependencies/repos.json') : { estado: 'nuevo' };
    const d = r.estado === 'leido' ? docDe(r.texto) : null;
    let motivo = null;
    if (r.estado === 'ilegible' || (r.estado === 'leido' && (!d || !Array.isArray(d.repos)))) motivo = M('config.reposIlegible');
    for (const x of (d && Array.isArray(d.repos) ? d.repos : [])) {
      if (!isObject(x) || typeof x.producto !== 'string') continue;
      out.push({ producto: x.producto, origen: 'dependencias', repo: x.ado || x.github || x.ruta || null, activo: x.activo !== false, motivo: typeof x.motivo === 'string' ? x.motivo : null });
    }
    // la forma de `deployments` es la del lector de despliegues: { provider, products: { "<producto>": { staging, production } } }
    const dep = opsDoc && isObject(opsDoc.deployments) && isObject(opsDoc.deployments.products) ? opsDoc.deployments.products : {};
    for (const k of Object.keys(dep)) if (!k.startsWith('__')) out.push({ producto: k, origen: 'deployments', repo: null, activo: true, motivo: null });
    return { lista: out, motivo };
  }
  /**
   * Los repos de la organización para elegir en «El filtro de cada repo»: los que mira la revisión de dependencias
   * (`ado: "<proyecto>/<repo>"` con la organización del repo de operaciones, o `github: "<org>/<repo>"`) y los que ya
   * nombra team-repos.json, sin repetir. `{ lista, motivo }`: una lista que no se pudo leer lo dice.
   */
  function reposDeLaOrganizacion(dirOps, doc) {
    const out = new Map();
    const sumar = (x) => {
      if (!isObject(x) || typeof x.platform !== 'string' || typeof x.org !== 'string' || typeof x.repo !== 'string' || !x.org || !x.repo) return false;
      // la forma de cada plataforma (con proyecto o sin él) la juzga el lector al revisar; acá sólo se arma la identidad
      const e = typeof x.project === 'string' && x.project ? { platform: x.platform, org: x.org, project: x.project, repo: x.repo } : { platform: x.platform, org: x.org, repo: x.repo };
      out.set([e.platform, e.org, e.project || '', e.repo].join('\0').toLowerCase(), e);
      return true;
    };
    const motivos = [];
    const r = dirOps ? leerDe(dirOps, 'scripts/nightly/dependencies/repos.json') : { estado: 'sin_copia' };
    const d = r.estado === 'leido' ? docDe(r.texto) : null;
    if (r.estado === 'sin_copia') motivos.push(M('config.reposSinOperaciones'));
    else if (r.estado === 'ilegible' || (r.estado === 'leido' && (!d || !Array.isArray(d.repos)))) motivos.push(M('config.reposListaIlegible'));
    const ops = remoteDe('operaciones') || {};
    let ignoradas = 0;
    for (const x of (d && Array.isArray(d.repos) ? d.repos : [])) {
      // una entrada es un repo si su «ado» («<proyecto>/<repo>», en la plataforma y la organización del repo de
      // operaciones, que tiene proyectos) o su «github» lo nombran
      const ado = isObject(x) && typeof x.ado === 'string' ? x.ado.split('/') : [];
      const gh = isObject(x) && typeof x.github === 'string' ? x.github.split('/') : [];
      const okAdo = ado.length === 2 && Boolean(ops.project) && sumar({ platform: ops.platform, org: ops.org, project: ado[0], repo: ado[1] });
      const okGh = gh.length === 2 && sumar({ platform: 'github', org: gh[0], repo: gh[1] });
      if (!okAdo && !okGh) ignoradas++;
    }
    if (ignoradas) motivos.push(M('config.reposIgnorados', { n: ignoradas }));
    if (isObject(doc)) {
      for (const k of ['public', 'profile', 'operations']) sumar(doc[k]);
      if (isObject(doc.merge_suites) && Array.isArray(doc.merge_suites.repos)) for (const e of doc.merge_suites.repos) sumar(isObject(e) ? e.repo : null);
    }
    const lista = [...out.values()].sort((a, b) => [a.platform, a.org, a.project || '', a.repo].join('/').localeCompare([b.platform, b.org, b.project || '', b.repo].join('/')));
    return { lista, motivo: motivos.length ? motivos.join('; ') : null };
  }
  const enlaceArchivo = (rel) => RP.enlaceArchivo(remoteDe('operaciones'), rel);

  // ── la sección por repo: el advisors.yaml de main de cada repo de producto ──
  // Los repos son los de «El filtro de cada repo» sin el público, el perfil ni operaciones. Cada uno se lee a pedido, en su
  // clon de escritura (`fuentes.clonDeProducto`), con SITE_PRODUCTS_WRITE_TOKEN o, sin ella, con la credencial de
  // lectura de operaciones; proponer pide SITE_PRODUCTS_WRITE_TOKEN y nunca completa el pedido (ni con `site.auto_apply`).
  const { ARCHIVO: ARCHIVO_DEL_REPO, ARCHIVOS: ARCHIVOS_DEL_REPO } = require('../../lib/repo-config-readers.js');
  const lecturasDeRepo = new Map();
  const identidad = (e) => [e.platform, e.org, e.project || '', e.repo].join('\0').toLowerCase();
  function reposDeProducto() {
    const cl = clones();
    const tr = cl.perfil && cl.perfil.dir ? docDe(leerDe(cl.perfil.dir, 'team-repos.json').texto || '') : null;
    const r = reposDeLaOrganizacion(cl.operaciones && cl.operaciones.dir, tr);
    const fuera = new Set();
    for (const k of ['public', 'profile', 'operations']) if (tr && isObject(tr[k])) fuera.add(identidad(tr[k]));
    for (const repo of ['operaciones', 'perfil']) { const x = remoteDe(repo); if (x && x.platform) fuera.add(identidad(x)); }
    const lista = r.lista.filter((e) => !fuera.has(identidad(e))).map((e) => ({ ...e, id: ORG.idDeRepo(e), nombre: [e.org, e.project, e.repo].filter(Boolean).join('/') }));
    return { lista, motivo: r.motivo };
  }
  const repoPorId = (id) => (typeof id === 'string' ? reposDeProducto().lista.find((e) => e.id === id) || null : null);
  const remoteDeProducto = (e) => ORG.remoteOf(ORG.urlDeRepo(e));
  const credencialDeLectura = () => (cfg.escritura && cfg.escritura.productos) || (cfg.operationsCredencial && cfg.operationsCredencial.token) || null;

  /** El clon de escritura de un repo de producto: `{ dir }` o `{ motivo }`. */
  async function clonDelRepo(e) {
    const url = urlDeProducto(e);
    if (!url) return { motivo: M('config.repoSinDireccion') };
    if (typeof fuentes.clonDeProducto !== 'function') return { motivo: M('config.repoSinClon') };
    const c = await fuentes.clonDeProducto({ id: e.id, url });
    return c && c.dir ? c : { motivo: M('config.clonFallo', { motivo: (c && c.motivo) || M('config.noSeArmoClon') }) };
  }

  /** ¿Se puede proponer a este repo? Sin el secreto, a mano; con él, la política de revisión de su main. */
  async function estadoProponerRepo(e, archivo = ARCHIVO_DEL_REPO) {
    const cred = cfg.escritura && cfg.escritura.productos;
    if (!cred) return { habilitado: false, motivo: M('config.repoSinSecreto') };
    const remote = remoteDeProducto(e);
    if (!remote.platform) return { habilitado: false, motivo: M('config.sinPlataforma') };
    try {
      const p = await RP.politicaDeRevision({ remote, credencial: cred, urlBase, fetch, archivo, aplicarSolo: false });
      return p.ok ? { habilitado: true, motivo: null } : { habilitado: false, motivo: p.message };
    } catch (err) {
      log(`configuración: la política de revisión de ${e.nombre} no se pudo leer (${(err && err.message) || err})`);
      return { habilitado: false, motivo: M('config.sinPolitica', { codigo: (err && err.name) || 'error' }) };
    }
  }

  /** Lo que dice el archivo de main de un repo, clave por clave, con su lector. Guarda la lectura para revisar. */
  async function leerRepo(e) {
    const base = { ok: true, id: e.id, nombre: e.nombre, enlace: RP.enlaceArchivo(remoteDeProducto(e), ARCHIVO_DEL_REPO), claves: [] };
    let leer;
    // el sitio demo lee el archivo de ejemplo de cada repo (demo/data.js): sin credencial, sin clon y sin git
    if (demo && typeof repoDeEjemplo === 'function') leer = async (archivo) => repoDeEjemplo(e, archivo);
    else {
      const cred = credencialDeLectura();
      if (!cred) return { ...base, estado: 'no_se_pudo', motivo: M('config.repoSinCredencial'), proponer: { habilitado: false, motivo: M('config.repoSinSecreto') } };
      const c = await clonDelRepo(e);
      if (!c.dir) return { ...base, estado: 'no_se_pudo', motivo: c.motivo, proponer: { habilitado: false, motivo: c.motivo } };
      leer = (archivo) => RP.leerDeMain({ clon: c.dir, archivo, credencial: cred, exclusivo: fuentes.exclusivo || ((fn) => fn()), log });
    }
    let archivo = ARCHIVOS_DEL_REPO[0];
    let r = await leer(archivo);
    if (!r.ok) return { ...base, estado: 'no_se_pudo', motivo: r.message, proponer: { habilitado: false, motivo: r.message } };
    // sin `.yaml`, el arnés lee `.yml`: el sitio también, y propone sobre ése
    const otro = ARCHIVOS_DEL_REPO.slice(1).find((a) => !r.oid && r.archivos.includes(a));
    if (otro) {
      archivo = otro;
      r = await leer(archivo);
      if (!r.ok) return { ...base, estado: 'no_se_pudo', motivo: r.message, proponer: { habilitado: false, motivo: r.message } };
    }
    base.archivo = archivo;
    base.enlace = RP.enlaceArchivo(remoteDeProducto(e), archivo);
    lecturasDeRepo.set(e.id, { texto: r.texto, oid: r.oid, archivo });
    const claves = clavesDelRepo.map((d) => {
      const vistaClave = { clave: d.clave, titulo: d.titulo, forma: d.forma };
      const lector = ORG.lectorDeClave(TREE, d, lectores);
      if (!lector) return { ...vistaClave, estado: 'no_reader', motivo: M('config.repoClaveSinLector', { clave: d.clave }) };
      const forma = ORG.reemplazarBloque(r.texto, d.clave, '');
      if (forma.ilegible) return { ...vistaClave, estado: 'ilegible', motivo: forma.ilegible };
      const l = lector.leerClave(r.texto);
      if (l.ilegible) return { ...vistaClave, estado: 'ilegible', motivo: l.ilegible };
      // un lector que no sabe marcar lo podrido no dice «nada podrido»: null es «no se miró»
      const podridas = typeof lector.podridasDelValor === 'function' ? lector.podridasDelValor(l.valor, r.archivos, dia()) : null;
      return { ...vistaClave, estado: 'ok', presente: l.presente, valor: l.valor, problemas: l.problemas, podridas };
    });
    // en el demo «Proponer» muestra lo que pasaría: no hay credencial ni política que mirar
    const proponer = demo ? { habilitado: true, motivo: null } : await estadoProponerRepo(e, archivo);
    return { ...base, estado: r.oid ? 'leido' : 'nuevo', motivo: null, oid: r.oid, texto: r.texto, claves, proponer };
  }

  /** Revisa lo que se propondría de una clave sobre la versión que abrió la página. */
  function revisarRepo(e, body) {
    const d = clavesDelRepo.find((x) => x.clave === body.clave);
    if (!d) return { ok: false, problemas: [M('config.repoClaveDesconocida')], filas: [] };
    const lector = ORG.lectorDeClave(TREE, d, lectores);
    if (!lector) return { ok: false, problemas: [M('config.repoClaveSinLector', { clave: d.clave })], filas: [] };
    const leida = lecturasDeRepo.get(e.id);
    if (!leida || (body.oid || null) !== (leida.oid || null)) return { ok: false, codigo: 'cambio', problemas: [M('rp.cambio')], filas: [] };
    const r = ORG.revisarClaveDelRepo({ descriptor: d, lector, texto: leida.texto, valor: body.valor });
    return { ok: r.ok, problemas: r.generales, filas: r.filas, texto: r.texto, diferencia: r.ok ? ORG.diferencia(leida.texto || '', r.texto) : [] };
  }

  /** Propone el cambio como un pedido al repo del producto: rama y pedido, nunca main ni completar el pedido. */
  async function proponerRepo(e, body, ctx) {
    const rechazoDeRevision = (rev) => ({ ok: false, codigo: rev.codigo, message: rev.problemas.concat(rev.filas.flat()).join(' · ') || M('config.repoNoValida'), filas: rev.filas });
    // el sitio demo revisa como siempre y muestra lo que pasaría: ni credencial, ni clon, ni pedido
    if (demo) {
      const rev = revisarRepo(e, body);
      if (!rev.ok) return rechazoDeRevision(rev);
      const d = clavesDelRepo.find((x) => x.clave === body.clave);
      const archivo = lecturasDeRepo.get(e.id).archivo;
      return { ok: true, codigo: 'demo', demo: true, message: M('config.demoPropuesta', { seccion: d.titulo, archivo, repo: e.nombre }),
        loQuePasaria: { repo: e.nombre, archivo, diferencia: rev.diferencia } };
    }
    const cred = cfg.escritura && cfg.escritura.productos;
    if (!cred) return { ok: false, message: M('config.repoSinSecreto') };
    const rev = revisarRepo(e, body);
    if (!rev.ok) return rechazoDeRevision(rev);
    const remote = remoteDeProducto(e);
    if (!remote.platform) return { ok: false, message: M('config.sinPlataforma') };
    const c = await clonDelRepo(e);
    if (!c.dir) return { ok: false, message: c.motivo };
    const d = clavesDelRepo.find((x) => x.clave === body.clave);
    const archivo = lecturasDeRepo.get(e.id).archivo;
    // sobre un `.yml`: si mientras tanto apareció un `.yaml` en main, el arnés leería ése y el pedido no tendría efecto
    if (archivo !== ARCHIVO_DEL_REPO) {
      const ahoraYaml = await RP.leerDeMain({ clon: c.dir, archivo: ARCHIVO_DEL_REPO, credencial: cred, exclusivo: fuentes.exclusivo || ((fn) => fn()), log });
      if (!ahoraYaml.ok) return { ok: false, message: ahoraYaml.message };
      if (ahoraYaml.oid) { lecturasDeRepo.delete(e.id); return { ok: false, codigo: 'cambio', message: M('rp.cambio') }; }
    }
    const r = await RP.proponer({
      clon: c.dir, archivo, contenido: rev.texto, oidEsperado: body.oid || null,
      idCorto: `advisors-${String(e.repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'}`,
      secciones: [`${d.titulo} (${e.nombre})`], quien: norm(ctx.sesion.email), credencial: cred, remote, urlBase,
      exclusivo: fuentes.exclusivo || ((fn) => fn()), now: new Date(ahora()), fetch, log, aplicarSolo: false, marca: body.marca || null,
    });
    if (r && r.ok) lecturasDeRepo.delete(e.id);
    if (r && r.codigo === 'cambio') { const { textoActual: _t, oidActual: _o, ...cambio } = r; return cambio; }
    return r;
  }

  async function leerTodo() {
    const secciones = ORG.SECCIONES.map(vista);
    const cl = clones();
    const opsDoc = cl.operaciones ? docDe((leerDe(cl.operaciones.dir, 'operations.json').texto) || '') : null;
    const machines = (opsDoc || fuentes.config() || {}).people;
    const quien = Object.fromEntries(Object.entries(isObject(machines) && isObject(machines.machines) ? machines.machines : {}).filter(([, e]) => isObject(e)).map(([m, e]) => [m, norm(e.person)]));
    const prods = productos(cl.operaciones && cl.operaciones.dir, opsDoc);
    let versionesMotivo = null;
    try { fs.readdirSync(fuentes.dirBuzon); } catch (e) { if (e && e.code !== 'ENOENT') versionesMotivo = M('config.espejoIlegible', { codigo: e.code || 'error' }); }
    return {
      ok: true, secciones,
      proponer: { operaciones: await estadoProponer('operaciones'), perfil: cfg.profileRepo ? await estadoProponer('perfil') : { habilitado: false, motivo: M('config.perfilNoConfigurado') } },
      productos: prods.lista, productosMotivo: prods.motivo, versionesMotivo,
      reposDeProducto: reposDeProducto(),
      productosEnlace: enlaceArchivo('scripts/nightly/dependencies/repos.json'),
      contenido: contenidoDelPerfil(cl.perfil && cl.perfil.dir, (rel) => RP.enlaceArchivo(remoteDe('perfil'), rel)),
      versiones: ORG.versionesDeMaquinas({ espejo: fuentes.dirBuzon, versionImagen, ahora: ahora(), personas: quien }),
    };
  }

  // ── revisar ──
  // ── la base que abrió la página y la mezcla con lo que cambió afuera ──
  /** La base que manda la página, si es de verdad la versión que dice (`oid`): `{ texto, doc }`; null si no. */
  function baseVerificada(body) {
    if (!isObject(body) || typeof body.base !== 'string') return null;
    if (body.oid === null) return body.base === '' ? { texto: null, doc: {} } : null;
    if (typeof body.oid !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(body.oid)) return null;
    if (ORG.versionDeTexto(body.base, body.oid.length) !== body.oid) return null;
    const doc = docDe(body.base);
    return doc ? { texto: body.base, doc } : null;
  }
  /** El borrador de la sección que sale de un documento, con la forma que le da `vista`. */
  function borradorDe(s, doc) {
    if (s.id === 'umbrales') return isObject(doc) && isObject(doc.thresholds) ? clone(doc.thresholds) : {};
    if (s.claves === null) return clone(isObject(doc) ? doc : { version: 1 });
    return Object.fromEntries(s.claves.filter((k) => isObject(doc) && doc[k] !== undefined).map((k) => [k, clone(doc[k])]));
  }
  // Diferencias entre productos no es una parte del archivo (su borrador es una acción): no se mezcla. «Confirmar máquina»
  // tampoco al revisar, porque se arma siempre sobre la versión de hoy; al proponer, su texto se mezcla como los demás
  const mezclable = (s, borrador) => s.id !== 'paridad' && !(isObject(borrador) && borrador.accion !== undefined);
  /** Cada choque con el camino dentro del borrador de la sección (Umbrales lo tiene sin `thresholds`). */
  const choquesDe = (s, conflictos) => conflictos.map((c) => ({ ...c, camino: s.id === 'umbrales' && c.camino[0] === 'thresholds' ? c.camino.slice(1) : c.camino }));
  const revisarCon = (s, texto, borrador) => ORG.revisar({ seccion: s, texto, borrador, lectores: { [s.lector]: lector(s.lector) }, arnes: { thresholds: arnes().thresholds }, hoy: dia(), tree: TREE });

  function revisarSeccion(s, borradorIn, ctx, body = {}) {
    const v = vista(s);
    if (['no_reader', 'no_configurado', 'bajando', 'ilegible'].includes(v.estado) || v.soloLectura) return { ok: false, problems: [{ path: '', message: v.motivo, sinCampo: true }], texto: null };
    // la página carga sobre su versión (la base): se revisa sobre ésa aunque el sitio tenga otra, más vieja o más nueva.
    // Aplicar el borrador entero sobre otra versión pisaría en silencio lo que cambió en el medio; si el archivo cambió en
    // main, la mezcla la hace «Proponer» contra la punta
    let texto = v.texto;
    if (body.oid !== undefined && body.oid !== v.oid && mezclable(s, borradorIn)) {
      const b = baseVerificada(body);
      if (!b) return { ok: false, problems: [{ path: '', message: M('config.baseNoCoincide'), sinCampo: true }], texto: null };
      texto = b.texto;
    }
    let borrador = clone(borradorIn);
    const problemas = [];
    let advertencia = null;
    if (s.id === 'personas' && isObject(borrador) && borrador.accion === 'confirm') {
      const peopleDoc = clone(isObject(borrador.people) ? borrador.people : ((docDe(v.texto || '') || {}).people || {}));
      const { informados } = contextoPersonas(null);
      const inf = informados && isObject(informados.maquinas) ? informados.maquinas[borrador.maquina] : null;
      const correo = inf && inf.estado === 'informa' ? inf.correo : null;
      peopleDoc.machines = isObject(peopleDoc.machines) ? peopleDoc.machines : {};
      // el correo informado nunca se escribe en claro: la huella, normalizada
      peopleDoc.machines[borrador.maquina] = { person: norm(borrador.person || correo || ''), reported_sha256: correo ? people.huellaDeCorreo(correo) : null, confirmed_by: norm(ctx.sesion.email), confirmed_on: dia() };
      borrador = { people: peopleDoc };
    }
    if (s.id === 'sitio') {
      const site = isObject(borrador) && isObject(borrador.site) ? borrador.site : {};
      // toda baja de la lista saca también la marca de su invitación: la lista editada como siempre no deja marcas sueltas
      if (isObject(site.invitations) && Array.isArray(site.access)) {
        const enLista = new Set(site.access.flatMap((e) => (isObject(e) && Array.isArray(e.emails) ? e.emails : [])).map(norm));
        for (const k of Object.keys(site.invitations)) if (!k.startsWith('__') && !enLista.has(norm(k))) delete site.invitations[k];
        if (!Object.keys(site.invitations).length) delete site.invitations;
      }
      // quien propone, con todos sus correos de la lista vigente
      const suyos = people.correosDe(ctx.sesion.email, people.contexto({ operations: fuentes.config() || {} }));
      if (Array.isArray(site.access)) {
        const mant = mantenedoresDe(site);
        if (!mant.length) problemas.push({ path: 'site.access', message: SIN_MANTENEDORES });
        else if (!suyos.some((m) => mant.includes(m))) advertencia = M('config.noEstas');
      } else {
        const lista = site.maintainers;
        if (!Array.isArray(lista) || !lista.length) problemas.push({ path: 'site.maintainers', message: M('config.listaVacia') });
        else if (!lista.map(norm).some((m) => suyos.includes(m))) advertencia = M('config.noEstas');
      }
    }
    const r = revisarCon(s, texto, borrador);
    const problems = [...problemas, ...r.problems];
    const bueno = r.ok && !problemas.length;
    // lo que cambia, para mostrarlo antes de proponer: la diferencia por renglones y el resumen en palabras
    const cambia = bueno && typeof r.texto === 'string';
    const resumen = cambia ? resumenDe(s, docDe(texto || '') || {}, docDe(r.texto) || {}, views.idiomaDe(ctx)) : [];
    const diferencia = cambia ? ORG.diferencia(texto || '', r.texto) : [];
    // la versión sobre la que se armó el texto: la de la página, o la del sitio para lo que se arma siempre sobre la versión
    // de hoy («Confirmar máquina»). «Proponer» la necesita para comparar contra la misma
    const version = { texto, oid: texto === v.texto ? v.oid : body.oid };
    return { ...r, ok: bueno, problems, texto: bueno ? r.texto : null, borrador, advertencia, resumen, diferencia, version };
  }

  /** El texto que llega a «Proponer» se vuelve a validar entero, con el lector de su archivo: nunca se confía en la pantalla. */
  function validarTexto(s, texto, actualTexto = vista(s).texto) {
    const doc = docDe(texto);
    if (!doc || ORG.formatJson(doc) !== texto) return M('config.noEsElRevisado');
    // el pedido cambia sólo la sección: lo demás del archivo tiene que quedar como está en el clon
    if (s.claves) {
      const actual = docDe(actualTexto || '') || {};
      const ajenas = [...new Set([...Object.keys(actual), ...Object.keys(doc)])].filter((k) => !s.claves.includes(k) && JSON.stringify(actual[k]) !== JSON.stringify(doc[k]));
      if (ajenas.length) return M('config.cambiaAjenas', { claves: ajenas.join(', ') });
      // una sección con `rutas` cambia sólo esas hojas de su clave: las otras, como están en el clon
      const hojas = ORG.hojasAjenas(s, actual, doc);
      if (hojas.length) return M('config.cambiaAjenas', { claves: hojas.join(', ') });
    }
    if (s.id === 'umbrales') { const r = ORG.thresholdsParse(texto, { arnes: { thresholds: arnes().thresholds }, previas: Object.keys(((docDe(actualTexto || '') || {}).thresholds) || {}), tree: TREE }); return r.ok ? null : r.problems[0].message; }
    if (s.id === 'paridad') { const l = lector('check-product-parity.js'); const r = l && l.leerDeclaradas(doc, dia()); return !r ? M('config.noLeeDeclaradas') : (r.problemas.length ? r.problemas[0].message : null); }
    const lec = lector(s.lector);
    if (!ORG.lectorSabe(lec, s)) return M('org.noLee', { que: s.archivo });
    const r = lec.parse(texto);
    if (!r.ok) return M('config.lectorRechaza', { detalle: (r.problems || []).map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join(' · ') });
    // el lector da por bueno un archivo con un modelo mal escrito (lo pone aparte): la sección que lo cambia no lo propone
    const aparte = ORG.problemasDeSeccion(s, r, docDe(actualTexto || ''), doc);
    if (aparte.length) return M('config.lectorRechazaParte', { detalle: aparte.map((p) => `${p.path}: ${p.message}`).join(' · ') });
    if (s.archivo === 'operations.json' && isObject(doc.site) && Array.isArray(doc.site.maintainers) && !doc.site.maintainers.length) return M('config.listaVacia');
    if (s.archivo === 'operations.json' && isObject(doc.site) && Array.isArray(doc.site.access) && !mantenedoresDe(doc.site).length) return SIN_MANTENEDORES;
    if (s.repo === 'perfil') {
      const capa = leerDe(clones().perfil.dir, 'team-layer.json');
      const layerText = capa.estado === 'leido' ? capa.texto : '';
      // la sección Paquetes vive en un archivo que cualquier versión lee; sólo una LISTA pide una versión que la conozca
      // el perfil del equipo: una lista de paquetes y `response` piden su versión; team-repos.json, la suya
      const gate = s.archivo === 'team-profile.json'
        ? ORG.teamProfileGateProblem({ layerText, versionImagen, doc, actual: docDe(actualTexto || '') })
        : ORG.profileGateProblem(layerText, doc);
      if (gate) return gate;
    }
    return null;
  }

  async function proponer(s, body, ctx) {
    const v = vista(s);
    if (['no_reader', 'no_configurado', 'bajando', 'ilegible'].includes(v.estado) || v.soloLectura) return { ok: false, message: v.motivo };
    if (s.id === 'personas' && v.extras && v.extras.vencido) return { ok: false, message: v.extras.vencido };
    const texto = typeof body.texto === 'string' ? body.texto : '';
    // sin la versión que abrió, no se puede saber si otro cambió el archivo: no se propone a ciegas
    if (body.oid === undefined) return { ok: false, message: M('config.faltaOid') };
    // lo propuesto se arma sobre la base que abrió la página: «no toca otras partes» se mira contra esa base. Que la base
    // sea la punta de main lo comprueba RP.proponer; si no lo es, se mezcla abajo
    const base = body.oid !== v.oid ? baseVerificada(body) : null;
    // una base que no es la versión que dice se rechaza, como en «Revisar»: controlar contra la copia del sitio dejaría
    // pasar un texto que deshace lo que ya entró en main
    if (body.oid !== v.oid && typeof body.base === 'string' && !base) return { ok: false, message: M('config.baseNoCoincide') };
    const problema = validarTexto(s, texto, base ? base.texto : v.texto);
    if (problema) return { ok: false, message: problema };
    const cred = cfg.escritura && cfg.escritura[s.repo];
    if (!cred) return { ok: false, message: M('config.sinIdentidad2') };
    const remote = remoteDe(s.repo);
    if (!remote.platform) return { ok: false, message: M('config.sinPlataforma') };
    // el sitio demo muestra lo que pasaría con lo ya revisado, sin abrir ningún pedido
    if (demo) {
      return { ok: true, codigo: 'demo', demo: true, message: M('config.demoPropuesta', { seccion: s.titulo, archivo: v.archivo, repo: s.repo }),
        loQuePasaria: { repo: s.repo, archivo: v.archivo, diferencia: ORG.diferencia(base ? base.texto || '' : v.texto || '', texto), resumen: resumenDe(s, docDe(v.texto || '') || {}, docDe(texto) || {}, views.idiomaDe(ctx)) } };
    }
    let dir = s.repo === 'perfil' ? clones().perfil.dir : clones().operaciones.dir;
    // con la copia de operaciones la carpeta de la foto no tiene git y nunca se escribe: la propuesta trae main en
    // un clon de escritura aparte, compara contra esa punta y arma el commit ahí
    if (s.repo === 'operaciones' && clones().operaciones.indice) {
      if (typeof fuentes.clonDeEscritura !== 'function') return { ok: false, message: M('config.sinClonEscritura') };
      const e = await fuentes.clonDeEscritura();
      if (!e || !e.dir) return { ok: false, message: M('config.clonFallo', { motivo: (e && e.motivo) || M('config.noSeArmoClon') }) };
      dir = e.dir;
    }
    // la herramienta de horas y los canales de aviso: el mismo pedido sube la versión que pide el perfil, si es anterior
    // a la que los lee (una máquina vieja rechaza la capa nueva y sigue con la de antes)
    let archivos = null;
    const antes = docDe(base ? base.texto || '' : v.texto || '');
    // la capa se lee sólo si el pedido cambia una de esas claves: prender o apagar otra integración no la necesita
    if (s.id === 'integraciones' && ORG.cambiaLaCapa({ actual: antes, doc: docDe(texto) })) {
      const capa = leerDe(dir, 'team-layer.json');
      if (capa.estado === 'ilegible') return { ok: false, message: capa.motivo };
      const sube = ORG.timeTrackingLayer({ layerText: capa.estado === 'leido' ? capa.texto : null, actual: antes, doc: docDe(texto) });
      if (sube && sube.problema) return { ok: false, message: sube.problema };
      if (sube) archivos = [{ archivo: v.archivo, contenido: texto, oidEsperado: body.oid }, { archivo: sube.archivo, contenido: sube.contenido, oidEsperado: capa.estado === 'leido' ? capa.oid : null }];
    }
    const r = await RP.proponer({
      clon: dir, ...(archivos ? { archivos } : { archivo: v.archivo, contenido: texto, oidEsperado: body.oid }), idCorto: s.idCorto,
      secciones: [s.titulo], quien: norm(ctx.sesion.email), credencial: cred, remote, urlBase, exclusivo: fuentes.exclusivo || ((fn) => fn()),
      now: new Date(ahora()), fetch, log, aplicarSolo: aplicarSolo(), marca: body.marca || null,
    });
    if (!r || r.codigo !== 'cambio') return r;
    // lo que cambió en main fue la capa, no el archivo de la sección: no se mezcla, se pide abrir de nuevo
    if (r.archivo && r.archivo !== v.archivo) { const { textoActual: _t, oidActual: _o, ...cambio } = r; return cambio; }
    const { textoActual, oidActual, ...cambio } = r;
    // la punta tiene el archivo pero no se pudo leer: mezclar contra un archivo vacío borraría el resto al proponer
    if (oidActual && typeof textoActual !== 'string') { log(`propuesta de ${v.archivo}: no pude leer la versión de main para mezclar; queda el «cambió» de siempre`); return cambio; }
    return reaplicarSobreLaPunta(s, body, texto, { texto: oidActual ? textoActual : null, oid: oidActual || null }, ctx) || cambio;
  }

  /**
   * El archivo cambió en main desde la base de la página: lo propuesto se pone encima de la punta. Sin choques, la
   * propuesta nueva para confirmar de nuevo (`reaplicado`); con choques, cada valor con las dos versiones (`se_pisan`);
   * sin choques pero con lo mezclado que no pasa la revisión, el motivo y la base nueva (`no_valida`). null si no se puede mezclar (sin base verificada, o una sección que no se mezcla): queda el «cambió» de siempre.
   */
  function reaplicarSobreLaPunta(s, body, texto, punta, ctx) {
    const b = baseVerificada(body);
    if (!b || !mezclable(s, body.borrador) || (punta.texto !== null && !docDe(punta.texto))) return null;
    const actual = punta.texto === null ? {} : docDe(punta.texto);
    const m = ORG.reaplicar({ base: b.doc, mio: docDe(texto) || {}, actual });
    const seccion = { texto: punta.texto, oid: punta.oid, borrador: borradorDe(s, actual) };
    const borrador = borradorDe(s, m.doc);
    if (m.conflictos.length) return { ok: false, codigo: 'se_pisan', message: M('config.sePisan'), conflictos: choquesDe(s, m.conflictos), borrador, seccion };
    const r = revisarCon(s, punta.texto, clone(borrador));
    if (!r.ok || typeof r.texto !== 'string') return { ok: false, codigo: 'no_valida', message: M('config.reaplicadoNoValida', { detalle: (r.problems || []).map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join(' · ') }), conflictos: [], borrador, seccion };
    const problema = validarTexto(s, r.texto, punta.texto);
    if (problema) return { ok: false, codigo: 'no_valida', message: problema, conflictos: [], borrador, seccion };
    return {
      ok: false, codigo: 'reaplicado', message: M('config.reaplicado'), texto: r.texto, borrador, seccion,
      diferencia: ORG.diferencia(punta.texto || '', r.texto), resumen: resumenDe(s, actual, docDe(r.texto) || {}, views.idiomaDe(ctx)),
    };
  }

  // ── la marca de cada propuesta: un solo pedido por marca, y la forma de encontrarlo después ──
  // en memoria: las propuestas en curso (la promesa, que comparte quien repite la marca) y las últimas terminadas
  const marcasEnCurso = new Map();
  const marcasHechas = new Map();
  const claveDe = (seccion, marca) => `${seccion}\0${marca}`;
  /** Corre `fn` una vez por marca: repetirla mientras corre espera el mismo resultado y después devuelve el mismo. */
  function unaVezPorMarca(seccion, marca, fn) {
    const k = claveDe(seccion, marca);
    if (marcasHechas.has(k)) return Promise.resolve(marcasHechas.get(k));
    if (marcasEnCurso.has(k)) return marcasEnCurso.get(k);
    const promesa = fn().then((r) => {
      marcasEnCurso.delete(k);
      marcasHechas.set(k, r);
      while (marcasHechas.size > MARCAS_RECORDADAS) marcasHechas.delete(marcasHechas.keys().next().value);
      return r;
    }, (e) => { marcasEnCurso.delete(k); throw e; });
    marcasEnCurso.set(k, promesa);
    return promesa;
  }
  /** Qué pasó con la propuesta de una marca: lo que recuerda este sitio o, si no la recuerda, lo que dice el repo. */
  async function estadoDeLaMarca(s, marca) {
    const k = claveDe(s.id, marca);
    if (marcasEnCurso.has(k)) return { ok: true, estado: 'en_curso' };
    if (marcasHechas.has(k)) {
      const r = marcasHechas.get(k);
      // un «ya hay un pedido abierto» habla del pedido de otra propuesta, no de esta
      const propia = r && r.enlace && r.codigo !== 'pedido_abierto' && (r.ok || r.codigo === 'quedo_abierto');
      if (!propia) return { ok: true, estado: 'no_hay' };
      if (r.codigo === 'aplicado') return { ok: true, estado: 'aplicado', enlace: r.enlace };
      // abierta cuando se propuso: si ya entró o se cerró lo sabe la plataforma; si no contesta, sigue abierta
      const ahoraEn = await pedidoEnLaPlataforma(s, marca);
      return ahoraEn && !ahoraEn.error ? { ok: true, estado: ahoraEn.estado, ...(ahoraEn.enlace ? { enlace: ahoraEn.enlace } : {}) } : { ok: true, estado: 'abierto', enlace: r.enlace };
    }
    const r = await pedidoEnLaPlataforma(s, marca);
    if (r.error) return { ok: true, estado: 'no_se_pudo_mirar' };
    return r.enlace ? { ok: true, estado: r.estado, enlace: r.enlace } : { ok: true, estado: r.estado };
  }
  /** El pedido de una marca según la plataforma: `{ estado, enlace? }` (`no_hay` si no está) o `{ error }`. */
  async function pedidoEnLaPlataforma(s, marca) {
    const cred = cfg.escritura && cfg.escritura[s.repo];
    const remote = remoteDe(s.repo);
    if (!cred || !remote || !remote.platform) return { error: 'sin_credencial' };
    let r;
    try { r = await RP.pedidoDeMarca({ remote, credencial: cred, marca, urlBase, fetch, ahora: ahora() }); } catch (e) { r = { error: (e && e.name) || 'error' }; }
    if (r && r.error) { log(`configuración: no pude mirar si existe el pedido de una propuesta (${r.error})`); return { error: r.error }; }
    return r ? { estado: r.estado, enlace: r.enlace } : { estado: 'no_hay' };
  }

  /**
   * Después de aplicar solo, el sitio relee sus fuentes enseguida —fuera del candado de la propuesta, que el refresco
   * también toma— y dice si ya usa el cambio.
   */
  // ── invitar y revocar (invitations.js): el alta o la baja, como un pedido sobre operations.json ──
  /** Lo que la sección del sitio muestra de las invitaciones: el botón, el permiso y el estado de cada invitado. */
  async function estadoDeInvitaciones() {
    if (!invitaciones) return null;
    const d = invitaciones.disponibilidad();
    const permiso = d.boton ? await invitaciones.permiso() : null;
    return { boton: d.boton, motivo: d.motivo, texto: d.texto, permiso: permiso && { ok: permiso.ok, texto: permiso.texto || null, comando: permiso.comando || null }, estados: invitaciones.estados(fuentes.config()), codigoPorCorreo: invitaciones.codigoPorCorreo };
  }
  /** operations.json de hoy, con la lista armada si todavía era `site.maintainers`: `{ s, v, doc }` o `{ error }`. */
  function operacionesParaCambiar() {
    const s = ORG.seccionPorId('sitio');
    const v = vista(s);
    if (['no_reader', 'no_configurado', 'bajando', 'ilegible'].includes(v.estado) || v.soloLectura) return { error: v.motivo };
    const doc = docDe(v.texto || '') || { version: 1 };
    doc.site = isObject(doc.site) ? doc.site : {};
    if (!Array.isArray(doc.site.access)) { doc.site.access = people.listaDeAcceso(doc).entradas; delete doc.site.maintainers; }
    return { s, v, doc };
  }
  /** Propone `doc` entero como un pedido (las secciones del sitio y de personas): la respuesta de RP.proponer. */
  async function proponerOperaciones({ s, v, doc }, ctx, marca) {
    const texto = ORG.formatJson(doc);
    const lec = lector(s.lector);
    const p = lec && lec.parse(texto);
    if (!p || !p.ok) return { ok: false, message: M('config.lectorRechaza', { detalle: ((p && p.problems) || []).map((x) => `${x.path || '(el archivo)'}: ${x.message}`).join(' · ') }) };
    if (!mantenedoresDe(doc.site).length) return { ok: false, message: SIN_MANTENEDORES };
    const cred = cfg.escritura && cfg.escritura.operaciones;
    if (!cred) return { ok: false, message: M('config.sinIdentidad2') };
    const remote = remoteDe('operaciones');
    if (!remote.platform) return { ok: false, message: M('config.sinPlataforma') };
    if (demo) return { ok: true, codigo: 'demo', demo: true, loQuePasaria: { repo: 'operaciones', archivo: v.archivo, diferencia: ORG.diferencia(v.texto || '', texto) } };
    let dir = clones().operaciones.dir;
    if (clones().operaciones.indice) {
      if (typeof fuentes.clonDeEscritura !== 'function') return { ok: false, message: M('config.sinClonEscritura') };
      const e = await fuentes.clonDeEscritura();
      if (!e || !e.dir) return { ok: false, message: M('config.clonFallo', { motivo: (e && e.motivo) || M('config.noSeArmoClon') }) };
      dir = e.dir;
    }
    const r = await RP.proponer({
      clon: dir, archivo: v.archivo, contenido: texto, oidEsperado: v.oid, idCorto: s.idCorto, secciones: [s.titulo, ORG.seccionPorId('personas').titulo],
      quien: norm(ctx.sesion.email), credencial: cred, remote, urlBase, exclusivo: fuentes.exclusivo || ((fn) => fn()),
      now: new Date(ahora()), fetch, log, aplicarSolo: aplicarSolo(), marca: marca || null,
    });
    guardado = null;
    if (r && r.codigo === 'cambio') { const { textoActual: _t, oidActual: _o, ...cambio } = r; return cambio; }
    return r;
  }
  async function invitar(body, ctx) {
    if (!invitaciones) return { ok: false, message: M('invitaciones.noDisponible', { motivo: '-' }) };
    const d = invitaciones.disponibilidad();
    if (!d.boton) return { ok: false, message: d.texto };
    const p = await invitaciones.permiso();
    if (!p.ok) return { ok: false, message: p.texto, comando: p.comando };
    const base = operacionesParaCambiar();
    if (base.error) return { ok: false, message: base.error };
    const rc = await invitaciones.revisarCorreo(body.correo, base.doc);
    if (!rc.ok) return { ok: false, message: rc.motivo };
    // nombres de producto: hasta 50, de hasta 100 caracteres cada uno (el lector valida el resto)
    const productos = [...new Set((Array.isArray(body.productos) ? body.productos : []).filter((x) => typeof x === 'string').map((x) => x.trim()).filter((x) => x && x.length <= 100))].slice(0, 50);
    const doc = base.doc;
    doc.site.access.push({ role: 'dev', emails: [rc.correo] });
    if (productos.length) {
      doc.people = isObject(doc.people) ? doc.people : {};
      doc.people.projects = isObject(doc.people.projects) ? doc.people.projects : {};
      // la ficha que ya tenga la persona, con la grafía que tenga (el lector rechaza dos claves del mismo correo); lo que
      // se le suma sale de lo que se le había sacado (el lector rechaza un producto en add y en remove)
      const clave = Object.keys(doc.people.projects).find((k) => !k.startsWith('_') && norm(k) === rc.correo) || rc.correo;
      const f = isObject(doc.people.projects[clave]) ? doc.people.projects[clave] : {};
      f.add = [...new Set([...(Array.isArray(f.add) ? f.add : []), ...productos])];
      if (Array.isArray(f.remove)) { f.remove = f.remove.filter((x) => !productos.includes(x)); if (!f.remove.length) delete f.remove; }
      doc.people.projects[clave] = f;
    }
    doc.site.invitations = { ...(isObject(doc.site.invitations) ? doc.site.invitations : {}), [rc.correo]: { por: norm(ctx.sesion.email), el: dia() } };
    const r = await proponerOperaciones({ ...base, doc }, ctx, body.marca);
    if (r && r.demo) return { ...r, message: M('config.demoInvitar', { correo: rc.correo }), aviso: rc.aviso || null };
    return r && r.ok ? { ...r, message: M('invitaciones.propuesta'), aviso: rc.aviso || null } : r;
  }
  async function revocar(body, ctx) {
    const correo = norm(body.correo);
    const base = operacionesParaCambiar();
    if (base.error) return { ok: false, message: base.error };
    const doc = base.doc;
    const estaba = doc.site.access.some((e) => isObject(e) && Array.isArray(e.emails) && e.emails.map(norm).includes(correo));
    if (!estaba) return { ok: false, message: M('invitaciones.noEstaEnLista', { correo: String(body.correo || '').trim().slice(0, 120) }) };
    doc.site.access = doc.site.access.map((e) => (isObject(e) && Array.isArray(e.emails) ? { ...e, emails: e.emails.filter((m) => norm(m) !== correo) } : e)).filter((e) => !(isObject(e) && Array.isArray(e.emails) && !e.emails.length));
    if (isObject(doc.site.invitations)) {
      for (const k of Object.keys(doc.site.invitations)) if (norm(k) === correo) delete doc.site.invitations[k];
      if (!Object.keys(doc.site.invitations).length) delete doc.site.invitations;
    }
    const r = await proponerOperaciones({ ...base, doc }, ctx, body.marca);
    if (r && r.demo) return { ...r, message: M('config.demoRevocar', { correo }), portal: null };
    return r && r.ok ? { ...r, message: M('invitaciones.revocada'), portal: invitaciones ? invitaciones.portalDe(correo) : null } : r;
  }

  async function despuesDeAplicar(s, r, texto) {
    if (!r || r.codigo !== 'aplicado') return r;
    // el refresco es el entero (con la bajada del buzón) y puede tardar minutos: la respuesta lo espera como mucho
    // `esperaRefrescoMs`; si tarda más, el cambio ya está en main y el refresco sigue solo
    const refresco = Promise.resolve().then(() => fuentes.refrescar())
      .then(() => true, (e) => { log(`después de aplicar ${s.archivo}, el refresco falló (${(e && e.name) || 'error'}): se ve en el próximo`); return true; });
    let tope;
    const aTiempo = await Promise.race([refresco, new Promise((ok) => { tope = setTimeout(() => ok(false), esperaRefrescoMs); })]);
    clearTimeout(tope);
    if (!aTiempo) log(`después de aplicar ${s.archivo}, el refresco sigue (más de ${esperaRefrescoMs} ms): la respuesta no lo espera`);
    const ya = aTiempo && vista(s).texto === texto;
    return { ...r, message: ya ? M('config.aplicadoYa') : M('config.aplicadoProximo') };
  }

  // ── la propuesta de stages: sólo lee, con SITE_PIPELINES_TOKEN; lo de cada plataforma vive en repo-proposal.js ──
  const stages = (pipeline) => RP.stagesPropuestos({ pipeline, remote: remoteDe('operaciones'), token: cfg.pipelinesToken, urlBase, fetch });

  // ── los nombres en lugar de los números: los pipelines de un proyecto y los nombres de los pasos guardados ──
  // se guardan VIGENCIA_MS por proyecto (lo que no contestó, no: se vuelve a preguntar la próxima vez)
  const pipelinesGuardados = new Map();
  async function pipelines(org, project) {
    const clave = `${org}\0${project}`;
    const g = pipelinesGuardados.get(clave);
    if (g && ahora() - g.t < VIGENCIA_MS) return g.r;
    const r = await RP.pipelinesDelProyecto({ org, project, token: cfg.pipelinesToken, urlBase, fetch });
    if (r.ok || r.codigo !== 'sin_respuesta') pipelinesGuardados.set(clave, { t: ahora(), r });
    return r;
  }
  /** Los nombres de los pasos de un pipeline guardado como «proyecto/nombre»: `{ ok, nombres: { identificador: nombre } }`. */
  async function nombresDePasos(pipeline) {
    const m = /^([^/]+)\/(.+)$/.exec(String(pipeline || ''));
    const org = (remoteDe('operaciones') || {}).org;
    if (!m || !org) return { ok: false, message: M('config.pipelineNoReconocido') };
    const lista = await pipelines(org, m[1]);
    if (!lista.ok) return { ok: false, message: lista.message };
    const def = lista.pipelines.find((x) => x.nombre === m[2]);
    if (!def) return { ok: false, message: M('config.pipelineYaNo', { proyecto: m[1], nombre: m[2] }) };
    const pasos = await stages(`${m[1]}/${def.id}`);
    if (!pasos.ok) return { ok: false, message: pasos.message };
    return { ok: true, nombres: Object.fromEntries(pasos.propuestos.filter((x) => x.nombre).map((x) => [x.identificador, x.nombre])) };
  }

  // ── los tipos de pedido de trabajo y sus campos, para elegirlos en «Pedidos de vulnerabilidades» ──
  // Se leen de los proyectos de los productos declarados (repos.json del repo de operaciones), con el mismo token de
  // sólo lectura; lo de cada plataforma vive en repo-proposal.js. Sin lista, la pantalla deja escribir como siempre.
  function dondeLeerPedidos() {
    const cl = clones();
    const r = cl.operaciones ? leerDe(cl.operaciones.dir, 'scripts/nightly/dependencies/repos.json') : { estado: 'nuevo' };
    const d = r.estado === 'leido' ? docDe(r.texto) : null;
    return RP.dondeLeerPedidos(d) || { sinDonde: M(RP.porQueNoSeLeenPedidos(d) === 'organizacion' ? 'config.pedidosSinOrganizacion' : 'config.pedidosSinProyectos') };
  }
  const pedidosGuardados = new Map();
  async function pedidoGuardado(clave, leer) {
    const g = pedidosGuardados.get(clave);
    if (g && ahora() - g.t < VIGENCIA_MS) return g.r;
    const r = await leer();
    if (r.ok || r.codigo !== 'sin_respuesta') pedidosGuardados.set(clave, { t: ahora(), r });
    return r;
  }
  const tiposDe = (org, project) => pedidoGuardado(`t\0${org}\0${project}`, () => RP.tiposDePedido({ org, project, token: cfg.pipelinesToken, urlBase, fetch }));
  /** Los tipos de todos los proyectos: `{ ok, tipos, sinLeer: [{ proyecto, message }] }`; sin ninguno leído, el motivo del primero. */
  async function tiposDePedido() {
    const donde = dondeLeerPedidos();
    if (donde.sinDonde) return { ok: false, codigo: 'no_reconozco', message: donde.sinDonde };
    const leidos = await Promise.all(donde.proyectos.map(async (p) => ({ proyecto: p, r: await tiposDe(donde.org, p) })));
    const ok = leidos.filter((x) => x.r.ok);
    if (!ok.length) return { ok: false, codigo: leidos[0].r.codigo, message: leidos[0].r.message };
    const tipos = [...new Set(ok.flatMap((x) => x.r.tipos))].sort((a, b) => a.localeCompare(b, 'es'));
    return { ok: true, tipos, sinLeer: leidos.filter((x) => !x.r.ok).map((x) => ({ proyecto: x.proyecto, message: x.r.message })) };
  }
  /** Los campos de un tipo, del primer proyecto que lo tiene: `{ ok, campos, proyecto }`. */
  async function camposDePedido(tipo) {
    const t = String(tipo || '').trim();
    const donde = dondeLeerPedidos();
    if (donde.sinDonde) return { ok: false, codigo: 'no_reconozco', message: donde.sinDonde };
    for (const p of donde.proyectos) {
      const ts = await tiposDe(donde.org, p);
      if (!ts.ok || !ts.tipos.includes(t)) continue;
      const r = await pedidoGuardado(`c\0${donde.org}\0${p}\0${t}`, () => RP.camposDelTipo({ org: donde.org, project: p, tipo: t, token: cfg.pipelinesToken, urlBase, fetch }));
      return r.ok ? { ...r, proyecto: p } : r;
    }
    return { ok: false, codigo: 'no_reconozco', message: M('config.pedidosTipoEnNinguno', { tipo: t }) };
  }

  // ── la página ──
  function pagina(ctx) {
    const tok = ctx.sesion && typeof ctx.sesion.tok === 'string' ? ctx.sesion.tok : '';
    const idioma = views.idiomaDe(ctx);
    // el encabezado en un renglón; cómo se revisa, se propone y se lee la pantalla, en un desplegable cerrado de entrada
    const como = ['revisar', 'sinCambios', 'anteLaDuda', 'palabras'].map((k) => `<li>${esc(TX.t(idioma, `config.comoFunciona.${k}`))}</li>`).join('');
    const ayuda = `<details class="mas-info como-funciona"><summary>${esc(TX.t(idioma, 'config.comoFunciona'))}</summary><ul>${como}</ul></details>`;
    const html = views.layout(ctx, TX.t(idioma, 'pestana.configuracion'), `${ayuda}<div id="config-app"><p class="q-note">${TX.t(idioma, 'config.cargando')}</p></div>`, TX.t(idioma, 'config.lede'));
    // el token de doble envío y el código de la pestaña en el idioma de la página, sin nada en línea (la CSP
    // del sitio no lo admite)
    return html.replace('</head>', `<meta name="site-token" content="${tok.replace(/[^A-Za-z0-9_-]/g, '')}"><script src="/static/long-text-editor.js" defer></script><script src="/static/config.js?l=${idioma}" defer></script></head>`);
  }

  // lo que cuesta armar —cada sección leída de su clon y validada con su lector, y el permiso de proponer, que pregunta
  // a la plataforma de cada repo— se arma una vez y se sirve igual hasta que los datos de fondo se refrescan (el modelo
  // y la configuración se reemplazan en cada pasada), hasta que pasa VIGENCIA_MS o hasta que alguien propone un cambio.
  // Dos pedidos a la vez comparten el mismo armado
  let guardado = null;
  // «releé ya»: las fuentes enseguida, con una relectura a la vez y no más de una cada RELECTURA_MS
  let relectura = null;
  let ultimaRelectura = -Infinity;
  function releer() {
    if (relectura) return relectura;
    if (ahora() - ultimaRelectura < RELECTURA_MS) return Promise.resolve();
    ultimaRelectura = ahora();
    relectura = Promise.resolve().then(() => fuentes.refrescar())
      .catch((e) => log(`configuración: la relectura pedida por la página falló (${(e && e.name) || 'error'}): queda lo que había`))
      .finally(() => { relectura = null; guardado = null; });
    return relectura;
  }
  function leerTodoGuardado() {
    const marca = [fuentes.modelo(), fuentes.config()];
    if (guardado && guardado.marca.every((m, i) => m === marca[i]) && ahora() - guardado.t < VIGENCIA_MS) return guardado.promesa;
    const promesa = leerTodo();
    guardado = { marca, t: ahora(), promesa };
    promesa.catch(() => { if (guardado && guardado.promesa === promesa) guardado = null; });
    return promesa;
  }

  const solo = ['maintainer'];
  /** Una respuesta JSON de la pestaña, con sus mensajes en el idioma del pedido. */
  const enIdioma = (handler) => async (ctx) => {
    const r = await handler(ctx);
    const idioma = views.idiomaDe(ctx);
    if (idioma === LANG.POR_DEFECTO || !r || !/^application\/json/.test(String(r.tipo || ''))) return r;
    // sin poder traducir, la respuesta va como está (en castellano), y se dice en el registro
    try { return { ...r, cuerpo: JSON.stringify(TX.traducirRespuesta(idioma, JSON.parse(r.cuerpo))) }; } catch (e) { log(`configuración: una respuesta no se pudo pasar a ${idioma} (${(e && e.message) || e}): sale en castellano`); return r; }
  };
  return [
    { method: 'GET', path: '/configuracion', needs: solo, pestana: { id: 'configuracion', titulo: 'Configuración', orden: 90 }, handler: (ctx) => ({ status: 200, tipo: 'text/html; charset=utf-8', cuerpo: pagina(ctx) }) },
    { method: 'GET', path: '/static/config.js', needs: solo, handler: (ctx) => ({ status: 200, tipo: 'text/javascript; charset=utf-8', cuerpo: ORG.pantalla(LANG.valido(ctx.url && ctx.url.searchParams.get('l')) || views.idiomaDe(ctx)) }) },
    {
      method: 'GET', path: '/api/config', needs: solo, handler: enIdioma(async (ctx) => {
        if (ctx.url && ctx.url.searchParams.get('releer') === '1') await releer();
        const todo = await leerTodoGuardado();
        // el estado de las invitaciones cambia con cada ciclo de fuentes: se arma fresco, fuera de lo guardado
        const inv = await estadoDeInvitaciones();
        if (!inv) return json(200, todo);
        return json(200, { ...todo, secciones: todo.secciones.map((x) => (x.id === 'sitio' ? { ...x, extras: { ...(x.extras || {}), invitaciones: inv } } : x)) });
      }),
    },
    {
      method: 'POST', path: '/api/config/invitar', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const marca = e.body && e.body.marca;
        if (marca !== undefined && !(typeof marca === 'string' && FORMA_DE_MARCA.test(marca))) return rechazo(400, M('config.marcaInvalida'));
        const trabajo = () => invitar(e.body || {}, ctx);
        return json(200, marca === undefined ? await trabajo() : await unaVezPorMarca('invitar', marca, trabajo));
      }),
    },
    {
      method: 'POST', path: '/api/config/revocar', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const marca = e.body && e.body.marca;
        if (marca !== undefined && !(typeof marca === 'string' && FORMA_DE_MARCA.test(marca))) return rechazo(400, M('config.marcaInvalida'));
        const trabajo = () => revocar(e.body || {}, ctx);
        return json(200, marca === undefined ? await trabajo() : await unaVezPorMarca('revocar', marca, trabajo));
      }),
    },
    {
      method: 'POST', path: '/api/config/revisar', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const s = ORG.seccionPorId(e.body && e.body.seccion);
        if (!s) return rechazo(400, M('org.seccionDesconocida'));
        return json(200, revisarSeccion(s, e.body.borrador, ctx, e.body));
      }),
    },
    {
      method: 'POST', path: '/api/config/stages', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        return json(200, await stages(e.body && e.body.pipeline));
      }),
    },
    {
      method: 'POST', path: '/api/config/pipelines', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const b = e.body || {};
        return json(200, await pipelines(String(b.org || '').trim(), String(b.project || '').trim()));
      }),
    },
    {
      method: 'POST', path: '/api/config/tipos-de-pedido', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        return json(200, await tiposDePedido());
      }),
    },
    {
      method: 'POST', path: '/api/config/campos-de-pedido', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        return json(200, await camposDePedido(e.body && e.body.tipo));
      }),
    },
    {
      method: 'POST', path: '/api/config/pasos', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        return json(200, await nombresDePasos(e.body && e.body.pipeline));
      }),
    },
    {
      method: 'POST', path: '/api/config/proponer', needs: solo, handler: enIdioma(async (ctx) => {
        const e = await escritura(ctx); if (e.error) return e.error;
        const s = ORG.seccionPorId(e.body && e.body.seccion);
        if (!s) return rechazo(400, M('org.seccionDesconocida'));
        const marca = e.body && e.body.marca;
        if (marca !== undefined && !(typeof marca === 'string' && FORMA_DE_MARCA.test(marca))) return rechazo(400, M('config.marcaInvalida'));
        const trabajo = async () => {
          const r = await despuesDeAplicar(s, await proponer(s, e.body, ctx), e.body && e.body.texto);
          guardado = null;
          return r;
        };
        return json(200, marca === undefined ? await trabajo() : await unaVezPorMarca(s.id, marca, trabajo));
      }),
    },
    {
      // la sección por repo: se lee a pedido, al abrirla
      method: 'GET', path: '/api/config/repo', needs: solo, handler: enIdioma(async (ctx) => {
        const e = repoPorId(ctx.url && ctx.url.searchParams.get('id'));
        if (!e) return rechazo(404, M('config.repoNoEncontrado'));
        return json(200, await leerRepo(e));
      }),
    },
    {
      method: 'POST', path: '/api/config/repo/revisar', needs: solo, handler: enIdioma(async (ctx) => {
        const w = await escritura(ctx); if (w.error) return w.error;
        const e = repoPorId(w.body && w.body.id);
        if (!e) return rechazo(404, M('config.repoNoEncontrado'));
        return json(200, revisarRepo(e, w.body));
      }),
    },
    {
      method: 'POST', path: '/api/config/repo/proponer', needs: solo, handler: enIdioma(async (ctx) => {
        const w = await escritura(ctx); if (w.error) return w.error;
        const e = repoPorId(w.body && w.body.id);
        if (!e) return rechazo(404, M('config.repoNoEncontrado'));
        const marca = w.body.marca;
        if (marca !== undefined && !(typeof marca === 'string' && FORMA_DE_MARCA.test(marca))) return rechazo(400, M('config.marcaInvalida'));
        const trabajo = () => proponerRepo(e, w.body, ctx);
        return json(200, marca === undefined ? await trabajo() : await unaVezPorMarca(`repo-${e.id}`, marca, trabajo));
      }),
    },
    {
      // sólo el estado y el enlace del pedido de ESA marca, y nada más (ni la rama, ni el cuerpo, ni quién lo pidió)
      method: 'GET', path: '/api/config/propuesta', needs: solo, handler: enIdioma(async (ctx) => {
        const q = ctx.url && ctx.url.searchParams;
        const s = ORG.seccionPorId(q && q.get('seccion'));
        if (!s) return rechazo(400, M('org.seccionDesconocida'));
        const marca = q.get('marca');
        if (typeof marca !== 'string' || !FORMA_DE_MARCA.test(marca)) return rechazo(400, M('config.marcaInvalida'));
        return json(200, await estadoDeLaMarca(s, marca));
      }),
    },
  ];
}

/**
 * La defensa de una escritura de la pestaña: mismo origen, el token de la sesión, JSON y un cuerpo
 * chico. `{ body }` con el cuerpo leído, o `{ error }` con la respuesta de rechazo. La usa también «Cómo trabaja».
 */
async function defensaDeEscritura(cfg, ctx) {
  const h = ctx.req.headers;
  if (h.origin) { if (h.origin !== cfg.publicUrl) return { error: rechazo(403, M('config.otroOrigen')) }; }
  else if (h['sec-fetch-site'] !== 'same-origin') return { error: rechazo(403, M('config.sinOrigen')) };
  const tok = h['x-site-token'];
  if (!tok) return { error: rechazo(403, M('config.sinToken')) };
  const propio = ctx.sesion && typeof ctx.sesion.tok === 'string' ? Buffer.from(ctx.sesion.tok) : Buffer.alloc(0);
  const traido = Buffer.from(String(tok));
  if (!propio.length || propio.length !== traido.length || !crypto.timingSafeEqual(propio, traido)) return { error: rechazo(403, M('config.otroToken')) };
  if (!/^application\/json\b/.test(String(h['content-type'] || ''))) return { error: rechazo(415, M('config.esperaJson')) };
  const cuerpo = await new Promise((resolve) => {
    let size = 0; const partes = []; let listo = false;
    ctx.req.on('data', (c) => { size += c.length; if (size > CUERPO_MAX) { if (!listo) { listo = true; resolve({ grande: true }); } } else partes.push(c); });
    ctx.req.on('end', () => { if (!listo) { listo = true; resolve({ texto: Buffer.concat(partes).toString('utf8') }); } });
    ctx.req.on('error', () => { if (!listo) { listo = true; resolve({ grande: true }); } });
  });
  if (cuerpo.grande) return { error: rechazo(400, M('config.muyGrande')) };
  try { return { body: cuerpo.texto ? JSON.parse(cuerpo.texto) : {} }; } catch { return { error: rechazo(400, M('config.noEsJson')) }; }
}

module.exports = { crearRutas, defensaDeEscritura };
