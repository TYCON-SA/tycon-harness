'use strict';
// team-config.js — la página local que MUESTRA la configuración de la organización: `harness.js team-config`.
//
// Qué resuelve: quien mantiene el arnés en una organización ve acá, de sólo lectura, dónde vive cada repo
// (team-repos.json, en el clon del perfil del equipo, que llega a todas las máquinas), a quién se le asignan los avisos y
// los Bugs de los nocturnos (operations.json, en el clon del repo de operaciones, que no se instala) y el resto de las
// secciones de esos clones: las mismas del sitio de la organización (scripts/lib/org-config.js), con los problemas que
// encuentran los MISMOS lectores que usa el arnés (acá no hay un validador propio). La configuración se edita en el sitio
// de la organización; sin sitio, con un pedido al repo de operaciones: la página lo dice arriba, con la dirección si
// operations.json la declara (`site.url`). Las rutas de edición contestan 410.
//
// Es una página LOCAL: un servidor en 127.0.0.1, en un puerto al azar, que sólo contesta a quien trae la llave de un solo
// uso de la dirección que abre el navegador. No carga nada de afuera, no guarda credenciales, no escribe en ningún repo y
// no sale a la red.
// Defensas: el encabezado Host tiene que ser el de la página (un sitio de afuera no puede hablarle por un nombre que
// resuelva a 127.0.0.1), la llave va en un encabezado propio en cada llamada (otra pestaña no la conoce), un POST con un
// Origin que no es el de la página se rechaza, y el cuerpo tiene tope.
//
// Las carpetas de los dos clones son claves de la máquina (`paths.team` y `paths.operations`, en ~/.tycon/config.json):
// las pide la página la primera vez y las guarda quien la lanzó (harness.js, con el mismo lector de configuración que
// `config set`). Sin el lector de un archivo en esta versión del arnés, esa parte de la página lo dice y no muestra datos.
//
// Este archivo viaja en la copia fija del programa: no carga `scripts/lib/` por ruta relativa al cargar; los lectores y el
// núcleo de las secciones se piden al árbol que se le pasa. Casos: scripts/tests/team-config.test.js.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

/** Los dos archivos que edita la página: dónde viven y con qué lector se validan. */
const TARGETS = Object.freeze([
  Object.freeze({
    id: 'repos', configKey: 'paths.team', file: 'team-repos.json', reader: 'team-repos.js',
    title: 'Dónde vive cada repo de la organización', repoName: 'harness-team-profile (el perfil del equipo)',
    reach: 'Este archivo llega a todas las máquinas del equipo.',
  }),
  Object.freeze({
    id: 'operations', configKey: 'paths.operations', file: 'operations.json', reader: 'operations-config.js',
    title: 'A quién se asignan los avisos y los Bugs', repoName: 'harness-team-operations (las operaciones del equipo)',
    reach: 'Este archivo no se instala en las máquinas: lo leen los procesos de la noche y el sitio de la organización.',
  }),
]);
const BODY_LIMIT = 256 * 1024;
/** Las rutas de edición que ya no existen: contestan 410. */
const RETIRED = new Set(['/api/check', '/api/save', '/api/plan', '/api/propose', '/api/propose-stages']);

const targetById = (id) => TARGETS.find((t) => t.id === id) || null;
const expandHome = (p, home) => String(p || '').replace(/^~(?=[\\/]|$)/, home || '');

/** El lector de un archivo, del árbol del arnés; `null` si esta versión no lo trae. `readers` (pruebas) manda. */
function loadReader(tree, target, readers) {
  if (readers && Object.prototype.hasOwnProperty.call(readers, target.id)) return readers[target.id];
  const f = path.join(tree, 'scripts', 'lib', target.reader);
  if (!fs.existsSync(f)) return null;
  const r = require(f);
  return r && typeof r.parse === 'function' ? r : null;
}

/**
 * El núcleo común de las secciones (scripts/lib/org-config.js), del árbol que se le pasa; `core` (pruebas) manda. Nunca tira:
 * `{ core, problem }`. Sin el núcleo la página muestra los archivos sin separarlos por secciones y lo dice.
 */
