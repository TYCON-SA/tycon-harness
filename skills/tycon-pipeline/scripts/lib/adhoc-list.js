'use strict';
/**
 * adhoc-list.js — la lista de archivos de un camino corto.
 *
 * Todo camino corto nuevo se abre con la lista cerrada de los archivos que va a tocar (`allowedFiles` en `adhoc set`,
 * o `--file` repetida en la terminal de la persona). Este módulo la normaliza y la valida, cuenta sus archivos de código,
 * mira el motivo (en una línea; con varios temas o vago no lo abre nadie que no sea una persona) y dice si una ruta cae
 * fuera de la lista. Lo usan `marker.js adhoc set`, el portón de carril (`adhoc-out-of-list`), el freno de guardar y la
 * medida de una parte de una historia (`batch-scope.js`), con la misma comparación de rutas.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// `*` y `?`: los corchetes y las llaves son nombres de verdad en las rutas dinámicas (`app/[id]/page.tsx`)
const COMODIN = /[*?]/;
// la evidencia del arnés: los registros de `.advisors/` y lo que el pase guarda de cada prueba (`*.txt`, COMO-SE-CORRIO)
const EVIDENCIA = /^\.advisors\/(.+\.(json|jsonl|md)|pipeline-runs\/[^/]+\/step-05b-probes\/.+)$/i;
const MEMORIA = /^\.engram\/(manifest\.json|chunks\/[^/]+\.jsonl\.gz)$/;
// los nombres de un motivo que no dice qué se arregla
const VAGO = /(^|[^\p{L}])(varios|varias|arreglos|pendientes?|etc\.?|cosas|otros|otras)(?=$|[^\p{L}])/iu;

const norm = (p) => String(p || '').replace(/\\/g, '/');

// En Windows la letra de unidad no distingue mayúsculas: VS Code abre la carpeta como `d:\…` y el editor pasa `D:\…`, y
// `realpathSync` deja la letra como vino. La lista se guarda y se compara con la letra en mayúscula. Una ruta de Mac o
// Linux empieza con `/` y no cambia.
const unidadEnMayuscula = (p) => String(p).replace(/^([a-z]):(?=[\\/]|$)/, (_, l) => `${l.toUpperCase()}:`);

/** La ruta con los enlaces resueltos, aunque el final todavía no exista. */
function sinEnlaces(p) {
  const abs = unidadEnMayuscula(path.resolve(String(p)));
  const resto = [];
  let cabeza = abs;
  for (;;) {
    try { return unidadEnMayuscula(path.join(fs.realpathSync(cabeza), ...resto)); } catch (_) { /* no existe: se sube uno */ }
    const arriba = path.dirname(cabeza);
    if (arriba === cabeza) return abs;
    resto.unshift(path.basename(cabeza));
    cabeza = arriba;
  }
}

/** La ruta con sus carpetas reales y el último nombre tal cual (sin seguir el enlace del final). */
function escritoDe(p) {
  const r = path.resolve(String(p));
  return path.join(sinEnlaces(path.dirname(r)), path.basename(r));
}

