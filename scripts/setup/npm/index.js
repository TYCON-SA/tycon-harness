#!/usr/bin/env node
'use strict';
// tycon-harness (paquete @tyconsa/harness) — lo que corre `npx @tyconsa/harness@latest`. NO trae el arnés ni su instalador:
// 1) revisa el piso de Node (sale 1 sin bajar nada, con el comando sugerido, que nunca corre); 2) baja la punta de main por las
// rutas públicas (info/refs y codeload; sin ellas, la API; un repo privado usa el permiso guardado, TYCON_GITHUB_TOKEN o lo
// pide), con proxies y NODE_EXTRA_CA_CERTS, y rechaza un comprimido con enlaces o rutas que salen; 3) corre con el MISMO Node
// `<árbol bajado>/scripts/setup/harness.js npx <opciones tal cual>` (commit en TYCON_NPX_COMMIT, repo en TYCON_NPX_REPO) y sale con
// su código; una punta sin ese subcomando sale 1. La carpeta temporal se borra siempre. Lo demás lo resuelve el instalador bajado.
// TYCON_RELEASE_API/_GIT/_ARCHIVE: sólo pruebas, como en release.js.

const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net'); const tls = require('tls');
const http = require('http'); const https = require('https'); const { spawnSync } = require('child_process');

const REPO = 'TYCON-SA/tycon-harness';
const NODE_FLOOR = 22;   // el piso para INSTALAR (el de la documentación); harness.js tolera 20 sólo para actualizar una instalación existente
const GH_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/, TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

