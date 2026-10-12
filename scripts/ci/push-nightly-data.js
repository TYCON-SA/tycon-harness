#!/usr/bin/env node
'use strict';
// push-nightly-data.js — cómo guardan los nocturnos lo que escribieron (story 8.26, tanda H1a).
//
// Uso:  node scripts/ci/push-nightly-data.js save --message <texto> [--require <ruta>]... [--require-daily <patrón>]...
//                                                 [--verify <orden> [--verify-export <ruta>]...] -- <ruta>...
//       node scripts/ci/push-nightly-data.js sync -- <ruta>...
//       Las dos: [--repo <checkout>] [--remote origin] [--branch main]. `save`: [--attempts 3] [--wait-ms 2000] [--today <fecha>].
//
// POR QUÉ EXISTE. Cada nocturno guardaba con `git push origin HEAD:main` y, si lo rechazaban, rebasaba sobre
// `origin/main`. Eso empuja TODO lo que haya debajo de HEAD. Cuando el arnés sale de GitHub, debajo de HEAD hay un commit
// local —la superposición: lo público encima del checkout— que no existe en el remoto: lo subía entero, con sus
// borrados. Eran seis pasos en los YAML y un séptimo adentro de `open-pr-per-finding.sh`, que además devolvía el checkout
// a `origin/main` y dejaba a la noche corriendo otro código. Ahora hay un solo camino, el mismo con las dos fuentes.
//
// LA REGLA: EL CHECKOUT NO SE MUEVE. `HEAD` y el índice quedan como estaban; lo que la noche escribió vive en el disco.
//
// QUÉ HACE `save`:
//   1. Arma el commit del paso con un índice temporal: el árbol de la base más SÓLO las rutas del paso, tomadas del
//      disco con fuerza (lo nuevo sin seguimiento, lo borrado y lo que el `.gitignore` ignora viajan igual). La base es
//      HEAD; después de un guardado que viajó, la base pasa a ser ese commit (referencia aparte, nunca HEAD): el
//      guardado siguiente del mismo trabajo lleva sólo lo que cambió desde entonces, y si el anterior NO viajó, lo lleva.
//   2. Trae la punta de la rama y traslada ese único commit con una fusión de tres vías (`git merge-tree`), que no toca
//      el checkout. Lo que otro escribió en la misma carpeta queda; un choque de contenido sale rojo con sus archivos.
//   3. Antes de empujar comprueba: que lo que cambia está adentro de las rutas del paso; que el archivo del día está
//      (`--require`, `--require-daily`); la verificación del paso (`--verify`, sobre lo que se va a publicar, extraído a
//      `PUSH_DIR`); y, antes de todo, la guarda del árbol (ver abajo).
//   4. Empuja el commit nuevo por su sha. Rechazado: vuelve al 2. Tres rechazos: sale 1 diciendo que NO viajó.
//
// QUÉ HACE `sync`: trae de la rama esas rutas al disco (lo que la rama borró, se borra), sin mover HEAD, y deja esa
// punta como base de los guardados que sigan. Es lo que hace el tablero antes de generar: datos al día, el código no.
// Después de un `sync`, guardar una ruta que no se trajo sale 2: devolvería en la rama lo que otros cambiaron.
//
// `--require-daily '<carpeta>/nombre-{day}.json'`: en lo que se empuja tiene que estar el archivo de hoy (UTC), o el
// paso tiene que haber escrito el de ayer (una corrida que cruzó la medianoche). El de ayer que ya estaba no cuenta.
// 🔴 «Nada nuevo» no saltea esa comprobación ni la de `--verify`: si el paso no escribió nada, el archivo del día
// tiene que estar YA en la rama (una corrida repetida) y lo publicado tiene que pasar la verificación; si no, la noche
// no midió y sale 1. Sin `--require`, `--require-daily` ni `--verify`, sin cambios sale 0 sin hablar con el remoto.
//
// SI EL EMPUJE VIAJÓ Y LA CONSTANCIA NO SE PUEDE ANOTAR, sale 0 con un aviso: decir «no viajó» sería mentira. El
// guardado siguiente del trabajo parte de HEAD y vuelve a llevar lo mismo, que la rama ya tiene. LÍMITE CONOCIDO: si
// además un archivo que ya había viajado VOLVIÓ A CAMBIAR en el mismo trabajo, la fusión no sabe cuál vale y sale 1
// nombrándolo («choca con lo que la rama trae»). Hacen falta las dos fallas juntas, sale rojo y no silencioso, y se
// recupera corriendo el trabajo otra vez (el checkout nuevo ya trae lo guardado).
//
// LO QUE NO SE GUARDA NUNCA, aunque caiga en una carpeta del paso: la basura de la máquina (`.DS_Store`, `*.swp`,
// `*.bak`). Y un paso no puede nombrar el repo entero (`.`, `*`): nombra sus carpetas o sus archivos.
//
// «NO PUDE» NUNCA ES «NO HAY». Un `git` que falla al listar, una constancia que está y no se puede leer, o una rama
// que no se pudo traer salen 1 con su motivo; no se leen como «no había nada que guardar».
//
// LA GUARDA DEL ÁRBOL. Antes de guardar se corre `overlay-harness.js --check-tree`: el código de HEAD tiene que seguir
// siendo el que dejó la plantilla que trae el arnés, que lo anota en `HARNESS_TREE`. Si cambió, no se guarda. Y si la
// variable falta, tampoco: no hay contra qué comparar (sale 1, también cuando no había nada nuevo). Corre el guion
// que la plantilla guardó para la corrida (`<Agent.TempDirectory>/arnes-guion/`), si lo guardó; si no, el del
// checkout. `sync` no la mira: no empuja nada.
//
// Salida: 0 viajó, o no había nada nuevo · 1 NO viajó (dice por qué) · 2 uso.
// Casos: scripts/tests/push-nightly-data.test.js (T73).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE_REF = 'refs/nightly-data/base';
const STATE_FILE = 'nightly-data.json';
// lo que nunca es un dato de la noche, aunque caiga en una carpeta que se guarda
const NEVER = ['.DS_Store', '*.swp', '*.bak'];
const TREE_CHECK = 'scripts/ci/overlay-harness.js';
/** Dónde deja la plantilla (traer-arnes.yml) el guion de la corrida, bajo la carpeta temporal del agente. */
const RUN_TREE_CHECK = path.join('arnes-guion', 'overlay-harness.js');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

