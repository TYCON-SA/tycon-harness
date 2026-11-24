'use strict';
/**
 * evidence-vs-commit.js — ¿una evidencia sigue valiendo para un archivo de código declarado?
 *
 * La fecha de un archivo no dice si cambió: git la reescribe en cada cambio de rama, aunque el contenido quede igual. Y
 * comparar la hora de la evidencia con la del commit tampoco sirve: la evidencia se toma antes del commit que guarda el
 * código. La pregunta es otra: ¿el archivo cambió desde que se guardó la evidencia? La evidencia también viaja por git
 * (`.advisors/dod-runtime/`), así que git la contesta por contenido.
 *
 * La regla, en orden; la primera que aplica decide:
 *   1. La fecha del archivo es anterior o igual a la hora de la evidencia → cuenta, sin llamar a git.
 *   2. El archivo tiene cambios sin commitear, también preparados; no está en git, está marcado para que git no lo mire,
 *      o git no contesta → no cuenta.
 *   3. La evidencia no está en ningún commit alcanzable desde HEAD → no cuenta: pudo probar el código de otra rama.
 *   4. En el mismo repo: cuenta si el archivo es igual en el commit que guardó la evidencia y en HEAD.
 *   5. En otro repo, una evidencia con ancla (el commit de ese repo al correr, y la huella de lo que tenía sin commitear) se
 *      compara por contenido contra HEAD: igual cuenta, distinto no. Si el commit del ancla no está en este clon, sigue abajo.
 *      Sin ancla no hay contenido que comparar: cuenta si el último commit del archivo es anterior o igual al de la
 *      evidencia. Esa hora se lee con --first-parent: un commit viejo que entra por un merge cuenta con la hora del merge.
 *      Si no, cuenta si hay una fusión de pedido posterior cuya rama es de esta historia, y el archivo es igual en HEAD y en
 *      esa rama a la hora de la evidencia. Supone que la evidencia corrió sobre esa rama: nada lo prueba, y por eso `via`
 *      le pide a la matriz que lo avise. Sin saber de qué historia es la rama no se puede: un commit ajeno, viejo, que entra
 *      por su fusión después de la evidencia tiene el mismo dibujo en git que el propio.
 *   6. Después de la 4 y de la 5: un archivo de prueba cuenta si todos los commits que lo cambiaron después son de otra
 *      historia. Afloja el control a propósito, por decisión del dueño: una prueba corregida por la misma historia quizá daba
 *      verde por estar mal, y vence. Pero vence sólo la evidencia de los criterios que esa prueba nombra
 *      (`@story-<historia> @ac-N`), también si está sin commitear en la rama de la historia (la regla 2): devuelve
 *      `{ cuenta: false, regla: 6, criterios }`, y la evidencia de los otros criterios sigue contando: el arreglo de
 *      una prueba no dice nada de lo que esa prueba no mira. Sin marcas o ilegible, `criterios: null`: vence toda. De qué historia es un commit lo dice
 *      lib/commit-story.js, o, para un commit de la rama de la historia que todavía no está en origin/main, la rama; si no
 *      se sabe, vence toda. Si lo único que cambió en la prueba son marcas `@story-…` y `@ac-N` en el nombre de una prueba
 *      o en un comentario, no vence nada: la prueba hace lo mismo que cuando corrió la evidencia, y devuelve
 *      `{ cuenta: true, regla: 6, via: 'solo-marcas' }`. Una marca en un dato de la prueba, o cualquier otro cambio, vence.
 *
 * La regla de la entrada no es una más de esta lista: `entrada` responde aparte, y la pide la matriz cuando una evidencia no
 * cuenta (runtime-matrix.js). Una historia queda probada si lo que entró a origin/main es, por contenido, lo que se probó;
 * lo que otra historia cambie después lo avisa el nocturno. Se compara en la línea de primer padre: lo probado contra el último
 * commit anterior a la evidencia («ya estaba») o contra el primero posterior que cambió el archivo (la entrada). Un cambio
 * posterior propio la vence: lo es si lo dice el registro de pedidos, la rama, o el asunto de uno de sus commits.
 *
 * Una evidencia guardada en el mismo commit que un archivo editado después de la prueba da verde en la regla 4: no se
 * distingue en git. Lo frena antes el freno del commit, que calcula esta misma regla con el archivo sin commitear.
 *
 * Git sin respuesta nunca se lee como «no cambió». Un clon cortado tampoco se compara: el commit del borde parece haber
 * agregado todos los archivos, y la regla 4 daría verde sin haber mirado nada.
 *
 * El índice: el freno del commit evalúa lo que quedaría preparado tras un `git add … && git commit` con GIT_INDEX_FILE en
 * una copia del índice. Esa variable se respeta sólo en `repoDelIndice`: en otro repo es el índice de otro. GIT_DIR y
 * GIT_WORK_TREE no se pasan nunca, porque cada comando elige su repo por la carpeta en la que corre.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { isTestPath } = require('./atdd-order.js');
const { ramaDelAsunto, historiaDeLaRama, historiaDeLaFusion, nombraLaHistoria } = require('./commit-story.js');
const changeKind = require('./change-kind.js');

const TIEMPO_MAX_MS = 10000;
// La historia entera de un registro de humos con sus cambios cabe holgada; si no cabe, git no contesta y la evidencia no cuenta.
const SALIDA_MAX_BYTES = 64 * 1024 * 1024;
const FORMATO_DE_COMMIT = '%H %ct %h';
// Abre cada commit en la historia de un registro: un byte que no aparece en un renglón de texto.
const MARCA_DE_COMMIT = '\x01';
const MAIN = 'origin/main';
// Una marca de prueba suelta, con los espacios de antes: `@story-<historia>` o `@ac-N`, sin una letra pegada a ninguno
// de los dos lados (`x@ac-4` es texto de la prueba).
const MARCA_DE_PRUEBA = /[ \t]*(?<![\w@])@(?:story-[\w.-]*\w|ac-\d+)(?!\w)/g;
// Un comentario que sin sus marcas quedó vacío.
const COMENTARIO_VACIO = /^[ \t]*(?:\/\/+|#+|\/\*+[ \t*]*\*\/)?[ \t]*$/;
// Las palabras que declaran una prueba: su primer argumento es su nombre, donde van las marcas.
const DECLARA_PRUEBA = /^(?:test|it|describe|context|suite|specify)$/;
// Lo que se encadena a una de ésas y sigue declarando una prueba (`test.only`, `describe.skip`, `test.describe.serial`,
// `test.step`). Otro método (`context.setItem`, `test.expect`) es una llamada cualquiera: su texto es un dato.
const MODIFICA_PRUEBA = /^(?:only|skip|todo|step|concurrent|serial|parallel|sequential|fixme|fail|failing)$/;

/**
 * ¿El texto en la posición `k` es el nombre de una prueba? `test('…'`, `it.only('…'`, `describe.skip('…'`. Uno de un
 * método (`t.test('…'`, `re.test('…'`) no: puede ser un dato.
 */
