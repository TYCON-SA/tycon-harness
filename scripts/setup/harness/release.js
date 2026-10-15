'use strict';
// release.js — la instalación `release`: una versión BAJADA de GitHub como archivos, sin git (story 8.23, tanda B).
//
// ── QUÉ ES ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Hasta la 8.23 cada máquina usaba un CLON de git para usar el arnés. Acá la máquina baja de GitHub el comprimido de
// un commit publicado, lo verifica y lo deja en `~/.tycon/harness`; la versión anterior queda en `~/.tycon/previous`
// para volver atrás sin red. Es la forma `kind: release` del estado, al lado de `kind: tree` (el clon): una máquina con
// clon no pasa por acá nunca (`state.isRelease`).
//
// ── CÓMO HABLA CON GITHUB ────────────────────────────────────────────────────────────────────────────────────────
// SIN permiso guardado (story 8.34), por las rutas públicas de public-git.js, que no cuentan contra el tope de la API
// (60 consultas por hora por conexión, aunque el repo sea público):
//   · las ramas, de UN pedido a `info/refs` (`main` y `mirror/sync` juntas); el número, del raw de cada commit, salvo que
//     el commit ya se conozca (el instalado, o una punta ya vista: `src.etags.tips`);
//   · el comprimido, de codeload (`tar.gz/<sha>`), y los de terceros, igual;
//   · a la API le queda UNA consulta por bajada: `git/commits/<sha>`, el árbol con el que se verifica (decisión D1 = A
//     del dueño, 2026-10-14). `install --version <n>` sigue por la API (D2 = A).
//   · Respaldo: `info/refs` sin red, con un 5xx o ilegible → se mira por la API, como antes, y se anota en el registro;
//     un 401/404 de `info/refs` (así contesta GitHub un repo que no existe o no es público) no cae: es «no se ve». El raw
//     caído → ese único `version.json` por la API.
//   · El tope: un 403 con `X-RateLimit-Remaining: 0` deja la hora de renovación (`limitedUntil`); el arranque la guarda
//     (`state.api_limited_until`) y hasta esa hora su cliente NO le pide nada a la API (`waitUntil`), avisa una vez y no lo
//     cuenta como fallo. `update` a mano intenta una vez.
// CON permiso guardado, por la API, igual que antes de la 8.34 (lo pidió el dueño; un repo privado sólo se ve así), con
// el cliente propio (scripts/lib/http-get.js: proxy, tope, redirección sin reenviar la credencial).
// Un permiso guardado que VENCIÓ (2026-10-14, la máquina de un dev): GitHub contesta 401 aunque el repo sea público, y el
// arnés quedaba sin actualizarse por un permiso que no hacía falta. Ante un 401 de un repo `/repos/<org>/<n>/…`, el cliente
// mira si ese repo se lee sin permiso (`info/refs` sin credencial, 200): si sí, sigue SIN el permiso —las rutas públicas de
// arriba— por el resto del proceso, y la máquina lo dice una vez (`EXPIRED_TOKEN_TEXT`, `state.token_expired_notice`); el
// permiso no se borra solo. Si el repo no se lee sin permiso (privado), el 401 se dice como siempre. El cliente del repo
// del equipo (team.js, `keepToken`) no cambia: ahí el permiso sí puede hacer falta.
//   · la ref del canal: `git/ref/heads/<ref>` (la de `latest`, `mirror/sync`, lleva barra y va tal cual), con ETag;
//     `latest` lee `main` si `mirror/sync` no está o su número es menor (la regla de sources.js);
//   · `contents/version.json?ref=<commit>`: el número, con If-None-Match (con permiso, un 304 no gasta cuota; sin
//     permiso SÍ gasta, según la documentación de GitHub: por eso sin permiso no se usa);
//   · `git/commits/<sha>`: el árbol del commit, con el que se verifica lo bajado;
//   · `tarball/<sha>`: el comprimido DE ESE COMMIT (redirige a codeload con su propia llave en la URL);
//   · `commits?sha=<ref>&path=version.json&per_page=100`: para ubicar un número pedido a mano (`install --version <n>`).
// La credencial es la de github-auth.js (siempre el permiso pegado; nunca git). El repo sale de
// `scripts/setup/public-remotes.json` del árbol que corre (la copia pública lo trae), o de `scripts/publishing/
// public-repos.json` (el interno), o de `--repo <org/nombre>`. `TYCON_RELEASE_API` cambia la base de la API (sólo las
// pruebas: el servidor de juguete), y `TYCON_RELEASE_GIT` / `_RAW` / `_ARCHIVE` las de las rutas públicas (public-git.js).
//
// ── EL CAMBIO DE VERSIÓN, CON DIARIO ─────────────────────────────────────────────────────────────────────────────
// La versión verificada se arma en `incoming/<v>/` (lector propio, scripts/lib/tar-reader.js; el árbol de git calculado
// tiene que ser el del commit) con el manifiesto adentro (`.tycon-release.json`: commit, árbol, versión, y ruta, modo y
// blob de cada archivo). Después, el cambio: el diario `swap.json` se escribe ANTES de mover; una `previous/` que todavía
// está se aparta a `trash/<sello>/` (nunca se borra durante el cambio; si no se puede apartar, la actualización ESPERA);
// `harness/` → `previous/`; `incoming/<v>/` → `harness/`; diario fuera. Un corte entre los dos `rename` lo repara el
// arranque siguiente desde el diario (`repair`; también bootstrap.js y los respaldos en shell). `trash/` se vacía en el
// arranque siguiente a una actualización sana, salvo lo que esté tomado (Windows) o lo nombre el estado, un enchufe o
// la tarea del examen.
//
// ── QUÉ RECIBE DE harness.js ─────────────────────────────────────────────────────────────────────────────────────
// Las piezas que ya existen y no saben de git: `H = { takeSnapshot, finishSnapshot, runApplier, runHealth, recordPieces,
// ensureLink, linkResolvesTo, ensureImport, copyBootstrap, settingsPath, policyOf, applyPolicy, installQuestions,
// writeAnswers, profileOf, machineProfile, applyHint }`. Lo que acá se evita a propósito: `sources.js` (todo git),
// `report.derive` (pregunta a git), `currentSources` sobre fuentes con `dir`.
//
// Sólo `require` dentro de scripts/setup/harness/ al cargar; el lector de comprimidos y el cliente HTTP se cargan al
// usarlos (`../../lib/`), así este archivo también corre desde la copia fija para reparar y volver atrás.

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./state.js');
const R = require('./report.js');
const TH = require('./tycon-home.js');
const GA = require('./github-auth.js');
const VO = require('./version-order.js');
const TOOLS = require('./tools.js');
const PG = require('./public-git.js');

const API_DEFAULT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const MAIN_REF = 'main';
const SYNC_REF = 'mirror/sync';
const MANIFEST_NAME = '.tycon-release.json';
const TARBALL_BUDGET_S_DEFAULT = 120;
const MAX_TARBALL_BYTES = 256 * 1024 * 1024;
const LOCATE_PAGE = 100;

// el permiso guardado que GitHub rechazó (401) contra un repo público, en ESTE proceso (sólo en memoria, nunca escrito):
// los clientes que se arman después ya no lo mandan. Y lo que se sabe de cada repo: si se lee sin permiso
let EXPIRED_TOKEN = null;
const READS_WITHOUT_TOKEN = new Map();
const EXPIRED_TOKEN_TEXT = 'el permiso de GitHub guardado venció o se revocó (401), pero no hace falta: el repo del arnés es público y se actualiza sin él. Para sacarlo: harness.js config unset github.token';
const ROUTE_REPO = /^\/repos\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\//;
/** ¿El permiso guardado de esta máquina es el que GitHub rechazó en este proceso? */
function tokenExpired(env) { const t = GA.readToken({ env }).token; return Boolean(t && EXPIRED_TOKEN === t); }

const nowIso = () => new Date().toISOString();
const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };
const lib = (name) => require(path.join(__dirname, '..', '..', 'lib', name));

// ── el repo y la API ──────────────────────────────────────────────────────────────────────────────────────────────

/** `github.com/<org>/<repo>` de una URL (https o ssh), o null. */
function githubRepoOf(url) {
  const m = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? { org: m[1], name: m[2] } : null;
}

/**
 * De qué repo baja la máquina: `--repo org/nombre`; si no, `scripts/setup/public-remotes.json` del árbol que corre; si no,
 * `scripts/publishing/public-repos.json` (el interno). `{ org, name, repo, url }` o `{ problem }`.
 */
function repoOf({ tree, option = null }) {
  if (option) {
    const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(String(option).trim());
    if (!m) return { problem: `--repo tiene que ser org/nombre (dice «${option}»)` };
    return { org: m[1], name: m[2], repo: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` };
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'setup', 'public-remotes.json'), 'utf8'));
    const hit = (Array.isArray(j.remotes) ? j.remotes : []).map(githubRepoOf).find(Boolean);
    if (hit) return Object.assign(hit, { repo: `${hit.org}/${hit.name}`, url: `https://github.com/${hit.org}/${hit.name}` });
  } catch (_) { /* no está: se prueba el otro */ }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'publishing', 'public-repos.json'), 'utf8'));
    if (j && typeof j.org === 'string' && typeof j.repo === 'string') return { org: j.org, name: j.repo, repo: `${j.org}/${j.repo}`, url: `https://github.com/${j.org}/${j.repo}` };
  } catch (_) { /* tampoco */ }
  return { problem: 'no sé de qué repo bajar: el árbol no trae scripts/setup/public-remotes.json ni scripts/publishing/public-repos.json; pasá --repo <org/nombre>' };
}

function apiBase(env) { return String(env.TYCON_RELEASE_API || API_DEFAULT).replace(/\/+$/, ''); }
function budgetS(env) { const n = Number(env.TYCON_UPDATE_NETWORK_BUDGET_S); return n > 0 ? n : 15; }

/**
 * El cliente de la API para una corrida: `get(ruta, { etag, maxBytes, timeoutMs })` → `{ ok, status, headers, body,
 * json }` o `{ ok: false, kind, message }`. Lleva la credencial de github-auth.js (si hay) y respeta el tope total.
 */
function client(ctx, { deadlineAt = null, waitUntil = null, keepToken = false } = {}) {
  const env = ctx.env || process.env;
  const base = apiBase(env);
  const read = GA.readToken({ env });
  const problem = read.problem;
  let token = read.token;
  // un permiso que ya contestó 401 contra un repo público en este proceso no se vuelve a mandar (`keepToken`: el repo del equipo)
  let expired = false;
  if (token && !keepToken && EXPIRED_TOKEN === token) { token = null; expired = true; }
  // sin permiso, las rutas públicas (story 8.34); con permiso, ninguna: el camino es el de la API, como antes
  const pub = token ? null : PG.bases(env);
  // el tope que contestó la API en esta corrida (la hora de renovación, en ms), y la espera que se respeta (el arranque)
  const limit = { until: null };
  // el reloj se puede correr (`setDeadline`): mirar es corto y bajar es largo, y quien baja después de mirar no hereda lo que
  // sobró de la mirada (2026-10-09). `clock` cuenta desde cuándo corre y cuántos pedidos contestaron: con eso un fallo del
  // reloj se dice como lo que es («se acabó el tiempo») y no como «sin red»
  const clock = { deadline: deadlineAt || (Date.now() + budgetS(env) * 1000), since: Date.now(), answered: 0 };
  const http = lib('http-get.js');
  const get = (route, { etag = null, maxBytes = 8 * 1024 * 1024, timeoutMs = null, retry = true } = {}) => {
    // la espera del tope (decisión 6 de la 8.34): hasta la hora que dijo GitHub, ningún pedido a la API
    if (waitUntil && Date.now() < waitUntil) return { ok: false, kind: 'limited', until: waitUntil, message: 'la API está en su tope' };
    const headers = Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION }, GA.authHeaders(token));
    if (etag) headers['If-None-Match'] = etag;
    const leftMs = clock.deadline - Date.now();
    const r = http.getSync(/^https?:\/\//.test(route) ? route : `${base}${route}`, { headers, env, timeoutMs: timeoutMs || Math.max(1000, leftMs), deadlineAt: clock.deadline, maxBytes });
    if (!r.ok) { if (http.ranOutOfClock(r, { leftMs, answered: clock.answered })) r.outOfClock = { leftMs: Math.max(0, leftMs), answered: clock.answered, totalS: Math.round((clock.deadline - clock.since) / 1000) }; return r; }
    clock.answered += 1;
    // el permiso vencido contra un repo que se lee sin permiso: se sigue sin él (y el pedido se repite sin credencial, salvo
    // que quien llama prefiera volver a mirar por las rutas públicas: `retry: false`)
    if (r.status === 401 && token && !keepToken && withoutToken(route)) {
      EXPIRED_TOKEN = token; token = null; expired = true; c.token = null; c.public = PG.bases(env);
      if (retry) return get(route, { etag, maxBytes, timeoutMs });
    }
    if (r.status === 403 && String(r.headers['x-ratelimit-remaining']) === '0') limit.until = resetOf(r.headers);
    let json = null;
    if (r.status !== 304 && /json/.test(String(r.headers['content-type'] || ''))) { try { json = JSON.parse(r.body.toString('utf8')); } catch (_) { json = null; } }
    return { ok: true, status: r.status, headers: r.headers, body: r.body, json, url: r.url };
  };
  // una ruta pública (github.com, raw, codeload): sin credencial nunca, con el mismo reloj
  const getPublic = (url, { maxBytes = 8 * 1024 * 1024, timeoutMs = null } = {}) => {
    const leftMs = clock.deadline - Date.now();
    const r = http.getSync(url, { headers: { Accept: '*/*' }, env, timeoutMs: timeoutMs || Math.max(1000, leftMs), deadlineAt: clock.deadline, maxBytes });
    if (!r.ok) { if (http.ranOutOfClock(r, { leftMs, answered: clock.answered })) r.outOfClock = { leftMs: Math.max(0, leftMs), answered: clock.answered, totalS: Math.round((clock.deadline - clock.since) / 1000) }; return r; }
    clock.answered += 1;
    return { ok: true, status: r.status, headers: r.headers, body: r.body, json: null, url: r.url };
  };
  /** ¿El repo de esta ruta de la API se lee sin permiso? `info/refs` sin credencial con 200 (una vez por repo y proceso). */
  const withoutToken = (route) => {
    const m = ROUTE_REPO.exec(String(route));
    if (!m) return false;
    if (!READS_WITHOUT_TOKEN.has(m[1])) {
      const r = getPublic(PG.refsUrl(PG.bases(env), m[1]), { timeoutMs: Math.max(1000, Math.floor((clock.deadline - Date.now()) / 2)) });
      READS_WITHOUT_TOKEN.set(m[1], Boolean(r.ok && r.status === 200));
    }
    return READS_WITHOUT_TOKEN.get(m[1]);
  };
  const c = { get, getPublic, public: pub, token, tokenProblem: problem, base, setDeadline: (at) => { clock.deadline = at; clock.since = Date.now(); clock.answered = 0; } };
  Object.defineProperty(c, 'expiredToken', { enumerable: true, get: () => expired });
  Object.defineProperty(c, 'deadline', { enumerable: true, get: () => clock.deadline });
  Object.defineProperty(c, 'limitedUntil', { enumerable: true, get: () => limit.until });
  return c;
}

/** La hora de renovación de un 403 del tope (`X-RateLimit-Reset`, en segundos), en ms; sin ella, dentro de una hora. */
function resetOf(headers) {
  const reset = Number((headers || {})['x-ratelimit-reset']);
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 3600 * 1000;
}
/** HH:MM en la hora local de la máquina. */
function localHHMM(ms) { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
/** El tope, dicho (decisión 7): hasta qué hora, en hora local; sin pedir un permiso como única salida. */
function limitText(c, until) {
  return `GitHub limita las consultas ${c.token ? 'de tu permiso' : 'sin permiso de esta conexión'} hasta las ${localHHMM(until)}`;
}
/** El aviso de una versión nueva que espera al tope: una sola vez por espera (el arranque) y el texto de `update` a mano. */
function limitWaitText(c, until, version) {
  return `hay versión nueva (${version}); ${limitText(c, until)}; se baja sola en el primer arranque después de esa hora. No hace falta hacer nada.`;
}

/** La frase de un fallo del reloj (`r.outOfClock`, de los dos clientes): nunca «sin red». */
function outOfClockText(r, what) {
  const o = r.outOfClock;
  return `se acabó el tiempo: el tope de ${o.totalS} s no alcanzó para ${what} (${o.answered} pedido(s) contestado(s); al último le quedaban ${o.leftMs} ms) — no es la red`;
}

/**
 * Qué decir cuando un pedido no sirvió (AC 9 y 11): `{ status: 'unknown', reason }` para lo que no se pudo mirar, y
 * `{ status: 'blocked', reason }` para lo que sí contestó y cierra el camino. `probeUser`: pide /user para la causa del 404.
 */
function explainFailure(c, r, { what = 'la API de GitHub', probeUser = true, repo = null } = {}) {
  if (!r.ok) {
    if (r.kind === 'limited') return { status: 'unknown', limitedUntil: r.until, reason: `${limitText(c, r.until)}: no le pido nada a la API hasta esa hora` };
    if (r.outOfClock) return { status: 'unknown', outOfClock: true, reason: outOfClockText(r, what) };
    if (r.kind === 'network') return { status: 'unknown', reason: `sin red: no pude hablar con ${what} (${r.code || r.message})` };
    if (r.kind === 'proxy-timeout' || r.kind === 'proxy') return { status: 'unknown', reason: `proxy sin respuesta: ${r.message}` };
    // sin proxy, un servidor que no contesta es «sin red» (la regla de la 8.13 T4: una IP no ruteable, un servidor mudo)
    if (r.kind === 'timeout') return { status: 'unknown', reason: `sin red: ${what} no contestó dentro del tope (${r.message})` };
    if (r.kind === 'tls') return { status: 'unknown', reason: `no pude verificar el certificado de ${what} (${r.message})` };
    return { status: 'unknown', reason: `no pude mirar ${what}: ${r.message}` };
  }
  // `c.repos` (story 8.25): con la capa del equipo declarada, el permiso tiene que ver los DOS repos y la acción los nombra
  if (r.status === 401) return { status: 'blocked', reason: GA.explain401({ repos: c.repos || null }) };
  if (r.status === 403 && String(r.headers['x-ratelimit-remaining']) === '0') {
    // el tope (story 8.34, decisión 7): la hora local, y que se puede esperar; el permiso es una opción, no la única salida
    const until = resetOf(r.headers);
    return { status: 'unknown', limitedUntil: until, reason: `${limitText(c, until)}: probá de nuevo después de esa hora${c.token ? '' : ' (un permiso guardado tiene otro tope, pero el repo público no lo necesita)'}` };
  }
  if (r.status === 404) {
    let userStatus = null;
    if (probeUser && c.token) { const u = c.get('/user'); userStatus = u.ok ? u.status : null; }
    // el repo se nombra sólo cuando hay DOS que distinguir (la copia y el del equipo, `c.repos`): una máquina sin equipo ve el
    // texto de siempre (AC 16 de la story 8.25)
    return { status: 'blocked', reason: GA.explain404({ token: c.token, userStatus, repo: c.repos ? repo : null, repos: c.repos || null }) };
  }
  return { status: 'unknown', reason: `${what} contestó ${r.status}` };
}

// ── mirar: la ref del canal y su número ───────────────────────────────────────────────────────────────────────────

/** El commit de una ref: `{ ok, sha, etag, unchanged }` o `{ ok: false, missing }` / el motivo de explainFailure. */
function refCommit(c, repo, ref, { etag = null, retry = true } = {}) {
  const r = c.get(`/repos/${repo}/git/ref/heads/${ref}`, { etag, retry });
  if (r.ok && r.status === 304) return { ok: true, unchanged: true, etag };
  if (r.ok && r.status === 200 && r.json && r.json.object && typeof r.json.object.sha === 'string') return { ok: true, sha: r.json.object.sha, etag: r.headers.etag || null };
  if (r.ok && r.status === 404 && etag === null) {
    // la rama no existe, o el repo no se ve: se distingue mirando `main` después (quien llama decide)
    return { ok: false, missing: true, raw: r };
  }
  return Object.assign({ ok: false }, explainFailure(c, r, { what: `la ref ${ref}` }));
}

/** El `version.json` de un commit: `{ ok, version, etag }`, `{ ok: true, absent: true }` si el commit no lo trae. */
function versionAt(c, repo, sha, { etag = null } = {}) {
  const r = c.get(`/repos/${repo}/contents/version.json?ref=${sha}`, { etag });
  if (r.ok && r.status === 304) return { ok: true, unchanged: true, etag };
  if (r.ok && r.status === 404) return { ok: true, absent: true };
  if (!r.ok || r.status !== 200 || !r.json) return Object.assign({ ok: false }, explainFailure(c, r, { what: 'version.json' }));
  let text = '';
  try { text = Buffer.from(String(r.json.content || ''), 'base64').toString('utf8'); } catch (_) { text = ''; }
  let v;
  try { v = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, status: 'blocked', reason: `el version.json de ${sha7(sha)} es ilegible (${e.message})` }; }
  if (!isObject(v) || typeof v.version !== 'string') return { ok: false, status: 'blocked', reason: `el version.json de ${sha7(sha)} no trae «version»` };
  return { ok: true, version: v.version, etag: r.headers.etag || null };
}

/**
 * Lo que el canal apunta: `{ status: 'ok', ref, commit, version, note }` o `{ status: 'unknown'|'blocked', reason }`.
 * `stable` lee `main`; `latest` lee `mirror/sync` si está y su número no es menor que el de `main`, si no `main`.
 */
