#!/usr/bin/env node
'use strict';
// tycon-harness (paquete @tycon-sa/harness) — el instalador que corre `npx @tycon-sa/harness@latest` (story 8.40). El
// paquete NO trae el arnés: trae este archivo, que hace lo mismo que scripts/setup/get-harness.sh, en Node y en los tres
// sistemas, sin dependencias. En orden:
//   1. Revisa los requisitos (`requisites`): Node NODE_FLOOR o más; fuera de Windows bash, tar y python3 (salvo sólo Codex;
//      en una Mac sin las herramientas de línea de comandos el de /usr/bin no cuenta); en Windows pwsh 7 y tar. Lo que
//      falta se dice con el comando sugerido, que se imprime y NUNCA se corre.
//   2. Con terminal, y sin --team ni --audience, pregunta para quién es la instalación (sin valor por defecto). Con
//      `--team <repo>` (o la respuesta 2; la forma, la de `--team`: `teamShape`) mira ANTES de bajar si el repo del equipo
//      se lee, y si no pide su permiso; en Azure vale la credencial que install --team usaría (TYCON_AZURE_TOKEN, que se
//      guarda; la guardada; la del gestor de credenciales de git: lo único que este programa le pide a git). Con la
//      respuesta 3 (o `--audience org`) instala sin capa y, si install sale 0, corre `harness.js team-init` del árbol YA
//      instalado, en esta misma terminal (el alta valida con los lectores de la versión instalada).
//   3. Baja a una carpeta temporal el comprimido de la punta de main por las rutas públicas (info/refs y codeload); con
//      permiso, por la API (la credencial sólo al mismo origen). Honra HTTPS_PROXY/HTTP_PROXY/NO_PROXY y los
//      npm_config_*proxy de npx (túnel CONNECT; un proxy https://, por TLS); una CA propia va en NODE_EXTRA_CA_CERTS. Un
//      enlace o una ruta que sale en el listado del comprimido lo rechazan entero.
//   4. Desde ese árbol, con el MISMO Node (process.execPath) y en esta terminal: guarda el permiso pedido (`harness.js
//      config set`) y corre `harness.js install --version latest --repo <repo>` con las demás opciones tal cual (la bajada
//      VERIFICADA y el «¿Instalo?» son los de install). La carpeta temporal se borra al terminar, también si algo falla.
// Una máquina que ya tiene el arnés no baja nada: lo dice y sale 0 (con --team sin capa, delega en su propio install; con
// --audience org, corre su team-init). Un estado del arnés que no se lee sale 1: nunca se instala encima.
// TYCON_RELEASE_API, TYCON_RELEASE_GIT y TYCON_RELEASE_ARCHIVE: sólo pruebas (el GitHub de juguete), como en release.js.

const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net'); const tls = require('tls');
const http = require('http'); const https = require('https'); const { spawnSync } = require('child_process');

const REPO = 'TYCON-SA/tycon-harness';
const NODE_FLOOR = 22;   // el piso para INSTALAR (el de la documentación); harness.js tolera 20 sólo para actualizar una instalación existente
const PACKAGE = '@tycon-sa/harness', TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new', AUDIENCES = { 1: 'me', 2: 'team', 3: 'org' };
const GH_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

const say = (s) => process.stderr.write(`tycon-harness: ${s}\n`);
class Stop extends Error { constructor(code, message) { super(message); this.code = code; } }
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// «.» y «..» pasan la forma pero no son nombres: en la URL cambiarían de endpoint (como parseTeam)
const dots = (s) => /^\.+$/.test(s);
const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
const enc = (r) => String(r).split('/').map((s) => encodeURIComponent(dec(s))).join('/');   // cada segmento, codificado, en toda URL armada
// el repo del perfil con el MISMO criterio que `--team` (parseTeam de team.js y parseAzureUrl de team-azure.js, que este
// paquete no trae: la paridad, caso por caso, la mide npm-package.test.js T36): `{ host, repo, … }` o null

