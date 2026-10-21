'use strict';
/**
 * npx.js — `harness.js npx`: lo que sigue a la bajada cuando alguien corre `npx @tyconsa/harness@latest`.
 *
 * El paquete de npm sólo baja la punta de main a una carpeta temporal y corre este subcomando desde ese árbol, con el
 * commit que bajó en TYCON_NPX_COMMIT y el repo en TYCON_NPX_REPO. Todo lo demás pasa acá, con las bibliotecas de este
 * mismo árbol, así que un cambio del instalador llega a la persona sin publicar el paquete de nuevo. En orden:
 *   1. Los requisitos (`requisites`): Node NODE_FLOOR o más; fuera de Windows bash, tar y python3 (salvo sólo Codex; en una
 *      Mac sin las herramientas de línea de comandos el python3 de /usr/bin no cuenta); en Windows pwsh 7 y tar. Lo que
 *      falta se dice con el comando sugerido, que se imprime y NUNCA se corre.
 *   2. El repo del perfil (`--team`), con el criterio de `parseTeam`; sin `--team`, «para mí» salvo `--audience`.
 *   3. Una máquina que ya tiene el arnés nunca se reinstala: se compara su commit con el de la punta que trajo el
 *      paquete y se dice «al día», o se pregunta «¿Actualizo?» y corre el `update` de ESTE árbol (el bajado). Con
 *      `--audience org` corre `team-init` y con `--team` sin capa, `install --team`, también de este árbol.
 *   4. Sin Claude Code ni Codex (y sin --tool) sale 1 con cómo instalarlos; sin terminal y sin --yes ni --dry-run sale 2
 *      con la línea exacta para confirmar.
 *   5. El permiso de lectura, antes de instalar: el de GitHub del repo del equipo, o el de Azure DevOps (la variable, el
 *      guardado o el del gestor de credenciales de git). Un permiso pedido se guarda para que `install --team` lo lea.
 *   6. `install --version latest --repo <repo> [--team …] --defaults …` de este árbol, en esta terminal; con
 *      `--audience org`, después `team-init`. Las opciones que no son del paquete pasan a `install` tal cual.
 * Códigos: 0 bien o nada que hacer · 1 falta algo · 2 uso o confirmación pendiente. TYCON_RELEASE_API y TYCON_RELEASE_GIT
 * son las de siempre (sólo pruebas).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const GA = require('./github-auth.js');
const AZ = require('./team-azure.js');
const T = require('./team.js');
const TL = require('./tools.js');
const P = require('./prompt.js');
const S = require('./state.js');
const PG = require('./public-git.js');

const NODE_FLOOR = 22;   // el piso para INSTALAR (el de la documentación); harness.js tolera 20 sólo para actualizar una instalación existente
const PACKAGE = '@tyconsa/harness';
const HARNESS_JS = path.join(__dirname, '..', 'harness.js');   // el de ESTE árbol: nunca el instalado
const GH_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const SHAPES = 'org/repo, https://github.com/<org>/<repo> o https://dev.azure.com/<org>/<proyecto>/_git/<repo>, sin segmentos «.» ni «..»';
const OWN_OPTIONS = ['--repo', '--team', '--audience'];

const say = (s) => process.stderr.write(`tycon-harness: ${s}\n`);
class Stop extends Error { constructor(code, message) { super(message); this.code = code; } }
const dots = (s) => /^\.+$/.test(s);
const bare = (s) => String(s).replace(/(https?:\/\/)[^\s/]*@/gi, '$1');   // lo citado va sin `usuario@`

// ── 1. los requisitos ─────────────────────────────────────────────────────────────────────────────────────────────
/** El tar del sistema: en Windows por ruta absoluta (el que trae Windows 10+), nunca uno de la carpeta actual. */
const tarCmd = (env = process.env, platform = process.platform) => (platform === 'win32' ? path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe') : 'tar');
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
/** Los valores de `--tool` de una lista de opciones, con las dos formas (`--tool x` y `--tool=x`). */
const toolValues = (args) => args.flatMap((a, i) => (a === '--tool' && args[i + 1] ? [args[i + 1]] : (/^--tool=/.test(a) ? [a.slice(7)] : [])));
/** Lo que falta en ESTE sistema, una línea por cada cosa (vacío = nada falta). La plataforma es la de Node, no una variable. */
function requisites({ platform = process.platform, env = process.env, tools = null, nodeVersion = process.versions.node, args = [], debian = null, clt = null } = {}) {
  const found = tools || onPath(env, platform);
  const has = (t) => (t === 'tar' && platform === 'win32' && !tools ? fs.existsSync(tarCmd(env, platform)) : found(t));
  const deb = debian === null ? platform === 'linux' && isDebian() : debian;
  // `--tool` como lo lee install (tools.parseOption): repetida o con comas, sin mayúsculas ni espacios
  const asked = TL.parseOption(toolValues(args).length ? toolValues(args) : null);
  const codexOnly = asked.ok && asked.tools && asked.tools.length === 1 && asked.tools[0] === 'codex';   // python3 lo pide el aplicador de Claude Code
  const need = platform === 'win32' ? ['pwsh', 'tar'] : ['bash', 'tar', ...(codexOnly ? [] : ['python3'])];
  const out = need.filter((t) => !has(t)).map((t) => `falta ${t}${t === 'pwsh' ? ' (PowerShell 7: lo usa el aplicador de Windows)' : ''} — sugerido (no lo corro): ${suggest(t, platform, deb)}`);
  // Mac sin las herramientas de línea de comandos: /usr/bin/python3 sólo pide instalarlas; se afirma sólo si xcode-select CORRIÓ y dijo que no
  const noClt = () => { if (clt !== null) return !clt; const r = spawnSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 10000, windowsHide: true }); return !r.error && !r.signal && r.status !== 0; };
  if (need.includes('python3') && platform === 'darwin' && found('python3') === '/usr/bin/python3' && noClt()) out.push('falta python3 (el de /usr/bin pide las herramientas de línea de comandos) — sugerido (no lo corro): xcode-select --install');
  const major = Number(String(nodeVersion).split('.')[0]);
  if (!(major >= NODE_FLOOR)) out.unshift(`node ${nodeVersion} es viejo: el arnés pide Node ${NODE_FLOOR} o más — sugerido (no lo corro): ${suggest('node', platform, deb)}`);
  return out;
}