/** Las entradas de una lista pedida: `{ lista }` con las rutas absolutas reales, ordenadas y sin repetir, o `{ problema }`. */
function normalizar(entradas, { cwd = process.cwd() } = {}) {
  if (entradas === undefined || entradas === null) return { problema: 'falta la lista de archivos ("allowedFiles"): el camino corto se abre con los archivos que va a tocar, uno por uno' };
  if (!Array.isArray(entradas) || !entradas.length) return { problema: 'la lista de archivos ("allowedFiles") está vacía: nombrá los archivos que va a tocar, uno por uno' };
  const out = new Set();
  const sinRepo = [];
  const hermanos = new Map();
  for (const e of entradas) {
    const s = typeof e === 'string' ? e.trim() : '';
    if (!s) return { problema: 'la lista de archivos tiene una entrada vacía' };
    if (COMODIN.test(s)) return { problema: `«${s}» tiene un comodín: la lista nombra los archivos uno por uno` };
    if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) return { problema: `«${s}» es una ruta absoluta: va relativa a la carpeta donde se pide` };
    if (/[\\/]$/.test(s)) return { problema: `«${s}» es una carpeta: la lista nombra archivos, uno por uno` };
    // `<Nombre>/<ruta>` de un repo hermano: se mira antes del «..», que sigue negado dentro de la ruta
    const h = deUnHermano(s, cwd, hermanos);
    if (h && h.problema) return { problema: h.problema };
    if (norm(s).split('/').includes('..')) return { problema: `«${s}» sube de carpeta con «..»: la lista nombra archivos de esta carpeta para abajo; la de un repo hermano va como <Nombre>/<ruta>` };
    const pedida = h ? path.join(h.raiz, h.resto) : path.resolve(cwd, s);
    const abs = sinEnlaces(pedida);
    // con los enlaces resueltos, la ruta de un hermano queda dentro de su raíz real
    if (h && !abs.startsWith(h.raiz + path.sep)) return { problema: `«${s}» sale de la raíz de ${h.nombre}` };
    // por un enlace de la carpeta propia (de una carpeta o del archivo), la ruta real puede caer en otro repo: vale el
    // propio o un hermano declarado, como con `<Nombre>/`
    // un enlace colgante del final no se resuelve: su destino se lee del enlace
    let destino = abs;
    try { if (fs.lstatSync(pedida).isSymbolicLink() && abs === unidadEnMayuscula(path.resolve(pedida))) destino = sinEnlaces(path.resolve(path.dirname(pedida), fs.readlinkSync(pedida))); } catch (_) { destino = abs; }
    if (!h && (destino !== path.join(sinEnlaces(cwd), s))) {
      const ajeno = repoAjenoPorEnlace(destino, cwd, hermanos);
      if (ajeno) return { problema: `«${s}» lleva, por un enlace, al ${ajeno}` };
    }
    let carpeta = false;
    try { carpeta = fs.statSync(abs).isDirectory(); } catch (_) { carpeta = false; }
    if (carpeta) return { problema: `«${s}» es una carpeta: la lista nombra archivos, uno por uno` };
    // pedida desde una carpeta que no es la del repo (la personal, por ejemplo), la lista nombra archivos que nadie va a
    // editar, y cada edición real frena como fuera de la lista: se avisa, con la ruta completa
    if (!raizDe(abs)) sinRepo.push(abs);
    // el nombre como se escribió (con sus carpetas reales): si es un enlace, la lista lo nombra a él, no a su destino
    out.add(escritoDe(pedida));
  }
  return { lista: [...out].sort(), sinRepo, hermanos };
}

/**
 * Si la ruta real `abs` cae en un repo que no es el de `cwd` (otro checkout del mismo cuenta como el mismo) ni un hermano
 * declarado: el texto de cuál y por qué, o null. Un hermano que se alcanza así se suma a `hermanos`. Fuera de todo repo,
 * o pedida desde una carpeta que no es de un repo, null: eso lo avisa `sinRepo`.
 */
function repoAjenoPorEnlace(abs, cwd, hermanos) {
  const raiz = raizDe(abs);
  const propia = raizDe(sinEnlaces(cwd));
  if (!raiz || !propia || raiz === propia) return null;
  const RG = require('./repo-group.js');
  const principal = RG.checkoutPrincipal(raiz);
  if (principal && principal === RG.checkoutPrincipal(cwd)) return null;
  const nombre = path.basename(principal || raiz);
  const h = RG.hermanoDeEdicion(cwd, nombre);
  if (!h.problema && h.raiz === (principal || raiz)) { hermanos.set(h.raiz, h.nombre); return null; }
  return `repo ${nombre}, que no vale como hermano${h.problema ? `: ${h.problema}` : ''}`;
}

/**
 * Si `s` es `<Nombre>/<ruta>` de un repo hermano (repo-group.js): `{ raiz, nombre, resto }`, o `{ problema }` si nombra
 * una carpeta al lado del repo que no vale como hermano, o es ambigua con una carpeta de `cwd`. null: una ruta de `cwd`,
 * como siempre. `hermanos` (raíz real → nombre) junta los resueltos.
 */
