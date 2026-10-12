'use strict';
// team-azure.js — la capa del equipo desde un repo de AZURE DEVOPS (story 8.25, la fuente de TYCON; decisión del dueño
// 2026-10-08 22:45): cuando la copia sea pública bajar el arnés no pide credencial, y los devs del equipo ya tienen la de
// Azure por su trabajo; no necesitan cuenta de GitHub. Lo que la capa ES (lista cerrada, declaración, perfil validado,
// apilado, estado) vive en team.js; acá sólo CÓMO se baja de Azure y de dónde sale la credencial.
//
// Sin zip y sin lector nuevo: la ref de `main` → el commit (su `treeId`) → el árbol recursivo (cada ruta con `mode`,
// `gitObjectType` blob/tree/commit, `objectId`, `size`) → el hash del árbol se RECALCULA de esa lista (git-tree-hash.js) y
// tiene que dar el `treeId` del commit → cada archivo de la capa por `items` en ese commit, y su blob (sha1 de git) tiene
// que ser el `objectId` de la lista. La misma cadena de hashes que verifica git: commit → árbol → blob.
//
// La credencial, en este orden, y si falta SE DICE (el caso de la máquina Windows que dejó de actualizarse sin avisar):
//   1. un PAT guardado en ~/.tycon/config.json (`harness.js config set azure.token`, sin eco) — lo explícito gana;
//   2. el gestor de credenciales de git, SIN interacción (`git credential fill` con GCM_INTERACTIVE=never y
//      GIT_TERMINAL_PROMPT=0; TYCON_AZURE_GIT_CREDENTIAL=0 lo apaga, para las pruebas);
//   3. ninguna → `{ ok: false }` con la acción, y quien llama frena (install/migrate: 1 sin escribir; update: la capa que ya está).
// Medido contra la API real (2026-10-08): un anónimo Y un PAT inválido reciben 302 a la página de login (no 401), así que
// «sin credencial» y «no vale» se dicen juntas; 403 es «sin permiso de lectura (Code: Read)»; 404 trae `typeKey`
// (ProjectDoesNotExist / GitRepositoryNotFound). Los árboles vienen con `mode` "40000" (sin el cero adelante).
//
// Sólo `require` dentro de scripts/setup/harness/ al cargar; lo de ../../lib/ y team.js, al usarlos.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TH = require('./tycon-home.js');
const GA = require('./github-auth.js');

const lib = (name) => require(path.join(__dirname, '..', '..', 'lib', name));
// team.js carga este archivo (al usarlo) y este archivo usa team.js (planTeam, validateDeclaration, validateProfile, la caché): la
// vuelta se nombra por ruta armada para que la copia fija de arranque —que ordena los módulos por sus `require('./…')`— no vea
// un ciclo (tycon-home T2b)
const team = () => require(path.join(__dirname, 'team.js'));

const AZURE_HOST = 'dev.azure.com';
const API_VERSION = '7.1';
const TEAM_REF = 'main';
const SHA40 = /^[0-9a-f]{40}$/;
// org, proyecto y repo: letras y números de cualquier idioma («Facturación»), espacio, `._-` y paréntesis («Proyecto (Legacy)»);
// afuera quedan los que Azure DevOps tampoco admite y los que cambiarían la ruta de la API (`/ \ : ? # % & @ ~ * " < > |`…)
const NAME_RE = /^[\p{L}\p{N}\p{M}._ ()!-]+$/u;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
// con menos que esto en el reloj de la bajada no se pide el archivo siguiente: se dice «se acabó el tiempo» con lo que se bajó
const MIN_ITEM_MS = 1000;
const CONFIG_KEY = 'azure.token';
const SET_HINT = `harness.js config set ${CONFIG_KEY}`;

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const nowIso = () => new Date().toISOString();