function teamShape(option) {
  const s = String(option === undefined || option === null ? '' : option).trim();
  if (/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\//i.test(s)) {
    const m = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i.exec(s);
    const [org, project, name] = m ? m.slice(1).map(dec) : [];
    if (!m || ![org, project, name].every((x) => /^[\p{L}\p{N}\p{M}._ ()!-]+$/u.test(x) && !dots(x))) return null;
    return { host: 'azure', org, project, name, repo: `https://dev.azure.com/${[org, project].map(encodeURIComponent).join('/')}/_git/${encodeURIComponent(name)}` };
  }
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(s) || GH_REPO.exec(s);
  return m && !dots(m[1]) && !dots(m[2]) ? { host: 'github', repo: `${m[1]}/${m[2]}` } : null;
}
/** El tar del sistema: en Windows por ruta absoluta (el que trae Windows 10+), nunca uno de la carpeta actual. */
const tarCmd = (env = process.env, platform = process.platform) => (platform === 'win32' ? path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');
/** Un hijo, esperado: si no arrancó o lo cortó una señal se dice, nunca un «salió mal» callado. */
function launch(what, cmd, args, opts) {
  const r = spawnSync(cmd, args, opts);
  if (r.error) throw new Stop(1, `no pude correr ${what}: ${r.error.code || r.error.message}`);
  if (r.signal) throw new Stop(1, `${what} se cortó con la señal ${r.signal}`);
  return r;
}

// ── 1. los requisitos ─────────────────────────────────────────────────────────────────────────────────────────────
function onPath(env, platform) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  // la ruta del primero que aparece en el PATH (el que va a correr), o '' si no está
  return (name) => { for (const d of dirs) for (const x of exts) { const p = path.join(d, name + x); try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* no está ahí */ } } return ''; };
}
function isDebian() { try { return /(^|\n)(ID|ID_LIKE)=.*(debian|ubuntu)/.test(fs.readFileSync('/etc/os-release', 'utf8')); } catch (_) { return false; } }
function suggest(tool, platform, debian) {
  if (tool === 'node') return platform === 'darwin' ? 'brew install node' : 'https://nodejs.org/en/download';
  if (platform === 'win32') return tool === 'pwsh' ? 'winget install Microsoft.PowerShell' : 'Windows 10 o posterior trae tar.exe en C:\\Windows\\System32';
  if (platform === 'darwin') return `brew install ${tool === 'python3' ? 'python' : tool}`;
  if (debian) return `sudo apt install ${tool}`;
  return { python3: 'https://www.python.org/downloads/', bash: 'https://www.gnu.org/software/bash/', tar: 'https://www.gnu.org/software/tar/' }[tool];
}
/** Lo que falta en ESTE sistema, una línea por cada cosa (vacío = nada falta). La plataforma es la de Node, no una variable. */
function requisites({ platform = process.platform, env = process.env, tools = null, nodeVersion = process.versions.node, args = [], debian = null, clt = null } = {}) {
  const found = tools || onPath(env, platform);
  const has = (t) => (t === 'tar' && platform === 'win32' && !tools ? fs.existsSync(tarCmd(env, platform)) : found(t));
  const deb = debian === null ? platform === 'linux' && isDebian() : debian;
  // --tool como lo lee install (tools.parseOption): repetida o con comas, sin mayúsculas ni espacios
  const asked = args.flatMap((a, i) => (a === '--tool' && args[i + 1] ? [args[i + 1]] : (/^--tool=/.test(a) ? [a.slice(7)] : []))).flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase());
  const codexOnly = asked.includes('codex') && !asked.includes('claude');   // python3 lo pide el aplicador de Claude Code
  const need = platform === 'win32' ? ['pwsh', 'tar'] : ['bash', 'tar', ...(codexOnly ? [] : ['python3'])];
  const out = need.filter((t) => !has(t)).map((t) => `falta ${t}${t === 'pwsh' ? ' (PowerShell 7: lo usa el aplicador de Windows)' : ''} — sugerido (no lo corro): ${suggest(t, platform, deb)}`);
  const noClt = () => { if (clt !== null) return !clt; const r = spawnSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 10000 }); return !r.error && !r.signal && r.status !== 0; };   // Mac sin las herramientas de línea de comandos: /usr/bin/python3 sólo pide instalarlas (get-harness.sh); se afirma sólo si xcode-select CORRIÓ y dijo que no
  if (need.includes('python3') && platform === 'darwin' && found('python3') === '/usr/bin/python3' && noClt()) out.push('falta python3 (el de /usr/bin pide las herramientas de línea de comandos) — sugerido (no lo corro): xcode-select --install');
  const major = Number(String(nodeVersion).split('.')[0]);
  if (!(major >= NODE_FLOOR)) out.unshift(`node ${nodeVersion} es viejo: el arnés pide Node ${NODE_FLOOR} o más — sugerido (no lo corro): ${suggest('node', platform, deb)}`);
  return out;
}