function deUnHermano(s, cwd, hermanos) {
  const RG = require('./repo-group.js');
  const p = RG.prefijoDeHermano(s, cwd);
  if (!p) return null;
  const malNombre = RG.problemaDelNombre(p.nombre);
  if (malNombre) return { problema: malNombre };
  const h = RG.hermanoDeEdicion(cwd, p.nombre);
  // una carpeta propia con el nombre de un repo de al lado: si el repo es un hermano declarado, no se sabe cuál es
  if (p.local) return h.problema ? null : { problema: `«${s}» es ambigua: ${p.nombre} es una carpeta de ${cwd} y también el repo hermano ${h.nombre}; renombrá la carpeta o pedí la lista desde otra` };
  // una carpeta común de al lado (no es un repo) que no está en el grupo: la entrada es una ruta de `cwd`, como siempre
  if (h.problema && h.fueraDelGrupo && !p.esRepo) return null;
  if (h.problema) return { problema: `«${s}» nombra el repo ${p.nombre}, que no vale como hermano: ${h.problema}` };
  hermanos.set(h.raiz, h.nombre);
  return { raiz: h.raiz, nombre: h.nombre, resto: p.resto };
}

/** La entrada de la lista como se escribe: `<Nombre>/<ruta>` para un hermano de `hermanos`, o relativa a `cwd`. */
function relDeLaLista(abs, cwd, hermanos = new Map()) {
  for (const [raiz, nombre] of hermanos) {
    if (abs.startsWith(raiz + path.sep)) return `${nombre}/${norm(path.relative(raiz, abs))}`;
  }
  // contra la carpeta real: la lista guarda rutas reales, y una carpeta pedida por un enlace daría `../…`
  return path.relative(sinEnlaces(cwd), abs) || abs;
}

/**
 * Si `repoRoot` es un repo al lado del checkout principal del repo de `cwd` que no vale como hermano: el texto de por
 * qué («el repo Z, que no está en repo_group de R…»), o null. Lo usa el portón de la lista al frenar.
 */
function repoVecinoFueraDelGrupo({ repoRoot, cwd }) {
  if (!repoRoot || !cwd) return null;
  try {
    const RG = require('./repo-group.js');
    const principal = RG.checkoutPrincipal(cwd);
    const raiz = sinEnlaces(repoRoot);
    if (!principal || raiz === principal || path.dirname(raiz) !== path.dirname(principal)) return null;
    const h = RG.hermanoDeEdicion(cwd, path.basename(raiz));
    return h.problema ? `el repo ${path.basename(raiz)}, que no vale como hermano de ${path.basename(principal)} (${h.problema})` : null;
  } catch (_) { return null; }
}

/** Los repos de una lista ya normalizada (sus raíces reales), sin repetir. */
function reposDeLaLista(lista) { return [...new Set((lista || []).map(raizDe).filter(Boolean))]; }

/**
 * El repo `nombre` del carril `adhoc`, para `adhoc test --repo`: `{ raiz }` o `{ problema }`. Vale el repo de la sesión
 * (el nombre de su checkout principal) o un hermano declarado en los dos sentidos, y tiene que tener archivos en la lista.
 */
function repoDelCarril(adhoc, nombre, { cwd = process.cwd() } = {}) {
  const RG = require('./repo-group.js');
  const mal = RG.problemaDelNombre(nombre);
  if (mal) return { problema: mal };
  const repos = reposDeLaLista(adhoc && adhoc.allowedFiles);
  const propio = RG.checkoutPrincipal(cwd);
  let raiz = null;
  if (propio && RG.clave(path.basename(propio)) === RG.clave(nombre)) {
    raiz = repos.find((r) => RG.checkoutPrincipal(r) === propio) || null;
  } else {
    const h = RG.hermanoDeEdicion(cwd, nombre);
    if (h.problema) return { problema: h.problema };
    // el hermano o una copia suya (`B--wt-x`, la rama de la historia): la que está en la lista, como con el propio
    const suyas = repos.filter((r) => r === h.raiz || RG.checkoutPrincipal(r) === h.raiz);
    if (suyas.length > 1) return { problema: `${nombre} tiene más de una copia en la lista de este camino corto (${suyas.join(', ')}): no sé en cuál correr` };
    raiz = suyas[0] || null;
  }
  if (!raiz) return { problema: `${nombre} no tiene archivos en la lista de este camino corto` };
  return { raiz };
}