class Red extends Error {}
class Usage extends Error {}

/** Lo que dijo otro programa, para mostrarlo sin que Azure lo lea como una orden suya (`##vso[...]`). */
// (el retorno de carro también: los `remote:` de git lo usan, y Azure corta ahí la línea; y las marcas de formato
// `##[error]`, `##[group]`…: no cambian el resultado de la corrida, pero pintarían líneas falsas en el registro)
const quiet = (text) => String(text).trim().replace(/\r/g, ' ').replace(/##(?=vso|\[)/gi, '## ');
/** Un aviso que la corrida muestra en naranja. */
const warn = (say, text) => say(`##vso[task.logissue type=warning]${quiet(text).replace(/\s*\n\s*/g, ' ')}`);

function git(repo, args, { env, input } = {}) {
  // core.quotePath=false: los nombres con acento llegan como son, no escapados en octal y entre comillas (así una ruta
  // que se compara con un nombre —el archivo de ayer— se encuentra, y la que se muestra se puede leer)
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { env, input, maxBuffer: 1 << 30 });
  return {
    ok: r.status === 0,
    status: r.status,
    out: r.stdout ? r.stdout.toString('utf8').trim() : '',
    // lo que git (o el remoto) dijo al fallar se usa sólo para mostrarlo: se sanea acá, en el origen, para que ningún
    // camino lo imprima crudo (los «intento N: …» lo mostraban sin pasar por `quiet`)
    err: quiet(r.stderr ? r.stderr.toString('utf8') : String(r.error || '')),
  };
}
function gitOrRed(repo, args, what, opts) {
  const r = git(repo, args, opts);
  if (!r.ok) throw new Red(`${what}: ${r.err.split('\n')[0] || 'git falló sin decir por qué'}`);
  return r.out;
}

