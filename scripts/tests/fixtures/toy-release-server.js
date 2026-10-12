#!/usr/bin/env node
'use strict';
// toy-release-server.js — el «GitHub» de juguete de las suites del mecanismo (story 8.23, tanda B).
//
// Imita lo que el arnés le pide a la API de GitHub para instalar y actualizar SIN git, sobre un repo bare del
// laboratorio (el remoto del arnés de harness-lab.sh): así las versiones se publican con las funciones de siempre
// (`harness_lab_publish_stable`, `harness_lab_publish_sync`) y el cliente no sabe que no habla con GitHub.
//
// Dos escuchas, como GitHub: la API (`/repos/<org>/<name>/…`, `/user`) y «codeload» en OTRO puerto —otro origen—, a
// donde redirige la bajada del comprimido con una llave temporal en la URL. Si a codeload le llega una cabecera
// `Authorization`, contesta 400 y lo anota: la credencial no tiene que viajar a otro host.
//
// Lo que atiende:
//   GET /repos/o/n/git/ref/heads/<ref…>            { ref, object: { sha, type } }           404 si la ref no existe
//   GET /repos/o/n/git/commits/<sha>               { sha, tree: { sha }, message }
//   GET /repos/o/n/commits?sha=<ref>&path=<p>&per_page=N   [{ sha, commit: { message } }]  (los que tocaron <p>)
//   GET /repos/o/n/contents/<ruta>?ref=<sha>       { content (base64), encoding, sha, size } con ETag; If-None-Match → 304
//                                                   con `Accept: application/vnd.github.raw`, los bytes del archivo (mismo ETag)
//   GET /repos/o/n/tarball/<sha>                   302 → codeload/o/n/legacy.tar.gz/<sha>?token=<llave>
//   GET /user                                      { login }   (401 sin credencial válida)
//   codeload: GET /o/n/legacy.tar.gz/<sha>?token=  el tar.gz de `git archive` (carpeta raíz <org>-<name>-<sha7>/ y la
//                                                   cabecera global pax con el commit, como el de GitHub)
//
// El archivo de control (`--control`, JSON, releído en cada pedido) cambia el comportamiento sin reiniciar:
//   auth        "none" (repo público) · "token:<valor>" (privado: sin credencial válida, /repos contesta 404 como
//               GitHub con un repo privado; con otra credencial, 401) · "invited:<valor>" (el permiso vale —/user 200—
//               pero el repo da 404: falta aceptar la invitación)
//   ratelimit   true → 403 con X-RateLimit-Remaining: 0
//   mute        true → acepta la conexión y no contesta nunca
//   ref_moved_to  <sha> → la ref contesta ese commit (la rama se movió); el comprimido del commit pedido sigue andando
//   truncate    true → el comprimido se corta a mitad
//   tamper      true → el comprimido trae un archivo cambiado (README.md): el árbol no coincide
//   latency_ms  n → espera antes de contestar
// La cuota se cuenta en memoria (`X-RateLimit-Remaining`): un 304 no la gasta, como en GitHub.
//
// El registro (`--log`): una línea JSON por pedido con método, host (api|codeload), ruta, si traía credencial y el
// sha256 de la credencial (nunca el valor: las pruebas buscan el valor en todo lo escrito).
//
// Uso: node toy-release-server.js --repo <bare> --org <o> --name <n> --control <json> --log <archivo> --port-file <archivo>
//   El archivo de puertos queda con `API=http://127.0.0.1:<p>` y `CODELOAD=http://127.0.0.1:<q>` cuando los dos escuchan.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

function arg(name, def = null) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def; }
// VARIOS repos (story 8.25): `--repo <bare> --org <o> --name <n>` repetibles, en orden; el primero es el público (el de
// siempre) y los demás, el repo del equipo de juguete. Cada uno tiene su control de acceso: `auth` global, o por repo con
// `auth_by_repo: { "<org>/<name>": "token:…" | "invited:…" | "none" }` (el permiso que ve un repo y no el otro, T8).
const REPOS = [];
for (let i = 0, cur = null; i < process.argv.length; i++) {
  const a = process.argv[i], v = process.argv[i + 1];
  if (a === '--repo' && v !== undefined) { cur = { bare: v, org: 'TYCON-LAB', name: 'arnes-lab' }; REPOS.push(cur); i++; }
  else if (a === '--org' && v !== undefined && cur) { cur.org = v; i++; }
  else if (a === '--name' && v !== undefined && cur) { cur.name = v; i++; }
}
const REPO = REPOS.length ? REPOS[0].bare : null, ORG = REPOS.length ? REPOS[0].org : 'TYCON-LAB', NAME = REPOS.length ? REPOS[0].name : 'arnes-lab';
const CONTROL = arg('--control'), LOG = arg('--log'), PORT_FILE = arg('--port-file');
// `--git <ruta>`: el git de verdad por ruta absoluta, para que un `git` testigo en el PATH no vea los del servidor
const GIT = arg('--git', 'git');
if (!REPO || !PORT_FILE) { process.stderr.write('uso: toy-release-server.js --repo <bare> --org <o> --name <n> [--repo <bare> --org <o> --name <n> …] [--git <ruta>] [--control <json>] [--log <archivo>] --port-file <archivo>\n'); process.exit(2); }