/**
 * La carpeta de trabajo de la sesión `sesion`, para resolver la lista que otra sesión pide por ella (`--for-session`): el
 * `cwd` del último renglón que lo trae en su transcripción, `<casa>/.claude/projects/<carpeta>/<sesión>.jsonl`. Null si
 * no hay transcripción con ese id, si hay más de una, o si ninguna trae `cwd` (una sesión de Codex, por ejemplo). No se
 * toma de un texto que manda otra sesión ni de los registros por nombre, que vencen.
 */
function carpetaDeLaSesion({ casa = os.homedir(), sesion } = {}) {
  if (!/^[\w-]+$/.test(String(sesion || ''))) return null;
  const raiz = path.join(casa, '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(raiz, { withFileTypes: true }); } catch (_) { return null; }
  const halladas = dirs.filter((d) => d.isDirectory()).map((d) => path.join(raiz, d.name, `${sesion}.jsonl`)).filter((f) => fs.existsSync(f));
  if (halladas.length !== 1) return null;
  // desde el final, por bloques: una transcripción larga pasa los cientos de MB y no entra en un texto (ni conviene
  // cargarla dentro del freno); la carpeta está en los últimos renglones
  let fd;
  try { fd = fs.openSync(halladas[0], 'r'); } catch (_) { return null; }
  try {
    let pos = fs.fstatSync(fd).size;
    let resto = Buffer.alloc(0);
    let leidos = 0;
    while (pos > 0 && leidos < LECTURA_MAXIMA) {
      const n = Math.min(BLOQUE, pos);
      pos -= n;
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, pos);
      leidos += n;
      resto = Buffer.concat([b, resto]);
      // el primer renglón puede estar cortado: queda para la vuelta siguiente, salvo al llegar al principio
      const corte = pos > 0 ? resto.indexOf(10) : -1;
      const enteros = corte >= 0 ? resto.subarray(corte + 1) : (pos > 0 ? Buffer.alloc(0) : resto);
      resto = corte >= 0 ? resto.subarray(0, corte) : (pos > 0 ? resto : Buffer.alloc(0));
      const cwd = ultimoCwd(enteros.toString('utf8'));
      if (cwd) return cwd;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ya cerrado */ }
  }
}

// lo que se lee por vuelta y el tope: el último renglón con `cwd` está cerca del final; más allá de esto, «no sé»
const BLOQUE = 64 * 1024;
const LECTURA_MAXIMA = 64 * 1024 * 1024;

/** El `cwd` absoluto del último renglón de `texto` que lo trae, o null. */
function ultimoCwd(texto) {
  const renglones = texto.split('\n');
  for (let i = renglones.length - 1; i >= 0; i--) {
    if (!renglones[i].includes('"cwd"')) continue;
    try {
      const r = JSON.parse(renglones[i]);
      if (r && typeof r.cwd === 'string' && path.isAbsolute(r.cwd)) return r.cwd;
    } catch (_) { /* renglón a medias */ }
  }
  return null;
}

/** Las entradas de la lista `anterior` que no están en la `nueva`, con la letra de unidad sin distinguir mayúsculas. */
function faltanEnLaNueva(anterior, nueva) {
  const nuevas = new Set((nueva || []).map(unidadEnMayuscula));
  return (anterior || []).filter((f) => !nuevas.has(unidadEnMayuscula(f)));
}

/** La raíz del repo de una ruta (aunque el archivo todavía no exista), o null. */
function raizDe(abs) {
  try {
    const u = require('./adhoc-base.js').ubicar(abs);
    return u && u.raiz ? sinEnlaces(u.raiz) : null;
  } catch (_) { return null; }
}