function loadCore(tree, injected) {
  if (injected) return { core: injected, problem: null };
  const f = path.join(tree, 'scripts', 'lib', 'org-config.js');
  if (!fs.existsSync(f)) return { core: null, problem: 'esta versión del arnés no trae scripts/lib/org-config.js: la página no separa los archivos por secciones' };
  try {
    const c = require(f);
    if (c && Array.isArray(c.SECCIONES)) return { core: c, problem: null };
    return { core: null, problem: 'scripts/lib/org-config.js no trae las secciones' };
  } catch (e) {
    return { core: null, problem: `no se pudo cargar scripts/lib/org-config.js (${(e && (e.code || e.name)) || 'error'})` };
  }
}

/** ¿Sirve `dir` como clon? Devuelve el motivo en llano, o null. */
function cloneProblem(dir) {
  if (!dir) return 'falta la carpeta del clon';
  if (!path.isAbsolute(dir)) return `la carpeta tiene que ser una ruta completa (dice «${dir}»)`;
  if (!fs.existsSync(dir)) return `la carpeta no existe (${dir})`;
  if (!fs.existsSync(path.join(dir, '.git'))) return `la carpeta no es un clon de git (${dir})`;
  return null;
}

/** Lo que la página muestra de un archivo: la carpeta, el texto, lo que dijo el lector. Nunca tira: dice el problema. */
function readTarget(target, clone, reader) {
  const out = { id: target.id, title: target.title, configKey: target.configKey, file: target.file, repoName: target.repoName, reach: target.reach, clone: clone || null };
  if (!reader) return { ...out, state: 'no-reader', message: `esta versión del arnés todavía no sabe leer ${target.file}: actualizá el arnés y volvé a abrir la página` };
  const why = cloneProblem(clone);
  if (why) return { ...out, state: 'needs-clone', message: why };
  const file = path.join(clone, target.file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { ...out, state: 'new', data: null, problems: [] };
    return { ...out, state: 'unreadable', message: `no pude leer ${file} (${(e && e.code) || e})` };
  }
  const r = reader.parse(text);
  // un problema que el lector da aparte (un modelo mal escrito) viene con `data` sin esa clave:
  // el borrador sale del archivo, para que guardar no la borre en silencio, y el problema se muestra
  const aparte = r.sectionProblems ? Object.values(r.sectionProblems).flat() : [];
  return { ...out, state: 'loaded', data: r.ok && !aparte.length ? r.data : safeJson(text), problems: [...(r.problems || []), ...aparte] };
}
function safeJson(text) { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }

/** De qué clon es cada archivo en el núcleo (el perfil del equipo o el repo de operaciones). */
const REPO_OF = Object.freeze({ repos: 'perfil', operations: 'operaciones' });

/**
 * Lee el archivo de una sección del clon. `{ doc }` si es un objeto JSON; `{ doc: null }` si no existe (ni con el nombre
 * viejo); `{ problem }` si existe y no se puede leer o no es un objeto JSON. Si existen los dos nombres gana el nuevo,
 * esté sano o no (la misma regla que el arnés): un archivo nuevo roto no se cambia en silencio por el viejo.
 */
