'use strict';

/**
 * packs.js — los paquetes de revisores.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────────────────────────
 * Los revisores de Bizuit (convenciones de plugins .NET/React/Next.js) y los de clientes (plugins hermanos, el adaptador
 * de un cliente) no se escriben en el código del pipeline. Para publicar el núcleo hay que sacarlos, y sacarlos a mano
 * tiene el modo de falla más silencioso del arnés: un revisor que deja de correr no da error, da MENOS hallazgos.
 * Entonces los revisores de un producto o de un cliente viven en **paquetes**: una carpeta con un `pack.json` que
 * dice qué revisor corre, en qué grupo, con qué condición, qué superficie mira en las vueltas y con qué profundidad de
 * modelo. El pipeline los carga y los anuncia; el núcleo no los nombra.
 *
 * ── LO QUE NO PUEDE PASAR EN SILENCIO ───────────────────────────────────────────────────────────
 *   · Un manifiesto ilegible, una clave fuera del vocabulario, una bandera que `detectStack` no
 *     produce, un agente que no existe, un revisor repetido con el núcleo o con otro paquete: el
 *     comando FRENA (PackError con TODOS los errores, cada uno con archivo · revisor · motivo).
 *     Nunca se evalúa como «falso», nunca se degrada a «sin ese paquete».
 *   · El repo puede restringir la lista con `packs:` en `.tycon/advisors.yaml`; nombrar uno que no
 *     está instalado también frena, diciendo dónde se buscó. Sin `packs:`, los activos los dice la clave
 *     `packs.default` del arnés (`all` | `none`: un paquete opcional viene apagado afuera) —
 *     ver `packsDefault`, abajo.
 *   · Sin paquetes (carpeta por defecto ausente o vacía) el núcleo corre solo y la salida dice
 *     `packs: []` — sin avisos, porque es un estado legítimo (una máquina sin agent-skills). Una
 *     `TYCON_PACKS_DIR` explícita que apunta a una carpeta inexistente sí frena: es configuración rota.
 *
 * ── DÓNDE SE BUSCAN ─────────────────────────────────────────────────────────────────────────────
 *   paquetes: `TYCON_PACKS_DIR`, o `packs/` de agent-skills (este archivo vive en
 *             skills/tycon-pipeline/scripts/lib/, cuatro niveles abajo de la raíz).
 *   agentes:  `TYCON_AGENTS_DIR`, o `agents/` de agent-skills (`~/.claude/agents` es un enlace ahí).
 *
 * ── EL MANIFIESTO (vocabulario cerrado — VOCABULARIO, abajo) ─────────────────────────────────────
 *   { "name", "description", "guides": [...], "skills"?: "<carpeta>", "agents"?: "<carpeta>", "reviewers": [ { "agent", "group", "when",
 *     "surface", "depth", "prefixes", "needsStory"?, "prompt"?, "model"?, "note"? } ],
 *     "siblings"?: [ { "path", "name" } ] }   ← los plugins hermanos del corral del banco
 *   `skills` y `agents`: carpetas DEL PAQUETE (rutas relativas a su carpeta, sin salir de ella) con sus skills
 *   y sus agentes. Un revisor se busca primero en `agents` del paquete y después en la carpeta de agentes de la raíz; el
 *   mismo nombre en los dos lugares es un paquete roto (no se sabe cuál corre).
 *   group: base | condicional | validacion. Los dos primeros entran al set del paso 5; `validacion`
 *   entra al paso 1 (`pipeline.js validators`) con su `prompt` ({story_path}, {repo_path}).
 *   when: { all: [..] } | { any: [..] } | { no: .. } | { detection: "<bandera>" } |
 *         { files: "<regex sobre rutas>" } | { added: { pattern, extensions } }
 *   `added` mira las líneas AGREGADAS del diff (readAddedContents del pipeline); en el grupo
 *   `validacion` no hay diff y lee el archivo entero.
 *
 * ── LAS CLAVES EN CASTELLANO ─────────────────────────────────────────────────────────────────────
 *   Las claves del manifiesto están en inglés. Un paquete de afuera (`TYCON_PACKS_DIR`) escrito con
 *   las claves en castellano se sigue aceptando: se traduce al leerlo (`readPackKeys` del puente lib/legacy-names.js).
 *   Una clave vieja y su nueva con valores distintos en el mismo objeto es un paquete roto (PackError).
 *   Lo que esta biblioteca DEVUELVE conserva los nombres en castellano: `cargarPaquetes` entrega cada paquete y cada
 *   revisor con los nombres de resumenPaquetes en pipeline.js, que son los que viajan en las salidas JSON del
 *   pipeline. La condición se evalúa con las claves nuevas.
 *
 * Quien evalúa las condiciones es el pipeline: este archivo no conoce detectStack ni git — recibe
 * el contexto (`{ det, files, agregado(extensiones) }`) y las banderas válidas como parámetros, para
 * que no haya dependencia circular y para que las pruebas lo ejerciten sin repo.
 */

const fs = require('fs');
const path = require('path');

const RAIZ_AGENT_SKILLS = path.resolve(__dirname, '..', '..', '..', '..');

const VOCABULARIO = Object.freeze({
  manifiesto: Object.freeze(['name', 'description', 'guides', 'skills', 'agents', 'reviewers', 'siblings']),
  hermano: Object.freeze(['path', 'name']),
  revisor: Object.freeze(['agent', 'group', 'when', 'surface', 'depth', 'prefixes', 'needsStory', 'prompt', 'model', 'note']),
  condicion: Object.freeze(['all', 'any', 'no', 'detection', 'files', 'added']),
  agregado: Object.freeze(['pattern', 'extensions']),
  superficie: Object.freeze(['paths', 'excludePaths', 'always']),
  grupos: Object.freeze(['base', 'condicional', 'validacion']),
  profundidades: Object.freeze(['lean', 'standard', 'deep']),
});

