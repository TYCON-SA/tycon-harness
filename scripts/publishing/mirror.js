#!/usr/bin/env node
'use strict';
// mirror.js — la verificación de lo publicado en el repo público (épica 8, story 8.8 · 2026-10-03; story 8.26, AC 36)
//
// POR QUÉ EXISTE: hasta el corte a GitHub el arnés se publicaba como ESPEJO —los repos internos eran la fuente y el
// público una copia que armaba el exportador— y este guion llevaba esa copia a GitHub (`plan`, `first`, `sync`) y
// absorbía los cambios ajenos. Desde el corte el repo público es la FUENTE: esa mitad no tiene nada que llevar, y se
// sacó (story 8.26, AC 36). Queda la otra mitad, que sigue haciendo falta: comprobar —con la lista privada— que lo
// publicado no nombra a nadie ni trae un secreto.
//
//   verify  clona lo publicado y lo revisa con el detector y la lista privada. Es el único subcomando: `plan`, `first`
//           y `sync` salen 2 diciendo que ya no existen.
//
// Tres partes de antes —los cambios ajenos (f), el número de versión contra su sincronización (i) y la lista de
// transformados (j)— comparaban lo publicado con lo interno: ya no hay contra qué, y el informe las da como «no aplica».
//
// LO QUE `verify` MIRA ADEMÁS DEL CLON (story 8.26, tanda F2): lo publicado que no es git —las versiones, el título y el
// cuerpo de todos los pedidos e issues, el nombre de la rama de cada pedido, lo que conserva su línea de tiempo (el
// título anterior de uno renombrado), las etiquetas y los hitos, y los comentarios de las cuatro clases—, cada lista
// leída hasta su última página. Con el arnés mantenido directo en el público, lo que un `gh` tecleado en una terminal
// o la web de GitHub publican no pasa por ningún freno de la máquina: se ve recién acá, de noche. Cada hallazgo dice
// QUÉ HACER según hasta dónde llegó (`REACH`): un secreto se rota primero; lo que cuelga sólo de una rama, una marca o
// una versión se borra; lo que llegó a `main`, a un pedido, a un issue o a un comentario, además, se pide purgar.
// Un correo `noreply` de GitHub en la identidad de un commit no es un hallazgo (la regla es del detector, la misma del
// freno antes de publicar); el nombre y la cuenta de adentro del correo sí se miran.
//   --direct           se acepta y no cambia nada (lo pasa el pipeline de la verificación diaria): desde el AC 36 de la
//                      story 8.26 `verify` es siempre directo.
//   --report <archivo> deja además el informe —lo mismo que `--json`— en ese archivo, también si frenó antes de mirar:
//                      de ahí arma su aviso el pipeline (scripts/ci/verify-notice.js). Nunca trae el texto hallado.
// Quedan afuera, a sabiendas: las discusiones y la wiki del repo (no se usan; se apagan en la configuración del repo).
//
// CÓMO FALLA: exit 0 = bien · 1 = hallazgos de `verify` · 2 = no pude (o un subcomando que ya no existe). «No pude
// leer» nunca es «no hay nada». Este guion no escribe en el público: sólo lee. El repo público
// se nombra siempre como «el de public-repos.json» —su nombre vive sólo en ese archivo, que se lee con el lector del
// exportador—, y el token no aparece en ninguna salida.
//
// A mano:
//   node scripts/publishing/mirror.js verify [--json] [--strict] [--direct] [--report <archivo>]
//        [--denied <f>] [--public-repos <f>]                          (default: los de scripts/publishing/)
//   TYCON_MIRROR_TOKEN     el token (el único lugar de donde se toma). Sin él, `verify` lee lo que es público.
//   TYCON_MIRROR_API_URL   la base de la API (default https://api.github.com)
//   TYCON_MIRROR_GIT_BASE  la base de las URL de git (default https://github.com)
//   Las dos bases van con https://; sin cifrar (http://) sólo hacia la propia máquina, donde las pruebas levantan
//   un repo y una API de mentira (la de git acepta además file://). Una base lleva sólo letras, números y
//   . _ ~ - : / [ ] — sin usuario ni clave—, y a git se le pasa ya leída, no como vino en la variable.
//
// LO QUE NO SE IMPRIME: el texto hallado, nunca; una ruta que ES un hallazgo (se cuenta, y en su lugar va un aviso); y
// de lo que viene del repo público —una ruta, una línea de git—, nada que no entre en una línea ni que el agente de la
// corrida pueda leer como una orden.
// Guía: guides/publicacion-espejo.md

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const OWN_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = 'scripts/publishing';
const GUIDE = 'guides/publicacion-espejo.md';
const PUBLIC_REPO = 'el repo de public-repos.json';

// ── Constantes, nunca configurables ─────────────────────────────────────────────────────────────────────────────
const COMMANDS = Object.freeze(['verify']);
// story 8.26 (AC 36): los subcomandos que llevaban la copia del exportador al público. Con el público como fuente ya no
// existen; nombrarlos sale 2 diciéndolo, para que un pipeline o una mano vieja no lo lea como «subcomando mal escrito».
const RETIRED = Object.freeze(['plan', 'first', 'sync']);
const RETIRED_WHY = 'ya no existe: el repo público es la fuente y nada se sincroniza desde lo interno (story 8.26, AC 36). Lo que queda es verify';
const MAIN = 'refs/heads/main';
// la rama donde la sincronización de antes del corte dejaba su pedido: `verify` sigue mirando el que haya quedado abierto
const SYNC_BRANCH = 'mirror/sync';
const CREDENTIAL_VARIABLE = 'TYCON_MIRROR_TOKEN';
const API_VARIABLE = 'TYCON_MIRROR_API_URL';
const DEFAULT_API = 'https://api.github.com';
const GIT_BASE_VARIABLE = 'TYCON_MIRROR_GIT_BASE';
const DEFAULT_GIT_BASE = 'https://github.com';
// sin cifrar sólo hacia la propia máquina: por http:// el token viajaría a la vista de cualquiera en el camino
const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);
// las opciones de configuración: su archivo por defecto vive al lado de este guion
const CONFIG = Object.freeze([
  { option: '--denied', key: 'denied', file: 'denylist.json' },
  { option: '--public-repos', key: 'publicRepos', file: 'public-repos.json' },
]);
const NAME_OK = /^[A-Za-z0-9._-]+$/;
const API_TIMEOUT_MS = 30000;
const API_MAX_BYTES = 8 * 1024 * 1024;
// Las rutas ficticias bajo las que el detector revisa lo que no es un archivo: ninguna excepción por ruta de un archivo
// de verdad las cubre, y la de identidad es donde vive la única excepción de nombre de persona (quien mergea).
const ROUTES = Object.freeze({
  pullRequest: '<pull-request>',
  identity: '<commit-identity>',
  message: '<commit-message>',
  about: '<repository-about>',
  release: '<release>',             // el título, la marca, las notas y los adjuntos de una versión (tanda F2 de la 8.26)
  paths: 'rutas-de-la-copia.txt',   // la lista de rutas, con el nombre con que la revisa el exportador
});

// ── Cómo se frena ───────────────────────────────────────────────────────────────────────────────────────────────
/** Una corrida que termina acá: con su código (1 = hallazgos, 2 = no pude) y lo que el --json dice además del motivo. */
class Stop extends Error {
  constructor(exit, message, data = {}) {
    super(message);
    this.exit = exit;
    this.data = data;
  }
}
const couldNot = (message, data) => new Stop(2, message, data);
const short = (sha) => String(sha).slice(0, 12);
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Lo que nunca se imprime: el token y la cabecera que lo lleva. Toda salida pasa por acá. Y ninguna línea le da una orden
// al agente de Azure: «##vso[…]» y «##[…]» los interpreta donde los vea, y parte de lo que se imprime lo escribió un
// tercero (una ruta de un pull request, lo que contesta un servidor).
const SECRETS = new Set();
function redact(text) {
  let out = String(text);
  for (const s of SECRETS) if (s) out = out.split(s).join('***');
  return out.replace(/##(?=vso\[|\[)/gi, '# #');
}

// Un texto que viene de afuera —una ruta del repo público, una línea de git o de un proceso hijo— se imprime en UNA
// línea, sin caracteres de control ni escapes de terminal, y con el largo acotado.
const TEXT_MAX = 300;
// los de control de ASCII y de Latin-1, y los dos separadores de línea de Unicode (por su código: U+2028 y U+2029)
const CONTROL_CHARS = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
function publicText(text, max = TEXT_MAX) {
  const line = String(text).replace(CONTROL_CHARS, '?');
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ── El exportador y el detector, cargados cuando hacen falta ────────────────────────────────────────────────────
// (el exportador arma el ambiente de su git al cargarse: se carga DESPUÉS de sacar el token del ambiente)
let exporterModule = null;
function exporter() {
  if (!exporterModule) {
    try {
      exporterModule = require('./export.js');
    } catch (e) {
      throw couldNot(`no pude cargar el exportador, ${CONFIG_DIR}/export.js (${(e && e.code) || (e && e.message) || e})`);
    }
  }
  return exporterModule;
}
function detector() {
  try {
    return require('./detector.js');
  } catch (e) {
    throw couldNot(`no pude cargar el detector, ${CONFIG_DIR}/detector.js (${(e && e.code) || (e && e.message) || e})`);
  }
}
const git = (dir, args, opts) => exporter().git(dir, args, opts);
const gitOut = (dir, args, opts) => exporter().salidaGit(dir, args, opts);

// ── Opciones ────────────────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const command = argv[0];
  if (RETIRED.includes(command)) throw couldNot(`${command} ${RETIRED_WHY}`);
  if (!COMMANDS.includes(command)) {
    throw couldNot(`subcomando desconocido: «${command === undefined ? '' : command}» (los que hay: ${COMMANDS.join(', ')})`);
  }
  const valued = new Map(CONFIG.map((c) => [c.option, c.key]));
  const args = { command };
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') args.json = true;
    else if (x === '--strict') {
      if (command !== 'verify') throw couldNot('--strict es sólo de verify');
      args.strict = true;
    } else if (x === '--direct') {
      // story 8.26, tanda F2 (AC 24): el público es la fuente. Desde el AC 36 es lo único que hay: la opción se sigue
      // aceptando (la pasa el pipeline de la verificación diaria) y no cambia nada.
      args.direct = true;
    } else if (x === '--report') {
      if (command !== 'verify') throw couldNot('--report es sólo de verify');
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw couldNot('--report necesita un valor (el archivo donde dejar el informe)');
      args.report = v;
    } else if (valued.has(x)) {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw couldNot(`${x} necesita un valor (vacío no es un valor: no cae al default)`);
      args[valued.get(x)] = v;   // la última vez que aparece manda
    } else throw couldNot(`opción desconocida: ${x}`);
  }
  return args;
}