/** ¿Cuenta como código para el cupo? La misma regla que el tope: un archivo de implementación, sin pruebas ni guías. */
function esCodigo(abs) {
  const gate = require('./story-gate.js');
  const { isImplPath } = require('./atdd-order.js');
  if (!gate.isCodeFile(abs)) return false;
  const raiz = raizDe(abs);
  return isImplPath(raiz ? norm(path.relative(raiz, abs)) : norm(abs));
}

/**
 * ¿Cuenta como código una ruta relativa, sin leer el remoto? Para lo que decide antes de abrir (la firma, la ventana).
 * Con `cwd`, la de un repo hermano (`<Nombre>/<ruta>`) se mira sin el prefijo, como la cuenta `esCodigo` en su repo.
 */
function esCodigoRel(rel, { cwd = null } = {}) {
  const gate = require('./story-gate.js');
  const { isImplPath } = require('./atdd-order.js');
  // como la cuenta `normalizar`: sin los espacios de los bordes (un espacio al final no saca un archivo del tope)
  let s = norm(String(rel || '').trim());
  const p = cwd ? require('./repo-group.js').prefijoDeHermano(s, cwd) : null;
  // sólo un repo de al lado: una carpeta común con ese nombre no saca el prefijo
  if (p && !p.local && p.esRepo) s = p.resto;
  return gate.isCodeFile(s) && isImplPath(s);
}

/** `{ codigo, total }` de una lista ya normalizada. `esCod` se pasa en las pruebas y en lo que no lee el disco. */
function contar(lista, { esCod = esCodigo } = {}) {
  return { codigo: lista.filter((f) => esCod(f)).length, total: lista.length };
}

/** Por qué una lista no entra en el cupo `cupo` (código hasta el cupo; el resto hasta el doble), o null. */
function problemaDeTopes(lista, cupo, opciones) {
  const { codigo, total } = contar(lista, opciones);
  if (codigo > cupo) return `la lista nombra ${codigo} archivos de código y el cupo es ${cupo}: pedí un cupo mayor o achicá la lista`;
  if (total > cupo * 2) return `la lista tiene ${total} entradas y el tope es el doble del cupo (${cupo * 2})`;
  return null;
}

/**
 * El motivo se muestra en un renglón: con un salto de línea, lo que no se ve no se aprueba. Los textos de este módulo
 * van en los dos perfiles (`harness`): en un producto hablan de vos y no nombran las piezas de mantenimiento.
 */
function problemaDelMotivo(reason, { harness = true } = {}) {
  if (!/[\r\n]/.test(String(reason || ''))) return null;
  return harness
    ? 'el motivo va en una línea: la ventana muestra un renglón, y ni una persona ni la coordinadora por delegación aprueban lo que no ven'
    : 'el motivo va en una línea: la ventana te muestra un renglón, y vos aprobás sólo lo que ves';
}

/** El rechazo de una lista inválida o fuera de los topes, con su uso. */
function rechazoDeLaLista(problema, { harness = true } = {}) {
  const uso = '  Uso: marker.js adhoc set \'{"reason":"<qué y por qué>","datos":"sin-cambio","allowedFiles":["<ruta>", …]}\' (en la terminal: --file <ruta> por cada archivo)';
  return harness
    ? `${problema}.\n${uso}`
    : `${problema}. La lista la escribís vos, archivo por archivo, y la aprobás con tu sí.\n${uso}`;
}

/** Ampliar sin una entrada que ya estaba aprobada: eso no se hace sin la persona. */
function textoDeAmpliar(faltan, { harness = true } = {}) {
  const cuales = faltan.join(', ');
  return harness
    ? `la lista nueva saca ${cuales}, que ya estaba firmada: por delegación la lista nueva contiene entera la firmada; sacar una entrada lo decide una persona`
    : `la lista nueva saca ${cuales}, que ya estaba aprobada: sacar una entrada lo decidís vos, en tu ventana`;
}

/** Un solo carril abierto sin la ventana por repo. */
function textoOtroCarril(sid, repo, { harness = true } = {}) {
  return harness
    ? `la sesión ${sid} ya tiene un camino corto delegado sobre ${repo}: uno por repo; otro lo abre una persona`
    : `la sesión ${sid} ya tiene un camino corto abierto sin tu ventana sobre ${repo}: uno así por repo; otro lo abrís vos, en tu ventana`;
}

