'use strict';
// github-auth.js — la credencial con que el arnés le habla a GitHub (story 8.23, tanda B · AC 11).
//
// ── LA DECISIÓN (el dueño, 2026-10-06) ───────────────────────────────────────────────────────────────────────────
// La credencial es SIEMPRE el permiso de sólo lectura que la persona pega una vez (`harness.js config set github.token`)
// y que queda guardado en `~/.tycon/config.json`, sólo para su usuario. No se lee la credencial guardada de git, del
// gestor de credenciales, de `gh` ni de otra herramienta: un solo camino en Mac, Windows y Linux (el equipo trabaja en
// Azure y casi nadie tiene login de GitHub). Sin permiso, el pedido va sin credencial —sirve el día que el repo sea
// público—; si eso no alcanza, la ÚNICA acción que se le pide a la persona es crear el permiso y pegarlo.
//
// ── LO QUE NUNCA PASA ────────────────────────────────────────────────────────────────────────────────────────────
//   · El valor no se imprime, no va a un registro, al estado, a un aviso ni a `doctor` (T11 lo busca en todo lo escrito).
//   · El valor no viaja en la línea de comandos: `config set` lo lee de stdin (o de la terminal), nunca de argv.
//   · Nunca se dispara un login, ni se invoca git.
//
// Un 404 de GitHub tiene tres causas posibles y la API no dice cuál: sin permiso guardado · el permiso no ve el repo ·
// falta aceptar la invitación al repo. `explain404` las nombra y, con lo que `GET /user` contestó, dice cuál es la
// probable. Un 401 es un permiso que venció o se revocó.
//
// Funciones puras respecto del HOME: la ruta del archivo la da tycon-home.js (`ownPaths`). Sólo módulos de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ownPaths } = require('./tycon-home.js');

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
const SET_HINT = 'harness.js config set github.token';
const CAUSES_404 = Object.freeze(['sin permiso de GitHub guardado', 'el permiso no ve el repo', 'falta aceptar la invitación al repo']);
// `azure.token` (story 8.25): el PAT de sólo lectura (Code: Read) de Azure DevOps para el repo del equipo; secreto como el de GitHub
// `paths.maintainers` (story 8.26, tanda F1): el clon del repo de mantenimiento en esta máquina, de donde el freno antes
// de publicar (scripts/hooks/public-push-guard.js) lee la lista privada. Sólo la tiene la máquina de quien mantiene.
const KEYS = Object.freeze(['github.token', 'paths.maintained', 'paths.maintainers', 'azure.token']);
const SECRET_KEYS = Object.freeze(['github.token', 'azure.token']);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** El archivo entero, o `{}`; uno ilegible se dice (nunca se pisa en silencio). */
function readConfig({ env = process.env } = {}) {
  const file = ownPaths({ env }).config;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, file, data: isObject(j) ? j : {} };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, file, data: {} };
    return { ok: false, file, data: {}, reason: `${file} no se puede leer (${e.code || e.message})` };
  }
}

/** El permiso guardado: `{ token, file }` con `token` null si no hay; `problem` si el archivo está roto. */
function readToken({ env = process.env } = {}) {
  const c = readConfig({ env });
  const t = c.data && isObject(c.data.github) && typeof c.data.github.token === 'string' ? c.data.github.token.trim() : '';
  return { token: t || null, file: c.file, problem: c.ok ? null : c.reason };
}

/** Sólo el usuario: 0600 en posix; en Windows, `icacls` deja sólo a la cuenta (si no se puede, se dice). */
function restrictToUser(file, { platform = process.platform } = {}) {
  if (platform !== 'win32') { fs.chmodSync(file, 0o600); return { ok: true }; }
  const user = process.env.USERNAME || os.userInfo().username;
  const r = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, reason: `icacls salió ${r.status === null ? 'matado' : r.status}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}` };
}

/** El archivo con una clave puesta (o sacada, con `null`): un objeto nuevo, sin tocar el que recibe. */
function nextData(current, key, value) {
  const [section, name] = key.split('.');
  const data = Object.assign({}, current);
  data[section] = Object.assign({}, isObject(data[section]) ? data[section] : {});
  if (value === null) delete data[section][name]; else data[section][name] = value;
  if (!Object.keys(data[section]).length) delete data[section];
  return data;
}

