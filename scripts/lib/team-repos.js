#!/usr/bin/env node
'use strict';
// team-repos.js — dónde vive cada repo del arnés de una organización (story 8.26, tanda J · 2026-10-13).
//
// POR QUÉ EXISTE: el nombre de cada repo del arnés estaba escrito a mano en lugares distintos —el del público en una
// lista del repo de mantenimiento, el del perfil y el de mantenimiento al lado, las copias del arnés en una variable de
// una definición de Azure, el repo privado de las validaciones en otra—, y una organización nueva no tenía dónde
// decir los suyos. `team-repos.json`, en la raíz del perfil del equipo, los declara a todos en un solo lugar. Lo leen el
// instalador, los avisos de arranque y los pipelines de operaciones; nadie más escribe un nombre de repo.
//
// LA FORMA (versión 1):
//   { "version": 1,
//     "public":      <repo>,            obligatorio — el repo público del arnés
//     "profile":     <repo>,            obligatorio — el perfil del equipo (este mismo repo)
//     "operations":  <repo>,            obligatorio — el repo de operaciones de la organización (no se instala)
//     "maintainers": <repo>,            opcional — el de mantenimiento, sólo para quien mantiene el arnés
//     "harness_copies": [<repo>, …] }   opcional — los repos de la organización que son copias del arnés: las métricas
//                                       de la noche no los miden, salvo el de `maintainers` si está en la lista
//   <repo> = { "platform": "azure", "org", "project", "repo" } o { "platform": "github", "org", "repo" }.
//   Las claves que empiezan con `__` son comentarios. Cualquier otra clave es un problema, en su propia ruta: así un
//   nombre mal escrito no queda ignorado en silencio.
//   La lista de responsables NO va acá (este archivo llega a todas las máquinas): va en `operations.json`, en el repo
//   de operaciones (scripts/lib/operations-config.js).
//
// EL CONTRATO: `parse(text)` → `{ ok, data, problems }`. Cada problema es `{ path, message }`, con la ruta de la clave
// en puntos e índices (`operations.project`, `harness_copies.1.repo`; `''` para el archivo entero). Con un problema,
// `data` es `null`: nunca hay datos a medias. `load(file)` suma `couldNotRead: true` cuando el archivo no se pudo leer:
// «no pude leer» nunca es «no hay repo».
//
// LAS COPIAS DEL ARNÉS, PARA LAS MÉTRICAS (DEF-8.30-copias-del-arnes-en-team-repos · 2026-10-14, decisión del dueño):
// antes las declaraba una variable de cada definición (`HARNESS_COPIES`, y `HARNESS_MEASURED_COPY` la que cuenta); ahora
// las declara este archivo, como el resto de los repos: un lugar menos que configurar. `harnessCopies(data, platform)`
// las da con la que se mide marcada: la de mantenimiento, si está en la lista —es donde se escriben las stories del
// arnés—; las demás se saltean, así sus stories no cuentan dos veces. Sin clave nueva: la que cuenta ya está declarada.
//
// A mano: node scripts/lib/team-repos.js <archivo> [--json]   → exit 0 válido · 1 con problemas · 2 no pude leer
//         node scripts/lib/team-repos.js <archivo> --harness-copies <azure|github>
//             → una línea por copia de esa plataforma, `measure<TAB><id>` o `skip<TAB><id>` (`<proyecto>/<repo>` en Azure,
//               `<org>/<repo>` en GitHub); los problemas, por la salida de errores. Mismos códigos de salida.

const fs = require('fs');

const VERSION = 1;
const PLATFORMS = ['azure', 'github'];
const REPO_KEYS = { azure: ['org', 'project', 'repo'], github: ['org', 'repo'] };
const REQUIRED = ['public', 'profile', 'operations'];
const OPTIONAL = ['maintainers', 'harness_copies'];
const KEYS = ['version', ...REQUIRED, ...OPTIONAL];
// Los nombres: letras, números, punto, guion, guion bajo, y espacios adentro. Azure acepta letras de cualquier idioma
// (un proyecto «Arnés del equipo» es válido); GitHub, sólo ASCII.
const NAME = {
  azure: /^[\p{L}\p{N}._-](?:[\p{L}\p{N}._ -]*[\p{L}\p{N}._-])?$/u,
  github: /^[A-Za-z0-9._-](?:[A-Za-z0-9._ -]*[A-Za-z0-9._-])?$/,
};

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const comment = (k) => k.startsWith('__');

/** Los problemas de un repo en `at`; `[]` si está bien. */
function repoProblems(value, at) {
  if (!isObject(value)) return [{ path: at, message: 'tiene que ser un objeto con platform y la dirección del repo' }];
  const { platform } = value;
  if (!PLATFORMS.includes(platform)) {
    return [{ path: `${at}.platform`, message: `tiene que ser ${PLATFORMS.map((p) => `«${p}»`).join(' o ')} (es ${JSON.stringify(platform)})` }];
  }
  const out = [];
  const wanted = REPO_KEYS[platform];
  for (const k of Object.keys(value)) {
    if (k === 'platform' || comment(k)) continue;
    if (!wanted.includes(k)) out.push({ path: `${at}.${k}`, message: platform === 'github' && k === 'project' ? 'un repo de GitHub no lleva project' : `clave desconocida en un repo de ${platform}` });
  }
  for (const k of wanted) {
    const v = value[k];
    if (v === undefined) out.push({ path: `${at}.${k}`, message: 'falta' });
    else if (typeof v !== 'string' || !v.trim()) out.push({ path: `${at}.${k}`, message: 'tiene que ser un texto no vacío' });
    else if (!NAME[platform].test(v)) out.push({ path: `${at}.${k}`, message: `«${v}» tiene caracteres que no van en un nombre de ${platform} (letras${platform === 'github' ? ' sin tilde' : ''}, números, punto, guion, guion bajo; espacios sólo adentro)` });
  }
  return out;
}

