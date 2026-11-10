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

/** La ruta con los enlaces resueltos, aunque el final todavía no exista. */
function sinEnlaces(p) {
  const abs = path.resolve(String(p));
  const resto = [];
  let cabeza = abs;
  for (;;) {
    try { return path.join(fs.realpathSync(cabeza), ...resto); } catch (_) { /* no existe: se sube uno */ }
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
  for (const e of entradas) {
    const s = typeof e === 'string' ? e.trim() : '';
    if (!s) return { problema: 'la lista de archivos tiene una entrada vacía' };
    if (COMODIN.test(s)) return { problema: `«${s}» tiene un comodín: la lista nombra los archivos uno por uno` };
    if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) return { problema: `«${s}» es una ruta absoluta: va relativa a la carpeta donde se pide` };
    if (norm(s).split('/').includes('..')) return { problema: `«${s}» sube de carpeta con «..»: la lista nombra archivos de esta carpeta para abajo` };
    if (/[\\/]$/.test(s)) return { problema: `«${s}» es una carpeta: la lista nombra archivos, uno por uno` };
    const abs = sinEnlaces(path.resolve(cwd, s));
    let carpeta = false;
    try { carpeta = fs.statSync(abs).isDirectory(); } catch (_) { carpeta = false; }
    if (carpeta) return { problema: `«${s}» es una carpeta: la lista nombra archivos, uno por uno` };
    // pedida desde una carpeta que no es la del repo (la personal, por ejemplo), la lista nombra archivos que nadie va a
    // editar, y cada edición real frena como fuera de la lista: se avisa, con la ruta completa
    if (!raizDe(abs)) sinRepo.push(abs);
    // el nombre como se escribió (con sus carpetas reales): si es un enlace, la lista lo nombra a él, no a su destino
    out.add(escritoDe(path.resolve(cwd, s)));
  }
  return { lista: [...out].sort(), sinRepo };
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

/** ¿Cuenta como código una ruta relativa, sin mirar el disco? Para lo que decide antes de abrir (la firma, la ventana). */
function esCodigoRel(rel) {
  const gate = require('./story-gate.js');
  const { isImplPath } = require('./atdd-order.js');
  // como la cuenta `normalizar`: sin los espacios de los bordes (un espacio al final no saca un archivo del tope)
  const s = norm(String(rel || '').trim());
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
    ? 'el motivo va en una línea: la ventana muestra un renglón, y lo que no se ve no lo aprueba el dueño'
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
  return /,[^,]*(^|\s)(y|e|o)(\s|$)/i.test(s);
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
 * ¿La ruta cae fuera de la lista? null (está, o está exenta) o `{ archivo, motivo }`. `filePath` y `real` (la ruta real,
 * por los enlaces) los da el borde, con la raíz real de su repo (`repoRoot`, null fuera de un repo). Fuera de un repo
 * frena salvo la carpeta temporal; la carpeta personal frena al carril delegado y no al de una persona.
 */
function fueraDeLaLista({ lista, filePath, real, repoRoot, home = os.homedir(), delegado = false }) {
  if (!Array.isArray(lista)) return null;
  const abs = sinEnlaces(real || filePath);
  // la ruta escrita, con sus carpetas reales pero sin seguir el enlace del final: un enlace con otro nombre no es la entrada
  const escrito = escritoDe(filePath);
  // cada entrada vale por su nombre y por su destino: un enlace de la lista se edita por cualquiera de los dos
  const set = new Set(lista.flatMap((x) => [sinEnlaces(x), escritoDe(x)]));
  if (set.has(abs) && set.has(escrito)) return null;
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
  if (esPruebaDe(lista, abs, raiz)) return null;
  return { archivo: abs, motivo: 'no está en la lista' };
}

module.exports = {
  sinEnlaces, normalizar, raizDe, esCodigo, esCodigoRel, contar, problemaDeTopes, problemaDelMotivo, variosTemas, vago, sinUnaPersona,
  esPapeleo, esPruebaDe, esTemporal, fueraDeLaLista, rechazoDeLaLista, textoDeAmpliar, textoOtroCarril, riesgoDeLaLista, textoDelRiesgo,
};
