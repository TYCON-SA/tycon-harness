'use strict';
// extension-notices.js — los avisos que trae una extensión (un paquete o una integración) y que el núcleo dice cuando
// aplican, en vez de que viajen siempre en las instrucciones de cada sesión.
//
// Cada extensión los declara en `notices.json`, en su carpeta, al lado de su manifiesto:
//   { "notices": [ { "id": "…", "text": "<ruta dentro de la carpeta>", "when": "session-start" | "before-command",
//                    "commands": ["…"],        // sólo con before-command, y ahí obligatorio
//                    "repo_files": "<regex>" } ] } // opcional: sobre las rutas que git sigue en el repo
// Va en un archivo aparte y no como clave del manifiesto porque el lector de manifiestos de paquetes rechaza las claves
// que no conoce: un arnés anterior que recibiera la clave nueva dejaría de cargar el paquete entero.
//
// Cuándo aplica lo decide el núcleo según el tipo de extensión, no la extensión: un paquete, si está activo para el repo
// (lo de la organización, achicado por el `packs:` del repo); después, si trae `repo_files`, si alguna ruta del repo la
// cumple. El texto vive dentro de la carpeta de la extensión: una ruta que sale de ahí se rechaza.
//
// Casos: scripts/tests/extension-notices.test.js. Lo usa scripts/hooks/extension-notices.js.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = 'notices.json';
const WHEN = Object.freeze(['session-start', 'before-command']);
const KEYS = Object.freeze(['id', 'text', 'when', 'commands', 'repo_files']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const GIT_TIMEOUT_MS = 3000;

// afuera = el camino de vuelta empieza con el tramo `..` (un archivo `..notas.md` está adentro)
const outside = (from, to) => { const back = path.relative(from, to); return !back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back); };

/**
 * La ruta real del texto si `rel` es un archivo dentro de `dir`; si no, `{ problem }`. Se mira dos veces: como texto
 * (`..`, rutas absolutas) y ya resuelta, porque un enlace simbólico —el archivo o una carpeta del camino— puede apuntar
 * afuera, y el gancho imprime ese texto en la sesión. Un enlace en el archivo mismo se rechaza siempre.
 */
function textFile(rel, dir) {
  if (typeof rel !== 'string' || !rel.trim()) return { problem: '«text» tiene que ser la ruta de un archivo' };
  if (path.isAbsolute(rel) || rel.includes('\\')) return { problem: `«text» (${rel}) queda fuera de la carpeta de la extensión` };
  const abs = path.resolve(dir, rel);
  if (outside(dir, abs)) return { problem: `«text» (${rel}) queda fuera de la carpeta de la extensión` };
  let real;
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return { problem: `«text» (${rel}) es un enlace simbólico: tiene que ser un archivo de la carpeta` };
    real = fs.realpathSync(abs);
    if (outside(fs.realpathSync(dir), real)) return { problem: `«text» (${rel}) queda fuera de la carpeta de la extensión (por un enlace del camino)` };
    if (!fs.statSync(real).isFile()) return { problem: `«text» (${rel}) no es un archivo` };
  } catch (_) { return { problem: `«text» (${rel}) no existe` }; }
  return { file: real };
}

/**
 * Los avisos de la extensión que vive en `dir`.
 * @returns {{notices: Array<{id, file, when, commands: string[]|null, repoFiles: RegExp|null}>, errors: string[]}}
 */
function readNotices(dir) {
  const file = path.join(dir, FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { notices: [], errors: [] };
    return { notices: [], errors: [`${FILE} no se puede leer (${e.code || e.message})`] };
  }
  let json;
  try { json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch (e) {
    return { notices: [], errors: [`${FILE} no es JSON válido (${e.message})`] };
  }
  if (!json || typeof json !== 'object' || !Array.isArray(json.notices)) {
    return { notices: [], errors: [`${FILE} tiene que ser { "notices": [ … ] }`] };
  }
  const notices = [];
  const errors = [];
  const seen = new Set();
  json.notices.forEach((n, i) => {
    const where = `${FILE}, aviso ${i + 1}`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) { errors.push(`${where}: tiene que ser un objeto`); return; }
    const bad = [];
    const extra = Object.keys(n).filter((k) => !KEYS.includes(k));
    if (extra.length) bad.push(`clave(s) fuera del vocabulario: ${extra.join(', ')} (van: ${KEYS.join(', ')})`);
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) bad.push('«id» tiene que ser minúsculas, números y guiones');
    else if (seen.has(n.id)) bad.push(`«id» repetido: ${n.id}`);
    const tf = textFile(n.text, dir);
    if (tf.problem) bad.push(tf.problem);
    if (!WHEN.includes(n.when)) bad.push(`«when» tiene que ser ${WHEN.join(' o ')}`);
    let commands = null;
    if (n.when === 'before-command') {
      if (!Array.isArray(n.commands) || !n.commands.length || !n.commands.every((c) => typeof c === 'string' && c.trim())) {
        bad.push('«commands» tiene que ser una lista no vacía de comandos (con before-command)');
      } else commands = n.commands.map((c) => c.trim());
    } else if (n.commands !== undefined) bad.push('«commands» va sólo con before-command');
    let repoFiles = null;
    if (n.repo_files !== undefined) {
      if (typeof n.repo_files !== 'string' || !n.repo_files) bad.push('«repo_files» tiene que ser una expresión regular');
      else { try { repoFiles = new RegExp(n.repo_files); } catch (e) { bad.push(`«repo_files» no es una expresión regular válida (${e.message})`); } }
    }
    if (bad.length) { errors.push(`${where}${typeof n.id === 'string' ? ` (${n.id})` : ''}: ${bad.join('; ')}`); return; }
    seen.add(n.id);
    notices.push({ id: n.id, file: tf.file, when: n.when, commands, repoFiles });
  });
  return { notices, errors };
}

