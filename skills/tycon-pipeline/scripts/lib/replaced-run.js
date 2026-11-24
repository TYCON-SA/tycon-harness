'use strict';
/**
 * replaced-run.js — una ejecución abierta cuyo arreglo ya entró a `main` por otro lado (un commit de una persona, otro
 * pedido) se cierra como `reemplazada`, sin pase, pasos ni firma: `marker.js clear --replaced-by <commit>`.
 *
 * No se le cree a nadie: el arnés comprueba que el commit está en `main` del servidor de un repo de la ejecución, que es
 * posterior a su arranque y que toca todos los archivos que la ejecución editó en ese repo. Una ejecución detenida, que espera la
 * decisión del dueño, no se cierra así. Si no lo puede comprobar, queda la salida de siempre (la firma de cerrar
 * la ejecución). La comprobación la hace igual el freno de la consola, antes, sin traer `main` (`fetch: false`), y el
 * guion, después de traerlo.
 *
 *   · `comprobar({ marker, sha, fetch })` → `{ ok: true, repo, archivos }` o `{ ok: false, motivo }`.
 *   · `shaDe(args)` → el `--replaced-by <sha>` de las palabras de un comando, o null.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHA = /^[0-9a-f]{7,40}$/i;
// sin las variables GIT_* del comando: una configuración o un directorio de git traídos por el entorno no cambian qué es main
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)));
const git = (repo, args, timeout = 20000) => spawnSync('git', ['-C', repo, '-c', 'maintenance.auto=false', ...args], { encoding: 'utf8', windowsHide: true, timeout, env: ENV });
const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };

/** La raíz de git de un archivo (el más cercano con `.git`), o null. */
function raizDe(archivo) {
  let d = path.dirname(archivo);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return real(d);
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

/** Los archivos que editó la ejecución, por repo: `Map<raíz, Set<ruta relativa>>`. */
function editadosPorRepo(marker) {
  const porRepo = new Map();
  for (const e of (marker && marker.fileEvents) || []) {
    const abs = e && typeof e.path === 'string' ? e.path : null;
    if (!abs || !path.isAbsolute(abs)) continue;
    const raiz = raizDe(abs);
    if (!raiz) continue;
    if (!porRepo.has(raiz)) porRepo.set(raiz, new Set());
    // la carpeta por su ruta real (como la raíz), y el archivo por su nombre: puede no existir ya
    porRepo.get(raiz).add(path.relative(raiz, path.join(real(path.dirname(abs)), path.basename(abs))).split(path.sep).join('/'));
  }
  return porRepo;
}

/** Lo que la ejecución editó de código (`code` distinto de false), por repo. */
function codigoPorRepo(marker) {
  return editadosPorRepo({ fileEvents: ((marker && marker.fileEvents) || []).filter((e) => e && e.code !== false) });
}

function comprobar({ marker, sha, fetch = false } = {}) {
  if (!SHA.test(String(sha || ''))) return { ok: false, motivo: `--replaced-by va con el commit que entró a main (de 7 a 40 letras hexadecimales), no «${String(sha || '').slice(0, 60)}»` };
  const editados = editadosPorRepo(marker);
  if (!editados.size) return { ok: false, motivo: 'la ejecución no tiene archivos editados anotados: no hay con qué comparar el commit' };
  const vistos = [];
  for (const [repo, archivos] of editados) {
    // con `fetch`, main es lo que el servidor tiene ahora (no la copia local, que se puede mover a mano); sin poder
    // traerlo, no se comprueba
    let main = 'origin/main';
    if (fetch) {
      const ls = git(repo, ['ls-remote', 'origin', 'refs/heads/main'], 60000);
      const punta = ls.status === 0 ? (String(ls.stdout).match(/^([0-9a-f]{40})\s/m) || [])[1] : null;
      if (!punta) { vistos.push(`${path.basename(repo)}: no pude leer main del servidor (${String(ls.stderr || '').trim().split('\n')[0] || 'sin respuesta'})`); continue; }
      if (git(repo, ['fetch', '--quiet', '--no-tags', 'origin', punta], 60000).status !== 0 && git(repo, ['cat-file', '-e', `${punta}^{commit}`]).status !== 0) {
        vistos.push(`${path.basename(repo)}: no pude traer main del servidor`);
        continue;
      }
      main = punta;
    }
    if (git(repo, ['cat-file', '-e', `${sha}^{commit}`]).status !== 0) continue;
    if (git(repo, ['merge-base', '--is-ancestor', sha, main]).status !== 0) {
      vistos.push(`${path.basename(repo)}: el commit no está en origin/main${fetch ? '' : ' (sin traer main)'}`);
      continue;
    }
    // con su primer padre: un commit de merge cuenta lo que trajo su pedido
    const d = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha]);
    if (d.status !== 0) { vistos.push(`${path.basename(repo)}: no pude leer qué cambió el commit`); continue; }
    // posterior al arranque: un commit viejo de main que toca el mismo archivo no es el arreglo de esta ejecución
    const desde = Date.parse((marker && marker.startedAt) || '');
    const cuando = Number(String(git(repo, ['show', '-s', '--format=%ct', sha]).stdout).trim()) * 1000;
    if (!Number.isFinite(desde) || !Number.isFinite(cuando) || cuando < desde) {
      vistos.push(`${path.basename(repo)}: el commit es anterior al arranque de la ejecución${Number.isFinite(desde) ? '' : ' (no sé cuándo arrancó)'}`);
      continue;
    }
    const toca = d.stdout.split('\n').map((x) => x.trim()).filter((x) => x && archivos.has(x));
    if (!toca.length) { vistos.push(`${path.basename(repo)}: el commit no toca ninguno de los archivos que editó la ejecución`); continue; }
    // todos, no alguno: un archivo en común con otra historia (una lista de suites) no dice que el arreglo entró
    const sinTocar = [...archivos].filter((x) => !toca.includes(x));
    if (sinTocar.length) {
      vistos.push(`${path.basename(repo)}: el commit deja sin tocar ${sinTocar.length} de los archivos que editó la ejecución (${sinTocar.slice(0, 5).join(', ')}${sinTocar.length > 5 ? ', …' : ''})`);
      continue;
    }
    // el código de la ejecución en otro repo no lo cubre un commit de éste; lo que no pide otra vuelta de revisores
    // (la historia, una guía: `code: false`) no cuenta
    const otros = [...codigoPorRepo(marker)].filter(([r]) => r !== repo);
    if (otros.length) {
      return { ok: false, motivo: `la ejecución editó también código en ${otros.map(([r, fs_]) => `${path.basename(r)} (${[...fs_].slice(0, 3).join(', ')}${fs_.size > 3 ? ', …' : ''})`).join('; ')}: un commit de ${path.basename(repo)} no dice que ese arreglo entró a main` };
    }
    return { ok: true, repo, archivos: toca };
  }
  return { ok: false, motivo: vistos.length ? vistos.join('; ') : `el commit ${String(sha).slice(0, 12)} no está en ningún repo de la ejecución` };
}

/** El `--replaced-by <sha>` de las palabras de un comando (`[{ texto, literal }]` o textos), o null si no está o no es literal. */
function shaDe(args) {
  const a = (args || []).map((w) => (w && typeof w === 'object' ? w : { texto: String(w), literal: true }));
  const i = a.findIndex((w) => w.texto === '--replaced-by');
  if (i < 0 || !a[i + 1] || !a[i + 1].literal) return null;
  return a[i + 1].texto;
}

module.exports = { comprobar, shaDe, editadosPorRepo };