// ── El token: sólo de su variable, y fuera del ambiente apenas se lee ───────────────────────────────────────────
/**
 * El token sale SÓLO de su variable: nunca de las credenciales de la máquina (las variables de `gh`, su llavero, un
 * ayudante de git). Se saca del ambiente apenas se lee, así ningún proceso hijo —el exportador, git— lo hereda: a git le
 * llega, sólo cuando habla con el público, como una cabecera por el ambiente (`gitAuth`).
 */
function takeToken(env) {
  const raw = String(env[CREDENTIAL_VARIABLE] == null ? '' : env[CREDENTIAL_VARIABLE]).trim();
  delete env[CREDENTIAL_VARIABLE];
  if (!raw) return null;
  if (!/^[\x21-\x7e]+$/.test(raw)) throw couldNot(`${CREDENTIAL_VARIABLE} no tiene la forma de un token (una sola palabra imprimible)`);
  SECRETS.add(raw);
  return raw;
}

/** El ambiente con que git se presenta ante el público: la cabecera por variables, nunca en un argumento ni en el disco. */
function gitAuth(token, base) {
  // sin un programa que pregunte: lo que no se puede leer sin credencial falla, no abre una ventana
  const env = { GIT_ASKPASS: '' };
  if (!token) return env;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  SECRETS.add(header);
  SECRETS.add(header.split(' ').pop());
  return { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${base}/.extraheader`, GIT_CONFIG_VALUE_0: header };
}

// ── El destino: el nombre público, y las dos bases ──────────────────────────────────────────────────────────────
/** El repo destino, con el lector del exportador: el único que conoce las claves del archivo. */
function readTarget(args) {
  const ex = exporter();
  let target;
  try {
    target = args.publicRepos ? ex.readPublicRepo(path.resolve(args.publicRepos)) : ex.readPublicRepo();
  } catch (e) {
    if (e instanceof ex.NoPudo) throw couldNot(e.message);
    throw e;
  }
  // el lector ya valida; se vuelve a mirar porque de estos dos valores salen una URL de git y una ruta de la API
  for (const k of ['org', 'repo']) {
    const v = target && target[k];
    if (typeof v !== 'string' || !v) throw couldNot(`el nombre público: el lector no devolvió "${k}"`);
    if (!NAME_OK.test(v) || v === '.' || v === '..') throw couldNot(`el nombre público: "${k}" tiene caracteres fuera de [A-Za-z0-9._-]`);
  }
  return { org: target.org, repo: target.repo };
}

// Lo que puede traer una base: nada que dos lectores de URL lean distinto. Con una barra invertida antes de una arroba,
// el lector de node ve un servidor y el de git, otro: la regla de abajo se validaba contra el primero y el token viajaba
// al segundo. Por eso la lista es corta —ni «\», ni «@», ni «%», ni espacios, ni «?», ni «#»— y a git se le pasa la URL
// ya leída y normalizada, la misma que se validó: nunca el texto crudo de la variable.
const BASE_CHARS = /^[A-Za-z0-9._~:/[\]-]+$/;

function baseUrl(env, variable, fallback, protocols) {
  const raw = String(env[variable] == null ? '' : env[variable]).trim() || fallback;
  if (!BASE_CHARS.test(raw)) {
    throw couldNot(`${variable} trae caracteres que una base no lleva: sólo letras, números y . _ ~ - : / [ ] (sin usuario ni clave, sin «?» ni «#»)`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw couldNot(`${variable} no es una URL`);
  }
  if (!protocols.includes(url.protocol)) throw couldNot(`${variable}: va con ${protocols.map((p) => `${p}//`).join(' o ')}, no con ${url.protocol}//`);
  if (url.protocol === 'file:') {
    if (url.hostname) throw couldNot(`${variable}: una base file:// es una carpeta de esta máquina, no lleva servidor`);
  } else if (!url.hostname) throw couldNot(`${variable} no dice a qué servidor`);
  if (url.protocol === 'http:' && !LOCAL_HOSTS.includes(url.hostname)) {
    throw couldNot(`${variable}: sin cifrar (http://) sólo se habla con la propia máquina; para ${url.host} va con https://`);
  }
  if (url.username || url.password) throw couldNot(`${variable} no lleva usuario ni clave`);
  if (url.search || url.hash) throw couldNot(`${variable} es una base: no lleva «?» ni «#»`);
  return { url, text: url.href.replace(/\/+$/, '') };
}

/** Lo que toda corrida arma antes de tocar nada: el destino (AC 1) y las dos bases. */
function prepare(args, token) {
  const target = readTarget(args);
  const gitBase = baseUrl(process.env, GIT_BASE_VARIABLE, DEFAULT_GIT_BASE, ['https:', 'http:', 'file:']).text;
  const api = baseUrl(process.env, API_VARIABLE, DEFAULT_API, ['https:', 'http:']).url;
  return {
    args, token, target, api, gitBase,
    remote: `${gitBase}/${target.org}/${target.repo}.git`,
    auth: gitAuth(token, gitBase),
    tmp: makeTemp(),
  };
}

// ── Temporales: lo que creó ESTA corrida, y nada más ────────────────────────────────────────────────────────────
const TEMPS = [];
function makeTemp() {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-'));
  } catch (e) {
    throw couldNot(`no pude crear una carpeta temporal en ${os.tmpdir()} (${(e && e.code) || e})`);
  }
  TEMPS.push(dir);
  return dir;
}
function cleanup() {
  for (const d of TEMPS.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (e) {
      // lo que no se pudo borrar se dice, no se traga
      process.stderr.write(`⚠️ mirror: no pude borrar el temporal ${d} (${(e && e.code) || e}) — borralo a mano\n`);
    }
  }
}

// ── El público: leerlo ──────────────────────────────────────────────────────────────────────────────────────────
/** git hablando con el público: aislado como el del exportador, sin ayudante de credenciales, con la cabecera por el ambiente. */
// Tampoco sigue redirecciones: la cabecera con el token va al servidor que se validó, y a ningún otro al que ése mande.
const remoteGit = (ctx, dir, args) => git(dir, ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', ...args], { env: ctx.auth });

/** Un texto de git sin el nombre ni la URL del repo: la salida no los trae. */
function withoutRepo(ctx, text) {
  let out = String(text);
  for (const s of [ctx.remote, ctx.remote.replace(/^file:\/\//, ''), `${ctx.target.org}/${ctx.target.repo}`]) out = out.split(s).join('<el repo>');
  return out;
}

/** Por qué no se pudo leer, sin la URL del repo. Nada se decide por lo que no se pudo leer: siempre es un 2. */
function unreadable(ctx, stderr) {
  const s = String(stderr || '').toLowerCase();
  if (/could not read username|terminal prompts disabled|authentication failed|repository not found|returned error: 40[134]/.test(s)) {
    return ctx.token
      ? `no pude leer ${PUBLIC_REPO}: GitHub no aceptó el token (¿venció, o la App no está instalada en ese repo?)`
      : `no pude leer: el repo es privado (o no existe) y falta el token de lectura (${CREDENTIAL_VARIABLE})`;
  }
  if (/does not appear to be a git repository|no such file or directory/.test(s)) return `no pude leer: ${PUBLIC_REPO} no existe`;
  const last = String(stderr || '').trim().split('\n').pop() || 'git no dijo por qué';
  return `no pude leer ${PUBLIC_REPO}: ${publicText(withoutRepo(ctx, last), 500)}`;
}

// ── La API ──────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Un pedido a la API sobre el repo público: `rest` es lo que sigue a la ruta del repo. Devuelve el código y el cuerpo
 * leído como JSON (o null). Un error de red es «no pude» (2): lo ataja quien pueda seguir sin esa respuesta. No sigue
 * redirecciones —el token no viaja a otro servidor— y habla http:// o https:// según la base.
 */
function apiCall(ctx, method, rest, body) {
  const base = ctx.api;
  const client = base.protocol === 'https:' ? require('https') : require('http');
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mirror.js' };
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`;
  if (payload) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: base.protocol,
      hostname: base.hostname.replace(/^\[|\]$/g, ''),
      port: base.port || undefined,
      path: `${base.pathname.replace(/\/+$/, '')}/repos/${ctx.target.org}/${ctx.target.repo}${rest}`,
      method,
      agent: false,
      timeout: API_TIMEOUT_MS,
      headers,
    }, (answer) => {
      const chunks = [];
      let size = 0;
      answer.on('data', (chunk) => {
        size += chunk.length;
        if (size > API_MAX_BYTES) {
          reject(couldNot('la API contestó más de lo que se esperaba leer'));
          answer.destroy();
          return;
        }
        chunks.push(chunk);
      });
      answer.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          json = null;
        }
        resolve({ status: answer.statusCode, json });
      });
      answer.on('error', (e) => reject(couldNot(`la respuesta de la API se cortó (${(e && e.code) || 'error de red'})`)));
    });
    request.on('timeout', () => {
      reject(couldNot(`la API no contestó en ${API_TIMEOUT_MS / 1000} segundos`));
      request.destroy();
    });
    request.on('error', (e) => reject(couldNot(`no pude hablar con la API (${(e && e.code) || 'error de red'})`)));
    request.end(payload || undefined);
  });
}

/** Una lectura que tiene que dar 200 con un cuerpo que se entienda: cualquier otra cosa es «no pude leer». */
async function apiRead(ctx, rest, what) {
  const r = await apiCall(ctx, 'GET', rest);
  if (r.status !== 200 || r.json === null) throw couldNot(`la API contestó ${r.status} al leer ${what}`);
  return r.json;
}

// Una lista de la API, ENTERA (story 8.26, tanda F2 · AC 24). GitHub la da de a páginas: quedarse con la primera es dar
// por limpio lo que no se leyó —y lo viejo, que es donde la lista aprende nombres nuevos, está en las últimas—. Se pide
// página por página hasta una que venga incompleta. Cualquier página que no se pudo leer, o que no es una lista, es
// «no pude leer» de la lista entera; y si las páginas no terminan nunca, también (no se corta callado en un tope).
const PAGE_SIZE = 100;
const MAX_PAGES = 500;
async function apiList(ctx, rest, what) {
  const out = [];
  const join = rest.includes('?') ? '&' : '?';
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) throw couldNot(`la API dio más de ${MAX_PAGES} páginas al leer ${what}: no las doy por leídas`);
    const items = await apiRead(ctx, `${rest}${join}per_page=${PAGE_SIZE}&page=${page}`, `${what} (página ${page})`);
    if (!Array.isArray(items)) throw couldNot(`la API no contestó una lista al leer ${what} (página ${page})`);
    out.push(...items);
    if (items.length < PAGE_SIZE) return out;
  }
}

/**
 * Los elementos de una lista que contestó la API, que tienen que ser objetos. 🔴 Uno que no lo es no se saltea:
 * salteado, la lista se daría por leída con un elemento menos y nadie sabría cuál. Es «no pude leer» de la parte entera.
 */
function each(list, what) {
  if (!list.every((item) => item && typeof item === 'object' && !Array.isArray(item))) throw couldNot(`la API contestó un elemento que no se puede leer en ${what}: no la doy por leída`);
  return list;
}

const SHA = /^[0-9a-f]{40,64}$/;

/** Quién firma una línea `author`/`committer`/`tagger` de un objeto: sin la fecha del final. */
const signer = (line) => {
  const m = /^(.*) \d+ [+-]\d{4}$/.exec(line);
  return m ? m[1] : line;
};

/**
 * Un commit leído CRUDO (`cat-file`), no por un formato de `git log`: lo que el objeto trae, tal cual. Así no hay un
 * separador que un mensaje pueda traer adentro.
 */
/**
 * Las lecturas de un objeto (un commit o un tag): sus encabezados y su cuerpo, como texto. La primera es siempre UTF-8.
 * Si el objeto declara otra codificación (el encabezado `encoding`) se suma la lectura en ésa — y se revisan las dos:
 * lo declarado puede no ser lo escrito. Una de 16 bits vale sólo para el cuerpo (los encabezados son ASCII, o git no
 * los leería) y se lee en los dos órdenes de bytes. `unsure` dice por qué NO se puede asegurar que alguna lectura sea
 * la buena —una codificación que no se sabe leer, o bytes nulos que ninguna lectura explica—: eso no es un objeto
 * limpio, es uno que no se pudo mirar.
 */
function objectReadings(buffer) {
  const end = buffer.indexOf('\n\n');
  const headBytes = end < 0 ? buffer : buffer.subarray(0, end);
  const bodyBytes = end < 0 ? Buffer.alloc(0) : buffer.subarray(end + 2);
  const head = headBytes.toString('utf8');
  const readings = [{ head, body: bodyBytes.toString('utf8') }];
  const declared = /^encoding (.+)$/m.exec(headBytes.toString('latin1'));
  let wide = false;
  let unsure = null;
  if (declared && !/^utf-?8$/i.test(declared[1].trim())) {
    try {
      const decoder = new TextDecoder(declared[1].trim());
      wide = /^utf-16/.test(decoder.encoding);
      if (wide) for (const order of ['utf-16le', 'utf-16be']) readings.push({ head, body: new TextDecoder(order).decode(bodyBytes) });
      else readings.push({ head: decoder.decode(headBytes), body: decoder.decode(bodyBytes) });
    } catch (_) {
      unsure = 'declara una codificación que no sé leer';
    }
  }
  if (!wide && !unsure && buffer.includes(0)) unsure = 'trae bytes nulos y no declara una codificación de 16 bits que los explique';
  return { readings, unsure };
}

function parseCommit(sha, buffer) {
  const { readings, unsure } = objectReadings(buffer);
  const read = ({ head, body }) => {
    const commit = { tree: null, parents: [], author: null, committer: null, message: body };
    for (const line of head.split('\n')) {
      const m = /^(tree|parent|author|committer) (.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'tree') commit.tree = m[2];
      else if (m[1] === 'parent') commit.parents.push(m[2]);
      else commit[m[1]] = signer(m[2]);
    }
    return commit;
  };
  const all = readings.map(read);
  // los datos del commit son los de su lectura en UTF-8; `readings` y `unsure` son para quien revisa su texto
  return { sha, ...all[0], readings: all, unsure };
}
function readCommits(dir, shas) {
  const objects = exporter().leerObjetos({ dir }, shas);
  return shas.map((sha) => parseCommit(sha, objects.get(sha)));
}

// ── La versión numerada (story 8.13, AC 24) ─────────────────────────────────────────────────────────────────────
// `version.json` va en la raíz de lo publicado: `YYYY.MM.DD.N` y el commit de cada fuente interna. Lo agrega ESTE guion
// y no el exportador, porque el número depende de lo que el público tiene y el exportador corre antes de leerlo. La
// forma del archivo sí es del exportador: su nombre, la forma del número y la función que arma sus bytes salen de ahí.
//
// La regla del número (decisión D1): la fecha es la del commit de la sincronización —la mayor fecha de committer de los
// commits internos, en UTC—, y `N` es 1 más el mayor `N` entre el de la punta de `main` y el de la punta de la rama de
// la sincronización, contando sólo los de esa misma fecha; si ninguno es de esa fecha, 1. Nada de esto mira el reloj ni
// el huso de la máquina: las mismas entradas dan el mismo número, corran cuando corran.

// ── Lo que se escribe en el público: el commit, y los textos revisados antes ────────────────────────────────────
/** La lista privada, leída una vez: con ella se revisa lo publicado y todo texto que este guion escribe en el público. */
function loadList(ctx, why) {
  if (ctx.list) return ctx.list;
  const file = ctx.args.denied ? path.resolve(ctx.args.denied) : path.join(OWN_ROOT, CONFIG_DIR, 'denylist.json');
  try {
    ctx.list = detector().cargarConfig(file);
  } catch (e) {
    throw couldNot(`${why}, y ${ctx.args.denied ? file : `${CONFIG_DIR}/denylist.json`} no sirve `
      + `(${(e && e.message) || e}) — donde ese archivo no viaja, pasala con --denied <f>`);
  }
  return ctx.list;
}

// ── verify: lo publicado, revisado con la lista privada ─────────────────────────────────────────────────────────
// Se mira lo que GitHub SIRVE, no lo que se empujó: el clon entero, con TODAS sus refs (ramas, etiquetas, cabezas de
// pull requests y cualquier otra), porque la historia pública conserva cada árbol mergeado y la lista aprende nombres
// nuevos. Ante la duda se mira de más: lo que no se mira sale como limpio, y eso es lo único que no puede pasar.
const PARTS = Object.freeze({
  a: 'el contenido de main',
  "a'": 'cada archivo de cada árbol alcanzable desde cualquier ref, y su ruta',
  b: 'las rutas de main',
  c: 'la identidad y el mensaje de cada commit y tag, y el nombre de cada ref',
  d: 'la descripción, el sitio y los temas del repo',
  e: 'el pull request abierto de la sincronización',
  f: 'cambios ajenos sin absorber',
  g: 'alertas abiertas del escaneo de secretos de GitHub',
  h: 'el reporte privado de vulnerabilidades',
  i: 'el número de versión (version.json) de main y de la rama de la sincronización',
  j: 'la lista de transformados (version.json) contra el commit interno de cada sincronización',
  // story 8.26, tanda F2 (AC 24): lo publicado que no es git. Lo que un `gh` tecleado en una terminal, la web de GitHub
  // u otra herramienta publican sin pasar por ningún freno de la máquina se ve recién acá.
  k: 'las versiones: su título, su marca, sus notas, de dónde se cortaron y sus adjuntos',
  l: 'el título y el cuerpo de cada pedido y de cada issue (abiertos y cerrados), la rama de cada pedido, su línea de tiempo, y las etiquetas y los hitos del repo',
  m: 'los comentarios: de conversación, de revisión (con el fragmento que muestran), el cuerpo de cada revisión y los de commits',
});
const IN_THE_CLONE = Object.freeze(['a', "a'", 'b', 'c', 'f', 'i', 'j']);
// Las partes atadas a la sincronización desde lo interno. Con `--direct` (el público es la fuente) no hay sincronización
// contra la cual comparar: dicen «no aplica» — un commit del dueño directo en `main` no es un «cambio ajeno».
const SYNC_PARTS = Object.freeze(['f', 'i', 'j']);
const DIRECT_REASON = 'el público es la fuente: no hay una sincronización contra la cual comparar';

// QUÉ HACER con cada hallazgo (AC 24). Depende de hasta dónde llegó lo hallado, no de qué es:
//   · lo que cuelga sólo de una rama, una marca o una versión se borra, y con eso deja de servirse;
//   · lo que llegó a `main` o a un pedido —o a un issue o a un comentario— no se despublica borrándolo: los commits
//     siguen alcanzables por la referencia del pedido, y GitHub guarda el historial de ediciones de un texto. Además de
//     borrarlo o corregirlo, se pide la purga al soporte de GitHub;
//   · un secreto se rota PRIMERO, esté donde esté: publicado, se da por comprometido.
const REACH = Object.freeze({
  main: { action: 'delete-and-purge', text: 'llegó a main: se saca, y además se pide la purga al soporte de GitHub (reescribir main no lo despublica)' },
  pull: { action: 'delete-and-purge', text: 'está en un pedido: se cierra el pedido y se borra su rama, y además se pide la purga al soporte de GitHub (la referencia del pedido lo sigue sirviendo)' },
  ref: { action: 'delete', text: 'cuelga sólo de una rama o de una marca: se borra esa rama o esa marca' },
  release: { action: 'delete', text: 'está en una versión: se borra la versión (o el adjunto)' },
  conversation: { action: 'delete-and-purge', text: 'está en un pedido, un issue o un comentario: se borra o se corrige, y además se pide la purga al soporte de GitHub (el historial de ediciones lo conserva)' },
  about: { action: 'edit', text: 'se corrige en la configuración del repo' },
  guide: { action: 'see-guide', text: `qué hacer: ${GUIDE}, §«Si \`verify\` da 1»` },
});
// Con el repo PRIVADO el consejo es otro (story 8.26, tanda F3 · AC 58; la guía, §«Si `verify` da 1»): nada se purga
// —no hay nada público que despublicar—, lo que se escapó se arregla en el interno y sale con la sincronización
// siguiente, y lo que queda en la historia se acepta hasta el corte, cuando el repo se recrea sin historia. Sólo
// cambian los tres alcances cuyo consejo nombra la purga; lo que se borra se sigue borrando y lo del repo se sigue
// corrigiendo en su configuración. Cambia el TEXTO: la acción, el lugar y el código de salida son los mismos.
const REACH_PRIVATE = Object.freeze({
  main: 'el repo es privado: si sigue en main, se arregla en el interno y sale de lo publicado con la sincronización siguiente; en la historia queda, y se acepta hasta el corte (sin purga)',
  pull: 'está en un pedido del repo privado: se cierra el pedido y se borra su rama (sin purga; lo que queda en la referencia del pedido se acepta hasta el corte)',
  conversation: 'está en un pedido, un issue o un comentario del repo privado: se borra o se corrige (sin purga)',
});
const ROTATE_FIRST = 'es un secreto: se rota PRIMERO (publicado, se da por comprometido); después, ';
const isSecret = (category) => category === 'secreto' || category === 'secret-alert';
/** El número de algo que contestó la API: un número, o «?» — nunca un texto que la respuesta haya querido poner ahí. */
const numberOf = (item) => (item && Number.isInteger(item.number) ? item.number : '?');

/** Un blob, con la regla del detector para un archivo: un binario sin permiso es un hallazgo («sin leer»), no un archivo limpio. */
function reviewBlob(d, cfg, data, rel) {
  if (d.esBinario(data)) {
    const allowed = cfg.binariosPermitidos.some((g) => g.test(rel)) || cfg.permitidos.some((p) => !p.patron && p.archivo.test(rel));
    return allowed ? [] : [{ linea: 0, categoria: 'sin-leer' }];
  }
  return d.reviewText(cfg, data.toString('utf8'), rel).hallazgos;
}

/**
 * Las partes que se miran en el clon: (a), (a'), (b) y (c). La salida dice dónde, nunca qué. Devuelve cuántos commits
 * quedaron bajo la excepción de identidad de los pull requests.
 */
function verifyClone(d, cfg, dir, found, looked, cant) {
  const ex = exporter();
  const repo = { dir };
  const review = (text, route) => d.reviewText(cfg, String(text == null ? '' : text), route).hallazgos;
  // Hasta dónde llegó cada objeto, para decir qué hacer con él (AC 24 de la 8.26): lo alcanzable desde `main`, lo
  // alcanzable desde la cabeza de algún pedido, y lo demás, que cuelga sólo de una rama o de una marca.
  const reachable = (revs) => new Set(gitOut(dir, ['rev-list', '--objects', ...revs]).split('\n').filter(Boolean).map((l) => l.split(' ')[0]));
  const fromMain = reachable([MAIN]);
  const anyPull = gitOut(dir, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/pull/']).trim() !== '';
  const fromPulls = anyPull ? reachable(['--glob=refs/pull/*']) : new Set();
  const reachOf = (sha) => (fromMain.has(sha) ? 'main' : fromPulls.has(sha) ? 'pull' : 'ref');

  const entries = ex.listarArbol(repo, MAIN);
  const mainPaths = new Set(entries.map((e) => e.ruta));
  // el nombre de cada ruta, mirado como lo mira el exportador (bajo el nombre de su lista de rutas): una vez cada una
  const nameFindings = new Map();
  const nameOf = (rel) => {
    if (!nameFindings.has(rel)) nameFindings.set(rel, review(rel, ROUTES.paths));
    return nameFindings.get(rel);
  };
  // una ruta con un hallazgo ES lo hallado: no se imprime, y se dice qué parte la ubica
  const shown = (rel) => {
    if (!nameOf(rel).length) return publicText(rel);
    return mainPaths.has(rel) ? '(una ruta con un hallazgo: la parte (b) dice cuál)'
      : "(una ruta con un hallazgo, fuera de la punta de main: la parte (a') la ubica por su objeto)";
  };
  const at = (rel, h) => `${shown(rel)}${h.linea ? `:${h.linea}` : ''}`;

  // (a) el contenido de main, cada archivo con su ruta desde la raíz
  const files = entries.filter((e) => e.tipo === 'blob');
  const now = ex.leerObjetos(repo, files.map((e) => e.obj));
  for (const e of entries) {
    if (e.tipo !== 'blob') found('a', 'sin-leer', `${shown(e.ruta)} (no es un archivo: un submódulo)`, 'main');
    else for (const h of reviewBlob(d, cfg, now.get(e.obj), e.ruta)) found('a', h.categoria, at(e.ruta, h), 'main');
  }
  looked.a = entries.length;

  // (a') cada archivo de cada árbol alcanzable desde cualquier ref, que no sea uno de la punta de main: cada par
  // (ruta, objeto) una vez, con SU ruta. Las excepciones de la lista son por ruta: el mismo contenido en dos rutas son dos
  // preguntas, y la respuesta no puede depender de cuál aparece primero en un recorrido. Y la ruta misma se revisa: la
  // historia conserva cada árbol mergeado, y la lista aprende nombres nuevos igual para un nombre de archivo.
  const GITLINK = '160000';
  const key = (sha, rel) => `${sha}\0${rel}`;
  const inMain = new Set(entries.map((e) => key(e.obj, e.ruta)));
  const pairs = new Map();
  const add = (sha, rel, mode) => {
    if (!inMain.has(key(sha, rel)) && !pairs.has(key(sha, rel))) pairs.set(key(sha, rel), { sha, rel, mode });
  };
  // Todo par que está en el árbol de algún commit aparece como «lo nuevo» de la diferencia de algún commit contra alguno
  // de sus padres (o contra nada, si es una raíz): git los da todos en una pasada, terminados en NUL.
  const introduced = (revs, each) => {
    const tokens = gitOut(dir, ['log', ...revs, '-m', '--root', '--raw', '-z', '--no-abbrev', '--no-renames', '--format=']).split('\0');
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      const m = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/.exec(tokens[i].replace(/^\n+/, ''));
      if (!m) continue;
      i += 1;   // lo que sigue a esa cabecera es su ruta, traiga lo que traiga
      if (!/^0+$/.test(m[2])) each(m[2], tokens[i], m[1]);
    }
  };
  introduced(['--all'], add);
  // Hasta dónde llegó cada PAR (AC 24): por los commits que lo traen, no por su objeto. El objeto de un submódulo es un
  // commit de OTRO repo y nunca figura entre los alcanzables de éste —por su objeto, uno que llegó a `main` salía como
  // «cuelga de una rama»—; y el mismo contenido puede estar en `main` en una ruta permitida y en una rama en otra que
  // no. Dos pasadas más, sobre lo que alcanza `main` y sobre lo que alcanzan los pedidos (pase adversarial de la F2).
  const pairsOf = (revs) => { const set = new Set(); introduced(revs, (sha, rel) => set.add(key(sha, rel))); return set; };
  const mainPairs = pairsOf([MAIN]);
  const pullPairs = anyPull ? pairsOf(['--glob=refs/pull/*']) : new Set();
  // Lo que cuelga de una ref sin pasar por un commit (más abajo) no tiene un commit que lo traiga, y tampoco está en
  // `main` ni en un pedido: si su objeto estuviera en alguno de sus commits, ya habría entrado como par de ese commit.
  const pairReach = (p) => (mainPairs.has(key(p.sha, p.rel)) ? 'main' : pullPairs.has(key(p.sha, p.rel)) ? 'pull' : 'ref');
  // Y lo que cuelga de una ref sin pasar por un commit (una etiqueta que apunta a un árbol, a un archivo o a otra
  // etiqueta): la lista de objetos alcanzables los trae a todos, cada uno con el nombre con que se llegó a él.
  const listed = [];
  for (const line of gitOut(dir, ['rev-list', '--objects', '--all']).split('\n')) {
    const cut = line.indexOf(' ');
    if (cut >= 0) listed.push([line.slice(0, cut), line.slice(cut + 1)]);   // sin espacio es un commit
  }
  const types = new Map(!listed.length ? [] : gitOut(dir, ['cat-file', '--batch-check'], { input: `${listed.map(([sha]) => sha).join('\n')}\n` })
    .split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2)));
  const reached = new Set([...files.map((e) => e.obj), ...[...pairs.values()].map((p) => p.sha)]);
  for (const [sha, rel] of listed) if (types.get(sha) === 'blob' && !reached.has(sha)) add(sha, rel, null);

  const outside = [...pairs.values()].sort((x, y) => byCode(x.rel, y.rel) || byCode(x.sha, y.sha));
  const before = ex.leerObjetos(repo, outside.filter((p) => p.mode !== GITLINK).map((p) => p.sha));
  // El NOMBRE de una ruta se dice una vez, aunque la ruta haya tenido varios contenidos. Lo que hay que hacer con él
  // sale del par que MÁS lejos llegó —si alguno llegó a `main`, la ruta está en la historia de `main`—, y ése es el
  // objeto que se cita: con el primero del recorrido, una ruta que estuvo en `main` y además en una rama salía, según
  // el orden de dos sha, como «se borra la rama» (pase adversarial de la F2).
  const RANK = { main: 0, pull: 1, ref: 2 };
  const farthest = new Map();
  for (const p of outside) {
    const reach = pairReach(p);
    const best = farthest.get(p.rel);
    if (!best || RANK[reach] < RANK[best.reach]) farthest.set(p.rel, { reach, sha: p.sha });
  }
  const named = new Set();
  for (const p of outside) {
    if (p.mode === GITLINK) found("a'", 'sin-leer', `${shown(p.rel)} (no es un archivo: un submódulo, en la historia o en otra ref)`, pairReach(p));
    else for (const h of reviewBlob(d, cfg, before.get(p.sha), p.rel)) found("a'", h.categoria, `${at(p.rel, h)} (el objeto ${short(p.sha)}, en la historia o en otra ref)`, pairReach(p));
    if (mainPaths.has(p.rel) || named.has(p.rel)) continue;   // las rutas de main las dice (b)
    named.add(p.rel);
    const far = farthest.get(p.rel);
    for (const category of new Set(nameOf(p.rel).map((h) => h.categoria))) {
      found("a'", category, `una ruta fuera de la punta de main, que no se imprime: la del objeto ${short(far.sha)} (\`git log --all --find-object=${far.sha}\` dice en qué commit)`, far.reach);
    }
  }
  looked["a'"] = outside.length;

  // (b) la lista de rutas de main, en el orden en que la da git
  const paths = entries.map((e) => e.ruta);
  for (const h of review(paths.join('\n'), ROUTES.paths)) found('b', h.categoria, `la ruta nº ${h.linea} de \`git ls-tree -r --name-only main\``, 'main');
  looked.b = paths.length;

  // (c) la identidad y el mensaje de TODOS los commits y tags alcanzables, y el nombre de cada ref.
  // Los commits que cuelgan SÓLO de la cabeza de un pull request los escribió alguien de afuera, con su identidad de git
  // de siempre, y esa ref no la puede borrar el equipo: con la regla genérica de correos, el primer pull request ajeno
  // dejaba esto en 1 para siempre. Ahí la identidad se revisa sin esa regla —los términos de la lista sí se buscan,
  // igual que en el mensaje y en el contenido—; en lo alcanzable desde una rama o una etiqueta no cambia nada.
  const pullOnly = new Set(gitOut(dir, ['rev-list', '--glob=refs/pull/*', '--not', '--exclude=refs/pull/*', '--all']).split('\n').filter(Boolean));
  const genericEmail = (d.PATRONES_GENERICOS || []).find((p) => p.nombre === 'email');
  const withoutEmailRule = { ...cfg, reglas: cfg.reglas.filter((r) => r !== genericEmail) };
  // Un correo `noreply` de GitHub en una identidad NO es un hallazgo: es la dirección con que se escribe en el público,
  // y la regla vive en el detector (no es de este guion: la comparten el exportador y el freno antes de publicar). Lo que
  // sí se mira contra la lista —va en la misma línea— son el nombre con que se firma y la cuenta de adentro del correo.
  const identity = (sha, text) => d.reviewText(pullOnly.has(sha) ? withoutEmailRule : cfg, String(text == null ? '' : text), ROUTES.identity).hallazgos;
  // Un objeto puede tener más de una lectura (la codificación que declara, y UTF-8): se revisan todas, y lo que
  // encuentran dos lecturas en el mismo lugar se dice una vez.
  const across = (readings, each) => {
    const seen = new Map();
    for (const reading of readings) for (const h of each(reading)) seen.set(`${h.categoria}\0${h.linea}`, h);
    return [...seen.values()];
  };
  const unsure = [];   // los objetos que no se pudieron leer con certeza: no salen limpios
  // cada commit se lee del objeto, no de un formato de `git log`: no hay separador que un mensaje pueda traer adentro
  const commits = gitOut(dir, ['rev-list', '--all']).split('\n').filter(Boolean);
  for (const c of readCommits(dir, commits)) {
    if (c.unsure) unsure.push(`el commit ${c.sha} ${c.unsure}`);
    for (const h of across(c.readings, (r) => identity(c.sha, r.author))) found('c', h.categoria, `el commit ${c.sha} (autor)`, reachOf(c.sha));
    for (const h of across(c.readings, (r) => identity(c.sha, r.committer))) found('c', h.categoria, `el commit ${c.sha} (committer)`, reachOf(c.sha));
    for (const h of across(c.readings, (r) => review(r.message, ROUTES.message))) found('c', h.categoria, `el commit ${c.sha} (mensaje, línea ${h.linea})`, reachOf(c.sha));
  }
  // cada objeto tag alcanzable —también el que cuelga de otro tag, sin ref propia—: el nombre que declara (que no tiene
  // por qué ser el de la ref: renombrar una etiqueta no cambia el objeto), quién lo creó y su mensaje
  const tags = [...new Set(listed.filter(([sha]) => types.get(sha) === 'tag').map(([sha]) => sha))];
  for (const [sha, buffer] of ex.leerObjetos(repo, tags)) {
    const tag = objectReadings(buffer);
    if (tag.unsure) unsure.push(`el tag ${sha} ${tag.unsure}`);
    const header = (key) => (r) => {
      const m = new RegExp(`^${key} (.*)$`, 'm').exec(r.head);
      return m ? m[1] : null;
    };
    for (const h of across(tag.readings, (r) => review(header('tag')(r), ROUTES.message))) found('c', h.categoria, `el tag ${sha} (el nombre que declara)`, 'ref');
    for (const h of across(tag.readings, (r) => identity(sha, signer(header('tagger')(r) || '')))) found('c', h.categoria, `el tag ${sha} (quien lo creó)`, 'ref');
    for (const h of across(tag.readings, (r) => review(r.body, ROUTES.message))) found('c', h.categoria, `el tag ${sha} (mensaje, línea ${h.linea})`, 'ref');
  }
  if (unsure.length) {
    cant('c', `${unsure.length} objeto(s) con una codificación que no se puede leer con certeza: su identidad y su mensaje no se dan por revisados. `
      + `El primero: ${unsure[0]}`);
  }
  const refs = gitOut(dir, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
  refs.forEach((name, i) => {
    // el nombre de la cabeza de un pedido no lo puede borrar nadie del equipo: cuenta como «está en un pedido»
    const refReach = name.startsWith('refs/pull/') ? 'pull' : 'ref';
    for (const h of review(name, ROUTES.message)) found('c', h.categoria, `el nombre de la ref nº ${i + 1} de \`git for-each-ref\``, refReach);
    // Una ref de reemplazo le dice a git que lea OTRO objeto en lugar de uno publicado. Acá no se aplica (el clon se
    // arma sin reemplazos: se mira lo publicado), pero quien clone el repo sí la aplica, y sirve para tapar: se dice.
    if (name.startsWith('refs/replace/')) {
      found('c', 'replace-ref', `la ref nº ${i + 1} de \`git for-each-ref\`: una ref de reemplazo (hace que git lea otro objeto en lugar del publicado)`, 'ref');
    }
  });
  looked.c = commits.length + tags.length + refs.length;
  return pullOnly.size;
}

async function verify(ctx) {
  const d = detector();
  const cfg = loadList(ctx, 'no pude mirar: lo publicado se revisa con la lista privada');
  const result = { findings: [], notMeasured: [], notApplicable: [], couldNotLook: [] };
  const looked = {};
  // story 8.26 (AC 36): el público es la FUENTE. La mitad que sincronizaba desde lo interno ya no existe, y con ella
  // las tres partes atadas a esa sincronización (cambios ajenos, número de versión, transformados): dicen «no aplica».
  const direct = true;
  /**
   * Un hallazgo, con lo que hay que hacer: `reach` dice hasta dónde llegó (REACH); un secreto se rota primero. El
   * alcance queda en el hallazgo (tanda F3): lo lee el aviso, para saber qué está sólo en la historia de `main`.
   */
  const found = (part, category, place, reach = 'guide') => {
    const known = Object.prototype.hasOwnProperty.call(REACH, reach) ? reach : 'guide';
    const to = REACH[known];
    const rotate = isSecret(category);
    result.findings.push({ part, category, place, reach: known, action: to.action, rotateFirst: rotate, todo: `${rotate ? ROTATE_FIRST : ''}${to.text}` });
  };
  // Lo que la API contesta donde va un texto es un texto, o nada (falta, o nulo). Otra cosa —un objeto, un número, una
  // lista— no se lee como «[object Object]», que saldría limpio: no se pudo leer, y la parte que lo pidió lo dice
  // (revisor de fallos silenciosos, quinta vuelta de la F2). Todas las llamadas corren dentro de un `look`.
  const review = (text, route) => {
    if (text !== undefined && text !== null && typeof text !== 'string') throw couldNot('la API contestó otra cosa donde iba un texto: no lo doy por leído');
    return d.reviewText(cfg, text == null ? '' : text, route).hallazgos;
  };
  for (const part of SYNC_PARTS) result.notApplicable.push({ part, reason: DIRECT_REASON });
  /** Corre una mirada; si no se pudo, las partes quedan como «no pude mirar» (nunca como limpias) y la corrida sigue. */
  const look = async (parts, fn) => {
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Stop) && !(exporterModule && e instanceof exporterModule.NoPudo)) throw e;
      for (const part of parts) result.couldNotLook.push({ part, reason: e.message });
    }
  };

  // El clon entero: TODAS las refs que el servidor sirve. No sólo ramas, etiquetas y cabezas de pull requests: una nota
  // de git o una ref de respaldo que alguien empujó también es lo publicado, y lo que no se trae sale como limpio.
  const dir = path.join(ctx.tmp, 'public.git');
  let tip = null;
  await look(IN_THE_CLONE.filter((part) => !SYNC_PARTS.includes(part)), () => {
    gitOut(ctx.tmp, ['init', '--quiet', '--bare', '--initial-branch=main', dir]);
    // Entre «todas las refs» pueden venir refs de reemplazo (`refs/replace/*`), con las que git lee OTRO objeto en lugar
    // del publicado. En este clon no se aplican —ninguna llamada de git, tampoco las del exportador—: se mira lo que
    // está publicado, no lo que alguien puso para taparlo.
    gitOut(dir, ['config', 'core.useReplaceRefs', 'false']);
    const r = remoteGit(ctx, dir, ['fetch', '--quiet', '--no-tags', ctx.remote, '+refs/*:refs/*']);
    if (r.status !== 0) throw couldNot(unreadable(ctx, r.stderr));
    const main = git(dir, ['rev-parse', '--verify', '--quiet', `${MAIN}^{commit}`]);
    if (main.status !== 0) throw couldNot(`${PUBLIC_REPO} no tiene main: no hay nada publicado que mirar`);
    tip = String(main.stdout).trim();
  });
  let pullOnlyCommits = null;   // cuántos commits cuelgan sólo de la cabeza de un pull request (null: no se pudo mirar)
  if (tip) {
    const cant = (part, reason) => result.couldNotLook.push({ part, reason });
    await look(['a', "a'", 'b', 'c'], () => { pullOnlyCommits = verifyClone(d, cfg, dir, found, looked, cant); });
  }
  // (d) lo que GitHub muestra del repo, y si es privado
  let about = null;
  await look(['d'], async () => {
    const info = await apiRead(ctx, '', 'los datos del repo');
    const topics = await apiRead(ctx, '/topics', 'los temas del repo');
    about = info;
    // los temas vienen siempre, como una lista (vacía si no hay): otra cosa no es «sin temas»
    if (!Array.isArray(topics.names)) throw couldNot('la API no contestó la lista de temas del repo: no la doy por leída');
    const texts = [['la descripción', info.description], ['el sitio', info.homepage], ...topics.names.map((t, i) => [`el tema nº ${i + 1}`, t])];
    for (const [what, text] of texts) for (const h of review(text, ROUTES.about)) found('d', h.categoria, `${what} del repo`, 'about');
  });

  // (e) el pull request abierto de la sincronización
  await look(['e'], async () => {
    const pulls = await apiRead(ctx, `/pulls?state=open&head=${encodeURIComponent(`${ctx.target.org}:${SYNC_BRANCH}`)}&per_page=100`, 'los pull requests abiertos');
    if (!Array.isArray(pulls)) throw couldNot('la API no contestó una lista al leer los pull requests abiertos');
    for (const pr of each(pulls, 'los pull requests abiertos')) {
      const number = numberOf(pr);
      for (const h of review(pr.title, ROUTES.pullRequest)) found('e', h.categoria, `el pull request nº ${number} (título)`, 'conversation');
      for (const h of review(pr.body, ROUTES.pullRequest)) found('e', h.categoria, `el pull request nº ${number} (cuerpo, línea ${h.linea})`, 'conversation');
      for (const h of review(pr.head && pr.head.ref, ROUTES.pullRequest)) found('e', h.categoria, `el pull request nº ${number} (rama)`, 'pull');
    }
  });

  // (g) y (h): lo que sólo GitHub sabe. Si no se pudieron medir se dice, nunca se calla; en un repo privado no existen.
  // Van ANTES de las listas largas de más abajo: la parte (m) hace una llamada por pedido, y si un día agota el cupo
  // de la hora, las alertas de secretos —dos llamadas— ya se leyeron (pase adversarial de la tanda F2).
  const isPrivate = Boolean(about && about.private === true);
  const unmeasured = (part, reason) => result.notMeasured.push({ part, reason });
  const ask = async (part, rest, read) => {
    let r;
    try {
      r = await apiCall(ctx, 'GET', rest);
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      unmeasured(part, e.message);
      return;
    }
    if (r.status !== 200 || !read(r.json)) unmeasured(part, `la API contestó ${r.status}: falta el permiso para leerlo, o en este repo no está prendido`);
  };
  if (isPrivate) {
    for (const part of ['g', 'h']) result.notApplicable.push({ part, reason: 'el repo es privado: ahí no existe (se mide cuando pasa a público)' });
  } else if (!about) {
    for (const part of ['g', 'h']) unmeasured(part, 'no pude leer si el repo es público');
  } else {
    if (!ctx.token) unmeasured('g', `sin un token que lea alertas (${CREDENTIAL_VARIABLE})`);
    else {
      await ask('g', '/secret-scanning/alerts?state=open&per_page=100', (json) => {
        if (!Array.isArray(json)) return false;
        for (const alert of json) found('g', 'secret-alert', `la alerta nº ${numberOf(alert)} (${GUIDE}, §«Alertas de prueba en GitHub»)`);
        return true;
      });
    }
    await ask('h', '/private-vulnerability-reporting', (json) => {
      if (!json || typeof json.enabled !== 'boolean') return false;
      if (!json.enabled) found('h', 'reporting-disabled', 'está apagado, y SECURITY.md lo ofrece como canal');
      return true;
    });
  }

  // ── Lo publicado que no es git (story 8.26, tanda F2 · AC 24) ────────────────────────────────────────────────
  // Cada lista se lee ENTERA (`apiList`), y cada parte es una mirada aparte: si una no se puede leer queda en «no pude
  // mirar» y las demás se miran igual. El lugar se dice por un NÚMERO que dio la API (el del pedido, el id del
  // comentario): nunca por un texto que la respuesta haya querido poner ahí.
  const idOf = (item) => (item && Number.isSafeInteger(item.id) ? item.id : '?');
  /** El número que cierra una dirección de la API (`…/issues/12`, `…/pulls/12`): de qué pedido o issue es un comentario. */
  const tail = (url) => { const m = /\/(\d{1,12})$/.exec(String(url || '')); return m ? m[1] : '?'; };

  // (k) las versiones: el título, la marca, las notas y cada adjunto. El arnés no sube adjuntos: uno subido es un
  // archivo publicado que este guion no baja ni lee, y eso es «sin leer», no «limpio».
  await look(['k'], async () => {
    const releases = each(await apiList(ctx, '/releases', 'las versiones'), 'las versiones');
    let assets = 0;
    for (const release of releases) {
      const where = `la versión con id ${idOf(release)}`;
      for (const h of review(release.name, ROUTES.release)) found('k', h.categoria, `${where} (título)`, 'release');
      for (const h of review(release.tag_name, ROUTES.release)) found('k', h.categoria, `${where} (marca)`, 'release');
      for (const h of review(release.body, ROUTES.release)) found('k', h.categoria, `${where} (notas, línea ${h.linea})`, 'release');
      // de dónde se cortó la versión: el nombre de una rama (o un commit), que la página de la versión también muestra
      for (const h of review(release.target_commitish, ROUTES.release)) found('k', h.categoria, `${where} (la rama o el commit de donde se cortó)`, 'release');
      // los adjuntos vienen siempre, como una lista (vacía si no hay): otra cosa no es «sin adjuntos»
      if (!Array.isArray(release.assets)) throw couldNot(`la API no contestó la lista de adjuntos de ${where}: no la doy por leída`);
      each(release.assets, `los adjuntos de ${where}`).forEach((asset, i) => {
        assets += 1;
        found('k', 'sin-leer', `${where}: un adjunto subido (el nº ${i + 1}; su contenido no se lee)`, 'release');
        for (const text of [asset.name, asset.label]) for (const h of review(text, ROUTES.release)) found('k', h.categoria, `${where} (el nombre del adjunto nº ${i + 1})`, 'release');
      });
    }
    looked.k = releases.length + assets;
  });

  // (l) el título y el cuerpo de TODOS los pedidos e issues, abiertos y cerrados (la lista de issues de la API trae
  // los dos: un pedido es un issue con la clave `pull_request`); y las etiquetas y los hitos, que también son texto.
  let pullNumbers = null;   // los pedidos, para leer después sus revisiones (null: no se pudo leer la lista)
  await look(['l'], async () => {
    const issues = each(await apiList(ctx, '/issues?state=all', 'los pedidos y los issues'), 'los pedidos y los issues');
    for (const issue of issues) {
      const where = `${issue.pull_request ? 'el pedido' : 'el issue'} nº ${numberOf(issue)}`;
      for (const h of review(issue.title, ROUTES.pullRequest)) found('l', h.categoria, `${where} (título)`, 'conversation');
      for (const h of review(issue.body, ROUTES.pullRequest)) found('l', h.categoria, `${where} (cuerpo, línea ${h.linea})`, 'conversation');
    }
    const labels = each(await apiList(ctx, '/labels', 'las etiquetas'), 'las etiquetas');
    labels.forEach((label, i) => {
      for (const text of [label.name, label.description]) for (const h of review(text, ROUTES.pullRequest)) found('l', h.categoria, `la etiqueta nº ${i + 1} del repo`, 'about');
    });
    const milestones = each(await apiList(ctx, '/milestones?state=all', 'los hitos'), 'los hitos');
    for (const milestone of milestones) {
      for (const text of [milestone.title, milestone.description]) for (const h of review(text, ROUTES.pullRequest)) found('l', h.categoria, `el hito nº ${numberOf(milestone)} del repo`, 'about');
    }
    // El nombre de la RAMA de cada pedido, abierto o cerrado (la lista de issues no lo trae: sale de la de pedidos).
    // Con la rama ya borrada ese nombre deja de ser una ref del clon —la parte (c) no lo ve— y sigue en la página del
    // pedido; la parte (e) sólo mira el pedido abierto de la sincronización. Y la rama destino, que se muestra igual.
    const pullList = each(await apiList(ctx, '/pulls?state=all', 'los pedidos (para el nombre de su rama)'), 'los pedidos (para el nombre de su rama)');
    for (const pr of pullList) {
      for (const [side, what] of [[pr.head, 'rama'], [pr.base, 'rama destino']]) {
        if (!side || typeof side !== 'object' || typeof side.ref !== 'string') throw couldNot('la API contestó un pedido sin el nombre de su rama: no lo doy por leído');
        for (const h of review(side.ref, ROUTES.pullRequest)) found('l', h.categoria, `el pedido nº ${numberOf(pr)} (${what})`, 'pull');
      }
    }
    // Y lo que la línea de tiempo de cada pedido e issue conserva y sigue mostrando: el título ANTERIOR de uno
    // renombrado (corregir el título no lo saca de ahí), el nombre de una etiqueta o de un hito ya borrados, y el
    // motivo con que se descartó una revisión.
    const events = each(await apiList(ctx, '/issues/events', 'la línea de tiempo de los pedidos y los issues'), 'la línea de tiempo de los pedidos y los issues');
    // Un evento trae o no cada una de estas claves (uno de «cerrado» no trae ninguna): que falte, o que venga nula, es
    // «este evento no tiene ese texto». Que venga y no sea lo que tiene que ser —un objeto, con un texto adentro— no es
    // «sin texto»: no se pudo leer, y la parte lo dice (revisor de fallos silenciosos, cuarta vuelta de la F2).
    const inner = (event, key, field) => {
      const holder = event[key];
      if (holder === undefined || holder === null) return null;
      const text = typeof holder === 'object' && !Array.isArray(holder) ? holder[field] : holder;
      if (text === undefined || text === null) return null;
      if (typeof text !== 'string') throw couldNot(`la API contestó un evento de la línea de tiempo con un «${key}» que no se puede leer: no lo doy por leído`);
      return text;
    };
    for (const event of events) {
      const where = `el evento con id ${idOf(event)} (en el pedido o issue nº ${numberOf(event.issue)})`;
      const texts = [
        ['un título anterior', inner(event, 'rename', 'from')], ['un título', inner(event, 'rename', 'to')],
        ['el nombre de una etiqueta', inner(event, 'label', 'name')], ['el título de un hito', inner(event, 'milestone', 'title')],
        ['el motivo con que se descartó una revisión', inner(event, 'dismissed_review', 'dismissal_message')],
      ];
      for (const [what, text] of texts) for (const h of review(text, ROUTES.pullRequest)) found('l', h.categoria, `${where}: ${what}`, 'conversation');
    }
    looked.l = issues.length + labels.length + milestones.length + events.length;
    // un pedido sin su número no se saltea: sus revisiones no se podrían pedir, y eso no es «no tiene»
    const pulls = issues.filter((issue) => issue.pull_request);
    if (!pulls.every((issue) => Number.isSafeInteger(issue.number) && issue.number > 0)) throw couldNot('la API contestó un pedido sin su número: no puedo pedir sus revisiones, y no las doy por leídas');
    pullNumbers = pulls.map((issue) => issue.number);
  });

  // (m) los comentarios, de las cuatro clases que hay: los de la conversación de un pedido o de un issue, los de
  // revisión (en una línea del cambio), el cuerpo de cada revisión, y los que se dejan sobre un commit.
  await look(['m'], async () => {
    let count = 0;
    const comments = [
      ['/issues/comments', 'los comentarios de los pedidos y los issues', (c) => `el comentario con id ${idOf(c)} (en el pedido o issue nº ${tail(c.issue_url)})`],
      ['/pulls/comments', 'los comentarios de revisión', (c) => `el comentario de revisión con id ${idOf(c)} (en el pedido nº ${tail(c.pull_request_url)})`, true],
      ['/comments', 'los comentarios sobre commits', (c) => `el comentario con id ${idOf(c)} sobre el commit ${SHA.test(String(c.commit_id || '')) ? short(c.commit_id) : '?'}`],
    ];
    for (const [rest, what, where, onAChange = false] of comments) {
      const list = each(await apiList(ctx, rest, what), what);
      count += list.length;
      for (const c of list) {
        for (const h of review(c.body, ROUTES.pullRequest)) found('m', h.categoria, `${where(c)} (línea ${h.linea})`, 'conversation');
        const pathName = (file) => {
          for (const category of new Set(review(file, ROUTES.paths).map((h) => h.categoria))) found('m', category, `${where(c)} (la ruta del archivo comentado)`, 'conversation');
        };
        if (onAChange) {
          // Un comentario de revisión muestra además el FRAGMENTO del cambio sobre el que se dejó, con su ruta. Si la
          // rama del pedido se reescribió después, ese commit ya no cuelga de ninguna ref —el clon no lo trae— y el
          // fragmento sigue en la conversación. Se mira con la regla de SU archivo, como el contenido en el clon.
          // Los dos campos vienen siempre: uno que falta no es «sin fragmento», es un comentario que no se pudo leer.
          if (typeof c.path !== 'string' || !c.path || typeof c.diff_hunk !== 'string') throw couldNot('la API contestó un comentario de revisión sin su ruta o sin el fragmento del cambio: no lo doy por leído');
          pathName(c.path);
          for (const h of review(c.diff_hunk, c.path)) found('m', h.categoria, `${where(c)} (el fragmento del cambio, línea ${h.linea})`, 'conversation');
        } else if (c.path !== undefined && c.path !== null) {
          // un comentario sobre un commit puede traer la ruta del archivo comentado (o ninguna)
          if (typeof c.path !== 'string') throw couldNot('la API contestó un comentario con una ruta que no es un texto: no lo doy por leído');
          pathName(c.path);
        }
      }
    }
    // las revisiones no tienen una lista de todo el repo: se piden pedido por pedido. Sin la lista de pedidos no se
    // sabe cuáles hay, y eso no es «ninguna»
    if (pullNumbers === null) throw couldNot('no pude leer la lista de pedidos, así que no sé de cuáles leer las revisiones');
    for (const number of pullNumbers) {
      const reviews = each(await apiList(ctx, `/pulls/${number}/reviews`, `las revisiones del pedido nº ${number}`), `las revisiones del pedido nº ${number}`);
      count += reviews.length;
      for (const r of reviews) for (const h of review(r.body, ROUTES.pullRequest)) found('m', h.categoria, `la revisión con id ${idOf(r)} del pedido nº ${number} (línea ${h.linea})`, 'conversation');
    }
    looked.m = count;
  });

  // El consejo del repo privado (AC 58). Sólo cuando GitHub DIJO que es privado: si la parte (d) no se pudo leer, no
  // se sabe, y el consejo es el del repo público. Se cambia al final —recién acá se sabe— y sólo el texto.
  if (about && isPrivate) {
    for (const f of result.findings) {
      const text = Object.prototype.hasOwnProperty.call(REACH_PRIVATE, f.reach) ? REACH_PRIVATE[f.reach] : null;
      if (text) f.todo = `${f.rotateFirst ? ROTATE_FIRST : ''}${text}`;
    }
  }
  const strictMiss = Boolean(ctx.args.strict) && result.notMeasured.length > 0;
  const exit = result.findings.length ? 1 : result.couldNotLook.length || strictMiss ? 2 : 0;
  const letters = (list) => [...new Set(list.map((x) => `(${x.part})`))].join(', ');
  const status = (part) => {
    const failed = result.couldNotLook.find((x) => x.part === part);
    if (failed) return 'NO PUDE MIRAR';
    const miss = result.notMeasured.find((x) => x.part === part);
    if (miss) return `NO MEDIDO — ${miss.reason}`;
    const skip = result.notApplicable.find((x) => x.part === part);
    if (skip) return `no aplica — ${skip.reason}`;
    const n = result.findings.filter((x) => x.part === part).length;
    return n ? `${n} hallazgo(s)` : 'sin hallazgos';
  };
  const lines = [`mirror verify: ${PUBLIC_REPO}, revisado con la lista privada`,
    ...Object.entries(PARTS).map(([part, what]) => `  (${part}) ${what}: ${status(part)}`),
    ...(pullOnlyCommits ? [`  (c) ${pullOnlyCommits} commit(s) alcanzables sólo desde cabezas de pull request: su identidad no se juzga con la regla genérica de correos (los términos de la lista sí se buscan)`] : []),
    // cada hallazgo con lo que hay que hacer, en el renglón de abajo: depende de hasta dónde llegó (REACH)
    ...result.findings.flatMap((f) => [`  · (${f.part}) [${f.category}] ${f.place}`, `      → ${f.todo}`])];
  // toda corrida dice cómo terminó, también la que salió bien (y ahí, lo que quedó sin medir)
  let message = `sin hallazgos${result.notMeasured.length ? `; quedó NO MEDIDO ${letters(result.notMeasured)}` : ''}`;
  if (result.findings.length) {
    message = `${result.findings.length} hallazgo(s) en lo publicado, en ${letters(result.findings)}. Qué hacer: ${GUIDE}, §«Si \`verify\` da 1»`
      + (result.couldNotLook.length ? `. Además no pude mirar ${letters(result.couldNotLook)}: ${result.couldNotLook[0].reason}` : '');
  } else if (result.couldNotLook.length) {
    message = `no pude mirar ${letters(result.couldNotLook)}: ${[...new Set(result.couldNotLook.map((x) => x.reason))].join(' · ')}`;
  } else if (strictMiss) {
    message = `--strict: quedó NO MEDIDO ${letters(result.notMeasured)}: ${[...new Set(result.notMeasured.map((x) => x.reason))].join(' · ')}`;
  }
  return { exit, lines, message, data: { strict: Boolean(ctx.args.strict), direct, private: about ? isPrivate : null, ...result, looked, pullOnlyCommits } };
}