let remaining = 5000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const git = (args, opts = {}, bare = REPO) => spawnSync(GIT, ['-C', bare, ...args], Object.assign({ encoding: 'utf8' }, opts));
const control = () => { try { return JSON.parse(fs.readFileSync(CONTROL, 'utf8')); } catch (_) { return { auth: 'none' }; } };
const log = (o) => { if (LOG) { try { fs.appendFileSync(LOG, `${JSON.stringify(o)}\n`); } catch (_) { /* nada */ } } };
const keyOf = (r) => `${r.org}/${r.name}`;
/** El modo de acceso que rige para un repo: el suyo (`auth_by_repo`) o el global (`auth`). */
const modeFor = (c, r) => String((r && c.auth_by_repo && c.auth_by_repo[keyOf(r)]) || c.auth || 'none');
/** Todos los permisos que el servidor conoce (el global y los por repo): /user contesta 200 a cualquiera de ellos. */
const knownTokens = (c) => new Set([String(c.auth || 'none'), ...Object.values(c.auth_by_repo || {})].map(String).filter((m) => m.includes(':')).map((m) => m.slice(m.indexOf(':') + 1)));

function authOf(req, c, repo = null) {
  const h = req.headers.authorization || '';
  const m = /^(?:Bearer|token) (.+)$/.exec(h);
  const given = m ? m[1] : null;
  const mode = modeFor(c, repo);
  const want = mode.includes(':') ? mode.slice(mode.indexOf(':') + 1) : null;
  const known = given !== null && knownTokens(c).has(given);
  if (mode === 'none') return { ok: given === null || known, given, repoVisible: true, known };
  const valid = given !== null && given === want;
  return { ok: valid, given, repoVisible: valid && mode.startsWith('token:'), known };
}
const send = (res, code, body, headers = {}) => {
  const h = Object.assign({ 'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': String(remaining), 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600) }, headers);
  if (body === null) { res.writeHead(code, h); return res.end(); }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(code, Object.assign({ 'Content-Type': Buffer.isBuffer(body) ? 'application/x-gzip' : 'application/json', 'Content-Length': String(buf.length) }, h));
  res.end(buf);
};
const notFound = (res) => send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });

function api(req, res) {
  const c = control();
  const u = new URL(req.url, 'http://api');
  const repo = REPOS.find((r) => u.pathname.startsWith(`/repos/${keyOf(r)}/`)) || null;
  const a = authOf(req, c, repo);
  log({ host: 'api', method: req.method, path: u.pathname + u.search, repo: repo ? keyOf(repo) : null, auth: a.given !== null, auth_sha256: a.given !== null ? sha256(a.given) : null, ifNoneMatch: req.headers['if-none-match'] || null, via_proxy: req.headers['x-toy-proxy'] === '1' });
  const gitR = (args, opts = {}) => git(args, opts, repo ? repo.bare : REPO);
  const go = () => {
    if (c.mute) return;   // acepta y calla
    if (c.ratelimit) { remaining = 0; return send(res, 403, { message: 'API rate limit exceeded' }); }
    if (u.pathname === '/user') { if (a.given === null || !a.known) return send(res, 401, { message: 'Bad credentials' }); remaining--; return send(res, 200, { login: 'lab-user' }); }
    if (!repo) return notFound(res);
    const prefix = `/repos/${keyOf(repo)}/`;
    // un repo privado sin permiso válido es 404 (así contesta GitHub); con otro permiso que el servidor no conoce, 401. Un
    // permiso CONOCIDO que no ve ESTE repo: 404 (o 403 si el control pide `blind_status: 403`: GitHub contesta una u otra)
    if (!a.repoVisible) {
      if (a.given !== null && !a.known) return send(res, 401, { message: 'Bad credentials' });
      if (a.given !== null && a.known && Number(c.blind_status) === 403) return send(res, 403, { message: 'Resource not accessible by personal access token' });
      return notFound(res);
    }
    const rest = u.pathname.slice(prefix.length);
    const git = gitR;
    let m;
    if ((m = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      const ref = decodeURIComponent(m[1]);
      const r = git(['rev-parse', '--verify', '-q', `refs/heads/${ref}`]);
      if (r.status !== 0) return notFound(res);
      const sha = c.ref_moved_to || r.stdout.trim();
      // como GitHub: la ref también lleva ETag, y un If-None-Match igual es 304 sin gastar cuota
      const etag = `"ref-${sha}"`;
      if (req.headers['if-none-match'] === etag) return send(res, 304, null, { ETag: etag });
      remaining--;
      return send(res, 200, { ref: `refs/heads/${ref}`, object: { type: 'commit', sha } }, { ETag: etag });
    }
    if ((m = /^git\/commits\/([0-9a-f]{7,40})$/.exec(rest))) {
      const t = git(['rev-parse', '--verify', '-q', `${m[1]}^{tree}`]);
      if (t.status !== 0) return notFound(res);
      remaining--;
      return send(res, 200, { sha: git(['rev-parse', m[1]]).stdout.trim(), tree: { sha: t.stdout.trim() }, message: git(['log', '-1', '--format=%B', m[1]]).stdout });
    }
    // la lista del árbol (story 8.25): rutas con su modo, tipo, sha y tamaño; `?recursive=1` baja a las subcarpetas (y
    // nombra también los árboles, como GitHub). `truncated_tree` en el control simula la lista cortada
    if ((m = /^git\/trees\/([0-9a-f]{7,40})$/.exec(rest))) {
      const recursive = u.searchParams.get('recursive');
      const r = git(['ls-tree', '-l', ...(recursive ? ['-r', '-t'] : []), m[1]]);
      if (r.status !== 0) return notFound(res);
      remaining--;
      const tree = r.stdout.split('\n').filter(Boolean).map((l) => {
        const [meta, p] = l.split('\t');
        const [mode, type, sha, size] = meta.trim().split(/\s+/);
        const e = { path: p, mode, type, sha };
        if (type === 'blob') e.size = Number(size);
        return e;
      });
      return send(res, 200, { sha: git(['rev-parse', m[1]]).stdout.trim(), url: `${u.origin}${u.pathname}`, tree, truncated: Boolean(c.truncated_tree) });
    }
    if (rest === 'commits') {
      const sha = u.searchParams.get('sha') || 'main', p = u.searchParams.get('path'), n = parseInt(u.searchParams.get('per_page') || '30', 10);
      const r = git(['log', `--format=%H%x1f%B%x1e`, `-${n}`, sha, ...(p ? ['--', p] : [])]);
      if (r.status !== 0) return notFound(res);
      remaining--;
      return send(res, 200, r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => { const [h, msg] = s.split('\x1f'); return { sha: h, commit: { message: (msg || '').trim() } }; }));
    }
    if ((m = /^contents\/(.+)$/.exec(rest))) {
      const ref = u.searchParams.get('ref') || 'main', file = decodeURIComponent(m[1]);
      const blob = git(['rev-parse', '--verify', '-q', `${ref}:${file}`]);
      if (blob.status !== 0) return notFound(res);
      const etag = `"${blob.stdout.trim()}"`;
      if (req.headers['if-none-match'] === etag) return send(res, 304, null, { ETag: etag });   // no gasta cuota
      const content = git(['show', `${ref}:${file}`], { encoding: 'buffer' }).stdout;
      remaining--;
      // como GitHub: a quien pide el archivo crudo (`Accept: application/vnd.github.raw`) le van los bytes del archivo, no
      // el JSON con el contenido en base64 (así lo baja la página de instalación de Windows, con Invoke-WebRequest)
      if (/application\/vnd\.github(\.v3)?\.raw\b/.test(String(req.headers.accept || ''))) return send(res, 200, content, { ETag: etag, 'Content-Type': 'application/vnd.github.raw; charset=utf-8' });
      return send(res, 200, { name: path.basename(file), path: file, sha: blob.stdout.trim(), size: content.length, encoding: 'base64', content: content.toString('base64') }, { ETag: etag });
    }
    if ((m = /^tarball\/([0-9a-f]{7,40})$/.exec(rest))) {
      const full = git(['rev-parse', '--verify', '-q', `${m[1]}^{commit}`]);
      if (full.status !== 0) return notFound(res);
      remaining--;
      const token = crypto.randomBytes(8).toString('hex');
      return send(res, 302, null, { Location: `${CODELOAD}/${keyOf(repo)}/legacy.tar.gz/${full.stdout.trim()}?token=${token}` });
    }
    return notFound(res);
  };
  if (c.latency_ms) setTimeout(go, c.latency_ms); else go();
}