function esNombreDePrueba(tokens, k) {
  if (!tokens[k - 1] || tokens[k - 1].v !== '(') return false;
  let j = k - 2;
  while (j >= 2 && tokens[j].tipo === 'palabra' && tokens[j - 1].v === '.' && (MODIFICA_PRUEBA.test(tokens[j].v) || DECLARA_PRUEBA.test(tokens[j].v))) j -= 2;
  return Boolean(tokens[j]) && tokens[j].tipo === 'palabra' && DECLARA_PRUEBA.test(tokens[j].v) && !(tokens[j - 1] && tokens[j - 1].v === '.');
}

/**
 * En un lenguaje que lee lib/change-kind.js (menos C#): ¿las dos versiones difieren sólo en marcas? El código y las
 * separaciones, iguales; un texto que cambió, sólo si es el nombre de una prueba y sin sus marcas da lo mismo (otro texto
 * puede ser un dato de la prueba); los comentarios, iguales sin sus marcas, y el que quedó vacío no cuenta. La separación
 * de antes del primer token no cuenta: es la de un renglón de comentario agregado arriba.
 */
function soloMarcasEnElCodigo(antes, ahora, ext) {
  const idioma = { jsx: !/^\.(?:ts|mts|cts)$/.test(ext) };
  const a = changeKind.leer(antes, idioma);
  const b = changeKind.leer(ahora, idioma);
  if (a.duda || b.duda || a.tokens.length !== b.tokens.length) return false;
  for (let k = 0; k < a.tokens.length; k++) {
    const [x, y] = [a.tokens[k], b.tokens[k]];
    if (x.tipo !== y.tipo || x.familia !== y.familia) return false;
    if (x.v === y.v) continue;
    if (x.tipo !== 'texto' || !esNombreDePrueba(a.tokens, k)) return false;
    if (x.v.replace(MARCA_DE_PRUEBA, '') !== y.v.replace(MARCA_DE_PRUEBA, '')) return false;
  }
  if (a.separaciones.some((s, k) => k > 0 && s !== b.separaciones[k])) return false;
  const comentarios = (r) => JSON.stringify(r.comentarios.map((c) => [sinMarcasDelComentario(c.texto), c.ancla])
    .filter(([t]) => !COMENTARIO_VACIO.test(t)));
  return comentarios(a) === comentarios(b);
}

