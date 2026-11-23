'use strict';
/**
 * adhoc-base.js — la base del camino rápido: contra qué se mide lo que cambió, y qué archivos son suyos. Una sola medida
 * para todos los que preguntan (el tope, la pantalla, los datos, el riesgo, la huella, los revisores y «descartar»).
 *
 *   traerBase(repo)           trae `main` del remoto y devuelve su commit: `{ sha, traida: true, ts, origen }`; sin red (o sin
 *                             remoto) `{ sha: null, traida: false, motivo, ts, origen }`. `origen` es el `origin` de ese
 *                             momento, leído aparte del `fetch` (null: no tenía). Nunca lee el `origin/main` local, que puede
 *                             estar movido o atrasado: lee lo que trajo (FETCH_HEAD).
 *   conBase(adhoc, repo)      el carril con la base de ese repo anotada, si todavía no la tenía (el primer toque).
 *   conBasesAlDia(adhoc)      el carril con `main` traído otra vez en cada repo cuyo `origin` es el de su base: lo que el freno
 *                             hace antes de frenar.
 *   mismoOrigen(a, b)         ¿dos formas de escribir la misma remota?
 *   repoConoce(repo, rel)     ¿el repo conoció esta ruta (en el índice o en la historia de sus ramas)?
 *   medirLoPropio(adhoc)      `{ porRepo: { <repo>: { base, cambios, sinSeguir, anotados } }, avisos, fallas, sinMedir }`: lo
 *                             que git sabe del carril en cada repo, sin decidir qué le importa a cada uno.
 *   rutasDe(medida, adhoc, …) lo que lee cada uno de la medida: `{ <repo>: [rel…] }`.
 *   reposQueSeMiden(…)        los repos de un guardado: `{ delCarril, delComando }`.
 *   cuentaDelCarril(adhoc)    `{ archivos, avisos, fallas }`: de lo propio, lo que suma para el tope.
 *   marcaSinSustento(…)       ¿la marca de riesgo alto nombra un archivo que ya no es del carril?
 *   huellaDelCarril(adhoc)    el sha256 del contenido de sus archivos de código, en cada repo: un cambio después de una
 *                             constancia la cambia.
 *   anotarGuardadoDelCarril(…) la constancia de un guardado del carril que el freno dejó pasar.
 *   puntaConConstancia(repo, M) el commit más nuevo de la rama con constancia (un guardado de otro carril o la foto de
 *                             una corrida cerrada completa): lo propio se mide desde ahí, no desde M.
 *
 * Lo que no se puede leer (git que no contesta) no da verde: queda en `fallas`, y quien mide no guarda.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RAMA = 'main';
const RAMA_DE_TRABAJO = 'dev';
const TOPE_MS = Number(process.env.TYCON_ADHOC_BASE_TIMEOUT_MS) || 8000;
const TOPE_CONOCE_MS = 3000;
// se lee al preguntar, y un 0 vale: las pruebas agotan el tiempo con él
const topeDeConoce = () => { const v = process.env.TYCON_ADHOC_KNOWN_TIMEOUT_MS; return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : TOPE_CONOCE_MS; };

// git en inglés: `ubicar` reconoce «fuera de un repo» por el texto del error, que se traduce. Se arma una vez, al
// primer git: un script que carga este módulo sin llegar a git no carga la biblioteca.
let gitEnv = null;
const entornoDeGit = () => gitEnv || (gitEnv = require(path.join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'clean-git-env.js')).idiomaFijo());
// el tope de salida por defecto es de 1 MB: en un repo grande, la lista de archivos lo pasa y parece que git no contestó
const SALIDA_MAX = 64 * 1024 * 1024;
function git(repo, args, timeout = 5000) {
  return execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: entornoDeGit(), maxBuffer: SALIDA_MAX }).trim();
}
const primeraLinea = (e) => String((e && (e.stderr || e.message)) || e).split('\n').find((l) => l.trim()) || 'git no contestó';

/**
 * `{ raiz }` con la raíz real del repo de una ruta; `{ fuera: true }` si la ruta no está en un repo (la carpeta temporal
 * de la sesión, por ejemplo); `{ falla }` si git no contestó. Con `ubicados` (un `Map` carpeta → resultado), la
 * respuesta de cada carpeta que existe se guarda y se reusa: las rutas de una misma carpeta preguntan una sola vez (un
 * git que no contestó no se guarda).
 */
function ubicar(p, ubicados) {
  let d = String(p);
  try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch (_) { d = path.dirname(d); }
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  if (ubicados && ubicados.has(d)) return ubicados.get(d);
  let u;
  try { u = { raiz: fs.realpathSync(git(d, ['rev-parse', '--show-toplevel'])) }; } catch (e) {
    const err = String((e && (e.stderr || e.message)) || e);
    // adentro de `.git` o de un repo pelado no hay árbol de trabajo: tampoco hay nada que medir
    u = /not a git repository|must be run in a work tree/i.test(err) ? { fuera: true } : { falla: primeraLinea(e) };
  }
  // un git que no contestó puede contestar en la próxima ruta: sólo se guarda lo que no cambia en la corrida
  if (ubicados && !u.falla) ubicados.set(d, u);
  return u;
}
/** La raíz del repo de una ruta, o null (fuera de un repo, o git que no contesta). */
function raizDe(p) { return ubicar(p).raiz || null; }

/** El `origin` del repo, o null si no tiene. Git que no contesta, sube. */
function origenDe(repo) {
  try { return git(repo, ['remote', 'get-url', 'origin']); } catch (e) {
    if (/no such remote/i.test(String(e.stderr || e.message))) return null;
    throw e;
  }
}

function traerBase(repo) {
  const ts = new Date().toISOString();
  let origen = null;
  try { origen = origenDe(repo); } catch (_) { /* git que no contesta: el fetch lo dice */ }
  try {
    git(repo, ['fetch', '--quiet', '--no-tags', 'origin', RAMA], TOPE_MS);
    return { sha: git(repo, ['rev-parse', 'FETCH_HEAD^{commit}']), traida: true, ts, origen };
  } catch (e) {
    return { sha: null, traida: false, motivo: `no pude traer ${RAMA} de origin: ${primeraLinea(e).trim()}`, ts, origen };
  }
}

/** El carril con la base del repo anotada si no la tenía: `{ adhoc, aviso }` (aviso sólo si la base no se trajo). */
function conBase(adhoc, repo) {
  const bases = { ...((adhoc && adhoc.bases) || {}) };
  if (bases[repo]) return { adhoc, aviso: null };
  const b = traerBase(repo);
  bases[repo] = b;
  return { adhoc: { ...adhoc, bases }, aviso: b.traida ? null : `camino rápido: la base de ${repo} queda sin traer (${b.motivo}); al guardar se mide con lo anotado y el commit, sin la rama` };
}

/**
 * Las formas de una remota reducidas a `servidor/ruta`: sin usuario ni clave, sin `.git` ni barra final, el servidor en
 * minúsculas; https, ssh y `git@srv:ruta` son lo mismo, y `file:///x` es `/x`. Azure DevOps: sus tres formas dan
 * `dev.azure.com/<org>/<proyecto>/<repo>`. Lo que no entra en esas formas queda como texto.
 */