function codeload(req, res) {
  const c = control();
  const u = new URL(req.url, 'http://codeload');
  const hasAuth = Boolean(req.headers.authorization);
  log({ host: 'codeload', method: req.method, path: u.pathname + u.search, auth: hasAuth, auth_sha256: hasAuth ? sha256(req.headers.authorization) : null });
  if (hasAuth) return send(res, 400, { message: 'credential forwarded to codeload' });
  const repo = REPOS.find((r) => u.pathname.startsWith(`/${keyOf(r)}/legacy.tar.gz/`)) || null;
  const m = repo ? new RegExp(`^/${repo.org}/${repo.name}/legacy\\.tar\\.gz/([0-9a-f]{40})$`).exec(u.pathname) : null;
  if (!m || !u.searchParams.get('token')) return notFound(res);
  const sha = m[1];
  const prefix = `${repo.org}-${repo.name}-${sha.slice(0, 7)}/`;
  const tar = git(['archive', '--format=tar', `--prefix=${prefix}`, sha], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, repo.bare);
  if (tar.status !== 0) return notFound(res);
  let raw = tar.stdout;
  // `tamper` / `truncate` valen para todos los repos, o sólo para los nombrados en `tamper_repos` / `truncate_repos` (así una
  // prueba rompe el comprimido del repo del equipo y no el de la versión pública que se baja antes)
  const applies = (flag, list) => Boolean(c[flag]) && (!Array.isArray(c[list]) || c[list].includes(keyOf(repo)));
  if (applies('tamper', 'tamper_repos')) {
    // un archivo cambiado adentro del tar: mismo largo, otro contenido → otro árbol (README.md, o el primero del repo)
    let i = raw.indexOf(Buffer.from(`${prefix}README.md\0`));
    if (i < 0) i = raw.indexOf(Buffer.from(`${prefix}perfil-equipo.json\0`));
    if (i >= 0) { const body = i - (i % 512) + 512; raw = Buffer.from(raw); raw[body] = raw[body] === 0x23 ? 0x2a : 0x23; }
  }
  let gz = zlib.gzipSync(raw);
  if (applies('truncate', 'truncate_repos')) gz = gz.subarray(0, Math.floor(gz.length / 2));
  send(res, 200, gz);
}

// ── los dos proxies de juguete: uno que pasa (forma absoluta para http, CONNECT para https) y marca cada pedido con la
// cabecera `X-Toy-Proxy: 1` (así el registro de la API dice `via_proxy`), y uno MUDO, que acepta y no contesta ───────
const net = require('net');
function proxyServer({ mute = false } = {}) {
  return net.createServer((sock) => {
    sock.on('error', () => {});
    if (mute) return;
    sock.once('data', (d) => {
      const head = d.toString('latin1');
      const [method, target] = head.split('\r\n')[0].split(' ');
      if (method === 'CONNECT') {
        const [host, port] = target.split(':');
        const up = net.connect(parseInt(port, 10), host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
        up.on('error', () => sock.destroy());
        return;
      }
      let u;
      try { u = new URL(target); } catch (_) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      const up = net.connect(parseInt(u.port || '80', 10), u.hostname, () => {
        const rest = head.slice(head.indexOf('\r\n') + 2);
        up.write(`${method} ${u.pathname}${u.search} HTTP/1.1\r\nX-Toy-Proxy: 1\r\n${rest}`);
        up.pipe(sock); sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
    });
  });
}

let CODELOAD = null;
const apiSrv = http.createServer(api);
const codeSrv = http.createServer(codeload);
const proxySrv = proxyServer();
const muteSrv = proxyServer({ mute: true });
const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${srv.address().port}`)));
(async () => {
  CODELOAD = await listen(codeSrv);
  const API = await listen(apiSrv);
  const PROXY = await listen(proxySrv);
  const MUTE = await listen(muteSrv);
  fs.writeFileSync(`${PORT_FILE}.tmp`, `API=${API}\nCODELOAD=${CODELOAD}\nPROXY=${PROXY}\nMUTE_PROXY=${MUTE}\n`);
  fs.renameSync(`${PORT_FILE}.tmp`, PORT_FILE);
})();
process.on('SIGTERM', () => process.exit(0));