/** Escribe una clave (`github.token` o `paths.maintained`) en `~/.tycon/config.json`, atómico, sólo para el usuario. */
function setKey(key, value, { env = process.env, platform = process.platform } = {}) {
  if (!KEYS.includes(key)) return { ok: false, reason: `la clave «${key}» no es del arnés; las que existen: ${KEYS.join(', ')}` };
  const c = readConfig({ env });
  if (!c.ok) return { ok: false, reason: c.reason };
  const data = nextData(c.data, key, value);
  try {
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    const tmp = `${c.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, c.file);
  } catch (e) { return { ok: false, reason: `no pude escribir ${c.file}: ${e.message}` }; }
  const r = restrictToUser(c.file, { platform });
  return { ok: true, file: c.file, warning: r.ok ? null : `no pude dejar ${c.file} sólo para tu usuario (${r.reason})` };
}

// ── el archivo que se escribe tiene que poder leerse ─────────────────────────────────────────────────────────────────────
// `setKey` escribe; quien LEE ese archivo es otro programa: `scripts/lib/tycon-config.js`, con su vocabulario cerrado.
// Y hay DOS copias de ese lector en una máquina: la de este arnés y la que el freno de producción tiene instalada en
// /opt/tycon, con permisos de administrador, que no se actualiza sola. Una clave que el comando escribe y un lector no
// conoce deja la configuración entera «rota» para ese lector (caso real, 2026-10-10: `paths.maintainers` en las dos
// máquinas del dueño, el mismo día de publicada). Por eso `setKeyChecked` les pregunta a los lectores ANTES de escribir.
//
// Cómo se pregunta: a cada lector se le muestra una COPIA del archivo en una carpeta temporal (`TYCON_HOME` apuntando
// ahí, con su `state/` para que el lector la tome por el archivo de la máquina) — el de hoy y el que quedaría. El archivo
// real no se toca hasta que todos contestaron: no hay nada que deshacer si alguno lo rechaza, ni una ventana con el
// archivo roto. La copia va SIN los secretos (su valor no hace falta para saber si el archivo se lee), y de lo que el
// lector contesta sólo se usa si aceptó, si rechazó y si fue por una clave desconocida: su texto no se repite (puede
// traer un pedazo del archivo o el valor de una variable).
const OWN_READER = path.join(__dirname, '..', '..', 'lib', 'tycon-config.js');
const GUARD_READER = path.join('/opt', 'tycon', 'lib', 'tycon-config.js');
const GUARD_INSTALLER = 'scripts/production/install-guard.sh';
const READER_MS = 15000;

/** La cuenta real de la máquina (no `HOME` del ambiente, que una prueba o un laboratorio cambian). */
function realHomeDir() {
  try { return os.userInfo().homedir; } catch (_) { return null; }
}
function sameDir(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch (_) { return false; }
}

/**
 * Los lectores a los que se les pregunta: `[{ label, file, guard? }]`. Siempre el de este arnés. El del freno de
 * producción, si está instalado y quien corre es la cuenta real de la máquina (su `HOME` es el de la cuenta, esté donde
 * esté `TYCON_HOME`): ese freno lee la configuración de esa cuenta, no la de un laboratorio con otro `HOME`.
 */
function configReaders({ env = process.env, guardReader = GUARD_READER, realHome = realHomeDir() } = {}) {
  const out = [{ label: 'el lector de configuración de este arnés', file: OWN_READER }];
  const home = env.HOME || env.USERPROFILE || '';
  if (fs.existsSync(guardReader) && realHome && home && sameDir(home, realHome)) out.push({ label: 'el freno de producción instalado (/opt/tycon)', file: guardReader, guard: true });
  return out;
}

/** El archivo sin el valor de sus secretos: lo que se le muestra a un lector para preguntarle si lo puede leer. */
function withoutSecrets(data) {
  const out = Object.assign({}, data);
  for (const key of SECRET_KEYS) {
    const [section, name] = key.split('.');
    // sea lo que sea lo que haya ahí (un texto, o algo escrito a mano con otra forma): su valor no viaja a la copia
    if (isObject(out[section]) && Object.prototype.hasOwnProperty.call(out[section], name)) out[section] = Object.assign({}, out[section], { [name]: 'sin-valor-en-la-copia' });
  }
  return out;
}

/** Una clave que ningún lector conoce: el archivo que la trae TIENE que ser rechazado por un lector que lo lea. */
const CANARY = Object.freeze({ paths: Object.freeze({ 'clave-de-control-que-ningun-lector-conoce': '/' }) });

/**
 * ¿Este lector acepta este archivo? `{ state }`: `absent` (el lector no está) · `accepts` · `rejects` (con `unknownKey`
 * si fue por una clave que no conoce) · `unknown` con `why` (no se lo pudo correr, no terminó, o no se pudo armar la
 * copia). `data` null = la máquina sin archivo. Que el lector LEA la copia lo comprueba quien llama, con `CANARY`.
 */
function askReader(reader, data, env, { ms = READER_MS } = {}) {
  if (!fs.existsSync(reader.file)) return { state: 'absent' };
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-config-check-'));
    fs.mkdirSync(path.join(dir, 'state'));
    if (data !== null) fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(withoutSecrets(data), null, 2)}\n`, { mode: 0o600 });
    const r = spawnSync(process.execPath, [reader.file, 'validate'], { env: Object.assign({}, env, { TYCON_HOME: dir }), encoding: 'utf8', timeout: ms, windowsHide: true });
    if (r.status === null) return { state: 'unknown', why: r.error && r.error.code === 'ETIMEDOUT' ? 'no terminó a tiempo' : 'no se lo pudo correr' };
    const out = `${r.stderr || ''}\n${r.stdout || ''}`;
    if (r.status !== 0) return { state: 'rejects', unknownKey: /clave desconocida/.test(out) };
    return { state: 'accepts' };
  } catch (_) {
    return { state: 'unknown', why: 'no pude armar la copia para preguntarle' };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* una carpeta temporal sin secretos */ } }
  }
}

