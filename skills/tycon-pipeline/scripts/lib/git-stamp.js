/**
 * git-stamp.js — la huella de una carpeta de git, leída del disco, para recordar respuestas de git dentro de un proceso.
 *
 * Un mismo proceso (el gancho del commit, el guion de los controles de la base) le hace a git la misma pregunta varias
 * veces: la lista de archivos del commit, lo commiteado de `.tycon/`, la rama. Cada respuesta se recuerda con la carpeta
 * y su huella en la llave; si la huella cambia, se vuelve a preguntar.
 *
 * La huella sale del disco, sin lanzar git: el contenido de `HEAD` (la referencia: una rama nueva en el mismo commit la
 * cambia), el tamaño y la hora de `logs/HEAD` (un commit, un cambio de rama), los del archivo de la referencia, de
 * `packed-refs` y de `MERGE_HEAD` (un merge en curso cambia la lista del commit), y la ruta, el tamaño y la hora del índice en uso (`GIT_INDEX_FILE` si está puesto: el gancho cambia de
 * índice al simular los `git add`). Las horas van en nanosegundos.
 *
 * Si algo no se puede leer, si las referencias viven en `reftable/` (no hay archivos que cambien con un commit), si
 * `GIT_DIR` está puesto (git no mira la carpeta) o con `TYCON_GIT_MEMO=0`, la huella es
 * null y nadie recuerda nada: se pregunta como si esto no existiera. Una respuesta fallida no se recuerda.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apagado = (env) => String(env.TYCON_GIT_MEMO || '') === '0';

/** `<tamaño>:<hora en ns>` de un archivo, `-` si no existe, o null si no se puede leer por otra razón. */
function marca(f) {
  try {
    const s = fs.statSync(f, { bigint: true });
    return `${s.size}:${s.mtimeNs}`;
  } catch (e) {
    return e && e.code === 'ENOENT' ? '-' : null;
  }
}

/** La carpeta de git de `dir` (subiendo hasta `.git`: carpeta, o archivo `gitdir:` de un worktree), o null. */
function gitDirOf(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const g = path.join(d, '.git');
    let s = null;
    try { s = fs.statSync(g); } catch (_) { /* sigue arriba */ }
    if (s && s.isDirectory()) return g;
    if (s && s.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(g, 'utf8'));
      return m ? path.resolve(d, m[1]) : null;
    }
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

/** La huella de `dir`, o null (no recordar). */
function stampOf(dir, env = process.env) {
  // un GIT_INDEX_FILE relativo lo resuelve git desde la raíz del árbol, no desde `dir`: sin huella
  if (apagado(env) || env.GIT_DIR || !dir || (env.GIT_INDEX_FILE && !path.isAbsolute(env.GIT_INDEX_FILE))) return null;
  try {
    const gd = gitDirOf(dir);
    if (!gd) return null;
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    let comun = gd;
    try { comun = path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch (_) { /* no es un worktree */ }
    // con las referencias en `reftable/` no hay archivo de la rama ni historial que cambien con un commit: sin huella
    if (fs.existsSync(path.join(comun, 'reftable')) || fs.existsSync(path.join(gd, 'reftable'))) return null;
    const ref = /^ref:\s*(\S+)$/.exec(head);
    const indice = env.GIT_INDEX_FILE ? env.GIT_INDEX_FILE : path.join(gd, 'index');
    const partes = [
      gd, head,
      marca(path.join(gd, 'logs', 'HEAD')),
      ref ? marca(path.join(comun, ref[1])) : '-',
      marca(path.join(comun, 'packed-refs')),
      marca(path.join(gd, 'MERGE_HEAD')),
      indice, marca(indice),
    ];
    return partes.includes(null) ? null : partes.join('|');
  } catch (_) {
    return null;
  }
}

/**
 * Recuerda en `mapa` lo que da `preguntar()` para la carpeta `dir` y la llave `clave`. `preguntar` devuelve
 * `{ valor, recordar }`: con `recordar: false` (git no contestó) se devuelve sin guardar. Sin huella, pregunta siempre.
 */
function memo(mapa, dir, clave, preguntar, env = process.env) {
  const huella = stampOf(dir, env);
  const k = huella ? `${path.resolve(dir)}\0${huella}\0${clave}` : null;
  if (k && mapa.has(k)) return mapa.get(k);
  const r = preguntar();
  if (k && r.recordar) mapa.set(k, r.valor);
  return r.valor;
}

module.exports = { stampOf, gitDirOf, memo, apagado };
