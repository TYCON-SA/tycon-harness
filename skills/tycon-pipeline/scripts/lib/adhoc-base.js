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
function repoConoce(repo, rel, avisos = []) {
  const tope = topeDeConoce();
  const agotado = () => { avisos.push(`camino corto: no pude saber a tiempo si ${repo} conoce ${rel}: cuenta como suya`); return true; };
  if (tope <= 0) return agotado();
  try {
    if (git(repo, ['--literal-pathspecs', 'ls-files', '--', rel], tope)) return true;
    return !!git(repo, ['--literal-pathspecs', 'log', '-1', '--format=%H', '--branches', '--', rel], tope);
  } catch (e) {
    if (e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')) return agotado();
    // sin commits, `log` no tiene qué recorrer: no la conoce. Otro error: ante la duda, se mide
    if (/does not have any commits|bad default revision/i.test(String(e.stderr || e.message))) return false;
    return true;
  }
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
 * Desde dónde se mide lo propio de un repo, en un solo lugar: `{ sha, de, aviso? }` (de: 'integracion' | 'anotada' |
 * 'sin-base'), o `{ falla }` con la salida escrita. Se compara el `origin` de hoy con el anotado antes de mirar ninguna
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
    if (candidatas.length) return { sha: candidatas.sort((a, b) => a.adelante - b.adelante)[0].sha, de: 'integracion' };
  }
  if (!shaAnotado) return sinBase((anotada && anotada.motivo) || `sin origin/${RAMA}`);
  if (!existeElCommit(repo, shaAnotado)) {
    return { falla: `camino corto: la base anotada de ${repo} (${corto(shaAnotado)}) no está en el repo: con red, repetí el comando (trae ${RAMA} de nuevo); sin red, cerrá y reabrí el carril (marker.js adhoc clear y adhoc set)` };
  }
  return { sha: nacido ? puntoDeSalida(repo, shaAnotado) : null, de: 'anotada' };
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
      // la carpeta de la persona como repo de dotfiles no es del arreglo: el portón de edición tampoco la cuenta
      if (repo === casa) continue;
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
function cuentaDelCarril(adhoc, { repos = [], sinSeguir = false, medida } = {}) {
  const { isImplPath } = require('./atdd-order.js');
  const { isCodeFile } = require('./story-gate.js');
  const m = medida || module.exports.medirLoPropio(adhoc, { repos });
  const leer = [...new Set([...reposDelCarril(adhoc), ...repos])];
  const porRepo = rutasDe(m, adhoc, { como: 'propio', repos: leer, sinSeguir, suma: sumaAlTope });
  const anotadas = new Set([adhoc && adhoc.mockup, adhoc && adhoc.capture].filter((x) => x && typeof x.file === 'string').map((x) => rutaReal(x.file)));
  const archivos = new Map();
  for (const repo of Object.keys(porRepo)) {
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
 * no vale como constancia: se midió con menos archivos. `medida`: la de esta vuelta (sin ella, mide).
 */
function huellaDelCarril(adhoc, medida) {
  const { isCodeFile } = require('./story-gate.js');
  const riskPaths = require('./risk-paths.js');
  const m = medida || module.exports.medirLoPropio(adhoc);
  const delCarril = reposDelCarril(adhoc);
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

/** ¿La huella sirve para una constancia? Una incompleta, no. */
const huellaCompleta = (h) => typeof h === 'string' && !h.startsWith('incompleta:');

module.exports = { traerBase, conBase, conBasesAlDia, mismoOrigen, repoConoce, medirLoPropio, rutasDe, reposQueSeMiden, marcaSinSustento,
  reposDelCarril, cuentaDelCarril, sigueElRepo, huellaDelCarril, huellaCompleta, raizDe, ubicar, sumaAlTope, RAMA };