function readSectionFile(clone, section) {
  for (const name of [section.archivo, section.archivoViejo].filter(Boolean)) {
    let text;
    try { text = fs.readFileSync(path.join(clone, name), 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { doc: null, problem: `no pude leer ${name} (${(e && e.code) || 'error'})` };
    }
    const doc = safeJson(text);
    return doc ? { doc } : { doc: null, problem: `${name} no es un objeto JSON válido` };
  }
  return { doc: null };
}

/**
 * Las secciones del núcleo que viven en el clon de un archivo, con sus datos tal como están (sólo las claves de la sección)
 * y los problemas del lector que caen en ellas. Un archivo que no se pudo leer o no es JSON se dice en la sección que lo
 * usa (con la ruta vacía). Sin núcleo o sin clon: lista vacía.
 */
function sectionsOf(target, clone, core, problems) {
  if (!core || cloneProblem(clone)) return [];
  return core.SECCIONES.filter((s) => s.repo === REPO_OF[target.id]).map((s) => {
    const { doc, problem } = readSectionFile(clone, s);
    let data = null;
    if (doc) {
      if (!s.claves) data = doc;
      else { data = {}; for (const k of s.claves) if (Object.prototype.hasOwnProperty.call(doc, k)) data[k] = doc[k]; }
    }
    // el archivo principal ya trae los problemas de su lector; el de otro archivo, el motivo de no haberlo leído
    const mine = s.archivo === target.file
      ? (problems || []).filter((x) => !s.claves || s.claves.some((k) => x.path === k || String(x.path).startsWith(`${k}.`)))
      : (problem ? [{ path: '', message: problem }] : []);
    return { id: s.id, titulo: s.titulo, archivo: s.archivo, data, problems: mine };
  });
}

/** La dirección del sitio de operations.json: https, sin usuario ni clave, sin espacios ni caracteres de control, de largo razonable. */
function siteUrlOk(v) {
  if (typeof v !== 'string' || v.length > 300 || /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname; } catch { return false; }
}

// ── el navegador ──────────────────────────────────────────────────────────────────────────────────────────────────
/** El comando que abre una dirección en el navegador de cada sistema. En Windows, `start` es de cmd y su primer argumento entre comillas es el título. */
function browserCommand(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  return ['xdg-open', [url]];
}

// ── el servidor ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Arranca la página. `opts`: tree (el árbol del arnés), clones ({ repos, operations }: las carpetas declaradas),
 * setClone(target, dir) → { ok, message } (guarda la clave de la máquina; lo da harness.js), readers y core (sólo pruebas:
 * los lectores y el núcleo de las secciones, en lugar de los del árbol),
 * env, port (0 = al azar). Devuelve { url, port, token, close, done } — `done` se resuelve cuando la página se cierra.
 */
function start(opts = {}) {
  const tree = opts.tree;
  const clones = { ...(opts.clones || {}) };
  const token = crypto.randomBytes(24).toString('hex');
  const nonce = () => crypto.randomBytes(16).toString('base64');
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const server = http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { ok: false, message: `falla interna: ${e && e.message ? e.message : e}` })));
  const loaded = loadCore(tree, opts.core);
  const state = () => TARGETS.map((t) => {
    const r = readTarget(t, clones[t.id], loadReader(tree, t, opts.readers));
    return { ...r, sections: sectionsOf(t, clones[t.id], loaded.core, r.problems) };
  });
  /** La dirección del sitio, de operations.json (`site.url`), o null; y el aviso que la página dice arriba. */
  const siteOf = (targets) => {
    const ops = targets.find((x) => x.id === 'operations');
    const url = ops && ops.data && ops.data.site && ops.data.site.url;
    return siteUrlOk(url) ? url : null;
  };
  // «sin sitio» sólo si se pudo leer operations.json y no declara uno: si no se pudo leer, no se sabe y se dice
  const noticeOf = (site, targets) => {
    if (site) return `la configuración de la organización se edita en el sitio: ${site}`;
    const ops = targets.find((x) => x.id === 'operations');
    if (ops && (ops.state === 'loaded' ? ops.data === null : ops.state !== 'new')) return 'no sé dónde se edita la configuración: no se pudo leer operations.json (abajo dice por qué); se edita en el sitio de la organización o con un pedido al repo de operaciones';
    // declarada pero inservible: no es «sin sitio», es una dirección que hay que corregir
    if (ops && ops.data && ops.data.site && ops.data.site.url !== undefined) return 'la dirección del sitio de operations.json (site.url) no sirve: tiene que ser https://…, sin usuario ni espacios; mientras tanto se edita con un pedido al repo de operaciones';
    return 'sin sitio: se edita con un pedido al repo de operaciones';
  };

  function send(res, code, body, headers = {}) {
    const isText = typeof body === 'string';
    res.writeHead(code, { 'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) { reject(new Error('el pedido es demasiado grande')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('el cuerpo no es JSON')); } });
      req.on('error', reject);
    });
  }
  async function handle(req, res) {
    const port = server.address().port;
    const self = `127.0.0.1:${port}`;
    if (req.headers.host !== self) return send(res, 403, { ok: false, message: 'esta página sólo contesta en su propia dirección' });
    const u = new URL(req.url, `http://${self}`);
    if (req.method === 'GET' && u.pathname === '/') {
      if (u.searchParams.get('k') !== token) return send(res, 403, '<!doctype html><meta charset="utf-8"><p>Esta dirección no tiene la llave de la página. Abrila con la que imprimió <code>harness.js team-config</code>.</p>');
      const n = nonce();
      return send(res, 200, page(n), { 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
    }
    if (!u.pathname.startsWith('/api/')) return send(res, 404, { ok: false, message: 'no existe' });
    if (req.headers['x-harness-key'] !== token) return send(res, 403, { ok: false, message: 'falta la llave de la página' });
    if (req.method === 'GET' && u.pathname === '/api/state') {
      const targets = state();
      const site = siteOf(targets);
      return send(res, 200, { ok: true, targets, site, notice: noticeOf(site, targets), coreProblem: loaded.problem, mailbox: mailboxSummary(tree, opts.mailboxFile) });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'método no permitido' });
    if (req.headers.origin && req.headers.origin !== `http://${self}`) return send(res, 403, { ok: false, message: 'pedido desde otra página' });
    if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, message: 'se espera JSON' });
    // la edición vive en el sitio: se contesta sin leer el cuerpo y sin tocar nada
    if (RETIRED.has(u.pathname)) return send(res, 410, { ok: false, message: 'la configuración se mudó al sitio: esta página es de sólo lectura' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, message: e.message }); }
    if (u.pathname === '/api/quit') { send(res, 200, { ok: true }); close(); return undefined; }
    const target = targetById(body && body.target);
    if (!target) return send(res, 400, { ok: false, message: 'archivo desconocido' });
    if (u.pathname === '/api/clone') {
      const dir = expandHome(String(body.dir || '').trim(), opts.home);
      const why = cloneProblem(dir);
      if (why) return send(res, 200, { ok: false, message: why });
      const r = opts.setClone ? opts.setClone(target, dir) : { ok: true };
      if (!r.ok) return send(res, 200, { ok: false, message: r.message });
      clones[target.id] = dir;
      return send(res, 200, { ok: true, message: r.message || `carpeta guardada (${target.configKey})` });
    }
    return send(res, 404, { ok: false, message: 'no existe' });
  }
  function close() {
    server.close(() => finish());
    server.closeAllConnections && server.closeAllConnections();
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/?k=${token}`, port, token, close, done, server });
    });
  });
}

// ── la página ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Todo inline, con el nonce de la respuesta: nada se carga de afuera. Los textos se ponen con textContent, nunca con
// innerHTML: lo que trae un archivo (un nombre, un motivo del lector) no puede volverse marcado.
function page(n) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configuración de la organización</title>
<style nonce="${n}">
:root{--bg:#fafaf7;--fg:#1d1d1b;--muted:#5d5d58;--line:#d9d8d0;--bad:#b3261e;--ok:#1e6b34;--accent:#2b4c7e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a4a39c;--line:#3a3a36;--bad:#f2766d;--ok:#7bc58f;--accent:#8fb0e3;--card:#1f1f1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:0 0 4px}
.muted{color:var(--muted)}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:20px 0}
.row>*{min-width:0}.row{display:grid;grid-template-columns:150px 140px 1fr 1fr 1fr auto;gap:8px;align-items:start;margin:8px 0}
@media (max-width:720px){.row{grid-template-columns:1fr 1fr}.bar input{flex:1 1 100%}}
label{display:block;font-size:12px;color:var(--muted)}input,select{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
input.bad,select.bad{border-color:var(--bad)}.err{color:var(--bad);font-size:13px}.okmsg{color:var(--ok)}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.sec{background:transparent;color:var(--accent)}.bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:13px}
.k{font-weight:600}p,li,pre,.err,.okmsg{overflow-wrap:anywhere}
</style></head><body><main>
<h1>Configuración de la organización</h1>
<p class="muted">Esta página sólo muestra lo que hay en tus clones: no cambia la configuración de la organización ni sale de esta máquina (sólo recuerda dónde están tus clones).</p>
<div id="app"><p class="muted">Cargando…</p></div>
<div class="bar"><button class="sec" id="quit">Cerrar la página</button></div>
</main>
<script nonce="${n}">
(() => {
const KEY = new URLSearchParams(location.search).get('k');
history.replaceState(null, '', '/');
const app = document.getElementById('app');
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c) e.append(c); return e; };
// una llamada que falla (el servidor ya se cerró, una respuesta que no es JSON) vuelve como { ok: false, message }: quien llama lo dice en la página
const api = async (p, body) => { try { const r = await fetch('/api/' + p, { method: body ? 'POST' : 'GET', headers: { 'x-harness-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return await r.json(); } catch (e) { return { ok: false, message: 'no pude hablar con la página local (' + e.message + ')' }; } };
const S = { targets: [], site: null, notice: '', coreProblem: null, mailbox: null };
// el buzón de corridas, sólo lectura — la página nunca recibe la firma
function mailboxSection(m) {
  const s = el('section', {}, el('h2', { text: 'El buzón de ejecuciones' }), el('p', { class: 'muted', text: 'Sólo lectura: la llave es una credencial y esta página no la muestra ni la guarda. Se cambia en el archivo de la capa del equipo (scripts/metrics/corridas-buzon.json).' }));
  if (!m || !m.hay) { s.append(el('p', { text: m && m.problema ? 'El buzón no se pudo leer: ' + m.problema : 'sin buzón: esta organización no sube ejecuciones' })); return s; }
  s.append(el('ul', {},
    el('li', { text: 'Cuenta: ' + m.cuenta }), el('li', { text: 'Contenedor: ' + m.contenedor }),
    el('li', { text: 'Política: ' + (m.politica || 'sin nombre') }), el('li', { text: 'Vence: ' + m.vence }),
    el('li', { text: 'Permisos propios de la firma: ' + (m.permisos_propios || 'ninguno (los toma de la política)') })));
  s.append(el('p', { text: '«Sólo crear» no se puede comprobar desde esta página. Lo comprueba una máquina del equipo con:' }), el('pre', { text: 'node scripts/metrics/upload-runs.js --check-create-only' }));
  return s;
}
async function load() { const r = await api('state'); if (!r.ok) throw new Error(r.message || 'el servidor no contestó'); S.targets = r.targets; S.site = r.site; S.notice = r.notice; S.coreProblem = r.coreProblem; S.mailbox = r.mailbox || null; render(); }

function problemList(list) {
  return list.length ? el('ul', {}, ...list.map((x) => el('li', { class: 'err', text: (x.path ? x.path + ': ' : '') + x.message }))) : null;
}
function sectionBox(s) {
  const box = el('div', {}, el('h3', { text: s.titulo }), el('p', { class: 'muted', text: 'Archivo: ' + s.archivo }));
  if (s.problems.length) box.append(el('div', { class: 'err', text: s.problems.length + ' cosa(s) para corregir (en el sitio):' }), problemList(s.problems));
  box.append(s.data === null ? el('p', { class: 'muted', text: 'sin datos en este archivo' }) : el('pre', { text: JSON.stringify(s.data, null, 2) }));
  return box;
}
function section(t) {
  const s = el('section', {}, el('h2', { text: t.title }), el('p', { class: 'muted', text: t.reach + ' Archivo: ' + t.file + ', en el clon de ' + t.repoName + '.' }));
  if (t.state === 'no-reader' || t.state === 'unreadable') { s.append(el('p', { class: 'err', text: t.message })); return s; }
  if (t.state === 'needs-clone') {
    const dir = el('input', { placeholder: 'carpeta del clon (ruta completa)' });
    const note = el('div', {});
    s.append(el('p', { text: 'Falta saber dónde está tu clon de ' + t.repoName + ' (' + t.message + '). Se guarda una sola vez en esta máquina (' + t.configKey + ').' }), dir,
      el('div', { class: 'bar' }, el('button', { text: 'Usar esta carpeta', onclick: async () => { const r = await api('clone', { target: t.id, dir: dir.value }); if (r.ok) load().catch((e) => note.replaceChildren(el('div', { class: 'err', text: 'No pude volver a cargar la página: ' + e.message }))); else note.replaceChildren(el('div', { class: 'err', text: r.message })); } })), note);
    return s;
  }
  s.append(el('p', { class: 'muted', text: 'Clon: ' + t.clone + (t.state === 'new' ? ' — el archivo todavía no existe.' : '') }));
  // todos los problemas arriba, con su clave: uno sin sección en la pantalla (una clave desconocida) no se pierde
  const all = t.problems || [];
  if (all.length) s.append(el('div', { class: 'err', text: all.length + ' cosa(s) para corregir (en el sitio):' }), problemList(all));
  if (t.sections.length) for (const x of t.sections) s.append(sectionBox(x));
  else if (t.data) s.append(el('pre', { text: JSON.stringify(t.data, null, 2) }));
  return s;
}
function render() {
  const head = el('p', { id: 'aviso', class: 'k', text: S.notice });
  const core = S.coreProblem ? el('p', { class: 'err', text: S.coreProblem }) : null;
  app.replaceChildren(...[head, core].filter(Boolean), ...S.targets.map(section), mailboxSection(S.mailbox));
}
document.getElementById('quit').addEventListener('click', async () => {
  const r = await api('quit', {});
  app.replaceChildren(el('p', r.ok ? { text: 'Página cerrada. Podés cerrar esta pestaña.' } : { class: 'err', text: 'No pude cerrar la página: ' + (r.message || 'el servidor no contestó') }));
});
load().catch((e) => app.replaceChildren(el('p', { class: 'err', text: 'No pude cargar la página: ' + e.message })));
})();
</script></body></html>`;
}