/** Las rutas como las escribe git: con «/», relativas al repo, sin salir de él. */
function cleanPaths(list, what) {
  const out = [];
  for (const raw of list) {
    const p = String(raw).replace(/\\/g, '/').replace(/\/+$/, '');
    // se mira la ruta YA normalizada: `\private\tmp` (barras al revés) pasaba por relativa. Y sin caracteres de
    // control: una ruta con un salto de línea se imprimiría en dos líneas, y la segunda podría leerse como una orden
    // (lo que se rechaza se muestra con esos caracteres a la vista, no crudos)
    const shown = quiet(String(raw).replace(/[\u0000-\u001f\u007f]/g, '?'));
    if (!p || /[\u0000-\u001f\u007f]/.test(p) || p.startsWith('-') || p.startsWith(':') || p.startsWith('/') || path.isAbsolute(raw)
      || /^[A-Za-z]:\//.test(p) || p.split('/').includes('..')) {
      throw new Usage(`${what}: «${shown}» no es una ruta relativa de adentro del repo`);
    }
    // el repo entero no es «las rutas de un paso»: ni `.`, ni un primer tramo con comodines (`*`, `?`, o una clase
    // de caracteres como `[a-z]*`, que abarca lo mismo): la carpeta de arriba va escrita con su nombre
    if (p.split('/').includes('.') || WILD.test(p.split('/')[0])) {
      throw new Usage(`${what}: «${raw}» abarca el repo entero o media raíz; un paso nombra sus carpetas o sus archivos (el primer tramo, sin comodines)`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
// Una ruta con comodines la resuelve git con las reglas del shell: `*` no cruza carpetas (`**` sí). Sin esta marca,
// `carpeta/*.json` se llevaba también `carpeta/sub/otro.json`, cosa que el comodín del shell de antes no hacía.
const WILD = /[*?[]/;
const pathspec = (s) => (WILD.test(s) ? `:(glob)${s}` : s);
const exclude = (specs) => specs.map((s) => (WILD.test(s) ? `:(exclude,glob)${s}` : `:(exclude)${s}`));
/** Nombres de archivo que entrega git separados por NUL (`-z`): enteros, con espacios o acentos. */
const names = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);
/** ¿Es basura de la máquina, por su nombre? (`.DS_Store`, o una extensión de NEVER) */
const isNever = (rel) => {
  const name = rel.split('/').pop();
  return NEVER.some((n) => (n.startsWith('*') ? name.endsWith(n.slice(1)) : name === n));
};

/** Los archivos que cambian entre dos commits y NO caen en las rutas dadas. Vacío es lo esperado. */
function changedOutside(repo, from, to, specs, env) {
  return diffNames(repo, [from, to, '--', '.', ...exclude(specs)], 'no pude comparar lo que se iba a empujar', env).sort();
}

/** Los archivos de un `git diff --name-only`, con sus nombres enteros (`-z`). */
function diffNames(repo, args, what, env) {
  const r = spawnSync('git', ['-C', repo, 'diff', '--name-only', '--no-renames', '-z', ...args], { env, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Red(`${what}: ${quiet(r.stderr ? r.stderr.toString('utf8') : '').split('\n')[0] || 'git falló sin decir por qué'}`);
  return names(r.stdout);
}

/** La identidad de los commits: la del entorno, la del repo, o la del pipeline. */
function withIdentity(repo, env) {
  const conf = (k) => git(repo, ['config', '--get', k], { env }).out;
  const name = env.GIT_AUTHOR_NAME || conf('user.name') || 'Azure Pipelines';
  const email = env.GIT_AUTHOR_EMAIL || conf('user.email') || 'azure-pipelines@dev.azure.com';
  return { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME || name, GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL || email };
}

/** La corrida a la que pertenece la constancia: otra corrida que reuse la carpeta no hereda la base de ésta. */
const runKey = (env) => [env.BUILD_BUILDID || 'local', env.SYSTEM_JOBID || '', env.SYSTEM_JOBATTEMPT || ''].join(':');

function statePath(repo, env) {
  const dir = gitOrRed(repo, ['rev-parse', '--absolute-git-dir'], 'no pude ubicar la carpeta de git del checkout', { env });
  return path.join(dir, STATE_FILE);
}
/**
 * La base de los guardados: `{ base, synced }`. Sin constancia (o con la de OTRA corrida, o de otro commit) la base es
 * HEAD: es lo esperado en el primer guardado. Una constancia que está y no se puede leer NO es «no hay»: sin ella no
 * se sabe qué se guardó ni qué trajo `sync`, así que sale rojo en vez de adivinar.
 */
function readState(repo, head, env, say) {
  const fresh = { base: head, synced: null };
  const file = statePath(repo, env);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return fresh;
    throw new Red(`no pude leer la constancia de los guardados (${file}): ${e.code || e.message}`);
  }
  let st;
  try { st = JSON.parse(text); } catch (e) {
    throw new Red(`la constancia de los guardados está ilegible (${file}): no sé qué se guardó ya en esta corrida`);
  }
  if (!st || st.key !== runKey(env) || st.head !== head || typeof st.base !== 'string') return fresh;
  const ref = git(repo, ['rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], { env });
  if (!ref.ok || ref.out !== st.base) {
    // la referencia y el archivo no dicen lo mismo (un guardado cortado a la mitad): se vuelve a llevar todo desde HEAD
    warn(say, `la constancia de los guardados no coincide con su referencia (${BASE_REF}): este guardado parte de HEAD y vuelve a llevar lo que ya se hubiera guardado`);
    return fresh;
  }
  return { base: st.base, synced: Array.isArray(st.synced) ? st.synced : null };
}
function writeState(repo, head, base, synced, env) {
  // el archivo primero y de una vez (a un temporal y renombrado), la referencia después: si algo se corta en el medio,
  // la lectura lo ve como «no coinciden» y parte de HEAD
  const file = statePath(repo, env);
  try {
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ key: runKey(env), head, base, synced }, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    throw new Red(`no pude escribir la constancia de los guardados (${file}): ${e.code || e.message}`);
  }
  gitOrRed(repo, ['update-ref', BASE_REF, base], 'no pude dejar anotada la base de los guardados', { env });
}

/** Trae la punta de la rama. Devuelve su commit, o null con el motivo impreso. */
function fetchTip(repo, remote, branch, env, say) {
  const f = git(repo, ['fetch', '--quiet', remote, branch], { env });
  if (!f.ok) { say(`no pude traer ${remote}/${branch}: ${f.err.split('\n')[0]}`); return null; }
  const tip = git(repo, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], { env });
  if (!tip.ok) { say(`traje ${remote}/${branch} pero no pude leer su punta`); return null; }
  return tip.out;
}

/** La guarda «el árbol sigue siendo el de la superposición». Sin con qué comprobarlo (HARNESS_TREE), rojo: no se guarda. */
function checkTree(repo, env, say) {
  // Sin la variable no hay contra qué comparar, y «guardar igual» es guardar sin saber qué código corrió la noche. La
  // plantilla que trae el arnés la deja en todo trabajo que guarda: que falte es que algo cambió ahí.
  if (!env.HARNESS_TREE) throw new Red('falta HARNESS_TREE (la deja la plantilla que trae el arnés): no se puede comprobar que el árbol sea el de la superposición, y sin comprobarlo no se guarda');
  // El guion de ESTA corrida, si la plantilla lo guardó (con la fuente github y antes del corte, el del disco es el del
  // commit del que salió la copia: puede no conocer `--check-tree`, o calcular la huella de otro modo). Es el mismo
  // que calculó HARNESS_TREE y el que corre check-tree.yml antes de medir. Si no lo guardó, el del checkout.
  const saved = env.AGENT_TEMPDIRECTORY ? path.join(env.AGENT_TEMPDIRECTORY, RUN_TREE_CHECK) : '';
  // un ARCHIVO, como lo elige check-tree.yml con `[ -f ]`: otra cosa con ese nombre no es el guion de la corrida
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
  const script = saved && isFile(saved) ? saved : path.join(repo, TREE_CHECK);
  const r = spawnSync(process.execPath, [script, '--check-tree', '--repo', repo], { env, encoding: 'utf8', maxBuffer: 1 << 26 });
  const said = quiet(`${r.stdout || ''}${r.stderr || ''}`);
  if (said) say(said);
  // el rojo nombra el guion que corrió: con el de la corrida, buscar el motivo en el del checkout es buscar en otro
  const which = script === saved ? `el guion de la corrida, ${RUN_TREE_CHECK}` : TREE_CHECK;
  if (r.status !== 0) throw new Red(`el árbol ya no es el que dejó la superposición (${which} --check-tree salió ${r.status === null ? 'sin código' : r.status}): no se guarda`);
}

/** El commit del paso: el árbol de la base más sólo esas rutas, del disco. `null` si no cambió nada. */
function stepCommit(repo, base, specs, message, env, tmp, say) {
  const idx = { ...env, GIT_INDEX_FILE: path.join(tmp, 'step-index') };
  gitOrRed(repo, ['read-tree', base], 'no pude leer el árbol de la base', { env: idx });
  // una ruta que no está ni en el disco ni en la base no es un error: esa noche no escribió ahí. Pero un `git` que
  // falla al listar NO es «no hay nada»: sale rojo (si no, todas las rutas se descartaban y el paso decía «nada nuevo»)
  const live = specs.filter((s) => gitOrRed(repo, ['ls-files', '--cached', '--others', '--', pathspec(s)], `no pude listar lo que hay en ${s}`, { env: idx }) !== '');
  if (live.length) {
    gitOrRed(repo, ['add', '-A', '-f', '--', ...live.map(pathspec)], 'no pude tomar del disco lo que escribió el paso', { env: idx });
    // Lo que NO es un dato de la noche vuelve a quedar como estaba en la base, después de tomar todo y no con rutas
    // de exclusión (con más de una exclusión de comodín, `git add` dejaba afuera también los archivos nuevos de la
    // carpeta: medido con git 2.50). Dos clases:
    //   · la basura de la máquina, NUNCA: ni nueva, ni cambiada, ni borrada si alguien la versionó alguna vez;
    //   · un enlace simbólico o un submódulo: apunta a cualquier lado, y el `sync` siguiente lo escribiría en el
    //     disco de cada agente. No viaja, y se avisa.
    const raw = spawnSync('git', ['-C', repo, 'diff', '--cached', '--raw', '--no-renames', '--abbrev=40', '-z', base], { env: idx, maxBuffer: 1 << 30 });
    if (raw.status !== 0) throw new Red('no pude listar lo que el paso cambió');
    const fields = names(raw.stdout);
    const undo = [];
    const links = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [oldMode, newMode, oldSha] = fields[i].replace(/^:/, '').split(' ');
      const file = fields[i + 1];
      const link = newMode === '120000' || newMode === '160000';
      if (!link && !isNever(file)) continue;
      if (link) links.push(file);
      // como estaba en la base: su entrada de antes, o ninguna si no existía
      undo.push(oldMode === '000000' ? `0 ${'0'.repeat(40)}\t${file}` : `${oldMode} ${oldSha}\t${file}`);
    }
    if (undo.length) {
      gitOrRed(repo, ['update-index', '-z', '--index-info'], 'no pude dejar afuera lo que no es un dato de la noche', { env: idx, input: `${undo.join('\0')}\0` });
    }
    if (links.length) warn(say, `no se guardan enlaces simbólicos ni submódulos, y hay ${links.length} en las rutas del paso: ${links.slice(0, 10).join(', ')}`);
  }
  const tree = gitOrRed(repo, ['write-tree'], 'no pude armar el árbol del paso', { env: idx });
  if (tree === gitOrRed(repo, ['rev-parse', `${base}^{tree}`], 'no pude leer el árbol de la base', { env })) return null;
  return gitOrRed(repo, ['commit-tree', tree, '-p', base, '-m', message], 'no pude armar el commit del paso', { env });
}

/** Extrae a una carpeta lo que se va a publicar en esas rutas. */
function exportTo(repo, commit, specs, dir, env, tmp) {
  const idx = { ...env, GIT_INDEX_FILE: path.join(tmp, 'export-index') };
  gitOrRed(repo, ['read-tree', commit], 'no pude leer lo que se iba a publicar', { env: idx });
  const listed = spawnSync('git', ['-C', repo, 'ls-files', '-s', '-z', '--', ...specs.map(pathspec)], { env: idx, maxBuffer: 1 << 30 });
  if (listed.status !== 0) throw new Red('no pude listar lo que se iba a publicar');
  // sólo archivos: un enlace simbólico que traiga la rama no se extrae (la verificación lo seguiría hacia afuera)
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean)
    .map((entry) => ({ mode: entry.slice(0, 6), file: entry.slice(entry.indexOf('\t') + 1) }))
    .filter((e) => e.mode !== '120000' && e.mode !== '160000').map((e) => e.file);
  if (!files.length) return;
  gitOrRed(repo, ['checkout-index', '-z', '--stdin', `--prefix=${dir.replace(/\\/g, '/')}/`], 'no pude extraer lo que se iba a publicar', { env: idx, input: `${files.join('\0')}\0` });
}

function yesterdayOf(day) {
  return new Date(Date.parse(`${day}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
}

function save(o, say) {
  const repo = path.resolve(o.repo || process.cwd());
  if (!o.message) throw new Usage('save: falta --message');
  if (!o.paths.length) throw new Usage('save: faltan las rutas del paso, después de «--»');
  const specs = cleanPaths(o.paths, 'save');
  const required = cleanPaths(o.require, '--require');
  const daily = cleanPaths(o.requireDaily, '--require-daily');
  for (const d of daily) if (!d.includes('{day}')) throw new Usage(`--require-daily: «${d}» no trae {day}`);
  // lo que se exige es UN archivo, por su nombre: un comodín ahí se buscaría literal y nunca estaría (un rojo falso)
  for (const r of [...required, ...daily]) if (WILD.test(r)) throw new Usage(`«${r}»: lo que se exige va con su nombre, sin comodines`);
  const exported = cleanPaths(o.verifyExport, '--verify-export');
  if (exported.length && !o.verify) throw new Usage('--verify-export va con --verify');
  const today = o.today || new Date().toISOString().slice(0, 10);
  // una fecha de verdad, no sólo su forma: `2026-13-45` reventaba al calcular el día anterior, y `2026-02-30` se
  // corregía sola a otro día
  const parsed = DAY.test(today) ? new Date(`${today}T12:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== today) {
    throw new Usage(`--today: «${today}» no es una fecha (AAAA-MM-DD)`);
  }
  const attempts = Number(o.attempts === undefined ? 3 : o.attempts);
  const waitMs = Number(o.waitMs === undefined ? 2000 : o.waitMs);
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(waitMs) || waitMs < 0) throw new Usage('--attempts y --wait-ms son números');
  const remote = o.remote || 'origin';
  const branch = o.branch || 'main';
  const env = withIdentity(repo, o.env || process.env);

  const head = gitOrRed(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], `${repo} no es un checkout de git`, { env });
  const state = readState(repo, head, env, say);
  if (state.synced) {
    const loose = specs.filter((s) => !state.synced.some((y) => s === y || s.startsWith(`${y}/`)));
    if (loose.length) throw new Usage(`save: ${loose.join(', ')} no está entre lo que trajo sync (${state.synced.join(', ')}): guardarla devolvería en ${branch} lo que otros cambiaron`);
  }
  checkTree(repo, env, say);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-nightly-data-'));
  try {
    // Lo que el paso exige que esté en la rama: sus rutas fijas y su archivo del día. `what` dice contra qué se mira.
    const assertRequired = (commit, written, what) => {
      const has = (rel) => git(repo, ['cat-file', '-e', `${commit}:${rel}`], { env }).ok;
      for (const rel of required) {
        if (!has(rel)) throw new Red(`${rel} no está en ${what}`);
      }
      for (const pattern of daily) {
        // todas las apariciones: la fecha puede ir en la carpeta y en el nombre
        const mine = pattern.split('{day}').join(today);
        const before = pattern.split('{day}').join(yesterdayOf(today));
        if (!has(mine) && !written.includes(before)) throw new Red(`el archivo del día (${mine}) no está en ${what}, y el paso tampoco escribió el de ayer`);
      }
    };

    // La verificación del paso, sobre lo que hay (o habrá) en la rama en ese commit, extraído a una carpeta.
    let exports = 0;
    const assertVerified = (commit, failed) => {
      if (!o.verify) return;
      const dir = path.join(tmp, `publish-${++exports}`);
      fs.mkdirSync(dir);
      exportTo(repo, commit, [...specs, ...exported], dir, env, tmp);
      const v = spawnSync(o.verify, { shell: true, cwd: repo, env: { ...env, PUSH_DIR: dir, PUSH_COMMIT: commit }, encoding: 'utf8', maxBuffer: 1 << 26 });
      const said = quiet(`${v.stdout || ''}${v.stderr || ''}`);
      if (said) say(said);
      if (v.status !== 0) throw new Red(failed);
    };
    // Lo guardado ya está en la rama: si la constancia no se puede anotar, decir «no viajó» sería mentira. Se avisa, y
    // el guardado siguiente parte de HEAD: vuelve a llevar lo mismo, que la rama ya tiene, y la fusión sale limpia
    // SALVO que alguno de esos archivos vuelva a cambiar en este trabajo (el límite de la cabecera: saldría 1).
    const noteSaved = (step) => {
      try { writeState(repo, head, step, state.synced, env); } catch (e) {
        warn(say, `lo guardado está en ${branch}, pero no pude anotar la constancia de los guardados (${e.message}): el guardado siguiente de este trabajo parte de HEAD, y si vuelve a cambiar un archivo que ya viajó va a salir rojo (correr el trabajo de nuevo lo resuelve)`);
      }
    };

    const step = stepCommit(repo, state.base, specs, o.message, env, tmp, say);
    if (!step) {
      // 🔴 «Nada nuevo» no es «todo bien»: si el paso exige un archivo del día o una verificación, se miran sobre
      // lo que la rama YA tiene (una corrida repetida). Si no escribió nada y tampoco está, la noche no midió: rojo,
      // no un verde sin foto.
      if (required.length || daily.length || o.verify) {
        let why = '';
        const tip = fetchTip(repo, remote, branch, env, (m) => { why = m; });
        if (!tip) throw new Red(`no hay nada nuevo que guardar y ${why}: no puedo comprobar lo que ${branch} tiene publicado`);
        assertRequired(tip, [], `${branch}, y el paso no escribió nada nuevo`);
        assertVerified(tip, `el paso no escribió nada nuevo, y lo que ${branch} tiene publicado no pasa la verificación del paso`);
      }
      say(`Nada nuevo que guardar en ${specs.join(', ')}.`);
      return 0;
    }
    const stepFiles = diffNames(repo, [state.base, step], 'no pude listar lo que escribió el paso', env);
    // lo que el paso ESCRIBIÓ (agregó o cambió): borrar el archivo de ayer no es haberlo escrito
    const stepWrote = diffNames(repo, ['--diff-filter=AM', state.base, step], 'no pude listar lo que escribió el paso', env);

    let last = 'no llegué a empujar';
    for (let i = 1; i <= attempts; i++) {
      if (i > 1 && waitMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      const tip = fetchTip(repo, remote, branch, env, (m) => { last = m; say(`intento ${i}: ${m}`); });
      if (!tip) continue;

      // la misma fusión de tres vías que un rebase, sin tocar el checkout: lo que el paso cambió, sobre la punta
      const m = git(repo, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${state.base}`, tip, step], { env });
      if (m.status === 1) {
        const clash = m.out.split('\n\n')[0].split('\n').slice(1).filter(Boolean);
        throw new Red(`lo que escribió el paso choca con lo que ${branch} trae en: ${clash.join(', ') || '(git no nombró el archivo)'}`);
      }
      if (!m.ok) throw new Red(`no pude trasladar el commit del paso a la punta de ${branch} (¿git anterior a 2.40?): ${(m.err || m.out).split('\n')[0]}`);
      const merged = m.out.split('\n')[0];
      if (merged === gitOrRed(repo, ['rev-parse', `${tip}^{tree}`], 'no pude leer la punta', { env })) {
        assertRequired(tip, stepWrote, `${branch}, que ya tiene lo que escribió el paso`);
        assertVerified(tip, `${branch} ya tiene lo que escribió el paso, y eso no pasa la verificación del paso`);
        noteSaved(step);
        say(`Nada nuevo que guardar: ${branch} ya tiene lo que escribió el paso.`);
        return 0;
      }
      const next = gitOrRed(repo, ['commit-tree', merged, '-p', tip, '-m', o.message], 'no pude armar el commit que se empuja', { env });

      const outside = changedOutside(repo, tip, next, specs, env);
      if (outside.length) throw new Red(`lo que se iba a empujar cambia archivos que el paso no escribió: ${outside.slice(0, 10).join(', ')}`);
      assertRequired(next, stepWrote, 'lo que se iba a empujar');
      assertVerified(next, 'la verificación de antes de empujar falló sobre lo que se iba a publicar: no se publica');

      const p = git(repo, ['push', '--quiet', remote, `${next}:refs/heads/${branch}`], { env });
      if (p.ok) {
        noteSaved(step);
        say(`Guardado en ${branch}: ${next.slice(0, 12)} (${stepFiles.length} archivo(s) del paso, sobre ${tip.slice(0, 12)}).`);
        return 0;
      }
      // todo lo que dijo el remoto, en una línea: la última sola («failed to push some refs») no dice por qué
      last = p.err.split('\n').map((l) => l.trim()).filter(Boolean).join(' · ').slice(0, 400) || 'el remoto rechazó el empuje sin decir por qué';
      say(`intento ${i}: el empuje a ${branch} fue rechazado — ${last}`);
    }
    throw new Red(`no se pudo empujar a ${branch} tras ${attempts} intentos (${last})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function sync(o, say) {
  const repo = path.resolve(o.repo || process.cwd());
  if (!o.paths.length) throw new Usage('sync: faltan las rutas que se traen, después de «--»');
  const specs = cleanPaths(o.paths, 'sync');
  const remote = o.remote || 'origin';
  const branch = o.branch || 'main';
  const env = o.env || process.env;
  const head = gitOrRed(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], `${repo} no es un checkout de git`, { env });
  let why = '';
  const tip = fetchTip(repo, remote, branch, env, (m) => { why = m; });
  if (!tip) throw new Red(why);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-nightly-data-'));
  try {
    // sólo lo que existe en la punta o en el índice (los comodines los resuelve git): lo demás no tiene qué traer
    const atTip = { ...env, GIT_INDEX_FILE: path.join(tmp, 'tip-index') };
    gitOrRed(repo, ['read-tree', tip], `no pude leer la punta de ${remote}/${branch}`, { env: atTip });
    // un `git` que falla al listar no es «no hay qué traer»: rojo (si no, no restauraba nada y decía «datos al disco»)
    const live = specs.filter((s) => gitOrRed(repo, ['ls-files', '--cached', '--', pathspec(s)], `no pude listar ${s} en la punta de ${remote}/${branch}`, { env: atTip }) !== ''
      || gitOrRed(repo, ['ls-files', '--cached', '--', pathspec(s)], `no pude listar ${s} en el checkout`, { env }) !== '');
    if (live.length) {
      // --worktree solo: el índice y HEAD quedan como estaban; lo que la punta no trae y el índice sí, se borra del disco
      gitOrRed(repo, ['restore', `--source=${tip}`, '--worktree', '--', ...live.map(pathspec)], `no pude traer los datos de ${remote}/${branch}`, { env });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  writeState(repo, head, tip, specs, env);
  say(`Datos de ${remote}/${branch} (${tip.slice(0, 12)}) al disco: ${specs.join(', ')}. El checkout sigue en ${head.slice(0, 12)}.`);
  return 0;
}

const FLAGS = {
  '--repo': 'repo', '--remote': 'remote', '--branch': 'branch', '--message': 'message', '--attempts': 'attempts',
  '--wait-ms': 'waitMs', '--today': 'today', '--verify': 'verify',
};
const LISTS = { '--require': 'require', '--require-daily': 'requireDaily', '--verify-export': 'verifyExport' };

function parse(argv) {
  const o = { paths: [], require: [], requireDaily: [], verifyExport: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    // sólo las opciones propias: `a in FLAGS` aceptaba también `constructor` o `toString`, que todo objeto trae
    const own = (table) => Object.prototype.hasOwnProperty.call(table, a);
    if (!own(FLAGS) && !own(LISTS)) throw new Usage(`opción desconocida: ${a}`);
    if (i + 1 >= argv.length || argv[i + 1] === '--') throw new Usage(`${a} sin valor`);
    if (own(FLAGS)) o[FLAGS[a]] = argv[++i]; else o[LISTS[a]].push(argv[++i]);
  }
  o.paths = argv.slice(i);
  return o;
}

function main(argv, { env = process.env, log = (m) => console.log(m) } = {}) {
  try {
    const [cmd, ...rest] = argv;
    if (cmd !== 'save' && cmd !== 'sync') throw new Usage(cmd ? `orden desconocida: ${cmd}` : 'falta la orden: save o sync');
    const o = { ...parse(rest), env };
    return cmd === 'save' ? save(o, log) : sync(o, log);
  } catch (e) {
    if (e instanceof Usage) {
      console.error(`uso: ${e.message}`);
      console.error('  push-nightly-data.js save --message <texto> [--require <ruta>] [--require-daily <patrón con {day}>] [--verify <orden>] -- <ruta>...');
      console.error('  push-nightly-data.js sync -- <ruta>...');
      return 2;
    }
    if (!(e instanceof Red)) throw e;
    // en una sola línea y sin que nada de adentro pueda leerse como una orden de Azure
    const why = quiet(e.message).replace(/\s*\n\s*/g, ' ');
    // cada orden dice lo suyo: `save` no empujó; `sync` no dejó los datos de la rama en el disco
    console.log(`##vso[task.logissue type=error]${why} — ${argv[0] === 'sync' ? 'los datos NO se trajeron' : 'el resultado NO viajó'}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, save, sync, changedOutside, BASE_REF };