/**
 * El informe de `verify` en un archivo (`--report`), para el paso del pipeline que avisa (story 8.26, tanda F2 · AC 24):
 * el veredicto, cada lugar con lo que hay que hacer, y lo que no se pudo mirar. Lo mismo que dice `--json`, y como todo
 * lo que este guion escribe: nunca el texto hallado. Se escribe SIEMPRE que la corrida pidió el informe, también si
 * `verify` frenó antes de mirar nada (ahí trae el código y el motivo): el paso que avisa no tiene que adivinar por qué
 * no hay archivo. Si no se puede escribir, la corrida es un 2: un aviso que no va a salir no puede pasar callado.
 */
/** Lo que va al informe: un error no previsto trae su traza en el mensaje, y al informe —que termina en un aviso— va sólo que lo hubo. */
const reportForFile = (report) => (/^error no previsto: /.test(report.message || '')
  ? { ...report, message: 'error no previsto (el detalle, en el registro de la corrida)' } : report);
/** La corrida cuyo informe no se pudo escribir: un 1 sigue siendo un 1 (hay hallazgos); cualquier otro código pasa a 2. */
const reportUnwritten = (report, failed) => ({ ...report, exit: report.exit === 1 ? 1 : 2, message: report.message ? `${report.message}. Además, ${failed}` : failed });
function writeReport(file, command, report) {
  const body = redact(JSON.stringify({ command, exit: report.exit, message: report.message || '', ...report.data }, null, 2));
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), `${body}\n`, { mode: 0o600 });
    return null;
  } catch (e) {
    return `no pude escribir el informe de la verificación (${(e && e.code) || 'error'}): el aviso no tendría de dónde salir`;
  }
}