class PackError extends Error {
  constructor(errores) {
    const lista = (errores || []).map((e) =>
      `  · ${e.archivo}${e.revisor ? ` · revisor ${e.revisor}` : ''}${e.clave ? ` · clave ${e.clave}` : ''} · ${e.motivo}`);
    super(`🛑 paquetes de revisores: ${errores.length} error(es). Un paquete roto NO degrada a «sin ese paquete» ` +
          `(story 8.2): se arregla el manifiesto o se desinstala el paquete.\n${lista.join('\n')}`);
    this.name = 'PackError';
    this.errores = errores;
  }
}

function raizAgentSkills() { return RAIZ_AGENT_SKILLS; }
function dirPaquetes() { return process.env.TYCON_PACKS_DIR || path.join(RAIZ_AGENT_SKILLS, 'packs'); }
function dirAgentes() { return process.env.TYCON_AGENTS_DIR || path.join(RAIZ_AGENT_SKILLS, 'agents'); }

/** Subcarpetas de `packsDir` con un `pack.json`, ordenadas por nombre. */
function descubrir(packsDir, explicito) {
  let entradas;
  try {
    entradas = fs.readdirSync(packsDir);
  } catch (e) {
    if (e && e.code === 'ENOENT' && !explicito) return [];   // máquina sin paquetes: estado legítimo
    throw new PackError([{ archivo: packsDir, revisor: null,
      motivo: `no se pudo leer la carpeta de paquetes (${(e && e.code) || e.message})` }]);
  }
  const out = [];
  for (const nombre of entradas.sort()) {
    const dir = path.join(packsDir, nombre);
    let esDir = false;
    try { esDir = fs.statSync(dir).isDirectory(); } catch (_e) { esDir = false; }
    if (!esDir) continue;
    const archivo = path.join(dir, 'pack.json');
    if (fs.existsSync(archivo)) out.push({ nombre, dir, archivo });
  }
  return out;
}

/**
 * Sólo los nombres instalados (para el lint de config). Mismo criterio que el cargador: la carpeta
 * por defecto ausente → []; una explícita (parámetro o TYCON_PACKS_DIR) inexistente o ilegible → tira
 * PackError. «No pude mirar» no se devuelve como «no hay ninguno»: sin esto el lint diría «no instalado» cuando el
 * problema real es que no se pudo leer.
 */
function nombresInstalados({ packsDir, explicito } = {}) {
  const dir = packsDir || dirPaquetes();
  // `explicito` se puede fijar (el lint ya resolvió la carpeta y sabe si vino de la variable): sin eso,
  // pasarle la carpeta por defecto ya resuelta la volvería «explícita» y una máquina sin
  // paquetes saldría como «no pude leer».
  const esExplicito = explicito != null ? !!explicito : (!!packsDir || !!process.env.TYCON_PACKS_DIR);
  return descubrir(dir, esExplicito).map((p) => p.nombre);
}