function formaDeLaRemota(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (/^file:\/\//i.test(u)) u = u.replace(/^file:\/\//i, '');
  let servidor = null;
  let ruta = null;
  const conEsquema = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(u);
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.*)$/.exec(u);
  if (conEsquema) [servidor, ruta] = [conEsquema[1], conEsquema[2]];
  else if (scp && !/^[A-Za-z]$/.test(scp[1])) [servidor, ruta] = [scp[1], scp[2]];
  if (servidor === null) return u.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
  servidor = servidor.toLowerCase();
  ruta = ruta.replace(/\/+$/, '').replace(/\.git$/i, '');
  const vs = /^([^.]+)\.visualstudio\.com$/.exec(servidor);
  if (vs) return `dev.azure.com/${vs[1]}/${ruta.replace('/_git/', '/')}`.toLowerCase();
  if (servidor === 'ssh.dev.azure.com') return `dev.azure.com/${ruta.replace(/^v3\//, '')}`.toLowerCase();
  if (servidor === 'dev.azure.com') return `dev.azure.com/${ruta.replace('/_git/', '/')}`.toLowerCase();
  return `${servidor}/${ruta}`;
}
/** ¿Dos formas de la misma remota? No es una barrera de seguridad: un error da un falso freno, con salida. */
function mismoOrigen(a, b) {
  const x = formaDeLaRemota(a);
  return !!x && x === formaDeLaRemota(b);
}
/** ¿El `origin` de hoy es el de la base anotada? Una base sin `origen` (de un carril viejo) no lo sabe: no. */
function deEseOrigen(anotada, hoy) {
  if (!anotada || !Object.prototype.hasOwnProperty.call(anotada, 'origen')) return false;
  if (anotada.origen === null || hoy === null) return anotada.origen === hoy;
  return mismoOrigen(anotada.origen, hoy);
}

/**
 * El carril con `main` traído otra vez en los repos que ya tienen base: `{ adhoc, alDia, avisos }`, con los repos cuya base
 * quedó recién traída y lo que no se pudo. Se compara el `origin` antes del `fetch`: uno que no es el de la base anotada (o
 * una base sin `origen`) no se trae, porque su `main` podría ser esta misma rama y el `fetch` movería `origin/main`.
 */
function conBasesAlDia(adhoc) {
  const bases = { ...((adhoc && adhoc.bases) || {}) };
  const alDia = [];
  const avisos = [];
  for (const repo of Object.keys(bases)) {
    let hoy;
    try { hoy = origenDe(repo); } catch (e) { avisos.push(`camino rápido: ${repo} sigue con la base anotada (${primeraLinea(e)})`); continue; }
    if (!deEseOrigen(bases[repo], hoy)) { avisos.push(`camino rápido: ${repo} sigue con la base anotada: su origin ya no es el de esa base`); continue; }
    const b = traerBase(repo);
    if (!b.traida) { avisos.push(`camino rápido: ${repo} sigue con la base anotada (${b.motivo})`); continue; }
    bases[repo] = b;
    alDia.push(repo);
  }
  return { adhoc: { ...adhoc, bases }, alDia, avisos };
}

// La etiqueta de `git ls-files -v` de un archivo con una bandera del índice (`--skip-worktree`, `--assume-unchanged`): el
// diff no ve lo que el archivo tiene.
const CON_BANDERA = /^(S|[a-z])/;
const ES_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * Donde la rama se separó de la base: lo que `main` agregó después no es de la rama. Sin historia común, la base: mide de
 * más. Con git caído, también; el diff que sigue lo dice como una falla.
 */
function puntoDeSalida(repo, sha) {
  try { return git(repo, ['merge-base', sha, 'HEAD']) || sha; } catch (_) { return sha; }
}

/** La ruta real (por los enlaces de carpeta, como /tmp → /private/tmp); la de su carpeta si el archivo ya no está. */
function rutaReal(f) {
  try { return fs.realpathSync(f); } catch (_) {
    try { return path.join(fs.realpathSync(path.dirname(f)), path.basename(f)); } catch (__) { return String(f); }
  }
}
/** La ruta con la carpeta existente más cercana resuelta: un enlace en el camino (como /tmp en mac) no cambia la ruta. */
function rutaResuelta(f) {
  let cerca = path.resolve(String(f));
  const resto = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cerca), ...resto); } catch (_) {
      const arriba = path.dirname(cerca);
      if (arriba === cerca) return path.resolve(String(f));
      resto.unshift(path.basename(cerca));
      cerca = arriba;
    }
  }
}
const relDe = (repo, abs) => {
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
};

/**
 * ¿El repo conoció esta ruta? Está en el índice, o un commit de alguna rama la tocó. Una ruta que ya no está en el disco es
 * del repo sólo así: una sonda borrada que git nunca siguió, la ruta de un worktree borrado vista desde el repo de afuera o
 * una variable sin expandir (`$L/p.js`) no traen a su repo; una pantalla borrada y commiteada, sí. Si se agota el tiempo,
 * cuenta como conocida (del lado seguro) y lo dice en `avisos`.
 */