/**
 * El buzón de corridas de la organización, para mostrar: una PROYECCIÓN de la llave
 * (`scripts/metrics/corridas-buzon.json` de la capa del equipo, leída con `leerConfig` del árbol) — cuenta, contenedor,
 * política, vencimiento, los permisos propios de la firma si los trae, y los NOMBRES de sus parámetros. La firma no
 * sale de acá: la llave es una credencial y la página no guarda credenciales. Sin el archivo: `{ hay: false }`.
 */
function mailboxSummary(tree, file) {
  let lib;
  const guion = path.join(tree, 'scripts', 'metrics', 'upload-runs.js');
  try { lib = require(guion); }
  catch (e) {
    // sólo «el archivo no está» es «esta versión no lo trae»; otro error (uno de sintaxis, una dependencia que falta) se dice con su código
    if (e && e.code === 'MODULE_NOT_FOUND' && !fs.existsSync(guion)) return { hay: false, problema: 'esta versión del arnés no trae la subida al buzón' };
    return { hay: false, problema: `no se pudo cargar scripts/metrics/upload-runs.js (${(e && (e.code || e.name)) || 'error'})` };
  }
  const lc = lib.leerConfig(['cuenta', 'contenedor', 'sas', 'vence'], file || undefined);
  if (!lc.cfg) return lc.estado === 'sin_config' ? { hay: false } : { hay: false, problema: lc.motivo };
  const firma = new URLSearchParams(lc.cfg.sas);
  return {
    hay: true,
    cuenta: lc.cfg.cuenta,
    contenedor: lc.cfg.contenedor,
    politica: typeof lc.cfg.politica === 'string' ? lc.cfg.politica : null,
    vence: lc.cfg.vence,
    permisos_propios: firma.get('sp') || null,
    parametros: [...new Set(firma.keys())],
  };
}

/** Las carpetas que la máquina ya declaró (`paths.team`, `paths.operations`), o null. Sin configuración legible: null (la página las pide). */
function declaredClones({ env = process.env } = {}) {
  let p = {};
  try {
    const j = JSON.parse(fs.readFileSync(require('./tycon-home.js').ownPaths({ env }).config, 'utf8'));
    if (j && j.paths && typeof j.paths === 'object') p = j.paths;
  } catch (_) { /* sin configuración: se piden */ }
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { repos: pick(p.team), operations: pick(p.operations) };
}

module.exports = { TARGETS, RETIRED, start, declaredClones, mailboxSummary, readTarget, sectionsOf, browserCommand, cloneProblem, loadReader, loadCore };