const RUN = Object.freeze({ verify });

// ── La corrida ──────────────────────────────────────────────────────────────────────────────────────────────────
async function main(argv) {
  const asJson = argv.includes('--json');
  const command = COMMANDS.includes(argv[0]) ? argv[0] : null;
  let report;
  // El archivo del informe se lee ANTES que nada: si la corrida frena al leer el token o las opciones, el informe se
  // escribe igual (con el código y el motivo) — el paso que avisa no tiene que adivinar por qué no hay archivo. Después
  // manda lo que diga `parseArgs`, que es quien valida la opción (pase adversarial de la tanda F2).
  const reportAt = command === 'verify' ? argv.lastIndexOf('--report') : -1;
  const early = reportAt >= 0 ? argv[reportAt + 1] : undefined;
  let reportFile = early !== undefined && early !== '' && !early.startsWith('--') ? early : null;
  try {
    const token = takeToken(process.env);   // antes de cargar nada: de acá en más no está en el ambiente
    const args = parseArgs(argv);
    reportFile = args.report || null;
    report = await RUN[args.command](prepare(args, token));
  } catch (e) {
    const known = e instanceof Stop || (exporterModule && e instanceof exporterModule.NoPudo);
    // cualquier error —previsto o no— es un 2: el 1 significa «encontré algo» y un 0 sería una mentira
    report = { exit: e instanceof Stop ? e.exit : 2, message: known ? e.message : `error no previsto: ${(e && e.stack) || e}`, data: (e instanceof Stop && e.data) || {} };
  }
  if (reportFile) {
    const failed = writeReport(reportFile, command, reportForFile(report));
    if (failed) report = reportUnwritten(report, failed);
  }
  cleanup();
  const out = [];
  // toda corrida trae `message`: la que frena, por qué; la que termina bien, cómo terminó
  if (asJson) out.push(JSON.stringify({ command, exit: report.exit, message: report.message || '', ...report.data }, null, 2));
  else if (report.lines) out.push(...report.lines);
  if (out.length) process.stdout.write(`${redact(out.join('\n'))}\n`);
  if (report.exit !== 0 && report.message) {
    process.stderr.write(redact(`${report.exit === 1 ? '🛑' : '⛔'} mirror${command ? ` ${command}` : ''}: ${report.message}\n`));
  }
  // exitCode y no exit(): con la salida en un pipe, exit() corta lo que todavía no se escribió
  process.exitCode = report.exit;
}

module.exports = {
  COMMANDS, gitAuth,
  // story 8.26, tanda F2 (AC 24): qué va al informe de `verify` y qué código queda si no se pudo escribir
  reportForFile, reportUnwritten,
};

if (require.main === module) {
  process.on('exit', cleanup);
  // lo que se escape de todo también es «no pude»: node saldría con 1, que acá es «encontré algo»
  process.on('uncaughtException', (e) => {
    cleanup();
    process.stderr.write(redact(`⛔ mirror: no pude — error no previsto: ${(e && e.stack) || e}\n`));
    process.exit(2);
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(s, () => {
      cleanup();
      process.stderr.write(`⛔ mirror: interrumpido (${s})\n`);
      process.exit(2);
    });
  }
  main(process.argv.slice(2));
}