/** `https://dev.azure.com/<org>/<proyecto>/_git/<repo>` (con o sin `usuario@`, barra final o `.git`) → `{ ok, org, project, name, url }`. */
function parseAzureUrl(url) {
  const s = String(url === undefined || url === null ? '' : url).trim();
  const m = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i.exec(s);
  // lo que se cita de vuelta va sin el `usuario[:clave]@` que pudiera traer (un PAT pegado en la URL no se repite en la salida)
  const shown = s.replace(/^(https?:\/\/)[^@/]+@/, '$1');
  if (!m) return { ok: false, problem: `--team tiene que ser la URL del repo del equipo: https://dev.azure.com/<org>/<proyecto>/_git/<repo> (o https://github.com/<org>/<repo>); dice «${shown}»` };
  const [org, project, name] = [m[1], m[2], m[3]].map((x) => { try { return decodeURIComponent(x); } catch (_) { return x; } });
  if (![org, project, name].every((x) => NAME_RE.test(x) && !/^\.+$/.test(x))) return { ok: false, problem: `la URL del repo del equipo trae un nombre con caracteres que no valen (dice «${shown}»)` };
  return { ok: true, host: 'azure', org, project, name, url: `https://${AZURE_HOST}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}` };
}

/** La acción cuando falta la credencial o no vale: las dos formas de ponerla. */
function how(src) {
  return `pegá un PAT de Azure DevOps de sólo lectura (Code: Read, de la organización ${src.org}) con: ${SET_HINT} — o iniciá sesión una vez con git en ${src.url} (un git fetch) para que el gestor de credenciales la guarde`;
}

/**
 * La credencial para el repo del equipo: `{ ok: true, pat, source: 'config'|'git-credential', username }` o
 * `{ ok: false, reason }` (con la acción adentro). Nunca pregunta ni cuelga: el gestor de git corre sin interacción y con tope.
 */
function credential(src, { env = process.env, git = 'git', timeoutMs = 15000 } = {}) {
  const cfg = GA.readConfig({ env });
  if (!cfg.ok) return { ok: false, reason: `${cfg.reason}: no puedo leer el PAT de Azure DevOps guardado — ${how(src)}` };
  const saved = isObject(cfg.data.azure) && typeof cfg.data.azure.token === 'string' ? cfg.data.azure.token.trim() : '';
  if (saved) return { ok: true, pat: saved, source: 'config', username: null };
  if (String(env.TYCON_AZURE_GIT_CREDENTIAL || '') !== '0') {
    const input = `protocol=https\nhost=${AZURE_HOST}\npath=${src.org}/${src.project}/_git/${src.name}\n\n`;
    // sin interacción de verdad: ni el GCM (GCM_INTERACTIVE), ni la terminal (GIT_TERMINAL_PROMPT), ni el askpass que la
    // terminal de VS Code deja en el entorno (GIT_ASKPASS/SSH_ASKPASS: con él, git abriría un cuadro al dev en cada arranque)
    const r = spawnSync(git, ['credential', 'fill'], { input, encoding: 'utf8', timeout: timeoutMs, env: Object.assign({}, env, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CREDENTIAL_INTERACTIVE: 'never' }), windowsHide: true });
    if (!r.error && r.status === 0) {
      const out = {};
      for (const line of String(r.stdout || '').split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i)] = line.slice(i + 1); }
      if (out.password) return { ok: true, pat: out.password, source: 'git-credential', username: out.username || null };
    }
  }
  return { ok: false, reason: `sin credencial de Azure DevOps para ${src.url} (ni PAT guardado en ${cfg.file} ni una en el gestor de credenciales de git): ${how(src)}` };
}

/** La base de la API: la real (https), o `TYCON_AZURE_API` (las pruebas) — por http SÓLO hacia esta máquina: la credencial nunca viaja en claro a otro host. */
function apiBase(env) {
  const v = String(env.TYCON_AZURE_API || '').trim().replace(/\/+$/, '');
  if (!v) return { ok: true, base: `https://${AZURE_HOST}` };
  let u;
  try { u = new URL(v); } catch (_) { return { ok: false, reason: `TYCON_AZURE_API no es una URL (dice «${v}»)` }; }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !loopback) return { ok: false, reason: `TYCON_AZURE_API apunta por ${u.protocol.replace(':', '')} a ${u.hostname}: la credencial no se manda en claro fuera de esta máquina (sólo https, o http hacia 127.0.0.1)` };
  return { ok: true, base: v };
}