/**
 * La raíz git de `cwd`: `{ root }`, `{ root: null }` si no es un repo, o `{ root: null, error }` si git no contestó
 * (no está, se pasó del tope). «No pude preguntar» no es «no es un repo».
 */
function repoRoot(cwd) {
  try {
    return { root: execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null };
  } catch (e) {
    // git sale 128 también con un repo que se niega a abrir (dueño distinto, un worktree cuyo .git apunta a una carpeta
    // que ya no está): con un .git en el camino eso es «no pude preguntar», no «no es un repo»
    let existe = true;
    try { existe = fs.statSync(cwd).isDirectory(); } catch (_) { existe = false; }
    if (!existe) return { root: null, error: `la carpeta de la sesión (${cwd}) no existe` };
    if (e && e.status === 128 && !gitMarkerAbove(cwd)) return { root: null };
    return { root: null, error: `no se pudo saber si ${cwd} es un repo (${(e && (e.status === 128 ? 'git no lo abre' : (e.code || e.signal))) || 'git no contestó'})` };
  }
}

/** Si hay un `.git` (carpeta o archivo) en `dir` o en alguna carpeta de arriba. */
function gitMarkerAbove(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/** Las rutas que git sigue en `root` (null si no se pudo preguntar: eso no es «no hay ninguna»). */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch (_) { return null; }
}

/**
 * Las extensiones activas para el repo, con su carpeta: hoy, los paquetes (las integraciones las suma el caso de
 * plataforma). Lo que no se pudo saber va en `errors`, no se calla.
 * @returns {{extensions: Array<{kind, name, dir}>, errors: string[]}}
 */
function activeExtensions({ root }) {
  const errors = [];
  const extensions = [];
  try {
    const packs = require(path.join(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts', 'lib', 'packs.js'));
    // una carpeta pedida con TYCON_PACKS_DIR que no existe es un error que se dice, no «sin paquetes»
    const installed = packs.descubrir(packs.dirPaquetes(), !!process.env.TYCON_PACKS_DIR);
    for (const p of packs.paquetesActivos({ repo: root, instalados: installed })) extensions.push({ kind: 'pack', name: p.nombre, dir: p.dir });
  } catch (e) {
    const why = e && Array.isArray(e.errores) ? e.errores.map((x) => x.motivo).join('; ') : (e && e.message) || String(e);
    errors.push(`no se pudo saber qué paquetes están activos (${why})`);
  }
  return { extensions, errors };
}

/**
 * Los avisos que aplican en `cwd` para el momento `when`.
 * @returns {{notices: Array<{extension, id, file}>, errors: string[]}}
 */
function applicable({ cwd, when }) {
  const where = repoRoot(cwd);
  const root = where.root;
  // sin saber si es un repo tampoco se sabe qué paquetes declara (`packs:` puede apagarlos): no se dice ningún aviso
  if (where.error) return { notices: [], errors: [`${where.error}: los avisos de las extensiones no se evaluaron`] };
  const { extensions, errors } = activeExtensions({ root });
  let files;
  const out = [];
  for (const ext of extensions) {
    const r = readNotices(ext.dir);
    for (const e of r.errors) errors.push(`${ext.kind === 'pack' ? 'paquete' : 'integración'} ${ext.name}: ${e}`);
    for (const n of r.notices) {
      if (n.when !== when) continue;
      if (n.repoFiles) {
        if (!root) continue;   // fuera de un repo, un aviso que depende del repo no aplica
        if (files === undefined) files = trackedFiles(root);
        if (files === null) { errors.push(`no se pudo listar los archivos de ${root}: el aviso ${n.id} no se evaluó`); continue; }
        if (!files.some((f) => n.repoFiles.test(f))) continue;
      }
      out.push({ extension: `${ext.kind}:${ext.name}`, id: n.id, file: n.file, commands: n.commands });
    }
  }
  return { notices: out, errors };
}

module.exports = { FILE, WHEN, readNotices, applicable, repoRoot, trackedFiles };