// ── las opciones ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Las opciones propias (`--repo`, `--team`, `--audience`, con las dos formas) y el resto, que pasa a `install` tal cual. */
function splitArgs(argv) {
  const out = { repo: '', team: '', audience: '', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const own = OWN_OPTIONS.find((o) => a === o || a.startsWith(`${o}=`));
    if (!own) { out.rest.push(a); continue; }
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
    if (!v) throw new Stop(2, `${own} pide un valor`);
    out[own.slice(2)] = v;
  }
  return out;
}
/** El repo del perfil con el criterio de `--team` (`parseTeam`), o null; un repo de esta máquina no vale acá. */
function teamOf(option, home) { const p = T.parseTeam(option, { home }); return p.ok && p.host !== 'local' ? p : null; }

// ── la máquina ya instalada y el permiso de lectura ───────────────────────────────────────────────────────────────
/** El arnés instalado: `{ state, tree, harness, source }`, o null si no hay. Un estado que está y no se lee sale 1. */
function installed(home) {
  const r = S.read(home);
  if (r.status === 'missing' || r.status === 'tree_missing') return null;   // un estado cuyo árbol ya no está es «sin arnés»: la instalación sigue
  if (r.status !== 'ok') throw new Stop(1, `el estado del arnés ${r.file} está pero no se lee (${r.reason}): no instalo encima. Revisalo (o, si no hay arnés, borralo) y volvé a correrlo. No instalé nada.`);
  const rel = S.releaseSource(r.state);   // sin fuente release: un clon
  const source = rel ? (GH_REPO.test(String(rel.repo || '')) && !String(rel.repo).split('/').some(dots) && /^[0-9a-f]{40}$/.test(String(rel.commit || '')) ? rel : { broken: true }) : null;
  return { state: r.state, tree: r.state.tree, harness: path.join(r.state.tree, 'scripts', 'setup', 'harness.js'), source };
}
/** La configuración guardada tiene que leerse: una que está y no se lee (o no es un objeto) sale 1 sin tocarla. */
function savedConfig(env) {
  let c;
  try { c = GA.readConfig({ env }); } catch (e) { throw new Stop(1, `${e.message}. No instalé nada.`); }
  let plain = c.ok;
  if (c.ok && fs.existsSync(c.file)) { try { const j = JSON.parse(fs.readFileSync(c.file, 'utf8')); plain = Boolean(j) && typeof j === 'object' && !Array.isArray(j); } catch (_) { plain = false; } }
  if (!plain) throw new Stop(1, `la configuración del arnés ${c.file} está pero no se lee: no la piso. Revisala (o, si no la usás, borrala) y volvé a correrlo. No instalé nada.`);
}
function limitedUntil(r) {
  if (r.status !== 403 || String(r.headers['x-ratelimit-remaining']) !== '0') return null;
  const d = new Date((Number(r.headers['x-ratelimit-reset']) || Date.now() / 1e3 + 3600) * 1e3);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Un GET con el cliente del árbol (proxy, tope, redirecciones); sin red, sale 1 con el motivo. */
function look(url, { token = '', env, accept = 'application/vnd.github+json' }) {
  const http = require(path.join(__dirname, '..', '..', 'lib', 'http-get.js'));
  const r = http.getSync(url, { headers: Object.assign({ Accept: accept }, token ? { Authorization: `Bearer ${token}` } : {}), env, timeoutMs: 30000 });
  if (!r.ok) throw new Stop(1, `sin red: no pude llegar a ${new URL(url).host} (${r.message}). No instalé nada.`);
  return r;
}

// ── el subcomando ─────────────────────────────────────────────────────────────────────────────────────────────────
const quote = (a) => (/^[\w./:=@,+%-]+$/.test(a) ? a : `'${a.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`);

/**
 * `harness.js npx <opciones>`. `ctx`: `{ env, home, argv }` (`argv` = lo que vino después de `npx`). `io` cambia lo que toca
 * la máquina (las pruebas): `launch(what, args)` corre un hijo con el mismo Node y devuelve su código, `tty`, `line()`,
 * `secret(prompt)` y `tools(nombre)` (qué hay en el PATH).
 * @returns {{ code: number, lines: string[] }}
 */
function run(ctx, io = {}) {
  const env = ctx.env || process.env; const home = ctx.home || os.homedir();
  const tty = io.tty === undefined ? P.isTerminal() : io.tty;
  const ask = () => (io.line ? io.line() : P.readLine());
  const secret = (prompt) => { process.stderr.write(`tycon-harness: ${prompt}`); return String(io.secret ? io.secret(prompt) : P.readSecret({ write: (s) => process.stderr.write(s) }).text).trim(); };
  const launch = (what, args) => {   // siempre el harness.js de ESTE árbol (args[0]), con el mismo Node y en esta terminal
    if (io.launch) return io.launch(what, args);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env, windowsHide: true });
    if (r.error) throw new Stop(1, `no pude correr ${what}: ${r.error.code || r.error.message}`);
    if (r.signal) throw new Stop(1, `${what} se cortó con la señal ${r.signal}`);
    return r.status;
  };
  const tree = (...args) => [HARNESS_JS, ...args];
  try { return { code: steps({ ctx, env, home, tty, ask, secret, launch, tree, io }), lines: [] }; } catch (e) {
    if (e instanceof Stop) { say(e.message); return { code: e.code, lines: [] }; }
    throw e;
  }
}