/** ¿El motivo enumera varios temas? «;» o «+», dos o más comas, o una coma seguida de «y», «e» u «o». */
function variosTemas(reason) {
  const s = String(reason || '');
  if (/[;+]/.test(s)) return true;
  if ((s.match(/,/g) || []).length >= 2) return true;
  // una coma y después una «y», «e» u «o»: «a, b y c» es una enumeración; «a y su prueba», sin coma, no
  return /,[^,]*\s(y|e|o)(\s|$)/i.test(s);
}

/** ¿El motivo es vago? Nombra «varios», «arreglos», «pendientes», «etc.», «cosas» u «otros» en vez de qué se arregla. */
function vago(reason) { return VAGO.test(String(reason || '')); }

/**
 * Por qué este pedido no lo abre nadie más que una persona (la delegación de la coordinadora, o una pestaña sin
 * permisos que lo abriría «hecho y avisado»), o null.
 */
function sinUnaPersona({ reason, harness = true } = {}) {
  const quien = harness ? 'no lo abre la coordinadora por delegación: lo abre una persona' : 'lo abrís vos, en tu ventana';
  if (variosTemas(reason)) return `el motivo «${String(reason).slice(0, 80)}» tiene varios temas: un camino corto es un solo arreglo, y uno de varios ${quien}`;
  if (vago(reason)) return `el motivo «${String(reason).slice(0, 80)}» es vago: tiene que decir qué se arregla, y uno vago ${quien}`;
  return null;
}

/**
 * La primera ruta de riesgo alto que nombra una lista ya normalizada (la regla de `risk-paths.js`, repo por repo), o
 * null: `{ regla, archivo }`. Lo que no se pudo medir es riesgo alto («no-pude-saber»): en duda, lo abre una persona.
 */
function riesgoDeLaLista(lista) {
  const { riesgoDeArchivos } = require('./risk-paths.js');
  const porRepo = new Map();
  for (const f of lista) {
    const r = raizDe(f);
    if (!r) continue;
    if (!porRepo.has(r)) porRepo.set(r, []);
    porRepo.get(r).push(f);
  }
  for (const [repo, archivos] of porRepo) {
    let r;
    try { r = riesgoDeArchivos(archivos, { repo }); } catch (e) { return { regla: 'no-pude-saber', archivo: archivos[0] }; }
    if (r && r.value) return { regla: r.rule, archivo: r.file ? path.join(repo, r.file) : archivos[0] };
  }
  return null;
}

/** El renglón del riesgo alto para el resumen de la firma y los rechazos: la regla y el archivo. */
function textoDelRiesgo(riesgo, { cwd = process.cwd() } = {}) {
  if (!riesgo) return '';
  const rel = path.relative(cwd, riesgo.archivo || '') || riesgo.archivo;
  return `riesgo alto (regla: ${riesgo.regla}, ${rel})`;
}

/** ¿`rel` (relativa a su repo) es evidencia del pipeline o un trozo de memoria? Pasan sin nombrarlos. */
function esPapeleo(rel) { return EVIDENCIA.test(rel) || MEMORIA.test(rel); }

// el papeleo de lo que está en la lista: la constancia del cambio de un control (la escribe sólo el guion firmado; el
// portón niega editarla a mano) y el renglón de suites.json de una prueba nueva
const CONSTANCIA = /^\.github\/control-changes\/[^/]+\.json$/;
const SUITES = 'scripts/tests/suites.json';
// dónde vive cada raíz de suites.json dentro del repo del arnés (su `__raices`)
const CARPETA_DE_LA_RAIZ = { arnes: 'scripts', 'agent-skills': 'skills' };
const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const relSegura = (r) => typeof r === 'string' && r !== '' && !path.isAbsolute(r) && !norm(r).split('/').includes('..');