const say = (s) => process.stderr.write(`tycon-harness: ${s}\n`); class Stop extends Error { constructor(code, message) { super(message); this.code = code; } }
const dots = (s) => /^\.+$/.test(s);   // «.» y «..» pasan la forma pero no son nombres: cambiarían de endpoint
const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } }; const enc = (r) => String(r).split('/').map((s) => encodeURIComponent(dec(s))).join('/');   // cada segmento, codificado, en toda URL armada
const tarCmd = (env = process.env, platform = process.platform) => (platform === 'win32' ? path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');
/** Un hijo, esperado: si no arrancó o lo cortó una señal se dice, nunca un «salió mal» callado. */
function launch(what, cmd, args, opts) {
  const r = spawnSync(cmd, args, opts);
  if (r.error && r.error.code === 'ENOENT' && /tar/.test(what)) {   // falta tar: se dice con el comando sugerido (se imprime, nunca se corre)
    const how = { win32: 'Windows 10 o posterior trae tar.exe en C:\\Windows\\System32', darwin: 'brew install tar' }[process.platform] || 'sudo apt install tar (Debian y Ubuntu) o https://www.gnu.org/software/tar/';
    throw new Stop(1, `falta tar — sugerido (no lo corro): ${how}. No instalé nada.`);
  }
  if (r.error) throw new Stop(1, `no pude correr ${what}: ${r.error.code || r.error.message}`);
  if (r.signal) throw new Stop(1, `${what} se cortó con la señal ${r.signal}`);
  return r;
}

function proxyFor(env, target) {
  const g = (n) => env[n] || env[n.toLowerCase()];
  const no = String(g('NO_PROXY') || env.npm_config_noproxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = target.hostname.toLowerCase();
  if (no.some((p) => p === '*' || p === h || (p.startsWith('.') && h.endsWith(p)) || h.endsWith(`.${p}`))) return null;
  const raw = target.protocol === 'https:' ? (g('HTTPS_PROXY') || env.npm_config_https_proxy || g('HTTP_PROXY') || env.npm_config_proxy) : (g('HTTP_PROXY') || env.npm_config_proxy);
  if (!raw) return null;
  try { return new URL(/^\w+:\/\//.test(raw) ? raw : `http://${raw}`); } catch (_) { return null; }
}
const proxyAuth = (p) => (p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {});
function netError(e, target) {
  if (e instanceof Stop) return e;
  if (!/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(`${e.code} ${e.message}`)) return new Stop(1, `sin red: no pude llegar a ${target.host} (${e.code || e.message}). No bajé nada.`);
  return new Stop(1, `no pude verificar el certificado de ${target.host} (${e.code || e.message}): si tu organización usa un proxy con su propia CA, poné su certificado en NODE_EXTRA_CA_CERTS y volvé a correrlo. No bajé nada.`);
}
function once(target, headers, env) {
  return new Promise((resolve, reject) => {
    const proxy = proxyFor(env, target); const isHttps = target.protocol === 'https:';
    const fail = (e) => reject(netError(e, target));
    const base = { method: 'GET', timeout: 30000, headers: Object.assign({ Host: target.host, 'User-Agent': 'tycon-harness-npx', Accept: '*/*' }, headers) };
    const go = (opts, mod) => {
      const req = mod.request(opts, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 256 * 1024 * 1024) req.destroy(new Stop(1, `la respuesta de ${target.host} es demasiado grande. No bajé nada.`)); else chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Stop(1, `sin respuesta: ${target.host} no contestó en 30 s. No bajé nada.`)));
      req.on('error', fail); req.end();
    };
    const pathOf = `${target.pathname}${target.search}`;
    if (!proxy) return go(Object.assign({}, base, { host: target.hostname, port: target.port || (isHttps ? 443 : 80), path: pathOf, agent: false }), isHttps ? https : http);
    // un proxy https:// se habla por TLS y, sin puerto, en el 443 (como curl); un socket por pedido (`agent: false`): sin
    // reusar la conexión al proxy, que ya quedó atada al host del pedido anterior
    const tlsProxy = proxy.protocol === 'https:'; const pmod = tlsProxy ? https : http;
    const to = Object.assign({ agent: false, host: proxy.hostname, port: proxy.port || (tlsProxy ? 443 : 80) }, tlsProxy && !net.isIP(proxy.hostname) ? { servername: proxy.hostname } : {});
    if (!isHttps) return go(Object.assign({}, base, to, { path: target.href, headers: Object.assign({}, base.headers, proxyAuth(proxy)) }), pmod);
    const port = target.port || 443;
    const c = pmod.request(Object.assign({}, to, { method: 'CONNECT', path: `${target.hostname}:${port}`, headers: Object.assign({ Host: `${target.hostname}:${port}` }, proxyAuth(proxy)), timeout: 30000 }));
    c.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Stop(1, `el proxy ${proxy.host} contestó ${res.statusCode} al túnel hacia ${target.host}. No bajé nada.`)); }
      const s = tls.connect(Object.assign({ socket, host: target.hostname }, net.isIP(target.hostname) ? {} : { servername: target.hostname })); s.on('error', fail);
      go(Object.assign({}, base, { host: target.hostname, port, path: pathOf, createConnection: () => s }), https);
    });
    c.on('timeout', () => c.destroy(new Stop(1, `el proxy ${proxy.host} no contestó en 30 s. No bajé nada.`)));
    c.on('error', (e) => reject(e instanceof Stop ? e : new Stop(1, `no pude hablar con el proxy ${proxy.host} (${e.code || e.message}). No bajé nada.`)));
    c.end();
  });
}
/** GET con redirecciones a mano (hasta 4): la credencial sigue sólo mientras el ORIGEN no cambie; sólo http(s). */
async function get(url, { token = '', env = process.env, accept = 'application/vnd.github+json' } = {}) {
  let target = new URL(url); let auth = Boolean(token);
  for (let hop = 0; ; hop++) {
    const r = await once(target, Object.assign({ Accept: accept }, auth ? { Authorization: `Bearer ${token}` } : {}), env);
    if (![301, 302, 303, 307, 308].includes(r.status) || !r.headers.location || hop >= 4) return r;
    const next = new URL(r.headers.location, target);
    if (!/^https?:$/.test(next.protocol)) throw new Stop(1, `la redirección de ${target.host} apunta a un esquema que no es http(s): no la sigo. No bajé nada.`);
    if (next.origin !== target.origin) auth = false;
    target = next;
  }
}
function limitedUntil(r) {
  if (r.status !== 403 || String(r.headers['x-ratelimit-remaining']) !== '0') return null;
  const d = new Date((Number(r.headers['x-ratelimit-reset']) || Date.now() / 1e3 + 3600) * 1e3);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function savedToken(env) {
  try { return String(JSON.parse(fs.readFileSync(path.join(env.TYCON_HOME || path.join(os.homedir(), '.tycon'), 'config.json'), 'utf8')).github.token || '').trim(); } catch (_) { return ''; }
}
/** Pide el permiso en la terminal, sin eco (Ctrl-C o Ctrl-D lo cortan); sin terminal, ''. */
function askToken(repo) {
  if (!process.stdin.isTTY) return '';
  say(`${repo} no se puede leer sin tu permiso de GitHub: uno de sólo lectura (Fine-grained, Contents: read) en ${TOKEN_URL}`);
  process.stderr.write('tycon-harness: pegá el permiso de GitHub y Enter: ');
  const b = Buffer.alloc(1); let s = ''; process.stdin.setRawMode(true);
  try {
    for (let n; ; s += b[0] >= 32 && b[0] !== 127 ? String.fromCharCode(b[0]) : '') {
      try { n = fs.readSync(0, b, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); b[0] = 0; continue; } return ''; }
      if (!n || b[0] === 3 || b[0] === 4) return '';
      if (b[0] === 13 || b[0] === 10) break;
    }
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); }
  return s.trim();
}