// lo que ya se le preguntó a git en este proceso: la misma ruta del mismo repo no se vuelve a preguntar
const CONOCE = new Map();
function repoConoce(repo, rel, avisos = []) {
  const clave = `${repo}\0${rel}`;
  if (CONOCE.has(clave)) return CONOCE.get(clave);
  const tope = topeDeConoce();
  // a destiempo no se recuerda: la próxima vez se pregunta de nuevo
  const agotado = () => { avisos.push(`camino corto: no pude saber a tiempo si ${repo} conoce ${rel}: cuenta como suya`); return true; };
  if (tope <= 0) return agotado();
  let conoce;
  try {
    conoce = Boolean(git(repo, ['--literal-pathspecs', 'ls-files', '--', rel], tope))
      || !!git(repo, ['--literal-pathspecs', 'log', '-1', '--format=%H', '--branches', '--', rel], tope);
  } catch (e) {
    if (e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')) return agotado();
    // sin commits, `log` no tiene qué recorrer: no la conoce. Otro error: ante la duda, se mide
    conoce = !/does not have any commits|bad default revision/i.test(String(e.stderr || e.message));
  }
  CONOCE.set(clave, conoce);
  return conoce;
}

/**
 * Lo anotado por las ediciones del carril, con su ruta real. Para el tope (`sinMarca`), la ruta de la marca de riesgo sola
 * no cuenta como anotada: en un carril viejo la puso el freno, no una edición. Para el riesgo, la huella y los revisores
 * sí cuenta: puede ser la de una edición, y un archivo ignorado sólo se ve por lo anotado.
 */
function anotadasDe(adhoc, { sinMarca = false } = {}) {
  const files = (adhoc && Array.isArray(adhoc.files) ? adhoc.files : []);
  const marca = adhoc && adhoc.riesgoAlto && adhoc.riesgoAlto.archivo;
  const rutas = (adhoc && Array.isArray(adhoc.rutas) ? adhoc.rutas : []).filter((f) => !sinMarca || f !== marca || files.includes(f));
  return [...new Set([...rutas, ...files].filter((f) => typeof f === 'string' && path.isAbsolute(f)).map(rutaResuelta))];
}

/**
 * Los repos del carril (los de su base y los de las rutas que anotó) y las rutas cuyo repo no se pudo ubicar. Una ruta que
 * ya no está en el disco trae a su repo sólo si el repo la conoce (`repoConoce`). `ubicados`: lo ya ubicado, compartido
 * entre llamadas (ver `ubicar`).
 */
function reposYHuerfanas(adhoc, avisos = [], { ubicados } = {}) {
  const repos = new Set(Object.keys((adhoc && adhoc.bases) || {}));
  const huerfanas = [];
  for (const f of [...((adhoc && adhoc.rutas) || []), ...((adhoc && adhoc.files) || [])]) {
    if (typeof f !== 'string') continue;
    const u = ubicar(f, ubicados);
    if (u.falla) { huerfanas.push(String(f)); continue; }
    if (!u.raiz || repos.has(u.raiz)) continue;
    if (fs.existsSync(f)) { repos.add(u.raiz); continue; }
    const rel = relDe(u.raiz, rutaResuelta(f));
    if (rel && repoConoce(u.raiz, rel, avisos)) repos.add(u.raiz);
  }
  return { repos: [...repos], huerfanas };
}
function reposDelCarril(adhoc, opts = {}) { return reposYHuerfanas(adhoc, [], opts).repos; }

// Las rutas que lista git, separadas por NUL (`-z`): sin comillas ni escapes en los nombres con acentos o espacios.
// `-z` va antes de todo lo demás: después de un `--` git lo leería como una ruta.
const rutasDeGit = (repo, [sub, ...resto]) => git(repo, ['-c', 'core.quotepath=false', sub, '-z', ...resto]).split('\0').filter(Boolean);
/** Los cambios de un diff, con la ruta vieja de un movimiento: `[{ ruta, vieja }]`. */
function cambiosDeGit(repo, args) {
  const campos = git(repo, ['-c', 'core.quotepath=false', 'diff', '-z', '--name-status', '--find-renames', ...args]).split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < campos.length;) {
    const estado = campos[i++];
    if (/^[RC]/.test(estado)) out.push({ ruta: campos[i + 1], vieja: campos[i] }), i += 2;
    else out.push({ ruta: campos[i++], vieja: null });
  }
  return out;
}

/**
 * ¿Sigue siendo un repo la carpeta anotada? Una que ya no está (un worktree borrado), sin `.git`, o con un `.git` que apunta
 * a un repo que ya no está (los restos de un worktree), no tiene nada que medir. Un repo roto sí: su `.git` está, y que git
 * no conteste es «no pude medir». Otro error sube.
 */