// ── la red: GET con proxy y redirecciones a mano ──────────────────────────────────────────────────────────────────
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
/** Un GET sin seguir redirecciones: { status, headers, body }. */
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

// ── la terminal ─────────────────────────────────────────────────────────────────────────────────────────────────────
const isTerminal = () => require('tty').isatty(0);
/** Una línea de la terminal (sin el salto), o null si la entrada se terminó. Lee de a poco: lo que sigue queda para install. */
function readLine() {
  const b = Buffer.alloc(1); const bytes = [];
  for (;;) {
    let n; try { n = fs.readSync(0, b, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') { pause(50); continue; } return bytes.length ? Buffer.from(bytes).toString('utf8') : null; }
    if (!n) return bytes.length ? Buffer.from(bytes).toString('utf8') : null;
    if (b[0] === 10) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    bytes.push(b[0]);
  }
}
/** Un permiso, sin eco (modo crudo): hasta Enter; Ctrl-C o Ctrl-D lo cortan; las marcas del pegado y los controles no entran. */
function readSecret(prompt) {
  process.stderr.write(`tycon-harness: ${prompt}`);
  const stdin = process.stdin; const raw = typeof stdin.setRawMode === 'function';
  if (!raw) return readLine() || '';
  const b = Buffer.alloc(1); const bytes = [];
  stdin.setRawMode(true);
  try {
    for (;;) {
      let n; try { n = fs.readSync(0, b, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') { pause(50); continue; } return ''; }
      if (!n || b[0] === 3 || b[0] === 4) return '';
      if (b[0] === 13 || b[0] === 10) break;
      if (b[0] === 127 || b[0] === 8) { bytes.pop(); continue; }
      bytes.push(b[0]);
    }
  } finally { try { stdin.setRawMode(false); stdin.pause(); } catch (_) { /* la terminal se cerró */ } process.stderr.write('\n'); }
  return Buffer.from(bytes).toString('utf8').replace(/\x1b\[[0-9;?]*[\x40-\x7e]|\x1bO.|\x1b./g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
}
/** Una pregunta sin valor por defecto: una respuesta vacía o que no vale vuelve a preguntar; tres (o la entrada cerrada) salen 2 sin bajar nada. */
function askUntil(question, accept, wrong, none) {
  for (let i = 0; i < 3; i++) {
    process.stderr.write(`tycon-harness: ${question}: `);
    const a = readLine(); if (a === null) break;
    const v = accept(a.trim()); if (v) return v;
    if (a.trim()) say(wrong);   // sin repetir lo escrito: podría ser un permiso pegado de más
  }
  throw new Stop(2, none);
}
const askAudience = () => askUntil('¿Para quién es esta instalación? 1 para mí · 2 para sumarme a un equipo que ya tiene su perfil · 3 para dar de alta mi organización',
  (a) => AUDIENCES[a], 'eso no es una de las tres: contestá 1, 2 o 3', 'sin elegir para quién es la instalación: no bajé nada. Volvé a correrlo, o pasá --audience me|team|org');

// ── la máquina ya instalada ─────────────────────────────────────────────────────────────────────────────────────────
function installed(env) {
  const home = os.homedir(); const own = env.TYCON_HOME || path.join(home, '.tycon');
  for (const f of [path.join(own, 'state', 'harness-state.json'), path.join(home, '.claude', '.tycon-pipeline', 'harness-state.json')]) {
    let s;   // un estado que está pero no se lee no es «sin arnés»: instalar encima pisaría una instalación
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); if (!s || typeof s !== 'object') throw new Error('no es un objeto'); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw new Stop(1, `el estado del arnés ${f} está pero no se lee (${e.code || e.message}): no instalo encima. Revisalo (o, si no hay arnés, borralo) y volvé a correrlo. No bajé nada.`);
    }
    const tree = s.tree || path.join(own, 'harness'); const harness = path.join(tree, 'scripts', 'setup', 'harness.js');
    if (fs.existsSync(harness)) return { tree, harness, version: (s.version && (s.version.number || s.version)) || '?', team: s.team || null };
  }
  return null;
}

// ── el permiso de lectura ───────────────────────────────────────────────────────────────────────────────────────────
function savedToken(env, key) {
  const f = path.join(env.TYCON_HOME || path.join(os.homedir(), '.tycon'), 'config.json'); let j;   // como installed(): que está y no se lee no es «sin permiso»
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); if (!j || typeof j !== 'object') throw new Error('no es un objeto'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ''; throw new Stop(1, `la configuración del arnés ${f} está pero no se lee (${e.code || e.message}): no la piso. Revisala (o, si no la usás, borrala) y volvé a correrlo. No bajé nada.`); }
  return String((j[key] && j[key].token) || '');
}
/** ¿El gestor de credenciales de git tiene la de Azure DevOps para ese repo? Como team-azure.credential: sin interacción, con tope. */
function gitCredential(src, env) {
  if (String(env.TYCON_AZURE_GIT_CREDENTIAL || '') === '0') return false;
  const r = spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=dev.azure.com\npath=${src.org}/${src.project}/_git/${src.name}\n\n`, encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: Object.assign({}, env, { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CREDENTIAL_INTERACTIVE: 'never' }) });
  return !r.error && r.status === 0 && new RegExp('^pass' + 'word=.', 'm').test(String(r.stdout || ''));
}
function askToken(what, url) {
  if (!isTerminal()) throw new Stop(1, `${what} no se puede leer sin un permiso de GitHub: creá uno de sólo lectura (Fine-grained, Contents: read) en ${url} y pasalo en TYCON_GITHUB_TOKEN (o pegalo después con harness.js config set github.token). No bajé nada.`);
  say(`${what} no se puede leer sin tu permiso de GitHub: uno de sólo lectura (Fine-grained, Contents: read) en ${url}`);
  const t = readSecret('pegá el permiso de GitHub y Enter: ');
  if (!t) throw new Stop(1, 'sin permiso no puedo bajar la versión: no bajé nada');
  return t;
}

async function main(argv, env = process.env) {
  // las opciones propias; todo lo demás va a `install` tal cual (sin `--`: npx se lo come en Windows)
  let repo = REPO, team = '', audience = '', help = false; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const own = ['--repo', '--team', '--audience'].find((o) => a === o || a.startsWith(`${o}=`));
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (!own) { rest.push(a); continue; }
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
    if (!v) throw new Stop(2, `${own} pide un valor`);
    if (own === '--repo') repo = v; else if (own === '--team') team = v; else audience = v;
  }
  if (help) {
    process.stdout.write([`uso: npx ${PACKAGE}@latest [--repo <org/nombre>] [--team <repo del perfil>] [--audience me|team|org] [<opciones de harness.js install>]`,
      `corre desde: ${__filename}`,
      'qué hace: 1) revisa los requisitos (Node, tar; bash y python3, o pwsh 7 en Windows) y dice lo que falta sin instalar nada;',
      '  2) baja de GitHub, a una carpeta temporal, la versión publicada del arnés (el arnés NO viene en este paquete);',
      '  3) corre harness.js install --version latest desde ahí: verifica lo bajado contra el commit, muestra el plan y pregunta «¿Instalo? [s/N]»;',
      '  4) borra la carpeta temporal.',
      `sin nadie delante: npx ${PACKAGE}@latest --profile minimal --yes (ese --yes, después del nombre, acepta el plan)`,
      `la procedencia del paquete: la pestaña «Provenance» de https://www.npmjs.com/package/${PACKAGE}, o npm view ${PACKAGE} dist.attestations`,
      'a mano, sin npm: scripts/setup/get-harness.sh (o get-harness.ps1) del repo público', ''].join('\n'));
    return 0;
  }
  if (!GH_REPO.test(repo) || repo.split('/').some(dots)) throw new Stop(2, `--repo pide <org/nombre> (sin segmentos «.» ni «..»): ${repo}`);
  if (audience && !['me', 'team', 'org'].includes(audience)) throw new Stop(2, `--audience es me, team u org: ${audience}`);
  const API = env.TYCON_RELEASE_API || 'https://api.github.com', GIT = env.TYCON_RELEASE_GIT || 'https://github.com', CODELOAD = env.TYCON_RELEASE_ARCHIVE || 'https://codeload.github.com';
  for (const [n, u] of [['API', API], ['GIT', GIT], ['ARCHIVE', CODELOAD]]) if (!/^https?:\/\//.test(u)) throw new Stop(2, `TYCON_RELEASE_${n} tiene que empezar con http:// o https:// (no sigo otros esquemas): ${u}`);
  const PUB = !(env.TYCON_RELEASE_API && !env.TYCON_RELEASE_GIT);   // la API de juguete con el github.com real: nunca
  const missing = requisites({ env, args: rest });
  if (missing.length) { missing.forEach(say); throw new Stop(1, `no bajé nada: instalá lo que falta y volvé a correr npx ${PACKAGE}@latest`); }
  // el repo del perfil, con el criterio de --team; lo que sigue usa su forma normal (`src.repo`). Lo citado va sin `usuario@`
  const SHAPES = 'org/repo, https://github.com/<org>/<repo> o https://dev.azure.com/<org>/<proyecto>/_git/<repo>, sin segmentos «.» ni «..»';
  let src = team ? teamShape(team) : null;
  if (team && !src) throw new Stop(2, `el repo del perfil tiene que ser ${SHAPES}: «${team.replace(/^(https?:\/\/)[^@/]+@/, '$1')}». No bajé nada.`);
  const here = installed(env);
  if (here) {
    if (audience === 'org') {   // dar de alta la organización en una máquina que ya tiene el arnés: el alta, del árbol instalado
      say(`el arnés ya está en ${here.tree} (versión ${here.version}): sigo con el alta de tu organización (harness.js team-init)`);
      return launch('harness.js team-init', process.execPath, [here.harness, 'team-init'], { stdio: 'inherit', env }).status;
    }
    if (src && !here.team) {
      say(`el arnés ya está en ${here.tree}: sumo el perfil del equipo con su propio install --team`);
      return launch('harness.js install --team', process.execPath, [here.harness, 'install', '--team', src.repo, ...rest], { stdio: 'inherit', env }).status;
    }
    say(`el arnés ya está instalado en ${here.tree} (versión ${here.version}): para actualizarlo, node "${here.harness}" update; para dar de alta tu organización, --audience org. No bajé nada.`);
    return 0;
  }
  if (src) audience = 'team';
  if (!audience) audience = isTerminal() ? askAudience() : 'me';
  if (audience === 'team' && !src) {   // la respuesta 2: vacía o que no es un repo vuelve a preguntar, como la de para quién
    if (!isTerminal()) throw new Stop(2, '--audience team pide --team <org/repo de GitHub, o la URL de Azure DevOps del repo del perfil>');
    src = askUntil('la dirección del repo del perfil del equipo (org/repo de GitHub, o https://dev.azure.com/<org>/<proyecto>/_git/<repo>)', teamShape,
      `esa dirección no es la de un repo: ${SHAPES}`, 'sin la dirección del repo del perfil: no bajé nada. Volvé a correrlo, o pasá --team <repo del perfil>');
  }
  team = src ? src.repo : '';

  // ── 2. el permiso, antes de bajar ───────────────────────────────────────────────────────────────────────────────
  // `token` es el del arnés (el de la variable o el guardado); el que se PIDE para el repo del equipo vive aparte
  // (`teamToken`): bajar el arnés público sigue por codeload, sin credencial. Se guarda uno solo, el que install --team usa.
  let token = String(env.TYCON_GITHUB_TOKEN || '').replace(/[\r\n]/g, ''); let save = Boolean(token);
  if (!token) token = savedToken(env, 'github');
  let teamToken = token, saveTeam = false, azureToken = '';
  const refsOf = async (r, t) => {   // github.com sin contestar no es «sin red»: se cae a la API, como get-harness.sh
    let res; try { res = await get(`${GIT}/${enc(r)}.git/info/refs?service=git-upload-pack`, { token: t, env, accept: '*/*' }); } catch (e) { if (/certificado/.test(e.message)) throw e; return { status: 0, sha: '' }; }
    const m = res.status === 200 && res.body.toString('latin1').startsWith('001e# service=git-upload-pack\n0000') && /([0-9a-f]{40}) refs\/heads\/main[\0\n]/.exec(res.body.toString('latin1'));
    return { status: res.status, sha: m ? m[1] : '' };
  };
  if (src && src.host === 'github') {
    // ¿se lee? 401/404 es «pedí permiso»; el tope dice hasta qué hora; un 5xx o la red caída salen 1 con la causa
    const r = PUB ? await refsOf(team, '') : { status: 0 };
    if (r.status !== 200) {
      const a = !teamToken && [401, 404].includes(r.status) ? r : await get(`${API}/repos/${enc(team)}/git/ref/heads/main`, { token: teamToken, env });
      const until = limitedUntil(a);
      if (until) throw new Stop(1, `GitHub limita las consultas al mirar el repo del perfil ${team} hasta las ${until}: probá de nuevo después de esa hora. No bajé nada.`);
      if ([401, 404].includes(a.status) && !teamToken) { teamToken = askToken(`el repo del perfil del equipo ${team}`, TOKEN_URL); saveTeam = true; }
      else if ([401, 404].includes(a.status)) throw new Stop(1, `el permiso de GitHub no ve el repo del perfil ${team} (${a.status}): venció, o no tiene acceso a ese repo. El permiso: ${TOKEN_URL}. No bajé nada.`);
      else if (a.status !== 200) throw new Stop(1, `GitHub contestó ${a.status} al mirar el repo del perfil ${team}. No bajé nada.`);
    }
  } else if (src) {
    // la credencial que install --team usaría (team-azure.credential): la de TYCON_AZURE_TOKEN (se guarda: install sólo lee
    // la guardada), la guardada, o la del gestor de credenciales de git; sólo sin ninguna se pide (sin terminal, sale 1)
    azureToken = String(env.TYCON_AZURE_TOKEN || '').replace(/[\r\n]/g, '');
    if (!azureToken && !savedToken(env, 'azure') && !gitCredential(src, env)) {
      const where = `https://dev.azure.com/${encodeURIComponent(src.org)}/_usersSettings/tokens`;
      if (!isTerminal()) throw new Stop(1, `el repo del perfil ${team} pide un permiso de Azure DevOps de sólo lectura (Code: Read): crealo en ${where} y pasalo en TYCON_AZURE_TOKEN (o iniciá sesión una vez con git en ${team}, para que el gestor de credenciales la guarde). No bajé nada.`);
      say(`el repo del perfil ${team} pide tu permiso de Azure DevOps de sólo lectura (Code: Read): ${where}`);
      azureToken = readSecret('pegá el permiso de Azure DevOps y Enter: ');
      if (!azureToken) throw new Stop(1, 'sin permiso no puedo leer el repo del perfil: no bajé nada');
    }
  }
  // el arnés privado (un --repo propio): su permiso. Si ya se pidió uno para el equipo, es ése (install --team lee los dos
  // repos con UN permiso guardado); un arnés público no lo usa nunca
  const harnessToken = () => (saveTeam ? teamToken : askToken(`el repo ${repo}`, TOKEN_URL));
  const ref = () => get(`${API}/repos/${enc(repo)}/git/ref/heads/main`, { token, env });
  let sha = '', code = 200;
  if (!token && PUB) { const r = await refsOf(repo, ''); code = r.status; sha = r.sha; if (code === 401 || code === 404) { token = harnessToken(); save = true; } }
  if (!sha) {
    let r = await ref();
    if (!token && (r.status === 401 || r.status === 404)) { token = harnessToken(); save = true; r = await ref(); }
    if (r.status === 401 && token && PUB) { const p = await refsOf(repo, ''); if (p.sha) { sha = p.sha; if (save) say('el permiso de TYCON_GITHUB_TOKEN venció o se revocó (401), pero no hace falta: el repo del arnés es público. Sigo sin él y no lo guardo.'); token = ''; save = false; } }
    if (!sha) {
      const until = limitedUntil(r); code = r.status;
      if (until) throw new Stop(1, `GitHub limita las consultas ${token ? 'de tu permiso' : 'sin permiso de esta conexión'} hasta las ${until}: probá de nuevo después de esa hora. No bajé nada.`);
      if (code === 401) throw new Stop(1, `el permiso de GitHub no vale (401): venció o se revocó. Creá otro en ${TOKEN_URL} y pegalo con harness.js config set github.token. No bajé nada.`);
      if (code === 404) throw new Stop(1, `GitHub no muestra ${repo} (404): sin permiso, o el permiso no ve el repo. El permiso: ${TOKEN_URL}. No bajé nada.`);
      if (code !== 200) throw new Stop(1, `GitHub contestó ${code} al pedir la rama main de ${repo}. No bajé nada.`);
      try { sha = JSON.parse(r.body.toString('utf8')).object.sha; } catch (_) { sha = ''; }
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Stop(1, `la respuesta de GitHub no trae el commit de main de ${repo}. No bajé nada.`);
    }
  }

  // ── 3. la bajada, a la carpeta temporal ─────────────────────────────────────────────────────────────────────────
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
    const harness = path.join(top, 'scripts', 'setup', 'harness.js');
    // ── 4. la instalación, desde ese árbol y en esta misma terminal, con este mismo Node ──────────────────────────
    const keep = (key, value) => { if (launch(`harness.js config set ${key}`, process.execPath, [harness, 'config', 'set', key], { input: value, stdio: ['pipe', 'ignore', 'inherit'], env }).status !== 0) throw new Stop(1, `no pude guardar el permiso (${key})`); };
    const github = save && token ? token : (saveTeam ? teamToken : '');
    if (github) keep('github.token', github); if (azureToken) keep('azure.token', azureToken);
    const args = ['install', '--version', 'latest', '--repo', repo, ...(team ? ['--team', team] : []), ...rest];
    const run = launch('harness.js install', process.execPath, [harness, ...args], { stdio: 'inherit', env });
    if (audience !== 'org' || run.status !== 0) return run.status;
    // 3 «dar de alta mi organización»: instalado sin capa, el alta corre desde el árbol YA instalado (sus lectores), acá mismo.
    // install sale 0 también sin instalar (el «no» al plan, --dry-run): entonces no hay árbol del que correr el alta
    const now = installed(env);
    if (!now) { say('no se instaló nada: el alta de tu organización queda para cuando instales (volvé a correr la misma línea)'); return 0; }
    say('instalado: ahora el alta de tu organización (harness.js team-init)');
    return launch('harness.js team-init', process.execPath, [now.harness, 'team-init'], { stdio: 'inherit', env }).status;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    if (e instanceof Stop) { say(e.message); process.exitCode = e.code; return; }
    say(`falló sin que lo esperara: ${e && e.stack ? e.stack : e}`); process.exitCode = 1;
  });
}

module.exports = { requisites, main, proxyFor, get, teamShape, tarCmd, NODE_FLOOR, REPO, PACKAGE };
