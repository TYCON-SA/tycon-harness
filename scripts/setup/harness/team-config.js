'use strict';
// team-config.js — la página local para configurar la organización: `harness.js team-config`.
//
// Qué resuelve: quien mantiene el arnés en una organización tiene que declarar dónde vive cada repo (team-repos.json, en
// el clon del perfil del equipo, que llega a todas las máquinas) y a quién se le asignan los avisos y los Bugs de los
// nocturnos (operations.json, en el clon del repo de operaciones, que no se instala). Escribir esos JSON a mano es fácil de
// romper; esta página los muestra como formularios, los valida con los MISMOS lectores que usa el arnés
// (scripts/lib/team-repos.js y scripts/lib/operations-config.js: acá no hay un validador propio) y, al guardar, ofrece el
// commit y el pedido en el repo de cada archivo.
//
// Es una página LOCAL: un servidor en 127.0.0.1, en un puerto al azar, que sólo contesta a quien trae la llave de un solo
// uso de la dirección que abre el navegador. No carga nada de afuera, no guarda credenciales y no sale a la red salvo
// cuando la persona confirma el pedido (git y, si están, gh o az, con las credenciales que ya tiene la máquina).
// Defensas: el encabezado Host tiene que ser el de la página (un sitio de afuera no puede hablarle por un nombre que
// resuelva a 127.0.0.1), la llave va en un encabezado propio en cada llamada (otra pestaña no la conoce), un POST con un
// Origin que no es el de la página se rechaza, y el cuerpo tiene tope.
//
// Las carpetas de los dos clones son claves de la máquina (`paths.team` y `paths.operations`, en ~/.tycon/config.json):
// las pide la página la primera vez y las guarda quien la lanzó (harness.js, con el mismo lector de configuración que
// `config set`). Sin el lector de un archivo en esta versión del arnés, esa parte de la página lo dice y no edita nada.
//
// Este archivo viaja en la copia fija del programa: no carga `scripts/lib/` por ruta relativa al cargar; los lectores se
// piden al árbol que se le pasa. Casos: scripts/tests/team-config.test.js.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

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
    reach: 'Este archivo no se instala en las máquinas: lo leen sólo los procesos de la noche.',
  }),
]);
const BODY_LIMIT = 256 * 1024;
const GIT_TIMEOUT_MS = 60 * 1000;

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
  return { ...out, state: 'loaded', data: r.ok ? r.data : safeJson(text), problems: r.problems || [] };
}
function safeJson(text) { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }

/** Cómo queda escrito: dos espacios y un salto final (lo que espera el diff de quien revisa el pedido). */
const formatJson = (data) => `${JSON.stringify(data, null, 2)}\n`;

/** Valida con el lector; sólo si está bien escribe (primero a un temporal en la misma carpeta, después lo cambia de nombre). */
function saveTarget(target, clone, reader, data) {
  if (!reader) return { ok: false, problems: [{ path: '', message: `esta versión del arnés no sabe leer ${target.file}` }] };
  const why = cloneProblem(clone);
  if (why) return { ok: false, problems: [{ path: '', message: why }] };
  const text = formatJson(data);
  const r = reader.parse(text);
  if (!r.ok) return { ok: false, problems: r.problems || [{ path: '', message: 'el lector lo rechazó sin decir por qué' }] };
  const file = path.join(clone, target.file);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { ok: true, file };
}

// ── el pedido ─────────────────────────────────────────────────────────────────────────────────────────────────────
function git(clone, args, env) {
  const r = spawnSync('git', ['-C', clone, ...args], { encoding: 'utf8', env, timeout: GIT_TIMEOUT_MS, windowsHide: true });
  return { ok: r.status === 0, raw: String(r.stdout || ''), out: String(r.stdout || '').trim(), err: String(r.stderr || (r.error && r.error.message) || '').trim() };
}