// ── validación (vocabulario cerrado) ───────────────────────────────────────────────────────────
/** null si `rel` es una carpeta que existe adentro de la del paquete; si no, el motivo. */
function motivoCarpetaPropia(rel, dirPaquete) {
  if (typeof rel !== 'string' || !rel.trim()) return 'tiene que ser la ruta de una carpeta del paquete (texto)';
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((t) => t === '..' || t === '')) return `«${rel}» tiene que ser relativa a la carpeta del paquete, sin «..» ni tramos vacíos`;
  let esDir = false;
  try { esDir = fs.statSync(path.join(dirPaquete, rel)).isDirectory(); } catch (_e) { esDir = false; }
  return esDir ? null : `la carpeta ${path.join(dirPaquete, rel)} no existe`;
}
/** null si `rel` es una ruta relativa al árbol del arnés que no sale de él (sin «..», absoluta ni «\»); si no, el motivo. */
function motivoRutaDelArbol(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return 'tiene que ser una ruta (texto)';
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some((t) => t === '..' || t === '')) return `«${rel}» tiene que ser relativa al árbol del arnés, sin «..» ni tramos vacíos`;
  return null;
}
function esObjeto(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function clavesFuera(obj, permitidas) { return Object.keys(obj).filter((k) => !permitidas.includes(k)); }
function regexValida(s) { try { new RegExp(s); return true; } catch (_e) { return false; } }

/** Devuelve el motivo (string) si la condición es inválida; null si es válida. */
function validarCondicion(cuando, banderas, ruta = 'when') {
  if (!esObjeto(cuando)) return `${ruta}: tiene que ser un objeto con UNA clave del vocabulario (${VOCABULARIO.condicion.join(' | ')})`;
  const claves = Object.keys(cuando);
  if (claves.length !== 1) return `${ruta}: tiene ${claves.length} claves (${claves.join(', ') || 'ninguna'}); va exactamente una`;
  const [clave] = claves;
  const valor = cuando[clave];
  if (!VOCABULARIO.condicion.includes(clave)) {
    return `${ruta}: la clave «${clave}» no está en el vocabulario (${VOCABULARIO.condicion.join(' | ')}) — no se evalúa como falso: el manifiesto es inválido`;
  }
  if (clave === 'all' || clave === 'any') {
    if (!Array.isArray(valor)) return `${ruta}.${clave}: tiene que ser una lista de condiciones`;
    for (let i = 0; i < valor.length; i++) {
      const m = validarCondicion(valor[i], banderas, `${ruta}.${clave}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (clave === 'no') return validarCondicion(valor, banderas, `${ruta}.no`);
  if (clave === 'detection') {
    if (typeof valor !== 'string') return `${ruta}.detection: tiene que ser el nombre de una bandera`;
    if (!banderas.includes(valor)) {
      return `${ruta}.detection: la bandera «${valor}» no la produce detectStack (válidas: ${banderas.join(', ')}) — no se evalúa como falso: el manifiesto es inválido`;
    }
    return null;
  }
  if (clave === 'files') {
    if (typeof valor !== 'string' || !valor) return `${ruta}.files: tiene que ser una expresión regular (string) sobre las rutas del diff`;
    if (!regexValida(valor)) return `${ruta}.files: «${valor}» no es una expresión regular válida`;
    return null;
  }
  // added
  if (!esObjeto(valor)) return `${ruta}.added: tiene que ser { pattern, extensions }`;
  const fuera = clavesFuera(valor, VOCABULARIO.agregado);
  if (fuera.length) return `${ruta}.added: clave(s) fuera del vocabulario: ${fuera.join(', ')} (van: ${VOCABULARIO.agregado.join(', ')})`;
  if (typeof valor.pattern !== 'string' || !valor.pattern) return `${ruta}.added.pattern: tiene que ser una expresión regular (string)`;
  if (!regexValida(valor.pattern)) return `${ruta}.added.pattern: «${valor.pattern}» no es una expresión regular válida`;
  if (!Array.isArray(valor.extensions) || !valor.extensions.length ||
      !valor.extensions.every((e) => typeof e === 'string' && e.startsWith('.'))) {
    return `${ruta}.added.extensions: lista no vacía de extensiones con punto (ej. [".cs"])`;
  }
  return null;
}

function validarSuperficie(s) {
  if (!esObjeto(s)) return 'surface: tiene que ser { paths: [...], excludePaths?: [...] } o { always: true }';
  const fuera = clavesFuera(s, VOCABULARIO.superficie);
  if (fuera.length) return `surface: clave(s) fuera del vocabulario: ${fuera.join(', ')}`;
  if (s.always === true) return null;
  if (!Array.isArray(s.paths) || !s.paths.length || !s.paths.every((p) => typeof p === 'string' && p)) {
    return 'surface.paths: lista no vacía de globs';
  }
  if (s.excludePaths != null && (!Array.isArray(s.excludePaths) || !s.excludePaths.every((p) => typeof p === 'string'))) {
    return 'surface.excludePaths: lista de globs';
  }
  return null;
}

/**
 * Valida un manifiesto ya parseado. Devuelve la lista de errores ({archivo, revisor, motivo}); vacía
 * si es válido. `yaDeclarados`: mapa agente → { paquete, archivo } de los paquetes ya cargados.
 */
function validarManifiesto(json, { archivo, agentsDir, nucleo = [], banderas = [], yaDeclarados = new Map() }) {
  const errores = [];
  const err = (revisor, motivo) => errores.push({ archivo, revisor, motivo });
  if (!esObjeto(json)) { err(null, 'el manifiesto tiene que ser un objeto JSON'); return errores; }
  for (const k of clavesFuera(json, VOCABULARIO.manifiesto)) {
    err(null, `clave «${k}» fuera del vocabulario del manifiesto (van: ${VOCABULARIO.manifiesto.join(', ')})`);
  }
  const carpeta = path.basename(path.dirname(archivo));
  if (typeof json.name !== 'string' || !json.name) err(null, 'falta «name»');
  else if (json.name !== carpeta) err(null, `«name» (${json.name}) tiene que coincidir con la carpeta (${carpeta})`);
  if (typeof json.description !== 'string') err(null, 'falta «description»');
  if (json.guides != null && (!Array.isArray(json.guides) || !json.guides.every((g) => typeof g === 'string'))) {
    err(null, '«guides» tiene que ser una lista de rutas');
  } else if (json.guides != null) {
    // relativas al árbol del arnés y adentro de él: el pipeline las pasa como guía a leer, y la auditoría las busca
    for (const g of json.guides) if (motivoRutaDelArbol(g)) err(null, `«guides»: ${motivoRutaDelArbol(g)}`);
  }
  const carpetaPropia = {};
  for (const clave of ['skills', 'agents']) {
    if (json[clave] == null) continue;
    const m = motivoCarpetaPropia(json[clave], path.dirname(archivo));
    if (m) err(null, `«${clave}»: ${m}`);
    else carpetaPropia[clave] = path.join(path.dirname(archivo), json[clave]);
  }
  // `siblings`: los plugins hermanos que el banco de revisores fabrica en su corral para
  // el revisor de hermanos del paquete. Son datos de un cliente: viven en el paquete que los usa (no se publica) y no
  // en el código del núcleo. Una lista de { path, name }: la ruta, relativa a la raíz del corral; el nombre, el del
  // plugin (un identificador: el banco arma con él las clases del hermano).
  if (json.siblings != null) {
    const rutaSegura = (r) => typeof r === 'string' && r.trim() !== '' && !path.isAbsolute(r) && !r.includes('\\')
      && !r.split('/').some((s) => s === '..' || s === '');
    if (!Array.isArray(json.siblings)) err(null, '«siblings» tiene que ser una lista de { path, name }');
    else {
      json.siblings.forEach((h, i) => {
        if (!esObjeto(h)) { err(null, `«siblings»[${i}] tiene que ser un objeto { path, name }`); return; }
        for (const k of clavesFuera(h, VOCABULARIO.hermano)) err(null, `«siblings»[${i}]: clave «${k}» fuera del vocabulario (van: ${VOCABULARIO.hermano.join(', ')})`);
        if (!rutaSegura(h.path)) err(null, `«siblings»[${i}]: la ruta («path») tiene que ser relativa, sin «..» ni tramos vacíos`);
        if (typeof h.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(h.name)) {
          err(null, `«siblings»[${i}]: el nombre («name») tiene que ser un identificador (una letra y después letras o dígitos)`);
        }
      });
    }
  }
  if (!Array.isArray(json.reviewers) || !json.reviewers.length) {
    err(null, '«reviewers» tiene que ser una lista no vacía');
    return errores;
  }
  const vistos = new Set();
  const gruposDe = new Map();   // agente → grupos en los que está (en ESTE paquete)
  json.reviewers.forEach((r, i) => {
    if (!esObjeto(r)) { err(null, `reviewers[${i}]: tiene que ser un objeto`); return; }
    const agente = typeof r.agent === 'string' ? r.agent : null;
    const e = (motivo) => err(agente || `reviewers[${i}]`, motivo);
    if (!agente || !/^[a-z0-9][a-z0-9-]*$/.test(agente)) { e('«agent» tiene que ser el nombre del agente (minúsculas y guiones)'); return; }
    for (const k of clavesFuera(r, VOCABULARIO.revisor)) {
      e(`clave «${k}» fuera del vocabulario del revisor (van: ${VOCABULARIO.revisor.join(', ')})`);
    }
    if (!VOCABULARIO.grupos.includes(r.group)) e(`«group» tiene que ser uno de: ${VOCABULARIO.grupos.join(' | ')}`);
    const m = validarCondicion(r.when, banderas);
    if (m) e(m);
    if (r.group !== 'validacion') {
      const ms = validarSuperficie(r.surface);
      if (ms) e(ms);
      if (!VOCABULARIO.profundidades.includes(r.depth)) e(`«depth» tiene que ser uno de: ${VOCABULARIO.profundidades.join(' | ')}`);
      if (r.prompt != null) e('«prompt» sólo va en el grupo validacion');
    } else {
      if (typeof r.prompt !== 'string' || !r.prompt) e('un revisor del grupo validacion lleva «prompt» (con {story_path} y {repo_path})');
      if (r.surface != null) e('«surface» no aplica al grupo validacion (no hay vueltas en el paso 1)');
      if (r.depth != null) e('«depth» no aplica al grupo validacion: va «model»');
    }
    if (r.model != null && typeof r.model !== 'string') e('«model» tiene que ser un string');
    if (r.note != null && typeof r.note !== 'string') e('«note» tiene que ser un string');
    if (!Array.isArray(r.prefixes) || !r.prefixes.every((p) => typeof p === 'string' && /^[A-Z][A-Z0-9]*$/.test(p))) {
      e('«prefixes» tiene que ser una lista de prefijos de reglas en mayúsculas (ej. ["DOTNET"])');
    }
    if (r.needsStory != null && typeof r.needsStory !== 'boolean') e('«needsStory» tiene que ser true/false');
    // duplicados
    if (nucleo.includes(agente)) e('ya lo declara el núcleo del pipeline: un paquete no puede redeclararlo');
    const otro = yaDeclarados.get(agente);
    if (otro) e(`ya lo declara otro paquete («${otro.paquete}», ${otro.archivo})`);
    const clave = `${agente}\0${r.group}`;
    if (vistos.has(clave)) e(`repetido en el grupo «${r.group}» dentro del mismo paquete`);
    vistos.add(clave);
    if (!gruposDe.has(agente)) gruposDe.set(agente, new Set());
    gruposDe.get(agente).add(r.group);
    // el agente existe: primero en la carpeta del paquete, después en la de la raíz; en las dos, roto
    const md = path.join(agentsDir, `${agente}.md`);
    const propio = carpetaPropia.agents ? path.join(carpetaPropia.agents, `${agente}.md`) : null;
    if (propio && fs.existsSync(propio) && fs.existsSync(md)) e(`el agente ${agente} está en dos lugares (${propio} y en la raíz, ${md}): va en uno solo`);
    else if (!(propio && fs.existsSync(propio)) && !fs.existsSync(md)) e(`no existe el agente ${propio ? `${propio} ni ${md}` : md}`);
  });
  // Un revisor del paso 5 tiene UNA superficie y UNA profundidad: en `base` o en `condicional`, no en
  // los dos (con los dos, `superficieDe`/`tierDe` tomarían la primera entrada y la otra se ignoraría
  // en silencio). Con `validacion` sí puede convivir.
  for (const [agente, grupos] of gruposDe) {
    if (grupos.has('base') && grupos.has('condicional')) {
      err(agente, 'está en «base» y en «condicional» del mismo paquete: va en uno solo (una sola superficie y profundidad por revisor del paso 5)');
    }
  }
  return errores;
}

/** Del manifiesto (claves nuevas) al revisor que devuelve esta biblioteca: los nombres de siempre, que son los que
 *  viajan en las salidas JSON del pipeline. La condición va tal cual
 *  (claves nuevas: la evalúa `evaluarCondicion`). */
function normalizarRevisor(r) {
  return {
    agente: r.agent,
    grupo: r.group,
    cuando: r.when,
    superficie: r.surface || null,
    profundidad: r.depth || null,
    prefijos: r.prefixes || [],
    necesitaStory: r.needsStory === true,
    prompt: r.prompt || null,
    modelo: r.model || null,
    nota: r.note || null,
  };
}

// ── carga (con caché por carpeta) ──────────────────────────────────────────────────────────────
const _cache = new Map();
function resetCache() { _cache.clear(); }

/**
 * Descubre, lee y valida TODOS los paquetes instalados. Tira PackError con la lista completa de
 * errores; devuelve `[{ nombre, dir, archivo, descripcion, guias, revisores }]` ordenados por nombre.
 */
function cargarPaquetes({ packsDir, agentsDir, nucleo = [], banderas = [] } = {}) {
  const explicito = !!packsDir || !!process.env.TYCON_PACKS_DIR;
  const dirP = packsDir || dirPaquetes();
  const dirA = agentsDir || dirAgentes();
  const clave = [dirP, dirA, nucleo.join(','), banderas.join(',')].join('\0');
  if (_cache.has(clave)) return _cache.get(clave);

  const errores = [];
  const paquetes = [];
  const yaDeclarados = new Map();
  for (const p of descubrir(dirP, explicito)) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(p.archivo, 'utf8'));
    } catch (e) {
      errores.push({ archivo: p.archivo, revisor: null, motivo: `JSON inválido o ilegible: ${e.message}` });
      continue;
    }
    // claves viejas → nuevas (un paquete de afuera escrito con las claves en castellano). Una vieja y su nueva con valores
    // distintos es un paquete roto, nunca «sin ese paquete».
    try {
      json = require('./legacy-names.js').readPackKeys(json);
    } catch (e) {
      errores.push({ archivo: p.archivo, revisor: null, motivo: `claves viejas y nuevas en conflicto: ${e.message}` });
      continue;
    }
    const propios = validarManifiesto(json, { archivo: p.archivo, agentsDir: dirA, nucleo, banderas, yaDeclarados });
    errores.push(...propios);
    if (propios.length) continue;
    for (const r of json.reviewers) {
      if (!yaDeclarados.has(r.agent)) yaDeclarados.set(r.agent, { paquete: json.name, archivo: p.archivo });
    }
    // lo que devuelve, con los nombres en castellano (ver «LAS CLAVES EN CASTELLANO» arriba)
    paquetes.push({
      nombre: json.name, dir: p.dir, archivo: p.archivo,
      descripcion: json.description, guias: json.guides || [],
      skills: json.skills ? path.join(p.dir, json.skills) : null,
      agentes: json.agents ? path.join(p.dir, json.agents) : null,
      revisores: json.reviewers.map(normalizarRevisor),
      hermanos: (json.siblings || []).map((h) => ({ ruta: h.path, nombre: h.name })),
    });
  }
  if (errores.length) throw new PackError(errores);
  _cache.set(clave, paquetes);
  return paquetes;
}

/**
 * Las banderas que produce `detectStack` (las únicas válidas en una condición `when`). Viven acá —y `pipeline.js` las
 * importa— para que validar un árbol no tenga que cargar el pipeline entero.
 */
const BANDERAS = Object.freeze([
  'hasNext', 'hasReact', 'csModified', 'tsxModified', 'shModified', 'codeModified',
  'pyModified', 'svelteModified', 'vueModified', 'sourceModified',
  'pluginCfgModified', 'secretCfgModified', 'depChanged', 'onlyDocs',
]);

/**
 * El contrato chico y estable que el instalador carga de LA VERSIÓN QUE VA A QUEDAR para validar la capa del equipo antes
 * de apilarla: los paquetes de `packsDir` con los agentes de `agentsDir`, contra el núcleo
 * dado. Carpetas explícitas: nunca lee TYCON_PACKS_DIR ni TYCON_AGENTS_DIR, ni la caché. Nunca tira: devuelve la lista de
 * errores `[{ archivo, revisor, motivo }]` (vacía si todo vale).
 */
function validateTree({ packsDir, agentsDir, nucleo = [], banderas = BANDERAS } = {}) {
  if (!packsDir || !agentsDir) return [{ archivo: String(packsDir || '(sin carpeta de paquetes)'), revisor: null, motivo: 'validateTree necesita las dos carpetas explícitas (packsDir y agentsDir)' }];
  const errores = [];
  const yaDeclarados = new Map();
  let encontrados = [];
  try { encontrados = descubrir(packsDir, true); } catch (e) { return [{ archivo: packsDir, revisor: null, motivo: `no pude recorrer los paquetes (${e.message})` }]; }
  for (const p of encontrados) {
    let json;
    try { json = JSON.parse(fs.readFileSync(p.archivo, 'utf8')); } catch (e) { errores.push({ archivo: p.archivo, revisor: null, motivo: `JSON inválido o ilegible: ${e.message}` }); continue; }
    try { json = require('./legacy-names.js').readPackKeys(json); } catch (e) { errores.push({ archivo: p.archivo, revisor: null, motivo: `claves viejas y nuevas en conflicto: ${e.message}` }); continue; }
    const propios = validarManifiesto(json, { archivo: p.archivo, agentsDir, nucleo, banderas, yaDeclarados });
    errores.push(...propios);
    if (propios.length || !Array.isArray(json.reviewers)) continue;
    for (const r of json.reviewers) if (r && !yaDeclarados.has(r.agent)) yaDeclarados.set(r.agent, { paquete: json.name, archivo: p.archivo });
  }
  return errores;
}

// ── `packs:` del repo (.tycon/advisors.yaml) ───────────────────────────────────────────────────
/** El nombre actual de un paquete: un repo de producto puede nombrarlo con el viejo (`clientes` → `clients`)
 *  hasta que lo actualice, así que se traduce al leer. */
function nombreActual(nombre) {
  return require('./legacy-names.js').nombreDePaquete(nombre);
}

/** Una clave `packs:` que no es una lista (nula, `~`, sin ítems). El que la lee decide cómo avisar. */
class PacksDeclaradosError extends Error {
  constructor(motivo) { super(motivo); this.name = 'PacksDeclaradosError'; }
}

const sinComentario = (s) => String(s).replace(/(^|\s)#.*$/, '').trim();
// Recorte de comillas DESPUÉS del trim: sin eso `[bizuit, "clientes"]` traería `"clientes` (comilla viva) y el
// pipeline frenaría por una config correcta.
const limpiarItem = (s) => sinComentario(s).replace(/^(['"])(.*)\1$/, '$2').trim();

/**
 * Lista declarada en la clave top-level `packs:` de un YAML (parser mínimo, sin dependencias — el
 * mismo criterio que `i18nRequired` del pipeline). null si no está la clave; [] si está vacía (`[]`).
 *
 * Formas que se leen (todas YAML válido; leer mal alguna deja al repo con CERO paquetes en silencio): lista en
 * bloque con ítems indentados o en
 * columna 0; flow en una línea o en varias (`[` … `]`); comillas con o sin espacio tras la coma;
 * comentario en la línea de la clave; BOM al inicio del archivo; un escalar suelto.
 * Una clave sin lista (`packs:` a secas, `~`, `null`, sólo comentarios) NO es «ninguno» ni «todos los paquetes»:
 * tira PacksDeclaradosError — o se declara la lista o se quita la clave.
 */
function paquetesDeclarados(txt) {
  const lineas = String(txt || '').replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(/^packs\s*:(.*)$/);
    if (!m) continue;
    let valor = sinComentario(m[1]);
    let j = i + 1;
    // flow en varias líneas: `packs: [` … `]`
    if (valor.startsWith('[') && !valor.endsWith(']')) {
      for (; j < lineas.length && !valor.endsWith(']'); j++) valor = (valor + ' ' + sinComentario(lineas[j])).trim();
      if (!valor.endsWith(']')) throw new PacksDeclaradosError('`packs:` abre una lista `[` que no se cierra');
    }
    const flow = valor.match(/^\[(.*)\]$/);
    if (flow) return flow[1].split(',').map(limpiarItem).filter(Boolean);
    if (/^(~|null)$/i.test(valor)) throw new PacksDeclaradosError('`packs:` es nulo (`~`/`null`): o se declara la lista o se quita la clave');
    if (valor) return [limpiarItem(valor)];
    // bloque: ítems `- x` (indentados o en columna 0) hasta la primera línea que no sea ítem
    const out = [];
    let vioItem = false;
    for (; j < lineas.length; j++) {
      const l = lineas[j];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const item = l.match(/^\s*-\s*(.*)$/);
      if (!item) break;   // otra clave: terminó la lista
      vioItem = true;
      const v = limpiarItem(item[1]);
      if (v) out.push(v);
    }
    if (!vioItem) throw new PacksDeclaradosError('`packs:` está sin lista (ni ítems `- nombre` ni `[…]`): o se declara la lista o se quita la clave');
    return out;
  }
  return null;
}

/**
 * La declaración del repo: null si no hay clave `packs:`; [] o [nombres] si la hay. Una clave sin
 * lista o una configuración ilegible → PackError (nombra el archivo).
 */
function declaracionDelRepo(repo) {
  const yaml = repo ? yamlDelRepo(repo) : null;
  if (!yaml) return { archivo: null, declarados: null };
  try {
    const declarados = paquetesDeclarados(yaml.txt);
    return { archivo: yaml.archivo, declarados: declarados && declarados.map((n) => nombreActual(n)) };
  } catch (e) {
    if (e instanceof PacksDeclaradosError) throw new PackError([{ archivo: yaml.archivo, revisor: null, motivo: e.message }]);
    throw e;
  }
}

function yamlDelRepo(repo) {
  for (const n of ['advisors.yaml', 'advisors.yml']) {
    const p = path.join(repo, '.tycon', n);
    try {
      return { archivo: p, txt: fs.readFileSync(p, 'utf8').replace(/^﻿/, '') };
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;   // no está con ese nombre: probar el siguiente
      // Ilegible por OTRA causa (permisos, es una carpeta…): NO es «sin restricción declarada». Si el
      // repo tenía una lista `packs:` y se ignora, el set cambia sin que nadie lo vea.
      throw new PackError([{ archivo: p, revisor: null,
        motivo: `no se pudo leer la configuración del repo (${(e && e.code) || e.message}); una lista \`packs:\` ilegible no se ignora` }]);
    }
  }
  return null;
}

// ── el default sin `packs:` ─────────────────────────────────────────
const PACKS_DEFAULT_KEY = 'packs.default';
const PACKS_DEFAULT_VALUES = Object.freeze(['all', 'none']);
// Una lista de nombres: la misma regla que el lector del arnés (`motivoPaquetes` de tycon-config.js), que
// esta biblioteca no puede cargar cuando la variable ya responde sin buscar el arnés.
const NOMBRE_DE_PAQUETE = /^[a-z0-9][a-z0-9-]*$/;
const PACKS_DEFAULT_TEXT = 'all, none o una lista de nombres de paquete';
/** null si el valor es `all`, `none` o una lista no vacía de nombres distintos; si no, el motivo. */
function motivoDeDefault(v) {
  if (typeof v === 'string') return PACKS_DEFAULT_VALUES.includes(v) ? null : `vale ${JSON.stringify(v)}; tiene que ser ${PACKS_DEFAULT_TEXT}`;
  if (!Array.isArray(v) || !v.length) return `vale ${JSON.stringify(v)}; tiene que ser ${PACKS_DEFAULT_TEXT} (no vacía: para ninguno, none)`;
  const malo = v.find((n) => typeof n !== 'string' || !NOMBRE_DE_PAQUETE.test(n));
  if (malo !== undefined) return `${JSON.stringify(malo)} no es un nombre de paquete (minúsculas, dígitos y guiones)`;
  if (new Set(v).size !== v.length) return `la lista repite un paquete: ${JSON.stringify(v)}`;
  return null;
}
/** Cómo se dice el valor en una línea: `all`, `none` o `[a, b]`. */
const textoDeDefault = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));

/**
 * Qué paquetes activa un repo que NO declara `packs:`: lo dice la clave `packs.default` del lector de configuración del
 * arnés (`scripts/lib/tycon-config.js`: la variable `TYCON_PACKS_DEFAULT` › `team-profile.json` (o el nombre de antes) › el archivo de la
 * máquina › `none`). En esta clave el perfil del equipo le gana a lo que la máquina eligió al instalar: acá
 * no hay un orden propio, lo decide el lector. Un paquete opcional es uno que quien no lo usa no tiene que apagar: afuera,
 * sin perfil, ninguno; el perfil del equipo dice `all`. El arnés se ubica como lo ubica el pipeline (lib/harness-path.js).
 *   · arnés no encontrado, lector que no carga o configuración rota → PackError nombrando archivo, clave y motivo: una
 *     configuración rota nunca se lee como «ninguno»;
 *   · un arnés cuyo lector no conoce la clave, o que no tiene lector → `all`: así el orden en que se mergean los dos
 *     repos no le quita los revisores del paquete al equipo ni un minuto.
 * El valor puede ser también una lista: la organización activa exactamente esos paquetes. Por la
 * variable, separada por comas (`bizuit,clients`).
 * @returns {{ value: 'all'|'none'|string[], origin: string, harness: string }}
 */
function packsDefault({ env = process.env } = {}) {
  // La variable manda sobre todo (la precedencia de tycon-config): puesta, el default se sabe sin buscar el arnés. Un
  // valor que no es de la lista frena nombrándola, como frenaría el lector.
  // recortada, y sólo espacios = sin poner: como la lee tycon-config.js (los dos lectores no pueden dar distinto)
  const variable = typeof env.TYCON_PACKS_DEFAULT === 'string' ? env.TYCON_PACKS_DEFAULT.trim() : '';
  if (variable !== '') {
    const value = PACKS_DEFAULT_VALUES.includes(variable) ? variable : variable.split(',').map((x) => x.trim());
    const m = motivoDeDefault(value);
    if (m) {
      throw new PackError([{ archivo: 'variable de entorno TYCON_PACKS_DEFAULT', revisor: null, clave: PACKS_DEFAULT_KEY,
        motivo: m.startsWith('vale ') ? `vale ${JSON.stringify(variable)}; tiene que ser ${PACKS_DEFAULT_TEXT}` : m }]);
    }
    return { value, origin: 'TYCON_PACKS_DEFAULT', harness: null };
  }
  let harness;
  try {
    harness = require('./harness-path.js').rutaArnes({ env });
  } catch (e) {
    throw new PackError([{ archivo: 'el arnés', revisor: null, clave: PACKS_DEFAULT_KEY,
      motivo: `no lo encuentro, y sin él no sé qué paquetes activar en un repo que no declara \`packs:\` — ${e.message}` }]);
  }
  const reader = path.join(harness, 'scripts', 'lib', 'tycon-config.js');
  if (!fs.existsSync(reader)) return { value: 'all', origin: 'arnés anterior a la 8.7 (sin lector de configuración)', harness };
  let cfg;
  try { cfg = require(reader); } catch (e) {
    throw new PackError([{ archivo: reader, revisor: null, clave: PACKS_DEFAULT_KEY, motivo: `el lector de configuración no carga (${e.message})` }]);
  }
  const knowsKey = !!(cfg.VOCABULARIO && cfg.VOCABULARIO.packs && cfg.VOCABULARIO.packs.default);
  if (!knowsKey) return { value: 'all', origin: 'arnés anterior a la 8.7 (su lector no conoce packs.default)', harness };
  let config;
  try { config = cfg.leer({ env }); } catch (e) {
    const errores = Array.isArray(e && e.errores) && e.errores.length
      ? e.errores.map((x) => ({ archivo: x.archivo, revisor: null, clave: x.clave || PACKS_DEFAULT_KEY, motivo: x.motivo }))
      : [{ archivo: reader, revisor: null, clave: PACKS_DEFAULT_KEY, motivo: `no se pudo leer la configuración (${e && e.message})` }];
    throw new PackError(errores);
  }
  const value = cfg.valor(config, PACKS_DEFAULT_KEY);
  if (motivoDeDefault(value)) {
    throw new PackError([{ archivo: reader, revisor: null, clave: PACKS_DEFAULT_KEY,
      motivo: `el lector devolvió ${JSON.stringify(value)}; tiene que ser ${PACKS_DEFAULT_TEXT}` }]);
  }
  return { value, origin: (config.origenes && config.origenes[PACKS_DEFAULT_KEY]) || 'default', harness };
}

/**
 * Los paquetes ACTIVOS en un repo: si el repo declara `packs:`, exactamente esa lista (en el orden de instalación; un
 * nombre no instalado → PackError); si no, los que diga `packs.default` (`all`: todos los instalados; `none`: ninguno).
 * Sin paquetes instalados no hay nada que decidir y no se le pregunta al arnés.
 */
function paquetesActivos({ repo, instalados, packsDir } = {}) {
  const { archivo, declarados } = declaracionDelRepo(repo);
  if (declarados === null && !instalados.length) {
    // sin paquetes instalados no hay nada que activar… salvo que la organización pida paquetes por nombre: eso es una
    // máquina sin los paquetes de su organización, y se dice. Sin arnés ni variable que responder, como siempre: ninguno
    let def = null;
    // sólo «no encuentro el arnés» se lee como «ninguno»; una configuración rota frena como en cualquier otro caso
    try { def = packsDefault(); } catch (e) { if (!(e instanceof PackError && e.errores.length > 0 && e.errores.every((x) => x.archivo === 'el arnés'))) throw e; }
    if (def && Array.isArray(def.value)) activosDeLaOrganizacion({ instalados, dir: packsDir || dirPaquetes() });
    return instalados;
  }
  if (declarados !== null && !declarados.length) return [];   // `packs: []`: ninguno, a propósito
  const dir = packsDir || dirPaquetes();
  const nombres = instalados.map((p) => p.nombre).join(', ') || 'ninguno';
  const faltan = (declarados || []).filter((n) => !instalados.some((p) => p.nombre === n));
  if (faltan.length) {
    throw new PackError(faltan.map((n) => ({
      archivo, revisor: null,
      motivo: `el repo declara el paquete «${n}» en \`packs:\` y no está instalado en ${dir} (instalados: ${nombres})`,
    })));
  }
  const org = activosDeLaOrganizacion({ instalados, dir });
  if (declarados === null) return org;
  // el repo achica lo que activa la organización y nunca suma
  const fuera = declarados.filter((n) => !org.some((p) => p.nombre === n));
  if (fuera.length) {
    throw new PackError(fuera.map((n) => ({
      archivo, revisor: null,
      motivo: `el repo declara el paquete «${n}» en \`packs:\` y la organización no lo activó — activalo en Configuración del sitio, sección Paquetes, o en el perfil del equipo (packs.default; en esta máquina, TYCON_PACKS_DEFAULT)`,
    })));
  }
  return instalados.filter((p) => declarados.includes(p.nombre));
}

/** Los paquetes instalados que activa la organización (`packs.default`). Uno de una lista que no está instalado frena
 *  nombrando la carpeta donde se buscó: la organización pide algo que esta máquina no tiene. */
function activosDeLaOrganizacion({ instalados, dir }) {
  const { value, origin } = packsDefault();
  if (value === 'all') return instalados;
  if (value === 'none') return [];
  const faltan = value.filter((n) => !instalados.some((p) => p.nombre === n));
  if (faltan.length) {
    throw new PackError(faltan.map((n) => ({
      archivo: `packs.default (${origin})`, revisor: null, clave: PACKS_DEFAULT_KEY,
      motivo: `la organización activa el paquete «${n}» y no está instalado en ${dir} (instalados: ${instalados.map((p) => p.nombre).join(', ') || 'ninguno'}) — ${queHacerSiFalta(origin)}`,
    })));
  }
  return instalados.filter((p) => value.includes(p.nombre));
}

/** Qué hacer cuando falta un paquete activo, según de dónde sale el pedido: las mismas palabras que doctor
 *  (scripts/lib/pack-pieces.js, missingPackHint). */
function queHacerSiFalta(origin) {
  try {
    return require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'pack-pieces.js')).missingPackHint(origin);
  } catch (e) {
    return `sacalo de packs.default (${origin}) o instalalo (no pude leer el resto de la ayuda: ${e.code || e.message})`;
  }
}

// ── evaluación ─────────────────────────────────────────────────────────────────────────────────
/**
 * ctx = { det: <banderas de detectStack>, files: [rutas del diff], agregado(extensiones) → [{file, content}] }
 * Una clave desconocida acá es un defecto de validación previa: se tira, no se devuelve falso.
 */
function evaluarCondicion(cuando, ctx) {
  const [clave] = Object.keys(cuando);
  const valor = cuando[clave];
  switch (clave) {
    case 'all': return valor.every((c) => evaluarCondicion(c, ctx));
    case 'any': return valor.some((c) => evaluarCondicion(c, ctx));
    case 'no': return !evaluarCondicion(valor, ctx);
    case 'detection': return !!(ctx.det && ctx.det[valor]);
    case 'files': { const re = new RegExp(valor); return (ctx.files || []).some((f) => re.test(f)); }
    case 'added': {
      const re = new RegExp(valor.pattern);
      return (ctx.agregado(valor.extensions) || []).some((c) => re.test(c.content));
    }
    default: throw new Error(`condición con clave desconocida «${clave}» — el manifiesto no pasó por validarManifiesto`);
  }
}

/** Rinde un prompt del grupo validacion: {story_path} y {repo_path}. Reemplazo por función: un `$&`
 *  o `$'` dentro de una ruta no se expande (String.replace con string sí lo haría). */
function rendirPrompt(prompt, { story_path, repo_path, siblings }) {
  return String(prompt || '')
    .replace(/\{story_path\}/g, () => story_path || '')
    .replace(/\{repo_path\}/g, () => repo_path || '')
    .replace(/\{siblings\}/g, () => siblings || '');
}

/**
 * Los hermanos que declaran los paquetes (`siblings`), cada uno en su ruta esperada bajo la raíz de repos. No se recorre
 * ninguna carpeta: sólo se mira si esa ruta existe. Un revisor que los buscara por el disco caería en repos que no
 * son hermanos; una raíz distinta en otra máquina se arregla declarándola, no buscando. Sin raíz, ninguno «está».
 * @returns {Array<{ paquete, nombre, ruta, rutaEsperada: string|null, esta: boolean }>}
 */
function hermanosResueltos({ paquetes = [], reposRoot = null } = {}) {
  const out = [];
  for (const p of paquetes) {
    for (const h of p.hermanos || []) {
      const rutaEsperada = reposRoot ? path.join(reposRoot, ...String(h.ruta).split('/')) : null;
      let esta = false;
      if (rutaEsperada) { try { esta = fs.statSync(rutaEsperada).isDirectory(); } catch (_e) { esta = false; } }
      out.push({ paquete: p.nombre, nombre: h.nombre, ruta: h.ruta, rutaEsperada, esta });
    }
  }
  return out;
}

/** Lo que recibe el pedido en `{siblings}`: una línea por hermano, y qué hacer con el que no está. */
function textoDeHermanos(lista, { reposRoot = null } = {}) {
  if (!lista.length) return '(no hay hermanos declarados: no se buscan)';
  const lineas = lista.map((h) => (h.esta
    ? `- ${h.nombre}: ${h.rutaEsperada} (está)`
    : `- ${h.nombre}: ${h.rutaEsperada || h.ruta} (NO está en esta máquina: no lo busques en otro lado)`));
  if (!reposRoot) lineas.push('(no sé cuál es la raíz de repos de esta máquina: se declara con TYCON_REPOS_ROOT)');
  return lineas.join('\n');
}

/**
 * Por qué no hay paquetes activos, para que se vea en la primera corrida: «ningún paquete instalado» y «N instalados y
 * ninguno activo» son dos cosas distintas. Una máquina con el paquete bizuit instalado y `packs.default` en `none`
 * porque el perfil del equipo no viajó, si anunciara «no hay paquetes instalados», revisaría con menos revisores sin que
 * nadie lo viera como pérdida. Con paquetes activos, null.
 */
function notaDePaquetes({ repo, instalados, activos, packsDir } = {}) {
  if (activos && activos.length) return null;
  const dir = packsDir || dirPaquetes();
  if (!instalados || !instalados.length) return `ningún paquete instalado en ${dir}`;
  const nombres = instalados.map((p) => p.nombre).sort().join(', ');
  const n = instalados.length;
  const { archivo, declarados } = declaracionDelRepo(repo);
  const cabeza = `${n} paquete${n === 1 ? '' : 's'} instalado${n === 1 ? '' : 's'} (${nombres}) y ninguno activo: `;
  if (declarados !== null) return `${cabeza}el repo declara packs: [] en ${archivo} (restringido a ninguno a propósito)`;
  const def = packsDefault();
  // con el perfil del equipo PRESENTE y diciendo `none`, «el perfil está ausente» sería falso (en esta clave
  // el perfil gana, así que un `none` con origen en el perfil es una decisión del equipo, no un perfil que no viajó)
  // qué paquetes activa la organización lo dice su configuración, no el repo: un repo sólo achica la lista
  const v = textoDeDefault(def.value);
  if (def.origin === 'perfil') return `${cabeza}packs.default es ${v} (${def.origin}) y el repo no declara packs: — lo fija el perfil del equipo; qué paquetes activa tu organización se cambia en Configuración del sitio, sección Paquetes, o en el perfil del equipo`;
  return `${cabeza}packs.default es ${v} (${def.origin}) y el repo no declara packs: — en una máquina del equipo eso es el perfil del equipo ausente: packs.default all lo prende (qué paquetes activa tu organización: Configuración del sitio, sección Paquetes, o el perfil del equipo)`;
}

module.exports = {
  VOCABULARIO, PackError, PacksDeclaradosError,
  raizAgentSkills, dirPaquetes, dirAgentes,
  descubrir, nombresInstalados, cargarPaquetes, resetCache, BANDERAS, validateTree,
  validarManifiesto, validarCondicion, validarSuperficie,
  paquetesDeclarados, declaracionDelRepo, paquetesActivos, activosDeLaOrganizacion, queHacerSiFalta, nombreActual, packsDefault, notaDePaquetes, textoDeDefault,
  evaluarCondicion, rendirPrompt, hermanosResueltos, textoDeHermanos,
};