function sigueElRepo(repo) {
  try {
    fs.statSync(repo);
    const punto = path.join(repo, '.git');
    if (fs.statSync(punto).isDirectory()) return true;
    const destino = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(punto, 'utf8'));
    return !destino || fs.existsSync(path.resolve(repo, destino[1]));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

// git que no contesta sube: no es «el commit no está», y el texto mandaría a reabrir el carril sin motivo
const existeElCommit = (repo, sha) => {
  try { git(repo, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch (e) {
    if (e && e.status === 128 && /not a valid object|bad object|Not a valid object name|could not get object info/i.test(String(e.stderr || e.message))) return false;
    if (e && e.status === 1) return false;
    throw e;
  }
};
const corto = (sha) => String(sha).slice(0, 12);

/**
 * Desde dónde se mide lo propio de un repo, en un solo lugar: `{ sha, de, aviso? }` (de: 'integracion' | 'constancia' |
 * 'anotada' | 'sin-base'), o `{ falla }` con la salida escrita. Con la rama de integración, si la rama ya tiene una punta
 * con constancia después de la bifurcación (`puntaConConstancia`), desde esa punta. Se compara el `origin` de hoy con el anotado antes de mirar ninguna
 * rama remota:
 *  - el mismo `origin` (o sin base anotada): la bifurcación con la rama de integración más cercana (`main` o `dev`). Una
 *    sola: «igual a la otra rama» no quiere decir «entró de ahí», y un revert masivo no sumaría. En `dev` con `main` traído
 *    y sin empujar, lo ya integrado suma hasta que se empuja: es un límite escrito, con salida en el click. Sin ninguna, el
 *    punto de salida de la base anotada; sin `sha`, lo anotado y el commit, con el aviso; con un `sha` que el repo no
 *    tiene, no se mide.
 *  - otro `origin`, o una base sin `origen` (de un carril viejo): no se le cree a sus ramas, que podrían traer esta misma
 *    rama como `main`. Se mide desde el punto de salida de la base anotada, con aviso; sin ella, no se mide.
 */
function laBase(repo, adhoc, nacido) {
  const anotada = adhoc && adhoc.bases && adhoc.bases[repo];
  const hoy = origenDe(repo);
  const cabeza = () => (nacido ? git(repo, ['rev-parse', '--verify', '-q', 'HEAD']) : null);
  const sinBase = (motivo) => ({ sha: cabeza(), de: 'sin-base', aviso: `camino corto: ${repo} no tiene su base traída (${motivo}): la rama no se midió, sólo lo anotado y el commit` });
  const shaAnotado = anotada && anotada.sha && ES_SHA.test(anotada.sha) ? anotada.sha : null;
  const otro = anotada && !deEseOrigen(anotada, hoy);
  if (otro) {
    if (shaAnotado && existeElCommit(repo, shaAnotado)) return { sha: nacido ? puntoDeSalida(repo, shaAnotado) : null, de: 'anotada', aviso: `camino corto: el origin de ${repo} no es el de su base anotada: se mide desde esa base` };
    const por = Object.prototype.hasOwnProperty.call(anotada, 'origen') ? 'el origin cambió desde que se abrió el carril' : 'el carril se abrió antes de que la base anotara su origin';
    return { falla: `camino corto: en ${repo} ${por}, y su base anotada ${shaAnotado ? `(${corto(shaAnotado)}) no está en el repo` : 'no tiene commit'}: cerrá y reabrí el carril (marker.js adhoc clear y adhoc set)` };
  }
  if (nacido) {
    const candidatas = [];
    for (const rama of [RAMA, RAMA_DE_TRABAJO]) {
      try {
        const sha = git(repo, ['merge-base', 'HEAD', `origin/${rama}`]);
        candidatas.push({ sha, adelante: Number(git(repo, ['rev-list', '--count', `${sha}..HEAD`])) });
      } catch (e) {
        // exit 1: historias sin relación. La rama que falta lo dice el texto
        if (e.status !== 1 && !/not a valid object name/i.test(String(e.stderr || e.message))) throw e;
      }
    }
    if (candidatas.length) {
      const M = candidatas.sort((a, b) => a.adelante - b.adelante)[0].sha;
      // lo que la rama ya guardó con su constancia no se vuelve a medir: se mide desde esa punta
      const p = puntaConConstancia(repo, M, { adhoc });
      if (p.sha) return { sha: p.sha, de: 'constancia', ...(p.aviso ? { aviso: p.aviso } : {}) };
      return { sha: M, de: 'integracion', ...(p.aviso ? { aviso: p.aviso } : {}) };
    }
  }
  if (!shaAnotado) return sinBase((anotada && anotada.motivo) || `sin origin/${RAMA}`);
  if (!existeElCommit(repo, shaAnotado)) {
    return { falla: `camino corto: la base anotada de ${repo} (${corto(shaAnotado)}) no está en el repo: con red, repetí el comando (trae ${RAMA} de nuevo); sin red, cerrá y reabrí el carril (marker.js adhoc clear y adhoc set)` };
  }
  return { sha: nacido ? puntoDeSalida(repo, shaAnotado) : null, de: 'anotada' };
}

// ── la punta con constancia ─────────────────────────────────────────────────────────────────────────────────────────

// Las constancias viven en la carpeta de estado del arnés, la de `gates.log`, que el portón de edición no deja escribir a
// una sesión: los guardados del carril que el freno dejó pasar, y los cierres archivados de las corridas.
const GUARDADOS = 'carril-guardados.jsonl';
const CIERRES = 'timing-history';
// cuánto se mira hacia atrás: los commits de la rama, los cierres de corrida, los guardados, las puntas encadenadas y, por
// cierre, los commits desde su foto
const COMMITS_MAX = 50;
const CIERRES_MAX = 50;
const GUARDADOS_MAX = 200;
const ENCADENADAS_MAX = 3;
const DESDE_LA_FOTO_MAX = 5;
const estadoDelArnes = () => require('./state-dir.js').stateDir(os.homedir());
const noPudeLeer = (que, e) => `camino corto: no pude leer las constancias de las puntas (${que}: ${(e && e.code) || primeraLinea(e)}): se mide desde main`;
const ramaDe = (repo) => { const r = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']); return r === 'HEAD' ? null : r; };

/**
 * Quién es el carril: sus guardados no le sirven de punta a él mismo (si no, partir el trabajo en varios commits esquivaría
 * su tope), sólo al arreglo que viene después. Sale de cuándo se declaró y se firmó, que no cambian mientras está abierto.
 */
function idDelCarril(adhoc) {
  if (!adhoc) return null;
  const partes = [adhoc.declaredAt, adhoc.firmadaEn, adhoc.reason].map((x) => (x == null ? '' : String(x)));
  return partes.every((x) => !x) ? null : crypto.createHash('sha256').update(partes.join('\0')).digest('hex').slice(0, 16);
}

/** El contenido de cada ruta en el índice y en el disco: `{ rel: { indice, disco } }` (null: no está). */
function contenidosDe(repo, rels) {
  const indice = new Map();
  for (const l of git(repo, ['-c', 'core.quotepath=false', '--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...rels]).split('\0')) {
    const m = /^\d+ ([0-9a-f]+) 0\t(.*)$/s.exec(l);
    if (m) indice.set(m[2], m[1]);
  }
  const enDisco = rels.filter((r) => {
    try { return fs.statSync(path.join(repo, r)).isFile(); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
  });
  const hashes = enDisco.length ? git(repo, ['hash-object', '--', ...enDisco]).split('\n') : [];
  if (hashes.length !== enDisco.length) throw new Error('git hash-object no devolvió un contenido por archivo');
  const disco = new Map(enDisco.map((r, i) => [r, hashes[i]]));
  return Object.fromEntries(rels.map((r) => [r, { indice: indice.get(r) || null, disco: disco.get(r) || null }]));
}

/**
 * Anota el guardado de un carril que el freno dejó pasar: `{ ts, repo, rama, base, carril, marca, archivos }`, con cada
 * archivo de lo propio del repo como está en el índice y en el disco. El freno corre antes del comando: un `git commit` solo
 * guarda el índice; con `-a` o un `git add` en el mismo comando, el disco. Al buscar la punta vale cualquiera de los dos,
 * salvo con marca de riesgo alto: ahí sólo el disco, que es lo que vieron los revisores. Sin medida, con fallas o sin nada
 * propio no anota. `{ anotado }`, o `{ anotado: false, aviso }` si algo impidió anotarlo: nunca tira, y quien guarda
 * sigue igual.
 */
function anotarGuardadoDelCarril({ adhoc, medida, repo, dir = estadoDelArnes(), ahora = new Date().toISOString() } = {}) {
  const no = (por) => ({ anotado: false, aviso: `camino corto: no anoté la constancia del guardado en ${repo} (${por}): el próximo arreglo de la rama se mide desde main` });
  try {
    if (!medida || (medida.fallas || []).length) return { anotado: false };
    const e = medida.porRepo && (medida.porRepo[repo] || medida.porRepo[rutaReal(repo)]);
    if (!e) return no('el repo no está en la medida del carril');
    if (!e.base || !e.base.sha) return no('la medida no tiene base');
    // lo que git todavía no sigue también: un `git add` en el mismo comando lo sube al commit
    const rels = [...new Set([...e.cambios.flatMap((c) => [c.ruta, c.vieja]), ...e.anotados, ...(e.sinSeguir || [])].filter(Boolean))].sort();
    if (!rels.length) return { anotado: false };
    const rama = ramaDe(repo);
    if (!rama) return no('HEAD suelto, sin rama');
    const renglon = { ts: ahora, repo: rutaReal(repo), rama, base: e.base.sha, carril: idDelCarril(adhoc), marca: !!(adhoc && adhoc.riesgoAlto), archivos: contenidosDe(repo, rels) };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, GUARDADOS), `${JSON.stringify(renglon)}\n`);
    return { anotado: true };
  } catch (err) {
    return no((err && err.code) || primeraLinea(err));
  }
}

const esContenido = (x) => x === null || (typeof x === 'string' && ES_SHA.test(x));
/** Los guardados anotados de ese repo y esa rama, del más nuevo al más viejo. Un renglón que no se lee lo dice el aviso. */
function guardadosDe(dir, repo, rama) {
  let texto;
  try { texto = fs.readFileSync(path.join(dir, GUARDADOS), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { lista: [] };
    return { lista: [], aviso: noPudeLeer(GUARDADOS, e) };
  }
  const lista = [];
  let rotos = 0;
  for (const l of texto.split('\n').filter((x) => x.trim()).slice(-GUARDADOS_MAX).reverse()) {
    let g;
    try { g = JSON.parse(l); } catch (_) { rotos += 1; continue; }
    const forma = g && ES_SHA.test(String(g.base)) && g.archivos && typeof g.archivos === 'object'
      && Object.values(g.archivos).every((c) => c && esContenido(c.indice) && esContenido(c.disco));
    if (!forma) { rotos += 1; continue; }
    if (g.repo === repo && g.rama === rama) lista.push(g);
  }
  return { lista, ...(rotos ? { aviso: noPudeLeer(GUARDADOS, { code: `${rotos} renglón(es) que no se leen` }) } : {}) };
}

/**
 * Las fotos de «Preparar el pull request» de las corridas cerradas completas de ese repo y esa rama: `[{ arbol, cabeza }]`
 * (el árbol sin el papeleo y el commit desde el que se tomó). Sólo los cierres posteriores a `desde` (segundos): uno
 * anterior a la bifurcación no puede tener una punta suya. Un cierre que no se lee lo dice el aviso.
 */
function fotosDe(dir, repo, rama, desde) {
  const carpeta = path.join(dir, CIERRES);
  let nombres;
  try { nombres = fs.readdirSync(carpeta).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code === 'ENOENT') return { fotos: [] };
    return { fotos: [], aviso: noPudeLeer(CIERRES, e) };
  }
  const recientes = [];
  for (const n of nombres) {
    // uno que se borró mientras se listaba no estaba
    try { const t = fs.statSync(path.join(carpeta, n)).mtimeMs; if (t >= desde * 1000) recientes.push({ n, t }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const fotos = [];
  let rotos = 0;
  for (const { n } of recientes.sort((a, b) => b.t - a.t).slice(0, CIERRES_MAX)) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(carpeta, n), 'utf8')).marker; } catch (_) { rotos += 1; continue; }
    if (!m || !m.cierre || m.cierre.estado !== 'completa' || !Array.isArray(m.prepareCommitHuellas)) continue;
    for (const h of m.prepareCommitHuellas) {
      if (h && rutaReal(String(h.repo)) === repo && h.rama === rama && ES_SHA.test(String(h.arbol))) fotos.push({ arbol: h.arbol, cabeza: ES_SHA.test(String(h.cabeza)) ? h.cabeza : null });
    }
  }
  return { fotos, ...(rotos ? { aviso: noPudeLeer(CIERRES, { code: `${rotos} cierre(s) que no se leen` }) } : {}) };
}

/**
 * Los sellos que revisó la última vuelta CERRADA de revisores de cada corrida abierta, en el repo `real`: un arreglo rápido
 * sobre la rama de una historia todavía abierta mide desde ahí, no desde main. Una vuelta sin cerrar no cuenta
 * (frozen-tree.js `vueltaCerradaDeLosRevisores`). `{ arboles, aviso? }`.
 */
function arbolesRevisados(dir, real) {
  let nombres;
  try { nombres = fs.readdirSync(path.join(dir, 'active')).filter((n) => n.endsWith('.json')); } catch (e) {
    if (e.code === 'ENOENT') return { arboles: [] };
    return { arboles: [], aviso: noPudeLeer('active', e) };
  }
  const ft = require('./frozen-tree.js');
  const { reviewersClose } = require('./steps.js');
  const arboles = [];
  let rotos = 0;
  for (const n of nombres) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, 'active', n), 'utf8')); } catch (_) { rotos += 1; continue; }
    const v = ft.vueltaCerradaDeLosRevisores(m, reviewersClose(m), { stateDir: dir });
    for (const r of (v && v.repos) || []) if (r && ES_SHA.test(String(r.tree)) && rutaReal(String(r.repo)) === real) arboles.push(r.tree);
  }
  return { arboles, ...(rotos ? { aviso: noPudeLeer('active', { code: `${rotos} marcador(es) que no se leen` }) } : {}) };
}