function resolveChannel(c, repo, channel, { installed = null, tips = null, log = null } = {}) {
  if (c.public && !c.token) {
    const p = resolvePublic(c, repo, channel, { tips });
    if (!p.fallback) return p;
    // el respaldo (decisión 4): github.com sin contestar o info/refs ilegible → la API, como antes, y queda dicho
    if (log) log(`mirar: ${p.fallback}: miro por la API`);
  }
  const hadToken = Boolean(c.token);
  const main = refCommit(c, repo, MAIN_REF, { retry: false });
  // el permiso guardado venció y el repo se lee sin él: se vuelve a mirar por las rutas públicas (una sola vez: ya sin permiso)
  if (hadToken && !c.token && c.public) return resolveChannel(c, repo, channel, { installed, tips, log });
  if (!main.ok) return main.missing ? Object.assign({ status: 'blocked' }, { reason: explainFailure(c, main.raw, { what: 'el repo', repo }).reason }) : main;
  const mainVersion = versionAt(c, repo, main.sha);
  if (!mainVersion.ok) return mainVersion;
  const atMain = { status: 'ok', ref: MAIN_REF, commit: main.sha, etag: main.etag, version: mainVersion.absent ? null : mainVersion.version, note: null };
  if (channel !== 'latest') return atMain;
  const sync = refCommit(c, repo, SYNC_REF);
  if (!sync.ok) {
    if (sync.missing) return Object.assign(atMain, { note: `latest lee ${MAIN_REF}: el remoto no tiene ${SYNC_REF}` });
    return sync;
  }
  const syncVersion = versionAt(c, repo, sync.sha);
  if (!syncVersion.ok) return syncVersion;
  const cmp = VO.compare(syncVersion.absent ? null : syncVersion.version, atMain.version);
  if (cmp === null || cmp < 0) return Object.assign(atMain, { note: `latest lee ${MAIN_REF}: ${SYNC_REF} no trae nada más nuevo que ${MAIN_REF}` });
  return { status: 'ok', ref: SYNC_REF, commit: sync.sha, etag: sync.etag, version: syncVersion.version, note: null };
}

/**
 * Lo que el canal apunta, sin la API (story 8.34): las ramas de UN `info/refs` y el número del raw de cada commit (o de
 * `tips`, los commits cuyo número ya se conoce: el instalado y las puntas ya vistas). La misma forma que `resolveChannel`,
 * o `{ fallback: <por qué> }` cuando hay que mirar por la API.
 */
function resolvePublic(c, repo, channel, { tips = null } = {}) {
  // `info/refs` tiene a lo sumo la mitad del reloj: si no contesta, al respaldo por la API le queda la otra mitad
  const r = c.getPublic(PG.refsUrl(c.public, repo), { timeoutMs: Math.max(1000, Math.floor((c.deadline - Date.now()) / 2)) });
  if (!r.ok) return { fallback: `github.com no contestó (${r.message || r.kind})` };
  // un repo que no existe o no es público: GitHub contesta 401 (medido) o 404; no cae a la API, se dice como siempre
  if (r.status === 401 || r.status === 404) return { status: 'blocked', reason: GA.explain404({ token: null, userStatus: null, repo: c.repos ? repo : null, repos: c.repos || null }) };
  if (r.status !== 200) return { fallback: `github.com contestó ${r.status} a info/refs` };
  const refs = PG.parseInfoRefs(r.body);
  if (!refs.ok) return { fallback: `info/refs ilegible (${refs.reason})` };
  const mainSha = refs.heads[MAIN_REF];
  if (!mainSha) return { status: 'blocked', reason: GA.explain404({ token: null, userStatus: null, repo: c.repos ? repo : null, repos: c.repos || null }) };
  const mainV = numberAt(c, repo, mainSha, tips);
  if (!mainV.ok) return mainV;
  const atMain = { status: 'ok', ref: MAIN_REF, commit: mainSha, etag: null, version: mainV.version, note: null };
  if (channel !== 'latest') return atMain;
  const syncSha = refs.heads[SYNC_REF];
  if (!syncSha) return Object.assign(atMain, { note: `latest lee ${MAIN_REF}: el remoto no tiene ${SYNC_REF}` });
  const syncV = numberAt(c, repo, syncSha, tips);
  if (!syncV.ok) return syncV;
  const cmp = VO.compare(syncV.version, atMain.version);
  if (cmp === null || cmp < 0) return Object.assign(atMain, { note: `latest lee ${MAIN_REF}: ${SYNC_REF} no trae nada más nuevo que ${MAIN_REF}` });
  return { status: 'ok', ref: SYNC_REF, commit: syncSha, etag: null, version: syncV.version, note: null };
}

/**
 * El número de un commit sin la API: el que ya se conoce (`tips`), o el `version.json` del raw POR COMMIT (nunca por rama:
 * su caché de 5 minutos podría dar un número viejo). Sólo vale un 200 que es un `version.json` con su número; cualquier
 * otra cosa —sin red, sin respuesta, un 404, la página de un proxy que filtra (con 200 o con 404), algo que no se lee— es
 * «raw caído» y se pide ese único `version.json` a la API (que distingue de verdad un commit sin version.json). El raw
 * tiene a lo sumo la mitad del reloj, para que al respaldo le quede la otra (pase adversarial de la story 8.34).
 * `{ ok, version }` (`version: null` si el commit no lo trae) o el motivo; lo que lee lo suma a `tips`.
 */
function numberAt(c, repo, sha, tips) {
  if (tips && Object.prototype.hasOwnProperty.call(tips, sha)) return { ok: true, version: tips[sha] };
  const r = c.getPublic(PG.rawUrl(c.public, repo, sha, 'version.json'), { timeoutMs: Math.max(1000, Math.floor((c.deadline - Date.now()) / 2)) });
  let v = null;
  if (r.ok && r.status === 200) { try { v = JSON.parse(r.body.toString('utf8').replace(/^\uFEFF/, '')); } catch (_) { v = null; } }
  let out;
  if (isObject(v) && typeof v.version === 'string') out = { ok: true, version: v.version };
  else {
    const a = versionAt(c, repo, sha);
    if (!a.ok) return a;
    out = { ok: true, version: a.absent ? null : a.version };
  }
  if (tips && out.version) tips[sha] = out.version;
  return out;
}

/** Las puntas ya vistas que se guardan (`src.etags.tips`): las últimas pocas, nada más. */
const TIPS_KEEP = 6;
function keepTips(tips) { const e = Object.entries(tips || {}); return Object.fromEntries(e.slice(Math.max(0, e.length - TIPS_KEEP))); }

/**
 * `update --check` de una instalación release: compara lo que apunta el canal con lo instalado, POR NÚMERO.
 * `{ status: 'up_to_date'|'new'|'older'|'unknown'|'blocked', code, lines, target? }`. Sella `src.etags` en memoria.
 */
function check(ctx, state, { channel, log = null, deadlineAt = null, waitUntil = null } = {}) {
  const src = S.releaseSource(state);
  const c = client(ctx, { deadlineAt, waitUntil });
  if (c.tokenProblem) return { status: 'unknown', code: 2, lines: [`harness.js update: ${c.tokenProblem}`] };
  const ch = channel || state.channel || 'stable';
  const etags = isObject(src.etags) ? src.etags : {};
  // la ref del canal con el ETag de la última mirada: un 304 dice «la MISMA punta que vi» (su commit y su número vienen
  // guardados con el ETag) sin gastar cuota (AC 9); lo que se compara con lo instalado es siempre ese commit, nunca
  // «no cambió desde la última mirada» (la última mirada pudo ser de otro canal, o de una punta todavía no instalada)
  const want = ch === 'latest' ? SYNC_REF : MAIN_REF;
  const cached = etags[`ref:${want}`];
  let t = null;
  // (sin permiso no hay ETag: un 304 sin credencial gasta igual —story 8.34—; se mira por info/refs)
  if (!c.public && ch !== 'latest' && isObject(cached) && cached.etag && cached.sha) {
    const same = refCommit(c, repo(src), want, { etag: cached.etag, retry: false });
    if (same.ok && same.unchanged) t = { status: 'ok', ref: want, commit: cached.sha, version: cached.version || null, note: null };
    // (el permiso venció y el repo se lee sin él: abajo se mira por las rutas públicas)
    else if (!same.ok && !same.missing && !c.expiredToken) return { status: same.status || 'unknown', code: 2, lines: [`harness.js update: ${same.reason}`], limitedUntil: same.limitedUntil || null };
  }
  if (!t) {
    // los commits cuyo número ya se conoce: las puntas vistas y el instalado (ése no necesita el raw)
    const tips = Object.assign({}, isObject(etags.tips) ? etags.tips : {});
    if (src.commit && src.version) tips[src.commit] = src.version;
    t = resolveChannel(c, repo(src), ch, { installed: src.version, tips, log });
    if (t.status !== 'ok') return { status: t.status, code: 2, lines: [`harness.js update: ${t.reason}`], limitedUntil: t.limitedUntil || null };
    if (t.etag) src.etags = Object.assign({}, etags, { [`ref:${t.ref}`]: { etag: t.etag, sha: t.commit, version: t.version } });
    if (c.public) src.etags = Object.assign({}, src.etags || etags, { tips: keepTips(tips) });
  }
  if (log && t.note) log(`update: ${t.note}`);
  const notes = t.note ? [t.note] : [];
  if (t.commit === src.commit) return { status: 'up_to_date', code: 0, lines: ['arnés al día', ...notes] };
  const cmp = VO.compare(t.version, src.version);
  if (cmp === null) {
    if (!t.version) return { status: 'blocked', code: 2, lines: [`harness.js update: la punta de ${t.ref} (${sha7(t.commit)}) no trae version.json: no sé si es más nueva que ${src.version}`, ...notes] };
    return { status: 'blocked', code: 2, lines: [`harness.js update: no puedo ordenar ${t.version} contra ${src.version}: ninguna versión se aplica sin número`, ...notes] };
  }
  if (cmp === 0) return { status: 'up_to_date', code: 0, lines: [`arnés al día (${src.version}; la punta de ${t.ref} tiene el mismo número en otro commit, ${sha7(t.commit)})`, ...notes] };
  if (cmp < 0) return { status: 'older', code: 0, lines: [`lo publicado en ${t.ref} (${t.version}) es más viejo que lo instalado (${src.version}): no se baja`, ...notes] };
  return { status: 'new', code: 3, lines: [`hay versión nueva: ${src.version} → ${t.version} (${t.ref} ${sha7(t.commit)})`, ...notes], target: t };
}
const repo = (src) => src.repo || (githubRepoOf(src.url) ? `${githubRepoOf(src.url).org}/${githubRepoOf(src.url).name}` : null);

/**
 * Ubica el commit de un número pedido a mano (`install --version <n>`): los commits recientes de la ref que tocaron
 * version.json (un pedido), leyendo el version.json de cada uno del más nuevo al más viejo hasta el que coincide.
 */
function locateVersion(c, repoName, ref, number) {
  const r = c.get(`/repos/${repoName}/commits?sha=${encodeURIComponent(ref)}&path=version.json&per_page=${LOCATE_PAGE}`);
  if (!r.ok || r.status !== 200 || !Array.isArray(r.json)) return Object.assign({ ok: false }, explainFailure(c, r, { what: 'la lista de commits' }));
  const seen = [];
  for (const entry of r.json) {
    if (!entry || typeof entry.sha !== 'string') continue;
    const v = versionAt(c, repoName, entry.sha);
    if (!v.ok) return v;
    if (v.absent) continue;
    seen.push(v.version);
    if (v.version === number) return { ok: true, commit: entry.sha, version: number };
  }
  const range = seen.length ? `entre ${seen[seen.length - 1]} y ${seen[0]} (${seen.length} versiones)` : 'ninguna versión con número en esa ref';
  return { ok: false, status: 'blocked', reason: `la versión ${number} no está en ${ref}: busqué ${range}` };
}

// ── bajar y verificar ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Baja el comprimido DEL COMMIT, lo recorre con el lector propio, verifica el árbol y deja la versión armada en
 * `incoming/<versión>/` con su manifiesto. `{ ok, dir, manifest }` o `{ ok: false, status, reason }` sin dejar nada.
 */
