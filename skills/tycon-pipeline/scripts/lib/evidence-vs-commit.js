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
 *   5. En otro repo no hay contenido que comparar: cuenta si el último commit del archivo es anterior o igual al de la
 *      evidencia. Esa hora se lee con --first-parent: un commit viejo que entra por un merge cuenta con la hora del merge.
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

const TIEMPO_MAX_MS = 10000;
const FORMATO_DE_COMMIT = '%H %ct %h';

/** `{ codigo, salida }`; `codigo: null` si git no pudo contestar (no está, no es un repo accesible, venció el tiempo). */
function correrGitDeVerdad(carpeta, args, env) {
  try {
    const salida = execFileSync('git', args, {
      cwd: carpeta, env, encoding: 'utf8', timeout: TIEMPO_MAX_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
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
 */
function crearJuez({ correrGit = correrGitDeVerdad, repoDelIndice = null } = {}) {
  const respuestas = new Map();
  const base = entornoBase();

  function preguntar(carpeta, args, env = base) {
    const clave = `${env === base ? '' : 'indice\0'}${carpeta}\0${args.join('\0')}`;
    if (!respuestas.has(clave)) respuestas.set(clave, correrGit(carpeta, args, env));
    return respuestas.get(clave);
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

  // Los commits salen del más nuevo al más viejo: el que guardó la evidencia es el último.
  function commitDeLaEvidencia({ ruta, linea }) {
    const carpeta = path.dirname(ruta);
    const nombre = path.basename(ruta);
    const filtro = linea ? [`-S${linea}`] : ['--diff-filter=A'];
    const r = preguntar(carpeta, ['log', '--topo-order', `--format=${FORMATO_DE_COMMIT}`, ...filtro, 'HEAD', '--', nombre]);
    if (r.codigo !== 0) return { fallo: true };
    const lineas = r.salida.trim().split('\n').filter(Boolean);
    if (!lineas.length) return { commit: null };
    const [hash, hora] = lineas[lineas.length - 1].split(' ');
    return { commit: hash, hora: Number(hora) };
  }

  function ultimoCommitCorto(carpeta, nombre) {
    const r = preguntar(carpeta, ['log', '-1', '--format=%h', 'HEAD', '--', nombre]);
    return r.codigo === 0 ? r.salida.trim() || null : null;
  }

  /**
   * `archivo`: ruta absoluta · `mtimeMs`: su fecha en disco · `evidencia`: `{ ruta, tsMs, linea }`, con `linea` la línea
   * entera del registro si es un humo: el `ts` solo no identifica una corrida, porque puede haber dos en un segundo.
   * Devuelve `{ cuenta, regla, motivo?, commit? }`.
   */
  function vigencia({ archivo, mtimeMs, evidencia }) {
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
    if (estado.salida.trim()) return NO_CUENTA('sin-commitear', 2);

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
      return NO_CUENTA('cambio-posterior', 4, { commit: ultimoCommitCorto(carpeta, nombre) });
    }

    if (!historiaEntera(carpeta)) return SIN_RESPUESTA(5);
    const ultimo = preguntar(carpeta, ['log', '-1', '--first-parent', `--format=${FORMATO_DE_COMMIT}`, 'HEAD', '--', nombre]);
    if (ultimo.codigo !== 0 || !ultimo.salida.trim()) return SIN_RESPUESTA(5);
    const [, hora, corto] = ultimo.salida.trim().split(' ');
    if (!Number.isFinite(guardada.hora) || !Number.isFinite(Number(hora))) return SIN_RESPUESTA(5);
    if (Number(hora) <= guardada.hora) return { cuenta: true, regla: 5 };
    return NO_CUENTA('otro-repo', 5, { commit: corto });
  }

  return { vigencia };
}

/** Por qué no cuenta, en una frase para el aviso de la matriz. Sin rutas ni texto de git: la matriz viaja por git. */
function motivoEnPalabras({ motivo, commit }) {
  switch (motivo) {
    case 'cambio-posterior': return `lo cambió el commit ${commit || '(sin identificar)'} después de guardarse la evidencia`;
    case 'otro-repo': return `está en otro repo y su commit ${commit} es posterior al de la evidencia (entre repos sólo se pueden comparar horas)`;
    case 'sin-commitear': return 'tiene cambios sin commitear';
    case 'fuera-de-git': return 'no está en git';
    case 'oculto-para-git': return 'está marcado para que git no lo mire (assume-unchanged o skip-worktree)';
    case 'evidencia-sin-commitear': return 'la evidencia no está commiteada, y pudo probar el código de otra rama';
    case 'sin-hora': return 'la evidencia no tiene una hora legible';
    default: return 'no se pudo comparar contra git';
  }
}

module.exports = { crearJuez, motivoEnPalabras, correrGitDeVerdad };