// Lo que hace de un comentario una directiva de alguna herramienta: ahí una marca nueva puede cambiar su efecto.
const DIRECTIVA = /eslint|prettier|istanbul|\bc8\b|jshint|tslint|@ts-|biome-|deno-|noqa|pylint|shellcheck|nolint|noinspection|ignore|skip|suppress|disable|webpack|sourceMapping|@jsx|environment|<reference|<amd-|^\s*(?:\/\/|#)\s*!|\b(?:global|exported)\s/i;

/** El texto de un comentario sin sus marcas; el de una directiva queda entero, para que una marca ahí cuente como cambio. */
function sinMarcasDelComentario(texto) {
  const sin = String(texto).replace(MARCA_DE_PRUEBA, '');
  return sin !== String(texto) && DIRECTIVA.test(sin) ? String(texto) : sin;
}

/** `{ codigo, salida }`; `codigo: null` si git no pudo contestar (no está, no es un repo accesible, venció el tiempo). */
function correrGitDeVerdad(carpeta, args, env) {
  try {
    const salida = execFileSync('git', args, {
      cwd: carpeta, env, encoding: 'utf8', timeout: TIEMPO_MAX_MS, maxBuffer: SALIDA_MAX_BYTES, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { codigo: 0, salida };
  } catch (e) {
    return { codigo: typeof e.status === 'number' ? e.status : null, salida: '' };
  }
}

// Sin bloquear el índice de quien esté trabajando: `status` lo refresca si puede.
function entornoBase() {
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

const NO_CUENTA = (motivo, regla, extra = {}) => ({ cuenta: false, regla, motivo, ...extra });
const SIN_RESPUESTA = (regla) => NO_CUENTA('sin-respuesta', regla);

/**
 * Un juez por cálculo: guarda cada respuesta de git, así una pregunta se hace una sola vez.
 * `repoDelIndice`: la raíz del repo al que pertenece GIT_INDEX_FILE, si está puesta.
 * `historia`: `{ numero, archivo, catalogo, clave?, pedidos? }`, con `catalogo()` la lista `[{ numero, archivo }]` del repo de
 * la historia, o null si no se pudo leer, y `pedidos()` lo que devuelve `leer` de lib/story-requests.js. Sin ella no hay reglas
 * que dependan de saber de qué historia es un commit.
 */
function crearJuez({ correrGit = correrGitDeVerdad, repoDelIndice = null, historia = null } = {}) {
  const respuestas = new Map();
  const base = entornoBase();
  let catalogoLeido;
  let pedidosLeidos;
  const pedidosDeLaHistoria = () => {
    if (pedidosLeidos === undefined) pedidosLeidos = historia.pedidos().porPedido;
    return pedidosLeidos;
  };
  const historiaDe = (rama) => {
    if (!historia) return null;
    if (catalogoLeido === undefined) catalogoLeido = historia.catalogo();
    return historiaDeLaRama(rama, { propia: historia, catalogo: catalogoLeido });
  };

  function preguntar(carpeta, pedido, env = base) {
    // con `log.showSignature` prendido, git escribe la firma de cada commit antes del formato pedido y se leería como un commit
    const args = pedido[0] === 'log' ? ['log', '--no-show-signature', ...pedido.slice(1)] : pedido;
    // lo que contesta lo mismo desde cualquier carpeta del repo se pregunta una vez, desde su raíz
    const donde = delRepo(pedido) ? raizDe(carpeta) || carpeta : carpeta;
    const clave = `${env === base ? '' : 'indice\0'}${donde}\0${args.join('\0')}`;
    if (!respuestas.has(clave)) respuestas.set(clave, correrGit(donde, args, env));
    return respuestas.get(clave);
  }

  // Una pregunta sobre commits y referencias, sin ninguna ruta (ni `--` ni «revisión:archivo»): su respuesta es la del repo.
  // `rev-parse` sólo con lo que no depende de la carpeta: `--git-common-dir` y `--show-toplevel` contestan según dónde corre.
  function delRepo(pedido) {
    if (pedido.includes('--') || pedido.some((a) => a.includes(':'))) return false;
    if (pedido[0] === 'rev-parse') return pedido.includes('--verify') || pedido.includes('--is-shallow-repository');
    return ['log', 'rev-list', 'merge-base', 'cat-file'].includes(pedido[0]);
  }

  function raizDe(carpeta) {
    const r = preguntar(carpeta, ['rev-parse', '--show-toplevel']);
    return r.codigo === 0 ? r.salida.trim() || null : null;
  }

  // Sólo un «false» explícito deja comparar: sin respuesta, no se sabe si la historia está entera.
  function historiaEntera(carpeta) {
    const r = preguntar(carpeta, ['rev-parse', '--is-shallow-repository']);
    return r.codigo === 0 && r.salida.trim() === 'false';
  }

  // El entorno para lo que lee el índice (`ls-files`, `status`), según de qué repo sea.
  function entornoDelIndice(raiz) {
    const indice = process.env.GIT_INDEX_FILE;
    if (!indice || !repoDelIndice) return base;
    if (raizDe(repoDelIndice) !== raiz) return base;
    // Absoluta: una ruta relativa se cuenta desde donde corre este proceso, y git corre en otra carpeta.
    return { ...base, GIT_INDEX_FILE: path.resolve(indice) };
  }

  // La historia de un registro, del commit más nuevo al más viejo, con los renglones que cada uno agregó y sacó. Una sola
  // pasada de git por registro: buscar renglón por renglón costaba una pasada por cada humo.
  const historias = new Map();
  function historiaDelRegistro(carpeta, nombre) {
    const clave = `${carpeta}\0${nombre}`;
    if (historias.has(clave)) return historias.get(clave);
    const r = preguntar(carpeta, ['log', '--topo-order', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-renames',
      `--format=${MARCA_DE_COMMIT}${FORMATO_DE_COMMIT}`, 'HEAD', '--', nombre]);
    let commits = null;
    if (r.codigo === 0) {
      commits = [];
      let actual = null;
      let enElCambio = false;
      for (const renglon of r.salida.split('\n')) {
        if (renglon.startsWith(MARCA_DE_COMMIT)) {
          const [hash, hora] = renglon.slice(1).split(' ');
          actual = { hash, hora: Number(hora), agregados: [], sacados: [] };
          commits.push(actual);
          enElCambio = false;
        } else if (!actual) {
          continue;
        } else if (renglon.startsWith('@@')) {
          enElCambio = true;
        } else if (renglon.startsWith('diff ')) {
          enElCambio = false;
        } else if (enElCambio && renglon.startsWith('+')) {
          actual.agregados.push(renglon.slice(1));
        } else if (enElCambio && renglon.startsWith('-')) {
          actual.sacados.push(renglon.slice(1));
        }
      }
    }
    historias.set(clave, commits);
    return commits;
  }

  const vecesEn = (renglones, texto) => renglones.reduce((n, r) => n + r.split(texto).length - 1, 0);

  // El commit que guardó la evidencia es el más viejo que cambió cuántas veces aparece su renglón: lo mismo que contesta
  // `git log -S<renglón>` tomando el último de la salida.
  function commitDeLaEvidencia({ ruta, linea }) {
    const carpeta = path.dirname(ruta);
    const nombre = path.basename(ruta);
    if (!linea) {
      const r = preguntar(carpeta, ['log', '--topo-order', `--format=${FORMATO_DE_COMMIT}`, '--diff-filter=A', 'HEAD', '--', nombre]);
      if (r.codigo !== 0) return { fallo: true };
      const lineas = r.salida.trim().split('\n').filter(Boolean);
      if (!lineas.length) return { commit: null };
      const [hash, hora] = lineas[lineas.length - 1].split(' ');
      return { commit: hash, hora: Number(hora) };
    }
    const commits = historiaDelRegistro(carpeta, nombre);
    if (!commits) return { fallo: true };
    for (let i = commits.length - 1; i >= 0; i -= 1) {
      const c = commits[i];
      if (vecesEn(c.agregados, linea) !== vecesEn(c.sacados, linea)) return { commit: c.hash, hora: c.hora };
    }
    return { commit: null };
  }


  function ultimoCommitCorto(carpeta, nombre) {
    const r = preguntar(carpeta, ['log', '-1', '--format=%h', 'HEAD', '--', nombre]);
    return r.codigo === 0 ? r.salida.trim() || null : null;
  }

  // La fusión de pedido de esta historia más nueva y posterior a `t`, con cómo estaba su rama a esa hora. `igual` si el archivo
  // de HEAD es el de ese estado; alcanza con una de ellas.
  function ramaPropia(carpeta, nombre, t) {
    const fusiones = preguntar(carpeta, ['log', '--merges', `--since=@${t}`, '--format=%h %P%x09%s', 'HEAD']);
    if (fusiones.codigo !== 0) return null;
    let distinta = null;
    for (const linea of fusiones.salida.split('\n').filter(Boolean)) {
      const [ids, asunto] = linea.split('\t');
      const [corto, , segundoPadre] = ids.split(' ');
      if (!segundoPadre || historiaDe(ramaDelAsunto(asunto)) !== 'propia') continue;
      const estado = preguntar(carpeta, ['rev-list', '-1', '--first-parent', `--before=@${t}`, segundoPadre]).salida.trim();
      if (!estado) continue;
      const diff = preguntar(carpeta, ['diff-tree', '--quiet', '-r', estado, 'HEAD', '--', nombre]);
      if (diff.codigo === 0) return { igual: true, estado, fusion: corto };
      if (diff.codigo === 1 && !distinta) distinta = { igual: false, estado, fusion: corto };
    }
    return distinta;
  }

  // La ruta del archivo desde la raíz de su repo, cruda: sin -z, git la escribe entre comillas y con escapes si no es ASCII.
  function rutaEnElRepo(carpeta, nombre) {
    const r = preguntar(carpeta, ['ls-files', '-z', '--full-name', '--', nombre]);
    return r.codigo === 0 ? r.salida.split('\0')[0] || null : null;
  }

  // La historia de la fusión que trajo el commit `c`: la primera, de la más vieja a la más nueva, que lo alcanza por su
  // segundo padre y no por el primero. Una fusión posterior que no lo trajo no cuenta. Sin esa fusión (un commit directo,
  // un squash) o con un asunto que no es de pedido, no se sabe.
  function historiaDelCommit(carpeta, c) {
    const fusiones = preguntar(carpeta, ['log', '--merges', '--ancestry-path', '--topo-order', '--reverse', '--format=%H %P%x09%s', `${c}..HEAD`]);
    if (fusiones.codigo !== 0) return null;
    for (const linea of fusiones.salida.split('\n').filter(Boolean)) {
      const [ids, asunto] = linea.split('\t');
      const [, primerPadre] = ids.split(' ');
      const porElPrimero = preguntar(carpeta, ['merge-base', '--is-ancestor', c, primerPadre]);
      if (porElPrimero.codigo === 0) continue;
      if (porElPrimero.codigo !== 1) return null;
      return historiaDe(ramaDelAsunto(asunto));
    }
    return null;
  }

  // Si el archivo es de prueba y todos los commits que lo cambiaron desde `desde` son de otra historia, el más nuevo con su
  // historia. El archivo de HEAD tiene que ser el de uno de esos commits: si no, lo escribió la resolución de una fusión, y
  // no se sabe de quién es.
  function pruebaDeOtraHistoria(carpeta, nombre, desde) {
    if (!historia || !desde) return null;
    const rel = rutaEnElRepo(carpeta, nombre);
    if (!rel || !isTestPath(rel)) return null;
    const commits = preguntar(carpeta, ['log', '--no-merges', '--format=%h', `${desde}..HEAD`, '--', nombre]);
    const lista = commits.codigo === 0 ? commits.salida.split('\n').filter(Boolean) : [];
    if (!lista.length) return null;
    const enHead = preguntar(carpeta, ['rev-parse', '--verify', '-q', `HEAD:${rel}`]).salida.trim();
    if (!enHead || !lista.some((c) => preguntar(carpeta, ['rev-parse', '--verify', '-q', `${c}:${rel}`]).salida.trim() === enHead)) return null;
    let delMasNuevo = null;
    for (const c of lista) {
      const de = historiaDelCommit(carpeta, c);
      if (!de || de === 'propia') return null;
      delMasNuevo = delMasNuevo || { commit: c, historia: de.numero };
    }
    return delMasNuevo;
  }

  // ¿La carpeta está en la rama de la historia? El mismo juez que reconoce la rama de una fusión de pedido.
  function enLaRamaDeLaHistoria(carpeta) {
    const r = preguntar(carpeta, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return r.codigo === 0 && historiaDe(r.salida.trim()) === 'propia';
  }

  // Si el archivo es de prueba, ¿lo cambió la propia historia? Los commits de `rango` (los que lo tocaron después de la
  // evidencia) tienen que ser todos propios o de otra historia, y al menos uno propio; sin ninguno (`vacio`), alcanza
  // con que la carpeta esté en la rama de la historia. Un commit sin fusión de pedido es propio si la carpeta está en la
  // rama de la historia y el commit no está en origin/main (es lo de siempre dentro de una corrida). El archivo de HEAD
  // tiene que ser el de uno de los commits: si no, lo escribió la resolución de una fusión. Cualquier duda da false.
  function laCambioLaPropia(carpeta, nombre, rango, { vacio = false, propioSinCommitear = false } = {}) {
    if (!historia) return false;
    const rel = rutaEnElRepo(carpeta, nombre);
    if (!rel || !isTestPath(rel)) return false;
    const commits = preguntar(carpeta, ['log', '--no-merges', '--format=%h', ...rango, '--', nombre]);
    if (commits.codigo !== 0) return false;
    const lista = commits.salida.split('\n').filter(Boolean);
    if (!lista.length) return vacio && enLaRamaDeLaHistoria(carpeta);
    const enHead = preguntar(carpeta, ['rev-parse', '--verify', '-q', `HEAD:${rel}`]).salida.trim();
    if (!enHead || !lista.some((c) => preguntar(carpeta, ['rev-parse', '--verify', '-q', `${c}:${rel}`]).salida.trim() === enHead)) return false;
    let propios = 0;
    for (const c of lista) {
      const de = historiaDelCommit(carpeta, c);
      if (de === 'propia') { propios += 1; continue; }
      if (de) continue;
      if (!enLaRamaDeLaHistoria(carpeta) || preguntar(carpeta, ['merge-base', '--is-ancestor', c, 'origin/main']).codigo !== 1) return false;
      propios += 1;
    }
    // la edición sin commitear en la rama de la historia es suya, aunque los commits del medio sean todos de otra
    return propios > 0 || propioSinCommitear;
  }

  // Los criterios que una prueba nombra para esta historia: los `@ac-N` de todo el archivo que nombra `@story-<historia>`,
  // como story-checks.js, que busca las dos marcas en todo el archivo. En un archivo de varias historias suma también los
  // criterios de las otras: vencer de más es el lado seguro. Se juntan la versión del disco, la de HEAD y la que juzgó la
  // evidencia (`desde`): un `@ac` que el arreglo sacó también vence, esté commiteado o no. Sin ninguno, con el archivo
  // ilegible o con `desde` que no se deja leer, null.
  function criteriosDeLaPrueba(archivo, carpeta, nombre, desde) {
    let disco;
    try { disco = require('fs').readFileSync(archivo, 'utf8'); } catch (_) { return null; }
    // un git que no contesta la ruta no es «el archivo no está en git»: sin las versiones de HEAD y de la evidencia, los
    // criterios del disco solos vencerían de menos, y con null vence toda (el lado seguro). Sin rastrear, sólo el disco
    const enGit = preguntar(carpeta, ['ls-files', '-z', '--full-name', '--', nombre]);
    if (enGit.codigo !== 0) return null;
    const rel = enGit.salida.split('\0')[0] || null;
    const textos = [disco];
    for (const rev of ['HEAD', ...(desde ? [desde] : [])]) {
      if (!rel) break;
      if (preguntar(carpeta, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]).codigo !== 0) return null;
      // el archivo puede no existir todavía en esa versión: entonces no aporta marcas
      if (preguntar(carpeta, ['cat-file', '-e', `${rev}:${rel}`]).codigo !== 0) continue;
      const texto = preguntar(carpeta, ['show', `${rev}:${rel}`]);
      if (texto.codigo !== 0) return null;
      textos.push(texto.salida);
    }
    const numero = historia.numero.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const marca = new RegExp(`@story-${numero}(?![\\w.])`);
    const criterios = new Set();
    for (const t of textos) {
      if (!marca.test(t)) continue;
      for (const m of t.matchAll(/@ac-(\d+)\b/g)) criterios.add(Number(m[1]));
    }
    return criterios.size ? [...criterios].sort((a, b) => a - b) : null;
  }

  // ¿Lo único que cambió en la prueba, de la versión que juzgó la evidencia (`desde`) a la del disco, son marcas? En el
  // nombre de una prueba o en un comentario, nunca en un dato ni en una directiva. Sólo en JS y TS (soloMarcasEnElCodigo),
  // que el lector sabe leer; en otro lenguaje, también shell, no se sabe qué renglón es un comentario, y vence como
  // siempre. Sin `desde`, sin el archivo en esa versión, igual a la de ahora o con git sin contestar, no.
  function soloMarcas(archivo, carpeta, nombre, desde) {
    if (!desde) return false;
    let ahora;
    try { ahora = require('fs').readFileSync(archivo, 'utf8'); } catch (_) { return false; }
    const rel = rutaEnElRepo(carpeta, nombre);
    if (!rel || preguntar(carpeta, ['cat-file', '-e', `${desde}:${rel}`]).codigo !== 0) return false;
    const antes = preguntar(carpeta, ['show', `${desde}:${rel}`]);
    if (antes.codigo !== 0 || antes.salida === ahora) return false;
    const ext = path.extname(rel).toLowerCase();
    return changeKind.EXTENSIONES.includes(ext) && ext !== '.cs' ? soloMarcasEnElCodigo(antes.salida, ahora, ext) : false;
  }

  // La regla 6 por criterio: la prueba que la propia historia cambió vence sólo la evidencia de los criterios que nombra,
  // porque pudo dar verde por estar mal sólo en lo que mira. `criterios: null` vence toda la evidencia. `desde` es la
  // versión que juzgó la evidencia. Si sólo le cambió marcas, no vence nada.
  const porCriterio = (archivo, carpeta, nombre, motivo, regla, desde, extra = {}) => (soloMarcas(archivo, carpeta, nombre, desde)
    ? { cuenta: true, regla: 6, via: 'solo-marcas', reglaDeOrigen: regla }
    : NO_CUENTA(motivo, 6, { ...extra, reglaDeOrigen: regla, criterios: criteriosDeLaPrueba(archivo, carpeta, nombre, desde) }));

  // Con la prueba sin commitear al correr, el commit que guardó justo lo probado no es un cambio posterior: se cuenta desde
  // el primero que dejó el archivo igual a su huella. Si ninguno lo hizo, desde el ancla.
  function desdeElAncla(carpeta, nombre, ancla) {
    const rel = rutaEnElRepo(carpeta, nombre);
    const huella = rel && ancla.huellas && ancla.huellas[rel];
    if (!huella) return ancla.commit;
    const commits = preguntar(carpeta, ['log', '--topo-order', '--reverse', '--format=%H', `${ancla.commit}..HEAD`, '--', nombre]);
    if (commits.codigo !== 0) return ancla.commit;
    const guardo = commits.salida.split('\n').filter(Boolean)
      .find((c) => preguntar(carpeta, ['rev-parse', '--verify', '-q', `${c}:${rel}`]).salida.trim() === huella);
    return guardo || ancla.commit;
  }

  // El nombre del repo: el de su checkout principal, igual desde un worktree.
  function nombreDelRepo(carpeta) {
    const comun = preguntar(carpeta, ['rev-parse', '--git-common-dir']);
    if (comun.codigo !== 0) return null;
    const dir = path.resolve(carpeta, comun.salida.trim());
    return path.basename(path.basename(dir) === '.git' ? path.dirname(dir) : dir);
  }

  // El ancla de la evidencia para este repo, si tiene.
  function anclaDelRepo(carpeta, evidencia) {
    if (!Array.isArray(evidencia.ancla)) return null;
    const nombre = nombreDelRepo(carpeta);
    if (!nombre) return null;
    return evidencia.ancla.find((a) => a && a.repo === nombre && a.commit) || null;
  }

  // ¿El archivo de HEAD es el que probó la evidencia? true, false, o null si el commit del ancla no está en este clon.
  function igualAlAncla(carpeta, nombre, ancla) {
    const rel = rutaEnElRepo(carpeta, nombre);
    if (!rel) return null;
    if (ancla.huellas && Object.prototype.hasOwnProperty.call(ancla.huellas, rel)) {
      const enHead = preguntar(carpeta, ['rev-parse', '--verify', '-q', `HEAD:${rel}`]);
      // 1 es «no está en HEAD»; cualquier otra respuesta es git que no contestó, y nunca da verde
      if (enHead.codigo === 1) return ancla.huellas[rel] === null;
      if (enHead.codigo !== 0) return null;
      return enHead.salida.trim() === ancla.huellas[rel];
    }
    const diff = preguntar(carpeta, ['diff-tree', '--quiet', '-r', ancla.commit, 'HEAD', '--', nombre]);
    return diff.codigo === 0 ? true : diff.codigo === 1 ? false : null;
  }

  const cuentaPorPrueba = (ajena) => ({ cuenta: true, regla: 6, commit: ajena.commit, historia: ajena.historia });

  // El sello de lo que se guarda, por repo: el árbol de ahora (lib/frozen-tree.js). Una sola vez por cálculo.
  const sellosDeAhora = new Map();
  function selloDeAhora(raiz) {
    if (!sellosDeAhora.has(raiz)) sellosDeAhora.set(raiz, require('./frozen-tree.js').seal(raiz).tree || null);
    return sellosDeAhora.get(raiz);
  }

  /**
   * La regla del sello (historia 8.161, decisión 5), antes que las otras: un humo que trae el sello del árbol que probó
   * cuenta si el archivo declarado es igual en ese sello y en lo que se guarda; si difiere, es de otra versión de lo
   * declarado. Vale sólo para el repo de la evidencia: los hermanos siguen con su ancla. Las pruebas siguen la regla 6.
   * Un humo sin sello, o con un sello que este clon no tiene (se escribió en otra máquina), sigue las reglas de siempre.
   * Devuelve el veredicto o null para seguir.
   */
  function reglaDelSello(archivo, evidencia) {
    const s = evidencia.sello;
    if (!s) return null;
    const raizArchivo = raizDe(path.dirname(archivo));
    const raizEvidencia = raizDe(path.dirname(evidencia.ruta));
    if (!raizArchivo || !raizEvidencia || raizArchivo !== raizEvidencia) return null;
    let real = archivo;
    try { real = require('fs').realpathSync(archivo); } catch (_) { /* un archivo a crear: su ruta tal cual */ }
    const rel = path.relative(raizArchivo, real).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || isTestPath(rel)) return null;
    if (!s.tree) return NO_CUENTA('sin-sello', 'sello', { error: s.error || null });
    if (preguntar(raizArchivo, ['cat-file', '-e', `${s.tree}^{tree}`]).codigo !== 0) return null;
    const ahora = selloDeAhora(raizArchivo);
    if (!ahora) return SIN_RESPUESTA('sello');
    const blob = (t) => {
      const r = preguntar(raizArchivo, ['rev-parse', '--verify', '-q', `${t}:${rel}`]);
      return r.codigo === 0 ? r.salida.trim() : r.codigo === 1 ? null : undefined;
    };
    const antes = blob(s.tree);
    const despues = blob(ahora);
    if (antes === undefined || despues === undefined) return SIN_RESPUESTA('sello');
    if (antes === despues) return { cuenta: true, regla: 'sello' };
    return NO_CUENTA('otra-version', 'sello', { tree: s.tree });
  }

  /**
   * `archivo`: ruta absoluta · `mtimeMs`: su fecha en disco · `evidencia`: `{ ruta, tsMs, linea }`, con `linea` la línea
   * entera del registro si es un humo: el `ts` solo no identifica una corrida, porque puede haber dos en un segundo.
   * Devuelve `{ cuenta, regla, motivo?, commit? }`.
   */
  function vigencia({ archivo, mtimeMs, evidencia }) {
    const porSello = reglaDelSello(archivo, evidencia);
    if (porSello) return porSello;
    if (!Number.isFinite(evidencia.tsMs)) return NO_CUENTA('sin-hora', 1);
    if (mtimeMs <= evidencia.tsMs) return { cuenta: true, regla: 1 };

    const carpeta = path.dirname(archivo);
    const nombre = path.basename(archivo);
    const raizArchivo = raizDe(carpeta);
    if (!raizArchivo) return SIN_RESPUESTA(2);
    const conIndice = entornoDelIndice(raizArchivo);
    // `status` no muestra los ignorados ni los marcados para no mirarlos: sin esta pregunta, los dos pasarían por «sin
    // cambios». La letra de `-v`: minúscula es assume-unchanged, y S es skip-worktree.
    const enGit = preguntar(carpeta, ['ls-files', '-v', '--', nombre], conIndice);
    if (enGit.codigo !== 0) return SIN_RESPUESTA(2);
    const letra = enGit.salida.trim().charAt(0);
    if (!letra) return NO_CUENTA('fuera-de-git', 2);
    if (letra === 'S' || letra !== letra.toUpperCase()) return NO_CUENTA('oculto-para-git', 2);
    const estado = preguntar(carpeta, ['status', '--porcelain', '--', nombre], conIndice);
    if (estado.codigo !== 0) return SIN_RESPUESTA(2);
    if (estado.salida.trim()) {
      // la prueba que la historia está corrigiendo, todavía sin commitear: en su rama, y con los commits posteriores a la
      // evidencia (por su hora: la evidencia puede vivir en otro repo) propios o de otra historia
      const desde = Number.isFinite(evidencia.tsMs) ? [`--since=@${Math.floor(evidencia.tsMs / 1000)}`, 'HEAD'] : null;
      if (desde && enLaRamaDeLaHistoria(carpeta) && laCambioLaPropia(carpeta, nombre, desde, { vacio: true, propioSinCommitear: true })) {
        // la versión que juzgó la evidencia: el último commit anterior a su hora. Sin poder buscarla, vence toda
        const antes = preguntar(carpeta, ['rev-list', '-1', `--before=@${Math.floor(evidencia.tsMs / 1000)}`, 'HEAD']);
        if (antes.codigo !== 0) return NO_CUENTA('sin-commitear', 2);
        return porCriterio(archivo, carpeta, nombre, 'sin-commitear', 2, antes.salida.trim() || undefined);
      }
      return NO_CUENTA('sin-commitear', 2);
    }

    const carpetaEvidencia = path.dirname(evidencia.ruta);
    const raizEvidencia = raizDe(carpetaEvidencia);
    if (!raizEvidencia || !historiaEntera(carpetaEvidencia)) return SIN_RESPUESTA(3);
    const guardada = commitDeLaEvidencia(evidencia);
    if (guardada.fallo) return SIN_RESPUESTA(3);
    if (!guardada.commit) return NO_CUENTA('evidencia-sin-commitear', 3);

    if (raizArchivo === raizEvidencia) {
      // `diff-tree` compara los dos commits sin mirar los filtros de `diff` que cada máquina tenga configurados.
      const diff = preguntar(carpeta, ['diff-tree', '--quiet', '-r', guardada.commit, 'HEAD', '--', nombre]);
      if (diff.codigo === 0) return { cuenta: true, regla: 4 };
      if (diff.codigo !== 1) return SIN_RESPUESTA(4);
      const ajena = pruebaDeOtraHistoria(carpeta, nombre, guardada.commit);
      if (ajena) return cuentaPorPrueba(ajena);
      const commit = ultimoCommitCorto(carpeta, nombre);
      if (laCambioLaPropia(carpeta, nombre, [`${guardada.commit}..HEAD`])) return porCriterio(archivo, carpeta, nombre, 'cambio-posterior', 4, guardada.commit, { commit });
      return NO_CUENTA('cambio-posterior', 4, { commit });
    }

    if (!historiaEntera(carpeta)) return SIN_RESPUESTA(5);
    const ancla = anclaDelRepo(carpeta, evidencia);
    if (ancla) {
      const igual = igualAlAncla(carpeta, nombre, ancla);
      if (igual) return { cuenta: true, regla: 5, via: 'ancla' };
      if (igual === false) {
        const desdeAncla = desdeElAncla(carpeta, nombre, ancla);
        const ajena = pruebaDeOtraHistoria(carpeta, nombre, desdeAncla);
        if (ajena) return cuentaPorPrueba(ajena);
        const commit = ultimoCommitCorto(carpeta, nombre);
        if (laCambioLaPropia(carpeta, nombre, [`${desdeAncla}..HEAD`])) return porCriterio(archivo, carpeta, nombre, 'cambio-posterior', 5, desdeAncla, { commit });
        return NO_CUENTA('cambio-posterior', 5, { commit });
      }
    }
    const ultimo = preguntar(carpeta, ['log', '-1', '--first-parent', `--format=${FORMATO_DE_COMMIT}`, 'HEAD', '--', nombre]);
    if (ultimo.codigo !== 0 || !ultimo.salida.trim()) return SIN_RESPUESTA(5);
    const [, hora, corto] = ultimo.salida.trim().split(' ');
    if (!Number.isFinite(guardada.hora) || !Number.isFinite(Number(hora))) return SIN_RESPUESTA(5);
    if (Number(hora) <= guardada.hora) return { cuenta: true, regla: 5 };
    // la menor de las dos horas: una evidencia guardada mucho después de correr no prueba lo que se commiteó en el medio
    const t = Math.min(guardada.hora, Math.floor(evidencia.tsMs / 1000));
    const propia = historia ? ramaPropia(carpeta, nombre, t) : null;
    if (propia && propia.igual) return { cuenta: true, regla: 5, via: 'fusion-propia', fusion: propia.fusion };
    const desde = propia ? propia.estado : historia && preguntar(carpeta, ['rev-list', '-1', '--first-parent', `--before=@${t}`, 'HEAD']).salida.trim();
    const ajena = pruebaDeOtraHistoria(carpeta, nombre, desde);
    if (ajena) return cuentaPorPrueba(ajena);
    const padres = preguntar(carpeta, ['log', '-1', '--format=%p', corto]).salida.trim().split(' ').filter(Boolean);
    if (desde && laCambioLaPropia(carpeta, nombre, [`${desde}..HEAD`])) return porCriterio(archivo, carpeta, nombre, 'otro-repo', 5, desde, { commit: corto, sinFusion: padres.length === 1 });
    return NO_CUENTA('otro-repo', 5, { commit: corto, sinFusion: padres.length === 1 });
  }

  // El blob de un archivo en una versión: su id, null si ahí no está, undefined si git no contestó.
  function blobEn(carpeta, rev, rel) {
    const r = preguntar(carpeta, ['rev-parse', '--verify', '-q', `${rev}:${rel}`]);
    if (r.codigo === 0) return r.salida.trim();
    return r.codigo === 1 ? null : undefined;
  }

  // Lo que probó la evidencia y hasta qué hora mirar, o null si no se puede saber.
  function loProbado(carpeta, rel, evidencia, guardada, mismoRepo) {
    const hora = Math.floor(evidencia.tsMs / 1000);
    if (mismoRepo) {
      const s = evidencia.sello;
      if (s && !s.tree) return null;
      const conSello = s && preguntar(carpeta, ['cat-file', '-e', `${s.tree}^{tree}`]).codigo === 0;
      const blob = blobEn(carpeta, conSello ? s.tree : guardada.commit, rel);
      return blob ? { blob, hora: Number.isFinite(guardada.hora) ? Math.min(hora, guardada.hora) : hora, version: guardada.commit } : null;
    }
    const ancla = anclaDelRepo(carpeta, evidencia);
    if (!ancla) return null;
    const hayCommit = preguntar(carpeta, ['cat-file', '-e', `${ancla.commit}^{commit}`]).codigo === 0;
    const version = hayCommit ? ancla.commit : undefined;
    if (ancla.huellas && Object.prototype.hasOwnProperty.call(ancla.huellas, rel)) return ancla.huellas[rel] ? { blob: ancla.huellas[rel], hora, version } : null;
    if (!hayCommit) return null;
    const blob = blobEn(carpeta, ancla.commit, rel);
    return blob ? { blob, hora, version } : null;
  }

  const lineasDe = (r) => r.salida.split('\n').filter(Boolean);

  // ¿Es de esta historia un commit de la línea principal? 'propia', `{ numero }`, null si no se sabe, o undefined si git no
  // contestó. Los asuntos de sus commits sólo pueden decir «propia»: son texto libre.
  function deQuienEs(carpeta, { asunto, padres }) {
    const pedidos = historia.pedidos ? pedidosDeLaHistoria() : null;
    if (catalogoLeido === undefined) catalogoLeido = historia.catalogo();
    const repo = nombreDelRepo(carpeta);
    const deLa = (a) => historiaDeLaFusion(a, { repo, propia: historia, catalogo: catalogoLeido, pedidos });
    const de = deLa(asunto);
    if (de === 'propia') return de;
    let asuntos = [asunto];
    if (padres.length > 1) {
      // también las fusiones de adentro: en un producto con `dev`, el pedido de la historia entra a `dev` y `dev` a main
      const r = preguntar(carpeta, ['log', '--format=%s', `${padres[0]}..${padres[1]}`]);
      if (r.codigo !== 0) return undefined;
      asuntos = lineasDe(r);
    }
    return asuntos.some((a) => nombraLaHistoria(a, historia.numero) || deLa(a) === 'propia') ? 'propia' : de;
  }

  /**
   * La regla de la entrada para un archivo. null si no se aplica, y entonces decide lo de siempre. Si no: `{ cuenta: true,
   * regla: 'entrada', commit, yaEstaba, ajenas, sinHistoria }`, con `commit` null si el archivo ya estaba así antes de la
   * evidencia, o `{ cuenta: false, regla: 'entrada', motivo, commit }`. Una duda de git siempre da null: nunca «entró igual».
   */
  function entrada({ archivo, evidencia }) {
    if (!historia || !Number.isFinite(evidencia.tsMs)) return null;
    const carpeta = path.dirname(archivo);
    const nombre = path.basename(archivo);
    const raizArchivo = raizDe(carpeta);
    if (!raizArchivo) return null;
    const conIndice = entornoDelIndice(raizArchivo);
    const enGit = preguntar(carpeta, ['ls-files', '-v', '--', nombre], conIndice);
    if (enGit.codigo !== 0) return null;
    const letra = enGit.salida.trim().charAt(0);
    if (!letra || letra === 'S' || letra !== letra.toUpperCase()) return null;
    const estado = preguntar(carpeta, ['status', '--porcelain', '--', nombre], conIndice);
    if (estado.codigo !== 0 || estado.salida.trim()) return null;
    const rel = rutaEnElRepo(carpeta, nombre);
    if (!rel) return null;

    const carpetaEvidencia = path.dirname(evidencia.ruta);
    const raizEvidencia = raizDe(carpetaEvidencia);
    if (!raizEvidencia || !historiaEntera(carpetaEvidencia) || !historiaEntera(carpeta)) return null;
    const guardada = commitDeLaEvidencia(evidencia);
    if (guardada.fallo || !guardada.commit) return null;
    if (preguntar(carpeta, ['rev-parse', '--verify', '-q', `${MAIN}^{commit}`]).codigo !== 0) return null;
    // un commit de esta copia que todavía no está en main y cambió el archivo: lo probado ya no es lo que hay
    const sinFusionar = preguntar(carpeta, ['log', '--format=%H', `${MAIN}..HEAD`, '--', nombre]);
    if (sinFusionar.codigo !== 0 || sinFusionar.salida.trim()) return null;

    const probado = loProbado(carpeta, rel, evidencia, guardada, raizArchivo === raizEvidencia);
    if (!probado) return null;
    const antes = preguntar(carpeta, ['rev-list', '-1', '--first-parent', `--before=@${probado.hora}`, MAIN]);
    if (antes.codigo !== 0 || !antes.salida.trim()) return null;
    let desde = antes.salida.trim();
    const enAntes = blobEn(carpeta, desde, rel);
    if (enAntes === undefined) return null;
    let commit = null;
    if (enAntes !== probado.blob) {
      const cambios = preguntar(carpeta, ['log', '--first-parent', '--reverse', '--format=%H %h', `${desde}..${MAIN}`, '--', nombre]);
      if (cambios.codigo !== 0) return null;
      const primero = lineasDe(cambios)[0];
      if (!primero) return null;
      const [largo, corto] = primero.split(' ');
      const entro = blobEn(carpeta, largo, rel);
      if (entro === undefined) return null;
      if (entro !== probado.blob) return NO_CUENTA('entro-otro-contenido', 'entrada', { commit: corto, desde: probado.version });
      if (preguntar(carpeta, ['merge-base', '--is-ancestor', largo, 'HEAD']).codigo !== 0) return null;
      desde = largo;
      commit = corto;
    }

    const despues = preguntar(carpeta, ['log', '--first-parent', '--reverse', '--format=%h%x09%P%x09%s', `${desde}..${MAIN}`, '--', nombre]);
    if (despues.codigo !== 0) return null;
    const ajenas = [];
    const sinHistoria = [];
    for (const linea of lineasDe(despues)) {
      const [corto, padres, ...resto] = linea.split('\t');
      const de = deQuienEs(carpeta, { asunto: resto.join('\t'), padres: padres.split(' ').filter(Boolean) });
      if (de === undefined) return null;
      if (de === 'propia') return NO_CUENTA('cambio-propio-tras-entrar', 'entrada', { commit: corto, fusion: corto, desde: probado.version });
      if (de) ajenas.push({ commit: corto, historia: de.numero });
      else sinHistoria.push(corto);
    }
    return { cuenta: true, regla: 'entrada', commit, yaEstaba: commit === null, ajenas, sinHistoria };
  }

  // Los criterios que nombra una prueba, con las marcas de la regla 6. `desde`: la versión que juzgó la evidencia.
  function criteriosDe({ archivo, desde }) {
    return criteriosDeLaPrueba(archivo, path.dirname(archivo), path.basename(archivo), desde);
  }

  // El nombre del repo de un archivo (el de su checkout principal, como el ancla), o null si git no contesta.
  const repos = new Map();
  function repoDe(archivo) {
    const carpeta = path.dirname(archivo);
    if (!repos.has(carpeta)) repos.set(carpeta, nombreDelRepo(carpeta));
    return repos.get(carpeta);
  }

  return { vigencia, commitDeLaEvidencia, entrada, criteriosDe, repoDe };
}

/** Por qué no cuenta, en una frase para el aviso de la matriz. Sin rutas ni texto de git: la matriz viaja por git. */
function motivoEnPalabras({ motivo, commit, sinFusion, tree, error }) {
  switch (motivo) {
    case 'otra-version': return `hay un humo de otra versión de lo declarado (${String(tree || '').slice(0, 12)})`;
    case 'sin-sello': return `el humo no pudo sellar el árbol que probó${error ? ` (${String(error).split('\n')[0].slice(0, 160)})` : ''}: no cuenta como de la versión actual`;
    case 'cambio-posterior': return `lo cambió el commit ${commit || '(sin identificar)'} después de guardarse la evidencia`;
    case 'otro-repo': {
      const causa = `está en otro repo y su commit ${commit} es posterior al de la evidencia (entre repos sólo se pueden comparar horas)`;
      // un commit directo y un squash se ven igual: el squash borra la hora de cada cambio, y no queda con qué comparar
      return sinFusion ? `${causa}; si es un squash de esta historia, borró la hora de cada cambio y hay que repetir la prueba` : causa;
    }
    case 'entro-otro-contenido': return `lo que entró a main en ${commit || '(sin identificar)'} no es lo que se probó`;
    case 'cambio-propio-tras-entrar': return `lo cambió la propia historia en ${commit || '(sin identificar)'}, después de probarlo`;
    case 'sin-commitear': return 'tiene cambios sin commitear';
    case 'fuera-de-git': return 'no está en git';
    case 'oculto-para-git': return 'está marcado para que git no lo mire (assume-unchanged o skip-worktree)';
    case 'evidencia-sin-commitear': return 'la evidencia no está commiteada, y pudo probar el código de otra rama';
    case 'sin-hora': return 'la evidencia no tiene una hora legible';
    default: return 'no se pudo comparar contra git';
  }
}

module.exports = { crearJuez, motivoEnPalabras, correrGitDeVerdad };