/**
 * El cliente de la API para un repo: `get(rest, { maxBytes, accept })` → `{ ok, status, headers, body, json, html }` o
 * `{ ok: false, kind, message }`. No sigue redirecciones: la de Azure a la página de login ES la respuesta (302).
 */
function client(src, cred, { env = process.env, deadlineAt = null } = {}) {
  const http = lib('http-get.js');
  const ab = apiBase(env);
  const base = ab.ok ? ab.base : null;
  const prefix = `${base}/${encodeURIComponent(src.org)}/${encodeURIComponent(src.project)}/_apis/git/repositories/${encodeURIComponent(src.name)}/`;
  // el reloj, como el del cliente de GitHub (release.js): se puede correr para la bajada (`setDeadline`) y un fallo del reloj
  // queda marcado (`outOfClock`) para decirse «se acabó el tiempo», no «sin red» (2026-10-09)
  const clock = { deadline: deadlineAt || (Date.now() + 15000), since: Date.now(), answered: 0 };
  const auth = cred && cred.ok ? { Authorization: `Basic ${Buffer.from(`:${cred.pat}`).toString('base64')}` } : {};
  const get = (rest, { maxBytes = 8 * 1024 * 1024, accept = 'application/json', timeoutMs = null } = {}) => {
    if (!ab.ok) return { ok: false, kind: 'insecure', message: ab.reason };
    const url = `${prefix}${rest}${rest.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
    const headers = Object.assign({ Accept: accept }, auth);
    const leftMs = clock.deadline - Date.now();
    const r = http.getSync(url, { headers, env, timeoutMs: timeoutMs || Math.max(1000, leftMs), deadlineAt: clock.deadline, maxBytes, maxRedirects: 0 });
    if (!r.ok) { if (http.ranOutOfClock(r, { leftMs, answered: clock.answered })) r.outOfClock = { leftMs: Math.max(0, leftMs), answered: clock.answered, totalS: Math.round((clock.deadline - clock.since) / 1000) }; return r; }
    clock.answered += 1;
    const type = String(r.headers['content-type'] || '');
    let json = null;
    if (/json/.test(type)) { try { json = JSON.parse(r.body.toString('utf8')); } catch (_) { json = null; } }
    return { ok: true, status: r.status, headers: r.headers, body: r.body, json, html: /html/.test(type), url };
  };
  const c = { get, cred, base, src, setDeadline: (at) => { clock.deadline = at; clock.since = Date.now(); clock.answered = 0; } };
  Object.defineProperty(c, 'deadline', { enumerable: true, get: () => clock.deadline });
  Object.defineProperty(c, 'since', { enumerable: true, get: () => clock.since });
  return c;
}

/** Qué decir cuando un pedido a Azure no sirvió: `{ status: 'unknown'|'blocked', missing?: 'team', reason }`. */
function explain(c, r, what) {
  const src = c.src;
  // el cliente no sigue redirecciones: la de Azure a la página de login llega como «redirect» (es el 302 medido contra la API real)
  if (!r.ok && r.kind === 'redirect') r = { ok: true, status: 302, headers: {}, body: Buffer.alloc(0), json: null, html: true };
  if (!r.ok) {
    if (r.kind === 'insecure') return { status: 'blocked', reason: r.message };
    if (r.outOfClock) return { status: 'unknown', outOfClock: true, reason: `se acabó el tiempo: el tope de ${r.outOfClock.totalS} s no alcanzó para ${what} (${r.outOfClock.answered} pedido(s) contestado(s); al último le quedaban ${r.outOfClock.leftMs} ms) — no es la red` };
    if (r.kind === 'network' || r.kind === 'timeout') return { status: 'unknown', reason: `sin red: no pude hablar con Azure DevOps para ${what} (${r.code || r.message})` };
    if (r.kind === 'proxy-timeout' || r.kind === 'proxy') return { status: 'unknown', reason: `proxy sin respuesta: ${r.message}` };
    if (r.kind === 'tls') return { status: 'unknown', reason: `no pude verificar el certificado de Azure DevOps (${r.message})` };
    return { status: 'unknown', reason: `no pude pedir ${what} a Azure DevOps: ${r.message}` };
  }
  const login = r.status === 302 || r.status === 203 || r.status === 401 || (r.status === 200 && r.html);
  if (login) {
    const reason = c.cred && c.cred.ok
      ? `la credencial de Azure DevOps (${c.cred.source === 'config' ? `el PAT guardado, ${SET_HINT}` : 'la del gestor de credenciales de git'}) no vale para ${src.url} (Azure contestó ${r.status}: venció, o no es un PAT con Code: Read de la organización ${src.org}) — ${how(src)}`
      : `sin credencial de Azure DevOps para ${src.url} (Azure contestó ${r.status}, la página de login): ${how(src)}`;
    return { status: 'blocked', missing: 'team', reason };
  }
  if (r.status === 403) return { status: 'blocked', missing: 'team', reason: `la credencial de Azure DevOps no tiene permiso de lectura (Code: Read) sobre ${src.url} (403): pedile al dueño que te dé lectura al repo del equipo, o un PAT con ese permiso (${SET_HINT})` };
  if (r.status === 404) {
    const key = r.json && typeof r.json.typeKey === 'string' ? r.json.typeKey : '';
    if (/ProjectDoesNotExist/i.test(key)) return { status: 'blocked', missing: 'team', reason: `el proyecto ${src.project} no existe en la organización ${src.org} de Azure DevOps (404): revisá la URL del repo del equipo` };
    return { status: 'blocked', missing: 'team', reason: `el repo ${src.name} no existe en ${src.org}/${src.project} o la credencial no lo ve (404 ${key || ''}): revisá la URL del repo del equipo y los permisos` };
  }
  if (r.status === 429) return { status: 'unknown', reason: `Azure DevOps pidió esperar (429${r.headers['retry-after'] ? `, ${r.headers['retry-after']} s` : ''}) para ${what}` };
  return { status: 'unknown', reason: `Azure DevOps contestó ${r.status} a ${what}` };
}

/** El contenido crudo de un archivo en un commit, verificado por su blob: `{ ok, buf }` o el motivo. */
function itemAt(c, commit, file, expectedSha, { timeoutMs = null } = {}) {
  const r = c.get(`items?path=${encodeURIComponent(`/${file}`)}&versionDescriptor.version=${commit}&versionDescriptor.versionType=commit`, { accept: 'application/octet-stream', maxBytes: MAX_ITEM_BYTES, timeoutMs });
  if (!r.ok || r.status !== 200 || r.html) return Object.assign({ ok: false }, explain(c, r, `el archivo ${file}`));
  const GH = lib('git-tree-hash.js');
  const blob = GH.blobSha(r.body);
  if (expectedSha && blob !== expectedSha) return { ok: false, status: 'blocked', reason: `el archivo ${file} que Azure DevOps devolvió no es el blob que la lista del árbol declara (${sha7(blob)} ≠ ${sha7(expectedSha)}): no se usa` };
  return { ok: true, buf: r.body, blob };
}

/**
 * Resuelve y valida la capa SIN escribir ni registrar (la misma forma que `team.resolveTeam`): la ref `main`, el commit y
 * su `treeId`, la lista del árbol (lista cerrada; su hash recalculado tiene que dar el `treeId`), la declaración y el perfil.
 */
function resolve(c, { version, readerTree, home = os.homedir(), env = process.env, knownCommits = [] } = {}) {
  const T = team();
  const src = c.src;
  const head = `capa del equipo (${src.url})`;
  const refs = c.get(`refs?filter=heads/${TEAM_REF}`);
  if (!refs.ok || refs.status !== 200 || !refs.json || !Array.isArray(refs.json.value)) { const f = explain(c, refs, `la ref ${TEAM_REF} del repo del equipo`); return Object.assign({ ok: false }, f, { reason: `${head}: ${f.reason}` }); }
  // Azure filtra las refs por PREFIJO (`heads/main` trae también `main-old`): sólo la rama exacta vale, nunca «la primera»
  const ref = refs.json.value.find((v) => v && v.name === `refs/heads/${TEAM_REF}`);
  if (!ref || typeof ref.objectId !== 'string' || !SHA40.test(ref.objectId)) return { ok: false, status: 'blocked', missing: 'team', reason: `${head}: el repo del equipo no tiene la rama ${TEAM_REF}${refs.json.value.length ? ` (hay ${refs.json.value.map((v) => String(v.name || '').replace(/^refs\/heads\//, '')).slice(0, 3).join(', ')})` : ''}; la capa se lee de refs/heads/${TEAM_REF}` };
  const commit = ref.objectId;
  // el refresco en el lugar (story 8.25, A1b · AC 10 (a), W10): un commit que quien llama ya conoce (el de harness/ o uno
  // rechazado) no pide nada más
  if (Array.isArray(knownCommits) && knownCommits.includes(commit)) return { ok: true, unchanged: true, repo: src.url, host: 'azure', commit, etag: null };
  const meta = c.get(`commits/${commit}`);
  if (!meta.ok || meta.status !== 200 || !meta.json || typeof meta.json.treeId !== 'string') { const f = explain(c, meta, `el commit ${sha7(commit)} del repo del equipo`); return Object.assign({ ok: false }, f, { reason: `${head}: ${f.reason}` }); }
  const tree = meta.json.treeId;
  if (!SHA40.test(tree)) return { ok: false, status: 'blocked', reason: `${head}: el commit ${sha7(commit)} declara un árbol sin forma de sha: no se usa` };
  const list = c.get(`trees/${tree}?recursive=true`);
  if (!list.ok || list.status !== 200 || !list.json || !Array.isArray(list.json.treeEntries)) { const f = explain(c, list, `la lista del árbol ${sha7(tree)} del repo del equipo`); return Object.assign({ ok: false }, f, { reason: `${head}: ${f.reason}` }); }
  // una entrada sin forma (nula, sin ruta, sin sha de 40 hex, sin tipo o sin modo) es «la lista no sirve», dicho — no un TypeError
  // que suba hasta el catch de harness.js como un volcado de pila (pase adversarial 8.25 A1a-azure)
  const malformed = list.json.treeEntries.find((e) => !e || typeof e !== 'object' || typeof e.relativePath !== 'string' || !e.relativePath || typeof e.objectId !== 'string' || !SHA40.test(e.objectId) || typeof e.gitObjectType !== 'string' || typeof e.mode !== 'string');
  if (malformed !== undefined) return { ok: false, status: 'blocked', reason: `${head}: la lista del árbol ${sha7(tree)} que Azure DevOps devolvió trae una entrada sin forma (sin ruta, sin sha de 40 hex, sin tipo o sin modo): no se usa` };
  const entries = list.json.treeEntries.map((e) => ({ path: e.relativePath, mode: e.mode === '40000' ? '040000' : e.mode, type: e.gitObjectType, sha: e.objectId, size: Number(e.size) || 0 }));
  // la lista tiene que SER el árbol del commit: su hash recalculado (blobs y submódulos con sus modos) da el treeId, o no se usa
  const GH = lib('git-tree-hash.js');
  const leaves = entries.filter((e) => e.type !== 'tree').map((e) => ({ mode: e.mode, path: e.path, sha: e.sha }));
  const recomputed = leaves.length ? GH.treeSha(leaves) : null;
  if (recomputed !== tree) return { ok: false, status: 'blocked', reason: `${head}: la lista del árbol que Azure DevOps devolvió no da el árbol del commit ${sha7(commit)} (${sha7(recomputed)} ≠ ${sha7(tree)}; lista cortada o alterada): no se usa` };
  const plan = T.planTeam(entries, { truncated: Boolean(list.json.truncated) });
  if (!plan.ok) return { ok: false, status: 'blocked', invalid: true, commit, reason: `${head} @ ${sha7(commit)}: no se apila — ${plan.problems.map((p) => `${p.path}: ${p.reason}`).join(' · ')}` };
  // el momento 1 (AC 26): la declaración y lo que se juzga por su contenido, cada item verificado por su blob, a una temporal fuera
  // del HOME que `fetch` reusa (cada archivo se pide UNA vez); lo que la máquina ya tiene con ese blob —en harness/ o en otra
  // caché— no se pide (tanda A2c · AC 39: un commit que sólo cambia el perfil cuesta la lista más un pedido)
  const store = T.blobStore(env);
  const judged = T.judgeContent(plan, (p, sha) => { const have = sha ? store.get(sha) : null; return have ? { ok: true, buf: have, blob: sha } : itemAt(c, commit, p, sha); }, { version, readerTree, home, env, head, commit });
  if (!judged.ok) return judged;
  return { ok: true, repo: src.url, host: 'azure', ref: TEAM_REF, commit, tree, etag: null, files: plan.files, declaration: judged.declaration, declarationSha: plan.declaration ? plan.declaration.sha : null, totalBytes: plan.totalBytes, profileEntries: judged.profileEntries, stagedDir: judged.dir };
}

/**
 * Baja los archivos de la capa resuelta (uno por uno, verificados por su blob) a `~/.tycon/team/<commit>/` con su manifiesto;
 * con la caché entera del mismo repo y commit, no pide nada. La misma forma que `team.fetchTeam`.
 */
function fetch(c, resolved, { env = process.env, log = null, deadlineFor = null, itemTimeoutMs = null } = {}) {
  const T = team();
  if (!SHA40.test(String(resolved.commit)) || !SHA40.test(String(resolved.tree))) return { ok: false, status: 'blocked', reason: `capa del equipo (${resolved.repo}): el commit o el árbol resueltos no tienen forma de sha: no se baja nada` };
  const cacheDir = T.cacheDirOf(env, resolved.commit);
  const m = T.readTeamManifest(cacheDir);
  if (m && m.commit === resolved.commit && m.repo === resolved.repo && m.tree === resolved.tree) {
    const GH = lib('git-tree-hash.js');
    const intact = [];
    for (const f of resolved.files) {
      let buf; try { buf = fs.readFileSync(path.join(cacheDir, ...f.path.split('/'))); } catch (_) { buf = null; }
      if (!buf || GH.blobSha(buf) !== f.sha) { intact.length = 0; break; }
      intact.push({ path: f.path, mode: f.mode || '100644', blob: f.sha });
    }
    if (intact.length === resolved.files.length) { if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} desde la caché (${intact.length} archivo(s))`); T.dropStaged(resolved.stagedDir); return { ok: true, cacheDir, files: intact, fromCache: true, resolved }; }
  }
  const staged = [];
  // lo que el momento 1 ya leyó y verificó (resolved.stagedDir) no se vuelve a pedir: cada archivo, una vez (AC 26); y lo que la
  // máquina ya tiene con ese blob, en harness/ o en otra caché, tampoco (tanda A2c · AC 39)
  const already = (f) => { if (!resolved.stagedDir) return null; try { const b = fs.readFileSync(path.join(resolved.stagedDir, ...f.path.split('/'))); return T.blobOf(b) === f.sha ? b : null; } catch (_) { return null; } };
  const store = T.blobStore(env);
  // lo que un intento anterior de ESTE commit ya bajó (y no llegó a terminar) queda en `<caché>.partial/<blob>`: una bajada
  // que se queda sin tiempo sigue desde ahí en vez de empezar de cero —si no, una red lenta no converge nunca (2026-10-09)—.
  // Cada archivo se verifica por su blob al leerlo; lo guardado de OTRO commit se borra acá
  const partialDir = `${cacheDir}.partial`;
  try { for (const n of fs.readdirSync(path.dirname(cacheDir))) if (/^[0-9a-f]{12}\.partial$/.test(n) && n !== path.basename(partialDir)) fs.rmSync(path.join(path.dirname(cacheDir), n), { recursive: true, force: true }); } catch (_) { /* sin cachés todavía */ }
  const partial = (f) => { try { const b = fs.readFileSync(path.join(partialDir, f.sha)); return T.blobOf(b) === f.sha ? b : null; } catch (_) { return null; } };
  const keepPartial = (sha, buf) => { try { fs.mkdirSync(partialDir, { recursive: true }); fs.writeFileSync(path.join(partialDir, sha), buf); } catch (e) { if (log) log(`team: no pude guardar lo bajado en ${partialDir} (${e.code || e.message}): si esta bajada no termina, la próxima empieza de nuevo`); } };
  const pending = [];
  for (const f of resolved.files) {
    const have = already(f) || store.get(f.sha) || partial(f);
    if (have) staged.push({ path: f.path, mode: f.mode || '100644', blob: f.sha, buf: have });
    else pending.push(f);
  }
  // bajar tiene su reloj (mirar es corto, bajar es largo): empieza ahora y depende de cuánto falta. Cada pedido espera lo que
  // un pedido de mirar (`itemTimeoutMs`): un servidor mudo no se lleva el reloj entero de la bajada
  if (pending.length && typeof deadlineFor === 'function') c.setDeadline(deadlineFor(pending.length));
  const startedAt = Date.now();
  const outOfTime = (done) => {
    T.dropStaged(resolved.stagedDir);
    const totalS = Math.max(1, Math.round((c.deadline - (c.since || startedAt)) / 1000));
    return { ok: false, status: 'unknown', outOfClock: true, reason: `capa del equipo (${resolved.repo}): se acabó el tiempo: bajé ${done} de ${pending.length} archivo(s) en ${totalS} s (el tope de la bajada) — no es la red; lo bajado queda guardado y el próximo intento sigue desde ahí. Para darle más tiempo: TYCON_RELEASE_DOWNLOAD_BUDGET_S=<segundos>` };
  };
  let done = 0;
  for (const f of pending) {
    if (c.deadline - Date.now() < MIN_ITEM_MS) return outOfTime(done);
    const it = itemAt(c, resolved.commit, f.path, f.sha, { timeoutMs: itemTimeoutMs });
    if (!it.ok) {
      if (it.outOfClock) return outOfTime(done);
      T.dropStaged(resolved.stagedDir);
      return Object.assign(it, { reason: `capa del equipo (${resolved.repo}): ${it.reason}` });
    }
    keepPartial(f.sha, it.buf);
    done += 1;
    staged.push({ path: f.path, mode: f.mode || '100644', blob: it.blob, buf: it.buf });
  }
  // en el orden de la lista del árbol, como siempre (lo que ya estaba y lo bajado se juntaron por separado)
  const order = new Map(resolved.files.map((f, i) => [f.path, i]));
  staged.sort((a, b) => order.get(a.path) - order.get(b.path));
  // la declaración que el momento 1 ya verificó queda en la caché (no se apila): la próxima punta que no la cambie no la pide
  const declSha = SHA40.test(String(resolved.declarationSha || '')) ? resolved.declarationSha : null;
  const declBuf = declSha ? (already({ path: T.DECLARATION, sha: declSha }) || store.get(declSha)) : null;
  T.dropStaged(resolved.stagedDir);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const s of staged) { const to = path.join(cacheDir, ...s.path.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, s.buf); }
  if (declBuf) fs.writeFileSync(path.join(cacheDir, T.DECLARATION), declBuf);
  const files = staged.map((s) => ({ path: s.path, mode: s.mode, blob: s.blob }));
  const manifest = { schema: 1, repo: resolved.repo, host: 'azure', ref: resolved.ref, commit: resolved.commit, tree: resolved.tree, etag: null, name: resolved.declaration.name, requires: resolved.declaration.requires, files, ...(declBuf ? { declaration_blob: declSha } : {}), fetched_at: nowIso() };
  fs.writeFileSync(path.join(cacheDir, T.MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
  // la caché entera reemplaza a lo guardado a medias
  try { fs.rmSync(partialDir, { recursive: true, force: true }); } catch (e) { if (log) log(`team: no pude borrar ${partialDir} (${e.code || e.message}): queda; la próxima bajada lo limpia`); }
  if (log) log(`team: ${resolved.repo} @ ${sha7(resolved.commit)} bajada de Azure DevOps y verificada en ${cacheDir} (${files.length} archivo(s), árbol ${sha7(resolved.tree)})`);
  return { ok: true, cacheDir, files, fromCache: false, resolved };
}

module.exports = { AZURE_HOST, CONFIG_KEY, SET_HINT, parseAzureUrl, credential, client, explain, itemAt, resolve, fetch, how };