const HELP = (file) => ['uso: npx @tyconsa/harness@latest [opciones]',
  `corre desde: ${file}`,
  'qué hace: baja de GitHub, a una carpeta temporal, la versión publicada del arnés (el arnés NO viene en este paquete) y le pasa el trabajo a su instalador (harness.js npx):',
  '  requisitos, para quién, el equipo, los permisos y el «¿Instalo? [s/N]». Las opciones van tal cual a ese instalador; `harness.js npx --help` las explica.',
  'la procedencia del paquete: la pestaña «Provenance» de https://www.npmjs.com/package/@tyconsa/harness, o npm view @tyconsa/harness dist.attestations',
  'a mano, sin npm: scripts/setup/get-harness.sh (o get-harness.ps1) del repo público', ''].join('\n');

async function run(argv, env, nodeVersion) {
  if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(HELP(__filename)); return 0; }
  let repo = REPO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--repo' && !argv[i].startsWith('--repo=')) continue;
    repo = argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1];
    if (!repo) throw new Stop(2, '--repo pide un valor');
  }
  if (!GH_REPO.test(repo) || repo.split('/').some(dots)) throw new Stop(2, `--repo pide <org/nombre> (sin segmentos «.» ni «..»): ${repo.replace(/(https?:\/\/)[^\s/]*@/gi, '$1')}`);
  const API = env.TYCON_RELEASE_API || 'https://api.github.com', GIT = env.TYCON_RELEASE_GIT || 'https://github.com', CODELOAD = env.TYCON_RELEASE_ARCHIVE || 'https://codeload.github.com';
  for (const [n, u] of [['API', API], ['GIT', GIT], ['ARCHIVE', CODELOAD]]) if (!/^https?:\/\//.test(u)) throw new Stop(2, `TYCON_RELEASE_${n} tiene que empezar con http:// o https:// (no sigo otros esquemas): ${u}`);
  if (!(Number(String(nodeVersion).split('.')[0]) >= NODE_FLOOR)) {
    throw new Stop(1, `node ${nodeVersion} es viejo: el arnés pide Node ${NODE_FLOOR} o más — sugerido (no lo corro): ${process.platform === 'darwin' ? 'brew install node' : 'https://nodejs.org/en/download'}. No bajé nada.`);
  }
  const PUB = !(env.TYCON_RELEASE_API && !env.TYCON_RELEASE_GIT);   // la API de juguete con el github.com real: nunca
  let token = String(env.TYCON_GITHUB_TOKEN || '').replace(/[\r\n]/g, '') || savedToken(env);
  // la punta de main: github.com sin contestar no es «sin red», se cae a la API, como get-harness.sh
  let sha = '';
  if (!token && PUB) {
    try {
      const res = await get(`${GIT}/${enc(repo)}.git/info/refs?service=git-upload-pack`, { env, accept: '*/*' }); const text = res.body.toString('latin1');
      const m = res.status === 200 && text.startsWith('001e# service=git-upload-pack\n0000') && /([0-9a-f]{40}) refs\/heads\/main[\0\n]/.exec(text);
      sha = m ? m[1] : '';
    } catch (e) { if (/certificado/.test(e.message)) throw e; }
  }
  if (!sha) {
    const ref = () => get(`${API}/repos/${enc(repo)}/git/ref/heads/main`, { token, env });
    let r = await ref();
    if (!token && (r.status === 401 || r.status === 404) && (token = askToken(repo))) r = await ref();   // un repo privado: el permiso se pide (sin eco) y lo guarda el instalador
    const until = limitedUntil(r);
    if (until) throw new Stop(1, `GitHub limita las consultas hasta las ${until}: probá de nuevo después de esa hora. No bajé nada.`);
    if (r.status === 401) throw new Stop(1, 'el permiso de TYCON_GITHUB_TOKEN no vale (401): venció o se revocó. No bajé nada.');
    if (r.status === 404) throw new Stop(1, `GitHub no muestra ${repo} (404): sin permiso, o el permiso no ve el repo. El permiso: ${TOKEN_URL}, y pasalo en TYCON_GITHUB_TOKEN. No bajé nada.`);
    if (r.status !== 200) throw new Stop(1, `GitHub contestó ${r.status} al pedir la rama main de ${repo}. No bajé nada.`);
    try { sha = JSON.parse(r.body.toString('utf8')).object.sha; } catch (_) { sha = ''; }
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Stop(1, `la respuesta de GitHub no trae el commit de main de ${repo}. No bajé nada.`);
  }

  say(`bajo ${repo} (main ${sha.slice(0, 7)}) a una carpeta temporal`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-harness-'));
  try {
    const r = !token && PUB ? await get(`${CODELOAD}/${enc(repo)}/tar.gz/${sha}`, { env, accept: '*/*' }) : await get(`${API}/repos/${enc(repo)}/tarball/${sha}`, { token, env });
    if (r.status !== 200) {
      const until = limitedUntil(r);
      throw new Stop(1, until ? `GitHub limita las consultas hasta las ${until}: probá de nuevo después de esa hora. No quedó nada.` : `no pude bajar el comprimido (GitHub contestó ${r.status}): no quedó nada`);
    }
    const tgz = path.join(tmp, 'arnes.tgz'); fs.writeFileSync(tgz, r.body);
    // antes de abrirlo con el tar del sistema se mira el listado: un enlace (l), un enlace duro (h) o una ruta que sale lo rechazan entero
    const TAR = tarCmd(env); const list = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
    const names = launch('tar (el listado del comprimido)', TAR, ['-tzf', tgz], list);
    const types = launch('tar (el listado del comprimido)', TAR, ['-tvzf', tgz], list);
    if (names.status !== 0 || types.status !== 0) throw new Stop(1, 'el comprimido no se pudo leer (¿cortado?): no quedó nada');
    if (/^[lh]/m.test(types.stdout) || names.stdout.split('\n').some((n) => /^([/\\]|[A-Za-z]:)|(^|[/\\])\.\.([/\\]|$)/.test(n))) throw new Stop(1, 'el comprimido trae enlaces o rutas que salen de su carpeta: no lo abro, no quedó nada');
    const into = path.join(tmp, 'tree'); fs.mkdirSync(into);
    if (launch('tar (al desempaquetar)', TAR, ['-xzf', tgz, '-C', into], { stdio: 'ignore' }).status !== 0) throw new Stop(1, 'el comprimido no se pudo desempaquetar: no quedó nada');
    const top = fs.readdirSync(into).map((d) => path.join(into, d)).find((d) => fs.existsSync(path.join(d, 'scripts', 'setup', 'harness.js')));
    if (!top) throw new Stop(1, 'el comprimido no trae scripts/setup/harness.js: no instalo');
    if (!fs.existsSync(path.join(top, 'scripts', 'setup', 'harness', 'npx.js'))) throw new Stop(1, 'la versión publicada todavía no sabe recibir este paquete: esperá a que se publique, o instalá a mano con scripts/setup/get-harness.sh (o get-harness.ps1). No instalé nada.');
    // el trabajo es del instalador bajado: mismo Node, esta terminal, el commit y el repo en el entorno
    return launch('harness.js npx', process.execPath, [path.join(top, 'scripts', 'setup', 'harness.js'), 'npx', ...argv], { stdio: 'inherit', env: Object.assign({}, env, { TYCON_NPX_COMMIT: sha, TYCON_NPX_REPO: repo }, token ? { TYCON_GITHUB_TOKEN: token } : {}) }).status;   // el permiso viaja por el entorno: el instalador lo guarda
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { say(`no pude borrar la carpeta temporal ${tmp} (${e.code || e.message}): borrala a mano`); } }
}

/** El arranque; devuelve el código de salida (un `Stop` se dice y sale con su código). */
async function main(argv, env = process.env, nodeVersion = process.versions.node) {
  try { return await run(argv, env, nodeVersion); } catch (e) {
    if (e instanceof Stop) { say(e.message); return e.code; }
    say(`falló sin que lo esperara: ${e && e.stack ? e.stack : e}`); return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });

module.exports = { main, get, proxyFor, tarCmd, NODE_FLOOR, REPO };