/**
 * La punta con constancia de la rama: el commit P más nuevo entre M (el punto en común con la rama de integración, sin
 * incluirlo) y HEAD que desciende de M y tiene su constancia —el árbol que vio la última vuelta cerrada de revisores de
 * una corrida abierta (igual salvo el papeleo), el árbol de la foto de una corrida cerrada completa, o el guardado de
 * OTRO carril: cada archivo con el contenido anotado y todo lo cambiado desde su base dentro de la lista, con la
 * base en M u otra punta válida—. Un merge de `main` después de P lo deja fuera: P ya no desciende del M de hoy. `adhoc`:
 * el carril que mide, cuyos guardados no cuentan. `{ sha }` (null: no hay) y `aviso` si una constancia no se pudo leer.
 */
function puntaConConstancia(repo, M, { adhoc = null, dir = estadoDelArnes() } = {}) {
  try {
    const real = rutaReal(repo);
    const rama = ramaDe(repo);
    if (!rama) return { sha: null };
    const commits = git(repo, ['rev-list', '--ancestry-path', `--max-count=${COMMITS_MAX}`, `${M}..HEAD`]).split('\n').filter(Boolean);
    if (!commits.length) return { sha: null };
    const propio = idDelCarril(adhoc);
    const g = guardadosDe(dir, real, rama);
    const guardados = g.lista.filter((x) => !propio || x.carril !== propio);
    const f = fotosDe(dir, real, rama, Number(git(repo, ['log', '-1', '--format=%ct', M])) || 0);
    const rv = arbolesRevisados(dir, real);
    const aviso = g.aviso || f.aviso || rv.aviso;
    if (!guardados.length && !f.fotos.length && !rv.arboles.length) return { sha: null, ...(aviso ? { aviso } : {}) };
    const enLaRama = new Set(commits);
    // lo que revisó la vuelta: un commit de la rama igual a ese sello, sin contar el papeleo (la historia, la evidencia)
    const deLaVuelta = new Set();
    if (rv.arboles.length) {
      const ft = require('./frozen-tree.js');
      for (const sha of commits) {
        const arbol = git(repo, ['rev-parse', `${sha}^{tree}`]);
        if (rv.arboles.some((t) => { const c = ft.changed(repo, t, arbol); return !c.error && c.files.length === 0; })) { deLaVuelta.add(sha); break; }
      }
    }
    // la foto se toma antes del commit: su punta es su cabeza o uno de los commits que le siguen, no cualquiera de la rama
    const deLaFoto = new Set();
    for (const foto of f.fotos) {
      if (!foto.cabeza || !(foto.cabeza === M || enLaRama.has(foto.cabeza))) continue;
      const despues = git(repo, ['rev-list', '--ancestry-path', '--reverse', `${foto.cabeza}..HEAD`]).split('\n').filter(Boolean).slice(0, DESDE_LA_FOTO_MAX);
      for (const sha of [foto.cabeza, ...despues]) {
        if (sha === M || deLaFoto.has(sha)) continue;
        const a = require('./save-ok.js').arbolDelCommit(repo, sha);
        if (a.error) throw new Error(a.error);
        if (a.arbol === foto.arbol) deLaFoto.add(sha);
      }
    }
    const blobs = new Map();
    const blobsDe = (sha) => {
      if (!blobs.has(sha)) {
        const rels = [...new Set(guardados.flatMap((x) => Object.keys(x.archivos)))];
        blobs.set(sha, new Map(git(repo, ['-c', 'core.quotepath=false', '--literal-pathspecs', 'ls-tree', '-r', '-z', sha, '--', ...rels])
          .split('\0').map((l) => /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(l)).filter(Boolean).map((m) => [m[2], m[1]])));
      }
      return blobs.get(sha);
    };
    const validas = new Map();
    const valida = (sha, vuelta) => {
      if (deLaFoto.has(sha) || deLaVuelta.has(sha)) return true;
      if (validas.has(sha)) return validas.get(sha);
      const ok = guardados.some((x) => {
        // lo barato primero: una base que no es M ni de la rama no puede encadenar
        if (x.base !== M && !(vuelta < ENCADENADAS_MAX && enLaRama.has(x.base))) return false;
        const ahi = blobsDe(sha);
        const coincide = Object.entries(x.archivos).every(([r, c]) => {
          const b = ahi.get(r) || null;
          return b === c.disco || (!x.marca && b === c.indice);
        });
        if (!coincide) return false;
        const cambiados = git(repo, ['-c', 'core.quotepath=false', 'diff', '-z', '--name-only', '--no-renames', x.base, sha, '--']).split('\0').filter(Boolean);
        if (cambiados.some((r) => !Object.prototype.hasOwnProperty.call(x.archivos, r))) return false;
        return x.base === M || valida(x.base, vuelta + 1);
      });
      validas.set(sha, ok);
      return ok;
    };
    const P = commits.find((sha) => valida(sha, 0)) || null;
    return { sha: P, ...(aviso ? { aviso } : {}) };
  } catch (e) {
    return { sha: null, aviso: noPudeLeer(repo, e) };
  }
}