/**
 * `setKey`, pero el archivo que queda tiene que poder leerse. A cada lector se le pregunta por el archivo de hoy y por el
 * que quedaría, ANTES de escribir: si uno que acepta el de hoy rechaza el nuevo, no se escribe nada y se dice quién. Uno
 * que ya rechazaba el de hoy, o al que no se le pudo preguntar, no frena: se escribe y se AVISA (nunca en silencio).
 * Sacar una clave no se comprueba: no puede romper nada, y es la salida de un archivo ya roto.
 */
function setKeyChecked(key, value, { env = process.env, platform = process.platform, readers = null, readerMs = READER_MS } = {}) {
  if (value === null) return setKey(key, null, { env, platform });
  if (!KEYS.includes(key)) return { ok: false, reason: `la clave «${key}» no es del arnés; las que existen: ${KEYS.join(', ')}` };
  const c = readConfig({ env });
  if (!c.ok) return { ok: false, reason: c.reason };
  const today = fs.existsSync(c.file) ? c.data : null;
  const next = nextData(c.data, key, value);
  const notes = [];
  for (const reader of (Array.isArray(readers) ? readers : configReaders({ env }))) {
    // 🔴 Antes de creerle un «válida», se comprueba que el lector LEE la copia: se le muestra un archivo que tiene que
    // rechazar. Uno que lo acepta no está mirando lo que se le muestra —una copia vieja del freno de producción lee
    // otro archivo, el de la carpeta de Claude Code, pase lo que pase con TYCON_HOME— y su «válida» no dice nada del
    // archivo nuevo: contestaba «válida» antes y después, y la clave quedaba «guardada» sin haberla mirado nadie.
    const control = askReader(reader, CANARY, env, { ms: readerMs });
    if (control.state === 'absent') continue;
    if (control.state !== 'rejects') {
      notes.push(`no pude comprobarlo con ${reader.label} (${control.state === 'accepts' ? 'no lee la copia que se le muestra: su respuesta no dice nada de este archivo' : control.why || 'sin respuesta'})`);
      continue;
    }
    const before = askReader(reader, today, env, { ms: readerMs });
    if (before.state === 'absent') continue;
    if (before.state === 'rejects') { notes.push(`${reader.label} ya rechazaba la configuración de esta máquina antes de este cambio: no lo comprobé con él`); continue; }
    const after = askReader(reader, next, env, { ms: readerMs });
    if (after.state === 'rejects') {
      return { ok: false, rejectedBy: reader.label, guard: Boolean(reader.guard), unknownKey: Boolean(after.unknownKey),
        reason: `no guardé ${key}: ${reader.label} ${after.unknownKey ? 'no conoce esa clave' : 'rechaza el archivo con esa clave'}, y con ella leería la configuración de esta máquina como rota. No toqué ${c.file}` };
    }
    if (after.state !== 'accepts') notes.push(`no pude comprobarlo con ${reader.label} (${after.why || 'sin respuesta'})`);
    else if (before.state === 'unknown') notes.push(`${reader.label} acepta el archivo nuevo, pero no pude preguntarle por el de antes (${before.why || 'sin respuesta'})`);
  }
  const w = setKey(key, value, { env, platform });
  if (!w.ok) return w;
  return { ok: true, file: w.file, warning: [w.warning, ...notes].filter(Boolean).join(' · ') || null };
}