function steps({ ctx, env, home, tty, ask, secret, launch, tree, io }) {
  const argv = ctx.argv || [];
  const o = splitArgs(argv); const rest = o.rest;
  let { audience } = o;
  const repo = o.repo || env.TYCON_NPX_REPO || '';
  if (repo && (!GH_REPO.test(repo) || repo.split('/').some(dots))) throw new Stop(2, `--repo pide <org/nombre> (sin segmentos «.» ni «..»): ${bare(repo)}`);
  if (audience && !['me', 'team', 'org'].includes(audience)) throw new Stop(2, `--audience es me, team u org: ${audience}`);
  const commit = String(env.TYCON_NPX_COMMIT || '');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Stop(2, `harness.js npx lo corre el paquete ${PACKAGE} (baja el árbol y le pasa el commit en TYCON_NPX_COMMIT): para instalar, npx ${PACKAGE}@latest`);
  const API = env.TYCON_RELEASE_API || 'https://api.github.com';
  const PUB = Boolean(PG.bases(env));   // la API de juguete con el github.com real: nunca
  const missing = requisites({ env, args: rest, tools: io.tools || null });
  if (missing.length) { missing.forEach(say); throw new Stop(1, `no instalé nada: instalá lo que falta y volvé a correr npx ${PACKAGE}@latest`); }
  let src = o.team ? teamOf(o.team, home) : null;
  if (o.team && !src) throw new Stop(2, `el repo del perfil tiene que ser ${SHAPES}: «${bare(o.team)}». No instalé nada.`);

  const here = installed(home);
  if (here) {
    const place = `el arnés ya está en ${here.tree}`, upd = `node "${here.harness}" update --yes`;
    if (audience === 'org') { say(`${place}: sigo con el alta de tu organización (harness.js team-init)`); return launch('harness.js team-init', tree('team-init')); }
    if (src && !here.state.team) { say(`${place}: sumo el perfil del equipo con su propio install --team`); return launch('harness.js install --team', tree('install', '--team', src.repo, ...rest)); }
    // nunca se reinstala: el commit instalado contra el de la punta que trajo el paquete; con uno nuevo, se pregunta
    if (!here.source || here.source.broken) { say(`${place}, ${here.source ? 'pero el estado no dice qué commit tiene' : 'instalado desde un clon'}: para actualizarlo, ${upd}. No cambié nada.`); return 0; }
    if ((here.source.ref || 'main') !== 'main' || (repo && here.source.repo.toLowerCase() !== repo.toLowerCase())) {
      say(`${place}, pero sigue ${here.source.repo} (${here.source.ref || 'main'}) y no la punta de main de ${repo || 'este repo'}: para actualizarlo, ${upd}. No cambié nada.`); return 0;
    }
    if (commit === here.source.commit) { say(`${place}: está al día. No cambié nada (para dar de alta tu organización, --audience org).`); return 0; }
    say(`${place}: hay una versión nueva (${commit.slice(0, 7)}).`);
    if (!tty) { say(`para actualizarlo, en una terminal: npx ${PACKAGE}@latest. No cambié nada.`); return 0; }
    if (!rest.includes('--yes')) {
      process.stderr.write('tycon-harness: ¿Actualizo? [s/N] ');
      if (!P.saidYes(ask())) { say(`no actualicé: para hacerlo, npx ${PACKAGE}@latest`); return 0; }
    }
    return launch('harness.js update', tree('update', '--yes'));   // el update de ESTE árbol: la capa del equipo se evalúa con el código nuevo
  }
  if (src) audience = 'team'; else if (!audience) audience = 'me';
  if (audience === 'team' && !src) {
    if (!tty) throw new Stop(2, '--audience team pide --team <org/repo de GitHub, o la URL de Azure DevOps del repo del perfil>');
    for (let i = 0; !src; i++) {
      if (i === 3) throw new Stop(2, 'sin la dirección del repo del perfil: no instalé nada. Volvé a correrlo, o pasá --team <repo del perfil>');
      process.stderr.write('tycon-harness: la dirección del repo del perfil del equipo (org/repo de GitHub, o https://dev.azure.com/<org>/<proyecto>/_git/<repo>): ');
      const a = io.line ? { text: io.line() } : P.readAnswer();
      if (a.text === null || a.eof) throw new Stop(2, 'sin la dirección del repo del perfil: no instalé nada. Volvé a correrlo, o pasá --team <repo del perfil>');
      src = teamOf(a.text.trim(), home);
      if (!src && a.text.trim()) say(`esa dirección no es la de un repo: ${SHAPES}`);   // sin repetir lo escrito: podría ser un permiso pegado de más
    }
  }
  const team = src ? src.repo : '';
  const flagged = [env.TYCON_CLAUDE, env.TYCON_CODEX].some((v) => ['1', 'true'].includes(String(v || '').toLowerCase()));
  if (!rest.some((a) => a === '--tool' || a.startsWith('--tool=')) && !flagged) {
    const d = TL.detect({ home, env, platform: process.platform });
    if (!d.claude.installed && !d.codex.installed) throw new Stop(1, `${TL.noneFound(process.platform)}`);
  }
  if (!tty && !rest.includes('--yes') && !rest.includes('--dry-run')) {
    throw new Stop(2, `sin terminal no puedo preguntarte «¿Instalo?»: para instalar igual, corré npx ${PACKAGE}@latest ${[...argv.map(bare).map(quote), '--yes'].join(' ')}. No instalé nada.`);
  }

  // ── el permiso, antes de instalar ─────────────────────────────────────────────────────────────────────────────
  // `token` es el de GitHub (la variable o el guardado); el que se PIDE para el repo del equipo vive aparte (`teamToken`)
  const askToken = (what) => {
    if (!tty) throw new Stop(1, `${what} no se puede leer sin un permiso de GitHub: creá uno de sólo lectura (Fine-grained, Contents: read) en ${GA.TOKEN_URL} y pasalo en TYCON_GITHUB_TOKEN (o pegalo después con harness.js config set github.token). No instalé nada.`);
    say(`${what} no se puede leer sin tu permiso de GitHub: uno de sólo lectura (Fine-grained, Contents: read) en ${GA.TOKEN_URL}`);
    const t = secret('pegá el permiso de GitHub y Enter: ');
    if (!t) throw new Stop(1, 'sin permiso no puedo leer el repo: no instalé nada');
    return t;
  };
  savedConfig(env);   // una configuración que está y no se lee frena acá, antes de pedir o guardar nada
  const envToken = String(env.TYCON_GITHUB_TOKEN || '').replace(/[\r\n]/g, '');
  const token = envToken || GA.readToken({ env }).token || '';
  let teamToken = token, saveTeam = false, azureToken = '';
  if (src && src.host === 'github') {
    // ¿se lee? 401/404 es «pedí permiso»; el tope dice hasta qué hora; un 5xx o la red caída salen 1 con la causa
    let r = { status: 0 };
    if (PUB) { const g = look(PG.refsUrl(PG.bases(env), team), { env, accept: '*/*' }); r = { status: g.status }; }
    if (r.status !== 200) {
      const a = !teamToken && [401, 404].includes(r.status) ? r : look(`${API}/repos/${team}/git/ref/heads/main`, { token: teamToken, env });
      const until = a.headers ? limitedUntil(a) : null;
      if (until) throw new Stop(1, `GitHub limita las consultas al mirar el repo del perfil ${team} hasta las ${until}: probá de nuevo después de esa hora. No instalé nada.`);
      if ([401, 404].includes(a.status) && !teamToken) { teamToken = askToken(`el repo del perfil del equipo ${team}`); saveTeam = true; }
      else if ([401, 404].includes(a.status)) throw new Stop(1, `el permiso de GitHub no ve el repo del perfil ${team} (${a.status}): venció, o no tiene acceso a ese repo. El permiso: ${GA.TOKEN_URL}. No instalé nada.`);
      else if (a.status !== 200) throw new Stop(1, `GitHub contestó ${a.status} al mirar el repo del perfil ${team}. No instalé nada.`);
    }
  } else if (src) {
    // la credencial que install --team usaría (team-azure.credential): la de TYCON_AZURE_TOKEN (se guarda: install sólo lee
    // la guardada), la guardada, o la del gestor de credenciales de git; sólo sin ninguna se pide (sin terminal, sale 1)
    azureToken = String(env.TYCON_AZURE_TOKEN || '').replace(/[\r\n]/g, '');
    if (!azureToken && !AZ.credential(src, { env }).ok) {
      const where = `https://dev.azure.com/${encodeURIComponent(src.org)}/_usersSettings/tokens`;
      if (!tty) throw new Stop(1, `el repo del perfil ${team} pide un permiso de Azure DevOps de sólo lectura (Code: Read): crealo en ${where} y pasalo en TYCON_AZURE_TOKEN (o iniciá sesión una vez con git en ${team}, para que el gestor de credenciales la guarde). No instalé nada.`);
      say(`el repo del perfil ${team} pide tu permiso de Azure DevOps de sólo lectura (Code: Read): ${where}`);
      azureToken = secret('pegá el permiso de Azure DevOps y Enter: ');
      if (!azureToken) throw new Stop(1, 'sin permiso no puedo leer el repo del perfil: no instalé nada');
    }
  }
  const keep = (key, value) => { const k = GA.setKeyChecked(key, value, { env }); if (!k.ok) throw new Stop(1, `no pude guardar el permiso (${key}): ${k.reason || k.rejectedBy}`); };
  const github = envToken || (saveTeam ? teamToken : '');
  if (github) keep('github.token', github);
  if (azureToken) keep('azure.token', azureToken);

  // ── la instalación, de este árbol y en esta misma terminal ────────────────────────────────────────────────────
  const args = ['install', '--version', 'latest', ...(repo ? ['--repo', repo] : []), ...(team ? ['--team', team] : []), ...(rest.includes('--defaults') ? [] : ['--defaults']), ...rest];
  const status = launch('harness.js install', tree(...args));
  if (audience !== 'org' || status !== 0) return status;
  // «dar de alta mi organización»: install sale 0 también sin instalar (el «no» al plan, --dry-run): sin arnés no hay alta
  if (S.read(home).status !== 'ok') { say('no se instaló nada: el alta de tu organización queda para cuando instales (volvé a correr la misma línea)'); return 0; }
  say('instalado: ahora el alta de tu organización (harness.js team-init)');
  return launch('harness.js team-init', tree('team-init'));
}

module.exports = { run, requisites, tarCmd, splitArgs, teamOf, NODE_FLOOR, HARNESS_JS, PACKAGE };