/**
 * ¿Hay un merge en curso de lo que ya está en una rama de integración? Sólo eso es «traído». Una rama cualquiera, o varias a
 * la vez, es trabajo propio: si no, armarlo aparte y mergearlo sin commitear lo sacaría de la cuenta.
 */
function traeDeIntegracion(repo) {
  let puntas;
  try { puntas = fs.readFileSync(path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD'])), 'utf8').split('\n').filter(Boolean); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (puntas.length !== 1) return false;
  return [RAMA, RAMA_DE_TRABAJO].some((rama) => {
    try { git(repo, ['merge-base', '--is-ancestor', puntas[0], `origin/${rama}`]); return true; } catch (e) {
      if (e.status === 1 || /not a valid object name/i.test(String(e.stderr || e.message))) return false;
      throw e;
    }
  });
}

/**
 * La medida de lo propio del carril: lo que git sabe, sin decidir qué le importa a cada uno.
 * `{ porRepo: { <repo>: { base: { sha, de }, cambios: [{ ruta, vieja }], sinSeguir: [rel], anotados: [rel] } }, avisos,
 * fallas, sinMedir: [repo] }`:
 *  - `cambios`: el diff contra la base y lo preparado; `vieja` sólo en un movimiento. En un repo sin commits, también lo
 *    que está en `git add -N`. Con un merge en curso de una rama de integración, lo que queda igual a esa rama es lo que el
 *    merge trae, y no está.
 *  - `sinSeguir`: lo que git no sigue en el repo, sea de quien sea.
 *  - `anotados`: lo anotado que git no puede comparar: ignorado, con bandera del índice, o en un repo sin base. Lo anotado
 *    que git sigue y es igual a la base no está (una edición restaurada, o que ya entró de `main`).
 * `repos`: los repos a medir además de los del carril. `fallas`: lo que no se pudo medir; con una, nadie da verde.
 */
function medirLoPropio(adhoc, opciones = {}) {
  // un error fuera de lo que mide cada repo tampoco da verde: la medida entera queda como falla
  try { return medirCadaRepo(adhoc, opciones); } catch (e) {
    const f = `camino corto: no pude medir lo propio del carril (${primeraLinea(e)})`;
    return { porRepo: {}, avisos: [f], fallas: [f], sinMedir: [] };
  }
}
function medirCadaRepo(adhoc, { repos: extra = [] } = {}) {
  const porRepo = {};
  const avisos = [];
  const fallas = [];
  const sinMedir = [];
  const anotadas = anotadasDe(adhoc);
  const { repos, huerfanas } = reposYHuerfanas({ bases: adhoc && adhoc.bases, rutas: anotadas }, avisos);
  // una ruta anotada cuyo repo no se ubica (git que no contesta) es una medición incompleta, no «nada que medir»
  for (const f of huerfanas) fallas.push(`camino corto: no pude ubicar el repo de ${f}: queda sin medir`);
  const casa = rutaReal(os.homedir());
  for (const repo of [...new Set([...repos, ...extra.filter(Boolean)])]) {
    try {
      if (!sigueElRepo(repo)) { avisos.push(`camino corto: ${repo} ya no es un repo: no hay nada que medir ahí`); continue; }
      // la carpeta de la persona como repo de dotfiles no es del arreglo: el portón de edición tampoco la cuenta, y se dice
      if (repo === casa) { avisos.push(`camino corto: ${repo} es tu carpeta personal: no se cuenta en el arreglo`); continue; }
      let nacido = true;
      try { git(repo, ['rev-parse', '--verify', '-q', 'HEAD']); } catch (e) { if (e.status === 1) nacido = false; else throw e; }
      const base = laBase(repo, adhoc, nacido);
      if (base.falla) { fallas.push(base.falla); sinMedir.push(repo); continue; }
      if (base.aviso) avisos.push(base.aviso);
      const cambios = new Map();
      // un archivo movido en la rama y editado después llega dos veces: preparado, sin su ruta vieja; contra la base, con
      // ella. La ruta vieja no se pierde
      const sumar = (c) => {
        const ya = cambios.get(c.ruta);
        if (!ya) cambios.set(c.ruta, c);
        else if (!ya.vieja && c.vieja) cambios.set(c.ruta, { ...ya, vieja: c.vieja });
      };
      cambiosDeGit(repo, ['--cached']).forEach(sumar);
      if (base.sha) cambiosDeGit(repo, [base.sha, '--']).forEach(sumar);
      // sin commits no hay contra qué comparar: lo que está en `git add -N` sólo lo muestra el diff del árbol
      else if (!nacido) cambiosDeGit(repo, ['--']).forEach(sumar);
      if (nacido && traeDeIntegracion(repo)) {
        const distintos = new Set(cambiosDeGit(repo, ['MERGE_HEAD', '--']).flatMap((c) => [c.ruta, c.vieja]).filter(Boolean));
        for (const [ruta, c] of [...cambios]) if (!distintos.has(ruta) && !(c.vieja && distintos.has(c.vieja))) cambios.delete(ruta);
      }
      const sinSeguir = rutasDeGit(repo, ['ls-files', '--others', '--exclude-standard']);
      const yaVistas = new Set([...cambios.keys(), ...[...cambios.values()].map((c) => c.vieja).filter(Boolean), ...sinSeguir]);
      const propias = anotadas.map((f) => relDe(repo, f)).filter((rel) => rel && !yaVistas.has(rel));
      const anotados = [];
      if (propias.length) {
        const etiquetas = new Map(git(repo, ['--literal-pathspecs', 'ls-files', '-v', '-z', '--', ...propias])
          .split('\0').filter(Boolean).map((l) => [l.slice(2), l]));
        for (const rel of propias) {
          // una carpeta anotada no es un archivo del carril: no hay nada que comparar
          let enDisco = false;
          try { enDisco = fs.statSync(path.join(repo, rel)).isFile(); } catch (e) {
            // que no esté es «nada que medir»; no poder mirarlo (permisos, un enlace en bucle) es una medición incompleta
            if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
          }
          if (etiquetas.has(rel)) { if (CON_BANDERA.test(etiquetas.get(rel)) || (base.de === 'sin-base' && enDisco)) anotados.push(rel); } else if (enDisco) anotados.push(rel);
        }
      }
      porRepo[repo] = { base: { sha: base.sha, de: base.de }, cambios: [...cambios.values()], sinSeguir, anotados };
    } catch (e) {
      fallas.push(`camino corto: git no contestó en ${repo} (${primeraLinea(e)})`);
      sinMedir.push(repo);
    }
  }
  return { porRepo, avisos: [...avisos, ...fallas], fallas, sinMedir };
}

const sumaAlTope = (rel) => require('./atdd-order.js').isImplPath(rel) && require('./story-gate.js').isCodeFile(rel);

/**
 * Lo que cada uno lee de la medida, `{ <repo>: [rel…] }`:
 *  - `como: 'todo'` (el riesgo, la huella, la marca, los revisores y la pantalla): las dos rutas de cada cambio, lo
 *    anotado y todo lo sin seguir: un `git add -A` lo puede subir.
 *  - `como: 'propio'` (el tope, los datos y «descartar»): cada cambio una vez, con su ruta nueva si ésa suma (`suma`) o si
 *    la vieja tampoco; lo anotado; y de lo sin seguir, sólo lo anotado, o todo con `sinSeguir`.
 * `repos`: sólo esos (null: todos los medidos).
 */
function rutasDe(medida, adhoc, { como = 'todo', repos = null, sinSeguir = false, suma = () => true } = {}) {
  const anotadas = new Set(anotadasDe(adhoc, { sinMarca: como !== 'todo' }));
  const out = {};
  for (const repo of Object.keys(medida.porRepo)) {
    if (repos && !repos.includes(repo)) continue;
    const e = medida.porRepo[repo];
    const set = new Set();
    for (const c of e.cambios) {
      if (como === 'todo') { set.add(c.ruta); if (c.vieja) set.add(c.vieja); } else set.add(!c.vieja || suma(c.ruta, repo) || !suma(c.vieja, repo) ? c.ruta : c.vieja);
    }
    for (const r of e.anotados) if (como === 'todo' || anotadas.has(path.join(repo, r))) set.add(r);
    for (const r of e.sinSeguir) if (como === 'todo' || sinSeguir || anotadas.has(path.join(repo, r))) set.add(r);
    out[repo] = [...set].sort();
  }
  return out;
}

/**
 * Los repos que mide un guardado, elegidos en un solo lugar: `{ delCarril, delComando }`.
 *  - `delComando`: la raíz de cada carpeta posible de cada guardado.
 *  - `delCarril`: los repos anotados; sin ninguno, los del comando, y además la carpeta de la sesión si el lector no
 *    asegura la carpeta (`segura`), si hay dudas o un comando que no se lee, o si hay un pedido abierto desde fuera de un
 *    repo. El tope y la pantalla leen `delCarril`; el riesgo, los dos.
 */
function reposQueSeMiden({ adhoc, cs = [], dudas = [], cwd, segura = true, raiz = raizDe, ubicarRuta = ubicar }) {
  const delComando = [];
  // la carpeta de un guardado que git no pudo ubicar no es «fuera de un repo»: quien mide no da verde
  const fallas = [];
  let pedidoSinRepo = false;
  let carpetaSinRaiz = false;
  for (const c of cs) {
    let r = null;
    try { r = raiz(c.dir); } catch (_) { r = null; }
    if (r) { if (!delComando.includes(r)) delComando.push(r); continue; }
    const u = ubicarRuta(c.dir);
    if (u.falla) { fallas.push(`camino corto: no pude ubicar el repo de ${c.dir} (${u.falla})`); continue; }
    if (c.tipo === 'pr') pedidoSinRepo = true;
    // una carpeta adentro de `.git` no tiene raíz: el lector no sabe dónde corre
    if (/(^|[\\/])\.git([\\/]|$)/.test(String(c.dir || ''))) carpetaSinRaiz = true;
  }
  const anotados = reposDelCarril(adhoc).filter((r) => fs.existsSync(r));
  if (anotados.length) return { delCarril: anotados, delComando, anotados, fallas };
  const delCarril = [...delComando];
  if (!segura || carpetaSinRaiz || dudas.length || cs.some((c) => c.opaco) || pedidoSinRepo) {
    let r = null;
    try { r = raiz(cwd); } catch (_) { r = null; }
    if (r && !delCarril.includes(r)) delCarril.push(r);
    // como la de un guardado: git que no contestó sobre la carpeta de la sesión no es «fuera de un repo»
    if (!r) {
      const u = ubicarRuta(cwd);
      if (u.falla) fallas.push(`camino corto: no pude ubicar el repo de ${cwd} (${u.falla})`);
    }
  }
  return { delCarril, delComando, anotados, fallas };
}

/**
 * ¿La marca nombra un archivo que ya no es del carril? Sólo con la medición completa y `main` recién traído en su repo.
 * Tampoco si un commit de otra rama local lo tocó después de la marca: pasarse de rama no la levanta. Ni si su carpeta ya
 * no está y el repo no conoce la ruta (un worktree borrado: su rama puede seguir viva y desde afuera no se ve). La duda
 * deja la marca; si la duda es un git que no contestó, `avisar` lo dice.
 */
function marcaSinSustento(marca, medida, alDia, bases, adhoc, avisar = () => {}) {
  if (medida.fallas.length || !marca || !marca.archivo) return false;
  for (const r of Object.keys(bases || {})) {
    if (!relDe(r, path.resolve(marca.archivo)) && r !== marca.archivo) continue;
    try { if (!sigueElRepo(r)) return false; } catch (_) { return false; }
  }
  // un enlace: medir su destino no dice si el enlace cambió
  try { if (fs.lstatSync(marca.archivo).isSymbolicLink()) return false; } catch (e) {
    // ya no está: se mide por su ruta. No poder mirarlo deja la marca
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return false;
  }
  const abs = rutaResuelta(marca.archivo);
  const repo = raizDe(abs);
  if (!repo || !alDia.includes(repo) || !medida.porRepo[repo]) return false;
  const rel = relDe(repo, abs);
  if (!rel || (rutasDe(medida, adhoc, { como: 'todo', repos: [repo] })[repo] || []).includes(rel)) return false;
  const avisos = [];
  if (!fs.existsSync(path.dirname(abs)) && !repoConoce(repo, rel, avisos)) return false;
  if (avisos.length) return false;
  const t = Date.parse(marca.ts);
  const desde = Number.isNaN(t) ? [] : [`--since=${new Date(t).toISOString().slice(0, 19)}Z`];
  try {
    if (CON_BANDERA.test(git(repo, ['--literal-pathspecs', 'ls-files', '-v', '--', rel]))) return false;
    const sha = medida.porRepo[repo].base.sha;
    return !git(repo, ['--literal-pathspecs', 'log', '-1', '--format=%H', '--branches', ...desde, ...(sha ? ['--not', sha] : []), '--', rel]);
  } catch (e) {
    avisar(`camino rápido: la marca de ${rel} queda: no pude mirar las otras ramas (${String(e.message || e).split('\n')[0]})`);
    return false;
  }
}

/**
 * Lo que suma para el tope: los archivos de implementación que el carril cambió, con su ruta entera. `{ archivos, avisos,
 * fallas }`. La maqueta y la captura anotadas no suman, aunque vivan en el repo. Un archivo suma una vez: un worktree dentro
 * de otro repo del carril lo muestra en los dos, y Mac guarda un nombre con acento en una forma de Unicode y git lo lista en otra.
 * `repos`: los del guardado, además de los del carril; `medida`: la de esta vuelta (sin ella, mide).
 */
// Las carpetas temporales del sistema, por su ruta real (en macOS /tmp es /private/tmp, y la de cada usuario vive en
// /private/var/folders). Ahí corren los laboratorios y las pruebas.
function temporalesDelSistema() {
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
  return [...new Set([real(require('os').tmpdir()), real('/tmp'), real('/private/tmp'), real('/private/var/folders')].filter(Boolean))];
}
const dentroDe = (dir, p) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/**
 * El juez de los laboratorios del camino corto: `(raiz) → bool`, si un repo es un laboratorio que no suma al tope. Lo es
 * un `git init` de prueba en una carpeta temporal del sistema: sin ningún remoto y con su propia carpeta `.git` (un clon,
 * con el remoto que sea, y un worktree, que tiene un archivo `.git`, suman), cuando la carpeta del camino corto (`cwd`)
 * vive fuera de los temporales. Los repos anotados del carril no cuentan para decidirlo: el freno de edición anota ahí el
 * repo de cada archivo tocado, laboratorios incluidos. Si el camino corto vive en un temporal, o no se sabe dónde vive,
 * nada es laboratorio. Un git que no contesta: suma. `temporales`: otra lista, para las pruebas.
 */
function juezDeLaboratorios(adhoc, { temporales = null } = {}) {
  const tmps = temporales || temporalesDelSistema();
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
  const carril = adhoc && adhoc.cwd ? real(adhoc.cwd) : null;
  if (!carril || tmps.some((t) => dentroDe(t, carril))) return () => false;
  const juzgados = new Map();
  return (raiz) => {
    const r = real(raiz);
    if (!r || r === carril || !tmps.some((t) => dentroDe(t, r))) return false;
    if (!juzgados.has(r)) {
      let lab = false;
      try { lab = fs.statSync(path.join(r, '.git')).isDirectory() && git(r, ['remote']).trim() === ''; } catch (_) { lab = false; }
      juzgados.set(r, lab);
    }
    return juzgados.get(r);
  };
}

function cuentaDelCarril(adhoc, { repos = [], sinSeguir = false, medida, temporales = null } = {}) {
  const { isImplPath } = require('./atdd-order.js');
  const { isCodeFile } = require('./story-gate.js');
  const m = medida || module.exports.medirLoPropio(adhoc, { repos });
  const leer = [...new Set([...reposDelCarril(adhoc), ...repos])];
  const porRepo = rutasDe(m, adhoc, { como: 'propio', repos: leer, sinSeguir, suma: sumaAlTope });
  const anotadas = new Set([adhoc && adhoc.mockup, adhoc && adhoc.capture].filter((x) => x && typeof x.file === 'string').map((x) => rutaReal(x.file)));
  const archivos = new Map();
  const esLaboratorio = juezDeLaboratorios(adhoc, { temporales });
  for (const repo of Object.keys(porRepo)) {
    if (esLaboratorio(repo)) continue;
    for (const rel of porRepo[repo]) {
      const abs = path.join(repo, rel);
      if (isImplPath(rel) && isCodeFile(rel) && !anotadas.has(rutaReal(abs))) {
        // Mac y Windows tampoco distinguen mayúsculas: es el mismo archivo con otra grafía
        const clave = process.platform === 'linux' ? abs.normalize('NFC') : abs.normalize('NFC').toLowerCase();
        if (!archivos.has(clave)) archivos.set(clave, abs);
      }
    }
  }
  return { archivos: [...archivos.values()].sort(), avisos: m.avisos, fallas: m.fallas };
}

/**
 * La huella del carril: el sha256 del contenido de sus archivos de código y de sus archivos de riesgo alto (una
 * migración, `.tycon/production.json`, un pipeline), en cada repo del carril. Con git caído empieza con `incompleta:` y
 * no vale como constancia: se midió con menos archivos. `medida`: la de esta vuelta (sin ella, mide). `repo`: sólo la
 * de ese repo del carril (las pruebas de un repo, `adhoc test --repo`).
 */
function huellaDelCarril(adhoc, medida, { repo = null } = {}) {
  const { isCodeFile } = require('./story-gate.js');
  const riskPaths = require('./risk-paths.js');
  const m = medida || module.exports.medirLoPropio(adhoc);
  const delCarril = reposDelCarril(adhoc).filter((r) => !repo || mismoRepo(r, repo));
  const porRepo = rutasDe(m, adhoc, { como: 'todo', repos: delCarril });
  const h = crypto.createHash('sha256');
  for (const repo of Object.keys(porRepo).sort()) {
    for (const rel of porRepo[repo]) {
      let cuenta = isCodeFile(rel);
      if (!cuenta) { try { cuenta = riskPaths.riesgoDeArchivos([rel], { repo }).value; } catch (_) { cuenta = true; } }
      if (!cuenta) continue;
      let contenido;
      try { contenido = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, rel))).digest('hex'); } catch (_) { contenido = 'ausente'; }
      h.update(`${repo}\t${rel}\t${contenido}\n`);
    }
  }
  return `${m.fallas.length ? 'incompleta:' : ''}${h.digest('hex')}`;
}

/** ¿Dos raíces son el mismo repo? Por su ruta real. */
function mismoRepo(a, b) {
  const r = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  return r(a) === r(b);
}

/** ¿La huella sirve para una constancia? Una incompleta, no. */
const huellaCompleta = (h) => typeof h === 'string' && !h.startsWith('incompleta:');

module.exports = { traerBase, conBase, conBasesAlDia, mismoOrigen, formaDeLaRemota, repoConoce, medirLoPropio, rutasDe, reposQueSeMiden, marcaSinSustento,
  anotarGuardadoDelCarril, puntaConConstancia, reposDelCarril, cuentaDelCarril, juezDeLaboratorios, sigueElRepo, huellaDelCarril, huellaCompleta, mismoRepo, raizDe, ubicar, sumaAlTope, RAMA };