function download(ctx, c, repoName, { commit, version, ref, log = null }) {
  const own = TH.ownPaths({ env: ctx.env });
  // el nombre de la carpeta sale del número publicado, que tiene forma fija: otra cosa no se usa como ruta
  if (version && !VO.isOrdered(version)) return { ok: false, status: 'blocked', reason: `la versión «${version}» no tiene la forma YYYY.MM.DD.N: no se instala una versión sin número` };
  const dir = path.join(own.incoming, version || sha7(commit));
  const meta = c.get(`/repos/${repoName}/git/commits/${commit}`);
  if (!meta.ok || meta.status !== 200 || !meta.json || !meta.json.tree || typeof meta.json.tree.sha !== 'string') return Object.assign({ ok: false }, explainFailure(c, meta, { what: `el commit ${sha7(commit)}` }));
  const expectedTree = meta.json.tree.sha;
  const tarBudget = Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) > 0 ? Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) : TARBALL_BUDGET_S_DEFAULT;
  // sin permiso, de codeload (story 8.34): el mismo archivo al que redirigía la API, sin gastar una consulta
  const tar = c.public
    ? c.getPublic(PG.tarUrl(c.public, repoName, commit), { maxBytes: MAX_TARBALL_BYTES, timeoutMs: tarBudget * 1000 })
    : c.get(`/repos/${repoName}/tarball/${commit}`, { maxBytes: MAX_TARBALL_BYTES, timeoutMs: tarBudget * 1000 });
  if (!tar.ok || tar.status !== 200) return Object.assign({ ok: false }, explainFailure(c, tar, { what: 'el comprimido' }));
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, status: 'blocked', reason: `no pude preparar ${dir}: ${e.message}` }; }
  const TR = lib('tar-reader.js');
  const x = TR.extractTarGz(tar.body, dir, { stripRoot: true });
  if (!x.ok) { fs.rmSync(dir, { recursive: true, force: true }); return { ok: false, status: 'blocked', reason: `el comprimido de ${sha7(commit)} no se instala: ${x.reason}` }; }
  const got = TR.treeOf(x.manifest);
  if (got !== expectedTree) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, status: 'blocked', reason: `lo bajado no coincide con el commit ${sha7(commit)}: el árbol calculado es ${sha7(got)} y el del commit ${sha7(expectedTree)} — no instalo nada` };
  }
  // el número con el que se nombra la versión sale de algo verificado (story 8.34, decisión 5): el version.json del árbol
  // verificado tiene que decir el número que se dio (el del raw, o el de la API)
  if (version) {
    let inTree = null;
    try { inTree = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8').replace(/^\uFEFF/, '')).version || null; } catch (_) { inTree = null; }
    if (inTree !== version) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, status: 'blocked', reason: `el número publicado (${version}) no coincide con el del árbol verificado de ${sha7(commit)} (${inTree || 'sin version.json'}) — no instalo nada` };
    }
  }
  const manifest = { schema: 1, repo: repoName, ref, commit, tree: expectedTree, version, downloaded_at: nowIso(), files: x.manifest };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 1)}\n`);
  if (log) log(`release: ${version || sha7(commit)} bajada y verificada en ${dir} (${x.manifest.length} archivos, árbol ${sha7(expectedTree)})`);
  return { ok: true, dir, manifest };
}

/** El manifiesto de una carpeta de versión (`harness/`, `previous/`, `incoming/<v>/`), o null. */
function readManifest(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')); return isObject(j) && Array.isArray(j.files) ? j : null; } catch (_) { return null; }
}

// ── las skills de terceros, desde la caché (AC 12) ───────────────────────────────────────────────────────────────
/**
 * Los destinos `download` del manifiesto de terceros del árbol que hay que reponer: los que NO están en el disco y, cuando
 * la caché de la bajada tiene su manifiesto, los que están con OTRO contenido (archivo por archivo, por hash; los modos
 * no cuentan: no viajan a Windows). Sin caché, un contenido distinto no se puede saber sin red: sólo lo que falta.
 */
function missingThirdParty(tree, own = null) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'publishing', 'third-party-skills.json'), 'utf8')); } catch (_) { return []; }
  const origins = isObject(raw.origins) ? raw.origins : {};
  const entries = (raw.thirdParty || raw.third_party || []).filter((e) => isObject(e) && e.install === 'download' && typeof e.target === 'string')
    .map((e) => Object.assign({}, e, { commit: e.commit !== undefined ? e.commit : (e.from && isObject(origins[e.from]) ? origins[e.from].commit : undefined) }));
  const GH = lib('git-tree-hash.js');
  const out = [];
  for (const e of entries) {
    const dest = path.join(tree, ...e.target.split('/'));
    if (!exists(dest)) { out.push(e.target); continue; }
    if (!own || !e.commit) continue;
    const m = readManifest(path.join(own.thirdParty, String(e.commit).slice(0, 12), String(e.target).replace(/[\\/]/g, '__')));
    if (!m || !Array.isArray(m.files) || m.tree !== e.tree) continue;
    const want = m.files.map((f) => `${f.path}\t${f.blob}`).sort().join('\n');
    const got = [];
    const walk = (d, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const it of ents) {
        const r = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) walk(path.join(d, it.name), r);
        else if (it.isFile()) { try { got.push(`${r}\t${GH.blobSha(fs.readFileSync(path.join(d, it.name)))}`); } catch (_) { got.push(`${r}\t?`); } }
        else got.push(`${r}\t?`);
      }
    };
    walk(dest, '');
    if (got.sort().join('\n') !== want) out.push(e.target);
  }
  return out;
}

/**
 * Restituye en `incomingDir` las skills de terceros que el manifiesto de ESA versión declara `download`: desde
 * `~/.tycon/third-party/<commit>/<destino>/` si la caché da el árbol declarado (sin red); si no, bajando el comprimido
 * del origen en su commit por la API, verificando el árbol y guardándolo en la caché. Lo que no se pudo queda dicho y
 * la versión se instala igual (el aplicador lo cuenta como pendiente). Nunca tira.
 */
function restoreThirdParty(ctx, c, incomingDir, { log = null, only = null } = {}) {
  const notes = [];
  let manifest;
  const manifestFile = path.join(incomingDir, 'scripts', 'publishing', 'third-party-skills.json');
  if (!exists(manifestFile)) return { notes: [] };   // una versión sin manifiesto de terceros: nada que restituir
  try {
    // con su lector si la versión lo trae (valida la forma); si no, el JSON tal cual (la forma la valida el aplicador)
    const covFile = path.join(incomingDir, 'scripts', 'publishing', 'third-party-coverage.js');
    manifest = exists(covFile) ? require(covFile).loadManifest(manifestFile) : JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^﻿/, ''));
    if (!isObject(manifest)) throw new Error('no es un objeto');
  } catch (e) { return { notes: [`skills de terceros: no pude leer su manifiesto (${e.message}): quedan para el aplicador`] }; }
  const TR = lib('tar-reader.js');
  const GH = lib('git-tree-hash.js');
  const own = TH.ownPaths({ env: ctx.env });
  // el manifiesto crudo escribe `third_party` y cada entrada hereda origen y commit de su bloque `origins` (campo `from`);
  // su lector (loadManifest) ya lo resuelve y lo renombra a `thirdParty`: se aceptan los dos, resolviendo lo crudo igual
  const origins = isObject(manifest.origins) ? manifest.origins : {};
  const resolved = (e) => { const base = e.from && isObject(origins[e.from]) ? origins[e.from] : {}; return Object.assign({}, e, { origin: e.origin !== undefined ? e.origin : base.origin, commit: e.commit !== undefined ? e.commit : base.commit }); };
  const rawEntries = Array.isArray(manifest.thirdParty) ? manifest.thirdParty : Array.isArray(manifest.third_party) ? manifest.third_party.map((e) => (isObject(e) ? resolved(e) : e)) : [];
  // la forma de cada entrada ANTES de usarla para borrar o escribir (revisor de seguridad de la tanda G de la 8.23): un destino
  // relativo, sin `..` ni segmentos vacíos, que quede dentro del árbol; un commit de 40 hexadecimales. Lo que no cumple se
  // dice y no se toca (el manifiesto publicado está verificado, pero este código escribe también en el árbol en uso).
  // `only` (tanda G): sólo esos destinos — la actualización al día repone lo que FALTA, no vuelve a copiar todo
  const SHA40 = /^[0-9a-f]{40}$/i;
  const saneTarget = (t) => typeof t === 'string' && t && !path.isAbsolute(t) && !t.includes('\\') && !t.includes('\0')
    && !t.split('/').some((s) => s === '' || s === '.' || s === '..' || s === '.git')
    && path.resolve(incomingDir, t).startsWith(`${path.resolve(incomingDir)}${path.sep}`);
  const notes0 = [];
  const entries = rawEntries.filter((x) => isObject(x) && x.install === 'download').filter((x) => {
    if (!saneTarget(x.target)) { notes0.push(`skills de terceros: la entrada ${JSON.stringify(x.target)} no es un destino dentro del árbol: no se toca`); return false; }
    if (!SHA40.test(String(x.commit || ''))) { notes0.push(`skills de terceros: ${x.target}: el commit ${JSON.stringify(x.commit)} no tiene forma de sha: no se toca`); return false; }
    if (only && !only.includes(x.target)) return false;
    return true;
  });
  // un comprimido por origen@commit, no por entrada (BMAD trae 30 skills del mismo commit): `{ body }` o `{ failure }`
  const downloads = new Map();
  const byFailure = new Map();
  const failed = (why, target) => { if (!byFailure.has(why)) byFailure.set(why, []); byFailure.get(why).push(target); };
  const tarballOf = (e) => {
    const origin = githubRepoOf(e.origin);
    if (!origin) return { failure: `el origen ${e.origin} no es un repo de GitHub` };
    const key = `${origin.org}/${origin.name}@${e.commit}`;
    if (!downloads.has(key)) {
      // sin permiso, de codeload (story 8.34); su verificación contra el árbol declarado no cambia
      const tar = c.public
        ? c.getPublic(PG.tarUrl(c.public, `${origin.org}/${origin.name}`, e.commit), { maxBytes: MAX_TARBALL_BYTES, timeoutMs: TARBALL_BUDGET_S_DEFAULT * 1000 })
        : c.get(`/repos/${origin.org}/${origin.name}/tarball/${e.commit}`, { maxBytes: MAX_TARBALL_BYTES, timeoutMs: TARBALL_BUDGET_S_DEFAULT * 1000 });
      downloads.set(key, tar.ok && tar.status === 200 ? { body: tar.body } : { failure: explainFailure(c, tar, { what: 'su origen', probeUser: false }).reason });
    }
    return downloads.get(key);
  };
  /** La caché sirve si el árbol de lo que tiene, RECALCULADO archivo por archivo, es el declarado (no lo que dice su manifiesto). */
  const cacheGood = (cacheDir, e) => {
    const m = readManifest(cacheDir);
    if (!m || !Array.isArray(m.files)) return null;
    const listing = [];
    for (const f of m.files) {
      let buf;
      try { buf = fs.readFileSync(path.join(cacheDir, ...f.path.split('/'))); } catch (_) { return null; }
      listing.push({ mode: f.mode, path: f.path, sha: GH.blobSha(buf) });
    }
    return GH.treeSha(listing) === e.tree ? m.files : null;
  };
  const copyFiles = (fromDir, files, dest) => {
    fs.rmSync(dest, { recursive: true, force: true });
    for (const f of files) {
      const to = path.join(dest, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(fromDir, ...f.path.split('/')), to);
      if (process.platform !== 'win32' && f.mode === '100755') { try { fs.chmodSync(to, 0o755); } catch (_) { /* nada */ } }
    }
  };
  for (const e of entries) {
    const dest = path.join(incomingDir, ...String(e.target).split('/'));
    const cacheDir = path.join(own.thirdParty, String(e.commit).slice(0, 12), String(e.target).replace(/[\\/]/g, '__'));
    try {
      const cached = cacheGood(cacheDir, e);
      if (cached) { copyFiles(cacheDir, cached, dest); if (log) log(`release: terceros: ${e.target} desde la caché (${sha7(e.tree)})`); continue; }
      const tar = tarballOf(e);
      if (tar.failure) { failed(tar.failure, e.target); continue; }
      // sólo la subcarpeta de la skill: lo demás del repo de origen (enlaces incluidos) no se juzga ni se escribe
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-third-party-'));
      const x = TR.extractTarGz(tar.body, tmp, { stripRoot: true, only: e.path || null });
      if (!x.ok) { fs.rmSync(tmp, { recursive: true, force: true }); notes.push(`skills de terceros: ${e.target}: ${x.reason}`); continue; }
      const prefix = e.path ? `${String(e.path).replace(/\/+$/, '')}/` : '';
      const omit = (e.omit || []).map((o) => (typeof o === 'string' ? o : o.file));
      const fixes = new Map((e.mode_fixes || []).map((f) => [f.file, f.mode]));
      const files = x.manifest.filter((m) => m.path.startsWith(prefix)).map((m) => ({ path: m.path.slice(prefix.length), mode: m.mode, blob: m.blob }))
        .filter((m) => !omit.some((f) => m.path === f || m.path.startsWith(`${f}/`)))
        .map((m) => (fixes.has(m.path) ? Object.assign({}, m, { mode: fixes.get(m.path) }) : m));
      const tree = GH.treeSha(files.map((m) => ({ mode: m.mode, path: m.path, sha: m.blob })));
      if (tree !== e.tree) { fs.rmSync(tmp, { recursive: true, force: true }); notes.push(`skills de terceros: ${e.target}: lo que trae el origen no da el árbol declarado (${sha7(tree)} ≠ ${sha7(e.tree)}); queda para el aplicador`); continue; }
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
      copyFiles(path.join(tmp, ...prefix.split('/').filter(Boolean)), files, cacheDir);
      fs.writeFileSync(path.join(cacheDir, MANIFEST_NAME), `${JSON.stringify({ schema: 1, origin: e.origin, commit: e.commit, tree: e.tree, files }, null, 1)}\n`);
      fs.rmSync(tmp, { recursive: true, force: true });
      copyFiles(cacheDir, files, dest);
      if (log) log(`release: terceros: ${e.target} bajada de ${e.origin} (${sha7(e.commit)}) y guardada en la caché`);
    } catch (err) { notes.push(`skills de terceros: ${e.target}: ${err.message}; queda para el aplicador`); }
  }
  // un mismo motivo (el origen no se ve, sin red) se dice UNA vez con cuántas skills alcanza, no setenta veces
  for (const [why, targets] of byFailure) notes.push(`skills de terceros: ${targets.length} skill(s) no se pudieron bajar (${targets.slice(0, 3).join(', ')}${targets.length > 3 ? ', …' : ''}): ${why}; las repone harness.js update cuando haya red`);
  return { notes: [...notes0, ...notes] };
}

// ── el cambio con diario (AC 12, 13, 14) ─────────────────────────────────────────────────────────────────────────

// un sello único por carpeta apartada: dos cambios en el mismo segundo (las pruebas, una máquina rápida) no pueden chocar
// en `trash/` — el `rename` sobre una carpeta que ya existe falla, y la actualización «esperaría» sin motivo
let stampSeq = 0;
const stamp = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${process.pid}-${(++stampSeq).toString(36)}`;
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* sin espera */ } };
/** `rename` con tres reintentos ante EPERM/EACCES/EBUSY/ENOTEMPTY (Windows: un archivo tomado). `{ ok, reason }`. */
function renameRetry(from, to) {
  let last = null;
  for (let i = 1; i <= 3; i++) {
    try { fs.renameSync(from, to); return { ok: true }; } catch (e) {
      last = e;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(e.code) || i === 3) break;
      nap(150 * i);
    }
  }
  return { ok: false, reason: `${last.code || last.message}: ${from} → ${to}` };
}
function writeJournal(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(Object.assign({ schema: 1 }, data), null, 2)}\n`); fs.renameSync(tmp, file); }
function readJournal(file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return isObject(j) && typeof j.stage === 'string' ? j : null; } catch (_) { return null; } }

// ── el cambio con ENLACES (story 8.33): Windows, y las pruebas de Mac con TYCON_RELEASE_LINKS=1 ─────────────────────
// `harness` y `previous` son enlaces (uniones en Windows) a `versions/<v>/`. Cambiar de versión, volver atrás y reparar
// cambian ENLACES; ninguna carpeta de versión se renombra después de armada, así que una carpeta tomada por otra sesión
// o por VS Code no frena nada (182 #13451: la unión se cambia con su destino tomado). El diario es otro archivo
// (`link-swap.json`): la copia fija de antes de esta story borra `swap.json` si `harness` existe, y lo perdería.
// Regla de la reparación: un cambio cortado vuelve los dos enlaces a donde estaban (el estado todavía dice esa versión).

const linksOn = (ctx) => TH.linksMode({ env: ctx.env });
// el número del manifiesto da el nombre de una carpeta que después se puede borrar: sólo un número publicado, nunca algo
// con separadores (revisor de seguridad: `../` en un manifiesto ajeno)
const versionOfDir = (dir) => { const m = readManifest(dir); return m && m.version && VO.isOrdered(String(m.version)) ? String(m.version) : null; };
// la misma carpeta: por su ruta real si existe, y sin distinguir mayúsculas en Windows (pase adversarial, clase 2: una
// casa escrita con otra caja, o /tmp y /private/tmp, hacía parecer libre la versión en uso y la limpieza la borraba)
const canon = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch (_) { /* no está: tal cual */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
const sameDir = (a, b) => Boolean(a && b) && canon(a) === canon(b);
// el mismo NOMBRE (sin seguir enlaces): para validar lo que nombra un diario
const plain = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const sameName = (a, b) => Boolean(a && b) && typeof a === 'string' && typeof b === 'string' && plain(a) === plain(b);
/** ¿`p` es una carpeta DENTRO de `versions/` (un hijo directo)? Lo que el diario nombra se valida con esto antes de usarlo. */
const inVersions = (own, p) => Boolean(p) && typeof p === 'string' && sameName(path.dirname(path.resolve(p)), own.versions);
/** Las carpetas de `versions/` que un enlace usa hoy (`harness`, `previous`). */
function linkedVersions(own) { return [TH.linkTarget(own.harness), TH.linkTarget(own.previous)].filter(Boolean); }
/**
 * Una carpeta libre en `versions/` para la versión `v`. Si ya hay una con ese número y ningún enlace la usa, es un resto
 * (una conversión trabada, un cambio cortado): se saca. Si no se puede sacar (tomada) o un enlace la usa, va con sello.
 */
function freeVersionDir(ctx, own, v) {
  const base = path.join(own.versions, String(v || 'sin-numero'));
  if (!exists(base)) return base;
  // como la limpieza (D6, pase adversarial clase 3): primero se APARTA a trash/ —en Windows falla entera si algo la tiene
  // abierta, así nunca se borra a medias una versión en uso—, y lo que una pieza nombra no se toca
  if (!linkedVersions(own).some((t) => sameDir(t, base)) && !isNamed(ctx, base)) {
    try {
      fs.mkdirSync(own.trash, { recursive: true });
      const aside = path.join(own.trash, `${path.basename(base)}-${stamp()}`);
      if (renameRetry(base, aside).ok) { try { fs.rmSync(aside, { recursive: true, force: true }); } catch (_) { /* queda en trash/: la limpieza */ } }
    } catch (_) { /* tomada: va con sello */ }
    if (!exists(base)) return base;
  }
  return `${base}-${stamp()}`;
}
/** Vuelve los dos enlaces a donde estaban según un diario; un `harness_was` ausente (la primera instalación) va al destino. */
function restoreLinks(own, j) {
  // lo que el diario nombra tiene que estar en versions/: un diario ajeno no hace apuntar nada fuera de ~/.tycon (seguridad)
  const bad = ['harness_was', 'previous_was', 'dest'].filter((k) => j[k] && !inVersions(own, j[k]));
  if (bad.length) return { ok: false, reason: `el diario nombra rutas fuera de ${own.versions} (${bad.join(', ')}): no lo uso` };
  const fix = (name, was) => {
    if (was && exists(was)) { if (!sameDir(TH.linkTarget(name), was)) TH.pointLink(name, was); }
    else if (TH.isLink(name)) TH.removeLink(name);
  };
  try {
    if (!j.harness_was && j.dest && exists(j.dest)) { if (!sameDir(TH.linkTarget(own.harness), j.dest)) TH.pointLink(own.harness, j.dest); }
    else fix(own.harness, j.harness_was);
    fix(own.previous, j.previous_was);
    for (const t of [...TH.strayTempLinks(own.harness), ...TH.strayTempLinks(own.previous)]) TH.removeLink(t);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.code || e.message }; }
}

/**
 * La conversión de una máquina en la forma de hoy (decisión 7 de la 8.33): `harness/` y `previous/` carpetas reales pasan
 * a `versions/<v>/` y su nombre a ser un enlace. Es un `rename` de la carpeta en uso —el mismo que falla con una ventana
 * abierta—, una sola vez por máquina. `{ ok, converted, held?, reason? }`: con `harness/` tomada, `ok: false, held: true`
 * y nada cambió para `harness`. Lo llaman el arranque (cada vez, sin frenar nada) y el cambio de versión.
 */
function convertLayout(ctx, { log = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  const real = (p) => exists(p) && !TH.isLink(p);
  if (!real(own.harness) && !real(own.previous)) return { ok: true, converted: false };
  if (exists(own.linkJournal)) return { ok: false, reason: `hay un cambio de enlaces a medias (${own.linkJournal}): primero se repara` };
  fs.mkdirSync(own.versions, { recursive: true });
  const moves = [];
  for (const name of [own.harness, own.previous]) {
    if (!real(name)) continue;
    const dest = freeVersionDir(ctx, own, versionOfDir(name));
    moves.push({ name, dest });
    writeJournal(own.linkJournal, { kind: 'convert', stage: 'start', moves, at: nowIso() });
    const r = renameRetry(name, dest);
    if (!r.ok) {
      moves.pop();
      if (moves.length) writeJournal(own.linkJournal, { kind: 'convert', stage: 'moved', moves, at: nowIso() }); else fs.rmSync(own.linkJournal, { force: true });
      if (name === own.harness) {
        if (log) log(`release: conversión a la forma con enlaces: ${own.harness} está tomada (${r.reason}); queda para el próximo arranque`);
        return { ok: false, held: true, reason: `${own.harness} está tomada (${r.reason})` };
      }
      // `previous` tomada con `harness` ya convertida: la conversión queda A MEDIAS y cuenta como TRABADA (pase adversarial,
      // clase 1): con `previous` todavía carpeta no hay a dónde volver, así que no se cambia de versión hasta que las dos
      // sean enlaces. `harness` ya convertida queda así (es la misma versión); el arranque siguiente reintenta `previous`
      fs.rmSync(own.linkJournal, { force: true });
      if (log) log(`release: conversión: ${own.previous} está tomada (${r.reason}); queda como carpeta hasta el próximo arranque`);
      return { ok: false, held: true, partial: true, reason: `${own.previous} está tomada (${r.reason})` };
    }
    writeJournal(own.linkJournal, { kind: 'convert', stage: 'moved', moves, at: nowIso() });
    TH.makeLink(dest, name);
    if (log) log(`release: conversión: ${name} → ${dest} (ahora es un enlace)`);
  }
  fs.rmSync(own.linkJournal, { force: true });
  return { ok: true, converted: moves.length > 0 };
}

/** El cambio con enlaces: `incoming/<v>` → `versions/<v>`, `previous` → donde estaba `harness`, `harness` → la nueva. */
function swapLinks(ctx, { incomingDir, version, log = null }) {
  const own = TH.ownPaths({ env: ctx.env });
  const conv = convertLayout(ctx, { log });
  if (!conv.ok) {
    // la versión no se pierde (AC 10): queda en versions/<v>; la máquina sigue en la de antes
    let kept = null;
    let keptWhy = null;
    try {
      fs.mkdirSync(own.versions, { recursive: true });
      const dest = freeVersionDir(ctx, own, version);
      const mv = renameRetry(incomingDir, dest);
      if (mv.ok) kept = dest; else keptWhy = mv.reason;
    } catch (e) { keptWhy = e.code || e.message; }
    if (!kept && log) log(`release: la versión ${version} no pude dejarla en ${own.versions} (${keptWhy}): queda en ${incomingDir} y se vuelve a bajar`);
    return { ok: false, waiting: true, convert: Boolean(conv.held), reason: conv.reason, kept };
  }
  const harnessWas = TH.linkTarget(own.harness);
  const previousWas = TH.linkTarget(own.previous);
  // lo ajeno dentro de una skill de la lista fija en la versión que deja de ser «anterior» se guarda antes de soltarla
  // (tanda A2c de la 8.25 · AC 36): la limpieza la va a borrar
  const kept = [];
  if (previousWas && !sameDir(previousWas, harnessWas)) {
    try {
      const k = require('./team.js').keepEdited([['previous', previousWas]], path.join(own.root, 'team'), { edited: false, foreign: true });
      if (k.copied.length) kept.push(`guardado en ${k.dir} antes de descartar la versión anterior (estaba dentro de una skill de la lista fija): ${k.copied.join(', ')}`);
      if (k.problems.length) kept.push(`no pude guardar ${k.problems.join(' · ')} antes de descartar la versión anterior: queda en ${previousWas} hasta que la limpieza la borre`);
    } catch (e) { kept.push(`no pude revisar lo ajeno de la versión anterior (${e.message}): queda en ${previousWas} hasta que la limpieza la borre`); }
    for (const l of kept) if (log) log(`release: ${l}`);
  }
  fs.mkdirSync(own.versions, { recursive: true });
  const dest = freeVersionDir(ctx, own, version);
  const base = { kind: 'swap', version, incoming: incomingDir, dest, harness_was: harnessWas, previous_was: previousWas, at: nowIso() };
  writeJournal(own.linkJournal, Object.assign({ stage: 'start' }, base));
  const r = renameRetry(incomingDir, dest);
  if (!r.ok) { fs.rmSync(own.linkJournal, { force: true }); return { ok: false, reason: `no pude poner la versión nueva en ${dest} (${r.reason})` }; }
  writeJournal(own.linkJournal, Object.assign({ stage: 'moved' }, base));
  try {
    // (convertLayout garantiza que `previous` es un enlace o no está: una conversión a medias cuenta como trabada)
    if (harnessWas) TH.pointLink(own.previous, harnessWas);
    writeJournal(own.linkJournal, Object.assign({ stage: 'previous-pointed' }, base));
    TH.pointLink(own.harness, dest);
    writeJournal(own.linkJournal, Object.assign({ stage: 'harness-pointed' }, base));
  } catch (e) {
    const back = restoreLinks(own, base);
    if (back.ok) fs.rmSync(own.linkJournal, { force: true });
    return { ok: false, reason: `no pude cambiar los enlaces (${e.code || e.message})${back.ok ? '; quedó la versión de antes' : '; el arranque siguiente lo repara desde el diario'}` };
  }
  fs.rmSync(own.linkJournal, { force: true });
  if (log) log(`release: ${version}: harness → ${dest}${harnessWas ? `; previous → ${harnessWas}` : ''}`);
  return { ok: true, kept };
}

/** La vuelta con enlaces: `rollback` intercambia los destinos; la salud roja vuelve `harness` y quita `previous`. */
function swapBackLinks(ctx, { log = null, reason = 'rollback' } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  const conv = convertLayout(ctx, { log });
  if (!conv.ok) return { ok: false, reason: `no pude pasar a la forma con enlaces: ${conv.reason}` };
  const harnessWas = TH.linkTarget(own.harness);
  const previousWas = TH.linkTarget(own.previous);
  if (!previousWas || !exists(previousWas)) return { ok: false, reason: 'no hay versión anterior (previous) a la que volver' };
  const base = { kind: 'back', why: reason, harness_was: harnessWas, previous_was: previousWas, at: nowIso() };
  writeJournal(own.linkJournal, Object.assign({ stage: 'start' }, base));
  try {
    TH.pointLink(own.harness, previousWas);
    writeJournal(own.linkJournal, Object.assign({ stage: 'harness-pointed' }, base));
    if (reason === 'rollback' && harnessWas) TH.pointLink(own.previous, harnessWas); else TH.removeLink(own.previous);
  } catch (e) {
    const back = restoreLinks(own, base);
    if (back.ok) fs.rmSync(own.linkJournal, { force: true });
    return { ok: false, reason: `no pude cambiar los enlaces (${e.code || e.message})${back.ok ? '; la actual quedó' : '; el arranque siguiente lo repara desde el diario'}` };
  }
  fs.rmSync(own.linkJournal, { force: true });
  if (log) log(`release: vuelta atrás (${reason}): harness → ${previousWas}; ${reason === 'rollback' ? `previous → ${harnessWas}` : `la deshecha (${harnessWas}) queda para la limpieza`}`);
  return { ok: true, aside: reason === 'rollback' ? own.previous : harnessWas };
}

/** Repara un cambio de enlaces cortado (AC 5). `{ repaired, lines }`; sin `link-swap.json`, nada. */
function repairLinks(ctx, { log = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  if (!exists(own.linkJournal)) return { repaired: false, lines: [] };
  const say = (l) => { if (log) log(`release: reparación: ${l}`); return l; };
  const j = readJournal(own.linkJournal);
  if (!j) return { repaired: false, lines: [say(`el diario ${own.linkJournal} no se puede leer: lo dejo para que alguien lo mire`)] };
  if (j.kind === 'convert') {
    const moves = Array.isArray(j.moves) ? j.moves : [];
    // sólo los dos nombres del arnés, y hacia versions/ (seguridad: un diario ajeno no crea enlaces en otro lado)
    if (moves.some((m) => !m || ![own.harness, own.previous].some((n) => sameName(n, m.name)) || !inVersions(own, m.dest))) {
      return { repaired: false, lines: [say(`el diario ${own.linkJournal} nombra rutas que no son del arnés: lo dejo para que alguien lo mire`)] };
    }
    let done = 0;
    try {
      for (const m of moves) if (!exists(m.name) && exists(m.dest)) { TH.makeLink(m.dest, m.name); done += 1; }
    } catch (e) { return { repaired: false, lines: [say(`no pude completar la conversión a la forma con enlaces (${e.code || e.message}); queda para el próximo arranque`)] }; }
    if (!exists(own.harness)) return { repaired: false, lines: [say(`la conversión quedó a medias y ${own.harness} no está, ni su carpeta movida: harness.js install --version latest la rehace`)] };
    fs.rmSync(own.linkJournal, { force: true });
    return { repaired: true, lines: [say(done ? 'la conversión a la forma con enlaces quedó a medias: se completó' : 'el diario de la conversión no tenía nada a medias: lo saco')] };
  }
  const back = restoreLinks(own, j);
  if (!back.ok) return { repaired: false, lines: [say(`no pude reparar el cambio de versión cortado en «${j.stage}» (${back.reason}); queda para el próximo arranque`)] };
  fs.rmSync(own.linkJournal, { force: true });
  const now = versionOfDir(own.harness) || TH.linkTarget(own.harness) || '—';
  return { repaired: true, lines: [say(`el ${j.kind === 'back' ? 'rollback' : `cambio a ${j.version || '—'}`} quedó a medias en «${j.stage}»: harness volvió a ${now}`)] };
}

/** Días enteros desde una fecha ISO (0 si no se puede leer). */
const daysSince = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : 0; };
const PENDING_SAY_DAYS = 7;   // decisión 9 de la 8.33: el aviso sale cuando la más vieja lleva 7 días sin poder borrarse
// ajuste del dueño (2026-10-14) a la decisión 7: la conversión trabada avisa recién con 3 días o 10 arranques, lo que
// llegue primero (un dev que nunca cierra todo arranca varias veces por día: los 10 arranques llegan antes)
const CONVERT_SAY_DAYS = 3;
const CONVERT_SAY_ATTEMPTS = 10;

/**
 * La limpieza de `versions/` (AC 11): lo que no es destino de `harness` ni de `previous`. Primero se intenta RENOMBRAR a
 * `trash/` —en Windows falla entera si algo la tiene tomada (182 #13451), así nunca se borra a medias una versión en
 * uso—; lo apartado se borra. Lo tomado queda en `state.link_pending` con la fecha en que quedó pendiente; lo nombrado no
 * se toca. Devuelve lo de `cleanupDeferred` más `held` y `oldHeld` (las tomadas de 7 días o más).
 */
function cleanupVersions(ctx, state, out, { log = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  out.held = [];
  out.oldHeld = [];
  // con la conversión pendiente (`harness` todavía es una carpeta), lo que hay en versions/ es la versión que espera a
  // la conversión (AC 10): no se toca hasta que harness sea un enlace
  if (!TH.isLink(own.harness) || (exists(own.previous) && !TH.isLink(own.previous))) return out;
  const linked = linkedVersions(own);
  const pending = isObject(state.link_pending) ? Object.assign({}, state.link_pending) : {};
  const namedBy = {};
  let names = [];
  try { names = fs.readdirSync(own.versions); } catch (_) { names = []; }
  for (const n of names) {
    const dir = path.join(own.versions, n);
    if (linked.some((t) => sameDir(t, dir))) continue;
    const named = isNamed(ctx, dir, { state });
    // (lo nombrado también va a doctor: AC 11 — por el nombre de la versión, como lo pendiente)
    if (named) { namedBy[n] = named; out.kept.push(dir); out.lines.push(`${dir} no se borra: lo nombra ${named}`); continue; }
    try { fs.mkdirSync(own.trash, { recursive: true }); } catch (e) { out.kept.push(dir); out.lines.push(`${dir} queda: no pude crear ${own.trash} (${e.code || e.message})`); continue; }
    const aside = path.join(own.trash, `${n}-${stamp()}`);
    const r = renameRetry(dir, aside);
    if (!r.ok) {
      // (se anota por el NOMBRE de la versión, no por su ruta: el estado no nombra versions/ — decisión 8, AC 4)
      if (!pending[n]) pending[n] = nowIso();
      out.kept.push(dir);
      out.held.push({ dir, since: pending[n], days: daysSince(pending[n]) });
      out.lines.push(`${dir} queda para el próximo arranque (${r.reason}: algún programa la tiene abierta)`);
      continue;
    }
    delete pending[n];
    try { fs.rmSync(aside, { recursive: true, force: true }); out.removed.push(dir); if (log) log(`release: limpieza: ${dir} borrada`); } catch (e) {
      out.removed.push(dir);
      out.lines.push(`${dir} se apartó a ${aside} y se borra en el próximo arranque (${e.code || e.message})`);
    }
  }
  for (const k of Object.keys(pending)) if (!exists(path.join(own.versions, k))) delete pending[k];
  if (Object.keys(pending).length) state.link_pending = pending; else delete state.link_pending;
  if (Object.keys(namedBy).length) state.link_named = namedBy; else delete state.link_named;
  out.oldHeld = out.held.filter((h) => h.days >= PENDING_SAY_DAYS);
  return out;
}

/** El aviso de una versión vieja que no se puede borrar hace 7 días o más (decisión 9). */
function oldHeldText(oldHeld) {
  const h = oldHeld.slice().sort((a, b) => b.days - a.days)[0];
  return `una versión vieja del arnés (${h.dir}) no se puede borrar hace ${h.days} días: algún programa la tiene abierta. Cerrá las otras sesiones de Claude Code y de Codex, y VS Code (si sigue, reiniciá la máquina); se borra sola en el arranque siguiente`;
}
/** El aviso de la conversión trabada (decisión 7): qué pasa, qué cerrar, reiniciar como último recurso, el comando. */
function convertHeldText(own) {
  return `el arnés no se puede actualizar en esta máquina hasta pasar a la forma nueva, y una de sus carpetas (${own.harness} o ${own.previous}) está en uso. Cerrá las otras sesiones de Claude Code y de Codex, y VS Code, y en una terminal suelta corré: node "${path.join(own.harness, 'scripts', 'setup', 'harness.js')}" update --yes. Si sigue trabado, reiniciá la máquina y corrélo antes de abrir nada. Pasa una sola vez por máquina`;
}

/**
 * El cambio: `incoming/<v>` pasa a ser `harness/`, y `harness/` a `previous/`, con el diario escrito antes de cada paso.
 * `{ ok: true }` · `{ ok: false, waiting: true, reason }` (una `previous/` que no se pudo apartar: la actualización
 * espera) · `{ ok: false, reason }` (algo que el arranque siguiente repara desde el diario).
 * En la forma con enlaces (Windows), el cambio es `swapLinks`.
 */
function swap(ctx, { incomingDir, version, log = null }) {
  if (linksOn(ctx)) return swapLinks(ctx, { incomingDir, version, log });
  const own = TH.ownPaths({ env: ctx.env });
  const journal = own.journal;
  const base = { incoming: incomingDir, version, at: nowIso(), harness: own.harness, previous: own.previous };
  writeJournal(journal, Object.assign({ stage: 'start' }, base));
  // lo ajeno dentro de una skill de la lista fija en previous/ (una spec escrita ahí por error) se guarda en
  // ~/.tycon/team/kept-…/previous/ ANTES de mandarla a trash/, y la salida lo nombra (tanda A2c · AC 36); nunca frena el cambio
  const kept = [];
  if (exists(own.previous)) {
    try {
      const k = require('./team.js').keepEdited([['previous', own.previous]], path.join(own.root, 'team'), { edited: false, foreign: true });
      if (k.copied.length) kept.push(`guardado en ${k.dir} antes de descartar la versión anterior (estaba dentro de una skill de la lista fija): ${k.copied.join(', ')}`);
      if (k.problems.length) kept.push(`no pude guardar ${k.problems.join(' · ')} antes de descartar la versión anterior: queda en ${own.trash} hasta el próximo arranque sano`);
    } catch (e) { kept.push(`no pude revisar lo ajeno de la versión anterior (${e.message}): queda en ${own.trash} hasta el próximo arranque sano`); }
    for (const l of kept) if (log) log(`release: ${l}`);
  }
  if (exists(own.previous)) {
    fs.mkdirSync(own.trash, { recursive: true });
    const aside = path.join(own.trash, `previous-${stamp()}`);
    const r = renameRetry(own.previous, aside);
    if (!r.ok) {
      fs.rmSync(journal, { force: true });
      return { ok: false, waiting: true, reason: `la versión anterior (${own.previous}) no se puede apartar (${r.reason}): un archivo está tomado; la actualización espera al próximo arranque` };
    }
    if (log) log(`release: la previous/ vieja se apartó a ${aside} (se borra en el arranque siguiente)`);
  }
  writeJournal(journal, Object.assign({ stage: 'previous-cleared' }, base));
  if (exists(own.harness)) {
    const r1 = renameRetry(own.harness, own.previous);
    if (!r1.ok) { fs.rmSync(journal, { force: true }); return { ok: false, waiting: true, reason: `no pude apartar la versión activa (${r1.reason}): un archivo está tomado; la actualización espera al próximo arranque` }; }
  }
  writeJournal(journal, Object.assign({ stage: 'harness-out' }, base));
  const r2 = renameRetry(incomingDir, own.harness);
  if (!r2.ok) {
    // vuelve lo que se movió; el diario queda hasta que se pueda (el arranque lo repara igual)
    const back = exists(own.previous) && !exists(own.harness) ? renameRetry(own.previous, own.harness) : { ok: true };
    if (back.ok) fs.rmSync(journal, { force: true });
    return { ok: false, reason: `no pude poner la versión nueva en su lugar (${r2.reason})${back.ok ? '; la anterior volvió' : '; el arranque siguiente lo repara desde el diario'}` };
  }
  writeJournal(journal, Object.assign({ stage: 'done' }, base));
  fs.rmSync(journal, { force: true });
  if (log) log(`release: ${version}: incoming → harness; la anterior en previous/`);
  return { ok: true, kept };
}

/**
 * La vuelta del cambio, con el mismo diario. `rollback` (AC 15) INTERCAMBIA `harness/` y `previous/`: la deshecha queda
 * en `previous/`, así un segundo `rollback` la deshace. Una salud roja (`reason: 'failed'`) manda la versión rota a
 * `trash/` y vuelve `previous/` a `harness/`: lo roto no se guarda como «anterior».
 */
function swapBack(ctx, { log = null, reason = 'rollback' } = {}) {
  if (linksOn(ctx)) return swapBackLinks(ctx, { log, reason });
  const own = TH.ownPaths({ env: ctx.env });
  if (!exists(own.previous)) return { ok: false, reason: 'no hay versión anterior (previous/) a la que volver' };
  const journal = own.journal;
  const base = { incoming: null, version: null, at: nowIso(), harness: own.harness, previous: own.previous, why: reason };
  fs.mkdirSync(own.trash, { recursive: true });
  // la activa se aparta: a trash/ si está rota; a un lugar de paso dentro de trash/ si es un rollback (vuelve como previous/)
  const aside = path.join(own.trash, `${reason === 'rollback' ? 'swapping' : 'failed'}-${stamp()}`);
  writeJournal(journal, Object.assign({ stage: 'back-start', aside }, base));
  if (exists(own.harness)) {
    const r1 = renameRetry(own.harness, aside);
    if (!r1.ok) { fs.rmSync(journal, { force: true }); return { ok: false, reason: `no pude apartar la versión activa (${r1.reason})` }; }
  }
  writeJournal(journal, Object.assign({ stage: 'back-harness-out', aside }, base));
  const r2 = renameRetry(own.previous, own.harness);
  if (!r2.ok) {
    const undo = renameRetry(aside, own.harness);
    if (undo.ok) fs.rmSync(journal, { force: true });
    return { ok: false, reason: `no pude volver a la versión anterior (${r2.reason})${undo.ok ? '; la actual quedó' : '; el arranque siguiente lo repara desde el diario'}` };
  }
  if (reason === 'rollback') {
    writeJournal(journal, Object.assign({ stage: 'back-previous-in', aside }, base));
    const r3 = renameRetry(aside, own.previous);
    if (!r3.ok) { if (log) log(`release: la deshecha no pudo quedar como previous/ (${r3.reason}): queda en ${aside}`); }
  }
  fs.rmSync(journal, { force: true });
  if (log) log(`release: vuelta atrás (${reason}): previous → harness; lo deshecho ${reason === 'rollback' ? 'en previous/' : `en ${aside}`}`);
  return { ok: true, aside: reason === 'rollback' ? own.previous : aside };
}

/**
 * Repara un cambio cortado a mitad desde el diario (AC 13). Lo llaman el arranque, bootstrap.js y, en shell, los
 * respaldos. `{ repaired: boolean, lines }`. Sin diario, nada.
 */
function repair(ctx, { log = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  // el diario de los enlaces (story 8.33) primero; después, el de carpetas, como siempre
  const rl = repairLinks(ctx, { log });
  if (exists(own.linkJournal)) return rl;
  const j = readJournal(own.journal);
  if (!j) return rl;
  const say = (l) => { if (log) log(`release: reparación: ${l}`); return l; };
  const lines = [];
  const done = () => { fs.rmSync(own.journal, { force: true }); return { repaired: true, lines }; };
  switch (j.stage) {
    case 'start': case 'previous-cleared':
      // la etapa se escribe ANTES del rename harness → previous: un corte justo después deja harness/ ausente con la
      // etapa vieja (pase adversarial de la B). Si harness/ no está, se completa igual que en «harness-out»
      if (exists(own.harness)) { lines.push(say(`el diario quedó en «${j.stage}» con harness/ en su lugar: lo saco`)); return done(); }
    // falls through
    case 'harness-out':
      if (!exists(own.harness) && j.incoming && exists(j.incoming)) {
        const r = renameRetry(j.incoming, own.harness);
        lines.push(say(r.ok ? `el cambio a ${j.version} se completó (incoming → harness)` : `no pude completar el cambio (${r.reason}); queda para el próximo arranque`));
        return r.ok ? done() : { repaired: false, lines };
      }
      if (!exists(own.harness) && exists(own.previous)) {
        const r = renameRetry(own.previous, own.harness);
        lines.push(say(r.ok ? `el cambio a ${j.version} se deshizo (la versión nueva no estaba): previous → harness` : `no pude deshacer el cambio (${r.reason})`));
        return r.ok ? done() : { repaired: false, lines };
      }
      lines.push(say('harness/ ya está en su lugar: el diario se saca'));
      return done();
    case 'done':
      lines.push(say('el diario quedó en «done»: lo saco'));
      return done();
    case 'back-start': case 'back-harness-out':
      if (!exists(own.harness) && exists(own.previous)) {
        const r = renameRetry(own.previous, own.harness);
        lines.push(say(r.ok ? 'la vuelta atrás se completó (previous → harness)' : `no pude completar la vuelta atrás (${r.reason})`));
        if (r.ok && j.why === 'rollback' && j.aside && exists(j.aside)) renameRetry(j.aside, own.previous);
        return r.ok ? done() : { repaired: false, lines };
      }
      if (!exists(own.harness) && j.aside && exists(j.aside)) {
        const r = renameRetry(j.aside, own.harness);
        lines.push(say(r.ok ? 'la vuelta atrás se deshizo (la anterior no estaba): la activa volvió' : `no pude recuperar la versión activa (${r.reason})`));
        return r.ok ? done() : { repaired: false, lines };
      }
      lines.push(say('harness/ ya está en su lugar: el diario se saca'));
      return done();
    case 'back-previous-in':
      // la vuelta del rollback ya volvió previous/ a harness/; falta que la deshecha quede como previous/
      if (!exists(own.previous) && j.aside && exists(j.aside)) {
        const r = renameRetry(j.aside, own.previous);
        lines.push(say(r.ok ? 'la deshecha quedó como previous/' : `la deshecha no pudo quedar como previous/ (${r.reason}); queda en ${j.aside}`));
      } else lines.push(say('la vuelta atrás ya estaba completa: el diario se saca'));
      return done();
    default:
      lines.push(say(`diario con una etapa que no conozco («${j.stage}»): lo dejo para que alguien lo mire`));
      return { repaired: false, lines };
  }
}

/**
 * ¿Alguna pieza de la máquina nombra esta carpeta? (el estado, settings.json, hooks.json, el plist, la tarea del examen)
 * Con `state`, el estado se mira en memoria y SIN su lista de pendientes de limpiar (8.33): que la limpieza anote una
 * versión como pendiente no la vuelve «nombrada».
 */
/**
 * ¿`text` nombra la carpeta en alguna de sus `forms`? Como RUTA ENTERA: lo que sigue no puede seguir el nombre (pase
 * adversarial de la 8.33, clase 4: `versions/2026.10.14.1` está adentro de `versions/2026.10.14.18`, y la .1 quedaba
 * «nombrada» para siempre).
 */
function namesDir(text, forms) {
  // en Windows una ruta se escribe con cualquier caja: se compara sin ella
  if (process.platform === 'win32') { text = text.toLowerCase(); forms = forms.map((x) => x.toLowerCase()); }
  for (const x of forms) {
    let i = text.indexOf(x);
    while (i !== -1) {
      if (!/[0-9A-Za-z._~-]/.test(text.charAt(i + x.length))) return true;
      i = text.indexOf(x, i + 1);
    }
  }
  return false;
}
function isNamed(ctx, dir, { state = null } = {}) {
  const H = ctx.home || os.homedir();
  // la carpeta como se la pidió y por su ruta real: una pieza pudo escribirla con la casa escrita de otra forma (la
  // ruta real, /var y /private/var en Mac) y tiene que contar igual (pase adversarial de la 8.33, clase 2)
  // …y, para una carpeta de versions/, también como se la escribe desde la carpeta del usuario (~/.tycon/versions/<v>):
  // así la nombran los enchufes aunque esta corrida tenga TYCON_HOME escrita de otra forma
  const names = [dir];
  try { names.push(fs.realpathSync(dir)); } catch (_) { /* no está */ }
  if (path.basename(path.dirname(dir)) === 'versions') names.push(path.join(H, TH.OWN_DIR_NAME, 'versions', path.basename(dir)));
  const spell = (d) => [d, JSON.stringify(d).slice(1, -1), d.replace(/\\/g, '/')];
  const allForms = [...new Set(names.flatMap(spell))];
  if (state) {
    const forms0 = allForms;
    const text = JSON.stringify(Object.assign({}, state, { link_pending: undefined }));
    if (namesDir(text, forms0)) return S.paths(H).file;
  }
  const files = [
    ...(state ? [] : [S.paths(H).file]),
    (ctx.env && ctx.env.TYCON_SETTINGS_PATH) || path.join(H, '.claude', 'settings.json'),
    path.join((ctx.env && ctx.env.CODEX_HOME) || path.join(H, '.codex'), 'hooks.json'),
    path.join((ctx.env && ctx.env.CODEX_HOME) || path.join(H, '.codex'), 'config.toml'),
    path.join(H, 'Library', 'LaunchAgents', 'ar.com.tycon.examen-periodico.plist'),
  ];
  // la ruta tal cual, como la escapa JSON (en Windows `C:\\Users\\…`) y con barras normales: un settings.json o un
  // hooks.json la guardan en cualquiera de las tres formas (pase adversarial de la B)
  const forms = allForms;
  for (const f of files) {
    try { const text = fs.readFileSync(f, 'utf8'); if (namesDir(text, forms)) return f; } catch (_) { /* no está */ }
  }
  // en Windows la tarea del examen es una tarea programada, no un archivo: se le pregunta al sistema (si no contesta, no
  // se sabe → la carpeta no se borra en este arranque)
  if (process.platform === 'win32') {
    const r = require('child_process').spawnSync('schtasks', ['/Query', '/FO', 'LIST', '/V'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status !== 0) return 'la tarea programada del examen (schtasks no contestó)';
    if (namesDir(String(r.stdout || ''), allForms)) return 'la tarea programada del examen';
  }
  return null;
}

/**
 * La limpieza diferida (AC 14): en el arranque siguiente a una actualización SANA se borra `trash/*` y lo que quedó en
 * `incoming/` que no es la versión activa. Un archivo tomado queda para el próximo arranque sin frenar nada; una carpeta
 * que alguna pieza nombra no se toca. `{ removed, kept, lines }`.
 */