/** Valida un objeto ya leído. */
function validate(doc) {
  if (!isObject(doc)) return [{ path: '', message: 'el archivo tiene que ser un objeto JSON' }];
  const problems = [];
  for (const k of Object.keys(doc)) {
    if (!comment(k) && !KEYS.includes(k)) problems.push({ path: k, message: k === 'owners' ? 'la lista de responsables no va acá (este archivo llega a todas las máquinas): va en operations.json, en el repo de operaciones' : 'clave desconocida' });
  }
  if (doc.version === undefined) problems.push({ path: 'version', message: 'falta' });
  else if (doc.version !== VERSION) problems.push({ path: 'version', message: `tiene que ser ${VERSION} (es ${JSON.stringify(doc.version)})` });
  for (const k of REQUIRED) {
    if (doc[k] === undefined) problems.push({ path: k, message: 'falta' });
    else problems.push(...repoProblems(doc[k], k));
  }
  if (doc.maintainers !== undefined) problems.push(...repoProblems(doc.maintainers, 'maintainers'));
  if (doc.harness_copies !== undefined) {
    if (!Array.isArray(doc.harness_copies)) problems.push({ path: 'harness_copies', message: 'tiene que ser una lista de repos' });
    else doc.harness_copies.forEach((r, i) => problems.push(...repoProblems(r, `harness_copies.${i}`)));
  }
  return problems;
}

/** `{ ok, data, problems }` del texto de un team-repos.json. */
function parse(text) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch (e) {
    return { ok: false, data: null, problems: [{ path: '', message: `no es JSON válido: ${String((e && e.message) || e).split('\n')[0]}` }] };
  }
  const problems = validate(doc);
  return { ok: problems.length === 0, data: problems.length ? null : doc, problems };
}

/** Lo mismo desde un archivo; si no se pudo leer, `couldNotRead: true` con el motivo. */
function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, data: null, couldNotRead: true, problems: [{ path: '', message: `no pude leer ${file}: ${(e && e.code) || (e && e.message) || e}` }] };
  }
  return { ...parse(text), couldNotRead: false };
}

/** La URL de un repo ya validado. */
function url(repo) {
  if (!isObject(repo)) return null;
  if (repo.platform === 'azure') return `https://dev.azure.com/${encodeURIComponent(repo.org)}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repo)}`;
  if (repo.platform === 'github') return `https://github.com/${repo.org}/${repo.repo}`;
  return null;
}

/** El id de un repo para comparar con lo que lista la organización: `<project>/<repo>` en Azure, `<org>/<repo>` en GitHub. */
function repoId(repo) {
  return repo.platform === 'azure' ? `${repo.project}/${repo.repo}` : `${repo.org}/${repo.repo}`;
}

/**
 * Las copias del arnés de una plataforma, de un archivo ya validado: `[{ id, measured }]`. Se mide sólo la de
 * mantenimiento (`maintainers`), si está en la lista; sin ella, ninguna. Las mayúsculas no distinguen (Azure y GitHub no
 * las distinguen en los nombres).
 */
function harnessCopies(data, platform) {
  if (!isObject(data) || !Array.isArray(data.harness_copies)) return [];
  const full = (r) => REPO_KEYS[r.platform].map((k) => String(r[k]).toLowerCase()).join('/');
  const m = isObject(data.maintainers) && PLATFORMS.includes(data.maintainers.platform) ? data.maintainers : null;
  return data.harness_copies
    .filter((r) => isObject(r) && r.platform === platform)
    .map((r) => ({ id: repoId(r), measured: !!m && m.platform === r.platform && full(m) === full(r) }));
}

/** La referencia `<project>/_git/<repo>` del repo de mantenimiento (la que piden las validaciones), o null. */
function privateRepoRef(data) {
  const m = data && data.maintainers;
  if (!isObject(m) || m.platform !== 'azure') return null;
  return `${m.project}/_git/${m.repo}`;
}

module.exports = { VERSION, PLATFORMS, REPO_KEYS, KEYS, parse, load, url, privateRepoRef, repoProblems, harnessCopies };

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--harness-copies');
  const platform = at >= 0 ? args[at + 1] : null;
  const file = args.find((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
  if (!file || (at >= 0 && !PLATFORMS.includes(platform))) {
    process.stderr.write('uso: node scripts/lib/team-repos.js <team-repos.json> [--json | --harness-copies <azure|github>]\n');
    process.exit(2);
  }
  const r = load(file);
  if (at >= 0) {
    // para los pipelines: la lista por la salida, los problemas por la de errores (no se mezclan con la lista)
    if (r.ok) for (const c of harnessCopies(r.data, platform)) process.stdout.write(`${c.measured ? 'measure' : 'skip'}\t${c.id}\n`);
    else for (const p of r.problems) process.stderr.write(`❌ ${file} · ${p.path || '(el archivo)'}: ${p.message}\n`);
  } else if (args.includes('--json')) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.ok) process.stdout.write(`✅ ${file}: válido\n`);
  else for (const p of r.problems) process.stdout.write(`❌ ${p.path || '(el archivo)'}: ${p.message}\n`);
  process.exit(r.ok ? 0 : (r.couldNotRead ? 2 : 1));
}