/** Lo que el comando le dice a la persona cuando un lector rechazó la clave: el motivo y, si fue el freno de producción, cómo seguir. */
function rejectionLines(key, r) {
  const lines = [String(r.reason)];
  if (r.guard) {
    lines.push(`  El freno de producción instalado es de una versión anterior. Reinstalalo (bash ${GUARD_INSTALLER}, pide tu clave) y volvé a correr este comando.`);
    if (key === 'paths.maintainers') lines.push('  Mientras tanto, la lista privada se puede declarar sin tocar este archivo: exportá TYCON_PUBLISH_DENYLIST=<clon>/scripts/publishing/denylist.json en el perfil de la terminal.');
  }
  return lines;
}

/** Las cabeceras del pedido: con permiso, `Authorization: Bearer`; sin él, ninguna (el pedido va sin credencial). */
function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * La acción única que se le pide a la persona cuando no hay permiso o no sirve. Con `repos` (story 8.25: la copia pública
 * y el repo del equipo), el permiso tiene que ver los DOS, y se nombran por su valor.
 */
function action({ repos = null } = {}) {
  const sobre = Array.isArray(repos) && repos.length ? `sobre ${repos.length > 1 ? 'los repos ' : 'el repo '}${repos.join(' y ')}` : 'sobre el repo';
  return `creá un permiso de sólo lectura de GitHub (Fine-grained, Contents: read ${sobre}) en ${TOKEN_URL} y pegalo con: ${SET_HINT}`;
}

/**
 * Qué decir ante un 404 del repo: las tres causas y, si se pudo mirar `/user`, la probable.
 * @param {{ token: string|null, userStatus: number|null, repo?: string|null, repos?: string[]|null, status?: number }} p —
 *   `userStatus`: lo que contestó GET /user (null: no se pidió); `repo`: cuál no se ve (story 8.25: con la copia y el repo
 *   del equipo hay dos, y se nombra el que falló); `repos`: los que el permiso tiene que ver; `status`: 404, o 403 (GitHub
 *   contesta una u otra a un permiso que no ve un repo privado: las dos son «sin acceso»).
 */
function explain404({ token, userStatus = null, repo = null, repos = null, status = 404 } = {}) {
  const causes = `las causas posibles: ${CAUSES_404.join(' · ')}`;
  let probable;
  if (!token) probable = 'la probable: sin permiso guardado';
  else if (userStatus === 200) probable = `la probable: el permiso vale pero no ve ${repo ? `el repo ${repo}` : 'el repo'} — falta aceptar la invitación, o el permiso no lo incluye`;
  else if (userStatus === 401) probable = 'la probable: el permiso guardado no sirve (venció o se revocó)';
  else probable = 'no pude mirar /user para decir cuál';
  return `el repo${repo ? ` ${repo}` : ''} no está o no se ve (${status === 403 ? '403' : '404'}); ${causes}; ${probable}. ${action({ repos })}`;
}

/** Qué decir ante un 401: el permiso que había dejó de servir. */
function explain401({ repos = null } = {}) {
  return `el permiso de GitHub guardado venció o se revocó (401). ${action({ repos })}`;
}

module.exports = { TOKEN_URL, SET_HINT, KEYS, SECRET_KEYS, CAUSES_404, readConfig, readToken, setKey, setKeyChecked, configReaders, rejectionLines, authHeaders, action, explain404, explain401, restrictToUser };