function cleanupDeferred(ctx, state, { log = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  const out = { removed: [], kept: [], lines: [] };
  if (!state.last_health) return out;
  if (exists(own.journal) || exists(own.linkJournal)) return out;   // un cambio a medias: primero se repara
  const candidates = [];
  try { for (const n of fs.readdirSync(own.trash)) candidates.push(path.join(own.trash, n)); } catch (_) { /* sin trash */ }
  try { for (const n of fs.readdirSync(own.incoming)) candidates.push(path.join(own.incoming, n)); } catch (_) { /* sin incoming */ }
  for (const dir of candidates) {
    const named = isNamed(ctx, dir);
    if (named) { out.kept.push(dir); out.lines.push(`${dir} no se borra: lo nombra ${named}`); continue; }
    try { fs.rmSync(dir, { recursive: true, force: true }); out.removed.push(dir); if (log) log(`release: limpieza: ${dir} borrada`); } catch (e) {
      out.kept.push(dir);
      out.lines.push(`${dir} queda para el próximo arranque (${e.code || e.message}: un archivo está tomado)`);
    }
  }
  // la forma con enlaces (story 8.33): las versiones que ningún enlace usa
  if (linksOn(ctx)) cleanupVersions(ctx, state, out, { log });
  return out;
}

// ── instalar (AC 8) ───────────────────────────────────────────────────────────────────────────────────────────────

/** La fuente `release` del estado. */
function makeSource({ repoInfo, ref, commit, tree, version }) {
  return { name: 'harness', kind: 'release', url: repoInfo.url, repo: repoInfo.repo, ref, rewrites: ref === SYNC_REF, commit, tree, version, previous: null, etags: {} };
}

/**
 * `install --version <número|latest>`: la primera instalación de una máquina sin arnés, bajando la versión. En una
 * máquina con estado `tree` (un clon) sale 2 sin escribir nada. Devuelve `{ code, lines }`.
 */
function cmdInstall(ctx, H) {
  const read = S.read(ctx.home);
  if (read.status === 'ok' && !S.isRelease(read.state)) return { code: 2, lines: [`harness.js install: esta máquina ya tiene el arnés instalado desde un clon (${read.state.tree}); install --version es para una máquina sin arnés. La mudanza del clon a ~/.tycon es migrate --to-home (tanda D de la story 8.23). No escribí nada`] };
  if (read.status !== 'ok' && read.status !== 'missing' && !(read.status === 'tree_missing' && read.state && S.isRelease(read.state))) {
    const f = S.fail(read, { home: ctx.home });
    return { code: f.code, lines: [f.line] };
  }
  // qué herramientas se enchufan (tanda C, AC 21): las de `--tool`, o las detectadas. Antes de la red y de escribir
  // nada: sin ninguna sale 1; un `--tool` que no vale, 2
  // (sobre una máquina ya instalada, lo que estaba enchufado se conserva: `install` nunca desenchufa)
  let tc = H.toolChoice(ctx, ctx.tree, { state: read.status === 'ok' ? read.state : null });
  if (!tc.ok) return { code: tc.code, lines: [`harness.js install: ${tc.line}`] };
  const withClaude = tc.tools.includes('claude');
  // Una máquina que NO enchufa a Claude Code vive entera en la casa propia del arnés (tanda C, AC 22): su estado nace en
  // `~/.tycon/state` y nada se escribe en la carpeta de Claude Code. La regla la lee `tycon-home.js` del disco; acá se
  // decide quién NACE ahí: sin Claude Code y sin estado donde siempre. Al revés —sumarle Claude Code a una máquina que
  // ya vive ahí— hay que esperar a la mudanza: el aplicador en shell tiene el lugar de antes escrito (DEF-8.23-D).
  // una `~/.tycon/state` sin estado adentro es el resto de una instalación cortada (Ctrl-C en «¿Instalo?», proceso
  // matado): no marca nada; se barre antes de decidir dónde nace esta (pase adversarial de la C, clase 7)
  if (TH.dropStaleOwnHome(ctx.home, { log: (l) => log(`install: ${l}`) })) log(`install: ${TH.ownStateDir(ctx.home)} estaba vacía (una instalación cortada): la saqué`);
  const bornInOwnHome = !withClaude && read.status === 'missing' && !TH.livesInOwnHome(ctx.home);
  // Lo que se frena es SUMARLE Claude Code a una máquina que vive en la casa propia SIN él (nació sólo con Codex). Una máquina
  // MUDADA (`migrate --to-home`, story 8.23 D) vive ahí CON Claude Code enchufado —su estado lo dice—: reinstalarla (por ejemplo,
  // para sumarle la capa del equipo con --team) es una reinstalación como cualquier otra. Antes de este arreglo el guardia de
  // la tanda C no distinguía las dos y no había forma de sumarle la capa a una máquina ya mudada (story 8.25, H7 del dueño)
  const ownHomeTools = read.state && Array.isArray(read.state.tools) ? read.state.tools : [];
  if (withClaude && TH.livesInOwnHome(ctx.home) && !ownHomeTools.includes('claude')) {
    return { code: 2, lines: [`harness.js install: esta máquina vive en la casa propia del arnés (${TH.ownStateDir(ctx.home)}) y se instaló sin Claude Code (sólo Codex). Sumarle Claude Code a una máquina así todavía no se puede —la mudanza a ~/.tycon es la de una máquina con clon—; sólo Codex: harness.js install --version ${String(ctx.opts.version || 'latest')} --tool codex. No escribí nada`] };
  }
  /** Lo que esta corrida creó para nacer en la casa propia, deshecho si al final no se instala (nada queda marcado). */
  const undoOwnHome = () => {
    if (!bornInOwnHome) return;
    try { if (!fs.existsSync(path.join(TH.ownStateDir(ctx.home), 'harness-state.json'))) fs.rmSync(TH.ownStateDir(ctx.home), { recursive: true, force: true }); } catch (_) { /* queda la carpeta: la próxima corrida la usa */ }
  };
  // los requisitos del aplicador, sin git (la versión bajada no lo usa). El aplicador es el enchufe de Claude Code: una
  // máquina que sólo enchufa a Codex no lo corre y no necesita lo suyo (bash y python3, o PowerShell 7)
  const missing = withClaude ? H.missingRequirement(ctx, { release: true }) : null;
  if (missing) return { code: 1, lines: [`harness.js install: ${missing}`] };
  const repoInfo = repoOf({ tree: ctx.tree, option: ctx.opts.repo || null });
  if (repoInfo.problem) return { code: 2, lines: [`harness.js install: ${repoInfo.problem}`] };
  // la capa del equipo (story 8.25, A1a): de dónde sale el repo del equipo —`--team`, o el estado que ya lo registró— y su
  // forma, antes de la red y de escribir nada. Se RESUELVE más abajo (paso 1 bis) y se apila después del «¿Instalo?»
  const TEAM = require('./team.js');
  // (también cuando la máquina bajada perdió su árbol —`tree_missing`—: el estado sigue recordando la capa; clase 13 del pase adversarial)
  const teamRepo = TEAM.teamOf({ option: ctx.opts.team, state: (read.status === 'ok' || read.status === 'tree_missing') && read.state ? read.state : null });
  if (teamRepo.problem) return { code: 2, lines: [`harness.js install: ${teamRepo.problem}`] };
  const wanted = String(ctx.opts.version || 'latest').trim();
  if (wanted !== 'latest' && !VO.isOrdered(wanted)) return { code: 2, lines: [`harness.js install: --version tiene que ser latest o un número publicado YYYY.MM.DD.N (dice «${wanted}»)`] };
  const log = (l) => R.log(ctx.home, `install: ${l}`);
  const c = client(ctx);
  if (c.tokenProblem) return { code: 2, lines: [`harness.js install: ${c.tokenProblem}`] };
  // con la capa en GitHub, un 404/401 de la copia nombra los dos repos que el permiso tiene que ver (con la capa en Azure, el
  // permiso de GitHub sigue siendo sólo para la copia)
  const teamSrc = teamRepo.repo ? TEAM.parseTeam(teamRepo.repo) : null;
  if (teamSrc && teamSrc.ok && teamSrc.host === 'github') c.repos = [repoInfo.repo, teamRepo.repo];
  // qué canal rige (la configuración; una máquina nueva: stable + ask)
  const policy = H.policyOf(ctx, ctx.tree);
  const channel = ctx.opts.channel || policy.channel || 'stable';

  // 1. qué commit: la punta del canal, o el número pedido
  let target;
  if (wanted === 'latest') {
    const t = resolveChannel(c, repoInfo.repo, channel);
    if (t.status !== 'ok') return { code: t.status === 'blocked' ? 1 : 2, lines: [`harness.js install: ${t.reason}`] };
    if (!t.version || !VO.isOrdered(t.version)) return { code: 2, lines: [`harness.js install: la punta de ${t.ref} (${sha7(t.commit)}) ${t.version ? `trae un número sin forma («${t.version}»)` : 'no trae version.json'}: no instalo una versión sin número`] };
    target = t;
  } else {
    // ubicar un número lee hasta 100 version.json: va con el tope de la bajada, no con el de mirar (15 s)
    const cLoc = client(ctx, { deadlineAt: Date.now() + Math.max(budgetS(ctx.env), Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) > 0 ? Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) : TARBALL_BUDGET_S_DEFAULT) * 1000 });
    let ref = channel === 'latest' ? SYNC_REF : MAIN_REF;
    let loc = locateVersion(cLoc, repoInfo.repo, ref, wanted);
    if (!loc.ok && ref === SYNC_REF && loc.status !== 'unknown') { ref = MAIN_REF; loc = locateVersion(cLoc, repoInfo.repo, MAIN_REF, wanted); }
    if (!loc.ok) return { code: loc.status === 'blocked' && /404|permiso|venció/.test(loc.reason) ? 1 : 2, lines: [`harness.js install: ${loc.reason}`] };
    target = { ref, commit: loc.commit, version: loc.version, note: null };
  }
  // 1 bis. la capa del equipo se RESUELVE y valida acá —ref, commit, lista del árbol (lista cerrada), declaración, perfil—
  // sin escribir ni registrar: sin acceso al repo del equipo, 1 con la HOME idéntica (AC 8). Se baja y apila después del
  // «¿Instalo?» y de las skills de terceros. El perfil se valida con el lector del árbol que corre y, al apilar, otra vez
  // con el de la versión que va a quedar (AC 6)
  let teamPlan = null;
  let teamOpen = null;
  if (teamRepo.repo) {
    // la fuente según su forma (GitHub o Azure DevOps): sin la credencial de Azure, 1 con la acción y sin escribir (nunca se calla)
    teamOpen = TEAM.openSource(teamRepo.repo, { ctx, deadlineAt: Date.now() + Math.max(budgetS(ctx.env), Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) > 0 ? Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) : TARBALL_BUDGET_S_DEFAULT) * 1000, publicRepo: repoInfo.repo });
    if (!teamOpen.ok) return { code: teamOpen.code, lines: [`harness.js install: ${teamOpen.reason}`] };
    teamPlan = teamOpen.resolve({ version: target.version, readerTree: ctx.tree, home: ctx.home, env: ctx.env });
    if (!teamPlan.ok) return { code: teamPlan.status === 'unknown' ? 2 : 1, lines: [`harness.js install: ${teamPlan.reason}`] };
  }

  // 2. antes de bajar nada: `--dry-run` sólo dice qué instalaría; sin `--yes` y sin terminal no se escribe nada (ni se baja)
  const tree = TH.ownPaths({ env: ctx.env }).harness;
  const P = require('./prompt.js');
  const what = `la versión ${target.version} (${target.ref} ${sha7(target.commit)}) de ${repoInfo.url} en ${tree}`;
  const teamLine = teamPlan ? [TEAM.planLine(teamPlan)] : [];
  if (ctx.opts['dry-run']) {
    // la conexión vieja de una skill de la lista que la capa trae (tanda A2c · AC 35): el plan dice qué se copiaría, sin escribir
    const st0 = read.status === 'ok' ? read.state : null;
    const dataPlan = teamPlan ? TEAM.moveSkillData({ home: ctx.home, env: ctx.env, dryRun: true, team: Object.assign({}, st0 && st0.team), layerPaths: teamPlan.files.map((f) => f.path), migrateHome: st0 && st0.migrate_home, previousDir: TH.ownPaths({ env: ctx.env }).previous }).lines : [];
    return { code: 0, lines: [`se instalaría ${what}`, tc.line, ...teamLine, ...dataPlan, ...(target.note ? [target.note] : []), ...(tokenExpired(ctx.env) ? [EXPIRED_TOKEN_TEXT] : [])] };
  }
  if (!ctx.opts.yes && !P.isTerminal()) return { code: 2, lines: [`se instala ${what}`, tc.line, 'harness.js install: sin `--yes` y sin terminal no escribo nada: harness.js install --version ' + wanted + ' --yes'] };

  // desde acá se escribe (la bajada, el registro): la máquina sin Claude Code ya vive en su casa, así ni el registro de
  // esta instalación cae en la carpeta de Claude Code
  if (bornInOwnHome) {
    // un corte por señal (Ctrl-C en la bajada o en la pregunta) también deshace lo creado: sin esto quedaba la carpeta
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { undoOwnHome(); process.exit(130); });
    try { TH.adoptOwnHome(ctx.home); } catch (e) { return { code: 1, lines: [`harness.js install: no pude crear ${TH.ownStateDir(ctx.home)} (${e.code || e.message}): sin esa carpeta el estado caería en la de Claude Code. No instalé nada`] }; }
  }
  // 3. bajar y verificar en incoming/<v>, con el tope de la bajada (más largo que el de mirar)
  const cDown = client(ctx, { deadlineAt: Date.now() + Math.max(budgetS(ctx.env), Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) > 0 ? Number(ctx.env.TYCON_RELEASE_DOWNLOAD_BUDGET_S) : TARBALL_BUDGET_S_DEFAULT) * 1000 });
  const d = download(ctx, cDown, repoInfo.repo, { commit: target.commit, version: target.version, ref: target.ref, log });
  if (!d.ok) { undoOwnHome(); return { code: d.status === 'unknown' ? 2 : 1, lines: [`harness.js install: ${d.reason}`] }; }
  const tp = restoreThirdParty(ctx, cDown, d.dir, { log });
  // 3 bis. la capa del equipo, apilada sobre la versión bajada ANTES de las preguntas (que leen la configuración del árbol
  // bajado: así ya ven el perfil del equipo y no preguntan lo que el equipo contesta)
  let teamStack = null;
  if (teamPlan) {
    // un choque con la versión bajada se mira ANTES de bajar la capa: no queda nada escrito (AC 4)
    const col = TEAM.collisionWith(teamPlan, d.dir);
    if (col.length) { const why = TEAM.collisionReason(teamPlan, d.dir, col); fs.rmSync(d.dir, { recursive: true, force: true }); undoOwnHome(); return { code: 1, lines: [`harness.js install: ${why}`] }; }
    const tf = teamOpen.fetch(teamPlan, { env: ctx.env, log });
    if (!tf.ok) { fs.rmSync(d.dir, { recursive: true, force: true }); undoOwnHome(); return { code: tf.status === 'unknown' ? 2 : 1, lines: [`harness.js install: ${tf.reason}`] }; }
    teamStack = TEAM.stackTeam(tf, d.dir, { home: ctx.home, env: ctx.env, log });
    // el momento 2 (AC 26) no deja ni incoming/ ni la caché que esta corrida acaba de crear
    if (!teamStack.ok) {
      fs.rmSync(d.dir, { recursive: true, force: true });
      let left = '';
      if (!tf.fromCache) { try { fs.rmSync(tf.cacheDir, { recursive: true, force: true }); } catch (e) { left = ` (y no pude borrar la caché ${tf.cacheDir}: ${e.code || e.message})`; } }
      undoOwnHome();
      return { code: 1, lines: [`harness.js install: ${teamStack.reason}${left}`] };
    }
  }

  // 4. las preguntas y la conformidad de install, sobre la versión bajada (con terminal)
  const asked = H.installQuestions(ctx, d.dir, read.status === 'ok' ? read.state : null);
  if (asked.code !== undefined) { fs.rmSync(d.dir, { recursive: true, force: true }); undoOwnHome(); return { code: asked.code, lines: asked.lines }; }
  if (asked.profile) ctx = Object.assign({}, ctx, { opts: Object.assign({}, ctx.opts, { profile: asked.profile }) });
  // lo contestado recién (la integración de Codex prendida o apagada) decide también el enchufe: se vuelve a elegir con
  // las respuestas puestas. Las preguntas no tocan a Claude Code, así que dónde vive la máquina no cambia; si con lo
  // contestado no queda ninguna herramienta, no se instala nada
  if (asked.writes && asked.writes.length) {
    const again = H.toolChoice(H.withAnswers(ctx, asked), ctx.tree, { state: read.status === 'ok' ? read.state : null });
    if (!again.ok) { fs.rmSync(d.dir, { recursive: true, force: true }); undoOwnHome(); return { code: again.code, lines: [`harness.js install: ${again.line}`] }; }
    if (again.tools.includes('claude') === withClaude) tc = again;
  }
  if (!ctx.opts.yes) {
    process.stdout.write(`${[`se instala ${what}`, tc.line, ...teamLine, ...(target.note ? [target.note] : []), ...asked.head].join('\n')}\n`);
    if (asked.eof || !P.ask('¿Instalo? [s/N] ')) { fs.rmSync(d.dir, { recursive: true, force: true }); undoOwnHome(); return { code: 0, lines: ['no se instaló nada'] }; }
  }

  const L = require('./lock.js');
  return L.withLock(ctx.home, () => {
    const notes = [...tp.notes, ...(target.note ? [target.note] : [])];
    const pieces = [];
    const existing = read.status === 'ok' ? read.state : null;
    const snap = H.takeSnapshot(ctx, tree, { reason: 'install', from: existing && existing.version ? existing.version.number : null, log, state: existing });
    // 4. el cambio: la versión bajada pasa a ser harness/
    const sw = swap(ctx, { incomingDir: d.dir, version: target.version, log });
    if (!sw.ok) { H.finishSnapshot(ctx, snap, log); undoOwnHome(); return { code: 1, lines: [`harness.js install: ${sw.reason}`] }; }
    notes.push(...(sw.kept || []));
    pieces.push('tree');
    // 5. los enlaces de hoy, al árbol nuevo: el lugar y agent-skills. Son enchufes de Claude Code (viven en su carpeta):
    // una máquina que no lo enchufa no los tiene (tanda C, AC 22)
    if (withClaude) {
      // el lugar apunta a ~/.tycon/harness aunque hoy apunte a otro clon válido: `link` lo fuerza (como `install --local`)
      const l = H.ensureLink(ctx, tree, { link: tree, prefer: tree });
      if (!l.ok) return { code: 2, lines: [`harness.js install: no pude asegurar el enlace: ${l.out || l.err}`] };
      pieces.push('link');
      const skillsLink = TH.installedSkillsDir(ctx.home);
      try {
        // en Windows, una unión (junction): un enlace simbólico de carpeta pide privilegios que un dev no tiene
        if (!exists(skillsLink)) { fs.symlinkSync(tree, skillsLink, process.platform === 'win32' ? 'junction' : 'dir'); pieces.push('agent-skills'); }
      } catch (e) { notes.push(`no pude crear el enlace ${skillsLink}: ${e.message}`); }
    }
    // 6. el estado
    const src = makeSource({ repoInfo, ref: target.ref, commit: target.commit, tree: d.manifest.tree, version: target.version });
    let state = existing;
    if (!state) { state = S.defaults({ tree, sources: [src], channel, version: { number: target.version } }); pieces.push('state'); }
    else { state.tree = tree; state.sources = [src]; state.mode = 'managed'; state.version.number = target.version; pieces.push('state'); }
    state.source = 'public';
    // la capa del equipo queda en el estado (story 8.25, AC 2 y 7): `update` la lleva a cada versión nueva
    state.team = teamStack ? TEAM.stateEntry(teamStack.manifest, existing && existing.team) : null;
    // qué herramientas enchufa esta máquina queda ESCRITO (tanda C): el arranque no vuelve a detectar
    state.tools = [...tc.tools];
    // con la capa apilada, la política se RELEE del árbol que quedó (trae el perfil del equipo): así el estado dice el canal
    // del perfil y el arranque siguiente no anuncia «el canal vigente cambió» (AC 7)
    const policyAfter = teamStack ? H.policyOf(ctx, tree) : null;
    if (policyAfter && policyAfter.errors.length) notes.push(`la política del equipo no se pudo leer después de apilar la capa (${policyAfter.errors[0]}): sigue con el canal de antes (${policy.channel})`);
    const policyNow = policyAfter && !policyAfter.errors.length ? policyAfter : policy;
    state.policy = { channel: policyNow.channel, apply: policyNow.apply, enabled: policyNow.enabled };
    H.applyPolicy(ctx, state, policyNow);
    // 7. la copia fija de arranque, y —sólo con Claude Code— su línea de arranque y el @import (en Codex el arranque es
    // su hook, que corre esta misma copia fija, y las reglas van en AGENTS.md: los pone el enchufe de Codex)
    if (H.copyBootstrap(ctx, tree, state, { version: target.version })) pieces.push('bootstrap');
    if (withClaude) {
      const SL = require('./startup-line.js');
      const n = SL.checkNode({ env: ctx.env });
      const m = SL.migrate(H.settingsPath(ctx), { home: ctx.home, platform: ctx.platform, nodeOk: n.ok, nodeVersion: n.version, addIfMissing: true, backup: !snap });
      if (m.changed) pieces.push('startup-line');
      if (H.ensureImport(ctx)) pieces.push('import');
    }
    // 8. lo contestado, el perfil
    if (asked.writes && asked.writes.length) {
      const wa = H.writeAnswers(ctx, tree, asked.writes);
      if (!wa.ok) { S.write(ctx.home, state); return { code: 2, lines: [`harness.js install: no pude escribir tus respuestas: ${wa.reason}. No corrí el aplicador`] }; }
      notes.push(...wa.warnings);
      pieces.push('config');
    }
    // 9. los enchufes de cada herramienta (el aplicador es el de Claude Code; el de Codex, en Node) y la salud
    const a = H.runApplier(ctx, tree, { log, snapshotDir: snap && snap.dir, tools: tc.tools, force: true, hooksPath: true });
    state.last_apply = nowIso();
    if (!a.ok) {
      state.last_health = null;
      state.failed = { commit: target.version, sources: { harness: target.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason: 'applier', stage: 'install' };
      S.write(ctx.home, state);
      H.finishSnapshot(ctx, snap, log);
      return { code: 1, lines: [`harness.js install: ${withClaude ? 'el aplicador' : 'el enchufe de Codex'} falló (${a.reason}) — detalle en ${S.paths(ctx.home).log}`, ...notes] };
    }
    if (withClaude) pieces.push('applier');
    if (tc.tools.includes('codex')) pieces.push('codex');
    // lo que el enchufe de Codex le dice a la persona (un servidor MCP que falta, los hooks a aprobar) va al cierre
    if (tc.tools.includes('codex')) for (const w of a.warnings || []) if (!notes.includes(w)) notes.push(w);
    H.recordPieces(ctx, state, a.report, a.shared);
    // la carpeta global de hooks de git (2026-10-14): si git no tenía ninguna, la puso el aplicador de arriba; se dice, y
    // si git no la dejó escribir, el aviso con el comando a mano (los demás avisos del aplicador no llegan a este cierre)
    { const hp = H.noteHooksPath(state, a); if (hp) notes.push(hp); else if (a.gitHooksPath && a.gitHooksPath.status === 'failed') notes.push(...a.gitHooksPath.line.split('\n')); }
    const prof = H.profileOf(ctx, tree);
    if (prof.ok) state.profile = { value: prof.value, origin: prof.origin };
    S.write(ctx.home, state);
    const h = H.runHealth(ctx, state, { report: a.report, applierOut: a.out, log });
    if (!h.ok) {
      state.failed = { commit: target.version, sources: { harness: target.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason: 'health', stage: 'install' };
      state.last_health = null;
      S.write(ctx.home, state);
      H.finishSnapshot(ctx, snap, log);
      return { code: 1, lines: [`harness.js install: la comprobación de salud no pasó: ${h.failures.join(' · ')} — detalle en ${S.paths(ctx.home).log}`, ...notes] };
    }
    state.failed = null;
    state.last_health = nowIso();
    // la conexión vieja de una skill de la lista fija (tanda A2c · AC 35): después del cambio sano, una vez por skill; lo que
    // no se pudo copiar se dice y no frena la instalación (D4)
    const moved = TEAM.moveSkillData({ home: ctx.home, env: ctx.env, team: state.team, harnessDir: tree, migrateHome: existing && existing.migrate_home, previousDir: TH.ownPaths({ env: ctx.env }).previous });
    for (const l of moved.lines) { notes.push(l); log(l); }
    S.write(ctx.home, state);
    H.finishSnapshot(ctx, snap, log);
    return { code: 0, lines: [`arnés instalado en modo managed · ${tree} (versión bajada, sin git)`, `versión: ${target.version} (${target.ref} ${sha7(target.commit)}) de ${repoInfo.url}`, ...(teamStack ? [`${TEAM.planLine(teamPlan)} → apilada en ${tree}`] : []), `canal: ${state.channel} · aplicación: ${policyNow.apply}`, `herramientas enchufadas: ${TOOLS.names(state.tools)}`, `piezas escritas: ${pieces.join(', ')}`, ...notes, ...(tokenExpired(ctx.env) ? [EXPIRED_TOKEN_TEXT] : [])] };
  }, { env: ctx.env, onBusy: (lock) => ({ code: 3, lines: [`harness.js: ${lock.reason || 'otra sesión está actualizando'}`] }) });
}

// ── actualizar (AC 9, 10, 12) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * El `doUpdate` de una instalación release: mira (`check`), y con `mode: 'apply'` baja, verifica, restituye terceros,
 * cambia con diario, enchufa y corre la salud; salud roja → vuelve y `failed`. Misma forma de resultado que doUpdate:
 * `{ status, code, lines, backup? }`. `yes` levanta la retención y reintenta lo fallido.
 */
/**
 * La capa del equipo puesta al día DENTRO de harness/ cuando no se instala una versión pública (story 8.25, A1b · AC 10). Sólo
 * con `state.team.repo`. Sin red primero: un archivo de la capa que FALTA se repone desde la caché del mismo commit (W11). Después
 * la ref: si da el commit que ya está en harness/ (o uno ya rechazado), nada más (una mirada = un pedido). Con un commit nuevo:
 * se resuelve y valida contra la versión INSTALADA (su número y su lector), se mira el choque con su manifiesto antes de bajar,
 * se baja a la caché y se refresca en el lugar como una transacción (`team.refreshInPlace`). Lo que no se puede no cambia nada en
 * harness/ y queda en `state.team.last_error`; una punta rechazada, en `state.team.rejected`. Nunca tira:
 * `{ status: 'none'|'same'|'refreshed'|'failed', lines, notice, profileChanged }`.
 */
function refreshTeam(ctx, state, { log = null, publicRepo = null } = {}) {
  if (!isObject(state.team) || typeof state.team.repo !== 'string' || !state.team.repo) return { status: 'none', lines: [] };
  const TEAM = require('./team.js');
  const own = TH.ownPaths({ env: ctx.env });
  const SHA40 = /^[0-9a-f]{40}$/;
  let onDisk = TEAM.readTeamManifest(own.harness);
  const label = onDisk ? sha7(onDisk.commit) : 'sin capa en esta versión';
  const say = (l) => { if (log) log(`team: ${l}`); };
  const fail = (reason, { rejectCommit = null } = {}) => {
    const text = `capa del equipo: ${reason} — sigue en ${label}`;
    const why = String(reason).slice(0, 600);
    state.team = Object.assign({}, state.team, { last_error: { at: nowIso(), reason: why } });
    // con la versión que la rechazó (A2a, AC 29): otra versión instalada la vuelve a evaluar
    if (rejectCommit && SHA40.test(String(rejectCommit))) state.team.rejected = { commit: rejectCommit, reason: why, at: nowIso(), version: (state.version && state.version.number) || null };
    say(text);
    return { status: 'failed', lines: [text], notice: text };
  };
  const lines = [];
  // si el perfil cambió se compara por su contenido antes y después, en CUALQUIER rama (pase adversarial, C-2: la reposición
  // desde la caché también lo cambia y la política se tiene que releer)
  // el perfil con su nombre de hoy o el de antes (team.js → profileIn): un repo del equipo que lo renombra no cuenta como cambio
  const profileNow = () => { try { return fs.readFileSync(TEAM.profileIn(own.harness).file, 'utf8'); } catch (_) { return null; } };
  const profileBefore = profileNow();
  try {
    const sameRepo = onDisk && onDisk.repo === state.team.repo;
    let forceFull = false;
    // 1. sin red: lo que FALTA de la capa de harness/ se repone desde la caché de ese commit (cero pedidos)
    if (sameRepo) {
      const st = TEAM.teamStatus(own.harness);
      if (st.present && st.missing.length) {
        let cacheDir = null;
        try { cacheDir = TEAM.cacheDirOf(ctx.env, onDisk.commit); } catch (_) { cacheDir = null; }
        const cm = cacheDir ? TEAM.readTeamManifest(cacheDir) : null;
        const files = onDisk.files.map((f) => ({ path: f.path, mode: f.mode || '100644', blob: f.blob || f.sha }));
        if (cm && cm.commit === onDisk.commit && cm.repo === onDisk.repo && TEAM.filesIntact(cacheDir, files)) {
          const resolved = { repo: onDisk.repo, host: onDisk.host, ref: onDisk.ref, commit: onDisk.commit, tree: onDisk.tree, etag: onDisk.etag, declaration: { name: onDisk.name, requires: onDisk.requires } };
          const rf = TEAM.refreshInPlace({ cacheDir, files, resolved }, own.harness, { home: ctx.home, env: ctx.env, log });
          if (rf.ok) { lines.push(`capa del equipo: repuesto(s) desde la caché ${rf.written.join(', ')}`); say(lines[lines.length - 1]); onDisk = TEAM.readTeamManifest(own.harness); }
          else forceFull = true;
        } else forceFull = true;
      }
    }
    // 2. la ref: una punta conocida (la de harness/ o una ya rechazada) no pide nada más
    // una punta rechazada se saltea sólo si la rechazó ESTA versión (A2a, AC 29: una versión que la entiende la vuelve a evaluar,
    // aunque haya llegado sin pasar por el apilado de update —rollback, install --version—); sin versión anotada (A1b), como antes
    const rj = isObject(state.team.rejected) && SHA40.test(String(state.team.rejected.commit)) ? state.team.rejected : null;
    const rejected = rj && (!rj.version || rj.version === (state.version && state.version.number)) ? rj : null;
    const known = [];
    if (sameRepo && onDisk && !forceFull) known.push(onDisk.commit);
    if (rejected) known.push(rejected.commit);
    const deadlineAt = Date.now() + Math.max(budgetS(ctx.env), 60) * 1000;
    const open = TEAM.openSource(state.team.repo, { ctx, deadlineAt, publicRepo });
    if (!open.ok) return fail(open.reason);
    const r = open.resolve({ version: state.version && state.version.number, readerTree: own.harness, home: ctx.home, env: ctx.env, knownCommits: known });
    // una versión pública que no se instaló por la capa (team-collision / team-invalid) se reintenta cuando la punta del equipo
    // es OTRA que la que se evaluó al fallar —aunque la instalada no la acepte (p. ej. `requires.harness` subido a esa versión)—:
    // la decide `update` contra la versión nueva en el arranque siguiente (pase adversarial de la A2a, clases 1, 6, 9 y 12)
    if (state.failed && (state.failed.reason === 'team-collision' || state.failed.reason === 'team-invalid')
      && r.commit && SHA40.test(String(r.commit)) && r.commit !== state.failed.team_commit) {
      lines.push(`capa del equipo: la punta cambió (${sha7(r.commit)}): la versión ${state.failed.commit || '—'} se vuelve a intentar en el próximo arranque`);
      say(lines[lines.length - 1]);
      state.failed = null;
    }
    if (!r.ok) return fail(r.reason, { rejectCommit: r.invalid ? r.commit : null });
    if (r.unchanged) {
      if (rejected && r.commit === rejected.commit) return fail(rejected.reason);
      // la punta es la de harness/: el estado la refleja, y lo viejo (un error, una punta rechazada) ya no aplica
      TEAM.syncStateWithTree(state, own.harness);
      if (isObject(state.team) && (state.team.last_error || state.team.rejected)) { const t = Object.assign({}, state.team); delete t.last_error; delete t.rejected; state.team = t; }
      return { status: lines.length ? 'refreshed' : 'same', lines, profileChanged: profileNow() !== profileBefore };
    }
    // 3. un commit nuevo: el choque con la versión instalada antes de bajar; bajar a la caché; refrescar en el lugar
    const col = TEAM.collisionWith(r, own.harness);
    if (col.length) return fail(TEAM.collisionReason(r, own.harness, col).replace(/ y no se instala$/, ': la capa no se refresca'), { rejectCommit: r.commit });
    const tf = open.fetch(r, { env: ctx.env, log });
    if (!tf.ok) return fail(tf.reason);
    const rf = TEAM.refreshInPlace(tf, own.harness, { home: ctx.home, env: ctx.env, log });
    if (!rf.ok) {
      // una punta que no vale para la versión instalada (momento 2, AC 26) no deja la caché que esta corrida acaba de crear
      if (rf.invalid && !tf.fromCache) { try { fs.rmSync(tf.cacheDir, { recursive: true, force: true }); } catch (_) { /* queda: la próxima bajada la reemplaza */ } }
      return fail(rf.reason, { rejectCommit: rf.invalid || rf.collision ? r.commit : null });
    }
    state.team = TEAM.stateEntry(rf.manifest, state.team);
    // una versión pública anotada como fallida por chocar con la capa o por no aceptarla: con la capa nueva se reintenta (N1, AC 19)
    if (state.failed && (state.failed.reason === 'team-collision' || state.failed.reason === 'team-invalid')) state.failed = null;
    lines.push(`capa del equipo ${rf.manifest.name} (${rf.manifest.repo}): ${rf.from ? sha7(rf.from) : 'sin capa'} → ${sha7(rf.manifest.commit)}${rf.written.length ? ` · actualizado(s) ${rf.written.join(', ')}` : ''}${rf.removed.length ? ` · quitado(s) ${rf.removed.join(', ')}` : ''}`);
    const handEdited = [...rf.kept, ...rf.keptRemoved];
    const notice = handEdited.length ? `capa del equipo: ${handEdited.join(', ')} editado(s) a mano en ${own.harness} — no se pisa(n) ni se borra(n); se pierde(n) con la próxima versión pública (queda(n) en previous/) — harness.js doctor lo detalla` : null;
    if (notice) lines.push(notice);
    say(lines.join(' · '));
    return { status: 'refreshed', lines, notice, profileChanged: profileNow() !== profileBefore };
  } catch (e) {
    return fail(`no se pudo refrescar (${e.message})`);
  }
}

function update(ctx, state, H, { mode = 'apply', log = null, snapshot = null, yes = false, policy = null, startedAt = null, teamRefresh = false, respectLimit = false } = {}) {
  const src = S.releaseSource(state);
  const channel = (policy && policy.channel) || state.channel || 'stable';
  const deadlineAt = (startedAt || Date.now()) + budgetS(ctx.env) * 1000;
  // la espera del tope de la API (story 8.34, decisión 6): el arranque la respeta (`respectLimit`); `update` a mano intenta
  // una vez, porque lo pidió una persona. Una espera vencida se borra
  const limitedAt = Date.parse(state.api_limited_until || '') || null;
  if (limitedAt && Date.now() >= limitedAt) { state.api_limited_until = null; state.api_limited_notice = null; }
  const waitUntil = respectLimit && limitedAt && Date.now() < limitedAt ? limitedAt : null;
  const c0 = check(ctx, state, { channel, log, deadlineAt, waitUntil });
  // la capa del equipo en el lugar (story 8.25, A1b · AC 10): cuando en ESTA corrida no se instala una versión pública, y sólo si
  // quien llama lo pide (el arranque; `update` salvo --check/--dry-run). También sin poder mirar la copia (W1): la capa no depende
  // de GitHub. El resultado va aparte (`res.team`): el estado de la copia no cambia por la capa (W3)
  const withTeam = (res) => { if (teamRefresh && mode !== 'dry-run' && state.mode !== 'developer') res.team = refreshTeam(ctx, state, { log, publicRepo: repo(src) }); return res; };
  if (c0.status === 'unknown') {
    state.last_fetch_failed = nowIso();
    if (c0.limitedUntil) { state.api_limited_until = new Date(c0.limitedUntil).toISOString(); return withTeam(Object.assign(c0, { status: 'limited' })); }
    return withTeam(c0);
  }
  state.last_fetch = nowIso();
  state.last_fetch_failed = null;
  // sin una versión nueva no hay nada esperando al tope: la espera se borra (si no, doctor seguiría anunciando «se baja
  // sola» una versión que no hay; revisor de fallos silenciosos de la story 8.34). Si vuelve a hacer falta la API, el
  // primer 403 la anota de nuevo
  if (c0.status === 'up_to_date' || c0.status === 'older') { state.api_limited_until = null; state.api_limited_notice = null; }
  if (c0.status === 'up_to_date' && mode === 'apply') {
    // una skill de terceros que no se pudo bajar al instalar (sin red, el origen caído) quedaba sin reponer hasta la
    // versión siguiente, y el aviso del aplicador mandaba a «harness.js update», que al día no hacía nada (pase adversarial
    // de la tanda G de la story 8.23, clase 12): al día, se repone lo que FALTA, nada más
    const own = TH.ownPaths({ env: ctx.env });
    const missing = missingThirdParty(own.harness, own);
    if (missing.length) {
      const c = client(ctx, { deadlineAt: Date.now() + Math.max(budgetS(ctx.env), TARBALL_BUDGET_S_DEFAULT) * 1000, waitUntil });
      const tp = restoreThirdParty(ctx, c, own.harness, { log, only: missing });
      const still = missingThirdParty(own.harness, own);
      c0.lines = [...(c0.lines || []), `skills de terceros que faltaban (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}): ${still.length ? `${missing.length - still.length} repuesta(s), ${still.length} siguen faltando` : 'repuestas'}`, ...tp.notes];
      if (log) { log(`update: al día; terceros que faltaban: ${missing.length}, siguen faltando: ${still.length}`); for (const n of tp.notes) log(`update: ${n}`); }   // el porqué, también en el registro (el arranque descarta las líneas)
    }
  }
  if (c0.status !== 'new') return withTeam(c0);
  const t = c0.target;
  const what = `${src.version} → ${t.version} (${t.ref} ${sha7(t.commit)})`;
  if (state.hold && !yes && mode !== 'dry-run') return withTeam({ status: 'held', code: 0, lines: [`hay versión nueva (${what}), pero ${H.holdText(state)}`] });
  if (state.failed && state.failed.reason !== 'interrupted' && !yes && mode !== 'dry-run' && state.failed.sources && state.failed.sources.harness === t.commit) {
    return withTeam({ status: 'skipped', code: 0, lines: [`la versión ${state.failed.commit} ya falló (${state.failed.reason || 'salud'}, ${state.failed.at || '—'}): no se reintenta sola hasta que cambie la punta (o ${H.applyHint})`] });
  }
  // `availableText` de harness.js lee `label` y `changes`: la misma forma que la de un clon
  if (mode === 'check') return withTeam(Object.assign(c0, { available: { label: `${t.version} (${t.ref} ${sha7(t.commit)})`, changes: '', version: t.version, commit: t.commit, ref: t.ref } }));
  if (mode === 'dry-run') {
    const own0 = TH.ownPaths({ env: ctx.env });
    // (la versión que corre hoy es la que va a quedar como previous/: el plan la mira en ese lugar del orden)
    const dataPlan = require('./team.js').moveSkillData({ home: ctx.home, env: ctx.env, dryRun: true, team: Object.assign({}, state.team), harnessDir: own0.harness, migrateHome: state.migrate_home, previousDir: own0.harness }).lines;
    return { status: 'new', code: 0, lines: [`se actualizaría: ${what}`, ...dataPlan] };
  }

  const c = client(ctx, { deadlineAt: Date.now() + Math.max(budgetS(ctx.env), TARBALL_BUDGET_S_DEFAULT) * 1000, waitUntil });
  const d = download(ctx, c, repo(src), { commit: t.commit, version: t.version, ref: t.ref, log });
  // al tope: la versión nueva espera a la hora que dijo GitHub; no es un fallo (story 8.34, decisiones 6 y 7)
  if (!d.ok && d.limitedUntil) {
    state.last_fetch_failed = nowIso();
    state.api_limited_until = new Date(d.limitedUntil).toISOString();
    return withTeam({ status: 'limited', code: 2, limitedUntil: d.limitedUntil, lines: [limitWaitText(c, d.limitedUntil, t.version)] });
  }
  if (d.ok) { state.api_limited_until = null; state.api_limited_notice = null; }
  // (una versión nueva que no se pudo bajar ni instalar NO congela la capa del equipo: cada salida del camino de aplicar que no
  // termina en el cambio refresca la capa en el lugar — pase adversarial de la A1b, R-1. La de la salud roja no hace falta: la
  // versión queda `failed` y el arranque siguiente pasa por la rama «ya falló», que refresca)
  if (!d.ok) { if (d.status === 'unknown') state.last_fetch_failed = nowIso(); return withTeam({ status: d.status === 'unknown' ? 'unknown' : 'blocked', code: 2, lines: [`harness.js update: ${d.reason}`] }); }
  const tp = restoreThirdParty(ctx, c, d.dir, { log });
  const own = TH.ownPaths({ env: ctx.env });
  // la capa del equipo (story 8.25, AC 9): la punta del repo del equipo, apilada sobre la versión nueva ANTES del cambio;
  // sin acceso (o con una punta que no valida), la que YA está en harness/ —comprobada contra su manifiesto— y se dice;
  // una versión que trae una ruta de la capa no se instala y queda anotada como fallida (no se vuelve a bajar en cada
  // arranque hasta que cambie la punta)
  const teamLines = [];
  let teamManifest = null;
  const previousTeam = state.team;
  if (isObject(state.team) && typeof state.team.repo === 'string' && state.team.repo) {
    const TEAM = require('./team.js');
    // la fuente según su forma (GitHub o Azure DevOps); sin credencial de Azure, se arrastra la capa instalada y se DICE
    const open = TEAM.openSource(state.team.repo, { ctx, deadlineAt: c.deadline, publicRepo: repo(src) });
    const r = open.ok ? open.resolve({ version: t.version, readerTree: d.dir, home: ctx.home, env: ctx.env }) : { ok: false, reason: open.reason };
    let st;
    if (r.ok) {
      // un choque con la versión nueva se mira ANTES de bajar la capa: no queda nada escrito (AC 4)
      const col = TEAM.collisionWith(r, d.dir);
      if (col.length) st = { ok: false, collision: col, reason: TEAM.collisionReason(r, d.dir, col) };
      else {
        const tf = open.fetch(r, { env: ctx.env, log });
        st = tf.ok ? TEAM.stackTeam(tf, d.dir, { home: ctx.home, env: ctx.env, log }) : { ok: false, reason: tf.reason, carry: true };
        // una punta que no vale para la versión nueva (momento 2, AC 19 y 26): no deja su caché y se arrastra la instalada
        if (tf.ok && !st.ok && st.invalid) {
          if (!tf.fromCache) { try { fs.rmSync(tf.cacheDir, { recursive: true, force: true }); } catch (e) { if (log) log(`update: no pude borrar la caché de la punta rechazada ${tf.cacheDir} (${e.code || e.message}); la próxima bajada la reemplaza`); } }
          st = Object.assign({}, st, { carry: true });
        }
      }
    } else st = { ok: false, reason: r.reason, carry: true };
    if (!st.ok && st.carry) {
      const carried = TEAM.carryTeam(own.harness, d.dir, { home: ctx.home, env: ctx.env, log });
      if (carried.ok) { teamLines.push(`capa del equipo: sin acceso al repo del equipo o su punta no vale (${st.reason}) — sigue en ${sha7(carried.manifest.commit)}`); st = carried; }
      else if (carried.collision) st = carried;
      // la instalada tampoco vale para la versión nueva (su cargador o su lector la rechazan): la versión no se instala y queda
      // anotada (team-invalid), como un choque, para no volver a bajarla en cada arranque hasta que cambie la punta (AC 19)
      else if (carried.invalid) st = { ok: false, invalid: true, reason: `${st.reason}; y ${carried.reason}: la versión nueva no se instala` };
      // ni la punta nueva ni la instalada (editada o incompleta): la versión nueva NO se instala sin capa; la máquina queda donde
      // estaba y lo dice (AC 9: nunca una máquina del equipo a medias)
      else st = { ok: false, reason: `${st.reason}; y la capa instalada no se puede arrastrar (${carried.reason}): la versión nueva no se instala hasta que el repo del equipo se vea o la capa instalada esté entera` };
    }
    // la punta del equipo que se evaluó (null si ni se pudo resolver): el refresco reintenta la versión cuando ve OTRA (clases 1 y 9)
    const teamCommit = r && /^[0-9a-f]{40}$/.test(String(r.commit || '')) ? r.commit : null;
    if (!st.ok && st.invalid) {
      fs.rmSync(d.dir, { recursive: true, force: true });
      state.failed = { commit: t.version, sources: { harness: t.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason: 'team-invalid', team_commit: teamCommit };
      if (log) log(`update: ${st.reason}`);
      return withTeam({ status: 'blocked', code: 2, lines: [`harness.js update: ${st.reason}; esa versión no se reintenta sola hasta que cambie la punta (o ${H.applyHint})`] });
    }
    if (st.collision) {
      fs.rmSync(d.dir, { recursive: true, force: true });
      state.failed = { commit: t.version, sources: { harness: t.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason: 'team-collision', team_commit: teamCommit };
      if (log) log(`update: ${st.reason}`);
      return withTeam({ status: 'blocked', code: 2, lines: [`harness.js update: ${st.reason}; esa versión no se reintenta sola hasta que cambie la punta (o ${H.applyHint})`] });
    }
    if (!st.ok) { fs.rmSync(d.dir, { recursive: true, force: true }); if (log) log(`update: ${st.reason}`); return withTeam({ status: 'blocked', code: 2, lines: [`harness.js update: ${st.reason}`] }); }
    teamManifest = st.manifest;
    for (const l of teamLines) if (log) log(`update: ${l}`);
  }
  const before = src.version;
  const snap = snapshot && snapshot.created ? snapshot : H.takeSnapshot(ctx, own.harness, { reason: 'update', from: before, to: `harness@${sha7(t.commit)}`, log, force: true, state });
  const sw = swap(ctx, { incomingDir: d.dir, version: t.version, log });
  if (!sw.ok) {
    H.finishSnapshot(ctx, snap, log);
    if (sw.waiting && sw.convert) {
      // la conversión a la forma con enlaces trabada (8.33, AC 10): la versión quedó en versions/, la máquina en la de antes
      const own0 = TH.ownPaths({ env: ctx.env });
      if (log) log(`update: la conversión a la forma con enlaces está trabada (${sw.reason})${sw.kept ? `; la versión ${t.version} quedó en ${sw.kept}` : ''}`);
      return withTeam({ status: 'waiting', convert: true, code: 2, lines: [`harness.js update: ${convertHeldText(own0)}`] });
    }
    if (sw.waiting) { if (log) log(`update: espera: ${sw.reason}`); return withTeam({ status: 'waiting', code: 2, lines: [`harness.js update: ${sw.reason}`] }); }
    return withTeam({ status: 'blocked', code: 2, lines: [`harness.js update: ${sw.reason}`] });
  }
  const previousSrc = Object.assign({}, src);
  Object.assign(src, { ref: t.ref, commit: t.commit, tree: d.manifest.tree, version: t.version, previous: previousSrc.commit });
  state.version.number = t.version;
  if (teamManifest) state.team = require('./team.js').stateEntry(teamManifest, state.team);
  if (log) log(`update: ${what}`);
  const a = H.runApplier(ctx, own.harness, { log, snapshotDir: snap && snap.dir });
  state.last_apply = nowIso();
  const fail = (failures, reason) => {
    const back = swapBack(ctx, { log, reason: 'failed' });
    Object.assign(src, previousSrc, { etags: src.etags });
    state.team = previousTeam;   // la capa que quedó es la de la versión que volvió
    state.version.number = previousSrc.version;
    state.failed = { commit: t.version, sources: { harness: t.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason };
    const text = back.ok ? `volvió sola a ${previousSrc.version}` : `NO pudo volver sola (${back.reason}): harness.js rollback`;
    R.setNotice(state, `la actualización ${before} → ${t.version} no quedó sana (${failures[0]}): ${text}; esa versión no se reintenta sola (cuando cambie la punta, o con ${H.applyHint}) — detalle en ${S.paths(ctx.home).log}`);
    if (log) log(`update: ${reason}: ${failures.join(' · ')} · ${back.ok ? 'vuelta hecha' : back.reason}`);
    H.finishSnapshot(ctx, snap, log);
    if (back.ok) H.runApplier(ctx, own.harness, { log, snapshotDir: snap && snap.dir });   // los enchufes de la versión que quedó
    return { status: 'failed', code: 1, lines: [`harness.js update: la versión ${t.version} no quedó sana (${failures.join(' · ')}) — ${text}`] };
  };
  if (!a.ok) return fail([a.reason], 'applier');
  H.recordPieces(ctx, state, a.report, a.shared);
  state.failed = { commit: t.version, sources: { harness: t.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason: 'interrupted', pending: 'health' };
  try { S.write(ctx.home, state); } catch (e) { if (log) log(`update: no pude grabar el estado antes de la salud (${e.message})`); }
  const h = H.runHealth(ctx, state, { report: a.report, applierOut: a.out, log });
  if (!h.ok) return fail(h.failures.length ? h.failures : ['la salud no pasó'], 'health');
  state.failed = null;
  state.version.installed_at = nowIso();
  state.last_health = nowIso();
  H.copyBootstrap(ctx, own.harness, state, { version: t.version });
  H.finishSnapshot(ctx, snap, log);
  // la conexión vieja de una skill de la lista (tanda A2c · AC 35): después del cambio sano (previous/ sigue ahí), una vez por skill
  const moved = require('./team.js').moveSkillData({ home: ctx.home, env: ctx.env, team: state.team, harnessDir: own.harness, migrateHome: state.migrate_home, previousDir: own.previous });
  for (const l of moved.lines) if (log) log(`update: ${l}`);
  // lo que la mudanza y kept- tienen que decir viaja también como aviso: el arranque con aplicación automática muestra sólo la
  // primera línea y manda el resto al registro, y la mudanza no se repite (pase adversarial de la A2c, clase 15)
  const dataNotice = [...(sw.kept || []), ...moved.lines].join(' · ') || null;
  return { status: 'applied', code: 0, lines: [`arnés ${before} → ${t.version}`, ...tp.notes, ...teamLines, ...(sw.kept || []), ...moved.lines], from: before, to: t.version, backup: snap && snap.dir ? snap.dir : null, dataNotice };
}

/** `rollback` en release (AC 15): el cambio al revés, los enchufes, la salud; sin previous/, dice `install --version`. */
function rollback(ctx, state, H, { log = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  const src = S.releaseSource(state);
  if (!exists(own.previous)) return { ok: false, lines: [`harness.js rollback: no hay versión anterior en ${own.previous}; para volver a un número publicado: harness.js install --version <n>`] };
  const prevManifest = readManifest(own.previous);
  const undone = src.version;
  const snap = H.takeSnapshot(ctx, own.harness, { reason: 'before-rollback', from: undone, to: prevManifest ? prevManifest.version : null, log, force: true, state });
  const back = swapBack(ctx, { log, reason: 'rollback' });
  if (!back.ok) { H.finishSnapshot(ctx, snap, log); return { ok: false, lines: [`harness.js rollback: ${back.reason}`] }; }
  const m = readManifest(own.harness);
  if (m) Object.assign(src, { ref: m.ref || src.ref, commit: m.commit, tree: m.tree, version: m.version, previous: null });
  state.version.number = m ? m.version : (prevManifest ? prevManifest.version : state.version.number);
  state.version.installed_at = nowIso();
  // la capa del equipo es la del árbol que quedó (story 8.25, A1b · AC 12): la de su .tycon-team.json; sin capa ahí, el repo
  // recordado sin commit (el arranque siguiente la trae); un estado sin team y un árbol con capa la toma
  let teamSyncProblem = null;
  try { require('./team.js').syncStateWithTree(state, own.harness, { adopt: true }); } catch (e) { teamSyncProblem = `no pude leer la capa del equipo del árbol que quedó (${e.message}): el estado puede nombrar otra capa — harness.js doctor lo detalla`; if (log) log(`rollback: ${teamSyncProblem}`); }
  const a = H.runApplier(ctx, own.harness, { log, snapshotDir: snap && snap.dir });
  state.last_apply = nowIso();
  const lines = [`vuelta atrás a ${state.version.number} (lo deshecho, ${undone}, queda en previous/: otro rollback lo vuelve a poner)`];
  if (teamSyncProblem) lines.push(`capa del equipo: ${teamSyncProblem}`);
  if (!a.ok) lines.push(`el aplicador falló (${a.reason}): harness.js doctor lo detalla`);
  else {
    H.recordPieces(ctx, state, a.report, a.shared);
    const h = H.runHealth(ctx, state, { report: a.report, applierOut: a.out, log });
    if (h.ok) state.last_health = nowIso(); else lines.push(`la comprobación de salud no pasó (${h.failures[0]}): harness.js doctor lo detalla`);
  }
  H.finishSnapshot(ctx, snap, log);
  return { ok: true, lines, undone, snap };
}

// ── doctor (AC 17) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Los archivos de `harness/` contra su manifiesto: editados, de más, faltantes (lo de terceros y el manifiesto no cuentan). */
function auditTree(ctx, tree) {
  const m = readManifest(tree);
  if (!m) return { ok: false, reason: `${tree} no trae su manifiesto (${MANIFEST_NAME}): no sé qué archivos debería tener` };
  const GH = lib('git-tree-hash.js');
  const edited = [], missing = [], extra = [];
  const known = new Map(m.files.map((f) => [f.path, f]));
  for (const f of m.files) {
    const abs = path.join(tree, ...f.path.split('/'));
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { missing.push(f.path); continue; }
    if (GH.blobSha(buf) !== f.blob) edited.push(f.path);
  }
  // lo de más: lo que está en el disco y el manifiesto no nombra, salvo el manifiesto mismo, lo de terceros y lo ignorado
  // por el repo (.dashboard/, .advisors/: lo escriben los nocturnos y las corridas)
  let thirdTargets = [];
  try { const raw = JSON.parse(fs.readFileSync(path.join(tree, 'scripts', 'publishing', 'third-party-skills.json'), 'utf8')); thirdTargets = (raw.thirdParty || raw.third_party || []).map((e) => String(e.target)); } catch (_) { thirdTargets = []; }
  // …y la capa del equipo (story 8.25): sus archivos y su manifiesto son del árbol, no «de más»
  // (y los temporales de un refresco de la capa cortado a mitad —sólo ARCHIVOS al lado de un destino de la capa: el refresco
  // siguiente los borra—; nada más se esconde: pase adversarial de la A1b, S-1)
  let teamPaths = new Set();
  let isLayerTemp = () => false;
  try { const TEAM = require('./team.js'); teamPaths = new Set(TEAM.layerPaths(tree)); isLayerTemp = TEAM.isLayerTemp; } catch (_) { teamPaths = new Set(); }
  const skip = (rel) => rel === MANIFEST_NAME || teamPaths.has(rel) || rel.startsWith('.dashboard/') || rel.startsWith('.advisors/') || rel.startsWith('node_modules/') || thirdTargets.some((t) => rel === t || rel.startsWith(`${t}/`));
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r)) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (!known.has(r) && !isLayerTemp(r)) extra.push(r);
    }
  };
  walk(tree, '');
  return { ok: true, manifest: m, edited, missing, extra };
}

// ── el arranque y `update` (lo que en un clon hacen cmdStartup y cmdUpdate) ──────────────────────────────────────

const FETCH_WINDOW_MS = { auto: 10 * 60 * 1000, ask: 6 * 60 * 60 * 1000 };
const FETCH_RETRY_MS = 10 * 60 * 1000;

/**
 * El arranque de una instalación release, YA con el candado tomado y el estado leído (lo llama cmdStartup): repara un
 * cambio a medias, mira según la política (con sus ventanas), aplica si corresponde, corre el aplicador SIEMPRE, limpia
 * lo diferido y deja el aviso. Devuelve `{ code: 0, lines }` (el arranque sale 0 siempre).
 */
function startup(ctx, state, H, { log, snapshot = null }) {
  const own = TH.ownPaths({ env: ctx.env });
  let line = null;
  let notice = null;
  const rep = repair(ctx, { log });
  if (rep.repaired) { line = rep.lines[0]; }
  // un cambio que quedó a medias y no se pudo reparar: el arranque no toca más nada y lo dice
  if (exists(own.journal) || exists(own.linkJournal)) {
    const text = `el cambio de versión quedó a medias y no se pudo reparar (${rep.lines[0] || 'ver el diario'}): detalle en ${S.paths(ctx.home).log}`;
    R.setNotice(state, text); S.write(ctx.home, state);
    return { code: 0, lines: [text] };
  }
  // la conversión a la forma con enlaces (story 8.33, decisión 7 con el ajuste del dueño): se intenta en silencio en cada
  // arranque, sin frenar nada. Trabada, el aviso sale UNA vez a los 3 días o 10 arranques; si no, registro y doctor
  if (linksOn(ctx) && state.mode !== 'developer') {
    const cv = convertLayout(ctx, { log: (l) => log(`startup: ${l.replace(/^release: /, '')}`) });
    if (cv.ok) {
      if (state.link_convert) { log('startup: la conversión a la forma con enlaces salió'); delete state.link_convert; }
    } else if (cv.held) {
      // ajuste del dueño (2026-10-14, «molestar lo menos posible»): se intenta en silencio —la primera sesión del día
      // suele arrancar con todo cerrado y ahí sale—; el aviso sale UNA vez, recién con 3 días o 10 arranques trabada
      const lc = isObject(state.link_convert) ? state.link_convert : { since: nowIso(), attempts: 0 };
      lc.attempts = (Number(lc.attempts) || 0) + 1;
      lc.reason = cv.reason;
      state.link_convert = lc;
      if (!lc.shown && (lc.attempts >= CONVERT_SAY_ATTEMPTS || daysSince(lc.since) >= CONVERT_SAY_DAYS)) { lc.shown = nowIso(); line = convertHeldText(own); log(`startup: ${line}`); }
      else log(`startup: la conversión a la forma con enlaces sigue trabada (intento ${lc.attempts}, desde ${lc.since}): ${cv.reason}`);
    } else log(`startup: la conversión a la forma con enlaces no se pudo (${cv.reason})`);
  }
  // el respaldo en shell pudo volver a previous/ sin tocar el estado: lo que hay en harness/ manda, y la versión que
  // se cayó queda como `failed` para no volver a bajarla sola (pase adversarial de la B)
  const src0 = S.releaseSource(state);
  const onDisk = readManifest(own.harness);
  if (onDisk && onDisk.commit && src0 && onDisk.commit !== src0.commit) {
    log(`startup: harness/ es ${onDisk.version} (${sha7(onDisk.commit)}) y el estado decía ${src0.version} (${sha7(src0.commit)}): el respaldo volvió atrás; se registra`);
    state.failed = { commit: src0.version, sources: { harness: src0.commit }, at: nowIso(), log: S.paths(ctx.home).log, reason: 'fallback' };
    Object.assign(src0, { ref: onDisk.ref || src0.ref, commit: onDisk.commit, tree: onDisk.tree, version: onDisk.version });
    state.version.number = onDisk.version;
    // …y la capa del equipo es la del árbol que quedó (story 8.25; pase adversarial, clase 2)
    if (require('./team.js').syncStateWithTree(state, own.harness)) log('startup: la capa del equipo del estado pasó a ser la del árbol que quedó');
    notice = `la versión ${state.failed.commit} no arrancaba y el respaldo volvió a ${onDisk.version}; esa versión no se reintenta sola (cuando cambie la punta, o con ${H.applyHint}) — harness.js doctor lo detalla`;
  }
  // `state.team` refleja SIEMPRE la capa que hay en harness/, sin red y antes de mirar (story 8.25, A1b · W4): un arranque que
  // murió entre refrescar la capa y grabar el estado no deja el estado en otro commit para siempre
  if (state.mode !== 'developer') { try { if (require('./team.js').syncStateWithTree(state, own.harness)) log('startup: la capa del equipo del estado pasó a ser la de harness/'); } catch (e) { log(`startup: no pude leer la capa del equipo de harness/ (${e.message})`); } }
  let policy = H.policyOf(ctx, own.harness);
  state.policy = { channel: policy.channel, apply: policy.apply, enabled: policy.enabled };
  let keepFromLastLook = Boolean(state.notice && !H.REEVALUATED_NOTICE.test(state.notice));
  if (policy.errors.length) { log(`startup: política inválida: ${policy.errors.join(' · ')}`); notice = `la política de actualización está mal escrita (${policy.errors[0]}): no se actualiza hasta arreglarla`; }
  else if (H.applyPolicy(ctx, state, policy).channelChanged) { keepFromLastLook = false; log(`startup: el canal vigente cambió a ${policy.channel}: se vuelve a mirar`); }
  const snap = snapshot || H.takeSnapshot(ctx, own.harness, { reason: 'startup', from: state.version && state.version.number, log, state });
  // una salud pendiente (la sesión anterior murió entre el cambio y la salud): se corre ahora; roja → vuelve
  if (state.failed && state.failed.pending === 'health') {
    const f = state.failed;
    log(`startup: la comprobación de salud de ${f.commit} quedó pendiente: la corro ahora`);
    const h = H.runHealth(ctx, state, { report: Array.isArray(state.managed) ? state.managed : [], applierOut: '', log });
    if (h.ok) { state.failed = null; state.last_health = nowIso(); H.copyBootstrap(ctx, own.harness, state, { version: state.version.number }); }
    else {
      const back = swapBack(ctx, { log, reason: 'failed' });
      const src = S.releaseSource(state);
      const m = readManifest(own.harness);
      if (back.ok && m) { Object.assign(src, { ref: m.ref || src.ref, commit: m.commit, tree: m.tree, version: m.version }); state.version.number = m.version; }
      // la capa del equipo del estado pasa a ser la del árbol que quedó (story 8.25; pase adversarial, clase 2)
      if (back.ok && require('./team.js').syncStateWithTree(state, own.harness)) log('startup: la capa del equipo del estado pasó a ser la del árbol que quedó');
      state.failed = { commit: f.commit, sources: f.sources, at: nowIso(), log: S.paths(ctx.home).log, reason: 'health' };
      notice = `la versión ${f.commit} no quedó sana (${h.failures[0]}): ${back.ok ? `volvió sola a ${state.version.number}` : `NO pudo volver sola (${back.reason}): harness.js rollback`}`;
      line = notice;
      log(`startup: salud pendiente: ${notice}`);
    }
  }
  // engram, sólo con la integración prendida (como en un clon)
  if (H.engramOn(ctx, own.harness)) H.engramSync(ctx);
  // mirar y actualizar según la política y sus ventanas
  let fetched = false;
  let teamNotice = null;
  if (state.mode === 'developer') log(`startup: modo desarrollador (${state.tree}): no se actualiza`);
  else if (!policy.enabled) log('startup: TYCON_UPDATE=0: sin actualización');
  else if (!policy.errors.length) {
    const window = FETCH_WINDOW_MS[policy.apply] || FETCH_WINDOW_MS.auto;
    const sinceLook = Date.now() - (Date.parse(state.last_fetch || '') || 0);
    const sinceTry = Date.now() - (Date.parse(state.last_fetch_failed || '') || 0);
    // pasada la hora del tope de la API, el primer arranque baja lo que esperaba, sin esperar la ventana (story 8.34, AC 11)
    const limitedAt = Date.parse(state.api_limited_until || '') || null;
    const limitOver = Boolean(limitedAt && Date.now() >= limitedAt);
    if (limitOver) log('startup: pasó la hora del tope de la API: miro y bajo lo que esperaba');
    if (sinceLook < window && !limitOver) log(`startup: última mirada a la red hace menos de ${policy.apply === 'ask' ? '6 horas (política ask)' : '10 min'}: sin pedir nada`);
    else if (sinceTry < FETCH_RETRY_MS && !limitOver) log('startup: el último intento de mirar (que no pudo) fue hace menos de 10 min: sin pedir nada');
    else {
      fetched = true;
      const u = update(ctx, state, H, { mode: policy.apply === 'auto' ? 'apply' : 'check', log, snapshot: snap, policy, teamRefresh: true, respectLimit: true });
      // la capa del equipo refrescada en el lugar (A1b · AC 10): su línea si no hay otra, su aviso se SUMA (W3), y con el perfil
      // cambiado la política se relee antes de grabar el estado (W12: si no, el arranque siguiente diría «el canal cambió»)
      if (u.team && u.team.status !== 'none' && u.team.status !== 'same') {
        for (const l of u.team.lines) log(`startup: ${l}`);
        if (u.team.notice) teamNotice = u.team.notice;
        if (u.team.status === 'refreshed') {
          line = line || u.team.lines[0];
          if (u.team.profileChanged) {
            const p2 = H.policyOf(ctx, own.harness);
            if (p2.errors.length) log(`startup: la política no se pudo releer después de refrescar la capa (${p2.errors[0]}): sigue la de antes`);
            else { policy = p2; state.policy = { channel: p2.channel, apply: p2.apply, enabled: p2.enabled }; H.applyPolicy(ctx, state, p2); }
          }
        }
      }
      // la conversión trabada (8.33) no es una falla que se cuente: su aviso es el de una sola vez, de arriba
      const convertWait = u.status === 'waiting' && u.convert;
      if (['new', 'applied', 'up_to_date', 'older'].includes(u.status) || convertWait) R.clearUpdateFailure(ctx.home);
      // esperar al tope de la API no es un fallo: la hora se sabe (story 8.34, decisión 6)
      else if (!['held', 'skipped', 'limited'].includes(u.status)) R.recordUpdateFailure(ctx.home, String(u.lines[0] || u.status).replace(/^harness\.js update: /, ''));
      if (u.status === 'limited') {
        // el aviso, UNA vez por espera (decisión 7); después, el registro y doctor
        log(`startup: ${u.lines.join(' · ')}`);
        if (state.api_limited_notice !== state.api_limited_until) { state.api_limited_notice = state.api_limited_until; notice = notice || u.lines[0].replace(/^harness\.js update: /, ''); line = u.lines[0]; }
      } else if (u.status === 'new') { const text = H.availableText(state, policy, u); notice = notice || text; log(`startup: ${text}`); line = text; }
      else if (u.status === 'applied') { line = u.lines[0]; log(`startup: ${u.lines.join(' · ')}`); if (u.dataNotice) notice = notice ? `${notice} · ${u.dataNotice}` : u.dataNotice; }
      else if (u.status === 'up_to_date' || u.status === 'older') { if (u.status === 'older') log(`startup: ${u.lines.join(' · ')}`); }
      else if (u.status === 'failed') { notice = notice || state.notice; line = u.lines[0]; log(`startup: ${u.lines.join(' · ')}`); }
      else if (u.status === 'held' || u.status === 'skipped' || convertWait) log(`startup: ${u.lines.join(' · ')}`);
      else if (u.status === 'unknown' && /sin red/.test(u.lines[0])) { log(`startup: ${u.lines.join(' · ')}`); line = 'arnés: sin red, no se actualizó'; }
      else { log(`startup: ${u.lines.join(' · ')}`); notice = notice || u.lines[0].replace(/^harness\.js update: /, ''); line = u.lines[0]; }
      // el permiso guardado venció y el repo se leyó sin él (2026-10-14): una línea, sin frenar, UNA vez mientras siga ese
      // permiso; con un permiso que vuelve a servir, la marca se borra (y uno nuevo que venza se avisa de nuevo)
      if (tokenExpired(ctx.env)) {
        log(`startup: ${EXPIRED_TOKEN_TEXT}`);
        if (!state.token_expired_notice) { state.token_expired_notice = nowIso(); notice = notice ? `${notice} · ${EXPIRED_TOKEN_TEXT}` : EXPIRED_TOKEN_TEXT; line = line ? `${line} · ${EXPIRED_TOKEN_TEXT}` : EXPIRED_TOKEN_TEXT; }
      } else if (['new', 'applied', 'up_to_date', 'older'].includes(u.status)) state.token_expired_notice = null;
    }
  }
  // sin permiso guardado, no hay nada que avisar: la marca se borra
  if (state.token_expired_notice && !GA.readToken({ env: ctx.env }).token) state.token_expired_notice = null;
  // el cambio de perfil (story 8.16, AC 26), como en un clon; y el aplicador, SIEMPRE, con el registro de lo que dejó
  const applierTree = state.mode === 'developer' ? state.tree : own.harness;
  const sw = H.profileSwitch(ctx, state, applierTree, log);
  if (sw.notice) notice = notice || sw.notice;
  const a = H.runApplier(ctx, applierTree, { log, snapshotDir: ((sw.snap || snap) && (sw.snap || snap).dir) || null });
  state.last_apply = nowIso();
  if (!a.ok) { const text = `el aplicador falló (${a.reason}): detalle en ${S.paths(ctx.home).log}`; notice = notice || text; log(`startup: ${text}`); line = line || text; }
  else {
    const dropped = sw.switching ? H.dropForProfile(ctx, state, applierTree, a, (l) => log(`startup: ${l}`), sw.profile.value) : true;
    if (sw.switching) H.profileSwitchNotes(dropped).forEach((n) => log(`startup: ${n}`));
    H.recordPieces(ctx, state, a.report, a.shared);
    if (sw.profile && sw.profile.ok && dropped !== null) state.profile = { value: sw.profile.value, origin: sw.profile.origin };
    // `--force` repite la salud entera aunque nada cambió (8.13 AC 21)
    if (ctx.opts && ctx.opts.force) {
      const h = H.runHealth(ctx, state, { report: a.report, applierOut: a.out, log });
      if (h.ok) state.last_health = nowIso();
      else { const text = `la comprobación de salud no pasó (${h.failures[0]}): harness.js doctor lo detalla; para volver a la versión anterior, harness.js rollback`; notice = notice || text; line = line || text; log(`startup: ${h.failures.join(' · ')}`); }
    }
  }
  H.finishSnapshot(ctx, sw.snap, log);
  // la limpieza diferida (AC 14): sólo con la salud en verde después del último cambio
  const cl = cleanupDeferred(ctx, state, { log });
  for (const l of cl.lines) log(`startup: limpieza: ${l}`);
  // una versión vieja tomada hace 7 días o más (8.33, decisión 9): el arranque lo dice, con qué cerrar
  if (cl.oldHeld && cl.oldHeld.length) { const t = oldHeldText(cl.oldHeld); line = line ? `${line} · ${t}` : t; log(`startup: ${t}`); }
  if (!notice && state.hold) notice = H.holdText(state);
  if (!notice && state.failed && state.failed.stage === 'install') notice = `la instalación quedó a medias (${state.failed.reason === 'applier' ? 'el aplicador falló' : 'la comprobación de salud no pasó'}, ${state.failed.at || '—'}): harness.js install --version latest otra vez la retoma — harness.js doctor lo detalla`;
  if (!notice && state.failed) notice = `la versión ${state.failed.commit} no quedó sana (${state.failed.reason || 'salud'}, ${state.failed.at || '—'}) y volvió sola a ${state.version && state.version.number}; no se reintenta sola hasta que cambie la punta (o ${H.applyHint}) — harness.js doctor lo detalla`;
  if (!notice && keepFromLastLook && !fetched && policy.enabled) notice = state.notice;
  // el aviso de la capa del equipo se suma, no reemplaza (A1b, W3)
  if (teamNotice && !(notice || '').includes(teamNotice)) notice = notice ? `${notice} · ${teamNotice}` : teamNotice;
  // una herramienta instalada y sin enchufar (tanda C, AC 24): se dice en cada arranque, sin pisar otro aviso
  { const tn = typeof H.toolNotice === 'function' ? H.toolNotice(ctx, own.harness, state) : null; if (tn) notice = notice ? `${notice} · ${tn}` : tn; }
  // la carpeta global de hooks de git (2026-10-14): con `auto` la pone este arranque y lo dice una vez; con `ask`, el aviso
  // la pide. Sólo con el aplicador sano (el pre-push tiene que estar en su lugar)
  if (typeof H.hooksPathUnattended === 'function') {
    if (a.ok) notice = H.hooksPathUnattended(ctx, state, applierTree, policy, { mode: 'startup', log: (l) => log(`startup: ${l}`), notice }).notice;
  }
  if (notice) R.setNotice(state, notice); else R.clearNotice(state);
  S.write(ctx.home, state);
  R.clearUpdateFailure(ctx.home, { kind: 'busy' });
  H.finishSnapshot(ctx, snap, log);
  return { code: 0, lines: line ? [line] : [] };
}

/** `update [--check|--dry-run|--yes]` en release (lo llama cmdUpdate, ya con el candado y el estado). */
function cmdUpdate(ctx, state, H, { log, asked = null }) {
  const own = TH.ownPaths({ env: ctx.env });
  const policy = H.policyOf(ctx, own.harness);
  if (policy.errors.length) return { code: 2, lines: [`harness.js update: la política de actualización está mal escrita: ${policy.errors.join(' · ')}`] };
  if (!policy.enabled) return { code: 0, lines: ['TYCON_UPDATE=0: la actualización está apagada del todo (sacá la variable para actualizar)'] };
  if (exists(own.journal) || exists(own.linkJournal)) { const rep = repair(ctx, { log }); if (exists(own.journal) || exists(own.linkJournal)) return { code: 2, lines: [`harness.js update: hay un cambio de versión a medias que no pude reparar: ${rep.lines[0] || 'ver el diario'}`] }; }
  // `update --yes` en una terminal suelta es lo que el aviso de la conversión manda correr (8.33, decisión 7): convierte
  // primero, aunque no haya versión nueva
  if (linksOn(ctx) && !ctx.opts.check && !ctx.opts['dry-run']) {
    const cv = convertLayout(ctx, { log });
    if (cv.ok && cv.converted) { delete state.link_convert; S.write(ctx.home, state); }
    else if (!cv.ok && cv.held) return { code: 2, lines: [`harness.js update: ${convertHeldText(own)}`] };
  }
  const mode = ctx.opts.check ? 'check' : ctx.opts['dry-run'] ? 'dry-run' : (policy.apply === 'ask' && !ctx.opts.yes && asked !== true ? 'check' : 'apply');
  if (ctx.opts.yes && mode === 'apply' && policy.apply === 'ask' && !process.stdin.isTTY) {
    return { code: 2, lines: ['harness.js update: `--yes` necesita una terminal, o `apply: auto` en la configuración (la política es «ask»: aplicar una versión nueva lo decide una persona)'] };
  }
  H.applyPolicy(ctx, state, policy);
  const lifted = [];
  if (ctx.opts.yes && mode === 'apply' && state.hold) { lifted.push(`retención levantada (había deshecho ${state.hold.commit})`); state.hold = null; }
  // la capa del equipo en el lugar (story 8.25, A1b · AC 10 y W2): con cualquier política, salvo --check y --dry-run (que no
  // escriben); el código de salida sigue siendo el de la copia (N3)
  const u = update(ctx, state, H, { mode, log, yes: Boolean(ctx.opts.yes), policy, startedAt: Date.now(), teamRefresh: !ctx.opts.check && !ctx.opts['dry-run'] });
  if (u.status === 'applied') { R.clearNotice(state); if (u.backup) u.lines = [...u.lines, R.updateBackupLine(u.backup)]; }
  else if (mode === 'check' && u.status === 'new') R.setNotice(state, H.availableText(state, policy, u));
  else if (u.status === 'up_to_date' && state.notice && !H.REEVALUATED_NOTICE.test(state.notice)) R.clearNotice(state);
  if (u.team && u.team.lines && u.team.lines.length) {
    u.lines = [...(u.lines || []), ...u.team.lines];
    const tn = u.team.notice;
    if (tn && !(state.notice || '').includes(tn)) R.setNotice(state, state.notice ? `${state.notice} · ${tn}` : tn);
  }
  // con el perfil cambiado por la capa, la política se relee antes de grabar el estado, como en el arranque (pase adversarial,
  // C-1: si no, el arranque siguiente dice «el canal cambió» y vuelve a mirar la red)
  if (u.team && u.team.profileChanged) {
    const p2 = H.policyOf(ctx, own.harness);
    if (p2.errors.length) u.lines = [...(u.lines || []), `la política no se pudo releer después de refrescar la capa del equipo (${p2.errors[0]}): sigue la de antes`];
    else { state.policy = { channel: p2.channel, apply: p2.apply, enabled: p2.enabled }; H.applyPolicy(ctx, state, p2); }
  }
  if (lifted.length) u.lines = [...lifted, ...u.lines];
  // la carpeta global de hooks de git (2026-10-14): un update que aplica la pone si falta (el aviso de `ask` la pedía)
  if (mode === 'apply' && typeof H.hooksPathUnattended === 'function' && !['failed', 'busy'].includes(u.status)) {
    const hp = H.hooksPathUnattended(ctx, state, own.harness, policy, { mode: 'update', log: (l) => log(`update: ${l}`), notice: state.notice });
    if (hp.line) u.lines = [...(u.lines || []), ...hp.line.split('\n')];
    if (hp.notice) R.setNotice(state, hp.notice); else R.clearNotice(state);
  }
  // el permiso guardado venció y el repo se leyó sin él: a mano se dice siempre, en una línea (no cambia la salida)
  if (tokenExpired(ctx.env)) { u.lines = [...(u.lines || []), EXPIRED_TOKEN_TEXT]; log(`update: ${EXPIRED_TOKEN_TEXT}`); if (!state.token_expired_notice) state.token_expired_notice = nowIso(); }
  else if (['new', 'applied', 'up_to_date', 'older'].includes(u.status)) state.token_expired_notice = null;
  S.write(ctx.home, state);
  if (mode === 'check' && u.status === 'new' && !ctx.opts.check) return { code: 3, lines: [...u.lines, `la política es «ask»: aplicá con ${H.applyHint}`] };
  return { code: u.code, lines: u.lines };
}

/**
 * Las líneas de la capa del equipo para `doctor` (story 8.25, A1b · AC 11): la línea `ok` (nombre, repo, commit, cuenta, entera);
 * editados y faltantes, la capa declarada y ausente, el último refresco que no se pudo, y el paquete de revisores del equipo que
 * todavía no está (hasta la A2), todos `warn`. Sin capa en el árbol ni en el estado: nada.
 */
function teamDoctorItems(ctx, state, tree) {
  const TEAM = require('./team.js');
  const out = [];
  const declared = isObject(state.team) && typeof state.team.repo === 'string' && state.team.repo ? state.team.repo : null;
  const st = TEAM.teamStatus(tree);
  if (st.error) out.push({ level: 'warn', text: `capa del equipo: no pude revisarla (${st.error})` });
  if (!st.present) {
    if (declared) out.push({ level: 'warn', text: `capa del equipo (${declared}) no está en esta versión${st.broken ? ` (su ${TEAM.MANIFEST_NAME} no se puede leer)` : ''}: el próximo arranque fuera de la ventana de red, o harness.js update, la trae` });
  } else {
    const m = st.manifest;
    const whole = !st.edited.length && !st.missing.length && !st.halfDone.length && !st.pendingCorrupt;
    out.push({ level: 'ok', text: `capa del equipo ${m.name || '—'} (${m.repo}) @ ${sha7(m.commit)}: ${m.files.length} archivo(s)${whole ? ', todo en su lugar' : ''}` });
    for (const p of st.edited) out.push({ level: 'warn', text: `capa del equipo: ${p} editado a mano — el refresco de la capa no lo pisa; se pierde con la próxima versión pública (queda en previous/)` });
    if (st.pendingCorrupt) out.push({ level: 'warn', text: `capa del equipo: el registro de un refresco a medias (${TEAM.PENDING_NAME}) no se puede leer — un archivo «editado» puede ser del arnés; el próximo refresco lo resuelve` });
    for (const p of st.halfDone) out.push({ level: 'warn', text: `capa del equipo: ${p} quedó a medio refrescar (ya es del commit ${sha7(st.pendingCommit)}; el manifiesto todavía dice ${sha7(m.commit)}) — el próximo refresco lo completa` });
    for (const p of st.missing) out.push({ level: 'warn', text: `capa del equipo: ${p} falta — el próximo arranque fuera de la ventana de red (o harness.js update) lo repone desde la caché o del repo del equipo` });
    for (const p of st.kept) out.push({ level: 'warn', text: `capa del equipo: ${p} editado a mano y ya no viene en la capa (${sha7(m.commit)}): se conservó; borralo a mano si no lo querés` });
    // el paquete de revisores del equipo (D-1, hasta la A2): con alguna integración del perfil de la capa prendida
    let integrationsOn = false;
    const prof = TEAM.profileIn(tree);
    try { const p = JSON.parse(fs.readFileSync(prof.file, 'utf8')); integrationsOn = isObject(p.integrations) && Object.values(p.integrations).some((v) => v === true); } catch (e) {
      integrationsOn = false;
      // sin perfil en la capa no hay nada que avisar; uno que no se puede leer se dice (fallos silenciosos, A2a vuelta 2)
      if (e && e.code !== 'ENOENT') out.push({ level: 'warn', text: `capa del equipo: ${prof.name} no se puede leer (${e.code || e.message})` });
    }
    // el nombre del perfil: el de antes sigue andando, dicho en una línea suave (nunca un fallo)
    const profNotice = TEAM.profileNameNotice(prof, 'layer');
    if (profNotice) out.push({ level: 'ok', text: `capa del equipo: ${profNotice}` });
    // (A2a, AC 20: una capa que ya trae un paquete no lo dice)
    const layerHasPack = m.files.some((f) => /^packs\/[^/]+\/pack\.json$/.test(f.path));
    if (integrationsOn && !layerHasPack && !exists(path.join(tree, 'packs', 'clients', 'pack.json'))) out.push({ level: 'warn', text: 'capa del equipo: el paquete de revisores del equipo (packs/clients) todavía no está en esta máquina — llega con la parte 2 de la capa; mientras tanto el pipeline corre sin esos revisores' });
    // las skills anidadas de la capa (skills/<grupo>/…) se leen por ruta en ~/.claude/skills/<grupo>/…; si esa carpeta es REAL y
    // ya trae su propio <grupo>/, las del equipo no se ven (el aplicador no pisa lo ajeno): se dice, nombrando la carpeta (AC 20)
    const groups = [...new Set(m.files.map((f) => f.path).filter((p) => p.startsWith('skills/') && p.split('/').length > 3 && path.posix.basename(p) === 'SKILL.md').map((p) => p.split('/')[1]))];
    const claudeSkills = path.join(ctx.home, '.claude', 'skills');
    let realDir = false;
    const said = (where, e) => out.push({ level: 'warn', text: `capa del equipo: no pude mirar ${where} (${e.code || e.message}) para saber si tapa las skills del equipo` });
    try { realDir = groups.length > 0 && fs.lstatSync(claudeSkills).isDirectory(); } catch (e) { realDir = false; if (e && e.code !== 'ENOENT') said(claudeSkills, e); }
    for (const g of realDir ? groups : []) {
      const own = path.join(claudeSkills, g);
      let st2 = null;
      try { st2 = fs.lstatSync(own); } catch (e) { st2 = null; if (e && e.code !== 'ENOENT') said(own, e); }
      if (!st2 || st2.isSymbolicLink()) continue;
      out.push({ level: 'warn', text: `capa del equipo: ${own} es una carpeta propia y tapa las skills del equipo de skills/${g}/ (se leen en ${path.join(tree, 'skills', g)}) — si no es tuya, borrala y el próximo arranque la enlaza` });
    }
  }
  if (declared && isObject(state.team.last_error) && state.team.last_error.reason) out.push({ level: 'warn', text: `capa del equipo: el último refresco no se pudo (${state.team.last_error.at || '—'}): ${state.team.last_error.reason}` });
  // una versión pública que no se instaló por la capa (AC 9 y 19): no se reintenta sola hasta que cambie la punta
  if (isObject(state.failed) && (state.failed.reason === 'team-collision' || state.failed.reason === 'team-invalid')) {
    out.push({ level: 'warn', text: `capa del equipo: la versión ${state.failed.commit || '—'} no se instaló (${state.failed.reason === 'team-invalid' ? 'team-invalid: ni la punta del equipo ni la capa instalada valen para esa versión' : 'team-collision: esa versión trae una ruta de la capa'}, ${state.failed.at || '—'}); no se reintenta sola hasta que cambie la punta del equipo` });
  }
  return out;
}

/** Lo que `doctor` dice de una instalación release (AC 17): versión, canal, previous/, el árbol contra su manifiesto. */
function doctorItems(ctx, state, { fetch = false, channel = null } = {}) {
  const own = TH.ownPaths({ env: ctx.env });
  const src = S.releaseSource(state);
  const items = [];
  const add = (level, text) => items.push({ level, text });
  // el canal que se dice es el VIGENTE (la política, que quien llama ya leyó); el del estado es la copia de la última
  // mirada y queda atrás si la configuración cambió a mano (la primera máquina migrada, 2026-10-08: «canal latest» en la
  // política y «canal stable» en esta línea). Si difieren, se dice: el arranque siguiente lo pone al día
  const now = channel || state.channel;
  const stale = channel && state.channel && channel !== state.channel ? ` (el estado todavía dice ${state.channel}: el próximo arranque lo pone al día)` : '';
  add('ok', `versión bajada ${src.version} (${src.ref} ${sha7(src.commit)}) de ${src.url} en ${own.harness}; canal ${now}${stale}`);
  const prev = readManifest(own.previous);
  if (exists(own.previous)) add('ok', `versión anterior en ${own.previous}${prev ? ` (${prev.version})` : ''}: harness.js rollback vuelve a ella sin red`);
  else add('ok', `sin versión anterior (${own.previous}): para volver a un número publicado, harness.js install --version <n>`);
  if (exists(own.journal)) add('fail', `hay un cambio de versión a medias (${own.journal}): el próximo arranque lo repara; harness.js update también`);
  if (exists(own.linkJournal)) add('fail', `hay un cambio de versión a medias (${own.linkJournal}): el próximo arranque lo repara; harness.js update también`);
  // (story 8.35) ~/.claude/skills y ~/.claude/agents son carpetas del dev; un enlace a la carpeta ENTERA del arnés es la
  // forma vieja: lo que el dev o Claude Code ponen ahí cae adentro del arnés y se pierde con una actualización
  // (los dos enchufes de Claude Code, cada uno escrito entero: así el techo de la carpeta de Claude Code los reconoce)
  const plugs = { skills: path.join(ctx.home || os.homedir(), '.claude', 'skills'), agents: path.join(ctx.home || os.homedir(), '.claude', 'agents') };
  for (const side of ['skills', 'agents']) {
    const p = plugs[side];
    let r = null, t = null;
    try { if (fs.lstatSync(p).isSymbolicLink()) { r = fs.realpathSync(p); t = fs.realpathSync(path.join(own.harness, side)); } } catch (_) { r = null; }
    // (en Windows y en Mac el disco no distingue mayúsculas: `c:\…` y `C:\…` son la misma carpeta)
    const same = r && t && (r === t || ((process.platform === 'win32' || process.platform === 'darwin') && r.toLowerCase() === t.toLowerCase()));
    // lo que dejó la conversión: una temporal de un corte (el arranque la termina) o lo apartado (lo revisa el dev)
    let near = [];
    try { near = fs.readdirSync(path.dirname(p)); } catch (_) { near = []; }
    const cut = near.filter((n) => n.startsWith(`${side}.tycon-new-`));
    if (cut.length) add('warn', `quedó una conversión de ${p} a medias (${cut.map((n) => path.join(path.dirname(p), n)).join(', ')}): lo tuyo está ahí, el próximo arranque la termina`);
    if (near.includes(`${side}.tycon-aparte`)) add('warn', `en ${p}.tycon-aparte hay cosas tuyas apartadas (estaban dos veces con distinto contenido): revisalas y borrá lo que sobre`);
    if (same) add('warn', `${p} es un enlace a la carpeta entera del arnés (la forma vieja): lo que pongas ahí se pierde con una actualización. El próximo arranque la convierte en una carpeta tuya, con lo tuyo adentro`);
  }
  // la forma con enlaces (story 8.33): dónde apunta cada enlace, la conversión trabada, lo pendiente de limpiar
  if (linksOn(ctx)) {
    const where = (name) => (TH.isLink(name) ? `${name} → ${TH.linkTarget(name)}` : exists(name) ? `${name} es una carpeta (la forma de antes)` : `${name} no está`);
    add('ok', `enlaces: ${where(own.harness)} · ${where(own.previous)}`);
    if ((exists(own.harness) && !TH.isLink(own.harness)) || (exists(own.previous) && !TH.isLink(own.previous))) {
      add('warn', `conversión a la forma con enlaces pendiente${isObject(state.link_convert) ? `, tomada desde ${state.link_convert.since}${state.link_convert.reason ? ` (${state.link_convert.reason})` : ''}` : ''}: ${convertHeldText(own)}`);
    }
    const pend = isObject(state.link_pending) ? state.link_pending : {};
    for (const [name, since] of Object.entries(pend)) {
      const dir = path.join(own.versions, name);
      if (!exists(dir)) continue;
      const d = daysSince(since);
      add('warn', `pendiente de limpiar: ${dir} (${d === 0 ? 'desde hoy' : `hace ${d} día(s)`}; algún programa la tiene abierta) — se borra sola cuando se suelte`);
    }
    const named = isObject(state.link_named) ? state.link_named : {};
    for (const [name, who] of Object.entries(named)) {
      const dir = path.join(own.versions, name);
      if (exists(dir)) add('ok', `no se borra: ${dir} (lo nombra ${who})`);
    }
  }
  const a = auditTree(ctx, own.harness);
  // las skills de la lista fija que trae la capa (tanda A2c · AC 36): lo ajeno dentro de su carpeta se dice con su lugar y
  // reemplaza, para esas rutas, la línea «de más»; nunca `fail`, nunca tira, nada en modo desarrollador
  let sd = { items: [], foreign: new Set() };
  if (state.mode !== 'developer') {
    try { sd = require('./team.js').skillDataDoctor({ home: ctx.home, env: ctx.env, tree: own.harness, team: state.team, codex: Array.isArray(state.tools) && state.tools.includes('codex') }); } catch (e) { sd = { items: [{ level: 'warn', text: `skills de la lista fija: no pude revisarlas (${e.message})` }], foreign: new Set() }; }
  }
  if (a.ok) a.extra = a.extra.filter((p) => !sd.foreign.has(p));
  if (!a.ok) add('fail', a.reason);
  else {
    if (a.manifest.tree !== src.tree) add('warn', `el manifiesto de harness/ es de otro árbol (${sha7(a.manifest.tree)}) que el que registra el estado (${sha7(src.tree)})`);
    for (const p of a.edited) add('warn', `${p}: editado en la carpeta del arnés — se pierde en la próxima actualización (la copia fija y el manifiesto dicen cómo era)`);
    for (const p of a.missing) add('warn', `${p}: falta en la carpeta del arnés — se repone en la próxima actualización`);
    for (const p of a.extra) add('warn', `${p}: de más en la carpeta del arnés (el manifiesto no lo trae) — se pierde en la próxima actualización`);
    if (!a.edited.length && !a.missing.length && !a.extra.length) add('ok', `los ${a.manifest.files.length} archivos de harness/ son los del manifiesto (árbol ${sha7(a.manifest.tree)})`);
  }
  const tp = readManifest(own.thirdParty);   // sólo informativo
  void tp;
  // la capa del equipo (story 8.25, A1b · AC 11): sin red, sin tirar nunca (doctor corre dentro de la salud: un volcado la
  // pondría roja y desharía una versión pública sana — W5), nunca `fail`, y nada en una máquina sin capa ni en modo desarrollador
  if (state.mode !== 'developer') {
    try { for (const it of teamDoctorItems(ctx, state, own.harness)) add(it.level, it.text); } catch (e) { add('warn', `capa del equipo: no pude revisarla (${e.message})`); }
    for (const it of sd.items) add(it.level === 'fail' ? 'warn' : it.level, it.text);
  }
  // la espera del tope de la API (story 8.34): hasta qué hora, y que se baja sola después
  { const until = Date.parse(state.api_limited_until || '') || null; if (until && Date.now() < until) add('warn', `${limitText({ token: GA.readToken({ env: ctx.env }).token }, until)}: la versión nueva se baja sola en el primer arranque después de esa hora`); }
  if (fetch) {
    const c = check(ctx, state, { channel: now });
    add(c.status === 'unknown' || c.status === 'blocked' ? 'warn' : 'ok', `red: ${c.lines[0].replace(/^harness\.js update: /, '')}`);
  }
  // el permiso guardado que venció contra el repo público (2026-10-14): amarillo, nunca rojo — la máquina se actualiza igual
  if (tokenExpired(ctx.env) || (state.token_expired_notice && GA.readToken({ env: ctx.env }).token)) add('warn', EXPIRED_TOKEN_TEXT);
  return items;
}

/** La línea de `version` en release: el número, el commit, modo, canal, de dónde. */
function versionLine(state, { channel = null } = {}) {
  const src = S.releaseSource(state);
  return `${src.version} · harness ${sha7(src.commit)} · ${state.mode || 'managed'} · ${channel || state.channel || 'stable'} · harness@${src.ref} (versión bajada de ${src.url})`;
}
function versionJson(state, { channel = null } = {}) {
  const src = S.releaseSource(state);
  // `team` (story 8.25): la capa del equipo apilada, o null (una máquina sin capa)
  return { number: src.version, stamped: true, kind: 'release', harness: { commit: src.commit, tree: src.tree, ref: src.ref, repo: src.url }, mode: state.mode || 'managed', channel: channel || state.channel || 'stable', team: isObject(state.team) ? state.team : null };
}

module.exports = {
  startup, cmdUpdate, doctorItems, versionLine, versionJson, FETCH_WINDOW_MS,
  MANIFEST_NAME, MAIN_REF, SYNC_REF, API_DEFAULT,
  githubRepoOf, repoOf, apiBase, client, explainFailure, tokenExpired, EXPIRED_TOKEN_TEXT, refCommit, versionAt, resolveChannel, check, locateVersion,
  download, readManifest, restoreThirdParty, swap, swapBack, repair, cleanupDeferred, isNamed, makeSource,
  convertLayout, swapLinks, swapBackLinks, repairLinks,
  cmdInstall, update, rollback, auditTree,
};