/**
 * ¿`abs` (relativa `rel` a su repo `raiz`) es papeleo de lo que nombra la lista? La constancia pasa si se lee y cada ruta
 * de sus `rules` está en la lista; suites.json, si contra su versión del último commit sólo suma renglones de pruebas de
 * la lista. Lo que no se puede leer, o sin git, no pasa.
 */
function esPapeleoDeLaLista(lista, abs, raiz, rel) {
  const set = new Set(lista.map(sinEnlaces));
  const esta = (r) => set.has(sinEnlaces(path.join(raiz, r)));
  if (CONSTANCIA.test(rel)) {
    let c;
    try { c = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { return false; }
    const reglas = esObjeto(c) && Array.isArray(c.rules) ? c.rules : [];
    return reglas.length > 0 && reglas.every((x) => esObjeto(x) && relSegura(x.path) && esta(norm(x.path)));
  }
  if (rel !== SUITES) return false;
  let ahora;
  try { ahora = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { return false; }
  const r = require('child_process').spawnSync('git', ['-C', raiz, 'show', `HEAD:${SUITES}`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error || r.status !== 0) return false;
  let antes;
  try { antes = JSON.parse(r.stdout); } catch (_) { return false; }
  if (!esObjeto(ahora) || !esObjeto(antes)) return false;
  const deLaLista = (x) => esObjeto(x) && Object.prototype.hasOwnProperty.call(CARPETA_DE_LA_RAIZ, x.raiz) && relSegura(x.ruta) && esta(`${CARPETA_DE_LA_RAIZ[x.raiz]}/${norm(x.ruta)}`);
  for (const k of new Set([...Object.keys(antes), ...Object.keys(ahora)])) {
    if ((k === 'diarias' || k === 'semanales') && Array.isArray(antes[k]) && Array.isArray(ahora[k])) {
      // los renglones de antes siguen todos, tal cual; lo que sobra son renglones de pruebas de la lista
      const quedan = new Map();
      for (const x of ahora[k]) { const t = JSON.stringify(x); quedan.set(t, [...(quedan.get(t) || []), x]); }
      for (const x of antes[k]) {
        const t = JSON.stringify(x);
        const iguales = quedan.get(t);
        if (!iguales || !iguales.length) return false;
        iguales.pop();
      }
      if (![...quedan.values()].flat().every(deLaLista)) return false;
    } else if (JSON.stringify(antes[k]) !== JSON.stringify(ahora[k])) return false;
  }
  return true;
}

/**
 * ¿`abs` es la prueba de un archivo de la lista? En el mismo repo, en una carpeta de pruebas (o con nombre de prueba) y
 * con el nombre del archivo: `x.test.js`, `x.spec.ts`, `test_x.py` o `x_test.go` de un `x.<ext>` de la lista.
 */
function esPruebaDe(lista, abs, raiz) {
  if (!raiz) return false;
  const rel = norm(path.relative(raiz, abs));
  if (rel.startsWith('..')) return false;
  const { isTestPath } = require('./atdd-order.js');
  if (!isTestPath(rel)) return false;
  const base = path.basename(abs);
  // dentro de `__tests__/` la prueba de Jest lleva el mismo nombre que el archivo
  const enTests = rel.split('/').slice(0, -1).includes('__tests__');
  return lista.some((f) => {
    if (raizDe(f) !== raiz) return false;
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    if (!stem) return false;
    const s = escapar(stem);
    // x.test.js, x.spec.ts, test_x.py, x_test.go, y la de .NET: XTests.cs o XTest.cs
    const re = new RegExp(`^(?:${s}\\.(?:test|spec)\\.[^.]+|test_${s}\\.[^.]+|${s}_test\\.[^.]+|${s}Tests?\\.[^.]+${enTests ? `|${s}\\.[^.]+` : ''})$`, 'i');
    return re.test(base);
  });
}
const escapar = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿`abs` cae en la carpeta temporal de la máquina? Sólo cuenta fuera de un repo. */
function esTemporal(abs) {
  const carpetas = [os.tmpdir(), '/tmp', '/private/tmp', process.env.CLAUDE_JOB_DIR].filter(Boolean).map(sinEnlaces);
  return carpetas.some((c) => abs === c || abs.startsWith(c.endsWith(path.sep) ? c : c + path.sep));
}

/**
 * Las raíces reales de los repos que nombra la lista tal como se guardó: de cada entrada se sube por sus carpetas sin
 * seguir un enlace, hasta la primera con `.git`. Un enlace creado después de abrir no cambia el repo de la entrada.
 */
function reposEscritos(lista) {
  const raices = new Set();
  for (const x of lista) {
    let d = path.dirname(String(x));
    for (;;) {
      let enlace = false;
      try { enlace = fs.lstatSync(d).isSymbolicLink(); } catch (_) { enlace = false; }
      let conGit = false;
      try { fs.statSync(path.join(d, '.git')); conGit = true; } catch (_) { conGit = false; }
      if (!enlace && conGit) { raices.add(sinEnlaces(d)); break; }
      const arriba = path.dirname(d);
      if (arriba === d) break;
      d = arriba;
    }
  }
  return [...raices];
}

/**
 * ¿La ruta cae fuera de la lista? null (está, o está exenta) o `{ archivo, motivo }`. `filePath` y `real` (la ruta real,
 * por los enlaces) los da el borde, con la raíz real de su repo (`repoRoot`, null fuera de un repo). Fuera de un repo
 * frena salvo la carpeta temporal; la carpeta personal frena al carril delegado y no al de una persona. `estricta` (el
 * arreglo de un rojo de CI, que cuenta las pruebas en su tope): la prueba de un archivo de la lista no pasa por su nombre.
 */
function fueraDeLaLista({ lista, filePath, real, repoRoot, home = os.homedir(), delegado = false, estricta = false }) {
  if (!Array.isArray(lista)) return null;
  const abs = sinEnlaces(real || filePath);
  // la ruta escrita, con sus carpetas reales pero sin seguir el enlace del final: un enlace con otro nombre no es la entrada
  const escrito = escritoDe(filePath);
  // cada entrada vale por su nombre y por su destino: un enlace de la lista se edita por cualquiera de los dos
  const set = new Set(lista.flatMap((x) => [sinEnlaces(x), escritoDe(x)]));
  // un destino que la lista no nombraba al abrir, alcanzado por un enlace de ahora, vale sólo en un repo de la lista: un
  // enlace creado o reapuntado después no la agranda a otro repo
  const deLaLista = lista.some((x) => unidadEnMayuscula(String(x)) === abs) || reposEscritos(lista).some((r) => abs === r || abs.startsWith(r + path.sep));
  if (set.has(abs) && set.has(escrito) && deLaLista) return null;
  const raiz = repoRoot ? sinEnlaces(repoRoot) : raizDe(abs);
  if (!raiz) {
    // la carpeta personal antes que la temporal: al delegado lo frena aunque la carpeta personal caiga en la temporal
    const casa = home ? sinEnlaces(home) : null;
    if (casa && (abs === casa || abs.startsWith(casa + path.sep))) return delegado ? { archivo: abs, motivo: 'carpeta personal' } : null;
    if (esTemporal(abs)) return null;
    return { archivo: abs, motivo: 'fuera de un repo' };
  }
  const rel = norm(path.relative(raiz, abs));
  if (esPapeleo(rel)) return null;
  if (!estricta && esPruebaDe(lista, abs, raiz)) return null;
  if (esPapeleoDeLaLista(lista, abs, raiz, rel)) return null;
  return { archivo: abs, motivo: 'no está en la lista' };
}

module.exports = {
  sinEnlaces, unidadEnMayuscula, faltanEnLaNueva, normalizar, relDeLaLista, reposDeLaLista, repoDelCarril, repoVecinoFueraDelGrupo, carpetaDeLaSesion, raizDe, esCodigo, esCodigoRel, contar, problemaDeTopes, problemaDelMotivo, variosTemas, vago, sinUnaPersona,
  esPapeleo, esPapeleoDeLaLista, esPruebaDe, esTemporal, fueraDeLaLista, rechazoDeLaLista, textoDeAmpliar, textoOtroCarril, riesgoDeLaLista, textoDelRiesgo,
};