/** La plataforma y la dirección del repo, leídas del `origin` del clon. */
function remoteOf(url) {
  const u = String(url || '').trim();
  let m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u);
  if (m) return { platform: 'github', org: m[1], repo: m[2], web: `https://github.com/${m[1]}/${m[2]}` };
  m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/.exec(u.replace(/\/\/[^@/]+@/, '//'))
    || /([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)\/?$/.exec(u);
  if (m) return { platform: 'azure', org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]), web: `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}` };
  return { platform: null, web: null };
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * 🔴 La primera versión del arnés cuya lista cerrada de la capa admite `team-repos.json` (scripts/setup/harness/team.js).
 * Una máquina con una versión anterior rechaza la capa ENTERA si el perfil trae ese archivo: se quedaría sin perfil, sin
 * revisores y sin skills del equipo. Por eso la página propone el cambio al perfil SÓLO si su `team-layer.json` ya pide al
 * menos esta versión (`requires.harness`), y lo dice si no. Si este número cambia al mergear, se corrige acá.
 */
const TEAM_REPOS_SINCE = '2026.10.13.10';
const versionParts = (v) => { const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})\.(\d+)$/.exec(String(v || '').trim()); return m ? m.slice(1).map(Number) : null; };
const versionAtLeast = (v, min) => {
  const a = versionParts(v); const b = versionParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
/** `null` si el perfil de ese clon ya pide una versión que admite team-repos.json; si no, el motivo en llano. */
function profileGateProblem(clone) {
  let decl;
  try { decl = JSON.parse(fs.readFileSync(path.join(clone, 'team-layer.json'), 'utf8')); } catch (e) {
    return `no pude leer team-layer.json del clon del perfil (${(e && e.code) || e.message}), y sin él no sé qué versión del arnés piden las máquinas`;
  }
  const req = String(((decl || {}).requires || {}).harness || '');
  const m = /^>=\s*(\S+)$/.exec(req.trim());
  if (m && versionAtLeast(m[1], TEAM_REPOS_SINCE)) return null;
  return `todavía no se puede proponer: el perfil pide «${req || 'nada'}» en team-layer.json, y una máquina con una versión anterior a la ${TEAM_REPOS_SINCE} rechazaría la capa entera si trae team-repos.json. Primero se sube requires.harness a «>= ${TEAM_REPOS_SINCE}» (o más). El archivo quedó guardado en tu clon`;
}

/**
 * Lo que va a pasar si la persona confirma: los comandos, en orden. No corre nada. Frena si el clon tiene otros cambios
 * sin commitear (el pedido llevaría más de lo que se ve en la página) o si el archivo no cambió.
 */
function proposalPlan(target, clone, opts = {}) {
  const why = cloneProblem(clone);
  if (why) return { ok: false, message: why };
  if (target.id === 'repos') {
    const gate = profileGateProblem(clone);
    if (gate) return { ok: false, message: gate };
  }
  const env = opts.env || process.env;
  // `-z`: cada entrada «XY ruta» separada por un nulo, sin comillas ni recortes (la salida recortada perdía el espacio
  // inicial de la primera línea y con él la primera letra de la ruta)
  const status = git(clone, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env);
  if (!status.ok) return { ok: false, message: `git no pudo mirar el clon: ${status.err}` };
  const lines = status.raw.split('\0').filter(Boolean);
  const others = lines.map((l) => l.slice(3)).filter((f) => f && f !== target.file);
  if (others.length) return { ok: false, message: `el clon tiene otros cambios sin commitear (${others.slice(0, 5).join(', ')}${others.length > 5 ? '…' : ''}): el pedido llevaría más de lo que se ve acá. Ordenalo y volvé a intentar.` };
  if (!lines.length) return { ok: false, message: `${target.file} no tiene cambios para proponer: guardá primero` };
  const origin = git(clone, ['remote', 'get-url', 'origin'], env);
  if (!origin.ok) return { ok: false, message: 'el clon no tiene un remoto «origin»: no hay adónde mandar el pedido' };
  const remote = remoteOf(origin.out);
  const head = git(clone, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], env);
  const base = head.ok && head.out.startsWith('origin/') ? head.out.slice('origin/'.length) : 'main';
  const branch = `team-config/${target.id}-${stamp(opts.now || new Date())}`;
  const title = `Configuración de la organización: ${target.file}`;
  const body = `${target.title}. Cambio hecho con la página de configuración del arnés (harness.js team-config).`;
  const commands = [
    ['git', 'switch', '-c', branch],
    ['git', 'add', '--', target.file],
    ['git', 'commit', '-m', title],
    ['git', 'push', '-u', 'origin', branch],
  ];
  let pr = null;
  if (remote.platform === 'github') pr = ['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
  if (remote.platform === 'azure') pr = ['az', 'repos', 'pr', 'create', '--detect', 'true', '--source-branch', branch, '--target-branch', base, '--title', title, '--description', body];
  const manual = remote.platform === 'github' ? `${remote.web}/compare/${base}...${branch}?expand=1`
    : remote.platform === 'azure' ? `${remote.web}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}&targetRef=${encodeURIComponent(base)}` : null;
  return { ok: true, branch, base, remote, commands, pr, manual };
}

/** ¿El rechazo es por permisos? Los textos de git, de GitHub y de Azure DevOps cuando la cuenta no puede escribir. */
const NO_PERMISSION = /\b403\b|permission|denied|not authorized|unauthori[sz]ed|insufficient|TF401027|TF401019|forbidden|Write access/i;

/** Corre el plan. Cada paso con su resultado; en el primer fallo para, y lo dice en llano. */
function runProposal(target, clone, opts = {}) {
  const plan = proposalPlan(target, clone, opts);
  if (!plan.ok) return { ok: false, message: plan.message, steps: [] };
  const env = opts.env || process.env;
  const run = opts.run || ((cmd) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: clone, encoding: 'utf8', env, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return { ok: r.status === 0, missing: !!(r.error && r.error.code === 'ENOENT'), out: String(r.stdout || '').trim(), err: String(r.stderr || (r.error && r.error.message) || '').trim() };
  });
  const steps = [];
  for (const cmd of plan.commands) {
    const r = run(cmd);
    steps.push({ cmd, ok: r.ok, out: r.out, err: r.err });
    if (!r.ok) {
      const push = cmd[1] === 'push';
      const message = push && NO_PERMISSION.test(r.err)
        ? `No tenés permiso para escribir en el repo de ${target.repoName}. El cambio quedó guardado en tu clon, en la rama ${plan.branch}: pedile permiso a quien administra ese repo, o mandale el archivo ${target.file}.`
        : `Falló «${cmd.join(' ')}»: ${r.err || 'sin motivo'}${push ? ` — el cambio quedó en tu clon, en la rama ${plan.branch}` : ''}`;
      return { ok: false, message, branch: plan.branch, steps };
    }
  }
  if (!plan.pr) return { ok: true, branch: plan.branch, message: `El cambio subió a la rama ${plan.branch}. No reconozco la plataforma del remoto: abrí el pedido a mano.`, steps };
  const r = run(plan.pr);
  steps.push({ cmd: plan.pr, ok: r.ok, out: r.out, err: r.err });
  if (r.ok) return { ok: true, branch: plan.branch, message: `Pedido abierto. ${r.out.split('\n').find((l) => /^https?:\/\//.test(l)) || ''}`.trim(), steps };
  const tool = plan.pr[0];
  const why = r.missing ? `no encontré «${tool}» en esta máquina` : NO_PERMISSION.test(r.err) ? 'tu cuenta no tiene permiso para abrir pedidos en ese repo' : (r.err || 'sin motivo');
  return { ok: false, branch: plan.branch, manual: plan.manual, message: `El cambio subió a la rama ${plan.branch}, pero no pude abrir el pedido (${why}). Abrilo desde: ${plan.manual}`, steps };
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
 * setClone(target, dir) → { ok, message } (guarda la clave de la máquina; lo da harness.js), readers (sólo pruebas),
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
  const state = () => TARGETS.map((t) => readTarget(t, clones[t.id], loadReader(tree, t, opts.readers)));

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
    if (req.method === 'GET' && u.pathname === '/api/state') return send(res, 200, { ok: true, targets: state(), mailbox: mailboxSummary(tree, opts.mailboxFile) });
    if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'método no permitido' });
    if (req.headers.origin && req.headers.origin !== `http://${self}`) return send(res, 403, { ok: false, message: 'pedido desde otra página' });
    if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, message: 'se espera JSON' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, message: e.message }); }
    if (u.pathname === '/api/quit') { send(res, 200, { ok: true }); close(); return undefined; }
    const target = targetById(body && body.target);
    if (!target) return send(res, 400, { ok: false, message: 'archivo desconocido' });
    const reader = loadReader(tree, target, opts.readers);
    const clone = clones[target.id];
    if (u.pathname === '/api/clone') {
      const dir = expandHome(String(body.dir || '').trim(), opts.home);
      const why = cloneProblem(dir);
      if (why) return send(res, 200, { ok: false, message: why });
      const r = opts.setClone ? opts.setClone(target, dir) : { ok: true };
      if (!r.ok) return send(res, 200, { ok: false, message: r.message });
      clones[target.id] = dir;
      return send(res, 200, { ok: true, message: r.message || `carpeta guardada (${target.configKey})` });
    }
    if (u.pathname === '/api/check') {
      if (!reader) return send(res, 200, { ok: false, problems: [{ path: '', message: `esta versión del arnés no sabe leer ${target.file}` }] });
      const r = reader.parse(formatJson(body.data));
      return send(res, 200, { ok: !!r.ok, problems: r.problems || [] });
    }
    if (u.pathname === '/api/save') return send(res, 200, saveTarget(target, clone, reader, body.data));
    if (u.pathname === '/api/plan') return send(res, 200, proposalPlan(target, clone, { env: opts.env }));
    if (u.pathname === '/api/propose') return send(res, 200, runProposal(target, clone, { env: opts.env, run: opts.run }));
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
<p class="muted">Cada parte se guarda en el archivo de su repo, y después podés proponer el cambio con un pedido. Nada sale de esta máquina hasta que lo confirmes.</p>
<div id="app"><p class="muted">Cargando…</p></div>
<div class="bar"><button class="sec" id="quit">Cerrar la página</button></div>
</main>
<script nonce="${n}">
(() => {
const KEY = new URLSearchParams(location.search).get('k');
history.replaceState(null, '', '/');
const app = document.getElementById('app');
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c) e.append(c); return e; };
const api = async (p, body) => { const r = await fetch('/api/' + p, { method: body ? 'POST' : 'GET', headers: { 'x-harness-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const REPO_SLOTS = [['public', 'El arnés público', 'el que instala cada máquina', true], ['profile', 'El perfil del equipo', 'la configuración que llega a cada máquina', true], ['operations', 'Las operaciones', 'lo que corre de noche para la organización', true], ['maintainers', 'El mantenimiento', 'sólo si tu organización mantiene el arnés', false]];
const clone = (v) => JSON.parse(JSON.stringify(v));

function problemsAt(problems, p) { return problems.filter((x) => x.path === p || x.path.startsWith(p + '.')); }
function field(label, value, onInput, p, problems, attrs = {}) {
  const mine = problems.filter((x) => x.path === p);
  const input = el('input', { value: value == null ? '' : String(value), oninput: (e) => onInput(e.target.value), 'data-path': p, ...attrs });
  if (mine.length) input.className = 'bad';
  return el('div', {}, el('label', { text: label }), input, ...mine.map((x) => el('div', { class: 'err', text: x.message })));
}
function repoRow(title, hint, repo, set, p, problems, removable) {
  const r = repo || { platform: 'azure', org: '', project: '', repo: '' };
  const plat = el('select', { 'data-path': p + '.platform', onchange: (e) => { const v = e.target.value; const nr = { platform: v, org: r.org || '', repo: r.repo || '' }; if (v === 'azure') nr.project = r.project || ''; set(nr); } },
    el('option', { value: 'azure', text: 'Azure DevOps' }), el('option', { value: 'github', text: 'GitHub' }));
  plat.value = r.platform === 'github' ? 'github' : 'azure';
  if (problemsAt(problems, p + '.platform').length) plat.className = 'bad';
  const upd = (k) => (v) => { r[k] = v; set(r); };
  return el('div', { class: 'row' },
    el('div', {}, el('div', { class: 'k', text: title }), el('div', { class: 'muted', text: hint })),
    el('div', {}, el('label', { text: 'plataforma' }), plat, ...problemsAt(problems, p + '.platform').map((x) => el('div', { class: 'err', text: x.message }))),
    field(r.platform === 'github' ? 'organización o usuario' : 'organización', r.org, upd('org'), p + '.org', problems),
    r.platform === 'github' ? el('div', {}) : field('proyecto', r.project, upd('project'), p + '.project', problems),
    field('repo', r.repo, upd('repo'), p + '.repo', problems),
    removable ? el('button', { class: 'sec', text: 'Quitar', onclick: removable }) : el('div', {}));
}
function listField(label, list, set, p, problems) {
  const box = el('div', {}, el('label', { text: label }));
  (list || []).forEach((v, i) => box.append(el('div', { class: 'row' }, field('identidad', v, (nv) => { list[i] = nv; set(list); }, p + '.' + i, problems), el('button', { class: 'sec', text: 'Quitar', onclick: () => { list.splice(i, 1); set(list); render(); } }))));
  box.append(el('button', { class: 'sec', text: 'Agregar revisor en ' + label.toLowerCase(), onclick: () => { list.push(''); set(list); render(); } }));
  for (const x of problems.filter((x) => x.path === p)) box.append(el('div', { class: 'err', text: x.message }));
  return box;
}

const S = { targets: [], drafts: {}, problems: {}, notes: {}, mailbox: null };
// story 2.24: el buzón de corridas, sólo lectura — la página nunca recibe la firma
function mailboxSection(m) {
  const s = el('section', {}, el('h2', { text: 'El buzón de corridas' }), el('p', { class: 'muted', text: 'Sólo lectura: la llave es una credencial y esta página no la muestra ni la guarda. Se cambia en el archivo de la capa del equipo (scripts/metrics/corridas-buzon.json).' }));
  if (!m || !m.hay) { s.append(el('p', { text: m && m.problema ? 'El buzón no se pudo leer: ' + m.problema : 'sin buzón: esta organización no sube corridas' })); return s; }
  s.append(el('ul', {},
    el('li', { text: 'Cuenta: ' + m.cuenta }), el('li', { text: 'Contenedor: ' + m.contenedor }),
    el('li', { text: 'Política: ' + (m.politica || 'sin nombre') }), el('li', { text: 'Vence: ' + m.vence }),
    el('li', { text: 'Permisos propios de la firma: ' + (m.permisos_propios || 'ninguno (los toma de la política)') })));
  s.append(el('p', { text: '«Sólo crear» no se puede comprobar desde esta página. Lo comprueba una máquina del equipo con:' }), el('pre', { text: 'node scripts/metrics/upload-runs.js --check-create-only' }));
  return s;
}
async function load() { const r = await api('state'); S.targets = r.targets; S.mailbox = r.mailbox || null; for (const t of r.targets) { S.drafts[t.id] = clone(t.data || (t.id === 'repos' ? { version: 1 } : { version: 1, owners: { default: '' } })); S.problems[t.id] = t.problems || []; } render(); }

function editor(t) {
  const d = S.drafts[t.id]; const pr = S.problems[t.id] || [];
  if (t.id === 'repos') {
    const box = el('div', {});
    for (const [k, title, hint, required] of REPO_SLOTS) {
      if (!required && !d[k]) { box.append(el('div', { class: 'bar' }, el('button', { class: 'sec', text: 'Agregar: ' + title.toLowerCase(), onclick: () => { d[k] = { platform: 'azure', org: '', project: '', repo: '' }; render(); } }), el('span', { class: 'muted', text: hint }))); continue; }
      box.append(repoRow(title, hint, d[k], (v) => { d[k] = v; }, k, pr, required ? null : () => { delete d[k]; render(); }));
    }
    box.append(el('h3', { text: 'Copias del arnés en la organización' }), el('p', { class: 'muted', text: 'Los repos que son copias del arnés, para que las métricas no cuenten dos veces la misma historia: de ellas se mide sólo la de mantenimiento, si está en la lista. Opcional.' }));
    (d.harness_copies || []).forEach((rp, i) => box.append(repoRow('Copia ' + (i + 1), '', rp, (v) => { d.harness_copies[i] = v; }, 'harness_copies.' + i, pr, () => { d.harness_copies.splice(i, 1); if (!d.harness_copies.length) delete d.harness_copies; render(); })));
    box.append(el('button', { class: 'sec', text: 'Agregar una copia', onclick: () => { (d.harness_copies = d.harness_copies || []).push({ platform: 'azure', org: '', project: '', repo: '' }); render(); } }));
    return box;
  }
  d.owners = d.owners || { default: '' };
  const box = el('div', {});
  box.append(field('Responsable por defecto (el nombre único en Azure DevOps, o el usuario de GitHub)', d.owners.default, (v) => { d.owners.default = v; }, 'owners.default', pr));
  box.append(el('h3', { text: 'Responsable por proyecto' }), el('p', { class: 'muted', text: 'Opcional: manda sobre lo que se deduce de los administradores de cada proyecto.' }));
  const byp = d.owners.by_project || {};
  for (const name of Object.keys(byp)) {
    box.append(el('div', { class: 'row' }, field('proyecto', name, (v) => { if (v !== name && v) { byp[v] = byp[name]; delete byp[name]; } }, 'owners.by_project', pr, { disabled: 'disabled' }), field('responsable', byp[name], (v) => { byp[name] = v; }, 'owners.by_project.' + name, pr), el('button', { class: 'sec', text: 'Quitar', onclick: () => { delete byp[name]; if (!Object.keys(byp).length) delete d.owners.by_project; render(); } })));
  }
  const np = el('input', { placeholder: 'nombre del proyecto' });
  box.append(el('div', { class: 'bar' }, np, el('button', { class: 'sec', text: 'Agregar proyecto', onclick: () => { const v = np.value.trim(); if (!v) return; d.owners.by_project = d.owners.by_project || {}; d.owners.by_project[v] = ''; render(); } })));
  d.reviewers = d.reviewers || {};
  box.append(el('h3', { text: 'Quiénes revisan los pedidos de la noche' }));
  box.append(listField('Dependencias', d.reviewers.dependencies = d.reviewers.dependencies || [], (l) => { d.reviewers.dependencies = l; }, 'reviewers.dependencies', pr));
  box.append(listField('Vigilante de producción', d.reviewers.watcher = d.reviewers.watcher || [], (l) => { d.reviewers.watcher = l; }, 'reviewers.watcher', pr));
  return box;
}
function tidy(t) {
  const d = clone(S.drafts[t.id]);
  if (t.id === 'operations' && d.reviewers) { for (const k of ['dependencies', 'watcher']) if (Array.isArray(d.reviewers[k]) && !d.reviewers[k].length) delete d.reviewers[k]; if (!Object.keys(d.reviewers).length) delete d.reviewers; }
  return d;
}
function section(t) {
  const s = el('section', {}, el('h2', { text: t.title }), el('p', { class: 'muted', text: t.reach + ' Archivo: ' + t.file + ', en el clon de ' + t.repoName + '.' }));
  if (t.state === 'no-reader' || t.state === 'unreadable') { s.append(el('p', { class: 'err', text: t.message })); return s; }
  if (t.state === 'needs-clone') {
    const dir = el('input', { placeholder: 'carpeta del clon (ruta completa)' });
    const note = el('div', {});
    s.append(el('p', { text: 'Falta saber dónde está tu clon de ' + t.repoName + ' (' + t.message + '). Se guarda una sola vez en esta máquina (' + t.configKey + ').' }), dir,
      el('div', { class: 'bar' }, el('button', { text: 'Usar esta carpeta', onclick: async () => { const r = await api('clone', { target: t.id, dir: dir.value }); if (r.ok) load(); else note.replaceChildren(el('div', { class: 'err', text: r.message })); } })), note);
    return s;
  }
  s.append(el('p', { class: 'muted', text: 'Clon: ' + t.clone + (t.state === 'new' ? ' — el archivo todavía no existe: se crea al guardar.' : '') }));
  // todos los problemas arriba, con su clave: uno sin campo en la pantalla (una clave desconocida) no se pierde
  const all = S.problems[t.id] || [];
  if (all.length) s.append(el('div', { class: 'err', text: all.length + ' cosa(s) para corregir:' }), el('ul', {}, ...all.map((x) => el('li', { class: 'err', text: (x.path ? x.path + ': ' : '') + x.message }))));
  s.append(editor(t));
  const note = el('div', { class: 'bar' });
  const show = (ok, text) => note.replaceChildren(el('div', { class: ok ? 'okmsg' : 'err', text }));
  s.append(el('div', { class: 'bar' },
    el('button', { class: 'sec', text: 'Revisar', onclick: async () => { const r = await api('check', { target: t.id, data: tidy(t) }); S.problems[t.id] = r.problems || []; render(); if (r.ok) showNote(t.id, true, 'Está bien escrito.'); } }),
    el('button', { text: 'Guardar', onclick: async () => { const r = await api('save', { target: t.id, data: tidy(t) }); S.problems[t.id] = r.problems || []; render(); showNote(t.id, r.ok, r.ok ? 'Guardado en ' + r.file + '.' : 'No se guardó: hay que corregir lo marcado.'); } }),
    el('button', { class: 'sec', text: 'Proponer el cambio (commit y pedido)', onclick: async () => { const p = await api('plan', { target: t.id }); if (!p.ok) return showNote(t.id, false, p.message); const cmds = p.commands.concat(p.pr ? [p.pr] : []).map((c) => c.join(' ')).join('\\n'); S.notes[t.id] = { confirm: true, text: 'Va a correr, en tu clon:\\n' + cmds }; render(); } })), note);
  const n = S.notes[t.id];
  if (n && n.confirm) {
    note.replaceChildren(el('pre', { text: n.text }), el('button', { text: 'Confirmar y mandar', onclick: async () => { S.notes[t.id] = null; const r = await api('propose', { target: t.id }); showNote(t.id, r.ok, r.message); } }), el('button', { class: 'sec', text: 'Cancelar', onclick: () => { S.notes[t.id] = null; render(); } }));
  } else if (n) show(n.ok, n.text);
  return s;
}
function showNote(id, ok, text) { S.notes[id] = { ok, text }; render(); }
function render() { app.replaceChildren(...S.targets.map(section), mailboxSection(S.mailbox)); }
document.getElementById('quit').addEventListener('click', async () => { await api('quit', {}); app.replaceChildren(el('p', { text: 'Página cerrada. Podés cerrar esta pestaña.' })); });
load().catch((e) => app.replaceChildren(el('p', { class: 'err', text: 'No pude cargar la página: ' + e.message })));
})();
</script></body></html>`;
}

/**
 * El buzón de corridas de la organización, para mostrar (story 2.24, AC 23): una PROYECCIÓN de la llave
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

module.exports = { TARGETS, start, declaredClones, mailboxSummary, readTarget, saveTarget, proposalPlan, runProposal, remoteOf, browserCommand, cloneProblem, formatJson, loadReader, NO_PERMISSION, TEAM_REPOS_SINCE, profileGateProblem };
